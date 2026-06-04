import * as Cesium from "cesium";

import type { DatasetConfig } from "./datasets";
import type { Viewer } from "./viewer";

// Scripted intro for the recorded video. With native Cesium 3D Tiles +
// KHR_gaussian_splatting, tile loading and LOD are entirely Cesium's job —
// this module just choreographs the camera. Stages:
//   1. Establish: snap to a high overview over Europe.
//   2. Fly in: smooth flyTo to the dataset's overview altitude.
//   3. Dive: drop to "flyover" altitude (above the rooftops, pitched down).
//   4. Glide: slow horizontal pan over the city.
// All durations are constants up here for easy retiming during recording.

const EUROPE_OVERVIEW = {
    lon: 19.0,
    lat: 50.0,
    height: 1_500_000,
    heading: 0,
    pitch: -90,
};

const ESTABLISH_MS = 1500;
const FLY_IN_SEC = 5;
const DIVE_SEC = 6;
const GLIDE_SEC = 12;

// End of dive: this many meters above the hero's anchor altitude, pitched down.
const FLYOVER_HEIGHT_ABOVE_ANCHOR_M = 60;
const FLYOVER_PITCH_DEG = -55;

// Glide defaults if the dataset config doesn't set them.
const DEFAULT_GLIDE_DISTANCE_M = 200;
const DEFAULT_GLIDE_HEADING_DEG = 0; // north

interface CaptionSpec {
    atMs: number;
    text: string;
    durationMs: number;
}
const DEFAULT_CAPTIONS: CaptionSpec[] = [
    { atMs: 0, text: "Lublin City 2025", durationMs: 3500 },
    {
        atMs: 1800,
        text: "Photogrammetry by Andrii Shramko / Teleportour",
        durationMs: 5000,
    },
    {
        atMs: 13000,
        text: "Drone flyover · 3D Gaussian Splats inside Cesium",
        durationMs: 6000,
    },
    {
        atMs: 23000,
        text: "Take control — R/T fly · D/F strafe · PgUp/PgDn altitude · Arrows look",
        durationMs: 6000,
    },
];

function flyToPromise(
    camera: Cesium.Camera,
    opts: {
        lon: number;
        lat: number;
        height: number;
        heading?: number;
        pitch?: number;
        durationSec: number;
    },
): Promise<void> {
    return new Promise((resolve) => {
        camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(opts.lon, opts.lat, opts.height),
            orientation: {
                heading: Cesium.Math.toRadians(opts.heading ?? 0),
                pitch: Cesium.Math.toRadians(opts.pitch ?? -45),
                roll: 0,
            },
            duration: opts.durationSec,
            complete: () => resolve(),
            cancel: () => resolve(),
        });
    });
}

function captionEl(): HTMLDivElement {
    const el = document.createElement("div");
    Object.assign(el.style, {
        position: "fixed",
        bottom: "8%",
        left: "50%",
        transform: "translateX(-50%)",
        padding: "10px 18px",
        background: "rgba(20,20,28,0.78)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        fontSize: "18px",
        borderRadius: "8px",
        zIndex: "9999",
        opacity: "0",
        transition: "opacity 0.4s ease",
        pointerEvents: "none",
        textShadow: "0 1px 2px rgba(0,0,0,0.6)",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
    return el;
}

function scheduleCaptions(captions: CaptionSpec[], el: HTMLDivElement) {
    for (const c of captions) {
        setTimeout(() => {
            el.textContent = c.text;
            el.style.opacity = "1";
            setTimeout(() => {
                el.style.opacity = "0";
            }, c.durationMs);
        }, c.atMs);
    }
}

export async function playDemoFlow(viewer: Viewer, config: DatasetConfig): Promise<void> {
    if (!viewer.cesium) return;
    const fly = config.initialFlyTo;
    if (!fly) {
        console.warn("[demo] config has no initialFlyTo; aborting");
        return;
    }

    const captionDiv = captionEl();
    scheduleCaptions(DEFAULT_CAPTIONS, captionDiv);

    // ── 1. Establish.
    viewer.cesium.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
            EUROPE_OVERVIEW.lon,
            EUROPE_OVERVIEW.lat,
            EUROPE_OVERVIEW.height,
        ),
        orientation: {
            heading: Cesium.Math.toRadians(EUROPE_OVERVIEW.heading),
            pitch: Cesium.Math.toRadians(EUROPE_OVERVIEW.pitch),
            roll: 0,
        },
    });
    await new Promise((r) => setTimeout(r, ESTABLISH_MS));

    // ── 2. Fly in to overview altitude.
    await flyToPromise(viewer.cesium.camera, {
        lon: fly.lon,
        lat: fly.lat,
        height: fly.height,
        heading: fly.heading ?? 0,
        pitch: fly.pitch ?? -45,
        durationSec: FLY_IN_SEC,
    });

    // ── 3. Dive: position above the hero point at flyover altitude, pitched down.
    const hero = config.heroLocation ?? { lon: fly.lon, lat: fly.lat };
    const glideDistM = config.heroGlideDistanceM ?? DEFAULT_GLIDE_DISTANCE_M;
    const glideHeadingDeg = config.heroGlideHeadingDeg ?? DEFAULT_GLIDE_HEADING_DEG;
    const glideHeadingRad = Cesium.Math.toRadians(glideHeadingDeg);
    const deltaLat = (glideDistM * Math.cos(glideHeadingRad)) / 111320;
    const deltaLon =
        (glideDistM * Math.sin(glideHeadingRad)) /
        (111320 * Math.cos(Cesium.Math.toRadians(hero.lat)));
    const aheadLon = hero.lon + deltaLon;
    const aheadLat = hero.lat + deltaLat;

    // Anchor altitude inferred from initialFlyTo height; the dive sits 60 m above.
    // (Cesium streams whatever LOD it needs for that altitude/SSE automatically.)
    const flyoverH = FLYOVER_HEIGHT_ABOVE_ANCHOR_M;
    await flyToPromise(viewer.cesium.camera, {
        lon: hero.lon,
        lat: hero.lat,
        height: flyoverH,
        heading: glideHeadingDeg,
        pitch: FLYOVER_PITCH_DEG,
        durationSec: DIVE_SEC,
    });

    // ── 4. Slow glide across the hero area.
    await flyToPromise(viewer.cesium.camera, {
        lon: aheadLon,
        lat: aheadLat,
        height: flyoverH,
        heading: glideHeadingDeg,
        pitch: FLYOVER_PITCH_DEG,
        durationSec: GLIDE_SEC,
    });

    console.log(
        "[demo] sequence done — keyboard flyover (R/T fly, D/F strafe, PgUp/PgDn altitude, arrows look)",
    );
}

/** Drop a "▶ Play Demo" button next to the fly-to button. */
export function addDemoButton(onPlay: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = "▶ Play Demo";
    Object.assign(btn.style, {
        position: "fixed",
        top: "12px",
        left: "260px",
        zIndex: "9999",
        padding: "10px 14px",
        fontFamily: "system-ui, sans-serif",
        fontSize: "14px",
        background: "rgba(20,80,40,0.85)",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.2)",
        borderRadius: "8px",
        cursor: "pointer",
    } satisfies Partial<CSSStyleDeclaration>);
    btn.onclick = onPlay;
    document.body.appendChild(btn);
    return btn;
}
