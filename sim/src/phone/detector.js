// Threshold braking detector (the baseline the ML model has to beat).
// Works wherever the phone sits: it finds "down" from gravity and "forward" by
// matching horizontal acceleration against GPS speed changes, then watches the
// forward axis for sustained deceleration. ml/foglink_ml/baseline.py mirrors it.

import { HARD_BRAKE, SLOW_SPEED } from '../core/alert.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

export class BrakeDetector {
  constructor({ threshold = HARD_BRAKE, sustainMs = 200, refractoryMs = 1000 } = {}) {
    this.threshold = threshold;
    this.sustainMs = sustainMs;
    this.refractoryMs = refractoryMs;
    this.reset();
  }

  reset() {
    this.g = null; // gravity estimate (device axes)
    this.F = [0, 0, 0]; // accumulated evidence for the forward direction
    this.weight = 0;
    this.hSum = [0, 0, 0]; // horizontal acceleration summed between GPS fixes
    this.hN = 0;
    this.dec = 0; // smoothed forward deceleration, m/s^2
    this.over = null;
    this.lastFire = -Infinity;
    this.lastT = null;
    this.speed = 0;
    this.lastGps = null;
    this.fastAt = -Infinity;
    this.lastSlow = -Infinity;
    this.quietUntil = 0;
  }

  get aligned() {
    return this.weight >= 6;
  }

  /**
   * Accelerometer sample including gravity, device axes, m/s^2; `rot` is the gyro
   * rotation rate in rad/s if the phone has one. Returns an event or null.
   */
  motion(t, ax, ay, az, rot = null) {
    const a = [ax, ay, az];
    const dt = this.lastT == null ? 0.02 : Math.min(0.2, Math.max(0.001, (t - this.lastT) / 1000));
    this.lastT = t;
    if (!this.g) this.g = a.slice();
    // A sudden change in which way is "down" means the phone was moved or dropped:
    // forget the alignment and stay quiet while it settles. Hard braking also tilts
    // apparent gravity (0.5 g is 27 degrees) but without the phone rotating, so the
    // gyro tells the two apart; without a gyro only a very large tilt counts.
    const cos = dot(a, this.g) / (norm(a) * norm(this.g) || 1);
    if (rot != null ? rot > 2.5 && cos < 0.97 : cos < 0.78) {
      this.g = a.slice();
      this.F = [0, 0, 0];
      this.weight = 0;
      this.quietUntil = t + 1500;
    }
    // gravity is tracked slowly: a quick filter would take a few seconds of braking
    // for a change in "down" and cancel it
    const kg = dt / (8 + dt);
    for (let i = 0; i < 3; i++) this.g[i] += kg * (a[i] - this.g[i]);
    const gn = norm(this.g) || 1;
    const up = this.g.map((x) => x / gn);
    const lin = a.map((x, i) => x - this.g[i]);
    const vert = dot(lin, up);
    const h = lin.map((x, i) => x - vert * up[i]);
    for (let i = 0; i < 3; i++) this.hSum[i] += h[i];
    this.hN++;
    if (!this.aligned || t < this.quietUntil) {
      this.over = null;
      return null;
    }
    const fn = norm(this.F) || 1;
    const fwd = -dot(h, this.F) / fn; // positive = slowing down
    this.dec += (dt / (0.25 + dt)) * (fwd - this.dec);
    if (this.dec >= this.threshold && this.speed > 4) {
      if (this.over == null) this.over = t;
      if (t - this.over >= this.sustainMs && t - this.lastFire >= this.refractoryMs) {
        this.lastFire = t;
        return { kind: 'brake', dec: this.dec, source: 'motion' };
      }
    } else this.over = null;
    return null;
  }

  /** GPS fix: speed in m/s, heading in degrees (or null). Returns an event or null. */
  gps(t, speed, heading) {
    let ev = null;
    const prev = this.lastGps;
    if (prev && t > prev.t) {
      const dt = (t - prev.t) / 1000;
      const acc = (speed - prev.speed) / dt;
      const turn = heading != null && prev.heading != null ? Math.abs(((heading - prev.heading + 540) % 360) - 180) / dt : 0;
      // learn "forward" while speeding up or slowing down in a straight line
      if (this.hN > 0 && Math.abs(acc) > 0.4 && Math.abs(acc) < 8 && turn < 3 && speed > 3 && dt < 3) {
        for (let i = 0; i < 3; i++) this.F[i] += (this.hSum[i] / this.hN) * acc;
        this.weight += Math.abs(acc);
      }
      // GPS alone also catches hard braking, just later
      if (-acc >= this.threshold && prev.speed > 4 && t - this.lastFire >= 1500) {
        this.lastFire = t;
        ev = { kind: 'brake', dec: -acc, source: 'gps' };
      }
    }
    this.hSum = [0, 0, 0];
    this.hN = 0;
    this.lastGps = { t, speed, heading };
    this.speed = speed;
    if (speed > 14) this.fastAt = t;
    // crawling or stopped shortly after expressway speed: keep telling the cars behind
    if (!ev && speed < SLOW_SPEED && t - this.fastAt < 60000 && t - this.lastSlow >= 2000) {
      this.lastSlow = t;
      ev = { kind: speed < 1 ? 'stopped' : 'slow', dec: 0, source: 'gps' };
    }
    return ev;
  }
}
