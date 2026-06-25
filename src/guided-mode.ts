import * as Cesium from "cesium";
import type { Viewer } from "./viewer";
import type { WalkMode } from "./datasets/types";

// Guided street-view experience for walk-mode datasets.
//
// Two states:
//   OVERVIEW  – splat hidden, blue waypoint balls visible, camera flies
//               freely (via flyover-controls). Clicking a ball enters
//               POINT mode at that waypoint.
//   POINT     – splat visible, balls hidden, camera snapped to the
//               waypoint's recorded pose (lat/lon/h/heading/pitch). User
//               can rotate / pan / zoom within a small radius. Drifting
//               past the radius snaps to the NEAREST waypoint; rolling
//               the mouse wheel UP exits back to OVERVIEW.
//
// Why this design: street-view splats render correctly only within a
// small bubble around each captured pose (parallax outside the captured
// volume breaks the splat). The radius lock keeps the user in that
// bubble; the snap-to-nearest pattern lets them traverse between
// captured points smoothly without ever leaving a valid render zone.

interface GuidedWaypoint {
    lat: number;
    lon: number;
    height_m: number;
    heading_deg: number;
    pitch_deg: number;
    /** Cached ECEF position — origin of the 5 m bubble around this
     *  waypoint and the entity's render anchor. */
    ecef: Cesium.Cartesian3;
    /** `false` for waypoints recorded by the user, `true` for points
     *  inserted by interpolation between two recorded waypoints that
     *  sat further than `MAX_GAP_M` apart. Used only for rendering
     *  (lighter color) so the user can tell what they recorded vs what
     *  was filled in. */
    interpolated: boolean;
    entity?: Cesium.Entity;
}

/** Shortest-arc difference in degrees: result lies in (-180, 180]. */
function shortestAngleDeltaDeg(from: number, to: number): number {
    let d = (to - from) % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
}

/** Insert adaptive midpoints between consecutive PAIRS of original recorded
 *  waypoints whose ECEF distance falls in (minGapM, maxGapM]. The count of
 *  midpoints per gap is `max(1, ⌈gap/targetSegM⌉ - 1)` — at least one when
 *  the gap qualifies, more if needed to keep each resulting segment near
 *  targetSegM. Gaps outside the window are skipped (no guessing across
 *  unwalkable distances; smaller gaps don't need help).
 *
 *  Iteration uses the original input array's indices for prev/curr, so
 *  interpolated points never seed further interpolation — they're inserted
 *  between original neighbors only. */
function interpolateWaypoints(
    input: GuidedWaypoint[],
    minGapM: number,
    maxGapM: number,
    targetSegM: number,
): GuidedWaypoint[] {
    if (input.length < 2) return input.slice();
    const out: GuidedWaypoint[] = [input[0]];
    for (let i = 1; i < input.length; i++) {
        const prev = input[i - 1];
        const curr = input[i];
        const dist = Cesium.Cartesian3.distance(prev.ecef, curr.ecef);
        if (dist > minGapM && dist <= maxGapM) {
            const N = Math.ceil(dist / targetSegM) - 1;
            if (N <= 0) {
                out.push(curr);
                continue;
            }
            const dHdg = shortestAngleDeltaDeg(prev.heading_deg, curr.heading_deg);
            for (let k = 1; k <= N; k++) {
                const t = k / (N + 1);
                const lat = prev.lat + (curr.lat - prev.lat) * t;
                const lon = prev.lon + (curr.lon - prev.lon) * t;
                const height_m = prev.height_m + (curr.height_m - prev.height_m) * t;
                const heading_deg = ((prev.heading_deg + dHdg * t) % 360 + 360) % 360;
                const pitch_deg = prev.pitch_deg + (curr.pitch_deg - prev.pitch_deg) * t;
                out.push({
                    lat, lon, height_m, heading_deg, pitch_deg,
                    ecef: Cesium.Cartesian3.fromDegrees(lon, lat, height_m),
                    interpolated: true,
                });
            }
        }
        out.push(curr);
    }
    return out;
}

interface WaypointsFile {
    version?: string;
    source?: string;
    waypoints?: Array<{
        lat: number;
        lon: number;
        height_m: number;
        heading_deg: number;
        pitch_deg?: number;
        ts?: number | null;
    }>;
}

const POINT_RADIUS_M = 5;
/** Interpolation window for original recorded gaps:
 *  - gap ≤ MIN: skip — two 5 m bubbles touch at exactly 10 m, so any
 *    gap ≤ MIN is already walkable without help.
 *  - MIN < gap ≤ MAX: insert just enough midpoints so each resulting
 *    segment is ≤ TARGET. 11-20 m → 1 midpoint, 21-25 m → 2 midpoints.
 *  - gap > MAX: skip — linear interpolation across that distance
 *    would risk cutting through empty / invalid splat space (e.g. the
 *    307 m teleport between two captured walk segments on the island). */
const INTERPOLATE_MIN_GAP_M = 10;
const INTERPOLATE_MAX_GAP_M = 25;
const INTERPOLATE_TARGET_SEGMENT_M = 10;
const COLOR_DEFAULT = Cesium.Color.fromCssColorString("#3aa8ff").withAlpha(0.9);
const COLOR_INTERPOLATED = Cesium.Color.fromCssColorString("#7ac8ff").withAlpha(0.7);
const COLOR_HOVER = Cesium.Color.fromCssColorString("#ff9933").withAlpha(0.95);

function findNearest(pos: Cesium.Cartesian3, waypoints: GuidedWaypoint[]): { idx: number; distM: number } {
    let bestIdx = 0;
    let bestDist = Cesium.Cartesian3.distance(pos, waypoints[0].ecef);
    for (let i = 1; i < waypoints.length; i++) {
        const d = Cesium.Cartesian3.distance(pos, waypoints[i].ecef);
        if (d < bestDist) {
            bestIdx = i;
            bestDist = d;
        }
    }
    return { idx: bestIdx, distM: bestDist };
}

export interface GuidedModeHandle {
    detach: () => void;
}

export async function setupGuidedMode(
    viewer: Viewer,
    walkMode: WalkMode,
    tilesets: Cesium.Cesium3DTileset[],
): Promise<GuidedModeHandle> {
    if (!viewer.cesium) return { detach: () => {} };
    const cesium = viewer.cesium;
    const camera = cesium.camera;
    const canvas = cesium.scene.canvas;

    type Mode = "overview" | "point";
    let mode: Mode = "overview";
    let currentIndex = -1;
    let hoveredIdx = -1;

    // ─── Load waypoints ───
    const recorded: GuidedWaypoint[] = [];
    try {
        const resp = await fetch(walkMode.waypointsUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const file = (await resp.json()) as WaypointsFile;
        for (const w of file.waypoints ?? []) {
            recorded.push({
                lat: w.lat,
                lon: w.lon,
                height_m: w.height_m,
                heading_deg: w.heading_deg,
                pitch_deg: w.pitch_deg ?? 0,
                ecef: Cesium.Cartesian3.fromDegrees(w.lon, w.lat, w.height_m),
                interpolated: false,
            });
        }
    } catch (e) {
        console.warn(`[guided] failed to load ${walkMode.waypointsUrl}; mode disabled:`, e);
        return { detach: () => {} };
    }
    if (recorded.length === 0) {
        console.warn("[guided] waypoints file empty; mode disabled.");
        return { detach: () => {} };
    }

    // Densify only the moderate gaps. Pairs closer than INTERPOLATE_MIN_GAP_M
    // already have overlapping bubbles; pairs further apart than
    // INTERPOLATE_MAX_GAP_M look like teleports (e.g. user moved to
    // another part of the island and started a new recording segment) —
    // bridging those linearly would draw a route through non-splat space.
    const waypoints = interpolateWaypoints(
        recorded, INTERPOLATE_MIN_GAP_M, INTERPOLATE_MAX_GAP_M, INTERPOLATE_TARGET_SEGMENT_M,
    );
    const insertedCount = waypoints.length - recorded.length;

    // Report which pairs were bridged and which were skipped as teleports
    // so the user can spot any over- or under-interpolation at a glance.
    let skippedAsTeleport = 0;
    for (let i = 1; i < recorded.length; i++) {
        const d = Cesium.Cartesian3.distance(recorded[i - 1].ecef, recorded[i].ecef);
        if (d > INTERPOLATE_MAX_GAP_M) skippedAsTeleport++;
    }
    console.log(
        `[guided] interpolation: recorded=${recorded.length} · inserted=${insertedCount} · ` +
        `total=${waypoints.length} · skipped-as-teleport=${skippedAsTeleport} ` +
        `(window ${INTERPOLATE_MIN_GAP_M}-${INTERPOLATE_MAX_GAP_M} m, target segment ≤${INTERPOLATE_TARGET_SEGMENT_M} m)`,
    );

    // ─── Create ball entities ───
    // Interpolated points render slightly smaller and lighter so the user
    // can still tell what they recorded vs what was auto-filled; both are
    // equally clickable.
    for (let i = 0; i < waypoints.length; i++) {
        const w = waypoints[i];
        w.entity = cesium.entities.add({
            position: w.ecef,
            point: {
                pixelSize: w.interpolated ? 10 : 14,
                color: w.interpolated ? COLOR_INTERPOLATED : COLOR_DEFAULT,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: w.interpolated ? 1 : 2,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                heightReference: Cesium.HeightReference.NONE,
            },
        });
    }

    // ─── State transitions ───
    function setTilesetsVisible(visible: boolean) {
        for (const t of tilesets) t.show = visible;
    }
    function setBallsVisible(visible: boolean) {
        for (const w of waypoints) if (w.entity) w.entity.show = visible;
    }

    /** Altitude (above the exited waypoint's terrain) and pitch the
     *  camera lifts to when returning to OVERVIEW from a POINT. Tuned so
     *  the user sees the spot they were just standing on, from above. */
    const RETURN_ALTITUDE_M = 150;
    const RETURN_PITCH_DEG = -70;

    function enterOverview() {
        if (mode === "overview") return;
        const exitedIndex = currentIndex; // capture before reset
        mode = "overview";
        currentIndex = -1;
        setTilesetsVisible(false);
        setBallsVisible(true);
        canvas.style.cursor = "default";
        cesium.selectedEntity = undefined;
        // Lift the camera up over the exited waypoint and pitch back
        // down — feels like backing out of a Street View to see "where
        // were we?" on the map. Falls back to a plain `setView` snap if
        // there was no point to exit from (e.g. programmatic call).
        if (exitedIndex >= 0) {
            const wp = waypoints[exitedIndex];
            camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(
                    wp.lon, wp.lat, wp.height_m + RETURN_ALTITUDE_M,
                ),
                orientation: {
                    heading: Cesium.Math.toRadians(wp.heading_deg),
                    pitch: Cesium.Math.toRadians(RETURN_PITCH_DEG),
                    roll: 0,
                },
                duration: 0.6,
            });
        }
        console.log("[guided] OVERVIEW (splat hidden, balls visible)");
        renderHud();
    }

    function enterPoint(idx: number) {
        if (idx < 0 || idx >= waypoints.length) return;
        const wp = waypoints[idx];
        mode = "point";
        currentIndex = idx;
        setTilesetsVisible(true);
        setBallsVisible(false);
        canvas.style.cursor = "default";
        cesium.selectedEntity = undefined;
        camera.flyTo({
            destination: wp.ecef,
            orientation: {
                heading: Cesium.Math.toRadians(wp.heading_deg),
                pitch: Cesium.Math.toRadians(wp.pitch_deg),
                roll: 0,
            },
            duration: 0.6,
        });
        console.log(`[guided] POINT #${idx + 1} (lat ${wp.lat.toFixed(6)}, hdg ${wp.heading_deg.toFixed(1)}°)`);
        renderHud();
    }

    // Initial render: overview, splat hidden. Setting tilesets.show in the
    // same frame they were added is fine — Cesium reads `show` per draw.
    setTilesetsVisible(false);
    setBallsVisible(true);

    // ─── Click on ball → POINT mode ───
    const sse = new Cesium.ScreenSpaceEventHandler(canvas);
    sse.setInputAction((event: { position: Cesium.Cartesian2 }) => {
        if (mode !== "overview") return;
        const picked = cesium.scene.pick(event.position);
        if (!picked || !picked.id) return;
        const idx = waypoints.findIndex((w) => w.entity === picked.id);
        if (idx >= 0) enterPoint(idx);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // ─── Hover highlight in overview mode ───
    function restoreBallStyle(i: number) {
        const w = waypoints[i];
        const e = w.entity;
        if (!e?.point) return;
        e.point.color = new Cesium.ConstantProperty(
            w.interpolated ? COLOR_INTERPOLATED : COLOR_DEFAULT,
        );
        e.point.pixelSize = new Cesium.ConstantProperty(w.interpolated ? 10 : 14);
    }
    sse.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => {
        if (mode !== "overview") return;
        const picked = cesium.scene.pick(event.endPosition);
        const idx = picked && picked.id
            ? waypoints.findIndex((w) => w.entity === picked.id)
            : -1;
        if (idx === hoveredIdx) return;
        if (hoveredIdx >= 0) restoreBallStyle(hoveredIdx);
        if (idx >= 0) {
            const e = waypoints[idx].entity;
            if (e?.point) {
                e.point.color = new Cesium.ConstantProperty(COLOR_HOVER);
                e.point.pixelSize = new Cesium.ConstantProperty(20);
            }
            canvas.style.cursor = "pointer";
        } else {
            canvas.style.cursor = "default";
        }
        hoveredIdx = idx;
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // ─── Right-click exits POINT → OVERVIEW ───
    // Hooked at the Cesium event layer (RIGHT_CLICK fires only when the
    // user releases without a meaningful drag — Cesium's own right-drag
    // tilt still works for inspecting the splat). The browser context
    // menu is suppressed on the canvas so the gesture feels native.
    sse.setInputAction(() => {
        if (mode === "point") enterOverview();
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    const onContextMenu = (e: MouseEvent) => { e.preventDefault(); };
    canvas.addEventListener("contextmenu", onContextMenu);

    // ─── Per-frame 5 m radius enforcement in POINT mode ───
    // Runs after each render. Hooked here (not in setInputAction) so it
    // catches movement from any source: Cesium's default mouse controls,
    // flyover-controls keys, scripted flyTo's mid-flight, etc.
    let snapping = false; // re-entry guard for setView triggering events
    const removeRender = cesium.scene.postRender.addEventListener(() => {
        if (mode !== "point" || currentIndex < 0 || snapping) return;
        const wp = waypoints[currentIndex];
        const distFromCurrent = Cesium.Cartesian3.distance(camera.positionWC, wp.ecef);
        if (distFromCurrent <= POINT_RADIUS_M) return;

        // Outside the current bubble. Pick the actual nearest waypoint.
        const { idx: nearestIdx, distM } = findNearest(camera.positionWC, waypoints);
        snapping = true;
        try {
            if (nearestIdx !== currentIndex) {
                // Snap position to the new waypoint, but preserve the
                // user's current heading/pitch so they don't get whipped
                // around mid-walk.
                currentIndex = nearestIdx;
                const newWp = waypoints[nearestIdx];
                camera.setView({
                    destination: newWp.ecef,
                    orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 },
                });
            } else {
                // Still the same nearest waypoint but outside its bubble
                // (the user drifted away from everyone). Push back along
                // the breach vector to sit on the boundary.
                const pos = camera.positionWC;
                const diff = Cesium.Cartesian3.subtract(wp.ecef, pos, new Cesium.Cartesian3());
                const dir = Cesium.Cartesian3.normalize(diff, new Cesium.Cartesian3());
                const push = Cesium.Cartesian3.multiplyByScalar(
                    dir, distM - POINT_RADIUS_M, new Cesium.Cartesian3(),
                );
                const newPos = Cesium.Cartesian3.add(pos, push, new Cesium.Cartesian3());
                camera.setView({
                    destination: newPos,
                    orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
                });
            }
        } finally {
            snapping = false;
        }
    });

    // ─── On-screen controls hint (bottom-left, mode-aware) ───
    const hud = document.createElement("div");
    Object.assign(hud.style, {
        position: "fixed",
        bottom: "12px",
        left: "12px",
        zIndex: "9998",
        padding: "10px 14px",
        background: "rgba(20,20,28,0.78)",
        color: "#fff",
        font: "12px/1.45 system-ui, sans-serif",
        border: "1px solid rgba(255,255,255,0.18)",
        borderRadius: "8px",
        maxWidth: "320px",
        pointerEvents: "none",
        backdropFilter: "blur(4px)",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(hud);
    function renderHud() {
        const overview = mode === "overview";
        hud.innerHTML = overview
            ? `<div style="font-weight:600;margin-bottom:4px;">Overview · pick a blue point</div>
               <div><b>Click</b> a blue dot &nbsp;→&nbsp; enter street view</div>
               <div><b>R / T</b> forward / back &nbsp; <b>D / F</b> strafe</div>
               <div><b>E / C</b> up / down &nbsp; <b>Arrows</b> look</div>
               <div>Mouse drag pans · wheel zooms · <b>Shift</b> = 5×</div>`
            : `<div style="font-weight:600;margin-bottom:4px;">Inside the splat · 5 m bubble</div>
               <div><b>R / T</b> forward / back &nbsp; <b>D / F</b> strafe</div>
               <div><b>Arrows</b> look around &nbsp; <b>Mouse drag</b> rotate</div>
               <div><b>Right-click</b> exit back to overview</div>
               <div style="opacity:0.65;margin-top:3px;">Walking past 5 m snaps to the nearest captured point.</div>`;
    }
    renderHud();

    // ─── Devtools shortcuts ───
    const w = window as unknown as Record<string, unknown>;
    w.__guidedEnterPoint = (i: number) => enterPoint(i);
    w.__guidedExit = () => enterOverview();
    w.__guidedWaypoints = waypoints;

    console.log(
        "%c[guided] click a blue ball to enter point mode · right-click to exit back to overview",
        "background:#2a3a55;color:#e0eaff;padding:2px 6px;border-radius:3px;",
    );

    return {
        detach: () => {
            for (const wp of waypoints) {
                if (wp.entity) cesium.entities.remove(wp.entity);
            }
            sse.destroy();
            canvas.removeEventListener("contextmenu", onContextMenu);
            removeRender();
            if (hud.parentNode) hud.parentNode.removeChild(hud);
        },
    };
}
