# WIRE source handoff

Status as of 2026-10-08. This is the portable, source-only handoff for this
publication. The full local operational handoff remains private and is not
included in Git.

## Included in this snapshot

The accepted saved-report library is composed over the accepted coverage-first
application, not an older feature branch's whole checkout.

- Reports opens the saved library. Create/Continue draft retains the separate
  Requests -> Contents -> Review -> Save flow.
- Saved-report metadata search spans all pages. Previous/Next and Page/Go
  navigation, direct Open controls and explicit unavailable-HTML states are
  included. Search does not read private report contents or prompts.
- Delete all reports requires a counted, membership-bound preview and a separate
  confirmation. It targets saved report bundles across pages/search, not
  collected activity, saved comparisons, drafts or external downloads. Reports
  created after preview are excluded.
- Saved comparisons preserve frozen bytes. Unsaved comparisons depending on
  removed reports invalidate. Logical removal and partial filesystem cleanup
  are distinct; receipt/restart recovery stays bound to the original operation.
- Coverage-first Insights, readable model/rubric origins, analytical filter
  controls and the previously accepted historical-metadata tooling are retained.
- Both README setup guides and the font/artwork licenses are preserved.

Adding deletion controls does not authorize deleting anyone's real reports.
Publication does not change the running application, private data or permissions.

## Continue on another machine

Authenticate personal Git access to the private repository. Use Node.js 24 or
newer and npm 11.17.0, as declared in `package.json`.

```powershell
git clone https://github.com/likamrat/wire.git
Set-Location wire
npm ci
npm start
```

Open `http://127.0.0.1:47831/`. See [README.md](README.md) for optional canvas and
PDF setup, and [README-USER.md](README-USER.md) for product behavior.

The checkout starts with its own empty private state. It contains no existing
reports, collected interactions, model results, account profiles or source
configuration. Configure and sign in locally on the new machine. Response saving
and automatic assessment require their own consent; installing source grants
neither. Do not copy private configuration or the full operational handoff into
the checkout.

For an existing clone already on sanitized history, stop only that machine's own
runtime before `git pull --ff-only`, `npm ci` and restart. Do not stop another
machine's server. An old clone with the original identifying ancestry requires
careful synchronization or a fresh clone, not merging that ancestry into main.

## Preserved unfinished work

This source candidate includes connected-failure clarity and the separately
guarded one-target repair entry; it is not a live release or user acceptance.
Its distinction is between the recorded execution outcome and the
independent AI-assessment state for the exact request. A later successful request
must not supply a cause or score for an earlier failed one. A generic tool error,
missing assessment or insufficient evidence is not a zero quality score.

Before integration, review the owned source delta and synthetic proof on this
newer library source. Preserve the library entry,
deletion protections, coverage semantics, readable origins and frozen report
facts; do not replace the application with an older candidate's whole checkout.

A one-target historical signal repair entry now has synthetic stale-target,
scored-target, second-writer, crash/recovery, revision and preservation checks.
It changes only the finite signal and matching retained checkpoint. Publication does
not authorize reading original private evidence or preparing/applying a real
data repair. Those operations need separately reviewed, bounded permission.

Broader automatic assessment, prior uncertain evaluator accounting,
error-reference semantics and saved/human-reviewed comparison inputs remain
separate gates. Do not replay consumed attempts or infer enrollment permission
from the delivered bounded scoring work.

## Quality and validation boundaries

Accuracy, Speed, answer Trust and action Trust remain distinct. Tool execution
failure does not itself prove an inaccurate answer or an unauthorized action.
Quality coverage is not broad accuracy across unassessed history, and unlike
scope denominators must not be pooled as though their membership were identical.

Current Cost display remains retired. Evaluator allowance/accounting and
no-replay safeguards are still required. Optional feedback is not a mandatory
grading queue.

The accepted library has focused synthetic and normal-entry evidence. This is
not a claim that the full test suite is green: existing baseline fixture,
selector and allowlist failures are documented. Large-library pagination proof
uses synthetic data, not transferred user reports.

Relevant source contracts are [docs/design.md](docs/design.md),
[docs/personal-evaluation.md](docs/personal-evaluation.md) and
[docs/reporting.md](docs/reporting.md).

## Publication and privacy rules

Keep future publications source-only, rooted in sanitized main, with reviewed
source deltas and privacy-safe commit identities. Never import old identifying
parents, merge unaccepted work, or publish private reports, proof artifacts,
release manifests, credentials, local configuration, operational IDs or paths.

Reachable published ancestry is sanitized. That does not guarantee erasure of
earlier commit objects, server caches or existing clones. Do not claim global
removal or expand cleanup/access changes without approval.
