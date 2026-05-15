/**
 * Project service-shape helpers.
 *
 * Compose is only one way to populate project services. The deployment shape is
 * owned by the project: if it has saved services, or the current deploy request
 * includes parsed services, it uses the service pipeline.
 */

import { repos, type Project, type Service } from "@repo/db";
import { getProjectType, type StackId } from "@repo/core";
import type { ComposeService } from "../../../lib/compose-parser";

export function isLegacyComposeProject(project: Pick<Project, "framework">): boolean {
  const framework = project.framework as StackId | undefined;
  if (!framework) return false;

  try {
    return getProjectType(framework) === "services";
  } catch {
    return framework === "docker-compose";
  }
}

export async function listProjectServices(projectId: string): Promise<Service[]> {
  return repos.service.listByProject(projectId);
}

export function projectServicesToComposeServices(services: Service[]): ComposeService[] {
  return services.map((service) => ({
    name: service.name,
    image: service.image ?? undefined,
    build: service.build ?? undefined,
    dockerfile: service.dockerfile ?? undefined,
    ports: (service.ports as string[] | null) ?? [],
    dependsOn: (service.dependsOn as string[] | null) ?? [],
    environment: (service.environment as Record<string, string> | null) ?? {},
    volumes: (service.volumes as string[] | null) ?? [],
    command: service.command ?? undefined,
    restart: service.restart ?? undefined,
    exposed: service.exposed,
    exposedPort: service.exposedPort ?? undefined,
    domain: service.domain ?? undefined,
    customDomain: service.customDomain ?? undefined,
    domainType: service.domainType === "custom" ? "custom" : "free",
  }));
}

export async function resolveProjectServicePreflightServices(
  projectId: string,
  requestServices?: ComposeService[] | null,
): Promise<ComposeService[]> {
  if (requestServices?.length) return requestServices;
  const services = await listProjectServices(projectId);
  return projectServicesToComposeServices(services.filter((service) => service.enabled));
}

export async function shouldUseProjectServicePipeline(
  project: Project,
  requestServices?: ComposeService[] | null,
): Promise<boolean> {
  if (requestServices?.length) return true;
  if ((await listProjectServices(project.id)).length > 0) return true;

  // Compatibility for existing compose projects that may not have synced
  // service rows yet. New behavior should be driven by project services.
  return isLegacyComposeProject(project);
}
