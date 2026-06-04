# Bug: CesiumJS 1.141 ignores GLB node matrix rotation for KHR_gaussian_splatting per-splat orientation

**Affects:** CesiumJS 1.141.0 (latest as of 2026-06-02)

**Severity:** Visible rendering artifact; effectively breaks any tileset whose leaves have a non-trivial `nodes[0].matrix` rotation.

## Symptom

When a 3D Tiles 1.1 tileset uses the `KHR_gaussian_splatting` extension and per-tile GLBs carry a `nodes[0].matrix` whose **3×3 upper-left block is not the identity** (i.e., the matrix includes a rotation in addition to translation/uniform scale), Cesium renders some splats with the wrong anisotropic orientation. Visually: a "blob with rays" — many splats clustered with spikes radiating outward instead of forming a coherent surface.

In our specific case (Lublin Old Town, 259M splats, single tileset):

- The converter's `make3DTilesGltfRootMatrix` (see [reproduction § Converter logic](#converter-logic)) emits matrices of the form `R · (1/positionScale) · I + translation` where `R` is the source-coordinate-system → glTF-Y-up rotation and `positionScale ≤ 1.0` is a per-tile scale applied to compress positions into SPZ's `[-1, 1]` quantized range.
- Cesium applies the matrix correctly to per-splat **positions** (city geometry appears in the right geographic location and rotational footprint is correct at low altitude).
- But per-splat **covariance** (scale × rotation, i.e. the anisotropic ellipsoid orientation) appears unaffected by the node matrix's rotation portion. Anisotropic splats face the directions encoded in their `KHR_gaussian_splatting:ROTATION` accessor as if no node matrix were applied → many face an incorrect axis given that all positions were rotated.

This matches the description in the now-closed [PR #13245 — Fix Gaussian splat orientation and modelMatrix](https://github.com/CesiumGS/cesium/pull/13245).

## Reproduction

### Source data

- 3DGS PLY: ~259 M splats, SH degree 0, intrinsic frame is UTM-ENU (X=East, Y=North, Z=Up). PLY origin offset baked into header `Offset:` comment: `609424.343115 5678598.157849 264.020042` (UTM-34N).
- The PLY has no `up-axis` / `z-up` / `y-up` / `colmap` / `y-down` keywords in its header comments, so the converter falls through to its `camera_y_down_z_forward` default source-coordinate-system.

### Conversion command

```bash
# 1. Pre-process opacity from logit to sigmoid so --input-convention khr_native
#    doesn't drop ~78% of splats as "zero opacity":
python tools/ply_preprocess.py source.ply source-khrnative.ply

# 2. Convert with khr_native (which correctly interprets per-splat quaternions):
3dgs-ply-3dtiles-converter source-khrnative.ply public/data/lublin-3dtiles \
  --coordinate "[51.248238, 22.567850, -20.26]" \
  --input-convention khr_native \
  --memory-budget 16 --no-open-inspector --clean
```

Resulting tileset: 31,195 GLB tiles, 12 LOD levels, 4.3 GB on disk, `KHR_gaussian_splatting` + `KHR_gaussian_splatting_compression_spz_2`, all 258,951,032 splats preserved (`removed_invalid_splats: 0`).

### Cesium load

```js
const tileset = await Cesium.Cesium3DTileset.fromUrl("./data/lublin-3dtiles/tileset.json", {
  maximumScreenSpaceError: 16,
});
viewer.scene.primitives.add(tileset);

// (apply a 90° X rotation to align the source frame with Cesium's local ENU)
tileset.root.transform = Cesium.Matrix4.multiply(
  tileset.root.transform,
  Cesium.Matrix4.fromRotationTranslation(
    Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(90)),
    Cesium.Cartesian3.ZERO,
  ),
  new Cesium.Matrix4(),
);
```

Fly the camera to Lublin Old Town (~51.249°N, 22.567°E, ~150 m altitude, pitch −45°). Observe: roughly half of the visible city is correctly resolved (rooftops, streets, vehicles visible), and the other half collapses into a yellow/orange ellipsoid blob with radial spikes / rays — the failing tiles.

### Diagnostic confirming the same recipe at lower density renders cleanly

Running an identical pipeline on a 5%-subsampled copy of the PLY (every 20th vertex, ~13M splats, 8 LOD levels) produces a clean tileset with no blob — because at that density the tree never produces tiles whose spatial extent exceeds SPZ's `[-1, 1]` range, so `positionScale = 1.0` everywhere and the GLB node matrices reduce to identity-rotation + translation.

```bash
python tools/ply_preprocess.py source.ply source-sub20-khrnative.ply --subsample 20
3dgs-ply-3dtiles-converter source-sub20-khrnative.ply public/data/lublin-3dtiles-khrtest \
  --coordinate "[51.248238, 22.567850, -20.26]" \
  --input-convention khr_native \
  --memory-budget 8 --no-open-inspector --clean
```

Loaded in identical Cesium build with identical post-load rotation: **renders cleanly**.

This is the single-variable control that points the bug squarely at the **per-tile non-identity-rotation node matrix** and Cesium's handling of it.

### LOD selection ruled out

Forcing the deepest possible LOD (`__tileset.maximumScreenSpaceError = 0.5; __tileset.cacheBytes = 4_000_000_000`) does not change the artifact — the same tiles that show the blob at coarse LOD also show it at the deepest leaves they're rendered through. So the bug is not "wrong parent LOD picked"; it's wrong per-splat orientation across all LOD levels where the converter set `positionScale < 1.0`.

### `--input-convention` ruled out

The earlier (non-preprocessed) graphdeco conversion also shows the blob. Both conventions exhibit the same artifact when the full PLY is used. The convention only affects opacity decode and per-splat-quaternion interpretation; it doesn't change `make3DTilesGltfRootMatrix`'s behavior.

### Cesium upgrade not available

CesiumJS 1.141 is the latest published. 1.142 was tagged in the repo on 2026-06-01 but not yet published; its CHANGES.md shows no Gaussian-splat fixes. PR #13245 which appears to address this exact class of bug was closed unmerged on 2026-03-13.

## Converter logic

`3dgs-ply-3dtiles-converter@0.5.4` (npm), file `src/formats/gltf.js` line 54:

```js
function make3DTilesGltfRootMatrix(translation, sourceCoordinateSystem, positionScale) {
  const inversePositionScale = 1.0 / positionScale;
  const sourceInfo = sourceCoordinateSystemInfo(sourceCoordinateSystem);
  const sourceToGltfYUp = sourceInfo.sourceToGltfYUp;     // 3×3 axis-permutation
  const r = [...sourceToGltfYUp[0], ...sourceToGltfYUp[1], ...sourceToGltfYUp[2]];
  const t = [
    r[0] * t0 + r[1] * t1 + r[2] * t2,  // translation rotated into glTF Y-up
    r[3] * t0 + r[4] * t1 + r[5] * t2,
    r[6] * t0 + r[7] * t1 + r[8] * t2,
  ];
  const m = [
    r[0] * inversePositionScale, r[1] * inversePositionScale, r[2] * inversePositionScale, t[0],
    r[3] * inversePositionScale, r[4] * inversePositionScale, r[5] * inversePositionScale, t[1],
    r[6] * inversePositionScale, r[7] * inversePositionScale, r[8] * inversePositionScale, t[2],
    0, 0, 0, 1,
  ];
  return mat4ToGltfColumnMajorList(m);
}
```

For the `camera_y_down_z_forward` default source coord system, `sourceToGltfYUp = [[1,0,0],[0,-1,0],[0,0,-1]]` — that's a non-identity rotation always present in every tile's node matrix, regardless of `positionScale`. So strictly speaking the rotation portion of the matrix is non-identity in *every* tile of every conversion with the default source coord. The blob would render in all tiles, not just `positionScale<1` ones — *unless* Cesium's bug specifically only manifests when the matrix has an inverse-scale alongside the rotation. To test that hypothesis, set the source coord to `gltf_y_up` and re-run.

## Expected behavior

Cesium 1.141's `KHR_gaussian_splatting` rendering should compose the GLB `nodes[0].matrix` into the per-splat covariance computation. Specifically, for a splat with covariance `C = R · diag(σ) · diag(σ) · Rᵀ` (where `R` is the per-splat rotation and `σ` is the per-splat scale), under a node-matrix transform `M` with rotation portion `R_node`, the rendered covariance should be `R_node · C · R_nodeᵀ`. Equivalently, each splat's effective rotation should be `R_node · R` (and scale rescaled by the matrix's scale factor) before projection.

## Workaround ideas

1. **Re-encode the source PLY with explicit `up-axis: +z` header comment** so the converter selects `z_up` instead of the default, producing a different (potentially identity-rotation) node matrix. — Untested.
2. **Force the converter to keep `positionScale = 1.0`** by limiting leaf size aggressively (`--max-leaf-limit 5000` or smaller). Reduces the per-tile spatial range so positions fit SPZ without scaling. Output may be larger / more tiles.
3. **Ship the demo with the subsampled tileset** at the cost of density.
4. **Wait for Cesium-side fix.** PR #13245 closed unmerged but the issue is real; a future release will need to land it.

---

Reproduction repository: <local copy at C:\Users\capoom\cesium-gaussian-splatting>
