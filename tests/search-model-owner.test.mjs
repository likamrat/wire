import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { createSearchModel, searchModelEnvironment } from "../lib/search-model.mjs";
import { SEARCH_MODEL_ID } from "../lib/search-model-assets.mjs";

function stubChildren(t) {
    const children = [], held = Promise.withResolvers();
    class Child extends EventEmitter {
        killed = false;
        exitCode = null;
        signalCode = null;
        send(message, callback) {
            queueMicrotask(() => {
                if (this.killed) return;
                if (message.kind === "initialize") {
                    this.emit("message", { ok: true, kind: "ready", modelId: SEARCH_MODEL_ID, ms: 1, rss: 1024, peakRss: 1024 });
                } else if (message.text === "hold") {
                    this.emit("message", { kind: "computing" });
                    held.resolve(this);
                } else {
                    const vector = new Float32Array(384); vector[0] = 1;
                    this.emit("message", { ok: true, kind: "embedded", modelId: SEARCH_MODEL_ID, ms: 1, rss: 1024, peakRss: 1024,
                        chunks: [{ start: 0, end: message.text.length, tokens: 3, vector }] });
                }
                callback?.(null);
            });
        }
        kill() {
            if (this.killed) return;
            this.killed = true;
            queueMicrotask(() => { this.signalCode = "SIGTERM"; this.emit("close", null); });
        }
    }
    const mocked = t.mock.method(childProcess, "fork", (target, args, options) => {
        assert.equal(target, fileURLToPath(new URL("../lib/search-model-worker.mjs", import.meta.url)));
        assert.deepEqual(args, []);
        assert.equal(options.execPath, process.execPath);
        assert.deepEqual(options.execArgv, ["--disallow-code-generation-from-strings", "--require",
            fileURLToPath(new URL("../lib/search-model-guard.cjs", import.meta.url))]);
        assert.deepEqual(options.env, searchModelEnvironment());
        assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
        assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
        const child = new Child(); children.push(child); return child;
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    return { children, held: held.promise };
}

test("stubbed owner rejects an unexpected helper exit without a response or unrelated timeout", async t => {
    const { children, held } = stubChildren(t);
    const model = createSearchModel();
    const pending = model.embed("hold");
    const rejection = assert.rejects(pending, { code: "model-process-failed" });
    const child = await held;
    child.exitCode = 1;
    child.emit("close", 1);
    await rejection;
    assert.equal((await model.embed("replacement")).length, 1);
    assert.equal(children.length, 2);
    await model.close();
    assert.ok(children.every(value => value.exitCode !== null || value.signalCode !== null));
});

test("stubbed owner supersession and close terminate pending work before replacement", async t => {
    const { children, held } = stubChildren(t);
    const model = createSearchModel();
    const old = model.embed("hold");
    const rejection = assert.rejects(old, { code: "model-cancelled" });
    await held;
    assert.equal((await model.embed("latest")).length, 1);
    await rejection;
    assert.equal(children[0].signalCode, "SIGTERM");
    const closing = model.embed("hold");
    const closeRejection = assert.rejects(closing, { code: "model-cancelled" });
    await model.close();
    await closeRejection;
    assert.ok(children.every(value => value.signalCode !== null));
});
