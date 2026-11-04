<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wire-wordmark-dark.svg">
    <img src="assets/wire-wordmark.svg" alt="WIRE" width="316">
  </picture>
  <br>
  <sub>Work IQ Request Explorer</sub>
</p>

WIRE is a local browser app for exploring Work IQ activity from your GitHub
Copilot app chats. Follow a request through its recorded calls, search saved
text and turn selected activity into a report.

[![WIRE showing recorded outcomes, response models, tools and services beside an open interaction.](docs/images/wire-overview.png)](docs/images/wire-overview.png)

*Invented activity: an overview of 25 calls alongside the three calls behind a
launch-review request. Completed calls describe tool execution, not answer quality.*

Curated evals help improve agents. Everyday prompts bring another perspective:
people phrase requests differently, leave context unstated and change direction.
Agents generate prompts of their own.

I built WIRE to understand those real interactions. It puts recorded human
and agent-generated prompts beside their tool calls and results, so you can
find patterns and failures, improve your agents and build better evaluation cases.

Search runs on-device without AI or provider calls. Review report text before
saving HTML, PDF, JSON or Markdown.

## Start

You need Node.js 24 or newer, npm 11.17.0 and access to this repository.

```powershell
git clone https://github.com/likamrat/wire.git
Set-Location wire
npm ci
npm start
```

Open [WIRE](http://127.0.0.1:4000/) and keep the terminal running.
In **Settings > Connection & updates**, choose **Review source & connect**.
Check the local Copilot paths and history window, then approve collection.
The [first-run guide](docs/user-guide.md#connect-local-history) walks through
these choices. Starting WIRE alone does not approve a source.

For an existing instance, read the
[port-change notes](docs/development.md#changing-the-local-port) before
switching addresses.

Private data is stored outside the checkout, by default at
`%LOCALAPPDATA%\WorkIQEvidence\data` on Windows. Run only one WIRE instance per
data store. Saving Copilot replies needs separate approval; review report
copies before sharing because local masking can miss confidential information.

## Guides

- [Use WIRE](docs/user-guide.md)
- [Create and compare reports](docs/reporting.md)
- [Develop and troubleshoot](docs/development.md)
- [Technical documentation](docs/README.md)

## Contributing

[Open an issue](https://github.com/likamrat/wire/issues) with a reproducible
problem or a proposed improvement. For a change, open a focused pull request
that explains the behavior, updates the relevant guide and includes the checks
you ran. See [Development](docs/development.md#check-a-change) for local checks
and code entry points.

Use invented examples in tests and screenshots. Keep personal histories,
prompts, reports, credentials and local configuration out of issues and commits.
