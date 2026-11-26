<p align="center">
  <a href="docs/images/wire-readme-logo-dark.svg#gh-dark-mode-only">
    <img src="docs/images/wire-readme-logo-dark.svg" alt="WIRE" width="560">
  </a>
  <a href="docs/images/wire-readme-logo.svg#gh-light-mode-only">
    <img src="docs/images/wire-readme-logo.svg" alt="WIRE" width="560">
  </a>
</p>

# Work IQ Request Explorer

**Contents:** [Getting started](#getting-started) · [How WIRE fits](#how-wire-fits) ·
[Trends](#trends) · [Reports](#reports) · [Compare](#compare) · [Guides](#guides) ·
[Contributing](#contributing) · [Security](#security) · [License](#license)

WIRE shows what happened after a person or an agent asked for something in the
GitHub Copilot app. Open a recorded interaction to see the prompt, the Work IQ
tools it used and the results each call returned.

Use those records to find patterns in your own work. If you're building an
agent, a failed call or an unexpected follow-up can give you a concrete case
to test that a synthetic evaluation might have missed.

[![Analyze with outcome, activity and token charts, and an open reader showing a prompt and its recorded call results.](docs/images/wire-overview.png)](docs/images/wire-overview.png)

Search runs on-device without AI or provider calls. Reports save locally as
HTML, PDF, JSON or Markdown, with detected personal details hidden by default.

<a id="start"></a>

## Getting started

WIRE installs as a plugin for the GitHub Copilot app. It runs inside the app,
so you don't need Node.js, npm or a terminal.

```sh
copilot plugin marketplace add likamrat/wire
copilot plugin install wire@wire
```

Then reload extensions or start a new chat, and ask Copilot to open WIRE.
You can also ask questions directly, for example "which Work IQ calls failed
this week and why?". The plugin's skills and read-only tools answer from your
local evidence without opening the canvas. Ask it to package failures for a
team and it prepares a redacted diagnostic report and bundle, saved locally
only when you agree. In the canvas, **Package these failures** in Analyze does
the same, and **Reports > Saved library** lists the saved bundles.

WIRE runs while the Copilot app is open, so collection pauses when you close
the app. To update, run `copilot plugin update wire`.

PDF reports use the Microsoft Edge or Google Chrome already on your computer.
HTML, Markdown and JSON reports need nothing else.

Collection needs accessible, supported GitHub Copilot app history. To work on
the source or run WIRE as a standalone server, see
[Development](docs/development.md#run-locally).

<a id="install-and-run"></a>

### Connect your history

Choose **Review and connect**, check the local paths and history window, then
approve collection. **Not now** leaves the prompt in Analyze.
See [Connect local history](docs/user-guide.md#connect-local-history) to connect later.

### Your data

- Activity and reports stay in a [per-user data folder](docs/collection.md#store-ownership)
  outside the repository.
- Independent instances need separate data folders and ports, with their own
  source approval, collection progress and reports.
- Saving Copilot replies needs separate approval. Review report copies before
  sharing; local masking can miss confidential information.

## How WIRE fits

WIRE reads recorded Work IQ activity from the **GitHub Copilot app** without
rerunning its calls, then keeps local evidence for inspection and reports.

<a href="docs/images/wire-evidence-flow-dark.png#gh-dark-mode-only">
  <picture>
    <source media="(max-width: 767px)" srcset="docs/images/wire-evidence-flow-narrow-dark.png">
    <img src="docs/images/wire-evidence-flow-dark.png" alt="The GitHub Copilot app calls Work IQ and records the results. WIRE reads approved local history into its own evidence store for Analyze, Trends and locally saved reports." width="800">
  </picture>
</a>
<a href="docs/images/wire-evidence-flow.png#gh-light-mode-only">
  <picture>
    <source media="(max-width: 767px)" srcset="docs/images/wire-evidence-flow-narrow.png">
    <img src="docs/images/wire-evidence-flow.png" alt="The GitHub Copilot app calls Work IQ and records the results. WIRE reads approved local history into its own evidence store for Analyze, Trends and locally saved reports." width="800">
  </picture>
</a>

See [Architecture](docs/architecture.md) for the local runtime and storage boundaries.

## Trends

Follow changes in daily tool use, errors or timing. Select a day to inspect
the calls behind it, or compare two measures over the same dates.
See [Trends](docs/user-guide.md#trends) for the eight measures and what each counts.

[![Trends shows a day with one interaction and no recorded errors.](docs/images/trends-overview.png)](docs/user-guide.md#trends)

## Reports

In Analyze, choose **Add to report** on an interaction card or in the reader to
[add it to a named draft](docs/reporting.md#keep-interactions-in-a-draft).
To report on a pattern instead, open **Reports** and select **Errors & failures**
under **New report**. [Read the preview](docs/reporting.md) and check its text
before saving a local copy.

[![Report choices, including Errors & failures and Custom report, beside drafts and recent reports.](docs/images/report-choices.png)](docs/reporting.md)

[![An example report with section navigation, privacy controls and Save report.](docs/images/report-preview.png)](docs/reporting.md)

<a id="comparisons"></a>

## Compare

Compare a selected period with a baseline, including call results and token
usage. Open either period's count to see the calls it includes. See
[Compare two periods](docs/reporting.md#compare).

[![Compare with call results for each period: 1 of 4 baseline calls failed, versus 5 of 19 selected calls.](docs/images/compare-periods.png)](docs/images/compare-periods.png)

## Guides

- [Use WIRE](docs/user-guide.md)
- [Read Trends and inspect supporting calls](docs/user-guide.md#trends)
- [Create and read reports](docs/reporting.md)
- [Develop and troubleshoot](docs/development.md)
- [Documentation index](docs/README.md)

## Contributing

[Report a bug or suggest an improvement](https://github.com/likamrat/wire/issues),
or see [Contributing](CONTRIBUTING.md) to submit a change.

## Security

Follow the [security reporting guide](SECURITY.md) for suspected vulnerabilities.

## License

WIRE is licensed under the [MIT License](LICENSE). Third-party components
retain their own licenses and notices.
