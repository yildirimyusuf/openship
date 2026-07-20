/**
 * System layer barrel exports.
 */

export type {
  EnvironmentProfile,
  LinuxDistro,
  SystemArch,
  SystemOs,
  SystemPackageManager,
  SystemServiceManager,
} from "./environment";
export { resolveEnvironment } from "./environment";

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  ComponentStatus,
  EdgeClassification,
  EdgeOccupant,
  EdgePolicy,
  EdgeStatus,
  EdgeStopTarget,
  Feature,
  FeatureReadiness,
  InstallerConfig,
  InstallResult,
  PrerequisiteRule,
  ProxyKind,
  RuntimeMode,
  SetupResult,
  SystemCheckResult,
  SystemLog,
  SystemLogCallback,
} from "./types";

// ─── Edge preflight + takeover ──────────────────────────────────────────────────
export {
  EdgeConflictError,
  EdgeMigrateRequested,
  freeEdgeTargets,
  probeEdge,
  stopTargetsForStatus,
} from "./edge-preflight";
export type { ImportedSite, ProxyScanResult } from "./types";
export { scanImportableSites, canImportProxy } from "./proxy-import";
export {
  runEdgeTakeover,
  recoverInterruptedTakeover,
  type EdgeTakeoverOptions,
  type EdgeTakeoverResult,
} from "./edge-takeover";

// ─── State ───────────────────────────────────────────────────────────────────
export type { SetupState, SetupStateStore, ComponentState } from "./state";
export { FileStateStore } from "./state";

// ─── Executor ────────────────────────────────────────────────────────────────
export { LocalExecutor, SshExecutor, SystemSshExecutor, createExecutor } from "./executor";

// ─── Checks ──────────────────────────────────────────────────────────────────
export {
  checkAll,
  checkComponents,
  checkCertbot,
  checkDocker,
  checkGit,
  checkOpenResty,
  checkRsync,
  COMPONENT_CHECKS,
} from "./checks";

// ─── Installers ───────────────────────────────────────────────────────────────
export {
  COMPONENT_INSTALLERS,
  COMPONENT_UNINSTALLERS,
  getRemovalSupport,
  installCertbot,
  installDocker,
  installGit,
  installOpenResty,
  installRsync,
  uninstallCertbot,
  uninstallOpenResty,
  uninstallRsync,
} from "./installer";

// ─── Manager ─────────────────────────────────────────────────────────────────
export { SystemManager, type SystemManagerOptions } from "./setup";
