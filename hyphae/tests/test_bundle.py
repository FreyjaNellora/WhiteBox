"""L1 bundle: sealing, signing, round-trip, and tamper detection."""
import unittest

from hyphae import Identity, Bundle


class TestBundle(unittest.TestCase):
    def setUp(self):
        self.alice = Identity.from_seed(b"A" * 32)
        self.bob = Identity.from_seed(b"B" * 32)

    def test_roundtrip_and_verify(self):
        msg = b"the message is sovereign; the channel is disposable"
        b = Bundle.create(self.alice, self.bob.address, self.bob.x_public_bytes,
                          msg, created_at=1000, deadline_s=60)
        raw = b.to_bytes(self.alice)
        got = Bundle.from_bytes(raw)
        self.assertTrue(got.verify())
        self.assertEqual(got.src, self.alice.address)
        self.assertEqual(got.dest, self.bob.address)
        self.assertEqual(self.bob.open_sealed(got.payload), msg)

    def test_content_addressed_id_stable(self):
        b1 = Bundle.create(self.alice, self.bob.address, self.bob.x_public_bytes,
                           b"x", created_at=1)
        # msg_id is a hash of src+payload; deterministic for identical payload
        b2 = Bundle(dest=b1.dest, src=b1.src, src_pubkey=b1.src_pubkey,
                    payload=b1.payload, created_at=1)
        self.assertEqual(b1.msg_id, b2.msg_id)

    def test_tamper_breaks_signature(self):
        b = Bundle.create(self.alice, self.bob.address, self.bob.x_public_bytes,
                          b"hello", created_at=1)
        raw = bytearray(b.to_bytes(self.alice))
        raw[-1] ^= 0x01  # flip a signature bit
        self.assertFalse(Bundle.from_bytes(bytes(raw)).verify())

    def test_forged_src_address_rejected(self):
        # Carry Alice's pubkey but claim a different src address.
        b = Bundle.create(self.alice, self.bob.address, self.bob.x_public_bytes,
                          b"hello", created_at=1)
        b.src = b"\x00" * 16
        forged = b.to_bytes(self.alice)
        self.assertFalse(Bundle.from_bytes(forged).verify())

    def test_expiry(self):
        b = Bundle.create(self.alice, self.bob.address, self.bob.x_public_bytes,
                          b"hi", created_at=1000, deadline_s=60)
        self.assertFalse(b.is_expired(1050))
        self.assertTrue(b.is_expired(1061))


if __name__ == "__main__":
    unittest.main()
