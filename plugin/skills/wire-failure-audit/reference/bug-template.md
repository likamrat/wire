# Bug and comment template

Redact before proposing a write. Request IDs and path shape are useful; user content, access
tokens, capability URLs, subjects, attendee lists and full successful batch payloads are not.
Internal bundle identity retention does not authorize copying that identity into an ADO item.
HTML-escape untrusted evidence before placing it inside HTML fields.

## Title

`[MCP] <tool>: <observed defect> under <condition>`

Name a mechanism only when demonstrated. “Returned nextLink is rejected by fetch” is supported
by an A/B pair. “Router decodes before authorization” needs additional implementation evidence.
Do not replace uncertainty with a confident mechanism just to make the title sharper.

## Body

```text
Summary
What fails, under which condition, and what the user cannot complete.
Separate observed behaviour from the suspected mechanism.

Environment and scope
Host/server/build where known, transport, UTC timestamps, requested and observed
window, corpus source and capture coverage. Unknown values are explicitly unknown.

Evidence track
A: valid failing request + comparable successful control.
B: recurrence + recent correlation evidence + recorded reproduction disposition.
If neither is supported, this remains a local draft, not an asserted bug.

Reproduction
1. Obtain a real test input through an approved read.
2. Make the failing READ call (or separately approved action on a scratch target).
3. Run the comparable control and state the differing dimension.
Do not paste redacted placeholders as executable IDs or replay captured writes.

Actual / expected
Minimal sanitized diagnostic result for each operation, including status/error code.
Expected behaviour justified by the applicable contract or documentation.

Correlation
Request/client-request IDs, host call IDs where necessary, exact UTC timestamps.
State absent server IDs rather than fabricating them.

Observed frequency
Raw call count, relevant unique sessions/days, first and last seen, per-day counts.
Separate effective failures, host flags, batch operations, deliberate probes and
retry storms. Do not sum overlapping session counts.
Rates only when the same population's denominator is known and reconciled.

Impact and workaround status
Impact in user terms, supported by evidence. Frequency informs but does not decide
severity. Workarounds are tested, untested, or failed on a named endpoint/data shape.
Do not infer Teams workaround failure from an Exchange mail error.

Related ADO work
Candidate IDs read, whether this is new scope, or what fresh evidence augments
the existing item. Similar titles alone do not establish duplicate coverage.

Limitations and suspected fix
Truncated source fields, unavailable bodies, unresolved ownership, no live repro,
or missing metadata. A proposed fix is labelled a hypothesis unless proven.
```

For comments, include only the delta: new recurrence, recent reproduction, materially broader
scope, or a newly tested workaround. Do not repeat unsupported claims from an older item.
Approval covers the exact proposed body and destination. Preserve the posted comment ID.
