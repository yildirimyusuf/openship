"use client";

/**
 * Instance-tab section (self-hosted only, owner-only) — export the entire
 * instance database to a file and import one on another install, for migrating
 * between two desktops. Secrets travel re-encrypted under a passphrase the
 * user sets on export and re-enters on import; the API re-encrypts them under
 * the destination install's own key.
 *
 * Owner gating is enforced by the API (requireRole("owner")); this component
 * renders nothing for non-owners so the Instance tab stays clean.
 */

import { useCallback, useEffect, useState } from "react";
import { DatabaseBackup, Download, Upload, Loader2, TriangleAlert } from "lucide-react";

import { SettingsSection } from "./SettingsSection";
import { Modal } from "@/components/ui/Modal";
import { useSession, authClient } from "@/lib/auth-client";
import { useToast } from "@/context/ToastContext";
import {
  dataTransferApi,
  getApiErrorMessage,
  type DataTransferFile,
  type ImportMode,
  type ImportResult,
} from "@/lib/api";

// Resolve the org client once (stable ref) — same guard TeamTab uses to avoid
// an effect-recreation loop.
const orgClient = (authClient as unknown as {
  organization: {
    listMembers: () => Promise<{ data?: { members?: Array<{ userId: string; role: string }> } }>;
  };
}).organization;

export function DataTransferTab() {
  const { data: session } = useSession();
  const { showToast } = useToast();

  const [isOwner, setIsOwner] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    orgClient
      .listMembers()
      .then((res) => {
        if (cancelled) return;
        const me = res.data?.members?.find((m) => m.userId === session?.user?.id);
        setIsOwner(me?.role === "owner");
      })
      .catch(() => {
        if (!cancelled) setIsOwner(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  // Non-owners (and the brief pre-resolution window) render nothing — the
  // section only appears for a confirmed owner, so the Instance tab shows just
  // instance info for everyone else instead of a "denied" card.
  if (isOwner !== true) return null;

  return (
    <div className="space-y-6">
      <ExportCard onToast={showToast} />
      <ImportCard onToast={showToast} />
    </div>
  );
}

type Toast = (message: string, type: "success" | "error", title?: string) => void;

/* ── Export ──────────────────────────────────────────────────────── */

function ExportCard({ onToast }: { onToast: Toast }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const passphraseMismatch = passphrase.length > 0 && confirm.length > 0 && passphrase !== confirm;

  const handleExport = useCallback(async () => {
    if (passphraseMismatch) return;
    setBusy(true);
    try {
      const file = (await dataTransferApi.export(passphrase || undefined)) as DataTransferFile;
      const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `openship-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
      onToast(
        passphrase
          ? "Export downloaded. Keep the passphrase safe — you'll need it to import."
          : "Export downloaded. Secrets were NOT included (no passphrase set).",
        "success",
        "Export",
      );
    } catch (err) {
      onToast(getApiErrorMessage(err, "Export failed."), "error", "Export");
    } finally {
      setBusy(false);
    }
  }, [passphrase, passphraseMismatch, onToast]);

  return (
    <SettingsSection
      icon={Download}
      title="Export data"
      description="Download the entire instance database as a file."
      iconBg="bg-primary/10"
      iconColor="text-primary"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Creates a portable snapshot of everything — projects, servers, deployments, settings.
          Set a passphrase to include your secrets (env vars, tokens, SSH credentials); they are
          re-encrypted under it, so the file is safe to move. Leave it blank to export without
          secrets.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Passphrase (optional)
            </label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="new-password"
              placeholder="Protects your secrets"
              className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Confirm passphrase
            </label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              placeholder="Repeat it"
              className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60"
            />
          </div>
        </div>

        {passphraseMismatch && (
          <p className="text-xs text-red-500">Passphrases don't match.</p>
        )}

        <button
          type="button"
          onClick={handleExport}
          disabled={busy || passphraseMismatch}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {busy ? "Exporting…" : "Export & download"}
        </button>
      </div>
    </SettingsSection>
  );
}

/* ── Import ──────────────────────────────────────────────────────── */

function ImportCard({ onToast }: { onToast: Toast }) {
  const [open, setOpen] = useState(false);

  return (
    <SettingsSection
      icon={Upload}
      title="Import data"
      description="Restore an exported file onto this instance."
      iconBg="bg-primary/10"
      iconColor="text-primary"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Load a file exported from another Openship install. Enter the passphrase used when it was
          exported to restore secrets too.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
        >
          <Upload className="size-4" />
          Import from file…
        </button>
      </div>

      <ImportModal open={open} onClose={() => setOpen(false)} onToast={onToast} />
    </SettingsSection>
  );
}

function ImportModal({
  open,
  onClose,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  onToast: Toast;
}) {
  const [file, setFile] = useState<DataTransferFile | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileHasSecrets, setFileHasSecrets] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [mode, setMode] = useState<ImportMode>("wipe");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setFileName("");
    setFileHasSecrets(false);
    setPassphrase("");
    setMode("wipe");
    setError(null);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    try {
      const parsed = JSON.parse(await f.text()) as DataTransferFile;
      if (parsed?.kind !== "openship-instance-export") {
        setError("That doesn't look like an Openship export file.");
        setFile(null);
        return;
      }
      setFile(parsed);
      setFileName(f.name);
      setFileHasSecrets(!!parsed.secrets);
    } catch {
      setError("Could not read that file — is it a valid export?");
      setFile(null);
    }
  };

  const handleImport = async () => {
    if (!file) return;
    if (mode === "wipe") {
      const ok = window.confirm(
        "Replace ALL data on this instance with the imported snapshot? This cannot be undone, and you'll be signed out.",
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = (await dataTransferApi.import(
        file,
        passphrase || undefined,
        mode,
      )) as ImportResult;

      const parts = [`${result.rowsRestored} rows restored`];
      if (result.secretsRehydrated > 0) parts.push(`${result.secretsRehydrated} secrets restored`);
      if (result.secretsSkipped && fileHasSecrets) {
        parts.push("secrets NOT restored (no/incorrect passphrase) — re-enter credentials");
      }
      onToast(parts.join(" · "), "success", "Import complete");

      onClose();
      reset();
      // A wipe replaces the current user/session — reload so the app
      // re-authenticates against the imported data.
      if (mode === "wipe" && typeof window !== "undefined") {
        setTimeout(() => window.location.reload(), 800);
      }
    } catch (err) {
      setError(getApiErrorMessage(err, "Import failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={() => {
        if (busy) return;
        onClose();
        reset();
      }}
      maxWidth="560px"
      closable={!busy}
    >
      <div className="p-6">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <DatabaseBackup className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">Import instance data</h2>
            <p className="text-xs text-muted-foreground">Restore an exported snapshot.</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Export file
            </label>
            <input
              type="file"
              accept="application/json,.json"
              onChange={handleFile}
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/70"
            />
            {fileName && (
              <p className="mt-1 text-xs text-muted-foreground">
                {fileName}
                {fileHasSecrets ? " · contains secrets (passphrase required)" : " · no secrets included"}
              </p>
            )}
          </div>

          {fileHasSecrets && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Passphrase
              </label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="off"
                placeholder="The passphrase set when exporting"
                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60"
              />
            </div>
          )}

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">Mode</label>
            <div className="space-y-2">
              <ModeOption
                selected={mode === "wipe"}
                onSelect={() => setMode("wipe")}
                title="Replace everything"
                description="Wipe this instance and restore the snapshot exactly. Recommended for migrating to a new machine."
              />
              <ModeOption
                selected={mode === "merge"}
                onSelect={() => setMode("merge")}
                title="Merge into existing"
                description="Keep current data and add the imported data. Your own account and settings are preserved."
              />
            </div>
          </div>

          {mode === "wipe" && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <p className="text-xs text-amber-700 dark:text-amber-500">
                This erases all current data on this instance and signs you out.
              </p>
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                if (busy) return;
                onClose();
                reset();
              }}
              disabled={busy}
              className="rounded-lg bg-foreground/[0.06] px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={busy || !file}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? "Importing…" : "Import"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ModeOption({
  selected,
  onSelect,
  title,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border p-3 text-left transition-colors ${
        selected ? "border-primary/60 bg-primary/[0.05]" : "border-border/50 hover:bg-foreground/[0.03]"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex size-4 items-center justify-center rounded-full border ${
            selected ? "border-primary" : "border-border"
          }`}
        >
          {selected && <span className="size-2 rounded-full bg-primary" />}
        </span>
        <span className="text-sm font-medium text-foreground">{title}</span>
      </div>
      <p className="mt-1 pl-6 text-xs text-muted-foreground">{description}</p>
    </button>
  );
}
