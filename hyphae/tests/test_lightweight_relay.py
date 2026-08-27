"""A borrowed node stays cheap: cut-through forwarding + a politeness cap.

These pin the "good guest" properties — the relay adds near-zero latency and load
to whatever device is temporarily carrying a message:

* it forwards fragments WITHOUT ever reassembling (decoding) the message, so it
  does O(header) work per fragment, never O(message), and never buffers the whole
  thing; and
* it never forwards more than its per-tick budget, so relaying can't starve the
  host's own traffic.
"""
import unittest

from hyphae import Identity, Node, Capabilities, loopback_pair

LINK = Capabilities("link", 1e6, 1200, 0.01, 1000, 0.0, "full",
                    "unlicensed-ism", 0.3)


class TestLightweightRelay(unittest.TestCase):
    def test_relay_never_reassembles(self):
        alice = Identity.from_seed(b"A" * 32)
        bob = Identity.from_seed(b"B" * 32)     # the borrowed node
        carol = Identity.from_seed(b"C" * 32)
        in_a, in_b = loopback_pair(LINK)
        out_b, out_c = loopback_pair(LINK)
        A = Node(alice, bearers=[in_a])
        B = Node(bob, bearers=[in_b, out_b], relay=True)
        C = Node(carol, bearers=[out_c])

        # A multi-fragment message so "didn't reassemble" is meaningful.
        mid = A.send(carol.address, carol.x_public_bytes, b"x" * 4000,
                     created_at=0, deadline_s=600, block_size=200)
        for i in range(60):
            B.tick(i); C.tick(i); A.tick(i)
            if A.is_delivered(mid):
                break

        self.assertTrue(A.is_delivered(mid))
        self.assertEqual(C.inbox[0][1], b"x" * 4000)
        # The borrowed node did NO decoding and held NO message state:
        self.assertEqual(B._decoders, {}, "relay reassembled — it should cut through")
        self.assertEqual(B.inbox, [])

    def test_politeness_cap_limits_forwarding_per_tick(self):
        alice = Identity.from_seed(b"A" * 32)
        bob = Identity.from_seed(b"B" * 32)
        carol = Identity.from_seed(b"C" * 32)
        in_a, in_b = loopback_pair(LINK)
        out_b, out_c = loopback_pair(LINK)
        A = Node(alice, bearers=[in_a])
        B = Node(bob, bearers=[in_b, out_b], relay=True, max_forwards_per_tick=1)
        Node(carol, bearers=[out_c])

        # Alice dumps many fragments into Bob's inbound link in one shot.
        A.send(carol.address, carol.x_public_bytes, b"y" * 4000,
               created_at=0, deadline_s=600, block_size=200)
        B.tick(0)
        # With a budget of 1, Bob forwarded at most one fragment this tick,
        # regardless of how many arrived — the host's radio isn't monopolized.
        self.assertLessEqual(len(out_c._inbox), 1)
        self.assertEqual(B._forwards_this_tick, 1)


if __name__ == "__main__":
    unittest.main()
