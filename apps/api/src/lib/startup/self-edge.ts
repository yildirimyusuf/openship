/**
 * Managed edge — provision OpenResty + a free Let's Encrypt cert for the
 * control plane's OWN hostname, reusing the app-deploy infra (SystemManager +
 * NginxProvider) over a LocalExecutor. The CLI boots the API as
 * DEPLOY_MODE=desktop, so the global `platform()` is the Noop provider — we
 * build our own bare infra just for the edge, leaving the app runtime untouched.
 *
 * ONE provisioning function, two drivers, guarded by a single in-flight lock so
 * certbot never runs twice at once:
 *   - the boot hook (fire-and-forget, retries on reboot until a cert exists);
 *   - POST /api/system/self-register (the setup wizard), which streams live
 *     progress into a setup-session for the CLI spinner.
 */

import { env } from "../../config/env";
import { registerStartupHook } from "./index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SelfEdgeProgress {
  onLog?: (message: string, level?: "info" | "warn" | "error") => void;
  onStep?: (
    step: "openresty" | "route" | "ssl",
    status: "installing" | "installed" | "failed",
  ) => void;
  /** Cert-issuance retry backoffs (ms). Defaults to the boot-hook set. */
  backoffs?: number[];
}

export interface SelfEdgeResult {
  verified: boolean;
  reason?: string;
  expiresAt?: string;
}

export interface SelfEdgeOptions {
  /**
   * User accepted taking over ports 80/443 from an existing proxy. Without it,
   * an occupied edge makes the OpenResty install throw rather than blind-kill.
   */
  edgeTakeover?: boolean;
  /**
   * User accepted MIGRATING the existing proxy's sites into Openship before
   * taking over. Runs the full scan → import → takeover orchestration.
   */
  edgeMigrate?: boolean;
}

// Long, patient backoffs for the unattended boot hook (DNS may still be
// propagating). The wizard passes a shorter set so its spinner resolves.
const BOOT_BACKOFFS = [15_000, 45_000, 120_000];

let inFlight: Promise<SelfEdgeResult> | null = null;

/**
 * Provision the local OpenResty edge for `hostname` → the loopback dashboard.
 * Single-flight: concurrent callers (boot hook + wizard endpoint) share one run.
 */
export function provisionSelfEdge(
  hostname: string,
  dashPort: number,
  progress?: SelfEdgeProgress,
  options?: SelfEdgeOptions,
): Promise<SelfEdgeResult> {
  if (inFlight) return inFlight;
  inFlight = runProvision(hostname, dashPort, progress, options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runProvision(
  hostname: string,
  dashPort: number,
  progress?: SelfEdgeProgress,
  options?: SelfEdgeOptions,
): Promise<SelfEdgeResult> {
  const log = (message: string, level: "info" | "warn" | "error" = "info") => {
    if (progress?.onLog) progress.onLog(message, level);
    else console.log(`[edge] ${message}`);
  };

  // Edge install needs a root Linux host (apt/dnf + certbot + systemd).
  if (process.platform !== "linux") {
    log("managed edge needs a Linux host — skipping (use a reverse proxy in front).", "warn");
    return { verified: false, reason: "not_linux" };
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    log("managed edge needs root (to install OpenResty/certbot) — skipping.", "warn");
    return { verified: false, reason: "not_root" };
  }

  // Loaded lazily so a non-managed boot never pulls the infra stack.
  const {
    createExecutor,
    SystemManager,
    NginxProvider,
    detectOpenRestyPaths,
    probeEdge,
    scanImportableSites,
    canImportProxy,
    runEdgeTakeover,
  } = await import("@repo/adapters");
  const executor = createExecutor(); // LocalExecutor — this same machine

  // Migrate path: import the existing proxy's sites, take over 80/443, and add
  // the control plane's own hostname as an extra route — one orchestrated run.
  if (options?.edgeMigrate) {
    progress?.onStep?.("openresty", "installing");
    const status = await probeEdge(executor);
    const proxy = status.occupants.find((o) => o.proxy)?.proxy;
    const scan = proxy && canImportProxy(proxy)
      ? await scanImportableSites(executor, proxy)
      : { sites: [], warnings: [] };
    const res = await runEdgeTakeover(
      executor,
      {
        status,
        sites: scan.sites,
        acmeEmail: env.OPENSHIP_ACME_EMAIL,
        extraRoutes: [{ domain: hostname, targetUrl: `http://127.0.0.1:${dashPort}`, tls: true }],
      },
      (entry) => log(entry.message, entry.level),
    );
    progress?.onStep?.("openresty", res.ok ? "installed" : "failed");
    progress?.onStep?.("route", res.ok ? "installed" : "failed");
    progress?.onStep?.("ssl", res.ok ? "installed" : "failed");
    if (!res.ok) return { verified: false, reason: "migrate_failed" };
    return { verified: true };
  }

  // 1. Install OpenResty + certbot (idempotent — short-circuits when ready).
  //    edgeTakeover authorizes reclaiming 80/443 from an existing proxy; without
  //    it an occupied edge throws EdgeConflictError instead of blind-killing.
  progress?.onStep?.("openresty", "installing");
  const installerConfig = options?.edgeTakeover
    ? { edgePolicy: { mode: "takeover" as const, stopTargets: [] } }
    : undefined;
  const system = new SystemManager("bare", { executor, installerConfig });
  await system.ensureFeature("ssl", (entry) => log(entry.message));
  progress?.onStep?.("openresty", "installed");

  // 2. Register hostname → loopback dashboard (HTTP vhost first; serves the
  //    ACME webroot so certbot can validate before a cert exists).
  progress?.onStep?.("route", "installing");
  const paths = await detectOpenRestyPaths(executor);
  const nginx = new NginxProvider({ paths, executor, acmeEmail: env.OPENSHIP_ACME_EMAIL });
  await nginx.registerRoute({
    domain: hostname,
    tls: true,
    targetUrl: `http://127.0.0.1:${dashPort}`,
  });
  progress?.onStep?.("route", "installed");
  log(`routing ${hostname} → http://127.0.0.1:${dashPort}`);

  // 3. Issue the Let's Encrypt cert. Retry so a not-yet-propagated A record
  //    doesn't permanently fail — the HTTP vhost keeps answering ACME between
  //    tries; if all retries fail, the next boot re-attempts.
  progress?.onStep?.("ssl", "installing");
  const backoffs = progress?.backoffs ?? BOOT_BACKOFFS;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      const res = await nginx.provisionCert(hostname);
      if (res.verified) {
        log(`TLS certificate issued for ${hostname} (expires ${res.expiresAt || "?"})`);
        progress?.onStep?.("ssl", "installed");
        return { verified: true, expiresAt: res.expiresAt };
      }
      log(
        `certificate not ready (${res.reason ?? "pending"})${attempt < backoffs.length ? " — retrying" : ""}`,
        "warn",
      );
    } catch (err) {
      log(`certbot error: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    if (attempt < backoffs.length) await sleep(backoffs[attempt]);
  }
  progress?.onStep?.("ssl", "failed");
  log(`could not issue TLS for ${hostname} yet — will retry on next boot (site still serves over HTTP).`, "warn");
  return { verified: false, reason: "cert_pending" };
}

/** Register the boot hook. Called from register.ts. */
export function registerSelfEdge(): void {
  registerStartupHook({
    id: "edge:self-register",
    modes: ["desktop", "selfhosted"],
    run: async () => {
      if (!env.OPENSHIP_MANAGED_EDGE || !env.OPENSHIP_PUBLIC_URL) return;

      // If a migrate/takeover crashed mid-flight last run, roll it back so
      // 80/443 aren't left dark. Best-effort; needs a root Linux host.
      if (process.platform === "linux" && (typeof process.getuid !== "function" || process.getuid() === 0)) {
        try {
          const { createExecutor, recoverInterruptedTakeover } = await import("@repo/adapters");
          await recoverInterruptedTakeover(createExecutor(), (e) => console.log(`[edge] ${e.message}`));
        } catch {}
      }

      let hostname: string;
      try {
        hostname = new URL(env.OPENSHIP_PUBLIC_URL).hostname;
      } catch {
        console.warn(`[edge] OPENSHIP_PUBLIC_URL is not a valid URL — skipping managed edge.`);
        return;
      }
      if (!hostname || hostname === "localhost") return; // nothing to route
      // First-run provisioning is driven by the wizard's self-register endpoint
      // (so it can stream live progress). Here we only RE-ENSURE on reboot:
      // act only once a domain row exists (setup ran) and its cert isn't active
      // yet. On the very first boot there's no row, so this no-ops — no race.
      try {
        const { repos } = await import("@repo/db");
        const row = await repos.domain.findByHostname(hostname);
        if (!row || row.sslStatus === "active") return;
      } catch {
        return;
      }
      const dashPort = env.OPENSHIP_DASHBOARD_PORT || 3001;
      void provisionSelfEdge(hostname, dashPort).catch((err) =>
        console.warn("[edge] self-register failed:", err),
      );
    },
  });
}
