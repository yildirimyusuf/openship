import { DarkSection } from "./dark-section";

/**
 * Complete platform — dark section, alternating with the light Features
 * section above. Six capability groups with big numbered anchors and an
 * abstract category mark composed of exactly six elements (matching the
 * six items in that group).
 */

type Item = { name: string; desc: string };
type Group = { n: string; heading: string; mark: React.ReactNode; items: Item[] };

/* ─── Category marks — each contains exactly 6 elements ─────────
 * Refined line-art for the dark surface. Generous viewBox margins,
 * consistent visual weight across all six categories. Color comes
 * from the .cp-group-mark class — a soft lavender, not raw white.
 */
const MARKS = {
  /* Deploy — 6 dots on a smooth ascending bezier (trajectory) */
  deploy: (
    <>
      <path d="M14 82 Q34 76 50 56 T86 18" opacity="0.7" />
      <circle cx="14" cy="82" r="2.1" />
      <circle cx="28" cy="76" r="2.1" />
      <circle cx="42" cy="66" r="2.1" />
      <circle cx="56" cy="52" r="2.1" />
      <circle cx="70" cy="35" r="2.1" />
      <circle cx="86" cy="18" r="2.6" fill="currentColor" />
    </>
  ),
  /* Run — 6 vertical bars on a baseline with caps (activity) */
  run: (
    <>
      <path d="M12 82 L88 82" opacity="0.55" />
      <path d="M20 82 L20 52" strokeLinecap="round" />
      <path d="M32 82 L32 38" strokeLinecap="round" />
      <path d="M44 82 L44 60" strokeLinecap="round" />
      <path d="M56 82 L56 28" strokeLinecap="round" />
      <path d="M68 82 L68 46" strokeLinecap="round" />
      <path d="M80 82 L80 22" strokeLinecap="round" />
    </>
  ),
  /* Connect — hub + 5 nodes arranged on a pentagon (network) */
  connect: (
    <>
      <path d="M50 50 L50 18" opacity="0.55" />
      <path d="M50 50 L80 32" opacity="0.55" />
      <path d="M50 50 L72 80" opacity="0.55" />
      <path d="M50 50 L28 80" opacity="0.55" />
      <path d="M50 50 L20 32" opacity="0.55" />
      <circle cx="50" cy="50" r="3.2" fill="currentColor" />
      <circle cx="50" cy="18" r="2.4" />
      <circle cx="80" cy="32" r="2.4" />
      <circle cx="72" cy="80" r="2.4" />
      <circle cx="28" cy="80" r="2.4" />
      <circle cx="20" cy="32" r="2.4" />
    </>
  ),
  /* Services — 6 stacked layers with subtle isometric step (containers) */
  services: (
    <>
      <rect x="22" y="14" width="56" height="8" rx="1.5" />
      <rect x="18" y="26" width="64" height="8" rx="1.5" />
      <rect x="14" y="38" width="72" height="8" rx="1.5" />
      <rect x="14" y="50" width="72" height="8" rx="1.5" />
      <rect x="14" y="62" width="72" height="8" rx="1.5" />
      <rect x="14" y="74" width="72" height="8" rx="1.5" />
    </>
  ),
  /* Manage — 6 list rows with toggle handles (control surfaces) */
  manage: (
    <>
      <path d="M14 18 L62 18" opacity="0.7" />
      <circle cx="80" cy="18" r="2.6" fill="currentColor" />
      <path d="M14 32 L62 32" opacity="0.7" />
      <circle cx="80" cy="32" r="2.6" />
      <path d="M14 46 L62 46" opacity="0.7" />
      <circle cx="80" cy="46" r="2.6" fill="currentColor" />
      <path d="M14 60 L62 60" opacity="0.7" />
      <circle cx="80" cy="60" r="2.6" />
      <path d="M14 74 L62 74" opacity="0.7" />
      <circle cx="80" cy="74" r="2.6" fill="currentColor" />
      <path d="M14 88 L62 88" opacity="0.7" />
      <circle cx="80" cy="88" r="2.6" />
    </>
  ),
  /* Secure — hexagon (6 sides) with inner check (shield) */
  secure: (
    <>
      <path d="M50 12 L82 30 L82 70 L50 88 L18 70 L18 30 Z" />
      <circle cx="50" cy="12" r="1.8" fill="currentColor" />
      <circle cx="82" cy="30" r="1.8" fill="currentColor" />
      <circle cx="82" cy="70" r="1.8" fill="currentColor" />
      <circle cx="50" cy="88" r="1.8" fill="currentColor" />
      <circle cx="18" cy="70" r="1.8" fill="currentColor" />
      <circle cx="18" cy="30" r="1.8" fill="currentColor" />
      <path d="M40 50 L48 58 L62 42" opacity="0.55" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

const GROUPS: Group[] = [
  {
    n: "01",
    heading: "Deploy",
    mark: MARKS.deploy,
    items: [
      { name: "Push-to-deploy", desc: "Every commit builds and ships. Branch environments included." },
      { name: "Preview deployments", desc: "Every pull request gets its own URL. Auto-torn down on merge." },
      { name: "Local builds", desc: "Builds run on your machine. Production servers stay focused." },
      { name: "Auto-detected stacks", desc: "Framework, language, package manager, commands — figured out." },
      { name: "Smart fixes", desc: "Common failures (missing imports, version drift) diagnosed and patched." },
      { name: "Instant rollbacks", desc: "Every deploy is immutable. Revert to any version in one click." },
    ],
  },
  {
    n: "02",
    heading: "Run",
    mark: MARKS.run,
    items: [
      { name: "Auto-scaling", desc: "Horizontal scaling per service. Up on traffic, down when idle." },
      { name: "Load balancing", desc: "Health checks, weighted routing, sticky sessions — built in." },
      { name: "Live monitoring", desc: "CPU, memory, network, disk — real-time charts and alerts." },
      { name: "Streaming logs", desc: "Live tail across services and replicas. Search, filter, persist." },
      { name: "Scheduled jobs", desc: "Cron-like jobs with retries, visibility, per-run logs." },
      { name: "Zero-downtime deploys", desc: "Rolling restarts, blue-green, draining connections — automatic." },
    ],
  },
  {
    n: "03",
    heading: "Connect",
    mark: MARKS.connect,
    items: [
      { name: "Custom domains", desc: "Unlimited apex and subdomains. Wildcards supported." },
      { name: "Free SSL", desc: "Let's Encrypt by default. Auto-renewing wildcard certificates." },
      { name: "DNS management", desc: "Visual records and propagation. Verify domains in seconds." },
      { name: "Edge routing", desc: "Global edge, anycast IPs, low-latency routing." },
      { name: "Private networking", desc: "Services talk over an isolated network, no exposed ports." },
      { name: "WebSockets", desc: "First-class support, persistent connections, sticky routing." },
    ],
  },
  {
    n: "04",
    heading: "Services",
    mark: MARKS.services,
    items: [
      { name: "PostgreSQL", desc: "Versions 14–17. Daily backups, PITR, scheduled upgrades." },
      { name: "Redis", desc: "Cache or persistent. Cluster mode. Pub/sub and streams." },
      { name: "MongoDB & MySQL", desc: "Replica sets, sharding, automated upgrades, migration tools." },
      { name: "Object storage", desc: "S3-compatible buckets. Signed URLs, lifecycle rules, replication." },
      { name: "Mail server", desc: "Transactional from your domain. SPF, DKIM, DMARC auto-configured." },
      { name: "CDN", desc: "Static asset acceleration. Cache invalidation on deploy." },
    ],
  },
  {
    n: "05",
    heading: "Manage",
    mark: MARKS.manage,
    items: [
      { name: "CLI", desc: "A single binary covering deploy, logs, secrets, domains, rollbacks." },
      { name: "Web dashboard", desc: "Visual deploys, metrics, billing, team access." },
      { name: "Desktop app", desc: "Native Mac and Windows. Push from local, stream logs natively." },
      { name: "Team roles", desc: "Owner, admin, deployer, viewer. Per-project access, audit trail." },
      { name: "Secrets vault", desc: "Encrypted at rest. Environment-scoped. Rotated without redeploying." },
      { name: "Audit log", desc: "Every action, exportable, retained for compliance." },
    ],
  },
  {
    n: "06",
    heading: "Secure",
    mark: MARKS.secure,
    items: [
      { name: "Firewall", desc: "Default-deny inbound. Per-service policies." },
      { name: "Rate limiting", desc: "Per-route limits, IP or token based. Burst and sustained." },
      { name: "Security headers", desc: "HSTS, CSP, COOP, COEP — production defaults." },
      { name: "DDoS protection", desc: "Edge-level mitigation, automatic challenge." },
      { name: "Encryption", desc: "TLS everywhere, encrypted backups, encrypted secrets." },
      { name: "Compliance-ready", desc: "Logs and config suitable for SOC 2, ISO 27001." },
    ],
  },
];

export function CompletePlatform() {
  return (
    <section className="cp-outer">
      <DarkSection>
        <div className="cp-container">
          <header className="cp-head">
            <p className="cp-eyebrow">The full platform</p>
            <h2 className="cp-title">
              Forty capabilities,<br />one platform.
            </h2>
            <p className="cp-sub">
              No add-on stores, no plugin marketplaces, no &ldquo;requires an integration with&hellip;&rdquo;.
            </p>
          </header>

          <div className="cp-stack">
            {GROUPS.map((g) => (
              <section key={g.n} className="cp-group">
                <div className="cp-group-rail">
                  <span className="cp-group-n">{g.n}</span>
                  <h3 className="cp-group-heading">{g.heading}</h3>

                  <svg
                    className="cp-group-mark"
                    viewBox="0 0 100 100"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {g.mark}
                  </svg>

                  <span className="cp-group-count">
                    <span className="cp-group-count-n">{g.items.length}</span>
                    <span className="cp-group-count-label">capabilities</span>
                  </span>
                </div>
                <div className="cp-grid">
                  {g.items.map((it) => (
                    <article key={it.name} className="cp-item">
                      <h4 className="cp-item-name">{it.name}</h4>
                      <p className="cp-item-desc">{it.desc}</p>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </DarkSection>
    </section>
  );
}
