/**
 * Pre-deploy checks — validate prerequisites before the build pipeline starts.
 *
 * Called after the user clicks Deploy but BEFORE any build work begins.
 * If any check fails, the deployment is rejected with actionable errors —
 * no resources are provisioned, no build session started.
 *
 * Cloud checks are SaaS-owned:
 *   - SaaS mode calls the shared cloud preflight service directly
 *   - Desktop/local mode calls the SaaS preflight endpoint
 *   - Local/desktop never talks to Oblien directly for preflight
 */

import type { DeploymentConfigSnapshot } from "./build.service";
import { platform } from "../../lib/controller-helpers";
import { resolveServiceHostnameLabel } from "@repo/core";
import { getCloudPreflight } from "../../lib/cloud-client";
import { runCloudPreflight, type CloudPreflightData } from "../../lib/cloud-preflight";
import type { ComposeService } from "../../lib/compose-parser";
import { getRoutingBaseDomain } from "../../lib/routing-domains";
import { normalizeTargetPath } from "../../lib/public-endpoints";

export interface PreflightCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn";
  message?: string;
  code?: string;
}

export const PREFLIGHT_ERROR_CODES = {
  CLOUD_REQUIRED_TARGET: "CLOUD_REQUIRED_TARGET",
  CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN: "CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN",
  CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS: "CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS",
} as const;

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightOptions {
  customDomain?: string;
  slug?: string;
  userId?: string;
  publicEndpoints?: Array<{
    port?: number;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }>;
  composeServices?: ComposeService[];
  multiService?: boolean;
}

async function checkPublicEndpoints(
  snapshot: DeploymentConfigSnapshot,
  endpoints: NonNullable<PreflightOptions["publicEndpoints"]>,
  cloud: CloudPreflightData | null,
  userId?: string,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const seenHostnames = new Set<string>();
  const plat = platform();
  const effectiveTarget =
    plat.target === "desktop" ? (snapshot.deployTarget ?? "cloud") : plat.target;
  const isCloudStatic = effectiveTarget === "cloud" && !snapshot.hasServer;

  if (isCloudStatic) {
    const staticPathEndpoints = endpoints.filter((endpoint) => typeof endpoint.targetPath === "string");

    if (staticPathEndpoints.length > 1) {
      checks.push({
        id: "endpoint-static-cloud-shape",
        label: "Static endpoint routing",
        status: "fail",
        message: "Cloud static deployments currently support only one explicit path-targeted public endpoint.",
      });
    }
  }

  for (const endpoint of endpoints) {
    const normalizedTargetPath = normalizeTargetPath(endpoint.targetPath);
    const hasPortTarget = endpoint.port !== undefined;
    const hasPathTarget = Boolean(normalizedTargetPath);
    const endpointPort = endpoint.port;
    const destinationLabel = hasPathTarget
      ? normalizedTargetPath!
      : endpointPort != null
        ? String(endpointPort)
        : "unknown";

    if (hasPortTarget === hasPathTarget) {
      checks.push({
        id: `endpoint-target-${destinationLabel}`,
        label: `Endpoint target (${destinationLabel})`,
        status: "fail",
        message: "Each endpoint must target exactly one destination: either a port or a static path.",
      });
      continue;
    }

    if (hasPortTarget) {
      const port = endpointPort as number;

      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        checks.push({
          id: `endpoint-port-${destinationLabel}`,
          label: `Endpoint port (${destinationLabel})`,
          status: "fail",
          message: "Port must be between 1 and 65535.",
        });
      }
    }

    if (hasPathTarget && !normalizedTargetPath) {
      checks.push({
        id: `endpoint-path-${destinationLabel}`,
        label: `Endpoint path (${destinationLabel})`,
        status: "fail",
        message: "Static target paths must be rooted, normalized paths inside the build output.",
      });
    }

    if (hasPortTarget && !snapshot.hasServer) {
      checks.push({
        id: `endpoint-shape-${destinationLabel}`,
        label: `Endpoint target (${destinationLabel})`,
        status: "fail",
        message: "Static deployments cannot expose port-targeted routes. Use a static target path instead.",
      });
    }

    if (hasPathTarget && snapshot.hasServer) {
      checks.push({
        id: `endpoint-shape-${destinationLabel}`,
        label: `Endpoint target (${destinationLabel})`,
        status: "fail",
        message: "Server deployments must expose port-targeted routes. Static target paths are only valid for static deployments.",
      });
    }

    if (endpoint.domainType === "custom") {
      const hostname = endpoint.customDomain?.trim().toLowerCase();
      if (!hostname) {
        checks.push({
          id: `endpoint-domain-${destinationLabel}`,
          label: `Endpoint domain (${destinationLabel})`,
          status: "fail",
          message: "Custom endpoint domains cannot be empty.",
        });
        continue;
      }

      if (seenHostnames.has(hostname)) {
        checks.push({
          id: `endpoint-domain-${destinationLabel}`,
          label: `Endpoint domain (${destinationLabel})`,
          status: "fail",
          message: `Duplicate domain configured: ${hostname}`,
        });
        continue;
      }

      seenHostnames.add(hostname);
      const endpointCloud = cloud?.runtime.ok && userId
        ? await requestCloudPreflight(snapshot, userId, { customDomain: hostname })
        : cloud;
      const result = await checkCustomDomain(hostname, endpointCloud);
      checks.push({
        ...result,
        id: `endpoint-domain-${destinationLabel}`,
        label: `Endpoint domain (${destinationLabel})`,
      });
      continue;
    }

    const slug = endpoint.domain?.trim().toLowerCase();
    if (!slug) {
      checks.push({
        id: `endpoint-slug-${destinationLabel}`,
        label: `Endpoint subdomain (${destinationLabel})`,
        status: "fail",
        message: "Free endpoint subdomains cannot be empty.",
      });
      continue;
    }

    const slugCheck = checkSlugFormat(slug);
    checks.push({
      ...slugCheck,
      id: `endpoint-slug-${destinationLabel}`,
      label: `Endpoint subdomain (${destinationLabel})`,
    });

    const hostname = `${slug}.${getRoutingBaseDomain()}`;
    if (seenHostnames.has(hostname)) {
      checks.push({
        id: `endpoint-domain-${destinationLabel}`,
        label: `Endpoint domain (${destinationLabel})`,
        status: "fail",
        message: `Duplicate domain configured: ${hostname}`,
      });
      continue;
    }

    seenHostnames.add(hostname);

    if (cloud?.runtime.ok && userId) {
      const endpointCloud = await requestCloudPreflight(snapshot, userId, { slug });
      const availability = await checkSlug(slug, endpointCloud);
      checks.push({
        ...availability,
        id: `endpoint-slug-available-${destinationLabel}`,
        label: `Endpoint availability (${destinationLabel})`,
      });
    }
  }

  return checks;
}

async function checkComposeServiceDomains(
  composeServices: ComposeService[],
  projectSlug: string | undefined,
  cloud: CloudPreflightData | null,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const seen = new Set<string>();
  const baseDomain = getRoutingBaseDomain();

  for (const service of composeServices) {
    if (!service.exposed) continue;

    if (service.domainType === "custom" && service.customDomain?.trim()) {
      const domain = service.customDomain.trim().toLowerCase();
      if (seen.has(domain)) {
        checks.push({
          id: `service-domain-${service.name}`,
          label: `Service domain (${service.name})`,
          status: "fail",
          message: `Duplicate custom domain configured: ${domain}`,
        });
        continue;
      }
      seen.add(domain);

      const result = await checkCustomDomain(domain, cloud);
      checks.push({
        ...result,
        id: `service-domain-${service.name}`,
        label: `Service domain (${service.name})`,
      });
      continue;
    }

    const subdomain = resolveServiceHostnameLabel(
      projectSlug || "project",
      service.name,
      service.domain,
    );
    const fqdn = `${subdomain}.${baseDomain}`;

    // Free subdomains require cloud — fail early if not connected
    if (!cloud) {
      checks.push({
        id: `service-domain-${service.name}`,
        label: `Service subdomain (${service.name})`,
        status: "fail",
        code: PREFLIGHT_ERROR_CODES.CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS,
        message: `Free subdomain "${fqdn}" requires Openship Cloud. Connect your account or switch to a custom domain.`,
      });
      continue;
    }

    if (seen.has(fqdn)) {
      checks.push({
        id: `service-domain-${service.name}`,
        label: `Service domain (${service.name})`,
        status: "fail",
        message: `Duplicate service subdomain configured: ${subdomain}`,
      });
      continue;
    }
    seen.add(fqdn);

    const result = checkSlugFormat(subdomain);
    checks.push({
      ...result,
      id: `service-domain-${service.name}`,
      label: `Service subdomain (${service.name})`,
    });
  }

  return checks;
}

async function requestCloudPreflight(
  snapshot: DeploymentConfigSnapshot,
  userId: string,
  input: { slug?: string; customDomain?: string },
): Promise<CloudPreflightData | null> {
  const plat = platform();
  const effectiveTarget =
    plat.target === "desktop" ? (snapshot.deployTarget ?? "cloud") : plat.target;

  if (plat.target === "cloud") {
    return runCloudPreflight(userId, input);
  }

  if (effectiveTarget === "cloud" || plat.target === "desktop") {
    return getCloudPreflight(userId, input);
  }

  return null;
}

async function resolveCloudPreflight(
  snapshot: DeploymentConfigSnapshot,
  opts?: PreflightOptions,
): Promise<CloudPreflightData | null> {
  const plat = platform();
  const effectiveTarget =
    plat.target === "desktop" ? (snapshot.deployTarget ?? "cloud") : plat.target;

  const usesManagedRouting =
    plat.target === "desktop" && (effectiveTarget === "server" || effectiveTarget === "local");
  const hasManagedPublicEndpoints =
    opts?.publicEndpoints?.some((endpoint) => endpoint.domainType !== "custom") ?? false;
  const needsManagedProjectDomain =
    (!!opts?.slug && !opts?.customDomain && usesManagedRouting) ||
    (usesManagedRouting && hasManagedPublicEndpoints);
  const needsManagedComposeDomains =
    opts?.composeServices?.some((service) => service.exposed && service.domainType !== "custom") ??
    false;
  const needsCloudPreflight =
    effectiveTarget === "cloud" || needsManagedProjectDomain || needsManagedComposeDomains;
  const requestInput = opts?.publicEndpoints?.length
    ? {}
    : {
        slug: opts?.slug,
        customDomain: opts?.customDomain,
      };

  if (!needsCloudPreflight || !opts?.userId) {
    return null;
  }

  return requestCloudPreflight(snapshot, opts.userId, requestInput);
}

function checkConfig(snapshot: DeploymentConfigSnapshot, opts?: PreflightOptions): PreflightCheck {
  const missing: string[] = [];

  if (!snapshot.repoUrl && !snapshot.localPath) missing.push("repository URL or local path");
  if (!snapshot.branch && !snapshot.localPath) missing.push("branch");

  if (opts?.multiService) {
    if (missing.length > 0) {
      return {
        id: "config",
        label: "Service configuration",
        status: "fail",
        message: `Missing required fields: ${missing.join(", ")}`,
      };
    }

    return { id: "config", label: "Service configuration", status: "pass" };
  }

  if (!snapshot.buildImage) missing.push("build image");

  if (snapshot.hasBuild && !snapshot.installCommand) {
    missing.push("install command");
  }

  if (snapshot.hasServer) {
    if (!snapshot.startCommand) missing.push("start command");
    if (!snapshot.port) missing.push("port");
  }

  if (missing.length > 0) {
    return {
      id: "config",
      label: "Build configuration",
      status: "fail",
      message: `Missing required fields: ${missing.join(", ")}`,
    };
  }

  return { id: "config", label: "Build configuration", status: "pass" };
}

function checkStack(snapshot: DeploymentConfigSnapshot): PreflightCheck {
  if (!snapshot.hasServer && snapshot.startCommand) {
    return {
      id: "stack",
      label: "Stack configuration",
      status: "warn",
      message:
        "Static site has a start command configured - it will be ignored. Files will be served from the edge.",
    };
  }

  if (snapshot.hasBuild && !snapshot.buildCommand) {
    return {
      id: "stack",
      label: "Stack configuration",
      status: "warn",
      message:
        "Build is enabled but no build command configured - deployment will use source files directly.",
    };
  }

  if (!snapshot.hasBuild && snapshot.buildCommand) {
    return {
      id: "stack",
      label: "Stack configuration",
      status: "warn",
      message: "Build is disabled but a build command exists - it will be skipped.",
    };
  }

  return { id: "stack", label: "Stack configuration", status: "pass" };
}

function checkSlugFormat(slug: string): PreflightCheck {
  if (slug.length < 1 || slug.length > 63) {
    return {
      id: "slug",
      label: "Subdomain",
      status: "fail",
      message: `Slug must be between 1 and 63 characters (got ${slug.length}).`,
    };
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return {
      id: "slug",
      label: "Subdomain",
      status: "fail",
      message: `"${slug}" is not a valid subdomain. Use only lowercase letters, numbers, and hyphens. Must start and end with a letter or number.`,
    };
  }

  return { id: "slug", label: "Subdomain", status: "pass" };
}

async function checkSlug(slug: string, cloud: CloudPreflightData | null): Promise<PreflightCheck> {
  const fqdn = `${slug}.${getRoutingBaseDomain()}`;

  if (!cloud) {
    return { id: "slug-available", label: "Subdomain availability", status: "pass" };
  }

  if (!cloud.runtime.ok) {
    return {
      id: "slug-available",
      label: "Subdomain availability",
      status: "warn",
      message: "Could not verify subdomain availability",
    };
  }

  if (cloud.slug?.available === false) {
    return {
      id: "slug-available",
      label: "Subdomain availability",
      status: "fail",
      message: cloud.slug.message ?? `"${fqdn}" is already taken. Choose a different subdomain.`,
    };
  }

  if (cloud.slug?.message) {
    return {
      id: "slug-available",
      label: "Subdomain availability",
      status: "warn",
      message: cloud.slug.message,
    };
  }

  return { id: "slug-available", label: "Subdomain availability", status: "pass" };
}

async function checkCustomDomain(
  customDomain: string,
  cloud: CloudPreflightData | null,
): Promise<PreflightCheck> {
  if (cloud?.runtime.ok && cloud.customDomain) {
    if (cloud.customDomain.verified) {
      if (cloud.customDomain.message) {
        return {
          id: "domain",
          label: "Domain DNS",
          status: "warn",
          message: cloud.customDomain.message,
        };
      }
      return { id: "domain", label: "Domain DNS", status: "pass" };
    }

    return {
      id: "domain",
      label: "Domain DNS",
      status: "fail",
      message: cloud.customDomain.message ?? `DNS not configured for ${customDomain}`,
    };
  }

  try {
    const dns = await import("node:dns/promises");
    const records = await dns.resolveCname(customDomain);
    const pointsToEdge = records.some((record) => record.toLowerCase() === "edge.openship.io");

    if (pointsToEdge) {
      return { id: "domain", label: "Domain DNS", status: "pass" };
    }

    return {
      id: "domain",
      label: "Domain DNS",
      status: "fail",
      message: `CNAME for ${customDomain} does not point to edge.openship.io. Current target: ${records.join(", ") || "none"}`,
    };
  } catch {
    return {
      id: "domain",
      label: "Domain DNS",
      status: "fail",
      message: `No CNAME record found for ${customDomain}. Add a CNAME record pointing to edge.openship.io`,
    };
  }
}

async function checkCloudRuntime(
  cloud: CloudPreflightData | null,
  requirement: "none" | "cloud-runtime" | "managed-project-domain" | "managed-compose-domains",
): Promise<PreflightCheck> {
  if (requirement === "none") {
    return { id: "runtime", label: "Runtime", status: "pass" };
  }

  if (!cloud) {
    if (requirement === "managed-project-domain") {
      return {
        id: "runtime",
        label: "Free domain routing",
        status: "fail",
        code: PREFLIGHT_ERROR_CODES.CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN,
        message: `Free .${getRoutingBaseDomain()} domains require Openship Cloud for routing. To deploy to your own server, either connect Openship Cloud or switch this project to a custom domain.`,
      };
    }

    if (requirement === "managed-compose-domains") {
      return {
        id: "runtime",
        label: "Free domain routing",
        status: "fail",
        code: PREFLIGHT_ERROR_CODES.CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS,
        message: `One or more exposed services use free .${getRoutingBaseDomain()} domains. Connect Openship Cloud or switch those services to custom domains before deploying to your own server.`,
      };
    }

    return {
      id: "runtime",
      label: "Openship Cloud",
      status: "fail",
      code: PREFLIGHT_ERROR_CODES.CLOUD_REQUIRED_TARGET,
      message:
        "This deployment target runs on Openship Cloud, but no cloud account is connected. Connect your account first.",
    };
  }

  if (cloud.runtime.ok) {
    return {
      id: "runtime",
      label: requirement === "cloud-runtime" ? "Openship Cloud" : "Free domain routing",
      status: "pass",
    };
  }

  return {
    id: "runtime",
    label: requirement === "cloud-runtime" ? "Openship Cloud" : "Free domain routing",
    status: "fail",
    message: cloud.runtime.message,
  };
}

export async function runPreflightChecks(
  snapshot: DeploymentConfigSnapshot,
  opts?: PreflightOptions,
): Promise<PreflightResult> {
  const cloudPreflight = await resolveCloudPreflight(snapshot, opts);

  // Determine whether this deployment requires cloud directly or via managed routing
  const plat = platform();
  const effectiveTarget =
    plat.target === "desktop" ? (snapshot.deployTarget ?? "cloud") : plat.target;
  const usesManagedRouting =
    plat.target === "desktop" && (effectiveTarget === "server" || effectiveTarget === "local");
  const hasEndpointRouting = !!opts?.publicEndpoints?.length;
  const hasManagedProjectDomain =
    !hasEndpointRouting && !!opts?.slug && !opts?.customDomain && usesManagedRouting;
  const hasManagedPublicEndpoints =
    opts?.publicEndpoints?.some((endpoint) => endpoint.domainType !== "custom") ?? false;
  const hasManagedComposeDomains =
    opts?.composeServices?.some((service) => service.exposed && service.domainType !== "custom") ??
    false;
  const cloudRequirement =
    effectiveTarget === "cloud"
      ? "cloud-runtime"
      : hasManagedProjectDomain || hasManagedPublicEndpoints
        ? "managed-project-domain"
        : hasManagedComposeDomains
          ? "managed-compose-domains"
          : "none";

  const checks: PreflightCheck[] = [
    checkConfig(snapshot, opts),
    opts?.multiService
      ? { id: "stack", label: "Service stack", status: "pass" }
      : checkStack(snapshot),
  ];

  if (!hasEndpointRouting && opts?.slug && !opts?.customDomain) {
    checks.push(checkSlugFormat(opts.slug));
    checks.push(await checkSlug(opts.slug, cloudPreflight));
  }

  checks.push(await checkCloudRuntime(cloudPreflight, cloudRequirement));

  if (!hasEndpointRouting && opts?.customDomain) {
    checks.push(await checkCustomDomain(opts.customDomain, cloudPreflight));
  }

  if (opts?.composeServices?.length) {
    checks.push(
      ...(await checkComposeServiceDomains(opts.composeServices, opts.slug, cloudPreflight)),
    );
  }

  if (opts?.publicEndpoints?.length) {
    checks.push(...(await checkPublicEndpoints(snapshot, opts.publicEndpoints, cloudPreflight, opts.userId)));
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}
