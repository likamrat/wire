import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const official = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)likamrat\/wire(?:\.git)?$/i;
const compatibility = "lib/update-compatibility.json";
const docsInputs = "lib/update-runtime-docs.json";
const privateRef = "refs/wire-updates/main";
const manual = message => Object.assign(new Error(message), { code: "WIRE_UPDATE_MANUAL" });
const failed = message => Object.assign(new Error(message), { code: "WIRE_UPDATE_FAILED" });

async function git(cwd, args, message, timeout = 30000) {
    try {
        const { stdout } = await execute("git", ["-c", `core.hooksPath=${os.devNull}`, "-c", "http.followRedirects=false",
            "-c", "credential.interactive=false", ...args], { cwd, timeout, windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never",
                GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes" },
            encoding: "buffer", maxBuffer: 24 * 1024 * 1024 });
        return stdout.toString("utf8").trimEnd();
    } catch {
        // Git and npm errors can contain credential URLs and machine-specific paths.
        throw failed(message);
    }
}

async function readTree(root, commit) {
    if (!oid.test(commit)) throw manual("The installed WIRE build could not be identified.");
    const tree = await git(root, ["ls-tree", "-rz", "--full-tree", commit], "Could not read this WIRE build.");
    return tree.split("\0").filter(Boolean).map(record => {
        const i = record.indexOf("\t");
        if (i < 0) throw failed("Could not identify the files in this WIRE build.");
        return { record, file: record.slice(i + 1) };
    });
}

async function fingerprint(root, commit) {
    const tree = await readTree(root, commit);
    let docs = [];
    if (tree.some(entry => entry.file === docsInputs)) {
        try {
            docs = JSON.parse(await git(root, ["show", `${commit}:${docsInputs}`], "Could not read the app input list."));
            if (!Array.isArray(docs) || !docs.every(file => typeof file === "string"
                && tree.some(entry => entry.file === file))) throw new Error();
        } catch { throw failed("The build's list of runtime documentation inputs is not usable."); }
    }
    const hash = createHash("sha256");
    for (const { record, file } of tree) {
        // Only repository material known not to ship is excluded. Colocated tests do not ship either.
        if (!docs.includes(file) && (/^(?:docs|tests|\.github)\//.test(file)
            || /\.(?:md|markdown|rst|adoc)$/i.test(file)
            || /\.(?:test|spec|qualification)\.(?:[cm]?[jt]sx?)$/.test(file)
            || /^(?:\.gitignore|scripts\/check\.mjs)$/.test(file))) continue;
        hash.update(record).update("\0");
    }
    return hash.digest("hex");
}

async function npmCli() {
    const locations = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
        path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
    for (const file of locations) {
        if (!file || !path.isAbsolute(file) || path.basename(file) !== "npm-cli.js") continue;
        try { await access(file); return file; } catch { /* Try the Node distribution's path. */ }
    }

    throw manual("Start this installation with npm start so WIRE can use its own npm.");
}

// The shim imports the original clone. Compare its dependency bundle and
// file-backed artwork without importing the staged adapter in the host.
export async function assertSameCanvasAdapter(installed, staged) {
    const refused = () => manual("The registered canvas adapter changed or could not be verified. Update the clone manually and reload the extension.");
    async function digest(dir) {
        const { build } = await import("esbuild");
        const result = await build({ absWorkingDir: dir, entryPoints: ["extension.mjs"], bundle: true, write: false,
            platform: "node", format: "esm", minify: true, logLevel: "silent", external: ["@github/copilot-sdk/extension"] });
        const code = result.outputFiles[0].text, sum = createHash("sha256").update(code);
        const resources = [...code.matchAll(/new URL\("(\.\.\/assets\/[\w./-]+)",import\.meta\.url\)/g)];
        // paths.mjs also uses fileURLToPath(import.meta.url) to identify the
        // installed root. It is not an asset read; the shim keeps that root.
        if (resources.length !== (code.match(/new URL\([^)]*import\.meta\.url/g) ?? []).length) throw refused();
        for (const [, name] of resources) {
            if (name.slice("../assets/".length).split("/").some(part => ["", ".", ".."].includes(part))) throw refused();
            sum.update(await readFile(path.join(dir, name.slice(3))));
        }
        return sum.digest("hex");
    }
    try {
        const [before, after] = await Promise.all([digest(installed), digest(staged)]);
        if (before === after) return;
    } catch { /* Unresolved adapter inputs also require a manual upgrade. */ }
    throw refused();
}

// The fixture source is injected by local tests; the runtime uses only the fixed official repository.
export function createUpdateSource({ fixtureRemote } = {}) {
    async function inspectInstallation(root) {
        const branch = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"], "This installation is not on a local main branch. Update it manually.");
        if (branch !== "main") throw manual("This copy is not on main. Update it manually.");
        const gitdir = await lstat(path.join(root, ".git")).catch(() => null);
        if (!gitdir?.isDirectory() || gitdir.isSymbolicLink()) throw manual("This copy is not a standalone WIRE clone. Update it manually.");
        const remote = await git(root, ["remote", "get-url", "origin"], "This copy has no identifiable origin. Update it manually.");
        if (!official.test(remote) && (!fixtureRemote || !path.isAbsolute(fixtureRemote) || path.resolve(remote) !== path.resolve(fixtureRemote))) {
            throw manual("This copy does not track the official WIRE repository. Update it manually.");
        }
        const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], "Could not check the installation for local changes.");
        if (status) throw manual("This copy has local changes. Update it manually; your files were not changed.");
        const installed = await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], "Could not identify the installed WIRE build.");
        return { installed };
    }
    async function checkMain(root, running) {
        const { installed } = await inspectInstallation(root);
        if (!oid.test(running)) throw manual("The running build is not identified. Update manually.");
        const remote = await git(root, ["remote", "get-url", "origin"], "Could not identify the WIRE repository.");
        if (!official.test(remote) && remote !== fixtureRemote && (!fixtureRemote || path.resolve(remote) !== path.resolve(fixtureRemote))) throw manual("The WIRE origin changed. Check this installation manually.");
        await git(root, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", remote,
            `+refs/heads/main:${privateRef}`], "Could not check main. Check your network and Git access to the WIRE repository.", 60000);
        const candidate = await git(root, ["rev-parse", "--verify", `${privateRef}^{commit}`], "Could not resolve the main build.");
        for (const ancestor of new Set([running, installed])) {
            await git(root, ["merge-base", "--is-ancestor", ancestor, candidate],
                "This copy and main have different histories. Update manually; no changes were made.");
        }
        const current = await fingerprint(root, running);
        const next = candidate === running ? current : await fingerprint(root, candidate);
        return { installed: running, candidate: next === current ? null : candidate, fingerprint: next };
    }
    async function stageMain(root, info, directory) {
        if (!info || !oid.test(info.installed) || !oid.test(info.candidate)) throw failed("No verified update was selected.");
        const now = await checkMain(root, info.installed);
        if (!now.candidate || now.fingerprint !== info.fingerprint) throw failed("The available update changed. Check for updates again.");
        if (await fingerprint(root, info.candidate) !== now.fingerprint) throw failed("The selected build no longer matches this update.");
        await git(root, ["merge-base", "--is-ancestor", info.candidate, now.candidate], "The selected build is no longer on main.");
        const { installed } = await inspectInstallation(root);
        const contracts = await Promise.all([...new Set([installed, info.installed, info.candidate])].map(commit =>
            git(root, ["rev-parse", "--verify", `${commit}:${compatibility}`], "This build has no compatible update contract. Update it manually.")));
        if (new Set(contracts).size !== 1) throw manual("This build changes the store, launcher or adapter contract. A manual upgrade is required.");
        const entries = await readdir(directory);
        if (entries.length || (await lstat(directory)).isSymbolicLink()
            || path.resolve(root) === path.resolve(directory)) throw failed("A new, empty stage directory is required.");
        await git(directory, ["init", "--quiet"], "Could not create an isolated update stage.");
        await git(directory, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", root, info.candidate], "Could not copy the pinned build into the update stage.", 90000);
        await git(directory, ["checkout", "--quiet", "--detach", info.candidate], "Could not prepare the pinned WIRE tree.");
        const cli = await npmCli();
        const options = { cwd: directory, timeout: 300000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
            env: { ...process.env, npm_config_engine_strict: "true", npm_config_audit: "false", npm_config_fund: "false",
                PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } };
        try { await execute(process.execPath, [cli, "ci", "--include=dev"], options); }
        catch { throw failed("The update dependencies could not be installed. Check Node/npm compatibility and network access. WIRE is still running."); }
        try { await execute(process.execPath, [cli, "run", "build"], options); }
        catch { throw failed("The new WIRE browser build failed. The running app was not changed."); }
        await assertSameCanvasAdapter(root, directory);
        return { commit: info.candidate, fingerprint: now.fingerprint };
    }
    return { inspectInstallation, checkMain, stageMain };
}

export const { inspectInstallation, checkMain, stageMain } = createUpdateSource();
