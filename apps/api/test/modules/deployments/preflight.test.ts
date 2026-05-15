import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCloudPreflight, runCloudPreflight } = vi.hoisted(() => ({
  getCloudPreflight: vi.fn(),
  runCloudPreflight: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {},
}));

vi.mock("../../../src/lib/controller-helpers", () => ({
  platform: () => ({ target: "desktop" }),
}));

vi.mock("../../../src/lib/cloud-client", () => ({
  getCloudPreflight,
}));

vi.mock("../../../src/lib/cloud-preflight", () => ({
  runCloudPreflight,
}));

import { runPreflightChecks } from "../../../src/modules/deployments/preflight";

describe("runPreflightChecks", () => {
  beforeEach(() => {
    runCloudPreflight.mockReset();
    getCloudPreflight.mockReset();
    getCloudPreflight.mockImplementation(async (_userId: string, input: { slug?: string }) => ({
      runtime: { ok: true },
      slug: input.slug
        ? {
            available: input.slug !== "taken-endpoint",
            message: input.slug === "taken-endpoint"
              ? "\"taken-endpoint.openship.test\" is already taken. Choose a different subdomain."
              : undefined,
          }
        : undefined,
    }));
  });

  it("checks free-domain availability for every public endpoint", async () => {
    const result = await runPreflightChecks({
      repoUrl: "https://github.com/acme/app.git",
      branch: "main",
      buildImage: "node:22",
      installCommand: "npm install",
      buildCommand: "npm run build",
      startCommand: "npm start",
      port: 3000,
      hasBuild: true,
      hasServer: true,
      deployTarget: "server",
    } as any, {
      userId: "user-1",
      publicEndpoints: [
        { port: 3000, domain: "taken-endpoint", domainType: "free" },
        { port: 4000, domain: "ok-endpoint", domainType: "free" },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "endpoint-slug-available-3000",
          status: "fail",
        }),
        expect.objectContaining({
          id: "endpoint-slug-available-4000",
          status: "pass",
        }),
      ]),
    );
    expect(
      getCloudPreflight.mock.calls.some(([, input]) => input && input.slug === "taken-endpoint"),
    ).toBe(true);
    expect(
      getCloudPreflight.mock.calls.some(([, input]) => input && input.slug === "ok-endpoint"),
    ).toBe(true);
  });

  it("accepts static path-targeted public endpoints", async () => {
    const result = await runPreflightChecks({
      repoUrl: "https://github.com/acme/docs.git",
      branch: "main",
      buildImage: "node:22",
      installCommand: "npm install",
      buildCommand: "npm run build",
      startCommand: "",
      port: 3000,
      hasBuild: true,
      hasServer: false,
      deployTarget: "cloud",
    } as any, {
      userId: "user-1",
      publicEndpoints: [
        { targetPath: "/docs", domain: "docs-site", domainType: "free" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.checks.some((check) => check.status === "fail")).toBe(false);
  });
});