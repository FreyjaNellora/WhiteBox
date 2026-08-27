"""The first non-simulated bearer: a real Hyphae message over real UDP sockets.

Two nodes, each with an IPBearer bound to a loopback port, exchange a sealed,
signed, fountain-coded message and a signed receipt — over the actual network
stack, not an in-process queue. This is the path Wi-Fi and cellular ride on the
device.
"""
import unittest

from hyphae import Identity, Node
from hyphae.ip_bearer import IPBearer


class TestIPBearer(unittest.TestCase):
    def test_real_udp_delivery_with_receipt(self):
        alice = Identity.from_seed(b"A" * 32)
        bob = Identity.from_seed(b"B" * 32)

        # Bind to port 0 so the OS picks free ports, then wire each node's bearer
        # to point at the other's resolved address.
        a_sock = IPBearer(("127.0.0.1", 0), ("127.0.0.1", 0), name="ip/wifi")
        b_sock = IPBearer(("127.0.0.1", 0), a_sock.bound, name="ip/wifi")
        a_sock.peer = b_sock.bound

        na = Node(alice, bearers=[a_sock])
        nb = Node(bob, bearers=[b_sock])
        try:
            # Small blocks so every fountain symbol fits comfortably in a datagram.
            mid = na.send(bob.address, bob.x_public_bytes,
                          b"crossed a real socket, not a python list" * 8,
                          created_at=0, deadline_s=600, block_size=200)
            delivered = False
            for i in range(50):
                nb.tick(i)
                na.tick(i)
                if na.is_delivered(mid):
                    delivered = True
                    break
            self.assertTrue(delivered, "no signed receipt came back over UDP")
            self.assertEqual(nb.inbox[0][0], alice.address)
            self.assertEqual(nb.inbox[0][1],
                             b"crossed a real socket, not a python list" * 8)
        finally:
            a_sock.close()
            b_sock.close()


if __name__ == "__main__":
    unittest.main()
