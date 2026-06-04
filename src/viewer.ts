import * as Cesium from "cesium";

// Lightweight wrapper around Cesium.Viewer. Native 3D Gaussian Splatting
// (KHR_gaussian_splatting + SPZ-compressed GLB tiles) is consumed via
// Cesium.Cesium3DTileset and added to scene.primitives, so we no longer
// need the Three.js overlay this class used to host.

export class Viewer {
    public cesium!: Cesium.Viewer;

    constructor() {
        this.createViewer();
        this.addBaseLayer();
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
