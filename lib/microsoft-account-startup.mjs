// Runs only in an eligible original app realm. No fetch, bindings, auth bodies,
// history projection or provider calls. The host independently grants proof.
export function installNativeAccountStartup(control, deadline, readAccount) {
    if (window.top !== window || !["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(location.origin)
        || !["/", "/home", "/chat", "/chat/work", "/hwav2/chat", "/landingv2", "/spalanding"].includes(location.pathname)) return;
    const restorations = new Set(), watches = new Set();
    let retired = false, retirementComplete = true, timer = null, staged = null, consistency = null, rejected = false;
    let status = { state: "bootstrap-unavailable", branch: "tanstack", projected: null };
    const invalid = () => {
        rejected = true; staged = null;
        status = { state: "invalid", branch: "unobserved", projected: null };
    };
    const unexpired = () => {
        if (retired) return false;
        if (Date.now() < deadline) return true;
        retire();
        return false;
    };
    const sample = () => {
        if (!unexpired() || rejected) return;
        try {
            const pending = (target, key) => [...watches].some(item => item.target === target && item.key === key
                && Object.getOwnPropertyDescriptor(target, key)?.get === item.get);
            const selected = Object.getOwnPropertyDescriptor(window, "__backgroundSSR");
            if (selected && !Object.hasOwn(selected, "value")) { invalid(); return; }
            if (selected?.value !== undefined && typeof selected.value !== "boolean") { invalid(); return; }
            const background = selected?.value === true;
            if (consistency && consistency.branch !== (background ? "background-loader" : "tanstack")) { invalid(); return; }
            const root = background ? null : Object.getOwnPropertyDescriptor(window, "$_TSR");
            if (background ? pending(window, "__backgroundLoaderData") : pending(window, "$_TSR")
                || root && Object.hasOwn(root, "value") && root.value && pending(root.value, "initialized")) {
                if (!staged) status = { state: background ? "bootstrap-loader-unavailable"
                    : root && Object.hasOwn(root, "value") ? "bootstrap-uninitialized" : "bootstrap-unavailable",
                branch: background ? "background-loader" : "tanstack", projected: null };
                return;
            }
            const value = readAccount(true);
            if (!unexpired()) return;
            if (consistency && value.branch !== consistency.branch) { invalid(); return; }
            if (value.state !== "available") {
                if (value.state !== "bootstrap-unavailable") staged = null;
                if (!staged) status = value;
                return;
            }
            const account = value.projected.store.accountInfo;
            // Missing startup placeholders are not an account or a refusal.
            if (!["AAD", "MSA"].includes(account.accountType) || account.accountType === "AAD"
                && (!account.tenantId || !account.objectId || !account.environment)) {
                staged = null;
                status = { state: "account-unavailable", branch: value.branch, projected: null };
                return;
            }
            const accountKey = JSON.stringify(account), label = value.projected.store.identity?.userPrincipalName;
            if (consistency) {
                if (consistency.accountKey !== accountKey
                    || consistency.label && label && consistency.label.toLowerCase() !== label.toLowerCase()) {
                    invalid(); return;
                }
                if (label) consistency.label = label;
            } else {
                consistency = { branch: value.branch, accountKey, label };
            }
            staged = value; status = value;
        } catch { invalid(); }
    };
    const retire = () => {
        if (retired) return retirementComplete;
        retired = true;
        clearTimeout(timer);
        window.removeEventListener("pagehide", retire);
        document.removeEventListener("DOMContentLoaded", sample);
        for (const restore of restorations) {
            try { restore(); } catch {
                retirementComplete = false;
                console.error("WIRE_ACCOUNT_STARTUP_RETIRE_FAILED");
            }
        }
        restorations.clear(); watches.clear(); staged = null; consistency = null;
        status = { state: "retired", branch: "unobserved", projected: null };
        delete window[control];
        return retirementComplete;
    };
    // Observe writable data assignment once, restoring the native descriptor
    // before sampling. Accessors/readonly fields are never invoked or replaced.
    const watch = (target, key, assigned, onceTrue = false) => {
        const original = Object.getOwnPropertyDescriptor(target, key);
        if (original && (!Object.hasOwn(original, "value") || !original.configurable || !original.writable)) return;
        if (!original && !Object.isExtensible(target)) return;
        let value = original?.value, written = false;
        const restore = () => {
            const current = Object.getOwnPropertyDescriptor(target, key);
            if (current?.get !== get || current.set !== set) return;
            if (!original && !written) delete target[key];
            else Object.defineProperty(target, key, { configurable: true, enumerable: original?.enumerable ?? true,
                writable: original?.writable ?? true, value });
        };
        const get = () => value;
        const set = next => {
            value = next; written = true;
            if (!unexpired()) return;
            if (onceTrue && next !== true) return;
            try {
                restore(); restorations.delete(restore); watches.delete(entry);
                assigned(next);
            } catch { invalid(); }
        };
        Object.defineProperty(target, key, { configurable: true, enumerable: original?.enumerable ?? true, get, set });
        const entry = { target, key, get };
        watches.add(entry);
        restorations.add(restore);
    };
    const transport = value => {
        if (!unexpired()) return;
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const descriptor = Object.getOwnPropertyDescriptor(value, "initialized");
        if (descriptor && !Object.hasOwn(descriptor, "value")) { invalid(); return; }
        if (descriptor?.value === true) sample();
        else watch(value, "initialized", sample, true);
    };
    const tick = () => {
        if (!unexpired()) return;
        sample();
        if (!retired) timer = setTimeout(tick, Math.min(100, deadline - Date.now()));
    };
    try {
        if (!unexpired()) return;
        Object.defineProperty(window, control, { configurable: true, value: {
            read() { sample(); return status; },
            retire,
        } });
        window.addEventListener("pagehide", retire, { once: true });
        document.addEventListener("DOMContentLoaded", sample, { once: true });
        const selector = Object.getOwnPropertyDescriptor(window, "__backgroundSSR");
        if (selector && !Object.hasOwn(selector, "value")) invalid();
        else {
            const existing = Object.getOwnPropertyDescriptor(window, "$_TSR");
            if (selector?.value !== true) {
                if (existing) {
                    if (Object.hasOwn(existing, "value")) transport(existing.value);
                    else invalid();
                } else watch(window, "$_TSR", value => {
                    const selected = Object.getOwnPropertyDescriptor(window, "__backgroundSSR");
                    if (selected && !Object.hasOwn(selected, "value")) { invalid(); return; }
                    if (selected?.value !== true) transport(value);
                });
            }
            if (!Object.hasOwn(window, "__backgroundLoaderData")) watch(window, "__backgroundLoaderData", sample);
            if (!Object.hasOwn(window, "__m365TanstackClientBooted")) watch(window, "__m365TanstackClientBooted", sample, true);
        }
        tick();
    } catch {
        invalid();
        console.error("WIRE_ACCOUNT_STARTUP_OBSERVATION_FAILED");
    }
}
