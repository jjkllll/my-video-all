import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useVideoConfig } from "remotion";

const resolveSrc = (path: string) => {
  if (!path) return "";
  return path.startsWith("http://") || path.startsWith("https://")
    ? path
    : staticFile(path);
};

/**
 * 视频片段组件。
 * 在 durationInFrames 内播放素材；超出素材可用长度（sourceFrames）的部分保持黑帧。
 */
export const VideoClip: React.FC<{
  src: string;
  /** 片段总时长（帧） */
  durationInFrames: number;
  /** 素材可用帧数（已扣除 trimStartSeconds），超出部分渲染为黑帧 */
  sourceFrames: number;
  /** 从素材第几秒开始播放 */
  trimStartSeconds?: number;
  /** 原声音量，默认 0（静音） */
  volume?: number;
}> = ({ src, durationInFrames, sourceFrames, trimStartSeconds = 0, volume = 0 }) => {
  const { fps } = useVideoConfig();

  // 实际播放帧数：不超过片段总时长，也不超过素材可用帧数
  const playFrames = Math.max(0, Math.min(durationInFrames, Math.floor(sourceFrames)));
  const trimBefore = Math.max(0, Math.round(trimStartSeconds * fps));

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {playFrames > 0 ? (
        // 用 Sequence 限定播放窗口，窗口之外不渲染 => 自然显示黑底
        <Sequence durationInFrames={playFrames}>
          <OffthreadVideo
            src={resolveSrc(src)}
            trimBefore={trimBefore}
            trimAfter={trimBefore + playFrames}
            volume={volume}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
