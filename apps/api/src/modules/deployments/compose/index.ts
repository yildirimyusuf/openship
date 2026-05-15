/**
 * Compose pipeline — barrel exports.
 *
 * Entry point for all compose-specific deployment logic.
 * The shared deployment infrastructure (lifecycle hooks, session manager,
 * build config factory, preflight checks) lives one level up.
 */

// Pipeline orchestrator
export { executeComposePipeline, type ComposePipelineOpts } from "./pipeline";

// Build phase
export { buildComposeImages, type ComposeBuildImagesResult } from "./build.service";

// Deploy phase
export { deployComposeServices, type ComposeDeployResult } from "./deploy.service";

// Project service-shape helpers
export {
  isLegacyComposeProject,
  listProjectServices,
  projectServicesToComposeServices,
  resolveProjectServicePreflightServices,
  shouldUseProjectServicePipeline,
} from "./project-services";

// Shared helpers
export { normalizeSubdomain, defaultServiceSubdomain, parseServicePort } from "./domain-helpers";
