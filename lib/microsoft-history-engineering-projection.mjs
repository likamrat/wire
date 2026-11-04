// This factory is installed as WIRE-owned code in the browser. Raw bodies never leave it.
export function createHistoryEngineeringProjection({ expectedAccount, salt, maximumBytes = 2 * 1024 * 1024 }, makeProjection) {
    const fail = code => { throw Object.assign(new Error("NATIVE_" + code), { code: "NATIVE_" + code }); };
    if (typeof expectedAccount !== "string" || expectedAccount.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedAccount)
        || !Array.isArray(salt) || salt.length !== 32 || salt.some(value => !Number.isInteger(value) || value < 0 || value > 255)
        || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 2 * 1024 * 1024
        || typeof makeProjection !== "function") fail("ENGINEERING_BINDING");
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const own = (value, key) => {
        if (!object(value)) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) return undefined;
        if (!Object.hasOwn(descriptor, "value")) fail("ENGINEERING_ACCESSOR_REJECTED");
        return descriptor.value;
    };
    const encoder = new TextEncoder();
    const key = crypto.subtle.importKey("raw", Uint8Array.from(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hash = async value => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await key,
        encoder.encode(value))), value => value.toString(16).padStart(2, "0")).join("");
    const scalar = (view, value, field) => view.scalar(view.field(value, field));
    const identifier = value => {
        if (typeof value !== "string" || !value.length || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
            fail("ENGINEERING_IDENTIFIER_SHAPE");
        }
        return value;
    };
    const cursor = async (value, present) => {
        if (!present || value === undefined) return { state: "absent", key: null };
        if (value === null) return { state: "null", key: null };
        if (value === "") return { state: "empty", key: null };
        if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) fail("ENGINEERING_CURSOR_SHAPE");
        return { state: "present", key: await hash("cursor:" + value) };
    };
    const decode = (bytes, mime, serialized) => {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumBytes) fail("ENGINEERING_BYTE_LIMIT");
        let body = bytes;
        if (/^application\/x-tss-framed(?:;|$)/i.test(mime)) {
            if (!serialized || /;\s*v=(?!1(?:;|$))/.test(mime) || bytes.length < 9) fail("ENGINEERING_FRAME_SHAPE");
            const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            if (header.getUint8(0) !== 0 || header.getUint32(1) !== 0 || header.getUint32(5) !== bytes.length - 9) fail("ENGINEERING_FRAME_SHAPE");
            body = bytes.subarray(9);
        } else if (!/^application\/json(?:;|$)/i.test(mime)) fail("ENGINEERING_MIME_SHAPE");
        let parsed;
        try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
        catch { fail("ENGINEERING_JSON_SHAPE"); }
        return { view: makeProjection(parsed, serialized, "NATIVE_ENGINEERING_SOURCE_SHAPE"), root: parsed };
    };
    const principal = (view, root) => {
        const store = view.field(root, "store");
        if (store === undefined) return null;
        const account = view.field(store, "accountInfo");
        if (account === undefined) return null;
        const type = scalar(view, account, "accountType"), cloud = scalar(view, account, "environment");
        if (typeof type !== "string" || type.trim().toUpperCase() !== "AAD"
            || typeof cloud !== "string" || !["prod", "production"].includes(cloud.trim().toLowerCase())) fail("ENGINEERING_ACCOUNT_SCOPE");
        const identity = view.field(store, "identity");
        const label = identity === undefined ? undefined : scalar(view, identity, "userPrincipalName");
        if (label !== undefined && (typeof label !== "string" || label.toLowerCase() !== expectedAccount.toLowerCase())) fail("ENGINEERING_WRONG_IDENTITY");
        return { namespace: "m365.accountInfo.objectId", realm: "prod",
            tenantId: identifier(scalar(view, account, "tenantId")), subjectId: identifier(scalar(view, account, "objectId")),
            accountLabelMatched: label !== undefined };
    };
    async function list(view, root, surface, storeName) {
        const store = surface === "chat" ? view.field(view.field(root, "store"), storeName) : root;
        const rows = view.array(view.field(store, surface === "chat" ? "chats" : "tasks"));
        if (rows.length > 500) fail("ENGINEERING_MEMBER_LIMIT");
        const keys = [], times = [];
        let unqualifiedTimes = 0;
        for (const row of rows) {
            const id = identifier(scalar(view, row, surface === "chat" ? "conversationId" : "sessionId"));
            const member = await hash(surface + ":" + id);
            if (keys.includes(member)) fail("ENGINEERING_DUPLICATE_MEMBER");
            keys.push(member);
            const time = scalar(view, row, surface === "chat" ? "updateTimeUtc" : "lastActivity");
            if (Number.isSafeInteger(time) && time >= 0) times.push(time);
            else unqualifiedTimes++;
        }
        if (unqualifiedTimes) fail("ENGINEERING_TIMESTAMP_SHAPE");
        const field = surface === "chat" ? "syncState" : "nextCursor";
        return { surface, members: keys, count: keys.length, tail: keys.at(-1) ?? null,
            times: { minimum: times.length ? Math.min(...times) : null, maximum: times.length ? Math.max(...times) : null, unqualified: unqualifiedTimes },
            cursor: await cursor(scalar(view, store, field), view.keys(store).includes(field)) };
    }
    async function request({ url: input, method, body }) {
        const url = new URL(input), app = ["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(url.origin);
        const path = url.pathname.replace(/^\/hwav2(?=\/)/, "");
        if (url.username || url.password) fail("ENGINEERING_REQUEST_SCOPE");
        if (app && method === "GET") {
            const roles = {
                "/_serverFn/d1ab460bd6165cfc5985242e7248c7435d8b5bd9e2a55fd0fd1022a81319548d": "principal",
                "/_serverFn/e1446a039787a6f09f7172df1d7a68d91d750f72a56219ae968fee8b58e967ed": "context",
                "/_serverFn/22ef9231e91dd4cf46350df4f8e31fc54e727335d4a882bc56199bd904815585": "chat-initializer",
            };
            if (Object.hasOwn(roles, path)) return { role: roles[path], cursor: { state: "absent", key: null }, basis: "initializer", filter: "unobserved" };
        }
        if (app && method === "POST" && path === "/_serverFn/73e9366cfbebe3976abc796ef16c0305213fd6f32aea4731837e2a1f18e54268") {
            if (typeof body !== "string" || encoder.encode(body).length > maximumBytes) fail("ENGINEERING_REQUEST_SHAPE");
            let wire;
            try { wire = JSON.parse(body); } catch { fail("ENGINEERING_REQUEST_SHAPE"); }
            if (!object(wire) || Object.keys(wire).sort().join(",") !== "f,m,t"
                || !Array.isArray(wire.m) || wire.m.length > 512 || wire.m.some(id => !Number.isSafeInteger(id) || id < 0)
                || !Number.isInteger(wire.f) || wire.f < 0 || wire.f > 127) fail("ENGINEERING_REQUEST_SHAPE");
            const view = makeProjection(wire.t, true, "NATIVE_ENGINEERING_REQUEST_SHAPE"), data = view.field(wire.t, "data");
            if (view.keys(wire.t).some(key => !["data", "context"].includes(key))) fail("ENGINEERING_REQUEST_SHAPE");
            const action = scalar(view, data, "action"), filter = scalar(view, data, "conversationHistoryFilter");
            if (filter != null) fail("ENGINEERING_FILTERED_SCOPE");
            if (action === "GetSections") {
                if (view.keys(data).some(key => !["action", "state", "conversationHistoryFilter", "enableLastMessage", "enableCache", "source"].includes(key))
                    || view.keys(view.field(data, "state")).length) fail("ENGINEERING_REQUEST_SCOPE");
                for (const field of ["enableLastMessage", "enableCache"]) {
                    const value = scalar(view, data, field);
                    if (value !== undefined && typeof value !== "boolean") fail("ENGINEERING_REQUEST_SCOPE");
                }
                const source = scalar(view, data, "source");
                if (source !== undefined && (typeof source !== "string" || source.length > 160 || /[\u0000-\u001f\u007f]/.test(source))) {
                    fail("ENGINEERING_REQUEST_SCOPE");
                }
                return { role: "context", cursor: { state: "absent", key: null }, basis: "context", filter: "none" };
            }
            if (action !== "GetConversationPageHistoryList" || scalar(view, data, "enableLastMessage") !== true) fail("ENGINEERING_REQUEST_SCOPE");
            if (view.keys(data).some(key => !["action", "syncState", "enableLastMessage", "state", "saveToStore", "conversationHistoryFilter"].includes(key))) {
                fail("ENGINEERING_REQUEST_SCOPE");
            }
            const name = scalar(view, data, "saveToStore") ?? "conversationPageHistoryList";
            if (!["conversationPageHistoryList", "chatLandingPageHistoryList"].includes(name)) fail("ENGINEERING_FILTERED_SCOPE");
            const continuation = await cursor(scalar(view, data, "syncState"), view.keys(data).includes("syncState"));
            const state = view.field(data, "state"), seed = view.field(state, name), seedKeys = view.keys(seed);
            if (view.keys(state).some(key => ![name, "agentList"].includes(key))) fail("ENGINEERING_REQUEST_SCOPE");
            const count = view.array(view.field(seed, "chats")).length;
            const reset = continuation.state === "absent" && view.keys(state).length === 1 && seedKeys.length === 2
                && seedKeys.includes("syncState") && scalar(view, seed, "syncState") === "" && count === 0;
            return { role: "chat-list", store: name, cursor: continuation,
                basis: reset ? "reset" : continuation.state === "present" ? "continuation" : "cached-or-unrecognized", filter: "none" };
        }
        const gateway = url.protocol === "https:" && /^[a-z0-9][a-z0-9.-]*\.gateway\.prod\.island\.powerapps\.com$/.test(url.hostname);
        if (app && /^\/chat\/conversation\//.test(path) || gateway && /\/(?:detail|messages)(?:\/|$)/.test(path)) fail("ENGINEERING_CONTENT_READ_FORBIDDEN");
        if (gateway && method === "GET" && path === "/v1/routing" && !url.search) return { role: "routing" };
        if (gateway && method === "GET" && path === "/v1/tasks/live") {
            const keys = [...url.searchParams.keys()];
            if (new Set(keys).size !== keys.length || keys.some(key => !["cursor", "pageSize", "includeCached", "sessionType"].includes(key))) fail("ENGINEERING_REQUEST_SCOPE");
            const size = url.searchParams.get("pageSize"), type = url.searchParams.get("sessionType"), cached = url.searchParams.get("includeCached");
            if (size !== null && (!/^[1-9]\d{0,2}$/.test(size) || Number(size) > 200)
                || type !== null && type !== "interactive" || cached !== null && cached !== "true") fail("ENGINEERING_REQUEST_SCOPE");
            const continuation = await cursor(url.searchParams.get("cursor"), url.searchParams.has("cursor"));
            if (cached && continuation.state === "present") fail("ENGINEERING_REQUEST_SCOPE");
            return { role: "cowork-list", cursor: continuation, basis: continuation.state === "present" ? "continuation" : "first-page",
                filter: type === "interactive" ? "interactive" : "none", pageSize: size === null ? null : Number(size), includeCached: cached === "true" };
        }
        return null;
    }
    async function response({ role, store, requestBasis, bytes, mime, serialized }) {
        if (!["principal", "context", "routing", "chat-list", "chat-initializer", "cowork-list"].includes(role)) fail("ENGINEERING_REQUEST_SCOPE");
        const decoded = decode(bytes, mime, serialized), view = decoded.view;
        let root = decoded.root;
        if (view.keys(root).includes("result")) root = view.field(root, "result");
        if (view.keys(root).includes("error") && scalar(view, root, "error") != null) fail("ENGINEERING_SOURCE_ERROR");
        const identity = ["principal", "context", "chat-list", "chat-initializer"].includes(role) ? principal(view, root) : null;
        if (role === "principal") return { role, principal: identity };
        if (role === "context") {
            if (!["context", "initializer"].includes(requestBasis)) fail("ENGINEERING_REQUEST_SCOPE");
            const sourceStore = view.field(root, "store");
            const collection = value => {
                if (value === undefined) return { availability: "absent", count: null };
                try {
                    const rows = view.array(value);
                    if (rows.length > 500) fail("ENGINEERING_MEMBER_LIMIT");
                    return { availability: "recorded", count: rows.length };
                } catch (error) {
                    if (error.code !== "NATIVE_ENGINEERING_SOURCE_SHAPE") throw error;
                    return { availability: "unsupported", count: null };
                }
            };
            const histories = [];
            for (const name of ["conversationPageHistoryList", "chatLandingPageHistoryList"]) {
                const value = sourceStore === undefined ? undefined : view.field(sourceStore, name);
                if (value === undefined) {
                    histories.push({ store: name, availability: "absent", count: null, cursor: { state: "absent", key: null } });
                    continue;
                }
                const rows = collection(view.field(value, "chats"));
                histories.push({ store: name, ...rows,
                    cursor: await cursor(scalar(view, value, "syncState"), view.keys(value).includes("syncState")) });
            }
            const flags = sourceStore === undefined ? undefined : view.field(sourceStore, "featureFlags");
            const flag = flags === undefined ? undefined : scalar(view, flags, "enableChatLandingPageHistoryStore");
            return { role, principal: identity, structure: {
                purpose: requestBasis === "context" ? "sections" : "common-context",
                histories,
                pinnedChatIds: collection(sourceStore === undefined ? undefined : view.field(sourceStore, "pinnedChatIds")),
                pinnedChats: collection(sourceStore === undefined ? undefined : view.field(sourceStore, "pinnedChats")),
                landingStoreFlag: flag === undefined ? "absent" : flag === true ? "true" : flag === false ? "false" : "unsupported",
            } };
        }
        if (role === "routing") {
            const endpoint = scalar(view, root, "endpoint"), url = typeof endpoint === "string" ? new URL(endpoint) : null;
            if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash
                || !["", "/"].includes(url.pathname) || !/\.gateway\.prod\.island\.powerapps\.com$/.test(url.hostname)) fail("ENGINEERING_ROUTING_SHAPE");
            return { role, endpoint: url.origin };
        }
        const surface = role === "cowork-list" ? "cowork" : "chat";
        return { role, principal: identity, list: await list(view, root, surface, store ?? "conversationPageHistoryList"),
            marker: "none" };
    }
    async function document(transport) {
        const loader = own(own(own(own(transport, "router"), "dehydratedData"), "copilotBootstrap"), "loaderData");
        if (!object(loader) || Object.keys(loader).length > 32) fail("ENGINEERING_DOCUMENT_SHAPE");
        let identity = null;
        for (const route of Object.keys(loader)) {
            const data = own(loader, route);
            if (!object(data)) continue;
            const view = makeProjection(data, false, "NATIVE_ENGINEERING_DOCUMENT_SHAPE"), found = principal(view, data);
            if (found) {
                if (identity && (identity.tenantId !== found.tenantId || identity.subjectId !== found.subjectId)) fail("ENGINEERING_WRONG_IDENTITY");
                identity = found;
            }
        }
        return { role: "document", principal: identity, list: null, marker: "none" };
    }
    return Object.freeze({ request, response, document, hash });
}

export function installHistoryEngineeringCapture({ binding, projectionBinding }, projection) {
    if (!["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(location.origin)) return;
    Object.defineProperty(window, projectionBinding, { value: projection, configurable: false, writable: false });
    const report = async error => {
        const code = typeof error?.code === "string" && /^NATIVE_ENGINEERING_[A-Z_]+$/.test(error.code)
            ? error.code : "NATIVE_ENGINEERING_CAPTURE_FAILED";
        await window[binding]({ type: "engineering-failure", code });
        throw Object.assign(new Error(code), { code });
    };
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const input = args[0], init = args[1];
        const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, location.href);
        const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
        let body;
        if (init && Object.hasOwn(init, "body")) {
            const descriptor = Object.getOwnPropertyDescriptor(init, "body");
            if (!Object.hasOwn(descriptor, "value")) return report({ code: "NATIVE_ENGINEERING_ACCESSOR_REJECTED" });
            body = descriptor.value;
        }
        let request;
        try { request = await projection.request({ url: url.href, method, body }); }
        catch (error) { return report(error); }
        if (!request) return Reflect.apply(originalFetch, this, args);
        const requestId = crypto.randomUUID(), requestUrlKey = await projection.hash("url:" + url.href);
        try {
            await window[binding]({ type: "engineering-request", requestId, method, requestUrlKey, projection: request });
            if (init && init.body !== body || String(init?.method ?? input?.method ?? "GET").toUpperCase() !== method
                || new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, location.href).href !== url.href) {
                throw Object.assign(new Error(), { code: "NATIVE_ENGINEERING_REQUEST_CHANGED" });
            }
        } catch (error) { return report(error); }
        const response = await Reflect.apply(originalFetch, this, args);
        try {
            if (response.status !== 200 || response.redirected || response.url !== url.href) {
                throw Object.assign(new Error(), { code: "NATIVE_ENGINEERING_RESPONSE_STATUS" });
            }
            const reader = response.clone().body.getReader(), chunks = [];
            let bytes = 0, timer;
            try {
                const timeout = new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        void reader.cancel();
                        reject(Object.assign(new Error(), { code: "NATIVE_ENGINEERING_RESPONSE_DEADLINE" }));
                    }, 15000);
                });
                for (;;) {
                    const chunk = await Promise.race([reader.read(), timeout]);
                    if (chunk.done) break;
                    bytes += chunk.value.byteLength;
                    if (bytes > 2 * 1024 * 1024) {
                        await reader.cancel();
                        throw Object.assign(new Error(), { code: "NATIVE_ENGINEERING_BYTE_LIMIT" });
                    }
                    chunks.push(chunk.value);
                }
            } finally { clearTimeout(timer); reader.releaseLock(); }
            const decoded = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) { decoded.set(chunk, offset); offset += chunk.byteLength; }
            const projected = await projection.response({ role: request.role, store: request.store, requestBasis: request.basis, bytes: decoded,
                mime: response.headers.get("content-type") ?? "", serialized: Boolean(response.headers.get("x-tss-serialized")) });
            await window[binding]({ type: "engineering-response", requestId, requestUrlKey, method, bytes, projection: projected });
            return response;
        } catch (error) {
            await report(error).catch(() => console.error("WIRE_ENGINEERING_OBSERVATION_FAILED"));
            return response;
        }
    };
    const documentToken = crypto.randomUUID(), originalUrl = new URL(location.href);
    originalUrl.hash = "";
    const documentKey = projection.hash("url:" + originalUrl.href);
    const deliver = async (state, projected) => window[binding]({ type: "engineering-document", documentToken,
        documentUrlKey: await documentKey, state, ...(projected ? { projection: projected } : {}) });
    void deliver("started").catch(error => report(error)).catch(() => {});
    const observe = transport => {
        if (!transport || typeof transport !== "object") return;
        const descriptor = Object.getOwnPropertyDescriptor(transport, "initialized");
        if (descriptor && (!Object.hasOwn(descriptor, "value") || descriptor.configurable === false)) {
            void report({ code: "NATIVE_ENGINEERING_DOCUMENT_SHAPE" }).catch(() => {});
            return;
        }
        const capture = () => {
            void projection.document(transport).then(value => deliver("complete", value)).catch(error => report(error)).catch(() => {});
        };
        let initialized = descriptor?.value;
        if (initialized === true) { capture(); return; }
        Object.defineProperty(transport, "initialized", {
            configurable: true, enumerable: descriptor?.enumerable ?? true,
            get: () => initialized,
            set(value) {
                initialized = value;
                if (value !== true) return;
                Object.defineProperty(transport, "initialized", { configurable: true, enumerable: descriptor?.enumerable ?? true,
                    writable: descriptor?.writable ?? true, value });
                capture();
            },
        });
    };
    const descriptor = Object.getOwnPropertyDescriptor(window, "$_TSR");
    if (descriptor) {
        if (Object.hasOwn(descriptor, "value")) observe(descriptor.value);
        else void report({ code: "NATIVE_ENGINEERING_DOCUMENT_SHAPE" }).catch(() => {});
    } else Object.defineProperty(window, "$_TSR", {
        configurable: true, enumerable: true, get: () => undefined,
        set(value) {
            Object.defineProperty(window, "$_TSR", { configurable: true, enumerable: true, writable: true, value });
            observe(value);
        },
    });
}
