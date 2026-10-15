import type { LampView } from "@/lib/state/selectors";
import { cn } from "@/lib/utils";

/**
 * SVG lamp used when WebGL is unavailable (and as the placeholder while the
 * 3D scene loads). Same state semantics as the 3D lamp.
 */
export function LampFallback({ view, className }: { view: LampView; className?: string }) {
  const g = view.lit ? view.intensity : 0;
  const ring = view.pending !== null || view.feedbackMissing;
  return (
    <svg viewBox="0 0 400 420" className={cn("h-full w-full", className)} role="presentation" aria-hidden>
      <defs>
        <radialGradient id="fb-globe" cx="50%" cy="45%" r="55%">
          <stop offset="0" stopColor="#fff3df" stopOpacity={0.15 + g * 0.85} />
          <stop offset="0.45" stopColor="#ffc98a" stopOpacity={0.08 + g * 0.6} />
          <stop offset="1" stopColor="#8aa0b6" stopOpacity={0.12} />
        </radialGradient>
        <radialGradient id="fb-halo" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#ffd6a0" stopOpacity={0.55 * g} />
          <stop offset="1" stopColor="#ffd6a0" stopOpacity={0} />
        </radialGradient>
        <radialGradient id="fb-pool" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#ffcf99" stopOpacity={0.35 * g} />
          <stop offset="1" stopColor="#ffcf99" stopOpacity={0} />
        </radialGradient>
        <linearGradient id="fb-cap" x1="0" x2="1">
          <stop offset="0" stopColor="#151a21" />
          <stop offset="0.5" stopColor="#36404d" />
          <stop offset="1" stopColor="#151a21" />
        </linearGradient>
      </defs>
      <ellipse cx="200" cy="395" rx="150" ry="18" fill="url(#fb-pool)" style={{ transition: "all 600ms ease" }} />
      <rect x="170" y="0" width="60" height="8" rx="3" fill="#1a2029" />
      <line x1="200" y1="8" x2="200" y2="120" stroke="#0d1015" strokeWidth="3" />
      <circle cx="200" cy="215" r="150" fill="url(#fb-halo)" style={{ transition: "all 600ms ease" }} />
      <path d="M186 120h28l26 52h-80z" fill="url(#fb-cap)" />
      <ellipse cx="200" cy="140" rx="15" ry="3" fill="#38d9f5" opacity="0.8" />
      <circle cx="200" cy="230" r="78" fill="url(#fb-globe)" stroke="#9fb3c8" strokeOpacity="0.35" strokeWidth="1.5" style={{ transition: "all 600ms ease" }} />
      <circle cx="200" cy="228" r="16" fill={g > 0 ? "#fff6e8" : "#2a3038"} opacity={0.4 + g * 0.6} style={{ transition: "all 600ms ease" }} />
      <ellipse cx="176" cy="196" rx="18" ry="9" fill="#ffffff" opacity="0.12" transform="rotate(-30 176 196)" />
      {ring ? (
        <circle
          cx="200"
          cy="230"
          r="100"
          fill="none"
          stroke={view.feedbackMissing ? "#f5b84b" : "#38d9f5"}
          strokeWidth="2"
          strokeDasharray="460 170"
          className="origin-center animate-pulse-ring [transform-box:fill-box]"
        />
      ) : null}
    </svg>
  );
}
