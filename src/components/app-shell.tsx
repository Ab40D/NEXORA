"use client";

import { Boxes, History, Mic, SlidersHorizontal, Hand } from "lucide-react";
import { useEffect } from "react";
import { Header } from "@/components/header";
import { DevicesPanel } from "@/components/hub/devices-panel";
import { LampStage } from "@/components/lamp/lamp-stage";
import { ControlPanel } from "@/components/panels/control-panel";
import { GesturePanel } from "@/components/panels/gesture-panel";
import { HistoryPanel } from "@/components/panels/history-panel";
import { VoicePanel } from "@/components/panels/voice-panel";
import { StateStrip } from "@/components/status/state-strip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/primitives";
import { ConnectionWizard } from "@/components/wizard/connection-wizard";
import { useGestureStore } from "@/lib/gesture/gesture-store";
import { useAppStore } from "@/lib/state/store";
import { useUi, type PanelTab } from "@/lib/state/ui-store";
import { initVoiceSupport, stopListening, useVoiceStore } from "@/lib/voice/voice-controller";

export function AppShell() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const paused = useAppStore((s) => s.light.dispatchPaused);
  const historyCount = useAppStore((s) => s.light.history.length);
  const cameraRunning = useGestureStore((s) => s.cameraStatus === "running");
  const listening = useVoiceStore((s) => s.listening);

  useEffect(() => {
    initVoiceSupport();
  }, []);

  // Emergency stop also ends any active listening session immediately.
  useEffect(() => {
    if (paused) stopListening();
  }, [paused]);

  // Esc = emergency stop for hands-free control; stop listening when the tab is hidden.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (useUi.getState().wizardOpen) return; // Esc closes the dialog instead
      const s = useAppStore.getState();
      if (!s.light.dispatchPaused) s.setPaused(true);
    };
    const onVis = () => {
      if (document.hidden) stopListening();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#controls" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-ink-950">
        Skip to controls
      </a>
      <Header />
      <main className="mx-auto grid w-full max-w-[1440px] flex-1 gap-4 px-3 py-4 sm:px-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(360px,1fr)] lg:gap-5">
        <div className="space-y-3 lg:sticky lg:top-[4.5rem] lg:self-start">
          <LampStage />
          <StateStrip />
        </div>

        <div id="controls" className="min-w-0">
          <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="space-y-4">
            <TabsList className="sticky top-[3.75rem] z-30 lg:static">
              <TabsTrigger value="control">
                <SlidersHorizontal className="h-4 w-4" aria-hidden />
                Control
              </TabsTrigger>
              <TabsTrigger value="gesture" badge={cameraRunning ? <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-label="camera on" /> : null}>
                <Hand className="h-4 w-4" aria-hidden />
                Gesture
              </TabsTrigger>
              <TabsTrigger value="voice" badge={listening ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" aria-label="listening" /> : null}>
                <Mic className="h-4 w-4" aria-hidden />
                Voice
              </TabsTrigger>
              <TabsTrigger value="devices">
                <Boxes className="h-4 w-4" aria-hidden />
                Devices
              </TabsTrigger>
              <TabsTrigger value="history" badge={historyCount ? <span className="font-mono text-[10px] text-ink-400">{Math.min(historyCount, 99)}</span> : null}>
                <History className="h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">History</span>
                <span className="sm:hidden">Log</span>
              </TabsTrigger>
            </TabsList>
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
          </Tabs>
        </div>
      </main>
      <footer className="mx-auto w-full max-w-[1440px] px-4 pb-6 pt-2 text-[11px] leading-relaxed text-ink-400 sm:px-5">
        SE7ENX Smart Light Experience · Camera frames are processed on your device and never uploaded · Real KNX commands are only reported as
        successful when the backend confirms them · Simulation never controls hardware.
      </footer>
      <ConnectionWizard />
    </div>
  );
}
