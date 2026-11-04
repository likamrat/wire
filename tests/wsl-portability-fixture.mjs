import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createCollector } from "../lib/collector.mjs";
import { acquireCollectorLock, collectorHostIdentity } from "../lib/collector-io.mjs";
import { readSavedReportDocument, readSavedArtifactFile } from "../lib/report-artifacts.mjs";
import { inspectWslHostRows } from "../lib/host-handover.mjs";
import { hostPaths } from "../lib/host-paths.mjs";

const [action, dataDir, nonce, argument] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
assert.match(path.basename(path.dirname(dataDir)), /^wire-wsl-portability-/);
assert.equal(path.basename(dataDir), "data");
assert.equal(JSON.parse(await readFile(path.join(path.dirname(dataDir), "fixture.json"), "utf8")).nonce, nonce);
const context = { dataDir };

if (action === "hold") {
    const release = await acquireCollectorLock(dataDir);
    let timer;
    try {
        console.log(JSON.stringify({ platform: process.platform, holding: true, pid: process.pid }));
        const stopped = await new Promise(resolve => {
            process.once("SIGTERM", () => resolve(true));
            timer = setTimeout(() => resolve(false), 20000);
        });
        assert.equal(stopped, true, "The exact owned Linux holder must be stopped gracefully.");
    } finally { clearTimeout(timer); await release(); }
} else if (action === "host") {
    console.log(JSON.stringify({ platform: process.platform, host: await collectorHostIdentity() }));
} else if (action === "verify-host-rows") {
    assert.equal(path.dirname(argument), path.dirname(dataDir));
    const request = JSON.parse(await readFile(argument, "utf8"));
    assert.equal(hostPaths.local(request.windowsDataDir), dataDir);
    for (const value of [request.config.appDbPath, request.config.sessionRoot]) {
        const relative = path.relative(path.dirname(dataDir), hostPaths.local(value));
        assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    }
    console.log(JSON.stringify({ platform: process.platform, ...await inspectWslHostRows(request) }));
} else if (action === "mapped-collect") {
    const collector = await createCollector(context, { timers: false });
    try {
        await collector.collectNow();
        const state = await loadBoardState(context, { readOnly: true });
        console.log(JSON.stringify({ platform: process.platform, records: state.evidence.length,
            oldVersion: state.evidence[0].userPrompt.authorshipVersion }));
    } finally { await collector.close(); }
} else if (action === "startup") {
    let runtime, access;
    try {
        runtime = await startServer(context, createExportController(context), {
            port: 0, collector: { timers: false }, sourcePolicy: "copilot-only",
            createAccess: async () => access = await createCopilotRuntimeAccess(context),
        });
        assert.notEqual(new URL(runtime.url).port, "4000");
        const health = await (await fetch(runtime.url + "health")).json();
        assert.equal(health.runtimeId, runtime.runtimeId);
        assert.equal((await fetch(runtime.url)).status, 200);
        assert.equal(runtime.accessBootstrap.mode, "enforced");
        assert.equal(runtime.accessBootstrap.collectionMode, "copilot-only");
        console.log(JSON.stringify({ platform: process.platform, started: true }));
    } finally { await runtime?.close(); await access?.close(); }
} else if (action === "report") {
    const state = await loadBoardState(context, { readOnly: true });
    const entry = state.exports[0];
    const html = await readSavedReportDocument(context, state, entry.bundleId);
    const json = await readSavedArtifactFile(context, state, entry.bundleId, "report", "json");
    const foreign = structuredClone(state);
    foreign.exports[0].bundleDir = String.raw`C:\unrelated-store\exports\files`;
    await assert.rejects(readSavedReportDocument(context, foreign, entry.bundleId), { status: 422 });
    console.log(JSON.stringify({ platform: process.platform, htmlHash: html.sha256, jsonHash: json.sha256 }));
} else if (action === "corrupt-report") {
    const state = await loadBoardState(context, { readOnly: true });
    await assert.rejects(readSavedReportDocument(context, state, state.exports[0].bundleId),
        error => error.status === 409 && /changed|integrity/i.test(error.message));
    console.log(JSON.stringify({ platform: process.platform, refusedAlteredBytes: true }));
} else if (action === "foreign-collection") {
    const indexFile = path.join(dataDir, "collector", "index.json");
    const index = JSON.parse(await readFile(indexFile, "utf8"));
    const checkpoint = path.join(dataDir, "collector", index.fingerprint, `${argument}.json`);
    const files = [path.join(dataDir, "workiq-evidence-board-v1.state.json"),
        path.join(dataDir, "collector", "config.json"), indexFile, checkpoint];
    const before = await Promise.all(files.map(file => readFile(file)));
    for (let restart = 0; restart < 2; restart++) {
        const collector = await createCollector(context, { timers: false });
        try {
            await assert.rejects(collector.collectNow(), { code: "source_host_mapping_required" });
        } finally { await collector.close(); }
        for (const [position, file] of files.entries()) assert.deepEqual(await readFile(file), before[position]);
    }
    const state = await loadBoardState(context, { readOnly: true });
    assert.equal(state.evidence[0].userPrompt.authorshipVersion, 5);
    console.log(JSON.stringify({ platform: process.platform, preserved: true, sourceReadsRefused: true }));
} else if (action === "lock") {
    let localPidExists = true;
    try { process.kill(Number(argument), 0); }
    catch (error) { if (error.code === "ESRCH") localPidExists = false; else throw error; }
    assert.equal(localPidExists, false, "The fixture must exercise a Windows PID absent from Linux.");
    let release, result;
    try {
        release = await acquireCollectorLock(dataDir);
        result = { platform: process.platform, acquired: true };
    } catch (error) {
        result = { platform: process.platform, acquired: false, code: error.code, status: error.status };
    } finally { await release?.(); }
    console.log(JSON.stringify(result));
} else throw new Error("Unknown portability fixture action.");
