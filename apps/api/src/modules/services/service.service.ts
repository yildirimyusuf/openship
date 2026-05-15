/**
 * Service business logic — CRUD and compose sync.
 */

import { repos } from "@repo/db";
import type { LogEntry } from "@repo/adapters";
import { encrypt, decrypt } from "../../lib/encryption";
import { assertProjectAccess, platform } from "../../lib/controller-helpers";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { buildServiceRouteDomain, getRoutingBaseDomain } from "../../lib/routing-domains";
import type {
  TCreateServiceBody,
  TUpdateServiceBody,
  TSetServiceEnvVarsBody,
} from "./service.schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Verify a service exists and belongs to the given project */
async function assertServiceAccess(projectId: string, serviceId: string, userId: string) {
  const project = await assertProjectAccess(projectId, userId);
  const svc = await repos.service.findById(serviceId);
  if (!svc || svc.projectId !== projectId) {
    throw new Error("service-not-found");
  }
  return { project, svc };
}

const trimOrNull = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed || null;
};

function normalizeRoutingPatch(input: {
  exposed?: boolean | null;
  exposedPort?: string | null;
  domain?: string | null;
  customDomain?: string | null;
  domainType?: string | null;
}): {
  exposed: boolean;
  exposedPort: string | null;
  domain: string | null;
  customDomain: string | null;
  domainType: "free" | "custom";
} {
  const exposed = input.exposed ?? false;
  if (!exposed) {
    return {
      exposed: false,
      exposedPort: null,
      domain: null,
      customDomain: null,
      domainType: "free",
    };
  }

  const domainType = input.domainType === "custom" ? "custom" : "free";

  return {
    exposed: true,
    exposedPort: trimOrNull(input.exposedPort),
    domain: domainType === "free" ? trimOrNull(input.domain) : null,
    customDomain: domainType === "custom" ? trimOrNull(input.customDomain) : null,
    domainType,
  };
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function listServices(projectId: string, userId: string) {
  await assertProjectAccess(projectId, userId);
  return repos.service.listByProject(projectId);
}

export async function getService(projectId: string, serviceId: string, userId: string) {
  const { svc } = await assertServiceAccess(projectId, serviceId, userId);
  return svc;
}

// ─── Create / Update ─────────────────────────────────────────────────────────

export async function createService(projectId: string, userId: string, data: TCreateServiceBody) {
  await assertProjectAccess(projectId, userId);

  const name = data.name.trim();
  if (!name) {
    throw new Error("service-name-required");
  }

  const existing = await repos.service.findByName(projectId, name);
  if (existing) {
    throw new Error("service-name-already-exists");
  }

  const services = await repos.service.listByProject(projectId);
  const routing = normalizeRoutingPatch({
    exposed: data.exposed ?? false,
    exposedPort: data.exposedPort,
    domain: data.domain,
    customDomain: data.customDomain,
    domainType: data.domainType,
  });

  return repos.service.create({
    projectId,
    name,
    image: trimOrNull(data.image),
    build: trimOrNull(data.build),
    dockerfile: trimOrNull(data.dockerfile),
    ports: data.ports ?? [],
    dependsOn: data.dependsOn ?? [],
    environment: data.environment ?? {},
    volumes: data.volumes ?? [],
    command: trimOrNull(data.command),
    restart: data.restart ?? "unless-stopped",
    ...routing,
    enabled: data.enabled ?? true,
    sortOrder: data.sortOrder ?? services.length,
  });
}

export async function updateService(
  projectId: string,
  serviceId: string,
  userId: string,
  data: TUpdateServiceBody,
) {
  const { project, svc } = await assertServiceAccess(projectId, serviceId, userId);

  // Normalize routing: when exposed is turned off, clear routing fields.
  // When domainType changes, clear the irrelevant domain field.
  const patch: Record<string, any> = { ...data };

  if ("name" in patch && typeof patch.name === "string") {
    const name = patch.name.trim();
    if (!name) {
      throw new Error("service-name-required");
    }

    if (name !== svc.name) {
      const existing = await repos.service.findByName(projectId, name);
      if (existing && existing.id !== serviceId) {
        throw new Error("service-name-already-exists");
      }
    }

    patch.name = name;
  }

  for (const key of ["image", "build", "dockerfile", "command"] as const) {
    if (key in patch) {
      patch[key] = trimOrNull(patch[key]);
    }
  }

  const touchesRouting = ["exposed", "exposedPort", "domain", "customDomain", "domainType"].some(
    (key) => key in patch,
  );
  const nameChanged = typeof patch.name === "string" && patch.name !== svc.name;

  if (touchesRouting) {
    const normalized = normalizeRoutingPatch({
      exposed: patch.exposed ?? svc.exposed,
      exposedPort: patch.exposedPort ?? svc.exposedPort,
      domain: patch.domain ?? svc.domain,
      customDomain: patch.customDomain ?? svc.customDomain,
      domainType: patch.domainType ?? svc.domainType,
    });

    patch.exposed = normalized.exposed;
    patch.exposedPort = normalized.exposedPort ?? undefined;
    patch.domain = normalized.domain ?? undefined;
    patch.customDomain = normalized.customDomain ?? undefined;
    patch.domainType = normalized.domainType;
  }

  await repos.service.update(serviceId, patch);
  const updated = await repos.service.findById(serviceId);

  // ── Route management ─────────────────────────────────────────
  // Keep live routes aligned when enable/expose/domain/port/name changes.
  const enabledChanged = typeof data.enabled === "boolean" && data.enabled !== svc.enabled;
  const exposedChanged = touchesRouting && patch.exposed !== svc.exposed;

  if (updated && (enabledChanged || exposedChanged || touchesRouting || nameChanged)) {
    try {
      const { routing, runtime } = platform();
      const runtimeName = runtime.name;
      const wasRoutable = svc.enabled && svc.exposed;
      const isRoutable = (updated.enabled ?? svc.enabled) && (updated.exposed ?? svc.exposed);
      const oldRoute = buildServiceRouteDomain({
        project,
        service: svc,
        runtimeName,
        usesManagedRouting: true,
      });
      const nextRoute = buildServiceRouteDomain({
        project,
        service: updated,
        runtimeName,
        usesManagedRouting: true,
      });
      const oldHostname = oldRoute?.hostname.toLowerCase();
      const nextHostname = nextRoute?.hostname.toLowerCase();

      if (wasRoutable && (!isRoutable || oldHostname !== nextHostname)) {
        if (oldRoute) {
          await routing.removeRoute(oldRoute.hostname);
        }
      }

      if (isRoutable && nextRoute && project.activeDeploymentId) {
        const rows = await repos.service.listByDeployment(project.activeDeploymentId);
        const row = rows.find((r) => r.serviceId === serviceId);
        if (row?.ip) {
          const port = updated.exposedPort || row.hostPort?.toString() || "80";
          await routing.registerRoute({
            domain: nextRoute.hostname,
            tls: true,
            targetUrl: `http://${row.ip}:${port}`,
          });
        }
      }
    } catch (err) {
      console.error(`[SERVICE] Failed to update route for ${svc.name}:`, err);
    }
  }

  return updated;
}

export async function deleteService(projectId: string, serviceId: string, userId: string) {
  const { project, svc } = await assertServiceAccess(projectId, serviceId, userId);

  if (project.activeDeploymentId) {
    const dep = await repos.deployment.findById(project.activeDeploymentId);
    const serviceDeployments = await repos.service.listByDeployment(project.activeDeploymentId);
    const serviceDeployment = serviceDeployments.find((row) => row.serviceId === serviceId);

    if (dep && serviceDeployment?.containerId) {
      const { runtime } = await resolveDeploymentRuntime(dep);
      await runtime.destroy(serviceDeployment.containerId).catch((err) => {
        console.error(
          `[SERVICE] Failed to destroy service container ${serviceDeployment.containerId}:`,
          err,
        );
      });
    }
  }

  if (svc.exposed) {
    try {
      const { routing, runtime } = platform();
      const route = buildServiceRouteDomain({
        project,
        service: svc,
        runtimeName: runtime.name,
        usesManagedRouting: true,
      });
      if (route) {
        await routing.removeRoute(route.hostname);
      }
    } catch (err) {
      console.error(`[SERVICE] Failed to remove route for ${svc.name}:`, err);
    }
  }

  await repos.service.remove(serviceId);
}

// ─── Service Environment Variables ───────────────────────────────────────────

export async function listServiceEnvVars(
  projectId: string,
  serviceId: string,
  userId: string,
  environment?: string,
) {
  await assertServiceAccess(projectId, serviceId, userId);

  const vars = await repos.project.listEnvVars(projectId, environment, serviceId);
  // Decrypt and mask secrets
  return vars.map((v) => ({
    ...v,
    value: v.isSecret ? "••••••••" : decrypt(v.value),
  }));
}

export async function setServiceEnvVars(
  projectId: string,
  serviceId: string,
  userId: string,
  data: TSetServiceEnvVarsBody,
) {
  await assertServiceAccess(projectId, serviceId, userId);

  // Encrypt values before storage
  const encrypted = data.vars.map((v) => ({
    key: v.key,
    value: encrypt(v.value),
    isSecret: v.isSecret,
  }));

  await repos.project.bulkSetEnvVars(projectId, data.environment, encrypted, serviceId);
  return { count: encrypted.length };
}

// ─── Compose Sync ────────────────────────────────────────────────────────────

export async function syncComposeServices(
  projectId: string,
  userId: string,
  parsed: {
    name: string;
    image?: string;
    build?: string;
    dockerfile?: string;
    ports?: string[];
    dependsOn?: string[];
    environment?: Record<string, string>;
    volumes?: string[];
    command?: string;
    restart?: string;
    exposed?: boolean;
    exposedPort?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }[],
) {
  await assertProjectAccess(projectId, userId);
  return repos.service.syncFromCompose(projectId, parsed);
}

// ─── Service Deployments (per-deployment state) ──────────────────────────────

export async function listServiceDeployments(deploymentId: string) {
  return repos.service.listByDeployment(deploymentId);
}

export async function getActiveServiceContainers(projectId: string, userId: string) {
  const project = await assertProjectAccess(projectId, userId);
  if (!project.activeDeploymentId) return [];
  return repos.service.listByDeployment(project.activeDeploymentId);
}

// ─── Per-service container actions ───────────────────────────────────────────

async function resolveServiceContainer(projectId: string, serviceId: string, userId: string) {
  const project = await assertProjectAccess(projectId, userId);
  if (!project.activeDeploymentId) throw new Error("No active deployment");

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep) throw new Error("Active deployment not found");

  const rows = await repos.service.listByDeployment(dep.id);
  const row = rows.find((r) => r.serviceId === serviceId);
  if (!row?.containerId) throw new Error("Service has no running container");

  const { runtime, serverId } = await resolveDeploymentRuntime(dep);
  return { runtime, containerId: row.containerId, serverId };
}

export async function startServiceContainer(projectId: string, serviceId: string, userId: string) {
  const { runtime, containerId } = await resolveServiceContainer(projectId, serviceId, userId);
  await runtime.start(containerId);
  return { containerId };
}

export async function stopServiceContainer(projectId: string, serviceId: string, userId: string) {
  const { runtime, containerId } = await resolveServiceContainer(projectId, serviceId, userId);
  await runtime.stop(containerId);
  return { containerId };
}

export async function restartServiceContainer(
  projectId: string,
  serviceId: string,
  userId: string,
) {
  const { runtime, containerId } = await resolveServiceContainer(projectId, serviceId, userId);
  await runtime.restart(containerId);
  return { containerId };
}

export async function getServiceRuntimeLogs(
  projectId: string,
  serviceId: string,
  userId: string,
  tail?: number,
) {
  const { runtime, containerId } = await resolveServiceContainer(projectId, serviceId, userId);
  return runtime.getRuntimeLogs(containerId, tail);
}

export async function streamServiceRuntimeLogs(
  projectId: string,
  serviceId: string,
  userId: string,
  onLog: (entry: LogEntry) => void,
  opts?: { tail?: number },
) {
  const { runtime, containerId, serverId } = await resolveServiceContainer(
    projectId,
    serviceId,
    userId,
  );
  const cleanup = await runtime.streamRuntimeLogs(containerId, onLog, opts);
  return { cleanup, serverId };
}
