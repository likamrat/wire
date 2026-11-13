<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wire-lockup-dark.svg?v=human-path-2">
    <img src="assets/wire-lockup.svg?v=human-path-2" alt="WIRE" width="560">
  </picture>
</p>

# Work IQ Request Explorer

Synthetic evals are essential, but they will always have a blind spot: how people
actually work with AI. People phrase requests differently, bring different context
and take different paths through multi-turn conversations. Those choices shape
both their own prompts and the prompts their agents generate, influencing the
tool calls and results that follow.

WIRE (Work IQ Request Explorer) was built to help you understand that blind spot
in your own work. It puts recorded human and agent-generated prompts beside their
Work IQ calls and results, so you can inspect personal patterns, unexpected
behavior and failures.

Those real interactions can become the basis for better synthetic eval cases.
Product teams and customers building agents on Work IQ APIs and MCP can use
that evidence to test the behaviors people rely on and improve their agents.

[![WIRE showing activity and prompt-author breakdowns beside a compact prompt preview and recorded call results.](docs/images/wire-overview.png)](docs/images/wire-overview.png)

Search runs on-device without AI or provider calls. Reports save locally as
HTML, PDF, JSON or Markdown, with detected personal details hidden by default.

<a id="start"></a>

## Getting started

### Platforms

Run WIRE with Node.js 24 or newer on:

- Windows
- WSL
- Linux
- macOS

Collection also needs accessible, supported GitHub Copilot app history.
See [platform setup](docs/development.md#windows-wsl-and-linux) for source
requirements and running separate instances.

### Coding agent

Copy this prompt into your coding agent:

```text
Set up and run WIRE locally from the main branch of
https://github.com/likamrat/wire.

Follow README.md and docs/development.md for this machine. Check for
Node.js 24+ and a running WIRE instance before installing or starting
anything. Preserve existing work and data.

Use npm ci and npm start for a new installation. Open the printed local
URL and verify that WIRE loads. Leave it running and tell me how to
reopen it. Ask me when setup choices need my input. Leave source
approval and reply-saving consent to me in WIRE.
```

<a id="install-and-run"></a>

### Manual setup

```sh
git clone https://github.com/likamrat/wire.git
cd wire
npm ci
npm start
```

The default browser address is `localhost:4000`. Keep the terminal running
while you use WIRE.

### Connect your history

WIRE prompts you to connect on first use. Choose **Review and connect**, check
the local paths and history window, then approve collection. **Not now** leaves
the connection prompt in Analyze; settings remain in **Settings > Connection & updates**.
Follow the [first-run guide](docs/user-guide.md#connect-local-history) for details.

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

<a href="docs/images/wire-evidence-flow.png">
  <picture>
    <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="docs/images/wire-evidence-flow-narrow-dark.png">
    <source media="(max-width: 767px)" srcset="docs/images/wire-evidence-flow-narrow.png">
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/wire-evidence-flow-dark.png">
    <img src="docs/images/wire-evidence-flow.png" alt="The GitHub Copilot app calls Work IQ and records the results. WIRE reads approved local history into its own evidence store for Analyze, Trends, Compare, literal Search and locally saved reports." width="800">
  </picture>
</a>

See [Architecture](docs/architecture.md) for the local runtime and storage boundaries.

## Trends

See which Work IQ tools appear in your recorded activity and how their use
varies by day. **Trends** gives each daily chart the full workspace width:
tool usage, prompt authors, tool calls, services, errors, response models
and call duration. Every widget has its own measure controls.

[![Full-width Trends charts with measure controls in every header.](docs/images/trends-overview.png)](docs/user-guide.md#trends)

Choose 7, 14, 30 or custom days and select a dated point in place. Maximize its
chart to open the supporting calls. The [Trends guide](docs/user-guide.md#trends)
explains reach versus call share, overlapping services and evidence gaps.

## Reports

Reports give you a shareable view of working patterns, backed by recorded
prompts, Work IQ calls and results. Ready-made templates preserve those
findings for review and for building eval cases.
**Report text** starts at **Mask detected details**. Change it before opening
a template or while reading the report.
The [reporting guide](docs/reporting.md) explains which template fits your
purpose and what the saved copy includes.

[![Reports homepage with ready-made templates, period controls and saved reports.](docs/images/report-choices.png)](docs/reporting.md)

[![An example report with section navigation, privacy controls and Save report.](docs/images/report-preview.png)](docs/reporting.md)

<a id="comparisons"></a>

## Compare

Compare shows how Work IQ activity, call outcomes and timing differ
[between periods or saved reports](docs/reporting.md#compare).
That evidence helps you assess changes
to your agents and investigate possible regressions.

[![Compare with call outcomes, chart choices and shared reading actions.](docs/images/compare-periods.png)](docs/images/compare-periods.png)

## Guides

- [Use WIRE](docs/user-guide.md)
- [Read Trends and inspect supporting calls](docs/user-guide.md#trends)
- [Create and compare reports](docs/reporting.md)
- [Develop and troubleshoot](docs/development.md)
- [Technical documentation](docs/README.md)

## Contributing

[Report a bug or suggest an improvement](https://github.com/likamrat/wire/issues),
or see [Contributing](CONTRIBUTING.md) to submit a change.

## Security

Follow the [security reporting guide](SECURITY.md) for suspected vulnerabilities.

## License

WIRE is licensed under the [MIT License](LICENSE). Third-party components
retain their own licenses and notices.
