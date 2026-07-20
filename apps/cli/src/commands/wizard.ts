/**
 * Interactive setup — what runs when you type `openship` with no subcommand.
 *
 * The one-command self-deploy: ask a few questions, then reuse the exact
 * `openship up` pipeline (prebuilt API + dashboard, no build) to install
 * Openship as a boot service, create the first admin, and — reusing Openship's
 * OWN app + domain pipeline — register the control plane as an **app** (it shows
 * up under Apps) with a domain:
 *   - Free   name.opsh.io  → Openship Cloud edge (Oblien); connects Cloud in-flow
 *   - Custom your-domain   → OpenResty + a free Let's Encrypt cert on this box
 *   - BYO    your-domain   → you run your own reverse proxy in front
 *
 * No new deploy machinery — Openship deploys itself with its own tools.
 * UI is @clack/prompts (modern, keyboard-driven).
 */

import chalk from "chalk";
import open from "open";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  intro,
  outro,
  text,
  password,
  select,
  confirm,
  spinner,
  note,
  log,
  cancel,
  isCancel,
} from "@clack/prompts";

import { startService, ensureInternalToken, normalizeUrl } from "./up";

/** Exit cleanly on Ctrl-C / Esc; otherwise narrow away clack's cancel symbol. */
function ensure<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
  return value as T;
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/* ── loopback API helpers (internal-token gated) ─────────────────────────── */

async function internalGet(port: string, path: string): Promise<any | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "X-Internal-Token": ensureInternalToken() },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function internalPost(port: string, path: string, body: unknown): Promise<{ ok: boolean; data: any }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": ensureInternalToken() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch (err) {
    return { ok: false, data: { error: (err as Error).message } };
  }
}

/** POST the first admin to the internal-token-gated bootstrap endpoint. */
async function bootstrapAdmin(
  apiPort: string,
  admin: { name: string; email: string; password: string },
): Promise<{ ok: boolean; message?: string }> {
  const { ok, data } = await internalPost(apiPort, "/api/system/bootstrap-admin", admin);
  if (ok) return { ok: true };
  if (data?.error === "An admin account already exists") return { ok: true, message: "already-exists" };
  return { ok: false, message: data?.error || "failed" };
}

async function waitHealthy(apiPort: string, seconds = 90): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      /* not up yet */
    }
  }
  return false;
}

/** Best-effort public IP for the A-record hint + edge-proxy target. */
async function detectPublicIp(): Promise<string | null> {
  for (const url of ["https://api.ipify.org", "https://ifconfig.me/ip"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (/^[0-9.]+$/.test(ip) || ip.includes(":")) return ip;
    } catch {
      /* try next */
    }
  }
  return null;
}

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Connect the org owner to Openship Cloud via the browser PKCE handshake, then
 * finalize on the loopback API (internal-token gated). Returns true when linked.
 */
async function connectOpenshipCloud(port: string): Promise<boolean> {
  const already = await internalGet(port, "/api/system/cloud-status");
  if (already?.connected) {
    log.success(`Already connected to Openship Cloud${already.user?.email ? ` as ${already.user.email}` : ""}.`);
    return true;
  }

  const capsEnv = await internalGet(port, "/api/health/env");
  const cloudApiUrl: string | undefined = capsEnv?.cloudApiUrl;
  if (!cloudApiUrl) {
    log.error("Couldn't discover the Openship Cloud URL — free domain unavailable. Use a custom domain instead.");
    return false;
  }

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  // Loopback listener captures the browser redirect (?code&state).
  const codePromise = new Promise<string | null>((resolve) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      if (!u.pathname.startsWith("/callback")) {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get("code");
      const gotState = u.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        "<html><body style='font:16px system-ui;padding:3rem;text-align:center'>" +
          "<h2>Openship Cloud connected</h2><p>You can close this window and return to your terminal.</p></body></html>",
      );
      server.close();
      resolve(code && gotState === state ? code : null);
    });
    server.on("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      const cbPort = (server.address() as AddressInfo).port;
      const redirect = `http://127.0.0.1:${cbPort}/callback`;
      const handoff =
        `${cloudApiUrl.replace(/\/$/, "")}/api/cloud/connect-handoff` +
        `?redirect=${encodeURIComponent(redirect)}&state=${state}&code_challenge=${challenge}`;
      note(handoff, "Open this URL to authorize (opening your browser…)");
      void open(handoff).catch(() => {});
    });
    setTimeout(() => {
      try {
        server.close();
      } catch {
        /* already closed */
      }
      resolve(null);
    }, 300_000);
  });

  const s = spinner();
  s.start("Waiting for Openship Cloud authorization in your browser");
  const code = await codePromise;
  if (!code) {
    s.stop("Openship Cloud wasn't authorized.", 1);
    return false;
  }
  s.message("Linking this instance to Openship Cloud");
  const res = await internalPost(port, "/api/system/cloud-connect", { code, codeVerifier: verifier });
  if (!res.ok) {
    s.stop(`Couldn't link Openship Cloud: ${res.data?.error || "failed"}`, 1);
    return false;
  }
  s.stop("Connected to Openship Cloud.");
  return true;
}

/** Prompt for a local admin (name / email / password). Used for the self-hosted
 *  paths and as the cloud-path fallback when the browser connect is declined. */
async function promptLocalAdmin(): Promise<{ name: string; email: string; password: string }> {
  const name = ensure(await text({ message: "Your name", validate: (v) => (v?.trim() ? undefined : "Required") })).trim();
  const email = ensure(
    await text({
      message: "Email",
      placeholder: "you@example.com",
      validate: (v) => (v?.includes("@") ? undefined : "Enter a valid email"),
    }),
  )
    .trim()
    .toLowerCase();
  const pw = ensure(
    await password({ message: "Password", validate: (v) => (v && v.length >= 8 ? undefined : "At least 8 characters") }),
  );
  ensure(await password({ message: "Confirm password", validate: (v) => (v === pw ? undefined : "Passwords don't match") }));
  return { name, email, password: pw };
}

/** Consume the self-register SSE stream, driving the spinner until done. */
async function streamProvision(port: string, sessionId: string, s: ReturnType<typeof spinner>): Promise<boolean> {
  let ok = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/system/self-register/stream?id=${sessionId}`, {
      headers: { "X-Internal-Token": ensureInternalToken() },
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok || !res.body) return false;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = /event:\s*(.*)/.exec(frame)?.[1]?.trim();
        const dataRaw = /data:\s*([\s\S]*)/.exec(frame)?.[1]?.trim();
        if (!event) continue;
        if (event === "log" && dataRaw) {
          try {
            const d = JSON.parse(dataRaw);
            if (d.message) s.message(String(d.message).replace(/\s+/g, " ").slice(0, 68));
          } catch {
            /* ignore */
          }
        } else if (event === "complete" && dataRaw) {
          try {
            ok = JSON.parse(dataRaw).status === "completed";
          } catch {
            /* ignore */
          }
        } else if (event === "end") {
          return ok;
        }
      }
    }
  } catch {
    return ok;
  }
  return ok;
}

export async function runWizard(): Promise<void> {
  intro(`${chalk.bgCyan(chalk.black(" Openship "))}${chalk.dim(" setup")}`);
  log.message(
    chalk.dim(
      "Deploy Openship on this machine — a few questions, then it installs itself\nas a service, registers as an app, and prints the URL to log in.",
    ),
  );

  let publicUrl: string | undefined;
  let behindProxy = false;
  let managedEdge = false;
  // Domain wiring executed AFTER the service + admin are up.
  let domainPlan:
    | { type: "free"; slug: string; publicHost: string | null }
    | { type: "custom"; hostname: string }
    | { type: "byo"; hostname: string }
    | { type: "none" } = { type: "none" };

  // 1. Reachability.
  const reach = ensure(
    await select({
      message: "How should this instance be reachable?",
      initialValue: "private",
      options: [
        { value: "private", label: "Private", hint: "this machine only (localhost)" },
        { value: "public", label: "Public", hint: "a server / VPS, reachable from other machines" },
      ],
    }),
  );

  if (reach === "public") {
    const canManage = process.platform === "linux";
    const domainType = ensure(
      await select({
        message: "How do you want a domain + HTTPS?",
        initialValue: "free",
        options: [
          { value: "free", label: "Free domain", hint: "name.opsh.io via Openship Cloud — HTTPS handled for you" },
          ...(canManage
            ? [{ value: "custom", label: "Custom domain", hint: "your domain + free Let's Encrypt on this box" }]
            : []),
          { value: "byo", label: "Bring your own", hint: "your domain, behind your own reverse proxy" },
        ],
      }),
    );

    if (domainType === "free") {
      const slug = ensure(
        await text({
          message: "Choose your subdomain",
          placeholder: "my-openship",
          validate: (v) => (v && SLUG_RE.test(v.trim().toLowerCase()) ? undefined : "Lowercase letters, digits, hyphens"),
        }),
      )
        .trim()
        .toLowerCase();
      const s = spinner();
      s.start("Detecting this server's public IP");
      const publicHost = await detectPublicIp();
      s.stop(publicHost ? `Public IP: ${chalk.bold(publicHost)}` : "Couldn't detect the public IP automatically.");
      publicUrl = `https://${slug}.opsh.io`;
      behindProxy = true; // Oblien's edge sets a trusted XFF
      domainPlan = { type: "free", slug, publicHost };
    } else if (domainType === "custom") {
      const raw = ensure(
        await text({
          message: "Your domain",
          placeholder: "ops.example.com",
          validate: (v) => (v && normalizeUrl(v) ? undefined : "Enter a valid domain"),
        }),
      );
      publicUrl = normalizeUrl(raw)!.replace(/^http:/i, "https:");
      const hostname = new URL(publicUrl).hostname;
      managedEdge = true;
      behindProxy = true; // OpenResty terminates TLS + sets a trusted XFF
      if (typeof process.getuid === "function" && process.getuid() !== 0) {
        log.warn("Managed HTTPS installs OpenResty + certbot — that needs root. Re-run with sudo if it can't install.");
      }
      const s = spinner();
      s.start("Detecting this server's public IP");
      const ip = await detectPublicIp();
      s.stop(ip ? `Public IP: ${chalk.bold(ip)}` : "Couldn't detect the public IP automatically.");
      note(
        `Add a DNS ${chalk.bold("A record")}:\n\n` +
          `  ${chalk.cyan(hostname)}  →  ${chalk.cyan(ip ?? "<this server's public IP>")}\n\n` +
          chalk.dim("HTTPS is issued automatically once DNS resolves (it retries for a couple minutes)."),
        "DNS",
      );
      ensure(await confirm({ message: "A record set? (continue either way — it retries)", initialValue: true }));
      domainPlan = { type: "custom", hostname };
    } else {
      const raw = ensure(
        await text({
          message: "Your domain (served behind your proxy)",
          placeholder: "ops.example.com",
          validate: (v) => (v && normalizeUrl(v) ? undefined : "Enter a valid domain"),
        }),
      );
      publicUrl = normalizeUrl(raw)!;
      behindProxy = true;
      if (publicUrl.startsWith("http://")) {
        log.warn("Serving over plain HTTP sends passwords in cleartext — put HTTPS in front before real use.");
      }
      domainPlan = { type: "byo", hostname: new URL(publicUrl).hostname };
    }
  }

  // 2. Admin account (this instance never runs zero-auth). The free / Openship
  //    Cloud path DERIVES the admin from your cloud login during connect below
  //    (passwordless — same identity pipe as the desktop app), so there's no
  //    local form here. Every other path creates a local admin now.
  const isCloudDomain = domainPlan.type === "free";
  const admin = isCloudDomain ? null : await promptLocalAdmin();

  // 3. Install via the SAME `up` service pipeline (prebuilt, no build).
  const s = spinner();
  s.start("Installing Openship as a service");
  let started: { port: string; dashPort: string; publicUrl?: string };
  try {
    started = startService(
      { publicUrl, trustProxy: behindProxy, managedEdge, acmeEmail: managedEdge ? admin?.email : undefined },
      { quiet: true },
    );
  } catch (e) {
    s.stop("Couldn't install the service.", 1);
    log.error((e as Error).message);
    log.info("Run `openship up --foreground` to run it attached and see the error.");
    process.exit(1);
  }

  s.message("Waiting for Openship to come up");
  if (!(await waitHealthy(started.port))) {
    s.stop("Openship didn't become healthy in time.", 1);
    log.info("Check logs: `openship logs` (or `openship up --foreground`).");
    process.exit(1);
  }

  // Self-hosted paths create the local admin now; the cloud path creates it from
  // your cloud identity during connect (below), so skip the local bootstrap here.
  if (admin) {
    s.message("Creating your admin account");
    const adminRes = await bootstrapAdmin(started.port, admin);
    if (!adminRes.ok) {
      s.stop(`Couldn't create the admin account: ${adminRes.message}`, 1);
      process.exit(1);
    }
    s.stop(
      adminRes.message === "already-exists"
        ? "An admin already exists — use your existing login."
        : `Admin account created for ${admin.email}.`,
    );
  } else {
    s.stop("Openship is up.");
  }

  // 4. Register the control plane as an app + attach its domain (reuse Openship's
  //    own app + domain pipeline). Runs for every mode so it shows under Apps.
  let liveUrl = publicUrl ?? `http://localhost:${started.dashPort}`;
  const port = started.port;

  if (domainPlan.type === "free") {
    // Connect establishes the box admin from your cloud identity (passwordless).
    const linked = await connectOpenshipCloud(port);
    if (!linked) {
      // Cloud wasn't authorized → the box has NO admin yet (the cloud path skips
      // the local form). Create a local admin now so setup never leaves the box
      // login-less, and register without the free domain.
      log.warn("Openship Cloud wasn't connected — set up a local admin instead. You can add the free domain later in Settings → Cloud.");
      const fb = await promptLocalAdmin();
      const abr = await bootstrapAdmin(port, fb);
      if (!abr.ok) {
        log.error(`Couldn't create the admin account: ${abr.message}`);
        process.exit(1);
      }
      await internalPost(port, "/api/system/self-register", { domainType: "byo" }); // still register as an app
    } else {
      const s2 = spinner();
      s2.start("Registering your free domain with Openship Cloud");
      const res = await internalPost(port, "/api/system/self-register", {
        domainType: "free",
        slug: domainPlan.slug,
        publicHost: domainPlan.publicHost,
        dashPort: Number(started.dashPort),
      });
      if (res.ok && res.data?.url) {
        liveUrl = res.data.url;
        s2.stop(`Free domain live: ${res.data.url}`);
      } else {
        s2.stop(`Couldn't register the free domain: ${res.data?.error || "failed"}`, 1);
      }
    }
  } else if (domainPlan.type === "custom") {
    // Managed HTTPS needs ports 80/443. If an existing proxy already owns them,
    // ask before taking over — never silently kill someone's running service.
    let edgeTakeover = false;
    let edgeMigrate = false;
    let proceedCustom = true;
    const pf = await internalPost(port, "/api/system/self-edge/preflight", {});
    const status = pf.ok
      ? (pf.data?.status as
          | { classification: string; canProceedClean: boolean; occupants: Array<{ command?: string; port: number }> }
          | undefined)
      : undefined;
    const importable = pf.ok && Array.isArray(pf.data?.sites) ? (pf.data.sites as unknown[]).length : 0;
    if (status && !status.canProceedClean && status.occupants?.length) {
      const owner = status.occupants.map((o) => o.command ?? `port ${o.port}`).join(", ");
      const known = status.classification === "known";
      const choice = ensure(
        await select({
          message: known
            ? `An existing reverse proxy (${owner}) is serving ports 80/443.`
            : `Ports 80/443 are in use by ${owner}, which we couldn't identify.`,
          options: [
            ...(importable > 0
              ? [{
                  value: "migrate",
                  label: `Migrate ${importable} site${importable === 1 ? "" : "s"} & take over`,
                  hint: "import the existing sites into Openship, then take 80/443",
                }]
              : []),
            {
              value: "override",
              label: "Stop it & take over 80/443",
              hint: known ? "the existing sites stop being served" : "may interrupt a running service",
            },
            { value: "cancel", label: "Cancel — leave it running" },
          ],
          // Per product decision: unknown owner pre-selects takeover; a known
          // proxy defaults to cancel so the user chooses deliberately.
          initialValue: known ? "cancel" : "override",
        }),
      );
      if (choice === "cancel") proceedCustom = false;
      else if (choice === "migrate") edgeMigrate = true;
      else edgeTakeover = true;
    }

    if (!proceedCustom) {
      log.warn(
        "Left the existing proxy on 80/443 running. Registering Openship without managed HTTPS — " +
          "front it with your proxy, or re-run setup to take over.",
      );
      await internalPost(port, "/api/system/self-register", {
        domainType: "byo",
        hostname: domainPlan.hostname,
      });
      liveUrl = `https://${domainPlan.hostname}`;
    } else {
      const res = await internalPost(port, "/api/system/self-register", {
        domainType: "custom",
        hostname: domainPlan.hostname,
        dashPort: Number(started.dashPort),
        acmeEmail: admin?.email,
        edgeTakeover,
        edgeMigrate,
      });
      if (res.ok && res.data?.sessionId) {
        const s2 = spinner();
        s2.start("Issuing HTTPS certificate (OpenResty + Let's Encrypt)");
        const done = await streamProvision(port, res.data.sessionId, s2);
        liveUrl = res.data.url ?? liveUrl;
        if (done) s2.stop(`HTTPS ready: ${liveUrl}`);
        else s2.stop("HTTPS isn't ready yet — it retries on reboot; the site serves over HTTP meanwhile.", 1);
      } else {
        log.warn(`Couldn't start domain provisioning: ${res.data?.error || "failed"}`);
      }
    }
  } else if (domainPlan.type === "byo") {
    const res = await internalPost(port, "/api/system/self-register", {
      domainType: "byo",
      hostname: domainPlan.hostname,
    });
    if (res.ok && res.data?.url) liveUrl = res.data.url;
  } else {
    // Private — still register as an app so it appears under Apps.
    await internalPost(port, "/api/system/self-register", { domainType: "byo" });
  }

  note(
    `${chalk.bold(liveUrl)}\n\n` +
      chalk.dim(`${admin ? `Log in as ${admin.email}` : "Log in with Openship Cloud"}. Openship now appears under your Apps, and runs as a service (restarts on boot).`),
    "Openship is live",
  );
  outro(
    domainPlan.type === "byo"
      ? chalk.dim("Point your reverse proxy at the dashboard port above.")
      : chalk.green("Happy shipping."),
  );
}
