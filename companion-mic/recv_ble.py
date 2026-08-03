#!/usr/bin/env python3
"""WhiteBox companion mic — BLE receiver (the HOME path).

Connects to the XIAO over Bluetooth Low Energy (the *same* Omi audio service the
phone will use), subscribes to the audio notify characteristic, strips the
per-packet header, and writes the raw PCM16 stream to a .wav. This proves the
wireless audio path end-to-end FROM THE PC with no phone in the loop:

    XIAO mic --BLE--> this PC --> WAV --> (whisper -> WhiteBox)

Usage:
    python recv_ble.py <seconds> <out.wav> [name-or-address]

Constants below mirror the Omi wire format. The ones marked CONFIRM are being
verified against the Omi repo; set them from that extraction before trusting a
capture's pitch/length.
"""
from __future__ import annotations  # allow `str | None` on Python 3.9

import array
import asyncio
import sys
import time
import wave

from bleak import BleakClient, BleakScanner

# --- WhiteBox sovereign audio service (our v4 firmware advertises these; no Omi) ---
SERVICE_UUID    = "b1a5c0de-0000-4f6c-9b21-7ea0f0dceafe"
AUDIO_CHAR_UUID = "b1a5c0de-0001-4f6c-9b21-7ea0f0dceafe"
CODEC_CHAR_UUID = "b1a5c0de-0002-4f6c-9b21-7ea0f0dceafe"

# Each audio notification is [header][pcm...]; the 3-byte header is a little-endian
# packet counter (2 bytes) + a sub-index (1 byte), purely for drop detection.
HEADER_LEN   = 3       # [seq_lo, seq_hi, subindex]
SAMPLE_RATE  = 16000   # v4 streams 16 kHz mono 16-bit LE (whisper-native)
CHANNELS     = 1
SAMPWIDTH    = 2       # 16-bit


def _stats(pcm: bytes):
    if len(pcm) < 2:
        return 0, 0
    s = array.array("h")
    s.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    peak = max((abs(x) for x in s), default=0)
    rms = int((sum(x * x for x in s) / len(s)) ** 0.5) if s else 0
    return peak, rms


async def find_device(hint: str | None):
    """Prefer the device that advertises our Omi service UUID; fall back to a
    name/address hint."""
    print("scanning 8s for the companion mic ...")
    found = await BleakScanner.discover(timeout=8.0, return_adv=True)
    by_service = None
    by_hint = None
    for addr, (dev, adv) in found.items():
        uuids = [u.lower() for u in (adv.service_uuids or [])]
        name = (dev.name or adv.local_name or "").strip()
        tag = f"{name or '(no name)'} [{addr}] rssi={adv.rssi}"
        if SERVICE_UUID in uuids:
            print(f"  * MATCH (service): {tag}")
            by_service = dev
        elif hint and (hint.lower() in name.lower() or hint.lower() == addr.lower()):
            print(f"  * match (hint): {tag}")
            by_hint = dev
        else:
            print(f"    seen: {tag}")
    return by_service or by_hint


async def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    secs = float(sys.argv[1])
    out = sys.argv[2]
    hint = sys.argv[3] if len(sys.argv) > 3 else None

    dev = await find_device(hint)
    if not dev:
        print("no matching device found. Is v3 flashed and advertising? "
              "(check the board's Serial log for 'advertising')")
        return 1

    buf = bytearray()
    pkts = 0
    dropped = 0
    last_ctr = [None]

    def on_audio(_char, data: bytearray):
        nonlocal pkts, dropped
        pkts += 1
        if len(data) > HEADER_LEN:
            # header[0:2] = LE packet counter — track gaps so drops are visible
            ctr = int.from_bytes(bytes(data[0:2]), "little")
            if last_ctr[0] is not None:
                gap = (ctr - last_ctr[0]) & 0xFFFF
                if gap > 1:
                    dropped += gap - 1
            last_ctr[0] = ctr
            buf.extend(data[HEADER_LEN:])

    print(f"connecting to {dev.name or dev.address} ...")
    async with BleakClient(dev) as client:
        print("connected. reading codec ...")
        try:
            codec = await client.read_gatt_char(CODEC_CHAR_UUID)
            print(f"  codec char = {list(codec)} (expect [16] = 16kHz PCM16)")
        except Exception as e:  # noqa: BLE001 — codec read is best-effort
            print(f"  (codec read skipped: {e})")

        await client.start_notify(AUDIO_CHAR_UUID, on_audio)
        print(f"streaming {secs:.0f}s ... TALK NOW")
        t0 = time.monotonic()
        while time.monotonic() - t0 < secs:
            await asyncio.sleep(0.2)
        await client.stop_notify(AUDIO_CHAR_UUID)

    peak, rms = _stats(bytes(buf))
    dur = len(buf) / (SAMPLE_RATE * SAMPWIDTH * CHANNELS)
    with wave.open(out, "wb") as w:
        w.setnchannels(CHANNELS)
        w.setsampwidth(SAMPWIDTH)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(bytes(buf))
    print(f"\n{pkts} packets, {dropped} dropped, {len(buf)} audio bytes "
          f"= {dur:.1f}s @ {SAMPLE_RATE}Hz -> {out}")
    print(f"peak {peak}  rms {rms}  -> "
          f"{'has signal' if peak > 500 else 'very quiet; talk louder / raise gain'}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
