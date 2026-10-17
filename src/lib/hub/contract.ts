/**
 * Typed contract of the SE7ENX hub device API (bridge >= 1.1.0, /api/v1/devices ...).
 * Mirrors bridge/se7enx_bridge/devices/registry.py#device_json. Unknown keys are ignored, so the
 * hub can add fields without breaking older UIs.
 */
import { z } from "zod";

export const HUB_COMMANDS = ["turn_on", "turn_off", "toggle", "set_brightness", "dim", "open", "close", "stop", "set_position"] as const;
export type HubCommand = (typeof HUB_COMMANDS)[number];

export const DEVICE_TYPES = ["light", "switch", "outlet", "cover", "sensor"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export const INTEGRATIONS = ["simulated", "shelly", "homeassistant", "knx"] as const;
export type Integration = (typeof INTEGRATIONS)[number];

export const HubErrorInfoSchema = z.object({ code: z.string(), message: z.string(), at: z.string().optional() });

export const HubDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(DEVICE_TYPES),
  integration: z.enum(INTEGRATIONS),
  simulated: z.boolean(),
  model: z.string().nullable().optional(),
  capabilities: z.array(z.string()),
  commands: z.array(z.string()),
  controlEnabled: z.boolean(),
  controlAllowed: z.boolean(),
  hidden: z.boolean(),
  metadata: z.object({ room: z.string().optional(), tags: z.array(z.string()).optional(), linkedTo: z.string().optional() }),
  connection: z.object({
    status: z.enum(["online", "offline", "unauthorized", "unavailable", "error", "unknown"]),
    lastSeen: z.string().nullable(),
    lastError: HubErrorInfoSchema.nullable(),
  }),
  state: z.object({
    reported: z.record(z.string(), z.unknown()),
    reportedAt: z.string().nullable(),
    source: z.string().nullable(),
    requested: z.record(z.string(), z.unknown()).nullable(),
    requestedAt: z.string().nullable(),
    pending: z.boolean(),
  }),
  config: z.record(z.string(), z.unknown()),
  credentialsStored: z.boolean(),
  diagnostics: z.record(z.string(), z.unknown()),
});
export type HubDevice = z.infer<typeof HubDeviceSchema>;

export const SafetySchema = z.object({ active: z.boolean(), since: z.string().optional(), by: z.string().optional() });
export type Safety = z.infer<typeof SafetySchema>;

export const DeviceListSchema = z.object({ devices: z.array(HubDeviceSchema), safety: SafetySchema });

export const IntegrationStatusSchema = z
  .object({
    name: z.string(),
    state: z.string(),
    detail: z.string(),
    lastSuccessAt: z.string().nullable(),
    lastError: HubErrorInfoSchema.nullable(),
  })
  .passthrough();
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

export const IntegrationListSchema = z.object({ integrations: z.array(IntegrationStatusSchema), persistent: z.boolean() });

export const HubCommandResponseSchema = z.object({
  outcome: z.enum(["confirmed", "accepted", "simulated"]),
  delivery: z.string(),
  detail: z.string(),
  device: HubDeviceSchema,
});
export type HubCommandResponse = z.infer<typeof HubCommandResponseSchema>;

export const ShellyIdentitySchema = z.object({
  host: z.string(),
  gen: z.number().int(),
  model: z.string(),
  shellyId: z.string(),
  mac: z.string().nullable().optional(),
  firmware: z.string().nullable().optional(),
  app: z.string().nullable().optional(),
  authRequired: z.boolean(),
  profile: z.string().nullable().optional(),
  channels: z.array(
    z.object({
      component: z.enum(["switch", "light", "cover"]),
      channel: z.number().int(),
      capabilities: z.array(z.string()),
      suggestedType: z.enum(DEVICE_TYPES),
      state: z.record(z.string(), z.unknown()),
    }),
  ),
  unsupportedComponents: z.array(z.string()),
});
export type ShellyIdentity = z.infer<typeof ShellyIdentitySchema>;

export const HaConfigSchema = z.object({
  status: IntegrationStatusSchema,
  config: z.object({ url: z.string().nullable(), verifyTls: z.boolean(), tokenStored: z.boolean(), source: z.string(), readOnly: z.boolean() }),
});
export type HaConfig = z.infer<typeof HaConfigSchema>;

export const HaEntitiesSchema = z.object({
  entities: z.array(
    z.object({
      entityId: z.string(),
      name: z.string(),
      domain: z.string(),
      state: z.string().nullable().optional(),
      suggestedType: z.enum(DEVICE_TYPES),
      capabilities: z.array(z.string()),
      added: z.boolean(),
    }),
  ),
});
export type HaEntity = z.infer<typeof HaEntitiesSchema>["entities"][number];

export const HaTestSchema = z.object({ ok: z.boolean(), version: z.string().nullable().optional(), locationName: z.string().nullable().optional() });

/** Hub events delivered on the existing SSE stream (GET /api/v1/events). */
export const HubEventSchemas = [
  z.object({ type: z.literal("device.state"), data: HubDeviceSchema }),
  z.object({ type: z.literal("device.removed"), data: z.object({ id: z.string() }) }),
  z.object({ type: z.literal("integration.status"), data: IntegrationStatusSchema }),
  z.object({ type: z.literal("safety"), data: SafetySchema }),
] as const;

export interface AddDeviceBody {
  device: Record<string, unknown> & { integration: Integration; id: string; name: string; type: DeviceType };
  credentials?: { username?: string; password: string };
}

export interface DevicePatchBody {
  name?: string;
  hidden?: boolean;
  metadata?: { room?: string; tags?: string[]; linkedTo?: string };
  controlEnabled?: boolean;
  acknowledgeRealControl?: boolean;
}
