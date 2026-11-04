// Serialized into the shell; source status never activates a collection mode.
export function createSourceCollectionState({ bootstrap, collectionStatus, createNativeConfigurationState }) {
    const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
    const controlsActive = Boolean(bootstrap && Object.hasOwn(bootstrap, "collectionMode"));
    const copilotOnly = bootstrap?.collectionMode === "copilot-only";
    const active = controlsActive && !copilotOnly;
    const validBootstrap = exact(bootstrap, ["schemaVersion", "mode", "runtimeId", "maxWaitMs", "freshnessMs", "collectionMode"])
        && bootstrap.schemaVersion === 1 && bootstrap.mode === "enforced" && ["source-aware", "copilot-only"].includes(bootstrap.collectionMode)
        && uuid(bootstrap.runtimeId)
        && bootstrap.maxWaitMs === 1000 && bootstrap.freshnessMs === 5000;
    const unavailable = () => new TypeError("Source-aware collection status is unavailable or invalid. Read current Settings; no action was started.");
    const revision = value => Number.isSafeInteger(value) && value >= 0;
    const positive = value => revision(value) && value > 0;
    const actions = (value, allowed) => Array.isArray(value) && new Set(value).size === value.length
        && value.every(action => allowed.includes(action));
    const offers = createNativeConfigurationState();
    let latest = null, highWater = null, runtimeId = bootstrap?.runtimeId;
    const retired = new Set();
    function decode(value) {
        if (!exact(value, ["schemaVersion", "kind", "generation", "authorizationRevision", "global", "github", ...(copilotOnly ? [] : ["microsoft"])])
            || value.schemaVersion !== 1 || value.kind !== "source-aware-collection"
            || !revision(value.generation) || !revision(value.authorizationRevision)
            || !exact(value.github, ["status", "actions"])
            || !copilotOnly && !exact(value.microsoft, ["status", "configurationOffer", "actions"])) throw unavailable();
        const global = value.global, github = value.github.status;
        if (!actions(global?.actions, ["pause", "resume"])
            || !(exact(global, ["state", "revision", "actions"]) && global.state === "legacy-compatible" && global.revision === null
                || exact(global, ["state", "revision", "paused", "actions"]) && global.state === "committed"
                    && positive(global.revision) && typeof global.paused === "boolean"
                    && global.actions.every(action => action === (global.paused ? "resume" : "pause")))
            || !github || typeof github !== "object" || Array.isArray(github)
            || !["stopped", "disconnected", "error", "collecting", "collecting-on-interval", "paused"].includes(github.state)
            || typeof github.connected !== "boolean" || !revision(github.revision)
            || !revision(github.deletionVersion) || !revision(github.artifactRevision)
            || !(github.config === null && github.configVersion === null
                || github.config?.approved === true && typeof github.config.enabled === "boolean"
                    && [7, 30, 90].includes(github.config.windowDays) && [5, 15, 30, 60].includes(github.config.pollSeconds)
                    && typeof github.config.appDbPath === "string" && typeof github.config.sessionRoot === "string"
                    && typeof github.configVersion === "string" && /^[a-f0-9]{64}$/.test(github.configVersion))
            || ["sourceAware", "nativeControl", "nativePersistence", "nativeConfigurationOffer"].some(key => Object.hasOwn(github, key))
            || !actions(value.github.actions, ["configure", "collect-now", "set-interval"])
            || value.github.actions.some(action => action !== "configure" && github.config?.approved !== true)
            || !copilotOnly && !actions(value.microsoft.actions, ["configure", "collect-now", "pause", "resume"])) throw unavailable();
        if (copilotOnly) return structuredClone(value);
        const wrapper = { nativePersistence: value.microsoft.status };
        const native = collectionStatus.nativeUnavailable(wrapper) ?? collectionStatus.persistence(wrapper);
        const offer = offers.decode(value.microsoft.configurationOffer);
        if (!native || native.generation !== value.generation
            || native.kind === "native-account-unavailable" && native.authorizationRevision !== value.authorizationRevision
            || offer.schemaVersion !== 2 || offer.generation !== value.generation
            || offer.authorizationRevision !== value.authorizationRevision || offer.globalRevision !== global.revision
            || offer.expectedRevision !== (native.configuration?.configurationRevision ?? null)
            || offer.intent !== (native.configured ? "save" : "enable")
            || native.configuration && (offer.values.windowDays !== native.configuration.settings.windowDays
                || JSON.stringify([...offer.values.surfaces].sort()) !== JSON.stringify([...native.configuration.surfaces].sort()))
            || Boolean(offer.available) !== value.microsoft.actions.includes("configure")
            || native.actions.includes("collect-now") !== value.microsoft.actions.includes("collect-now")
            || value.microsoft.actions.includes("pause") && value.microsoft.actions.includes("resume")
            || value.microsoft.actions.includes("resume") && !native.configured
            || global.state === "committed" && global.paused && value.microsoft.actions.includes("collect-now")) throw unavailable();
        return structuredClone(value);
    }
    const validAccess = observed => Boolean(validBootstrap && observed?.readable
        && observed.mode === "enforced" && observed.collectionMode === bootstrap.collectionMode
        && uuid(observed.runtimeId) && revision(observed.state?.generation)
        && revision(observed.state?.authorizationRevision));
    const matches = observed => Boolean(validAccess(observed) && observed.runtimeId === runtimeId && latest
        && latest.generation === observed.state.generation && latest.authorizationRevision >= observed.state.authorizationRevision);
    return {
        active, controlsActive, copilotOnly,
        decode,
        receive(value, observed) {
            latest = null;
            if (!controlsActive || !validBootstrap) throw unavailable();
            const next = decode(value);
            if (!validAccess(observed) || retired.has(observed.runtimeId)
                || next.generation !== observed.state.generation || next.authorizationRevision < observed.state.authorizationRevision) throw unavailable();
            if (observed.runtimeId !== runtimeId) {
                retired.add(runtimeId); runtimeId = observed.runtimeId; highWater = null;
            }
            if (highWater && (next.generation < highWater.generation
                || next.authorizationRevision < highWater.authorizationRevision
                || next.generation === highWater.generation && ((next.microsoft?.status.revision ?? 0) < highWater.nativeRevision
                    || next.github.status.revision < highWater.githubRevision
                    || (next.global.revision ?? 0) < highWater.globalRevision))) throw unavailable();
            latest = next;
            if (!matches(observed)) { latest = null; throw unavailable(); }
            highWater = { generation: next.generation, authorizationRevision: next.authorizationRevision,
                nativeRevision: next.microsoft?.status.revision ?? 0, githubRevision: next.github.status.revision,
                globalRevision: next.global.revision ?? 0 };
        },
        withdraw() { latest = null; },
        authorize(endpoint, input, observed) {
            if (!matches(observed)) { latest = null; throw unavailable(); }
            if (copilotOnly && endpoint.startsWith("/api/collection/microsoft/")) throw unavailable();
            let valid = false;
            if (endpoint === "/api/collection/global/enabled") {
                valid = exact(input, ["schemaVersion", "enabled", "generation", "authorizationRevision", "expectedRevision"])
                    && input.schemaVersion === 1 && typeof input.enabled === "boolean"
                    && input.generation === latest.generation && input.authorizationRevision === latest.authorizationRevision
                    && input.expectedRevision === latest.global.revision
                    && latest.global.actions.includes(input.enabled ? "resume" : "pause");
            } else if (endpoint === "/api/collection/microsoft/configure") {
                const offer = latest.microsoft.configurationOffer;
                valid = exact(input, ["schemaVersion", "intent", "generation", "authorizationRevision", "globalRevision",
                    "expectedRevision", "surfaces", "windowDays"])
                    && ["schemaVersion", "intent", "generation", "authorizationRevision", "globalRevision", "expectedRevision"]
                        .every(key => input[key] === offer[key])
                    && latest.microsoft.actions.includes("configure")
                    && Array.isArray(input.surfaces) && input.surfaces.length > 0
                    && new Set(input.surfaces).size === input.surfaces.length
                    && input.surfaces.every(surface => offer.supportedSurfaces.includes(surface))
                    && positive(input.windowDays) && input.windowDays <= 90;
            } else if (endpoint === "/api/collection/microsoft/enabled") {
                valid = exact(input, ["enabled", "expectedNativeRevision"]) && typeof input.enabled === "boolean"
                    && input.expectedNativeRevision === latest.authorizationRevision
                    && latest.microsoft.actions.includes(input.enabled ? "resume" : "pause");
            } else if (endpoint === "/api/collection/microsoft/now") {
                const hasBasis = input && Object.hasOwn(input, "expectedBasis"), basis = input?.expectedBasis;
                const hasDeadline = input && Object.hasOwn(input, "deadline");
                const native = latest.microsoft.status;
                valid = exact(input, ["operationId", ...(hasBasis ? ["expectedBasis"] : []), ...(hasDeadline ? ["deadline"] : [])]) && uuid(input.operationId)
                    && (!hasDeadline || Number.isSafeInteger(input.deadline) && input.deadline > Date.now()
                        && input.deadline <= Date.now() + 300000)
                    && latest.microsoft.actions.includes("collect-now") && (!hasBasis
                        || exact(basis, ["generation", "accountRef", "configurationRevision", "privacyRevision", "globalRevision"])
                            && basis.generation === latest.generation && basis.accountRef === native.accountRef
                            && basis.configurationRevision === native.configuration?.configurationRevision
                            && basis.privacyRevision === native.configuration?.privacyRevision && basis.globalRevision === latest.global.revision);
            } else if (endpoint === "/api/collection/now") {
                const hasBasis = input && Object.hasOwn(input, "expectedBasis"), basis = input?.expectedBasis;
                valid = exact(input, hasBasis ? ["expectedBasis"] : []) && latest.github.actions.includes("collect-now")
                    && (!hasBasis || exact(basis, ["generation", "configVersion"])
                        && basis.generation === latest.generation && basis.configVersion === latest.github.status.configVersion);
            } else if (endpoint === "/api/collection/enabled") {
                valid = exact(input, ["enabled", "expectedConfigVersion"]) && typeof input.enabled === "boolean"
                    && input.expectedConfigVersion === latest.github.status.configVersion
                    && latest.github.actions.includes("set-interval");
            } else if (endpoint === "/api/collection/configure") {
                valid = exact(input, ["appDbPath", "sessionRoot", "approved", "enabled", "windowDays", "pollSeconds", "expectedConfigVersion"])
                    && input.expectedConfigVersion === latest.github.status.configVersion
                    && input.approved === true && typeof input.enabled === "boolean"
                    && typeof input.appDbPath === "string" && typeof input.sessionRoot === "string"
                    && [7, 30, 90].includes(input.windowDays) && [5, 15, 30, 60].includes(input.pollSeconds)
                    && latest.github.actions.includes("configure");
            }
            if (!valid) throw unavailable();
        },
        view(observed) {
            const current = matches(observed);
            if (!current) latest = null;
            return { current, status: current ? structuredClone(latest) : null,
                actions: current ? { global: [...latest.global.actions], github: [...latest.github.actions],
                    microsoft: [...latest.microsoft?.actions ?? []] } : { global: [], github: [], microsoft: [] } };
        },
    };
}
