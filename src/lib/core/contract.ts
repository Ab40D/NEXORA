/**
 * Typed contracts for the SE7ENX Core API (M1, unreleased; the hub still reports 1.1.0): accounts, roles, building model, audit ledger.
 * Every hub response is validated with these schemas before the UI uses it.
 */
import { z } from "zod";

export const ROLES = ["owner", "admin", "engineer", "technician", "user"] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const PERMISSION_KEYS = [
  "building.view",
  "building.edit",
  "device.view",
  "device.control",
  "device.configure",
  "integration.view",
  "integration.configure",
  "scene.run",
  "automation.view",
  "automation.edit",
  "automation.run",
  "safety.stop",
  "safety.release",
  "assistant.use",
  "audit.view",
  "user.manage",
  "role.manage",
  "system.backup",
  "system.configure",
] as const;
export type Permission = (typeof PERMISSION_KEYS)[number];

export const UserSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().nullable(),
  displayName: z.string(),
  role: RoleSchema,
  disabled: z.boolean(),
  mustChangePassword: z.boolean(),
  hasPassword: z.boolean(),
  createdAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
});
export type User = z.infer<typeof UserSchema>;

export const AccountSessionSchema = z.object({
  id: z.string(),
  client: z.string(),
  ip: z.string(),
  transport: z.enum(["cookie", "bearer"]),
  remember: z.boolean(),
  createdAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  current: z.boolean(),
});
export type AccountSession = z.infer<typeof AccountSessionSchema>;

export const PreferencesSchema = z
  .object({
    language: z.enum(["en", "fr", "ar", "dz"]),
    theme: z.enum(["dark", "light", "system"]),
    personality: z.enum(["professional", "friendly", "playful"]),
    guideLevel: z.enum(["beginner", "intermediate", "advanced"]),
    guideEnabled: z.boolean(),
    reducedMotion: z.boolean(),
    homeView: z.string(),
    dismissed: z.array(z.string()),
  })
  .partial();
export type Preferences = z.infer<typeof PreferencesSchema>;

export const MeSchema = z.object({
  user: UserSchema,
  permissions: z.array(z.string()),
  preferences: PreferencesSchema,
  session: AccountSessionSchema.nullable(),
});
export type Me = z.infer<typeof MeSchema>;

export const SignInResultSchema = MeSchema.extend({
  transport: z.enum(["cookie", "bearer"]),
  token: z.string().optional(),
});
export type SignInResult = z.infer<typeof SignInResultSchema>;

export const RegistrationSchema = z.enum(["disabled", "invite", "open"]);
export type Registration = z.infer<typeof RegistrationSchema>;

export const AuthStatusSchema = z.object({
  mode: z.enum(["accounts", "pairing"]),
  setupRequired: z.boolean(),
  registration: RegistrationSchema,
  passwordMinLength: z.number().int(),
  me: MeSchema.nullable(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const UsersSchema = z.object({ users: z.array(UserSchema) });
export const OneTimeCodeSchema = z.object({ code: z.string(), expiresAt: z.string().nullable() });
export type OneTimeCode = z.infer<typeof OneTimeCodeSchema>;
export const CreatedUserSchema = z.object({ user: UserSchema, setupCode: OneTimeCodeSchema.optional() });
export const UpdatedUserSchema = z.object({ user: UserSchema });

export const InviteSchema = z.object({ id: z.string(), role: RoleSchema, createdAt: z.string().nullable(), expiresAt: z.string().nullable() });
export type Invite = z.infer<typeof InviteSchema>;
export const InvitesSchema = z.object({ invites: z.array(InviteSchema), registration: RegistrationSchema });
export const CreatedInviteSchema = z.object({ code: z.string(), id: z.string(), role: RoleSchema, expiresAt: z.string().nullable() });

export const RolesSchema = z.object({
  roles: z.array(RoleSchema),
  rank: z.record(z.string(), z.number()),
  editable: z.array(RoleSchema),
  permissions: z.record(z.string(), z.string()),
  matrix: z.record(z.string(), z.array(z.string())),
});
export type Roles = z.infer<typeof RolesSchema>;

export const SecuritySchema = z.object({ registration: RegistrationSchema, passwordMinLength: z.number().int() });

export const AuditEntrySchema = z.object({
  id: z.number().int(),
  at: z.number(),
  actor: z.object({ id: z.string().nullable(), name: z.string().nullable(), role: z.string().nullable() }),
  source: z.string(),
  action: z.string(),
  target: z.object({ type: z.string(), id: z.string().nullable() }).nullable(),
  outcome: z.string(),
  details: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export const AuditPageSchema = z.object({ entries: z.array(AuditEntrySchema), next: z.number().int().nullable() });

// ------------------------------------------------------------------ building model

export const BUILDING_KINDS = ["residential", "commercial", "industrial", "public", "other"] as const;
export const ROOM_KINDS = [
  "living",
  "kitchen",
  "dining",
  "bedroom",
  "bathroom",
  "office",
  "meeting",
  "corridor",
  "entrance",
  "storage",
  "technical",
  "garage",
  "outdoor",
  "other",
] as const;
export const ZONE_KINDS = ["lighting", "hvac", "security", "energy", "custom"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];
export type BuildingKind = (typeof BUILDING_KINDS)[number];

export const SiteSchema = z.object({ id: z.string(), name: z.string(), timezone: z.string().optional(), address: z.string().optional() });
export const BuildingEntitySchema = z.object({ id: z.string(), siteId: z.string(), name: z.string(), kind: z.enum(BUILDING_KINDS) });
export const FloorSchema = z.object({ id: z.string(), buildingId: z.string(), name: z.string(), level: z.number().int() });
export const RoomSchema = z.object({
  id: z.string(),
  floorId: z.string(),
  name: z.string(),
  kind: z.enum(ROOM_KINDS),
  aliases: z.array(z.string()).default([]),
});
export const ZoneSchema = z.object({ id: z.string(), buildingId: z.string(), name: z.string(), kind: z.enum(ZONE_KINDS), roomIds: z.array(z.string()) });
export type Site = z.infer<typeof SiteSchema>;
export type BuildingEntity = z.infer<typeof BuildingEntitySchema>;
export type Floor = z.infer<typeof FloorSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type Zone = z.infer<typeof ZoneSchema>;

export const BuildingSnapshotSchema = z.object({
  sites: z.array(SiteSchema),
  buildings: z.array(BuildingEntitySchema),
  floors: z.array(FloorSchema),
  rooms: z.array(RoomSchema),
  zones: z.array(ZoneSchema),
  placement: z.record(z.string(), z.array(z.string())),
});
export type BuildingSnapshot = z.infer<typeof BuildingSnapshotSchema>;
export type BuildingCollection = "sites" | "buildings" | "floors" | "rooms" | "zones";

export interface BuildingImportTree {
  sites: Array<{
    id?: string;
    name?: string;
    timezone?: string;
    buildings: Array<{ name: string; kind?: BuildingKind; floors: Array<{ name: string; level: number; rooms: Array<{ name: string; kind?: RoomKind }> }> }>;
  }>;
}
