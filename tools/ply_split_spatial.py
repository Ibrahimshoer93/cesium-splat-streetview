"""Split a 3DGS PLY into multiple sub-PLYs by spatial cells, single pass.

For Lublin the splat distribution is heavily SW-skewed (73% of splats in the
south-west quadrant). A round-robin random split doesn't help — every chunk
still covers the full footprint, so Cesium can't frustum-cull between them.
Spatial chunks each cover a small geographic region, so Cesium can ignore the
ones outside the camera's view, freeing memory budget to refine the visible
ones.

Outputs one PLY per cell, all in a single streaming pass over the source PLY.
Each output PLY also gets sigmoid(opacity) and an 'up-axis: +z' header
comment so the downstream converter auto-selects khr_native + z_up.

Usage:
    python tools/ply_split_spatial.py SOURCE.ply --cells "name1:x0,y0,z0,x1,y1,z1;name2:..." --out-dir <dir>
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

HEADER_PEEK = 64 * 1024
CHUNK_TARGET_BYTES = 64 * 1024 * 1024
DTYPE = np.dtype("<f4")


def parse_header(path: Path):
    with path.open("rb") as f:
        buf = f.read(HEADER_PEEK)
    text = buf.decode("ascii", errors="replace")
    end = text.find("end_header")
    if end < 0:
        sys.exit(f"No end_header in first {HEADER_PEEK} bytes of {path}")
    nl = text.find("\n", end)
    if nl < 0:
        sys.exit("end_header found but no newline after")
    header_bytes = nl + 1
    header_text = text[:header_bytes]

    vc = None
    props = []
    for raw in header_text.splitlines():
        line = raw.strip()
        if line.startswith("element vertex"):
            vc = int(line.split()[-1])
        elif line.startswith("property "):
            parts = line.split()
            if len(parts) >= 3 and parts[1] == "float":
                props.append((parts[1], parts[2]))
            else:
                sys.exit(f"Unsupported property line: {line!r}")
    if vc is None or not props:
        sys.exit("PLY header missing required fields")
    stride = len(props) * 4
    op_idx = next((i for i, p in enumerate(props) if p[1] == "opacity"), -1)
    if op_idx < 0:
        sys.exit("PLY has no 'opacity' property")
    return header_bytes, vc, props, stride, op_idx, header_text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="Source PLY")
    ap.add_argument("--cells", required=True,
                    help="Semicolon-separated 'name:x0,y0,z0,x1,y1,z1' specs")
    ap.add_argument("--out-dir", required=True, help="Output directory")
    ap.add_argument("--no-sigmoid", action="store_true")
    ap.add_argument("--no-up-axis", action="store_true")
    args = ap.parse_args()

    source = Path(args.source)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    header_bytes, vc, props, stride, op_idx, header_text = parse_header(source)
    num_props = len(props)

    # Parse cell specs
    cells = []
    for spec in args.cells.split(";"):
        spec = spec.strip()
        if not spec:
            continue
        name, bbox_str = spec.split(":", 1)
        bf = [float(s) for s in bbox_str.split(",")]
        if len(bf) != 6:
            sys.exit(f"cell {name}: need 6 floats, got {bf}")
        cells.append({"name": name.strip(), "bbox": bf, "count": 0, "fh": None, "path": None})
    print(f"splitting into {len(cells)} cells: {[c['name'] for c in cells]}")

    # Build the new header text (vertex count gets patched after streaming)
    new_header_text = header_text
    if not args.no_sigmoid:
        new_header_text = new_header_text.replace(
            "end_header",
            "comment opacity = sigmoid(orig_opacity) -- for khr_native\nend_header",
        )
    if not args.no_up_axis:
        new_header_text = new_header_text.replace(
            "end_header",
            "comment up-axis: +z\nend_header",
        )

    # Open output files with FIXED-WIDTH placeholder vertex counts. Using a
    # 10-digit zero-padded placeholder ('0000000000') so the patched value
    # of up to 10 digits keeps the same byte length — the binary body stays
    # at the same offset and isn't corrupted.
    PLACEHOLDER = "0000000000"  # 10 digits, fits up to 9,999,999,999 splats
    for c in cells:
        c["path"] = out_dir / f"{c['name']}.ply"
        c["fh"] = c["path"].open("wb")
        ph = new_header_text.replace(f"element vertex {vc}", f"element vertex {PLACEHOLDER}")
        c["fh"].write(ph.encode("ascii"))

    chunk_records = max(1, CHUNK_TARGET_BYTES // stride)
    chunk_bytes = chunk_records * stride
    seen = 0
    t0 = time.time()
    last_log = t0

    with source.open("rb") as fin:
        fin.seek(header_bytes)
        while True:
            buf = fin.read(chunk_bytes)
            if not buf:
                break
            usable = (len(buf) // stride) * stride
            if usable == 0:
                break
            arr = np.frombuffer(buf[:usable], dtype=DTYPE).reshape(-1, num_props).copy()
            if not args.no_sigmoid:
                arr[:, op_idx] = 1.0 / (1.0 + np.exp(-arr[:, op_idx]))
            for c in cells:
                bf = c["bbox"]
                mask = (
                    (arr[:, 0] >= bf[0]) & (arr[:, 0] < bf[3]) &
                    (arr[:, 1] >= bf[1]) & (arr[:, 1] < bf[4]) &
                    (arr[:, 2] >= bf[2]) & (arr[:, 2] < bf[5])
                )
                if mask.any():
                    sub = arr[mask]
                    c["fh"].write(sub.tobytes())
                    c["count"] += sub.shape[0]
            seen += arr.shape[0]
            now = time.time()
            if now - last_log > 2.0:
                rate_mb = (seen * stride) / (1024 * 1024) / max(0.001, now - t0)
                print(f"  {seen:>14,} / {vc:,} ({100*seen/vc:5.1f}%) @ {rate_mb:6.0f} MiB/s")
                last_log = now

    # Close and patch the FIXED-WIDTH vertex-count placeholder.
    # PLACEHOLDER is exactly 10 ASCII digits ("0000000000"); we replace it
    # with a left-padded 10-digit decimal count so the byte length is identical
    # and the binary body stays at the same offset.
    for c in cells:
        c["fh"].close()
        with c["path"].open("rb+") as f:
            peek = f.read(8192)
            idx = peek.find(b"end_header")
            if idx < 0:
                print(f"WARNING: {c['path']}: end_header not found, cannot patch count")
                continue
            nl = peek.find(b"\n", idx)
            header_bytes_out = nl + 1
            header_str = peek[:header_bytes_out].decode("ascii", errors="strict")
            count_str = f"{c['count']:010d}"  # 10-digit zero-padded
            patched = header_str.replace(
                f"element vertex {PLACEHOLDER}",
                f"element vertex {count_str}",
                1,
            )
            new_header_bytes = patched.encode("ascii")
            if len(new_header_bytes) != header_bytes_out:
                print(f"WARNING: {c['path']}: header length changed "
                      f"({header_bytes_out} -> {len(new_header_bytes)}); body corrupted")
                continue
            f.seek(0)
            f.write(new_header_bytes)

    print()
    print(f"{'cell':<10} {'splats':>14} {'pct':>6} {'file':<40}")
    total = sum(c["count"] for c in cells)
    for c in cells:
        pct = 100 * c["count"] / max(1, total)
        print(f"{c['name']:<10} {c['count']:>14,} {pct:>5.1f}% {c['path']}")
    print(f"{'total':<10} {total:>14,}    of source {vc:,}, kept {100*total/vc:.2f}%")
    print(f"\nelapsed {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
