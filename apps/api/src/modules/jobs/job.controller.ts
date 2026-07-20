/**
 * Job controller — Hono handlers for the self-hosted Jobs tab.
 *
 * Permission + auth are injected by secureRouter via the route tags; these stay
 * thin. Mounted under /api/jobs behind `localOnly` (self-hosted only).
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { param, isServerInOrg } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { streamRunSSE } from "../../lib/run-sse";
import * as jobService from "./job.service";
import { jobRunBus } from "./job-run.sse";
import { resolveServerIds } from "./job.types";
import { JOB_TRIGGER_EVENTS } from "./job-events";
import type { TUpdateJobBody, TCreateJobBody } from "./job.schema";

/**
 * Authorize every target server a command job would run on. Jobs are instance-
 * global (no organizationId), and the `job:write` tag only checks org
 * membership — so WITHOUT this a member could create/run a command job pointed
 * at ANY server id (including another org's) and get root RCE on it. Gate each
 * target the same way the terminal / migration paths do: server-admin + the
 * server must resolve inside the caller's org.
 */
async function assertJobServersWritable(c: Context, serverIds: string[]): Promise<Response | null> {
  const ctx = getRequestContext(c);
  for (const serverId of new Set(serverIds)) {
    await permission.assert(ctx, { resourceType: "server", resourceId: serverId, action: "admin" });
    if (!(await isServerInOrg(ctx, serverId))) {
      return c.json({ error: "Server not found" }, 404);
    }
  }
  return null;
}

export async function list(c: Context) {
  const jobs = await jobService.listJobs();
  return c.json({ data: jobs });
}

/** GET /jobs/:key — one job with next run + recent run history (detail page). */
export async function get(c: Context) {
  const job = await jobService.getJob(param(c, "key"));
  return c.json({ data: job });
}

/** GET /jobs/:key/runs — a job's run history. */
export async function listRuns(c: Context) {
  const limit = Number(c.req.query("limit") ?? 50);
  const runs = await repos.jobRun.listRecent({ jobId: param(c, "key"), limit });
  return c.json({ data: runs });
}

/** GET /jobs/trigger-events — curated list of triggerable events (for the UI). */
export async function triggerEvents(c: Context) {
  return c.json({ data: JOB_TRIGGER_EVENTS });
}

/** GET /jobs/backup-schedules — read-only view of the org's scheduled backup
 *  policies, surfaced alongside jobs. Managed under each project's Backups. */
export async function backupSchedules(c: Context) {
  const ctx = getRequestContext(c);
  const data = await jobService.listBackupSchedules(ctx.organizationId);
  return c.json({ data });
}

export async function create(c: Context) {
  const body = await c.req.json<TCreateJobBody>();
  const ctx = getRequestContext(c);
  const denied = await assertJobServersWritable(c, resolveServerIds(body));
  if (denied) return denied;
  const job = await jobService.createCustomJob({ ...body, createdBy: ctx.userId });
  // Return the redacted JobView (never ship secret ciphertext back to the client).
  return c.json({ data: await jobService.getJob(job.key) }, 201);
}

export async function update(c: Context) {
  const key = param(c, "key");
  const body = await c.req.json<TUpdateJobBody>();
  // If the patch re-points the job at (new) servers, authorize those targets.
  const targets = resolveServerIds(body);
  if (targets.length) {
    const denied = await assertJobServersWritable(c, targets);
    if (denied) return denied;
  }
  const updated = await jobService.updateJob(key, body);
  return c.json({ data: await jobService.getJob(updated.key) });
}

export async function remove(c: Context) {
  await jobService.deleteCustomJob(param(c, "key"));
  return c.json({ success: true });
}

export async function run(c: Context) {
  const key = param(c, "key");
  // Re-authorize the job's stored targets on every manual run: jobs are
  // instance-global, so run-by-key would otherwise let a member trigger a
  // command job pointed at a server outside their org.
  const row = await repos.job.findByKey(key);
  if (!row) return c.json({ error: "Job not found" }, 404);
  const cfg = (row.actionConfig ?? {}) as { serverIds?: string[]; serverId?: string };
  const serverIds = resolveServerIds({ serverId: cfg.serverId, serverIds: cfg.serverIds });
  if (serverIds.length) {
    const denied = await assertJobServersWritable(c, serverIds);
    if (denied) return denied;
  }
  const result = await jobService.runJobNow(key);
  return c.json({ data: result });
}

/** GET /jobs/runs/:runId — one run row incl. stored output (history detail). */
export async function getRun(c: Context) {
  const run = await repos.jobRun.findById(param(c, "runId"));
  if (!run) return c.json({ error: "Run not found" }, 404);
  return c.json({ data: run });
}

/** GET /jobs/runs/:runId/stream — live output + terminal outcome (SSE). */
export async function streamRun(c: Context) {
  const runId = param(c, "runId");
  const run = await repos.jobRun.findById(runId);
  if (!run) return c.json({ error: "Run not found" }, 404);
  const finished = run.status === "success" || run.status === "failed";
  return streamRunSSE(c, {
    bus: jobRunBus,
    id: runId,
    snapshot: { type: "snapshot", run },
    terminalComplete: finished
      ? { type: "complete", status: run.status as "success" | "failed", error: run.error }
      : null,
    isFinalEvent: (e) => e.type === "complete",
  });
}
