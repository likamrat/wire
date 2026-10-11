import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
import { Tokenizer } from "@huggingface/tokenizers";
import { createSearchModel, searchModelEnvironment } from "../lib/search-model.mjs";
import { SEARCH_MODEL, SEARCH_MODEL_ID, readSearchModel } from "../lib/search-model-assets.mjs";
import { chunkSearchText } from "../lib/search-chunks.mjs";
import { privateFixture } from "./helpers.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const fixturePairs = [
    ["The physician treated an injured patient in the hospital.", "A doctor cared for somebody who was hurt."],
    ["The mechanic repaired a broken automobile in the garage.", "Someone fixed a damaged vehicle."],
    ["Employees cannot sign in because their credentials have expired.", "Staff are locked out and must renew authentication."],
];
function monitorSearchChildren(t) {
    const original = childProcess.fork, children = [];
    const mocked = t.mock.method(childProcess, "fork", (modulePath, args, options) => {
        const child = original(modulePath, args, options);
        if (String(modulePath).endsWith("search-model-worker.mjs")) {
            assert.equal(options.execPath, process.execPath);
            assert.deepEqual(args, []);
            assert.deepEqual(options.execArgv, ["--disallow-code-generation-from-strings"]);
            assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
            assert.deepEqual(Object.keys(options.env).sort(), Object.keys(searchModelEnvironment()).sort());
            children.push(child);
        }
        return child;
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    return children;
}

test("real pinned CPU WASM embeds paraphrases, rejects negative controls and verifies model/runtime identity", async t => {
    const model = createSearchModel();
    t.after(() => model.close());
    const positives = [], negatives = [];
    for (const [document, query] of fixturePairs) {
        const a = await model.embed(`Recorded request\n${document}\nRetained local interaction`);
        const b = await model.embed(query);
        assert.equal(a.length, 1); assert.equal(b.length, 1);
        assert.equal(a[0].vector.length, 384);
        assert.ok(Math.abs(Math.hypot(...a[0].vector) - 1) < 1e-5);
        const score = dot(a[0].vector, b[0].vector);
        positives.push(score);
        assert.ok(score > 0.5);
        for (const unrelated of ["Distant galaxies contain enormous black holes.", "A recipe for chocolate cake and vanilla icing.",
            "Fresh salmon migrate upstream to reproduce.", "A hospital accountant calculated quarterly payroll."]) {
            const c = await model.embed(unrelated);
            const negative = dot(a[0].vector, c[0].vector);
            negatives.push(negative);
            assert.ok(negative < 0.5);
        }
    }
    assert.equal(model.status().modelId, SEARCH_MODEL_ID);
    assert.equal(model.status().state, "ready");
    t.diagnostic(JSON.stringify({ positiveCosines: positives, maxNegativeCosine: Math.max(...negatives), model: model.status() }));
});

test("token-aware Unicode chunks cover every source offset, preserve text and include long tails", async () => {
    const files = await readSearchModel();
    const tokenizer = new Tokenizer(JSON.parse(files["tokenizer.json"]), JSON.parse(files["tokenizer_config.json"]));
    const text = "Café naïve résumé 中文 😀\n".repeat(220) + "The spacecraft safely returned from the moon.";
    const chunks = chunkSearchText(text, tokenizer);
    let covered = 0;
    assert.ok(chunks.length > 2);
    for (const chunk of chunks) {
        assert.ok(chunk.start <= covered); assert.ok(chunk.end > covered);
        assert.ok(chunk.encoded.ids.length <= SEARCH_MODEL.maxTokens);
        assert.deepEqual(chunk.encoded, tokenizer.encode(text.slice(chunk.start, chunk.end), { return_token_type_ids: true }));
        assert.doesNotMatch(text.slice(chunk.start, chunk.end), /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
        covered = chunk.end;
    }
    assert.equal(covered, text.length);
    assert.match(text.slice(chunks.at(-1).start), /returned from the moon/);
    assert.deepEqual(chunkSearchText("", tokenizer), []);
    assert.equal(chunkSearchText("one short sentence", tokenizer).length, 1);
});

test("actual active helper computation is killed on abort and supersession, with at most one child alive", async t => {
    const children = monitorSearchChildren(t);
    let entered = Promise.withResolvers();
    const model = createSearchModel({ onActivity: event => { if (event.state === "computed") entered.resolve(); } });
    t.after(() => model.close());
    await model.embed("Warm up the local model.");
    entered = Promise.withResolvers();
    const signal = new AbortController();
    const pending = model.embed("Invented text about a damaged vehicle. ".repeat(3000), { signal: signal.signal });
    const rejection = assert.rejects(pending, { code: "model-cancelled" });
    await entered.promise;
    signal.abort();
    await rejection;
    assert.equal(children[0].killed, true);
    assert.notEqual(children[0].exitCode ?? children[0].signalCode, null);
    entered = Promise.withResolvers();
    const superseded = model.embed("Invented research material. ".repeat(3000));
    const supersededRejection = assert.rejects(superseded, { code: "model-cancelled" });
    await entered.promise;
    const latest = model.embed("A physician treated the patient.");
    await supersededRejection;
    assert.equal((await latest).length, 1);
    assert.equal(children.filter(child => child.exitCode === null && child.signalCode === null).length, 1);
    assert.equal(children[1].killed, true);
    entered = Promise.withResolvers();
    const closingWork = model.embed("Invented long-running research material. ".repeat(3000));
    const closingRejection = assert.rejects(closingWork, { code: "model-cancelled" });
    await entered.promise;
    await model.close();
    await closingRejection;
    assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
});

test("direct embed supersession at the IPC result callback boundary settles both invocations", async t => {
    const children = [];
    class FixtureChild extends EventEmitter {
        killed = false;
        exitCode = null;
        signalCode = null;
        send(message, callback) {
            queueMicrotask(() => {
                if (this.killed) return;
                const receipt = { ok: true, modelId: SEARCH_MODEL_ID, ms: 1, rss: 1024, peakRss: 1024 };
                if (message.kind === "initialize") this.emit("message", { ...receipt, kind: "ready" });
                else {
                    this.emit("message", { kind: "computed" });
                    const vector = new Float32Array(384);
                    vector[0] = 1;
                    this.emit("message", { ...receipt, kind: "embedded",
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
    const mocked = t.mock.method(childProcess, "fork", () => {
        assert.ok(children.every(child => child.signalCode !== null), "Replacement must not overlap a still-running child");
        const child = new FixtureChild();
        children.push(child);
        return child;
    });
    syncBuiltinESMExports();
    let replaceAtResult = false, replacement;
    const replacementStarted = Promise.withResolvers();
    const model = createSearchModel({ onActivity: event => {
        if (event.state === "computed" && replaceAtResult) {
            replaceAtResult = false;
            // Admit replacement after the IPC handler clears pending, before the old embed continuation resumes.
            queueMicrotask(() => {
                replacement = model.embed("Replacement sentence.");
                replacementStarted.resolve();
            });
        }
    } });
    try {
        await model.embed("Warm sentence.");
        replaceAtResult = true;
        const old = model.embed("Superseded sentence.").then(
            () => ({ state: "fulfilled" }),
            error => ({ state: "rejected", code: error.code }),
        );
        await replacementStarted.promise;
        assert.equal((await replacement).length, 1);
        const outcome = await Promise.race([old, setImmediate({ state: "pending" })]);
        assert.deepEqual(outcome, { state: "rejected", code: "model-cancelled" },
            "Superseded embed must settle without closing the replacement's ready child");
        assert.equal(model.status().state, "ready");
    } finally {
        await model.close();
        mocked.mock.restore();
        syncBuiltinESMExports();
    }
    assert.ok(children.every(child => child.signalCode !== null));
});

test("missing/corrupt models are explicit, with no fallback fetch or persisted query", async t => {
    const { root, context } = await privateFixture(t);
    const directory = path.join(root, "absent-model");
    const missing = createSearchModel({ directory });
    await assert.rejects(missing.embed("Ephemeral invented text"), { code: "model-missing" });
    await missing.close();
    await mkdir(directory);
    await writeFile(path.join(directory, "config.json"), Buffer.alloc(650));
    const corrupt = createSearchModel({ directory });
    await assert.rejects(corrupt.embed("Ephemeral invented text"), { code: "model-corrupt" });
    await corrupt.close();
    const state = await readFile(path.join(context.dataDir, `${BOARD_ID}.state.json`), "utf8");
    assert.doesNotMatch(state, /Ephemeral invented text/);
});
