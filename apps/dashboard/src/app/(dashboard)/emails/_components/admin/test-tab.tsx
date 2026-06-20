"use client";

/**
 * Test tab — send a real test email through this mail server to confirm
 * delivery, DKIM, and SPF. CTA opens SendTestMailModal which collects
 * recipient + (cosmetic) sender domain and posts to the test-email
 * endpoint.
 */

import { useState } from "react";
import { Send } from "lucide-react";
import { SectionCard } from "./_shared/section-card";
import { SendTestMailModal } from "./SendTestMailModal";

interface Props {
  serverId: string;
}

export function TestTab({ serverId }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-4">
      <SectionCard
        icon={Send}
        title="Test sending"
        description="Send a real test email through this mail server to confirm delivery, DKIM, and SPF."
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Send className="size-3.5" />
          Send test email
        </button>
      </SectionCard>

      <SendTestMailModal
        open={open}
        onClose={() => setOpen(false)}
        serverId={serverId}
      />
    </div>
  );
}
