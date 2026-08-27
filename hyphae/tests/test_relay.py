"""Multi-hop cross-medium relay: radio -> bridge -> wifi.

Alice can only reach a "radio" link; Carol can only reach a "wifi" link. They
share no medium, so the message is undeliverable directly. Bob sits between them
with BOTH radios and relays: he catches the bundle on radio and re-emits it on
wifi — a different medium than it arrived on — and carries Carol's signed receipt
back the same way. This is the "signal jumps from radio to Bluetooth to Wi-Fi"
chain, with Bob playing the role the earbuds couldn't.
"""
import unittest

from hyphae import Identity, Node, Capabilities, loopback_pair

RADIO = Capabilities(
    name="lora-radio", rate_bps=5000, mtu=240, latency_s=0.1, reach_m=5000,
    error_rate=0.0, directionality="full", legal_class="unlicensed-ism",
    detectability=0.3,
)
WIFI = Capabilities(
    name="wifi", rate_bps=1e7, mtu=1200, latency_s=0.01, reach_m=60,
    error_rate=0.0, directionality="full", legal_class="unlicensed-ism",
    detectability=0.6,
)


class TestRelay(unittest.TestCase):
    def test_radio_to_wifi_bridge(self):
        alice = Identity.from_seed(b"A" * 32)
        bob = Identity.from_seed(b"B" * 32)     # the bridge; never reads the message
        carol = Identity.from_seed(b"C" * 32)

        radio_a, radio_b = loopback_pair(RADIO)   # Alice <-> Bob, medium 1
        wifi_b, wifi_c = loopback_pair(WIFI)       # Bob   <-> Carol, medium 2

        na = Node(alice, bearers=[radio_a])                       # radio only
        nb = Node(bob, bearers=[radio_b, wifi_b], relay=True)     # both -> bridge
        nc = Node(carol, bearers=[wifi_c])                        # wifi only

        mid = na.send(carol.address, carol.x_public_bytes,
                      b"this hopped media to reach you" * 3,
                      created_at=0, deadline_s=600, block_size=200)

        delivered = False
        for i in range(40):
            nb.tick(i)   # bridge: radio in -> wifi out, and receipt back
            nc.tick(i)   # destination on the far medium
            na.tick(i)   # source, waiting on the receipt
            if na.is_delivered(mid):
                delivered = True
                break

        # Carol got it, over a medium Alice can't even touch:
        self.assertEqual(len(nc.inbox), 1)
        self.assertEqual(nc.inbox[0][0], alice.address)
        self.assertEqual(nc.inbox[0][1], b"this hopped media to reach you" * 3)
        # ...and Alice got a signed receipt carried back across the bridge:
        self.assertTrue(delivered, "receipt never made it back across the bridge")
        # Bob bridged but never read the sealed payload (it isn't addressed to him):
        self.assertEqual(nb.inbox, [])


if __name__ == "__main__":
    unittest.main()
