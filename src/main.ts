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
    // or `ionAssetIds` (Cesium Ion). Per-tileset cache budget at 256 MB —
    // earlier 512 MB pushed integrated-GPU machines past their GPU memory
    // budget and produced <4 fps. 256 MB suits the public default;
    // discrete-GPU users can bump to High in the quality picker (sets
    // window.__setCache(1) = 1 GB total via the devtool).
    const perTilesetCacheBytes = 256 * 1024 * 1024;
    const QUALITY_TIERS: Record<string, { sse: number; cacheMB: number }> = {
        low: { sse: 32, cacheMB: 128 },
        medium: { sse: 16, cacheMB: 256 },
        high: { sse: 8, cacheMB: 512 },
    };

    // First-visit auto-detect of a sensible quality tier from coarse
    // hardware signals. Returns "medium" when uncertain (never throws and
    // never falsely upgrades). A previously saved choice takes priority,
    // so once the user picks Low/Med/High manually we never override.
    function detectQualityTier(): "low" | "medium" | "high" {
        // Mobile devices: always low. They run hot fast and can't sustain
        // 30 fps splat decoding for long.
        const ua = navigator.userAgent;
        if (/Mobile|Android|iPhone|iPad|iPod|webOS|Phone/i.test(ua)) return "low";

        // Probe WebGL renderer string. Often masked for privacy, but the
        // common Intel-integrated and NVIDIA/AMD/Apple strings still leak
        // through unmasked in most browsers.
        let gpuKind: "weak" | "strong" | "unknown" = "unknown";
        try {
            const canvas = document.createElement("canvas");
            const gl = (canvas.getContext("webgl2") || canvas.getContext("webgl")) as WebGLRenderingContext | null;
            if (gl) {
                const ext = gl.getExtension("WEBGL_debug_renderer_info");
                const r = ext
                    ? String(gl.getParameter((ext as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL))
                    : String(gl.getParameter(gl.RENDERER));
                const rl = r.toLowerCase();
                if (/swiftshader|llvmpipe|software|microsoft basic/.test(rl)) gpuKind = "weak";
                else if (/intel.*(hd|uhd|iris)/.test(rl)) gpuKind = "weak";
                else if (/(rtx|gtx|geforce|quadro|radeon|amd|apple\s*(m\d|gpu))/.test(rl)) gpuKind = "strong";
            }
        } catch {
            // Privacy / sandboxed contexts — leave as unknown.
        }

        const dm = (navigator as { deviceMemory?: number }).deviceMemory ?? 0;
        const cores = navigator.hardwareConcurrency ?? 0;

        if (gpuKind === "weak") return "low";
        if (dm > 0 && dm < 4) return "low";
        if (cores > 0 && cores < 4) return "low";
        if (gpuKind === "strong" && (dm === 0 || dm >= 8) && (cores === 0 || cores >= 8)) return "high";
        return "medium";
    }

    const savedQualityRaw = (typeof localStorage !== "undefined")
        ? localStorage.getItem("__guidedQuality")
        : null;
    let savedQuality: string;
    if (savedQualityRaw && savedQualityRaw in QUALITY_TIERS) {
        savedQuality = savedQualityRaw;
        console.log(`[quality] using saved choice "${savedQuality}"`);
    } else {
        savedQuality = detectQualityTier();
        const ua = navigator.userAgent.slice(0, 80);
        const dm = (navigator as { deviceMemory?: number }).deviceMemory ?? "?";
        const cores = navigator.hardwareConcurrency ?? "?";
        console.log(
            `[quality] auto-detected "${savedQuality}" (deviceMemory=${dm} GB, cores=${cores}, ua="${ua}…")`,
        );
    }
    const initialTier = QUALITY_TIERS[savedQuality] ?? QUALITY_TIERS.medium;
    const opts = {
        maximumScreenSpaceError: config.splat.maximumScreenSpaceError ?? initialTier.sse,
        cacheBytes: initialTier.cacheMB * 1024 * 1024,
        maximumCacheOverflowBytes: Math.floor((initialTier.cacheMB * 1024 * 1024) / 4),
    };
    void perTilesetCacheBytes;
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

    // ─── Quality picker (bottom-right) ───
    // Three tiers map to (SSE, cache) pairs tuned for distinct hardware
    // budgets. Choice persists in localStorage; saved value is read at the
    // top of loadDataset so the *initial* `opts` already match. Clicking a
    // tier here applies it live AND updates the persisted choice.
    const qualityPanel = document.createElement("div");
    Object.assign(qualityPanel.style, {
        position: "fixed",
        bottom: "12px",
        right: "12px",
        zIndex: "9998",
        padding: "8px 10px",
        background: "rgba(20,20,28,0.78)",
        color: "#fff",
        font: "12px/1.3 system-ui, sans-serif",
        border: "1px solid rgba(255,255,255,0.18)",
        borderRadius: "8px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        backdropFilter: "blur(4px)",
    } satisfies Partial<CSSStyleDeclaration>);
    const qualityLabel = document.createElement("div");
    qualityLabel.style.cssText = "opacity:0.75;font-size:11px;";
    qualityLabel.textContent = "Quality (try Low if slow)";
    qualityPanel.appendChild(qualityLabel);
    const qualityRow = document.createElement("div");
    qualityRow.style.cssText = "display:flex;gap:4px;";
    let currentQuality: keyof typeof QUALITY_TIERS = savedQuality in QUALITY_TIERS
        ? (savedQuality as keyof typeof QUALITY_TIERS)
        : "medium";
    const qualityButtons: Record<string, HTMLButtonElement> = {};
    function paintActive() {
        for (const [name, btn] of Object.entries(qualityButtons)) {
            const active = name === currentQuality;
            btn.style.background = active ? "#3a7a4a" : "#2a2a32";
            btn.style.borderColor = active ? "#6acc88" : "rgba(255,255,255,0.2)";
            btn.style.fontWeight = active ? "600" : "400";
        }
    }
    const applyTier = (name: keyof typeof QUALITY_TIERS) => {
        const tier = QUALITY_TIERS[name];
        for (const t of tilesets) {
            t.maximumScreenSpaceError = tier.sse;
            t.cacheBytes = tier.cacheMB * 1024 * 1024;
            t.maximumCacheOverflowBytes = Math.floor((tier.cacheMB * 1024 * 1024) / 4);
        }
        currentQuality = name;
        try { localStorage.setItem("__guidedQuality", name); } catch {}
        paintActive();
        console.log(`[quality] ${name} (SSE=${tier.sse}, cache=${tier.cacheMB} MB/tileset)`);
    };
    for (const name of ["low", "medium", "high"] as const) {
        const btn = document.createElement("button");
        btn.textContent = name[0].toUpperCase() + name.slice(1);
        Object.assign(btn.style, {
            flex: "1",
            padding: "4px 10px",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "12px",
            fontFamily: "system-ui, sans-serif",
        } satisfies Partial<CSSStyleDeclaration>);
        btn.onclick = () => applyTier(name);
        qualityButtons[name] = btn;
        qualityRow.appendChild(btn);
    }
    qualityPanel.appendChild(qualityRow);
    document.body.appendChild(qualityPanel);
    paintActive();

    console.log(
        `%c[dataset] ${config.displayName}\n  loaded ${tilesets.length} tileset(s): ${sourceLabel}\n  quality=${currentQuality} (SSE=${initialTier.sse}, cache=${initialTier.cacheMB} MB)\n  __setSSE(N) / __setCache(GB) for fine-tuning.`,
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
