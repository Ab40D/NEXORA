# SE7ENX Bridge API — integration contract v1

The web app talks to the bridge **directly from the browser** (never through
Vercel). All responses are validated by zod schemas in
[`src/lib/bridge/contract.ts`](../src/lib/bridge/contract.ts); the Python
implementation lives in [`bridge/se7enx_bridge/api.py`](../bridge/se7enx_bridge/api.py).
A contract test (`tests/integration/bridge-contract.test.ts`) runs the typed
client against the real bridge.

Base path: `/api/v1` · JSON in/out · UTF-8 · timestamps ISO-8601 UTC.

## Authentication

1. The bridge prints a **pairing code** in its console (random, single use, rotates).
2. `POST /api/v1/pair` with the code returns a **session token** (32 random bytes,
   stored hashed, default lifetime 12 h).
3. Every other endpoint (except `/health`) requires `Authorization: Bearer <token>`.

The token is kept only in the browser tab's `sessionStorage`; `POST /session/revoke`
invalidates it ("Disconnect" in the UI does this).

## Cross-origin rules

* Requests carrying an `Origin` header that is not in `SE7ENX_ALLOWED_ORIGINS`
  are rejected with `403 ORIGIN_NOT_ALLOWED` (including preflights).
* Preflights from allowed origins get `Access-Control-Allow-Origin: <origin>`,
  methods `GET, POST, PUT, DELETE, OPTIONS`, headers `Authorization, Content-Type, Accept`,
  and `Access-Control-Allow-Private-Network: true` when requested.
* No cookies are used (`credentials: "omit"`), so CSRF does not apply.

## Error envelope

```json
{ "error": { "code": "GA_NOT_ALLOWED", "message": "Group address 1/2/3 is not permitted by this bridge.", "hint": "Allowed: 0/0/1, 0/0/2. The installer can extend SE7ENX_ALLOWED_GROUP_ADDRESSES." } }
```

`429` responses include `Retry-After` (seconds).

| HTTP | code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED`, `SESSION_INVALID` | Missing / invalid / expired / revoked token |
| 401 | `PAIRING_FAILED` | Wrong or expired pairing code |
| 403 | `ORIGIN_NOT_ALLOWED` | Web origin not allowlisted on the bridge |
| 403 | `GA_NOT_ALLOWED` | Group address outside `SE7ENX_ALLOWED_GROUP_ADDRESSES` |
| 403 | `GATEWAY_OVERRIDE_DISABLED`, `GATEWAY_NOT_ALLOWED` | Browser-supplied interface settings refused |
| 403 | `DISCOVERY_DISABLED` | Discovery switched off |
| 404 | `LIGHT_NOT_FOUND`, `NOT_FOUND` | Unknown light id / route |
| 409 | `KNX_NOT_CONNECTED` | Bridge is not connected to the KNX interface |
| 409 | `TOO_MANY_LIGHTS` | More than 16 lights in one session |
| 411/413 | `LENGTH_REQUIRED`, `PAYLOAD_TOO_LARGE` | Body without length / larger than 16 KiB |
| 422 | `VALIDATION_ERROR`, `INVALID_GROUP_ADDRESS`, `INVALID_LIGHT_ID` | Malformed input |
| 429 | `RATE_LIMITED`, `PAIRING_LOCKED`, `TOO_MANY_STREAMS` | Throttled |
| 502 | `KNX_NEGATIVE_CONFIRMATION` | Interface reported the telegram was **not** transmitted |
| 502 | `KNX_COMMUNICATION_ERROR`, `KNX_CONNECT_FAILED`, `KNX_NO_GATEWAY_FOUND`, `KNX_SECURE_ERROR` | Interface / tunnel problems |
| 504 | `KNX_CONFIRMATION_TIMEOUT` | No `L_Data.con` within 3 s — transmission unknown |
| 504 | `KNX_CONNECT_TIMEOUT`, `KNX_SEND_TIMEOUT` | Timeouts |
| 500 | `INTERNAL_ERROR` | Unexpected; details only in the bridge log |

## Endpoints

### `GET /health` (public)

```json
{ "ok": true, "service": "se7enx-bridge", "version": "1.0.0", "apiVersion": 1, "pairingRequired": true }
```

Deliberately reveals nothing about the installation.

### `POST /pair` (public, rate limited: 5/min per client, lockout after 20 failures)

Request `{ "code": "ABCD-EFGH", "clientName": "SE7ENX web · Chrome on macOS" }` →
`{ "token": "…", "expiresAt": "2026-10-16T09:05:41Z", "bridgeId": "e143cb305f91" }`

### `GET /session`

```json
{
  "session": { "clientName": "SE7ENX web · Chrome on macOS", "expiresAt": "2026-10-16T09:05:41Z" },
  "bridge": { "id": "e143cb305f91", "name": "SE7ENX Bridge", "version": "1.0.0" },
  "knx": { "…": "see KnxStatus" },
  "policy": { "allowedGroupAddresses": ["0/0/1", "0/0/2"], "supportedDpts": ["1.001", "5.001"], "clientGatewayOverride": false, "discovery": true }
}
```

### `POST /session/revoke` → `204`

### `GET /knx/status` → `KnxStatus`

```json
{
  "state": "connected",
  "connectionType": "tunneling",
  "gateway": { "host": "192.168.1.20", "port": 3671, "name": "KNX IP Interface", "individualAddress": "1.1.0" },
  "localAddress": "1.1.241",
  "since": "2026-10-15T21:05:22.974Z",
  "lastError": null,
  "confirmation": "interface",
  "secure": false
}
```

`state`: `disconnected | connecting | connected | error`.
`confirmation`: `interface` (tunnelling — the interface returns `L_Data.con`) or
`local` (routing — no bus-level confirmation exists).

### `POST /knx/connect`

Body `{}` connects with the bridge configuration. Optional override (only if
`SE7ENX_ALLOW_CLIENT_GATEWAY_CONFIG=true`; host must be an IPv4 literal inside
`SE7ENX_CLIENT_GATEWAY_CIDRS`):

```json
{ "override": { "connectionType": "tunneling", "host": "192.168.1.20", "port": 3671 } }
```

Returns `KnxStatus` or an error (`KNX_CONNECT_*`). Rate limited (6/min per session).

### `POST /knx/disconnect` → `KnxStatus`

### `POST /knx/discover` → `{ "gateways": [Gateway] }`

```json
{ "name": "KNX IP Router", "host": "192.168.1.20", "port": 3671, "individualAddress": "1.1.0",
  "supportsTunnelling": true, "supportsTunnellingTcp": true, "supportsRouting": true, "requiresSecure": false }
```

### `POST /knx/test` — connectivity self-test, **never writes to the bus**

Body `{}` or `{ "readAddress": "0/0/2" }` (allowlisted; performs one GroupValueRead).

```json
{ "ok": true, "checks": [
  { "id": "link", "label": "KNX link", "ok": true, "detail": "tunneling — connected as 1.1.241" },
  { "id": "interface", "label": "Interface responds", "ok": true, "detail": "“KNX IP Interface” (1.1.0) answered a description request." },
  { "id": "policy", "label": "Group address policy", "ok": true, "detail": "Allowed: 0/0/1, 0/0/2" },
  { "id": "read", "label": "Read 0/0/2", "ok": true, "detail": "Answer 1 from 1.1.10" }
] }
```

### `PUT /lights/{id}` — register a light for this session

`id`: `^[a-z0-9][a-z0-9-]{0,31}$`.

```json
{ "switchAddress": "0/0/1", "statusAddress": "0/0/2", "dpt": "1.001", "onLevel": 100 }
```

Addresses accept 3-level, 2-level and free format and are normalized to 3-level.
Both addresses must be allowlisted. Response: `{ "light": LightConfig, "state": LightState }`.

### `GET /lights/{id}` · `DELETE /lights/{id}` (204)

### `GET /lights/{id}/state[?refresh=1]` → `LightState`

`refresh=1` sends a GroupValueRead to the status address (or the switching
address if none) and waits up to 2.5 s.

```json
{ "lightId": "primary", "value": "on", "via": "status_address", "at": "2026-10-15T21:22:57.758Z", "payload": 1 }
```

`value`: `on | off | unknown`. `via`: `status_address` (actuator feedback telegram),
`read_response` (answer to a read), `switch_address` (another device wrote the
switching address — observed, not actuator feedback), `none`.

### `POST /lights/{id}/on` · `POST /lights/{id}/off`

```json
{ "requestId": "cmd-lz1x8k-3-1f2e3d4c", "source": "gesture" }
```

`source`: `manual | lamp | keyboard | gesture | voice | test`. Requests with a
`requestId` seen in the last 120 s return the cached response **without sending
again** (safe client retries). Rate limits: per session (default 6 / 10 s) and
global (default 20 / 10 s).

```json
{
  "requestId": "cmd-lz1x8k-3-1f2e3d4c",
  "lightId": "primary",
  "value": "on",
  "outcome": "bus_confirmed",
  "confirmation": "interface_positive",
  "detail": "The KNX interface confirmed transmission on the bus (positive L_Data.con). Device state is reported separately via the status address.",
  "telegram": { "destination": "0/0/1", "payload": 1 },
  "at": "2026-10-15T21:06:13.133Z"
}
```

| outcome | confirmation | Meaning |
| --- | --- | --- |
| `bus_confirmed` | `interface_positive` | Tunnelling interface returned a positive `L_Data.con` |
| `sent_unconfirmed` | `local` | Routing multicast — no bus confirmation possible |
| `sent_unconfirmed` | `none` | Handed to the interface without a confirmation frame (unexpected) |

Negative confirmations and missing confirmations are **errors**
(`KNX_NEGATIVE_CONFIRMATION`, `KNX_CONFIRMATION_TIMEOUT`), never successes.
A confirmed transmission is **not** device state — that only comes from the
status address or read responses.

Payload encoding: DPT 1.001 → `1`/`0`; DPT 5.001 → `[round(onLevel·255/100)]` / `[0]`.

### `GET /events` — server-sent events (fetch-based client; `Authorization` header)

Headers: `Content-Type: text/event-stream`, `Cache-Control: no-store, no-transform`,
`X-Accel-Buffering: no`. Max 3 streams per session, 50 total.

| event | data |
| --- | --- |
| `hello` | `{ "bridgeId": "…", "knx": KnxStatus }` — sent immediately |
| `knx.status` | `KnxStatus` on every change |
| `light.state` | `LightState` for this session's lights when their status/feedback address changes |
| `light.command` | `{ requestId, lightId, value, outcome }` for this session's commands |
| `ping` | `{ "t": "…" }` every 15 s |

The stream ends when the session expires or is revoked; the client then reports
"pair again". Clients reconnect with exponential back-off (1 → 15 s) and treat
10 s without a first byte as "stream buffered by a proxy".

## Mapping to the example routes in the brief

| Brief | This contract |
| --- | --- |
| `GET /api/knx/health` | `GET /api/v1/health` (+ `GET /api/v1/knx/status`) |
| `POST /api/knx/connect` | `POST /api/v1/pair` then `POST /api/v1/knx/connect` |
| `POST /api/knx/test` | `POST /api/v1/knx/test` (no bus writes) |
| `POST /api/knx/lights/:id/on` | `POST /api/v1/lights/:id/on` (after `PUT /api/v1/lights/:id`) |
| `POST /api/knx/lights/:id/off` | `POST /api/v1/lights/:id/off` |
| `GET /api/knx/lights/:id/state` | `GET /api/v1/lights/:id/state[?refresh=1]` + `GET /api/v1/events` |
| `POST /api/knx/disconnect` | `POST /api/v1/knx/disconnect` · `POST /api/v1/session/revoke` |

These routes are served by the **bridge on the customer's LAN**, not by Vercel —
serverless functions cannot reach a private network, send KNXnet/IP UDP or keep
a tunnel open. The Vercel deployment only serves the UI and `GET /api/health`.

---

## Device API (hub, bridge ≥ 1.1.0)

Unified devices across integrations (`simulated`, `shelly`, `homeassistant`, `knx`). All routes
require `Authorization: Bearer <token>` (same pairing/session as above). Errors use the same
`{ "error": { "code", "message", "hint" } }` body. Device-level authentication failures are reported
as **502** (`SHELLY_AUTH_FAILED`, `HA_AUTH_FAILED`), never 401, which always means "SE7ENX session
invalid".

### Device object (`GET /devices` → `{ "devices": [Device], "safety": Safety }`)

```json
{
  "id": "kitchen", "name": "Kitchen", "type": "light", "integration": "knx", "simulated": false,
  "model": "KNX group-address mapping",
  "capabilities": ["brightness", "dim_relative", "on_off"],
  "commands": ["turn_on", "turn_off", "toggle", "set_brightness", "dim"],
  "controlEnabled": false, "controlAllowed": false, "hidden": false, "metadata": { "room": "Ground floor" },
  "connection": { "status": "online", "lastSeen": "2026-10-17T12:00:00Z", "lastError": null },
  "state": { "reported": { "on": true, "brightness": 40 }, "reportedAt": "…", "source": "status",
             "requested": null, "requestedAt": null, "pending": false },
  "config": { "switch": "1/1/1", "switchStatus": "1/1/2", "brightness": "1/2/1" },
  "credentialsStored": false, "diagnostics": { }
}
```

* `type`: `light | switch | outlet | cover | sensor`. `connection.status`: `online | offline |
  unauthorized | unavailable | error | unknown`.
* `commands` are derived from the capabilities the device actually reports. Sensors have none.
* Conventions: `brightness` and `position` are 0–100; **position 100 = open** (KNX inversion
  handled by the hub); `power` W, `energy` Wh.
* `state.reported` comes from the device. `state.requested` is what was asked and not yet confirmed.

### Routes

| Route | Description |
| --- | --- |
| `GET /devices`, `GET /devices/{id}` | List / one device |
| `POST /devices` | Add: `{ "device": DeviceConfig, "credentials"?: { "username"?, "password" } }` → `201 Device`. Real devices are **always created with `controlEnabled: false`**. Shelly devices are identified first (wrong channel → `400 SHELLY_CHANNEL_NOT_FOUND`); HA entities must exist (`404 HA_ENTITY_NOT_FOUND`); KNX addresses must lie inside `SE7ENX_ALLOWED_GROUP_ADDRESSES` when set (`403 GA_NOT_ALLOWED`) |
| `PATCH /devices/{id}` | `{ name?, hidden?, metadata?, controlEnabled?, acknowledgeRealControl? }`. Enabling control of a real device requires `acknowledgeRealControl: true` (`400 ACKNOWLEDGEMENT_REQUIRED`) |
| `DELETE /devices/{id}` | `204`, also deletes stored credentials |
| `POST /devices/{id}/commands` | `{ "command", "params", "requestId", "source" }` → `{ "outcome": "confirmed" \| "accepted" \| "simulated", "delivery", "detail", "device" }` |
| `POST /devices/{id}/refresh` | Ask the device for fresh state |
| `GET /integrations` | `{ "integrations": [{ name, state, detail, lastSuccessAt, lastError, … }], "persistent": bool }` |
| `GET /safety` · `POST /safety/stop` · `POST /safety/resume` | Hub-wide emergency stop for real devices (all clients) |
| `GET /config/export` | Configuration **without credentials** (attachment) |
| `POST /integrations/shelly/identify` | `{ host, username?, password? }` → model, generation, firmware, channels with capabilities. Nothing is saved; only local addresses |
| `GET` / `PUT` / `DELETE /integrations/homeassistant` | Status + config (`tokenStored` only, never the token). `PUT { url, token?, verifyTls }`. `409 HA_CONFIGURED_BY_ENV` when set via environment |
| `POST /integrations/homeassistant/test` | One-shot connection test with given or stored URL/token |
| `GET /integrations/homeassistant/entities` | Supported entities (light, switch, input_boolean, cover, sensor, binary_sensor) |

Commands and parameters:

| Command | Params | Capability |
| --- | --- | --- |
| `turn_on`, `turn_off`, `toggle` | – | `on_off` |
| `set_brightness` | `{ "brightness": 0–100 }` (absolute) | `brightness` |
| `dim` | `{ "direction": "up" \| "down" \| "stop", "step"?: 1–100 }` (relative, start/stop) | `dim_relative` |
| `open`, `close` | – | `open_close` |
| `stop` | – | `stop` |
| `set_position` | `{ "position": 0–100 }` (100 = open) | `position` |

Command policy errors: `400 UNSUPPORTED_COMMAND`, `403 CONTROL_NOT_ENABLED`, `423 SAFETY_STOP_ACTIVE`,
`503 DEVICE_UNAVAILABLE`, `429 DEVICE_RATE_LIMITED` (per-device minimum interval), `409 DEVICE_BUSY`,
`504 DEVICE_TIMEOUT`, plus protocol errors (`KNX_NEGATIVE_CONFIRMATION`, `SHELLY_UNREACHABLE`,
`HA_SERVICE_FAILED`, …).

### Events (`GET /events`)

In addition to the events above: `device.state` (full Device), `device.removed` (`{ id }`),
`integration.status`, `safety`. These are hub-wide and sent to every session.

## SE7ENX Core API: accounts, roles, building, ledger (hub ≥ 1.3, M1)

### Authentication modes

| Mode | When | Transport |
| --- | --- | --- |
| **Account, cookie** | UI served by the hub (appliance, same origin) | `HttpOnly; SameSite=Strict; Path=/` cookie `se7enx_session` (`__Host-se7enx_session` + `Secure` under HTTPS). **Unsafe methods must carry a same-origin `Origin`** (or `Sec-Fetch-Site: same-origin`), otherwise `403 CSRF_REJECTED`. |
| **Account, bearer** | Allowed cross-origin web apps (`SE7ENX_ALLOWED_ORIGINS`), scripts | `Authorization: Bearer <token>`; the token is returned once by sign-in when `transport: "bearer"` is requested or the request is cross-origin. |
| **Legacy pairing** | Only while **no account exists** | `POST /pair` → bearer token with full rights. After the owner account is created: `403 PAIRING_DISABLED`, and existing pairing sessions are revoked. |

Every route except the public ones below requires a session **and a permission**. Roles and default permissions are listed
by `GET /roles`; the matrix is in `bridge/se7enx_bridge/core/rbac.py`. A refusal is `403 FORBIDDEN`, its hint names the
missing permission, and it is recorded in the ledger as `access.denied`.

### Public routes (rate limited per IP)

| Route | Body | Notes |
| --- | --- | --- |
| `GET /auth/status` | – | `{mode: "accounts"\|"pairing", setupRequired, registration, passwordMinLength, me}`; `me` is set when the request carries a valid session |
| `POST /auth/setup` | `{setupCode, username, displayName, password, email?, remember, transport, clientName}` | Only while no account exists. `setupCode` = console code (`SE7ENX_PAIRING_CODE` or the rotating code). The password is validated **before** the single-use code is spent. `201` + session |
| `POST /auth/login` | `{login, password, remember, transport, clientName}` | `login` = username or e-mail. Errors: `401 LOGIN_FAILED` (generic for unknown users and wrong passwords), `429 TOO_MANY_ATTEMPTS` (progressive lockout per login name), `403 ACCOUNT_DISABLED` |
| `POST /auth/register` | `{inviteCode?, username, displayName, password, email?, …}` | Allowed only when `registration` is `invite` (code required) or `open` (role `user`); else `403 REGISTRATION_DISABLED` |
| `POST /auth/reset` | `{code, newPassword, …}` | Redeems a one-time reset code (admin-issued or CLI), revokes all sessions of that user, signs in |

Session responses: `{user, permissions[], preferences, session, transport, token?}`.

### Own account

`POST /auth/logout` (204, clears the cookie) · `GET /auth/me` · `PATCH /auth/me` `{displayName?, email?, preferences?}` ·
`POST /auth/password` `{currentPassword, newPassword}` (revokes the other sessions) · `GET /auth/sessions` ·
`DELETE /auth/sessions/{id}`.

`preferences`: `language` (en/fr/ar/dz), `theme`, `personality` (professional/friendly/playful), `guideLevel`,
`guideEnabled`, `reducedMotion`, `homeView`, `dismissed[]`. At most 4 KB.

### Administration

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /users` · `POST /users` · `PATCH /users/{id}` · `DELETE /users/{id}` | `user.manage` | Rank rule: only users ranked **below** you (owner: everyone). The last active owner can't be demoted, disabled or deleted. No self role change or self-disable. `POST /users` without `password` returns `setupCode {code, expiresAt}` (24 h, single use) |
| `POST /users/{id}/reset-code` | `user.manage` | `{code, expiresAt}`; valid 30 min, single use, replaces older codes |
| `GET /invites` · `POST /invites {role, ttlHours}` · `DELETE /invites/{id}` | `user.manage` | The code is returned once |
| `GET /roles` | `user.manage` or `role.manage` | `{roles, rank, editable, permissions{key: description}, matrix{role: [perm]}}` |
| `PUT /roles/{role}` `{permissions}` | `role.manage` | The owner role can't be edited; only the owner edits `admin` or grants `role.manage` / `system.configure`; you can't grant what you don't hold |
| `GET`/`PUT /system/security` `{registration}` | `system.configure` | `disabled` (default), `invite` or `open` |
| `GET /audit?limit&before&action&actor&targetType&targetId&outcome` | `audit.view` | Ledger entries, newest first: `{id, at, actor{id,name,role}, source, action, target, outcome, details}`; `next` = cursor |

### Building model

| Route | Permission |
| --- | --- |
| `GET /building` → `{sites, buildings, floors, rooms, zones, placement{roomId: [deviceId]}}` | `building.view` |
| `POST /building/{sites\|buildings\|floors\|rooms\|zones}` | `building.edit` |
| `PATCH /building/{collection}/{id}` | `building.edit` |
| `DELETE /building/{collection}/{id}[?cascade=true]` → `{deleted, unassignedDevices}` | `building.edit` |
| `POST /building/import` `{sites: [{id? \| name, timezone?, buildings: [{name, kind, floors: [{name, level, rooms: [{name, kind}]}]}]}]}` (atomic) | `building.edit` |
| `PUT /devices/{id}/room` `{roomId \| null}` | `device.configure` |

Errors: `409 NAME_TAKEN` (siblings, case-insensitive), `422 PARENT_NOT_FOUND`, `422 ROOM_NOT_IN_BUILDING` (zones),
`409 NOT_EMPTY` (delete without cascade), `422 MOVE_ACROSS_BUILDINGS`. Devices are never deleted by a cascade: they are
only un-assigned.

### Recovery (host console)

```bash
se7enx-bridge users                       # list accounts
se7enx-bridge reset-password <username>   # prints a one-time reset code (30 min); enter it in "I have a reset code"
# Docker: docker compose exec se7enx se7enx-bridge reset-password <username>
```
