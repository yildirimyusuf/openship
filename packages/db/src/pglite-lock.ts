import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from "fs";
import { dirname, basename, join } from "path";
import { hostname } from "os";
import { spawnSync } from "child_process";

/**
 * Single-instance lock for a PGlite data directory.
 *
 * PGlite is single-process embedded Postgres with NO real cross-process lock —
 * it writes a `-42` sentinel into `postmaster.pid` that identifies no process.
 * Two processes opening the same data dir corrupt the WASM cluster
 * (`RuntimeError: Aborted()`), which is unrecoverable. This lock provides the
 * exclusion PGlite lacks:
 *
 *   - acquisition is atomic (`open(..., "wx")` / O_EXCL) so exactly one process
 *     can ever hold the dir — no concurrent-open corruption is possible;
 *   - it self-heals a crashed previous run (dead pid → reclaim) so a SIGKILL
 *     never wedges the dir shut;
 *   - it only ever creates/removes its own `<dir>.lock` file (a sibling of the
 *     data dir) and never reads, writes, moves, or deletes cluster data — so it
 *     can never lose data.
 */

/**
 * Lock file path — a SIBLING of the data dir, never inside it. PGlite's initdb
 * refuses a non-empty directory when bootstrapping a fresh cluster, so a lock
 * file placed inside the data dir would break every first-time install. Keeping
 * it beside the dir (`<dir>.lock`) leaves the cluster directory pristine.
 */
function lockPathFor(dataDir: string): string {
  return join(dirname(dataDir), `${basename(dataDir)}.lock`);
}

/**
 * Stable per-machine identifier. `os.hostname()` is NOT stable — on macOS it
 * tracks the current network's mDNS/DHCP name and changes when you switch
 * networks (e.g. "bluemac.local" → "bluemac"), so comparing hostnames wrongly
 * flagged a same-machine live lock as a "different host" and told the user to
 * delete a lock a running process legitimately held. We compare the OS machine
 * UUID instead: local to the box, independent of the (possibly shared) data
 * filesystem, so it still distinguishes two real machines mounting one data dir.
 * Falls back to hostname() only if the platform lookup fails.
 */
let cachedMachineId: string | null = null;
function machineId(): string {
  if (cachedMachineId) return cachedMachineId;
  let id = "";
  try {
    if (process.platform === "darwin") {
      const out =
        spawnSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
          encoding: "utf8",
          timeout: 2000,
        }).stdout ?? "";
      id = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? "";
    } else if (process.platform === "win32") {
      const out =
        spawnSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
          encoding: "utf8",
          timeout: 2000,
        }).stdout ?? "";
      id = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i)?.[1] ?? "";
    } else {
      for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          id = readFileSync(p, "utf8").trim();
          if (id) break;
        } catch {
          /* try the next source */
        }
      }
    }
  } catch {
    /* platform lookup failed — fall back to hostname below */
  }
  cachedMachineId = (id || hostname()).trim();
  return cachedMachineId;
}

interface LockRecord {
  pid: number;
  startedAt: number;
  /** Human-readable hostname — for messages only (unstable; not for identity). */
  host: string;
  /** Stable machine UUID — the real identity check. Absent in pre-fix locks. */
  machineId?: string;
}

// Path of the lock this process currently holds (null when unheld). Module-
// scoped so the exit hook and releasePgliteLock can find it without threading
// state through every caller.
let heldLockPath: string | null = null;
let exitHookRegistered = false;

export interface AcquireLockOptions {
  /** Max time to wait for a live holder to release before failing (ms). */
  waitMs?: number;
  /** Poll interval while waiting (ms). */
  pollMs?: number;
  /**
   * Terminate a LIVE same-machine holder and reclaim, instead of waiting then
   * failing. For the dev hot-reload flow: `node --watch` starts the new process
   * while the previous one still holds the lock (and may never exit on its own),
   * so waiting just stalls → error on every file save. Default: auto-on under
   * `--watch` or `OPENSHIP_DEV_LOCK_TAKEOVER=true`, off everywhere else (a
   * desktop/CLI must NEVER kill a legitimate second instance — it waits + errors).
   */
  takeover?: boolean;
}

function readLock(lockPath: string): LockRecord | "unreadable" {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
    if (
      typeof parsed.pid === "number" &&
      Number.isFinite(parsed.pid) &&
      typeof parsed.host === "string"
    ) {
      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
        host: parsed.host,
        machineId: typeof parsed.machineId === "string" ? parsed.machineId : undefined,
      };
    }
    return "unreadable";
  } catch {
    return "unreadable";
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe; sends nothing
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = exists but not ours (alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryRemove(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone, or a racing peer removed it — either way, fine */
  }
}

function claim(lockPath: string): void {
  // O_EXCL: create-or-fail atomically. The kernel guarantees exactly one caller
  // wins even under a concurrent race — this is the exclusion primitive.
  const fd = openSync(lockPath, "wx");
  try {
    const record: LockRecord = {
      pid: process.pid,
      startedAt: Date.now(),
      host: hostname(),
      machineId: machineId(),
    };
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
  heldLockPath = lockPath;
  registerExitHook();
}

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  // Best-effort synchronous release on normal exit / process.exit(). Crash and
  // SIGKILL can't run this — those are covered by stale-pid reclamation on the
  // next boot.
  process.once("exit", () => releasePgliteLock());
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Acquire exclusive access to `dataDir`, waiting up to `waitMs` for a live
 * holder to release. Throws with an actionable message if a live instance
 * still holds it after the wait, or if the lock belongs to another host.
 */
export async function acquirePgliteLock(
  dataDir: string,
  { waitMs = 5000, pollMs = 100, takeover }: AcquireLockOptions = {},
): Promise<void> {
  const lockPath = lockPathFor(dataDir);
  const deadline = Date.now() + Math.max(0, waitMs);
  // Dev hot-reload takes over a lingering predecessor; production/desktop never
  // does (no `--watch`, flag unset) → they keep the safe wait-then-error path.
  const canTakeover =
    takeover ??
    (process.execArgv.includes("--watch") || process.env.OPENSHIP_DEV_LOCK_TAKEOVER === "true");
  let warnedWaiting = false;
  let takeoverAttempted = false;

  for (;;) {
    try {
      claim(lockPath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // A lock file exists — classify it: stale (reclaim) or live (wait/fail).
    const holder = readLock(lockPath);

    if (holder === "unreadable") {
      tryRemove(lockPath);
      continue;
    }

    // Only a lock from a genuinely DIFFERENT machine is unrecoverable (we can't
    // probe a remote pid). A pre-fix lock has no machineId — assume this machine
    // and let the pid-liveness check below decide, rather than trusting the
    // volatile hostname that caused the false "different host" bug.
    if (holder.machineId != null && holder.machineId !== machineId()) {
      throw new Error(
        `The Openship database at ${dataDir} is locked by a process on a different machine ` +
          `(${holder.host}, pid ${holder.pid}). PGlite data directories cannot be shared ` +
          `across machines. If that machine no longer uses it, remove the lock file: ${lockPath}`,
      );
    }

    if (!isProcessAlive(holder.pid)) {
      // Previous holder crashed without releasing — safe to reclaim.
      tryRemove(lockPath);
      continue;
    }

    // A LIVE same-machine holder. Under dev `--watch`, `node` starts the new
    // process while the previous one still holds the lock and often never exits
    // on its own — so waiting only stalls then fails on every save. Take over:
    // terminate the stale holder (SIGTERM → brief grace → SIGKILL) and reclaim.
    // Done ONCE; if it can't be killed (e.g. pid not ours) we fall through to
    // the wait/error path. NOTE: pid-based — a reused pid is a theoretical risk,
    // acceptably bounded to the dev `--watch` flow this is gated to.
    if (canTakeover && !takeoverAttempted) {
      takeoverAttempted = true;
      console.warn(
        `[db] lock held by pid ${holder.pid}; taking over (dev --watch reload) — ` +
          `terminating the stale holder.`,
      );
      try {
        process.kill(holder.pid, "SIGTERM");
      } catch {
        /* already gone / not ours — the loop below re-evaluates */
      }
      const graceUntil = Date.now() + 3000;
      while (isProcessAlive(holder.pid) && Date.now() < graceUntil) await sleep(150);
      if (isProcessAlive(holder.pid)) {
        try {
          process.kill(holder.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        const hardUntil = Date.now() + 1500;
        while (isProcessAlive(holder.pid) && Date.now() < hardUntil) await sleep(100);
      }
      // Re-loop: a clean SIGTERM exit already removed the lock (its exit hook),
      // and a SIGKILL leaves a dead-pid lock the next iteration reclaims.
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Another Openship instance is already using the database at ${dataDir} ` +
          `(pid ${holder.pid}). PGlite allows only one process per data directory; opening a ` +
          `second would corrupt it. Stop the other instance (e.g. quit the desktop app) and ` +
          `retry. If you are certain no Openship process is running, remove: ${lockPath}`,
      );
    }

    // A live holder that's likely a restarting predecessor — surface ONE line so
    // the wait during a hot-reload handoff doesn't look like a hang.
    if (!warnedWaiting) {
      warnedWaiting = true;
      console.log(
        `[db] database at ${dataDir} is held by pid ${holder.pid} — waiting for it to ` +
          `release (restart/hot-reload handoff)...`,
      );
    }

    await sleep(pollMs);
  }
}

/**
 * Release the lock held by this process. No-op if we hold nothing, and refuses
 * to delete a lock that another process has taken over (owner check).
 */
export function releasePgliteLock(): void {
  if (!heldLockPath) return;
  const lockPath = heldLockPath;
  heldLockPath = null;
  const holder = readLock(lockPath);
  // We own it iff our pid wrote it on this machine. pid is the real check; the
  // machineId guard just avoids clobbering a taken-over lock (legacy locks
  // without machineId still pass on a pid match, matching prior behavior).
  if (
    holder !== "unreadable" &&
    holder.pid === process.pid &&
    (holder.machineId == null || holder.machineId === machineId())
  ) {
    tryRemove(lockPath);
  }
}
