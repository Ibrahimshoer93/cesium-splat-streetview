"""Pre-process a 3DGS PLY for the WilliamLiu converter's khr_native convention.

The Lublin PLY (and other Inria-trained 3DGS PLYs) stores `opacity` as a logit
(real-valued, range typically -10..+10). The converter's `--input-convention
graphdeco` applies sigmoid during decode; `--input-convention khr_native` does
not, so any vertex with opacity ≤ 0 is dropped as "zero opacity" — 78% of the
Lublin file. This tool applies sigmoid up-front so the resulting PLY is
khr-native-compatible without losing data.

Optional subsampling lets us prepare a fast diagnostic PLY for testing whether
khr_native actually fixes the rendering artifact before committing 9 h to a
full re-conversion.

Usage:
    python tools/ply_preprocess.py input.ply output.ply [--subsample N] [--no-sigmoid]
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
        sys.exit("end_header found but no following newline")
    header_bytes = nl + 1
    header_text = text[:header_bytes]

    vertex_count = None
    props: list[tuple[str, str]] = []
    for raw in header_text.splitlines():
        line = raw.strip()
        if line.startswith("element vertex"):
            vertex_count = int(line.split()[-1])
        elif line.startswith("property "):
            parts = line.split()
            if len(parts) >= 3 and parts[1] == "float":
                props.append((parts[1], parts[2]))
            else:
                sys.exit(f"Unsupported property line: {line!r}")

    if vertex_count is None:
        sys.exit("No element vertex N")
    stride = len(props) * 4
    op_idx = next((i for i, p in enumerate(props) if p[1] == "opacity"), -1)
    if op_idx < 0:
        sys.exit("PLY has no 'opacity' property")
    return header_bytes, vertex_count, props, stride, op_idx, header_text


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--subsample", type=int, default=1,
                    help="Keep every Nth vertex (default 1 = all)")
    ap.add_argument("--subsample-offset", type=int, default=0,
                    help="Offset within the subsample stride. For 4-way round-robin "
                         "partition use --subsample 4 with --subsample-offset 0/1/2/3.")
    ap.add_argument("--no-sigmoid", action="store_true",
                    help="Skip the opacity sigmoid (just copy the PLY)")
    ap.add_argument("--no-up-axis", action="store_true",
                    help="Don't add the 'up-axis: +z' header comment "
                         "(default: add, so 3dgs-ply-3dtiles-converter auto-selects z_up coord system)")
    ap.add_argument("--shift-positions", action="store_true",
                    help="Subtract bbox-min from each x/y/z so all positions are >=0. "
                         "Useful for testing SPZ sign-handling bugs. Requires a first pass "
                         "to compute bbox; prints the shift amounts so you can adjust --coordinate.")
    ap.add_argument("--bbox-filter",
                    help="Keep only splats with positions inside this XYZ bbox in source PLY "
                         "coordinates. Format: 'x_min,y_min,z_min,x_max,y_max,z_max'. "
                         "Used to split a large PLY into spatial sub-PLYs (quadrants, etc.) "
                         "so each sub-tileset's tiles stay inside SPZ's representable range.")
    args = ap.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    if not input_path.is_file():
        sys.exit(f"Not found: {input_path}")

    header_bytes, vc, props, stride, op_idx, header_text = parse_header(input_path)
    num_props = len(props)
    out_vc = vc // args.subsample if args.subsample > 1 else vc
    print(f"input:  {input_path}")
    print(f"  vertices: {vc:,}  stride: {stride} B  opacity column: {op_idx}")
    print(f"output: {output_path}")
    print(f"  vertices: {out_vc:,}  (subsample 1:{args.subsample})  sigmoid={'no' if args.no_sigmoid else 'yes'}")

    # Rewrite header with the new vertex count.
    new_header_text = header_text.replace(
        f"element vertex {vc}",
        f"element vertex {out_vc}",
    )
    if not args.no_sigmoid:
        new_header_text = new_header_text.replace(
            "end_header",
            "comment opacity = sigmoid(orig_opacity) -- converted for khr_native\nend_header",
        )
    if not args.no_up_axis:
        # Match 3dgs-ply-3dtiles-converter's regex for explicit z-up detection
        # (see src/formats/coordinates.js::hasExplicitZUpComment). Picking
        # the most unambiguous phrasing.
        new_header_text = new_header_text.replace(
            "end_header",
            "comment up-axis: +z\nend_header",
        )

    chunk_records = max(1, CHUNK_TARGET_BYTES // stride)
    chunk_bytes = chunk_records * stride

    # Optional pre-pass: compute bbox min so we can subtract it for --shift-positions.
    shift = np.zeros(3, dtype=np.float64)
    if args.shift_positions:
        print("first pass: scanning bbox for shift...")
        xyz_min = np.full(3, np.inf)
        t_pre = time.time()
        with input_path.open("rb") as fin:
            fin.seek(header_bytes)
            chunk_idx = 0
            while True:
                buf = fin.read(chunk_bytes)
                if not buf:
                    break
                usable = (len(buf) // stride) * stride
                if usable == 0:
                    break
                arr = np.frombuffer(buf[:usable], dtype=DTYPE).reshape(-1, num_props)
                xyz_min = np.minimum(xyz_min, arr[:, :3].min(axis=0))
                chunk_idx += 1
        shift = -xyz_min.astype(np.float64)
        print(f"  bbox min: ({xyz_min[0]:.3f}, {xyz_min[1]:.3f}, {xyz_min[2]:.3f})")
        print(f"  applying shift +({shift[0]:.3f}, {shift[1]:.3f}, {shift[2]:.3f}) so all coords >= 0")
        print(f"  remember to adjust --coordinate: PLY origin (0,0,0) is now at OLD origin + ({-shift[0]:.3f}, {-shift[1]:.3f}, {-shift[2]:.3f})  scan {time.time()-t_pre:.1f}s")

    written = 0
    seen = 0
    t0 = time.time()
    last_log = t0

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with input_path.open("rb") as fin, output_path.open("wb") as fout:
        fin.seek(header_bytes)
        fout.write(new_header_text.encode("ascii"))
        chunk_idx = 0
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
            if args.shift_positions:
                arr[:, 0] += np.float32(shift[0])
                arr[:, 1] += np.float32(shift[1])
                arr[:, 2] += np.float32(shift[2])
            if args.bbox_filter:
                # Apply filter BEFORE subsample so subsample percentages remain
                # consistent across the kept-splats subset.
                bf = [float(s) for s in args.bbox_filter.split(",")]
                if len(bf) != 6:
                    sys.exit("--bbox-filter needs 6 comma-separated floats: x_min,y_min,z_min,x_max,y_max,z_max")
                mask = (
                    (arr[:, 0] >= bf[0]) & (arr[:, 0] < bf[3]) &
                    (arr[:, 1] >= bf[1]) & (arr[:, 1] < bf[4]) &
                    (arr[:, 2] >= bf[2]) & (arr[:, 2] < bf[5])
                )
                arr = arr[mask]
            seen += arr.shape[0]
            if args.subsample > 1:
                # Keep vertices where abs_index % subsample == subsample_offset.
                # For offset=0: keep 0,K,2K,... (original behavior).
                # For 4-way round-robin partition: run 4× with offsets 0/1/2/3.
                start_abs = seen - arr.shape[0]
                first_keep_offset = (args.subsample_offset - start_abs) % args.subsample
                arr = arr[first_keep_offset :: args.subsample]
            fout.write(arr.tobytes())
            written += arr.shape[0]
            chunk_idx += 1
            now = time.time()
            if now - last_log > 2.0:
                pct = 100 * seen / vc
                rate_mb = (seen * stride) / (1024 * 1024) / max(0.001, now - t0)
                print(f"  {seen:>14,} / {vc:,}  ({pct:5.1f}%)  written {written:>11,}  {rate_mb:6.0f} MiB/s")
                last_log = now

    # Patch header vertex count if subsample left us short of out_vc.
    if written != out_vc:
        print(f"NOTE: wrote {written:,} vertices but header declared {out_vc:,}. Rewriting header.")
        new_header_text = new_header_text.replace(
            f"element vertex {out_vc}",
            f"element vertex {written}",
        )
        with output_path.open("rb+") as f:
            f.seek(0)
            f.write(new_header_text.encode("ascii"))

    elapsed = time.time() - t0
    print(f"\ndone in {elapsed:.1f}s. wrote {written:,} vertices ({output_path.stat().st_size/1e6:.1f} MB).")


if __name__ == "__main__":
    main()
