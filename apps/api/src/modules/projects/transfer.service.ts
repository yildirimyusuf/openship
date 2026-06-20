/**
 * Project transfer service — local <-> Openship Cloud mobility.
 *
 * Thin wrapper around dumpSubgraph / restoreSubgraph + the unified
 * cloudClient.{ingestSubgraph,exportSubgraph} primitives. Both directions:
 *
 *   transferProjectToCloud      — dump local project subgraph, push to SaaS,
 *                                 flip cloudWorkspaceId locally.
 *   transferProjectToSelfHosted — pull project subgraph from SaaS, wipe
 *                                 the local (shadow) rows, restore, clear
 *                                 cloudWorkspaceId.
 *
 * SCOPE OF THIS FILE: data-layer transfer only. Container teardown on the
 * source side, mail-server reattachment, GitHub installation re-binding,
 * DNS / domain re-provisioning, and racing concurrent deploys are
 * INTENTIONALLY deferred for the business-logic discussion. The hooks for
 * those live as TODOs below.
 */

import {
  dumpSubgraph,
  restoreSubgraph,
  PkCollisionError,
  db,
  schema,
  eq,
  inArray,
  type DatabaseDump,
  type SubgraphScope,
} from "@repo/db";
import { cloudClient } from "../../lib/cloud-client";

// ─── Typed errors ────────────────────────────────────────────────────────────

export class TransferAlreadyOnTargetError extends Error {
  readonly code = "TRANSFER_ALREADY_ON_TARGET" as const;
  constructor(public readonly side: "cloud" | "self_hosted") {
    super(`Project is already hosted on ${side}.`);
    this.name = "TransferAlreadyOnTargetError";
  }
}

export class TransferConflictError extends Error {
  readonly code = "TRANSFER_CONFLICT" as const;
  constructor(
    public readonly conflictKind: "id" | "slug",
    public readonly conflictValue: string,
  ) {
    super(
      `Target organization already has a project with this ${conflictKind}: ${conflictValue}.`,
    );
    this.name = "TransferConflictError";
  }
}

export class TransferNotConnectedError extends Error {
  readonly code = "TRANSFER_NOT_CONNECTED" as const;
  constructor() {
    super("This organization is not connected to Openship Cloud.");
    this.name = "TransferNotConnectedError";
  }
}

export class TransferCloudCallFailedError extends Error {
  readonly code = "TRANSFER_CLOUD_FAILED" as const;
  constructor(reason: string) {
    super(`Cloud transfer call failed: ${reason}`);
    this.name = "TransferCloudCallFailedError";
  }
}

export class TransferProjectNotFoundError extends Error {
  readonly code = "TRANSFER_PROJECT_NOT_FOUND" as const;
  constructor(projectId: string) {
    super(`Project ${projectId} not found.`);
    this.name = "TransferProjectNotFoundError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  slug: string;
  organizationId: string;
  cloudWorkspaceId: string | null;
}

async function loadProject(
  projectId: string,
  organizationId: string,
): Promise<ProjectRow | null> {
  const rows = await db
    .select({
      id: schema.project.id,
      slug: schema.project.slug,
      organizationId: schema.project.organizationId,
      cloudWorkspaceId: schema.project.cloudWorkspaceId,
    })
    .from(schema.project)
    .where(eq(schema.project.id, projectId));
  const row = rows[0];
  if (!row) return null;
  if (row.organizationId !== organizationId) return null;
  return row;
}

// ─── Forward: local → cloud ──────────────────────────────────────────────────

export interface TransferToCloudInput {
  projectId: string;
  /** Caller's local org (becomes the SaaS org via cloud session). */
  organizationId: string;
}

export interface TransferToCloudResult {
  projectId: string;
  cloudWorkspaceId: string;
  imported: Record<string, number>;
}

export async function transferProjectToCloud(
  input: TransferToCloudInput,
): Promise<TransferToCloudResult> {
  // 1) Pre-flight: project exists in this org and isn't already on cloud.
  const project = await loadProject(input.projectId, input.organizationId);
  if (!project) throw new TransferProjectNotFoundError(input.projectId);
  if (project.cloudWorkspaceId) {
    throw new TransferAlreadyOnTargetError("cloud");
  }

  // 2) Dump the project subgraph from local. stripEncrypted: true — the
  //    SaaS can't decrypt local-host blobs; re-link is the operator's
  //    job on the cloud side.
  const dump = await dumpSubgraph(
    { kind: "project", projectId: input.projectId },
    { stripEncrypted: true },
  );

  // 3) Push to cloud. The SaaS derives merge mode from dump.scope and
  //    rewrites every organizationId onto the caller's SaaS org.
  const result = await cloudClient({
    organizationId: input.organizationId,
  }).ingestSubgraph({ dump });
  if (!result.ok) {
    // No cloud session linked for this org.
    if (/not connected/i.test(result.error)) {
      throw new TransferNotConnectedError();
    }
    if (result.code === "INGEST_VALIDATION_FAILED") {
      throw new TransferCloudCallFailedError(result.error);
    }
    // PK collision on the SaaS-side restoreSubgraph surfaces as code
    // "PK_COLLISION" (from PkCollisionError in @repo/db, mapped to 409
    // by the cloud-ingest controller). The legacy string-match check
    // is kept as a fallback for older SaaS instances that pre-date
    // typed collision errors.
    if (result.code === "PK_COLLISION" || /duplicate key value/i.test(result.error)) {
      throw new TransferConflictError("id", project.id);
    }
    throw new TransferCloudCallFailedError(result.error);
  }

  // 4) Mark the local project as cloud-hosted. The SaaS reuses the same
  //    project.id (only organizationId is remapped), so cloudWorkspaceId
  //    is the project id itself for now — a future API iteration could
  //    return a distinct cloud workspace id.
  const cloudWorkspaceId = project.id;
  await db
    .update(schema.project)
    .set({ cloudWorkspaceId, updatedAt: new Date() })
    .where(eq(schema.project.id, project.id));

  // TODO (business-logic phase, NOT in this change):
  //   - tear down containers/services on the source machine
  //   - hand DNS records over (if any custom domains)
  //   - re-bind the GitHub installation to the cloud org
  //   - issue an audit_event row referencing both ends
  //   - guard against a concurrent deploy in flight at dump-time

  return {
    projectId: project.id,
    cloudWorkspaceId,
    imported: result.imported,
  };
}

// ─── Reverse: cloud → local ──────────────────────────────────────────────────

export interface TransferToSelfHostedInput {
  projectId: string;
  organizationId: string;
}

export interface TransferToSelfHostedResult {
  projectId: string;
  imported: Record<string, number>;
}

export async function transferProjectToSelfHosted(
  input: TransferToSelfHostedInput,
): Promise<TransferToSelfHostedResult> {
  // 1) Pre-flight: project exists in this org and IS currently on cloud.
  const project = await loadProject(input.projectId, input.organizationId);
  if (!project) throw new TransferProjectNotFoundError(input.projectId);
  if (!project.cloudWorkspaceId) {
    throw new TransferAlreadyOnTargetError("self_hosted");
  }

  // 2) Pull the project subgraph from the SaaS.
  const scope: SubgraphScope = { kind: "project", projectId: input.projectId };
  const result = await cloudClient({
    organizationId: input.organizationId,
  }).exportSubgraph({ scope });
  if (!result.ok) {
    if (/not connected/i.test(result.error)) {
      throw new TransferNotConnectedError();
    }
    throw new TransferCloudCallFailedError(result.error);
  }
  const dump: DatabaseDump = result.dump;

  // 3) Wipe the local rows for this project, then merge-insert the dump.
  //    The primitive's "merge = no truncate" rule is intact: the wipe is
  //    scoped to *this project* and lives inside this service.
  await db.transaction(async (tx) => {
    // Resolve deployment ids first so we can purge service_deployment rows.
    const deploymentRows = await tx
      .select({ id: schema.deployment.id })
      .from(schema.deployment)
      .where(eq(schema.deployment.projectId, project.id));
    const deploymentIds = deploymentRows.map((r) => r.id);

    if (deploymentIds.length > 0) {
      await tx
        .delete(schema.serviceDeployment)
        .where(inArray(schema.serviceDeployment.deploymentId, deploymentIds));
    }

    // Reverse FK dependency order — children before parents.
    await tx.delete(schema.service).where(eq(schema.service.projectId, project.id));
    await tx.delete(schema.domain).where(eq(schema.domain.projectId, project.id));
    await tx.delete(schema.envVar).where(eq(schema.envVar.projectId, project.id));
    await tx
      .delete(schema.backupPolicy)
      .where(eq(schema.backupPolicy.projectId, project.id));
    await tx
      .delete(schema.deployment)
      .where(eq(schema.deployment.projectId, project.id));
    await tx.delete(schema.project).where(eq(schema.project.id, project.id));
  });

  try {
    await restoreSubgraph(dump, {
      mode: "merge",
      remapOrgId: input.organizationId,
    });
  } catch (err) {
    // PkCollisionError = caller already pulled this project back at some
    // point and didn't clean up local shadow rows fully. We map it to
    // TransferConflictError so the dashboard surfaces a recoverable
    // "already exists locally" rather than an opaque 500.
    if (err instanceof PkCollisionError) {
      throw new TransferConflictError("id", project.id);
    }
    throw err;
  }

  // 4) Clear cloudWorkspaceId; project is now canonical-local again.
  await db
    .update(schema.project)
    .set({ cloudWorkspaceId: null, updatedAt: new Date() })
    .where(eq(schema.project.id, project.id));

  // TODO (business-logic phase, NOT in this change):
  //   - schedule the cloud-side teardown (delete cloud workspace)
  //   - kick the local deploy pipeline so containers come back up
  //   - re-bind GitHub installation to the local org
  //   - audit_event row

  const imported = Object.fromEntries(
    Object.entries(dump.tables)
      .filter(([, rows]) => rows.length > 0)
      .map(([k, v]) => [k, v.length]),
  );

  return { projectId: project.id, imported };
}
