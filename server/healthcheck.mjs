#!/usr/bin/env node
// End-to-end probe of a running relay:  node server/healthcheck.mjs https://foglink-relay.fly.dev
// Checks /healthz, then sends one stop event through the relay's simulated world on a
// carriageway nobody uses and waits for it to reach a client 500 m behind.
// Exits 1 on any failure, so a scheduled run that fails raises an alarm.
const base = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const ws = base.replace(/^http/, 'ws') + '/ws?p=1&world=sim';
const CW = 'healthcheck:probe';
const fail = (why) => { console.error(`FAIL ${base}: ${why}`); process.exit(1); };
const timer = setTimeout(() => fail('timed out after 20 s'), 20000);

const res = await fetch(base + '/healthz').catch((e) => fail(`/healthz unreachable (${e.message})`));
if (!res.ok) fail(`/healthz returned ${res.status}`);

const open = () => new Promise((resolve) => {
  const s = new WebSocket(ws);
  s.onopen = () => resolve(s);
  s.onerror = () => fail('WebSocket would not connect');
});
const behind = await open();
const front = await open();
const id = Math.random().toString(16).slice(2, 12);
const got = new Promise((resolve) => {
  behind.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'hello' && m.min > 1) fail(`relay needs protocol ${m.min}`);
    if (m.t === 'alert' && m.cw === CW) resolve(Date.now() - m.ts);
  };
});
behind.send(JSON.stringify({ t: 'pos', id: `probe-b-${id}`, cw: CW, s: 1000, v: 20, ts: Date.now() }));
await new Promise((r) => setTimeout(r, 500));
front.send(JSON.stringify({ t: 'stop', id: `probe-f-${id}`, cw: CW, s: 1500, v: 0, dec: 6, kind: 'brake', ts: Date.now() }));
const ms = await got;
clearTimeout(timer);
console.log(`OK ${base}: stop event reached the client behind in ${ms} ms`);
process.exit(0);
