import * as Cesium from "cesium";
import type { Viewer } from "./viewer";
import type { WalkMode } from "./datasets/types";

// Vite HMR: force a full page reload on any edit to this module so we
// never end up with stale duplicate editor instances bound to stale data.
if (import.meta.hot) {
    import.meta.hot.accept(() => {
        location.reload();
    });
}

// Manual waypoint recorder. Workflow:
//   1. Fly the camera anywhere using R/T/D/F (walk) + E/C (up/down) +
//      arrows (look) — or with the mouse.
//   2. Click "● Record" to drop a blue ball at the current camera position
//      and capture the camera's full pose (lat / lon / height / heading /
//      pitch). The new waypoint joins the list at the end.
//   3. Click "🗑 Delete" to remove the currently selected waypoint, or
//      "Delete last" to pop the most recent one.
//   4. Click "💾 Export" to download the collected waypoints as JSON.
//
// The editor never reads an existing waypoints.json — recording is purely
// additive. The exported file is what gets written to disk.

interface RecordedWaypoint {
    lat: number;
    lon: number;
    height_m: number;     // camera elevation in WGS84 ellipsoidal meters
    heading_deg: number;
    pitch_deg: number;
    ts: number | null;
    entity?: Cesium.Entity;
}

const COLOR_DEFAULT = Cesium.Color.fromCssColorString("#3aa8ff").withAlpha(0.85);
const COLOR_SELECTED = Cesium.Color.fromCssColorString("#ff9933").withAlpha(0.95);

export interface WaypointEditorHandle {
    detach: () => void;
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

export async function setupWaypointEditor(
    viewer: Viewer,
    walkMode: WalkMode,
): Promise<WaypointEditorHandle> {
    if (!viewer.cesium) return { detach: () => {} };
    const cesium = viewer.cesium;
    const waypoints: RecordedWaypoint[] = [];
    let currentIndex = -1; // -1 = nothing selected yet (empty list)

    // Load whatever's already in the waypoints file so its balls are
    // visible immediately. The user can still add to / delete from / fully
    // overwrite the set; on Export, only the in-memory list is serialized.
    // Failure to fetch (no file yet) is fine — we just start empty.
    try {
        const resp = await fetch(walkMode.waypointsUrl);
        if (resp.ok) {
            const file = (await resp.json()) as WaypointsFile;
            for (const w of file.waypoints ?? []) {
                waypoints.push({
                    lat: w.lat,
                    lon: w.lon,
                    height_m: w.height_m,
                    heading_deg: w.heading_deg,
                    pitch_deg: w.pitch_deg ?? 0,
                    ts: w.ts ?? null,
                });
            }
            console.log(`[editor] preloaded ${waypoints.length} waypoints from ${walkMode.waypointsUrl}`);
        }
    } catch (e) {
        console.warn(`[editor] no existing waypoints file to preload (${e}); starting empty.`);
    }

    function makeEntity(w: RecordedWaypoint, index: number): Cesium.Entity {
        // CallbackProperty reads live `w.*` values so any future mutation
        // (none planned in this design, but defensive) shows up instantly.
        const positionProp = new Cesium.CallbackProperty(
            () => Cesium.Cartesian3.fromDegrees(w.lon, w.lat, w.height_m),
            false,
        ) as unknown as Cesium.PositionProperty;
        return cesium.entities.add({
            position: positionProp,
            point: {
                pixelSize: 14,
                color: COLOR_DEFAULT,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 2,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                heightReference: Cesium.HeightReference.NONE,
            },
            label: {
                text: String(index + 1),
                font: "12px sans-serif",
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -20),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                heightReference: Cesium.HeightReference.NONE,
                show: true,
            },
        });
    }

    function relabelAll() {
        // After a delete, indices shift — refresh labels so 1..N stays
        // contiguous on screen.
        for (let i = 0; i < waypoints.length; i++) {
            const e = waypoints[i].entity;
            if (e?.label) e.label.text = new Cesium.ConstantProperty(String(i + 1));
        }
    }

    function refreshColors() {
        for (let i = 0; i < waypoints.length; i++) {
            const e = waypoints[i].entity;
            if (!e?.point) continue;
            e.point.color = new Cesium.ConstantProperty(
                i === currentIndex ? COLOR_SELECTED : COLOR_DEFAULT,
            );
            e.point.pixelSize = new Cesium.ConstantProperty(i === currentIndex ? 20 : 14);
        }
    }

    function setSelected(idx: number) {
        if (waypoints.length === 0) {
            currentIndex = -1;
        } else {
            currentIndex = ((idx % waypoints.length) + waypoints.length) % waypoints.length;
        }
        refreshColors();
        updateInfo();
    }

    // ───── UI panel ─────
    const panel = document.createElement("div");
    Object.assign(panel.style, {
        position: "fixed",
        top: "12px",
        right: "12px",
        zIndex: "9999",
        padding: "12px",
        fontFamily: "system-ui, sans-serif",
        fontSize: "13px",
        background: "rgba(20,20,28,0.92)",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.2)",
        borderRadius: "8px",
        minWidth: "280px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    } satisfies Partial<CSSStyleDeclaration>);

    const title = document.createElement("div");
    title.textContent = "Waypoint Recorder";
    title.style.cssText = "font-weight:bold;margin-bottom:6px;font-size:14px;";
    panel.appendChild(title);

    const help = document.createElement("div");
    help.style.cssText = "font-size:11px;opacity:0.7;margin-bottom:8px;line-height:1.5;";
    help.innerHTML =
        "Fly camera with R/T (forward/back) · D/F (strafe) · E/C (up/down) · Arrows (look) · Mouse. " +
        "Position camera where you want a waypoint, then click Record.";
    panel.appendChild(help);

    const info = document.createElement("div");
    info.style.cssText = "font-size:11px;background:#0008;padding:6px 8px;border-radius:4px;margin-bottom:8px;line-height:1.4;font-family:monospace;";
    panel.appendChild(info);

    function updateInfo() {
        if (currentIndex < 0 || waypoints.length === 0) {
            info.innerHTML = `<div>Recorded: <b>0</b> waypoints</div><div style='opacity:0.6'>(none selected)</div>`;
            return;
        }
        const w = waypoints[currentIndex];
        info.innerHTML = `
            <div>Recorded: <b>${waypoints.length}</b> &nbsp;·&nbsp; selected <b>#${currentIndex + 1}</b></div>
            <div>lat ${w.lat.toFixed(6)}</div>
            <div>lon ${w.lon.toFixed(6)}</div>
            <div>h ${w.height_m.toFixed(2)} m &nbsp; hdg ${w.heading_deg.toFixed(1)}° &nbsp; pitch ${w.pitch_deg.toFixed(1)}°</div>
        `;
    }

    function styleButton(b: HTMLButtonElement, color: string) {
        Object.assign(b.style, {
            flex: "1",
            padding: "8px",
            background: color,
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "13px",
            fontFamily: "system-ui, sans-serif",
        } satisfies Partial<CSSStyleDeclaration>);
    }

    // ─── Record button (the main action) ───
    const btnRecord = document.createElement("button");
    btnRecord.textContent = "● Record camera position";
    styleButton(btnRecord, "#bf3a3a");
    btnRecord.style.width = "100%";
    btnRecord.style.padding = "12px";
    btnRecord.style.fontSize = "14px";
    btnRecord.style.fontWeight = "bold";
    btnRecord.style.marginBottom = "8px";
    btnRecord.onclick = () => {
        const cam = cesium.camera;
        const carto = Cesium.Cartographic.fromCartesian(cam.positionWC);
        const w: RecordedWaypoint = {
            lat: Cesium.Math.toDegrees(carto.latitude),
            lon: Cesium.Math.toDegrees(carto.longitude),
            height_m: carto.height,
            heading_deg: ((Cesium.Math.toDegrees(cam.heading) % 360) + 360) % 360,
            pitch_deg: Cesium.Math.toDegrees(cam.pitch),
            ts: null,
        };
        w.entity = makeEntity(w, waypoints.length);
        waypoints.push(w);
        setSelected(waypoints.length - 1);
        console.log(
            `[editor] recorded #${waypoints.length}: lat=${w.lat.toFixed(6)} lon=${w.lon.toFixed(6)} ` +
            `h=${w.height_m.toFixed(2)} hdg=${w.heading_deg.toFixed(1)}° pitch=${w.pitch_deg.toFixed(1)}°`,
        );
    };
    panel.appendChild(btnRecord);

    // ─── Nav: prev / next ───
    const navRow = document.createElement("div");
    navRow.style.cssText = "display:flex;gap:6px;margin-bottom:6px;";
    const btnPrev = document.createElement("button");
    btnPrev.textContent = "← Prev";
    const btnNext = document.createElement("button");
    btnNext.textContent = "Next →";
    styleButton(btnPrev, "#333");
    styleButton(btnNext, "#333");
    btnPrev.onclick = () => { if (waypoints.length) setSelected(currentIndex - 1); };
    btnNext.onclick = () => { if (waypoints.length) setSelected(currentIndex + 1); };
    navRow.appendChild(btnPrev);
    navRow.appendChild(btnNext);
    panel.appendChild(navRow);

    // ─── Fly to selected ───
    const btnJump = document.createElement("button");
    btnJump.textContent = "🎯 Fly to selected";
    styleButton(btnJump, "#2a5577");
    btnJump.style.width = "100%";
    btnJump.style.marginBottom = "6px";
    btnJump.onclick = () => {
        if (currentIndex < 0) return;
        const w = waypoints[currentIndex];
        cesium.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(w.lon, w.lat, w.height_m),
            orientation: {
                heading: Cesium.Math.toRadians(w.heading_deg),
                pitch: Cesium.Math.toRadians(w.pitch_deg),
                roll: 0,
            },
            duration: 0.8,
        });
    };
    panel.appendChild(btnJump);

    // ─── Delete row ───
    const delRow = document.createElement("div");
    delRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;";
    const btnDeleteSelected = document.createElement("button");
    btnDeleteSelected.textContent = "🗑 Delete selected";
    styleButton(btnDeleteSelected, "#552a2a");
    btnDeleteSelected.onclick = () => {
        if (currentIndex < 0 || waypoints.length === 0) return;
        const removed = waypoints.splice(currentIndex, 1)[0];
        if (removed.entity) cesium.entities.remove(removed.entity);
        relabelAll();
        if (waypoints.length === 0) {
            setSelected(-1);
        } else {
            setSelected(Math.min(currentIndex, waypoints.length - 1));
        }
        console.log(`[editor] deleted; ${waypoints.length} remain.`);
    };
    const btnDeleteLast = document.createElement("button");
    btnDeleteLast.textContent = "🗑 Delete last";
    styleButton(btnDeleteLast, "#552a2a");
    btnDeleteLast.onclick = () => {
        if (waypoints.length === 0) return;
        const removed = waypoints.pop()!;
        if (removed.entity) cesium.entities.remove(removed.entity);
        relabelAll();
        if (waypoints.length === 0) {
            setSelected(-1);
        } else {
            setSelected(waypoints.length - 1);
        }
        console.log(`[editor] popped; ${waypoints.length} remain.`);
    };
    delRow.appendChild(btnDeleteSelected);
    delRow.appendChild(btnDeleteLast);
    panel.appendChild(delRow);

    // ─── Splat alignment (whole-dataset, NOT waypoint-specific) ───
    // Re-exposes the splat-debug-controls keyboard shortcuts as buttons for
    // when the user is mousing in the panel and notices the splat tilted
    // or floating. Each click calls a delta-style helper on window that
    // splat-debug-controls owns; Ctrl+P prints the current full pose.
    const splatBlock = document.createElement("div");
    splatBlock.style.cssText = "margin:0 0 8px 0;padding:8px;background:#221a22;border-radius:4px;";
    const splatLabel = document.createElement("div");
    splatLabel.style.cssText = "font-size:11px;opacity:0.75;margin-bottom:6px;";
    splatLabel.innerHTML = "Splat alignment (whole dataset · Ctrl+P prints state)";
    splatBlock.appendChild(splatLabel);

    function getWin<T extends string>(name: T): ((d: number) => void) | undefined {
        const w = window as unknown as Record<string, unknown>;
        return typeof w[name] === "function" ? (w[name] as (d: number) => void) : undefined;
    }
    function call(name: string, delta: number) {
        const fn = getWin(name);
        if (fn) fn(delta);
        else console.warn(`[editor] ${name} not available (splat-debug-controls not wired?)`);
    }

    function makeRow(label: string, buttons: Array<{ text: string; onClick: () => void }>) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:4px;margin-bottom:4px;align-items:center;";
        const lab = document.createElement("div");
        lab.textContent = label;
        lab.style.cssText = "width:90px;font-size:11px;opacity:0.75;";
        row.appendChild(lab);
        for (const b of buttons) {
            const btn = document.createElement("button");
            btn.textContent = b.text;
            styleButton(btn, "#552a3a");
            btn.style.padding = "4px 6px";
            btn.style.fontSize = "11px";
            btn.onclick = b.onClick;
            row.appendChild(btn);
        }
        splatBlock.appendChild(row);
    }
    // Tilt N/S = roll around the east axis (a/s in splat-debug); lifts or
    // drops the north end. If the splat looks "north end too high",
    // click −1° here a few times.
    makeRow("tilt N/S (a/s)", [
        { text: "−1°", onClick: () => call("__bumpSplatRollX", -1) },
        { text: "−0.1°", onClick: () => call("__bumpSplatRollX", -0.1) },
        { text: "+0.1°", onClick: () => call("__bumpSplatRollX", +0.1) },
        { text: "+1°", onClick: () => call("__bumpSplatRollX", +1) },
    ]);
    // Tilt E/W = pitch around the north axis (q/w in splat-debug); lifts
    // or drops the east end.
    makeRow("tilt E/W (q/w)", [
        { text: "−1°", onClick: () => call("__bumpSplatPitchY", -1) },
        { text: "−0.1°", onClick: () => call("__bumpSplatPitchY", -0.1) },
        { text: "+0.1°", onClick: () => call("__bumpSplatPitchY", +0.1) },
        { text: "+1°", onClick: () => call("__bumpSplatPitchY", +1) },
    ]);
    makeRow("yaw (z/x)", [
        { text: "−1°", onClick: () => call("__bumpSplatYaw", -1) },
        { text: "−0.1°", onClick: () => call("__bumpSplatYaw", -0.1) },
        { text: "+0.1°", onClick: () => call("__bumpSplatYaw", +0.1) },
        { text: "+1°", onClick: () => call("__bumpSplatYaw", +1) },
    ]);
    makeRow("height (o/l)", [
        { text: "−5m", onClick: () => call("__bumpSplatHeight", -5) },
        { text: "−1m", onClick: () => call("__bumpSplatHeight", -1) },
        { text: "+1m", onClick: () => call("__bumpSplatHeight", +1) },
        { text: "+5m", onClick: () => call("__bumpSplatHeight", +5) },
    ]);
    panel.appendChild(splatBlock);

    // ─── Export ───
    const btnExport = document.createElement("button");
    btnExport.textContent = "💾 Export waypoints.json";
    styleButton(btnExport, "#774a2a");
    btnExport.style.width = "100%";
    btnExport.style.marginBottom = "6px";
    btnExport.onclick = () => {
        if (waypoints.length === 0) {
            alert("No waypoints recorded yet.");
            return;
        }
        const out = {
            version: "1.0",
            source: "manual-record",
            waypoints: waypoints.map((w) => ({
                lat: Number(w.lat.toFixed(8)),
                lon: Number(w.lon.toFixed(8)),
                height_m: Number(w.height_m.toFixed(3)),
                heading_deg: Number(w.heading_deg.toFixed(2)),
                pitch_deg: Number(w.pitch_deg.toFixed(2)),
                ts: w.ts,
            })),
        };
        const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = walkMode.waypointsUrl.split("/").pop() || "waypoints.json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log(`[editor] exported ${waypoints.length} waypoints.`);
    };
    panel.appendChild(btnExport);

    const btnHide = document.createElement("button");
    btnHide.textContent = "Hide panel";
    styleButton(btnHide, "#444");
    btnHide.style.width = "100%";
    btnHide.style.fontSize = "11px";
    btnHide.style.padding = "4px";
    btnHide.onclick = () => {
        panel.style.display = "none";
        showHandle.style.display = "block";
    };
    panel.appendChild(btnHide);

    document.body.appendChild(panel);

    const showHandle = document.createElement("button");
    showHandle.textContent = "📝 Recorder";
    Object.assign(showHandle.style, {
        position: "fixed",
        top: "12px",
        right: "12px",
        zIndex: "9999",
        padding: "6px 10px",
        background: "rgba(20,20,28,0.92)",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.2)",
        borderRadius: "6px",
        cursor: "pointer",
        fontSize: "12px",
        display: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    showHandle.onclick = () => {
        panel.style.display = "block";
        showHandle.style.display = "none";
    };
    document.body.appendChild(showHandle);

    // Materialize ball entities for any waypoints loaded from the JSON file
    // at startup. New waypoints created via Record get their entities at
    // that point; this just handles the pre-existing set.
    for (let i = 0; i < waypoints.length; i++) {
        waypoints[i].entity = makeEntity(waypoints[i], i);
    }
    if (waypoints.length > 0) setSelected(0);
    else updateInfo();

    console.log(
        "%c[editor] Recorder ready. Fly camera, click Record to drop a waypoint.",
        "background:#1a4055;color:#e0f0ff;padding:2px 6px;border-radius:3px;",
    );

    return {
        detach: () => {
            for (const w of waypoints) {
                if (w.entity) cesium.entities.remove(w.entity);
            }
            if (panel.parentNode) panel.parentNode.removeChild(panel);
            if (showHandle.parentNode) showHandle.parentNode.removeChild(showHandle);
        },
    };
}
