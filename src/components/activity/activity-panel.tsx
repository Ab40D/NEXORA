"use client";

import { RefreshCw, ScrollText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuthErrorText } from "@/components/auth/auth-forms";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Card, CardHeader } from "@/components/ui/primitives";
import { coreClient, toFailure, useAuth, type AuthFailure } from "@/lib/core/auth-store";
import type { AuditEntry } from "@/lib/core/contract";
import { useHub } from "@/lib/hub/hub-store";
import { useT, type MessageKey } from "@/lib/i18n";
import { en } from "@/lib/i18n/messages/en";

const FILTERS = { all: "", device: "device.", auth: "auth.", user: "user.", access: "access." } as const;
type Filter = keyof typeof FILTERS;
const KNOWN_ACTIONS = new Set(Object.keys(en.activity.action));
const KNOWN_OUTCOMES = new Set(Object.keys(en.activity.outcome));
const KNOWN_SOURCES = new Set(Object.keys(en.activity.source));
const OUTCOME_TONE: Record<string, "ok" | "warn" | "danger" | "neutral" | "sim"> = {
  ok: "ok",
  confirmed: "ok",
  accepted: "warn",
  already_satisfied: "neutral",
  simulated: "sim",
  failed: "danger",
  denied: "danger",
};

export function ActivityPanel() {
  const { t, locale } = useT();
  const status = useAuth((s) => s.status);
  const devices = useHub((s) => s.devices);
  const [filter, setFilter] = useState<Filter>("all");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<AuthFailure | null>(null);
  const errorText = useAuthErrorText()(error);

  const load = useCallback(
    (before?: number) => {
      coreClient()
        .audit({ limit: 50, action: FILTERS[filter] || undefined, before })
        .then((page) => {
          setEntries((prev) => (before ? [...prev, ...page.entries] : page.entries));
          setNext(page.next);
          setError(null);
        })
        .catch((e) => setError(toFailure(e)));
    },
    [filter],
  );
  useEffect(() => {
    if (status === "signed_in") load();
  }, [status, load]);

  if (status !== "signed_in") return <Callout tone="neutral">{t("auth.guest.note")}</Callout>;

  const fmt = new Intl.DateTimeFormat(locale === "dz" ? "ar-DZ" : locale, { dateStyle: "short", timeStyle: "medium" });
  const actionText = (a: string) => {
    const key = a.replace(/\./g, "_");
    return KNOWN_ACTIONS.has(key) ? t(`activity.action.${key}` as MessageKey) : a;
  };
  const actorText = (e: AuditEntry) => {
    if (!e.actor.name || e.actor.name === "system") return t("activity.system");
    if (e.actor.name === "unknown account") return t("activity.unknownAccount");
    return e.actor.name;
  };
  const targetText = (e: AuditEntry) => {
    if (!e.target?.id) return null;
    if (e.target.type === "device") return devices[e.target.id]?.name ?? e.target.id;
    return e.target.id;
  };

  return (
    <Card data-testid="activity-panel">
      <CardHeader
        title={t("activity.title")}
        subtitle={t("activity.subtitle")}
        icon={<ScrollText className="h-4 w-4" />}
        actions={
          <Button size="icon" variant="ghost" onClick={() => load()} aria-label={t("activity.refresh")}>
            <RefreshCw className="h-4 w-4" aria-hidden />
          </Button>
        }
      />
      <div className="space-y-3 p-4 pt-0">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("activity.title")}>
          {(Object.keys(FILTERS) as Filter[]).map((f) => (
            <Button key={f} size="sm" variant={f === filter ? "primary" : "ghost"} aria-pressed={f === filter} onClick={() => setFilter(f)}>
              {t(`activity.filter.${f}`)}
            </Button>
          ))}
        </div>
        {errorText ? (
          <p className="text-xs text-danger" role="alert">
            {errorText}
          </p>
        ) : null}
        <ol className="space-y-1.5" data-testid="activity-list">
          {entries.map((e) => {
            const target = targetText(e);
            return (
              <li key={e.id} className="rounded-lg border border-ink-800 px-3 py-2 text-xs" data-action={e.action} data-outcome={e.outcome}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 text-ink-100">
                    <span className="font-medium" dir="auto">
                      {actorText(e)}
                    </span>{" "}
                    {actionText(e.action)}
                    {target ? (
                      <>
                        {" · "}
                        <bdi>{target}</bdi>
                      </>
                    ) : null}
                  </p>
                  <Badge tone={OUTCOME_TONE[e.outcome] ?? "neutral"}>{KNOWN_OUTCOMES.has(e.outcome) ? t(`activity.outcome.${e.outcome}` as MessageKey) : e.outcome}</Badge>
                </div>
                <p className="mt-0.5 text-ink-400">
                  <time dateTime={new Date(e.at * 1000).toISOString()}>{fmt.format(new Date(e.at * 1000))}</time>
                  {" · "}
                  {t("activity.via", { source: KNOWN_SOURCES.has(e.source) ? t(`activity.source.${e.source}` as MessageKey) : e.source })}
                </p>
              </li>
            );
          })}
          {entries.length === 0 && !error ? <li className="text-xs text-ink-400">{t("activity.empty")}</li> : null}
        </ol>
        {next ? (
          <Button size="sm" variant="ghost" onClick={() => load(next)}>
            {t("activity.loadMore")}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
