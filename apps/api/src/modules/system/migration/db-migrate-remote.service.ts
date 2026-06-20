/**
 * Dump the local DB → transfer to remote → restore.
 *
 * Atomic on the remote (single transaction inside restoreDatabase),
 * but the LOCAL→REMOTE leg is necessarily non-atomic — we generate a
 * dump file, scp it over, then trigger the restore. If the wizard
 * fails mid-stream the operator can re-run; the dump is idempotent
 * and the restore is wipe-then-insert so a partial first run is
 * cleaned up by the second.
 *
 * Why we don't pipe stdin over SSH directly: the dump can be tens of
 * MB, and Drizzle's restore wants the whole envelope in memory at
 * once (it inserts table-by-table). Writing to disk on the remote
 * keeps the API process's memory pressure bounded.
 */

import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpSubgraph } from "@repo/db";
import { sshManager } from "../../../lib/ssh-manager";

export interface DumpRemoteRestoreInput {
  /** The target server's id — we already have an SSH executor for it. */
  serverId: string;
  /**
   * The Openship project slug deployed on the remote. We use this to
   * locate the per-deploy working dir on the target so the restore
   * runs from the right cwd (where node_modules and the bun bin are).
   */
  projectSlug: string;
}

/**
 * End-to-end migrate: dump → scp → restore. Throws on any failure;
 * the local tempfile is always cleaned up.
 */
export async function dumpRemoteRestore(
  input: DumpRemoteRestoreInput,
): Promise<void> {
  // ── 1. Dump the local DB to a temp file.
  //
  // stripEncrypted: every blob encrypted with this host's
  // BETTER_AUTH_SECRET (cloud session token, clone tokens, env var
  // values, backup credentials, notification channel configs) gets
  // nulled out. The remote can't decrypt them with a different key, so
  // carrying them across is worse than leaving them blank — the operator
  // re-links cleanly on the new host. The dump's
  // `strippedEncryptedFields` array surfaces what was stripped so the
  // wizard can tell the operator exactly what to reconnect. ─────────
  const dump = await dumpSubgraph({ kind: "instance" }, { stripEncrypted: true });
  const payload = JSON.stringify(dump);

  const localTmpDir = mkdtempSync(join(tmpdir(), "openship-migrate-"));
  const localTmpPath = join(localTmpDir, "dump.json");
  writeFileSync(localTmpPath, payload, { encoding: "utf-8", mode: 0o600 });

  const remoteDumpPath = `/tmp/openship-migrate-${Date.now()}.json`;

  try {
    await sshManager.withExecutor(input.serverId, async (exec) => {
      // ── 2. Push the dump file over SSH. ──────────────────────────────
      //
      // sshManager's executor exposes a `writeFile(remotePath, content)`
      // wrapper that we already use for state files. For multi-MB
      // payloads this is fine — bun's ssh transport batches efficiently.
      // For tens-of-MB+ dumps we could switch to a streaming approach;
      // this is the simplest correct path.
      await exec.writeFile(remoteDumpPath, payload);

      // Tight perms — dump contains hashed creds, audit log, etc.
      await exec.exec(`chmod 600 ${remoteDumpPath}`);

      // ── 3. Restore on the remote. ────────────────────────────────────
      //
      // The remote Openship install is the operator's freshly-deployed
      // openship app. We invoke its `db:restore` script via bun in the
      // project's working dir. The script reads the JSON file and runs
      // the FK-deferred transactional restore from @repo/db.
      //
      // Path: /var/lib/openship/projects/<slug>/current — matches the
      // deploy pipeline's per-project layout convention.
      //
      // exec() throws on non-zero exit and resolves to stdout on
      // success; CommandExecutor's contract guarantees this so we
      // don't need a separate exit-code check here.
      const remoteProjectDir = `/var/lib/openship/projects/${input.projectSlug}/current`;
      await exec.exec(
        `cd ${remoteProjectDir} && bun --cwd packages/db scripts/restore.ts --in ${remoteDumpPath}`,
      );

      // ── 4. Best-effort cleanup of the dump file on the remote. ──────
      // Not critical — /tmp is wiped on reboot — but keeping the file
      // around indefinitely leaks data at rest.
      await exec.exec(`rm -f ${remoteDumpPath}`);
    });
  } finally {
    // ── 5. Local cleanup, regardless of outcome. ─────────────────────
    try {
      unlinkSync(localTmpPath);
      rmSync(localTmpDir, { recursive: true, force: true });
    } catch {
      // best-effort — /tmp gets cleared on reboot
    }
  }
}
