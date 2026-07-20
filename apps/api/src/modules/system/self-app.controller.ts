/**
 * Self-registration of the control plane as a managed "app".
 *
 * The CLI setup wizard calls these AFTER bootstrap-admin (internal-token gated,
 * self-hosted only). They reuse the ordinary app + domain pipes so that, once
 * setup finishes, Openship itself shows up under the dashboard's **Apps** tab
 * with a real domain:
 *   - createProject({ isApp:true, appTemplateId:"openship" })  → the Apps row
 *   - free  domain → Oblien edge proxy (slug.opsh.io → this box), reusing
 *     cloudClient().edgeProxy.sync — needs the owner connected to Openship Cloud
 *   - custom domain → OpenResty + Let's Encrypt via provisionSelfEdge, streamed
 *     live through a setup-session for the wizard's spinner
 *
 * No new routing/SSL machinery — Openship deploys itself with its own tools.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { SYSTEM, safeErrorMessage } from "@repo/core";
import { env } from "../../config";
import { assertNotCloud } from "../../lib/controller-helpers";
import { ensureLocalUser } from "../../lib/local-user";
import { createProject } from "../projects/project-crud.service";
import { cloudClient } from "../../lib/cloud/client";
import { getCloudConnectionStatusForOrg } from "../../lib/cloud/session";
import { provisionSelfEdge } from "../../lib/startup/self-edge";
import { streamSSE } from "../../lib/sse";
import {
  createSetupSession,
  getSetupSession,
  updateComponentProgress,
  appendSetupLog,
  finishSetupSession,
  subscribeSetupSession,
} from "./setup-session";

const APP_SLUG = "openship";
const APP_TEMPLATE_ID = "openship";

/**
 * The org that OWNS this box. Once connected to Openship Cloud, the mirrored
 * cloud user is the admin and its personal org `org_<id>` carries the cloud
 * link — prefer that. Otherwise fall back to the deterministic local owner
 * (fresh / self-hosted-only box). Single source of truth so cloud-status and
 * self-register act on the SAME org after a cloud connect — no client-side org
 * threading needed.
 */
async function resolveOrg(): Promise<{ userId: string; organizationId: string }> {
  const linked = await repos.settings.listCloudLinkedOrgIds().catch(() => [] as string[]);
  if (linked.length > 0) {
    const organizationId = linked[0];
    return { userId: organizationId.replace(/^org_/, ""), organizationId };
  }
  const localUser = await ensureLocalUser();
  return { userId: localUser.id, organizationId: `org_${localUser.id}` };
}

/** Find-or-create the control-plane app project (idempotent). Returns its id. */
async function ensureControlPlaneApp(organizationId: string, port?: number): Promise<string> {
  const existing = await repos.project.findBySlugInOrg(organizationId, APP_SLUG);
  if (existing) return existing.id;
  const created = await createProject(
    {
      name: "Openship",
      isApp: true,
      appTemplateId: APP_TEMPLATE_ID,
      hasBuild: false,
      hasServer: true,
      projectType: "app",
      ...(port ? { port } : {}),
    },
    organizationId,
  );
  return created.id;
}

/**
 * GET /api/system/cloud-status — is the org's owner connected to Openship Cloud?
 * The wizard checks this before offering / after driving the free-domain path.
 */
export async function cloudStatus(c: Context) {
  const guard = assertNotCloud(c); if (guard) return guard;
  const { organizationId } = await resolveOrg();
  const status = await getCloudConnectionStatusForOrg(organizationId);
  return c.json(status);
}

/**
 * POST /api/system/cloud-connect — finalize the browser PKCE handshake AND make
 * the Openship Cloud account this box's admin, reusing the EXACT desktop
 * identity pipe (no duplication): `mirrorCloudUser` provisions a local user from
 * the cloud identity (+ its personal org + owner membership), we store the cloud
 * session against it, and switch the box to `authMode="cloud"` so the local
 * login offers "Continue with Cloud" — passwordless, no separate local
 * credential. Internal-token gated (the fresh wizard has no session/PAT).
 */
export async function cloudConnect(c: Context) {
  const guard = assertNotCloud(c); if (guard) return guard;
  const body = await c.req
    .json<{ code?: string; codeVerifier?: string }>()
    .catch(() => ({}) as { code?: string; codeVerifier?: string });
  if (!body.code) return c.json({ error: "code is required" }, 400);

  try {
    const { exchangeCodeWithCloud, mirrorCloudUser, storeCloudSession } = await import(
      "../../lib/cloud-auth-proxy"
    );
    const { clearAuthModeCache } = await import("../../lib/auth-mode");
    const data = await exchangeCodeWithCloud(body.code, body.codeVerifier);
    if (!data) return c.json({ error: "Could not verify with Openship Cloud" }, 401);

    const userId = await mirrorCloudUser(data.user);
    await storeCloudSession(userId, data.sessionToken);
    // Local login becomes cloud-backed (passwordless). Reuse the singleton
    // upsert; clear the cached mode so the change takes effect immediately.
    await repos.instanceSettings.upsert({ authMode: "cloud" });
    clearAuthModeCache();

    const email = (data.user as { email?: string | null }).email ?? null;
    return c.json({ ok: true, userId, organizationId: `org_${userId}`, email });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
}

/**
 * POST /api/system/self-register — register the control plane as an app and
 * attach its domain. Free returns immediately; custom returns a `sessionId` to
 * stream provisioning progress from.
 */
export async function selfRegister(c: Context) {
  const guard = assertNotCloud(c); if (guard) return guard;
  const body = await c.req.json<{
    domainType?: "free" | "custom" | "byo";
    hostname?: string;
    slug?: string;
    dashPort?: number;
    acmeEmail?: string;
    publicHost?: string;
    /** User accepted taking over ports 80/443 from an existing proxy. */
    edgeTakeover?: boolean;
    /** User accepted migrating the existing proxy's sites before taking over. */
    edgeMigrate?: boolean;
  }>().catch(() => ({}) as Record<string, never>);

  const domainType = body.domainType ?? "byo";
  const dashPort = Number(body.dashPort) || env.OPENSHIP_DASHBOARD_PORT || 3001;
  const { organizationId } = await resolveOrg();
  const projectId = await ensureControlPlaneApp(organizationId, dashPort);

  if (domainType === "free") {
    const slug = (body.slug ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) return c.json({ error: "slug is required for a free domain" }, 400);
    const hostname = `${slug}.${SYSTEM.DOMAINS.CLOUD_DOMAIN}`;
    const target = `${body.publicHost || env.SERVER_IP || ""}:${dashPort}`.replace(/^:/, "");
    if (!body.publicHost && !env.SERVER_IP) {
      return c.json({ error: "Could not resolve this server's public address for the edge proxy" }, 400);
    }
    try {
      const result = await cloudClient({ organizationId }).edgeProxy.sync({ slug, target });
      if (!result) {
        return c.json(
          { error: "Openship Cloud is not connected — connect it to use a free .opsh.io domain." },
          409,
        );
      }
    } catch (err) {
      return c.json({ error: safeErrorMessage(err) }, 502);
    }
    // Oblien's edge terminates TLS for *.opsh.io and forwards to the box, so the
    // domain is live + secured the moment the proxy syncs.
    await repos.domain.findOrCreate({
      projectId,
      hostname,
      domainType: "free",
      isPrimary: true,
      verified: true,
      verifiedAt: new Date(),
      status: "active",
      sslStatus: "active",
    });
    return c.json({ ok: true, url: `https://${hostname}`, hostname });
  }

  if (domainType === "custom") {
    const hostname = (body.hostname ?? "").trim().toLowerCase();
    if (!hostname || !hostname.includes(".")) {
      return c.json({ error: "a valid hostname is required for a custom domain" }, 400);
    }
    await repos.domain.findOrCreate({
      projectId,
      hostname,
      domainType: "custom",
      isPrimary: true,
      status: "pending",
      sslStatus: "provisioning",
    });

    const session = createSetupSession(
      [
        { name: "openresty", label: "Install OpenResty + certbot" },
        { name: "route", label: "Route domain to Openship" },
        { name: "ssl", label: "Issue SSL certificate" },
      ],
      "self",
    );

    // Drive provisioning in the background; the wizard streams progress.
    void provisionSelfEdge(
      hostname,
      dashPort,
      {
        backoffs: [15_000, 45_000], // shorter than the boot hook so the spinner resolves
        onLog: (message, level) => appendSetupLog(session.id, "edge", message, level),
        onStep: (step, status) => updateComponentProgress(session.id, step, status),
      },
      { edgeTakeover: body.edgeTakeover === true, edgeMigrate: body.edgeMigrate === true },
    )
      .then(async (res) => {
        await repos.domain
          .updateSsl(await domainIdFor(projectId, hostname), {
            sslStatus: res.verified ? "active" : "error",
            sslExpiresAt: res.expiresAt ? new Date(res.expiresAt) : undefined,
          })
          .catch(() => {});
        finishSetupSession(session.id, res.verified ? "completed" : "failed");
      })
      .catch((err) => {
        appendSetupLog(session.id, "edge", safeErrorMessage(err), "error");
        finishSetupSession(session.id, "failed");
      });

    return c.json({ ok: true, sessionId: session.id, url: `https://${hostname}`, hostname });
  }

  // BYO reverse proxy — record the domain, provision nothing.
  const hostname = (body.hostname ?? "").trim().toLowerCase();
  if (hostname) {
    await repos.domain.findOrCreate({
      projectId,
      hostname,
      domainType: "custom",
      isPrimary: true,
      externalIngress: true,
      verified: true,
      verifiedAt: new Date(),
      status: "active",
      sslStatus: "external",
    });
  }
  return c.json({ ok: true, url: hostname ? `https://${hostname}` : null, hostname: hostname || null });
}

/**
 * POST /api/system/self-edge/preflight — detect what owns ports 80/443 on THIS
 * machine before the wizard installs OpenResty (internal-token gated, local
 * executor). Read-only; the CLI uses it to prompt migrate/takeover/cancel.
 */
export async function selfEdgePreflight(c: Context) {
  const guard = assertNotCloud(c); if (guard) return guard;

  // Managed edge only installs on a Linux host; elsewhere there's nothing to take over.
  if (process.platform !== "linux") {
    return c.json({ status: { classification: "free", occupants: [], canProceedClean: true } });
  }

  try {
    const { createExecutor, probeEdge, scanImportableSites, canImportProxy } = await import("@repo/adapters");
    const executor = createExecutor();
    const status = await probeEdge(executor);

    // For a known, importable proxy, scan its sites so the CLI can offer migration.
    let sites: unknown[] = [];
    let warnings: string[] = [];
    const proxy = status.occupants.find((o) => o.proxy)?.proxy;
    if (status.classification === "known" && canImportProxy(proxy)) {
      const scan = await scanImportableSites(executor, proxy!);
      sites = scan.sites;
      warnings = scan.warnings;
    }
    return c.json({ status, sites, warnings });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
}

/** Resolve a domain row id by (project, hostname) for the SSL status patch. */
async function domainIdFor(projectId: string, hostname: string): Promise<string> {
  const row = await repos.domain.findByHostnameForProject(projectId, hostname.toLowerCase());
  return row?.id ?? "";
}

/**
 * GET /api/system/self-register/stream?id=<sessionId> — SSE progress for the
 * custom-domain provisioning (mirrors the system-install stream, but
 * internal-token gated rather than server-permission gated).
 */
export async function selfRegisterStream(c: Context) {
  const guard = assertNotCloud(c); if (guard) return guard;
  const sessionId = c.req.query("id");
  const session = sessionId ? getSetupSession(sessionId) : null;
  if (!session) return c.json({ error: "No such session" }, 404);

  return streamSSE(c, async (sseStream) => {
    let closed = false;
    const writer = (event: string, data: string): boolean => {
      if (closed) return false;
      try {
        void sseStream.writeSSE({ event, data });
        return true;
      } catch {
        return false;
      }
    };

    const { success } = subscribeSetupSession(session.id, writer);
    if (!success || session.status !== "running") return;

    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (closed) {
          clearInterval(iv);
          resolve();
        }
      }, 1000);
      sseStream.onAbort(() => {
        closed = true;
        clearInterval(iv);
        resolve();
      });
    });
  });
}
