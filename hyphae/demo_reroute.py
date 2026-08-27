#!/usr/bin/env python3
"""Cut a path mid-flight; watch the message find its own way around.

Run:  python demo_reroute.py   (from the hyphae/ directory, PyNaCl installed)

Diamond: Alice can reach Dave through EITHER Bob or Carl. We kill Bob's path.
Nobody re-plans the route by hand — the message floods every open branch,
remembers where it's been so it never loops, and the copy through Carl arrives.
"""
from hyphae import Identity, Node, Capabilities, loopback_pair

LINK = Capabilities("link", 1e6, 1200, 0.01, 1000, 0.0, "full",
                    "unlicensed-ism", 0.3)


def main() -> None:
    alice, bob, carl, dave = (Identity.generate() for _ in range(4))
    ab_a, ab_b = loopback_pair(LINK)
    ac_a, ac_c = loopback_pair(LINK)
    bd_b, bd_d = loopback_pair(LINK)
    cd_c, cd_d = loopback_pair(LINK)
    A = Node(alice, bearers=[ab_a, ac_a])
    B = Node(bob, bearers=[ab_b, bd_b], relay=True)     # DOWN — never ticked
    C = Node(carl, bearers=[ac_c, cd_c], relay=True)
    D = Node(dave, bearers=[bd_d, cd_d])

    print("      Bob(DOWN)")
    print("      /      \\")
    print("  Alice       Dave")
    print("      \\      /")
    print("       Carl\n")

    mid = A.send(dave.address, dave.x_public_bytes,
                 b"the river found another channel", created_at=0, priority=200)
    print(f"[Alice] flooded every branch with {mid.hex()[:12]}")

    for t in range(40):
        C.tick(t)   # Bob is not ticked at all — his path is dead
        D.tick(t)
        A.tick(t)
        if D.inbox and "d" not in _seen:
            _seen.add("d")
            print("[Carl]  relayed around the dead Bob path")
            print(f"[Dave]  received: {D.inbox[0][1].decode()!r}")
        if A.is_delivered(mid):
            print(f"[Alice] got the receipt (via Carl) at tick {t} — rerouted, no reconfig")
            break

    print(f"\nDid anything pass through the dead node Bob? "
          f"{'yes' if B.inbox else 'no'}")


_seen: set = set()

if __name__ == "__main__":
    main()
