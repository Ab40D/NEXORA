"use client";

import { Eye, EyeOff, KeyRound, LogIn, ShieldCheck, UserPlus } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Callout, Checkbox, FieldHint, Input, Label } from "@/components/ui/primitives";
import { toFailure, useAuth, type AuthFailure } from "@/lib/core/auth-store";
import { APPLIANCE } from "@/lib/hub/hub-store";
import { useT, type MessageKey } from "@/lib/i18n";
import { en } from "@/lib/i18n/messages/en";

export type AuthView = "setup" | "signin" | "register" | "reset";

const KNOWN_ERRORS = new Set(Object.keys(en.auth.error));
const DEFAULT_HUB = process.env.NEXT_PUBLIC_DEFAULT_BRIDGE_URL ?? "";

/** Localized text for a hub error (falls back to the hub's English message for unknown codes). */
export function useAuthErrorText(): (f: AuthFailure | null) => string | null {
  const { t } = useT();
  return (f) => {
    if (!f) return null;
    if (KNOWN_ERRORS.has(f.code)) return t(`auth.error.${f.code}` as MessageKey);
    return f.message || t("auth.error.generic");
  };
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: "current-password" | "new-password";
  hint?: ReactNode;
  invalid?: boolean;
}) {
  const { t } = useT();
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          spellCheck={false}
          className="pe-10"
          invalid={invalid}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-ink-400 hover:text-ink-100"
          aria-label={show ? t("auth.hidePassword") : t("auth.showPassword")}
          aria-pressed={show}
        >
          {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      {hint ? <FieldHint id={`${id}-hint`}>{hint}</FieldHint> : null}
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  hint,
  autoComplete,
  dirLtr,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  autoComplete?: string;
  dirLtr?: boolean;
  type?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        dir={dirLtr ? "ltr" : undefined}
        spellCheck={false}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? <FieldHint id={`${id}-hint`}>{hint}</FieldHint> : null}
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);
  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(toFailure(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function ErrorBox({ error }: { error: AuthFailure | null }) {
  const text = useAuthErrorText()(error);
  if (!text) return null;
  return (
    <Callout tone="danger" role="alert">
      <span data-testid="auth-error" data-code={error?.code}>
        {text}
      </span>
    </Callout>
  );
}

function RememberBox({ id, value, onChange }: { id: string; value: boolean; onChange: (v: boolean) => void }) {
  const { t } = useT();
  return (
    <div className="space-y-1">
      <Checkbox id={id} checked={value} onCheckedChange={onChange}>
        {t("auth.remember")}
      </Checkbox>
      <FieldHint>{t("auth.rememberHint")}</FieldHint>
    </div>
  );
}

function NewPasswordFields({ password, setPassword, confirm, setConfirm }: { password: string; setPassword: (v: string) => void; confirm: string; setConfirm: (v: string) => void }) {
  const { t } = useT();
  const id = useId();
  const min = useAuth((s) => s.passwordMinLength);
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <>
      <PasswordField id={`${id}-pw`} label={t("auth.password")} value={password} onChange={setPassword} autoComplete="new-password" hint={t("auth.passwordHint", { min })} />
      <PasswordField id={`${id}-pw2`} label={t("auth.confirm")} value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={mismatch} hint={mismatch ? t("auth.mismatch") : undefined} />
    </>
  );
}

export function SetupForm() {
  const { t } = useT();
  const setup = useAuth((s) => s.setup);
  const { busy, error, run } = useSubmit();
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(false);
  const ready = code.trim().length >= 4 && username.trim() && name.trim() && password.length > 0 && password === confirm;
  return (
    <form className="space-y-4" onSubmit={run(() => setup({ setupCode: code, username, displayName: name, email, password, remember }))} data-testid="setup-form">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold text-ink-50">
          <ShieldCheck className="h-5 w-5 text-accent" aria-hidden />
          {t("auth.setup.title")}
        </h1>
        <p className="mt-1 text-sm text-ink-300">{t("auth.setup.subtitle")}</p>
      </div>
      <Field id="setup-code" label={t("auth.setup.code")} value={code} onChange={setCode} dirLtr autoComplete="one-time-code" hint={t("auth.setup.codeHint", { command: "docker compose logs se7enx" })} />
      <Field id="setup-name" label={t("auth.displayName")} value={name} onChange={setName} autoComplete="name" />
      <Field id="setup-username" label={t("auth.username")} value={username} onChange={setUsername} dirLtr autoComplete="username" hint={t("auth.usernameHint")} />
      <Field id="setup-email" label={t("auth.email")} value={email} onChange={setEmail} dirLtr type="email" autoComplete="email" />
      <NewPasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
      <RememberBox id="setup-remember" value={remember} onChange={setRemember} />
      <ErrorBox error={error} />
      <Button type="submit" variant="primary" className="w-full" disabled={!ready || busy} data-testid="setup-submit">
        <ShieldCheck className="h-4 w-4" aria-hidden />
        {busy ? t("common.loading") : t("auth.setup.submit")}
      </Button>
    </form>
  );
}

export function SignInForm({ onView, allowGuest, onGuest }: { onView: (v: AuthView) => void; allowGuest: boolean; onGuest?: () => void }) {
  const { t } = useT();
  const login = useAuth((s) => s.login);
  const registration = useAuth((s) => s.registration);
  const storedHub = useAuth((s) => s.hubUrl);
  const { busy, error, run } = useSubmit();
  const [hubUrl, setHubUrl] = useState(storedHub ?? DEFAULT_HUB);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  return (
    <form className="space-y-4" onSubmit={run(() => login({ login: user, password, remember, hubUrl: hubUrl.trim() || undefined }))} data-testid="signin-form">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold text-ink-50">
          <LogIn className="h-5 w-5 text-accent" aria-hidden />
          {t("auth.signIn.title")}
        </h1>
        <p className="mt-1 text-sm text-ink-300">{t("auth.signIn.subtitle")}</p>
      </div>
      {!APPLIANCE ? <Field id="signin-hub" label={t("auth.signIn.hubUrl")} value={hubUrl} onChange={setHubUrl} dirLtr type="url" hint={t("auth.signIn.hubUrlHint")} /> : null}
      <Field id="signin-login" label={t("auth.signIn.login")} value={user} onChange={setUser} dirLtr autoComplete="username" />
      <PasswordField id="signin-password" label={t("auth.password")} value={password} onChange={setPassword} autoComplete="current-password" />
      <RememberBox id="signin-remember" value={remember} onChange={setRemember} />
      <ErrorBox error={error} />
      <Button type="submit" variant="primary" className="w-full" disabled={!user.trim() || !password || busy} data-testid="signin-submit">
        <LogIn className="h-4 w-4" aria-hidden />
        {busy ? t("common.loading") : t("auth.signIn.submit")}
      </Button>
      <div className="flex flex-wrap justify-between gap-2 text-xs">
        <button type="button" className="text-ink-300 underline-offset-4 hover:text-ink-50 hover:underline" onClick={() => onView("reset")} data-testid="to-reset">
          {t("auth.signIn.reset")}
        </button>
        {registration !== "disabled" ? (
          <button type="button" className="text-ink-300 underline-offset-4 hover:text-ink-50 hover:underline" onClick={() => onView("register")} data-testid="to-register">
            {t("auth.signIn.register")}
          </button>
        ) : null}
      </div>
      {allowGuest && onGuest ? (
        <div className="border-t border-ink-800 pt-4">
          <Button variant="ghost" className="w-full" onClick={onGuest} data-testid="continue-guest">
            {t("auth.guest.action")}
          </Button>
          <FieldHint>{t("auth.guest.note")}</FieldHint>
        </div>
      ) : null}
    </form>
  );
}

export function RegisterForm({ onView }: { onView: (v: AuthView) => void }) {
  const { t } = useT();
  const register = useAuth((s) => s.register);
  const registration = useAuth((s) => s.registration);
  const { busy, error, run } = useSubmit();
  const [invite, setInvite] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(false);
  const ready = username.trim() && name.trim() && password && password === confirm && (registration !== "invite" || invite.trim());
  return (
    <form className="space-y-4" onSubmit={run(() => register({ inviteCode: invite, username, displayName: name, email, password, remember }))} data-testid="register-form">
      <h1 className="flex items-center gap-2 text-lg font-semibold text-ink-50">
        <UserPlus className="h-5 w-5 text-accent" aria-hidden />
        {t("auth.register.title")}
      </h1>
      {registration === "invite" ? (
        <Field id="reg-invite" label={t("auth.register.invite")} value={invite} onChange={setInvite} dirLtr autoComplete="one-time-code" hint={t("auth.register.inviteHint")} />
      ) : null}
      <Field id="reg-name" label={t("auth.displayName")} value={name} onChange={setName} autoComplete="name" />
      <Field id="reg-username" label={t("auth.username")} value={username} onChange={setUsername} dirLtr autoComplete="username" hint={t("auth.usernameHint")} />
      <Field id="reg-email" label={t("auth.email")} value={email} onChange={setEmail} dirLtr type="email" autoComplete="email" />
      <NewPasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
      <RememberBox id="reg-remember" value={remember} onChange={setRemember} />
      <ErrorBox error={error} />
      <Button type="submit" variant="primary" className="w-full" disabled={!ready || busy}>
        {busy ? t("common.loading") : t("auth.register.submit")}
      </Button>
      <button type="button" className="text-xs text-ink-300 underline-offset-4 hover:text-ink-50 hover:underline" onClick={() => onView("signin")}>
        {t("auth.register.back")}
      </button>
    </form>
  );
}

export function ResetForm({ onView }: { onView: (v: AuthView) => void }) {
  const { t } = useT();
  const redeem = useAuth((s) => s.redeemReset);
  const { busy, error, run } = useSubmit();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(false);
  return (
    <form className="space-y-4" onSubmit={run(() => redeem({ code, newPassword: password, remember }))} data-testid="reset-form">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold text-ink-50">
          <KeyRound className="h-5 w-5 text-accent" aria-hidden />
          {t("auth.reset.title")}
        </h1>
        <p className="mt-1 text-sm text-ink-300">{t("auth.reset.subtitle")}</p>
      </div>
      <Field id="reset-code" label={t("auth.reset.code")} value={code} onChange={setCode} dirLtr autoComplete="one-time-code" />
      <NewPasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
      <RememberBox id="reset-remember" value={remember} onChange={setRemember} />
      <ErrorBox error={error} />
      <Button type="submit" variant="primary" className="w-full" disabled={code.trim().length < 8 || !password || password !== confirm || busy} data-testid="reset-submit">
        {busy ? t("common.loading") : t("auth.reset.submit")}
      </Button>
      <button type="button" className="text-xs text-ink-300 underline-offset-4 hover:text-ink-50 hover:underline" onClick={() => onView("signin")}>
        {t("auth.register.back")}
      </button>
    </form>
  );
}

/** Switches between sign-in, registration and reset; setup is shown while no account exists. */
export function AuthPanel({ initial, allowGuest, onGuest }: { initial: AuthView; allowGuest: boolean; onGuest?: () => void }) {
  const [view, setView] = useState<AuthView>(initial);
  const current = initial === "setup" ? "setup" : view;
  if (current === "setup") return <SetupForm />;
  if (current === "register") return <RegisterForm onView={setView} />;
  if (current === "reset") return <ResetForm onView={setView} />;
  return <SignInForm onView={setView} allowGuest={allowGuest} onGuest={onGuest} />;
}
