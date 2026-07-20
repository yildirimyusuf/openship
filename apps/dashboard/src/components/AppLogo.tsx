"use client";

import { useState } from "react";
import { Boxes, type LucideIcon } from "lucide-react";

/**
 * Per-app logo source. `src` wins (official logo URL); otherwise `slug` resolves
 * to a simpleicons brand mark. Convex uses its official favicon because the
 * simpleicons "convex" glyph renders as a red mask, not the real orange logo.
 */
export const APP_LOGO: Record<
  string,
  { slug?: string; src?: string; fill?: boolean; darkInvert?: boolean }
> = {
  convex: { src: "https://www.google.com/s2/favicons?domain=convex.dev&sz=128" },
  n8n: { slug: "n8n" },
  // Ghost's brand mark is near-black — invert it on the dark themes so it
  // stays visible (it's monochrome, so invert = clean white). Colored logos
  // are left alone.
  ghost: { slug: "ghost", darkInvert: true },
  "uptime-kuma": { slug: "uptimekuma" },
  vaultwarden: { slug: "vaultwarden" },
  metabase: { slug: "metabase" },
  directus: { slug: "directus" },
  nocodb: { slug: "nocodb" },
  // Grafana's mark stays colored; Gitea's tea-cup mark is fine as-is.
  grafana: { slug: "grafana" },
  gitea: { slug: "gitea" },
  freshrss: { slug: "freshrss" },
  excalidraw: { slug: "excalidraw" },
  // code-server / IT-Tools / Stirling-PDF have no reliable simpleicons mark →
  // they fall back to the monochrome Boxes glyph.
  // openship-native mail stack — its own brand mark, a full-bleed square icon.
  "mail-webmail": { src: "/apple-touch-icon.png", fill: true },
  // The control plane self-registered as an app (CLI self-deploy) — Openship's
  // own brand mark, a full-bleed square icon.
  openship: { src: "/apple-touch-icon.png", fill: true },
};

/**
 * Brand logo for a catalog app. Resolves an official URL / simpleicons mark and
 * gracefully falls back to a monochrome lucide icon (offline / air-gapped /
 * unknown app). Keeps the UI clean while adding a touch of real color.
 */
export function AppLogo({
  appId,
  slug,
  src,
  icon: Icon = Boxes,
  className = "size-5",
}: {
  appId?: string;
  slug?: string;
  src?: string;
  icon?: LucideIcon;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const cfg = appId ? APP_LOGO[appId] : undefined;
  const resolvedSlug = slug ?? cfg?.slug;
  const url = src ?? cfg?.src ?? (resolvedSlug ? `https://cdn.simpleicons.org/${resolvedSlug}` : undefined);

  if (!url || failed) return <Icon className={`${className} text-muted-foreground`} />;
  // Full-bleed square marks (own background) fill the tile; transparent brand
  // glyphs stay at the requested size. Dark monochrome marks invert on the dark
  // themes so they don't vanish against a dark tile.
  const base = cfg?.fill ? "size-full object-cover" : className;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      className={cfg?.darkInvert ? `${base} dark:invert dim:invert` : base}
      onError={() => setFailed(true)}
    />
  );
}
