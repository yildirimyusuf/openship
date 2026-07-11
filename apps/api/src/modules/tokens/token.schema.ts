import { Type, type Static } from "@sinclair/typebox";

const TokenGrant = Type.Object({
  resourceType: Type.String(),
  resourceId: Type.String(),
  permissions: Type.Array(
    Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("admin")]),
  ),
});

export const CreateTokenBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  /** Read-only tokens reject mutation methods (POST/PUT/PATCH/DELETE). */
  readOnly: Type.Optional(Type.Boolean()),
  /** Optional expiry, in days from now (1–365). Omit for a non-expiring token. */
  expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  /**
   * Optional resource scope. When present + non-empty, the token is limited to
   * exactly these resources (a restricted principal) — even below the minter's
   * role. Each grant must be within the minter's own access (validated server-side).
   */
  grants: Type.Optional(Type.Array(TokenGrant)),
});
export type TCreateTokenBody = Static<typeof CreateTokenBody>;
