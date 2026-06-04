"""Inspect a 3D Tiles GLB tile and extract its embedded SPZ payload.

Useful for diagnosing the SPZ-vs-render pipeline: extracts the SPZ binary
blob to a standalone .spz file (which can then be decoded to .ply via
Niantic's `spz` CLI or francescofugazzi/3dgsconverter) and dumps the GLB's
glTF JSON metadata so you can see node matrix, positionScale, accessor
schemas, and extension declarations.

Usage:
    python tools/inspect_glb.py path/to/tile.glb
    python tools/inspect_glb.py path/to/tile.glb --dump-spz out.spz
    python tools/inspect_glb.py path/to/tile.glb --dump-json out.json
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path


def read_glb(path: Path) -> tuple[dict, bytes]:
    """Return (glTF JSON object, binary chunk bytes)."""
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise SystemExit(f"{path} is not a glTF binary (missing magic).")
    version = struct.unpack("<I", data[4:8])[0]
    total = struct.unpack("<I", data[8:12])[0]
    if version != 2:
        print(f"warning: glTF version {version}, expected 2")
    json_len = struct.unpack("<I", data[12:16])[0]
    if data[16:20] != b"JSON":
        raise SystemExit("expected JSON chunk")
    json_text = data[20 : 20 + json_len].decode("utf-8").rstrip(" \x00\n")
    gltf = json.loads(json_text)
    bin_offset = 20 + json_len
    if bin_offset + 8 > total:
        raise SystemExit("glTF has no binary chunk")
    bin_len = struct.unpack("<I", data[bin_offset : bin_offset + 4])[0]
    if data[bin_offset + 4 : bin_offset + 8] != b"BIN\x00":
        raise SystemExit("expected BIN\\0 chunk")
    bin_data = data[bin_offset + 8 : bin_offset + 8 + bin_len]
    return gltf, bin_data


def get_buffer_view(gltf: dict, bin_data: bytes, idx: int) -> bytes:
    bv = gltf["bufferViews"][idx]
    off = bv.get("byteOffset", 0)
    length = bv["byteLength"]
    return bin_data[off : off + length]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="Path to a .glb tile")
    ap.add_argument("--dump-spz", help="Write the embedded SPZ payload to this file")
    ap.add_argument("--dump-json", help="Write the full glTF JSON to this file")
    args = ap.parse_args()

    path = Path(args.path)
    if not path.is_file():
        sys.exit(f"Not found: {path}")
    gltf, bin_data = read_glb(path)

    print(f"file:           {path}")
    print(f"file size:      {path.stat().st_size:,} bytes")
    print(f"json size:      {len(json.dumps(gltf)):,} bytes")
    print(f"binary chunk:   {len(bin_data):,} bytes")
    print()

    # Asset / extensions
    print(f"asset.version:  {gltf['asset'].get('version')}")
    print(f"extensionsUsed: {gltf.get('extensionsUsed')}")
    print(f"extensionsRequired: {gltf.get('extensionsRequired')}")
    print()

    # Node matrix (key for the Cesium splat-orientation bug — non-unit column
    # scale = positionScale<1 baked in = bug-triggering tile).
    node = gltf.get("nodes", [{}])[0]
    m = node.get("matrix")
    if m and len(m) == 16:
        cx = math.sqrt(m[0] ** 2 + m[1] ** 2 + m[2] ** 2)
        cy = math.sqrt(m[4] ** 2 + m[5] ** 2 + m[6] ** 2)
        cz = math.sqrt(m[8] ** 2 + m[9] ** 2 + m[10] ** 2)
        tx, ty, tz = m[12], m[13], m[14]
        print("node.matrix (column-major):")
        for i in range(4):
            row = [m[j * 4 + i] for j in range(4)]
            print(f"  [{row[0]:>12.4f} {row[1]:>12.4f} {row[2]:>12.4f} {row[3]:>14.2f}]")
        print(f"column scales:  X={cx:.5f} Y={cy:.5f} Z={cz:.5f}")
        print(f"translation:    ({tx:.2f}, {ty:.2f}, {tz:.2f}) m (tile-local)")
        if abs(cx - 1.0) > 0.001 or abs(cy - 1.0) > 0.001 or abs(cz - 1.0) > 0.001:
            print("[!] positionScale<1 baked into node matrix -- this tile triggers the Cesium splat-orientation bug")
        else:
            print("[ok] unit column scales -- this tile does NOT trigger the bug")
    print()

    # Mesh primitive + extension drill-down
    mesh = gltf.get("meshes", [{}])[0]
    prim = mesh.get("primitives", [{}])[0]
    ext = prim.get("extensions", {})
    print("primitive.extensions:")
    print(f"  keys: {list(ext.keys())}")
    gs = ext.get("KHR_gaussian_splatting")
    if gs:
        print(f"  KHR_gaussian_splatting.kernel: {gs.get('kernel')}")
        print(f"  KHR_gaussian_splatting.projection: {gs.get('projection')}")
        spz_ext = gs.get("extensions", {}).get("KHR_gaussian_splatting_compression_spz_2")
        if spz_ext:
            spz_bv = spz_ext["bufferView"]
            spz_bytes = get_buffer_view(gltf, bin_data, spz_bv)
            print(f"  SPZ bufferView index: {spz_bv}")
            print(f"  SPZ payload size:    {len(spz_bytes):,} bytes "
                  f"({len(spz_bytes)/len(bin_data)*100:.1f}% of binary chunk)")
            # First bytes are SPZ stream magic. Note: the converter wraps SPZ
            # in gzip (magic 1f 8b), so the first bytes you see are gzip's,
            # not SPZ's raw header. Decompress with `gzip -d` (or zlib in
            # Python) to get the raw SPZ packet.
            if len(spz_bytes) >= 4:
                magic = spz_bytes[:4].hex()
                print(f"  Payload first 4 bytes (hex): {magic}")
                if magic.startswith("1f8b"):
                    print(f"    -> gzip-wrapped SPZ stream. Decompress to see SPZ packet:")
                    print(f"       python -c \"import gzip,sys; sys.stdout.buffer.write(gzip.open(sys.argv[1]).read())\" <spz-file> > raw.bin")
            if args.dump_spz:
                Path(args.dump_spz).write_bytes(spz_bytes)
                print(f"\n  wrote SPZ payload to {args.dump_spz}")
                print(f"  decompress: python -c \"import gzip; open('raw.spz','wb').write(gzip.open('{args.dump_spz}').read())\"")
                print(f"  decode with: niantic spz CLI, or load via @loaders.gl/gltf in Node")

    # Accessors
    print()
    print(f"accessors:      {len(gltf.get('accessors', []))} total")
    for i, a in enumerate(gltf.get("accessors", [])[:8]):
        bv = a.get("bufferView", "<no bufferView (placeholder)>")
        print(f"  [{i}] type={a.get('type'):<6} count={a.get('count'):>10}  bufferView={bv}")
    if len(gltf.get("accessors", [])) > 8:
        print(f"  ... ({len(gltf['accessors']) - 8} more)")

    if args.dump_json:
        Path(args.dump_json).write_text(json.dumps(gltf, indent=2))
        print(f"\nwrote full glTF JSON → {args.dump_json}")


if __name__ == "__main__":
    main()
