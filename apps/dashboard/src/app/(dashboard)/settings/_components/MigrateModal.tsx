"use client";

/**
 * Team-mode migration wizard. Promotes a single_user instance into a
 * multi-user deployment via one of three paths:
 *
 *   - Server (A) — SSH-deploy openship onto the operator's own VPS.
 *                  Triggers /migration/preflight then /migration/start.
 *   - Cloud  (B) — push dump to api.openship.io. Triggers /start-cloud.
 *   - Tunnel (C) — keep data local, expose via Oblien edge tunnel.
 *                  Triggers /start-tunnel.
 *
 * The modal owns a three-step state machine: choose path → fill form →
 * show result. On success the dashboard rerenders the MigratedLauncher
 * automatically because /api/health/env now returns teamMode != single_user.
 */

import { useEffect, useState } from "react";
import {
  Cloud,
  Loader2,
  Network,
  Server,
  X,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
} from "lucide-react";
import { migrationApi, systemApi, getApiErrorMessage } from "@/lib/api";
import type {
  DomainChoice,
  PreflightResult,
  StartServerResult,
  StartCloudResult,
  StartTunnelResult,
} from "@/lib/api/migration";
import type { ServerInfo } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { useCloud } from "@/context/CloudContext";

type PathKind = "server" | "cloud" | "tunnel";
type Step = "choose" | "form" | "result";

interface MigrateModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful migration so the parent can refresh. */
  onMigrated: (url: string) => void;
}

export function MigrateModal({ open, onClose, onMigrated }: MigrateModalProps) {
  const { showToast } = useToast();
  const { connected: cloudConnected } = useCloud();
  const [step, setStep] = useState<Step>("choose");
  const [path, setPath] = useState<PathKind | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultDetail, setResultDetail] = useState<string>("");

  // Reset everything on open so re-opens start clean.
  useEffect(() => {
    if (!open) return;
    setStep("choose");
    setPath(null);
    setSubmitting(false);
    setResultUrl(null);
    setResultDetail("");
  }, [open]);

  if (!open) return null;

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handleSuccess = (url: string, detail: string) => {
    setResultUrl(url);
    setResultDetail(detail);
    setStep("result");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-hidden rounded-2xl border border-border/50 bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <ModalHeader
          step={step}
          path={path}
          onBack={() => {
            if (step === "form") {
              setPath(null);
              setStep("choose");
            }
          }}
          onClose={handleClose}
          submitting={submitting}
        />

        <div className="max-h-[calc(90vh-72px)] overflow-y-auto p-6">
          {step === "choose" && (
            <ChooseStep
              cloudConnected={cloudConnected}
              onPick={(p) => {
                setPath(p);
                setStep("form");
              }}
            />
          )}

          {step === "form" && path === "server" && (
            <ServerForm
              submitting={submitting}
              onSubmitStart={() => setSubmitting(true)}
              onSubmitEnd={() => setSubmitting(false)}
              onSuccess={(res) =>
                handleSuccess(
                  res.migrationTargetUrl,
                  `openship is now running on your server. Project id ${res.projectId}.`,
                )
              }
              showToast={showToast}
            />
          )}

          {step === "form" && path === "cloud" && (
            <CloudForm
              cloudConnected={cloudConnected}
              submitting={submitting}
              onSubmitStart={() => setSubmitting(true)}
              onSubmitEnd={() => setSubmitting(false)}
              onSuccess={(res) =>
                handleSuccess(
                  res.publicUrl,
                  `Imported ${res.imported.projects} projects, ${res.imported.deployments} deployments, ${res.imported.services} services.`,
                )
              }
              showToast={showToast}
            />
          )}

          {step === "form" && path === "tunnel" && (
            <TunnelForm
              cloudConnected={cloudConnected}
              submitting={submitting}
              onSubmitStart={() => setSubmitting(true)}
              onSubmitEnd={() => setSubmitting(false)}
              onSuccess={(res) =>
                handleSuccess(
                  res.migrationTargetUrl,
                  `Tunnel "${res.slug}" is publishing your local dashboard.`,
                )
              }
              showToast={showToast}
            />
          )}

          {step === "result" && resultUrl && (
            <ResultStep
              url={resultUrl}
              detail={resultDetail}
              onDone={() => onMigrated(resultUrl)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Header ───────────────────────────────────────────────────────── */

function ModalHeader({
  step,
  path,
  onBack,
  onClose,
  submitting,
}: {
  step: Step;
  path: PathKind | null;
  onBack: () => void;
  onClose: () => void;
  submitting: boolean;
}) {
  const title =
    step === "choose"
      ? "Move to multi-user mode"
      : step === "form"
        ? path === "server"
          ? "Migrate to your server"
          : path === "cloud"
            ? "Migrate to Openship Cloud"
            : "Expose via tunnel"
        : "Migration complete";
  return (
    <div className="flex items-center gap-3 border-b border-border/50 px-6 py-4">
      {step === "form" && !submitting && (
        <button
          type="button"
          onClick={onBack}
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50"
          title="Back"
        >
          <ChevronLeft className="size-4" />
        </button>
      )}
      <h2 className="text-base font-semibold text-foreground flex-1">{title}</h2>
      <button
        type="button"
        onClick={onClose}
        disabled={submitting}
        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50"
        title="Close"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/* ─── Step 1: Choose ───────────────────────────────────────────────── */

function ChooseStep({
  cloudConnected,
  onPick,
}: {
  cloudConnected: boolean;
  onPick: (p: PathKind) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Right now this instance is single-user. Pick how you want your
        teammates to reach it.
      </p>

      <PathCard
        icon={Server}
        title="Migrate to your server"
        body="SSH-deploy openship on a VPS you own. Data moves there. Best for teams that already have infrastructure."
        meta="No external dependency"
        onClick={() => onPick("server")}
      />

      <PathCard
        icon={Cloud}
        title="Migrate to Openship Cloud"
        body="Push your data to api.openship.io. We host everything. Best for teams that want zero infrastructure."
        meta={cloudConnected ? "Cloud account connected" : "Requires cloud account"}
        warn={!cloudConnected ? "Connect to Openship Cloud first." : undefined}
        onClick={() => onPick("cloud")}
      />

      <PathCard
        icon={Network}
        title="Keep local, expose via tunnel"
        body="Your data stays on this machine. We provision an Oblien edge tunnel so teammates can reach you over the public internet — your machine has to be online."
        meta={cloudConnected ? "Tunnel via Oblien" : "Requires cloud account"}
        warn={!cloudConnected ? "Tunnels are provisioned through your cloud account." : undefined}
        onClick={() => onPick("tunnel")}
      />
    </div>
  );
}

function PathCard({
  icon: Icon,
  title,
  body,
  meta,
  warn,
  onClick,
}: {
  icon: React.ElementType;
  title: string;
  body: string;
  meta: string;
  warn?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-xl border border-border/50 bg-muted/[0.05] hover:bg-muted/15 hover:border-border p-4 flex items-start gap-4 transition-all"
    >
      <div className="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <Icon className="size-4" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{body}</p>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground/70 mt-2">
          {meta}
        </p>
        {warn && (
          <p className="text-[11px] text-amber-500 mt-1 flex items-center gap-1">
            <AlertCircle className="size-3" /> {warn}
          </p>
        )}
      </div>
      <ChevronRight className="size-4 text-muted-foreground/70 mt-1" />
    </button>
  );
}

/* ─── Step 2a: Server form ─────────────────────────────────────────── */

function ServerForm({
  submitting,
  onSubmitStart,
  onSubmitEnd,
  onSuccess,
  showToast,
}: {
  submitting: boolean;
  onSubmitStart: () => void;
  onSubmitEnd: () => void;
  onSuccess: (res: StartServerResult) => void;
  showToast: (msg: string, kind: "success" | "error", topic?: string) => void;
}) {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [loadingServers, setLoadingServers] = useState(true);
  const [serverId, setServerId] = useState("");
  const [domainKind, setDomainKind] = useState<"custom" | "free">("free");
  const [customHost, setCustomHost] = useState("");
  const [freeSlug, setFreeSlug] = useState("");
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadingServers(true);
    systemApi
      .listServers()
      .then((list) => {
        if (!alive) return;
        setServers(list);
        if (list.length === 1) setServerId(list[0].id);
      })
      .catch((err) =>
        showToast(getApiErrorMessage(err, "Failed to load servers"), "error", "Migration"),
      )
      .finally(() => {
        if (alive) setLoadingServers(false);
      });
    return () => {
      alive = false;
    };
  }, [showToast]);

  const domain: DomainChoice =
    domainKind === "custom"
      ? { kind: "custom", hostname: customHost.trim() }
      : { kind: "free", slug: freeSlug.trim() };

  const canPreflight =
    !!serverId &&
    (domainKind === "custom"
      ? customHost.trim().length > 3
      : /^[a-z0-9-]+$/.test(freeSlug.trim()));

  const runPreflight = async () => {
    if (!canPreflight) return;
    setRunning(true);
    setPreflight(null);
    try {
      const res = await migrationApi.preflight({ serverId, domain });
      setPreflight(res);
    } catch (err) {
      showToast(getApiErrorMessage(err, "Preflight failed"), "error", "Migration");
    } finally {
      setRunning(false);
    }
  };

  const handleStart = async () => {
    if (!preflight?.ready) return;
    onSubmitStart();
    try {
      const res = await migrationApi.startServer({ serverId, domain });
      onSuccess(res);
    } catch (err) {
      showToast(getApiErrorMessage(err, "Migration failed"), "error", "Migration");
    } finally {
      onSubmitEnd();
    }
  };

  return (
    <div className="space-y-5">
      {/* Server picker */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground block">Target server</label>
        {loadingServers ? (
          <div className="rounded-xl border border-border/50 px-3 py-3 text-xs text-muted-foreground">
            Loading servers...
          </div>
        ) : servers.length === 0 ? (
          <div className="rounded-xl border border-border/50 px-3 py-3 text-xs text-muted-foreground">
            No servers configured. Add one in <span className="font-mono">/system/servers</span>.
          </div>
        ) : (
          <select
            value={serverId}
            onChange={(e) => {
              setServerId(e.target.value);
              setPreflight(null);
            }}
            disabled={submitting}
            className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground"
          >
            <option value="">Pick a server</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.sshHost} ({s.sshUser}@{s.sshHost})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Domain choice */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground block">Domain</label>
        <div className="grid grid-cols-2 gap-2">
          <ToggleButton
            selected={domainKind === "free"}
            disabled={submitting}
            onClick={() => {
              setDomainKind("free");
              setPreflight(null);
            }}
          >
            <span className="text-sm font-medium">Free subdomain</span>
            <span className="text-[11px] text-muted-foreground">name.opsh.io</span>
          </ToggleButton>
          <ToggleButton
            selected={domainKind === "custom"}
            disabled={submitting}
            onClick={() => {
              setDomainKind("custom");
              setPreflight(null);
            }}
          >
            <span className="text-sm font-medium">Custom domain</span>
            <span className="text-[11px] text-muted-foreground">DNS pointed at server</span>
          </ToggleButton>
        </div>
        {domainKind === "free" ? (
          <div className="relative">
            <input
              value={freeSlug}
              onChange={(e) => {
                setFreeSlug(e.target.value.toLowerCase());
                setPreflight(null);
              }}
              placeholder="myteam"
              disabled={submitting}
              className="w-full pl-3 pr-24 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground font-mono"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono">
              .opsh.io
            </span>
          </div>
        ) : (
          <input
            value={customHost}
            onChange={(e) => {
              setCustomHost(e.target.value.toLowerCase());
              setPreflight(null);
            }}
            placeholder="team.acme.com"
            disabled={submitting}
            className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground font-mono"
          />
        )}
      </div>

      {/* Preflight checklist */}
      {preflight && (
        <div className="rounded-xl border border-border/50 p-4 space-y-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Preflight
          </p>
          <CheckRow ok={preflight.checks.ssh.ok} label="SSH reachable">
            {preflight.checks.ssh.detail}
          </CheckRow>
          <CheckRow ok={preflight.checks.releaseDist.ok} label="Openship release available">
            {preflight.checks.releaseDist.detail}
          </CheckRow>
          <CheckRow ok={preflight.checks.domain.ok} label="Domain ready">
            {preflight.checks.domain.detail}
          </CheckRow>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2">
        {!preflight && (
          <button
            type="button"
            onClick={runPreflight}
            disabled={!canPreflight || running || submitting}
            className="inline-flex items-center gap-2 px-4 py-2 bg-muted/50 hover:bg-muted text-foreground rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
          >
            {running && <Loader2 className="size-4 animate-spin" />}
            Run preflight
          </button>
        )}
        {preflight && (
          <>
            <button
              type="button"
              onClick={runPreflight}
              disabled={running || submitting}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Re-check
            </button>
            <button
              type="button"
              onClick={handleStart}
              disabled={!preflight.ready || submitting}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {submitting ? "Deploying..." : "Start migration"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Step 2b: Cloud form ──────────────────────────────────────────── */

function CloudForm({
  cloudConnected,
  submitting,
  onSubmitStart,
  onSubmitEnd,
  onSuccess,
  showToast,
}: {
  cloudConnected: boolean;
  submitting: boolean;
  onSubmitStart: () => void;
  onSubmitEnd: () => void;
  onSuccess: (res: StartCloudResult) => void;
  showToast: (msg: string, kind: "success" | "error", topic?: string) => void;
}) {
  const [allowNonEmptyTarget, setAllowNonEmptyTarget] = useState(false);

  const handleStart = async () => {
    onSubmitStart();
    try {
      const res = await migrationApi.startCloud({ allowNonEmptyTarget });
      onSuccess(res);
    } catch (err: unknown) {
      const apiErr = err as { status?: number; body?: { projectCount?: number } };
      if (apiErr.status === 409 && !allowNonEmptyTarget) {
        showToast(
          `Your cloud org already has ${apiErr.body?.projectCount ?? "some"} projects. Tick the box to proceed and include this instance's data alongside what's already there.`,
          "error",
          "Migration",
        );
      } else {
        showToast(getApiErrorMessage(err, "Cloud migration failed"), "error", "Migration");
      }
    } finally {
      onSubmitEnd();
    }
  };

  if (!cloudConnected) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.04] p-4 space-y-2">
        <div className="flex items-center gap-2 text-amber-500">
          <AlertCircle className="size-4" />
          <p className="text-sm font-medium">Connect your cloud account first</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Open Settings → Cloud and sign in to api.openship.io. Then come back here to migrate.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border/50 p-4 space-y-2">
        <p className="text-sm text-foreground">What happens when you click migrate</p>
        <ul className="space-y-1 text-xs text-muted-foreground list-disc list-inside">
          <li>Your local DB is dumped (encrypted fields stripped — credentials don't leave this machine).</li>
          <li>The dump is uploaded to api.openship.io under your active org.</li>
          <li>Local instance becomes a launcher pointing at app.openship.io.</li>
          <li>You can switch back any time — your local data stays on disk.</li>
        </ul>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={allowNonEmptyTarget}
          onChange={(e) => setAllowNonEmptyTarget(e.target.checked)}
          disabled={submitting}
        />
        <span className="text-sm text-foreground">
          Proceed even if my cloud org already has projects (I'll handle conflicts)
        </span>
      </label>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={handleStart}
          disabled={submitting}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {submitting ? "Pushing data..." : "Start migration"}
        </button>
      </div>
    </div>
  );
}

/* ─── Step 2c: Tunnel form ─────────────────────────────────────────── */

function TunnelForm({
  cloudConnected,
  submitting,
  onSubmitStart,
  onSubmitEnd,
  onSuccess,
  showToast,
}: {
  cloudConnected: boolean;
  submitting: boolean;
  onSubmitStart: () => void;
  onSubmitEnd: () => void;
  onSuccess: (res: StartTunnelResult) => void;
  showToast: (msg: string, kind: "success" | "error", topic?: string) => void;
}) {
  const [slug, setSlug] = useState("");

  const handleStart = async () => {
    if (!slug) return;
    onSubmitStart();
    try {
      const res = await migrationApi.startTunnel({ slug: slug.trim() });
      onSuccess(res);
    } catch (err: unknown) {
      const apiErr = err as { status?: number };
      if (apiErr.status === 409) {
        showToast(`Slug "${slug}" is taken. Pick another.`, "error", "Migration");
      } else if (apiErr.status === 412) {
        showToast(
          "Tunnels need your cloud account connected. Open Settings → Cloud first.",
          "error",
          "Migration",
        );
      } else {
        showToast(getApiErrorMessage(err, "Tunnel provision failed"), "error", "Migration");
      }
    } finally {
      onSubmitEnd();
    }
  };

  if (!cloudConnected) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.04] p-4 space-y-2">
        <div className="flex items-center gap-2 text-amber-500">
          <AlertCircle className="size-4" />
          <p className="text-sm font-medium">Connect your cloud account first</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Tunnels are provisioned through Openship Cloud. Open Settings → Cloud and sign in,
          then come back here.
        </p>
      </div>
    );
  }

  const slugOk = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/.test(slug.trim());

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border/50 p-4 space-y-2">
        <p className="text-sm text-foreground">Heads up</p>
        <ul className="space-y-1 text-xs text-muted-foreground list-disc list-inside">
          <li>Your data stays on this machine. Nothing moves.</li>
          <li>Teammates can reach you only when this machine is online.</li>
          <li>The tunnel agent runs inside the API process — no extra service to babysit.</li>
        </ul>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground block">Tunnel slug</label>
        <div className="relative">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="myteam"
            disabled={submitting}
            className="w-full pl-3 pr-32 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground font-mono"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono">
            .preview.oblien.com
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          3-32 chars, lowercase letters, digits, dashes. Must start and end with a letter or digit.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={handleStart}
          disabled={!slugOk || submitting}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {submitting ? "Provisioning..." : "Provision tunnel"}
        </button>
      </div>
    </div>
  );
}

/* ─── Step 3: Result ───────────────────────────────────────────────── */

function ResultStep({
  url,
  detail,
  onDone,
}: {
  url: string;
  detail: string;
  onDone: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] p-4">
        <CheckCircle2 className="size-5 text-emerald-500 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-foreground">Migration complete</p>
          <p className="text-xs text-muted-foreground mt-1">{detail}</p>
        </div>
      </div>

      <div className="rounded-xl border border-border/50 px-4 py-3 space-y-1">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">New location</p>
        <p className="text-sm font-mono text-foreground break-all">{url}</p>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-muted/50 hover:bg-muted text-foreground rounded-xl text-sm font-medium transition-colors"
        >
          <ExternalLink className="size-4" />
          Open
        </a>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90"
        >
          Done
        </button>
      </div>
    </div>
  );
}

/* ─── Tiny shared bits ─────────────────────────────────────────────── */

function CheckRow({
  ok,
  label,
  children,
}: {
  ok: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      {ok ? (
        <CheckCircle2 className="size-4 text-emerald-500 shrink-0 mt-0.5" />
      ) : (
        <AlertCircle className="size-4 text-amber-500 shrink-0 mt-0.5" />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

function ToggleButton({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`flex flex-col items-start gap-0.5 px-3 py-2 rounded-xl border transition-all disabled:opacity-50 ${
        selected
          ? "border-primary/40 bg-primary/[0.06]"
          : "border-border/50 bg-muted/[0.05] hover:bg-muted/15"
      }`}
    >
      {children}
    </button>
  );
}
