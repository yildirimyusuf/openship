import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      listByProject: vi.fn(),
    },
  },
}));

import { deriveEnvironmentPublicEndpoints } from "../../../src/modules/domains/project-route.service";

describe("deriveEnvironmentPublicEndpoints", () => {
  it("clones an explicit proxy target without inventing a fallback port", () => {
    expect(
      deriveEnvironmentPublicEndpoints(
        [{ port: 4010 }],
        "preview-app",
      ),
    ).toEqual([
      { port: 4010, domain: "preview-app", domainType: "free" },
    ]);
  });

  it("clones an explicit static path target without inventing a port", () => {
    expect(
      deriveEnvironmentPublicEndpoints(
        [{ targetPath: "/docs" }],
        "preview-docs",
      ),
    ).toEqual([
      { targetPath: "/docs", domain: "preview-docs", domainType: "free" },
    ]);
  });

  it("returns no endpoints when the base project has no explicit destination", () => {
    expect(deriveEnvironmentPublicEndpoints([], "preview-app")).toEqual([]);
  });
});