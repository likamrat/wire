import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { EventEmitter, once } from "node:events";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { setImmediate } from "node:timers/promises";
import { createCoworkReadBridge } from "../lib/microsoft-cowork-read-bridge.mjs";
import { createChatReadHost } from "../lib/microsoft-chat-read-host.mjs";
import { openCoworkBrowserHost, COWORK_CLIENT_ASSETS, CHAT_CLIENT_ASSETS } from "../lib/microsoft-cowork-browser.mjs";
import { acquireCoworkClient } from "../lib/microsoft-cowork-acquisition.mjs";
import { acquireMicrosoftSession } from "../lib/microsoft-session-acquisition.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { privateFixture, selectActivityOption } from "./helpers.mjs";
import { acquireCollectorLock } from "../lib/collector-io.mjs";
import { chromium, expect } from "@playwright/test";
import { closeNativeBrowserContext, createMicrosoftNativeHost } from "../lib/microsoft-native-host.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { COWORK_COMPOSITION_ENTRY, COWORK_COMPOSITION_MANIFEST } from "../lib/microsoft-cowork-composition.mjs";

const principal = { namespace: "m365.accountInfo.objectId", realm: "prod",
    tenantId: "11111111-1111-4111-8111-111111111111", subjectId: "22222222-2222-4222-8222-222222222222" };
const nativeAccount = { tenantId: principal.tenantId, userId: principal.subjectId, realm: "prod" };
const capabilities = () => ({ isConsented: false, isEdgeIdentityMatched: false, isSimpleBrowserSupported: false });
const store = value => {
    const listeners = new Set();
    return { getState: () => value, setState(next) { value = next; for (const fn of [...listeners]) fn(value); },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
};
const event = (id, text = "Invented prompt", time = Date.now() - 1000) => ({
    id, event: "u", data: { ts: time, t: text },
});
const task = id => ({ sessionId: id, ic3ThreadId: "thread-" + id, lastActivity: Date.now() - 1000 });

function bridgeFixture(client, overrides = {}) {
    const clients = store({ client }), consent = store(capabilities());
    const bridge = createCoworkReadBridge({ principal, getAccount: () => nativeAccount,
        getClient: () => clients.getState().client, getCapabilities: consent.getState,
        subscribeClient: clients.subscribe, subscribeCapabilities: consent.subscribe,
        assertCurrent() {}, instanceId: randomUUID(), deadline: Date.now() + 10000, ...overrides });
    const invoke = (method, args) => bridge.invoke({ invocationId: randomUUID(), method, arguments: args });
    return { bridge, invoke, clients, consent };
}

test("native bridge discovers IDs, follows original cursors and never opens a task", async t => {
    const calls = [];
    const f = bridgeFixture({
        async listTasks(args) { calls.push(["tasks", args]); return { tasks: [task("a")], nextCursor: null }; },
        async listMessages(args) {
            calls.push(["messages", args]);
            return { events: [event(args.cursor ? "second" : "first")], nextCursor: args.cursor ? null : "next" };
        },
        getTaskDetail() { assert.fail("Detail/coalescing is not authorized by this bridge."); },
    });
    t.after(() => f.bridge.retire());
    await assert.rejects(f.invoke("listMessages", { pageSize: 200, sessionId: "supplied-id" }), { code: "NATIVE_COWORK_CLIENT_ARGUMENTS_INVALID" });
    const inventory = await f.invoke("listTasks", { pageSize: 200 });
    assert.equal(inventory.kind, "native-client-return");
    await f.invoke("listMessages", { pageSize: 200, sessionId: "a" });
    await assert.rejects(f.invoke("listMessages", { pageSize: 200, sessionId: "a", cursor: "invented" }),
        { code: "NATIVE_COWORK_CLIENT_CURSOR_INVALID" });
    const second = await f.invoke("listMessages", { pageSize: 200, sessionId: "a", cursor: "next" });
    assert.equal(second.value.events[0].id, "second");
    assert.ok(calls.every(([, args]) => args.signal instanceof AbortSignal));
    assert.equal(calls.length, 3);
});

test("native bridge retirement preserves the known outer guard failure during synchronous capability notification", () => {
    let failed = false;
    const retired = [], code = "NATIVE_COWORK_CLIENT_READONLY_UNQUALIFIED";
    const fixture = bridgeFixture({ async listTasks() {}, async listMessages() {} }, {
        assertCurrent() { if (failed) throw Object.assign(new Error(code), { code }); },
        onRetire: value => retired.push(value),
    });
    failed = true;
    fixture.consent.setState({ ...capabilities(), isConsented: true });
    assert.deepEqual(retired, [code]);
    assert.throws(fixture.bridge.assertCurrent, { code });
});

for (const invalidation of ["replacement", "account", "consent", "deadline"]) {
    test(`native bridge rejects a held return after ${invalidation}`, async t => {
        const gate = Promise.withResolvers(), started = Promise.withResolvers();
        let account = nativeAccount;
        const f = bridgeFixture({
            async listTasks() { started.resolve(); return gate.promise; },
            async listMessages() { assert.fail("No additional reads after invalidation."); },
        }, { getAccount: () => account, ...(invalidation === "deadline" ? { deadline: Date.now() + 40 } : {}) });
        t.after(() => { f.bridge.retire(); gate.resolve({ tasks: [task("late")], nextCursor: null }); });
        const pending = f.invoke("listTasks", { pageSize: 200 });
        const rejected = assert.rejects(pending, { code: {
            replacement: "NATIVE_COWORK_CLIENT_REPLACED", consent: "NATIVE_COWORK_CLIENT_READONLY_UNQUALIFIED",
            account: "NATIVE_COWORK_CLIENT_ACCOUNT_CHANGED",
            deadline: "NATIVE_COWORK_CLIENT_DEADLINE",
        }[invalidation] });
        await started.promise;
        if (invalidation === "replacement") f.clients.setState({ client: {} });
        if (invalidation === "account") {
            account = { ...nativeAccount, userId: "changed-account" };
            gate.resolve({ tasks: [task("late")], nextCursor: null });
        }
        if (invalidation === "consent") f.consent.setState({ ...capabilities(), isConsented: true });
        if (invalidation === "deadline") await new Promise(resolve => setTimeout(resolve, 60));
        await rejected;
        gate.resolve({ tasks: [task("late")], nextCursor: null });
        await setImmediate();
        await assert.rejects(f.invoke("listTasks", { pageSize: 200 }));
    });
}

test("normalized empty or malformed native data is not successful empty history", async t => {
    for (const value of [{ tasks: [], nextCursor: null }, { tasks: [task("a")] },
        { tasks: [task("a")], nextCursor: {} }]) {
        const f = bridgeFixture({ async listTasks() { return value; }, async listMessages() {} });
        t.after(() => f.bridge.retire());
        await assert.rejects(f.invoke("listTasks", { pageSize: 200 }), { code: "NATIVE_COWORK_CLIENT_NORMALIZED_EMPTY" });
        await assert.rejects(f.invoke("listTasks", { pageSize: 200 }), { code: "NATIVE_COWORK_CLIENT_NORMALIZED_EMPTY" });
    }
});

test("native client call and UTF-8 response bounds are enforced without truncation", async t => {
    let dispatched = 0;
    const f = bridgeFixture({
        async listTasks() { dispatched++; return { tasks: Array.from({ length: 144 }, (_, n) => task("h-" + n)), nextCursor: null }; },
        async listMessages() { dispatched++; return { events: [event("bounded")], nextCursor: null }; },
    });
    t.after(() => f.bridge.retire());
    await f.invoke("listTasks", { pageSize: 200 });
    for (let n = 0; n < 143; n++) await f.invoke("listMessages", { sessionId: "h-" + n, pageSize: 200 });
    await assert.rejects(f.invoke("listMessages", { sessionId: "h-143", pageSize: 200 }),
        { code: "NATIVE_COWORK_CLIENT_INVOCATION_INVALID" });
    assert.equal(dispatched, 144);
    const oversized = bridgeFixture({
        async listTasks() { return { tasks: [task("a")], nextCursor: null }; },
        async listMessages() { return { events: [event("oversized", "\u20ac".repeat(700000))], nextCursor: null }; },
    });
    t.after(() => oversized.bridge.retire());
    await oversized.invoke("listTasks", { pageSize: 200 });
    await assert.rejects(oversized.invoke("listMessages", { sessionId: "a", pageSize: 200 }),
        { code: "NATIVE_COWORK_CLIENT_RESPONSE_LIMIT" });
});

test("a native cursor cycle retires the chain instead of replaying a prefix", async t => {
    let page = 0;
    const f = bridgeFixture({
        async listTasks() { return { tasks: [task("a")], nextCursor: ["first", "second", "first"][page++] }; },
        async listMessages() {},
    });
    t.after(() => f.bridge.retire());
    await f.invoke("listTasks", { pageSize: 200 });
    await f.invoke("listTasks", { pageSize: 200, cursor: "first" });
    await assert.rejects(f.invoke("listTasks", { pageSize: 200, cursor: "second" }),
        { code: "NATIVE_COWORK_CLIENT_CURSOR_INVALID" });
    assert.equal(page, 3);
});

async function retainedAcquisitionFixture(t, makeClient, { surfaces = ["cowork"], makeChat } = {}) {
    const cleanups = [], { context } = await privateFixture({ after: work => cleanups.push(work) }, []);
    const releaseWriter = await acquireCollectorLock(context.dataDir);
    const transport = createMicrosoftNativeReadTransport({
        async open() {}, async stop() { return { processExited: true, profileReleased: true }; },
        async verifyAccount() { return { ...principal, knownAccountMatched: true,
            evidence: { kind: "native-account-metadata", issuer: "https://m365.cloud.microsoft",
                namespace: principal.namespace, realm: "prod", observedAt: new Date().toISOString() } }; },
    });
    const lifecycle = await createMicrosoftSession(context, { transport, collection: { paused: false, windowDays: 7 } });
    const persistence = await createNativePersistence(context, { lifecycle, transport, backfillTracking: true });
    const comparisons = [], operations = [];
    let bridges = {};
    const access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence,
        async acquireNative(lease, collection, recordFailure, previousBackfill, operation) {
            operations.push(operation);
            const documentId = randomUUID();
            bridges = {};
            if (surfaces.includes("cowork")) {
                const client = makeClient();
                bridges.cowork = createCoworkReadBridge({ principal, instanceId: randomUUID(), deadline: Date.now() + 30000,
                    getAccount: () => nativeAccount, getClient: () => client, getCapabilities: capabilities,
                    subscribeClient: () => () => {}, subscribeCapabilities: () => () => {}, assertCurrent() {} });
            }
            if (surfaces.includes("chat")) {
                const native = makeChat();
                const router = { options: { context: {
                    store: { getState: () => ({ accountInfo: { accountType: "AAD", environment: "prod",
                        tenantId: principal.tenantId, objectId: principal.subjectId },
                    featureFlags: { enableChatLandingPageHistoryStore: false } }), subscribe: () => () => {} },
                    queryClient: { getDefaultOptions: () => ({ queries: { queryFn: native.query } }) },
                } }, routesById: { "/_sharedChatSetup/chat_/all": {} }, subscribe: () => () => {} };
                bridges.chat = createChatReadHost({ principal, getRouter: () => router,
                    optionsForAction: ({ action, payload }) => ({ queryKey: ["/chat", action], meta: { actionPayload: payload } }),
                    getConversation: native.detail, assertOwner() {}, onRetire() {} });
                bridges.chat.begin({ deadline: Date.now() + 30000, instanceId: randomUUID() });
            }
            const reader = { forSurface(surface) {
                const bridge = bridges[surface];
                assert.ok(bridge);
                return { instanceId: bridge.instanceId, documentId, operationId: operation.operationId,
                    origin: "https://m365.cloud.microsoft", assertCurrent: bridge.assertCurrent,
                    async read(method, args) {
                        return { ...await bridge.invoke({ invocationId: randomUUID(), method, arguments: args }),
                            documentId, operationId: operation.operationId };
                    } };
            } };
            return acquireMicrosoftSession({ lifecycle, transport, lease, collection, reader, recordFailure, previousBackfill });
        },
        async completeNative(ticket, receipt, acquired, recordBackfill) {
            const comparison = await persistence.compareCommittedSource(ticket, acquired);
            comparisons.push(comparison);
            await recordBackfill(comparison);
            for (const bridge of Object.values(bridges)) bridge.retire();
        },
    });
    t.after(async () => {
        for (const bridge of Object.values(bridges)) bridge.retire();
        access.close(); persistence.close(); await lifecycle.close(); await releaseWriter();
        for (const cleanup of cleanups) await cleanup();
    });
    for (const action of ["wire-sign-in", "microsoft-connect"]) {
        const receipt = await lifecycle.command("invented-cowork-history-owner", { action, operationId: randomUUID(),
            generation: (await lifecycle.status()).generation, ...(action === "microsoft-connect" ? { replace: false } : {}) }, () => true);
        assert.equal(receipt.outcome, "completed");
    }
    const admission = { owner: "invented-cowork-history-owner", check() {}, dispatched() {} };
    await persistence.configure({ expectedRevision: null, surfaces, windowDays: 7 }, admission);
    return {
        comparisons,
        operations,
        collect: input => access.collectNativeNow({ operationId: randomUUID(), ...input }, admission),
        receipts: async () => (await loadBoardState(context, { readOnly: true })).nativeRetention.receipts,
        progress: async () => (await loadBoardState(context, { readOnly: true })).nativeRetention.backfill?.[0],
        retained: async () => persistence.readAuthorized(await lifecycle.lease("microsoft-retained")),
    };
}

test("registered native Collect preserves a supplied deadline and never replays its receipt with a renewed deadline", async t => {
    const app = await retainedAcquisitionFixture(t, () => ({
        async listTasks() { return { tasks: [task("bounded")], nextCursor: null }; },
        async listMessages() { return { events: [event("bounded")], nextCursor: null }; },
    }));
    for (const deadline of [null, "future", 0, -1, 1.5]) {
        await assert.rejects(app.collect({ deadline }), { code: "wire_access_invalid_request" });
    }
    assert.deepEqual(await app.receipts(), []);
    const operationId = randomUUID(), deadline = Date.now() + 30000;
    assert.equal((await app.collect({ operationId, deadline })).status, "committed");
    assert.deepEqual(app.operations, [{ operationId, deadline }]);
    assert.equal(Object.isFrozen(app.operations[0]), true);
    assert.equal((await app.collect({ operationId, deadline: Date.now() + 600000 })).status, "committed");
    assert.equal(app.operations.length, 1);
    const before = Date.now();
    assert.equal((await app.collect({ deadline: before + 600000 })).status, "committed");
    assert.ok(app.operations[1].deadline >= before + 300000 && app.operations[1].deadline <= Date.now() + 300000);
});

test("an expired Collect deadline records one failed operation without dispatching or renewing acquisition", async t => {
    const app = await retainedAcquisitionFixture(t, () => { assert.fail("Expired work must not construct a native reader."); });
    await assert.rejects(app.collect({ deadline: Date.now() - 1 }), { code: "NATIVE_SOURCE_DEADLINE" });
    assert.deepEqual(app.operations, []);
    const receipts = await app.receipts();
    assert.equal(receipts.length, 1);
    assert.notEqual(receipts[0].status, "committed");
    assert.equal(receipts[0].firstFailure?.code, "NATIVE_SOURCE_DEADLINE");
});

for (const recency of ["old", "missing"]) {
    test(`native acquisition retains current events when list recency is ${recency}`, async t => {
        const now = Date.now(), calls = [];
        const app = await retainedAcquisitionFixture(t, () => ({
            async listTasks() { return { tasks: [{ sessionId: "a", ic3ThreadId: "thread-a",
                ...(recency === "old" ? { lastActivity: now - 8 * 86400000 } : {}) }], nextCursor: null }; },
            async listMessages(args) {
                calls.push(args.sessionId);
                return { events: [event("current-event", "Current source event", now - 1000)], nextCursor: null };
            },
        }));
        assert.equal((await app.collect()).status, "committed");
        assert.deepEqual(calls, ["a"]);
        const retained = await app.retained();
        assert.equal(retained.records.length, 1);
        assert.equal(retained.records[0].fields.observationTime.value, now - 1000);
        assert.equal(app.comparisons[0].status, "matched");
    });
}

test("committed byte-budget progress rotates past a partial large history on the next cycle", { timeout: 60000 }, async t => {
    const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const [large, small] = ["invented-a", "invented-b"].sort((a, b) => hash(a).localeCompare(hash(b)));
    const now = Date.now(), input = JSON.stringify({ q: "x".repeat(500000) }), reads = [];
    const rawBytes = [];
    let cycle = -1;
    const app = await retainedAcquisitionFixture(t, () => {
        cycle++;
        const currentCycle = cycle;
        rawBytes[currentCycle] = 0;
        return {
            async listTasks() { return { tasks: [task(large), task(small)], nextCursor: null }; },
            async listMessages(args) {
                reads.push({ cycle: currentCycle, id: args.sessionId });
                const page = args.cursor === undefined ? 0 : Number(args.cursor);
                const value = args.sessionId === small
                    ? { events: [event("small-event", "The later small history", now - 1000)], nextCursor: null }
                    : { events: [0, 1].map(index => ({ id: `large-${page}-${index}`, event: "ts",
                        data: { ts: now - 1000, tid: `tool-${page}-${index}`, tn: "mcp__graph__CallGraph", inp: input } })),
                    nextCursor: page === 9 ? null : String(page + 1) };
                const size = Buffer.byteLength(JSON.stringify(value));
                assert.ok(size < 2 * 1024 * 1024);
                rawBytes[currentCycle] += size;
                return value;
            },
        };
    });
    assert.equal((await app.collect()).status, "committed");
    const first = (await app.progress()).sources[0];
    assert.ok(first.stops.includes("byte-budget"));
    assert.equal(first.exhausted, false);
    assert.equal(first.coworkCursor?.referenceAfter, hash(large));
    assert.deepEqual(first.histories.map(row => [row.key, row.state, row.handledThrough]),
        [[hash(["cowork", large]), "pending", null]]);
    assert.equal((await app.retained()).records.length, 16);
    assert.equal((await app.collect()).status, "committed");
    assert.equal(reads.filter(row => row.cycle === 1)[0].id, small);
    assert.ok((await app.retained()).records.some(row => row.identity.id === "small-event"));
    assert.ok((await app.progress()).sources[0].histories.every(row => row.state === "pending"));
    assert.deepEqual(app.comparisons.map(row => row.status), ["matched", "matched"]);
    assert.ok(rawBytes.every(size => size < 12 * 1024 * 1024));
});

test("Cowork message page budget leaves the retained history pending without handled-through claims", async t => {
    let pages = 0;
    const app = await retainedAcquisitionFixture(t, () => ({
        async listTasks() { return { tasks: [task("paged")], nextCursor: null }; },
        async listMessages() { pages++; return { events: [event("page-" + pages)], nextCursor: "next-" + pages }; },
    }));
    assert.equal((await app.collect()).status, "committed");
    assert.equal(pages, 16);
    const source = (await app.progress()).sources[0];
    assert.ok(source.stops.includes("page-budget"));
    assert.equal(source.histories[0].state, "pending");
    assert.equal(source.histories[0].handledThrough, null);
    assert.equal(source.histories[0].handledActivity, null);
});

test("normalized Cowork feed end never publishes handled-through progress across committed cycles", async t => {
    const now = Date.now(), calls = [];
    let cycle = 0;
    const app = await retainedAcquisitionFixture(t, () => {
        const revision = ++cycle;
        return {
            async listTasks() { return { tasks: [task("normalized-end")], nextCursor: null }; },
            async listMessages(args) {
                calls.push([revision, args.cursor ?? null]);
                return { events: [event(`native-${revision}-${args.cursor ?? "first"}`, "Invented native event", now - 1000)],
                    nextCursor: args.cursor ? null : "native-next" };
            },
        };
    });
    for (const revision of [1, 2]) {
        assert.equal((await app.collect()).status, "committed");
        const source = (await app.progress()).sources[0];
        assert.equal(source.exhausted, false);
        assert.equal(source.startQualified, false);
        assert.ok(source.stops.includes("membership-unqualified"));
        assert.ok(!source.stops.includes("page-budget"));
        assert.equal(source.histories.length, 1);
        assert.deepEqual(source.histories.map(row => [row.state, row.handledActivity, row.handledThrough]),
            [["pending", null, null]], "Native normalization cannot attest that all events through a time were read.");
        assert.equal((await app.retained()).records.length, revision * 2);
    }
    assert.deepEqual(calls, [[1, null], [1, "native-next"], [2, null], [2, "native-next"]]);
    assert.deepEqual(app.comparisons.map(row => row.status), ["matched", "matched"]);
});

test("a native Cowork cycle with only outside-window events stays content-unverified, not complete empty history", async t => {
    const app = await retainedAcquisitionFixture(t, () => ({
        async listTasks() { return { tasks: [task("outside")], nextCursor: null }; },
        async listMessages() { return { events: [event("old-event", "Outside retained window", Date.now() - 8 * 86400000)],
            nextCursor: null }; },
    }));
    assert.equal((await app.collect()).status, "committed");
    const source = (await app.progress()).sources[0];
    assert.equal((await app.retained()).records.length, 0);
    assert.equal(source.exhausted, false);
    assert.equal(source.startQualified, false);
    assert.ok(source.stops.includes("membership-unqualified"));
    assert.deepEqual(source.histories, []);
    assert.deepEqual(app.comparisons.map(row => [row.status, row.reason]), [["unverified", "empty-source"]]);
});

test("both-source envelope budgets commit partial Chat without starving Cowork", { timeout: 60000 }, async t => {
    const text = "invented text ".repeat(4200), createdAt = new Date(Date.now() - 1000).toISOString();
    const app = await retainedAcquisitionFixture(t, () => ({
        async listTasks() { return { tasks: [task("small-cowork")], nextCursor: null }; },
        async listMessages() { return { events: [event("small-cowork-event", "Invented prompt", Date.parse(createdAt))], nextCursor: null }; },
    }), { surfaces: ["chat", "cowork"], makeChat: () => ({
        async query() { return { conversationPageHistoryList: {
            chats: ["chat-a", "chat-b", "chat-c", "chat-d", "chat-e"].map(conversationId => ({ conversationId })), syncState: "" },
        pinnedChatIds: {}, pinnedChats: [] }; },
        async detail({ data }) { return { store: { rawConversationResponse: {
            conversationId: data.conversationId, messages: Array.from({ length: 32 }, (_, index) => ({
                messageId: data.conversationId + "-" + index, author: "user", createdAt, text,
            })) } } }; },
    }) });
    assert.equal((await app.collect()).status, "committed");
    const progress = await app.progress(), chat = progress.sources.find(row => row.surface === "chat");
    assert.ok(chat.stops.includes("byte-budget"));
    assert.ok(chat.chatCursor.referenceAfter);
    assert.ok(chat.histories.every(row => row.state === "pending" && row.handledThrough === null));
    const retained = await app.retained();
    assert.ok(retained.records.some(row => row.scope.surface === "chat"));
    assert.ok(retained.records.some(row => row.scope.surface === "cowork" && row.identity.id === "small-cowork-event"));
    assert.equal(app.comparisons[0].status, "matched");
});

// An invented component/effect driver, not React or Microsoft code. It exercises
// our real bootstrap and bridge across a parent/provider boundary and cleanup.
function renderer() {
    const instances = new Map();
    const errors = [];
    let rendering, root, scheduled = false, destroyed = false;
    const destroy = () => {
        destroyed = true;
        for (const instance of instances.values()) for (const hook of instance.hooks) hook.cleanup?.();
        instances.clear();
    };
    const Provider = Symbol("invented-native-provider");
    const render = () => {
        if (destroyed) return;
        const seen = new Set(), effects = [];
        const visit = (element, path = "root", context = null) => {
            if (!element) return;
            if (element.type === Provider) return visit(element.props.children, path + "/provider", {
                account: element.props.account, client: element.props.client,
            });
            const previous = rendering;
            let instance = instances.get(path);
            if (!instance || instance.type !== element.type) {
                instance = { type: element.type, hooks: [], context };
                instances.set(path, instance);
            }
            instance.context = context;
            instance.cursor = 0;
            instance.effects = [];
            seen.add(path);
            rendering = instance;
            const child = element.type(element.props);
            rendering = previous;
            visit(child, path + "/child", context);
            effects.push(...instance.effects);
        };
        visit(root);
        for (const [key, instance] of instances) if (!seen.has(key)) {
            for (const hook of instance.hooks) hook.cleanup?.();
            instances.delete(key);
        }
        for (const work of effects) work();
    };
    const refresh = () => {
        if (scheduled || destroyed) return;
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            try { render(); }
            catch (error) { errors.push(error); destroy(); }
        });
    };
    const react = {
        createElement: (type, props, child) => ({ type, props: { ...props, ...(child === undefined ? {} : { children: child }) } }),
        useRef(value) {
            const index = rendering.cursor++;
            return rendering.hooks[index] ??= { current: value };
        },
        useLayoutEffect(work, deps) {
            const index = rendering.cursor++;
            const previous = rendering.hooks[index];
            if (previous && deps && previous.deps?.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
            previous?.cleanup?.();
            const hook = rendering.hooks[index] = { deps };
            rendering.effects.push(() => { hook.cleanup = work(); });
        },
        useSyncExternalStore(subscribe, snapshot) {
            const index = rendering.cursor++;
            rendering.hooks[index] ??= { cleanup: subscribe(refresh) };
            return snapshot();
        },
    };
    return { react, Provider, errors, refresh, mount(element) { root = element; render(); },
        useAccount() {
            if (!rendering?.context) throw new Error("The bridge must have a native account provider parent.");
            return rendering.context.account;
        },
        useClient() {
            if (!rendering?.context) throw new Error("The bridge must have a native client provider parent.");
            return rendering.context.client;
        },
        destroy };
}

function browserFixture(makeClient, options = {}) {
    const protocol = new EventEmitter(), scripts = [], clients = store({ client: null }), consent = store(capabilities());
    const nativeOptions = [];
    const exposed = new Map(), frame = { url: () => url }, pageEvents = new EventEmitter(), browserEvents = new EventEmitter();
    let context, ui, renderHost, url = "about:blank", closed = false, loader = 0, customizeExecutions = 0;
    const page = {
        url: () => url, isClosed: () => closed,
        mainFrame: () => frame,
        once: (name, work) => pageEvents.once(name, work),
        async goto(next) {
            ui?.destroy();
            url = next;
            loader++;
            ui = renderer();
            const location = { origin: next === "about:blank" ? "null" : new URL(next).origin };
            const handlers = new Map();
            const window = { addEventListener: (name, work) => handlers.set(name, work) };
            window.top = window;
            for (const [name, callback] of exposed) window[name] = value => callback({ page, frame }, structuredClone(value));
            context = vm.createContext({ window, location, document: {}, crypto: { randomUUID }, Date, TextEncoder,
                AbortController, setTimeout, clearTimeout, queueMicrotask, console });
            for (const script of scripts) vm.runInContext(script, context);
            const rootAccount = { accountType: "AAD", environment: "prod", tenantId: principal.tenantId, objectId: principal.subjectId };
            const rootStore = {}, queryClient = {}, runtime = {};
            window.__TSR_ROUTER__ = { options: { context: { store: rootStore, queryClient } } };
            const appModules = { 468902: ui.react, 339248: { $K: () => rootStore }, 784501: { jE: () => queryClient },
                101912: { gr: () => runtime }, 217142: { T: () => rootAccount } };
            const app = id => { assert.ok(appModules[id], "Unknown native app module"); return appModules[id]; };
            app.m = Object.fromEntries(Object.keys(appModules).map(id => [id, true]));
            const useNativeClient = props => {
                assert.equal(props.ownsPageHooks, false);
                nativeOptions.push({ hostType: props.hostType, ring: props.ring, surface: props.surface, geo: props.geo });
                const held = ui.react.useRef(null);
                if (held.current === null) held.current = makeClient();
                ui.react.useLayoutEffect(() => {
                    clients.setState({ client: held.current });
                    return () => clients.setState({ client: null });
                }, []);
                return { realm: "prod", dataSource: { ic3LiveClient: held.current } };
            };
            const modules = { 476712: { x: useNativeClient }, 311439: { U() {} }, 857730: { V: () => ({}) },
                627524: { W: props => props.children }, 605640: { F: props => props.children },
                731677: { XJ: () => "ltr" }, 249155: { yk: value => value }, 175081: { H_: consent } };
            if (options.activeToolBridge) consent.setState({ ...capabilities(), isSimpleBrowserSupported: true });
            const cowork = id => { assert.ok(modules[id], "Unknown native module " + id); return modules[id]; };
            cowork.m = Object.fromEntries(Object.keys(modules).map(key => [key, true]));
            for (const [name, runtime] of [["rspackChunk_1js_m365_copilot_app", app], ["chunk_coworker", cowork]]) {
                for (const [, , callback] of window[name] ?? []) callback(runtime);
            }
            window.coworker = { async get(expose) {
                assert.equal(expose, "./Customize");
                return () => { customizeExecutions++; };
            } };
            if (next !== "about:blank") for (const [index, asset] of COWORK_CLIENT_ASSETS.entries()) {
                const metadata = { requestId: `script-${loader}-${index}`, type: "Script", frameId: "frame", loaderId: "loader-" + loader };
                protocol.emit("Network.requestWillBeSent", { ...metadata, request: { url: asset } });
                if (options.memoryCachedAsset === asset) protocol.emit("Network.requestServedFromCache", metadata);
                protocol.emit("Network.responseReceived", { ...metadata,
                    response: { url: asset, status: 200, fromDiskCache: options.cachedAsset === asset } });
                if (options.lateMemoryCachedAsset === asset) protocol.emit("Network.requestServedFromCache", metadata);
            }
        },
        async evaluate(work, input) {
            context.__input = input;
            const result = await vm.runInContext(`(${work.toString()})(__input)`, context);
            return structuredClone(result);
        },
    };
    frame.evaluate = (work, input) => page.evaluate(work, input);
    frame.isDetached = () => closed;
    protocol.send = async (method, input) => {
        if (method === "Fetch.enable") {
            assert.deepEqual(input, { patterns: [{ urlPattern: "*/v1/conversations/*/client-tool-*", requestStage: "Request" }] });
            return {};
        }
        if (method === "Network.setCacheDisabled") { assert.deepEqual(input, { cacheDisabled: true }); return {}; }
        assert.equal(method, "Page.getFrameTree");
        return { frameTree: { frame: { id: "frame", loaderId: "loader-" + loader } } };
    };
    protocol.detach = async () => {};
    const browser = { pages: () => closed ? [] : [page],
        browser: () => rootBrowser,
        on: (name, work) => browserEvents.on(name, work),
        once: (name, work) => browserEvents.once(name, work),
        off: (name, work) => browserEvents.off(name, work),
        async exposeBinding(name, callback) { exposed.set(name, callback); },
        async addInitScript({ content }) { scripts.push(content); },
        async newCDPSession() { return protocol; } };
    const rootBrowser = { contexts: () => [browser], newBrowserCDPSession: async () => protocol, isConnected: () => !closed };
    return { page, browser, clients, consent, nativeOptions, get customizeExecutions() { return customizeExecutions; },
        get renderErrors() { return ui?.errors ?? []; },
        updateAccount(value) { options.account = { ...options.account, ...value }; renderHost(); },
        markSourceCached() { protocol.emit("Network.requestServedFromCache", { requestId: `script-${loader}-1` }); },
        observeDocument: async () => ({ frameId: "frame", async read() { return { ...principal, knownAccountMatched: true }; }, async retire() {} }),
        async openCowork() {
            const hooks = [];
            const host = { name: "coworker-host", version: "2.9.2", loaderHook: {
                registerPlugins: {}, applyPlugin(plugin) { this.registerPlugins[plugin.name] = plugin; hooks.push(plugin); },
            } };
            for (const plugin of context.window.__FEDERATION__.__GLOBAL_PLUGIN__) hooks.push(plugin.apply(host));
            let factory;
            const event = {
                expose: "./Coworker", moduleInfo: { name: "coworker", entry: COWORK_COMPOSITION_ENTRY },
                remoteEntryExports: context.window.coworker,
            };
            for (const plugin of [...hooks]) if (plugin.getModuleFactory) factory = await plugin.getModuleFactory(event) ?? factory;
            for (const plugin of [...hooks]) await plugin.afterGetExpose?.({ ...event, moduleFactory: factory });
            assert.equal(typeof factory, "function");
            const Host = factory().FederatedCoworker;
            renderHost = () => ui.mount(ui.react.createElement(Host, {
                ...nativeAccount, ...options.account, ...options.hostProps, locale: "en-us", tokenProviders: {},
            }));
            renderHost();
        },
        close() { closed = true; ui?.destroy(); pageEvents.emit("close"); browserEvents.emit("close"); },
    };
}

test("the independent native hook preserves host-supplied values and uses only the original shell defaults", async t => {
    for (const [hostProps, expected] of [
        [{}, { hostType: "unknown", ring: "ww", surface: "app", geo: "us" }],
        [{ hostType: "teams:desktop", ring: "msit", surface: "canvas", geo: "ca" },
            { hostType: "teams:desktop", ring: "msit", surface: "canvas", geo: "ca" }],
        [{ hostType: null, ring: null, surface: null, geo: null },
            { hostType: null, ring: null, surface: null, geo: "us" }],
    ]) {
        const browser = browserFixture(() => ({
            async listTasks() { return { tasks: [task("a")], nextCursor: null }; },
            async listMessages() { return { events: [event("a")], nextCursor: null }; },
        }), { hostProps });
        const reader = await openCoworkBrowserHost({
            browser: browser.browser, page: browser.page, principal, deadline: Date.now() + 1000,
            assertOwner() {}, assertLease: async () => {}, beforeReload: async () => {},
            observeDocument: browser.observeDocument, openCowork: browser.openCowork,
            onFailure(error) { assert.fail(error.code); },
        });
        try {
            await reader.begin(Date.now() + 1000);
            assert.deepEqual(browser.nativeOptions.at(-1), expected);
            await reader.finish();
        } finally {
            const retirement = reader.retire(); browser.close(); await retirement;
        }
    }
});

for (const scenario of ["wrong-account", "cached-source", "memory-cached-source", "late-memory-cached-source", "active-tool-bridge"]) {
    test(`native bootstrap refuses ${scenario} before a client read`, async t => {
        let reads = 0;
        const browser = browserFixture(() => ({
            async listTasks() { reads++; return { tasks: [task("a")], nextCursor: null }; },
            async listMessages() { reads++; return { events: [event("a")], nextCursor: null }; },
        }), scenario === "wrong-account" ? { account: { userId: "foreign-native-account" } }
            : scenario === "active-tool-bridge" ? { activeToolBridge: true }
            : { [{ "cached-source": "cachedAsset", "memory-cached-source": "memoryCachedAsset",
                "late-memory-cached-source": "lateMemoryCachedAsset" }[scenario]]: COWORK_CLIENT_ASSETS[1] });
        t.after(() => browser.close());
        await assert.rejects(async () => {
            const reader = await openCoworkBrowserHost({
                browser: browser.browser, page: browser.page, principal, deadline: Date.now() + 1000,
                assertOwner() {}, assertLease: async () => {}, beforeReload: async () => {},
                observeDocument: browser.observeDocument, openCowork: browser.openCowork, onFailure() {},
            });
            await reader.begin(Date.now() + 1000);
        }, { code: scenario === "wrong-account" ? "NATIVE_COWORK_COMPOSITION_ACCOUNT"
            : scenario === "active-tool-bridge" ? "NATIVE_COWORK_CLIENT_READONLY_UNQUALIFIED" : "NATIVE_COWORK_BOOTSTRAP_SOURCE_UNQUALIFIED" });
        assert.equal(reads, 0);
        assert.ok(browser.renderErrors.every(error => error.code === "NATIVE_COWORK_COMPOSITION_RETIRED"));
    });
}

for (const field of ["documentId", "operationId", "instanceId"]) {
    test(`browser rejects a native return with a changed ${field} and refuses subsequent dispatch`, async t => {
        let reads = 0;
        const failures = [];
        const browser = browserFixture(() => ({
            async listTasks() { reads++; return { tasks: [task("a")], nextCursor: null }; },
            async listMessages() { assert.fail("No reads after lost association."); },
        }));
        const reader = await openCoworkBrowserHost({
            browser: browser.browser, page: browser.page, principal, deadline: Date.now() + 1000,
            assertOwner() {}, assertLease: async () => {}, beforeReload: async () => {},
            observeDocument: browser.observeDocument, openCowork: browser.openCowork,
            onFailure: error => failures.push(error.code),
        });
        t.after(async () => { const retiring = reader.retire(); browser.close(); await retiring; });
        await reader.begin(Date.now() + 1000);
        const evaluate = browser.page.evaluate;
        t.mock.method(browser.page, "evaluate", async (work, input) => {
            const value = await evaluate(work, input);
            return input?.method === "invoke" ? { ...value, [field]: randomUUID() } : value;
        });
        await assert.rejects(reader.read("listTasks", { pageSize: 200 }), { code: "NATIVE_COWORK_CLIENT_ASSOCIATION" });
        await assert.rejects(reader.read("listMessages", { sessionId: "a", pageSize: 200 }),
            { code: "NATIVE_COWORK_CLIENT_ASSOCIATION" });
        assert.equal(reads, 1);
        assert.deepEqual(failures, ["NATIVE_COWORK_CLIENT_ASSOCIATION"]);
    });
}

test("a cache notice after source admission revokes the owner before another native call", async t => {
    let reads = 0;
    const browser = browserFixture(() => ({
        async listTasks() { reads++; return { tasks: [task("a")], nextCursor: null }; },
        async listMessages() {},
    }));
    const failures = [];
    const reader = await openCoworkBrowserHost({
        browser: browser.browser, page: browser.page, principal, deadline: Date.now() + 1000,
        assertOwner() {}, assertLease: async () => {}, beforeReload: async () => {},
        observeDocument: browser.observeDocument, openCowork: browser.openCowork,
        onFailure: error => failures.push(error.code),
    });
    t.after(async () => { const retiring = reader.retire(); browser.close(); await retiring; });
    await reader.begin(Date.now() + 1000);
    browser.markSourceCached();
    await assert.rejects(reader.read("listTasks", { pageSize: 200 }), { code: "NATIVE_COWORK_BOOTSTRAP_SOURCE_UNQUALIFIED" });
    assert.equal(reads, 0);
    assert.deepEqual(failures, ["NATIVE_COWORK_BOOTSTRAP_SOURCE_UNQUALIFIED"]);
});

test("the native provider's changed account retires the bridge between reads", async t => {
    let reads = 0;
    const browser = browserFixture(() => ({
        async listTasks() { reads++; return { tasks: [task("a")], nextCursor: null }; },
        async listMessages() { assert.fail("No read under the changed account."); },
    }));
    const failures = [];
    const reader = await openCoworkBrowserHost({
        browser: browser.browser, page: browser.page, principal, deadline: Date.now() + 1000,
        assertOwner() {}, assertLease: async () => {}, beforeReload: async () => {},
        observeDocument: browser.observeDocument, openCowork: browser.openCowork,
        onFailure: error => failures.push(error.code),
    });
    t.after(async () => { const retiring = reader.retire(); browser.close(); await retiring; });
    await reader.begin(Date.now() + 1000);
    await reader.read("listTasks", { pageSize: 200 });
    assert.throws(() => browser.updateAccount({ userId: "changed-native-account" }), { code: "NATIVE_COWORK_COMPOSITION_ACCOUNT" });
    await setImmediate();
    assert.deepEqual(failures, ["NATIVE_COWORK_COMPOSITION_ACCOUNT"]);
    await assert.rejects(reader.read("listMessages", { sessionId: "a", pageSize: 200 }),
        { code: "NATIVE_COWORK_COMPOSITION_ACCOUNT" });
    assert.equal(reads, 1);
});

test("a later shell cannot adopt the client retired by an earlier cycle", async t => {
    let reads = 0;
    const client = {
        async listTasks() { reads++; return { tasks: [task("a")], nextCursor: null }; },
        async listMessages() {},
    };
    const browser = browserFixture(() => client);
    const failures = [];
    const reader = await openCoworkBrowserHost({
        browser: browser.browser, page: browser.page, principal, deadline: Date.now() + 1000,
        assertOwner() {}, assertLease: async () => {}, beforeReload: async () => {},
        observeDocument: browser.observeDocument, openCowork: browser.openCowork,
        onFailure: error => failures.push(error.code),
    });
    t.after(async () => { const retiring = reader.retire(); browser.close(); await retiring; });
    await reader.begin(Date.now() + 1000);
    await reader.finish();
    await assert.rejects(reader.begin(Date.now() + 1000), { code: "NATIVE_COWORK_CLIENT_REUSED" });
    assert.equal(reads, 0);
    assert.deepEqual(failures, ["NATIVE_COWORK_CLIENT_REUSED"]);
});

test("native browser deadline rejects ignored-signal work and closes its owner without accepting a late return", async t => {
    const pending = Promise.withResolvers(), entered = Promise.withResolvers(), failures = [];
    const browser = browserFixture(() => ({
        async listTasks() { entered.resolve(); return pending.promise; },
        async listMessages() { assert.fail("No later history call after deadline."); },
    }));
    let closing;
    const reader = await openCoworkBrowserHost({
        browser: browser.browser, page: browser.page, principal, deadline: Date.now() + 1000,
        assertOwner() {}, assertLease: async () => {}, beforeReload: async () => {},
        observeDocument: browser.observeDocument, openCowork: browser.openCowork,
        onFailure(error) {
            failures.push(error.code);
            closing ??= closeNativeBrowserContext({ close: () => browser.close() }, () => reader.retire());
        },
    });
    t.after(async () => { browser.close(); await closing; });
    await reader.begin(Date.now() + 200);
    const reading = reader.read("listTasks", { pageSize: 200 });
    const rejected = assert.rejects(reading, { code: "NATIVE_COWORK_CLIENT_DEADLINE" });
    await entered.promise;
    await rejected;
    await closing;
    assert.equal(browser.page.isClosed(), true);
    pending.resolve({ tasks: [task("late-native-task")], nextCursor: null });
    await setImmediate();
    assert.deepEqual(failures, ["NATIVE_COWORK_CLIENT_DEADLINE"]);
    await assert.rejects(reader.read("listTasks", { pageSize: 200 }));
});

function realReactRenderer() {
    const { React, createRoot, flushSync } = window.wireTestReact;
    const Account = React.createContext(null), Client = React.createContext(null);
    const RootStore = React.createContext(null), RootQuery = React.createContext(null);
    const RootRuntime = React.createContext(null), RootAccount = React.createContext(null);
    const element = document.getElementById("root") ?? document.createElement("div"), errors = [];
    element.id = "root";
    if (!element.isConnected) document.body.append(element);
    let root;
    const RootProviders = props => {
        const account = React.useSyncExternalStore(props.store.subscribe, () => props.store.getState().accountInfo);
        const [runtime, setRuntime] = React.useState(props.runtime);
        window.replaceNativeRuntime = () => flushSync(() => setRuntime({ scope: "invented-replacement-runtime" }));
        return React.createElement(RootStore.Provider, { value: props.store },
            React.createElement(RootQuery.Provider, { value: props.queryClient },
                React.createElement(RootRuntime.Provider, { value: runtime },
                    React.createElement(RootAccount.Provider, { value: account }, props.children))));
    };
    const Provider = props => {
        const [account, setAccount] = React.useState(props.account);
        window.updateNativeProviderAccount = value => flushSync(() => setAccount(previous => ({ ...previous, ...value })));
        return React.createElement(Account.Provider, { value: account },
            React.createElement(Client.Provider, { value: props.client }, props.children));
    };
    return { react: React, Provider, RootProviders, errors,
        useAccount: () => React.useContext(Account), useClient: () => React.useContext(Client),
        useRootStore: () => React.useContext(RootStore), useRootQuery: () => React.useContext(RootQuery),
        useRootRuntime: () => React.useContext(RootRuntime), useRootAccount: () => React.useContext(RootAccount),
        mount(value) {
            root ??= createRoot(element, { onUncaughtError: error => errors.push(error.code ?? error.message) });
            flushSync(() => root.render(value));
        },
        destroy: () => { if (root) flushSync(() => root.unmount()); } };
}

let reactBundle;
function testReactBundle() {
    return reactBundle ??= buildTestReactBundle();
}

async function buildTestReactBundle() {
    const result = await build({ stdin: { contents: `
        import * as React from "react";
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        window.wireTestReact = { React, createRoot, flushSync };`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
    return result.outputFiles[0].text.replaceAll("</script", "<\\/script");
}

async function loopbackCertificate() {
    // In-memory, disposable TLS identity. Nothing is installed in a trust store.
    const script = `
        $rsa = [System.Security.Cryptography.RSA]::Create(2048)
        $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
            'CN=wire-invented-loopback', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256,
            [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $cert = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1), [DateTimeOffset]::UtcNow.AddHours(1))
        @{ key = $rsa.ExportPkcs8PrivateKeyPem(); cert = $cert.ExportCertificatePem() } | ConvertTo-Json -Compress
        $cert.Dispose(); $rsa.Dispose()
    `;
    const { stdout } = await promisify(execFile)("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 15000, windowsHide: true });
    return JSON.parse(stdout);
}

async function inventedNativeApp(makeRenderer, makeStore, account, entry, sourceTime, pinnedOnly = false, remoteAssets = null) {
    let selectedHost, selectedHooks;
    if (remoteAssets) {
        selectedHooks = [];
        selectedHost = { name: "coworker-host", version: "2.9.2", moduleCache: new Map(), options: { remotes: [] }, loaderHook: {
            registerPlugins: {}, applyPlugin(plugin) { this.registerPlugins[plugin.name] = plugin; selectedHooks.push(plugin); },
        } };
        for (const plugin of window.__FEDERATION__?.__GLOBAL_PLUGIN__ ?? []) selectedHooks.push(plugin.apply(selectedHost));
        let init = { origin: selectedHost, options: selectedHost.options, shareInfo: {}, userOptions: {
            name: "coworker-host", shared: {}, remotes: [
                { name: "coworker", entry: "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/version.json" },
            ],
        } };
        for (const hook of selectedHooks) init = hook.beforeInit?.(init) ?? init;
        for (const remote of init.userOptions.remotes) {
            for (const hook of selectedHooks) hook.beforeRegisterRemote?.({ remote, origin: selectedHost });
            selectedHost.options.remotes.push(remote);
            for (const hook of selectedHooks) hook.registerRemote?.({ remote, origin: selectedHost });
        }
        const manifestUrl = selectedHost.options.remotes[0].entry;
        const response = await fetch(manifestUrl);
        if (!response.ok) throw new Error("Invented native manifest unavailable.");
        const manifest = await response.json();
        entry = new URL(manifest.metaData.remoteEntry.name, manifestUrl).href;
        await Promise.all(remoteAssets.map(relative => new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = new URL(relative, entry).href;
            script.onload = resolve; script.onerror = reject; document.head.append(script);
        })));
    }
    const ui = makeRenderer(), clients = makeStore({ client: null });
    const consent = makeStore({ isConsented: false, isEdgeIdentityMatched: false, isSimpleBrowserSupported: false });
    let toolDispatch;
    const nativeTools = {
        connect() { window.nativeToolConnections++; toolDispatch = () => { window.nativeToolCommands++; }; },
        setIdentity() { window.nativeToolConnections++; },
    };
    window.nativeCapabilitySequence = () => {
        consent.setState({ ...consent.getState(), isSimpleBrowserSupported: true });
        consent.setState({ ...consent.getState(), isConsented: true });
        consent.setState({ ...consent.getState(), isEdgeIdentityMatched: true });
        toolDispatch?.();
        return { forwarded: window.nativeToolCommands > 0, sent: window.nativeToolCommands ? ["Edge.ToolAction"] : [], flags: consent.getState() };
    };
    window.clientInvocations = [];
    window.chatDetailIds = [];
    window.revision = 1;
    window.forbiddenAppMounts = 0;
    window.nativeMounts = 0;
    window.nativeUnmounts = 0;
    const chatStore = makeStore({ accountInfo: { accountType: "AAD", environment: "prod",
        tenantId: account.tenantId, objectId: account.userId },
    featureFlags: { enableChatLandingPageHistoryStore: true },
    chatLandingPageHistoryList: { chats: [{ conversationId: "pre-enable-cached-chat" }], syncState: "old-cache" } });
    window.updateNativeChatAccount = value => chatStore.setState({ ...chatStore.getState(),
        accountInfo: { ...chatStore.getState().accountInfo, ...value } });
    const query = async ({ meta, signal }) => {
        if (!(signal instanceof AbortSignal) || meta.actionPayload.state.chatLandingPageHistoryList.chats.length) {
            throw new Error("The invented native reset must not reuse cached history.");
        }
        window.clientInvocations.push("listChats");
        const pinnedId = pinnedOnly ? "pinned-only" : "invented-pinned";
        return { chatLandingPageHistoryList: { chats: pinnedOnly ? [] : [{ conversationId: "invented-chat", updateTimeUtc: "2020-01-01T00:00:00.000Z" }], syncState: "" },
            pinnedChatIds: { [pinnedId]: 1 }, pinnedChats: [{ conversationId: pinnedId }] };
    };
    const nativeDetail = async ({ data, signal, ...options }) => {
        if (!(signal instanceof AbortSignal) || Object.keys(options).length) throw new Error("Native middleware owns detail options.");
        window.clientInvocations.push("readConversation");
        window.chatDetailIds.push(data.conversationId);
        if (window.holdNextMessages) { window.heldReadStarted = true; return new Promise(() => {}); }
        const id = data.conversationId, revision = window.revision, createdAt = new Date(sourceTime).toISOString();
        return { store: { rawConversationResponse: { conversationId: id, requestId: "native-request-" + id,
            messages: [
                { messageId: `message-${id}-${revision}`, author: "user", text: "Invented Chat revision " + revision, createdAt },
                { messageId: `tool-${id}-${revision}`, storageMessageId: `storage-${id}-${revision}`, author: "bot",
                    messageType: "Progress", createdAt, invocation: JSON.stringify([{ id: `call-${id}-${revision}`, type: "function",
                        function: { name: "invented_lookup", arguments: { query: "Invented tool input" } } }]),
                    error: "UNQUALIFIED_CHAT_ERROR_NOT_RETAINED" },
            ] } } };
    };
    const queryClient = { getDefaultOptions: () => ({ queries: { queryFn: query } }),
        fetchQuery() { throw new Error("No query-cache reads."); } };
    const rootRuntime = Object.freeze({ scope: "invented-native-runtime" });
    const rootProps = { store: chatStore, queryClient, runtime: rootRuntime };
    const rootRoute = { id: "__root__" };
    const chatRoute = { id: "/_sharedChatSetup/chat/", options: { component: () => null },
        update(options) { this.options = { ...this.options, ...options }; } };
    const nativeRouter = {
        options: { context: { store: chatStore, queryClient } },
        routesById: { "/_sharedChatSetup/chat_/all": { options: { loader() { throw new Error("No full route updater."); } } } },
        getMatchedRoutes() { return [[rootRoute, chatRoute]]; },
        subscribe(name) { if (name !== "onBeforeNavigate") throw new Error("Unexpected router subscription."); return () => {}; },
    };
    window.__TSR_ROUTER__ = nativeRouter;
    window.unmountNativeRoot = () => ui.destroy();
    window.nativeRootReferences = () => ({ router: window.__TSR_ROUTER__ === nativeRouter,
        store: nativeRouter.options.context.store === chatStore, query: nativeRouter.options.context.queryClient === queryClient });
    const useNativeClient = props => {
        if (props.ownsPageHooks !== false) {
            nativeTools.setIdentity();
            throw new Error("The original independent-client option is required.");
        }
        const held = ui.react.useRef(null);
        if (held.current === null) held.current = {
            async listTasks(args) {
                window.clientInvocations.push("listTasks");
                return { tasks: [{ sessionId: "invented-history", ic3ThreadId: "invented-thread",
                    lastActivity: sourceTime }], nextCursor: null };
            },
            async listMessages(args) {
                window.clientInvocations.push("listMessages");
                if (window.failNextMessages) throw Object.assign(new Error("Invented native read failure"), { code: "NATIVE_SOURCE_READ_FAILED" });
                if (window.holdNextMessages) {
                    window.heldReadStarted = true;
                    return new Promise(() => {});
                }
                return { events: [{ id: "invented-event-" + window.revision, event: "u",
                    data: { ts: sourceTime, t: "Invented normal collection " + window.revision } }], nextCursor: null };
            },
        };
        ui.react.useLayoutEffect(() => {
            window.nativeMounts++;
            clients.setState({ client: held.current });
            return () => { window.nativeUnmounts++; clients.setState({ client: null }); };
        }, []);
        return { realm: "prod", dataSource: { ic3LiveClient: held.current } };
    };
    window.nativeToolConnections = 0;
    window.nativeToolCommands = 0;
    const modules = { 476712: { x: useNativeClient }, 311439: { U() {} }, 857730: { V: () => ({}) },
        627524: { W: props => props.children }, 605640: { F: props => props.children },
        731677: { XJ: () => "ltr" }, 249155: { yk: value => value }, 175081: { H_: consent },
        238873: { S() { nativeTools.connect(); throw new Error("The tool-connecting shell must not mount."); } } };
    const app = id => {
        if (id === 468902) return ui.react;
        if (id === 806101) return { f({ action, payload }) {
            if (action !== "GetConversationPageHistoryList") throw new Error("Only the native All-chats read.");
            return { queryKey: ["/chat", action], meta: { actionPayload: payload } };
        } };
        if (id === 551945) return { o: nativeDetail };
        if (id === 339248) return { $K: ui.useRootStore };
        if (id === 784501) return { jE: ui.useRootQuery };
        if (id === 101912) return { gr: ui.useRootRuntime };
        if (id === 217142) return { T: ui.useRootAccount };
        throw new Error("Unexpected app module");
    };
    app.m = { 468902: true, 806101: true, 551945: true, 339248: true, 784501: true, 101912: true, 217142: true };
    const cowork = id => {
        if (!modules[id]) throw new Error("Unexpected Cowork module");
        return modules[id];
    };
    cowork.m = Object.fromEntries(Object.keys(modules).map(key => [key, true]));
    if (window.inventedAmbientTools === "prepare") delete cowork.m[476712];
    for (const [name, runtime] of [["rspackChunk_1js_m365_copilot_app", app], ["chunk_coworker", cowork]]) {
        for (const [, , callback] of window[name] ?? []) callback(runtime);
    }
    window.nativeDependencyLoads = 0;
    window.coworker = { async get(expose) {
        if (expose === "./CoworkNav") return () => ({ CoworkNavEntry: () => null });
        if (expose !== "./Customize") throw new Error("Unexpected native exposure");
        window.nativeDependencyLoads++;
        cowork.m[476712] = true;
        return () => { window.forbiddenAppMounts++; };
    } };
    window.prepareAmbientCowork = async () => {
        window.bridgeMissingAtAmbient = !Object.hasOwn(cowork.m, 476712);
        const host = selectedHost ?? { name: "invented-other-native-host", version: "2.9.2" };
        const event = { expose: "./CoworkNav", moduleInfo: { name: "coworker", entry }, remoteEntryExports: window.coworker };
        const hooks = selectedHooks ?? (window.__FEDERATION__?.__GLOBAL_PLUGIN__ ?? []).map(plugin => plugin.apply(host));
        let factory;
        for (const plugin of hooks) factory = await plugin.getModuleFactory?.(event) ?? factory;
        factory ??= await window.coworker.get(event.expose);
        for (const plugin of hooks) await plugin.afterGetExpose?.({ ...event, moduleFactory: factory });
        factory();
        // This is deliberately outside the selected Cowork composition path.
        window.ambientGuardPrepared = true;
    };
    if (window.inventedAmbientTools) void window.prepareAmbientCowork().then(() => {
        if (window.inventedAmbientTools !== "attack") return;
        const result = window.nativeCapabilitySequence();
        void window.reportInventedToolAttempt(result);
        void Promise.allSettled(["heartbeat", "results", "consent"].map(kind =>
            fetch("/v1/conversations/invented/client-tool-" + kind, { method: "POST", body: "{}" })));
    });
    // The original native bootstrap publishes the router before its first
    // asynchronous React mount; the read host must compose before that mount.
    queueMicrotask(() => ui.mount(ui.react.createElement(ui.RootProviders, rootProps,
        ui.react.createElement(chatRoute.options.component))));
    document.querySelector("a").onclick = async event => {
        event.preventDefault();
        history.pushState(null, "", "/cowork");
        const hooks = selectedHooks ?? [];
        const host = selectedHost ?? { name: "coworker-host", version: "2.9.2", loaderHook: {
            registerPlugins: {}, applyPlugin(plugin) { this.registerPlugins[plugin.name] = plugin; hooks.push(plugin); },
        } };
        if (!selectedHooks) for (const plugin of window.__FEDERATION__.__GLOBAL_PLUGIN__) hooks.push(plugin.apply(host));
        let factory;
        const load = {
            expose: "./Coworker", moduleInfo: { name: "coworker", entry }, remoteEntryExports: window.coworker,
        };
        for (const plugin of [...hooks]) if (plugin.getModuleFactory) factory = await plugin.getModuleFactory(load) ?? factory;
        for (const plugin of [...hooks]) await plugin.afterGetExpose?.({ ...load, moduleFactory: factory });
        if (!factory) throw new Error("No read-host factory");
        const Host = factory().FederatedCoworker;
        ui.mount(ui.react.createElement(ui.RootProviders, rootProps,
            ui.react.createElement(Host, { ...account, locale: "en-us", tokenProviders: {} })));
        window.updateNativeHostAccount = value => {
            ui.mount(ui.react.createElement(ui.RootProviders, rootProps,
                ui.react.createElement(Host, { ...account, ...value, locale: "en-us", tokenProviders: {} })));
        };
        window.updateNativeProviderAccount = value => window.updateNativeHostAccount(value);
    };
}

for (const { surfaces, cacheable, pinnedOnly = false, disposeRoot = false, ctiProtocol = false, launcher = null } of [
    { surfaces: ["cowork"], cacheable: false }, { surfaces: ["cowork"], cacheable: true },
    { surfaces: ["chat"], cacheable: true }, { surfaces: ["chat", "cowork"], cacheable: true },
    { surfaces: ["chat"], cacheable: true, pinnedOnly: true },
    { surfaces: ["chat"], cacheable: true, disposeRoot: true },
    { surfaces: ["cowork"], cacheable: true, disposeRoot: true },
    { surfaces: ["chat"], cacheable: true, disposeRoot: "runtime" },
    { surfaces: ["cowork"], cacheable: true, ctiProtocol: true },
    { surfaces: ["cowork"], cacheable: true, ctiProtocol: "sequential" },
    { surfaces: ["cowork"], cacheable: true, ctiProtocol: "denial-unconfirmed" },
    { surfaces: ["chat"], cacheable: true, ctiProtocol: "sequential" },
    ...["manual", "automatic", "failure", "logout", "connect-boundary", "connect-early", "connect-protocol", "connect-handoff", "connect-popup",
        "connect-immediate-popup", "connect-immediate-frame"]
        .map(launcher => ({ surfaces: ["cowork"], cacheable: true, launcher })),
]) test(`${launcher ? `development launcher ${launcher} Settings collection` : `automatic first ${surfaces.map(surface => surface === "chat" ? "Chat" : "Cowork").join("+")} Enable`} uses real React, normal collection and ${cacheable ? "unrouted cacheable HTTPS assets" : "invented routed assets"}${pinnedOnly ? " (pinned-only)" : ""}${disposeRoot ? ` (provider ${disposeRoot === "runtime" ? "replacement" : "disposal"})` : ""}${ctiProtocol ? ` (CTI protocol refusal ${ctiProtocol})` : ""}`,
    { timeout: 60000 }, async t => {
    const hasChat = surfaces.includes("chat"), hasCowork = surfaces.includes("cowork");
    const assets = hasCowork ? COWORK_CLIENT_ASSETS : CHAT_CLIENT_ASSETS;
    const cleanups = [], { context } = await privateFixture({ after: work => cleanups.push(work) }, []);
    const reactScript = await testReactBundle(), sourceTime = Date.now() - 1000;
    const requests = new Map(), cached = [], unexpected = [], cacheControls = [], ownerDeadlines = [], manifests = [];
    let ctiReached = 0, protocolDenials = 0, isolatedFrames = 0;
    const earlyAttempts = [];
    const content = url => {
        if (url === COWORK_COMPOSITION_MANIFEST || url === "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/version.json") {
            manifests.push(url);
            return { status: 200, contentType: "application/json", headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
                body: JSON.stringify({ metaData: { publicPath: "auto", remoteEntry: {
                    name: url === COWORK_COMPOSITION_MANIFEST ? "coworker.8d98ec00.js" : "coworker.73f67e44.js", path: "", type: "var",
                } } }) };
        }
        if (new URL(url).pathname.startsWith("/v1/conversations/") && new URL(url).pathname.includes("/client-tool-")) {
            ctiReached++;
            return { status: 200, headers: {}, body: "{}" };
        }
        if (new URL(url).pathname === "/fixture-safe-init") return { status: 200, headers: {}, body: "allowed fixture read" };
        if (url === "https://copilot.cloud.microsoft/fixture-immediate-tool") return {
            status: 200, contentType: "text/html", headers: { "cache-control": "no-store" },
            body: `<html><head><script>
                fetch("/v1/conversations/invented/client-tool-heartbeat", {method:"POST",body:"{}"}).catch(()=>{});
                </script></head><body>Invented first-script request, without a native factory.</body></html>`,
        };
        if (assets.includes(url)) {
            requests.set(url, (requests.get(url) ?? 0) + 1);
            return { status: 200, contentType: "application/javascript",
                headers: { "cache-control": cacheable ? "public, max-age=31536000, immutable" : "no-store",
                    etag: '"invented-cohort"' }, body: "/* Invented dependency witness, not Microsoft code. */" };
        }
        if (["https://m365.cloud.microsoft/chat", "https://copilot.cloud.microsoft/chat"].includes(url)) {
            const bootstrap = { initialized: true, router: { dehydratedData: { copilotBootstrap: { loaderData: {
                root: { store: { accountInfo: { accountType: "AAD", environment: "prod",
                    tenantId: principal.tenantId, objectId: principal.subjectId } } },
            } } } } };
            return { status: 200, contentType: "text/html", headers: { "cache-control": "no-store" },
                body: `<html><head>${assets.filter(asset => launcher !== "connect-handoff" || !asset.includes("/s01-copilotstudio/"))
                    .map(asset => `<script src="${asset}"></script>`).join("")}</head>
                    <body><a href="/cowork">Cowork</a><script>${reactScript}</script><script>
                    ${launcher === "connect-early" ? "" : `window.$_TSR=${JSON.stringify(bootstrap)};`}
                    window.inventedAmbientTools=${JSON.stringify(launcher === "connect-early" ? "attack"
                        : launcher === "connect-handoff" ? "prepare" : null)};
                    (${inventedNativeApp.toString()})(${realReactRenderer.toString()},${store.toString()},
                        ${JSON.stringify(nativeAccount)},${JSON.stringify(COWORK_COMPOSITION_ENTRY)},${sourceTime},${pinnedOnly},
                        ${JSON.stringify(launcher === "connect-handoff" ? assets.filter(asset => asset.includes("/s01-copilotstudio/"))
                            .map(asset => asset.slice(COWORK_COMPOSITION_ENTRY.lastIndexOf("/") + 1)) : null)});
                    </script></body></html>` };
        }
        if (new URL(url).pathname === "/favicon.ico") return { status: 204, headers: {}, body: "" };
        throw new Error("Unexpected invented-browser request.");
    };
    let https, browser, owned, host, runtime, launcherStop, launcherUi, uiBrowser;
    t.after(async () => {
        try { await launcherUi?.close(); await launcherStop?.(); await host?.close(); }
        finally {
            try { await runtime?.close(); }
            finally {
                await browser?.close();
                await uiBrowser?.close();
                if (https?.listening) { https.closeAllConnections(); await new Promise(resolve => https.close(resolve)); }
                for (const work of cleanups) await work();
                assert.deepEqual(unexpected, []);
            }
        }
    });
    const args = ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"];
    if (launcher === "connect-immediate-frame") args.push("--isolate-origins=https://copilot.cloud.microsoft");
    if (cacheable) {
        const certificate = await loopbackCertificate();
        https = createHttpsServer(certificate, (req, res) => {
            try {
                const response = content("https://" + req.headers.host + req.url);
                res.writeHead(response.status, { ...response.headers, "content-type": response.contentType ?? "text/plain" });
                res.end(response.body);
            } catch (error) { unexpected.push(error.message); res.writeHead(404); res.end(); }
        });
        https.listen(0, "127.0.0.1");
        await once(https, "listening");
        const domains = new Set(COWORK_CLIENT_ASSETS.map(url => new URL(url).hostname));
        domains.add("m365.cloud.microsoft"); domains.add("copilot.cloud.microsoft");
        args[0] = "--host-resolver-rules=" + [...domains].map(host => `MAP ${host} 127.0.0.1:${https.address().port}`)
            .concat("MAP * ~NOTFOUND", "EXCLUDE localhost", "EXCLUDE 127.0.0.1").join(", ");
        args.push("--proxy-server=direct://", "--proxy-bypass-list=*",
            "--ignore-certificate-errors-spki-list=" + createHash("sha256")
                .update(createPublicKey(certificate.key).export({ type: "spki", format: "der" })).digest("base64"));
    }
    browser = await chromium.launch({ channel: "msedge", headless: true, chromiumSandbox: true,
        args });
    const createRootProtocol = browser.newBrowserCDPSession.bind(browser);
    t.mock.method(browser, "newBrowserCDPSession", async () => {
        const protocol = await createRootProtocol(), send = protocol.send.bind(protocol), detach = protocol.detach.bind(protocol);
        t.mock.method(protocol, "send", async (method, input) => {
            assert.ok(!["Target.setAutoAttach", "Target.attachToTarget", "Target.sendMessageToTarget"].includes(method),
                "The HTTP fence must not depend on a second debugger winning a startup race.");
            if (method === "Fetch.enable") {
                assert.deepEqual(input, { patterns: [
                    { urlPattern: "*/v1/conversations/*/client-tool-*", requestStage: "Request" },
                ] });
                if (launcher?.startsWith("connect-immediate-")) await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (method === "Fetch.failRequest") protocolDenials++;
            if (method === "Fetch.failRequest" && ctiProtocol === "denial-unconfirmed") {
                throw new Error("Invented unconfirmed protocol acknowledgement");
            }
            return send(method, input);
        });
        t.mock.method(protocol, "detach", () => {
            assert.equal(owned.pages().length, 0, "A browser fence cannot detach before its owned context closes.");
            return detach();
        });
        if (launcher === "connect-immediate-frame") {
            protocol.on("Target.targetCreated", event => { if (event.targetInfo.type === "iframe") isolatedFrames++; });
            await protocol.send("Target.setDiscoverTargets", { discover: true, filter: [{ type: "iframe" }, { exclude: true }] });
        }
        return protocol;
    });
    const settled = [];
    t.mock.method(console, "info", (message, value) => {
        if (message === "[workiq-native] native client read settled") settled.push(JSON.parse(value));
    });
    t.mock.method(chromium, "launchPersistentContext", async (_directory, options) => {
        assert.deepEqual(options.args, ["--disable-extensions", "--disable-component-extensions-with-background-pages"]);
        owned = await browser.newContext({ serviceWorkers: "block" });
        if (launcher === "connect-early") await owned.exposeFunction("reportInventedToolAttempt", value => earlyAttempts.push(value));
        if (launcher === "failure") await owned.addInitScript(() => { window.failNextMessages = true; });
        if (launcher === "logout") await owned.addInitScript(() => { window.holdNextMessages = true; });
        if (launcher) {
            const addInitScript = owned.addInitScript.bind(owned);
            t.mock.method(owned, "addInitScript", async script => {
                const deadline = /"ownerDeadline":(\d+)/.exec(script?.content ?? "");
                if (deadline) ownerDeadlines.push(Number(deadline[1]));
                return addInitScript(script);
            });
        }
        await owned.newPage();
        if (!cacheable) await owned.route("**/*", route => route.fulfill(content(route.request().url())));
        else {
            t.mock.method(owned, "route", () => assert.fail("Routing would disable the HTTP-cache regression."));
            t.mock.method(owned, "routeWebSocket", () => assert.fail("No broad collection interception."));
        }
        const createProtocol = owned.newCDPSession.bind(owned);
        t.mock.method(owned, "newCDPSession", async page => {
            const protocol = await createProtocol(page), send = protocol.send.bind(protocol), detach = protocol.detach.bind(protocol);
            let protectsTools = false;
            t.mock.method(protocol, "detach", async () => {
                if (protectsTools) assert.ok(page.isClosed(), "A paused protocol request must not be released by detaching a live target.");
                return detach();
            });
            const cachedRequests = new Set();
            protocol.on("Network.requestServedFromCache", event => cachedRequests.add(event.requestId));
            protocol.on("Network.responseReceived", event => {
                if (assets.includes(event.response.url)
                    && (event.response.fromDiskCache || cachedRequests.has(event.requestId))) cached.push(event.response.url);
            });
            let bounds = { left: 0, top: 0, width: 900, height: 700, windowState: "normal" };
            t.mock.method(protocol, "send", async (method, input) => {
                if (launcher?.startsWith("connect-immediate-") && page !== owned.pages()[0] && method === "Fetch.enable") {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (method === "Fetch.enable") protectsTools = true;
                if (protectsTools && method === "Fetch.disable") assert.fail("The protocol denial stays active until target closure.");
                if (method === "Fetch.failRequest" && ctiProtocol === "denial-unconfirmed") {
                    throw new Error("Invented unconfirmed protocol acknowledgement");
                }
                if (method === "Network.setCacheDisabled") cacheControls.push(input.cacheDisabled);
                if (method === "Browser.getWindowForTarget") return { windowId: 1, bounds: { ...bounds } };
                if (method === "Browser.setWindowBounds") { bounds = { ...bounds, ...input.bounds }; return {}; }
                return send(method, input);
            });
            return protocol;
        });
        return owned;
    });
    if (launcher) {
        const originalArgv = process.argv, originalOnce = process.once.bind(process);
        const environment = { WORKIQ_EVIDENCE_DATA_DIR: context.dataDir,
            COPILOT_HOME: context.dataDir + "\\empty-copilot", GH_CONFIG_DIR: context.dataDir + "\\empty-github",
            GH_TOKEN: "", GITHUB_TOKEN: "", GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "" };
        const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
        Object.assign(process.env, environment);
        t.after(() => {
            process.argv = originalArgv;
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key]; else process.env[key] = value;
            }
        });
        const stops = new Map(), startup = [], nativeTimers = [], timeout = globalThis.setTimeout;
        t.mock.method(process, "once", (name, work) => {
            if (["SIGINT", "SIGTERM", "disconnect"].includes(name)) { stops.set(name, work); return process; }
            return originalOnce(name, work);
        });
        t.mock.method(globalThis, "setTimeout", (work, ms, ...args) => {
            if (/at schedule \(.*runtime-access\.mjs:/.test(new Error().stack)) nativeTimers.push(ms);
            return timeout(work, ms, ...args);
        });
        t.mock.method(console, "log", message => startup.push(message));
        process.argv = [process.execPath, "scripts\\start.mjs", "--port", "0", "--development-microsoft",
            ...(launcher === "automatic" ? [] : ["--microsoft-manual-collection"])];
        // Execute the actual launcher/parser; only its external browser and
        // process signal delivery use the owned test fixture.
        await import(`../scripts/start.mjs?fixture=${randomUUID()}`);
        process.once.mock.restore();
        launcherStop = stops.get("SIGINT");
        assert.equal(typeof launcherStop, "function");
        const url = /ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(startup.join("\n"))?.[1];
        assert.ok(url, startup.join("\n"));
        assert.equal(startup.some(line => line.includes("Automatic collection is off")), true);
        uiBrowser = await chromium.launch({ channel: "msedge", headless: true, chromiumSandbox: true, args });
        const ui = launcherUi = await uiBrowser.newContext(), page = await ui.newPage();
        const requests = [], replies = [], readbacks = [];
        page.on("request", request => {
            if (request.url().endsWith("/api/collection/microsoft/now")) requests.push(request.postDataJSON());
        });
        page.on("response", response => {
            if (response.url().endsWith("/api/collection/microsoft/now")) replies.push(response.status());
            if (response.url().endsWith("/api/retained/microsoft/readback")) readbacks.push({
                operationId: response.request().postDataJSON().operationId, status: response.status() });
        });
        await page.goto(url + "#settings?section=connection");
        await expect(page.locator("#wireMicrosoftPrepare")).toBeEnabled();
        await page.locator("#wireMicrosoftPrepare").click();
        if (launcher === "connect-early") {
            await expect.poll(() => earlyAttempts.length).toBe(1);
            assert.equal(earlyAttempts[0].forwarded, false);
            assert.deepEqual(earlyAttempts[0].sent, []);
            await expect.poll(() => owned.pages().length).toBe(0);
            assert.equal(ctiReached, 0);
            assert.deepEqual(ownerDeadlines, []);
            assert.deepEqual(nativeTimers, []);
            assert.deepEqual((await loadBoardState(context, { readOnly: true })).nativeRetention?.receipts ?? [], []);
            await page.locator("#wireAccountTrigger").click();
            await page.locator("#wireAccountGate").click();
            await expect(page.locator("#accessShell")).toBeVisible();
            await ui.close(); launcherUi = null;
            await launcherStop(); launcherStop = null;
            return;
        }
        await expect(page.locator("#sourceMicrosoftSurfaces")).toBeEnabled();
        if (launcher?.startsWith("connect-immediate-")) {
            await owned.pages()[0].evaluate(frame => {
                const url = "https://copilot.cloud.microsoft/fixture-immediate-tool";
                if (!frame) { window.open(url); return; }
                const child = document.createElement("iframe");
                child.src = url; document.body.append(child);
            }, launcher.endsWith("-frame"));
            await expect.poll(() => ctiReached > 0 || owned.pages().length === 0).toBe(true);
            assert.equal(ctiReached, 0, "The first inline script must not outrun the known HTTP-family fence.");
            assert.equal(protocolDenials, 1, "The first inline request must actually reach the browser-wide refusal.");
            if (launcher.endsWith("-frame")) assert.ok(isolatedFrames > 0, "Exercise a distinct out-of-process frame target.");
            await expect.poll(() => owned.pages().length).toBe(0);
            assert.deepEqual(ownerDeadlines, []);
            assert.deepEqual((await loadBoardState(context, { readOnly: true })).nativeRetention?.receipts ?? [], []);
            await page.locator("#wireAccountTrigger").click();
            await page.locator("#wireAccountGate").click();
            await expect(page.locator("#accessShell")).toBeVisible();
            await ui.close(); launcherUi = null;
            await launcherStop(); launcherStop = null;
            return;
        }
        if (["connect-boundary", "connect-protocol", "connect-popup"].includes(launcher)) {
            let native = owned.pages()[0];
            assert.deepEqual(ownerDeadlines, [], "The collection bootstrap has not been installed during Connect.");
            if (launcher === "connect-popup") {
                const opened = owned.waitForEvent("page");
                await native.evaluate(() => window.open("https://copilot.cloud.microsoft/chat"));
                native = await opened;
                await native.waitForFunction(() => typeof window.prepareAmbientCowork === "function");
            }
            assert.deepEqual(await native.evaluate(() => Promise.all(["GET", "POST"].map(method =>
                fetch("/fixture-safe-init", { method }).then(response => response.status)))), [200, 200]);
            if (launcher !== "connect-protocol") await native.evaluate(() => window.prepareAmbientCowork());
            const observed = await native.evaluate(invoke => {
                const invoked = invoke ? window.nativeCapabilitySequence() : null;
                void fetch("/v1/conversations/invented/client-tool-heartbeat",
                    { method: "POST", body: "{}" }).catch(() => {});
                return { invoked,
                    collectionControl: Object.getOwnPropertyNames(window).some(name => name.startsWith("__wireCoworkReader_")) };
            }, launcher !== "connect-protocol");
            // Connect remains metadata-only, but its denial-only owner is live.
            // This port and receiver are invented and hold no extension.
            assert.equal(observed.collectionControl, false);
            if (observed.invoked) {
                assert.equal(observed.invoked.forwarded, false);
                assert.deepEqual(observed.invoked.sent, []);
            }
            await expect.poll(() => owned.pages().length).toBe(0);
            assert.equal(ctiReached, 0);
            assert.deepEqual(nativeTimers, []);
            assert.deepEqual((await loadBoardState(context, { readOnly: true })).nativeRetention?.receipts ?? [], []);
            await page.locator("#wireAccountTrigger").click();
            await page.locator("#wireAccountGate").click();
            await expect(page.locator("#accessShell")).toBeVisible();
            await expect.poll(() => owned.pages().length).toBe(0);
            await ui.close(); launcherUi = null;
            await launcherStop(); launcherStop = null;
            return;
        }
        if (launcher === "connect-handoff") {
            await owned.pages()[0].waitForFunction(() => window.ambientGuardPrepared);
            assert.deepEqual(await owned.pages()[0].evaluate(() => ({
                missing: window.bridgeMissingAtAmbient, loads: window.nativeDependencyLoads,
                providers: window.nativeMounts, customize: window.forbiddenAppMounts, toolConnections: window.nativeToolConnections,
            })), { missing: true, loads: 1, providers: 0, customize: 0, toolConnections: 0 });
            assert.deepEqual(ownerDeadlines, [], "Ambient execution denial must not mount an account-bound reader.");
            assert.deepEqual(manifests, [COWORK_COMPOSITION_MANIFEST], "Connect must select the reviewed manifest before any moving-latest load.");
        }
        await selectActivityOption(page, "sourceMicrosoftSurfaces", "cowork");
        await selectActivityOption(page, "sourceMicrosoftWindow", "30");
        const enableAt = Date.now();
        await page.locator("#saveMicrosoftCollection").click();
        if (launcher !== "automatic") await expect(page.locator("#collectMicrosoftActivity")).toBeEnabled();
        const receipts = async () => (await loadBoardState(context, { readOnly: true })).nativeRetention?.receipts ?? [];
        if (launcher !== "automatic") {
            assert.deepEqual(await receipts(), []);
            assert.deepEqual(nativeTimers, [], "Manual mode must not install a native timer, even on Enable.");
            await new Promise(resolve => timeout(resolve, 250));
            const gestureAt = Date.now();
            await page.locator("#collectMicrosoftActivity").click();
            await expect.poll(() => requests.length).toBe(1);
            assert.equal(requests[0].deadline > enableAt + 300000, true, "The deadline belongs to Collect, not earlier Enable.");
            assert.ok(requests[0].deadline >= gestureAt + 300000 && requests[0].deadline <= Date.now() + 300000);
            if (launcher === "logout") {
                await owned.pages()[0].waitForFunction(() => window.heldReadStarted);
                await page.locator("#wireAccountTrigger").click();
                await page.locator("#wireAccountGate").click();
                await expect(page.locator("#accessShell")).toBeVisible();
            }
            await expect.poll(() => replies.length, { timeout: 15000 }).toBe(1);
            await expect.poll(async () => (await receipts()).length).toBe(1);
            if (["manual", "connect-handoff"].includes(launcher)) await expect.poll(async () =>
                (await receipts()).find(receipt => receipt.operationId === requests[0].operationId)?.status).toBe("committed");
            const receipt = (await receipts())[0];
            assert.equal(receipt.operationId, requests[0].operationId);
            assert.deepEqual(ownerDeadlines, [requests[0].deadline], "Initialization and reads share the original Collect deadline.");
            if (["manual", "connect-handoff"].includes(launcher)) {
                assert.equal(receipt.status, "committed");
                await expect.poll(() => settled.length).toBe(1);
                assert.equal(settled[0].sourceComparison.status, "matched");
                assert.equal(await owned.pages()[0].evaluate(() => window.nativeToolConnections), 0);
                if (launcher === "connect-handoff") assert.deepEqual(manifests, [COWORK_COMPOSITION_MANIFEST, COWORK_COMPOSITION_MANIFEST],
                    "Collection reload must retain the same native version selection.");
                await expect.poll(() => readbacks).toEqual([{ operationId: receipt.operationId, status: 200 }]);
                await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Enabled");
            } else {
                assert.notEqual(receipt.status, "committed");
                assert.notEqual(replies[0], 200);
            }
            assert.deepEqual(nativeTimers, [], "Completion/failure cannot schedule a later native cycle.");
        } else {
            await expect(page.locator("#collectMicrosoftActivity")).toBeEnabled();
            assert.deepEqual(await receipts(), []);
            assert.deepEqual(requests, []);
            assert.deepEqual(nativeTimers, [], "Development opt-in without the old manual flag must not auto-resume acquisition.");
        }
        if (["manual", "connect-handoff", "automatic"].includes(launcher)) {
            await page.locator("#pauseMicrosoftCollection").click();
            await expect(page.locator("#pauseMicrosoftCollection")).toHaveText("Resume collection");
        }
        if (launcher !== "logout") {
            await page.locator("#wireAccountTrigger").click();
            await page.locator("#wireAccountGate").click();
        }
        await expect(page.locator("#accessShell")).toBeVisible();
        await expect.poll(() => owned.pages().length).toBe(0);
        assert.equal((await receipts()).length, launcher === "automatic" ? 0 : 1);
        await ui.close();
        launcherUi = null;
        await launcherStop();
        launcherStop = null;
        assert.equal((await receipts()).length, launcher === "automatic" ? 0 : 1);
        return;
    }
    host = await createMicrosoftNativeHost(context, { sourceAware: true, ordinaryStartup: true });
    runtime = await startServer(context, createExportController(context), { port: 0, access: host.access, collector: { timers: false } });
    const admission = { owner: "invented-ordinary-cowork-owner", check() {}, dispatched() {} };
    const enrollment = await host.access.nativeEnrollmentStatus(admission);
    await host.access.prepareNativeEnrollment({ schemaVersion: 2, generation: enrollment.generation, operationId: randomUUID() }, admission);
    const connect = await host.access.command(admission.owner, { schemaVersion: 1, action: "microsoft-connect",
        operationId: randomUUID(), generation: (await host.access.status()).generation }, () => true);
    assert.equal(connect.outcome, "completed");
    assert.deepEqual(cacheControls, [], "Ordinary Connect keeps its native cache policy.");
    if (cacheable) assert.ok(assets.every(asset => requests.get(asset) === 1));
    const global = await host.access.globalCollectionControl(admission);
    await host.access.setGlobalCollectionEnabled({ schemaVersion: 1, enabled: true,
        generation: global.generation, authorizationRevision: global.authorizationRevision,
        expectedRevision: global.globalCollection?.revision ?? null }, admission);
    const offer = await host.access.nativeConfigurationOffer(admission);
    await host.access.configureNativeIntent({ schemaVersion: 2, intent: offer.intent, generation: offer.generation,
        authorizationRevision: offer.authorizationRevision, expectedRevision: offer.expectedRevision,
        globalRevision: offer.globalRevision, surfaces, windowDays: 7 }, admission);
    for (const revision of [1, 2]) {
        if (revision === 1) {
            for (let attempt = 0; attempt < 300 && !settled.some(row => row.sourceComparison?.status === "matched"); attempt++) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.ok(settled.some(row => row.sourceComparison?.status === "matched"),
                `First Enable must automatically commit through the runtime scheduler; cached witnesses: ${cached.length}.`);
            await setImmediate();
            assert.equal((await loadBoardState(context, { readOnly: true })).nativeRetention.receipts.at(-1).status, "committed");
            if (cacheable) {
                assert.equal(cached.length, 0);
                assert.deepEqual(cacheControls, [true]);
                assert.ok(assets.every(asset => requests.get(asset) === 2),
                    "Enable reacquires fresh script witnesses rather than adopting Connect's cache.");
            }
        } else {
            await owned.pages()[0].evaluate(() => { window.revision = 2; });
            const receipt = await host.access.collectNativeNow({ operationId: randomUUID() }, admission);
            assert.equal(receipt.status, "committed");
        }
        assert.equal(settled.at(-1).sourceComparison.status, "matched");
        assert.equal(settled.at(-1).nativeSource.producer, "m365-native-client-return-v1");
        assert.deepEqual(settled.at(-1).nativeSource.counts, { eligible: (hasChat ? pinnedOnly ? 2 : 4 : 0) + (hasCowork ? 1 : 0), outside: 0, unqualified: 0 });
    }
    const cycleMethods = [...(hasChat ? ["listChats", "readConversation", ...(pinnedOnly ? [] : ["readConversation"])] : []),
        ...(hasCowork ? ["listTasks", "listMessages"] : [])];
    assert.deepEqual(await owned.pages()[0].evaluate(() => ({
        invoked: window.clientInvocations, nativeMounts: window.nativeMounts, nativeUnmounts: window.nativeUnmounts,
        appMounts: window.forbiddenAppMounts, reactVersion: window.wireTestReact.React.version,
    })), { invoked: [...cycleMethods, ...cycleMethods], nativeMounts: hasCowork ? 2 : 0, nativeUnmounts: hasCowork ? 2 : 0,
        appMounts: 0, reactVersion: "19.3.1" });
    const committed = await loadBoardState(context, { readOnly: true });
    assert.deepEqual(committed.nativeRetention.backfill[0].sources.map(source => source.surface).sort(), [...surfaces].sort());
    assert.ok(committed.nativeRetention.backfill[0].sources.every(source => !source.startQualified && !source.exhausted));
    if (hasChat) assert.ok(committed.nativeRetention.backfill[0].sources.find(source => source.surface === "chat")
        .histories.every(history => history.state === "pending" && history.handledThrough === null));
    if (pinnedOnly) {
        const source = committed.nativeRetention.backfill[0].sources.find(source => source.surface === "chat");
        assert.equal(source.initial, "empty", "The ordinary list remains empty; returned pins are the positive population.");
        assert.equal(source.histories.length, 1);
        assert.deepEqual(await owned.pages()[0].evaluate(() => window.chatDetailIds), ["pinned-only", "pinned-only"]);
    }
    const guard = await host.access.read(admission.owner);
    let readback;
    try {
        const views = host.access.nativeRetainedFor(guard, { check() {} });
        const selectedSources = surfaces.map(surface => "microsoft-365-" + surface);
        const listing = await views.query({ schemaVersion: 1, revision: null, sources: selectedSources,
            analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 100, after: null } });
        const details = [];
        for (const item of listing.page.items) details.push(await views.detail({
            schemaVersion: 1, revision: listing.revision, sources: selectedSources,
            conversationId: item.id, page: { limit: 100, after: null },
        }));
        readback = JSON.stringify({ listing, details });
    } finally { guard.release(); }
    if (hasChat) {
        assert.match(readback, /Invented Chat revision 1/);
        assert.match(readback, /Invented Chat revision 2/);
        assert.match(readback, /invented_lookup/);
        assert.match(readback, /Invented tool input/);
        assert.doesNotMatch(readback, /UNQUALIFIED_CHAT_ERROR_NOT_RETAINED|pre-enable-cached-chat/);
    } else assert.doesNotMatch(readback, /Invented Chat revision/);
    if (hasCowork) assert.match(readback, /Invented normal collection/);
    else assert.doesNotMatch(readback, /Invented normal collection/);
    // First Enable used the actual scheduler. Isolate the subsequent manual
    // Pause/reconnect assertions from its later timer-driven work.
    await host.access.stopNativeCollection();
    const page = owned.pages()[0];
    await page.evaluate(() => { window.holdNextMessages = true; });
    const interruptedId = randomUUID();
    const held = host.access.collectNativeNow({ operationId: interruptedId }, admission);
    const rejected = assert.rejects(held);
    await page.waitForFunction(() => window.heldReadStarted === true);
    if (cacheable) {
        if (disposeRoot) {
            const references = await page.evaluate(replace => {
                if (replace) window.replaceNativeRuntime(); else window.unmountNativeRoot();
                return window.nativeRootReferences();
            }, disposeRoot === "runtime");
            assert.deepEqual(references, { router: true, store: true, query: true });
        } else if (ctiProtocol) {
            assert.deepEqual(await page.evaluate(() => Promise.all(["GET", "POST"].map(method =>
                fetch("/fixture-safe-init", { method }).then(response => response.status)))), [200, 200],
            "The narrow protocol boundary is not a blanket POST prohibition.");
            if (!hasCowork) await page.evaluate(() => window.prepareAmbientCowork());
            const native = await page.evaluate(sequential => {
                const result = sequential ? window.nativeCapabilitySequence() : null;
                void Promise.allSettled(["heartbeat", "results", "consent"].map(kind =>
                    fetch("/v1/conversations/invented/client-tool-" + kind, { method: "POST", body: "{}" })));
                return result;
            }, ctiProtocol === "sequential");
            if (ctiProtocol === "sequential") {
                assert.deepEqual(native, { forwarded: false, sent: [],
                    flags: { isSimpleBrowserSupported: true, isConsented: true, isEdgeIdentityMatched: true } });
            }
        } else await page.evaluate(hasChat => hasChat ? window.updateNativeChatAccount({ objectId: "changed-active-native-account" })
            : window.updateNativeProviderAccount({ userId: "changed-active-native-account" }), hasChat);
        await rejected;
        for (let attempt = 0; attempt < 100 && !page.isClosed(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(page.isClosed(), true, "A real React provider account update retires the held native invocation.");
        if (ctiProtocol) {
            assert.equal(ctiReached, 0, "No client-tool coordination write reaches the fixture server.");
            const failure = settled.at(-1).nativeSource.failure;
            if (ctiProtocol === "sequential") {
                assert.ok(["NATIVE_COWORK_CLIENT_READONLY_UNQUALIFIED", "NATIVE_CLIENT_TOOL_PROTOCOL_DENIED"].includes(failure),
                    "Preserve the first actual guard failure; browser interception and realm notification race.");
            } else assert.equal(failure, "NATIVE_CLIENT_TOOL_PROTOCOL_DENIED");
        }
        if (disposeRoot) assert.match(settled.at(-1).nativeSource.failure, /^NATIVE_PROVIDER_/);
    }
    const beforePause = await host.access.globalCollectionControl(admission);
    await host.access.setGlobalCollectionEnabled({ schemaVersion: 1, enabled: false,
        generation: beforePause.generation, authorizationRevision: beforePause.authorizationRevision,
        expectedRevision: beforePause.globalCollection.revision }, admission);
    await rejected;
    for (let attempt = 0; attempt < 100 && !page.isClosed(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(page.isClosed(), true, "Pause closes the active owned read context even when native work ignores abort.");
    const retained = await host.access.nativePersistenceStatus({ operationId: interruptedId }, admission);
    assert.notEqual(retained.receipt?.status, "committed");
    assert.equal((await host.access.status()).wire, "signed-in");
    let reconnectState;
    for (let attempt = 0; attempt < 200; attempt++) {
        reconnectState = await host.access.status();
        if (reconnectState.microsoft.actions.includes("microsoft-connect")) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const reconnect = await host.access.command(admission.owner, { schemaVersion: 1, action: "microsoft-connect",
        operationId: randomUUID(), generation: reconnectState.generation }, () => true);
    assert.equal(reconnect.outcome, "completed");
    const paused = await host.access.globalCollectionControl(admission);
    assert.equal(paused.globalCollection.paused, true, "Reconnect alone does not resume collection.");
    await host.access.setGlobalCollectionEnabled({ schemaVersion: 1, enabled: true,
        generation: paused.generation, authorizationRevision: paused.authorizationRevision,
        expectedRevision: paused.globalCollection.revision }, admission);
    const afterReconnect = await host.access.collectNativeNow({ operationId: randomUUID() }, admission);
    assert.equal(afterReconnect.status, "committed");
    assert.equal(settled.at(-1).sourceComparison.status, "matched");
    assert.notEqual(owned.pages()[0], page);
    const idlePage = owned.pages()[0];
    assert.equal(await idlePage.evaluate(() => window.nativeMounts - window.nativeUnmounts), 0);
    if (disposeRoot) {
        assert.deepEqual(await idlePage.evaluate(replace => {
            if (replace) window.replaceNativeRuntime(); else window.unmountNativeRoot();
            return window.nativeRootReferences();
        }, disposeRoot === "runtime"),
            { router: true, store: true, query: true });
    } else await idlePage.evaluate(hasChat => hasChat ? window.updateNativeChatAccount({ objectId: "changed-idle-native-account" })
        : window.updateNativeHostAccount({ userId: "changed-idle-native-account" }), hasChat);
    for (let attempt = 0; attempt < 100 && !idlePage.isClosed(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(idlePage.isClosed(), true, "An idle native parent account change must retire the owner without another begin().");
    const idleStatus = await host.access.status();
    assert.notEqual(idleStatus.microsoft.state, "connected");
    assert.equal(idleStatus.wire, "signed-in");
    if (hasChat && hasCowork) {
        let available = idleStatus;
        for (let attempt = 0; attempt < 200 && !available.microsoft.actions.includes("microsoft-connect"); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
            available = await host.access.status();
        }
        assert.ok(available.microsoft.actions.includes("microsoft-connect"));
        const connection = await host.access.command(admission.owner, { schemaVersion: 1, action: "microsoft-connect",
            operationId: randomUUID(), generation: available.generation }, () => true);
        assert.equal(connection.outcome, "completed");
        assert.equal((await host.access.collectNativeNow({ operationId: randomUUID() }, admission)).status, "committed");
        const beforeChange = (await loadBoardState(context, { readOnly: true })).nativeRetention.partitions;
        const changed = await host.access.nativeConfigurationOffer(admission);
        await host.access.configureNativeIntent({ schemaVersion: 2, intent: changed.intent, generation: changed.generation,
            authorizationRevision: changed.authorizationRevision, expectedRevision: changed.expectedRevision,
            globalRevision: changed.globalRevision, surfaces: ["chat"], windowDays: 7 }, admission);
        const oldOwner = owned.pages()[0];
        await assert.rejects(host.access.collectNativeNow({ operationId: randomUUID() }, admission),
            { code: "NATIVE_CLIENT_SOURCE_SWITCH_RECONNECT" });
        assert.equal(oldOwner.isClosed(), true);
        assert.deepEqual((await loadBoardState(context, { readOnly: true })).nativeRetention.partitions, beforeChange);
    }
});
test("actual bootstrap and invocation path reaches the existing writer and committed comparison with invented providers", async t => {
    const cleanups = [], { context } = await privateFixture({ after: work => cleanups.push(work) }, []);
    const releaseWriter = await acquireCollectorLock(context.dataDir);
    const calls = [];
    let version = 1;
    const browser = browserFixture(() => ({
        async listTasks(args) { calls.push(["listTasks", args]); return { tasks: [task("history")], nextCursor: null }; },
        async listMessages(args) {
            calls.push(["listMessages", args]);
            const ts = Date.now() - 1000, tid = "native-tool-" + version;
            return { events: [
                event("message-" + version, "Invented revision " + version, ts),
                { id: "assistant-" + version, event: "a", data: { ts, t: "Invented assistant reply" } },
                { id: "start-" + version, event: "ts", data: { ts, tid, tn: "mcp__graph__CallGraph", inp: '{"method":"GET"}' } },
                { id: "end-" + version, event: "tx", data: { ts, tid, tn: "mcp__graph__CallGraph",
                    ok: false, err: "Invented native failure.", d: "The selected operation stopped.", out: "DO_NOT_RETAIN_NATIVE_OUTPUT" } },
            ], nextCursor: null };
        },
        getTaskDetail() { assert.fail("The new reader does not use coalesced detail."); },
    }));
    const transport = createMicrosoftNativeReadTransport({
        async open() {}, async stop() { browser.close(); return { processExited: true, profileReleased: true }; },
        async verifyAccount() { return { ...principal, knownAccountMatched: true,
            evidence: { kind: "native-account-metadata", issuer: "https://m365.cloud.microsoft",
                namespace: principal.namespace, realm: "prod", observedAt: new Date().toISOString() } }; },
    });
    const lifecycle = await createMicrosoftSession(context, { transport, collection: { paused: false, windowDays: 7 } });
    const persistence = await createNativePersistence(context, { lifecycle, transport, backfillTracking: true });
    let reader, currentLease;
    const comparisons = [], operationIds = [], documentIds = new Set();
    const access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence,
        async acquireNative(lease, collection, recordFailure, previousBackfill, operation) {
            currentLease = lease;
            reader ??= await openCoworkBrowserHost({
                browser: browser.browser, page: browser.page, principal, deadline: Date.now() + 10000,
                assertOwner() {}, assertLease: () => lifecycle.assertLease(currentLease), beforeReload: async () => {},
                observeDocument: browser.observeDocument, openCowork: browser.openCowork,
                onFailure(error) { throw error; },
            });
            await reader.begin(Date.now() + 10000, { assertLease: () => lifecycle.assertLease(lease),
                operationId: operation.operationId });
            documentIds.add(reader.documentId);
            return acquireCoworkClient({ lifecycle, transport, lease, collection, reader, recordFailure, previousBackfill });
        },
        async completeNative(ticket, receipt, acquired, recordBackfill) {
            const comparison = await persistence.compareCommittedSource(ticket, acquired);
            comparisons.push(comparison);
            await recordBackfill(comparison);
            if (receipt?.status === "committed") await reader.finish();
        },
    });
    t.after(async () => {
        access.close(); persistence.close(); await lifecycle.close(); await releaseWriter();
        for (const cleanup of cleanups) await cleanup();
    });
    for (const action of ["wire-sign-in", "microsoft-connect"]) {
        const receipt = await lifecycle.command("invented-cowork-backend-owner", { action, operationId: randomUUID(),
            generation: (await lifecycle.status()).generation, ...(action === "microsoft-connect" ? { replace: false } : {}) }, () => true);
        assert.equal(receipt.outcome, "completed");
    }
    const admission = { owner: "invented-cowork-backend-owner", check() {}, dispatched() {} };
    await persistence.configure({ expectedRevision: null, surfaces: ["cowork"], windowDays: 7 }, admission);
    for (const expected of [1, 2]) {
        version = expected;
        const operationId = randomUUID();
        operationIds.push(operationId);
        const receipt = await access.collectNativeNow({ operationId }, admission);
        assert.equal(receipt.status, "committed");
        assert.equal(comparisons.at(-1).status, "matched");
        assert.equal(browser.clients.getState().client, null, "Commit completion unmounts the native client owner.");
    }
    assert.equal(browser.customizeExecutions, 0, "The Customize factory was loaded only; no Customize UI or actions ran.");
    assert.deepEqual(browser.renderErrors, []);
    assert.deepEqual(calls.map(([method]) => method), ["listTasks", "listMessages", "listTasks", "listMessages"]);
    const retained = await persistence.readAuthorized(await lifecycle.lease("microsoft-retained"));
    const references = retained.records.flatMap(row => row.coverage);
    assert.deepEqual([...new Set(references.filter(row => row.kind === "native-client-operation").map(row => row.subject))].sort(),
        operationIds.sort(), "Retained provenance contains the actual registered collection operation IDs.");
    assert.deepEqual(new Set(references.filter(row => row.kind === "native-client-document").map(row => row.subject)),
        documentIds);
    assert.match(JSON.stringify(retained), /Invented revision 1/);
    assert.match(JSON.stringify(retained), /Invented revision 2/);
    assert.match(JSON.stringify(retained), /cowork-native-client-return-v1/);
    assert.doesNotMatch(JSON.stringify(retained), /native-original-json/);
    assert.match(JSON.stringify(retained), /Invented native failure/);
    assert.match(JSON.stringify(retained), /The selected operation stopped/);
    assert.doesNotMatch(JSON.stringify(retained), /DO_NOT_RETAIN_NATIVE_OUTPUT/);
});
