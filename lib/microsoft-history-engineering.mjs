import { createHmac, randomUUID } from "node:crypto";
import { SESSION_REASONS, nativeFailureDetails } from "./microsoft-session-state.mjs";
import { nativePublicOriginLabels } from "./microsoft-native-bootstrap.mjs";

const instances = new WeakSet();
const startupEvidence = new WeakMap();
const steps = ["chat:initial", "chat:page", "chat:refresh", "cowork:initial", "cowork:page", "cowork:refresh"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const listRoles = new Set(["chat-list", "chat-initializer", "cowork-list"]);
export const isHistoryEngineering = value => instances.has(value);
export function withHistoryEngineeringStartup(error, input, provenance) {
    if (!(error instanceof Error) || startupEvidence.has(error)) return error;
    const fields = {
        binding: ["matched-original-request", "unobserved"],
        frame: ["root", "owned-descendant", "unobserved"],
        invocationState: ["started", "not-started"],
        requestRelation: ["preexisting-before-invocation", "preexisting-request-chain", "requested-destination-match", "different-destination", "unobserved"],
        initiator: ["parser", "script", "other", "preflight", "unobserved"],
        document: ["blank", "browser-internal", "known-app", "known-auth", "other", "unobserved"],
        redirect: ["from-requested-destination", "observed-other", "not-observed", "unobserved"],
    };
    if (!exact(provenance, Object.keys(fields)) || Object.entries(fields).some(([key, values]) => !values.includes(provenance[key]))) {
        fail("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
    }
    const url = input instanceof URL ? input : URL.parse(input);
    const origin = url && Object.hasOwn(nativePublicOriginLabels, url.origin) ? url.origin : null;
    startupEvidence.set(error, Object.freeze({ origin,
        originDisposition: origin ? "recorded" : "withheld-sensitive-or-unqualified",
        provenance: Object.freeze({ ...provenance }) }));
    return error;
}

export function inheritHistoryEngineeringStartup(original, replacement) {
    if (startupEvidence.has(original) && !startupEvidence.has(replacement)) startupEvidence.set(replacement, startupEvidence.get(original));
    return replacement;
}

export function historyEngineeringVisibleSummary(summary) {
    const result = structuredClone(summary);
    if (result.firstFailure?.startup) delete result.firstFailure.startup.origin;
    if (Array.isArray(result.steps)) result.steps = result.steps.map(step => {
        const { members, tail, times, cursor, ...visible } = step;
        return { ...visible, ...(cursor ? { cursor: { state: cursor.state } } : {}),
            ...(times ? { unqualifiedTimes: times.unqualified } : {}) };
    });
    if (Array.isArray(result.contexts)) for (const context of result.contexts) {
        for (const history of context.structure.histories) delete history.cursor.key;
    }
    return result;
}
export function validateHistoryContextStructure(value) {
    const collection = value => exact(value, ["availability", "count"])
        && ["absent", "recorded", "unsupported"].includes(value.availability)
        && (value.availability === "recorded" ? Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= 500 : value.count === null);
    if (!exact(value, ["purpose", "histories", "pinnedChatIds", "pinnedChats", "landingStoreFlag"])
        || !["sections", "common-context"].includes(value.purpose)
        || !collection(value.pinnedChatIds) || !collection(value.pinnedChats)
        || !["absent", "true", "false", "unsupported"].includes(value.landingStoreFlag)
        || !Array.isArray(value.histories) || value.histories.length !== 2) fail("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
    for (const [index, history] of value.histories.entries()) {
        if (!exact(history, ["store", "availability", "count", "cursor"])
            || history.store !== ["conversationPageHistoryList", "chatLandingPageHistoryList"][index]
            || !collection({ availability: history.availability, count: history.count })
            || !exact(history.cursor, ["state", "key"])
            || !["absent", "null", "empty", "present"].includes(history.cursor.state)
            || history.availability === "absent" && history.cursor.state !== "absent"
            || (history.cursor.state === "present" ? !hash(history.cursor.key) : history.cursor.key !== null)) {
            fail("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
        }
    }
    return value;
}
export const historyEngineeringAssets = Object.freeze([
    "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/coworker.4e935246.js",
    "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/__federation_expose_Coworker.0931499f.js",
    "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/63754.5cc614bd.js",
    "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/1979.ca29e321.js",
    "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/33954.f0e5741d.js",
    "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/91902.0ae5ea97.js",
    "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/12735.644e934a.js",
]);

export function createHistoryEngineering({ expectedAccount, salt, now = Date.now, onEvent = () => {} }) {
    if (typeof expectedAccount !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedAccount)
        || !Array.isArray(salt) || salt.length !== 32 || salt.some(value => !Number.isInteger(value) || value < 0 || value > 255)
        || typeof now !== "function" || typeof onEvent !== "function") fail("NATIVE_ENGINEERING_BINDING");
    let owner, connection, active, index = -1, finished = false, firstFailure = null, authenticated = false, attentionPublished = false;
    let requestCount = 0, bytes = 0;
    let browserOwners = [];
    const requests = new Map(), results = [], contexts = [], lists = new Map(), counts = new Map(), documents = new Set(), navigations = new Map();
    const semantics = new Map();
    const urlKey = value => createHmac("sha256", Buffer.from(salt)).update("url:" + value).digest("hex");
    const emit = event => onEvent(Object.freeze(structuredClone(event)));
    const connectionFacts = () => connection ? {
        ownerId: connection.ownerId, startedAt: new Date(connection.startedAt).toISOString(),
        authenticationDeadline: new Date(connection.authDeadline).toISOString(),
        readDeadline: new Date(connection.deadline).toISOString(), shutdownAt: new Date(connection.shutdownAt).toISOString(),
    } : null;
    const assertCurrent = () => {
        if (!owner || finished || owner.signal.aborted || now() >= owner.deadline || owner.check() !== true || firstFailure) {
            fail(firstFailure?.code ?? "NATIVE_ENGINEERING_AUTHORITY_LOST");
        }
    };
    const attention = () => {
        assertCurrent();
        const value = owner.authentication;
        if (!value || active || now() >= value.deadline) fail("NATIVE_ENGINEERING_ATTENTION_RETIRED");
        return { ownerId: value.ownerId, generation: value.generation, issuedAt: new Date(now()).toISOString(),
            deadline: new Date(value.deadline).toISOString() };
    };
    const recordFailure = error => {
        if (!firstFailure) {
            const started = Boolean(connection || owner);
            const detail = error instanceof Error ? nativeFailureDetails(error, "connect") : null;
            const code = detail?.code ?? (error instanceof Error ? error.code : error);
            firstFailure = { code: typeof code === "string" && (/^NATIVE_[A-Z_]{1,90}$/.test(code) || SESSION_REASONS.includes(code))
                ? code : "NATIVE_ENGINEERING_FAILED",
                step: active?.key ?? (started ? "authentication" : "preparation"),
                ...(detail ? { predicate: detail.predicate, ...(detail.admission ? { admission: detail.admission } : {}),
                    ...(detail.protocolStop ? { protocolStop: detail.protocolStop } : {}) } : {}),
                ...(startupEvidence.has(error) ? { startup: startupEvidence.get(error) } : {}) };
            emit({ type: "failure", ...historyEngineeringVisibleSummary({ firstFailure }).firstFailure });
        }
    };
    const validateList = value => {
        if (!exact(value, ["surface", "members", "count", "tail", "times", "cursor"])
            || !["chat", "cowork"].includes(value.surface) || !Array.isArray(value.members) || value.members.length > 500
            || value.members.some(member => !hash(member)) || new Set(value.members).size !== value.members.length
            || value.count !== value.members.length || value.tail !== (value.members.at(-1) ?? null)
            || !exact(value.times, ["minimum", "maximum", "unqualified"])
            || !Number.isSafeInteger(value.times.unqualified) || value.times.unqualified < 0 || value.times.unqualified > value.count
            || ["minimum", "maximum"].some(key => value.times[key] !== null && (!Number.isSafeInteger(value.times[key]) || value.times[key] < 0))
            || (value.count === value.times.unqualified ? value.times.minimum !== null || value.times.maximum !== null
                : value.times.minimum === null || value.times.maximum === null || value.times.minimum > value.times.maximum)
            || !exact(value.cursor, ["state", "key"]) || !["absent", "null", "empty", "present"].includes(value.cursor.state)
            || (value.cursor.state === "present" ? !hash(value.cursor.key) : value.cursor.key !== null)) fail("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
    };
    const validateRequest = value => {
        const role = value?.role;
        if (role === "routing") {
            if (!exact(value, ["role"])) fail("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
            return;
        }
        const extra = role === "chat-list" ? ["store"] : role === "cowork-list" ? ["pageSize", "includeCached"] : [];
        if (!["principal", "context", "chat-list", "chat-initializer", "cowork-list"].includes(role)
            || !exact(value, ["role", "cursor", "basis", "filter", ...extra])
            || !["initializer", "context", "reset", "continuation", "cached-or-unrecognized", "first-page"].includes(value.basis)
            || !["none", "interactive", "unobserved"].includes(value.filter)
            || !exact(value.cursor, ["state", "key"]) || !["absent", "null", "empty", "present"].includes(value.cursor.state)
            || (value.cursor.state === "present" ? !hash(value.cursor.key) : value.cursor.key !== null)
            || role === "chat-list" && !["conversationPageHistoryList", "chatLandingPageHistoryList"].includes(value.store)
            || role === "cowork-list" && (typeof value.includeCached !== "boolean"
                || value.pageSize !== null && (!Number.isSafeInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 200))) {
            fail("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
        }
    };
    const pinSemantics = (surface, value) => {
        const existing = semantics.get(surface);
        if (existing && (existing.filter !== value.filter || existing.store !== value.store)) fail("NATIVE_ENGINEERING_SEMANTIC_SCOPE");
        if (!existing) semantics.set(surface, Object.freeze(value));
    };
    const recordList = (projection, basis, filter, source, byteLength) => {
        if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > 2 * 1024 * 1024) fail("NATIVE_ENGINEERING_BYTE_LIMIT");
        bytes += byteLength;
        if (bytes > 16 * 1024 * 1024) fail("NATIVE_ENGINEERING_BYTE_LIMIT");
        validateList(projection.list);
        if (projection.list.surface !== active.surface || !["all-chats", "none"].includes(projection.marker)) fail("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
        const result = { step: active.key, outcome: "observed", source, basis, filter,
            marker: projection.marker, ...structuredClone(projection.list) };
        lists.set(active.surface, structuredClone(projection.list));
        results.push(result); active.settled = true;
        emit({ type: "step", step: active.key, outcome: "observed", count: result.count, cursor: result.cursor.state });
    };
    const api = Object.freeze({
        expectedAccount,
        salt: Object.freeze([...salt]),
        urlKey,
        beginConnection(value) {
            if (connection || owner || finished) fail("NATIVE_ENGINEERING_ALREADY_STARTED");
            if (firstFailure) fail(firstFailure.code);
            if (!value || typeof value.ownerId !== "string" || !/^[a-f0-9-]{36}$/i.test(value.ownerId)
                || !(value.signal instanceof AbortSignal) || value.signal.aborted) fail("NATIVE_ENGINEERING_AUTHORITY_LOST");
            const startedAt = now();
            if (!Number.isSafeInteger(startedAt)) fail("NATIVE_ENGINEERING_BINDING");
            const bounds = Object.freeze({ ownerId: value.ownerId, startedAt,
                authDeadline: startedAt + 90000, deadline: startedAt + 300000, shutdownAt: startedAt + 280000 });
            connection = { ...bounds, signal: value.signal };
            emit({ type: "connect-started", ...connectionFacts() });
            return bounds;
        },
        get connectionStarted() { return Boolean(connection || owner); },
        bind(value) {
            if (owner || !value || !value.signal || typeof value.check !== "function" || !Number.isSafeInteger(value.deadline)
                || value.deadline <= now() || value.deadline - now() > 300000) fail("NATIVE_ENGINEERING_BINDING");
            const authentication = value.authentication;
            if (connection && (value.ownerId !== connection.ownerId || value.signal !== connection.signal
                || value.deadline !== connection.shutdownAt
                || authentication && (authentication.ownerId !== connection.ownerId
                    || authentication.deadline !== connection.authDeadline))) fail("NATIVE_ENGINEERING_BINDING");
            if (authentication !== undefined && (!exact(authentication, ["ownerId", "generation", "deadline"])
                || !/^[a-f0-9-]{36}$/i.test(authentication.ownerId)
                || !Number.isSafeInteger(authentication.generation) || authentication.generation < 0
                || !Number.isSafeInteger(authentication.deadline) || authentication.deadline <= now()
                || authentication.deadline > value.deadline)) fail("NATIVE_ENGINEERING_BINDING");
            owner = { ...value, ...(authentication ? { authentication: Object.freeze({ ...authentication }) } : {}) };
        },
        authenticate() {
            assertCurrent();
            if (authenticated) fail("NATIVE_ENGINEERING_ACCOUNT_SCOPE");
            authenticated = true;
        },
        get authenticated() { return authenticated; },
        assertCurrent,
        recordFailure,
        windowReady() {
            const reference = attention();
            emit({ type: "window-ready", ...reference, display: "headful", presentation: "normal-in-work-area",
                userVisibility: "unconfirmed" });
            attentionPublished = true;
        },
        humanNeeded(interaction) {
            const reference = attention();
            emit({ type: "human-needed", ...reference, interaction: ["sign-in", "select-work-account", "mfa", "password", "review-sign-in"].includes(interaction)
                ? interaction : "native-sign-in" });
            attentionPublished = true;
        },
        get activeStep() { return active?.key ?? null; },
        get complete() { return finished; },
        registerBrowserOwners(values) {
            if (browserOwners.length || !Array.isArray(values) || !values.length
                || values.some(value => !Number.isSafeInteger(value) || value < 1)) fail("NATIVE_ENGINEERING_CUSTODY");
            browserOwners = [...new Set(values)];
        },
        get browserOwnerIds() { return [...browserOwners]; },
        get hasActiveRequest() { return (active?.admitted ?? 0) > 0; },
        get hasFailure() { return firstFailure !== null; },
        admitNavigation(networkId) {
            assertCurrent();
            if (!active || active.step === "page" || active.settled || typeof networkId !== "string" || !networkId.length
                || navigations.has(active.key) && navigations.get(active.key) !== networkId) fail("NATIVE_ENGINEERING_ENTRY_REQUIRED");
            navigations.set(active.key, networkId);
        },
        begin(surface, step) {
            assertCurrent();
            const key = surface + ":" + step;
            if (!authenticated || steps[index + 1] !== key || active && !active.settled) fail("NATIVE_ENGINEERING_STEP_INVALID");
            index++;
            active = { key, surface, step, settled: false, admitted: 0, nonce: randomUUID() };
            if (index === 0 && attentionPublished) emit({ type: "attention-ended", ownerId: owner.authentication.ownerId,
                generation: owner.authentication.generation, reason: "history-started" });
            if (step === "page" && lists.get(surface)?.cursor.state !== "present") {
                active.settled = true;
                results.push({ step: key, outcome: "unavailable", reason: "no-next-page" });
                emit({ type: "step", step: key, outcome: "unavailable" });
            } else emit({ type: "step", step: key, outcome: "pending" });
            return !active.settled;
        },
        unavailable(reason) {
            assertCurrent();
            if (!active || active.step !== "page" || active.admitted || active.settled || reason !== "native-control-unavailable") {
                fail("NATIVE_ENGINEERING_STEP_INVALID");
            }
            active.settled = true;
            results.push({ step: active.key, outcome: "unavailable", reason });
        },
        prepareRequest({ requestId, method, requestUrlKey, projection }) {
            assertCurrent();
            if (!/^[a-f0-9-]{36}$/i.test(requestId) || !hash(requestUrlKey) || !["GET", "POST"].includes(method)
                || !object(projection) || requests.has(requestId) || requestCount >= 18) fail("NATIVE_ENGINEERING_REQUEST_SCOPE");
            const role = projection.role;
            validateRequest(projection);
            if (role === "context" && projection.basis === "context" && !authenticated) fail("NATIVE_ENGINEERING_IDENTITY_UNCONFIRMED");
            if (role === "context"
                ? !["context", "initializer"].includes(projection.basis)
                    || method !== (projection.basis === "context" ? "POST" : "GET")
                : role === "chat-list" ? method !== "POST" : method !== "GET") fail("NATIVE_ENGINEERING_REQUEST_SCOPE");
            if (listRoles.has(role)) {
                if (authenticated && active?.settled && active.step === "initial"
                    && projection.cursor?.state === "present" && projection.cursor.key === lists.get(active.surface)?.cursor.key) {
                    api.begin(active.surface, "page");
                }
                if (!authenticated || !active || active.settled || active.admitted
                    || (role.startsWith("chat") ? "chat" : "cowork") !== active.surface) fail("NATIVE_ENGINEERING_STEP_SCOPE");
                if (active.step === "page") {
                    const previous = lists.get(active.surface);
                    if (projection.cursor?.state !== "present" || projection.cursor.key !== previous?.cursor.key
                        || projection.basis !== "continuation") fail("NATIVE_ENGINEERING_CURSOR_SCOPE");
                    if (role === "cowork-list" && projection.includeCached) fail("NATIVE_ENGINEERING_REQUEST_SCOPE");
                } else if (active.surface === "chat" ? role !== "chat-initializer" && projection.basis !== "reset"
                    : projection.basis !== "first-page" || projection.cursor?.state !== "absent") {
                    fail("NATIVE_ENGINEERING_INITIALIZER_REQUIRED");
                }
                if (role === "cowork-list" && !["none", "interactive"].includes(projection.filter)) fail("NATIVE_ENGINEERING_SEMANTIC_SCOPE");
                pinSemantics(active.surface, { store: active.surface === "chat" ? projection.store ?? "conversationPageHistoryList" : "my-tasks",
                    filter: role === "chat-initializer" ? "none" : projection.filter });
                active.admitted++;
            } else {
                const count = (counts.get(role) ?? 0) + 1;
                if (count > ({ principal: 2, context: 8, routing: 2 })[role]) fail("NATIVE_ENGINEERING_REQUEST_LIMIT");
                counts.set(role, count);
            }
            requestCount++;
            const record = { requestId, method, requestUrlKey, projection: structuredClone(projection),
                step: active?.key ?? "authentication", consumed: false, accepted: false };
            requests.set(requestId, record);
            return true;
        },
        requestFor(url, method) {
            assertCurrent();
            const key = urlKey(url), matches = [...requests.values()].filter(row => !row.accepted && row.method === method && row.requestUrlKey === key);
            if (matches.length !== 1) fail("NATIVE_ENGINEERING_PROJECTION_REQUIRED");
            return matches[0];
        },
        requestById(requestId) { assertCurrent(); return requests.get(requestId); },
        matchRequest(url, method, networkId = null) {
            const record = api.requestFor(url, method);
            if (record.consumed && record.networkId !== networkId) fail("NATIVE_ENGINEERING_DUPLICATE_REQUEST");
            record.consumed = true;
            record.networkId = networkId;
            return record;
        },
        accept(requestId, projection, byteLength) {
            assertCurrent();
            const record = requests.get(requestId);
            if (!record?.consumed || record.accepted || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > 2 * 1024 * 1024
                || !object(projection) || projection.role !== record.projection.role) fail("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
            record.accepted = true;
            if (!listRoles.has(projection.role)) {
                bytes += byteLength;
                if (bytes > 16 * 1024 * 1024) fail("NATIVE_ENGINEERING_BYTE_LIMIT");
                if (projection.role === "context") {
                    const structure = validateHistoryContextStructure(projection.structure);
                    if (structure.purpose !== (record.projection.basis === "context" ? "sections" : "common-context")) {
                        fail("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
                    }
                    contexts.push({ step: record.step, structure: structuredClone(structure) });
                }
                return;
            }
            if (!active || active.key !== record.step || active.settled) fail("NATIVE_ENGINEERING_STEP_SCOPE");
            recordList(projection, record.projection.basis, record.projection.filter, projection.role, byteLength);
        },
        acceptDocument(documentKey, projection, byteLength) {
            assertCurrent();
            if (!hash(documentKey) || documents.has(documentKey)) fail("NATIVE_ENGINEERING_DOCUMENT_SHAPE");
            if (!exact(projection, ["role", "principal", "list", "marker"]) || projection.role !== "document"
                || (projection.list === null ? projection.marker !== "none" : projection.marker !== "all-chats")) {
                fail("NATIVE_ENGINEERING_DOCUMENT_SHAPE");
            }
            if (requestCount >= 18) fail("NATIVE_ENGINEERING_REQUEST_LIMIT");
            if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > 2 * 1024 * 1024
                || bytes + byteLength > 16 * 1024 * 1024) fail("NATIVE_ENGINEERING_BYTE_LIMIT");
            if (projection.list) {
                if (!authenticated || active?.surface !== "chat" || active.step === "page" || active.admitted || active.settled) {
                    fail("NATIVE_ENGINEERING_INITIALIZER_REQUIRED");
                }
                validateList(projection.list);
                if (projection.list.surface !== "chat") fail("NATIVE_ENGINEERING_DOCUMENT_SHAPE");
                pinSemantics("chat", { store: "conversationPageHistoryList", filter: "none" });
            }
            documents.add(documentKey);
            requestCount++;
            bytes += byteLength;
            if (projection.list) {
                active.admitted++;
                recordList(projection, "initializer", "none", "chat-document", 0);
            }
        },
        currentList() { return active ? structuredClone(lists.get(active.surface) ?? null) : null; },
        settled() { return active?.settled === true; },
        finish() {
            assertCurrent();
            if (index !== steps.length - 1 || !active?.settled) fail("NATIVE_ENGINEERING_INCOMPLETE");
            finished = true;
        },
        summary() {
            const operationStarted = Boolean(connection || owner);
            return { schemaVersion: 1, outcome: firstFailure ? operationStarted ? "stopped" : "not-started" : finished ? "observed" : "incomplete",
                operationStarted, operation: connectionFacts(),
                firstFailure: firstFailure ? { ...firstFailure } : null, requests: requestCount, bytes,
                steps: structuredClone(results), contexts: structuredClone(contexts), positiveCoverage: false };
        },
    });
    instances.add(api);
    return api;
}

export async function runHistoryEngineeringSteps(control, driver) {
    if (!isHistoryEngineering(control) || ["initial", "page", "refresh", "wait"].some(name => typeof driver?.[name] !== "function")) {
        fail("NATIVE_ENGINEERING_BINDING");
    }
    for (const surface of ["chat", "cowork"]) for (const step of ["initial", "page", "refresh"]) {
        control.assertCurrent();
        const key = surface + ":" + step;
        if (control.activeStep !== key) control.begin(surface, step);
        if (control.settled()) continue;
        if (!control.hasActiveRequest) {
            if (step === "page") {
                if (!await driver.page(surface, control.currentList()?.tail)) {
                    control.unavailable("native-control-unavailable");
                    continue;
                }
            } else await driver[step](surface);
        }
        control.assertCurrent();
        await driver.wait(() => control.settled(), surface, step);
        control.assertCurrent();
    }
    control.finish();
    return control.summary();
}
