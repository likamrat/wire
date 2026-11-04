import test from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { installNativeChatCapture, projectNativeSourceResponse } from "../lib/microsoft-chat-capture.mjs";
import { readNativeAccountMetadata, projectNativeBootstrapHistory } from "../lib/microsoft-native-bootstrap.mjs";

const row = (id, time = 1800000000000) => ({ conversationId: id, updateTimeUtc: time, createTimeUtc: time - 1000 });
const sample = () => ({ historySource: "all-chats", store: {
    featureFlags: { enableChatLandingPageHistoryStore: true },
    conversationPageHistoryList: { chats: [row("unselected")], syncState: "unselected-cursor" },
    chatLandingPageHistoryList: { chats: [row("ordinary")], syncState: "next-page" },
    pinnedChatIds: { pinned: 1799999000000 }, pinnedChats: [row("pinned")],
    unifiedSessions: [{ conversationId: "cowork-presentation-row" }],
} });
const project = value => projectNativeSourceResponse({
    bytes: Buffer.from(JSON.stringify(value)), mime: "application/json", kind: "chat-list", store: null,
});

test("Chat membership uses the original selected store and separate pinned identities, never unified display rows", () => {
    const value = project(sample());
    assert.deepEqual(value.items.map(item => item.conversationId), ["ordinary"]);
    assert.equal(value.store, "chatLandingPageHistoryList");
    assert.deepEqual(value.continuation, { state: "present", value: "next-page" });
    assert.deepEqual(value.membership, {
        marker: "all-chats", selected: true, pinnedComplete: true,
        pinnedIds: ["pinned"], pinnedItems: [{ conversationId: "pinned", createdAt: 1799999999000, lastActivity: 1800000000000 }],
    });
    assert.doesNotMatch(JSON.stringify(value), /unselected|cowork-presentation/);
});

test("missing, conflicting and unknown membership evidence is not an empty or complete population", () => {
    for (const missing of ["pinnedChats", "pinnedChatIds"]) {
        const source = sample();
        delete source.store[missing];
        assert.equal(project(source).membership.pinnedComplete, false);
    }
    const inconsistent = sample();
    inconsistent.store.pinnedChatIds = { another: 1799999000000 };
    assert.equal(project(inconsistent).membership.pinnedComplete, false);
    const unknown = sample();
    unknown.historySource = "undocumented-source";
    assert.equal(project(unknown).membership.marker, "unqualified");
    const unselected = sample();
    delete unselected.store.featureFlags;
    assert.throws(() => project(unselected), { code: "NATIVE_SOURCE_RESPONSE_UNQUALIFIED" });
    const presentationArray = sample();
    presentationArray.store.pinnedChatIds = ["pinned"];
    assert.throws(() => project(presentationArray), { code: "NATIVE_SOURCE_RESPONSE_UNQUALIFIED" });
    const undated = sample();
    delete undated.store.pinnedChats[0].updateTimeUtc;
    assert.equal(Object.hasOwn(project(undated).membership.pinnedItems[0], "lastActivity"), false);
});

for (const mode of ["tanstack", "background-document", "background-native-start"])
test(`original All-chats hydration wins over common context without reading secrets or copying display text: ${mode}`, async () => {
    const background = mode !== "tanstack";
    const source = sample(), deliveries = [];
    source.store.accountInfo = { accountType: "AAD", environment: "prod", tenantId: "tenant", objectId: "subject" };
    Object.defineProperty(source.store, "accessToken", { enumerable: true,
        get() { assert.fail("The membership observer must not inspect credentials."); } });
    Object.defineProperty(source.store.pinnedChats[0], "chatName", { enumerable: true,
        get() { assert.fail("The membership observer needs no title or content."); } });
    const bootstrap = { initialized: true, router: { dehydratedData: { copilotBootstrap: { loaderData: {
        common: { store: { conversationPageHistoryList: { chats: [row("stale-common")], syncState: "" },
            accountInfo: source.store.accountInfo } },
        all: source,
    } } } } };
    const window = { fetch() { assert.fail("Hydration projection must not issue a request."); },
        deliver: value => { deliveries.push(value); } };
    window.top = window;
    const ready = [];
    const context = createContext({ window, document: { readyState: "loading", addEventListener: (event, work) => {
        assert.equal(event, "DOMContentLoaded"); ready.push(work);
    } }, location: { origin: "https://m365.cloud.microsoft",
        pathname: "/chat/all", href: "https://m365.cloud.microsoft/chat/all" }, crypto: { randomUUID }, console });
    runInContext(`(${installNativeChatCapture.toString()})({binding:"deliver",nativeHistory:{}},
        null,null,${readNativeAccountMetadata.toString()},${projectNativeBootstrapHistory.toString()})`, context);
    if (mode === "background-native-start") ready.forEach(work => work());
    if (background) {
        window.__backgroundSSR = true;
        window.__backgroundLoaderData = bootstrap.router.dehydratedData.copilotBootstrap.loaderData;
        Object.defineProperty(window, "$_TSR", { get() { assert.fail("Inactive bootstrap must not be read."); } });
        if (mode === "background-native-start") window.__m365TanstackClientBooted = true;
        else ready.forEach(work => work());
    } else window.$_TSR = bootstrap;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(deliveries.map(value => value.state), ["started", "complete"]);
    assert.ok(deliveries.every(value => value.kind === "chat-history-document"));
    assert.equal(deliveries[1].bootstrapBranch, background ? "background-loader" : "tanstack");
    const projected = JSON.parse(JSON.stringify(deliveries[1].projected));
    assert.equal(projected.historySource, "all-chats");
    assert.deepEqual(projected.store.accountInfo, source.store.accountInfo);
    assert.equal(project(projected).membership.pinnedComplete, true);
    assert.doesNotMatch(JSON.stringify(projected), /accessToken|chatName|unifiedSessions|stale-common/);
    assert.equal(bootstrap.initialized, true);
    if (mode === "background-native-start") {
        assert.deepEqual(Object.getOwnPropertyDescriptor(window, "__m365TanstackClientBooted"),
            { configurable: true, enumerable: true, writable: true, value: true });
    }
});

for (const scenario of ["late", "missing-account", "never-ready", "after-deadline", "malformed", "accessor", "page-retired", "phase-retired", "owner-retired", "branch-changed"])
test(`background readiness after document and boot-start cues: ${scenario}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const deliveries = [], events = new Map();
    const window = { __backgroundSSR: true, fetch() { assert.fail("Bootstrap readiness cannot issue requests."); },
        deliver: value => { deliveries.push(value); },
        addEventListener: (name, work) => events.set(name, work),
        removeEventListener: (name, work) => { if (events.get(name) === work) events.delete(name); } };
    window.top = window;
    const context = createContext({ window, document: { readyState: "complete" },
        location: { origin: "https://m365.cloud.microsoft", pathname: "/chat", href: "https://m365.cloud.microsoft/chat" },
        crypto: { randomUUID }, Date, setTimeout, clearTimeout, console });
    runInContext(`(${installNativeChatCapture.toString()})({binding:"deliver",timeoutMs:1000,
        nativeHistory:{resetBinding:"reset"}},null,null,${readNativeAccountMetadata.toString()},${projectNativeBootstrapHistory.toString()})`, context);
    window.__m365TanstackClientBooted = true;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(deliveries.map(row => row.state), ["started"]);
    const accountInfo = { accountType: "AAD", environment: "prod", tenantId: "tenant", objectId: "subject" };
    const loader = { root: { store: { accountInfo } } };
    if (scenario === "after-deadline") {
        t.mock.timers.tick(1000);
        await new Promise(resolve => setImmediate(resolve));
    }
    if (scenario === "page-retired") events.get("pagehide")?.();
    if (scenario === "phase-retired") assert.equal(window.reset(), true);
    if (scenario === "owner-retired") assert.equal(window.reset(true), true);
    if (scenario === "branch-changed") window.__backgroundSSR = false;
    if (scenario === "malformed") window.__backgroundLoaderData = [];
    else if (scenario === "accessor") Object.defineProperty(window, "__backgroundLoaderData", {
        configurable: true, get() { assert.fail("Do not invoke the source accessor."); } });
    else if (scenario === "missing-account") window.__backgroundLoaderData = { root: { store: {} } };
    else if (scenario !== "never-ready") Object.defineProperty(window, "__backgroundLoaderData", {
        configurable: true, enumerable: false, writable: false, value: loader });
    t.mock.timers.tick(100);
    await new Promise(resolve => setImmediate(resolve));
    if (scenario === "missing-account") {
        assert.deepEqual(deliveries.map(row => row.state), ["started"]);
        window.__backgroundLoaderData.root.store.accountInfo = accountInfo;
        t.mock.timers.tick(100);
        await new Promise(resolve => setImmediate(resolve));
    }
    if (["late", "missing-account"].includes(scenario)) {
        assert.deepEqual(deliveries.map(row => row.state), ["started", "complete"]);
        assert.deepEqual(JSON.parse(JSON.stringify(deliveries[1].projected)), { store: { accountInfo } });
        assert.equal(deliveries[1].bootstrapBranch, "background-loader");
        if (scenario === "late") assert.deepEqual(Object.getOwnPropertyDescriptor(window, "__backgroundLoaderData"),
            { configurable: true, enumerable: false, writable: false, value: loader });
    }
    t.mock.timers.tick(2000);
    await new Promise(resolve => setImmediate(resolve));
    if (["page-retired", "phase-retired", "owner-retired"].includes(scenario)) {
        assert.deepEqual(deliveries.map(row => row.state), ["started"], "Retired work cannot publish a late projection.");
    } else if (!["late", "missing-account"].includes(scenario)) {
        assert.deepEqual(deliveries.map(row => row.state), ["started", "unqualified"]);
    } else assert.equal(deliveries.length, 2, "Ready data is projected exactly once, not on every cue or timer.");
    assert.deepEqual(Object.getOwnPropertyDescriptor(window, "__m365TanstackClientBooted"),
        { configurable: true, enumerable: true, writable: true, value: true });
});
