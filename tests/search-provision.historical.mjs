import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { provisionSearchModel } from "../scripts/provision-search-model.mjs";
import { SEARCH_MODEL, readSearchModel, defaultSearchModelDirectory } from "../lib/search-model-assets.mjs";
import { searchModelEnvironment } from "../lib/search-model.mjs";
import { privateFixture } from "./helpers.mjs";

test("provisioning is fixed, byte-verified, atomic and never overwrites a bad installation", async t => {
    const { root } = await privateFixture(t), files = await readSearchModel();
    const directory = path.join(root, "model"), requested = [];
    const mock = t.mock.method(globalThis, "fetch", async (url, options) => {
        const address = new URL(url);
        assert.equal(options.credentials, "omit");
        assert.equal(address.origin, "https://huggingface.co");
        const prefix = `/${SEARCH_MODEL.name}/resolve/${SEARCH_MODEL.revision}/`;
        assert.ok(address.pathname.startsWith(prefix));
        const name = address.pathname.slice(prefix.length);
        assert.ok(Object.hasOwn(files, name));
        requested.push(name);
        return new Response(files[name]);
    });
    assert.equal((await provisionSearchModel(directory)).state, "verified");
    assert.equal(requested.length, 5);
    await provisionSearchModel(directory);
    assert.equal(requested.length, 5, "An already verified model does not cause network acquisition");
    mock.mock.restore();
    assert.equal((await readdir(root)).some(name => name.startsWith(".provision-")), false);
    await mkdir(path.join(root, "bad-model"));
    await assert.rejects(provisionSearchModel(path.join(root, "bad-model")), { code: "model-missing" });
    const corrupt = t.mock.method(globalThis, "fetch", async () => new Response(Buffer.alloc(650)));
    await assert.rejects(provisionSearchModel(path.join(root, "corrupt-download")), { code: "provision-integrity" });
    await assert.rejects(readdir(path.join(root, "corrupt-download")), { code: "ENOENT" });
    corrupt.mock.restore();
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: "https://outside.invalid/asset" } }));
    await assert.rejects(provisionSearchModel(path.join(root, "foreign-redirect")), { code: "provision-host-denied" });
    assert.equal((await readdir(root)).some(name => name.startsWith(".provision-")), false);
});

test("locked omit-dev offline installation runs the real owned WASM helper without native ORT", { timeout: 120000 }, async t => {
    const { root } = await privateFixture(t), directory = path.join(root, "production");
    await mkdir(path.join(directory, "lib"), { recursive: true });
    for (const file of ["package.json", "package-lock.json", "lib/search-model-worker.mjs", "lib/search-model-guard.cjs",
        "lib/search-model-assets.mjs", "lib/search-chunks.mjs"]) {
        await copyFile(new URL(`../${file}`, import.meta.url), path.join(directory, ...file.split("/")));
    }
    const run = promisify(execFile), args = ["ci", "--omit=dev", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"];
    if (process.platform === "win32") await run(process.env.ComSpec, ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd: directory });
    else await run("npm", args, { cwd: directory });
    await assert.rejects(readFile(path.join(directory, "node_modules", "onnxruntime-node", "package.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(directory, "node_modules", "@playwright", "test", "package.json")), { code: "ENOENT" });
    const child = fork(path.join(directory, "lib", "search-model-worker.mjs"), [], {
        cwd: directory, execPath: process.execPath, execArgv: ["--disallow-code-generation-from-strings", "--require",
            path.join(directory, "lib", "search-model-guard.cjs")],
        serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"], env: searchModelEnvironment(),
    });
    const exit = new Promise(resolve => child.once("close", resolve));
    let result;
    try { result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => reject(new Error("Isolated model helper closed before completion.")));
        child.on("message", message => {
            if (message.ok === false) reject(new Error(message.code));
            else if (message.kind === "ready") child.send({ kind: "embed", text: "An invented physician treated a patient." });
            else if (message.kind === "embedded") resolve(message);
        });
        child.send({ kind: "initialize", directory: defaultSearchModelDirectory });
    }); } finally { child.kill(); await exit; }
    assert.equal(result.chunks[0].vector.length, 384);
    t.diagnostic(JSON.stringify({ productionOffline: true, runtime: "onnxruntime-web@1.22.0", childRss: result.rss }));
});
