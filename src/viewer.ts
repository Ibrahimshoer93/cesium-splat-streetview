import * as Cesium from "cesium";

// Lightweight wrapper around Cesium.Viewer. Native 3D Gaussian Splatting
// (KHR_gaussian_splatting + SPZ-compressed GLB tiles) is consumed via
// Cesium.Cesium3DTileset and added to scene.primitives, so we no longer
// need the Three.js overlay this class used to host.

export class Viewer {
    public cesium!: Cesium.Viewer;
    /** Resolves once Cesium World Terrain has finished loading and is installed
     *  on the viewer. Code that needs the terrain provider's tile availability
     *  (e.g. sampleTerrainMostDetailed) must await this — without it, the
     *  default Ellipsoid provider is still in place and the call throws. */
    public terrainReady: Promise<void>;

    constructor() {
        this.createViewer();
        this.addBaseLayer();
        this.terrainReady = this.addWorldTerrain();
    }

    private createViewer() {
        this.cesium = new Cesium.Viewer("cesium", {
            skyBox: false,
            baseLayerPicker: false,
            geocoder: false,
            homeButton: false,
            sceneModePicker: false,
            animation: false,
            timeline: false,
            navigationHelpButton: false,
            infoBox: false,
            // SelectionIndicator + InfoBox track Cesium's "currently selected
            // entity" — but guided-mode hides ball entities when entering a
            // waypoint, which invalidates the selected entity's world position
            // and triggers "normalized result is not a number" inside Cesium's
            // selection rendering. We have our own hover/selected colors;
            // disable Cesium's built-ins so they can't latch onto an entity.
            selectionIndicator: false,
            // Cesium 1.141 expects baseLayer (not imageryProvider). Pass false
            // to suppress the default and add our OSM provider in addBaseLayer.
            baseLayer: false as unknown as Cesium.ImageryLayer,
        });
        this.cesium.scene.debugShowFramesPerSecond = true;
    }

    private addBaseLayer(): void {
        // OSM caps tiles at zoom 19; setting maximumLevel avoids 404+CORS spam
        // when the camera gets close.
        const osm = new Cesium.OpenStreetMapImageryProvider({
            url: "https://tile.openstreetmap.org/",
            maximumLevel: 19,
            credit: "© OpenStreetMap contributors",
        });
        this.cesium.imageryLayers.addImageryProvider(osm);
    }

    /** Swap the default flat-ellipsoid terrain for Cesium World Terrain
     *  (Ion-hosted global DEM, ~10 m resolution, sub-meter in covered cities).
     *  The OSM imagery drapes onto the heightmap so the globe gets real
     *  topography. Requires Cesium.Ion.defaultAccessToken to be set (handled
     *  by main.ts from VITE_CESIUM_ION_TOKEN). Failures fall back silently
     *  to the flat ellipsoid so the viewer keeps working without a token. */
    private async addWorldTerrain(): Promise<void> {
        try {
            const terrain = await Cesium.createWorldTerrainAsync({
                // Skip lighting/normals on the terrain — keeps the OSM
                // imagery looking like a clean map, not a shaded relief.
                requestVertexNormals: false,
                requestWaterMask: false,
            });
            this.cesium.terrainProvider = terrain;
            console.log("[viewer] Cesium World Terrain enabled.");
        } catch (e) {
            console.warn("[viewer] could not enable Cesium World Terrain; staying on flat ellipsoid:", e);
        }
    }

    public flyTo(
        x: number,
        y: number,
        z: number,
        heading: number,
        pitch: number,
        duration: number,
    ): void {
        this.cesium.camera?.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(x, y, z),
            orientation: {
                heading: Cesium.Math.toRadians(heading),
                pitch: Cesium.Math.toRadians(pitch),
                roll: 0.0,
            },
            duration: duration,
        });
    }
}
