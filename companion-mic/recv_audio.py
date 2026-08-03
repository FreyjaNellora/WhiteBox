#!/usr/bin/env python3
"""WhiteBox companion mic — PC receiver. Reads raw 16 kHz mono s16le PCM from the XIAO over USB serial
(DTR MUST be asserted or the CDC won't stream) and writes a .wav. Prints peak/RMS so we know real sound
was captured. Usage: python recv_audio.py [COM4] [seconds] [out.wav]"""
import os
import struct
import sys
import time
import wave

import serial

PORT = sys.argv[1] if len(sys.argv) > 1 else "COM4"
SECS = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0
OUT = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                          "recordings", "capture.wav")
RATE = 16000

os.makedirs(os.path.dirname(OUT), exist_ok=True)
s = serial.Serial(PORT, 115200, timeout=0.5)
s.dtr = True; s.rts = True                       # assert DTR so the XIAO's USB-CDC starts streaming
time.sleep(0.4); s.reset_input_buffer()
print(f"recording {SECS:.0f}s from {PORT} ... TALK NOW")
data = bytearray()
end = time.time() + SECS
while time.time() < end:
    chunk = s.read(8192)
    if chunk:
        data += chunk
s.close()

if len(data) % 2:
    data = data[:-1]
with wave.open(OUT, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
    w.writeframes(bytes(data))

n = len(data) // 2
if n:
    samples = struct.unpack("<%dh" % n, bytes(data))
    peak = max(abs(x) for x in samples)
    rms = int((sum(x * x for x in samples) / n) ** 0.5)
else:
    peak = rms = 0
print(f"captured {len(data)} bytes = {n / RATE:.1f}s @ {RATE}Hz -> {OUT}")
print(f"peak {peak}  rms {rms}  -> {'SOUND CAPTURED' if peak > 1000 else 'very quiet; talk louder / re-run'}")
