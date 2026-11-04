# WIRE

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/wire-wordmark-dark.svg">
  <img src="assets/wire-wordmark.svg" alt="WIRE" width="316" height="100">
</picture>

**Work IQ Request Explorer**

WIRE lets you inspect recorded Work IQ calls from local GitHub Copilot app
chats, search saved evidence and create reports you review before saving.
Recorded tool completion does not prove that an answer is correct.

The delivered interface runs in your browser and supports GitHub Copilot app
activity. Microsoft 365 Chat and Cowork integration is not available in this
release. Search runs on-device without AI, provider calls or AI credits.

## Start

This is a private, source-only project. The main branch contains the reviewed
source described here; no packaged release is published.

Use Node.js 24 or newer and npm 11.17.0. With access to this repository:

```powershell
git clone --branch main --single-branch https://github.com/likamrat/wire.git
Set-Location wire
npm ci
npm start
```

Open [WIRE](http://127.0.0.1:4000/) and keep the terminal running.
An existing instance keeps its current port until restarted. See the
[port-change notes](docs/development.md#changing-the-local-port) before switching.
In **Settings > Connection & updates**, review and approve the local Copilot
metadata and history paths before collection. Starting WIRE does not approve
a source. Only supported local histories can be read.

Private data stays outside the checkout. On Windows, the default is
`%LOCALAPPDATA%\WorkIQEvidence\data`; another checkout can use that same store.
Do not run two writers against it or put private data in the repository.
Saving Copilot replies requires separate approval.

Reports are saved locally after disclosure review and a separate Save action.
Review them before sharing: local masking can miss confidential information.

- [Use WIRE](docs/user-guide.md)
- [Create and compare reports](docs/reporting.md)
- [Develop and troubleshoot](docs/development.md)
- [Technical documentation](docs/README.md)
