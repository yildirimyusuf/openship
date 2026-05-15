import { repos, type Domain, type Project } from "@repo/db";
import {
  inferPublicRouteDomainType,
  normalizeTargetPath,
  publicEndpointHostname,
  syncStoredPublicEndpoints,
  type StoredPublicEndpoint,
} from "../../lib/public-endpoints";
import { getRoutingBaseDomain } from "../../lib/routing-domains";
import { syncProjectPublicRoutes } from "../../lib/project-route-store";

type ProjectRouteProject = Pick<Project, "id" | "slug">;
type RouteStateProject = Pick<Project, "slug">;
type NextPublicEndpointsInput = Parameters<typeof syncStoredPublicEndpoints>[0]["next"];

export interface ProjectRouteEndpoint extends StoredPublicEndpoint {
  id?: string;
  hostname: string;
  isPrimary: boolean;
}

export interface ProjectRouteState {
  projectDomains: Domain[];
  publicEndpoints: ProjectRouteEndpoint[];
  primarySlug: string;
  primaryCustomDomain?: string;
  primaryDomainType: "free" | "custom";
}

export function deriveEnvironmentPublicEndpoints(
  publicEndpoints: Array<Pick<StoredPublicEndpoint, "port" | "targetPath">>,
  slug: string,
): StoredPublicEndpoint[] {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) return [];

  const primaryEndpoint = publicEndpoints[0];
  if (!primaryEndpoint) return [];

  if (primaryEndpoint.targetPath) {
    return [{
      targetPath: primaryEndpoint.targetPath,
      domain: normalizedSlug,
      domainType: "free",
    }];
  }

  if (primaryEndpoint.port !== undefined) {
    return [{
      port: primaryEndpoint.port,
      domain: normalizedSlug,
      domainType: "free",
    }];
  }

  return [];
}

function normalizeProjectRouteRows(projectDomains: Domain[]): Domain[] {
  return projectDomains
    .filter((domain) => !domain.serviceId)
    .sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }

      return left.hostname.localeCompare(right.hostname);
    });
}

function managedHostnameToSlug(hostname: string): string | undefined {
  const normalized = hostname.trim().toLowerCase();
  const suffix = `.${getRoutingBaseDomain().trim().toLowerCase()}`;
  if (!normalized.endsWith(suffix)) return undefined;

  const slug = normalized.slice(0, -suffix.length);
  return slug || undefined;
}

function draftEndpointsWithIds(
  projectDomains: Domain[],
  endpoints: StoredPublicEndpoint[],
): ProjectRouteEndpoint[] {
  const idByHostname = new Map(
    normalizeProjectRouteRows(projectDomains).map((domain) => [domain.hostname.toLowerCase(), domain.id]),
  );

  return endpoints.map((endpoint, index) => {
    const hostname = publicEndpointHostname(endpoint) ?? "";
    return {
      ...endpoint,
      id: hostname ? idByHostname.get(hostname.toLowerCase()) : undefined,
      hostname,
      isPrimary: index === 0,
    } satisfies ProjectRouteEndpoint;
  });
}

function routeRowToEndpoint(domain: Domain): ProjectRouteEndpoint | null {
  const hostname = domain.hostname?.trim().toLowerCase();
  if (!hostname || domain.serviceId) return null;

  const port = domain.targetPort ?? undefined;
  const targetPath = normalizeTargetPath(domain.targetPath);
  const domainType = inferPublicRouteDomainType(hostname, domain.domainType);

  if ((port !== undefined) === Boolean(targetPath)) {
    return null;
  }

  if (domainType === "free") {
    const slug = managedHostnameToSlug(hostname);
    if (!slug) return null;

    return {
      id: domain.id,
      hostname,
      isPrimary: domain.isPrimary,
      ...(port !== undefined ? { port } : {}),
      ...(targetPath ? { targetPath } : {}),
      domain: slug,
      domainType,
    } satisfies ProjectRouteEndpoint;
  }

  return {
    id: domain.id,
    hostname,
    isPrimary: domain.isPrimary,
    ...(port !== undefined ? { port } : {}),
    ...(targetPath ? { targetPath } : {}),
    customDomain: hostname,
    domainType,
  } satisfies ProjectRouteEndpoint;
}

function buildRouteState(
  project: RouteStateProject,
  projectDomains: Domain[],
  publicEndpoints: ProjectRouteEndpoint[],
): ProjectRouteState {
  const primaryEndpoint = publicEndpoints[0];

  return {
    projectDomains,
    publicEndpoints,
    primarySlug:
      primaryEndpoint?.domainType === "free"
        ? (primaryEndpoint.domain ?? project.slug ?? "project")
        : (project.slug ?? "project"),
    primaryCustomDomain:
      primaryEndpoint?.domainType === "custom" ? primaryEndpoint.customDomain : undefined,
    primaryDomainType: primaryEndpoint?.domainType ?? "free",
  };
}

export async function listProjectRouteRows(projectId: string): Promise<Domain[]> {
  return repos.domain.listByProject(projectId);
}

export function deriveProjectRouteState(
  project: RouteStateProject,
  opts?: { projectDomains?: Domain[] },
): ProjectRouteState {
  const projectDomains = normalizeProjectRouteRows(opts?.projectDomains ?? []);
  const publicEndpoints = projectDomains
    .map((domain) => routeRowToEndpoint(domain))
    .filter((endpoint): endpoint is ProjectRouteEndpoint => endpoint !== null);

  return buildRouteState(project, projectDomains, publicEndpoints);
}

export function deriveNextProjectRouteState(
  project: RouteStateProject,
  input: {
    projectDomains?: Domain[];
    nextPublicEndpoints?: NextPublicEndpointsInput;
    slug?: string | null;
    customDomain?: string | null;
  },
): ProjectRouteState {
  const currentState = deriveProjectRouteState(project, {
    projectDomains: input.projectDomains,
  });
  const routing = syncStoredPublicEndpoints({
    current: currentState.publicEndpoints,
    next: input.nextPublicEndpoints,
    slug: input.slug ?? project.slug,
    customDomain: input.customDomain,
    projectDomains: currentState.projectDomains,
  });

  return buildRouteState(
    project,
    currentState.projectDomains,
    draftEndpointsWithIds(currentState.projectDomains, routing.publicEndpoints),
  );
}

export async function resolveProjectRouteState(
  project: ProjectRouteProject,
  opts?: { projectDomains?: Domain[] },
): Promise<ProjectRouteState> {
  const projectDomains = opts?.projectDomains ?? await listProjectRouteRows(project.id);
  return deriveProjectRouteState(project, { projectDomains });
}

export async function persistProjectRouteState(
  projectId: string,
  publicEndpoints: StoredPublicEndpoint[],
  projectDomains?: Domain[],
): Promise<void> {
  await syncProjectPublicRoutes({
    projectId,
    endpoints: publicEndpoints,
    currentDomains: projectDomains,
  });
}

export async function syncProjectRouteState(
  project: ProjectRouteProject,
  input: {
    projectDomains?: Domain[];
    nextPublicEndpoints?: NextPublicEndpointsInput;
    slug?: string | null;
    customDomain?: string | null;
  },
): Promise<ProjectRouteState> {
  const projectDomains = input.projectDomains ?? await listProjectRouteRows(project.id);
  const nextState = deriveNextProjectRouteState(project, {
    ...input,
    projectDomains,
  });

  await persistProjectRouteState(project.id, nextState.publicEndpoints, projectDomains);
  const refreshedDomains = await listProjectRouteRows(project.id);
  return deriveProjectRouteState(project, { projectDomains: refreshedDomains });
}