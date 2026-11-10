// WebSocket link to the FogLink relay, shared by the phone client and the dashboard.
// Reconnects by itself and keeps an estimate of the relay's clock so that
// event-to-alert delay can be measured across two phones.

export class RelayLink {
  constructor(url = defaultUrl()) {
    this.url = url;
    this.handlers = {};
    this.open = false;
    this.offset = 0; // relay clock minus local clock, ms
    this.rtt = null;
    this._bestRtt = Infinity;
    this._connect();
  }

  on(type, fn) {
    this.handlers[type] = fn;
    return this;
  }

  _emit(type, arg) {
    if (this.handlers[type]) this.handlers[type](arg);
  }

  _connect() {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return void setTimeout(() => this._connect(), 2000);
    }
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this._emit('open');
      this._ping();
      this._timer = setInterval(() => this._ping(), 5000);
    };
    ws.onclose = () => {
      this.open = false;
      clearInterval(this._timer);
      this._emit('close');
      setTimeout(() => this._connect(), 1500);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'pong') {
        const now = Date.now();
        const rtt = now - m.ts;
        this.rtt = rtt;
        if (rtt <= this._bestRtt + 20) {
          // the quickest round trips give the best clock estimate
          this._bestRtt = Math.min(rtt, this._bestRtt);
          this.offset = m.rts - (m.ts + now) / 2;
        }
        this._emit('pong', rtt);
      } else this._emit(m.t, m);
    };
  }

  _ping() {
    this.send({ t: 'ping', ts: Date.now() });
  }

  send(msg) {
    if (this.open && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Local time expressed on the relay's clock: put this in `ts`. */
  now() {
    return Math.round(Date.now() + this.offset);
  }

  close() {
    this.closed = true;
    clearInterval(this._timer);
    if (this.ws) this.ws.close();
  }
}

export function defaultUrl() {
  const q = new URLSearchParams(location.search).get('relay');
  if (q) return q;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/** Random anonymous vehicle ID. Callers rotate it every 10 minutes. */
export function randomId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
