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

### Updating WIRE

On Windows or WSL, in-app updates require a clean standalone clone of the
official WIRE repository on `main`, with the updater already included.
Use `npm start` with the usual port and data folder, without development flags.
Automatic checks are on by default. To check now, open **Settings > General**
and choose **Check for updates**. This works even if you turned automatic checks
off. When WIRE offers a build, choose **Update and restart** in General or in the
bottom-right notification. **Dismiss** hides the notification; the update stays
available in General.

For a clean official `main` clone, use the manual path on macOS or standalone
Linux, or if the installed version predates the updater. Finish open work and
stop only its own WIRE process. In that same clone, run `git pull --ff-only origin main`,
`npm ci`, `npm run build` and `npm start` with the original OS user,
data-folder override and port. Do not switch a development copy to `main`.
A conflict is a reason to stop, not to rebase or discard someone's edits.

WIRE checks when first opened after launch and daily while in use. It compares
the running app with the official `main` branch, so an app change can be offered
even if the package version stays the same. Changes to contributor docs,
tests or CI alone do not create an update notice. Git uses the current
user's repository access; no source approval or Copilot sign-in is requested.

Finish any report, close other WIRE panels, and resolve unconfirmed saves or
deletions before updating. Keep the terminal open while WIRE prepares its
replacement. App versions and the activation record stay inside this clone’s
Git directory, separate from evidence. A failed check is not “up to date.”
On restart, return to the same address and reopen an old canvas if needed.
The updater never restores a previous copy of your store or takes over a port.
If it cannot verify a clean shutdown or compatible reader, leave the store and
lock intact and inspect the original launcher error.

Store read/write protocol 2 includes the explicit agent-authored origin. The
managed updater refuses a protocol-1/protocol-2 transition before stopping
the current writer. Qualify both the primary and fallback for the new retained
and saved-report vocabulary before a manual transition or author repair;
see [prompt origin reader compatibility](collection.md#prompt-origin-reader-compatibility).

Archives without `.git`, contributor worktrees, forks, modified clones and special
development launch modes stay manual. Do not use a new data folder to resolve an update problem.
For a directly launched runtime, **General** shows the package version and
**Update instructions**. WIRE cannot check or restart this copy. Keep its usual
update and restart process.
One-click activation is qualified on Windows and WSL. Standalone Linux and
macOS use the same-folder manual path until their cutover tests pass natively.
Special modes cannot bypass an active staged build or unresolved handoff.
When a candidate changes the registered canvas adapter or its dependencies,
WIRE declines the switch rather than silently running the old adapter.
An expired tab can lose data access without resolving its draft or Save.
If WIRE cannot confirm that all panels finished, resolve their original
operations before manually restarting; do not replay them from a new tab.
When adding a document consumed at runtime, list its tracked path in
`lib/update-runtime-docs.json` so changes to that document qualify. An
incompatible store, launcher or canvas change must update the compatibility
contract rather than silently treating older readers as compatible.

`npm run test:update-runtime` builds and updates a disposable clone using
the platform's own Git, Node and npm, then reopens a saved report at the
original address and verifies its bytes. It does not update your installation.
With the project's Playwright Chromium installed, set `WIRE_UPDATE_BROWSER=1`
to exercise **Update and restart** in Settings and verify that the
reloaded browser is executing the new build.

To try the update yourself on Windows or WSL, set `WIRE_UPDATE_BROWSER=manual`
and run `npm run test:update-runtime`. In PowerShell:

```powershell
$env:WIRE_UPDATE_BROWSER = 'manual'
npm run test:update-runtime
Remove-Item Env:WIRE_UPDATE_BROWSER
```

Open the printed **Disposable update simulation** address in one tab. In
**Settings > General**, choose **Check for updates**. Checking does not
install anything. Try **Dismiss**, then choose **Update and restart** in General.
When the same page says **WIRE updated**, open **Reports** to read the saved
example. The simulation verifies the running revision. No GitHub release,
account connection or change to your usual WIRE installation is involved.
The simulation waits up to 20 minutes for the update, then stays open two
minutes after verification so you can inspect the result.

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
operations in the current tab. Browser preferences and recovery markers belong
to that address; unfinished previews belong to their panel. Named report
drafts are stored with the instance. A new port does not create a new store.
Never repeat an uncertain operation at a new address.

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

If using the optional WIRE canvas, its adapter accepts
`{"boardId":"workiq-evidence-board-v1","runtimePort":4100}` at open. Use the
actual printed port and a distinct canvas instance; omitting the port selects
main's default 4000. If the canvas does not offer `runtimePort`, use the
browser URL or run `npm run install:canvas` in this checkout and reload
extensions. This points your personal canvas launcher at this checkout's
adapter for future sessions. It does not start
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

Use `npm run test:packaging` for the production-only installation check. It
builds the browser assets, then checks the packaged browser and local Search
against the same disposable install.

For changes to native report selection, saving or recovery, run `npm run build`
followed by `node --test tests/native-report-save.qualification.mjs`. This
browser check uses invented Microsoft activity and a disposable store. It
needs no live Microsoft account or separate backend checkout. It runs
separately from `npm test`.

Two other checks need an explicit environment. Use a fresh PowerShell session
for each:

- **Browser zoom:** With Chrome installed and the client built, set
  `$env:WIRE_CHART_NATIVE_ZOOM = '1'`. Run
  `node --test --test-concurrency=1 --test-name-pattern="actual 200% browser zoom|complete filter qualifications until reset \(native zoom\)" tests/analyze-entry-layout.browser.test.mjs tests/chart-reference-integration.browser.test.mjs`.
  These checks zoom the browser itself, not just the page font.
- **Offline operator and transport:** On a clean Windows checkout, set
  `$env:WIRE_HISTORY_TEST_COMMIT = (git rev-parse HEAD)`. Run
  `node --test --test-concurrency=1 --test-name-pattern="offline clean candidate:" tests/microsoft-engineering-admission.test.mjs tests/microsoft-native-transport.test.mjs`.
  This exercises startup, cancellation and cleanup without launching a live provider.

### Changing a Copilot journal format

Run `npm run test:history-compatibility` when changing source recognition,
retention or historical recovery. It uses invented journals and disposable
stores. It compares normal collection with recovery from the **same original
events** after the connector mapping arrives late. Compare the originating
prompt, author, call, start, completion and outcome, not just the count.
A start without an end can be retained as unknown by collection; it is not
independently recoverable as a completed call.

For a newly observed layout, add the smallest invented example to the
existing fixtures. Keep an older layout in the comparison and include a
counterexample that would change attribution or exclusions. A new field is
not safe merely because the current collector ignores it. An unfamiliar
record after a valid call must not produce an empty-success response or
leave the earlier call available for confirmation. No test should require
someone's real history or permission to replay it.

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
To offer **Verified records only (day incomplete)** on one Copilot-only
runtime, append `--verified-record-recovery` to its startup command. The
option lasts only for that process; it does not change the store, approval,
collection policy or default strict selection. Omitting it leaves
verified-record recovery unavailable. See [explicit recollection](collection.md#explicit-recollection).

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

For an isolated synthetic check without starting a normal store, install the
Chromium build for this checkout's Playwright version if it is missing:

```text
npx playwright install chromium
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
Edge for the evaluation fixture only; the bundle test still uses Playwright's
Chromium. Neither test downloads a browser. Measurements are samples,
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

### Capture documentation screenshots

[`tests/documentation-screenshots.mjs`](../tests/documentation-screenshots.mjs)
captures Analyze, Trends, Search, reporting, comparisons and Settings with invented
activity and disposable saved reports. Set `WIRE_DOC_OUTPUT` to an owned image
directory and `WIRE_DOC_PROOF` to a separate private evidence directory, then run:

```text
npm run build
node --test tests/documentation-screenshots.mjs
```

For count/share widgets and the compact prompt reader only, set
`WIRE_DOC_CAPTURE=widgets` to capture Analyze, the README overview, the reader,
Search over Analyze and live period comparison without unrelated report journeys
or screen captures. One synthetic saved report supplies the Search example.
Set `WIRE_DOC_CAPTURE=reports` for report choices, reading, copy inspection,
file views and Save/Open without recapturing Analyze, comparisons or Settings.
Set `WIRE_DOC_CAPTURE=analyze` for Analyze, the outcome link and reader, and the README overview, without
creating saved-report fixtures or visiting unrelated destinations.

The capture uses the feature checkout's compiled React renderer and requires
committed product source. It uses an available loopback port
with collection timers disabled, and closes its browser/runtime and temporary
store. It records source and fixture hashes, image hashes and inspected file
formats in the private evidence directory. Inspect the captures before copying
the applicable PNGs into `docs/images`; keep receipts and extra proof images out
of source.

Capture the maximized reader separately. In Analyze, open an invented interaction
with a returned entry and a separate failed call. Choose **Maximize interaction**
and keep both calls and the recorded reason in view for `interaction-maximized.png`.

For first-use connection, run `tests/first-connection.browser.test.mjs` with
`WIRE_FIRST_CONNECTION_PROOFS` set to an owned private directory. It exercises
the welcome, deliberate source approval and first retained activity using
invented Copilot metadata and history. Only the welcome image is used in the
guide; source-review captures include temporary local paths and stay private.

For a change to an individual control, use its existing browser test rather
than rebuilding every documentation image. These tests take a private output directory:

| What changed | Browser test | Output variable |
| --- | --- | --- |
| Keyboard paging or file controls | `tests/appwide-controls.browser.test.mjs` | `WIRE_VISUAL_PROOFS` |
| Settings search | `tests/settings-search.browser.test.mjs` | `WIRE_SETTINGS_SEARCH_PROOFS` |
| Daily charts, sizing, dates or the return from a call | `tests/trends.browser.test.mjs` | `WIRE_TRENDS_PROOFS` |
| Brand, navigation or avatar | `tests/branding.browser.test.mjs` | `WIRE_BRAND_PROOFS` |

For sidebar motion on populated charts, run
`node --test --test-name-pattern="populated Trends sidebar motion" tests/trends.browser.test.mjs`.
Set `WIRE_TRENDS_PERFORMANCE` to a private JSON file for timings, or
`WIRE_TRENDS_PROFILE` for the Chromium CPU profile. For an actual divider
drag, build first and run `node --test tests/sidebar-resize.qualification.mjs`.

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
[Asta Sans OFL](../assets/fonts/OFL.txt), React Icons MIT and Lucide ISC/Feather MIT notices.
Add icon roles to `web/icon-roles.mjs` and named `react-icons/lu` exports to
`scripts/react-icon-selection.mjs`. Run `npm run icons:generate` and commit the
generated SVG catalog; `npm run build` checks it against the installed package.
The packaged DOM and native renderers use this catalog without React roots,
an icon font, an external request, or a development dependency at startup.
