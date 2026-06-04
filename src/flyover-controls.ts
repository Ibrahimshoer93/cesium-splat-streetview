import * as Cesium from "cesium";
import type { Viewer } from "./viewer";

// Keyboard-driven flyover camera. Built for aerial / drone splats where the
// natural viewpoint is *above* the scene looking down, not first-person inside.
//
// Movement steps scale with camera altitude so the controls feel right at both
// 1000 m overview and 30 m close-up. Hold Shift for 5x speed.
//
// Keys:
//   R / T  → forward / back   (along camera heading, projected to horizontal)
//   D / F  → strafe left / right
//   PgUp / PgDn → altitude up / down
//   Arrows → rotate heading (←/→) and pitch (↑/↓)
//   Shift  → 5x speed multiplier on any of the above

const ROTATE_DEG = 2;
const ALT_FRACTION = 0.05; // horizontal step = altitude * this
const MIN_STEP_M = 1;

function horizontalDirection(camera: Cesium.Camera, headingOffsetDeg: number): Cesium.Cartesian3 {
    // Compute the ECEF direction vector for "forward along camera heading,
    // rotated by headingOffsetDeg, with no vertical component" — i.e. a
    // horizontal slide in the local east-north plane.
    const pos = camera.positionWC;
    const enuFrame = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
    const totalRad = camera.heading + Cesium.Math.toRadians(headingOffsetDeg);
    // Cesium heading: 0=north, increases clockwise. ENU x=east, y=north.
    const enuDir = new Cesium.Cartesian3(Math.sin(totalRad), Math.cos(totalRad), 0);
    const ecefDir = Cesium.Matrix4.multiplyByPointAsVector(
        enuFrame, enuDir, new Cesium.Cartesian3(),
    );
    return Cesium.Cartesian3.normalize(ecefDir, ecefDir);
}

/** Move camera up/down along the local ellipsoid normal (true altitude change). */
function changeAltitude(camera: Cesium.Camera, deltaM: number) {
    const pos = camera.positionWC;
    const up = Cesium.Cartesian3.normalize(pos, new Cesium.Cartesian3());
    const offset = Cesium.Cartesian3.multiplyByScalar(up, deltaM, new Cesium.Cartesian3());
    const newPos = Cesium.Cartesian3.add(pos, offset, new Cesium.Cartesian3());
    camera.setView({
        destination: newPos,
        orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
    });
}

export interface FlyoverControlsHandle {
    detach: () => void;
}

export function setupFlyoverControls(viewer: Viewer): FlyoverControlsHandle {
    if (!viewer.cesium) {
        return { detach: () => {} };
    }
    const camera = viewer.cesium.camera;

    const stepFor = () => {
        const h = Math.max(10, camera.positionCartographic.height);
        return Math.max(MIN_STEP_M, h * ALT_FRACTION);
    };

    const onKey = (e: KeyboardEvent) => {
        // Ignore when user is typing in an input field.
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

        const mult = e.shiftKey ? 5 : 1;
        const step = stepFor() * mult;
        const rotateRad = Cesium.Math.toRadians(ROTATE_DEG * mult);
        const altStep = stepFor() * mult;

        let handled = true;
        switch (e.key) {
            case "r": case "R": camera.move(horizontalDirection(camera, 0), step); break;
            case "t": case "T": camera.move(horizontalDirection(camera, 180), step); break;
            case "d": case "D": camera.move(horizontalDirection(camera, -90), step); break;
            case "f": case "F": camera.move(horizontalDirection(camera, 90), step); break;
            case "PageUp":   changeAltitude(camera, altStep); break;
            case "PageDown": changeAltitude(camera, -altStep); break;
            case "ArrowLeft":  camera.lookLeft(rotateRad); break;
            case "ArrowRight": camera.lookRight(rotateRad); break;
            case "ArrowUp":    camera.lookUp(rotateRad); break;
            case "ArrowDown":  camera.lookDown(rotateRad); break;
            default: handled = false;
        }
        if (handled) e.preventDefault();
    };

    window.addEventListener("keydown", onKey);
    console.log(
        "%c[flyover] keys: R/T forward/back · D/F strafe · PgUp/PgDn altitude · Arrows look · Shift = 5x",
        "background:#143;color:#cfd;padding:2px 6px;border-radius:3px;",
    );
    return { detach: () => window.removeEventListener("keydown", onKey) };
}
