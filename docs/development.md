# Development

WIRE is a private, source-only Node application. The delivered route is the
ordinary browser at `http://127.0.0.1:4000/` by default; native canvas delivery remains
deferred. See [README](../README.md) for the current source-availability notice.

## Run from the intended checkout

Use Node.js 24 or newer and npm 11.17.0, as declared in
[`package.json`](../package.json). Git access to this repository is separate
from Copilot authentication, local source approval and desktop-selected identity.

```powershell
npm ci
npm start
```

Keep the terminal running. Startup requires no copied private state, evidence
migration, build output or model assets. It does not install a scheduled task
or startup service. Closing a page or canvas does not stop the runtime.

For an existing checkout, stop only its own runtime before pulling the intended
published source, reinstalling locked dependencies and restarting. A fixed-port
conflict is an error, not permission to stop another process. `--port 0` is an
explicit isolated-port option; it does not isolate the private data directory.

All checkouts default to the same per-user store. A disposable fixture must
provide an explicit owned data directory outside source, disable collection
timers and use invented source paths. Never point a fixture at the normal store,
an existing browser profile or original history.

## Changing the local port

The default is `4000`, bound only to `127.0.0.1`. Use
`npm start -- --port 47831` to keep the previous address, or pass another explicit
port. WIRE refuses an occupied port instead of silently choosing another.
`WORKIQ_EVIDENCE_DATA_DIR` still selects the store; a port change does not move
retained evidence, collection settings or saved reports.

Before switching, finish any drafts and resolve pending or unconfirmed operations
in the existing tab. Do not repeat an uncertain Save, deletion or collection
operation at the new address. Browser-local recovery markers and in-memory drafts
do not transfer between ports; leave the old instance in place if recovery is
unresolved.

After a controlled restart, open the printed URL and update bookmarks. Already-open
tabs keep using the old address. Theme, sidebar and display-time-zone preferences
belong to the browser origin and may need setting again. Do not copy capabilities
or browser storage to carry a session across.

## Check a change

```powershell
npm run check
npm test
```

`check` validates JavaScript syntax, not TypeScript types. Runtime validators
and focused tests cover input contracts. Use the smallest relevant test set
before a broader run; a skipped or zero-selected lane is not qualification.
There is no blanket claim here that every historical baseline test passes.

Packaging changes have a separate lane:

```powershell
npm run test:packaging
```

It creates a disposable production-only installation and verifies saved-PDF
text extraction without development dependencies. Run it serially with other
installation/browser qualification. It is outside the default test glob.

Browser tests reuse the normal renderer and owned temporary stores through
[`tests/helpers.mjs`](../tests/helpers.mjs). Collection, provider, fixture,
headless browser and live-product evidence are different scopes. An invented
response proves the exercised code path, not genuine acquisition.

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

These are task pointers, not instructions to load every document. Keep stable
rules with their owner, and use source/tests for mechanical schema details
rather than copying a changing implementation inventory into each guide.

## Deferred canvas integration

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

Publish only reviewed source and safe illustrative assets. Do not include
private histories, prompts, reports, profiles, credentials, operational receipts,
local configuration or machine-specific paths. Do not merge old identifying
ancestry to make an unavailable historical link work. Sanitized reachable
history does not prove erasure from earlier objects, caches or other clones.
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
