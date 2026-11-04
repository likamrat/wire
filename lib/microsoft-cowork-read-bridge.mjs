import { createNativeClientValueCopier } from "./microsoft-native-client-value.mjs";

// This runs in the owned Microsoft realm with references from the native shell.
// Results describe native client returns, never original HTTP/UI requests.
export function createCoworkReadBridge({ principal, getAccount, getClient, getCapabilities,
    subscribeClient, subscribeCapabilities, assertCurrent, instanceId, deadline, onRetire }) {
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    const own = (value, key) => {
        const descriptor = value && Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) return undefined;
        if (!Object.hasOwn(descriptor, "value")) fail("NATIVE_COWORK_CLIENT_ACCESSOR");
        return descriptor.value;
    };
    const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 1024;
    if (!principal || principal.namespace !== "m365.accountInfo.objectId" || principal.realm !== "prod"
        || !identifier(principal.tenantId) || !identifier(principal.subjectId) || !identifier(instanceId)
        || !Number.isFinite(deadline) || deadline <= Date.now()
        || onRetire !== undefined && typeof onRetire !== "function"
        || [getAccount, getClient, getCapabilities, subscribeClient, subscribeCapabilities, assertCurrent]
            .some(value => typeof value !== "function")) fail("NATIVE_COWORK_CLIENT_BINDING_INVALID");
    const expected = { tenantId: principal.tenantId, userId: principal.subjectId };
    const client = getClient(), methods = {
        listTasks: own(client, "listTasks"), listMessages: own(client, "listMessages"),
    };
    if (!client || Object.values(methods).some(value => typeof value !== "function")) {
        fail("NATIVE_COWORK_CLIENT_UNAVAILABLE");
    }
    let retired = null, pending = null, calls = 0;
    const invoked = new Set(), histories = new Set(), cursors = new Map(), seenCursors = new Map();
    let unsubscribeClient = () => {}, unsubscribeCapabilities = () => {};
    let timer;
    const retire = (reason = "NATIVE_COWORK_CLIENT_RETIRED") => {
        if (retired) return;
        retired = reason;
        clearTimeout(timer);
        pending?.controller.abort();
        pending?.reject(Object.assign(new Error(reason), { code: reason }));
        unsubscribeClient();
        unsubscribeCapabilities();
        onRetire?.(reason);
    };
    const current = () => {
        if (retired) fail(retired);
        if (Date.now() >= deadline) {
            retire("NATIVE_COWORK_CLIENT_DEADLINE");
            fail(retired);
        }
        let authorization;
        try { authorization = assertCurrent(); }
        catch (error) {
            retire(typeof error?.code === "string" && /^NATIVE_[A-Z_]+$/.test(error.code)
                ? error.code : "NATIVE_COWORK_CLIENT_RETIRED");
            throw error;
        }
        if (authorization !== undefined) {
            if (authorization && typeof authorization.then === "function") Promise.resolve(authorization).catch(() => {});
            retire("NATIVE_COWORK_CLIENT_GUARD_INVALID");
            fail(retired);
        }
        const account = getAccount(), capabilities = getCapabilities();
        if (own(account, "tenantId") !== expected.tenantId || own(account, "userId") !== expected.userId
            || own(account, "realm") !== "prod") {
            retire("NATIVE_COWORK_CLIENT_ACCOUNT_CHANGED");
            fail(retired);
        }
        if (!capabilities || ["isConsented", "isEdgeIdentityMatched", "isSimpleBrowserSupported"]
            .some(key => own(capabilities, key) !== false)) {
            retire("NATIVE_COWORK_CLIENT_READONLY_UNQUALIFIED");
            fail(retired);
        }
        if (getClient() !== client || Object.entries(methods).some(([key, method]) => own(client, key) !== method)) {
            retire("NATIVE_COWORK_CLIENT_REPLACED");
            fail(retired);
        }
    };
    const inspect = () => {
        try { current(); }
        catch (error) {
            retire(typeof error?.code === "string" && /^NATIVE_[A-Z_]+$/.test(error.code)
                ? error.code : "NATIVE_COWORK_CLIENT_RETIRED");
        }
    };
    const copy = createNativeClientValueCopier(reason => fail("NATIVE_COWORK_CLIENT_" + reason));
    const subscribe = register => {
        const unsubscribe = register(inspect);
        if (typeof unsubscribe !== "function") fail("NATIVE_COWORK_CLIENT_BINDING_INVALID");
        if (retired) {
            unsubscribe();
            fail(retired);
        }
        return unsubscribe;
    };
    try {
        current();
        timer = setTimeout(() => retire("NATIVE_COWORK_CLIENT_DEADLINE"), Math.max(0, deadline - Date.now()));
        timer.unref?.();
        unsubscribeClient = subscribe(subscribeClient);
        unsubscribeCapabilities = subscribe(subscribeCapabilities);
        current();
    } catch (error) {
        retire("NATIVE_COWORK_CLIENT_RETIRED");
        throw error;
    }
    return Object.freeze({
        instanceId,
        assertCurrent: current,
        retire,
        async invoke(input) {
            current();
            if (!input || Object.keys(input).sort().join(",") !== "arguments,invocationId,method"
                || !identifier(input.invocationId) || invoked.has(input.invocationId)
                || !Object.hasOwn(methods, input.method) || pending || calls >= 144) {
                fail("NATIVE_COWORK_CLIENT_INVOCATION_INVALID");
            }
            const args = input.arguments, method = input.method;
            if (!args || typeof args !== "object" || Array.isArray(args)
                || Object.keys(args).some(key => !(method === "listTasks"
                    ? ["cursor", "pageSize", "includeCached", "sessionType"]
                    : ["cursor", "pageSize", "sessionId"]).includes(key))
                || !Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > 200
                || Object.hasOwn(args, "cursor") && !identifier(args.cursor)
                || method === "listTasks" && (Object.hasOwn(args, "includeCached") && typeof args.includeCached !== "boolean"
                    || Object.hasOwn(args, "sessionType") && !["interactive", "scheduled_run", "automation_run"].includes(args.sessionType))
                || method === "listMessages" && !histories.has(args.sessionId)) {
                fail("NATIVE_COWORK_CLIENT_ARGUMENTS_INVALID");
            }
            const key = method === "listTasks" ? "tasks:" + (args.sessionType ?? "") : "messages:" + args.sessionId;
            const previous = cursors.get(key);
            if (previous === null || previous !== undefined && previous !== args.cursor
                || previous === undefined && Object.hasOwn(args, "cursor")) fail("NATIVE_COWORK_CLIENT_CURSOR_INVALID");
            const controller = new AbortController();
            let reject;
            const cancelled = new Promise((_, no) => { reject = no; });
            pending = { controller, reject };
            invoked.add(input.invocationId);
            calls++;
            try {
                const operation = { ...args, signal: controller.signal };
                current();
                const value = copy(await Promise.race([Reflect.apply(methods[method], client, [operation]), cancelled]));
                current();
                const rows = value?.[method === "listTasks" ? "tasks" : "events"];
                if (!Array.isArray(rows) || rows.length === 0
                    || !(value.nextCursor === null || identifier(value.nextCursor))) {
                    fail("NATIVE_COWORK_CLIENT_NORMALIZED_EMPTY");
                }
                if (value.nextCursor !== null && value.nextCursor === args.cursor) fail("NATIVE_COWORK_CLIENT_CURSOR_INVALID");
                const seen = seenCursors.get(key) ?? new Set();
                if (value.nextCursor !== null && seen.has(value.nextCursor)) fail("NATIVE_COWORK_CLIENT_CURSOR_INVALID");
                if (value.nextCursor !== null) seen.add(value.nextCursor);
                seenCursors.set(key, seen);
                if (method === "listTasks") {
                    for (const row of rows) {
                        if (!identifier(row.sessionId) || !identifier(row.ic3ThreadId)) fail("NATIVE_COWORK_CLIENT_RESPONSE_INVALID");
                        histories.add(row.sessionId);
                    }
                } else if (rows.some(row => !identifier(row.id) || !identifier(row.event)
                    || !row.data || typeof row.data !== "object" || Array.isArray(row.data))) {
                    fail("NATIVE_COWORK_CLIENT_RESPONSE_INVALID");
                }
                cursors.set(key, value.nextCursor);
                return { schemaVersion: 1, kind: "native-client-return", instanceId,
                    invocationId: input.invocationId, method, arguments: { ...args },
                    observedAt: new Date().toISOString(), value };
            } catch (error) {
                retire(typeof error?.code === "string" && /^NATIVE_[A-Z_]+$/.test(error.code)
                    ? error.code : "NATIVE_COWORK_CLIENT_READ_FAILED");
                throw error;
            } finally { pending = null; }
        },
    });
}
