/**
 * Adopt a discovered Docker stack as an Openship project.
 *
 * Re-discovers the server (server truth, not client-sent config), filters to the
 * services the user selected, and creates a `services` project whose service
 * rows mirror the running containers. Same-server adoption reuses the EXISTING
 * named volumes in place by default (`namespaceVolumes=false`, original bare
 * names) so data survives — Openship would otherwise re-scope them to
 * `openship-<slug>-<name>` and mount empty volumes. A service the user marks
 * "copy" instead keeps the scoped name; its data is duplicated into that new
 * volume during moving_data, leaving the original volume untouched.
 *
 * This creates records only; deploy + cutover (stop old → start Openship's) is a
 * separate step so the user reviews before anything on the server changes.
 */

import { repos } from "@repo/db";
import { ensureProject } from "../projects/project-crud.service";
import { discoverServerStack } from "./docker-inspect.service";
import type { DiscoveredVolumeMount } from "./docker-reconcile";

type EnsureBody = Parameters<typeof ensureProject>[0];
type ParsedComposeList = Parameters<typeof repos.service.syncFromCompose>[1];

export interface AdoptResult {
  projectId: string;
  slug: string;
  created: boolean;
  adopted: string[];
}

/** A discovered mount → compose volume string. Anonymous (no source) is dropped
 *  (its data isn't reusable in place). Named volumes keep their original bare
 *  name; bind mounts keep their host path. */
function volumeToComposeString(v: DiscoveredVolumeMount): string | null {
  if (!v.source) return null;
  const mode = v.rw ? "" : ":ro";
  return `${v.source}:${v.target}${mode}`;
}

export async function adoptServerStack(opts: {
  serverId: string;
  organizationId: string;
  projectName: string;
  serviceNames: string[];
  /** True when target == source. Only then is "copy" (below) meaningful. */
  sameServer?: boolean;
  /** serviceName → "reuse" | "copy" (same-server volume ownership). */
  volumeStrategies?: Record<string, "reuse" | "copy">;
}): Promise<AdoptResult> {
  const { serverId, organizationId, projectName, serviceNames, sameServer, volumeStrategies } = opts;

  const stack = await discoverServerStack(serverId, organizationId);
  const selected = new Set(serviceNames);
  const chosen = stack.services.filter((s) => selected.has(s.name));
  if (chosen.length === 0) {
    throw new Error("None of the selected services were found on the server.");
  }

  const anyBuild = chosen.some((s) => Boolean(s.build));
  const ensureBody: EnsureBody = {
    name: projectName,
    projectType: "services",
    hasServer: true,
    hasBuild: anyBuild,
  };
  const { project_id, created } = await ensureProject(ensureBody, organizationId);

  const parsed: ParsedComposeList = chosen.map((s) => ({
    name: s.name,
    kind: "compose",
    // A service that builds keeps its build context; otherwise adopt the image.
    image: s.build ? undefined : s.image,
    build: s.build,
    dockerfile: s.dockerfile,
    ports: s.ports,
    // Only keep dependencies on services we're also adopting.
    dependsOn: s.dependsOn.filter((d) => selected.has(d)),
    environment: s.env,
    volumes: s.volumes
      .map(volumeToComposeString)
      .filter((v): v is string => v !== null),
    command: s.command,
    restart: s.restart,
    advanced: s.healthcheck ? { healthcheck: s.healthcheck } : undefined,
  }));

  const createdServices = await repos.service.syncFromCompose(project_id, parsed);

  // Volume ownership: reuse the original bare-named volumes in place
  // (namespaceVolumes=false) — EXCEPT same-server services the user marked
  // "copy", which keep the scoped openship-<slug>-<name> name so the deploy
  // mounts the fresh copy (populated in moving_data) and the original volume is
  // left untouched. Cross-server always reuses bare names (the A→B stream trick).
  for (const svc of createdServices) {
    const copy = Boolean(sameServer) && volumeStrategies?.[svc.name] === "copy";
    if (svc.namespaceVolumes !== copy) {
      await repos.service.update(svc.id, { namespaceVolumes: copy });
    }
  }

  const project = await repos.project.findById(project_id);
  return {
    projectId: project_id,
    slug: project?.slug ?? "",
    created,
    adopted: chosen.map((s) => s.name),
  };
}
