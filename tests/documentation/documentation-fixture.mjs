import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocumentationSource } from "../../lib/documentation-source.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const tick = "\u0060";

// A rendering sample that is only ever committed to a disposable fixture repository.
export const renderingGuide = `# Rendering check

**Contents:** [Headings](#headings) · [Links](#links) · [Tables](#tables)

## Headings

### Repeated heading

First.

### Repeated heading

Second: [jump to the second one](#repeated-heading-1).

### Punctuation: "quotes", commas & ampersands — dashes, too?

[Link to this heading](#punctuation-quotes-commas--ampersands--dashes-too).

## Links

- Guide: [Development](development.md)
- Guide section: [Trends in the user guide](user-guide.md#trends)
- Root file: [Contributing](../CONTRIBUTING.md)
- Repository file: [helpers](../tests/support/helpers.mjs)
- External: [GitHub Docs](https://docs.github.com/en/get-started/writing-on-github)
- Missing guide: [Missing](no-such-guide.md)
- Missing section: [Missing section](user-guide.md#no-such-section)

## Images

![Trends overview](images/trends-overview.png)

![Outside image](https://img.shields.io/badge/build-passing-brightgreen)

## Tables

| Column | Alignment | Number |
| :--- | :---: | ---: |
| §inline code§ | ✅ | 1,024 |
| A [link](#links) | ❌ | 3.14 |

## Code

§§§powershell
npm run build
§§§

Text with a footnote[^first] and :rocket: shortcode.

[^first]: The footnote.

- [x] Completed task
- [ ] Open task

> [!WARNING]
> Urgent information.

## Unsafe content

<script>window.__docsScript = true</script>

<img src="x" onerror="window.__docsOnError = true" alt="Image with a handler">

<a href="javascript:window.__docsLink = true">A javascript link</a>

<div style="position:fixed;inset:0">Overlay attempt</div>
`.replaceAll("§", tick);

const git = (cwd, ...args) => execFileSync("git", ["-c", "core.autocrlf=true", "-c", "core.safecrlf=false", "-c", "user.name=WIRE fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T12:00:00Z" } }).trim();

// The guides of this checkout in a disposable repository whose origin stands in for official GitHub main.
export async function documentationRepository(t) {
    const root = await mkdtemp(path.join(tmpdir(), "wire-docs-"));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const work = path.join(root, "work"), origin = path.join(root, "origin.git"), publisher = path.join(root, "publisher");
    await mkdir(work);
    for (const file of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "docs"]) await cp(path.join(repository, file), path.join(work, file), { recursive: true });
    await cp(path.join(repository, "assets"), path.join(work, "assets"), { recursive: true, filter: source => !/\.[a-z]+$/i.test(source) || /\.(?:png|svg)$/i.test(source) });
    await writeFile(path.join(work, "docs", "rendering-check.md"), renderingGuide);
    await mkdir(path.join(work, "tests", "support"), { recursive: true });
    await cp(path.join(repository, "tests", "support", "helpers.mjs"), path.join(work, "tests", "support", "helpers.mjs"));
    git(work, "init", "--quiet");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "Fixture guides");
    git(root, "clone", "--quiet", "--bare", work, origin);
    git(work, "remote", "add", "origin", origin);
    git(root, "clone", "--quiet", origin, publisher);
    return {
        work, origin,
        head: () => git(work, "rev-parse", "HEAD"),
        // A docs-only commit published to "GitHub main", leaving the running copy untouched.
        async publish(file, text, message = "Update guides", branch = "main") {
            git(publisher, "pull", "--quiet", "--ff-only");
            await writeFile(path.join(publisher, ...file.split("/")), text);
            git(publisher, "add", "-A");
            git(publisher, "commit", "--quiet", "-m", message);
            git(publisher, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
            return git(publisher, "rev-parse", "HEAD");
        },
        source: (options = {}) => createDocumentationSource({ root: work, fixtureRemote: origin, ...options }),
    };
}
