---
name: wire-ux-finish
description: Finish WIRE interfaces against established human-reading and interaction principles. Use for UI changes, repeated design feedback, cross-surface inconsistencies or user-facing readiness review. Inspect affected real journeys and transitions without launching a redesign or broad test campaign.
license: MIT
---

# WIRE UX finish

Make the existing WIRE experience understandable and usable. Technical
correctness and a polished isolated component do not establish that result.

## 1. Recover the intent, not just the treatment

Read the original feedback and relevant current sections of
[design](../../../docs/design.md) and the
[user guide](../../../docs/user-guide.md). Reuse already recovered decisions.
For controls, reading order or return behavior, read the affected surface in
[interaction design](../../../docs/interaction-design.md).
Inspect supplied reference images when needed; say when they are unavailable.
Later rejection supersedes an earlier approved mock. Keep private feedback and
real-data screenshots out of published source.

State the user's question, useful facts, reading order and each action's effect.
For interaction reading, the prompt establishes context; tools, services,
outcomes and supporting details explain what happened.

Separate the enduring principle from a proposed treatment. "Make this coherent"
does not mean copy filter pills into every section. "Reduce noise" does not mean
hide useful evidence inside more disclosure panels. Deduplicate the same scoped
fact, not distinct records with equal text or timestamps.

**Ready:** identify the actual comprehension/interaction failure and the affected
surfaces before changing controls or paint.

## 2. Correct the shared cause

Find prior art and the owning shared component/projection. Apply repeated
feedback across the related cards, reader, Search, filters, Settings or reporting
surfaces actually affected. Keep unrelated redesign opportunities out of scope.

- Give primary facts, labels, values, supporting context and actions deliberate
  hierarchy through alignment, regular typography and purposeful spacing.
- Use concise, concrete wording. Retain necessary uncertainty and exact evidence
  without exposing every stored field, repeated heading or engineering recital.
- Preserve the current Asta Sans, Lucide, theme and sidebar conventions in the
  design contract; derive current values there rather than copying old palettes.
- Share author, service and outcome meaning across surfaces. Labels/icons support
  color; service identity is not success and missing evidence is not failure.
- Inspect painted glyphs, baselines, line boxes, padding and hit areas together.
  Accessible targets need not create oversized paint or phantom blank rows.
- Put actions beside their task context. Distinct consent, destructive and
  recovery actions keep their effects and boundaries even when prose is reduced.
- Preserve screen/report style isolation and the current shared Search behavior.

Use existing WIRE components and browser automation for observation. This
workflow needs no personal design skill, new design system, reference hunt
or component framework.

**Ready:** the candidate fixes the shared cause while preserving meaning, exact
content, accessibility and existing product behavior.

## 3. Operate the affected journey

Use the normal renderer on the exact candidate with realistic invented data:
plural tools/services, long content, missing facts or failures where relevant.
Follow the affected path into and back out of its contextual surfaces.
Inspect the composed screen, not only crops or computed style values.
Use the existing [isolated fixture pattern](../../../docs/development.md#keep-development-data-separate);
a different port alone does not isolate a store.

Choose relevant cases, not the Cartesian product of every state:

- Actual hover, pressed, keyboard focus, Copy and menu interactions.
- Filter/query changes without page bounce, focus loss or stale content.
- Sidebar entry, reversal, exit and content replacement; applicable reduced
  motion and the loaded page's real settings, not forced-animation fixtures.
- Close/Escape, Back/Forward, pagination and meaningful reading-position return.
- Both themes and relevant narrow/enlarged-text states, including useful empty,
  loading, error and recovery states.

A still image cannot prove motion or focus. A green check cannot excuse an
obviously confusing layout. Fix observed defects with the existing owner and
retest that scenario; do not commission another review team or broad campaign.
Respect permission gates for private data, clipboard effects and live operations.

**Ready:** the relevant user action works and the resulting information is
readable without new clutter, layout shifts or broken return behavior.

## 4. Finish honestly

The worker self-reviews; an active coordinator inspects the combined experience
before presenting a combined build. Reuse candidate-matched proof and existing
reviewers rather than creating a new approval chain.

Record only useful findings: affected path, observed problem, consequence,
correction and concise evidence. Keep private screenshots/logs outside source;
publish only approved synthetic documentation images with their fixture
provenance. Preserve baseline limitations. If the required renderer or journey
cannot be exercised, name that gap instead of claiming acceptance.

Visual acceptance is not evidence that acquisition, persistence or reporting
works. When those are required,
[end-to-end delivery](../wire-end-to-end-delivery/SKILL.md) must close their
actual criteria too. Present one coherent version with real remaining limits.
