# Hyphae wire formats (v1)

All integers big-endian. This is the normative byte layout the reference
implementation reads and writes. Version tag is the bundle magic `HYF1`.

## Bundle (L1)

Signature covers every byte before `sig`.

| field       | bytes | notes |
|-------------|-------|-------|
| magic       | 4  | `b"HYF1"` |
| dest        | 16 | destination address |
| src         | 16 | source address, MUST equal `sha256(src_pubkey)[:16]` |
| src_pubkey  | 32 | raw Ed25519 public key of the source |
| msg_id      | 16 | `sha256(src \|\| payload)[:16]` (content address) |
| created_at  | 8  | uint64 seconds since epoch |
| deadline_s  | 4  | uint32 seconds after `created_at`; 0 = no expiry |
| priority    | 1  | uint8, 0 bulk .. 255 emergency |
| det_budget  | 1  | uint8, max detectability × 100 |
| flags       | 1  | uint8, bit0 = receipt requested |
| _reserved   | 1  | uint8, 0 |
| payload_len | 4  | uint32 |
| payload     | N  | sealed ciphertext (libsodium sealed box) |
| sig         | 64 | Ed25519 signature over all preceding bytes |

## Fountain symbol (L2)

Self-describing; carries no ordering requirement.

| field      | bytes | notes |
|------------|-------|-------|
| msg_id     | 16 | bundle this symbol reconstructs |
| k          | 4  | uint32 number of source blocks |
| block_size | 4  | uint32 bytes per block |
| orig_len   | 4  | uint32 original bundle length (trim padding) |
| seed       | 4  | uint32 PRNG seed → source-block neighborhood |
| data       | block_size | XOR of the neighbor blocks |

## Bearer frame (L0/L3)

A 1-byte kind prefix distinguishes payload types on a bearer.

| kind | value | body |
|------|-------|------|
| SYMBOL  | 0x01 | a fountain symbol (above) |
| RECEIPT | 0x02 | a delivery receipt (below) |

## Receipt (L3)

Proof of delivery, signed by the recipient over `b"HYFR" || msg_id`.

| field     | bytes | notes |
|-----------|-------|-------|
| msg_id    | 16 | the delivered bundle |
| recipient | 32 | raw Ed25519 public key; `sha256(...)[:16]` must equal the bundle `dest` |
| sig       | 64 | Ed25519 signature over `b"HYFR" \|\| msg_id` |
