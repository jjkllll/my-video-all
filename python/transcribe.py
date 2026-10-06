#!/usr/bin/env python3
"""用 faster-whisper 提取语音并生成带时间轴的 SRT 字幕。

用法:
    transcribe.py <media> [--language zh] [--model small] [--device cpu]
                  [--compute-type int8] [--beam-size 5] [--vad-filter]
                  [--initial-prompt TEXT] [--model-root PATH] [--srt-out PATH]

输出:
    向 stdout 打印单个 JSON 对象（成功或失败），进程退出码 0/1。
    形如:
    {
      "success": true,
      "language": "zh",
      "languageProbability": 0.99,
      "duration": 15.083,
      "model": "small",
      "segmentCount": 3,
      "segments": [
        {"index": 0, "start": 0.0, "end": 2.5, "text": "大家好"}
      ],
      "srt": "1\n00:00:00,000 --> 00:00:02,500\n大家好\n\n"
    }

说明:
    - 输入可为音频或视频文件（视频会自动抽取音轨，依赖 PyAV）;
    - 默认按中文（zh）识别，可用 --language 指定其它语言或 auto 自动判别;
    - --srt-out 指定时，会把 SRT 字幕写入该文件。
"""

import argparse
import json
import os
import sys


def parse_args(argv):
    p = argparse.ArgumentParser(description="Transcribe speech to SRT subtitles with faster-whisper.")
    p.add_argument("media", help="Path to the input audio/video file")
    p.add_argument("--language", default="zh", help="Spoken language code, e.g. zh / en / ja, or 'auto' (default zh)")
    p.add_argument("--model", default="small", help="Whisper model size or path (default small)")
    p.add_argument("--device", default="cpu", help="Inference device: cpu or cuda (default cpu)")
    p.add_argument("--compute-type", default="int8", help="Compute type: int8 / int8_float16 / float16 / float32 (default int8)")
    p.add_argument("--beam-size", type=int, default=5, help="Beam size for decoding (default 5)")
    p.add_argument("--no-vad", action="store_true", help="Disable VAD silence filtering (enabled by default)")
    p.add_argument("--initial-prompt", default=None, help="Optional prompt to bias decoding (e.g. domain terms)")
    p.add_argument("--model-root", default=None, help="Where to store/download models (default: python/.whisper-models)")
    p.add_argument("--srt-out", default=None, help="If set, write the SRT subtitles to this file path")
    return p.parse_args(argv)


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(code)


def format_timestamp(seconds):
    """秒 → SRT 时间戳 HH:MM:SS,mmm。"""
    if seconds is None or seconds < 0:
        seconds = 0.0
    ms = int(round(seconds * 1000))
    hours, ms = divmod(ms, 3600 * 1000)
    minutes, ms = divmod(ms, 60 * 1000)
    secs, ms = divmod(ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def build_srt(segments):
    blocks = []
    for i, seg in enumerate(segments, start=1):
        text = (seg["text"] or "").strip()
        blocks.append(
            f"{i}\n{format_timestamp(seg['start'])} --> {format_timestamp(seg['end'])}\n{text}\n"
        )
    return "\n".join(blocks)


def transcribe(args):
    from faster_whisper import WhisperModel

    root = args.model_root or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".whisper-models")

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type, download_root=root)

    language = None if str(args.language).lower() == "auto" else args.language

    seg_iter, info = model.transcribe(
        args.media,
        language=language,
        beam_size=args.beam_size,
        vad_filter=not args.no_vad,
        initial_prompt=args.initial_prompt,
        condition_on_previous_text=False,
    )

    segments = []
    for i, s in enumerate(seg_iter):
        segments.append(
            {
                "index": i,
                "start": round(float(s.start), 3),
                "end": round(float(s.end), 3),
                "text": (s.text or "").strip(),
            }
        )

    duration = segments[-1]["end"] if segments else 0.0
    srt = build_srt(segments)

    if args.srt_out:
        with open(args.srt_out, "w", encoding="utf-8") as f:
            f.write(srt)

    return {
        "language": getattr(info, "language", None),
        "languageProbability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 4),
        "duration": round(float(duration), 3),
        "model": args.model,
        "segmentCount": len(segments),
        "segments": segments,
        "srt": srt,
    }


def main():
    args = parse_args(sys.argv[1:])
    if not os.path.isfile(args.media):
        emit({"success": False, "error": f"Media not found: {args.media}"}, 1)
    try:
        result = transcribe(args)
    except Exception as e:  # noqa: BLE001 - 统一以 JSON 报错
        emit({"success": False, "error": str(e)}, 1)
    result["success"] = True
    emit(result, 0)


if __name__ == "__main__":
    main()
