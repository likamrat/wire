import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createChatReadHost } from "../lib/microsoft-chat-read-host.mjs";

const principal = { namespace: "m365.accountInfo.objectId", realm: "prod",
    tenantId: "11111111-1111-4111-8111-111111111111", subjectId: "22222222-2222-4222-8222-222222222222" };
const row = id => ({ conversationId: id, createTimeUtc: "2020-01-01T00:00:00.000Z" });
const conversation = id => ({ conversationId: id, requestId: "invented-request",
    messages: [{ messageId: "message-" + id, author: "user", text: "Invented Chat history", createdAt: new Date().toISOString() }] });

function fixture(t, { landing = false, query, detail, deadline = Date.now() + 10000, subscribe } = {}) {
    let state = { accountInfo: { accountType: "AAD", environment: "prod",
        tenantId: principal.tenantId, objectId: principal.subjectId },
    featureFlags: { enableChatLandingPageHistoryStore: landing },
    conversationPageHistoryList: { chats: [row("pre-enable-cache")], syncState: "cached-cursor" } };
    Object.defineProperty(state, "tokenProviders", { get() { assert.fail("Do not inspect native credential/provider state."); } });
    const changes = new Set(), navigation = new Set(), calls = [], retired = [];
    const nativeQuery = query ?? (async ({ meta, signal }) => {
        const payload = meta.actionPayload;
        calls.push({ method: "list", payload, signal });
        return { [payload.saveToStore ?? "conversationPageHistoryList"]: {
            chats: payload.syncState ? [row("a"), row("b")] : [row("a")],
            syncState: payload.syncState ? "" : "next-original" },
        pinnedChatIds: { pinned: 1 }, pinnedChats: [row("pinned")] };
    });
    const store = { getState: () => state, subscribe: work => {
        changes.add(work);
        subscribe?.(work);
        return () => changes.delete(work);
    } };
    const queryClient = { getDefaultOptions: () => ({ queries: { queryFn: nativeQuery } }),
        fetchQuery() { assert.fail("No native query cache/coalescing."); },
        ensureQueryData() { assert.fail("No pre-Enable query-cache reuse."); } };
    const router = { options: { context: { store, queryClient } },
        routesById: { "/_sharedChatSetup/chat_/all": { options: { loader() { assert.fail("Do not invoke the store-mutating route loader."); } } } },
        subscribe(name, work) {
            assert.equal(name, "onBeforeNavigate");
            navigation.add(work);
            return () => navigation.delete(work);
        } };
    const host = createChatReadHost({ principal, getRouter: () => router,
        optionsForAction({ action, payload }) {
            assert.equal(action, "GetConversationPageHistoryList");
            return { queryKey: ["/chat", action], meta: { actionPayload: payload } };
        },
        getConversation: detail ?? (async input => {
            assert.deepEqual(Object.keys(input).sort(), ["data", "signal"]);
            calls.push({ method: "detail", ...input });
            return { store: { rawConversationResponse: conversation(input.data.conversationId) } };
        }), assertOwner() {}, onRetire: reason => retired.push(reason) });
    t.after(() => host.retire());
    host.begin({ deadline, instanceId: randomUUID() });
    return { host, calls, retired, store, router,
        invoke: (method, args = {}) => host.invoke({ method, arguments: args, invocationId: randomUUID() }),
        update(next) { state = { ...state, ...next }; for (const work of [...changes]) work(); },
        navigate() { for (const work of [...navigation]) work(); },
        subscriptions: () => changes.size + navigation.size };
}

for (const landing of [false, true]) test(`native Chat uses the All-chats read action and original ${landing ? "landing" : "conversation"} store`, async t => {
    const f = fixture(t, { landing });
    await assert.rejects(f.invoke("readConversation", { conversationId: "pre-enable-cache" }), { code: "NATIVE_CHAT_CLIENT_ARGUMENTS_INVALID" });
    const first = await f.invoke("listChats");
    assert.deepEqual(first.value.chats.map(row => row.conversationId), ["a"]);
    assert.deepEqual(first.value.pinned.map(row => row.conversationId), ["pinned"]);
    assert.equal(first.value.complete, false);
    await assert.rejects(f.invoke("listChats", { cursor: "invented" }), { code: "NATIVE_CHAT_CLIENT_ARGUMENTS_INVALID" });
    await f.invoke("listChats", { cursor: "next-original" });
    const field = landing ? "chatLandingPageHistoryList" : "conversationPageHistoryList";
    assert.deepEqual(f.calls[0].payload.state, { [field]: { chats: [], syncState: "" } });
    assert.equal(Object.hasOwn(f.calls[0].payload, "syncState"), false);
    assert.deepEqual(f.calls[1].payload.state[field].chats, [row("a")], "Pins do not replace the original paging store.");
    assert.equal(f.calls[1].payload.syncState, "next-original");
    const detail = await f.invoke("readConversation", { conversationId: "pinned" });
    assert.equal(detail.value.conversation.conversationId, "pinned");
    assert.ok(f.calls.every(call => call.signal instanceof AbortSignal));
    f.host.suspend();
    f.host.begin({ deadline: Date.now() + 10000, instanceId: randomUUID() });
    await assert.rejects(f.invoke("readConversation", { conversationId: "pinned" }), { code: "NATIVE_CHAT_CLIENT_ARGUMENTS_INVALID" });
    await f.invoke("listChats");
    assert.deepEqual(f.calls.at(-1).payload.state, { [field]: { chats: [], syncState: "" } });
});

for (const reason of ["account", "population", "navigation", "deadline"]) test(`native Chat rejects a held response after ${reason}`, async t => {
    const pending = Promise.withResolvers(), started = Promise.withResolvers();
    const f = fixture(t, { query: () => { started.resolve(); return pending.promise; },
        ...(reason === "deadline" ? { deadline: Date.now() + 40 } : {}) });
    const read = f.invoke("listChats"), rejected = assert.rejects(read);
    await started.promise;
    if (reason === "account") f.update({ accountInfo: { accountType: "AAD", environment: "prod", tenantId: principal.tenantId, objectId: "changed" } });
    if (reason === "population") f.update({ featureFlags: { enableChatLandingPageHistoryStore: true } });
    if (reason === "navigation") f.navigate();
    if (reason === "deadline") await new Promise(resolve => setTimeout(resolve, 60));
    await rejected;
    pending.resolve({ conversationPageHistoryList: { chats: [row("late")], syncState: "" } });
    assert.equal(f.retired.length, 1);
    assert.equal(f.subscriptions(), 0);
});

test("native Chat remains account-fenced while idle and never revives a replaced query client", async t => {
    const f = fixture(t);
    f.host.suspend();
    f.router.options.context.queryClient = {};
    assert.throws(f.host.assertCurrent, { code: "NATIVE_CHAT_CLIENT_REPLACED" });
    await assert.rejects(f.invoke("listChats"), { code: "NATIVE_CHAT_CLIENT_REPLACED" });
    assert.equal(f.subscriptions(), 0);
});

test("native Chat refuses missing/empty data, inconsistent pins and foreign details", async t => {
    for (const data of [{}, { conversationPageHistoryList: { chats: [], syncState: "" } },
        { conversationPageHistoryList: { chats: [], syncState: "" }, pinnedChatIds: {}, pinnedChats: [] },
        { pinnedChatIds: { "pinned-only": 1 }, pinnedChats: [row("pinned-only")] },
        { conversationPageHistoryList: { chats: null, syncState: "" }, pinnedChatIds: { "pinned-only": 1 }, pinnedChats: [row("pinned-only")] },
        { conversationPageHistoryList: { chats: [], syncState: "" }, pinnedChatIds: { foreign: 1 }, pinnedChats: [row("pinned-only")] },
        { conversationPageHistoryList: { chats: [row("a")], syncState: "" }, pinnedChatIds: { foreign: 1 }, pinnedChats: [row("a")] }]) {
        const f = fixture(t, { query: async () => data });
        await assert.rejects(f.invoke("listChats"));
        assert.equal(f.retired.length, 1);
    }
    const f = fixture(t, { detail: async () => ({ store: { rawConversationResponse: conversation("foreign") } }) });
    await f.invoke("listChats");
    await assert.rejects(f.invoke("readConversation", { conversationId: "a" }), { code: "NATIVE_CHAT_CLIENT_CONVERSATION_UNQUALIFIED" });
});

test("native Chat admits a validated pinned-only population without global cached membership", async t => {
    const f = fixture(t, { query: async () => ({
        conversationPageHistoryList: { chats: [], syncState: "" },
        pinnedChatIds: { "pinned-only": 1 }, pinnedChats: [row("pinned-only")],
    }) });
    const inventory = await f.invoke("listChats");
    assert.deepEqual(inventory.value.chats, []);
    assert.deepEqual(inventory.value.pinned, [row("pinned-only")]);
    assert.equal(inventory.value.complete, false);
    await assert.rejects(f.invoke("readConversation", { conversationId: "pre-enable-cache" }),
        { code: "NATIVE_CHAT_CLIENT_ARGUMENTS_INVALID" });
    assert.equal((await f.invoke("readConversation", { conversationId: "pinned-only" })).value.conversation.conversationId, "pinned-only");
});

test("additional connected context remains explicit and is not merged into the discovered conversation", async t => {
    const f = fixture(t, { detail: async ({ data }) => ({ store: {
        rawConversationResponse: conversation(data.conversationId),
        rawConnectedConversationResponse: { conversationId: "unqualified-related", messages: ["UNQUALIFIED_CONNECTED_CONTENT"] },
    } }) });
    await f.invoke("listChats");
    const returned = await f.invoke("readConversation", { conversationId: "a" });
    assert.equal(returned.value.connectedContext, "unqualified");
    assert.doesNotMatch(JSON.stringify(returned), /UNQUALIFIED_CONNECTED_CONTENT|unqualified-related/);
});
