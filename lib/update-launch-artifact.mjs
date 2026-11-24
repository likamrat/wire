import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { SEARCH_MODEL, readVerifiedFile } from "./search-model-assets.mjs";
import { SEARCH_LINGUISTICS, SEARCH_LINGUISTICS_ID } from "./search-linguistics-assets.mjs";
import { codePath, privateError } from "./update-launch-state.mjs";

const git = promisify(execFile);
export async function validateArtifact({ root, directory, base, source }, ref) {
    const location = codePath(root, directory, ref, base);
    if ((await source.inspectInstallation(root)).installed !== base) throw privateError("The original checkout changed. Review it manually before updating.");
    if (await realpath(location) !== location) throw privateError("The staged code directory moved. No runtime was started.");
    if (ref.slot !== null) {
        const run = async (...args) => (await git("git", ["--no-optional-locks", ...args],
            { cwd: location, timeout: 30000, windowsHide: true })).stdout.trim();
        if (await run("rev-parse", "--verify", "HEAD^{commit}") !== ref.commit
            || await run("status", "--porcelain=v1", "--untracked-files=normal")) {
            throw privateError("The staged code changed. No replacement was started.");
        }
    }
    const file = "lib/update-compatibility.json";
    const contract = await readFile(path.join(root, file));
    const parsed = JSON.parse(contract);
    if (Object.keys(parsed).sort().join() !== "canvasAdapterProtocol,launcherProtocol,storeReadWriteProtocol"
        || parsed.launcherProtocol !== 1 || parsed.storeReadWriteProtocol !== 2 || parsed.canvasAdapterProtocol !== 1
        || !contract.equals(await readFile(path.join(location, file)))) {
        throw privateError("The launcher, store or canvas protocol changed. Update this installation manually.");
    }
    return location;
}

// Copy only pinned, verified optional resources, never arbitrary ignored files
// or node_modules from the user's clone. No provisioner or download is run.
export async function preserveSearch(source, destination) {
    for (const [relative, specs] of [
        [path.join("assets", "search-models", "all-MiniLM-L6-v2", SEARCH_MODEL.revision), SEARCH_MODEL.files],
        [path.join("assets", "search-linguistics", SEARCH_LINGUISTICS_ID), SEARCH_LINGUISTICS.files],
    ]) {
        const directory = path.join(source, relative);
        try { await lstat(directory); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        for (const spec of specs) {
            const input = path.join(directory, spec.name), output = path.join(destination, relative, spec.name);
            if (await realpath(input) !== input) throw privateError("A local Search resource moved; the running app was not changed.");
            const bytes = await readVerifiedFile(directory, spec);
            await mkdir(path.dirname(output), { recursive: true });
            if (await realpath(path.dirname(output)) !== path.dirname(output)) throw privateError("The staged Search directory is not isolated.");
            await writeFile(output, bytes, { flag: "wx" });
        }
    }
}
