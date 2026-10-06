import React from "react";
import {
  Composition,
  AbsoluteFill,
  Audio,
  staticFile,
  type CalculateMetadataFunction,
} from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade as fadeTransition } from "@remotion/transitions/fade";
import { KenBurnsImage, type CameraConfig } from "./KenBurnsImage";
import { VideoClip } from "./VideoClip";
import AudioSubtitleVideo, {
  calculateInsertMetadata,
} from "./AudioSubtitleVideo";

// ========== 类型定义 ==========

/** 片段类型 */
export type SlideType = "image" | "video";

/** 单个片段配置（图片或视频） */
export type SlideConfig = {
  src: string;
  /** 片段类型，不传按图片处理 */
  type?: SlideType;
  /**
   * 该片段显示时长（帧）。
   * 图片：不传则回退全局 durationPerImage；
   * 视频：超出素材可用长度的部分以黑帧补足。
   */
  durationInFrames?: number;
  /** 仅视频：素材可用帧数（已扣除 trimStartSeconds） */
  sourceFrames?: number;
  /** 仅视频：从素材第几秒开始播放 */
  trimStartSeconds?: number;
  /** 仅视频：原声音量，默认 0（静音） */
  volume?: number;
  /** 运镜效果，仅图片生效 */
  camera?: CameraConfig;
};

/** 音轨配置 */
type AudioTrack = {
  src: string;
  volume?: number;
  startFrom?: number;
};

/** 转场类型 */
type TransitionType = "fade" | "slide" | "wipe" | "none";

// ========== 工具函数 ==========

const resolveSrc = (path: string) => {
  if (!path) return "";
  return path.startsWith("http://") || path.startsWith("https://")
    ? path
    : staticFile(path);
};

/** 将 images 或 slides 统一归一化为 SlideConfig[] */
function normalizeSlides(
  images?: string[],
  slides?: SlideConfig[]
): SlideConfig[] {
  if (slides && slides.length > 0) return slides;
  if (images && images.length > 0) return images.map((src) => ({ src }));
  return [];
}

// ========== SlideVideo 组件 ==========

export type SlideVideoProps = {
  /** 图片 URL 数组（简单模式，与 slides 二选一） */
  images?: string[];
  /** 幻灯片配置数组（高级模式，与 images 二选一） */
  slides?: SlideConfig[];
  /** 单音频（向下兼容） */
  audioUrl?: string;
  /** 多音轨 */
  audioTracks?: AudioTrack[];
  /** 每张图片的默认持续帧数（不含转场），可被 slides[].durationInFrames 覆盖，默认 90 */
  durationPerImage: number;
  /** 转场类型，默认 "fade" */
  transition?: TransitionType;
  /** 转场持续帧数，默认 15 */
  transitionDuration?: number;
  /** 全局默认运镜 */
  camera?: CameraConfig;
  /** 成片帧率，默认 30（含视频时由第一段视频的帧率决定） */
  fps?: number;
  /** 成片画布宽，默认 1280（含视频时由第一段视频的宽度决定） */
  width?: number;
  /** 成片画布高，默认 720（含视频时由第一段视频的高度决定） */
  height?: number;
};

const SlideVideo = ({
  images,
  slides,
  audioUrl,
  audioTracks,
  durationPerImage,
  transition = "fade",
  transitionDuration = 15,
  camera,
}: SlideVideoProps) => {
  const slideList = normalizeSlides(images, slides);

  // 每段最终时长：显式 durationInFrames 优先，图片回退全局 durationPerImage
  const durations = slideList.map((s) =>
    Math.max(1, Math.round(s.durationInFrames ?? durationPerImage))
  );

  // 转场时长按相邻两段取 min，避免某段短于转场导致 TransitionSeries 报错
  const transitions = durations.map((d, i) => {
    if (transition === "none" || i === durations.length - 1) return 0;
    return Math.max(0, Math.min(transitionDuration, d, durations[i + 1]));
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* 音频 */}
      {audioTracks?.map((track, i) => {
        const resolved = resolveSrc(track.src);
        if (!resolved) return null;
        return (
          <Audio
            key={`audio-${i}`}
            src={resolved}
            volume={track.volume ?? 1}
          />
        );
      })}
      {!audioTracks && audioUrl ? (
        <Audio src={resolveSrc(audioUrl)} />
      ) : null}

      {/* 幻灯片 + 转场 */}
      <TransitionSeries>
        {slideList.flatMap((slide, idx) => {
          const isLast = idx === slideList.length - 1;
          const mergedCamera = slide.camera ?? camera;
          const dur = durations[idx];
          const trans = transitions[idx];
          const items: React.ReactNode[] = [];

          // 画面 Sequence
          items.push(
            <TransitionSeries.Sequence
              key={`seq-${idx}`}
              durationInFrames={dur}
            >
              {slide.type === "video" ? (
                <VideoClip
                  src={slide.src}
                  durationInFrames={dur}
                  sourceFrames={slide.sourceFrames ?? dur}
                  trimStartSeconds={slide.trimStartSeconds}
                  volume={slide.volume ?? 0}
                />
              ) : (
                <KenBurnsImage
                  src={slide.src}
                  camera={mergedCamera}
                  durationInFrames={dur}
                />
              )}
            </TransitionSeries.Sequence>
          );

          // 转场（最后一张后面不加）
          if (!isLast && trans > 0) {
            items.push(
              <TransitionSeries.Transition
                key={`trans-${idx}`}
                presentation={fadeTransition()}
                timing={linearTiming({ durationInFrames: trans })}
              />
            );
          }

          return items;
        })}
      </TransitionSeries>
    </AbsoluteFill>
  );
};

// ========== 动态计算视频总时长 ==========

const calculateMetadata: CalculateMetadataFunction<SlideVideoProps> = ({
  props,
}) => {
  const slideList = normalizeSlides(props.images, props.slides);
  const durationPerImage = props.durationPerImage || 90;
  const transitionDuration = props.transitionDuration ?? 15;

  // 每段时长（与渲染时的口径保持一致）
  const durations = slideList.map((s) =>
    Math.max(1, Math.round(s.durationInFrames ?? durationPerImage))
  );

  // 总帧数 = 各段时长之和 − 各转场时长之和
  // TransitionSeries 中转场与前后序列重叠，不额外增加时长；转场按相邻两段取 min
  let totalFrames = durations.reduce((sum, d) => sum + d, 0);
  if (props.transition !== "none") {
    for (let i = 0; i < durations.length - 1; i++) {
      totalFrames -= Math.max(
        0,
        Math.min(transitionDuration, durations[i], durations[i + 1])
      );
    }
  }

  const durationInFrames = Math.max(totalFrames, 1);

  return {
    durationInFrames,
    fps: props.fps && props.fps > 0 ? props.fps : 30,
    width: props.width && props.width > 0 ? props.width : 1280,
    height: props.height && props.height > 0 ? props.height : 720,
  };
};

// ========== 根组件 ==========

export const Root = () => {
  return (
    <>
      <Composition
        id="SlideVideo"
        component={SlideVideo}
        width={1280}
        height={720}
        fps={30}
        durationInFrames={1}
        defaultProps={{
          images: [],
          audioUrl: "",
          durationPerImage: 90,
          transition: "fade",
          transitionDuration: 15,
        }}
        calculateMetadata={calculateMetadata}
      />

      <Composition
        id="AudioSubtitleVideo"
        component={AudioSubtitleVideo}
        width={1280}
        height={720}
        fps={30}
        durationInFrames={1}
        defaultProps={{
          videoSrc: "",
          segments: [],
          durationInFrames: 1,
          fps: 30,
          width: 1280,
          height: 720,
        }}
        calculateMetadata={calculateInsertMetadata}
      />
    </>
  );
};
