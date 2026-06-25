import * as Cesium from "cesium";
import type { Viewer } from "./viewer";
import type { WalkMode } from "./datasets/types";

// Street-view "walk mode" controller. Constrains the camera to within
// `radiusM` of the nearest captured waypoint, so the user can wander around
// inside the ground-level splat without drifting into empty geometry off the
// captured path.
//
// Keys (mirror flyover-controls layout):
//   R / T  → forward / back along camera heading (horizontal)
//   D / F  → strafe left / right
//   PgUp / PgDn → height up / down (clamped to ±2 m around eye height)
//   Arrows → look (yaw on ←/→, pitch on ↑/↓)
//   Shift  → 2x speed multiplier
//
// Each frame after a move, the camera position is checked against the
// waypoint set: if min horizontal distance > radiusM, the camera is pushed
// back along the breach vector to sit exactly on the radius boundary.

interface Waypoint {
    lat: number;
    lon: number;
    height_m: number;
    heading_deg: number;
    pitch_deg?: number;
    ts?: number;
    /** Cached ECEF position (origin for distance checks). */
    ecef: Cesium.Cartesian3;
}

interface WaypointsFile {
    version: string;
    anchor_wgs84: [number, number, number];
    waypoints: Array<{
        lat: number;
        lon: number;
        height_m: number;
        heading_deg: number;
        pitch_deg?: number;
        ts?: number;
    }>;
}

const ROTATE_DEG = 2;
const WALK_SPEED_MPS = 1.4; // average walking speed
const STEP_MIN_M = 0.2;
const STEP_MAX_M = 5.0;

function horizontalDirection(camera: Cesium.Camera, headingOffsetDeg: number): Cesium.Cartesian3 {
    const pos = camera.positionWC;
    const enuFrame = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
    const totalRad = camera.heading + Cesium.Math.toRadians(headingOffsetDeg);
    const enuDir = new Cesium.Cartesian3(Math.sin(totalRad), Math.cos(totalRad), 0);
    const ecefDir = Cesium.Matrix4.multiplyByPointAsVector(
        enuFrame, enuDir, new Cesium.Cartesian3(),
    );
    return Cesium.Cartesian3.normalize(ecefDir, ecefDir);
}

/** Move camera up/down along the local ellipsoid normal — preserves heading
 *  and pitch, just changes altitude. Used by the E/C vertical keys. */
function changeAltitude(camera: Cesium.Camera, deltaM: number): void {
    const pos = camera.positionWC;
    const up = Cesium.Cartesian3.normalize(pos, new Cesium.Cartesian3());
    const offset = Cesium.Cartesian3.multiplyByScalar(up, deltaM, new Cesium.Cartesian3());
    const newPos = Cesium.Cartesian3.add(pos, offset, new Cesium.Cartesian3());
    camera.setView({
        destination: newPos,
        orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
    });
}

/** Distance, measured in the horizontal (ENU east+north) plane at the camera's
 *  current position. Vertical component is ignored so the radius check doesn't
 *  fight gentle altitude changes. */
function horizontalDistance(a: Cesium.Cartesian3, b: Cesium.Cartesian3, enuFrameInverse: Cesium.Matrix4): number {
    const diff = Cesium.Cartesian3.subtract(a, b, new Cesium.Cartesian3());
    const enuDiff = Cesium.Matrix4.multiplyByPointAsVector(enuFrameInverse, diff, new Cesium.Cartesian3());
    return Math.hypot(enuDiff.x, enuDiff.y);
}

/** Find the waypoint whose horizontal distance to `pos` is smallest. */
function nearestWaypoint(pos: Cesium.Cartesian3, waypoints: Waypoint[]): { wp: Waypoint; distM: number } {
    const enuFrame = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
    const enuFrameInv = Cesium.Matrix4.inverseTransformation(enuFrame, new Cesium.Matrix4());
    let best = waypoints[0];
    let bestDist = horizontalDistance(pos, best.ecef, enuFrameInv);
    for (let i = 1; i < waypoints.length; i++) {
        const d = horizontalDistance(pos, waypoints[i].ecef, enuFrameInv);
        if (d < bestDist) {
            best = waypoints[i];
            bestDist = d;
        }
    }
    return { wp: best, distM: bestDist };
}

/** If the camera has drifted beyond `radiusM` from the nearest waypoint, snap
 *  it back along the breach vector to sit on the boundary. */
function enforceRadius(camera: Cesium.Camera, waypoints: Waypoint[], radiusM: number): boolean {
    const pos = camera.positionWC;
    const { wp, distM } = nearestWaypoint(pos, waypoints);
    if (distM <= radiusM) return false;
    const breach = distM - radiusM;
    // Push the camera back toward the nearest waypoint by `breach` meters
    // along the horizontal direction from camera→waypoint.
    const enuFrame = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
    const enuFrameInv = Cesium.Matrix4.inverseTransformation(enuFrame, new Cesium.Matrix4());
    const diff = Cesium.Cartesian3.subtract(wp.ecef, pos, new Cesium.Cartesian3());
    const enuDiff = Cesium.Matrix4.multiplyByPointAsVector(enuFrameInv, diff, new Cesium.Cartesian3());
    // Horizontal-only push.
    enuDiff.z = 0;
    const len = Math.hypot(enuDiff.x, enuDiff.y) || 1;
    enuDiff.x = (enuDiff.x / len) * breach;
    enuDiff.y = (enuDiff.y / len) * breach;
    const ecefDiff = Cesium.Matrix4.multiplyByPointAsVector(enuFrame, enuDiff, new Cesium.Cartesian3());
    const newPos = Cesium.Cartesian3.add(pos, ecefDiff, new Cesium.Cartesian3());
    camera.setView({
        destination: newPos,
        orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
    });
    return true;
}

export interface WalkControlsHandle {
    detach: () => void;
}

export async function setupWalkControls(
    viewer: Viewer,
    walkMode: WalkMode,
): Promise<WalkControlsHandle> {
    if (!viewer.cesium) {
        return { detach: () => {} };
    }
    const cesium = viewer.cesium;
    const camera = cesium.camera;
    // walkMode.eyeHeightM is unused in the new convention — recorded
    // waypoints already store the full camera position (lat/lon/h are
    // exactly where the camera was when the user pressed Record).
    void walkMode.eyeHeightM;

    // Load the waypoints file. Cache ECEF positions so per-frame distance
    // checks don't re-project the WGS84 → ECEF math. height_m is the
    // CAMERA elevation that was recorded — no eye-height add, no terrain
    // sampling. Recorded heights are authoritative.
    let waypoints: Waypoint[] = [];
    try {
        const resp = await fetch(walkMode.waypointsUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const file = (await resp.json()) as WaypointsFile;
        waypoints = file.waypoints.map((w) => ({
            ...w,
            ecef: Cesium.Cartesian3.fromDegrees(w.lon, w.lat, w.height_m),
        }));
        console.log(
            `%c[walk] loaded ${waypoints.length} recorded waypoints (heights as captured, no terrain override)`,
            "background:#3a1a55;color:#f0e0ff;padding:2px 6px;border-radius:3px;",
        );
    } catch (e) {
        console.warn(`[walk] failed to load ${walkMode.waypointsUrl}; walk-mode disabled. Reason:`, e);
        return { detach: () => {} };
    }

    if (waypoints.length === 0) {
        console.warn("[walk] waypoints file has no entries; walk-mode disabled.");
        return { detach: () => {} };
    }

    const onKey = (e: KeyboardEvent) => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

        const mult = e.shiftKey ? 2 : 1;
        const step = Math.min(STEP_MAX_M, Math.max(STEP_MIN_M, WALK_SPEED_MPS * 0.1)) * mult;
        const rotateRad = Cesium.Math.toRadians(ROTATE_DEG * mult);

        let handled = true;
        // `isHorizontalWalk` controls whether the radius + terrain-clamp
        // post-step runs. Vertical keys (E/C) and look keys (arrows) skip
        // it: the user explicitly asked to change altitude, so don't
        // immediately snap them back to the ground.
        let isHorizontalWalk = false;
        switch (e.key) {
            case "r": case "R": camera.move(horizontalDirection(camera, 0), step); isHorizontalWalk = true; break;
            case "t": case "T": camera.move(horizontalDirection(camera, 180), step); isHorizontalWalk = true; break;
            case "d": case "D": camera.move(horizontalDirection(camera, -90), step); isHorizontalWalk = true; break;
            case "f": case "F": camera.move(horizontalDirection(camera, 90), step); isHorizontalWalk = true; break;
            case "e": case "E": changeAltitude(camera, step); break;
            case "c": case "C": changeAltitude(camera, -step); break;
            case "ArrowLeft":  camera.lookLeft(rotateRad); break;
            case "ArrowRight": camera.lookRight(rotateRad); break;
            case "ArrowUp":    camera.lookUp(rotateRad); break;
            case "ArrowDown":  camera.lookDown(rotateRad); break;
            default: handled = false;
        }
        if (!handled) return;
        e.preventDefault();

        // After a horizontal-walk key: push back inside the radius if we
        // breached, then clamp the camera's altitude to the NEAREST
        // waypoint's recorded height. The user recorded specific heights
        // (some on hills, some at sea level on the same path), so terrain
        // is no longer the right reference — nearest-waypoint height is.
        // This keeps the walker at the elevation the captured pose
        // intended, even if camera.move() left us at the previous
        // waypoint's height while drifting into another's radius.
        // E/C explicitly opt out for free vertical exploration.
        if (isHorizontalWalk) {
            enforceRadius(camera, waypoints, walkMode.radiusM);
            const pos = camera.positionWC;
            const carto = Cesium.Cartographic.fromCartesian(pos);
            const { wp } = nearestWaypoint(pos, waypoints);
            const newPos = Cesium.Cartesian3.fromRadians(
                carto.longitude, carto.latitude, wp.height_m,
            );
            camera.setView({
                destination: newPos,
                orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
            });
        }
    };

    window.addEventListener("keydown", onKey);

    // Devtool: jump to a specific waypoint by index. Useful for testing the
    // walk path during alignment.
    (window as unknown as { __walkTo: (i: number) => void }).__walkTo = (i: number) => {
        const wp = waypoints[i];
        if (!wp) {
            console.warn(`[walk] index ${i} out of range (have ${waypoints.length} waypoints)`);
            return;
        }
        camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.height_m),
            orientation: {
                heading: Cesium.Math.toRadians(wp.heading_deg),
                pitch: Cesium.Math.toRadians(wp.pitch_deg ?? 0),
                roll: 0,
            },
        });
        console.log(`[walk] jumped to waypoint #${i} (${wp.lat.toFixed(6)}, ${wp.lon.toFixed(6)}, h=${wp.height_m.toFixed(1)}, hdg=${wp.heading_deg.toFixed(1)}°)`);
    };
    (window as unknown as { __walkpoints: Waypoint[] }).__walkpoints = waypoints;

    console.log(
        "%c[walk] keys: R/T forward/back · D/F strafe · E/C up/down · Arrows look · Shift = 2x · __walkTo(i) to jump",
        "background:#3a1a55;color:#f0e0ff;padding:2px 6px;border-radius:3px;",
    );
    return { detach: () => window.removeEventListener("keydown", onKey) };
}
