---
name: wire-evidence-semantics
description: Preserve WIRE's evidence meaning across metrics, filters, charts, cards and reports. Use for canonical population, denominators, outcomes, errors, service classification, author/model provenance or timestamp changes. Keep missing, partial and unknown evidence distinct from zero or failure.
license: MIT
---

# WIRE evidence semantics

Start with the current definitions in the
[report contract](../../../docs/report-contract.md) and the affected
producer/consumer. Use [collection fidelity](../../../docs/collection.md#evidence-fidelity)
when changing retained facts.

## Preserve the unit and population

- Count canonical identities once in the declared population before pagination.
  Keep matching calls distinct from their complete parent interactions.
- Preserve Current view, Selected and All collected activity semantics; hidden
  selections and complete-root membership are not the visible page.
- Keep tool calls, returned API entries/statuses, recorded sites, code references,
  messages and task completions as their own evidence units.
- Identify each denominator and compatible clock. Do not pool unlike source
  rates or treat supporting conversation context as a measured call cohort.
- Distinguish known empty membership from unavailable identity or incomplete
  coverage. Missing is not zero; partial results do not prove complete coverage.

## Preserve the meaning

Successful tool execution does not prove answer correctness, authorization or
overall task completion. Discovery/schema inspection is not execution of the
operation described. A returned API status is not automatically its parent
call's failure cause.

Use recorded model, author, service, path and timestamp provenance. Keep unknown
or conflicting facts explicit; infer none from color, names, adjacent messages
or current account state. Capture/commit/completion time cannot silently become
call-start time. Version changed definitions rather than reinterpreting frozen
historical facts.

For failures, separate an observed error from its retained cause. Distinguish
not recorded, not retained and excluded for privacy when the evidence supports
that distinction. A past sign-in failure is not proof the current account needs
to sign in. Use concise human wording without discarding useful error codes.

## Check one fact through its consumers

Trace representative known, missing, partial and conflicting examples through
filters, widgets, exact rows, the reader and any affected report projection.
Verify the same membership and source-qualified meaning, allowing deliberate
differences between a filtered summary and the full interaction.
Use the existing shared projection rather than independent browser-side inference.

Completion means the changed fact keeps its qualified meaning through every
affected consumer, with explicit limits and focused matching evidence. Use
[report integrity](../wire-report-integrity/SKILL.md) for frozen output changes;
no new scoring, inference or source-reading authority follows from this skill.
