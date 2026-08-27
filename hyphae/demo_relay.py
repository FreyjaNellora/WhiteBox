#!/usr/bin/env python3
"""Watch a message hop across two different media to reach someone unreachable.

Run:  python demo_relay.py   (from the hyphae/ directory, PyNaCl installed)

Alice has only a radio link. Carol has only a wifi link. They share no medium, so
Alice cannot reach Carol directly. Bob sits between them with both radios and
relays: he catches the bundle on radio and re-emits it on wifi, then carries
Carol's signed receipt back the same way. The message never touches a carrier or
a server, and Bob never reads it — he only bridges.
"""
from hyphae import Identity, Node, Capabilities, loopback_pair

RADIO = Capabilities("lora-radio", 5000, 240, 0.1, 5000, 0.0, "full",
                     "unlicensed-ism", 0.3)
WIFI = Capabilities("wifi", 1e7, 1200, 0.01, 60, 0.0, "full",
                    "unlicensed-ism", 0.6)


def main() -> None:
    alice, bob, carol = Identity.generate(), Identity.generate(), Identity.generate()
    radio_a, radio_b = loopback_pair(RADIO)   # Alice <-> Bob   (medium 1: radio)
    wifi_b, wifi_c = loopback_pair(WIFI)       # Bob   <-> Carol (medium 2: wifi)
    na = Node(alice, bearers=[radio_a])
    nb = Node(bob, bearers=[radio_b, wifi_b], relay=True)
    nc = Node(carol, bearers=[wifi_c])

    print(f"Alice {alice.address.hex()[:12]}  — radio only")
    print(f"Bob   {bob.address.hex()[:12]}  — radio + wifi (bridge)")
    print(f"Carol {carol.address.hex()[:12]}  — wifi only")
    print("Alice and Carol share no medium; only Bob can bridge them.\n")

    msg = b"radio -> bridge -> wifi, and nobody in the middle read it."
    mid = na.send(carol.address, carol.x_public_bytes, msg,
                  created_at=0, deadline_s=600, block_size=200)
    print(f"[Alice] sent {mid.hex()[:12]} over radio")

    for t in range(40):
        nb.tick(t)
        nc.tick(t)
        na.tick(t)
        if nc.inbox and "[Carol]" not in _printed:
            print(f"[Bob]   bridged radio -> wifi")
            print(f"[Carol] received: {nc.inbox[0][1].decode()!r}")
            _printed.add("[Carol]")
        if na.is_delivered(mid):
            print(f"[Bob]   carried the receipt back wifi -> radio")
            print(f"[Alice] got a signed receipt — delivery confirmed at tick {t}")
            break

    print(f"\nBob read the message? {'yes' if nb.inbox else 'no — he only bridged'}")


_printed: set = set()

if __name__ == "__main__":
    main()
