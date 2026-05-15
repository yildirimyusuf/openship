"use client";

import React, { useState, useCallback, useEffect, useRef } from "react";
import { Terminal, Server } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { TerminalLogs } from "./logs/TerminalLogs";
import { ServerLogs } from "./logs/ServerLogs";
import { LogsActions } from "./logs/LogsActions";
import { endpoints } from "@/lib/api/endpoints";

type LogsTab = "terminal" | "server";

export const LogsSettings = () => {
  const {
    projectData,
    buildData,
    id,
    terminalLogsData,
    serverLogsData,
    clearTerminalLogs,
    clearServerLogs,
    servicesData,
    hasMultipleServices,
  } = useProjectSettings();
  const hasProjectId = Boolean(id && id !== "undefined");
  const hasResolvedServerMode =
    typeof projectData?.options?.hasServer === "boolean" ||
    typeof projectData?.hasServer === "boolean" ||
    buildData.isLoading === false;
  const effectiveHasServer =
    projectData?.options?.hasServer === true ||
    projectData?.hasServer === true ||
    (buildData.isLoading === false && buildData.hasServer === true);
  const [activeTab, setActiveTab] = useState<LogsTab>("server");
  const hasSelectedTabRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const [currentLogs, setCurrentLogs] = useState<string[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const services = servicesData.services;
  const servicesLoading = servicesData.isLoading;
  const servicesLoaded = !servicesData.isLoading;
  const hasServices = services.length > 0;
  const canShowLogs = effectiveHasServer || hasServices;
  const canShowTerminal = canShowLogs;
  const hasResolvedLogTargets = hasResolvedServerMode && (effectiveHasServer || servicesLoaded);

  useEffect(() => {
    if (!hasResolvedLogTargets) return;
    if (!canShowLogs) {
      setCurrentLogs([]);
      return;
    }

    if (!hasSelectedTabRef.current) {
      setActiveTab("terminal");
    }
  }, [hasResolvedLogTargets, canShowLogs]);

  const switchTab = useCallback(
    (tab: LogsTab) => {
      if (!canShowLogs) return;
      if (tab === "terminal" && !canShowTerminal) return;
      hasSelectedTabRef.current = true;
      setActiveTab((current) => (current === tab ? current : tab));
    },
    [canShowLogs, canShowTerminal],
  );

  useEffect(() => {
    if (!hasProjectId || servicesLoading) return;

    setSelectedServiceId((current) => {
      if (hasMultipleServices && current && services.some((service) => service.id === current)) {
        return current;
      }

      if (hasMultipleServices) {
        return effectiveHasServer ? null : (services[0]?.id ?? null);
      }

      return !effectiveHasServer && services.length === 1 ? services[0].id : null;
    });
  }, [effectiveHasServer, hasMultipleServices, hasProjectId, services, servicesLoading]);

  const selectedService = services.find((service) => service.id === selectedServiceId) ?? null;
  const implicitSingleService =
    !hasMultipleServices && !effectiveHasServer ? (services[0] ?? null) : null;
  const terminalService = hasMultipleServices ? selectedService : implicitSingleService;
  const isServiceLogTarget = Boolean(terminalService);
  const terminalStreamTarget = !hasProjectId
    ? ""
    : isServiceLogTarget
      ? terminalService
        ? endpoints.services.logsStream(id, terminalService.id)
        : ""
      : endpoints.projects.logsStream(id);
  const terminalHistoryTarget = !hasProjectId
    ? ""
    : isServiceLogTarget
      ? terminalService
        ? endpoints.services.logs(id, terminalService.id)
        : ""
      : endpoints.projects.logs(id);

  const handleLogsChange = useCallback((logs: string[]) => {
    setCurrentLogs(logs);
  }, []);

  // Update current logs when active tab or logs data changes
  useEffect(() => {
    if (!canShowLogs) {
      setCurrentLogs([]);
      return;
    }

    if (activeTab === "terminal") {
      setCurrentLogs(terminalLogsData.logs);
    } else {
      const serverLogsStrings = serverLogsData.logs.map(
        (log) =>
          `${log.timestamp} - ${log.ip} - ${log.method} ${log.path} - ${log.statusCode} - ${log.responseTime}ms`,
      );
      setCurrentLogs(serverLogsStrings);
    }
  }, [activeTab, canShowLogs, terminalLogsData.logs, serverLogsData.logs]);

  const copyLogs = useCallback(() => {
    if (currentLogs.length === 0) return;
    navigator.clipboard.writeText(currentLogs.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [currentLogs]);

  const downloadLogs = useCallback(() => {
    if (currentLogs.length === 0) return;
    const blob = new Blob([currentLogs.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeTab}-logs-${new Date().toISOString()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [currentLogs, activeTab]);

  const clearLogs = useCallback(() => {
    if (currentLogs.length === 0) return;

    // Clear logs from context based on active tab
    if (activeTab === "terminal") {
      clearTerminalLogs();
      // Also trigger the event for terminal to reset its display
      window.dispatchEvent(new CustomEvent("clearLogs"));
    } else {
      clearServerLogs();
    }
  }, [currentLogs, activeTab, clearTerminalLogs, clearServerLogs]);

  if (!hasResolvedLogTargets) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8">
        <div className="space-y-3">
          <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          <div className="h-20 animate-pulse rounded-xl bg-muted/70" />
        </div>
      </div>
    );
  }

  if (hasResolvedLogTargets && !canShowLogs) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
        <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Terminal className="size-5" />
        </div>
        <h3 className="text-sm font-semibold text-foreground">No runtime logs</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          This project is deployed as a static app, so there is no running server process to stream
          logs from.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Tabs + Actions */}
      <div className="flex items-center justify-between border-b border-border/50">
        <div className="flex items-center gap-1">
          {canShowTerminal && (
            <button
              onClick={() => switchTab("terminal")}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === "terminal"
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground/70"
              }`}
            >
              <Terminal className="size-4" />
              Terminal
              {activeTab === "terminal" && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
              )}
            </button>
          )}
          <button
            onClick={() => switchTab("server")}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === "server"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground/70"
            }`}
          >
            <Server className="size-4" />
            Server
            {activeTab === "server" && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        </div>

        <LogsActions
          onCopy={copyLogs}
          onDownload={downloadLogs}
          onClear={clearLogs}
          copied={copied}
          logsCount={currentLogs.length}
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-h-[460px]">
        {activeTab === "terminal" && canShowTerminal && (
          <div className="space-y-4">
            {hasMultipleServices && (
              <div className="rounded-2xl border border-border/60 bg-card/70 p-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">Runtime log target</p>
                    <p className="text-sm text-muted-foreground">
                      Switch between the project runtime and service runtimes.
                    </p>
                  </div>
                  <div className="min-w-[220px]">
                    <select
                      value={selectedServiceId ?? ""}
                      onChange={(event) => setSelectedServiceId(event.target.value || null)}
                      disabled={servicesLoading}
                      className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                    >
                      {effectiveHasServer && <option value="">Project runtime</option>}
                      {services.map((service) => (
                        <option key={service.id} value={service.id}>
                          {service.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {hasMultipleServices && !effectiveHasServer && !selectedService ? (
              <div className="flex min-h-[420px] items-center justify-center rounded-3xl border border-border/50 bg-card text-sm text-muted-foreground">
                Select a service to view its runtime logs.
              </div>
            ) : (
              <TerminalLogs
                projectId={id}
                projectName={terminalService?.name || projectData?.name || "Project"}
                streamTarget={terminalStreamTarget}
                historyTarget={terminalHistoryTarget}
                onLogsChange={handleLogsChange}
              />
            )}
          </div>
        )}
        {activeTab === "server" && canShowLogs && hasProjectId && (
          <ServerLogs
            projectId={id}
            projectName={projectData?.name || "Project"}
            onLogsChange={handleLogsChange}
          />
        )}
      </div>
    </div>
  );
};
