import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      update: vi.fn(),
      updateSsl: vi.fn(),
      findOrCreate: vi.fn(),
    },
  },
}));

import {
  buildProjectRouteDomains,
  buildServiceRouteDomain,
  getRoutingBaseDomain,
} from "../../src/lib/routing-domains";

describe("buildProjectRouteDomains", () => {
  it("uses public endpoints as the only app routing source when they are provided", () => {
    const planned = buildProjectRouteDomains({
      project: { slug: "my-app" } as any,
      projectDomains: [{ hostname: "stale.example.com", verified: true } as any],
      customDomain: "legacy.example.com",
      managedSlug: "my-app",
      publicEndpoints: [
        { port: 3000, domain: "my-app", domainType: "free" },
        { port: 4000, customDomain: "admin.example.com", domainType: "custom" },
      ],
      runtimeName: "bare",
      usesManagedRouting: true,
    });

    expect(planned.map((domain) => domain.hostname)).toEqual([
      `my-app.${getRoutingBaseDomain()}`,
      "admin.example.com",
    ]);
    expect(planned.find((domain) => domain.hostname === `my-app.${getRoutingBaseDomain()}`)?.targetPort).toBe(3000);
    expect(planned.find((domain) => domain.hostname === "admin.example.com")?.targetPort).toBe(4000);
  });

  it("keeps static path targets on planned routes", () => {
    const planned = buildProjectRouteDomains({
      project: { slug: "docs" } as any,
      projectDomains: [],
      managedSlug: "docs",
      publicEndpoints: [
        { targetPath: "/docs", domain: "docs", domainType: "free" },
      ],
      runtimeName: "bare",
      usesManagedRouting: true,
    });

    expect(planned).toEqual([
      expect.objectContaining({
        hostname: `docs.${getRoutingBaseDomain()}`,
        targetPath: "/docs",
        domainType: "free",
      }),
    ]);
  });

  it("keeps service route target ports on the planned route", () => {
    const planned = buildServiceRouteDomain({
      project: { slug: "my-app", name: "My App" } as any,
      service: {
        id: "svc_web",
        name: "web",
        exposed: true,
        exposedPort: "8080",
        customDomain: "api.example.com",
        domainType: "custom",
      } as any,
      runtimeName: "bare",
      usesManagedRouting: true,
    });

    expect(planned?.hostname).toBe("api.example.com");
    expect(planned?.targetPort).toBe(8080);
    expect(planned?.domainType).toBe("custom");
  });
});