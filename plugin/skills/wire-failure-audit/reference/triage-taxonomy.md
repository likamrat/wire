# Triage taxonomy

Use observed evidence, not a mandatory verdict distribution. Split a cluster when its members
need different causes or dispositions. A common status code is not a common root cause.
`unclassified` is the correct answer when evidence is insufficient.

| Verdict | Evidence needed | Disposition |
|---|---|---|
| `test-probe` | Session/test intent establishes a deliberate negative test, and the response is expected | Preserve evidence; exclude from production numerator and denominator; report the count |
| `client-side` | Concrete host/configuration/transport evidence identifies ownership | Route to the appropriate ADO area, not automatically to WorkIQ |
| `contract-gap` | Applicable advertised contract and incompatible runtime result, with permission/context differences considered | Assess evidence track, then ADO dedupe |
| `product-bug` | Valid in-scope request mishandled under the applicable contract | Assess evidence track, then ADO dedupe |
| `caller-error` | Request is invalid and not reasonably derived from shipped guidance | Record caller remediation; inspect guidance provenance |
| `by-design` | Applicable documented limit/policy accounts for the observed response | Record limit and supported alternatives; capability requests are not proven defects |
| `infra-transient` | Transient failure pattern, with infrastructure ownership only if established | Preserve recurrence and unresolved ownership; Track B only if admissible |
| `fixed-since` | Named applicable fix or repeated representative successes with ongoing use | Record basis and dates; don't infer a fix from silence |
| `not-reproduced-now` | Passed now or reproduction was unavailable/unsafe | Preserve original cause separately; not sufficient on its own to file |
| `unclassified` | Cause or relevant contract cannot be established | Local evidence/draft; state what would resolve uncertainty |

## Decisions that need particular care

- Invalid IDs, `null`, empty input and bursts of variants are **hints**, not proof of deliberate
  testing. An actual caller can generate them accidentally. A negative test returning an
  unexpected 500 or hanging remains a potential defect rather than an automatic exclusion.
- A client timeout reports where waiting ended, not why. A slow server can cause it. Do not
  reclassify all `-32001` calls as host bugs or subtract them from experience metrics.
- If a caller followed server docs, a skill or discovery output, identify that guidance as a
  possible defect and cite it. No source means caller provenance is unknown, not invented.
- One 429 followed by success is not proof of a fix. Lack of recent failures without recent
  usage is also not proof. Recurrence across days supports prioritization, not automatic cause.
- A control on a different resource does not rule out permissions. State comparable conditions
  and the single changed dimension before drawing a mechanism conclusion.
- Test a workaround on the relevant endpoint. Mail `InefficientFilter` does not demonstrate
  failure of a Teams-chat filtering workaround; these are different service contracts.
- Do not demand a contract gap, caller error, or product bug merely to satisfy a histogram.
  Investigate suspicious distributions without changing labels to make them look plausible.

## Evidence tracks and replay

Track A needs a current valid failing request and meaningful successful control.
Track B needs recurrence, recent correlation evidence and an explicit reproduction disposition
(failed, passed now, or skipped with a reason). A skipped write alone is neither track.
Unknown/read/write semantics must be established anew before probing; safe-looking names or
imported verdicts are not authorization. Never replay captured writes against original targets.

## Persistent audit ledger

Keep one row per cluster using a stable content-derived ID. Store exact member frame IDs and
separate raw from adjusted counts. Missing fields remain unknown; don't use defaults that imply
a check occurred.

```sql
CREATE TABLE IF NOT EXISTS mcp_clusters (
  id TEXT PRIMARY KEY,
  tool TEXT,
  signature TEXT,
  member_frame_ids TEXT,
  raw_count INTEGER,
  adjusted_count INTEGER,
  first_seen TEXT,
  last_seen TEXT,
  day_counts TEXT,
  verdict TEXT,
  cause_notes TEXT,
  rw_class TEXT,
  repro_disposition TEXT,
  repro_call TEXT,
  control_call TEXT,
  request_ids TEXT,
  evidence_track TEXT,
  evidence_limitations TEXT,
  ado_org TEXT,
  ado_project TEXT,
  ado_area TEXT,
  candidates_read TEXT,
  overlap TEXT,
  existing_item TEXT,
  redaction_review TEXT,
  approved_actions TEXT,
  posted_ids TEXT,
  notes TEXT
);
```

`rw_class` is `read`, `write`, or `unknown-treat-as-write`; the last is the safe default.
`approved_actions` records approval of the specific destination and payload, not merely the
user's request to investigate. Record exclusions and malformed-input accounting separately:
a malformed row with no known tool/signature is not a fabricated failure cluster.

Before an ADO write require the relevant evidence, dedupe, redaction and specific approval
fields. Preserve returned IDs. A timeout is ambiguous; inspect for a completed write before
retrying. This ledger is a record, not a script that posts by itself.

## Verdict files

A diagnostic bundle's verdicts template lists every cluster by its stable ID. Use those IDs, not rank labels such as `c01`; adding observations must never move a verdict to a different cluster. Unknown IDs and invalid verdicts are refused. Missing entries stay `unclassified`.

Select negative-test exclusions per call with `probe_frame_ids`, not with a cluster-wide verdict, when a real call and a deliberate probe share one signature. The raw count stays visible beside the adjusted count.
