#!/usr/bin/env python3
"""Hyphae end-to-end demo — watch a message cross two different bearers.

Run:  python demo.py   (from the hyphae/ directory, with PyNaCl installed)

Alice sends one sealed, signed bundle to Bob. It is fountain-coded and sprayed
across TWO dissimilar bearers at once — an in-memory link and a file/sneakernet
link — then reassembled by Bob, delivered after signature + address checks, and
confirmed back to Alice with a signed receipt. Nothing here is a cell network,
a carrier, or a central server.
"""
import os
import tempfile

from hyphae import Identity, Node, Capabilities, loopback_pair, FileBearer

LOOP = Capabilities("mesh-link", 1e6, 4096, 0.001, 30, 0.0, "full",
                    "unregulated-physical", 0.05)
FILE = Capabilities("sneakernet", 100, 65536, 3600, 0.0, 0.0, "half",
                    "local-only", 0.10)


def main() -> None:
    with tempfile.TemporaryDirectory() as d:
        a2b, b2a = os.path.join(d, "a2b"), os.path.join(d, "b2a")
        alice, bob = Identity.generate(), Identity.generate()
        a_lo, b_lo = loopback_pair(LOOP)
        na = Node(alice, bearers=[a_lo, FileBearer(FILE, a2b, b2a)])
        nb = Node(bob, bearers=[b_lo, FileBearer(FILE, b2a, a2b)])

        print(f"Alice  {alice.address.hex()}")
        print(f"Bob    {bob.address.hex()}")
        print("Bearers: mesh-link (unregulated-physical) + sneakernet (local-only)\n")

        message = b"No tower. No carrier. No middleman. This still arrives."
        mid = na.send(bob.address, bob.x_public_bytes, message,
                      created_at=0, deadline_s=600)
        print(f"[send]     bundle {mid.hex()[:16]} sprayed as fountain symbols")

        for t in range(20):
            nb.tick(t)
            na.tick(t)
            if na.is_delivered(mid):
                print(f"[tick {t:>2}]  Bob reassembled + verified; receipt returned")
                break

        print()
        print(f"delivered to sender's satisfaction: {na.is_delivered(mid)}")
        if nb.inbox:
            src, plaintext = nb.inbox[0]
            print(f"Bob received from {src.hex()[:16]}: {plaintext.decode()!r}")


if __name__ == "__main__":
    main()
