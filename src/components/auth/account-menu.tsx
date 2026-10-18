"use client";

import { DropdownMenu } from "radix-ui";
import { LogIn, LogOut, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/core/auth-store";
import { APPLIANCE } from "@/lib/hub/hub-store";
import { useT, type MessageKey } from "@/lib/i18n";
import { useUi } from "@/lib/state/ui-store";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

export function AccountMenu() {
  const status = useAuth((s) => s.status);
  const me = useAuth((s) => s.me);
  const logout = useAuth((s) => s.logout);
  const stopGuest = useAuth((s) => s.stopGuest);
  const openAuth = useUi((s) => s.openAuth);
  const setTab = useUi((s) => s.setTab);
  const { t, dir } = useT();

  if (status === "unknown" || status === "checking" || status === "setup" || status === "pairing") return null;

  if (status !== "signed_in" || !me) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => (APPLIANCE ? stopGuest() : openAuth("signin"))}
        data-testid="account-signin"
        className="h-8"
      >
        <LogIn className="h-3.5 w-3.5" aria-hidden />
        <span className="hidden sm:inline">{t("auth.menu.signIn")}</span>
      </Button>
    );
  }

  return (
    <DropdownMenu.Root dir={dir}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-ink-600 bg-ink-800 text-[11px] font-semibold text-ink-100 hover:border-ink-300"
          aria-label={t("auth.menu.signedInAs", { name: me.user.displayName })}
          data-testid="account-menu"
        >
          {initials(me.user.displayName)}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-[14rem] rounded-xl border border-ink-700 bg-ink-900 p-1.5 text-sm shadow-2xl">
          <div className="px-2.5 py-2">
            <p className="font-medium text-ink-50" dir="auto">
              {me.user.displayName}
            </p>
            <p className="text-xs text-ink-400">
              <bdi dir="ltr">@{me.user.username}</bdi> · {t(`role.${me.user.role}` as MessageKey)}
            </p>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-ink-800" />
          <DropdownMenu.Item
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-ink-100 outline-none data-[highlighted]:bg-ink-800"
            onSelect={() => setTab("settings")}
          >
            <UserRound className="h-4 w-4" aria-hidden />
            {t("auth.menu.account")}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-ink-100 outline-none data-[highlighted]:bg-ink-800"
            onSelect={() => void logout()}
            data-testid="account-signout"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {t("auth.menu.signOut")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
