// Executed only in a fresh, leased Microsoft document. Uses the native module
// registration protocols; never replaces fetch, React hooks or provider values.
export function installCoworkReadHost(config, compose, createReadBridge, createChatHost, createProviderLifetime) {
    if (!["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(location.origin)
        || window.top !== window) return;
    const origin = location.origin, documentId = crypto.randomUUID(), loaded = {};
    const surfaces = config.surfaces ?? ["cowork"], needsCowork = surfaces.includes("cowork"), needsChat = surfaces.includes("chat");
    const listeners = new Set();
    let active = true, authorized = false, operation = null, binding = null, composition = null, chatHost = null, prepared = false;
    let state = "waiting", failure = null, host = null, providerLifetime = null;
    const seenClients = new WeakSet();
    const own = (object, key) => {
        const descriptor = object && Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor) return undefined;
        if (!Object.hasOwn(descriptor, "value")) throw new Error("NATIVE_COWORK_BOOTSTRAP_ACCESSOR");
        return descriptor.value;
    };
    const error = code => Object.assign(new Error(code), { code });
    const notify = () => { for (const listener of listeners) listener(); };
    const stop = code => {
        if (!active) return;
        if (typeof code !== "string" || !/^NATIVE_[A-Z_]{1,80}$/.test(code)) code = "NATIVE_COWORK_BOOTSTRAP_FAILED";
        failure = code;
        state = "failed";
        active = false;
        binding?.retire(code);
        chatHost?.retire(code);
        composition?.retire();
        providerLifetime?.retire(code);
        operation = null;
        notify();
        const publish = own(window, config.retiredBinding);
        if (typeof publish === "function") {
            void Promise.resolve(publish({ documentId, code })).catch(() => {
                console.error("NATIVE_COWORK_RETIREMENT_UNACKNOWLEDGED");
            });
        }
    };
    const documentCurrent = () => {
        if (!active || location.origin !== origin || !prepared && Date.now() >= config.ownerDeadline) {
            throw error(failure ?? "NATIVE_COWORK_BOOTSTRAP_RETIRED");
        }
    };
    const current = () => {
        documentCurrent();
        if (prepared) providerLifetime.assertCurrent();
        const guard = own(window, config.toolControl);
        if (!guard) throw error("NATIVE_TOOL_GUARD_MISSING");
        guard.assertCurrent();
    };
    const operationCurrent = () => {
        current();
        if (!operation || Date.now() >= operation.deadline) throw error("NATIVE_COWORK_CLIENT_DEADLINE");
    };
    const captureRuntime = (name, key) => {
        const chunks = own(window, name) ?? (window[name] = []);
        if (!Array.isArray(chunks)) throw error("NATIVE_COWORK_BOOTSTRAP_RUNTIME");
        chunks.push([[`wire-cowork-${key}-${documentId}`], {}, runtime => {
            if (!active) return;
            if (loaded[key] && loaded[key] !== runtime) {
                stop("NATIVE_COWORK_BOOTSTRAP_RUNTIME_CHANGED");
                return;
            }
            loaded[key] = runtime;
        }]);
    };
    const wait = async predicate => {
        while (!predicate()) {
            current();
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        current();
    };
    const requireNative = (runtime, id) => {
        current();
        if (!runtime || !Object.hasOwn(runtime.m ?? {}, id)) throw error("NATIVE_COWORK_BOOTSTRAP_MODULE_MISSING");
        return runtime(id);
    };
    const preparedState = () => {
        if ((!needsCowork || composition) && (!needsChat || chatHost) && providerLifetime?.mounted) { prepared = true; state = "idle"; }
    };
    const readyState = () => {
        if ((!needsCowork || binding) && (!needsChat || chatHost?.instanceId)) state = "ready";
    };
    const makeProviderLifetime = () => {
        if (providerLifetime) return providerLifetime;
        const react = requireNative(loaded.app, 468902);
        providerLifetime = createProviderLifetime({
            react, principal: config.principal, getRouter: () => own(window, "__TSR_ROUTER__"),
            useStore: requireNative(loaded.app, 339248).$K,
            useQueryClient: requireNative(loaded.app, 784501).jE,
            useRuntime: requireNative(loaded.app, 101912).gr,
            useAccount: requireNative(loaded.app, 217142).T,
            assertOwner: documentCurrent, onMounted: preparedState, onRetire: stop,
        });
        return providerLifetime;
    };
    const installChatLifetime = router => {
        try {
            current();
            const root = document.getElementById("root");
            if (!root || Object.getOwnPropertyNames(root).some(key => key.startsWith("__reactContainer$"))) {
                throw error("NATIVE_PROVIDER_INSTALL_LATE");
            }
            const routes = router?.getMatchedRoutes?.(location.pathname)?.[0], route = routes?.at(-1);
            const original = route?.options?.component;
            if (!Array.isArray(routes) || routes[0]?.id !== "__root__" || route.id === "__root__"
                || typeof original !== "function" || typeof route.update !== "function") throw error("NATIVE_PROVIDER_ROUTE_UNQUALIFIED");
            const react = requireNative(loaded.app, 468902), lifetime = makeProviderLifetime();
            const ReaderRoute = props => react.createElement(lifetime.Boundary, null, react.createElement(original, props));
            if (typeof original.preload === "function") Object.defineProperty(ReaderRoute, "preload", { value: original.preload });
            route.update({ component: ReaderRoute });
            if (route.options.component !== ReaderRoute) throw error("NATIVE_PROVIDER_ROUTE_UNQUALIFIED");
        } catch (reason) { stop(reason.code ?? "NATIVE_PROVIDER_INSTALL_FAILED"); }
    };
    const prepareChat = async () => {
        await wait(() => authorized && loaded.app && (!needsCowork || composition)
            && own(window, "__TSR_ROUTER__")?.options?.context?.store);
        chatHost = createChatHost({
            principal: config.principal, getRouter: () => own(window, "__TSR_ROUTER__"),
            optionsForAction: requireNative(loaded.app, 806101).f,
            getConversation: requireNative(loaded.app, 551945).o,
            assertOwner: current, onRetire: stop,
        });
        preparedState();
    };
    const prepare = async event => {
        await wait(() => authorized && loaded.app && loaded.cowork);
        const container = own(event, "remoteEntryExports");
        if (container !== own(window, "coworker") || typeof container?.get !== "function") {
            throw error("NATIVE_COWORK_BOOTSTRAP_CONTAINER");
        }
        // This native exposure imports the shared shell and its own dependencies.
        // Loading its factory does not render or execute the Customize component.
        await container.get("./Customize");
        current();
        await own(window, config.toolControl).ensure(container);
        const react = requireNative(loaded.app, 468902);
        const lifetime = makeProviderLifetime();
        const useNativeClient = requireNative(loaded.cowork, 476712).x;
        const initializeConfiguration = requireNative(loaded.cowork, 311439).U;
        const configurationFor = requireNative(loaded.cowork, 857730).V;
        const Root = requireNative(loaded.cowork, 627524).W;
        const Direction = requireNative(loaded.cowork, 605640).F;
        const directionFor = requireNative(loaded.cowork, 731677).XJ;
        const localeFor = requireNative(loaded.cowork, 249155).yk;
        const capabilities = requireNative(loaded.cowork, 175081).H_;
        if ([useNativeClient, initializeConfiguration, configurationFor, Root, Direction, directionFor, localeFor].some(value => typeof value !== "function")
            || !["createElement", "useLayoutEffect", "useRef", "useSyncExternalStore"]
                .every(key => typeof react[key] === "function")
            || typeof capabilities?.getState !== "function" || typeof capabilities?.subscribe !== "function") {
            throw error("NATIVE_COWORK_BOOTSTRAP_REFERENCES");
        }
        const readonly = () => ["isConsented", "isEdgeIdentityMatched", "isSimpleBrowserSupported"]
            .every(key => own(capabilities.getState(), key) === false);
        if (!readonly()) throw error("NATIVE_COWORK_CLIENT_READONLY_UNQUALIFIED");
        const Bridge = props => {
            const configuration = react.useRef(null);
            if (configuration.current === null) configuration.current = configurationFor(props.experienceId);
            initializeConfiguration(configuration.current);
            const { hostType = "unknown", ring = "ww", surface = "app" } = props;
            const native = useNativeClient({ ...props, ownsPageHooks: false,
                geo: props.geo ?? "us", hostType, ring, surface });
            const account = { tenantId: props.tenantId, userId: props.userId, realm: native.realm };
            const client = native.dataSource?.ic3LiveClient ?? null;
            const accountRef = react.useRef(account), clientRef = react.useRef(client), clientListeners = react.useRef(new Set());
            accountRef.current = account;
            clientRef.current = client;
            react.useLayoutEffect(() => {
                for (const listener of clientListeners.current) listener();
            }, [client, own(account, "tenantId"), own(account, "userId"), own(account, "realm")]);
            react.useLayoutEffect(() => {
                let live = true, accepted = false, ownedBinding;
                const bind = () => {
                    queueMicrotask(() => {
                        if (!live || accepted || !operation || !active) return;
                        const client = clientRef.current;
                        if (!client) return;
                        try {
                            operationCurrent();
                            if (seenClients.has(client)) throw error("NATIVE_COWORK_CLIENT_REUSED");
                            ownedBinding = createReadBridge({
                                principal: config.principal, instanceId: crypto.randomUUID(), deadline: operation.deadline,
                                getAccount: () => accountRef.current, getClient: () => clientRef.current,
                                getCapabilities: () => capabilities.getState(),
                                subscribeClient: callback => {
                                    clientListeners.current.add(callback);
                                    return () => clientListeners.current.delete(callback);
                                },
                                subscribeCapabilities: callback => capabilities.subscribe(callback), assertCurrent: operationCurrent,
                                onRetire: reason => { if (active && operation) stop(reason); },
                            });
                            binding = ownedBinding;
                            seenClients.add(client);
                            accepted = true;
                            readyState();
                        } catch (reason) { stop(reason.code ?? "NATIVE_COWORK_BOOTSTRAP_BINDING"); }
                    });
                };
                bind();
                return () => {
                    live = false;
                    ownedBinding?.retire(clientRef.current !== client
                        ? "NATIVE_COWORK_CLIENT_REPLACED" : "NATIVE_COWORK_CLIENT_RETIRED");
                    if (binding === ownedBinding) binding = null;
                    queueMicrotask(() => {
                        if (active && !operation && state === "stopping") state = "idle";
                    });
                };
            }, [client]);
            return null;
        };
        const subscribe = callback => { listeners.add(callback); return () => listeners.delete(callback); };
        const ScopedShell = props => {
            const selected = react.useSyncExternalStore(subscribe, () => operation, () => null);
            if (!selected || !active) return null;
            operationCurrent();
            return react.createElement(Root, null, react.createElement(Direction, {
                initialDirection: props.locale ? directionFor(localeFor(props.locale)) : undefined,
            }, props.children));
        };
        const OwnedShell = props => react.createElement(lifetime.Boundary, null, react.createElement(ScopedShell, props));
        composition = compose({ react, shell: OwnedShell, bridge: Bridge, container,
            principal: config.principal, assertCurrent: current,
            onFailure: reason => stop(reason.code ?? "NATIVE_COWORK_COMPOSITION_FAILED") });
        composition.install(host);
        preparedState();
    };
    let preparing, preparingChat;
    const plugin = {
        name: "wire-cowork-bootstrap-" + documentId,
        apply(candidate) {
            if (candidate.name !== "coworker-host") return {};
            current();
            if (host && host !== candidate || candidate.version !== "2.9.2") throw error("NATIVE_COWORK_BOOTSTRAP_HOST");
            host = candidate;
            return {
                async getModuleFactory(event) {
                    if (own(event, "expose") !== "./Coworker" || own(own(event, "moduleInfo"), "name") !== "coworker") return;
                    try {
                        current();
                        if (own(own(event, "moduleInfo"), "entry") !== config.entry) throw error("NATIVE_COWORK_BOOTSTRAP_SOURCE");
                        preparing ??= prepare(event);
                        await preparing;
                        current();
                        const factory = composition.factoryFor(event);
                        own(window, config.toolControl).acceptReaderFactory(factory);
                        return factory;
                    } catch (reason) {
                        stop(reason.code ?? "NATIVE_COWORK_BOOTSTRAP_FAILED");
                        throw reason;
                    }
                },
            };
        },
    };
    const command = value => {
        current();
        if (value?.documentId !== documentId) throw error("NATIVE_COWORK_BOOTSTRAP_DOCUMENT_CHANGED");
    };
    const control = Object.freeze({
        status() {
            if (chatHost) {
                try { chatHost.assertCurrent(); }
                catch (reason) { stop(reason.code ?? "NATIVE_CHAT_CLIENT_RETIRED"); }
            }
            if (binding) {
                try { binding.assertCurrent(); }
                catch (reason) { stop(reason.code ?? "NATIVE_COWORK_CLIENT_RETIRED"); }
            }
            return { documentId, state, failure, instanceId: binding?.instanceId ?? chatHost?.instanceId ?? null,
                instances: { cowork: binding?.instanceId ?? null, chat: chatHost?.instanceId ?? null },
                toolTransport: own(window, config.toolControl)?.status() ?? null };
        },
        authorize(value) {
            command(value);
            authorized = true;
            if (needsChat) preparingChat ??= prepareChat().catch(reason => stop(reason.code ?? "NATIVE_CHAT_CLIENT_BOOTSTRAP"));
        },
        start(value) {
            command(value);
            if (!authorized || state !== "idle" || operation || binding || !Number.isFinite(value.deadline)
                || value.deadline <= Date.now() || value.deadline > Date.now() + 300000) throw error("NATIVE_COWORK_BOOTSTRAP_OPERATION");
            operation = Object.freeze({ deadline: value.deadline, operationId: value.operationId });
            state = "starting";
            try {
                if (needsChat) chatHost.begin({ deadline: value.deadline, instanceId: crypto.randomUUID() });
                readyState();
                notify();
            } catch (reason) {
                stop(reason.code ?? "NATIVE_CLIENT_BEGIN_FAILED");
                throw reason;
            }
        },
        async invoke(value) {
            command(value);
            operationCurrent();
            const surface = value.surface ?? (needsCowork ? "cowork" : "chat");
            const selected = surface === "cowork" ? binding : surface === "chat" ? chatHost : null;
            if (!surfaces.includes(surface) || state !== "ready" || !selected || value.instanceId !== selected.instanceId
                || value.operationId !== operation.operationId) throw error("NATIVE_COWORK_CLIENT_BINDING_INVALID");
            const invokedOperation = operation;
            try {
                const result = await selected.invoke(value.input);
                operationCurrent();
                if (operation !== invokedOperation) throw error("NATIVE_COWORK_CLIENT_BINDING_INVALID");
                return { ...result, documentId, operationId: invokedOperation.operationId };
            }
            catch (reason) { stop(reason.code ?? "NATIVE_COWORK_CLIENT_READ_FAILED"); throw reason; }
        },
        suspend(value) {
            command(value);
            operation = null;
            binding?.retire();
            binding = null;
            chatHost?.suspend();
            state = needsCowork ? "stopping" : "idle";
            notify();
        },
        retire() { stop("NATIVE_COWORK_BOOTSTRAP_RETIRED"); },
    });
    if (own(window, config.control) !== undefined) throw error("NATIVE_COWORK_BOOTSTRAP_DUPLICATE");
    Object.defineProperty(window, config.control, { value: control, configurable: true });
    if (!needsCowork) {
        if (Object.getOwnPropertyDescriptor(window, "__TSR_ROUTER__")) throw error("NATIVE_PROVIDER_INSTALL_LATE");
        Object.defineProperty(window, "__TSR_ROUTER__", {
            configurable: true, enumerable: true,
            get: () => undefined,
            set(router) {
                Object.defineProperty(window, "__TSR_ROUTER__", { value: router, writable: true, configurable: true, enumerable: true });
                queueMicrotask(() => installChatLifetime(router));
            },
        });
    }
    captureRuntime("rspackChunk_1js_m365_copilot_app", "app");
    if (needsCowork) captureRuntime("chunk_coworker", "cowork");
    const federation = own(window, "__FEDERATION__") ?? (window.__FEDERATION__ = {});
    if (own(federation, "__INSTANCES__")?.length) throw error("NATIVE_COWORK_BOOTSTRAP_LATE");
    const plugins = own(federation, "__GLOBAL_PLUGIN__") ?? (federation.__GLOBAL_PLUGIN__ = []);
    if (!Array.isArray(plugins)) throw error("NATIVE_COWORK_BOOTSTRAP_RUNTIME");
    if (needsCowork) {
        plugins.push(plugin);
    }
    window.addEventListener("pagehide", () => stop("NATIVE_COWORK_BOOTSTRAP_RETIRED"), { once: true });
}
