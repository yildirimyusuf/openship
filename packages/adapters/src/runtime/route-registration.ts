import { DeployError } from "@repo/core";
import { posix as pathPosix } from "node:path";

import type { RouteConfig } from "../types";
import type { BuildLogger } from "./build-pipeline";
import type { DeployRouting, DeploySsl } from "./deploy-pipeline";

export interface RoutedDomainInput {
  hostname: string;
  tls: boolean;
  provisionSsl?: boolean;
  targetPort?: number;
  targetPath?: string;
}

export interface RouteRegistrationOptions {
  /** If set, the domain matching this hostname gets a /_openship/hooks/ location */
  webhookDomain?: string | null;
  /** The proxy target for webhook requests (e.g. http://127.0.0.1:4000/api/webhooks/) */
  webhookProxy?: string;
}

export async function registerResolvedRoutes(
  logger: BuildLogger,
  routing: DeployRouting | undefined,
  ssl: DeploySsl | undefined,
  domains: RoutedDomainInput[],
  routeTarget: Omit<RouteConfig, "domain" | "tls"> | null,
  routeTargetsByPort?: Map<number, Omit<RouteConfig, "domain" | "tls">>,
  options?: RouteRegistrationOptions,
): Promise<void> {
  if (!routing || domains.length === 0) {
    if (domains.length === 0) {
      logger.log("No domains configured — skipping routing for this deployment.\n", "warn");
    }
    return;
  }

  if (!routeTarget) {
    return;
  }

  for (const domain of domains) {
    logger.log(`Registering route for ${domain.hostname}...\n`);

    let routeConfig: RouteConfig;
    const hasPortTarget = domain.targetPort !== undefined;
    const hasPathTarget = typeof domain.targetPath === "string";

    if (hasPortTarget === hasPathTarget) {
      throw new DeployError(
        `Route ${domain.hostname} must target exactly one destination`,
        "INVALID_ROUTE_TARGET",
      );
    }

    const resolvedRouteTarget =
      domain.targetPort !== undefined
        ? routeTargetsByPort?.get(domain.targetPort) ?? routeTarget
        : routeTarget;
    const targetUrl = (resolvedRouteTarget as { targetUrl?: string }).targetUrl;
    const staticRoot = (resolvedRouteTarget as { staticRoot?: string }).staticRoot;

    if (hasPortTarget && typeof targetUrl === "string") {
      routeConfig = { domain: domain.hostname, tls: domain.tls, targetUrl };
    } else if (hasPathTarget && typeof staticRoot === "string") {
      const targetPath = domain.targetPath!;
      routeConfig = {
        domain: domain.hostname,
        tls: domain.tls,
        staticRoot: targetPath === "/"
          ? staticRoot
          : pathPosix.join(staticRoot, targetPath.slice(1)),
      };
    } else {
      throw new DeployError("Resolved route target is invalid", "INVALID_ROUTE_TARGET");
    }

    // Add webhook proxy location if this domain is the project's webhook domain
    if (options?.webhookDomain && domain.hostname === options.webhookDomain && options.webhookProxy) {
      routeConfig.webhookProxy = options.webhookProxy;
    }

    await routing.registerRoute(routeConfig);

    if (domain.provisionSsl && ssl) {
      logger.log(`Checking SSL for ${domain.hostname}...\n`);
      await ssl.provisionCert(domain.hostname);
    }
  }
}