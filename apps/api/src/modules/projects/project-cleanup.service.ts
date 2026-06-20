/**
 * Project cleanup orchestrator - resource manifest + bounded-concurrency teardown.
 *
 * Reuses the same patterns as deployment-lifecycle.ts:
 *   1. Collect a manifest of all resources (containers, images, artifacts, routes)
 *   2. Execute cleanup with bounded concurrency + per-item error isolation
 *   3. Retry transient failures once with backoff
 *
 * Used by:
 *   - deleteProject()           → full project teardown
 *   - deleteDeployment()        → single deployment teardown
 */

import { repos, type Project, type Deployment } from "@repo/db";
import { DockerRuntime, type RuntimeAdapter } from "@repo/adapters";
import { NotFoundError, safeErrorMessage } from "@repo/core";
import { assertResourceInOrg, platform } from "../../lib/controller-helpers";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { buildServiceRouteDomain } from "../../lib/routing-domains";
import {
  cleanupWebmailInstall,
  mailServerIdFromWebmailSlug,
} from "../mail/webmail/webmail-project.service";

// ─── Resource Manifest ───────────────────────────────────────────────────────

export interface CleanupResource {
  type: "container" | "image" | "artifact" | "route" | "volume" | "network";
  /** Runtime-specific identifier (container ID, image ref, hostname, volume name, network slug). */
  ref: string;
  /** Label for logging */
  label: string;
  /** The runtime to use for destroy/removeImage/removeVolume - null for routes. */
  runtime: RuntimeAdapter | null;
}

export interface CleanupManifest {
  projectId: string;
  resources: CleanupResource[];
}

/** Per-service summary of what will be removed when this service's container is destroyed. */
export interface DeletionPreviewService {
  id: string;
  name: string;
  image: string | null;
  /** Named volumes attached to this service's container (will leak unless wipeVolumes=true). */
  volumes: string[];
  /** True if the container is currently known to the runtime. */
  hasContainer: boolean;
}

export interface DeletionPreview {
  projectId: string;
  projectName: string;
  /** Self-hosted (docker / bare / ssh) or cloud? Cloud teardown is always complete. */
  selfHosted: boolean;
  services: DeletionPreviewService[];
  /** Named volumes attached to the main deployment container, if any. */
  deploymentVolumes: string[];
  /** Project networks that exist on the host. */
  networks: string[];
  /** Total named volumes across services + deployment containers. */
  totalVolumes: number;
}

export interface CollectManifestOptions {
  /** Include named-volume cleanup resources in the manifest. Default false. */
  wipeVolumes?: boolean;
}

export interface CleanupResult {
  total: number;
  succeeded: number;
  failed: { ref: string; label: string; error: string }[];
}

// ─── Manifest Collectors ─────────────────────────────────────────────────────

/**
 * Collect ALL resources owned by a project into a flat manifest.
 * Single pass: queries DB once per resource type, no per-item queries in loops.
 */
export async function collectProjectManifest(
  project: Project,
  options: CollectManifestOptions = {},
): Promise<CleanupManifest> {
  const wipeVolumes = options.wipeVolumes ?? false;
  const resources: CleanupResource[] = [];
  const services = await repos.service.listByProject(project.id).catch(() => []);
  const seenContainers = new Set<string>();
  const seenVolumes = new Set<string>();
  const dockerRuntimes = new Set<DockerRuntime>();

  const pushContainer = (containerId: string, runtime: RuntimeAdapter, labelPrefix: string) => {
    if (seenContainers.has(containerId)) return;
    seenContainers.add(containerId);
    resources.push({
      type: "container",
      ref: containerId,
      label: `${labelPrefix} ${containerId.slice(0, 12)}`,
      runtime,
    });
  };

  /** When wipeVolumes=true, enumerate named volumes attached to this container
   *  and add them as separate cleanup resources. Must run BEFORE the container
   *  is destroyed - once the container is gone, the volume names are lost. */
  const pushVolumesForContainer = async (
    containerId: string,
    runtime: RuntimeAdapter,
    labelPrefix: string,
  ) => {
    if (!wipeVolumes || !(runtime instanceof DockerRuntime)) return;
    const names = await runtime.inspectNamedVolumes(containerId).catch(() => [] as string[]);
    for (const name of names) {
      if (seenVolumes.has(name)) continue;
      seenVolumes.add(name);
      resources.push({
        type: "volume",
        ref: name,
        label: `${labelPrefix} volume ${name}`,
        runtime,
      });
    }
  };

  // ── Deployment containers + images + service containers ────────────
  const { rows: allDeps } = await repos.deployment.listByProject(project.id, { perPage: 1000 });
  const seenImages = new Set<string>();

  for (const dep of allDeps) {
    let runtime: RuntimeAdapter;
    try {
      ({ runtime } = await resolveDeploymentRuntime(dep));
    } catch {
      // Can't resolve runtime (e.g. server deleted) - skip runtime resources
      continue;
    }

    if (runtime instanceof DockerRuntime) {
      dockerRuntimes.add(runtime);
    }

    // Service containers - enumerate volumes BEFORE destroying the container
    // so we still have the mount metadata. Volume names live on the container
    // and disappear with it.
    const serviceRows = await repos.service.listByDeployment(dep.id);
    for (const sd of serviceRows) {
      if (sd.containerId) {
        await pushVolumesForContainer(sd.containerId, runtime, "service");
        pushContainer(sd.containerId, runtime, "service container");
      }
    }

    // Main deployment container - same order.
    if (dep.containerId) {
      await pushVolumesForContainer(dep.containerId, runtime, "deployment");
      pushContainer(dep.containerId, runtime, "deployment container");
    }

    // Docker images (deduplicated)
    if (dep.imageRef && !seenImages.has(dep.imageRef) && runtime instanceof DockerRuntime) {
      seenImages.add(dep.imageRef);
      resources.push({
        type: "image",
        ref: dep.imageRef,
        label: `image ${dep.imageRef.slice(0, 24)}`,
        runtime,
      });
    }

    // Bare runtime artifacts (release dirs stored as containerId paths)
    if (dep.containerId?.includes("/") && !(runtime instanceof DockerRuntime)) {
      // Already tracked as "container" above - bare destroy() handles path removal
    }
  }

  // ── Project networks (always cleaned - they're clutter, not data) ──
  // One per docker runtime (Docker installs are per-machine), keyed off
  // project slug to match the `openship-<slug>` naming in DockerRuntime.
  for (const docker of dockerRuntimes) {
    resources.push({
      type: "network",
      ref: project.slug,
      label: `network openship-${project.slug}`,
      runtime: docker,
    });
  }

  // ── Domain routes (project-level) ──────────────────────────────────
  const domains = await repos.domain.listByProject(project.id).catch(() => []);
  for (const d of domains) {
    resources.push({
      type: "route",
      ref: d.hostname,
      label: `route ${d.hostname}`,
      runtime: null, // routes use routing adapter, not runtime
    });
  }

  // ── Service routes ─────────────────────────────────────────────────
  for (const svc of services) {
    const route = buildServiceRouteDomain({
      project,
      service: svc,
      runtimeName: "bare",
      usesManagedRouting: true,
    });
    if (route) {
      resources.push({
        type: "route",
        ref: route.hostname,
        label: `service route ${route.hostname}`,
        runtime: null,
      });
    }
  }

  // Ordering matters: containers must be destroyed before their volumes
  // (Docker refuses to remove volumes still attached to a live container),
  // and networks should come after all containers detach from them. The
  // batched executor runs resources in order, so a stable sort here is
  // enough - no need for explicit phases.
  const TYPE_ORDER: Record<CleanupResource["type"], number> = {
    container: 0,
    artifact: 0,
    image: 1,
    route: 2,
    volume: 3,
    network: 4,
  };
  resources.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);

  return { projectId: project.id, resources };
}

/**
 * Build a deletion-preview snapshot for the UI to render before the user
 * confirms. Returns the list of services and their named volumes, plus
 * any networks that exist on the host - so the user sees exactly what
 * will be wiped (or what'll be left behind if they skip `wipeVolumes`).
 *
 * Read-only - does NOT modify state. Cheap enough to call on modal open.
 */
export async function previewProjectDeletion(project: Project): Promise<DeletionPreview> {
  const services = await repos.service.listByProject(project.id).catch(() => []);
  const { rows: allDeps } = await repos.deployment.listByProject(project.id, { perPage: 1000 });

  const previewServices: DeletionPreviewService[] = [];
  const deploymentVolumes: string[] = [];
  const networkSlugs = new Set<string>();
  let selfHosted = false;

  // Map service id → its container id (most recent deployment wins, which
  // matches the order rows come back in). We resolve volumes per container.
  const serviceContainerByServiceId = new Map<string, { containerId: string; runtime: RuntimeAdapter }>();

  for (const dep of allDeps) {
    let runtime: RuntimeAdapter;
    try {
      ({ runtime } = await resolveDeploymentRuntime(dep));
    } catch {
      continue;
    }
    if (runtime instanceof DockerRuntime) {
      selfHosted = true;
      networkSlugs.add(project.slug);
    } else if (!(runtime instanceof DockerRuntime)) {
      // Bare runtime is also self-hosted; only the cloud adapter is "managed."
      selfHosted = selfHosted || runtime.name !== "cloud";
    }

    if (dep.containerId && runtime instanceof DockerRuntime) {
      const vols = await runtime.inspectNamedVolumes(dep.containerId).catch(() => [] as string[]);
      for (const v of vols) deploymentVolumes.push(v);
    }

    const serviceRows = await repos.service.listByDeployment(dep.id);
    for (const sd of serviceRows) {
      if (sd.containerId && !serviceContainerByServiceId.has(sd.serviceId)) {
        serviceContainerByServiceId.set(sd.serviceId, { containerId: sd.containerId, runtime });
      }
    }
  }

  for (const svc of services) {
    const link = serviceContainerByServiceId.get(svc.id);
    let volumes: string[] = [];
    if (link && link.runtime instanceof DockerRuntime) {
      volumes = await link.runtime.inspectNamedVolumes(link.containerId).catch(() => []);
    }
    previewServices.push({
      id: svc.id,
      name: svc.name,
      image: svc.image ?? null,
      volumes,
      hasContainer: !!link,
    });
  }

  const totalVolumes = deploymentVolumes.length + previewServices.reduce((n, s) => n + s.volumes.length, 0);

  return {
    projectId: project.id,
    projectName: project.name,
    selfHosted,
    services: previewServices,
    deploymentVolumes: Array.from(new Set(deploymentVolumes)),
    networks: Array.from(networkSlugs).map((slug) => `openship-${slug}`),
    totalVolumes,
  };
}

/**
 * Collect resources for a single deployment.
 * Used by deployment.service.ts deleteDeployment().
 */
export async function collectDeploymentManifest(
  dep: Deployment,
  _project: Project | null,
): Promise<CleanupManifest> {
  const resources: CleanupResource[] = [];
  const serviceRows = await repos.service.listByDeployment(dep.id).catch(() => []);
  const serviceContainerIds = serviceRows
    .map((r) => r.containerId)
    .filter((id): id is string => !!id);
  const containerIds = [
    ...new Set(
      serviceContainerIds.length > 0
        ? serviceContainerIds
        : dep.containerId
          ? [dep.containerId]
          : [],
    ),
  ];

  // Resolve the runtime once. Anything below this point that depends on the
  // runtime (containers, images) only fires when the runtime is reachable.
  let runtime: RuntimeAdapter | null = null;
  try {
    runtime = (await resolveDeploymentRuntime(dep)).runtime;
  } catch {
    return { projectId: dep.projectId, resources };
  }

  for (const containerId of containerIds) {
    resources.push({
      type: "container",
      ref: containerId,
      label: `container ${containerId.slice(0, 12)}`,
      runtime,
    });
  }

  // Images - main deployment imageRef + per-service imageRef. Only Docker
  // images need explicit removal (bare runtime artifacts are tied to the
  // container destroy path). Deduplicated across the manifest.
  if (runtime instanceof DockerRuntime) {
    const seenImages = new Set<string>();
    const pushImage = (ref: string | null | undefined, label: string) => {
      if (!ref || seenImages.has(ref)) return;
      seenImages.add(ref);
      resources.push({ type: "image", ref, label, runtime });
    };
    pushImage(dep.imageRef, `image ${(dep.imageRef ?? "").slice(0, 24)}`);
    for (const sd of serviceRows) {
      pushImage(sd.imageRef, `service image ${(sd.imageRef ?? "").slice(0, 24)}`);
    }
  }

  return { projectId: dep.projectId, resources };
}

// ─── Cleanup Executor ────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 6;
const RETRY_DELAY_MS = 2000;

/**
 * Execute cleanup for all resources in a manifest.
 *
 * - Bounded concurrency (default 6 parallel ops)
 * - Per-item error isolation: one failure doesn't block others
 * - Single retry with backoff for transient failures
 */
export async function executeCleanup(
  manifest: CleanupManifest,
  opts?: { concurrency?: number },
): Promise<CleanupResult> {
  const concurrency = opts?.concurrency ?? DEFAULT_CONCURRENCY;
  const { routing } = platform();
  const result: CleanupResult = { total: manifest.resources.length, succeeded: 0, failed: [] };

  // Process in bounded batches
  for (let i = 0; i < manifest.resources.length; i += concurrency) {
    const batch = manifest.resources.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map((resource) => destroyResource(resource, routing)),
    );

    for (let j = 0; j < settled.length; j++) {
      if (settled[j].status === "fulfilled") {
        result.succeeded++;
      } else {
        const resource = batch[j];
        const reason = settled[j] as PromiseRejectedResult;
        result.failed.push({
          ref: resource.ref,
          label: resource.label,
          error: safeErrorMessage(reason.reason),
        });
      }
    }
  }

  return result;
}

/** Destroy a single resource with one retry on failure. */
async function destroyResource(
  resource: CleanupResource,
  routing: ReturnType<typeof platform>["routing"],
): Promise<void> {
  try {
    await destroyResourceOnce(resource, routing);
  } catch (firstErr) {
    // Retry once after backoff
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    await destroyResourceOnce(resource, routing);
  }
}

async function destroyResourceOnce(
  resource: CleanupResource,
  routing: ReturnType<typeof platform>["routing"],
): Promise<void> {
  switch (resource.type) {
    case "container": {
      if (!resource.runtime) return;
      await resource.runtime.destroy(resource.ref);
      return;
    }
    case "image": {
      if (!resource.runtime || !(resource.runtime instanceof DockerRuntime)) return;
      await resource.runtime.removeImage(resource.ref);
      return;
    }
    case "artifact": {
      if (!resource.runtime) return;
      await resource.runtime.destroy(resource.ref);
      return;
    }
    case "route": {
      await routing.removeRoute(resource.ref);
      return;
    }
    case "volume": {
      if (!resource.runtime || !(resource.runtime instanceof DockerRuntime)) return;
      await resource.runtime.removeVolume(resource.ref);
      return;
    }
    case "network": {
      if (!resource.runtime || !(resource.runtime instanceof DockerRuntime)) return;
      await resource.runtime.removeNetwork(resource.ref);
      return;
    }
  }
}

// ─── High-Level Orchestrators ────────────────────────────────────────────────

export interface DeleteProjectOptions {
  /** True deletes every environment under the same project app. */
  deleteApp?: boolean;
  /** True wipes named Docker volumes - destroys persistent data. Default false. */
  wipeVolumes?: boolean;
}

export interface DeleteProjectFailure {
  projectId: string;
  resource: string;
  reason: string;
}

export interface DeleteProjectResult {
  ok: boolean;
  deletedApp: boolean;
  deletedProjects: number;
  /** Populated only when ok=false — every remote step that failed during
   *  cleanup. The local DB rows are preserved when this is non-empty so
   *  the caller can retry without orphaning cloud resources. */
  failed?: DeleteProjectFailure[];
  /** Human-readable summary when ok=false. */
  message?: string;
}

/**
 * Full project/environment deletion: validate → REMOTE cleanup first → DB delete.
 *
 * Ordering invariant: we must NOT delete the local project row until every
 * remote resource (Oblien workspaces / pages / edge proxies, Docker
 * containers, routes, volumes, networks) is gone. If we lose the local row
 * first and a remote step fails, the user has no way to retry the cleanup
 * — the project is invisible in the dashboard while the cloud resources
 * keep billing/serving. So the order here is intentionally:
 *
 *   1. collect resource manifests (must run before DB teardown anyway — the
 *      manifest needs domain/deployment rows still in place)
 *   2. run remote cleanup (executeCleanup + webmail teardown) per project
 *      and wait for it
 *   3. ONLY if every remote step succeeded: soft-delete project rows, drop
 *      domains, soft-delete project_app, hard-delete deployments + services
 *   4. on any remote failure: return { ok: false, failed: [...] } and leave
 *      local DB intact so the user can retry
 *
 * Within step 2, sub-steps still fan out via Promise.allSettled — parallel
 * where independent, sequential where dependent (executeCleanup already
 * orders containers→images→routes→volumes→networks via TYPE_ORDER).
 *
 * In the current product model, a DB project is one environment and project_app
 * is the app users think of as "the project". deleteApp=true removes all sibling
 * environments under that app; false removes only the current environment.
 */
export async function deleteProject(
  projectId: string,
  organizationId: string,
  options: DeleteProjectOptions = {},
): Promise<DeleteProjectResult> {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const deleteApp = options.deleteApp ?? true;
  const wipeVolumes = options.wipeVolumes ?? false;
  // Sibling environments are scoped by org membership.
  const projects = deleteApp
    ? (await repos.project.listByApp(p.appId)).filter(
        (row) => row.organizationId === organizationId,
      )
    : [p];

  // 1. Collect resource manifests BEFORE any teardown - the manifest needs
  //    to inspect domain/deployment rows AND container mount metadata that
  //    later steps remove. Volume enumeration also has to run here: once
  //    the container is gone, its mount metadata is gone too.
  const manifests = await Promise.all(
    projects.map(async (project) => ({
      project,
      manifest: await collectProjectManifest(project, { wipeVolumes }),
    })),
  );

  // 2. Run remote cleanup for every project FIRST and wait for completion.
  //    Each cleanup is parallel via Promise.allSettled so a single project's
  //    failure doesn't block siblings; sub-steps inside each cleanup are
  //    already bounded-concurrency + retry via executeCleanup.
  const cleanupSettled = await Promise.allSettled(
    manifests.map(({ project, manifest }) => cleanupProjectResources(manifest, project)),
  );

  // Aggregate failures into a flat list the controller can surface.
  const failed: DeleteProjectFailure[] = [];
  for (let i = 0; i < cleanupSettled.length; i++) {
    const settled = cleanupSettled[i];
    const project = manifests[i].project;
    if (settled.status === "rejected") {
      // The cleanup helper itself threw (catastrophic). Wrap as one entry.
      failed.push({
        projectId: project.id,
        resource: "(cleanup driver)",
        reason: safeErrorMessage(settled.reason),
      });
      continue;
    }
    for (const f of settled.value.failed) {
      failed.push({
        projectId: project.id,
        resource: f.label,
        reason: f.error,
      });
    }
  }

  // 3. If any remote step failed, ABORT before touching local DB. The
  //    project is still resolvable, the dashboard still shows it, and the
  //    user can retry to drain whatever stragglers remain. This is the
  //    critical safety property: a partial cloud teardown must never
  //    orphan-on-local-delete.
  if (failed.length > 0) {
    const total = cleanupSettled.reduce(
      (n, s) => n + (s.status === "fulfilled" ? s.value.total : 1),
      0,
    );
    const failedCount = failed.length;
    console.error(
      `[PROJECT] Aborting DB delete for ${projectId}: ${failedCount}/${total} remote cleanup steps failed`,
    );
    return {
      ok: false,
      deletedApp: false,
      deletedProjects: 0,
      failed,
      message: `${failedCount}/${total} remote cleanup steps failed. Local project preserved. Retry to attempt again.`,
    };
  }

  // 4. Remote cleanup succeeded everywhere - now safe to drop local rows.
  //    Soft-delete environments and hard-delete domain rows so the managed-
  //    slug "registry" is freed. Order matters: domains first so an
  //    immediate redeploy doesn't trip over an orphan row.
  await Promise.all(projects.map((project) => repos.domain.deleteByProjectId(project.id)));
  await Promise.all(projects.map((project) => repos.project.softDelete(project.id)));

  let deletedApp = deleteApp;
  if (deleteApp) {
    await repos.projectApp.softDelete(p.appId);
  } else {
    const remainingEnvironments = await repos.project.listByApp(p.appId);
    if (remainingEnvironments.length === 0) {
      await repos.projectApp.softDelete(p.appId);
      deletedApp = true;
    }
  }

  // 5. Hard-delete dependent rows. Project soft-delete only sets `deletedAt`
  //    and FK cascades only fire on hard-delete, so service rows survive
  //    otherwise. Order matters: deployments first (their FK cascades remove
  //    serviceDeployment rows), then services (no FK dependents left).
  await Promise.all(
    projects.map((project) => repos.deployment.deleteByProjectId(project.id)),
  );
  await Promise.all(
    projects.map((project) => repos.service.deleteByProjectId(project.id)),
  );

  return { ok: true, deletedApp, deletedProjects: projects.length };
}

/**
 * Internal: drive remote cleanup for a single project. Returns the cleanup
 * result so deleteProject() can decide whether to proceed with DB teardown.
 *
 * Layers:
 *   1. executeCleanup(manifest) — containers/images/routes/volumes/networks
 *      via runtime + routing adapters (bounded concurrency, single retry).
 *      On cloud, destroying the workspace also frees the Oblien-side route;
 *      on self-hosted, removeRoute clears the local nginx config.
 *   2. webmail-specific teardown — branding dir + mail-state block, which
 *      live outside the generic resource manifest.
 *
 * Throws only on catastrophic failures (e.g. the manifest itself is
 * malformed); per-resource failures are reported in the returned
 * CleanupResult and the caller decides what to do.
 */
async function cleanupProjectResources(
  manifest: CleanupManifest,
  project: Project,
): Promise<CleanupResult> {
  const result = await executeCleanup(manifest);
  if (result.failed.length > 0) {
    console.error(
      `[PROJECT] Cleanup for ${project.id}: ${result.succeeded}/${result.total} succeeded, ` +
        `${result.failed.length} failed:`,
      result.failed.map((f) => `${f.label}: ${f.error}`),
    );
  }

  // Webmail keeps a branding dir outside the workspace and a block in the
  // mail-state file; both have to be wiped explicitly so a future re-deploy
  // starts fresh. Only run when the generic resource cleanup succeeded —
  // otherwise we'd wipe the branding while the route still serves traffic.
  if (project.framework === "webmail" && result.failed.length === 0) {
    const mailServerId = mailServerIdFromWebmailSlug(project.slug);
    if (mailServerId) {
      try {
        await cleanupWebmailInstall({ mailServerId });
      } catch (err) {
        result.failed.push({
          ref: mailServerId,
          label: `webmail teardown ${project.slug}`,
          error: safeErrorMessage(err),
        });
      }
    }
  }

  return result;
}


