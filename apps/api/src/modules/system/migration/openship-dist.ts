/**
 * Resolves the path to the pre-built Openship release dist that the
 * migration wizard streams to the operator's remote server.
 *
 * Mirrors the webmail pattern (apps/email/scripts/build-release.ts
 * produces apps/email/dist/, resolveWebmailDistDir() finds it).
 *
 * Expected layout (produced by the future apps/api/scripts/build-release.ts):
 *
 *   <repoRoot>/apps/api/release-dist/
 *     package.json        ← release orchestration / start script
 *     api/                ← API source (bun runs TS directly)
 *     dashboard/          ← pre-built Next standalone output
 *     start.ts            ← starts both processes
 *
 * The build script is INTENTIONALLY not part of this module — it's
 * a separate piece of work. This file just locates the artifact.
 * Until the build script lands, every call here fails fast with a
 * clear "run the release build first" message, which is the same
 * fail-fast contract webmail has.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = (() => {
  try {
    return resolve(fileURLToPath(import.meta.url), "..");
  } catch {
    // CJS fallback (tests, scripts) — walk back up from cwd.
    return resolve(process.cwd(), "apps/api/src/modules/system/migration");
  }
})();

/**
 * Compute the canonical release-dist path. Override with
 * OPENSHIP_RELEASE_DIST_PATH for non-standard layouts (Docker images,
 * custom CI bundles).
 */
function computeDistPath(): string {
  const override = process.env.OPENSHIP_RELEASE_DIST_PATH;
  if (override) return resolve(override);

  // apps/api/src/modules/system/migration/ → up to apps/api/ → release-dist/
  return resolve(__dirname, "../../../../release-dist");
}

export class OpenshipReleaseDistMissingError extends Error {
  readonly code = "OPENSHIP_RELEASE_DIST_MISSING" as const;
  constructor(distPath: string) {
    super(
      `Openship release dist not found at ${distPath}. ` +
        `Build it first with \`bun run --cwd apps/api build-release\`, ` +
        `or set OPENSHIP_RELEASE_DIST_PATH to point at an existing bundle.`,
    );
    this.name = "OpenshipReleaseDistMissingError";
  }
}

/**
 * Locate the release dist, throwing a typed error when missing so the
 * controller can surface a clean 412 (precondition failed) to the
 * wizard instead of an opaque 500.
 */
export function resolveOpenshipDistDir(): string {
  const path = computeDistPath();
  if (!existsSync(path)) {
    throw new OpenshipReleaseDistMissingError(path);
  }
  return path;
}

/**
 * Non-throwing variant for the preflight endpoint — used to surface
 * "release dist missing" as a structured precondition the operator
 * can fix before clicking Deploy. Returns null when missing.
 */
export function resolveOpenshipDistDirOrNull(): string | null {
  const path = computeDistPath();
  return existsSync(path) ? path : null;
}
