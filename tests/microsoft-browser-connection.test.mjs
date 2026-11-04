import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { chromium } from "playwright";
import { privateFixture } from "./helpers.mjs";
import { createMicrosoftNativeHost, observeBrowserAccountDocument } from "../lib/microsoft-native-host.mjs";
import { readNativeAccountMetadata } from "../lib/microsoft-native-bootstrap.mjs";
import { readMicrosoftNativeConfiguration } from "../lib/microsoft-native-configuration.mjs";
import { nativeFailureDetails, validNativeFailure, withNativeFailurePredicate } from "../lib/microsoft-session-state.mjs";
import { installNativeAccountStartup } from "../lib/microsoft-account-startup.mjs";

const app = "https://m365.cloud.microsoft";
const account = { accountType: "AAD", environment: "prod",
    tenantId: "11111111-1111-4111-8111-111111111111", objectId: "22222222-2222-4222-8222-222222222222" };
const hydration = value => ({ initialized: true, router: { dehydratedData: { copilotBootstrap: {
    loaderData: { root: { store: { accountInfo: value, identity: { userPrincipalName: "fixture@example.test" } } } },
} } } });

function stagedProtocol(frame, read, methods = []) {
    const protocol = new EventEmitter();
    protocol.send = async (method, input) => {
        methods.push(method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { ...frame } } };
        if (method === "Runtime.enable") protocol.emit("Runtime.executionContextCreated", {
            context: { id: 1, uniqueId: "realm-1", auxData: { isDefault: true, frameId: frame.id } },
        });
        if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "startup-script" };
        if (method === "Runtime.evaluate" && input.expression.endsWith("?.read()")) return { result: { value: await read(input) } };
        assert.ok(["Page.enable", "Network.enable", "Runtime.enable", "Runtime.evaluate",
            "Page.removeScriptToEvaluateOnNewDocument"].includes(method));
        return {};
    };
    return protocol;
}

for (const trigger of ["loader-assignment", "transport-assignment", "initialization-assignment", "read"])
test(`account startup deadline holds without timer delivery: ${trigger}`, () => {
    let now = 0, reads = 0;
    class Clock extends Date { static now() { return now; } }
    const window = { ...(["transport-assignment", "initialization-assignment"].includes(trigger) ? {} : { __backgroundSSR: true }),
        addEventListener() {}, removeEventListener() {} };
    window.top = window;
    const observation = runInNewContext(`(${installNativeAccountStartup.toString()})`, {
        window, location: { origin: app, pathname: "/chat" }, document: { addEventListener() {}, removeEventListener() {} },
        Date: Clock, setTimeout: () => 1, clearTimeout() {}, console,
    });
    observation("control", 100, () => {
        reads++;
        return { state: "available", branch: "background-loader", projected: { store: { accountInfo: account } } };
    });
    const transport = { initialized: false };
    if (trigger === "initialization-assignment") window.$_TSR = transport;
    const control = window.control, priorReads = reads;
    now = 101;
    if (trigger === "loader-assignment") {
        const loader = { root: { store: { accountInfo: account } } };
        assert.doesNotThrow(() => { window.__backgroundLoaderData = loader; });
        assert.equal(window.__backgroundLoaderData, loader);
        assert.deepEqual(Object.getOwnPropertyDescriptor(window, "__backgroundLoaderData"),
            { value: loader, configurable: true, enumerable: true, writable: true });
    } else if (trigger === "transport-assignment") {
        const transport = {};
        Object.defineProperty(transport, "initialized", { get() { assert.fail("Expired observation cannot inspect native initialization."); } });
        assert.doesNotThrow(() => { window.$_TSR = transport; });
        assert.equal(window.$_TSR, transport);
    } else if (trigger === "initialization-assignment") {
        assert.doesNotThrow(() => { transport.initialized = true; });
        assert.deepEqual(Object.getOwnPropertyDescriptor(transport, "initialized"),
            { value: true, configurable: true, enumerable: true, writable: true });
    } else control.read();
    assert.equal(reads, priorReads, "Expiry must be checked before reading metadata, not only by a queued timer.");
    assert.equal(Object.hasOwn(window, "control"), false);
    assert.equal(control.read().state, "retired");
});

for (const outcome of ["same", "changed-account", "changed-branch", "late-label", "changed-label"])
test(`account consistency survives an unavailable placeholder: ${outcome}`, () => {
    const source = hydration({ ...account }), window = { $_TSR: source,
        addEventListener() {}, removeEventListener() {} };
    window.top = window;
    const run = (fn, args) => runInNewContext(`(${fn.toString()})(${args})`, {
        window, location: { origin: app, pathname: "/home" }, document: { addEventListener() {}, removeEventListener() {} },
        Date, setTimeout: () => 1, clearTimeout() {}, console,
    });
    const store = source.router.dehydratedData.copilotBootstrap.loaderData.root.store;
    if (outcome === "late-label") delete store.identity;
    run(installNativeAccountStartup, `"control",${Date.now() + 10000},${readNativeAccountMetadata.toString()}`);
    assert.equal(window.control.read().state, "available");
    store.accountInfo = {};
    delete store.identity;
    assert.equal(window.control.read().state, "account-unavailable", "A placeholder cannot keep stale identity usable.");
    store.accountInfo = outcome === "changed-account" ? { ...account, objectId: "different-source-subject" } : { ...account };
    if (outcome === "changed-branch") {
        window.__backgroundSSR = true;
        window.__backgroundLoaderData = { root: { store } };
    }
    if (outcome === "late-label") store.identity = { userPrincipalName: "late@example.test" };
    if (outcome === "changed-label") store.identity = { userPrincipalName: "different@example.test" };
    assert.equal(window.control.read().state, ["same", "late-label"].includes(outcome) ? "available" : "invalid");
    window.control.retire();
});

for (const stalled of ["script-removal", "realm-retirement"])
test(`account observer retirement bounds stalled ${stalled}`, async t => {
    const frame = { id: "root", loaderId: "original", url: app + "/home" };
    const protocol = stagedProtocol(frame, () => assert.fail("Retirement must not read account data."));
    const originalSend = protocol.send, blocked = Promise.withResolvers();
    let released = false, retirementEvaluations = 0;
    t.after(() => { released = true; blocked.resolve({}); });
    protocol.send = async (method, input) => {
        if (method === "Page.removeScriptToEvaluateOnNewDocument" && stalled === "script-removal") return blocked.promise;
        if (method === "Runtime.evaluate") {
            retirementEvaluations++;
            if (stalled === "realm-retirement") return blocked.promise;
        }
        return originalSend(method, input);
    };
    const observer = await observeBrowserAccountDocument({ isClosed: () => false }, protocol, Date.now() + 150);
    let timer;
    const result = await Promise.race([observer.retire().then(() => "completed", error => error.code),
        new Promise(resolve => { timer = setTimeout(() => resolve("still-blocked"), 1000); })]);
    clearTimeout(timer);
    assert.equal(result, "NATIVE_ACCOUNT_STARTUP_RETIRE_TIMEOUT");
    assert.equal(released, false, "The original protocol call must still be unsettled when retirement returns.");
    assert.equal(protocol.listenerCount("Runtime.executionContextCreated"), 0);
    blocked.resolve({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(retirementEvaluations, stalled === "script-removal" ? 0 : 1, "Late replies cannot resume retired cleanup steps.");
    await assert.rejects(observer.retire(), { code: "NATIVE_ACCOUNT_STARTUP_RETIRE_TIMEOUT" });
});

for (const scenario of ["cleanup", "placeholder", "unknown-placeholder", "late-label", "conflict", "accessor", "readonly", "retire", "expiry", "unrelated",
    "active-placeholder", "branch-switch"])
test(`account-only startup preserves original behavior: ${scenario}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const events = new Map(), window = { fetch() { assert.fail("No fetch is permitted from account staging."); },
        addEventListener: (name, work) => events.set(name, work), removeEventListener: name => events.delete(name) };
    window.top = window;
    const source = hydration(scenario === "placeholder" ? {}
        : scenario === "unknown-placeholder" ? { accountType: "Unestablished" } : { ...account });
    source.initialized = false;
    const sourceStore = source.router.dehydratedData.copilotBootstrap.loaderData.root.store;
    if (scenario === "late-label") delete sourceStore.identity;
    for (const key of ["accessToken", "conversationPageHistoryList", "pinnedChats"]) {
        Object.defineProperty(sourceStore, key, { get() { assert.fail("Account staging must not read credentials or history."); } });
    }
    const document = { addEventListener() {}, removeEventListener() {} };
    const location = { origin: scenario === "unrelated" ? "https://login.microsoftonline.com" : app, pathname: "/chat" };
    runInNewContext(`(${installNativeAccountStartup.toString()})("accountControl",1000,${readNativeAccountMetadata.toString()})`,
        { window, document, location, Date, setTimeout, clearTimeout, console });
    if (scenario === "unrelated") {
        assert.deepEqual(Object.getOwnPropertyNames(window).sort(), ["addEventListener", "fetch", "removeEventListener", "top"]);
        return;
    }
    const nativeFetch = window.fetch;
    if (scenario === "readonly") Object.defineProperty(source, "initialized", { value: false, writable: false });
    if (scenario === "accessor") Object.defineProperty(sourceStore.accountInfo, "tenantId", {
        get() { assert.fail("Original account accessors must not execute."); },
    });
    assert.doesNotThrow(() => { window.$_TSR = source; });
    if (scenario === "retire") {
        window.accountControl.retire();
        assert.equal(Object.hasOwn(window, "accountControl"), false);
        assert.equal(Object.getOwnPropertyDescriptor(source, "initialized").value, false);
    }
    if (scenario === "readonly") {
        assert.throws(() => { source.initialized = true; }, TypeError);
        window.accountControl.retire();
        assert.equal(Object.getOwnPropertyDescriptor(source, "initialized").writable, false);
        return;
    }
    assert.doesNotThrow(() => { source.initialized = true; });
    assert.deepEqual(Object.getOwnPropertyDescriptor(source, "initialized"), {
        value: true, writable: true, enumerable: true, configurable: true,
    });
    assert.equal(window.fetch, nativeFetch);
    if (scenario === "retire") return;
    if (scenario === "expiry") {
        t.mock.timers.tick(1000);
        assert.equal(Object.hasOwn(window, "accountControl"), false);
        return;
    }
    if (["placeholder", "unknown-placeholder"].includes(scenario)) {
        assert.equal(window.accountControl.read().state, "account-unavailable");
        sourceStore.accountInfo = account;
        t.mock.timers.tick(100);
    } else if (scenario === "conflict") {
        sourceStore.accountInfo = { ...account, objectId: "another-subject" };
        t.mock.timers.tick(100);
    } else if (scenario === "late-label") {
        sourceStore.identity = { userPrincipalName: "fixture@example.test" };
        t.mock.timers.tick(100);
    } else if (scenario === "active-placeholder") {
        sourceStore.accountInfo = {};
        t.mock.timers.tick(100);
        assert.equal(window.accountControl.read().state, "account-unavailable");
        window.accountControl.retire();
        return;
    } else if (scenario === "branch-switch") {
        window.__backgroundSSR = true;
        window.__backgroundLoaderData = hydration(account).router.dehydratedData.copilotBootstrap.loaderData;
        t.mock.timers.tick(100);
    }
    const nativeError = new Error("native-rejection");
    source.h = () => { delete window.$_TSR; return "native-result"; };
    source.e = () => { throw nativeError; };
    assert.equal(source.h(), "native-result");
    assert.throws(source.e, error => error === nativeError);
    const observed = window.accountControl.read();
    assert.equal(observed.state, ["conflict", "accessor", "branch-switch"].includes(scenario) ? "invalid" : "available");
    if (observed.state === "available") assert.equal(observed.projected.store.accountInfo.objectId, account.objectId);
    window.accountControl.retire();
    assert.equal(Object.hasOwn(window, "$_TSR"), false, "Retirement cannot restore a global Microsoft deleted.");
    assert.equal(Object.hasOwn(window, "__backgroundLoaderData"), scenario === "branch-switch");
    assert.equal(Object.hasOwn(window, "__m365TanstackClientBooted"), false);
});

test("staged accounts cannot cross same-URL reloads, stale realm callbacks or failed document completion", async () => {
    const frame = { id: "root", loaderId: "old", url: app + "/home" };
    const pending = Promise.withResolvers();
    const metadata = { state: "available", branch: "tanstack",
        projected: { store: { accountInfo: account } } };
    let wait = false, reads = 0, expectedRealm = "realm-1";
    const protocol = stagedProtocol(frame, input => {
        reads++;
        assert.equal(input.uniqueContextId, expectedRealm);
        return wait ? pending.promise : metadata;
    });
    const observer = await observeBrowserAccountDocument({}, protocol);
    const response = () => protocol.emit("Network.responseReceived", { type: "Document", frameId: frame.id,
        requestId: frame.loaderId, loaderId: frame.loaderId, response: { url: frame.url, status: 200, mimeType: "text/html" } });
    response();
    assert.equal(await observer.read(() => {}), null);
    assert.equal(reads, 0);
    protocol.emit("Network.loadingFinished", { requestId: "old" });
    wait = true;
    const oldRead = observer.read(() => {});
    await new Promise(resolve => setImmediate(resolve));
    frame.loaderId = "new";
    protocol.emit("Page.frameNavigated", { frame: { ...frame } });
    protocol.emit("Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "realm-1" });
    protocol.emit("Runtime.executionContextCreated", { context: { id: 1, uniqueId: "realm-2",
        auxData: { isDefault: true, frameId: frame.id } } });
    response();
    pending.resolve(metadata);
    assert.equal(await oldRead, null, "A same numeric context ID never makes an old unique realm current.");
    wait = false; expectedRealm = "realm-2";
    protocol.emit("Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "realm-1" });
    protocol.emit("Network.loadingFinished", { requestId: "new" });
    assert.equal((await observer.read(() => {}))?.subjectId, account.objectId,
        "Late destruction of the old unique realm cannot remove its same-numbered replacement.");
    response();
    protocol.emit("Network.loadingFailed", { requestId: "new" });
    protocol.emit("Network.loadingFinished", { requestId: "new" });
    assert.equal(await observer.read(() => {}), null);
    assert.equal(reads, 2, "Failed completion cannot publish staged identity or inspect a replacement.");
    await observer.retire();
});

test("passive account projection reads only original nonsecret data properties", () => {
    const source = hydration({ ...account });
    for (const target of [source, source.router.dehydratedData.copilotBootstrap.loaderData.root.store,
        source.router.dehydratedData.copilotBootstrap.loaderData.root.store.accountInfo]) {
        Object.defineProperty(target, "accessToken", { get() { assert.fail("Credentials must stay opaque."); } });
    }
    const window = { $_TSR: source }, before = Object.getOwnPropertyDescriptors(window);
    const read = () => runInNewContext(`(${readNativeAccountMetadata.toString()})()`, { window });
    assert.deepEqual(JSON.parse(JSON.stringify(read())), {
        store: { accountInfo: account, identity: { userPrincipalName: "fixture@example.test" } },
    });
    assert.deepEqual(Object.getOwnPropertyDescriptors(window), before);
    Object.defineProperty(source.router.dehydratedData.copilotBootstrap.loaderData.root.store.accountInfo,
        "tenantId", { get() { assert.fail("An account accessor is not original metadata."); } });
    assert.throws(read, /NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED/);
});

test("the explicit background-loader branch uses the same original account contract without consulting inactive globals", () => {
    const window = { __backgroundSSR: true, __backgroundLoaderData: hydration(account).router.dehydratedData.copilotBootstrap.loaderData };
    const read = () => JSON.parse(JSON.stringify(runInNewContext(`(${readNativeAccountMetadata.toString()})(true)`, { window })));
    for (const key of ["$_TSR", "accessToken", "__backgroundQueryState"]) {
        Object.defineProperty(window, key, { get() { assert.fail("Inactive state and tokens must not be inspected."); }, configurable: true });
    }
    assert.deepEqual(read(), { state: "available", branch: "background-loader",
        projected: { store: { accountInfo: account, identity: { userPrincipalName: "fixture@example.test" } } } });
    delete window.__backgroundLoaderData;
    assert.equal(read().state, "bootstrap-loader-unavailable", "Missing active data cannot fall back to a different source.");
    window.__backgroundLoaderData = { first: { store: { accountInfo: account } },
        second: { store: { accountInfo: { ...account, objectId: "other-subject" } } } };
    assert.throws(read, /NATIVE_SOURCE_ACCOUNT_MISMATCH/);
    Object.defineProperty(window, "__backgroundLoaderData", { get() { assert.fail("Do not invoke loader accessors."); }, configurable: true });
    assert.throws(read, /NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED/);
    for (const flag of [null, "true", 1, {}]) {
        window.__backgroundSSR = flag;
        assert.throws(read, /NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED/);
    }
    window.__backgroundSSR = false;
    Object.defineProperty(window, "$_TSR", { value: hydration(account), configurable: true });
    assert.equal(read().branch, "tanstack", "False selects TanStack and must not inspect the inactive background loader.");
    Object.defineProperty(window, "__backgroundSSR", { get() { assert.fail("The branch selector must be original data."); } });
    assert.throws(read, /NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED/);
});

for (const pathname of ["/chat", "/chat/work", "/landingv2"])
test(`identity requires the completed original current Microsoft document, not a loaded page or cached metadata: ${pathname}`, async () => {
    const origin = pathname === "/landingv2" ? "https://copilot.cloud.microsoft" : app;
    const frame = { id: "root", loaderId: "original", url: origin + pathname };
    const projected = { store: hydration(account).router.dehydratedData.copilotBootstrap.loaderData.root.store };
    let reads = 0, replaceDuringRead = false;
    const protocol = stagedProtocol(frame, () => {
        reads++;
        if (replaceDuringRead) frame.loaderId = "replacement";
        return { state: "available", branch: "tanstack", projected };
    });
    const observer = await observeBrowserAccountDocument({}, protocol);
    const emit = change => protocol.emit("Network.responseReceived", { type: "Document", frameId: "root",
        requestId: "original", loaderId: "original",
        response: { url: frame.url, status: 200, mimeType: "text/html", ...change } });
    const check = () => {}, finish = () => protocol.emit("Network.loadingFinished", { requestId: "original" });
    assert.equal(await observer.read(check), null);
    assert.equal(reads, 0);
    for (const change of [{ fromDiskCache: true }, { fromServiceWorker: true }, { status: 401 },
        { url: "https://example.invalid/chat" }, { mimeType: "application/json" }]) {
        emit(change); finish();
        assert.equal(await observer.read(check), null);
        assert.equal(reads, 0);
    }
    emit({});
    assert.equal(await observer.read(check), null);
    finish();
    assert.equal((await observer.read(check)).subjectId, account.objectId);
    frame.url = origin + "/home";
    assert.equal((await observer.read(check))?.subjectId, account.objectId,
        "The known home destination must preserve same-document original account verification.");
    frame.url = origin + "/chat/work";
    assert.equal((await observer.read(check)).subjectId, account.objectId);
    frame.url = origin + "/chat/arbitrary";
    assert.equal(await observer.read(check), null);
    assert.equal(observer.failurePredicate(), "passive-frame-path-changed");
    frame.url = (origin === app ? "https://copilot.cloud.microsoft" : app) + "/home";
    assert.equal(await observer.read(check), null, "Even another Microsoft app origin cannot reuse the original document proof.");
    assert.equal(observer.failurePredicate(), "passive-frame-origin-changed");
    frame.url = origin + pathname;
    await assert.rejects(observer.read(check, "different@example.test"), { code: "wrong-account" });
    replaceDuringRead = true;
    assert.equal(await observer.read(check), null);
    frame.loaderId = "original";
    await observer.retire();
    assert.equal(await observer.read(check), null);
    assert.equal(protocol.listenerCount("Network.responseReceived"), 0);
});

test("passive evidence distinguishes an unsupported path from missing identity without inspecting its contents", async () => {
    const frame = { id: "root", loaderId: "original",
        url: app + "/chat/work/unsupported?PRIVATE_QUERY=PRIVATE_VALUE#PRIVATE_FRAGMENT" };
    const methods = [];
    const protocol = stagedProtocol(frame, () => {
        assert.fail("An unqualified document must not be read, even when it contains a valid account.");
    }, methods);
    const observer = await observeBrowserAccountDocument({}, protocol);
    protocol.emit("Network.responseReceived", { type: "Document", frameId: "root", loaderId: "original", requestId: "original",
        response: { url: frame.url, status: 200, mimeType: "text/html" } });
    protocol.emit("Network.loadingFinished", { requestId: "original" });
    assert.equal(await observer.read(() => {}), null);
    assert.equal(observer.failurePredicate(), "passive-document-path-unqualified");
    assert.deepEqual(methods, ["Page.getFrameTree", "Network.enable", "Page.enable", "Runtime.enable", "Page.addScriptToEvaluateOnNewDocument"]);
    await observer.retire();
});

test("passive bootstrap prerequisites are bounded evidence rather than account or authentication content", async () => {
    const frame = { id: "root", loaderId: "original", url: app + "/chat/work" };
    let window = {};
    const protocol = stagedProtocol(frame, () => runInNewContext(`(${readNativeAccountMetadata.toString()})(true)`, { window }));
    const observer = await observeBrowserAccountDocument({}, protocol);
    protocol.emit("Network.responseReceived", { type: "Document", frameId: "root", requestId: "original", loaderId: "original",
        response: { url: frame.url, status: 200, mimeType: "text/html" } });
    protocol.emit("Network.loadingFinished", { requestId: "original" });
    for (const [state, expected] of [
        [{}, "bootstrap-unavailable"],
        [{ $_TSR: { initialized: false } }, "bootstrap-uninitialized"],
        [{ $_TSR: { initialized: true } }, "bootstrap-loader-unavailable"],
        [{ $_TSR: { initialized: true, router: { dehydratedData: { copilotBootstrap: { loaderData: {} } } } } }, "account-unavailable"],
    ]) {
        window = state;
        Object.defineProperty(window, "accessToken", { get() { assert.fail("No credential getter may run."); } });
        assert.equal(await observer.read(() => {}), null);
        assert.equal(observer.failurePredicate(), "passive-" + expected);
        const detail = { ...nativeFailureDetails(withNativeFailurePredicate(new Error("PRIVATE_UNRETAINED"), "connect",
            observer.failurePredicate())), recordedAt: new Date().toISOString() };
        assert.equal(validNativeFailure(detail), true);
        assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_|https:|objectId|tenantId|accessToken/);
        assert.equal(validNativeFailure({ ...detail, predicate: { ...detail.predicate, name: "passive-PRIVATE_UNKNOWN" } }), false);
        assert.equal(validNativeFailure({ ...detail, predicate: { ...detail.predicate, url: frame.url } }), false);
    }
    window = { $_TSR: hydration(account) };
    Object.defineProperty(window.$_TSR, "initialized", { get() { throw new Error("PRIVATE_ACCESSOR"); } });
    await assert.rejects(observer.read(() => {}), /NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED/);
    assert.equal(observer.failurePredicate(), "passive-bootstrap-invalid");
    window = { $_TSR: hydration({ ...account, accountType: "MSA" }) };
    await assert.rejects(observer.read(() => {}), { code: "NATIVE_SOURCE_RESPONSE_UNQUALIFIED" });
    assert.equal(observer.failurePredicate(), "passive-account-rejected");
    await observer.retire();
});

for (const scenario of ["connect", "early-navigation", "cancel", "wrong-retained-account", "no-principal", "restart", "deadline", "nonwork",
    "work-route", "same-document-work-route", "unsupported-route",
    "work-route-wrong-retained-account", "work-route-nonwork",
    "landing-home", "landing-home-missing",
    "background-loader", "background-loader-wrong-account", "background-loader-nonwork", "background-loader-missing", "startup-cleanup",
    "startup-reload", "startup-failed-document", "startup-placeholder", "startup-conflict",
    "startup-cancel-late",
    "startup-retire-script-stalled", "startup-retire-evaluate-stalled", "startup-retire-close-unproved", "startup-deadline-retire-stalled",
    "connected-window-close", "late-owner-close"]) {
    test(`ordinary browser-owned Connect: ${scenario}`, { timeout: 30000 }, async t => {
        const backgroundLoader = scenario.startsWith("background-loader");
        const stalledRetirement = scenario.startsWith("startup-retire-") || scenario === "startup-deadline-retire-stalled";
        const deadlineRetirement = scenario === "startup-deadline-retire-stalled";
        const cleanups = [], { context: store } = await privateFixture({ after: work => cleanups.push(work) }, []);
        const browser = await chromium.launch({ channel: "msedge", headless: true, chromiumSandbox: true,
            args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"] });
        let host, context, contextReady = false, signIn = false, changeAccount = false, launches = 0, expireOnPassiveRead = false, appDocuments = 0;
        const commands = [], sent = [];
        const rootProtocol = browser.newBrowserCDPSession.bind(browser);
        t.mock.method(browser, "newBrowserCDPSession", async () => {
            const protocol = await rootProtocol(), send = protocol.send.bind(protocol);
            t.mock.method(protocol, "send", async (method, input) => {
                commands.push(method);
                assert.equal(method, "Fetch.enable");
                assert.deepEqual(input, { patterns: [
                    { urlPattern: "*/v1/conversations/*/client-tool-*", requestStage: "Request" },
                ] }, "Browser-wide scope must not turn into all-request or authentication interception.");
                return send(method, input);
            });
            return protocol;
        });
        const stagedRead = Promise.withResolvers(), releaseStagedRead = Promise.withResolvers();
        const releaseRetirement = Promise.withResolvers();
        let closeAttempts = 0, closeUnproved = scenario === "startup-retire-close-unproved", retirementReleased = false;
        t.after(async () => {
            closeUnproved = false;
            retirementReleased = true; releaseRetirement.resolve({});
            releaseStagedRead.resolve();
            try { await host?.close(); }
            finally { await browser.close(); for (const work of cleanups) await work(); }
        });
        t.mock.method(chromium, "launchPersistentContext", async (_directory, options) => {
            contextReady = false;
            launches++;
            assert.equal(options.headless, false, "Ordinary startup opens an attended window.");
            assert.equal(options.chromiumSandbox, true);
            assert.notEqual(options.ignoreHTTPSErrors, true);
            context = await browser.newContext({ serviceWorkers: "block" });
            const closeContext = context.close.bind(context);
            if (stalledRetirement) t.mock.method(context, "close", async () => {
                closeAttempts++;
                if (closeUnproved) throw new Error("Invented owned-close refusal.");
                return closeContext();
            });
            await context.newPage();
            // This unconditional test-owned route is the only network provider.
            await context.route("**/*", async route => {
                const request = route.request(), url = new URL(request.url());
                sent.push(url.origin + url.pathname);
                let body, contentType = "text/html";
                if (url.origin === app && url.pathname === "/chat" && !signIn) {
                    body = `<link rel="icon" href="data:,"><a href="https://login.microsoftonline.com/fixture">Sign in</a>`
                        + (scenario === "early-navigation" ? '<script src="https://slow-script.invalid/presentation.js"></script>' : "");
                } else if (url.origin === "https://login.microsoftonline.com") {
                    body = `<link rel="icon" href="data:,"><h1>Pick an account</h1>
                        <form method="post" action="${scenario.startsWith("landing-home") ? "https://copilot.cloud.microsoft/landingv2"
                            : app + (scenario.startsWith("work-route") ? "/chat/work"
                                : scenario === "unsupported-route" ? "/chat/work/unsupported" : "/home")}"><button>Fixture work account</button></form>
                        <script src="https://new-auth-dependency.invalid/unrecognized.js"></script>
                        <img src="https://new-images.invalid/signin.png">`;
                } else if (url.origin === app && ["/home", "/chat", "/chat/work", "/chat/work/unsupported"].includes(url.pathname)
                    || scenario.startsWith("landing-home") && url.origin === "https://copilot.cloud.microsoft" && url.pathname === "/landingv2") {
                    signIn = true;
                    appDocuments++;
                    const principal = changeAccount ? { ...account, objectId: "33333333-3333-4333-8333-333333333333" }
                        : ["nonwork", "work-route-nonwork", "background-loader-nonwork"].includes(scenario) ? { ...account, accountType: "MSA" } : account;
                    body = `<link rel="icon" href="data:,"><h1>Microsoft 365 Copilot</h1><script>
                        window.originalFetch=fetch;
                        ${backgroundLoader ? `window.__backgroundSSR=true;${scenario === "background-loader-missing" ? "" : `window.__backgroundLoaderData=
                            ${JSON.stringify(hydration(principal).router.dehydratedData.copilotBootstrap.loaderData)};`}
                            Object.defineProperty(window,"$_TSR",{get(){throw Error("Inactive TanStack branch must not be read");}});`
                            : ["no-principal", "deadline", "landing-home-missing"].includes(scenario) || deadlineRetirement
                                || scenario === "startup-reload" && appDocuments > 1 ? ""
                            : `window.$_TSR=${JSON.stringify({ ...hydration(scenario === "startup-placeholder" ? {} : principal), initialized: false })};
                                window.$_TSR.initialized=true;`}
                        ${scenario === "startup-placeholder" ? `setTimeout(()=>{window.$_TSR.router.dehydratedData.copilotBootstrap.loaderData.root.store.accountInfo=
                            ${JSON.stringify(principal)};},100);` : ""}
                        ${scenario === "startup-conflict" ? `window.$_TSR.router.dehydratedData.copilotBootstrap.loaderData.other=
                            {store:{accountInfo:${JSON.stringify({ ...account, objectId: "conflicting-subject" })}}};` : ""}
                        ${scenario === "startup-reload" && appDocuments === 1 ? "location.reload();" : ""}
                        ${scenario === "startup-cleanup" ? `
                            window.nativeHydratedAccount=window.$_TSR.router.dehydratedData.copilotBootstrap.loaderData.root.store.accountInfo.objectId;
                            window.$_TSR.h=()=>{window.fixtureHydrated=true;if(window.fixtureStreamEnded)delete window.$_TSR;return "native-h";};
                            window.$_TSR.e=()=>{window.fixtureStreamEnded=true;if(window.fixtureHydrated)delete window.$_TSR;return "native-e";};
                            const native=window.$_TSR;window.nativeResults=[native.h(),native.e()];
                            ` : ""}
                        ${scenario === "same-document-work-route" ? 'history.replaceState(null,"","/chat/work");' : ""}
                        ${scenario.startsWith("landing-home") ? 'history.replaceState(null,"","/home");' : ""}
                        fetch("/ordinary-background",{method:"POST",body:"invented-page-request"})
                            .then(r=>r.text()).then(text=>window.pageResult=text);
                        </script>`;
                } else if (url.pathname === "/ordinary-background") {
                    body = "unchanged-native-response"; contentType = "text/plain";
                } else if (url.hostname === "new-auth-dependency.invalid") {
                    body = "window.fixtureScriptRan=true"; contentType = "application/javascript";
                } else if (url.hostname === "new-images.invalid") {
                    body = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"); contentType = "image/gif";
                } else if (url.hostname === "slow-script.invalid") {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    body = ""; contentType = "application/javascript";
                } else assert.fail("Unimplemented offline request: " + url.origin + url.pathname);
                await route.fulfill({ status: scenario === "startup-failed-document" && url.pathname === "/home" ? 500 : 200,
                    contentType, body, headers: { "cache-control": "no-store" } });
            });
            const createProtocol = context.newCDPSession.bind(context);
            t.mock.method(context, "newCDPSession", async target => {
                const protocol = await createProtocol(target), send = protocol.send.bind(protocol);
                t.mock.method(protocol, "send", async (method, input) => {
                    commands.push(method);
                    if (method.startsWith("Fetch.")) {
                        assert.equal(method, "Fetch.enable");
                        assert.deepEqual(input, { patterns: [
                            { urlPattern: "*/v1/conversations/*/client-tool-*", requestStage: "Request" },
                        ] }, "Connect may deny only the known execution protocol, not intercept ordinary auth traffic.");
                    }
                    assert.ok(!["Network.getResponseBody", "Network.getRequestPostData", "Network.getCookies",
                        "Storage.getCookies", "Network.setCacheDisabled"].includes(method));
                    if (method === "Page.addScriptToEvaluateOnNewDocument") {
                        assert.doesNotMatch(input.source, /window\.fetch|originalFetch|pinnedChats|conversationPageHistoryList|exposeBinding/);
                    }
                    if (stalledRetirement && (scenario === "startup-retire-evaluate-stalled"
                        ? method === "Runtime.evaluate" && input.expression?.endsWith("?.retire()")
                        : method === "Page.removeScriptToEvaluateOnNewDocument")) {
                        return releaseRetirement.promise;
                    }
                    const result = await send(method, input);
                    if (scenario === "startup-cancel-late" && method === "Runtime.evaluate"
                        && input.expression?.endsWith("?.read()") && result.result?.value?.state === "available") {
                        stagedRead.resolve();
                        await releaseStagedRead.promise;
                    }
                    if (expireOnPassiveRead && method === "Runtime.evaluate" && input.expression?.endsWith("?.read()")) {
                        const expired = Date.now() + 90001;
                        t.mock.method(Date, "now", () => expired);
                    }
                    return result;
                });
                return protocol;
            });
            t.mock.method(context, "route", () => assert.fail("WIRE must not install a login request gate."));
            t.mock.method(context, "routeWebSocket", () => assert.fail("WIRE must not replace sign-in socket behavior."));
            const addInitScript = context.addInitScript.bind(context), exposeBinding = context.exposeBinding.bind(context);
            t.mock.method(context, "addInitScript", script => {
                assert.match(script.content, /installNativeToolGuard/);
                assert.doesNotMatch(script.content, /installCoworkReadHost|listTasks|listMessages|principal/);
                return addInitScript(script);
            });
            t.mock.method(context, "exposeBinding", (name, callback) => {
                assert.match(name, /^__wireNativeToolGuard_[a-f0-9]+_notify$/);
                return exposeBinding(name, callback);
            });
            contextReady = true;
            return context;
        });
        host = await createMicrosoftNativeHost(store, { sourceAware: true, ordinaryStartup: true });
        const owner = "browser-owned-fixture", admission = { owner, check() {}, dispatched() {} };
        const enrollment = await host.access.nativeEnrollmentStatus(admission);
        const prepared = await host.access.prepareNativeEnrollment({ schemaVersion: 2, generation: enrollment.generation,
            operationId: randomUUID() }, admission);
        assert.equal(prepared.phase, "prepared");
        assert.equal(launches, 0);
        const configuration = await readMicrosoftNativeConfiguration(path.join(store.dataDir, "microsoft-source.json"));
        assert.equal(Object.hasOwn(configuration, "expectedAccount"), false);
        assert.equal((await host.access.status()).collection, "paused");
        const command = async action => host.access.command(owner, { schemaVersion: 1, action,
            operationId: randomUUID(), generation: (await host.access.status()).generation }, () => true);
        const connecting = command("microsoft-connect");
        while (!contextReady) await new Promise(resolve => setTimeout(resolve, 10));
        const page = context.pages()[0];
        await page.getByText("Sign in", { exact: true }).click();
        await page.getByRole("heading", { name: "Pick an account" }).waitFor();
        assert.ok(sent.includes("https://new-auth-dependency.invalid/unrecognized.js"));
        if (scenario === "cancel") {
            assert.equal((await command("microsoft-cancel")).outcome, "completed");
            assert.equal((await connecting).outcome, "cancelled");
            assert.notEqual((await host.access.status()).microsoft.state, "connected");
            return;
        }
        await page.getByRole("button", { name: "Fixture work account" }).click();
        if (stalledRetirement) {
            if (deadlineRetirement) expireOnPassiveRead = true;
            const pending = Symbol("retirement-blocked");
            let timer;
            const receipt = await Promise.race([connecting,
                new Promise(resolve => { timer = setTimeout(() => resolve(pending), 3000); })]);
            clearTimeout(timer);
            assert.notEqual(receipt, pending, "A stalled retirement must not prevent attempted owned closure.");
            assert.equal(retirementReleased, false);
            assert.equal(receipt.outcome, "failed");
            assert.equal(receipt.reason, deadlineRetirement ? "timed-out" : "transport-failed");
            assert.equal(closeAttempts, 1);
            const state = JSON.parse(await readFile(path.join(store.dataDir, "microsoft-session", "session.json"), "utf8"));
            const original = state.receipts.find(row => row.operationId === receipt.operationId);
            assert.equal(original.nativeEvidence.firstFailure.code, deadlineRetirement ? "timed-out" : "NATIVE_ACCOUNT_STARTUP_RETIRE_TIMEOUT");
            assert.equal(original.nativeEvidence.cleanup.state, closeUnproved ? "failed" : "completed");
            assert.equal(state.connection, closeUnproved ? "recovery-required" : "disconnected");
            assert.equal(state.partition, null);
            if (closeUnproved) assert.ok(state.owner, "Unproved owned cleanup retains custody evidence.");
            else assert.equal(state.owner, null);
            const commandsBeforeLateReply = commands.length;
            releaseRetirement.resolve({});
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.equal(commands.length, commandsBeforeLateReply, "A late protocol reply cannot resume cleanup or verification.");
            const unchanged = JSON.parse(await readFile(path.join(store.dataDir, "microsoft-session", "session.json"), "utf8"));
            assert.deepEqual(unchanged.receipts.find(row => row.operationId === receipt.operationId), original);
            return;
        }
        if (["nonwork", "work-route-nonwork", "background-loader-nonwork", "startup-conflict"].includes(scenario)) {
            assert.equal((await connecting).outcome, "failed");
            assert.notEqual((await host.access.status()).microsoft.state, "connected");
            return;
        }
        await page.waitForFunction(() => window.pageResult === "unchanged-native-response");
        assert.equal(await page.evaluate(() => fetch === originalFetch
            && Function.prototype.toString.call(fetch).includes("[native code]")), true);
        if (scenario === "startup-cancel-late") {
            await stagedRead.promise;
            const cancellation = command("microsoft-cancel");
            assert.equal((await cancellation).outcome, "completed");
            releaseStagedRead.resolve();
            assert.equal((await connecting).outcome, "cancelled");
            assert.notEqual((await host.access.status()).microsoft.state, "connected");
            return;
        }
        if (["no-principal", "landing-home-missing", "background-loader-missing", "startup-reload", "startup-failed-document"].includes(scenario)) {
            await new Promise(resolve => setTimeout(resolve, 250));
            assert.notEqual((await host.access.status()).microsoft.state, "connected");
            await command("microsoft-cancel");
            assert.equal((await connecting).outcome, "cancelled");
            return;
        }
        if (["deadline", "unsupported-route"].includes(scenario)) {
            if (scenario !== "deadline") {
                assert.equal(await page.evaluate(() => window.$_TSR.initialized), true);
                assert.deepEqual(await page.evaluate(readNativeAccountMetadata), {
                    store: { accountInfo: account, identity: { userPrincipalName: "fixture@example.test" } },
                }, "A genuine documented native route with original account metadata is not a missing-identity fixture.");
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            if (scenario === "deadline") expireOnPassiveRead = true;
            else {
                const expired = Date.now() + 90001;
                t.mock.method(Date, "now", () => expired);
            }
            const receipt = await connecting;
            assert.equal(receipt.reason, "timed-out");
            assert.notEqual((await host.access.status()).microsoft.state, "connected");
            const saved = JSON.parse(await readFile(path.join(store.dataDir, "microsoft-session", "session.json"), "utf8"));
            assert.deepEqual(saved.receipts.find(row => row.operationId === receipt.operationId).nativeEvidence.firstFailure.predicate, {
                schemaVersion: 1, stage: "connect",
                name: scenario === "unsupported-route" ? "passive-document-path-unqualified" : "passive-metadata-read-pending",
            });
            assert.equal(receipt.nativeEvidence, undefined, "Passive evidence stays in the original private receipt.");
            assert.doesNotMatch(JSON.stringify(saved), /fixture@example|PRIVATE_|originalFetch|unchanged-native-response/);
            return;
        }
        if (scenario === "startup-cleanup") {
            assert.equal(await page.evaluate(() => Object.hasOwn(window, "$_TSR")), false);
            assert.deepEqual(await page.evaluate(() => nativeResults), ["native-h", "native-e"]);
            assert.equal(await page.evaluate(() => nativeHydratedAccount), account.objectId);
            const pending = Symbol("still-pending");
            assert.notEqual(await Promise.race([connecting, new Promise(resolve => setTimeout(() => resolve(pending), 2000))]), pending,
                "Native cleanup before document verification must not erase staged original account proof.");
        }
        if (["work-route", "same-document-work-route", "landing-home", "background-loader"].includes(scenario)) {
            assert.deepEqual(await page.evaluate(readNativeAccountMetadata), {
                store: { accountInfo: account, identity: { userPrincipalName: "fixture@example.test" } },
            }, "The documented native route has genuine original bootstrap account evidence.");
            const pending = Symbol("still-pending");
            assert.notEqual(await Promise.race([connecting, new Promise(resolve => setTimeout(() => resolve(pending), 2000))]), pending,
                "The passive verifier must accept the documented native route without waiting for its timeout.");
        }
        const receipt = await connecting;
        assert.equal(receipt.outcome, "completed");
        assert.equal((await host.access.status()).microsoft.state, "connected");
        assert.equal((await host.access.nativeCollectionControl()).enabled, false);
        assert.equal((await host.access.status()).collection, "paused");
        assert.ok(commands.includes("Browser.setWindowBounds"));
        assert.ok(commands.includes("Page.removeScriptToEvaluateOnNewDocument"));
        assert.equal(await page.evaluate(() => Object.getOwnPropertyNames(window).some(name => name.startsWith("__wireAccountStartup_"))), false);
        assert.ok(sent.includes("https://new-images.invalid/signin.png"));
        const saved = await readFile(path.join(store.dataDir, "microsoft-session", "session.json"), "utf8");
        assert.doesNotMatch(saved, /invented-page-request|unchanged-native-response|new-auth-dependency/);
        if (scenario === "connected-window-close") {
            await page.close();
            for (let attempt = 0; attempt < 100 && (await host.access.status()).microsoft.state === "connected"; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            const status = await host.access.status();
            assert.equal(status.microsoft.state, "reconnect-required");
            assert.equal(status.wire, "signed-in");
            assert.equal(status.collection, "paused");
            const after = JSON.parse(await readFile(path.join(store.dataDir, "microsoft-session", "session.json"), "utf8"));
            assert.equal(after.partition, JSON.parse(saved).partition);
            const original = after.receipts.find(row => row.operationId === receipt.operationId);
            assert.equal(original.outcome, "completed");
            assert.equal(original.generation, receipt.generation);
            assert.equal(original.reason, null, "Losing an idle owner must not rewrite successful sign-in as cancellation.");
            assert.equal(original.nativeEvidence?.firstFailure?.code, "NATIVE_SOURCE_PAGE_CLOSED");
            assert.deepEqual(original.nativeEvidence.firstFailure.predicate,
                { schemaVersion: 1, stage: "completion", name: "native-owner-lost" });
            assert.equal(launches, 1, "Owner loss must not reconnect automatically.");
            return;
        }
        if (scenario === "late-owner-close") {
            const previousContext = context;
            assert.equal((await command("microsoft-connect")).outcome, "completed");
            page.emit("close");
            page.emit("crash");
            previousContext.emit("close");
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.equal((await host.access.status()).microsoft.state, "connected");
            assert.equal((await host.access.nativeCollectionControl()).enabled, false);
            assert.equal(context.pages().length, 1);
            assert.equal(launches, 2);
            return;
        }
        if (["wrong-retained-account", "work-route-wrong-retained-account", "background-loader-wrong-account"].includes(scenario)) {
            const partition = JSON.parse(saved).partition;
            changeAccount = true;
            const reconnect = await command("microsoft-connect");
            assert.equal(reconnect.outcome, "failed");
            assert.equal(reconnect.reason, "wrong-account");
            const after = JSON.parse(await readFile(path.join(store.dataDir, "microsoft-session", "session.json"), "utf8"));
            assert.equal(after.partition, partition, "An equal label cannot rekey the retained account.");
        } else {
            await command("wire-sign-out");
            await assert.rejects(host.access.read(owner), { code: "wire_access_revoked" });
            assert.deepEqual(context.pages(), []);
            if (scenario === "restart") {
                await host.close();
                host = await createMicrosoftNativeHost(store, { configuration, sourceAware: true,
                    nativeAcquisition: true, ordinaryStartup: true });
                assert.equal(launches, 1, "Restart neither reconnects nor opens the profile.");
                await assert.rejects(host.access.read(owner), { code: "wire_access_revoked" });
                assert.equal((await command("wire-sign-in")).outcome, "completed");
                assert.equal((await command("microsoft-connect")).outcome, "completed");
                assert.equal(launches, 2);
                assert.equal((await host.access.nativeCollectionControl()).enabled, false);
            }
        }
    });
}
