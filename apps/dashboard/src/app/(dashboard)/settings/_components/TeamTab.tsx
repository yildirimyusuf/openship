"use client";

/**
 * Members page — list, invite, manage roles, remove members in the
 * active organization.
 *
 * Backed by Better Auth's organization plugin endpoints:
 *   GET    /api/auth/organization/list-members
 *   POST   /api/auth/organization/invite-member
 *   POST   /api/auth/organization/update-member-role
 *   POST   /api/auth/organization/remove-member
 *
 * All accessible via the authClient.organization.* methods.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mail, Plus, Trash2, UserPlus, Building2 } from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { useToast } from "@/context/ToastContext";
import {
  api,
  ApiError,
  getApiErrorMessage,
  isNetworkError,
  permissionsApi,
  type PickerGrant,
  type ResourceGrant,
  type ResourceType,
} from "@/lib/api";
import { useModal } from "@/context/ModalContext";
import { GrantPickerModal } from "./GrantPickerModal";
import { InviteMemberModal } from "./InviteMemberModal";
import { usePlatform } from "@/context/PlatformContext";
import { TeamWorkspaceCard } from "./TeamWorkspaceCard";

type MemberRole = "owner" | "admin" | "member" | "restricted";

// ResourceType / PickerGrant / ResourceGrant / resourceTypeLabel are the shared
// definitions from @/lib/api (imported above).

interface MemberRow {
  id: string;
  userId: string;
  role: MemberRole;
  createdAt: string;
  user: { id: string; name: string; email: string; image?: string | null };
}

interface InvitationRow {
  id: string;
  email: string;
  role: MemberRole;
  status: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Better Auth's React client wraps `authClient.organization` in a Proxy
 * whose property accesses return fresh references. Putting that proxy
 * (or any value derived from it) into a `useEffect` / `useCallback`
 * dependency array explodes into an infinite render loop:
 *
 *   render → new ref → useCallback rebuilds → useEffect re-fires
 *   → fetch → setState → render → ...
 *
 * Resolving the client ONCE at module load avoids the trap. Imports of
 * this module evaluate before any React tree mounts, so the captured
 * reference is stable for the lifetime of the page.
 */
const orgClient = (authClient as unknown as {
  organization: {
    listMembers: () => Promise<{ data?: { members?: MemberRow[] } }>;
    listInvitations: () => Promise<{ data?: InvitationRow[] }>;
    inviteMember: (opts: { email: string; role: MemberRole }) => Promise<{ error?: { message?: string } }>;
    removeMember: (opts: { memberIdOrEmail: string }) => Promise<{ error?: { message?: string } }>;
    updateMemberRole: (opts: { memberId: string; role: MemberRole }) => Promise<{ error?: { message?: string } }>;
    cancelInvitation: (opts: { invitationId: string }) => Promise<{ error?: { message?: string } }>;
  };
}).organization;

export function TeamTab() {
  const { data: session } = useSession();
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Per-instance invitation mail source, loaded from /api/system/settings and
  // passed to the invite modal as its initial value (the modal owns changes).
  type InvitationMailSource = "platform" | "cloud";
  const [invitationMailSource, setInvitationMailSource] =
    useState<InvitationMailSource>("platform");
  const [teamMode, setTeamMode] = useState<
    "single_user" | "self_hosted_remote" | "cloud_hosted" | "tunneled"
  >("single_user");
  const { selfHosted } = usePlatform();

  // Mode-aware grantable types: servers + mail servers are self-hosted-only;
  // billing exists only in cloud (SaaS). The picker collapses the two GitHub
  // types into one tab.
  const availableTypes: ResourceType[] = selfHosted
    ? ["project", "server", "mail_server", "backup_destination", "audit", "github_installation", "github_repository"]
    : ["project", "backup_destination", "billing", "audit", "github_installation", "github_repository"];

  // Org-meta: drives personal-vs-team UX. Personal workspaces (auto-
  // created on signup) hide the invite UI; clicking "Create team org"
  // spawns a brand-new is_team=true org with the same owner.
  const [orgMeta, setOrgMeta] = useState<{ isTeam: boolean; memberCount: number } | null>(null);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [creatingTeam, setCreatingTeam] = useState(false);

  // In-flight guard. React Strict Mode mounts every component twice in
  // dev to surface non-idempotent effects — without this ref the refresh
  // effect fires two parallel fetches on every page load. The ref flips
  // true at the start of a refresh and resets in `finally`, so retries
  // after errors still work, but the StrictMode remount no-ops.
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setLoading(true);
    try {
      const [mRes, iRes, metaRes, settingsRes] = await Promise.all([
        orgClient.listMembers(),
        orgClient.listInvitations(),
        // org-meta drives the personal-vs-team UX. The backend ensures
        // a row exists for every org, so this always resolves.
        api.get<{ data: { isTeam: boolean; memberCount: number } }>(
          "permissions/org-meta",
        ).catch(() => ({ data: { isTeam: false, memberCount: 0 } })),
        api
          .get<{
            invitationMailSource?: InvitationMailSource;
            teamMode?: "single_user" | "self_hosted_remote" | "cloud_hosted" | "tunneled";
          }>("system/settings")
          .catch(() => ({ invitationMailSource: "platform" as InvitationMailSource })),
      ]);
      setMembers(mRes.data?.members ?? []);
      setInvitations(iRes.data ?? []);
      setOrgMeta(metaRes.data);
      // SaaS has no self-hosted mail server — invites always go via cloud and
      // the "Send via" chooser is hidden, so only honor a stored source when
      // self-hosted.
      const src = settingsRes?.invitationMailSource;
      if (!selfHosted) {
        setInvitationMailSource("cloud");
      } else if (src === "platform" || src === "cloud") {
        setInvitationMailSource(src);
      }
      const tm = (settingsRes as { teamMode?: typeof teamMode })?.teamMode;
      if (tm) setTeamMode(tm);
    } catch (err) {
      // Network/abort errors are handled by the global NetworkErrorHandler;
      // only surface real API errors here so we don't double-toast.
      console.error("Failed to load members", err);
      if (err instanceof ApiError || !isNetworkError(err)) {
        showToast(getApiErrorMessage(err, "Failed to load team"), "error", "Team");
      }
    } finally {
      setLoading(false);
      refreshingRef.current = false;
    }
  }, [showToast, selfHosted]);

  const handleCreateTeam = async () => {
    const name = newTeamName.trim();
    if (!name) {
      showToast("Team name is required", "error", "Team");
      return;
    }
    setCreatingTeam(true);
    try {
      const res = await api.post<{ data: { id: string; name: string } }>(
        "permissions/create-team-org",
        { name },
      );
      const newOrgId = res.data?.id;
      if (!newOrgId) throw new Error("No org id returned");
      showToast(`Team "${name}" created — switching now…`, "success", "Team");
      setCreateTeamOpen(false);
      setNewTeamName("");
      // Switch the active org to the new one via Better Auth, then reload.
      try {
        const setActive = (
          authClient as unknown as {
            organization: {
              setActive: (opts: { organizationId: string }) => Promise<unknown>;
            };
          }
        ).organization.setActive;
        await setActive({ organizationId: newOrgId });
      } catch {
        /* fall through — page reload picks up the new org */
      }
      // Force a reload so every context (sidebar, header) picks up the
      // new active org cleanly.
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to create team"), "error", "Team");
    } finally {
      setCreatingTeam(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Open the invite flow via the centralized modal hook (blurred, centered).
  const openInvite = () => {
    let id = "";
    id = showModal({
      // The content owns its own width (narrow single-column, or wide two-pane
      // when "Restricted" is picked); cap the shell so it never clips.
      maxWidth: "95vw",
      showCloseButton: false,
      customContent: (
        <InviteMemberModal
          availableTypes={availableTypes}
          selfHosted={selfHosted}
          initialMailSource={invitationMailSource}
          onInvited={() => void refresh()}
          onClose={() => hideModal(id)}
        />
      ),
    });
  };

  const handleRoleChange = async (memberId: string, role: MemberRole) => {
    const res = await orgClient.updateMemberRole({ memberId, role });
    if (res.error) {
      showToast(res.error.message ?? "Failed to update role", "error", "Members");
      return;
    }
    await refresh();
  };

  const handleRemove = async (memberIdOrEmail: string) => {
    if (!confirm("Remove this member from the organization?")) return;
    const res = await orgClient.removeMember({ memberIdOrEmail });
    if (res.error) {
      showToast(res.error.message ?? "Failed to remove", "error", "Members");
      return;
    }
    await refresh();
  };

  const handleCancelInvite = async (invitationId: string) => {
    const res = await orgClient.cancelInvitation({ invitationId });
    if (res.error) {
      showToast(res.error.message ?? "Failed to cancel", "error", "Invitations");
      return;
    }
    await refresh();
  };

  // Open the resource-access editor for a member: load their current grants,
  // then show the shared picker modal (blurred, centered) prefilled with them.
  // Save replaces the whole set (server diffs add/change/remove).
  const openMemberPanel = useCallback(
    async (m: MemberRow) => {
      if (m.role === "owner") return;
      let initial: PickerGrant[] = [];
      try {
        const res = await permissionsApi.listGrants(m.userId);
        initial = (res.data ?? []).map((g: ResourceGrant) => ({
          resourceType: g.resourceType,
          resourceId: g.resourceId,
          permissions: g.permissions,
        }));
      } catch (err) {
        showToast(getApiErrorMessage(err, "Failed to load grants"), "error", "Permissions");
        return;
      }
      let id = "";
      id = showModal({
        maxWidth: "640px",
        showCloseButton: false,
        customContent: (
          <GrantPickerModal
            title={m.user.name || m.user.email}
            subtitle="Grants apply to restricted members. Owner/admin/member have org-wide access by default."
            initial={initial}
            availableTypes={availableTypes}
            saveLabel="Save access"
            onSave={async (grants) => {
              await permissionsApi.replaceGrants(m.userId, grants);
              showToast("Access updated", "success", "Permissions");
            }}
            onClose={() => hideModal(id)}
          />
        ),
      });
    },
    [availableTypes, showModal, hideModal, showToast],
  );

  const myMembership = members.find((m) => m.userId === session?.user?.id);
  const isOwner = myMembership?.role === "owner";
  const isAdminOrOwner = myMembership?.role === "owner" || myMembership?.role === "admin";

  // Tri-state org kind: loading | personal | team. Render the invite
  // button ONLY when team is confirmed; render the "Create team" banner
  // ONLY when personal is confirmed. Anything else (initial null, fetch
  // failure) shows nothing — better than flashing a button that the
  // server would reject with "you are not allowed to invite".
  const orgKind: "loading" | "personal" | "team" =
    orgMeta === null ? "loading" : orgMeta.isTeam ? "team" : "personal";
  const isPersonalOrg = orgKind === "personal";

  // Team-workspace migration card: surfaced ONLY to the owner on
  // single_user self-hosted instances. After migration the dashboard
  // renders the MigratedLauncher in place of this whole page anyway.
  const showWorkspaceMigration = selfHosted && teamMode === "single_user";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            className="text-xl font-medium text-foreground/80"
            style={{ letterSpacing: "-0.2px" }}
          >
            Team
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {isPersonalOrg
              ? "People with access to your personal workspace. Invite collaborators directly, or create a separate team organization."
              : "People with access to this organization's projects, deployments, and servers."}
          </p>
        </div>
        {isAdminOrOwner && (
          <button
            type="button"
            onClick={openInvite}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <UserPlus className="size-4" />
            Invite member
          </button>
        )}
      </div>

      {/* Secondary option for personal workspaces: spin up a separate team org.
          Inviting directly is the primary path (the button up top), so this
          stays a quiet, non-highlighted alternative — owner only. */}
      {isPersonalOrg && isOwner && (
        <div className="rounded-xl border border-border/50 bg-transparent p-4 flex items-center gap-3">
          <div className="size-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <Building2 className="size-[18px] text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">Create a team organization</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              You can invite people here directly — or spin up a separate shared
              space that stays isolated from your personal projects.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreateTeamOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-transparent px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors shrink-0"
          >
            <Plus className="size-3.5" />
            Create team
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Active members */}
          <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border/50 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                Active members ({members.length})
              </h2>
            </div>
            <div className="divide-y divide-border/40">
              {members.map((m) => {
                const clickable = m.role !== "owner";
                return (
                  <div
                    key={m.id}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? () => void openMemberPanel(m) : undefined}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void openMemberPanel(m);
                            }
                          }
                        : undefined
                    }
                    className={`px-5 py-4 flex items-center gap-4 ${
                      clickable ? "cursor-pointer hover:bg-muted/30 transition-colors" : ""
                    }`}
                  >
                    <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-sm font-medium text-foreground">
                      {(m.user.name || m.user.email).slice(0, 1).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {m.user.name || m.user.email}
                        {m.userId === session?.user?.id && (
                          <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{m.user.email}</p>
                    </div>
                    {isOwner && m.userId !== session?.user?.id ? (
                      <select
                        value={m.role}
                        onChange={(e) => handleRoleChange(m.id, e.target.value as MemberRole)}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs rounded-lg border border-border/50 bg-card px-2 py-1.5 text-foreground"
                      >
                        <option value="owner">Owner</option>
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                        <option value="restricted">Restricted</option>
                      </select>
                    ) : (
                      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        {m.role}
                      </span>
                    )}
                    {isAdminOrOwner && m.userId !== session?.user?.id && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRemove(m.id);
                        }}
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title="Remove member"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Pending invitations */}
          {invitations.length > 0 && (
            <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border/50">
                <h2 className="text-sm font-semibold text-foreground">
                  Pending invitations ({invitations.filter((i) => i.status === "pending").length})
                </h2>
              </div>
              <div className="divide-y divide-border/40">
                {invitations
                  .filter((i) => i.status === "pending")
                  .map((inv) => (
                    <div key={inv.id} className="px-5 py-4 flex items-center gap-4">
                      <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                        <Mail className="size-4 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{inv.email}</p>
                        <p className="text-xs text-muted-foreground">
                          Invited as {inv.role} - expires{" "}
                          {new Date(inv.expiresAt).toLocaleDateString()}
                        </p>
                      </div>
                      {isAdminOrOwner && (
                        <button
                          type="button"
                          onClick={() => handleCancelInvite(inv.id)}
                          className="text-xs font-medium text-muted-foreground hover:text-destructive transition-colors"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Team workspace / migration card — last in the team tab so the
          primary "people" UI (members + invitations) is what operators
          see first. Owner-only, self-hosted single_user only. */}
      {showWorkspaceMigration && <TeamWorkspaceCard canMigrate={!!isOwner} />}

      {/* Create Team org modal — Cloudflare-style separate account
          creation. Spawns a fresh org with is_team=true; user becomes
          owner. After creation we setActive() to it and reload so the
          whole app picks up the new active org. */}
      {createTeamOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6"
          onClick={() => !creatingTeam && setCreateTeamOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border/50 bg-card p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="size-9 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
                <Building2 className="size-4 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">Create team organization</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Your personal workspace stays untouched. The team org has
                  its own projects, servers, and invited members.
                </p>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground block mb-1.5">Team name</label>
              <input
                type="text"
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTeamName.trim()) {
                    void handleCreateTeam();
                  }
                }}
                placeholder="Acme Inc"
                autoFocus
                disabled={creatingTeam}
                className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreateTeamOpen(false)}
                disabled={creatingTeam}
                className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateTeam}
                disabled={creatingTeam || !newTeamName.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {creatingTeam && <Loader2 className="size-4 animate-spin" />}
                Create team
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

