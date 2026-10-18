"use client";

import { Dialog } from "radix-ui";
import { LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { AuthPanel } from "@/components/auth/auth-forms";
import { LogoMark, Wordmark } from "@/components/brand/logo";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/core/auth-store";
import { APPLIANCE } from "@/lib/hub/hub-store";
import { useI18n, useT } from "@/lib/i18n";
import { isLocale } from "@/lib/i18n/core";
import { useUi } from "@/lib/state/ui-store";

/** Starts the auth check once and keeps the account's language preference in sync with the UI. */
export function AuthBoot() {
  useEffect(() => {
    void useAuth.getState().init();
  }, []);

  useEffect(() => {
    // Signed in: adopt the language saved in the account (chosen on another device).
    const unsubAuth = useAuth.subscribe((s, prev) => {
      if (s.status === "signed_in" && prev.status !== "signed_in") {
        const lang = s.me?.preferences.language;
        if (lang && isLocale(lang) && lang !== useI18n.getState().locale) useI18n.getState().setLocale(lang);
        useUi.getState().closeAuth();
      }
    });
    // Language changed while signed in: remember it in the account.
    const unsubLang = useI18n.subscribe((s, prev) => {
      const auth = useAuth.getState();
      if (s.locale !== prev.locale && auth.status === "signed_in" && auth.me?.preferences.language !== s.locale) {
        void auth.updatePreferences({ language: s.locale }).catch(() => undefined);
      }
    });
    return () => {
      unsubAuth();
      unsubLang();
    };
  }, []);
  return null;
}

function FullPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="mb-6 flex w-full max-w-md items-center justify-between">
        <div className="flex items-center gap-2.5">
          <LogoMark />
          <span dir="ltr">
            <Wordmark className="text-base" />
          </span>
        </div>
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-md rounded-2xl border border-ink-700 bg-ink-900/80 p-6 shadow-2xl">{children}</div>
    </div>
  );
}

/**
 * Appliance: the hub's private data needs an account, so the app opens with owner setup (first run) or sign-in.
 * Visitors may explore the simulation as guests instead; that choice is remembered and never nagged about.
 * Remote web app: guests (simulation) by default; signing in to a hub is offered from the header.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const guest = useAuth((s) => s.guest);
  const continueAsGuest = useAuth((s) => s.continueAsGuest);
  const { t } = useT();

  if (!APPLIANCE) return <>{children}</>;

  if (status === "unknown" || status === "checking") {
    return (
      <FullPage>
        <p className="flex items-center gap-2 text-sm text-ink-200" role="status" data-testid="auth-checking">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          {t("auth.checking")}
        </p>
      </FullPage>
    );
  }
  if (status === "setup") {
    return (
      <FullPage>
        <AuthPanel initial="setup" allowGuest={false} />
      </FullPage>
    );
  }
  if ((status === "signed_out" || status === "error") && !guest) {
    return (
      <FullPage>
        {status === "error" ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm text-warn" role="alert">
            <span>{t("auth.unavailable")}</span>
            <Button variant="ghost" size="sm" onClick={() => void useAuth.getState().init()}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              {t("common.retry")}
            </Button>
          </div>
        ) : null}
        <AuthPanel initial="signin" allowGuest onGuest={continueAsGuest} />
      </FullPage>
    );
  }
  return <>{children}</>;
}

/** Shown to appliance guests: what they can and cannot do, and the way back to sign-in. */
export function GuestBanner() {
  const status = useAuth((s) => s.status);
  const guest = useAuth((s) => s.guest);
  const stopGuest = useAuth((s) => s.stopGuest);
  const { t } = useT();
  if (!APPLIANCE || !guest || status === "signed_in") return null;
  return (
    <div role="status" className="border-b border-sim/30 bg-sim/10 px-4 py-1.5 text-center text-xs text-ink-100" data-testid="guest-banner">
      {t("auth.guest.banner")}{" "}
      <button type="button" className="font-medium underline underline-offset-4 hover:text-white" onClick={stopGuest}>
        {t("auth.guest.signIn")}
      </button>
    </div>
  );
}

/** Sign-in as a dialog (remote web app, or a guest deciding to sign in without leaving the page). */
export function AuthDialog() {
  const view = useUi((s) => s.authDialog);
  const close = useUi((s) => s.closeAuth);
  const { t, dir } = useT();
  return (
    <Dialog.Root open={view !== null} onOpenChange={(v) => !v && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-950/70 backdrop-blur-sm" />
        <Dialog.Content dir={dir} className="fixed inset-x-3 top-[8vh] z-50 mx-auto max-h-[84vh] max-w-md overflow-y-auto rounded-2xl border border-ink-700 bg-ink-900 p-5 shadow-2xl focus:outline-none">
          <Dialog.Title className="sr-only">{t("auth.signIn.title")}</Dialog.Title>
          <Dialog.Description className="sr-only">{t("auth.signIn.subtitle")}</Dialog.Description>
          <div className="mb-2 flex justify-end">
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t("common.close")}>
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          {view ? <AuthPanel initial={view} allowGuest={false} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
