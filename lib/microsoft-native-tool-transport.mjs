// Uses the native bridge's reconnect subscription and the original Port API.
// No capability/consent values or native send methods are replaced.
export function createNativeToolTransportDenial({ getBridgeClass, assertOwner, onFailure }) {
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    const Bridge = getBridgeClass();
    if (typeof Bridge !== "function") fail("NATIVE_TOOL_TRANSPORT_CLASS_UNQUALIFIED");
    if (typeof Bridge.instance !== "function") fail("NATIVE_TOOL_TRANSPORT_FACTORY_UNQUALIFIED");
    const size = Object.getOwnPropertyDescriptor(Set.prototype, "size").get;
    const emptySet = value => {
        try { return Reflect.apply(size, value, []) === 0; }
        catch { return false; }
    };
    const existing = Bridge.singleton;
    const empty = value => value && value.port === undefined && emptySet(value.listeners) && emptySet(value.reconnectListeners);
    if (existing !== undefined && !empty(existing)) fail("NATIVE_TOOL_TRANSPORT_ALREADY_ACTIVE");
    const bridge = existing ?? Bridge.instance();
    const factory = Bridge.instance, ensurePort = bridge?.ensurePort, send = bridge?.postMessageWithStaleRetry;
    if (Bridge.singleton !== bridge) fail("NATIVE_TOOL_TRANSPORT_SINGLETON_UNQUALIFIED");
    if (!empty(bridge)) fail("NATIVE_TOOL_TRANSPORT_INITIAL_STATE_UNQUALIFIED");
    if (typeof bridge.addReconnectListener !== "function") fail("NATIVE_TOOL_TRANSPORT_SUBSCRIBE_UNQUALIFIED");
    if (typeof ensurePort !== "function") fail("NATIVE_TOOL_TRANSPORT_PORT_METHOD_UNQUALIFIED");
    if (typeof send !== "function") fail("NATIVE_TOOL_TRANSPORT_SEND_METHOD_UNQUALIFIED");
    const subscribe = bridge.addReconnectListener;
    let deniedConnections = 0, invalid = false;
    const deny = port => {
        try {
            if (typeof port?.disconnect !== "function") fail("NATIVE_TOOL_TRANSPORT_PORT_UNQUALIFIED");
            const result = port.disconnect();
            if (result !== undefined) fail("NATIVE_TOOL_TRANSPORT_DENIAL_UNCONFIRMED");
            deniedConnections++;
        } catch (error) {
            invalid = true;
            onFailure("NATIVE_TOOL_TRANSPORT_DENIAL_UNCONFIRMED");
            throw error;
        }
    };
    const current = () => {
        if (invalid || assertOwner() !== undefined || getBridgeClass() !== Bridge || Bridge.singleton !== bridge
            || Bridge.instance !== factory || bridge.ensurePort !== ensurePort || bridge.postMessageWithStaleRetry !== send
            || bridge.addReconnectListener !== subscribe
            || Reflect.apply(Set.prototype.values, bridge.reconnectListeners, []).next().value !== deny) {
            fail("NATIVE_TOOL_TRANSPORT_GUARD_LOST");
        }
    };
    try {
        const unsubscribe = Reflect.apply(subscribe, bridge, [deny]);
        if (typeof unsubscribe !== "function") fail("NATIVE_TOOL_TRANSPORT_UNSUBSCRIBE_UNQUALIFIED");
        current();
    } catch (error) {
        invalid = true;
        onFailure(error.code === "NATIVE_TOOL_TRANSPORT_UNSUBSCRIBE_UNQUALIFIED"
            ? error.code : "NATIVE_TOOL_TRANSPORT_GUARD_LOST");
        throw error;
    }
    // Deliberately retain the denial until the document is destroyed. Removing
    // it on retirement could let a still-running native callback reconnect.
    return Object.freeze({
        assertCurrent: current,
        get deniedConnections() { return deniedConnections; },
    });
}

// This denial-only owner precedes account discovery. It cannot authorize a
// reader, copy account data or invoke a native history method.
export function installNativeToolGuard(config) {
    if (!["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(location.origin)) return;
    const origin = location.origin, documentId = crypto.randomUUID();
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    const own = (value, key) => {
        const descriptor = value && Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && !Object.hasOwn(descriptor, "value")) fail("NATIVE_TOOL_GUARD_ACCESSOR");
        return descriptor?.value;
    };
    let active = true, failure = null, runtime, installing, publicCoworkScript, readerFactory, clientHook, containerOwner, containerGet;
    const publish = own(window, config.binding);
    if (typeof publish !== "function") fail("NATIVE_TOOL_GUARD_BINDING_MISSING");
    const stop = code => {
        if (!active) return;
        active = false;
        failure = /^NATIVE_[A-Z_]{1,80}$/.test(code ?? "") ? code : "NATIVE_TOOL_GUARD_FAILED";
        void Promise.resolve(publish({ documentId, kind: "failed", code: failure,
            ...(publicCoworkScript ? { publicCoworkScript } : {}),
        })).catch(() => {
            console.error("NATIVE_TOOL_GUARD_RETIREMENT_UNACKNOWLEDGED");
        });
    };
    const current = () => {
        if (!active || location.origin !== origin) fail(failure ?? "NATIVE_TOOL_GUARD_RETIRED");
        if (containerOwner && (containerOwner !== own(window, "coworker") || containerOwner.get !== containerGet)) {
            fail("NATIVE_TOOL_TRANSPORT_CONTAINER_UNQUALIFIED");
        }
        if (clientHook && runtime(476712).x !== clientHook) fail("NATIVE_TOOL_GUARD_RUNTIME_CHANGED");
    };
    const ready = Promise.resolve(publish({ documentId, kind: "ready" })).then(value => {
        if (value?.acknowledged !== true) fail("NATIVE_TOOL_GUARD_PROTOCOL_UNAVAILABLE");
        current();
    }).catch(reason => { stop(reason.code); throw reason; });
    // Failure is also published when native code never requests a factory.
    void ready.catch(() => {});
    const ensure = async container => {
        current();
        await ready;
        const owner = await publish({ documentId, kind: "ready" });
        if (owner?.acknowledged !== true) {
            stop("NATIVE_TOOL_GUARD_PROTOCOL_UNAVAILABLE");
            fail("NATIVE_TOOL_GUARD_PROTOCOL_UNAVAILABLE");
        }
        current();
        container ??= containerOwner;
        if (!container || container !== own(window, "coworker") || typeof container.get !== "function"
            || containerOwner && container !== containerOwner) fail("NATIVE_TOOL_TRANSPORT_CONTAINER_UNQUALIFIED");
        containerOwner = container;
        containerGet ??= container.get;
        installing ??= (async () => {
            if (!runtime) fail("NATIVE_TOOL_TRANSPORT_RUNTIME_MISSING");
            if (!Object.hasOwn(runtime.m ?? {}, 476712) || !Object.hasOwn(runtime.m ?? {}, 175081)) {
                if (!container || container !== own(window, "coworker")) {
                    fail("NATIVE_TOOL_TRANSPORT_CONTAINER_UNQUALIFIED");
                }
                const get = container.get; // The native container exports get through an accessor.
                if (typeof get !== "function") fail("NATIVE_TOOL_TRANSPORT_CONTAINER_UNQUALIFIED");
                // Native get loads this exposure's dependencies and returns its
                // factory; never call that factory or initialize Customize.
                let factory;
                try { factory = await Reflect.apply(get, container, ["./Customize"]); }
                catch { fail("NATIVE_TOOL_TRANSPORT_DEPENDENCIES_FAILED"); }
                current();
                if (container !== own(window, "coworker") || container.get !== get || typeof factory !== "function") {
                    fail("NATIVE_TOOL_TRANSPORT_CONTAINER_UNQUALIFIED");
                }
            }
            if (!Object.hasOwn(runtime.m ?? {}, 476712)) fail("NATIVE_TOOL_TRANSPORT_CLIENT_MODULE_MISSING");
            if (!Object.hasOwn(runtime.m ?? {}, 175081)) fail("NATIVE_TOOL_TRANSPORT_CAPABILITY_MODULE_MISSING");
            clientHook = runtime(476712).x;
            if (typeof clientHook !== "function") fail("NATIVE_TOOL_TRANSPORT_CLIENT_FACTORY_UNQUALIFIED");
            const capabilities = runtime(175081).H_;
            if (typeof capabilities?.getState !== "function" || typeof capabilities?.subscribe !== "function") {
                fail("NATIVE_COWORK_CLIENT_READONLY_UNQUALIFIED");
            }
            const readonly = () => ["isConsented", "isEdgeIdentityMatched", "isSimpleBrowserSupported"]
                .every(key => own(capabilities.getState(), key) === false);
            if (!readonly()) fail("NATIVE_COWORK_CLIENT_READONLY_UNQUALIFIED");
            const unsubscribe = capabilities.subscribe(() => {
                if (!readonly()) stop("NATIVE_COWORK_CLIENT_READONLY_UNQUALIFIED");
            });
            if (typeof unsubscribe !== "function" || !readonly()) fail("NATIVE_COWORK_CLIENT_READONLY_UNQUALIFIED");
            current();
        })().catch(reason => { stop(reason.code); throw reason; });
        await installing;
        current();
    };
    try {
        if (own(window, config.control) !== undefined) fail("NATIVE_TOOL_GUARD_DUPLICATE");
        Object.defineProperty(window, config.control, { value: Object.freeze({
            documentId, ensure, assertCurrent: current,
            acceptReaderFactory(factory) {
                current();
                if (typeof factory !== "function" || readerFactory && readerFactory !== factory) fail("NATIVE_TOOL_READER_FACTORY_CHANGED");
                readerFactory = factory;
            },
            status: () => ({ documentId, failure, installed: Boolean(clientHook) }),
        }) });
        const chunks = own(window, "chunk_coworker") ?? (window.chunk_coworker = []);
        if (!Array.isArray(chunks)) fail("NATIVE_TOOL_GUARD_RUNTIME_UNQUALIFIED");
        chunks.push([[`wire-tool-guard-${documentId}`], {}, loaded => {
            if (runtime && runtime !== loaded) stop("NATIVE_TOOL_GUARD_RUNTIME_CHANGED");
            else runtime = loaded;
        }]);
        const federation = own(window, "__FEDERATION__") ?? (window.__FEDERATION__ = {});
        if (own(federation, "__INSTANCES__")?.length) fail("NATIVE_TOOL_GUARD_INSTALL_LATE");
        const plugins = own(federation, "__GLOBAL_PLUGIN__") ?? (federation.__GLOBAL_PLUGIN__ = []);
        if (!Array.isArray(plugins)) fail("NATIVE_TOOL_GUARD_RUNTIME_UNQUALIFIED");
        plugins.push({
            name: "wire-native-tool-guard-" + documentId,
            apply(host) {
                const navigationFactories = new WeakMap();
                const checkRegistration = event => {
                    const remote = own(event, "remote");
                    if (own(remote, "name") !== "coworker") return;
                    try {
                        current();
                        if (host.version !== "2.9.2" || own(remote, "entry") !== config.manifest) {
                            fail("NATIVE_TOOL_VERSION_SELECTION_UNQUALIFIED");
                        }
                    } catch (reason) { stop(reason.code); throw reason; }
                };
                const checkSource = event => {
                    current();
                    if (host.version !== "2.9.2") fail("NATIVE_TOOL_TRANSPORT_HOST_VERSION_UNQUALIFIED");
                    const entry = own(own(event, "moduleInfo"), "entry");
                    if (entry !== config.entry) {
                        if (typeof entry === "string"
                            && /^https:\/\/res\.cdn\.office\.net\/s01-copilotstudio\/cowork\/(?:latest|v\/[\w.-]+)\/coworker\.[a-f0-9]{8}\.js$/.test(entry)) {
                            publicCoworkScript = entry.slice(entry.lastIndexOf("/") + 1);
                        }
                        fail("NATIVE_TOOL_TRANSPORT_ENTRY_UNQUALIFIED");
                    }
                };
                return {
                    beforeInit(event) {
                        const options = own(event, "userOptions"), remotes = own(options, "remotes");
                        if (!Array.isArray(remotes) || !remotes.some(remote => own(remote, "name") === "coworker")) return event;
                        try {
                            current();
                            const selected = remotes.filter(remote => own(remote, "name") === "coworker");
                            if (host.version !== "2.9.2" || selected.length !== 1 || own(selected[0], "version") !== undefined
                                || typeof own(selected[0], "entry") !== "string"
                                || !/^https:\/\/res\.cdn\.office\.net\/s01-copilotstudio\/cowork\/(?:latest\/version\.json|v\/[\w.-]+\/coworker-manifest\.json)$/.test(own(selected[0], "entry"))
                                || host.moduleCache?.has("coworker")
                                || (own(own(event, "options"), "remotes") ?? []).some(remote =>
                                    own(remote, "name") === "coworker" && own(remote, "entry") !== config.manifest)) {
                                fail("NATIVE_TOOL_VERSION_SELECTION_UNQUALIFIED");
                            }
                            return { ...event, userOptions: { ...options, remotes: remotes.map(remote =>
                                own(remote, "name") === "coworker" ? { ...remote, entry: config.manifest } : remote) } };
                        } catch (reason) { stop(reason.code); throw reason; }
                    },
                    beforeRegisterRemote: checkRegistration,
                    registerRemote: checkRegistration,
                    async getModuleFactory(event) {
                        if (own(event, "expose") !== "./CoworkNav" || own(own(event, "moduleInfo"), "name") !== "coworker") return;
                        try {
                            checkSource(event);
                            await ensure(own(event, "remoteEntryExports"));
                            // Preserve the original load-only get result itself:
                            // another get returns a different native closure.
                            const original = await Reflect.apply(containerGet, containerOwner, ["./CoworkNav"]);
                            current();
                            if (typeof original !== "function") fail("NATIVE_TOOL_NAV_FACTORY_UNQUALIFIED");
                            let admitted = false;
                            const factory = function (...args) {
                                try {
                                    current();
                                    if (!admitted) fail("NATIVE_TOOL_NAV_FACTORY_UNQUALIFIED");
                                } catch (reason) { stop(reason.code); throw reason; }
                                return Reflect.apply(original, this, args);
                            };
                            navigationFactories.set(factory, {
                                container: containerOwner, moduleInfo: own(event, "moduleInfo"),
                                admit() { admitted = true; },
                            });
                            return factory;
                        } catch (reason) { stop(reason.code); throw reason; }
                    },
                    async afterGetExpose(event) {
                        if (own(own(event, "moduleInfo"), "name") !== "coworker" || own(event, "error")) return;
                        try {
                            checkSource(event);
                            // This exact build's navigation export does not mount
                            // the shell. Only WIRE's composed Coworker factory may
                            // replace the tool-connecting app; other surfaces stop.
                            const expose = own(event, "expose");
                            let navigation;
                            if (expose === "./CoworkNav") {
                                const factory = own(event, "moduleFactory"), original = navigationFactories.get(factory);
                                if (!original || original.container !== own(event, "remoteEntryExports")
                                    || original.moduleInfo !== own(event, "moduleInfo")) fail("NATIVE_TOOL_NAV_FACTORY_UNQUALIFIED");
                                navigationFactories.delete(factory);
                                navigation = original;
                            }
                            if (expose !== "./CoworkNav" && !(expose === "./Coworker" && readerFactory
                                && own(event, "moduleFactory") === readerFactory)) {
                                fail("NATIVE_TOOL_CONNECTING_SURFACE_DENIED");
                            }
                            await ensure(own(event, "remoteEntryExports"));
                            navigation?.admit();
                        } catch (reason) { stop(reason.code); throw reason; }
                    },
                };
            },
        });
        window.addEventListener("pagehide", () => { active = false; }, { once: true });
    } catch (reason) { stop(reason.code); throw reason; }
}
