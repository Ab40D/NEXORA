"""In-process pub/sub used to feed the server-sent event streams."""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Event:
    type: str
    data: dict[str, Any]
    session_id: str | None = None


@dataclass(eq=False)  # identity semantics: subscriptions live in a set
class Subscription:
    queue: asyncio.Queue[Event] = field(default_factory=lambda: asyncio.Queue(maxsize=256))
    _broker: EventBroker | None = None

    async def get(self) -> Event:
        return await self.queue.get()

    def close(self) -> None:
        if self._broker is not None:
            self._broker._subs.discard(self)
            self._broker = None


class EventBroker:
    def __init__(self) -> None:
        self._subs: set[Subscription] = set()

    def subscribe(self) -> Subscription:
        sub = Subscription(_broker=self)
        self._subs.add(sub)
        return sub

    def publish(self, type_: str, data: dict[str, Any], session_id: str | None = None) -> None:
        ev = Event(type=type_, data=data, session_id=session_id)
        for sub in list(self._subs):
            q = sub.queue
            if q.full():  # slow consumer: drop the oldest event rather than block the bus
                with contextlib.suppress(asyncio.QueueEmpty):
                    q.get_nowait()
            q.put_nowait(ev)

    @property
    def subscriber_count(self) -> int:
        return len(self._subs)
