"use client";

/**
 * Explains why the camera / microphone are unavailable on plain HTTP and how to fix it with the
 * hub's local HTTPS (SE7ENX_TLS=local-ca). Renders nothing in a secure context.
 */
import { Lock } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Callout } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";

interface TlsStatus {
  mode: string;
  caDownload: boolean;
  fingerprintSha256?: string;
}

const noSubscribe = () => () => undefined;

/** window.isSecureContext (true during server rendering, so nothing flashes). */
export function useSecureContext(): boolean {
  return useSyncExternalStore(noSubscribe, () => window.isSecureContext, () => true);
}

export function SecureContextHelp({ feature }: { feature: "camera" | "microphone" }) {
  const { t } = useT();
  const secure = useSecureContext();
  const [tls, setTls] = useState<TlsStatus | null>(null);
  useEffect(() => {
    if (secure) return;
    let alive = true;
    // Same-origin hub (appliance): ask whether local HTTPS is available on its HTTPS port.
    fetch("/api/v1/tls", { credentials: "omit" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: TlsStatus | null) => alive && setTls(j && typeof j.mode === "string" ? j : null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [secure]);
  if (secure) return null;
  const origin = typeof location !== "undefined" ? location.origin : "";
  const httpsBase = typeof location !== "undefined" ? `https://${location.host}` : "https://<hub>:8787";
  return (
    <Callout tone="warn" role="alert" title={t("secure.title", { feature: t(`secure.${feature}`) })} data-testid="secure-context-help">
      <p>{t("secure.why", { url: origin })}</p>
      <ol className="mt-2 list-decimal space-y-1 ps-5">
        <li>
          {t("secure.step1")} <code className="rounded bg-ink-800 px-1">SE7ENX_TLS=local-ca</code>{" "}
          <code className="rounded bg-ink-800 px-1">SE7ENX_TLS_HOSTS={typeof location !== "undefined" ? location.hostname : "<LAN IP>"}</code>
          {tls?.mode === "off" ? <span className="block text-ink-400">{t("secure.hubOff")}</span> : null}
        </li>
        <li>
          {t("secure.step2")} <code className="rounded bg-ink-800 px-1">{httpsBase}/setup/ca</code>
        </li>
        <li>
          {t("secure.step3")} <code className="rounded bg-ink-800 px-1">{httpsBase}/</code>
        </li>
      </ol>
      <p className="mt-2 flex items-center gap-1.5 text-ink-400">
        <Lock className="h-3.5 w-3.5" aria-hidden /> {t("secure.localOnly")}
      </p>
    </Callout>
  );
}
