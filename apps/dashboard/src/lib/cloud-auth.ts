import { getCloudApiOrigin, getCloudDashboardUrl } from "@/lib/api/urls";

export const DESKTOP_CLOUD_FLOW = "desktop-cloud";
const DEFAULT_APP_NAME = "Openship Desktop";
const DEFAULT_POLL_INTERVAL_MS = 2000;

type SearchParamsLike = {
  get(name: string): string | null;
};

type DesktopCloudAuthFailure = "start_failed" | "expired" | "error" | "cancelled";

export function buildDesktopAuthorizeUrl(options: {
  cloudAuthUrl?: string;
  callbackUrl: string;
  appName?: string;
  machine?: string | null;
  state?: string | null;
  codeChallenge?: string | null;
}) {
  const baseUrl = getCloudDashboardUrl(options.cloudAuthUrl);
  const params = new URLSearchParams({
    callback: options.callbackUrl,
    app: options.appName || DEFAULT_APP_NAME,
    flow: DESKTOP_CLOUD_FLOW,
  });

  if (options.machine) params.set("machine", options.machine);
  if (options.state) params.set("state", options.state);
  if (options.codeChallenge) params.set("code_challenge", options.codeChallenge);

  return `${baseUrl}/authorize?${params.toString()}`;
}

export function getCloudConnectHandoffUrl(
  callbackUrl: string,
  options?: { state?: string | null; codeChallenge?: string | null },
) {
  const params = new URLSearchParams({ redirect: callbackUrl });
  if (options?.state) params.set("state", options.state);
  if (options?.codeChallenge) params.set("code_challenge", options.codeChallenge);
  return `${getCloudApiOrigin()}/api/cloud/connect-handoff?${params.toString()}`;
}

/* ── PKCE helpers (browser-only) ─────────────────────────────────── */

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 code_verifier — 32 random bytes, base64url-encoded. */
export function generatePkceVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** RFC 7636 S256 code_challenge: base64url(SHA-256(verifier)). */
export async function computePkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

/** Random flow id, used as the storage key for the verifier and the
 *  `state` param on the handoff URL. */
export function generateConnectFlowId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Storage key for the in-flight verifier. localStorage (not sessionStorage)
 *  because the popup runs in a different tab/window and sessionStorage is
 *  per-tab — localStorage is shared across same-origin windows. */
export const CONNECT_PKCE_STORAGE_PREFIX = "openship.cloud-connect.pkce.";

/**
 * Generate a fresh PKCE pair, stash the verifier under a random flow id
 * in localStorage, and return {state, codeChallenge} ready to put on a
 * handoff URL. The callback page reads the verifier back keyed by state.
 *
 * Browser-only: requires `window.localStorage` + `crypto.subtle`. If
 * localStorage is unavailable (private mode, disabled) we still return
 * the pair so the URL gets bound to a challenge — but the round trip
 * will fail at the callback because the verifier is gone. Callers that
 * need a server-side path must wire their own storage.
 */
export async function preparePkceFlow(): Promise<{ state: string; codeChallenge: string }> {
  const flowId = generateConnectFlowId();
  const verifier = generatePkceVerifier();
  const codeChallenge = await computePkceChallenge(verifier);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CONNECT_PKCE_STORAGE_PREFIX + flowId, verifier);
    } catch {
      /* localStorage disabled — callback round trip will fail, but at
       * least the URL is PKCE-bound so a bearer code can't be replayed. */
    }
  }
  return { state: flowId, codeChallenge };
}

export function getCloudDesktopHandoffUrl(options: {
  callbackUrl: string;
  state?: string | null;
  codeChallenge?: string | null;
}) {
  const params = new URLSearchParams({
    redirect: options.callbackUrl,
    ...(options.state ? { state: options.state } : {}),
    ...(options.codeChallenge ? { code_challenge: options.codeChallenge } : {}),
  });

  return `${getCloudApiOrigin()}/api/cloud/desktop-handoff?${params.toString()}`;
}

export function buildAuthPageHref(route: "/login" | "/register" | "/authorize", searchParams: SearchParamsLike) {
  const params = new URLSearchParams();

  for (const key of ["callback", "app", "machine", "state", "code_challenge", "flow"]) {
    const value = searchParams.get(key);
    if (value) params.set(key, value);
  }

  const query = params.toString();
  return query ? `${route}?${query}` : route;
}

export function getPostAuthRedirect(searchParams: SearchParamsLike) {
  const callback = searchParams.get("callback");
  if (!callback) return null;

  if (searchParams.get("flow") === DESKTOP_CLOUD_FLOW) {
    return buildAuthPageHref("/authorize", searchParams);
  }

  return getCloudConnectHandoffUrl(callback);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startDesktopCloudAuth(options: {
  desktop: DesktopBridge;
  isCancelled?: () => boolean;
  pollIntervalMs?: number;
}) {
  const result = await options.desktop.onboarding.cloudAuth();
  if (!result?.ok || !result.nonce) {
    return { ok: false as const, reason: "start_failed" as DesktopCloudAuthFailure };
  }

  const isCancelled = options.isCancelled ?? (() => false);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  while (!isCancelled()) {
    await sleep(pollIntervalMs);
    const poll = await options.desktop.onboarding.cloudAuthPoll(result.nonce);

    if (poll.status === "resolved") {
      return { ok: true as const };
    }

    if (poll.status === "expired" || poll.status === "error") {
      return { ok: false as const, reason: poll.status };
    }
  }

  return { ok: false as const, reason: "cancelled" as DesktopCloudAuthFailure };
}
