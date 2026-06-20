/**
 * Cloud local controller - runs only when !CLOUD_MODE.
 *
 * Dynamic imports for security isolation: cloud-client and cloud-auth-proxy
 * are never loaded on the SaaS. This prevents self-hosted code paths
 * (which handle user credentials, SSH config, etc.) from being accessible
 * in the SaaS process.
 *
 *   POST /api/cloud/disconnect      - clear stored session
 *   GET  /api/cloud/status          - check connection state
 *   GET  /api/cloud/connect-callback - exchange code from external auth
 */

import type { Context } from "hono";
import { Oblien } from "@repo/adapters";
import { repos } from "@repo/db";
import { getUserId, getActiveOrganizationId } from "../../lib/controller-helpers";
import { audit, auditContextFrom } from "../../lib/audit";
import {
  cloudClient,
  getCloudConnectionStatus,
} from "../../lib/cloud-client";
import { safeErrorMessage } from "@repo/core";

// ─── Result page (shown in popup / browser tab after connect) ────────────────

function connectResultPage(title: string, message: string, success = false): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Openship</title>
<script>
// Auto-close popup windows; the opener detects the close event.
if (window.opener) { window.close(); }
</script></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#fafafa">
<div style="text-align:center;max-width:420px">
  <div style="font-size:48px;margin-bottom:16px">${success ? "\u2713" : "\u26A0"}</div>
  <h2 style="margin:0 0 8px">${title}</h2>
  <p style="color:#888;margin:0 0 24px">${message}</p>
  ${success ? '<p style="color:#555;font-size:14px">You can close this window.</p>' : ""}
</div>
</body></html>`;
}

// ─── Cloud workspaces / drift ────────────────────────────────────────────────

/**
 * GET /api/cloud/workspaces
 *
 * The recovery + drift primitive. Lists every workspace in the
 * active organization's owner namespace on Oblien, joins against
 * local `project.cloud_workspace_id` for the active org, returns:
 *
 *   - workspaces[]      every workspace owned by the org on cloud,
 *                       annotated with the local project (if any)
 *                       it's bound to
 *   - orphanedCloud[]   workspaces with no matching local project —
 *                       these surface in the Import wizard
 *   - orphanedLocal[]   local projects whose cloud_workspace_id is
 *                       no longer on cloud (deleted from Oblien
 *                       directly, or never existed) — surface as a
 *                       red badge with "Re-deploy" / "Delete local"
 *
 * Runs entirely on the local API. SaaS is touched only to mint the
 * namespace token through the org-owner cloud link (whichever member
 * of the org linked cloud). This means every member of the org sees
 * the same workspace list, and `connected: false` is returned only
 * when NO member of the org has linked cloud — not when the calling
 * user personally hasn't linked.
 *
 * Oblien enforces namespace isolation natively, so the listing
 * returned here is exactly the set of workspaces the org is allowed
 * to see.
 */
export async function listWorkspaces(c: Context) {
  const organizationId = getActiveOrganizationId(c);

  const tokenResult = await cloudClient({ organizationId })
    .token()
    .catch(() => null);
  if (!tokenResult) {
    return c.json({
      connected: false,
      workspaces: [],
      orphanedCloud: [],
      orphanedLocal: [],
    });
  }

  let cloudWorkspaces: Array<{
    id: string;
    slug?: string | null;
    name?: string;
    status: string;
    namespace?: string;
    createdAt: string;
    updatedAt: string;
  }>;
  try {
    const oblien = new Oblien({ token: tokenResult.token });
    const result = await oblien.workspaces.list({ limit: 200 });
    cloudWorkspaces = (result.workspaces as Array<{
      id: string;
      slug?: string | null;
      name?: string;
      status: string;
      namespace?: string;
      created_at: string;
      updated_at: string;
    }>).map((w) => ({
      id: w.id,
      slug: w.slug ?? null,
      name: w.name,
      status: w.status,
      namespace: w.namespace,
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    }));
  } catch (err) {
    console.error(
      `[cloud-workspaces] Oblien list failed: ${safeErrorMessage(err)}`,
    );
    return c.json(
      {
        connected: true,
        error: "Could not list workspaces from Openship Cloud",
        workspaces: [],
        orphanedCloud: [],
        orphanedLocal: [],
      },
      502,
    );
  }

  // Pull local projects targeting cloud for this org.
  const localProjects = await repos.project
    .listCloudProjectsByOrganization(organizationId)
    .catch(() => [] as Array<{ id: string; name: string; slug: string; cloudWorkspaceId: string | null }>);

  const localByWorkspace = new Map<string, typeof localProjects[number]>();
  for (const p of localProjects) {
    if (p.cloudWorkspaceId) localByWorkspace.set(p.cloudWorkspaceId, p);
  }
  const cloudWorkspaceIds = new Set(cloudWorkspaces.map((w) => w.id));

  const workspaces = cloudWorkspaces.map((w) => ({
    ...w,
    localProject: localByWorkspace.get(w.id)
      ? {
          id: localByWorkspace.get(w.id)!.id,
          name: localByWorkspace.get(w.id)!.name,
          slug: localByWorkspace.get(w.id)!.slug,
        }
      : null,
  }));

  const orphanedCloud = cloudWorkspaces.filter((w) => !localByWorkspace.has(w.id));

  const orphanedLocal = localProjects.filter(
    (p) => p.cloudWorkspaceId && !cloudWorkspaceIds.has(p.cloudWorkspaceId),
  );

  return c.json({
    connected: true,
    namespace: tokenResult.namespace,
    workspaces,
    orphanedCloud,
    orphanedLocal,
  });
}

// ─── Cloud account management ────────────────────────────────────────────────

export async function disconnect(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  await cloudClient({ userId }).disconnect();
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "cloud.disconnect",
    resourceType: "cloud",
    resourceId: "*",
  });
  return c.json({ connected: false });
}

export async function status(c: Context) {
  const userId = getUserId(c);
  return c.json(await getCloudConnectionStatus(userId));
}

/**
 * GET /api/cloud/connect-callback?code=<one-time-code>&state=<flow_id>
 *
 * After the user authenticates on Openship Cloud, they're redirected
 * here with a one-time code. We render a tiny browser page that reads
 * the PKCE verifier (stashed in localStorage by the dashboard initiator
 * before the popup opened) and POSTs (code, codeVerifier) to
 * /api/cloud/connect-finalize, which performs the actual token exchange.
 *
 * Doing the exchange browser-side rather than directly here is what
 * lets us bind the one-time code to a PKCE verifier the SaaS issuer
 * has never seen — without sending the verifier through the SaaS at any
 * point. If no verifier is found in localStorage (older flow, popup
 * disabled, third-party cookies blocking storage) we fall back to the
 * legacy non-PKCE exchange so the connect still completes.
 */
export async function connectCallback(c: Context) {
  // requireRole("owner") on the route already enforces auth; we don't
  // need to resolve the user here — the actual exchange happens in
  // connectFinalize, where it's bound to the calling user.
  const code = c.req.query("code");
  const state = c.req.query("state") ?? "";
  if (!code) {
    console.error("[cloud-connect-callback] missing code query param");
    return c.html(
      connectResultPage(
        "Missing Code",
        "The authentication code was not provided. Please try again.",
      ),
    );
  }
  return c.html(connectFinalizePage(code, state));
}

/**
 * POST /api/cloud/connect-finalize  { code, codeVerifier? }
 *
 * Browser-side completion of the connect popup flow. The popup script
 * rendered by /connect-callback reads the verifier from localStorage
 * and posts here, where we run the SaaS exchange + store the bearer.
 */
export async function connectFinalize(c: Context) {
  const userId = getUserId(c);
  const body = await c.req
    .json<{ code?: string; codeVerifier?: string }>()
    .catch(() => ({} as { code?: string; codeVerifier?: string }));
  if (!body.code) {
    return c.json({ error: "code is required" }, 400);
  }
  try {
    const { exchangeCodeWithCloud, storeCloudSession } = await import(
      "../../lib/cloud-auth-proxy"
    );
    const data = await exchangeCodeWithCloud(body.code, body.codeVerifier);
    if (!data) {
      return c.json(
        { error: "Could not verify with Openship Cloud" },
        401,
      );
    }
    await storeCloudSession(userId, data.sessionToken);
    return c.json({ ok: true });
  } catch (err) {
    console.error(
      `[cloud-connect-finalize] unexpected error: ${safeErrorMessage(err)}`,
    );
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
}

/**
 * HTML rendered into the popup after the cloud round trip. Reads the
 * verifier from localStorage (stashed by the dashboard initiator), POSTs
 * (code, codeVerifier) to /api/cloud/connect-finalize, then closes the
 * window. All same-origin — the popup ends up on the local API origin,
 * which is the same origin as the dashboard.
 */
function connectFinalizePage(code: string, state: string): string {
  const safeCode = JSON.stringify(code);
  const safeState = JSON.stringify(state);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Openship</title>
<style>
body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#fafafa}
.card{text-align:center;max-width:420px}
.spinner{width:24px;height:24px;border:2px solid #333;border-top-color:#fafafa;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body>
<div class="card" id="card">
  <div class="spinner"></div>
  <h2 style="margin:0 0 8px">Finalizing connection…</h2>
  <p style="color:#888;margin:0">Just a moment.</p>
</div>
<script>
(async function(){
  var code = ${safeCode};
  var state = ${safeState};
  var verifier = null;
  try {
    if (state) verifier = window.localStorage.getItem("openship.cloud-connect.pkce." + state);
    if (state) window.localStorage.removeItem("openship.cloud-connect.pkce." + state);
  } catch(e){}
  try {
    var res = await fetch("/api/cloud/connect-finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code: code, codeVerifier: verifier || undefined })
    });
    var card = document.getElementById("card");
    if (res.ok) {
      card.innerHTML = '<div style="font-size:48px;margin-bottom:16px">✓</div><h2 style="margin:0 0 8px">Connected to Openship Cloud</h2><p style="color:#888;margin:0 0 24px">Your instance is now linked. You can close this window.</p>';
      if (window.opener) setTimeout(function(){ window.close(); }, 600);
    } else {
      var msg = "Could not verify with Openship Cloud.";
      try { var j = await res.json(); if (j && j.error) msg = j.error; } catch(e){}
      card.innerHTML = '<div style="font-size:48px;margin-bottom:16px">⚠</div><h2 style="margin:0 0 8px">Connection Failed</h2><p style="color:#888;margin:0">' + msg + '</p>';
    }
  } catch(e){
    var card2 = document.getElementById("card");
    card2.innerHTML = '<div style="font-size:48px;margin-bottom:16px">⚠</div><h2 style="margin:0 0 8px">Connection Failed</h2><p style="color:#888;margin:0">Network error finalizing connection.</p>';
  }
})();
</script>
</body></html>`;
}
