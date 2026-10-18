"use client";

import { Boxes, Building2, Cable, History, Lightbulb, Mic, ScrollText, Settings, SlidersHorizontal, Hand } from "lucide-react";
import { Direction } from "radix-ui";
import { useEffect } from "react";
import { ActivityPanel } from "@/components/activity/activity-panel";
import { AuthBoot, AuthDialog, AuthGate, GuestBanner } from "@/components/auth/auth-gate";
import { BuildingPanel } from "@/components/building/building-panel";
import { ConnectWorkspace } from "@/components/experience/connect-workspace";
import { ExperiencePanel } from "@/components/experience/experience-panel";
import { WelcomeIntro } from "@/components/experience/welcome-intro";
import { Header } from "@/components/header";
import { DevicesPanel } from "@/components/hub/devices-panel";
import { LampStage } from "@/components/lamp/lamp-stage";
import { ControlPanel } from "@/components/panels/control-panel";
import { GesturePanel } from "@/components/panels/gesture-panel";
import { HistoryPanel } from "@/components/panels/history-panel";
import { VoicePanel } from "@/components/panels/voice-panel";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { StateStrip } from "@/components/status/state-strip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/primitives";
import { ConnectionWizard } from "@/components/wizard/connection-wizard";
import { useConversation } from "@/lib/assistant/conversation";
import { useAuth } from "@/lib/core/auth-store";
import { useExperience } from "@/lib/experience/store";
import { useGestureStore } from "@/lib/gesture/gesture-store";
import { I18nDocumentSync, useT } from "@/lib/i18n";
import { useAppStore } from "@/lib/state/store";
import { initIntro, useUi, type PanelTab } from "@/lib/state/ui-store";
import { initVoiceSupport, stopListening, useVoiceStore } from "@/lib/voice/voice-controller";

export function AppShell() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const paused = useAppStore((s) => s.light.dispatchPaused);
  const historyCount = useAppStore((s) => s.light.history.length);
  const cameraRunning = useGestureStore((s) => s.cameraStatus === "running");
  const listening = useVoiceStore((s) => s.listening);
  const chatListening = useConversation((s) => s.listening);
  const { t, dir } = useT();
  const signedIn = useAuth((s) => s.status === "signed_in");
  const perms = useAuth((s) => s.me?.permissions);
  const canBuilding = signedIn && (perms?.includes("building.view") ?? false);
  const canAudit = signedIn && (perms?.includes("audit.view") ?? false);

  // Account workspaces disappear on sign-out: fall back to the experience view.
  useEffect(() => {
    if ((tab === "building" && !canBuilding) || (tab === "activity" && !canAudit) || (tab === "settings" && !signedIn)) setTab("experience");
  }, [tab, canBuilding, canAudit, signedIn, setTab]);

  useEffect(() => {
    initVoiceSupport();
    // persisted UI state is applied after hydration so server and client markup match
    void useExperience.persist.rehydrate();
    initIntro();
  }, []);

  // Emergency stop also ends any active listening session immediately.
  useEffect(() => {
    if (paused) {
      stopListening();
      useConversation.getState().stopListening();
    }
  }, [paused]);

  // Esc = emergency stop for hands-free control; stop listening when the tab is hidden.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const ui = useUi.getState();
      if (ui.wizardOpen || ui.introOpen) return; // Esc closes the dialog / skips the intro instead
      const s = useAppStore.getState();
      if (!s.light.dispatchPaused) s.setPaused(true);
    };
    const onVis = () => {
      if (document.hidden) {
        stopListening();
        useConversation.getState().stopListening();
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    // Radix primitives set an explicit dir attribute; the provider keeps them in the UI direction.
    <Direction.Provider dir={dir}>
      <AuthBoot />
      <I18nDocumentSync />
      <AuthGate>
      <div className="flex min-h-dvh flex-col">
        <a
          href="#controls"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-ink-950"
        >
          {t("shell.skip")}
        </a>
        <Header />
        <GuestBanner />
        <main className="mx-auto grid w-full max-w-[1440px] flex-1 gap-4 px-3 py-4 sm:px-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(360px,1fr)] lg:gap-5">
          <div className="space-y-3 lg:sticky lg:top-[4.5rem] lg:self-start">
            <LampStage />
            <StateStrip />
          </div>

          <div id="controls" className="min-w-0">
            <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="space-y-4">
              <TabsList className="sticky top-[3.75rem] z-30 lg:static">
                <TabsTrigger
                  value="experience"
                  badge={chatListening ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" aria-label={t("tabs.listening")} /> : null}
                >
                  <Lightbulb className="h-4 w-4" aria-hidden />
                  {t("tabs.experience")}
                </TabsTrigger>
                {canBuilding ? (
                  <TabsTrigger value="building">
                    <Building2 className="h-4 w-4" aria-hidden />
                    {t("tabs.building")}
                  </TabsTrigger>
                ) : null}
                <TabsTrigger value="connect">
                  <Cable className="h-4 w-4" aria-hidden />
                  {t("tabs.connect")}
                </TabsTrigger>
                <TabsTrigger value="gesture" badge={cameraRunning ? <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-label={t("tabs.cameraOn")} /> : null}>
                  <Hand className="h-4 w-4" aria-hidden />
                  {t("tabs.gesture")}
                </TabsTrigger>
                <TabsTrigger
                  value="voice"
                  badge={listening ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" aria-label={t("tabs.listening")} /> : null}
                >
                  <Mic className="h-4 w-4" aria-hidden />
                  {t("tabs.voice")}
                </TabsTrigger>
                <TabsTrigger value="devices">
                  <Boxes className="h-4 w-4" aria-hidden />
                  {t("tabs.devices")}
                </TabsTrigger>
                <TabsTrigger
                  value="history"
                  badge={historyCount ? <span className="font-mono text-[10px] text-ink-400">{Math.min(historyCount, 99)}</span> : null}
                >
                  <History className="h-4 w-4" aria-hidden />
                  <span className="hidden sm:inline">{t("tabs.history")}</span>
                  <span className="sm:hidden">{t("tabs.historyShort")}</span>
                </TabsTrigger>
                {canAudit ? (
                  <TabsTrigger value="activity">
                    <ScrollText className="h-4 w-4" aria-hidden />
                    {t("tabs.activity")}
                  </TabsTrigger>
                ) : null}
                {signedIn ? (
                  <TabsTrigger value="settings">
                    <Settings className="h-4 w-4" aria-hidden />
                    {t("tabs.settings")}
                  </TabsTrigger>
                ) : null}
                <TabsTrigger value="control">
                  <SlidersHorizontal className="h-4 w-4" aria-hidden />
                  {t("tabs.control")}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="experience">
                <ExperiencePanel />
              </TabsContent>
              <TabsContent value="connect">
                <ConnectWorkspace />
              </TabsContent>
              <TabsContent value="control">
                <ControlPanel />
              </TabsContent>
              <TabsContent value="gesture">
                <GesturePanel />
              </TabsContent>
              <TabsContent value="voice">
                <VoicePanel />
              </TabsContent>
              <TabsContent value="devices">
                <DevicesPanel />
              </TabsContent>
              <TabsContent value="history">
                <HistoryPanel />
              </TabsContent>
              <TabsContent value="building">{canBuilding ? <BuildingPanel /> : null}</TabsContent>
              <TabsContent value="activity">{canAudit ? <ActivityPanel /> : null}</TabsContent>
              <TabsContent value="settings">{signedIn ? <SettingsPanel /> : null}</TabsContent>
            </Tabs>
          </div>
        </main>
        <footer className="mx-auto w-full max-w-[1440px] px-4 pb-6 pt-2 text-[11px] leading-relaxed text-ink-400 sm:px-5">
          <p>{t("shell.footer")}</p>
          <button type="button" onClick={() => useUi.getState().openIntro()} className="mt-2 underline-offset-4 hover:text-ink-100 hover:underline sm:hidden">
            {t("intro.replay")}
          </button>
        </footer>
        <ConnectionWizard />
        <WelcomeIntro />
        <AuthDialog />
      </div>
      </AuthGate>
    </Direction.Provider>
  );
}
