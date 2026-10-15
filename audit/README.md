# Audit probes

Reproducible checks behind [SECURITY_AUDIT.md](../SECURITY_AUDIT.md). They are **local and
non-destructive**. They run the real bridge code against the **fake** KNXnet/IP interface
(`SE7ENX FAKE KNX (TEST ONLY)`) and a local production build of the web app. They never contact
real KNX hardware, Home Assistant or third parties (off-origin browser requests are recorded and
**aborted**).

> Do not point these probes at a production bridge or a live installation.

## Prerequisites

```bash
npm ci                                   # web app dependencies (also Playwright)
npx playwright install chromium          # browser for the .mjs probes
cd bridge && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]" && cd ..
npm run build && npx next start -H 127.0.0.1 -p 3100   # web app under test (separate terminal)
```

## Probes

| Script | What it checks | How to run | Raw result of the audit run |
| --- | --- | --- | --- |
| [`bridge_probes.py`](bridge_probes.py) | P01–P17: authentication, origin checks, session isolation, authorization gaps, session eviction, audit-log injection, stale state, rate limits, body limits, `X-Forwarded-For` handling, pairing lockout, gateway-override CIDRs, fixed-code strength, safe defaults. Runs the bridge in-process | `bridge/.venv/bin/python audit/bridge_probes.py` | [`results/bridge_probes.txt`](results/bridge_probes.txt) |
| [`storage-and-revocation.mjs`](storage-and-revocation.mjs) | What the browser stores after pairing (`sessionStorage`, `localStorage`, cookies; token values masked) and whether **Disconnect** revokes the token on the bridge | Start the dev stack: `bridge/.venv/bin/python bridge/tools/dev_stack.py --port 8799 --pairing-code AUDIT-0001 --origin http://127.0.0.1:3100`, then `AUDIT_BASE_URL=http://127.0.0.1:3100 node audit/storage-and-revocation.mjs` (optional `AUDIT_BRIDGE_URL`, `AUDIT_PAIRING_CODE`) | [`results/storage_and_revocation.txt`](results/storage_and_revocation.txt) |
| [`network-egress.mjs`](network-egress.mjs) | Every network request the app makes during simulation and ≥ 60 s of hand tracking (Chromium fake camera); off-origin requests are logged with header names and body size, then aborted | `AUDIT_BASE_URL=http://127.0.0.1:3100 AUDIT_CAMERA_SECONDS=75 node audit/network-egress.mjs` | [`results/network_egress.txt`](results/network_egress.txt) |

## Reading the results

* `PASS`: the control works as intended.
* `CONFIRMED`: the weakness described in the probe exists (see the matching SE7-xx finding).
* `INFO`: a measurement without a pass/fail verdict.

When a finding is fixed, the corresponding probe should flip from `CONFIRMED` to `PASS` (or the
egress probe should report `off-origin requests: 0`). Add a regular regression test at the same time.
