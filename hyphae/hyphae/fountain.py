"""Hyphae L2 — LT fountain coding.

A bundle is split into ``k`` equal blocks and encoded into an endless stream of
*coded symbols*. Each symbol is the XOR of a pseudo-random subset of the source
blocks; the subset is regenerated on the decoder side from the symbol's 32-bit
``seed`` and ``k`` alone, so a symbol is fully self-describing and needs no
ordering or delivery guarantees from the bearer that carries it.

The receiver runs a peeling decoder and reconstructs the whole bundle once it
has collected *enough* symbols — from any mix of bearers, in any order, with
arbitrary losses in between. This is what makes "spray coded fragments across
whatever threads are alive, reassemble at the destination" actually work.

Symbol wire layout (big-endian):

    msg_id      16   which bundle this symbol belongs to
    k           4    number of source blocks
    block_size  4    bytes per block
    orig_len    4    original bundle length (to trim padding)
    seed        4    PRNG seed identifying this symbol's block neighborhood
    data        block_size   the XOR of the neighbor blocks
"""
from __future__ import annotations

import math
import random
import struct
from dataclasses import dataclass

_SYM = struct.Struct(">16sIIII")

# Robust-soliton parameters. Conservative so decoding succeeds with modest
# overhead; both encoder and decoder must agree on these constants.
_C = 0.1
_DELTA = 0.05


def _soliton_cdf(k: int) -> list[float]:
    """Cumulative distribution over degrees 1..k (robust soliton)."""
    if k == 1:
        return [0.0, 1.0]  # index 0 unused, degree 1 with probability 1
    rho = [0.0] * (k + 1)
    rho[1] = 1.0 / k
    for d in range(2, k + 1):
        rho[d] = 1.0 / (d * (d - 1))
    R = _C * math.log(k / _DELTA) * math.sqrt(k)
    tau = [0.0] * (k + 1)
    kr = max(1, int(k / R))
    for d in range(1, kr):
        tau[d] = R / (d * k)
    if kr <= k:
        tau[kr] = R * math.log(R / _DELTA) / k
    mu = [rho[d] + tau[d] for d in range(k + 1)]
    total = sum(mu)
    cdf, acc = [], 0.0
    for d in range(k + 1):
        acc += mu[d] / total
        cdf.append(acc)
    return cdf


def _degree(rng: random.Random, cdf: list[float], k: int) -> int:
    x = rng.random()
    for d in range(1, k + 1):
        if x <= cdf[d]:
            return d
    return k


def _neighbors(seed: int, k: int, cdf: list[float]) -> list[int]:
    """Regenerate a symbol's source-block indices from its seed. Deterministic."""
    rng = random.Random(seed)
    d = min(_degree(rng, cdf, k), k)
    return rng.sample(range(k), d)


def _split(data: bytes, block_size: int) -> tuple[list[bytes], int]:
    k = max(1, math.ceil(len(data) / block_size))
    padded = data.ljust(k * block_size, b"\x00")
    blocks = [padded[i * block_size:(i + 1) * block_size] for i in range(k)]
    return blocks, k


def _xor(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


class Encoder:
    """Produces an endless stream of coded symbols for one bundle."""

    def __init__(self, msg_id: bytes, data: bytes, block_size: int = 256):
        self.msg_id = msg_id
        self.orig_len = len(data)
        self.block_size = block_size
        self.blocks, self.k = _split(data, block_size)
        self.cdf = _soliton_cdf(self.k)
        self._seed = 0

    def symbol(self, seed: int) -> bytes:
        idxs = _neighbors(seed, self.k, self.cdf)
        acc = bytes(self.block_size)
        for i in idxs:
            acc = _xor(acc, self.blocks[i])
        return _SYM.pack(self.msg_id, self.k, self.block_size, self.orig_len,
                         seed) + acc

    def stream(self, n: int) -> list[bytes]:
        """The next ``n`` symbols (seeds are just a local counter)."""
        out = []
        for _ in range(n):
            self._seed += 1
            out.append(self.symbol(self._seed))
        return out


@dataclass
class _Pending:
    idxs: set
    data: bytes


class Decoder:
    """Peeling decoder. Feed it symbols until ``complete`` is True."""

    def __init__(self) -> None:
        self.k: int | None = None
        self.block_size = 0
        self.orig_len = 0
        self.msg_id = b""
        self._cdf: list[float] = []
        self._recovered: dict[int, bytes] = {}
        self._pending: list[_Pending] = []

    @property
    def complete(self) -> bool:
        return self.k is not None and len(self._recovered) == self.k

    def add(self, symbol: bytes) -> bool:
        """Ingest one symbol. Returns True once the bundle is fully decoded."""
        msg_id, k, block_size, orig_len, seed = _SYM.unpack_from(symbol, 0)
        data = symbol[_SYM.size:]
        if self.k is None:
            self.k, self.block_size, self.orig_len = k, block_size, orig_len
            self.msg_id, self._cdf = msg_id, _soliton_cdf(k)
        elif msg_id != self.msg_id:
            return self.complete  # symbol for a different bundle; ignore
        self._pending.append(_Pending(set(_neighbors(seed, k, self._cdf)), data))
        self._reduce()
        return self.complete

    def _reduce(self) -> None:
        progress = True
        while progress:
            progress = False
            # XOR every already-recovered neighbor out of each pending symbol;
            # any symbol that collapses to a single unknown reveals that block.
            new_pending = []
            for p in self._pending:
                idxs = set(p.idxs)
                data = p.data
                for i in list(idxs):
                    if i in self._recovered:
                        data = _xor(data, self._recovered[i])
                        idxs.discard(i)
                if len(idxs) == 1:
                    (only,) = tuple(idxs)
                    if only not in self._recovered:
                        self._recovered[only] = data
                        progress = True
                elif len(idxs) >= 1:
                    new_pending.append(_Pending(idxs, data))
            self._pending = new_pending

    def result(self) -> bytes:
        if not self.complete:
            raise ValueError("decode not complete")
        blocks = b"".join(self._recovered[i] for i in range(self.k))
        return blocks[:self.orig_len]
