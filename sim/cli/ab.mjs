#!/usr/bin/env node
// Headless A/B runs: the same scenarios with and without FogLink.
//   node sim/cli/ab.mjs --vis 20,50,200 --seeds 20 --penetration 0.5
import { batchAB, DEFAULT_CONFIG, ASSUMPTIONS } from '../src/core/sim.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const list = (s, d) => (s ? s.split(',').map(Number) : d);
const vis = list(args.vis, [20, 50, 200]);
const pens = list(args.penetration, [0.1, 0.3, 0.5, 1]);
const seeds = Number(args.seeds ?? 20);
const seconds = Number(args.seconds ?? 240);
const cfg = {};
for (const k of ['vehicles', 'lanes', 'density', 'reactionMean', 'overdrive', 'netLatency', 'alertReaction', 'compliance', 'noIncident'])
  if (args[k] != null) cfg[k] = Number(args[k]);
if (args.noIncident) cfg.incidentAt = null;

const f = (x, d = 1) => x.toFixed(d);
console.log(`| Visibility | FogLink share | Collisions without → with | Vehicles involved without → with | Reduction | Mean impact km/h without → with | Runs where FogLink was worse |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const v of vis) {
  for (const p of pens) {
    const r = batchAB({ ...cfg, visibility: v, penetration: p }, seeds, seconds);
    console.log(`| ${v} m | ${Math.round(p * 100)}% | ${f(r.base.collisions)} → ${f(r.fog.collisions)} | ${f(r.base.involved)} → ${f(r.fog.involved)} | ${f(r.reductionPct, 0)}% | ${f(r.base.meanImpactKmh, 0)} → ${f(r.fog.meanImpactKmh, 0)} | ${r.worse}/${seeds} |`);
  }
}
const c = { ...DEFAULT_CONFIG, ...cfg };
console.log(`\nMean of ${seeds} seeds, ${seconds} s each. ${c.vehicles} vehicles, ${c.lanes} lanes, ${c.density} veh/km/lane, all lanes blocked at t=${c.incidentAt}s.`);
console.log(`reaction ${c.reactionMean}s, overdrive ${c.overdrive}x, detect ${c.detectLatency}s @ ${c.detectRecall * 100}% recall, network ${c.netLatency}s, alert reaction ${c.alertReaction}s, compliance ${c.compliance * 100}%.`);
console.log('\nAssumptions:');
for (const [k, t] of ASSUMPTIONS) console.log(`- ${k}: ${t}`);
