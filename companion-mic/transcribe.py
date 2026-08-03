#!/usr/bin/env python3
"""WhiteBox companion mic — local speech-to-text. faster-whisper (CTranslate2, CPU int8 — light enough for the
6GB box) turns a captured .wav into TEXT: the moment the mic actually talks to WhiteBox. Usage:
python transcribe.py [recordings/talk3.wav] [model=base]"""
import os
import sys

wav = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                         "recordings", "talk3.wav")
model_name = sys.argv[2] if len(sys.argv) > 2 else "base"

from faster_whisper import WhisperModel   # noqa: E402
print(f"loading whisper '{model_name}' (CPU int8) ...")
model = WhisperModel(model_name, device="cpu", compute_type="int8")
print(f"transcribing {os.path.basename(wav)} ...\n")
segments, info = model.transcribe(wav, beam_size=5, vad_filter=True)
print(f"[detected language: {info.language} (p={info.language_probability:.2f})]\n--- TRANSCRIPT ---")
full = []
for seg in segments:
    print(f"  [{seg.start:5.1f}s] {seg.text.strip()}")
    full.append(seg.text.strip())
text = " ".join(full).strip()
print("\n--- FULL ---")
print(text if text else "(nothing transcribed — audio too quiet / no speech)")
