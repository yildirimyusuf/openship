import { api } from "./client";
import { endpoints } from "./endpoints";

/** One catalog entry as returned by GET /apps/catalog. */
export interface AppCatalogField {
  key: string;
  service: string;
  label: string;
  help?: string;
  type: "text" | "password";
  default?: string;
  required: boolean;
}

export interface AppCatalogEntry {
  id: string;
  name: string;
  description: string;
  kind: "template" | "flow";
  logo: string;
  category: string;
  tags: string[];
  flowHref?: string;
  configFields: AppCatalogField[];
}

export type InstallAppResult =
  | { kind: "flow"; flowHref: string }
  | { kind: "template"; projectId: string; slug: string };

export const appsApi = {
  /** The installable app catalog. */
  catalog: () => api.get<{ data: AppCatalogEntry[] }>(endpoints.apps.catalog),

  /** Install an app from the catalog. Template apps return the new project;
   *  flow apps return the wizard route to hand off to. */
  install: (body: { templateId: string; name?: string; config?: Record<string, string> }) =>
    api.post<{ data: InstallAppResult }>(endpoints.apps.install, body),
};
