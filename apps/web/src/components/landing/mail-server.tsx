/**
 * Mail server spotlight — full self-hosted transactional mail, unlimited
 * domains, one-click setup. Image frame ready for /mail.png.
 */
export function MailServer() {
  return (
    <section className="ms-section">
      <div className="ms-container">
        <div className="ms-grid">
          {/* ── Text side ── */}
          <div className="ms-lead">
            <p className="ms-eyebrow">Built-in mail server</p>
            <h2 className="ms-title">
              Transactional email,<br />
              <span className="ms-title-soft">unlimited domains.</span>
            </h2>
            <p className="ms-body">
              Send password resets, receipts, magic links, marketing — from any domain
              you own. No Sendgrid bill. No DNS rabbit hole. One click and the records,
              certificates, and authentication chain are in place.
            </p>

            <ul className="ms-points">
              <li>
                <span className="ms-point-name">One-click setup.</span>
                <span className="ms-point-desc">SPF, DKIM, DMARC, reverse DNS — verified and configured for you.</span>
              </li>
              <li>
                <span className="ms-point-name">Unlimited domains.</span>
                <span className="ms-point-desc">Add as many sending domains as you need. No add-on, no per-domain pricing.</span>
              </li>
              <li>
                <span className="ms-point-name">Real deliverability.</span>
                <span className="ms-point-desc">Warm-up, reputation tracking, bounce handling, suppression lists — out of the box.</span>
              </li>
              <li>
                <span className="ms-point-name">Open SMTP & REST API.</span>
                <span className="ms-point-desc">Plug straight in from your code. Webhooks for opens, clicks, bounces.</span>
              </li>
            </ul>

            <div className="ms-stat-row">
              <div className="ms-stat">
                <span className="ms-stat-n">∞</span>
                <span className="ms-stat-label">Domains</span>
              </div>
              <div className="ms-stat">
                <span className="ms-stat-n">1</span>
                <span className="ms-stat-label">Click setup</span>
              </div>
              <div className="ms-stat">
                <span className="ms-stat-n">$0</span>
                <span className="ms-stat-label">Add-on cost</span>
              </div>
            </div>
          </div>

          {/* ── Image side ── */}
          <figure className="ms-shot">
            <div className="ms-shot-frame">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/mail.png"
                alt="Openship mail server dashboard"
                loading="lazy"
                decoding="async"
                className="ms-shot-img"
              />
            </div>
            <figcaption className="ms-shot-caption">
              Mail dashboard — add a domain, verify, send.
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
