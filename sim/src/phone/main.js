// FogLink phone client (web). The same loop the Android app runs: sense braking,
// report it, and speak when something ahead means this driver may not stop in time.

import yamuna from '../../../data/roads/yamuna.json';
import nh48 from '../../../data/roads/nh48.json';
import { loadRoads, matchCarriageway } from '../core/road.js';
import { assess, phrase, AlertGate, LEVEL } from '../core/alert.js';
import { RelayLink, randomId } from '../core/link.js';
import { BrakeDetector } from './detector.js';

const $ = (id) => document.getElementById(id);
const roads = loadRoads([nh48, yamuna]);
const params = new URLSearchParams(location.search);
const ID_ROTATE_MS = 10 * 60 * 1000;

const st = {
  on: false, lang: params.get('lang') || 'en', visibility: +(params.get('vis') || 50),
  source: params.get('demo') ? 'demo' : 'gps',
  id: randomId(), idAt: Date.now(),
  cw: null, s: 0, speed: 0, heading: null, fixAt: 0,
  delays: [], rec: null, wake: null,
};
const detector = new BrakeDetector();
const gate = new AlertGate();
let link = null;
let audio = null;

// ---------- UI ----------
function seg(id, value, fn) {
  const el = $(id);
  const mark = (v) => [...el.children].forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
  mark(value);
  el.addEventListener('click', (e) => {
    if (!e.target.dataset.v) return;
    mark(e.target.dataset.v);
    fn(e.target.dataset.v);
  });
}
seg('lang', st.lang, (v) => (st.lang = v));
seg('vis', st.visibility, (v) => (st.visibility = +v));
seg('source', st.source, (v) => {
  st.source = v;
  $('demo').hidden = v !== 'demo';
  st.cw = null;
  if (st.on) startPosition();
});
$('demo').hidden = st.source !== 'demo';
roads.forEach((cw) => $('cw').add(new Option(`${cw.roadName} → ${cw.towards}`, cw.id)));
if (params.get('cw')) $('cw').value = params.get('cw');
if (params.get('km')) $('km').value = params.get('km');
if (params.get('kmh')) $('kmh').value = params.get('kmh');

function paint() {
  $('fog').className = st.on ? 'on' : '';
  $('fog').firstChild.textContent = st.on ? 'Fog mode is ON' : 'Fog mode is off';
  $('fog').querySelector('small').textContent = st.on ? 'Listening for vehicles ahead. Tap to switch off.' : 'Tap once before you set off. Then leave the phone alone.';
  $('speed').textContent = st.on ? Math.round(st.speed * 3.6) : '–';
  $('link').textContent = link && link.open ? (link.rtt != null ? `${Math.round(link.rtt)} ms` : 'online') : 'offline';
  $('road').textContent = st.cw ? `${st.cw.roadName} → ${st.cw.towards}` : st.on ? 'Not on a FogLink road' : '–';
  $('roadSub').textContent = st.cw ? `km ${(st.s / 1000).toFixed(1)}` : 'road';
  $('sensor').textContent = !st.on ? '–' : detector.aligned ? 'motion + GPS' : 'GPS only';
  if (st.delays.length) {
    const d = [...st.delays].sort((a, b) => a - b);
    $('delay').textContent = `${Math.round(d[d.length >> 1])} / ${Math.round(d[Math.min(d.length - 1, Math.floor(d.length * 0.95))])} ms`;
  }
}

// ---------- speaking ----------
function beep(level) {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const n = level === LEVEL.CRITICAL ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = level === LEVEL.CRITICAL ? 1320 : 880;
      g.gain.value = 0.5;
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + i * 0.18);
      o.stop(audio.currentTime + i * 0.18 + 0.12);
    }
  } catch { /* no audio: voice and screen still work */ }
}

let hideTimer = 0;
function announce(res) {
  const text = phrase(res, st.lang);
  if (res.level >= LEVEL.WARNING) beep(res.level);
  if ('speechSynthesis' in window) {
    if (res.level === LEVEL.CRITICAL) speechSynthesis.cancel(); // BRAKE never waits behind another sentence
    const u = new SpeechSynthesisUtterance(text);
    u.lang = st.lang === 'hi' ? 'hi-IN' : 'en-IN';
    u.rate = res.level === LEVEL.CRITICAL ? 1.2 : 1.05;
    u.volume = 1;
    speechSynthesis.speak(u);
  }
  if (res.level === LEVEL.CRITICAL && navigator.vibrate) navigator.vibrate([500, 100, 500, 100, 500]);
  const el = $('alert');
  el.textContent = text;
  el.className = 'l' + res.level;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => (el.className = ''), res.level === LEVEL.CRITICAL ? 4000 : 3000);
  log(`${['', 'Heads-up', 'Warning', 'CRITICAL'][res.level]}: “${text}” (${Math.round(res.gap)} m ahead)`);
}

const lines = [];
function log(text) {
  lines.unshift(`${new Date().toLocaleTimeString()}  ${text}`);
  lines.length = Math.min(lines.length, 6);
  $('log').innerHTML = lines.join('<br>');
}

// ---------- relay ----------
function connect() {
  link = new RelayLink();
  link.on('open', paint).on('close', paint).on('pong', paint);
  link.on('alert', (m) => {
    if (!st.on || !st.cw || m.cw !== st.cw.id) return;
    if (m.ts) {
      const d = link.now() - m.ts;
      if (d >= 0 && d < 10000) {
        st.delays.push(d);
        if (st.delays.length > 200) st.delays.shift();
      }
    }
    const res = assess({ gap: m.s - st.s, v: st.speed, hazardV: m.v, hazardDec: m.dec || 0, visibility: st.visibility });
    if (gate.offer(res.level, Date.now())) announce(res);
    paint();
  });
}

function report() {
  if (!st.on) return;
  if (Date.now() - st.idAt > ID_ROTATE_MS) {
    st.id = randomId();
    st.idAt = Date.now();
  }
  if (st.source === 'demo') demoFix();
  else if (Date.now() - st.fixAt > 5000) st.cw = null; // GPS went quiet
  if (st.cw && link) link.send({ t: 'pos', id: st.id, cw: st.cw.id, s: Math.round(st.s * 10) / 10, v: +st.speed.toFixed(1), ts: link.now() });
  paint();
}

function sendStop(ev) {
  if (!st.on || !st.cw || !link) return;
  link.send({ t: 'stop', id: st.id, cw: st.cw.id, s: Math.round(st.s * 10) / 10, v: +st.speed.toFixed(1), dec: +ev.dec.toFixed(1), kind: ev.kind, ts: link.now() });
  if (ev.kind === 'brake') log(`Hard braking reported (${(ev.dec / 9.81).toFixed(2)} g, ${ev.source})`);
}

// ---------- position ----------
let watch = null;
function demoFix() {
  st.cw = roads.find((c) => c.id === $('cw').value) || roads[0];
  st.s = Math.min(Math.max(0, +$('km').value * 1000), st.cw.length);
  st.speed = Math.max(0, +$('kmh').value / 3.6);
}
function startPosition() {
  if (watch != null) navigator.geolocation.clearWatch(watch);
  watch = null;
  if (st.source === 'demo') return demoFix();
  if (!navigator.geolocation) return log('This browser has no GPS access.');
  watch = navigator.geolocation.watchPosition(
    (p) => {
      const c = p.coords;
      st.fixAt = Date.now();
      st.speed = c.speed ?? 0;
      st.heading = st.speed > 3 && c.heading != null && !Number.isNaN(c.heading) ? c.heading : null;
      const m = matchCarriageway(roads, c.latitude, c.longitude, st.heading, { previousId: st.cw?.id });
      st.cw = m ? m.cw : null;
      if (m) st.s = m.s;
      const ev = detector.gps(p.timestamp, st.speed, st.heading);
      if (ev) sendStop(ev);
      if (st.rec) st.rec.push(`${p.timestamp},g,,,,,,,${c.latitude},${c.longitude},${c.speed ?? ''},${c.heading ?? ''},${c.accuracy}`);
    },
    (e) => log(`GPS: ${e.message}`),
    { enableHighAccuracy: true, maximumAge: 0 },
  );
}

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const t = Date.now();
  const rr = e.rotationRate;
  const rot = rr && rr.alpha != null ? (Math.hypot(rr.alpha, rr.beta, rr.gamma) * Math.PI) / 180 : null;
  if (st.on && st.source === 'gps') {
    const ev = detector.motion(t, a.x, a.y, a.z, rot);
    if (ev) sendStop(ev);
  }
  if (st.rec) {
    const r = e.rotationRate || {};
    const rad = Math.PI / 180;
    st.rec.push(`${t},m,${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)},${((r.alpha || 0) * rad).toFixed(4)},${((r.beta || 0) * rad).toFixed(4)},${((r.gamma || 0) * rad).toFixed(4)},,,,,`);
  }
}

async function motionPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
    try {
      await DeviceMotionEvent.requestPermission();
    } catch { /* GPS-only detection still works */ }
  }
  removeEventListener('devicemotion', onMotion);
  addEventListener('devicemotion', onMotion);
}

// ---------- Fog mode ----------
$('fog').addEventListener('click', async () => {
  st.on = !st.on;
  if (st.on) {
    if (!link) connect();
    await motionPermission();
    detector.reset();
    startPosition();
    try {
      st.wake = await navigator.wakeLock?.request('screen');
    } catch { /* screen may sleep; keep the phone plugged in */ }
    if ('speechSynthesis' in window) {
      const hello = new SpeechSynthesisUtterance(st.lang === 'hi' ? 'फ़ॉग मोड चालू' : 'Fog mode on');
      hello.lang = st.lang === 'hi' ? 'hi-IN' : 'en-IN';
      speechSynthesis.speak(hello);
    }
  } else {
    if (watch != null) navigator.geolocation.clearWatch(watch);
    watch = null;
    st.cw = null;
    st.wake?.release?.();
  }
  paint();
});
document.addEventListener('visibilitychange', async () => {
  if (st.on && document.visibilityState === 'visible') {
    try {
      st.wake = await navigator.wakeLock?.request('screen');
    } catch { /* ignore */ }
  }
});

$('brake').addEventListener('click', () => {
  if (!st.on) return log('Switch Fog mode on first.');
  demoFix();
  sendStop({ kind: 'brake', dec: 6, source: 'demo' });
});

// ---------- logger: motion sensors + GPS to a CSV that ml/ reads ----------
$('rec').addEventListener('click', async () => {
  if (!st.rec) {
    await motionPermission();
    st.rec = ['t_ms,kind,ax,ay,az,gx,gy,gz,lat,lon,speed,bearing,acc'];
    if (!st.on && navigator.geolocation && watch == null) {
      st.source = 'gps';
      startPosition();
    }
    $('rec').textContent = 'Stop and save recording';
    log('Recording motion sensors and GPS.');
  } else {
    const blob = new Blob([st.rec.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `foglink-drive-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    a.click();
    log(`Saved ${st.rec.length - 1} rows.`);
    st.rec = null;
    $('rec').textContent = 'Start recording sensors';
  }
});

setInterval(report, 1000);
paint();
window.foglinkPhone = { st, detector, announce };
