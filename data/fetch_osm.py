#!/usr/bin/env python3
"""Fetch expressway lines from OpenStreetMap and stitch one polyline per carriageway.

Output: data/roads/<road>.json
  { "id", "name", "carriageways": [ { "id", "towards", "length_m", "line": [[lat, lon], ...] } ] }

Each carriageway line runs in the direction of travel, so "position along the
road" (s, metres from the start of the line) always increases as a car drives.
"Behind" a vehicle therefore means "smaller s on the same carriageway id".

Usage: python3 data/fetch_osm.py [--refresh]
Map data (c) OpenStreetMap contributors, ODbL.
"""
import heapq
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
OUT = HERE / "roads"
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

ROADS = [
    {
        "id": "yamuna",
        "name": "Yamuna Expressway",
        "ends": ("Greater Noida", "Agra"),  # (north/west end, south/east end)
        # the second clause picks up the stretch near Agra that OpenStreetMap has without a name
        "query": 'way["highway"~"^(motorway|trunk)$"]["name"~"Yamuna Expressway",i](27.0,77.3,28.6,78.3);'
                 'way["highway"="motorway"][!"name"](27.13,78.08,27.24,78.15);'
                 'way["highway"="motorway"]["name"~"Agra Ring",i](27.13,78.08,27.24,78.15);',
        "bbox": "27.0,77.3,28.6,78.3",
    },
    {
        "id": "nh48",
        "name": "NH-48 Delhi-Jaipur",
        "ends": ("Delhi", "Jaipur"),
        "query": 'way["highway"~"^(motorway|trunk)$"]["ref"~"(^|;) ?NH ?48(;|$)"](26.85,75.75,28.62,77.25);',
        "bbox": "26.85,75.75,28.62,77.25",
    },
]

R = 6371000.0


def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def fetch(road, refresh=False):
    raw = RAW / f"{road['id']}.json"
    if raw.exists() and not refresh:
        return json.loads(raw.read_text())
    q = f"[out:json][timeout:180];({road['query']});out geom;"
    last = None
    for url in OVERPASS:
        try:
            req = urllib.request.Request(
                url,
                data=urllib.parse.urlencode({"data": q}).encode(),
                headers={"User-Agent": "foglink-osm-fetch/0.1", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=240) as r:
                body = r.read()
            data = json.loads(body)
            if data.get("elements"):
                RAW.mkdir(exist_ok=True)
                raw.write_bytes(body)
                return data
            last = "empty result"
        except Exception as e:  # try the next mirror
            last = e
            print(f"  {url}: {e}", file=sys.stderr)
    raise SystemExit(f"could not fetch {road['id']}: {last}")


def build_graph(data):
    """Directed node graph. One-way ways give one edge per node pair, others two."""
    pos, out, indeg = {}, {}, {}
    for w in data["elements"]:
        if w.get("type") != "way":
            continue
        tags = w.get("tags", {})
        ids, geom = w["nodes"], w["geometry"]
        oneway = tags.get("oneway", "yes" if tags.get("highway") == "motorway" else "no")
        if oneway == "-1":
            ids, geom, oneway = ids[::-1], geom[::-1], "yes"
        for i, n in enumerate(ids):
            pos[n] = (geom[i]["lat"], geom[i]["lon"])
        for a, b in zip(ids, ids[1:]):
            d = hav(pos[a], pos[b])
            out.setdefault(a, []).append((b, d))
            indeg[b] = indeg.get(b, 0) + 1
            if oneway not in ("yes", "true", "1"):
                out.setdefault(b, []).append((a, d))
                indeg[a] = indeg.get(a, 0) + 1
    return pos, out, indeg


def bridge_gaps(pos, out, indeg, max_gap=7000.0, penalty=4.0):
    """Join dead ends to nearby chain starts, where a stretch is tagged differently."""
    starts = [n for n in pos if indeg.get(n, 0) == 0]
    dead = [n for n in pos if not out.get(n)]
    n_bridges = 0
    for d in dead:
        for s in starts:
            if s == d:
                continue
            g = hav(pos[d], pos[s])
            if g <= max_gap:
                out.setdefault(d, []).append((s, g * penalty))
                n_bridges += 1
    return n_bridges


def principal_ends(pos):
    """The two extreme nodes along the main axis of the road."""
    pts = list(pos.values())
    la0 = sum(p[0] for p in pts) / len(pts)
    lo0 = sum(p[1] for p in pts) / len(pts)
    k = math.cos(math.radians(la0))
    xs = [((p[1] - lo0) * k, p[0] - la0) for p in pts]
    sxx = sum(x * x for x, _ in xs)
    syy = sum(y * y for _, y in xs)
    sxy = sum(x * y for x, y in xs)
    th = 0.5 * math.atan2(2 * sxy, sxx - syy)
    ax = (math.cos(th), math.sin(th))
    proj = {n: ((p[1] - lo0) * k) * ax[0] + (p[0] - la0) * ax[1] for n, p in pos.items()}
    lo = min(proj, key=proj.get)
    hi = max(proj, key=proj.get)
    # put the more northern end first so "ends" names line up
    return (lo, hi) if pos[lo][0] > pos[hi][0] else (hi, lo)


def shortest(pos, out, src_pt, dst_pt, radius=1500.0):
    srcs = [n for n, p in pos.items() if hav(p, src_pt) <= radius]
    dsts = {n for n, p in pos.items() if hav(p, dst_pt) <= radius}
    dist = {n: 0.0 for n in srcs}
    prev = {}
    pq = [(0.0, n) for n in srcs]
    heapq.heapify(pq)
    best = None
    while pq:
        d, n = heapq.heappop(pq)
        if d > dist.get(n, 1e18):
            continue
        if n in dsts:
            # keep going to the destination node that is furthest along
            if best is None or d > best[0]:
                best = (d, n)
            # but never leave the destination zone and come back
        for m, w in out.get(n, []):
            nd = d + w
            if nd < dist.get(m, 1e18):
                dist[m] = nd
                prev[m] = n
                heapq.heappush(pq, (nd, m))
    if best is None:
        return None
    path, n = [], best[1]
    while True:
        path.append(n)
        if n not in prev:
            break
        n = prev[n]
    return [pos[n] for n in reversed(path)]


def simplify(line, tol=4.0):
    """Douglas-Peucker in a local metric frame."""
    if len(line) < 3:
        return line
    la0 = line[0][0]
    k = math.cos(math.radians(la0)) * 111320.0
    xy = [((p[1] - line[0][1]) * k, (p[0] - la0) * 110540.0) for p in line]
    keep = [False] * len(line)
    keep[0] = keep[-1] = True
    stack = [(0, len(line) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1e-9
        worst, wi = 0.0, -1
        for i in range(a + 1, b):
            d = abs((xy[i][0] - ax) * dy - (xy[i][1] - ay) * dx) / L
            if d > worst:
                worst, wi = d, i
        if worst > tol:
            keep[wi] = True
            stack += [(a, wi), (wi, b)]
    return [p for p, k_ in zip(line, keep) if k_]


def overpass(q, raw, refresh):
    if raw.exists() and not refresh:
        return json.loads(raw.read_text())
    last = None
    for url in OVERPASS:
        try:
            req = urllib.request.Request(
                url,
                data=urllib.parse.urlencode({"data": q}).encode(),
                headers={"User-Agent": "foglink-osm-fetch/0.1", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=240) as r:
                body = r.read()
            data = json.loads(body)
            if "elements" in data:
                RAW.mkdir(exist_ok=True)
                raw.write_bytes(body)
                return data
            last = "no result"
        except Exception as e:  # try the next mirror
            last = e
            print(f"  {url}: {e}", file=sys.stderr)
    raise SystemExit(f"overpass failed: {last}")


def project(line, cum, pt):
    """(distance along the line, distance from it) of pt's nearest point, in metres."""
    best = (0.0, float("inf"))
    kx = math.cos(math.radians(pt[0])) * 111320.0
    for i in range(len(line) - 1):
        ax, ay = (line[i][1] - pt[1]) * kx, (line[i][0] - pt[0]) * 110540.0
        bx, by = (line[i + 1][1] - pt[1]) * kx, (line[i + 1][0] - pt[0]) * 110540.0
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        f = 0.0 if den == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / den))
        d = math.hypot(ax + f * dx, ay + f * dy)
        if d < best[1]:
            best = (cum[i] + f * (cum[i + 1] - cum[i]), d)
    return best


def add_tolls(refresh=False, max_off=120.0, join=600.0):
    """Mark where each carriageway passes through a toll plaza: "tolls": [[from_m, to_m], ...].

    Phones do not report crawling or queueing inside these stretches (plus a
    margin they add themselves); everyone slows down there and expects to.
    Booths on entry and exit ramps sit well off the main line and are ignored.
    """
    for road in ROADS:
        path = OUT / f"{road['id']}.json"
        doc = json.loads(path.read_text())
        q = f'[out:json][timeout:120];(node["barrier"="toll_booth"]({road["bbox"]});node["highway"="toll_gantry"]({road["bbox"]}););out;'
        nodes = [(e["lat"], e["lon"]) for e in overpass(q, RAW / f"{road['id']}-tolls.json", refresh)["elements"] if e.get("type") == "node"]
        for cw in doc["carriageways"]:
            line = cw["line"]
            cum = [0.0]
            for p_, q_ in zip(line, line[1:]):
                cum.append(cum[-1] + hav(p_, q_))
            hits = sorted(s_ for s_, d in (project(line, cum, n) for n in nodes) if d <= max_off)
            spans = []
            for s_ in hits:
                if spans and s_ - spans[-1][1] <= join:
                    spans[-1][1] = s_
                else:
                    spans.append([s_, s_])
            cw["tolls"] = [[round(a_), round(b_)] for a_, b_ in spans]
            print(f"  {cw['id']}: {len(spans)} toll plazas at km " + ", ".join(f"{(a_ + b_) / 2000:.1f}" for a_, b_ in spans))
        path.write_text(json.dumps(doc, separators=(",", ":")))


def main():
    refresh = "--refresh" in sys.argv
    OUT.mkdir(exist_ok=True)
    if "--tolls-only" in sys.argv:
        return add_tolls(refresh)
    for road in ROADS:
        print(f"{road['name']}:")
        data = fetch(road, refresh)
        pos, out, indeg = build_graph(data)
        nb = bridge_gaps(pos, out, indeg)
        a, b = principal_ends(pos)
        cws = []
        for src, dst, towards in ((a, b, road["ends"][1]), (b, a, road["ends"][0])):
            line = shortest(pos, out, pos[src], pos[dst])
            if not line:
                print(f"  !! no path towards {towards}")
                continue
            raw_len = sum(hav(p, q) for p, q in zip(line, line[1:]))
            jumps = sum(1 for p, q in zip(line, line[1:]) if hav(p, q) > 400)
            line = simplify(line)
            length = sum(hav(p, q) for p, q in zip(line, line[1:]))
            cid = f"{road['id']}:{towards.lower().replace(' ', '-')}"
            cws.append({
                "id": cid,
                "towards": towards,
                "length_m": round(length),
                "line": [[round(p[0], 6), round(p[1], 6)] for p in line],
            })
            print(f"  {cid}: {length/1000:.1f} km (raw {raw_len/1000:.1f}), {len(line)} points, {jumps} gaps >400 m")
        print(f"  ({len(data['elements'])} ways, {len(pos)} nodes, {nb} candidate gap bridges)")
        (OUT / f"{road['id']}.json").write_text(json.dumps({
            "id": road["id"],
            "name": road["name"],
            "attribution": "(c) OpenStreetMap contributors, ODbL",
            "carriageways": cws,
        }, separators=(",", ":")))
    add_tolls(refresh)


if __name__ == "__main__":
    main()
