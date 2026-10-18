"""KNX connectivity via xknx.

Responsibilities:
  * own the single XKNX instance (tunnelling UDP/TCP, KNX Secure, routing)
  * send GroupValueWrite / GroupValueRead telegrams and report what the
    interface confirmed (positive / negative L_Data.con, timeout)
  * track the last value seen on every group address (status feedback)
  * supervise the connection and publish status changes

Confirmation semantics (never overstated):
  bus_confirmed      the tunnelling interface returned a POSITIVE L_Data.con
  sent_unconfirmed   routing (multicast): L_Data.con is generated locally by
                     xknx, so no bus-level confirmation exists
Device state is a separate concern and only comes from telegrams on the
status address or answers to GroupValueRead.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from xknx import XKNX
from xknx.cemi import CEMIFrame, CEMIHandler, CEMILData, CEMIMessageCode
from xknx.core import XknxConnectionState
from xknx.dpt import DPTArray, DPTBinary
from xknx.exceptions import CommunicationError, ConfirmationError, XKNXException
from xknx.io import ConnectionConfig, ConnectionType, GatewayScanner, SecureConfig
from xknx.telegram import GroupAddress, Telegram, TelegramDirection
from xknx.telegram.apci import GroupValueRead, GroupValueResponse, GroupValueWrite

from .config import Settings

log = logging.getLogger("se7enx.knx")

CONNECT_TIMEOUT_S = 20.0
SEND_TIMEOUT_S = 6.0

_TYPE_MAP = {
    "automatic": ConnectionType.AUTOMATIC,
    "tunneling": ConnectionType.TUNNELING,
    "tunneling_tcp": ConnectionType.TUNNELING_TCP,
    "tunneling_tcp_secure": ConnectionType.TUNNELING_TCP_SECURE,
    "routing": ConnectionType.ROUTING,
    "routing_secure": ConnectionType.ROUTING_SECURE,
}


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class KnxError(Exception):
    """KNX failure with a stable code, a human message and an actionable hint."""

    def __init__(self, code: str, message: str, *, hint: str | None = None, status: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.status = status


@dataclass(frozen=True)
class GatewayTarget:
    connection_type: str
    host: str | None
    port: int
    route_back: bool | None = None  # None = use SE7ENX_KNX_ROUTE_BACK (UI-configured interfaces set it)


@dataclass
class GaValue:
    payload: int | list[int]
    kind: str  # "write" | "response"
    at: str
    source: str


@dataclass
class KnxStatus:
    state: str = "disconnected"  # disconnected | connecting | connected | error
    connection_type: str = "automatic"
    gateway_host: str | None = None
    gateway_port: int | None = None
    gateway_name: str | None = None
    gateway_ia: str | None = None
    local_address: str | None = None
    since: str | None = None
    last_error: tuple[str, str] | None = None
    secure: bool = False

    def to_dict(self) -> dict[str, Any]:
        gateway = None
        if self.gateway_host or self.gateway_name:
            gateway = {
                "host": self.gateway_host,
                "port": self.gateway_port,
                "name": self.gateway_name,
                "individualAddress": self.gateway_ia,
            }
        return {
            "state": self.state,
            "connectionType": self.connection_type,
            "gateway": gateway,
            "localAddress": self.local_address,
            "since": self.since,
            "lastError": {"code": self.last_error[0], "message": self.last_error[1]} if self.last_error else None,
            "confirmation": "local" if self.connection_type.startswith("routing") else "interface",
            "secure": self.secure,
        }


class ConfirmingCEMIHandler(CEMIHandler):
    """CEMIHandler that additionally records the confirm flag of L_Data.con frames.

    xknx waits for the arrival of L_Data.con before releasing a send, but does
    not distinguish positive from negative confirmations. We need that
    distinction to never report a failed transmission as confirmed.
    """

    def __init__(self, xknx: XKNX) -> None:
        super().__init__(xknx)
        self.last_confirmation: tuple[str, bool] | None = None  # (destination, confirm_error)

    def handle_cemi_frame(self, cemi: CEMIFrame) -> None:
        if cemi.code is CEMIMessageCode.L_DATA_CON and isinstance(cemi.data, CEMILData):
            self.last_confirmation = (str(cemi.data.dst_addr), bool(cemi.data.flags.confirm_error))
        super().handle_cemi_frame(cemi)


def payload_to_json(value: DPTBinary | DPTArray) -> int | list[int]:
    if isinstance(value, DPTBinary):
        return int(value.value)
    return [int(b) for b in value.value]


def _map_connect_error(err: BaseException, target: GatewayTarget) -> KnxError:
    where = f"{target.host}:{target.port}" if target.host else "the KNX network"
    if isinstance(err, TimeoutError):
        return KnxError(
            "KNX_CONNECT_TIMEOUT",
            f"No answer from the KNX interface at {where} within {CONNECT_TIMEOUT_S:.0f} s.",
            hint="Check the interface IP/port, that it is powered and reachable from the bridge host (same subnet, no firewall blocking UDP/TCP 3671).",
            status=504,
        )
    text = str(err) or err.__class__.__name__
    if "No Gateways found" in text or ("Gateway" in text and target.connection_type == "automatic"):
        return KnxError(
            "KNX_NO_GATEWAY_FOUND",
            "Automatic discovery found no KNXnet/IP interface or router.",
            hint="Set SE7ENX_KNX_GATEWAY_IP to your interface address. Discovery uses multicast, which some networks (Wi-Fi isolation, Docker bridge mode, VLANs) block.",
        )
    if "Secure" in err.__class__.__name__ or "secure" in text.lower() or "keyring" in text.lower():
        return KnxError(
            "KNX_SECURE_ERROR",
            f"KNX Secure handshake failed: {text}",
            hint="Check the keyring file/password or the tunnel user id and passwords configured on the bridge.",
        )
    return KnxError(
        "KNX_CONNECT_FAILED",
        f"Could not connect to the KNX interface at {where}: {text}",
        hint="Common causes: wrong IP or connection type, all tunnelling slots of the interface are in use, or the interface only accepts KNX Secure.",
    )


class KnxService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.xknx: XKNX | None = None
        self._status = KnxStatus(connection_type=settings.connection_type, secure=settings.secure)
        self._send_lock = asyncio.Lock()
        self._connect_lock = asyncio.Lock()
        self._target: GatewayTarget | None = None
        self._generation = 0
        self._starting = False
        self._want_connected = False
        self._supervisor: asyncio.Task[None] | None = None
        self.values: dict[str, GaValue] = {}
        # Last telegram sent by a device on the bus (not by the interface/knxd or by us): evidence that
        # the bus behind the interface is really reachable. A connected tunnel alone does not prove it.
        self.bus_activity: dict[str, str] | None = None
        self._value_listeners: list[Callable[[str, GaValue], None]] = []
        self._status_listeners: list[Callable[[KnxStatus], None]] = []

    # ------------------------------------------------------------------ state

    @property
    def status(self) -> KnxStatus:
        return self._status

    @property
    def connected(self) -> bool:
        return self.xknx is not None and self._status.state == "connected"

    @property
    def is_routing(self) -> bool:
        return self._status.connection_type.startswith("routing")

    def on_value(self, fn: Callable[[str, GaValue], None]) -> None:
        self._value_listeners.append(fn)

    def on_status(self, fn: Callable[[KnxStatus], None]) -> None:
        self._status_listeners.append(fn)

    def off_status(self, fn: Callable[[KnxStatus], None]) -> None:
        if fn in self._status_listeners:
            self._status_listeners.remove(fn)

    def _set_status(self, **changes: Any) -> None:
        for k, v in changes.items():
            setattr(self._status, k, v)
        for fn in self._status_listeners:
            try:
                fn(self._status)
            except Exception:  # pragma: no cover - defensive
                log.exception("status listener failed")

    # ------------------------------------------------------------ lifecycle

    def default_target(self) -> GatewayTarget:
        s = self.settings
        return GatewayTarget(s.connection_type, s.gateway_ip, s.gateway_port)

    async def start(self) -> None:
        if self.settings.autoconnect:
            self._want_connected = True
            self._supervisor = asyncio.create_task(self._supervise(), name="se7enx-knx-supervisor")

    async def reconfigure(self, target: GatewayTarget | None) -> KnxStatus:
        """Apply an interface configured on the hub (UI). ``None`` disconnects and stops supervising.

        Uses the same supervised connection as environment configuration: initial connection with
        back-off, then xknx's own reconnect, with the supervisor stepping in if xknx gives up.
        """
        await self.stop()
        if target is None:
            self._set_status(state="disconnected", last_error=None)
            return self.status
        self._target = target
        self._want_connected = True
        self._supervisor = asyncio.create_task(self._supervise(), name="se7enx-knx-supervisor")
        return self.status

    async def stop(self) -> None:
        self._want_connected = False
        if self._supervisor:
            self._supervisor.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._supervisor
            self._supervisor = None
        await self._teardown()

    async def _supervise(self) -> None:
        """Initial connection with back-off. After a successful start, xknx's own
        auto-reconnect keeps a tunnel alive; we only step in if it gave up."""
        delay = 5.0
        while self._want_connected:
            if self.xknx is None:
                try:
                    await self.connect(self._target)
                    delay = 5.0
                except KnxError as err:
                    log.warning("KNX connection failed (%s): %s — retrying in %.0f s", err.code, err.message, delay)
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 60.0)
                    continue
                except Exception:  # pragma: no cover - defensive
                    log.exception("unexpected error while connecting")
                    await asyncio.sleep(delay)
                    continue
            elif self._status.state == "disconnected" and not self._starting:
                log.warning("KNX link lost and not recovered by xknx — restarting connection")
                await self._teardown()
                continue
            await asyncio.sleep(5)

    def _connection_config(self, target: GatewayTarget) -> ConnectionConfig:
        s = self.settings
        secure: SecureConfig | None = None
        if s.keyring_path or s.secure_user_id or s.backbone_key:
            secure = SecureConfig(
                backbone_key=s.backbone_key,
                user_id=s.secure_user_id,
                user_password=s.secure_user_password,
                device_authentication_password=s.secure_device_auth_password,
                knxkeys_file_path=s.keyring_path,
                knxkeys_password=s.keyring_password,
            )
        return ConnectionConfig(
            connection_type=_TYPE_MAP[target.connection_type],
            gateway_ip=target.host if not target.connection_type.startswith("routing") else None,
            gateway_port=target.port,
            local_ip=s.local_ip,
            route_back=s.route_back if target.route_back is None else target.route_back,
            individual_address=s.individual_address,
            multicast_group=s.multicast_group,
            multicast_port=s.multicast_port,
            auto_reconnect=True,
            auto_reconnect_wait=3,
            secure_config=secure,
        )

    async def connect(self, target: GatewayTarget | None = None) -> KnxStatus:
        target = target or self.default_target()
        async with self._connect_lock:
            if self.xknx is not None and self._status.state == "connected" and target == self._target:
                return self._status
            await self._teardown()
            self._generation += 1
            gen = self._generation
            self._starting = True
            self._set_status(
                state="connecting",
                connection_type=target.connection_type,
                gateway_host=target.host,
                gateway_port=target.port if target.host else None,
                gateway_name=None,
                gateway_ia=None,
                last_error=None,
            )

            def on_conn_state(state: XknxConnectionState) -> None:
                if gen == self._generation:
                    self._on_connection_state(state)

            xknx = XKNX(
                connection_config=self._connection_config(target),
                connection_state_changed_cb=on_conn_state,
                rate_limit=0,
                state_updater=False,
                multicast_group=self.settings.multicast_group,
                multicast_port=self.settings.multicast_port,
            )
            xknx.cemi_handler = ConfirmingCEMIHandler(xknx)
            xknx.telegram_queue.register_telegram_received_cb(self._on_telegram)
            try:
                await asyncio.wait_for(xknx.start(), timeout=CONNECT_TIMEOUT_S)
            except (TimeoutError, XKNXException, OSError, ValueError) as err:
                self._starting = False
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(xknx.stop(), timeout=5)
                mapped = _map_connect_error(err, target)
                self._set_status(state="error", last_error=(mapped.code, mapped.message))
                raise mapped from err

            self.xknx = xknx
            self._target = target
            self._want_connected = True
            name = ia = None
            if not target.connection_type.startswith("routing"):
                with contextlib.suppress(Exception):
                    info = await asyncio.wait_for(xknx.knxip_interface.gateway_info(), timeout=3)
                    if info is not None:
                        name = info.name or None
                        ia = str(info.individual_address) if info.individual_address else None
                        if info.ip_addr and not target.host:
                            self._status.gateway_host = info.ip_addr
                            self._status.gateway_port = info.port
            self._starting = False
            self._set_status(
                state="connected",
                since=now_iso(),
                local_address=str(xknx.current_address),
                gateway_name=name,
                gateway_ia=ia,
                last_error=None,
            )
            log.info("KNX connected: %s", self._status.to_dict())
            if self._supervisor is None and self.settings.autoconnect:
                self._supervisor = asyncio.create_task(self._supervise(), name="se7enx-knx-supervisor")
            return self._status

    def _on_connection_state(self, state: XknxConnectionState) -> None:
        if self._starting or self.xknx is None:
            return
        if state == XknxConnectionState.CONNECTED:
            self._set_status(
                state="connected", since=now_iso(), local_address=str(self.xknx.current_address), last_error=None
            )
        elif state == XknxConnectionState.CONNECTING:
            self._set_status(state="connecting")
        else:
            self._set_status(
                state="connecting",
                last_error=("KNX_LINK_LOST", "Connection to the KNX interface was lost; reconnecting."),
            )

    async def _teardown(self) -> None:
        x, self.xknx = self.xknx, None
        self._generation += 1
        if x is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(x.stop(), timeout=8)
        if self._status.state != "disconnected":
            self._set_status(state="disconnected", since=None, local_address=None)

    async def disconnect(self) -> KnxStatus:
        self._want_connected = False
        if self._supervisor:
            self._supervisor.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._supervisor
            self._supervisor = None
        async with self._connect_lock:
            await self._teardown()
        return self._status

    # -------------------------------------------------------------- telegrams

    def _on_telegram(self, telegram: Telegram) -> None:
        if telegram.direction is not TelegramDirection.INCOMING:
            return
        if not isinstance(telegram.destination_address, GroupAddress):
            return
        payload = telegram.payload
        if isinstance(payload, GroupValueWrite):
            kind = "write"
        elif isinstance(payload, GroupValueResponse):
            kind = "response"
        else:
            return
        try:
            value = payload_to_json(payload.value)
        except Exception:  # pragma: no cover - undecodable payload
            return
        ga = str(telegram.destination_address)
        src = str(telegram.source_address)
        gv = GaValue(payload=value, kind=kind, at=now_iso(), source=src)
        self.values[ga] = gv
        if src not in (self._status.local_address, self._status.gateway_ia, "0.0.0"):
            self.bus_activity = {"source": src, "groupAddress": ga, "kind": kind, "at": gv.at}
        for fn in self._value_listeners:
            try:
                fn(ga, gv)
            except Exception:  # pragma: no cover - defensive
                log.exception("value listener failed")

    def _require_connected(self) -> XKNX:
        if self.xknx is None or self._status.state != "connected":
            st = self._status.state
            raise KnxError(
                "KNX_NOT_CONNECTED",
                "The bridge is not connected to the KNX interface."
                if st != "connecting"
                else "The KNX connection is being (re)established.",
                hint="Wait for the connection or use Test connectivity in the wizard. Check the bridge logs for the cause.",
                status=409,
            )
        return self.xknx

    async def _send(self, xknx: XKNX, telegram: Telegram) -> tuple[str, str]:
        handler = xknx.cemi_handler
        async with self._send_lock:
            if isinstance(handler, ConfirmingCEMIHandler):
                handler.last_confirmation = None
            try:
                await asyncio.wait_for(xknx.telegram_queue.process_telegram_outgoing(telegram), timeout=SEND_TIMEOUT_S)
            except ConfirmationError as err:
                raise KnxError(
                    "KNX_CONFIRMATION_TIMEOUT",
                    "The KNX interface did not confirm the telegram (no L_Data.con within 3 s). It may not have reached the bus.",
                    hint="The interface may be overloaded or not attached to the bus, or the tunnel is broken. Check the interface and the bus power supply.",
                    status=504,
                ) from err
            except CommunicationError as err:
                raise KnxError(
                    "KNX_COMMUNICATION_ERROR",
                    f"Sending to the KNX interface failed: {err}",
                    hint="The tunnel connection was interrupted; the bridge reconnects automatically. Try again in a few seconds.",
                    status=502,
                ) from err
            except TimeoutError as err:
                raise KnxError("KNX_SEND_TIMEOUT", "Sending the telegram timed out.", status=504) from err
            confirmation = handler.last_confirmation if isinstance(handler, ConfirmingCEMIHandler) else None
        if self.is_routing:
            return "sent_unconfirmed", "local"
        if confirmation is None:
            return "sent_unconfirmed", "none"
        _dst, confirm_error = confirmation
        if confirm_error:
            raise KnxError(
                "KNX_NEGATIVE_CONFIRMATION",
                "The KNX interface reported that the telegram could not be transmitted on the bus (negative L_Data.con).",
                hint="Check the KNX line (bus power supply, wiring) and that the interface is connected to the bus.",
                status=502,
            )
        return "bus_confirmed", "interface_positive"

    async def write(self, ga: str, value: DPTBinary | DPTArray) -> tuple[str, str]:
        xknx = self._require_connected()
        telegram = Telegram(destination_address=GroupAddress(ga), payload=GroupValueWrite(value))
        return await self._send(xknx, telegram)

    async def read(self, ga: str, wait_s: float = 2.5) -> GaValue | None:
        xknx = self._require_connected()
        target = GroupAddress(ga)
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[Telegram] = loop.create_future()

        def cb(t: Telegram) -> None:
            if (
                t.direction is TelegramDirection.INCOMING
                and isinstance(t.payload, GroupValueResponse | GroupValueWrite)
                and not fut.done()
            ):
                fut.set_result(t)

        handle = xknx.telegram_queue.register_telegram_received_cb(cb, group_addresses=[target])
        try:
            await self._send(xknx, Telegram(destination_address=target, payload=GroupValueRead()))
            t = await asyncio.wait_for(fut, timeout=wait_s)
        except TimeoutError:
            return None
        finally:
            with contextlib.suppress(ValueError):
                xknx.telegram_queue.unregister_telegram_received_cb(handle)
        assert isinstance(t.payload, GroupValueResponse | GroupValueWrite)
        return GaValue(
            payload=payload_to_json(t.payload.value),
            kind="response" if isinstance(t.payload, GroupValueResponse) else "write",
            at=now_iso(),
            source=str(t.source_address),
        )

    # ---------------------------------------------------------------- helpers

    async def gateway_description(self) -> tuple[bool, str]:
        xknx = self._require_connected()
        if self.is_routing:
            return True, "Routing (multicast) has no single interface to query."
        try:
            info = await asyncio.wait_for(xknx.knxip_interface.gateway_info(), timeout=3)
        except Exception as err:
            return False, f"Description request failed: {err}"
        if info is None:
            return False, "The interface did not answer a description request."
        return True, f"“{info.name or 'unnamed'}” ({info.individual_address}) answered a description request."

    async def discover(self, wait_s: float = 3.0) -> list[dict[str, Any]]:
        scanner_xknx = self.xknx or XKNX(
            multicast_group=self.settings.multicast_group, multicast_port=self.settings.multicast_port
        )
        try:
            gateways = await GatewayScanner(
                scanner_xknx, local_ip=self.settings.local_ip, timeout_in_seconds=wait_s
            ).scan()
        except (XKNXException, OSError) as err:
            raise KnxError(
                "KNX_DISCOVERY_FAILED",
                f"Interface discovery failed: {err}",
                hint="Multicast may be blocked on this network.",
            ) from err
        result = []
        for g in gateways:
            result.append(
                {
                    "name": g.name or "KNX/IP device",
                    "host": g.ip_addr,
                    "port": g.port,
                    "individualAddress": str(g.individual_address) if g.individual_address else None,
                    "supportsTunnelling": bool(g.supports_tunnelling),
                    "supportsTunnellingTcp": bool(g.supports_tunnelling_tcp),
                    "supportsRouting": bool(g.supports_routing),
                    "requiresSecure": bool(
                        getattr(g, "tunnelling_requires_secure", False) or getattr(g, "routing_requires_secure", False)
                    ),
                }
            )
        return result


def gateway_allowed(host: str, networks: tuple[ipaddress.IPv4Network, ...]) -> bool:
    try:
        ip = ipaddress.IPv4Address(host)
    except ValueError:
        return False
    return any(ip in n for n in networks)
