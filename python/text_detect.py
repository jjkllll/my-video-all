#!/usr/bin/env python3
"""Detect burned-in subtitles / watermarks with a *learned* text detector.

Unlike ``detect_subtitles.py`` (which relies on a white-glyph / dark-outline
heuristic), this script runs a PP-OCR DBNet text-detection ONNX model over each
declared region and uses its per-pixel text probability map to decide presence.
That makes it robust to low-contrast, coloured, semi-transparent or vertical
text where the heuristic struggles.

Pipeline per sampled frame and per region:

    crop -> (optional 90° rotation for vertical text) -> DBNet -> prob map
         -> binarise at --det-thresh -> text mask

A sample counts as "has text" when the text pixels cover at least
``--min-text-ratio`` of the region. Each region is analysed independently and
reported in ``regions`` as a plain array in request order (regions[0],
regions[1], ...), without distinguishing subtitles from watermarks: every entry
carries ``detected`` and, when text was found, the flat text box in absolute
pixel coordinates plus ``confidence``. A top-level ``segments`` array tiles the
whole video timeline into contiguous ``{start, end, hasText}`` ranges (the union
of all regions over the sampled frames decides each sample's state), so callers
get every part of the video, with or without text, and can test ``hasText``
explicitly.

Inference runs on GPU (onnxruntime ``CUDAExecutionProvider``) when available and
falls back to CPU otherwise; choose explicitly with ``--provider``.

Contract: prints a single JSON object to stdout, exit code 0 (success) / 1 (error).
"""

import argparse
import json
import sys
import traceback
from pathlib import Path

try:
    import cv2
    import numpy as np
except Exception as _exc:  # pragma: no cover - reported from main()
    cv2 = None
    np = None
    _IMPORT_ERROR = _exc
else:
    _IMPORT_ERROR = None

sys.path.insert(0, str(Path(__file__).resolve().parent))
from detect_subtitles import (  # noqa: E402
    emit,
    build_regions,
    build_segments,
)

DEFAULT_MODEL = Path(__file__).resolve().parent.parent / "models" / "ch_PP-OCRv4_det_mobile.onnx"

# PP-OCR detection normalisation (ImageNet statistics, RGB, 0..1 scale).
_DET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32) if np is not None else None
_DET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32) if np is not None else None


def parse_args(argv):
    p = argparse.ArgumentParser(description="Detect subtitles / watermarks with a learned text detector.")
    p.add_argument("media", help="Path to the input video file")
    p.add_argument("--sample-fps", type=float, default=1.0,
                   help="How many frames per second to sample (default: 1.0)")
    p.add_argument("--max-samples", type=int, default=600,
                   help="Maximum number of sampled frames (default: 600)")
    p.add_argument("--region-ratio", type=float, default=0.35,
                   help="Bottom fraction of the frame to inspect when no --regions is given (default: 0.35)")
    p.add_argument("--regions", default="",
                   help="JSON array of regions to scan independently. Each item: "
                        '{"name":str, "left":0..1, "top":0..1, "right":0..1, "bottom":0..1, '
                        '"orientation":"horizontal"|"vertical", "anchor":"..."} (ratios of frame size).')
    p.add_argument("--model", default=str(DEFAULT_MODEL),
                   help=f"Path to the DBNet ONNX detection model (default: {DEFAULT_MODEL})")
    p.add_argument("--provider", choices=["auto", "cpu", "cuda"], default="auto",
                   help="ONNX Runtime provider: auto (use CUDA if present), cpu, or cuda (default: auto)")
    p.add_argument("--device-id", type=int, default=0,
                   help="CUDA device index when --provider=cuda/auto (default: 0)")
    p.add_argument("--det-thresh", type=float, default=0.3,
                   help="Probability threshold to binarise the text map (default: 0.3)")
    p.add_argument("--min-text-ratio", type=float, default=0.002,
                   help="Min text-pixel fraction of a region to count the frame as having text (default: 0.002)")
    p.add_argument("--min-box-area", type=int, default=20,
                   help="Min connected-component area (px) to count as one text line (default: 20)")
    p.add_argument("--det-limit", type=int, default=960,
                   help="Longest side (px) the detector input is resized down to (default: 960)")
    p.add_argument("--min-det-size", type=int, default=320,
                   help="Upscale the crop so its longest side reaches at least this many pixels before "
                        "detection; small regions (e.g. thin vertical watermarks) are otherwise missed "
                        "(default: 320, 0 = never upscale)")
    p.add_argument("--gap-bridge", type=int, default=1,
                   help="Bridge up to this many consecutive missing samples when merging segments (default: 1)")
    p.add_argument("--upscale", type=float, default=0.0,
                   help="Extend each subtitle segment by this many seconds on both sides "
                        "(min 0.01 when > 0; default 0 = no change)")
    p.add_argument("--auto-freq-threshold", type=float, default=0.02,
                   help="Auto mode: a pixel must be text in at least this fraction of sampled frames "
                        "to survive as a stable text region (default: 0.02)")
    p.add_argument("--auto-min-area-ratio", type=float, default=0.0004,
                   help="Auto mode: min stable text area as a fraction of the frame to report a region "
                        "(default: 0.0004)")
    return p.parse_args(argv)


def _collect_lib_dirs():
    """Map nvidia-*-cu12 package name -> list of lib dirs (venv wheels or MYVIDEO_CUDA_LIBS)."""
    import glob
    import os
    import sysconfig

    roots = [x for x in os.environ.get("MYVIDEO_CUDA_LIBS", "").split(os.pathsep) if x]
    for key in ("purelib", "platlib"):
        base = sysconfig.get_paths().get(key)
        if base:
            roots.append(os.path.join(base, "nvidia"))

    lib_dirs = {}
    for root in roots:
        if not os.path.isdir(root):
            continue
        cands = glob.glob(os.path.join(root, "*", "lib"))  # nvidia/<pkg>/lib
        if glob.glob(os.path.join(root, "*.so*")):
            cands.append(root)  # the dir itself holds the libs
        for d in cands:
            lib_dirs.setdefault(os.path.basename(os.path.dirname(d)), []).append(d)
    return lib_dirs


def _preload_cuda_libs():
    """Preload CUDA/cuDNN shared libs (RTLD_GLOBAL) so the ORT CUDA provider can be
    dlopen-ed without relying on LD_LIBRARY_PATH. Mirrors the pip nvidia-* wheels."""
    import ctypes
    import glob
    import os

    order = ["nvjitlink", "cuda_runtime", "cuda_nvrtc", "cublas", "cudnn",
             "cufft", "curand", "cusolver", "cusparse", "nccl"]
    lib_dirs = _collect_lib_dirs()
    loaded = []
    for pkg in order:
        for d in lib_dirs.get(pkg, []):
            for so in sorted(glob.glob(os.path.join(d, "*.so*"))):
                try:
                    ctypes.CDLL(so, mode=ctypes.RTLD_GLOBAL)
                    loaded.append(so)
                except OSError:
                    pass
    return loaded


def build_session(model_path, provider, device_id):
    """Create an ONNX Runtime session, preferring CUDA when asked/available."""
    if provider in ("auto", "cuda"):
        _preload_cuda_libs()
    try:
        import onnxruntime as ort
    except Exception as exc:
        emit({"success": False, "error": f"onnxruntime is not available: {exc}"}, 1)
    if not Path(model_path).is_file():
        emit({"success": False, "error": f"Detection model not found: {model_path}"}, 1)

    available = ort.get_available_providers()
    want_cuda = provider in ("auto", "cuda") and "CUDAExecutionProvider" in available
    if provider == "cuda" and "CUDAExecutionProvider" not in available:
        emit({"success": False,
              "error": "CUDAExecutionProvider is not available in this onnxruntime build; "
                       "install onnxruntime-gpu or use --provider cpu",
              "availableProviders": available}, 1)

    providers = [("CUDAExecutionProvider", {"device_id": int(device_id)}), "CPUExecutionProvider"] \
        if want_cuda else ["CPUExecutionProvider"]

    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    try:
        sess = ort.InferenceSession(str(model_path), sess_options=opts, providers=providers)
    except Exception as exc:
        emit({"success": False, "error": f"Failed to create ONNX session: {exc}"}, 1)
    return sess, sess.get_providers(), available


def det_prob(sess, bgr, limit, min_size=0):
    """Run DBNet on a BGR crop and return a probability map with the crop's size.

    ``min_size`` upscales small crops so the detector can resolve fine glyphs
    (thin watermarks); ``limit`` caps very large crops to keep inference cheap.
    """
    h0, w0 = bgr.shape[:2]
    longest = max(h0, w0)
    scale = 1.0
    if min_size and longest < min_size:
        scale = min_size / float(longest)
    elif limit > 0 and longest > limit:
        scale = limit / float(longest)
    nh = max(32, int(round(h0 * scale / 32.0)) * 32)
    nw = max(32, int(round(w0 * scale / 32.0)) * 32)
    if nh != h0 or nw != w0:
        img = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
    else:
        img = bgr
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    rgb = (rgb - _DET_MEAN) / _DET_STD
    blob = rgb.transpose(2, 0, 1)[None].astype(np.float32)
    inp = sess.get_inputs()[0].name
    out = sess.run(None, {inp: blob})[0]
    prob = out[0, 0] if out.ndim == 4 else out[0]
    prob = np.asarray(prob, dtype=np.float32)
    if prob.shape != (h0, w0):
        prob = cv2.resize(prob, (w0, h0), interpolation=cv2.INTER_LINEAR)
    return prob


def analyze_region(sess, reg, args):
    """Analyse one region.

    Returns ``(box, presence)``: ``box`` is a flat text box in absolute pixels or
    ``None`` when no text is found; ``presence`` is a per-sample bool list saying
    whether this region showed text in each sampled frame.
    """
    rotate = reg["orientation"] == "vertical"
    x0, y0, x1, y1 = reg["left"], reg["top"], reg["right"], reg["bottom"]
    area = float((x1 - x0) * (y1 - y0))
    min_pixels = max(1.0, area * args.min_text_ratio)

    conf_sum = 0.0
    conf_cnt = 0
    gx0 = gy0 = None
    gx1 = gy1 = None
    presence = []

    for frame in reg["_frames"]:
        crop = frame[y0:y1, x0:x1]
        if crop.size == 0:
            presence.append(False)
            continue
        work = cv2.rotate(crop, cv2.ROTATE_90_CLOCKWISE) if rotate else crop
        prob = det_prob(sess, work, args.det_limit, args.min_det_size)
        if rotate:
            prob = cv2.rotate(prob, cv2.ROTATE_90_COUNTERCLOCKWISE)
        mask = prob >= args.det_thresh
        pix = int(mask.sum())
        if pix >= min_pixels:
            presence.append(True)
            conf_sum += float(prob[mask].mean())
            conf_cnt += 1
            ys, xs = np.where(mask)
            if ys.size:
                lo_x, hi_x = int(xs.min()), int(xs.max())
                lo_y, hi_y = int(ys.min()), int(ys.max())
                gx0 = lo_x if gx0 is None else min(gx0, lo_x)
                gy0 = lo_y if gy0 is None else min(gy0, lo_y)
                gx1 = hi_x if gx1 is None else max(gx1, hi_x)
                gy1 = hi_y if gy1 is None else max(gy1, hi_y)
        else:
            presence.append(False)

    if conf_cnt == 0 or gx0 is None:
        return None, presence

    left = x0 + gx0
    top = y0 + gy0
    right = x0 + gx1
    bottom = y0 + gy1
    return {
        "left": left,
        "top": top,
        "right": right,
        "bottom": bottom,
        "width": right - left + 1,
        "height": bottom - top + 1,
        "confidence": round(conf_sum / conf_cnt, 4),
    }, presence


def analyze_auto(sess, frames, args, width, height):
    """Whole-frame text-region detection (no ``--regions`` given).

    Runs DBNet on every sampled frame, accumulates where text recurs, then
    groups the stable text pixels into connected regions. Each region is a
    subtitle band / watermark with its absolute-pixel box, so callers get the
    regions that actually contain text without declaring any region themselves.

    Returns ``(region_reports, presence)`` where ``presence`` is the per-sample
    bool list used to build ``segments``.
    """
    n = len(frames)
    hits = np.zeros((height, width), dtype=np.uint16)
    conf_sum = np.zeros((height, width), dtype=np.float32)
    packed = []  # per-frame packed text mask (1 bit/px, far cheaper than the frames)

    for frame in frames:
        prob = det_prob(sess, frame, args.det_limit, 0)
        mask = prob >= args.det_thresh
        packed.append(np.packbits(mask, axis=1))
        hits += mask.astype(np.uint16)
        conf_sum += np.where(mask, prob, 0.0).astype(np.float32)

    # Keep only pixels that recur across frames so one-off detector noise drops out.
    freq_threshold = min(max(args.auto_freq_threshold, 0.0), 1.0)
    stable = hits >= max(1, int(np.ceil(freq_threshold * n)))
    if not stable.any():
        return [], [False] * n

    # Bridge sub-glyph gaps so a text line / stacked watermark becomes one region.
    k = max(5, int(round(min(width, height) * 0.03)) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    dil = cv2.dilate(stable.astype(np.uint8), kernel, iterations=1)
    num, labels = cv2.connectedComponents(dil)

    min_area = max(args.min_box_area, int(round(args.auto_min_area_ratio * width * height)))
    reports = []
    for i in range(1, num):
        sel = (labels == i) & stable
        if int(sel.sum()) < min_area:
            continue
        ys, xs = np.where(sel)
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = int(ys.min()), int(ys.max())
        conf = float(conf_sum[sel].sum()) / float(hits[sel].sum())
        reports.append({
            "name": f"region{len(reports)}",
            "detected": True,
            "left": x0,
            "top": y0,
            "right": x1,
            "bottom": y1,
            "width": x1 - x0 + 1,
            "height": y1 - y0 + 1,
            "orientation": "horizontal" if (x1 - x0) >= (y1 - y0) else "vertical",
            "confidence": round(conf, 4),
        })

    reports.sort(key=lambda r: (r["top"], r["left"]))

    # Per-frame presence: a sample "has text" when any reported region shows
    # enough text pixels in it. This keeps ``segments`` consistent with
    # ``regions`` and counts a frame that only carries a watermark (no subtitle)
    # as text, so a video whose watermark runs the whole length yields one segment.
    thresholds = [max(args.min_box_area, int(round(r["width"] * r["height"] * args.min_text_ratio)))
                  for r in reports]
    presence = [False] * n
    for i, pk in enumerate(packed):
        mask = np.unpackbits(pk, axis=1)[:, :width].astype(bool)
        for r, t in zip(reports, thresholds):
            sub = mask[r["top"]:r["bottom"] + 1, r["left"]:r["right"] + 1]
            if int(sub.sum()) >= t:
                presence[i] = True
                break
    return reports, presence


def main():
    args = parse_args(sys.argv[1:])
    media = Path(args.media)
    if not media.is_file():
        emit({"success": False, "error": f"Input file not found: {media}"}, 1)
    if cv2 is None or np is None:
        emit({"success": False, "error": f"Failed to import cv2/numpy: {_IMPORT_ERROR}"}, 1)

    sess, used_providers, available = build_session(args.model, args.provider, args.device_id)

    cap = cv2.VideoCapture(str(media))
    if not cap.isOpened():
        emit({"success": False, "error": f"Cannot open video: {media}"}, 1)

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if width <= 0 or height <= 0:
        cap.release()
        emit({"success": False, "error": "Video has no readable frames / dimensions"}, 1)

    eff_fps = fps if fps > 0 else 25.0
    duration = frame_count / eff_fps if frame_count > 0 else 0.0
    sample_fps = args.sample_fps if args.sample_fps > 0 else 1.0
    if duration > 0 and sample_fps * duration > args.max_samples:
        sample_fps = args.max_samples / duration
    stride = max(1, int(round(eff_fps / sample_fps)))

    upscale = args.upscale
    if upscale < 0:
        upscale = 0.0
    elif 0 < upscale < 0.01:
        upscale = 0.01

    # No --regions given -> auto mode: scan the whole frame and report the
    # regions that actually contain text (subtitles / watermarks).
    auto_mode = not str(args.regions or "").strip()
    regions = None if auto_mode else build_regions(args, width, height)
    frames = []

    sample_times = []
    idx = 0
    while True:
        if not cap.grab():
            break
        if idx % stride == 0:
            ok, frame = cap.retrieve()
            if not ok:
                break
            frames.append(frame)
            sample_times.append(round(idx / eff_fps, 3))
            if len(sample_times) >= args.max_samples:
                break
        idx += 1
    cap.release()

    if not sample_times:
        emit({"success": False, "error": "No frames were sampled from the video"}, 1)

    sample_period = stride / eff_fps if eff_fps > 0 else 0.0

    presence_any = [False] * len(sample_times)
    if auto_mode:
        region_reports, presence_any = analyze_auto(sess, frames, args, width, height)
    else:
        # Every requested region is reported; regions without text carry detected=false.
        region_reports = []
        for reg in regions:
            reg["_frames"] = frames
        for reg in regions:
            box, presence = analyze_region(sess, reg, args)
            report = {"detected": box is not None}
            if box is not None:
                report.update(box)
            else:
                report.update({"left": None, "top": None, "right": None, "bottom": None,
                               "width": None, "height": None, "confidence": 0.0})
            region_reports.append(report)
            if presence:
                presence_any = [a or b for a, b in zip(presence_any, presence)]

    any_detected = any(r["detected"] for r in region_reports)
    segments = build_segments(
        presence_any, sample_times, sample_period, duration,
        max(0, args.gap_bridge))

    detect = {
        "engine": "ml",
        "mode": "auto" if auto_mode else "regions",
        "detected": any_detected,
        "model": str(args.model),
        "providers": used_providers,
        "availableProviders": available,
        "sampleFps": round(sample_fps, 3),
        "sampledFrames": len(sample_times),
        "upscale": round(upscale, 3),
        "gapBridge": args.gap_bridge,
        "params": {
            "regionRatio": round(min(max(args.region_ratio, 0.05), 1.0), 4),
            "detThresh": args.det_thresh,
            "minTextRatio": args.min_text_ratio,
            "minBoxArea": args.min_box_area,
            "detLimit": args.det_limit,
            "minDetSize": args.min_det_size,
            "autoFreqThreshold": args.auto_freq_threshold,
            "autoMinAreaRatio": args.auto_min_area_ratio,
        },
    }
    if not any_detected:
        detect["message"] = ("No text detected in the frame; lower detThresh."
                             if auto_mode else
                             "No text detected in any region; lower detThresh or widen a region.")

    emit({
        "success": True,
        "video": {
            "width": width,
            "height": height,
            "fps": round(eff_fps, 3),
            "frameCount": frame_count,
            "duration": round(duration, 3),
        },
        "detect": detect,
        # 所有请求区域按顺序列出（含 detected）；每个是绝对像素坐标的扁平文本框
        "regions": region_reports,
        # 全片出现文字的时间段（各区域合并，只要有文字即为有）
        "segments": segments,
    }, 0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        emit({"success": False, "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()}, 1)
