#!/usr/bin/env python3
"""沿时间轴检测视频中出现 / 未出现人脸的连续时间段。

用法:
    face_detect.py <video> [--sample-fps 2] [--det-thresh 0.5] [--det-size 640]
                   [--max-samples 1200] [--ctx-id -1] [--upscale 0]
                   [--model-root PATH] [--name buffalo_l]

输出:
    向 stdout 打印单个 JSON 对象（成功或失败），进程退出码 0/1。
    形如:
    {
      "success": true,
      "duration": 15.083,
      "fps": 24.0,
      "sampleFps": 2.0,
      "sampledFrames": 31,
      "facesFound": 12,
      "segments": [
        {"start": 0.0, "end": 2.5, "hasFace": true,  "faceCount": 1},
        {"start": 2.5, "end": 6.0, "hasFace": false, "faceCount": 0}
      ]
    }

说明:
    - 按 sampleFps 沿时间轴采样帧，对每帧用 InsightFace 检测是否有脸;
    - 相邻采样点状态相同则合并为同一时间段，时间段首尾相连、覆盖整个视频;
    - faceCount 取该时间段内采样到的最大人脸数;
    - upscale > 0 时，每个有脸时间段前后各延长 upscale 秒（最小 0.01），
      无脸时间段相应缩短，整体范围不变；扩展后重叠的有脸段会合并。
"""

import argparse
import json
import os
import sys


def parse_args(argv):
    p = argparse.ArgumentParser(description="Detect face / no-face time segments in a video.")
    p.add_argument("video", help="Path to the input video file")
    p.add_argument("--sample-fps", type=float, default=2.0, help="Frames sampled per second (default 2)")
    p.add_argument("--det-thresh", type=float, default=0.5, help="Detection score threshold (default 0.5)")
    p.add_argument("--det-size", type=int, default=640, help="Detector input size (default 640)")
    p.add_argument("--max-samples", type=int, default=1200, help="Max sampled frames; sampling density is lowered to fit (default 1200)")
    p.add_argument("--ctx-id", type=int, default=-1, help="InsightFace ctx_id: -1 CPU, >=0 GPU (default -1)")
    p.add_argument("--upscale", type=float, default=0.0, help="Extend each face segment by this many seconds on both sides (min 0.01 when > 0; default 0 = no change)")
    p.add_argument("--model-root", default=None, help="InsightFace model root (default: python/.insightface)")
    p.add_argument("--name", default="buffalo_l", help="Model pack name (default buffalo_l)")
    return p.parse_args(argv)


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(code)


def build_detector(args):
    from insightface.app import FaceAnalysis  # 延迟导入，便于快速失败时给出清晰报错

    root = args.model_root or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".insightface")
    app = FaceAnalysis(name=args.name, root=root, allowed_modules=["detection"])
    app.prepare(ctx_id=args.ctx_id, det_thresh=args.det_thresh, det_size=(args.det_size, args.det_size))
    return app


def apply_upscale(segments, upscale):
    """把每个有脸时间段前后各延长 upscale 秒，无脸段相应缩短；整体范围不变。

    扩展后相互重叠的有脸段会合并，被完全挤掉的无脸段会被移除。
    """
    if upscale <= 0 or not segments:
        return segments

    total_end = segments[-1]["end"]

    face = []
    for s in segments:
        if not s.get("hasFace"):
            continue
        st = max(0.0, s["start"] - upscale)
        en = min(total_end, s["end"] + upscale)
        if en > st:
            face.append({"start": st, "end": en, "faceCount": s.get("faceCount", 0)})

    if not face:
        return segments

    # 按起点排序后合并重叠 / 相接的有脸段，faceCount 取最大
    face.sort(key=lambda x: x["start"])
    merged = [dict(face[0])]
    for f in face[1:]:
        last = merged[-1]
        if f["start"] <= last["end"] + 1e-9:
            last["end"] = max(last["end"], f["end"])
            last["faceCount"] = max(last["faceCount"], f["faceCount"])
        else:
            merged.append(dict(f))

    # 用有脸段切割时间轴，剩余区间即无脸段
    result = []
    cursor = 0.0
    for f in merged:
        if f["start"] > cursor + 1e-9:
            result.append({"start": round(cursor, 3), "end": round(f["start"], 3), "hasFace": False, "faceCount": 0})
        result.append({"start": round(f["start"], 3), "end": round(f["end"], 3), "hasFace": True, "faceCount": f["faceCount"]})
        cursor = f["end"]
    if total_end > cursor + 1e-9:
        result.append({"start": round(cursor, 3), "end": round(total_end, 3), "hasFace": False, "faceCount": 0})
    return result


def detect_segments(args):
    import cv2

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {args.video}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if fps <= 0:
        # 无帧率信息时按 30fps 估算时长
        fps = 30.0
    duration = frame_count / fps if frame_count > 0 else 0.0

    # upscale 归一化：负值视为 0；正数不小于 0.01
    upscale = args.upscale
    if upscale < 0:
        upscale = 0.0
    elif 0 < upscale < 0.01:
        upscale = 0.01

    # 采样密度：不超过 sampleFps，同时不超过 max-samples 上限
    sample_fps = args.sample_fps
    if duration > 0 and sample_fps * duration > args.max_samples:
        sample_fps = args.max_samples / duration
    if sample_fps <= 0:
        sample_fps = args.sample_fps

    step = max(1, int(round(fps / sample_fps))) if fps > 0 else 30

    app = build_detector(args)

    # 采样时间戳（秒）：0, step, 2*step, ... 直到 duration
    samples = []  # [(time, hasFace, faceCount)]
    idx = 0
    while True:
        t = idx / fps if fps > 0 else idx / 30.0
        if duration > 0 and t >= duration:
            break
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            break
        faces = app.get(frame)
        samples.append((round(t, 3), len(faces) > 0, len(faces)))
        idx += step
        if idx > 10_000_000:  # 安全上限
            break

    cap.release()

    if not samples:
        return {
            "duration": round(duration, 3),
            "fps": round(fps, 3),
            "sampleFps": round(sample_fps, 3),
            "upscale": round(upscale, 3),
            "sampledFrames": 0,
            "facesFound": 0,
            "segments": [],
        }

    # 合并相邻同状态采样点为连续时间段；段首尾相连覆盖整个视频
    segments = []
    run_start_t = samples[0][0]
    run_has_face = samples[0][1]
    run_max_count = samples[0][2]
    for i in range(1, len(samples)):
        t, has_face, count = samples[i]
        if has_face == run_has_face:
            run_max_count = max(run_max_count, count)
            continue
        segments.append(
            {
                "start": run_start_t,
                "end": t,
                "hasFace": run_has_face,
                "faceCount": run_max_count,
            }
        )
        run_start_t = t
        run_has_face = has_face
        run_max_count = count
    # 收尾段：结束时间取视频时长（无时长信息则取最后一个采样点）
    end_t = round(duration, 3) if duration > 0 else samples[-1][0]
    segments.append(
        {
            "start": run_start_t,
            "end": end_t,
            "hasFace": run_has_face,
            "faceCount": run_max_count,
        }
    )

    return {
        "duration": round(duration, 3),
        "fps": round(fps, 3),
        "sampleFps": round(sample_fps, 3),
        "upscale": round(upscale, 3),
        "sampledFrames": len(samples),
        "facesFound": sum(1 for s in samples if s[1]),
        "segments": apply_upscale(segments, upscale),
    }


def main():
    args = parse_args(sys.argv[1:])
    if not os.path.isfile(args.video):
        emit({"success": False, "error": f"Video not found: {args.video}"}, 1)
    try:
        result = detect_segments(args)
    except Exception as e:  # noqa: BLE001 - 统一以 JSON 报错
        emit({"success": False, "error": str(e)}, 1)
    result["success"] = True
    emit(result, 0)


if __name__ == "__main__":
    main()
