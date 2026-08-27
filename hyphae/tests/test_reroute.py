"""The message reroutes itself: cut one path, another carries it.

Diamond topology — Alice reaches Dave through EITHER Bob or Carl:

        Bob
       /   \\
    Alice    Dave
       \\   /
        Carl

With the Alice->Bob leg dead (Bob never wakes), the message must find its own way
around, through Carl. Nothing reconfigures the route by hand; the message floods
every open branch, remembers where it's been, and the copy through Carl arrives.
"""
import unittest

from hyphae import Identity, Node, Capabilities, loopback_pair

LINK = Capabilities(
    name="link", rate_bps=1e6, mtu=1200, latency_s=0.01, reach_m=1000,
    error_rate=0.0, directionality="full", legal_class="unlicensed-ism",
    detectability=0.3,
)


def _diamond():
    ids = {n: Identity.from_seed(bytes([ord(n)]) * 32) for n in "ABCD"}
    ab_a, ab_b = loopback_pair(LINK)
    ac_a, ac_c = loopback_pair(LINK)
    bd_b, bd_d = loopback_pair(LINK)
    cd_c, cd_d = loopback_pair(LINK)
    A = Node(ids["A"], bearers=[ab_a, ac_a])
    B = Node(ids["B"], bearers=[ab_b, bd_b], relay=True)
    C = Node(ids["C"], bearers=[ac_c, cd_c], relay=True)
    D = Node(ids["D"], bearers=[bd_d, cd_d])
    return ids, A, B, C, D


class TestReroute(unittest.TestCase):
    def test_reroutes_around_a_dead_path(self):
        ids, A, B, C, D = _diamond()
        # Urgent => Alice floods every branch at once (delivery beats stealth).
        mid = A.send(ids["D"].address, ids["D"].x_public_bytes,
                     b"the river found another channel", created_at=0,
                     priority=200)
        # Bob is DOWN: we never tick him. Only Carl's path is alive.
        for i in range(40):
            C.tick(i)
            D.tick(i)
            A.tick(i)
            if A.is_delivered(mid):
                break
        self.assertTrue(A.is_delivered(mid), "message did not reroute around the cut")
        self.assertEqual(D.inbox[0][1], b"the river found another channel")
        self.assertEqual(B.inbox, [])  # the dead node carried nothing

    def test_hop_budget_bounds_the_search(self):
        # A line A -> B -> D. With no hop budget, B refuses to relay, so the
        # message cannot reach a destination two hops away.
        ids = {n: Identity.from_seed(bytes([ord(n)]) * 32) for n in "ABD"}
        ab_a, ab_b = loopback_pair(LINK)
        bd_b, bd_d = loopback_pair(LINK)
        A = Node(ids["A"], bearers=[ab_a])
        B = Node(ids["B"], bearers=[ab_b, bd_b], relay=True)
        D = Node(ids["D"], bearers=[bd_d])

        mid0 = A.send(ids["D"].address, ids["D"].x_public_bytes, b"no budget",
                      created_at=0, deadline_s=5, hop_limit=0)
        for i in range(10):
            B.tick(i); D.tick(i); A.tick(i)
        self.assertEqual(D.inbox, [])                 # never got there
        self.assertFalse(A.is_delivered(mid0))

        # Same topology, a budget of one hop: now it arrives.
        ids, A, B, D = ids, A, B, D
        mid1 = A.send(ids["D"].address, ids["D"].x_public_bytes, b"one hop",
                      created_at=100, deadline_s=600, hop_limit=1)
        for i in range(100, 140):
            B.tick(i); D.tick(i); A.tick(i)
            if A.is_delivered(mid1):
                break
        self.assertTrue(A.is_delivered(mid1))
        self.assertEqual(D.inbox[0][1], b"one hop")


if __name__ == "__main__":
    unittest.main()
