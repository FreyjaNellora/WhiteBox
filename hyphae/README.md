# Hyphae

**A transport-agnostic, censorship-resistant messaging layer.** Send a message
as long as you are connected to *anything* that is connected to *anything else*
— internet, IoT, mesh, satellite, radio, or a channel nobody has named yet —
using only lawful means, with no monopoly in the middle.

The message is sovereign and self-contained; every channel is a disposable,
hot-swappable thread it can ride. See **[THEORY.md](THEORY.md)** for the full
model (the five layers, why it is lawful by construction, and the road to a
physical device).

## Status

Phase 2 of 5: a runnable reference implementation that proves the theory end to
end in a simulated network. Sign/seal, fountain-code, spray across multiple
bearers, reassemble, verify, and confirm with a signed receipt — all working,
with tests.

## Quick start

```bash
pip install -r requirements.txt      # PyNaCl (libsodium); everything else stdlib
python demo.py                       # watch a message cross two bearers at once
python -m unittest discover -s tests # 15 tests: crypto, fountain, delivery, policy
```

## What's here

| file | layer | what it is |
|------|-------|------------|
| `hyphae/identity.py`  | L1 | Ed25519 + Curve25519 identity; address = `hash(pubkey)` |
| `hyphae/sealedbox.py` | L1 | recipient-only payload sealing (libsodium sealed box) |
| `hyphae/bundle.py`    | L1 | the sovereign, signed, content-addressed message |
| `hyphae/fountain.py`  | L2 | LT fountain coding — reassemble from any mix of bearers |
| `hyphae/bearer.py`    | L0 | the uniform channel interface + loopback & file bearers |
| `hyphae/policy.py`    | L4 | bearer selection: legality gate + stealth-by-default + deadline |
| `hyphae/node.py`      | L3 | send / receive / reassemble / confirm with receipts |

## Scope and intent

Hyphae is for **lawful** communication that infringes no one's rights, safety,
property, or sovereignty. The legality and detectability machinery exists to keep
operators inside the law and to resist censorship of lawful speech — not to
conceal wrongdoing. Bearers requiring unauthorized access to, or interference
with, systems or property you do not own are out of scope by policy, and the
reference selection policy rejects them.

The crypto here (PyNaCl/libsodium) is correct but the surrounding reference code
is not hardened or side-channel-resistant; treat it as a proof of the
architecture, not a finished secure product.
