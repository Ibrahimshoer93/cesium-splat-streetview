// Per-dataset configuration for the native 3D Tiles + KHR_gaussian_splatting
// pipeline. A new dataset is added by exporting a `DatasetConfig` from
// `src/datasets/<id>.ts` and registering it in `src/datasets/index.ts`.

export interface DatasetSplatTileset {
    kind: "tileset";
    /** URL of the 3D Tiles `tileset.json` produced by
     *  `3dgs-ply-3dtiles-converter`. Can be a single string OR an array of
     *  strings when the source PLY has been split into multiple chunks (e.g.
     *  4 round-robin subsamples that together = full density). Each URL
     *  loads as its own Cesium3DTileset primitive; they share the same
     *  geographic anchor and Cesium frustum-culls them together. */
    tilesetUrl: string | string[];
    /** Maximum screen-space-error in pixels. Lower = more refinement (more
     *  detail, more memory); higher = coarser. Cesium default is 16. */
    maximumScreenSpaceError?: number;
    /** Per-axis rotation applied to `root.transform` after load (degrees).
     *  Compensates for input-convention mismatch when the converter assumed
     *  a different intrinsic frame than the PLY actually uses.
     *  - Lublin PLY is UTM-ENU (Y=north, Z=up). Converter used graphdeco
     *    (Y=down, Z=forward). +90° around X puts Z back to up. */
    orientationFixDeg?: { x?: number; y?: number; z?: number };
    /** Shift the tileset along the local ENU up vector by this many meters.
     *  Useful when the converter's `--coordinate height` was off — bakes the
     *  correction in without re-running the (hours-long) conversion. Iterate
     *  live with `window.__nudgeHeight(deltaM)` in devtools. */
    additionalHeightM?: number;
}

export type DatasetSplat = DatasetSplatTileset;

export interface DatasetConfig {
    id: string;
    displayName: string;
    description?: string;

    splat: DatasetSplat;

    /** Camera fly-to on the "→ Fly to ..." button click. */
    initialFlyTo?: {
        lon: number;
        lat: number;
        height: number;
        heading?: number;
        pitch?: number;
        durationSec?: number;
    };

    /** Demo flow "hero" point. After the establish + fly-in, the demo flies
     *  here at flyover altitude and glides. Falls back to initialFlyTo. */
    heroLocation?: { lon: number; lat: number };
    heroGlideHeadingDeg?: number;
    heroGlideDistanceM?: number;

    /** Verbatim attribution string required by the dataset's license. */
    attribution?: string;
    /** Notes about restricted uses (license terms). */
    prohibitedUses?: string[];
}
