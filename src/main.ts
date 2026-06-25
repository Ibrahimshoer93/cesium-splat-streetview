import * as Cesium from "cesium";

import { Viewer } from "./viewer";

// Expose Cesium globally so DevTools can use `Cesium.Cartesian3.fromDegrees(...)`
// etc. without needing dynamic imports (which don't work cleanly in dev mode).
(window as unknown as { Cesium: typeof Cesium }).Cesium = Cesium;
import { pickDatasetFromUrl, type DatasetConfig } from "./datasets";
import { playDemoFlow, addDemoButton } from "./demo-flow";
import { setupFlyoverControls } from "./flyover-controls";
import { setupWalkControls } from "./walk-controls";
import { setupSplatDebugControls } from "./splat-debug-controls";
import { setupWaypointEditor } from "./waypoint-editor";
import { setupGuidedMode } from "./guided-mode";

// Cesium Ion access token, injected by Vite from `.env` (local) or a GH
// Actions repo secret (deploy). Required when any dataset uses
// `ionAssetIds`; ignored for self-hosted tileset URLs.
const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;
if (ionToken) {
    Cesium.Ion.defaultAccessToken = ionToken;
} else {
    console.warn(
        "[ion] VITE_CESIUM_ION_TOKEN is not set. Datasets using Ion asset IDs will fail to load.\n" +
            "Copy .env.example to .env and paste your token from https://ion.cesium.com/tokens",
    );
}

const viewer = new Viewer();

function addAttribution(config: DatasetConfig) {
    if (!config.attribution || !viewer.cesium) return;
    try {
        viewer.cesium.creditDisplay.addStaticCredit(
            new Cesium.Credit(config.attribution, true /* show on screen */),
        );
    } catch (e) {
        console.warn("[dispatch] could not add attribution credit:", e);
    }
}

function addFlyToButton(config: DatasetConfig, onClick: () => void) {
    if (!config.initialFlyTo) return;
    const btn = document.createElement("button");
    btn.textContent = `→ Fly to ${config.displayName}`;
    Object.assign(btn.style, {
        position: "fixed",
        top: "12px",
        left: "12px",
        zIndex: "9999",
        padding: "10px 14px",
        fontFamily: "system-ui, sans-serif",
        fontSize: "14px",
        background: "rgba(20,20,28,0.85)",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.2)",
        borderRadius: "8px",
        cursor: "pointer",
    } satisfies Partial<CSSStyleDeclaration>);
    btn.onclick = onClick;
    document.body.appendChild(btn);
}

async function loadDataset(config: DatasetConfig) {
    if (!viewer.cesium) return;
    if (config.splat.kind !== "tileset") {
        console.error(
            `[dispatch] dataset ${config.id} uses splat.kind="${config.splat.kind}" which is no ` +
                `longer supported. Convert to a 3D Tiles tileset via 3dgs-ply-3dtiles-converter.`,
        );
        return;
    }

    // Add the 3D Tiles tileset(s). Cesium handles LOD streaming, frustum
    // culling, GPU memory, and the splat decoder — nothing left to babysit.
    // A dataset can use either `tilesetUrl` (self-hosted under public/data/)
    // or `ionAssetIds` (Cesium Ion). Per-tileset cache budget at 512 MB —
    // smaller cache (128 MB) starved aggressive SSE settings, Cesium warned
    // "more memory than allocated" and auto-coarsened. 512 MB × N tilesets
    // still leaves comfortable JS heap headroom. Live override:
    // window.__setCache(GB).
    const perTilesetCacheBytes = 512 * 1024 * 1024;
    const opts = {
        maximumScreenSpaceError: config.splat.maximumScreenSpaceError ?? 16,
        cacheBytes: perTilesetCacheBytes,
        maximumCacheOverflowBytes: Math.floor(perTilesetCacheBytes / 4),
    };
    let tilesets: Cesium.Cesium3DTileset[];
    let sourceLabel: string;
    if (config.splat.ionAssetIds && config.splat.ionAssetIds.length) {
        tilesets = await Promise.all(
            config.splat.ionAssetIds.map((id) => Cesium.Cesium3DTileset.fromIonAssetId(id, opts)),
        );
        sourceLabel = config.splat.ionAssetIds.map((id) => `ion:${id}`).join(", ");
    } else if (config.splat.tilesetUrl) {
        const urls = Array.isArray(config.splat.tilesetUrl)
            ? config.splat.tilesetUrl
            : [config.splat.tilesetUrl];
        tilesets = await Promise.all(urls.map((u) => Cesium.Cesium3DTileset.fromUrl(u, opts)));
        sourceLabel = urls.join(", ");
    } else {
        console.error(`[dispatch] dataset ${config.id} has neither tilesetUrl nor ionAssetIds`);
        return;
    }
    const tileset = tilesets[0]; // backwards-compatible alias for the rest of this fn

    for (const t of tilesets) {
        viewer.cesium.scene.primitives.add(t);
    }

    // Alignment controls — owns both the initial bake of
    // `orientationFixDeg` + `additionalHeightM` (read from config) and the
    // live keyboard/devtool tuning. Single source of truth so the load
    // state and the runtime state can never drift.
    //
    // Keys: q/w pitch · a/s roll · z/x yaw · y/h N/S · j/g E/W · o/l height
    // · Alt = 0.1× step · Shift = 10× step · Ctrl+P prints the current
    // state in copy-paste-ready config form.
    setupSplatDebugControls(viewer, tilesets, config);

    // Expose for devtools poking. __tileset = first (legacy single-tileset
    // helper still works); __tilesets = full array for multi-chunk datasets.
    (window as unknown as { __tileset: Cesium.Cesium3DTileset }).__tileset = tileset;
    (window as unknown as { __tilesets: Cesium.Cesium3DTileset[] }).__tilesets = tilesets;
    (window as unknown as { __setSSE: (sse: number) => void }).__setSSE = (sse: number) => {
        for (const t of tilesets) t.maximumScreenSpaceError = sse;
        console.log(`[sse] all ${tilesets.length} tilesets -> maximumScreenSpaceError = ${sse}`);
    };
    (window as unknown as { __setCache: (gbTotal: number) => void }).__setCache = (gbTotal: number) => {
        const perTileset = Math.floor((gbTotal * 1024 * 1024 * 1024) / tilesets.length);
        for (const t of tilesets) {
            t.cacheBytes = perTileset;
            t.maximumCacheOverflowBytes = Math.floor(perTileset / 4);
        }
        console.log(`[cache] ${gbTotal} GB total -> ${(perTileset / 1024 / 1024).toFixed(0)} MB per tileset across ${tilesets.length} tilesets`);
    };


    console.log(
        `%c[dataset] ${config.displayName}\n  loaded ${tilesets.length} tileset(s): ${sourceLabel}\n  __setSSE(N) to override LOD aggressiveness for all chunks.`,
        "background:#1a3550;color:#eaf2ff;padding:2px 6px;border-radius:3px;",
    );

    // Fly-to-overview button: useful for both aerial flyover (Lublin) and
    // street-view (Kınalıada) — in the latter case it's the "I drifted,
    // take me back to the overview" shortcut. Always wired when the
    // dataset has an initialFlyTo.
    addFlyToButton(config, () => {
        if (!viewer.cesium || !config.initialFlyTo) return;
        const fly = config.initialFlyTo;
        viewer.flyTo(
            fly.lon,
            fly.lat,
            fly.height,
            fly.heading ?? 0,
            fly.pitch ?? -45,
            fly.durationSec ?? 2,
        );
    });

    // Scripted Play Demo intro is Lublin-specific (hardcoded captions
    // and aerial flyover sequence). Skip for walk-mode datasets.
    if (!config.walkMode) {
        addDemoButton(() => playDemoFlow(viewer, config));
    }

    // Initial camera placement on load so the user lands at the overview.
    if (viewer.cesium && config.initialFlyTo) {
        const fly = config.initialFlyTo;
        viewer.flyTo(
            fly.lon,
            fly.lat,
            fly.height,
            fly.heading ?? 0,
            fly.pitch ?? -45,
            0.0,
        );
    }

    // Camera controller. Walk-mode datasets get the guided two-state
    // experience (overview hides the splat + shows clickable waypoint
    // balls; POINT mode reveals the splat in a 5 m bubble around the
    // clicked waypoint, with wheel-up to exit). Other datasets keep
    // free-fly flyover. Flyover-controls is also active under guided
    // mode for navigating around the island in OVERVIEW.
    setupFlyoverControls(viewer);
    if (config.walkMode) {
        setupGuidedMode(viewer, config.walkMode, tilesets);
    }

    // Waypoint recorder/editor panel is a dev tool only. Visit
    // ?dataset=...&dev=1 to surface it for recording or fixing waypoints.
    // In the demo experience it stays out of the user's way.
    const devMode = new URLSearchParams(window.location.search).get("dev") === "1";
    if (config.walkMode && devMode) {
        setupWaypointEditor(viewer, config.walkMode);
    }

    // setupWalkControls kept around as a reference fallback (was the
    // pre-guided radius-locked controller). Not currently called.
    void setupWalkControls;
}

if (viewer.cesium) {
    const config = pickDatasetFromUrl();
    console.log(`[dispatch] dataset = ${config.id}  (${config.displayName})`);
    addAttribution(config);
    loadDataset(config);
} else {
    console.error("Cesium viewer not initialized");
}
