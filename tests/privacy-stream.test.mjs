import test from "node:test";
import assert from "node:assert/strict";
import { createArrayPrivacyScan, scanTree } from "../lib/privacy.mjs";

test("incremental selected-field scanning equals one ordinary array scan across arbitrary chunk boundaries", () => {
    const values = [
        { message: "An invented message.", metadata: { source: "invented", index: 0 } },
        { message: "Contact someone@example.invalid", fields: [null, false, 4, "second"] },
        { nested: [{ text: "Third representation." }] },
    ];
    const scan = createArrayPrivacyScan();
    for (const value of values) scan.append(value);
    assert.deepEqual(scan.finish(), scanTree(values));
    assert.throws(() => scan.append({ text: "Cannot extend a finished scan" }), { status: 422 });
});

test("incremental privacy text budget is cumulative and cannot publish a partial successful scan", () => {
    const text = "x".repeat(2 * 1024 * 1024);
    assert.ok(scanTree([text]));
    const scan = createArrayPrivacyScan();
    scan.append(text);
    assert.throws(() => scan.append(text), error => error.status === 422 && /text limit exceeded/.test(error.message));
    assert.throws(() => scan.finish(), { status: 422 });
});

test("incremental privacy field budget and unsupported-value failures stay terminal", () => {
    const scan = createArrayPrivacyScan();
    for (let index = 0; index < 24999; index++) scan.append({ text: "x" });
    assert.throws(() => scan.append({ text: "x" }), error => error.status === 422 && /field limit exceeded/.test(error.message));
    assert.throws(() => scan.finish(), { status: 422 });
    const invalid = createArrayPrivacyScan();
    assert.throws(() => invalid.append({ hidden: undefined }), { status: 422 });
    assert.throws(() => invalid.append({ text: "Cannot continue after a rejected chunk" }), { status: 422 });
});

test("even a non-Error traversal exception cannot turn a failed sequence into a partial successful scan", () => {
    const scan = createArrayPrivacyScan();
    const invalid = new Proxy({}, { ownKeys() { throw undefined; } });
    let rejected = false;
    try { scan.append(invalid); } catch { rejected = true; }
    assert.equal(rejected, true);
    assert.throws(() => scan.finish(), { status: 422 });
});
