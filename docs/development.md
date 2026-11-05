# Development

WIRE runs as a local Node server with a browser interface. Start with the
[README](../README.md#start) to clone and install it. This guide covers working
on the source, checking a change and troubleshooting a local installation.

## WIRE development skills

For contributors using Copilot, the repository includes eight WIRE-specific
[project skills](https://docs.github.com/en/copilot/concepts/customizations/agent-skills)
in [`.github/skills`](../.github/skills). Open a Copilot session in this checkout
and ask it to use a skill by name, for example, "Use wire-local-search to fix
Search highlighting." Copilot can also select a relevant skill from its description.
Human contributions do not require Copilot or skills.

| Work | Skill |
| --- | --- |
| Coordinate outcomes and ownership | [wire-coordination](../.github/skills/wire-coordination/SKILL.md) |
| Implement and deliver a complete change | [wire-end-to-end-delivery](../.github/skills/wire-end-to-end-delivery/SKILL.md) |
| Preserve evidence meaning and unknowns | [wire-evidence-semantics](../.github/skills/wire-evidence-semantics/SKILL.md) |
| Change literal on-device Search | [wire-local-search](../.github/skills/wire-local-search/SKILL.md) |
| Change reports without altering frozen facts | [wire-report-integrity](../.github/skills/wire-report-integrity/SKILL.md) |
| Handle Refresh, repair or uncertain operations | [wire-safe-recovery](../.github/skills/wire-safe-recovery/SKILL.md) |
| Change collection or source access | [wire-source-integration](../.github/skills/wire-source-integration/SKILL.md) |
| Finish reading and interaction journeys | [wire-ux-finish](../.github/skills/wire-ux-finish/SKILL.md) |

These workflows and their required references are part of WIRE under its
[MIT license](../LICENSE). They grant no permission to access private data,
collect sources, change accounts, replace a runtime or publish work.
No global installation or extra app configuration is needed. If an existing
session still shows an older skill catalog, use a new session in this checkout.

## Run locally

Use Node.js 24 or newer in the environment that will run WIRE. On WSL or Linux,
use native Linux Node and install dependencies there; do not reuse a Windows
`node_modules` directory.

```text
npm ci
npm start
```

Open `http://127.0.0.1:4000/` and keep the terminal running. Use **Ctrl+C** in
that terminal to stop WIRE; closing the browser tab leaves it running.

To update an existing checkout, stop its WIRE process, pull the changes, run
`npm ci` and restart. If the port is already in use, check whether WIRE is
already running rather than stopping an unfamiliar process.

## Windows, WSL and Linux

Starting the server and accessing Copilot history are separate requirements:

| Source location | What collection needs |
| --- | --- |
| Supported local metadata on the same OS as WIRE | Read access to the approved metadata database and history folder; WIRE opens SQLite read-only |
| Windows-owned live metadata read from WSL | Readable Windows source paths and an existing Windows Node 24+ available as `node.exe` through WSL interop, in addition to Linux Node running WIRE |

For the WSL case, WIRE runs the same bounded metadata reader in a short-lived
Windows helper. It is not another WIRE server or daemon and does not copy the
database. See [source access](collection.md#source-mapping-and-bounded-reads).
Installing Node or running WIRE on an OS does not by itself make a supported
Copilot source available.

If Windows WIRE is already on port 4000, run a second instance from a separate
WSL checkout. Run `npm ci` there, then choose a separate data folder and unused port:

```sh
WORKIQ_EVIDENCE_DATA_DIR="$HOME/.local/share/wire-wsl/data" npm start -- --port 4001
```

Port **4001 is an explicit example**, not a WSL default. Open the printed URL
in a browser that can reach the WSL listener; access from a Windows browser
depends on WSL localhost forwarding. The Windows instance can keep running:
there is no need to move its store or stop it to start an independent WSL instance.

Each instance needs its own source approval and optional reply-saving consent.
Its cached activity, collection cursors, settings and reports remain separate,
even when both instances read the same approved source. Use the
[data-location rules](collection.md#store-ownership) to select other folders;
do not point WSL at the Windows instance's writable store.

## Changing the local port

WIRE listens on `127.0.0.1:4000` by default. To choose another port:

```text
npm start -- --port 4100
```

Use `--port 0` for an available port, then open the URL printed in the terminal.
An occupied explicit port is an error. The port does not isolate or move data;
`WORKIQ_EVIDENCE_DATA_DIR` selects the store.

Before restarting on a different port, finish drafts and resolve unconfirmed
operations in the current tab. Browser preferences, drafts and recovery markers
belong to that address and do not transfer. Never repeat an uncertain operation
at a new address.

## Keep development data separate

A disposable fixture needs an explicit owned data directory outside source,
disabled collection timers and invented source paths. Never point it at a
normal store, existing browser profile or original history.

Browser tests set up temporary stores through
[`tests/helpers.mjs`](../tests/helpers.mjs) and close their own resources.
Reuse that pattern for tests and image capture. A different port alone does
not create a separate store.

## Check a change

Run the syntax check and the tests for the behavior you changed. For example,
a literal Search matching change can start with:

```text
npm run check
node --test tests/search-text.test.mjs
```

`check` validates JavaScript syntax. Runtime validators and focused tests cover
input contracts. Use `npm test` for the default suite when a change needs
broader coverage. In your pull request, describe the scenario checked and any
failures or skips.

For source-reader changes, the opt-in
`tests/wsl-portability.qualification.mjs` suite runs from Windows against
an owned WSL installation of the same revision. Set `WIRE_WSL_DISTRO`,
`WIRE_WSL_NODE` and `WIRE_WSL_SOURCE` to its distribution name, absolute Linux
Node executable and checkout path. It uses invented sources and disposable
stores to check concurrent readers, restart, incremental reads and refusals;
the Windows helper requirement above still applies.

Packaging changes have a separate lane:

```text
npm run test:packaging
```

It creates a disposable production-only installation and verifies saved-PDF
text extraction without development dependencies. Run it separately from other
installation or browser checks. `npm test` does not include it.

## PDF and browser tools

PDF generation uses the pinned Playwright runtime dependency and a local
Chromium browser:

```text
npx playwright install chromium
```

This is an optional browser download. HTML, JSON and Markdown do not need it.
If Chromium is unavailable, install it or deselect PDF and prepare a new review.

Saved-PDF reading uses PDF.js locally and does not require Chromium. It reads
the text layer, not OCR; no remote conversion service is used.

For documentation images, use an existing synthetic fixture, ordinary
Playwright interactions and the unmodified normal renderer. Capture only
useful states, inspect every image for readability and private data, and close
the owned runtime/browser and remove its temporary store. Keep fixture provenance
with capture evidence, and add a visible caption only when it helps explain the task.

## Troubleshoot a local run

| What you see | What to check |
| --- | --- |
| WIRE cannot start because the port is owned | Use the existing WIRE window, or stop the WIRE process you started before restarting. |
| The page opens but no activity appears | Review the source paths and history window in Settings. Open Collection status for missing or unsupported history. See [Connect local history](user-guide.md#connect-local-history). |
| WSL reports that the Windows source reader is unavailable | Make an existing Windows Node 24+ executable available as `node.exe` through WSL interop, and check access to the selected Windows paths. Do not copy the live database or share WIRE stores as a workaround. |
| PDF preparation cannot find a browser | Install Chromium with the command above, or deselect PDF and prepare a new review. Other formats do not need that browser. |
| A save or deletion has an uncertain result | Use its status/result check. Do not repeat the action to see whether it worked. See [collection and recovery](collection.md#refresh-and-uncertain-outcomes) or [report saving](reporting.md#approve-save-and-reopen). |

## Find the owning code

| Work | Entry points and contract |
| --- | --- |
| Collection and persistence | `lib/source-discovery.mjs`, `source-reader.mjs`, `source-metadata.mjs`, `collector.mjs`, `collector-io.mjs`, `store.mjs`, `paths.mjs`; [collection](collection.md) |
| Access and uncertain effects | `lib/runtime-access.mjs`, `client-transport.mjs`, `web/client.mjs`; [runtime access](runtime-access.md) |
| Canonical evidence and filters | `lib/analytics.mjs`, `activity-analytics.mjs`, `activity-projection.mjs`, `service-categories.mjs`; [report meanings](report-contract.md#evidence-and-membership) |
| Search | `lib/search-text.mjs`, `search-retrieval.mjs`, `search-corpus.mjs`, `live-search.mjs`; [Search](live-search.md) and [corpus](search-corpus.md) |
| Reports | `lib/export.mjs`, `report-facts.mjs`, `report-artifacts.mjs`, `product-report.mjs`, `pdf.mjs`; [report contract](report-contract.md) |
| Screens | `lib/render.mjs`, `web/client.mjs` and existing surface owners; [design](design.md) |

Read the contract for the boundary you change. Use source and tests for exact
schemas rather than copying them into another guide.

When changing bundled assets, keep their license notices intact, including the
[Asta Sans OFL](../assets/fonts/OFL.txt) and Lucide ISC/Feather MIT notices.
