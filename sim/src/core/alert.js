// FogLink alert logic. This one file decides when a phone speaks, and it is used
// unchanged by the phone client and by the simulator's "with FogLink" arm.
// The Kotlin app must mirror it; test/alert.test.mjs pins the behaviour.

export const G = 9.81;
export const HARD_BRAKE_G = 0.35; // a stop event fires above this deceleration
export const HARD_BRAKE = HARD_BRAKE_G * G;
export const SLOW_SPEED = 8; // m/s (~30 km/h): crawling on an expressway is itself a hazard
export const RANGE_M = 2000; // how far back a stop event travels

export const LEVEL = { NONE: 0, HEADS_UP: 1, WARNING: 2, CRITICAL: 3 };
export const LEVEL_NAME = ['none', 'heads-up', 'warning', 'critical'];

// Required-deceleration thresholds between the three levels (m/s^2).
export const WARN_DECEL = 1.0;
export const CRITICAL_DECEL = 3.0;

/** Extra distance held back in fog: the driver gets no visual confirmation until late. */
export function fogMargin(visibilityM) {
  if (visibilityM < 50) return 40;
  if (visibilityM < 200) return 25;
  return 10;
}

/**
 * Can this driver stop in time?
 * @param gap           metres from this vehicle to the reported position (same carriageway, ahead)
 * @param v             own speed, m/s
 * @param hazardV       reported speed of the vehicle ahead, m/s
 * @param hazardDec     reported deceleration, m/s^2 (>= 1 means "it is braking towards a stop")
 * @param visibility    current fog visibility, metres
 * @param reactionS     driver reaction time to a spoken alert, seconds
 * @returns {{level:number, aReq:number, gap:number, stopped:boolean}}
 */
export function assess({ gap, v, hazardV = 0, hazardDec = 0, visibility = 50, reactionS = 1.5 }) {
  const none = { level: LEVEL.NONE, aReq: 0, gap, stopped: false };
  if (!(gap > 0) || gap > RANGE_M) return none;
  const braking = hazardDec >= 1;
  const stopped = hazardV < 1 || braking;
  // Where will the hazard be when we get there? A braking vehicle rolls on a little.
  const effGap = braking ? gap + (hazardV * hazardV) / (2 * hazardDec) : gap;
  const closing = stopped ? v : v - hazardV;
  if (closing <= 0.5) return none;
  const free = effGap - closing * reactionS - fogMargin(visibility);
  const aReq = free > 0 ? (closing * closing) / (2 * free) : Infinity;
  let level = LEVEL.HEADS_UP;
  if (aReq >= CRITICAL_DECEL) level = LEVEL.CRITICAL;
  else if (aReq >= WARN_DECEL) level = LEVEL.WARNING;
  return { level, aReq, gap, stopped };
}

const roundGap = (m) => (m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10));

/** The words that are spoken. Short on purpose: the driver never looks at the screen. */
export function phrase(result, lang = 'en') {
  const d = roundGap(result.gap);
  if (lang === 'hi') {
    if (result.level === LEVEL.CRITICAL) return 'ब्रेक!';
    if (result.level === LEVEL.WARNING)
      return result.stopped ? `${d} मीटर आगे गाड़ी रुकी है।` : `${d} मीटर आगे गाड़ी धीमी है।`;
    if (result.level === LEVEL.HEADS_UP) return 'आगे ट्रैफ़िक धीमा है।';
    return '';
  }
  if (result.level === LEVEL.CRITICAL) return 'BRAKE';
  if (result.level === LEVEL.WARNING)
    return result.stopped ? `Vehicle stopped ${d} metres ahead.` : `Slow vehicle ${d} metres ahead.`;
  if (result.level === LEVEL.HEADS_UP) return 'Slow traffic ahead.';
  return '';
}

/**
 * Stops the phone repeating itself. Speak when the level rises, repeat a standing
 * warning only occasionally, and reset after a quiet period.
 */
export class AlertGate {
  constructor({ repeatMs = 8000, quietMs = 20000 } = {}) {
    this.repeatMs = repeatMs;
    this.quietMs = quietMs;
    this.level = LEVEL.NONE;
    this.lastSpoke = -Infinity;
    this.lastSeen = -Infinity;
  }
  /** @returns {boolean} whether to speak now */
  offer(level, nowMs) {
    if (level === LEVEL.NONE) return false;
    if (nowMs - this.lastSeen > this.quietMs) this.level = LEVEL.NONE;
    this.lastSeen = nowMs;
    const rising = level > this.level;
    const due = level >= LEVEL.WARNING && level === this.level && nowMs - this.lastSpoke >= this.repeatMs;
    if (level < this.level && nowMs - this.lastSpoke >= this.repeatMs) this.level = level; // easing off
    if (rising || due) {
      this.level = level;
      this.lastSpoke = nowMs;
      return true;
    }
    return false;
  }
}

/**
 * Whether the phone can currently warn its driver, and if not, why. Silence must
 * never be mistaken for "all clear", so every change of state is spoken.
 */
export const COVER = { OK: 'ok', RELAY: 'relay', GPS: 'gps', ROAD: 'road', UPDATE: 'update' };

const COVER_PHRASES = {
  ok: ['FogLink active.', 'फ़ॉगलिंक चालू है।'],
  relay: ['FogLink offline. No network. You will not get warnings.', 'फ़ॉगलिंक बंद है। नेटवर्क नहीं है। चेतावनी नहीं मिलेगी।'],
  gps: ['FogLink offline. No GPS signal. You will not get warnings.', 'फ़ॉगलिंक बंद है। जीपीएस सिग्नल नहीं है। चेतावनी नहीं मिलेगी।'],
  road: ['This road is not covered by FogLink.', 'यह सड़क फ़ॉगलिंक में शामिल नहीं है।'],
  update: ['FogLink needs an update. You will not get warnings.', 'फ़ॉगलिंक को अपडेट करना ज़रूरी है। चेतावनी नहीं मिलेगी।'],
};

export function coverPhrase(state, lang = 'en') {
  return COVER_PHRASES[state][lang === 'hi' ? 1 : 0];
}

/** What stands between the phone and a warning, most fundamental first. */
export function coverState({ outdated, relayOpen, gpsFresh, onRoad }) {
  if (outdated) return COVER.UPDATE;
  if (!relayOpen) return COVER.RELAY;
  if (!gpsFresh) return COVER.GPS;
  return onRoad ? COVER.OK : COVER.ROAD;
}

/** Announces a cover state once it has held for a few seconds, so a flicker is not spoken. */
export class CoverGate {
  constructor({ holdMs = 8000 } = {}) {
    this.holdMs = holdMs;
    this.said = null;
    this.pending = null;
    this.since = 0;
  }
  /** @returns {boolean} whether to announce `state` now */
  offer(state, nowMs) {
    if (state !== this.pending) {
      this.pending = state;
      this.since = nowMs;
    }
    if (state === this.said || nowMs - this.since < this.holdMs) return false;
    this.said = state;
    return true;
  }
}

/** Speed (m/s) from which a driver can stop within `dist` metres. */
export function stoppableSpeed(dist, reactionS, decel) {
  // v*tr + v^2/(2b) = dist
  const b = decel;
  return -b * reactionS + Math.sqrt(b * b * reactionS * reactionS + 2 * b * Math.max(dist, 0));
}
