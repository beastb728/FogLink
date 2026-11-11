// Carriageway geometry and rule-based map matching.
// A carriageway is one direction of a road, as a line that runs the way traffic
// drives. Position "s" is metres from the start of that line.

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function haversine(a, b) {
  const dLa = rad(b[0] - a[0]);
  const dLo = rad(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x =
    Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

export class Carriageway {
  constructor({ id, towards, line, tolls = [] }, roadName = '') {
    this.id = id;
    this.tolls = tolls; // [[from, to], ...] metres along, where the line passes a toll plaza
    this.towards = towards;
    this.roadName = roadName;
    this.line = line;
    this.cum = new Float64Array(line.length);
    for (let i = 1; i < line.length; i++) this.cum[i] = this.cum[i - 1] + haversine(line[i - 1], line[i]);
    this.length = this.cum[line.length - 1];
  }

  _seg(s) {
    const c = this.cum;
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Inside a toll plaza or its approach, where everyone crawls and expects to.
   * Phones do not report "slow" or "stopped" here; hard braking is still reported.
   * The queue forms before the booths, so the margin is longer on that side.
   */
  inTollZone(s, before = 600, after = 300) {
    return this.tolls.some(([a, b]) => s >= a - before && s <= b + after);
  }

  /** [lat, lon] at s metres along, optionally shifted `offset` metres to the right. */
  pointAt(s, offset = 0) {
    s = Math.min(Math.max(s, 0), this.length);
    const i = this._seg(s);
    const a = this.line[i];
    const b = this.line[i + 1];
    const f = (s - this.cum[i]) / (this.cum[i + 1] - this.cum[i] || 1);
    let lat = a[0] + (b[0] - a[0]) * f;
    let lon = a[1] + (b[1] - a[1]) * f;
    if (offset) {
      const br = rad(bearing(a, b) + 90);
      lat += deg((offset * Math.cos(br)) / R);
      lon += deg((offset * Math.sin(br)) / (R * Math.cos(rad(lat))));
    }
    return [lat, lon];
  }

  bearingAt(s) {
    const i = this._seg(Math.min(Math.max(s, 0), this.length - 0.01));
    return bearing(this.line[i], this.line[i + 1]);
  }

  /** Nearest point on the line: { s, dist } in metres. */
  project(lat, lon) {
    const k = Math.cos(rad(lat)) * 111320;
    const ky = 110540;
    let best = { s: 0, dist: Infinity };
    const L = this.line;
    for (let i = 0; i < L.length - 1; i++) {
      const ax = (L[i][1] - lon) * k;
      const ay = (L[i][0] - lat) * ky;
      const bx = (L[i + 1][1] - lon) * k;
      const by = (L[i + 1][0] - lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-9;
      const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
      const d = Math.hypot(ax + dx * t, ay + dy * t);
      if (d < best.dist) best = { s: this.cum[i] + t * (this.cum[i + 1] - this.cum[i]), dist: d };
    }
    return best;
  }
}

export function loadRoads(jsonList) {
  const out = [];
  for (const road of jsonList) for (const cw of road.carriageways) out.push(new Carriageway(cw, road.name));
  return out;
}

/**
 * Rule-based map matching (v1): the nearest carriageway within `maxDist` metres
 * whose direction agrees with the GPS heading. The two carriageways of an
 * expressway are only ~20 m apart, so heading, not distance, tells them apart.
 * Pass heading = null when the vehicle is too slow for GPS heading to be trusted;
 * then `previousId` (the last match) breaks the tie.
 */
export function matchCarriageway(carriageways, lat, lon, heading, { maxDist = 60, maxAngle = 60, previousId } = {}) {
  let best = null;
  for (const cw of carriageways) {
    const p = cw.project(lat, lon);
    if (p.dist > maxDist) continue;
    if (heading != null) {
      if (angleDiff(cw.bearingAt(p.s), heading) > maxAngle) continue;
    } else if (previousId && cw.id !== previousId) continue;
    if (!best || p.dist < best.dist) best = { cw, s: p.s, dist: p.dist };
  }
  return best;
}
