# Companion Mic

A **do-it-yourself wireless microphone** that streams audio to your PC over Bluetooth LE — no app,
no account, no cloud. The board runs our own BLE GATT service; a small Python script on the PC
subscribes and receives raw 16 kHz PCM. Built as a fully self-owned alternative to commodity
"AI pendant" devices.

## Hardware
- **Seeed XIAO nRF52840 Sense** (has the on-board PDM microphone). The plain XIAO nRF52840 without
  the mic won't work.

## Files
| File | What it does |
|---|---|
| `v4_sovereign/v4_sovereign.ino` | Firmware. Streams the PDM mic as 16 kHz mono 16-bit PCM over a custom BLE service. Advertises under a fixed 128-bit UUID (`b1a5c0de-…`); receivers recognize it by that UUID alone. Each BLE notification is a 3-byte header `[seq_lo, seq_hi, subindex]` + PCM so the receiver can detect dropped packets. |
| `recv_ble.py` | PC receiver (uses `bleak`). Scans for the service UUID, subscribes to the audio characteristic, reassembles frames, and writes/plays the stream. |
| `recv_audio.py` | Minimal audio sink helper. |
| `transcribe.py` | Optional: feed the captured audio to a local speech-to-text (e.g. Whisper). |

## Firmware flash
1. Install the **Arduino IDE** (or `arduino-cli`).
2. Add the Seeed nRF52 board package (Seeeduino nRF52 / Adafruit Bluefruit core) — see Seeed's
   XIAO nRF52840 wiki for the board-manager URL.
3. Select **Seeed XIAO nRF52840 Sense**, open `v4_sovereign/v4_sovereign.ino`, and Upload.

## Receive on the PC
```
pip install bleak numpy
python recv_ble.py
```
The board advertises as our service UUID; `recv_ble.py` finds it, subscribes, and streams. Range is
short-range local RF (a few meters) — the link never leaves the room.

## Design notes
- **16 kHz** because we own both ends (no stock app forcing 8 kHz); 16 kHz is Whisper's native rate.
- **Custom UUID base** `b1a5c0de` — our own service identity, not a third-party's.
- BLE link-layer bonding (LE Secure Connections) is a planned hardening step; it needs a one-time
  pairing confirmation, so it lands when a human is in the loop.

## License
AGPL-3.0 (see [`LICENSE`](LICENSE)).

