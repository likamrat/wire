import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile, stat, readFile, mkdir, readdir } from "node:fs/promises";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer, Server } from "node:http";
import { EventEmitter } from "node:events";
import { AsyncResource, createHook } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import vm from "node:vm";
import { chromium } from "playwright";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { readMicrosoftNativeConfiguration, isMicrosoftNativeConfiguration } from "../lib/microsoft-native-configuration.mjs";
import { createHistoryEngineering, historyEngineeringAssets } from "../lib/microsoft-history-engineering.mjs";
import { runHistoryInvestigation, requestHistoryPreparationClose } from "../scripts/investigate-native-history.mjs";
import { createMicrosoftNativeHost, accountOnlyRequestDecision, accountOnlyDenialContext, guardAccountOnlyRequests,
    recordNativeHostFailure, unavailableNativeRequestEvidence, nativeHeadfulHostReady, nativeTelemetryAttemptLimits, profileOwners,
    nativeProtocolFailure } from "../lib/microsoft-native-host.mjs";
import { collectBootstrapUIMetadata, nativeSignInControl, nativeApplicationEntry, nativeHistoryProducer, nativeApplicationBuilds, nativeCoworkBuilds, revealNativeOlderMessages,
    nativeBootstrapRouteEvidence, nativeAuthScriptEvidence, nativeCachedSessionBindings, presentNativeSignInHandoff,
    clickNativeHistoryLink, nativeHistoryEntry, readNativeAccountMetadata, projectNativeBootstrapHistory } from "../lib/microsoft-native-bootstrap.mjs";
import { readNativeCollectionSettings, readGlobalCollectionGate, createNativePersistence } from "../lib/native-persistence.mjs";
import { createMicrosoftSession, MicrosoftSessionError } from "../lib/microsoft-session.mjs";
import { validateSessionState, nativeFailureDetails, validNativeFailure } from "../lib/microsoft-session-state.mjs";
import { createNativeBackfill, validateNativeBackfill } from "../lib/native-backfill-state.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { coworkFixture, envelope, recorded } from "./native-read-model-fixtures.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { decodeNativeChatObservation } from "../lib/native-chat-source.mjs";
import { retainNativeChatSourceObservations } from "../lib/native-read-model.mjs";
import { adaptCoworkSourceRecordsWithMessageParts, COWORK_PARTS_ADAPTER_VERSION } from "../lib/cowork-source-adapter.mjs";
import { privateFixture } from "./helpers.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";
import { acquireCollectorLock } from "../lib/collector-io.mjs";
import { sourceDefaults } from "../lib/source-discovery.mjs";
import { sourceProjection, projectNativeHistoryRequest, classifyNativeHistoryRequest, projectNativeSourceResponse, projectNativeCoworkListRequest, nativeHistoryWindow,
    nativeHistoryActivity, compareNativeIdentityHeaders, installNativeChatCapture } from "../lib/microsoft-chat-capture.mjs";

const fixtureAuthScripts = {
    telemetry: "https://aadcdn.msftauth.net/shared/1.0/content/js/oneDs_0e6e4f5935218971c598.js",
    returnTelemetry: "https://aadcdn.msauth.net/shared/1.0/content/js/oneDs_0e6e4f5935218971c598.js",
    returnCores: [
        "https://aadcdn.msauth.net/shared/1.0/content/js/ConvergedLogin_PCore_0VaiIU2YQ2Ha0HQI5MKqTQ2.js",
        "https://aadcdn.msauth.net/shared/1.0/content/js/ConvergedLogin_PCore_tg1zCo1cm8VzH5kfPPn1ZQ2.js",
    ],
};

const proof = subjectId => ({
    tenantId: "example-tenant", subjectId, knownAccountMatched: true, chat: true, cowork: true,
    evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() },
});
const operation = ownerId => ({ ownerId, signal: new AbortController().signal });

function inventedNativeWire(value) {
    let id = 0;
    const node = value => {
        if (value === null) return { t: 2, s: 0 };
        if (value === undefined) return { t: 2, s: 1 };
        if (typeof value === "boolean") return { t: 2, s: value ? 2 : 3 };
        if (typeof value === "number") return { t: 0, s: value };
        if (typeof value === "string") return { t: 1, s: JSON.stringify(value).slice(1, -1) };
        const i = id++;
        if (Array.isArray(value)) return { t: 9, i, a: value.map(node), o: 0 };
        return { t: 10, i, p: { k: Object.keys(value), v: Object.values(value).map(node) }, o: 0 };
    };
    return { t: node(value), f: 127, m: [] };
}

test("native identity comparison reads only the two named noncredential fields and never returns their values", () => {
    const principal = { namespace: "m365.accountInfo.objectId", realm: "prod", knownAccountMatched: true,
        observedAt: new Date().toISOString(), tenantId: "native-tenant", subjectId: "native-subject" };
    const read = values => name => {
        assert.ok(["x-user-id", "x-tenant-id"].includes(name));
        return values[name] ?? null;
    };
    assert.deepEqual(compareNativeIdentityHeaders(read({ "x-user-id": "native-subject", "x-tenant-id": "native-tenant" }), principal),
        { state: "matched" });
    for (const values of [{}, { "x-user-id": "foreign", "x-tenant-id": "native-tenant" },
        { "x-user-id": "native-subject, native-subject", "x-tenant-id": "native-tenant" }]) {
        const result = compareNativeIdentityHeaders(read(values), principal);
        assert.equal(result.state, "unavailable");
        assert.doesNotMatch(JSON.stringify(result), /native-subject|native-tenant|foreign/);
    }
    assert.equal(compareNativeIdentityHeaders(() => assert.fail("No fields before fresh principal qualification."),
        { ...principal, knownAccountMatched: false }).state, "unavailable");
});

test("native bootstrap routing evidence keeps only recognized public routes and fixed query key names", () => {
    const source = nativeBootstrapRouteEvidence(new URL("https://m365.cloud.microsoft/externalauth/start?es=PRIVATE&ru=PRIVATE&state=SECRET&login_hint=PRIVATE&PRIVATE_KEY=PRIVATE#SECRET"));
    assert.deepEqual(source, { publicOrigin: "https://m365.cloud.microsoft", route: "/externalauth/start",
        queryKeys: ["es", "ru"], unknownKeys: true, duplicateKeys: false, capped: false, fragmentPresent: true });
    assert.doesNotMatch(JSON.stringify(source), /PRIVATE|SECRET|state|login_hint/);
    for (const url of ["https://m365.cloud.microsoft/PRIVATE_ACCOUNT?PRIVATE_KEY=PRIVATE", "https://private.invalid/PRIVATE_ACCOUNT"]) {
        const evidence = nativeBootstrapRouteEvidence(new URL(url));
        assert.equal(evidence.route, null);
        assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|private\.invalid/);
    }
    const authority = nativeBootstrapRouteEvidence(new URL("https://login.microsoftonline.com/PRIVATE_TENANT/oauth2/v2.0/authorize?client_id=PRIVATE&client_id=PRIVATE"));
    assert.equal(authority.route, "/{authority}/oauth2/authorize");
    assert.equal(authority.duplicateKeys, true);
    assert.doesNotMatch(JSON.stringify(authority), /PRIVATE/);
    const separateAuthority = new URL("https://login.live.com/PRIVATE_ROUTE?PRIVATE_KEY=PRIVATE");
    assert.equal(nativeBootstrapRouteEvidence(separateAuthority).publicOrigin, "https://login.live.com");
    assert.equal(nativeBootstrapRouteEvidence(separateAuthority).route, null);
    assert.equal(accountOnlyRequestDecision({ url: separateAuthority, owned: true, original: true,
        method: "GET", type: "document", navigation: true }).denied, "document-scope");
    const live = nativeBootstrapRouteEvidence(new URL("https://login.live.com/Me.htm?v=PRIVATE&state=SECRET"));
    assert.equal(live.route, "/Me.htm");
    assert.deepEqual(live.queryKeys, ["v"]);
    assert.doesNotMatch(JSON.stringify(live), /PRIVATE|SECRET/);
    const script = new URL("https://aadcdn.msauth.net/ests/2.1/content/cdnbundles/convergedlogin_pcore.min_fixture.js");
    assert.deepEqual(nativeAuthScriptEvidence(script), { publicOrigin: script.origin, publicPath: script.pathname });
    assert.equal(nativeAuthScriptEvidence(new URL(script + "?private=SECRET")), null);
    assert.equal(nativeAuthScriptEvidence(new URL("https://private.invalid/PRIVATE.js")), null);
});

test("native bootstrap observer projects only original hydration fields at native initialization", async t => {
    const browser = await chromium.launch({ channel: "msedge", headless: true, chromiumSandbox: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ offline: true }), captured = [];
    const delayedCapture = Promise.withResolvers(), releaseCapture = Promise.withResolvers();
    let accessor = false;
    await context.exposeBinding("__nativeBootstrapFixture", (source, value) => { captured.push(value); });
    await context.addInitScript({ content: `(${installNativeChatCapture.toString()})(${JSON.stringify({ binding: "__nativeBootstrapFixture",
        nativeHistory: { bootstrapRpcId: nativeHistoryProducer.bootstrapRpcId, chatRpcId: nativeHistoryProducer.chatRpcId,
            resetBinding: "__nativeCapturePhase" } })},null,null,${readNativeAccountMetadata.toString()},${projectNativeBootstrapHistory.toString()});` });
    await context.route("**/*", async route => {
        if (new URL(route.request().url()).pathname.endsWith(nativeHistoryProducer.chatRpcId)) {
            if (new URL(route.request().url()).searchParams.has("old")) {
                delayedCapture.resolve();
                await releaseCapture.promise;
            }
            return route.fulfill({ json: {} });
        }
        return route.fulfill({ contentType: "text/html", body: `
        <link rel="icon" href="data:,"><script>
        window.$_TSR={initialized:false,router:{dehydratedData:{copilotBootstrap:{loaderData:{
            root:{store:{accountInfo:{accountType:"AAD",objectId:"original-native-user",tenantId:"native-tenant",environment:"prod"},
                identity:{userPrincipalName:"example@invalid.test"},chatHistory:["PRIVATE_BOOTSTRAP_TEXT"]}}
        }}}}};
        ${accessor ? `Object.defineProperty(window.$_TSR.router.dehydratedData.copilotBootstrap.loaderData, "root",
            {get(){window.unqualifiedGetterInvoked=true;return {}},enumerable:true});` : ""}
        window.$_TSR.initialized=true;
        ${accessor ? "" : 'window.$_TSR.router.dehydratedData.copilotBootstrap.loaderData.root.store.accountInfo.objectId="changed-after-initialization";'}
        </script>` });
    });
    const page = await context.newPage();
    await page.goto(nativeApplicationEntry);
    await page.waitForFunction(() => Object.getOwnPropertyDescriptor(window.$_TSR, "initialized")?.value === true);
    assert.equal(captured[0].state, "started");
    const snapshot = captured.find(value => value.state === "complete");
    assert.equal(snapshot.projected.store.accountInfo.objectId, "original-native-user");
    assert.equal(snapshot.documentToken, captured[0].documentToken);
    assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_BOOTSTRAP_TEXT|changed-after-initialization/);
    assert.equal(await page.evaluate(() => Boolean(Object.getOwnPropertyDescriptor(window, "$_TSR")?.value)), true);
    const rpc = "/_serverFn/" + nativeHistoryProducer.chatRpcId;
    try {
        await page.evaluate(url => {
            window.oldCapture = fetch(url + "?old", { method: "POST", body: "{}" })
                .then(() => "captured", error => error.message);
        }, rpc);
        await delayedCapture.promise;
        await page.evaluate(() => window.__nativeCapturePhase());
        releaseCapture.resolve();
        assert.equal(await page.evaluate(() => window.oldCapture), "captured");
        const responses = await page.evaluate(async url => {
            const results = [];
            for (let index = 0; index < 17; index++) {
                try { await fetch(url, { method: "POST", body: "{}" }); results.push("response"); }
                catch (error) { results.push(error.message); }
            }
            return results;
        }, rpc);
        assert.deepEqual(responses, Array(17).fill("response"));
        const until = Date.now() + 1000;
        while (captured.filter(value => value.kind === "chat-list" && value.state === "complete").length < 16 && Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(captured.filter(value => value.kind === "chat-list" && value.state === "complete").length, 16,
            "A stale completion must not charge the replacement phase or add a seventeenth capture.");
        assert.equal(captured.filter(value => value.state === "failed" && value.code === "NATIVE_CHAT_CAPTURE_ALREADY_CONSUMED").length, 2);
    } finally { releaseCapture.resolve(); }
    captured.length = 0;
    accessor = true;
    await page.goto(nativeApplicationEntry);
    await page.waitForFunction(() => Object.getOwnPropertyDescriptor(window.$_TSR, "initialized")?.value === true);
    assert.equal(captured.some(value => value.state === "complete"), false);
    assert.equal(captured.some(value => value.state === "unqualified"), true);
    assert.equal(await page.evaluate(() => window.unqualifiedGetterInvoked), undefined);
    captured.length = 0;
    await page.goto("https://device-helper.microsoft.com/");
    assert.equal(captured.length, 0, "No WIRE capture binding may run in a device-helper document.");
    assert.equal(await page.evaluate(() => Function.prototype.toString.call(window.fetch).includes("[native code]")), true);
});

test("native fetch observation preserves the exact result and rejection even when capture fails", async () => {
    const url = "https://m365.cloud.microsoft/_serverFn/" + nativeHistoryProducer.bootstrapRpcId;
    for (const failure of ["clone", "mime", "delivery", "limit", "native", "request", "body-limit", "service-unavailable"]) {
        const messages = [], logs = [], nativeError = new Error("PRIVATE_NATIVE_FAILURE");
        const delivery = Promise.withResolvers();
        let calls = 0;
        const response = new Response("{}", { status: failure === "service-unavailable" ? 503 : 200, headers: {
            "content-type": failure === "mime" ? "text/html" : "application/json",
        } });
        Object.defineProperty(response, "url", { value: url });
        if (failure === "clone") response.clone = () => { throw new Error("PRIVATE_CLONE_FAILURE"); };
        const window = {
            fetch: function (...args) {
                calls++;
                assert.equal(this, window);
                assert.equal(args.length, 1);
                if (failure === "native") return Promise.reject(nativeError);
                return Promise.resolve(response);
            },
            binding: async value => {
                messages.push(value);
                delivery.resolve();
                if (failure === "delivery") throw new Error("PRIVATE_BINDING_FAILURE");
            },
        };
        const context = vm.createContext({ window, location: { origin: "https://m365.cloud.microsoft", href: url, pathname: "/fixture" },
            URL, crypto: globalThis.crypto, Uint8Array, TextDecoder, btoa, setTimeout, clearTimeout,
            console: { error: code => { logs.push(code); delivery.resolve(); } } });
        vm.runInContext(`(${installNativeChatCapture.toString()})({binding:"binding",
            nativeHistory:{bootstrapRpcId:${JSON.stringify(nativeHistoryProducer.bootstrapRpcId)}}});`, context);
        const input = failure === "request" ? { get url() { throw new Error("PRIVATE_REQUEST_FAILURE"); } } : url;
        if (failure === "body-limit") response.clone = () => ({
            body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close(); } }),
        });
        if (failure === "native") {
            await assert.rejects(window.fetch(input), error => error === nativeError);
            assert.equal(messages.length, 0);
        } else {
            assert.equal(await window.fetch(input), response);
            if (failure === "limit") assert.equal(await window.fetch(input), response);
            await delivery.promise;
            if (failure === "limit") assert.ok(messages.some(value => value.code === "NATIVE_CHAT_CAPTURE_ALREADY_CONSUMED"));
            else if (failure === "service-unavailable") {
                assert.equal(messages[0].state, "read-failed");
                assert.equal(messages[0].status, 503);
                assert.equal(messages[0].encodedBody, undefined);
            } else if (failure !== "delivery") assert.ok(messages.some(value => value.state === "failed"), failure);
            assert.equal(await response.text(), "{}", "Observation must not consume the native response body.");
        }
        assert.equal(calls, failure === "limit" ? 2 : 1, "Never replay the original request.");
        assert.doesNotMatch(JSON.stringify({ messages, logs }), /PRIVATE_/);
    }
});

test("bootstrap observation cannot reject native transport assignment or make readonly initialization writable", async () => {
    for (const scenario of ["nonextensible", "readonly", "descriptor-error", "binding-error", "branch-accessor"]) {
        const messages = [], logs = [];
        const window = { fetch: async () => new Response("{}"),
            binding(value) {
                if (scenario === "binding-error") throw new Error("PRIVATE_BINDING_FAILURE");
                messages.push(value);
                return Promise.resolve();
            } };
        window.top = window;
        const transport = scenario === "nonextensible" ? Object.preventExtensions({})
            : scenario === "readonly" ? Object.defineProperty({}, "initialized", { value: false, configurable: true, writable: false })
                : scenario === "descriptor-error" ? new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("PRIVATE_DESCRIPTOR_FAILURE"); } })
                    : {};
        const context = vm.createContext({ window, transport, location: {
            origin: "https://m365.cloud.microsoft", pathname: "/chat", href: "https://m365.cloud.microsoft/chat",
        }, crypto: globalThis.crypto, console: { error: value => logs.push(value) } });
        assert.doesNotThrow(() => vm.runInContext(`(${installNativeChatCapture.toString()})({binding:"binding",nativeHistory:{}},
            null,null,${readNativeAccountMetadata.toString()});`, context));
        if (scenario === "branch-accessor") Object.defineProperty(window, "__backgroundSSR", {
            get() { assert.fail("An active selector accessor cannot be read."); },
        });
        assert.doesNotThrow(() => vm.runInContext("window.$_TSR=transport", context));
        assert.equal(window.$_TSR, transport);
        if (scenario === "readonly") {
            assert.equal(Object.getOwnPropertyDescriptor(transport, "initialized").writable, false);
            assert.equal(vm.runInContext(`(()=>{"use strict";try{transport.initialized=true;return "changed"}catch(error){return error.name}})()`, context),
                "TypeError");
            assert.equal(transport.initialized, false);
        }
        await nextTurn();
        if (scenario === "binding-error") assert.ok(logs.includes("WIRE_NATIVE_BOOTSTRAP_OBSERVATION_FAILED"));
        else assert.ok(messages.some(value => value.state === "unqualified"), scenario);
        assert.doesNotMatch(JSON.stringify({ messages, logs }), /PRIVATE_/);
    }
});

test("native history request projection reads the root action without exposing cached state or permitting a decoy", () => {
    const action = { action: "GetConversationPageHistoryList", enableLastMessage: true,
        syncState: "invented-private-continuation", state: { conversationPageHistoryList: {
            chats: [{ title: "PRIVATE_CACHED_TEXT", action: "DeleteConversation" }], syncState: "old" } } };
    const projected = projectNativeHistoryRequest(JSON.stringify(inventedNativeWire({ data: action,
        context: { privateValue: "PRIVATE_CONTEXT" } })));
    assert.deepEqual(projected, { action: action.action, store: "conversationPageHistoryList",
        continuation: { state: "present", value: action.syncState }, requestBasis: "continuation" });
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_CACHED_TEXT|PRIVATE_CONTEXT|DeleteConversation/);
    for (const change of [{ action: "DeleteConversation" }, { enableLastMessage: false }, { extraAction: "mutate" },
        { conversationHistoryFilter: { filterType: "Agent", filterEnabled: true, filterValue: "example" } }]) {
        assert.throws(() => projectNativeHistoryRequest(JSON.stringify(inventedNativeWire({
            data: { ...action, ...change, state: { action: action.action } },
        }))), { code: "NATIVE_HISTORY_REQUEST_UNQUALIFIED" });
    }
});

test("native Chat history distinguishes matched empty-reset shape from continuation and cached seeds", () => {
    const project = data => projectNativeHistoryRequest(JSON.stringify(inventedNativeWire({ data })));
    for (const store of ["conversationPageHistoryList", "chatLandingPageHistoryList"]) {
        const reset = { action: "GetConversationPageHistoryList", enableLastMessage: true,
            state: { [store]: { chats: [], syncState: "" } }, ...(store === "chatLandingPageHistoryList" ? { saveToStore: store } : {}) };
        assert.equal(project(reset).requestBasis, "empty-reset-shape");
        assert.equal(project({ ...reset, syncState: "original-next" }).requestBasis, "continuation");
        assert.equal(project({ ...reset, syncState: "" }).requestBasis, "unobserved");
        assert.equal(project({ ...reset, state: { [store]: { chats: [{ title: "PRIVATE_CACHED_TEXT" }], syncState: "" } } }).requestBasis, "cached-seed");
        assert.equal(project({ ...reset, state: { ...reset.state, agentList: [] } }).requestBasis, "unobserved");
        assert.equal(project({ ...reset, state: { [store]: { chats: [], syncState: "old-seed" } } }).requestBasis, "unobserved");
        assert.equal(project({ ...reset, state: { [store]: { cachedOpaque: "PRIVATE_STATE" } } }).requestBasis, "unobserved");
        assert.doesNotMatch(JSON.stringify(project(reset)), /startQualified|PRIVATE_/);
    }
});

test("declared Chat section reads require the exact empty-state unfiltered read payload", () => {
    const data = { action: "GetSections", state: {}, enableLastMessage: true, enableCache: false, source: "NavPane" };
    const classify = value => classifyNativeHistoryRequest(JSON.stringify(inventedNativeWire({ data: value })), "unobserved", true);
    assert.deepEqual(classify(data), { kind: "context", request: { action: "GetSections" } });
    assert.deepEqual(classify({ action: "GetSections", state: {} }), { kind: "context", request: { action: "GetSections" } });
    for (const change of [{ state: { privateState: true } }, { state: undefined }, { state: [] },
        { conversationHistoryFilter: { filterType: "Product", filterEnabled: true, filterValue: "Cowork" } },
        { enableLastMessage: "true" }, { enableCache: null }, { source: { action: "DeleteConversation" } },
        { extra: "unqualified" }]) assert.equal(classify({ ...data, ...change }).kind, "unqualified");
    assert.equal(classify({ ...data, action: "DeleteSections" }).kind, "different-action");
});

test("unselected GetSections payloads keep acknowledged-denial classification without becoming a history contract", () => {
    for (const data of [
        { action: "GetSections", state: { PRIVATE_STATE: { unknown: true } } },
        { action: "GetSections", conversationHistoryFilter: { filterType: "Product", filterValue: "PRIVATE_FILTER" } },
        { action: "GetSections", additionalUnselectedField: ["PRIVATE_PAYLOAD"] },
    ]) {
        const body = JSON.stringify(inventedNativeWire({ data }));
        assert.deepEqual(classifyNativeHistoryRequest(body, "network"), { kind: "different-action" });
        assert.equal(classifyNativeHistoryRequest(body, "network", true).kind, "unqualified");
    }
    for (const body of ["{", "{}", JSON.stringify(inventedNativeWire({ data: { action: {} } }))]) {
        assert.equal(classifyNativeHistoryRequest(body, "network").kind, "unqualified");
    }
});

test("native section responses stay with their caller without consuming history capture slots", async () => {
    const messages = [], observed = Promise.withResolvers(), url = "https://m365.cloud.microsoft/_serverFn/" + nativeHistoryProducer.chatRpcId;
    const contextBody = JSON.stringify(inventedNativeWire({ data: { action: "GetSections", state: {} } }));
    const listBody = JSON.stringify(inventedNativeWire({ data: { action: "GetConversationPageHistoryList" } }));
    const window = {
        fetch: async (_url, init) => {
            const context = init.body === contextBody;
            const response = new Response(context ? "PRIVATE_CONTEXT_RESPONSE" : "{}", {
                status: 200, headers: { "content-type": "application/json" },
            });
            Object.defineProperty(response, "url", { value: url });
            if (context) response.clone = () => assert.fail("WIRE must not clone context response bodies.");
            return response;
        },
        binding: async value => { messages.push(value); observed.resolve(); },
    };
    const context = vm.createContext({ window, location: { origin: "https://m365.cloud.microsoft", pathname: "/fixture", href: url },
        crypto: globalThis.crypto, URL, TextEncoder, TextDecoder, Uint8Array, btoa, setTimeout, clearTimeout, console });
    vm.runInContext(`(${installNativeChatCapture.toString()})(${JSON.stringify({ binding: "binding",
        nativeHistory: { chatRpcId: nativeHistoryProducer.chatRpcId } })},${sourceProjection.toString()});`, context);
    for (let index = 0; index < 16; index++) {
        assert.equal(await (await window.fetch(url, { method: "POST", body: contextBody })).text(), "PRIVATE_CONTEXT_RESPONSE");
    }
    assert.equal(messages.length, 0);
    assert.equal(await (await window.fetch(url, { method: "POST", body: listBody })).text(), "{}");
    await observed.promise;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].state, "complete");
    assert.equal(messages[0].kind, "chat-list");
    assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_CONTEXT/);
});

test("native history request refusals preserve closed predicates without exposing the rejected payload", () => {
    const data = { action: "GetConversationPageHistoryList", enableLastMessage: true,
        state: { conversationPageHistoryList: { chats: [], syncState: "" } } };
    const body = changed => JSON.stringify(inventedNativeWire({ data: { ...data, ...changed },
        context: { privateValue: "PRIVATE_CONTEXT" } }));
    const cases = [
        ["body-type", undefined],
        ["body-budget", "x".repeat(2 * 1024 * 1024 + 1)],
        ["json", '{"PRIVATE_MALFORMED":'],
        ["envelope", JSON.stringify({ ...inventedNativeWire({ data }), f: 128 })],
        ["root", JSON.stringify(inventedNativeWire({ data, privateExtra: "PRIVATE_EXTRA" }))],
        ["root", JSON.stringify({ f: 127, m: [], t: { t: 4, i: 999 } })],
        ["data", body({ extra: "PRIVATE_EXTRA" })],
        ["action", body({ action: "DeleteConversation" })],
        ["last-message", body({ enableLastMessage: false })],
        ["filter", body({ conversationHistoryFilter: { filterType: "Agent", filterValue: "PRIVATE_FILTER" } })],
        ["store", body({ saveToStore: "PRIVATE_STORE" })],
        ["state", body({ state: { agentList: [] } })],
        ["continuation", body({ syncState: "\u0000PRIVATE_CURSOR" })],
    ];
    for (const [index, [predicate, input]] of cases.entries()) {
        const stage = ["network", "protocol", "route"][index % 3];
        assert.throws(() => projectNativeHistoryRequest(input, stage), error => {
            const failure = nativeFailureDetails(error, "connect");
            assert.equal(failure.code, "NATIVE_HISTORY_REQUEST_UNQUALIFIED");
            assert.deepEqual(failure.predicate, { schemaVersion: 1, stage, name: "history-request-" + predicate });
            assert.equal(validNativeFailure({ ...failure, recordedAt: new Date().toISOString() }), true);
            assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_|DeleteConversation|https?:|999/);
            return true;
        });

    }
    const valid = body({});
    assert.deepEqual(projectNativeHistoryRequest(valid.padEnd(2 * 1024 * 1024, " "), "protocol"),
        projectNativeHistoryRequest(valid));
});

test("shared Chat action classification separates a decoded exclusion from every unqualified candidate", () => {
    const data = { action: "GetConversationPageHistoryList", enableLastMessage: true,
        state: { conversationPageHistoryList: { chats: [], syncState: "" } } };
    const body = value => JSON.stringify(inventedNativeWire({ data: value, context: { secret: "PRIVATE_CONTEXT" } }));
    const valid = body(data);
    assert.deepEqual(classifyNativeHistoryRequest(valid), { kind: "history", request: projectNativeHistoryRequest(valid) });
    assert.deepEqual(classifyNativeHistoryRequest(body({ action: "PRIVATE_DIFFERENT_ACTION",
        extra: { cached: "PRIVATE_CACHE", action: "GetConversationPageHistoryList" } })), { kind: "different-action" });
    assert.deepEqual(classifyNativeHistoryRequest(body({ action: " GetConversationPageHistoryList" })), { kind: "different-action" });
    const wire = inventedNativeWire({ data: { action: "PRIVATE_DIFFERENT_ACTION", ignored: null } });
    const node = wire.t.p.v[0];
    node.p.v[1] = { t: 999, private: "PRIVATE_UNKNOWN_TAG" };
    assert.deepEqual(classifyNativeHistoryRequest(JSON.stringify(wire)), { kind: "different-action" });
    node.p.v[0] = { t: 4, i: 999 };
    assert.equal(classifyNativeHistoryRequest(JSON.stringify(wire)).kind, "unqualified");
    node.p.v[0] = { t: 1, s: "PRIVATE_DIFFERENT_ACTION" };
    node.p.k.push("action"); node.p.v.push({ t: 1, s: "PRIVATE_DIFFERENT_ACTION" });
    assert.equal(classifyNativeHistoryRequest(JSON.stringify(wire)).kind, "unqualified");
    for (const input of [undefined, "{", "x".repeat(2 * 1024 * 1024 + 1), body({ ...data, action: undefined }), body({ ...data, action: "" }),
        body({ ...data, action: null }), body({ ...data, action: false }), body({ ...data, action: 1 }),
        body({ ...data, action: {} }), body({ ...data, extra: "PRIVATE_FIELD" }), body({ ...data, enableLastMessage: false }),
        body({ ...data, conversationHistoryFilter: { filterType: "Agent" } }), body({ ...data, saveToStore: "other" }),
        body({ ...data, state: {} }), body({ ...data, syncState: "\u0000" })]) {
        const result = classifyNativeHistoryRequest(input, "protocol");
        assert.equal(result.kind, "unqualified");
        assert.equal(result.error.code, "NATIVE_HISTORY_REQUEST_UNQUALIFIED");
        assert.doesNotMatch(JSON.stringify(nativeFailureDetails(result.error)), /PRIVATE_|GetConversation/);
    }
    const escaped = inventedNativeWire({ data });
    escaped.t.p.v[0].p.v[0].s = "\\u0047etConversationPageHistoryList";
    assert.equal(classifyNativeHistoryRequest(JSON.stringify(escaped)).kind, "history");
});

test("native source response projection preserves source identity and bounded list metadata, not private cached text", () => {
    const wire = inventedNativeWire({ result: { store: { accountInfo: {
        accountType: "AAD", objectId: "native-object", tenantId: "native-tenant", environment: "prod",
        displayName: "PRIVATE_DISPLAY_NAME",
    }, conversationPageHistoryList: { chats: [{ _brand: "SessionChat", conversationId: "discovered-chat", chatName: "PRIVATE_TITLE",
        updateTimeUtc: 1800000000000, createTimeUtc: 1700000000000, lastMessage: { text: "PRIVATE_OLD_REPLY" } }],
        syncState: "private-next-page" } } }, context: { private: "PRIVATE_CONTEXT" } }).t;
    const bytes = Buffer.from(JSON.stringify(wire));
    const options = { bytes, mime: "application/json", serialized: true };
    assert.deepEqual(projectNativeSourceResponse({ ...options, kind: "principal" }), {
        namespace: "m365.accountInfo.objectId", realm: "prod", tenantId: "native-tenant", subjectId: "native-object",
    });
    const chat = projectNativeSourceResponse({ ...options, kind: "chat-list", store: "conversationPageHistoryList" });
    assert.deepEqual(chat, { items: [{ conversationId: "discovered-chat", createdAt: 1700000000000, lastActivity: 1800000000000 }],
        continuation: { state: "present", value: "private-next-page" }, store: "conversationPageHistoryList" });
    assert.doesNotMatch(JSON.stringify(chat), /PRIVATE_/);
    const header = Buffer.alloc(9);
    header.writeUInt32BE(bytes.length, 5);
    assert.deepEqual(projectNativeSourceResponse({ ...options, bytes: Buffer.concat([header, bytes]),
        mime: "application/x-tss-framed;v=1", kind: "chat-list" }), chat);
    const cowork = projectNativeSourceResponse({ kind: "cowork-list", mime: "application/json",
        bytes: Buffer.from(JSON.stringify({ tasks: [{ sessionId: "native-task", createdAt: "2026-10-20T00:00:00Z",
            lastActivity: 1800000000000, title: "PRIVATE_COWORK_TITLE" }], nextCursor: null })) });
    assert.deepEqual(cowork, { items: [{ sessionId: "native-task", createdAt: "2026-10-20T00:00:00Z", lastActivity: 1800000000000 }],
        continuation: { state: "null" } });
    assert.throws(() => projectNativeSourceResponse({ ...options, kind: "chat-list", bytes: bytes.subarray(0, 20) }),
        { code: "NATIVE_SOURCE_RESPONSE_UNQUALIFIED" });
    assert.throws(() => projectNativeSourceResponse({ ...options, kind: "chat-list",
        bytes: Buffer.concat([header, bytes, header, bytes]), mime: "application/x-tss-framed" }),
    { code: "NATIVE_SOURCE_RESPONSE_UNQUALIFIED" });
});

test("native Chat initializer selects only one original history store without guessing a server marker", () => {
    const project = root => projectNativeSourceResponse({ kind: "chat-list", store: null,
        mime: "application/json", bytes: Buffer.from(JSON.stringify(root)) });
    for (const store of ["conversationPageHistoryList", "chatLandingPageHistoryList"]) {
        for (const historySource of [undefined, "server-defined-value"]) {
            const result = project({ historySource, store: { [store]: {
                chats: [{ conversationId: "original-chat", updateTimeUtc: 1800000000000 }], syncState: "original-cursor",
            } } });
            assert.equal(result.store, store);
            assert.equal(result.continuation.value, "original-cursor");
        }
    }
    for (const store of [{}, { filteredHistory: { chats: [], syncState: "" } },
        { conversationPageHistoryList: { chats: [], syncState: "" }, chatLandingPageHistoryList: { chats: [], syncState: "" } }]) {
        assert.throws(() => project({ historySource: "all-chats", store }), { code: "NATIVE_SOURCE_RESPONSE_UNQUALIFIED" });
    }
    assert.equal(project({ store: { conversationPageHistoryList: { chats: [] } } }).continuation.state, "absent");
});

test("native Cowork list phases vary cache and page size without changing the source population", () => {
    const project = query => projectNativeCoworkListRequest(new URL("https://fixture.invalid/v1/tasks/live?" + query));
    for (const population of [null, "interactive", "scheduled_run", "event_run", "automation_run"]) {
        const suffix = population === null ? "" : "&sessionType=" + population;
        const first = project("pageSize=25&includeCached=true" + suffix);
        const next = project("pageSize=50&cursor=original-next" + suffix);
        assert.equal(first.population, population);
        assert.equal(next.population, population);
        assert.equal(first.includeCached, true);
        assert.equal(next.includeCached, false);
        assert.equal(first.pageSize, 25);
        assert.equal(next.pageSize, 50);
        assert.equal(first.continuation.state, "absent");
        assert.deepEqual(next.continuation, { state: "present", value: "original-next" });
    }
    assert.notEqual(project("sessionType=automation_run").population, project("sessionType=event_run").population,
        "The native event-run feed's query value is not the task record's sessionType.");
    for (const query of ["pageSize=0", "pageSize=201", "pageSize=25.0", "pageSize=025",
        "pageSize=25&pageSize=50", "sessionType=unknown", "sessionType=", "includeCached=false",
        "includeCached=true&cursor=next", "cursor=", "cursor=%00", "cursor=one&cursor=two", "filter=all"]) {
        assert.throws(() => project(query), { code: "NATIVE_SOURCE_QUERY_UNQUALIFIED" }, query);
    }
});

test("native principal projection recognizes explicit production cloud names without inventing identity", () => {
    const account = { accountType: "AAD", objectId: "native-object", tenantId: "native-tenant" };
    const input = environment => ({ store: { accountInfo: { ...account, environment },
        identity: { userPrincipalName: "example@invalid.test" } } });
    const project = (value, serialized = false) => projectNativeSourceResponse({
        kind: "principal", expectedAccount: "example@invalid.test", mime: "application/json", serialized,
        bytes: Buffer.from(JSON.stringify(serialized ? inventedNativeWire(value).t : value)),
    });
    const expected = { namespace: "m365.accountInfo.objectId", realm: "prod", tenantId: "native-tenant",
        subjectId: "native-object", accountLabelMatched: true,
        presentation: { source: "microsoft-native-principal", email: "example@invalid.test" } };
    for (const environment of ["prod", "production", " PROD ", "Production"]) {
        assert.deepEqual(project(input(environment)), expected);
        assert.deepEqual(project(input(environment), true), expected);
    }
    for (const environment of [undefined, null, "", "development", "production-other", "dod", "gcch"]) {
        assert.throws(() => project(input(environment)), { code: "NATIVE_SOURCE_RESPONSE_UNQUALIFIED" });
    }
    assert.throws(() => project({ store: { accountInfo: { ...account, environment: "production", accountType: "MSA" } } }),
        { code: "NATIVE_SOURCE_RESPONSE_UNQUALIFIED" });
    assert.throws(() => project({ store: { accountInfo: { ...account, environment: "production", tenantId: "" } } }),
        { code: "NATIVE_SOURCE_RESPONSE_UNQUALIFIED" });
    assert.equal(project({ store: { ...input("production").store,
        identity: { userPrincipalName: "different@invalid.test" } } }).accountLabelMatched, false);
});

test("native original gate covers admitted descendants and blocks expiry before the native retry handler", async () => {
    const protocol = new EventEmitter(), calls = [], pending = new Set(), stopped = [];
    protocol.send = async (method, input) => { calls.push({ method, input }); return {}; };
    const scope = { abort: new AbortController() };
    const raw = JSON.stringify(inventedNativeWire({ data: { action: "GetConversationPageHistoryList",
        enableLastMessage: true, state: { conversationPageHistoryList: { chats: [] } } } }));
    const gate = await guardAccountOnlyRequests(protocol, {
        mainFrameId: "root", ownsFrame: id => ["root", "owned-child"].includes(id), getScope: () => scope,
        isSelfUrl: () => false, diagnoseFrames: false,
        admit(current, facts, stage, readPostData) {
            assert.equal(current, scope);
            assert.equal(facts.owned, true);
            assert.equal(projectNativeHistoryRequest(readPostData()).action, "GetConversationPageHistoryList");
            return "chat-list";
        },
        responded() { assert.fail("The expired response must not reach the application."); },
        stop(current, reason) { stopped.push(reason); current.abort.abort(); },
        track(work) { pending.add(work); work.finally(() => pending.delete(work)); return work; },
    });
    const request = { url: "https://m365.cloud.microsoft/_serverFn/" + "a".repeat(64), method: "POST", postData: raw };
    protocol.emit("Fetch.requestPaused", { requestId: "original", networkId: "network", frameId: "owned-child",
        resourceType: "Fetch", request });
    await Promise.all([...pending]);
    assert.equal(calls.filter(row => row.method === "Fetch.continueRequest").length, 1);
    protocol.emit("Fetch.requestPaused", { requestId: "original", networkId: "network", frameId: "owned-child",
        resourceType: "Fetch", request, responseStatusCode: 401 });
    await Promise.all([...pending]);
    assert.equal(gate.active, false);
    assert.equal(stopped.length, 1);
    assert.equal(calls.filter(row => row.method === "Fetch.continueResponse").length, 0);
    assert.equal(calls.filter(row => row.method === "Fetch.failRequest").length, 1);
});

test("native preflight waits for original protocol linkage but never admits an orphan", async () => {
    for (const linked of [true, false]) {
        const protocol = new EventEmitter(), calls = [], pending = new Set();
        protocol.send = async (method, input) => { calls.push({ method, input }); return {}; };
        const scope = { abort: new AbortController() };
        const request = { url: "https://cowork.example.gateway.prod.island.powerapps.com/v1/tasks/live", method: "OPTIONS" };
        const gate = await guardAccountOnlyRequests(protocol, {
            mainFrameId: "root", getScope: () => scope, isSelfUrl: () => false,
            admit() { return null; }, responded() {},
            preflightCandidate(current, facts) { return facts.url?.pathname === "/v1/tasks/live"; },
            admitPreflight(current, facts) {
                assert.equal(current, scope);
                assert.equal(facts.method, "GET");
                return "native-preflight";
            },
            stop(current) { current.abort.abort(); },
            track(work) { pending.add(work); work.finally(() => pending.delete(work)); return work; },
        });
        protocol.emit("Fetch.requestPaused", { requestId: "preflight", networkId: "preflight-network", frameId: "root",
            resourceType: "Other", request });
        assert.equal(calls.some(call => call.method === "Fetch.continueRequest"), false);
        if (linked) {
            protocol.emit("Network.requestWillBeSent", { requestId: "preflight-network", request,
                initiator: { type: "preflight", requestId: "get-network" } });
            protocol.emit("Network.requestWillBeSent", { requestId: "get-network", frameId: "root", type: "Fetch",
                request: { ...request, method: "GET" } });
        }
        await Promise.all([...pending]);
        assert.equal(calls.filter(call => call.method === "Fetch.continueRequest").length, linked ? 1 : 0);
        assert.equal(calls.filter(call => call.method === "Fetch.failRequest").length, linked ? 0 : 1);
        gate.retire();
    }
});

test("a read503 disposition requires the original GET, admitted owner, response acknowledgement and successful terminal", async () => {
    for (const scenario of ["qualified", "post", "unauthorized", "auth-status", "unknown-ack", "network-failed", "owner-loss"]) {
        const protocol = new EventEmitter(), pending = new Set(), calls = [], stopped = [], responded = [];
        const scope = { abort: new AbortController() };
        protocol.send = async (method, input) => {
            calls.push({ method, input });
            if (scenario === "owner-loss" && method === "Fetch.continueResponse") scope.abort.abort();
            return scenario === "unknown-ack" && method === "Fetch.continueResponse" ? undefined : {};
        };
        let failedEntry;
        const gate = await guardAccountOnlyRequests(protocol, {
            mainFrameId: "root", getScope: () => scope, isSelfUrl: () => false,
            admit: () => "cowork-list", acceptResponse: (_scope, _kind, status) => status === 200,
            allowReadFailureResponse: current => scenario !== "unauthorized" && current === scope && !scope.abort.signal.aborted,
            observeRequest(_scope, entry) { failedEntry = entry; },
            responded(_scope, _kind, _method, status) { responded.push(status); },
            stop(current, reason) { stopped.push(reason); current.abort.abort(); },
            track(work) { pending.add(work); work.finally(() => pending.delete(work)); return work; },
        });
        const request = { url: "https://fixture.gateway.prod.island.powerapps.com/v1/tasks/live",
            method: scenario === "post" ? "POST" : "GET" };
        protocol.emit("Fetch.requestPaused", { requestId: "original", networkId: "network", frameId: "root",
            resourceType: "Fetch", request });
        await Promise.all([...pending]);
        protocol.emit("Fetch.requestPaused", { requestId: "original", networkId: "network", frameId: "root",
            resourceType: "Fetch", request, responseStatusCode: scenario === "auth-status" ? 401 : 503 });
        await Promise.all([...pending]);
        if (["qualified", "network-failed"].includes(scenario)) {
            assert.equal(failedEntry.readFailureResponse, true);
            assert.equal(failedEntry.responseAcknowledged, true);
            assert.equal(failedEntry.terminal, null, "A response alone is not settled-read proof.");
            protocol.emit(scenario === "network-failed" ? "Network.loadingFailed" : "Network.loadingFinished",
                { requestId: "network" });
        }
        assert.equal(gate.active, scenario === "qualified");
        if (scenario === "qualified") {
            assert.equal(failedEntry.terminal, "finished");
            assert.deepEqual(responded, [503]);
            assert.deepEqual(stopped, []);
        } else assert.equal(stopped.length, 1);
        assert.equal(calls.some(row => row.method === "Fetch.fulfillRequest"), false, "Never fabricate a success response.");
        gate.retire();
    }
});

test("denied telemetry POST preflights never consume GET history correlation capacity", async () => {
    const protocol = new EventEmitter(), calls = [], pending = new Set(), stopped = [];
    protocol.send = async (method, input) => { calls.push({ method, input }); return {}; };
    const scope = { abort: new AbortController(), native: {},
        page: { url: () => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize" } };
    const gate = await guardAccountOnlyRequests(protocol, {
        mainFrameId: "root", getScope: () => scope, isSelfUrl: () => false,
        telemetryAttemptLimit: nativeTelemetryAttemptLimits.attended,
        allowAuthTelemetryDenial: () => () => !scope.abort.signal.aborted,
        preflightCandidate(current, facts) {
            assert.equal(current, scope);
            return facts.url.pathname === "/v1/tasks/live"
                || accountOnlyRequestDecision(facts).blockOnly === true;
        },
        admitPreflight() { return "native-preflight"; },
        admit() { assert.fail("Denied collector transport must never become an application/history read."); },
        responded() { assert.fail("Denied collector transport has no source response."); },
        stop(current, reason) { stopped.push(reason); current.abort.abort(); },
        track(work) { pending.add(work); work.finally(() => pending.delete(work)); return work; },
    });
    const url = nativeHistoryProducer.authTelemetryCollector;
    for (let index = 0; index < 9; index++) {
        protocol.emit("Network.requestWillBeSent", { requestId: "post-" + index, frameId: "root", type: "XHR",
            request: { url, method: "POST", get postData() { assert.fail("Denied bodies stay opaque."); } },
            initiator: { type: "script", stack: { callFrames: [] } } });
        protocol.emit("Network.requestWillBeSent", { requestId: "options-" + index, frameId: "root", type: "Other",
            request: { url, method: "OPTIONS" }, initiator: { type: "preflight", requestId: "post-" + index } });
    }
    assert.deepEqual(stopped, [], "These are positively associated POST preflights, not eight GET reads plus an overflow.");
    for (let index = 0; index < 9; index++) {
        protocol.emit("Fetch.requestPaused", { requestId: "paused-options-" + index, networkId: "options-" + index,
            frameId: "root", resourceType: "Other", request: { url, method: "OPTIONS" } });
        await Promise.all([...pending]);
        protocol.emit("Network.loadingFailed", { requestId: "options-" + index });
        protocol.emit("Fetch.requestPaused", { requestId: "paused-post-" + index, networkId: "post-" + index,
            frameId: "root", resourceType: "XHR", request: { url, method: "POST" } });
        await Promise.all([...pending]);
        protocol.emit("Network.loadingFailed", { requestId: "post-" + index });
    }
    assert.deepEqual(stopped, []);
    assert.equal(gate.active, true);
    assert.equal(gate.pendingCount, 0);
    assert.equal(scope.blockedAuthTelemetry.posts, 9);
    assert.equal(scope.blockedAuthTelemetry.preflights, 9);
    assert.equal(scope.blockedAuthTelemetry.failedPosts, 9);
    assert.equal(scope.blockedAuthTelemetry.failedPreflights, 9);
    assert.equal(calls.some(row => ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.fulfillRequest"].includes(row.method)), false);
    for (let index = 0; index < 8; index++) protocol.emit("Network.requestWillBeSent", {
        requestId: "get-" + index, frameId: "root", type: "Fetch",
        request: { url: "https://fixture.gateway.prod.island.powerapps.com/v1/tasks/live?cursor=" + index, method: "GET" },
    });
    assert.deepEqual(stopped, [], "The existing eight GET association slots remain available.");
    protocol.emit("Network.requestWillBeSent", { requestId: "get-overflow", frameId: "root", type: "Fetch",
        request: { url: "https://fixture.gateway.prod.island.powerapps.com/v1/tasks/live", method: "GET" } });
    assert.deepEqual(stopped, ["native-preflight-cap"], "Do not raise or remove the genuine GET correlation limit.");
    gate.retire();
});

test("a late pause for the same failed telemetry beacon stays denied once without resetting accounting", async () => {
    for (const scenario of ["current", "stale", "bad-ack", "owner-change"]) {
        const protocol = new EventEmitter(), calls = [], pending = new Set(), stopped = [];
        let currentProof = true;
        protocol.send = async (method, input) => {
            calls.push({ method, input });
            if (method === "Fetch.failRequest" && input.requestId === "late-pause") {
                if (scenario === "bad-ack") return { unexpected: true };
                if (scenario === "owner-change") currentProof = false;
            }
            return {};
        };
        const scope = { abort: new AbortController(), native: {},
            page: { url: () => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize" } };
        const gate = await guardAccountOnlyRequests(protocol, {
            mainFrameId: "root", getScope: () => scope, isSelfUrl: () => false,
            allowAuthTelemetryDenial: async () => () => currentProof,
            admit() { assert.fail("Blocked telemetry must never enter ordinary admission."); },
            responded() { assert.fail("Denied telemetry must never receive a response."); },
            stop(current, reason, facts) {
                const failure = nativeFailureDetails(nativeProtocolFailure(reason, facts, { scope: current, mainFrameId: "root" }));
                assert.equal(failure.protocolStop.reason, reason);
                assert.equal(validNativeFailure({ ...failure, recordedAt: new Date().toISOString() }), true);
                stopped.push(reason); current.abort.abort();
            },
            track(work) { pending.add(work); work.finally(() => pending.delete(work)); return work; },
        });
        const request = { url: nativeHistoryProducer.authTelemetryCollector + "?cors=true", method: "POST",
            get postData() { assert.fail("Telemetry body must stay opaque."); } };
        protocol.emit("Network.requestWillBeSent", { requestId: "original-network", frameId: "root", type: "Ping",
            request, initiator: { type: "script", stack: { callFrames: [{ url: fixtureAuthScripts.telemetry }] } } });
        protocol.emit("Fetch.requestPaused", { requestId: "first-pause", networkId: "original-network",
            frameId: "root", resourceType: "Ping", request });
        await Promise.all([...pending]);
        protocol.emit("Network.loadingFailed", { requestId: "original-network" });
        assert.equal(gate.pendingCount, 0);
        currentProof = scenario !== "stale";
        protocol.emit("Fetch.requestPaused", { requestId: "late-pause", networkId: "original-network",
            frameId: "root", resourceType: "Ping", request });
        await Promise.all([...pending]);
        assert.equal(gate.active, scenario === "current");
        assert.equal(calls.filter(call => call.method === "Fetch.continueRequest").length, 0);
        assert.equal(scope.blockedAuthTelemetry.posts, 1);
        assert.equal(scope.blockedAuthTelemetry.failedPosts, 1);
        if (scenario === "current") {
            assert.equal(scope.blockedAuthTelemetry.latePostPauses, 1);
            assert.equal(gate.pendingCount, 0);
            protocol.emit("Fetch.requestPaused", { requestId: "excess-pause", networkId: "original-network",
                frameId: "root", resourceType: "Ping", request });
            await Promise.all([...pending]);
            assert.deepEqual(stopped, ["auth-telemetry-association"]);
        } else assert.deepEqual(stopped, [scenario === "stale" ? "auth-telemetry-role"
            : scenario === "bad-ack" ? "auth-telemetry-acknowledgement" : "auth-telemetry-owner-changed"]);
        gate.retire();
    }
});

test("optional collector original and linked aborts require genuine acknowledgement", async () => {
    for (const failedStage of ["post", "preflight", "linked-post"]) {
        const protocol = new EventEmitter(), pending = new Set(), stopped = [], calls = [];
        const scope = { abort: new AbortController(), native: {},
            page: { url: () => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize" } };
        protocol.send = async (method, input) => {
            calls.push({ method, input });
            return method === "Fetch.failRequest" && input.requestId === failedStage ? { unexpected: true } : {};
        };
        const gate = await guardAccountOnlyRequests(protocol, {
            mainFrameId: "root", getScope: () => scope, isSelfUrl: () => false,
            allowAuthTelemetryDenial: () => () => true,
            admit() { assert.fail("Collector requests must stay blocked."); },
            responded() { assert.fail("Blocked collector requests cannot have successful responses."); },
            stop(current, reason, facts) {
                const failure = nativeFailureDetails(nativeProtocolFailure(reason, facts, { scope: current, mainFrameId: "root" }));
                assert.equal(failure.protocolStop.reason, reason);
                assert.equal(validNativeFailure({ ...failure, recordedAt: new Date().toISOString() }), true);
                stopped.push(reason); current.abort.abort();
            },
            track(work) { pending.add(work); work.finally(() => pending.delete(work)); return work; },
        });
        const request = { url: nativeHistoryProducer.authTelemetryCollector + "?fixture=denied", method: "POST",
            get postData() { assert.fail("Collector body must remain opaque."); } };
        protocol.emit("Network.requestWillBeSent", { requestId: "post-network", frameId: "root", type: "XHR",
            request, initiator: { type: "other" } });
        if (failedStage !== "post") {
            protocol.emit("Network.requestWillBeSent", { requestId: "preflight-network", frameId: "root", type: "XHR",
                request: { url: request.url, method: "OPTIONS" }, initiator: { type: "preflight", requestId: "post-network" } });
            protocol.emit("Fetch.requestPaused", { requestId: "preflight", networkId: "preflight-network", frameId: "root",
                resourceType: "XHR", request: { url: request.url, method: "OPTIONS" } });
            await Promise.all([...pending]);
        }
        if (failedStage !== "preflight") {
            protocol.emit("Fetch.requestPaused", { requestId: failedStage, networkId: "post-network",
                frameId: "root", resourceType: "XHR", request });
            await Promise.all([...pending]);
        }
        assert.deepEqual(stopped, ["auth-telemetry-acknowledgement"]);
        assert.equal(gate.active, false);
        assert.equal(calls.some(row => row.method === "Fetch.continueRequest" || row.method === "Fetch.fulfillRequest"), false);
        assert.equal(scope.blockedAuthTelemetry.failedPosts, 0);
        gate.retire();
    }
});

test("collection denial budgets retire only after a committed acquisition and exact settlement", async t => {
    for (const scenario of ["committed", "same-lease-recovery", "same-scope", "uncommitted", "old-scope-live",
        "new-scope-aborted", "foreign-scope", "missing-terminal", "missing-ack", "duplicate-terminal", "old-terminal",
        "retired"]) await t.test(scenario, async () => {
        const protocol = new EventEmitter(), pending = new Set(), calls = [], stops = [], acknowledgement = Promise.withResolvers();
        const scope = { lease: { kind: "microsoft-read" }, abort: new AbortController(), commitState: "committed" };
        let current = scope;
        protocol.send = async (method, input) => {
            calls.push({ method, input });
            if (method === "Fetch.failRequest" && scenario === "missing-ack") return acknowledgement.promise;
            return {};
        };
        const gate = await guardAccountOnlyRequests(protocol, {
            mainFrameId: "root", getScope: () => current, isSelfUrl: () => false,
            qualifyAppTelemetry: async owner => () => owner === current && !owner.abort.signal.aborted,
            admit() { assert.fail("Logger denial must not enter source admission."); }, responded() {},
            stop(owner, reason) { stops.push(reason); owner?.abort.abort(); },
            track(work) { pending.add(work); work.finally(() => pending.delete(work)); return work; },
        });
        assert.equal(gate.beginCollection(scope), true);
        const emitPost = index => {
            const request = { url: "https://m365.cloud.microsoft/events", method: "POST",
                get headers() { assert.fail("No credential reads."); }, get postData() { assert.fail("No logger-body reads."); } };
            protocol.emit("Network.requestWillBeSent", { requestId: "network-" + index, frameId: "root",
                type: "XHR", request, initiator: { type: "script", stack: { callFrames: [] } } });
            protocol.emit("Fetch.requestPaused", { requestId: "fetch-" + index, networkId: "network-" + index,
                frameId: "root", resourceType: "XHR", request });
        };
        const count = ["missing-terminal", "missing-ack", "duplicate-terminal"].includes(scenario) ? 1 : 6;
        for (let index = 0; index < count; index++) {
            emitPost(index);
            if (scenario === "missing-ack") await nextTurn();
            else await Promise.all([...pending]);
            if (scenario !== "missing-terminal") protocol.emit("Network.loadingFailed", { requestId: "network-" + index });
        }
        if (scenario === "duplicate-terminal") protocol.emit("Network.loadingFailed", { requestId: "network-0" });
        if (scenario === "retired") gate.retire();
        if (scenario === "uncommitted") scope.commitState = "unconfirmed";
        if (scenario === "same-lease-recovery") scope.commitState = "not-published";
        const next = scenario === "same-scope" ? scope : {
            lease: scenario === "same-lease-recovery" ? scope.lease : { kind: "microsoft-read" },
            abort: new AbortController(), commitState: "unconfirmed",
        };
        if (scenario !== "old-scope-live" && scenario !== "same-scope") scope.abort.abort();
        if (scenario === "new-scope-aborted") next.abort.abort();
        current = scenario === "foreign-scope" ? {} : next;
        const accepted = gate.beginCollection(next);
        assert.equal(accepted, ["committed", "same-lease-recovery", "old-terminal"].includes(scenario));
        if (scenario === "missing-ack") { acknowledgement.resolve({}); await Promise.all([...pending]); }
        if (scenario === "committed") {
            for (let index = 6; index < 12; index++) {
                emitPost(index); await Promise.all([...pending]);
                protocol.emit("Network.loadingFailed", { requestId: "network-" + index });
            }
            assert.equal(gate.active, true);
            assert.equal(next.blockedAppEvents.failedPosts, 6);
        } else if (scenario === "same-lease-recovery" || scenario === "same-scope") {
            emitPost(6); await Promise.all([...pending]);
            assert.ok(stops.includes("app-telemetry-limit"), "A phase transition or same-operation recovery cannot reset the original allowance.");
        } else if (scenario === "old-terminal") {
            protocol.emit("Network.loadingFailed", { requestId: "network-0" });
            assert.ok(stops.includes("network-record-missing"), "A late terminal is refused, not silently swallowed after turnover.");
        }
        assert.equal(calls.some(row => ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.fulfillRequest"].includes(row.method)), false);
        gate.retire();
        await Promise.all([...pending]);
    });
});

test("registered collection logger denials share original metadata capacity without a bonus pool", async t => {
    for (const scenario of ["shared-boundary", "logger-before-source", "all-logger", "same-lease-recovery", "phase-change",
        "committed-turnover", "unconfirmed-turnover", "preexisting-metadata", "unregistered", "legacy", "legacy-attended",
        "wrong-role", "revoked-before-fetch", "revoked-after-ack", "stale-role-after-ack", "duplicate-original",
        "terminal-success", "terminal-duplicate", "ack-invalid", "terminal-before-ack"]) {
        await t.test(scenario, async () => {
            const handlers = new Map(), commands = [], stopped = [], ack = Promise.withResolvers();
            const page = { url: () => nativeApplicationEntry };
            const original = { lease: { kind: "microsoft-read" }, native: {}, page, phase: "native-collection-bootstrap",
                abort: new AbortController(), commitState: "unconfirmed" };
            let current = original, registered = scenario !== "unregistered", roleCurrent = true, serial = 0;
            const legacy = scenario.startsWith("legacy");
            if (legacy) original.lease = null;
            const limit = scenario === "legacy-attended" ? 16 : 6;
            const gate = await guardAccountOnlyRequests({
                on: (name, handler) => handlers.set(name, handler),
                async send(method, input) {
                    commands.push({ method, input });
                    if (method === "Fetch.failRequest" && scenario === "ack-invalid") return undefined;
                    if (method === "Fetch.failRequest" && scenario === "terminal-before-ack") return ack.promise;
                    return {};
                },
            }, {
                mainFrameId: "root", getScope: () => current, track: work => work, telemetryAttemptLimit: limit,
                getAncillaryDocument: () => ({ entry: { networkId: "document" } }),
                collectionLoggerCurrent: owner => registered && owner === current,
                qualifyAppTelemetry: async owner => () => roleCurrent && owner === current,
                admit(_owner, facts) { assert.equal(facts.method, "GET"); return "static"; },
                responded() {},
                stop(owner, reason) { if (!owner?.abort.signal.aborted) stopped.push(reason); owner?.abort.abort(); },
            });
            const emit = (event, data) => handlers.get(event)(data);
            assert.equal(legacy ? false : gate.beginCollection(original), !legacy);
            const request = (id, logger) => ({
                requestId: id, frameId: "root", loaderId: "document", documentURL: nativeApplicationEntry,
                type: logger ? "XHR" : "Script",
                request: { url: logger ? "https://m365.cloud.microsoft/events" : "https://res.cdn.office.net/fixture-" + id + ".js",
                    method: logger ? "POST" : "GET",
                    get postData() { assert.fail("Neither accounting nor logger denial reads bodies."); },
                    get headers() { assert.fail("No credentials."); } },
            });
            const post = async (terminal = true) => {
                const id = "post-" + serial++, event = request(id, true);
                emit("Network.requestWillBeSent", event);
                if (!gate.active) return id;
                if (scenario === "revoked-before-fetch") registered = false;
                const pending = emit("Fetch.requestPaused", { requestId: id, networkId: id, frameId: "root",
                    resourceType: "XHR", request: event.request });
                if (scenario === "terminal-before-ack") {
                    await nextTurn();
                    emit("Network.loadingFailed", { requestId: id });
                    assert.equal(gate.pendingCount, 1);
                    ack.resolve({});
                }
                await pending;
                if (gate.active && terminal && scenario !== "terminal-before-ack") emit("Network.loadingFailed", { requestId: id });
                return id;
            };
            const source = async () => {
                const id = "source-" + serial++, event = request(id, false);
                emit("Network.requestWillBeSent", event);
                if (!gate.active) return;
                const paused = { requestId: id, networkId: id, frameId: "root", resourceType: "Script", request: event.request };
                await emit("Fetch.requestPaused", paused);
                await emit("Fetch.requestPaused", { ...paused, responseStatusCode: 200 });
                emit("Network.loadingFinished", { requestId: id });
            };
            const replace = (sameLease, committed) => {
                current.commitState = committed ? "committed" : "not-published";
                current.abort.abort();
                current.native.requestOrigins?.clear();
                current = { ...original, lease: sameLease ? original.lease : { kind: "microsoft-read" },
                    native: {}, abort: new AbortController(), commitState: "unconfirmed" };
                return gate.beginCollection(current);
            };
            if (["shared-boundary", "phase-change", "committed-turnover", "unconfirmed-turnover"].includes(scenario)) {
                for (let n = 0; n < 511; n++) await source();
                if (scenario === "phase-change") current.phase = "cowork-discovery";
                await post();
                assert.equal(gate.active, true);
                assert.equal(current.native.requestOrigins.size, 512);
                assert.equal(current.blockedAppEvents.failedPosts, 1);
                if (scenario.endsWith("turnover")) {
                    const committed = scenario === "committed-turnover";
                    assert.equal(replace(false, committed), committed);
                    if (committed) {
                        await post();
                        assert.equal(gate.active, true);
                        assert.equal(current.native.requestOrigins.size, 1);
                    }
                } else await post();
            } else if (scenario === "logger-before-source") {
                for (let n = 0; n < 511; n++) await post();
                await source();
                assert.equal(gate.active, true);
                assert.equal(current.native.requestOrigins.size, 512);
                await source();
            } else if (scenario === "all-logger") {
                for (let n = 0; n < 512; n++) await post();
                assert.equal(gate.active, true);
                assert.equal(current.blockedAppEvents.acknowledged, 512);
                assert.equal(current.blockedAppEvents.failedPosts, 512);
                await post();
            } else if (scenario === "same-lease-recovery") {
                for (let n = 0; n < 500; n++) await source();
                await post();
                assert.equal(replace(true, false), true);
                for (let n = 0; n < 11; n++) await source();
                assert.equal(gate.active, true);
                assert.equal(current.native.requestOrigins.size, 11);
                await post();
            } else if (scenario === "preexisting-metadata") {
                original.commitState = "committed"; original.abort.abort();
                current = { ...original, lease: { kind: "microsoft-read" }, abort: new AbortController(),
                    native: { requestOrigins: new Map([["borrowed", {}]]) } };
                assert.equal(gate.beginCollection(current), false);
            } else if (legacy) {
                for (let n = 0; n < limit; n++) await post();
                assert.equal(gate.active, true);
                await post();
                assert.equal(current.blockedAppEvents.failedPosts, limit);
            } else {
                if (scenario === "wrong-role") roleCurrent = false;
                const id = await post(!["revoked-after-ack", "stale-role-after-ack", "terminal-success"].includes(scenario));
                if (scenario === "revoked-after-ack") registered = false;
                if (scenario === "stale-role-after-ack") roleCurrent = false;
                if (["revoked-after-ack", "stale-role-after-ack"].includes(scenario)) emit("Network.loadingFailed", { requestId: id });
                if (scenario === "terminal-success") emit("Network.loadingFinished", { requestId: id });
                if (scenario === "terminal-duplicate") emit("Network.loadingFailed", { requestId: id });
                if (scenario === "duplicate-original") emit("Network.requestWillBeSent", request(id, true));
            }
            const expected = ["shared-boundary", "logger-before-source", "all-logger", "same-lease-recovery", "phase-change"].includes(scenario)
                ? "protocol-cap" : legacy || scenario === "duplicate-original"
                    ? "app-telemetry-limit" : ["wrong-role", "revoked-before-fetch"].includes(scenario)
                        ? "app-telemetry-role" : ["unregistered", "revoked-after-ack", "stale-role-after-ack"].includes(scenario)
                            ? "app-telemetry-owner-changed" : scenario === "ack-invalid" ? "app-telemetry-acknowledgement"
                                : scenario === "terminal-success" ? "network-block-completed"
                                    : scenario === "terminal-duplicate" ? "network-record-missing" : null;
            assert.deepEqual(stopped, expected ? [expected] : []);
            if (expected === "protocol-cap") assert.equal(current.native.requestOriginsTruncated, true);
            assert.equal(commands.some(row => row.input?.requestId?.startsWith("post-")
                && ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.fulfillRequest"].includes(row.method)), false);
            if (scenario === "terminal-before-ack") assert.deepEqual(current.blockedAppEvents,
                { role: "reviewed-app-logger", posts: 1, acknowledged: 1, failedPosts: 1, disposition: "denied-not-contacted" });
            assert.equal(gate.pendingCount, 0);
            gate.retire();
        });
    }
});

test("CSP report denial requires the original browser primitive and exact collection settlement", async t => {
    for (const scenario of ["ack-first", "terminal-first", "missing-binding", "unregistered", "legacy", "wrong-method", "child-frame",
        "redirect", "missing-network", "wrong-network-class", "no-original", "generic-other", "generic-ping",
        "expired", "revoked-before-fetch", "revoked-after-ack", "document-after-ack", "ack-invalid", "ack-rejected",
        "finished-terminal", "duplicate-terminal", "conflicting-terminal", "unmatched-terminal", "response-stage",
        "late-after-retire", "shared-cap", "capacity"]) {
        await t.test(scenario, async () => {
            const handlers = new Map(), commands = [], stopped = [], heldAck = Promise.withResolvers();
            const scope = { lease: { kind: "microsoft-read" }, native: {}, page: { url: () => nativeApplicationEntry },
                abort: new AbortController(), phase: "native-collection-bootstrap" };
            if (scenario === "legacy") scope.lease = null;
            const deadline = Date.now() + (scenario === "expired" ? -1 : 10000);
            let current = scope, registered = scenario !== "unregistered", documentCurrent = true;
            const protocol = {
                on: (event, listener) => handlers.set(event, listener),
                async send(method, input) {
                    commands.push({ method, input });
                    if (method === "Fetch.failRequest") {
                        if (scenario === "ack-invalid") return [];
                        if (scenario === "ack-rejected") throw new Error("PRIVATE_CSP_TRANSPORT_ERROR");
                        if (scenario === "terminal-first") return heldAck.promise;
                    }
                    return {};
                },
            };
            const gate = await guardAccountOnlyRequests(protocol, {
                mainFrameId: "root", getScope: () => current, ownsFrame: id => ["root", "child"].includes(id),
                collectionLoggerCurrent: owner => owner === current && registered,
                getAncillaryDocument: () => ({ entry: { networkId: "document" } }),
                bindRequestCapacity: () => ({ deadline, current: () => registered && current === scope }),
                bindCspReport(owner, facts) {
                    const record = owner.native.requestOrigins?.get(facts.networkId);
                    if (scenario === "missing-binding" || !record || !["other", "cspviolationreport"].includes(record.type)) return null;
                    return { deadline, current: () => documentCurrent, check: async () => documentCurrent };
                },
                track: work => work, responded() {},
                admit(_owner, facts) {
                    assert.equal(accountOnlyRequestDecision(facts).denied, "method-scope");
                    return null;
                },
                stop(owner, reason) { if (!owner?.abort.signal.aborted) stopped.push(reason); owner?.abort.abort(); },
            });
            assert.equal(gate.beginCollection(scope), scenario !== "legacy");
            const emit = (event, input) => handlers.get(event)(input);
            const request = { url: "https://example.invalid/csp-receiver", method: scenario === "wrong-method" ? "GET" : "POST",
                get postData() { assert.fail("CSP payload is never read."); },
                get headers() { assert.fail("CSP headers are never read."); } };
            const post = (id = "report") => {
                if (scenario !== "no-original") emit("Network.requestWillBeSent", {
                    requestId: id, frameId: "root", loaderId: "document", documentURL: nativeApplicationEntry,
                    type: scenario === "wrong-network-class" ? "Fetch" : "Other", request,
                });
                if (scenario === "revoked-before-fetch") registered = false;
                return emit("Fetch.requestPaused", {
                    requestId: id, networkId: scenario === "missing-network" ? undefined : id,
                    frameId: scenario === "child-frame" ? "child" : "root",
                    ...(scenario === "redirect" ? { redirectedRequestId: "previous" } : {}),
                    resourceType: scenario === "generic-other" ? "Other" : scenario === "generic-ping" ? "Ping" : "CSPViolationReport",
                    ...(scenario === "response-stage" ? { responseStatusCode: 200 } : {}), request,
                });
            };
            if (scenario === "shared-cap") {
                for (let n = 0; n < 511; n++) emit("Network.requestWillBeSent", {
                    requestId: "source-" + n, frameId: "root", type: "Script", request: { url: "https://res.cdn.office.net/fixture-" + n + ".js", method: "GET" },
                });
                await post();
                emit("Network.loadingFailed", { requestId: "report" });
                assert.equal(scope.native.requestOrigins.size, 512);
                assert.equal(scope.blockedCspReports.failed, 1);
                emit("Network.requestWillBeSent", { requestId: "over-cap", frameId: "root", type: "Other", request });
                assert.deepEqual(stopped, ["protocol-cap"]);
            } else if (scenario === "capacity") {
                for (let n = 0; n < 128; n++) await post("report-" + n);
                assert.equal(gate.pendingCount, 128);
                const waiting = post("report-128");
                await nextTurn();
                assert.equal(commands.filter(row => row.method === "Fetch.failRequest").length, 128);
                emit("Network.loadingFailed", { requestId: "report-0" });
                await waiting;
                for (let n = 1; n <= 128; n++) emit("Network.loadingFailed", { requestId: "report-" + n });
                assert.deepEqual(scope.blockedCspReports,
                    { reports: 129, acknowledged: 129, failed: 129, sourceQualified: false, disposition: "denied-not-contacted" });
                assert.deepEqual(stopped, []);
            } else {
                const pending = post();
                if (scenario === "terminal-first") {
                    await nextTurn();
                    emit("Network.loadingFailed", { requestId: "report" });
                    assert.equal(gate.pendingCount, 1, "Failed terminal alone cannot retire an unacknowledged abort.");
                    assert.equal(scope.blockedCspReports.acknowledged, 0);
                    heldAck.resolve({});
                }
                await pending;
                if (scenario === "revoked-after-ack") registered = false;
                if (scenario === "document-after-ack") documentCurrent = false;
                if (scenario === "late-after-retire") { gate.retire(); current = null; }
                if (gate.active && scenario !== "terminal-first") {
                    emit(scenario === "finished-terminal" ? "Network.loadingFinished" : "Network.loadingFailed",
                        { requestId: scenario === "unmatched-terminal" ? "unknown" : "report" });
                    if (["duplicate-terminal", "conflicting-terminal"].includes(scenario)) {
                        emit(scenario === "duplicate-terminal" ? "Network.loadingFailed" : "Network.loadingFinished", { requestId: "report" });
                    }
                }
                if (scenario === "late-after-retire") emit("Network.loadingFailed", { requestId: "report" });
                const expected = {
                    "missing-binding": "policy-block-scope", unregistered: "capacity-unbound", legacy: "policy-block-scope",
                    "wrong-method": "policy-block-scope", "child-frame": "policy-block-scope",
                    redirect: "redirect-correlation", "missing-network": "network-id-missing",
                    "wrong-network-class": "policy-block-scope", "no-original": "policy-block-scope",
                    "generic-other": "request-scope", "generic-ping": "request-scope",
                    expired: "capacity-deadline", "revoked-before-fetch": "capacity-unbound",
                    "revoked-after-ack": "network-scope-mismatch", "document-after-ack": "network-scope-mismatch",
                    "ack-invalid": "policy-abort-failed", "ack-rejected": "policy-abort-failed",
                    "finished-terminal": "network-block-completed", "duplicate-terminal": "network-record-missing",
                    "conflicting-terminal": "network-record-missing", "unmatched-terminal": "network-record-missing",
                    "response-stage": "response-correlation",
                }[scenario];
                assert.deepEqual(stopped, expected ? [expected] : []);
                if (["ack-first", "terminal-first"].includes(scenario)) assert.deepEqual(scope.blockedCspReports,
                    { reports: 1, acknowledged: 1, failed: 1, sourceQualified: false, disposition: "denied-not-contacted" });
                if (["generic-other", "generic-ping"].includes(scenario)) assert.equal(scope.blockedCspReports, undefined);
            }
            assert.equal(commands.some(row => /Fetch\.(continue|fulfill)/.test(row.method)), false);
            assert.equal(gate.pendingCount, 0);
            gate.retire();
        });
    }
});

test("Fetch-only sink denial is narrow, acknowledged, distinct and shares the telemetry budget", async () => {
    for (const scenario of ["beacon", "keepalive", "pending-ack", "wrong-origin", "wrong-method", "wrong-frame", "wrong-type", "response",
        "redirect", "ack-failure", "unknown-ack", "owner-change", "expired", "duplicate", "shared-budget", "attended-shared-budget",
        "app-shared-budget", "attended-app-shared-budget", "app-unlinked", "app-stale-proof",
        "app-redirect", "app-unknown-ack", "app-owner-change"]) {
        const protocol = new EventEmitter(), calls = [], pending = new Set(), stopped = [];
        const scope = { abort: new AbortController() };
        let current = scope, authorized = true, acknowledge;
        protocol.send = async (method, input) => {
            calls.push({ method, input });
            if (method === "Fetch.failRequest") {
                if (scenario === "ack-failure") throw new Error("invented acknowledgement failure");
                if (["unknown-ack", "app-unknown-ack"].includes(scenario)) return undefined;
                if (scenario === "pending-ack") return new Promise(resolve => { acknowledge = resolve; });
                if (["owner-change", "app-owner-change"].includes(scenario)) current = null;
                if (scenario === "expired") authorized = false;
            }
            return {};
        };
        const gate = await guardAccountOnlyRequests(protocol, {
            mainFrameId: "root", getScope: () => current, isSelfUrl: () => false,
            ...(scenario.startsWith("attended-") ? { telemetryAttemptLimit: nativeTelemetryAttemptLimits.attended } : {}),
            allowAuthTelemetryDenial: async () => () => true,
            qualifyAppTelemetry: async () => () => authorized && current === scope,
            allowFetchOnlyTelemetryDenial: (owner, facts) => authorized && owner === current
                && facts.url?.href === nativeHistoryProducer.authTelemetryCollector,
            admit() { assert.fail("An unlinked request must not reach ordinary admission."); }, responded() {},
            stop(owner, reason) { stopped.push(reason); owner?.abort.abort(); },
            track(work) { pending.add(work); work.finally(() => pending.delete(work)); return work; },
        });
        const request = { url: scenario === "wrong-origin" ? "https://other.invalid/OneCollector/1.0/" : nativeHistoryProducer.authTelemetryCollector,
            method: scenario === "wrong-method" ? "GET" : "POST",
            get postData() { assert.fail("Fetch-only denial must not inspect a body."); },
            get headers() { assert.fail("Fetch-only denial must not inspect headers."); } };
        if (scenario.startsWith("app-") && scenario !== "app-shared-budget") {
            const appRequest = { url: "https://copilot.cloud.microsoft/events", method: "POST",
                get postData() { assert.fail("Logger bodies stay opaque."); },
                get headers() { assert.fail("Logger credentials stay opaque."); } };
            if (scenario !== "app-unlinked") protocol.emit("Network.requestWillBeSent", {
                requestId: "app-network", frameId: "root", type: "Fetch", request: appRequest,
                ...(scenario === "app-redirect" ? { redirectResponse: {} } : {}),
                initiator: { type: "script", stack: { callFrames: [] } },
            });
            if (scenario === "app-stale-proof") authorized = false;
            protocol.emit("Fetch.requestPaused", { requestId: "app-pause",
                ...(scenario === "app-unlinked" ? {} : { networkId: "app-network" }),
                frameId: "root", resourceType: "XHR", request: appRequest });
            await Promise.all([...pending]);
            assert.equal(gate.active, false);
            assert.ok(stopped.includes(({ "app-unlinked": "network-id-missing", "app-stale-proof": "app-telemetry-role",
                "app-redirect": "app-telemetry-association", "app-unknown-ack": "app-telemetry-acknowledgement",
                "app-owner-change": "app-telemetry-owner-changed" })[scenario]));
            if (scenario === "app-unknown-ack") assert.equal(scope.blockedAppEvents.acknowledged, 0);
            if (scenario === "app-owner-change") assert.equal(scope.blockedAppEvents.acknowledged, 1);
            assert.equal(calls.some(call => ["Fetch.continueRequest", "Fetch.fulfillRequest", "Fetch.continueResponse"].includes(call.method)), false);
            gate.retire();
            continue;
        }
        const budgetCase = scenario.endsWith("shared-budget");
        const limit = scenario.startsWith("attended-") ? nativeTelemetryAttemptLimits.attended : nativeTelemetryAttemptLimits.unattended;
        if (budgetCase) protocol.emit("Network.requestWillBeSent", {
            requestId: "linked-attempt", frameId: "root", type: "Ping", request,
            initiator: { type: "script", stack: { callFrames: [{ url: fixtureAuthScripts.telemetry }] } },
        });
        const appBudget = scenario.includes("app-shared-budget");
        if (appBudget) protocol.emit("Network.requestWillBeSent", {
            requestId: "app-linked-attempt", frameId: "root", type: "Fetch",
            request: { url: "https://copilot.cloud.microsoft/events", method: "POST",
                get postData() { assert.fail("Logger body must remain opaque."); } },
            initiator: { type: "script", stack: { callFrames: [] } },
        });
        const emit = id => protocol.emit("Fetch.requestPaused", { requestId: id, frameId: scenario === "wrong-frame" ? "other" : "root",
            resourceType: scenario === "wrong-type" ? "Other" : scenario === "keepalive" ? "XHR" : "Ping", request,
            ...(scenario === "response" ? { responseStatusCode: 200 } : {}),
            ...(scenario === "redirect" ? { redirectedRequestId: "prior" } : {}) });
        const attempts = budgetCase ? limit : scenario === "duplicate" ? 2 : 1;
        for (let index = 0; index < attempts; index++) {
            emit(scenario === "duplicate" ? "same-pause" : "pause-" + index);
            if (scenario === "pending-ack") {
                assert.equal(scope.blockedFetchOnlySinkRequests.acknowledged, 0);
                assert.equal(gate.pendingCount, 1);
                acknowledge({});
            }
            await Promise.all([...pending]);
        }
        assert.equal(calls.some(call => ["Fetch.continueRequest", "Fetch.fulfillRequest", "Fetch.continueResponse"].includes(call.method)), false);
        assert.equal(scope.blockedAuthTelemetry, undefined, "Fetch-only interception is not a source-qualified Network attempt.");
        const outcome = scope.blockedFetchOnlySinkRequests;
        if (["beacon", "keepalive", "pending-ack"].includes(scenario)) {
            assert.equal(gate.active, true);
            assert.equal(outcome.acknowledged, 1);
            assert.equal(gate.pendingCount, 0);
        } else assert.equal(gate.active, false, scenario);
        if (outcome) {
            assert.equal(outcome.originalNetwork, "unavailable");
            assert.equal(outcome.initiator, "unavailable");
            assert.equal(outcome.networkTerminal, "unavailable");
        }
        if (["ack-failure", "unknown-ack", "owner-change", "expired"].includes(scenario)) assert.equal(outcome.acknowledged, 0);
        if (scenario === "duplicate") assert.equal(calls.filter(call => call.method === "Fetch.failRequest").length, 1);
        if (budgetCase) {
            assert.equal(outcome.pauses, limit - (appBudget ? 2 : 1));
            assert.equal(outcome.acknowledged, limit - (appBudget ? 2 : 1));
            assert.deepEqual(stopped, ["fetch-only-denial-limit"]);
        }
        gate.retire();
    }
});

test("native stop reporting preserves the first failure and separates post-stop callbacks", () => {
    const failure = Object.assign(new Error("invented source failure"), { code: "NATIVE_SOURCE_REQUEST_FAILED" });
    const first = { abort: new AbortController(), error: null };
    assert.equal(recordNativeHostFailure(first, failure), true);
    assert.equal(recordNativeHostFailure(first, new MicrosoftSessionError("window-closed")), false);
    assert.equal(first.error, failure, "A later close must not replace a source failure recorded before local abort.");
    assert.equal(first.afterStopFailure, "window-closed");
    for (const prior of ["bootstrap", "cancellation", "release"]) {
        const caller = new AbortController(), scope = { abort: new AbortController(), operationSignal: caller.signal, error: null };
        if (prior === "bootstrap") scope.terminalOutcome = { outcome: "unverified", reason: "account-metadata-unavailable" };
        if (prior === "cancellation") caller.abort();
        if (prior === "release") scope.releaseTask = Promise.resolve();
        assert.equal(recordNativeHostFailure(scope, failure), false);
        assert.equal(scope.error, null, prior);
        assert.equal(scope.afterStopFailure, "NATIVE_SOURCE_REQUEST_FAILED");
        if (prior === "bootstrap") assert.equal(scope.terminalOutcome.reason, "account-metadata-unavailable");
    }
    assert.deepEqual(nativeHeadfulHostReady, { state: "host-ready", display: "headful", userVisibility: "unconfirmed" });
});

test("the local sign-in handoff deadline includes stalled preparation", { timeout: 1000 }, async () => {
    const page = new EventEmitter();
    page.url = () => "about:blank";
    page.isClosed = () => false;
    page.exposeBinding = async () => {};
    page.setContent = () => new Promise(() => {});
    page.bringToFront = () => assert.fail("An expired handoff must not activate the page.");
    const result = await presentNativeSignInHandoff(page, {
        binding: "__fixtureHandoff", signal: new AbortController().signal, deadline: Date.now() + 20,
        onReady() { assert.fail("Stalled preparation cannot report ready."); },
    });
    assert.equal(result, "timed-out");
    assert.equal(page.listenerCount("close"), 0);
    assert.equal(page.listenerCount("framenavigated"), 0);
});

test("Network telemetry cap reporting does not invent an examined Fetch event", async () => {
    const protocol = new EventEmitter(), calls = [], scope = { abort: new AbortController() };
    protocol.send = async (method, input) => { calls.push({ method, input }); return {}; };
    let stopped;
    const gate = await guardAccountOnlyRequests(protocol, {
        mainFrameId: "root", getScope: () => scope, isSelfUrl: () => false,
        allowAuthTelemetryDenial: async () => () => true, admit() { assert.fail("No Fetch event was sent."); }, responded() {},
        stop(owner, reason, facts) { stopped = { reason, provenance: unavailableNativeRequestEvidence(facts) }; owner.abort.abort(); },
        track: work => work,
    });
    for (let index = 0; index < 7; index++) protocol.emit("Network.requestWillBeSent", {
        requestId: "network-" + index, frameId: "root", type: "Ping",
        request: { url: nativeHistoryProducer.authTelemetryCollector, method: "POST" },
        initiator: { type: "script", stack: { callFrames: [{ url: fixtureAuthScripts.telemetry }] } },
    });
    assert.equal(gate.active, false);
    assert.deepEqual(stopped, { reason: "auth-telemetry-limit",
        provenance: { available: false, reason: "no-fetch-event-examined" } });
    assert.equal(calls.some(call => /Fetch\.(continue|fulfill|fail)/.test(call.method)), false);
    assert.deepEqual(unavailableNativeRequestEvidence({ networkId: undefined }),
        { available: false, reason: "fetch-network-id-missing" });
    gate.retire();
});

test("a bounded bootstrap-child denial keeps exact accounting without admitting near misses", async () => {
    for (const scenario of ["blocked", "top", "foreign-origin", "foreign-frame", "foreign-network", "foreign-scope",
        "foreign-initiator", "unowned", "redirect", "abort-failure", "completed-network", "pending-network", "second-request",
        "browser-error", "foreign-error-loader"]) {
        const protocol = new EventEmitter(), calls = [], stopped = [], pending = new Set();
        const firstScope = { abort: new AbortController() };
        let scope = firstScope;
        protocol.send = async (method, input) => {
            calls.push({ method, input });
            if (scenario === "abort-failure" && method === "Fetch.failRequest") throw new Error("Invented abort failure.");
            return {};
        };
        const authorize = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
        const gate = await guardAccountOnlyRequests(protocol, {
            mainFrameId: "root", ownsFrame: id => ["root", "child", "different-child"].includes(id), getScope: () => scope,
            isSelfUrl: () => false, admit: () => null, responded() { assert.fail("Denied responses must not continue."); },
            blockedBootstrapChild: { origin: "https://blocked-bootstrap.invalid",
                qualify: (current, frame, initiator) => current === firstScope && frame === "child" && initiator === authorize },
            stop(current, reason) { stopped.push(reason); current?.abort.abort(); },
            track(work) { pending.add(work); work.finally(() => pending.delete(work)); return work; },
        });
        const request = { url: `${scenario === "foreign-origin" ? "https://foreign.invalid" : "https://blocked-bootstrap.invalid"}/private?secret=opaque`, method: "GET" };
        const frameId = scenario === "top" ? "root" : scenario === "unowned" ? "unowned-child" : "child";
        protocol.emit("Network.requestWillBeSent", { requestId: "network", frameId, type: "Document", request,
            initiator: { type: "parser", url: scenario === "foreign-initiator" ? "https://foreign.invalid" : authorize } });
        if (scenario === "foreign-scope") scope = { abort: new AbortController() };
        protocol.emit("Fetch.requestPaused", { requestId: "request", networkId: scenario === "foreign-network" ? "different-network" : "network",
            frameId: scenario === "foreign-frame" ? "different-child" : frameId, resourceType: "Document", request,
            ...(scenario === "redirect" ? { redirectedRequestId: "unbound-prior" } : {}) });
        await Promise.all([...pending]);
        assert.equal(calls.filter(x => x.method === "Fetch.continueRequest" || x.method === "Fetch.continueResponse").length, 0);
        if (["blocked", "completed-network", "pending-network", "second-request", "browser-error", "foreign-error-loader"].includes(scenario)) {
            assert.equal(gate.active, true);
            assert.equal(gate.pendingCount, 1);
            assert.equal(scope.blockedBootstrapChild.abortAcknowledged, true);
            if (scenario !== "pending-network") protocol.emit(scenario === "completed-network" ? "Network.loadingFinished" : "Network.loadingFailed",
                { requestId: "network" });
            if (["blocked", "second-request", "browser-error", "foreign-error-loader"].includes(scenario)) {
                assert.equal(gate.pendingCount, 0);
                assert.equal(scope.blockedBootstrapChild.networkFailed, true);
            }
            if (scenario === "completed-network") assert.equal(gate.active, false);
            if (["browser-error", "foreign-error-loader"].includes(scenario)) {
                protocol.emit("Page.frameNavigated", { frame: { id: "child",
                    loaderId: scenario === "browser-error" ? "network" : "foreign-loader",
                    url: "chrome-error://chromewebdata/", unreachableUrl: request.url } });
                protocol.emit("Network.loadingFinished", { requestId: "network" });
                assert.equal(gate.active, scenario === "browser-error");
                if (scenario === "browser-error") {
                    protocol.emit("Network.requestWillBeSent", { requestId: "local-image", frameId: "child", type: "Image",
                        request: { method: "GET", url: "data:image/png;base64,aW52ZW50ZWQ=" } });
                    assert.equal(gate.pendingCount, 1);
                    protocol.emit("Network.loadingFinished", { requestId: "local-image" });
                    assert.equal(gate.pendingCount, 0);
                    assert.equal(gate.active, true);
                    assert.equal(calls.some(x => x.method === "Fetch.continueRequest"), false);
                }
            }
            if (scenario === "second-request") {
                protocol.emit("Network.requestWillBeSent", { requestId: "second-network", frameId, type: "Document", request,
                    initiator: { type: "parser", url: authorize } });
                assert.equal(gate.active, false);
                assert.ok(stopped.includes("bootstrap-child-limit"));
            }
        } else assert.equal(gate.active, false, scenario);
        gate.retire();
    }
});

test("ordinary passive-preload denial preserves redirect, abort and authorization-context fences", async () => {
    for (const scenario of ["ordinary", "redirect", "abort-failure", "unexpected-completion", "second-request",
        "contexts", "contexts-repeat-partner", "contexts-repeat-cached", "contexts-unverified",
        "contexts-unsettled", "contexts-retired", "contexts-third", "contexts-image-limit", "contexts-image-reused",
        "contexts-stale-image", "contexts-network-reused", "contexts-abort-failure"]) {
        const protocol = new EventEmitter(), calls = [], pending = new Set(), scope = { abort: new AbortController() };
        const contextual = scenario.startsWith("contexts"), owned = new Set(["root", "child"]), stopped = [];
        let authorization = 0, admittedRole = "blocked-partner-preload";
        protocol.send = async (method, input) => {
            calls.push({ method, input });
            if (scenario === "abort-failure" && method === "Fetch.failRequest") throw new Error("Invented abort failure.");
            if (scenario === "contexts-abort-failure" && method === "Fetch.failRequest"
                && input.requestId === "fetch-cached-1") throw new Error("Invented second-context abort failure.");
            return {};
        };
        const gate = await guardAccountOnlyRequests(protocol, {
            mainFrameId: "root", ownsFrame: id => owned.has(id), getScope: () => scope,
            ...(contextual ? { getAuthorizationContext: () => authorization } : {}),
            isSelfUrl: () => false, admit: () => admittedRole, responded() { assert.fail("No response continuation."); },
            stop(current, reason) { stopped.push(reason); current.abort.abort(); },
            track(work) { pending.add(work); work.finally(() => pending.delete(work)); return work; },
        });
        if (contextual) {
            const deny = async (role, id, finish = true, networkId = id) => {
                admittedRole = role;
                owned.add(id);
                protocol.emit("Fetch.requestPaused", { requestId: "fetch-" + id, networkId, frameId: id,
                    resourceType: "Document", request: { url: "https://login.live.com/Me.htm?v=opaque", method: "GET" } });
                await Promise.all([...pending]);
                if (gate.active && finish) {
                    protocol.emit("Network.loadingFailed", { requestId: networkId });
                    protocol.emit("Page.frameNavigated", { frame: { id, loaderId: networkId,
                        url: "chrome-error://chromewebdata/", unreachableUrl: "https://login.live.com/Me.htm?v=opaque" } });
                }
            };
            const image = (frameId, requestId) => {
                protocol.emit("Network.requestWillBeSent", { requestId, frameId, type: "Image",
                    request: { method: "GET", url: "data:image/png;base64,aW52ZW50ZWQ=" } });
                if (gate.active) protocol.emit("Network.loadingFinished", { requestId });
            };
            if (scenario === "contexts-unverified") authorization = null;
            await deny("blocked-cached-session", "cached-0", scenario !== "contexts-unsettled");
            if (scenario === "contexts-unverified") {
                assert.equal(gate.active, false);
                assert.ok(stopped.includes("cached-session-association"));
            } else if (scenario === "contexts-unsettled") {
                authorization = 1;
                owned.delete("cached-0");
                await deny("blocked-cached-session", "cached-1");
                assert.equal(gate.active, false);
                assert.equal(scope.blockedCachedSession.networkFailed, false);
            } else {
                await deny("blocked-partner-preload", "partner-0");
                for (let index = 0; index < 4; index++) image("cached-0", "image-0-" + index);
                assert.equal(gate.active, true, scenario);
                if (scenario.startsWith("contexts-repeat-")) {
                    await deny(scenario.endsWith("cached") ? "blocked-cached-session" : "blocked-partner-preload", "repeat");
                    assert.equal(gate.active, false);
                } else if (scenario === "contexts-image-limit") {
                    image("cached-0", "image-fifth");
                    assert.equal(gate.active, false);
                    assert.ok(stopped.includes("bootstrap-child-error-limit"));
                } else if (scenario === "contexts-stale-image") {
                    authorization = null;
                    image("cached-0", "image-retired");
                    assert.equal(gate.active, false);
                    assert.ok(stopped.includes("bootstrap-child-error-correlation"));
                } else {
                    owned.delete("cached-0"); owned.delete("partner-0");
                    authorization = 1;
                    await deny("blocked-cached-session", "cached-1", true, scenario === "contexts-network-reused" ? "cached-0" : "cached-1");
                    if (["contexts-network-reused", "contexts-abort-failure"].includes(scenario)) {
                        assert.equal(gate.active, false);
                        assert.ok(stopped.includes(scenario === "contexts-network-reused"
                            ? "blocked-document-association" : "policy-abort-failed"));
                        if (scenario === "contexts-abort-failure") {
                            assert.equal(scope.blockedCachedSession.abortAcknowledged, false);
                            assert.equal(scope.blockedCachedSession.networkFailed, false);
                            assert.equal(scope.blockedCachedSession.contexts[0].networkFailed, true);
                            assert.equal(scope.blockedCachedSession.contexts[1].abortAcknowledged, false);
                        }
                        gate.retire();
                        continue;
                    }
                    await deny("blocked-partner-preload", "partner-1");
                    assert.equal(gate.active, true, scenario);
                    for (const role of [scope.blockedCachedSession, scope.blockedPartnerPreload]) {
                        assert.equal(role.attempts, 2);
                        assert.equal(role.abortAcknowledged, true);
                        assert.equal(role.networkFailed, true);
                        assert.deepEqual(role.contexts.map(row => row.authorizationContext), [0, 1]);
                        assert.ok(role.contexts.every(row => row.abortAcknowledged && row.networkFailed));
                    }
                    if (scenario === "contexts-image-reused") {
                        image("cached-1", "image-0-0");
                        assert.equal(gate.active, false);
                    } else {
                        for (let index = 0; index < 4; index++) image("cached-1", "image-1-" + index);
                        assert.equal(gate.active, true);
                        assert.equal(gate.pendingCount, 0);
                        if (scenario !== "contexts") {
                            owned.delete("cached-1"); owned.delete("partner-1");
                            authorization = scenario === "contexts-third" ? 2 : 0;
                            await deny("blocked-cached-session", "out-of-context");
                            assert.equal(gate.active, false);
                        }
                    }
                }
            }
            assert.equal(calls.some(call => call.method === "Fetch.continueRequest" || call.method === "Fetch.continueResponse"), false);
            gate.retire();
            continue;
        }
        const event = { requestId: "request", networkId: "network", frameId: "child", resourceType: "Document",
            request: { url: "https://login.live.com/Me.htm?v=opaque", method: "GET" } };
        protocol.emit("Fetch.requestPaused", { ...event, ...(scenario === "redirect" ? { redirectedRequestId: "unbound" } : {}) });
        await Promise.all([...pending]);
        if (!["redirect", "abort-failure"].includes(scenario)) {
            assert.equal(scope.blockedPartnerPreload.abortAcknowledged, true);
            protocol.emit(scenario === "unexpected-completion" ? "Network.loadingFinished" : "Network.loadingFailed", { requestId: "network" });
            if (scenario === "second-request") {
                protocol.emit("Fetch.requestPaused", { ...event, requestId: "second", networkId: "second-network" });
                await Promise.all([...pending]);
            }
        }
        assert.equal(gate.active, scenario === "ordinary");
        if (scenario === "ordinary") assert.equal(scope.blockedPartnerPreload.networkFailed, true);
        assert.equal(calls.some(call => call.method === "Fetch.continueRequest" || call.method === "Fetch.continueResponse"), false);
        gate.retire();
    }
});

test("native selected windows use each activity timestamp without capture-time or conversation-recency fallback", () => {
    const now = Date.parse("2026-10-24T12:00:00Z"), window = nativeHistoryWindow({ windowDays: 7, now });
    assert.deepEqual(window, { from: "2026-10-17T12:00:00.000Z", to: "2026-10-24T12:00:00.000Z" });
    assert.equal(nativeHistoryActivity({ createdAt: window.from }, "chat", window).state, "unqualified",
        "A parseable timestamp is not producer qualification.");
    assert.equal(nativeHistoryActivity({ createdAt: window.from }, "chat", window, "iso8601").state, "in-window");
    assert.equal(nativeHistoryActivity({ createdAt: "2026-10-01T12:00:00Z", timestamp: window.to }, "chat", window, "iso8601").state, "outside");
    assert.equal(nativeHistoryActivity({ timestamp: window.to }, "chat", window, "iso8601").state, "unqualified");
    assert.equal(nativeHistoryActivity({ createdAt: now }, "chat", window, "iso8601").state, "unqualified");
    assert.equal(nativeHistoryActivity({ data: { ts: now } }, "cowork", window).state, "unqualified",
        "An epoch unit is not guessed from a number.");
    const activity = nativeHistoryActivity({ id: "native-event", data: { ts: window.to } }, "cowork", window, "iso8601");
    assert.equal(activity.state, "in-window");
    assert.equal(activity.unit, "iso8601");
    assert.equal(activity.value, window.to);
    assert.equal(nativeHistoryActivity({ data: { ts: now } }, "cowork", window, "epoch-ms").state, "in-window");
    assert.equal(nativeHistoryActivity({ data: { ts: "2026-10-24T12:00:00.001Z" } }, "cowork", window, "iso8601").state, "outside");
});

test("source-native account namespaces isolate partitions without relabeling legacy subject identifiers", async () => {
    let namespace = "m365.accountInfo.objectId";
    const transport = createMicrosoftNativeReadTransport({
        async open() {},
        async verifyAccount() { return { ...proof("native-subject"),
            evidence: { ...proof("native-subject").evidence, namespace, realm: "prod" } }; },
        async stop() { return { processExited: true, profileReleased: true }; },
    });
    const op = operation(randomUUID());
    await transport.open(op);
    const first = await transport.verify(op);
    const identity = transport.accountFor({ kind: "microsoft-retained", partition: first.partition });
    assert.equal(identity.namespace, namespace);
    assert.equal(identity.realm, "prod");
    assert.equal(identity.account.subjectId, "native-subject");
    const legacy = createHash("sha256").update(JSON.stringify([
        "microsoft-native-account-v1", "https://example.invalid", "example-tenant", "native-subject",
    ])).digest("hex");
    assert.notEqual(first.partition, legacy);
    await transport.stop(op);
    namespace = "different-native-namespace";
    await transport.open(op);
    assert.notEqual((await transport.verify(op)).partition, first.partition);
});

test("native Chat reinitializes the selected document instead of a skipped same-route fetch", async t => {
    const browser = await chromium.launch({ channel: "msedge", headless: true, chromiumSandbox: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ offline: true });
    const initializer = "/_serverFn/" + nativeHistoryProducer.chatInitializerRpcId;
    let documents = 0, initializers = 0;
    await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        assert.equal(request.method(), "GET");
        if (url.pathname === initializer) {
            initializers++;
            return route.fulfill({ json: {} });
        }
        assert.equal(url.pathname, "/chat/all");
        documents++;
        return route.fulfill({ contentType: "text/html", body: `<link rel="icon" href="data:,">
            <a href="/chat/all" onclick="event.preventDefault();window.skipped=true">All chats</a>
            <script>fetch(${JSON.stringify(initializer)}).then(()=>window.ready=true)</script>` });
    });
    const page = await context.newPage();
    await page.goto("https://m365.cloud.microsoft/chat/all");
    await page.waitForFunction(() => window.ready === true);
    await clickNativeHistoryLink(page, { surface: "chat", initialize: true });
    await page.waitForFunction(() => window.ready === true);
    assert.equal(documents, 2);
    assert.equal(initializers, 2);
    assert.equal(await page.evaluate(() => window.skipped), undefined);
});

test("native Cowork discovery resets loaded root and task-fragment documents without replaying a history request", async t => {
    const browser = await chromium.launch({ channel: "msedge", headless: true, chromiumSandbox: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ offline: true });
    let documents = 0, lists = 0, selected = "/cowork/";
    await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        assert.equal(request.method(), "GET");
        if (url.pathname === "/v1/tasks/live") {
            lists++;
            return route.fulfill({ json: { tasks: [], nextCursor: null } });
        }
        assert.equal(url.pathname, "/cowork/");
        documents++;
        return route.fulfill({ contentType: "text/html", body: `<link rel="icon" href="data:,">
            <a href="${selected}" onclick="event.preventDefault();window.cached=true">Cowork</a>
            <script>fetch("/v1/tasks/live").then(()=>window.ready=true)</script>` });
    });
    const page = await context.newPage();
    for (const fragment of ["", "#/task/invented-task", "#/"]) {
        selected = fragment === "#/" ? "/cowork/#/" : "/cowork/";
        await page.goto("https://m365.cloud.microsoft/cowork/");
        await page.waitForFunction(() => window.ready === true);
        if (fragment) await page.goto("https://m365.cloud.microsoft/cowork/" + fragment);
        const before = { documents, lists };
        await clickNativeHistoryLink(page, { surface: "cowork", initialize: true });
        await page.waitForFunction(() => window.ready === true);
        assert.equal(documents, before.documents + 1);
        assert.equal(lists, before.lists + 1);
        assert.equal(await page.evaluate(() => window.cached), undefined);
        assert.equal(page.url(), "https://m365.cloud.microsoft" + selected);
    }
});

test("unqualified native history controls retain their error code", async () => {
    const page = { locator: () => ({ filter: () => ({ evaluateAll: async () => [] }) }) };
    await assert.rejects(clickNativeHistoryLink(page, { surface: "chat" }), { code: "NATIVE_HISTORY_CONTROL_UNQUALIFIED" });
    await assert.rejects(clickNativeHistoryLink(page, { surface: "invalid" }), { code: "NATIVE_HISTORY_CONTROL_UNQUALIFIED" });
    await assert.rejects(clickNativeHistoryLink(page, { surface: "cowork", id: "task", initialize: true }),
        { code: "NATIVE_HISTORY_CONTROL_UNQUALIFIED" });
    await assert.rejects(clickNativeHistoryLink(page, { surface: "cowork", initialize: true, revealOnly: true }),
        { code: "NATIVE_HISTORY_CONTROL_UNQUALIFIED" });
});

test("older-message UI progression uses only one current published scroll region without reading text or taking focus", async t => {
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ offline: true }), page = await context.newPage();
    const url = "https://m365.cloud.microsoft/cowork/#/task/fixture";
    await page.route("https://m365.cloud.microsoft/**", route => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto(url);
    let current = true, checks = 0;
    const assertCurrent = () => { checks++; if (!current) throw new Error("revoked"); };
    const markup = (body = "legacy", loader = '<div data-older-messages-loader></div>') =>
        `<input id="untouched" value="PRIVATE_INPUT"><div role="region" data-chat-scroll-container="true" data-timeline-body="${body}"
            style="height:100px;overflow:auto">${loader}<div style="height:1000px">PRIVATE_MESSAGE</div></div>`;
    for (const body of ["legacy", "virtualized"]) {
        await page.setContent(markup(body));
        await page.locator("#untouched").focus();
        await page.locator("[data-chat-scroll-container]").evaluate(region => {
            region.scrollTop = 400;
            Object.defineProperty(region, "textContent", { get() { throw new Error("No message text inspection"); } });
        });
        assert.equal(await revealNativeOlderMessages(page, url, assertCurrent), "revealed");
        assert.equal(await page.locator("[data-chat-scroll-container]").evaluate(region => region.scrollTop), 0);
        assert.equal(await page.evaluate(() => document.activeElement.id), "untouched");
    }
    await page.setContent(markup("legacy", '<div data-older-messages-loader><span role="status">Loading</span></div>'));
    await page.locator("[data-chat-scroll-container]").evaluate(region => { region.scrollTop = 400; });
    assert.equal(await revealNativeOlderMessages(page, url, assertCurrent), "loading");
    assert.equal(await page.locator("[data-chat-scroll-container]").evaluate(region => region.scrollTop), 400);
    for (const html of ["<main></main>", markup("legacy", ""), `<div hidden>${markup()}</div>`]) {
        await page.setContent(html);
        assert.equal(await revealNativeOlderMessages(page, url, assertCurrent), "pending");
    }
    for (const html of [markup() + markup(), markup("unknown"),
        markup("legacy", '<div data-older-messages-loader></div><div data-older-messages-loader></div>')]) {
        await page.setContent(html);
        await assert.rejects(revealNativeOlderMessages(page, url, assertCurrent), { code: "NATIVE_HISTORY_CONTROL_UNQUALIFIED" });
    }
    await page.setContent(markup());
    await assert.rejects(revealNativeOlderMessages(page, url + "-different", assertCurrent), { code: "NATIVE_SOURCE_DOCUMENT_CHANGED" });
    current = false;
    await assert.rejects(revealNativeOlderMessages(page, url, assertCurrent), /revoked/);
    assert.ok(checks > 10);
});

test("native Cowork task rows open the original identity and reveal only their own paging sentinel", async t => {
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ offline: true }), page = await context.newPage();
    page.setDefaultTimeout(1000);
    const url = "https://m365.cloud.microsoft/cowork/";
    await page.route("https://m365.cloud.microsoft/**", route => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto(url);
    const input = { surface: "cowork", tenantId: "tenant", subjectId: "subject", id: "original-session" };
    const markup = rowId => `<ul role="list" aria-busy="false"><li data-row-id="${rowId}" tabindex="0" style="height:1200px">
        <button data-actions-trigger>Run now</button></li></ul>
        <div style="position:relative;height:40px"><div aria-hidden="true" style="position:absolute;top:0;height:1px;width:1px"></div></div>`;
    const kinds = [];
    for (const rowId of ["tenant:subject:original-session", "feed-original-session"]) {
        await page.setContent(markup(rowId));
        await page.evaluate(() => {
            window.opened = 0; window.mutated = 0;
            document.querySelector("li").addEventListener("keydown", event => {
                if (event.target === event.currentTarget && event.key === "Enter") window.opened++;
            });
            document.querySelector("button").onclick = () => { window.mutated++; };
        });
        const result = await clickNativeHistoryLink(page, { ...input, taskRows: async kind => { kinds.push(kind); } });
        assert.deepEqual(result, { kind: "cowork-task-row" });
        assert.deepEqual(await page.evaluate(() => [window.opened, window.mutated]), [1, 0]);
        await page.evaluate(() => {
            window.paged = false; window.scrollTo(0, 0);
            const observer = new IntersectionObserver(entries => {
                if (entries.some(entry => entry.isIntersecting)) { window.paged = true; observer.disconnect(); }
            });
            observer.observe(document.querySelector("ul").nextElementSibling.firstElementChild);
        });
        await clickNativeHistoryLink(page, { ...input, revealOnly: true, taskRows: async () => {} });
        await page.waitForFunction(() => window.paged);
        assert.deepEqual(await page.evaluate(() => [window.opened, window.mutated]), [1, 0]);
    }
    assert.ok(kinds.includes("task") && kinds.includes("feed"));
    for (const html of [markup("foreign-row"), markup("tenant:subject:original-session") + markup("tenant:subject:original-session"),
        markup("tenant:subject:original-session").replace("<button", '<span data-select-checkbox></span><button'),
        markup("tenant:subject:original-session").replace('aria-busy="false"', 'aria-busy="true"')]) {
        await page.setContent(html);
        await assert.rejects(clickNativeHistoryLink(page, { ...input, taskRows: async () => {} }), { code: "NATIVE_HISTORY_CONTROL_UNQUALIFIED" });
    }
    await page.setContent(markup("tenant:subject:original-session"));
    await assert.rejects(clickNativeHistoryLink(page, { ...input, taskRows: async () => { throw new Error("revoked"); } }), /revoked/);
});

test("qualified image denial settles only after a current acknowledged abort and its original failed terminal", async t => {
    const start = Date.now();
    let now = start;
    t.mock.method(Date, "now", () => now);
    for (const scenario of ["ack-first", "terminal-first", "missing-terminal", "missing-ack", "invalid-ack", "rejected-ack",
        "owner-at-ack", "stale-at-terminal", "expired-at-ack", "expired-at-terminal", "finished", "duplicate",
        "unmatched-terminal", "unbound", "script", "navigation", "post"]) {
        now = start;
        const handlers = new Map(), commands = [], stopped = [];
        const pending = Promise.withResolvers(), requested = Promise.withResolvers();
        const scope = { abort: new AbortController() };
        let current = scope, bound = true;
        const event = { requestId: "image-fetch", networkId: "image-network", frameId: "main",
            resourceType: scenario === "script" ? "Script" : scenario === "navigation" ? "Document" : "Image",
            request: { url: "https://aadcdn.msftauthimages.net/opaque?value=PRIVATE_IMAGE_VALUE",
                method: scenario === "post" ? "POST" : "GET",
                get headers() { assert.fail("Image denial does not inspect headers."); },
                get postData() { assert.fail("Image denial does not inspect bodies."); } } };
        const gate = await guardAccountOnlyRequests({
            on(name, listener) { handlers.set(name, listener); },
            async send(method, input) {
                commands.push({ method, input });
                if (method !== "Fetch.failRequest") return {};
                requested.resolve();
                if (scenario === "terminal-first") return pending.promise;
                if (scenario === "missing-ack") return undefined;
                if (scenario === "invalid-ack") return { unexpected: true };
                if (scenario === "rejected-ack") throw new Error("Fixture abort failed");
                if (scenario === "owner-at-ack") current = null;
                if (scenario === "expired-at-ack") now = start + 1000;
                return {};
            },
        }, {
            mainFrameId: "main", getScope: () => current, track: work => work,
            admit: () => "policy-block", responded() {},
            bindDeniedImage: () => scenario === "unbound" ? null : { deadline: start + 1000, current: () => bound && current === scope },
            stop(_, reason) { if (!scope.abort.signal.aborted) { stopped.push(reason); scope.abort.abort(); } },
        });
        const terminal = { requestId: "image-network", type: "Image" };
        const request = handlers.get("Fetch.requestPaused")(event);
        await requested.promise;
        if (scenario === "terminal-first") {
            handlers.get("Network.loadingFailed")(terminal);
            assert.equal(gate.pendingCount, 1, "The failed terminal is not an acknowledgement.");
            assert.deepEqual(stopped, []);
            pending.resolve({});
        }
        await request;
        const preterminalRefused = ["missing-ack", "invalid-ack", "rejected-ack", "owner-at-ack", "expired-at-ack",
            "unbound", "script", "navigation", "post"].includes(scenario);
        if (!preterminalRefused && scenario !== "terminal-first") {
            assert.equal(gate.pendingCount, 1, "Acknowledgement alone cannot settle a denied image.");
            if (scenario === "stale-at-terminal") bound = false;
            if (scenario === "expired-at-terminal") now = start + 1000;
            if (scenario !== "missing-terminal") {
                handlers.get(scenario === "finished" ? "Network.loadingFinished" : "Network.loadingFailed")(
                    scenario === "unmatched-terminal" ? { ...terminal, requestId: "unrelated-network" } : terminal);
                if (scenario === "duplicate") handlers.get("Network.loadingFailed")(terminal);
            }
        }
        const expected = ["missing-ack", "invalid-ack", "rejected-ack"].includes(scenario) ? "policy-abort-failed"
            : ["owner-at-ack", "stale-at-terminal"].includes(scenario) ? "operation-closed"
                : scenario.startsWith("expired-") ? "capacity-deadline"
                    : scenario === "finished" ? "network-block-completed"
                        : ["duplicate", "unmatched-terminal"].includes(scenario) ? "network-record-missing"
                            : ["unbound", "script", "navigation", "post"].includes(scenario) ? "policy-block-scope" : null;
        assert.deepEqual(stopped, expected ? [expected] : [], scenario);
        assert.equal(commands.some(command => ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.fulfillRequest"].includes(command.method)), false,
            "The policy-block path must not forward or fabricate an image response.");
        if (!expected) assert.equal(gate.pendingCount, scenario === "missing-terminal" ? 1 : 0, scenario);
        gate.retire();
    }
});

test("detected history control failures survive a rejected observation write", async () => {
    for (const match of ["missing", "ambiguous"]) {
        const page = { locator: () => ({ filter: () => ({
            evaluateAll: async () => match === "missing" ? [] : ["/chat/all", "/chat/all"],
            count: async () => 2,
        }) }) };
        let observed = false, original;
        await assert.rejects(clickNativeHistoryLink(page, { surface: "chat", observe: async event => {
            observed = true; original = event.failure;
            assert.equal(event.control.match, match);
            throw Object.assign(new Error("Private receipt write rejected"), { code: "EIO" });
        } }), error => error.code === "NATIVE_HISTORY_CONTROL_UNQUALIFIED" && error === original);
        assert.equal(observed, true);
    }
});

test("native history entry recognition does not equate Cowork root with My tasks", () => {
    assert.equal(nativeHistoryEntry("chat", "https://m365.cloud.microsoft/chat/all"), "chat-all");
    assert.equal(nativeHistoryEntry("cowork", "https://m365.cloud.microsoft/cowork/"), "cowork-root");
    assert.equal(nativeHistoryEntry("cowork", "https://m365.cloud.microsoft/cowork/#/"), "cowork-root");
    assert.equal(nativeHistoryEntry("cowork", "https://m365.cloud.microsoft/cowork/#/my-tasks"), "cowork-my-tasks");
    assert.equal(nativeHistoryEntry("cowork", "https://m365.cloud.microsoft/hwav2/cowork/#/my-tasks"), "cowork-my-tasks");
    assert.equal(nativeHistoryEntry("cowork", "https://example.invalid/cowork/#/my-tasks"), "unobserved");
    assert.equal(nativeHistoryEntry("cowork", "https://m365.cloud.microsoft/cowork/#/task/private-id"), "unobserved");
});

test("bootstrap recognition and clicks share published anchors and existing sign-in labels", async t => {
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ offline: true }), document = await context.newPage();
    let location = "https://copilot.cloud.microsoft/home";
    // Offline DOM controls only, not a provider page, response or identity proof.
    const page = { url: () => location, locator: selector => document.locator(selector) };
    const input = { phase: "blank-native-start", expectedAccount: "example@invalid.test" };
    const anchors = ["hero-banner-sign-in-to-office-365-link", "hero-banner-sign-back-in-to-office-365-link"];
    for (const [id, label] of [...anchors.map(id => [id, "Published entry"]), ["legacy-lowercase", "sign in"], ["legacy-login", "Log in"]]) {
        location = "https://copilot.cloud.microsoft" + (id === anchors[0] ? "/" : "/home");
        const href = "#" + id;
        await document.setContent(`<a id="${id}" href="${href}">${label}</a>`);
        const metadata = await collectBootstrapUIMetadata(page, input);
        assert.equal(metadata.kind, "app-signin-control");
        assert.equal(metadata.signInMatches, 1);
        const control = nativeSignInControl(page);
        assert.equal(await control.count(), 1);
        assert.equal(await control.getAttribute("href"), href);
        await control.click();
        assert.equal(await document.evaluate(() => location.hash), href);
        assert.equal(await control.getAttribute("href"), href, "The host must not manufacture a target or login hint.");
    }
    await document.setContent('<button>Sign in</button>');
    assert.equal((await collectBootstrapUIMetadata(page, input)).kind, "app-signin-control");
    assert.equal(await nativeSignInControl(page).count(), 1);
    await document.setContent(anchors.map(id => `<a id="${id}" href="#existing">Published entry</a>`).join(""));
    assert.equal((await collectBootstrapUIMetadata(page, input)).signInMatches, 2);
    assert.notEqual((await collectBootstrapUIMetadata(page, input)).kind, "app-signin-control");
    assert.equal(await nativeSignInControl(page).count(), 2, "Do not choose one ambiguous entry automatically.");
    await document.locator("#" + anchors[0]).evaluate(node => { node.hidden = true; });
    assert.equal((await collectBootstrapUIMetadata(page, input)).signInMatches, 1);
    for (const html of ['<a href="#existing">Published entry</a>',
        `<a id="${anchors[0]}">Published entry</a>`, `<div id="${anchors[0]}">Published entry</div>`]) {
        await document.setContent(html);
        assert.equal(await nativeSignInControl(page).count(), 0);
    }
    for (const value of ["https://example.invalid/home", "https://copilot.cloud.microsoft/cowork/"]) {
        location = value;
        assert.throws(() => nativeSignInControl(page), /SIGNIN_CONTROL_SURFACE_UNQUALIFIED/);
    }
    location = "https://copilot.cloud.microsoft/";
    await document.setContent("<main></main>");
    assert.equal((await collectBootstrapUIMetadata(page, input)).kind, "app-signin-not-yet-observed");
    assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase: "unqualified-phase" })).kind, "app-bootstrap-transit-metadata-only");
    for (const phase of ["native-signin-invoked", "known-account-selection-invoked"]) {
        for (const appPath of ["/", "/home"]) {
            location = "https://copilot.cloud.microsoft" + appPath;
            await document.setContent("<main></main>");
            const returned = await collectBootstrapUIMetadata(page, { ...input, phase });
            assert.equal(returned.kind, "app-home-metadata-only");
            assert.equal(returned.signInMatches, 0);
            assert.equal(Object.hasOwn(returned, "accountVerified"), false);
            await document.setContent('<button>Sign in</button>');
            assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase })).kind, "app-home-signin-present");
        }
        for (const appPath of ["/login", "/landingv2", "/spalanding"]) {
            location = "https://copilot.cloud.microsoft" + appPath;
            assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase })).kind, "app-bootstrap-transit-metadata-only");
        }
    }
    for (const authUiOrigin of ["https://login.microsoftonline.com", "https://login.microsoft.com"]) {
        location = authUiOrigin + "/common";
        await document.setContent("<h1>Pick an account</h1><button>example@invalid.test</button>");
        assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase: "native-entry-invoked" })).kind, "known-account-picker");
        assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase: "native-signin-invoked" })).kind, "known-account-picker");
        await document.setContent('<input type="password">');
        assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase: "native-signin-invoked" })).kind, "auth-challenge-control");
        assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase: "native-signin-invoked" })).interaction, "password");
        await document.setContent('<input name="loginfmt" type="email">');
        assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase: "native-signin-invoked" })).interaction, "username");
        await document.setContent("<h1>Verify your identity</h1>");
        assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase: "native-entry-invoked" })).interaction, "mfa");
        await document.setContent('<button id="idBtn_Accept">Accept</button>');
        assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase: "native-entry-invoked" })).interaction, "consent");
        location = authUiOrigin + "/common/fido/fixture";
        await document.setContent("<h1>Pick an account</h1><button>example@invalid.test</button>");
        const securitySelection = await collectBootstrapUIMetadata(page, { ...input, phase: "native-entry-invoked" });
        assert.equal(securitySelection.kind, "auth-challenge-control", "A FIDO selection is not an ordinary account-tile automation.");
    }
    location = nativeApplicationEntry;
    await document.setContent("<main></main>");
    assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase: "native-entry-invoked" })).kind, "app-shell-metadata-only");
    await document.setContent(`<a id="${anchors[0]}" href="#unchanged">Published elsewhere</a>`);
    assert.equal(await nativeSignInControl(page).count(), 0, "Landing-page IDs do not qualify shell controls.");
    await document.setContent('<a href="#unchanged">Sign in</a>');
    assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase: "native-entry-invoked" })).kind, "app-signin-control");
    await nativeSignInControl(page).click();
    assert.equal(await document.evaluate(() => location.hash), "#unchanged");
    location = nativeApplicationEntry + "?fromcode=example";
    assert.throws(() => nativeSignInControl(page), /SIGNIN_CONTROL_SURFACE_UNQUALIFIED/);
    location = "https://m365.cloud.microsoft/login";
    assert.equal((await collectBootstrapUIMetadata(page, { ...input, phase: "native-entry-invoked" })).kind, "app-bootstrap-transit-metadata-only");
});

test("account-only shared decision admits only the exact shell document and preserves data/auth fences", t => {
    const base = { url: new URL(nativeApplicationEntry), method: "GET", type: "document", navigation: true,
        owned: true, original: true, pageOrigin: "https://m365.cloud.microsoft",
        tokenEndpoint: "https://login.microsoftonline.com/example-tenant/oauth2/v2.0/token",
        signInClicked: false, accountSelected: false };
    assert.equal(accountOnlyRequestDecision(base).kind, "shell");
    for (const change of [{ owned: false }, { method: "POST" }, { method: "HEAD" },
        { type: "fetch", navigation: false }, { type: "xhr", navigation: false },
        ...["?fromcode=example", "?", "#", "#example", "/conversation/example", "/"].map(suffix => ({ url: new URL(nativeApplicationEntry + suffix) }))]) {
        assert.ok(accountOnlyRequestDecision({ ...base, ...change }).denied);
    }
    for (const pathname of ["/api/account", "/api/tasks", "/chat/conversation/example", "/history", "/api/Recent",
        "/api/conversations", "/api/messages", "/api/actions", "/cowork/"]) {
        for (const original of [true, false]) {
            assert.ok(accountOnlyRequestDecision({ ...base, original, url: new URL(pathname, base.url) }).denied);
        }
    }
    const landing = { ...base, url: new URL("/landingv2", base.url), method: "POST" };
    assert.equal(accountOnlyRequestDecision(landing).denied, "sign-in-return-method");
    assert.equal(accountOnlyRequestDecision({ ...landing, signInClicked: true }).denied, "sign-in-return-method");
    assert.equal(accountOnlyRequestDecision({ ...landing, signInClicked: true, accountSelected: true }).kind, "document");
    const self = { ...base, url: new URL("https://graph.microsoft.com/v1.0/me"), type: "fetch", navigation: false };
    assert.equal(accountOnlyRequestDecision(self).kind, "self");
    assert.equal(accountOnlyRequestDecision({ ...self, original: false }).denied, "self-scope");
    assert.equal(accountOnlyRequestDecision({ ...self, method: "OPTIONS" }).denied, "self-preflight-association");
    assert.equal(accountOnlyRequestDecision({ ...self, method: "OPTIONS", selfPreflightAssociated: true }).kind, "self-preflight");
    for (const change of [{ owned: false }, { original: false }, { navigation: true }, { pageOrigin: "https://example.invalid" }]) {
        assert.ok(accountOnlyRequestDecision({ ...self, method: "OPTIONS", selfPreflightAssociated: true, ...change }).denied);
    }
    for (const query of ["?$select=", "?$select=id,id", "?$select=id&$select=mail", "?$select=*",
        "?$select=identities", "?$select=id&$expand=manager", "?$filter=id", "?$SELECT=id", "?$select=id&&"]) {
        assert.ok(accountOnlyRequestDecision({ ...self, url: new URL(self.url.href + query) }).denied);
        assert.ok(accountOnlyRequestDecision({ ...self, method: "OPTIONS", selfPreflightAssociated: true,
            url: new URL(self.url.href + query) }).denied);
    }
    const token = { ...base, url: new URL(base.tokenEndpoint + "?unchanged=example"), type: "fetch", navigation: false, method: "POST" };
    assert.equal(accountOnlyRequestDecision(token).kind, "token");
    assert.equal(accountOnlyRequestDecision({ ...token, original: false }).denied, "token-scope");
    assert.equal(accountOnlyRequestDecision({ ...token, owned: false }).denied, "unowned-frame");
    assert.equal(accountOnlyRequestDecision({ ...token, url: new URL(token.url.href.replace("example-tenant", "common")) }).denied, "token-scope");
    const blockedData = { ...base, url: new URL("https://example.invalid/config"), type: "fetch", navigation: false };
    assert.deepEqual(accountOnlyRequestDecision(blockedData), { denied: "data-dependency", blockOnly: true });
    assert.equal(accountOnlyRequestDecision({ ...blockedData, type: "xhr" }).blockOnly, true);
    for (const change of [{ owned: false }, { original: false }, { navigation: true }, { method: "POST" }, { method: "HEAD" },
        { type: "script" }, { url: new URL("https://m365.cloud.microsoft/api/tasks") }, { url: self.url }, { url: token.url }]) {
        assert.notEqual(accountOnlyRequestDecision({ ...blockedData, ...change }).blockOnly, true);
    }
    for (const key of ["search", "searchParams"]) t.mock.getter(URL.prototype, key, () => assert.fail("Denial context must not inspect queries."));
    assert.deepEqual(accountOnlyDenialContext(base), { method: "GET", resourceType: "document", navigation: true,
        owned: true, original: true, target: "shell", queryPresent: false, stage: "other" });
    for (const [url, target] of [[base.url.href, "shell"], [landing.url.href, "landingv2"],
        ["https://m365.cloud.microsoft/login", "other-account-page"], [token.url.href, "token"], [self.url.href, "self"],
        ["https://m365.cloud.microsoft/api/tasks/EXAMPLE_PRIVATE_LABEL", "protected-data"],
        ["https://res.cdn.office.net/officehub/bundles/unauth-bcb078e6e9.js", "static"],
        ["https://example.invalid/EXAMPLE_PRIVATE_LABEL", "other"]]) {
        const context = accountOnlyDenialContext({ ...base, type: "Script", url: new URL(url) });
        assert.equal(context.target, target);
        assert.equal(context.resourceType, "script");
        assert.doesNotMatch(JSON.stringify(context), /EXAMPLE_PRIVATE_LABEL|https:|example-tenant|unchanged/);
    }
    for (const [suffix, present] of [["?private=EXAMPLE_PRIVATE_LABEL&nonce=EXAMPLE_PRIVATE_LABEL", true],
        ["?", true], ["#?private=EXAMPLE_PRIVATE_LABEL", false]]) {
        assert.equal(accountOnlyDenialContext({ ...token, url: new URL(base.tokenEndpoint + suffix) }).queryPresent, present);
    }
    assert.deepEqual(accountOnlyDenialContext({ ...base, method: "EXAMPLE_PRIVATE_LABEL", type: "EXAMPLE_PRIVATE_LABEL" }),
        { method: "OTHER", resourceType: "other", navigation: true, owned: true, original: true, target: "shell", queryPresent: false, stage: "other" });
    assert.equal(accountOnlyDenialContext(null), null);
});

async function configurationFixture(t, expectedCloseError = null) {
    const cleanups = [];
    const { context, root } = await privateFixture({ after: work => cleanups.push(work) }, []);
    let host;
    t.after(async () => {
        try {
            if (host && expectedCloseError) await assert.rejects(host.close(), { code: expectedCloseError });
            else await host?.close();
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    const tenant = randomUUID(), subject = randomUUID(), session = randomUUID();
    const target = { schemaVersion: 1, expectedAccount: "example@invalid.test", expectedTenant: tenant,
        expectedSubject: subject, chatPath: "/chat/conversation/" + randomUUID(),
        coworkFragment: `${tenant}:${subject}:${session}`, coworkThreadId: "example-thread" };
    const bytes = JSON.stringify(target);
    const config = { schemaVersion: 1, targetMetadataPath: path.join(root, "target.json"),
        targetMetadataSha256: createHash("sha256").update(bytes).digest("hex"),
        profileDirectory: path.join(root, "never-opened", "profile"), profileOwnerSessionId: randomUUID(),
        ownerLockPath: path.join(root, "native-owner.lock") };
    const file = path.join(root, "source.json");
    await writeFile(config.targetMetadataPath, bytes);
    await writeFile(file, JSON.stringify(config));
    return { context, root, file, config, target, async start(configuration, hostContext = context, sourceAware = false, nativeAcquisition, accountOnlyVerification,
        blockedBootstrapChildOrigin = null, observeAuthenticationChain = false, visibleSignIn = false, visibilityExperiment = false,
        engineering = null, ordinaryStartup = false, nativeScheduling = ordinaryStartup) {
        host = await createMicrosoftNativeHost(hostContext, { configuration, sourceAware,
            blockedBootstrapChildOrigin, observeAuthenticationChain, visibleSignIn, visibilityExperiment, engineering, ordinaryStartup, nativeScheduling,
            ...(nativeAcquisition === undefined ? {} : { nativeAcquisition }),
            ...(accountOnlyVerification === undefined ? {} : { accountOnlyVerification }) });
        return host;
    } };
}

test("native host scheduling requires a boolean and a source-aware binding", async () => {
    for (const options of [{ sourceAware: true, nativeScheduling: "enabled" }, { nativeScheduling: true }]) {
        await assert.rejects(createMicrosoftNativeHost({}, options), { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
    }
});

for (const scenario of ["initializer", "sections", "sections-old-cohort", "document", "wrong-identity", "generic-entry", "extra-page", "detail", "read-marker",
    "attended-unclassified", "attended-password", "attended-presentation-cancel",
    "detail-navigation", "unprojected", "runner", "runner-shape", "runner-normal-entry", "runner-delayed-entry",
    "runner-preparation-close", "runner-connect-deadline", "runner-startup-cancel",
    "runner-connect-presentation", "runner-terminal-presentation"]) {
    test(`bounded engineering original transport: ${scenario}`, { timeout: 60000 }, async t => {
        const normalRunner = ["runner-normal-entry", "runner-delayed-entry", "runner-preparation-close",
            "runner-connect-deadline", "runner-startup-cancel", "runner-connect-presentation", "runner-terminal-presentation"].includes(scenario);
        const experience = ["runner-connect-presentation", "runner-terminal-presentation"].includes(scenario);
        const experienceProof = experience && process.env.WIRE_CONNECT_EXPERIENCE_PROOF_DIR;
        const preparationOnly = ["runner-preparation-close", "runner-startup-cancel"].includes(scenario);
        const connectDeadline = scenario === "runner-connect-deadline";
        if (normalRunner && !process.env.WIRE_HISTORY_TEST_COMMIT) {
            t.skip("Run explicitly against the clean committed offline candidate.");
            return;
        }
        const sections = ["sections", "sections-old-cohort", "runner-normal-entry", "runner-delayed-entry"].includes(scenario);
        const unclassifiedAttention = scenario === "attended-unclassified";
        const classifiedAttention = scenario === "attended-password";
        const presentationCancel = scenario === "attended-presentation-cancel";
        const attended = unclassifiedAttention || classifiedAttention || presentationCancel || experience;
        const attentionDocument = Promise.withResolvers(), attentionNotice = Promise.withResolvers(), mfaNotice = Promise.withResolvers();
        const presentationPending = Promise.withResolvers(), releasePresentation = Promise.withResolvers(), windowActions = [];
        let host, browser, wireBrowser, release, initialWindowActions, nativeLaunches = 0;
        t.after(async () => { await host?.close(); await browser?.close(); await wireBrowser?.close(); await release?.(); });
        const fixture = await configurationFixture(t);
        release = await acquireCollectorLock(fixture.context.dataDir);
        await mkdir(fixture.config.profileDirectory, { recursive: true });
        await writeFile(path.join(path.dirname(fixture.config.profileDirectory), "profile-owner.json"),
            JSON.stringify({ sessionId: fixture.config.profileOwnerSessionId, profile: "profile" }));
        await writeFile(fixture.file, JSON.stringify({ schemaVersion: 2, expectedAccount: "example@invalid.test",
            profileDirectory: fixture.config.profileDirectory, profileOwnerSessionId: fixture.config.profileOwnerSessionId,
            ownerLockPath: fixture.config.ownerLockPath }));
        const configuration = await readMicrosoftNativeConfiguration(fixture.file);
        const events = [], messages = [], calls = [], rawReads = [], logs = [], failures = [];
        const engineering = createHistoryEngineering({ expectedAccount: configuration.expectedAccount,
            salt: Array(32).fill(5), onEvent: value => {
                events.push(value);
                if (value.type === "window-ready") initialWindowActions = [...windowActions];
                if (value.type === "human-needed" && value.interaction === "password") attentionNotice.resolve(value);
                if (value.type === "human-needed" && value.interaction === "mfa") mfaNotice.resolve(value);
            } });
        t.mock.method(console, "info", (...value) => logs.push(value));
        t.mock.method(console, "error", (...value) => logs.push(value));
        const app = "https://m365.cloud.microsoft", gateway = "https://fixture.gateway.prod.island.powerapps.com";
        const initializer = "/_serverFn/22ef9231e91dd4cf46350df4f8e31fc54e727335d4a882bc56199bd904815585";
        const tenant = "11111111-1111-4111-8111-111111111111", subject = "22222222-2222-4222-8222-222222222222";
        const account = { accountType: "AAD", environment: "prod", tenantId: tenant, objectId: subject };
        const principal = { store: { accountInfo: account, identity: {
            userPrincipalName: scenario === "wrong-identity" ? "wrong@invalid.test" : configuration.expectedAccount } } };
        const list = page => ({ historySource: "all-chats", store: { conversationPageHistoryList: {
            chats: [{ conversationId: "PRIVATE_CHAT_" + page, updateTimeUtc: 1800000000000,
                chatName: "PRIVATE_TITLE", lastMessage: { text: "PRIVATE_REPLY" } }], syncState: "PRIVATE_CURSOR_" + (page + 1) } } });
        const pageBody = page => JSON.stringify(inventedNativeWire({ data: { action: "GetConversationPageHistoryList",
            enableLastMessage: true, syncState: "PRIVATE_CURSOR_" + page,
            state: { conversationPageHistoryList: { chats: [] } } } }));
        const sectionsBody = JSON.stringify(inventedNativeWire({ data: { action: "GetSections", state: {},
            enableLastMessage: true, enableCache: false, source: "NavPane" } }));
        const scripts = nativeApplicationBuilds[sections && scenario !== "sections-old-cohort" ? 3 : 0]
            .scriptAssets.map(src => `<script src="${src}"></script>`).join("");
        const base = '<link rel="icon" href="data:,">' + scripts
            + '<a href="/chat/all">All chats</a><a href="/cowork/">Cowork</a>';
        let selected = false;
        const launch = chromium.launchPersistentContext.bind(chromium);
        t.mock.method(chromium, "launchPersistentContext", async (directory, options) => {
            nativeLaunches++;
            if (!scenario.startsWith("runner")) assert.equal(directory, configuration.profileDirectory);
            else assert.notEqual(directory, configuration.profileDirectory);
            assert.equal(options.chromiumSandbox, true);
            browser = await launch(directory, { ...options, headless: !attended, offline: true });
            if (attended && !experience) {
                const protocol = await browser.newCDPSession(browser.pages()[0]);
                const { windowId } = await protocol.send("Browser.getWindowForTarget");
                await protocol.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
                await protocol.send("Browser.setWindowBounds", { windowId, bounds: { left: -30000, top: -30000, width: 800, height: 600 } });
                await protocol.detach();
            }
            if (attended) {
                const page = browser.pages()[0], bringToFront = page.bringToFront.bind(page);
                t.mock.method(page, "bringToFront", () => { windowActions.push("bringToFront"); return bringToFront(); });
            }
            browser.on("requestfailed", request => failures.push({ path: new URL(request.url()).pathname, reason: request.failure()?.errorText }));
            const expose = browser.exposeBinding.bind(browser);
            t.mock.method(browser, "exposeBinding", (name, callback) => expose(name, (source, value) => {
                messages.push(value);
                return callback(source, value);
            }));
            const session = browser.newCDPSession.bind(browser);
            t.mock.method(browser, "newCDPSession", async target => {
                const protocol = await session(target), send = protocol.send.bind(protocol);
                t.mock.method(protocol, "send", async (method, ...args) => {
                    if (["Network.getResponseBody", "Fetch.getResponseBody", "Network.getRequestPostData"].includes(method)) rawReads.push(method);
                    if (attended && method === "Browser.setWindowBounds") windowActions.push(method);
                    if (presentationCancel && method === "Browser.getWindowForTarget") {
                        const reply = await send(method, ...args);
                        presentationPending.resolve();
                        await releasePresentation.promise;
                        return reply;
                    }
                    return send(method, ...args);
                });
                return protocol;
            });
            const route = browser.route.bind(browser);
            t.mock.method(browser, "route", (pattern, handler) => route(pattern, original => handler({
                request: () => original.request(),
                abort: reason => original.abort(reason),
                continue: async () => {
                    const request = original.request(), url = new URL(request.url());
                    if (unclassifiedAttention) assert.ok(events.some(event => event.type === "window-ready"),
                        "Owned-window availability is emitted before navigation, without waiting to recognize a prompt.");
                    calls.push({ path: url.pathname, method: request.method(), step: engineering.activeStep });
                    let body, contentType = "application/json";
                    if (request.method() === "OPTIONS") return original.fulfill({ status: 204, headers: {
                        "access-control-allow-origin": "*", "access-control-allow-headers": "x-user-id,x-tenant-id,content-type",
                    } });
                    if (request.resourceType() === "script") { body = ""; contentType = "application/javascript"; }
                    else if (request.isNavigationRequest()) {
                        contentType = "text/html";
                        if (unclassifiedAttention) {
                            body = '<link rel="icon" href="data:,"><title>Unclassified fixture interaction</title><p>Original fixture page</p>';
                        } else if (url.origin === "https://login.microsoftonline.com") {
                            selected = true;
                            body = classifiedAttention
                                ? '<link rel="icon" href="data:,"><input name="passwd" type="password"><p>Original fixture page</p>'
                                : `<link rel="icon" href="data:,"><h1>Pick an account</h1><button onclick="location.href='${app}/chat'">example@invalid.test</button>`;
                        } else if (!selected) body = `<link rel="icon" href="data:,"><button onclick="location.href='https://login.microsoftonline.com/common'">Sign in</button>`;
                        else if (url.pathname === "/chat") body = base + `<script>
                            fetch("/_serverFn/${nativeHistoryProducer.bootstrapRpcId}").then(r=>r.json());</script>`;
                        else if (url.pathname === "/chat/all") {
                            const initial = scenario === "document"
                                ? `(()=>{window.$_TSR=${JSON.stringify({ initialized: false, router: { dehydratedData: {
                                    copilotBootstrap: { loaderData: { all: list(0) } } } } })};
                                    window.$_TSR.initialized=true;return Promise.resolve(${JSON.stringify(list(0))});})()`
                                : scenario === "generic-entry"
                                    ? `fetch("/_serverFn/${nativeHistoryProducer.chatRpcId}",{method:"POST",body:${JSON.stringify(pageBody(1))}}).then(r=>r.json())`
                                    : scenario === "unprojected" ? `new Promise(resolve=>{const request=new XMLHttpRequest();
                                        request.open("GET",${JSON.stringify(initializer)});request.onload=()=>resolve(JSON.parse(request.responseText));request.send();})`
                                    : `fetch(${JSON.stringify(initializer)}).then(r=>r.json())`;
                            body = base + `<script>
                                let page=0;const append=r=>{const a=document.createElement("a");a.href="/chat/conversation/"+r.store.conversationPageHistoryList.chats[0].conversationId;
                                a.textContent="PRIVATE_VISIBLE_TITLE";a.style.cssText="display:block;margin-top:2000px";document.body.append(a);
                                if(page===0){const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();page++;
                                    fetch("/_serverFn/${nativeHistoryProducer.chatRpcId}",{method:"POST",body:${JSON.stringify(pageBody(1))}})
                                    .then(r=>r.json()).then(append);}});observer.observe(a);}
                                ${scenario === "extra-page" ? `else fetch("/_serverFn/${nativeHistoryProducer.chatRpcId}",{method:"POST",body:${JSON.stringify(pageBody(2))}});` : ""}
                                ${scenario === "detail" ? `fetch("/chat/conversation/PRIVATE_CHAT_0");` : ""}
                                ${scenario === "read-marker" ? `fetch("${gateway}/v1/conversations/PRIVATE_THREAD/read",{method:"PUT",body:"PRIVATE_READ_MARKER"}).catch(()=>{});` : ""}
                                ${scenario === "detail-navigation" ? 'location.href="/chat/conversation/PRIVATE_CHAT_0";' : ""}};
                                ${sections ? `fetch("/_serverFn/${nativeHistoryProducer.chatRpcId}",
                                    {method:"POST",body:${JSON.stringify(sectionsBody)}}).then(r=>r.json()).then(()=>(${initial})).then(append).catch(()=>{});`
                                    : `(${initial}).then(append).catch(()=>{});`}</script>`;
                        } else if (url.pathname === "/cowork/") body = base + historyEngineeringAssets.map(src => `<script src="${src}"></script>`).join("")
                            + `<script>const headers={"X-User-ID":${JSON.stringify(subject)},"X-Tenant-ID":${JSON.stringify(tenant)}};
                                fetch("${gateway}/v1/routing",{headers}).then(r=>r.json()).then(r=>
                                fetch(r.endpoint+"/v1/tasks/live?pageSize=25&includeCached=true&sessionType=interactive",{headers})).then(r=>r.json());</script>`;
                        else assert.fail("Unexpected engineering document");
                    } else if (url.pathname.endsWith(nativeHistoryProducer.bootstrapRpcId)) body = JSON.stringify(principal);
                    else if (url.pathname === initializer) body = JSON.stringify(scenario === "runner-shape" ? { unexpected: "PRIVATE_RESPONSE" } : list(0));
                    else if (url.pathname.endsWith(nativeHistoryProducer.chatRpcId)) {
                        body = request.postData() === sectionsBody ? JSON.stringify({ store: {
                            ...list(0).store, pinnedChats: [{ title: "PRIVATE_PIN_TITLE" }], pinnedChatIds: ["PRIVATE_PIN"],
                            featureFlags: { enableChatLandingPageHistoryStore: false },
                        } }) : JSON.stringify(list(1));
                    }
                    else if (url.pathname === "/v1/routing") body = JSON.stringify({ endpoint: gateway });
                    else if (url.pathname === "/v1/tasks/live") body = JSON.stringify({ tasks: [{
                        sessionId: "PRIVATE_TASK", lastActivity: 1800000000000, title: "PRIVATE_TASK_TITLE" }], nextCursor: null });
                    else assert.fail("Unpermitted engineering source route reached dispatch");
                    await original.fulfill({ status: 200, contentType, body, headers: {
                        "access-control-allow-origin": "*", "cache-control": "no-store",
                    } });
                    if (attended && request.isNavigationRequest()) attentionDocument.resolve();
                },
            })));
            if (scenario.startsWith("runner") && !experience) {
                // The real runner remains attended; only this offline fixture clicks its invented controls.
                const page = browser.pages()[0];
                const click = (async () => {
                    await page.getByRole("button", { name: "Sign in", exact: true }).click();
                    await page.getByRole("button", { name: "example@invalid.test", exact: true }).click();
                })();
                void click.catch(() => {});
            }
            return browser;
        });
        if (scenario.startsWith("runner")) {
            const outputFile = path.join(fixture.root, "engineering-result.json");
            const cancellation = new AbortController();
            t.after(() => cancellation.abort());
            const budgets = [], authenticationTimers = [];
            const nativeReady = Promise.withResolvers(), terminal = Promise.withResolvers();
            let preparationClock = 0;
            if (["runner-delayed-entry", "runner-preparation-close", "runner-connect-deadline"].includes(scenario) || experience) {
                const schedule = globalThis.setTimeout;
                t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
                    const timer = schedule(callback, milliseconds, ...args);
                    if (milliseconds >= 270000 && milliseconds <= 280000) {
                        budgets.push({ timer, due: preparationClock + milliseconds, milliseconds, callback: () => callback(...args) });
                    }
                    if (experience && milliseconds >= 60000 && milliseconds <= 90000) {
                        authenticationTimers.push({ timer, callback: () => callback(...args) });
                    }
                    return timer;
                });
                t.after(() => { for (const budget of [...budgets, ...authenticationTimers]) clearTimeout(budget.timer); });
            }
            const waitForHuman = async () => {
                preparationClock += 280001;
                for (const budget of budgets.filter(value => !value.fired && value.due <= preparationClock)) {
                    budget.fired = true;
                    clearTimeout(budget.timer);
                    budget.callback();
                }
                await nextTurn();
                assert.equal(events.some(event => ["failure", "window-ready", "step", "result"].includes(event.type)), false,
                    "Waiting on the normal local page must not consume a Microsoft deadline or end preparation.");
                assert.equal(browser, undefined, "Preparation and local WIRE Login cannot launch the native browser.");
                assert.deepEqual(calls, []);
            };
            let normalCommands, commandFailure, lateClose;
            let startupCancelled = false;
            if (scenario === "runner-startup-cancel") {
                const listen = Server.prototype.listen;
                t.mock.method(Server.prototype, "listen", function (...args) {
                    const value = Reflect.apply(listen, this, args);
                    assert.equal(args[0].port, 0);
                    assert.equal(cancellation.signal.aborted, false);
                    startupCancelled = true;
                    cancellation.abort();
                    return value;
                });
            }
            const run = () => runHistoryInvestigation({ expectedAccount: configuration.expectedAccount,
                authorizationReference: "offline-fixture-only", outputFile, signal: cancellation.signal,
                ...(normalRunner ? { normalEntry: true, expectedCommit: process.env.WIRE_HISTORY_TEST_COMMIT,
                    cancelPreparation: () => cancellation.abort() } : {}),
                emit: event => {
                    events.push(event);
                    if (event.type === "window-ready") nativeReady.resolve(event);
                    if (event.type === "result") terminal.resolve(event);
                    if (connectDeadline && event.type === "connect-started") {
                        assert.equal(budgets.length, 1);
                        clearTimeout(budgets[0].timer);
                        budgets[0].callback();
                    }
                    if (scenario === "runner-delayed-entry" && event.type === "connect-started") {
                        lateClose = requestHistoryPreparationClose(outputFile + ".custody");
                        void lateClose.catch(() => {});
                    }
                    if (event.type === "normal-entry-ready") normalCommands = (async () => {
                        assert.equal(calls.length, 0, "No Microsoft navigation before the normal Connect command.");
                        assert.equal(event.microsoft, "not-started");
                        assert.equal(event.userVisibility, "unconfirmed");
                        assert.equal(event.preparationClose, "owned-ipc");
                        assert.equal(event.settingsUrl, event.url + "#settings?section=connection&setting=microsoft-connection");
                        const origin = new URL(event.url).origin;
                        const custody = JSON.parse(await readFile(outputFile + ".custody", "utf8"));
                        const emptyCopilot = path.join(custody.root, "empty-copilot"), emptyGitHub = path.join(custody.root, "empty-github");
                        assert.equal(process.env.COPILOT_HOME, emptyCopilot);
                        assert.equal(process.env.GH_CONFIG_DIR, emptyGitHub);
                        assert.deepEqual(sourceDefaults(), { appDbPath: path.join(emptyCopilot, "data.db"),
                            sessionRoot: path.join(emptyCopilot, "session-state") });
                        assert.ok(Object.keys(process.env).every(name => !/^(?:GH|GITHUB|COPILOT)(?:_[A-Z0-9]+)*_TOKEN$/i.test(name)
                            && !/^WIRE_/i.test(name)));
                        assert.deepEqual(await readdir(emptyCopilot), []);
                        assert.deepEqual(await readdir(emptyGitHub), []);
                        wireBrowser = await chromium.launch({ channel: "msedge", headless: !experience, chromiumSandbox: true });
                        const local = await wireBrowser.newContext();
                        await local.route("**/*", route => new URL(route.request().url()).origin === origin
                            ? route.continue() : route.abort("blockedbyclient"));
                        const page = await local.newPage(), commands = [];
                        page.on("request", request => {
                            if (new URL(request.url()).pathname === "/api/access/command") commands.push(request.postDataJSON().action);
                        });
                        await page.goto(event.settingsUrl);
                        if (scenario === "runner-delayed-entry") {
                            await page.locator("#wireAccountTrigger").waitFor({ state: "visible" });
                            await waitForHuman();
                            assert.equal((await fetch(origin + "/health")).status, 200);
                            await page.reload();
                            assert.equal(budgets.length, 0);
                        }
                        await page.locator("#wireAccountTrigger").click();
                        const signedIn = page.waitForResponse(response => new URL(response.url()).pathname === "/api/access/command"
                            && response.request().postDataJSON().action === "wire-sign-in");
                        await page.locator("#wireAccountGate").click();
                        assert.equal((await (await signedIn).json()).outcome, "completed");
                        await assert.rejects(stat(path.join(custody.root, "data", "collector", "config.json")), { code: "ENOENT" });
                        assert.deepEqual((await loadBoardState({ dataDir: path.join(custody.root, "data") })).evidence ?? [], []);
                        assert.deepEqual(await readdir(emptyCopilot), []);
                        if (scenario === "runner-preparation-close") {
                            await page.locator("#wireMicrosoftAction:not([disabled])").waitFor({ state: "visible" });
                            await waitForHuman();
                            assert.equal(budgets.length, 0);
                            assert.equal(nativeLaunches, 0);
                            assert.deepEqual(commands, ["wire-sign-in"]);
                            assert.equal((await requestHistoryPreparationClose(outputFile + ".custody")).disposition, "accepted");
                            return;
                        }
                        if (scenario === "runner-delayed-entry") {
                            await waitForHuman();
                            await page.locator("#wireMicrosoftAction:not([disabled])").waitFor({ state: "visible" });
                        }
                        const connected = page.waitForResponse(response => new URL(response.url()).pathname === "/api/access/command"
                            && response.request().postDataJSON().action === "microsoft-connect");
                        const originalReceipt = experience ? Promise.race([
                            connected.then(async response => {
                                try { return { receipt: await response.json() }; }
                                catch (error) { return { error, networkFailure: response.request().failure()?.errorText }; }
                            }),
                            page.waitForEvent("requestfailed", { predicate: request =>
                                new URL(request.url()).origin === origin
                                && new URL(request.url()).pathname === "/api/access/command"
                                && request.postDataJSON()?.action === "microsoft-connect",
                            }).then(request => ({ networkFailure: request.failure()?.errorText })),
                        ]) : null;
                        if (originalReceipt) void originalReceipt.catch(() => {});
                        await page.locator("#wireMicrosoftAction").click();
                        if (experience) {
                            await nativeReady.promise;
                            const nativePage = browser.pages()[0];
                            await nativePage.getByRole("button", { name: "Sign in", exact: true }).waitFor();
                            const protocol = await browser.newCDPSession(nativePage);
                            const window = await protocol.send("Browser.getWindowForTarget");
                            assert.equal(window.bounds.windowState, "normal");
                            await protocol.detach();
                            const owners = await profileOwners(custody.profileDirectory);
                            assert.ok(owners.length > 0);
                            const visible = await promisify(execFile)("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
                                `$ErrorActionPreference='Stop'; @(${owners.join(",")}) | ForEach-Object { $p=Get-Process -Id $_; $p.Refresh(); [ordered]@{visibleMainWindow=($p.MainWindowHandle -ne 0)} } | ConvertTo-Json -Compress`],
                            { windowsHide: true, encoding: "utf8", timeout: 5000 });
                            assert.ok([JSON.parse(visible.stdout)].flat().some(value => value.visibleMainWindow),
                                "The fixture must have a real OS-visible owned window; this is not human-visibility proof for05.");
                            await page.waitForFunction(() => document.getElementById("wireMicrosoftStatus")?.textContent === "Waiting for Microsoft sign-in");
                            if (scenario === "runner-connect-presentation") {
                                assert.equal(await page.locator("#wireMicrosoftConnection .wire-connection-effect").textContent(),
                                    "Continue in the Microsoft sign-in window.",
                                    "The waiting page must direct the user to the separate sign-in interaction without a coordinator relay.");
                                if (experienceProof) {
                                    await mkdir(experienceProof, { recursive: true });
                                    await page.screenshot({ path: path.join(experienceProof, "connect-pending.png"), fullPage: true });
                                }
                                await page.locator("#themePreference").click();
                                assert.equal(await page.locator("#themePreference").getAttribute("aria-checked"), "true");
                                assert.equal(await page.locator("html").getAttribute("data-evidence-theme"), "dark");
                                await page.setViewportSize({ width: 390, height: 900 });
                                await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
                                await page.locator("#wireMicrosoftAction").scrollIntoViewIfNeeded();
                                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                                if (experienceProof) await page.screenshot({
                                    path: path.join(experienceProof, "connect-pending-dark-narrow.png"), fullPage: true,
                                });
                            }
                            await nativePage.getByRole("button", { name: "Sign in", exact: true }).click();
                            await nativePage.getByRole("button", { name: "example@invalid.test", exact: true }).waitFor();
                            assert.equal(authenticationTimers.length, 1);
                            clearTimeout(authenticationTimers[0].timer);
                            authenticationTimers[0].callback();
                            await terminal.promise;
                            const delivery = await originalReceipt;
                            if (delivery.receipt) assert.equal(delivery.receipt.reason, "timed-out",
                                "An observed original receipt must preserve the authentication failure.");
                            else assert.ok(delivery.networkFailure, "Unavailable receipt proof requires an actual failed browser request.");
                            await page.waitForTimeout(5500);
                            const visiblePage = await page.locator("body").innerText();
                            assert.doesNotMatch(visiblePage, /Waiting for Microsoft sign-in|Signing in\.\.\./,
                                "A stopped original run must not leave the visible page presenting an ongoing sign-in.");
                            assert.match(visiblePage, /sign-in result.*unconfirmed|Microsoft sign-in timed out|local WIRE.*unavailable/i,
                                "The stopped page needs a truthful visible terminal or unavailable result, not a generic access wait.");
                            if (!delivery.receipt) assert.match(visiblePage, /Microsoft sign-in result is unconfirmed/,
                                "Lost delivery must not invent the timeout known only to the runner.");
                            assert.deepEqual(commands, ["wire-sign-in", "microsoft-connect"]);
                            assert.equal(windowActions.filter(value => value === "bringToFront").length, 1,
                                "Guidance and terminal delivery must not reactivate the native window.");
                            assert.equal(await page.locator("#microsoftConnectionHost").isVisible(), false);
                            if (experienceProof) {
                                await mkdir(experienceProof, { recursive: true });
                                await page.screenshot({ path: path.join(experienceProof,
                                    scenario === "runner-connect-presentation" ? "connect-terminal-dark-narrow.png" : "connect-terminal.png"), fullPage: true });
                            }
                            return;
                        }
                        assert.equal((await (await connected).json()).outcome, connectDeadline ? "cancelled" : "completed");
                        assert.deepEqual(commands, ["wire-sign-in", "microsoft-connect"]);
                        if (scenario === "runner-delayed-entry") {
                            assert.equal(budgets.length, 1, "The original source budget starts exactly once at deliberate Connect.");
                            assert.ok(budgets[0].milliseconds > 270000 && budgets[0].milliseconds <= 280000);
                        }
                    })().catch(error => { commandFailure = error; cancellation.abort(); });
                } });
            const result = await run();
            await normalCommands;
            if (commandFailure) throw commandFailure;
            if (lateClose) {
                const refused = await lateClose;
                assert.equal(refused.disposition, "refused");
                assert.equal(refused.reason, "connect-started", "A late preparation close must not interrupt authentication.");
            }
            assert.ok(events.every(event => event.operationId === result.operationId),
                "Forwarded progress, attention and terminal output must identify the original runner operation.");
            if (normalRunner && !preparationOnly && !connectDeadline) {
                const attention = events.find(event => event.type === "window-ready");
                assert.equal(attention?.userVisibility, "unconfirmed");
                assert.equal(attention.interaction, undefined);
                assert.ok(Date.parse(attention.deadline) - Date.parse(attention.issuedAt) <= 90000);
                if (!experience) assert.ok(events.some(event => event.type === "attention-ended" && event.ownerId === attention.ownerId
                    && event.generation === attention.generation));
            }
            assert.equal(result.source.outcome, preparationOnly ? "not-started"
                : scenario === "runner-shape" || connectDeadline || experience ? "stopped" : "observed", JSON.stringify(result));
            if (experience) assert.equal(result.source.firstFailure.code, "timed-out");
            if (connectDeadline) {
                assert.equal(result.source.firstFailure.code, "NATIVE_ENGINEERING_DEADLINE");
                assert.equal(result.source.firstFailure.step, "authentication");
                assert.deepEqual(calls, []);
            }
            if (scenario === "runner-shape") assert.equal(result.source.firstFailure.code, "NATIVE_ENGINEERING_SOURCE_SHAPE", JSON.stringify(result));
            if (preparationOnly) {
                if (scenario === "runner-startup-cancel") {
                    assert.equal(startupCancelled, true);
                    assert.equal(events.some(event => event.type === "normal-entry-ready"), false);
                }
                assert.equal(result.source.firstFailure.code, "NATIVE_ENGINEERING_CANCELLED");
                assert.equal(result.source.firstFailure.step, "preparation");
                assert.equal(result.source.operationStarted, false);
                assert.equal(result.source.operation, null);
                assert.equal(events.some(event => ["connect-started", "window-ready", "human-needed", "step"].includes(event.type)), false);
                assert.equal(calls.length, 0);
                assert.equal(nativeLaunches, 0);
            } else {
                assert.equal(result.source.operationStarted, true);
                const start = events.filter(event => event.type === "connect-started");
                assert.equal(start.length, 1);
                assert.deepEqual(result.source.operation, Object.fromEntries(Object.entries(start[0])
                    .filter(([key]) => !["type", "operationId"].includes(key))));
                assert.equal(Date.parse(start[0].authenticationDeadline) - Date.parse(start[0].startedAt), 90000);
                assert.equal(Date.parse(start[0].readDeadline) - Date.parse(start[0].startedAt), 300000);
                assert.equal(Date.parse(start[0].shutdownAt) - Date.parse(start[0].startedAt), 280000);
            }
            if (scenario === "runner-normal-entry") {
                assert.equal(result.candidate, process.env.WIRE_HISTORY_TEST_COMMIT);
                assert.equal(result.source.contexts.length, 2);
                const outward = events.find(event => event.type === "result");
                assert.equal(outward.custodyRoot, undefined);
                assert.ok(outward.source.steps.every(step => step.members === undefined && step.times === undefined));
                assert.ok(outward.source.contexts.every(row => row.structure.histories.every(history => history.cursor.key === undefined)));
            }
            assert.equal(result.cleanup.disposition, "removed", JSON.stringify(result.cleanup));
            assert.equal(result.cleanup.closeFailure, null);
            assert.equal(result.cleanup.releaseFailure, null);
            await assert.rejects(stat(result.custodyRoot), { code: "ENOENT" });
            const count = calls.length;
            assert.deepEqual(JSON.parse(await readFile(outputFile, "utf8")), result);
            assert.equal(JSON.parse(await readFile(outputFile + ".started", "utf8")).stage, "preparation");
            await assert.rejects(run(), { code: preparationOnly ? "NATIVE_ENGINEERING_CANCELLED" : "NATIVE_ENGINEERING_ALREADY_ATTEMPTED" });
            await assert.rejects(runHistoryInvestigation({ expectedAccount: configuration.expectedAccount,
                authorizationReference: "offline-fixture-only", outputFile, signal: new AbortController().signal,
                ...(normalRunner ? { normalEntry: true, expectedCommit: process.env.WIRE_HISTORY_TEST_COMMIT } : {}) }),
            { code: "NATIVE_ENGINEERING_ALREADY_ATTEMPTED" });
            assert.equal(calls.length, count);
            assert.doesNotMatch(JSON.stringify({ result, events, messages }), /PRIVATE_|chatName|lastMessage|encodedBody|userPrincipalName/);
            assert.deepEqual(rawReads, []);
            return;
        }
        host = await fixture.start(configuration, fixture.context, true, false, false, null, false, attended, false, engineering);
        const owner = "engineering-fixture-" + randomUUID();
        if (attended) {
            await host.access.command(owner, { schemaVersion: 1, action: "wire-sign-in",
                operationId: randomUUID(), generation: (await host.access.status()).generation }, () => true);
            const connectInput = { schemaVersion: 1, action: "microsoft-connect",
                operationId: randomUUID(), generation: (await host.access.status()).generation };
            const connect = host.access.command(owner, connectInput, () => true);
            if (presentationCancel) {
                try {
                    await presentationPending.promise;
                    const generation = (await host.access.status()).generation;
                    const cancel = host.access.command(owner, { schemaVersion: 1, action: "microsoft-cancel",
                        operationId: randomUUID(), generation }, () => true);
                    const limit = Date.now() + 2000;
                    while ((await host.access.status()).generation === generation && Date.now() < limit) await nextTurn();
                    assert.ok((await host.access.status()).generation > generation);
                    releasePresentation.resolve();
                    assert.equal((await cancel).outcome, "completed");
                    const original = await connect;
                    assert.equal(original.outcome, "cancelled");
                    const stopped = engineering.summary();
                    assert.deepEqual(await host.access.receipt(owner, { schemaVersion: 1, operationId: connectInput.operationId }), original);
                    assert.deepEqual(await host.access.command(owner, connectInput, () => true), original);
                    await assert.rejects(host.access.command(owner, { ...connectInput, operationId: randomUUID() }, () => true),
                        { code: "wire_access_stale_generation" });
                    const repeated = await host.access.command(owner, { ...connectInput, operationId: randomUUID(),
                        generation: (await host.access.status()).generation }, () => true);
                    assert.equal(repeated.outcome, "failed");
                    assert.equal(nativeLaunches, 1, "A fresh or repeated command cannot launch a second engineering operation.");
                    assert.deepEqual(engineering.summary(), stopped);
                    assert.deepEqual(windowActions, []);
                    assert.deepEqual(calls, []);
                    assert.equal(events.some(event => ["window-ready", "human-needed"].includes(event.type)), false);
                } finally { releasePresentation.resolve(); }
                return;
            }
            try {
                await attentionDocument.promise;
                const page = browser.pages()[0];
                if (classifiedAttention) {
                    await page.getByRole("button", { name: "Sign in", exact: true }).click();
                    const notice = await attentionNotice.promise;
                    assert.equal(notice.interaction, "password");
                    assert.ok(Date.parse(notice.deadline) > Date.now());
                    assert.equal(events.filter(event => event.type === "window-ready").length, 1);
                    assert.equal(initialWindowActions.filter(action => action === "bringToFront").length, 1);
                    assert.deepEqual(windowActions, initialWindowActions,
                        "A classified authentication cue must not reactivate or move the already-presented owned browser.");
                    await page.locator('input[name="passwd"]').evaluate(input => {
                        input.type = "text";
                        input.name = "otc";
                        input.autocomplete = "one-time-code";
                    });
                    const next = await mfaNotice.promise;
                    assert.equal(next.interaction, "mfa");
                    assert.equal(next.ownerId, notice.ownerId);
                    assert.equal(next.generation, notice.generation);
                    assert.equal(next.deadline, notice.deadline);
                    assert.ok(Date.parse(next.issuedAt) >= Date.parse(notice.issuedAt));
                    assert.deepEqual(windowActions, initialWindowActions,
                        "Changing an invented web challenge must publish its cue without a window command; this is not Windows Hello proof.");
                    assert.equal(events.filter(event => event.type === "window-ready").length, 1);
                }
                await page.getByText("Original fixture page", { exact: true }).waitFor();
                const protocol = await browser.newCDPSession(page);
                try {
                    const { bounds } = await protocol.send("Browser.getWindowForTarget");
                    assert.equal(bounds.windowState, "normal",
                        "A deliberate Connect must not hide an unclassified Microsoft interaction until a DOM classifier succeeds.");
                    const area = await page.evaluate(() => ({ left: screen.availLeft, top: screen.availTop,
                        width: screen.availWidth, height: screen.availHeight }));
                    assert.ok(bounds.left >= area.left && bounds.top >= area.top
                        && bounds.left + bounds.width <= area.left + area.width
                        && bounds.top + bounds.height <= area.top + area.height,
                    "The owned sign-in window must fit in the available work area, not keep a stale off-screen position.");
                    const attention = events.find(event => event.type === "window-ready");
                    assert.equal(attention?.userVisibility, "unconfirmed");
                    assert.equal(attention.interaction, undefined);
                    assert.ok(Date.parse(attention.deadline) > Date.now());
                    assert.ok(Date.parse(attention.deadline) - Date.parse(attention.issuedAt) <= 90000);
                    assert.equal(events.some(event => event.type === "human-needed"), classifiedAttention);
                } finally { await protocol.detach(); }
            } finally {
                await host.access.command(owner, { schemaVersion: 1, action: "microsoft-cancel",
                    operationId: randomUUID(), generation: (await host.access.status()).generation }, () => true);
                assert.equal((await connect).outcome, "cancelled");
            }
            assert.deepEqual(rawReads, []);
            assert.equal(engineering.summary().requests, 0);
            assert.equal(engineering.summary().bytes, 0);
            return;
        }
        let receipt;
        for (const action of ["wire-sign-in", "microsoft-connect"]) receipt = await host.access.command(owner,
            { schemaVersion: 1, action, operationId: randomUUID(), generation: (await host.access.status()).generation }, () => true);
        const result = engineering.summary();
        if (["initializer", "sections"].includes(scenario)) {
            assert.equal(receipt.outcome, "completed", JSON.stringify({ result, logs, calls, failures }));
            assert.equal(result.outcome, "observed");
            assert.deepEqual(result.steps.map(row => row.step), ["chat:initial", "chat:page", "chat:refresh", "cowork:initial", "cowork:page", "cowork:refresh"]);
            assert.equal(result.steps[0].source, "chat-initializer");
            assert.equal(result.steps[4].outcome, "unavailable");
            assert.equal(calls.filter(row => row.path.endsWith(nativeHistoryProducer.chatRpcId)).length, sections ? 3 : 1);
            assert.equal(result.contexts.length, sections ? 2 : 0);
            assert.equal(calls.filter(row => row.path === "/v1/tasks/live").length, 2);
        } else {
            assert.equal(receipt.outcome, "failed");
            const expected = ({ "wrong-identity": ["NATIVE_ENGINEERING_WRONG_IDENTITY"],
                "sections-old-cohort": ["NATIVE_SOURCE_BUILD_UNQUALIFIED"],
                document: ["NATIVE_ENGINEERING_STEP_UNAVAILABLE"],
                "generic-entry": ["NATIVE_ENGINEERING_INITIALIZER_REQUIRED"],
                "extra-page": ["NATIVE_ENGINEERING_STEP_SCOPE", "NATIVE_ENGINEERING_INITIALIZER_REQUIRED"],
                "detail-navigation": ["NATIVE_ENGINEERING_CONTENT_READ_FORBIDDEN"],
                "read-marker": ["NATIVE_SOURCE_REQUEST_UNQUALIFIED"],
                unprojected: ["NATIVE_ENGINEERING_PROJECTION_REQUIRED"],
                detail: ["NATIVE_ENGINEERING_CONTENT_READ_FORBIDDEN"] })[scenario];
            assert.ok(expected.includes(result.firstFailure?.code), JSON.stringify({ result, logs }));
            if (scenario === "read-marker") assert.equal(result.firstFailure.admission.predicate, "business-data");
            if (scenario === "extra-page") assert.equal(calls.filter(row => row.path.endsWith(nativeHistoryProducer.chatRpcId)).length, 1);
        }
        assert.equal(result.positiveCoverage, false);
        assert.deepEqual(rawReads, []);
        assert.equal(calls.some(row => row.path.startsWith("/chat/conversation/") || /\/(?:detail|messages)$/.test(row.path)), false);
        assert.equal(calls.some(row => row.path.endsWith("/read") || row.method === "PUT"), false);
        assert.doesNotMatch(JSON.stringify({ result, logs, events, messages }), /PRIVATE_|chatName|lastMessage|encodedBody|userPrincipalName/);
        assert.equal((await host.access.nativeCollectionControl()).enabled, false);
        const saved = await loadBoardState(fixture.context);
        assert.deepEqual(saved.nativeRetention?.receipts ?? [], []);
        assert.deepEqual(saved.nativeRetention?.backfill ?? [], []);
        await host.close();
        assert.deepEqual(await profileOwners(configuration.profileDirectory), []);
        await assert.rejects(stat(configuration.ownerLockPath), { code: "ENOENT" });
    });
}

test("normal Microsoft configuration needs owned profile custody, not selected histories or a configured principal", async t => {
    const fixture = await configurationFixture(t);
    const value = { schemaVersion: 2, expectedAccount: "example@invalid.test",
        profileDirectory: fixture.config.profileDirectory, profileOwnerSessionId: fixture.config.profileOwnerSessionId,
        ownerLockPath: fixture.config.ownerLockPath };
    await writeFile(fixture.file, JSON.stringify(value));
    const configuration = await readMicrosoftNativeConfiguration(fixture.file);
    assert.equal(isMicrosoftNativeConfiguration(configuration), true);
    assert.equal(configuration.mode, "native-ui-history");
    assert.equal(configuration.expectedAccount, value.expectedAccount);
    assert.equal(Object.hasOwn(configuration, "target"), false);
    await writeFile(fixture.file, JSON.stringify({ ...value, deviceRiskOrigin: "https://device-helper.microsoft.com" }));
    assert.equal((await readMicrosoftNativeConfiguration(fixture.file)).deviceRiskOrigin, "https://device-helper.microsoft.com");
    for (const deviceRiskOrigin of ["https://device-helper.microsoft.com/", "http://device-helper.microsoft.com",
        "https://device-helper.microsoft.com/opaque", "https://device-helper.microsoft.com?private=value",
        "https://foreign.invalid", "https://device-helper.microsoft.com:8443", null]) {
        await writeFile(fixture.file, JSON.stringify({ ...value, deviceRiskOrigin }));
        await assert.rejects(readMicrosoftNativeConfiguration(fixture.file), { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
    }
    for (const extra of [{ expectedSubject: randomUUID() }, { chatPath: "/chat/conversation/example" },
        { principal: { verified: true } }, { producer: "caller-chosen" }]) {
        await writeFile(fixture.file, JSON.stringify({ ...value, ...extra }));
        await assert.rejects(readMicrosoftNativeConfiguration(fixture.file), { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
    }
});

for (const scenario of ["success", "chat-ssr-membership", "chat-ssr-mixed", "chat-ssr-unqualified-pins", "chat-ssr-marker-unknown",
    "chat-ssr-pin-newer", "chat-ssr-continuation", "chat-ssr-wrong-cursor",
    "chat-ssr-reset", "chat-ssr-reset-first",
    "bootstrap-ancillary", "bootstrap-ancillary-capacity", "bootstrap-ancillary-wrong-caller",
    "bootstrap-ancillary-recorded-caller", "bootstrap-ancillary-budget",
    "bootstrap-csp-report", "bootstrap-csp-app-sink", "bootstrap-csp-rpc-sink", "bootstrap-csp-stale-loader", "bootstrap-csp-stale-document",
    "bootstrap-csp-required-bootstrap", "bootstrap-csp-pause",
    "bootstrap-capacity-preflight", "bootstrap-capacity-preflight-late",
    "bootstrap-capacity-preflight-foreign-frame", "bootstrap-capacity-preflight-missing-link",
    "bootstrap-capacity-preflight-stale-original", "bootstrap-capacity-preflight-foreign-original",
    "bootstrap-capacity-preflight-url-mismatch", "bootstrap-capacity-preflight-explicit-loader",
    "bootstrap-capacity-preflight-duplicate-original",
    "bootstrap-capacity-preflight-unqualified", "bootstrap-capacity-preflight-write",
    "bootstrap-capacity-preflight-pause", "bootstrap-capacity-preflight-document",
    "bootstrap-capacity-scripts", "bootstrap-capacity-late", "bootstrap-capacity-pause", "bootstrap-capacity-logout",
    "bootstrap-capacity-document", "bootstrap-capacity-deadline", "bootstrap-capacity-unknown", "bootstrap-capacity-write",
    "bootstrap-excluded-action", "bootstrap-local-image", "bootstrap-local-image-stale-loader",
    "bootstrap-local-image-stale-document", "bootstrap-local-image-remote",
    "bootstrap-context-chat", "bootstrap-context-cowork", "snapshot-context", "cowork-outside-window", "deleted-running-prefix", "ordinary-enrollment", "multiple-histories", "paged-histories",
    "cowork-older-legacy", "cowork-older-virtualized", "cowork-older-missing-control", "cowork-older-unknown-script", "cowork-older-pause",
    "cowork-event-feed", "cowork-event-feed-unmatched", "cowork-event-feed-switch",
    "cowork-membership-union", "cowork-membership-interleaved", "cowork-membership-delayed", "cowork-membership-unavailable", "cowork-membership-stalled", "cowork-membership-carry",
    "cowork-membership-startup-cleanup", "cowork-membership-startup-cleanup-switch", "cowork-membership-background-after-cleanup",
    "cowork-membership-background", "cowork-membership-background-late", "cowork-membership-background-late-pause",
    "cowork-membership-background-account-switch", "cowork-membership-background-conflict",
    "cowork-membership-wrong-account", "cowork-membership-pause", "cowork-membership-marker",
    "cowork-task-rows", "cowork-run-rows", "cowork-run-rows-wrong-population", "cowork-task-rows-unmatched", "cowork-task-rows-selection",
    "cowork-scheduled-rediscovery", "cowork-scheduled-read503",
    "cowork-read503-once", "cowork-read503-repeat", "cowork-read503-retry-after", "cowork-read503-pause",
    "chat-context-read",
    "chat-context-filtered", "chat-context-wrong-cohort", "chat-context-limit",
    "cowork-matched-authors", "cowork-matched-time-unqualified", "cowork-mixed-cohort", "cowork-incomplete-cohort",
    "chat-initializer", "chat-initializer-landing", "chat-initializer-store-switch", "chat-initializer-empty-skip",
    "cowork-population-switch", "cowork-cached-continuation",
    "long-discovery", "long-discovery-hot", "long-discovery-deep", "long-discovery-lost", "mixed-new-changed", "completed-source-live", "time-yield", "byte-yield", "bounded-backfill", "backfill-live-update", "deleted-prefix", "changing-prefix", "changed-cold-history",
    "repeated-message-cursor", "empty-history", "incremental-history", "expiry", "wrong-action", "outside-window", "unqualified-time", "changed-producer", "pause", "native-retry",
    "foreign-thread", "foreign-session", "thread-in-session-slot", "session-in-thread-slot", "thread-alias", "both-selectors",
    "changed-cowork-producer"])
for (const coreVersion of ["passive-preload", "device-risk", "cached-session-with-device"].includes(scenario)
    ? ["tg1zCo1cm8VzH5kfPPn1ZQ2", "Z0tfIqn-YAh_QXsCBPIQ0w2"]
    : scenario === "auth-return-telemetry" ? ["0VaiIU2YQ2Ha0HQI5MKqTQ2", "tg1zCo1cm8VzH5kfPPn1ZQ2"] : ["Z0tfIqn-YAh_QXsCBPIQ0w2"])
for (const applicationCohort of [
    "existing",
    ...(["bootstrap-ancillary", "bootstrap-ancillary-capacity", "bootstrap-ancillary-wrong-caller", "bootstrap-ancillary-budget",
        "bootstrap-csp-report", "bootstrap-csp-app-sink", "bootstrap-csp-rpc-sink", "bootstrap-csp-stale-loader", "bootstrap-csp-stale-document",
        "bootstrap-csp-required-bootstrap", "bootstrap-csp-pause", "bootstrap-capacity-preflight",
        "bootstrap-context-chat", "bootstrap-context-cowork", "chat-ssr-mixed", "chat-ssr-continuation", "chat-initializer",
        "cowork-membership-background", "cowork-membership-background-account-switch", "cowork-membership-unavailable",
        "cowork-membership-marker", "cowork-scheduled-rediscovery", "cowork-older-virtualized"].includes(scenario) ? ["d6"] : []),
    ...(scenario === "bootstrap-ancillary" ? ["d6-direct", "d6-worker-retries", "d6-direct-retries",
        "d6-missing-react", "d6-missing-graphql", "d6-mixed-vendor", "existing-shared-startup"] : []),
])
test(`normal native UI originals preserve the whole source contract: ${scenario} (${coreVersion}${applicationCohort === "existing" ? "" : ", " + applicationCohort})`, {
    timeout: scenario.startsWith("bootstrap-capacity-") ? 20000
        : scenario.startsWith("long-discovery") ? 180000 : scenario.startsWith("auth-reentry-callback-host-flow") ? 45000 : 90000,
}, async t => {
    const d6 = applicationCohort.startsWith("d6");
    const d6Direct = applicationCohort.startsWith("d6-direct");
    const loggerRetries = applicationCohort.endsWith("-retries");
    const d6Unqualified = ["d6-missing-react", "d6-missing-graphql", "d6-mixed-vendor"].includes(applicationCohort);
    const bootstrapAncillary = scenario.startsWith("bootstrap-ancillary");
    const cspScenario = scenario.startsWith("bootstrap-csp-");
    const cspRefusal = cspScenario && !["bootstrap-csp-report", "bootstrap-csp-app-sink", "bootstrap-csp-rpc-sink"].includes(scenario);
    const cspReportUrl = scenario === "bootstrap-csp-rpc-sink"
        ? "https://m365.cloud.microsoft/_serverFn/" + nativeHistoryProducer.chatRpcId
        : scenario === "bootstrap-csp-app-sink" ? "https://m365.cloud.microsoft/events"
        : "https://example.invalid/fixture-csp-report";
    const unqualifiedAncillaryCaller = ["bootstrap-ancillary-wrong-caller", "bootstrap-ancillary-recorded-caller"].includes(scenario);
    const bootstrapCapacity = scenario.startsWith("bootstrap-capacity-") || scenario === "bootstrap-ancillary-capacity";
    const capacityPreflight = scenario.startsWith("bootstrap-capacity-preflight");
    const capacityPreflightFailure = capacityPreflight && !["bootstrap-capacity-preflight", "bootstrap-capacity-preflight-late"].includes(scenario);
    const preflightMetadata = { delayed: 0, delivered: 0, fetchBeforeMetadata: false };
    const capacityPreflightUrl = scenario === "bootstrap-capacity-preflight-unqualified"
        ? "https://example.invalid/fixture-unqualified" : "https://config.edge.skype.com/config/v1/CHILL/0.0.14";
    const automaticEnable = cspScenario || bootstrapCapacity || bootstrapAncillary || d6 && scenario === "cowork-membership-background";
    const lateBootstrapCapacity = scenario === "bootstrap-capacity-late";
    const bootstrapCapacityRefusal = bootstrapCapacity && !["bootstrap-capacity-preflight", "bootstrap-capacity-preflight-late",
        "bootstrap-capacity-scripts", "bootstrap-capacity-late", "bootstrap-ancillary-capacity"].includes(scenario);
    const localImageScenario = scenario.startsWith("bootstrap-local-image");
    const backgroundBootstrap = scenario.startsWith("cowork-membership-background");
    const startupCleanup = scenario.startsWith("cowork-membership-startup-cleanup") || scenario === "cowork-membership-background-after-cleanup";
    const lateBackground = scenario.startsWith("cowork-membership-background-late");
    const membershipSSR = scenario.startsWith("chat-ssr-") || backgroundBootstrap;
    const coworkMembership = scenario.startsWith("cowork-membership-");
    const membershipFailure = ["cowork-membership-wrong-account", "cowork-membership-pause", "cowork-membership-marker",
        "cowork-membership-background-account-switch", "cowork-membership-background-conflict", "cowork-membership-background-late-pause",
        "cowork-membership-startup-cleanup-switch"].includes(scenario);
    const membershipRequests = [];
    const membershipPaging = ["chat-ssr-continuation", "chat-ssr-wrong-cursor"].includes(scenario);
    const bootstrapContext = scenario.startsWith("bootstrap-context-");
    let bootstrapContextReads = 0;
    const contextRead = scenario.startsWith("chat-context-");

    const contextRejected = contextRead && scenario !== "chat-context-read";
    const transientRead = scenario.startsWith("cowork-read503-") || scenario === "cowork-scheduled-read503";
    let failedReadReplies = 0;
    const scheduledRediscovery = ["cowork-scheduled-rediscovery", "cowork-scheduled-read503"].includes(scenario);
    const olderPages = scenario.startsWith("cowork-older-");
    const olderMessagesAsset = "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/73427.cde954e9.js";
    // These fixtures supply a native-selected run feed; they do not prove discovery of the scheduled/event UI.
    const feedRows = scenario.startsWith("cowork-run-rows");
    const taskRows = scenario.startsWith("cowork-task-rows") || feedRows;
    const eventFeed = scenario.startsWith("cowork-event-feed") || scenario === "cowork-run-rows";
    const taskListAsset = "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/66584.d4bf7c45.js";
    const runFeedAsset = "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/scheduled-page.98886159.js";
    const matchedCowork = d6 || coworkMembership || taskRows || eventFeed || olderPages || scenario.startsWith("cowork-matched") || scenario.startsWith("cowork-mixed") || scenario.startsWith("cowork-incomplete");
    const cohortFailure = ["cowork-mixed-cohort", "cowork-incomplete-cohort"].includes(scenario);
    const snapshotContext = scenario === "snapshot-context";
    const chatInitializer = scenario.startsWith("chat-initializer");
    const selectedStore = ["chat-initializer-landing", "chat-ssr-mixed"].includes(scenario) ? "chatLandingPageHistoryList" : "conversationPageHistoryList";
    const queryFailure = ["cowork-population-switch", "cowork-cached-continuation"].includes(scenario);

    const bindingFailureCase = /^auth-reentry-callback-host-flow-history-bind-(missing|current)-ssr$/.exec(scenario)?.[1];
    const connectHistoryRefusal = Boolean(bindingFailureCase) || ["auth-reentry-callback-host-flow-history-refusal-ssr",
        "auth-reentry-callback-host-flow-history-denied-no-principal-ssr"].includes(scenario);
    let suppressedBindingMetadata = 0, invalidPageMock;

    const metadataCase = /^auth-reentry-callback-host-flow-capacity-metadata-(.+)-ssr$/.exec(scenario)?.[1];
    const lateCapacityMetadata = Boolean(metadataCase);
    const metadataRefusal = lateCapacityMetadata && metadataCase !== "late";
    const pressureAuthFlow = scenario === "auth-reentry-callback-host-flow-capacity-ssr" || lateCapacityMetadata;

    const associationFailure = ["foreign-thread", "foreign-session", "thread-in-session-slot", "session-in-thread-slot"].includes(scenario);

    const pauseScenario = scenario === "pause" || scenario === "cowork-membership-pause" || scenario === "cowork-membership-background-late-pause"
        || scenario === "cowork-read503-pause" || scenario === "cowork-older-pause";

    const presentationTypes = [];

    const healthBuild = d6 ? {
        scriptAssets: [
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/runtime.5b09355d.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.d6c807be.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.vendors.afde6380.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/graphql.vendors.6cde5440.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/react.vendors.66726b7f.js",
        ],
        healthPingCallsites: { loggerInit: { line: 2, column: 20094 }, mainLoad: { line: 2, column: 514812 } },
        appEventsCallsites: d6Direct
            ? { batch: { line: 2, column: 621408 }, retry: { line: 2, column: 621966 }, flush: { line: 2, column: 623359 } }
            : { batch: { line: 2, column: 635255 }, flush: { line: 2, column: 637322 } },
        workerPreflightCallsite: { line: 2, column: 848005 },
    } : nativeApplicationBuilds[bootstrapAncillary || membershipSSR || bootstrapContext || chatInitializer || matchedCowork || contextRead && scenario !== "chat-context-wrong-cohort" ? 3 : 0];
    const applicationAssets = applicationCohort === "d6-missing-react" ? healthBuild.scriptAssets.slice(0, -1)
        : applicationCohort === "d6-missing-graphql" ? healthBuild.scriptAssets.filter((_, index) => index !== 3)
        : applicationCohort === "d6-mixed-vendor"
            ? healthBuild.scriptAssets.map((asset, index) => index === 2 ? nativeApplicationBuilds[3].scriptAssets[2] : asset)
        : applicationCohort === "existing-shared-startup" ? [...healthBuild.scriptAssets,
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/graphql.vendors.6cde5440.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/react.vendors.66726b7f.js"]
        : healthBuild.scriptAssets;

    const authorizationUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");

    const reentryUrl = new URL(authorizationUrl);
    reentryUrl.searchParams.set("fixture-pass", "second");

    const attended = loggerRetries;
    const succeeds = automaticEnable || scenario === "bootstrap-local-image" || coworkMembership || membershipSSR
        || bootstrapContext || scenario === "bootstrap-excluded-action" || contextRead && !contextRejected
        || ["cowork-older-legacy", "cowork-older-virtualized", "cowork-event-feed", "cowork-task-rows", "cowork-run-rows",
            "cowork-read503-once", "cowork-matched-authors", "snapshot-context", "cowork-outside-window", "deleted-running-prefix",
            "chat-initializer", "chat-initializer-landing", "success", "ordinary-enrollment", "multiple-histories", "paged-histories",
            "long-discovery", "long-discovery-hot", "long-discovery-deep", "long-discovery-lost", "mixed-new-changed",
            "completed-source-live", "time-yield", "byte-yield", "bounded-backfill", "backfill-live-update", "deleted-prefix",
            "changing-prefix", "changed-cold-history", "empty-history", "outside-window", "incremental-history",
            "thread-alias", "both-selectors"].includes(scenario);
    let host, release;
    t.after(async () => {
        try {
            await host?.close();
        } finally { await release?.(); }
    });
    const fixture = await configurationFixture(t);
    release = await acquireCollectorLock(fixture.context.dataDir);
    await mkdir(fixture.config.profileDirectory, { recursive: true });
    await writeFile(path.join(path.dirname(fixture.config.profileDirectory), "profile-owner.json"),
        JSON.stringify({ sessionId: fixture.config.profileOwnerSessionId, profile: "profile" }));
    await writeFile(fixture.file, JSON.stringify({ schemaVersion: 2, expectedAccount: "example@invalid.test",
        profileDirectory: fixture.config.profileDirectory, profileOwnerSessionId: fixture.config.profileOwnerSessionId,
        ownerLockPath: fixture.config.ownerLockPath }));

    const browser = await chromium.launch({ channel: "msedge", headless: true, chromiumSandbox: true });
    const context = await browser.newContext({ offline: true });

    t.after(() => browser.close());

    if (!context.pages().length) await context.newPage();
    {
        const versionPage = await context.newPage();
        await versionPage.goto("edge://version");
        const commandLine = await versionPage.locator("#command_line").innerText();
        assert.equal(/--(?:no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox)(?:\s|$)/.test(commandLine), false);
        await versionPage.close();
    }
    const app = "https://m365.cloud.microsoft", gateway = "https://cowork.us-ia888.gateway.prod.island.powerapps.com";
    const tenant = "11111111-1111-4111-8111-111111111111", subject = "22222222-2222-4222-8222-222222222222";
    const chatId = "33333333-3333-4333-8333-333333333333", taskId = "44444444-4444-4444-8444-444444444444";
    const longDiscovery = scenario.startsWith("long-discovery"), lostDiscovery = scenario === "long-discovery-lost";
    const deepDiscovery = scenario === "long-discovery-deep";
    const hotDiscovery = scenario === "long-discovery-hot" || deepDiscovery;
    // Let ongoing live polling settle only after twelve rounds of hot-prefix competition.
    const activityRound = () => hotDiscovery && !deepDiscovery ? Math.min(collectionRound, 12) : collectionRound;
    const mixedFairness = scenario === "mixed-new-changed", completedLive = scenario === "completed-source-live";
    const historyReads = [];
    const budgetYield = ["time-yield", "byte-yield"].includes(scenario);
    const timeYield = scenario === "time-yield";
    let timeAdvance = 0;
    const pagedHistories = taskRows || eventFeed || scenario === "paged-histories" || chatInitializer || queryFailure || longDiscovery || timeYield, emptyHistory = scenario === "empty-history";
    const multipleHistories = membershipSSR || scenario === "multiple-histories" || pagedHistories;
    const chatIds = emptyHistory ? [] : [chatId, ...(multipleHistories ? ["55555555-5555-4555-8555-555555555555"] : []),
        ...(pagedHistories ? ["77777777-7777-4777-8777-777777777777"] : [])];
    if (membershipPaging) chatIds.push("77777777-7777-4777-8777-777777777777");
    const taskIds = emptyHistory ? [] : [taskId, ...(multipleHistories ? ["66666666-6666-4666-8666-666666666666"] : []),
        ...(pagedHistories ? ["88888888-8888-4888-8888-888888888888"] : [])];
    const deletedPrefix = ["deleted-prefix", "deleted-running-prefix"].includes(scenario);
    const liveBackfill = scenario === "backfill-live-update";
    let liveUpdateAt = null;
    const changedCold = scenario === "changed-cold-history";
    const boundedBackfill = ["bounded-backfill", "changing-prefix"].includes(scenario) || deletedPrefix || changedCold || liveBackfill;
    if (boundedBackfill) for (let index = 1; index < (changedCold ? 9 : 10); index++) {
        chatIds.push(`33333333-3333-4333-8333-${String(index).padStart(12, "0")}`);
        taskIds.push(`44444444-4444-4444-8444-${String(index).padStart(12, "0")}`);
    }
    if (longDiscovery) for (let index = 3; index < 17; index++) {
        chatIds.push(`33333333-3333-4333-8333-${String(index).padStart(12, "0")}`);
        taskIds.push(`44444444-4444-4444-8444-${String(index).padStart(12, "0")}`);
    }
    if (timeYield) for (let index = 3; index < 16; index++) {
        chatIds.push(`33333333-3333-4333-8333-${String(index).padStart(12, "0")}`);
        taskIds.push(`44444444-4444-4444-8444-${String(index).padStart(12, "0")}`);
    }
    if (deepDiscovery) for (let index = 17; index < 49; index++) {
        chatIds.push(`33333333-3333-4333-8333-${String(index).padStart(12, "0")}`);
        taskIds.push(`44444444-4444-4444-8444-${String(index).padStart(12, "0")}`);
    }
    if (mixedFairness || completedLive) for (let index = 1; index < 20; index++) {
        if (mixedFairness) chatIds.push(`33333333-3333-4333-8333-${String(index).padStart(12, "0")}`);
        taskIds.push(`44444444-4444-4444-8444-${String(index).padStart(12, "0")}`);
    }
    const threadId = "19:source-qualified-thread@thread.v2";
    const now = Date.now(), current = new Date(now - 3600000).toISOString(), older = new Date(now - 40 * 86400000).toISOString();
    const principal = { accountType: "AAD",
        tenantId: tenant, objectId: subject,
        environment: "prod" };
    const principalLabel = "example@invalid.test";
    const owner = "native-history-whole-path-owner", admission = { owner, check: () => true, dispatched() {} };
    if (deletedPrefix) {
        const transport = createMicrosoftNativeReadTransport({
            async open() {}, async verifyAccount() { return {
                tenantId: tenant, subjectId: subject, knownAccountMatched: true,
                evidence: { kind: "native-account-metadata", issuer: app, namespace: nativeHistoryProducer.accountNamespace,
                    realm: "prod", observedAt: new Date().toISOString() },
            }; }, async stop() { return { processExited: true, profileReleased: true }; },
        });
        const lifecycle = await createMicrosoftSession(fixture.context, { transport, sourceAware: true, globalCollection: null,
            collection: { paused: false, windowDays: 7 } });
        const persistence = await createNativePersistence(fixture.context, { lifecycle, transport, configurationIntents: true });
        const previous = [];
        for (const [surface, ids] of [["chat", chatIds], ["cowork", taskIds]]) for (const id of ids.slice(0, 8)) {
            const row = envelope(surface, surface === "chat"
                ? { messageId: "current-message", author: "user", messageType: "Chat", createdAt: current, text: "Current Chat activity" }
                : { id: "current-event", event: "u", data: { ts: now - 3600000, t: "Current Cowork activity" } },
            { message: recorded({ author: "user", representation: surface === "chat" ? "plain-text" : "follow-up",
                text: `Current ${surface === "chat" ? "Chat" : "Cowork"} activity` }) });
            row.scope.account = { tenantId: tenant, subjectId: subject, verification: "verified" };
            row.scope.conversationId = id;
            previous.push(...(surface === "chat" ? retainNativeChatSourceObservations(decodeNativeChatObservation({
                scope: row.scope, capture: row.capture, ordering: { ...row.ordering, frameOrdinal: 0 },
                source: { sourceDocument: row.capture.captureId, pointer: "/frames/0/messages/0", responsePointer: "/frames/0" },
                record: row.record,
            })) : adaptCoworkSourceRecordsWithMessageParts([{
                record: row.record, ordering: row.ordering,
                source: { sourceDocument: row.capture.captureId, pointer: "/events/0" },
            }], { scope: row.scope, capture: { ...row.capture, parserVersion: COWORK_PARTS_ADAPTER_VERSION } })));
        }
        const access = await createNativeRuntimeAccess(fixture.context, { lifecycle, nativePersistence: persistence,
            sourceAware: true, nativeConnection: true, acquireNative: async () => previous });
        try {
            for (const action of ["wire-sign-in", "microsoft-connect"]) await access.command(owner, {
                schemaVersion: 1, action, operationId: randomUUID(), generation: (await access.status()).generation,
            }, () => true);
            const offer = await access.nativeConfigurationOffer(admission);
            await access.configureNativeIntent({ schemaVersion: 2, intent: offer.intent, generation: offer.generation,
                authorizationRevision: offer.authorizationRevision, expectedRevision: offer.expectedRevision,
                globalRevision: offer.globalRevision, surfaces: ["chat", "cowork"], windowDays: 7 }, admission);
            await access.collectNativeNow({ operationId: randomUUID() }, admission);
            const deletion = createDeletionController(fixture.context);
            const local = await persistence.localActivityDeletionAdmission(admission);
            const preview = await deletion.preview(owner, { scope: "all" }, local);
            assert.equal(preview.counts.records, 16);
            await deletion.confirm(owner, { operationId: preview.operationId, confirmed: true }, local);
        } finally { access.close(); persistence.close(); await lifecycle.close(); }
    }

    const calls = [], wireRequests = [], preflightEvents = [], ancillaryCallerFrames = [], capacityPreflightEvents = [];
    if (bootstrapAncillary) t.after(() => {
        const captureLines = installNativeChatCapture.toString().split(/\r?\n/);
        const forwardingLine = captureLines.findIndex(line => line.includes("Reflect.apply(originalFetch, this, args)"));
        assert.ok(ancillaryCallerFrames.length > 0);
        for (const frames of ancillaryCallerFrames) {
            assert.deepEqual(frames[0], { line: forwardingLine + 1, column: captureLines[forwardingLine].indexOf("apply"),
                urlPresent: false, reviewedEntry: false }, "The emitted WIRE wrapper is URL-less, not a selectable reviewed caller.");
            assert.equal(frames[1].urlPresent, true);
            assert.equal(frames[1].reviewedEntry, true);
            assert.equal(frames[1].line, 2);
            assert.ok([scenario === "bootstrap-ancillary-recorded-caller" ? 635255
                : healthBuild.appEventsCallsites.batch.column + Number(scenario === "bootstrap-ancillary-wrong-caller"),
                healthBuild.appEventsCallsites.flush.column, healthBuild.appEventsCallsites.retry?.column].includes(frames[1].column));
        }
    });
    const settlements = [], visibleNotices = [];
    const automaticCollection = automaticEnable ? Promise.withResolvers() : null;
    let manualAction, handoffAction, launchOptions;
    if (automaticEnable || localImageScenario || contextRead || transientRead || scenario === "wrong-action" || scenario === "bootstrap-excluded-action") t.mock.method(console, "info", (label, value) => {
        if (label === "[workiq-native] original read settled") {
            const result = JSON.parse(value);
            settlements.push(result);
            if (automaticEnable && result.purpose === "content" && result.commitState !== "committed") {
                automaticCollection.resolve({ error: result.nativeSource.failure });
            }
        }
        if (label === "[workiq-native] visible sign-in") {
            const notice = JSON.parse(value);
            const { deadline, flow, ...state } = notice;
            if (notice.state === "host-ready") {
                assert.ok(Date.parse(deadline) > Date.now() && Date.parse(deadline) <= Date.now() + 90000);

                assert.equal(flow, "direct");
                if (attended && true) {
                    handoffAction = context.pages()[0].getByRole("button", { name: "Continue to Microsoft" }).count()
                        .then(count => assert.equal(count, 0, "Normal attended Connect has no WIRE interstitial."));
                    void handoffAction.catch(() => {});
                }
            }
            visibleNotices.push(state);

            if (attended && notice.state === "waiting-for-user" && notice.interaction === "mfa") {
                manualAction = context.pages()[0].getByRole("button", { name: "Finish fixture MFA" }).click();
                void manualAction.catch(() => {});
            }
        }
    });
    let selected = false, pauseFailure, workerPreflights = 0, collectionRound = 0;
    const cspEvents = [], cspViolations = [], cspRequestIds = {};
    let cspBootstrapForwarded = 0;
    if (cspScenario) {
        await context.exposeBinding("fixtureCspViolation", (_source, event) => { cspViolations.push(event); });
        context.on("request", request => {
            if (request.url() === cspReportUrl && request.method() === "POST" && request.resourceType() === "other") {
                t.mock.method(request, "postData", () => assert.fail("A browser CSP report cannot be decoded as a history action."));
            }
        });
    }
    const loggerEvents = [], loggerFirstSettled = Promise.withResolvers(), loggerReadRelease = Promise.withResolvers();
    if (loggerRetries) {
        const persistedGroups = new Set([0, 1, 2]);
        await context.exposeBinding("fixtureLoggerRecovery", source => {
            const ids = [...persistedGroups].sort();
            persistedGroups.clear();
            loggerEvents.push({ event: "recover", document: new URL(source.frame.url()).pathname, ids });
            return ids.map(id => ({ id, retry: 0 }));
        });
        await context.exposeBinding("fixtureLoggerEvent", (_source, event) => {
            loggerEvents.push(event);
            if (event.event === "persist") persistedGroups.add(event.id);
            if (loggerEvents.filter(row => row.event === "persist" && row.document === "/chat").length === 3) loggerFirstSettled.resolve();
            if (loggerEvents.filter(row => row.event === "persist" && row.document === "/cowork/").length === 3) loggerReadRelease.resolve();
        });
        t.after(() => { loggerFirstSettled.resolve(); loggerReadRelease.resolve(); });
    }

    const pressure = { pauses: new Map(), routes: new Map(), forwarded: new Map(), acknowledged: new Map(),
        finished: new Map(), aborted: new Set(), sequence: 0, full: Promise.withResolvers(),
        ready: Promise.withResolvers(), resumed: Promise.withResolvers() };
    if (bootstrapCapacity) await context.exposeBinding("fixtureCapacityFull", () => pressure.full.promise);
    const delayedCapacityMetadata = { networkId: null, delivered: false, fetchBeforeMetadata: false };
    let metadataCancel, metadataClock;
    const drainPressure = () => {
        pressure.draining = true;
        for (const held of pressure.routes.values()) held.resolve();
    };
    if (pressureAuthFlow || bootstrapCapacity) t.signal.addEventListener("abort", drainPressure, { once: true });
    const pressurePath = url => /^\/shared\/1\.0\/content\/(?:images|js)\/fixture-capacity-\d+\.(?:gif|js)$/.test(new URL(url).pathname);
    const pressureReady = () => {
        if (pressure.routes.size === (capacityPreflight ? 127 : 128)
            && pressure.forwarded.size === (capacityPreflight ? 127 : 128) && pressure.acknowledged.size === (capacityPreflight ? 127 : 128)) {
            pressure.full.resolve();
        }
        if (pressure.routes.size === 128 && pressure.pauses.size === 129 && pressure.forwarded.size === 128
            && pressure.acknowledged.size === 128) {
            const waiting = [...pressure.pauses.values()].filter(row => !pressure.forwarded.has(row.requestId));
            if (waiting.length === 1) pressure.ready.resolve(waiting[0]);
        }
    };
    let repeatedCursorRequests = 0;
    let sourceOpenedAt;

    let requestPause;
    const pauseSignal = new Promise(resolve => { requestPause = resolve; });
    const pauseResult = pauseScenario ? (async () => {
        await pauseSignal;
        try {
            const control = await host.access.nativeCollectionControl();
            await host.access.setNativeCollectionEnabled({ enabled: false, expectedNativeRevision: control.revision }, admission);
        } catch (error) { pauseFailure = error.code; throw error; }
    })() : Promise.resolve();
    if (scenario === "cowork-older-pause") await context.exposeBinding("fixtureStopOlder", async () => {
        requestPause();
        await pauseResult;
    });
    if (scenario === "cowork-membership-background-late-pause") await context.exposeBinding("fixturePauseBootstrap", async () => {
        requestPause();
        await pauseResult;
    });
    const listBody = JSON.stringify(inventedNativeWire({ data: { action: scenario === "wrong-action" || connectHistoryRefusal ? "DeleteConversation" : "GetConversationPageHistoryList",
        enableLastMessage: true, state: { conversationPageHistoryList: { chats: [{ chatName: "PRIVATE_CACHED_TITLE" }] } } } }));
    const contextBody = JSON.stringify(inventedNativeWire({ data: { action: "GetSections", state: {},
        enableLastMessage: true, enableCache: false, source: "NavPane",
        ...(scenario === "chat-context-filtered" ? { conversationHistoryFilter: { filterType: "Product", filterValue: "Cowork", filterEnabled: true } } : {}) } }));

    const listPages = [listBody, ...Array.from({ length: deepDiscovery ? 48 : longDiscovery ? 16 : timeYield ? 15 : 2 }, (_, index) => index + 1).map(page => JSON.stringify(inventedNativeWire({ data: {
        action: "GetConversationPageHistoryList", enableLastMessage: true, syncState: `fixture-page-${page}`,
        saveToStore: scenario === "chat-initializer-store-switch" ? "chatLandingPageHistoryList" : selectedStore,
        state: { [scenario === "chat-initializer-store-switch" ? "chatLandingPageHistoryList" : selectedStore]: { chats: [] } },
    } })))];
    const scripts = applicationAssets.map(src => `<script src="${scenario === "changed-producer"
        ? src.replace("runtime.7ec01a27", "runtime.changed") : src}"></script>`).join("");
    const icon = '<link rel="icon" href="data:,">';
    const historyLinks = '<a href="/chat/all">All chats</a><a href="/cowork/">Cowork</a>';
    const base = icon + scripts + historyLinks;
    const rpcOrigin = app;
    const principalScript = `fetch(${JSON.stringify(rpcOrigin + "/_serverFn/" + nativeHistoryProducer.bootstrapRpcId)}).then(r=>r.json())
        .then(value=>{window.$_TSR={initialized:false,router:{dehydratedData:{copilotBootstrap:{
            loaderData:{root:{store:{...value.result.store,identity:{userPrincipalName:${JSON.stringify(principalLabel)}}}}}}}}};
            window.$_TSR.initialized=true;
            ${startupCleanup ? 'window.fixtureHydrated=true;window.fixtureStreamEnded=true;delete window.$_TSR;' : ""}
        });`;
    const documents = pathname => {
        if (!selected) return icon + `<button onclick="location.href='https://login.microsoftonline.com/common'">Sign in</button>`;
        let script = pathname === "/chat" ? principalScript : "";
        const backgroundSource = loaderData => `window.__backgroundSSR=true;
            ${lateBackground ? "" : `window.__backgroundLoaderData=${JSON.stringify(loaderData)};`}
            Object.defineProperty(window,"$_TSR",{configurable:true,get(){throw Error("Inactive bootstrap must not be read");}});
            window.__m365TanstackClientBooted=true;
            ${lateBackground ? `addEventListener("DOMContentLoaded",()=>{
                ${scenario === "cowork-membership-background-late-pause" && collectionRound > 0 ? "void window.fixturePauseBootstrap();" : ""}
                setTimeout(()=>{window.__backgroundLoaderData=${JSON.stringify(loaderData)};},250);
            },{once:true});` : ""}`;
        if (backgroundBootstrap && (!startupCleanup || collectionRound > 0) && ["/chat", "/cowork/"].includes(pathname)) {
            const accountInfo = scenario === "cowork-membership-background-account-switch" && collectionRound > 0
                ? { ...principal, objectId: "different-source-subject" } : principal;
            script = backgroundSource({ root: { store: { accountInfo, identity: { userPrincipalName: principalLabel } } },
                ...(scenario === "cowork-membership-background-conflict" && collectionRound > 0
                    ? { other: { store: { accountInfo: { ...principal, objectId: "conflicting-active-subject" } } } } : {}) });
        }

        const contextFetchFor = body => `fetch(${JSON.stringify(rpcOrigin + "/_serverFn/" + nativeHistoryProducer.chatRpcId)},
            {method:"POST",headers:{"content-type":"application/json"},body:${JSON.stringify(body)}}).then(response=>response.json())`;
        const contextFetch = contextFetchFor(contextBody);
        if (bootstrapContext && collectionRound > 0 && pathname === "/chat") script += `${contextFetch}.catch(()=>{});`;
        if ((localImageScenario || bootstrapAncillary) && collectionRound > 0 && pathname === "/chat") {
            script += `const image=new Image();image.src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";document.body.append(image);`;
        }
        if (cspScenario && collectionRound > 0 && pathname === "/chat") {
            script += `addEventListener("securitypolicyviolation",event=>window.fixtureCspViolation({
                directive:event.effectiveDirective,disposition:event.disposition,
                styleBlocked:getComputedStyle(document.body).getPropertyValue("--fixture-csp")===""}));
                const style=document.createElement("style");style.textContent="body{--fixture-csp:applied}";document.head.append(style);`;
        }
        if ((scenario === "bootstrap-excluded-action" || bootstrapAncillary) && collectionRound > 0 && pathname === "/chat") {
            script += `fetch(${JSON.stringify(rpcOrigin + "/_serverFn/" + nativeHistoryProducer.chatRpcId)},
                {method:"POST",headers:{"content-type":"application/json"},
                body:${JSON.stringify(JSON.stringify(inventedNativeWire({ data: { action: "FixtureExcludedAction" } })))}})
                .catch(()=>{window.fixtureExcludedActionDenied=true;});`;
        }

        if (pathname === "/chat/all") script += `const load=()=>fetch(${JSON.stringify(rpcOrigin + "/_serverFn/" + nativeHistoryProducer.chatRpcId)},
            {method:"POST",headers:{"content-type":"application/json"},body:${JSON.stringify(listBody)}});
            const pending=${contextRead ? `(async()=>{for(let i=0;i<${scenario === "chat-context-limit" ? 9 : 1};i++)await ${contextFetch};return load()})()`
                : "load()"};if(${scenario === "native-retry"})load().catch(()=>{});pending
            .then(r=>r.status===401?load():r)
            .then(r=>r.json()).then(r=>{for(const row of r.result.store.conversationPageHistoryList.chats){
                const a=document.createElement("a");a.href="/chat/conversation/"+row.conversationId;a.textContent="Selected chat";document.body.append(a);}});`;

        if (pathname.startsWith("/chat/conversation/")) script += `fetch(location.href).then(r=>r.text());`;
        if (pagedHistories && pathname === "/chat/all") script = `
            const pages=${JSON.stringify(listPages)};let pageIndex=0;
            const load=()=>(${chatInitializer ? `pageIndex++===0
                ? fetch(${JSON.stringify(rpcOrigin + "/_serverFn/" + nativeHistoryProducer.chatInitializerRpcId)})
                : fetch(${JSON.stringify(rpcOrigin + "/_serverFn/" + nativeHistoryProducer.chatRpcId)},
                    {method:"POST",headers:{"content-type":"application/json"},body:pages[pageIndex-1]})`
                : `fetch(${JSON.stringify(rpcOrigin + "/_serverFn/" + nativeHistoryProducer.chatRpcId)},
                    {method:"POST",headers:{"content-type":"application/json"},body:pages[pageIndex++]})`})
                .then(r=>r.json()).then(r=>{let last;
                    for(const row of r.result.store[${JSON.stringify(selectedStore)}].chats){const a=document.createElement("a");
                        a.href="/chat/conversation/"+row.conversationId;a.textContent="Selected chat";
                        a.style.cssText="display:block;margin-top:2000px";document.body.append(a);last=a;}
                    if(pageIndex<pages.length){const observer=new IntersectionObserver(entries=>{
                        if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();load();}});
                        observer.observe(last);}});
            load();`;
        if (pathname === "/cowork/") script += `
            ${scheduledRediscovery ? `document.querySelector('a[href="/cowork/"]').onclick=event=>{
                event.preventDefault();history.replaceState(null,"","/cowork/");window.cachedHistoryReused=true;
            };` : ""}
            const identityHeaders=${JSON.stringify(matchedCowork ? { "X-User-ID": subject,
                ...({ "X-Tenant-ID": tenant }) } : {})};
            ${taskRows ? `const taskList=document.createElement("ul");taskList.setAttribute("role","list");
                taskList.setAttribute("aria-busy","false");document.body.append(taskList);let taskFooter;` : ""}
            fetch(${JSON.stringify(gateway + "/v1/routing")},{headers:identityHeaders}).then(r=>r.json()).then(r=>
              fetch(r.endpoint+"/v1/tasks/live?pageSize=25&includeCached=true${eventFeed ? "&sessionType=automation_run" : scenario === "history-observation-filtered" || queryFailure || coworkMembership ? "&sessionType=interactive" : ""}",{headers:identityHeaders})).then(r=>r.json()).then(r=>{
                const append=r=>{let last;for(const row of r.tasks){const a=document.createElement(${JSON.stringify(taskRows ? "li" : "a")});
                ${taskRows ? `a.dataset.rowId=${JSON.stringify(feedRows ? "feed-" : tenant + ":" + subject + ":")}+row.sessionId;
                    a.tabIndex=0;a.addEventListener("keydown",event=>{if(event.key==="Enter"&&event.target===a)
                        location.hash="#/task/"+${JSON.stringify(tenant + ":" + subject + ":")}+row.sessionId;});
                    ${scenario === "cowork-task-rows-selection" ? 'a.innerHTML="<span data-select-checkbox></span>";' : ""}
                    const action=document.createElement("button");action.textContent="Run now";
                    action.onclick=()=>{throw Error("Native row traversal must not run a task");};a.append(action);`
                    : `a.href="#/task/"+${JSON.stringify(tenant + ":" + subject + ":")}+row.sessionId;a.textContent="Selected task";`}
                if(${pagedHistories})a.style.cssText="display:block;margin-top:2000px";${taskRows ? "taskList" : "document.body"}.append(a);last=a;}
                ${taskRows ? `taskList.setAttribute("aria-busy","false");if(r.nextCursor){
                    taskFooter=document.createElement("div");taskFooter.style.cssText="position:relative;height:40px";
                    last=document.createElement("div");last.setAttribute("aria-hidden","true");
                    last.style.cssText="position:absolute;top:0;height:1px;width:1px";taskFooter.append(last);taskList.after(taskFooter);}` : ""}
                if(r.nextCursor){const observer=new IntersectionObserver(entries=>{
                    if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();
                    ${taskRows ? 'taskFooter.remove();taskList.setAttribute("aria-busy","true");' : ""}
                    fetch(${JSON.stringify(gateway + "/v1/tasks/live?pageSize=50"
                        + (eventFeed ? "&sessionType=" + (scenario === "cowork-event-feed-switch" ? "event_run" : "automation_run")
                            : scenario === "cowork-population-switch" ? "&sessionType=scheduled_run"
                            : scenario === "cowork-cached-continuation" ? "&sessionType=interactive&includeCached=true" : "")
                        + "&cursor=")}+encodeURIComponent(r.nextCursor),
                        {headers:identityHeaders}).then(r=>r.json()).then(append);}});observer.observe(last);}};
                append(r);});
            addEventListener("hashchange",()=>{if(!location.hash.startsWith("#/task/"))return;
                ${taskRows ? "taskList.hidden=true;taskFooter?.remove();" : ""}
                const id=decodeURIComponent(location.hash.slice("#/task/".length));
                fetch(${JSON.stringify(gateway + "/v1/tasks/live/detail?sessionId=")}+encodeURIComponent(id)).then(r=>r.json()).then(detail=>{
                    const scenario=${JSON.stringify(scenario)},query=new URLSearchParams();
                    if(scenario!=="thread-alias")query.set("sessionId",scenario==="foreign-session"?"foreign-session":
                        scenario==="thread-in-session-slot"?detail.snapshot.ic3ThreadId:id);
                    if(["foreign-thread","foreign-session","thread-in-session-slot","session-in-thread-slot","thread-alias","both-selectors"].includes(scenario))
                        query.set("threadId",scenario==="foreign-thread"?"foreign-thread":
                            scenario==="session-in-thread-slot"?id:detail.snapshot.ic3ThreadId);
                    query.set("pageSize","50");
                    ${olderPages ? `
                    const region=document.createElement("div");
                    region.setAttribute("data-chat-scroll-container","true");
                    region.setAttribute("data-timeline-body",${JSON.stringify(scenario === "cowork-older-virtualized" ? "virtualized" : "legacy")});
                    region.setAttribute("role","region");
                    region.style.cssText="height:180px;overflow:auto";
                    const loader=document.createElement("div");
                    ${scenario === "cowork-older-missing-control" ? "" : 'loader.setAttribute("data-older-messages-loader","");'}
                    const rows=document.createElement("div");rows.style.height="1200px";
                    region.append(loader,rows);document.body.append(region);
                    let loading=false,next=null,hiddenRows=${scenario === "cowork-older-virtualized" ? 50 : 0};
                    const load=()=>{loading=true;loader.innerHTML='<span role="status">Loading</span>';
                        return fetch(${JSON.stringify(gateway + "/v1/tasks/live/messages?")}+query).then(r=>r.json()).then(body=>{
                            next=body.nextCursor;rows.style.height=(rows.offsetHeight+400)+"px";
                            region.scrollTop=400;
                            setTimeout(()=>{loading=false;loader.replaceChildren();if(!next)loader.remove();
                                ${scenario === "cowork-older-pause" ? "void window.fixtureStopOlder();" : ""}
                            },100);
                            return body;
                        });};
                    region.addEventListener("scroll",()=>{if(region.scrollTop===0&&!loading&&next){
                        if(hiddenRows>0){hiddenRows-=25;region.scrollTop=400;return;}
                        query.set("cursor",next);void load();
                    }});
                    return load();
                    ` : `const load=()=>fetch(${JSON.stringify(gateway + "/v1/tasks/live/messages?")}+query).then(r=>r.json()).then(body=>{
                        if(body.nextCursor){query.set("cursor",body.nextCursor);return load();}return body;});
                    return load();`}
                });});`;
        if (matchedCowork && pathname === "/cowork/") script += `
            addEventListener("hashchange",async()=>{
                document.querySelectorAll("[data-automation-list],[data-section-label=runs]").forEach(node=>node.remove());
                if(location.hash==="#/scheduled/manage"){
                    const inventory=await(await fetch(${JSON.stringify(gateway + "/v1/automations?type=all")},
                        {headers:{...identityHeaders,${scenario === "cowork-membership-wrong-account" ? '"X-User-ID":"foreign-subject"' : ""}}})).json();
                    const list=document.createElement("div");list.dataset.automationList="";document.body.append(list);
                    for(const parent of inventory.automations){
                        const row=document.createElement("div");row.tabIndex=0;
                        row.dataset.automationRow=(parent.kind==="scheduled"?"schedule:":"trigger:")+parent.id;
                        row.textContent="Invented routine";
                        row.onkeydown=e=>{if(e.key==="Enter"&&e.target===row)location.hash=
                            "#/scheduled/manage/"+(parent.kind==="event"?"trigger/":"")+encodeURIComponent(parent.id);};
                        const mutate=document.createElement("button");mutate.dataset.routineControl="";mutate.textContent="Run now";
                        mutate.onclick=()=>{throw Error("Must not run or edit a routine");};row.append(mutate);list.append(row);
                    }
                }else if(location.hash.startsWith("#/scheduled/manage/")){
                    const event=location.hash.startsWith("#/scheduled/manage/trigger/");
                    const id=decodeURIComponent(location.hash.slice(event?"#/scheduled/manage/trigger/".length:"#/scheduled/manage/".length));
                    ${scenario === "cowork-membership-marker"
                        ? `await fetch(${JSON.stringify(gateway + "/v1/conversations/" + tenant + ":" + subject + ":" + taskId + "/read")},
                            {method:"PUT",headers:identityHeaders}).catch(()=>{});` : ""}
                    const detail=await fetch(${JSON.stringify(gateway)}+(event?"/v1/event-triggers/":"/v1/conversations/")+encodeURIComponent(id)
                        +(event?"":"/scheduled-prompt"),{headers:identityHeaders});
                    if(!detail.ok)return;
                    const section=document.createElement("section");section.dataset.sectionLabel="runs";document.body.append(section);
                    const list=document.createElement("ul");list.setAttribute("role","list");section.append(list);
                    const load=async cursor=>{
                        const reply=await(await fetch(${JSON.stringify(gateway + "/v1/tasks/live?pageSize=50&sessionType=")}
                            +(event?"automation_run":"scheduled_run")+(cursor?"&cursor="+encodeURIComponent(cursor):""),{headers:identityHeaders})).json();
                        for(const task of reply.tasks){const row=document.createElement("li");row.dataset.rowId="feed-"+task.sessionId;
                            row.textContent="Invented run";row.style.height="1200px";list.append(row);}
                        if(reply.nextCursor&&${scenario !== "cowork-membership-stalled"}){const footer=document.createElement("div"),sentinel=document.createElement("div");
                            sentinel.setAttribute("aria-hidden","true");sentinel.style.cssText="height:1px;width:1px";
                            footer.append(sentinel);list.after(footer);
                            const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){
                                observer.disconnect();footer.remove();void load(reply.nextCursor);}});observer.observe(sentinel);}
                    };
                    ${scenario === "cowork-membership-interleaved"
                        ? `void fetch(${JSON.stringify(gateway + "/v1/tasks/live?pageSize=50&sessionType=interactive")},{headers:identityHeaders}).then(r=>r.json());` : ""}
                    void load(null);
                }
            });`;
        const pageBase = base;
        const presentation = (bootstrapAncillary && collectionRound > 0) && ["/home", "/chat"].includes(pathname)
            ? `<link rel="stylesheet" href="https://res.cdn.office.net/fixture-presentation.css">
                <style>@font-face{font-family:FixturePresentation;src:url("https://res.cdn.office.net/fixture-presentation.woff2")}
                body{font-family:FixturePresentation, sans-serif}</style>
                <img src="https://res.cdn.office.net/fixture-presentation.png" alt="Fixture presentation">` : "";
        const successfulPresentation = "";
        const prefetch = "";
        const observedView = "";
        const coworkAssets = matchedCowork ? [...nativeCoworkBuilds[1].scriptAssets.slice(0, scenario === "cowork-incomplete-cohort" ? 2 : 3),
            ...(scenario === "cowork-mixed-cohort" ? [nativeHistoryProducer.coworkScriptAsset] : []),
            ...(olderPages ? [scenario === "cowork-older-unknown-script"
                ? olderMessagesAsset.replace("73427.cde954e9", "73427.fixture-unknown") : olderMessagesAsset] : []),
            ...(matchedCowork ? [scenario === "cowork-event-feed-unmatched"
                ? runFeedAsset.replace("98886159", "fixture-unknown") : runFeedAsset] : []),
            ...(coworkMembership ? [nativeCoworkBuilds[1].automationDetailsScriptAsset] : []),
            ...(taskRows ? [scenario === "cowork-task-rows-unmatched"
                ? taskListAsset.replace("d4bf7c45", "fixture-unknown") : taskListAsset] : [])]
            : [scenario === "changed-cowork-producer"
                ? nativeHistoryProducer.coworkScriptAsset.replace("1979.657607ab", "1979.changed") : nativeHistoryProducer.coworkScriptAsset];
        if (!membershipSSR && pathname === "/chat/all" && (d6 || applicationAssets.includes(nativeApplicationBuilds[3].scriptAssets[1]))) {
            script = 'window.$_TSR={initialized:true,router:{dehydratedData:{copilotBootstrap:{loaderData:{}}}}};' + script;
        }
        if (membershipSSR && pathname === "/chat/all") {
            const row = conversationId => ({ conversationId, createTimeUtc: now - 40 * 86400000, updateTimeUtc: now - 3600000 });
            const pins = scenario === "chat-ssr-pin-newer" ? [...chatIds] : [chatIds[1]];
            const sourceStore = { accountInfo: principal, identity: { userPrincipalName: principalLabel },
                featureFlags: { enableChatLandingPageHistoryStore: selectedStore === "chatLandingPageHistoryList" },
                [selectedStore]: { chats: [{ ...row(chatIds[0]),
                    ...(scenario === "chat-ssr-pin-newer" ? { updateTimeUtc: now - 40 * 86400000 } : {}) }],
                syncState: membershipPaging ? "fixture-page-1" : "" },
                pinnedChats: pins.map(row),
                ...(scenario === "chat-ssr-unqualified-pins" ? {} : {
                    pinnedChatIds: Object.fromEntries(pins.map(id => [id, now - 7200000])) }),
                ...(scenario === "chat-ssr-mixed" ? { conversationPageHistoryList: { chats: [row(taskId)], syncState: "" },
                    unifiedSessions: [{ id: taskId, title: "PRIVATE_MIXED_HISTORY" }] } : {}) };
            const bootstrap = { initialized: false, router: { dehydratedData: { copilotBootstrap: { loaderData: {
                common: { store: { ...(scenario === "chat-ssr-marker-unknown" ? {} : {
                    conversationPageHistoryList: { chats: [], syncState: "" } }), accountInfo: principal } },
                all: { historySource: scenario === "chat-ssr-marker-unknown" ? "unknown-marker" : "all-chats", store: sourceStore },
            } } } } };
            script = `${backgroundBootstrap ? backgroundSource(bootstrap.router.dehydratedData.copilotBootstrap.loaderData)
                : `window.$_TSR=${JSON.stringify(bootstrap)};window.$_TSR.initialized=true;`}
                const add=id=>{const link=document.createElement("a");link.href="/chat/conversation/"+id;link.textContent="Native history";document.body.append(link);return link;};
                for(const id of ${JSON.stringify([...chatIds.slice(0, 2), ...(scenario === "chat-ssr-mixed" ? [taskId] : [])])})add(id);
                ${scenario.startsWith("chat-ssr-reset") ? `fetch("/_serverFn/${nativeHistoryProducer.chatRpcId}",{
                    method:"POST",headers:{"content-type":"application/json"},
                    body:${JSON.stringify(JSON.stringify(inventedNativeWire({ data: {
                        action: "GetConversationPageHistoryList", enableLastMessage: true,
                        state: { conversationPageHistoryList: { chats: [], syncState: "" } },
                    } })))}
                }).then(r=>r.json()).catch(()=>{});` : ""}
                ${membershipPaging ? `const tail=document.querySelector('a[href="/chat/conversation/${chatIds[0]}"]');
                tail.style.cssText="display:block;margin-top:2000px";
                const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){
                    observer.disconnect();fetch("/_serverFn/${nativeHistoryProducer.chatRpcId}",{method:"POST",headers:{"content-type":"application/json"},
                        body:${JSON.stringify(scenario === "chat-ssr-wrong-cursor" ? listPages[1].replace("fixture-page-1", "wrong-cursor") : listPages[1])}})
                    .then(r=>r.json()).then(r=>{for(const row of r.result.store[${JSON.stringify(selectedStore)}].chats){
                        if(!document.querySelector('a[href="/chat/conversation/'+row.conversationId+'"]'))add(row.conversationId);
                    }}).catch(()=>{});
                }});observer.observe(tail);` : ""}`;
            assert.doesNotThrow(() => new Function(script));
        }
        if (startupCleanup && collectionRound > 0) script = `
            if(Object.getOwnPropertyNames(window).some(name=>name.startsWith("__wireAccountStartup_")))
                throw Error("Login account observer survived into collection");
            ` + script;
        if (bootstrapCapacity && collectionRound > 0 && pathname === "/chat") script = `(async()=>{
            await new Promise(resolve=>addEventListener("load",resolve,{once:true}));
            await Promise.all(Array.from({length:${capacityPreflight ? 128 : 129}},async(_,index)=>{
                if(index===${capacityPreflight ? 127 : 128})await window.fixtureCapacityFull();
                ${capacityPreflight ? `if(index===127)return fetch(${JSON.stringify(capacityPreflightUrl)},{
                    ${scenario === "bootstrap-capacity-preflight-write" ? 'method:"POST",body:"PRIVATE_FORBIDDEN_WRITE",' : ""}
                    headers:{"X-User-ID":"fixture-preflight"}}).then(response=>response.json());` : ""}
                ${scenario === "bootstrap-capacity-write" ? `if(index===128)return fetch(
                    "https://res.cdn.office.net/shared/1.0/content/js/fixture-capacity-128.js",{method:"POST",body:"PRIVATE_WRITE"});` : ""}
                return new Promise((resolve,reject)=>{
                const resource=document.createElement("script");resource.onload=resolve;resource.onerror=reject;
                resource.src=${scenario === "bootstrap-capacity-unknown" ? '(index===128?"https://example.invalid":"https://res.cdn.office.net")'
                    : '"https://res.cdn.office.net"'}+"/shared/1.0/content/js/fixture-capacity-"+index+".js";
                document.body.append(resource);
            });}));
            ${script}
        })();`;
        return pageBase + presentation + successfulPresentation + prefetch
            + (pathname === "/cowork/" ? coworkAssets.map(src => `<script src="${src}"></script>`).join("") : "")
            + observedView + `<script>${script}</script>`
            + (connectHistoryRefusal && pathname === "/home" ? `<script>
                (async()=>{
                fetch("/_serverFn/${nativeHistoryProducer.chatRpcId}",{method:"POST",headers:{"Content-Type":"application/json"},
                    body:${JSON.stringify(listBody)}}).catch(()=>{});
                })();
                </script>` : "");
    };
    const originalRoute = context.route.bind(context);
    const originalSession = context.newCDPSession.bind(context);
    if (scenario === "chat-ssr-reset-first") {
        const expose = context.exposeBinding.bind(context);
        t.mock.method(context, "exposeBinding", (name, callback) => expose(name, async (source, value) => {
            if (value?.kind === "chat-history-document" && value.state === "complete") {
                await new Promise(resolve => setTimeout(resolve, 150));
            }
            return callback(source, value);
        }));
    }
    let rootProtocol, rootFrame;

    const localImageEvents = [];
    t.mock.method(context, "newCDPSession", async target => {
        const session = await originalSession(target);
        const targetKind = target === context.pages()[0] ? "root" : "helper";
        if (capacityPreflight) {
            const ids = new Set();
            session.on("Network.requestWillBeSent", event => {
                if (event.request.url !== capacityPreflightUrl) return;
                ids.add(event.requestId);
                if (event.request.method === "OPTIONS") {
                    if (scenario === "bootstrap-capacity-preflight-foreign-frame") event.frameId = "fixture-foreign-frame";
                    if (scenario === "bootstrap-capacity-preflight-missing-link") event.initiator.requestId = "fixture-unlinked-request";
                    if (scenario === "bootstrap-capacity-preflight-explicit-loader") event.loaderId = "fixture-conflicting-loader";
                } else {
                    if (scenario === "bootstrap-capacity-preflight-stale-original") event.loaderId = "fixture-old-loader";
                    if (scenario === "bootstrap-capacity-preflight-foreign-original") event.frameId = "fixture-foreign-frame";
                    if (scenario === "bootstrap-capacity-preflight-url-mismatch") event.request.url += "?fixture-mismatch=1";
                }
                capacityPreflightEvents.push({ event: "network", method: event.request.method, type: event.type,
                    framePresent: typeof event.frameId === "string", root: event.frameId === rootFrame,
                    loaderPresent: Boolean(event.loaderId), loaderEmpty: event.loaderId === "",
                    documentMatched: event.documentURL === context.pages()[0].url(), initiator: event.initiator?.type,
                    linkedRequestPresent: typeof event.initiator?.requestId === "string" });
            });
            if (["bootstrap-capacity-preflight-duplicate-original", "bootstrap-capacity-preflight-late"].includes(scenario)) {
                const on = session.on.bind(session);
                t.mock.method(session, "on", (event, listener) => on(event, event === "Network.requestWillBeSent"
                    ? record => {
                        if (scenario === "bootstrap-capacity-preflight-late"
                            && record.request.url === capacityPreflightUrl && record.request.method === "OPTIONS") {
                            preflightMetadata.delayed++;
                            const timer = setTimeout(() => { preflightMetadata.delivered++; listener(record); }, 75);
                            t.after(() => clearTimeout(timer));
                            return;
                        }
                        listener(record);
                        if (scenario === "bootstrap-capacity-preflight-duplicate-original"
                            && record.request.url === capacityPreflightUrl && record.request.method === "GET") listener(record);
                    } : listener));
            }
            session.on("Network.responseReceived", event => {
                if (ids.has(event.requestId)) capacityPreflightEvents.push({ event: "response", type: event.type, status: event.response.status });
            });
            session.on("Network.loadingFinished", event => {
                if (ids.has(event.requestId)) capacityPreflightEvents.push({ event: "finished" });
            });
            session.on("Network.loadingFailed", event => {
                if (ids.has(event.requestId)) capacityPreflightEvents.push({ event: "failed", type: event.type,
                    blockedReason: event.blockedReason ?? null, cors: event.corsErrorStatus?.corsError ?? null });
            });
            session.on("Fetch.requestPaused", event => {
                if (event.request.url !== capacityPreflightUrl || event.responseStatusCode !== undefined) return;
                capacityPreflightEvents.push({ event: "fetch", method: event.request.method, type: event.resourceType,
                    framePresent: typeof event.frameId === "string", root: event.frameId === rootFrame });
                if (event.request.method === "OPTIONS") {
                    preflightMetadata.fetchBeforeMetadata = preflightMetadata.delayed > preflightMetadata.delivered;
                    pressure.ready.resolve({ requestId: event.requestId, networkId: event.networkId, url: event.request.url });
                }
            });
        }
        if (cspScenario) {
            let reportId, reportFetchId, documentLoader;
            session.on("Network.responseReceived", event => {
                if (event.type === "Document") documentLoader = event.loaderId;
            });
            session.on("Network.requestWillBeSent", event => {
                if (event.request.url !== cspReportUrl || event.type !== "Other") return;
                reportId = event.requestId;
                cspRequestIds.network = event.requestId;
                if (scenario === "bootstrap-csp-stale-loader") event.loaderId = "fixture-old-loader";
                if (scenario === "bootstrap-csp-stale-document") event.documentURL = "https://m365.cloud.microsoft/fixture-old";
                cspEvents.push({ event: "network", type: event.type, method: event.request.method,
                    root: event.frameId === rootFrame, loaderMatched: event.loaderId === documentLoader,
                    documentMatched: event.documentURL === context.pages()[0].url(), initiator: event.initiator?.type });
                Object.defineProperty(event.request, "postData", { get() { assert.fail("No CSP report payload read."); } });
                Object.defineProperty(event.request, "headers", { get() { assert.fail("No CSP report header read."); } });
            });
            session.on("Fetch.requestPaused", event => {
                if (event.request.url !== cspReportUrl || event.resourceType !== "CSPViolationReport") return;
                reportFetchId = event.requestId;
                cspRequestIds.fetch = event.networkId;
                cspEvents.push({ event: "fetch", type: event.resourceType,
                    root: event.frameId === rootFrame });
                Object.defineProperty(event.request, "postData", { get() { assert.fail("No CSP report payload read."); } });
                Object.defineProperty(event.request, "headers", { get() { assert.fail("No CSP report header read."); } });
            });
            session.on("Network.loadingFailed", event => {
                if (event.requestId === reportId) {
                    cspRequestIds.terminal = event.requestId;
                    cspEvents.push({ event: "failed" });
                }
            });
            if (scenario === "bootstrap-csp-pause") {
                const send = session.send.bind(session);
                t.mock.method(session, "send", async (method, input) => {
                    const result = await send(method, input);
                    if (method === "Fetch.failRequest" && input.requestId === reportFetchId) {
                        await host.access.setNativeCollectionEnabled({ enabled: false,
                            expectedNativeRevision: (await host.access.nativeCollectionControl()).revision }, admission);
                    }
                    return result;
                });
            }
        }
        if (bootstrapAncillary) session.on("Network.requestWillBeSent", event => {
            if (event.request.method !== "POST" || URL.parse(event.request.url)?.pathname !== "/events") return;
            ancillaryCallerFrames.push((event.initiator?.stack?.callFrames ?? []).slice(0, 8).map(frame => ({
                line: frame.lineNumber, column: frame.columnNumber, urlPresent: Boolean(frame.url),
                reviewedEntry: frame.url === healthBuild.scriptAssets[1],
            })));
        });
        if (localImageScenario) {
            let localId, documentLoader, localFrame, localLoader;
            session.on("Network.responseReceived", event => {
                if (event.type === "Document") documentLoader = event.loaderId;
                if (event.requestId === localId) localImageEvents.push({ event: "response", type: event.type,
                    status: event.response.status, mime: event.response.mimeType,
                    frameMatched: event.frameId === localFrame, loaderMatched: event.loaderId === localLoader,
                    embedded: event.response.url.startsWith("data:image/gif;base64,"),
                    disk: event.response.fromDiskCache, prefetch: event.response.fromPrefetchCache,
                    worker: event.response.fromServiceWorker });
            });
            session.on("Network.requestWillBeSent", event => {
                if (!event.request.url.startsWith("data:image/")) return;
                localId = event.requestId;
                localFrame = event.frameId; localLoader = event.loaderId;
                if (scenario === "bootstrap-local-image-stale-loader") event.loaderId = "invented-old-loader";
                if (scenario === "bootstrap-local-image-stale-document") event.documentURL = "https://m365.cloud.microsoft/PRIVATE_OLD_DOCUMENT";
                if (scenario === "bootstrap-local-image-remote") event.request.url = "https://example.invalid/PRIVATE_IMAGE?secret=PRIVATE_VALUE";
                localImageEvents.push({ event: "request", type: event.type, method: event.request.method,
                    loaderMatched: event.loaderId === documentLoader,
                    initiator: event.initiator.type });
            });
            session.on("Fetch.requestPaused", event => {
                if (event.networkId === localId) localImageEvents.push({ event: "fetch" });
            });
            session.on("Network.requestServedFromCache", event => {
                if (event.requestId === localId) localImageEvents.push({ event: "cache" });
            });
            session.on("Network.loadingFinished", event => {
                if (event.requestId === localId) localImageEvents.push({ event: "finished" });
            });
        }

        if ((pressureAuthFlow || bootstrapCapacity) && targetKind === "root") {
            session.on("Fetch.requestPaused", event => {
                if (!pressurePath(event.request.url)) return;
                Object.defineProperty(event.request, "postData", { get() { assert.fail("Pressure must not read a body."); } });
                Object.defineProperty(event.request, "headers", { get() { assert.fail("Pressure must not inspect headers."); } });
                if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) return;
                assert.equal(event.redirectedRequestId, undefined);
                assert.equal(typeof event.networkId, "string");
                assert.equal(event.frameId, rootFrame);
                const write = scenario === "bootstrap-capacity-write" && event.request.url.endsWith("fixture-capacity-128.js");
                assert.equal(event.request.method, write ? "POST" : "GET");
                assert.equal(event.resourceType, write ? "XHR" : bootstrapCapacity ? "Script" : "Image");
                if ((lateCapacityMetadata || lateBootstrapCapacity) && event.networkId === delayedCapacityMetadata.networkId
                    && !delayedCapacityMetadata.delivered) {
                    delayedCapacityMetadata.fetchBeforeMetadata = true;
                    delayedCapacityMetadata.fetchId = event.requestId;
                    delayedCapacityMetadata.startedAt = Date.now();
                    if (metadataCase === "missing") {
                        metadataClock = Date.now();
                        t.mock.method(Date, "now", () => metadataClock);
                    }
                    if (["missing", "capped", "document-loss", "owner-loss", "deadline", "cancel"].includes(metadataCase)) void pressure.ready.promise.then(async () => {
                        await new Promise(setImmediate);
                        if (metadataCase === "capped") delayedCapacityMetadata.cap();
                        if (metadataCase === "missing") {
                            metadataClock += 999;
                            await new Promise(resolve => setTimeout(resolve, 25));
                            assert.equal(pressure.aborted.has(event.requestId), false);
                            assert.equal(pressure.forwarded.has(event.requestId), false);
                            metadataClock++;
                        }
                        if (metadataCase === "document-loss") session.emit("Page.frameNavigated", {
                            frame: { id: rootFrame, loaderId: "replacement-document", url: context.pages()[0].url() },
                        });
                        if (metadataCase === "owner-loss") t.mock.method(context.pages()[0], "isClosed", () => true);
                        if (metadataCase === "deadline") {
                            const expired = Date.now() + 90000;
                            t.mock.method(Date, "now", () => expired);
                        }
                        if (metadataCase === "cancel") metadataCancel = (async () => host.access.command(owner, {
                            schemaVersion: 1, action: "microsoft-cancel", operationId: randomUUID(),
                            generation: (await host.access.status()).generation,
                        }, () => true))();
                    });
                }
                assert.equal(pressure.pauses.has(event.requestId), false);
                pressure.pauses.set(event.requestId, { requestId: event.requestId, networkId: event.networkId, url: event.request.url });
                pressureReady();
            });
            session.on("Network.loadingFinished", event => {
                if ([...pressure.pauses.values()].some(row => row.networkId === event.requestId)) {
                    pressure.finished.set(event.requestId, ++pressure.sequence);
                }
            });
            const send = session.send.bind(session);
            t.mock.method(session, "send", async (method, input) => {
                const row = pressure.pauses.get(input?.requestId)
                    ?? (capacityPreflight && pressure.waiter?.requestId === input?.requestId ? pressure.waiter : null);
                if (row && method === "Fetch.continueRequest") {
                    assert.equal(pressure.forwarded.has(row.requestId), false, "Never replay the original paused request.");
                    pressure.forwarded.set(row.requestId, ++pressure.sequence);
                    if (pressure.waiter?.requestId === row.requestId) pressure.resumed.resolve();
                    pressureReady();
                }
                if (row && method === "Fetch.failRequest") {
                    pressure.aborted.add(row.requestId);
                    if (metadataRefusal || bootstrapCapacity) drainPressure();
                }
                const result = await send(method, input);
                if (row && method === "Fetch.continueRequest") {
                    pressure.acknowledged.set(row.networkId, ++pressure.sequence);
                    pressureReady();
                }
                return result;
            });
        }

        if (targetKind === "root") {
            rootProtocol = session;
            rootFrame = (await session.send("Page.getFrameTree")).frameTree.frame.id;

        }
        session.on("Fetch.requestPaused", event => {
            wireRequests.push({ path: new URL(event.request.url).pathname, method: event.request.method,
                type: event.resourceType, status: event.responseStatusCode });
        });
        session.on("Network.requestWillBeSent", event => {

            const pathname = new URL(event.request.url).pathname;
            if (pathname.startsWith("/v1/")) preflightEvents.push({ path: pathname, id: event.requestId, frame: event.frameId,
                type: event.type, method: event.request.method, initiator: event.initiator?.type,
                initiatorRequest: event.initiator?.requestId });
        });

        if ((lateCapacityMetadata || lateBootstrapCapacity) && targetKind === "root") {
            const on = session.on.bind(session);
            t.mock.method(session, "on", (name, listener) => on(name, name === "Network.requestWillBeSent"
                ? event => {
                    if (new URL(event.request.url).pathname.endsWith(lateBootstrapCapacity ? "/fixture-capacity-128.js" : "/fixture-capacity-128.gif")) {
                        delayedCapacityMetadata.networkId = event.requestId;
                        if (metadataCase === "excluded") return;
                        if (metadataCase === "capped") {
                            delayedCapacityMetadata.cap = () => {
                                for (let index = 0; index < 512; index++) listener({ ...event,
                                    requestId: "capacity-provenance-" + index,
                                    request: { url: "https://aadcdn.msauth.net/fixture-provenance-" + index + ".gif", method: "GET" },
                                });
                            };
                            return;
                        }
                        if (["missing", "document-loss", "owner-loss", "cancel", "deadline"].includes(metadataCase)) return;
                        setTimeout(() => {
                            delayedCapacityMetadata.delivered = true;
                            listener(metadataCase === "mismatch" ? { ...event, request: { url: event.request.url, method: "HEAD" } }
                                : metadataCase === "stale-loader" ? { ...event, loaderId: "previous-loader" } : event);
                            if (metadataCase === "duplicate") listener(event);
                        }, 50);
                    } else listener(event);
                } : listener));
        }
        if (bindingFailureCase && targetKind === "root") {
            if (bindingFailureCase === "missing") {
                const on = session.on.bind(session);
                t.mock.method(session, "on", (name, listener) => on(name, name === "Network.requestWillBeSent" ? event => {
                    if (event.request.method === "POST" && new URL(event.request.url).pathname.endsWith(nativeHistoryProducer.chatRpcId)) {
                        suppressedBindingMetadata++;
                        return;
                    }
                    listener(event);
                } : listener));
            } else session.on("Fetch.requestPaused", event => {
                if (!invalidPageMock && event.request.method === "POST"
                    && new URL(event.request.url).pathname.endsWith(nativeHistoryProducer.chatRpcId)) {
                    invalidPageMock = t.mock.method(context.pages()[0], "isClosed", () => true);
                }
            });
        }

        return session;
    });
    const fixtureRoute = (pattern, handler) => originalRoute(pattern, route => {

        return handler({
        request: () => route.request(),
        abort: reason => {
            calls.push({ blocked: true, method: route.request().method(), path: new URL(route.request().url()).pathname,
                type: route.request().resourceType() });
            return route.abort(reason);
        },
        continue: async () => {
            const request = route.request(), url = new URL(request.url());
            if ((scenario === "bootstrap-excluded-action" || bootstrapAncillary) && request.method() === "POST"
                && url.pathname.endsWith(nativeHistoryProducer.chatRpcId)) {
                assert.notEqual(classifyNativeHistoryRequest(request.postData()).kind, "different-action",
                    "The excluded bootstrap operation must never reach the test provider.");
            }
            calls.push({ method: request.method(), path: url.pathname, navigation: request.isNavigationRequest() });
            if (cspScenario && url.href === cspReportUrl && request.resourceType() === "other") assert.fail("A CSP report must never be forwarded.");
            if (cspScenario && collectionRound > 0 && url.pathname.endsWith(nativeHistoryProducer.bootstrapRpcId)) cspBootstrapForwarded++;
            if (bootstrapAncillary && url.pathname === "/events") assert.fail("Logger writes must never reach the fixture provider.");
            if (loggerRetries && collectionRound > 0) {
                if (url.pathname.endsWith(nativeHistoryProducer.bootstrapRpcId)) await loggerFirstSettled.promise;
                if (url.pathname === "/v1/routing") await loggerReadRelease.promise;
            }
            if ((pressureAuthFlow || bootstrapCapacity) && pressurePath(url.href)) {
                assert.equal(pressure.routes.has(url.href), false);
                const held = Promise.withResolvers();
                pressure.routes.set(url.href, held);
                if (pressure.draining) held.resolve();
                pressureReady();
                await held.promise;
                return route.fulfill({ status: 200, contentType: bootstrapCapacity ? "application/javascript" : "image/gif",
                    body: bootstrapCapacity ? "" : Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
                    headers: { "cache-control": "no-store" } });
            }
            let body, mime = "application/json", status = 200, extraHeaders = {};
            if (capacityPreflight && url.href === capacityPreflightUrl) {
                assert.notEqual(request.method(), "POST", "The browser preflight must not authorize its forbidden original write.");
                return route.fulfill({ status: request.method() === "OPTIONS" ? 204 : 200, body: "{}",
                    contentType: "application/json", headers: { "access-control-allow-origin": "*",
                        "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "x-user-id",
                        "cache-control": "no-store" } });
            }

            if ((bootstrapAncillary) && url.origin === "https://res.cdn.office.net"
                && /^\/fixture-presentation\.(?:css|woff2|png)$/.test(url.pathname)) {
                presentationTypes.push(request.resourceType());
                return route.abort("failed");
            }

            if (bootstrapAncillary && ["/client_health_ping", "/events-worker.js"].includes(url.pathname)) {
                if (url.pathname === "/events-worker.js") workerPreflights++;
                return route.abort("failed");
            }

            if (request.method() === "OPTIONS") { status = 204; body = ""; }
            else if (request.resourceType() === "script") {
                body = url.pathname === "/fixture-native-frame.js" ? 'const child=document.createElement("iframe");child.src="https://blocked-bootstrap.invalid/private?secret=opaque";document.body.append(child);' : "";
                if (bootstrapAncillary && collectionRound > 0 && url.href === healthBuild.scriptAssets[1]) {
                    body = "\n\n";
                    const at = (prefix, column, rest) => {
                        body += prefix;
                        body += " ".repeat(column - (body.length - body.lastIndexOf("\n") - 1)) + rest;
                    };
                    at("function health(){return ", healthBuild.healthPingCallsites.loggerInit.column,
                        'fetch("/client_health_ping?type=loggerInit&route=PRIVATE_ROUTE").catch(()=>{});}');
                    at("function mainHealth(){return ", healthBuild.healthPingCallsites.mainLoad.column,
                        'fetch("/client_health_ping?type=mainLoad&route=PRIVATE_ROUTE").catch(()=>{});}');
                    at(loggerRetries ? 'async function sendLog(batch){await window.fixtureLoggerEvent({event:"attempt",document:location.pathname,id:batch.id,retry:batch.retry,at:performance.now()});return '
                        : "function sendLog(){return ", scenario === "bootstrap-ancillary-recorded-caller" ? 635255
                        : healthBuild.appEventsCallsites.batch.column + Number(scenario === "bootstrap-ancillary-wrong-caller"),
                        'fetch("/events",{method:"POST",body:"PRIVATE_LOGGER_BODY"})' + (loggerRetries ? ';}' : '.catch(()=>{});}'));
                    if (d6Direct) at("function retryLog(){return ", healthBuild.appEventsCallsites.retry.column,
                        'fetch("/events",{method:"POST",body:"PRIVATE_RETRY_BODY"}).catch(()=>{});}');
                    at("function flushLog(){return ", healthBuild.appEventsCallsites.flush.column,
                        'fetch("/events",{method:"POST",keepalive:true,body:"PRIVATE_FLUSH_BODY"}).catch(()=>{});}');
                    at("function probe(){return ", healthBuild.workerPreflightCallsite.column,
                        'fetch("/events-worker.js").catch(()=>{});}');
                    body += loggerRetries ? `
                        if(["/chat","/cowork/"].includes(location.pathname)){
                            void(async()=>{
                            const pending=await window.fixtureLoggerRecovery();
                            const note=(event,batch,delay)=>window.fixtureLoggerEvent({event,document:location.pathname,id:batch.id,retry:batch.retry,delay});
                            ${d6Direct ? `
                                let retryTimer=null,flushing=false;
                                const flush=async()=>{
                                    if(flushing)return;flushing=true;
                                    const batch=pending.splice(0);
                                    for(const row of batch)try{await sendLog(row)}catch{
                                        if(row.retry===3){await note("persist",row);continue}
                                        row.retry++;pending.push(row);
                                        if(retryTimer===null){
                                            const wait=Math.min(1000*2**(row.retry-1),30000);
                                            await note("schedule",row,wait);
                                            retryTimer=setTimeout(()=>{retryTimer=null;void flush()},wait);
                                        }
                                    }
                                    flushing=false;
                                };
                                const periodic=()=>setTimeout(async()=>{await flush();periodic()},3000);
                                periodic();
                            ` : `
                                const sends=[];let timer=null,next=0;
                                const pump=()=>{
                                    if(timer!==null)return;
                                    if(!sends.length)return;
                                    const wait=next-performance.now();
                                    if(wait>0){timer=setTimeout(()=>{timer=null;pump()},wait);return}
                                    const row=sends.shift();next=performance.now()+1000;
                                    void run(row);pump();
                                };
                                const enqueue=row=>{sends.push(row);pump()};
                                const run=async row=>{
                                    try{await sendLog(row)}catch{
                                        if(row.retry===3){await note("persist",row);return}
                                        row.retry++;await note("schedule",row,1000);
                                        setTimeout(()=>enqueue(row),1000);
                                    }
                                };
                                pending.forEach(enqueue);
                            `}
                            })();
                        }` : d6Direct ? 'void health();void mainHealth();void probe();'
                        + 'if(location.pathname==="/chat")void sendLog().then(retryLog).then(flushLog);'
                        + 'else if(["/chat/all","/cowork/"].includes(location.pathname))void flushLog();'
                        : 'void health();void mainHealth();void probe();if(["/chat","/chat/all","/cowork/"].includes(location.pathname))'
                        + 'void sendLog().then(flushLog)'
                        + (scenario === "bootstrap-ancillary-budget" ? '.then(()=>location.pathname==="/chat/all"?sendLog():undefined)' : "") + ';';
                }

                if (url.pathname.endsWith("/convergedlogin_pcore.min_fixture.js")) {
                    body = `const child=document.createElement("iframe");child.src="https://blocked-bootstrap.invalid/private?secret=opaque";document.body.append(child);
                        setTimeout(()=>{${'const second=document.createElement("iframe");second.src="https://login.live.com/Me.htm?v=PRIVATE_VALUE&state=SECRET";document.body.append(second);'}},50);`;
                }

                mime = "application/javascript";
            }
            else if (url.origin === "https://login.microsoftonline.com") {
                selected = true; mime = "text/html";

                body = icon + `<h1 id="fixture-picker-heading">Pick an account</h1>
                        <button id="fixture-known-account" style="" onclick="location.href='${nativeApplicationEntry}'">example@invalid.test</button>`;

            } else if (request.isNavigationRequest()) {
                mime = "text/html"; body = documents(url.pathname);
                if (cspScenario && collectionRound > 0 && url.pathname === "/chat") {
                    extraHeaders["content-security-policy"] = `style-src 'none'; ${scenario === "bootstrap-csp-required-bootstrap" ? "connect-src 'none'; " : ""}report-uri ${cspReportUrl}`;
                }
            }
            else if (url.pathname.endsWith(nativeHistoryProducer.bootstrapRpcId)) body = JSON.stringify({ result: { store: {
                accountInfo: scenario === "cowork-membership-startup-cleanup-switch" && collectionRound > 0
                    ? { ...principal, objectId: "changed-source-subject" } : principal,
                ...(scenario === "ordinary-enrollment" || coworkMembership
                    ? { identity: { userPrincipalName: principalLabel } } : {}),
            } } });
            else if (url.pathname.endsWith(nativeHistoryProducer.chatRpcId)
                && classifyNativeHistoryRequest(request.postData(), "unobserved", true).kind === "context") {
                if (bootstrapContext && collectionRound > 0) bootstrapContextReads++;
                body = JSON.stringify({ privateContext: "PRIVATE_CONTEXT_RESPONSE" });
            } else if (url.pathname.endsWith(nativeHistoryProducer.chatRpcId) || url.pathname.endsWith(nativeHistoryProducer.chatInitializerRpcId)) {
                if (scenario === "expiry") { status = 401; body = JSON.stringify({ error: "expired" }); }
                else {
                    const cursor = request.method() === "GET" ? { state: "absent" } : projectNativeHistoryRequest(request.postData()).continuation;
                    const page = cursor.state === "present" ? Number(cursor.value.split("-").at(-1)) : 0;
                    body = JSON.stringify({ result: { store: {
                        [selectedStore]: { chats: (pagedHistories ? chatIds.slice(page, page + 1) : chatIds)
                            .map(conversationId => ({ conversationId, chatName: "PRIVATE_LIST_TITLE",
                                createTimeUtc: now - 40 * 86400000,
                                updateTimeUtc: liveBackfill && liveUpdateAt && conversationId === chatId ? liveUpdateAt : now - 3600000 + (changedCold && collectionRound >= 3
                                    ? (chatIds.indexOf(conversationId) < 8 ? collectionRound : 3) * 1000
                                    : scenario === "incremental-history"
                                        || (scenario === "changing-prefix" || hotDiscovery || mixedFairness || completedLive) && chatIds.indexOf(conversationId) < 8 ? activityRound() * 1000 : 0) })),
                            syncState: pagedHistories && page < chatIds.length - 1 ? `fixture-page-${page + 1}` : "" },
                    } } });
                    if (scenario === "chat-initializer-empty-skip") body = JSON.stringify({ result: { store: {} } });
                }
            }
            else if (url.pathname === "/v1/routing") body = JSON.stringify({ endpoint: gateway, geo: "US" });
            else if (url.pathname === "/v1/automations") body = JSON.stringify({ automations: coworkMembership ? [
                { kind: "scheduled", id: `${tenant}:${subject}:${taskId}` },
                { kind: "event", id: "fixture-trigger", owner_conversation_id: `${tenant}:${subject}:${taskId}` },
            ] : [] });
            else if (url.pathname.endsWith("/scheduled-prompt")) body = JSON.stringify({
                conversation_id: `${tenant}:${subject}:${taskId}`, version: 1, execution_count: 100,
                recent_executions: [{ target_conversation_id: `${tenant}:${subject}:log-only:run`,
                    executed_at: "2099-01-01T00:00:00Z", id: "FAKE_UI_ORDINAL#1" }] });
            else if (url.pathname.startsWith("/v1/event-triggers/")) {
                if (scenario === "cowork-membership-pause") { requestPause(); await pauseResult; }
                if (scenario === "cowork-membership-unavailable") { status = 403; body = "PRIVATE_PARENT_ERROR"; }
                else body = JSON.stringify({ id: "fixture-trigger", owner_conversation_id: `${tenant}:${subject}:${taskId}`,
                    version: 1, fire_count: 100, callback_url: "PRIVATE_CALLBACK", secret_header: "PRIVATE_SECRET",
                    recent_fires: [{ conversation_id: `${tenant}:${subject}:event-live`, fired_at: "2099-01-01T00:00:00Z" }] });
            }
            else if (url.pathname === "/v1/tasks/live") {
                const page = Number(url.searchParams.get("cursor") ?? 0);
                body = JSON.stringify({ tasks: (pagedHistories ? taskIds.slice(page, page + 1) : taskIds).map(sessionId => ({ sessionId,
                    createdAt: older, lastActivity: liveBackfill && liveUpdateAt && sessionId === taskId ? liveUpdateAt : now - 3600000 + (changedCold && collectionRound >= 3
                        ? (taskIds.indexOf(sessionId) < 8 ? collectionRound : 3) * 1000
                        : scenario === "incremental-history" || scheduledRediscovery && collectionRound >= 3
                            || (scenario === "changing-prefix" || hotDiscovery || mixedFairness) && taskIds.indexOf(sessionId) < 8 ? activityRound() * 1000 : 0),
                    title: "PRIVATE_TASK_TITLE" })), nextCursor: pagedHistories && page < taskIds.length - 1 ? String(page + 1) : null });
                if (coworkMembership && ["scheduled_run", "automation_run"].includes(url.searchParams.get("sessionType"))) {
                    const scheduled = url.searchParams.get("sessionType") === "scheduled_run";
                    if (scenario === "cowork-membership-delayed" && scheduled && !page) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                    membershipRequests.push({ population: url.searchParams.get("sessionType"), cursor: url.searchParams.get("cursor") });
                    const ids = scheduled ? [scenario === "cowork-membership-carry" ? "scheduled-live-" + page
                        : page ? "other-parent-live" : "scheduled-live"] : ["event-live"];
                    body = JSON.stringify({ tasks: ids.map(sessionId => ({ sessionId, createdAt: older,
                        lastActivity: now - 3600000 + (sessionId === "event-live" && collectionRound > 1 ? 1000 : 0) })),
                        nextCursor: scheduled && page < (scenario === "cowork-membership-carry" ? 17 : 1) ? String(page + 1) : null });
                }
                if (transientRead && (scenario === "cowork-read503-repeat" || failedReadReplies === 0)) {
                    status = 503; body = JSON.stringify({ error: "PRIVATE_SERVICE_UNAVAILABLE" }); failedReadReplies++;
                    if (scenario === "cowork-read503-retry-after") extraHeaders["retry-after"] = "120";
                    if (scenario === "cowork-read503-pause") { requestPause(); await pauseResult; }
                }
            }
            else if (url.pathname.endsWith("/detail")) body = JSON.stringify({ task: {
                taskId: url.searchParams.get("sessionId"), sessionId: url.searchParams.get("sessionId").split(":").slice(2).join(":"),
                state: snapshotContext && collectionRound === 1 || scenario === "deleted-running-prefix" ? "running" : "completed",
            }, snapshot: { sessionId: url.searchParams.get("sessionId").split(":").slice(2).join(":"), ic3ThreadId: threadId,
                ...(snapshotContext ? { activeModel: collectionRound === 1 ? "invented-model-one" : "invented-model-two" } : {}) },
            ...(scenario === "byte-yield" ? { fixturePadding: "x".repeat(12 * 1024 * 1024 - 512) } : {}) });
            else if (url.pathname.endsWith("/messages")) {
                historyReads.push({ surface: "cowork", id: url.searchParams.get("sessionId")?.split(":").slice(2).join(":"), round: collectionRound });
                body = JSON.stringify({ events: [
                { id: "old-event", event: "u", data: { ts: now - 40 * 86400000, t: "PRIVATE_OLDER_COWORK" } },
                { id: "current-event" + (pagedHistories || olderPages ? "-" + (url.searchParams.get("cursor") ?? 0) : ""),
                    event: "u", data: { ts: ["unqualified-time", "cowork-matched-time-unqualified"].includes(scenario) ? current
                        : scenario === "cowork-outside-window" ? now - 40 * 86400000 : now - 3600000,
                    t: olderPages && url.searchParams.get("cursor") === "2" ? "Last Cowork history page"
                        : coworkMembership && collectionRound > 1 ? "Later automation activity"
                        : changedCold && collectionRound >= 3 && url.searchParams.get("sessionId")?.endsWith(taskIds[8])
                        ? "Cold Cowork update" : scenario === "incremental-history" && collectionRound > 1
                            ? "Later Cowork activity" : scheduledRediscovery && collectionRound >= 3
                                ? "Automatic later Cowork activity" : "Current Cowork activity" } },
                ...(matchedCowork ? [{ id: "assistant-event", event: "a", data: { e: "a", id: "assistant-message",
                    ts: now - 3500000, t: "Current Cowork assistant text", s: true } }] : []),
                ...(olderPages && !url.searchParams.has("cursor") ? Array.from({ length: 97 }, (_, index) => ({
                    id: "cold-fill-" + index, event: "u", data: { ts: now - 3600000, t: "Cold-open message " + index },
                })) : []),
                ...(["success", "cowork-matched-authors"].includes(scenario) ? [
                    { id: "qualified-error-event", event: "tx", data: { tid: "qualified-error-call",
                        tn: "native_document_update", ts: now - 3400000, ok: false,
                        err: "Permission [write] is required for {folder}." } },
                    { id: "qualified-result-event", event: "tx", data: { tid: "qualified-result-call",
                        tn: "native_document_fetch", ts: now - 3300000, ok: true,
                        d: "Retrieved the selected item.", out: "PRIVATE_NATIVE_RESULT_BODY" } },
                ] : []),
                ...(liveBackfill && liveUpdateAt && url.searchParams.get("sessionId")?.endsWith(taskId)
                    ? [{ id: "after-cutoff-event", event: "u", data: { ts: liveUpdateAt, t: "After cutoff Cowork activity" } }] : []),
            ], nextCursor: scenario === "repeated-message-cursor" ? (++repeatedCursorRequests < 3 ? "same-cursor" : null)
                : (pagedHistories || olderPages) && !longDiscovery && !timeYield && Number(url.searchParams.get("cursor") ?? 0) < 2
                ? String(Number(url.searchParams.get("cursor") ?? 0) + 1) : null });
            }
            else if (chatIds.some(id => url.pathname === "/chat/conversation/" + id)) {
                historyReads.push({ surface: "chat", id: url.pathname.split("/").at(-1), round: collectionRound });
                if (pauseScenario) {
                    requestPause();
                    await pauseResult;
                }
                mime = "application/x-ndjson";
                body = JSON.stringify({ conversationId: url.pathname.split("/").at(-1), messages: [
                    { messageId: "old-message", author: "user", messageType: "Chat", createdAt: older, text: "PRIVATE_OLDER_CHAT" },
                    { messageId: "current-message", author: "user", messageType: "Chat",
                        createdAt: scenario === "outside-window" ? older : current,
                        text: changedCold && collectionRound >= 3 && url.pathname.endsWith(chatIds[8])
                            ? "Cold Chat update" : scenario === "incremental-history" && collectionRound > 1
                                ? "Later Chat activity" : "Current Chat activity" },
                    ...(liveBackfill && liveUpdateAt && url.pathname.endsWith(chatId)
                        ? [{ messageId: "after-cutoff-message", author: "user", messageType: "Chat",
                            createdAt: new Date(liveUpdateAt).toISOString(), text: "After cutoff Chat activity" }] : []),
                ] }) + "\n" + JSON.stringify({ isLastPage: true }) + "\n";
            } else assert.fail("Unexpected invented native route: " + url.pathname);
            if (timeYield && collectionRound === 1 && !request.isNavigationRequest()) {
                if (url.pathname === "/v1/tasks/live") timeAdvance += 11000;
                else if (url.pathname.endsWith("/detail") || url.pathname.endsWith("/messages")) timeAdvance += 7000;
            }
            await route.fulfill({ status, contentType: mime, body, headers: {
                "access-control-allow-origin": "*", "cache-control": "no-store",
                "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "x-user-id,x-tenant-id,content-type",
                ...extraHeaders,
            } });
        },
        });
    });
    t.mock.method(context, "route", fixtureRoute);
    // The test provider must exist independently of WIRE installing a request
    // gate. Sign-in itself deliberately has no WIRE route interception.
    await fixtureRoute("**/*", route => route.continue());
    t.mock.method(chromium, "launchPersistentContext", async (_directory, options) => {
        assert.equal(options.chromiumSandbox, true, "Every native mode must explicitly enable Chromium sandboxing.");
        sourceOpenedAt = Date.now();
        launchOptions = options;
        return context;
    });
    let configuration = await readMicrosoftNativeConfiguration(fixture.file);
    // This family qualifies the configured original-UI collector, including
    // its scheduled reads. Ordinary-default session-reader proof lives in
    // microsoft-cowork-client.test.mjs and must not be selected by this fixture.
    const startLegacy = configuration => fixture.start(configuration, fixture.context, true, true, undefined,
        null, false, attended, false, null,
        false, scheduledRediscovery || automaticEnable);
    if (scenario === "ordinary-enrollment" || coworkMembership) {
        host = await createMicrosoftNativeHost(fixture.context, { sourceAware: true, ordinaryStartup: true, enrollmentPolicy: null });
        const status = await host.access.nativeEnrollmentStatus(admission);
        assert.equal(status.phase, "available");
        await host.access.prepareNativeEnrollment({ schemaVersion: 2, generation: status.generation,
            operationId: randomUUID() }, admission);
        configuration = await readMicrosoftNativeConfiguration(path.join(fixture.context.dataDir, "microsoft-source.json"));
        assert.notEqual(configuration.profileDirectory, fixture.config.profileDirectory);
        assert.equal(Object.hasOwn(configuration, "expectedAccount"), false);
        assert.equal(configuration.deviceRiskOrigin, undefined);
        // Enrollment remains exercised through its ordinary API. Before any
        // Connect/read, use that resulting configuration in the legacy host.
        await host.close();
        host = await startLegacy(configuration);
        manualAction = (async () => {
            const page = context.pages()[0];
            await page.getByRole("button", { name: "Sign in", exact: true }).click();
            await page.getByRole("button", { name: "example@invalid.test", exact: true }).click();
        })();
        void manualAction.catch(() => {});
    } else host = await startLegacy(configuration);
    if (!manualAction && (!attended || loggerRetries)) {
        manualAction = (async () => {
            const page = context.pages()[0];
            await page.getByRole("button", { name: "Sign in", exact: true }).click();
            await page.getByRole("button", { name: "example@invalid.test", exact: true }).click();
        })();
        void manualAction.catch(() => {});
    }

    for (const action of ["wire-sign-in", "microsoft-connect"]) {
        const work = host.access.command(owner, { schemaVersion: 1, action, operationId: randomUUID(),
            generation: (await host.access.status()).generation }, () => true);
        if (pressureAuthFlow && action === "microsoft-connect") {
            try {
                if (metadataRefusal) {
                    const receipt = await work;
                    if (metadataCancel) assert.equal((await metadataCancel).outcome, "completed");
                    assert.equal(receipt.outcome, metadataCase === "cancel" ? "cancelled" : "failed");
                    assert.equal(delayedCapacityMetadata.fetchBeforeMetadata, true);
                    assert.equal(pressure.pauses.size, 129);
                    assert.equal(pressure.forwarded.size, 128);
                    assert.equal(pressure.forwarded.has(delayedCapacityMetadata.fetchId), false);
                    const saved = JSON.parse(await readFile(path.join(fixture.context.dataDir, "microsoft-session", "session.json"), "utf8"));
                    const failure = saved.receipts.find(row => row.operationId === receipt.operationId)?.nativeEvidence?.firstFailure;
                    if (metadataCase !== "cancel") {
                        const stop = failure.protocolStop;
                        assert.equal(stop.reason, metadataCase === "deadline" ? "capacity-deadline"
                            : ["document-loss", "owner-loss"].includes(metadataCase) ? "capacity-owner-changed" : "capacity-unbound");
                        assert.equal(stop.binding.reason, {
                            missing: "metadata-timeout", capped: "metadata-capped", excluded: "metadata-excluded", mismatch: "metadata-mismatch",
                            duplicate: "metadata-duplicate", "stale-loader": "metadata-stale",
                            "document-loss": "document", "owner-loss": "custody", deadline: "deadline",
                        }[metadataCase]);
                        assert.equal(stop.binding.limit, 512);
                        assert.equal(stop.binding.capped, metadataCase === "capped");
                        assert.equal(stop.binding.retained, settlements.find(row => row.purpose === "identity")
                            .nativeSource.sourceRequestRecords.retained);
                        if (metadataCase === "capped") assert.equal(stop.binding.retained, 512);
                        else assert.ok(stop.binding.retained >= 128 && stop.binding.retained < 512);
                        assert.equal(stop.capacity.active, 128);
                        assert.equal(stop.capacity.waiting, metadataCase === "excluded" ? 0 : 1,
                            "The metadata rendezvous itself must already count as a waiting unit.");
                        assert.doesNotMatch(JSON.stringify(stop.binding), /https?:|requestId|networkId|PRIVATE_/);
                    }
                    assert.equal((await host.access.status()).collection, "paused");
                    assert.equal((await host.access.nativeCollectionControl()).enabled, false);
                    assert.equal(receipt.nativeEvidence, undefined);
                    assert.equal(settlements.some(row => row.purpose === "content"), false);
                    await host.close();
                    return;
                }
                pressure.waiter = await Promise.race([pressure.ready.promise, work.then(async receipt => {
                    const saved = lateCapacityMetadata ? JSON.parse(await readFile(
                        path.join(fixture.context.dataDir, "microsoft-session", "session.json"), "utf8")) : null;
                    assert.fail("Connect ended before genuine pressure: " + JSON.stringify({
                        outcome: receipt.outcome, failure: settlements.at(-1)?.nativeSource?.failure,
                        continued: pressure.forwarded.size, paused: pressure.pauses.size, held: pressure.routes.size,
                        ...(lateCapacityMetadata ? {
                            fetchBeforeMetadata: delayedCapacityMetadata.fetchBeforeMetadata,
                            sourceRequestRecords: settlements.at(-1)?.nativeSource?.sourceRequestRecords,
                            firstFailure: saved.receipts.find(row => row.operationId === receipt.operationId)?.nativeEvidence?.firstFailure,
                        } : {}),
                    }));
                })]);
                await new Promise(setImmediate);
                assert.equal(pressure.forwarded.size, 128);
                assert.equal(pressure.aborted.size, 0);
                assert.equal(pressure.acknowledged.size, 128);
                assert.equal(pressure.finished.size, 0);
                assert.equal(pressure.forwarded.has(pressure.waiter.requestId), false);
                const first = [...pressure.pauses.values()].find(row => pressure.routes.has(row.url));
                pressure.routes.get(first.url).resolve();
                await Promise.race([pressure.resumed.promise, work.then(() => assert.fail("The original waiter did not resume."))]);
                const resumedAt = pressure.forwarded.get(pressure.waiter.requestId);
                if (lateCapacityMetadata) {
                    assert.equal(delayedCapacityMetadata.fetchBeforeMetadata, true);
                    assert.equal(delayedCapacityMetadata.delivered, true);
                }
                assert.ok(pressure.acknowledged.get(first.networkId) < resumedAt, "Real continuation acknowledgement precedes capacity reuse.");
                assert.ok(pressure.finished.get(first.networkId) < resumedAt, "Real Network completion precedes capacity reuse.");
                assert.equal(pressure.aborted.size, 0);
            } finally {
                drainPressure();
            }
        }

        const receipt = await work;

        if (scenario === "changed-producer" && action === "microsoft-connect") {
            assert.equal(receipt.outcome, "completed", "Source decoder build admission must not gate normal Microsoft sign-in.");
            assert.equal((await host.access.nativeCollectionControl()).enabled, false);
        }

        if (scenario === "changed-cowork-producer" && action === "microsoft-connect") {
            assert.equal(receipt.outcome, "completed");
            assert.equal(calls.some(row => row.path.startsWith("/v1/")), false,
                "The reviewed Cowork producer must be active before routing/list identity requests are admitted.");
        }

        assert.equal(receipt.outcome, "completed", JSON.stringify({ reason: receipt.reason, calls, wireRequests, preflightEvents, settlements }));
    }
    assert.equal(calls.some(row => row.path.startsWith("/v1/")), false,
        "Fresh account verification must not depend on Cowork or read source history before Enable.");

    if (scheduledRediscovery) {
        const scopes = new WeakSet(), callbacks = new WeakSet();
        const hook = createHook({ init(_id, type, _parent, resource) {
            if (type === "WIRENativeCollectorTimer") scopes.add(resource);
        } }).enable();
        t.after(() => hook.disable());
        const bind = AsyncResource.prototype.bind, set = globalThis.setTimeout;
        let nextTick = Promise.withResolvers(), nextCommit = Promise.withResolvers();
        const receipts = [];
        t.mock.method(AsyncResource.prototype, "bind", function (...args) {
            const callback = Reflect.apply(bind, this, args);
            if (scopes.has(this)) callbacks.add(callback);
            return callback;
        });
        t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
            const timer = set(callback, milliseconds, ...args);
            if (milliseconds === 60000 && callbacks.has(callback)) nextTick.resolve({ timer, callback });
            return timer;
        });
        host.access.startNativeCollection(work => work(), receipt => { receipts.push(receipt); nextCommit.resolve(receipt); });
        const offer = await host.access.nativeConfigurationOffer(admission);
        collectionRound = 1;
        await host.access.configureNativeIntent({ schemaVersion: 2, intent: offer.intent, generation: offer.generation,
            authorizationRevision: offer.authorizationRevision, expectedRevision: offer.expectedRevision,
            globalRevision: offer.globalRevision, surfaces: ["cowork"], windowDays: 7 }, admission);
        assert.equal((await nextCommit.promise).status, "committed");
        assert.equal(historyReads.length, 1);
        const initialPartitions = (await loadBoardState(fixture.context)).nativeRetention.partitions;
        for (collectionRound = 2; collectionRound <= 3; collectionRound++) {
            const tick = await nextTick.promise;
            nextTick = Promise.withResolvers(); nextCommit = Promise.withResolvers();
            if (collectionRound === 3) taskIds.push("66666666-6666-4666-8666-666666666666");
            clearTimeout(tick.timer);
            tick.callback();
            const receipt = await nextCommit.promise;
            assert.equal(receipt.status, "committed");
            if (contextRead) {
                const records = settlements.filter(row => row.purpose === "content").flatMap(row => row.beforeCleanup.requests);
                assert.equal(records.some(row => row.kind === "context"), false, "Context transport must not be recorded as source evidence.");

            }
            if (collectionRound === 2) {
                assert.equal(historyReads.length, 1, "An unchanged list does not reread completed histories.");
                assert.equal(receipt.changes.addedObservations, 0);
                assert.deepEqual((await loadBoardState(fixture.context)).nativeRetention.partitions[0].file, initialPartitions[0].file);
            }
        }
        assert.equal(calls.filter(row => row.path === "/v1/tasks/live").length, transientRead ? 4 : 3,
            "Each automatic round must obtain an original first page, not reuse an already-loaded native store.");
        assert.equal(calls.filter(row => row.path === "/cowork/" && row.navigation).length, transientRead ? 4 : 3);
        assert.equal(historyReads.length, 3, "The later round revisits the changed task and discovers the new task.");
        assert.ok(historyReads.every(row => row.surface === "cowork"));
        assert.equal(calls.some(row => row.path.endsWith(nativeHistoryProducer.chatRpcId)
            || row.path.endsWith(nativeHistoryProducer.chatInitializerRpcId) || row.path.startsWith("/chat/conversation/")), false);
        const guard = await host.access.read(owner);
        try {
            const views = host.access.nativeRetainedFor(guard, { check() {} });
            const frame = await views.query({ schemaVersion: 1, revision: null, sources: ["microsoft-365-cowork"],
                analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 10, after: null } });
            assert.equal(frame.aggregates.conversations, 2);
            const details = await Promise.all(frame.page.items.map(item => views.detail({ schemaVersion: 1,
                revision: frame.revision, sources: ["microsoft-365-cowork"], conversationId: item.id, page: { limit: 10, after: null } })));
            assert.match(JSON.stringify(details), /Automatic later Cowork activity/);
            assert.match(JSON.stringify(details), /Current Cowork activity/);
        } finally { guard.release(); }
        const tick = await nextTick.promise, beforePause = calls.length;
        await host.access.setNativeCollectionEnabled({ enabled: false,
            expectedNativeRevision: (await host.access.nativeCollectionControl()).revision }, admission);
        tick.callback();
        await nextTurn();
        assert.equal(calls.length, beforePause);
        assert.equal((await host.access.nativeCollectionControl()).retained, true);
        nextTick = Promise.withResolvers(); nextCommit = Promise.withResolvers();
        collectionRound = 4;
        await host.access.setNativeCollectionEnabled({ enabled: true,
            expectedNativeRevision: (await host.access.nativeCollectionControl()).revision }, admission);
        assert.equal((await nextCommit.promise).status, "committed");
        const afterResume = await nextTick.promise;
        const beforeLogout = calls.length;
        assert.equal((await host.access.command(owner, { schemaVersion: 1, action: "wire-sign-out",
            operationId: randomUUID(), generation: (await host.access.status()).generation }, () => true)).outcome, "completed");
        afterResume.callback();
        await nextTurn();
        assert.equal(calls.length, beforeLogout);
        await assert.rejects(host.access.read(owner), { code: "wire_access_revoked" });
        assert.equal(new Set(receipts.map(row => row.operationId)).size, 4);
        assert.ok((await loadBoardState(fixture.context)).nativeRetention.receipts.every(row => row.status === "committed"));
        await host.close();
        return;
    }
    if (automaticEnable) {
        collectionRound = 1;
        host.access.startNativeCollection(work => work(), receipt => automaticCollection.resolve({ receipt }));
    }
    const offer = await host.access.nativeConfigurationOffer(admission);
    await host.access.configureNativeIntent({ schemaVersion: 2, intent: offer.intent, generation: offer.generation,
        authorizationRevision: offer.authorizationRevision, expectedRevision: offer.expectedRevision,
        globalRevision: offer.globalRevision, surfaces: membershipSSR && !backgroundBootstrap ? ["chat"]
            : scenario === "bootstrap-context-cowork" ? ["cowork"] : ["chat", "cowork"], windowDays: 7 }, admission);
    collectionRound = 1;
    let automaticReceipt;
    if (automaticEnable && !bootstrapCapacity) {
        const result = await automaticCollection.promise;
        await host.access.stopNativeCollection();
        const state = await loadBoardState(fixture.context);
        if (cspRefusal) {
            assert.equal(state.nativeRetention.partitions.length, 0);
            assert.equal(state.nativeRetention.receipts.length, 1);
            const original = state.nativeRetention.receipts[0];
            assert.equal(original.status, "registered");
            assert.equal(result.error, scenario === "bootstrap-csp-pause" ? null
                : scenario === "bootstrap-csp-required-bootstrap" ? "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED"
                : "NATIVE_SOURCE_REQUEST_FAILED", JSON.stringify(original.firstFailure));
            if (scenario === "bootstrap-csp-pause") {
                assert.equal(original.firstFailure.code, "NATIVE_SOURCE_CANCELLED");
                assert.equal((await host.access.nativeCollectionControl()).enabled, false);
                assert.equal(historyReads.length, 0);
            } else if (scenario !== "bootstrap-csp-required-bootstrap") assert.equal(original.firstFailure.protocolStop.reason, "policy-block-scope");
            if (scenario === "bootstrap-csp-required-bootstrap") {
                assert.equal(cspBootstrapForwarded, 0, "CSP enforcement blocks the required original principal read.");
                assert.equal(historyReads.length, 0);
                assert.ok(settlements.find(row => row.purpose === "content").nativeSource.blockedCspReports.failed >= 1);
            }
            await host.close();
            assert.deepEqual((await loadBoardState(fixture.context)).nativeRetention.receipts[0].firstFailure, original.firstFailure);
            return;
        }
        if (loggerRetries) {
            const original = state.nativeRetention.receipts[0];
            assert.equal(launchOptions.headless, false, "Use ordinary attended custody and its actual sixteen-attempt bound.");
            assert.equal(state.nativeRetention.receipts.length, 1);
            assert.equal(original.status, "committed", JSON.stringify(original.firstFailure));
            assert.equal(result.error, undefined);
            assert.ok(state.nativeRetention.partitions.length > 0);
            const attempts = loggerEvents.filter(row => row.event === "attempt");
            assert.deepEqual(loggerEvents.filter(row => row.event === "recover"), [
                { event: "recover", document: "/chat", ids: [0, 1, 2] },
                { event: "recover", document: "/cowork/", ids: [0, 1, 2] },
            ], "The second document drains the same three groups persisted after first-document retry exhaustion, not fresh invented batches.");
            assert.equal(attempts.filter(row => row.document === "/chat").length, 12);
            assert.equal(attempts.filter(row => row.document === "/cowork/").length, 12);
            assert.equal(loggerEvents.filter(row => row.event === "persist" && row.document === "/chat").length, 3);
            assert.ok(loggerEvents.filter(row => row.event === "schedule").every(row =>
                row.delay === (d6Direct ? Math.min(1000 * 2 ** (row.retry - 1), 30000) : 1000)));
            assert.deepEqual(settlements.find(row => row.purpose === "content").nativeSource.blockedAppEvents, {
                role: "reviewed-app-logger", posts: 24, acknowledged: 24, failedPosts: 24, disposition: "denied-not-contacted",
            });
            assert.equal(calls.some(row => row.path === "/events" && !row.blocked), false);
        }
        if (d6Unqualified) {
            assert.equal(result.error, "NATIVE_SOURCE_BUILD_UNQUALIFIED");
            assert.equal(state.nativeRetention.partitions.length, 0);
            assert.equal(state.nativeRetention.receipts.length, 1);
            assert.equal(state.nativeRetention.receipts[0].status, "registered");
            assert.equal(historyReads.length, 0);
            assert.equal(calls.some(row => row.path === "/events" && !row.blocked), false);
            await host.close();
            return;
        }
        if (unqualifiedAncillaryCaller) {
            const original = state.nativeRetention.receipts[0];
            assert.equal(state.nativeRetention.receipts.length, 1);
            assert.equal(original.status, "registered");
            assert.equal(state.nativeRetention.partitions.length, 0);
            if (unqualifiedAncillaryCaller) assert.equal(historyReads.length, 0);
            assert.equal(result.error, "NATIVE_SOURCE_REQUEST_FAILED");
            assert.deepEqual(original.firstFailure.protocolStop, {
                reason: "app-telemetry-role", phase: "request",
                request: { method: "POST", resourceType: "xhr", owner: "owned-frame", original: true, navigation: false },
                provenance: { request: "matched", frame: "root", invocation: "unobserved" },
            });
            assert.equal(calls.some(row => row.path === "/events" && !row.blocked), false);
            assert.doesNotMatch(JSON.stringify(original.firstFailure), /PRIVATE_|https:|scriptId|networkId/);
            await host.close();
            assert.deepEqual((await loadBoardState(fixture.context)).nativeRetention.receipts[0].firstFailure, original.firstFailure);
            return;
        }
        assert.equal(result.receipt?.status, "committed", JSON.stringify(state.nativeRetention.receipts.at(-1)?.firstFailure));
        automaticReceipt = result.receipt;
    }
    if (bootstrapCapacity) {
        try {
            const firstOutcome = await Promise.race([pressure.ready.promise.then(waiter => ({ waiter })),
                automaticCollection.promise.then(result => ({ result }))]);
            if (firstOutcome.result) {
                await host.access.stopNativeCollection();
                const state = await loadBoardState(fixture.context);
                assert.fail("First Enable stopped before bounded resource waiting: " + JSON.stringify({
                    error: firstOutcome.result.error, firstFailure: state.nativeRetention.receipts.at(-1)?.firstFailure,
                    continued: pressure.forwarded.size, paused: pressure.pauses.size, held: pressure.routes.size,
                }));
            }
            pressure.waiter = firstOutcome.waiter;
            await new Promise(setImmediate);
            if (capacityPreflightFailure) {
                if (scenario === "bootstrap-capacity-preflight-pause") {
                    await host.access.setNativeCollectionEnabled({ enabled: false,
                        expectedNativeRevision: (await host.access.nativeCollectionControl()).revision }, admission);
                } else if (scenario === "bootstrap-capacity-preflight-document") {
                    rootProtocol.emit("Page.frameNavigated", { frame: {
                        id: rootFrame, loaderId: "fixture-replacement-loader", url: context.pages()[0].url(),
                    } });
                } else if (["bootstrap-capacity-preflight-unqualified", "bootstrap-capacity-preflight-write"].includes(scenario)) {
                    const row = [...pressure.pauses.values()].find(row => pressure.routes.has(row.url));
                    pressure.routes.get(row.url).resolve();
                }
                const outcome = await automaticCollection.promise;
                await host.access.stopNativeCollection();
                const state = await loadBoardState(fixture.context), original = state.nativeRetention.receipts[0];
                assert.equal(state.nativeRetention.receipts.length, 1);
                assert.equal(original.status, "registered");
                assert.equal(state.nativeRetention.partitions.length, 0);
                assert.equal(historyReads.length, 0);
                if (scenario === "bootstrap-capacity-preflight-unqualified") {
                    assert.equal(outcome.error, "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
                    assert.deepEqual(settlements.find(row => row.purpose === "content").nativeSource.blockedDependencyPreflights,
                        { pairs: 1, failedGets: 1, failedPreflights: 1, disposition: "both-denied-not-contacted" });
                } else if (scenario === "bootstrap-capacity-preflight-write") {
                    assert.equal(outcome.error, "NATIVE_SOURCE_REQUEST_UNQUALIFIED");
                    assert.equal(original.firstFailure.admission.predicate, "method-scope");
                } else if (scenario === "bootstrap-capacity-preflight-pause") {
                    assert.equal(original.firstFailure.code, "NATIVE_SOURCE_CANCELLED");
                    assert.equal((await host.access.nativeCollectionControl()).enabled, false);
                } else {
                    assert.equal(outcome.error, "NATIVE_SOURCE_REQUEST_FAILED");
                    assert.equal(original.firstFailure.protocolStop.reason, scenario.endsWith("-document") ? "capacity-owner-changed" : "capacity-unbound");
                    assert.equal(original.firstFailure.protocolStop.binding.reason,
                        scenario.endsWith("-document") ? "document"
                            : ["bootstrap-capacity-preflight-stale-original", "bootstrap-capacity-preflight-explicit-loader"].includes(scenario)
                                ? "metadata-stale" : "metadata-mismatch");
                }
                assert.equal(calls.some(row => row.path === new URL(capacityPreflightUrl).pathname
                    && !row.blocked && row.method !== "OPTIONS"), false);
                await host.close();
                assert.deepEqual((await loadBoardState(fixture.context)).nativeRetention.receipts[0].firstFailure, original.firstFailure);
                return;
            }
            assert.equal(pressure.forwarded.size, capacityPreflight ? 127 : 128);
            assert.equal(pressure.acknowledged.size, capacityPreflight ? 127 : 128);
            assert.equal(pressure.finished.size, 0);
            assert.equal(pressure.aborted.size, 0);
            assert.equal(pressure.forwarded.has(pressure.waiter.requestId), false);
            if (capacityPreflight) {
                assert.deepEqual(capacityPreflightEvents.filter(row => row.event === "network").map(row => ({
                    method: row.method, type: row.type, framePresent: row.framePresent, root: row.root,
                    loaderPresent: row.loaderPresent, loaderEmpty: row.loaderEmpty,
                    documentMatched: row.documentMatched, initiator: row.initiator, linkedRequestPresent: row.linkedRequestPresent,
                })), [
                    { method: "GET", type: "Fetch", framePresent: true, root: true, loaderPresent: true,
                        loaderEmpty: false, documentMatched: true, initiator: "script", linkedRequestPresent: false },
                    { method: "OPTIONS", type: "Other", framePresent: false, root: false, loaderPresent: false,
                        loaderEmpty: true, documentMatched: false, initiator: "preflight", linkedRequestPresent: true },
                ]);
                assert.ok(capacityPreflightEvents.some(row => row.event === "fetch" && row.method === "OPTIONS"
                    && row.type === "XHR" && row.root));
            }
            const first = [...pressure.pauses.values()].find(row => pressure.routes.has(row.url));
            if (bootstrapCapacityRefusal) {
                if (scenario === "bootstrap-capacity-pause") await host.access.setNativeCollectionEnabled({
                    enabled: false, expectedNativeRevision: (await host.access.nativeCollectionControl()).revision }, admission);
                else if (scenario === "bootstrap-capacity-logout") await host.access.command(owner, {
                    schemaVersion: 1, action: "wire-sign-out", operationId: randomUUID(),
                    generation: (await host.access.status()).generation }, () => true);
                else if (scenario === "bootstrap-capacity-document") rootProtocol.emit("Page.frameNavigated", {
                    frame: { id: rootFrame, loaderId: "replacement-document", url: context.pages()[0].url() },
                });
                else if (scenario === "bootstrap-capacity-deadline") {
                    const expired = Date.now() + 300001;
                    t.mock.method(Date, "now", () => expired);
                    rootProtocol.emit("Page.frameDetached", { frameId: "unrelated-fixture-frame" });
                } else pressure.routes.get(first.url).resolve();
                const result = await automaticCollection.promise;
                await host.access.stopNativeCollection();
                const state = await loadBoardState(fixture.context), original = state.nativeRetention.receipts.at(-1);
                assert.equal(state.nativeRetention.partitions.length, 0);
                assert.equal(state.nativeRetention.receipts.length, 1);
                assert.equal(original.status, "registered");
                assert.equal(pressure.forwarded.has(pressure.waiter.requestId), false);
                assert.equal(historyReads.length, 0);
                if (["bootstrap-capacity-document", "bootstrap-capacity-deadline"].includes(scenario)) {
                    assert.equal(result.error, "NATIVE_SOURCE_REQUEST_FAILED");
                    assert.equal(original.firstFailure.protocolStop.reason, scenario.endsWith("-document") ? "capacity-owner-changed" : "capacity-deadline");
                    assert.equal(original.firstFailure.protocolStop.binding.reason, scenario.endsWith("-document") ? "document" : "deadline");
                    assert.equal(original.firstFailure.protocolStop.capacity.active, 128);
                    assert.equal(original.firstFailure.protocolStop.capacity.waiting, 1);
                } else if (["bootstrap-capacity-unknown", "bootstrap-capacity-write"].includes(scenario)) {
                    assert.equal(result.error, "NATIVE_SOURCE_REQUEST_UNQUALIFIED");
                    assert.equal(original.firstFailure.admission.predicate, scenario.endsWith("-write") ? "method-scope" : "data-dependency");
                } else assert.equal(original.firstFailure.code, "NATIVE_SOURCE_CANCELLED");
                assert.doesNotMatch(JSON.stringify(original.firstFailure), /PRIVATE_|fixture-capacity|replacement-document/);
                await host.close();
                assert.deepEqual((await loadBoardState(fixture.context)).nativeRetention.receipts[0].firstFailure, original.firstFailure);
                return;
            }
            pressure.routes.get(first.url).resolve();
            const resumed = await Promise.race([pressure.resumed.promise.then(() => true),
                automaticCollection.promise.then(() => false)]);
            assert.equal(resumed, true, "First Enable must resume the original waiter: "
                + (resumed ? "" : JSON.stringify((await loadBoardState(fixture.context)).nativeRetention.receipts.at(-1)?.firstFailure)));
            const resumedAt = pressure.forwarded.get(pressure.waiter.requestId);
            assert.ok(pressure.acknowledged.get(first.networkId) < resumedAt);
            assert.ok(pressure.finished.get(first.networkId) < resumedAt);
            if (lateBootstrapCapacity) {
                assert.equal(delayedCapacityMetadata.fetchBeforeMetadata, true);
                assert.equal(delayedCapacityMetadata.delivered, true);
            }
            drainPressure();
            automaticReceipt = (await automaticCollection.promise).receipt;
            assert.equal(automaticReceipt?.status, "committed", JSON.stringify(settlements.find(row => row.purpose === "content")));
            await host.access.stopNativeCollection();
            assert.equal(pressure.forwarded.size, capacityPreflight ? 128 : 129);
            assert.equal(pressure.finished.size, capacityPreflight ? 127 : 129);
            assert.equal(pressure.aborted.size, 0);
            if (capacityPreflight) {
                assert.equal(capacityPreflightEvents.filter(row => row.event === "finished").length, 2);
                assert.ok(capacityPreflightEvents.some(row => row.event === "response" && row.type === "Preflight" && row.status === 204));
                if (scenario === "bootstrap-capacity-preflight-late") {
                    assert.equal(preflightMetadata.fetchBeforeMetadata, true);
                    assert.ok(preflightMetadata.delayed > 0);
                    assert.equal(preflightMetadata.delivered, preflightMetadata.delayed);
                }
            }
        } finally { drainPressure(); }
    }
    if (localImageScenario && scenario !== "bootstrap-local-image") {
        const before = (await loadBoardState(fixture.context)).nativeRetention.partitions, operationId = randomUUID();
        await assert.rejects(host.access.collectNativeNow({ operationId }, admission), { code: "NATIVE_SOURCE_REQUEST_FAILED" });
        const state = await loadBoardState(fixture.context), receipt = state.nativeRetention.receipts.find(row => row.operationId === operationId);
        assert.deepEqual(state.nativeRetention.partitions, before);
        assert.equal(historyReads.length, 0);
        assert.equal(receipt.status, "registered");
        assert.deepEqual(receipt.firstFailure.protocolStop, {
            reason: "network-record-missing", phase: "network", terminal: "finished",
            networkRecord: { observation: "original", resourceType: "image",
                urlClass: scenario.endsWith("-remote") ? "https" : "embedded-raster-image", frame: "root",
                document: scenario.endsWith("-stale-document") ? "different-at-request" : "matched-at-request",
                loader: scenario.endsWith("-stale-loader") ? "different-at-request" : "matched-at-request" },
        });
        assert.doesNotMatch(JSON.stringify(receipt.firstFailure), /PRIVATE_|data:|base64|https:|invented-old-loader/);
        await host.close();
        assert.deepEqual((await loadBoardState(fixture.context)).nativeRetention.receipts.find(row =>
            row.operationId === operationId).firstFailure, receipt.firstFailure);
        return;
    }
    if (timeYield) {
        const realNow = Date.now.bind(Date);
        t.mock.method(Date, "now", () => realNow() + timeAdvance);
    }

    if (!succeeds || membershipFailure) {
        const before = (await loadBoardState(fixture.context)).nativeRetention.partitions;
        await assert.rejects(host.access.collectNativeNow({ operationId: randomUUID() }, admission), error => {
            assert.equal(pauseFailure, undefined, "Pause control failed: " + pauseFailure);
            assert.equal(error.code, scenario === "changed-producer" ? "NATIVE_SOURCE_BUILD_UNQUALIFIED"
                : scenario === "cowork-membership-wrong-account" ? "NATIVE_SOURCE_ACCOUNT_MISMATCH"
                : scenario === "cowork-membership-background-account-switch" ? "NATIVE_SOURCE_ACCOUNT_MISMATCH"
                : scenario === "cowork-membership-startup-cleanup-switch" ? "NATIVE_SOURCE_ACCOUNT_MISMATCH"
                : scenario === "cowork-membership-background-conflict" ? "NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED"
                : scenario === "cowork-membership-pause" ? "NATIVE_SOURCE_CANCELLED"
                : scenario === "cowork-membership-background-late-pause" ? "NATIVE_SOURCE_CANCELLED"
                : scenario === "cowork-membership-marker" ? "NATIVE_SOURCE_REQUEST_UNQUALIFIED"
                : scenario === "chat-context-filtered" ? "NATIVE_HISTORY_REQUEST_UNQUALIFIED"
                : scenario === "chat-context-limit" ? "NATIVE_SOURCE_REQUEST_LIMIT"
                : scenario === "chat-context-wrong-cohort" ? "NATIVE_SOURCE_BUILD_UNQUALIFIED"
                : scenario === "cowork-older-missing-control" ? "NATIVE_SOURCE_PAGING_UNQUALIFIED"
                : scenario === "cowork-older-unknown-script" ? "NATIVE_SOURCE_BUILD_UNQUALIFIED"
                : scenario === "cowork-older-pause" ? "NATIVE_SOURCE_CANCELLED"
                : scenario === "cowork-event-feed-unmatched" ? "NATIVE_SOURCE_BUILD_UNQUALIFIED"
                : scenario === "cowork-event-feed-switch" ? "NATIVE_SOURCE_CONTINUATION_UNQUALIFIED"
                : scenario === "cowork-task-rows-unmatched" ? "NATIVE_SOURCE_BUILD_UNQUALIFIED"
                : scenario === "cowork-task-rows-selection" ? "NATIVE_HISTORY_CONTROL_UNQUALIFIED"
                : scenario === "cowork-run-rows-wrong-population" ? "NATIVE_SOURCE_ASSOCIATION_FAILED"
                : scenario === "cowork-read503-pause" ? "NATIVE_SOURCE_CANCELLED"
                : scenario === "cowork-read503-repeat" ? "NATIVE_SOURCE_TRANSIENT_READ_FAILED"
                : scenario === "cowork-read503-retry-after" ? "NATIVE_SOURCE_RETRY_AFTER_REQUIRED"
                : scenario === "changed-cowork-producer" || cohortFailure ? "NATIVE_SOURCE_BUILD_UNQUALIFIED"
                : scenario === "cowork-cached-continuation" ? "NATIVE_SOURCE_QUERY_UNQUALIFIED"
                : ["chat-initializer-store-switch", "cowork-population-switch"].includes(scenario) ? "NATIVE_SOURCE_CONTINUATION_UNQUALIFIED"
                    : scenario === "chat-initializer-empty-skip" ? "NATIVE_SOURCE_RESPONSE_UNQUALIFIED"
                : scenario === "expiry" ? "NATIVE_SOURCE_ACCESS_EXPIRED" : scenario === "wrong-action"
                ? "NATIVE_SOURCE_DISCOVERY_UNQUALIFIED" : scenario === "pause" ? "NATIVE_SOURCE_CANCELLED"
                    : ["native-retry", "repeated-message-cursor"].includes(scenario) ? "NATIVE_SOURCE_CONTINUATION_UNQUALIFIED"
                        : associationFailure ? "NATIVE_SOURCE_ASSOCIATION_FAILED" : "NATIVE_NO_QUALIFIED_WINDOW_ACTIVITY");
            return true;
        });
        const failedState = await loadBoardState(fixture.context);
        assert.deepEqual(failedState.nativeRetention.partitions, before);
        if (scenario === "cowork-membership-background-late-pause") {
            await new Promise(resolve => setTimeout(resolve, 400));
            assert.deepEqual((await loadBoardState(fixture.context)).nativeRetention.partitions, before);
            assert.equal(historyReads.length, 0, "Pause during bootstrap cannot lead to source discovery or retained reads.");
        }
        const failedReceipt = failedState.nativeRetention.receipts.at(-1);
        assert.equal(failedReceipt.status, "registered");
        assert.ok(failedReceipt.firstFailure?.code.startsWith("NATIVE_"));
        if (!contextRejected && scenario !== "cowork-membership-marker") {
            assert.equal(failedReceipt.firstFailure.predicate.name, "unobserved");
            assert.equal(failedReceipt.firstFailure.predicate.stage, "acquisition");
        }
        if (scenario === "wrong-action") {
            const chat = failedState.nativeRetention.backfill[0].sources.find(row => row.surface === "chat");
            assert.equal(chat.startQualified, false);
            assert.equal(chat.exhausted, false);
            assert.equal(chat.initial, "unobserved");
            assert.equal(settlements.find(row => row.purpose === "content").nativeSource.blockedChatActions.failedPosts, 1);
        }
        if (scenario === "unqualified-time") {
            assert.equal(failedReceipt.backfill.sources.find(row => row.surface === "cowork").unreadable, 1);
            assert.equal(failedState.nativeRetention.backfill[0].sources.find(row => row.surface === "cowork").histories[0].state, "unreadable");
        }

        if (scenario === "pause") {
            const control = await host.access.nativeCollectionControl();
            assert.equal(control.enabled, false);
            assert.equal(control.connected, true, "Pause is not Microsoft expiry.");
            assert.equal(control.retained, true);
        }
        const posted = calls.filter(row => !row.blocked && row.method === "POST").length;
        if (scenario === "native-retry") assert.ok(posted <= 1, "No repeated native request may be forwarded.");
        else if (contextRejected) assert.equal(posted, scenario === "chat-context-limit" ? 8 : 0);
        else if (membershipFailure || taskRows || eventFeed || olderPages || associationFailure || chatInitializer || queryFailure || cohortFailure || transientRead
            || ["changed-producer", "changed-cowork-producer"].includes(scenario)) assert.equal(posted, 0);
        else assert.equal(posted, ["wrong-action", "repeated-message-cursor"].includes(scenario) ? 0 : 1);
        if (scenario === "cowork-membership-marker") assert.equal(calls.some(row => row.method === "PUT"), false,
            "The original native read marker cannot reach even the isolated fixture service.");
        if (transientRead) assert.equal(failedReadReplies, scenario === "cowork-read503-repeat" ? 2 : 1);
        if (scenario === "repeated-message-cursor") assert.equal(repeatedCursorRequests, 2,
            "The repeated original continuation must be denied before a later terminal reply can hide it.");
        if (associationFailure) assert.equal(calls.filter(row => !row.blocked && row.path.endsWith("/messages")).length, 0,
            "Every supplied selector must be qualified before the original messages request is continued.");
        if (olderPages) {
            assert.equal(calls.filter(row => !row.blocked && row.path.endsWith("/messages")).length, 1,
                "An unavailable or revoked native UI cannot authorize a cursor request or publish a prefix as complete.");
            assert.equal(failedReceipt.backfill.sources.find(row => row.surface === "cowork").unreadable, 1);
        }
        await host.close();
        assert.deepEqual((await loadBoardState(fixture.context)).nativeRetention.receipts.find(row =>
            row.operationId === failedReceipt.operationId).firstFailure, failedReceipt.firstFailure);
        await assert.rejects(stat(fixture.config.ownerLockPath), { code: "ENOENT" });
        return;
    }
    if (scenario === "chat-ssr-wrong-cursor") {
        await assert.rejects(host.access.collectNativeNow({ operationId: randomUUID() }, admission),
            { code: "NATIVE_SOURCE_CONTINUATION_UNQUALIFIED" });
        assert.equal(calls.some(row => row.method === "POST" && !row.blocked), false);
        assert.equal(historyReads.length, 0);
        await host.close();
        return;
    }
    let receipt;
    try { receipt = automaticReceipt ?? await host.access.collectNativeNow({ operationId: randomUUID() }, admission); }
    catch (error) { assert.fail(JSON.stringify({ code: error.code, ...({ calls, wireRequests, preflightEvents }) })); }
    assert.equal(receipt.status, "committed");
    if (cspScenario) {
        assert.ok(cspViolations.some(row => row.directive === "style-src-elem" && row.disposition === "enforce" && row.styleBlocked),
            "The original CSP violation must still block its inline style, not just suppress its report.");
        assert.match(cspRequestIds.network, /\S/);
        assert.equal(cspRequestIds.fetch, cspRequestIds.network);
        assert.equal(cspRequestIds.terminal, cspRequestIds.network);
        assert.equal(cspEvents.length, 3);
        assert.deepEqual(cspEvents.at(-1), { event: "failed" });
        // CDP domains can deliver Fetch before Network; bindCspReport waits for the original Network identity.
        assert.deepEqual(["network", "fetch"].map(kind => cspEvents.find(row => row.event === kind)), [
            { event: "network", type: "Other", method: "POST", root: true, loaderMatched: true, documentMatched: true, initiator: "script" },
            { event: "fetch", type: "CSPViolationReport", root: true },
        ], "Real Chromium generates the report; no resource-type label is forged by the fixture.");
        const content = settlements.find(row => row.purpose === "content");
        assert.deepEqual(content.nativeSource.blockedCspReports,
            { reports: 1, acknowledged: 1, failed: 1, sourceQualified: false, disposition: "denied-not-contacted" });
        assert.equal(content.nativeSource.blockedAppEvents, undefined, "A report to an events-shaped URL is still not logger authority.");
        assert.equal(content.sourceComparison.status, "matched");
    }
    if (automaticEnable) {
        const content = settlements.find(row => row.purpose === "content");
        assert.equal(content.sourceComparison.status, "matched");
        assert.equal(content.nativeSource.accountVerified, true);
        assert.equal((await loadBoardState(fixture.context)).nativeRetention.receipts.length, 1,
            "Explicit Enable schedules exactly one first acquisition, not a compensating manual collection.");
        if (bootstrapAncillary) {
            assert.equal(content.nativeSource.blockedAppEvents.posts, loggerRetries ? 24
                : scenario === "bootstrap-ancillary-budget" ? 7 : d6Direct ? 5 : 6);
            assert.equal(content.nativeSource.blockedAppEvents.posts, content.nativeSource.blockedAppEvents.acknowledged);
            assert.equal(content.nativeSource.blockedAppEvents.posts, content.nativeSource.blockedAppEvents.failedPosts);
            assert.equal(content.nativeSource.blockedChatActions.posts, 1);
            assert.equal(content.nativeSource.blockedChatActions.failedPosts, 1);
            assert.equal(content.nativeSource.localImages.completed, 1);
            assert.ok(content.nativeSource.presentationTransport.networkFailed >= 3);
            if (!loggerRetries) {
                assert.ok(content.nativeSource.nativeHealthPingFailures.loggerInit >= 1);
                assert.ok(content.nativeSource.nativeHealthPingFailures.mainLoad >= 1);
                assert.ok(content.nativeSource.workerPreflight.networkFailed >= 1);
            }
        }
    }
    if (scenario === "bootstrap-local-image") {
        assert.deepEqual(localImageEvents.map(row => row.event), ["request", "cache", "response", "finished"]);
        assert.deepEqual(localImageEvents[0], { event: "request", type: "Image", method: "GET", loaderMatched: true, initiator: "parser" });
        assert.deepEqual(localImageEvents[2], { event: "response", type: "Image", status: 200, mime: "image/gif",
            frameMatched: true, loaderMatched: true, embedded: true, disk: false, prefetch: false, worker: false });
        const content = settlements.find(row => row.purpose === "content");
        assert.deepEqual(content.nativeSource.localImages,
            { completed: 1, sourceQualified: false, disposition: "embedded-image-no-network-authority" });
        assert.equal(content.sourceComparison.status, "matched");
        assert.equal(settlements.find(row => row.purpose === "identity").nativeSource.localImages, undefined);
        assert.ok(content.beforeCleanup.requests.every(row => row.kind !== "image"),
            "An embedded image supplies no history or identity evidence.");
    }
    if (membershipSSR && !backgroundBootstrap) {
        const status = await host.access.nativePersistenceStatus({}, admission), source = status.backfill.sources[0];
        const qualified = !["chat-ssr-unqualified-pins", "chat-ssr-marker-unknown", "chat-ssr-reset", "chat-ssr-reset-first"].includes(scenario);
        assert.equal(status.backfill.state, qualified ? "covered" : "unqualified");
        assert.equal(source.startQualified, qualified);
        assert.equal(source.eligible, chatIds.length);
        assert.equal(source.handled, chatIds.length);
        assert.deepEqual(historyReads.map(row => row.id).sort(), [...chatIds].sort());
        assert.equal(calls.some(row => row.path.endsWith(nativeHistoryProducer.chatRpcId)), membershipPaging || scenario.startsWith("chat-ssr-reset"));
        const state = await loadBoardState(fixture.context);
        assert.equal(state.nativeRetention.backfill[0].sources[0].observation.association.chatRequestBasis,
            scenario === "chat-ssr-reset-first" ? "empty-reset-shape" : "ssr-initializer");
        assert.doesNotMatch(JSON.stringify(state), /PRIVATE_MIXED_HISTORY/);
        const guard = await host.access.read(owner);
        try {
            const views = host.access.nativeRetainedFor(guard, { check() {} });
            const frame = await views.query({ schemaVersion: 1, revision: null, sources: ["microsoft-365-chat"],
                analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 10, after: null } });
            assert.equal(frame.aggregates.conversations, chatIds.length);
        } finally { guard.release(); }
        await host.close();
        return;
    }
    if (bootstrapContext) {
        assert.equal(bootstrapContextReads, scenario === "bootstrap-context-chat" ? 1 : 0,
            "The existing Chat context read requires explicit Chat authority, including during first collection bootstrap.");
        assert.doesNotMatch(JSON.stringify(await loadBoardState(fixture.context)), /PRIVATE_CONTEXT_RESPONSE/);
        await host.close();
        return;
    }
    if (coworkMembership) {
        if (scenario === "cowork-membership-carry") {
            assert.equal(historyReads.length, 0, "A pending native cursor keeps its owned view instead of publishing a prefix as complete.");
            assert.equal(membershipRequests.length, 15, "The interactive page shares the per-cycle list budget.");
            collectionRound = 2;
            assert.equal((await host.access.collectNativeNow({ operationId: randomUUID() }, admission)).status, "committed");
            assert.deepEqual(membershipRequests, Array.from({ length: 18 }, (_, index) => ({
                population: "scheduled_run", cursor: index === 0 ? null : String(index),
            })), "Continuation uses the remaining original native cursor, without restarting its first page.");
            assert.equal(calls.filter(row => row.path === "/v1/automations").length, 1);
            assert.equal(historyReads.filter(row => row.surface === "cowork").length, 8);
            const progress = (await host.access.nativePersistenceStatus({}, admission)).backfill.sources.find(row => row.surface === "cowork");
            assert.ok(progress.pending > 0);
            assert.equal(progress.exhausted, false);
            await host.close();
            return;
        }
        const ids = historyReads.filter(row => row.surface === "cowork").map(row => row.id);
        assert.deepEqual(ids.toSorted(), [...(backgroundBootstrap ? taskIds : [taskId]), "scheduled-live", "log-only:run",
            ...(scenario === "cowork-membership-stalled" ? [] : ["other-parent-live"]),
            ...(scenario === "cowork-membership-unavailable" ? [] : ["event-live"])].toSorted());
        assert.equal(new Set(ids).size, ids.length, "Overlapping parent/log/run membership reads each original history once.");
        const status = await host.access.nativePersistenceStatus({}, admission);
        const progress = status.backfill.sources.find(row => row.surface === "cowork");
        assert.equal(progress.startQualified, false);
        assert.equal(progress.exhausted, false, "Native recent logs cannot establish the complete historical run population.");
        assert.ok(progress.stops.includes("membership-unqualified"));
        assert.equal(progress.handled, ids.length, "A log-only history becomes in-window only through its original activity dates.");
        const state = await loadBoardState(fixture.context);
        if (backgroundBootstrap) {
            assert.ok(settlements.filter(row => row.purpose === "identity" || row.purpose === "content")
                .every(row => row.nativeSource.bootstrapBranch === (startupCleanup && row.purpose === "identity" ? "tanstack" : "background-loader")));
            assert.deepEqual(historyReads.filter(row => row.surface === "chat" && row.round === 1).map(row => row.id).sort(),
                [...chatIds].sort(), "Original background SSR and pin membership reach the shared writer alongside Cowork.");
            const chatProgress = status.backfill.sources.find(row => row.surface === "chat");
            assert.equal(chatProgress.startQualified, true);
            assert.equal(chatProgress.handled, chatIds.length);
            assert.equal(calls.filter(row => row.path.endsWith(nativeHistoryProducer.bootstrapRpcId)).length, startupCleanup ? 1 : 0,
                "No bootstrap RPC supplies a hidden substitute for either Connect or first-Enable proof.");
        }
        assert.doesNotMatch(JSON.stringify(state), /PRIVATE_CALLBACK|PRIVATE_SECRET|PRIVATE_PARENT_ERROR|FAKE_UI_ORDINAL|2099-01-01/);
        const guard = await host.access.read(owner);
        try {
            const views = host.access.nativeRetainedFor(guard, { check() {} });
            const frame = await views.query({ schemaVersion: 1, revision: null, sources: ["microsoft-365-cowork"],
                analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 10, after: null } });
            assert.equal(frame.aggregates.conversations, ids.length);
            for (const item of frame.page.items) {
                const detail = await views.detail({ schemaVersion: 1, revision: frame.revision, sources: ["microsoft-365-cowork"],
                    conversationId: item.id, page: { limit: 10, after: null } });
                assert.match(JSON.stringify(detail), /Current Cowork activity/);
                assert.ok(detail.page.items.filter(row => row.fields.message).every(row =>
                    row.fields.observationTime.unit === "epoch-ms" && row.fields.observationTime.basis === "cowork.data.ts"));
            }
        } finally { guard.release(); }
        collectionRound = 2;
        const next = await host.access.collectNativeNow({ operationId: randomUUID() }, admission);
        assert.equal(next.status, "committed");
        assert.ok(next.changes.addedVariants > 0);
        const later = historyReads.filter(row => row.surface === "cowork" && row.round === 2).map(row => row.id);
        assert.deepEqual(later.toSorted(), ["log-only:run", ...(scenario === "cowork-membership-unavailable" ? [] : ["event-live"])].toSorted());
        await host.close();
        return;
    }
    if (scenario === "bootstrap-excluded-action") {
        assert.deepEqual(settlements.find(row => row.purpose === "content").nativeSource.blockedChatActions,
            { posts: 1, preflights: 0, acknowledged: 1, failedPosts: 1, failedPreflights: 0, disposition: "denied-different-action" });
    }
    if (taskRows) {
        const cow = () => host.access.nativePersistenceStatus({}, admission).then(status =>
            status.backfill.sources.find(row => row.surface === "cowork"));
        const first = await cow();
        assert.equal(first.handled, 3);
        assert.equal(first.pending, 0, "Source-qualified native task navigation does not reload discovery between each history.");
        assert.equal(calls.filter(row => row.path === "/v1/routing").length, 1);
        const read = async expected => {
            const guard = await host.access.read(owner);
            try {
                const views = host.access.nativeRetainedFor(guard, { check() {} }), sources = ["microsoft-365-cowork"];
                const frame = await views.query({ schemaVersion: 1, revision: null, sources,
                    analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 10, after: null } });
                assert.equal(frame.aggregates.conversations, expected);
                const details = await Promise.all(frame.page.items.map(item => views.detail({ schemaVersion: 1,
                    revision: frame.revision, sources, conversationId: item.id, page: { limit: 10, after: null } })));
                assert.ok(details.every(detail => JSON.stringify(detail).includes("current-event-2")));
            } finally { guard.release(); }
        };
        await read(3);
        collectionRound = 2;
        assert.equal((await host.access.collectNativeNow({ operationId: randomUUID() }, admission)).status, "committed");
        await read(3);
        assert.equal((await cow()).pending, 0);
        assert.equal((await cow()).startQualified, false, "UI traversal cannot qualify complete source membership.");
        const detailReads = calls.filter(row => row.path.endsWith("/detail")).length;
        collectionRound = 3;
        const unchanged = await host.access.collectNativeNow({ operationId: randomUUID() }, admission);
        assert.equal(unchanged.status, "committed");
        assert.equal(unchanged.changes.addedObservations, 0);
        assert.equal(calls.filter(row => row.path.endsWith("/detail")).length, detailReads);
        await host.close();
        return;
    }
    if (transientRead) {
        assert.equal(failedReadReplies, 1);
        assert.equal((await loadBoardState(fixture.context)).nativeRetention.receipts.length, 1,
            "Recovery stays before publication inside the original collection operation; no unknown operation is replayed.");
        assert.equal(settlements.filter(row => row.commitState === "not-published").length, 1,
            JSON.stringify(settlements.map(row => ({ purpose: row.purpose, commitState: row.commitState }))));
    }
    if (scenario === "success") {
        const checkpoint = (await loadBoardState(fixture.context)).nativeRetention.backfill[0];
        assert.ok(checkpoint.sources.every(row => row.observation.view.region === "unobserved" && row.startQualified === false),
            "A matching native route cannot manufacture a missing history/filter region.");
    }

    if (mixedFairness || completedLive) {
        const first = (await host.access.nativePersistenceStatus({}, admission)).backfill;
        if (completedLive) {
            assert.equal(first.sources.find(row => row.surface === "chat").handled, 1);
            assert.ok(first.sources.find(row => row.surface === "cowork").pending > 0);
            chatIds.push("99999999-9999-4999-8999-999999999999");
        }
        collectionRound = 2;
        assert.equal((await host.access.collectNativeNow({ operationId: randomUUID() }, admission)).status, "committed");
        for (const [surface, ids] of [["chat", chatIds], ["cowork", taskIds]]) {
            const reads = historyReads.filter(row => row.surface === surface && row.round === 2);
            if (mixedFairness) {
                assert.equal(reads.filter(row => ids.slice(0, 8).includes(row.id)).length, 4,
                    surface + " changed histories must receive their reserved half of a mixed batch.");
                assert.equal(reads.filter(row => !ids.slice(0, 8).includes(row.id)).length, 4);
            } else if (surface === "chat") {
                assert.ok(reads.some(row => row.id === chatId), "Completed Chat must poll updates while Cowork remains pending.");
                assert.ok(reads.some(row => row.id === chatIds.at(-1)), "Completed Chat must discover new histories.");
            }
        }
        const next = (await host.access.nativePersistenceStatus({}, admission)).backfill;
        assert.deepEqual(next.window, first.window);
        assert.ok(next.sources.find(row => row.surface === "cowork").pending > 0);
        const guard = await host.access.read(owner), views = host.access.nativeRetainedFor(guard, { check() {} });
        const frame = await views.query({ schemaVersion: 1, revision: null, sources: ["microsoft-365-chat", "microsoft-365-cowork"],
            analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 30, after: null } });
        assert.equal(frame.aggregates.conversations, mixedFairness ? 24 : 18);
        guard.release();
        await host.close();
        return;
    }
    if (budgetYield) {
        const first = (await host.access.nativePersistenceStatus({}, admission)).backfill;
        const handled = first.sources.find(row => row.surface === "cowork").handled;
        if (timeYield) assert.ok(handled > 0 && handled <= 8);
        else assert.equal(handled, 1);
        assert.equal(first.sources.find(row => row.surface === "chat").pages, 0);
        assert.ok(first.sources.find(row => row.surface === "chat").stops.includes(scenario === "time-yield" ? "time-budget" : "byte-budget"));
        let next;
        for (collectionRound = 2; collectionRound <= (timeYield ? 5 : 2); collectionRound++) {
            assert.equal((await host.access.collectNativeNow({ operationId: randomUUID() }, admission)).status, "committed");
            next = (await host.access.nativePersistenceStatus({}, admission)).backfill;
            assert.deepEqual(next.window, first.window);
            if (next.sources.every(row => row.exhausted && row.pending === 0)) break;
        }
        assert.ok(next.sources.every(row => row.exhausted && row.handled === (timeYield ? 16 : 1) && row.pending === 0));
        assert.equal(next.state, "unqualified");
        await host.close();
        return;
    }
    if (longDiscovery) {
        let summary = (await host.access.nativePersistenceStatus({}, admission)).backfill;
        assert.equal(summary.state, "progressing");
        assert.ok(summary.sources.every(source => source.pages === 16 && !source.exhausted && source.handled === 8 && source.pending === 8));
        const fixedWindow = structuredClone(summary.window);
        for (collectionRound = 2; collectionRound <= (lostDiscovery ? 3 : deepDiscovery ? 8 : 14); collectionRound++) {
            assert.equal((await host.access.collectNativeNow({ operationId: randomUUID() }, admission)).status, "committed");
            summary = (await host.access.nativePersistenceStatus({}, admission)).backfill;
            if (hotDiscovery) t.diagnostic(JSON.stringify({ round: collectionRound, sources: summary.sources.map(source => ({
                surface: source.surface, exhausted: source.exhausted, handled: source.handled, pending: source.pending, chainPages: source.chainPages,
            })) }));
            assert.deepEqual(summary.window, fixedWindow);
            if (summary.sources.every(source => deepDiscovery ? source.chainPages === 49 : source.exhausted && source.pending === 0)) break;
        }
        assert.doesNotMatch(JSON.stringify((await loadBoardState(fixture.context)).nativeRetention.backfill), /fixture-page-|PRIVATE_LIST|PRIVATE_TASK/);
        if (deepDiscovery) {
            assert.ok(summary.sources.every(source => source.chainPages === 49 && source.exhausted && source.eligible === 49),
                "Three capped segments must retain the actual original page through page49 despite hot-history competition.");
            assert.ok(summary.sources.every(source => source.handled > 0 && source.pending > 0 && !source.startQualified));
            assert.equal(summary.state, "progressing");
            await host.close();
            return;
        }
        if (lostDiscovery) {
            const before = structuredClone((await loadBoardState(fixture.context)).nativeRetention.backfill);
            const original = rootProtocol.send.bind(rootProtocol);
            t.mock.method(rootProtocol, "send", async (method, input) => {
                const result = await original(method, input);
                if (method === "Page.getFrameTree") result.frameTree.frame.loaderId = "changed-native-document";
                return result;
            });
            await assert.rejects(host.access.collectNativeNow({ operationId: randomUUID() }, admission),
                { code: "NATIVE_APP_DOCUMENT_CONTINUITY_UNQUALIFIED" });
            const stopped = (await loadBoardState(fixture.context)).nativeRetention.backfill;
            assert.deepEqual(stopped.map(row => row.window), before.map(row => row.window));
            assert.deepEqual(stopped[0].sources.map(row => row.histories), before[0].sources.map(row => row.histories));
            assert.ok(stopped[0].sources.every(row => row.stops.includes("continuity-lost") && !row.startQualified));
            await host.close();
            return;
        }
        assert.ok(summary.sources.every(source => (hotDiscovery ? source.pages >= 17 : source.pages === 17) && source.chainPages === 17 && source.exhausted
            && source.eligible === 17 && source.handled === 17 && source.pending === 0 && source.unreadable === 0));
        assert.ok(summary.sources.every(source => source.controlObserved && source.initial !== "unobserved" && !source.startQualified));
        assert.equal(summary.state, "unqualified", "Native suffix/first-page semantics are not qualified by this offline fixture.");
        assert.ok(summary.sources.every(source => source.stops.includes("page-budget")));
        const guard = await host.access.read(owner), views = host.access.nativeRetainedFor(guard, { check() {} });
        const frame = await views.query({ schemaVersion: 1, revision: null,
            sources: ["microsoft-365-chat", "microsoft-365-cowork"],
            analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 10, after: null } });
        assert.equal(frame.aggregates.conversations, 34);
        guard.release();
        await host.close();
        return;
    }
    if (deletedPrefix) {
        assert.equal(receipt.changes.suppressedObservations, 24);
        assert.equal(receipt.changes.addedObservations, 0);
    }
    const guard = await host.access.read(owner);
    const views = host.access.nativeRetainedFor(guard, { check() {} });
    const sources = ["microsoft-365-chat", "microsoft-365-cowork"];
    const frame = await views.query({ schemaVersion: 1, revision: null, sources,
        analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 10, after: null } });
    assert.equal(frame.aggregates.conversations, emptyHistory || deletedPrefix ? 0
        : ["outside-window", "cowork-outside-window"].includes(scenario) ? 1
        : boundedBackfill ? 16 : pagedHistories ? 6 : multipleHistories ? 4 : 2);
    const details = await Promise.all(frame.page.items.map(item => views.detail({ schemaVersion: 1,
        revision: frame.revision, sources, conversationId: item.id, page: { limit: 10, after: null } })));
    if (scenario === "bootstrap-local-image" || automaticEnable) {
        assert.deepEqual(details.map(detail => detail.sourceId).sort(), ["microsoft-365-chat", "microsoft-365-cowork"]);
    }
    if (olderPages) {
        let detail = details.find(row => row.sourceId === "microsoft-365-cowork");
        const items = [...detail.page.items];
        while (detail.page.nextCursor) {
            detail = await views.detail({ schemaVersion: 1, revision: frame.revision, sources,
                conversationId: detail.conversationId, page: { limit: 10, after: detail.page.nextCursor } });
            items.push(...detail.page.items);
        }
        const messages = items.filter(row => row.fields.message);
        assert.equal(messages.length, 101, "The 100-frame cold-open prefix is not the complete retained history.");
        assert.equal(messages.filter(row => row.fields.message.value.text === "Last Cowork history page").length, 1);
        assert.ok(messages.every(row => row.fields.observationTime.unit === "epoch-ms"
            && row.fields.observationTime.basis === "cowork.data.ts"));
        assert.equal(calls.filter(row => row.path.endsWith("/messages")).length, 3);
        assert.equal((await host.access.nativePersistenceStatus({}, admission)).backfill.sources
            .find(row => row.surface === "cowork").pending, 0);
    }
    const retained = JSON.stringify(details);
    guard.release();
    if (!emptyHistory && !deletedPrefix) {
        if (scenario !== "outside-window") assert.match(retained, /Current Chat activity/);
        if (scenario !== "cowork-outside-window") assert.match(retained, /Current Cowork activity/);
        else assert.equal(details.some(detail => detail.sourceId === "microsoft-365-cowork"), false,
            "An undated detail snapshot alone must not create in-window activity.");
    }
    if (loggerRetries) {
        await host.close();
        const saved = await loadBoardState(fixture.context);
        assert.equal(saved.nativeRetention.receipts[0].status, "committed");
        assert.equal(saved.nativeRetention.receipts[0].firstFailure, undefined);
        return;
    }
    if (snapshotContext) {
        const detail = details.find(row => row.sourceId === "microsoft-365-cowork");
        const snapshots = detail.page.items.filter(row => row.outcomes.task);
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0].outcomes.task.state, "running");
        assert.equal(snapshots[0].outcomes.task.aggregateToolSuccess, false);
        assert.equal(snapshots[0].fields.model.value, "invented-model-one");
        assert.equal(snapshots[0].fields.model.scope, "snapshot");
        assert.equal(snapshots[0].fields.observationTime, undefined);
        assert.deepEqual(snapshots[0].callSummaries, []);
        assert.equal(frame.aggregates.calls, 0);
        assert.equal((await host.access.nativePersistenceStatus({}, admission)).backfill.sources
            .find(row => row.surface === "cowork").pending, 1, "An explicitly running history stays queued even when its recency hint is unchanged.");
        const checkpoint = (await loadBoardState(fixture.context)).nativeRetention.backfill[0];
        const restored = createNativeBackfill(checkpoint.accountRef, checkpoint.windowDays, ["chat", "cowork"],
            checkpoint.privacyRevision, JSON.parse(JSON.stringify(checkpoint)), Date.now(), checkpoint.deletionVersion);
        assert.deepEqual(restored.sources.find(row => row.surface === "cowork").histories,
            checkpoint.sources.find(row => row.surface === "cowork").histories);
    }
    if (matchedCowork && !olderPages && !eventFeed) {
        const detail = details.find(row => row.sourceId === "microsoft-365-cowork");
        const messages = detail.page.items.filter(row => row.fields.message).map(row => row.fields.message.value);
        assert.deepEqual(messages.map(row => [row.author, row.text]).sort(),
            [["assistant", "Current Cowork assistant text"],
                ...Array.from({ length: pagedHistories ? 3 : 1 }, () => ["user", "Current Cowork activity"])]);
        assert.ok(detail.page.items.filter(row => row.fields.message).every(row => Object.keys(row.outcomes).length === 0));
        assert.ok(detail.page.items.filter(row => row.fields.message).every(row => row.fields.observationTime.unit === "epoch-ms"
            && row.fields.observationTime.basis === "cowork.data.ts"));
    }
    if (["success", "cowork-matched-authors"].includes(scenario)) {
        const detail = details.find(row => row.sourceId === "microsoft-365-cowork");
        const failed = detail.page.items.find(row => row.fields.failure);
        const returned = detail.page.items.find(row => row.callSummaries.some(call => call.tool === "native_document_fetch"));
        assert.equal(failed.fields.failure.value.diagnostic.message, "Permission [write] is required for {folder}.");
        assert.equal(returned.fields.resultEvidence.value.contentStatus, "body-excluded");
        assert.equal(returned.fields.resultEvidence.value.description?.text, matchedCowork ? "Retrieved the selected item." : undefined);
        assert.equal(returned.fields.resultEvidence.value.statusCode, null);
        assert.equal(returned.callSummaries[0].outcome, "success");
        assert.equal(failed.callSummaries[0].outcome, "failure");
        assert.doesNotMatch(retained, /PRIVATE_NATIVE_RESULT_BODY/);
    }
    if (pagedHistories) {
        assert.match(retained, /current-event-2/);
        assert.equal(calls.filter(row => row.path.endsWith("/messages")).length, 9);
    }
    assert.doesNotMatch(retained, /PRIVATE_OLDER|PRIVATE_CACHED|PRIVATE_LIST_TITLE|PRIVATE_TASK_TITLE|PRIVATE_BOOTSTRAP_TEXT|PRIVATE_DEVICE|PRIVATE_CONTEXT_RESPONSE/);
    const chatListRequests = calls.filter(row => row.path.endsWith(nativeHistoryProducer.chatRpcId)).length;
    assert.equal(chatListRequests, contextRead ? 2 : chatInitializer ? 6 : boundedBackfill ? 8 : pagedHistories ? 9 : multipleHistories ? 2 : 1);
    if (chatInitializer) assert.equal(calls.filter(row => row.path.endsWith(nativeHistoryProducer.chatInitializerRpcId)).length, 3);
    assert.equal(calls.filter(row => row.path === "/v1/tasks/live").length, transientRead ? 2 : pagedHistories ? 3 : 1);
    assert.equal(calls.filter(row => row.method === "POST" && !row.path.endsWith(nativeHistoryProducer.chatRpcId)).length,
        0);
    collectionRound = 2;
    const backfillWindow = liveBackfill ? (await host.access.nativePersistenceStatus({}, admission)).backfill.window : null;
    if (liveBackfill) liveUpdateAt = Date.now();
    let repeated;
    try { repeated = await host.access.collectNativeNow({ operationId: randomUUID() }, admission); }
    catch (error) {
        if (!bootstrapAncillary) throw error;
        const state = await loadBoardState(fixture.context);
        assert.fail(JSON.stringify({ code: error.code, priorStatus: state.nativeRetention.receipts[0].status,
            firstFailure: state.nativeRetention.receipts.at(-1).firstFailure }));
    }
    assert.equal(repeated.status, "committed", "A new confirmed operation gets a new bounded scope, not a permanent one-use connection.");
    if (bootstrapAncillary) {
        const later = settlements.filter(row => row.purpose === "content")[1];
        const laterPosts = scenario === "bootstrap-ancillary-budget" ? 5 : d6Direct ? 2 : 4;
        assert.deepEqual(later.nativeSource.blockedAppEvents, {
            role: "reviewed-app-logger", posts: laterPosts, acknowledged: laterPosts,
            failedPosts: laterPosts, disposition: "denied-not-contacted",
        });
        const retainedGuard = await host.access.read(owner);
        try {
            const retainedViews = host.access.nativeRetainedFor(retainedGuard, { check() {} });
            const laterFrame = await retainedViews.query({ schemaVersion: 1, revision: null, sources,
                analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 10, after: null } });
            assert.deepEqual(laterFrame.page.items.map(row => row.id).sort(), frame.page.items.map(row => row.id).sort());
        } finally { retainedGuard.release(); }
    }
    if (scenario === "incremental-history" || boundedBackfill || snapshotContext) {
        const guard = await host.access.read(owner), views = host.access.nativeRetainedFor(guard, { check() {} });
        const frame = await views.query({ schemaVersion: 1, revision: null, sources,
            analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: liveBackfill ? 30 : 10, after: null } });
        const details = await Promise.all(frame.page.items.map(item => views.detail({ schemaVersion: 1,
            revision: frame.revision, sources, conversationId: item.id, page: { limit: 10, after: null } })));
        if (!boundedBackfill && !snapshotContext) {
            assert.match(JSON.stringify(details), /Later Chat activity/);
            assert.match(JSON.stringify(details), /Later Cowork activity/);
        }
        if (snapshotContext) {
            const snapshots = details.find(row => row.sourceId === "microsoft-365-cowork").page.items.filter(row => row.outcomes.task);
            assert.deepEqual(snapshots.map(row => row.outcomes.task.state).sort(), ["completed", "running"]);
            assert.deepEqual(snapshots.map(row => row.fields.model.value).sort(), ["invented-model-one", "invented-model-two"]);
            assert.ok(snapshots.every(row => row.fields.observationTime === undefined && row.fields.model.scope === "snapshot"));
            assert.equal(repeated.changes.addedObservations, 0, "A new snapshot variant does not duplicate its native identity or the original message.");
            assert.equal(repeated.changes.addedVariants, 1);
            assert.equal((await host.access.nativePersistenceStatus({}, admission)).backfill.sources
                .find(row => row.surface === "cowork").pending, 0);
        }
        assert.equal(frame.aggregates.conversations, deletedPrefix ? 4 : changedCold ? 18 : boundedBackfill ? 20 : 2);
        if (liveBackfill) {
            assert.deepEqual((await host.access.nativePersistenceStatus({}, admission)).backfill.window, backfillWindow);
            assert.ok(liveUpdateAt > Date.parse(backfillWindow.to));
            assert.match(JSON.stringify(details), /After cutoff Chat activity/);
            assert.match(JSON.stringify(details), /After cutoff Cowork activity/);
        }
        if (deletedPrefix) {
            assert.equal(repeated.changes.suppressedObservations, 0);
            assert.equal(repeated.changes.addedObservations, 6);
        }
        guard.release();
    }
    if (changedCold) {
        for (collectionRound = 3; collectionRound <= 4; collectionRound++) {
            assert.equal((await host.access.collectNativeNow({ operationId: randomUUID() }, admission)).status, "committed");
        }
        const guard = await host.access.read(owner), views = host.access.nativeRetainedFor(guard, { check() {} });
        const frame = await views.query({ schemaVersion: 1, revision: null, sources,
            analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 30, after: null } });
        const details = await Promise.all(frame.page.items.map(item => views.detail({ schemaVersion: 1,
            revision: frame.revision, sources, conversationId: item.id, page: { limit: 10, after: null } })));
        assert.equal(frame.aggregates.conversations, 18);
        assert.ok(JSON.stringify(details).includes("Cold Chat update"), "Already-collected cold Chat must not starve behind hot changed histories.");
        assert.ok(JSON.stringify(details).includes("Cold Cowork update"), "Already-collected cold Cowork must not starve behind hot changed histories.");
        guard.release();
    }

    await host.close();
    await assert.rejects(stat(configuration.ownerLockPath), { code: "ENOENT" });
});

test("native host initializes an empty private store without connecting a source", async t => {
    const fixture = await configurationFixture(t);
    const context = { ...fixture.context, dataDir: path.join(fixture.root, "fresh-native-data") };
    const host = await fixture.start(null, context);
    assert.equal((await host.access.status()).wire, "signed-out");
    assert.equal((await host.access.status()).collection, "paused");
    assert.equal(await readNativeCollectionSettings(context), null);
    await assert.rejects(stat(fixture.config.profileDirectory), { code: "ENOENT" });
});

test("native host configuration is a bounded historical expectation, not identity or source authority", async t => {
    const fixture = await configurationFixture(t);
    const configuration = await readMicrosoftNativeConfiguration(fixture.file);
    assert.equal(isMicrosoftNativeConfiguration(configuration), true);
    assert.equal(isMicrosoftNativeConfiguration({ ...configuration }), false);
    assert.equal(Object.isFrozen(configuration.target), true);
    const host = await fixture.start(configuration);
    const status = await host.access.status();
    assert.equal(status.wire, "signed-out");
    assert.equal(status.collection, "paused");
    assert.deepEqual(status.microsoft, { state: "disconnected", reason: null, actions: [] });
    assert.equal(await readNativeCollectionSettings(fixture.context), null, "Startup must not configure native collection.");
    await assert.rejects(stat(fixture.config.profileDirectory), { code: "ENOENT" });
    await assert.rejects(stat(fixture.config.ownerLockPath), { code: "ENOENT" });
});

test("development launcher selects explicit Microsoft modes without connecting or adopting saved configuration", async t => {
    const fixture = await configurationFixture(t);
    const script = fileURLToPath(new URL("../scripts/start.mjs", import.meta.url));
    const boardFile = path.join(fixture.context.dataDir, `${BOARD_ID}.state.json`), before = await readFile(boardFile);
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    const savedConfiguration = path.join(fixture.context.dataDir, "microsoft-source.json");
    await writeFile(savedConfiguration, "NOT_VALID_CONFIGURATION_JSON");
    for (const mode of ["native", "account-only", "retained", "native-history"]) {
        const retained = mode === "retained", accountOnly = mode === "account-only";
        if (mode === "native-history") await writeFile(fixture.file, JSON.stringify({
            schemaVersion: 2, expectedAccount: fixture.target.expectedAccount,
            profileDirectory: fixture.config.profileDirectory, profileOwnerSessionId: fixture.config.profileOwnerSessionId,
            ownerLockPath: fixture.config.ownerLockPath,
        }));
        const child = fork(script, ["--port", "0", "--development-microsoft", ...(retained ? ["--microsoft-retained"]
            : ["--microsoft-config", fixture.file, ...(accountOnly ? ["--microsoft-account-only"] : [])])], {
            env: { ...environment, WORKIQ_EVIDENCE_DATA_DIR: fixture.context.dataDir }, execArgv: [],
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        const exited = new Promise(resolve => child.once("exit", code => resolve(code)));
        let readyTimer, output = "";
        const ready = new Promise((resolve, reject) => {
            readyTimer = setTimeout(() => reject(new Error("Normal launcher readiness timed out.")), 10000);
            child.once("error", reject);
            child.once("exit", () => reject(new Error("Normal launcher exited before readiness.")));
            child.stderr.once("data", chunk => reject(new Error("Normal launcher startup failed: " + chunk)));
            child.stdout.on("data", chunk => {
                output += chunk;
                const found = /ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
                if (found) resolve(found[1]);
            });
        });
        let exitCode;
        try {
            const url = await ready, origin = new URL(url).origin;
            const session = await fetch(origin + "/api/session", { method: "POST",
                headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" }, body: "{}" }).then(response => response.json());
            assert.equal(session.accessBootstrap.mode, "enforced");
            assert.equal(session.accessBootstrap.collectionMode, accountOnly || retained || mode === "native-history" ? "source-aware" : undefined);
            const status = await fetch(origin + "/api/access/status", {
                headers: { Origin: origin, "X-Board-Capability": session.capability },
            }).then(response => response.json());
            assert.equal(status.wire, "signed-out");
            assert.equal(status.collection, "paused");
            if (retained) {
                assert.equal(Object.hasOwn(status, "microsoft"), false);
                assert.equal(status.actions.some(action => action.startsWith("microsoft-")), false);
            } else assert.equal(status.microsoft.state, "disconnected");
            assert.deepEqual(await readFile(boardFile), before);
            assert.equal(await readFile(savedConfiguration, "utf8"), "NOT_VALID_CONFIGURATION_JSON");
            await assert.rejects(stat(fixture.config.profileDirectory), { code: "ENOENT" });
            await assert.rejects(stat(fixture.config.ownerLockPath), { code: "ENOENT" });
        } finally {
            clearTimeout(readyTimer);
            if (child.connected) child.disconnect();
            const killTimer = setTimeout(() => child.kill(), 5000);
            try { exitCode = await exited; } finally { clearTimeout(killTimer); }
        }
        assert.equal(exitCode, 0);
    }
});

test("launcher rejects Microsoft flags without development opt-in and rejects conflicting development arguments", async t => {
    const fixture = await configurationFixture(t);
    const script = fileURLToPath(new URL("../scripts/start.mjs", import.meta.url));
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    await writeFile(path.join(fixture.context.dataDir, "microsoft-source.json"), await readFile(fixture.file));
    for (const args of [
        ["--development-microsoft", "--development-microsoft"],
        ["--microsoft-account-only"],
        ["--microsoft-account-only", "--microsoft-config", fixture.file, "--microsoft-retained"],
        ["--microsoft-account-only", "--microsoft-account-only", "--microsoft-config", fixture.file],
        ["--microsoft-visible-sign-in"],
        ["--microsoft-visible-sign-in", "--microsoft-config", fixture.file, "--microsoft-account-only"],
        ["--microsoft-visible-sign-in", "--microsoft-visible-sign-in", "--microsoft-config", fixture.file],
        ["--microsoft-visibility-experiment"],
        ["--microsoft-visibility-experiment", "--microsoft-visible-sign-in", "--microsoft-config", fixture.file],
        ["--microsoft-manual-collection", "--microsoft-manual-collection"],
        ["--microsoft-manual-collection", "false"],
        ["--microsoft-manual-collection", "--microsoft-retained"],
        ["--microsoft-manual-collection", "--microsoft-account-only", "--microsoft-config", fixture.file],
        ["--microsoft-manual-collection", "--microsoft-visibility-experiment", "--microsoft-config", fixture.file],
    ]) {
        for (const prefix of [[], ["--development-microsoft"]]) {
            await assert.rejects(promisify(execFile)(process.execPath, [script, "--port", "0", ...prefix, ...args], {
                env: { ...environment, WORKIQ_EVIDENCE_DATA_DIR: fixture.context.dataDir }, timeout: 10000,
            }), error => error.code === 1 && error.stderr.includes("Use npm start --"));
        }
    }
    await assert.rejects(stat(path.join(fixture.context.dataDir, "microsoft-session")), { code: "ENOENT" });
    await assert.rejects(stat(fixture.config.profileDirectory), { code: "ENOENT" });
});

test("normal manual-collection launcher refuses a selected-ID legacy configuration before browser ownership", async t => {
    const fixture = await configurationFixture(t);
    await assert.rejects(promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("../scripts/start.mjs", import.meta.url)), "--port", "0",
        "--development-microsoft", "--microsoft-manual-collection", "--microsoft-config", fixture.file,
    ], { env: { ...process.env, WORKIQ_EVIDENCE_DATA_DIR: fixture.context.dataDir }, timeout: 10000 }),
    error => error.code === 1);
    await assert.rejects(stat(fixture.config.profileDirectory), { code: "ENOENT" });
    await assert.rejects(stat(fixture.config.ownerLockPath), { code: "ENOENT" });
    assert.equal(await readNativeCollectionSettings(fixture.context), null);
});

test("explicit source-aware host restores UNSET and committed global policy without source enrollment or acquisition", async t => {
    const fixture = await configurationFixture(t), context = fixture.context;
    const release = await acquireCollectorLock(context.dataDir);
    const boardFile = path.join(context.dataDir, `${BOARD_ID}.state.json`);
    try {
        const before = await readFile(boardFile);
        let host = await fixture.start(null, context, true);
        assert.equal(host.access.sourceAware, true);
        assert.deepEqual(await readFile(boardFile), before);
        const admission = { owner: "source-aware-host-test-owner", check() {}, dispatched() {} };
        const signIn = await host.access.command(admission.owner, {
            schemaVersion: 1, action: "wire-sign-in", operationId: randomUUID(),
            generation: (await host.access.status()).generation,
        }, () => true);
        assert.equal(signIn.outcome, "completed");
        const control = await host.access.globalCollectionControl(admission);
        assert.equal(control.globalCollection, null);
        const offer = await host.access.nativeConfigurationOffer(admission);
        assert.equal(offer.schemaVersion, 2);
        assert.equal(offer.globalRevision, null);
        assert.equal(offer.available, false);
        assert.equal((await host.access.nativePersistenceStatus({}, admission)).kind, "native-account-unavailable");
        await host.access.setGlobalCollectionEnabled({
            schemaVersion: 1, enabled: false, generation: control.generation,
            authorizationRevision: control.authorizationRevision, expectedRevision: null,
        }, admission);
        assert.deepEqual(await readGlobalCollectionGate(context), { revision: 1, paused: true });
        assert.equal(await readNativeCollectionSettings(context), null);
        assert.equal((await loadBoardState(context)).stateVersion, 6);
        const saved = await readFile(boardFile);
        await assert.rejects(host.access.collectNativeNow({ operationId: randomUUID() }, admission),
            { code: "wire_access_native_writer_unqualified", status: 503 });
        assert.deepEqual(await readFile(boardFile), saved);
        await host.close();
        host = await fixture.start(null, context, true);
        assert.deepEqual(await readFile(boardFile), saved);
        assert.deepEqual((await host.access.globalCollectionControl(admission)).globalCollection, { revision: 1, paused: true });
        assert.equal((await host.access.nativeConfigurationOffer(admission)).globalRevision, 1);
        assert.equal(await readNativeCollectionSettings(context), null);
        await host.close();
        const configuration = await readMicrosoftNativeConfiguration(fixture.file);
        host = await fixture.start(configuration, context, true);
        await assert.rejects(host.access.collectNativeNow({ operationId: randomUUID() }, admission),
            { code: "wire_access_native_writer_unqualified", status: 503 });
        assert.deepEqual(await readFile(boardFile), saved);
        await host.close();
        host = await fixture.start(configuration, context, true, true);
        assert.deepEqual((await host.access.globalCollectionControl(admission)).globalCollection, { revision: 1, paused: true });
        assert.equal((await host.access.status()).collection, "paused");
        assert.equal((await host.access.status()).microsoft.state, "disconnected");
        await assert.rejects(host.access.collectNativeNow({ operationId: randomUUID() }, admission),
            { code: "wire_access_revoked", status: 403 });
        assert.deepEqual(await readFile(boardFile), saved, "The host opt-in cannot grant consent or register a denied Collect.");
        assert.equal(await readNativeCollectionSettings(context), null);
        await assert.rejects(stat(fixture.config.profileDirectory), { code: "ENOENT" });
        await assert.rejects(stat(fixture.config.ownerLockPath), { code: "ENOENT" });
    } finally { await release(); }
});

test("changed or extra native configuration fields reject without leaking input or opening a profile", async t => {
    const fixture = await configurationFixture(t);
    const configuration = await readMicrosoftNativeConfiguration(fixture.file);
    const before = await readFile(path.join(fixture.context.dataDir, `${BOARD_ID}.state.json`));
    for (const options of [
        ...[null, 1, "true", {}].map(nativeAcquisition => ({ configuration, sourceAware: true, nativeAcquisition })),
        { configuration: null, sourceAware: true, nativeAcquisition: true },
        { configuration: { ...configuration }, sourceAware: true, nativeAcquisition: true },
        { configuration, sourceAware: false, nativeAcquisition: true },
        ...[null, 1, "true", {}].map(accountOnlyVerification => ({ configuration, sourceAware: true, accountOnlyVerification })),
        { configuration: null, sourceAware: true, accountOnlyVerification: true },
        { configuration: { ...configuration }, sourceAware: true, accountOnlyVerification: true },
        { configuration, sourceAware: false, accountOnlyVerification: true },
        { configuration, sourceAware: true, nativeAcquisition: true, accountOnlyVerification: true },
    ]) {
        await assert.rejects(async () => {
            const host = await createMicrosoftNativeHost(fixture.context, options);
            await host.close();
        }, { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
    }
    assert.deepEqual(await readFile(path.join(fixture.context.dataDir, `${BOARD_ID}.state.json`)), before);
    await writeFile(fixture.file, JSON.stringify({ ...fixture.config, targetMetadataSha256: "0".repeat(64) }));
    await assert.rejects(readMicrosoftNativeConfiguration(fixture.file), { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
    await writeFile(fixture.file, JSON.stringify({ ...fixture.config, credentials: "EXAMPLE_ONLY" }));
    await assert.rejects(readMicrosoftNativeConfiguration(fixture.file), error =>
        error.code === "NATIVE_HOST_CONFIGURATION_INVALID" && !error.message.includes("EXAMPLE_ONLY"));
    await assert.rejects(stat(fixture.config.profileDirectory), { code: "ENOENT" });
});

test("a native Connect failing before ownership needs no profile recovery and never configures collection", async t => {
    const fixture = await configurationFixture(t);
    const host = await fixture.start(await readMicrosoftNativeConfiguration(fixture.file));
    const owner = "example-native-product-owner";
    for (const action of ["wire-sign-in", "microsoft-connect"]) {
        const receipt = await host.access.command(owner, {
            schemaVersion: 1, action, operationId: randomUUID(), generation: (await host.access.status()).generation,
        }, () => true);
        assert.equal(receipt.outcome, action === "wire-sign-in" ? "completed" : "failed");
    }
    assert.equal((await host.access.status()).microsoft.state, "disconnected");
    assert.equal(await readNativeCollectionSettings(fixture.context), null);
    await assert.rejects(stat(fixture.config.ownerLockPath), { code: "ENOENT" });
    await host.close();
});

for (const scenario of ["default fields", "selected fields", "gate attachment failure", "gate closes before entry", "unexpected page",
    "shell query document", "shell XHR", "landing return POST", "route-first data block", "policy block then allowed failure",
    "self preflight", "self preflight cap", "self preflight no association", "continuation failure",
    "token post cap", "token preflight cap", "token protocol cap", "token tenant mismatch",
    "token frame mismatch", "token redirect", "token continuation failure"]) test(`account-only Connect keeps one-request and identity gates: ${scenario}`, { timeout: 60000 }, async t => {
    const tokenScenario = scenario.startsWith("token "), tokenCaps = tokenScenario && scenario.endsWith("cap");
    const tokenMismatch = scenario.endsWith("mismatch"), tokenFailure = scenario === "token continuation failure";
    const continuationFails = scenario === "continuation failure";
    const preflightScenario = scenario.startsWith("self preflight"), preflightOnlyStop = preflightScenario && scenario !== "self preflight";
    const selectedFields = scenario === "selected fields" || continuationFails || preflightScenario, attachmentFails = scenario === "gate attachment failure";
    const earlyCoverage = scenario === "gate closes before entry", unexpectedPage = scenario === "unexpected page";
    const earlyStop = earlyCoverage || unexpectedPage;
    const surfaceDenial = ["shell query document", "shell XHR", "landing return POST"].includes(scenario);
    const routeDataBlock = scenario === "route-first data block", protocolDataBlock = scenario === "policy block then allowed failure";
    const fixture = await configurationFixture(t);
    await mkdir(fixture.config.profileDirectory, { recursive: true });
    await writeFile(path.join(path.dirname(fixture.config.profileDirectory), "profile-owner.json"), JSON.stringify({
        sessionId: fixture.config.profileOwnerSessionId, profile: "profile",
    }));
    const diagnostics = [], routed = [], events = new Map(), protocolCommands = [], networkEvents = new Map();
    t.mock.method(console, "info", (...values) => diagnostics.push(values));
    let router, paused, protocolClosed, location = "about:blank", closed = false, pageClosed = false,
        launches = 0, taskNavigations = 0, tokenSequence = 0, extraClosed = 0, preflightAttempted = false;
    const app = "https://copilot.cloud.microsoft", gateway = "https://cowork.us-ia888.gateway.prod.island.powerapps.com";
    const graphSelf = "https://graph.microsoft.com/v1.0/me";
    const allowedSelf = graphSelf + (selectedFields ? "?$select=id,displayName,givenName,surname,mail,userPrincipalName,preferredLanguage,businessPhones,jobTitle,mobilePhone,officeLocation" : "");
    const tokenEndpoint = `https://login.microsoftonline.com/${fixture.target.expectedTenant}/oauth2/v2.0/token`;
    const tokenUrl = tokenEndpoint + "?client-request-id=EXAMPLE_PRIVATE_LABEL&extra=EXAMPLE_PRIVATE_LABEL&extra=unchanged";
    // Request-metadata validation inputs only; no script body is supplied or fetched.
    const assets = [
        "https://res.cdn.office.net/officehub/bundles/unauth-bcb078e6e9.js",
        ...Array.from({ length: 12 }, (_, i) => `https://res.cdn.office.net/officehub/bundles/test-bundle-${i.toString(16).padStart(10, "0")}.js`),
    ];
    const assetInputs = scenario === "default fields" ? [
        [assets[0] + "?private=EXAMPLE_PRIVATE_LABEL", "script", false],
        [assets[0] + "#EXAMPLE_PRIVATE_LABEL", "script", false],
        [`https://res.cdn.office.net/officehub/bundles/client-${fixture.target.expectedSubject}-1234567890.js`, "script", false],
        [`https://res.cdn.office.net/officehub/bundles/client-${fixture.target.expectedTenant.replaceAll("-", "")}-1234567890.js`, "script", false],
        [`https://res.cdn.office.net/officehub/bundles/client-${fixture.target.expectedAccount.split("@")[0]}-1234567890.js`, "script", false],
        ["https://res.cdn.office.net/officehub/bundles/client%2dentry-1234567890.js", "script", false],
        ["https://res.cdn.office.net/officehub/private/EXAMPLE_PRIVATE_LABEL/entry.js", "script", false],
        ["https://tenant.sharepointonline.com/entry.js", "script", false],
        [app + "/entry.js", "script", false],
        ["https://res.cdn.office.net/officehub/bundles/" + "a".repeat(2048) + "-1234567890.js", "script", false],
        [assets[0], "script", false],
        [assets[0], "script", false],
        ...assets.slice(1).map(url => [url, "script", false]),
    ] : [];
    for (const key of ["search", "searchParams"]) {
        const original = Object.getOwnPropertyDescriptor(URL.prototype, key).get;
        t.mock.getter(URL.prototype, key, function () {
            assert.ok(!this.pathname.endsWith("/oauth2/v2.0/token"), "Authentication queries must remain unread.");
            return original.call(this);
        });
    }
    const frame = { url: () => location, page: () => page };
    const page = {
        url: () => location, isClosed: () => pageClosed,
        async close() { pageClosed = true; },
        mainFrame: () => frame,
        on() {},
        locator: () => ({ filter() { return this; }, async count() { return 0; } }),
        async goto(url) {
            if (url === "about:blank") { location = url; return; }
            if (url !== nativeApplicationEntry) { taskNavigations++; throw new Error("Synthetic task navigation is forbidden."); }
            location = nativeApplicationEntry;
            const inputs = surfaceDenial ? [
                [nativeApplicationEntry, "document", true],
                scenario === "shell query document" ? [nativeApplicationEntry + "?private=EXAMPLE_PRIVATE_LABEL", "document", true]
                    : scenario === "shell XHR" ? [nativeApplicationEntry, "xhr", false]
                        : [app + "/landingv2", "document", true, "POST"],
            ] : routeDataBlock || protocolDataBlock ? [
                [nativeApplicationEntry, "document", true],
                [routeDataBlock ? "https://example.invalid/config?private=EXAMPLE_PRIVATE_LABEL" : app + "/entry.js",
                    protocolDataBlock ? "script" : "fetch", false],
            ] : tokenScenario ? [
                [nativeApplicationEntry, "document", true],
                ...(tokenCaps ? Array.from({ length: 4 }, () => [
                    [tokenUrl, "other", false, "OPTIONS"], [tokenUrl, "fetch", false, "POST"],
                ]).flat() : [[scenario === "token tenant mismatch"
                    ? "https://login.microsoftonline.com/common/oauth2/v2.0/token" : tokenUrl,
                "fetch", false, "POST", false, scenario === "token frame mismatch"]]),
                ...(["token post cap", "token preflight cap"].includes(scenario)
                    ? [[tokenUrl, scenario === "token post cap" ? "fetch" : "other", false,
                        scenario === "token post cap" ? "POST" : "OPTIONS"]] : []),
            ] : [
                [nativeApplicationEntry, "document", true],
                ...assetInputs,
                [allowedSelf, "fetch", false],
                [allowedSelf, "fetch", false],
            ];
            for (const [url, type, navigation, method = "GET", redirected = false, otherFrame = false] of inputs) {
                if (preflightScenario && url === allowedSelf && !preflightAttempted) {
                    preflightAttempted = true;
                    const metadataRequest = method => ({ url, method,
                        get headers() { assert.fail("No Network header inspection."); },
                        get postData() { assert.fail("No Network body inspection."); } });
                    if (scenario !== "self preflight no association") {
                        networkEvents.get("Network.requestWillBeSent")({ requestId: "associated-get", frameId: "owned-main-frame",
                            type: "Fetch", request: metadataRequest("GET") });
                        networkEvents.get("Network.requestWillBeSent")({ requestId: "associated-preflight", type: "Other",
                            initiator: { type: "preflight", requestId: "associated-get",
                                get url() { assert.fail("No initiator URL inspection."); }, get stack() { assert.fail("No stack inspection."); } },
                            request: metadataRequest("OPTIONS") });
                    }
                    const preflight = { requestId: "self-preflight", networkId: "associated-preflight", frameId: "owned-main-frame",
                        resourceType: "Other", request: metadataRequest("OPTIONS") };
                    await paused(preflight);
                    if (scenario !== "self preflight no association") await paused({ ...preflight, responseStatusCode: 204 });
                    if (scenario === "self preflight cap") await paused({ ...preflight, requestId: "second-preflight" });
                    if (preflightOnlyStop) break;
                }
                const request = { url: () => url, method: () => method, resourceType: () => type,
                    isNavigationRequest: () => navigation,
                    redirectedFrom: () => redirected ? {} : null, frame: () => otherFrame ? {} : frame,
                    postData() { assert.fail("Authentication bodies must remain unread."); },
                    headerValue() { assert.fail("Account-only routing must not read credential or identity headers."); } };
                await router({ request: () => request,
                    async continue(...overrides) {
                        assert.equal(overrides.length, 0, "Original requests must not be overridden.");
                        routed.push({ url, continued: true });
                        const token = url === tokenUrl, self = url === allowedSelf;
                        if (token) tokenSequence++;
                        const original = { requestId: self ? "original-self" : token ? "token-" + tokenSequence : "resource-" + routed.length,
                            networkId: self && preflightScenario ? "associated-get" : self ? "self-network"
                                : token ? "network-token-" + tokenSequence : "network-resource-" + routed.length,
                            frameId: "owned-main-frame", resourceType: method === "OPTIONS" ? "Preflight"
                                : type === "fetch" ? "Fetch" : type === "document" ? "Document" : "Script", request: {
                            url, method, get headers() { assert.fail("No protocol header capture."); },
                            get postData() { assert.fail("No token body capture."); },
                        } };
                        for (const event of [original, { ...original, responseStatusCode:
                            self ? selectedFields ? 200 : 302 : token && scenario === "token redirect" ? 302
                                : method === "OPTIONS" ? 204 : token && tokenSequence === 8 ? 400 : 200 }]) {
                            Object.defineProperty(event, "responseHeaders", { get() { assert.fail("No protocol response-header capture."); } });
                            await paused(event);
                        }
                        if (!diagnostics.some(item => item[0] === "[workiq-native] account-only stopped")) {
                            if (protocolDataBlock && url === app + "/entry.js") networkEvents.get("Network.loadingFailed")({
                                requestId: original.networkId, type: original.resourceType,
                            });
                            else networkEvents.get("Network.loadingFinished")({ requestId: original.networkId });
                        }
                    },
                    async abort() { routed.push({ url, continued: false }); } });
                if (unexpectedPage) events.get("page")({ async close() { extraClosed++; } });
                if (protocolDataBlock && url === nativeApplicationEntry) {
                    await paused({ requestId: "policy-block", networkId: "policy-block-network", frameId: "owned-main-frame",
                        resourceType: "Fetch", request: { url: "https://example.invalid/config?private=EXAMPLE_PRIVATE_LABEL", method: "GET" } });
                    networkEvents.get("Network.loadingFailed")({ requestId: "policy-block-network", type: "Fetch" });
                    assert.equal(diagnostics.some(item => item[0] === "[workiq-native] account-only stopped"), false);
                }
                if (!routed.at(-1).continued
                    || diagnostics.some(item => item[0] === "[workiq-native] account-only stopped")) break;
            }
            if (scenario === "token protocol cap") await paused({ requestId: "token-over-cap", frameId: "owned-main-frame",
                networkId: "network-token-over-cap",
                resourceType: "Fetch", request: { url: tokenUrl, method: "POST",
                    get headers() { assert.fail("No token header capture."); } } });
        },
    };
    const browser = {
        pages: () => [page], setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
        async routeWebSocket() {}, async route(_pattern, handler) { router = handler; },
        on(event, handler) { events.set(event, handler); },
        async exposeBinding() { assert.fail("Account-only Connect must not install a content capture binding."); },
        async addInitScript() { assert.fail("Account-only Connect must not install the Chat content capture hook."); },
        async newCDPSession(value) {
            assert.equal(value, page);
            return {
                on(event, handler) {
                    if (event === "Fetch.requestPaused") paused = handler;
                    else if (event === "close") protocolClosed = handler;
                    else {
                        assert.ok(["Page.frameNavigated", "Page.frameDetached", "Network.requestServedFromCache",
                            "Network.responseReceived", "Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed"].includes(event));
                        networkEvents.set(event, handler);
                    }
                },
                async send(method, input) {
                    assert.ok(["Page.getFrameTree", "Network.enable", "Fetch.enable", "Fetch.continueRequest", "Fetch.continueResponse", "Fetch.failRequest"].includes(method));
                    protocolCommands.push({ method, input });
                    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "owned-main-frame" } } };
                    if (attachmentFails && method === "Fetch.enable") throw new Error("Protocol attachment failed.");
                    if (earlyCoverage && method === "Fetch.enable") protocolClosed();
                    if (continuationFails && method === "Fetch.continueResponse" && input.requestId === "original-self") throw new Error("Response continuation failed.");
                    if (tokenFailure && method === "Fetch.continueResponse" && input.requestId.startsWith("token-")) throw new Error("Token continuation failed.");
                },
                async detach() { assert.fail("A live redirect gate must not be detached."); },
            };
        },
        async close() { closed = true; events.get("close")?.(); },
    };
    t.mock.method(chromium, "launchPersistentContext", async (directory, options) => {
        launches++;
        assert.equal(directory, fixture.config.profileDirectory);
        assert.equal(options.channel, "msedge");
        const owner = JSON.parse(await readFile(fixture.config.ownerLockPath, "utf8"));
        assert.equal(owner.pid, process.pid);
        assert.equal(owner.profile, directory);
        assert.equal(typeof owner.owner, "string");
        return browser;
    });
    const host = await fixture.start(await readMicrosoftNativeConfiguration(fixture.file), fixture.context, true, false, true);
    const boardFile = path.join(fixture.context.dataDir, `${BOARD_ID}.state.json`), before = await readFile(boardFile);
    const owner = "account-only-existing-connect-owner";
    await host.access.command(owner, { schemaVersion: 1, action: "wire-sign-in", operationId: randomUUID(),
        generation: (await host.access.status()).generation }, () => true);
    const operationId = randomUUID();
    const receipt = await host.access.command(owner, { schemaVersion: 1, action: "microsoft-connect", operationId,
        generation: (await host.access.status()).generation }, () => true);
    assert.equal(receipt.outcome, "failed");
    assert.equal(receipt.reason, attachmentFails ? "transport-failed" : "account-metadata-unavailable");
    assert.equal(receipt.operationId, operationId);
    assert.equal(taskNavigations, 0);
    assert.equal(launches, 1);
    assert.equal(events.has("requestfailed"), false, "Account-only HTTP failures must use the exact-ID protocol path, not an uncorrelated duplicate hook.");
    assert.equal(networkEvents.has("Network.loadingFailed"), true);
    assert.deepEqual(routed.filter(item => item.continued).map(item => item.url), tokenScenario
        ? [nativeApplicationEntry, ...Array(tokenMismatch ? 0 : tokenCaps ? 8 : 1).fill(tokenUrl)]
        : attachmentFails || earlyCoverage ? [] : unexpectedPage || surfaceDenial || preflightOnlyStop || routeDataBlock ? [nativeApplicationEntry]
            : protocolDataBlock ? [nativeApplicationEntry, app + "/entry.js"]
            : [nativeApplicationEntry, ...assetInputs.map(([url]) => url), allowedSelf]);
    assert.deepEqual(protocolCommands.slice(0, 3), [
        { method: "Page.getFrameTree", input: undefined },
        { method: "Network.enable", input: { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 } },
        { method: "Fetch.enable", input: { patterns: [
            { urlPattern: "*", requestStage: "Request" },
        ] } },
    ]);
    if (tokenScenario) {
        assert.equal(protocolCommands.filter(item => item.method === "Fetch.continueRequest").length, 1 + (tokenMismatch ? 0 : tokenCaps ? 8 : 1));
        assert.equal(protocolCommands.filter(item => item.method === "Fetch.continueResponse").length,
            1 + (tokenMismatch || scenario === "token redirect" ? 0 : tokenCaps ? 8 : 1));
        for (const item of protocolCommands.filter(item => item.method === "Fetch.continueRequest")) {
            assert.deepEqual(Object.keys(item.input).sort(), ["interceptResponse", "requestId"]);
            assert.equal(item.input.interceptResponse, true);
        }
        for (const item of protocolCommands.filter(item => item.method === "Fetch.continueResponse")) {
            assert.deepEqual(Object.keys(item.input), ["requestId"]);
        }
        if (scenario === "token redirect" || scenario === "token protocol cap") {
            assert.equal(protocolCommands.at(-1).method, "Fetch.failRequest");
        }
    }
    const routes = diagnostics.filter(item => item[0] === "[workiq-native] account-only request").map(item => JSON.parse(item[1]));
    assert.equal(routes.length, attachmentFails || earlyStop || surfaceDenial || preflightOnlyStop || routeDataBlock || protocolDataBlock ? 0 : 1);
    if (!attachmentFails) {
        if (!tokenScenario && !earlyStop && !surfaceDenial && !preflightOnlyStop && !routeDataBlock && !protocolDataBlock) {
            assert.ok(routes.some(item => item.origin === "https://graph.microsoft.com" && item.pathTemplate === "/v1.0/me"));
        }
        for (const item of routes) assert.deepEqual(Object.keys(item).sort(), ["method", "origin", "pathTemplate"]);
        assert.doesNotMatch(JSON.stringify(routes), new RegExp(fixture.target.expectedSubject + "|EXAMPLE_PRIVATE_LABEL|\\?"));
        const settled = diagnostics.find(item => item[0] === "[workiq-native] original read settled");
        assert.equal(JSON.parse(settled[1]).capturedResponses, 0);
        const facts = JSON.parse(settled[1]).accountOnlyRequests;
        assert.doesNotMatch(settled[1], /token-\d|original-self|associated-get|associated-preflight|EXAMPLE_PRIVATE_LABEL/);
        const { tokenRequests, scriptAssets, deniedDependency, firstDenialContext, frameDiagnosis, selfPreflight,
            firstPolicyBlock, terminalOutcome, ...selfFacts } = facts;
        assert.equal(frameDiagnosis, null, "These route-first failures have no protocol frame diagnosis.");
        assert.deepEqual(firstPolicyBlock, protocolDataBlock ? { reason: "data-dependency", context: {
            method: "GET", resourceType: "fetch", stage: "request", navigation: false, owned: true, original: true,
            target: "other", queryPresent: true,
        }, abortAcknowledged: true } : null);
        assert.deepEqual(terminalOutcome, { outcome: "unverified", reason: "account-metadata-unavailable" });
        const preflightAccepted = preflightScenario && scenario !== "self preflight no association";
        assert.deepEqual(selfPreflight, { consumed: preflightAccepted, associated: preflightAccepted,
            requestContinued: preflightAccepted, responseContinued: preflightAccepted });
        const reason = earlyCoverage ? "protocol-coverage" : unexpectedPage ? "unexpected-page"
            : routeDataBlock ? "data-dependency" : protocolDataBlock ? "request-failed"
            : surfaceDenial ? scenario === "landing return POST" ? "sign-in-return-method" : "shell-document-scope"
            : preflightOnlyStop ? scenario === "self preflight cap" ? "network-id-reused" : "self-preflight-association"
            : tokenCaps ? "token-cap" : scenario === "token tenant mismatch" ? "token-scope"
            : scenario === "token frame mismatch" ? "unowned-frame" : scenario === "token redirect" ? "token-redirect"
                : tokenFailure || continuationFails ? "protocol-continuation" : selectedFields ? "self-cap" : "self-response";
        assert.equal(deniedDependency, reason);
        assert.deepEqual(diagnostics.filter(item => item[0] === "[workiq-native] account-only stopped"),
            [["[workiq-native] account-only stopped", { reason }]], "The first denial is the only stop reason.");
        assert.deepEqual(firstDenialContext, earlyStop ? null : {
            method: preflightOnlyStop ? "OPTIONS" : scenario === "landing return POST" ? "POST" : tokenScenario ? scenario === "token preflight cap" ? "OPTIONS" : "POST" : "GET",
            resourceType: protocolDataBlock ? "script" : scenario === "shell XHR" ? "xhr" : surfaceDenial ? "document"
                : scenario === "token preflight cap" || preflightOnlyStop ? "other" : "fetch",
            stage: scenario === "token protocol cap" || preflightOnlyStop ? "request" : protocolDataBlock || continuationFails || tokenFailure
                || scenario === "default fields" || scenario === "token redirect" ? "response" : "route",
            navigation: surfaceDenial && scenario !== "shell XHR", owned: scenario !== "token frame mismatch", original: true,
            target: protocolDataBlock ? "static" : scenario === "landing return POST" ? "landingv2" : surfaceDenial ? "shell" : tokenScenario ? "token" : routeDataBlock ? "other" : "self",
            queryPresent: routeDataBlock ? true : surfaceDenial ? scenario === "shell query document" : tokenScenario ? scenario !== "token tenant mismatch" : selectedFields,
        }, "Preserve the first denied request shape through cleanup, without inferring startup necessity.");
        assert.deepEqual(scriptAssets, scenario === "default fields"
            ? { urls: assets.slice(0, 12), capped: true, omitted: true }
            : { urls: [], capped: false, omitted: protocolDataBlock });
        assert.ok(scriptAssets.urls.every(url => url.length <= 2048));
        assert.equal(new Set(scriptAssets.urls).size, scriptAssets.urls.length);
        assert.doesNotMatch(JSON.stringify(scriptAssets), new RegExp(fixture.target.expectedTenant + "|" + fixture.target.expectedSubject));
        assert.deepEqual(selfFacts, { recorded: earlyStop || surfaceDenial || preflightOnlyStop || routeDataBlock || protocolDataBlock ? 0 : 1, capped: false,
            selfRouteConsumed: !tokenScenario && !earlyStop && !surfaceDenial && !preflightOnlyStop && !routeDataBlock && !protocolDataBlock,
            selfProtocolConsumed: !tokenScenario && !earlyStop && !surfaceDenial && !preflightOnlyStop && !routeDataBlock && !protocolDataBlock,
            self2xxContinued: selectedFields && !continuationFails && !preflightOnlyStop });
        const count = tokenScenario && !tokenMismatch ? tokenCaps ? 4 : 1 : 0;
        assert.deepEqual(tokenRequests, {
            posts: { routeConsumed: count, protocolConsumed: count, requestContinued: count,
                responseContinued: scenario === "token redirect" || tokenFailure ? 0 : count },
            preflights: { routeConsumed: tokenCaps ? 4 : 0, protocolConsumed: tokenCaps ? 4 : 0,
                requestContinued: tokenCaps ? 4 : 0, responseContinued: tokenCaps ? 4 : 0 },
            errorResponsesContinued: tokenCaps ? 1 : 0, capReached: tokenCaps,
            mismatch: scenario === "token tenant mismatch", redirectBlocked: scenario === "token redirect",
            continuationFailed: tokenFailure,
        });
    }
    const control = JSON.parse(await readFile(path.join(fixture.context.dataDir, "microsoft-session", "session.json"), "utf8"));
    assert.equal(control.partition, null);
    assert.ok(control.receipts.some(item => item.operationId === operationId && item.outcome === "failed"));
    assert.equal((await host.access.status()).microsoft.state, "disconnected");
    assert.equal(await readNativeCollectionSettings(fixture.context), null);
    assert.deepEqual(await readFile(boardFile), before);
    assert.equal(closed, true);
    assert.equal(extraClosed, unexpectedPage ? 1 : 0);
    await assert.rejects(stat(fixture.config.ownerLockPath), { code: "ENOENT" });
});

test("Network-only embedded images settle without Fetch authority and refuse ambiguous completion", async t => {
    for (const scenario of ["complete", "memory-cache", "png", "jpeg", "webp", "unbound", "scope-change", "revoked",
        "response-frame", "response-loader", "response-mime", "response-url", "response-status", "response-missing",
        "response-disk", "response-prefetch", "response-worker", "response-duplicate", "finish-without-response",
        "failed", "terminal-duplicate", "terminal-conflict", "cache-duplicate", "cache-after-response",
        "unexpected-fetch", "id-reused", "id-reused-remote", "fetch-first", "fetch-pending", "write", "wrong-type", "svg", "blob",
        "oversized", "cap", "retired", "next-scope"]) {
        await t.test(scenario, async () => {
            const handlers = new Map(), commands = [], stopped = [];
            const scope = { native: {}, abort: new AbortController(), page: { url: () => nativeApplicationEntry } };
            const document = { entry: { networkId: "document-loader" } };
            let current = scope, bound = true;
            const admission = Promise.withResolvers();
            const mime = ["png", "jpeg", "webp"].includes(scenario) ? "image/" + scenario : "image/gif";
            const url = `data:${mime};base64,PRIVATE_IMAGE_BYTES`;
            const request = { requestId: "local", frameId: "root", loaderId: "document-loader",
                documentURL: nativeApplicationEntry, type: "Image",
                request: { url, method: "GET", get headers() { assert.fail("No headers."); }, get postData() { assert.fail("No payload."); } } };
            const gate = await guardAccountOnlyRequests({
                on: (name, handler) => handlers.set(name, handler),
                async send(method, input) { commands.push({ method, input }); return {}; },
            }, {
                mainFrameId: "root", getScope: () => current, getAncillaryDocument: () => document,
                track: work => work, admit: () => scenario === "fetch-pending" ? admission.promise : "static", responded() {},
                bindLocalImage: () => scenario === "unbound" ? null : { current: () => bound },
                stop(owner, reason, facts, observation) {
                    if (owner?.abort.signal.aborted) return;
                    stopped.push(nativeFailureDetails(nativeProtocolFailure(reason, facts, { scope: owner, mainFrameId: "root", observation })));
                    owner?.abort.abort();
                },
            });
            const emit = (name, event) => handlers.get(name)(event);
            const response = { requestId: "local", frameId: "root", loaderId: "document-loader", type: "Image",
                response: { status: 200, mimeType: mime, url, fromDiskCache: false, fromPrefetchCache: false,
                    fromServiceWorker: false, get headers() { assert.fail("No response headers."); } } };
            const terminal = { requestId: "local", get errorText() { assert.fail("No error-text inference."); } };
            const pause = { requestId: "fetch", networkId: "local", frameId: "root", resourceType: "Image", request: request.request };
            if (scenario === "fetch-first") await emit("Fetch.requestPaused", pause);
            const pendingFetch = scenario === "fetch-pending" ? emit("Fetch.requestPaused", pause) : null;
            if (scenario === "write") request.request.method = "POST";
            if (scenario === "wrong-type") request.type = "Script";
            if (scenario === "svg") request.request.url = "data:image/svg+xml;base64,PRIVATE_IMAGE_BYTES";
            if (scenario === "blob") request.request.url = "blob:https://example.invalid/PRIVATE_BLOB";
            if (scenario === "oversized") request.request.url = url + "A".repeat(65536);
            emit("Network.requestWillBeSent", request);
            if (["complete", "memory-cache", "png", "jpeg", "webp", "finish-without-response", "failed", "cap", "next-scope"].includes(scenario)) {
                assert.equal(gate.pendingCount, 1, "The original image must keep the collection drain pending until its matching terminal.");
            }
            if (pendingFetch) {
                admission.resolve("static");
                await pendingFetch;
            }
            if (scenario === "cap") {
                for (let index = 1; index <= 512; index++) emit("Network.requestWillBeSent", { ...request, requestId: "local-" + index });
            } else if (scenario === "retired") {
                gate.retire();
                emit("Network.responseReceived", response);
                emit("Network.loadingFinished", terminal);
            } else if (scenario === "unexpected-fetch") await emit("Fetch.requestPaused", pause);
            else if (scenario.startsWith("id-reused")) emit("Network.requestWillBeSent", {
                ...request, ...(scenario === "id-reused-remote" ? { type: "Fetch", request: { url: "https://example.invalid/PRIVATE", method: "POST" } } : {}),
            });
            else if (gate.active) {
                if (scenario === "scope-change") current = { ...scope, native: {}, abort: new AbortController() };
                if (scenario === "revoked") bound = false;
                if (["memory-cache", "cache-duplicate"].includes(scenario)) {
                    emit("Network.requestServedFromCache", terminal);
                    if (scenario === "cache-duplicate") emit("Network.requestServedFromCache", terminal);
                }
                if (scenario === "response-frame") response.frameId = "child";
                if (scenario === "response-loader") response.loaderId = "different-loader";
                if (scenario === "response-mime") response.response.mimeType = "text/html";
                if (scenario === "response-url") response.response.url = "https://example.invalid/PRIVATE_IMAGE";
                if (scenario === "response-status") response.response.status = 302;
                if (scenario === "response-missing") delete response.response;
                if (scenario === "response-disk") response.response.fromDiskCache = true;
                if (scenario === "response-prefetch") response.response.fromPrefetchCache = true;
                if (scenario === "response-worker") response.response.fromServiceWorker = true;
                if (scenario !== "finish-without-response") emit("Network.responseReceived", response);
                if (scenario === "response-duplicate") emit("Network.responseReceived", response);
                if (scenario === "cache-after-response") emit("Network.requestServedFromCache", terminal);
                emit(scenario === "failed" ? "Network.loadingFailed" : "Network.loadingFinished", terminal);
                if (scenario.startsWith("terminal-")) emit(scenario === "terminal-duplicate" ? "Network.loadingFinished" : "Network.loadingFailed", terminal);
                if (scenario === "next-scope") {
                    current = { ...scope, native: {}, abort: new AbortController() };
                    emit("Network.requestWillBeSent", { ...request, requestId: "next" });
                    emit("Network.responseReceived", { ...response, requestId: "next" });
                    emit("Network.loadingFinished", { requestId: "next" });
                    assert.equal(current.native.localImages.completed, 1);
                }
            }
            const succeeds = ["complete", "memory-cache", "png", "jpeg", "webp", "next-scope"].includes(scenario);
            assert.equal(gate.active, succeeds);
            assert.equal(stopped.length, succeeds || scenario === "retired" ? 0 : 1);
            if (stopped[0]) assert.equal(stopped[0].protocolStop.reason,
                ["unbound", "write", "wrong-type", "svg", "blob", "oversized"].includes(scenario) ? "network-record-missing"
                    : ["scope-change", "revoked"].includes(scenario) ? "network-scope-mismatch"
                        : scenario.startsWith("terminal-") ? "network-" + scenario
                            : ["unexpected-fetch", "id-reused", "id-reused-remote", "fetch-first", "fetch-pending"].includes(scenario) ? "network-id-reused"
                                : scenario === "cap" ? "protocol-cap" : "network-completion-state");
            assert.equal(scope.native.localImages?.completed ?? 0,
                succeeds || scenario.startsWith("terminal-") ? 1 : 0);
            if (scope.native.localImages) assert.equal(scope.native.localImages.sourceQualified, false);
            if (stopped[0]) assert.equal(validNativeFailure({ ...stopped[0], recordedAt: new Date().toISOString() }), true);
            assert.doesNotMatch(JSON.stringify(stopped), /PRIVATE_|data:|base64|https:/);
            assert.equal(commands.some(row => row.method.startsWith("Fetch.continue")), scenario === "fetch-first");
            if (scenario === "unexpected-fetch") assert.deepEqual(commands.filter(row => row.method === "Fetch.failRequest"),
                [{ method: "Fetch.failRequest", input: { requestId: "fetch", errorReason: "BlockedByClient" } }]);
            assert.equal(gate.pendingCount, 0);
            gate.retire();
        });
    }
});

test("missing Network records retain only bounded original classifications, never terminal guesses", async t => {
    for (const scenario of ["remote", "duplicate", "redirect", "absent", "capped", "foreign", "unknown", "invalid-id"]) {
        await t.test(scenario, async () => {
            const handlers = new Map(), scope = { native: {}, abort: new AbortController(), page: { url: () => nativeApplicationEntry } };
            let failure;
            const gate = await guardAccountOnlyRequests({
                on: (name, handler) => handlers.set(name, handler), async send() { return {}; },
            }, {
                mainFrameId: "root", getScope: () => scope, track: work => work,
                getAncillaryDocument: () => ({ entry: { networkId: "loader" } }),
                admit() { assert.fail("No Fetch record."); }, responded() {},
                stop(owner, reason, facts, observation) {
                    failure = nativeFailureDetails(nativeProtocolFailure(reason, facts, { scope: owner, mainFrameId: "root", observation }));
                    owner.abort.abort();
                },
            });
            const event = { requestId: scenario === "invalid-id" ? "" : "original", type: scenario === "unknown" ? "PRIVATE_TYPE" : "Fetch",
                frameId: scenario === "foreign" ? "foreign" : "root", loaderId: "loader", documentURL: nativeApplicationEntry,
                request: { method: "GET", url: "https://example.invalid/PRIVATE_PATH?PRIVATE_QUERY=PRIVATE_VALUE" } };
            const emit = handlers.get("Network.requestWillBeSent");
            if (scenario === "capped") for (let index = 0; index < 512; index++) emit({ ...event, requestId: "earlier-" + index });
            if (scenario !== "absent") emit(event);
            if (scenario === "duplicate") emit(event);
            if (scenario === "redirect") emit({ ...event, redirectResponse: {} });
            handlers.get("Network.loadingFinished")({ requestId: event.requestId, type: "Image" });
            const detail = failure.protocolStop, record = detail.networkRecord;
            assert.equal(detail.reason, "network-record-missing");
            assert.equal(detail.terminal, "finished");
            assert.equal(record.observation, ["absent", "invalid-id"].includes(scenario) ? "unobserved"
                : ["duplicate", "redirect", "capped"].includes(scenario) ? scenario : "original");
            assert.equal(record.resourceType, ["absent", "invalid-id", "capped"].includes(scenario) ? "unobserved"
                : scenario === "unknown" ? "other" : "fetch", "A terminal's resource type cannot replace the original observation.");
            assert.equal(validNativeFailure({ ...failure, recordedAt: new Date().toISOString() }), true);
            const { networkRecord, ...legacy } = detail;
            assert.equal(validNativeFailure({ ...failure, recordedAt: new Date().toISOString(), protocolStop: legacy }), true,
                "Old missing-record failures remain valid without guessing their original class.");
            for (const changed of [{ reason: "protocol-cap" }, { phase: "request" }, { terminal: undefined }]) {
                assert.equal(validNativeFailure({ ...failure, recordedAt: new Date().toISOString(),
                    protocolStop: { ...detail, ...changed } }), false);
            }
            assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_|https:/);
            for (const changed of [{ ...record, url: "PRIVATE" }, { ...record, resourceType: "PRIVATE" },
                { ...record, observation: "PRIVATE" }, { ...record, document: "PRIVATE" }, { ...record, loader: "PRIVATE" },
                { ...record, frame: "PRIVATE" }, { ...record, urlClass: "PRIVATE" }]) {
                assert.equal(validNativeFailure({ ...failure, recordedAt: new Date().toISOString(),
                    protocolStop: { ...detail, networkRecord: changed } }), false);
            }
            assert.equal(scope.native.networkRecordObservations?.size ?? 0, scenario === "capped" ? 512
                : ["absent", "invalid-id"].includes(scenario) ? 0 : 1);
            gate.retire();
        });
    }
});

test("account-only policy aborts require exact terminal accounting without hiding allowed failures", async () => {
    for (const variant of ["abort-ack-first", "abort-terminal-first", "abort-rejected", "abort-finished",
        "abort-unmatched-failure", "abort-duplicate-terminal",
        "abort-terminal-first-duplicate", "abort-terminal-first-conflict",
        "abort-terminal-type", "abort-terminal-first-type", "allowed-terminal-type", "allowed-after-headers-type",
        "allowed-before-headers", "allowed-after-headers", "allowed-finish-before-ack", "unmatched-failure", "unmatched-finish",
        "unmatched-terminal-type", "allowed-finish-without-headers",
        "transport-failure", "transport-finished", "transport-response-error", "transport-response-error-with-status",
        "transport-response", "transport-response-failure-after-headers",
        "transport-response-terminal-first", "transport-request-terminal-first", "transport-request-unknown-ack",
        "transport-response-unknown-ack", "transport-response-error-unknown-ack", "transport-request-owner-change", "transport-response-owner-change",
        "transport-stale-binding", "transport-duplicate-terminal", "transport-response-mismatch",
        "transport-redirect", "transport-unknown-error", "transport-missing-network",
        { scenario: "transport-response", presentation: "Stylesheet", status: 404 },
        { scenario: "transport-response-error", presentation: "Font" },
        { scenario: "transport-stale-binding", presentation: "Image" },
        { scenario: "transport-failure", presentation: "Script", refused: true },
        { scenario: "transport-failure", presentation: "Other", refused: true },
        { scenario: "transport-failure", presentation: "Image", frame: "child", refused: true }]) {
        const { scenario, presentation = null, refused = false, frame: frameId = "owned", status: responseStatus = 200 } =
            typeof variant === "string" ? { scenario: variant } : variant;
        const handlers = new Map(), commands = [], stopped = [], deferred = Promise.withResolvers();
        const scope = { abort: new AbortController(), firstPolicyBlock: null };
        const transportOnly = scenario.startsWith("transport-");
        let current = scope, bindingCurrent = true, transportSettlements = 0;
        const block = scenario.startsWith("abort-");
        const abortBeforeAck = scenario.startsWith("abort-terminal-first") || scenario === "abort-rejected";
        const event = { requestId: "fetch-id", networkId: "network-id", frameId,
            resourceType: presentation ?? (block || transportOnly ? "Fetch" : "Document"), request: { method: "GET",
                url: block ? "https://example.invalid/config?opaque=DO_NOT_CAPTURE"
                    : presentation ? "https://res.cdn.office.net/fixture-presentation"
                    : transportOnly ? "https://m365.cloud.microsoft/client_health_ping?type=loggerInit&route=PRIVATE_ROUTE" : nativeApplicationEntry,
                get headers() { assert.fail("No headers."); }, get postData() { assert.fail("No body."); } } };
        const gate = await guardAccountOnlyRequests({
            on: (name, listener) => handlers.set(name, listener),
            async send(method, input) {
                commands.push({ method, input });
                if (transportOnly) {
                    if (method === "Fetch.continueRequest") {
                        if (scenario === "transport-request-unknown-ack") return undefined;
                        if (scenario === "transport-request-owner-change") current = null;
                        if (scenario === "transport-request-terminal-first") return deferred.promise;
                    }
                    if (method === "Fetch.continueResponse" && scenario === "transport-response-unknown-ack") return [];
                    if (method === "Fetch.failRequest" && input.errorReason === "Failed") {
                        if (scenario === "transport-response-error-unknown-ack") return [];
                        if (scenario === "transport-response-owner-change") current = null;
                        if (scenario === "transport-response-terminal-first") return deferred.promise;
                    }
                    return {};
                }
                if (method === "Fetch.failRequest" && abortBeforeAck
                    || method === "Fetch.continueResponse" && scenario === "allowed-finish-before-ack") return deferred.promise;
            },
        }, {
            mainFrameId: "owned", getScope: () => current, track: work => work, responded() {},
            ownsFrame: id => ["owned", "child"].includes(id),
            validateBootstrapTransport: () => bindingCurrent,
            observeTerminal: () => { transportSettlements++; return true; },
            stop(_, reason) { if (!scope.abort.signal.aborted) { stopped.push(reason); scope.abort.abort(); } },
            admit(_, facts) {
                if (presentation) return "static-presentation-transport";
                const decision = accountOnlyRequestDecision(facts);
                if (transportOnly && decision.kind === "bootstrap") return "bootstrap-health-transport";
                return decision.denied === "data-dependency" ? "policy-block" : decision.kind;
            },
        });
        const terminal = { requestId: "network-id", type: scenario.endsWith("-type") ? "Other" : event.resourceType,
            get errorText() { assert.fail("No error-text-based attribution."); } };
        if (transportOnly) {
            const paused = handlers.get("Fetch.requestPaused");
            const request = paused({ ...event, ...(scenario === "transport-missing-network" ? { networkId: undefined } : {}) });
            if (scenario === "transport-request-terminal-first") {
                handlers.get("Network.loadingFailed")(terminal);
                assert.equal(transportSettlements, 0, "A native terminal does not fabricate protocol acknowledgement.");
                deferred.resolve({});
            }
            await request;
            if (gate.active && !scenario.startsWith("transport-request-terminal")) {
                if (scenario === "transport-stale-binding") bindingCurrent = false;
                if (scenario.startsWith("transport-response") || ["transport-redirect", "transport-unknown-error"].includes(scenario)) {
                    const actualResponse = ["transport-response", "transport-response-failure-after-headers",
                        "transport-response-unknown-ack"].includes(scenario);
                    const response = paused({ ...event, ...(actualResponse ? { responseStatusCode: responseStatus }
                        : { responseErrorReason: scenario === "transport-unknown-error" ? "Unqualified" : "Failed" }),
                        ...(scenario === "transport-response-error-with-status" ? { responseStatusCode: 200 } : {}),
                        ...(scenario === "transport-redirect" ? { responseStatusCode: 302 } : {}),
                        ...(scenario === "transport-response-mismatch" ? { networkId: "different-network" } : {}) });
                    if (scenario === "transport-response-terminal-first") {
                        handlers.get("Network.loadingFailed")(terminal);
                        assert.equal(transportSettlements, 0);
                        deferred.resolve({});
                    }
                    await response;
                    if (gate.active && scenario !== "transport-response-terminal-first") {
                        handlers.get(scenario === "transport-response" ? "Network.loadingFinished" : "Network.loadingFailed")(terminal);
                    }
                } else handlers.get(scenario === "transport-finished" ? "Network.loadingFinished" : "Network.loadingFailed")(terminal);
                if (scenario === "transport-duplicate-terminal") handlers.get("Network.loadingFailed")(terminal);
            }
            const succeeds = !refused && ["transport-failure", "transport-finished", "transport-response-error",
                "transport-response", "transport-response-failure-after-headers",
                "transport-response-error-with-status", "transport-response-terminal-first", "transport-request-terminal-first"].includes(scenario);
            assert.equal(gate.active, succeeds, scenario);
            assert.equal(transportSettlements, succeeds || scenario === "transport-duplicate-terminal" ? 1 : 0, scenario);
            assert.equal(commands.some(command => command.method === "Fetch.fulfillRequest"), false);
            if (refused) assert.equal(commands.some(command => command.method === "Fetch.continueRequest"), false,
                "Presentation settlement cannot admit scripts, generic Other requests, or owned subframes.");
            const actualResponse = ["transport-response", "transport-response-failure-after-headers",
                "transport-response-unknown-ack"].includes(scenario);
            assert.deepEqual(commands.filter(command => command.method === "Fetch.continueResponse").map(command => command.input),
                actualResponse ? [{ requestId: "fetch-id" }] : []);
            for (const command of commands.filter(command => command.method === "Fetch.continueRequest")) {
                assert.deepEqual(command.input, { requestId: "fetch-id", interceptResponse: false });
            }
            if (succeeds && scenario.startsWith("transport-response") && !actualResponse) {
                assert.deepEqual(commands.filter(command => command.method === "Fetch.failRequest").map(command => command.input),
                    [{ requestId: "fetch-id", errorReason: "Failed" }]);
            }
            assert.equal(gate.pendingCount, 0, scenario);
            gate.retire();
            continue;
        }
        const request = handlers.get("Fetch.requestPaused")(event);
        if (block) {
            assert.equal(commands.at(-1).method, "Fetch.failRequest", scenario);
            assert.equal(commands.some(item => item.method === "Fetch.continueRequest"), false, "The denied request must never dispatch.");
            if (abortBeforeAck) {
                handlers.get("Network.loadingFailed")(terminal);
                assert.equal(gate.pendingCount, 1, "A terminal event alone must not retire an unacknowledged abort.");
                assert.equal(scope.abort.signal.aborted, false);
                if (scenario === "abort-terminal-first-duplicate") handlers.get("Network.loadingFailed")(terminal);
                if (scenario === "abort-terminal-first-conflict") handlers.get("Network.loadingFinished")(terminal);
                if (scenario === "abort-rejected") deferred.reject(new Error("Abort acknowledgment failed"));
                else deferred.resolve();
                await request;
            } else {
                await request;
                assert.equal(gate.pendingCount, 1, "Keep the acknowledged abort until its actual terminal event.");
                handlers.get(scenario === "abort-finished" ? "Network.loadingFinished" : "Network.loadingFailed")(
                    scenario === "abort-unmatched-failure" ? Object.create(terminal, { requestId: { value: "different-id" } }) : terminal);
                if (scenario === "abort-duplicate-terminal") handlers.get("Network.loadingFailed")(terminal);
            }
            assert.equal(scope.firstPolicyBlock.reason, "data-dependency");
            assert.equal(scope.firstPolicyBlock.abortAcknowledged, scenario !== "abort-rejected");
            assert.doesNotMatch(JSON.stringify(scope.firstPolicyBlock), /DO_NOT_CAPTURE|network-id|fetch-id|https:/);
            assert.deepEqual(stopped, scenario === "abort-rejected" ? ["policy-abort-failed"]
                : scenario === "abort-finished" ? ["network-block-completed"]
                    : ["abort-unmatched-failure", "abort-duplicate-terminal"].includes(scenario) ? ["network-record-missing"]
                        : scenario === "abort-terminal-first-duplicate" ? ["network-terminal-duplicate"]
                            : scenario === "abort-terminal-first-conflict" ? ["network-terminal-conflict"] : []);
        } else {
            await request;
            if (scenario.startsWith("allowed-after-headers") || scenario === "allowed-finish-before-ack") {
                const response = handlers.get("Fetch.requestPaused")({ ...event, responseStatusCode: 200 });
                if (scenario === "allowed-finish-before-ack") {
                    handlers.get("Network.loadingFinished")(terminal);
                    assert.equal(gate.pendingCount, 1);
                    deferred.resolve();
                    await response;
                } else {
                    await response;
                    assert.equal(gate.pendingCount, 1, "Headers are not request completion.");
                }
            }
            if (scenario !== "allowed-finish-before-ack") {
                handlers.get(["unmatched-finish", "allowed-finish-without-headers"].includes(scenario) ? "Network.loadingFinished" : "Network.loadingFailed")(
                    Object.create(terminal, { requestId: { value: scenario.startsWith("unmatched-") ? "unknown-id" : terminal.requestId } }));
            }
            assert.deepEqual(stopped, scenario === "allowed-finish-before-ack" ? []
                : scenario.startsWith("unmatched-") ? ["network-record-missing"]
                    : scenario === "allowed-finish-without-headers" ? ["network-completion-state"] : ["request-failed"]);
        }
        assert.equal(gate.pendingCount, 0, scenario);
        gate.retire();
    }
});

test("different Chat actions require exact original denial settlement and never inherit source authority", async t => {
    for (const scenario of ["ack-first", "terminal-first", "preflight", "preflight-at-capacity", "preflight-without-decision", "preflight-wrong-link",
        "ack-invalid", "ack-rejected", "owner-loss", "expired", "unowned", "missing-binding",
        "terminal-success", "terminal-duplicate", "replay", "replay-upgrade", "limit"]) {
        await t.test(scenario, async () => {
            const handlers = new Map(), calls = [], pending = new Set(), ack = Promise.withResolvers();
            const url = "https://m365.cloud.microsoft/_serverFn/" + nativeHistoryProducer.chatRpcId;
            const scope = { abort: new AbortController(), page: { url: () => "https://m365.cloud.microsoft/home" },
                native: { currentDocument: { epoch: 1, entry: { networkId: "document" } } } };
            let current = scope, stopped, upgraded = false;
            const gate = await guardAccountOnlyRequests({
                on: (name, handler) => handlers.set(name, handler),
                async send(method, input) {
                    calls.push({ method, input });
                    if (method === "Fetch.failRequest" && input.requestId === "post") {
                        if (scenario === "ack-invalid") return [];
                        if (scenario === "ack-rejected") throw new Error("PRIVATE_ABORT_FAILURE");
                        if (["terminal-first", "owner-loss"].includes(scenario)) return ack.promise;
                    }
                    return {};
                },
            }, {
                mainFrameId: "root", getScope: () => current,
                track(work) { pending.add(work); work.finally(() => pending.delete(work)); return work; },
                stop(owner, reason, facts) {
                    stopped ??= reason;
                    const failure = nativeFailureDetails(nativeProtocolFailure(reason, facts, { scope: owner, mainFrameId: "root" }));
                    assert.equal(validNativeFailure({ ...failure, recordedAt: new Date().toISOString() }), true);
                    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_|https?:/);
                    owner?.abort.abort();
                },
                responded() {},
                chatActionUrl: (_owner, candidate) => candidate?.href === url,
                chatActionPreflight(owner, facts) {
                    const record = owner.native.requestOrigins?.get(facts.networkId);
                    return record?.initiatorType === "preflight" ? {
                        networkId: record.initiatorRequestId,
                        current: () => owner === current,
                        check: async () => owner === current,
                    } : null;
                },
                bindChatAction(owner, facts) {
                    const record = owner.native.requestOrigins?.get(facts.networkId);
                    if (scenario === "missing-binding" || !record || record.duplicate || record.chatActionDenied) return null;
                    record.chatActionDenied = true;
                    return { deadline: Date.now() + (scenario === "expired" ? -1 : 10000),
                        current: () => owner === current && !owner.abort.signal.aborted,
                        check: async () => owner === current && !owner.abort.signal.aborted };
                },
                admit(_owner, _facts, _stage, readBody) {
                    const value = classifyNativeHistoryRequest(readBody());
                    assert.equal(value.kind, "different-action");
                    return "blocked-chat-action";
                },
            });
            const body = JSON.stringify(inventedNativeWire({ data: { action: "PRIVATE_DIFFERENT_ACTION",
                unknown: { private: "PRIVATE_STATE" } }, context: { private: "PRIVATE_CONTEXT" } }));
            const request = (id, preflight = false) => ({ requestId: id, networkId: id + "-network",
                frameId: scenario === "unowned" ? "foreign" : "root", resourceType: preflight ? "Other" : "Fetch",
                request: { url, method: preflight ? "OPTIONS" : "POST",
                    get postData() {
                        assert.equal(preflight, false, "A preflight cannot inspect a POST body.");
                        return upgraded ? JSON.stringify(inventedNativeWire({ data: { action: "GetConversationPageHistoryList" } })) : body;
                    },
                    get headers() { assert.fail("Denial must not inspect headers."); } } });
            const network = (id, preflight = false) => handlers.get("Network.requestWillBeSent")({
                requestId: id + "-network", frameId: preflight ? undefined : "root", loaderId: "document",
                type: preflight ? "Other" : "Fetch", request: { url, method: preflight ? "OPTIONS" : "POST" },
                initiator: preflight ? { type: "preflight",
                    requestId: scenario === "preflight-wrong-link" ? "other-network" : "post-network" } : { type: "script" },
            });
            const fail = id => handlers.get("Network.loadingFailed")({ requestId: id + "-network" });
            try {
                if (scenario === "preflight-without-decision") {
                    network("post");
                    network("preflight", true);
                    await handlers.get("Fetch.requestPaused")(request("preflight", true));
                    assert.equal(stopped, "chat-action-preflight");
                } else if (scenario === "limit") {
                    for (let index = 0; index < 512; index++) {
                        const id = "limited-" + index;
                        network(id);
                        await handlers.get("Fetch.requestPaused")(request(id));
                        fail(id);
                    }
                    network("overflow");
                    await handlers.get("Fetch.requestPaused")(request("overflow"));
                    assert.equal(stopped, "chat-action-association", "Exhausted original metadata cannot authorize another denial.");
                    assert.equal(scope.blockedChatActions.posts, 512);
                } else {
                    network("post");
                    const work = handlers.get("Fetch.requestPaused")(request("post"));
                    while (!calls.some(row => row.method === "Fetch.failRequest") && !stopped) await new Promise(setImmediate);
                    if (scenario === "terminal-first") {
                        fail("post");
                        assert.equal(gate.pendingCount, 1);
                        ack.resolve({});
                    } else if (scenario === "owner-loss") {
                        current = null; ack.resolve({});
                    }
                    await work;
                    if (["preflight", "preflight-at-capacity", "preflight-wrong-link"].includes(scenario)) {
                        if (scenario === "preflight-at-capacity") {
                            for (let index = 0; index < 127; index++) {
                                const id = "held-" + index;
                                network(id);
                                await handlers.get("Fetch.requestPaused")(request(id));
                            }
                            assert.equal(gate.pendingCount, 128);
                        }
                        network("preflight", true);
                        const preflight = handlers.get("Fetch.requestPaused")(request("preflight", true));
                        if (scenario === "preflight-at-capacity") {
                            assert.equal(gate.pendingCount, 129);
                            assert.equal(calls.some(row => row.method === "Fetch.failRequest" && row.input.requestId === "preflight"), false);
                            fail("post");
                        }
                        await preflight;
                        if (["preflight", "preflight-at-capacity"].includes(scenario)) {
                            fail("preflight");
                            if (scenario === "preflight") fail("post");
                            else for (let index = 0; index < 127; index++) fail("held-" + index);
                            assert.equal(scope.blockedChatActions.preflights, 1);
                            assert.equal(scope.blockedChatActions.failedPreflights, 1);
                            assert.equal(scope.blockedChatActions.acknowledged, scenario === "preflight" ? 2 : 129);
                        } else assert.equal(stopped, "chat-action-preflight");
                    } else if (scenario === "terminal-success") {
                        handlers.get("Network.loadingFinished")({ requestId: "post-network" });
                        assert.equal(stopped, "network-block-completed");
                    } else if (["ack-first", "terminal-duplicate", "replay", "replay-upgrade"].includes(scenario)) {
                        assert.equal(gate.pendingCount, 1);
                        fail("post");
                        if (scenario === "terminal-duplicate") { fail("post"); assert.equal(stopped, "network-record-missing"); }
                        if (["replay", "replay-upgrade"].includes(scenario)) {
                            if (scenario === "replay-upgrade") { upgraded = true; network("post"); }
                            await handlers.get("Fetch.requestPaused")(request("post"));
                            assert.equal(stopped, "chat-action-association");
                        }
                    }
                    const expected = { "ack-invalid": "chat-action-acknowledgement", "ack-rejected": "policy-abort-failed",
                        "owner-loss": "chat-action-owner-changed", expired: "chat-action-association",
                        unowned: "unowned-frame", "missing-binding": "chat-action-association" }[scenario];
                    if (expected) assert.equal(stopped, expected);
                }
                if (["ack-first", "terminal-first", "preflight", "preflight-at-capacity"].includes(scenario)) {
                    assert.equal(stopped, undefined);
                    assert.equal(scope.blockedChatActions.failedPosts, scenario === "preflight-at-capacity" ? 128 : 1);
                }
                assert.equal(gate.pendingCount, 0);
                assert.equal(calls.some(row => ["Fetch.continueRequest", "Fetch.continueResponse", "Fetch.fulfillRequest"].includes(row.method)), false);
                assert.doesNotMatch(JSON.stringify(scope.blockedChatActions ?? null), /PRIVATE_/);
            } finally {
                ack.resolve({}); gate.retire();
                await Promise.all([...pending]);
            }
        });
    }
});

test("bounded capacity waits preserve original ownership, reservations and genuine settlement", async t => {
    for (const scenario of ["ack-first", "terminal-first", "reservations", "saturation", "deadline",
        "cancel", "owner-loss", "document-loss", "protocol-loss", "redirect-replaces", "abort-settlement",
        "duplicate-waiter", "two-slot-preflight", "original-timeout-first", "metadata-rendezvous"]) {
        await t.test(scenario, async t => {
            t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
            const handlers = new Map(), commands = [], pending = new Set(), deferred = [];
            const metadata = Promise.withResolvers();
            const scope = { abort: new AbortController() };
            let current = scope, document = {}, admissionCalls = 0, firstFailure, lastBinding;
            const stop = (owner, reason, facts, observation) => {
                if (owner.abort.signal.aborted) return;
                firstFailure ??= nativeFailureDetails(nativeProtocolFailure(reason, facts, {
                    scope: owner, mainFrameId: "root", observation,
                }));
                owner.abort.abort();
            };
            const gate = await guardAccountOnlyRequests({
                on(name, handler) { handlers.set(name, handler); },
                async send(method, input) { commands.push({ method, input }); return {}; },
            }, {
                mainFrameId: "root", getScope: () => current, stop, responded() {},
                track(work) {
                    pending.add(work);
                    work.then(() => pending.delete(work), () => pending.delete(work));
                    return work;
                },
                bindRequestCapacity(owner, facts, { waitForMetadata }) {
                    const originalDocument = document;
                    lastBinding = { deadline: 1001000, current: () => owner === current && document === originalDocument };
                    if (scenario === "metadata-rendezvous" && waitForMetadata && facts.networkId === "network-128") {
                        lastBinding.associate = () => {
                            assert.equal(gate.pendingCount, 129, "Count the original handler before metadata waiting starts.");
                            return metadata.promise;
                        };
                    }
                    return lastBinding;
                },
                admit(owner, facts) {
                    admissionCalls++;
                    if (scenario === "reservations" && admissionCalls <= 128) {
                        const wait = Promise.withResolvers();
                        deferred.push(wait);
                        return wait.promise;
                    }
                    return facts.url.pathname === "/blocked" ? "policy-block" : "static";
                },
            });
            t.after(async () => {
                metadata.resolve(null);
                for (const wait of deferred) wait.resolve("static");
                gate.retire();
                await Promise.all([...pending]);
            });
            const request = index => ({
                requestId: `fetch-${index}`, networkId: `network-${index}`, frameId: "root",
                resourceType: scenario === "abort-settlement" && index < 128 ? "Fetch" : "Script",
                request: { url: scenario === "abort-settlement" && index < 128
                    ? "https://example.invalid/blocked" : "https://aadcdn.msauth.net/fixture-wait.js",
                method: "GET", get postData() { assert.fail("Capacity must not read bodies."); } },
            });
            const emit = event => handlers.get("Fetch.requestPaused")(event);
            const held = Array.from({ length: 128 }, (_, index) => request(index));
            const opening = [];
            for (const event of held) {
                const work = emit(event);
                if (scenario === "reservations") opening.push(work);
                else await work;
            }
            assert.equal(gate.pendingCount, 128);
            if (scenario === "redirect-replaces") {
                await emit({ ...held[0], responseStatusCode: 302 });
                const redirected = { ...held[0], requestId: "redirect", redirectedRequestId: held[0].requestId };
                await emit(redirected);
                assert.equal(gate.pendingCount, 128);
                assert.equal(commands.filter(row => row.method === "Fetch.continueRequest" && row.input.requestId === "redirect").length, 1);
                await emit({ ...redirected, responseStatusCode: 200 });
                handlers.get("Network.loadingFinished")({ requestId: held[0].networkId });
                assert.equal(gate.pendingCount, 127);
                assert.equal(firstFailure, undefined);
                return;
            }
            const waiter = request(128);
            if (scenario === "two-slot-preflight") {
                waiter.request.method = "OPTIONS";
                waiter.resourceType = "Other";
            }
            const waiting = emit(waiter);
            assert.equal(gate.pendingCount, 129);
            assert.equal(admissionCalls, 128, "Queued traffic must not reach asynchronous source admission.");
            assert.equal(commands.some(row => row.method === "Fetch.continueRequest" && row.input.requestId === waiter.requestId), false);
            if (scenario === "metadata-rendezvous") {
                await emit({ ...held[0], responseStatusCode: 200 });
                handlers.get("Network.loadingFinished")({ requestId: held[0].networkId });
                await new Promise(setImmediate);
                assert.equal(admissionCalls, 128, "Settlement must drain without granting incomplete metadata authority.");
                assert.equal(gate.pendingCount, 128, "The freed slot remains reserved for the metadata handler.");
                const later = request(129), laterWork = emit(later);
                assert.equal(gate.pendingCount, 129);
                assert.equal(admissionCalls, 128, "A later request cannot steal that reservation.");
                metadata.resolve(null);
                await waiting;
                assert.equal(admissionCalls, 129);
                assert.equal(commands.filter(row => row.method === "Fetch.continueRequest" && row.input.requestId === waiter.requestId).length, 1);
                await emit({ ...held[1], responseStatusCode: 200 });
                handlers.get("Network.loadingFinished")({ requestId: held[1].networkId });
                await laterWork;
                assert.equal(admissionCalls, 130);
                assert.equal(firstFailure, undefined);
                return;
            }
            if (scenario === "two-slot-preflight") {
                const later = request(129), laterWork = emit(later);
                await emit({ ...held[0], responseStatusCode: 200 });
                handlers.get("Network.loadingFinished")({ requestId: held[0].networkId });
                await new Promise(setImmediate);
                assert.equal(admissionCalls, 128, "A later single-slot arrival cannot starve the earlier two-slot preflight.");
                await emit({ ...held[1], responseStatusCode: 200 });
                handlers.get("Network.loadingFinished")({ requestId: held[1].networkId });
                await Promise.all([waiting, laterWork]);
                assert.equal(admissionCalls, 130);
                assert.equal(gate.pendingCount, 128);
                assert.equal(firstFailure, undefined);
                return;
            } else if (scenario === "duplicate-waiter") {
                await emit(waiter);
                await waiting;
                assert.equal(firstFailure.protocolStop.reason, "capacity-duplicate");
                assert.equal(firstFailure.protocolStop.capacity.waiting, 1);
            } else if (scenario === "saturation") {
                const queued = [waiting];
                for (let index = 129; index < 512; index++) queued.push(emit(request(index)));
                assert.equal(gate.pendingCount, 512);
                await emit(request(512));
                await Promise.all(queued);
                assert.equal(firstFailure.protocolStop.reason, "capacity-queue-full");
                assert.deepEqual(firstFailure.protocolStop.capacity, { active: 128, reserved: 0, waiting: 384,
                    withoutTerminal: 128, withoutAcknowledgement: 128, redirecting: 0 });
            } else if (scenario === "original-timeout-first") {
                t.mock.timers.setTime(1001000);
                const original = new MicrosoftSessionError("timed-out");
                assert.equal(gate.preserveCapacityTimeout(scope, original), original);
                const detail = nativeFailureDetails(original);
                assert.equal(detail.code, "timed-out", "The earlier original deadline error remains the first cause.");
                assert.equal(detail.protocolStop.reason, "capacity-deadline");
                assert.equal(detail.protocolStop.capacity.waiting, 1);
                assert.equal(validNativeFailure({ ...detail, recordedAt: new Date().toISOString() }), true);
                scope.abort.abort();
                await waiting;
                assert.equal(firstFailure, undefined);
            } else if (scenario === "deadline") {
                lastBinding.deadline += 1000;
                t.mock.timers.tick(1000);
                await waiting;
                assert.equal(firstFailure.protocolStop.reason, "capacity-deadline");
                assert.equal(firstFailure.protocolStop.capacity.waiting, 1);
            } else if (scenario === "cancel") {
                scope.abort.abort();
                await waiting;
                assert.equal(firstFailure, undefined, "Cancellation must not invent another original failure.");
                assert.equal(gate.pendingCount, 128, "Cancelling a waiter must not retire unfinished active requests.");
            } else if (["owner-loss", "document-loss"].includes(scenario)) {
                if (scenario === "owner-loss") current = { abort: new AbortController() };
                else document = {};
                handlers.get("Page.frameDetached")({ frameId: "root" });
                await waiting;
                assert.equal(firstFailure.protocolStop.reason, "capacity-owner-changed");
            } else if (scenario === "protocol-loss") {
                handlers.get("close")();
                await waiting;
                assert.equal(firstFailure.protocolStop.reason, "protocol-coverage");
                assert.equal(firstFailure.protocolStop.capacity.waiting, 1);
            } else {
                if (scenario === "reservations") {
                    assert.equal(commands.filter(row => row.method === "Fetch.continueRequest").length, 0);
                    deferred[0].resolve("static");
                    await opening[0];
                    assert.equal(admissionCalls, 128, "Converting a reservation to active does not free capacity.");
                }
                if (scenario === "abort-settlement") {
                    assert.equal(commands.filter(row => row.method === "Fetch.failRequest").length, 128);
                    handlers.get("Network.loadingFailed")({ requestId: held[0].networkId });
                } else {
                    const response = emit({ ...held[0], responseStatusCode: 200 });
                    if (scenario !== "terminal-first") await response;
                    handlers.get("Network.loadingFinished")({ requestId: held[0].networkId });
                    await response;
                }
                await waiting;
                if (scenario === "reservations") {
                    for (const wait of deferred) wait.resolve("static");
                    await Promise.all(opening);
                }
                assert.equal(admissionCalls, 129);
                assert.equal(gate.pendingCount, 128);
                assert.equal(commands.filter(row => row.method === "Fetch.continueRequest" && row.input.requestId === waiter.requestId).length, 1);
                assert.equal(firstFailure, undefined);
                return;
            }
            assert.equal(commands.some(row => row.method === "Fetch.continueRequest" && row.input.requestId === waiter.requestId), false);
            if (firstFailure) {
                assert.equal(validNativeFailure({ ...firstFailure, recordedAt: new Date().toISOString() }), true);
                assert.doesNotMatch(JSON.stringify(firstFailure), /https?:|fetch-|network-|fixture-wait/);
                const preserved = structuredClone(firstFailure);
                handlers.get("close")();
                assert.deepEqual(firstFailure, preserved);
            }
        });
    }
});

test("protocol capacity counts outstanding Fetch entries, not settled originals or response stages", async () => {
    const handlers = new Map(), commands = [], stopped = [];
    const scope = { abort: new AbortController() };
    const gate = await guardAccountOnlyRequests({
        on: (name, handler) => handlers.set(name, handler),
        async send(method, input) { commands.push({ method, input }); return {}; },
    }, {
        mainFrameId: "root", getScope: () => scope, track: work => work, responded() {},
        admit(current, facts) { return accountOnlyRequestDecision(facts).kind; },
        stop(current, reason, facts) {
            stopped.push({ reason, original: facts?.original, stage: facts?.stage, type: facts?.type });
            current.abort.abort();
        },
    });
    const request = index => ({
        requestId: `fetch-${index}`, networkId: `network-${index}`, frameId: "root", resourceType: "Script",
        request: { url: "https://aadcdn.msauth.net/fixture-cap-script.js", method: "GET",
            get postData() { assert.fail("No source body access."); },
            get headers() { assert.fail("No source header access."); } },
    });
    const pause = event => handlers.get("Fetch.requestPaused")(event);
    const finish = event => handlers.get("Network.loadingFinished")({ requestId: event.networkId });
    for (let index = 0; index < 256; index++) {
        const event = request(index);
        await pause(event);
        if (index % 2) await pause({ ...event, responseStatusCode: 200 });
        else {
            const response = pause({ ...event, responseStatusCode: 200 });
            finish(event);
            await response;
        }
        if (index % 2) finish(event);
        assert.equal(gate.pendingCount, 0, "Both acknowledgement/terminal orders must retire the original slot.");
    }
    const held = Array.from({ length: 128 }, (_, index) => request(index + 256));
    for (const event of held) {
        await pause(event);
        await pause({ ...event, responseStatusCode: 200 });
    }
    assert.equal(gate.pendingCount, 128, "Headers do not release entries; the request/response stages share one slot.");
    finish(held[0]);
    assert.equal(gate.pendingCount, 127);
    await pause(request(384));
    assert.equal(gate.pendingCount, 128, "A completed entry frees exactly one slot.");
    await pause(request(385));
    assert.deepEqual(stopped, [{ reason: "protocol-cap", original: true, stage: "request", type: "script" }]);
    assert.equal(commands.some(row => row.method === "Fetch.continueRequest" && row.input.requestId === "fetch-385"), false);
    assert.equal(gate.active, false);
    assert.equal(gate.pendingCount, 0, "Fatal retirement clears correlation bookkeeping, not a new allowance.");
});

test("account-only protocol correlation is bounded, owned and retired on rejection or completion", async t => {
    for (const scenario of ["unmatched-response", "orphan-redirect", "frame-less", "missing-network-id", "replaced-scope",
        "invalid-network-id", "long-network-id", "reused-network-id", "redirect-network-id-mismatch", "fetch-other-network-fetch",
        "in-flight-cap", "headers-cap", "policy-abort-cap", "redirect-cap", "complete", "retired", "network-owner-replaced"]) {
        const handlers = new Map(), commands = [], stopped = [], contexts = [];
        let scope = { abort: new AbortController() };
        const protocol = { on: (event, handler) => handlers.set(event, handler),
            async send(method, input) { commands.push({ method, input }); } };
        const stop = (current, reason, facts) => {
            if (!current || current.abort.signal.aborted) return;
            stopped.push(reason); contexts.push(accountOnlyDenialContext(facts)); current.accountDenied = reason; current.abort.abort();
        };
        const gate = await guardAccountOnlyRequests(protocol, {
            mainFrameId: "owned", getScope: () => scope, stop, track: work => work, responded() {},
            admit(current, facts) {
                const decision = accountOnlyRequestDecision(facts);
                if (decision.blockOnly === true) return "policy-block";
                if (decision.denied) stop(current, decision.denied, facts);
                return decision.kind;
            },
        });
        const event = { requestId: "first", networkId: "network", frameId: "owned",
            resourceType: scenario === "fetch-other-network-fetch" ? "Other" : scenario === "policy-abort-cap" ? "Fetch" : "Document", request: {
            url: ["policy-abort-cap", "fetch-other-network-fetch"].includes(scenario) ? "https://example.invalid/config" : nativeApplicationEntry, method: "GET",
            get headers() { assert.fail("No header access."); }, get postData() { assert.fail("No body access."); },
        } };
        const emit = value => handlers.get("Fetch.requestPaused")(value);
        if (scenario === "fetch-other-network-fetch") {
            handlers.get("Network.requestWillBeSent")({ requestId: event.networkId, frameId: "owned", type: "Fetch", request: event.request });
            await emit(event);
            assert.deepEqual(commands.at(-1), { method: "Fetch.failRequest",
                input: { requestId: event.requestId, errorReason: "BlockedByClient" } });
            assert.equal(scope.abort.signal.aborted, true, "Fetch Other must stop Connect despite Network Fetch metadata.");
            assert.deepEqual(stopped, ["data-dependency"]);
            assert.equal(gate.active, false);
            assert.equal(scope.firstPolicyBlock ?? null, null);
            handlers.get("Network.loadingFailed")({ requestId: event.networkId, type: "Fetch",
                get errorText() { assert.fail("No error-text fallback."); } });
            assert.equal(commands.some(command => command.method === "Fetch.continueRequest"), false, "The request must never be continued.");
            assert.equal(scope.abort.signal.aborted, true, "The terminal label cannot undo the stop.");
            assert.equal(gate.active, false);
            assert.equal(scope.firstPolicyBlock ?? null, null, "The terminal label cannot promote the request into block-only handling.");
        }
        if (scenario === "unmatched-response") await emit({ ...event, responseStatusCode: 200 });
        if (scenario === "orphan-redirect") await emit({ ...event, redirectedRequestId: "missing" });
        if (scenario === "frame-less") await emit({ ...event, frameId: undefined });
        if (scenario === "missing-network-id") await emit({ ...event, networkId: undefined });
        if (scenario === "invalid-network-id") await emit({ ...event, networkId: "" });
        if (scenario === "long-network-id") await emit({ ...event, networkId: "n".repeat(257) });
        if (["reused-network-id", "redirect-network-id-mismatch"].includes(scenario)) {
            await emit(event);
            if (scenario === "redirect-network-id-mismatch") await emit({ ...event, responseStatusCode: 302 });
            await emit({ ...event, requestId: "next", ...(scenario === "redirect-network-id-mismatch"
                ? { redirectedRequestId: event.requestId, networkId: "changed-network" } : {}) });
        }
        if (scenario === "network-owner-replaced") {
            await emit(event);
            scope = { abort: new AbortController() };
            handlers.get("Network.loadingFailed")({ requestId: event.networkId, type: "Document" });
        }
        if (["replaced-scope", "complete", "retired"].includes(scenario)) {
            await emit(event);
            assert.equal(gate.pendingCount, 1);
            if (scenario === "replaced-scope") scope = { abort: new AbortController() };
            if (scenario === "retired") gate.retire();
            await emit({ ...event, responseStatusCode: 200 });
            if (scenario === "complete") handlers.get("Network.loadingFinished")({ requestId: event.networkId });
        }
        if (["in-flight-cap", "headers-cap", "policy-abort-cap"].includes(scenario)) {
            for (let index = 0; index <= 128; index++) {
                const request = { ...event, requestId: String(index), networkId: "network-" + index };
                await emit(request);
                if (scenario === "headers-cap" && !scope.abort.signal.aborted) await emit({ ...request, responseStatusCode: 200 });
            }
        }
        if (scenario === "redirect-cap") {
            for (let index = 0; index <= 20; index++) {
                const request = { ...event, requestId: String(index), ...(index ? { redirectedRequestId: String(index - 1) } : {}) };
                await emit(request);
                if (!scope.abort.signal.aborted) await emit({ ...request, responseStatusCode: 302 });
            }
        }
        assert.equal(gate.pendingCount, 0, scenario);
        assert.deepEqual(stopped, ["complete", "retired"].includes(scenario) ? [] : [scenario === "orphan-redirect"
            ? "redirect-correlation" : scenario === "frame-less" ? "unowned-frame" : scenario.endsWith("-cap")
                ? "protocol-cap" : scenario === "missing-network-id" ? "network-id-missing"
                    : ["invalid-network-id", "long-network-id"].includes(scenario) ? "network-id-invalid"
                        : scenario === "reused-network-id" ? "network-id-reused"
                            : scenario === "redirect-network-id-mismatch" ? "network-redirect-id-mismatch"
                                : scenario === "network-owner-replaced" ? "network-scope-mismatch"
                                    : scenario === "fetch-other-network-fetch" ? "data-dependency" : "response-correlation"], scenario);
        assert.equal(commands.at(-1).method, scenario === "network-owner-replaced" ? "Fetch.continueRequest"
            : scenario === "complete" ? "Fetch.continueResponse" : "Fetch.failRequest", scenario);
        if (stopped.length) {
            assert.equal(contexts[0].owned, scenario !== "frame-less");
            assert.equal(contexts[0].original, !["orphan-redirect", "redirect-cap", "redirect-network-id-mismatch"].includes(scenario));
            assert.equal(contexts[0].target, ["policy-abort-cap", "fetch-other-network-fetch"].includes(scenario) ? "other" : "shell");
            if (scenario === "fetch-other-network-fetch") assert.equal(contexts[0].resourceType, "other");
            if (scenario === "network-owner-replaced") assert.equal(contexts[0].stage, "request", "Retain the prior entry facts, not an invented current owner.");
        }
        gate.retire();
    }
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const scenario of ["current-root", "owned-descendant", "descendant-changed-root", "unknown-frame",
        "missing-frame-id", "invalid-frame-id", "long-frame-id", "missing-tree", "null-node", "array-node",
        "missing-frame", "empty-tree-id", "long-tree-id", "root-parent", "duplicate", "cycle",
        "inconsistent-parent", "missing-parent", "invalid-children", "128-frames", "129-frames", "16-levels", "17-levels",
        "query-rejected", "timeout", "late-after-timeout", "stale-before", "stale-after",
        "page-replaced", "stale-after-query", "closed-before", "closed-after",
        "frame-navigation", "frame-detach", "frame-attach", "page-close", "protocol-close"]) {
        const commands = [], stopped = [], deferred = Promise.withResolvers();
        const page = new EventEmitter();
        let closed = scenario === "closed-before";
        page.isClosed = () => closed;
        const firstPolicyBlock = { reason: "data-dependency", abortAcknowledged: true };
        const scope = { page, abort: new AbortController(), accountFrameDiagnosis: null, firstPolicyBlock };
        let current = scope;
        const node = (id, parentId) => ({ frame: { id, ...(parentId === undefined ? {} : { parentId }),
            get url() { assert.fail("Frame URLs must not be read."); },
            get name() { assert.fail("Frame names must not be read."); },
            get securityOrigin() { assert.fail("Frame origins must not be read."); } } });
        let tree = node("pinned");
        tree.childFrames = [node("candidate", "pinned")];
        if (scenario === "current-root") tree = node("candidate");
        if (scenario === "descendant-changed-root") {
            tree = node("replacement");
            tree.childFrames = [node("candidate", "replacement")];
        }
        if (scenario === "missing-tree") tree = undefined;
        if (scenario === "null-node") tree.childFrames.push(null);
        if (scenario === "array-node") tree.childFrames.push([]);
        if (scenario === "missing-frame") tree.childFrames.push({});
        if (scenario === "empty-tree-id") tree.childFrames.push(node("", "pinned"));
        if (scenario === "long-tree-id") tree.childFrames.push(node("x".repeat(257), "pinned"));
        if (scenario === "root-parent") tree.frame.parentId = "foreign";
        if (scenario === "duplicate") tree.childFrames.push(node("candidate", "pinned"));
        if (scenario === "cycle") tree.childFrames[0].childFrames = [tree];
        if (scenario === "inconsistent-parent") tree.childFrames[0].frame.parentId = "foreign";
        if (scenario === "missing-parent") delete tree.childFrames[0].frame.parentId;
        if (scenario === "invalid-children") tree.childFrames = {};
        if (["128-frames", "129-frames"].includes(scenario)) {
            for (let index = 2; index < (scenario === "128-frames" ? 128 : 129); index++) {
                tree.childFrames.push(node("sibling-" + index, "pinned"));
            }
        }
        if (["16-levels", "17-levels"].includes(scenario)) {
            tree = node("pinned");
            let parent = tree;
            for (let level = 2; level <= (scenario === "16-levels" ? 16 : 17); level++) {
                const child = node(level === 2 ? "candidate" : "level-" + level, parent.frame.id);
                parent.childFrames = [child];
                parent = child;
            }
        }
        const protocol = new EventEmitter();
        protocol.send = async (method, input) => {
            commands.push({ method, input });
            if (method === "Fetch.failRequest" && scenario === "stale-after-query") return deferred.promise;
            if (method !== "Page.getFrameTree") return;
            assert.equal(scope.abort.signal.aborted, true, "The diagnostic must not delay the fatal stop.");
            assert.equal(commands.some(command => command.method === "Fetch.failRequest"), true,
                "Abort must already be dispatched before querying the frame relationship.");
            if (scenario === "query-rejected") throw new Error("DO_NOT_CAPTURE");
            if (["timeout", "late-after-timeout"].includes(scenario)) return deferred.promise;
            if (scenario === "stale-after") current = { page, abort: new AbortController() };
            if (scenario === "page-replaced") scope.page = new EventEmitter();
            if (scenario === "closed-after") closed = true;
            const racingEvent = { "frame-navigation": "framenavigated", "frame-detach": "framedetached",
                "frame-attach": "frameattached", "page-close": "close" }[scenario];
            if (racingEvent) page.emit(racingEvent);
            if (scenario === "protocol-close") protocol.emit("close");
            return { frameTree: tree };
        };
        const stop = (value, reason) => {
            if (!value || value.abort.signal.aborted) return;
            stopped.push(reason); value.accountDenied = reason; value.abort.abort();
            if (scenario === "stale-before") current = { page, abort: new AbortController() };
        };
        const gate = await guardAccountOnlyRequests(protocol, {
            mainFrameId: "pinned", getScope: () => current, stop, track: work => work, responded() {},
            admit(value, facts) {
                const decision = accountOnlyRequestDecision(facts);
                if (decision.denied) stop(value, decision.denied);
                return decision.kind;
            },
        });
        const event = { requestId: "denied-fetch", networkId: "denied-network",
            frameId: scenario === "missing-frame-id" ? undefined : scenario === "invalid-frame-id" ? 7
                : scenario === "long-frame-id" ? "x".repeat(257) : scenario === "unknown-frame" ? "absent" : "candidate",
            resourceType: "Document", request: { method: "GET", url: "https://example.invalid/unknown?DO_NOT_CAPTURE" } };
        const paused = protocol.listeners("Fetch.requestPaused")[0];
        const pending = paused(event);
        if (scenario === "stale-after-query") {
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(page.eventNames(), [], "The query settled while the abort acknowledgment was pending.");
            current = { page, abort: new AbortController() };
            deferred.resolve();
        }
        if (["timeout", "late-after-timeout"].includes(scenario)) {
            t.mock.timers.tick(999);
            await Promise.resolve();
            assert.equal(scope.accountFrameDiagnosis, null);
            assert.equal(scope.abort.signal.aborted, true);
            t.mock.timers.tick(1);
        }
        await pending;
        const expected = scenario === "current-root" ? { classification: "current-root", rootMatchesPinned: false }
            : ["owned-descendant", "descendant-changed-root", "128-frames", "16-levels"].includes(scenario)
                ? { classification: "owned-descendant", rootMatchesPinned: scenario !== "descendant-changed-root" }
                : { classification: "unresolved", rootMatchesPinned: scenario === "unknown-frame" ? true : null };
        assert.deepEqual(scope.accountFrameDiagnosis, expected, scenario);
        assert.deepEqual(stopped, ["unowned-frame"], scenario);
        assert.equal(scope.abort.signal.aborted, true, scenario);
        assert.equal(gate.active, false, scenario);
        assert.equal(gate.pendingCount, 0, scenario);
        assert.equal(scope.firstPolicyBlock, firstPolicyBlock, "A diagnosis must not replace the earlier policy block.");
        assert.equal(commands.some(command => command.method.startsWith("Fetch.continue")), false, scenario);
        assert.deepEqual(commands.filter(command => command.method === "Fetch.failRequest"),
            [{ method: "Fetch.failRequest", input: { requestId: event.requestId, errorReason: "BlockedByClient" } }], scenario);
        const queries = commands.filter(command => command.method === "Page.getFrameTree");
        assert.equal(queries.length, ["missing-frame-id", "invalid-frame-id", "long-frame-id", "stale-before", "closed-before"]
            .includes(scenario) ? 0 : 1, scenario);
        assert.ok(queries.every(command => command.input === undefined));
        assert.deepEqual(page.eventNames(), [], "Query-scoped race listeners must always be removed.");
        assert.equal(protocol.listenerCount("close"), 1, "Only the existing coverage listener remains.");
        assert.doesNotMatch(JSON.stringify(scope.accountFrameDiagnosis), /pinned|candidate|replacement|denied-|DO_NOT_CAPTURE|https:/);
        if (scenario === "late-after-timeout") {
            deferred.resolve({ frameTree: tree });
            await Promise.resolve();
            await Promise.resolve();
            assert.deepEqual(scope.accountFrameDiagnosis, expected, "Late success cannot replace unresolved.");
        }
        protocol.emit("Network.loadingFailed", { requestId: event.networkId, type: "Document" });
        await paused({ ...event, requestId: "after-stop" });
        assert.equal(commands.filter(command => command.method === "Page.getFrameTree").length, queries.length,
            "The closed operation must not query a second time.");
        assert.equal(commands.some(command => command.method.startsWith("Fetch.continue")), false);
        assert.deepEqual(stopped, ["unowned-frame"]);
        if (current !== scope) assert.equal(current.abort.signal.aborted, false, "Diagnostics cannot transfer a stop or authority to another scope.");
        gate.retire();
    }
    t.mock.timers.reset();
});

test("account-only self preflight requires exact browser initiator, URL, frame and GET association", async () => {
    for (const scenario of ["missing-parent", "wrong-parent", "parent-post", "parent-frame", "preflight-frame",
        "frame-less", "manual", "different-url", "missing-network-id", "redirected-parent", "redirected-preflight", "different-get", "spent-get",
        "failed-get-rebind", "finished-get-rebind", "failed-get-rebind-before-response", "finished-get-rebind-before-response"]) {
        const rebind = scenario.includes("-rebind");
        const handlers = new Map(), commands = [], denied = [];
        const scope = { abort: new AbortController(), accountSelf: { routed: false, protocolConsumed: scenario === "spent-get" },
            accountSelfPreflight: { consumed: false, associated: false, requestContinued: false, responseContinued: false } };
        const url = "https://graph.microsoft.com/v1.0/me";
        const request = (method, address = url) => ({ url: address, method,
            get headers() { assert.fail("No header access."); }, get postData() { assert.fail("No body access."); } });
        const stop = (_, reason) => { if (!scope.abort.signal.aborted) { denied.push(reason); scope.abort.abort(); } };
        const gate = await guardAccountOnlyRequests({ on: (event, handler) => handlers.set(event, handler),
            async send(method, input) { commands.push({ method, input }); } }, {
            mainFrameId: "owned", getScope: () => scope, stop, track: work => work,
            responded(_, kind) { if (kind === "self-preflight") scope.accountSelfPreflight.responseContinued = true; },
            admit(_, facts) {
                const decision = accountOnlyRequestDecision({ ...facts, pageOrigin: "https://m365.cloud.microsoft" });
                if (decision.denied) { stop(scope, decision.denied); return null; }
                if (decision.kind === "self-preflight") {
                    scope.accountSelfPreflight.consumed = true; scope.accountSelfPreflight.associated = true;
                }
                return decision.kind;
            },
        });
        const parent = {
            requestId: "get-network", frameId: scenario === "parent-frame" ? "foreign" : "owned", type: "Fetch",
            request: request(scenario === "parent-post" ? "POST" : "GET"),
        };
        if (scenario === "redirected-parent") Object.defineProperty(parent, "redirectResponse", {
            get() { assert.fail("No redirect headers/body access."); },
        });
        if (scenario !== "missing-parent") handlers.get("Network.requestWillBeSent")(parent);
        const preflightUrl = scenario === "different-url" ? url + "?$select=id" : url;
        handlers.get("Network.requestWillBeSent")({ requestId: "preflight-network", type: "Other",
            ...(scenario === "preflight-frame" ? { frameId: "foreign" } : {}),
            initiator: { type: scenario === "manual" ? "script" : "preflight",
                requestId: scenario === "wrong-parent" ? "different-parent" : "get-network",
                get url() { assert.fail("No initiator URL access."); }, get stack() { assert.fail("No stack access."); } },
            request: request("OPTIONS", preflightUrl),
        });
        const preflight = { requestId: "preflight", networkId: scenario === "missing-network-id" ? undefined : "preflight-network",
            frameId: scenario === "frame-less" ? undefined : "owned", resourceType: "Other",
            ...(scenario === "redirected-preflight" ? { redirectedRequestId: "earlier" } : {}), request: request("OPTIONS", preflightUrl) };
        await handlers.get("Fetch.requestPaused")(preflight);
        if (scenario === "different-get" || rebind) {
            assert.deepEqual(scope.accountSelf, { routed: false, protocolConsumed: false }, "OPTIONS must not consume the GET.");
            if (!scenario.endsWith("-before-response")) await handlers.get("Fetch.requestPaused")({ ...preflight, responseStatusCode: 204 });
            if (rebind) {
                handlers.get(scenario.startsWith("failed-") ? "Network.loadingFailed" : "Network.loadingFinished")({ requestId: "get-network" });
                handlers.get("Network.requestWillBeSent")({ ...parent, requestId: "different-get-network" });
            }
            await handlers.get("Fetch.requestPaused")({ requestId: "wrong-get", networkId: "different-get-network",
                frameId: "owned", resourceType: "Fetch", request: request("GET") });
            assert.equal(commands.some(item => item.method === "Fetch.continueRequest" && item.input.requestId === "wrong-get"), false,
                `${scenario}: the replacement GET must not dispatch after a consumed preflight loses its original GET`);
        }
        assert.deepEqual(denied, [scenario === "frame-less" ? "unowned-frame"
            : scenario === "redirected-preflight" ? "redirect-correlation"
                : rebind ? "network-record-missing" : scenario === "missing-network-id" ? "network-id-missing" : "self-preflight-association"], scenario);
        assert.equal(commands.at(-1).method, "Fetch.failRequest", scenario);
        assert.equal(scope.accountSelfPreflight.consumed, scenario === "different-get" || rebind, scenario);
        assert.deepEqual(scope.accountSelf, { routed: false, protocolConsumed: scenario === "spent-get" }, scenario);
        assert.equal(gate.selfAssociationCount, 0, scenario);
        gate.retire();
    }
});

test("account-only production gate covers cross-origin documents, static redirects and method changes before dispatch", { timeout: 30000 }, async t => {
    let browser, mode, base, authBase, streamedResponse;
    const streamHeaders = Promise.withResolvers();
    const streamBody = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const visits = [];
    const server = createServer((request, response) => {
        visits.push({ method: request.method, path: request.url, host: request.headers.host });
        let destination;
        if (request.url === "/chat" && ["return", "auth-data"].includes(mode)
            && visits.filter(item => item.path === "/chat").length === 1) destination = authBase + "/login";
        if (request.url === "/login") destination = base + (mode === "auth-data" ? "/api/tasks" : "/chat");
        if (request.url.startsWith("/entry.js") && mode === "static-data") destination = base + "/api/tasks";
        if (request.url === "/landingv2") destination = base + "/chat";
        if (request.url === "/fixture-stream.gif") {
            streamedResponse = response;
            response.writeHead(200, { "Content-Type": "image/gif", "Content-Length": streamBody.length });
            response.write(streamBody.subarray(0, 6));
            streamHeaders.resolve();
            return;
        }
        if (request.url === "/healthz") {
            if (mode === "allowed-before-headers") { request.socket.destroy(); return; }
            if (["allowed-after-headers", "soft-then-allowed-failure"].includes(mode)) {
                response.writeHead(200, { "Content-Length": "1" }); response.flushHeaders();
                setTimeout(() => response.destroy(), 25);
                return;
            }
            response.writeHead(mode === "allowed-http-failure" ? 500 : 200); response.end(); return;
        }
        if (request.url.startsWith("/entry.js") && mode.startsWith("soft-")) {
            response.writeHead(200, { "Content-Type": "application/javascript" }); response.end(); return;
        }
        if (request.url === "/token") {
            response.writeHead(request.method === "OPTIONS" ? 204 : mode === "token-redirect" ? 302 : 400, {
                "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST",
                "Access-Control-Allow-Headers": "X-Loopback-Check",
                ...(mode === "token-redirect" && request.method !== "OPTIONS" ? { Location: base + "/api/tasks" } : {}),
            });
            response.end();
            return;
        }
        if (request.url.startsWith("/me")) {
            response.writeHead(request.method === "OPTIONS" ? mode === "self-preflight-redirect" ? 302 : 204 : 200, {
                "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET",
                "Access-Control-Allow-Headers": "X-Loopback-Check",
                ...(mode === "self-preflight-redirect" ? { Location: base + "/api/tasks" } : {}),
            });
            response.end();
            return;
        }
        response.writeHead(destination ? mode === "post-307" ? 307 : mode === "post-303" ? 303 : 302 : 200,
            { "Content-Type": "text/html", ...(destination ? { Location: destination } : {}) });
        response.end(destination ? "" : '<link rel="icon" href="data:,">');
    });
    t.after(async () => {
        await browser?.close();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    authBase = `http://localhost:${server.address().port}`;
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    for (const next of ["return", "origin-commits", "auth-data", "static-data", "post-303", "post-307", "child", "coverage", "token-error", "token-redirect",
        "self-preflight", "self-preflight-redirect", "self-manual-options", "soft-block",
        "allowed-before-headers", "allowed-after-headers", "allowed-http-failure", "soft-then-allowed-failure", "streamed-static"]) {
        await t.test(next, async () => {
            mode = next; visits.length = 0;
            const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
            const tokenEndpoint = "https://login.microsoftonline.com/example-tenant/oauth2/v2.0/token";
            const scope = { abort: new AbortController(), firstPolicyBlock: null,
                accountSelf: { routed: false, protocolConsumed: false, continued: false },
                accountSelfPreflight: { consumed: false, associated: false, requestContinued: false, responseContinued: false },
                accountToken: Object.fromEntries(["POST", "OPTIONS"].map(method =>
                [method, { routeConsumed: 0, protocolConsumed: 0, requestContinued: 0, responseContinued: 0 }])) };
            const denied = [], pending = new Set(), seen = [], routed = [], playwrightFailures = [], protocolTrace = [];
            page.on("requestfailed", request => playwrightFailures.push(request.resourceType()));
            let gate, callbackRedirectRoot = false;
            const stop = (_, reason) => {
                if (scope.abort.signal.aborted) return;
                denied.push(reason); gate?.retire(); scope.abort.abort();
            };
            // Only local empty-document transport is mapped; production policy still decides every hop.
            const mapped = url => url.pathname === "/me" ? new URL("https://graph.microsoft.com/v1.0/me" + url.search)
                : url.pathname === "/token" ? new URL(tokenEndpoint) : new URL(url.pathname + url.search, url.origin === authBase
                ? "https://login.microsoftonline.com" : "https://m365.cloud.microsoft");
            const admit = (_, facts, stage) => {
                if (scope.abort.signal.aborted) return null;
                if (![base, authBase].includes(facts.url?.origin)) { stop(scope, "non-local-test-request"); return null; }
                const decision = accountOnlyRequestDecision({ ...facts, url: mapped(facts.url),
                    pageOrigin: "https://m365.cloud.microsoft", tokenEndpoint, signInClicked: mode.startsWith("post-"),
                    accountSelected: mode.startsWith("post-") });
                if (decision.denied) {
                    if (stage === "protocol" && decision.blockOnly === true) return "policy-block";
                    stop(scope, decision.denied); return null;
                }
                if (decision.kind === "token") scope.accountToken[facts.method][stage === "protocol" ? "protocolConsumed" : "routeConsumed"]++;
                if (decision.kind === "self") scope.accountSelf[stage === "protocol" ? "protocolConsumed" : "routed"] = true;
                if (decision.kind === "self-preflight") {
                    if (scope.accountSelfPreflight.consumed) { stop(scope, "self-preflight-cap"); return null; }
                    scope.accountSelfPreflight.consumed = true; scope.accountSelfPreflight.associated = true;
                }
                return decision.kind;
            };
            try {
                // Routing can answer CORS preflights itself. Isolate the real redirect response in that one case.
                if (mode !== "self-preflight-redirect") await context.route("**/*", async route => {
                    const request = route.request();
                    let owned = false;
                    try { owned = request.frame() === page.mainFrame() && request.frame().page() === page; } catch {}
                    routed.push(new URL(request.url()).pathname);
                    const allowed = admit(scope, { url: new URL(request.url()), method: request.method(), type: request.resourceType(),
                        navigation: request.isNavigationRequest(), owned, original: request.redirectedFrom() === null }, "route");
                    await (allowed ? route.continue() : route.abort());
                });
                const protocol = await context.newCDPSession(page);
                const { frameTree: { frame: { id: mainFrameId } } } = await protocol.send("Page.getFrameTree");
                protocol.on("Fetch.requestPaused", ({ requestId, networkId, redirectedRequestId, frameId, resourceType,
                    request: { url, method }, responseStatusCode, responseErrorReason }) => {
                    protocolTrace.push({ event: "paused", requestId, networkId, redirectedRequestId, frameId, resourceType,
                        path: new URL(url).pathname, method, responseStatusCode, failed: responseErrorReason !== undefined });
                    if (responseStatusCode === undefined) seen.push({ frameId, path: new URL(url).pathname, method });
                });
                for (const event of ["Network.loadingFailed", "Network.loadingFinished"]) protocol.on(event, ({ requestId, type }) => {
                    protocolTrace.push({ event, requestId, type });
                });
                gate = await guardAccountOnlyRequests(protocol, { mainFrameId, getScope: () => scope, admit, stop,
                    observeResponse(_owner, entry) {
                        if (mode === "post-303" && entry.url === base + "/chat") {
                            assert.equal(entry.initial.url, base + "/landingv2");
                            assert.equal(entry.initial.method, "POST");
                            assert.equal(entry.initial.networkId, entry.networkId);
                            assert.equal(entry.initial.frameId, mainFrameId);
                            callbackRedirectRoot = true;
                        }
                    },
                    isSelfUrl: url => [base, authBase].includes(url.origin) && accountOnlyRequestDecision({
                        url: mapped(url), method: "GET", type: "fetch", navigation: false, owned: true, original: true,
                        pageOrigin: "https://m365.cloud.microsoft", tokenEndpoint,
                    }).kind === "self",
                    responded(_, kind, method) {
                        if (kind === "token") scope.accountToken[method].responseContinued++;
                        if (kind === "self") scope.accountSelf.continued = true;
                        if (kind === "self-preflight") scope.accountSelfPreflight.responseContinued = true;
                    },
                    track(work) { pending.add(work); void work.finally(() => pending.delete(work)); return work; } });
                if (["return", "auth-data"].includes(mode)) {
                    if (mode === "return") await page.goto(base + "/chat", { waitUntil: "domcontentloaded" });
                    else await assert.rejects(page.goto(base + "/chat", { waitUntil: "domcontentloaded" }));
                } else {
                    await page.goto(base + "/home", { waitUntil: "domcontentloaded" });
                    if (mode === "streamed-static") {
                        await page.waitForLoadState("networkidle");
                        const loaded = page.evaluate(url => new Promise(resolve => {
                            const image = new Image();
                            image.onload = () => resolve(true);
                            image.onerror = () => resolve(false);
                            image.src = url;
                            document.body.append(image);
                        }), base + "/fixture-stream.gif");
                        await streamHeaders.promise;
                        const until = Date.now() + 2000;
                        while (!protocolTrace.some(row => row.path === "/fixture-stream.gif" && row.responseStatusCode === 200)
                            && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
                        await Promise.all([...pending]);
                        const response = protocolTrace.find(row => row.path === "/fixture-stream.gif" && row.responseStatusCode === 200);
                        assert.ok(response, "The real upstream headers must reach the native response gate.");
                        assert.equal(gate.pendingCount, 1, "Response forwarding alone cannot retire a streaming request.");
                        assert.equal(protocolTrace.some(row => row.event === "Network.loadingFinished"
                            && row.requestId === response.networkId), false);
                        assert.equal(visits.filter(row => row.path === "/fixture-stream.gif").length, 1);
                        streamedResponse.end(streamBody.subarray(6));
                        assert.equal(await loaded, true);
                        t.diagnostic("Real loopback route.continue: headers forwarded while body open; no premature retirement; genuine completed image drains the same native correlation.");
                    }
                    if (mode.startsWith("soft-")) {
                        const blocked = page.evaluate(async url => {
                            try { await fetch(url); return false; } catch { return true; }
                        }, base + "/entry.js?opaque=example");
                        if (mode === "soft-block") {
                            try { await page.addScriptTag({ url: base + "/entry.js?opaque=example" }); }
                            catch { assert.fail(JSON.stringify({ denied, protocolTrace })); }
                        }
                        assert.equal(await blocked, true);
                        assert.equal(scope.abort.signal.aborted, false, "An exact policy abort must not stop the scope.");
                    }
                    if (mode.startsWith("allowed-") || mode.startsWith("soft-")) {
                        const status = await page.evaluate(async url => {
                            try {
                                const response = await fetch(url);
                                await response.arrayBuffer();
                                return response.status;
                            } catch { return null; }
                        }, base + "/healthz");
                        if (mode === "soft-block") assert.equal(status, 200, "Allowed traffic must still work after a policy block.");
                    }
                    if (mode === "origin-commits") {
                        await page.goto(authBase + "/home", { waitUntil: "domcontentloaded" });
                        await page.goto(base + "/chat", { waitUntil: "domcontentloaded" });
                    }
                    if (mode === "static-data") await assert.rejects(page.addScriptTag({ url: base + "/entry.js" }));
                    if (mode.startsWith("post-")) {
                        const navigation = page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame() });
                        await page.evaluate(url => {
                            const form = document.createElement("form"); form.method = "POST"; form.action = url;
                            document.body.append(form); form.submit();
                        }, base + "/landingv2");
                        await navigation;
                        if (mode === "post-303") assert.equal(callbackRedirectRoot, true);
                    }
                    if (mode === "child") {
                        const failed = page.waitForEvent("requestfailed");
                        await page.evaluate(url => {
                            const frame = document.createElement("iframe"); frame.src = url; document.body.append(frame);
                        }, base + "/chat");
                        await failed;
                    }
                    if (mode === "coverage") {
                        await protocol.detach();
                        await assert.rejects(page.goto(base + "/chat"));
                    }
                    if (mode.startsWith("token-")) {
                        const status = await page.evaluate(async url => {
                            try {
                                const response = await fetch(url, { method: "POST", headers: { "X-Loopback-Check": "1" } });
                                await response.arrayBuffer();
                                return response.status;
                            }
                            catch { return null; }
                        }, authBase + "/token");
                        assert.equal(status, mode === "token-error" ? 400 : null,
                            JSON.stringify({ denied, seen, routed, budgets: scope.accountToken }));
                    }
                    if (mode.startsWith("self-")) {
                        const status = await page.evaluate(async ({ url, manual }) => {
                            try {
                                const response = await fetch(url, { method: manual ? "OPTIONS" : "GET", headers: { "X-Loopback-Check": "1" } });
                                await response.arrayBuffer();
                                return response.status;
                            }
                            catch { return null; }
                        }, { url: authBase + "/me?$select=id", manual: mode === "self-manual-options" });
                        assert.equal(status, mode === "self-preflight" ? 200 : null, JSON.stringify({ denied, seen, routed }));
                    }
                }
                await page.waitForLoadState("networkidle", { timeout: 2000 });
                await Promise.all([...pending]);
                assert.equal(visits.some(item => item.path === "/api/tasks"), false, "A redirected data destination must never reach HTTP.");
                assert.equal(gate.pendingCount, 0, "Completed/aborted correlations must be retired.");
                assert.equal(gate.selfAssociationCount, 0, "Self association IDs must be retired without logging them.");
                if (mode.startsWith("soft-") || mode.startsWith("allowed-")) {
                    assert.ok(playwrightFailures.length > 0, "HTTP failures still surface through Playwright; they are attributed by exact protocol IDs.");
                    if (mode.startsWith("soft-")) {
                        const blockedType = protocolTrace.find(item => item.event === "paused" && item.path === "/entry.js"
                            && ["Fetch", "XHR"].includes(item.resourceType)).resourceType.toLowerCase();
                        assert.deepEqual(scope.firstPolicyBlock, { reason: "data-dependency",
                            context: { method: "GET", resourceType: blockedType, navigation: false, owned: true, original: true,
                                target: "other", queryPresent: true, stage: "request" }, abortAcknowledged: true });
                        assert.equal(visits.filter(item => item.path.startsWith("/entry.js")).length, mode === "soft-block" ? 1 : 0,
                            "Only the allowed script, never the same-URL blocked fetch, may reach HTTP.");
                    } else assert.equal(scope.firstPolicyBlock, null);
                    assert.deepEqual(denied, mode === "soft-block" ? [] : ["response-failed"]);
                } else if (mode === "streamed-static") {
                    assert.deepEqual(denied, []);
                    const response = protocolTrace.find(row => row.path === "/fixture-stream.gif" && row.responseStatusCode === 200);
                    assert.ok(protocolTrace.some(row => row.event === "Network.loadingFinished" && row.requestId === response.networkId));
                } else if (mode === "self-preflight") {
                    assert.deepEqual(denied, [], JSON.stringify(protocolTrace));
                    assert.deepEqual(scope.accountSelfPreflight, { consumed: true, associated: true, requestContinued: true, responseContinued: true });
                    assert.deepEqual(scope.accountSelf, { routed: true, protocolConsumed: true, continued: true });
                    assert.deepEqual(seen.filter(item => item.path === "/me").map(item => item.method), ["OPTIONS", "GET"]);
                    assert.deepEqual(visits.filter(item => item.path.startsWith("/me")).map(item => item.method), ["GET"],
                        "The normal Playwright-routing composition can answer preflight before it reaches HTTP.");
                } else if (mode === "token-error") {
                    assert.deepEqual(denied, [], JSON.stringify(protocolTrace));
                    assert.equal(scope.accountToken.POST.responseContinued, 1);
                    assert.equal(scope.accountToken.OPTIONS.protocolConsumed, 1);
                    assert.equal(scope.accountToken.OPTIONS.responseContinued, 1);
                    assert.equal(scope.accountToken.OPTIONS.routeConsumed, 0, "Browser preflight was gated even though Playwright did not route it.");
                } else if (["return", "origin-commits", "post-303"].includes(mode)) {
                    assert.deepEqual(denied, []);
                    assert.equal(page.url(), base + "/chat");
                    assert.ok(seen.every(item => item.frameId === mainFrameId));
                    if (mode === "return") {
                        assert.ok(visits.some(item => item.host.startsWith("localhost:")), "The chain must cross a real origin.");
                        assert.deepEqual(seen.map(item => item.path), ["/chat", "/login", "/chat"]);
                        assert.deepEqual(routed, ["/chat"], "Playwright only sees the initial redirect URL.");
                    } else if (mode === "post-303") {
                        assert.ok(visits.some(item => item.method === "POST" && item.path === "/landingv2"));
                        assert.ok(visits.some(item => item.method === "GET" && item.path === "/chat"));
                    } else {
                        assert.deepEqual(seen.map(item => item.path), ["/home", "/home", "/chat"]);
                        assert.ok(visits.some(item => item.host.startsWith("localhost:")));
                        assert.equal(gate.active, true, "The same gate must survive committed cross-origin documents.");
                    }
                } else {
                    assert.deepEqual(denied, [mode === "post-307" ? "shell-document-scope"
                        : mode === "child" ? "unowned-frame" : mode === "coverage" ? "protocol-coverage"
                            : mode === "token-redirect" ? "token-redirect" : mode === "self-preflight-redirect" ? "self-preflight-response"
                                : mode === "self-manual-options" ? "self-preflight-association" : "business-data"]);
                    if (["post-307", "child", "coverage"].includes(mode)) assert.equal(visits.some(item => item.path === "/chat"), false);
                    if (mode.startsWith("self-")) {
                        assert.deepEqual(scope.accountSelf, { routed: false, protocolConsumed: false, continued: false });
                        assert.equal(scope.accountSelfPreflight.consumed, mode === "self-preflight-redirect");
                        assert.equal(scope.accountSelfPreflight.responseContinued, false);
                        assert.equal(visits.some(item => item.path.startsWith("/me") && item.method === "GET"), false);
                        assert.equal(visits.filter(item => item.path.startsWith("/me") && item.method === "OPTIONS").length,
                            mode === "self-preflight-redirect" ? 1 : 0);
                    }
                }
            } finally {
                if (mode === "streamed-static" && streamedResponse && !streamedResponse.writableEnded) streamedResponse.end(streamBody.subarray(6));
                gate?.retire(); scope.abort.abort();
                try { await page.close(); }
                finally { await context.close(); await Promise.all([...pending]); }
            }
        });
    }
});

test("owned protocol gate blocks preflights and redirects while forwarding an unchanged error response", { timeout: 15000 }, async t => {
    let browser, endpointRequests = 0, escapedRequests = 0, beaconContacts = 0, mode = "block-preflight";
    const server = createServer((request, response) => {
        if (request.url === "/beacon-page") {
            response.writeHead(200, { "Content-Type": "text/html" });
            response.end(`<link rel="icon" href="data:,"><script>addEventListener("pagehide",()=>{
                navigator.sendBeacon("/beacon-unload","synthetic");
                fetch("/beacon-keepalive",{method:"POST",body:"synthetic",keepalive:true}).catch(()=>{});
            });</script>`);
            return;
        }
        if (request.url === "/next") {
            response.writeHead(200, { "Content-Type": "text/html" });
            response.end('<link rel="icon" href="data:,">');
            return;
        }
        if (request.url.startsWith("/beacon-")) beaconContacts++;
        if (request.url === "/escaped") escapedRequests++;
        if (request.url === "/token") {
            endpointRequests++;
            response.writeHead(mode === "block-redirect" ? 302 : 400, {
                "Access-Control-Allow-Origin": "*", ...(mode === "block-redirect" ? { Location: "/escaped" } : {}),
            });
        } else response.writeHead(200);
        response.end();
    });
    t.after(async () => {
        await browser?.close();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    browser = await chromium.launch({ channel: "msedge", headless: true, chromiumSandbox: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.context().route("**/*", route => route.continue());
    const protocol = await page.context().newCDPSession(page);
    const { frameTree: { frame: { id: frameId } } } = await protocol.send("Page.getFrameTree");
    const seen = [], pending = [], originals = new Map(), network = new Map(), beaconPauses = [];
    let correlationFailed = false;
    protocol.on("Network.requestWillBeSent", event => {
        if (event.request.method === "POST" && new URL(event.request.url).pathname.startsWith("/beacon-")) {
            network.set(event.requestId, { frameId: event.frameId, method: event.request.method });
        }
    });
    protocol.on("Fetch.requestPaused", ({ requestId, networkId, frameId: actualFrame, resourceType, responseStatusCode, request: { method, url } }) => {
        if (method === "POST" && new URL(url).pathname.startsWith("/beacon-")) {
            beaconPauses.push({ kind: new URL(url).pathname.slice("/beacon-".length),
                networkId: networkId ?? null, frameId: actualFrame, method, resourceType });
            pending.push(protocol.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }));
            return;
        }
        seen.push({ method, frameId: actualFrame, resourceType });
        if (responseStatusCode === undefined) originals.set(requestId, method);
        else if (originals.get(requestId) !== method) correlationFailed = true;
        pending.push(correlationFailed || mode === "block-preflight" && method === "OPTIONS"
            || responseStatusCode >= 300 && responseStatusCode < 400
            ? protocol.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
            : responseStatusCode === undefined
                ? protocol.send("Fetch.continueRequest", { requestId, interceptResponse: true })
                : protocol.send("Fetch.continueResponse", { requestId }));
    });
    const browserProtocol = await protocol.send("Browser.getVersion");
    await protocol.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });
    await protocol.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await page.goto(`http://127.0.0.1:${port}/`);
    for (const next of ["block-preflight", "allow-error", "block-redirect"]) {
        mode = next;
        const status = await page.evaluate(async url => {
            try { return (await fetch(url, { method: "POST", headers: { "X-Loopback-Check": "1" } })).status; }
            catch { return null; }
        }, `http://localhost:${port}/token`);
        await Promise.all(pending);
        assert.equal(correlationFailed, false, "Response must retain the exact original protocol request ID.");
        assert.equal(status, mode === "allow-error" ? 400 : null);
        if (mode === "block-preflight") assert.equal(endpointRequests, 0);
    }
    assert.equal(endpointRequests, 2);
    assert.equal(escapedRequests, 0);
    assert.ok(seen.some(item => item.method === "OPTIONS" && item.frameId === frameId));
    await page.goto(`http://127.0.0.1:${port}/beacon-page`);
    await page.evaluate(url => navigator.sendBeacon(url, "synthetic"), `http://127.0.0.1:${port}/beacon-direct`);
    await page.waitForTimeout(100);
    await page.goto(`http://localhost:${port}/next`);
    await page.waitForTimeout(200);
    await Promise.all(pending);
    assert.equal(beaconContacts, 0, "Every actual beacon/keepalive request stays blocked at Fetch.");
    assert.ok(beaconPauses.length >= 1);
    for (const paused of beaconPauses) if (paused.networkId !== null) {
        assert.equal(network.get(paused.networkId)?.method, paused.method);
    }
    const { frameTree: after } = await protocol.send("Page.getFrameTree");
    t.diagnostic(JSON.stringify({ browser: browserProtocol.product, protocol: browserProtocol.protocolVersion,
        listenersBeforeEnable: true, networkBeforeFetch: true, mainFrameStable: after.frame.id === frameId,
        nativeBeaconPauses: beaconPauses.length, nativeNetworkEvents: network.size,
        missingNetworkIds: beaconPauses.filter(value => value.networkId === null).length, sourceRequestsForwarded: beaconContacts,
        samples: beaconPauses.map(value => ({ kind: value.kind, networkIdPresent: value.networkId !== null,
            mainFrameMatches: value.frameId === frameId, resourceType: value.resourceType })) }));

    const guardedPage = await page.context().newPage();
    const guardedProtocol = await page.context().newCDPSession(guardedPage);
    const { frameTree: guardedTree } = await guardedProtocol.send("Page.getFrameTree");
    const guardedScope = { page: guardedPage, abort: new AbortController() }, guardedPending = new Set(), guardedStops = [], guardedPauses = [];
    const localSinks = new Set([`http://127.0.0.1:${port}/beacon-unload`, `http://127.0.0.1:${port}/beacon-keepalive`]);
    guardedProtocol.on("Fetch.requestPaused", event => {
        if (event.request.method === "POST") guardedPauses.push({ networkIdPresent: event.networkId !== undefined,
            resourceType: event.resourceType });
    });
    const guardedGate = await guardAccountOnlyRequests(guardedProtocol, {
        mainFrameId: guardedTree.frame.id, getScope: () => guardedScope, isSelfUrl: () => false,
        allowFetchOnlyTelemetryDenial: (owner, facts) => owner === guardedScope && localSinks.has(facts.url?.href),
        admit(owner, facts) { return facts.method === "GET" ? "bootstrap" : null; }, responded() {},
        stop(owner, reason) { guardedStops.push(reason); owner.abort.abort(); },
        track(work) { guardedPending.add(work); work.finally(() => guardedPending.delete(work)); return work; },
    });
    await guardedPage.goto(`http://127.0.0.1:${port}/beacon-page`);
    await guardedPage.waitForLoadState("networkidle");
    try { await guardedPage.goto(`http://localhost:${port}/next`); }
    catch (error) { assert.fail(JSON.stringify({ error: error.name, guardedStops, guardedPauses,
        fetchOnly: guardedScope.blockedFetchOnlySinkRequests })); }
    await guardedPage.waitForLoadState("networkidle");
    await Promise.all([...guardedPending]);
    assert.ok(guardedPauses.length >= 1);
    assert.ok(guardedPauses.every(value => value.networkIdPresent === false), "This installed-browser fixture observes IDs, never supplies them.");
    assert.deepEqual(guardedStops, []);
    assert.equal(guardedScope.blockedFetchOnlySinkRequests.acknowledged, guardedPauses.length);
    assert.equal(guardedScope.blockedFetchOnlySinkRequests.originalNetwork, "unavailable");
    assert.equal(guardedScope.blockedAuthTelemetry, undefined);
    assert.equal(beaconContacts, 0);
    assert.equal(guardedGate.pendingCount, 0);
    t.diagnostic(JSON.stringify({ fetchOnlyPolicy: "acknowledged-denial", naturallyUnlinkedPauses: guardedPauses.length,
        acknowledged: guardedScope.blockedFetchOnlySinkRequests.acknowledged, sourceRequestsForwarded: beaconContacts }));
    guardedGate.retire();
    await guardedPage.close();
});

test("native connection verifies account metadata without requiring or claiming source reads", async () => {
    const metadata = proof("example-subject");
    delete metadata.chat;
    delete metadata.cowork;
    const transport = createMicrosoftNativeReadTransport({
        open: async () => {},
        verifyAccount: async () => metadata,
        stop: async () => ({ processExited: true, profileReleased: true }),
    });
    const current = operation("example-account-owner");
    await transport.open(current);
    const verified = await transport.verify(current);
    assert.deepEqual(Object.keys(verified).sort(), ["accountVerified", "partition"]);
    assert.equal(verified.accountVerified, true);
    assert.equal(transport.accountFor({ kind: "microsoft-retained", partition: verified.partition }).account.subjectId,
        "example-subject");
    await transport.stop({ ownerId: current.ownerId });
});

test("native routing witness selection is transport-owned and only needed for a different retained namespace", async () => {
    const metadata = { ...proof("example-subject"), evidence: { ...proof("example-subject").evidence,
        namespace: "m365.accountInfo.objectId", realm: "prod" } };
    const expected = createHash("sha256").update(JSON.stringify([
        "microsoft-native-account-v2", metadata.evidence.issuer, metadata.evidence.namespace, metadata.evidence.realm,
        metadata.tenantId, metadata.subjectId,
    ])).digest("hex");
    for (const expectedPartition of [undefined, expected, "f".repeat(64)]) {
        let needsRouting;
        const transport = createMicrosoftNativeReadTransport({
            open: async () => {},
            verifyAccount: async operation => {
                assert.equal(Object.hasOwn(operation, "expectedPartition"), false);
                needsRouting = operation.needsNativeRouting;
                assert.equal(needsRouting(metadata), expectedPartition !== undefined && expectedPartition !== expected);
                return metadata;
            },
            stop: async () => ({ processExited: true, profileReleased: true }),
        });
        const current = { ...operation("example-account-owner"), generation: 1, expectedPartition };
        await transport.open(current);
        const verified = await transport.verify(current);
        assert.equal(verified.partition, expected, "No missing witness may turn a fresh namespace into the requested legacy partition.");
        assert.throws(() => needsRouting(metadata), { code: "cancelled" }, "Witness selection expires with its original verification.");
        await transport.stop(current);
    }
});

for (const invalidation of ["abort", "stop", "abort-and-stop", "owner-replacement", "reused-owner"]) {
    test(`native account verification rejects held proof after ${invalidation}`, async () => {
        const held = Promise.withResolvers(), entered = Promise.withResolvers();
        const controller = new AbortController();
        const old = { ownerId: "example-owner-old", signal: controller.signal };
        const next = operation(invalidation === "reused-owner" ? old.ownerId : "example-owner-new");
        const transport = createMicrosoftNativeReadTransport({
            open: async () => {},
            verifyAccount: async value => {
                if (value === old) { entered.resolve(); return held.promise; }
                return proof("example-subject-new");
            },
            stop: async () => ({ processExited: true, profileReleased: true }),
        });
        await transport.open(old);
        const pending = transport.verify(old).then(value => ({ value }), error => ({ error }));
        await entered.promise;
        if (invalidation.includes("abort")) controller.abort();
        if (invalidation.includes("stop") || invalidation === "reused-owner") await transport.stop({ ownerId: old.ownerId });
        const reopened = ["owner-replacement", "reused-owner"].includes(invalidation);
        if (reopened) await transport.open(next);
        held.resolve(proof("example-subject-old"));
        const stale = await pending;
        if (!reopened) await transport.open(next);
        const fresh = await transport.verify(next).then(value => ({ value }), error => ({ error }));
        assert.deepEqual({ retired: stale.error?.code ?? "accepted", replacement: fresh.error?.code ?? "verified" },
            { retired: "cancelled", replacement: "verified" }, "A retired proof must not install or poison the replacement account.");
        assert.equal(transport.accountFor({ kind: "microsoft-read", partition: fresh.value.partition }).account.subjectId,
            "example-subject-new");
        await transport.stop({ ownerId: next.ownerId });
    });
}

test("old verifier settling after a replacement is verified cannot alter its identity", async () => {
    const held = Promise.withResolvers(), entered = Promise.withResolvers();
    const old = operation("example-owner-old"), next = operation("example-owner-new");
    const transport = createMicrosoftNativeReadTransport({
        open: async () => {},
        verifyAccount: async value => {
            if (value === old) { entered.resolve(); return held.promise; }
            return proof("example-subject-new");
        },
        stop: async () => ({ processExited: true, profileReleased: true }),
    });
    await transport.open(old);
    const pending = transport.verify(old).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    await transport.stop({ ownerId: old.ownerId });
    await transport.open(next);
    const accepted = await transport.verify(next);
    held.resolve(proof("example-subject-old"));
    assert.equal((await pending).error?.code, "cancelled");
    assert.equal(transport.accountFor({ kind: "microsoft-read", partition: accepted.partition }).account.subjectId,
        "example-subject-new");
    await transport.stop({ ownerId: next.ownerId });
});

test("identity-only verification still rejects missing, stale or unsafe account evidence", async () => {
    const changes = [
        value => { delete value.tenantId; },
        value => { delete value.subjectId; },
        value => { value.knownAccountMatched = false; },
        value => { value.evidence.observedAt = "not-a-time"; },
        value => { value.evidence.observedAt = new Date(Date.now() - 600000).toISOString(); },
        value => { value.evidence.issuer = "https://example:invalid@example.invalid"; },
    ];
    for (const change of changes) {
        const metadata = proof("example-subject");
        delete metadata.chat; delete metadata.cowork;
        change(metadata);
        const transport = createMicrosoftNativeReadTransport({
            open: async () => {}, verifyAccount: async () => metadata,
            stop: async () => ({ processExited: true, profileReleased: true }),
        });
        const current = operation("example-account-owner");
        await transport.open(current);
        await assert.rejects(transport.verify(current), { code: "account-metadata-unavailable" });
        assert.throws(() => transport.accountFor({ kind: "microsoft-read", partition: "0".repeat(64) }), { code: "lease-invalid" });
        await transport.stop({ ownerId: current.ownerId });
    }
});

test("native transport preserves reconnect identity and refuses a different account until stopped", async () => {
    let subject = "example-subject-a";
    const transport = createMicrosoftNativeReadTransport({
        open: async () => {},
        verifyAccount: async () => proof(subject),
        stop: async () => ({ processExited: true, profileReleased: true }),
    });
    const first = operation("example-owner-a");
    await transport.open(first);
    const accepted = await transport.verify(first);
    assert.deepEqual(await transport.verify(first), accepted);
    const replacement = operation("example-owner-b");
    await transport.open(replacement);
    assert.deepEqual(await transport.verify(replacement), accepted);
    subject = "example-subject-b";
    await assert.rejects(transport.verify(replacement), { code: "wrong-account" });
    assert.equal(transport.accountFor({ kind: "microsoft-retained", partition: accepted.partition }).account.subjectId,
        "example-subject-a");
    await transport.stop({ ownerId: replacement.ownerId });
    assert.throws(() => transport.accountFor({ kind: "microsoft-retained", partition: accepted.partition }), { code: "lease-invalid" });
    const reopened = operation("example-owner-c");
    await transport.open(reopened);
    assert.notEqual((await transport.verify(reopened)).partition, accepted.partition);
    await transport.stop({ ownerId: reopened.ownerId });
});
