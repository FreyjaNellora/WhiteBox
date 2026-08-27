"""L2 fountain coding: reassembly from a partial, out-of-order symbol stream."""
import hashlib
import os
import random
import unittest

from hyphae import Encoder, Decoder


class TestFountain(unittest.TestCase):
    def _roundtrip(self, data: bytes, block_size: int, drop: float, shuffle: bool):
        msg_id = hashlib.sha256(data).digest()[:16]
        enc = Encoder(msg_id, data, block_size=block_size)
        dec = Decoder()
        rng = random.Random(1234)
        # Emit generously; simulate loss and reordering on the way to the decoder.
        symbols = enc.stream(int(enc.k * 3) + 20)
        if shuffle:
            rng.shuffle(symbols)
        for sym in symbols:
            if rng.random() < drop:
                continue  # bearer lost this fragment
            if dec.add(sym):
                break
        self.assertTrue(dec.complete, "decoder never completed")
        self.assertEqual(dec.result(), data)

    def test_small(self):
        self._roundtrip(b"hello hyphae", block_size=4, drop=0.0, shuffle=False)

    def test_multiblock_lossy_shuffled(self):
        data = os.urandom(4000)
        self._roundtrip(data, block_size=256, drop=0.3, shuffle=True)

    def test_single_block(self):
        self._roundtrip(b"x" * 10, block_size=256, drop=0.0, shuffle=False)

    def test_exact_multiple_of_block(self):
        self._roundtrip(os.urandom(512), block_size=256, drop=0.1, shuffle=True)

    def test_symbols_from_two_sources_mix(self):
        # Two encoders (as if two bearers) for the SAME bundle interleave; the
        # decoder reassembles from the mixed stream. This is the core property.
        data = os.urandom(2000)
        msg_id = hashlib.sha256(data).digest()[:16]
        enc_a = Encoder(msg_id, data, block_size=256)
        enc_b = Encoder(msg_id, data, block_size=256)
        dec = Decoder()
        # Distinct seed ranges => genuinely different coded symbols per "bearer".
        stream = [enc_a.symbol(s) for s in range(1, 21)]
        stream += [enc_b.symbol(s) for s in range(1001, 1021)]
        random.Random(7).shuffle(stream)
        for sym in stream:
            if dec.add(sym):
                break
        self.assertTrue(dec.complete)
        self.assertEqual(dec.result(), data)


if __name__ == "__main__":
    unittest.main()
