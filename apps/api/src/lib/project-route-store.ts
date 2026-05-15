import { repos, type Domain } from "@repo/db";
import { ConflictError } from "@repo/core";
import {
  normalizeStoredPublicEndpoints,
  publicEndpointHostname,
  type StoredPublicEndpoint,
} from "./public-endpoints";

interface SyncProjectPublicRoutesInput {
  projectId: string;
  endpoints?: StoredPublicEndpoint[] | null;
  currentDomains?: Domain[] | null;
}

interface DesiredProjectRoute {
  hostname: string;
  targetPort?: number;
  targetPath?: string;
  domainType: "free" | "custom";
  isPrimary: boolean;
}

function desiredProjectRoutes(endpoints?: StoredPublicEndpoint[] | null): DesiredProjectRoute[] {
  const seen = new Set<string>();

  return normalizeStoredPublicEndpoints(endpoints).flatMap((endpoint, index) => {
    const hostname = publicEndpointHostname(endpoint);
    if (!hostname || seen.has(hostname)) return [];

    seen.add(hostname);
    return [{
      hostname,
      targetPort: endpoint.port,
      targetPath: endpoint.targetPath,
      domainType: endpoint.domainType,
      isPrimary: index === 0,
    } satisfies DesiredProjectRoute];
  });
}

export async function syncProjectPublicRoutes(
  input: SyncProjectPublicRoutesInput,
): Promise<StoredPublicEndpoint[]> {
  const endpoints = normalizeStoredPublicEndpoints(input.endpoints);
  const allExistingDomains = input.currentDomains ?? await repos.domain.listByProject(input.projectId);
  const existingDomains = allExistingDomains
    .filter((domain) => !domain.serviceId);
  const desiredRoutes = desiredProjectRoutes(endpoints);
  const desiredByHostname = new Map(desiredRoutes.map((route) => [route.hostname, route]));
  const existingByHostname = new Map(
    allExistingDomains.map((domain) => [domain.hostname.toLowerCase(), domain]),
  );

  for (const domain of existingDomains) {
    if (!desiredByHostname.has(domain.hostname.toLowerCase())) {
      await repos.domain.remove(domain.id);
      existingByHostname.delete(domain.hostname.toLowerCase());
    }
  }

  for (const route of desiredRoutes) {
    let existing = existingByHostname.get(route.hostname);

    if (!existing) {
      const globalExisting = await repos.domain.findByHostname(route.hostname);
      if (globalExisting) {
        if (globalExisting.projectId !== input.projectId) {
          throw new ConflictError(`Domain "${route.hostname}" is already in use`);
        }

        existing = globalExisting;
        existingByHostname.set(route.hostname, globalExisting);
      }
    }

    if (!existing) {
      let created: Domain;
      try {
        created = await repos.domain.create({
          projectId: input.projectId,
          serviceId: null,
          hostname: route.hostname,
          targetPort: route.targetPort,
          targetPath: route.targetPath,
          domainType: route.domainType,
          isPrimary: route.isPrimary,
          status: "active",
          verified: true,
          verifiedAt: new Date(),
        });
      } catch (err: any) {
        if (err?.cause?.code === "23505" || err?.code === "23505") {
          const conflicting = await repos.domain.findByHostname(route.hostname);
          if (conflicting) {
            if (conflicting.projectId !== input.projectId) {
              throw new ConflictError(`Domain "${route.hostname}" is already in use`);
            }

            created = conflicting;
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      existingByHostname.set(route.hostname, created);
      continue;
    }

    const patch: Record<string, unknown> = {};
    if ((existing.serviceId ?? null) !== null) patch.serviceId = null;
    if ((existing.targetPort ?? null) !== (route.targetPort ?? null)) patch.targetPort = route.targetPort ?? null;
    if ((existing.targetPath ?? null) !== (route.targetPath ?? null)) patch.targetPath = route.targetPath ?? null;
    if ((existing.domainType ?? null) !== route.domainType) patch.domainType = route.domainType;
    if (existing.isPrimary !== route.isPrimary) patch.isPrimary = route.isPrimary;
    if (!existing.verified) {
      patch.verified = true;
      patch.verifiedAt = new Date();
    }
    if (existing.status !== "active") patch.status = "active";

    if (Object.keys(patch).length > 0) {
      await repos.domain.update(existing.id, patch);
      existingByHostname.set(route.hostname, { ...existing, ...patch } as Domain);
    }
  }

  return endpoints;
}