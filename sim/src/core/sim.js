// FogLink traffic simulator: one foggy carriageway, with or without FogLink.
//
// Every modelling assumption that moves the result is a named field in
// DEFAULT_CONFIG and is listed in ASSUMPTIONS, so results can always be shown
// next to what they depend on.

import { assess, stoppableSpeed, HARD_BRAKE, SLOW_SPEED, RANGE_M, LEVEL } from './alert.js';

export const TYPES = {
  car: { len: 4.5, v0: [25, 33.3], bMax: 6.5, aMax: 1.6 }, // 90-120 km/h
  bus: { len: 12, v0: [20, 25], bMax: 4.8, aMax: 0.9 }, // 72-90 km/h
  truck: { len: 14, v0: [15.3, 21], bMax: 4.2, aMax: 0.6 }, // 55-75 km/h
};

export const DEFAULT_CONFIG = {
  seed: 1,
  vehicles: 1000,
  lanes: 3,
  density: 10, // vehicles per km per lane
  mix: { car: 0.6, bus: 0.1, truck: 0.3 },
  visibility: 50, // metres
  reactionMean: 1.5, // s, to something the driver sees
  overdrive: 2.0, // drivers pick a speed whose stopping distance is this many times what they can see
  // FogLink
  foglink: true,
  penetration: 0.5, // share of vehicles running FogLink
  detectLatency: 0.2, // s, braking starts -> phone fires
  detectRecall: 0.95, // share of hard-braking events the phone catches
  netLatency: 0.3, // s, phone -> relay -> phones behind
  alertReaction: 1.0, // s, voice alert -> driver starts to act
  compliance: 0.9, // share of alerted drivers who act on it
  rangeM: RANGE_M,
  // incident
  incidentAt: 20, // s; null = none
  incidentFrac: 0.7, // where along the stretch
  incidentAllLanes: true,
  dt: 0.1,
};

export const ASSUMPTIONS = [
  ['Car-following', 'Intelligent Driver Model per lane, no lane changes. A driver knows nothing about the vehicle ahead until it is inside the visibility distance, starts responding one reaction time after it comes into view, and picks up changes in its speed half a reaction time late. In thick fog drivers close up to keep the tail-lights ahead in view (gap <= 0.8 x visibility).'],
  ['Speed in fog', 'Drivers overdrive their sight distance: each picks a speed whose stopping distance is `overdrive` x visibility (capped at their normal cruising speed). Each lane has settled to a common platoon speed, within 3%.'],
  ['Braking', 'Wet-road maximum deceleration: cars 6.5, buses 4.8, trucks 4.2 m/s^2.'],
  ['Collision', 'A vehicle that reaches the one ahead at more than 2 km/h closing speed crashes and stays stopped in lane.'],
  ['FogLink detection', 'An equipped phone reports hard braking (>0.35 g), a crash, or crawling below 30 km/h after `detectLatency`, catching `detectRecall` of events. False alarms are not simulated.'],
  ['Relay', 'Events reach every equipped vehicle up to 2 km behind on the carriageway (all lanes) after `netLatency`. No coverage gaps are simulated.'],
  ['Driver response', 'A `compliance` share of alerted drivers, `alertReaction` seconds after the alert, ease down to a speed from which they can stop within what they can see by the time they reach the reported position. Nobody ignores an alert and then brakes later because of it.'],
];

/** mulberry32: small deterministic PRNG so both arms of an A/B run start identical. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HIST_S = 3.2; // longest reaction delay we keep history for

export class Sim {
  constructor(config = {}) {
    const c = (this.c = { ...DEFAULT_CONFIG, ...config });
    this.length = (c.vehicles / (c.lanes * c.density)) * 1000; // metres of road simulated
    this.t = 0;
    this.k = 0;
    this.H = Math.ceil(HIST_S / c.dt) + 1;
    this.keepInSight = Math.max(8, 0.8 * c.visibility); // in fog drivers close up to keep tail-lights in view
    this.lanes = [];
    this.vehicles = [];
    this.pending = []; // stop events in flight to the relay
    this.recentEvents = []; // for drawing: {t, s, lane, kind}
    this.incidents = [];
    this.stats = {
      collisions: 0, involved: 0, severe: 0, impactSum: 0, maxImpact: 0,
      events: 0, alerts: [0, 0, 0, 0], alerted: 0, waveBack: 0, firstCollisionT: null,
    };
    this.onEvent = null; // (event) => void, used to bridge virtual events to a live relay
    this._build();
    this._warmup();
    if (c.incidentAt != null) this.incidentPending = { t: c.incidentAt, s: this.length * c.incidentFrac };
  }

  _build() {
    const c = this.c;
    const r = rng(c.seed);
    this.evRng = rng(c.seed ^ 0x9e3779b9); // separate stream: only the FogLink arm draws from it
    const types = Object.keys(c.mix);
    const total = types.reduce((a, k) => a + c.mix[k], 0) || 1;
    // heavy vehicles keep left (lane 0), cars keep right, as on Indian expressways
    const lanePref = (type) => {
      const u = r();
      if (c.lanes === 1) return 0;
      if (type === 'car') return u < 0.15 ? 0 : Math.min(c.lanes - 1, 1 + Math.floor(r() * (c.lanes - 1)));
      return u < 0.75 ? 0 : Math.min(c.lanes - 1, 1);
    };
    const perLane = Array.from({ length: c.lanes }, () => []);
    for (let i = 0; i < c.vehicles; i++) {
      let u = r() * total;
      let type = types[0];
      for (const k of types) {
        if (u < c.mix[k]) { type = k; break; }
        u -= c.mix[k];
      }
      const T = TYPES[type];
      const tr = Math.min(3, Math.max(0.6, c.reactionMean * (0.7 + 0.6 * r())));
      const v0 = T.v0[0] + (T.v0[1] - T.v0[0]) * r();
      const vFog = Math.max(10, stoppableSpeed(c.visibility * c.overdrive, tr, T.bMax));
      const veh = {
        id: i, type, len: T.len, lane: lanePref(type),
        s: 0, v: 0, a: 0,
        v0, vDes: Math.min(v0, vFog),
        T: Math.max(1.2 + 0.6 * r(), 0.5 * tr + 0.7), s0: 2, aMax: T.aMax, bMax: T.bMax, tr,
        delay: Math.round((0.5 * tr) / c.dt), // brake lights of a vehicle already in view are picked up faster
        equipped: r() < c.penetration, compliant: r() < c.compliance,
        vCaution: Math.max(4, stoppableSpeed(c.visibility * 0.8, tr, 4)),
        crashed: false, involved: false, forced: false,
        hist: null, u: r(), seen: null,
        // FogLink state
        hz: null, respondAt: Infinity, alertLevel: 0, hardSince: null, lastEmit: -Infinity, wasCrashed: false,
      };
      perLane[veh.lane].push(veh);
      this.vehicles.push(veh);
    }
    for (let l = 0; l < c.lanes; l++) {
      const arr = perLane[l];
      const n = arr.length;
      const gap = this.length / Math.max(n, 1);
      // Nobody overtakes in fog, so each lane has settled to a common platoon speed (+-3%).
      const sorted = arr.map((v) => v.vDes).sort((a, b) => a - b);
      const base = sorted[Math.floor(n * 0.2)] ?? 20;
      for (const v of arr) v.vDes = Math.min(Math.max(v.vDes, base * 0.97), base * 1.03);
      // index 0 is the rearmost vehicle; a vehicle's leader is index + 1
      arr.forEach((veh, i) => {
        veh.s = (i + 0.2 + 0.6 * veh.u) * gap;
        veh.v = Math.min(veh.vDes, Math.max(0, (gap - veh.len - veh.s0) / veh.T));
      });
      for (let i = n - 2; i >= 0; i--) arr[i].s = Math.min(arr[i].s, arr[i + 1].s - arr[i + 1].len - 1);
      this.lanes.push(arr);
    }
  }

  /** Let traffic settle with perfect perception, so no run starts mid-transient. */
  _warmup() {
    const dt = this.c.dt;
    for (let k = 0; k < 30 / dt; k++) {
      for (const lane of this.lanes) {
        for (let i = lane.length - 1; i >= 0; i--) {
          const v = lane[i];
          const L = lane[i + 1];
          v.a = L ? this._idm(v, L.s - L.len - v.s, L.v, v.vDes) : this._idm(v, Infinity, 0, v.vDes);
        }
        for (const v of lane) {
          v.v = Math.max(0, v.v + v.a * dt);
          v.s += v.v * dt;
        }
      }
    }
    const shift = Math.min(...this.vehicles.map((v) => v.s));
    for (const v of this.vehicles) {
      v.s -= shift;
      v.a = 0;
      v.seen = null;
      v.hist = new Float32Array(this.H * 2);
      for (let j = 0; j < this.H; j++) {
        v.hist[2 * j] = v.s;
        v.hist[2 * j + 1] = v.v;
      }
    }
    for (const lane of this.lanes)
      for (let i = 0; i < lane.length - 1; i++)
        if (lane[i + 1].s - lane[i + 1].len - lane[i].s < this.c.visibility) lane[i].seen = -Infinity;
    this.length = Math.max(...this.vehicles.map((v) => v.s)) + 50;
  }

  _idm(v, gap, vLead, vDes) {
    const free = Math.max(-2.5, v.aMax * (1 - (v.v / vDes) ** 4));
    if (gap === Infinity) return free;
    const g = Math.max(gap, 0.1);
    const sStar = Math.min(v.s0 + v.v * v.T, this.keepInSight) + Math.max(0, (v.v * (v.v - vLead)) / (2 * Math.sqrt(v.aMax * 2.0)));
    return Math.max(-v.bMax, Math.min(free, v.aMax * (1 - (v.v / vDes) ** 4 - (sStar / g) ** 2)));
  }

  /** Stop the vehicle nearest to position s (in every lane, or just one). */
  inject(s, allLanes = true, lane = 0) {
    const hit = [];
    this.lanes.forEach((arr, l) => {
      if (!allLanes && l !== lane) return;
      let best = null;
      for (const v of arr) if (!v.crashed && (!best || Math.abs(v.s - s) < Math.abs(best.s - s))) best = v;
      if (best) {
        best.forced = true;
        hit.push(best);
      }
    });
    this.incidents.push({ t: this.t, s });
    return hit;
  }

  step() {
    const c = this.c;
    const dt = c.dt;
    if (this.incidentPending && this.t >= this.incidentPending.t) {
      this.inject(this.incidentPending.s, c.incidentAllLanes, 0);
      this.incidentPending = null;
    }
    const H = this.H;
    for (const lane of this.lanes) {
      // 1. accelerations
      for (let i = 0; i < lane.length; i++) {
        const v = lane[i];
        if (v.crashed) { v.a = 0; continue; }
        if (v.forced) { v.a = v.v > 0 ? -v.bMax : 0; continue; }
        const L = lane[i + 1];
        let a;
        let vDes = v.vDes;
        // what the driver sees, one reaction time ago
        let gap = Infinity;
        let vLead = 0;
        if (L) {
          const g = L.s - L.len - v.s;
          if (g < c.visibility * (v.seen == null ? 1 : 1.1)) {
            if (v.seen == null) v.seen = this.t; // just came into view: reaction time starts
            if (this.t - v.seen >= v.tr) {
              gap = g;
              // closing speed is judged late: the leader's speed one reaction time ago
              vLead = L.hist[2 * ((((this.k - v.delay) % H) + H) % H) + 1];
            }
          } else v.seen = null;
        }
        // what FogLink told the driver
        let aAlert = Infinity;
        if (v.hz && v.compliant && this.t >= v.respondAt) {
          const hg = v.hz.s - 15 - v.s; // metres to the reported position
          if (hg > -50 && this.t - v.hz.t < 10) {
            // be down to a speed you can stop from within sight by the time you get there,
            // braking gently (2 m/s^2) if warned early, harder only if warned late
            const vT = Math.max(v.hz.v, v.vCaution);
            const vAllowed = Math.sqrt(vT * vT + 2 * 2.0 * Math.max(hg, 0));
            vDes = Math.min(vDes, Math.max(vAllowed, vT));
            if (v.v > vAllowed) aAlert = Math.max(-0.8 * v.bMax, -(v.v * v.v - vT * vT) / (2 * Math.max(hg, 5)));
          }
        }
        a = Math.min(this._idm(v, gap, vLead, vDes), aAlert);
        v.a = a;
      }
      // 2. integrate
      for (const v of lane) {
        if (v.crashed) continue;
        v.v = Math.max(0, v.v + v.a * dt);
        v.s += v.v * dt;
        if (v.forced && v.v === 0) v.a = 0;
      }
      // 3. collisions, front to back
      for (let i = lane.length - 2; i >= 0; i--) {
        const v = lane[i];
        const L = lane[i + 1];
        const lim = L.s - L.len;
        if (v.s >= lim) {
          const dv = v.v - L.v;
          v.s = lim - 0.05;
          if (dv > 0.55 && !v.crashed) {
            this.stats.collisions++;
            this.stats.impactSum += dv;
            this.stats.maxImpact = Math.max(this.stats.maxImpact, dv);
            if (dv > 8.3) this.stats.severe++;
            if (this.stats.firstCollisionT == null) this.stats.firstCollisionT = this.t;
            for (const x of [v, L]) {
              if (!x.involved) { x.involved = true; this.stats.involved++; }
              x.crashed = true;
              x.v = 0;
              x.a = 0;
            }
          } else if (!v.crashed) {
            v.v = Math.min(v.v, L.v);
          }
        }
      }
    }
    this.k++;
    this.t += dt;
    const slot = this.k % H;
    for (const v of this.vehicles) {
      v.hist[2 * slot] = v.s;
      v.hist[2 * slot + 1] = v.v;
    }
    if (c.foglink) this._foglink();
    if (this.recentEvents.length && this.t - this.recentEvents[0].t > 4) {
      this.recentEvents = this.recentEvents.filter((e) => this.t - e.t <= 4);
    }
  }

  _foglink() {
    const c = this.c;
    // phones detect and report
    for (const v of this.vehicles) {
      if (!v.equipped) continue;
      let kind = null;
      if (v.crashed && !v.wasCrashed) {
        v.wasCrashed = true;
        kind = 'crash';
      } else if (-v.a >= HARD_BRAKE && v.v > 1) {
        if (v.hardSince == null) v.hardSince = this.t;
        if (this.t - v.hardSince >= c.detectLatency && this.t - v.lastEmit >= 1) kind = 'brake';
      } else {
        v.hardSince = null;
        if (v.v < SLOW_SPEED && this.t - v.lastEmit >= 2) kind = v.v < 1 ? 'stopped' : 'slow';
      }
      if (!kind) continue;
      v.lastEmit = this.t;
      if (kind !== 'stopped' && kind !== 'slow' && this.evRng() > c.detectRecall) continue; // missed
      const ev = { t: this.t, due: this.t + c.netLatency, s: v.s, v: v.v, dec: Math.max(0, -v.a), lane: v.lane, kind, from: v.id };
      this.pending.push(ev);
      this.recentEvents.push(ev);
      this.stats.events++;
      if (this.onEvent) this.onEvent(ev);
    }
    // relay delivers to every equipped vehicle up to rangeM behind, any lane
    if (!this.pending.length) return;
    const due = [];
    this.pending = this.pending.filter((e) => (e.due <= this.t ? (due.push(e), false) : true));
    for (const ev of due) this.deliver(ev);
  }

  /** Hand one stop event to the phones behind it. Also used for events from real phones. */
  deliver(ev) {
    const c = this.c;
    for (const v of this.vehicles) {
      if (!v.equipped || v.crashed || v.id === ev.from) continue;
      const gap = ev.s - v.s;
      if (gap <= 0 || gap > c.rangeM) continue;
      // the phone keeps the nearest fresh hazard ahead
      if (!v.hz || this.t - v.hz.t > 6 || v.hz.s <= v.s || ev.s <= v.hz.s + 5) {
        v.hz = { s: ev.s, v: ev.dec >= 1 ? 0 : ev.v, t: this.t };
      }
      const res = assess({ gap, v: v.v, hazardV: ev.v, hazardDec: ev.dec, visibility: c.visibility, reactionS: c.alertReaction });
      if (res.level > v.alertLevel) {
        if (v.alertLevel === 0) {
          this.stats.alerted++;
          v.respondAt = this.t + c.alertReaction;
        }
        v.alertLevel = res.level;
        this.stats.alerts[res.level]++;
        this.stats.waveBack = Math.max(this.stats.waveBack, gap);
      }
    }
  }

  run(seconds) {
    const n = Math.round(seconds / this.c.dt);
    for (let i = 0; i < n; i++) this.step();
    return this.summary();
  }

  summary() {
    const s = this.stats;
    return {
      collisions: s.collisions,
      involved: s.involved,
      severe: s.severe,
      meanImpactKmh: s.collisions ? (s.impactSum / s.collisions) * 3.6 : 0,
      maxImpactKmh: s.maxImpact * 3.6,
      events: s.events,
      alerted: s.alerted,
      alerts: { headsUp: s.alerts[LEVEL.HEADS_UP], warning: s.alerts[LEVEL.WARNING], critical: s.alerts[LEVEL.CRITICAL] },
    };
  }
}

/** Same seed, same traffic, same incident: once without FogLink, once with. */
export function runAB(config = {}, seconds = 240) {
  const base = new Sim({ ...config, foglink: false }).run(seconds);
  const fog = new Sim({ ...config, foglink: true }).run(seconds);
  return { base, fog };
}

export function batchAB(config = {}, seeds = 20, seconds = 240) {
  const rows = [];
  for (let i = 0; i < seeds; i++) rows.push(runAB({ ...config, seed: (config.seed ?? 1) + i }, seconds));
  const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  const out = {
    seeds,
    base: { collisions: mean((r) => r.base.collisions), involved: mean((r) => r.base.involved), severe: mean((r) => r.base.severe), meanImpactKmh: mean((r) => r.base.meanImpactKmh) },
    fog: { collisions: mean((r) => r.fog.collisions), involved: mean((r) => r.fog.involved), severe: mean((r) => r.fog.severe), meanImpactKmh: mean((r) => r.fog.meanImpactKmh) },
    worse: rows.filter((r) => r.fog.involved > r.base.involved).length,
    rows,
  };
  out.reductionPct = out.base.involved ? (100 * (out.base.involved - out.fog.involved)) / out.base.involved : 0;
  return out;
}
