import test from "node:test";
import assert from "node:assert/strict";
import { createUsageObserver } from "../lib/usage-observer.mjs";

function fixture() {
    const handlers = new Set(), saved = [], errors = [];
    let granted = true;
    const session = { sessionId: "source-session", on(handler) { handlers.add(handler); return () => handlers.delete(handler); } };
    const grant = () => granted ? { confirmed: true, categories: ["usage"], sourceSessionId: "source-session",
        sourceRef: "source-" + "a".repeat(32), revision: 1 } : null;
    return {
        handlers, saved, errors, session, grant, revoke: () => { granted = false; },
        resolveInteraction: async eventId => eventId === "prompt-event" ? "interaction-" + "b".repeat(32) : null,
        emit: event => { for (const handler of handlers) handler(event); },
    };
}
const prompt = { type: "user.message", id: "prompt-event", data: { messageId: "prompt-message", content: "NEVER RETAIN THIS" } };
const message = { type: "assistant.message", id: "answer-event", data: {
    originatingMessageId: "prompt-message", apiCallId: "api-1", model: "model-a", content: "NEVER RETAIN THE ANSWER",
} };
const usage = { type: "assistant.usage", id: "usage-event", data: {
    apiCallId: "api-1", model: "model-a", copilotUsage: { totalNanoAiu: 100000000 },
} };

test("observer remains entirely unsubscribed without scoped usage authority", () => {
    const f = fixture(); f.revoke();
    assert.throws(() => createUsageObserver({ ...f, currentGrant: f.grant, onUsage: row => f.saved.push(row), onError: error => f.errors.push(error) }), /usage-observer-not-approved/);
    assert.equal(f.handlers.size, 0);
});

test("out-of-order ephemeral usage binds explicit original message and deduplicates delivery without text", async () => {
    const f = fixture();
    const observer = createUsageObserver({ ...f, currentGrant: f.grant, onUsage: row => f.saved.push(row), onError: error => f.errors.push(error) });
    f.emit(prompt); f.emit(usage); f.emit(message); f.emit(usage);
    await observer.flush();
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].value, 0.1);
    assert.doesNotMatch(JSON.stringify(f.saved), /NEVER RETAIN|prompt-message|api-1/);
    assert.deepEqual(f.errors, []);
    observer.stop();
    assert.equal(f.handlers.size, 0);
});

test("revocation before async ownership resolution blocks late retention", async () => {
    const f = fixture();
    let resolve;
    const held = new Promise(done => { resolve = done; });
    const observer = createUsageObserver({ ...f, currentGrant: f.grant, resolveInteraction: () => held,
        onUsage: row => f.saved.push(row), onError: error => f.errors.push(error) });
    f.emit(prompt); f.emit(message); f.emit(usage);
    await new Promise(done => setImmediate(done));
    f.revoke(); resolve("interaction-" + "b".repeat(32));
    await observer.flush();
    assert.equal(f.saved.length, 0);
    assert.match(f.errors[0].message, /usage-grant-changed/);
    observer.stop();
});

test("events without a retained interaction stay unassigned and bounded loss is explicit", async () => {
    const f = fixture();
    const observer = createUsageObserver({ ...f, currentGrant: f.grant, resolveInteraction: async () => null,
        onUsage: row => f.saved.push(row), onError: error => f.errors.push(error), pendingLimit: 2 });
    f.emit(prompt); f.emit(message); f.emit(usage);
    await observer.flush();
    assert.equal(f.saved.length, 0);
    assert.match(f.errors[0].message, /usage-interaction-not-retained/);
    for (let i = 0; i < 4; i++) f.emit({ ...usage, data: { ...usage.data, apiCallId: `extra-${i}` } });
    await observer.flush();
    assert.ok(f.errors.some(error => error.message === "usage-observer-capacity"));
    observer.stop();
});

test("observer never reads response or reasoning properties while queuing usage metadata", async () => {
    const f = fixture();
    const observer = createUsageObserver({ ...f, currentGrant: f.grant, onUsage: row => f.saved.push(row), onError: error => f.errors.push(error) });
    const data = { ...message.data };
    Object.defineProperty(data, "content", { get() { throw new Error("Response text must not be read"); } });
    Object.defineProperty(data, "reasoningText", { get() { throw new Error("Reasoning must not be read"); } });
    f.emit(prompt); f.emit({ ...message, data }); f.emit(usage);
    await observer.flush();
    assert.equal(f.saved.length, 1);
    assert.deepEqual(f.errors, []);
    observer.stop();
});
