"use client";

import { useState } from "react";
import { Info, MonitorSmartphone, Shield } from "lucide-react";
import { usePlatform } from "@/context/PlatformContext";
import { useAuth } from "@/context/AuthContext";
import { SettingsSection } from "./SettingsSection";
import { UpgradeAuthModal } from "./UpgradeAuthModal";

export function InstanceInfo() {
  const { user } = useAuth();
  const { authMode, deployMode } = usePlatform();
  const isDesktop = authMode === "none";
  const isCloudSaas = deployMode === "cloud";
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  return (
    <SettingsSection
      icon={Info}
      title="Instance"
      description={isDesktop ? "Desktop app" : isCloudSaas ? "Cloud" : "Self-hosted"}
      iconBg="bg-violet-500/10"
      iconColor="text-violet-500"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex items-center gap-3 rounded-xl border border-border/50 p-4">
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            <MonitorSmartphone className="size-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {isDesktop ? "Desktop" : isCloudSaas ? "Openship Cloud" : "Self-Hosted"}
            </p>
            <p className="text-xs text-muted-foreground">Deploy mode: {deployMode}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-border/50 p-4">
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            <Shield className="size-4 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              {authMode === "none"
                ? "Zero Auth"
                : authMode === "cloud"
                  ? "Cloud Auth"
                  : "Local Auth"}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {user?.email || (isDesktop ? "Local user" : "-")}
            </p>
          </div>
          {/* "Change" only shows in zero-auth — once promoted there's
              no in-place downgrade. Cloud-mode swaps go through the
              cloud-disconnect flow elsewhere. */}
          {isDesktop && (
            <button
              type="button"
              onClick={() => setUpgradeOpen(true)}
              className="shrink-0 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
            >
              Change
            </button>
          )}
        </div>
      </div>

      <UpgradeAuthModal
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        onSuccess={() => {
          // Hard reload so PlatformContext re-reads the new authMode
          // and AuthContext picks up the updated user row.
          if (typeof window !== "undefined") {
            window.location.reload();
          }
        }}
      />
    </SettingsSection>
  );
}
