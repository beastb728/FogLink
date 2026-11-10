"""Synthetic drives, standing in for logged ones until real logs exist.

A drive is a dict of arrays in the same shape the logger produces:
  t      (N,)   seconds, 100 Hz
  acc    (N,3)  accelerometer incl. gravity, phone axes, m/s^2
  gyro   (N,3)  rad/s, phone axes
  gps_t, gps_speed, gps_heading  (M,)  1 Hz, with the lag and noise of a phone GPS
plus ground truth that real logs do not have (true_speed, true_acc, events).

What is modelled: cruising, gentle and hard braking, toll-plaza stops, speed
breakers, potholes, a phone being moved mid-drive, an arbitrary phone
orientation, sensor noise and bias, and GPS speed that lags the vehicle.
What is not: engine vibration spectra, cornering on ramps, a phone sliding on
the seat, GPS multipath. Numbers from this data are a pipeline check, not a
field result.
"""
import numpy as np

G = 9.81
FS = 100


def _rot(rng):
    """Random rotation matrix (phone axes <- car axes)."""
    q = rng.normal(size=4)
    q /= np.linalg.norm(q)
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def _ramp(n, rise):
    """0 -> 1 -> 0 envelope over n samples with `rise` samples of onset/offset."""
    env = np.ones(n)
    r = max(1, min(rise, n // 2))
    env[:r] = np.linspace(0, 1, r, endpoint=False)
    env[-r:] = env[:r][::-1]
    return env


def make_drive(seed, minutes=10.0):
    rng = np.random.default_rng(seed)
    n = int(minutes * 60 * FS)
    jolt = np.zeros(n)  # longitudinal jolts from bumps: felt by the phone, too short to change speed
    az = np.zeros(n)  # vertical extra (bumps)
    ay = np.zeros(n)
    events = []
    v = rng.uniform(18, 28)
    speed = np.empty(n)
    i = 0
    target = v
    while i < n:
        kind = rng.choice(["cruise", "gentle", "hard", "toll", "breaker", "pothole"], p=[0.44, 0.2, 0.12, 0.04, 0.1, 0.1])
        if kind == "cruise":
            d = int(rng.uniform(8, 30) * FS)
            target = rng.uniform(16, 31)
            a = np.clip((target - v) * 0.15, -0.6, 1.2) * np.ones(d)
        elif kind == "gentle":
            dec = rng.uniform(0.08, 0.27) * G
            d = int(min(rng.uniform(2, 6), max(v - 6, 1) / dec) * FS)
            a = -dec * _ramp(max(d, 20), int(0.5 * FS))
        elif kind == "hard":
            dec = rng.uniform(0.42, 0.85) * G
            dv = rng.uniform(8, 26)
            d = int(min(dv, max(v - 0.5, 1)) / dec * FS) + int(0.3 * FS)
            a = -dec * _ramp(max(d, 40), int(rng.uniform(0.15, 0.4) * FS))
            if v > 8:
                events.append(("hard", i / FS, dec))
        elif kind == "toll":
            dec = rng.uniform(0.12, 0.22) * G
            d1 = int(v / dec * FS)
            a = np.concatenate([-dec * _ramp(max(d1, 20), FS), np.zeros(int(rng.uniform(5, 12) * FS)), 1.4 * np.ones(int(8 * FS))])
            events.append(("toll", i / FS, dec))
        elif kind == "breaker":
            # drivers slow gently, then the bump: big vertical, small longitudinal
            dec = rng.uniform(0.1, 0.25) * G
            d1 = int(rng.uniform(1.5, 3) * FS)
            d2 = int(0.5 * FS)
            a = np.concatenate([-dec * _ramp(d1, 40), np.zeros(d2), 0.8 * np.ones(int(2 * FS))])
            j = i + d1
            if j + d2 < n:
                k = np.arange(d2)
                az[j:j + d2] += rng.uniform(0.4, 0.9) * G * np.sin(2 * np.pi * k / d2) * np.hanning(d2)
                jolt[j:j + d2] += -rng.uniform(0.1, 0.3) * G * np.hanning(d2)
            events.append(("breaker", j / FS, 0))
        else:  # pothole: sharp jolt on every axis, far shorter than any braking
            d = int(rng.uniform(1, 3) * FS)
            a = np.zeros(d)
            j = i + rng.integers(0, d)
            w = int(rng.uniform(0.04, 0.1) * FS)
            if j + w < n:
                az[j:j + w] += rng.uniform(0.6, 1.5) * G * np.hanning(w) * rng.choice([-1, 1])
                jolt[j:j + w] += -rng.uniform(0.3, 0.9) * G * np.hanning(w)
            events.append(("pothole", j / FS, 0))
        d = min(len(a), n - i)
        for k in range(d):
            acc = a[k]
            if v <= 0 and acc < 0:
                acc = 0.0
            if v >= 33 and acc > 0:
                acc = 0.0
            v = max(0.0, v + acc * (1 / FS))
            speed[i + k] = v
        i += d
    true_acc = np.gradient(speed, 1 / FS)
    # slow lateral sway and gentle curves
    ay += np.convolve(rng.normal(0, 3.0, n), np.ones(400) / 400, mode="same")
    yaw = ay / np.maximum(speed, 3.0)
    # road vibration grows with speed
    vib = rng.normal(0, 1, (n, 3)) * (0.08 + 0.012 * speed)[:, None]
    car = np.stack([true_acc + jolt, ay, az + G], axis=1)  # specific force in car axes: x forward, z up
    car += vib

    # phone orientation: fixed, except when somebody moves the phone
    R = _rot(rng)
    acc = car @ R.T
    gyro = np.stack([np.zeros(n), np.zeros(n), yaw], axis=1) @ R.T + rng.normal(0, 0.01, (n, 3))
    moves = []
    if rng.random() < 0.4:
        j = int(rng.uniform(0.3, 0.7) * n)
        R2 = _rot(rng)
        acc[j:] = car[j:] @ R2.T
        gyro[j:] = np.stack([np.zeros(n - j), np.zeros(n - j), yaw[j:]], axis=1) @ R2.T + rng.normal(0, 0.01, (n - j, 3))
        w = int(0.4 * FS)
        acc[j:j + w] += rng.normal(0, 6.0, (w, 3))  # the fumble itself
        gyro[j:j + w] += rng.normal(0, 3.0, (w, 3))
        moves.append(j / FS)
        events.append(("phone_move", j / FS, 0))
    acc += rng.normal(0, 0.05, 3)  # bias
    acc += rng.normal(0, 0.12, (n, 3))

    # GPS: 1 Hz, speed lags the vehicle (receiver filtering) and is noisy
    lag = rng.uniform(0.5, 1.1)
    gps_t = np.arange(1.0, n / FS, 1.0) + rng.uniform(0, 0.2)
    gps_t = gps_t[gps_t < n / FS - 0.01]
    k = int(lag * FS)
    smooth = np.convolve(np.concatenate([np.full(k, speed[0]), speed]), np.ones(k) / k, mode="full")[k:k + n]  # causal average (lag/2) sampled lag/2 late: `lag` seconds behind the car
    idx = np.clip(((gps_t - lag / 2) * FS).astype(int), 0, n - 1)
    gps_speed = np.maximum(0, smooth[idx] + rng.normal(0, 0.15, len(gps_t)))
    gps_heading = (90 + np.degrees(np.cumsum(yaw) / FS)[np.clip((gps_t * FS).astype(int), 0, n - 1)]) % 360
    return {
        "t": np.arange(n) / FS, "acc": acc.astype(np.float32), "gyro": gyro.astype(np.float32),
        "gps_t": gps_t, "gps_speed": gps_speed, "gps_heading": gps_heading,
        "true_speed": speed, "true_acc": true_acc, "events": events, "km": float(speed.sum() / FS / 1000),
    }


def load_csv(path):
    """Read a drive recorded by the FogLink logger (phone client or Android app)."""
    import csv
    mt, acc, gyro, gt, gs, gh = [], [], [], [], [], []
    with open(path) as f:
        for r in csv.DictReader(f):
            t = float(r["t_ms"]) / 1000
            if r["kind"] == "m":
                mt.append(t)
                acc.append([float(r["ax"]), float(r["ay"]), float(r["az"])])
                gyro.append([float(r["gx"] or 0), float(r["gy"] or 0), float(r["gz"] or 0)])
            elif r["kind"] == "g" and r["speed"] not in ("", "null"):
                gt.append(t)
                gs.append(float(r["speed"]))
                gh.append(float(r["bearing"]) if r["bearing"] not in ("", "null", "NaN") else np.nan)
    mt, acc, gyro = np.array(mt), np.array(acc, dtype=np.float32), np.array(gyro, dtype=np.float32)
    t0 = mt[0]
    # resample to a steady 100 Hz: browsers deliver 60 Hz, Android 100-200 Hz
    t = np.arange(0, mt[-1] - t0, 1 / FS)
    acc = np.stack([np.interp(t, mt - t0, acc[:, i]) for i in range(3)], axis=1).astype(np.float32)
    gyro = np.stack([np.interp(t, mt - t0, gyro[:, i]) for i in range(3)], axis=1).astype(np.float32)
    gs = np.array(gs)
    return {"t": t, "acc": acc, "gyro": gyro, "gps_t": np.array(gt) - t0, "gps_speed": gs, "gps_heading": np.array(gh),
            "events": [], "km": float(np.trapz(gs, np.array(gt)) / 1000) if len(gs) > 1 else 0.0}
