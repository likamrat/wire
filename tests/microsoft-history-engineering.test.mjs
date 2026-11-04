import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { sourceProjection } from "../lib/microsoft-chat-capture.mjs";
import { createHistoryEngineeringProjection, installHistoryEngineeringCapture } from "../lib/microsoft-history-engineering-projection.mjs";
import { createHistoryEngineering, runHistoryEngineeringSteps, historyEngineeringVisibleSummary,
    validateHistoryContextStructure } from "../lib/microsoft-history-engineering.mjs";
import { createEngineeringCustody, cleanupEngineeringCustody, verifyHistoryInvestigationCandidate,
    runHistoryInvestigation, historyInvestigationEnvironment, assertHistoryInvestigationActive } from "../scripts/investigate-native-history.mjs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { prepareMicrosoftNativeConfiguration } from "../lib/microsoft-native-configuration.mjs";
import { createMicrosoftNativeHost } from "../lib/microsoft-native-host.mjs";

const expectedAccount = "example@invalid.test", salt = Array(32).fill(7);
const initializer = "https://m365.cloud.microsoft/_serverFn/22ef9231e91dd4cf46350df4f8e31fc54e727335d4a882bc56199bd904815585";
const payload = () => ({
    historySource: "all-chats",
    store: {
        accountInfo: { accountType: "AAD", environment: "prod", tenantId: "tenant", objectId: "subject" },
        identity: { userPrincipalName: expectedAccount },
        conversationPageHistoryList: {
            chats: [{ conversationId: "PRIVATE_ID", updateTimeUtc: 1800000000000,
                chatName: "PRIVATE_TITLE", lastMessage: { text: "PRIVATE_REPLY" } }],
            syncState: "PRIVATE_CURSOR",
        },
    },
});

test("native attention expires at the original authentication deadline, not the longer investigation deadline", () => {
    let clock = 100;
    const events = [], controller = createHistoryEngineering({ expectedAccount, salt, now: () => clock,
        onEvent: event => events.push(event) });
    controller.bind({ signal: new AbortController().signal, deadline: 1000, check: () => true,
        authentication: { ownerId: randomUUID(), generation: 2, deadline: 200 } });
    controller.humanNeeded("password");
    clock = 200;
    assert.throws(() => controller.humanNeeded("password"), { code: "NATIVE_ENGINEERING_ATTENTION_RETIRED" });
    assert.equal(events.length, 1, "An expired prompt must not produce another actionable attention event.");
});

test("one original Connect owns immutable authentication and read bounds after any preparation delay", () => {
    let clock = 0;
    const events = [], signal = new AbortController();
    const controller = createHistoryEngineering({ expectedAccount, salt, now: () => clock, onEvent: event => events.push(event) });
    clock = 900000;
    assert.equal(controller.connectionStarted, false);
    assert.equal(controller.summary().operationStarted, false);
    assert.equal(controller.summary().operation, null);
    assert.deepEqual(events, []);
    const ownerId = randomUUID(), bounds = controller.beginConnection({ ownerId, signal: signal.signal });
    assert.equal(bounds.startedAt, clock);
    assert.equal(bounds.authDeadline - clock, 90000);
    assert.equal(bounds.deadline - clock, 300000);
    assert.equal(bounds.shutdownAt - clock, 280000);
    assert.equal(Object.isFrozen(bounds), true);
    const original = controller.summary().operation;
    clock += 1000;
    for (const id of [ownerId, randomUUID()]) {
        assert.throws(() => controller.beginConnection({ ownerId: id, signal: signal.signal }), { code: "NATIVE_ENGINEERING_ALREADY_STARTED" });
    }
    assert.equal(events.filter(event => event.type === "connect-started").length, 1);
    assert.deepEqual(controller.summary().operation, original);
    assert.throws(() => controller.bind({ ownerId, signal: signal.signal, check: () => true,
        deadline: clock + 280000 }), { code: "NATIVE_ENGINEERING_BINDING" }, "Binding cannot renew the original read deadline.");
    controller.bind({ ownerId, signal: signal.signal, check: () => true, deadline: bounds.shutdownAt,
        authentication: { ownerId, generation: 2, deadline: bounds.authDeadline } });
    controller.recordFailure("timed-out");
    const terminal = controller.summary();
    assert.equal(terminal.firstFailure.step, "authentication");
    assert.equal(terminal.outcome, "stopped");
    assert.throws(() => controller.beginConnection({ ownerId: randomUUID(), signal: new AbortController().signal }),
        { code: "NATIVE_ENGINEERING_ALREADY_STARTED" });
    controller.recordFailure("NATIVE_ENGINEERING_DEADLINE");
    assert.deepEqual(controller.summary(), terminal);
});

test("preparation cancellation records no Microsoft start and cannot later authorize a connection", () => {
    const events = [], controller = createHistoryEngineering({ expectedAccount, salt, onEvent: event => events.push(event) });
    controller.recordFailure("NATIVE_ENGINEERING_CANCELLED");
    const original = controller.summary();
    assert.equal(original.outcome, "not-started");
    assert.equal(original.operationStarted, false);
    assert.equal(original.operation, null);
    assert.equal(original.firstFailure.step, "preparation");
    assert.throws(() => controller.beginConnection({ ownerId: randomUUID(), signal: new AbortController().signal }),
        { code: "NATIVE_ENGINEERING_CANCELLED" });
    controller.recordFailure("NATIVE_ENGINEERING_CLEANUP_FAILED");
    assert.deepEqual(controller.summary(), original);
    assert.equal(events.some(event => event.type === "connect-started"), false);
});

test("native attention carries its original owner and expires or retires without relabeling an unseen window", () => {
    for (const retirement of ["history", "cancel", "owner", "failure"]) {
        const events = [], signal = new AbortController();
        let current = true;
        const controller = createHistoryEngineering({ expectedAccount, salt, now: () => 100,
            onEvent: event => events.push(event) });
        const authentication = { ownerId: randomUUID(), generation: 2, deadline: 200 };
        controller.bind({ signal: signal.signal, deadline: 1000, check: () => current, authentication });
        controller.windowReady();
        assert.deepEqual(events[0], { type: "window-ready", ownerId: authentication.ownerId, generation: 2,
            issuedAt: new Date(100).toISOString(), deadline: new Date(200).toISOString(),
            display: "headful", presentation: "normal-in-work-area", userVisibility: "unconfirmed" });
        assert.equal(events[0].interaction, undefined);
        controller.humanNeeded("mfa");
        assert.equal(events[1].ownerId, authentication.ownerId);
        assert.equal(events[1].deadline, events[0].deadline);
        if (retirement === "history") {
            controller.authenticate();
            controller.humanNeeded("review-sign-in");
            assert.equal(events[2].type, "human-needed", "Matched identity alone does not establish completed bootstrap.");
            controller.begin("chat", "initial");
            assert.deepEqual(events[3], { type: "attention-ended", ownerId: authentication.ownerId,
                generation: 2, reason: "history-started" });
        } else if (retirement === "cancel") signal.abort();
        else if (retirement === "owner") current = false;
        else controller.recordFailure("NATIVE_ENGINEERING_FAILED");
        const count = events.length;
        const code = retirement === "history" ? "NATIVE_ENGINEERING_ATTENTION_RETIRED"
            : retirement === "failure" ? "NATIVE_ENGINEERING_FAILED" : "NATIVE_ENGINEERING_AUTHORITY_LOST";
        assert.throws(() => controller.windowReady(), { code });
        assert.throws(() => controller.humanNeeded("password"), { code });
        assert.equal(events.length, count);
    }
    const controller = createHistoryEngineering({ expectedAccount, salt, now: () => 100 });
    controller.bind({ signal: new AbortController().signal, deadline: 1000, check: () => true });
    assert.throws(() => controller.humanNeeded("mfa"), { code: "NATIVE_ENGINEERING_ATTENTION_RETIRED" });
});

test("context feasibility records only fixed known-store structure and keeps protected sections behind verified identity", async () => {
    const projection = createHistoryEngineeringProjection({ expectedAccount, salt }, sourceProjection);
    const value = payload();
    value.store.featureFlags = { enableChatLandingPageHistoryStore: true };
    value.store.pinnedChatIds = ["PRIVATE_PIN"];
    value.store.pinnedChats = [{ title: "PRIVATE_PIN_TITLE", body: "PRIVATE_PIN_BODY" }];
    const result = await projection.response({ role: "context", requestBasis: "context",
        bytes: Buffer.from(JSON.stringify(value)), mime: "application/json", serialized: false });
    assert.equal(result.structure.purpose, "sections");
    assert.equal(result.structure.histories[0].count, 1);
    assert.equal(result.structure.histories[1].availability, "absent");
    assert.equal(result.structure.pinnedChatIds.count, 1);
    assert.equal(result.structure.pinnedChats.count, 1);
    assert.equal(result.structure.landingStoreFlag, "true");
    assert.doesNotMatch(JSON.stringify(result.structure), /PRIVATE_|tenant|subject|1800000000000/);
    const controller = createHistoryEngineering({ expectedAccount, salt, now: () => 0 });
    controller.bind({ signal: new AbortController().signal, deadline: 1000, check: () => true });
    const requestId = randomUUID(), input = { requestId, method: "POST",
        requestUrlKey: controller.urlKey(initializer),
        projection: { role: "context", cursor: { state: "absent", key: null }, basis: "context", filter: "none" } };
    assert.throws(() => controller.prepareRequest(input), { code: "NATIVE_ENGINEERING_IDENTITY_UNCONFIRMED" });
    controller.authenticate(); controller.begin("chat", "initial");
    controller.prepareRequest(input); controller.matchRequest(initializer, "POST");
    controller.accept(requestId, result, 100);
    const saved = controller.summary(), visible = historyEngineeringVisibleSummary(saved);
    assert.equal(saved.contexts.length, 1);
    assert.equal(saved.steps.length, 0, "Context structure is not an initializer or membership proof.");
    assert.match(saved.contexts[0].structure.histories[0].cursor.key, /^[a-f0-9]{64}$/);
    assert.equal(visible.contexts[0].structure.histories[0].cursor.key, undefined);
    const invalid = structuredClone(result.structure);
    invalid.rawTitle = "PRIVATE_TITLE";
    assert.throws(() => validateHistoryContextStructure(invalid), { code: "NATIVE_ENGINEERING_OBSERVER_UNSAFE" });
});

test("normal-entry feasibility refuses an absent or mismatched candidate before creating custody", async () => {
    await assert.rejects(verifyHistoryInvestigationCandidate(undefined), { code: "NATIVE_ENGINEERING_CANDIDATE_REQUIRED" });
    await assert.rejects(verifyHistoryInvestigationCandidate("0".repeat(40)), { code: "NATIVE_ENGINEERING_CANDIDATE_CHANGED" });
    await assert.rejects(runHistoryInvestigation({ expectedAccount, authorizationReference: "offline-only",
        outputFile: path.resolve("candidate-not-created.json"), normalEntry: true, signal: new AbortController().signal }),
    { code: "NATIVE_ENGINEERING_CANDIDATE_REQUIRED" });
    await assert.rejects(runHistoryInvestigation({ expectedAccount, authorizationReference: "offline-only",
        outputFile: path.resolve("candidate-not-created.json"), normalEntry: true }),
    { code: "NATIVE_ENGINEERING_BINDING" });
    await assert.rejects(stat(path.resolve("candidate-not-created.json.started")), { code: "ENOENT" });
    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(runHistoryInvestigation({ expectedAccount, authorizationReference: "offline-only",
        outputFile: path.resolve("candidate-not-created.json"), signal: cancellation.signal }),
    { code: "NATIVE_ENGINEERING_CANCELLED" });
});

test("normal-entry environment uses only empty owned source roots and strips inherited provider tokens", () => {
    const root = path.resolve("invented-isolated-root"), dataDir = path.join(root, "data");
    const environment = historyInvestigationEnvironment({ root, dataDir }, {
        PATH: "unchanged", COPILOT_HOME: "PRIVATE_SOURCE", GH_CONFIG_DIR: "PRIVATE_CONFIG",
        WORKIQ_EVIDENCE_DATA_DIR: "PRIVATE_STORE", GH_TOKEN: "PRIVATE_TOKEN",
        GITHUB_TOKEN: "PRIVATE_TOKEN", github_enterprise_token: "PRIVATE_TOKEN",
        COPILOT_TOKEN: "PRIVATE_TOKEN", WIRE_PRIVATE_BINDING: "PRIVATE_BINDING", NODE_TEST_CONTEXT: "child",
    });
    assert.equal(environment.COPILOT_HOME, path.join(root, "empty-copilot"));
    assert.equal(environment.GH_CONFIG_DIR, path.join(root, "empty-github"));
    assert.equal(environment.WORKIQ_EVIDENCE_DATA_DIR, dataDir);
    assert.equal(environment.PATH, "unchanged");
    assert.doesNotMatch(JSON.stringify(environment), /PRIVATE_|TOKEN|token|WIRE_|NODE_TEST/);
});

test("a failure during asynchronous startup is retained when the normal-entry waiter is registered later", async () => {
    for (const reason of ["NATIVE_ENGINEERING_CANCELLED", "NATIVE_ENGINEERING_DEADLINE"]) {
        const engineering = createHistoryEngineering({ expectedAccount, salt });
        const startup = Promise.withResolvers(), signal = new AbortController();
        const entering = (async () => {
            await startup.promise;
            assertHistoryInvestigationActive(engineering, signal.signal);
            assert.fail("A stopped startup cannot begin waiting for another Connect.");
        })();
        engineering.recordFailure(reason);
        signal.abort();
        engineering.recordFailure("NATIVE_ENGINEERING_CLEANUP_FAILED");
        startup.resolve();
        await assert.rejects(entering, { code: reason });
    }
});
test("a delayed context response retains its request's original step across a page transition", async () => {
    const projection = createHistoryEngineeringProjection({ expectedAccount, salt }, sourceProjection);
    const bytes = Buffer.from(JSON.stringify(payload()));
    const context = await projection.response({ role: "context", requestBasis: "context", bytes, mime: "application/json", serialized: false });
    const initial = await projection.response({ role: "chat-initializer", bytes, mime: "application/json", serialized: false });
    const controller = createHistoryEngineering({ expectedAccount, salt, now: () => 0 });
    controller.bind({ signal: new AbortController().signal, deadline: 1000, check: () => true });
    controller.authenticate(); controller.begin("chat", "initial");
    const requestId = randomUUID();
    controller.prepareRequest({ requestId, method: "POST", requestUrlKey: controller.urlKey(initializer),
        projection: { role: "context", cursor: { state: "absent", key: null }, basis: "context", filter: "none" } });
    controller.matchRequest(initializer, "POST");
    const initialId = randomUUID();
    controller.prepareRequest({ requestId: initialId, method: "GET", requestUrlKey: controller.urlKey(initializer),
        projection: await projection.request({ url: initializer, method: "GET" }) });
    controller.matchRequest(initializer, "GET"); controller.accept(initialId, initial, bytes.length);
    controller.begin("chat", "page");
    controller.accept(requestId, context, bytes.length);
    assert.equal(controller.summary().contexts[0].step, "chat:initial");
});
test("engineering source projection exports metadata only and refuses an unselected load-more start", async () => {
    const projection = createHistoryEngineeringProjection({ expectedAccount, salt }, sourceProjection);
    const result = await projection.response({ role: "chat-initializer", bytes: Buffer.from(JSON.stringify(payload())),
        mime: "application/json", serialized: false });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|chatName|lastMessage|encodedBody/);
    assert.equal(result.list.count, 1);
    assert.equal(result.list.cursor.state, "present");
    const events = [], abort = new AbortController();
    const control = createHistoryEngineering({ expectedAccount, salt, now: () => 100, onEvent: event => events.push(event) });
    control.bind({ signal: abort.signal, deadline: 1000, check: () => true });
    control.authenticate();
    control.begin("chat", "initial");
    assert.throws(() => control.prepareRequest({ requestId: randomUUID(), method: "POST",
        requestUrlKey: control.urlKey(initializer), projection: { role: "chat-list", store: "conversationPageHistoryList",
            cursor: result.list.cursor, basis: "continuation", filter: "none" } }), { code: "NATIVE_ENGINEERING_INITIALIZER_REQUIRED" });
    const requestId = randomUUID(), request = await projection.request({ url: initializer, method: "GET" });
    control.prepareRequest({ requestId, method: "GET", requestUrlKey: control.urlKey(initializer), projection: request });
    control.matchRequest(initializer, "GET");
    control.accept(requestId, result, 500);
    control.begin("chat", "page");
    control.unavailable("native-control-unavailable");
    assert.equal(control.summary().steps[1].outcome, "unavailable");
    assert.equal(control.summary().requests, 1);
    assert.doesNotMatch(JSON.stringify(control.summary()), /PRIVATE_|tenant|subject|userPrincipalName/);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|tenant|subject/);
    abort.abort();
    assert.throws(() => control.begin("chat", "refresh"), { code: "NATIVE_ENGINEERING_AUTHORITY_LOST" });
});

test("engineering projection rejects message endpoints and wrong identity without inventing initializer markers", async () => {
    const projection = createHistoryEngineeringProjection({ expectedAccount, salt }, sourceProjection);
    await assert.rejects(projection.response({ role: "cowork-detail", bytes: Buffer.from("{}"),
        mime: "application/json", serialized: false }), { code: "NATIVE_ENGINEERING_REQUEST_SCOPE" });
    for (const change of [
        value => { value.store.identity.userPrincipalName = "wrong@invalid.test"; },
        value => { value.store = {}; },
    ]) {
        const value = payload(); change(value);
        await assert.rejects(projection.response({ role: "chat-initializer", bytes: Buffer.from(JSON.stringify(value)),
            mime: "application/json", serialized: false }), error => ["NATIVE_ENGINEERING_WRONG_IDENTITY", "NATIVE_ENGINEERING_SOURCE_SHAPE"].includes(error.code));
    }
    const value = payload(); value.historySource = "server-defined";
    assert.equal((await projection.response({ role: "chat-initializer", bytes: Buffer.from(JSON.stringify(value)),
        mime: "application/json", serialized: false })).marker, "none");
    const document = await projection.document({ router: { dehydratedData: { copilotBootstrap: {
        loaderData: { unqualifiedRoute: payload() },
    } } } });
    assert.equal(document.list, null, "A guessed historySource literal cannot qualify an SSR starting population.");
    const controller = createHistoryEngineering({ expectedAccount, salt, now: () => 0 });
    controller.bind({ signal: new AbortController().signal, deadline: 1000, check: () => true });
    controller.recordFailure("NATIVE_ENGINEERING_INITIALIZER_REQUIRED");
    controller.recordFailure("NATIVE_ENGINEERING_CLEANUP_FAILED");
    assert.equal(controller.summary().firstFailure.code, "NATIVE_ENGINEERING_INITIALIZER_REQUIRED");
});

test("browser-side engineering capture sends no raw body and blocks detail fetch before dispatch", async () => {
    const messages = [], calls = [];
    const window = { _binding: async value => { messages.push(value); } };
    let responsePayload = payload(), nativeFailure = null;
    window.fetch = async input => {
        calls.push(input);
        if (nativeFailure) throw nativeFailure;
        const response = new Response(JSON.stringify(responsePayload), { status: 200, headers: { "content-type": "application/json" } });
        Object.defineProperty(response, "url", { value: String(input) });
        return response;
    };
    const context = vm.createContext({ window, location: { origin: "https://m365.cloud.microsoft", href: "https://m365.cloud.microsoft/chat/all" },
        crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, DataView, URL, setTimeout, clearTimeout });
    vm.runInContext(`(${installHistoryEngineeringCapture.toString()})({binding:"_binding",projectionBinding:"_projection"},
        (${createHistoryEngineeringProjection.toString()})(${JSON.stringify({ expectedAccount, salt })},${sourceProjection.toString()}));`, context);
    await window.fetch(initializer);
    assert.equal(calls.length, 1);
    assert.ok(messages.some(value => value.type === "engineering-response" && value.projection.list.count === 1));
    assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_|encodedBody|lastMessage|chatName|https:\/\//);
    await assert.rejects(window.fetch("https://fixture.gateway.prod.island.powerapps.com/v1/tasks/live/detail?sessionId=PRIVATE"),
        { code: "NATIVE_ENGINEERING_CONTENT_READ_FORBIDDEN" });
    assert.equal(calls.length, 1);
    responsePayload = { unknown: "PRIVATE_RESPONSE" };
    assert.equal(await (await window.fetch(initializer)).text(), JSON.stringify(responsePayload));
    assert.ok(messages.some(value => value.type === "engineering-failure"));
    assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_RESPONSE/);
    nativeFailure = new Error("PRIVATE_NATIVE_FAILURE");
    await assert.rejects(window.fetch(initializer), error => error === nativeFailure);
});

test("engineering driver performs explicit initial/page/refresh only and skips an unavailable next page", async () => {
    const control = createHistoryEngineering({ expectedAccount, salt, now: () => 100 });
    control.bind({ signal: new AbortController().signal, deadline: 1000, check: () => true });
    control.authenticate();
    const actions = [];
    const answer = async (surface, step) => {
        const requestId = randomUUID(), page = step === "page";
        const url = surface === "chat" ? page
            ? "https://m365.cloud.microsoft/_serverFn/73e9366cfbebe3976abc796ef16c0305213fd6f32aea4731837e2a1f18e54268" : initializer
            : "https://fixture.gateway.prod.island.powerapps.com/v1/tasks/live";
        const method = surface === "chat" && page ? "POST" : "GET";
        const cursor = { state: page ? "present" : "absent", key: page ? "a".repeat(64) : null };
        const projection = surface === "chat"
            ? { role: page ? "chat-list" : "chat-initializer", basis: page ? "continuation" : "initializer", filter: "none", cursor,
                ...(page ? { store: "conversationPageHistoryList" } : {}) }
            : { role: "cowork-list", basis: page ? "continuation" : "first-page", filter: "none", cursor, pageSize: 25, includeCached: !page };
        control.prepareRequest({ requestId, method, requestUrlKey: control.urlKey(url), projection });
        control.matchRequest(url, method);
        control.accept(requestId, { role: projection.role, principal: null, marker: surface === "chat" && !page ? "all-chats" : "none",
            list: { surface, members: ["b".repeat(64)], count: 1, tail: "b".repeat(64),
                times: { minimum: 1800000000000, maximum: 1800000000000, unqualified: 0 },
                cursor: { state: surface === "chat" && step === "initial" ? "present" : "null",
                    key: surface === "chat" && step === "initial" ? "a".repeat(64) : null } } }, 100);
    };
    const result = await runHistoryEngineeringSteps(control, {
        initial: async surface => { actions.push(surface + ":initial"); await answer(surface, "initial"); },
        page: async surface => { actions.push(surface + ":page"); await answer(surface, "page"); return true; },
        refresh: async surface => { actions.push(surface + ":refresh"); await answer(surface, "refresh"); },
        wait: async done => assert.equal(done(), true),
    });
    assert.deepEqual(actions, ["chat:initial", "chat:page", "chat:refresh", "cowork:initial", "cowork:refresh"]);
    assert.equal(result.steps.find(row => row.step === "cowork:page").outcome, "unavailable");
    assert.equal(result.positiveCoverage, false);
    assert.equal(result.outcome, "observed");
});

test("engineering custody cleanup refuses a changed marker or live profile owner and removes only its own root", async () => {
    const custody = await createEngineeringCustody(randomUUID());
    let removed = false, probes = 0;
    const empty = async () => { probes++; return []; };
    try {
        await mkdir(custody.profileDirectory, { recursive: true });
        await writeFile(path.join(custody.profileDirectory, "fixture-cache"), "PRIVATE_TRANSIENT_CACHE");
        await assert.rejects(cleanupEngineeringCustody({ ...custody, operationId: randomUUID() }, { inspectOwners: empty }),
            { code: "NATIVE_ENGINEERING_CUSTODY" });
        assert.equal(probes, 0);
        await assert.rejects(cleanupEngineeringCustody(custody, { inspectOwners: async () => [123] }),
            { code: "NATIVE_ENGINEERING_CUSTODY_NOT_RELEASED" });
        assert.equal((await stat(custody.profileDirectory)).isDirectory(), true);
        const result = await cleanupEngineeringCustody(custody, { inspectOwners: empty });
        removed = true;
        assert.equal(result.profileRemoved, true);
        assert.equal(probes, 2);
        await assert.rejects(stat(custody.root), { code: "ENOENT" });
    } finally {
        if (!removed) await cleanupEngineeringCustody(custody, { inspectOwners: empty });
    }
});

test("engineering deadlines and closed scope reject another request without replacing the first failure", () => {
    let now = 0;
    const control = createHistoryEngineering({ expectedAccount, salt, now: () => now });
    control.bind({ signal: new AbortController().signal, deadline: 100, check: () => true });
    control.authenticate();
    now = 100;
    assert.throws(() => control.begin("chat", "initial"), { code: "NATIVE_ENGINEERING_AUTHORITY_LOST" });
    control.recordFailure("NATIVE_ENGINEERING_AUTHORITY_LOST");
    control.recordFailure("NATIVE_ENGINEERING_CLEANUP_FAILED");
    assert.equal(control.summary().firstFailure.code, "NATIVE_ENGINEERING_AUTHORITY_LOST");
});

test("engineering authority cannot activate ordinary startup, acquisition or an unbranded controller", async () => {
    const custody = await createEngineeringCustody(randomUUID());
    try {
        const context = { dataDir: custody.dataDir, sessionId: randomUUID() };
        const configuration = await prepareMicrosoftNativeConfiguration(context, expectedAccount, { check() {}, dispatched() {} });
        const engineering = createHistoryEngineering({ expectedAccount, salt });
        for (const change of [{ ordinaryStartup: true }, { nativeAcquisition: true },
            { accountOnlyVerification: true }, { observeAuthenticationChain: true }, { engineering: {} }]) {
            await assert.rejects(createMicrosoftNativeHost(context, { configuration, sourceAware: true, engineering, ...change }),
                { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
        }
    } finally { await cleanupEngineeringCustody(custody, { inspectOwners: async () => [] }); }
});

const emptyDocument = () => ({ role: "document", principal: null, list: null, marker: "none" });
const emptyChatDocument = () => ({ ...emptyDocument(), marker: "all-chats", list: {
    surface: "chat", members: [], count: 0, tail: null,
    times: { minimum: null, maximum: null, unqualified: 0 }, cursor: { state: "empty", key: null },
} });
function boundControl() {
    const value = createHistoryEngineering({ expectedAccount, salt, now: () => 0 });
    value.bind({ signal: new AbortController().signal, deadline: 10000, check: () => true });
    return value;
}

test("engineering principal-only and mixed documents charge exact bytes and request counts once", () => {
    const value = boundControl(), key = "1".repeat(64), maximum = 2 * 1024 * 1024;
    value.acceptDocument(key, emptyDocument(), maximum);
    assert.equal(value.summary().requests, 1);
    assert.equal(value.summary().bytes, maximum);
    assert.throws(() => value.acceptDocument(key, emptyDocument(), maximum));
    assert.equal(value.summary().requests, 1);
    value.authenticate();
    value.begin("chat", "initial");
    value.acceptDocument("2".repeat(64), emptyChatDocument(), maximum);
    assert.equal(value.summary().requests, 2);
    assert.equal(value.summary().bytes, maximum * 2);
    for (let i = 3; i <= 8; i++) value.acceptDocument(String(i).repeat(64), emptyDocument(), maximum);
    assert.equal(value.summary().bytes, 16 * 1024 * 1024);
    assert.throws(() => value.acceptDocument("9".repeat(64), emptyDocument(), 1), { code: "NATIVE_ENGINEERING_BYTE_LIMIT" });
    const counted = boundControl();
    for (let i = 0; i < 18; i++) counted.acceptDocument(i.toString(16).padStart(64, "0"), emptyDocument(), 1);
    assert.equal(counted.summary().requests, 18);
    assert.throws(() => counted.acceptDocument("f".repeat(64), emptyDocument(), 1), { code: "NATIVE_ENGINEERING_REQUEST_LIMIT" });
});

function coworkStart(filter, cursorKey = "a".repeat(64)) {
    const value = boundControl();
    value.authenticate();
    value.begin("chat", "initial"); value.acceptDocument("1".repeat(64), emptyChatDocument(), 1);
    value.begin("chat", "page");
    value.begin("chat", "refresh"); value.acceptDocument("2".repeat(64), emptyChatDocument(), 1);
    value.begin("cowork", "initial");
    const requestId = randomUUID(), url = "https://fixture.gateway.prod.island.powerapps.com/v1/tasks/live";
    value.prepareRequest({ requestId, method: "GET", requestUrlKey: value.urlKey(url), projection: {
        role: "cowork-list", cursor: { state: "absent", key: null }, basis: "first-page", filter, pageSize: 25, includeCached: true,
    } });
    value.matchRequest(url, "GET");
    value.accept(requestId, { role: "cowork-list", principal: null, marker: "none", list: {
        surface: "cowork", members: [], count: 0, tail: null,
        times: { minimum: null, maximum: null, unqualified: 0 }, cursor: { state: "present", key: cursorKey },
    } }, 1);
    value.begin("cowork", "page");
    return { value, url };
}

for (const [initialFilter, nextFilter] of [["interactive", "none"], ["none", "interactive"], ["interactive", "unobserved"]]) {
    test(`engineering continuation rejects semantic filter ${initialFilter} -> ${nextFilter}`, () => {
        const { value, url } = coworkStart(initialFilter);
        assert.throws(() => value.prepareRequest({ requestId: randomUUID(), method: "GET", requestUrlKey: value.urlKey(url), projection: {
            role: "cowork-list", cursor: { state: "present", key: "a".repeat(64) }, basis: "continuation",
            filter: nextFilter, pageSize: 100, includeCached: false,
        } }), { code: "NATIVE_ENGINEERING_SEMANTIC_SCOPE" });
    });
}

test("engineering continuation retains semantic filter while allowing documented transport differences", () => {
    const { value, url } = coworkStart("interactive");
    assert.equal(value.prepareRequest({ requestId: randomUUID(), method: "GET", requestUrlKey: value.urlKey(url), projection: {
        role: "cowork-list", cursor: { state: "present", key: "a".repeat(64) }, basis: "continuation",
        filter: "interactive", pageSize: 100, includeCached: false,
    } }), true);
});

test("engineering actual Cowork query projections reject removed, added and unknown session filters", async () => {
    const projection = createHistoryEngineeringProjection({ expectedAccount, salt }, sourceProjection);
    for (const [initial, next] of [["interactive", "none"], ["none", "interactive"]]) {
        const { value, url } = coworkStart(initial, await projection.hash("cursor:PRIVATE_CURSOR"));
        const requestUrl = url + "?pageSize=100&cursor=PRIVATE_CURSOR" + (next === "interactive" ? "&sessionType=interactive" : "");
        const request = await projection.request({ url: requestUrl, method: "GET" });
        assert.throws(() => value.prepareRequest({ requestId: randomUUID(), method: "GET",
            requestUrlKey: value.urlKey(requestUrl), projection: request }), { code: "NATIVE_ENGINEERING_SEMANTIC_SCOPE" });
    }
    await assert.rejects(projection.request({
        url: "https://fixture.gateway.prod.island.powerapps.com/v1/tasks/live?pageSize=100&cursor=PRIVATE_CURSOR&sessionType=scheduled",
        method: "GET",
    }), { code: "NATIVE_ENGINEERING_REQUEST_SCOPE" });
});

test("engineering Chat paging cannot substitute another store and authenticated ownership cannot be rebound", () => {
    const value = boundControl();
    value.authenticate();
    assert.throws(() => value.authenticate(), { code: "NATIVE_ENGINEERING_ACCOUNT_SCOPE" });
    value.begin("chat", "initial");
    value.acceptDocument("1".repeat(64), { ...emptyChatDocument(),
        list: { ...emptyChatDocument().list, cursor: { state: "present", key: "a".repeat(64) } } }, 1);
    value.begin("chat", "page");
    assert.throws(() => value.prepareRequest({ requestId: randomUUID(), method: "POST",
        requestUrlKey: value.urlKey(initializer), projection: { role: "chat-list", store: "chatLandingPageHistoryList",
            cursor: { state: "present", key: "a".repeat(64) }, basis: "continuation", filter: "none" } }),
    { code: "NATIVE_ENGINEERING_SEMANTIC_SCOPE" });
});
