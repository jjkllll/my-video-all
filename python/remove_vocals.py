#!/usr/bin/env python3
"""Remove vocals (speech) from an audio/video file using Demucs.

Separates the input with Demucs and writes the "no_vocals" (accompaniment)
track to --out, i.e. drums + bass + other, with the vocals removed.

The script always prints a single JSON object to stdout:
  success: {"success": true, ...}
  failure: {"success": false, "error": "..."}
and exits with code 0 / 1 accordingly.
"""

import argparse
import json
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent


def emit(obj, code=0):
    """Print a single JSON object to stdout and exit."""
    print(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(code)


def parse_args(argv):
    p = argparse.ArgumentParser(description="Remove vocals from a media file with Demucs.")
    p.add_argument("media", help="Path to the input audio/video file")
    p.add_argument("--out", required=True, help="Path of the output (no-vocals) file")
    p.add_argument("--model", default="htdemucs", help="Demucs model name (default htdemucs)")
    p.add_argument("--repo", default=str(HERE / ".demucs-models"),
                   help="Folder containing pre-trained Demucs models (default python/.demucs-models)")
    p.add_argument("--device", default="cpu", help="Torch device: cpu or cuda (default cpu)")
    p.add_argument("--shifts", type=int, default=1, help="Random shifts for time equivariance (default 1)")
    p.add_argument("--overlap", type=float, default=0.25, help="Overlap between segments (default 0.25)")
    p.add_argument("--segment", type=int, default=None, help="Segment length in seconds (default: model value)")
    p.add_argument("--jobs", type=int, default=0, help="Number of parallel jobs (default 0 = auto)")
    p.add_argument("--stems-out-dir", default=None,
                   help="If set, also write every separated stem into this directory")
    p.add_argument("--mp3", action="store_true", help="Encode output as mp3 instead of wav")
    p.add_argument("--mp3-bitrate", type=int, default=320, help="MP3 bitrate in kbps (default 320)")
    p.add_argument("--int24", action="store_true", help="Write 24-bit PCM instead of 16-bit")
    p.add_argument("--float32", action="store_true", help="Write 32-bit float PCM (wav only)")
    return p.parse_args(argv)


def main():
    args = parse_args(sys.argv[1:])

    media = Path(args.media)
    if not media.is_file():
        emit({"success": False, "error": f"Input file not found: {media}"}, 1)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    repo = Path(args.repo) if args.repo else None

    try:
        from demucs.api import Separator, save_audio
    except Exception as exc:  # pragma: no cover - environment issue
        emit({"success": False, "error": f"Failed to import demucs: {exc}"}, 1)

    try:
        separator = Separator(
            model=args.model,
            repo=repo,
            device=args.device,
            shifts=args.shifts,
            overlap=args.overlap,
            split=True,
            segment=args.segment,
            jobs=args.jobs,
            progress=False,
        )
    except Exception as exc:
        emit({"success": False, "error": f"Failed to load model '{args.model}': {exc}"}, 1)

    try:
        origin, separated = separator.separate_audio_file(media)
    except Exception as exc:
        emit({"success": False, "error": f"Failed to separate audio: {exc}"}, 1)

    stems = list(separated.keys())

    # no_vocals = sum of all stems except the vocals stem
    no_vocals = None
    for name, src in separated.items():
        if name == "vocals":
            continue
        no_vocals = src if no_vocals is None else no_vocals + src
    if no_vocals is None:
        emit({"success": False, "error": f"Model produced no non-vocal stems (stems: {stems})"}, 1)

    samplerate = separator.samplerate
    save_kwargs = {
        "samplerate": samplerate,
        "clip": "rescale",
        "bits_per_sample": 24 if args.int24 else 16,
        "as_float": args.float32,
    }
    if args.mp3:
        save_kwargs["bitrate"] = args.mp3_bitrate

    try:
        save_audio(no_vocals, str(out), **save_kwargs)
    except Exception as exc:
        emit({"success": False, "error": f"Failed to write output: {exc}"}, 1)

    result = {
        "success": True,
        "model": args.model,
        "device": args.device,
        "samplerate": samplerate,
        "channels": separator.audio_channels,
        "durationSeconds": round(float(origin.shape[-1]) / samplerate, 3),
        "stems": stems,
        "removed": "vocals",
        "output": {
            "path": str(out),
            "sizeBytes": out.stat().st_size if out.exists() else 0,
        },
    }

    if args.stems_out_dir:
        stem_dir = Path(args.stems_out_dir)
        stem_dir.mkdir(parents=True, exist_ok=True)
        ext = ".mp3" if args.mp3 else ".wav"
        written = {}
        for name, src in separated.items():
            sp = stem_dir / f"{name}{ext}"
            try:
                save_audio(src, str(sp), **save_kwargs)
            except Exception as exc:
                emit({"success": False, "error": f"Failed to write stem '{name}': {exc}"}, 1)
            written[name] = {"path": str(sp), "sizeBytes": sp.stat().st_size if sp.exists() else 0}
        result["stemFiles"] = written

    emit(result, 0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # last-resort guard: always print JSON
        emit({"success": False, "error": f"{type(exc).__name__}: {exc}",
              "traceback": traceback.format_exc()}, 1)
