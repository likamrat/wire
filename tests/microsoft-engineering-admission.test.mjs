import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { accountOnlyRequestDecision, assertNativeRequestAdmission, guardAccountOnlyRequests,
    nativeFailureForPublication, recordNativeEngineeringFailure, recordNativeHostFailure, admitNativeRequestObservation, nativeProtocolFailure } from "../lib/microsoft-native-host.mjs";
import { createMicrosoftNativeRequestObserver } from "../lib/microsoft-native-request-observer.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { nativeFailureDetails, withNativeFailureAdmission, validNativeAdmission,
    withNativeFailureProtocolStop, validNativeProtocolStop } from "../lib/microsoft-session-state.mjs";
import { createHistoryEngineering, withHistoryEngineeringStartup } from "../lib/microsoft-history-engineering.mjs";
import { persistHistoryInvestigationResult } from "../scripts/investigate-native-history.mjs";

const control = () => createHistoryEngineering({ expectedAccount: "example@invalid.test", salt: Array(32).fill(7) });
const later = () => Object.assign(new Error("PRIVATE_LATER_ERROR"), { code: "NATIVE_SOURCE_REQUEST_FAILED" });
const privateData = /PRIVATE_|https?:|[?&]secret=|"(?:headers|authorization|payload|cursor)"\s*:|token-value/i;

test("Windows operator closes the actual CLI preparation without a process signal or native launch",
    { timeout: 60000, skip: process.platform !== "win32" || !process.env.WIRE_HISTORY_TEST_COMMIT }, async t => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "wire-preparation-operator-"));
        const output = path.join(directory, "result.json");
        const script = fileURLToPath(new URL("../scripts/investigate-native-history.mjs", import.meta.url));
        const preload = `
            const {chromium}=await import(${JSON.stringify(import.meta.resolve("playwright"))});
            chromium.launchPersistentContext=async()=>{process.send?.({type:"native-launch-blocked"});throw Error("OFFLINE_NATIVE_LAUNCH_FORBIDDEN");};
            const originalFetch=globalThis.fetch;
            globalThis.fetch=(input,...args)=>{const u=new URL(typeof input==="string"?input:input.url);
                if(u.hostname!=="127.0.0.1")throw Error("OFFLINE_PROVIDER_FETCH_FORBIDDEN");return originalFetch(input,...args);};
            process.on("message", value=>{if(value?.type==="fixture-stop"){
                process.send?.({type:"fixture-stop-used"});process.emit("SIGINT");}});
            process.channel?.unref();
        `;
        const environment = { ...process.env };
        delete environment.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(preload), script,
            "--normal-entry", "--expected-commit", process.env.WIRE_HISTORY_TEST_COMMIT,
            "--expected-account", "example@invalid.test", "--authorization-reference", "offline-preparation-operator",
            "--output", output], { env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
        const exited = once(child, "exit"), ready = Promise.withResolvers(), messages = [], events = [];
        let pending = "", stderr = "";
        child.on("message", value => messages.push(value));
        child.stderr.on("data", value => { stderr = (stderr + value).slice(-4096); });
        child.stdout.on("data", value => {
            pending += value;
            let end;
            while ((end = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
                if (!line) continue;
                const event = JSON.parse(line); events.push(event);
                if (event.type === "normal-entry-ready") ready.resolve(event);
            }
        });
        t.after(async () => {
            if (child.exitCode === null && child.signalCode === null && child.connected) child.send({ type: "fixture-stop" });
            await Promise.race([exited, delay(15000, undefined, { ref: false }).then(() => { throw Error("Owned fixture cleanup did not finish."); })]);
            await rm(directory, { recursive: true, force: true });
        });
        const entry = await Promise.race([ready.promise,
            exited.then(() => { throw Error("CLI exited before readiness: " + stderr); }),
            delay(30000, undefined, { ref: false }).then(() => { throw Error("Owned CLI preparation did not become ready."); })]);
        const custody = JSON.parse(await readFile(output + ".custody", "utf8"));
        assert.equal(entry.microsoft, "not-started");
        assert.equal(entry.preparationClose, "owned-ipc");
        assert.equal((await fetch(new URL("/health", entry.url))).status, 200);
        assert.equal(events.some(event => ["connect-started", "window-ready", "human-needed"].includes(event.type)), false);
        const binding = custody.preparationClose;
        assert.match(binding.capability, /^[a-f0-9]{64}$/);
        async function packet(value) {
            const socket = net.createConnection({ path: binding.address });
            let response = "";
            const ended = new Promise(resolve => socket.once("close", resolve));
            socket.on("error", () => socket.destroy());
            socket.on("data", chunk => { response += chunk; });
            await once(socket, "connect");
            if (value !== null) socket.end(value);
            await ended;
            return response.trim() ? JSON.parse(response) : null;
        }
        const valid = { schemaVersion: 1, action: "close-preparation", operationId: entry.operationId,
            outputFile: output, capability: binding.capability };
        for (const changed of [
            { ...valid, operationId: randomUUID() }, { ...valid, outputFile: output + ".foreign" },
            { ...valid, capability: (binding.capability[0] === "0" ? "1" : "0") + binding.capability.slice(1) },
            { ...valid, action: "microsoft-connect" }, { ...valid, extra: true },
        ]) assert.equal((await packet(JSON.stringify(changed) + "\n")).disposition, "refused");
        assert.equal((await packet("{\n")).disposition, "refused");
        assert.equal(await packet("x".repeat(4097)), null);
        assert.equal(await packet(null), null, "Idle clients must be closed without cancelling preparation.");
        assert.equal((await fetch(new URL("/health", entry.url))).status, 200);
        assert.equal(events.some(event => event.type === "failure"), false);
        const quote = value => "'" + value.replaceAll("'", "''") + "'";
        const operator = spawn("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
            `& ${quote(process.execPath)} ${quote(script)} --close-preparation ${quote(output + ".custody")}; exit $LASTEXITCODE`],
        { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const operatorExit = once(operator, "exit");
        let response = "", operatorError = "";
        operator.stdout.on("data", value => { response += value; });
        operator.stderr.on("data", value => { operatorError = (operatorError + value).slice(-4096); });
        const [code] = await operatorExit;
        assert.equal(code, 0, "A separate Windows operator invocation must request graceful owned close: " + operatorError);
        assert.equal(JSON.parse(response).disposition, "accepted");
        assert.equal((await exited)[0], 1, "A closed preparation is not a successful Microsoft acquisition.");
        const result = JSON.parse(await readFile(output, "utf8"));
        assert.equal(result.operationId, entry.operationId);
        assert.equal(result.source.operationStarted, false);
        assert.equal(result.source.outcome, "not-started");
        assert.equal(result.source.firstFailure.step, "preparation");
        assert.equal(result.cleanup.disposition, "removed");
        await assert.rejects(stat(custody.root), { code: "ENOENT" });
        const resultBytes = await readFile(output, "utf8");
        const { requestHistoryPreparationClose } = await import("../scripts/investigate-native-history.mjs");
        const duplicate = await requestHistoryPreparationClose(output + ".custody");
        assert.equal(duplicate.disposition, "terminal-record-present");
        assert.equal(await readFile(output, "utf8"), resultBytes);
        assert.equal(JSON.stringify({ events, result, response }).includes(binding.capability), false);
        assert.deepEqual(messages, [], "Positive proof must use neither native launch nor the fixture-only cleanup fallback.");
    });

const admissionCases = [
    ...["network-record-missing", "request-failed", "response-correlation"].map(protocolReason => ({
        label: "active protocol stop " + protocolReason, protocolReason,
        method: "GET", type: "Document", url: "https://m365.cloud.microsoft/home", publicRoute: "other-account-page",
    })),
    { label: "startup origin and provenance", predicate: "document-scope", url: "https://www.office.com/PRIVATE_ROUTE",
        method: "GET", type: "Document", publicRoute: "other", engineeringOrigin: true,
        document: { originClass: "known-unadmitted-origin", originLabel: "office", routeLabel: "unknown", clause: "outside-admitted-origins" } },
    ...["explicit", "different", "redirect"].map(originCase => ({
        label: "startup origin and provenance " + originCase, originCase, predicate: "document-scope",
        url: "https://www.office.com/PRIVATE_ROUTE", method: "GET", type: "Document", publicRoute: "other", engineeringOrigin: true,
        document: { originClass: "known-unadmitted-origin", originLabel: "office", routeLabel: "unknown", clause: "outside-admitted-origins" },
    })),
    { label: "document boundary admitted-app", predicate: "document-scope", url: "https://m365.cloud.microsoft/PRIVATE_ROUTE",
        method: "GET", type: "Document", publicRoute: "other",
        document: { originClass: "admitted-app", originLabel: "m365-app", routeLabel: "unknown", clause: "unlisted-app-path" } },
    { label: "document boundary outside-known-origin", predicate: "document-scope", url: "https://PRIVATE_HOST.invalid/PRIVATE_ROUTE",
        method: "GET", type: "Document", publicRoute: "other",
        document: { originClass: "outside-known-origin", originLabel: "unknown", routeLabel: "unknown", clause: "outside-admitted-origins" } },
    { label: "document boundary known outside origin", predicate: "document-scope", url: "https://www.office.com/",
        method: "GET", type: "Document", publicRoute: "other",
        document: { originClass: "known-unadmitted-origin", originLabel: "office", routeLabel: "root", clause: "outside-admitted-origins" } },
    { label: "document boundary known unlisted app path", predicate: "document-scope", url: "https://copilot.cloud.microsoft/signinDev",
        method: "GET", type: "Document", publicRoute: "other",
        document: { originClass: "admitted-app", originLabel: "copilot-app", routeLabel: "sign-in-dev", clause: "unlisted-app-path" } },
    { label: "document boundary deceptive origin", predicate: "document-scope", url: "https://login.microsoftonline.com.PRIVATE_HOST.invalid/home",
        method: "GET", type: "Document", publicRoute: "other",
        document: { originClass: "outside-known-origin", originLabel: "unknown", routeLabel: "unknown", clause: "outside-admitted-origins" } },
    { predicate: "auth-data", url: "https://login.microsoftonline.com/PRIVATE_ROUTE", method: "GET", type: "Fetch", publicRoute: "other" },
    { predicate: "shell-document-scope", url: "https://m365.cloud.microsoft/chat", method: "POST", type: "Fetch", publicRoute: "shell" },
    { predicate: "business-data", url: "https://foreign.invalid/messages/PRIVATE_ROUTE", method: "GET", type: "Fetch", publicRoute: "protected-data" },
    { predicate: "token-scope", url: "https://login.microsoftonline.com/common/oauth2/v2.0/token", method: "GET", type: "Fetch", publicRoute: "token" },
    { predicate: "self-scope", url: "https://graph.microsoft.com/v1.0/me", method: "POST", type: "Fetch", publicRoute: "self" },
    { predicate: "self-preflight-association", url: "https://graph.microsoft.com/v1.0/me", method: "OPTIONS", type: "Other", publicRoute: "self" },
    { predicate: "document-scope", url: "https://foreign.invalid/PRIVATE_ROUTE", method: "GET", type: "Document", publicRoute: "other" },
    { predicate: "sign-in-return-method", url: "https://login.microsoftonline.com/PRIVATE_ROUTE", method: "POST", type: "Document", publicRoute: "other" },
    { predicate: "method-scope", url: "https://foreign.invalid/PRIVATE_ROUTE", method: "PATCH", type: "Other", publicRoute: "other" },
    { predicate: "data-dependency", url: "https://foreign.invalid/PRIVATE_ROUTE", method: "GET", type: "Other", publicRoute: "other" },
    ...["budget", "closed", "no-phase", "kind", "duplicate"].map(mode => ({ mode,
        predicate: mode === "budget" ? "request-observation-budget" : "request-observer-" + mode,
        url: "https://m365.cloud.microsoft/_serverFn/" + "a".repeat(64), method: "GET", type: "Fetch", publicRoute: "other" })),
];

for (const scenario of admissionCases) test(`authentication admission evidence reaches persisted result: ${scenario.label ?? scenario.predicate}`, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wire-admission-evidence-"));
    let session, firstError, failCleanup = true;
    t.after(async () => { failCleanup = false; await session?.close(); await rm(directory, { recursive: true, force: true }); });
    const engineering = control(), callbacks = [];
    const transport = createMicrosoftNativeReadTransport({
        async open(operation) { engineering.beginConnection(operation); },
        async verifyAccount(operation) {
            const protocol = new EventEmitter(), pending = new Set(), commands = [];
            protocol.send = async (method, value) => { commands.push(method); return {}; };
            const scope = { abort: new AbortController(), native: {}, page: { url: () => "about:blank" } };
            const observer = createMicrosoftNativeRequestObserver({ lifecycle: session });
            if (scenario.mode !== "no-phase") await observer.beginPhase("native-connect", { signal: scope.abort.signal });
            const observedRequest = {};
            if (scenario.mode === "closed") observer.close();
            if (scenario.mode === "duplicate") assert.equal(observer.observe(observedRequest, "principal"), true);
            const gate = await guardAccountOnlyRequests(protocol, {
                mainFrameId: "root", getScope: () => scope, diagnoseFrames: false, isSelfUrl: () => false,
                admit(current, facts, stage) {
                    try {
                        if (scenario.mode) {
                            admitNativeRequestObservation(observer, observedRequest, scenario.mode === "kind" ? "chat" : "principal",
                                scenario.mode === "budget" ? 2 : 1, 1, facts, "network");
                            assert.fail("The selected original observer branch must refuse.");
                        }
                        const decision = accountOnlyRequestDecision(facts);
                        if (scenario.protocolReason) {
                            assert.equal(decision.kind, "document");
                            return decision.kind;
                        }
                        if (scenario.originCase === "redirect" && facts.url.href === scope.native.engineeringInvocation.url) {
                            assert.equal(decision.kind, "shell");
                            return decision.kind;
                        }
                        assert.equal(decision.denied, scenario.predicate);
                        assertNativeRequestAdmission(!decision.denied, facts, stage, decision.denied,
                            scenario.engineeringOrigin ? { engineering, scope, mainFrameId: "root" } : null);
                        return decision.kind;
                    } catch (error) {
                        firstError = error;
                        recordNativeEngineeringFailure(engineering, error);
                        recordNativeHostFailure(scope, nativeFailureForPublication(error, "connect"));
                        current.abort.abort();
                        return null;
                    }
                },
                responded(_scope, _kind, _method, status) {
                    assert.equal(scenario.originCase, "redirect");
                    assert.equal(status, 302);
                },
                stop(current, reason, facts, observation) {
                    if (!scenario.protocolReason) return;
                    firstError ??= nativeProtocolFailure(reason, facts, { scope: current, mainFrameId: "root", observation });
                    recordNativeEngineeringFailure(engineering, firstError, current);
                    recordNativeHostFailure(current, nativeFailureForPublication(firstError, "connect"));
                    current.abort.abort();
                },
                track(work) { pending.add(work); work.then(() => pending.delete(work), () => pending.delete(work)); return work; },
            });
            if (scenario.engineeringOrigin) {
                const invocation = { url: scenario.originCase === "explicit" ? scenario.url + "?secret=PRIVATE_QUERY#PRIVATE_FRAGMENT"
                    : "https://m365.cloud.microsoft/chat", frameId: "root", preexistingNetworkIds: new Set() };
                if (scenario.originCase) scope.native.engineeringInvocation = invocation;
                if (scenario.originCase === "redirect") {
                    protocol.emit("Network.requestWillBeSent", {
                        requestId: "network", frameId: "root", type: "Document", loaderId: "loader",
                        initiator: { type: "other" }, request: { method: "GET", url: invocation.url },
                    });
                    const request = { method: "GET", url: invocation.url };
                    protocol.emit("Fetch.requestPaused", { requestId: "previous-request", networkId: "network",
                        frameId: "root", resourceType: "Document", request });
                    await Promise.all([...pending]);
                    protocol.emit("Fetch.requestPaused", { requestId: "previous-request", networkId: "network",
                        frameId: "root", resourceType: "Document", request, responseStatusCode: 302 });
                    await Promise.all([...pending]);
                }
                protocol.emit("Network.requestWillBeSent", { requestId: "network", frameId: "root", type: scenario.type,
                    loaderId: "loader", initiator: { type: "other" }, request: { method: scenario.method,
                        url: scenario.url + "?secret=PRIVATE_QUERY#PRIVATE_FRAGMENT" },
                    ...(scenario.originCase === "redirect" ? { redirectResponse: { url: invocation.url } } : {}) });
                if (!scenario.originCase) scope.native.engineeringInvocation = { ...invocation,
                    preexistingNetworkIds: new Set(scope.native.requestOrigins.keys()) };
            }
            if (scenario.protocolReason && scenario.protocolReason !== "network-record-missing") {
                scope.native.engineeringInvocation = { url: scenario.url + "?secret=PRIVATE_QUERY#PRIVATE_FRAGMENT",
                    frameId: "root", preexistingNetworkIds: new Set() };
                protocol.emit("Network.requestWillBeSent", { requestId: "network", frameId: "root", type: "Document",
                    initiator: { type: "other" }, request: { url: scope.native.engineeringInvocation.url, method: "GET" } });
            }
            if (scenario.protocolReason !== "network-record-missing") protocol.emit("Fetch.requestPaused", { requestId: "request", networkId: "network", frameId: "root",
                ...(scenario.originCase === "redirect" ? { redirectedRequestId: "previous-request" } : {}),
                resourceType: scenario.type, request: { method: scenario.method,
                    url: scenario.url + "?secret=PRIVATE_QUERY#PRIVATE_FRAGMENT",
                    headers: { authorization: "PRIVATE_TOKEN" }, postData: "PRIVATE_PAYLOAD" } });
            await Promise.all([...pending]);
            if (scenario.protocolReason) {
                if (scenario.protocolReason === "response-correlation") protocol.emit("Fetch.requestPaused", {
                    requestId: "request", networkId: "mismatched-network", frameId: "root", resourceType: "Document",
                    responseStatusCode: 200, request: { url: scenario.url + "?secret=PRIVATE_QUERY#PRIVATE_FRAGMENT", method: "GET" },
                });
                else protocol.emit("Network.loadingFailed", { requestId: "network", errorText: "PRIVATE_NETWORK_ERROR", canceled: false });
                await Promise.all([...pending]);
                assert.equal(commands.filter(method => method === "Fetch.continueRequest").length,
                    scenario.protocolReason === "network-record-missing" ? 0 : 1);
            } else {
                assert.equal(commands.filter(method => method === "Fetch.continueRequest").length, scenario.originCase === "redirect" ? 1 : 0);
                assert.ok(commands.includes("Fetch.failRequest"));
            }
            gate.retire();
            observer.close();
            callbacks.push(await operation.recordFailure(nativeFailureDetails(scope.error, "connect")));
            if (scenario.protocolReason) {
                const gotoError = Object.assign(new Error("PRIVATE_GOTO_TIMEOUT"), { code: "NATIVE_SOURCE_READ_FAILED" });
                assert.equal(recordNativeHostFailure(scope, nativeFailureForPublication(gotoError, "connect")), false);
                recordNativeEngineeringFailure(engineering, gotoError, scope);
            }
            recordNativeEngineeringFailure(engineering, later());
            callbacks.push(await operation.recordFailure(nativeFailureDetails(later(), "connect")));
            throw scope.error;
        },
        async stop() {
            if (failCleanup) throw Object.assign(new Error("PRIVATE_CLEANUP"), { code: "cleanup-failed" });
            return { processExited: true, profileReleased: true };
        },
    });
    session = await createMicrosoftSession({ dataDir: directory }, { transport, collection: { paused: false, windowDays: 14 },
        timeoutMs: 5000, cleanupMs: 1000 });
    const owner = "offline-admission-owner";
    for (const action of ["wire-sign-in", "microsoft-connect"]) {
        const receipt = await session.command(owner, { action, operationId: randomUUID(), generation: (await session.status()).generation,
            ...(action === "microsoft-connect" ? { replace: false } : {}) }, () => true);
        assert.equal(receipt.nativeEvidence, undefined);
    }
    const sessionFile = path.join(directory, "microsoft-session", "session.json");
    const saved = JSON.parse(await readFile(sessionFile, "utf8"));
    const evidence = saved.receipts.find(row => row.action === "microsoft-connect").nativeEvidence;
    const original = evidence.firstFailure;
    assert.equal(evidence.cleanup.state, "failed");
    const resultFile = path.join(directory, "result.json"), events = [];
    const input = { engineering, operationId: randomUUID(), authorizationReference: "offline-only",
        startedAt: new Date().toISOString(), cleanup: { disposition: "not-verified" }, custodyRoot: null,
        outputFile: resultFile, emit: value => events.push(value) };
    const blockedFile = path.join(directory, "existing.json");
    await writeFile(blockedFile, "do-not-overwrite");
    await assert.rejects(persistHistoryInvestigationResult({ ...input, outputFile: blockedFile }), { code: "EEXIST" });
    recordNativeEngineeringFailure(engineering, Object.assign(new Error("PRIVATE_STORAGE_ERROR"), { code: "storage-failed" }));
    await persistHistoryInvestigationResult(input);
    const result = JSON.parse(await readFile(resultFile, "utf8"));
    if (scenario.engineeringOrigin) {
        assert.equal(result.source.firstFailure.startup?.origin, "https://www.office.com");
        assert.deepEqual(result.source.firstFailure.startup?.provenance, { binding: "matched-original-request",
            frame: "root", requestRelation: scenario.originCase ? scenario.originCase === "explicit" ? "requested-destination-match"
                : "different-destination" : "preexisting-before-invocation", invocationState: "started",
            initiator: "other", document: "blank", redirect: scenario.originCase === "redirect" ? "from-requested-destination" : "not-observed" });
        assert.equal(original.startup, undefined);
        assert.doesNotMatch(JSON.stringify(events), /www\.office\.com|https?:|PRIVATE_/);
    }
    assert.deepEqual(callbacks, [true, false]);
    assert.equal(firstError.code, scenario.protocolReason ? "NATIVE_SOURCE_REQUEST_FAILED" : "NATIVE_SOURCE_REQUEST_UNQUALIFIED");
    assert.equal(original.code, firstError.code);
    assert.equal(result.source.firstFailure.code, firstError.code);
    if (scenario.protocolReason) {
        const expectedStop = { reason: scenario.protocolReason,
            phase: scenario.protocolReason === "response-correlation" ? "response" : "network",
            ...(scenario.protocolReason === "response-correlation" ? {} : { terminal: "failed" }),
            ...(scenario.protocolReason === "network-record-missing" ? {
                networkRecord: { observation: "unobserved", resourceType: "unobserved", urlClass: "unobserved",
                    frame: "unobserved", document: "unobserved", loader: "unobserved" },
            } : {
                request: { method: "GET", resourceType: "document", owner: "owned-frame", original: true, navigation: true },
                provenance: { request: scenario.protocolReason === "response-correlation" ? "unobserved" : "matched",
                    frame: "root", invocation: scenario.protocolReason === "response-correlation" ? "unobserved" : "requested-destination-match" },
            }),
        };
        assert.deepEqual(original.protocolStop, expectedStop);
        assert.deepEqual(result.source.firstFailure.protocolStop, expectedStop);
        assert.deepEqual(nativeFailureDetails(firstError).protocolStop, expectedStop);
        assert.equal(result.source.firstFailure.predicate.name, "protocol-stop");
        withNativeFailureProtocolStop(firstError, { reason: "protocol-coverage", phase: "unobserved" });
        assert.deepEqual(nativeFailureDetails(firstError).protocolStop, expectedStop);
        for (const malformed of [
            { ...expectedStop, reason: "PRIVATE_REASON" }, { ...expectedStop, terminal: "PRIVATE_ERROR" },
            { ...expectedStop, url: "https://PRIVATE_HOST" },
            { ...expectedStop, request: { method: "GET", resourceType: "document", owner: "owned-frame",
                original: true, navigation: true, headers: "PRIVATE_HEADER" } },
        ]) {
            assert.equal(validNativeProtocolStop(malformed), false);
            assert.throws(() => withNativeFailureProtocolStop(later(), malformed), { code: "invalid-request" });
        }
        if (expectedStop.request) assert.throws(() => {
            nativeFailureDetails(firstError).protocolStop.request.method = "POST";
        }, TypeError);
        assert.doesNotMatch(JSON.stringify({ original, result, events }), privateData);
        return;
    }
    const expected = { schemaVersion: 1, method: scenario.method, resourceType: scenario.type.toLowerCase(), publicRoute: scenario.publicRoute,
        owner: "owned-frame", original: scenario.originCase !== "redirect", navigation: scenario.type === "Document", predicate: scenario.predicate,
        stage: scenario.mode ? "network" : "protocol", ...(scenario.predicate === "document-scope" ? { document: scenario.document
            ?? { originClass: "outside-known-origin", originLabel: "unknown", routeLabel: "unknown", clause: "outside-admitted-origins" } } : {}) };
    assert.deepEqual(nativeFailureDetails(firstError).admission, expected);
    assert.deepEqual(original.admission, expected);
    assert.deepEqual(result.source.firstFailure.admission, expected);
    withNativeFailureAdmission(firstError, { ...expected, ...(expected.document ? { document: {
        originClass: "known-unadmitted-origin", originLabel: "outlook", routeLabel: "unknown", clause: "outside-admitted-origins",
    } } : { predicate: "data-dependency" }) });
    assert.deepEqual(nativeFailureDetails(firstError).admission, expected);
    const lateSink = control(), latched = { abort: new AbortController() };
    recordNativeHostFailure(latched, nativeFailureForPublication(firstError, "connect"));
    recordNativeEngineeringFailure(lateSink, later(), latched);
    assert.deepEqual(lateSink.summary().firstFailure.admission, expected);
    if (scenario.engineeringOrigin) assert.deepEqual(lateSink.summary().firstFailure.startup, result.source.firstFailure.startup);
    for (const changed of [{ ...expected, publicRoute: "https://PRIVATE_ROUTE" }, { ...expected, predicate: "PRIVATE_PREDICATE" },
        { ...expected, header: "PRIVATE_TOKEN" }, { ...expected, owner: "PRIVATE_ACCOUNT" }]) {
        assert.equal(validNativeAdmission(changed), false);
        assert.throws(() => withNativeFailureAdmission(later(), changed), { code: "invalid-request" });
    }
    if (expected.document) {
        const { document, ...legacy } = expected;
        assert.equal(validNativeAdmission(legacy), true, "The original nine-field diagnostic remains readable.");
        for (const changed of [
            { ...document, originLabel: "PRIVATE_HOST" }, { ...document, routeLabel: "PRIVATE_PATH" },
            { ...document, clause: "PRIVATE_CLAUSE" }, { ...document, originClass: "admitted-anything" },
            { ...document, query: "PRIVATE_QUERY" }, { ...document, urlHash: "a".repeat(64) },
            { ...document, originClass: "admitted-auth", originLabel: "unknown" }, null,
        ]) {
            assert.equal(validNativeAdmission({ ...expected, document: changed }), false);
            assert.throws(() => withNativeFailureAdmission(later(), { ...expected, document: changed }), { code: "invalid-request" });
        }
        assert.throws(() => { nativeFailureDetails(firstError).admission.document.routeLabel = "PRIVATE_MUTATION"; }, TypeError);
    }
    assert.doesNotMatch(JSON.stringify({ original, result: scenario.engineeringOrigin ? { ...result, source: {
        ...result.source, firstFailure: { ...result.source.firstFailure, startup: undefined } } } : result, events }), privateData);
});

test("document boundary diagnostics preserve admitted routes and reject deceptive destinations without extra access", () => {
    const base = { method: "GET", type: "document", navigation: true, owned: true, original: true };
    for (const value of ["https://m365.cloud.microsoft/home", "https://copilot.cloud.microsoft/login",
        "https://login.microsoftonline.com/PRIVATE_TENANT/oauth2/v2.0/authorize?secret=PRIVATE_QUERY",
        "https://login.microsoft.com/PRIVATE_PATH", "https://autologon.microsoftazuread-sso.com/PRIVATE_PATH"]) {
        assert.equal(accountOnlyRequestDecision({ ...base, url: new URL(value) }).kind, "document");
    }
    for (const value of ["https://m365.cloud.microsoft.PRIVATE_HOST.invalid/home", "https://PRIVATE_HOST.invalid/login",
        "https://www.office.com/home", "https://m365.cloud.microsoft/signinDev"]) {
        assert.deepEqual(accountOnlyRequestDecision({ ...base, url: new URL(value) }), { denied: "document-scope" });
    }
    for (const value of ["http://m365.cloud.microsoft/home", "https://PRIVATE_USER:PRIVATE_PASSWORD@m365.cloud.microsoft/home"]) {
        assert.deepEqual(accountOnlyRequestDecision({ ...base, url: new URL(value) }), { denied: "url-scope" });
    }
    for (const url of ["https://m365.cloud.microsoft/home", "https://login.microsoftonline.com/PRIVATE_PATH"]) {
        const facts = { ...base, type: "other", url: new URL(url) };
        assert.deepEqual(accountOnlyRequestDecision(facts), { denied: "document-scope" });
        assert.throws(() => assertNativeRequestAdmission(false, facts, "protocol", "document-scope"), error => {
            const value = nativeFailureDetails(error).admission.document;
            assert.equal(value.clause, "non-document-resource");
            assert.equal(value.originClass, url.includes("login.microsoftonline") ? "admitted-auth" : "admitted-app");
            return true;
        });
    }
});

test("startup origin projection strips userinfo and refuses sensitive hostname labels without public leakage", () => {
    const provenance = { binding: "unobserved", frame: "root", invocationState: "started", requestRelation: "unobserved",
        initiator: "unobserved", document: "unobserved", redirect: "unobserved" };
    const events = [], observed = createHistoryEngineering({ expectedAccount: "example@invalid.test", salt: Array(32).fill(7),
        onEvent: value => events.push(value) });
    const original = withHistoryEngineeringStartup(later(),
        "https://PRIVATE_USER:PRIVATE_PASSWORD@www.office.com/PRIVATE_PATH?secret=PRIVATE_QUERY#PRIVATE_FRAGMENT", provenance);
    observed.recordFailure(original);
    observed.recordFailure(later());
    assert.equal(observed.summary().firstFailure.startup.origin, "https://www.office.com");
    assert.doesNotMatch(JSON.stringify(events), /www\.office\.com|https?:|PRIVATE_/);
    assert.doesNotMatch(JSON.stringify(observed.summary()), /PRIVATE_|userinfo|headers|urlHash/);
    for (const value of [
        "https://orchard.msn.com", "https://orchard.microsoft.com", "https://www.office.com:8443", "https://ntp.msn.com",
        "https://example.msn.com", "https://tenant-name.msn.com", "https://12345678-abcd-1234-abcd-123456789abc.msn.com",
        "https://abcdef1234567890.msn.com", "https://abcdefghijklmnopqrstuvwxy.msn.com",
        "https://PRIVATE_HOST.onmicrosoft.com", "https://PRIVATE_HOST.sharepoint.com",
        "https://ntp.msn.com.PRIVATE_HOST.invalid", "https://127.0.0.1", "data:text/plain,PRIVATE_BODY",
    ]) {
        const rejected = control();
        rejected.recordFailure(withHistoryEngineeringStartup(later(), value, provenance));
        assert.equal(rejected.summary().firstFailure.startup.origin, null);
        assert.equal(rejected.summary().firstFailure.startup.originDisposition, "withheld-sensitive-or-unqualified");
        assert.doesNotMatch(JSON.stringify(rejected.summary()), /https?:|PRIVATE_|abcdef|tenant-name/);
    }
    assert.throws(() => withHistoryEngineeringStartup(later(), "https://www.office.com",
        { ...provenance, url: "PRIVATE_URL" }), { code: "NATIVE_ENGINEERING_OBSERVER_UNSAFE" });
});

for (const failure of ["write", "emitter"]) {
    test(`uncertain engineering custody survives final ${failure} failure`, { timeout: 10000 }, async t => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "wire-custody-publication-"));
        const outputFile = path.join(directory, "result.json");
        if (failure === "write") await writeFile(outputFile, "existing-result");
        const source = `
            const {finishHistoryInvestigation}=await import(${JSON.stringify(import.meta.resolve("../scripts/investigate-native-history.mjs"))});
            const {createHistoryEngineering}=await import(${JSON.stringify(import.meta.resolve("../lib/microsoft-history-engineering.mjs"))});
            const engineering=createHistoryEngineering({expectedAccount:"example@invalid.test",salt:Array(32).fill(7)});
            engineering.recordFailure("NATIVE_SOURCE_REQUEST_UNQUALIFIED");
            try { await finishHistoryInvestigation({engineering,operationId:"offline-only",authorizationReference:"offline-only",
                startedAt:new Date().toISOString(),cleanup:{disposition:"not-verified"},custodyRoot:null,
                outputFile:${JSON.stringify(outputFile)},emit(value){if(${JSON.stringify(failure)}==="emitter"&&value.type==="result")throw Error("PRIVATE_EMITTER");}
            }); } catch { process.send({publicationFailed:true});process.exitCode=1; }
            process.disconnect();
        `;
        const child = spawn(process.execPath, ["--input-type=module", "--eval", source],
            { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
        const exit = once(child, "exit"), stderr = [];
        child.stderr.on("data", value => stderr.push(value.toString()));
        const timeout = setTimeout(() => child.kill(), 8000);
        t.after(async () => {
            clearTimeout(timeout);
            if (child.exitCode === null && child.signalCode === null) child.kill();
            await exit;
            await rm(directory, { recursive: true, force: true });
        });
        assert.deepEqual((await once(child, "message"))[0], { publicationFailed: true });
        await delay(200);
        assert.equal(child.exitCode, null, "Uncertain custody must remain blocked after failed publication.");
        assert.equal(child.signalCode, null);
        assert.doesNotMatch(stderr.join(""), /PRIVATE_EMITTER|PRIVATE_/);
        if (failure === "write") assert.equal(await readFile(outputFile, "utf8"), "existing-result");
        else assert.equal(JSON.parse(await readFile(outputFile, "utf8")).cleanup.disposition, "not-verified");
    });
}
