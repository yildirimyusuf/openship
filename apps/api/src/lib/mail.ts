import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";
import { repos } from "@repo/db";
import { cloudClient } from "./cloud-client";

/**
 * Email sender with two transport sources:
 *
 *   1. The provisioned platform mailbox on this instance's mail server
 *      (`openship@<state.domain>`), credentials sourced from
 *      `state.platformMailbox` via `ensureOpenshipPlatformMailbox`.
 *      Preferred when a mail server is present.
 *   2. Static env-configured SMTP (SMTP_HOST/USER/PASS). Used as fallback
 *      when no platform mailbox is provisioned, or when a caller
 *      explicitly requests the cloud / env transport.
 *
 * Self-hosted instances without either source no-op gracefully — email
 * features (verification, password reset, invitations) are simply
 * disabled.
 *
 * `smtpEnabled` exported for backward compat: true when EITHER source
 * COULD deliver a message. Callers gated on this still work; new code
 * should prefer `await canSendMail()` for a fresh runtime check.
 */

export type SendMailSource = "platform" | "cloud" | "auto";

export type SendMailOptions = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * Preferred transport source. Default "auto" — uses the platform
   * mailbox when provisioned, otherwise falls back to env-configured
   * SMTP. "platform" forces platform (returns silently if unavailable).
   * "cloud" routes via the SaaS invitation-relay endpoint on a local
   * instance (requires `organizationId`), and uses the SaaS's own
   * env/platform transport when run on the SaaS itself.
   */
  preferSource?: SendMailSource;
  /**
   * Organization ID for the cloud relay path. Required when
   * `preferSource === "cloud"` and we are NOT the SaaS — the cloudClient
   * uses it to resolve the org owner's cloud session token. Ignored on
   * other paths.
   */
  organizationId?: string;
};

// ─── Env-based transport (singleton) ─────────────────────────────────────────

/** True when env SMTP credentials are all present. */
const envSmtpConfigured = !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);

const envTransport: Transporter | null = envSmtpConfigured
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: (env.SMTP_PORT ?? 587) === 465,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    })
  : null;

const envFrom = env.SMTP_FROM;

// ─── Platform transport (cached briefly per serverId) ────────────────────────

interface CachedPlatformTransport {
  transport: Transporter;
  from: string;
  fetchedAt: number;
}

const PLATFORM_TRANSPORT_TTL_MS = 60_000;
const platformTransportCache = new Map<string, CachedPlatformTransport>();

/**
 * Locate the active mail server and (re)build its platform-mailbox
 * transport. Returns null if no mail server is provisioned, or if the
 * ensure*-call throws (we don't want a transient mail-server fault to
 * crash the caller; the env fallback will be tried).
 *
 * Cached for 60s per serverId so we don't hit ensure* on every send.
 */
async function getPlatformTransport(): Promise<{
  transport: Transporter;
  from: string;
} | null> {
  // `@repo/db` is universal (every controller / service / repo consumer
  // already loads it eagerly at boot via `db = await createDb()`), so
  // a dynamic import buys nothing — kept static for clarity. The ONLY
  // dynamic import in this file is `platform-mailbox.service` below,
  // because THAT module pulls in the local-only SSH manager chain that
  // shouldn't load on CLOUD_MODE.
  let mailServers: Array<{ serverId: string; installedAt: Date | null }>;
  try {
    mailServers = (await repos.mailServer.list()) as Array<{
      serverId: string;
      installedAt: Date | null;
    }>;
  } catch (err) {
    console.warn("[mail] mail-server lookup failed:", err);
    return null;
  }
  const installed = mailServers.find((m) => m.installedAt != null) ?? mailServers[0];
  if (!installed) return null;

  const cacheKey = installed.serverId;
  const cached = platformTransportCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PLATFORM_TRANSPORT_TTL_MS) {
    return { transport: cached.transport, from: cached.from };
  }

  try {
    const { ensureOpenshipPlatformMailbox } = await import(
      "../modules/mail/admin/platform-mailbox.service"
    );
    const creds = await ensureOpenshipPlatformMailbox(installed.serverId);
    const transport = nodemailer.createTransport({
      host: creds.smtpHost,
      port: creds.smtpPort,
      secure: creds.secure,
      auth: {
        user: creds.email,
        pass: creds.password,
      },
    });
    const entry: CachedPlatformTransport = {
      transport,
      from: creds.from,
      fetchedAt: Date.now(),
    };
    platformTransportCache.set(cacheKey, entry);
    return { transport, from: creds.from };
  } catch (err) {
    console.warn(
      "[mail] ensureOpenshipPlatformMailbox failed; will fall back to env transport:",
      err,
    );
    return null;
  }
}

// ─── Public surface ──────────────────────────────────────────────────────────

/**
 * Best-effort module-load flag — true if env SMTP is configured OR a
 * platform mailbox is potentially available at runtime.
 *
 * Better Auth needs callbacks wired/unwired at module-load time, so we
 * default this to `true` whenever the install is provisioned (i.e. the
 * mail server / platform mailbox may exist by the time invites are
 * sent). Pure-zero-state instances (no env vars AND code knows a mail
 * server can't appear) can be detected via `canSendMail()` at runtime.
 *
 * `requireEmailVerification` should NOT be derived from this — use
 * `requireEmailVerificationStrict` (env-only) so users aren't locked
 * out when the platform transport drops mid-signup.
 */
export const smtpEnabled = true; // callbacks wired; runtime decides delivery

/**
 * Stricter env-only flag for gating `requireEmailVerification`. Avoids
 * the lockout case where the platform mailbox temporarily fails and a
 * signup can't complete because no verification email got out.
 */
export const requireEmailVerificationStrict = envSmtpConfigured;

/** Runtime check — true if either source could currently deliver. */
export async function canSendMail(): Promise<boolean> {
  if (envSmtpConfigured) return true;
  const platform = await getPlatformTransport();
  return platform !== null;
}

interface ActiveTransport {
  transport: Transporter;
  from: string | undefined;
  source: "platform" | "env";
}

/**
 * Pick the right transport for this call. Order honored by preferSource:
 *   - "auto"     → platform first, env fallback
 *   - "platform" → platform only (no fallback)
 *   - "cloud"    → on the SaaS itself (CLOUD_MODE=true), behaves like
 *                  "auto" — the SaaS uses its own platform/env transport.
 *                  Local instances never reach this branch because
 *                  `sendMail` short-circuits to the cloud-client relay
 *                  before calling `getActiveTransport`.
 */
async function getActiveTransport(
  preferSource: SendMailSource = "auto",
): Promise<ActiveTransport | null> {
  const platform = await getPlatformTransport();
  if (platform) {
    return { transport: platform.transport, from: platform.from, source: "platform" };
  }
  if (preferSource === "platform") {
    return null;
  }
  if (envTransport) {
    return { transport: envTransport, from: envFrom, source: "env" };
  }
  return null;
}

/** Send an email. No-ops with a warning when no transport is available. */
export async function sendMail(opts: SendMailOptions): Promise<void> {
  const preferSource = opts.preferSource ?? "auto";

  // Cloud relay branch — only meaningful on a local self-hosted instance.
  // When CLOUD_MODE=true we ARE the SaaS, so "cloud" falls through to the
  // normal transport selection (the SaaS has its own infra mailer).
  if (preferSource === "cloud" && !env.CLOUD_MODE) {
    if (!opts.organizationId) {
      console.warn(
        "[mail] preferSource=cloud requires organizationId - skipping email to",
        opts.to,
      );
      return;
    }
    // cloud-client is dual-side (local outbound → SaaS) with no local-
    // only side effects on import, so static import is fine. Cargo-cult
    // comment about matching "platform-transport pattern" was wrong —
    // that one IS local-only, this one isn't.
    const result = await cloudClient({
      organizationId: opts.organizationId,
    }).sendInvitation({
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text ?? stripHtmlForText(opts.html),
    });
    if (!result.ok) {
      console.warn(
        `[mail] cloud invitation relay failed for org=${opts.organizationId}: ${result.error}`,
      );
    }
    return;
  }

  const active = await getActiveTransport(preferSource);
  if (!active) {
    console.warn(
      `[mail] no transport configured (preferSource=${preferSource}) - skipping email to`,
      opts.to,
    );
    return;
  }

  await active.transport.sendMail({
    from: active.from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    ...(opts.text ? { text: opts.text } : {}),
  });
}

/**
 * Minimal HTML → plaintext fallback for the cloud relay when a caller
 * supplied only HTML. The SaaS endpoint requires `text` (it never sees
 * the rendered HTML beyond passthrough), so we collapse tags so the
 * payload still validates.
 */
function stripHtmlForText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Invalidate the cached platform transport. Call after a mail-server
 * rotate / uninstall so the next sendMail re-runs ensure* and picks up
 * fresh creds (or correctly drops back to env).
 */
export function invalidatePlatformTransportCache(): void {
  platformTransportCache.clear();
}
