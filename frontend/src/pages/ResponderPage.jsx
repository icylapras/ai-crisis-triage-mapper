import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowLeft } from "@fortawesome/free-solid-svg-icons";
import { Link } from "react-router-dom";
import Globe from "react-globe.gl";
import { getReports, resolveReport } from "../api.js";
import ReportOverlay from "../components/ReportOverlay.jsx";
import { countryName, findCountryAt, pointInFeature } from "../utils/geo.js";

const colorForUrgency = (urgency) =>
  urgency > 7 ? "#ff0044" : "#ffe600";
const POLL_MS = 4000;
const ZOOM_THRESHOLD = 1.6; // camera altitude below which we detect a country
const DETECT_INTERVAL_MS = 200; // throttle country detection while dragging
const PIXEL_RATIO_CAP = 1.5; // cap devicePixelRatio (Retina renders 2x = 4x work)
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character],
  );

export default function ResponderPage() {
  const [reports, setReports] = useState([]);
  const [features, setFeatures] = useState([]);
  const [activeCountry, setActiveCountry] = useState(null);
  const [sortBy, setSortBy] = useState("time");
  const [selected, setSelected] = useState(null);
  const globeRef = useRef();
  const wrapRef = useRef();
  const activeNameRef = useRef(null);
  const throttleRef = useRef({ last: 0, timer: null });
  const [dims, setDims] = useState({ width: 800, height: 600 });

  useEffect(() => {
    fetch("/countries.geojson")
      .then((response) => response.json())
      .then((geoJson) => setFeatures(geoJson.features || []))
      .catch(() => setFeatures([]));
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getReports()
        .then((data) => alive && setReports(data))
        .catch(() => {});

    load();
    const intervalId = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return undefined;

    const update = () =>
      setDims({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Cap the renderer pixel ratio. On Retina displays the globe otherwise
  // renders at 2x resolution (4x the fragments), which dominates GPU cost.
  // setPixelRatio re-applies the drawing-buffer size internally.
  useEffect(() => {
    const renderer = globeRef.current?.renderer?.();
    if (!renderer) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));
  }, [dims]);

  // Reports that can actually be plotted.
  const mappable = useMemo(
    () => reports.filter((report) => report.lat != null && report.lng != null),
    [reports],
  );

  const visible = useMemo(() => {
    const inRegion = activeCountry
      ? reports.filter(
          (report) =>
            report.lat != null &&
            report.lng != null &&
            pointInFeature(report.lat, report.lng, activeCountry),
        )
      : reports;
    const sorted = [...inRegion];

    if (sortBy === "urgency") {
      sorted.sort((a, b) => b.urgency - a.urgency);
    } else {
      sorted.sort((a, b) => b.id - a.id);
    }
    return sorted;
  }, [reports, activeCountry, sortBy]);

  // The expensive part: point-in-polygon against every country.
  const detectCountry = useCallback(
    (pov) => {
      const found = findCountryAt(pov.lat, pov.lng, features);
      const name = found ? countryName(found) : null;
      if (name !== activeNameRef.current) {
        activeNameRef.current = name;
        setActiveCountry(found);
      }
    },
    [features],
  );

  // onZoom fires on every camera frame while dragging. Do only the cheap
  // altitude check inline; throttle the polygon detection so a fast drag
  // doesn't run 177 point-in-polygon tests per frame on the main thread.
  const handleZoom = useCallback(
    (pov) => {
      if (!features.length) return;

      const state = throttleRef.current;
      if (pov.altitude > ZOOM_THRESHOLD) {
        // Zoomed out: clear immediately, cancel any pending detection.
        clearTimeout(state.timer);
        state.timer = null;
        if (activeNameRef.current !== null) {
          activeNameRef.current = null;
          setActiveCountry(null);
        }
        return;
      }

      const now = Date.now();
      const wait = DETECT_INTERVAL_MS - (now - state.last);
      clearTimeout(state.timer);
      if (wait <= 0) {
        state.last = now;
        detectCountry(pov);
      } else {
        // Trailing call so the region still resolves once the drag settles.
        state.timer = setTimeout(() => {
          state.last = Date.now();
          detectCountry(pov);
        }, wait);
      }
    },
    [features, detectCountry],
  );

  // Clear any pending throttled detection on unmount.
  useEffect(() => {
    const state = throttleRef.current;
    return () => clearTimeout(state.timer);
  }, []);

  const clearRegion = () => {
    activeNameRef.current = null;
    setActiveCountry(null);
  };

  // Optimistically remove the report everywhere (feed, globe, overlay), then
  // tell the backend to delete it for good. A failed request self-heals on
  // the next poll since the report would still be in the DB.
  const handleResolve = useCallback((id) => {
    setReports((prev) => prev.filter((report) => report.id !== id));
    setSelected((prev) => (prev?.id === id ? null : prev));
    resolveReport(id).catch(() => {});
  }, []);

  return (
    <section className="responder-view">
      <aside className="feed">
        <Link className="back-link" to="/user">
          <FontAwesomeIcon icon={faArrowLeft} aria-hidden="true" />
          <span>Crisis assistant</span>
        </Link>

        <div className="feed-head">
          <span className="section-eyebrow">Global crisis events</span>
          <div className="sort" aria-label="Sort crisis events">
            <button
              className={sortBy === "urgency" ? "active" : ""}
              onClick={() => setSortBy("urgency")}
              type="button"
              aria-pressed={sortBy === "urgency"}
            >
              Urgency
            </button>
            <button
              className={sortBy === "time" ? "active" : ""}
              onClick={() => setSortBy("time")}
              type="button"
              aria-pressed={sortBy === "time"}
            >
              Recent
            </button>
          </div>
        </div>

        {activeCountry && (
          <div className="region-banner">
            <span>
              Showing <b>{countryName(activeCountry)}</b>
            </span>
            <button
              onClick={clearRegion}
              type="button"
              aria-label="Clear region filter"
            >
              ✕
            </button>
          </div>
        )}

        <div className="legend">
          <span>
            <i className="dot red" /> Critical (urgency &gt; 7)
          </span>
          <span>
            <i className="dot yellow" /> Elevated (urgency ≤ 7)
          </span>
        </div>

        {visible.length === 0 ? (
          <p className="empty">
            {activeCountry
              ? "No events in this region yet."
              : "No crisis events yet. Submit a report from the assistant."}
          </p>
        ) : (
          <div className="event-list">
            {visible.map((report) => (
              <div className="event-box" key={report.id}>
                <button
                  className="event-main"
                  onClick={() => setSelected(report)}
                  type="button"
                >
                  <span
                    className="badge"
                    style={{ background: colorForUrgency(report.urgency) }}
                  >
                    {report.urgency}
                  </span>
                  <span className="event-body">
                    <span className="event-title">{report.title}</span>
                    <span className="event-loc">📍 {report.location}</span>
                  </span>
                </button>
                <button
                  className="event-resolve"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleResolve(report.id);
                  }}
                  type="button"
                >
                  Resolved
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>

      <div className="globe-wrap" ref={wrapRef}>
        <Globe
          ref={globeRef}
          width={dims.width}
          height={dims.height}
          backgroundColor="#05070d"
          globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
          atmosphereColor="#3a7bd5"
          atmosphereAltitude={0.22}
          onZoom={handleZoom}
          heatmapsData={mappable.length ? [mappable] : []}
          heatmapPointLat="lat"
          heatmapPointLng="lng"
          heatmapPointWeight={(report) => report.urgency / 2}
          heatmapBandwidth={0.9}
          heatmapColorSaturation={2.2}
          heatmapTopAltitude={0.28}
          heatmapsTransitionDuration={0}
          /* Points: hover + click targets */
          pointsData={mappable}
          pointLat="lat"
          pointLng="lng"
          pointColor={(report) => colorForUrgency(report.urgency)}
          pointAltitude={(report) => 0.02 + (report.urgency / 10) * 0.25}
          pointRadius={0.22}
          pointLabel={(report) =>
            `<div class="tip"><b>Urgency ${report.urgency}/10 · ${esc(
              report.location,
            )}</b><br/>${esc(report.summary)}</div>`
          }
          onPointClick={(report) => setSelected(report)}
          pointsMerge={false}
          polygonsData={activeCountry ? [activeCountry] : []}
          polygonCapColor={() => "rgba(255, 0, 68, 0.12)"}
          polygonSideColor={() => "rgba(255, 0, 68, 0.05)"}
          polygonStrokeColor={() => "#ff5a7a"}
          polygonAltitude={0.012}
        />

        <div className="globe-hint">
          Drag to rotate · scroll to zoom into a region
        </div>
      </div>

      {selected && (
        <ReportOverlay
          report={selected}
          onClose={() => setSelected(null)}
          onResolve={handleResolve}
        />
      )}
    </section>
  );
}
