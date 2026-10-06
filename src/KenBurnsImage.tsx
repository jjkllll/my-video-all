import { useCurrentFrame, interpolate, Img, staticFile, Easing } from "remotion";

/** 运镜配置 */
export type CameraConfig = {
  /** 效果类型 */
  effect?:
    | "kenBurnsIn" // 缓慢放大（默认）
    | "kenBurnsOut" // 缓慢缩小
    | "panLeft" // 向左平移
    | "panRight" // 向右平移
    | "panUp" // 向上平移
    | "panDown" // 向下平移
    | "rotate" // 轻微旋转
    | "blurIn" // 模糊入场
    | "none"; // 无效果
  /** 强度 0-1，默认 0.2 */
  intensity?: number;
};

const resolveSrc = (path: string) => {
  if (!path) return "";
  return path.startsWith("http://") || path.startsWith("https://")
    ? path
    : staticFile(path);
};

/**
 * 带 Ken Burns 运镜效果的图片组件。
 * 在 Sequence 内使用，通过 useCurrentFrame() 驱动动画。
 */
export const KenBurnsImage: React.FC<{
  src: string;
  camera?: CameraConfig;
  durationInFrames: number;
}> = ({ src, camera, durationInFrames }) => {
  const frame = useCurrentFrame();
  const intensity = camera?.intensity ?? 0.2;
  const effect = camera?.effect ?? "kenBurnsIn";

  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let rotate = 0;
  let blur = 0;

  switch (effect) {
    case "kenBurnsIn":
      // 从 1.0 缓慢放大到 1.0 + intensity，easeOut 让开始快结束慢
      scale = interpolate(frame, [0, durationInFrames], [1, 1 + intensity], {
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.ease),
      });
      break;

    case "kenBurnsOut":
      // 从 1.0 + intensity 缓慢缩小到 1.0
      scale = interpolate(frame, [0, durationInFrames], [1 + intensity, 1], {
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.ease),
      });
      break;

    case "panLeft": {
      // 从右向左平移，同时稍加缩放防止穿帮
      const maxPan = 200 * intensity;
      scale = 1 + intensity * 0.4;
      translateX = interpolate(frame, [0, durationInFrames], [0, -maxPan], {
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.ease),
      });
      break;
    }

    case "panRight": {
      const maxPan = 200 * intensity;
      scale = 1 + intensity * 0.4;
      translateX = interpolate(frame, [0, durationInFrames], [0, maxPan], {
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.ease),
      });
      break;
    }

    case "panUp": {
      const maxPan = 120 * intensity;
      scale = 1 + intensity * 0.4;
      translateY = interpolate(frame, [0, durationInFrames], [0, -maxPan], {
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.ease),
      });
      break;
    }

    case "panDown": {
      const maxPan = 120 * intensity;
      scale = 1 + intensity * 0.4;
      translateY = interpolate(frame, [0, durationInFrames], [0, maxPan], {
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.ease),
      });
      break;
    }

    case "rotate":
      // 缓慢旋转 intensity * 4 度 + 轻微放大
      scale = 1 + intensity * 0.3;
      rotate = interpolate(frame, [0, durationInFrames], [0, intensity * 4], {
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.ease),
      });
      break;

    case "blurIn":
      // 前 30% 时长从模糊变清晰
      scale = 1 + intensity * 0.1;
      blur = interpolate(
        frame,
        [0, durationInFrames * 0.3],
        [intensity * 20, 0],
        { extrapolateRight: "clamp" }
      );
      break;

    case "none":
    default:
      // 仍轻微放大防边缘闪烁
      scale = 1.02;
      break;
  }

  return (
    <Img
      src={resolveSrc(src)}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        transform: `scale(${scale}) translate(${translateX}px, ${translateY}px) rotate(${rotate}deg)`,
        filter: blur > 0 ? `blur(${blur}px)` : undefined,
      }}
    />
  );
};
