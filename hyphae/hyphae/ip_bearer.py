"""Hyphae bearer: real IP networking (UDP).

This is the first *non-simulated* bearer — it moves frames over actual network
sockets, not an in-process queue. On the target device (a Raspberry Pi) both
Wi-Fi and cellular present to the OS as ordinary IP interfaces, so this single
bearer is the path those two radios ride: bind a local UDP socket, send frames
as datagrams to a peer, and drain whatever has arrived on each ``poll()``.

Datagrams can be lost or reordered — which is fine, because L2 fountain coding
reassembles a bundle from whatever fragments arrive. Frames must fit one
datagram; keep the sender's fountain ``block_size`` well under the path MTU
(~1200 bytes is safe on the open internet; localhost tolerates much more).

Legality is a property of the *underlying link*, not of IP itself, so it is a
constructor argument: an IP socket over Wi-Fi is ``unlicensed-ism``; the same
socket over a cellular modem is ``licensed-carrier`` (you are a subscriber).
"""
from __future__ import annotations

import socket

from .bearer import Bearer, Capabilities

_MAX_DATAGRAM = 65535


class IPBearer(Bearer):
    """A UDP link to one peer. ``bind`` is (host, port) for this node's socket;
    ``peer`` is (host, port) of the far node's socket."""

    def __init__(
        self,
        bind: tuple[str, int],
        peer: tuple[str, int],
        legal_class: str = "unlicensed-ism",
        name: str = "ip/udp",
        detectability: float = 0.6,
        rate_bps: float = 1e7,
        mtu: int = 1200,
    ):
        self.peer = peer
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(bind)
        self._sock.setblocking(False)
        self.bound = self._sock.getsockname()  # resolved (host, port), port may be OS-chosen
        self._caps = Capabilities(
            name=name, rate_bps=rate_bps, mtu=mtu, latency_s=0.03,
            reach_m=float("inf"), error_rate=0.01, directionality="full",
            legal_class=legal_class, detectability=detectability,
        )

    def capabilities(self) -> Capabilities:
        return self._caps

    def send(self, frame: bytes) -> None:
        if len(frame) > _MAX_DATAGRAM:
            raise ValueError("frame exceeds one UDP datagram; lower block_size")
        try:
            self._sock.sendto(frame, self.peer)
        except OSError:
            pass  # peer not up yet / transient; L3 will re-spray

    def poll(self) -> list[bytes]:
        out: list[bytes] = []
        while True:
            try:
                data, _addr = self._sock.recvfrom(_MAX_DATAGRAM)
            except (BlockingIOError, OSError):
                break
            if data:
                out.append(data)
        return out

    def close(self) -> None:
        self._sock.close()
