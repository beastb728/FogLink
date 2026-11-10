"""Train the braking model, compare it with the threshold baseline, export it.

  python3 -m foglink_ml.train                      # synthetic drives
  python3 -m foglink_ml.train --drives ../data/drives/*.csv   # logged drives

Labels come from GPS speed alone (see signal.labels); the inputs are the motion
sensors. The headline number is how many milliseconds before GPS the model fires.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

from .signal import FS, align, baseline_fire_times, combine, gps_episodes, labels, score
from .synth import load_csv, make_drive

WIN = 2 * FS  # 2-second window
STEP = 5  # the phone runs the model every 50 ms


class BrakeNet(nn.Module):
    """Small 1D-CNN over a 2 s window of [forward, lateral, vertical, |gyro|]."""

    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv1d(4, 16, 7, stride=2, padding=3), nn.ReLU(),
            nn.Conv1d(16, 32, 5, stride=2, padding=2), nn.ReLU(),
            nn.Conv1d(32, 32, 5, stride=2, padding=2), nn.ReLU(),
        )
        self.head = nn.Linear(32, 1)

    def forward(self, x):  # x: (B, 4, 200), m/s^2 and rad/s
        z = self.net(x / 5.0)
        # the newest second matters most: pool the recent half and the whole window
        return self.head(z[:, :, z.shape[2] // 2:].amax(dim=2)).squeeze(1)


def windows(aligned, idx):
    return np.stack([aligned[i - WIN:i].T for i in idx])


def training_set(drives, rng):
    X, Y = [], []
    for d in drives:
        y = d["y"]
        ends = np.arange(WIN, len(y), STEP)
        pos = ends[y[ends - 1] == 1]
        neg = ends[y[ends - 1] == 0]
        # hard negatives: anything that shakes the phone without being braking
        rough = neg[np.abs(d["aligned"][neg - 1, :3]).max(axis=1) > 2.0]
        neg = np.concatenate([rng.choice(neg, min(len(neg), 6 * len(pos) + 200), replace=False), rough])
        idx = np.concatenate([pos, neg])
        X.append(windows(d["aligned"], idx))
        Y.append(np.concatenate([np.ones(len(pos)), np.zeros(len(neg))]))
    return torch.tensor(np.concatenate(X)), torch.tensor(np.concatenate(Y), dtype=torch.float32)


def model_fire_times(model, d, thr, refractory=2.0):
    ends = np.arange(WIN, len(d["aligned"]), STEP)
    with torch.no_grad():
        p = torch.sigmoid(torch.cat([model(torch.tensor(windows(d["aligned"], ends[i:i + 4096]))) for i in range(0, len(ends), 4096)])).numpy()
    fires, last = [], -1e9
    for k in range(1, len(p)):
        t = ends[k] / FS
        # two consecutive windows over threshold, vehicle moving
        if p[k] >= thr and p[k - 1] >= thr and t - last >= refractory and d["speed_at"](t) > 4:
            fires.append(t)
            last = t
    return fires


def prepare(d):
    d["aligned"], d["align_quality"] = align(d)
    d["y"] = labels(d)
    d["episodes"] = gps_episodes(d)
    gt, gs = d["gps_t"], d["gps_speed"]
    d["speed_at"] = lambda t: float(np.interp(t, gt, gs))
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--drives", nargs="*", help="logged drive CSVs; default is synthetic data")
    ap.add_argument("--train", type=int, default=40)
    ap.add_argument("--test", type=int, default=15)
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "out"))
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(0)
    rng = np.random.default_rng(0)

    if a.drives:
        drives = [prepare(load_csv(p)) for p in a.drives]
        n_test = max(1, len(drives) // 4)
        train, test, source = drives[:-n_test], drives[-n_test:], f"{len(drives)} logged drives"
        if not train:
            sys.exit("need at least 2 drives: one to train on, one held out")
    else:
        train = [prepare(make_drive(s)) for s in range(a.train)]
        test = [prepare(make_drive(10_000 + s)) for s in range(a.test)]
        source = f"synthetic drives ({a.train} train, {a.test} held out, 10 min each)"
    print(f"data: {source}; {sum(len(d['episodes']) for d in train)} GPS-labelled hard-braking episodes to learn from")

    X, Y = training_set(train, rng)
    model = BrakeNet()
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 4e-3, total_steps=a.epochs * (len(X) // 256 + 1))
    lossf = nn.BCEWithLogitsLoss()
    for ep in range(a.epochs):
        perm = torch.randperm(len(X))
        tot = 0.0
        for i in range(0, len(X), 256):
            b = perm[i:i + 256]
            opt.zero_grad()
            loss = lossf(model(X[b]), Y[b])
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item() * len(b)
        print(f"epoch {ep + 1:2d}  loss {tot / len(X):.4f}")
    model.eval()

    # choose the operating threshold on training drives: most recall at >= 95% precision
    best = (0.5, -1)
    for thr in (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
        c = combine([score(model_fire_times(model, d, thr), d["episodes"], d["km"]) for d in train[:12]])
        if c["precision"] >= 0.95 and c["recall"] > best[1]:
            best = (thr, c["recall"])
    thr = best[0]

    res = {
        "data": source,
        "threshold": thr,
        "baseline": combine([score(baseline_fire_times(d["aligned"], d["speed_at"]), d["episodes"], d["km"]) for d in test]),
        "model": combine([score(model_fire_times(model, d, thr), d["episodes"], d["km"]) for d in test]),
        "params": sum(p.numel() for p in model.parameters()),
    }
    torch.save(model.state_dict(), out / "brakenet.pt")
    res["size_kb"] = (out / "brakenet.pt").stat().st_size / 1024
    res["exports"] = export(model, out)
    (out / "metrics.json").write_text(json.dumps(res, indent=2))

    print(f"\nheld-out drives: {res['model']['episodes']} hard-braking episodes over {res['model']['km']:.0f} km")
    print(f"{'':10s} {'precision':>9s} {'recall':>7s} {'earlier than GPS (median / worst 10%)':>38s} {'false alarms /100 km':>21s}")
    for k in ("baseline", "model"):
        r = res[k]
        print(f"{k:10s} {r['precision']:9.1%} {r['recall']:7.1%} {r['lead_ms_median']:22.0f} ms / {r['lead_ms_p10']:5.0f} ms {r['false_alarms_per_100km']:21.2f}")
    print(f"model: {res['params']} parameters, {res['size_kb']:.0f} KB; exported: {', '.join(res['exports'])}")


def export(model, out):
    """TorchScript always; TFLite when ai-edge-torch is installed (pip install ai-edge-torch)."""
    done = []
    example = torch.zeros(1, 4, WIN)
    torch.jit.trace(model, example).save(str(out / "brakenet.torchscript.pt"))
    done.append("TorchScript")
    try:
        import ai_edge_torch  # noqa: PLC0415
        ai_edge_torch.convert(model, (example,)).export(str(out / "brakenet.tflite"))
        done.append("TFLite")
    except Exception as e:  # not installed, or conversion failed
        (out / "tflite_export.log").write_text(f"TFLite export skipped: {type(e).__name__}: {e}\n")
    return done


if __name__ == "__main__":
    main()
