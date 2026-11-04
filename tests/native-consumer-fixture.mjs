import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { privateFixture } from "./helpers.mjs";
import { chatFixture, coworkFixture, multiCallChatFixture } from "./native-read-model-fixtures.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createFixtureRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";

const A = "a".repeat(64), B = "b".repeat(64), owner = "invented-native-reader-owner";
export const nativeConsumerEnvelopes = () => [...chatFixture(), ...coworkFixture(), multiCallChatFixture()];

export async function nativeConsumerCommand(lifecycle, action, extra = {}) {
    return lifecycle.command(owner, { action, operationId: randomUUID(), generation: (await lifecycle.status()).generation, ...extra }, () => true);
}

// Owned temporary storage and invented transports only. This is not a native
// account resolver, production adapter, browser profile or writer admission.
export async function nativeConsumerFixture(t, { records = [], envelopes = nativeConsumerEnvelopes(), source } = {}) {
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const lifecycle = await createMicrosoftSession(context, {
        collection: { paused: false, windowDays: 30 },
        transport: {
            qualification: "synthetic-only-v1", async open() {},
            async verify({ expectedPartition }) { return { partition: expectedPartition, chat: true, cowork: true }; },
            async stop() { return { processExited: true, profileReleased: true }; },
        },
    });
    let runtime;
    const access = await createFixtureRuntimeAccess(context, { lifecycle, nativeSource: source ?? (lease => {
        assert.equal(lease.kind, "microsoft-retained");
        if (lease.partition === A) return structuredClone(envelopes);
        if (lease.partition === B) return chatFixture().map(row => ({
            ...row, scope: { ...row.scope, account: { ...row.scope.account, subjectId: "invented-replacement" } },
        }));
        throw new Error("Unknown invented fixture partition.");
    }) });
    t.after(async () => {
        await runtime?.close(); access.close(); await lifecycle.close();
        for (const fn of cleanup) await fn();
    });
    await nativeConsumerCommand(lifecycle, "wire-sign-in");
    await nativeConsumerCommand(lifecycle, "microsoft-connect", { expectedPartition: A, replace: false });
    return { context, lifecycle, access, reader: access.nativeReader,
        get url() { return runtime?.url; },
        setEnvelopes(value) { envelopes = value; },
        async start() {
            runtime = await startServer(context, createExportController(context), { port: 0, access, collector: { timers: false } });
            const origin = new URL(runtime.url).origin;
            const capability = (await (await fetch(origin + "/api/session", {
                method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" }, body: "{}",
            })).json()).capability;
            const api = async (route, input) => {
                const response = await fetch(origin + route, {
                    method: input === undefined ? "GET" : "POST",
                    headers: { Origin: origin, "X-Board-Capability": capability, "Content-Type": "application/json" },
                    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
                });
                return { status: response.status, body: await response.json() };
            };
            api.stream = async () => {
                const controller = new AbortController();
                const response = await fetch(origin + "/api/search/events", {
                    method: "POST", signal: controller.signal,
                    headers: { Origin: origin, "X-Board-Capability": capability, "Content-Type": "application/json" },
                    body: JSON.stringify({ schemaVersion: 3 }),
                });
                assert.equal(response.status, 200);
                const reader = response.body.getReader(), decoder = new TextDecoder();
                let buffer = "";
                const next = async predicate => {
                    const deadline = AbortSignal.timeout(10000);
                    for (;;) {
                        deadline.throwIfAborted();
                        let end;
                        while ((end = buffer.indexOf("\n")) >= 0) {
                            const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
                            if (predicate(value)) return value;
                        }
                        const value = await reader.read();
                        assert.equal(value.done, false, "Search ended before the expected event.");
                        buffer += decoder.decode(value.value, { stream: true });
                    }
                };
                return { next, async close() { controller.abort(); await reader.cancel().catch(error => {
                    if (error.name !== "AbortError" && error.message !== "terminated") throw error;
                }); reader.releaseLock(); } };
            };
            return api;
        },
    };
}
