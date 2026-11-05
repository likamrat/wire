<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wire-lockup-dark.svg">
    <img src="assets/wire-lockup.svg" alt="WIRE - Work IQ Request Explorer" width="316">
  </picture>
</p>

Synthetic evals are essential, but they will always have a blind spot: how people
actually work with AI. People phrase requests differently, bring different context
and take different paths through multi-turn conversations. Those choices shape
both their own prompts and the prompts their agents generate, influencing the
tool calls and results that follow.

I built WIRE (Work IQ Request Explorer) to help you understand that blind spot
in your own work. It puts recorded human and agent-generated prompts beside their
Work IQ calls and results, so you can inspect personal patterns, unexpected
behavior and failures.

Those real interactions can become the basis for better synthetic eval cases.
Product teams and customers building agents on Work IQ APIs and MCP can use
that evidence to test the behaviors people rely on and improve their agents.

[![WIRE showing weekly activity, outcomes, models, tools and services beside an interaction with completed and failed calls.](docs/images/wire-overview.png)](docs/images/wire-overview.png)

Search runs on-device without AI or provider calls. Review report text before
saving HTML, PDF, JSON or Markdown.

## How WIRE fits

WIRE reads recorded Work IQ activity from the **GitHub Copilot app** without
rerunning its calls, then keeps local evidence for inspection and reviewed reports.

<a href="docs/images/wire-evidence-flow.png">
  <picture>
    <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="docs/images/wire-evidence-flow-narrow-dark.png">
    <source media="(max-width: 767px)" srcset="docs/images/wire-evidence-flow-narrow.png">
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/wire-evidence-flow-dark.png">
    <img src="docs/images/wire-evidence-flow.png" alt="The GitHub Copilot app calls Work IQ and records the results. WIRE reads approved app history into its own local evidence store for Analyze, literal Search and reviewed reports." width="800">
  </picture>
</a>

See [Architecture](docs/architecture.md) for the local runtime and storage boundaries.

## Start

### Platforms

Run WIRE with Node.js 24 or newer on:

- Windows
- WSL
- Linux
- macOS

Collection also needs accessible, supported GitHub Copilot app history.
See [platform setup](docs/development.md#windows-wsl-and-linux) for source
requirements and running separate instances.

### Install and run

```sh
git clone https://github.com/likamrat/wire.git
cd wire
npm ci
npm start
```

The default browser address is `localhost:4000`. Keep the terminal running
while you use WIRE.

### Connect your history

In **Settings > Connection & updates**, choose **Review source & connect**,
check the paths and history window, then approve collection.
Follow the [first-run guide](docs/user-guide.md#connect-local-history) for details.

### Your data

- Activity and reports stay in a [per-user data folder](docs/collection.md#store-ownership)
  outside the repository.
- Independent instances need separate data folders and ports, with their own
  source approval, collection progress and reports.
- Saving Copilot replies needs separate approval. Review report copies before
  sharing; local masking can miss confidential information.

## Comparisons

Compare periods to see where failure rates or call timings changed, then inspect
the calls behind those changes. Use those differences to decide which agent
behaviors need closer investigation.

[![A comparison of two periods showing call outcomes and tool latency side by side.](docs/images/compare-periods.png)](docs/images/compare-periods.png)

## Reports

Turn selected interactions into a portable record of prompts, tool calls and
results. Review the included text, then share the report with people building
evaluations so they can turn real-use patterns and failures into concrete eval cases.

[![A saved HTML report open in WIRE, showing its scope, activity counts, tools and services.](docs/images/saved-report.png)](docs/images/saved-report.png)

## Guides

- [Use WIRE](docs/user-guide.md)
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
