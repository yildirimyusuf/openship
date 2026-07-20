import { api } from "./client";
import { endpoints } from "./endpoints";

// ─── Types (mirror apps/api docker-inspect.service.ts DiscoveredStack) ────────

export interface DiscoveredVolumeMount {
  type: "volume" | "bind";
  source?: string;
  target: string;
  rw: boolean;
}

export interface DiscoveredService {
  name: string;
  source: "compose" | "container";
  containerId?: string;
  containerName?: string;
  running: boolean;
  image?: string;
  build?: string;
  dockerfile?: string;
  ports: string[];
  env: Record<string, string>;
  volumes: DiscoveredVolumeMount[];
  networks: string[];
  dependsOn: string[];
  command?: string;
  restart?: string;
  warnings: string[];
}

export interface DiscoveredGroup {
  /** compose project name, or null for hand-run standalone containers. */
  project: string | null;
  services: DiscoveredService[];
}

export interface DiscoveredStack {
  serverId: string;
  composeProjects: string[];
  groups: DiscoveredGroup[];
  services: DiscoveredService[];
  volumes: Array<{ name: string; driver: string; inUseBy: string[] }>;
  networks: Array<{ name: string; driver: string }>;
  warnings: string[];
  adoptable: boolean;
  alreadyManaged: number;
}

export interface AdoptResult {
  success: boolean;
  projectId: string;
  slug: string;
  created: boolean;
  adopted: string[];
}

// ─── Full migration (adopt → move → deploy → verify → cutover) ────────────────

export interface MigrationPreviewService {
  name: string;
  source: "compose" | "container";
  image?: string;
  classification: "registry" | "build";
  blocked: boolean;
  reason?: string;
  volumes: Array<{ name: string; target: string }>;
  /** App-data bind paths that WILL be copied to the target. */
  bindMounts: string[];
  /** System/socket bind paths left on the source host. */
  bindMountsSkipped: string[];
  warnings: string[];
}

export interface MigrationPreview {
  sameServer: boolean;
  services: MigrationPreviewService[];
  volumesToMove: string[];
  hasBlocked: boolean;
  downtimeWarning: boolean;
  warnings: string[];
}

export type MigrationStatus =
  | "queued"
  | "adopting"
  | "moving_data"
  | "deploying"
  | "verifying"
  | "awaiting_cutover"
  | "cutover"
  | "succeeded"
  | "failed"
  | "rolled_back";

export interface MigrationRun {
  id: string;
  status: MigrationStatus;
  mode: "cross_server" | "same_server";
  projectId?: string | null;
  deploymentId?: string | null;
  bytesMoved?: number | null;
  errorMessage?: string | null;
}

/**
 * Docker migration API client — talks to /api/migration (self-hosted only).
 * Distinct from `migrationApi` (lib/api/migration.ts), which is the unrelated
 * team-instance/data migration.
 */
export const dockerMigrationApi = {
  /** Read-only: inspect a server's Docker and return the adoptable stack. */
  scan: (serverId: string) =>
    api.post<{ success: boolean; stack: DiscoveredStack }>(
      endpoints.dockerMigration.scan,
      { serverId },
    ),

  /** Create an Openship project from the selected discovered services (records only). */
  adopt: (input: { serverId: string; projectName: string; serviceNames: string[] }) =>
    api.post<AdoptResult>(endpoints.dockerMigration.adopt, input),

  /** Read-only preview of a full migration to a (possibly different) server. */
  preview: (input: {
    sourceServerId: string;
    targetServerId: string;
    serviceNames: string[];
  }) =>
    api.post<{ success: boolean; preview: MigrationPreview }>(
      endpoints.dockerMigration.preview,
      input,
    ),

  /** Start a full migration. Returns the run id + the cutover confirmation token. */
  migrate: (input: {
    sourceServerId: string;
    targetServerId: string;
    serviceNames: string[];
    projectName: string;
    killOriginals?: boolean;
    /** Same-server only: serviceName → "reuse" (take over in place) | "copy". */
    volumeStrategies?: Record<string, "reuse" | "copy">;
    /** Per-run override of the volume-transfer strategy (else the user's Settings default). */
    transferMode?: "auto" | "stream" | "direct" | "rsync";
    transferCompression?: "auto" | "zstd" | "gzip" | "none";
  }) =>
    api.post<{ success: boolean; migrationId: string; confirmationToken: string }>(
      endpoints.dockerMigration.migrate,
      input,
    ),

  /** Poll a migration run's current state. */
  getMigration: (id: string) =>
    api.get<{ success: boolean; run: MigrationRun }>(
      endpoints.dockerMigration.migration(id),
    ),

  /** Confirm (kill=true) or decline (kill=false) the destructive cutover. */
  confirmCutover: (id: string, confirmationToken: string, kill: boolean) =>
    api.post<{ success: boolean }>(endpoints.dockerMigration.cutover(id), {
      confirmationToken,
      kill,
    }),
};
