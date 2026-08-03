# Security posture

WhiteBox stores the most sensitive class of personal data a system can hold — a person's
identity, memory, and (by design intent) affective context — on hardware the user owns. That
data class raises the stakes of every design decision, and it is why this project treats
security as an ongoing discipline, not a checkbox.

## Why we adversarially verify our own system

WhiteBox is a multi-agent system: multiple AI agents, some with real capability, read and write
a shared user-owned substrate, and some ingest untrusted content from the open web. In that
setting, a defense that has only been *designed* is not a defense — it is a hope. The sensitivity
of the data makes it mandatory to verify our protections adversarially: we red-team and blue-team
the system against both outside attackers and *insider* threats, including a corrupted or
deceptively-aligned agent operating from inside the trust boundary. A control counts only when we
have tried to break it and measured the result — not because we asserted that it works.

## What we deliberately do not publish

This repository describes our security *properties and intent*, not the *mechanisms* by which we
detect, contain, or adjudicate malicious behavior. Detection internals, monitoring specifics, and
operational configuration are withheld on purpose: publishing them would hand an adversary a map
and weaken the people the system is meant to protect. This is operational secrecy around
detection, layered on top of a design that does not rely on secrecy for its correctness. Where we
are unsure whether a detail helps a reader or an attacker more, we leave it out.

## Reporting a vulnerability

Good-faith security research is welcome. Please report privately via this repository's GitHub
**Security Advisories** ("Report a vulnerability") rather than opening a public issue, so we can
address it before it is disclosed. We will engage.
