import { repos, type Domain, type Project, type Service } from "@repo/db";
import type { RoutedDomainInput, SslProvider } from "@repo/adapters";
import { SYSTEM, resolveServiceHostnameLabel } from "@repo/core";
import { env } from "../config/env";

export interface PlannedRouteDomain {
  hostname: string;
  tls: true;
  provisionSsl: boolean;
  isCloud: boolean;
  targetPort?: number;
  targetPath?: string;
  domainType?: "free" | "custom";
  managedSubdomain?: string;
  serviceId?: string;
  isPrimary?: boolean;
  createIfMissing?: boolean;
}

export function getRoutingBaseDomain(): string {
  return env.HOST_DOMAIN || SYSTEM.DOMAINS.CLOUD_DOMAIN;
}

function resolveManagedHostname(hostname: string): { isManaged: boolean; subdomain?: string } {
  const baseDomain = getRoutingBaseDomain().toLowerCase();
  const normalized = hostname.trim().toLowerCase();
  const suffix = `.${baseDomain}`;

  if (!normalized.endsWith(suffix)) {
    return { isManaged: false };
  }

  const subdomain = normalized.slice(0, -suffix.length);
  return {
    isManaged: subdomain.length > 0,
    subdomain: subdomain || undefined,
  };
}

export function buildProjectRouteDomains(opts: {
  project: Project;
  projectDomains: Domain[];
  customDomain?: string;
  managedSlug?: string;
  publicEndpoints?: Array<{
    port?: number;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }>;
  runtimeName: string;
  usesManagedRouting: boolean;
}): PlannedRouteDomain[] {
  const {
    project,
    projectDomains,
    customDomain,
    managedSlug,
    publicEndpoints,
    runtimeName,
    usesManagedRouting,
  } = opts;
  const seen = new Set<string>();
  const planned: PlannedRouteDomain[] = [];

  const add = (
    hostname: string,
    domainType: "free" | "custom",
    skipSsl = false,
    destination?: { targetPort?: number; targetPath?: string },
    isPrimary = planned.length === 0,
  ) => {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    if (!destination?.targetPath && destination?.targetPort === undefined) return;
    seen.add(normalized);

    const managed = resolveManagedHostname(normalized);
    planned.push({
      hostname: normalized,
      tls: true,
      provisionSsl: runtimeName === "bare" && !managed.isManaged && !skipSsl,
      isCloud: managed.isManaged,
      ...(destination?.targetPort !== undefined ? { targetPort: destination.targetPort } : {}),
      ...(destination?.targetPath ? { targetPath: destination.targetPath } : {}),
      domainType,
      managedSubdomain: managed.subdomain,
      isPrimary,
      createIfMissing: true,
    });
  };

  if (publicEndpoints?.length) {
    for (const [index, endpoint] of publicEndpoints.entries()) {
      const destination = endpoint.targetPath
        ? { targetPath: endpoint.targetPath }
        : endpoint.port !== undefined
          ? { targetPort: endpoint.port }
          : undefined;

      if (!destination) {
        continue;
      }

      if (endpoint.domainType === "custom" && endpoint.customDomain) {
        add(endpoint.customDomain, "custom", false, destination, index === 0);
        continue;
      }

      const routeSlug = endpoint.domain || managedSlug;
      if (routeSlug && usesManagedRouting) {
        add(`${routeSlug}.${getRoutingBaseDomain()}`, "free", true, destination, index === 0);
      }
    }

    return planned;
  }

  if (customDomain) add(customDomain, "custom");
  for (const domain of projectDomains) {
    if (domain.verified && !domain.serviceId) {
      add(
        domain.hostname,
        domain.domainType === "free" ? "free" : "custom",
        domain.domainType === "free",
        domain.targetPath
          ? { targetPath: domain.targetPath }
          : domain.targetPort !== null && domain.targetPort !== undefined
            ? { targetPort: domain.targetPort }
            : undefined,
        domain.isPrimary,
      );
    }
  }
  const routeSlug = managedSlug;
  if (routeSlug && usesManagedRouting) {
    add(`${routeSlug}.${getRoutingBaseDomain()}`, "free", true);
  }

  return planned;
}

export function buildServiceRouteDomain(opts: {
  project: Project;
  service: Service;
  runtimeName: string;
  usesManagedRouting: boolean;
}): PlannedRouteDomain | null {
  const { project, service, runtimeName, usesManagedRouting } = opts;
  if (!service.exposed) return null;

  const targetPort = service.exposedPort ? Number(service.exposedPort) : undefined;

  const hostname = service.domainType === "custom"
    ? service.customDomain?.trim().toLowerCase()
    : usesManagedRouting
      ? `${resolveServiceHostnameLabel(project.slug ?? project.name, service.name, service.domain)}.${getRoutingBaseDomain()}`
      : null;

  if (!hostname) return null;

  const managed = resolveManagedHostname(hostname);
  return {
    hostname,
    tls: true,
    provisionSsl: runtimeName === "bare" && service.domainType === "custom",
    isCloud: managed.isManaged,
    targetPort: Number.isFinite(targetPort) ? targetPort : undefined,
    domainType: service.domainType === "custom" ? "custom" : "free",
    managedSubdomain: managed.subdomain,
    serviceId: service.id,
    isPrimary: false,
    createIfMissing: true,
  };
}

export function createTrackedSslProvider(
  ssl: SslProvider,
  domainByHostname: Map<string, Domain>,
): SslProvider {
  const persistSslResult = async (hostname: string, result: Awaited<ReturnType<SslProvider["provisionCert"]>>) => {
    const domainRecord = domainByHostname.get(hostname.toLowerCase());

    if (domainRecord) {
      await repos.domain.updateSsl(domainRecord.id, {
        sslStatus: result.expiresAt ? "active" : "provisioning",
        sslIssuer: result.issuer,
        sslExpiresAt: result.expiresAt ? new Date(result.expiresAt) : undefined,
      });
    }

    return result;
  };

  return {
    provisionCert: async (hostname: string) => {
      const result = await ssl.provisionCert(hostname);
      return persistSslResult(hostname, result);
    },
    renewCert: async (hostname: string) => {
      const result = await ssl.renewCert(hostname);
      return persistSslResult(hostname, result);
    },
  };
}

export async function ensureRouteDomainRecord(opts: {
  projectId: string;
  route: PlannedRouteDomain;
  domainByHostname: Map<string, Domain>;
}): Promise<Domain | null> {
  const { projectId, route, domainByHostname } = opts;
  const key = route.hostname.toLowerCase();
  const existing = domainByHostname.get(key);
  if (existing) {
    const patch: Record<string, unknown> = {};
    const expectedDomainType = route.domainType ?? null;
    const expectedTargetPort = route.targetPort ?? null;
    const expectedTargetPath = route.targetPath ?? null;
    const expectedServiceId = route.serviceId ?? null;
    const expectedPrimary = route.isPrimary ?? existing.isPrimary;

    if ((existing.domainType ?? null) !== expectedDomainType) patch.domainType = expectedDomainType;
    if ((existing.targetPort ?? null) !== expectedTargetPort) patch.targetPort = expectedTargetPort;
    if ((existing.targetPath ?? null) !== expectedTargetPath) patch.targetPath = expectedTargetPath;
    if ((existing.serviceId ?? null) !== expectedServiceId) patch.serviceId = expectedServiceId;
    if (existing.isPrimary !== expectedPrimary) patch.isPrimary = expectedPrimary;
    if (!existing.verified) {
      patch.verified = true;
      patch.verifiedAt = new Date();
    }
    if (existing.status !== "active") patch.status = "active";

    if (Object.keys(patch).length > 0) {
      await repos.domain.update(existing.id, patch);
      const updated = { ...existing, ...patch } as Domain;
      domainByHostname.set(key, updated);
      return updated;
    }

    return existing;
  }

  if (!route.createIfMissing) {
    return null;
  }

  const created = await repos.domain.findOrCreate({
    projectId,
    serviceId: route.serviceId,
    hostname: route.hostname,
    targetPort: route.targetPort,
    targetPath: route.targetPath,
    domainType: route.domainType,
    isPrimary: route.isPrimary ?? (!route.serviceId && domainByHostname.size === 0),
    status: "active",
    verified: true,
    verifiedAt: new Date(),
  });
  domainByHostname.set(key, created);
  return created;
}

export function toRoutedDomainInputs(domains: PlannedRouteDomain[]): RoutedDomainInput[] {
  return domains.map((domain) => ({
    hostname: domain.hostname,
    tls: domain.tls,
    provisionSsl: domain.provisionSsl,
    targetPort: domain.targetPort,
    targetPath: domain.targetPath,
  }));
}
