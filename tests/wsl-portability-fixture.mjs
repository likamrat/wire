import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { startServer } from "../lib/server.mjs";
import { createCollector } from "../lib/collector.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { loadBoardState, mergeEvidenceWithState } from "../lib/store.mjs";
import { hostPaths } from "../lib/host-paths.mjs";

const [action, sourceRoot, nonce, dataDir] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
assert.match(path.basename(sourceRoot), /^wire-source-reader-/);
assert.equal(JSON.parse(await readFile(path.join(sourceRoot, "fixture.json"), "utf8")).nonce, nonce);
const digest = value => createHash("sha256").update(value).digest("hex");
const config = JSON.parse(await readFile(path.join(sourceRoot, "source.json"), "utf8"));
assert.equal(hostPaths.local(config.appDbPath), path.join(sourceRoot, "data.db"));
assert.equal(hostPaths.local(config.sessionRoot), path.join(sourceRoot, "session-state"));

if (action === "init") {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-source-reader-"));
    await writeFile(path.join(root, "fixture.json"), JSON.stringify({ nonce }));
    await mkdir(path.join(root, "data"));
    console.log(JSON.stringify({ platform: process.platform, dataDir: path.join(root, "data") }));
} else {
    const root = path.dirname(dataDir);
    assert.equal(path.basename(dataDir), "data");
    assert.match(path.basename(root), /^wire-source-reader-/);
    assert.equal(JSON.parse(await readFile(path.join(root, "fixture.json"), "utf8")).nonce, nonce);
    if (action === "cleanup") {
        assert.notEqual(root, sourceRoot);
        await rm(root, { recursive: true });
        console.log(JSON.stringify({ platform: process.platform, cleaned: true }));
    } else if (action === "foreign") {
        let collector;
        try {
            collector = await createCollector({ dataDir }, { timers: false });
            throw new Error("Foreign store was adopted.");
        } catch (error) {
            assert.ok(["COLLECTOR_OWNER_FOREIGN", "source_store_foreign"].includes(error.code));
            console.log(JSON.stringify({ platform: process.platform, refused: error.code }));
        } finally { await collector?.close(); }
    } else if (action === "collect") {
        const context = { dataDir };
        let runtime, access;
        try {
            runtime = await startServer(context, createExportController(context), {
                port: 0, collector: { timers: false }, sourcePolicy: "copilot-only",
                createAccess: async () => access = await createCopilotRuntimeAccess(context),
            });
            const origin = new URL(runtime.url).origin;
            assert.notEqual(new URL(origin).port, "4000");
            const headers = { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" };
            const panel = await (await fetch(origin + "/api/session", { method: "POST", headers, body: "{}" })).json();
            assert.equal(panel.runtimeId, runtime.runtimeId);
            headers["X-Board-Capability"] = panel.capability;
            const api = async (route, input = {}) => {
                const response = await fetch(origin + route, { method: "POST", headers, body: JSON.stringify(input) });
                return { status: response.status, body: await response.json() };
            };
            const status = await api("/api/collection/status");
            assert.equal(status.status, 200);
            if (!status.body.config) {
                const configured = await api("/api/collection/configure", config);
                assert.equal(configured.status, 200, configured.body.error);
            }
            const result = await api("/api/collection/now");
            const state = await loadBoardState(context, { readOnly: true });
            const indexFile = path.join(dataDir, "collector/index.json");
            const bytes = await readFile(indexFile), index = JSON.parse(bytes);
            const rows = mergeEvidenceWithState(state);
            console.log(JSON.stringify({ platform: process.platform, status: result.status, code: result.body.code,
                records: rows.length, sessions: rows.map(row => row.sourceSessionId),
                indexHash: digest(bytes), stateHash: digest(await readFile(path.join(dataDir, "workiq-evidence-board-v1.state.json"))),
                cursors: Object.values(index.sources).map(row => row.cursor?.identity), owner: index.ownerHost }));
        } finally { await runtime?.close(); await access?.close(); }
    } else throw new Error("Unknown owned source-reader fixture action.");
}
