import React from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  staticFile,
  useVideoConfig,
  type CalculateMetadataFunction,
} from "remotion";

// ========== 类型定义 ==========

/** 单条「音频 + 字幕」片段（start/end 为服务端排程后的最终秒数） */
export type InsertSegment = {
  /** 原始下标，仅用于标识 */
  index: number;
  /** 最终开始时间（秒），音频与字幕共用，保证两者对齐 */
  start: number;
  /** 最终结束时间（秒）= start + 音频实际时长 */
  end: number;
  /** 已解析的音频地址（http(s) 或 staticFile 相对路径） */
  audioSrc: string;
  /** 字幕文本 */
  text: string;
};

/** 字幕样式 */
export type SubtitleStyle = {
  /** 字号（px），默认取视频高度的 5% */
  fontSize?: number;
  /** 文字颜色，默认 #FFFFFF */
  color?: string;
  /** 字幕底色，默认半透明黑 */
  backgroundColor?: string;
  /** 出现位置，默认 bottom */
  position?: "bottom" | "top" | "center";
  /** 距画面边缘的比例（默认 0.06，按视频高度换算） */
  marginRatio?: number;
};

export type AudioSubtitleVideoProps = {
  /** 底图视频（整段铺底，保留原声） */
  videoSrc: string;
  /** 音频 + 字幕片段 */
  segments: InsertSegment[];
  /** 原声音量，默认 1 */
  videoVolume?: number;
  /** 配音音量，默认 1 */
  ttsVolume?: number;
  /** 字幕样式 */
  subtitle?: SubtitleStyle;
  /** 以下四项由 calculateMetadata 读取 */
  fps?: number;
  width?: number;
  height?: number;
  durationInFrames?: number;
};

// ========== 工具函数 ==========

const resolveSrc = (path: string) => {
  if (!path) return "";
  return path.startsWith("http://") || path.startsWith("https://")
    ? path
    : staticFile(path);
};

/** 系统已安装 Noto Sans / Noto CJK，兼顾拉丁与中日韩字符 */
const DEFAULT_FONT =
  '"Noto Sans", "Noto Sans CJK SC", "DejaVu Sans", "Liberation Sans", Arial, sans-serif';

// ========== 字幕框 ==========

const SubtitleBox: React.FC<{
  text: string;
  height: number;
  style?: SubtitleStyle;
}> = ({ text, height, style }) => {
  const position = style?.position ?? "bottom";
  const fontSize = style?.fontSize ?? Math.round(height * 0.05);
  const margin = Math.round(height * (style?.marginRatio ?? 0.06));

  const justify =
    position === "top" ? "flex-start" : position === "center" ? "center" : "flex-end";

  return (
    <AbsoluteFill
      style={{
        justifyContent: justify,
        alignItems: "center",
        paddingTop: position === "top" ? margin : 0,
        paddingBottom: position === "bottom" ? margin : 0,
        paddingLeft: Math.round(height * 0.05),
        paddingRight: Math.round(height * 0.05),
      }}
    >
      <div
        style={{
          maxWidth: "100%",
          fontFamily: DEFAULT_FONT,
          fontWeight: 700,
          fontSize,
          lineHeight: 1.3,
          color: style?.color ?? "#FFFFFF",
          background: style?.backgroundColor ?? "rgba(0,0,0,0.55)",
          padding: `${Math.round(fontSize * 0.35)}px ${Math.round(fontSize * 0.7)}px`,
          borderRadius: Math.round(fontSize * 0.15),
          textAlign: "center",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          textShadow: "0 2px 6px rgba(0,0,0,0.6)",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

// ========== 主组件 ==========

const AudioSubtitleVideo = ({
  videoSrc,
  segments,
  videoVolume = 1,
  ttsVolume = 1,
  subtitle,
}: AudioSubtitleVideoProps) => {
  const { fps, height } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* 底图视频整段铺底，保留原声（volume 可调） */}
      {videoSrc ? (
        <OffthreadVideo
          src={resolveSrc(videoSrc)}
          volume={videoVolume}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : null}

      {/* 每条片段：音频与字幕共用同一 Sequence，起点/时长一致，天然对齐 */}
      {segments.map((seg, i) => {
        const from = Math.max(0, Math.round(seg.start * fps));
        const dur = Math.max(1, Math.round((seg.end - seg.start) * fps));
        return (
          <Sequence key={`seg-${seg.index}-${i}`} from={from} durationInFrames={dur}>
            {seg.audioSrc ? (
              <Audio src={resolveSrc(seg.audioSrc)} volume={ttsVolume} />
            ) : null}
            {seg.text ? (
              <SubtitleBox text={seg.text} height={height} style={subtitle} />
            ) : null}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

// ========== 动态元数据 ==========

export const calculateInsertMetadata: CalculateMetadataFunction<
  AudioSubtitleVideoProps
> = ({ props }) => {
  return {
    durationInFrames: Math.max(1, Math.round(props.durationInFrames ?? 1)),
    fps: props.fps && props.fps > 0 ? props.fps : 30,
    width: props.width && props.width > 0 ? props.width : 1280,
    height: props.height && props.height > 0 ? props.height : 720,
  };
};

export default AudioSubtitleVideo;
