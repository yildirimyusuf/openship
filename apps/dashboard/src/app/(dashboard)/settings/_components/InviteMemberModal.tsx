"use client";

/**
 * Self-contained content for the "Invite a member" modal — rendered via the
 * centralized `showModal` hook (blurred, centered Modal shell). Owns all its
 * own state (email, role, mail source, initial grants) so it stays reactive
 * inside showModal's snapshotted customContent. Calls `onInvited` after a
 * successful send and `onClose` to dismiss.
 */

import { useState } from "react";
import { Loader2, Users as UsersIcon, Shield, Lock, Send, Cloud } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useToast } from "@/context/ToastContext";
import {
  api,
  getApiErrorMessage,
  permissionsApi,
  type PickerGrant,
  type ResourceType,
} from "@/lib/api";
import { ResourcePicker } from "@/components/permissions/ResourcePicker";
import { useI18n, interpolate } from "@/components/i18n-provider";

type MemberRole = "owner" | "admin" | "member" | "restricted";
type MailSource = "platform" | "cloud";

const orgClient = (authClient as unknown as {
  organization: {
    inviteMember: (opts: { email: string; role: MemberRole }) => Promise<{ error?: { message?: string } }>;
  };
}).organization;

export function InviteMemberModal({
  availableTypes,
  selfHosted,
  initialMailSource,
  isPersonalOrg,
  onInvited,
  onClose,
}: {
  availableTypes: ResourceType[];
  selfHosted: boolean;
  initialMailSource: MailSource;
  /** Personal workspaces can't invite — the backend rejects with a raw
   *  "not allowed" error, so we intercept and guide the user to create a
   *  team organization first. */
  isPersonalOrg: boolean;
  onInvited: () => void;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [grants, setGrants] = useState<PickerGrant[]>([]);
  const [mailSource, setMailSource] = useState<MailSource>(initialMailSource);
  const [savingMailSource, setSavingMailSource] = useState(false);
  const [inviting, setInviting] = useState(false);

  const changeMailSource = async (next: MailSource) => {
    if (next === mailSource) return;
    const prev = mailSource;
    setMailSource(next);
    setSavingMailSource(true);
    try {
      await api.patch("system/settings", { invitationMailSource: next });
    } catch (err) {
      setMailSource(prev);
      showToast(getApiErrorMessage(err, t.settings.inviteMember.toast.updateMailSourceFailed), "error", t.settings.common.toast.settings);
    } finally {
      setSavingMailSource(false);
    }
  };

  const handleInvite = async () => {
    if (!email.trim()) return;
    // Personal workspaces can't hold other members — short-circuit with clear
    // guidance instead of letting the backend return a raw "not allowed" error.
    if (isPersonalOrg) {
      showToast(
        t.settings.inviteMember.toast.personalOrgBlocked,
        "error",
        t.settings.common.toast.invitation,
      );
      return;
    }
    setInviting(true);
    try {
      if (role === "restricted" && grants.length > 0) {
        await permissionsApi.inviteWithGrants({ email: email.trim(), role, grants });
      } else {
        const res = await orgClient.inviteMember({ email: email.trim(), role });
        if (res.error) {
          showToast(res.error.message ?? t.settings.inviteMember.toast.failedSend, "error", t.settings.common.toast.invitation);
          return;
        }
      }
      showToast(interpolate(t.settings.inviteMember.toast.invitationSent, { email }), "success", t.settings.common.toast.invitation);
      onInvited();
      onClose();
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.inviteMember.toast.failedSend), "error", t.settings.common.toast.invitation);
    } finally {
      setInviting(false);
    }
  };

  const restricted = role === "restricted";

  // Left column (single-column body when not restricted): email, role cards,
  // and the mail-source picker. Rendered as the left pane in two-pane mode.
  const formFields = (
    <>
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground block">{t.settings.inviteMember.email}</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t.settings.inviteMember.emailPlaceholder}
          disabled={inviting}
          className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground block">{t.settings.inviteMember.role}</label>
        <div className="space-y-2">
          <RoleCard
            icon={UsersIcon}
            title={t.settings.inviteMember.roleMemberTitle}
            description={t.settings.inviteMember.roleMemberDesc}
            selected={role === "member"}
            disabled={inviting}
            onClick={() => {
              setRole("member");
              setGrants([]);
            }}
          />
          <RoleCard
            icon={Shield}
            title={t.settings.inviteMember.roleAdminTitle}
            description={t.settings.inviteMember.roleAdminDesc}
            selected={role === "admin"}
            disabled={inviting}
            onClick={() => {
              setRole("admin");
              setGrants([]);
            }}
          />
          <RoleCard
            icon={Lock}
            title={t.settings.inviteMember.roleRestrictedTitle}
            description={t.settings.inviteMember.roleRestrictedDesc}
            selected={restricted}
            disabled={inviting}
            onClick={() => setRole("restricted")}
            badge={
              restricted && grants.length > 0
                ? interpolate(
                    grants.length === 1 ? t.settings.inviteMember.grantsOne : t.settings.inviteMember.grantsMany,
                    { count: String(grants.length) },
                  )
                : undefined
            }
          />
        </div>
      </div>

      {/* Mail source — self-hosted only (SaaS always sends via cloud). */}
      {selfHosted && (
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground block">{t.settings.inviteMember.sendVia}</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => changeMailSource("platform")}
              disabled={inviting || savingMailSource}
              aria-pressed={mailSource === "platform"}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition-all disabled:opacity-50 ${
                mailSource === "platform"
                  ? "border-primary/40 bg-primary/[0.06] text-foreground"
                  : "border-border/50 bg-muted/[0.05] text-muted-foreground hover:bg-muted/15"
              }`}
            >
              <Send className="size-3.5" />
              {t.settings.inviteMember.yourMailServer}
            </button>
            <button
              type="button"
              onClick={() => changeMailSource("cloud")}
              disabled={inviting || savingMailSource}
              aria-pressed={mailSource === "cloud"}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition-all disabled:opacity-50 ${
                mailSource === "cloud"
                  ? "border-primary/40 bg-primary/[0.06] text-foreground"
                  : "border-border/50 bg-muted/[0.05] text-muted-foreground hover:bg-muted/15"
              }`}
            >
              <Cloud className="size-3.5" />
              {t.settings.inviteMember.openshipCloud}
            </button>
          </div>
        </div>
      )}
    </>
  );

  // Right pane, restricted only: the resource picker the invite unlocks.
  const pickerPane = (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-foreground">{t.settings.inviteMember.pickerTitle}</h4>
        <p className="text-xs text-muted-foreground mt-1">
          {t.settings.inviteMember.pickerDesc}
        </p>
      </div>
      <ResourcePicker
        value={grants}
        onChange={setGrants}
        availableTypes={availableTypes}
        defaultPermissions={["read"]}
        disabled={inviting}
      />
    </div>
  );

  return (
    <div
      className={`flex flex-col max-h-[85vh] transition-[width,max-width] duration-300 ${
        restricted ? "w-[92vw] max-w-[1040px]" : "w-[min(92vw,560px)]"
      }`}
    >
      <div className="p-6 border-b border-border/50">
        <h3 className="text-lg font-semibold text-foreground">{t.settings.inviteMember.headerTitle}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {restricted
            ? t.settings.inviteMember.headerDescRestricted
            : t.settings.inviteMember.headerDescDefault}
        </p>
      </div>

      {restricted ? (
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="overflow-y-auto p-6 space-y-5 md:border-e border-border/50">
            {formFields}
          </div>
          <div className="overflow-y-auto p-6">{pickerPane}</div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-5">{formFields}</div>
      )}

      <div className="flex items-center justify-end gap-2 p-6 border-t border-border/50">
        <button
          type="button"
          onClick={onClose}
          disabled={inviting}
          className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {t.settings.common.cancel}
        </button>
        <button
          type="button"
          onClick={handleInvite}
          disabled={inviting || !email.trim()}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {inviting && <Loader2 className="size-4 animate-spin" />}
          {t.settings.inviteMember.sendInvite}
        </button>
      </div>
    </div>
  );
}

function RoleCard({
  icon: Icon,
  title,
  description,
  selected,
  disabled,
  onClick,
  badge,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`w-full text-start flex items-start gap-3 rounded-xl border px-3.5 py-3 transition-all disabled:opacity-50 ${
        selected
          ? "border-primary/40 bg-primary/[0.06]"
          : "border-border/50 bg-muted/[0.05] hover:bg-muted/15 hover:border-border"
      }`}
    >
      <div
        className={`size-8 rounded-lg flex items-center justify-center shrink-0 ${
          selected ? "bg-primary/15 text-primary" : "bg-muted/40 text-muted-foreground"
        }`}
      >
        <Icon className="size-4" strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {badge && (
            <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-md bg-primary/15 text-primary">
              {badge}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
      </div>
    </button>
  );
}
