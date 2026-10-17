import { cn } from "@/lib/utils";

/**
 * Stylised Digital Twin room (inline SVG, no external assets): perspective walls, a sofa and a
 * pendant lamp. `lit` turns the lamp on; `intensity` (0..1) scales the light.
 */
export function TwinRoom({
  lit,
  intensity = 1,
  revealed = true,
  className,
  label,
}: {
  lit: boolean;
  intensity?: number;
  revealed?: boolean;
  className?: string;
  label?: string;
}) {
  const glow = lit ? Math.max(0.15, Math.min(1, intensity)) : 0;
  return (
    <svg
      viewBox="0 0 400 240"
      className={cn("w-full transition-opacity duration-1000", revealed ? "opacity-100" : "opacity-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <radialGradient id="twin-glow" cx="50%" cy="38%" r="60%">
          <stop offset="0" stopColor="#ffd9a8" stopOpacity="0.95" />
          <stop offset="0.35" stopColor="#ffcf99" stopOpacity="0.35" />
          <stop offset="1" stopColor="#ffcf99" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="twin-cone" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe2b8" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffe2b8" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="twin-line" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f8cff" />
          <stop offset="1" stopColor="#38d9f5" />
        </linearGradient>
      </defs>

      {/* room shell */}
      <g fill="none" stroke="url(#twin-line)" strokeOpacity="0.45" strokeWidth="1">
        <polygon points="0,0 400,0 300,44 100,44" fill="#0b0f15" />
        <polygon points="0,0 100,44 100,170 0,240" fill="#090c11" />
        <polygon points="400,0 300,44 300,170 400,240" fill="#090c11" />
        <rect x="100" y="44" width="200" height="126" fill="#0c1118" />
        <polygon points="100,170 300,170 400,240 0,240" fill="#07090d" />
      </g>
      {/* floor grid */}
      <g stroke="#38d9f5" strokeOpacity="0.12" strokeWidth="0.6">
        <line x1="150" y1="170" x2="100" y2="240" />
        <line x1="200" y1="170" x2="200" y2="240" />
        <line x1="250" y1="170" x2="300" y2="240" />
        <line x1="40" y1="200" x2="360" y2="200" />
      </g>
      {/* window on the right wall */}
      <polygon points="330,70 375,52 375,140 330,150" fill="#0d1622" stroke="#4f8cff" strokeOpacity="0.35" strokeWidth="0.8" />

      {/* light: glow, cone, floor pool */}
      <g style={{ opacity: glow, transition: "opacity 900ms ease-out" }}>
        <rect x="0" y="0" width="400" height="240" fill="url(#twin-glow)" />
        <polygon points="186,96 214,96 262,172 138,172" fill="url(#twin-cone)" />
        <ellipse cx="200" cy="186" rx="92" ry="16" fill="#ffd9a8" fillOpacity="0.18" />
      </g>

      {/* sofa + table */}
      <g fill="#121925" stroke="#38d9f5" strokeOpacity="0.3" strokeWidth="0.8">
        <rect x="120" y="150" width="96" height="26" rx="6" />
        <rect x="114" y="140" width="108" height="14" rx="6" />
        <rect x="236" y="164" width="44" height="10" rx="3" />
        <line x1="242" y1="174" x2="242" y2="186" />
        <line x1="274" y1="174" x2="274" y2="186" />
      </g>

      {/* pendant lamp */}
      <line x1="200" y1="44" x2="200" y2="82" stroke="#9fb3c8" strokeOpacity="0.6" strokeWidth="1" />
      <path
        d="M186 96 L192 82 L208 82 L214 96 Z"
        fill={lit ? "#ffe9c7" : "#1a2230"}
        stroke={lit ? "#ffcf99" : "#5b6b80"}
        strokeWidth="1"
        style={{ transition: "fill 700ms" }}
      />
      <circle cx="200" cy="98" r="3.2" fill={lit ? "#fff4e0" : "#2a3444"} style={{ transition: "fill 700ms" }} />
    </svg>
  );
}
