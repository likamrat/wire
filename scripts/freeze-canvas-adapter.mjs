import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, version } from "esbuild";

// This is the executable closure understood by the original protocol-1 launcher.
// Read tracked Git objects, never the current collector or a personal extension.
const baseline = "83a6040065072acdf5e8984d8450bd3b4b8cf42e";
const bridge = "copilot-bridge";
const root = fileURLToPath(new URL("../", import.meta.url));
const write = process.argv[2] === "--write";
assert.deepEqual(process.argv.slice(2), write ? ["--write"] : []);
assert.equal(version, "0.28.2");
const temp = await mkdtemp(path.join(os.tmpdir(), "wire-freeze-canvas-"));
try {
    const archive = path.join(temp, "source.tar");
    execFileSync("git", ["archive", "-o", archive, baseline, "extension.mjs", "lib", "web"], { cwd: root });
    execFileSync("tar", ["-xf", archive, "-C", temp]);
    const { metafile } = await build({ absWorkingDir: temp, entryPoints: ["extension.mjs"], platform: "node",
        format: "esm", bundle: true, write: false, metafile: true, packages: "external" });
    const files = new Map();
    for (const name of Object.keys(metafile.inputs)) {
        assert.match(name, /^(extension\.mjs|(?:lib|web)\/[\w-]+\.mjs)$/);
        const entry = name === "extension.mjs";
        const target = entry ? name : `${bridge}/${path.posix.basename(name)}`;
        assert.ok(!files.has(target), `Ambiguous adapter module: ${name}`);
        let source = (await readFile(path.join(temp, name), "utf8")).replaceAll("\r\n", "\n");
        source = entry ? source.replaceAll('"./lib/', `"./${bridge}/`)
            : source.replaceAll('"../web/recorded-results.mjs"', '"./recorded-results.mjs"');
        files.set(target, source);
    }
    if (write) await mkdir(path.join(root, bridge), { recursive: true });
    for (const [name, source] of files) {
        const target = path.join(root, name);
        if (write) await writeFile(target, name === "extension.mjs" && process.platform === "win32" ? source.replaceAll("\n", "\r\n") : source);
        else assert.ok((await readFile(target, "utf8")).replaceAll("\r\n", "\n") === source, `Not frozen source: ${name}`);
    }
    assert.deepEqual((await readdir(path.join(root, bridge))).sort(),
        [...files.keys()].filter(name => name !== "extension.mjs").map(name => path.posix.basename(name)).sort());
    console.log(`Canvas entry and ${files.size - 1} frozen modules match ${baseline}.`);
} finally {
    await rm(temp, { recursive: true, force: true });
}
