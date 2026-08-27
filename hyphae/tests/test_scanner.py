"""The opportunity scanner: take every usable path, skip only what we can't use."""
import unittest

from hyphae import Capabilities
from hyphae.scanner import LinkOpportunity, OpportunityScanner


def caps(name, legal_class, det, latency=0.05, rate=1e6, err=0.0):
    return Capabilities(
        name=name, rate_bps=rate, mtu=1200, latency_s=latency, reach_m=1000,
        error_rate=err, directionality="full", legal_class=legal_class,
        detectability=det,
    )


class TestScanner(unittest.TestCase):
    def setUp(self):
        # A realistic mix the device might see at one moment.
        self.opps = [
            LinkOpportunity("cafe-guest", "wifi-open",
                            caps("wifi-open", "unlicensed-ism", 0.6)),
            LinkOpportunity("nearby-phone", "ble-broadcast",
                            caps("ble", "unlicensed-ism", 0.2)),
            LinkOpportunity("hyphae-relay-7", "mesh-peer",
                            caps("mesh", "unlicensed-ism", 0.3)),
            LinkOpportunity("lte", "cellular",
                            caps("cellular", "licensed-carrier", 0.5),
                            have_credentials=True),      # we have a SIM
            LinkOpportunity("neighbor-locked", "wifi-known",
                            caps("wifi-locked", "unlicensed-ism", 0.6),
                            have_credentials=False),     # not ours, no key -> unusable
            LinkOpportunity("far-mesh", "mesh-peer",
                            caps("far", "unlicensed-ism", 0.3),
                            reachable=False),            # out of range -> unusable
        ]

    def test_takes_every_usable_path(self):
        taken = {o.name for o in OpportunityScanner().take(self.opps)}
        # open network, connectionless BLE, consenting mesh peer, and our own SIM.
        self.assertEqual(taken,
                         {"cafe-guest", "nearby-phone", "hyphae-relay-7", "lte"})

    def test_skips_only_the_unusable(self):
        reasons = dict(OpportunityScanner().skipped(self.opps))
        self.assertIn("neighbor-locked", reasons)      # no key of our own
        self.assertIn("far-mesh", reasons)             # unreachable
        self.assertNotIn("cafe-guest", reasons)
        self.assertEqual(reasons["far-mesh"], "unreachable")

    def test_quietest_first_by_default(self):
        order = [o.name for o in OpportunityScanner().take(self.opps)]
        # nearby-phone (0.2) is quietest, cafe-guest (0.6) loudest of the usable set.
        self.assertEqual(order[0], "nearby-phone")
        self.assertEqual(order[-1], "cafe-guest")

    def test_urgent_prefers_fastest(self):
        fast = LinkOpportunity("fast-open", "wifi-open",
                               caps("fast", "unlicensed-ism", 0.9, latency=0.001))
        taken = OpportunityScanner().take(self.opps + [fast], urgent=True)
        self.assertEqual(taken[0].name, "fast-open")

    def test_legal_whitelist_can_narrow(self):
        # Operator restricts to non-RF physical channels: cellular/wifi/ble drop out.
        taken = OpportunityScanner(
            legal_whitelist=frozenset({"unregulated-physical"})
        ).take(self.opps)
        self.assertEqual(taken, [])


if __name__ == "__main__":
    unittest.main()
