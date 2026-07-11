import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm as fsRm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";

import { getTarCreateArgs, getTarCreateEnv } from "../archive";
import type {
  CommandExecutor,
  LogEntry,
  ShellOptions,
  ShellSession,
  SshConfig,
} from "../types";
import { logEntry, sq } from "./local-shell";
import {
  canUseRemoteRsync,
  transferRemoteDirectoryWithRsync,
  transferRemoteDirectoryWithTar,
} from "./remote-transfer";
import type { Client as SshClient, SFTPWrapper } from "ssh2";
import type { Readable, Duplex } from "node:stream";
import { connectSshClient, openSftp, openSshUnixSocket, type StreamLocalCapableClient } from "./ssh-client";
import { SshDisconnectedError } from "./errors";
import { TRANSFER_EXCLUDES, formatBytes, safeErrorMessage } from "@repo/core";

/** Clamp a window dimension to a sane range to avoid garbage values
 *  reaching ssh2.Client.shell() / channel.setWindow(). */
function clampWindow(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Runs commands on a remote server via SSH.
 * File operations use SFTP.
 */
export class SshExecutor implements CommandExecutor {
  private client: SshClient | null = null;
  private connecting: Promise<SshClient> | null = null;
  private readonly config: SshConfig;
  /** Subscribers notified when the transport drops (see onDisconnect). */
  private readonly disconnectListeners = new Set<(err: Error) => void>();
  /** In-flight cancelable ops — each entry aborts ONE exec/stream on a drop,
   *  so a dead channel fails fast instead of hanging to its command timeout. */
  private readonly inflight = new Set<(err: Error) => void>();
  /** Reverse-forward handlers keyed by the remote bound port (see reverseForward). */
  private readonly reverseHandlers = new Map<number, (stream: Duplex) => void>();
  /** The client the single 'tcp connection' dispatcher is attached to (re-attached on reconnect). */
  private reverseListenerClient: SshClient | null = null;

  constructor(config: SshConfig) {
    if (!config.privateKey && !config.sshAgent && !config.password) {
      throw new Error("SSH requires one of privateKey, sshAgent, or password.");
    }
    this.config = config;
  }

  private async connect(): Promise<SshClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = await connectSshClient(this.config);

      const onTransportDown = (cause?: Error) => {
        if (this.client !== client) return; // superseded / already handled
        this.client = null;
        this.handleDisconnect(cause);
      };

      client.on("close", () => onTransportDown());
      client.on("end", () => onTransportDown());
      client.on("error", (err: Error) => onTransportDown(err));

      this.client = client;
      this.connecting = null;
      return client;
    })();

    return this.connecting;
  }

  /**
   * Subscribe to transport-level disconnects. Returns an unsubscribe fn.
   */
  onDisconnect(cb: (err: Error) => void): () => void {
    this.disconnectListeners.add(cb);
    return () => {
      this.disconnectListeners.delete(cb);
    };
  }

  /**
   * The transport died. Reject every in-flight exec/stream with a typed
   * SshDisconnectedError — so they fail in <1s instead of hanging to their
   * per-command timeout on a dead channel — then notify subscribers so the
   * manager can reconnect / re-drive journaled ops.
   */
  private handleDisconnect(cause?: Error): void {
    const err = new SshDisconnectedError(
      cause?.message ? `SSH connection lost: ${cause.message}` : "SSH connection lost",
    );
    const aborts = [...this.inflight];
    this.inflight.clear();
    for (const abort of aborts) {
      try { abort(err); } catch { /* per-op settle guard handles double-settle */ }
    }
    for (const cb of [...this.disconnectListeners]) {
      try { cb(err); } catch { /* a listener bug must not break disconnect handling */ }
    }
  }

  private async sftp(): Promise<SFTPWrapper> {
    const client = await this.connect();
    return openSftp(client);
  }

  /**
   * Force-close the current connection so the next call reconnects.
   */
  private resetConnection(): void {
    if (this.client) {
      try { this.client.end(); } catch {}
      this.client = null;
    }
    this.connecting = null;
  }

  /** Returns true if the error is an SSH channel-open failure. */
  private static isChannelError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes("channel open failure") || msg.includes("open failed");
  }

  /**
   * Run an operation, and if it fails opening an SSH channel on a half-dead
   * cached connection ("Channel open failure: open failed" — common after the
   * idle timeout drops the socket), drop the connection and retry ONCE on a
   * fresh one. This is why `exec` survives a stale connection; the SFTP-based
   * ops (writeFile/readFile/exists) must go through it too, or a deploy's route
   * write fails spuriously and only succeeds on a manual redeploy.
   */
  private async withChannelRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (SshExecutor.isChannelError(err)) {
        this.resetConnection();
        return fn();
      }
      throw err;
    }
  }

  async exec(command: string, opts?: { timeout?: number }): Promise<string> {
    return this.withChannelRetry(() => this._exec(command, opts));
  }

  /** Prefix applied to every SSH command - keeps dpkg non-interactive. */
  private static readonly ENV_PREFIX =
    'export DEBIAN_FRONTEND=noninteractive DPKG_FORCE=confnew && ';

  private async _exec(command: string, opts?: { timeout?: number }): Promise<string> {
    const client = await this.connect();
    const timeout = opts?.timeout ?? 30_000;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      // `abort` cancels THIS op on a transport drop; `finish` is the single
      // settle path (guards double-settle, clears the timer, deregisters).
      const abort = (err: Error) => finish(() => reject(err));
      const finish = (act: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.inflight.delete(abort);
        act();
      };
      this.inflight.add(abort);

      timer = setTimeout(
        () => finish(() => reject(new Error(`Command timed out after ${timeout}ms: ${command}`))),
        timeout,
      );

      client.exec(SshExecutor.ENV_PREFIX + command, (err, stream) => {
        if (err) return finish(() => reject(err));

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on("close", (code: number) => {
          finish(() => {
            if (code !== 0) reject(new Error(stderr.trim() || `Exit code ${code}`));
            else resolve(stdout.trim());
          });
        });
      });
    });
  }

  streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
  ): Promise<{ code: number; output: string }> {
    return this._streamExec(command, onLog).catch((err) => {
      if (SshExecutor.isChannelError(err)) {
        this.resetConnection();
        return this._streamExec(command, onLog);
      }
      throw err;
    });
  }

  private async _streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
  ): Promise<{ code: number; output: string }> {
    const client = await this.connect();

    return new Promise<{ code: number; output: string }>((resolve, reject) => {
      let settled = false;

      // A transport drop mid-stream rejects with SshDisconnectedError instead
      // of silently resolving `code ?? 1` (truncated output). Callers treat the
      // throw as a real failure; the manager can reconnect/re-drive.
      const abort = (err: Error) => finish(() => reject(err));
      const finish = (act: () => void) => {
        if (settled) return;
        settled = true;
        this.inflight.delete(abort);
        act();
      };
      this.inflight.add(abort);

      client.exec(SshExecutor.ENV_PREFIX + command, (err, stream) => {
        if (err) return finish(() => reject(err));

        // Raw passthrough (see LocalExecutor.streamExec): forward the untouched
        // byte stream as rawData so the client's xterm renders "\r"/ANSI
        // natively — progress lines repaint in place instead of new lines.
        const chunks: string[] = [];

        const onChunk = (data: Buffer, level: LogEntry["level"]) => {
          const text = data.toString();
          if (!text) return;
          chunks.push(text);
          onLog(logEntry(text, level, data.toString("base64")));
        };

        stream.on("data", (data: Buffer) => onChunk(data, "info"));
        stream.stderr.on("data", (data: Buffer) => onChunk(data, "warn"));

        stream.on("close", (code: number) => {
          finish(() => resolve({ code: code ?? 1, output: chunks.join("") }));
        });
      });
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    const dir = dirname(path);
    try {
      await this.exec(`mkdir -p ${sq(dir)}`);
    } catch {
      // Best effort
    }

    return this.withChannelRetry(async () => {
      const sftp = await this.sftp();
      return new Promise<void>((resolve, reject) => {
        sftp.writeFile(path, content, { encoding: "utf-8" }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  async readFile(path: string): Promise<string> {
    return this.withChannelRetry(async () => {
      const sftp = await this.sftp();
      return new Promise<string>((resolve, reject) => {
        sftp.readFile(path, { encoding: "utf-8" }, (err, data) => {
          if (err) reject(err);
          else resolve(data.toString());
        });
      });
    });
  }

  async exists(path: string): Promise<boolean> {
    return this.withChannelRetry(async () => {
      const sftp = await this.sftp();
      return new Promise<boolean>((resolve) => {
        sftp.stat(path, (err) => {
          resolve(!err);
        });
      });
    });
  }

  async mkdir(path: string): Promise<void> {
    await this.exec(`mkdir -p ${sq(path)}`);
  }

  async rm(path: string): Promise<void> {
    try {
      await this.exec(`rm -rf ${sq(path)}`);
    } catch {
      // Already gone
    }
  }

  rawExec(command: string): Promise<{
    stdout: Readable;
    stderr: Readable;
    onClose: Promise<number>;
    kill: () => void;
  }> {
    return (async () => {
      const client = await this.connect();
      return new Promise((resolve, reject) => {
        client.exec(command, (err, stream) => {
          if (err) return reject(err);
          const onClose = new Promise<number>((res) => {
            stream.on("close", (code: number) => res(code ?? 1));
          });
          resolve({
            stdout: stream,
            stderr: stream.stderr,
            onClose,
            kill: () => { try { stream.close(); } catch {} },
          });
        });
      });
    })();
  }

  /**
   * Open an interactive PTY shell on the remote host. The returned
   * ShellSession wraps an ssh2 ClientChannel: writes go to stdin,
   * stdout/stderr emit on the readable streams, setWindow forwards to
   * channel.setWindow, close ends the channel. Lifetime is bound to the
   * channel - the underlying ssh2.Client stays cached by sshManager, so
   * callers must wrap with `sshManager.retain(serverId)` / `release()`
   * to avoid the 5-minute idle drop on the parent connection.
   */
  async openShell(opts?: ShellOptions): Promise<ShellSession> {
    const client = await this.connect();
    const cols = clampWindow(opts?.cols, 80, 1, 1000);
    const rows = clampWindow(opts?.rows, 24, 1, 500);
    const term = opts?.term || "xterm-256color";

    const channel = await new Promise<import("ssh2").ClientChannel>(
      (resolve, reject) => {
        client.shell(
          { term, cols, rows, width: 0, height: 0, modes: {} },
          (err, ch) => (err ? reject(err) : resolve(ch)),
        );
      },
    );

    const closeListeners: Array<(code: number | null, signal?: string) => void> = [];
    let closed = false;
    const fireClose = (code: number | null, signal?: string) => {
      if (closed) return;
      closed = true;
      for (const cb of closeListeners) {
        try { cb(code, signal); } catch { /* listener bug shouldn't kill cleanup */ }
      }
    };

    // ssh2 emits 'exit' with the remote exit code (or signal), then
    // 'close' once the channel teardown finishes. We fire on whichever
    // arrives first and de-dup via the `closed` flag.
    channel.on("exit", (code: number | null, signal?: string) => {
      fireClose(code, signal);
    });
    channel.on("close", () => fireClose(null));
    channel.on("error", () => fireClose(null));

    return {
      stdin: channel,
      stdout: channel,
      stderr: channel.stderr,
      setWindow: (c: number, r: number) => {
        const sc = clampWindow(c, 80, 1, 1000);
        const sr = clampWindow(r, 24, 1, 500);
        try { channel.setWindow(sr, sc, 0, 0); } catch { /* channel may be closing */ }
      },
      close: (_signal?: string) => {
        try { channel.end(); } catch { /* already ending */ }
        try { channel.close(); } catch { /* already closed */ }
      },
      onClose: (cb) => { closeListeners.push(cb); },
    };
  }

  async forwardUnixSocket(socketPath: string): Promise<Duplex> {
    const client = await this.connect();
    return openSshUnixSocket(client as StreamLocalCapableClient, socketPath);
  }

  async forwardPort(remoteHost: string, remotePort: number): Promise<Duplex> {
    const client = await this.connect();
    return new Promise<Duplex>((resolve, reject) => {
      client.forwardOut(
        "127.0.0.1", 0,
        remoteHost, remotePort,
        (err, stream) => {
          if (err) return reject(err);
          resolve(stream as unknown as Duplex);
        },
      );
    });
  }

  /**
   * Open a reverse tunnel: the remote listens on an ephemeral 127.0.0.1 port
   * and every connection to it is handed to `onConnection` as a duplex stream
   * over this SSH connection. ssh2's 'tcp connection' event is client-wide, so
   * a single dispatcher routes by the bound `destPort` to the right handler.
   */
  async reverseForward(
    onConnection: (stream: Duplex) => void,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const client = await this.connect();
    this.attachReverseListener(client);

    const port = await new Promise<number>((resolve, reject) => {
      client.forwardIn("127.0.0.1", 0, (err, boundPort) => {
        if (err) return reject(err);
        resolve(boundPort);
      });
    });
    this.reverseHandlers.set(port, onConnection);

    return {
      port,
      close: async () => {
        this.reverseHandlers.delete(port);
        await new Promise<void>((resolve) => {
          try {
            client.unforwardIn("127.0.0.1", port, () => resolve());
          } catch {
            resolve();
          }
        });
      },
    };
  }

  /** Attach the single client-wide 'tcp connection' dispatcher (idempotent per client). */
  private attachReverseListener(client: SshClient): void {
    if (this.reverseListenerClient === client) return;
    this.reverseListenerClient = client;
    client.on("tcp connection", (details, accept, reject) => {
      const handler = this.reverseHandlers.get(details.destPort);
      if (!handler) {
        // No relay registered on this port — refuse rather than leak a channel.
        try { reject(); } catch { /* already gone */ }
        return;
      }
      const channel = accept();
      handler(channel as unknown as Duplex);
    });
  }

  async dispose(): Promise<void> {
    this.connecting = null;
    this.reverseHandlers.clear();
    this.reverseListenerClient = null;
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  private async pipeLocal(
    localCmd: string,
    remoteCmd: string,
    onLog?: (log: LogEntry) => void,
    onBytes?: (bytes: number) => void,
  ): Promise<{ code: number }> {
    const client = await this.connect();

    return new Promise((resolve, reject) => {
      // Surface the local command so a hang at "0 B sent" tells the
      // operator exactly what to run by hand to reproduce.
      onLog?.(logEntry(`local: ${localCmd}`));

      client.exec(remoteCmd, (err, channel) => {
        if (err) return reject(err);

        const local = spawn("sh", ["-c", localCmd], {
          stdio: ["ignore", "pipe", "pipe"],
          env: getTarCreateEnv(),
        });

        let localExited = false;
        let localExitCode: number | null = null;
        let localStderrBuffer = "";
        // Single settle guard so EVERY exit path (clean close, forced close, a
        // stalled/truncated remote, local spawn error) resolves or rejects the
        // promise exactly once. A truncated transfer must FAIL the deploy — not
        // hang the heartbeat forever (ssh2 has been seen to swallow the channel
        // 'close' event on a stuck/truncated remote).
        let settled = false;
        const finish = (act: () => void) => {
          if (settled) return;
          settled = true;
          act();
        };

        if (onBytes) {
          // Backpressure-preserving Transform between local.stdout and the
          // SSH channel - counts every chunk passing through without
          // breaking node's pipe flow control. The pipe still closes the
          // channel on local.stdout end.
          const counter = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              onBytes(chunk.length);
              cb(null, chunk);
            },
          });
          local.stdout.pipe(counter).pipe(channel);
        } else {
          local.stdout.pipe(channel);
        }

        local.stderr.on("data", (data: Buffer) => {
          const text = data.toString();
          localStderrBuffer += text;
          const trimmed = text.trim();
          if (trimmed && onLog) onLog(logEntry(`local stderr: ${trimmed}`, "warn"));
        });

        channel.stderr.on("data", (data: Buffer) => {
          const text = data.toString().trim();
          if (text && onLog) onLog(logEntry(`remote stderr: ${text}`, "warn"));
        });

        // Local process exit - distinct from the SSH channel close. If
        // local exits non-zero we MUST surface that, otherwise the channel
        // keeps the heartbeat ticking and the operator sees "0 B sent"
        // forever with no clue why.
        local.on("exit", (code, signal) => {
          localExited = true;
          localExitCode = code;
          if (onLog) {
            const detail = signal
              ? `signal=${signal}`
              : `code=${code ?? "null"}`;
            onLog(
              logEntry(
                `local process exited (${detail})${localStderrBuffer ? ` · stderr=${localStderrBuffer.trim()}` : ""}`,
                code === 0 ? "info" : "error",
              ),
            );
          }
          if (code !== 0) {
            // Force-close the channel so the outer promise resolves and
            // the caller can surface the real failure instead of hanging.
            try {
              channel.end();
              channel.close();
            } catch {
              /* channel may already be gone */
            }
            // Settle even if ssh2 never surfaces the channel 'close'.
            const failTimer = setTimeout(
              () =>
                finish(() =>
                  reject(
                    new Error(
                      `Local pipe command failed (exit ${code})${localStderrBuffer ? ": " + localStderrBuffer.trim() : ""}`,
                    ),
                  ),
                ),
              10_000,
            );
            (failTimer as { unref?: () => void }).unref?.();
            return;
          }
          // Clean local exit. Two-step shutdown:
          //
          //   1. Send EOF politely via channel.end() so the remote tar
          //      sees end-of-stdin and finishes extracting. We wait one
          //      tick first so any data still in the Transform's
          //      internal buffer can drain to the channel.
          //
          //   2. Arm a watchdog. If the channel still hasn't closed
          //      after `REMOTE_DRAIN_GRACE_MS`, the remote side is
          //      stuck (slow disk, hung tar, network anomaly, ssh2 EOF
          //      not propagating - we've seen all four). At that point
          //      all bytes are already on the wire so it's safe to
          //      force-close. Without this, the channel hangs at "82%"
          //      indefinitely until the 15-min idle timeout fires.
          //
          // The watchdog is cancelled if channel.on('close') fires
          // naturally, which it does on healthy networks within ~1s.
          setImmediate(() => {
            try {
              channel.end();
            } catch {
              /* channel may already be ending */
            }
          });
          const REMOTE_DRAIN_GRACE_MS = 30_000;
          const watchdog = setTimeout(() => {
            if (onLog) {
              onLog(
                logEntry(
                  `Local pipe finished but SSH channel didn't close after ${
                    REMOTE_DRAIN_GRACE_MS / 1000
                  }s - forcing close (remote tar may be stuck or ssh2 EOF didn't propagate).`,
                  "warn",
                ),
              );
            }
            try {
              channel.close();
            } catch {
              /* channel may already be closed */
            }
            // If ssh2 STILL swallows the 'close' after the forced close (seen
            // on a truncated/stuck remote), settle ourselves so the deploy
            // fails fast instead of hanging indefinitely.
            const stallTimer = setTimeout(
              () =>
                finish(() =>
                  reject(
                    new Error(
                      "File transfer stalled: the remote did not finish extracting within the grace period (the archive may have been truncated mid-stream).",
                    ),
                  ),
                ),
              5_000,
            );
            (stallTimer as { unref?: () => void }).unref?.();
          }, REMOTE_DRAIN_GRACE_MS);
          (watchdog as { unref?: () => void }).unref?.();
          channel.once("close", () => clearTimeout(watchdog));
        });

        channel.on("close", (code: number) => {
          finish(() => {
            // If the channel closes "cleanly" (code 0) but the local
            // process actually failed, surface the local failure instead.
            if (localExited && localExitCode !== null && localExitCode !== 0) {
              reject(
                new Error(
                  `Local pipe command failed (exit ${localExitCode})${localStderrBuffer ? ": " + localStderrBuffer.trim() : ""}`,
                ),
              );
              return;
            }
            resolve({ code: code ?? 1 });
          });
        });

        local.on("error", (e) => {
          finish(() => reject(new Error(`Local process failed to start: ${e.message}`)));
        });
      });
    });
  }

  private async hasRemoteCommand(command: string): Promise<boolean> {
    try {
      await this.exec(`command -v ${command} >/dev/null 2>&1 && echo ok`, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async transferIn(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    options?: { excludes?: string[]; includes?: string[]; mode?: "auto" | "tar" },
  ): Promise<void> {
    const deps = {
      config: this.config,
      hasRemoteCommand: (command: string) => this.hasRemoteCommand(command),
      ensureRemoteDir: (path: string) => this.exec(`mkdir -p ${sq(path)}`).then(() => undefined),
      pipeLocal: (
        localCmd: string,
        remoteCmd: string,
        logCb?: (log: LogEntry) => void,
        onBytes?: (bytes: number) => void,
      ) => this.pipeLocal(localCmd, remoteCmd, logCb, onBytes),
    };

    // Fast ssh2 path (see transferInViaSftp): pack once, upload the single
    // archive via SFTP fastPut (concurrent). Falls back to the streaming tar
    // pipe over the exec channel only if SFTP itself fails.
    const sftpThenPipe = async () => {
      try {
        await this.transferInViaSftp(localPath, remotePath, onLog, options);
      } catch (err) {
        onLog?.(
          logEntry(
            `SFTP upload failed (${safeErrorMessage(err)}); falling back to the tar stream over the existing connection.`,
            "warn",
          ),
        );
        await transferRemoteDirectoryWithTar(localPath, remotePath, deps, onLog, options);
      }
    };

    // Explicit "tar" mode = "don't use the system-ssh rsync path". Honor that,
    // but still prefer the fast SFTP upload over the slow exec-channel stream.
    if (options?.mode === "tar") {
      await sftpThenPipe();
      return;
    }

    const rsync = await canUseRemoteRsync(deps);
    if (rsync.ok) {
      try {
        await transferRemoteDirectoryWithRsync(localPath, remotePath, deps, onLog, options);
        return;
      } catch (err) {
        // rsync uses a SEPARATE /usr/bin/ssh subprocess with its own auth path
        // - when the VPS's pubkey/password state desyncs (perms changed,
        // fail2ban ban, authorized_keys edited), rsync fails even though
        // openship's own ssh2 connection still works. Fall back to the SFTP
        // upload, which RIDES the existing ssh2 connection (same auth) and is
        // far faster than the exec-channel tar stream.
        const message = safeErrorMessage(err);
        onLog?.(
          logEntry(
            `rsync transfer failed (${message}); falling back to a single-archive SFTP upload.`,
            "warn",
          ),
        );
      }
    } else {
      // rsync needs sshpass for password servers (absent on e.g. macOS desktop);
      // the SFTP upload has no such dependency and still gets concurrency.
      onLog?.(logEntry(`rsync unavailable (${rsync.reason}); using a single-archive SFTP upload.`, "warn"));
    }

    await sftpThenPipe();
  }

  /**
   * Fast ssh2 transfer: pack the source into ONE gzipped archive locally, upload
   * it with SFTP `fastPut` (concurrent chunks fill the bandwidth-delay product —
   * far faster than the single exec-channel tar stream on a latency-bound link),
   * then extract on the remote. Works over password auth with no `sshpass`, and
   * completes cleanly (no swallowed channel-close hang). Throws on failure so the
   * caller can fall back to the exec-channel tar stream.
   */
  private async transferInViaSftp(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    options?: { excludes?: string[]; includes?: string[] },
  ): Promise<void> {
    const excludes = options?.excludes ?? [...TRANSFER_EXCLUDES];
    const tarArgs = getTarCreateArgs(localPath, { excludes, includes: options?.includes });

    const tmpLocalDir = await mkdtemp(join(tmpdir(), "openship-xfer-"));
    const localArchive = join(tmpLocalDir, "context.tar.gz");
    // Sibling of the destination dir so it lands on the same filesystem.
    const remoteArchive = `${remotePath}.openship-xfer.tar.gz`;

    try {
      onLog?.(logEntry("Packing source into a single archive for a fast SFTP upload..."));
      await this.runLocalTarToFile(tarArgs, localArchive);

      const totalBytes = (await stat(localArchive)).size;
      onLog?.(logEntry(`Uploading ${formatBytes(totalBytes)} archive via SFTP (concurrent)...`));

      await this.exec(`mkdir -p ${sq(dirname(remoteArchive))}`);
      await this.sftpFastPut(localArchive, remoteArchive, totalBytes, onLog);

      await this.exec(
        `mkdir -p ${sq(remotePath)} && tar xzf ${sq(remoteArchive)} -C ${sq(remotePath)} && rm -f ${sq(remoteArchive)}`,
      );
      onLog?.(logEntry(`Transferred ${formatBytes(totalBytes)} via SFTP and extracted on the server.`));
    } finally {
      await fsRm(tmpLocalDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Run `tar` locally, streaming its archive to `outFile`. Resolves when tar
   *  exits 0 AND the file is fully flushed; rejects with tar's stderr otherwise. */
  private runLocalTarToFile(tarArgs: string[], outFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tar = spawn("tar", tarArgs, { stdio: ["ignore", "pipe", "pipe"], env: getTarCreateEnv() });
      const out = createWriteStream(outFile);
      let stderr = "";
      let tarCode: number | null = null;
      let tarClosed = false;
      let outClosed = false;
      const settle = () => {
        if (!tarClosed || !outClosed) return;
        if (tarCode === 0) resolve();
        else reject(new Error(`tar failed (exit ${tarCode})${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`));
      };
      tar.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      tar.on("error", reject);
      out.on("error", reject);
      tar.stdout.pipe(out);
      tar.on("close", (code) => { tarCode = code ?? 1; tarClosed = true; settle(); });
      out.on("finish", () => { outClosed = true; settle(); });
    });
  }

  /** SFTP fastPut with concurrency + a throttled progress heartbeat. */
  private async sftpFastPut(
    localArchive: string,
    remoteArchive: string,
    totalBytes: number,
    onLog?: (log: LogEntry) => void,
  ): Promise<void> {
    const sftp = await this.sftp();
    const startedAt = Date.now();
    let lastReportedAt = startedAt;
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(
        localArchive,
        remoteArchive,
        {
          concurrency: 16,
          chunkSize: 32768,
          step: (transferred: number) => {
            const now = Date.now();
            if (now - lastReportedAt < 2500) return;
            lastReportedAt = now;
            const elapsed = (now - startedAt) / 1000;
            const mbps = elapsed > 0 ? transferred / 1024 / 1024 / elapsed : 0;
            const pct = totalBytes > 0 ? Math.min(Math.floor((transferred / totalBytes) * 100), 100) : 0;
            onLog?.(
              logEntry(`  ~${pct}% · ${formatBytes(transferred)} · ${mbps.toFixed(1)} MB/s · ${elapsed.toFixed(0)}s`),
            );
          },
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }
}