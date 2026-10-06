#!/usr/bin/env python3
"""Remove watermarks / subtitles from a video using VSR (video-subtitle-remover).

The mask is supplied by a previous text-detection call as a flat array of
pixel-space boxes ``{left, top, right, bottom}`` (top-left origin, ``right`` /
``bottom`` inclusive, original video resolution). Only those rectangles are
inpainted; everything else is copied through untouched.

Backend: VSR ``sttn-auto`` mode (``vendored`` under ``vendor/vsr``), which takes
a static area mask directly (no OCR / subtitle detection at runtime).

This script always prints a single JSON object to stdout:
  success: {"success": true, ...}
  failure: {"success": false, "error": "..."}
and exits 0 / 1 accordingly.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import types
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
VSR_ROOT = (HERE.parent / "vendor" / "vsr").resolve()

# The real stdout is reserved for the single JSON result. VSR's internals print
# progress and warnings to stdout, so during processing we point sys.stdout at
# stderr and keep emitting our result through this handle.
_REAL_STDOUT = sys.stdout


def emit(obj, code=0):
    """Print a single JSON object to the reserved stdout and exit."""
    _REAL_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _REAL_STDOUT.flush()
    sys.exit(code)


class _Value:
    """Minimal stand-in for qfluentwidgets' config item (only ``.value`` is used)."""

    def __init__(self, value):
        self.value = value


def install_light_config(deviation, max_load_num, neighbor_stride, ref_length):
    """Register a GUI-free ``backend.config`` before importing the VSR code.

    VSR's real ``backend.config`` imports ``qfluentwidgets`` (PySide6) and its
    model paths pull in OCR dependencies. sttn-auto inference needs none of
    that, so we provide the handful of attributes the inpaint modules read.
    """
    mod = types.ModuleType("backend.config")

    class _Config:
        def __init__(self):
            self.subtitleAreaDeviationPixel = _Value(deviation)
            self.sttnNeighborStride = _Value(neighbor_stride)
            self.sttnReferenceLength = _Value(ref_length)

        def getSttnMaxLoadNum(self):
            return max(max_load_num, neighbor_stride * ref_length)

    mod.config = _Config()
    # tr['Main']['Key'].format(...) is used for a few log lines in the vendored code
    mod.tr = defaultdict(lambda: defaultdict(str))
    mod.BASE_DIR = str(VSR_ROOT / "backend")
    sys.modules["backend.config"] = mod

    if str(VSR_ROOT) not in sys.path:
        sys.path.insert(0, str(VSR_ROOT))


def find_ffmpeg():
    candidates = [
        os.environ.get("VSR_FFMPEG"),
        str(VSR_ROOT / "backend" / "ffmpeg" / "linux_x64" / "ffmpeg"),
        shutil.which("ffmpeg"),
    ]
    for cand in candidates:
        if cand and Path(cand).is_file():
            return cand
    return "ffmpeg"


def parse_args(argv):
    p = argparse.ArgumentParser(description="Remove watermarks with VSR sttn-auto.")
    p.add_argument("media", help="Path to the input video file")
    p.add_argument("--out", required=True, help="Path of the output video file")
    p.add_argument("--regions", default="",
                   help="JSON array of boxes: [{\"left\":int,\"top\":int,\"right\":int,\"bottom\":int}, ...]")
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"],
                   help="Torch device (default auto)")
    p.add_argument("--deviation", type=int, default=10,
                   help="Pixels to grow each mask box by (default 10)")
    p.add_argument("--max-load-num", type=int, default=50,
                   help="Max frames STTN processes per clip (default 50)")
    p.add_argument("--neighbor-stride", type=int, default=5,
                   help="STTN neighbor frame stride (default 5)")
    p.add_argument("--ref-length", type=int, default=10,
                   help="STTN reference frame count (default 10)")
    return p.parse_args(argv)


def normalize_regions(raw, width, height):
    """Turn detection boxes into clamped (left, top, right, bottom) tuples."""
    if isinstance(raw, dict):
        raw = raw.get("regions", [])
    if not isinstance(raw, list):
        return []

    boxes = []
    for r in raw:
        if not isinstance(r, dict):
            continue
        if r.get("detected") is False:
            continue
        vals = (r.get("left"), r.get("top"), r.get("right"), r.get("bottom"))
        if any(v is None for v in vals):
            continue
        try:
            left, top, right, bottom = (int(round(float(v))) for v in vals)
        except (TypeError, ValueError):
            continue
        left = max(0, min(left, width - 1))
        top = max(0, min(top, height - 1))
        right = max(0, min(right, width - 1))
        bottom = max(0, min(bottom, height - 1))
        if right <= left or bottom <= top:
            continue
        if (left, top, right, bottom) not in boxes:
            boxes.append((left, top, right, bottom))
    return boxes


def mux_audio(ffmpeg, silent_video, source, out_path, reencode=True):
    """Copy the source's audio track onto the processed (silent) video.

    VSR writes the video with OpenCV's ``mp4v`` codec, which browsers often
    refuse to play, so processed output is re-encoded to H.264. When there is
    nothing to inpaint the streams are copied untouched (``reencode=False``).
    """
    video_codec = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"] if reencode else ["-c:v", "copy"]
    cmd = [
        ffmpeg, "-y",
        "-i", silent_video,
        "-i", source,
        "-map", "0:v:0",
        "-map", "1:a:0?",
        *video_codec,
        "-c:a", "copy",
        "-movflags", "+faststart",
        "-loglevel", "error",
        out_path,
    ]
    proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=1800)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "ignore").strip()[-500:] or "ffmpeg failed")


def main():
    args = parse_args(sys.argv[1:])
    # From here on, VSR (and torch/tqdm) may write progress to stdout; divert it
    # to stderr so the JSON result stays the only thing on stdout.
    sys.stdout = sys.stderr

    media = Path(args.media)
    if not media.is_file():
        emit({"success": False, "error": f"Input file not found: {media}"}, 1)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    try:
        raw_regions = json.loads(args.regions) if args.regions else []
    except json.JSONDecodeError as exc:
        emit({"success": False, "error": f"Invalid --regions JSON: {exc}"}, 1)

    try:
        import cv2
    except Exception as exc:  # pragma: no cover - environment issue
        emit({"success": False, "error": f"Failed to import cv2: {exc}"}, 1)

    cap = cv2.VideoCapture(str(media))
    if not cap.isOpened():
        emit({"success": False, "error": f"Cannot open video: {media}"}, 1)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) + 0.5)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) + 0.5)
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) + 0.5)
    cap.release()
    if width <= 0 or height <= 0:
        emit({"success": False, "error": "No readable video frames"}, 1)

    boxes = normalize_regions(raw_regions, width, height)
    ffmpeg = find_ffmpeg()
    started = time.time()

    # No usable mask: nothing to inpaint, just remux the source.
    if not boxes:
        try:
            mux_audio(ffmpeg, str(media), str(media), str(out), reencode=False)
        except Exception as exc:
            emit({"success": False, "error": f"ffmpeg remux failed: {exc}"}, 1)
        emit({
            "success": True,
            "processed": False,
            "message": "No valid regions provided; the source was copied unchanged.",
            "regionsUsed": 0,
            "video": {"width": width, "height": height, "fps": round(fps, 3), "frameCount": frame_count},
            "elapsedSeconds": round(time.time() - started, 2),
        })

    install_light_config(args.deviation, args.max_load_num, args.neighbor_stride, args.ref_length)

    try:
        import torch
        from backend.inpaint.sttn_auto_inpaint import STTNAutoInpaint
        from backend.tools.inpaint_tools import create_mask
    except Exception as exc:
        emit({"success": False, "error": f"Failed to import VSR backend: {exc}"}, 1)

    model_path = VSR_ROOT / "backend" / "models" / "sttn-auto" / "infer_model.pth"
    if not model_path.is_file():
        emit({"success": False, "error": f"STTN model not found: {model_path}"}, 1)

    if args.device == "auto":
        device_name = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device_name = args.device
    if device_name == "cuda" and not torch.cuda.is_available():
        device_name = "cpu"
    device = torch.device(device_name)

    # VSR create_mask expects (xmin, xmax, ymin, ymax); main.py maps the CLI's
    # (ymin, ymax, xmin, xmax) accordingly. Compute the mask ourselves.
    coords = [(left, right, top, bottom) for (left, top, right, bottom) in boxes]
    mask = create_mask((height, width), coords)

    silent = out.with_name(f"{out.stem}.vsr_tmp.mp4")
    try:
        inpaint = STTNAutoInpaint(device, str(model_path), str(media))
        inpaint.video_out_path = str(silent)
        inpaint(input_mask=mask)
    except Exception as exc:
        emit({"success": False, "error": f"Watermark removal failed: {exc}"}, 1)

    if not silent.is_file() or silent.stat().st_size == 0:
        emit({"success": False, "error": "Watermark removal produced no output"}, 1)

    try:
        mux_audio(ffmpeg, str(silent), str(media), str(out))
    except Exception as exc:
        emit({"success": False, "error": f"Failed to add audio: {exc}"}, 1)
    finally:
        try:
            silent.unlink()
        except OSError:
            pass

    if not out.is_file() or out.stat().st_size == 0:
        emit({"success": False, "error": "Output file was not written"}, 1)

    emit({
        "success": True,
        "processed": True,
        "engine": "vsr-sttn-auto",
        "device": device_name,
        "regionsUsed": len(boxes),
        "regions": [
            {"left": l, "top": t, "right": r, "bottom": b} for (l, t, r, b) in boxes
        ],
        "video": {"width": width, "height": height, "fps": round(fps, 3), "frameCount": frame_count},
        "elapsedSeconds": round(time.time() - started, 2),
    })


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        emit({"success": False, "error": f"{type(exc).__name__}: {exc}"}, 1)
