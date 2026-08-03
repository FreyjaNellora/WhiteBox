#!/usr/bin/env python
"""
Sovereign Search - canonical content artifact (seam-defense primitive, NO deps).

THE PROBLEM THIS SOLVES
  In a scrape->scan->read pipeline, the components almost never fail on their own -
  the *seams* between them do. The deadliest seam is the "parser differential":
  the scanner normalizes bytes one way, the reader tokenizes them another, and an
  attacker crafts input the scanner reads as clean while the reader reads as an
  instruction. Every place two components interpret the same bytes differently is
  a door.

THE FIX (one canonical artifact, frozen and hashed)
  Normalize ONCE, here, and freeze the result. Every downstream component - the
  injection classifier, the powerless reader, the audit log - consumes the SAME
  frozen artifact, never a re-parse. The digest PROVES they all saw identical
  bytes: the instant any component's view doesn't match the hash, that's the seam
  hole, caught.

  Two views come out of one normalization, and they cannot diverge (proven in
  test_canonical.py::test_seam_views_agree):
    - .safe_text : readable content, invisibles/dangerous chars removed. What the
                   reader/user actually sees.
    - .fold      : an aggressively-folded MATCHING skeleton (NFKC + cross-script
                   confusable mapping + accent-strip + casefold). What a signature
                   scanner / classifier matches against, so "ignore", fullwidth
                   "ignore", and Cyrillic-homoglyph "ignore" all collapse to ONE
                   string - the multi-language / homoglyph evasion can't split the
                   scanner's view from the reader's.

  This is also the codebase's single definition of "dangerous char." quotemine.py
  currently carries its own inline copy (is_dangerous/scan_text/clean_for_output);
  it should be refactored to import from here so there is ONE definition, not three
  drifting ones.

Usage (CLI):  echo "some text" | python canonical.py
              python canonical.py --file page.txt
"""

import argparse
import hashlib
import json
import math
import re
import sys
import unicodedata
from collections import Counter
from dataclasses import dataclass

# ---------------------------------------------------------------- danger taxonomy
# One definition, reused everywhere. Aligned with quotemine.py's categories.
ZERO_WIDTH = {0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF}
SAFE_WS = {0x09, 0x0A, 0x0D}                      # tab, newline, carriage return

# Categories a caller may treat as CRITICAL (fail-closed). zero-width is stripped
# and noted but not itself critical (matches quotemine's release policy).
CRITICAL = frozenset({"control-char", "bidi-override", "tag-char",
                      "homoglyph", "encoded-blob"})


def danger_cat(cp: int):
    """Category string for a dangerous code point, or None. Excludes ZERO_WIDTH
    (handled separately: stripped + noted) and SAFE_WS."""
    if cp in SAFE_WS:
        return None
    if cp < 0x20 or (0x7F <= cp <= 0x9F):     # C0 (0x00-0x1F) + DEL + C1 (0x80-0x9F) = all Unicode Cc.
        return "control-char"                 # C1 (incl. NEL U+0085, CSI U+009B) is invisible but hostile.
    if 0x202A <= cp <= 0x202E or 0x2066 <= cp <= 0x2069:
        return "bidi-override"
    if 0xE0000 <= cp <= 0xE007F:
        return "tag-char"
    # Catch-all for the interstitial gap between the named blocks: ANY invisible Unicode Format (Cf)
    # char that isn't a strong override/tag/zero-width — LRM U+200E, RLM U+200F, ALM U+061C, the
    # invisible math operators, etc. Category-based so new Unicode versions are covered automatically.
    # TRADE-OFF (intentional, security > byte-fidelity): this also strips script-internal format marks
    # that are legitimate but invisible — SOFT HYPHEN U+00AD, Arabic number signs U+0600-0605,
    # MONGOLIAN VOWEL SEPARATOR U+180E. For an English-credible-source tool an invisible char is far
    # likelier hostile than meaningful, and this is NOT silent: _scan() emits a "format-char" finding,
    # so the strip is disclosed in the scan report. We deliberately do NOT keep an allowlist here — a
    # hand-maintained exempt-list is exactly the "named-block" blind spot that let LRM/RLM slip through.
    if cp not in ZERO_WIDTH and unicodedata.category(chr(cp)) == "Cf":
        return "format-char"
    return None


# Cross-script confusables -> Latin skeleton. Curated to the code points actually
# used in homoglyph attacks (Cyrillic + a few Greek). NFKC already folds fullwidth
# and compatibility forms, so those are not listed here. This is a practical subset,
# not the full Unicode confusables table - swapping in `confusable_homoglyphs` or
# Unicode's confusables.txt is the upgrade; the interface does not change.
_CONFUSABLE = {
    # Cyrillic lower
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x",
    "і": "i", "ј": "j", "ѕ": "s", "к": "k", "м": "m", "н": "h", "т": "t",
    "в": "b", "ԁ": "d", "ѡ": "w", "ё": "e", "ӏ": "l",
    # Cyrillic upper
    "А": "A", "Е": "E", "О": "O", "Р": "P", "С": "C", "У": "Y", "Х": "X",
    "І": "I", "Ј": "J", "Ѕ": "S", "К": "K", "М": "M", "Н": "H", "Т": "T",
    "В": "B", "Г": "r", "Ё": "E",
    # Greek
    "ο": "o", "α": "a", "ν": "v", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
    "ε": "e", "ι": "i", "κ": "k", "Ο": "O", "Α": "A", "Ρ": "P", "Τ": "T",
    "Υ": "Y", "Χ": "X", "Ε": "E", "Ι": "I", "Κ": "K", "Β": "B", "Η": "H",
    "Μ": "M", "Ν": "N", "Ζ": "Z",
}
_CONFUSABLE_SET = set(_CONFUSABLE)


# ---------------------------------------------------------------- normalization core
def _strip(s: str) -> str:
    """Remove invisibles/dangerous chars and fold safe whitespace FIRST, THEN
    normalize (NFC), then collapse. ORDER MATTERS: normalizing *before* stripping
    lets a since-removed zero-width char change how its neighbors compose on a
    second pass -> non-idempotent (a bug the fuzzer caught). Stripping first makes
    _strip IDEMPOTENT, which is what makes the two views provably agree at the seam."""
    out = []
    for ch in s:
        cp = ord(ch)
        if cp in ZERO_WIDTH:
            continue
        if cp in SAFE_WS:
            out.append(" ")
            continue
        if danger_cat(cp):
            continue
        out.append(ch)
    s = unicodedata.normalize("NFC", "".join(out))
    return re.sub(r"\s+", " ", s).strip()


def _skeleton(s: str) -> str:
    """Aggressive matching form. Input is assumed already _strip'd. DECOMPOSE
    FIRST so the cross-script map sees base characters: a diacritic'd homoglyph
    (Cyrillic e + grave = U+0450) must expose its Cyrillic base before mapping, or
    a second fold decomposes it further and the two disagree (a parser-differential
    the fuzzer caught). Then map look-alikes -> Latin, recompose compatibility
    forms, casefold. Idempotent by construction."""
    s = unicodedata.normalize("NFKD", s)                            # decompose (also folds fullwidth)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))    # strip accents
    s = "".join(_CONFUSABLE.get(ch, ch) for ch in s)                # look-alikes -> latin
    s = unicodedata.normalize("NFKC", s)                            # recompose compatibility forms
    # defensive: normalization must never re-introduce an invisible/dangerous char
    s = "".join(ch for ch in s if ord(ch) not in ZERO_WIDTH and not danger_cat(ord(ch)))
    return re.sub(r"\s+", " ", s.casefold()).strip()


def _shannon(s: str) -> float:
    if not s:
        return 0.0
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in Counter(s).values())


def _scan(raw: str):
    """Detect what dangerous/suspicious content was present in the ORIGINAL bytes,
    before stripping. Returns a sorted tuple of (category, detail). Nothing hidden
    passes silently - detection is fail-loud."""
    findings = set()
    zw = sum(1 for ch in raw if ord(ch) in ZERO_WIDTH)
    if zw:
        findings.add(("zero-width", f"{zw} char(s)"))
    for ch in raw:
        cat = danger_cat(ord(ch))
        if cat:
            findings.add((cat, f"U+{ord(ch):04X}"))
        if ch in _CONFUSABLE_SET:
            findings.add(("homoglyph", f"U+{ord(ch):04X} {ch!r}->{_CONFUSABLE[ch]!r}"))
        else:
            # precomposed homoglyph: check the NFKD base(s) too, so e.g. U+0450 'ѐ' (Cyrillic ie +
            # grave) is flagged via its base U+0435 'е'. Skeleton already folds it; the SCANNER must
            # see it too or a spoof is released marked clean. Latin accents (é->e) never match — the
            # confusable map keys are Cyrillic/Greek, and Latin 'e' is a value, not a key.
            for d in unicodedata.normalize("NFKD", ch):
                if not unicodedata.combining(d) and d in _CONFUSABLE_SET:
                    findings.add(("homoglyph", f"U+{ord(ch):04X} {ch!r}->{_CONFUSABLE[d]!r}"))
    for tok in re.findall(r"\S{40,}", raw):
        if _shannon(tok) > 4.3 and re.fullmatch(r"[A-Za-z0-9+/=_-]+", tok):
            findings.add(("encoded-blob", tok[:24] + "..."))
    return tuple(sorted(findings))


# ---------------------------------------------------------------- the artifact
@dataclass(frozen=True)
class Canonical:
    """A frozen (immutable) canonical view of scraped content. Freeze + hash are
    what let every downstream component prove it saw the same bytes."""
    raw_len: int
    safe_text: str
    fold: str
    findings: tuple
    digest: str

    @property
    def critical(self) -> tuple:
        return tuple(f for f in self.findings if f[0] in CRITICAL)

    @property
    def is_clean(self) -> bool:
        return not self.critical


def canonicalize(raw: str) -> Canonical:
    """Normalize scraped content ONCE into a frozen, hashed artifact. Pure and
    deterministic: same input -> same digest, always."""
    if not isinstance(raw, str):
        raw = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
    safe_text = _strip(raw)
    fold = _skeleton(safe_text)
    findings = _scan(raw)
    # Canonical serialization mirrors the audit-chain's cross-language JSON discipline
    # (sort_keys, tight separators, ensure_ascii=False) so the digest is stable and
    # reproducible across languages/processes.
    payload = json.dumps(
        {"safe": safe_text, "fold": fold, "findings": [list(f) for f in findings]},
        sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    )
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return Canonical(len(raw), safe_text, fold, findings, digest)


def readable(raw) -> str:
    """Reader-safe view only: invisibles/dangerous removed, NFC, whitespace
    collapsed. Same as canonicalize(raw).safe_text, for callers that just need to
    clean text (e.g. the quote-miner) - ONE definition, imported not copied."""
    if not isinstance(raw, str):
        raw = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
    return _strip(raw)


def scan_text(raw) -> tuple:
    """Findings only (category, detail), fail-loud. Same as canonicalize(raw).findings."""
    if not isinstance(raw, str):
        raw = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
    return _scan(raw)


# ---------------------------------------------------------------- CLI
def main():
    ap = argparse.ArgumentParser(description="Canonicalize scraped content.")
    ap.add_argument("--file", help="read from file instead of stdin")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    except Exception:
        pass
    raw = open(args.file, encoding="utf-8").read() if args.file else sys.stdin.read()
    c = canonicalize(raw)
    print(f"digest    : {c.digest}")
    print(f"raw_len   : {c.raw_len}")
    print(f"clean     : {c.is_clean}  ({len(c.critical)} critical / {len(c.findings)} findings)")
    for cat, detail in c.findings:
        mark = "!!" if cat in CRITICAL else "  "
        print(f"  {mark} {cat}: {detail}")
    print(f"safe_text : {c.safe_text[:200]}")
    print(f"fold      : {c.fold[:200]}")


if __name__ == "__main__":
    main()
