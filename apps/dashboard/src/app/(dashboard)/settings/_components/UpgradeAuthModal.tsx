"use client";

/**
 * Zero-auth → local-auth upgrade modal.
 *
 * The synthetic "Local User" provisioned for a zero-auth desktop install
 * keeps its userId across this upgrade — every FK (projects, deployments,
 * member rows, audit) stays valid. The backend rewrites the user row
 * (name/email/emailVerified), inserts a Better Auth credential account
 * with the hashed password, and flips instanceSettings.authMode to
 * "local" in one transaction. On success the response sets a fresh
 * session cookie so the browser stays signed in.
 *
 * The "Use your mail server" toggle is offered only when a provisioned
 * mail server exists; ticking it asks the backend to warm the platform
 * mailbox (ensureOpenshipPlatformMailbox) so outbound mail uses our
 * own SMTP identity by default after the upgrade.
 */

import { useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, Lock, Server, X } from "lucide-react";
import { api, getApiErrorMessage } from "@/lib/api";
import { useToast } from "@/context/ToastContext";

interface MailServerSummary {
  serverId: string;
  installedAt: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function UpgradeAuthModal({ open, onClose, onSuccess }: Props) {
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [useOwnMailServer, setUseOwnMailServer] = useState(false);
  const [hasMailServer, setHasMailServer] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Probe for an installed mail server so we can show the toggle
    // conditionally. Best-effort: if the endpoint errors we just hide
    // the toggle.
    void (async () => {
      try {
        const res = await api.get<{ data: MailServerSummary[] } | MailServerSummary[]>(
          "mail/servers",
        );
        const list = Array.isArray(res) ? res : (res?.data ?? []);
        const installed = list.some((m) => m.installedAt != null);
        setHasMailServer(installed);
        setUseOwnMailServer(installed);
      } catch {
        setHasMailServer(false);
      }
    })();
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (password.length < 8) {
      showToast("Password must be at least 8 characters", "error", "Auth upgrade");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("system/upgrade-to-auth", {
        name: name.trim(),
        email: email.trim(),
        password,
        useOwnMailServer: hasMailServer ? useOwnMailServer : false,
      });
      showToast("Account created — you are now signed in", "success", "Auth upgrade");
      onSuccess();
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to upgrade"), "error", "Auth upgrade");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border/50 bg-card p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
              <Lock className="size-5 text-primary" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">Add a password</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Promote this zero-auth instance to a real email + password
                login. Your projects and history stay intact.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0 disabled:opacity-50"
            title="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground block">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
              disabled={submitting}
              className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              placeholder="Jane Doe"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground block">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              disabled={submitting}
              className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              placeholder="you@example.com"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground block">Password</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                disabled={submitting}
                className="w-full px-3 py-2 pr-10 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                placeholder="At least 8 characters"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {hasMailServer && (
            <label className="flex items-start gap-3 rounded-xl border border-border/50 bg-muted/[0.04] p-3 cursor-pointer">
              <input
                type="checkbox"
                checked={useOwnMailServer}
                onChange={(e) => setUseOwnMailServer(e.target.checked)}
                disabled={submitting}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground flex items-center gap-2">
                  <Server className="size-3.5 text-muted-foreground" />
                  Use your mail server
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  Send password resets, verifications, and team invites
                  from your provisioned mail server instead of the env-based
                  SMTP fallback.
                </p>
              </div>
            </label>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || !email.trim() || password.length < 8}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Create account
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
