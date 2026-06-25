import type { DatasetConfig } from "./types";

// Kınalıada (Princes' Islands, Istanbul) — XGrids walking-level 3DGS capture.
// Street-view counterpart to Lublin's drone flyover. Source PLY (13.9M splats,
// SH=0, logit opacity, z_up) is preprocessed with sigmoid + up-axis comment,
// then converted via `3dgs-ply-3dtiles-converter` with --input-convention
// khr_native, --coverage-boost-scale 0, --max-depth 8 (same recipe that
// fixed Lublin's per-splat orientation bug in Cesium 1.141).
//
// Anchor (40.9102656°N, 29.0537504°E) is the user's Google-Maps-recorded
// start position; capture is local-meter SLAM (PLY header: epsg=0, offset=0),
// so the converter's --coordinate flag places the PLY origin at this WGS84
// point and aligns local axes to ENU. The yaw rotation between PLY-local-+X
// and ENU-east is unknown until visual alignment; tune via
// `orientationFixDeg.z` (devtool: __nudgeHeight for height).
export const KINALIADA: DatasetConfig = {
    id: "kinaliada",
    displayName: "Kınalıada (Turkey)",
    description: "XGrids walking-level photogrammetry of Kınalıada, Princes' Islands, Istanbul",

    splat: {
        kind: "tileset",
        // Built from iteration_100/point_cloud.ply (31.6M splats, L0 of the
        // XGrids 7-level pyramid). 1013 MB tileset, 1798 GLB tiles.
        //
        // For the public Pages deploy, paste the Cesium Ion asset ID here
        // after zipping `public/data/kinaliada-3dtiles/` and uploading via
        // ion.cesium.com (Asset Type: 3D Tiles, Sub-Type: 3DGS). Once it's
        // set, swap the tilesetUrl line out for ionAssetIds.
        //
        // Local dev (current default): tilesetUrl reads the on-disk tiles.
        // Production deploy: comment out tilesetUrl and uncomment ionAssetIds.
        tilesetUrl: "./data/kinaliada-3dtiles/tileset.json",
        // ionAssetIds: [/* TODO: paste asset ID after Ion upload */],
        // 8 (vs Cesium default 16) — splat looked coarse at the overview
        // altitude; halving SSE forces earlier refinement at distance.
        // Memory budget headroom is fine (~1 GB tileset on disk).
        maximumScreenSpaceError: 8,
        // +52 m along local ENU up — lifts the splat onto Cesium World
        // Terrain at Kınalıada. Tuned visually after enabling terrain;
        // earlier value of +41 m left several waypoints poking below
        // ground at the higher parts of the island.
        additionalHeightM: 52.0,
        // Aligned visually against OSM + terrain via splat-debug-controls.
        // Final --coordinate baked into the converter:
        //   lat 40.9094657, lon 29.0539287, h 0
        // (= original Google Maps anchor 40.9102656 / 29.0537504 shifted
        // N=-89 m, E=+15 m total — almost half of the visible adjustment
        // came after enabling terrain, suggesting the lat/lon ref needed
        // a small bump once the topography was correct).
        // y=+2.9° tilt was added in the last alignment pass to fix the
        // splat being "high on one end, low on the other".
        orientationFixDeg: { x: 0, y: 2.9, z: -253.8 },
    },

    // Position above the splat's geographic centre (computed from the
    // recorded waypoint bbox: lat ≈40.910, lon ≈29.053) and pitch nearly
    // straight down so the whole walked path frames within view. The
    // earlier "pitch −45° heading NNW from 800 m" placed the look target
    // ~950 m off into the sea north of the island, so the user saw water
    // on first arrival.
    initialFlyTo: {
        lon: 29.0530,
        lat: 40.9102,
        height: 600,
        heading: 0,
        pitch: -80,
        durationSec: 3,
    },

    // Walk-mode constrains R/T/D/F movement to within radiusM of the
    // nearest captured waypoint, keeping the walker on the path the XGrids
    // operator actually recorded. Mouse navigation is unconstrained (you
    // can still zoom / pan freely to inspect from outside the radius).
    walkMode: {
        waypointsUrl: "./data/kinaliada-waypoints.json",
        radiusM: 25,
        eyeHeightM: 1.6,
    },

    attribution:
        "Captured by Capoom Eng. using XGrids LCC. Site: Kınalıada, Princes' Islands, Istanbul, Türkiye.",
};
