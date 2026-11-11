#!/usr/bin/env node
// Writes test vectors from the JavaScript reference logic, so the Kotlin port in
// android/ can be checked against it:  node sim/cli/vectors.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { assess, phrase, AlertGate, CoverGate, coverState, coverPhrase, COVER } from '../src/core/alert.js';
import { loadRoads, matchCarriageway } from '../src/core/road.js';
import { BrakeDetector } from '../src/phone/detector.js';
import { rng } from '../src/core/sim.js';

const out = new URL('../../android/app/src/test/resources/', import.meta.url);
mkdirSync(out, { recursive: true });

// 1. alert rule and phrases: [gap, v, hazardV, hazardDec, visibility, level, aReq|null, en, hi]
const alert = [];
for (const gap of [-5, 10, 40, 80, 120, 205, 300, 449, 600, 1200, 1900, 2000, 2500])
  for (const v of [0.3, 5, 11, 22, 27.8, 33])
    for (const hv of [0, 0.5, 6, 20])
      for (const hd of [0, 0.9, 1, 4])
        for (const vis of [20, 50, 199, 200]) {
          const r = assess({ gap, v, hazardV: hv, hazardDec: hd, visibility: vis });
          alert.push([gap, v, hv, hd, vis, r.level, Number.isFinite(r.aReq) ? r.aReq : null, phrase(r, 'en'), phrase(r, 'hi')]);
        }

// 2. the gate: [level, timeMs, speaks]
const r = rng(11);
const gate = [];
const g = new AlertGate();
let t = 0;
for (let i = 0; i < 400; i++) {
  t += Math.floor(r() * (r() < 0.05 ? 30000 : 4000));
  const level = Math.floor(r() * 4);
  gate.push([level, t, g.offer(level, t)]);
}

// 3. map matching: [lat, lon, heading|null, previousId|null, matchedId|null, s]
const roads = loadRoads(['nh48', 'yamuna'].map((n) => JSON.parse(readFileSync(new URL(`../../data/roads/${n}.json`, import.meta.url)))));
const match = [];
for (const cw of roads)
  for (let i = 1; i <= 12; i++) {
    const s = (cw.length * i) / 13;
    const [lat, lon] = cw.pointAt(s, (r() - 0.5) * 30);
    const hdg = cw.bearingAt(s);
    for (const [heading, prev, dLat] of [[hdg, null, 0], [(hdg + 180) % 360, null, 0], [null, cw.id, 0], [hdg + 20, null, 0], [hdg, null, 0.002]]) {
      const m = matchCarriageway(roads, lat + dLat, lon, heading, { previousId: prev });
      match.push([lat + dLat, lon, heading, prev, m ? m.cw.id : null, m ? m.s : 0]);
    }
  }

// 4. braking detector: a sensor stream and the events the reference detector fires on it
const up = [0.2, 0.96, 0.2].map((x) => x / Math.hypot(0.2, 0.96, 0.2));
let f = [1, 0, -1];
const d = f[0] * up[0] + f[1] * up[1] + f[2] * up[2];
f = f.map((x, i) => x - d * up[i]);
f = f.map((x) => x / Math.hypot(...f));
const det = new BrakeDetector();
const stream = []; // ["m", t, ax, ay, az, rot|null] or ["g", t, speed, heading]
const fired = []; // [t, kind, source]
let v = 5;
t = 1_700_000_000_000;
const drive = (seconds, acc, bump = 0, rot = null) => {
  for (let i = 0; i < seconds * 50; i++) {
    t += 20;
    v = Math.max(0, v + acc * 0.02);
    const b = bump * Math.sin(i * 0.9);
    const n = () => (r() - 0.5) * 0.3;
    const a = [0, 1, 2].map((k) => +(9.81 * up[k] + acc * f[k] + b * up[k] + n()).toFixed(4));
    stream.push(['m', t, ...a, rot]);
    let e = det.motion(t, a[0], a[1], a[2], rot);
    if (e) fired.push([t, e.kind, e.source]);
    if (t % 1000 === 0) {
      const sp = +v.toFixed(2);
      stream.push(['g', t, sp, 90]);
      e = det.gps(t, sp, 90);
      if (e) fired.push([t, e.kind, e.source]);
    }
  }
};
drive(12, 1.5); drive(10, 0); drive(0.6, 0, 9); drive(5, -1.5); drive(4, 1.5); drive(2, -5);
drive(1, 0, 0, 4); // phone picked up: alignment is dropped
drive(6, 1.2); drive(8, 1.0); drive(3, -6); drive(6, -1.5); drive(6, 0);

// 5. cover status: which state [outdated, relayOpen, gpsFresh, onRoad, state], its phrases, and when the gate speaks
const coverStates = [];
for (let i = 0; i < 16; i++) {
  const c = { outdated: !!(i & 8), relayOpen: !!(i & 4), gpsFresh: !!(i & 2), onRoad: !!(i & 1) };
  coverStates.push([c.outdated, c.relayOpen, c.gpsFresh, c.onRoad, coverState(c)]);
}
const coverPhrases = Object.values(COVER).map((st) => [st, coverPhrase(st, 'en'), coverPhrase(st, 'hi')]);
const coverGate = [];
const cg = new CoverGate();
const all = Object.values(COVER);
let cs = all[0];
t = 0;
for (let i = 0; i < 300; i++) {
  t += 1000;
  if (r() < 0.12) cs = all[Math.floor(r() * all.length)];
  coverGate.push([cs, t, cg.offer(cs, t)]);
}

// 6. toll zones: [carriageway, s, inside]
const toll = [];
for (const cw of roads) {
  for (const [a, b] of cw.tolls) for (const s of [a - 601, a - 599, a, (a + b) / 2, b + 299, b + 301]) toll.push([cw.id, s, cw.inTollZone(s)]);
  for (let i = 0; i < 20; i++) {
    const s = r() * cw.length;
    toll.push([cw.id, s, cw.inTollZone(s)]);
  }
}

writeFileSync(new URL('vectors.json', out), JSON.stringify({ alert, gate, match, detector: { stream, fired }, coverStates, coverPhrases, coverGate, toll }));
console.log(`cover gate ${coverGate.length} (${coverGate.filter((c) => c[2]).length} spoken), toll ${toll.length} (${toll.filter((c) => c[2]).length} inside)`);
console.log(`alert ${alert.length}, gate ${gate.length}, match ${match.length}, detector ${stream.length} samples / ${fired.length} events (${fired.map((e) => e[1] + ':' + e[2]).join(' ')})`);
