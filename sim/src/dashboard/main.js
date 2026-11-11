import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import yamuna from '../../../data/roads/yamuna.json';
import nh48 from '../../../data/roads/nh48.json';
import { loadRoads } from '../core/road.js';
import { Sim, ASSUMPTIONS, batchAB } from '../core/sim.js';
import { RelayLink } from '../core/link.js';

const $ = (id) => document.getElementById(id);
const roads = loadRoads([nh48, yamuna]);
const VIEW_BACK = 3200; // metres of road shown behind the incident
const VIEW_AHEAD = 500;

const state = { running: false, speed: 1, mapArm: 'fog', focus: 0, base: null, fog: null, cw: roads[0], s0: 40000, acc: 0, last: 0 };
const phones = new Map(); // real phones seen through the relay: id -> {s, v, t}

// ---------- controls ----------
const roadSel = $('road');
roads.forEach((cw, i) => roadSel.add(new Option(`${cw.roadName} → ${cw.towards}`, i)));
const sliders = [...document.querySelectorAll('aside input[type=range]')];
const showValue = (el) => (el.previousElementSibling.textContent = el.value + (el.dataset.unit || ''));
sliders.forEach((el) => {
  showValue(el);
  el.addEventListener('input', () => {
    showValue(el);
    if (el.id === 'visibility') markSeg('visPreset', el.value);
    reset();
  });
});
function markSeg(id, v) {
  for (const b of $(id).children) b.classList.toggle('on', b.dataset.v === String(v));
}
function seg(id, fn) {
  $(id).addEventListener('click', (e) => {
    if (!e.target.dataset.v) return;
    markSeg(id, e.target.dataset.v);
    fn(e.target.dataset.v);
  });
}
seg('speed', (v) => (state.speed = +v));
seg('mapArm', (v) => (state.mapArm = v));
seg('visPreset', (v) => {
  $('visibility').value = v;
  showValue($('visibility'));
  reset();
});
roadSel.addEventListener('change', reset);
$('startKm').addEventListener('change', reset);
$('reset').addEventListener('click', reset);
$('play').addEventListener('click', () => setRunning(!state.running));
$('crash').addEventListener('click', () => {
  inject(state.focus);
  setRunning(true);
});
$('assumptions').innerHTML = ASSUMPTIONS.map(([k, t]) => `<li><b>${k}.</b> ${t.replace(/`/g, '')}</li>`).join('');

function config() {
  const n = (id) => +$(id).value;
  const trucks = n('trucks') / 100;
  const buses = n('buses') / 100;
  return {
    seed: n('seed'), vehicles: n('vehicles'), density: n('density'),
    mix: { car: Math.max(0.05, 1 - trucks - buses), bus: buses, truck: trucks },
    visibility: n('visibility'), reactionMean: n('reactionMean'), overdrive: n('overdrive'),
    penetration: n('penetration') / 100, netLatency: n('netLatency'), alertReaction: n('alertReaction'), compliance: n('compliance') / 100,
    incidentAt: null,
  };
}

function setRunning(on) {
  state.running = on;
  state.last = performance.now();
  $('play').textContent = on ? 'Pause' : 'Start';
}

function reset() {
  const cfg = config();
  state.cw = roads[+roadSel.value];
  state.base = new Sim({ ...cfg, foglink: false });
  state.fog = new Sim({ ...cfg, foglink: true });
  const maxStart = Math.max(0, state.cw.length - state.fog.length - 500);
  state.s0 = Math.min(Math.max(0, +$('startKm').value * 1000), maxStart);
  state.focus = state.fog.length * 0.7;
  state.fog.onEvent = bridgeOut;
  setRunning(false);
  phoneLink();
  drawRoad();
  render();
}

function phoneLink() {
  const km = ((state.s0 + state.focus - 800) / 1000).toFixed(2);
  document.querySelector('a.link').href = `/phone.html?demo=1&cw=${encodeURIComponent(state.cw.id)}&km=${km}&kmh=80&vis=${state.fog.c.visibility}`;
}

function inject(s) {
  state.focus = s;
  phoneLink();
  state.base.inject(s, true);
  state.fog.inject(s, true);
  fitMap();
}

// ---------- live relay: real phones join the simulation ----------
const relayChip = $('relay');
// The dashboard lives in the relay's simulated world: its virtual events reach
// phones showing a demo position and can never reach a phone reporting a real one.
const link = new RelayLink(undefined, { world: 'sim' });
const chip = () => {
  const n = [...phones.values()].filter((p) => Date.now() - p.t < 5000).length;
  relayChip.className = 'chip ' + (link.open ? 'on' : 'off');
  relayChip.textContent = link.open ? `Relay connected · ${n} phone${n === 1 ? '' : 's'} joined` : 'Relay offline (simulation only)';
};
link.on('open', () => {
  link.send({ t: 'observe' });
  chip();
});
link.on('close', chip);
const onPhonePos = (m) => {
  if (m.cw === state.cw.id) phones.set(m.id, { s: m.s - state.s0, v: m.v, t: Date.now() });
  chip();
};
const onPhoneStop = (m) => {
  // a phone braked: virtual cars behind it hear about it too
  if (m.id.startsWith('sim-') || m.cw !== state.cw.id || !state.fog) return;
  const ev = { t: state.fog.t, s: m.s - state.s0, v: m.v, dec: m.dec || 0, lane: 0, kind: m.kind, from: -1, real: true };
  state.fog.recentEvents.push(ev);
  state.fog.deliver(ev);
};
link.on('pos', onPhonePos);
link.on('stop', onPhoneStop);
// With ?token=<the relay's observer token>, also watch phones reporting real
// positions. That feed is read-only: nothing the dashboard does reaches them.
const token = new URLSearchParams(location.search).get('token');
if (token) {
  const real = new RelayLink();
  real.on('open', () => real.send({ t: 'observe', token }));
  real.on('pos', onPhonePos);
  real.on('stop', onPhoneStop);
}
function bridgeOut(ev) {
  // virtual stop events go through the real relay, so a phone in a real car hears them
  link.send({ t: 'stop', id: 'sim-' + ev.from, cw: state.cw.id, s: Math.round((state.s0 + ev.s) * 10) / 10, v: +ev.v.toFixed(1), dec: +ev.dec.toFixed(1), kind: ev.kind, ts: link.now() });
}

// ---------- map ----------
const map = L.map('map', { zoomSnap: 0.25, attributionControl: true });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
map.setView([28.2, 76.8], 9);
let roadLine = null;
let stretchLine = null;
const mapCanvas = L.DomUtil.create('canvas', '', map.getPanes().overlayPane);
mapCanvas.style.pointerEvents = 'none';
mapCanvas.style.height = 'auto';
function sizeMapCanvas() {
  const size = map.getSize();
  const dpr = devicePixelRatio || 1;
  mapCanvas.width = size.x * dpr;
  mapCanvas.height = size.y * dpr;
  mapCanvas.style.width = size.x + 'px';
  mapCanvas.style.height = size.y + 'px';
  L.DomUtil.setPosition(mapCanvas, map.containerPointToLayerPoint([0, 0]));
}
map.on('move zoom resize viewreset', () => {
  sizeMapCanvas();
  drawMap();
});

function stretchPoints(a, b, step = 60) {
  const pts = [];
  for (let s = a; s < b; s += step) pts.push(state.cw.pointAt(state.s0 + s));
  pts.push(state.cw.pointAt(state.s0 + b));
  return pts;
}
function drawRoad() {
  if (roadLine) roadLine.remove();
  if (stretchLine) stretchLine.remove();
  roadLine = L.polyline(state.cw.line, { color: '#5b6b82', weight: 2, opacity: 0.7 }).addTo(map);
  stretchLine = L.polyline(stretchPoints(0, state.fog.length), { color: '#c9d4e3', weight: 5, opacity: 0.35 }).addTo(map);
  fitMap();
}
function fitMap() {
  map.fitBounds(L.latLngBounds(stretchPoints(state.focus - VIEW_BACK, state.focus + VIEW_AHEAD, 200)), { padding: [30, 30], animate: false });
  sizeMapCanvas();
}

const COLORS = { plain: '#8a94a6', equipped: '#4aa8ff', alerted: '#ffc53d', critical: '#ff8a1f', crashed: '#ff4d4f' };
function colour(v, sim) {
  if (v.crashed) return COLORS.crashed;
  if (!sim.c.foglink || !v.equipped) return COLORS.plain;
  // an alert colours the vehicle only while it is still relevant
  if (v.alertLevel && v.hz && v.hz.s > v.s - 50 && sim.t - v.hz.t < 10) return v.alertLevel === 3 ? COLORS.critical : COLORS.alerted;
  return COLORS.equipped;
}

function drawMap() {
  const sim = state[state.mapArm];
  if (!sim) return;
  const ctx = mapCanvas.getContext('2d');
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const size = map.getSize();
  ctx.clearRect(0, 0, size.x, size.y);
  const z = map.getZoom();
  const r = z >= 15 ? 3.2 : z >= 13 ? 2.4 : 1.8;
  const spread = z >= 16 ? 3.7 : z >= 14 ? 9 : 22; // exaggerate lane spacing when zoomed out so lanes stay visible
  const mid = (sim.c.lanes - 1) / 2;
  const cw = state.cw;
  const put = (s, lane) => map.latLngToContainerPoint(cw.pointAt(state.s0 + s, (lane - mid) * spread));
  for (const ev of sim.recentEvents) {
    const age = sim.t - ev.t;
    if (age > 1.5) continue;
    const p = put(ev.s, ev.lane);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4 + age * 26, 0, 6.3);
    ctx.strokeStyle = `rgba(255,197,61,${0.9 - age * 0.6})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  for (const v of sim.vehicles) {
    const p = put(v.s, v.lane);
    if (p.x < -5 || p.y < -5 || p.x > size.x + 5 || p.y > size.y + 5) continue;
    ctx.fillStyle = colour(v, sim);
    ctx.beginPath();
    ctx.arc(p.x, p.y, v.crashed ? r + 1 : r, 0, 6.3);
    ctx.fill();
  }
  for (const [id, ph] of phones) {
    if (Date.now() - ph.t > 5000) { phones.delete(id); continue; }
    const p = put(ph.s, mid);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, 6.3);
    ctx.fillStyle = COLORS.equipped;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
}

// ---------- strips ----------
function drawStrip(canvas, sim) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const a = state.focus - VIEW_BACK;
  const span = VIEW_BACK + VIEW_AHEAD;
  const x = (s) => ((s - a) / span) * w;
  const lanes = sim.c.lanes;
  const top = 12;
  const laneH = (h - 32) / lanes;
  ctx.fillStyle = '#10151c';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#1b222d';
  ctx.fillRect(0, top, w, laneH * lanes);
  ctx.strokeStyle = '#2c3646';
  ctx.setLineDash([8, 8]);
  for (let l = 1; l < lanes; l++) { ctx.beginPath(); ctx.moveTo(0, top + l * laneH); ctx.lineTo(w, top + l * laneH); ctx.stroke(); }
  ctx.setLineDash([]);
  // the warning moving backward: each stop event sweeps 2 km back through traffic
  if (sim.c.foglink) {
    for (const ev of sim.recentEvents) {
      const age = sim.t - ev.t - sim.c.netLatency;
      if (age < 0 || age > 1.2) continue;
      const x1 = x(ev.s);
      const x0 = x(ev.s - sim.c.rangeM * Math.min(1, age / 0.6));
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, `rgba(255,197,61,${0.55 * (1 - age / 1.2)})`);
      g.addColorStop(1, 'rgba(255,197,61,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x0, top, x1 - x0, laneH * lanes);
    }
  }
  for (const inc of sim.incidents) {
    ctx.fillStyle = 'rgba(255,77,79,.25)';
    ctx.fillRect(x(inc.s) - 1, 0, 2, h - 14);
  }
  for (const v of sim.vehicles) {
    if (v.s < a || v.s - v.len > a + span) continue;
    const px = x(v.s - v.len);
    const pw = Math.max(3, x(v.s) - px);
    // lane 0 is the slow lane: drawn at the bottom
    const y = top + (lanes - 1 - v.lane) * laneH + laneH * 0.22;
    ctx.fillStyle = colour(v, sim);
    ctx.fillRect(px, y, pw, laneH * 0.56);
  }
  if (sim.c.foglink) {
    for (const ph of phones.values()) {
      if (ph.s < a || ph.s > a + span) continue;
      ctx.beginPath();
      ctx.arc(x(ph.s), top + (laneH * lanes) / 2, 6, 0, 6.3);
      ctx.fillStyle = COLORS.equipped;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  // distance marks, and how far a driver can actually see
  ctx.fillStyle = '#8d99ab';
  ctx.font = '11px system-ui';
  ctx.textAlign = 'center';
  const k0 = Math.ceil((state.s0 + a) / 500) * 500;
  for (let m = k0; m < state.s0 + a + span; m += 500) ctx.fillText(`km ${(m / 1000).toFixed(1)}`, x(m - state.s0), h - 3);
  const vw = Math.max(x(a + sim.c.visibility), 1);
  ctx.fillStyle = '#e6ebf2';
  ctx.fillRect(8, 2, vw, 2);
  ctx.fillRect(8, 0, 1, 6);
  ctx.fillRect(8 + vw, 0, 1, 6);
  ctx.font = '10px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText(`${sim.c.visibility} m of sight`, 8 + vw + 6, 8);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#8d99ab';
  ctx.fillText('traffic →', w - 8, 8);
}

for (const id of ['stripBase', 'stripFog']) {
  $(id).addEventListener('click', (e) => {
    const r = e.target.getBoundingClientRect();
    inject(state.focus - VIEW_BACK + ((e.clientX - r.left) / r.width) * (VIEW_BACK + VIEW_AHEAD));
    setRunning(true);
  });
}

function stat(label, value, cls = '') {
  return `<span class="${cls}"><b>${value}</b>${label}</span>`;
}
function drawStats() {
  const b = state.base.summary();
  const f = state.fog.summary();
  $('statsBase').innerHTML = stat('collisions', b.collisions, b.collisions ? 'big' : '') + stat('vehicles involved', b.involved, b.involved ? 'big' : '') + stat('km/h mean impact', b.meanImpactKmh.toFixed(0));
  const diff = b.involved ? Math.round((100 * (b.involved - f.involved)) / b.involved) : null;
  $('statsFog').innerHTML =
    stat('collisions', f.collisions, f.collisions ? 'big' : '') + stat('vehicles involved', f.involved, f.involved ? 'big' : '') + stat('km/h mean impact', f.meanImpactKmh.toFixed(0)) +
    stat('stop events', f.events) + stat('drivers alerted', f.alerted) +
    (diff == null ? '' : stat('vehicles involved, this run', (diff >= 0 ? '−' : '+') + Math.abs(diff) + '%', diff > 0 ? 'gain' : diff < 0 ? 'big' : ''));
  $('clock').textContent = `t = ${state.fog.t.toFixed(1)} s · ${state.fog.vehicles.length} vehicles on ${(state.fog.length / 1000).toFixed(1)} km`;
}

function render() {
  drawStrip($('stripBase'), state.base);
  drawStrip($('stripFog'), state.fog);
  drawMap();
  drawStats();
}

function frame(now) {
  if (state.running) {
    state.acc += Math.min(0.1, (now - state.last) / 1000) * state.speed;
    let n = 0;
    while (state.acc >= 0.1 && n < 40) {
      state.base.step();
      state.fog.step();
      state.acc -= 0.1;
      n++;
    }
    if (n === 40) state.acc = 0;
    render();
  }
  state.last = now;
  requestAnimationFrame(frame);
}

// ---------- batch A/B ----------
$('batch').addEventListener('click', async () => {
  const btn = $('batch');
  btn.disabled = true;
  const cfg = { ...config(), incidentAt: 20 };
  const rows = [];
  for (const vis of [20, 50, 200]) {
    const runs = [];
    for (let i = 0; i < 10; i++) {
      btn.textContent = `Running… ${vis} m, ${i + 1}/10`;
      await new Promise((r) => setTimeout(r));
      runs.push(batchAB({ ...cfg, visibility: vis, seed: 100 + i }, 1, 240).rows[0]);
    }
    const mean = (f) => runs.reduce((s, r) => s + f(r), 0) / runs.length;
    const bi = mean((r) => r.base.involved);
    const fi = mean((r) => r.fog.involved);
    rows.push(`<tr><td>${vis} m</td><td>${bi.toFixed(1)}</td><td>${fi.toFixed(1)}</td><td>${bi ? ((100 * (bi - fi)) / bi).toFixed(0) + '%' : '–'}</td><td>${mean((r) => r.base.meanImpactKmh).toFixed(0)} → ${mean((r) => r.fog.meanImpactKmh).toFixed(0)}</td><td>${runs.filter((r) => r.fog.involved > r.base.involved).length}/10</td></tr>`);
  }
  $('batchOut').innerHTML = `<table><tr><th>Visibility</th><th>Involved, without</th><th>Involved, with</th><th>Fewer</th><th>Mean impact km/h</th><th>Runs FogLink did worse</th></tr>${rows.join('')}</table>`;
  $('batchNote').textContent = `Mean of 10 runs of 240 s. ${cfg.vehicles} vehicles, ${Math.round(cfg.penetration * 100)}% running FogLink, ${Math.round(cfg.compliance * 100)}% of alerted drivers act after ${cfg.alertReaction} s, network delay ${cfg.netLatency} s, reaction ${cfg.reactionMean} s, overdriving sight ${cfg.overdrive}×. Change any of these and the numbers change.`;
  btn.textContent = 'Run 10 seeds × 3 fog levels';
  btn.disabled = false;
});

addEventListener('resize', render);
reset();
requestAnimationFrame(frame);
window.foglink = Object.assign(state, { render }); // for poking at from the console
