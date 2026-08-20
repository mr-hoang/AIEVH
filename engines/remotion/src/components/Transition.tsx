import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

/**
 * Transition giữa hai scene. Mặc định cắt thẳng (fadeInFrames = 0).
 *
 * Crossfade: scene TRƯỚC khai `transitionOverlap` = N frame → scene SAU bắt đầu
 * sớm N frame (Assemble trừ overlap khi cộng dồn `from`) và nằm ĐÈ LÊN scene
 * trước (Sequence render sau nằm trên). Vì vậy fade được đặt ở scene ĐANG VÀO:
 * opacity 0 → 1 trong N frame đầu của nó, lộ dần scene cũ bên dưới ra scene mới.
 */
export const Transition: React.FC<{
  /** = transitionOverlap của scene liền trước (0 = cắt thẳng) */
  fadeInFrames: number;
  children: React.ReactNode;
}> = ({ fadeInFrames, children }) => {
  const frame = useCurrentFrame();

  if (fadeInFrames <= 0) {
    return <AbsoluteFill>{children}</AbsoluteFill>;
  }

  const opacity = interpolate(frame, [0, fadeInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};
