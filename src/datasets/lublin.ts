import type { DatasetConfig } from "./types";

// Open-source Lublin City scan, 2025. PLY → 3D Tiles + SPZ-compressed GLBs
// via `3dgs-ply-3dtiles-converter` (WilliamLiu-1997). License requires
// verbatim attribution — see README "License & attribution" and the
// `prohibitedUses` array below.
export const LUBLIN: DatasetConfig = {
    id: "lublin",
    displayName: "Lublin City 2025 (Poland)",
    description:
        "Drone + ground photogrammetry capture of Lublin Old Town by Andrii Shramko / Teleportour",

    splat: {
        kind: "tileset",
        // 10 spatial cells — density-aware split where Lublin's heavily
        // SW-clustered data gets finer subdivision. Largest cell (sw_ne_se)
        // is 50.5M splats, under sub4's 65M proven-clean threshold.
        // Cesium frustum-culls cells outside the camera view, freeing memory
        // budget to refine the visible ones to deeper LODs.
        tilesetUrl: [
            "./data/lublin-cell-nw/tileset.json",
            "./data/lublin-cell-ne/tileset.json",
            "./data/lublin-cell-se/tileset.json",
            "./data/lublin-cell-sw_nw/tileset.json",
            "./data/lublin-cell-sw_sw/tileset.json",
            "./data/lublin-cell-sw_se/tileset.json",
            "./data/lublin-cell-sw_ne_nw/tileset.json",
            "./data/lublin-cell-sw_ne_ne/tileset.json",
            "./data/lublin-cell-sw_ne_sw/tileset.json",
            "./data/lublin-cell-sw_ne_se/tileset.json",
        ],
        // Cesium default is 16; we use 24 to ease refinement on the two
        // densest cells where the per-tileset splat aggregation OOM'd at 16.
        // Live override with window.__setSSE(N).
        maximumScreenSpaceError: 24,
        // sub4-noboost = 25%-subsampled (64.7M of 259M splats), converted
        // with --coverage-boost-scale 0 and --max-depth 8 to avoid the
        // Cesium 1.141 per-splat orientation bug triggered when any tile's
        // GLB node matrix has positionScale<1. Verified: 155 sampled tiles
        // across all 9 LOD levels have uniform column scale = 1.000.
        // Source PLY: sigmoid(opacity) + up-axis +z comment → z_up coord
        // auto-detected by converter, no post-load orientation fix needed.
        // Lifts the splat 75 m along local up. The previous 60 m left the
        // ground plane intersecting the WGS84 ellipsoid + OSM imagery so the
        // map textures poked through; +15 m clears that intersection. Tune
        // live with window.__nudgeHeight(N) and bake back here.
        additionalHeightM: 75,
    },

    // Stands the camera south-southwest of the dataset at 1500 m, pitched
    // -40° looking NNE so the full 1100 x 860 m footprint (overall center
    // lon=22.5696, lat=51.2492) frames inside the view. Cesium streams in
    // the matching coarse LOD as it descends.
    initialFlyTo: {
        lon: 22.56960,
        lat: 51.24300,
        height: 1500,
        heading: 0,
        pitch: -40,
        durationSec: 3,
    },

    // Demo flyover: land 200 m south of the dense core (the 4 sw_ne_* cells
    // hold ~62% of the splats around lat 51.2482) and glide 400 m north so
    // the camera ends up over the densest part. Previous heroLocation was on
    // the northern border and the 200 m north glide pushed it OUT of the
    // splat into empty terrain — visible as "missing parts" in the recording.
    heroLocation: { lon: 22.56860, lat: 51.24580 },
    heroGlideHeadingDeg: 0,
    heroGlideDistanceM: 400,

    attribution:
        "3D scanning data created and provided by Andrii Shramko, Teleportour. " +
        "https://www.linkedin.com/in/andrii-shramko/ · " +
        "https://www.linkedin.com/company/teleportour/ · teleportour.com",

    prohibitedUses: [
        "Facial recognition / biometric identification",
        "License-plate identification",
        "Re-identification of individuals or vehicles",
    ],
};
