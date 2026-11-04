import { createNativeClientValueCopier } from "./microsoft-native-client-value.mjs";

// Uses the already initialized app router/query client and original serverFn.
// Native middleware owns authentication, headers, routing and serialization.
export function createChatReadHost({ principal, getRouter, optionsForAction, getConversation, assertOwner, onRetire }) {
    const fail = reason => { throw Object.assign(new Error("NATIVE_CHAT_CLIENT_" + reason), { code: "NATIVE_CHAT_CLIENT_" + reason }); };
    const own = (value, key) => {
        const descriptor = value && Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) return undefined;
        if (!Object.hasOwn(descriptor, "value")) fail("ACCESSOR");
        return descriptor.value;
    };
    const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 1024;
    if (principal?.namespace !== "m365.accountInfo.objectId" || principal.realm !== "prod"
        || !identifier(principal.tenantId) || !identifier(principal.subjectId)
        || [getRouter, optionsForAction, getConversation, assertOwner, onRetire].some(value => typeof value !== "function")) {
        fail("BINDING_INVALID");
    }
    const router = getRouter(), context = router?.options?.context, store = context?.store, queryClient = context?.queryClient;
    if (!router?.routesById?.["/_sharedChatSetup/chat_/all"] || typeof router.subscribe !== "function"
        || typeof store?.getState !== "function" || typeof store?.subscribe !== "function"
        || typeof queryClient?.getDefaultOptions !== "function") fail("UNINITIALIZED");
    const query = queryClient.getDefaultOptions().queries?.queryFn, readState = store.getState;
    if (typeof query !== "function") fail("UNINITIALIZED");
    let retired = null, run = null, unsubscribeStore = () => {}, unsubscribeRouter = () => {};
    const stopRun = reason => {
        const previous = run;
        run = null;
        if (!previous) return;
        clearTimeout(previous.timer);
        previous.pending?.controller.abort();
        previous.pending?.reject(Object.assign(new Error(reason), { code: reason }));
        previous.store = null;
        previous.histories.clear();
    };
    const retire = (reason = "NATIVE_CHAT_CLIENT_RETIRED") => {
        if (retired) return;
        retired = reason;
        stopRun(reason);
        unsubscribeStore();
        unsubscribeRouter();
        onRetire(reason);
    };
    const current = () => {
        if (retired) throw Object.assign(new Error(retired), { code: retired });
        try {
            const authorization = assertOwner();
            if (authorization !== undefined) {
                if (authorization && typeof authorization.then === "function") Promise.resolve(authorization).catch(() => {});
                fail("GUARD_INVALID");
            }
            if (getRouter() !== router || router.options.context.store !== store || router.options.context.queryClient !== queryClient
                || store.getState !== readState || queryClient.getDefaultOptions().queries?.queryFn !== query) fail("REPLACED");
            const state = Reflect.apply(readState, store, []), account = own(state, "accountInfo"), environment = own(account, "environment");
            if (own(account, "accountType") !== "AAD" || own(account, "tenantId") !== principal.tenantId
                || own(account, "objectId") !== principal.subjectId || typeof environment !== "string"
                || !["prod", "production"].includes(environment.trim().toLowerCase())) fail("ACCOUNT_CHANGED");
            return state;
        } catch (error) {
            retire(/^NATIVE_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "NATIVE_CHAT_CLIENT_RETIRED");
            throw error;
        }
    };
    const inspect = () => {
        try { if (run) active(run); else current(); }
        catch (error) { retire(/^NATIVE_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "NATIVE_CHAT_CLIENT_RETIRED"); }
    };
    const active = selected => {
        const state = current();
        if (!selected || selected !== run) fail("OPERATION_RETIRED");
        if (Date.now() >= selected.deadline) fail("DEADLINE");
        const flag = own(own(state, "featureFlags"), "enableChatLandingPageHistoryStore");
        if (flag !== selected.flag) fail("POPULATION_CHANGED");
    };
    const subscribe = register => {
        const unsubscribe = register();
        if (typeof unsubscribe !== "function") fail("BINDING_INVALID");
        if (retired) {
            unsubscribe();
            throw Object.assign(new Error(retired), { code: retired });
        }
        return unsubscribe;
    };
    try {
        current();
        unsubscribeStore = subscribe(() => store.subscribe(inspect));
        unsubscribeRouter = subscribe(() => router.subscribe("onBeforeNavigate", () => retire("NATIVE_CHAT_CLIENT_NAVIGATION")));
        current();
    } catch (error) {
        retire(/^NATIVE_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "NATIVE_CHAT_CLIENT_RETIRED");
        throw error;
    }
    return Object.freeze({
        get instanceId() { return run?.instanceId ?? null; },
        assertCurrent: current,
        retire,
        begin({ deadline, instanceId }) {
            const state = current();
            if (run || !identifier(instanceId) || !Number.isFinite(deadline) || deadline <= Date.now()) fail("OPERATION_INVALID");
            const flag = own(own(state, "featureFlags"), "enableChatLandingPageHistoryStore");
            if (typeof flag !== "boolean") fail("POPULATION_UNQUALIFIED");
            run = { instanceId, deadline, flag, field: flag ? "chatLandingPageHistoryList" : "conversationPageHistoryList",
                store: null, cursor: undefined, histories: new Set(), details: new Set(), cursors: new Set(),
                invocations: new Set(), calls: 0, pending: null, copy: createNativeClientValueCopier(fail) };
            run.timer = setTimeout(() => retire("NATIVE_CHAT_CLIENT_DEADLINE"), Math.max(0, deadline - Date.now()));
            run.timer.unref?.();
        },
        suspend() {
            current();
            if (run?.pending) fail("OPERATION_PENDING");
            stopRun("NATIVE_CHAT_CLIENT_OPERATION_RETIRED");
        },
        async invoke(input) {
            const selected = run;
            active(selected);
            if (!input || Object.keys(input).sort().join(",") !== "arguments,invocationId,method"
                || !identifier(input.invocationId) || selected.invocations.has(input.invocationId)
                || selected.calls >= 24 || selected.pending || !["listChats", "readConversation"].includes(input.method)) {
                fail("INVOCATION_INVALID");
            }
            const args = input.arguments, list = input.method === "listChats";
            if (!args || typeof args !== "object" || Array.isArray(args)
                || Object.keys(args).some(key => !(list ? ["cursor"] : ["conversationId"]).includes(key))
                || list && (selected.cursor === "" || selected.cursor !== args.cursor
                    || Object.hasOwn(args, "cursor") && !identifier(args.cursor))
                || !list && (!selected.histories.has(args.conversationId) || selected.details.has(args.conversationId))) {
                fail("ARGUMENTS_INVALID");
            }
            const controller = new AbortController();
            let reject;
            const cancelled = new Promise((_, rejectValue) => { reject = rejectValue; });
            selected.pending = { controller, reject };
            selected.invocations.add(input.invocationId);
            selected.calls++;
            try {
                active(selected);
                let operation;
                if (list) {
                    const payload = { enableLastMessage: true,
                        state: { [selected.field]: selected.store ?? { chats: [], syncState: "" } },
                        ...(selected.cursor === undefined ? {} : { syncState: selected.cursor }),
                        ...(selected.flag ? { saveToStore: selected.field } : {}) };
                    const options = optionsForAction({ action: "GetConversationPageHistoryList", payload });
                    operation = query({ client: queryClient, queryKey: options.queryKey, meta: options.meta, signal: controller.signal });
                } else {
                    operation = getConversation({ data: { conversationId: args.conversationId }, signal: controller.signal });
                }
                const response = await Promise.race([operation, cancelled]);
                active(selected);
                let value;
                if (list) {
                    const result = selected.copy({ list: own(response, selected.field),
                        pinnedChatIds: own(response, "pinnedChatIds"), pinnedChats: own(response, "pinnedChats") });
                    if (!Array.isArray(result.list?.chats)
                        || typeof result.list.syncState !== "string") fail("EMPTY_UNQUALIFIED");
                    const cursor = result.list.syncState;
                    if (cursor && (cursor === selected.cursor || selected.cursors.has(cursor))) fail("CURSOR_INVALID");
                    const rows = values => values.map(row => {
                        if (!identifier(row.conversationId)) fail("RESPONSE_INVALID");
                        return { conversationId: row.conversationId,
                            ...(row.createTimeUtc === undefined ? {} : { createTimeUtc: row.createTimeUtc }),
                            ...(row.updateTimeUtc === undefined ? {} : { updateTimeUtc: row.updateTimeUtc }) };
                    });
                    const chats = rows(result.list.chats);
                    let pinned = null;
                    if (result.pinnedChatIds !== undefined || result.pinnedChats !== undefined) {
                        if (!result.pinnedChatIds || typeof result.pinnedChatIds !== "object" || Array.isArray(result.pinnedChatIds)
                            || !Array.isArray(result.pinnedChats)) fail("PINNED_UNQUALIFIED");
                        pinned = rows(result.pinnedChats);
                        const ids = Object.keys(result.pinnedChatIds);
                        if (new Set(pinned.map(row => row.conversationId)).size !== pinned.length || ids.length !== pinned.length
                            || pinned.some(row => !Object.hasOwn(result.pinnedChatIds, row.conversationId))
                            || Object.values(result.pinnedChatIds).some(value => !Number.isSafeInteger(value) || value < 0)) fail("PINNED_UNQUALIFIED");
                        const witness = JSON.stringify(ids.sort().map(id => [id, result.pinnedChatIds[id]]));
                        if (selected.pinWitness !== undefined && selected.pinWitness !== witness) fail("POPULATION_CHANGED");
                        selected.pinWitness = witness;
                    }
                    if (!chats.length && !pinned?.length) fail("EMPTY_UNQUALIFIED");
                    for (const row of [...chats, ...(pinned ?? [])]) selected.histories.add(row.conversationId);
                    selected.store = result.list;
                    selected.cursor = cursor;
                    if (cursor) selected.cursors.add(cursor);
                    value = { chats, pinned, syncState: cursor, selectedStore: selected.field,
                        membership: pinned === null ? "pinned-not-returned" : "returned-pinned-union", complete: false };
                } else {
                    if (own(response, "error") || own(response, "redirectTo")) fail("RESPONSE_INVALID");
                    const conversation = selected.copy(own(own(response, "store"), "rawConversationResponse"));
                    if (conversation?.conversationId !== args.conversationId || !Array.isArray(conversation.messages) || !conversation.messages.length) {
                        fail("CONVERSATION_UNQUALIFIED");
                    }
                    value = { conversation, connectedContext: own(own(response, "store"), "rawConnectedConversationResponse") == null
                        ? "not-returned" : "unqualified" };
                    selected.details.add(args.conversationId);
                }
                active(selected);
                return { schemaVersion: 1, kind: "native-client-return", instanceId: selected.instanceId,
                    invocationId: input.invocationId, method: input.method, arguments: { ...args },
                    observedAt: new Date().toISOString(), value };
            } catch (error) {
                retire(/^NATIVE_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "NATIVE_CHAT_CLIENT_READ_FAILED");
                throw error;
            } finally { selected.pending = null; }
        },
    });
}
