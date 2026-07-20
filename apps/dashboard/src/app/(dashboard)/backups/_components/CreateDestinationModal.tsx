"use client";

import React, { useEffect, useState } from "react";
import { ArrowLeft, Cloud, Server, HardDrive, Lock } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import {
  backupDestinationsApi,
  systemApi,
  type BackupDestinationSummary,
  type CreateDestinationInput,
  getApiErrorMessage,
} from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";

type Kind = Exclude<BackupDestinationSummary["kind"], "http_upload">;

interface KindOption {
  kind: Kind;
  icon: React.ComponentType<{ className?: string }>;
}

const KIND_OPTIONS: KindOption[] = [
  { kind: "s3_compatible", icon: Cloud },
  { kind: "sftp", icon: Server },
  { kind: "openship_server", icon: Server },
  { kind: "local", icon: HardDrive },
];

/** Translated display title for a destination kind. */
function kindTitle(kind: Kind, m: Record<string, string>): string {
  switch (kind) {
    case "s3_compatible":
      return m.kindS3;
    case "sftp":
      return m.kindSftp;
    case "openship_server":
      return m.kindServer;
    case "local":
      return m.kindLocal;
  }
}

/** Translated description + examples for a destination kind (picker cards). */
function kindMeta(kind: Kind, m: Record<string, string>): { description: string; examples: string } {
  switch (kind) {
    case "s3_compatible":
      return { description: m.s3Desc, examples: m.s3Examples };
    case "sftp":
      return { description: m.sftpDesc, examples: m.sftpExamples };
    case "openship_server":
      return { description: m.serverDesc, examples: m.serverExamples };
    case "local":
      return { description: m.localDesc, examples: m.localExamples };
  }
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  /** When set, the modal edits this destination instead of creating one:
   *  the kind picker is skipped, fields are pre-filled, and secrets are left
   *  blank (blank = keep the stored value). */
  destination?: BackupDestinationSummary | null;
}

type Step = "pick" | "configure";

export function CreateDestinationModal({ isOpen, onClose, onSaved, destination }: Props) {
  const { t } = useI18n();
  const m = t.misc.backups;
  const editing = !!destination;
  const [step, setStep] = useState<Step>("pick");
  const [selectedKind, setSelectedKind] = useState<Kind | null>(null);

  // Reset state every time the modal opens. In edit mode jump straight to the
  // configure step with the destination's (fixed) kind.
  useEffect(() => {
    if (!isOpen) return;
    if (destination && destination.kind !== "http_upload") {
      setSelectedKind(destination.kind);
      setStep("configure");
    } else {
      setSelectedKind(null);
      setStep("pick");
    }
  }, [isOpen, destination]);

  const selectedTitle = selectedKind ? kindTitle(selectedKind, m) : null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth={step === "pick" ? "880px" : "760px"}
      width="100%"
      maxHeight="92vh"
    >
      <div className="flex max-h-[92vh] flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border/40 px-6 py-5">
          <div className="flex items-center gap-3 min-w-0">
            {step === "configure" && !editing && (
              <button
                type="button"
                onClick={() => setStep("pick")}
                className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                aria-label={m.backToPicker}
              >
                <ArrowLeft className="size-4 rtl:rotate-180" />
              </button>
            )}
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground truncate">
                {editing
                  ? interpolate(m.modalEditTitle, { name: selectedTitle ?? m.destinationFallback })
                  : step === "pick"
                    ? m.modalAddTitle
                    : interpolate(m.modalNewTitle, { name: selectedTitle ?? m.destinationFallback })}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground truncate">
                {step === "pick"
                  ? m.modalPickSubtitle
                  : m.modalConfigureSubtitle}
              </p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Lock className="size-3.5" />
            {m.encryptedAtRest}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 sm:px-8 sm:py-8">
          {step === "pick" ? (
            <KindPicker
              onPick={(kind) => {
                setSelectedKind(kind);
                setStep("configure");
              }}
            />
          ) : selectedKind ? (
            <ConfigureForm
              key={destination?.id ?? "new"}
              kind={selectedKind}
              destination={destination ?? null}
              onCancel={onClose}
              onSaved={onSaved}
            />
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

// ─── Kind picker (step 1) ────────────────────────────────────────────────────

function KindPicker({ onPick }: { onPick: (kind: Kind) => void }) {
  const { t } = useI18n();
  const m = t.misc.backups;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {KIND_OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const meta = kindMeta(opt.kind, m);
        return (
          <button
            key={opt.kind}
            type="button"
            onClick={() => onPick(opt.kind)}
            className="group flex items-start gap-4 rounded-2xl border border-border/50 bg-card p-5 text-start transition-all hover:border-primary/40 hover:shadow-md hover:-translate-y-0.5"
          >
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted border border-border/40 transition-colors group-hover:bg-primary/10 group-hover:border-primary/30">
              <Icon className="size-5 text-muted-foreground transition-colors group-hover:text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-foreground">
                {kindTitle(opt.kind, m)}
              </p>
              <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
                {meta.description}
              </p>
              <p className="mt-3 text-xs text-muted-foreground/70 uppercase tracking-wider font-medium">
                {meta.examples}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Configure form (step 2) — create OR edit ────────────────────────────────

function ConfigureForm({
  kind,
  destination,
  onCancel,
  onSaved,
}: {
  kind: Kind;
  destination: BackupDestinationSummary | null;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const m = t.misc.backups;
  const editing = !!destination;
  const [name, setName] = useState(destination?.name ?? "");
  const [endpoint, setEndpoint] = useState(destination?.endpoint ?? "");
  // "auto" is a create-time convenience default (R2). In edit mode reflect the
  // STORED value (which may be null → empty) so saving an unrelated change
  // doesn't silently rewrite a null/AWS region to "auto".
  const [region, setRegion] = useState(
    destination ? (destination.region ?? "") : "auto",
  );
  const [bucket, setBucket] = useState(destination?.bucket ?? "");
  const [pathPrefix, setPathPrefix] = useState(destination?.pathPrefix ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sshHost, setSshHost] = useState(destination?.sshHost ?? "");
  const [sshPort, setSshPort] = useState<number | "">(destination?.sshPort ?? 22);
  const [sshUser, setSshUser] = useState(destination?.sshUser ?? "");
  const [sftpPassword, setSftpPassword] = useState("");
  const [sftpPrivateKey, setSftpPrivateKey] = useState("");
  const [serverId, setServerId] = useState(destination?.serverId ?? "");
  const [servers, setServers] = useState<
    Array<{ id: string; name?: string | null; sshHost: string }>
  >([]);
  const [serversLoaded, setServersLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "openship_server") return;
    void systemApi
      .listServers()
      .then((rows) => {
        setServers(
          rows as unknown as Array<{
            id: string;
            name?: string | null;
            sshHost: string;
          }>,
        );
      })
      .catch(() => setServers([]))
      .finally(() => setServersLoaded(true));
  }, [kind]);

  // Placeholder for a secret field that already has a stored value (edit mode):
  // blank submit keeps it, so tell the user that explicitly.
  const secretPlaceholder = (stored: boolean) =>
    editing && stored ? m.secretStoredPlaceholder : undefined;

  const submit = async () => {
    setError(null);
    const input: CreateDestinationInput = { name: name.trim(), kind };

    // Non-secret fields are always sent. Secrets are only sent when the user
    // typed a new value — in edit mode a blank field keeps the stored secret.
    if (kind === "s3_compatible") {
      input.endpoint = endpoint.trim() || null;
      input.region = region.trim() || null;
      input.bucket = bucket.trim();
      input.pathPrefix = pathPrefix.trim() || null;
      if (!editing || accessKeyId) input.accessKeyId = accessKeyId;
      if (!editing || secretAccessKey) input.secretAccessKey = secretAccessKey;
    } else if (kind === "sftp") {
      input.sshHost = sshHost.trim();
      input.sshPort = typeof sshPort === "number" ? sshPort : 22;
      input.sshUser = sshUser.trim();
      input.pathPrefix = pathPrefix.trim() || null;
      if (sftpPassword) input.sftpPassword = sftpPassword;
      if (sftpPrivateKey) input.sftpPrivateKey = sftpPrivateKey;
    } else if (kind === "openship_server") {
      input.serverId = serverId;
      input.pathPrefix = pathPrefix.trim() || null;
    } else if (kind === "local") {
      input.endpoint = endpoint.trim();
    }

    setBusy(true);
    try {
      if (editing && destination) {
        // Kind is immutable — never send it on update.
        const { kind: _kind, ...patch } = input;
        await backupDestinationsApi.update(destination.id, patch);
      } else {
        await backupDestinationsApi.create(input);
      }
      await onSaved();
    } catch (err) {
      setError(
        getApiErrorMessage(err, editing ? m.updateFailed : m.createFailed),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      <Field label={m.fieldName}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Production R2"
          className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
        />
      </Field>

      {kind === "s3_compatible" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            label={m.fieldEndpoint}
            hint={m.hintEndpoint}
          >
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://…"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label={m.fieldRegion}>
            <input
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="us-east-1 / auto"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label={m.fieldBucket}>
            <input
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              placeholder="my-backups"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label={m.fieldPathPrefix} hint={m.hintPathPrefix}>
            <input
              value={pathPrefix}
              onChange={(e) => setPathPrefix(e.target.value)}
              placeholder="openship/prod"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label={m.fieldAccessKeyId}>
            <input
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              placeholder={secretPlaceholder(destination?.hasAccessKeyId ?? false)}
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label={m.fieldSecretAccessKey}>
            <input
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              type="password"
              placeholder={secretPlaceholder(destination?.hasSecretAccessKey ?? false)}
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
        </div>
      )}

      {kind === "sftp" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label={m.fieldHost}>
            <input
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
              placeholder="backups.example.com"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label={m.fieldPort}>
            <input
              type="number"
              value={sshPort}
              onChange={(e) =>
                setSshPort(e.target.value === "" ? "" : Number(e.target.value))
              }
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label={m.fieldUser}>
            <input
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              placeholder="backup"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label={m.fieldPathPrefix}>
            <input
              value={pathPrefix}
              onChange={(e) => setPathPrefix(e.target.value)}
              placeholder="/backups/openship"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label={m.fieldPassword} hint={m.hintPassword}>
            <input
              value={sftpPassword}
              onChange={(e) => setSftpPassword(e.target.value)}
              type="password"
              placeholder={secretPlaceholder(destination?.hasSftpPassword ?? false)}
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
          <Field label={m.fieldPrivateKey} hint={m.hintPrivateKey}>
            <textarea
              value={sftpPrivateKey}
              onChange={(e) => setSftpPrivateKey(e.target.value)}
              rows={4}
              placeholder={
                secretPlaceholder(destination?.hasSftpPrivateKey ?? false) ??
                "-----BEGIN OPENSSH PRIVATE KEY-----"
              }
              className="w-full rounded-xl border border-border/50 bg-muted/20 px-3 py-2.5 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
        </div>
      )}

      {kind === "openship_server" && (
        <div className="grid grid-cols-1 gap-4">
          <Field
            label={m.fieldServer}
            hint={m.hintServer}
          >
            <select
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            >
              <option value="">{m.selectServer}</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ?? s.sshHost} ({s.sshHost})
                </option>
              ))}
            </select>
            {serversLoaded && servers.length === 0 && (
              <span className="block text-sm text-muted-foreground">
                {m.noServersPre}
                <a href="/servers" className="text-primary hover:underline">
                  {m.noServersLink}
                </a>
                {m.noServersPost}
              </span>
            )}
          </Field>
          <Field
            label={m.fieldRemotePath}
            hint={m.hintRemotePath}
          >
            <input
              value={pathPrefix}
              onChange={(e) => setPathPrefix(e.target.value)}
              placeholder="/backups/openship"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>
        </div>
      )}

      {kind === "local" && (
        <Field
          label={m.fieldAbsolutePath}
          hint={m.hintAbsolutePath}
        >
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="/var/backups/openship"
            className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm font-mono text-foreground outline-none transition-colors focus:border-primary/40"
          />
        </Field>
      )}

      <div className="flex items-center justify-end gap-3 pt-6 border-t border-border/40 -mx-6 px-6 -mb-6 pb-6 sm:-mx-8 sm:px-8 sm:-mb-8 sm:pb-8 mt-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="h-11 inline-flex items-center justify-center rounded-xl px-5 text-sm font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
        >
          {m.cancel}
        </button>
        <button
          onClick={submit}
          disabled={busy || !name.trim()}
          className="h-11 inline-flex items-center gap-2 px-6 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none"
        >
          {busy ? m.saving : editing ? m.saveChanges : m.saveDestination}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-foreground mb-1.5">
        {label}
      </span>
      {hint && (
        <span className="block text-xs text-muted-foreground mb-1.5">
          {hint}
        </span>
      )}
      {children}
    </label>
  );
}
