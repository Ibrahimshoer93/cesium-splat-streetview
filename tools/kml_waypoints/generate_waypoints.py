"""Generate KML waypoints along a city's street network for the Cesium viewer.

Reads a tiler `tiles.json` to pin down the WGS84 footprint, queries OSM's
Overpass API for walkable ways inside that bbox, samples N evenly-spaced
points along the union of street centerlines, and writes:

  <out-dir>/<prefix>_waypoints.kml          # KML Placemarks (blue dot per point)
  <out-dir>/<prefix>_waypoints_OrbitPos.txt # Pan/Tilt/Roll per point (along-street)

Output schema mirrors the legacy KAFD waypoint files so the existing
`main.ts::parseKmlAndApplyRotations` logic can consume them unchanged.

Self-contained: only depends on `urllib` (stdlib) and `pyproj` (already in
the env for the tiler). No osmnx / geopandas / pandas needed.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from pyproj import Transformer

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Highway types worth walking down. Excludes motorway/trunk (no foot access)
# and the smallest service/track classes to keep the dot density reasonable.
WALKABLE_HIGHWAYS = (
    "primary", "primary_link",
    "secondary", "secondary_link",
    "tertiary", "tertiary_link",
    "residential", "living_street", "unclassified",
    "pedestrian", "footway", "path",
)


def fetch_ways(south: float, west: float, north: float, east: float) -> dict:
    """Hit Overpass for the walkable street network in the bbox."""
    highway_regex = "^(" + "|".join(WALKABLE_HIGHWAYS) + ")$"
    query = f"""
[out:json][timeout:60];
(
  way["highway"~"{highway_regex}"]({south},{west},{north},{east});
);
(._;>;);
out body;
"""
    body = urllib.parse.urlencode({"data": query}).encode("ascii")
    req = urllib.request.Request(
        OVERPASS_URL,
        data=body,
        method="POST",
        headers={
            # Overpass returns 406 if these are missing or generic.
            "User-Agent": "cesium-gaussian-splatting-waypoint-generator/0.1 (github.com/Ibrahimshoer93)",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )
    print(f"  POST {OVERPASS_URL}  bbox=({south:.4f},{west:.4f},{north:.4f},{east:.4f})")
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_ways(payload: dict) -> list[list[tuple[float, float]]]:
    """Resolve way node refs into a list of lon/lat polylines."""
    nodes: dict[int, tuple[float, float]] = {}
    for el in payload.get("elements", []):
        if el.get("type") == "node":
            nodes[el["id"]] = (el["lon"], el["lat"])
    ways: list[list[tuple[float, float]]] = []
    for el in payload.get("elements", []):
        if el.get("type") != "way":
            continue
        coords = [nodes[n] for n in el.get("nodes", []) if n in nodes]
        if len(coords) >= 2:
            ways.append(coords)
    return ways


def sample_along_ways(
    ways: list[list[tuple[float, float]]],
    n_target: int,
    utm_epsg: str,
) -> list[tuple[float, float, float]]:
    """Project ways to UTM, walk all segments end-to-end, emit n_target points
    spaced uniformly by along-network distance. Each entry: (lon, lat, heading_deg)."""
    to_utm = Transformer.from_crs("EPSG:4326", utm_epsg, always_xy=True)
    to_wgs = Transformer.from_crs(utm_epsg, "EPSG:4326", always_xy=True)

    segments: list[tuple[tuple[float, float], tuple[float, float]]] = []
    for coords in ways:
        utm = [to_utm.transform(lon, lat) for lon, lat in coords]
        for i in range(len(utm) - 1):
            segments.append((utm[i], utm[i + 1]))

    if not segments:
        return []

    seg_lengths = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in segments]
    total_len = sum(seg_lengths)
    if total_len == 0 or n_target <= 0:
        return []
    spacing = total_len / n_target

    points: list[tuple[float, float, float]] = []
    cumulative = 0.0
    for (a, b), L in zip(segments, seg_lengths):
        if L == 0:
            continue
        # Sample positions that fall inside [cumulative, cumulative + L].
        i0 = int(cumulative // spacing) + 1
        i1 = int((cumulative + L) // spacing)
        for i in range(i0, i1 + 1):
            global_d = i * spacing
            local_d = global_d - cumulative
            if local_d < 0 or local_d > L:
                continue
            t = local_d / L
            x = a[0] + t * (b[0] - a[0])
            y = a[1] + t * (b[1] - a[1])
            # Heading from segment direction; UTM x=East, y=North; heading
            # is clockwise from North.
            dx = b[0] - a[0]
            dy = b[1] - a[1]
            heading = math.degrees(math.atan2(dx, dy))
            if heading < 0:
                heading += 360.0
            lon, lat = to_wgs.transform(x, y)
            points.append((lon, lat, heading))
        cumulative += L
    return points


def write_kml(points: list[tuple[float, float, float]], path: Path,
              prefix: str, point_height_m: float) -> None:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2">',
        '<Document>',
        f'<name>{prefix} waypoints</name>',
        '<Style id="dot"><IconStyle><scale>0.6</scale>'
        '<Icon><href>http://maps.google.com/mapfiles/kml/paddle/blu-circle.png</href></Icon>'
        '</IconStyle></Style>',
    ]
    for i, (lon, lat, _heading) in enumerate(points):
        name = f"{prefix}_{i:04d}"
        lines.append(
            f'<Placemark><name>{name}</name><styleUrl>#dot</styleUrl>'
            f'<Point><coordinates>{lon},{lat},{point_height_m}</coordinates></Point></Placemark>'
        )
    lines.append('</Document>')
    lines.append('</kml>')
    path.write_text("\n".join(lines), encoding="utf-8")


def write_orbit_pos(points: list[tuple[float, float, float]], path: Path,
                    prefix: str) -> None:
    lines = ["Filename Pan Tilt Roll"]
    for i, (_, _, heading) in enumerate(points):
        name = f"{prefix}_{i:04d}"
        # Pan = along-street heading (deg clockwise from north).
        # Tilt = 0 (horizontal). Roll = 0.
        lines.append(f"{name},{heading:.4f},0.0000,0.0000")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", default="public/data/lublin/tiles.json",
                   help="Use bbox_wgs84 + utm_central_meridian from this manifest")
    p.add_argument("-n", "--num-points", type=int, default=40)
    p.add_argument("--height", type=float, default=0.0,
                   help="Ellipsoidal height (m) for each placemark")
    p.add_argument("--prefix", default="lublin")
    p.add_argument("--out-dir", default="public/data")
    p.add_argument("--utm-epsg", default="",
                   help="Override UTM EPSG (e.g. EPSG:32634); inferred from manifest by default")
    args = p.parse_args()

    manifest_path = Path(args.manifest)
    if not manifest_path.is_file():
        sys.exit(f"manifest not found: {manifest_path}")
    m = json.loads(manifest_path.read_text())
    (lon0, lat0), (lon1, lat1) = m["bbox_wgs84"]
    print(f"manifest bbox: lon [{lon0:.5f}, {lon1:.5f}]  lat [{lat0:.5f}, {lat1:.5f}]")

    utm_epsg = args.utm_epsg
    if not utm_epsg:
        utm_epsg = m.get("crs", "EPSG:32634")
    print(f"projecting in {utm_epsg}")

    print("fetching ways from Overpass...")
    payload = fetch_ways(lat0, lon0, lat1, lon1)
    ways = build_ways(payload)
    print(f"got {len(ways)} ways")

    print(f"sampling {args.num_points} points...")
    points = sample_along_ways(ways, args.num_points, utm_epsg)
    print(f"emitted {len(points)} waypoints")
    if not points:
        sys.exit("no waypoints generated; check bbox / Overpass response")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    kml = out_dir / f"{args.prefix}_waypoints.kml"
    orbit = out_dir / f"{args.prefix}_waypoints_OrbitPos.txt"
    write_kml(points, kml, args.prefix, args.height)
    write_orbit_pos(points, orbit, args.prefix)
    print(f"wrote {kml}")
    print(f"wrote {orbit}")


if __name__ == "__main__":
    main()
