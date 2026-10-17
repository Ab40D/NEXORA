"use client";

import { Slider as RSlider } from "radix-ui";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Slider that only reports a value when the user releases it (one command per gesture, never a
 * command per pixel). Shared by the device cards and the Smart Light Experience screen.
 */
export function CommitSlider({
  id,
  label,
  value,
  disabled,
  onCommit,
  format,
  dir = "ltr",
  min = 0,
  max = 100,
  hideHeader = false,
}: {
  id: string;
  label: string;
  value: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
  format: (v: number) => string;
  dir?: "ltr" | "rtl";
  min?: number;
  max?: number;
  hideHeader?: boolean;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const shown = local ?? value;
  return (
    <div className="space-y-1.5">
      <div className={cn("flex items-center justify-between text-xs", hideHeader && "sr-only")}>
        <span id={`${id}-label`} className="font-medium text-ink-200">
          {label}
        </span>
        <span className="font-mono tabular-nums text-accent" dir="ltr">
          {format(shown)}
        </span>
      </div>
      <RSlider.Root
        aria-labelledby={`${id}-label`}
        className={cn("relative flex h-6 w-full touch-none select-none items-center", disabled && "opacity-50")}
        value={[shown]}
        min={min}
        max={max}
        step={1}
        dir={dir}
        disabled={disabled}
        onValueChange={(v) => v[0] !== undefined && setLocal(v[0])}
        onValueCommit={(v) => {
          if (v[0] !== undefined) onCommit(v[0]);
          setLocal(null);
        }}
      >
        <RSlider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-ink-600">
          <RSlider.Range className="absolute h-full rounded-full bg-gradient-to-r from-accent-blue to-accent" />
        </RSlider.Track>
        <RSlider.Thumb
          aria-label={label}
          aria-valuetext={format(shown)}
          data-testid={`${id}-thumb`}
          className="block h-5 w-5 rounded-full border-2 border-accent bg-ink-950 shadow-[0_0_12px_rgb(56_217_245/0.45)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/30"
        />
      </RSlider.Root>
    </div>
  );
}
