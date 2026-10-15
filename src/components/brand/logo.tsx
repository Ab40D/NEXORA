import { cn } from "@/lib/utils";

/** Original SE7ENX mark: a stylised "7" cut into a hexagonal cell. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={cn("h-8 w-8", className)} aria-hidden>
      <defs>
        <linearGradient id="se7enx-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f8cff" />
          <stop offset="1" stopColor="#38d9f5" />
        </linearGradient>
      </defs>
      <path d="M20 2.5 35.2 11.25v17.5L20 37.5 4.8 28.75v-17.5Z" fill="none" stroke="url(#se7enx-g)" strokeWidth="2" />
      <path d="M12.5 13h15l-7.6 15.5" fill="none" stroke="#e6faff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.2 20.6h7.2" stroke="url(#se7enx-g)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-semibold tracking-[0.28em] text-ink-50", className)}>
      SE<span className="text-accent">7</span>ENX
    </span>
  );
}
