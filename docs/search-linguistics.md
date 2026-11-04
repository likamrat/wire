# Historical linguistic Search

WIRE no longer offers linguistic Search. Use [local text Search](live-search.md)
for the current matching and privacy contract; no dictionary or model setup
is needed.

The former experiment used a local parser and dictionary to add role-bound
matches to semantic retrieval. It remained disabled and unqualified for
activation when retired.

## What the experiment established

| Question | Historical result |
| --- | --- |
| Could matching use grammatical roles and dictionary relationships? | The additional path required a consistent operation, participant and location within the same recorded event. Shared ancestry or a high similarity score was insufficient. |
| Could it discard a modifier? | No. Dropping `broken` from `broken automobile` invalidated the claimed gain for an unmodified car query. Required modifier sequences and head lemmas had to agree. |
| Could it prove a negative? | No. The parser lacked enough event-domain and quantifier scope. The additional path accepted positive assertions only. |
| Did safety corrections qualify better recall? | No. The original positive requirements and ordinary-work misses remained open. Passing fail-closed checks did not establish the missing positive matches. |

Unsupported grammar kept the baseline retrieval path; it was not clipped or
rewritten to manufacture a proof. Lexical support described retained text,
not execution, answer correctness, ownership or permission.

## Boundaries worth preserving

- Search stayed on-device. Provider sessions, assessment approval and AI credits
  could not supply relevance or authorize off-device processing.
- Resources required explicit provisioning and verified local bytes. Provisioning
  was separate from activation; startup and typing did not download anything.
- Added hits used the same current-source, permission and integrity delivery
  gate as baseline hits. Cancellation and close waited for owned helper exit.
- Navigation-only Related candidates did not enter analytical membership.
  Complete accepted membership, not a result page, governed charts and reports.
- Qualification required `MUST ⊆ actual ⊆ ALLOWED`. Unspecified recall and
  allowed-only checks were not positive qualification.

These are historical findings, not alternative settings for current Search.
Current literal matching does not interpret intent or apply the former denial
veto.

## Preserved research and reproduction limit

The [complete published research text](https://github.com/likamrat/wire/blob/0585abe8b2294da12b140af5e948897b53119822/docs/search-linguistics.md)
preserves the former interfaces, bounds, resource identities, test commands,
qualification ledger and detailed limitations.

That link preserves **documentation, not the old implementation**.
The historical code pin `b1ccf65e8d79534b35a347c992e947d067837858` is not
available through this published repository. Its provisioning scripts and
suites are not commands for the current checkout. Do not install resources
or restore private ancestry to try to reproduce them.

## Resource provenance and notices

| Former resource | Pinned provenance | Notice |
| --- | --- | --- |
| Compromise 14.17.0 | Git revision `263fab53e01f18c8ba2ed5c69fb128c7116a3185` | Unmodified MIT license alongside the reviewed standalone ESM bundle and package metadata |
| `wordnet-db` 3.1.14 | Git revision `9e5cbc56523450c50d6655c8ba47bcb9fabf7935` | Unmodified Princeton WordNet notice/disclaimer alongside the noun/verb data, indexes, metadata and README |

The WordNet package declares data version 3.1, but its supplied license is
headed *WordNet Release 3.0*. That discrepancy remains part of its provenance;
the database is not simply MIT or an independently reproduced Princeton archive.

Notices must remain with any existing resource copies. Do not commit the
database or strip its notices when packaging. The original ten-file inventory
and byte/hash checks are preserved in the linked research text.
