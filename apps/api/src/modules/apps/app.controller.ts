/**
 * Apps controller — the one-click app catalog + installer.
 */

import type { Context } from "hono";
import { getRequestContext } from "../../lib/request-context";
import { getAppCatalog, installApp } from "./app-install.service";

/** GET /api/apps/catalog — the installable app catalog for the Create-App UI. */
export async function catalog(c: Context) {
  return c.json({ data: getAppCatalog() });
}

/** POST /api/apps — install an app from the catalog. */
export async function install(c: Context) {
  const ctx = getRequestContext(c);
  type InstallBody = { templateId?: string; name?: string; config?: Record<string, string> };
  const body = await c.req.json<InstallBody>().catch((): InstallBody => ({}));
  if (!body.templateId) {
    return c.json({ error: "templateId is required" }, 400);
  }
  try {
    const result = await installApp(ctx, {
      templateId: body.templateId,
      name: body.name,
      config: body.config,
    });
    return c.json({ data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to install app";
    return c.json({ error: message }, 400);
  }
}
