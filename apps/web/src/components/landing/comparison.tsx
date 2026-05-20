/**
 * Comparison — clean table, Openship column visually highlighted with
 * tinted background. Each cell carries a refined status mark (win / loss
 * / neutral) so the comparison reads at a glance, without bright colors.
 */

type Status = "win" | "loss" | "neutral";
type Cell = { text: string; status: Status };
type Row = { feature: string; openship: Cell; managed: Cell; selfhost: Cell };

const ROWS: Row[] = [
  {
    feature: "Where the build runs",
    openship: { text: "Your machine — server stays free",   status: "win" },
    managed:  { text: "Their build runners",                status: "neutral" },
    selfhost: { text: "Always on your production server",   status: "loss" },
  },
  {
    feature: "What lives on your VPS",
    openship: { text: "Only the apps you shipped",          status: "win" },
    managed:  { text: "Not applicable — managed",           status: "neutral" },
    selfhost: { text: "Dashboard, build agent, DB, queue",  status: "loss" },
  },
  {
    feature: "Pricing model",
    openship: { text: "Flat — your compute, your cost",     status: "win" },
    managed:  { text: "Per-seat + bandwidth + invocations", status: "loss" },
    selfhost: { text: "Free, but you maintain the OS",      status: "neutral" },
  },
  {
    feature: "Vendor lock-in",
    openship: { text: "Plain containers, eject any day",    status: "win" },
    managed:  { text: "Vendor-specific runtime & edge",     status: "loss" },
    selfhost: { text: "Tied to the tool's install layout",  status: "loss" },
  },
  {
    feature: "Custom domains and SSL",
    openship: { text: "Unlimited, wildcards, automatic",    status: "win" },
    managed:  { text: "Limited per plan, sometimes paid",   status: "loss" },
    selfhost: { text: "Manual NGINX or Caddy",              status: "neutral" },
  },
  {
    feature: "Managed databases",
    openship: { text: "Postgres, Redis, Mongo, MySQL",      status: "win" },
    managed:  { text: "Bring your own — third-party",       status: "loss" },
    selfhost: { text: "Run yourself, no managed tooling",   status: "loss" },
  },
  {
    feature: "Mail server",
    openship: { text: "Transactional from your domain",     status: "win" },
    managed:  { text: "Not included — bring Sendgrid",      status: "loss" },
    selfhost: { text: "Configure Postfix yourself",         status: "loss" },
  },
  {
    feature: "Interfaces",
    openship: { text: "CLI, web, desktop — same backend",   status: "win" },
    managed:  { text: "Web only, or thin CLI",              status: "neutral" },
    selfhost: { text: "Web on the server itself",           status: "neutral" },
  },
  {
    feature: "Source",
    openship: { text: "Open source, AGPL-3, fork-friendly", status: "win" },
    managed:  { text: "Closed source",                      status: "loss" },
    selfhost: { text: "Mixed licenses",                     status: "neutral" },
  },
  {
    feature: "Migration path",
    openship: { text: "Cloud ⇄ self-host, no rebuild",      status: "win" },
    managed:  { text: "Rewrite to leave",                   status: "loss" },
    selfhost: { text: "Manual export and re-deploy",        status: "neutral" },
  },
];

function StatusMark({ status }: { status: Status }) {
  return (
    <span className={`cmp-mark cmp-mark--${status}`} aria-hidden="true">
      {status === "win" && (
        <svg viewBox="0 0 14 14" fill="none">
          <path d="M3 7.2 L6 10 L11 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {status === "loss" && (
        <svg viewBox="0 0 14 14" fill="none">
          <path d="M4 4 L10 10 M10 4 L4 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
      {status === "neutral" && (
        <svg viewBox="0 0 14 14" fill="none">
          <path d="M3.5 7 L10.5 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}

export function Comparison() {
  return (
    <section className="cmp-section">
      <div className="cmp-container">
        <header className="cmp-head">
          <p className="cmp-eyebrow">Compared to the alternatives</p>
          <h2 className="cmp-title">
            Different choices,<br />made honestly.
          </h2>
          <p className="cmp-sub">
            The right tool depends on what you&rsquo;re building. Here&rsquo;s where Openship sits
            against managed clouds and other self-hosting tools.
          </p>
        </header>

        <div className="cmp">
          <div className="cmp-highlight" aria-hidden="true" />

          {/* Header */}
          <div className="cmp-row cmp-row--head">
            <div className="cmp-cell cmp-cell--feature">Feature</div>
            <div className="cmp-cell cmp-cell--win">Openship</div>
            <div className="cmp-cell">Managed (Vercel, Netlify)</div>
            <div className="cmp-cell">Self-host (Coolify, Dokku)</div>
          </div>

          {/* Body */}
          {ROWS.map((r) => (
            <div key={r.feature} className="cmp-row">
              <div className="cmp-cell cmp-cell--feature">{r.feature}</div>
              <div className="cmp-cell cmp-cell--win">
                <StatusMark status={r.openship.status} />
                <span>{r.openship.text}</span>
              </div>
              <div className="cmp-cell">
                <StatusMark status={r.managed.status} />
                <span>{r.managed.text}</span>
              </div>
              <div className="cmp-cell">
                <StatusMark status={r.selfhost.status} />
                <span>{r.selfhost.text}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
