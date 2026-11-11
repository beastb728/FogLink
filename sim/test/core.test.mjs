import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assess, phrase, AlertGate, LEVEL, stoppableSpeed, CoverGate, coverState, coverPhrase, COVER } from '../src/core/alert.js';
import { Sim, runAB } from '../src/core/sim.js';
import { loadRoads, matchCarriageway } from '../src/core/road.js';
import { BrakeDetector } from '../src/phone/detector.js';

const kmh = (x) => x / 3.6;

test('alert levels follow the stopping-distance check', () => {
  const at = (gap, v = kmh(100)) => assess({ gap, v, hazardV: 0, hazardDec: 0, visibility: 50 }).level;
  assert.equal(at(1900), LEVEL.HEADS_UP);
  assert.equal(at(300), LEVEL.WARNING);
  assert.equal(at(120), LEVEL.CRITICAL);
  assert.equal(at(300, kmh(40)), LEVEL.HEADS_UP, 'a slow vehicle has room');
  assert.equal(at(-5), LEVEL.NONE, 'hazard behind us');
  assert.equal(at(2500), LEVEL.NONE, 'out of range');
  assert.equal(assess({ gap: 200, v: 20, hazardV: 22, hazardDec: 0 }).level, LEVEL.NONE, 'not closing on it');
});

test('thicker fog warns earlier', () => {
  const a = (visibility) => assess({ gap: 205, v: kmh(100), visibility }).level;
  assert.equal(a(300), LEVEL.WARNING);
  assert.equal(a(20), LEVEL.CRITICAL);
});

test('spoken phrases, English and Hindi', () => {
  const warn = assess({ gap: 310, v: kmh(100), visibility: 50 });
  assert.equal(phrase(warn, 'en'), 'Vehicle stopped 300 metres ahead.');
  assert.equal(phrase(warn, 'hi'), '300 मीटर आगे गाड़ी रुकी है।');
  assert.equal(phrase({ level: LEVEL.CRITICAL, gap: 40 }, 'en'), 'BRAKE');
  assert.equal(phrase({ level: LEVEL.HEADS_UP, gap: 1500 }, 'en'), 'Slow traffic ahead.');
});

test('the gate speaks on escalation and does not nag', () => {
  const g = new AlertGate();
  assert.equal(g.offer(LEVEL.HEADS_UP, 0), true);
  assert.equal(g.offer(LEVEL.HEADS_UP, 2000), false);
  assert.equal(g.offer(LEVEL.WARNING, 3000), true);
  assert.equal(g.offer(LEVEL.WARNING, 5000), false, 'heartbeat events must not repeat the warning');
  assert.equal(g.offer(LEVEL.CRITICAL, 6000), true);
  assert.equal(g.offer(LEVEL.WARNING, 6500), false);
  assert.equal(g.offer(LEVEL.HEADS_UP, 40000), true, 'a new episode after a quiet spell');
});

test('stoppableSpeed inverts the stopping distance', () => {
  const v = stoppableSpeed(100, 1.5, 6.5);
  assert.ok(Math.abs(v * 1.5 + (v * v) / 13 - 100) < 1e-6);
});

test('no incident, no collisions, at every fog level', () => {
  for (const visibility of [20, 50, 200]) {
    const s = new Sim({ visibility, vehicles: 400, incidentAt: null, foglink: true }).run(180);
    assert.equal(s.collisions, 0, `visibility ${visibility}`);
  }
});

test('A/B arms are deterministic and start identical', () => {
  const cfg = { vehicles: 400, visibility: 50, seed: 7 };
  const a = runAB(cfg, 120);
  const b = runAB(cfg, 120);
  assert.deepEqual(a, b);
  const x = new Sim({ ...cfg, foglink: false });
  const y = new Sim({ ...cfg, foglink: true });
  assert.deepEqual(x.vehicles.map((v) => [v.s, v.v]), y.vehicles.map((v) => [v.s, v.v]));
});

test('a blocked carriageway in fog piles up, and not in clear air', () => {
  assert.ok(new Sim({ vehicles: 400, visibility: 50, foglink: false }).run(180).involved > 5);
  assert.equal(new Sim({ vehicles: 400, visibility: 400, foglink: false }).run(180).involved, 0);
});

test('with everyone on FogLink the pileup shrinks', () => {
  const { base, fog } = runAB({ vehicles: 400, visibility: 50, penetration: 1, seed: 3 }, 180);
  assert.ok(fog.involved < base.involved / 2, `${base.involved} -> ${fog.involved}`);
  assert.ok(fog.alerted > 0);
});

const roads = loadRoads(['nh48', 'yamuna'].map((r) => JSON.parse(readFileSync(new URL(`../../data/roads/${r}.json`, import.meta.url)))));

test('road lines look like the real roads', () => {
  const len = Object.fromEntries(roads.map((c) => [c.id, c.length / 1000]));
  assert.ok(len['nh48:jaipur'] > 220 && len['nh48:jaipur'] < 270, String(len['nh48:jaipur']));
  assert.ok(len['yamuna:agra'] > 150 && len['yamuna:agra'] < 190, String(len['yamuna:agra']));
});

test('map matching picks the carriageway by heading', () => {
  const jaipur = roads.find((c) => c.id === 'nh48:jaipur');
  const [lat, lon] = jaipur.pointAt(60000);
  const hdg = jaipur.bearingAt(60000);
  const fwd = matchCarriageway(roads, lat, lon, hdg);
  assert.equal(fwd.cw.id, 'nh48:jaipur');
  assert.ok(Math.abs(fwd.s - 60000) < 5);
  // same spot on the map, driving the other way: must match the opposite carriageway
  const back = matchCarriageway(roads, lat, lon, (hdg + 180) % 360);
  assert.equal(back?.cw.id, 'nh48:delhi');
  assert.equal(matchCarriageway(roads, lat + 0.01, lon, hdg), null, '1 km off the road');
});

test('detector: learns forward from GPS, fires on hard braking, ignores a speed breaker', () => {
  // phone lying at an odd angle: gravity mostly along -y, forward along a tilted axis
  const up = [0.2, 0.96, 0.2];
  const un = Math.hypot(...up);
  const U = up.map((x) => x / un);
  let f = [1, 0, -1];
  const d = f[0] * U[0] + f[1] * U[1] + f[2] * U[2];
  f = f.map((x, i) => x - d * U[i]);
  const fn = Math.hypot(...f);
  const F = f.map((x) => x / fn);
  const det = new BrakeDetector();
  let v = 5;
  let t = 0;
  const events = [];
  const drive = (seconds, acc, bump = 0) => {
    for (let i = 0; i < seconds * 50; i++) {
      t += 20;
      v = Math.max(0, v + acc * 0.02);
      const b = bump * Math.sin(i * 0.9);
      const e = det.motion(t, 9.81 * U[0] + acc * F[0] + b * U[0], 9.81 * U[1] + acc * F[1] + b * U[1], 9.81 * U[2] + acc * F[2] + b * U[2]);
      if (e) events.push({ ...e, t });
      if (t % 1000 === 0) {
        const g = det.gps(t, v, 90);
        if (g) events.push({ ...g, t });
      }
    }
  };
  drive(12, 1.5); // pull away: alignment is learned here
  assert.ok(det.aligned);
  drive(10, 0);
  drive(0.6, 0, 9); // speed breaker: violent, but vertical
  drive(5, -1.5); // ordinary braking
  drive(4, 1.5);
  assert.equal(events.length, 0, JSON.stringify(events));
  const t0 = t;
  drive(2, -5);
  assert.equal(events[0]?.kind, 'brake');
  assert.equal(events[0].source, 'motion');
  assert.ok(events[0].t - t0 < 700, `fired after ${events[0].t - t0} ms`);
  // picking the phone up (fast rotation) must not read as braking
  const n = events.length;
  for (let i = 0; i < 50; i++) {
    t += 20;
    const e = det.motion(t, 9.81 * F[0], 9.81 * F[1], 9.81 * F[2], 4);
    if (e) events.push(e);
  }
  assert.equal(events.length, n);
  assert.equal(det.aligned, false, 'alignment is relearned after the phone moves');
});

test('cover status: says why it cannot warn, once the state has held', () => {
  assert.equal(coverState({ outdated: false, relayOpen: true, gpsFresh: true, onRoad: true }), COVER.OK);
  assert.equal(coverState({ outdated: false, relayOpen: false, gpsFresh: true, onRoad: true }), COVER.RELAY);
  assert.equal(coverState({ outdated: false, relayOpen: true, gpsFresh: false, onRoad: false }), COVER.GPS);
  assert.equal(coverState({ outdated: false, relayOpen: true, gpsFresh: true, onRoad: false }), COVER.ROAD);
  assert.equal(coverState({ outdated: true, relayOpen: false, gpsFresh: false, onRoad: false }), COVER.UPDATE);
  assert.match(coverPhrase(COVER.RELAY), /offline/i);
  assert.match(coverPhrase(COVER.RELAY, 'hi'), /चेतावनी/);
  const g = new CoverGate();
  assert.equal(g.offer(COVER.OK, 0), false); // not yet held
  assert.equal(g.offer(COVER.OK, 8000), true);
  assert.equal(g.offer(COVER.OK, 20000), false); // said already
  assert.equal(g.offer(COVER.RELAY, 21000), false);
  assert.equal(g.offer(COVER.OK, 23000), false); // a 2 s drop-out is never spoken
  assert.equal(g.offer(COVER.RELAY, 40000), false);
  assert.equal(g.offer(COVER.RELAY, 48000), true);
});

test('toll plazas are marked on every carriageway', () => {
  const roads = loadRoads(['nh48', 'yamuna'].map((n) => JSON.parse(readFileSync(new URL(`../../data/roads/${n}.json`, import.meta.url)))));
  for (const cw of roads) {
    assert.ok(cw.tolls.length >= 3, `${cw.id} has toll plazas`);
    const [a, b] = cw.tolls[0];
    assert.ok(cw.inTollZone(a - 500) && cw.inTollZone((a + b) / 2) && cw.inTollZone(b + 200));
    assert.ok(!cw.inTollZone(a - 700) || cw.tolls.length > 1);
    const zone = cw.tolls.reduce((sum, [x, y]) => sum + (y - x) + 900, 0);
    assert.ok(zone / cw.length < 0.06, `${cw.id}: toll zones cover ${(100 * zone / cw.length).toFixed(1)}% of the road`);
  }
});
