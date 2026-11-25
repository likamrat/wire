import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { guideCatalog, guideSlug, guideSummary, isDocumentationAsset, isGuideFile, renderGuide, resolveTargets } from "./documentation-render.mjs";

const execute = promisify(execFile);
const OFFICIAL_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)likamrat\/wire(?:\.git)?\/?$/i;
const OFFICIAL_WEB = "https://github.com/likamrat/wire";
// Documentation keeps its own private ref. The app updater's ref is read when it is newer, but never written here.
export const DOCUMENTATION_REF = "refs/wire-docs/main";
const UPDATE_REF = "refs/wire-updates/main";
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const limits = { guide: 2 * 1024 * 1024, asset: 16 * 1024 * 1024, files: 200000 };

const failure = (message, code = "documentation_unavailable", status = 503) => Object.assign(new Error(message), { code, status });

function githubWeb(remote) {
    if (OFFICIAL_REMOTE.test(remote)) return OFFICIAL_WEB;
    const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote ?? "");
    return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/**
 * Supplies the guides shown on the Documentation page.
 *
 * - Build: the running WIRE commit. A newer remote main never replaces the installed guide.
 * - Branch: an explicitly selected head in the official repository, pinned for this read.
 * - Copy: the files on disk, for a copy without Git.
 * - Checkout: a contributor's working tree, including unsaved-to-Git edits. Only README/CONTRIBUTING/SECURITY,
 *   docs/*.md and images under docs/ or assets/ are read.
 */
export function createDocumentationSource({ root, gitDir = null, running = null, checkout = gitDir === null, fixtureRemote = null,
    now = Date.now, checkEveryMs = 15 * 60 * 1000 } = {}) {
    if (!root || !path.isAbsolute(root)) throw new TypeError("Documentation needs the absolute WIRE root.");
    const location = gitDir ? ["--git-dir", gitDir] : ["-C", root];
    const revisions = new Map(), issued = new Set();
    let setup, checking = null, lastAttempt = 0;
    const freshness = { checkedAt: null, failedAt: null, error: null };

    async function git(args, { timeout = 30000, buffer = false } = {}) {
        const { stdout } = await execute("git", [...location, "-c", `core.hooksPath=${os.devNull}`, "-c", "http.followRedirects=false",
            "-c", "credential.interactive=false", ...args], { timeout, windowsHide: true, encoding: "buffer", maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes" } });
        return buffer ? stdout : stdout.toString("utf8").trimEnd();
    }
    const quiet = async (args, options) => { try { return await git(args, options); } catch { return null; } };

    async function configure() {
        setup ??= (async () => {
            const repository = (gitDir ? await quiet(["rev-parse", "--git-dir"]) : await quiet(["rev-parse", "--is-inside-work-tree"])) !== null;
            const remote = repository ? await quiet(["config", "--get", "remote.origin.url"]) : null;
            const official = Boolean(remote) && (OFFICIAL_REMOTE.test(remote) || Boolean(fixtureRemote) && path.isAbsolute(remote) && path.resolve(remote) === path.resolve(fixtureRemote));
            const head = repository ? running ?? await quiet(["rev-parse", "--verify", "HEAD^{commit}"]) : null;
            return { repository, remote, official, web: official ? OFFICIAL_WEB : githubWeb(remote),
                head: oid.test(head ?? "") ? head : null, checkout: checkout && repository && !gitDir };
        })();
        return setup;
    }

    async function commitRevision(commit, kind) {
        const key = `git:${commit}`;
        // The same commit can be this build and GitHub main; the label follows how it was chosen.
        if (revisions.has(key)) return { ...revisions.get(key), kind };
        const listing = (await git(["ls-tree", "-rlz", "--full-tree", commit])).split("\0").filter(Boolean);
        if (listing.length > limits.files) throw failure("This revision has too many files to read its guides.");
        const files = new Map(), folders = new Set();
        for (const record of listing) {
            const tab = record.indexOf("\t"), [, type, object, size] = record.slice(0, tab).split(/\s+/), file = record.slice(tab + 1);
            if (type !== "blob") continue;
            files.set(file, { object, size: Number(size) });
            for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) folders.add(dir);
        }
        const blobs = new Map(), published = await git(["show", "-s", "--format=%cI", commit]);
        let cachedBytes = 0;
        const revision = {
            id: key, kind, commit, published,
            files: [...files.keys()],
            exists: file => files.has(file) ? "file" : folders.has(file) ? "folder" : null,
            async read(file) {
                const entry = files.get(file);
                if (!entry || entry.size > (isGuideFile(file) ? limits.guide : limits.asset)) return null;
                if (blobs.has(entry.object)) return blobs.get(entry.object);
                const bytes = await git(["cat-file", "blob", entry.object], { buffer: true });
                if (cachedBytes + bytes.length <= 16 * 1024 * 1024) { blobs.set(entry.object,bytes); cachedBytes += bytes.length; }
                return bytes;
            },
            object: file => files.get(file)?.object ?? null,
        };
        revisions.set(key, revision);
        if (revisions.size > 8) revisions.delete(revisions.keys().next().value);
        return revision;
    }

    // Working-tree and plain-file revisions are read from disk inside the WIRE root, never through links out of it.
    async function readInside(file) {
        if (!isGuideFile(file) && !isDocumentationAsset(file)) return null;
        const full = path.resolve(root, ...file.split("/"));
        if (!full.startsWith(path.resolve(root) + path.sep)) return null;
        try {
            const info = await lstat(full);
            if (!info.isFile() || info.size > (isGuideFile(file) ? limits.guide : limits.asset)) return null;
            const real = await realpath(full);
            if (!real.startsWith(await realpath(root) + path.sep)) return null;
            return { bytes: await readFile(real), info };
        } catch { return null; }
    }
    async function diskRevision(kind, listed) {
        const stamps = createHash("sha256"), cache = new Map(), folders = new Set();
        const scoped = listed.filter(file => isGuideFile(file) || isDocumentationAsset(file)).sort();
        for (const file of scoped) {
            const found = await readInside(file);
            if (!found) continue;
            cache.set(file, found.bytes);
            stamps.update(`${file}\0${found.info.size}\0${found.info.mtimeMs}\0`);
        }
        for (const file of listed) for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) folders.add(dir);
        const all = new Set(listed);
        return { id: `${kind}:${stamps.digest("hex").slice(0, 32)}`, kind, commit: null, published: null, files: [...cache.keys()],
            exists: file => all.has(file) ? "file" : folders.has(file) ? "folder" : null,
            async read(file) { return cache.get(file) ?? null; } };
    }
    async function walkCopy() {
        const listed = ["README.md", "CONTRIBUTING.md", "SECURITY.md"];
        async function walk(dir, depth) {
            if (depth > 4 || listed.length > 5000) return;
            for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
                const file = `${dir}/${entry.name}`;
                if (entry.isDirectory()) await walk(file, depth + 1);
                else if (entry.isFile()) listed.push(file);
            }
        }
        await walk("docs", 0); await walk("assets", 0);
        return diskRevision("copy", listed);
    }
    async function checkoutRevision() {
        const listed = (await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
        if (listed.length > limits.files) throw failure("This checkout has too many files to read its guides.");
        return diskRevision("checkout", listed);
    }

    async function officialCommit() {
        const found = [];
        for (const ref of [DOCUMENTATION_REF, UPDATE_REF]) {
            const commit = await quiet(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
            if (oid.test(commit ?? "")) found.push(commit);
        }
        if (found.length < 2 || found[0] === found[1]) return found[0] ?? null;
        // Prefer whichever ref is newer; the updater may have fetched more recently than Documentation.
        return await quiet(["merge-base", "--is-ancestor", found[0], found[1]]) !== null ? found[1] : found[0];
    }

    async function branches() {
        const config = await configure();
        if (!config.official) throw failure("Branch previews require the official WIRE repository.", "documentation_source_unavailable", 403);
        let output;
        try { output = await git(["ls-remote", "--heads", "--refs", config.remote]); }
        catch { throw failure("Couldn't list WIRE branches. Check your network and Git access, then try again."); }
        const result = output.split("\n").filter(Boolean).map(line => {
            const [commit, ref] = line.split("\t");
            if (!oid.test(commit) || !ref?.startsWith("refs/heads/")) throw failure("Git returned an unreadable branch list.");
            return { branch: ref.slice(11), commit };
        });
        if (result.length > 5000) throw failure("There are too many branches to preview.");
        return result;
    }
    async function select(kind, selection) {
        const config = await configure();
        if (kind === "branch") {
            const { branch, commit } = selection;
            if (!config.official || !(await branches()).some(item => item.branch === branch && item.commit === commit)) {
                throw failure("That branch moved or was removed. Reload the branch list.", "documentation_branch_changed", 409);
            }
            const ref = `refs/wire-docs/preview/${createHash("sha256").update(branch).digest("hex")}`;
            try {
                await git(["fetch", "--quiet","--no-tags","--no-recurse-submodules","--no-write-fetch-head",config.remote,`+refs/heads/${branch}:${ref}`], { timeout: 60000 });
                if (await git(["rev-parse","--verify",`${ref}^{commit}`]) !== commit) throw failure("That branch moved during the preview. Reload the branch list.", "documentation_branch_changed", 409);
            } catch (error) {
                if (error.status) throw error;
                throw failure("Couldn't fetch that WIRE branch. Check your network and reload the branch list.");
            }
            return { ...await commitRevision(commit, "branch"), branch };
        }
        if (kind === "checkout") {
            if (!config.checkout) throw failure("This WIRE copy has no checkout to preview.", "documentation_source_unavailable", 409);
            return checkoutRevision();
        }
        if (!config.repository) return walkCopy();
        if (config.head) return commitRevision(config.head, "build");
        return walkCopy();
    }

    async function describe(revision, config) {
        const source = { revision: revision.id, kind: revision.kind, commit: revision.commit, published: revision.published,
            checkedAt: freshness.checkedAt, failedAt: freshness.failedAt, failure: freshness.error,
            canCheck: config.official, checkout: config.checkout, ...(revision.branch && { branch: revision.branch }) };
        if (revision.kind === "checkout") {
            source.branch = await quiet(["rev-parse", "--abbrev-ref", "HEAD"]) ?? null;
            source.head = config.head;
            source.official = config.official;
            const fetched = config.official ? await officialCommit() : null, main = fetched ?? config.head;
            if (main) {
                // Compare text with line endings normalized, so a Windows checkout with CRLF files is not "edited".
                const reference = await commitRevision(main, "official"), changed = {};
                for (const file of revision.files.filter(isGuideFile)) {
                    const object = reference.object(file);
                    if (!object) { changed[file] = "new"; continue; }
                    const raw = await revision.read(file), text = raw.toString("utf8").replace(/\r\n/g, "\n"), bytes = Buffer.from(text);
                    const blob = value => [createHash("sha1"), createHash("sha256")].map(hash => hash.update(`blob ${value.length}\0`).update(value).digest("hex"));
                    if (![...blob(bytes), ...blob(raw)].includes(object)) changed[file] = "edited";
                }
                source.changed = changed;
                source.compared = main;
                // A fork, or a clone that hasn't fetched main yet, is compared with its own last commit.
                source.comparedWith = fetched ? "main" : "commit";
            }
        }
        return source;
    }

    const outlines = new Map();
    async function outline(revision, file) {
        const key = revision.commit ? `${revision.object(file)}` : `${revision.id}:${file}`;
        if (!outlines.has(key)) {
            const text = (await revision.read(file))?.toString("utf8") ?? "";
            const { headings, anchors, title } = renderGuide(text);
            outlines.set(key, { headings: headings.filter(h => h.depth <= 4), anchors, title: title ?? file, summary: guideSummary(text) });
            if (outlines.size > 400) outlines.delete(outlines.keys().next().value);
        }
        return outlines.get(key);
    }

    async function catalog(kind = "installed", selection) {
        const config = await configure();
        const revision = await select(kind, selection);
        issued.add(revision.id);
        if (issued.size > 32) issued.delete(issued.values().next().value);
        const guides = revision.files.filter(isGuideFile);
        if (!guides.includes("docs/README.md")) throw failure("This revision has no documentation index (docs/README.md).");
        const texts = new Map();
        let total = 0;
        for (const file of guides) {
            const bytes = await revision.read(file);
            if (!bytes || (total += bytes.length) > 12 * 1024 * 1024) throw failure("The selected guides exceed the preview size limit.");
            texts.set(file, bytes.toString("utf8"));
        }
        const { groups, tasks } = guideCatalog(guides, file => texts.get(file) ?? "");
        const shaped = [];
        for (const group of groups) {
            const items = [];
            for (const file of group.files) {
                const { headings, title, summary } = await outline(revision, file);
                items.push({ file, guide: guideSlug(file), title, summary, headings });
            }
            shaped.push({ name: group.name === "Contributor references" ? "For contributors" : group.name, items });
        }
        const index = await outline(revision, "docs/README.md");
        return { source: await describe(revision, config), title: index.title, groups: shaped, tasks };
    }

    async function revisionFor(id) {
        if (typeof id !== "string" || !issued.has(id)) throw failure("This documentation revision is no longer available. Reload the guides.", "documentation_revision_changed", 409);
        if (id.startsWith("git:")) return revisions.get(id) ?? commitRevision(id.slice(4), "official");
        const current = id.startsWith("checkout:") ? await checkoutRevision() : await walkCopy();
        if (current.id !== id) throw failure("The guides changed on disk. Reload to see the saved version.", "documentation_revision_changed", 409);
        return current;
    }

    async function page(id, guide) {
        const config = await configure();
        const revision = await revisionFor(id);
        const guidesByFile = new Map(revision.files.filter(isGuideFile).map(file => [file, guideSlug(file)]));
        const file = [...guidesByFile].find(([, slug]) => slug === guide)?.[0];
        if (!file) throw failure("There's no guide at this address in these guides.", "documentation_guide_missing", 404);
        const source = (await revision.read(file)).toString("utf8");
        const rendered = renderGuide(source);
        const anchors = new Map();
        for (const other of guidesByFile.keys()) anchors.set(other, (await outline(revision, other)).anchors);
        anchors.set(file, rendered.anchors);
        const bytes = new Map();
        let imageBytes = 0;
        for (const asset of revision.files.filter(isDocumentationAsset)) if (rendered.html.includes(path.posix.basename(asset))) {
            const data = await revision.read(asset);
            if ((imageBytes += data?.length ?? 0) > 32 * 1024 * 1024) throw failure("The selected guide's images exceed the preview size limit.");
            bytes.set(asset,data);
        }
        const ref = revision.commit ?? config.head;
        const webUrl = (kind, target, fragment) => config.web && ref ? `${config.web}/${kind}/${ref}/${target.split("/").map(encodeURIComponent).join("/")}${fragment ? "#" + encodeURIComponent(fragment) : ""}` : null;
        const targets = resolveTargets(rendered.html, { file, guides: guidesByFile, anchors, exists: revision.exists, read: target => bytes.get(target) ?? null, webUrl });
        return { revision: revision.id, file, guide, title: rendered.title ?? file, html: rendered.html, headings: rendered.headings, targets,
            sourceUrl: revision.kind === "checkout" ? null : webUrl("blob", file, "") };
    }

    async function asset(id, file) {
        if (!isDocumentationAsset(file)) return null;
        const revision = await revisionFor(id);
        return revision.exists(file) === "file" ? revision.read(file) : null;
    }

    // A docs-only fetch of official main into Documentation's private ref. It changes no files, settings or updates.
    async function check({ force = false } = {}) {
        const config = await configure();
        if (!config.official) return { checked: false };
        if (!force && now() - lastAttempt < checkEveryMs) return { checked: false };
        checking ??= (async () => {
            lastAttempt = now();
            try {
                await git(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", config.remote,
                    `+refs/heads/main:${DOCUMENTATION_REF}`], { timeout: 60000 });
                Object.assign(freshness, { checkedAt: new Date(now()).toISOString(), failedAt: null, error: null });
            } catch (error) {
                const reason = error.killed ? "GitHub didn't answer in time." : "Check your network and Git access to the WIRE repository.";
                Object.assign(freshness, { failedAt: new Date(now()).toISOString(), error: `Couldn't reach GitHub main. ${reason}` });
            } finally { checking = null; }
            return { checked: true };
        })();
        return checking;
    }

    async function version() {
        const config = await configure();
        return config.checkout ? (await checkoutRevision()).id : null;
    }

    return { catalog, page, asset, check, version, configure, branches };
}
