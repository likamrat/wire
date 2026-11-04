export const COWORK_COMPOSITION_ROOT = "https://res.cdn.office.net/s01-copilotstudio/cowork/v/20261101.72.0-6507b83d";
export const COWORK_COMPOSITION_MANIFEST = COWORK_COMPOSITION_ROOT + "/coworker-manifest.json";
export const COWORK_COMPOSITION_ENTRY = COWORK_COMPOSITION_ROOT + "/coworker.8d98ec00.js";

// Runs inside the owned native realm. Provider props and component references
// stay there; this module neither reads credentials nor constructs a React root.
export function createCoworkComposition({ react, shell, bridge, container, principal, assertCurrent, onFailure }) {
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    const own = (object, key) => {
        const descriptor = object && Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor) return undefined;
        if (!Object.hasOwn(descriptor, "value")) fail("NATIVE_COWORK_COMPOSITION_ACCESSOR");
        return descriptor.value;
    };
    if (typeof react?.createElement !== "function" || typeof shell !== "function"
        || typeof bridge !== "function" || typeof assertCurrent !== "function"
        || onFailure !== undefined && typeof onFailure !== "function"
        || !container || typeof container !== "object"
        || principal?.namespace !== "m365.accountInfo.objectId" || principal.realm !== "prod"
        || !["tenantId", "subjectId"].every(key => typeof principal[key] === "string" && principal[key].length > 0)) {
        fail("NATIVE_COWORK_COMPOSITION_INVALID");
    }
    const account = Object.freeze({ tenantId: principal.tenantId, subjectId: principal.subjectId });
    let retired = false, installed = false, selected = false, factoryUsed = false;
    const current = () => {
        if (retired) fail("NATIVE_COWORK_COMPOSITION_RETIRED");
        const result = assertCurrent();
        if (result !== undefined) {
            if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
            fail("NATIVE_COWORK_COMPOSITION_GUARD");
        }
    };
    const ReadHost = props => {
        try {
            current();
            if (!installed || !factoryUsed || own(props, "tenantId") !== account.tenantId
                || own(props, "userId") !== account.subjectId
                || own(props, "overrideRealm") !== undefined && own(props, "overrideRealm") !== "prod") {
                fail("NATIVE_COWORK_COMPOSITION_ACCOUNT");
            }
            // Microsoft's existing parent supplies the original provider props.
            const child = react.createElement(bridge, props);
            const result = react.createElement(shell, props, child);
            current();
            return result;
        } catch (error) {
            const notify = !retired;
            retired = true;
            if (notify) onFailure?.(error);
            throw error;
        }
    };
    const factory = () => {
        current();
        if (!installed || !selected) fail("NATIVE_COWORK_COMPOSITION_UNSELECTED");
        factoryUsed = true;
        return { FederatedCoworker: ReadHost, HOST_LAUNCH_CONTRACT_VERSION: 1 };
    };
    const plugin = Object.freeze({
        name: "wire-cowork-read-composition",
        getModuleFactory(event) {
            if (own(event, "expose") !== "./Coworker" || own(own(event, "moduleInfo"), "name") !== "coworker") return;
            current();
            if (!installed || own(event, "remoteEntryExports") !== container
                || own(own(event, "moduleInfo"), "entry") !== COWORK_COMPOSITION_ENTRY) {
                fail("NATIVE_COWORK_COMPOSITION_SOURCE");
            }
            selected = true;
            return factory;
        },
    });
    return Object.freeze({
        install(host) {
            current();
            if (installed || host?.name !== "coworker-host" || host.version !== "2.9.2"
                || typeof host.loaderHook?.applyPlugin !== "function"
                || !host.loaderHook.registerPlugins || Object.hasOwn(host.loaderHook.registerPlugins, plugin.name)) {
                fail("NATIVE_COWORK_COMPOSITION_HOST");
            }
            // A failed installation is not retried under the same composition.
            installed = true;
            try {
                host.loaderHook.applyPlugin(plugin);
                current();
            }
            catch (error) { retired = true; throw error; }
        },
        factoryFor: plugin.getModuleFactory,
        retire() {
            retired = true;
            // Keep the target factory fenced until owned-context close. Removing
            // it while live would let a subsequent load mount the normal app.
        },
    });
}
