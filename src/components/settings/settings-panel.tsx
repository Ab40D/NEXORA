"use client";

import { Check, Copy, KeyRound, MonitorSmartphone, ShieldCheck, Trash2, UserPlus, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuthErrorText } from "@/components/auth/auth-forms";
import { Button } from "@/components/ui/button";
import { Badge, Callout, Card, CardHeader, FieldHint, Input, Label } from "@/components/ui/primitives";
import { coreClient, toFailure, useAuth, useCan, type AuthFailure } from "@/lib/core/auth-store";
import { PERMISSION_KEYS, ROLES, type AccountSession, type Invite, type OneTimeCode, type Registration, type Role, type Roles, type User } from "@/lib/core/contract";
import { useT, type MessageKey } from "@/lib/i18n";

const RANK: Record<Role, number> = { owner: 5, admin: 4, engineer: 3, technician: 2, user: 1 };
const OWNER_ONLY = new Set(["role.manage", "system.configure"]);

function outranks(actor: Role, target: Role): boolean {
  return actor === "owner" || RANK[actor] > RANK[target];
}

function permKey(p: string): MessageKey {
  return `perm.${p.replace(".", "_")}` as MessageKey;
}

function useWhen() {
  const { locale } = useT();
  return (iso: string | null | undefined) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat(locale === "dz" ? "ar-DZ" : locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
  };
}

function Select<T extends string>({ id, value, options, onChange, disabled, label }: { id: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; disabled?: boolean; label?: string }) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-9 rounded-lg border border-ink-600 bg-ink-850 px-2 text-sm text-ink-100 disabled:opacity-50"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ErrorLine({ error }: { error: AuthFailure | null }) {
  const text = useAuthErrorText()(error);
  return text ? (
    <p className="text-xs text-danger" role="alert" data-code={error?.code}>
      {text}
    </p>
  ) : null;
}

/** A one-time code shown exactly once, with copy and expiry. */
export function CodeReveal({ title, help, code, expiresAt }: { title: string; help: string; code: string; expiresAt: string | null }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-3" data-testid="code-reveal">
      <p className="text-sm font-medium text-ink-50">{title}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code dir="ltr" className="rounded-lg bg-ink-950 px-3 py-1.5 font-mono text-base tracking-[0.18em] text-ink-50" data-testid="one-time-code" data-expires={expiresAt ?? ""}>
          {code}
        </code>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => setCopied(true));
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied ? t("users.copied") : t("users.copy")}
        </Button>
      </div>
      <p className="text-xs text-ink-300">{help}</p>
    </div>
  );
}

// ------------------------------------------------------------------ own account

function ProfileCard() {
  const { t } = useT();
  const me = useAuth((s) => s.me)!;
  const updateProfile = useAuth((s) => s.updateProfile);
  const updatePreferences = useAuth((s) => s.updatePreferences);
  const [name, setName] = useState(me.user.displayName);
  const [email, setEmail] = useState(me.user.email ?? "");
  const [personality, setPersonality] = useState(me.preferences.personality ?? "friendly");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await updateProfile({ displayName: name, email: email.trim() ? email : null });
      await updatePreferences({ personality });
      setSaved(true);
    } catch (err) {
      setError(toFailure(err));
    }
  };
  return (
    <Card>
      <CardHeader title={t("account.title")} subtitle={t("account.subtitle")} icon={<UserRound className="h-4 w-4" />} actions={<Badge tone="accent">{t(`role.${me.user.role}` as MessageKey)}</Badge>} />
      <form className="grid gap-3 p-4 pt-0 sm:grid-cols-2" onSubmit={save}>
        <div className="space-y-1">
          <Label htmlFor="acc-name">{t("auth.displayName")}</Label>
          <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="acc-email">{t("auth.email")}</Label>
          <Input id="acc-email" dir="ltr" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="acc-personality">{t("account.personality")}</Label>
          <Select
            id="acc-personality"
            value={personality}
            onChange={setPersonality}
            options={(["professional", "friendly", "playful"] as const).map((p) => ({ value: p, label: t(`account.personalities.${p}`) }))}
          />
        </div>
        <div className="flex items-end gap-3">
          <Button type="submit" variant="primary" size="sm">
            {t("account.save")}
          </Button>
          {saved ? <span className="text-xs text-ok">{t("account.saved")}</span> : null}
        </div>
        <div className="sm:col-span-2">
          <ErrorLine error={error} />
        </div>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const { t } = useT();
  const min = useAuth((s) => s.passwordMinLength);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      useAuth.setState({ me: await coreClient().changePassword(current, next) });
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      setError(toFailure(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title={t("account.password.title")} icon={<KeyRound className="h-4 w-4" />} />
      <form className="space-y-3 p-4 pt-0" onSubmit={submit}>
        <div className="space-y-1">
          <Label htmlFor="pw-current">{t("account.password.current")}</Label>
          <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pw-new">{t("account.password.new")}</Label>
          <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          <FieldHint>{t("auth.passwordHint", { min })}</FieldHint>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pw-confirm">{t("auth.confirm")}</Label>
          <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} invalid={confirm.length > 0 && confirm !== next} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <ErrorLine error={error} />
        {done ? <p className="text-xs text-ok">{t("account.password.done")}</p> : null}
        <Button type="submit" size="sm" disabled={busy || !current || !next || next !== confirm}>
          {t("account.password.submit")}
        </Button>
      </form>
    </Card>
  );
}

function SessionsCard() {
  const { t } = useT();
  const when = useWhen();
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const load = useCallback(() => {
    coreClient()
      .mySessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);
  useEffect(load, [load]);
  return (
    <Card>
      <CardHeader title={t("account.sessions.title")} icon={<MonitorSmartphone className="h-4 w-4" />} />
      <ul className="space-y-2 p-4 pt-0" data-testid="sessions-list">
        {(sessions ?? []).map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-700 px-3 py-2 text-xs">
            <div className="min-w-0">
              <p className="truncate font-medium text-ink-100" dir="ltr">
                {s.client}
              </p>
              <p className="text-ink-400">
                <bdi dir="ltr">{s.ip}</bdi> · {t("account.sessions.lastSeen", { when: when(s.lastSeenAt) })}
                {s.remember ? ` · ${t("account.sessions.kept")}` : ""}
              </p>
            </div>
            {s.current ? (
              <Badge tone="ok">{t("account.sessions.current")}</Badge>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => void coreClient().revokeMySession(s.id).then(load)}>
                {t("account.sessions.revoke")}
              </Button>
            )}
          </li>
        ))}
        {sessions && sessions.length <= 1 ? <li className="text-xs text-ink-400">{t("account.sessions.empty")}</li> : null}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------ administration

function UsersCard() {
  const { t } = useT();
  const when = useWhen();
  const me = useAuth((s) => s.me)!;
  const myRole = me.user.role;
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<AuthFailure | null>(null);
  const [reveal, setReveal] = useState<{ name: string; code: OneTimeCode } | null>(null);
  const [form, setForm] = useState({ username: "", displayName: "", role: "user" as Role, email: "", password: "" });
  const load = useCallback(() => {
    coreClient()
      .users()
      .then(setUsers)
      .catch((e) => setError(toFailure(e)));
  }, []);
  useEffect(load, [load]);
  const assignable = ROLES.filter((r) => outranks(myRole, r));
  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    fn()
      .then(load)
      .catch((e) => setError(toFailure(e)));
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setReveal(null);
    coreClient()
      .createUser({ username: form.username, displayName: form.displayName, role: form.role, email: form.email || undefined, password: form.password || undefined })
      .then((res) => {
        if (res.setupCode) setReveal({ name: res.user.displayName, code: res.setupCode });
        setForm({ username: "", displayName: "", role: "user", email: "", password: "" });
        load();
      })
      .catch((err) => setError(toFailure(err)));
  };
  return (
    <Card>
      <CardHeader title={t("users.title")} subtitle={t("users.subtitle")} icon={<Users className="h-4 w-4" />} />
      <div className="space-y-4 p-4 pt-0">
        <ul className="space-y-2" data-testid="users-list">
          {users.map((u) => {
            const self = u.id === me.user.id;
            const manageable = !self && outranks(myRole, u.role);
            const status = u.disabled ? "disabled" : u.hasPassword ? "active" : "noPassword";
            return (
              <li key={u.id} className="rounded-xl border border-ink-700 px-3 py-2 text-xs" data-testid={`user-${u.username}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-ink-100" dir="auto">
                      {u.displayName} {self ? <span className="text-ink-400">({t("users.you")})</span> : null}
                    </p>
                    <p className="text-ink-400">
                      <bdi dir="ltr">@{u.username}</bdi> · {t("users.lastLogin", { when: u.lastLoginAt ? when(u.lastLoginAt) : t("users.never") })}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={status === "active" ? "ok" : status === "disabled" ? "danger" : "warn"}>{t(`users.status.${status}`)}</Badge>
                    {manageable ? (
                      <Select
                        id={`role-${u.id}`}
                        label={t("users.role")}
                        value={u.role}
                        onChange={(role) => act(() => coreClient().updateUser(u.id, { role }))}
                        options={assignable.map((r) => ({ value: r, label: t(`role.${r}` as MessageKey) }))}
                      />
                    ) : (
                      <Badge tone="neutral">{t(`role.${u.role}` as MessageKey)}</Badge>
                    )}
                  </div>
                </div>
                {manageable ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => act(() => coreClient().updateUser(u.id, { disabled: !u.disabled }))}>
                      {u.disabled ? t("users.action.enable") : t("users.action.disable")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        coreClient()
                          .userResetCode(u.id)
                          .then((code) => setReveal({ name: u.displayName, code }))
                          .catch((e) => setError(toFailure(e)))
                      }
                    >
                      <KeyRound className="h-3.5 w-3.5" aria-hidden />
                      {t("users.action.resetCode")}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        if (window.confirm(t("users.action.confirmDelete", { name: u.displayName }))) act(() => coreClient().deleteUser(u.id));
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      {t("users.action.delete")}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {reveal ? (
          <CodeReveal
            title={t("users.codeTitle", { name: reveal.name })}
            help={t("users.codeHelp", { name: reveal.name, when: when(reveal.code.expiresAt) })}
            code={reveal.code.code}
            expiresAt={reveal.code.expiresAt}
          />
        ) : null}
        <ErrorLine error={error} />
        <form className="grid gap-3 rounded-xl border border-ink-800 p-3 sm:grid-cols-2" onSubmit={create} data-testid="add-user-form">
          <p className="flex items-center gap-2 text-sm font-medium text-ink-100 sm:col-span-2">
            <UserPlus className="h-4 w-4" aria-hidden />
            {t("users.add")}
          </p>
          <div className="space-y-1">
            <Label htmlFor="nu-name">{t("users.name")}</Label>
            <Input id="nu-name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nu-username">{t("auth.username")}</Label>
            <Input id="nu-username" dir="ltr" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nu-role">{t("users.role")}</Label>
            <div>
              <Select id="nu-role" value={form.role} onChange={(role) => setForm({ ...form, role })} options={assignable.map((r) => ({ value: r, label: t(`role.${r}` as MessageKey) }))} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="nu-email">{t("auth.email")}</Label>
            <Input id="nu-email" dir="ltr" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="nu-password">{t("users.passwordOptional")}</Label>
            <Input id="nu-password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <FieldHint>{t("users.passwordOptionalHint")}</FieldHint>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" size="sm" variant="primary" disabled={!form.username.trim() || !form.displayName.trim()} data-testid="add-user-submit">
              {t("users.create")}
            </Button>
          </div>
        </form>
      </div>
    </Card>
  );
}

function InvitesCard() {
  const { t } = useT();
  const when = useWhen();
  const me = useAuth((s) => s.me)!;
  const canConfigure = useCan("system.configure");
  const [invites, setInvites] = useState<Invite[]>([]);
  const [registration, setRegistration] = useState<Registration>("disabled");
  const [role, setRole] = useState<Role>("user");
  const [ttl, setTtl] = useState("72");
  const [reveal, setReveal] = useState<{ code: string; expiresAt: string | null } | null>(null);
  const [error, setError] = useState<AuthFailure | null>(null);
  const load = useCallback(() => {
    coreClient()
      .invites()
      .then((r) => {
        setInvites(r.invites);
        setRegistration(r.registration);
        useAuth.setState({ registration: r.registration });
      })
      .catch((e) => setError(toFailure(e)));
  }, []);
  useEffect(load, [load]);
  const assignable = ROLES.filter((r) => outranks(me.user.role, r));
  return (
    <Card>
      <CardHeader title={t("users.invites.title")} icon={<UserPlus className="h-4 w-4" />} />
      <div className="space-y-3 p-4 pt-0">
        <div className="space-y-1">
          <Label htmlFor="reg-mode">{t("users.registration.title")}</Label>
          <div>
            <Select
              id="reg-mode"
              value={registration}
              disabled={!canConfigure}
              onChange={(v) =>
                coreClient()
                  .updateSecurity(v)
                  .then((r) => {
                    setRegistration(r.registration);
                    useAuth.setState({ registration: r.registration });
                  })
                  .catch((e) => setError(toFailure(e)))
              }
              options={(["disabled", "invite", "open"] as const).map((v) => ({ value: v, label: t(`users.registration.${v}`) }))}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="inv-role">{t("users.role")}</Label>
            <div>
              <Select id="inv-role" value={role} onChange={setRole} options={assignable.map((r) => ({ value: r, label: t(`role.${r}` as MessageKey) }))} />
            </div>
          </div>
          <div className="w-28 space-y-1">
            <Label htmlFor="inv-ttl">{t("users.invites.ttl")}</Label>
            <Input id="inv-ttl" inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value.replace(/[^0-9]/g, ""))} />
          </div>
          <Button
            size="sm"
            onClick={() =>
              coreClient()
                .createInvite(role, Math.min(336, Math.max(1, Number(ttl) || 72)))
                .then((r) => {
                  setReveal({ code: r.code, expiresAt: r.expiresAt });
                  load();
                })
                .catch((e) => setError(toFailure(e)))
            }
          >
            {t("users.invites.create")}
          </Button>
        </div>
        {reveal ? <CodeReveal title={t("users.invites.codeTitle")} help={t("users.invites.codeHelp", { when: when(reveal.expiresAt) })} code={reveal.code} expiresAt={reveal.expiresAt} /> : null}
        <ErrorLine error={error} />
        <ul className="space-y-1.5 text-xs">
          {invites.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-2 rounded-lg border border-ink-800 px-3 py-1.5">
              <span>
                {t("users.invites.for", { role: t(`role.${i.role}` as MessageKey) })} · {t("users.invites.expires", { when: when(i.expiresAt) })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void coreClient().revokeInvite(i.id).then(load)}>
                {t("users.invites.revoke")}
              </Button>
            </li>
          ))}
          {invites.length === 0 ? <li className="text-ink-400">{t("users.invites.empty")}</li> : null}
        </ul>
      </div>
    </Card>
  );
}

function RolesCard() {
  const { t } = useT();
  const me = useAuth((s) => s.me)!;
  const canEdit = useCan("role.manage");
  const [roles, setRoles] = useState<Roles | null>(null);
  const [error, setError] = useState<AuthFailure | null>(null);
  useEffect(() => {
    coreClient()
      .roles()
      .then(setRoles)
      .catch((e) => setError(toFailure(e)));
  }, []);
  const myPerms = new Set(me.permissions);
  const toggle = (role: Role, perm: string, on: boolean) => {
    if (!roles) return;
    const current = new Set(roles.matrix[role] ?? []);
    if (on) current.add(perm);
    else current.delete(perm);
    coreClient()
      .updateRole(role, [...current])
      .then(setRoles)
      .catch((e) => setError(toFailure(e)));
  };
  return (
    <Card>
      <CardHeader title={t("users.roles.title")} subtitle={t("users.roles.subtitle")} icon={<ShieldCheck className="h-4 w-4" />} />
      <div className="overflow-x-auto p-4 pt-0">
        <ErrorLine error={error} />
        {roles ? (
          <table className="w-full min-w-[560px] text-xs" data-testid="roles-matrix">
            <thead>
              <tr className="text-ink-300">
                <th className="py-1.5 text-start font-medium" />
                {ROLES.map((r) => (
                  <th key={r} className="px-1 py-1.5 text-center font-medium">
                    {t(`role.${r}` as MessageKey)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSION_KEYS.map((p) => (
                <tr key={p} className="border-t border-ink-800">
                  <td className="py-1.5 pe-2 text-ink-200">{t(permKey(p))}</td>
                  {ROLES.map((r) => {
                    const has = (roles.matrix[r] ?? []).includes(p);
                    const editable =
                      canEdit && r !== "owner" && outranks(me.user.role, r) && (r !== "admin" || me.user.role === "owner") && myPerms.has(p) && (me.user.role === "owner" || !OWNER_ONLY.has(p));
                    return (
                      <td key={r} className="px-1 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={has}
                          disabled={!editable}
                          aria-label={`${t(`role.${r}` as MessageKey)}: ${t(permKey(p))}`}
                          onChange={(e) => toggle(r, p, e.target.checked)}
                          className="h-3.5 w-3.5 accent-[var(--color-accent,#38d9f5)] disabled:opacity-60"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </Card>
  );
}

export function SettingsPanel() {
  const status = useAuth((s) => s.status);
  const canUsers = useCan("user.manage");
  const canRoles = useCan("role.manage");
  const { t } = useT();
  if (status !== "signed_in") {
    return <Callout tone="neutral">{t("auth.guest.note")}</Callout>;
  }
  return (
    <div className="space-y-4" data-testid="settings-panel">
      <ProfileCard />
      <PasswordCard />
      <SessionsCard />
      {canUsers ? <UsersCard /> : null}
      {canUsers ? <InvitesCard /> : null}
      {canUsers || canRoles ? <RolesCard /> : null}
    </div>
  );
}
