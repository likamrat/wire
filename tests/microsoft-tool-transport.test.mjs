import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createNativeToolTransportDenial, installNativeToolGuard } from "../lib/microsoft-native-tool-transport.mjs";
import { protectNativeToolTransport } from "../lib/microsoft-native-tool-guard.mjs";
import { protectNativeBrowserProtocol } from "../lib/microsoft-native-browser-protocol.mjs";
import { inventedToolBridge } from "./microsoft-tool-transport-fixture.mjs";
import { nativeFailureDetails, validNativeFailure } from "../lib/microsoft-session-state.mjs";
import { COWORK_COMPOSITION_ENTRY, COWORK_COMPOSITION_MANIFEST } from "../lib/microsoft-cowork-composition.mjs";

function browserProtocolFixture(context, protocol = new EventEmitter()) {
    let closed = false;
    context.once("close", () => { closed = true; });
    protocol.send ??= async () => {};
    protocol.detach ??= async () => {};
    const browser = { contexts: () => [context], newBrowserCDPSession: async () => protocol, isConnected: () => !closed };
    context.browser = () => browser;
    return protocol;
}

test("native reconnect denial blocks later identity/tool listeners and every reconnect without altering native methods", () => {
    const Bridge = inventedToolBridge(), original = Bridge.prototype.postMessageWithStaleRetry;
    const gate = createNativeToolTransportDenial({ getBridgeClass: () => Bridge, assertOwner() {},
        onFailure() { assert.fail("The original native port contract is available."); } });
    const bridge = Bridge.instance();
    bridge.addReconnectListener(port => port.postMessage({ eventName: "Edge.UseCoworkIdentity" }));
    for (const name of ["Edge.ToolAction", "Edge.SetCoworkActionConsent", "Edge.ShowTabs", "UnknownFutureTool"]) {
        assert.equal(bridge.send(name), false);
    }
    assert.equal(Bridge.prototype.postMessageWithStaleRetry, original);
    assert.deepEqual(Bridge.sent, []);
    assert.equal(gate.deniedConnections, 5, "The first send and each native stale-port retry acquire a denied port.");
    gate.assertCurrent();
});

test("native transport denial refuses an already active or previously subscribed bridge", () => {
    for (const previous of ["port", "listener", "reconnect"]) {
        const Bridge = inventedToolBridge(), bridge = Bridge.instance();
        if (previous === "port") bridge.port = {};
        if (previous === "listener") bridge.listeners.add(() => {});
        if (previous === "reconnect") bridge.reconnectListeners.add(() => {});
        assert.throws(() => createNativeToolTransportDenial({ getBridgeClass: () => Bridge, assertOwner() {}, onFailure() {} }),
            { code: "NATIVE_TOOL_TRANSPORT_ALREADY_ACTIVE" });
    }
});

test("native transport denial stays installed after owner withdrawal and rejects removal", () => {
    const Bridge = inventedToolBridge();
    let live = true;
    const gate = createNativeToolTransportDenial({ getBridgeClass: () => Bridge,
        assertOwner() { if (!live) throw new Error("Owner withdrawn"); }, onFailure() {} });
    live = false;
    assert.equal(Bridge.instance().send("Edge.ToolAction"), false);
    assert.deepEqual(Bridge.sent, []);
    Bridge.instance().reconnectListeners.clear();
    assert.throws(gate.assertCurrent);
});

test("native transport denial permanently rejects registration-time owner loss even if ownership returns", () => {
    const Bridge = inventedToolBridge(), bridge = Bridge.instance(), subscribe = bridge.addReconnectListener;
    let live = true;
    const failures = [];
    bridge.addReconnectListener = function (work) { const result = subscribe.call(this, work); live = false; return result; };
    assert.throws(() => createNativeToolTransportDenial({ getBridgeClass: () => Bridge,
        assertOwner() { if (!live) throw new Error("Owner withdrawn during registration"); },
        onFailure: code => failures.push(code) }));
    live = true;
    assert.equal(bridge.send("Edge.ToolAction"), false);
    assert.deepEqual(Bridge.sent, []);
    assert.deepEqual(failures, ["NATIVE_TOOL_TRANSPORT_GUARD_LOST"]);
});

test("an unqualified native port retires the owner and cannot be described as executor exclusion", () => {
    for (const disconnect of [undefined, () => Promise.resolve(), () => { throw new Error("Denied by platform"); }]) {
        const Bridge = inventedToolBridge(), failures = [];
        const gate = createNativeToolTransportDenial({ getBridgeClass: () => Bridge, assertOwner() {},
            onFailure: code => failures.push(code) });
        const deny = [...Bridge.instance().reconnectListeners][0];
        assert.throws(() => deny({ disconnect }));
        assert.deepEqual(failures, ["NATIVE_TOOL_TRANSPORT_DENIAL_UNCONFIRMED"]);
        assert.equal(gate.deniedConnections, 0);
        assert.throws(gate.assertCurrent, { code: "NATIVE_TOOL_TRANSPORT_GUARD_LOST" });
    }
});

test("native transport denial refuses changed factory, sender or port acquisition references", () => {
    for (const method of ["instance", "ensurePort", "postMessageWithStaleRetry"]) {
        const Bridge = inventedToolBridge();
        const gate = createNativeToolTransportDenial({ getBridgeClass: () => Bridge, assertOwner() {}, onFailure() {} });
        const owner = method === "instance" ? Bridge : Bridge.prototype;
        const original = owner[method];
        owner[method] = function (...args) { return original.apply(this, args); };
        assert.throws(gate.assertCurrent, { code: "NATIVE_TOOL_TRANSPORT_GUARD_LOST" });
    }
});

function realmGuardFixture({ holdReady = false, activeBridge = false, missing = null, nativeEntry } = {}) {
    const ready = Promise.withResolvers(), notices = [], events = new Map(), Bridge = inventedToolBridge();
    let acknowledged = true;
    const entry = nativeEntry ?? "https://invented.invalid/entry.js";
    const state = { isConsented: false, isEdgeIdentityMatched: false, isSimpleBrowserSupported: false };
    if (activeBridge) state.isSimpleBrowserSupported = true;
    const clientHook = () => ({});
    const runtime = id => id === 476712 ? { x: clientHook }
        : { H_: { getState: () => state, subscribe: () => () => {} } };
    runtime.m = { 476712: true, 175081: true };
    if (missing === "bridge") delete runtime.m[476712];
    if (missing === "capability") delete runtime.m[175081];
    if (missing === "both") runtime.m = {};
    const window = { addEventListener: (name, work) => events.set(name, work),
        notify(value) { notices.push(value); return value.kind === "ready" && holdReady ? ready.promise : { acknowledged }; } };
    const container = { async get() { return () => {}; } };
    window.coworker = container;
    const context = vm.createContext({ window, location: { origin: "https://m365.cloud.microsoft" },
        crypto: { randomUUID }, console });
    vm.runInContext(`(${installNativeToolGuard.toString()})(${JSON.stringify({
        binding: "notify", control: "guard", entry, manifest: COWORK_COMPOSITION_MANIFEST,
    })},${createNativeToolTransportDenial.toString()});`, context);
    const publishRuntime = next => window.chunk_coworker[0][2](next);
    if (missing !== "runtime") publishRuntime(runtime);
    return { ready, notices, Bridge, runtime, publishRuntime, container, window, control: window.guard,
        withdraw: () => { acknowledged = false; },
        hide: () => events.get("pagehide")(),
        async expose(overrides = {}, version = "2.9.2", expose = "./CoworkNav", moduleFactory) {
            const plugin = window.__FEDERATION__.__GLOBAL_PLUGIN__[0].apply({ version });
            const event = { expose, remoteEntryExports: container, moduleInfo: { name: "coworker", entry, ...overrides } };
            const original = expose === "./CoworkNav"
                ? await plugin.getModuleFactory?.(event) ?? await container.get(expose) : moduleFactory;
            await plugin.afterGetExpose({ ...event, moduleFactory: moduleFactory ?? original });
            return moduleFactory ?? original;
        } };
}

test("native beforeInit selects the exact reviewed manifest before registration without replacing shared host options", () => {
    const fixture = realmGuardFixture({ nativeEntry: COWORK_COMPOSITION_ENTRY });
    const host = { version: "2.9.2", moduleCache: new Map() };
    const hooks = fixture.window.__FEDERATION__.__GLOBAL_PLUGIN__[0].apply(host);
    const shared = { react: { native: true } }, other = { name: "unrelated", entry: "https://other.invalid/module.js" };
    const nativeRemote = { name: "coworker", entry: "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/version.json", shareScope: "default" };
    const userOptions = { name: "coworker-host", remotes: [nativeRemote, other], shared };
    const options = { remotes: [] }, original = { origin: host, options, userOptions, shareInfo: {} };
    const selected = hooks.beforeInit(original);
    assert.equal(selected.origin, host);
    assert.equal(selected.options, options);
    assert.equal(selected.userOptions.shared, shared);
    assert.equal(selected.userOptions.remotes[1], other);
    assert.deepEqual({ ...selected.userOptions.remotes[0] }, { ...nativeRemote, entry: COWORK_COMPOSITION_MANIFEST });
    assert.match(nativeRemote.entry, /\/latest\/version\.json$/, "Do not rewrite the original host options object.");
    for (const remote of selected.userOptions.remotes) {
        hooks.beforeRegisterRemote({ remote });
        options.remotes.push(remote);
        hooks.registerRemote({ remote });
    }
    assert.equal(new URL("coworker.8d98ec00.js", options.remotes[0].entry).href, COWORK_COMPOSITION_ENTRY);
    assert.throws(() => hooks.beforeRegisterRemote({ remote: nativeRemote }), { code: "NATIVE_TOOL_VERSION_SELECTION_UNQUALIFIED" });
});

test("native version selection refuses an already loaded or differently registered Cowork source", () => {
    for (const loaded of [false, true]) {
        const fixture = realmGuardFixture();
        const host = { version: "2.9.2", moduleCache: new Map(loaded ? [["coworker", {}]] : []) };
        const hooks = fixture.window.__FEDERATION__.__GLOBAL_PLUGIN__[0].apply(host);
        const remote = { name: "coworker", entry: "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/version.json" };
        assert.throws(() => hooks.beforeInit({ options: { remotes: loaded ? [] : [remote] },
            userOptions: { remotes: [remote] } }), { code: "NATIVE_TOOL_VERSION_SELECTION_UNQUALIFIED" });
    }
});

test("a substituted CoworkNav factory is refused before execution even with the expected native source and container", async () => {
    const fixture = realmGuardFixture();
    let executions = 0;
    const substitute = () => { executions++; };
    await assert.rejects(fixture.expose({}, "2.9.2", "./CoworkNav", substitute).then(substitute),
        { code: "NATIVE_TOOL_NAV_FACTORY_UNQUALIFIED" });
    assert.equal(executions, 0);
    assert.equal(fixture.notices.find(value => value.kind === "failed").code, "NATIVE_TOOL_NAV_FACTORY_UNQUALIFIED");
    assert.throws(fixture.control.assertCurrent);
});

test("the bound native navigation factory is load-only until accepted and cannot run after its document retires", async () => {
    const fixture = realmGuardFixture();
    let executions = 0;
    fixture.container.get = async () => function () { executions++; return this; };
    const factory = await fixture.expose();
    assert.equal(executions, 0);
    const receiver = {};
    assert.equal(factory.call(receiver), receiver);
    fixture.hide();
    assert.throws(factory, { code: "NATIVE_TOOL_GUARD_RETIRED" });
    assert.equal(executions, 1);
});

test("valid native CoworkNav and Coworker factories wait for load-only bridge dependencies before any consumer executes", async () => {
    // The current native get loads dependencies but does not execute the
    // returned Customize factory. Coworker must be WIRE's exact replacement.
    for (const [expose, missing] of [["./CoworkNav", "bridge"], ["./Coworker", "both"]]) {
        const fixture = realmGuardFixture({ missing }), loading = Promise.withResolvers(), entered = Promise.withResolvers();
        const order = [];
        let customizeExecutions = 0, originalExecutions = 0;
        const get = async name => {
            if (name === "./CoworkNav") return () => {};
            assert.equal(name, "./Customize");
            order.push("loading"); entered.resolve();
            await loading.promise;
            fixture.runtime.m[476712] = fixture.runtime.m[175081] = true;
            order.push("registered");
            return () => { customizeExecutions++; };
        };
        Object.defineProperty(fixture.container, "get", { get: () => get });
        // The original parent awaits afterGetExpose before executing its factory.
        const reader = () => {};
        if (expose === "./Coworker") fixture.control.acceptReaderFactory(reader);
        const selected = fixture.expose({}, "2.9.2", expose, expose === "./Coworker" ? reader : undefined).then(() => {
            order.push("original-factory"); originalExecutions++;
        });
        await Promise.race([entered.promise, selected]);
        assert.equal(originalExecutions, 0);
        loading.resolve();
        await selected;
        assert.deepEqual(order, ["loading", "registered", "original-factory"]);
        assert.equal(customizeExecutions, 0, "Loading a native factory must not initialize its app/provider features.");
        assert.deepEqual(fixture.Bridge.sent, []);
        assert.deepEqual(fixture.notices.filter(value => value.kind === "failed"), []);
    }
});

test("native load-only dependency failure, container replacement and withdrawal never release the original consumer", async () => {
    for (const scenario of ["failed", "replaced", "withdrawn", "missing"]) {
        const fixture = realmGuardFixture({ missing: "bridge" });
        let executed = false;
        fixture.container.get = async () => {
            if (scenario === "failed") throw new Error("Invented load failure");
            if (scenario !== "missing") fixture.runtime.m[476712] = true;
            if (scenario === "replaced") fixture.window.coworker = {};
            if (scenario === "withdrawn") fixture.hide();
            return () => { assert.fail("No Customize factory may execute."); };
        };
        const expected = {
            failed: "NATIVE_TOOL_TRANSPORT_DEPENDENCIES_FAILED",
            replaced: "NATIVE_TOOL_TRANSPORT_CONTAINER_UNQUALIFIED",
            withdrawn: "NATIVE_TOOL_GUARD_RETIRED",
            missing: "NATIVE_TOOL_TRANSPORT_CLIENT_MODULE_MISSING",
        }[scenario];
        await assert.rejects(fixture.expose().then(() => { executed = true; }), { code: expected });
        assert.equal(executed, false);
        assert.equal(fixture.Bridge.singleton, undefined);
    }
});

test("early native factory waits for its HTTP fence and reuses current read-owner readiness", async () => {
    const fixture = realmGuardFixture({ holdReady: true });
    let executed = false;
    const factory = fixture.expose().then(() => { executed = true; });
    await Promise.resolve();
    assert.equal(executed, false);
    assert.equal(fixture.Bridge.singleton, undefined);
    fixture.ready.resolve({ acknowledged: true });
    await factory;
    await fixture.control.ensure();
    await fixture.expose();
    assert.equal(fixture.Bridge.singleton, undefined, "Read-owner admission must not access the private Port class.");
    fixture.hide();
    await assert.rejects(fixture.control.ensure(), { code: "NATIVE_TOOL_GUARD_RETIRED" });
    assert.deepEqual(fixture.Bridge.sent, []);
});

test("early native guard refuses unsupported host/source/prior ownership and changed runtime", async () => {
    for (const scenario of ["host", "source", "active", "runtime"]) {
        const fixture = realmGuardFixture({ activeBridge: scenario === "active" });
        if (scenario === "runtime") fixture.publishRuntime(() => {});
        const code = { host: "NATIVE_TOOL_TRANSPORT_HOST_VERSION_UNQUALIFIED", source: "NATIVE_TOOL_TRANSPORT_ENTRY_UNQUALIFIED",
            active: "NATIVE_COWORK_CLIENT_READONLY_UNQUALIFIED", runtime: "NATIVE_TOOL_GUARD_RUNTIME_CHANGED" }[scenario];
        await assert.rejects(fixture.expose(scenario === "source" ? { entry: "https://unqualified.invalid/entry.js" } : {},
            scenario === "host" ? "unknown" : "2.9.2"), { code });
        assert.equal(fixture.notices.filter(value => value.kind === "failed").length, 1);
        assert.equal(fixture.notices.find(value => value.kind === "failed").code, code);
        assert.throws(fixture.control.assertCurrent);
    }
});

test("entry refusal publishes only a strictly screened public Cowork script basename", async () => {
    const allowed = "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/coworker.8d98ec00.js";
    for (const [entry, expected] of [
        [allowed, "coworker.8d98ec00.js"],
        [allowed.replace("/latest/", "/v/20261101.72.0-6507b83d/"), "coworker.8d98ec00.js"],
        [allowed + "?private=value", undefined], [allowed + "#private", undefined],
        [allowed.replace("res.cdn.office.net", "unqualified.invalid"), undefined],
        [allowed.replace("/cowork/latest/", "/cowork/private/"), undefined],
        [allowed.replace("https://", "https://user:secret@"), undefined], ["private arbitrary value", undefined],
    ]) {
        const fixture = realmGuardFixture();
        await assert.rejects(fixture.expose({ entry }), { code: "NATIVE_TOOL_TRANSPORT_ENTRY_UNQUALIFIED" });
        const notice = fixture.notices.find(value => value.kind === "failed");
        assert.equal(notice.publicCoworkScript, expected);
        assert.deepEqual(Object.keys(notice).sort(),
            ["documentId", "kind", "code", ...(expected ? ["publicCoworkScript"] : [])].sort());
        assert.ok(!JSON.stringify(notice).includes(entry));
        assert.equal(fixture.Bridge.singleton, undefined);
    }
});

test("failure receipt validation permits only the public basename on an entry refusal", () => {
    const code = "NATIVE_TOOL_TRANSPORT_ENTRY_UNQUALIFIED", publicCoworkScript = "coworker.8d98ec00.js";
    const details = nativeFailureDetails(Object.assign(new Error(code), { code, publicCoworkScript }));
    const evidence = { ...details, recordedAt: new Date().toISOString() };
    assert.equal(details.publicCoworkScript, publicCoworkScript);
    assert.equal(validNativeFailure(evidence), true);
    for (const invalid of ["https://res.cdn.office.net/" + publicCoworkScript, publicCoworkScript + "?private=1", "PRIVATE"]) {
        assert.equal(validNativeFailure({ ...evidence, publicCoworkScript: invalid }), false);
        assert.equal(nativeFailureDetails(Object.assign(new Error(code), { code, publicCoworkScript: invalid })).publicCoworkScript, undefined);
    }
    assert.equal(validNativeFailure({ ...evidence, code: "NATIVE_TOOL_TRANSPORT_ALREADY_ACTIVE" }), false);
});

test("native transport diagnostics distinguish missing runtime and loaded modules without accepting them", async () => {
    for (const [missing, suffix] of [["runtime", "RUNTIME_MISSING"], ["bridge", "CLIENT_MODULE_MISSING"],
        ["capability", "CAPABILITY_MODULE_MISSING"]]) {
        const fixture = realmGuardFixture({ missing });
        const code = "NATIVE_TOOL_TRANSPORT_" + suffix;
        await assert.rejects(fixture.expose(), { code });
        assert.equal(fixture.notices.find(value => value.kind === "failed").code, code);
        assert.equal(fixture.Bridge.singleton, undefined);
        assert.throws(fixture.control.assertCurrent, { code });
    }
});

test("native transport diagnostics distinguish rejected bridge prerequisites without logging their values", () => {
    for (const suffix of ["CLASS", "FACTORY", "SINGLETON", "INITIAL_STATE", "SUBSCRIBE", "PORT_METHOD", "SEND_METHOD", "UNSUBSCRIBE"]) {
        const Bridge = inventedToolBridge(), notices = [];
        if (suffix === "FACTORY") Bridge.instance = null;
        else Bridge.instance = () => {
            const bridge = new Bridge();
            Bridge.singleton = suffix === "SINGLETON" ? {} : bridge;
            if (suffix === "INITIAL_STATE") bridge.port = {};
            if (suffix === "SUBSCRIBE") bridge.addReconnectListener = null;
            if (suffix === "PORT_METHOD") bridge.ensurePort = null;
            if (suffix === "SEND_METHOD") bridge.postMessageWithStaleRetry = null;
            if (suffix === "UNSUBSCRIBE") bridge.addReconnectListener = listener => { bridge.reconnectListeners.add(listener); };
            return bridge;
        };
        const code = `NATIVE_TOOL_TRANSPORT_${suffix}_UNQUALIFIED`;
        assert.throws(() => createNativeToolTransportDenial({ getBridgeClass: () => suffix === "CLASS" ? null : Bridge,
            assertOwner() {}, onFailure: value => notices.push(value) }), { code });
        if (suffix === "UNSUBSCRIBE") {
            assert.deepEqual(notices, [code]);
            assert.equal(Bridge.singleton.send("Edge.ToolAction"), false, "A failed subscription still retains its denial.");
        }
    }
});

test("failed HTTP readiness prevents native factory execution without initializing the port bridge", async () => {
    const fixture = realmGuardFixture({ holdReady: true });
    const factory = fixture.expose();
    fixture.ready.resolve({ acknowledged: false });
    await assert.rejects(factory, { code: "NATIVE_TOOL_GUARD_PROTOCOL_UNAVAILABLE" });
    assert.equal(fixture.Bridge.singleton, undefined);
});

test("a withdrawn context cannot reuse an earlier successful native factory readiness acknowledgement", async () => {
    const fixture = realmGuardFixture();
    await fixture.expose();
    fixture.withdraw();
    await assert.rejects(fixture.expose(), { code: "NATIVE_TOOL_GUARD_PROTOCOL_UNAVAILABLE" });
    assert.equal(fixture.Bridge.singleton, undefined);
    assert.deepEqual(fixture.Bridge.sent, []);
});

test("current native tool-connecting exports cannot execute unless Coworker is the exact accepted reader factory", async () => {
    for (const expose of ["./Coworker", "./Customize", "./TaskCanvas", "./DevMenu", "./Unknown"]) {
        const fixture = realmGuardFixture();
        let executed = false;
        const original = () => { executed = true; };
        await assert.rejects(fixture.expose({}, "2.9.2", expose, original).then(original),
            { code: "NATIVE_TOOL_CONNECTING_SURFACE_DENIED" });
        assert.equal(executed, false);
    }
    const fixture = realmGuardFixture(), reader = () => {};
    fixture.control.acceptReaderFactory(reader);
    await fixture.expose({}, "2.9.2", "./Coworker", reader);
    await assert.rejects(fixture.expose({}, "2.9.2", "./Coworker", () => {}),
        { code: "NATIVE_TOOL_CONNECTING_SURFACE_DENIED" });
});

test("a stalled initial execution fence consumes the original deadline and cannot resume setup after failure", async () => {
    const gate = Promise.withResolvers(), browser = new EventEmitter(), failures = [];
    browserProtocolFixture(browser);
    let exposed = 0, scripts = 0;
    browser.exposeBinding = async () => { exposed++; await gate.promise; };
    browser.addInitScript = async () => { scripts++; };
    browser.pages = () => [];
    await assert.rejects(protectNativeToolTransport({ browser, assertOwner() {}, onFailure: error => failures.push(error.code),
        deadline: Date.now() + 30 }), { code: "NATIVE_TOOL_GUARD_DEADLINE" });
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(exposed, 1);
    assert.equal(scripts, 0);
    assert.deepEqual(failures, ["NATIVE_TOOL_GUARD_DEADLINE"]);
    browser.emit("close");
});

test("cancelled or expired Connect guard setup performs no browser operation", async () => {
    for (const cancelled of [true, false]) {
        const signal = new AbortController();
        if (cancelled) signal.abort();
        const failures = [];
        const code = cancelled ? "NATIVE_TOOL_GUARD_CANCELLED" : "NATIVE_TOOL_GUARD_DEADLINE";
        await assert.rejects(protectNativeToolTransport({ browser: null, assertOwner() {},
            onFailure: error => failures.push(error.code), deadline: Date.now() + (cancelled ? 1000 : -1), signal: signal.signal }),
        { code });
        assert.deepEqual(failures, [code]);
    }
});

test("unexpected protocol loss retires the context and logical retirement never detaches a live fence", async () => {
    const browser = new EventEmitter(), protocol = new EventEmitter(), failures = [], methods = [];
    let targetClosed = false;
    const page = { isClosed: () => targetClosed };
    browser.exposeBinding = async () => {};
    browser.addInitScript = async () => {};
    browser.pages = () => [page];
    browser.newCDPSession = async () => protocol;
    protocol.send = async method => { methods.push(method); };
    protocol.detach = async () => { assert.equal(targetClosed, true, "Never detach a live fence."); };
    browserProtocolFixture(browser, protocol);
    const guard = await protectNativeToolTransport({ browser, assertOwner() {}, deadline: Date.now() + 1000,
        onFailure: error => failures.push(error.code) });
    protocol.emit("close");
    assert.deepEqual(failures, ["NATIVE_TOOL_GUARD_PROTOCOL_LOST"]);
    assert.throws(guard.assertCurrent, { code: "NATIVE_TOOL_GUARD_PROTOCOL_LOST" });
    guard.retire();
    protocol.emit("Fetch.requestPaused", { requestId: "invented-pending" });
    await Promise.resolve();
    assert.deepEqual(methods, ["Fetch.enable", "Fetch.failRequest"]);
    targetClosed = true; browser.emit("close");
});

test("a replaced Connect document cannot publish retirement under the reader document's guard owner", async () => {
    const browser = new EventEmitter(), protocol = new EventEmitter(), failures = [];
    const previous = randomUUID(), current = randomUUID();
    let notify;
    const frame = { url: () => "https://m365.cloud.microsoft/chat", isDetached: () => false,
        evaluate: async (_work, input) => input.documentId === current };
    const page = { mainFrame: () => frame, isClosed: () => false };
    browser.exposeBinding = async (_name, callback) => { notify = callback; };
    browser.addInitScript = async () => {};
    browser.pages = () => [page];
    browser.newCDPSession = async () => protocol;
    protocol.send = async () => {};
    browserProtocolFixture(browser, protocol);
    const guard = await protectNativeToolTransport({ browser, assertOwner() {}, deadline: Date.now() + 1000,
        onFailure: error => failures.push(error.code) });
    assert.deepEqual(await notify({ page, frame }, { documentId: previous, kind: "failed", code: "NATIVE_TOOL_GUARD_FAILED" }),
        { acknowledged: false });
    assert.deepEqual(await notify({ page, frame }, { documentId: current, kind: "ready" }), { acknowledged: true });
    guard.assertCurrent();
    assert.deepEqual(failures, []);
    const code = "NATIVE_TOOL_TRANSPORT_ENTRY_UNQUALIFIED", publicCoworkScript = "coworker.8d98ec00.js";
    await notify({ page, frame }, { documentId: current, kind: "failed", code, publicCoworkScript });
    assert.throws(guard.assertCurrent, error => error.code === code && error.publicCoworkScript === publicCoworkScript);
    guard.retire(); browser.emit("close");
});

test("browser-wide execution refusal requires an exclusively owned browser and never intercepts a shared one", async () => {
    let sessions = 0;
    const context = {}, other = {};
    context.browser = () => ({ contexts: () => [context, other], newBrowserCDPSession: async () => { sessions++; } });
    await assert.rejects(protectNativeBrowserProtocol({ context, assertOwner() {}, onFailure() {} }),
        { code: "NATIVE_TOOL_GUARD_BROWSER_NOT_EXCLUSIVE" });
    assert.equal(sessions, 0);
});

test("unsupported browser-target Fetch fails instead of falling back to late page attachment or broad routing", async () => {
    const context = new EventEmitter(), protocol = new EventEmitter(), failures = [], commands = [];
    context.newCDPSession = () => assert.fail("A late per-page fallback is not protective.");
    context.route = () => assert.fail("Broad driver routing is not a fallback.");
    protocol.send = async method => { commands.push(method); throw new Error("Invented unsupported browser command"); };
    browserProtocolFixture(context, protocol);
    await assert.rejects(protectNativeBrowserProtocol({ context, assertOwner() {}, onFailure: reason => failures.push(reason.code) }),
        { code: "NATIVE_TOOL_GUARD_PROTOCOL_UNAVAILABLE" });
    assert.deepEqual(commands, ["Fetch.enable"]);
    assert.deepEqual(failures, ["NATIVE_TOOL_GUARD_PROTOCOL_UNAVAILABLE"]);
    context.emit("close");
});
