import * as Cesium from "cesium";

import { Viewer } from "./viewer";

// Expose Cesium globally so DevTools can use `Cesium.Cartesian3.fromDegrees(...)`
// etc. without needing dynamic imports (which don't work cleanly in dev mode).
(window as unknown as { Cesium: typeof Cesium }).Cesium = Cesium;
import { pickDatasetFromUrl, type DatasetConfig } from "./datasets";
import { playDemoFlow, addDemoButton } from "./demo-flow";
import { setupFlyoverControls } from "./flyover-controls";

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
    // When `tilesetUrl` is an array we load one Cesium3DTileset per URL and
    // share the same orientation/altitude fix across them. Used for
    // bandwidth/quality-balanced multi-chunk splits.
    const urls = Array.isArray(config.splat.tilesetUrl)
        ? config.splat.tilesetUrl
        : [config.splat.tilesetUrl];
    // Per-tileset cache budget. The Cesium 1.141 GaussianSplatPrimitive
    // aggregates *all* currently-loaded splats from a tileset into one
    // Float32 texture buffer, which OOMs the JS heap when two dense cells
    // (~50 M splats each on Lublin) refine to deep LOD at the same time.
    // 128 MB/cell (~1.28 GB total) keeps each primitive's buffer well under
    // the 2 GB ArrayBuffer ceiling. Live override: window.__setCache(GB).
    const perTilesetCacheBytes = 128 * 1024 * 1024;
    const tilesets = await Promise.all(
        urls.map((u) =>
            Cesium.Cesium3DTileset.fromUrl(u, {
                maximumScreenSpaceError: config.splat.maximumScreenSpaceError ?? 16,
                cacheBytes: perTilesetCacheBytes,
                maximumCacheOverflowBytes: Math.floor(perTilesetCacheBytes / 4),
            }),
        ),
    );
    const tileset = tilesets[0]; // backwards-compatible alias for the rest of this fn

    // Optional orientation fix: multiply root.transform by a local rotation
    // so PLYs converted with the wrong --input-convention can still load
    // upright without re-running the (hours-long) conversion. Applied to
    // every tileset in the (possibly multi-chunk) set.
    const fix = config.splat.orientationFixDeg;
    if (fix && (fix.x || fix.y || fix.z)) {
        const rx = Cesium.Math.toRadians(fix.x ?? 0);
        const ry = Cesium.Math.toRadians(fix.y ?? 0);
        const rz = Cesium.Math.toRadians(fix.z ?? 0);
        const m3 = Cesium.Matrix3.multiply(
            Cesium.Matrix3.multiply(
                Cesium.Matrix3.fromRotationX(rx),
                Cesium.Matrix3.fromRotationY(ry),
                new Cesium.Matrix3(),
            ),
            Cesium.Matrix3.fromRotationZ(rz),
            new Cesium.Matrix3(),
        );
        const fixMat = Cesium.Matrix4.fromRotationTranslation(m3, Cesium.Cartesian3.ZERO);
        for (const t of tilesets) {
            t.root.transform = Cesium.Matrix4.multiply(
                t.root.transform,
                fixMat,
                new Cesium.Matrix4(),
            );
        }
        console.log(`[dataset] applied orientationFix (deg) x=${fix.x ?? 0} y=${fix.y ?? 0} z=${fix.z ?? 0} to ${tilesets.length} tileset(s)`);
    }

    // Track the *baseline* origins (post-rotation, pre-height-shift) per
    // tileset so the height nudge is always a delta from the converter's
    // --coordinate value — not cumulative across nudges.
    const baselineOrigins = tilesets.map((t) =>
        Cesium.Matrix4.getTranslation(t.root.transform, new Cesium.Cartesian3()),
    );
    const applyHeight = (deltaM: number) => {
        for (let i = 0; i < tilesets.length; i++) {
            const t = tilesets[i];
            const origin = baselineOrigins[i];
            const up = Cesium.Cartesian3.normalize(origin, new Cesium.Cartesian3());
            const offset = Cesium.Cartesian3.multiplyByScalar(up, deltaM, new Cesium.Cartesian3());
            const newOrigin = Cesium.Cartesian3.add(origin, offset, new Cesium.Cartesian3());
            Cesium.Matrix4.setTranslation(t.root.transform, newOrigin, t.root.transform);
        }
    };

    const initialHeightM = config.splat.additionalHeightM ?? 0;
    if (initialHeightM) {
        applyHeight(initialHeightM);
        console.log(`[dataset] applied additionalHeightM = ${initialHeightM} m (along local up)`);
    }

    // Devtools helper for live tuning. Each call replaces the previous shift
    // (not cumulative) so you can sweep through values quickly. When the
    // splat sits correctly, paste the printed value into config.splat.additionalHeightM.
    (window as unknown as { __nudgeHeight: (d: number) => void }).__nudgeHeight = (deltaM: number) => {
        applyHeight(deltaM);
        console.log(
            `[height] set to ${deltaM} m along local up.  Bake into config.splat.additionalHeightM if good.`,
        );
    };

    for (const t of tilesets) {
        viewer.cesium.scene.primitives.add(t);
    }

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
        `%c[dataset] ${config.displayName}\n  loaded ${tilesets.length} tileset(s): ${urls.join("\n    ")}\n  __setSSE(N) to override LOD aggressiveness for all chunks.`,
        "background:#1a3550;color:#eaf2ff;padding:2px 6px;border-radius:3px;",
    );

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

    addDemoButton(() => playDemoFlow(viewer, config));

    setupFlyoverControls(viewer);
}

if (viewer.cesium) {
    const config = pickDatasetFromUrl();
    console.log(`[dispatch] dataset = ${config.id}  (${config.displayName})`);
    addAttribution(config);
    loadDataset(config);
} else {
    console.error("Cesium viewer not initialized");
}
