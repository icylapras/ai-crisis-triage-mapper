"use client";

import { motion } from "motion/react";

const BLUR_PRESETS = {
  softest: 4,
  soft: 8,
  medium: 12,
  strong: 16,
  stronger: 18,
  strongest: 18,
  none: 0,
};

export function GlowEffect({
  className = "",
  style,
  colors = ["#FF5733", "#33FF57", "#3357FF", "#F1C40F"],
  mode = "rotate",
  blur = "medium",
  transition,
  scale = 1,
  duration = 5,
}) {
  const baseTransition = {
    repeat: Infinity,
    duration,
    ease: "linear",
  };

  const animations = {
    rotate: {
      background: [
        `conic-gradient(from 0deg at 50% 50%, ${colors.join(", ")})`,
        `conic-gradient(from 360deg at 50% 50%, ${colors.join(", ")})`,
      ],
      transition: transition ?? baseTransition,
    },
    pulse: {
      background: colors.map(
        (color) =>
          `radial-gradient(circle at 50% 50%, ${color} 0%, transparent 100%)`,
      ),
      scale: [scale, 1.1 * scale, scale],
      opacity: [0.5, 0.8, 0.5],
      transition: transition ?? {
        ...baseTransition,
        repeatType: "mirror",
      },
    },
    breathe: {
      background: colors.map(
        (color) =>
          `radial-gradient(circle at 50% 50%, ${color} 0%, transparent 100%)`,
      ),
      scale: [scale, 1.05 * scale, scale],
      transition: transition ?? {
        ...baseTransition,
        repeatType: "mirror",
      },
    },
    colorShift: {
      background: colors.map((color, index) => {
        const nextColor = colors[(index + 1) % colors.length];
        return `conic-gradient(from 0deg at 50% 50%, ${color} 0%, ${nextColor} 50%, ${color} 100%)`;
      }),
      transition: transition ?? {
        ...baseTransition,
        repeatType: "mirror",
      },
    },
    flowHorizontal: {
      background: colors.map((color, index) => {
        const nextColor = colors[(index + 1) % colors.length];
        return `linear-gradient(to right, ${color}, ${nextColor})`;
      }),
      transition: transition ?? {
        ...baseTransition,
        repeatType: "mirror",
      },
    },
    static: {
      background: `linear-gradient(to right, ${colors.join(", ")})`,
    },
  };

  const blurPixels =
    typeof blur === "number" ? blur : (BLUR_PRESETS[blur] ?? 12);

  return (
    <motion.div
      aria-hidden="true"
      style={{
        ...style,
        "--scale": scale,
        filter: `blur(${blurPixels}px)`,
        transform: `scale(${scale})`,
        willChange: "transform",
        backfaceVisibility: "hidden",
      }}
      animate={animations[mode]}
      className={`glow-effect-layer ${className}`.trim()}
    />
  );
}

export default GlowEffect;
