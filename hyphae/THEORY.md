# Hyphae — a transport-agnostic messaging layer

> A mycelial network signals through **hyphae** — the fine threads that thread
> through everything and carry state from one point to another. Hyphae (the
> layer) is WhiteBox's answer to a single question: **how do you send a message
> as long as you are connected to *anything* that is connected to *anything
> else* — internet, IoT, mesh, satellite, radio, or a channel nobody has named
> yet — using only lawful means, with no monopoly in the middle?**

This document is the founding theory. It pins down the model and the two
contracts (the **Bundle** and the **Bearer interface**) that everything else in
`hyphae/` references. The reference implementation under `hyphae/hyphae/`
implements it; the tests under `hyphae/tests/` prove it.

---

## 0. The one idea

**The message is sovereign and self-contained. Every channel is a disposable,
hot-swappable thread it can ride.**

A cell phone welds the message to one carrier: kill the carrier, kill the
message. Hyphae inverts that. A message ("bundle") is a sealed, addressed,
signed, self-describing object with a deadline. It does not know or care *how*
it travels. Any link a node can touch — even for a few seconds — is a **bearer**
it can be sprayed across. The node's only job is: find *anything* alive, hand
off coded fragments, hold the obligation open until a signed receipt comes back
or the deadline passes.

## 1. Why this is lawful by construction, not by evasion

The design rests on a structural mismatch, not on hiding:

- **The law defines communication by *named medium and intent*** — "radio
  emitter," "carrier," "broadcast." A finite list of categories.
- **Information theory defines a channel as *any physical variable two parties
  can correlate*.** An open-ended, mostly-unnamed set.

A regulatory code is a finite axiom set trying to pin down "communication." By
the same logic that gives arithmetic non-standard models (Gödel's completeness
theorem, compactness, Löwenheim–Skolem), such a code **necessarily admits
unintended models** — arrangements that satisfy every literal clause while doing
something the drafters never enumerated. A finite list of rules can never close
an open-ended space of channels.

Hyphae turns that into engineering with three invariants enforced **at bearer-
selection time** (see §5):

1. **Legality invariant.** Every bearer declares a `legal_class`. A policy can
   hard-restrict selection to a lawful whitelist. Lawfulness is a property of
   *what the system is built out of*, checked before a byte moves — not a hope.
2. **Detectability budget.** A bundle may cap how visible its transit is; the
   manager only picks bearers under that cap.
3. **Deadline / priority.** Urgency unlocks faster, costlier, or more numerous
   bearers.

Underneath sits a permanent backstop: by **Rice's theorem**, no adversary can
build a decider that reads a stream of individually-lawful actions and decides
which of them *were* communication. That is undecidable, not merely hard.

**Non-goal / hard floor.** Hyphae is for lawful communication that infringes no
one's rights, safety, property, or sovereignty. The `legal_class` and
detectability machinery exist to keep operators *inside* the law and to resist
censorship of lawful speech — not to conceal wrongdoing. Bearers that would
require unauthorized access to, or interference with, systems or property you do
not own are out of scope by policy, and the reference policy rejects them.

## 2. The five layers

```
  L4  Generator / Bearer Manager   discover live bearers, select per policy
  L3  Reachability + Delivery       gossip routing, store-carry-forward, receipts
  L2  Fragmentation + Fountain      one message survives many mismatched threads
  L1  Bundle                        the sovereign, signed, addressed message
  L0  Bearer interface              the uniform socket every channel implements
```

### L0 — Bearer interface (the impedance match)

The load-bearing idea. The channel space is infinite and wildly heterogeneous
(a lamp at ~10 bit/s, LoRa at ~kbit/s, a public-sensor channel at bits/hour, a
TCP socket). They cannot each carry their own stack, so every channel is forced
to implement **one** interface:

- `send(frame: bytes) -> None`
- `poll() -> list[bytes]`
- `capabilities() -> Capabilities`

where `Capabilities` describes the thread so L4 can reason about it:

| field           | meaning                                             |
|-----------------|-----------------------------------------------------|
| `rate_bps`      | usable payload bits/sec                              |
| `mtu`           | max frame size in bytes                             |
| `latency_s`     | typical one-way delay                               |
| `reach_m`       | rough physical/logical reach                        |
| `error_rate`    | expected frame loss (0..1)                          |
| `directionality`| `simplex` \| `half` \| `full`                      |
| `legal_class`   | e.g. `unlicensed-ism`, `license-by-rule`, `licensed-carrier`, `unregulated-physical`, `public-substrate` |
| `detectability` | 0 (ambient/indistinguishable) .. 1 (loud, obvious) |

A new channel discovered in the wild becomes a **plugin** implementing this
interface; the whole network gains a medium with no other change. *Extensibility
is the moat:* the bearer set is open-ended, and a new thread can be added faster
than any rulebook can name it.

### L1 — Bundle (the sovereign message)

Self-contained, medium-agnostic. Fields (wire format in `SPEC-wire.md`):

```
dest        16-byte destination address (hash of recipient public key)
src         16-byte source address
msg_id      16 bytes, = hash(src || nonce || payload)  (content-addressed)
created_at  uint64 seconds
deadline_s  uint32 seconds after created_at; 0 = best-effort, no expiry
priority    uint8  0 bulk .. 255 emergency
det_budget  uint8  max detectability *100 (bearers above this are never chosen)
flags       uint8  bit0 = receipt requested
payload     encrypted bytes (recipient-only)
sig         signature over all preceding fields, by the source identity
```

The bundle satisfies each bearer's local rules while being, globally, something
that bearer never conceived. It is the "unintended model" made concrete.

### L2 — Fragmentation + fountain coding

Bearers are radically mismatched in rate and reliability, so a bundle is split
into equal blocks and **fountain-coded** (an LT rateless code). The source emits
an effectively endless stream of *coded* symbols; the receiver reconstructs the
whole bundle once it has collected **enough symbols from any mix of bearers** —
a symbol over a lamp, three over LoRa, one carried on a USB stick. Reassembly is
oblivious to which thread carried each symbol.

This single choice solves three problems at once: multi-bearer racing,
heterogeneous rates, and partial-arrival reliability. Each symbol is
self-describing (`msg_id`, block count, block size, and the PRNG seed that
regenerates its source-block neighborhood), so no bearer needs to deliver
symbols in order or in full.

### L3 — Reachability + delivery

No registry, no DNS. A node learns reachability two ways:

- **Announces (gradient).** Identities periodically announce; each relay records
  "to reach X, hand toward me," building a hop-metric gradient by gossip.
- **Encounter history.** Route toward carriers statistically likely to meet the
  destination (an epidemic/PRoPHET-style fallback when no gradient exists).

Store-carry-forward throughout; **mailbox nodes** hold bundles for recipients
who are offline now. A bundle is **closed** exactly two ways:

- a **signed receipt** propagates back (proof of delivery), or
- the **deadline** expires (honest, reported failure).

Until one of those, the bundle stays **in flight**: retried, re-sprayed, and
escalated to faster/costlier bearers to meet its deadline. "Delivered, or a
truthful failure" is the only contract — never a silent drop.

### L4 — Generator / bearer manager (the doctrine, running)

The runtime that, wherever the node stands, **discovers which bearers are live
now**, reads each one's `capabilities()`, and selects/combines them per bundle
under the three invariants of §1. Selection is a policy function
(`policy.py`): given the bundle's `det_budget`, `deadline_s`, `priority`, and a
legal whitelist, it returns the ordered set of bearers to spray across. Legality
and detectability are enforced *here*, before any symbol is emitted.

## 3. What the reference implementation proves

The code under `hyphae/hyphae/` is a runnable, dependency-light (PyNaCl /
libsodium only; everything else is standard library) reference that demonstrates
the theory end to end in a simulated network:

- **`identity.py`** — Ed25519 identities, addresses = `hash(pubkey)`, sign/verify.
- **`bundle.py`** — the L1 wire format: build, sign, serialize, parse, verify.
- **`fountain.py`** — L2 LT encoder/peeling decoder over arbitrary blocks.
- **`bearer.py`** — the L0 interface + `LoopbackBearer` and `FileBearer`
  ("sneakernet": symbols written to a directory and picked up elsewhere).
- **`policy.py`** — the L4 selection policy (legal whitelist, detectability
  budget, deadline-aware ordering).
- **`node.py`** — an L3 node: send across bearers, receive, reassemble, emit and
  verify signed receipts, keep bundles in flight until receipt-or-deadline.

The tests show a message crossing **two different bearer types**, reconstructed
by fountain decode, and confirmed by a signed receipt — with a bearer that
violates the legal/detectability policy correctly refused.

## 4. Road to the device

The theory comes first because the device is just a physical node =
`compute + a chosen set of L0 bearer front-ends + this stack`. Once L0–L4 exist,
"what hardware do we build" becomes "which bearer front-ends do we solder on for
v1, and what does each cost."

1. **Network theory + protocol spec** — this document + `SPEC-wire.md`. ✅
2. **Software reference implementation** — `hyphae/hyphae/` + tests. ✅ (this PR)
3. **Physical bearer front-ends** — pick v1's real channels; spec parts.
4. **Device integration** — SBC/MCU + radios/transducers + power + phone pairing.
5. **Production-grade** — inherited module certification, design-for-manufacture,
   BOM + sourcing, contract manufacturing, compliance.
