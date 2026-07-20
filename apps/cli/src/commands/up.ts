import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDashboard } from "../lib/dashboard";
import { installAndStart, preview } from "../lib/service";

interface UpOpts {
  port?: string;
  dataDir?: string;
  dashboardPort?: string;
  ui?: boolean;
  uiVersion?: string;
  foreground?: boolean;
  dryRun?: boolean;
  publicUrl?: string;
  trustProxy?: boolean;
  /** Install OpenResty + Let's Encrypt on this box and route --public-url here. */
  managedEdge?: boolean;
  /** ACME contact email for the managed edge. */
  acmeEmail?: string;
}

/** Normalize a URL/host to `scheme://host`, or null if unparseable. Shared with
 *  the setup wizard so there's one URL-normalization rule. */
export function normalizeUrl(raw: string): string | null {
  const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Normalize a --public-url value, or exit with a hint if it's malformed. */
function normalizePublicUrl(raw: string): string {
  const url = normalizeUrl(raw);
  if (!url) {
    console.error(
      chalk.red(`\n  Invalid --public-url: ${raw}`) +
        chalk.dim("\n  Expected something like https://ops.example.com\n"),
    );
    process.exit(1);
  }
  return url;
}

// Inlined at build time by tsup (see tsup.config.ts `define`). Used to pin the
// dashboard bundle to this CLI's release so the API and UI versions match.
declare const __CLI_VERSION__: string;

// dist/ (this file is bundled into dist/index.js); the API bundle staged by
// build/stage-server.ts lives alongside it at dist/server/.
const DIST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(DIST_DIR, "server");
const OS_DIR = join(homedir(), ".openship");

/** Persist a stable auth secret so sessions survive restarts. */
function ensureAuthSecret(): string {
  const path = join(OS_DIR, "auth-secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(OS_DIR, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

/**
 * Persist a stable INTERNAL_TOKEN. The API is booted with it (so zero-auth is
 * off), and the `openship` setup wizard reads the SAME file to authenticate its
 * one-shot POST /system/bootstrap-admin. A browser reaching the API through the
 * public proxy has no token, so it can't create the admin.
 */
export function ensureInternalToken(): string {
  const path = join(OS_DIR, "internal-token");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(OS_DIR, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

export const upCommand = new Command("up")
  .description("Start Openship as a persistent service (boot + auto-restart); --foreground to run attached")
  .option("--port <port>", "API port to listen on", "4000")
  .option("--data-dir <dir>", "Directory for the embedded database")
  .option("--dashboard-port <port>", "Dashboard port", "3001")
  .option("--no-ui", "Run the API only — don't download/serve the dashboard")
  .option("--ui-version <tag>", "Dashboard release tag to run (default: this CLI's version)")
  .option("-f, --foreground", "Run attached in this terminal instead of as a background service")
  .option("--dry-run", "Print the service definition that would be installed, then exit")
  .option(
    "--public-url <url>",
    "Serve remotely at this public URL (VPS): binds the dashboard to all interfaces, proxies the API same-origin, and requires login",
  )
  .option(
    "--trust-proxy",
    "Trust the X-Real-IP set by a reverse proxy in front (the proxy MUST overwrite X-Real-IP with the real client IP, e.g. `proxy_set_header X-Real-IP $remote_addr`, and the app port MUST be firewalled so only the proxy can reach it; enables per-client rate limiting)",
  )
  .option(
    "--managed-edge",
    "Managed edge: install OpenResty + a free Let's Encrypt cert on this box and route --public-url's domain to the dashboard (no reverse proxy needed)",
  )
  .option("--acme-email <email>", "Contact email for Let's Encrypt certificates (managed edge)")
  .action(async (opts: UpOpts) => {
    if (opts.foreground) return runForeground(opts);
    startService(opts);
  });

/**
 * Default `openship up`: install + start Openship as a persistent service that
 * auto-restarts on crash and starts on boot, running until `openship stop`.
 */
export function startService(
  opts: UpOpts,
  runOpts: { quiet?: boolean } = {},
): { port: string; dashPort: string; publicUrl?: string } {
  const publicUrl = opts.publicUrl ? normalizePublicUrl(opts.publicUrl) : undefined;
  const port = String(opts.port || "4000");
  const dashPort = String(opts.dashboardPort || "3001");
  const flags = {
    port: opts.port,
    dataDir: opts.dataDir,
    dashboardPort: opts.dashboardPort,
    ui: opts.ui,
    uiVersion: opts.uiVersion,
    publicUrl,
    trustProxy: opts.trustProxy || opts.managedEdge, // managed edge = OpenResty sets XFF
    managedEdge: opts.managedEdge,
    acmeEmail: opts.acmeEmail,
  };
  if (opts.dryRun) {
    const p = preview(flags);
    console.log(
      chalk.dim(`\n  service manager: ${p.kind}\n  path: ${p.path}\n\n`) + p.content + "\n",
    );
    return { port, dashPort, publicUrl };
  }
  try {
    const res = installAndStart(flags);
    // The wizard renders its own summary via clack — stay silent for it.
    if (!runOpts.quiet) {
      const dashboardLine = publicUrl
        ? chalk.dim(`  Dashboard: ${publicUrl}  (login required)\n`)
        : chalk.dim(`  Dashboard: http://localhost:${dashPort}  (login required)\n`);
      console.log(
        chalk.green("\n  ✔ Openship is running as a service.\n") +
          (opts.ui !== false ? dashboardLine : "") +
          (publicUrl
            ? chalk.dim("  API is proxied through the dashboard (not exposed). Point your reverse proxy / DNS at the dashboard port.\n")
            : chalk.dim(`  API:       http://localhost:${port}/api\n`)) +
          chalk.dim(`  ${res.detail}\n`) +
          chalk.dim("  Starts on boot and auto-restarts. Stop with `openship stop`.\n"),
      );
    }
    return { port, dashPort, publicUrl };
  } catch (e) {
    if (runOpts.quiet) throw e; // let the wizard present the failure
    console.error(
      chalk.red(`\n  Couldn't install the service: ${(e as Error).message}\n`) +
        chalk.dim("  Run `openship up --foreground` to run it attached instead.\n"),
    );
    process.exit(1);
  }
}

/** Run the API + dashboard attached to this terminal (also what the service runs). */
async function runForeground(opts: UpOpts): Promise<void> {
    const serverEntry = join(SERVER_DIR, "index.js");
    if (!existsSync(serverEntry)) {
      console.error(
        chalk.red("\n  Bundled server not found in this install.") +
          chalk.dim("\n  Reinstall with `openship update` (or `npm i -g openship`).\n"),
      );
      process.exit(1);
    }

    const port = String(opts.port || "4000");
    const dashPort = String(opts.dashboardPort || "3001");
    const publicUrl = opts.publicUrl ? normalizePublicUrl(opts.publicUrl) : undefined;
    const managedEdge = Boolean(opts.managedEdge && publicUrl);
    const dataDir: string = opts.dataDir || join(OS_DIR, "data");
    mkdirSync(dataDir, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: port,
      NODE_ENV: "production",
      // desktop mode → in-process job runner (no Redis).
      DEPLOY_MODE: "desktop",
      OPENSHIP_TARGET: "local",
      OPENSHIP_JOB_RUNNER: "in-process",
      PGLITE_DATA_DIR: dataDir,
      OPENSHIP_MIGRATIONS_DIR: join(SERVER_DIR, "migrations"),
      OPENSHIP_PGLITE_ASSETS_DIR: join(SERVER_DIR, "pglite"),
      BETTER_AUTH_SECRET: ensureAuthSecret(),
    };
    // CLI-managed instances ALWAYS require login (zero-auth is desktop-only).
    // The admin is created by `openship` setup via the internal-token-gated
    // bootstrap endpoint; both processes share this token file.
    env.OPENSHIP_REQUIRE_AUTH = "true";
    env.INTERNAL_TOKEN = ensureInternalToken();
    // The API ALWAYS binds loopback under the CLI — reachable only by the setup
    // wizard and the dashboard proxy on this same box, never exposed on
    // 0.0.0.0. Only the dashboard is ever public, and only in --public-url mode.
    env.OPENSHIP_API_HOST = "127.0.0.1";
    delete env.OPENSHIP_ALLOW_ZERO_AUTH;
    if (publicUrl) {
      // Serve the dashboard publicly; it proxies to the loopback API above.
      env.OPENSHIP_PUBLIC_URL = publicUrl;
    }
    // Only trust the forwarded client IP (X-Real-IP) when an operator confirms a
    // real proxy is in front that OVERWRITES it — otherwise a client that can
    // reach the app port directly could forge X-Real-IP (see client-ip).
    if (opts.trustProxy || managedEdge) env.TRUST_PROXY = "true";
    // Managed edge: the API boot hook (self-edge) installs OpenResty + a free
    // Let's Encrypt cert on this box and routes the public hostname → the
    // loopback dashboard. OpenResty terminates TLS and sets XFF (trusted above).
    if (managedEdge) {
      env.OPENSHIP_MANAGED_EDGE = "true";
      env.OPENSHIP_DASHBOARD_PORT = dashPort;
      if (opts.acmeEmail) env.OPENSHIP_ACME_EMAIL = opts.acmeEmail;
    }
    delete env.DATABASE_URL;
    delete env.POSTGRES_URL;

    const spinner = ora(`Starting Openship on http://localhost:${port} …`).start();
    const child = spawn(process.execPath, [serverEntry], { env, stdio: ["ignore", "pipe", "pipe"] });

    // Buffer output until healthy; on early exit, surface the tail.
    let buffered = "";
    const buffer = (d: Buffer) => {
      buffered += d.toString();
    };
    child.stdout.on("data", buffer);
    child.stderr.on("data", buffer);
    child.on("exit", (code) => {
      if (code && code !== 0) {
        spinner.fail(`Openship server exited (code ${code})`);
        process.stderr.write(buffered.slice(-2000));
        process.exit(code);
      }
    });

    const healthUrl = `http://127.0.0.1:${port}/api/health`;
    let healthy = false;
    for (let i = 0; i < 60 && child.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // not up yet
      }
    }

    if (!healthy) {
      spinner.fail("Openship did not become healthy in time");
      process.stderr.write(buffered.slice(-2000));
      child.kill("SIGTERM");
      process.exit(1);
    }

    spinner.succeed(`Openship API running at http://localhost:${port}`);

    // Track every child so Ctrl-C / a fatal exit tears them all down together.
    const children = [child];
    const stopAll = () => {
      for (const c of children) {
        try {
          c.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            c.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, 5000).unref?.();
      }
    };

    // Dashboard (unless --no-ui): lazy-downloaded from GitHub releases, then run
    // alongside the API. A UI failure is non-fatal — the API keeps serving.
    let dashboardUrl: string | null = null;
    if (opts.ui !== false) {
      const uiSpinner = ora("Preparing the dashboard…").start();
      try {
        const bundle = await ensureDashboard({
          tag: opts.uiVersion || `v${__CLI_VERSION__}`,
          onProgress: (received, total) => {
            if (total) {
              uiSpinner.text = `Downloading dashboard… ${Math.round((received / total) * 100)}%`;
            }
          },
        });
        uiSpinner.text = "Starting the dashboard…";
        const dash = spawn(process.execPath, [bundle.entry], {
          cwd: bundle.cwd,
          env: {
            ...process.env,
            NODE_ENV: "production",
            OPENSHIP_TARGET: "local",
            PORT: dashPort,
            // Reachable remotely when public; loopback-only otherwise. Under
            // managed edge the local OpenResty fronts the dashboard, so it stays
            // on loopback even though there's a public URL.
            HOSTNAME: publicUrl && !managedEdge ? "0.0.0.0" : "127.0.0.1",
            // The dashboard's same-origin proxy (NEXT_PUBLIC_API_PROXY, baked
            // into the release build) forwards /api/proxy/* to this address, so
            // the browser never needs to know where the API lives. Set in every
            // mode; loopback because the dashboard runs on the same box.
            INTERNAL_API_URL: `http://127.0.0.1:${port}`,
            // Public URL feeds the SSR proxy-origin resolver; local mode keeps
            // the window.__OPENSHIP_API_ORIGIN__ fallback for direct API calls.
            ...(publicUrl
              ? { OPENSHIP_PUBLIC_URL: publicUrl }
              : { OPENSHIP_LOCAL_API_URL: `http://127.0.0.1:${port}` }),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(dash);
        let dashBuf = "";
        const onDash = (d: Buffer) => {
          dashBuf += d.toString();
        };
        dash.stdout.on("data", onDash);
        dash.stderr.on("data", onDash);

        let dashUp = false;
        for (let i = 0; i < 45 && dash.exitCode === null; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const res = await fetch(`http://127.0.0.1:${dashPort}`, { signal: AbortSignal.timeout(2000) });
            if (res.status < 500) {
              dashUp = true;
              break;
            }
          } catch {
            /* not up yet */
          }
        }
        if (dashUp) {
          dashboardUrl = publicUrl ?? `http://localhost:${dashPort}`;
          uiSpinner.succeed(`Dashboard running at ${dashboardUrl}`);
          dash.stdout.off("data", onDash);
          dash.stderr.off("data", onDash);
          dash.stdout.on("data", (d) => process.stdout.write(d));
          dash.stderr.on("data", (d) => process.stderr.write(d));
        } else {
          uiSpinner.warn("Dashboard didn't come up in time — continuing with the API only.");
          process.stderr.write(dashBuf.slice(-1000));
        }
      } catch (e) {
        uiSpinner.warn(`Dashboard unavailable: ${(e as Error).message}`);
        console.log(
          chalk.dim(
            "  The API is still running. Retry `openship up`, pass --no-ui, or use `openship install` for the desktop app.\n",
          ),
        );
      }
    }

    if (publicUrl) {
      console.log(
        (dashboardUrl ? chalk.dim(`  Dashboard: ${dashboardUrl}  (login required)\n`) : "") +
          chalk.dim("  API is proxied through the dashboard (bound to loopback, not exposed).\n") +
          chalk.dim(`  Data:      ${dataDir}\n`) +
          (managedEdge
            ? chalk.dim("  Managed edge (OpenResty + Let's Encrypt) fronts this box — point your domain's A record at this server's IP. Stop with Ctrl-C.\n")
            : chalk.dim("  Point your reverse proxy / DNS at the dashboard port. Stop with Ctrl-C.\n")),
      );
    } else {
      console.log(
        chalk.dim(`  API:       http://localhost:${port}/api\n`) +
          (dashboardUrl ? chalk.dim(`  Dashboard: ${dashboardUrl}  (login required)\n`) : "") +
          chalk.dim(`  Data:      ${dataDir}\n`) +
          chalk.dim("  Log in with your admin account (run `openship` to create one). Stop with Ctrl-C.\n"),
      );
    }

    // API: switch from buffering to live passthrough for the rest of the run.
    child.stdout.off("data", buffer);
    child.stderr.off("data", buffer);
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));

    process.on("SIGINT", stopAll);
    process.on("SIGTERM", stopAll);
    // If the API dies, bring the dashboard down with it and exit.
    child.on("exit", (code) => {
      stopAll();
      process.exit(code ?? 0);
    });
}
