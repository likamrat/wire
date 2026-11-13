# Development

WIRE runs as a local Node server with a browser interface. Start with the
[README](../README.md#start) to clone and install it. This guide covers working
on the source, checking a change and troubleshooting a local installation.

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
If Chromium is unavailable, install it or deselect PDF and prepare the report again.

Saved-PDF reading uses PDF.js locally and does not require Chromium. It reads
the text layer, not OCR; no remote conversion service is used.

For documentation images, use an existing synthetic fixture, ordinary
Playwright interactions and the unmodified normal renderer. Capture only
useful states, inspect every image for readability and private data, and close
the owned runtime/browser and remove its temporary store. Keep fixture provenance
with capture evidence, and add a visible caption only when it helps explain the task.
Application screenshots in Markdown use Light theme and the browser's light
color scheme. Theme-aware diagrams and brand assets keep their light/dark variants.

[`tests/documentation-screenshots.mjs`](../tests/documentation-screenshots.mjs)
captures Analyze, Search, reporting, comparisons and Settings with invented
activity and disposable saved reports. Set `WIRE_DOC_OUTPUT` to an owned image
directory and `WIRE_DOC_PROOF` to a separate private evidence directory, then run:

```text
node --test tests/documentation-screenshots.mjs
```

For count/share widgets and the compact prompt reader only, set
`WIRE_DOC_CAPTURE=widgets` to capture Analyze, the README overview, the reader,
Search over Analyze and live period comparison without unrelated report journeys
or screen captures. One synthetic saved report supplies the Search example.
Set `WIRE_DOC_CAPTURE=reports` for report choices, reading, copy inspection,
file views and Save/Open without recapturing Analyze, comparisons or Settings.
Set `WIRE_DOC_CAPTURE=analyze` for only Analyze and the README overview, without
creating saved-report fixtures or visiting unrelated destinations.

The capture requires committed product source, uses an available loopback port
with collection timers disabled, and closes its browser/runtime and temporary
store. It records source and fixture hashes, image hashes and inspected file
formats in the private evidence directory. Inspect the captures before copying
the applicable PNGs into `docs/images`; keep receipts and extra proof images out
of source.

For first-use connection, run `tests/first-connection.browser.test.mjs` with
`WIRE_FIRST_CONNECTION_PROOFS` set to an owned private directory. It exercises
the welcome, deliberate source approval and first retained activity using
invented Copilot metadata and history. Only the welcome image is used in the
guide; source-review captures include temporary local paths and stay private.

Shared-control proofs use `tests/appwide-controls.browser.test.mjs` with
`WIRE_VISUAL_PROOFS` set to an owned capture directory. Its invented activity
and saved reports also exercise keyboard paging and frozen-file preservation.
Focused Settings-search proofs use `tests/settings-search.browser.test.mjs` with
`WIRE_SETTINGS_SEARCH_PROOFS` set to an owned capture directory. It starts
the normal runtime on an ephemeral port with invented Cedar activity and source
paths, disables collection timers, rejects action requests and checks that
retained data and collection configuration stay unchanged.

For Trends, `tests/trends.browser.test.mjs` uses invented requests and the normal
renderer, with collection timers and provider work disabled. Set
`WIRE_TRENDS_PROOFS` to an owned private capture directory. The overview, daily
axes, exact-evidence reading, filters, sizing and heading-icon journeys share
that fixture; screenshots are not evidence of live collection or deployment.
The widget-layout regression operates every chart in overview, maximized,
collapsed and restored states at 3440px landscape, 1080px portrait and enlarged
narrow text. It checks full-width rows, visible measure controls, whole labels
and the absence of accidental vertical chart scrolling.
The control matrix also exercises every measure and series toggle, sizing,
exact evidence, numbers and guide controls for all seven widgets over
7/14/30/custom periods. Separate hover captures verify centered, nonoverlapping
targets and uniform collapsed rows in both themes and enlarged text.
Date-context cases verify every widget header after presets and custom Apply,
including month/year boundaries, one-day ranges, Cancel, held/failed reads and
access withdrawal. Source-wide coverage metadata remains separate from the
chart-specific limits shown in Trends.
Point-selection cases compare all widget bounds and scroll positions before
and after actual data clicks across the seven-widget/four-period matrix.
Touch and keyboard also select in place; explicit sizing must retain the
selected point and its exact evidence.

For the brand and navigation header, `tests/branding.browser.test.mjs` uses
invented Cedar activity and a synthetic selected profile in the normal renderer.
Set `WIRE_BRAND_PROOFS` to an owned private directory for theme/layout captures
and unpaused frame traces. It checks full-name help, separate navigation help,
header alignment, repeated reversal, the mounted avatar and the narrow drawer
under native and explicitly reduced-motion preferences. Providers and action
requests are blocked; its disposable runtime and store are closed afterward.

## Troubleshoot a local run

| What you see | What to check |
| --- | --- |
| WIRE cannot start because the port is owned | Use the existing WIRE window, or stop the WIRE process you started before restarting. |
| The page opens but no activity appears | Review the source paths and history window in Settings. Open Collection status for missing or unsupported history. See [Connect local history](user-guide.md#connect-local-history). |
| "Collection cannot check history" appears | Open Collection status for the failing source operation and reason. Retained activity stays available. A transient metadata change can recover on the next ordinary collection interval; investigate persistent failures using the [status diagnostic guidance](runtime-access.md#check-a-background-return). |
| Returning to a tab briefly shows "Checking WIRE access" | A current access watch should keep the accepted view. If the watch can no longer establish fresh authority, WIRE must confirm access again. For recurring interruptions, use the [access-watch diagnostic guidance](runtime-access.md#check-a-background-return). |
| WSL reports that the Windows source reader is unavailable | Make an existing Windows Node 24+ executable available as `node.exe` through WSL interop, and check access to the selected Windows paths. Do not copy the live database or share WIRE stores as a workaround. |
| PDF preparation cannot find a browser | Install Chromium with the command above, or deselect PDF and prepare the report again. Other formats do not need that browser. |
| A save or deletion has an uncertain result | Use its status/result check. Do not repeat the action to see whether it worked. See [collection and recovery](collection.md#refresh-and-uncertain-outcomes) or [report saving](reporting.md#save-and-reopen). |

## WIRE development skills

The [skills landing page](../.github/skills/README.md) explains the eight optional
WIRE skills and when to use each. In a Copilot session opened in this checkout,
ask for one by name, for example, "Use wire-local-search to fix Search highlighting."
Copilot can also select a relevant skill from its description; GitHub's
[agent-skills guide](https://docs.github.com/en/copilot/concepts/customizations/agent-skills)
explains that mechanism.

No global installation or extra app configuration is needed. If an existing
session still shows an older skill catalog, use a new session in this checkout.
Human contributions do not require Copilot or skills.

## Find the owning code

| Work | Entry points and contract |
| --- | --- |
| Collection and persistence | `lib/source-discovery.mjs`, `source-reader.mjs`, `source-metadata.mjs`, `collector.mjs`, `collector-io.mjs`, `store.mjs`, `paths.mjs`; [collection](collection.md) |
| Access and uncertain effects | `lib/runtime-access.mjs`, `client-transport.mjs`, `web/client.mjs`; [runtime access](runtime-access.md) |
| Canonical evidence and filters | `lib/analytics.mjs`, `activity-analytics.mjs`, `activity-projection.mjs`, `service-categories.mjs`; [report meanings](report-contract.md#evidence-and-membership) |
| Search | `lib/search-text.mjs`, `search-retrieval.mjs`, `search-corpus.mjs`, `live-search.mjs`; [Search](live-search.md) and [corpus](search-corpus.md) |
| Reports | `lib/export.mjs`, `report-facts.mjs`, `report-artifacts.mjs`, `product-report.mjs`, `pdf.mjs`; [report contract](report-contract.md) |
| Screens | `lib/render.mjs`, `web/client.mjs` and existing surface owners; [shared design](design.md) and [interaction behavior](interaction-design.md) |

Read the contract for the boundary you change. Use source and tests for exact
schemas rather than copying them into another guide.

When changing bundled assets, keep their license notices intact, including the
[Asta Sans OFL](../assets/fonts/OFL.txt) and Lucide ISC/Feather MIT notices.
