import test from "node:test";
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createRuntimeClient, RUNTIME_ORIGIN } from "../lib/runtime-client.mjs";
import { DEFAULT_RUNTIME_PORT } from "../lib/runtime-endpoint.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture } from "./helpers.mjs";

async function isolatedStore(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-port-test-"));
    const context = { dataDir: path.join(root, "data") }, stops = [];
    t.after(async () => {
        try { for (const stop of stops.reverse()) await stop(); }
        finally { await rm(root, { recursive: true, force: true }); }
    });
    await replaceEvidence(context, () => ({ records: [fixture("invented-port-record")], importCoverage: null }));
    await mkdir(path.join(context.dataDir, "collector"));
    const configFile = path.join(context.dataDir, "collector", "config.json");
    const config = JSON.stringify({ schemaVersion: 1, approved: true, enabled: false, windowDays: 30, pollSeconds: 60,
        appDbPath: path.join(root, "never-read", "data.db"), sessionRoot: path.join(root, "never-read", "session-state") });
    await writeFile(configFile, config);
    return { root, context, stops, configFile, config };
}

async function launch(app, args = [], { expectFailure = false, dataDir = app.context.dataDir } = {}) {
    const server = new URL("../lib/server.mjs", import.meta.url).href;
    const entry = new URL("../scripts/start.mjs", import.meta.url);
    // Keep the normal entry and access gates; only disable fixture collection timers.
    const wrapper = `import { startServer as start } from ${JSON.stringify(server)};
        export const startServer = (context, exports, options) =>
            start(context, exports, { ...options, collector: { ...options.collector, timers: false } });`;
    const guard = `import { registerHooks } from "node:module";
        registerHooks({ resolve(specifier, context, next) {
            if (/microsoft-native-(host|configuration)\\.mjs/.test(specifier))
                throw new Error("The release must not load a Microsoft source owner.");
            if (context.parentURL === ${JSON.stringify(entry.href)} && specifier === "../lib/server.mjs")
                return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(wrapper))}, shortCircuit: true };
            return next(specifier, context);
        } });`;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        name !== "NODE_TEST_CONTEXT" && name !== "NODE_OPTIONS" && !name.startsWith("WIRE_")
        && !/^(?:GH|GITHUB|COPILOT)(?:_[A-Z0-9]+)*_TOKEN$/i.test(name)));
    const child = fork(entry, args, {
        env: { ...environment, WORKIQ_EVIDENCE_DATA_DIR: dataDir,
            COPILOT_HOME: path.join(app.root, "no-copilot"), GH_CONFIG_DIR: path.join(app.root, "no-profile") },
        execArgv: ["--import", "data:text/javascript," + encodeURIComponent(guard)],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    let stdout = "", stderr = "", stopped = false;
    const stop = async () => {
        if (stopped) return;
        if (child.connected) child.disconnect();
        const timer = setTimeout(() => child.kill(), 5000);
        try {
            const result = await exited;
            stopped = true;
            assert.deepEqual(result, { code: expectFailure ? 1 : 0, signal: null }, stderr);
        } finally { clearTimeout(timer); }
    };
    app.stops.push(stop);
    const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture startup timed out: " + stderr)), 15000);
        const finish = (error, value) => {
            clearTimeout(timer);
            if (error) reject(error); else resolve(value);
        };
        child.once("error", error => finish(error));
        child.stderr.on("data", bytes => {
            stderr += bytes;
            if (/could not start|requested port is already owned/.test(stderr)) {
                if (expectFailure && child.connected) child.disconnect();
                else finish(new Error(stderr));
            }
        });
        child.stdout.on("data", bytes => {
            stdout += bytes;
            const ready = /ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout);
            if (ready) finish(null, ready[1]);
        });
        child.once("exit", code => {
            if (expectFailure && code === 1) finish(null, null);
            else finish(new Error("Fixture launcher exited: " + stderr));
        });
    });
    return { url, stop, stdout, stderr };
}

test("normal launcher and default canvas client use loopback 4000 and preserve retained evidence", { timeout: 30000 }, async t => {
    const app = await isolatedStore(t), before = await loadBoardState(app.context);
    assert.equal(DEFAULT_RUNTIME_PORT, 4000);
    assert.equal(RUNTIME_ORIGIN, "http://127.0.0.1:4000");
    const runtime = await launch(app);
    assert.equal(runtime.url, RUNTIME_ORIGIN + "/");
    const health = await fetch(runtime.url + "health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "workiq-evidence");
    const page = await fetch(runtime.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /WIRE/);
    const client = createRuntimeClient();
    try {
        assert.deepEqual(await client.open("port-fixture"), { title: "WIRE", url: runtime.url });
        const state = await client.action("port-fixture", "get_state", {});
        assert.equal(state.scenarios[0].scenarioId, "invented-port-record");
    } finally { await client.close("port-fixture"); }
    const session = await fetch(runtime.url + "api/session", { method: "POST",
        headers: { Origin: RUNTIME_ORIGIN, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" }, body: "{}" });
    const connection = await session.json();
    assert.equal(connection.accessBootstrap.mode, "enforced");
    assert.equal(connection.accessBootstrap.collectionMode, "copilot-only");
    const release = await fetch(runtime.url + "api/session/release", { method: "POST",
        headers: { Origin: RUNTIME_ORIGIN, "Content-Type": "application/json", "X-Board-Capability": connection.capability }, body: "{}" });
    assert.equal(release.status, 200);
    await runtime.stop();
    assert.deepEqual((await loadBoardState(app.context)).evidence, before.evidence);
    assert.equal(await readFile(app.configFile, "utf8"), app.config);
});

test("direct server default and occupied default refuse a second launcher before store initialization", { timeout: 30000 }, async t => {
    const app = await isolatedStore(t);
    const runtime = await startServer(app.context, createExportController(app.context), { collector: { timers: false } });
    app.stops.push(() => runtime.server.listening ? runtime.close() : undefined);
    assert.equal(runtime.url, "http://127.0.0.1:4000/");
    assert.equal(runtime.server.address().address, "127.0.0.1");
    let accessCalls = 0;
    await assert.rejects(startServer(app.context, createExportController(app.context), {
        collector: { timers: false }, createAccess: async () => { accessCalls++; },
    }), { code: "EADDRINUSE" });
    assert.equal(accessCalls, 0);
    const unused = path.join(app.root, "must-stay-absent");
    const refused = await launch(app, [], { expectFailure: true, dataDir: unused });
    assert.equal(refused.url, null);
    assert.match(refused.stderr, /requested port is already owned/);
    assert.doesNotMatch(refused.stdout, /ready at/);
    await assert.rejects(readdir(unused), { code: "ENOENT" });
    const imported = path.join(app.root, "invented-import.json");
    await writeFile(imported, "{}");
    await assert.rejects(promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("../scripts/import-graph.mjs", import.meta.url)), "--file", imported, "--data-dir", unused,
    ], { timeout: 10000 }), error => error.code === 1 && /EADDRINUSE/.test(error.stderr));
    await assert.rejects(readdir(unused), { code: "ENOENT" });
    assert.equal((await fetch(runtime.url + "health")).status, 200);
    await runtime.close();
});

test("explicit ephemeral and fixed ports retain client and data-directory overrides", { timeout: 30000 }, async t => {
    const app = await isolatedStore(t);
    const ephemeral = await launch(app, ["--port", "0"]);
    const origin = new URL(ephemeral.url).origin, port = new URL(origin).port;
    assert.notEqual(port, "0");
    const client = createRuntimeClient(origin);
    try { assert.equal((await client.open("explicit-port")).url, ephemeral.url); }
    finally { await client.close("explicit-port"); }
    const refused = await launch(app, ["--port", port], {
        expectFailure: true, dataDir: path.join(app.root, "must-stay-absent"),
    });
    assert.equal(refused.url, null);
    assert.match(refused.stderr, /requested port is already owned/);
    assert.equal((await fetch(ephemeral.url + "health")).status, 200);
    await ephemeral.stop();
    const fixed = await launch(app, ["--port", port]);
    assert.equal(fixed.url, ephemeral.url);
    await fixed.stop();
    assert.equal((await loadBoardState(app.context)).evidence[0].scenarioId, "invented-port-record");
    assert.equal(await readFile(app.configFile, "utf8"), app.config);
});
