import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { COWORK_COMPOSITION_ENTRY, COWORK_COMPOSITION_ROOT, createCoworkComposition } from "./microsoft-cowork-composition.mjs";
import { createCoworkReadBridge } from "./microsoft-cowork-read-bridge.mjs";
import { createChatReadHost } from "./microsoft-chat-read-host.mjs";
import { createNativeClientValueCopier } from "./microsoft-native-client-value.mjs";
import { createNativeProviderLifetime } from "./microsoft-native-provider-lifetime.mjs";
import { protectNativeToolTransport } from "./microsoft-native-tool-guard.mjs";
import { installCoworkReadHost } from "./microsoft-cowork-bootstrap.mjs";
import { nativeApplicationEntry } from "./microsoft-native-bootstrap.mjs";
import { UUID } from "./microsoft-session-state.mjs";

export const CHAT_CLIENT_ASSETS = Object.freeze([
    "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/runtime.5b09355d.js",
    "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.d6c807be.js",
    "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.vendors.afde6380.js",
    "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/react.vendors.66726b7f.js",
]);
export const COWORK_CLIENT_ASSETS = Object.freeze([
    ...CHAT_CLIENT_ASSETS,
    "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/257977.8cbd1d2d.chunk.js",
    "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/856401.f55eb6c6.chunk.js",
    COWORK_COMPOSITION_ENTRY,
    COWORK_COMPOSITION_ROOT + "/static/js/async/65531.747fdacc.js",
    COWORK_COMPOSITION_ROOT + "/static/js/async/60537.17c58e3d.js",
    COWORK_COMPOSITION_ROOT + "/static/js/async/69992.fb43aefa.js",
    COWORK_COMPOSITION_ROOT + "/static/js/async/__federation_expose_Customize.a8a52247.js",
    COWORK_COMPOSITION_ROOT + "/static/js/async/64802.6e1308a2.js",
]);

const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeError = reason => Object.assign(new Error("Native Cowork reader stopped."), {
    code: reason?.code && /^NATIVE_[A-Z_]{1,80}$/.test(reason.code) ? reason.code
        : /NATIVE_[A-Z_]{1,80}/.exec(reason?.message ?? "")?.[0] ?? "NATIVE_COWORK_BROWSER_FAILED",
});

export async function openCoworkBrowserHost({ browser, page, principal, assertOwner, assertLease,
    beforeReload, observeDocument, openCowork, deadline, signal, onFailure, surfaces: selectedSurfaces = ["cowork"],
    toolGuard: existingToolGuard }) {
    const surfaces = [...selectedSurfaces].sort();
    if (!surfaces.length || new Set(surfaces).size !== surfaces.length || surfaces.some(value => !["chat", "cowork"].includes(value))) {
        fail("NATIVE_CLIENT_SOURCE_SCOPE");
    }
    const requiredAssets = surfaces.includes("cowork") ? COWORK_CLIENT_ASSETS : CHAT_CLIENT_ASSETS;
    const control = "__wireCoworkReader_" + randomUUID().replaceAll("-", "");
    const retiredBinding = control + "_retired";
    const toolGuard = existingToolGuard ?? await protectNativeToolTransport({ browser, assertOwner, onFailure, deadline, signal });
    const script = `(() => { const COWORK_COMPOSITION_ENTRY=${JSON.stringify(COWORK_COMPOSITION_ENTRY)};
        const createNativeClientValueCopier=${createNativeClientValueCopier.toString()};
        (${installCoworkReadHost.toString()})(${JSON.stringify({
            control, retiredBinding, principal, surfaces, entry: COWORK_COMPOSITION_ENTRY, ownerDeadline: deadline,
            toolControl: toolGuard.control,
        })},${createCoworkComposition.toString()},${createCoworkReadBridge.toString()},${createChatReadHost.toString()},${createNativeProviderLifetime.toString()}); })();`;
    let protocol, observer, currentDocument, currentInstances = {}, operationId, retired = false, readDeadline = deadline, boundLoader = null;
    let capturedOrigin;
    let readSignal = signal, checkLease = assertLease, reported = false, retiredCause = null;
    const assets = new Map(), assetRequests = new Map();
    const report = error => {
        retiredCause ??= error.code;
        if (!reported) { reported = true; onFailure(error); }
    };
    const rejectAssociation = () => {
        const error = safeError({ code: "NATIVE_COWORK_CLIENT_ASSOCIATION" });
        retired = true;
        report(error);
        throw error;
    };
    const current = () => {
        assertOwner();
        toolGuard.assertCurrent();
        if (Date.now() >= readDeadline) fail("NATIVE_COWORK_CLIENT_DEADLINE");
        if (readSignal?.aborted) fail("NATIVE_SOURCE_CANCELLED");
        if (retired || page.isClosed() || browser.pages().length !== 1 || browser.pages()[0] !== page) {
            fail(retiredCause ?? "NATIVE_COWORK_BROWSER_RETIRED");
        }
    };
    const bounded = async work => {
        current();
        let timer, abort;
        const capturedSignal = readSignal;
        const stopped = new Promise((_, reject) => {
            const stop = code => reject(Object.assign(new Error(code), { code }));
            timer = setTimeout(() => stop("NATIVE_COWORK_CLIENT_DEADLINE"), Math.max(0, readDeadline - Date.now()));
            abort = () => stop("NATIVE_SOURCE_CANCELLED");
            capturedSignal?.addEventListener("abort", abort, { once: true });
        });
        try {
            return await Promise.race([(async () => {
                await checkLease();
                current();
                const value = await work();
                current();
                await checkLease();
                current();
                return value;
            })(), stopped]);
        } catch (reason) {
            const error = safeError(reason);
            retired = true;
            report(error);
            throw error;
        } finally {
            clearTimeout(timer);
            capturedSignal?.removeEventListener("abort", abort);
        }
    };
    const call = (method, input = {}) => bounded(() => page.evaluate(({ control, method, input }) => {
        const owner = window[control];
        if (!owner || typeof owner[method] !== "function") throw new Error("NATIVE_COWORK_BOOTSTRAP_UNAVAILABLE");
        return owner[method](input);
    }, { control, method, input }));
    const status = () => call("status");
    const waitFor = async predicate => {
        for (;;) {
            const value = await predicate();
            if (value) return value;
            await bounded(() => delay(25));
        }
    };
    const verifyPrincipal = async () => {
        const proof = await waitFor(() => bounded(() => observer.read(current)));
        if (proof.tenantId !== principal.tenantId || proof.subjectId !== principal.subjectId
            || proof.namespace !== principal.namespace || proof.realm !== principal.realm) {
            fail("NATIVE_COWORK_CLIENT_ACCOUNT_CHANGED");
        }
    };
    const verifyAssets = async () => {
        const { frameTree } = await bounded(() => protocol.send("Page.getFrameTree"));
        const frame = frameTree?.frame;
        if (frame?.id !== observer.frameId || !frame.loaderId || requiredAssets.some(url => {
            const item = assets.get(url);
            return !item || item.loaderId !== frame.loaderId || item.frameId !== frame.id || !item.accepted;
        })) fail("NATIVE_COWORK_BOOTSTRAP_SOURCE_UNQUALIFIED");
        if (boundLoader !== null && frame.loaderId !== boundLoader) fail("NATIVE_COWORK_BOOTSTRAP_DOCUMENT_CHANGED");
        boundLoader = frame.loaderId;
    };
    const navigated = ({ frame }) => {
        if (boundLoader !== null && frame?.id === observer?.frameId && frame.loaderId !== boundLoader) {
            retired = true;
            report(safeError({ code: "NATIVE_COWORK_BOOTSTRAP_DOCUMENT_CHANGED" }));
        }
    };
    const request = event => {
        if (event.type !== "Script" || !requiredAssets.includes(event.request?.url)) return;
        assetRequests.set(event.request.url, { requestId: event.requestId, frameId: event.frameId,
            loaderId: event.loaderId, cached: false });
    };
    const servedFromCache = event => {
        for (const item of assetRequests.values()) if (item.requestId === event.requestId) item.cached = true;
        for (const item of assets.values()) if (item.requestId === event.requestId) {
            item.accepted = false;
            if (boundLoader !== null && item.loaderId === boundLoader) {
                retired = true;
                report(safeError({ code: "NATIVE_COWORK_BOOTSTRAP_SOURCE_UNQUALIFIED" }));
            }
        }
    };
    const response = event => {
        if (event.type !== "Script" || !requiredAssets.includes(event.response?.url)) return;
        const requested = assetRequests.get(event.response.url);
        assets.set(event.response.url, { requestId: event.requestId, frameId: event.frameId, loaderId: event.loaderId,
            accepted: requested !== undefined && requested.requestId === event.requestId && requested.frameId === event.frameId
                && requested.loaderId === event.loaderId && !requested.cached
                && event.response.status === 200 && !event.response.fromDiskCache
                && !event.response.fromServiceWorker && !event.response.fromPrefetchCache });
    };
    try {
        await bounded(() => page.goto("about:blank", { waitUntil: "load" }));
        await bounded(beforeReload);
        await bounded(() => browser.exposeBinding(retiredBinding, (source, value) => {
            if (source.page !== page || source.frame !== page.mainFrame()
                || value?.documentId !== currentDocument || typeof value.code !== "string"
                || !/^NATIVE_[A-Z_]{1,80}$/.test(value.code)) return { acknowledged: false };
            if (page.isClosed()) return { acknowledged: true };
            if (boundLoader === null && value.code === "NATIVE_COWORK_BOOTSTRAP_RETIRED") return { acknowledged: true };
            if (!retired) {
                retired = true;
                report(safeError({ code: value.code }));
            }
            return { acknowledged: true };
        }));
        await bounded(() => browser.addInitScript({ content: script }));
        protocol = await bounded(() => browser.newCDPSession(page));
        protocol.on("Network.requestWillBeSent", request);
        protocol.on("Network.requestServedFromCache", servedFromCache);
        protocol.on("Network.responseReceived", response);
        protocol.on("Page.frameNavigated", navigated);
        observer = await bounded(() => observeDocument(page, protocol, deadline));
        await bounded(() => protocol.send("Network.setCacheDisabled", { cacheDisabled: true }));
        await bounded(() => page.goto(nativeApplicationEntry, { waitUntil: "domcontentloaded" }));
        await verifyPrincipal();
        let observed = await status();
        currentDocument = observed.documentId;
        await call("authorize", { documentId: currentDocument });
        if (surfaces.includes("cowork")) await bounded(openCowork);
        await waitFor(async () => {
            const value = await status();
            if (value.documentId !== currentDocument) {
                await verifyPrincipal();
                currentDocument = value.documentId;
                await call("authorize", { documentId: currentDocument });
            }
            if (value.state === "failed") fail(value.failure ?? "NATIVE_COWORK_BOOTSTRAP_FAILED");
            return value.state === "idle";
        });
        await verifyAssets();
        capturedOrigin = new URL(page.url()).origin;
        await bounded(() => observer.retire());
    } catch (reason) {
        const error = safeError(reason);
        retired = true;
        report(error);
        protocol?.off("Network.requestWillBeSent", request);
        protocol?.off("Network.requestServedFromCache", servedFromCache);
        protocol?.off("Network.responseReceived", response);
        protocol?.off("Page.frameNavigated", navigated);
        throw error;
    }
    const cancel = async () => {
        retired = true;
        if (page.isClosed()) return;
        try { await page.evaluate(control => window[control]?.retire(), control); }
        catch (reason) { if (!page.isClosed()) throw safeError(reason); }
    };
    const reader = {
        get origin() { return capturedOrigin; },
        get instanceId() { return currentInstances[surfaces[0]] ?? null; },
        get surfaces() { return [...surfaces]; },
        get documentId() { return currentDocument; },
        get operationId() { return operationId; },
        async assertCurrent(surface = surfaces[0]) {
            if (!surfaces.includes(surface)) fail("NATIVE_CLIENT_SOURCE_SCOPE");
            const value = await status();
            if (value.documentId !== currentDocument || value.instances?.[surface] !== currentInstances[surface] || value.state !== "ready") {
                rejectAssociation();
            }
        },
        async begin(nextDeadline, scope = {}) {
            if (scope.signal) readSignal = scope.signal;
            if (scope.assertLease) checkLease = scope.assertLease;
            readDeadline = nextDeadline;
            if (scope.operationId !== undefined && (typeof scope.operationId !== "string"
                || !UUID.test(scope.operationId))) fail("NATIVE_COWORK_CLIENT_OPERATION_UNQUALIFIED");
            operationId = scope.operationId ?? randomUUID();
            await call("start", { documentId: currentDocument, operationId, deadline: nextDeadline });
            const ready = await waitFor(async () => {
                const value = await status();
                if (value.documentId !== currentDocument) fail("NATIVE_COWORK_BOOTSTRAP_DOCUMENT_CHANGED");
                if (value.state === "failed") fail(value.failure ?? "NATIVE_COWORK_BOOTSTRAP_FAILED");
                return value.state === "ready" && surfaces.every(surface => typeof value.instances?.[surface] === "string"
                    && UUID.test(value.instances[surface])) ? value : null;
            });
            currentInstances = ready.instances;
            await verifyAssets();
        },
        async read(method, args, surface = surfaces[0]) {
            if (!surfaces.includes(surface)) fail("NATIVE_CLIENT_SOURCE_SCOPE");
            const instanceId = currentInstances[surface];
            const invocationId = randomUUID();
            const input = { invocationId, method, arguments: args };
            const result = await call("invoke", { documentId: currentDocument, operationId, instanceId, surface, input });
            if (result?.instanceId !== instanceId || result.invocationId !== invocationId
                || result.documentId !== currentDocument || result.operationId !== operationId
                || result.method !== method || JSON.stringify(result.arguments) !== JSON.stringify(args)) {
                rejectAssociation();
            }
            const observed = await status();
            if (observed.documentId !== currentDocument || observed.instances?.[surface] !== instanceId || observed.state !== "ready") {
                rejectAssociation();
            }
            return result;
        },
        async finish() {
            await call("suspend", { documentId: currentDocument });
            await waitFor(async () => {
                const value = await status();
                if (value.documentId !== currentDocument || value.state === "failed") fail("NATIVE_COWORK_BROWSER_RETIRED");
                return value.state === "idle";
            });
            currentInstances = {};
        },
        forSurface(surface) {
            if (!surfaces.includes(surface)) fail("NATIVE_CLIENT_SOURCE_SCOPE");
            return Object.freeze({
                get origin() { return capturedOrigin; },
                get instanceId() { return currentInstances[surface] ?? null; },
                get documentId() { return currentDocument; },
                get operationId() { return operationId; },
                read: (method, args) => reader.read(method, args, surface),
                assertCurrent: () => reader.assertCurrent(surface),
            });
        },
        cancel,
        async retire() {
            await cancel();
            // The execution fence remains context-owned through this handoff.
            if (!page.isClosed()) await new Promise(resolve => page.once("close", resolve));
            if (!existingToolGuard) await toolGuard.retire();
            protocol.off("Network.requestWillBeSent", request);
            protocol.off("Network.requestServedFromCache", servedFromCache);
            protocol.off("Network.responseReceived", response);
            protocol.off("Page.frameNavigated", navigated);
            try { await protocol.detach(); }
            catch (reason) { if (!page.isClosed()) throw safeError(reason); }
        },
    };
    return Object.freeze(reader);
}

export const openMicrosoftSessionBrowserHost = openCoworkBrowserHost;
