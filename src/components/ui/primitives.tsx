"use client";

import { Checkbox as RCheckbox, Slider as RSlider, Switch as RSwitch, Tabs as RTabs } from "radix-ui";
import { Check } from "lucide-react";
import { forwardRef, type HTMLAttributes, type InputHTMLAttributes, type LabelHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- Card */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-ink-700/80 bg-ink-850/80 shadow-[var(--shadow-panel)] backdrop-blur-sm",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ title, subtitle, icon, actions, className }: { title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-4 pt-4 sm:px-5 sm:pt-5", className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon ? <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ink-700/80 text-accent">{icon}</div> : null}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-wide text-ink-50">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs leading-relaxed text-ink-300">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Badge */
type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "sim";
const toneClass: Record<Tone, string> = {
  neutral: "border-ink-500/70 bg-ink-750 text-ink-200",
  accent: "border-accent/40 bg-accent/10 text-accent",
  ok: "border-ok/40 bg-ok/10 text-ok",
  warn: "border-warn/40 bg-warn/10 text-warn",
  danger: "border-danger/50 bg-danger/10 text-danger",
  sim: "border-sim/50 bg-sim/10 text-sim",
};

export function Badge({ tone = "neutral", className, children, dot }: { tone?: Tone; className?: string; children: ReactNode; dot?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]",
        toneClass[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- Callout */
export function Callout({ tone = "neutral", title, children, icon, className, role }: { tone?: Tone; title?: ReactNode; children?: ReactNode; icon?: ReactNode; className?: string; role?: "alert" | "status" }) {
  const border: Record<Tone, string> = {
    neutral: "border-ink-600 bg-ink-800/80",
    accent: "border-accent/30 bg-accent/[0.06]",
    ok: "border-ok/30 bg-ok/[0.06]",
    warn: "border-warn/40 bg-warn/[0.07]",
    danger: "border-danger/45 bg-danger/[0.08]",
    sim: "border-sim/40 bg-sim/[0.07]",
  };
  const text: Record<Tone, string> = {
    neutral: "text-ink-200",
    accent: "text-accent",
    ok: "text-ok",
    warn: "text-warn",
    danger: "text-danger",
    sim: "text-sim",
  };
  return (
    <div role={role} className={cn("flex gap-3 rounded-xl border p-3 text-sm", border[tone], className)}>
      {icon ? <div className={cn("mt-0.5 shrink-0", text[tone])}>{icon}</div> : null}
      <div className="min-w-0 space-y-1">
        {title ? <p className={cn("font-semibold", text[tone])}>{title}</p> : null}
        {children ? <div className="leading-relaxed text-ink-200">{children}</div> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Form */
export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-xs font-semibold uppercase tracking-[0.08em] text-ink-300", className)} {...props} />;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "h-11 w-full rounded-xl border bg-ink-900/80 px-3.5 text-sm text-ink-50 placeholder:text-ink-400 transition-colors focus-visible:border-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
        invalid ? "border-danger/70" : "border-ink-600",
        className,
      )}
      {...props}
    />
  );
});

export function FieldHint({ id, children, tone = "muted" }: { id?: string; children: ReactNode; tone?: "muted" | "error" | "ok" }) {
  return (
    <p id={id} className={cn("text-xs leading-relaxed", tone === "error" ? "text-danger" : tone === "ok" ? "text-ok" : "text-ink-300")}>
      {children}
    </p>
  );
}

/* ---------------------------------------------------------------- Switch */
export function Switch({ checked, onCheckedChange, label, description, disabled, id }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean; id: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-ink-100">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs leading-relaxed text-ink-300">{description}</p> : null}
      </div>
      <RSwitch.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full border border-ink-500 bg-ink-700 transition-colors data-[state=checked]:border-accent/70 data-[state=checked]:bg-accent/80 disabled:opacity-40"
      >
        <RSwitch.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-ink-100 shadow transition-transform data-[state=checked]:translate-x-[21px] data-[state=checked]:bg-white" />
      </RSwitch.Root>
    </div>
  );
}

/* ---------------------------------------------------------------- Checkbox */
export function Checkbox({ checked, onCheckedChange, id, children }: { checked: boolean; onCheckedChange: (v: boolean) => void; id: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <RCheckbox.Root
        id={id}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border border-ink-400 bg-ink-900 data-[state=checked]:border-warn data-[state=checked]:bg-warn"
      >
        <RCheckbox.Indicator>
          <Check className="h-3.5 w-3.5 text-ink-950" strokeWidth={3} />
        </RCheckbox.Indicator>
      </RCheckbox.Root>
      <label htmlFor={id} className="text-sm leading-relaxed text-ink-200">
        {children}
      </label>
    </div>
  );
}

/* ---------------------------------------------------------------- Slider */
export function Slider({ label, value, min, max, step, onChange, format, id, description }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string; id: string; description?: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span id={`${id}-label`} className="text-sm font-medium text-ink-100">
          {label}
        </span>
        <span className="font-mono text-xs tabular-nums text-accent">{format ? format(value) : value}</span>
      </div>
      <RSlider.Root
        aria-labelledby={`${id}-label`}
        className="relative flex h-5 w-full touch-none select-none items-center"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => v[0] !== undefined && onChange(v[0])}
      >
        <RSlider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-ink-600">
          <RSlider.Range className="absolute h-full rounded-full bg-gradient-to-r from-accent-blue to-accent" />
        </RSlider.Track>
        <RSlider.Thumb
          aria-label={label}
          className="block h-5 w-5 rounded-full border-2 border-accent bg-ink-950 shadow-[0_0_12px_rgb(56_217_245/0.5)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/30"
        />
      </RSlider.Root>
      {description ? <p className="text-xs text-ink-300">{description}</p> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Tabs */
export const Tabs = RTabs.Root;
export const TabsContent = forwardRef<HTMLDivElement, RTabs.TabsContentProps>(function TabsContent({ className, ...props }, ref) {
  return <RTabs.Content ref={ref} className={cn("animate-fade-in focus-visible:outline-none", className)} {...props} />;
});

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    // Scrolls horizontally when there are more tabs than room (account workspaces add tabs); never squeezes labels.
    <RTabs.List className={cn("flex gap-1 overflow-x-auto rounded-xl border border-ink-700 bg-ink-900/80 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
      {children}
    </RTabs.List>
  );
}

export function TabsTrigger({ value, children, badge }: { value: string; children: ReactNode; badge?: ReactNode }) {
  return (
    <RTabs.Trigger
      value={value}
      className="relative inline-flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-2 text-xs font-semibold text-ink-300 transition-colors hover:text-ink-100 data-[state=active]:bg-ink-700 data-[state=active]:text-white data-[state=active]:shadow-[inset_0_-2px_0_0_var(--color-accent)] sm:text-sm"
    >
      {children}
      {badge}
    </RTabs.Trigger>
  );
}

/* ---------------------------------------------------------------- KeyValue */
export function KeyValue({ label, value, mono, className }: { label: ReactNode; value: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">{label}</dt>
      <dd className={cn("mt-0.5 truncate text-sm text-ink-100", mono && "font-mono")}>{value}</dd>
    </div>
  );
}
