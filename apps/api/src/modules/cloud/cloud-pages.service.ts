/**
 * Cloud pages service — create / enable / disable / delete Oblien pages.
 *
 * Auth model: **namespace token is the authorization**. Mint a
 * namespace-scoped token for the caller's org, hand it to Oblien, let
 * Oblien gate by namespace. No SaaS-side ownership ledger, no
 * verify-then-dispatch dance.
 *
 * ─── Required Oblien behavior (track upstream) ──────────────────────────
 *
 *   Right now Oblien rejects `pages.delete/disable/enable` from
 *   namespace tokens with `scope: namespace, required: admin`. That's
 *   backwards: a namespace token should be the canonical authorization
 *   for namespace-scoped resources. Admin scope should only be required
 *   for cross-namespace or namespace-lifecycle operations.
 *
 *   Required upstream:
 *     - `pages.delete(slug)` with a namespace token MUST succeed when
 *       the page belongs to the namespace, 403 otherwise.
 *     - Same for `pages.disable(slug)` and `pages.enable(slug)`.
 *
 *   Once Oblien fixes this, this whole file collapses to ~30 lines of
 *   thin pass-through. No master client. No namespace-membership probe.
 */

import { getNamespaceClient } from "../../lib/openship-cloud";

export async function createCloudPage(
  organizationId: string,
  input: { workspace_id: string; path: string; name: string; slug: string; domain?: string },
): Promise<unknown> {
  const { client, namespace } = await getNamespaceClient(organizationId);
  // namespace is passed explicitly so Oblien validates the resource
  // belongs to this namespace (defense in depth — the token already
  // scopes to it, but the param lets Oblien reject mismatch upfront).
  return await client.pages.create({
    workspace_id: input.workspace_id,
    path: input.path,
    name: input.name,
    slug: input.slug,
    namespace,
    ...(input.domain ? { domain: input.domain } : {}),
  });
}

export type CloudPageAction = "disable" | "enable" | "delete";

export async function dispatchCloudPageAction(
  organizationId: string,
  slug: string,
  action: CloudPageAction,
): Promise<{ ok: true } | { ok: false; status: 403; error: string }> {
  // disable/enable/delete don't accept a `namespace` param on the SDK
  // — they identify the page by slug. The namespace-scoped token is
  // the only gate; Oblien rejects with 403/404 if the slug belongs
  // to another namespace (caught by isCrossTenantError below).
  const { client } = await getNamespaceClient(organizationId);
  try {
    switch (action) {
      case "disable":
        await client.pages.disable(slug);
        break;
      case "enable":
        await client.pages.enable(slug);
        break;
      case "delete":
        await client.pages.delete(slug);
        break;
    }
    return { ok: true };
  } catch (err) {
    if (isCrossTenantError(err)) {
      return { ok: false, status: 403, error: "Page does not belong to your namespace" };
    }
    throw err;
  }
}

function isCrossTenantError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: number }).status;
  if (status === 403 || status === 404) return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("not found") ||
    msg.includes("does not have access") ||
    msg.includes("does not belong")
  );
}
