# Hardware & real-service test matrix

What has been verified for SE7ENX 1.1.0, and what still needs physical equipment or a real
installation. **"Fake" means a protocol-level simulator written from the official documentation**
(`bridge/tools/fake_shelly.py`, `fake_homeassistant.py`, `fake_knx_interface.py`). Fakes prove that
SE7ENX speaks the documented protocol correctly. They do not prove compatibility with every
firmware version.

Legend: ✅ verified · 🧪 verified against a fake only · ⬜ not tested (needs hardware / real service)

## Shelly

| Case | Gen1 (e.g. Shelly 1, 2.5, Dimmer 2) | Gen2+ (Plus / Pro / Gen3 / Gen4) |
| --- | --- | --- |
| Identify model, firmware, generation via `/shelly` | 🧪 | 🧪 |
| Authentication (Gen1 Basic / Gen2+ digest SHA-256), wrong password, throttling (429) | 🧪 | 🧪 (429 mapping by code review) |
| Relay on/off/toggle, confirmation by status read-back | 🧪 | 🧪 |
| Power (W) and energy (Wh) where reported; Gen1 watt-minutes → Wh | 🧪 | 🧪 |
| Dimmer brightness + relative dimming (Gen1 `dim=`, Gen2 `Light.DimUp/Down/Stop`) | 🧪 | 🧪 |
| Roller/cover open/close/stop; position only when calibrated | 🧪 (roller mode) | 🧪 |
| Multi-channel devices sharing one poller | 🧪 | 🧪 |
| Device disappears / reappears (offline → online) | 🧪 | 🧪 |
| Real devices of each family | ⬜ | ⬜ |
| Battery / sleeping devices, RGB(W), EM/3EM, PM Mini | ⬜ not supported in 1.1.0 (reported as unsupported components) | ⬜ |

## Home Assistant

| Case | Status |
| --- | --- |
| WebSocket auth (`auth_ok` / `auth_invalid`), `get_states`, `state_changed`, `call_service` | 🧪 |
| Confirmed vs accepted (no feedback, mismatching feedback) | 🧪 |
| HA restart → automatic reconnect | 🧪 |
| Invalid/revoked token → no retry storm | 🧪 |
| HA unreachable (closed port, unroutable address) | ✅ (real network conditions, in tests and in Docker) |
| HA in a separate container, addressed by container name | 🧪 (fake HA in a second container, Docker network) |
| Real Home Assistant (versions, large entity lists, TLS with self-signed cert, Nabu Casa URL) | ⬜ |
| Real lights/covers/sensors through HA, entity `unavailable` handling | ⬜ (🧪 with the fake) |

## KNX

| Case | Status |
| --- | --- |
| Tunnelling UDP with positive / negative `L_Data.con` | 🧪 (real xknx ↔ fake interface) |
| Switch + status feedback; GroupValueRead of feedback addresses at start-up | 🧪 |
| Absolute brightness (5.001) with feedback; relative dimming (3.007) telegram encoding | 🧪 |
| Blinds: 1.008 up/down, stop, 5.001 position with inversion and feedback | 🧪 |
| Sensors (9.001 etc.) via xknx transcoders | 🧪 |
| Only configured addresses written; operator allowlist ceiling | 🧪 |
| Tunnelling TCP, KNX Secure, routing / multicast, discovery | ⬜ |
| Real actuators (dimming curves, blind run times, status object behaviour, read flags) | ⬜ |

## Platform

| Case | Status |
| --- | --- |
| Docker image build (x86-64), Compose start-up, health check, graceful stop | ✅ |
| Read-only rootfs, non-root, persistence across `down`/`up`, backup/restore commands | ✅ |
| Appliance UI in Chromium (pairing, devices, commands, add/remove, emergency stop, export, no off-origin requests) | ✅ (simulated devices) |
| ARM64 / Raspberry Pi build and runtime | ⬜ |
| Safari / Firefox / mobile browsers against the appliance | ⬜ |
| HTTPS via mounted certificate or reverse proxy | ⬜ |
| Proxmox LXC | ⬜ (not provided yet) |

## Suggested acceptance procedure with real hardware

1. Add the device, leave control **disabled**, and compare the reported state with reality (switch it
   by hand / in the vendor app: SE7ENX must follow).
2. Enable control, then send each supported command once while watching the device. Check the outcome:
   *confirmed* only if the device reported the new state.
3. Disconnect the device (power or network): SE7ENX must show offline and refuse commands.
4. Activate **Stop all devices**: commands must be refused (HTTP 423) until resumed.
5. Record model, firmware and results in this table.
