import * as Cesium from "cesium";
import type { Viewer } from "./viewer";
import type { DatasetConfig } from "./datasets/types";

// Free-form splat alignment debug keys, modeled after the pre-Ion
// GaussianSplatLayer.adjustScene controls but wired to the native Cesium
// 3D Tiles pipeline.
//
// Each tileset's `root.transform` is rebuilt every keypress from a small
// state vector — rotation (Rx/Ry/Rz around ENU east/north/up at the anchor),
// horizontal shift (meters along ENU east/north), and vertical shift (height).
// All values are absolute, NOT cumulative-per-keypress, so Ctrl+P prints
// values you can paste straight into the dataset config without arithmetic.
//
// Why this exists alongside __nudgeHeight / __setYaw: those are one-axis
// nudges; this is the multi-axis "free-fly the splat into place" controller.
//
// Keys:
//   q / w → rotate around local Y (pitch tilt)        -/+ degrees
//   a / s → rotate around local X (roll tilt)         -/+ degrees
//   z / x → rotate around local Z (yaw / compass)     -/+ degrees
//   y / h → shift anchor along ENU north / south      -/+ meters
//   j / g → shift anchor along ENU east  / west       -/+ meters
//   o / l → lift  / lower along ENU up                -/+ meters
//   Alt   → fine step (0.1° / 0.1 m); without Alt, 1° / 1 m
//   Shift → 10x step (so 10° / 10 m, or 1° / 1 m with Alt)
//   Ctrl+P → print the current state in copy-paste-ready config form

export function setupSplatDebugControls(
    viewer: Viewer,
    tilesets: Cesium.Cesium3DTileset[],
    config: DatasetConfig,
): { detach: () => void } {
    if (!viewer.cesium || tilesets.length === 0) {
        return { detach: () => {} };
    }

    // The converter-baked anchor for each tileset. We extract it from
    // root.transform at attach time (before any of OUR adjustments), so it
    // always reflects the --coordinate value passed to the converter — the
    // value the user would have to change to re-bake the anchor.
    const baseOrigins = tilesets.map((t) =>
        Cesium.Matrix4.getTranslation(t.root.transform, new Cesium.Cartesian3()),
    );

    // Cumulative state, initialized FROM the dataset config so live tuning
    // starts from the currently-baked values (zero work to re-find the
    // previous good spot if the user reloads).
    let rx = config.splat.orientationFixDeg?.x ?? 0;
    let ry = config.splat.orientationFixDeg?.y ?? 0;
    let rz = config.splat.orientationFixDeg?.z ?? 0;
    let dHeightM = config.splat.additionalHeightM ?? 0;
    let dNorthM = 0;
    let dEastM = 0;

    function apply() {
        const rxRad = Cesium.Math.toRadians(rx);
        const ryRad = Cesium.Math.toRadians(ry);
        const rzRad = Cesium.Math.toRadians(rz);
        // ZYX intrinsic composition (yaw → pitch → roll). Same convention as
        // the load-time orientationFixDeg path in main.ts.
        const rot = Cesium.Matrix3.multiply(
            Cesium.Matrix3.multiply(
                Cesium.Matrix3.fromRotationZ(rzRad),
                Cesium.Matrix3.fromRotationY(ryRad),
                new Cesium.Matrix3(),
            ),
            Cesium.Matrix3.fromRotationX(rxRad),
            new Cesium.Matrix3(),
        );
        const rotMat4 = Cesium.Matrix4.fromRotationTranslation(rot, Cesium.Cartesian3.ZERO);

        for (let i = 0; i < tilesets.length; i++) {
            const t = tilesets[i];
            const baseOrigin = baseOrigins[i];

            // Shift the anchor along ENU east/north/up at its current spot.
            // We rebuild from baseOrigin every call (not from the last
            // shifted origin) so the delta is always absolute.
            const enuAtBase = Cesium.Transforms.eastNorthUpToFixedFrame(baseOrigin);
            const shiftLocal = new Cesium.Cartesian3(dEastM, dNorthM, dHeightM);
            const shiftEcef = Cesium.Matrix4.multiplyByPointAsVector(
                enuAtBase, shiftLocal, new Cesium.Cartesian3(),
            );
            const newOrigin = Cesium.Cartesian3.add(
                baseOrigin, shiftEcef, new Cesium.Cartesian3(),
            );

            // ENU frame at the shifted origin — provides the basis the
            // rotation is interpreted in.
            const enuAtNew = Cesium.Transforms.eastNorthUpToFixedFrame(newOrigin);

            const newRoot = Cesium.Matrix4.multiply(
                enuAtNew, rotMat4, new Cesium.Matrix4(),
            );
            // IMPORTANT: assign through the setter — `Matrix4.clone(src, dest)`
            // would mutate the internal _transform without calling the
            // setter, leaving Cesium's cached bounding volumes / world
            // matrices stale and producing the "nothing visibly changed"
            // failure mode the previous __setYaw devtool had.
            t.root.transform = newRoot;
        }
    }

    function dumpState() {
        // Show what to paste into the dataset config to bake the current
        // visible state. The lat/lon shift is shown as a degree delta
        // (apply by changing the --coordinate value next conversion) since
        // the TS dataset config has no "anchorShiftM" field — the
        // converter's --coordinate is the source of truth for lat/lon.
        const anchorLat = config.initialFlyTo?.lat;
        const cosLat = anchorLat != null
            ? Math.cos(Cesium.Math.toRadians(anchorLat))
            : 1;
        const dLatDeg = dNorthM / 111320.0;
        const dLonDeg = dEastM / (111320.0 * Math.max(1e-6, cosLat));

        const lines: string[] = [];
        lines.push("");
        lines.push("[splat-debug] current state — paste into the dataset config:");
        lines.push("");
        lines.push(`    orientationFixDeg: { x: ${rx.toFixed(2)}, y: ${ry.toFixed(2)}, z: ${rz.toFixed(2)} },`);
        lines.push(`    additionalHeightM: ${dHeightM.toFixed(3)},`);
        if (dNorthM !== 0 || dEastM !== 0) {
            lines.push("");
            lines.push(`    // anchor was shifted by ${dNorthM.toFixed(2)} m N · ${dEastM.toFixed(2)} m E`);
            lines.push(`    // to bake, re-run the converter with --coordinate updated:`);
            lines.push(`    //   new lat = originalLat + ${dLatDeg.toFixed(8)}`);
            lines.push(`    //   new lon = originalLon + ${dLonDeg.toFixed(8)}`);
            lines.push(`    // and pass the same yaw to tools/kinaliada_poses/generate_waypoints.py --yaw-deg`);
        }
        lines.push("");
        console.log("%c" + lines.join("\n"),
            "background:#553a1a;color:#ffe0c0;padding:2px 6px;border-radius:3px;");
    }

    function onKey(e: KeyboardEvent) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

        // Ctrl+P → dump. Don't pass through to the print dialog.
        if (e.ctrlKey && (e.key === "p" || e.key === "P")) {
            e.preventDefault();
            dumpState();
            return;
        }

        // Step sizing: Alt = 0.1x, Shift = 10x, default 1.
        const stepMult = e.altKey ? 0.1 : (e.shiftKey ? 10 : 1);
        const rotStep = 1 * stepMult;
        const posStep = 1 * stepMult;

        let handled = true;
        switch (e.key) {
            case "q": case "Q": ry -= rotStep; break;
            case "w": case "W": ry += rotStep; break;
            case "a": case "A": rx -= rotStep; break;
            case "s": case "S": rx += rotStep; break;
            case "z": case "Z": rz -= rotStep; break;
            case "x": case "X": rz += rotStep; break;
            case "y": case "Y": dNorthM += posStep; break;
            case "h": case "H": dNorthM -= posStep; break;
            case "j": case "J": dEastM += posStep; break;
            case "g": case "G": dEastM -= posStep; break;
            case "o": case "O": dHeightM += posStep; break;
            case "l": case "L": dHeightM -= posStep; break;
            default: handled = false;
        }
        if (!handled) return;
        e.preventDefault();
        apply();
        console.log(
            `[splat-debug] rot(${rx.toFixed(2)},${ry.toFixed(2)},${rz.toFixed(2)})° · ` +
            `shift(N=${dNorthM.toFixed(2)} E=${dEastM.toFixed(2)} U=${dHeightM.toFixed(2)})m  Ctrl+P to print`,
        );
    }

    window.addEventListener("keydown", onKey);

    // Apply once so the visible state reflects the cumulative initial values
    // (matches what the load-time orientationFixDeg + additionalHeightM
    // would have produced; lets us own the transform from here on out).
    apply();

    // Expose the same state via devtools for users who prefer typing values
    // over chord presses. Each fn updates one axis at a time, leaves the
    // others intact, then triggers a single re-apply.
    const w = window as unknown as Record<string, unknown>;
    w.__setYaw = (deg: number) => { rz = deg; apply(); console.log(`[yaw] z=${rz}°`); };
    w.__setPitchY = (deg: number) => { ry = deg; apply(); console.log(`[pitch-y] y=${ry}°`); };
    w.__setRollX = (deg: number) => { rx = deg; apply(); console.log(`[roll-x] x=${rx}°`); };
    w.__nudgeHeight = (m: number) => { dHeightM = m; apply(); console.log(`[height] ${dHeightM}m (absolute)`); };
    w.__nudgeNorth = (m: number) => { dNorthM = m; apply(); console.log(`[north] ${dNorthM}m`); };
    w.__nudgeEast = (m: number) => { dEastM = m; apply(); console.log(`[east] ${dEastM}m`); };
    w.__dumpSplat = dumpState;
    // Delta-style helpers (apply to current state, don't replace) — used by
    // the waypoint-editor panel's splat buttons so the user can sweep
    // through nearby values with single clicks instead of computing absolutes.
    w.__bumpSplatHeight = (delta: number) => { dHeightM += delta; apply(); console.log(`[splat-height] ${dHeightM.toFixed(2)} m (+${delta})`); };
    w.__bumpSplatPitchY = (delta: number) => { ry += delta; apply(); console.log(`[splat-pitch ry] ${ry.toFixed(2)}° (+${delta})`); };
    w.__bumpSplatRollX = (delta: number) => { rx += delta; apply(); console.log(`[splat-roll rx]  ${rx.toFixed(2)}° (+${delta})`); };
    w.__bumpSplatYaw = (delta: number) => { rz += delta; apply(); console.log(`[splat-yaw rz]   ${rz.toFixed(2)}° (+${delta})`); };
    w.__getSplatHeight = () => dHeightM;
    w.__getSplatPitchY = () => ry;
    w.__getSplatRollX = () => rx;
    w.__getSplatYaw = () => rz;

    console.log(
        "%c[splat-debug] q/w pitch · a/s roll · z/x yaw · y/h N/S · j/g E/W · o/l height · Alt=0.1x · Shift=10x · Ctrl+P print",
        "background:#553a1a;color:#ffe0c0;padding:2px 6px;border-radius:3px;",
    );
    return { detach: () => window.removeEventListener("keydown", onKey) };
}
