# Development

WIRE runs as a local Node server with a browser interface. Start with the
[README](../README.md#getting-started) to clone and install it. This guide covers working
on the source, checking a change and troubleshooting a local installation.

## Run locally

Use Node.js 24 or newer in the environment that will run WIRE. On WSL or Linux,
use native Linux Node and install dependencies there; do not reuse a Windows
`node_modules` directory.

```text
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:4000/` and keep the terminal running. Use **Ctrl+C** in
that terminal to stop WIRE; closing the browser tab leaves it running.

To update an existing checkout, stop its WIRE process, pull the changes, run
`npm ci`, rebuild with `npm run build` and restart. If the port is already in use, check whether WIRE is
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
WSL checkout. Run `npm ci` and `npm run build` there, then choose a separate data folder and unused port:

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

### Run a feature checkout beside main

From the feature checkout, install dependencies with `npm ci`, then run:

```text
npm run dev
```

This builds the checkout and starts the normal access-bound WIRE server with
the React renderer on loopback port 4100. Its private store is outside Git,
keyed to the checkout's physical directory. Reopening the same checkout keeps
its store; moving the checkout creates a new one. Different branches switched
in the **same directory** share a store: use separate worktrees to isolate them.
This launcher refuses an inherited `WORKIQ_EVIDENCE_DATA_DIR`. Unset it in the
contributor shell; do not copy main's store or approvals.

Open the **printed URL**, not main's port or a restricted preview. Choose an
unused port with `npm run dev -- --port 4101`; keep it stable for browser
preferences and pending operations. For the other renderer use
`npm run dev -- --development-frontend bundled`. The renderer does not select
an account, approve a source or change permission. **Review and connect**
lets you independently approve supported local Copilot history. Before approval
the Account menu is neutral; a verified profile comes from that instance's
approved source, not a copied avatar or the branch name.

If using the optional WIRE canvas, its **updated adapter** accepts
`{"boardId":"workiq-evidence-board-v1","runtimePort":4100}` at open. Use the
actual printed port and a distinct canvas instance; omitting the port selects
main's default 4000. The installed shim points at one checkout's adapter, not
its server. If its schema lacks `runtimePort`, use the browser URL or explicitly
install the updated shim (`npm run install:canvas`) and reload extensions.
Installing changes the personal adapter for future sessions; it does not start
a writer or grant source access. A closed or replaced runtime requires a
fresh canvas; resolve uncertain operations in the original instance, never
replay them on another.

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

### Browser build and React evaluation

`npm run build` creates local, content-hashed browser modules in `dist/client`.
Normal startup serves these assets from the existing Node server; it does not
run a Vite server or require development dependencies at runtime. The panel
bootstrap remains private and uncached. A missing build or a source/build
mismatch fails explicitly; rebuild rather than falling back to older code.
Pre-paint theme/navigation preferences stay in the small inline bootstrap.

`lib/page-path.mjs` lists the shell's exact GET paths. `/` is Analyze;
`/analyze` and a single trailing slash are accepted aliases. A recognized
legacy route fragment is replaced in the same history entry; ordinary document
anchors are not routes. Do not add a catch-all SPA fallback: assets, APIs, saved
files and unknown paths must retain their own handling and access checks.
The bundled and React clients use the same route controller. Its public query
projection admits known choices and dates, never record IDs, free text, source
paths or operation receipts. A `privateView=required` marker carries no data
or authority. Private state and a modified-click handoff live only in the
authorized page; copying the marker cannot recover them. An ordinary saved
report link names the saved bundle, not permission to read it.

An ordinary retained interaction may use `/request?record=…`. Its locator
is a purpose-separated HMAC using the store's existing pseudonym key, access
generation, source binding, deletion epoch and exact record identity. Resolve
it only in the currently admitted snapshot, with no lookup API, separate
registry, or write. A missing or ambiguous match is unavailable. Search-owned
reads, exact calls and other private scopes do not become ordinary bookmarks.

For React evaluation, use the [feature checkout launcher](#run-a-feature-checkout-beside-main).
For an already managed, explicitly owned evaluation store, set
`WORKIQ_EVIDENCE_DATA_DIR` to its absolute path and use
`npm start -- --development-frontend react --port <unused-port>`.
Without an explicit store, this lower-level React command refuses startup;
it never silently adopts the normal default store.
The single React shell composes the header/navigation, Analyze overview and
activity, filter panel, Search and contextual reader. Existing chart, evidence,
select-control and Search controllers are explicit native DOM adapters, not
parallel authorities. React-owned structure and native-owned content do not
replace each other's children.

`web/frontend/workspace-state.ts` owns accepted evidence/scope, pending reads,
navigation and reading generations, date drafts and return positions for both
entries. Only public destination/readiness metadata enters the shell's React
subscription; private content remains fenced by the shared transport and its
owned presenters. Reader exit releases response hosts as well as text readers.

The compact Analyze hierarchy shares one accepted period, keeps actual scope
qualifications visible and retains complete breakdowns below full-width evidence.
Trends, Reports, Compare and Settings still use their existing feature
controllers. Omitting the flag retains the bundled established renderer; this
development selection is not authorization to replace a live runtime.

For an isolated synthetic check without starting a normal store:

```text
npm run test:frontend
```

This type-checks, builds and exercises both entries, including exact Search
Open/Back, accepted/failed/held filter reads, later navigation intent, retired
actions and cross-panel withdrawal with the reader, Search and filters present.
Repeated complete journeys check mounted-shell identity, released response hosts
and stable connected DOM/listener counts. Raw heap/DOM-counter samples are also
recorded; browser-native input edit history is not application-owned DOM leakage.
`WIRE_FRONTEND_PROOFS` can name a private output directory for screenshots and
delivery measurements. `WIRE_FRONTEND_BROWSER=msedge` selects an already installed
Edge for that fixture; it does not download a browser. Measurements are samples,
not proof that adding React is faster. Numerical acceptance budgets remain
separate from the existing behavioral checks.

The `startServer` library retains its inline compatibility entry when `frontend`
is omitted, for existing serialization-based fixtures. New frontend proof must
explicitly use `frontend: "bundled"` or `"react"` and the real build. Do not treat
an inline fixture as proof of the packaged browser entry.

To compare Analyze counts with main, prepare this checkout and a separate
trusted reference checkout for their respective normal startup (`npm ci` and
`npm run build --if-present` in each). Set
`WIRE_COUNT_REFERENCE_ROOT` to the reference checkout's absolute path, then run
`node --test tests/count-parity.qualification.mjs` here. It launches the
reference normally and this checkout in contributor mode on ephemeral ports,
approves the same invented source in two disposable stores, and checks call
and interaction identities as well as the counts shown across pages and filters.
It does not connect to either running installation or copy personal history.

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

The sidebar performance case compares native collapse/expand motion on populated
7- and 30-day Trends with Analyze and Reports in the same browser. It measures
input-to-motion, completion, frame gaps, long tasks and full SVG rebuilds, with
repeated reversal and a portrait layout. Width-only changes must reposition
mounted chart nodes, not reformat dates or rebuild the evidence scene.
Both latest-date and earlier-date anchors must survive reversal; deliberate
horizontal scrolling during the glide must replace the old anchor.
Run it with `node --test --test-name-pattern="populated Trends sidebar motion" tests/trends.browser.test.mjs`.
Set `WIRE_TRENDS_PERFORMANCE` to an owned JSON file for measurements; optional
`WIRE_TRENDS_PROFILE` writes the 30-day Chromium CPU profile. Keep these private.
Timing uses invented activity, disabled collection timers and the unchanged
320ms sidebar animation; an empty chart or shorter animation is not a substitute.

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
