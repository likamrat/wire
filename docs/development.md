# Development

WIRE runs as a local Node server with a browser interface. Start with the
[README](../README.md#start) to clone and install it. This guide covers working
on the source, checking a change and troubleshooting a local installation.

## Run locally

Use Node.js 24 or newer.

```text
npm ci
npm start
```

Open `http://127.0.0.1:4000/` and keep the terminal running. Use **Ctrl+C** in
that terminal to stop WIRE; closing the browser tab leaves it running.

To update an existing checkout, stop its WIRE process, pull the changes, run
`npm ci` and restart. If the port is already in use, check whether WIRE is
already running rather than stopping an unfamiliar process.

## Keep development data separate

All checkouts default to the same per-user store. A disposable fixture must
provide an explicit owned data directory outside source, disable collection
timers and use invented source paths. Never point a fixture at the normal store,
an existing browser profile or original history.

Browser tests set up temporary stores through
[`tests/helpers.mjs`](../tests/helpers.mjs) and close their own resources.
Reuse that pattern for tests and image capture.

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

Read the contract for the boundary you change. Use source and tests for exact
schemas rather than copying them into another guide.

When changing bundled assets, keep their license notices intact, including the
[Asta Sans OFL](../assets/fonts/OFL.txt) and Lucide ISC/Feather MIT notices.
