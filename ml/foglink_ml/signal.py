"""Orientation alignment, automatic labels from GPS, and the threshold baseline."""
import numpy as np
from scipy.signal import lfilter

G = 9.81
FS = 100
HARD = 0.35 * G


def _ema(x, tau, fs=FS):
    k = (1 / fs) / (tau + 1 / fs)
    return lfilter([k], [1, k - 1], x, axis=0, zi=np.atleast_2d(x[0] * (1 - k)) if x.ndim > 1 else [x[0] * (1 - k)])[0]


def find_moves(acc, gyro):
    """Sample indices where the phone was moved: fast rotation and a new 'down'."""
    g = _ema(acc, 0.5)
    gn = g / np.linalg.norm(g, axis=1, keepdims=True)
    lag = FS
    cos = np.sum(gn[lag:] * gn[:-lag], axis=1)
    spin = np.convolve(np.linalg.norm(gyro, axis=1), np.ones(20) / 20, mode="same")[lag:]
    idx = np.flatnonzero((cos < 0.97) & (spin > 1.0))
    moves, last = [], -10 * FS
    for i in idx:
        if i - last > 3 * FS:
            moves.append(int(i))
        last = i
    return moves


def align(drive):
    """Rotate phone-frame acceleration into the car frame.

    Returns (N,4) float32: forward, lateral, vertical linear acceleration (m/s^2,
    gravity removed; forward > 0 is speeding up) and gyro magnitude (rad/s).
    'Down' comes from slowly low-passed gravity. 'Forward' is the horizontal direction
    whose acceleration best matches GPS speed changes on straight stretches.
    Alignment restarts whenever the phone is moved.
    """
    acc, gyro, t = drive["acc"].astype(np.float64), drive["gyro"].astype(np.float64), drive["t"]
    n = len(acc)
    out = np.zeros((n, 4), dtype=np.float32)
    out[:, 3] = np.linalg.norm(gyro, axis=1)
    gt, gs, gh = drive["gps_t"], drive["gps_speed"], drive["gps_heading"]
    gacc = np.diff(gs) / np.diff(gt)
    turn = np.abs((np.diff(gh) + 180) % 360 - 180) / np.diff(gt)
    turn = np.nan_to_num(turn)
    bounds = [0] + find_moves(acc, gyro) + [n]
    quality = []
    for a, b in zip(bounds, bounds[1:]):
        if b - a < 2 * FS:
            continue
        seg = acc[a:b]
        # the phone is fixed between moves, so gravity is tracked slowly: a quick filter
        # would mistake a few seconds of braking for a change in 'down' and cancel it
        g = _ema(seg, 8.0)
        up = g / np.linalg.norm(g, axis=1, keepdims=True)
        lin = seg - g
        vert = np.sum(lin * up, axis=1)
        h = lin - vert[:, None] * up
        F = np.zeros(3)
        w = 0.0
        for k in range(len(gacc)):
            i0, i1 = int(gt[k] * FS), int(gt[k + 1] * FS)
            if i0 < a or i1 > b or i1 <= i0:
                continue
            if 0.4 < abs(gacc[k]) < 8 and turn[k] < 3 and gs[k] > 3:  # above 8 m/s^2 is a GPS glitch
                F += h[i0 - a:i1 - a].mean(axis=0) * gacc[k]
                w += abs(gacc[k])
        quality.append(w)
        if w < 3:  # never saw the car speed up or slow down in this stretch
            continue
        up0 = up.mean(axis=0)
        up0 /= np.linalg.norm(up0)
        f = F - np.dot(F, up0) * up0
        f /= np.linalg.norm(f)
        lat = np.cross(up0, f)
        out[a:b, 0] = h @ f
        out[a:b, 1] = h @ lat
        out[a:b, 2] = vert
    return out, quality


def gps_episodes(drive, thr=HARD):
    """Hard-braking episodes as GPS sees them: [(t_confirm, t_end)].

    t_confirm is the first GPS fix at which the speed has dropped faster than
    `thr` since the previous fix: the earliest moment GPS alone could know.
    """
    gt, gs = drive["gps_t"], drive["gps_speed"]
    dec = -np.diff(gs) / np.diff(gt)
    hot = (dec >= thr) & (gs[:-1] > 4)
    eps, k = [], 0
    while k < len(hot):
        if hot[k]:
            j = k
            while j + 1 < len(hot) and hot[j + 1]:
                j += 1
            eps.append((float(gt[k + 1]), float(gt[j + 1])))
            k = j + 1
        else:
            k += 1
    return eps


def labels(drive, lead=1.2):
    """Per-sample labels from GPS only: 1 = hard braking, 0 = not, -1 = ignore.

    GPS confirms late, so the positive span starts `lead` seconds before the
    confirming fix; that is what lets the model learn to fire earlier than GPS.
    A guard band either side is ignored rather than called negative.
    """
    y = np.zeros(len(drive["t"]), dtype=np.int8)
    for t0, t1 in gps_episodes(drive):
        a, b = int((t0 - lead) * FS), int(t1 * FS)
        y[max(0, a - FS):min(len(y), b + FS)] = -1
        y[max(0, a):min(len(y), b)] = 1
    return y


def baseline_fire_times(aligned, speed_at, thr=HARD, sustain=0.2, refractory=2.0):
    """Threshold rule on smoothed forward deceleration. Returns fire times (s)."""
    dec = _ema(-aligned[:, 0].astype(np.float64), 0.25)
    over = dec >= thr
    fires, run, last = [], 0, -1e9
    need = int(sustain * FS)
    for i, o in enumerate(over):
        run = run + 1 if o else 0
        if run >= need and i / FS - last >= refractory and speed_at(i / FS) > 4:
            fires.append(i / FS)
            last = i / FS
    return fires


def score(fires, episodes, km):
    """Event-level precision / recall and how much earlier than GPS we fired."""
    used = [False] * len(episodes)
    tp, leads = 0, []
    for f in fires:
        hit = None
        for k, (t0, t1) in enumerate(episodes):
            if t0 - 3.0 <= f <= t1 + 1.0:
                hit = k
                break
        if hit is None:
            continue
        tp += 1
        if not used[hit]:
            used[hit] = True
            leads.append((episodes[hit][0] - f) * 1000)
    return {"fires": len(fires), "tp": tp, "episodes": len(episodes), "found": int(sum(used)), "leads_ms": leads, "km": km}


def combine(scores):
    fires = sum(s["fires"] for s in scores)
    tp = sum(s["tp"] for s in scores)
    eps = sum(s["episodes"] for s in scores)
    found = sum(s["found"] for s in scores)
    leads = np.array([x for s in scores for x in s["leads_ms"]])
    km = sum(s["km"] for s in scores)
    return {
        "precision": tp / fires if fires else 0.0,
        "recall": found / eps if eps else 0.0,
        "lead_ms_median": float(np.median(leads)) if len(leads) else 0.0,
        "lead_ms_p10": float(np.percentile(leads, 10)) if len(leads) else 0.0,
        "false_alarms_per_100km": 100 * (fires - tp) / km if km else 0.0,
        "episodes": eps, "km": km,
    }
