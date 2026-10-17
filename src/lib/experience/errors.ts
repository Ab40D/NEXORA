/**
 * Maps hub/bridge error codes to a small set of localized, actionable categories
 * (dictionary section `errors.*`). The original English detail is kept for "Technical details".
 */
export type ErrorCategory =
  | "offline"
  | "timeout"
  | "auth"
  | "blocked"
  | "needsTest"
  | "stateUnknown"
  | "busy"
  | "unsupported"
  | "config"
  | "deviceFailed"
  | "knx"
  | "llm"
  | "hub"
  | "unexpected";

const BY_CODE: Record<string, ErrorCategory> = {
  // device / integration offline
  DEVICE_UNAVAILABLE: "offline",
  DEVICE_NOT_READY: "offline",
  INTEGRATION_UNAVAILABLE: "offline",
  HA_DISCONNECTED: "offline",
  HA_NOT_CONNECTED: "offline",
  HA_ENTITY_UNAVAILABLE: "offline",
  HA_UNREACHABLE: "offline",
  KNX_NOT_CONNECTED: "offline",
  SHELLY_UNREACHABLE: "offline",
  // timeouts
  DEVICE_TIMEOUT: "timeout",
  HA_TIMEOUT: "timeout",
  SHELLY_TIMEOUT: "timeout",
  // authentication
  HA_AUTH_FAILED: "auth",
  HA_TOKEN_REQUIRED: "auth",
  SHELLY_AUTH_FAILED: "auth",
  SHELLY_INVALID_USERNAME: "auth",
  NOT_PAIRED: "auth",
  UNAUTHORIZED: "auth",
  // safety
  SAFETY_STOP_ACTIVE: "blocked",
  HANDS_FREE_STOPPED: "blocked",
  CONTROL_NOT_ENABLED: "needsTest",
  ACKNOWLEDGEMENT_REQUIRED: "needsTest",
  // state
  STATE_UNKNOWN: "stateUnknown",
  // busy / rate
  DEVICE_BUSY: "busy",
  DEVICE_RATE_LIMITED: "busy",
  RATE_LIMITED: "busy",
  SHELLY_THROTTLED: "busy",
  // unsupported
  UNSUPPORTED_COMMAND: "unsupported",
  UNSUPPORTED_ON_DEVICE: "unsupported",
  SHELLY_COMPONENT_NOT_FOUND: "unsupported",
  SHELLY_CHANNEL_NOT_FOUND: "unsupported",
  // configuration
  VALIDATION_ERROR: "config",
  GA_NOT_ALLOWED: "config",
  GA_NOT_CONFIGURED: "config",
  INVALID_DEVICE_HOST: "config",
  NOT_A_SHELLY: "config",
  HA_ENTITY_NOT_FOUND: "config",
  HA_NOT_CONFIGURED: "config",
  HA_CONFIGURED_BY_ENV: "config",
  KNX_CONFIGURED_BY_ENV: "config",
  GATEWAY_NOT_ALLOWED: "config",
  DEVICE_EXISTS: "config",
  DEVICE_NOT_FOUND: "config",
  TOO_MANY_DEVICES: "config",
  // device-side failures
  HA_SERVICE_FAILED: "deviceFailed",
  SHELLY_ERROR: "deviceFailed",
  SHELLY_RPC_ERROR: "deviceFailed",
  SHELLY_BAD_RESPONSE: "deviceFailed",
  SHELLY_INVALID_ARGUMENT: "deviceFailed",
  SHELLY_PRECONDITION_FAILED: "deviceFailed",
  // KNX link
  KNX_CONNECT_TIMEOUT: "knx",
  KNX_NO_GATEWAY_FOUND: "knx",
  KNX_SECURE_ERROR: "knx",
  KNX_CONNECT_FAILED: "knx",
  // optional AI provider
  LLM_DISABLED: "llm",
  LLM_TIMEOUT: "llm",
  LLM_UNAVAILABLE: "llm",
  LLM_INVALID_OUTPUT: "llm",
  // the hub itself
  BRIDGE_UNREACHABLE: "hub",
  BRIDGE_TIMEOUT: "hub",
};

export function errorCategory(code: string | undefined, status?: number): ErrorCategory {
  const known = code ? BY_CODE[code] : undefined;
  if (known) return known;
  switch (status) {
    case 401:
      return "auth";
    case 409:
      return "busy";
    case 422:
      return "config";
    case 423:
      return "blocked";
    case 429:
      return "busy";
    case 503:
      return "offline";
    case 504:
      return "timeout";
    default:
      return "unexpected";
  }
}
