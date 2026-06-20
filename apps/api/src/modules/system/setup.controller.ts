/**
 * Setup controller - Electron → API direct push of instance config.
 *
 * Called once after onboarding with the internal token.
 * Persists SSH credentials, tunnel config, and default build mode
 * as instance-level settings (not per-user).
 *
 * Security: These handlers are loaded via dynamic import only in
 * self-hosted mode. Additionally, each handler checks CLOUD_MODE as
 * defense-in-depth - if somehow mounted in cloud, they refuse to run.
 */

import type { Context } from "hono";
import { setSignedCookie } from "hono/cookie";
import { db, repos, schema, eq, and } from "@repo/db";
import { generateId } from "@repo/core";
import { hashPassword } from "better-auth/crypto";
import { invalidateOpenRestyPaths } from "@/lib/openresty-paths";
import { env } from "../../config";
import { audit, auditContextFrom } from "../../lib/audit";
import { clearAuthModeCache } from "../../lib/auth-mode";
import { normalizeRollbackWindow } from "../../lib/release-retention";
import { sshManager } from "../../lib/ssh-manager";
import { encryptSecretField } from "@/lib/credential-encryption";
import { ensureLocalUser, invalidateLocalUserCache } from "../../lib/local-user";
import { COOKIE_PREFIX } from "../../lib/auth";
import { createLocalSession } from "../../lib/cloud-auth-proxy";
import { invalidatePlatformTransportCache } from "../../lib/mail";

const VALID_AUTH_MODES = ["none", "local", "cloud"] as const;
type AuthMode = (typeof VALID_AUTH_MODES)[number];

/**
 * Result of validating an incoming authMode change. `error` is set when
 * the change must be refused — callers should return the embedded JSON +
 * status as-is. `value` is the canonical mode to persist on success.
 */
type AuthModeValidation =
  | { ok: true; value: AuthMode }
  | { ok: false; status: 400 | 403; body: { error: string } };

/**
 * Validate an authMode write against the canonical mode set + the
 * two-key safety gate for flipping a non-desktop deployment to zero-auth.
 *
 * Zero-auth on a network-reachable instance means anyone who can hit the
 * API can act as admin, so the operator must opt in via the
 * OPENSHIP_ALLOW_ZERO_AUTH env var (deliberate restart) AND echo the
 * confirmation phrase in the request body (deliberate click) before we
 * write the value. Desktop deployments bypass the gate — loopback-only
 * Electron is the default zero-auth target.
 */
function validateAuthModeChange(body: Record<string, unknown>): AuthModeValidation {
  const raw = body.authMode;
  if (typeof raw !== "string" || !VALID_AUTH_MODES.includes(raw as AuthMode)) {
    return {
      ok: false,
      status: 400,
      body: { error: `authMode must be one of: ${VALID_AUTH_MODES.join(", ")}` },
    };
  }
  const value = raw as AuthMode;

  if (value === "none" && env.DEPLOY_MODE !== "desktop") {
    if (!env.OPENSHIP_ALLOW_ZERO_AUTH) {
      return {
        ok: false,
        status: 403,
        body: {
          error:
            "Zero-auth toggle disabled. Operator must set OPENSHIP_ALLOW_ZERO_AUTH=true and restart.",
        },
      };
    }
    if (body.confirm !== "I-understand-no-auth") {
      return {
        ok: false,
        status: 400,
        body: {
          error:
            "Zero-auth toggle requires `confirm: \"I-understand-no-auth\"` in the request body.",
        },
      };
    }
  }

  return { ok: true, value };
}

/** Guard - returns 404 in cloud mode (defense-in-depth) */
function assertNotCloud(c: Context): boolean {
  if (env.CLOUD_MODE) {
    c.status(404);
    c.body(null);
    return false;
  }
  return true;
}

/** POST /system/setup - push all instance settings from desktop app */
export async function setup(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const body = await c.req.json();

  // Instance-level config (non-SSH) → instance_settings table
  await repos.instanceSettings.upsert({
    authMode: body.authMode || "none",
    tunnelProvider: body.tunnelProvider || null,
    tunnelToken: body.tunnelToken || null,
    defaultBuildMode: body.defaultBuildMode || "auto",
    defaultRollbackWindow: normalizeRollbackWindow(body.defaultRollbackWindow),
  });

  // SSH server config → servers table (single source of truth)
  let serverId: string | undefined;
  if (body.sshHost) {
    // If caller specifies serverId, update that server; otherwise fall back to
    // the first existing server (desktop onboarding always has at most one).
    const existing = body.serverId
      ? await repos.server.get(body.serverId)
      : (await repos.server.list())[0] ?? null;

    // Encrypt SSH secrets at rest. Decrypted only inside `buildSshConfig`
    // when the ssh2 client needs them. See lib/credential-encryption.
    const encryptedPassword = encryptSecretField(body.sshPassword);
    const encryptedKeyPassphrase = encryptSecretField(body.sshKeyPassphrase);

    if (existing) {
      await repos.server.update(existing.id, {
        name: body.serverName || null,
        sshHost: body.sshHost,
        sshPort: body.sshPort || 22,
        sshUser: body.sshUser || "root",
        sshAuthMethod: body.sshAuthMethod || null,
        sshPassword: encryptedPassword,
        sshKeyPath: body.sshKeyPath || null,
        sshKeyPassphrase: encryptedKeyPassphrase,
        sshJumpHost: body.sshJumpHost || null,
        sshArgs: body.sshArgs || null,
      });
      serverId = existing.id;
    } else {
      // Setup runs through internalAuth / onboarding (no user session), so
      // there's no active org in context. Use whatever the middleware may
      // have set, otherwise leave NULL — these are instance-global servers
      // per the schema comment. Operators assign org post-onboarding.
      const ctxOrgId = c.get("activeOrganizationId");
      const organizationId =
        typeof ctxOrgId === "string" && ctxOrgId.length > 0 ? ctxOrgId : null;
      const created = await repos.server.create({
        organizationId,
        name: body.serverName || null,
        sshHost: body.sshHost,
        sshPort: body.sshPort || 22,
        sshUser: body.sshUser || "root",
        sshAuthMethod: body.sshAuthMethod || null,
        sshPassword: encryptedPassword,
        sshKeyPath: body.sshKeyPath || null,
        sshKeyPassphrase: encryptedKeyPassphrase,
        sshJumpHost: body.sshJumpHost || null,
        sshArgs: body.sshArgs || null,
      });
      serverId = created.id;
    }
    sshManager.invalidate(serverId);
    await invalidateOpenRestyPaths(serverId);
  }

  clearAuthModeCache();
  return c.json({ ok: true });
}

/** GET /system/setup - retrieve current instance settings */
export async function getSetup(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const settings = await repos.instanceSettings.get();
  const servers = await repos.server.list();
  const hasServer = servers.length > 0;

  return c.json({
    configured: hasServer,
    authMode: settings?.authMode ?? "none",
    tunnelProvider: settings?.tunnelProvider ?? null,
    defaultBuildMode: settings?.defaultBuildMode ?? "auto",
    defaultRollbackWindow: normalizeRollbackWindow(settings?.defaultRollbackWindow),
    invitationMailSource: settings?.invitationMailSource ?? "platform",
    teamMode: settings?.teamMode ?? "single_user",
    migrationTargetUrl: settings?.migrationTargetUrl ?? null,
    migratedAt: settings?.migratedAt?.toISOString() ?? null,
  });
}

/** PATCH /system/settings - partial update instance-level settings (non-SSH) */
export async function updateSettings(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const body = (await c.req.json()) as Record<string, unknown>;

  // Only instance-level fields - SSH changes go through the servers API.
  const patch: Record<string, unknown> = {};

  // authMode changes are security-sensitive: validate against the canonical
  // set, enforce the zero-auth safety gate, and capture the previous value
  // for the audit row written after the upsert succeeds.
  let authModeChange: { before: AuthMode | null; after: AuthMode } | null = null;
  if (body.authMode !== undefined) {
    const validation = validateAuthModeChange(body);
    if (!validation.ok) {
      return c.json(validation.body, validation.status);
    }
    const prev = (await repos.instanceSettings.get())?.authMode ?? null;
    patch.authMode = validation.value;
    authModeChange = {
      before: (prev as AuthMode | null) ?? null,
      after: validation.value,
    };
  }
  if (body.tunnelProvider !== undefined) patch.tunnelProvider = body.tunnelProvider || null;
  if (body.tunnelToken !== undefined) patch.tunnelToken = body.tunnelToken || null;
  if (body.defaultBuildMode !== undefined) patch.defaultBuildMode = body.defaultBuildMode || "auto";
  if (body.defaultRollbackWindow !== undefined) {
    patch.defaultRollbackWindow = normalizeRollbackWindow(body.defaultRollbackWindow);
  }
  if (body.invitationMailSource !== undefined) {
    const raw = body.invitationMailSource;
    if (raw !== "platform" && raw !== "cloud") {
      return c.json(
        { error: "invitationMailSource must be 'platform' or 'cloud'" },
        400,
      );
    }
    patch.invitationMailSource = raw;
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  await repos.instanceSettings.upsert(patch);

  clearAuthModeCache();

  if (authModeChange) {
    const user = c.get("user") as { id?: string } | undefined;
    const orgIdRaw = c.get("activeOrganizationId");
    const organizationId =
      typeof orgIdRaw === "string" && orgIdRaw.length > 0 ? orgIdRaw : "instance";
    audit.recordAsync(auditContextFrom(c, organizationId, user?.id ?? null), {
      eventType: "auth-mode-changed",
      resourceType: "instance-settings",
      resourceId: "instance",
      before: { authMode: authModeChange.before },
      after: { authMode: authModeChange.after },
    });
  }

  return c.json({ ok: true });
}

/** DELETE /system/settings - remove server configuration */
export async function deleteSettings(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  await repos.instanceSettings.delete();

  // Also clear all servers since SSH config lives in the servers table.
  // Purge per-server grants alongside each server so we don't leave
  // orphan resource_grant rows pointing at deleted resources.
  const serverList = await repos.server.list();
  for (const s of serverList) {
    if (s.organizationId) {
      await repos.resourceGrant
        .deleteForResource(s.organizationId, "server", s.id)
        .catch((err: unknown) =>
          console.error("[deleteSettings] server grant cleanup failed:", err),
        );
      await repos.resourceGrant
        .deleteForResource(s.organizationId, "mail_server", s.id)
        .catch((err: unknown) =>
          console.error("[deleteSettings] mail_server grant cleanup failed:", err),
        );
    }
    await repos.server.delete(s.id);
  }

  sshManager.invalidate();
  await invalidateOpenRestyPaths();
  clearAuthModeCache();
  return c.json({ ok: true });
}

// ── Onboarding (first-run, no auth required) ─────────────────────────────────

/**
 * GET /system/onboarding - check whether onboarding is complete.
 * No auth required - used by CLI polling and first-run detection.
 */
export async function onboardingStatus(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const servers = await repos.server.list();
  return c.json({ configured: servers.length > 0 });
}

// ── Auth upgrade (zero-auth → local-auth) ────────────────────────────────────

/**
 * POST /system/upgrade-to-auth — promote the synthetic zero-auth user
 * to a real email/password account.
 *
 * Only callable while `authMode === "none"`. Steps:
 *
 *   1. Locate the existing local user via ensureLocalUser (preserves
 *      userId so every existing FK — projects, deployments, member,
 *      audit — keeps resolving).
 *   2. UPDATE user.{name,email,emailVerified,autoProvisioned=false}.
 *   3. Insert a credential-provider account row with the hashed
 *      password (Better Auth's own hasher).
 *   4. If `useOwnMailServer === true` and a provisioned mail server
 *      exists, ensureOpenshipPlatformMailbox(serverId) so the platform
 *      transport is ready for the new login emails.
 *   5. Flip instanceSettings.authMode "none" → "local" (audit row).
 *   6. Mint a Better Auth session and stamp the response cookie so the
 *      browser stays signed in across the redirect.
 *
 * Reversible up to step 5: any failure before the authMode flip leaves
 * the instance in zero-auth mode and the operator can retry.
 */
export async function upgradeToAuth(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const settings = await repos.instanceSettings.get();
  const currentMode = settings?.authMode ?? "none";
  if (currentMode !== "none") {
    return c.json(
      {
        error:
          "Auth upgrade is only available from zero-auth mode. Current mode: " +
          currentMode,
      },
      400,
    );
  }

  const body = (await c.req.json()) as {
    name?: unknown;
    email?: unknown;
    password?: unknown;
    useOwnMailServer?: unknown;
  };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const useOwnMailServer = body.useOwnMailServer === true;

  if (!name || name.length < 1 || name.length > 100) {
    return c.json({ error: "name is required (1-100 chars)" }, 400);
  }
  if (!email || !email.includes("@") || email.length > 254) {
    return c.json({ error: "email must be a valid address" }, 400);
  }
  if (password.length < 8 || password.length > 128) {
    return c.json({ error: "password must be 8-128 characters" }, 400);
  }

  // Reject if the email collides with an OTHER user (we DO allow it to
  // collide with the local synthetic user — that's the row we're
  // rewriting).
  const existingByEmail = await repos.user.findByEmail(email);
  const localUser = await ensureLocalUser();
  if (existingByEmail && existingByEmail.id !== localUser.id) {
    return c.json({ error: "An account with this email already exists" }, 409);
  }

  const hashed = await hashPassword(password);

  // 1+2+3. Update user + insert credential account in one transaction.
  await db.transaction(async (tx) => {
    await tx
      .update(schema.user)
      .set({
        name,
        email,
        emailVerified: true,
        autoProvisioned: false,
        updatedAt: new Date(),
      })
      .where(eq(schema.user.id, localUser.id));

    // Better Auth's credential provider expects providerId="credential",
    // accountId=userId, and the bcrypt-style hash in `password`. There
    // should be no prior credential row for the zero-auth user; guard
    // by deleting any existing credential row first to keep the call
    // idempotent on retry.
    await tx
      .delete(schema.account)
      .where(
        and(
          eq(schema.account.userId, localUser.id),
          eq(schema.account.providerId, "credential"),
        ),
      );

    await tx.insert(schema.account).values({
      id: generateId("acc"),
      accountId: localUser.id,
      providerId: "credential",
      userId: localUser.id,
      password: hashed,
    });

    // 5. Flip authMode "none" → "local".
    await tx
      .insert(schema.instanceSettings)
      .values({ id: "default", authMode: "local" })
      .onConflictDoUpdate({
        target: schema.instanceSettings.id,
        set: { authMode: "local", updatedAt: new Date() },
      });
  });

  invalidateLocalUserCache();
  clearAuthModeCache();

  // 4. Best-effort: warm the platform mailbox if requested. We don't
  //    fail the upgrade if this errors — sendMail() will fall back to
  //    env-based transport on subsequent emails.
  if (useOwnMailServer) {
    try {
      const mailServers = await repos.mailServer.list();
      const installed = mailServers.find((m) => m.installedAt != null);
      if (installed) {
        const { ensureOpenshipPlatformMailbox } = await import(
          "../mail/admin/platform-mailbox.service"
        );
        await ensureOpenshipPlatformMailbox(installed.serverId);
        invalidatePlatformTransportCache();
      }
    } catch (err) {
      console.warn("[upgradeToAuth] platform mailbox warm-up failed:", err);
    }
  }

  // Audit the mode flip.
  audit.recordAsync(
    auditContextFrom(c, "instance", localUser.id),
    {
      eventType: "auth-mode-changed",
      resourceType: "instance-settings",
      resourceId: "instance",
      before: { authMode: "none" },
      after: { authMode: "local", upgradedUserId: localUser.id, email },
    },
  );

  // 6. Mint a fresh session so the browser stays signed in.
  const ipAddress = c.req.header("x-forwarded-for") ?? "127.0.0.1";
  const userAgent = c.req.header("user-agent") ?? "upgrade";
  const session = await createLocalSession(localUser.id, ipAddress, userAgent);
  await setSignedCookie(
    c,
    `${COOKIE_PREFIX}.session_token`,
    session.token,
    env.BETTER_AUTH_SECRET,
    {
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
      path: "/",
      expires: session.expiresAt,
    },
  );

  return c.json({
    ok: true,
    authMode: "local",
    user: { id: localUser.id, name, email },
  });
}

/**
 * POST /system/onboarding - first-run setup from dashboard/browser.
 *
 * Same logic as `setup()`, but only allowed when the instance has
 * no servers configured yet. This avoids requiring auth tokens for
 * the initial onboarding flow (desktop, CLI, or direct browser).
 *
 * After the first server is created this endpoint returns 403.
 */
export async function onboardingSetup(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const servers = await repos.server.list();
  if (servers.length > 0) {
    return c.json({ error: "Instance already configured" }, 403);
  }

  // Delegate to the shared setup logic
  return setup(c);
}
