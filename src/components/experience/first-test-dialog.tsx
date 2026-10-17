"use client";

import { Dialog } from "radix-ui";
import { ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/primitives";
import { describeError } from "@/lib/adapters/types";
import { useHub } from "@/lib/hub/hub-store";
import { useT } from "@/lib/i18n";

/**
 * Explicit first-test acknowledgement before SE7ENX may switch a real device
 * (same hub call as the device card: controlEnabled + acknowledgeRealControl). Nothing is switched here.
 */
export function FirstTestDialog({
  deviceId,
  deviceName,
  open,
  onOpenChange,
}: {
  deviceId: string;
  deviceName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t, dir } = useT();
  const patch = useHub((s) => s.patch);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setAck(false);
          setError(null);
        }
        onOpenChange(v);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-950/70 backdrop-blur-sm" />
        <Dialog.Content
          dir={dir}
          className="fixed inset-x-3 top-[12vh] z-50 mx-auto max-w-md rounded-2xl border border-warn/40 bg-ink-900 p-5 shadow-2xl focus:outline-none"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-ink-50">
              <ShieldAlert className="h-4 w-4 text-warn" aria-hidden />
              {t("connect.firstTest.title")}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t("common.close")}>
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-1 text-sm font-medium text-ink-100" dir="auto">
            {deviceName}
          </Dialog.Description>
          <p className="mb-4 text-sm leading-relaxed text-ink-200">{t("connect.firstTest.body")}</p>
          <Checkbox id={`ack-${deviceId}`} checked={ack} onCheckedChange={setAck}>
            {t("connect.firstTest.confirm")}
          </Checkbox>
          {error ? (
            <p className="mt-3 text-xs text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm">
                {t("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button
              variant="primary"
              size="sm"
              disabled={!ack || busy}
              data-testid="first-test-confirm"
              onClick={() => {
                setBusy(true);
                setError(null);
                void patch(deviceId, { controlEnabled: true, acknowledgeRealControl: true })
                  .then(() => onOpenChange(false))
                  .catch((err) => setError(describeError(err).message))
                  .finally(() => setBusy(false));
              }}
            >
              {t("experience.enableControlAction")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
