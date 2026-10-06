#!/usr/bin/env python3
"""Text-to-speech using the bundled sherpa-onnx Supertonic 3 (int8) model.

Model: ``sherpa-onnx-supertonic-3-tts-int8-2026-05-11`` in the project root.
Runs on GPU (CUDA) by default; falls back to CPU automatically if CUDA is not
usable. Depends only on the project-local ``.vsrenv`` environment plus a
project-local CUDA runtime directory (``.tts_cuda``), so nothing is installed
into the system.

This script always prints a single JSON object to stdout:
  success: {"success": true, ...}
  failure: {"success": false, "error": "..."}
and exits 0 / 1 accordingly.
"""

import argparse
import ctypes
import json
import sys
import time
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
DEFAULT_MODEL_DIR = PROJECT_ROOT / "sherpa-onnx-supertonic-3-tts-int8-2026-05-11"

# The real stdout is reserved for the single JSON result; any library logging
# is redirected to stderr while we work.
_REAL_STDOUT = sys.stdout


def emit(obj, code=0):
    """Print a single JSON object to the reserved stdout and exit."""
    _REAL_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _REAL_STDOUT.flush()
    sys.exit(code)


def _cuda_lib_dirs():
    """Project-local directories that hold the CUDA libraries we need.

    ``.tts_cuda/lib`` provides a newer ``libcudart.so.12`` (required by the
    bundled onnxruntime CUDA provider); the ``nvidia/*`` wheels inside
    ``.vsrenv`` provide cuDNN 9, cuBLAS, cuFFT, cuRAND, etc.
    """
    dirs = [PROJECT_ROOT / ".tts_cuda" / "lib"]
    nvidia = PROJECT_ROOT / ".vsrenv" / "lib" / "python3.12" / "site-packages" / "nvidia"
    if nvidia.is_dir():
        dirs.extend(sorted(p for p in nvidia.glob("*/lib") if p.is_dir()))
    return dirs


def preload_cuda_libraries():
    """Preload CUDA shared libraries (RTLD_GLOBAL) before importing sherpa_onnx.

    Setting ``LD_LIBRARY_PATH`` from inside a running process is too late for
    already-started dynamic linking, so we load the libraries explicitly. Once
    loaded, the onnxruntime CUDA provider resolves them by soname.
    """
    dirs = _cuda_lib_dirs()
    # Dependency order matters: runtime -> math libs -> cudnn last.
    names = [
        "libcudart.so.12",
        "libnvJitLink.so.12",
        "libcublasLt.so.12",
        "libcublas.so.12",
        "libcufft.so.11",
        "libcurand.so.10",
        "libcusparse.so.12",
        "libcusolver.so.11",
        "libcudnn.so.9",
    ]
    loaded = []
    for name in names:
        for d in dirs:
            candidate = d / name
            if candidate.exists():
                try:
                    ctypes.CDLL(str(candidate), mode=ctypes.RTLD_GLOBAL)
                    loaded.append(str(candidate))
                except OSError:
                    pass
                break
    return loaded


def parse_args():
    p = argparse.ArgumentParser(description="Supertonic 3 TTS (sherpa-onnx)")
    p.add_argument("text", nargs="?", help="Text to synthesize")
    p.add_argument("--text", dest="text_opt", help="Text to synthesize (alternative to positional)")
    p.add_argument("--out", required=True, help="Output .wav path")
    p.add_argument("--sid", type=int, default=0, help="Speaker id, 0-9 (default 0)")
    p.add_argument("--lang", default="en", help="Language code, e.g. en/ja/ko/fr (default en)")
    p.add_argument("--speed", type=float, default=1.0, help="Speaking speed, larger is faster (default 1.0)")
    p.add_argument("--num-steps", type=int, default=8, help="Diffusion steps (default 8)")
    p.add_argument("--device", default="cuda", choices=["cuda", "cpu", "auto"], help="Compute device (default cuda)")
    p.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR), help="Model directory")
    return p.parse_args()


def build_config(sherpa_onnx, model_dir: Path, provider: str, num_threads: int):
    return sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            supertonic=sherpa_onnx.OfflineTtsSupertonicModelConfig(
                duration_predictor=str(model_dir / "duration_predictor.int8.onnx"),
                text_encoder=str(model_dir / "text_encoder.int8.onnx"),
                vector_estimator=str(model_dir / "vector_estimator.int8.onnx"),
                vocoder=str(model_dir / "vocoder.int8.onnx"),
                tts_json=str(model_dir / "tts.json"),
                unicode_indexer=str(model_dir / "unicode_indexer.bin"),
                voice_style=str(model_dir / "voice.bin"),
            ),
            debug=False,
            num_threads=num_threads,
            provider=provider,
        )
    )


def synthesize(sherpa_onnx, model_dir, text, provider, args, num_threads):
    cfg = build_config(sherpa_onnx, model_dir, provider, num_threads)
    if not cfg.validate():
        raise ValueError("invalid TTS configuration (check model files)")
    tts = sherpa_onnx.OfflineTts(cfg)
    gen = sherpa_onnx.GenerationConfig()
    gen.sid = max(0, min(9, int(args.sid)))
    gen.num_steps = int(args.num_steps)
    gen.speed = float(args.speed)
    gen.extra["lang"] = str(args.lang)
    return tts.generate(text, gen)


def write_wav(path: Path, samples, sample_rate: int):
    import numpy as np

    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm = (data * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm.tobytes())


def main():
    args = parse_args()
    text = args.text_opt if args.text_opt is not None else args.text
    if not text or not str(text).strip():
        emit({"success": False, "error": "empty text"}, 1)

    model_dir = Path(args.model_dir).expanduser().resolve()
    if not model_dir.is_dir():
        emit({"success": False, "error": f"model directory not found: {model_dir}"}, 1)
    for fname in ("duration_predictor.int8.onnx", "text_encoder.int8.onnx",
                  "vector_estimator.int8.onnx", "vocoder.int8.onnx",
                  "tts.json", "unicode_indexer.bin", "voice.bin"):
        if not (model_dir / fname).exists():
            emit({"success": False, "error": f"missing model file: {fname}"}, 1)

    out_path = Path(args.out).expanduser().resolve()

    # Library logging (C++/onnxruntime) must not corrupt our JSON on stdout.
    sys.stdout = sys.stderr

    t0 = time.time()
    preload_cuda_libraries()
    try:
        import sherpa_onnx
    except Exception as e:  # pragma: no cover
        emit({"success": False, "error": f"failed to import sherpa_onnx: {e}. Install it in .vsrenv first."}, 1)

    num_threads = 4
    requested = args.device
    if requested == "auto":
        attempts = ["cuda", "cpu"]
    elif requested == "cuda":
        attempts = ["cuda", "cpu"]  # transparent fallback so the API still works without a GPU
    else:
        attempts = ["cpu"]

    last_err = None
    for provider in attempts:
        try:
            audio = synthesize(sherpa_onnx, model_dir, text, provider, args, num_threads)
        except Exception as e:
            last_err = f"{provider}: {e}"
            continue
        sample_rate = int(audio.sample_rate)
        num_samples = len(audio.samples)
        write_wav(out_path, audio.samples, sample_rate)
        emit({
            "success": True,
            "out": str(out_path),
            "provider": provider,
            "sample_rate": sample_rate,
            "num_samples": num_samples,
            "duration": num_samples / sample_rate if sample_rate else 0,
            "sid": max(0, min(9, int(args.sid))),
            "lang": args.lang,
            "num_steps": int(args.num_steps),
            "speed": float(args.speed),
            "elapsed": time.time() - t0,
            "fallback": provider != requested,
        })

    emit({"success": False, "error": f"speech synthesis failed ({last_err})"}, 1)


if __name__ == "__main__":
    main()
