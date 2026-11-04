# Development

WIRE runs as a local Node server with a browser interface. Start with the
[README](../README.md#start) to clone and install it. This guide covers working
on the source, checking a change and troubleshooting a local installation.

## Run locally

Use Node.js 24 or newer and npm 11.17.0, as declared in
[`package.json`](../package.json). Git access to this repository is separate
from Copilot authentication, local source approval and desktop-selected identity.

```powershell
npm ci
npm start
```

Open `http://127.0.0.1:4000/` and keep the terminal running. Use **Ctrl+C** in
that terminal to stop WIRE; closing the browser tab leaves it running. No build,
data migration or model download is needed for startup.

To update an existing checkout, stop its WIRE process, pull the changes, run
`npm ci` and restart. If the port is already in use, check whether WIRE is
already running rather than stopping an unfamiliar process.

## Keep development data separate

All checkouts default to the same per-user store. A disposable fixture must
provide an explicit owned data directory outside source, disable collection
timers and use invented source paths. Never point a fixture at the normal store,
an existing browser profile or original history.

`--port 0` chooses an available port; it does not isolate data. Existing browser
tests set up temporary stores through [`tests/helpers.mjs`](../tests/helpers.mjs)
and close their own resources. Reuse that pattern for tests and image capture.

## Changing the local port

The default is `4000`, bound only to `127.0.0.1`. Use
`npm start -- --port 47831` to keep the previous address, or pass another explicit
port. WIRE refuses an occupied port instead of silently choosing another.
`WORKIQ_EVIDENCE_DATA_DIR` still selects the store; a port change does not move
retained evidence, collection settings or saved reports.

1. Finish drafts and resolve pending/unconfirmed operations in the existing tab.
   Browser-local recovery markers and memory-only drafts do not transfer;
   leave the old instance in place if recovery is unresolved.
2. Stop your instance and restart it with the chosen port.
3. Open the printed URL and update bookmarks. Existing tabs still use the old address.

Do not repeat an uncertain Save, deletion or collection operation at the new
address. Theme, sidebar and display-time-zone preferences belong to the browser
origin and may need setting again. Do not copy capabilities or browser storage
to carry a session across.

## Check a change

Run the syntax check and the tests for the behavior you changed. For example,
a literal Search matching change can start with:

```powershell
npm run check
node --test tests/search-text.test.mjs
```

`check` validates JavaScript syntax, not TypeScript types. Runtime validators
and focused tests cover input contracts. Check that the selected tests actually
ran. Use `npm test` for the default suite when a change needs broader coverage.
In your pull request, describe the scenario checked and any failures or skips.

Packaging changes have a separate lane:

```powershell
npm run test:packaging
```

It creates a disposable production-only installation and verifies saved-PDF
text extraction without development dependencies. Run it separately from other
installation or browser checks. `npm test` does not include it.

## PDF and browser tools

PDF generation uses the pinned Playwright runtime dependency and a local
Chromium browser:

```powershell
npx playwright install chromium
```

This is an optional browser download, not a startup prerequisite. HTML, JSON
and Markdown do not need it. PDF preview fails explicitly if its browser is
unavailable; deselect PDF and prepare a new review rather than silently
substituting another format.

The pinned PDF.js dependency supports local saved-PDF text extraction and
reading. Extraction is not OCR and does not require the PDF-generation browser.
No remote conversion service or signed-in browser profile is used.

For documentation images, use an existing synthetic fixture, ordinary
Playwright interactions and the unmodified normal renderer. Capture only
useful states, inspect every image for readability and private data, and close
the owned runtime/browser and remove its temporary store. Caption invented
content clearly; screenshots do not prove report-file integrity or live
collection.

## Troubleshoot a local run

| What you see | What to check |
| --- | --- |
| WIRE cannot start because the port is owned | Use the existing WIRE window, or stop the WIRE process you started before restarting. |
| The page opens but no activity appears | Review the source paths and history window in Settings. Open Collection status for missing or unsupported history. See [Connect local history](user-guide.md#connect-local-history). |
| PDF preparation cannot find a browser | Install Chromium with the command above, or deselect PDF and prepare a new review. Other formats do not need that browser. |
| A save or deletion has an uncertain result | Use its status/result check. Do not repeat the action to see whether it worked. See [collection and recovery](collection.md#refresh-and-uncertain-outcomes) or [report saving](reporting.md#approve-save-and-reopen). |

## Find the owning code

| Work | Entry points and contract |
| --- | --- |
| Collection and persistence | `lib/source-discovery.mjs`, `collector.mjs`, `collector-io.mjs`, `store.mjs`, `paths.mjs`; [collection](collection.md) |
| Access and uncertain effects | `lib/runtime-access.mjs`, `client-transport.mjs`, `web/client.mjs`; [runtime access](runtime-access.md) |
| Canonical evidence and filters | `lib/analytics.mjs`, `activity-analytics.mjs`, `activity-projection.mjs`, `service-categories.mjs`; [report meanings](report-contract.md#evidence-and-membership) |
| Search | `lib/search-text.mjs`, `search-retrieval.mjs`, `search-corpus.mjs`, `live-search.mjs`; [Search](live-search.md) and [corpus](search-corpus.md) |
| Reports | `lib/export.mjs`, `report-facts.mjs`, `report-artifacts.mjs`, `product-report.mjs`, `pdf.mjs`; [report contract](report-contract.md) |
| Screens | `lib/render.mjs`, `web/client.mjs` and existing surface owners; [design](design.md) |
| GitHub profile | `lib/github-profile*.mjs`, `copilot-account-snapshot.mjs`; [host identity boundary](github-profile.md) |

Read the contract for the boundary you change. Use source and tests for exact
schemas rather than copying them into another guide.

## Deferred canvas integration

The browser is the supported interface; native canvas delivery remains deferred.
The repository retains `extension.mjs` and `scripts/install-canvas.mjs`.
A compatible Copilot host supplies `@github/copilot-sdk/extension`; it is not
a normal npm dependency or a machine-specific SDK folder to add to this project.
The source adapter is not proof of working native delivery on a particular host.

For a separately authorized host-integration task, `npm run install:canvas`
writes a user-scoped shim under `.copilot\extensions\workiq-evidence`, pointing
at this checkout's `extension.mjs`. It backs up a different entry before
replacement. Moving the checkout requires reinstalling that pointer; changing
the HTTP server does not reload an already-loaded extension.

The adapter connects over HTTP and cannot create a second store writer.
Its separately loaded `lib/runtime-client.mjs` must match the runtime and
handshake protocol. Reloading extensions is a host operation, not a setup
workaround to perform during ordinary documentation or source review.
Desktop-selected profile binding remains [independently unresolved](github-profile.md).

## Historical compatibility and publication

The display name changed from Work IQ Evidence to WIRE without a storage
migration. Existing package/folder names, environment variables, storage keys,
`workiq-evidence` extension identity and `workiq-evidence-board` canvas ID remain.
Historical records and saved report bytes are not renamed or regenerated.

| Material | Publication boundary |
| --- | --- |
| Reviewed source and safe illustrative assets | Eligible for source review/publication |
| Private histories, prompts, reports, profiles, credentials, receipts, local configuration and machine-specific paths | Keep out of published source |
| Old identifying ancestry | Do not merge it to repair an unavailable historical link |
| Sanitized reachable history | Does not prove erasure from earlier objects, caches or other clones |

Publication and deployment are separate operations.

Current Search needs no model setup. The retained
[semantic](semantic-retrieval.md) and [linguistic](search-linguistics.md)
research documents explain former behavior, not current commands. Their
referenced development revisions are not available through the published
repository. Do not reinstall removed inference dependencies to run old examples.

Keep the bundled [Asta Sans OFL](../assets/fonts/OFL.txt), embedded Lucide
ISC/Feather MIT notices and any applicable resource notices intact. The
historical semantic document retains its ONNX notice while that document
remains. Dependency/font notices do not establish an application or artwork
publishing license; this repository does not supply a root application license.
