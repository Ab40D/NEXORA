#!/usr/bin/env python3
"""Fake KNXnet/IP tunnelling interface with a simulated switch actuator.

FOR TESTING AND DEVELOPMENT ONLY — it is NOT real hardware and the bridge
reports exactly what this fake answers (its description name says so).

It speaks the real KNXnet/IP UDP tunnelling protocol, so the bridge's xknx
stack is exercised end to end:

  CONNECT_REQUEST/RESPONSE · CONNECTIONSTATE (heartbeat) · DESCRIPTION
  TUNNELLING_REQUEST/ACK in both directions · L_Data.con (positive, negative
  or missing) · L_Data.ind feedback from a simulated actuator · read responses

Usage:
  python tools/fake_knx_interface.py --port 3671 --switch 0/0/1 --status 0/0/2
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
from dataclasses import dataclass, field

from xknx.cemi import CEMIFlags, CEMIFrame, CEMILData, CEMIMessageCode
from xknx.dpt import DPTArray, DPTBinary
from xknx.knxip import (
    HPAI,
    ConnectionStateRequest,
    ConnectionStateResponse,
    ConnectRequest,
    ConnectResponse,
    ConnectResponseData,
    DescriptionRequest,
    DescriptionResponse,
    DIBDeviceInformation,
    DIBServiceFamily,
    DIBSuppSVCFamilies,
    DisconnectRequest,
    DisconnectResponse,
    ErrorCode,
    KNXIPFrame,
    TunnellingAck,
    TunnellingRequest,
)
from xknx.telegram import GroupAddress, IndividualAddress, Telegram
from xknx.telegram.apci import GroupValueRead, GroupValueResponse, GroupValueWrite

log = logging.getLogger("fake-knx")

FAKE_NAME = "SE7ENX FAKE KNX (TEST ONLY)"  # DIB name field: max 30 bytes


@dataclass
class Actuator:
    """Simulated switch actuator channel (DPT 1.001 or a 1-byte value)."""

    switch: str = "0/0/1"
    status: str | None = "0/0/2"
    ia: str = "1.1.10"
    value: int = 0
    binary: bool = True
    readable_switch: bool = False


@dataclass
class Client:
    channel: int
    control_addr: tuple[str, int]
    data_addr: tuple[str, int]
    individual_address: IndividualAddress
    seq_out: int = 0


@dataclass
class FakeInterface(asyncio.DatagramProtocol):
    actuator: Actuator = field(default_factory=Actuator)
    confirm: str = "positive"  # positive | negative | none
    feedback: bool = True
    respond_reads: bool = True
    feedback_delay: float = 0.05
    individual_address: str = "1.1.0"
    max_clients: int = 4
    clients: dict[int, Client] = field(default_factory=dict)
    received: list[tuple[str, str, object]] = field(default_factory=list)  # (service, ga, payload)
    transport: asyncio.DatagramTransport | None = None

    # -------------------------------------------------------------- plumbing

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        assert isinstance(transport, asyncio.DatagramTransport)
        self.transport = transport

    @property
    def address(self) -> tuple[str, int]:
        assert self.transport is not None
        return self.transport.get_extra_info("sockname")[:2]

    def _send(self, body: object, addr: tuple[str, int]) -> None:
        assert self.transport is not None
        self.transport.sendto(KNXIPFrame.init_from_body(body).to_knx(), addr)  # type: ignore[arg-type]

    @staticmethod
    def _endpoint(hpai: HPAI, fallback: tuple[str, int]) -> tuple[str, int]:
        if hpai.ip_addr == "0.0.0.0" or hpai.port == 0:  # route back (NAT)
            return fallback
        return hpai.ip_addr, hpai.port

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        try:
            frame, _ = KNXIPFrame.from_knx(data)
        except Exception as err:
            log.warning("unparsable frame from %s: %s", addr, err)
            return
        body = frame.body
        if isinstance(body, ConnectRequest):
            self._on_connect(body, addr)
        elif isinstance(body, ConnectionStateRequest):
            status = (
                ErrorCode.E_NO_ERROR if body.communication_channel_id in self.clients else ErrorCode.E_CONNECTION_ID
            )
            self._send(
                ConnectionStateResponse(communication_channel_id=body.communication_channel_id, status_code=status),
                self._endpoint(body.control_endpoint, addr),
            )
        elif isinstance(body, DisconnectRequest):
            self.clients.pop(body.communication_channel_id, None)
            self._send(
                DisconnectResponse(communication_channel_id=body.communication_channel_id),
                self._endpoint(body.control_endpoint, addr),
            )
        elif isinstance(body, DescriptionRequest):
            self._on_description(body, addr)
        elif isinstance(body, TunnellingRequest):
            self._on_tunnelling_request(body, addr)
        elif isinstance(body, TunnellingAck):
            pass  # acks for our server->client requests

    # -------------------------------------------------------------- services

    def _on_connect(self, body: ConnectRequest, addr: tuple[str, int]) -> None:
        control = self._endpoint(body.control_endpoint, addr)
        if len(self.clients) >= self.max_clients:
            self._send(ConnectResponse(status_code=ErrorCode.E_NO_MORE_CONNECTIONS), control)
            return
        channel = next(i for i in range(1, 255) if i not in self.clients)
        client = Client(
            channel=channel,
            control_addr=control,
            data_addr=self._endpoint(body.data_endpoint, addr),
            individual_address=IndividualAddress(f"1.1.{240 + channel}"),
        )
        self.clients[channel] = client
        host, port = self.address
        self._send(
            ConnectResponse(
                communication_channel=channel,
                status_code=ErrorCode.E_NO_ERROR,
                data_endpoint=HPAI(ip_addr=host, port=port),
                crd=ConnectResponseData(individual_address=client.individual_address),
            ),
            control,
        )
        log.info("tunnel %s connected from %s as %s", channel, control, client.individual_address)

    def _on_description(self, body: DescriptionRequest, addr: tuple[str, int]) -> None:
        resp = DescriptionResponse()
        info = DIBDeviceInformation()
        info.name = FAKE_NAME
        info.individual_address = IndividualAddress(self.individual_address)
        info.serial_number = "00:fa:00:00:00:01"
        info.mac_address = "02:00:00:00:00:01"
        families = DIBSuppSVCFamilies()
        families.families = [
            DIBSuppSVCFamilies.Family(DIBServiceFamily.CORE, 1),
            DIBSuppSVCFamilies.Family(DIBServiceFamily.DEVICE_MANAGEMENT, 1),
            DIBSuppSVCFamilies.Family(DIBServiceFamily.TUNNELING, 1),
        ]
        resp.dibs = [info, families]
        self._send(resp, self._endpoint(body.control_endpoint, addr))

    def _on_tunnelling_request(self, body: TunnellingRequest, addr: tuple[str, int]) -> None:
        client = self.clients.get(body.communication_channel_id)
        if client is None:
            return
        self._send(
            TunnellingAck(communication_channel_id=client.channel, sequence_counter=body.sequence_counter),
            client.data_addr,
        )
        try:
            cemi = CEMIFrame.from_knx(body.raw_cemi)
        except Exception as err:
            log.warning("bad cemi: %s", err)
            return
        if cemi.code is not CEMIMessageCode.L_DATA_REQ or not isinstance(cemi.data, CEMILData):
            return
        data = cemi.data
        if self.confirm != "none":
            flags = CEMIFlags(
                priority=data.flags.priority,
                repeat_on_error=data.flags.repeat_on_error,
                system_broadcast=data.flags.system_broadcast,
                acknowledge_request=data.flags.acknowledge_request,
                confirm_error=self.confirm == "negative",
                hop_count=data.flags.hop_count,
            )
            con = CEMIFrame(
                code=CEMIMessageCode.L_DATA_CON,
                data=CEMILData(
                    src_addr=client.individual_address,
                    dst_addr=data.dst_addr,
                    flags=flags,
                    tpci=data.tpci,
                    payload=data.payload,
                ),
            )
            self._to_client(client, con)
        if self.confirm == "positive":  # only telegrams that "reached the bus" are seen by the actuator
            telegram = data.telegram()
            self._record(telegram)
            asyncio.get_running_loop().call_later(self.feedback_delay, self._bus_telegram, telegram)

    # -------------------------------------------------------------- simulated bus

    def _to_client(self, client: Client, cemi: CEMIFrame) -> None:
        req = TunnellingRequest(
            communication_channel_id=client.channel, sequence_counter=client.seq_out, raw_cemi=cemi.to_knx()
        )
        client.seq_out = (client.seq_out + 1) % 256
        self._send(req, client.data_addr)

    def _indicate(self, telegram: Telegram, source: str) -> None:
        cemi = CEMIFrame(
            code=CEMIMessageCode.L_DATA_IND,
            data=CEMILData.init_from_telegram(telegram, src_addr=IndividualAddress(source)),
        )
        for client in list(self.clients.values()):
            self._to_client(client, cemi)

    def _payload(self) -> DPTBinary | DPTArray:
        a = self.actuator
        return DPTBinary(a.value) if a.binary else DPTArray((a.value,))

    @staticmethod
    def _write_value(p: GroupValueWrite) -> int:
        v = p.value.value
        return int(v) if isinstance(p.value, DPTBinary) else int(v[0]) if v else 0

    def _record(self, telegram: Telegram) -> None:
        p = telegram.payload
        ga = str(telegram.destination_address)
        if isinstance(p, GroupValueWrite):
            self.received.append(("write", ga, self._write_value(p)))
        elif isinstance(p, GroupValueRead):
            self.received.append(("read", ga, None))

    def _bus_telegram(self, telegram: Telegram) -> None:
        a = self.actuator
        ga = str(telegram.destination_address)
        p = telegram.payload
        if isinstance(p, GroupValueWrite):
            value = self._write_value(p)
            if ga == a.switch:
                a.value = value
                if self.feedback and a.status:
                    self._indicate(
                        Telegram(destination_address=GroupAddress(a.status), payload=GroupValueWrite(self._payload())),
                        a.ia,
                    )
        elif isinstance(p, GroupValueRead):
            if not self.respond_reads:
                return
            if ga == a.status or (ga == a.switch and a.readable_switch):
                self._indicate(
                    Telegram(destination_address=GroupAddress(ga), payload=GroupValueResponse(self._payload())), a.ia
                )

    def external_switch(self, value: int, source: str = "1.1.20") -> None:
        """Simulate a wall switch writing the switching address."""
        a = self.actuator
        self._indicate(
            Telegram(
                destination_address=GroupAddress(a.switch),
                payload=GroupValueWrite(DPTBinary(value) if a.binary else DPTArray((value,))),
            ),
            source,
        )
        a.value = value
        if self.feedback and a.status:
            asyncio.get_running_loop().call_later(
                self.feedback_delay,
                lambda: self._indicate(
                    Telegram(destination_address=GroupAddress(a.status), payload=GroupValueWrite(self._payload())), a.ia
                ),  # type: ignore[arg-type]
            )


async def start_fake_interface(host: str = "127.0.0.1", port: int = 0, **kwargs: object) -> FakeInterface:
    loop = asyncio.get_running_loop()
    _transport, protocol = await loop.create_datagram_endpoint(lambda: FakeInterface(**kwargs), local_addr=(host, port))  # type: ignore[arg-type]
    return protocol


def main() -> None:
    parser = argparse.ArgumentParser(description="Fake KNXnet/IP tunnelling interface for testing (NOT real hardware)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3671)
    parser.add_argument("--switch", default="0/0/1", help="switching group address of the simulated actuator")
    parser.add_argument("--status", default="0/0/2", help="status group address ('' to disable)")
    parser.add_argument("--confirm", choices=["positive", "negative", "none"], default="positive")
    parser.add_argument("--no-feedback", action="store_true")
    parser.add_argument("--readable-switch", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s fake-knx %(message)s")

    async def run() -> None:
        fake = await start_fake_interface(
            args.host,
            args.port,
            actuator=Actuator(switch=args.switch, status=args.status or None, readable_switch=args.readable_switch),
            confirm=args.confirm,
            feedback=not args.no_feedback,
        )
        log.info(
            "%s listening on %s:%s (switch %s, status %s)", FAKE_NAME, *fake.address, args.switch, args.status or "-"
        )
        await asyncio.Event().wait()

    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(run())


if __name__ == "__main__":
    main()
