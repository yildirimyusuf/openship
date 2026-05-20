/**
 * Image-only hero showcase — the real dashboard screenshot sitting just
 * below the hero. No title, no description, no card grid. The image is
 * the story.
 */
export function Dashboard() {
  return (
    <section className="dashboard-showcase">
      <div className="mx-auto max-w-6xl px-6">
        <div className="dashboard-shot">
          <div className="dashboard-shot__frame">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/screen.png"
              alt="Openship dashboard"
              loading="lazy"
              decoding="async"
              width="2880"
              height="1800"
              className="dashboard-shot__img"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
