/**
 * SE7ENX Bridge HTTP API — integration contract v1 (see docs/API.md).
 *
 * Every response from the bridge is validated against these schemas before it
 * is used; a non-conforming bridge produces a CONTRACT_MISMATCH error instead
 * of undefined behaviour.
 */
import { z } from "zod";
import { HubEventSchemas } from "@/lib/hub/contract";

export const API_PREFIX = "/api/v1";

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().nullish(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export const HealthSchema = z.object({
  ok: z.literal(true),
  service: z.literal("se7enx-bridge"),
  version: z.string(),
  apiVersion: z.literal(1),
  pairingRequired: z.boolean(),
});
export type Health = z.infer<typeof HealthSchema>;

export const PairResponseSchema = z.object({
  token: z.string().min(20),
  expiresAt: z.string(),
  bridgeId: z.string(),
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

export const ConnectionTypeSchema = z.enum([
  "automatic",
  "tunneling",
  "tunneling_tcp",
  "tunneling_tcp_secure",
  "routing",
  "routing_secure",
]);
export type ConnectionType = z.infer<typeof ConnectionTypeSchema>;

export const KnxStatusSchema = z.object({
  state: z.enum(["disconnected", "connecting", "connected", "error"]),
  connectionType: ConnectionTypeSchema,
  gateway: z
    .object({
      host: z.string().nullable(),
      port: z.number().int().nullable(),
      name: z.string().nullable(),
      individualAddress: z.string().nullable(),
    })
    .nullable(),
  localAddress: z.string().nullable(),
  since: z.string().nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** "interface": L_Data.con comes from the KNX interface; "local": routing — no bus confirmation */
  confirmation: z.enum(["interface", "local"]),
  secure: z.boolean(),
});
export type KnxStatus = z.infer<typeof KnxStatusSchema>;

export const PolicySchema = z.object({
  allowedGroupAddresses: z.array(z.string()),
  supportedDpts: z.array(z.string()),
  clientGatewayOverride: z.boolean(),
  discovery: z.boolean(),
});
export type BridgePolicy = z.infer<typeof PolicySchema>;

export const SessionInfoSchema = z.object({
  session: z.object({ clientName: z.string(), expiresAt: z.string() }),
  bridge: z.object({ id: z.string(), name: z.string(), version: z.string() }),
  knx: KnxStatusSchema,
  policy: PolicySchema,
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const GatewaySchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  individualAddress: z.string().nullable(),
  supportsTunnelling: z.boolean(),
  supportsTunnellingTcp: z.boolean(),
  supportsRouting: z.boolean(),
  requiresSecure: z.boolean(),
});
export type Gateway = z.infer<typeof GatewaySchema>;
export const DiscoverResponseSchema = z.object({ gateways: z.array(GatewaySchema) });

export const ConnectOverrideSchema = z.object({
  connectionType: z.enum(["tunneling", "tunneling_tcp", "routing"]),
  host: z.string().max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});
export type ConnectOverride = z.infer<typeof ConnectOverrideSchema>;

export const TestCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
export const TestResultSchema = z.object({ ok: z.boolean(), checks: z.array(TestCheckSchema) });
export type TestResult = z.infer<typeof TestResultSchema>;

export const PayloadSchema = z.union([z.number().int(), z.array(z.number().int())]);

export const LightConfigSchema = z.object({
  id: z.string(),
  switchAddress: z.string(),
  statusAddress: z.string().nullable(),
  dpt: z.enum(["1.001", "5.001"]),
  onLevel: z.number().int().min(1).max(100),
});
export type LightConfig = z.infer<typeof LightConfigSchema>;

export const LightStateSchema = z.object({
  lightId: z.string(),
  value: z.enum(["on", "off", "unknown"]),
  via: z.enum(["status_address", "read_response", "switch_address", "none"]),
  at: z.string().nullable(),
  payload: PayloadSchema.nullable(),
});
export type LightStateDto = z.infer<typeof LightStateSchema>;

export const LightResponseSchema = z.object({ light: LightConfigSchema, state: LightStateSchema });
export type LightResponse = z.infer<typeof LightResponseSchema>;

export const CommandResponseSchema = z.object({
  requestId: z.string(),
  lightId: z.string(),
  value: z.enum(["on", "off"]),
  outcome: z.enum(["bus_confirmed", "sent_unconfirmed"]),
  confirmation: z.enum(["interface_positive", "local", "none"]),
  detail: z.string(),
  telegram: z.object({ destination: z.string(), payload: PayloadSchema }),
  at: z.string(),
});
export type CommandResponse = z.infer<typeof CommandResponseSchema>;

export const LightRegistrationSchema = z.object({
  switchAddress: z.string(),
  statusAddress: z.string().nullable(),
  dpt: z.enum(["1.001", "5.001"]),
  onLevel: z.number().int().min(1).max(100),
});
export type LightRegistration = z.infer<typeof LightRegistrationSchema>;

/** Server-sent events on GET /api/v1/events */
export const BridgeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), data: z.object({ bridgeId: z.string(), knx: KnxStatusSchema }) }),
  z.object({ type: z.literal("knx.status"), data: KnxStatusSchema }),
  z.object({ type: z.literal("light.state"), data: LightStateSchema }),
  z.object({
    type: z.literal("light.command"),
    data: z.object({ requestId: z.string(), lightId: z.string(), value: z.enum(["on", "off"]), outcome: z.string() }),
  }),
  z.object({ type: z.literal("ping"), data: z.object({}).passthrough() }),
  ...HubEventSchemas,
]);
export type BridgeEvent = z.infer<typeof BridgeEventSchema>;

export const LIGHT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
