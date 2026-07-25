import { useEffect } from "react";
import { formatElapsed } from "../utils/geo.js";

const colorForUrgency = (u) => (u > 7 ? "#ff0044" : "#ffe600");

const show = (v) => (v && v !== "n/a" ? v : null);

export default function ReportOverlay({ report, onClose, onResolve }) {
  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!report) return null;

  const directionsUrl =
    show(report.location) &&
    `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
      report.location
    )}&travelmode=driving`;

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="overlay-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <button className="overlay-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div className="overlay-header">
          <span
            className="badge lg"
            style={{ background: colorForUrgency(report.urgency) }}
          >
            {report.urgency}
          </span>
          <div className="overlay-header-info">
            <span className="section-eyebrow">AI crisis summary</span>
            <h2>{report.title}</h2>
            <div className="overlay-elapsed">
              Reported {formatElapsed(report.created_at)}
            </div>
          </div>
          {onResolve && (
            <button
              className="overlay-resolve"
              onClick={() => onResolve(report.id)}
              type="button"
            >
              ✓ Mark resolved
            </button>
          )}
        </div>

        <div className="overlay-grid">
          <section className="overlay-section">
            <h4>Summary</h4>
            <p>{report.summary}</p>
            {show(report.notes) && (
              <>
                <h4>Additional notes</h4>
                <p>{report.notes}</p>
              </>
            )}
          </section>

          <section className="overlay-section">
            <h4>Personal information</h4>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{show(report.name) || "—"}</dd>
              <dt>Age</dt>
              <dd>{show(report.age) || "—"}</dd>
              <dt>Other data</dt>
              <dd>{show(report.other_data) || "—"}</dd>
            </dl>

            <h4>Location</h4>
            <div className="overlay-location">
              <span>{show(report.location) || "Unknown"}</span>
              {directionsUrl && (
                <a
                  className="directions"
                  href={directionsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  🧭 Directions
                </a>
              )}
            </div>
            {report.lat != null && report.lng != null && (
              <div className="overlay-coords">
                {report.lat.toFixed(3)}, {report.lng.toFixed(3)}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
