# Contributing to WIRE

Bug reports, documentation corrections and focused code changes are welcome.
For suspected vulnerabilities, use [Security](SECURITY.md) instead of a public issue.

## Report a problem or propose a change

Search the [existing issues](https://github.com/likamrat/wire/issues) first.
For a bug, include the WIRE commit or version, operating system, Node version,
steps to reproduce, and expected versus actual behavior. Use a small invented
example instead of personal Copilot history.

For a larger feature, open an issue explaining the task it would help with
before starting implementation.

## Make a change

If you use Copilot, the repository includes eight optional
[WIRE development skills](docs/development.md#wire-development-skills).
Contributions do not require an AI tool.

1. Follow [Development](docs/development.md) to run WIRE and find the relevant code.
2. Keep the change focused. Preserve source permissions, evidence meaning and
   saved report bytes; read the [relevant contract](docs/README.md#contributor-references).
3. Add regression coverage for changed behavior and run the
   [appropriate checks](docs/development.md#check-a-change). Update affected instructions.
4. Open a pull request explaining the problem, the change and how you checked it.
   Include known limitations or failing checks.

## Keep examples safe

Use isolated test data directories and invented records. Do not commit or attach
personal histories, prompts, reports, credentials, browser profiles or local
configuration. Keep fixture provenance with capture evidence; add a screenshot
caption only when it helps explain the task.

Retain the licenses and notices supplied with bundled dependencies, fonts and icons.
