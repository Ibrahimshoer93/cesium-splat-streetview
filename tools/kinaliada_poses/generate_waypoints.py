"""Convert XGrids poses.json → walk-mode waypoints JSON.

The XGrids LCC export's `assets/poses.json` is a dense (~10 Hz) walking
trajectory in the PLY's local meter frame:

    {"poses": [{"ts": "...", "T": [x,y,z], "R": [w,x,y,z]}, ...]}

This tool:
  1. Drops the leading ~9 s stationary calibration (quaternion stays near
     identity, T stays near origin).
  2. Subsamples to ~N waypoints, spaced evenly along path arc length so
     dense and sparse stretches both get coverage.
  3. Applies the local→ENU rigid transform — rotation by --yaw-deg around
     local +Z, then projection onto WGS84 at the --anchor.
  4. Derives a per-waypoint compass heading from the pose quaternion + yaw.
  5. Emits the waypoints JSON the walk-controls.ts loader consumes.

The --yaw-deg value is the rotation that aligns the PLY's local-+Y (or
whichever direction XGrids encodes as "walker forward") to compass north.
You don't know it ahead of time — load the splat in the dev viewer, use
`window.__setYaw(deg)` to dial it in visually, then pass the same value
here so the waypoints land in the same orientation as the splat.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path


# WGS84 average meters-per-degree at the anchor. Small-angle linearization
# is fine for the ~500 m extent of Kınalıada — the planar error is sub-cm.
def meters_per_degree_lat() -> float:
    return 111320.0


def meters_per_degree_lon(at_lat_deg: float) -> float:
    return 111320.0 * math.cos(math.radians(at_lat_deg))


def quat_yaw_rad(R: list[float]) -> float:
    """Yaw (rotation around +Z, CCW looking from above) extracted from a
    [w, x, y, z] quaternion. Standard formula for the ZYX (yaw-pitch-roll)
    decomposition. Returns rad in (-π, π]."""
    w, x, y, z = R
    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    return math.atan2(siny_cosp, cosy_cosp)


def is_stationary(T: list[float], thresh_m: float = 0.05) -> bool:
    """Treat the pose as part of the stationary calibration if T is within
    `thresh_m` of origin in every axis. The capture used 0–9 s for handshake;
    we drop those frames so the waypoint set starts where movement begins."""
    return all(abs(c) < thresh_m for c in T)


def arc_length_subsample(positions: list[tuple[float, float, float]], n: int) -> list[int]:
    """Return `n` indices into `positions` chosen so the arc-length spacing
    between picks is uniform. Handles repeated points (zero-length segments)
    by falling back to even-index subsample if total path length is ~0."""
    if len(positions) <= n:
        return list(range(len(positions)))
    # Cumulative arc lengths.
    cum = [0.0]
    for i in range(1, len(positions)):
        dx = positions[i][0] - positions[i - 1][0]
        dy = positions[i][1] - positions[i - 1][1]
        dz = positions[i][2] - positions[i - 1][2]
        cum.append(cum[-1] + math.sqrt(dx * dx + dy * dy + dz * dz))
    total = cum[-1]
    if total < 1.0:
        # Path didn't really go anywhere (or all points coincide).
        step = max(1, len(positions) // n)
        return list(range(0, len(positions), step))[:n]
    # Walk along desired arc-length targets, pick nearest source index.
    targets = [total * (i / (n - 1)) for i in range(n)]
    out: list[int] = []
    j = 0
    for tgt in targets:
        while j + 1 < len(cum) and cum[j + 1] < tgt:
            j += 1
        out.append(j)
    # Dedupe while preserving order (consecutive duplicate indices collapse).
    deduped: list[int] = []
    for i in out:
        if not deduped or deduped[-1] != i:
            deduped.append(i)
    return deduped


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="Path to poses.json")
    ap.add_argument("output", help="Path to output waypoints JSON")
    ap.add_argument("--anchor-lat", type=float, required=True,
                    help="WGS84 latitude (deg) of the PLY's local origin")
    ap.add_argument("--anchor-lon", type=float, required=True,
                    help="WGS84 longitude (deg) of the PLY's local origin")
    ap.add_argument("--anchor-height-m", type=float, default=0.0,
                    help="WGS84 ellipsoidal height (m) of the PLY's local origin. "
                         "Should match config.splat.additionalHeightM after tuning.")
    ap.add_argument("--yaw-deg", type=float, default=0.0,
                    help="Rotation (deg, CCW around local +Z) applied to local "
                         "positions before ENU projection. Must match the value "
                         "baked into config.splat.orientationFixDeg.z so waypoints "
                         "and splat are co-located.")
    ap.add_argument("--waypoint-count", type=int, default=30,
                    help="Target number of evenly-spaced waypoints (default 30)")
    ap.add_argument("--calib-thresh-m", type=float, default=0.05,
                    help="Pose translation magnitude below which we treat the "
                         "pose as calibration noise (default 0.05 m)")
    ap.add_argument("--eye-height-m", type=float, default=0.0,
                    help="Extra height added to every waypoint (passes through "
                         "to walk-controls' eyeHeightM, but bake here if you "
                         "want the waypoint heights to already include eye level)")
    args = ap.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    if not input_path.is_file():
        sys.exit(f"Not found: {input_path}")

    with input_path.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    poses = raw.get("poses")
    if not poses:
        sys.exit("No 'poses' array in input JSON")

    # Drop leading stationary frames. We require the first MOVING pose to
    # have crossed the threshold, then keep everything from there onward
    # (a brief stop mid-walk is fine — only the initial calibration is dropped).
    first_moving = None
    for i, p in enumerate(poses):
        if not is_stationary(p["T"], args.calib_thresh_m):
            first_moving = i
            break
    if first_moving is None:
        sys.exit("All poses are within --calib-thresh-m of origin; nothing to subsample")
    moving = poses[first_moving:]
    print(f"input poses: {len(poses):,}  ·  dropped {first_moving} calibration poses  ·  walking: {len(moving):,}")

    positions = [tuple(p["T"]) for p in moving]
    idx = arc_length_subsample(positions, args.waypoint_count)
    print(f"subsampled to {len(idx)} waypoints along arc length")

    # Build the local→ENU rotation. yaw_deg is CCW around local +Z.
    yaw_rad = math.radians(args.yaw_deg)
    cos_y, sin_y = math.cos(yaw_rad), math.sin(yaw_rad)

    lat_per_m = 1.0 / meters_per_degree_lat()
    lon_per_m = 1.0 / meters_per_degree_lon(args.anchor_lat)

    waypoints = []
    for i in idx:
        p = moving[i]
        Tx, Ty, Tz = p["T"]
        # Local → ENU rotation around Z. Local +X may not be ENU east; the
        # yaw rotates it into ENU east at yaw_deg=0 + dataset-specific offset.
        e = cos_y * Tx - sin_y * Ty
        n = sin_y * Tx + cos_y * Ty
        u = Tz  # Z is up in both local and ENU frames
        lat = args.anchor_lat + n * lat_per_m
        lon = args.anchor_lon + e * lon_per_m
        height_m = args.anchor_height_m + u + args.eye_height_m

        # Heading in ENU: yaw_local + yaw_offset → compass heading. Compass
        # heading is CW from north (so add 90° to convert from "east is 0,
        # CCW positive" math convention, then negate). XGrids quaternion
        # convention is right-handed; treat yaw_local as the rotation of
        # local +Y (typically "walker forward") in the local horizontal plane.
        yaw_local_rad = quat_yaw_rad(p["R"])
        # ENU yaw (CCW from east) of walker forward = yaw_local + yaw_offset.
        enu_yaw_rad = yaw_local_rad + yaw_rad
        # Compass heading = 90° - enu_yaw (degrees), normalized to [0, 360).
        heading_deg = (90.0 - math.degrees(enu_yaw_rad)) % 360.0

        try:
            ts = float(p["ts"])
        except (TypeError, ValueError):
            ts = None

        waypoints.append({
            "lat": round(lat, 8),
            "lon": round(lon, 8),
            "height_m": round(height_m, 3),
            "heading_deg": round(heading_deg, 2),
            "pitch_deg": 0.0,
            "ts": ts,
        })

    out = {
        "version": "1.0",
        "dataset": output_path.stem.replace("-waypoints", ""),
        "anchor_wgs84": [args.anchor_lat, args.anchor_lon, args.anchor_height_m],
        "yaw_deg_applied": args.yaw_deg,
        "calib_thresh_m": args.calib_thresh_m,
        "waypoints": waypoints,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(f"wrote {len(waypoints)} waypoints to {output_path}")
    # Quick sanity readout.
    lat_min = min(w["lat"] for w in waypoints)
    lat_max = max(w["lat"] for w in waypoints)
    lon_min = min(w["lon"] for w in waypoints)
    lon_max = max(w["lon"] for w in waypoints)
    print(f"bbox lat: [{lat_min:.6f}, {lat_max:.6f}]  lon: [{lon_min:.6f}, {lon_max:.6f}]")


if __name__ == "__main__":
    main()
