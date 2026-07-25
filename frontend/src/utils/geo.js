// Small dependency-free geo helpers for the responder globe.

/**
 * Ray-casting point-in-ring test. `ring` is an array of [lng, lat] pairs.
 */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * True if (lng, lat) falls inside a GeoJSON Polygon/MultiPolygon geometry.
 * Handles holes: a point in an outer ring but inside a hole is excluded.
 */
function pointInGeometry(lng, lat, geometry) {
  if (!geometry) return false;
  const polys =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  for (const poly of polys) {
    const [outer, ...holes] = poly;
    if (pointInRing(lng, lat, outer)) {
      const inHole = holes.some((h) => pointInRing(lng, lat, h));
      if (!inHole) return true;
    }
  }
  return false;
}

/** True if (lat, lng) is inside a GeoJSON country feature. */
export function pointInFeature(lat, lng, feature) {
  return pointInGeometry(lng, lat, feature?.geometry);
}

/**
 * Find the country feature containing (lat, lng), or null.
 * A cheap bbox pre-check keeps this fast enough to run on every zoom event.
 */
export function findCountryAt(lat, lng, features) {
  for (const f of features) {
    const bbox = f.bbox;
    if (
      bbox &&
      (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3])
    ) {
      continue;
    }
    if (pointInFeature(lat, lng, f)) return f;
  }
  return null;
}

/** Human-readable name for a country feature. */
export function countryName(feature) {
  return feature?.properties?.NAME || feature?.properties?.ADMIN || "region";
}

/**
 * Humanized "time since" string from an ISO timestamp.
 * e.g. "just now", "12 min ago", "3 hr ago", "2 days ago".
 */
export function formatElapsed(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
