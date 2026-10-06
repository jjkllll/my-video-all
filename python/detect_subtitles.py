#!/usr/bin/env python3
"""Detect burned-in subtitles / watermarks using OpenCV.

The clip is sampled at `sampleFps` frames per second. For every region you
declare (see `--regions`) a per-frame "text-likeness" mask is built and projected
onto the axis perpendicular to the text direction:

* ``horizontal`` text (classic bottom subtitles): rows are projected, and the
  contiguous "hot" band of rows is the subtitle band.
* ``vertical`` text (e.g. a watermark of stacked characters on the right edge):
  columns are projected, and the hot band of columns is the text band.

Each region is analysed independently and reported in ``regions`` as a plain
array in request order (regions[0], regions[1], ...), without distinguishing
subtitles from watermarks: every entry carries ``detected`` and, when text was
found, the flat text box in absolute pixel coordinates plus ``confidence``.
A top-level ``segments`` array gives the time ranges where the whole video shows
text (the union of all regions over the sampled frames).

When no ``--regions`` is given a single default region covering the bottom
``--region-ratio`` fraction of the frame is used, preserving the original
bottom-subtitle behaviour.

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


def emit(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(code)


def parse_args(argv):
    p = argparse.ArgumentParser(description="Detect subtitles / watermarks with OpenCV.")
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
                        '"orientation":"horizontal"|"vertical", '
                        '"anchor":"bottom"|"top"|"left"|"right"}. '
                        "Coordinates are ratios of the frame size. orientation defaults to "
                        '"horizontal"; anchor defaults to "bottom" for horizontal and "right" '
                        "for vertical (i.e. which region edge the text band hugs).")
    p.add_argument("--bright-thresh", type=int, default=200,
                   help="Grayscale threshold for bright subtitle pixels (default: 200)")
    p.add_argument("--dark-thresh", type=int, default=100,
                   help="Grayscale threshold for the dark counterpart near bright glyphs (default: 100)")
    p.add_argument("--min-row-ratio", type=float, default=0.05,
                   help="Min fraction of the projection extent that must be text to mark a bin active "
                        "(default: 0.05). Raise it to reject textured backgrounds.")
    p.add_argument("--max-row-ratio", type=float, default=0.7,
                   help="Max fraction of the projection extent allowed, filters solid bands (default: 0.7)")
    p.add_argument("--freq-threshold", type=float, default=0.05,
                   help="Min fraction of sampled frames a bin must be active (default: 0.05)")
    p.add_argument("--min-confidence", type=float, default=0.04,
                   help="Min mean activation across the detected band (default: 0.04)")
    p.add_argument("--min-band-height-ratio", type=float, default=0.015,
                   help="Min detected band thickness as a fraction of the reference edge "
                        "(height for horizontal text, width for vertical text; default: 0.015)")
    p.add_argument("--gap-bridge", type=int, default=8,
                   help="Bridge gaps up to this many projection bins inside a band (default: 8)")
    p.add_argument("--padding", type=int, default=0,
                   help="Extra pixels to extend the cut upward past the detected top of a "
                        "horizontal band (default: 0)")
    p.add_argument("--upscale", type=float, default=0.0,
                   help="Extend each subtitle segment by this many seconds on both sides "
                        "(min 0.01 when > 0; default 0 = no change)")
    p.add_argument("--edges", action="store_true",
                   help="Also use Canny edges (helps non-bright/colored subtitles)")
    return p.parse_args(argv)


def bridge_gaps(hot, max_gap):
    """Fill runs of False of length <= max_gap that are surrounded by True."""
    n = len(hot)
    i = 0
    while i < n:
        if not hot[i]:
            j = i
            while j < n and not hot[j]:
                j += 1
            if i > 0 and j < n and (j - i) <= max_gap:
                hot[i:j] = True
            i = j
        else:
            i += 1
    return hot


def _clamp01(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        f = 0.0
    return min(max(f, 0.0), 1.0)


def build_segments(present, sample_times, sample_period, duration, gap_bridge):
    """Split the whole video into contiguous ``{start, end, hasText}`` ranges.

    ``present[i]`` says whether *any* region showed text in sampled frame ``i``.
    Short "no text" gaps of up to ``gap_bridge`` samples are bridged first, then
    the timeline is tiled end to end: consecutive samples in the same state merge
    into one range. The ranges always cover ``[0, duration]`` with no gaps, so a
    clip that shows text throughout (e.g. a watermark) becomes a single
    ``{start: 0, end: duration, hasText: true}`` and a clip with no text at all
    becomes a single ``hasText: false`` range.
    """
    if not present:
        if duration > 0:
            return [{"start": 0.0, "end": round(duration, 3), "hasText": False}]
        return []
    state = bridge_gaps(np.asarray(present, dtype=bool), gap_bridge)
    n = len(state)
    end_limit = duration if duration > 0 else sample_times[-1] + sample_period
    # Boundaries: 0, then the midpoint between neighbouring samples, then the end.
    bounds = [0.0]
    for i in range(1, n):
        bounds.append((sample_times[i - 1] + sample_times[i]) / 2.0)
    bounds.append(end_limit)
    # Clamp and round once so adjacent ranges share the exact same edge.
    bounds = [round(min(max(b, 0.0), end_limit), 3) for b in bounds]

    segments = []
    i = 0
    while i < n:
        j = i
        while j < n and state[j] == state[i]:
            j += 1
        segments.append({"start": bounds[i], "end": bounds[j], "hasText": bool(state[i])})
        i = j
    return segments


def make_region(name, left, top, right, bottom, orientation, width, height, anchor=None):
    """Turn ratio coordinates into a pixel region descriptor."""
    x0 = max(0, min(int(left * width), width - 1))
    x1 = max(x0 + 1, min(int(right * width), width))
    y0 = max(0, min(int(top * height), height - 1))
    y1 = max(y0 + 1, min(int(bottom * height), height))
    horiz = orientation != "vertical"
    if anchor not in ("bottom", "top", "left", "right"):
        anchor = "bottom" if horiz else "right"
    # Projection bins: rows for horizontal text, columns for vertical text.
    length = (y1 - y0) if horiz else (x1 - x0)
    return {
        "name": name,
        "orientation": "horizontal" if horiz else "vertical",
        "anchor": anchor,
        "left": x0, "top": y0, "right": x1, "bottom": y1,
        "length": length,
    }


def build_regions(args, width, height):
    spec = str(args.regions or "").strip()
    if spec:
        try:
            data = json.loads(spec)
        except Exception as exc:
            emit({"success": False, "error": f"Invalid --regions JSON: {exc}"}, 1)
        if not isinstance(data, list) or not data:
            emit({"success": False, "error": "--regions must be a non-empty JSON array"}, 1)
        regions = []
        for i, r in enumerate(data):
            if not isinstance(r, dict):
                emit({"success": False, "error": f"--regions[{i}] must be an object"}, 1)
            orientation = str(r.get("orientation") or "horizontal").lower()
            if orientation not in ("horizontal", "vertical"):
                emit({"success": False,
                      "error": f"--regions[{i}].orientation must be 'horizontal' or 'vertical'"}, 1)
            left = _clamp01(r.get("left", 0.0))
            top = _clamp01(r.get("top", 0.0))
            right = _clamp01(r.get("right", 1.0))
            bottom = _clamp01(r.get("bottom", 1.0))
            if right <= left or bottom <= top:
                emit({"success": False,
                      "error": f"--regions[{i}] is empty (right must be > left and bottom must be > top)"}, 1)
            regions.append(make_region(
                str(r.get("name") or f"region{i}"),
                left, top, right, bottom, orientation, width, height, r.get("anchor"),
            ))
        return regions

    ratio = min(max(args.region_ratio, 0.05), 1.0)
    return [make_region("default", 0.0, 1.0 - ratio, 1.0, 1.0, "horizontal", width, height, "bottom")]


def pick_band(hot, anchor):
    """Return the (start, end) contiguous hot run nearest the anchor edge."""
    runs = []
    n = len(hot)
    i = 0
    while i < n:
        if hot[i]:
            j = i
            while j < n and hot[j]:
                j += 1
            runs.append((i, j - 1))
            i = j
        else:
            i += 1
    if not runs:
        return None
    if anchor in ("top", "left"):
        return runs[0]
    # "bottom" / "right" (default) -> closest to the far edge
    return runs[-1]


def analyze_region(acc, sampled, args, width, height, gap_bridge):
    """Analyse one region.

    Returns ``(box, presence)``: ``box`` is a flat text box in absolute pixels or
    ``None`` when no text is found; ``presence`` is a per-sample bool list saying
    whether this region showed text in each sampled frame.
    """
    reg = acc["region"]
    horiz = acc["horiz"]
    no_presence = [False] * len(acc["sample_active"])
    freq_rate = acc["freq"] / float(sampled)
    hot = bridge_gaps(freq_rate >= args.freq_threshold, gap_bridge)

    band = pick_band(hot, reg["anchor"])
    if band is None:
        return None, no_presence

    band_start, band_end = band
    band_len = band_end - band_start + 1
    confidence = float(freq_rate[band_start:band_end + 1].mean())

    ref_edge = height if horiz else width
    min_band_px = max(3, int(round(ref_edge * args.min_band_height_ratio)))
    if band_len < min_band_px:
        return None, no_presence
    if confidence < args.min_confidence:
        return None, no_presence

    # Max outer box: union the perpendicular extents of every active bin in band.
    box_lo = None
    box_hi = None
    if acc["bin_ids"]:
        bins = np.asarray(acc["bin_ids"])
        pmins = np.asarray(acc["perp_min"])
        pmaxs = np.asarray(acc["perp_max"])
        in_band = (bins >= band_start) & (bins <= band_end)
        if in_band.any():
            box_lo = int(pmins[in_band].min())
            box_hi = int(pmaxs[in_band].max())

    if horiz:
        top = reg["top"] + band_start
        bottom = reg["top"] + band_end
        pad = max(0, args.padding)
        top = max(0, top - pad)
        left = reg["left"] + (box_lo if box_lo is not None else 0)
        right = reg["left"] + (box_hi if box_hi is not None else (reg["right"] - reg["left"] - 1))
    else:
        left = reg["left"] + band_start
        right = reg["left"] + band_end
        top = reg["top"] + (box_lo if box_lo is not None else 0)
        bottom = reg["top"] + (box_hi if box_hi is not None else (reg["bottom"] - reg["top"] - 1))

    presence = [bool(act[band_start:band_end + 1].any()) for act in acc["sample_active"]]
    return {
        "left": left,
        "top": top,
        "right": right,
        "bottom": bottom,
        "width": right - left + 1,
        "height": bottom - top + 1,
        "confidence": round(confidence, 4),
    }, presence


def main():
    args = parse_args(sys.argv[1:])
    media = Path(args.media)
    if not media.is_file():
        emit({"success": False, "error": f"Input file not found: {media}"}, 1)

    if cv2 is None or np is None:
        emit({"success": False, "error": f"Failed to import cv2/numpy: {_IMPORT_ERROR}"}, 1)

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

    # Sampling stride derived from the real fps
    eff_fps = fps if fps > 0 else 25.0
    duration = frame_count / eff_fps if frame_count > 0 else 0.0
    sample_fps = args.sample_fps if args.sample_fps > 0 else 1.0
    # Lower the density to fit max-samples so sampling still spans the whole clip
    if duration > 0 and sample_fps * duration > args.max_samples:
        sample_fps = args.max_samples / duration
    stride = max(1, int(round(eff_fps / sample_fps)))

    # upscale normalization: negative -> 0; positive but tiny -> 0.01
    upscale = args.upscale
    if upscale < 0:
        upscale = 0.0
    elif 0 < upscale < 0.01:
        upscale = 0.01
    gap_bridge = max(0, args.gap_bridge)

    regions = build_regions(args, width, height)

    # Per-region accumulators (projection length = region rows or columns)
    accs = []
    for reg in regions:
        horiz = reg["orientation"] == "horizontal"
        proj_extent = (reg["right"] - reg["left"]) if horiz else (reg["bottom"] - reg["top"])
        min_px = max(1, int(round(proj_extent * args.min_row_ratio)))
        max_px = max(min_px, int(round(proj_extent * args.max_row_ratio)))
        kern_len = max(3, (proj_extent // 120) | 1)
        kernel = (cv2.getStructuringElement(cv2.MORPH_RECT, (kern_len, 3)) if horiz else
                  cv2.getStructuringElement(cv2.MORPH_RECT, (3, kern_len)))
        accs.append({
            "region": reg,
            "horiz": horiz,
            "min_px": min_px,
            "max_px": max_px,
            "kernel": kernel,
            "freq": np.zeros(reg["length"], dtype=np.float64),
            "sample_active": [],
            "bin_ids": [],
            "perp_min": [],
            "perp_max": [],
        })

    sampled = 0
    sample_times = []
    idx = 0
    while sampled < args.max_samples:
        if not cap.grab():
            break
        if idx % stride == 0:
            ok, frame = cap.retrieve()
            if not ok:
                break
            sample_times.append(round(idx / eff_fps, 3))
            gray_full = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            for acc in accs:
                reg = acc["region"]
                crop = gray_full[reg["top"]:reg["bottom"], reg["left"]:reg["right"]]
                # Bright glyph pixels that sit next to dark pixels (outline / gaps).
                # This rejects large uniform bright areas (pavement, walls, shirts).
                _, bright = cv2.threshold(crop, args.bright_thresh, 255, cv2.THRESH_BINARY)
                _, dark = cv2.threshold(crop, args.dark_thresh, 255, cv2.THRESH_BINARY_INV)
                near_dark = cv2.dilate(dark, np.ones((5, 5), np.uint8))
                mask = cv2.bitwise_and(bright, near_dark)
                if args.edges:
                    edges = cv2.Canny(crop, 50, 150)
                    mask = cv2.bitwise_or(mask, cv2.bitwise_and(edges, near_dark))
                mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, acc["kernel"])
                if acc["horiz"]:
                    proj = mask.sum(axis=1).astype(np.float64) / 255.0
                else:
                    proj = mask.sum(axis=0).astype(np.float64) / 255.0
                active = (proj >= acc["min_px"]) & (proj <= acc["max_px"])
                acc["freq"] += active
                acc["sample_active"].append(active)
                for b in np.where(active)[0]:
                    perp = np.where(mask[b] > 0)[0] if acc["horiz"] else np.where(mask[:, b] > 0)[0]
                    if perp.size:
                        acc["bin_ids"].append(int(b))
                        acc["perp_min"].append(int(perp[0]))
                        acc["perp_max"].append(int(perp[-1]))
            sampled += 1
        idx += 1
    cap.release()

    if sampled == 0:
        emit({"success": False, "error": "No frames were sampled from the video"}, 1)

    sample_period = stride / eff_fps if eff_fps > 0 else 0.0

    # Every requested region is reported; regions without text carry detected=false.
    region_reports = []
    presence_any = [False] * sampled
    for acc in accs:
        box, presence = analyze_region(acc, sampled, args, width, height, gap_bridge)
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
        presence_any, sample_times, sample_period, duration, gap_bridge)

    detect = {
        "engine": "heuristic",
        "detected": any_detected,
        "sampleFps": round(sample_fps, 3),
        "sampledFrames": sampled,
        "upscale": round(upscale, 3),
        "gapBridge": gap_bridge,
        "params": {
            "regionRatio": round(min(max(args.region_ratio, 0.05), 1.0), 4),
            "brightThresh": args.bright_thresh,
            "darkThresh": args.dark_thresh,
            "minRowRatio": args.min_row_ratio,
            "maxRowRatio": args.max_row_ratio,
            "freqThreshold": args.freq_threshold,
            "minConfidence": args.min_confidence,
            "minBandHeightRatio": args.min_band_height_ratio,
            "padding": args.padding,
            "edges": bool(args.edges),
        },
    }
    if not any_detected:
        detect["message"] = "No text band detected in any region; try lowering freqThreshold or widening a region."

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
