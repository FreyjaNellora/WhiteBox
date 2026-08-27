# Hyphae device — v1 hardware (Phase 3–4)

A pocket node that opportunistically uses every radio it has to find *any* legal
connection it can, whenever it needs one. Compute is a **Raspberry Pi** because
it runs the Hyphae reference stack (`hyphae/`) unchanged and ships with Wi-Fi +
Bluetooth on-board — two bearers for zero extra parts. Every other radio bolts
on as a HAT or USB module and becomes a bearer implementing the L0 interface.

## Bill of materials

| Part | Role | Bearer | `legal_class` | License | ~Cost |
|------|------|--------|---------------|---------|-------|
| Raspberry Pi Zero 2 W (field) / Pi 4–5 (dev) | runs Hyphae | — | — | — | $15 / $55–80 |
| On-board Wi-Fi | join any reachable network → internet; local peer | `IPBearer` | `unlicensed-ism` | none | incl. |
| On-board Bluetooth LE | phone pairing + short-range peer | BLE bearer *(todo)* | `unlicensed-ism` | none | incl. |
| Waveshare SX1262 LoRa HAT (915 MHz US) | long-range mesh, 2–15 km | LoRa bearer *(todo)* | `unlicensed-ism` (Part 15) | none | ~$25 |
| Waveshare SIM7600G-H 4G HAT (+ GPS) + data SIM/eSIM | internet anywhere with a tower | `IPBearer` (over `ppp0`) | `licensed-carrier` | SIM only | ~$60 + SIM |
| UPS/battery HAT (PiSugar / Waveshare) + cell | portable power | — | — | — | ~$30 |
| LoRa 915 MHz + LTE antennas (incl. w/ HATs) | — | — | — | — | ~$10 |

Every module ships **already FCC-certified**, so the device inherits their
approvals — no new filing. Later bearers (satellite via a Swarm/Iridium USB
modem; optical/acoustic) attach the same way.

## How each radio reaches the code

- **Wi-Fi / cellular** present to the OS as ordinary IP interfaces (`wlan0`,
  `ppp0`), so both ride the **`IPBearer`** (UDP) — already built and tested over
  real sockets. Cellular just constructs it with `legal_class="licensed-carrier"`.
- **LoRa** is driven over the Pi's serial/SPI pins (SX1262 UART) — a bearer that
  wraps the module's send/receive.
- **BLE** goes through the OS Bluetooth stack (BlueZ) — a bearer for phone
  pairing and nearby peers.

The bearer manager (`policy.py` + `node.py`) already does the opportunistic part:
discover which bearers are live, prefer the quietest legal one, and escalate to
louder/faster radios only when delivery requires it.

## Build order

1. **`IPBearer`** — Wi-Fi + cellular path. ✅ built, tested over real UDP sockets.
2. **LoRa bearer** — the long-range backbone. ← next; needs the SX1262 HAT in hand.
3. **BLE bearer** — phone pairing + short-range peer.
4. **Cellular bring-up** — SIM7600 HAT + data SIM; point `IPBearer` at `ppp0`.
5. **Enclosure + power + phone app** — the finished portable unit.
