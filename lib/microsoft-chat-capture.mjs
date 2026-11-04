import { normalizeNativeMessageTime, normalizeNativeObservationTime, NativeReadModelError,
    nativeValueHasCredentials } from "./native-read-model.mjs";
import { withNativeFailurePredicate } from "./microsoft-session-state.mjs";

// Installed only in the owned browser before the selected native navigation.
// Observe a bounded clone; return the original response unchanged to its caller.
export function installNativeChatCapture({ origin, path, binding, maximumBytes = 12 * 1024 * 1024, timeoutMs = 45000,
    nativeHistory = null }, makeProjection, projectCowork, readBootstrap, projectHistory) {
    if (nativeHistory && !["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(location.origin)) return;
    const originalFetch = window.fetch;
    const historyDocument = ["/chat/all", "/hwav2/chat/all"].includes(location.pathname);
    let retireBootstrap = () => {};
    if (nativeHistory && window.top === window
        && ["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(location.origin)
        && (historyDocument || ["/", "/home", "/chat", "/hwav2/chat", "/landingv2",
            "/cowork", "/cowork/", "/hwav2/cowork", "/hwav2/cowork/"].includes(location.pathname))) {
        const documentToken = crypto.randomUUID(), documentUrl = location.href;
        let retired = false;
        const deliver = value => {
            void Promise.resolve().then(() => !retired && window[binding]({
                kind: historyDocument ? "chat-history-document" : "principal-document", documentToken, documentUrl, ...value,
            }))
                .catch(() => console.error("WIRE_NATIVE_BOOTSTRAP_OBSERVATION_FAILED"));
        };
        deliver({ state: "started" });
        const own = (value, key) => {
            if (!value || typeof value !== "object") return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor) return undefined;
            if (!Object.hasOwn(descriptor, "value")) throw new Error("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
            return descriptor.value;
        };
        let captured = false, readinessTimer = null, waitingBackground = false;
        const readinessDeadline = Date.now() + Math.min(timeoutMs, 15000);
        const stopWaiting = () => {
            if (readinessTimer !== null) clearTimeout(readinessTimer);
            readinessTimer = null;
        };
        const refuse = () => {
            if (retired || captured) return;
            captured = true;
            stopWaiting();
            deliver({ state: "unqualified", code: "NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED" });
        };
        const capture = () => {
            if (retired || captured) return;
            try {
                if (waitingBackground && (own(window, "__backgroundSSR") !== true || Date.now() >= readinessDeadline)) {
                    refuse(); return;
                }
                const value = readBootstrap(true, historyDocument ? projectHistory : null);
                const missing = ["bootstrap-unavailable", "bootstrap-uninitialized", "bootstrap-loader-unavailable"].includes(value.state)
                    || value.branch === "background-loader" && value.state === "account-unavailable";
                if (missing) {
                    if (value.branch === "background-loader") {
                        waitingBackground = true;
                        if (Date.now() >= readinessDeadline) { refuse(); return; }
                        if (readinessTimer === null) readinessTimer = setTimeout(() => {
                            readinessTimer = null;
                            capture();
                        }, Math.min(100, readinessDeadline - Date.now()));
                    }
                    return;
                }
                captured = true;
                stopWaiting();
                deliver(value.state === "available" ? { state: "complete", projected: value.projected, bootstrapBranch: value.branch }
                    : { state: "unavailable", bootstrapBranch: value.branch });
            } catch { refuse(); }
        };
        const observeTransport = transport => {
            if (!transport || typeof transport !== "object" || Array.isArray(transport)) return;
            try {
                const descriptor = Object.getOwnPropertyDescriptor(transport, "initialized");
                if (descriptor && (!Object.hasOwn(descriptor, "value")
                    || descriptor.configurable === false || descriptor.writable === false)) {
                    refuse();
                    return;
                }
                let initialized = descriptor?.value;
                if (initialized === true) { capture(); return; }
                Object.defineProperty(transport, "initialized", {
                    configurable: true, enumerable: descriptor?.enumerable ?? true,
                    get: () => initialized,
                    set(value) {
                        initialized = value;
                        if (value !== true) return;
                        Object.defineProperty(transport, "initialized", { configurable: true,
                            enumerable: descriptor?.enumerable ?? true, writable: descriptor?.writable ?? true, value });
                        capture();
                    },
                });
            } catch { refuse(); }
        };
        let backgroundReady;
        retireBootstrap = () => {
            retired = true;
            stopWaiting();
            window.removeEventListener?.("pagehide", retireBootstrap);
            if (typeof document !== "undefined") document.removeEventListener?.("DOMContentLoaded", backgroundReady);
        };
        window.addEventListener?.("pagehide", retireBootstrap, { once: true });
        try {
            if (own(window, "__backgroundSSR") === true) capture();
            else {
                const descriptor = Object.getOwnPropertyDescriptor(window, "$_TSR");
                if (descriptor) {
                    if (Object.hasOwn(descriptor, "value")) observeTransport(descriptor.value);
                    else throw new Error("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
                } else Object.defineProperty(window, "$_TSR", {
                    configurable: true, enumerable: true, get: () => undefined,
                    set(value) {
                        Object.defineProperty(window, "$_TSR", { configurable: true, enumerable: true, writable: true, value });
                        try {
                            if (own(window, "__backgroundSSR") !== true) observeTransport(value);
                        } catch { refuse(); }
                    },
                });
            }
            backgroundReady = () => {
                if (retired || captured) return;
                try {
                    const selected = own(window, "__backgroundSSR");
                    if (selected !== undefined && typeof selected !== "boolean") throw new Error("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
                    if (selected === true) capture();
                } catch { refuse(); }
            };
            if (!Object.getOwnPropertyDescriptor(window, "__m365TanstackClientBooted")) {
                Object.defineProperty(window, "__m365TanstackClientBooted", {
                    configurable: true, enumerable: true, get: () => undefined,
                    set(value) {
                        Object.defineProperty(window, "__m365TanstackClientBooted", {
                            configurable: true, enumerable: true, writable: true, value,
                        });
                        if (value === true) backgroundReady();
                    },
                });
            }
            if (typeof document !== "undefined") {
                if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", backgroundReady, { once: true });
                else backgroundReady();
            }
        } catch { refuse(); }
    }
    let consumed = false;
    const nativeCounts = new Map();
    let nativeEpoch = 0, activeCaptures = 0;
    if (nativeHistory?.resetBinding) Object.defineProperty(window, nativeHistory.resetBinding, {
        value(retireOnly = false) {
            if (retireOnly === true) { retireBootstrap(); return true; }
            if (activeCaptures) return false;
            retireBootstrap();
            nativeCounts.clear(); nativeEpoch++; return true;
        }, configurable: false, writable: false,
    });
    window.fetch = async function (...args) {
        const captureEpoch = nativeEpoch;
        const response = await Reflect.apply(originalFetch, this, args);
        let nativeKind = null;
        const report = error => Promise.resolve().then(() => window[binding]({
            state: "failed", ...(nativeKind ? { kind: nativeKind } : {}),
            code: /^NATIVE_CHAT_[A-Z_]+$/.test(error?.message)
                ? error.message : "NATIVE_CHAT_STREAM_DECODE_FAILED",
        })).catch(() => console.error("WIRE_NATIVE_CHAT_OBSERVATION_DELIVERY_FAILED"));
        try {
            const input = args[0], init = args[1];
            const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, location.href);
            const method = String(init?.method || input?.method || "GET").toUpperCase();
            if (nativeHistory) {
                const app = ["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(url.origin);
                const pathname = url.pathname.replace(/^\/hwav2(?=\/)/, "");
                if (app && pathname === "/_serverFn/" + nativeHistory.bootstrapRpcId && method === "GET") nativeKind = "principal";
                else if (app && pathname === "/_serverFn/" + nativeHistory.chatInitializerRpcId && method === "GET") nativeKind = "chat-list";
                else if (app && pathname === "/_serverFn/" + nativeHistory.chatRpcId && method === "POST") {
                    const body = init?.body;
                    if (typeof makeProjection === "function" && typeof body === "string" && body.length <= 2 * 1024 * 1024
                        && new TextEncoder().encode(body).length <= 2 * 1024 * 1024) {
                        const wire = JSON.parse(body), view = makeProjection(wire.t, true, "NATIVE_CHAT_REQUEST_UNQUALIFIED");
                        if (view.scalar(view.field(view.field(wire.t, "data"), "action")) === "GetSections") return response;
                    }
                    nativeKind = "chat-list";
                }
                else if (app && /^\/chat\/conversation\/[^/]+$/.test(pathname) && method === "GET") nativeKind = "chat";
                else if (/^[a-z0-9][a-z0-9.-]*\.gateway\.prod\.island\.powerapps\.com$/.test(url.hostname) && method === "GET") {
                    nativeKind = ({ "/v1/routing": "routing", "/v1/tasks/live": "cowork-list",
                        "/v1/tasks/live/detail": "cowork-detail", "/v1/tasks/live/messages": "cowork-messages" })[pathname] ?? null;
                    if (nativeHistory.coworkMembership) {
                        if (pathname === "/v1/automations") nativeKind = "cowork-automations";
                        else if (/^\/v1\/conversations\/[^/]+\/scheduled-prompt$/.test(pathname)) nativeKind = "cowork-schedule";
                        else if (/^\/v1\/event-triggers\/[^/]+$/.test(pathname)) nativeKind = "cowork-trigger";
                    }
                }
                if (!nativeKind) return response;
                if (captureEpoch !== nativeEpoch) throw new Error("NATIVE_CHAT_CAPTURE_ALREADY_CONSUMED");
                const count = (nativeCounts.get(nativeKind) ?? 0) + 1;
                if (count > (["chat-list", "cowork-list", "cowork-messages", "cowork-automations", "cowork-schedule", "cowork-trigger"].includes(nativeKind) ? 16 : 1)) {
                    throw new Error("NATIVE_CHAT_CAPTURE_ALREADY_CONSUMED");
                }
                nativeCounts.set(nativeKind, count);
            } else {
                if (url.origin !== origin || url.pathname !== path) return response;
                if (method !== "GET" || consumed) throw new Error("NATIVE_CHAT_CAPTURE_ALREADY_CONSUMED");
                consumed = true;
            }
            const membership = ["cowork-automations", "cowork-schedule", "cowork-trigger"].includes(nativeKind);
            const bound = nativeKind === "principal" ? 1024 * 1024
                : membership || ["chat-list", "cowork-list", "routing"].includes(nativeKind) ? 2 * 1024 * 1024 : maximumBytes;
            const readTimeout = ["principal", "chat-list", "cowork-list", "routing"].includes(nativeKind)
                ? Math.min(timeoutMs, 15000) : timeoutMs;
            const unavailable = (nativeKind === "cowork-schedule" && response.status === 404
                || nativeKind === "cowork-trigger" && [403, 404].includes(response.status))
                && !response.redirected && response.url === url.href;
            if (nativeKind && method === "GET" && response.status === 503 && !response.redirected && response.url === url.href) {
                void Promise.resolve().then(() => window[binding]({ state: "read-failed", kind: nativeKind,
                    status: response.status, requestUrl: url.href, method })).catch(() => {
                    console.error("WIRE_NATIVE_CHAT_OBSERVATION_DELIVERY_FAILED");
                });
                return response;
            }
            const clone = response.clone();
            async function collect() {
                let reader, timer, bytes = 0, chunks = [];
                try {
                    const mime = response.headers.get("content-type") ?? "";
                    if (!unavailable && response.status !== 200 || response.redirected || response.url !== url.href
                        || ["principal", "chat-list"].includes(nativeKind) && response.headers.get("x-tss-raw") === "true"
                        || !unavailable && (nativeKind && nativeKind !== "chat"
                            ? !/^application\/(?:json|x-tss-framed)(?:;|$)/i.test(mime)
                            : !/\bapplication\/(?:x-)?ndjson\b/i.test(mime))) {
                        throw new Error("NATIVE_CHAT_RESPONSE_UNQUALIFIED");
                    }

                    reader = clone.body.getReader();
                    let timedOut = false, timeoutCancellationFailed = false;
                    timer = setTimeout(() => {
                        timedOut = true;
                        void reader.cancel().catch(() => { timeoutCancellationFailed = true; });
                    }, readTimeout);
                    for (;;) {
                        const part = await reader.read();
                        if (timedOut) throw new Error("NATIVE_CHAT_STREAM_DEADLINE");
                        if (part.done) break;
                        bytes += part.value.byteLength;
                        if (bytes > bound) throw new Error("NATIVE_CHAT_STREAM_BYTE_LIMIT");
                        if (!unavailable) chunks.push(part.value);
                    }
                    if (unavailable) {
                        if (captureEpoch !== nativeEpoch || timeoutCancellationFailed) throw new Error("NATIVE_CHAT_CAPTURE_ALREADY_CONSUMED");
                        await window[binding]({ state: "unavailable", kind: nativeKind, status: response.status,
                            requestUrl: url.href, method, bytes });
                        return;
                    }
                    const data = new Uint8Array(bytes);
                    let offset = 0;
                    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
                    chunks = [];
                    if (timeoutCancellationFailed) throw new Error("NATIVE_CHAT_READER_CANCEL_FAILED");
                    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
                        value => value.toString(16).padStart(2, "0")).join("");
                    if (captureEpoch !== nativeEpoch) throw new Error("NATIVE_CHAT_CAPTURE_ALREADY_CONSUMED");
                    if (membership) {
                        if (typeof projectCowork !== "function" || !/^application\/json(?:;|$)/i.test(mime)) {
                            throw new Error("NATIVE_CHAT_RESPONSE_UNQUALIFIED");
                        }
                        const projected = projectCowork(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)), nativeKind);
                        await window[binding]({ state: "complete", kind: nativeKind, requestUrl: url.href, method,
                            bytes, bodyDigest: digest, status: response.status, mime, projected });
                        return;
                    }
                    if (nativeKind && nativeKind !== "chat") {
                        let binary = "";
                        for (let offset = 0; offset < data.length; offset += 32768) {
                            binary += String.fromCharCode(...data.subarray(offset, offset + 32768));
                        }
                        await window[binding]({ state: "complete", kind: nativeKind, requestUrl: url.href, method,
                            bytes, bodyDigest: digest, status: response.status, mime,
                            serialized: Boolean(response.headers.get("x-tss-serialized")), encodedBody: btoa(binary) });
                        return;
                    }
                    const frames = [];
                    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
                    for (const line of text.split(/\r?\n/)) {
                        if (!line.trim()) continue;
                        const value = JSON.parse(line);
                        frames.push(...(Array.isArray(value) ? value : [value]));
                        if (frames.length > 256) throw new Error("NATIVE_CHAT_FRAME_LIMIT");
                    }
                    await window[binding]({ state: "complete", bytes, bodyDigest: digest, status: response.status,
                        mime: response.headers.get("content-type"), frames });
                } catch (error) {
                    await report(error);
                } finally {
                    clearTimeout(timer); chunks = [];
                    if (reader) {
                        try { await reader.cancel(); }
                        catch { await window[binding]({ state: "cleanup-failed", code: "NATIVE_CHAT_READER_CANCEL_FAILED" }); }
                    }
                }
            }
            activeCaptures++;
            void collect().catch(() => {
                // A failed local binding must remain observable without any body text.
                console.error("WIRE_NATIVE_CHAT_OBSERVATION_DELIVERY_FAILED");
            }).finally(() => { activeCaptures--; });
        } catch (error) {
            void report(error);
        }
        return response;
    };
}

const sourceObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const historyStores = new Set(["conversationPageHistoryList", "chatLandingPageHistoryList"]);
const projectionLimit = 2 * 1024 * 1024;
function projectionFailure(code) {
    throw Object.assign(new Error(code), { code });
}
function sourceJson(input, code, reject = () => projectionFailure(code)) {
    if (typeof input !== "string") reject("body-type");
    if (Buffer.byteLength(input) > projectionLimit) reject("body-budget");
    try { return JSON.parse(input); }
    catch { reject("json"); }
}

// Select reviewed paths only; never deserialize cached state or executable tags.
export function sourceProjection(root, encoded, code, maximumStringLength = 2 * 1024 * 1024) {
    const sourceObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const definitions = new Map();
    let visited = 0;
    const fail = () => { throw Object.assign(new Error(code), { code }); };
    function resolve(node) {
        if (++visited > 50000) fail();
        if (!encoded) return node;
        const seen = new Set();
        while (sourceObject(node) && node.t === 4) {
            if (!Number.isSafeInteger(node.i) || seen.has(node.i) || !definitions.has(node.i)) fail();
            seen.add(node.i);
            node = definitions.get(node.i);
        }
        if (!sourceObject(node) || !Number.isSafeInteger(node.t)) fail();
        if ([9, 10, 11].includes(node.t)) {
            if (!Number.isSafeInteger(node.i) || node.i < 0 || node.i > 50000
                || definitions.has(node.i) && definitions.get(node.i) !== node) fail();
            definitions.set(node.i, node);
        }
        return node;
    }
    function keys(value) {
        const node = resolve(value);
        if (!encoded) {
            if (!sourceObject(node)) fail();
            const names = Object.keys(node);
            if (names.length > 512) fail();
            return names;
        }
        if (![10, 11].includes(node.t) || !sourceObject(node.p)
            || !Array.isArray(node.p.k) || !Array.isArray(node.p.v)
            || node.p.k.length !== node.p.v.length || node.p.k.length > 512
            || node.p.k.some(key => typeof key !== "string" || key.length > 256 || /[\u0000-\u001f\u007f\\]/.test(key))
            || new Set(node.p.k).size !== node.p.k.length) fail();
        return node.p.k;
    }
    function field(value, name) {
        const names = keys(value), index = names.indexOf(name);
        if (index < 0) return undefined;
        const node = resolve(value);
        if (encoded) return node.p.v[index];
        const descriptor = Object.getOwnPropertyDescriptor(node, name);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
        return descriptor.value;
    }
    function scalar(value) {
        if (value === undefined) return undefined;
        const node = resolve(value);
        if (!encoded) {
            if (node === null || typeof node === "string" || typeof node === "boolean"
                || typeof node === "number" && Number.isFinite(node)) return node;
            fail();
        }
        if (node.t === 2 && [0, 1, 2, 3].includes(node.s)) return [null, undefined, true, false][node.s];
        if (node.t === 0 && typeof node.s === "number" && Number.isFinite(node.s)) return node.s;
        if (node.t === 1 && typeof node.s === "string" && node.s.length <= maximumStringLength) {
            try { return JSON.parse('"' + node.s.replace(/\\x3C/g, "\\u003C") + '"'); }
            catch { fail(); }
        }
        fail();
    }
    function array(value) {
        const node = resolve(value), result = encoded ? node.a : node;
        if (encoded && node.t !== 9 || !Array.isArray(result) || result.length > 10000) fail();
        return result;
    }
    return { root, keys, field, scalar, array, fail };
}

function nativeContinuation(value, present, code) {
    if (!present || value === undefined) return { state: "absent" };
    if (value === null) return { state: "null" };
    if (value === "") return { state: "empty" };
    if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) projectionFailure(code);
    return { state: "present", value };
}

function nativeHistoryRequestReader(postData, stage) {
    const code = "NATIVE_HISTORY_REQUEST_UNQUALIFIED";
    const reject = reason => {
        throw withNativeFailurePredicate(Object.assign(new Error(code), { code }), stage, "history-request-" + reason);
    };
    const at = (reason, read) => {
        try { return read(); }
        catch (error) {
            if (error.code !== code) throw error;
            throw withNativeFailurePredicate(error, stage, "history-request-" + reason);
        }
    };
    const wire = sourceJson(postData, code, reject);
    if (!sourceObject(wire) || Object.keys(wire).sort().join(",") !== "f,m,t"
        || !Number.isInteger(wire.f) || wire.f < 0 || wire.f > 127 || !Array.isArray(wire.m)
        || wire.m.length > 512 || wire.m.some(id => !Number.isSafeInteger(id) || id < 0)) reject("envelope");
    const view = sourceProjection(wire.t, true, code);
    if (at("root", () => view.keys(wire.t)).some(key => !["data", "context"].includes(key))) reject("root");
    const data = at("data", () => view.field(wire.t, "data")), keys = at("data", () => view.keys(data));
    let action, actionRead = false;
    return { code, view, data, keys, reject, at, action() {
        if (!actionRead) { action = at("action", () => view.scalar(view.field(data, "action"))); actionRead = true; }
        return action;
    } };
}

function projectHistoryRequest(reader) {
    const { code, view, data, keys, reject, at } = reader;
    if (keys.some(key => !["action", "syncState", "enableLastMessage", "state", "saveToStore", "conversationHistoryFilter"].includes(key))) reject("data");
    if (reader.action() !== "GetConversationPageHistoryList") reject("action");
    if (at("last-message", () => view.scalar(view.field(data, "enableLastMessage"))) !== true) reject("last-message");
    const filter = at("filter", () => view.field(data, "conversationHistoryFilter"));
    if (filter !== undefined && at("filter", () => view.scalar(filter)) != null) reject("filter");
    const store = at("store", () => view.scalar(view.field(data, "saveToStore"))) ?? "conversationPageHistoryList";
    if (!historyStores.has(store)) reject("store");
    const stateKeys = at("state", () => view.keys(view.field(data, "state")));
    if (!stateKeys.includes(store) || stateKeys.some(key => key !== store && key !== "agentList")) reject("state");
    const continuation = at("continuation", () =>
        nativeContinuation(view.scalar(view.field(data, "syncState")), keys.includes("syncState"), code));
    let requestBasis = continuation.state === "present" ? "continuation" : "unobserved";
    if (requestBasis === "unobserved") {
        try {
            const seed = view.field(view.field(data, "state"), store), seedKeys = view.keys(seed);
            const rows = view.array(view.field(seed, "chats"));
            if (rows.length) requestBasis = "cached-seed";
            else if (continuation.state === "absent" && stateKeys.length === 1
                && seedKeys.length === 2 && seedKeys.includes("syncState") && view.scalar(view.field(seed, "syncState")) === "") {
                requestBasis = "empty-reset-shape";
            }
        } catch (error) {
            // An opaque cached seed is not decoded or promoted into starting evidence.
            if (error.code !== code) throw error;
        }
    }
    return { action: "GetConversationPageHistoryList", store,
        continuation, requestBasis };
}

export function projectNativeHistoryRequest(postData, stage = "unobserved") {
    return projectHistoryRequest(nativeHistoryRequestReader(postData, stage));
}

export function classifyNativeHistoryRequest(postData, stage = "unobserved", contextEligible = false) {
    try {
        const reader = nativeHistoryRequestReader(postData, stage), action = reader.action();
        if (typeof action !== "string" || action.length === 0) reader.reject("action");
        if (action === "GetSections") {
            if (!contextEligible) return { kind: "different-action" };
            const { view, data, keys, reject, at } = reader;
            if (keys.some(key => !["action", "state", "conversationHistoryFilter", "enableLastMessage", "enableCache", "source"].includes(key))) reject("data");
            if (at("state", () => view.keys(view.field(data, "state"))).length) reject("state");
            if (at("filter", () => view.scalar(view.field(data, "conversationHistoryFilter"))) != null) reject("filter");
            for (const field of ["enableLastMessage", "enableCache"]) {
                const value = at("data", () => view.scalar(view.field(data, field)));
                if (value !== undefined && typeof value !== "boolean") reject("data");
            }
            const source = at("data", () => view.scalar(view.field(data, "source")));
            if (source !== undefined && (typeof source !== "string" || source.length > 160 || /[\u0000-\u001f\u007f]/.test(source))) reject("data");
            return { kind: "context", request: { action: "GetSections" } };
        }
        if (action !== "GetConversationPageHistoryList") return { kind: "different-action" };
        return { kind: "history", request: projectHistoryRequest(reader) };
    } catch (error) {
        if (error.code !== "NATIVE_HISTORY_REQUEST_UNQUALIFIED") throw error;
        return { kind: "unqualified", error };
    }
}

export function projectNativeCoworkListRequest(url) {
    const code = "NATIVE_SOURCE_QUERY_UNQUALIFIED", keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length
        || keys.some(key => !["pageSize", "includeCached", "sessionType", "cursor"].includes(key))) projectionFailure(code);
    const size = url.searchParams.get("pageSize"), population = url.searchParams.get("sessionType");
    const cached = url.searchParams.get("includeCached");
    const continuation = nativeContinuation(url.searchParams.get("cursor"), url.searchParams.has("cursor"), code);
    if (size !== null && (!/^[1-9]\d{0,2}$/.test(size) || Number(size) > 200)
        || population !== null && !["interactive", "scheduled_run", "event_run", "automation_run"].includes(population)
        || cached !== null && cached !== "true"
        || url.searchParams.has("cursor") && continuation.state !== "present"
        || cached !== null && continuation.state === "present") projectionFailure(code);
    return { population, pageSize: size === null ? null : Number(size),
        includeCached: cached === "true", continuation };
}

function sourceResponseView(bytes, mime, serialized, code) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > projectionLimit
        || typeof mime !== "string" || typeof serialized !== "boolean") projectionFailure(code);
    let body = bytes;
    if (/^application\/x-tss-framed(?:;|$)/i.test(mime)) {
        if (/;\s*v=(?!1(?:;|$))/.test(mime) || !serialized || bytes.byteLength < 9) projectionFailure(code);
        const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (header.getUint8(0) !== 0 || header.getUint32(1) !== 0
            || header.getUint32(5) !== bytes.byteLength - 9) projectionFailure(code);
        body = bytes.subarray(9);
    } else if (!/^application\/json(?:;|$)/i.test(mime)) projectionFailure(code);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); }
    catch { projectionFailure(code); }
    const root = sourceJson(text, code);
    return sourceProjection(root, serialized, code);
}

function sourceIdentifier(value, code) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,1023}$/.test(value)
        || nativeValueHasCredentials(value)) projectionFailure(code);
    return value;
}

export function compareNativeIdentityHeaders(readHeader, principal) {
    if (typeof readHeader !== "function") projectionFailure("NATIVE_SOURCE_IDENTITY_UNQUALIFIED");
    if (!principal?.knownAccountMatched || principal.namespace !== "m365.accountInfo.objectId" || principal.realm !== "prod"
        || !Number.isFinite(Date.parse(principal.observedAt)) || Math.abs(Date.now() - Date.parse(principal.observedAt)) > 300000) {
        return { state: "unavailable", reason: "fresh-principal-required" };
    }
    return compareNativeAccountHeaders(readHeader, principal);
}

export function compareNativeReadHeaders(readHeader, identity) {
    if (typeof readHeader !== "function") projectionFailure("NATIVE_SOURCE_IDENTITY_UNQUALIFIED");
    if (identity?.account?.verification !== "verified" || identity.namespace !== "m365.accountInfo.objectId"
        || identity.realm !== "prod") return { state: "unavailable", reason: "verified-owner-required" };
    return compareNativeAccountHeaders(readHeader, identity.account);
}

function compareNativeAccountHeaders(readHeader, principal) {
    const subject = readHeader("x-user-id"), tenant = readHeader("x-tenant-id");
    if (subject === null || tenant === null) return { state: "unavailable", reason: "native-identity-header-missing" };
    try {
        sourceIdentifier(subject, "NATIVE_SOURCE_IDENTITY_UNQUALIFIED");
        sourceIdentifier(tenant, "NATIVE_SOURCE_IDENTITY_UNQUALIFIED");
    } catch {
        return { state: "unavailable", reason: "native-identity-header-unqualified" };
    }
    return subject === principal.subjectId && tenant === principal.tenantId
        ? { state: "matched" } : { state: "unavailable", reason: "native-identity-header-mismatch" };
}

function nativeListItems(view, rows, kind, code) {
    const get = (node, name) => view.scalar(view.field(node, name));
    if (rows.length > 500) view.fail();
    const identities = new Set();
    return rows.map(row => {
        const key = kind === "chat-list" ? "conversationId" : "sessionId";
        const id = sourceIdentifier(get(row, key), code);
        if (identities.has(id)) view.fail();
        identities.add(id);
        const item = { [key]: id };
        const created = get(row, kind === "chat-list" ? "createTimeUtc" : "createdAt");
        const activity = get(row, kind === "chat-list" ? "updateTimeUtc" : "lastActivity");
        if (created !== undefined && created !== null) {
            if (kind === "chat-list" ? !Number.isSafeInteger(created) || created < 0
                : typeof created !== "string" || created.length > 64) view.fail();
            item.createdAt = created;
        }
        if (activity !== undefined && activity !== null) {
            if (!Number.isSafeInteger(activity) || activity < 0) view.fail();
            item.lastActivity = activity;
        }
        return item;
    });
}

export function projectNativeSourceResponse({ bytes, mime, serialized = false, kind, store = "conversationPageHistoryList",
    expectedAccount, principalOptional = false }) {
    const code = "NATIVE_SOURCE_RESPONSE_UNQUALIFIED";
    if (!["principal", "chat-list", "cowork-list", "routing"].includes(kind)) projectionFailure(code);
    if (kind === "principal" && bytes?.byteLength > 1024 * 1024) projectionFailure(code);
    const view = sourceResponseView(bytes, mime, serialized, code);
    const get = (node, name) => view.scalar(view.field(node, name));
    let root = view.root;
    if (view.keys(root).includes("error") && get(root, "error") != null) view.fail();
    if (view.keys(root).includes("result")) root = view.field(root, "result");
    if (view.keys(root).includes("redirectTo") && get(root, "redirectTo")) view.fail();
    if (kind === "principal") {
        const sourceStore = view.field(root, "store");
        if (principalOptional && !view.keys(sourceStore).includes("accountInfo")) return null;
        const account = view.field(sourceStore, "accountInfo");
        const environment = get(account, "environment");
        if (get(account, "accountType") !== "AAD" || typeof environment !== "string"
            || !["prod", "production"].includes(environment.trim().toLowerCase())) view.fail();
        let accountLabelMatched, presentation;
        const identity = view.field(sourceStore, "identity");
        const label = identity === undefined ? undefined : get(identity, "userPrincipalName");
        if (expectedAccount !== undefined) {
            if (typeof expectedAccount !== "string" || expectedAccount.length > 160) view.fail();
            accountLabelMatched = typeof label === "string" && label.length <= 160
                && label.toLowerCase() === expectedAccount.toLowerCase();
        }
        if ((expectedAccount === undefined || accountLabelMatched) && typeof label === "string" && label.length <= 160
            && /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(label)) {
            presentation = { source: "microsoft-native-principal", email: label };
        }
        return { namespace: "m365.accountInfo.objectId", realm: "prod",
            tenantId: sourceIdentifier(get(account, "tenantId"), code),
            subjectId: sourceIdentifier(get(account, "objectId"), code),
            ...(expectedAccount === undefined ? {} : { accountLabelMatched }),
            ...(presentation ? { presentation } : {}) };
    }
    if (kind === "routing") {
        const endpoint = get(root, "endpoint"), geo = get(root, "geo");
        let url;
        try { url = new URL(endpoint); } catch { view.fail(); }
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
            || !["", "/"].includes(url.pathname)
            || !/^[a-z0-9][a-z0-9.-]*\.gateway\.prod\.island\.powerapps\.com$/.test(url.hostname)
            || typeof geo !== "string" || !/^[A-Za-z0-9-]{1,32}$/.test(geo)) view.fail();
        return { origin: url.origin, geo };
    }
    let rows, continuation, membership;
    if (kind === "chat-list") {
        const sourceStore = view.field(root, "store"), keys = view.keys(sourceStore);
        const flags = view.field(sourceStore, "featureFlags");
        const selection = flags === undefined ? undefined : get(flags, "enableChatLandingPageHistoryStore");
        if (store === null) {
            const stores = view.keys(view.field(root, "store")).filter(key => historyStores.has(key));
            if (typeof selection === "boolean") {
                store = selection ? "chatLandingPageHistoryList" : "conversationPageHistoryList";
                if (!stores.includes(store)) view.fail();
            } else {
                if (stores.length !== 1) view.fail();
                [store] = stores;
            }
        }
        if (!historyStores.has(store)) view.fail();
        const list = view.field(view.field(root, "store"), store);
        rows = view.array(view.field(list, "chats"));
        continuation = nativeContinuation(get(list, "syncState"), view.keys(list).includes("syncState"), code);
        if (view.keys(root).includes("historySource") || keys.includes("pinnedChatIds") || keys.includes("pinnedChats")) {
            const pinMap = keys.includes("pinnedChatIds") ? view.field(sourceStore, "pinnedChatIds") : undefined;
            const ids = pinMap === undefined ? null : view.keys(pinMap).map(key => {
                const pinnedAt = get(pinMap, key);
                if (!Number.isSafeInteger(pinnedAt) || pinnedAt < 0) view.fail();
                return sourceIdentifier(key, code);
            });
            if (ids && (ids.length > 500 || new Set(ids).size !== ids.length)) view.fail();
            const items = keys.includes("pinnedChats")
                ? nativeListItems(view, view.array(view.field(sourceStore, "pinnedChats")), kind, code) : null;
            const complete = ids !== null && items !== null && ids.length === items.length
                && items.every(item => ids.includes(item.conversationId));
            const selected = typeof selection === "boolean"
                && store === (selection ? "chatLandingPageHistoryList" : "conversationPageHistoryList");
            membership = { marker: get(root, "historySource") === "all-chats" ? "all-chats" : "unqualified",
                selected, pinnedComplete: complete, pinnedIds: ids, pinnedItems: items };
        }
    } else {
        rows = view.array(view.field(root, "tasks"));
        continuation = nativeContinuation(get(root, "nextCursor"), view.keys(root).includes("nextCursor"), code);
    }
    const items = nativeListItems(view, rows, kind, code);
    return { items, continuation, ...(kind === "chat-list" ? { store } : {}), ...(membership ? { membership } : {}) };
}

export function nativeHistoryWindow({ windowDays, now = Date.now() }) {
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 90 || !Number.isSafeInteger(now)) {
        projectionFailure("NATIVE_HISTORY_WINDOW_UNQUALIFIED");
    }
    try {
        return Object.freeze({ from: normalizeNativeMessageTime(new Date(now - windowDays * 86400000).toISOString()),
            to: normalizeNativeMessageTime(new Date(now).toISOString()) });
    } catch {
        projectionFailure("NATIVE_HISTORY_WINDOW_UNQUALIFIED");
    }
}

export function nativeHistoryActivity(record, surface, window, unit) {
    if (!["chat", "cowork"].includes(surface) || !sourceObject(window)
        || normalizeNativeMessageTime(window.from) !== window.from
        || normalizeNativeMessageTime(window.to) !== window.to || window.from > window.to) {
        projectionFailure("NATIVE_HISTORY_WINDOW_UNQUALIFIED");
    }
    const value = surface === "chat" ? record?.createdAt : record?.data?.ts;
    if (!["iso8601", "epoch-ms"].includes(unit) || value === undefined || value === null || value === "") {
        return { state: "unqualified", reason: "source-activity-time-unqualified" };
    }
    let calendarInstant;
    try {
        calendarInstant = surface === "chat" ? unit === "iso8601" ? normalizeNativeMessageTime(value) : null
            : normalizeNativeObservationTime(value, unit);
    } catch (error) {
        if (!(error instanceof NativeReadModelError)) throw error;
        return { state: "unqualified", reason: "source-activity-time-unqualified" };
    }
    if (!calendarInstant) return { state: "unqualified", reason: "source-activity-time-unqualified" };
    return { state: calendarInstant >= window.from && calendarInstant <= window.to ? "in-window" : "outside",
        value, unit, calendarInstant };
}
