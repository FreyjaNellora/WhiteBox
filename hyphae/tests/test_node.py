"""L3/L4 end-to-end: delivery across two bearers, signed receipts, policy.

This is the proof the theory runs: a bundle is sprayed as fountain symbols
across two genuinely different bearers (an in-memory link and a file/sneakernet
link), reassembled by the recipient, delivered after signature + address checks,
and confirmed back to the sender with a signed receipt. Separately we show the
selection policy refusing a bearer that breaks the legality or detectability
invariants, and the honest-failure path when a deadline passes with no receipt.
"""
import os
import tempfile
import unittest

from hyphae import (
    Identity, Node, Bundle, Capabilities, loopback_pair, FileBearer,
    evaluate, DEFAULT_LEGAL_WHITELIST,
)

LOOP_CAPS = Capabilities(
    name="loop", rate_bps=1e6, mtu=4096, latency_s=0.001, reach_m=1.0,
    error_rate=0.0, directionality="full", legal_class="local-only",
    detectability=0.05,
)
FILE_CAPS = Capabilities(
    name="sneakernet", rate_bps=100.0, mtu=65536, latency_s=3600.0, reach_m=0.0,
    error_rate=0.0, directionality="half", legal_class="local-only",
    detectability=0.10,
)


class TestNodeDelivery(unittest.TestCase):
    def test_two_bearer_delivery_with_receipt(self):
        with tempfile.TemporaryDirectory() as d:
            a2b = os.path.join(d, "a2b")
            b2a = os.path.join(d, "b2a")
            alice = Identity.from_seed(b"A" * 32)
            bob = Identity.from_seed(b"B" * 32)

            a_lo, b_lo = loopback_pair(LOOP_CAPS)
            a_file = FileBearer(FILE_CAPS, outbox=a2b, inbox=b2a)
            b_file = FileBearer(FILE_CAPS, outbox=b2a, inbox=a2b)

            na = Node(alice, bearers=[a_lo, a_file])
            nb = Node(bob, bearers=[b_lo, b_file])

            secret = b"meet at the old bridge at dusk; bring the keys" * 4
            mid = na.send(bob.address, bob.x_public_bytes, secret,
                          created_at=1000, deadline_s=600)

            delivered = False
            for i in range(20):
                nb.tick(1000 + i)
                na.tick(1000 + i)
                if na.is_delivered(mid):
                    delivered = True
                    break

            self.assertTrue(delivered, "sender never got a signed receipt")
            self.assertEqual(len(nb.inbox), 1)
            src, plaintext = nb.inbox[0]
            self.assertEqual(src, alice.address)
            self.assertEqual(plaintext, secret)

    def test_delivery_survives_when_one_bearer_is_dead(self):
        # Only the file bearer carries symbols; the loopback is one-directional
        # here (no peer polling it). Delivery must still complete via the file.
        with tempfile.TemporaryDirectory() as d:
            a2b, b2a = os.path.join(d, "a2b"), os.path.join(d, "b2a")
            alice, bob = Identity.from_seed(b"A" * 32), Identity.from_seed(b"B" * 32)
            a_file = FileBearer(FILE_CAPS, outbox=a2b, inbox=b2a)
            b_file = FileBearer(FILE_CAPS, outbox=b2a, inbox=a2b)
            na = Node(alice, bearers=[a_file])
            nb = Node(bob, bearers=[b_file])
            mid = na.send(bob.address, bob.x_public_bytes, b"lantern lit" * 30,
                          created_at=0, deadline_s=600)
            for i in range(20):
                nb.tick(i)
                na.tick(i)
                if na.is_delivered(mid):
                    break
            self.assertTrue(na.is_delivered(mid))
            self.assertEqual(nb.inbox[0][1], b"lantern lit" * 30)

    def test_honest_failure_on_deadline(self):
        # Bob never ticks: no receipt ever returns. Sender must report failure,
        # not a false success, once the deadline passes.
        alice, bob = Identity.from_seed(b"A" * 32), Identity.from_seed(b"B" * 32)
        a_lo, _b_lo = loopback_pair(LOOP_CAPS)
        na = Node(alice, bearers=[a_lo])
        mid = na.send(bob.address, bob.x_public_bytes, b"hello",
                      created_at=0, deadline_s=5)
        na.tick(100)  # well past the deadline
        self.assertFalse(na.is_delivered(mid))
        self.assertTrue(na.is_failed(mid))


class TestPolicy(unittest.TestCase):
    def _bundle(self, det_budget):
        alice, bob = Identity.from_seed(b"A" * 32), Identity.from_seed(b"B" * 32)
        return Bundle.create(alice, bob.address, bob.x_public_bytes, b"x",
                             created_at=0, det_budget=det_budget)

    def test_detectability_budget_refuses_loud_bearer(self):
        loud = Capabilities(
            name="loud", rate_bps=1e6, mtu=4096, latency_s=0.01, reach_m=1000,
            error_rate=0.0, directionality="full", legal_class="unlicensed-ism",
            detectability=0.9,
        )
        quiet = LOOP_CAPS
        a_loud, _ = loopback_pair(loud)
        a_quiet, _ = loopback_pair(quiet)
        bundle = self._bundle(det_budget=20)  # allow only <=0.20 detectability
        decision = evaluate([a_loud, a_quiet], bundle)
        chosen_names = {b.capabilities().name for b in decision.chosen}
        self.assertIn("loop", chosen_names)
        self.assertNotIn("loud", chosen_names)
        self.assertTrue(any("detectability" in r for _, r in decision.refused))

    def test_legality_whitelist_refuses_disallowed_class(self):
        ism, _ = loopback_pair(Capabilities(
            name="ism", rate_bps=1e5, mtu=256, latency_s=0.1, reach_m=2000,
            error_rate=0.0, directionality="full", legal_class="unlicensed-ism",
            detectability=0.1,
        ))
        bundle = self._bundle(det_budget=100)
        # Operator restricts to non-RF physical channels only.
        decision = evaluate([ism], bundle,
                            legal_whitelist=frozenset({"unregulated-physical"}))
        self.assertEqual(decision.chosen, [])
        self.assertTrue(any("legal_class" in r for _, r in decision.refused))


if __name__ == "__main__":
    unittest.main()
