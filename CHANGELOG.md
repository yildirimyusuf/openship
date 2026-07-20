# Changelog

All notable changes to Openship. Versions follow [semver](https://semver.org);
the in-app updater surfaces critical advisories from `release-advisories.json`.

## 0.2.0

A large feature + hardening release across the deploy flow, the app catalog,
routing, servers, jobs, and the build toolchain.

### Deploy
- Redesigned **"Where do you want to deploy?"** step: unified page-style header
  with the **Continue** action aligned to the config column, and a **collapsed,
  searchable server picker** (with an inline "Add your own server").
- **Package-manager toolchain fix** — pnpm/yarn are now enabled via `corepack`
  across every build path (cloud, generated Dockerfile, bare host, monorepo
  workspace-prepare, cloud local-build). Fixes `pnpm: not found` on deploy.

### Apps
- **Searchable, category-tabbed one-click app catalog**, expanded to 15
  production-ready self-hosted apps: Convex, n8n, Ghost, Directus, NocoDB,
  Metabase, Grafana, Gitea, code-server, Uptime Kuma, Vaultwarden, FreshRSS,
  Stirling PDF, IT-Tools, Excalidraw.
- Home "Apps" card refreshed; catalog cards show real brand logos.

### Routing & domains (single source of truth)
- Custom domains on **service-based projects** now flow through the same
  verify → DNS-records → SSL pipe as single-app domains: a verifiable pending
  row is minted on add/create/edit, one canonical hostname normalizer is shared
  across storage/routing/domain-service, lookups are cross-tenant-safe, and
  certbot is gated on verification (no wasted Let's Encrypt attempts).

### Servers
- Redesigned servers page (tabs, live reachability, country flags).
- Per-server **Git** auth tab (token / SSH key / deploy keys) with a
  comfortable full-width card; connect-on-server credentials honored in preflight.

### Jobs
- Jobs page gains **search** + an at-a-glance **status filter sidebar**
  (running / failed / scheduled / disabled), shown once custom jobs exist.

### Team & workspace
- **Invite member** is only offered where it works (team orgs on a multi-user
  instance); single-user/personal instances are guided to migrate or create a
  team org instead of hitting a dead end.

### Add service
- The **Openship Cloud** image tab shows a "Connect to Openship Cloud" CTA when
  the instance isn't linked, and the source switcher has clearer contrast.

### Other
- Docker migration flow, per-project/service backups, unified connectivity
  checks, Arabic (RTL) localization, marketing roadmap page, and desktop window
  polish (macOS traffic-light inset).

> The list above is the highlights — trim/adjust before tagging.
