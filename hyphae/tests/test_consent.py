"""Opt-in gateway relaying: a volunteer donates connectivity on their terms.

A person running the app can turn on "carry others' messages," and separately
choose whether that may use their metered cellular, cap the data it spends, and
stop when their battery is low. These pin those controls.
"""
import unittest

from hyphae import (
    Identity, Node, Capabilities, loopback_pair, RelayConsent,
)

WIFI = Capabilities("wifi", 1e7, 1200, 0.01, 60, 0.0, "full",
                    "unlicensed-ism", 0.4)
CELL = Capabilities("cell", 1e6, 1200, 0.05, 5000, 0.0, "full",
                    "licensed-carrier", 0.5)


def _hyf(inbox):  # count symbol frames sitting in a loopback endpoint
    return len(inbox)


class TestConsent(unittest.TestCase):
    def _line_with_gateway(self, consent, battery=100):
        """Alice -> Bob(gateway) with a wifi leg to Carol and a metered cell leg
        to a bare sink we can inspect."""
        alice = Identity.from_seed(b"A" * 32)
        bob = Identity.from_seed(b"B" * 32)
        carol = Identity.from_seed(b"C" * 32)
        in_a, in_b = loopback_pair(WIFI)
        wifi_b, wifi_c = loopback_pair(WIFI)
        cell_b, cell_sink = loopback_pair(CELL)
        A = Node(alice, bearers=[in_a])
        B = Node(bob, bearers=[in_b, wifi_b, cell_b], consent=consent,
                 battery_pct=battery)
        C = Node(carol, bearers=[wifi_c])
        return alice, carol, A, B, C, cell_sink

    def test_off_by_default_no_relay(self):
        alice, carol, A, B, C, sink = self._line_with_gateway(RelayConsent())
        A.send(carol.address, carol.x_public_bytes, b"hi" * 50, created_at=0,
               deadline_s=600, block_size=200)
        for i in range(20):
            B.tick(i); C.tick(i); A.tick(i)
        self.assertEqual(C.inbox, [])                 # Bob didn't volunteer
        self.assertEqual(_hyf(sink._inbox), 0)

    def test_wifi_only_does_not_spend_cellular(self):
        consent = RelayConsent(enabled=True, allow_metered=False)
        alice, carol, A, B, C, sink = self._line_with_gateway(consent)
        mid = A.send(carol.address, carol.x_public_bytes, b"hi" * 50, created_at=0,
                     deadline_s=600, block_size=200)
        for i in range(20):
            B.tick(i); C.tick(i); A.tick(i)
            if A.is_delivered(mid):
                break
        self.assertTrue(A.is_delivered(mid))          # delivered over wifi
        self.assertEqual(_hyf(sink._inbox), 0)        # cellular never used

    def test_allow_metered_uses_cellular(self):
        consent = RelayConsent(enabled=True, allow_metered=True)
        alice, carol, A, B, C, sink = self._line_with_gateway(consent)
        A.send(carol.address, carol.x_public_bytes, b"hi" * 50, created_at=0,
               deadline_s=600, block_size=200)
        for i in range(5):
            B.tick(i); C.tick(i); A.tick(i)
        self.assertGreater(_hyf(sink._inbox), 0)      # cellular carried a copy

    def test_data_budget_stops_relaying(self):
        consent = RelayConsent(enabled=True, allow_metered=True,
                               data_budget_bytes=300)
        alice, carol, A, B, C, sink = self._line_with_gateway(consent)
        A.send(carol.address, carol.x_public_bytes, b"z" * 4000, created_at=0,
               deadline_s=600, block_size=200)
        for i in range(20):
            B.tick(i); C.tick(i); A.tick(i)
        self.assertLessEqual(B._relayed_bytes, 300 + 1300)  # stops ~at the cap

    def test_battery_floor_pauses_relaying(self):
        consent = RelayConsent(enabled=True, allow_metered=True,
                               battery_floor_pct=50)
        alice, carol, A, B, C, sink = self._line_with_gateway(consent, battery=20)
        A.send(carol.address, carol.x_public_bytes, b"hi" * 50, created_at=0,
               deadline_s=600, block_size=200)
        for i in range(20):
            B.tick(i); C.tick(i); A.tick(i)
        self.assertEqual(C.inbox, [])                 # too low to relay


if __name__ == "__main__":
    unittest.main()
