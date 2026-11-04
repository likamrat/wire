import { open, readFile, realpath, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AsyncResource } from "node:async_hooks";
import { setTimeout as delay, setImmediate } from "node:timers/promises";
import path from "node:path";
import { chromium } from "playwright";
import { BoardError, exclusiveBoard } from "./store.mjs";
import { activityDeletionVersion } from "./deletion-identities.mjs";
import { isMicrosoftNativeConfiguration, isMicrosoftNativeEnrollmentPolicy, prepareMicrosoftNativeConfiguration } from "./microsoft-native-configuration.mjs";
import { createMicrosoftNativeReadTransport } from "./microsoft-native-transport.mjs";
import { createMicrosoftNativeRequestObserver } from "./microsoft-native-request-observer.mjs";
import { createMicrosoftSession, MicrosoftSessionError } from "./microsoft-session.mjs";
import { nativeFailureDetails, withNativeFailurePredicate, withNativeFailureAdmission,
    withNativeFailureProtocolStop, NATIVE_PROTOCOL_STOP_REASONS } from "./microsoft-session-state.mjs";
import { attachNativeBackfill, createNativeBackfill, createNativeHistoryObservation, validateNativeHistoryObservation, NATIVE_BACKFILL_LIMIT } from "./native-backfill-state.mjs";
import { isHistoryEngineering, historyEngineeringAssets, runHistoryEngineeringSteps,
    withHistoryEngineeringStartup, inheritHistoryEngineeringStartup, validateHistoryContextStructure } from "./microsoft-history-engineering.mjs";
import { createHistoryEngineeringProjection, installHistoryEngineeringCapture } from "./microsoft-history-engineering-projection.mjs";
import { createNativeRuntimeAccess } from "./runtime-access.mjs";
import { createNativePersistence, readNativeCollectionSettings, readGlobalCollectionGate } from "./native-persistence.mjs";
import { collectBootstrapUIMetadata, nativeSignInControl, knownAccountControl, nativeApplicationEntry,
    nativeHistoryProducer, nativeApplicationBuilds, nativeCoworkBuilds, nativeCachedSessionBindings, clickNativeHistoryLink, nativeHistoryEntry, readNativeHistoryView, nativeBootstrapRouteEvidence, nativeAuthScriptEvidence,
    presentNativeSignInHandoff, nativeBootstrapDestinationLabels, revealNativeOlderMessages,
    readNativeAccountMetadata, projectNativeBootstrapHistory, openNativeCoworkAutomations, openNativeCoworkParent,
    revealNativeCoworkRuns, openNativeCoworkConversation } from "./microsoft-native-bootstrap.mjs";
import { installNativeChatCapture, classifyNativeHistoryRequest, projectNativeSourceResponse, projectNativeCoworkListRequest,
    nativeHistoryWindow, nativeHistoryActivity, compareNativeIdentityHeaders, compareNativeReadHeaders, sourceProjection } from "./microsoft-chat-capture.mjs";
import { decodeNativeChatObservation } from "./native-chat-source.mjs";
import { installNativeAccountStartup } from "./microsoft-account-startup.mjs";
import { COWORK_MEMBERSHIP_KINDS, projectCoworkMembership, coworkParentReferences } from "./native-cowork-membership.mjs";
import { retainNativeChatSourceObservations } from "./native-read-model.mjs";
import { adaptCoworkSourceRecordsWithResultFacts,
    COWORK_RESULT_ADAPTER_VERSION, COWORK_MATCHED_RESULT_ADAPTER_VERSION } from "./cowork-source-adapter.mjs";
import { openMicrosoftSessionBrowserHost } from "./microsoft-cowork-browser.mjs";
import { acquireMicrosoftSession } from "./microsoft-session-acquisition.mjs";
import { protectNativeToolTransport } from "./microsoft-native-tool-guard.mjs";

const runFile = promisify(execFile);
const origin = "https://copilot.cloud.microsoft";
const accountAppOrigins = new Set([origin, "https://m365.cloud.microsoft"]);
const accountAuthOrigins = new Set(["https://login.microsoftonline.com", "https://login.microsoft.com", "https://autologon.microsoftazuread-sso.com"]);
const maximumBytes = 12 * 1024 * 1024;
const nativeRequestOriginLimit = 512;
const nativeResponseErrors = new Set(["Failed", "Aborted", "TimedOut", "AccessDenied", "ConnectionClosed", "ConnectionReset",
    "ConnectionRefused", "ConnectionAborted", "ConnectionFailed", "NameNotResolved", "InternetDisconnected",
    "AddressUnreachable", "BlockedByClient", "BlockedByResponse"]);
const deviceRiskLimits = Object.freeze({ requests: 24, posts: 8, responseBytes: 2 * 1024 * 1024,
    totalResponseBytes: 12 * 1024 * 1024, requestMs: 15000, urlLength: 16384 });
// Attended allowance for two reviewed documents: six event attempts plus two unload attempts each, never reset per document.
export const nativeTelemetryAttemptLimits = Object.freeze({ unattended: 6, attended: 16 });
const accountSelfUrl = "https://graph.microsoft.com/v1.0/me";
const accountSelfFields = new Set(["id", "displayName", "givenName", "surname", "mail", "userPrincipalName",
    "preferredLanguage", "businessPhones", "jobTitle", "mobilePhone", "officeLocation"]);
const accountPages = new Set(["/", "/home", "/login", "/landingv2", "/spalanding"]);
const accountPathSegments = new Set(["api", "v1", "v1.0", "beta", "me", "user", "users", "account", "accounts",
    "profile", "profiles", "userinfo", "self", "identity", "bootstrap", "tenant", "tenants", "organization", "organizations", "settings",
    "routing", "common", "oauth2", "v2.0", "authorize", "token"]);
const hash = value => createHash("sha256").update(value).digest("hex");
const sourceSlot = (kind, count) => count === 1 ? kind : count === 2 ? kind + "-next" : kind + "-page-" + count;
const incidentalScriptLimit = 32, staticOriginWitnessLimit = 64;
function nativeDocumentScript(document, url, originals) {
    const required = document?.scripts?.get(url);
    if (required) return required.ambiguous ? null : required;
    // Reuse bounded original records for caller evidence beyond the partial diagnostic sample.
    const matches = originals ? [...originals.values()].filter(row => row.url === url
        && row.scriptResponse?.document === document && row.original && !row.duplicate) : [];
    if (matches.length) return matches.length === 1 && !matches[0].scriptResponse.ambiguous ? matches[0].scriptResponse : null;
    const record = document?.incidentalScripts?.get(url);
    return record?.ambiguous ? null : record;
}
const gateway = url => /^https:\/\/(?:cowork\.us-ia888|mcsaetherruntime-eus2\.us-ia302)\.gateway\.prod\.island\.powerapps\.com$/.test(url.origin);
const presentationTypes = new Set(["image", "font", "stylesheet"]);
const nativeAuthImageOrigins = new Set(["https://aadcdn.msauthimages.net", "https://aadcdn.msftauthimages.net"]);
const preservedTransportKind = kind => ["bootstrap-health-transport", "static-presentation-transport"].includes(kind);
const safeCode = error => /^NATIVE_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "NATIVE_SOURCE_READ_FAILED";
const nativeErrorCode = error => error instanceof MicrosoftSessionError ? error.code : safeCode(error);
const nativeStopRecorded = scope => Boolean(scope?.error || scope?.terminalOutcome || scope?.releaseTask
    || scope?.abort.signal.aborted || scope?.operationSignal?.aborted);
export function recordNativeHostFailure(scope, error) {
    if (!scope) return false;
    if (nativeStopRecorded(scope)) {
        if (scope.error !== error) scope.afterStopFailure ??= nativeErrorCode(error);
        return false;
    }
    scope.error = error;
    return true;
}
export function unavailableNativeRequestEvidence(facts) {
    if (!facts) return { available: false, reason: "no-fetch-event-examined" };
    if (!facts.networkId) return { available: false, reason: "fetch-network-id-missing" };
    return null;
}
export const nativeHeadfulHostReady = Object.freeze({
    state: "host-ready", display: "headful", userVisibility: "unconfirmed",
});

export async function closeNativeBrowserContext(context, retire) {
    // Retirement can be waiting for a browser callback that only close releases.
    const [retirement, closing] = await Promise.allSettled([
        Promise.resolve().then(retire),
        Promise.resolve().then(() => context?.close()),
    ]);
    if (closing.status === "rejected") throw closing.reason;
    if (retirement.status === "rejected") throw retirement.reason;
}

// Metadata observation is intentionally independent of request admission. No
// Fetch domain, routes, response bodies, headers or stored authentication URLs.
export async function observeBrowserAccountDocument(page, protocol, deadline = Date.now() + 90000) {
    const { frameTree } = await protocol.send("Page.getFrameTree");
    const frameId = frameTree?.frame?.id;
    if (typeof frameId !== "string" || !frameId) throw sourceError("NATIVE_SOURCE_FRAME_UNQUALIFIED");
    let document = null, retired = false, prerequisite = "passive-document-unobserved", bootstrapBranch = "unobserved";
    const control = "__wireAccountStartup_" + randomUUID().replaceAll("-", "");
    const contexts = new Map();
    let navigationLoader = frameTree.frame.loaderId, scriptId, retirement;
    const created = ({ context }) => {
        if (retired || context.auxData?.isDefault !== true || context.auxData.frameId !== frameId
            || typeof context.uniqueId !== "string") return;
        contexts.set(context.id, { id: context.id, uniqueId: context.uniqueId, loaderId: navigationLoader });
    };
    const destroyed = event => {
        if (contexts.get(event.executionContextId)?.uniqueId === event.executionContextUniqueId) {
            contexts.delete(event.executionContextId);
        }
    };
    const cleared = () => contexts.clear();
    const response = event => {
        if (retired || event.type !== "Document" || event.frameId !== frameId) return;
        const url = URL.parse(event.response.url);
        const reason = !url || !accountAppOrigins.has(url.origin) || url.username || url.password
            ? url && accountAuthOrigins.has(url.origin) ? "auth-document" : "document-origin-unqualified"
            : !["/", "/home", "/chat", "/chat/work", "/hwav2/chat", "/landingv2", "/spalanding"].includes(url.pathname) ? "document-path-unqualified"
                : event.response.status !== 200 ? "document-status-unqualified"
                    : event.response.fromDiskCache || event.response.fromServiceWorker ? "document-cache-unqualified"
                        : event.response.mimeType !== "text/html" ? "document-mime-unqualified"
                            : event.loaderId !== event.requestId ? "document-loader-unqualified" : null;
        prerequisite = "passive-" + (reason ?? "document-loading");
        bootstrapBranch = "unobserved";
        document = reason ? null : { frameId, loaderId: event.loaderId, origin: url.origin, path: url.pathname, finished: false };
    };
    const finished = event => {
        if (document?.loaderId === event.requestId) document.finished = true;
    };
    const failed = event => {
        if (document?.loaderId === event.requestId) { document = null; prerequisite = "passive-document-failed"; }
    };
    const navigated = event => {
        if (event.frame.id === frameId) navigationLoader = event.frame.loaderId;
        if (document && event.frame.id === frameId && document.loaderId !== event.frame.loaderId) {
            document = null; prerequisite = "passive-document-replaced";
        }
    };
    protocol.on("Network.responseReceived", response);
    protocol.on("Network.loadingFinished", finished);
    protocol.on("Network.loadingFailed", failed);
    protocol.on("Page.frameNavigated", navigated);
    protocol.on("Runtime.executionContextCreated", created);
    protocol.on("Runtime.executionContextDestroyed", destroyed);
    protocol.on("Runtime.executionContextsCleared", cleared);
    await protocol.send("Network.enable");
    await protocol.send("Page.enable");
    await protocol.send("Runtime.enable");
    ({ identifier: scriptId } = await protocol.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(${installNativeAccountStartup.toString()})(${JSON.stringify(control)},${deadline},${readNativeAccountMetadata.toString()});`,
    }));
    if (typeof scriptId !== "string") throw sourceError("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
    return {
        frameId,
        failurePredicate: () => prerequisite,
        bootstrapBranch: () => bootstrapBranch,
        async read(assertCurrent, expectedAccount) {
            assertCurrent();
            const candidate = document;
            if (retired || !candidate?.finished) return null;
            const matches = tree => {
                const frame = tree?.frameTree?.frame, url = URL.parse(frame?.url);
                if (retired || candidate !== document) return false;
                if (frame?.id !== frameId || frame.parentId || frame.loaderId !== candidate.loaderId) {
                    prerequisite = "passive-frame-identity-changed"; return false;
                }
                if (url?.origin !== candidate.origin) {
                    prerequisite = "passive-frame-origin-changed"; return false;
                }
                if (url.pathname !== candidate.path && !["/chat/work", "/home"].includes(url.pathname)) {
                    prerequisite = "passive-frame-path-changed"; return false;
                }
                return true;
            };
            prerequisite = "passive-frame-inspection-pending";
            if (!matches(await protocol.send("Page.getFrameTree"))) return null;
            assertCurrent();
            const candidates = [...contexts.values()].filter(value => value.loaderId === candidate.loaderId);
            if (candidates.length !== 1) { prerequisite = "passive-frame-identity-changed"; return null; }
            const realm = candidates[0];
            let metadata;
            prerequisite = "passive-metadata-read-pending";
            try {
                const result = await protocol.send("Runtime.evaluate", { uniqueContextId: realm.uniqueId, returnByValue: true,
                    expression: `window[${JSON.stringify(control)}]?.read()` });
                if (result.exceptionDetails || result.result?.value === false) throw sourceError("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
                metadata = result.result?.value ?? { state: "bootstrap-unavailable", branch: "tanstack", projected: null };
            }
            catch (error) {
                assertCurrent();
                // A normal Microsoft navigation can replace the execution
                // context between the two document reads. It is not a failed login.
                if (!matches(await protocol.send("Page.getFrameTree")) || contexts.get(realm.id) !== realm) return null;
                prerequisite = "passive-bootstrap-invalid";
                throw error;
            }
            assertCurrent();
            if (!matches(await protocol.send("Page.getFrameTree")) || contexts.get(realm.id) !== realm) return null;
            if (metadata?.state === "invalid") {
                prerequisite = "passive-bootstrap-invalid";
                throw sourceError("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
            }
            if (!["tanstack", "background-loader"].includes(metadata?.branch)) {
                prerequisite = "passive-bootstrap-invalid";
                throw sourceError("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
            }
            bootstrapBranch = metadata.branch;
            const background = metadata?.branch === "background-loader";
            if (["bootstrap-unavailable", "bootstrap-uninitialized", "bootstrap-loader-unavailable", "account-unavailable"].includes(metadata?.state)
                && metadata.projected === null) {
                prerequisite = (background ? "passive-background-" : "passive-") + metadata.state;
                return null;
            }
            if (metadata?.state !== "available" || !metadata.projected) {
                prerequisite = "passive-bootstrap-invalid";
                throw sourceError("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
            }
            assertCurrent();
            prerequisite = background ? "passive-background-account-rejected" : "passive-account-rejected";
            const principal = projectNativeSourceResponse({ bytes: Buffer.from(JSON.stringify(metadata.projected)),
                mime: "application/json", kind: "principal", expectedAccount });
            if (expectedAccount !== undefined && !principal.accountLabelMatched) throw new MicrosoftSessionError("wrong-account");
            prerequisite = background ? "passive-background-account-verified" : "passive-account-verified";
            return { ...principal, knownAccountMatched: true, origin: candidate.origin, observedAt: new Date().toISOString() };
        },
        retire() {
            if (retirement) return retirement;
            retired = true; document = null;
            protocol.off("Network.responseReceived", response);
            protocol.off("Network.loadingFinished", finished);
            protocol.off("Network.loadingFailed", failed);
            protocol.off("Page.frameNavigated", navigated);
            protocol.off("Runtime.executionContextCreated", created);
            protocol.off("Runtime.executionContextDestroyed", destroyed);
            protocol.off("Runtime.executionContextsCleared", cleared);
            const active = [...contexts.values()];
            contexts.clear();
            const until = Math.min(deadline, Date.now() + 1000);
            let timer, retiring = true;
            const checkRetirement = () => {
                if (!retiring || Date.now() >= until) throw sourceError("NATIVE_ACCOUNT_STARTUP_RETIRE_TIMEOUT");
            };
            const work = async () => {
                checkRetirement();
                await protocol.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
                checkRetirement();
                for (const realm of active) {
                    try {
                        checkRetirement();
                        const result = await protocol.send("Runtime.evaluate", { uniqueContextId: realm.uniqueId, returnByValue: true,
                            expression: `window[${JSON.stringify(control)}]?.retire()` });
                        checkRetirement();
                        if (result.exceptionDetails || result.result?.value === false) throw sourceError("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
                    } catch (error) {
                        if (error.code === "NATIVE_ACCOUNT_STARTUP_RETIRE_TIMEOUT") throw error;
                        if (!page.isClosed() && !/context.*(?:destroyed|not found|unique id)|Cannot find context/i.test(error.message)) throw error;
                    }
                }
            };
            retirement = Promise.race([work(), new Promise((_, reject) => {
                timer = setTimeout(() => reject(sourceError("NATIVE_ACCOUNT_STARTUP_RETIRE_TIMEOUT")), Math.max(0, until - Date.now()));
            })]).finally(() => { retiring = false; clearTimeout(timer); });
            return retirement;
        },
    };
}

async function presentOwnedSignInWindow(page, protocol, frameId, assertCurrent) {
    const invalid = () => sourceError("NATIVE_WINDOW_PRESENTATION_UNQUALIFIED");
    const send = async (method, input) => {
        assertCurrent();
        try { return await protocol.send(method, input); }
        finally { assertCurrent(); }
    };
    const initial = await send("Browser.getWindowForTarget");
    if (!Number.isSafeInteger(initial.windowId) || initial.windowId < 0
        || !["normal", "minimized", "maximized", "fullscreen"].includes(initial.bounds?.windowState)) throw invalid();
    const move = async bounds => {
        const reply = await send("Browser.setWindowBounds", { windowId: initial.windowId, bounds });
        if (!reply || typeof reply !== "object" || Array.isArray(reply) || Object.keys(reply).length) throw invalid();
    };
    if (initial.bounds.windowState !== "normal") await move({ windowState: "normal" });
    const world = await send("Page.createIsolatedWorld", { frameId, worldName: "wire-sign-in-work-area" });
    if (!Number.isSafeInteger(world.executionContextId) || world.executionContextId <= 0) throw invalid();
    const metrics = await send("Runtime.evaluate", { contextId: world.executionContextId, returnByValue: true,
        expression: "({left:screen.availLeft,top:screen.availTop,width:screen.availWidth,height:screen.availHeight})" });
    const area = metrics.result?.value;
    if (metrics.exceptionDetails || !area || ["left", "top", "width", "height"].some(key => !Number.isSafeInteger(area[key]))
        || area.width <= 0 || area.height <= 0) throw invalid();
    const restored = await send("Browser.getWindowForTarget");
    const bounds = restored.bounds;
    if (restored.windowId !== initial.windowId || bounds?.windowState !== "normal"
        || ["left", "top", "width", "height"].some(key => !Number.isSafeInteger(bounds[key]))
        || bounds.width <= 0 || bounds.height <= 0) throw invalid();
    const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
    const target = { width, height, left: Math.max(area.left, Math.min(bounds.left, area.left + area.width - width)),
        top: Math.max(area.top, Math.min(bounds.top, area.top + area.height - height)) };
    if (Object.keys(target).some(key => target[key] !== bounds[key])) await move(target);
    assertCurrent();
    try { await page.bringToFront(); }
    finally { assertCurrent(); }
    const shown = await send("Browser.getWindowForTarget");
    if (shown.windowId !== initial.windowId || shown.bounds?.windowState !== "normal"
        || ["left", "top", "width", "height"].some(key => !Number.isSafeInteger(shown.bounds[key]))
        || shown.bounds.width <= 0 || shown.bounds.height <= 0
        || shown.bounds.left < area.left || shown.bounds.top < area.top
        || shown.bounds.left + shown.bounds.width > area.left + area.width
        || shown.bounds.top + shown.bounds.height > area.top + area.height) throw invalid();
}
function sourceError(code) {
    return Object.assign(new BoardError("Microsoft activity could not be acquired completely. No source request was replayed.", 503), { code });
}

export function assertNativeRequestAdmission(allowed, facts, stage, predicate, engineeringContext = null) {
    if (allowed) return;
    if (stage === "preflight-check") stage = "protocol";
    const context = accountOnlyDenialContext(facts);
    const error = withNativeFailurePredicate(sourceError("NATIVE_SOURCE_REQUEST_UNQUALIFIED"), stage,
        predicate.startsWith("request-observ") ? predicate : "request-admission");
    withNativeFailureAdmission(error, {
        schemaVersion: 1, method: context?.method ?? "OTHER", resourceType: context?.resourceType ?? "other",
        publicRoute: context?.target ?? "unobserved",
        owner: facts?.owned === true ? "owned-frame" : facts?.owned === false ? "unowned-frame" : "unobserved",
        original: typeof facts?.original === "boolean" ? facts.original : null,
        navigation: typeof facts?.navigation === "boolean" ? facts.navigation : null, predicate, stage,
        ...(predicate === "document-scope" ? { document: documentAdmissionEvidence(facts) } : {}),
    });
    if (predicate === "document-scope" && isHistoryEngineering(engineeringContext?.engineering)) {
        const { scope, mainFrameId } = engineeringContext;
        withHistoryEngineeringStartup(error, facts.url, nativeEngineeringStartupProvenance(scope, facts, mainFrameId));
    }
    throw error;
}

export function nativeEngineeringStartupProvenance(scope, facts, mainFrameId) {
    const invocation = scope.native?.engineeringInvocation;
    const request = scope.native?.requestOrigins?.get(facts.networkId);
    const matched = request && request.networkId === facts.networkId && request.frameId === facts.frameId
        && request.url === facts.url?.href && request.method === facts.method && request.owned && !request.duplicate;
    const document = matched && URL.parse(request.documentUrl);
    return {
        binding: matched ? "matched-original-request" : "unobserved",
        frame: typeof mainFrameId !== "string" || typeof facts.frameId !== "string" ? "unobserved"
            : facts.frameId === mainFrameId ? "root" : facts.owned === true ? "owned-descendant" : "unobserved",
        invocationState: invocation ? "started" : "not-started",
        requestRelation: !matched || !invocation ? "unobserved"
            : invocation.preexistingNetworkIds.has(request.networkId)
                ? request.original ? "preexisting-before-invocation" : "preexisting-request-chain"
                : request.engineeringInvocation === invocation
                    ? request.url === invocation.url && request.frameId === invocation.frameId
                        ? "requested-destination-match" : "different-destination" : "unobserved",
        initiator: matched && ["parser", "script", "other", "preflight"].includes(request.initiatorType) ? request.initiatorType : "unobserved",
        document: !document ? "unobserved" : document.href === "about:blank" ? "blank"
            : ["edge:", "chrome:", "chrome-search:"].includes(document.protocol) ? "browser-internal"
                : accountAppOrigins.has(document.origin) ? "known-app" : accountAuthOrigins.has(document.origin) ? "known-auth" : "other",
        redirect: !matched ? "unobserved" : request.original ? "not-observed"
            : request.engineeringRedirectFromInvocation ? "from-requested-destination" : "observed-other",
    };
}

function documentAdmissionEvidence({ url, type }) {
    const labels = nativeBootstrapDestinationLabels(url);
    const app = accountAppOrigins.has(url?.origin), auth = accountAuthOrigins.has(url?.origin);
    return { originClass: app ? "admitted-app" : auth ? "admitted-auth"
        : labels.originLabel !== "unknown" ? "known-unadmitted-origin" : "outside-known-origin",
        ...labels,
        clause: type !== "document" ? "non-document-resource" : app && !accountPages.has(url.pathname)
            ? "unlisted-app-path" : !app && !auth ? "outside-admitted-origins" : "unobserved" };
}

export function nativeFailureForPublication(error, stage) {
    const detail = nativeFailureDetails(error, stage);
    const failure = withNativeFailurePredicate(sourceError(safeCode(error)), detail.predicate.stage, detail.predicate.name);
    if (detail.admission) withNativeFailureAdmission(failure, detail.admission);
    if (detail.protocolStop) withNativeFailureProtocolStop(failure, detail.protocolStop);
    return inheritHistoryEngineeringStartup(error, failure);
}

export function admitNativeRequestObservation(observer, request, slot, count, maximum, facts, stage) {
    let predicate = count > maximum ? "request-observation-budget" : "request-observer-admission";
    const admitted = count <= maximum && observer.observe(request, slot, reason => { predicate = reason; });
    assertNativeRequestAdmission(admitted, facts, stage, predicate);
}

export function recordNativeEngineeringFailure(engineering, error, scope) {
    engineering.recordFailure(scope?.error ?? error);
}

export function nativeProtocolFailure(reason, facts, { scope, mainFrameId, observation } = {}) {
    const known = NATIVE_PROTOCOL_STOP_REASONS.includes(reason) ? reason : "unrecognized-stop";
    const phase = observation?.source === "network" ? "network" : ["request", "response"].includes(facts?.stage) ? facts.stage : "unobserved";
    const request = accountOnlyDenialContext(facts);
    const provenance = request ? nativeEngineeringStartupProvenance(scope ?? {}, facts, mainFrameId) : null;
    return withNativeFailureProtocolStop(withNativeFailurePredicate(sourceError("NATIVE_SOURCE_REQUEST_FAILED"),
        phase === "network" ? "network" : "protocol", "protocol-stop"), {
        reason: known, phase,
        ...(["failed", "finished"].includes(observation?.terminal) ? { terminal: observation.terminal } : {}),
        ...(observation?.capacity ? { capacity: observation.capacity } : {}),
        ...(observation?.binding ? { binding: observation.binding } : {}),
        ...(observation?.networkRecord ? { networkRecord: observation.networkRecord } : {}),
        ...(request ? { request: { method: request.method, resourceType: request.resourceType,
            owner: request.owned ? "owned-frame" : "unowned-frame", original: request.original, navigation: request.navigation },
        provenance: { request: provenance.binding === "matched-original-request" ? "matched" : "unobserved",
            frame: provenance.frame, invocation: provenance.requestRelation } } : {}),
    });
}

function allowedAccountSelfUrl(url) {
    if (url.origin + url.pathname !== accountSelfUrl || url.username || url.password || url.hash
        || url.search.length > 512 || url.search.includes("&")) return false;
    if (!url.search) return true;
    const entries = [...url.searchParams];
    if (entries.length !== 1 || entries[0][0] !== "$select") return false;
    const fields = entries[0][1].split(",");
    return fields.length > 0 && new Set(fields).size === fields.length && fields.every(field => accountSelfFields.has(field));
}

export function accountOnlyDenialContext(facts) {
    if (!facts?.url || !["navigation", "owned", "original"].every(key => typeof facts[key] === "boolean")) return null;
    const { url } = facts, method = typeof facts.method === "string" ? facts.method.toUpperCase() : "OTHER";
    const type = typeof facts.type === "string" ? facts.type.toLowerCase() : "other";
    const app = accountAppOrigins.has(url.origin);
    const auth = accountAuthOrigins.has(url.origin);
    let target = "other";
    if (url.origin === "https://m365.cloud.microsoft" && url.pathname === "/chat") target = "shell";
    else if (app && url.pathname === "/landingv2") target = "landingv2";
    else if (app && accountPages.has(url.pathname)) target = "other-account-page";
    else if (auth && /\/oauth2\/v2\.0\/token(?:\/|$)/.test(url.pathname)) target = "token";
    else if (url.origin + url.pathname === accountSelfUrl) target = "self";
    else if (/\/(?:subscribe|conversations|conversation|chats|chat|tasks|task|messages|files|history|events|actions)(?:\/|$)/i.test(url.pathname)) target = "protected-data";
    else if (["script", "stylesheet", "font", "image"].includes(type)
        && (app || /(^|\.)cdn\.office\.net$|(^|\.)onecdn\.static\.microsoft$|^aadcdn\.msftauth\.net$|^aadcdn\.msauth\.net$|(^|\.)sharepointonline\.com$/.test(url.hostname))) target = "static";
    // Test only the URL delimiters, not authentication query keys or values.
    const queryAt = url.href.indexOf("?"), fragmentAt = url.href.indexOf("#");
    return {
        method: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(method) ? method : "OTHER",
        resourceType: ["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch",
            "eventsource", "websocket", "manifest", "other"].includes(type) ? type : "other",
        stage: ["route", "request", "response"].includes(facts.stage) ? facts.stage : "other",
        navigation: facts.navigation, owned: facts.owned, original: facts.original, target,
        queryPresent: queryAt !== -1 && (fragmentAt === -1 || queryAt < fragmentAt),
    };
}

// This decision is shared by Playwright admission and every Chromium redirect hop.
export function accountOnlyRequestDecision({ url, method, type, navigation, owned, original, pageOrigin,
    tokenEndpoint, signInClicked, accountSelected, selfPreflightAssociated = false }) {
    if (!owned) return { denied: "unowned-frame" };
    if (!url || url.protocol !== "https:" || url.username || url.password) return { denied: "url-scope" };
    const app = accountAppOrigins.has(url.origin);
    const auth = accountAuthOrigins.has(url.origin);
    const appInitiator = [origin, "https://m365.cloud.microsoft"].includes(pageOrigin);
    if (auth && /\/oauth2\/v2\.0\/token(?:\/|$)/.test(url.pathname)) {
        return original && appInitiator && url.origin + url.pathname === tokenEndpoint && !url.hash && !navigation
            && (method === "POST" && ["xhr", "fetch"].includes(type)
                || method === "OPTIONS" && ["other", "xhr", "fetch"].includes(type))
            ? { kind: "token" } : { denied: "token-scope" };
    }
    if (url.origin === "https://m365.cloud.microsoft" && url.pathname === "/chat") {
        return url.href === nativeApplicationEntry && method === "GET" && type === "document" && navigation
            ? { kind: "shell" } : { denied: "shell-document-scope" };
    }
    if (/\/(?:subscribe|conversations|conversation|chats|chat|tasks|task|messages|files|history|events|actions)(?:\/|$)/i.test(url.pathname)) {
        return { denied: "business-data" };
    }
    if (url.origin + url.pathname === accountSelfUrl) {
        if (method === "OPTIONS") return original && appInitiator && !navigation && ["other", "xhr", "fetch"].includes(type)
            && allowedAccountSelfUrl(url) && selfPreflightAssociated === true
            ? { kind: "self-preflight" } : { denied: "self-preflight-association" };
        return original && appInitiator && method === "GET" && ["xhr", "fetch"].includes(type)
            && !navigation && allowedAccountSelfUrl(url) ? { kind: "self" } : { denied: "self-scope" };
    }
    if (auth && ["xhr", "fetch"].includes(type)) return { denied: "auth-data" };
    if (navigation) {
        if (type !== "document" || app && !accountPages.has(url.pathname)) return { denied: "document-scope" };
        if (method === "POST") return app && url.pathname === "/landingv2" && signInClicked && accountSelected
            ? { kind: "document" } : { denied: "sign-in-return-method" };
        if (!["GET", "HEAD", "OPTIONS"].includes(method)) return { denied: "method-scope" };
        return auth || app ? { kind: "document" } : { denied: "document-scope" };
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) return { denied: "method-scope" };
    const dataDenial = { denied: "data-dependency", blockOnly: original === true && owned === true
        && navigation === false && method === "GET" && ["xhr", "fetch"].includes(type) };
    if (gateway(url)) return url.pathname === "/v1/routing" && !url.search
        ? { kind: "bootstrap" } : dataDenial;
    if (auth) return { kind: "bootstrap" };
    if (["script", "stylesheet", "font", "image"].includes(type)
        && (app || /(^|\.)cdn\.office\.net$|(^|\.)onecdn\.static\.microsoft$|^aadcdn\.msftauth\.net$|^aadcdn\.msauth\.net$|(^|\.)sharepointonline\.com$/.test(url.hostname))) {
        return { kind: "static" };
    }
    if (url.origin === "https://config.edge.skype.com" && url.pathname === "/config/v1/CHILL/0.0.14"
        || url.origin === "https://res.cdn.office.net" && ["/teams-js/validDomains/json/validDomains.json", "/s01-copilotstudio/cowork/latest/version.json"].includes(url.pathname)
        || url.origin === "https://res.public.onecdn.static.microsoft" && /\.json$/.test(url.pathname)
        || app && ["/healthz", "/client_health_ping", "/events-worker.js"].includes(url.pathname)) return { kind: "bootstrap" };
    return dataDenial;
}

async function diagnoseAccountFrame(protocol, { mainFrameId, frameId, scope, getScope, rootParentId }) {
    const unresolved = { classification: "unresolved", rootMatchesPinned: null };
    const validId = value => typeof value === "string" && value.length > 0 && value.length <= 256;
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const page = scope.page, changed = Promise.withResolvers(), listening = [];
    let timer, invalidated = false;
    const invalidate = () => { invalidated = true; changed.resolve(null); };
    try {
        // The fatal stop already aborted this scope; continued ownership permits diagnosis only.
        if (!validId(frameId) || getScope() !== scope || !page || page.isClosed()) return unresolved;
        const deadline = performance.now() + 1000;
        for (const event of ["framenavigated", "frameattached", "framedetached", "close"]) {
            page.on(event, invalidate);
            listening.push([page, event]);
        }
        protocol.on("close", invalidate);
        listening.push([protocol, "close"]);
        timer = setTimeout(invalidate, 1000);
        const result = await Promise.race([protocol.send("Page.getFrameTree"), changed.promise]);
        if (invalidated || getScope() !== scope || scope.page !== page || page.isClosed()
            || performance.now() >= deadline) return unresolved;
        const pending = [{ node: result?.frameTree, parentId: rootParentId, level: 1 }], seen = new Set();
        let rootId, found = false;
        while (pending.length) {
            const { node, parentId, level } = pending.pop();
            if (!object(node) || !object(node.frame) || !validId(node.frame.id)
                || node.frame.parentId !== parentId || seen.has(node.frame.id) || level > 16 || seen.size === 128) return unresolved;
            const id = node.frame.id;
            seen.add(id);
            if (level === 1) rootId = id;
            if (id === frameId) found = true;
            const children = node.childFrames;
            if (children !== undefined) {
                if (!Array.isArray(children) || children.length + seen.size + pending.length > 128) return unresolved;
                for (const child of children) pending.push({ node: child, parentId: id, level: level + 1 });
            }
        }
        if (invalidated || getScope() !== scope || scope.page !== page || page.isClosed()
            || performance.now() >= deadline) return unresolved;
        return { classification: !found ? "unresolved" : frameId === rootId ? "current-root" : "owned-descendant",
            rootMatchesPinned: rootId === mainFrameId };
    } catch {
        return unresolved;
    } finally {
        clearTimeout(timer);
        for (const [emitter, event] of listening) emitter.off(event, invalidate);
    }
}

function blockedTelemetryDestination(url) {
    return url && !url.username && !url.password && !url.hash && url.href.length <= 16384
        && url.origin + url.pathname === nativeHistoryProducer.authTelemetryCollector;
}
function appEventsDestination(url) {
    return url && ["https://copilot.cloud.microsoft", "https://m365.cloud.microsoft"].includes(url.origin)
        && url.pathname === "/events" && !url.search && !url.hash && !url.username && !url.password;
}
function healthQueryPurpose(url) {
    const keys = [...url.searchParams.keys()];
    if (keys.length > 5 || new Set(keys).size !== keys.length || !keys.includes("type") || !keys.includes("route")
        || keys.some(key => !["type", "route", "traceId", "sessionId", "handInRequestId"].includes(key))) return null;
    const purpose = url.searchParams.get("type");
    return ["loggerInit", "mainLoad"].includes(purpose) ? purpose : null;
}

// The existing account-only protocol gate, also exercised against local HTTP redirects.
// No headers/bodies are read; opaque URLs exist only in bounded in-flight correlation.
export async function guardAccountOnlyRequests(protocol, { mainFrameId, getScope, admit, responded, stop, track,
    isSelfUrl = allowedAccountSelfUrl, ownsFrame = frameId => frameId === mainFrameId,
    diagnoseFrames = true, acceptResponse = () => true, keepIdle = false, observeRequest, observeResponse,
    preflightCandidate, admitPreflight, blockedBootstrapChild = null, observeNetworkDocument, observeData, observeTerminal,
    inheritedResponse = null, allowAuthTelemetryDenial, qualifyAppTelemetry, observeNetworkResource, allowFetchOnlyTelemetryDenial,
    telemetryAttemptLimit = nativeTelemetryAttemptLimits.unattended, getAuthorizationContext, getAncillaryDocument,
    validateBootstrapTransport, bindRequestCapacity, chatActionUrl, bindChatAction, chatActionPreflight,
    allowReadFailureResponse, allowUnavailableResponse, bindDeniedImage, bindLocalImage, collectionLoggerCurrent, bindCspReport }) {
    if (!Object.values(nativeTelemetryAttemptLimits).includes(telemetryAttemptLimit)) throw sourceError("NATIVE_SOURCE_REQUEST_LIMIT");
    const requests = new Map(), networkRequests = new Map(), idleBlocks = new Map(), cached = new Set();
    const nativeGets = new Map(), nativePreflights = new Map();
    const childErrorImages = new Map();
    const localImages = new Map();
    const localImageMime = value => typeof value === "string" && value.length <= 65536
        ? /^data:(image\/(?:png|gif|jpeg|webp));base64,/i.exec(value.slice(0, 40))?.[1].toLowerCase() ?? null : null;
    const blockedFrames = new Map();
    const telemetryPosts = new Map(), telemetryPreflights = new Map(), telemetryLatePauses = new Set();
    let collectionScope = null, collectionRecordCount = 0;
    const collectionCurrent = scope => scope === collectionScope && scope === getScope()
        && scope?.lease?.kind === "microsoft-read" && !scope.error && !scope.abort.signal.aborted
        && !scope.operationSignal?.aborted && collectionLoggerCurrent?.(scope) === true;
    const fetchOnlyTelemetry = new Set(), fetchOnlyPending = new Set(), telemetryDeniedIds = new Set();
    const telemetryUrl = blockedTelemetryDestination;
    const abortConfirmed = entry => entry.abortAcknowledged || entry.linkedPreflight?.abortAcknowledged;
    const capacity = 128, admissions = new Map();
    const activeEntries = () => new Set([...requests.values(), ...networkRequests.values()]);
    const pendingCount = () => activeEntries().size
        + [...childErrorImages.values()].filter(entry => !entry.finished).length
        + [...localImages.values()].filter(entry => entry.terminal === null).length
        + telemetryLatePauses.size + fetchOnlyPending.size + admissions.size;
    const reservedSlots = () => [...admissions.values()].reduce((sum, ticket) => sum + (ticket.reserved ? ticket.slots : 0), 0);
    const capacitySummary = () => {
        const entries = [...activeEntries()];
        return { active: entries.length, reserved: reservedSlots(),
            waiting: [...admissions.values()].reduce((sum, ticket) => sum + (ticket.reserved ? 0 : ticket.slots), 0),
            withoutTerminal: entries.filter(entry => entry.terminal === null).length,
            withoutAcknowledgement: entries.filter(entry => entry.state === "policy-block"
                ? !abortConfirmed(entry) : !entry.responseAcknowledged).length,
            redirecting: entries.filter(entry => entry.state === "redirect").length };
    };
    let capacityTimer = null;
    const capacityScopes = new Map();
    let active = true, selfGet = null, selfPreflight = null, childRequest = null, childBlocks = 0, partnerBlocks = 0,
        cachedSessionBlocks = 0, childErrorImageCount = 0;
    const authorizationContexts = new Map(), contextLimit = getAuthorizationContext ? 2 : 1;
    let latestAuthorizationContext = -1;
    const authorizationContextSettled = (id, detached = false) =>
        [...blockedFrames.values()].filter(entry => entry.authorizationContext === id).every(entry =>
            entry.abortAcknowledged && entry.terminal === "failed" && (!detached || !ownsFrame(entry.frameId)))
        && [...childErrorImages.values()].filter(entry => entry.authorizationContext === id).every(entry => entry.finished);
    const denialContext = scope => {
        const id = getAuthorizationContext ? getAuthorizationContext(scope) : 0;
        if (!Number.isSafeInteger(id) || id < 0 || id >= contextLimit || id < latestAuthorizationContext
            || id > latestAuthorizationContext && latestAuthorizationContext >= 0
                && !authorizationContextSettled(latestAuthorizationContext, true)) return null;
        if (!authorizationContexts.has(id)) authorizationContexts.set(id, { id, partner: 0, cached: 0, images: 0 });
        latestAuthorizationContext = id;
        return authorizationContexts.get(id);
    };
    const acknowledgeChildBlock = (entry, field) => {
        if (!entry.childBlock) return;
        entry.childBlock[field] = true;
        if (entry.childBlockAggregate) entry.childBlockAggregate[field] =
            entry.childBlockAggregate.contexts.every(record => record[field]);
    };
    const retireSelf = () => { selfGet = null; selfPreflight = null; };
    const retire = () => {
        active = false;
        clearTimeout(capacityTimer);
        capacityTimer = null;
        for (const [scope, listener] of capacityScopes) scope.abort.signal.removeEventListener("abort", listener);
        capacityScopes.clear();
        for (const ticket of admissions.values()) ticket.resume("capacity-owner-changed");
        admissions.clear();
        requests.clear(); networkRequests.clear(); idleBlocks.clear(); cached.clear();
        nativeGets.clear(); nativePreflights.clear(); telemetryPosts.clear(); telemetryPreflights.clear(); telemetryLatePauses.clear();
        fetchOnlyTelemetry.clear(); fetchOnlyPending.clear(); telemetryDeniedIds.clear();
        childErrorImages.clear(); localImages.clear(); blockedFrames.clear(); childRequest = null;
        collectionScope = null; collectionRecordCount = 0; retireSelf(); };
    const retireRequest = entry => {
        if (requests.get(entry.requestId) === entry) requests.delete(entry.requestId);
        if (networkRequests.get(entry.networkId) === entry) networkRequests.delete(entry.networkId);
        pumpCapacity();
    };
    const ticketCurrent = ticket => active && admissions.get(ticket.requestId) === ticket
        && ticket.facts.networkId === ticket.networkId && ticket.scope === getScope() && !ticket.scope.abort.signal.aborted
        && ownsFrame(ticket.facts.frameId) && (!ticket.binding || ticket.binding.current() === true);
    const pumpCapacity = () => {
        clearTimeout(capacityTimer);
        capacityTimer = null;
        let invalid = false;
        for (const ticket of admissions.values()) {
            if (!ticketCurrent(ticket)) {
                ticket.resume("capacity-owner-changed");
                invalid = true;
            } else if (ticket.binding && Date.now() >= ticket.binding.deadline) {
                ticket.resume("capacity-deadline");
                invalid = true;
            }
        }
        if (invalid) return;
        for (const ticket of admissions.values()) {
            if (ticket.reserved) continue;
            if (activeEntries().size + reservedSlots() + ticket.slots > capacity) break;
            ticket.reserved = true;
            ticket.resume(null);
        }
        const deadline = Math.min(...[...admissions.values()].filter(ticket => !ticket.reserved)
            .map(ticket => ticket.binding.deadline));
        if (Number.isFinite(deadline)) capacityTimer = setTimeout(pumpCapacity, Math.max(1, deadline - Date.now()));
    };
    const releaseAdmission = ticket => {
        if (!ticket || admissions.get(ticket.requestId) !== ticket) return;
        admissions.delete(ticket.requestId);
        if (![...admissions.values()].some(row => row.scope === ticket.scope)) {
            const listener = capacityScopes.get(ticket.scope);
            ticket.scope.abort.signal.removeEventListener("abort", listener);
            capacityScopes.delete(ticket.scope);
        }
        pumpCapacity();
    };
    const reserveAdmission = (scope, facts, requestId, networkId, previous, existing, linkedChatPost, chatBinding) => {
        if (admissions.has(requestId) || [...admissions.values()].some(ticket => ticket.networkId === networkId)) {
            return { error: "capacity-duplicate" };
        }
        // A preflight may retain its original blocked request too; reserve both before awaiting.
        const lateBeacon = existing?.type === "ping" && !existing.linkedPreflight && existing.terminal === "failed";
        const slots = previous || existing && (activeEntries().has(existing) || lateBeacon)
            ? 0 : facts.method === "OPTIONS" && !linkedChatPost ? 2 : 1;
        const summary = capacitySummary();
        if (admissions.size >= nativeRequestOriginLimit
            || summary.active + summary.reserved + summary.waiting + slots > nativeRequestOriginLimit) {
            return { error: "capacity-queue-full" };
        }
        const reserved = slots === 0 || summary.waiting === 0 && summary.active + summary.reserved + slots <= capacity;
        const supplied = chatBinding ?? bindRequestCapacity?.(scope, facts, { waitForMetadata: !reserved }) ?? null;
        if (supplied?.refused) return { error: "capacity-unbound", binding: supplied.refused };
        const binding = supplied && Object.freeze({ deadline: supplied.deadline, current: supplied.current,
            associate: supplied.associate, failureEvidence: supplied.failureEvidence });
        if (binding && (!Number.isFinite(binding.deadline) || typeof binding.current !== "function" || binding.current() !== true)) {
            return { error: "capacity-unbound", binding: binding.failureEvidence?.("capacity-unbound") };
        }
        if (!reserved && !binding) return { error: bindRequestCapacity ? "capacity-unbound" : "protocol-cap" };
        let resolve;
        const ready = new Promise(done => { resolve = done; });
        let resumed = false;
        const ticket = { scope, facts, requestId, networkId, slots, binding, reserved, ready,
            resume(reason) { if (!resumed) { resumed = true; resolve(reason); } } };
        admissions.set(requestId, ticket);
        if (!capacityScopes.has(scope)) {
            const listener = () => pumpCapacity();
            capacityScopes.set(scope, listener);
            scope.abort.signal.addEventListener("abort", listener, { once: true });
        }
        if (reserved) ticket.resume(null);
        else pumpCapacity();
        return { ticket };
    };
    if (inheritedResponse) {
        if (inheritedResponse.scope !== getScope() || !ownsFrame(inheritedResponse.frameId)
            || inheritedResponse.kind !== "device-risk-document" || inheritedResponse.state !== "complete"
            || !inheritedResponse.responseAcknowledged || inheritedResponse.terminal !== null) {
            throw sourceError("NATIVE_DEVICE_RISK_HANDOFF_UNQUALIFIED");
        }
        requests.set(inheritedResponse.requestId, inheritedResponse);
        networkRequests.set(inheritedResponse.networkId, inheritedResponse);
    }
    const stopNetwork = (scope, reason, entry, terminal, networkRecord) => {
        stop(scope, reason, entry ? { ...entry.facts, stage: entry.state === "request" ? "request" : "response" } : null,
            { source: terminal ? "network" : "protocol", terminal: terminal ?? entry?.terminal,
                ...(admissions.size ? { capacity: capacitySummary() } : {}),
                ...(networkRecord ? { networkRecord } : {}) });
        retire();
    };
    const bootstrapTransportCurrent = entry => active && entry.scope === getScope()
        && !entry.scope.abort.signal.aborted && ownsFrame(entry.frameId) && entry.frameId === mainFrameId
        && preservedTransportKind(entry.kind) && entry.method === "GET"
        && (entry.kind === "bootstrap-health-transport" ? ["fetch", "xhr"].includes(entry.type) : presentationTypes.has(entry.type))
        && entry.hops === 1 && entry.facts.original && !entry.facts.navigation
        && validateBootstrapTransport?.(entry.scope, entry) === true;
    const settleBootstrapTransport = entry => {
        if (!entry.requestAcknowledged || entry.responsePending) return;
        if (!bootstrapTransportCurrent(entry) || entry.state !== "request"
            || entry.nativeResponseError && entry.terminal !== "failed"
            || observeTerminal?.(entry.scope, entry) !== true) {
            stopNetwork(entry.scope, "bootstrap-transport-unqualified", entry);
            return;
        }
        retireRequest(entry);
    };
    protocol.on("close", () => {
        if (active) stop(getScope(), "protocol-coverage", null, admissions.size ? { capacity: capacitySummary() } : undefined);
        retire();
    });
    protocol.on("Page.frameNavigated", ({ frame }) => {
        queueMicrotask(pumpCapacity);
        const entry = blockedFrames.get(frame.id);
        if (!active || !entry || entry.scope !== getScope() || entry.scope.abort.signal.aborted) return;
        if (frame.id === entry.frameId && frame.loaderId === entry.networkId && frame.url === "chrome-error://chromewebdata/"
            && frame.unreachableUrl === entry.url && entry.abortAcknowledged && entry.terminal === "failed"
            && ownsFrame(frame.id)) entry.errorDocument = true;
    });
    protocol.on("Page.frameDetached", () => queueMicrotask(pumpCapacity));
    protocol.on("Network.requestServedFromCache", ({ requestId }) => {
        if (!active || typeof requestId !== "string") return;
        const local = localImages.get(requestId);
        if (local) {
            if (local.scope !== getScope() || local.scope.abort.signal.aborted || !local.proof.current()
                || local.memoryCache || local.response || local.terminal) {
                stopNetwork(getScope(), "network-completion-state", null); return;
            }
            // Chromium reports an embedded data image as memory-cached, not a remote cached response.
            local.memoryCache = true;
            return;
        }
        if (cached.size >= 128) { stop(getScope(), "protocol-cap"); retire(); return; }
        cached.add(requestId);
        const entry = networkRequests.get(requestId);
        if (entry) entry.cached = true;
    });
    protocol.on("Network.responseReceived", ({ requestId, frameId, loaderId, type, response }) => {
        if (!active) return;
        const local = localImages.get(requestId);
        if (local) {
            if (local.scope !== getScope() || local.scope.abort.signal.aborted || !local.proof.current()) {
                stopNetwork(getScope(), "network-scope-mismatch", null); return;
            }
            if (local.response || local.terminal || frameId !== local.frameId || loaderId !== local.loaderId
                || type !== "Image" || response?.status !== 200 || response.mimeType !== local.mime
                || localImageMime(response.url) !== local.mime || response.fromDiskCache || response.fromPrefetchCache
                || response.fromServiceWorker) {
                stopNetwork(local.scope, "network-completion-state", null); return;
            }
            local.response = true;
            return;
        }
        if (response?.fromDiskCache || response?.fromPrefetchCache || response?.fromServiceWorker) {
            const entry = networkRequests.get(requestId);
            if (entry) entry.cached = true;
            else if (cached.size < 128) cached.add(requestId);
            else { stop(getScope(), "protocol-cap"); retire(); }
        }
    });
    if (observeData) protocol.on("Network.dataReceived", ({ requestId, dataLength }) => {
        const entry = networkRequests.get(requestId);
        if (active && entry && entry.scope === getScope() && !entry.scope.abort.signal.aborted) observeData(entry.scope, entry, dataLength);
    });
    protocol.on("Network.requestWillBeSent", event => {
        const scope = active ? getScope() : null;
        if (!scope || scope.abort.signal.aborted) return;
        if (typeof event?.request?.url !== "string" || typeof event.request.method !== "string") {
            stop(scope, "self-preflight-association");
            retire();
            return;
        }
        const { requestId, frameId, type, initiator, request: { url: requestUrl, method } } = event;
        if (scope.native) {
            const records = scope.native.networkRecordObservations ??= new Map();
            if (typeof requestId === "string" && requestId.length > 0 && requestId.length <= 256
                && (records.has(requestId) || records.size < nativeRequestOriginLimit)) {
                const document = getAncillaryDocument?.(scope), resourceType = type?.toLowerCase();
                const compare = (value, expected) => typeof value !== "string" || !value || typeof expected !== "string" || !expected
                    ? "unobserved" : value === expected ? "matched-at-request" : "different-at-request";
                records.set(requestId, {
                    observation: records.has(requestId) && !Object.hasOwn(event, "redirectResponse") ? "duplicate"
                        : Object.hasOwn(event, "redirectResponse") ? "redirect" : "original",
                    resourceType: ["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch",
                        "eventsource", "websocket", "manifest", "ping", "preflight", "other"].includes(resourceType) ? resourceType : "other",
                    urlClass: localImageMime(requestUrl) ? "embedded-raster-image" : requestUrl.startsWith("data:") ? "data-other"
                        : requestUrl.startsWith("https:") ? "https" : requestUrl.startsWith("http:") ? "http"
                            : requestUrl.startsWith("blob:") ? "blob" : "other",
                    frame: typeof frameId !== "string" || !frameId ? "unobserved" : frameId === mainFrameId ? "root"
                        : ownsFrame(frameId) ? "owned-descendant" : "unowned",
                    document: compare(event.documentURL, document ? scope.page?.url() : null),
                    loader: compare(event.loaderId, document?.entry.networkId),
                });
            } else if (records.size >= nativeRequestOriginLimit) scope.native.networkRecordObservationsCapped = true;
        }
        for (const [id, local] of localImages) {
            if (local.scope !== scope && local.terminal !== null) localImages.delete(id);
        }
        if (localImages.has(requestId)) { stopNetwork(scope, "network-id-reused", null); return; }
        const mime = bindLocalImage && method === "GET" && type === "Image" ? localImageMime(requestUrl) : null;
        if (mime) {
            const proof = bindLocalImage(scope, { networkId: requestId, frameId, loaderId: event.loaderId,
                documentUrl: event.documentURL, original: !Object.hasOwn(event, "redirectResponse") });
            if (proof) {
                const fetchAssociated = networkRequests.has(requestId)
                    || [...admissions.values()].some(ticket => ticket.networkId === requestId);
                if (typeof requestId !== "string" || !requestId || requestId.length > 256 || fetchAssociated
                    || cached.has(requestId) || localImages.size >= nativeRequestOriginLimit) {
                    stopNetwork(scope, fetchAssociated ? "network-id-reused"
                        : cached.has(requestId) ? "network-completion-state" : "protocol-cap", null);
                    return;
                }
                localImages.set(requestId, { scope, frameId, loaderId: event.loaderId, mime, proof, response: false, terminal: null });
                return;
            }
        }
        const metadataUrl = requestUrl.startsWith("https://") ? URL.parse(requestUrl) : null;
        if (scope.native && metadataUrl && !metadataUrl.username && !metadataUrl.password
            && !scope.native.deviceRisk?.frames?.has(frameId)) {
            const records = scope.native.requestOrigins ??= new Map();
            if (scope === collectionScope && !records.has(requestId) && collectionRecordCount >= nativeRequestOriginLimit) {
                scope.native.requestOriginsTruncated = true;
                stopNetwork(scope, "protocol-cap", null);
                return;
            }
            if (typeof requestId === "string" && requestId.length <= 256 && requestUrl.length <= 16384
                && (records.has(requestId) || records.size < nativeRequestOriginLimit)) {
                const prior = records.get(requestId);
                if (!prior && scope === collectionScope) collectionRecordCount++;
                const ancillary = appEventsDestination(metadataUrl)
                    || ["/client_health_ping", "/events-worker.js"].includes(metadataUrl.pathname);
                const document = scope.native.currentDocument
                    ?? (ancillary || presentationTypes.has(type?.toLowerCase()) ? getAncillaryDocument?.(scope) : null);
                records.set(requestId, { networkId: requestId, frameId, url: requestUrl, method, type: type?.toLowerCase(),
                    ...(prior?.chatActionDenied ? { chatActionDenied: true } : {}),
                    loaderId: typeof event.loaderId === "string" ? event.loaderId : null,
                    original: !Object.hasOwn(event, "redirectResponse"), duplicate: Boolean(prior && !event.redirectResponse),
                    ...(scope.native.engineeringInvocation ? { engineeringInvocation: scope.native.engineeringInvocation,
                        engineeringRedirectFromInvocation: Boolean(event.redirectResponse && prior?.original
                            && prior.engineeringInvocation === scope.native.engineeringInvocation
                            && prior.frameId === scope.native.engineeringInvocation.frameId
                            && prior.url === scope.native.engineeringInvocation.url) } : {}),
                    owned: ownsFrame(frameId), document, epoch: document?.epoch ?? null,
                    documentUrl: scope.page.url(), initiatorType: initiator?.type, initiatorRequestId: initiator?.requestId,
                    initiatorUrl: initiator?.url,
                    frames: (initiator?.stack?.callFrames ?? []).slice(0, 8).map(({ url, lineNumber, columnNumber }) => {
                        const candidate = typeof url === "string" && url.startsWith("https://") && url.length <= 4096 ? URL.parse(url) : null;
                        return { url: candidate && !candidate.username && !candidate.password ? url : null, lineNumber, columnNumber,
                            acceptedScript: nativeDocumentScript(document, url, records) ?? null };
                    }) });
            } else scope.native.requestOriginsTruncated = true;
        }
        if (observeNetworkResource && method === "GET" && type === "Other") observeNetworkResource(scope, {
            networkId: requestId, frameId, requestUrl, method, type: "other", owned: ownsFrame(frameId),
            original: !Object.hasOwn(event, "redirectResponse"), initiatorType: initiator?.type,
        });
        const appTelemetry = method === "POST" && qualifyAppTelemetry && ["Fetch", "XHR"].includes(type) && appEventsDestination(metadataUrl);
        if (allowAuthTelemetryDenial && telemetryUrl(URL.parse(requestUrl))
            && (method !== "POST" || ["Fetch", "XHR", "Ping"].includes(type)) || appTelemetry) {
            const label = appTelemetry ? "app-telemetry" : "auth-telemetry";
            if (typeof requestId !== "string" || !requestId || requestId.length > 256
                || Object.hasOwn(event, "redirectResponse")) {
                stop(scope, label + "-association"); retire(); return;
            }
            if (method === "POST") {
                const collection = appTelemetry && scope === collectionScope && typeof collectionLoggerCurrent === "function";
                if (collection && !collectionCurrent(scope)) { stop(scope, "app-telemetry-owner-changed"); retire(); return; }
                if (collection && (!scope.native?.requestOrigins?.has(requestId) || scope.native.requestOriginsTruncated)) {
                    stop(scope, "app-telemetry-association"); retire(); return;
                }
                if ((!collection && telemetryPosts.size + fetchOnlyTelemetry.size >= telemetryAttemptLimit) || telemetryPosts.has(requestId)) {
                    stop(scope, label + "-limit"); retire(); return;
                }
                const observation = { networkId: requestId, frameId, url: requestUrl, method,
                    type: type?.toLowerCase(), original: true, owned: ownsFrame(frameId),
                    initiatorType: initiator?.type, scriptUrl: initiator?.stack?.callFrames?.[0]?.url };
                const proof = Promise.resolve((appTelemetry ? qualifyAppTelemetry : allowAuthTelemetryDenial)(scope, observation))
                    .then(value => ({ value }), error => ({ error }));
                telemetryPosts.set(requestId, { scope, observation, proof, app: Boolean(appTelemetry), collection });
            } else if (method === "OPTIONS") {
                if (telemetryPreflights.size >= telemetryAttemptLimit || telemetryPreflights.has(requestId)
                    || initiator?.type !== "preflight" || typeof initiator.requestId !== "string") {
                    stop(scope, "auth-telemetry-association"); retire(); return;
                }
                telemetryPreflights.set(requestId, { scope, frameId, url: requestUrl, initiatorId: initiator.requestId });
            }
            if (method === "POST" || method === "OPTIONS") return;
        }
        if (observeNetworkDocument && type === "Document") observeNetworkDocument(scope, {
            networkId: requestId, frameId, requestUrl, method, original: !Object.hasOwn(event, "redirectResponse"),
            hasUserGesture: typeof event.hasUserGesture === "boolean" ? event.hasUserGesture : null,
            initiatorType: initiator?.type, initiatorUrl: initiator?.url,
            frames: (initiator?.stack?.callFrames ?? []).slice(0, 16).map(({ url, lineNumber, columnNumber }) => ({ url, lineNumber, columnNumber })),
            stackTruncated: (initiator?.stack?.callFrames?.length ?? 0) > 16 || Boolean(initiator?.stack?.parent || initiator?.stack?.parentId),
        });
        const blockedChildEntry = blockedFrames.get(frameId);
        if (blockedChildEntry?.scope === scope && blockedChildEntry.errorDocument && frameId === blockedChildEntry.frameId
            && ownsFrame(frameId) && method === "GET" && type === "Image" && requestUrl.startsWith("data:image/png;base64,")
            && requestUrl.length <= 65536 && !Object.hasOwn(event, "redirectResponse")) {
            const context = denialContext(scope);
            if (!context || context.id !== blockedChildEntry.authorizationContext) {
                stop(scope, "bootstrap-child-error-correlation"); retire(); return;
            }
            if (++childErrorImageCount > 4 * contextLimit || ++context.images > 4 || childErrorImages.has(requestId)) {
                stop(scope, "bootstrap-child-error-limit"); retire(); return;
            }
            childErrorImages.set(requestId, { scope, frameId, authorizationContext: context.id, finished: false });
            return;
        }
        if (blockedBootstrapChild && URL.parse(requestUrl)?.origin === blockedBootstrapChild.origin
            && method === "GET" && type === "Document" && frameId !== mainFrameId && ownsFrame(frameId)
            && !Object.hasOwn(event, "redirectResponse")) {
            if (childRequest || childBlocks || typeof requestId !== "string" || !requestId || requestId.length > 256) {
                stop(scope, "bootstrap-child-limit"); retire(); return;
            }
            childRequest = { scope, networkId: requestId, frameId, url: requestUrl,
                initiatorUrl: initiator?.type === "parser" ? initiator.url
                    : initiator?.type === "script" ? initiator.stack?.callFrames?.[0]?.url : undefined };
        }
        if (Object.hasOwn(event, "redirectResponse")) cached.delete(requestId);
        if (preflightCandidate && !Object.hasOwn(event, "redirectResponse")) {
            const facts = { url: URL.parse(requestUrl), method, type: type?.toLowerCase(), navigation: false,
                original: true, owned: ownsFrame(frameId) };
            if (method === "GET" && facts.owned && ["Fetch", "XHR"].includes(type) && preflightCandidate(scope, facts)) {
                if (nativeGets.size >= 8 || nativeGets.has(requestId)) { stop(scope, "native-preflight-cap"); retire(); return; }
                nativeGets.set(requestId, { scope, frameId, url: requestUrl, facts, consumed: false,
                    document: scope.native?.currentDocument, epoch: scope.native?.currentDocument?.epoch });
            } else if (method === "OPTIONS" && initiator?.type === "preflight"
                && preflightCandidate(scope, { ...facts, method: "GET", type: "fetch" })) {
                if (nativePreflights.size >= 8 || nativePreflights.has(requestId)
                    || typeof initiator.requestId !== "string" || !initiator.requestId || initiator.requestId.length > 256) {
                    stop(scope, "native-preflight-cap"); retire(); return;
                }
                nativePreflights.set(requestId, { initiatorId: initiator.requestId, scope, frameId, url: requestUrl });
            }
        }
        if (!["GET", "OPTIONS"].includes(method)) return;
        const url = URL.parse(requestUrl);
        if (!url || !isSelfUrl(url)) return;
        if (Object.hasOwn(event, "redirectResponse")) {
            if (selfGet?.id === requestId || selfPreflight?.id === requestId) retireSelf();
            return;
        }
        if (typeof requestId !== "string" || !requestId || requestId.length > 256) return;
        if (method === "GET" && frameId === mainFrameId && ["Fetch", "XHR"].includes(type)
            && !selfGet && !scope.accountSelf?.protocolConsumed && !scope.accountSelfPreflight?.consumed) {
            selfGet = { id: requestId, url: requestUrl, scope };
        } else if (method === "OPTIONS" && selfGet?.scope === scope && selfGet.url === requestUrl
            && initiator?.type === "preflight" && initiator.requestId === selfGet.id
            // Network may omit the preflight frame; Fetch must still supply the exact owned frame.
            && (frameId === undefined || frameId === mainFrameId) && !selfPreflight && !scope.accountSelfPreflight?.consumed) {
            selfPreflight = { id: requestId, url: requestUrl, scope };
        }
    });
    for (const event of ["Network.loadingFinished", "Network.loadingFailed"]) protocol.on(event, ({ requestId }) => {
        const terminal = event === "Network.loadingFailed" ? "failed" : "finished";
        const local = localImages.get(requestId);
        if (local) {
            if (!active) return;
            if (local.scope !== getScope() || local.scope.abort.signal.aborted || !local.proof.current()) {
                stopNetwork(getScope(), "network-scope-mismatch", null, terminal); return;
            }
            if (local.terminal) {
                stopNetwork(local.scope, local.terminal === terminal ? "network-terminal-duplicate" : "network-terminal-conflict", null, terminal);
                return;
            }
            if (terminal !== "finished" || !local.response) {
                stopNetwork(local.scope, "network-completion-state", null, terminal); return;
            }
            local.terminal = terminal;
            const outcome = local.scope.native.localImages ??= { completed: 0, sourceQualified: false, disposition: "embedded-image-no-network-authority" };
            outcome.completed++;
            return;
        }
        const localImage = childErrorImages.get(requestId);
        if (localImage) {
            if (event !== "Network.loadingFinished" || localImage.finished
                || localImage.scope !== getScope() || !ownsFrame(localImage.frameId)) {
                stop(localImage.scope, "bootstrap-child-error-correlation"); retire(); return;
            }
            localImage.finished = true;
            return;
        }
        const blockedChildEntry = [...blockedFrames.values()].find(entry => entry.networkId === requestId);
        if (blockedChildEntry?.networkId === requestId && blockedChildEntry.terminal === "failed"
            && event === "Network.loadingFinished" && blockedChildEntry.errorDocument && !blockedChildEntry.errorDocumentFinished
            && blockedChildEntry.abortAcknowledged && blockedChildEntry.scope === getScope() && ownsFrame(blockedChildEntry.frameId)) {
            blockedChildEntry.errorDocumentFinished = true;
            return;
        }
        cached.delete(requestId);
        nativePreflights.delete(requestId);
        const completedGet = nativeGets.get(requestId);
        if (completedGet) {
            nativeGets.delete(requestId);
            for (const [id, pair] of nativePreflights) if (pair.initiatorId === requestId) nativePreflights.delete(id);
        }
        const idle = idleBlocks.get(requestId);
        if (idle) {
            if (event !== "Network.loadingFailed") { stop(getScope(), "idle-block-completed"); retire(); return; }
            idle.terminal = true;
            if (idle.acknowledged) idleBlocks.delete(requestId);
            return;
        }
        const retiredEntry = networkRequests.get(requestId);
        if (keepIdle && retiredEntry?.scope.abort.signal.aborted) { retireRequest(retiredEntry); return; }
        if (selfGet?.id === requestId) retireSelf();
        else if (selfPreflight?.id === requestId) selfPreflight = null;
        const scope = active ? getScope() : null;
        if (!scope || scope.abort.signal.aborted) return;
        const entry = networkRequests.get(requestId);
        // Network IDs bind terminal events; cross-domain resource classifications are not identity.
        if (!entry) {
            const networkRecord = scope.native?.networkRecordObservations?.get(requestId) ?? {
                observation: scope.native?.networkRecordObservationsCapped ? "capped" : "unobserved",
                resourceType: "unobserved", urlClass: "unobserved", frame: "unobserved",
                document: "unobserved", loader: "unobserved",
            };
            stopNetwork(scope, "network-record-missing", null, terminal, networkRecord);
            return;
        }
        if (entry.scope !== scope) {
            stopNetwork(scope, "network-scope-mismatch", entry, terminal);
            return;
        }
        if (!ownsFrame(entry.frameId)) {
            stopNetwork(scope, "network-frame-mismatch", entry, terminal);
            return;
        }
        if (entry.terminal !== null) {
            stopNetwork(scope, entry.terminal === (event === "Network.loadingFailed" ? "failed" : "finished")
                ? "network-terminal-duplicate" : "network-terminal-conflict", entry, terminal);
            return;
        }
        if (preservedTransportKind(entry.kind)) {
            entry.terminal = event === "Network.loadingFailed" ? "failed" : "finished";
            settleBootstrapTransport(entry);
            return;
        }
        if (["native-health-ping", "native-worker-preflight"].includes(entry.kind)) {
            // Original ancillary responses/rejections stay with their reviewed native consumer.
            entry.terminal = event === "Network.loadingFailed" ? "failed" : "finished";
            if (entry.state !== "request" || observeTerminal?.(scope, entry) !== true) {
                stopNetwork(scope, entry.kind === "native-health-ping"
                    ? "health-ping-terminal-unqualified" : "worker-preflight-terminal-unqualified", entry, terminal);
                return;
            }
            retireRequest(entry);
            return;
        }
        if (event === "Network.loadingFailed") {
            if (entry.state !== "policy-block") { stopNetwork(scope, "request-failed", entry, terminal); return; }
            if (entry.collectionLoggerProof && !entry.collectionLoggerProof()) {
                stopNetwork(scope, "app-telemetry-owner-changed", entry, terminal); return;
            }
            if (entry.cspReportProof && (!collectionCurrent(scope) || !entry.cspReportProof.current()
                || Date.now() >= entry.cspReportProof.deadline)) {
                stopNetwork(scope, "network-scope-mismatch", entry, terminal); return;
            }
            if (entry.deniedImageProof && (!entry.deniedImageProof.current()
                || Date.now() >= entry.deniedImageProof.deadline)) {
                stopNetwork(scope, Date.now() >= entry.deniedImageProof.deadline ? "capacity-deadline" : "operation-closed", entry, terminal);
                return;
            }
            entry.terminal = "failed";
            acknowledgeChildBlock(entry, "networkFailed");
            if (entry.kind === "blocked-auth-telemetry-post") scope.blockedAuthTelemetry.failedPosts++;
            if (entry.kind === "blocked-app-events-post") scope.blockedAppEvents.failedPosts++;
            if (entry.kind === "blocked-auth-telemetry-preflight") scope.blockedAuthTelemetry.failedPreflights++;
            if (entry.kind === "blocked-dependency-get") scope.blockedDependencyPreflights.failedGets++;
            if (entry.kind === "blocked-dependency-preflight") scope.blockedDependencyPreflights.failedPreflights++;
            if (entry.kind === "blocked-chat-action") scope.blockedChatActions.failedPosts++;
            if (entry.kind === "blocked-chat-action-preflight") scope.blockedChatActions.failedPreflights++;
            if (entry.kind === "blocked-csp-report") scope.blockedCspReports.failed++;
            if (abortConfirmed(entry)) retireRequest(entry);
        } else {
            if (entry.state === "policy-block") {
                stopNetwork(scope, "network-block-completed", entry, terminal);
                return;
            }
            if (entry.state !== "complete") {
                stopNetwork(scope, "network-completion-state", entry, terminal);
                return;
            }
            entry.terminal = "finished";
            observeTerminal?.(scope, entry);
            if (entry.responseAcknowledged) retireRequest(entry);
        }
    });
    protocol.on("Fetch.requestPaused", ({ requestId, networkId, frameId, redirectedRequestId, resourceType,
        responseStatusCode, responseErrorReason, request }) => {
        const { url: requestUrl, method } = request;
        const scope = active ? getScope() : null;
        let facts = null, capacityTicket = null;
        return track((async () => {
            const fail = async (reason, capacityEvidence, bindingEvidence) => {
                const telemetryPair = telemetryPreflights.get(networkId);
                const telemetryPost = telemetryPosts.get(telemetryPair?.initiatorId ?? networkId);
                const telemetryOriginal = telemetryPost?.observation, telemetryEntry = telemetryPost?.entry;
                const telemetryAssociation = reason.startsWith("auth-telemetry-") ? {
                    fetchNetworkIdPresent: typeof networkId === "string" && networkId.length > 0,
                    originalObserved: Boolean(telemetryOriginal), originalScopeCurrent: telemetryPost?.scope === scope,
                    originalOwned: telemetryOriginal?.owned === true,
                    originalType: ["fetch", "xhr", "ping", "other"].includes(telemetryOriginal?.type) ? telemetryOriginal.type : null,
                    originalMainFrame: telemetryOriginal?.frameId === mainFrameId, fetchMainFrame: frameId === mainFrameId,
                    sameFrame: telemetryOriginal?.frameId === frameId, sameUrl: telemetryOriginal?.url === requestUrl,
                    originalRequest: telemetryOriginal?.original === true,
                    preflightObserved: Boolean(telemetryPair), preflightAlreadyBound: Boolean(telemetryPost?.preflight),
                    entryObserved: Boolean(telemetryEntry), entryLinkedPreflight: Boolean(telemetryEntry?.linkedPreflight),
                    entryAwaitingFetch: telemetryEntry?.requestId === null,
                    entryRequestMatches: telemetryEntry?.requestId === requestId,
                    entryNetworkMatches: Boolean(telemetryEntry && typeof networkId === "string" && telemetryEntry.networkId === networkId),
                    entryTerminal: telemetryEntry?.terminal ?? null,
                } : null;
                const priorDenial = scope?.native?.denial;
                if (scope) stop(scope, reason, facts, capacityEvidence || bindingEvidence ? {
                    ...(capacityEvidence ? { capacity: capacityEvidence } : {}),
                    ...(bindingEvidence ? { binding: bindingEvidence } : {}),
                } : undefined);
                if (telemetryAssociation && scope?.native?.denial && (!priorDenial
                    || priorDenial.reason === reason && priorDenial.provenance?.fetch?.networkId === networkId)) {
                    scope.native.denial.telemetryAssociation = telemetryAssociation;
                }
                retire();
                const blocked = protocol.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                const diagnosisPage = scope?.page;
                const diagnosis = diagnoseFrames && reason === "unowned-frame" && scope
                    ? diagnoseAccountFrame(protocol, { mainFrameId, frameId, scope, getScope }) : null;
                try { await blocked; }
                finally {
                    if (diagnosis) {
                        const result = await diagnosis;
                        scope.accountFrameDiagnosis = getScope() === scope && scope.page === diagnosisPage
                            && diagnosisPage && !diagnosisPage.isClosed() ? result
                            : { classification: "unresolved", rootMatchesPinned: null };
                    }
                }
            };
            if (keepIdle && active && (!scope || scope.abort.signal.aborted)) {
                if (typeof networkId !== "string" || !networkId || idleBlocks.has(networkId)
                    || idleBlocks.size + activeEntries().size + reservedSlots() >= capacity) {
                    retire();
                    await protocol.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                    return;
                }
                const prior = requests.get(requestId);
                if (prior) retireRequest(prior);
                const idle = { acknowledged: false, terminal: false };
                idleBlocks.set(networkId, idle);
                await protocol.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                idle.acknowledged = true;
                if (idle.terminal) idleBlocks.delete(networkId);
                return;
            }
            if (!scope || scope.abort.signal.aborted) return await fail("operation-closed");
            const type = resourceType === "Preflight" ? "other" : resourceType.toLowerCase();
            const response = responseStatusCode !== undefined || responseErrorReason !== undefined;
            if (localImages.has(networkId)) return await fail("network-id-reused");
            const entry = requests.get(requestId);
            facts = { url: URL.parse(requestUrl), method, type, navigation: type === "document", owned: ownsFrame(frameId),
                networkId, frameId,
                original: entry ? entry.hops === 1 : redirectedRequestId === undefined, stage: response ? "response" : "request",
                selfPreflightAssociated: selfPreflight?.scope === scope && selfPreflight.id === networkId
                    && selfPreflight.url === requestUrl && selfGet?.scope === scope && selfGet.url === requestUrl };
            if (networkId === undefined && !response && redirectedRequestId === undefined && method === "POST"
                && ["ping", "xhr"].includes(type) && facts.owned && frameId === mainFrameId
                && allowFetchOnlyTelemetryDenial?.(scope, facts) === true) {
                if (fetchOnlyTelemetry.has(requestId) || telemetryDeniedIds.has(requestId)) {
                    stop(scope, "fetch-only-denial-duplicate", facts); retire(); return;
                }
                if (typeof requestId !== "string" || !requestId || requestId.length > 256
                    || requests.has(requestId)
                    || [...telemetryPosts.values()].some(post => post.entry?.requestId === requestId
                        || post.preflight?.requestId === requestId)
                    || telemetryPosts.size + fetchOnlyTelemetry.size >= telemetryAttemptLimit) return await fail("fetch-only-denial-limit");
                fetchOnlyTelemetry.add(requestId);
                fetchOnlyPending.add(requestId);
                telemetryDeniedIds.add(requestId);
                const outcome = scope.blockedFetchOnlySinkRequests ??= { pauses: 0, acknowledged: 0,
                    originalNetwork: "unavailable", initiator: "unavailable", networkTerminal: "unavailable",
                    disposition: "fetch-only-denied-no-continuation" };
                outcome.pauses++;
                const acknowledgement = await protocol.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)
                    || Object.keys(acknowledgement).length !== 0) {
                    stop(scope, "fetch-only-denial-acknowledgement", facts); retire(); return;
                }
                if (!active || scope !== getScope() || scope.abort.signal.aborted || !ownsFrame(frameId)
                    || allowFetchOnlyTelemetryDenial(scope, facts) !== true) {
                    stop(scope, "fetch-only-denial-owner-changed", facts); retire(); return;
                }
                outcome.acknowledged++;
                fetchOnlyPending.delete(requestId);
                return;
            }
            if (networkId === undefined && !response) return await fail("network-id-missing");
            let previous = null, chatPost = null, chatPreflightProof = null;
            if (!response) {
                if (!facts.owned) return await fail("unowned-frame");
                if (chatActionUrl && scope.native?.requestOrigins?.get(networkId)?.chatActionDenied) {
                    return await fail("chat-action-association");
                }
                if (typeof requestId !== "string" || !requestId || requestId.length > 256) return await fail("request-correlation");
                if (entry) return await fail("request-correlation");
                previous = redirectedRequestId === undefined ? null : requests.get(redirectedRequestId);
                if (redirectedRequestId !== undefined && (!previous || previous.scope !== scope || previous.state !== "redirect")) {
                    return await fail("redirect-correlation");
                }
                if (typeof networkId !== "string" || !networkId || networkId.length > 256) return await fail("network-id-invalid");
                if (previous && previous.networkId !== networkId) return await fail("network-redirect-id-mismatch");
                const drainedPost = telemetryPosts.get(networkId);
                const existing = drainedPost?.scope === scope && drainedPost.entry?.kind === "blocked-auth-telemetry-post"
                    ? drainedPost.entry : null;
                if (networkRequests.has(networkId) && networkRequests.get(networkId) !== previous
                    && networkRequests.get(networkId) !== existing) return await fail("network-id-reused");
                if ((previous?.hops ?? 0) >= 20) return await fail("protocol-cap", capacitySummary());
                if (method === "OPTIONS" && chatActionUrl?.(scope, facts.url)) {
                    const link = chatActionPreflight?.(scope, facts);
                    chatPost = networkRequests.get(link?.networkId);
                    if (!link || !chatPost || chatPost.scope !== scope || chatPost.kind !== "blocked-chat-action"
                        || chatPost.state !== "policy-block" || chatPost.terminal !== null || chatPost.chatPreflight
                        || chatPost.frameId !== frameId || chatPost.url !== requestUrl
                        || !chatPost.chatActionProof?.current() || !link.current()) return await fail("chat-action-preflight");
                    chatPreflightProof = link;
                }
                const chatBinding = chatPost ? { deadline: chatPost.chatActionProof.deadline,
                    current: () => chatPost.chatActionProof.current() && chatPreflightProof.current() } : null;
                const reservation = reserveAdmission(scope, facts, requestId, networkId, previous, existing, chatPost, chatBinding);
                if (reservation.error) return await fail(reservation.error, capacitySummary(), reservation.binding);
                capacityTicket = reservation.ticket;
                if (chatPost) chatPost.chatPreflight = requestId;
                const association = capacityTicket.binding?.associate ? await capacityTicket.binding.associate() : null;
                const refusal = association ?? (capacityTicket.reserved ? null : await capacityTicket.ready);
                if (refusal) {
                    if (!active || scope.abort.signal.aborted) {
                        await protocol.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                        return;
                    }
                    return await fail(refusal, capacitySummary(), capacityTicket.binding?.failureEvidence?.(refusal));
                }
                if (!ticketCurrent(capacityTicket)) return await fail("capacity-owner-changed", capacitySummary(),
                    capacityTicket.binding?.failureEvidence?.("capacity-owner-changed"));
                if (capacityTicket.binding && Date.now() >= capacityTicket.binding.deadline) {
                    return await fail("capacity-deadline", capacitySummary(), capacityTicket.binding.failureEvidence?.("capacity-deadline"));
                }
            }
            let telemetryPost = null;
            const denyTelemetry = async () => {
                const acknowledgement = await protocol.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                if (!acknowledgement || typeof acknowledgement !== "object"
                    || Array.isArray(acknowledgement) || Object.keys(acknowledgement).length !== 0) {
                    stop(scope, "auth-telemetry-acknowledgement", facts); retire(); return false;
                }
                if (!active || scope !== getScope() || scope.abort.signal.aborted
                    || !ownsFrame(frameId) || !telemetryPost.currentProof()) {
                    stop(scope, "auth-telemetry-owner-changed", facts); retire(); return false;
                }
                return true;
            };
            const cspReport = type === "cspviolationreport" && Boolean(bindCspReport);
            const appTelemetry = !cspReport && method === "POST" && qualifyAppTelemetry && appEventsDestination(facts.url);
            if (!response && !cspReport && (allowAuthTelemetryDenial && telemetryUrl(facts.url) && ["POST", "OPTIONS"].includes(method) || appTelemetry)) {
                const label = appTelemetry ? "app-telemetry" : "auth-telemetry";
                const until = Date.now() + 1000;
                while (active && scope === getScope() && !scope.abort.signal.aborted && Date.now() < until
                    && (method === "POST" ? !telemetryPosts.has(networkId)
                        : !telemetryPosts.has(telemetryPreflights.get(networkId)?.initiatorId))) {
                    await delay(10, undefined, { signal: scope.abort.signal });
                }
                const pair = method === "OPTIONS" ? telemetryPreflights.get(networkId) : null;
                telemetryPost = telemetryPosts.get(pair ? pair.initiatorId : networkId);
                const original = telemetryPost?.observation;
                if (!telemetryPost || telemetryPost.app !== Boolean(appTelemetry)
                    || telemetryPost.scope !== scope || !original?.owned || original.frameId !== mainFrameId
                    || frameId !== original.frameId || !facts.owned || !facts.original || facts.navigation
                    || requestUrl !== original.url || !(appTelemetry ? ["fetch", "xhr"] : ["fetch", "xhr", "ping"]).includes(original.type)
                    || method === "OPTIONS" && (!pair || pair.scope !== scope || pair.url !== requestUrl
                        || pair.frameId !== undefined && pair.frameId !== frameId || telemetryPost.preflight)) {
                    return await fail(label + "-association");
                }
                const proof = await telemetryPost.proof;
                if (proof.error) throw proof.error;
                if (typeof proof.value !== "function" || proof.value() !== true) return await fail(label + "-role");
                telemetryPost.currentProof = () => proof.value() === true
                    && (!telemetryPost.collection || collectionCurrent(scope));
                if (!telemetryPost.currentProof()) return await fail(label + "-role");
                const completed = telemetryPost.entry;
                if (method === "POST" && original.type === "ping" && completed?.kind === "blocked-auth-telemetry-post"
                    && !completed.linkedPreflight && completed.terminal === "failed" && completed.abortAcknowledged
                    && completed.requestId !== requestId && !telemetryPost.latePauseUsed) {
                    telemetryPost.latePauseUsed = true;
                    telemetryLatePauses.add(requestId);
                    telemetryDeniedIds.add(requestId);
                    if (!await denyTelemetry()) return;
                    scope.blockedAuthTelemetry.latePostPauses = (scope.blockedAuthTelemetry.latePostPauses ?? 0) + 1;
                    telemetryLatePauses.delete(requestId);
                    return;
                }
                if (method === "POST" && telemetryPost.entry?.linkedPreflight) {
                    const linked = telemetryPost.entry;
                    if (linked.terminal !== null || linked.requestId !== null) return await fail("auth-telemetry-association");
                    linked.requestId = requestId;
                    requests.set(requestId, linked);
                    releaseAdmission(capacityTicket);
                    capacityTicket = null;
                    telemetryDeniedIds.add(requestId);
                    if (!await denyTelemetry()) return;
                    linked.abortAcknowledged = true;
                    if (linked.terminal === "failed") retireRequest(linked);
                    return;
                }
            }
            if (response) {
                if (!entry || entry.scope !== scope || !ownsFrame(frameId) || frameId !== entry.frameId || entry.url !== requestUrl
                    || entry.networkId !== networkId || entry.method !== method || entry.type !== type) {
                    return await fail("response-correlation");
                }
                if (preservedTransportKind(entry.kind)) {
                    const nativeError = responseErrorReason !== undefined;
                    if (entry.state !== "request" || entry.responseSeen
                        || (responseStatusCode !== undefined || !nativeError) && (!Number.isInteger(responseStatusCode)
                            || responseStatusCode < 200 || responseStatusCode > 599 || responseStatusCode >= 300 && responseStatusCode < 400)
                        || nativeError && !nativeResponseErrors.has(responseErrorReason)
                        || !bootstrapTransportCurrent(entry)) {
                        return await fail("bootstrap-transport-response-error");
                    }
                    entry.responseSeen = true;
                    if (nativeError) entry.nativeResponseError = responseErrorReason;
                    entry.responsePending = true;
                    const acknowledgement = await protocol.send(nativeError ? "Fetch.failRequest" : "Fetch.continueResponse",
                        nativeError ? { requestId, errorReason: responseErrorReason } : { requestId });
                    if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)
                        || Object.keys(acknowledgement).length !== 0) {
                        stopNetwork(scope, "bootstrap-transport-acknowledgement", entry); return;
                    }
                    entry.responsePending = false;
                    entry.responseAcknowledged = true;
                    if (!bootstrapTransportCurrent(entry)) {
                        stopNetwork(scope, "bootstrap-transport-unqualified", entry); return;
                    }
                    if (entry.terminal !== null) settleBootstrapTransport(entry);
                    return;
                }
                if (responseErrorReason !== undefined || !Number.isInteger(responseStatusCode)) return await fail("response-failed");
                if (entry.state !== "request") return await fail("response-correlation");
                const readFailure = responseStatusCode === 503 && method === "GET"
                    && allowReadFailureResponse?.(scope, entry) === true;
                const unavailable = allowUnavailableResponse?.(scope, entry, responseStatusCode) === true;
                if (!readFailure && !unavailable && !acceptResponse(scope, entry.kind, responseStatusCode)) return await fail("response-failed");
                const redirect = responseStatusCode >= 300 && responseStatusCode < 400;
                if (entry.kind === "token" && (redirect || responseStatusCode < 200 || responseStatusCode >= 600)) {
                    return await fail(redirect ? "token-redirect" : "response-failed");
                }
                if (entry.kind === "self" && (responseStatusCode < 200 || responseStatusCode >= 300)) return await fail("self-response");
                if (entry.kind === "self-preflight" && (responseStatusCode < 200 || responseStatusCode >= 300)) return await fail("self-preflight-response");
                if (entry.kind === "self" && !scope.accountSelf.routed) return await fail("response-correlation");
                if (entry.kind !== "token" && !readFailure && !unavailable && (responseStatusCode < 200 || responseStatusCode >= 400)) return await fail("response-failed");
                entry.state = [301, 302, 303, 307, 308].includes(responseStatusCode) ? "redirect" : "complete";
                entry.responseStatus = responseStatusCode;
                entry.readFailureResponse = readFailure;
                entry.unavailableResponse = unavailable;
                observeResponse?.(scope, entry);
                const acknowledgement = await protocol.send("Fetch.continueResponse", { requestId });
                if (readFailure && (!acknowledgement || typeof acknowledgement !== "object"
                    || Array.isArray(acknowledgement) || Object.keys(acknowledgement).length
                    || scope !== getScope() || scope.abort.signal.aborted
                    || allowReadFailureResponse(scope, entry) !== true)) return await fail("response-failed");
                if (unavailable && (!acknowledgement || typeof acknowledgement !== "object"
                    || Array.isArray(acknowledgement) || Object.keys(acknowledgement).length
                    || allowUnavailableResponse(scope, entry, responseStatusCode) !== true)) return await fail("response-failed");
                entry.responseAcknowledged = true;
                responded(scope, entry.kind, method, responseStatusCode, entry);
                if (entry.kind === "self") retireSelf();
                if (entry.terminal === "finished") retireRequest(entry);
                return;
            }
            if (method === "GET" && facts.url && isSelfUrl(facts.url) && scope.accountSelfPreflight?.consumed
                && !scope.accountSelf.protocolConsumed
                && (selfGet?.scope !== scope || selfGet.id !== networkId || selfGet.url !== requestUrl)) {
                return await fail("self-preflight-association");
            }
            let pair = method === "OPTIONS" ? nativePreflights.get(networkId) : null;
            if (method === "OPTIONS" && !telemetryPost && !chatPost && admitPreflight
                && preflightCandidate?.(scope, { ...facts, method: "GET", type: "fetch" })) {
                const until = Date.now() + 1000;
                while ((!pair || !nativeGets.has(pair.initiatorId)) && active && scope === getScope()
                    && !scope.abort.signal.aborted && Date.now() < until) {
                    await delay(10, undefined, { signal: scope.abort.signal });
                    pair = nativePreflights.get(networkId);
                }
            }
            const pairedGet = pair ? nativeGets.get(pair.initiatorId) : null;
            let admission, cspReportProof;
            const candidateChild = blockedBootstrapChild && facts.url?.origin === blockedBootstrapChild.origin
                && facts.owned && facts.original && facts.navigation && type === "document" && method === "GET"
                && frameId !== mainFrameId;
            if (candidateChild) {
                const until = Date.now() + 1000;
                while (!childRequest && active && scope === getScope() && !scope.abort.signal.aborted && Date.now() < until) {
                    await delay(10, undefined, { signal: scope.abort.signal });
                }
                if (childBlocks || !childRequest || childRequest.scope !== scope || childRequest.networkId !== networkId
                    || childRequest.frameId !== frameId || childRequest.url !== requestUrl
                    || typeof childRequest.initiatorUrl !== "string"
                    || await blockedBootstrapChild.qualify(scope, frameId, childRequest.initiatorUrl) !== true) {
                    return await fail("bootstrap-child-association");
                }
                childBlocks++;
                admission = "blocked-bootstrap-child";
            } else if (!chatPost && pair && admitPreflight && pair.scope === scope && pair.url === requestUrl
                && pairedGet?.scope === scope && pairedGet.url === requestUrl && pairedGet.frameId === frameId
                && (pair.frameId === undefined || pair.frameId === frameId)
                && ownsFrame(frameId) && !pairedGet.consumed && facts.original) {
                pairedGet.consumed = true;
                admission = admitPreflight(scope, pairedGet.facts, pairedGet);
            } else if (telemetryPost) {
                admission = telemetryPost.app ? "blocked-app-events-post"
                    : method === "OPTIONS" ? "blocked-auth-telemetry-preflight" : "blocked-auth-telemetry-post";
            } else if (chatPost) admission = "blocked-chat-action-preflight";
            else if (cspReport) {
                if (!collectionCurrent(scope) || method !== "POST" || !facts.original || facts.navigation
                    || !facts.owned || frameId !== mainFrameId || facts.url?.protocol !== "https:"
                    || facts.url.username || facts.url.password || requestUrl.length > 16384) return await fail("policy-block-scope");
                cspReportProof = await bindCspReport(scope, facts);
                if (!cspReportProof || typeof cspReportProof.current !== "function" || typeof cspReportProof.check !== "function"
                    || !Number.isFinite(cspReportProof.deadline) || !await cspReportProof.check()
                    || !cspReportProof.current() || !collectionCurrent(scope)
                    || Date.now() >= cspReportProof.deadline) return await fail("policy-block-scope");
                admission = "blocked-csp-report";
            }
            else admission = admit(scope, facts, "protocol", () => request.postData);
            const kind = admission && typeof admission.then === "function" ? await admission : admission;
            if (!kind) return await fail(scope.accountDenied ?? "request-scope");
            if (!active || scope !== getScope() || scope.abort.signal.aborted) return await fail("operation-closed");
            if (!ticketCurrent(capacityTicket)) return await fail("capacity-owner-changed", capacitySummary(),
                capacityTicket.binding?.failureEvidence?.("capacity-owner-changed"));
            if (capacityTicket.binding && Date.now() >= capacityTicket.binding.deadline) {
                return await fail("capacity-deadline", capacitySummary(), capacityTicket.binding.failureEvidence?.("capacity-deadline"));
            }
            if (previous && requests.get(previous.requestId) !== previous) return await fail("redirect-correlation");
            if (!ownsFrame(frameId)) return await fail("unowned-frame");
            const chatBlocked = kind === "blocked-chat-action" || kind === "blocked-chat-action-preflight";
            let chatProof;
            if (chatBlocked) {
                if (!facts.original || facts.navigation || frameId !== mainFrameId || !chatActionUrl?.(scope, facts.url)
                    || (chatPost ? method !== "OPTIONS" : method !== "POST" || !["fetch", "xhr"].includes(type))) {
                    return await fail("chat-action-association");
                }
                chatProof = chatPost ? { deadline: chatPost.chatActionProof.deadline,
                    current: () => chatPost.chatActionProof.current() && chatPreflightProof.current(),
                    check: async () => await chatPost.chatActionProof.check() && await chatPreflightProof.check() }
                    : await bindChatAction?.(scope, facts);
                if (!chatProof || typeof chatProof.current !== "function" || !Number.isFinite(chatProof.deadline)
                    || typeof chatProof.check !== "function" || !await chatProof.check() || !ticketCurrent(capacityTicket)
                    || !chatProof.current() || Date.now() >= chatProof.deadline
                    || chatPost && (chatPost.chatPreflight !== requestId
                        || ![null, "failed"].includes(chatPost.terminal))) return await fail("chat-action-association");
                const count = scope.blockedChatActions ??= { posts: 0, preflights: 0, acknowledged: 0,
                    failedPosts: 0, failedPreflights: 0, disposition: "denied-different-action" };
                if (count.posts + count.preflights >= nativeRequestOriginLimit) return await fail("chat-action-limit");
                count[chatPost ? "preflights" : "posts"]++;
            }
            let deniedImageProof;
            if (kind === "policy-block") {
                if (!facts.owned || !facts.original || facts.navigation || method !== "GET") return await fail("policy-block-scope");
                if (type === "image" && frameId === mainFrameId) {
                    deniedImageProof = bindDeniedImage?.(scope, facts);
                    if (!deniedImageProof || typeof deniedImageProof.current !== "function"
                        || !Number.isFinite(deniedImageProof.deadline) || !deniedImageProof.current()) return await fail("policy-block-scope");
                    if (Date.now() >= deniedImageProof.deadline) return await fail("capacity-deadline");
                } else if (!["fetch", "xhr"].includes(type)) return await fail("policy-block-scope");
            }
            if (kind === "blocked-bootstrap-child" && (!candidateChild || childBlocks !== 1)) return await fail("bootstrap-child-association");
            const blockedDocument = ["blocked-bootstrap-child", "blocked-partner-preload", "blocked-cached-session"].includes(kind);
            const context = blockedDocument ? denialContext(scope) : null;
            if (kind === "blocked-partner-preload" && (blockedBootstrapChild !== null || !facts.owned || !facts.original
                || !facts.navigation || type !== "document" || method !== "GET" || frameId === mainFrameId
                || !context || ++partnerBlocks > contextLimit || ++context.partner > 1)) return await fail("partner-preload-association");
            if (kind === "blocked-cached-session" && (blockedBootstrapChild !== null || !facts.owned || !facts.original
                || !facts.navigation || type !== "document" || method !== "GET" || frameId === mainFrameId
                || !context || ++cachedSessionBlocks > contextLimit || ++context.cached > 1)) return await fail("cached-session-association");
            if (blockedDocument && (!context || blockedFrames.has(frameId) || blockedFrames.size >= 2 * contextLimit
                || [...blockedFrames.values()].some(record => record.networkId === networkId))) return await fail("blocked-document-association");
            const blockedAppEvents = kind === "blocked-app-events-post";
            const blockedTelemetry = blockedAppEvents || kind === "blocked-auth-telemetry-post" || kind === "blocked-auth-telemetry-preflight";
            const blockedDependency = kind === "blocked-dependency-preflight";
            if (blockedDependency && (!pair || !pairedGet || method !== "OPTIONS")) return await fail("blocked-preflight-association");
            const cspBlocked = kind === "blocked-csp-report";
            const policyBlocked = kind === "policy-block" || blockedDocument || blockedTelemetry || blockedDependency || chatBlocked || cspBlocked;
            if (previous) {
                requests.delete(previous.requestId);
                networkRequests.delete(previous.networkId);
            }
            const current = { requestId, networkId, frameId, scope, facts, url: requestUrl, method, type, kind,
                state: policyBlocked ? "policy-block" : "request", hops: (previous?.hops ?? 0) + 1,
                initial: previous?.initial ?? { networkId, frameId, url: requestUrl, method, type },
                terminal: null, responseAcknowledged: false, abortAcknowledged: false, cached: cached.has(networkId) };
            requests.set(requestId, current);
            networkRequests.set(networkId, current);
            if (deniedImageProof) current.deniedImageProof = deniedImageProof;
            if (cspBlocked) {
                current.cspReportProof = cspReportProof;
                const outcome = scope.blockedCspReports ??= { reports: 0, acknowledged: 0, failed: 0,
                    sourceQualified: false, disposition: "denied-not-contacted" };
                outcome.reports++;
            }
            if (chatBlocked) {
                current.chatActionProof = chatProof;
                if (chatPost) { chatPost.chatPreflight = current; current.chatPost = chatPost; }
            }
            if (blockedDependency) {
                const originalId = pair.initiatorId;
                if (networkRequests.has(originalId)) return await fail("blocked-preflight-association");
                const outcome = scope.blockedDependencyPreflights ??= { pairs: 0, failedGets: 0, failedPreflights: 0,
                    disposition: "both-denied-not-contacted" };
                outcome.pairs++;
                current.blockedGet = { ...current, requestId: null, networkId: originalId, method: "GET",
                    type: pairedGet.facts.type, kind: "blocked-dependency-get", linkedPreflight: current,
                    facts: { ...pairedGet.facts, frameId, networkId: originalId } };
                networkRequests.set(originalId, current.blockedGet);
            }
            if (blockedTelemetry) {
                const outcome = blockedAppEvents
                    ? scope.blockedAppEvents ??= { role: "reviewed-app-logger", posts: 0, acknowledged: 0, failedPosts: 0,
                        disposition: "denied-not-contacted" }
                    : scope.blockedAuthTelemetry ??= { role: "blocked-optional-auth-collector", posts: 0, preflights: 0,
                        failedPosts: 0, failedPreflights: 0, disposition: "denied-not-contacted" };
                if (method === "POST") {
                    if (telemetryPost.entry) return await fail(blockedAppEvents ? "app-telemetry-association" : "auth-telemetry-association");
                    telemetryPost.entry = current;
                    if (telemetryPost.collection) current.collectionLoggerProof = telemetryPost.currentProof;
                    outcome.posts++;
                } else {
                    const original = telemetryPost.observation;
                    if (telemetryPost.entry || networkRequests.has(original.networkId)) return await fail("auth-telemetry-association");
                    telemetryPost.preflight = current;
                    telemetryPost.entry = { ...current, requestId: null, networkId: original.networkId, method: "POST",
                        type: original.type, kind: "blocked-auth-telemetry-post", linkedPreflight: current,
                        facts: { ...facts, method: "POST", type: original.type, networkId: original.networkId } };
                    networkRequests.set(original.networkId, telemetryPost.entry);
                    outcome.posts++; outcome.preflights++;
                }
            }
            releaseAdmission(capacityTicket);
            capacityTicket = null;
            observeRequest?.(scope, current, name => {
                const variants = {
                    "x-user-id": ["x-user-id", "X-User-ID", "X-User-Id", "X-USER-ID"],
                    "x-tenant-id": ["x-tenant-id", "X-Tenant-ID", "X-Tenant-Id", "X-TENANT-ID"],
                }[name];
                if (!variants) throw sourceError("NATIVE_SOURCE_IDENTITY_UNQUALIFIED");
                const headers = request.headers;
                if (!headers || typeof headers !== "object") return null;
                const fields = variants.map(key => Object.getOwnPropertyDescriptor(headers, key)).filter(Boolean);
                if (fields.length !== 1 || !Object.hasOwn(fields[0], "value")) return null;
                return fields[0].value;
            });
            if (scope.abort.signal.aborted || scope !== getScope()) return await fail("operation-closed");
            if (policyBlocked) {
                const first = !scope.firstPolicyBlock;
                if (first) scope.firstPolicyBlock = { reason: kind === "blocked-bootstrap-child" ? "bootstrap-child-denied"
                    : kind === "blocked-partner-preload" ? "passive-partner-preload"
                        : kind === "blocked-cached-session" ? "native-cached-session-fallback"
                            : cspBlocked ? "browser-csp-report-denied" : chatBlocked ? "different-chat-action-denied"
                            : blockedAppEvents ? "app-events-denied" : blockedTelemetry ? "auth-telemetry-denied"
                                : blockedDependency ? "dependency-preflight-denied" : "data-dependency",
                    context: accountOnlyDenialContext(facts),
                    abortAcknowledged: false };
                if (kind === "blocked-bootstrap-child") {
                    current.childBlock = scope.blockedBootstrapChild = { attempts: childBlocks, abortAcknowledged: false,
                        networkFailed: false, context: "original-owned-child-from-current-authorize", disposition: "denied-not-contacted" };
                }
                if (kind === "blocked-partner-preload") {
                    scope.blockedPartnerPreload ??= { role: "native-idPartnerPL-injectIframe", disposition: "denied-not-contacted", contexts: [] };
                    current.childBlockAggregate = scope.blockedPartnerPreload;
                    current.childBlockAggregate.attempts = partnerBlocks;
                }
                if (kind === "blocked-cached-session") {
                    scope.blockedCachedSession ??= { role: "native-interactive-cached-sessions", nativeRejectionDelayMs: 10000,
                        disposition: "denied-native-fallback-not-forged", contexts: [] };
                    current.childBlockAggregate = scope.blockedCachedSession;
                    current.childBlockAggregate.attempts = cachedSessionBlocks;
                }
                if (current.childBlockAggregate) {
                    current.childBlock = { authorizationContext: context.id, abortAcknowledged: false, networkFailed: false };
                    current.childBlockAggregate.contexts.push(current.childBlock);
                    current.childBlockAggregate.abortAcknowledged = false;
                    current.childBlockAggregate.networkFailed = false;
                }
                if (blockedDocument) {
                    current.authorizationContext = context.id;
                    blockedFrames.set(frameId, current);
                }
                if (blockedTelemetry) telemetryDeniedIds.add(requestId);
                if (chatBlocked) {
                    const acknowledgement = await protocol.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                    if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)
                        || Object.keys(acknowledgement).length !== 0) {
                        stop(scope, "chat-action-acknowledgement", facts); retire(); return;
                    }
                    if (!await chatProof.check() || !active || scope !== getScope() || scope.abort.signal.aborted || !ownsFrame(frameId)
                        || !chatProof.current() || Date.now() >= chatProof.deadline) {
                        stop(scope, "chat-action-owner-changed", facts); retire(); return;
                    }
                    scope.blockedChatActions.acknowledged++;
                } else if (blockedTelemetry && !blockedAppEvents) {
                    if (!await denyTelemetry()) return;
                } else {
                    const acknowledgement = await protocol.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
                    if (cspBlocked) {
                        if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)
                            || Object.keys(acknowledgement).length !== 0) {
                            stop(scope, "policy-abort-failed", facts); retire(); return;
                        }
                        if (!await cspReportProof.check() || !collectionCurrent(scope) || !cspReportProof.current()
                            || Date.now() >= cspReportProof.deadline) {
                            stop(scope, "operation-closed", facts); retire(); return;
                        }
                        scope.blockedCspReports.acknowledged++;
                    }
                    if (deniedImageProof) {
                        if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)
                            || Object.keys(acknowledgement).length !== 0) {
                            stop(scope, "policy-abort-failed", facts); retire(); return;
                        }
                        if (!active || scope !== getScope() || scope.abort.signal.aborted || !ownsFrame(frameId)
                            || !deniedImageProof.current() || Date.now() >= deniedImageProof.deadline) {
                            stop(scope, Date.now() >= deniedImageProof.deadline ? "capacity-deadline" : "operation-closed", facts);
                            retire(); return;
                        }
                    }
                    if (blockedAppEvents && (!acknowledgement || typeof acknowledgement !== "object"
                        || Array.isArray(acknowledgement) || Object.keys(acknowledgement).length !== 0)) {
                        stop(scope, "app-telemetry-acknowledgement", facts); retire(); return;
                    }
                }
                current.abortAcknowledged = true;
                if (blockedAppEvents) {
                    scope.blockedAppEvents.acknowledged++;
                    if (!active || scope !== getScope() || scope.abort.signal.aborted || !telemetryPost.currentProof()) {
                        stop(scope, "app-telemetry-owner-changed", facts); retire(); return;
                    }
                }
                acknowledgeChildBlock(current, "abortAcknowledged");
                if (first) scope.firstPolicyBlock.abortAcknowledged = true;
                if (current.terminal === "failed") retireRequest(current);
                if (telemetryPost?.entry?.linkedPreflight === current && telemetryPost.entry.terminal === "failed") {
                    retireRequest(telemetryPost.entry);
                }
                if (current.blockedGet?.terminal === "failed") retireRequest(current.blockedGet);
                return;
            }
            if (preservedTransportKind(kind) && !bootstrapTransportCurrent(current)) {
                return await fail("bootstrap-transport-unqualified");
            }
            const acknowledgement = await protocol.send("Fetch.continueRequest", { requestId,
                interceptResponse: !["native-health-ping", "native-worker-preflight"].includes(kind) && !preservedTransportKind(kind) });
            if (preservedTransportKind(kind)) {
                if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)
                    || Object.keys(acknowledgement).length !== 0) {
                    stopNetwork(scope, "bootstrap-transport-acknowledgement", current); return;
                }
                current.requestAcknowledged = true;
                if (!bootstrapTransportCurrent(current)) {
                    stopNetwork(scope, "bootstrap-transport-unqualified", current); return;
                }
                if (current.terminal !== null) settleBootstrapTransport(current);
            }
            if (kind === "token") scope.accountToken[method].requestContinued++;
            if (kind === "self-preflight") scope.accountSelfPreflight.requestContinued = true;
        })().catch(() => {
            if (scope && !scope.abort.signal.aborted) {
                if (requests.get(requestId)?.kind === "token") scope.accountToken.continuationFailed = true;
                stop(scope, requests.get(requestId)?.state === "policy-block" ? "policy-abort-failed" : "protocol-continuation", facts);
            }
            // Cleanup closes the owning target; never disable interception to recover.
            if (active) retire();
        }).finally(() => releaseAdmission(capacityTicket)), scope);
    });
    await protocol.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });
    await protocol.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    return { retire, authorizationContextSettled, get active() { return active; },
        beginCollection(scope) {
            if (!active || scope !== getScope() || scope.lease?.kind !== "microsoft-read" || scope.error
                || scope.abort.signal.aborted || scope.operationSignal?.aborted || pendingCount() || idleBlocks.size
                || telemetryPreflights.size || fetchOnlyTelemetry.size
                || telemetryDeniedIds.size !== telemetryPosts.size || scope.native?.requestOrigins?.size) return false;
            if (collectionScope && (!collectionScope.abort.signal.aborted
                || [...telemetryPosts.values()].some(post => !post.app || post.scope.lease !== collectionScope.lease
                    || !post.scope.abort.signal.aborted || post.entry?.kind !== "blocked-app-events-post"
                    || !telemetryDeniedIds.has(post.entry.requestId)
                    || !post.entry.abortAcknowledged || post.entry.terminal !== "failed"))) return false;
            if (!collectionScope && telemetryPosts.size) return false;
            if (collectionScope && collectionScope.lease !== scope.lease) {
                if (collectionScope.commitState !== "committed") return false;
                telemetryPosts.clear();
                telemetryDeniedIds.clear();
                collectionRecordCount = 0;
            }
            // Same-lease recovery is still the original acquisition and keeps its consumed allowance.
            collectionScope = scope;
            return true;
        },
        preserveCapacityTimeout(scope, error) {
            const ticket = [...admissions.values()].find(ticket => ticket.scope === scope
                && ticket.binding && Date.now() >= ticket.binding.deadline);
            if (error?.code === "timed-out" && scope === getScope() && ticket) {
                const binding = ticket.binding.failureEvidence?.("capacity-deadline");
                withNativeFailureProtocolStop(withNativeFailurePredicate(error, "protocol", "protocol-stop"), {
                    reason: "capacity-deadline", phase: "request", capacity: capacitySummary(),
                    ...(binding ? { binding } : {}),
                });
            }
            return error;
        },
        get idlePendingCount() { return idleBlocks.size; },
        get pendingCount() { return pendingCount(); },
        transferDeviceResponse(entry) {
            if (!active || entry.scope !== getScope() || entry.kind !== "device-risk-document"
                || entry.state !== "complete" || !entry.responseAcknowledged) throw sourceError("NATIVE_DEVICE_RISK_HANDOFF_UNQUALIFIED");
            if (entry.terminal === "finished") return null;
            if (entry.terminal !== null || requests.get(entry.requestId) !== entry || networkRequests.get(entry.networkId) !== entry
                || [...requests.values()].some(other => other !== entry && other.frameId === entry.frameId)) {
                throw sourceError("NATIVE_DEVICE_RISK_HANDOFF_UNQUALIFIED");
            }
            retireRequest(entry);
            return entry;
        },
        get selfAssociationCount() { return Number(selfGet !== null) + Number(selfPreflight !== null); } };
}

export async function profileOwners(directory) {
    if (process.platform !== "win32") throw new MicrosoftSessionError("browser-unavailable");
    const quoted = directory.replaceAll("'", "''");
    const result = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; $p='${quoted}'; $ids=@(Get-CimInstance Win32_Process -Filter "name = 'msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) } | Select-Object -ExpandProperty ProcessId); ConvertTo-Json -InputObject $ids -Compress`],
    { encoding: "utf8", windowsHide: true, timeout: 10000 });
    const owners = JSON.parse(result.stdout);
    if (!Array.isArray(owners) || owners.some(value => !Number.isSafeInteger(value))) throw new MicrosoftSessionError("cleanup-failed");
    return owners;
}

// Startup restores the local gate and committed settings only. The browser
// opens exclusively through an admitted Microsoft Connect command.
export async function createMicrosoftNativeHost(context, { configuration = null, sourceAware = false, nativeAcquisition = false,
    accountOnlyVerification = false, blockedBootstrapChildOrigin = null, observeAuthenticationChain = false,
    ordinaryStartup = false, nativeScheduling = ordinaryStartup,
    visibleSignIn = (ordinaryStartup || configuration?.mode === "native-ui-history") && !observeAuthenticationChain && blockedBootstrapChildOrigin === null,
    visibilityExperiment = false, engineering = null, enrollmentPolicy = null } = {}) {
    let normal = configuration?.mode === "native-ui-history";
    const browserOwnedSignIn = () => normal && !engineering && !observeAuthenticationChain
        && blockedBootstrapChildOrigin === null && !visibilityExperiment;
    const ordinaryPartnerPreload = (normal || ordinaryStartup) && !observeAuthenticationChain && blockedBootstrapChildOrigin === null;
    if (typeof sourceAware !== "boolean" || typeof nativeAcquisition !== "boolean" || typeof accountOnlyVerification !== "boolean"
        || typeof ordinaryStartup !== "boolean" || ordinaryStartup && (!sourceAware || accountOnlyVerification || visibilityExperiment)
        || typeof nativeScheduling !== "boolean" || nativeScheduling && (!sourceAware || accountOnlyVerification)
        || typeof visibleSignIn !== "boolean" || visibleSignIn && (!(normal || ordinaryStartup && configuration === null) || !ordinaryPartnerPreload)
        || typeof visibilityExperiment !== "boolean" || visibilityExperiment && !visibleSignIn
        || (nativeAcquisition || accountOnlyVerification) && (!sourceAware || configuration === null)
        || nativeAcquisition && accountOnlyVerification
        || normal && (!sourceAware || accountOnlyVerification)
        || typeof observeAuthenticationChain !== "boolean" || observeAuthenticationChain && !normal
        || enrollmentPolicy !== null && (!isMicrosoftNativeEnrollmentPolicy(enrollmentPolicy) || !ordinaryStartup
            || configuration !== null || existsSync(path.join(context.dataDir, "microsoft-source.json"))
            || existsSync(path.join(context.dataDir, "microsoft-native")))
        || engineering !== null && (!isHistoryEngineering(engineering) || !normal || ordinaryStartup || nativeAcquisition
            || accountOnlyVerification || observeAuthenticationChain || visibilityExperiment
            || engineering.expectedAccount.toLowerCase() !== configuration.expectedAccount.toLowerCase())
        || blockedBootstrapChildOrigin !== null && (!normal || typeof blockedBootstrapChildOrigin !== "string"
            || URL.parse(blockedBootstrapChildOrigin)?.protocol !== "https:"
            || URL.parse(blockedBootstrapChildOrigin)?.origin !== blockedBootstrapChildOrigin)
        || configuration !== null && !isMicrosoftNativeConfiguration(configuration)) {
        throw sourceError("NATIVE_HOST_CONFIGURATION_INVALID");
    }
    const target = configuration?.target;
    const applicationScriptAssets = new Set([...nativeApplicationBuilds.flatMap(build => [...build.scriptAssets, ...(build.startupScriptAssets ?? [])]),
        ...nativeCoworkBuilds.flatMap(build => build.scriptAssets), ...(engineering ? historyEngineeringAssets : [])]);
    const cachedScriptAssets = new Set(["https://aadcdn.msftauth.net", "https://aadcdn.msauth.net"]
        .map(origin => origin + new URL(nativeHistoryProducer.cachedSessionsScriptAsset).pathname));
    const helperScriptAssets = new Set([...nativeHistoryProducer.partnerPreloadScriptAssets, ...cachedScriptAssets]);
    const requiredScriptAssets = new Set([...applicationScriptAssets, ...helperScriptAssets,
        ...nativeCoworkBuilds.flatMap(build => [build.runFeedScriptAsset, build.automationDetailsScriptAsset].filter(Boolean))]);
    let expectedAccount = normal ? configuration.expectedAccount : target?.expectedAccount;
    const tokenEndpoint = target ? `https://login.microsoftonline.com/${target.expectedTenant}/oauth2/v2.0/token` : null;
    const composite = target ? decodeURIComponent(target.coworkFragment) : null;
    const sessionId = composite?.split(":")[2];
    const selectedIds = new Set(target ? [composite, sessionId, target.coworkThreadId] : []);
    const privateAssetIds = target ? [target.expectedTenant, target.expectedSubject, sessionId,
        target.coworkThreadId, target.chatPath.split("/").at(-1)]
        .filter(value => typeof value === "string" && value.length > 0)
        .flatMap(value => [value.toLowerCase(), value.toLowerCase().replaceAll("-", "")]) : [];
    const accountAlias = target?.expectedAccount.split("@")[0].toLowerCase();
    let lifecycle, persistence, access, browser, page, ownerId, attemptedOwner, lock, current, verified = false, closed = false;
    let browserClosed = true, closeTask, unsubscribe, openings = 0, epoch = 0;
    let accountProtocol = null, accountProtocolReady = false, accountGate = null, accountFailure = null, accountFailureContext = null;
    let nativeRun = null, readBootstrapFrameRole = null;
    let captureResetBinding, engineeringProjectionBinding, engineeringPrincipalKey, captureScript, browserAccount, installCaptureBinding;
    const requestScopes = new WeakMap(), pageScopes = new WeakMap(), leaseScopes = new WeakMap(), pending = new Set();
    const ownerNotifications = new AsyncResource("WIRENativeOwnerNotifications", { requireManualDestroy: true });

    function nativeOwnerLost(run, code, publicCoworkScript) {
        if (!normal || !verified || closed || !run || run !== nativeRun || ownerId !== run.ownerId || run.ownerLossReported) return;
        run.ownerLossReported = true;
        verified = false;
        // Do not put this task in pending: it owns stopOwner, whose transport
        // cleanup drains that set. Delayed callbacks cannot retire another owner.
        void lifecycle.nativeOwnerLost({ ownerId: run.ownerId, generation: run.generation,
            code: typeof code === "string" && /^NATIVE_[A-Z_]{1,93}$/.test(code) ? code : "NATIVE_BROWSER_OWNER_LOST",
            ...(publicCoworkScript ? { publicCoworkScript } : {}),
        }).catch(error => {
            console.error("[workiq-native] lost browser owner cleanup failed", { code: nativeErrorCode(error) });
        });
    }

    function revokeAppDocumentContinuity() {
        if (nativeRun) {
            nativeRun.liveAppDocument = null;
            nativeRun.discoveryCarry = null;
            nativeRun.continuityVersion = (nativeRun.continuityVersion ?? 0) + 1;
        }
        if (current?.native) current.native.appDocumentBinding = null;
    }
    function nativeFailure(scope, code) {
        if (engineering?.complete) { scope?.abort.abort(); scope?.observer.block(); return; }
        if (engineering && scope && !closed) recordNativeEngineeringFailure(engineering, code, scope);
        revokeAppDocumentContinuity();
        if (!scope || scope.abort.signal.aborted) return;
        fault(scope, code instanceof Error ? code : sourceError(code));
        scope.abort.abort();
        scope.observer.block();
        if (scope.lease && !scope.expiration) {
            scope.expiration = lifecycle.expire(scope.lease);
            void scope.expiration.catch(() => {
                scope.cleanupFailed = true;
                console.error("[workiq-native] source cleanup failed", { code: "NATIVE_SOURCE_EXPIRY_CLEANUP_FAILED" });
            });
        }
    }
    async function nativeWait(scope, ready, milliseconds, code) {
        const until = Math.min(Date.now() + milliseconds, nativeRun.deadline);
        while (!ready()) {
            if (scope.native?.readFailure?.responseAcknowledged && scope.native.readFailure.terminal === "finished") {
                throw sourceError("NATIVE_SOURCE_TRANSIENT_READ_FAILED");
            }
            if (scope.error) throw scope.error;
            if (scope !== current || scope.abort.signal.aborted || browserClosed || Date.now() >= until) {
                throw sourceError(code);
            }
            try { await delay(25, undefined, { signal: scope.abort.signal }); }
            catch (error) {
                if (scope.error || scope.abort.signal.aborted) throw scope.error ?? sourceError("NATIVE_SOURCE_CANCELLED");
                throw error;
            }
        }
        if (scope.error || scope.abort.signal.aborted) throw scope.error ?? sourceError("NATIVE_SOURCE_CANCELLED");
        if (scope.native?.readFailure?.responseAcknowledged && scope.native.readFailure.terminal === "finished") {
            throw sourceError("NATIVE_SOURCE_TRANSIENT_READ_FAILED");
        }
    }
    function ancillaryDocument(scope) {
        if (scope.native.currentDocument) return scope.native.currentDocument;
        const binding = scope.native.appDocumentBinding;
        return binding && scope === current && !scope.abort.signal.aborted && !scope.operationSignal?.aborted
            && binding.ownerId === ownerId && ownerId === nativeRun.ownerId
            && binding.generation === nativeRun.generation && binding.generation === scope.lease?.generation
            && binding.version === nativeRun.continuityVersion
            && binding.page === page && scope.page === page && !page.isClosed() && !browserClosed
            && binding.protocol === accountProtocol && accountProtocolReady && accountGate?.active
            && binding.frameId === nativeRun.mainFrameId && binding.epoch === nativeRun.documentEpoch
            ? binding.document : null;
    }
    function retainAppDocumentContinuity(scope) {
        nativeRun.liveAppDocument = null;
        if (scope !== current || !verified || scope.error || scope.cleanupFailed || scope.continuityRevoked
            || scope.abort.signal.aborted || scope.operationSignal?.aborted
            || !scope.lease && scope.native.principal?.knownAccountMatched !== true
            || scope.lease && scope.commitState !== "committed" && scope.readRecovery !== true || !ownerId || ownerId !== nativeRun.ownerId
            || !Number.isSafeInteger(nativeRun.generation) || scope.lease && scope.lease.generation !== nativeRun.generation
            || browserClosed || page.isClosed() || scope.page !== page || !accountProtocolReady || !accountGate?.active) return;
        const source = ancillaryDocument(scope);
        const build = nativeApplicationBuild();
        if (!source || source.epoch !== nativeRun.documentEpoch || !build
            || !source.scripts.has(build.scriptAssets[1])
            || ![origin, "https://m365.cloud.microsoft"].includes(URL.parse(source.entry.url)?.origin)) return;
        const response = entry => {
            if (!entry || entry.frameId !== nativeRun.mainFrameId || entry.responseStatus !== 200
                || !entry.responseAcknowledged || entry.terminal !== "finished" || entry.cached
                || !["GET", "POST"].includes(entry.method) || !Number.isSafeInteger(entry.hops) || entry.hops < 1 || entry.hops > 20
                || typeof entry.url !== "string" || entry.url.length > 16384
                || !["requestId", "networkId", "frameId"].every(key => typeof entry[key] === "string"
                    && entry[key].length > 0 && entry[key].length <= 256)) return null;
            return Object.freeze(Object.fromEntries(["requestId", "networkId", "frameId", "url", "method", "hops",
                "responseStatus", "responseAcknowledged", "terminal", "cached"].map(key => [key, entry[key]])));
        };
        const entry = response(source.entry);
        if (!entry) return;
        const document = { entry, epoch: source.epoch, scripts: new Map(), scriptInventoryPartial: true };
        const retainedAssets = new Set([...nativeApplicationBuilds.flatMap(candidate => [...candidate.scriptAssets, ...(candidate.startupScriptAssets ?? [])]),
            ...nativeCoworkBuilds.flatMap(candidate => [...candidate.scriptAssets, candidate.runFeedScriptAsset,
                candidate.taskListScriptAsset, candidate.olderMessagesScriptAsset, candidate.automationDetailsScriptAsset].filter(Boolean))]);
        for (const [url, script] of source.scripts) {
            if (!retainedAssets.has(url)) continue;
            const scriptEntry = response(script.entry);
            if (script.ambiguous || script.document !== source || !scriptEntry || scriptEntry.url !== url
                || scriptEntry.method !== "GET" || scriptEntry.hops !== 1) return;
            document.scripts.set(url, Object.freeze({ entry: scriptEntry, document }));
        }
        if (!document.scripts.size) return;
        nativeRun.liveAppDocument = Object.freeze({ ownerId, generation: nativeRun.generation, page,
            protocol: accountProtocol, frameId: entry.frameId, loaderId: entry.networkId,
            epoch: source.epoch, version: nativeRun.continuityVersion, pageUrl: page.url(), document: Object.freeze(document) });
    }
    async function claimAppDocumentContinuity(lease) {
        const binding = nativeRun.liveAppDocument;
        nativeRun.liveAppDocument = null;
        await lifecycle.assertLease(lease);
        const valid = () => binding && !current && verified && !closed && !browserClosed && !page.isClosed()
            && binding.page === page && binding.ownerId === ownerId && ownerId === nativeRun.ownerId
            && binding.generation === nativeRun.generation && binding.generation === lease.generation
            && Number.isSafeInteger(binding.version) && binding.version === nativeRun.continuityVersion
            && binding.protocol === accountProtocol && accountProtocolReady && accountGate?.active
            && accountGate.pendingCount === 0 && accountGate.idlePendingCount === 0
            && binding.frameId === nativeRun.mainFrameId && binding.epoch === nativeRun.documentEpoch
            && binding.pageUrl === page.url() && Date.now() < nativeRun.deadline;
        if (!valid()) throw sourceError("NATIVE_APP_DOCUMENT_CONTINUITY_UNQUALIFIED");
        let frameTree, timer;
        try {
            ({ frameTree } = await Promise.race([accountProtocol.send("Page.getFrameTree"), new Promise((_, reject) => {
                timer = setTimeout(() => reject(sourceError("NATIVE_APP_DOCUMENT_CONTINUITY_UNQUALIFIED")),
                    Math.max(1, Math.min(1000, nativeRun.deadline - Date.now())));
            })]));
        } catch { throw sourceError("NATIVE_APP_DOCUMENT_CONTINUITY_UNQUALIFIED"); }
        finally { clearTimeout(timer); }
        await lifecycle.assertLease(lease);
        if (!valid() || frameTree?.frame?.id !== binding.frameId || frameTree.frame.parentId
            || frameTree.frame.loaderId !== binding.loaderId
            || URL.parse(frameTree.frame.url)?.origin !== URL.parse(binding.document.entry.url)?.origin) {
            throw sourceError("NATIVE_APP_DOCUMENT_CONTINUITY_UNQUALIFIED");
        }
        return binding;
    }
    function nativeApplicationBuild() {
        const matches = nativeApplicationBuilds.filter(build =>
            [...build.scriptAssets, ...(build.startupScriptAssets ?? [])].every(url => nativeRun.assets.has(url)));
        if (matches.length !== 1) return null;
        const build = matches[0];
        return nativeApplicationBuilds.some(candidate => candidate.scriptAssets.some(url =>
            nativeRun.assets.has(url) && !build.scriptAssets.includes(url))) ? null : build;
    }
    function nativeHistoryBuildKnown() {
        return ["midgard-ee6e08b8", "midgard-d6c807be"].includes(nativeApplicationBuild()?.id);
    }
    function nativeCoworkBuild() {
        const matches = nativeCoworkBuilds.filter(build => build.scriptAssets.every(url => nativeRun.assets.has(url)));
        if (matches.length !== 1) return null;
        const build = matches[0];
        return nativeCoworkBuilds.some(candidate => candidate !== build
            && candidate.scriptAssets.some(url => nativeRun.assets.has(url))) ? null : build;
    }
    function nativeBuildKnown(surface = "chat") {
        const application = nativeApplicationBuild();
        if (!application) return false;
        if (surface !== "cowork") return true;
        if (engineering) return historyEngineeringAssets.every(asset => nativeRun.assets.has(asset));
        const cowork = nativeCoworkBuild();
        return Boolean(cowork && (!cowork.messageAuthors || nativeHistoryBuildKnown()));
    }
    function nativeCoworkRowGuard(scope) {
        const run = nativeRun, document = ancillaryDocument(scope), epoch = run.documentEpoch;
        const assertCurrent = () => {
            if (scope !== current || scope.abort.signal.aborted || nativeRun !== run || run.documentEpoch !== epoch
                || ancillaryDocument(scope) !== document || Date.now() >= run.deadline) {
                throw sourceError("NATIVE_SOURCE_DOCUMENT_CHANGED");
            }
        };
        return async kind => {
            await lifecycle.assertLease(scope.lease);
            assertCurrent();
            const scriptCurrent = asset => {
                const script = asset && nativeDocumentScript(document, asset, scope.native.requestOrigins);
                return Boolean(script && script.document === document && document.epoch === epoch
                    && script.entry.responseStatus === 200 && script.entry.responseAcknowledged
                    && script.entry.terminal === "finished" && !script.entry.cached);
            };
            await nativeWait(scope, () => scriptCurrent(nativeCoworkBuild()?.taskListScriptAsset),
                5000, "NATIVE_SOURCE_BUILD_UNQUALIFIED");
            if (kind === "feed" && (!["scheduled_run", "automation_run"].includes(scope.native.lists.cowork?.population)
                || !scriptCurrent(nativeCoworkBuild()?.runFeedScriptAsset))) throw sourceError("NATIVE_SOURCE_ASSOCIATION_FAILED");
            await lifecycle.assertLease(scope.lease);
            assertCurrent();
        };
    }
    function nativeAuthorizeScript(scope, url) {
        const required = scope.native.authorizeScripts.get(url);
        if (required) return required;
        const record = nativeDocumentScript(scope.native.currentDocument, url, scope.native.requestOrigins);
        return record?.document?.entry === scope.native.authorizeDocument?.entry ? record : null;
    }
    function retainAuthOriginWitness(scope, entry, stage) {
        // This records an already-used origin, not trust in an incidental script's implementation.
        const document = scope.native?.authorizeDocument;
        if (scope !== current || scope.abort.signal.aborted || scope.phase !== "native-connect"
            || !document || document.epoch !== nativeRun.documentEpoch || scope.page.url() !== document.entry.url
            || entry.kind !== "static" || entry.type !== "script" || entry.method !== "GET" || entry.hops !== 1
            || entry.frameId !== nativeRun.mainFrameId || entry.documentAtAdmission?.entry !== document.entry
            || entry.documentEpochAtAdmission !== nativeRun.documentEpoch || entry.responseStatus !== 200
            || !entry.responseAcknowledged || entry.terminal !== "finished" || entry.cached) return;
        const origin = new URL(entry.url).origin, witnesses = scope.native.authorizeStaticOrigins;
        if (witnesses.has(origin)) return;
        if (witnesses.size >= staticOriginWitnessLimit) {
            nativeFailure(scope, withNativeFailurePredicate(sourceError("NATIVE_SOURCE_PROVENANCE_UNQUALIFIED"),
                stage, "script-origin-budget"));
            return;
        }
        witnesses.set(origin, { entry, document });
    }
    function nativeAccountSelectionCurrent(scope) {
        return scope.accountSelected && scope.native.accountSelectionContext === scope.native.authorizationContext;
    }
    function nativeSignInCurrent(scope) {
        return scope.signInClicked && scope.native.signInContext === scope.native.authorizationContext;
    }
    function nativeAppAncillaryRole(scope, facts, requireReady = true) {
        const url = facts.url, document = ancillaryDocument(scope);
        const kind = facts.method === "GET" && url?.pathname === "/client_health_ping" ? "native-health-ping"
            : facts.method === "GET" && url?.pathname === "/events-worker.js" ? "native-worker-preflight"
                : facts.method === "POST" && appEventsDestination(url) ? "blocked-app-events-post" : null;
        if (!kind) return null;
        const request = scope.native.requestOrigins?.get(facts.networkId);
        const caller = request?.frames.find(frame => frame.url !== null), script = caller?.acceptedScript;
        // Ancillary rejection depends on its reviewed caller, not full-app liveness.
        const build = nativeApplicationBuilds.find(candidate => candidate.scriptAssets[1] === caller?.url);
        if (!build || scope !== current || scope.abort.signal.aborted || scope.operationSignal?.aborted || Date.now() >= nativeRun.deadline
            || scope.phase === "native-connect" && Date.now() >= nativeRun.authDeadline
            || !facts.original || !facts.owned || facts.frameId !== nativeRun.mainFrameId
            || !["fetch", "xhr"].includes(facts.type)
            || !url || ![origin, "https://m365.cloud.microsoft"].includes(url.origin)
            || url.hash || url.username || url.password
            || !document || document.epoch !== nativeRun.documentEpoch || document.entry.frameId !== nativeRun.mainFrameId
            || document.entry.responseStatus !== 200 || requireReady && !document.entry.responseAcknowledged || document.entry.cached
            || URL.parse(document.entry.url)?.origin !== url.origin || URL.parse(scope.page.url())?.origin !== url.origin) return null;
        let purpose, site;
        if (kind === "native-health-ping") {
            purpose = healthQueryPurpose(url);
            if (!purpose) return null;
            site = build.healthPingCallsites[purpose];
        } else {
            if (url.search) return null;
            if (kind === "native-worker-preflight") {
                purpose = "worker-preflight";
                site = build.workerPreflightCallsite;
            } else {
                const match = Object.entries(build.appEventsCallsites ?? {}).find(([, site]) =>
                    site.line === caller?.lineNumber && site.column === caller?.columnNumber);
                if (!match) return null;
                [purpose, site] = match;
            }
        }
        if (!site || !request?.original || request.duplicate || !request.owned || request.method !== facts.method
            || !["fetch", "xhr"].includes(request.type) || request.frameId !== nativeRun.mainFrameId
            || request.url !== url.href || request.document !== document || request.epoch !== nativeRun.documentEpoch
            || request.initiatorType !== "script" || caller?.url !== build.scriptAssets[1]
            || caller.lineNumber !== site.line || caller.columnNumber !== site.column
            || !script || script.document !== document || document.scripts.get(caller.url) !== script
            || script.entry.responseStatus !== 200 || script.entry.cached
            || requireReady && (!script.entry.responseAcknowledged || script.entry.terminal !== "finished")) return null;
        return { kind, purpose };
    }
    function nativeTransportRefusal(scope, facts, kind) {
        const url = facts.url, document = ancillaryDocument(scope), request = scope.native.requestOrigins?.get(facts.networkId);
        const generation = scope.lease?.generation ?? scope.native.connectLimits?.generation;
        const health = kind === "bootstrap-health-transport", presentation = kind === "static-presentation-transport";
        if (scope !== current || scope.abort.signal.aborted || scope.operationSignal?.aborted) return "scope";
        if (!ownerId || ownerId !== nativeRun.ownerId || generation !== nativeRun.generation) return "owner-generation";
        if (!accountProtocolReady || !accountGate?.active) return "interception";
        if (!(Date.now() < nativeRun.deadline)
            || scope.phase === "native-connect" && !(Date.now() < nativeRun.authDeadline)) return "deadline";
        if (!facts.original || !facts.owned || facts.method !== "GET" || facts.navigation
            || !(health ? ["fetch", "xhr"].includes(facts.type) : presentation && presentationTypes.has(facts.type))
            || facts.frameId !== nativeRun.mainFrameId) return "request-shape";
        if (!url || url.username || url.password || (health
            ? ![origin, "https://m365.cloud.microsoft"].includes(url.origin) || url.pathname !== "/client_health_ping" || url.hash
            : accountOnlyRequestDecision(facts).kind !== "static")) return "destination";
        if (!document || document.epoch !== nativeRun.documentEpoch || document.entry.frameId !== facts.frameId
            || document.entry.responseStatus !== 200 || !document.entry.responseAcknowledged || document.entry.cached) return "document";
        const documentOrigin = URL.parse(document.entry.url)?.origin, pageOrigin = URL.parse(scope.page.url())?.origin;
        if (!documentOrigin || documentOrigin !== pageOrigin || health && documentOrigin !== url.origin) return "document-origin";
        if (scope.native.requestOriginsTruncated) return "provenance-cap";
        if (!request?.original || request.duplicate || !request.owned) return "original-network";
        if (request.networkId !== facts.networkId || request.frameId !== facts.frameId || request.method !== "GET"
            || !(health ? ["fetch", "xhr"].includes(request.type) : request.type === facts.type)
            || request.url !== url.href) return "network-correlation";
        if (request.document !== document || request.epoch !== nativeRun.documentEpoch) return "request-document";
        return null;
    }
    function nativeObservation(entry, captureId, observedAt) {
        if (!entry || entry.responseStatus !== 200 || !entry.responseAcknowledged || entry.terminal !== "finished" || entry.cached
            || !["requestId", "networkId", "frameId"].every(key => typeof entry[key] === "string" && entry[key])) {
            throw sourceError("NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
        }
        return { captureId, requestId: entry.requestId, networkId: entry.networkId, frameId: entry.frameId,
            requestOrigin: new URL(entry.url).origin, method: entry.method, responseStatus: entry.responseStatus, observedAt };
    }
    function qualifyNativePrincipal(scope, principal, observation, selectedAtRequest) {
        const existing = scope.native.principal ?? nativeRun.principal;
        if (existing?.knownAccountMatched && (principal.tenantId !== existing.tenantId || principal.subjectId !== existing.subjectId
            || principal.namespace !== existing.namespace || principal.realm !== existing.realm)) {
            throw sourceError("NATIVE_SOURCE_ACCOUNT_MISMATCH");
        }
        if (scope.native.principal?.knownAccountMatched && !scope.lease) return;
        scope.native.principal = { ...principal, knownAccountMatched: selectedAtRequest || principal.accountLabelMatched
            || browserOwnedSignIn() && existing?.knownAccountMatched === true,
            origin: observation.requestOrigin, observedAt: observation.observedAt, provenance: observation };
        if (scope.lease && scope.native.principal.knownAccountMatched) nativeRun.principal = scope.native.principal;
    }
    function nativeRoutingWitness(scope) {
        const principal = scope.native.principal, routing = scope.native.routingObservation, routed = scope.native.routedObservation;
        if (!principal?.knownAccountMatched || !routing || !routed
            || routed.principalCaptureId !== principal.provenance.captureId
            || routing.endpointOrigin !== routed.responseOrigin || !Number.isSafeInteger(nativeRun.generation)) return undefined;
        const { principalCaptureId: ignored, ...routedProvenance } = routed;
        return { schemaVersion: 1, sourceContract: "m365-accountInfo-cowork-headers-v1",
            ownerId: nativeRun.ownerId, generation: nativeRun.generation, observedAt: new Date().toISOString(),
            issuer: routed.responseOrigin, tenantId: principal.tenantId, subjectId: principal.subjectId,
            namespace: principal.namespace, realm: principal.realm,
            current: principal.provenance, routing, routed: routedProvenance };
    }
    async function authenticationChainEvidence(scope, facts) {
        if ((!observeAuthenticationChain && !ordinaryPartnerPreload) || !facts.navigation || scope.phase !== "native-connect") return undefined;
        const until = Date.now() + 1000;
        while (!scope.native.authDocumentRequests.has(facts.networkId) && scope === current && !scope.abort.signal.aborted
            && Date.now() < until) await delay(10, undefined, { signal: scope.abort.signal });
        const observed = scope.native.authDocumentRequests.get(facts.networkId);
        if (!observed || observed.frameId !== facts.frameId || observed.requestUrl !== facts.url.href || observed.method !== facts.method
            || observed.original !== facts.original || observed.scope !== scope || observed.epoch !== nativeRun.documentEpoch) {
            return { binding: "unqualified-network-request", destination: nativeBootstrapRouteEvidence(facts.url) };
        }
        const document = observed.document;
        if (document && scope.native.authorizeDocument === document && document.epoch === observed.epoch
            && scope.page.url() === document.entry.url && !document.entry.cached) {
            await nativeWait(scope, () => document.entry.responseAcknowledged && document.entry.terminal === "finished",
                1000, "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
        }
        const documentCurrent = () => document && scope.native.authorizeDocument === document && document.epoch === observed.epoch
            && observed.epoch === nativeRun.documentEpoch
            && scope.page.url() === document.entry.url && document.entry.responseStatus === 200
            && document.entry.responseAcknowledged && document.entry.terminal === "finished" && !document.entry.cached;
        const firstUrl = observed.initiatorType === "script" ? observed.frames[0]?.url : null;
        const initiatingScript = firstUrl ? scope.native.authorizeScripts.get(firstUrl) : null;
        if (documentCurrent() && initiatingScript?.document === document && initiatingScript.entry.responseStatus === 200
            && !initiatingScript.entry.cached && nativeHistoryProducer.partnerPreloadScriptAssets.includes(firstUrl)) {
            await nativeWait(scope, () => {
                if (!documentCurrent() || scope.native.authorizeScripts.get(firstUrl) !== initiatingScript
                    || Date.now() >= nativeRun.authDeadline) throw sourceError("NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
                return initiatingScript.entry.responseAcknowledged && initiatingScript.entry.terminal === "finished";
            }, 1000, "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
        }
        const source = (url, position = {}) => {
            const script = nativeAuthorizeScript(scope, url);
            const scriptBound = documentCurrent() && script?.document?.entry === document.entry && script.entry.responseStatus === 200
                && script.entry.responseAcknowledged && script.entry.terminal === "finished" && !script.entry.cached;
            const binding = documentCurrent() && url === document.entry.url ? "current-authorize-document"
                : scriptBound ? "accepted-current-authorize-script" : "unqualified";
            return { binding, ...(scriptBound ? { script: nativeAuthScriptEvidence(URL.parse(script.entry.url)) } : {}),
                ...(binding !== "unqualified" && Number.isInteger(position.lineNumber) && position.lineNumber >= 0
                    && Number.isInteger(position.columnNumber) && position.columnNumber >= 0
                    ? { zeroBasedLine: position.lineNumber, zeroBasedColumn: position.columnNumber } : {}) };
        };
        return { binding: "exact-original-network-request", frameRelation: observed.frameRelation,
            parentOwnedAtRequest: observed.parentOwned, documentEpochCurrent: observed.epoch === nativeRun.documentEpoch,
            currentAuthorizeDocument: documentCurrent() ? "accepted-original-completed-noncached-200" : "unqualified",
            destination: nativeBootstrapRouteEvidence(facts.url),
            actualInitiator: { type: ["parser", "script", "other", "preflight"].includes(observed.initiatorType) ? observed.initiatorType : "unqualified",
                ...(observed.initiatorType === "parser" ? { source: source(observed.initiatorUrl) } : {}),
                ...(observed.initiatorType === "script" ? { frames: observed.frames.map(frame => source(frame.url, frame)),
                    stackTruncated: observed.stackTruncated } : {}) } };
    }
    function nativeData(scope, facts, readPostData, stage = "unobserved") {
        const { url, method, navigation } = facts;
        if (!url || navigation || !facts.original) return null;
        const app = [origin, "https://m365.cloud.microsoft"].includes(url.origin);
        const pathname = url.pathname.replace(/^\/hwav2(?=\/)/, "");
        if (engineering) {
            if (method === "OPTIONS") return null;
            const nativeGateway = /^https:\/\/[a-z0-9][a-z0-9.-]*\.gateway\.prod\.island\.powerapps\.com$/.test(url.origin);
            if (nativeGateway && /\/(?:detail|messages)(?:\/|$)/.test(pathname)
                || app && pathname.startsWith("/chat/conversation/")) throw sourceError("NATIVE_ENGINEERING_CONTENT_READ_FORBIDDEN");
            const known = app && [nativeHistoryProducer.bootstrapRpcId, nativeHistoryProducer.chatRpcId,
                "e1446a039787a6f09f7172df1d7a68d91d750f72a56219ae968fee8b58e967ed",
                "22ef9231e91dd4cf46350df4f8e31fc54e727335d4a882bc56199bd904815585"]
                .some(id => pathname === "/_serverFn/" + id)
                || nativeGateway && ["/v1/routing", "/v1/tasks/live"].includes(pathname);
            if (known) {
                const record = engineering.requestFor(url.href, method), projection = record.projection;
                const roles = app && method === "POST" && pathname === "/_serverFn/" + nativeHistoryProducer.chatRpcId ? ["chat-list", "context"]
                    : app && method === "GET" && pathname === "/_serverFn/" + nativeHistoryProducer.bootstrapRpcId ? ["principal"]
                        : app && method === "GET" && pathname === "/_serverFn/e1446a039787a6f09f7172df1d7a68d91d750f72a56219ae968fee8b58e967ed" ? ["context"]
                            : app && method === "GET" && pathname === "/_serverFn/22ef9231e91dd4cf46350df4f8e31fc54e727335d4a882bc56199bd904815585" ? ["chat-initializer"]
                                : nativeGateway && method === "GET" && pathname === "/v1/routing" ? ["routing"]
                                    : nativeGateway && method === "GET" && pathname === "/v1/tasks/live" ? ["cowork-list"] : [];
                if (!roles.includes(projection.role)) throw sourceError("NATIVE_ENGINEERING_REQUEST_SCOPE");
                const kind = ({ principal: "principal", context: "context", routing: "routing",
                    "chat-list": "chat-list", "chat-initializer": "chat-list", "cowork-list": "cowork-list" })[projection.role];
                if (!kind) throw sourceError("NATIVE_ENGINEERING_REQUEST_SCOPE");
                return { kind, engineeringRequestId: record.requestId, store: projection.store,
                    engineeringRole: projection.role, continuation: projection.cursor, requestBasis: projection.basis };
            }
        }
        if (app && pathname === "/_serverFn/" + nativeHistoryProducer.bootstrapRpcId && method === "GET") {
            return { kind: "principal" };
        }
        if (app && pathname === "/_serverFn/" + nativeHistoryProducer.chatInitializerRpcId && method === "GET") {
            if (url.search || url.hash) throw sourceError("NATIVE_SOURCE_QUERY_UNQUALIFIED");
            return { kind: "chat-list", initializer: true, store: null,
                continuation: { state: "absent" }, requestBasis: "unobserved" };
        }
        if (app && pathname === "/_serverFn/" + nativeHistoryProducer.chatRpcId && method === "POST") {
            if (!["fetch", "xhr"].includes(facts.type)) return null;
            const contextEligible = scope.lease?.kind === "microsoft-read"
                && (scope.native.collectingSurface === "chat" && ["chat-discovery", "chat"].includes(scope.phase)
                    || scope.phase === "native-collection-bootstrap" && scope.native.bootstrapSurfaces?.includes("chat"));
            const decision = classifyNativeHistoryRequest(readPostData(), stage, contextEligible);
            if (decision.kind === "unqualified") throw decision.error;
            if (decision.kind === "context") return { kind: "context" };
            return decision.kind === "different-action" ? { kind: "blocked-chat-action" }
                : { kind: "chat-list", ...decision.request };
        }
        if (gateway(url) || /^https:\/\/[a-z0-9][a-z0-9.-]*\.gateway\.prod\.island\.powerapps\.com$/.test(url.origin)) {
            if (method === "OPTIONS") return null;
            if (method !== "GET") return null;
            if (url.pathname === "/v1/routing" && !url.search) return { kind: "routing" };
            if (!engineering && scope.phase === "cowork-membership") {
                if (url.pathname === "/v1/automations") {
                    if (url.search !== "?type=all") throw sourceError("NATIVE_SOURCE_QUERY_UNQUALIFIED");
                    return { kind: "cowork-automations" };
                }
                const schedule = /^\/v1\/conversations\/([^/]+)\/scheduled-prompt$/.exec(url.pathname);
                const trigger = /^\/v1\/event-triggers\/([^/]+)$/.exec(url.pathname);
                if (schedule || trigger) {
                    if (url.search || url.hash) throw sourceError("NATIVE_SOURCE_QUERY_UNQUALIFIED");
                    let parentId;
                    try { parentId = decodeURIComponent((schedule ?? trigger)[1]); }
                    catch { throw sourceError("NATIVE_SOURCE_QUERY_UNQUALIFIED"); }
                    return { kind: schedule ? "cowork-schedule" : "cowork-trigger", parentId };
                }
            }
            if (url.pathname === "/v1/tasks/live") return { kind: "cowork-list",
                ...(scope.phase === "cowork-membership" ? { membershipInitial: !url.searchParams.has("cursor"),
                    population: url.searchParams.get("sessionType"),
                    queryBindingKey: "cowork-list:" + JSON.stringify(url.searchParams.get("sessionType")) } : {}) };
            if (scope.native.selectedCowork && ["/v1/tasks/live/detail", "/v1/tasks/live/messages"].includes(url.pathname)) {
                return { kind: url.pathname.endsWith("/detail") ? "cowork-detail" : "cowork-messages" };
            }
        }
        if (app && method === "GET" && scope.phase === "chat" && scope.native.selectedChat
            && pathname === "/chat/conversation/" + encodeURIComponent(scope.native.selectedChat) && !url.search) {
            return { kind: "chat" };
        }
        return null;
    }
    function nativeFrameEvidence(scope, facts, stage) {
        return {
            channel: stage === "route" ? "browser-route" : facts.deviceRiskTarget ? "device-helper" : "application",
            identifierPresent: typeof facts.frameId === "string" && facts.frameId.length > 0,
            matchesMain: typeof facts.frameId === "string" && facts.frameId === nativeRun.mainFrameId,
            matchesDevice: typeof facts.frameId === "string" && facts.frameId === scope.native.deviceRisk?.frameId,
            admittedDeviceOrigin: Boolean(configuration.deviceRiskOrigin && facts.url?.origin === configuration.deviceRiskOrigin),
            authorizeOrigin: facts.url?.origin === "https://login.microsoftonline.com",
        };
    }
    function nativeRefusalEvidence(scope, facts) {
        const unavailable = unavailableNativeRequestEvidence(facts);
        if (unavailable) return unavailable;
        const records = scope.native.requestOrigins, request = records?.get(facts.networkId);
        const reference = value => {
            if (typeof value !== "string") return null;
            const url = URL.parse(value);
            if (!url) return null;
            const safe = nativeBootstrapRouteEvidence(url), authScript = nativeAuthScriptEvidence(url);
            const publicCdn = ["https://res.cdn.office.net", "https://res.public.onecdn.static.microsoft"].includes(url.origin);
            const publicPath = authScript?.publicPath ?? (publicCdn && !url.search && !url.hash
                && /^\/[A-Za-z0-9/._-]{1,500}\.(?:m?js|json|css|wasm|woff2?|ico|png|svg)$/.test(url.pathname)
                ? url.pathname.replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, "{opaque}") : null);
            const collector = ["/OneCollector/1.0/", "/OneCollector/1.0", "/Collector/3.0/", "/Collector/3.0", "/v2/track"];
            const appRoute = [origin, "https://m365.cloud.microsoft"].includes(url.origin)
                && ["/events", "/client_health_ping"].includes(url.pathname);
            return { protocol: url.protocol, origin: url.origin,
                route: safe.route ?? (appRoute || collector.includes(url.pathname) ? url.pathname : null),
                publicPath, queryKeys: safe.queryKeys, unknownKeys: safe.unknownKeys, duplicateKeys: safe.duplicateKeys,
                fragmentPresent: safe.fragmentPresent, pathSegments: url.pathname.split("/").filter(Boolean).length };
        };
        const observed = { truncated: scope.native.requestOriginsTruncated === true, retainedRecords: records?.size ?? 0,
            phase: scope.phase,
            ...(request?.healthTransportAdmission ? { healthTransportAdmission: request.healthTransportAdmission } : {}),
            fetch: { networkId: facts.networkId, method: facts.method, type: facts.type, owned: facts.owned,
                mainFrame: facts.frameId === nativeRun.mainFrameId, original: facts.original,
                destination: reference(facts.url?.href) },
            currentDocumentScripts: [...(scope.native.currentDocument?.scripts?.values() ?? []),
                ...(scope.native.currentDocument?.incidentalScripts?.values() ?? [])].slice(0, incidentalScriptLimit).map(script => ({
                reference: reference(script.entry.url), responseAcknowledged: script.entry.responseAcknowledged,
                terminal: script.entry.terminal, cached: script.entry.cached,
            })),
            currentDocumentScriptsComplete: Boolean(scope.native.currentDocument
                && !scope.native.currentDocument.scriptInventoryPartial
                && scope.native.currentDocument.scripts.size + (scope.native.currentDocument.incidentalScripts?.size ?? 0) <= incidentalScriptLimit),
            requiredBuildAssets: nativeApplicationBuilds.flatMap(build => [...build.scriptAssets, ...(build.startupScriptAssets ?? [])].map(url => ({
                build: build.id, reference: reference(url), recognized: nativeRun.assets.has(url),
            }))),
            chatProducerCurrent: nativeBuildKnown(), coworkProducerCurrent: nativeBuildKnown("cowork"),
            principalQualified: Boolean(scope.native.principal?.knownAccountMatched || nativeRun.principal?.knownAccountMatched) };
        if (!request) return { available: false,
            reason: records ? "original-network-record-unavailable" : "network-metadata-unavailable", ...observed };
        const original = request.initiatorType === "preflight" ? records.get(request.initiatorRequestId) : null;
        const project = row => {
            if (!row) return null;
            const document = row.document, current = document && document === scope.native.currentDocument
                && document.epoch === nativeRun.documentEpoch;
            const rowFacts = { url: URL.parse(row.url), method: row.method, type: row.type, owned: row.owned,
                original: row.original, navigation: row.type === "document" };
            return { networkId: row.networkId, method: row.method, type: row.type, original: row.original, duplicate: row.duplicate,
                destination: reference(row.url), documentAtRequest: reference(row.documentUrl),
                ownedAtNetwork: row.owned, mainFrame: row.frameId === nativeRun.mainFrameId, epoch: row.epoch,
                currentEpoch: row.epoch === nativeRun.documentEpoch,
                acceptedDocument: document ? { current: Boolean(current), status: document.entry.responseStatus,
                    responseAcknowledged: document.entry.responseAcknowledged, terminal: document.entry.terminal,
                    cached: document.entry.cached, method: document.entry.method, hops: document.entry.hops,
                    scriptRegistryComplete: document.scriptInventoryPartial !== true } : null,
                initiatorType: row.initiatorType, initiatorDocument: reference(row.initiatorUrl),
                initiatorFrames: row.frames.map(frame => ({ reference: reference(frame.url), line: frame.lineNumber, column: frame.columnNumber,
                    acceptedForRequestDocument: Boolean(frame.acceptedScript?.document === document && document && !frame.acceptedScript.ambiguous),
                    acceptedForCurrentDocument: Boolean(frame.acceptedScript?.document === scope.native.currentDocument && scope.native.currentDocument
                        && nativeDocumentScript(scope.native.currentDocument, frame.url, records) === frame.acceptedScript),
                    stillCurrentScript: Boolean(nativeDocumentScript(document, frame.url, records) === frame.acceptedScript && frame.acceptedScript),
                    responseAcknowledged: frame.acceptedScript?.entry.responseAcknowledged ?? false,
                    terminal: frame.acceptedScript?.entry.terminal ?? null, cached: frame.acceptedScript?.entry.cached ?? null,
                    reviewedCoreScript: nativeHistoryProducer.partnerPreloadScriptAssets.includes(frame.url) })),
                decision: accountOnlyRequestDecision({ ...rowFacts, pageOrigin: URL.parse(row.documentUrl)?.origin,
                    tokenEndpoint: nativeRun.tokenEndpoint, signInClicked: nativeSignInCurrent(scope), accountSelected: nativeAccountSelectionCurrent(scope) }),
                nativeKind: row.method === "GET" ? nativeData(scope, rowFacts, () => undefined)?.kind ?? null : null };
        };
        return { available: true, ...observed,
            request: project(request), linkedOriginal: project(original),
            exactNetworkMatch: request.url === facts.url?.href && request.method === facts.method && !request.duplicate,
            exactFetchFrameMatch: request.frameId === facts.frameId,
            browserPreflight: request.initiatorType === "preflight" && Boolean(original),
            linkedUrlMatch: Boolean(original && original.url === request.url),
            linkedFrameMatchesFetch: Boolean(original && original.frameId === facts.frameId),
            linkedEpochMatch: Boolean(original && original.epoch === request.epoch) };
    }
    function deviceFrameOwned(risk, frameId) {
        if (!risk || risk.retired || risk.scope !== current || risk.epoch !== nativeRun.documentEpoch
            || risk.parent !== current?.native?.authorizeDocument) return false;
        const seen = new Set();
        while (risk.frames.has(frameId) && !seen.has(frameId) && seen.size < 16) {
            if (frameId === risk.frameId) return true;
            seen.add(frameId);
            frameId = risk.frames.get(frameId).parentId;
        }
        return false;
    }
    function deviceBrowserFrame(risk, frame) {
        if (!risk?.frame || risk.retired || risk.epoch !== nativeRun.documentEpoch) return false;
        for (let depth = 0; frame && depth < 16; depth++, frame = frame.parentFrame()) {
            if (frame.isDetached() || frame.page() !== current?.page) return false;
            if (frame === risk.frame) return true;
        }
        return false;
    }
    function deviceRiskRequest(scope, facts, stage) {
        const risk = scope.native.deviceRisk;
        const frameId = stage === "protocol" ? facts.frameId : facts.deviceRiskFrameId;
        if (!deviceFrameOwned(risk, frameId)) return null;
        const document = scope.native.authorizeDocument;
        const refuse = code => {
            scope.native.deviceRiskOutcome.failure = code;
            throw sourceError(code);
        };
        if (scope.phase !== "native-connect" || document !== risk.parent || risk.epoch !== nativeRun.documentEpoch
            || scope.page.url() !== risk.parent.entry.url || facts.url.href.length > deviceRiskLimits.urlLength) {
            return refuse("NATIVE_DEVICE_RISK_SCOPE_CHANGED");
        }
        if (stage === "protocol" && risk.childGate && facts.deviceRiskTarget !== risk.childProtocol) {
            return refuse("NATIVE_DEVICE_RISK_FRAME_COVERAGE_UNQUALIFIED");
        }
        if (stage === "protocol" && !facts.original) {
            return refuse("NATIVE_DEVICE_RISK_REDIRECT_UNQUALIFIED");
        }
        let kind;
        if (facts.navigation) {
            if (facts.method !== "GET" || facts.url.origin !== risk.origin
                || stage === "route" && !facts.deviceRiskDocument) {
                return refuse("NATIVE_DEVICE_RISK_NAVIGATION_UNQUALIFIED");
            }
            if (stage === "protocol") {
                const node = risk.frames.get(frameId), original = risk.documentRequests.get(facts.networkId);
                const parent = risk.frames.get(node.parentId);
                if (frameId === risk.frameId || node.document || !original
                    || original.frameId !== frameId || original.url !== facts.url.href
                    || original.parentId !== node.parentId || original.epoch !== nativeRun.documentEpoch
                    || original.parentDocument !== parent?.document || !parent.document?.responseAcknowledged
                    || parent.document.state !== "complete" || parent.document.cached) {
                    return refuse("NATIVE_DEVICE_RISK_NAVIGATION_UNQUALIFIED");
                }
            }
            kind = "device-risk-document";
        } else {
            const document = risk.frames.get(frameId).document;
            if (!document?.responseAcknowledged || document.state !== "complete" || document.cached) {
                return refuse("NATIVE_DEVICE_RISK_FRAME_COVERAGE_UNQUALIFIED");
            }
            const asset = ["script", "stylesheet", "image", "font"].includes(facts.type)
                && ["GET", "HEAD"].includes(facts.method);
            const witness = scope.native.authorizeStaticOrigins.get(facts.url.origin);
            const existingStatic = asset && accountOnlyRequestDecision({ ...facts, pageOrigin: risk.origin }).kind === "static"
                && witness?.document === risk.parent && witness.entry.responseAcknowledged
                && witness.entry.terminal === "finished" && !witness.entry.cached;
            const sameOriginData = facts.url.origin === risk.origin
                && (["GET", "HEAD", "POST"].includes(facts.method) && ["fetch", "xhr", "ping"].includes(facts.type)
                    || facts.method === "OPTIONS" && ["fetch", "xhr", "other"].includes(facts.type)
                    || stage === "route" && facts.method === "POST" && facts.type === "other");
            if (!(asset && facts.url.origin === risk.origin || existingStatic || sameOriginData)) {
                return refuse("NATIVE_DEVICE_RISK_DESTINATION_UNQUALIFIED");
            }
            kind = asset ? "device-risk-asset" : "device-risk-transport";
        }
        if (stage === "protocol") {
            const outcome = scope.native.deviceRiskOutcome;
            const identity = JSON.stringify([facts.frameId, facts.networkId]);
            if (scope.native.deviceRequestIds.has(identity)) return refuse("NATIVE_DEVICE_RISK_RESOURCE_UNQUALIFIED");
            scope.native.deviceRequestIds.add(identity);
            if (++outcome.requests > deviceRiskLimits.requests
                || facts.method === "POST" && ++outcome.opaquePosts > deviceRiskLimits.posts) {
                return refuse("NATIVE_DEVICE_RISK_RESOURCE_LIMIT");
            }
        }
        return kind;
    }
    function observeNative(scope, request, stage = "network") {
        const frame = request.frame();
        if (deviceBrowserFrame(scope.native.deviceRisk, frame)) return null;
        if (requestScopes.has(request)) return scope.native.metadata.get(request);
        const facts = { url: URL.parse(request.url()), method: request.method(), type: request.resourceType(),
            navigation: request.isNavigationRequest(), original: request.redirectedFrom() === null,
            owned: frame.page() === scope.page && !frame.isDetached() };
        const metadata = nativeData(scope, facts, () => request.postData(), stage);
        if (!metadata) return null;
        if (!engineering && metadata.kind === "context") return null;
        if (metadata.kind === "blocked-chat-action") {
            if (!facts.owned || frame !== scope.page.mainFrame() || scope !== current || scope.abort.signal.aborted
                || !["native-connect", "native-collection-bootstrap", "chat-discovery", "cowork-discovery", "chat", "cowork"].includes(scope.phase)
                || scope.phase === "native-collection-bootstrap" && scope.lease?.kind !== "microsoft-read") {
                throw withNativeFailurePredicate(sourceError("NATIVE_CHAT_ACTION_UNQUALIFIED"), stage, "chat-action-binding");
            }
            return null;
        }
        const count = (scope.native.observed.get(metadata.kind) ?? 0) + 1;
        const slot = sourceSlot(metadata.kind, count);
        const maximum = ["chat-list", "cowork-list", "cowork-messages", ...COWORK_MEMBERSHIP_KINDS].includes(metadata.kind)
            || engineering && ["context", "routing", "principal"].includes(metadata.kind) ? 16 : 1;
        admitNativeRequestObservation(scope.observer, request, slot, count, maximum, facts, stage);
        scope.native.observed.set(metadata.kind, count);
        scope.native.metadata.set(request, { ...metadata, slot, documentEpoch: nativeRun.documentEpoch,
            frameUrl: request.frame().url(), selectedAtRequest: nativeAccountSelectionCurrent(scope) });
        requestScopes.set(request, scope);
        return scope.native.metadata.get(request);
    }
    async function openNativeHistory(scope, surface) {
        const principal = scope.native.principal ?? nativeRun.principal;
        const action = { value: createNativeHistoryObservation(surface, randomUUID()), run: nativeRun,
            ownerId: nativeRun.ownerId, generation: nativeRun.generation, frameId: nativeRun.mainFrameId,
            principal: principal ? hash(JSON.stringify([principal.tenantId, principal.subjectId, principal.namespace, principal.realm])) : null,
            priorRequests: new Set(scope.native.requestOrigins?.keys() ?? []), started: null, target: null, entry: null, navigation: null };
        scope.native.historyObservations.set(surface, action);
        try {
            await clickNativeHistoryLink(scope.page, { surface, initialize: true, observe: async event => {
                if (event.phase === "selection") {
                    action.value.control = { ...event.control, entry: nativeHistoryEntry(surface, event.target) };
                    action.target = event.target; action.viewTarget = event.viewTarget ?? null;
                    if (surface === "cowork" && event.target) nativeRun.coworkEntry = event.target;
                    if (event.failure) {
                        scope.controlFailure ??= event.failure;
                        await scope.recordControlFailure?.(scope.controlFailure);
                    }
                    if (scope.recordHistory) await scope.recordHistory([...scope.native.historyObservations.values()].map(row => row.value));
                } else if (event.phase === "invoking") {
                    if (scope.lease) await lifecycle.assertLease(scope.lease);
                    action.started = Date.now();
                    action.priorRequests = new Set(scope.native.requestOrigins?.keys() ?? []);
                    action.document = ancillaryDocument(scope);
                    action.documentEpoch = nativeRun.documentEpoch;
                } else action.value.view = event.view;
                if (scope !== current || scope.abort.signal.aborted || scope.operationSignal?.aborted || nativeRun !== action.run
                    || nativeRun.ownerId !== action.ownerId || Date.now() >= nativeRun.deadline) {
                    action.value.association.state = "owner-lost";
                    throw scope.error ?? sourceError("NATIVE_SOURCE_CANCELLED");
                }
                validateNativeHistoryObservation(action.value);
            } });
        } catch (error) {
            if (scope !== current || scope.abort.signal.aborted || nativeRun !== action.run) action.value.association.state = "owner-lost";
            throw error;
        }
    }
    async function settleHistoryObservation(scope, surface) {
        const action = scope.native.historyObservations.get(surface);
        if (!action) return;
        if (scope.lease) await lifecycle.assertLease(scope.lease);
        if (scope !== current || scope.abort.signal.aborted || scope.operationSignal?.aborted || nativeRun !== action.run) {
            action.value.association.state = "owner-lost";
            throw scope.error ?? sourceError("NATIVE_SOURCE_CANCELLED");
        }
        const epoch = nativeRun.documentEpoch;
        const view = await readNativeHistoryView(scope.page, action.viewTarget);
        if (scope !== current || scope.abort.signal.aborted || nativeRun !== action.run || nativeRun.ownerId !== action.ownerId
            || nativeRun.documentEpoch !== epoch) {
            action.value.association.state = "owner-lost";
            return;
        }
        action.value.view = view;
        validateNativeHistoryObservation(action.value);
    }
    function observeHistoryRequest(scope, entry) {
        for (const action of scope.native.historyObservations.values()) {
            if (action.started === null) continue;
            const original = scope.native.requestOrigins?.get(entry.networkId);
            if (entry.kind === "document" && entry.url === action.target && entry.frameId === action.frameId
                && original?.original && original.owned && !original.duplicate
                && action.document && action.document.epoch === action.documentEpoch
                && !action.priorRequests.has(entry.networkId) && ancillaryDocument(scope) === action.document
                && entry.documentEpochAtAdmission === action.documentEpoch) action.navigation ??= entry;
            if (entry.kind !== action.value.surface + "-list" || action.entry) continue;
            action.entry = entry;
            action.requestDocument = ancillaryDocument(scope);
            const association = action.value.association;
            association.request = hash(JSON.stringify([action.value.actionId, entry.networkId, entry.frameId, action.ownerId, action.generation]));
            association.requestFilterPresent = entry.kind === "cowork-list" && new URL(entry.url).searchParams.has("sessionType");
            if (action.priorRequests.has(entry.networkId)) association.state = "unrelated";
            else if (Date.now() - action.started > 10000) association.state = "late";
        }
    }
    function acceptHistoryObservation(scope, entry, meta, metadata) {
        const documentInitializer = metadata.documentInitializer === true;
        const action = scope.native.historyObservations.get(documentInitializer || entry.kind === "chat-list" ? "chat" : "cowork");
        if (documentInitializer && action?.navigation === entry && action.started !== null && !action.entry) {
            action.entry = entry;
            action.requestDocument = scope.native.currentDocument;
            action.value.association.request = hash(JSON.stringify([
                action.value.actionId, entry.networkId, entry.frameId, action.ownerId, action.generation,
            ]));
            if (Date.now() - action.started > 10000) action.value.association.state = "late";
        }
        if (!action || action.entry !== entry) return null;
        const value = action.value, result = value.association;
        result.chatRequestBasis = documentInitializer ? "ssr-initializer" : entry.kind === "chat-list" ? metadata.requestBasis : "unobserved";
        const document = action.requestDocument, original = scope.native.requestOrigins?.get(entry.networkId);
        const principal = scope.native.principal ?? nativeRun.principal;
        result.frameMatched = entry.frameId === action.frameId && original?.frameId === action.frameId;
        result.loaderMatched = typeof original?.loaderId === "string" && original.loaderId === document?.entry.networkId;
        result.selectedNavigation = action.navigation !== null && document?.entry === action.navigation;
        const invocationDocument = document !== null && document === action.document && document.epoch === action.documentEpoch;
        result.epochMatched = documentInitializer
            ? result.selectedNavigation && document?.epoch === nativeRun.documentEpoch && document === ancillaryDocument(scope)
                && entry.documentEpochAtAdmission === action.documentEpoch
            : entry.documentEpochAtAdmission === nativeRun.documentEpoch && document === ancillaryDocument(scope)
                && (invocationDocument || result.selectedNavigation);
        const samePrincipal = principal && action.principal === hash(JSON.stringify([principal.tenantId, principal.subjectId, principal.namespace, principal.realm]));
        result.accountMatched = principal?.knownAccountMatched === true
            && (samePrincipal || action.principal === null && principal.provenance?.captureId === meta.captureId)
            && !["native-identity-header-mismatch", "native-identity-header-unqualified"].includes(entry.nativeIdentity?.reason);
        result.accountBinding = result.accountMatched ? entry.nativeIdentity?.state === "matched" ? "request-headers" : "principal-context" : "unobserved";
        result.response = hash(JSON.stringify([result.request, meta.bodyDigest]));
        if (action.run !== nativeRun || action.ownerId !== nativeRun.ownerId || action.generation !== nativeRun.generation
            || scope !== current || scope.abort.signal.aborted) result.state = "owner-lost";
        else if (result.state === "unobserved") result.state = original?.original && !original.duplicate && original.owned
            && result.frameMatched && result.loaderMatched && result.epochMatched && result.accountMatched ? "ordered" : "unrelated";
        return validateNativeHistoryObservation(value);
    }
    function nativeAuthReturnFailure(continuation, stage, reason) {
        return withNativeFailurePredicate(sourceError("NATIVE_AUTH_RETURN_UNQUALIFIED"), stage,
            `${continuation ? "auth-continuation" : "auth-return"}-${reason}`);
    }
    function nativeAuthContinuationDocument(scope) {
        const document = scope.native.currentDocument, first = scope.native.authReturnAccepted;
        return scope.phase === "native-connect" && first?.routed && document
            && document.entry.url === first.url && document.entry.networkId === first.networkId
            && document.entry.frameId === nativeRun.mainFrameId && document.entry.method === "POST" && document.entry.hops === 1
            && document.entry.responseStatus === 200 && document.entry.responseAcknowledged
            && document.entry.terminal === "finished" && !document.entry.cached
            && document.epoch === nativeRun.documentEpoch && document.epoch === first.epoch + 1
            && scope.page.url() === document.entry.url ? document : null;
    }
    function nativeAuthContinuationDestination(scope, url) {
        return url?.origin === "https://login.microsoftonline.com" && !url.username && !url.password
            && !url.hash && url.href.length <= 16384 && Boolean(nativeAuthContinuationDocument(scope));
    }
    function nativeAuthCallbackDestination(url) {
        return [origin + "/landingv2", "https://m365.cloud.microsoft/landingv2"].includes(url?.href);
    }
    function nativeAuthorizationRequest(url) {
        return url?.origin === "https://login.microsoftonline.com"
            && /^\/(?:common|organizations|[a-f0-9-]{36})\/oauth2\/(?:v2\.0\/)?authorize$/i.test(url.pathname);
    }
    function retireBootstrapAuthority(scope) {
        const document = scope.native.document;
        if (document?.token) scope.native.retiredBootstrapTokens.add(document.token);
        scope.native.document = null;
        scope.native.principal = null;
        scope.native.gateway = null;
        scope.native.routingObservation = null;
        scope.native.routedObservation = null;
        scope.native.lists = {};
        scope.accountMatched = false;
        scope.identity = null;
        nativeRun.principal = null;
        nativeRun.gateway = null;
        nativeRun.initialDiscovery = null;
    }
    function beginNativeAuthorizationReentry(scope, entry, previousDocument) {
        const refuse = code => {
            nativeFailure(scope, code);
            throw scope.error ?? sourceError(code);
        };
        const callback = scope.native.authCallbackAccepted, limits = scope.native.connectLimits;
        const request = scope.native.requestOrigins?.get(entry.networkId), initial = entry.initial;
        const previousAuthorization = URL.parse(callback?.authorization?.entry.url ?? "");
        const authorization = URL.parse(entry.url);
        const one = (url, key) => {
            const values = url?.searchParams.getAll(key) ?? [];
            return values.length === 1 ? values[0] : null;
        };
        const priorClient = one(previousAuthorization, "client_id"), client = one(authorization, "client_id");
        const priorRedirect = URL.parse(one(previousAuthorization, "redirect_uri") ?? "");
        const redirect = URL.parse(one(authorization, "redirect_uri") ?? "");
        const priorMode = one(previousAuthorization, "response_mode"), mode = one(authorization, "response_mode");
        const validClient = value => typeof value === "string" && value.trim().length > 0 && value.length <= 256;
        const applicationComparison = Object.freeze({
            previousDestinationQualified: Boolean(nativeAuthorizationRequest(previousAuthorization)),
            currentDestinationQualified: Boolean(nativeAuthorizationRequest(authorization)),
            previousClientValid: validClient(priorClient), currentClientValid: validClient(client),
            clientMatches: client !== null && client === priorClient,
            previousRedirectValid: Boolean(priorRedirect), currentRedirectValid: Boolean(redirect),
            redirectMatches: Boolean(redirect && redirect.href === priorRedirect?.href),
            redirectMatchesCallback: Boolean(redirect && redirect.href === callback?.url),
            previousResponseModeValid: priorMode === "form_post", currentResponseModeValid: mode === "form_post",
            responseModeMatches: mode !== null && mode === priorMode,
        });
        const navigation = scope.native.lastMainNavigation;
        const callbackTransaction = Boolean(callback && initial?.method === "POST" && initial.url === callback.url
            && initial.networkId === callback.networkId && entry.networkId === callback.networkId && entry.hops > 1
            && previousDocument === callback.document && previousDocument.epoch === callback.epoch
            && request?.document === callback.document && request.epoch === callback.epoch);
        const callbackHostHandoff = callbackTransaction
            && priorRedirect?.href === "https://m365.cloud.microsoft/landingv2" && callback.url === priorRedirect.href
            && redirect?.href === origin + "/landingv2";
        const callbackDocument = Boolean(callback && previousDocument?.entry.initial?.method === "POST"
            && previousDocument.entry.initial.url === callback.url && previousDocument.entry.networkId === callback.networkId
            && [origin, "https://m365.cloud.microsoft"].includes(URL.parse(previousDocument.entry.url)?.origin)
            && previousDocument.entry.responseStatus === 200 && previousDocument.entry.responseAcknowledged
            && previousDocument.entry.terminal === "finished" && !previousDocument.entry.cached);
        const applicationNavigation = Boolean(callbackDocument && initial?.method === "GET"
            && request?.document === previousDocument && request.epoch === previousDocument.epoch
            && navigation?.document === previousDocument && navigation.epoch === previousDocument.epoch
            && navigation.url === initial.url && ["scriptInitiated", "anchorClick"].includes(navigation.reason));
        const proof = {
            sameConnect: Boolean(limits && scope === current && scope.phase === "native-connect" && !scope.lease && !verified
                && !scope.abort.signal.aborted && !scope.operationSignal?.aborted && entry.scope === scope
                && typeof limits.ownerId === "string" && limits.ownerId.length > 0
                && Number.isSafeInteger(limits.generation) && limits.generation >= 0
                && limits.ownerId === nativeRun.ownerId && limits.generation === nativeRun.generation
                && limits.deadline === nativeRun.deadline && limits.authDeadline === nativeRun.authDeadline
                && Date.now() < limits.authDeadline && Date.now() < limits.deadline),
            currentSource: Boolean(previousDocument && previousDocument === scope.native.currentDocument
                && previousDocument.epoch === nativeRun.documentEpoch && entry.frameId === nativeRun.mainFrameId
                && initial?.frameId === nativeRun.mainFrameId && initial.networkId === entry.networkId
                && request?.owned && !request.duplicate && request.frameId === nativeRun.mainFrameId
                && request.method === "GET" && request.type === "document" && request.url === entry.url
                && request.original === (entry.hops === 1)
                && entry.method === "GET" && entry.responseStatus === 200 && !entry.cached),
            acceptedCallback: Boolean(callback?.routed && nativeAuthCallbackDestination(URL.parse(callback.url))),
            sameApplication: Object.entries(applicationComparison).every(([key, value]) => value === true
                || callbackHostHandoff && ["redirectMatches", "redirectMatchesCallback"].includes(key)),
            nativeReturnChain: callbackTransaction || applicationNavigation,
            noPriorIdentityRead: !scope.native.principal && !nativeRun.principal && !scope.native.document?.projectionPending
                && scope.native.observed.size === 0 && scope.native.requests.size === 0 && scope.native.protocolEntries.size === 0
                && !scope.native.gateway && !scope.native.routingObservation && !scope.native.routedObservation,
        };
        const reentry = scope.native.authorizationReentry ??= { attempts: 0, activated: 0, possibleLoop: true };
        reentry.attempts++;
        reentry.proof = proof;
        reentry.applicationComparison = applicationComparison;
        reentry.callbackHostHandoff = callbackHostHandoff;
        if (Object.values(proof).some(value => value !== true)) return refuse("NATIVE_AUTH_REENTRY_UNQUALIFIED");
        if (reentry.attempts !== 1 || scope.native.authTransition) return refuse("NATIVE_AUTH_REENTRY_LOOP");
        const oldPending = [...scope.pending], risk = scope.native.deviceRisk, oldContext = scope.native.authorizationContext;
        reentry.previousCallback = { ...scope.native.authCallbackOutcome };
        reentry.previousEpoch = nativeRun.documentEpoch;
        scope.native.authorizationContext++;
        retireBootstrapAuthority(scope);
        for (const key of ["authPostNavigation",
            "authPostNavigationUrl", "authPostNavigationDocument", "authReturnAccepted", "authReturnProof", "authReturnOutcome",
            "authContinuationNavigation", "authContinuationNavigationUrl", "authContinuationNavigationDocument",
            "authContinuationAccepted", "authContinuationProof", "authContinuationOutcome",
            "authCallbackAccepted", "authCallbackNavigation", "authCallbackProof", "authCallbackProtocol", "authCallbackOutcome",
            "lastMainNavigation", "bootstrapSnapshot", "bootstrapSampleDocument"]) scope.native[key] = null;
        scope.native.authPostRequests = new Map();
        scope.native.authContinuationRequests = new Map();
        scope.native.bootstrapUnmet = "authorization-retirement";
        const transition = (async () => {
            await nativeWait(scope, () => oldPending.every(task => !scope.pending.has(task)),
                1000, "NATIVE_AUTH_REENTRY_UNSETTLED");
            await nativeWait(scope, () => scope.native.currentDocument?.entry === entry
                && scope.native.currentDocument.epoch === nativeRun.documentEpoch
                && entry.responseAcknowledged && entry.terminal === "finished",
            deviceRiskLimits.requestMs, "NATIVE_AUTH_REENTRY_UNSETTLED");
            if (risk) {
                await nativeWait(scope, () => risk.retired && !risk.coveragePending && risk.frame?.isDetached()
                    && [...risk.requests.values()].every(request => request.finished)
                    && (!risk.childGate || risk.childGate.pendingCount === 0)
                    && (!risk.childProtocol || risk.protocolClosed),
                deviceRiskLimits.requestMs, "NATIVE_AUTH_REENTRY_UNSETTLED");
                risk.childGate?.retire();
                clearTimeout(risk.coverageTimer);
                for (const request of risk.requests.values()) clearTimeout(request.timer);
                scope.native.retiredDeviceRisks.push(risk);
                scope.native.deviceRisk = null;
            }
            await nativeWait(scope, () => accountGate.authorizationContextSettled(oldContext, true),
                1000, "NATIVE_AUTH_REENTRY_UNSETTLED");
            if (scope !== current || scope.abort.signal.aborted || scope.operationSignal?.aborted
                || scope.native.currentDocument?.entry !== entry || entry.cached
                || Date.now() >= limits.authDeadline || Date.now() >= limits.deadline) throw sourceError("NATIVE_AUTH_REENTRY_UNQUALIFIED");
            reentry.activated = 1;
            reentry.currentEpoch = nativeRun.documentEpoch;
            reentry.retired = true;
            scope.native.bootstrapUnmet = null;
            scope.native.authTransition = null;
        })().catch(error => { nativeFailure(scope, error); });
        scope.native.authTransition = track(transition, scope);
    }
    function nativeAuthCallbackChain(scope, document) {
        const seen = new Set();
        let providerChain = "authorize-native-get";
        while (document && seen.size < 128 && !seen.has(document)) {
            seen.add(document);
            const entry = document.entry, url = URL.parse(entry.url);
            const request = scope.native.requestOrigins?.get(entry.networkId);
            if (entry.scope !== scope || entry.frameId !== nativeRun.mainFrameId || entry.type !== "document"
                || entry.responseStatus !== 200 || !entry.responseAcknowledged || entry.terminal !== "finished" || entry.cached
                || !Number.isInteger(document.epoch) || !request || request.duplicate || !request.owned
                || request.frameId !== entry.frameId || request.type !== "document" || request.method !== entry.method
                || request.url !== entry.url || request.original !== (entry.hops === 1)) return null;
            if (entry.method === "GET" && nativeAuthorizationRequest(url)) {
                if (scope.native.authorizationRoot && scope.native.authorizationRoot.entry !== entry) return null;
                return { authorizationDocument: document, providerChain };
            }
            const parent = request.document;
            if (!parent || entry.hops !== 1 || request.epoch !== parent.epoch || document.epoch !== parent.epoch + 1) return null;
            if (entry.method === "GET") {
                if (url?.origin !== "https://login.microsoftonline.com") return null;
            } else if (entry.method === "POST") {
                const accepted = [scope.native.authReturnAccepted, scope.native.authContinuationAccepted]
                    .find(value => value?.networkId === entry.networkId);
                if (!accepted?.routed || accepted.url !== entry.url || accepted.document.entry !== parent.entry
                    || accepted.epoch !== parent.epoch) return null;
                providerChain = "native-authentication-continuation";
            } else return null;
            document = parent;
        }
        return null;
    }
    async function admitNativeAuthCallback(scope, facts, stage) {
        const document = scope.native.currentDocument, epoch = nativeRun.documentEpoch;
        if (document && stage === "protocol") {
            await nativeWait(scope, () => document.entry.responseAcknowledged && document.entry.terminal === "finished",
                1000, "NATIVE_AUTH_CALLBACK_UNQUALIFIED");
        }
        const chain = nativeAuthCallbackChain(scope, document), authorizationDocument = chain?.authorizationDocument;
        const authorization = URL.parse(authorizationDocument?.entry.url ?? "");
        const redirectUris = authorization?.searchParams.getAll("redirect_uri") ?? [];
        const responseModes = authorization?.searchParams.getAll("response_mode") ?? [];
        const sourceCurrent = () => Boolean(scope === current && !scope.abort.signal.aborted && !scope.operationSignal?.aborted
            && scope.phase === "native-connect" && document && scope.native.currentDocument === document && authorizationDocument
            && nativeAuthCallbackChain(scope, document)?.authorizationDocument === authorizationDocument
            && URL.parse(document.entry.url)?.origin === "https://login.microsoftonline.com"
            && document.epoch === epoch && nativeRun.documentEpoch === epoch
            && scope.page.url() === document.entry.url);
        if (stage === "route") {
            await nativeWait(scope, () => Boolean(scope.native.authCallbackAccepted), 1000, "NATIVE_AUTH_CALLBACK_UNQUALIFIED");
            const accepted = scope.native.authCallbackAccepted;
            if (!sourceCurrent() || !facts.nativeMainFrame || accepted.document !== document
                || accepted.url !== facts.url.href || accepted.routed) throw sourceError("NATIVE_AUTH_CALLBACK_UNQUALIFIED");
            accepted.routed = true;
            return "document";
        }
        const proof = scope.native.authCallbackProof = {
            currentProviderDocument: sourceCurrent(),
            acceptedAuthChain: Boolean(chain),
            declaredFormPost: responseModes.length === 1 && responseModes[0] === "form_post",
            exactRedirectUri: redirectUris.length === 1 && URL.parse(redirectUris[0])?.href === facts.url.href
                && nativeAuthCallbackDestination(facts.url),
            firstCallback: !scope.native.authCallbackAccepted && !scope.native.authSubmissionIds.has(facts.networkId),
            providerCompleted: false, originalRequest: false, nativeNavigation: false,
        };
        scope.native.authCallbackProtocol = { responseModeCount: responseModes.length, redirectUriCount: redirectUris.length };
        if (!ordinaryPartnerPreload || !facts.original || !facts.owned || facts.frameId !== nativeRun.mainFrameId
            || !proof.currentProviderDocument || !proof.acceptedAuthChain || !proof.declaredFormPost
            || !proof.exactRedirectUri || !proof.firstCallback) throw sourceError("NATIVE_AUTH_CALLBACK_UNQUALIFIED");
        const request = () => scope.native.requestOrigins?.get(facts.networkId);
        await nativeWait(scope, () => request() && scope.native.authCallbackNavigation
            && document.entry.responseAcknowledged && document.entry.terminal === "finished",
        1000, "NATIVE_AUTH_CALLBACK_UNQUALIFIED");
        const original = request(), navigation = scope.native.authCallbackNavigation;
        proof.currentProviderDocument = sourceCurrent();
        proof.providerCompleted = document.entry.responseAcknowledged && document.entry.terminal === "finished" && !document.entry.cached;
        proof.originalRequest = original.original && !original.duplicate && original.owned
            && original.method === "POST" && original.type === "document" && original.url === facts.url.href
            && original.frameId === facts.frameId && original.document === document && original.epoch === epoch;
        proof.nativeNavigation = navigation.reason === "formSubmissionPost" && navigation.mainFrame
            && navigation.url === facts.url.href && navigation.document === document && navigation.epoch === epoch;
        if (Object.values(proof).some(value => value !== true)) throw sourceError("NATIVE_AUTH_CALLBACK_UNQUALIFIED");
        scope.native.authSubmissionIds.add(facts.networkId);
        scope.native.authSubmissionCounts.callback++;
        scope.native.authCallbackAccepted = { networkId: facts.networkId, url: facts.url.href, document, epoch,
            authorization: authorizationDocument, routed: false };
        scope.native.authCallbackOutcome = { role: "native-form-post-response", originalPostAdmitted: true,
            providerChain: chain.providerChain };
        return "document";
    }
    function nativeAuthReturnDestination(url) {
        return url?.origin === "https://login.microsoft.com"
            && /^\/common\/fido\/[A-Za-z0-9._-]{1,128}$/.test(url.pathname)
            && !url.username && !url.password && !url.hash && url.href.length <= 16384;
    }
    function faviconCandidate(facts) {
        return facts.url && facts.method === "GET" && facts.type === "other" && !facts.navigation && facts.original
            && !facts.url.search && !facts.url.hash && facts.url.href.length <= 16384
            && Boolean(accountOnlyRequestDecision(facts).denied)
            && accountOnlyRequestDecision({ ...facts, type: "image" }).kind === "static";
    }
    function nativeFaviconFailure(scope, stage, category, error = sourceError("NATIVE_FAVICON_UNQUALIFIED"), predicate = "unobserved") {
        if (!nativeStopRecorded(scope)) {
            scope.native.faviconFailure ??= Object.freeze({ stage, category });
            withNativeFailurePredicate(error, stage, predicate);
        }
        return error;
    }
    function faviconMetadataPredicate(scope, facts, stage) {
        if (stage === "protocol" && !facts.networkId) return "favicon-request-network-id";
        const records = scope.native.requestOrigins;
        if (!records) return "unobserved";
        const examined = stage === "protocol" ? [records.get(facts.networkId)].filter(Boolean)
            : [...records.values()].filter(record => record.url === facts.url.href);
        if (!examined.length) return scope.native.requestOriginsTruncated ? "favicon-metadata-capped" : "favicon-candidate-unobserved";
        if (examined.length !== 1) return "favicon-candidate-unique";
        const record = examined[0];
        if (record.frameId !== nativeRun.mainFrameId) return "favicon-request-frame";
        if (!record.owned) return "favicon-request-owned";
        if (record.initiatorType !== "other") return "favicon-request-initiator";
        if (!record.original) return "favicon-request-original";
        if (record.epoch !== nativeRun.documentEpoch) return "favicon-request-epoch";
        const candidate = scope.native.faviconRequests?.get(record.networkId);
        if (!candidate) return "favicon-candidate-unobserved";
        if (stage === "protocol" && candidate.networkId !== facts.networkId) return "favicon-request-network-id";
        if (stage === "route" && !candidate.admitted) return "favicon-request-admission";
        return "unobserved";
    }
    async function qualifyNativeFavicon(scope, facts, stage) {
        if (!faviconCandidate(facts)) return false;
        const candidates = () => [...(scope.native.faviconRequests?.values() ?? [])].filter(record =>
            record.requestUrl === facts.url.href && record.epoch === nativeRun.documentEpoch
            && (stage === "protocol" ? record.networkId === facts.networkId : !record.routed));
        try {
            await nativeWait(scope, () => candidates().some(record => stage === "protocol" || record.admitted),
                1000, "NATIVE_FAVICON_UNQUALIFIED");
        } catch (error) {
            throw nativeFaviconFailure(scope, stage, "request-metadata", error, faviconMetadataPredicate(scope, facts, stage));
        }
        const matches = candidates(), record = matches.length === 1 ? matches[0] : null;
        const failed = !record ? "favicon-candidate-unique" : record.frameId !== nativeRun.mainFrameId ? "favicon-request-frame"
            : !record.original ? "favicon-request-original" : !record.owned ? "favicon-request-owned"
                : stage === "protocol" && facts.frameId !== record.frameId ? "favicon-request-frame"
                    : stage === "protocol" && record.admitted ? "favicon-request-not-admitted"
                        : stage === "route" && !facts.nativeMainFrame ? "favicon-route-main-frame" : null;
        if (failed) throw nativeFaviconFailure(scope, stage, "request-correlation", undefined, failed);
        const proof = await record.proof;
        if (proof.error) throw proof.error;
        const bindingFailure = typeof proof.value === "function" ? proof.value() : "unobserved";
        if (bindingFailure !== null) throw nativeFaviconFailure(scope, stage, "current-binding", undefined, bindingFailure);
        if (stage === "protocol") record.admitted = true;
        else record.routed = true;
        scope.native.faviconAdmitted = (scope.native.faviconAdmitted ?? 0) + Number(stage === "protocol");
        return true;
    }
    function nativeReturnImageTransaction(scope, document) {
        if (!document || document !== scope.native.currentDocument || document.epoch !== nativeRun.documentEpoch
            || document.entry.scope !== scope || document.entry.method !== "POST" || document.entry.hops !== 1
            || document.entry.frameId !== nativeRun.mainFrameId || document.entry.cached) return null;
        return [scope.native.authReturnAccepted, scope.native.authCallbackAccepted].find(value =>
            value?.routed && value.url === document.entry.url && value.networkId === document.entry.networkId
            && value.epoch + 1 === document.epoch) ?? null;
    }
    function admitNativeReturnImage(scope, facts, stage) {
        if (facts.url?.origin !== "https://aadcdn.msauthimages.net") return false;
        const document = scope.native.currentDocument, returned = scope.native.authReturnAccepted;
        if (scope.phase !== "native-connect" || facts.method !== "GET" || facts.type !== "image"
            || facts.navigation || !facts.original || !facts.owned || facts.url.hash || facts.url.href.length > 16384
            || !document || !returned || document.entry.url !== returned.url || document.entry.method !== "POST"
            || document.entry.networkId !== returned.networkId || document.entry.frameId !== nativeRun.mainFrameId
            || document.epoch !== nativeRun.documentEpoch || !document.entry.responseAcknowledged
            || document.entry.terminal !== "finished" || document.entry.cached) return false;
        const candidates = [...(scope.native.requestOrigins?.values() ?? [])].filter(record =>
            record.url === facts.url.href && record.method === "GET" && record.type === "image" && record.original
            && !record.duplicate && record.owned && record.frameId === nativeRun.mainFrameId
            && record.document === document && record.epoch === nativeRun.documentEpoch
            && (stage === "protocol" ? record.networkId === facts.networkId : record.returnImageAdmitted && !record.returnImageRouted));
        const record = candidates.length === 1 ? candidates[0] : null;
        if (!record || stage === "protocol" && (facts.frameId !== record.frameId || record.returnImageAdmitted)
            || stage === "route" && !facts.nativeMainFrame) return false;
        if (stage === "protocol") {
            record.returnImageAdmitted = true;
            scope.native.returnImageRequests = (scope.native.returnImageRequests ?? 0) + 1;
        } else record.returnImageRouted = true;
        return true;
    }
    async function qualifyDeniedReturnImage(scope, facts, stage) {
        if (stage !== "protocol") return false;
        if (!nativeAuthImageOrigins.has(facts.url?.origin)) return false;
        const run = nativeRun, document = scope.native.currentDocument, limits = scope.native.connectLimits;
        const imageCurrent = () => scope === current && !scope.error && !scope.abort.signal.aborted
            && !scope.operationSignal?.aborted && nativeRun === run && scope.phase === "native-connect"
            && limits === scope.native.connectLimits && limits?.ownerId === ownerId && ownerId === run.ownerId
            && limits.generation === run.generation && limits.authDeadline === run.authDeadline && limits.deadline === run.deadline
            && !closed && !browserClosed && page === scope.page && !page.isClosed()
            && accountProtocolReady && accountGate?.active && scope.native.currentDocument === document;
        if (scope.phase !== "native-connect" || facts.method !== "GET" || facts.type !== "image"
            || facts.navigation || !facts.original || !facts.owned || facts.url.hash || facts.url.href.length > 16384
            || !document || document.entry.method !== "POST" || document.entry.scope !== scope
            || document.entry.hops !== 1 || document.entry.frameId !== run.mainFrameId
            || document.epoch !== run.documentEpoch || document.entry.cached || !imageCurrent()) return false;
        const assertDeadline = () => {
            if (Date.now() >= limits.authDeadline || Date.now() >= limits.deadline) throw new MicrosoftSessionError("timed-out");
        };
        assertDeadline();
        const returned = nativeReturnImageTransaction(scope, document);
        if (!returned || URL.parse(scope.page.url())?.origin !== URL.parse(document.entry.url)?.origin) return false;
        await nativeWait(scope, () => {
            assertDeadline();
            return document.entry.responseAcknowledged && document.entry.terminal === "finished";
        }, Math.min(1000, limits.authDeadline - Date.now()), "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
        assertDeadline();
        if (!imageCurrent() || document.entry.responseStatus !== 200 || document.entry.cached
            || !document.entry.responseAcknowledged || document.entry.terminal !== "finished"
            || ![scope.native.authReturnAccepted, scope.native.authCallbackAccepted].includes(returned)) return false;
        const candidates = [...(scope.native.requestOrigins?.values() ?? [])].filter(record =>
            record.url === facts.url.href && record.method === "GET" && record.type === "image" && record.original
            && !record.duplicate && record.owned && record.frameId === nativeRun.mainFrameId
            && record.document === document && record.epoch === nativeRun.documentEpoch
            && URL.parse(record.documentUrl)?.origin === URL.parse(document.entry.url)?.origin
            && record.networkId === facts.networkId);
        const record = candidates.length === 1 ? candidates[0] : null;
        if (!record || facts.frameId !== record.frameId || record.returnImageAdmitted || record.deniedImageProof) return false;
        record.deniedImageProof = { deadline: Math.min(limits.authDeadline, limits.deadline),
            current: () => imageCurrent() && nativeReturnImageTransaction(scope, document) === returned
                && document.entry.responseStatus === 200 && document.entry.responseAcknowledged
                && document.entry.terminal === "finished" && !document.entry.cached
                && scope.native.requestOrigins?.get(facts.networkId) === record && !record.duplicate
                && record.document === document && record.epoch === nativeRun.documentEpoch
                && record.url === facts.url.href && record.frameId === facts.frameId
                && record.owned && record.original && record.method === "GET" && record.type === "image"
                && URL.parse(scope.page.url())?.origin === URL.parse(document.entry.url)?.origin };
        return true;
    }
    async function admitNativeAuthReturn(scope, facts, stage, continuation = false) {
        const document = continuation ? nativeAuthContinuationDocument(scope) : scope.native.authorizeDocument;
        const run = nativeRun, epoch = run.documentEpoch, protocol = accountProtocol, limits = scope.native.connectLimits;
        const acceptedReturn = () => continuation ? scope.native.authContinuationAccepted : scope.native.authReturnAccepted;
        const require = (condition, reason) => {
            if (!condition) throw nativeAuthReturnFailure(continuation, stage, reason);
        };
        const assertCurrent = () => {
            require(ordinaryPartnerPreload && scope === current && scope.phase === "native-connect", "scope");
            require(!scope.abort.signal.aborted && !scope.operationSignal?.aborted, "aborted");
            require(run === nativeRun && ownerId && run.ownerId === ownerId && limits?.ownerId === ownerId
                && Number.isSafeInteger(limits?.generation) && limits.generation === run.generation, "owner");
            require(!closed && !browserClosed && page === scope.page && !page.isClosed()
                && accountProtocol === protocol && accountProtocolReady && accountGate?.active, "custody");
            require(limits.authDeadline === run.authDeadline && limits.deadline === run.deadline
                && Date.now() < limits.authDeadline && Date.now() < limits.deadline, "deadline");
            require(document, "document");
            require((continuation ? nativeAuthContinuationDocument(scope) === document : scope.native.authorizeDocument === document)
                && scope.native.currentDocument?.entry === document.entry
                && scope.page.url() === document.entry.url, "current-document");
            require(document.epoch === epoch && run.documentEpoch === epoch, "epoch");
            require(document.entry.responseStatus === 200 && document.entry.responseAcknowledged
                && document.entry.terminal === "finished" && !document.entry.cached, "document-ready");
            require(continuation ? nativeAuthContinuationDestination(scope, facts.url) : nativeAuthReturnDestination(facts.url), "destination");
            require(facts.original && facts.owned && facts.method === "POST" && facts.navigation && facts.type === "document"
                && (stage === "protocol" ? facts.frameId === run.mainFrameId : facts.nativeMainFrame === true), "request");
        };
        const waitForAssociation = async (ready, reason) => {
            try { await nativeWait(scope, ready, 1000, "NATIVE_AUTH_RETURN_UNQUALIFIED"); }
            catch (error) {
                if (scope.error) throw scope.error;
                assertCurrent();
                if (error.code === "NATIVE_AUTH_RETURN_UNQUALIFIED") throw nativeAuthReturnFailure(continuation, stage, reason);
                throw error;
            }
            assertCurrent();
        };
        assertCurrent();
        if (stage === "route") {
            await waitForAssociation(() => Boolean(acceptedReturn()), "protocol-pairing");
            const accepted = acceptedReturn();
            require(accepted.document === document && accepted.epoch === epoch && accepted.url === facts.url.href
                && !accepted.routed, "route-pairing");
            accepted.routed = true;
            return "document";
        }
        const requests = () => continuation ? scope.native.authContinuationRequests : scope.native.authPostRequests;
        const requestedNavigationUrl = () => continuation ? scope.native.authContinuationNavigationUrl : scope.native.authPostNavigationUrl;
        await waitForAssociation(() => requests()?.has(facts.networkId)
            && requestedNavigationUrl() === facts.url.href, "navigation-association");
        const request = requests().get(facts.networkId);
        const navigation = continuation ? scope.native.authContinuationNavigation : scope.native.authPostNavigation;
        const navigationDocument = continuation ? scope.native.authContinuationNavigationDocument : scope.native.authPostNavigationDocument;
        const proof = {
            originalRequest: request.original && request.requestUrl === facts.url.href && request.frameId === facts.frameId
                && request.document === document && request.epoch === epoch,
            nativeNavigation: navigation?.reason === "formSubmissionPost" && navigation.mainFrame && navigation.epoch === epoch
                && navigationDocument === document && requestedNavigationUrl() === facts.url.href,
            firstSubmission: !acceptedReturn() && !scope.native.authSubmissionIds.has(facts.networkId),
        };
        if (continuation) scope.native.authContinuationProof = proof;
        else scope.native.authReturnProof = proof;
        require(proof.originalRequest, "original-request");
        require(proof.nativeNavigation, "native-navigation");
        require(proof.firstSubmission, "first-submission");
        scope.native.authSubmissionIds.add(facts.networkId);
        scope.native.authSubmissionCounts[continuation ? "continuation" : "return"]++;
        const accepted = { networkId: facts.networkId, url: facts.url.href, document, epoch, routed: false };
        const outcome = { role: continuation ? "native-authentication-continuation" : "native-authentication-return",
            authority: "owned-original-authentication-transaction", submittedForm: "not-identified-by-protocol",
            originalPostAdmitted: true,
            nativeSignInClickInvoked: nativeSignInCurrent(scope),
            nativeAccountClickInvoked: nativeAccountSelectionCurrent(scope),
            browserReportedUserGesture: request.hasUserGesture };
        if (continuation) {
            scope.native.authContinuationAccepted = accepted;
            scope.native.authContinuationOutcome = outcome;
        } else {
            scope.native.authReturnAccepted = accepted;
            scope.native.authReturnOutcome = outcome;
        }
        return "document";
    }
    async function admitNative(scope, facts, stage, readPostData) {
        if (!scope || scope !== current || scope.error || scope.abort.signal.aborted || Date.now() >= nativeRun.deadline) return null;
        if (scope.native.authTransition && !(["GET", "HEAD"].includes(facts.method) && !facts.navigation
            && ["script", "stylesheet", "image", "font"].includes(facts.type))) {
            await scope.native.authTransition;
            if (scope !== current || scope.error || scope.abort.signal.aborted) return null;
        }
        if (!accountProtocolReady || !accountGate?.active) {
            nativeFailure(scope, "NATIVE_SOURCE_FRAME_COVERAGE_UNQUALIFIED");
            return null;
        }
        if (!facts.owned || !facts.url || facts.url.protocol !== "https:" || facts.url.username || facts.url.password) {
            scope.native.denial ??= { reason: "frame-ownership", context: accountOnlyDenialContext(facts),
                frame: nativeFrameEvidence(scope, facts, stage), provenance: nativeRefusalEvidence(scope, facts) };
            nativeFailure(scope, "NATIVE_SOURCE_FRAME_UNQUALIFIED");
            const risk = scope.native.deviceRisk;
            if (!facts.owned && facts.deviceRiskTarget && facts.deviceRiskTarget === risk?.childProtocol) {
                scope.native.denial.frame.currentTree = await diagnoseAccountFrame(facts.deviceRiskTarget, {
                    mainFrameId: risk.frameId, rootParentId: nativeRun.mainFrameId, frameId: facts.frameId, scope,
                    getScope: () => current === scope && !risk.retired && risk.epoch === nativeRun.documentEpoch ? scope : null,
                });
            }
            return null;
        }
        try {
            if (engineering) {
                engineering.assertCurrent();
                const url = facts.url;
                if ([origin, "https://m365.cloud.microsoft"].includes(url.origin) && /^\/(?:hwav2\/)?chat\/conversation\//.test(url.pathname)
                    || /\.gateway\.prod\.island\.powerapps\.com$/.test(url.hostname) && /\/(?:detail|messages)(?:\/|$)/.test(url.pathname)) {
                    throw sourceError("NATIVE_ENGINEERING_CONTENT_READ_FORBIDDEN");
                }
                if (scope.phase === "native-engineering" && facts.navigation) {
                    const destination = engineering.activeStep?.startsWith("chat:") ? "/chat/all" : "/cowork/";
                    if (url.origin !== "https://m365.cloud.microsoft" || url.pathname !== destination || url.search
                        || facts.method !== "GET" || !facts.original
                        || (stage === "route" ? !facts.nativeMainFrame : facts.frameId !== nativeRun.mainFrameId)) {
                        throw sourceError("NATIVE_ENGINEERING_ENTRY_REQUIRED");
                    }
                    if (stage === "protocol") engineering.admitNavigation(facts.networkId);
                }
            }
            if (stage === "protocol" && facts.navigation && facts.frameId === nativeRun.mainFrameId) {
                await nativeWait(scope, () => accountGate.authorizationContextSettled(scope.native.authorizationContext),
                    1000, "NATIVE_AUTH_REENTRY_UNSETTLED");
            }
            const retiringHelper = scope.native.deviceRisk;
            if (stage === "protocol" && facts.navigation && facts.frameId === nativeRun.mainFrameId
                && retiringHelper && !retiringHelper.retired && retiringHelper.epoch === nativeRun.documentEpoch) {
                await nativeWait(scope, () => !retiringHelper.coveragePending
                    && [...retiringHelper.requests.values()].every(request => request.finished)
                    && (!retiringHelper.childGate || retiringHelper.childGate.pendingCount === 0),
                deviceRiskLimits.requestMs, "NATIVE_DEVICE_RISK_INCOMPLETE");
            }
            const deviceKind = deviceRiskRequest(scope, facts, stage);
            if (deviceKind) return deviceKind;
            if (facts.method === "POST" && facts.navigation && nativeAuthReturnDestination(facts.url)) {
                return await admitNativeAuthReturn(scope, facts, stage);
            }
            if (facts.method === "POST" && facts.navigation && nativeAuthContinuationDestination(scope, facts.url)) {
                return await admitNativeAuthReturn(scope, facts, stage, true);
            }
            if (facts.method === "POST" && facts.navigation && [origin, "https://m365.cloud.microsoft"].includes(facts.url.origin)) {
                return await admitNativeAuthCallback(scope, facts, stage);
            }
            const validateContinuation = stage === "protocol" || stage === "preflight-check";
            const metadata = nativeData(scope, facts, readPostData, stage === "preflight-check" ? "protocol" : stage);
            let kind;
            if (metadata) {
                if (observeAuthenticationChain) throw sourceError("NATIVE_AUTH_CHAIN_OBSERVATION_COMPLETE");
                kind = metadata.kind;
                if (kind === "blocked-chat-action") return kind;
                if (COWORK_MEMBERSHIP_KINDS.includes(kind)) {
                    if (scope.phase !== "cowork-membership" || scope.native.collectingSurface !== "cowork"
                        || scope.lease?.kind !== "microsoft-read" || !verified) {
                        throw sourceError("NATIVE_COLLECTION_CONFIGURATION_REQUIRED");
                    }
                    await lifecycle.assertLease(scope.lease);
                    await nativeWait(scope, () => {
                        const document = ancillaryDocument(scope), build = nativeCoworkBuild();
                        const asset = kind === "cowork-schedule" ? build?.automationDetailsScriptAsset : build?.runFeedScriptAsset;
                        const script = asset && nativeDocumentScript(document, asset, scope.native.requestOrigins);
                        return script && script.document === document && !script.ambiguous && script.entry.responseAcknowledged
                            && script.entry.terminal === "finished" && !script.entry.cached;
                    }, 5000, "NATIVE_SOURCE_BUILD_UNQUALIFIED");
                    if (metadata.parentId) {
                        await nativeWait(scope, () => Boolean(scope.native.automationParents), 15000, "NATIVE_COWORK_MEMBERSHIP_UNQUALIFIED");
                        const expectedKind = kind === "cowork-schedule" ? "scheduled" : "event";
                        if (!scope.native.automationParents.some(parent => parent.kind === expectedKind && parent.id === metadata.parentId)) {
                            throw sourceError("NATIVE_SOURCE_ASSOCIATION_FAILED");
                        }
                    }
                }
                if (!engineering && metadata.initializer && (scope.phase !== "chat-discovery" || !scope.lease
                    || nativeHistoryEntry("chat", scope.page.url()) !== "chat-all")) {
                    throw sourceError("NATIVE_COLLECTION_CONFIGURATION_REQUIRED");
                }
                await nativeWait(scope, () => nativeBuildKnown(kind === "routing" || kind.startsWith("cowork") ? "cowork" : "chat"),
                    5000, "NATIVE_SOURCE_BUILD_UNQUALIFIED");
                if (engineering && kind === "context" && metadata.requestBasis === "context"
                    && !nativeHistoryBuildKnown()) throw sourceError("NATIVE_SOURCE_BUILD_UNQUALIFIED");
                if (!engineering && metadata.initializer && !nativeHistoryBuildKnown()) {
                    throw sourceError("NATIVE_SOURCE_BUILD_UNQUALIFIED");
                }
                if (!engineering && kind === "context") {
                    if (!nativeHistoryBuildKnown()) throw sourceError("NATIVE_SOURCE_BUILD_UNQUALIFIED");
                    if (!facts.original || facts.navigation || facts.url.origin !== URL.parse(scope.page.url())?.origin
                        || (stage === "route" ? !facts.nativeMainFrame : facts.frameId !== nativeRun.mainFrameId)) {
                        throw sourceError("NATIVE_SOURCE_FRAME_UNQUALIFIED");
                    }
                }
                if (["chat", "cowork-detail", "cowork-messages"].includes(kind) || !engineering && kind === "context") {
                    if (!verified || !scope.lease) throw sourceError("NATIVE_CONNECTION_REQUIRED");
                    await lifecycle.assertLease(scope.lease);
                }
                if (engineering && kind === "cowork-list") {
                    await nativeWait(scope, () => Boolean(scope.native.gateway), 15000, "NATIVE_ROUTING_UNQUALIFIED");
                    if (facts.url.origin !== scope.native.gateway.origin) throw sourceError("NATIVE_ROUTING_UNQUALIFIED");
                }
                if (!engineering && kind.startsWith("cowork") && kind !== "routing") {
                    await nativeWait(scope, () => Boolean(scope.native.gateway), 15000, "NATIVE_ROUTING_UNQUALIFIED");
                    if (facts.url.origin !== scope.native.gateway.origin) throw sourceError("NATIVE_ROUTING_UNQUALIFIED");
                    const keys = [...facts.url.searchParams.keys()];
                    const allowed = COWORK_MEMBERSHIP_KINDS.includes(kind) ? kind === "cowork-automations" ? ["type"] : []
                        : kind === "cowork-list" ? ["pageSize", "includeCached", "sessionType", "cursor"]
                        : ["sessionId", "threadId", "pageSize", "cursor"];
                    if (new Set(keys).size !== keys.length || keys.some(key => !allowed.includes(key))) throw sourceError("NATIVE_SOURCE_QUERY_UNQUALIFIED");
                    const listRequest = kind === "cowork-list" ? projectNativeCoworkListRequest(facts.url) : null;
                    if (listRequest?.population === "automation_run") {
                        if (!scope.lease || !["cowork-discovery", "cowork-membership"].includes(scope.phase)) throw sourceError("NATIVE_COLLECTION_CONFIGURATION_REQUIRED");
                        await lifecycle.assertLease(scope.lease);
                        await nativeWait(scope, () => {
                            const document = ancillaryDocument(scope);
                            const asset = nativeCoworkBuild()?.runFeedScriptAsset;
                            const script = asset && nativeDocumentScript(document, asset, scope.native.requestOrigins);
                            return Boolean(script && script.document === document && document.epoch === nativeRun.documentEpoch
                                && script.entry.responseStatus === 200 && script.entry.responseAcknowledged
                                && script.entry.terminal === "finished" && !script.entry.cached);
                        }, 5000, "NATIVE_SOURCE_BUILD_UNQUALIFIED");
                    }
                    if (validateContinuation) {
                        const bindingKey = metadata.queryBindingKey ?? kind;
                        const query = hash(JSON.stringify(listRequest ? { population: listRequest.population }
                            : [...facts.url.searchParams].filter(([key]) => key !== "cursor")
                                .sort(([left], [right]) => left.localeCompare(right))));
                        if (scope.native.queryBindings.has(bindingKey) && scope.native.queryBindings.get(bindingKey) !== query) {
                            throw sourceError("NATIVE_SOURCE_CONTINUATION_UNQUALIFIED");
                        }
                        if (stage === "protocol") scope.native.queryBindings.set(bindingKey, query);
                    }
                    if (["cowork-detail", "cowork-messages"].includes(kind)) {
                        const hasSession = facts.url.searchParams.has("sessionId"), hasThread = facts.url.searchParams.has("threadId");
                        const session = facts.url.searchParams.get("sessionId"), thread = facts.url.searchParams.get("threadId");
                        if (!hasSession && !hasThread
                            || hasSession && ![scope.native.selectedCowork, scope.native.coworkComposite].includes(session)) {
                            throw sourceError("NATIVE_SOURCE_ASSOCIATION_FAILED");
                        }
                        if (hasThread) {
                            if (kind === "cowork-detail" && !scope.native.detailVerified) throw sourceError("NATIVE_SOURCE_ASSOCIATION_FAILED");
                            await nativeWait(scope, () => scope.native.detailVerified, 15000, "NATIVE_SOURCE_ASSOCIATION_FAILED");
                            if (!scope.native.threadIds.has(thread)) throw sourceError("NATIVE_SOURCE_ASSOCIATION_FAILED");
                        }
                    }
                    if (validateContinuation && (facts.url.searchParams.has("cursor")
                        || (scope.native.protocolCounts.get(kind) ?? 0) > 0
                        || kind === "cowork-list" && scope.native.continuingDiscovery === "cowork")) {
                        if (kind === "cowork-messages" && (scope.native.protocolCounts.get(kind) ?? 0) > 0) {
                            await nativeWait(scope, () => scope.native.messageCursor?.state === "present"
                                && scope.native.messageCursor.value === facts.url.searchParams.get("cursor"), 1000,
                                "NATIVE_SOURCE_CONTINUATION_UNQUALIFIED");
                        }
                        const cursor = kind === "cowork-list" ? (scope.phase === "cowork-membership"
                            ? scope.native.coworkPopulations.get(listRequest.population) : scope.native.lists.cowork)?.continuation
                            : scope.native.messageCursor;
                        const initialListContext = kind === "cowork-list" && !scope.native.protocolCounts.has(kind)
                            && scope.native.continuingDiscovery !== "cowork";
                        if (scope.phase === "cowork-membership" && kind === "cowork-list" && facts.url.searchParams.has("cursor")) {
                            const prior = scope.native.coworkPopulations.get(listRequest.population);
                            if (!prior || prior.continuation.state !== "present" || prior.continuation.value !== facts.url.searchParams.get("cursor")) {
                                throw sourceError("NATIVE_SOURCE_CONTINUATION_UNQUALIFIED");
                            }
                        }
                        if (!initialListContext && !metadata.membershipInitial
                            && (cursor?.state !== "present" || facts.url.searchParams.get("cursor") !== cursor.value)) {
                            throw sourceError("NATIVE_SOURCE_CONTINUATION_UNQUALIFIED");
                        }
                        if (stage === "protocol" && kind === "cowork-messages") {
                            if (scope.native.messageContinuations.has(cursor.value)) {
                                throw sourceError("NATIVE_SOURCE_CONTINUATION_UNQUALIFIED");
                            }
                            scope.native.messageContinuations.add(cursor.value);
                        }
                        if (initialListContext) scope.native.enteredWithContinuation = true;
                    }
                }
                if (!engineering && validateContinuation && kind === "chat-list") {
                    const documentReset = scope.phase === "chat-discovery" && scope.native.lists.chat?.documentInitialized
                        && metadata.requestBasis === "empty-reset-shape" && scope.native.lists.chat.store === metadata.store;
                    if (documentReset) {
                        scope.native.lists.chat.startQualified = false;
                        if (scope.native.backfillSource?.surface === "chat") {
                            scope.native.backfillSource.startQualified = false;
                            scope.native.backfillSource.exhausted = false;
                        }
                    } else if (scope.native.protocolCounts.has(kind) || scope.native.continuingDiscovery === "chat"
                        || scope.native.lists.chat?.documentInitialized) {
                        if (metadata.initializer) throw sourceError("NATIVE_SOURCE_CONTINUATION_UNQUALIFIED");
                        await nativeWait(scope, () => Boolean(scope.native.lists.chat), 1000,
                            "NATIVE_SOURCE_CONTINUATION_UNQUALIFIED");
                        if (metadata.continuation.state !== "present" || scope.native.lists.chat?.continuation.state !== "present"
                            || scope.native.lists.chat.continuation.value !== metadata.continuation.value
                            || scope.native.lists.chat.store !== metadata.store) {
                            throw sourceError("NATIVE_SOURCE_CONTINUATION_UNQUALIFIED");
                        }
                    } else if (metadata.continuation.state === "present") scope.native.enteredWithContinuation = true;
                }
                if (!engineering && stage === "protocol" && ["chat-list", "cowork-list"].includes(kind)) {
                    const surface = kind === "chat-list" ? "chat" : "cowork";
                    scope.native.discoveryInitial ??= {};
                    scope.native.discoveryInitial[surface] ??= kind === "chat-list" ? metadata.continuation.state
                        : facts.url.searchParams.has("cursor") ? "present" : "absent";
                }
            } else {
                const pathname = facts.url.pathname.replace(/^\/hwav2(?=\/)/, "");
                const app = [origin, "https://m365.cloud.microsoft"].includes(facts.url.origin);
                if (!engineering && app && facts.navigation && pathname === "/chat/all"
                    && (scope.phase !== "chat-discovery" || scope.lease?.kind !== "microsoft-read"
                        || scope.native.collectingSurface !== "chat")) {
                    throw sourceError("NATIVE_COLLECTION_CONFIGURATION_REQUIRED");
                }
                if (app && facts.navigation && facts.method === "GET"
                    && (["/chat", "/chat/all", "/cowork", "/cowork/"].includes(pathname)
                        || verified && scope.native.selectedChat && pathname === "/chat/conversation/" + scope.native.selectedChat)) {
                    kind = "document";
                } else {
                    const favicon = await qualifyNativeFavicon(scope, facts, stage);
                    const token = facts.url.origin === "https://login.microsoftonline.com"
                        && /^\/[A-Za-z0-9-]+\/oauth2\/v2\.0\/token$/.test(facts.url.pathname);
                    if (token && nativeRun.tokenEndpoint === null) nativeRun.tokenEndpoint = facts.url.origin + facts.url.pathname;
                    const returnImage = admitNativeReturnImage(scope, facts, stage);
                    const decision = returnImage ? { kind: "static" }
                        : accountOnlyRequestDecision({ ...facts, ...(favicon ? { type: "image" } : {}),
                            pageOrigin: URL.parse(scope.page.url())?.origin,
                            tokenEndpoint: nativeRun.tokenEndpoint, signInClicked: nativeSignInCurrent(scope), accountSelected: nativeAccountSelectionCurrent(scope) });
                    if (decision.denied) {
                        if (decision.denied === "data-dependency" && nativeAuthImageOrigins.has(facts.url?.origin)
                            && await qualifyDeniedReturnImage(scope, facts, stage)) return "policy-block";
                        if (decision.blockOnly && stage === "protocol") return "policy-block";
                        let authenticationChain, frameRole;
                        if (facts.navigation && stage === "protocol") {
                            authenticationChain = await authenticationChainEvidence(scope, facts);
                            if (ordinaryPartnerPreload && authenticationChain?.binding === "exact-original-network-request") {
                                frameRole = await readBootstrapFrameRole(scope, facts, authenticationChain);
                                if (frameRole.qualifiedPartnerPreload) {
                                    scope.native.partnerPreloadRole = { authenticationChain, frameRole };
                                    return "blocked-partner-preload";
                                }
                                if (frameRole.qualifiedCachedSession) {
                                    scope.native.cachedSessionRole = { authenticationChain, frameRole };
                                    return "blocked-cached-session";
                                }
                                if (frameRole.role === "device-fingerprinting" && frameRole.reviewedScript && frameRole.noLoadHandler
                                    && configuration.deviceRiskOrigin === facts.url.origin
                                    && facts.url.href.length <= deviceRiskLimits.urlLength && !scope.native.deviceRisk) {
                                    const identity = JSON.stringify([facts.frameId, facts.networkId]);
                                    if (scope.native.deviceRequestIds.has(identity)) throw sourceError("NATIVE_DEVICE_RISK_RESOURCE_UNQUALIFIED");
                                    scope.native.deviceRequestIds.add(identity);
                                    const outcome = scope.native.deviceRiskOutcome ??= { role: "native-device-risk", requests: 0, opaquePosts: 0,
                                        decodedResponseBytes: 0, completedResponses: 0, descendantDocuments: 0, failure: null };
                                    if (++outcome.requests > deviceRiskLimits.requests) {
                                        outcome.failure = "NATIVE_DEVICE_RISK_RESOURCE_LIMIT";
                                        throw sourceError(outcome.failure);
                                    }
                                    const risk = scope.native.deviceRisk = { origin: facts.url.origin, url: facts.url.href,
                                        frameId: facts.frameId, networkId: facts.networkId, epoch: nativeRun.documentEpoch,
                                        parent: scope.native.authorizeDocument, frame: null, requests: new Map(), routeEntries: [], scope,
                                        frames: new Map([[facts.frameId, { parentId: nativeRun.mainFrameId, frame: null, document: null }]]),
                                        documentRequests: new Map() };
                                    scope.native.deviceRiskRole = { authenticationChain, frameRole };
                                    scope.abort.signal.addEventListener("abort", () => {
                                        for (const request of risk.requests.values()) clearTimeout(request.timer);
                                        clearTimeout(risk.coverageTimer);
                                    }, { once: true });
                                    return "device-risk-document";
                                }
                            }
                        }
                        scope.native.denial ??= { reason: decision.denied,
                            context: accountOnlyDenialContext({ ...facts, stage: stage === "route" ? "route" : "request" }),
                            provenance: nativeRefusalEvidence(scope, facts),
                            ...(facts.method === "OPTIONS" && scope.native.deviceRisk
                                ? { frame: nativeFrameEvidence(scope, facts, stage) } : {}),
                            ...(facts.navigation ? { routing: nativeBootstrapRouteEvidence(facts.url),
                                initiator: nativeBootstrapRouteEvidence(URL.parse(scope.page.url())),
                                producerRecognized: nativeBuildKnown() } : {}),
                            ...(authenticationChain ? { authenticationChain } : {}), ...(frameRole ? { frameRole } : {}) };
                        assertNativeRequestAdmission(false, facts, stage, decision.denied,
                            engineering ? { engineering, scope, mainFrameId: nativeRun.mainFrameId } : null);
                    }
                    kind = decision.kind;
                    if (stage === "protocol" && kind === "bootstrap" && facts.method === "GET"
                        && ["fetch", "xhr"].includes(facts.type) && facts.frameId === nativeRun.mainFrameId
                        && [origin, "https://m365.cloud.microsoft"].includes(facts.url.origin)
                        && ["/client_health_ping", "/events-worker.js"].includes(facts.url.pathname)) {
                        await nativeWait(scope, () => scope.native.requestOrigins?.has(facts.networkId)
                            || scope.native.requestOriginsTruncated, 1000, facts.url.pathname === "/events-worker.js"
                                ? "NATIVE_WORKER_PREFLIGHT_SOURCE_UNQUALIFIED" : "NATIVE_HEALTH_PING_SOURCE_UNQUALIFIED");
                    }
                    const ancillary = stage === "protocol" && kind === "bootstrap" && nativeAppAncillaryRole(scope, facts, false);
                    if (ancillary) {
                        await nativeWait(scope, () => nativeAppAncillaryRole(scope, facts)?.kind === ancillary.kind,
                            1000, ancillary.kind === "native-worker-preflight"
                                ? "NATIVE_WORKER_PREFLIGHT_SOURCE_UNQUALIFIED" : "NATIVE_HEALTH_PING_SOURCE_UNQUALIFIED");
                        kind = ancillary.kind;
                    } else if (stage === "protocol" && kind === "bootstrap" && facts.url.pathname === "/client_health_ping") {
                        const reason = nativeTransportRefusal(scope, facts, "bootstrap-health-transport");
                        const request = scope.native.requestOrigins?.get(facts.networkId);
                        if (request) request.healthTransportAdmission = Object.freeze({
                            disposition: reason === null ? "transport-only-no-authority" : "ordinary-bootstrap", reason,
                        });
                        if (reason === null) kind = "bootstrap-health-transport";
                    } else if (stage === "protocol" && kind === "static" && presentationTypes.has(facts.type)
                        && facts.method === "GET" && facts.frameId === nativeRun.mainFrameId) {
                        const admissionDeadline = Math.min(nativeRun.deadline,
                            scope.phase === "native-connect" ? nativeRun.authDeadline : nativeRun.deadline);
                        const until = Math.min(Date.now() + 1000, admissionDeadline);
                        while (!scope.native.requestOrigins?.has(facts.networkId) && !scope.native.requestOriginsTruncated
                            && scope === current && !scope.error && !scope.abort.signal.aborted && !scope.operationSignal?.aborted
                            && accountProtocolReady && accountGate?.active && Date.now() < until) {
                            await delay(10, undefined, { signal: scope.abort.signal });
                        }
                        if (scope !== current || scope.error || scope.abort.signal.aborted || scope.operationSignal?.aborted
                            || Date.now() >= admissionDeadline) return null;
                        if (!accountProtocolReady || !accountGate?.active) {
                            nativeFailure(scope, "NATIVE_SOURCE_FRAME_COVERAGE_UNQUALIFIED");
                            return null;
                        }
                        if (nativeTransportRefusal(scope, facts, "static-presentation-transport") === null) {
                            kind = "static-presentation-transport";
                        }
                    }
                    if (kind === "self") scope.accountSelf[stage === "route" ? "routed" : "protocolConsumed"] = true;
                    if (kind === "self-preflight") scope.accountSelfPreflight.consumed = true;
                }
            }
            if (stage === "protocol") {
                const key = kind === "token" ? "token-" + facts.method : kind;
                const maximum = { principal: engineering ? 2 : 1, context: 8, "chat-list": 128, "cowork-list": 16, routing: 2, chat: 8,
                    "cowork-detail": 8, "cowork-messages": 128, "cowork-automations": 16, "cowork-schedule": 32, "cowork-trigger": 32,
                    self: 1, "self-preflight": 1, "token-POST": 8, "token-OPTIONS": 8 }[key];
                if (maximum !== undefined) {
                    const count = (nativeRun.counts.get(key) ?? 0) + 1;
                    if (count > maximum) throw sourceError("NATIVE_SOURCE_REQUEST_LIMIT");
                    nativeRun.counts.set(key, count);
                }
                scope.native.protocolCounts.set(kind, (scope.native.protocolCounts.get(kind) ?? 0) + 1);
            }
            return kind;
        } catch (error) {
            if (error instanceof MicrosoftSessionError && error.code === "timed-out") {
                recordNativeHostFailure(scope, error);
                scope.abort.abort();
                scope.observer.block();
            } else nativeFailure(scope, error);
            return null;
        }
    }
    async function guardNativePage(scopePage) {
        const protocol = await browser.newCDPSession(scopePage);
        accountProtocol = protocol;
        const { frameTree } = await protocol.send("Page.getFrameTree");
        const root = frameTree?.frame?.id, parents = new Map();
        nativeRun.mainFrameId = root;
        const add = (tree, parent, depth = 0) => {
            const id = tree?.frame?.id;
            if (typeof id !== "string" || !id || parents.has(id) || parents.size >= 128 || depth > 16) throw sourceError("NATIVE_SOURCE_FRAME_UNQUALIFIED");
            parents.set(id, parent);
            for (const child of tree.childFrames ?? []) add(child, id, depth + 1);
        };
        add(frameTree, null);
        const owned = id => {
            const seen = new Set();
            while (parents.has(id) && !seen.has(id) && seen.size <= 16) {
                if (id === root) return true;
                seen.add(id); id = parents.get(id);
            }
            return false;
        };
        readBootstrapFrameRole = async (scope, facts, chain) => {
            if (scope !== current || scope.phase !== "native-connect" || scope.abort.signal.aborted
                || accountProtocol !== protocol || parents.get(facts.frameId) !== root || !facts.original
                || facts.method !== "GET" || chain.frameRelation !== "direct-child"
                || chain.currentAuthorizeDocument !== "accepted-original-completed-noncached-200") {
                return { inspected: false, qualifiedPartnerPreload: false, reason: "not-current-original-authorize-child" };
            }
            const document = scope.native.authorizeDocument, epoch = nativeRun.documentEpoch;
            const componentPath = new URL(nativeHistoryProducer.cachedSessionsScriptAsset).pathname;
            const components = [...scope.native.authorizeScripts.values()].filter(script => {
                const url = new URL(script.entry.url);
                return ["https://aadcdn.msftauth.net", "https://aadcdn.msauth.net"].includes(url.origin)
                    && url.pathname === componentPath && !url.search && !url.hash && script.document === document;
            });
            const component = components.length === 1 ? components[0] : null;
            if (component?.document === document && !component.entry.cached) {
                await nativeWait(scope, () => component.entry.responseAcknowledged && component.entry.terminal === "finished",
                    1000, "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
            }
            const componentQualified = component?.document === document && component.entry.responseAcknowledged
                && component.entry.terminal === "finished" && !component.entry.cached;
            let objectId;
            try {
                const { backendNodeId } = await protocol.send("DOM.getFrameOwner", { frameId: facts.frameId });
                const { object } = await protocol.send("DOM.resolveNode", { backendNodeId });
                objectId = object?.objectId;
                if (!objectId) throw sourceError("NATIVE_SOURCE_FRAME_ROLE_UNQUALIFIED");
                const roleRead = {
                    objectId, returnByValue: true, silent: true, throwOnSideEffect: true,
                    arguments: [{ value: facts.url.href }, { value: document.entry.url }, { value: nativeCachedSessionBindings },
                        { value: Boolean(componentQualified) }, { value: false }],
                    functionDeclaration: `function(expectedSource, expectedDocument, expectedBindings, componentQualified, readMode) {
                        const node=this, doc=node.ownerDocument, parent=node.parentElement;
                        const binding=(parent?.getAttribute("data-bind") ?? "").replace(/\\s+/g,"");
                        const partnerContainer=parent?.id==="idPartnerPL" && doc.querySelectorAll('[id="idPartnerPL"]').length===1;
                        const fingerprintContainer=parent?.id==="idDFPDeviceFingerprinting" && doc.querySelectorAll('[id="idDFPDeviceFingerprinting"]').length===1;
                        const cachedSessionBinding=binding==="injectIframe:{url:svr.urlMsaStaticMeControl,onload:iFrame_onload}";
                        let cachedSessionControl=false,cachedSessionNormalView=false,cachedSessionTilesView=false;
                        if(cachedSessionBinding)for(let ancestor=parent.parentElement,depth=0;ancestor&&depth<8;ancestor=ancestor.parentElement,depth++){
                            const dataBinding=(ancestor.getAttribute("data-bind")??"").replace(/\\s+/g,"");
                            if(dataBinding===expectedBindings.control)cachedSessionControl=true;
                            const view=ancestor.getAttribute("data-viewid");
                            if(view!==null){
                                cachedSessionNormalView=cachedSessionControl&&view==="55"&&dataBinding===expectedBindings.view;
                                cachedSessionTilesView=view==="12";
                                break;
                            }
                        }
                        let cachedModeInspected=false,cachedModeFieldsQualified=false,cachedContext=false,cachedInteractive=false,
                            cachedMsaMode=false,cachedLookupEnabled=false,cachedLookupStarted=false,cachedSourceMatches=false;
                        if(readMode&&componentQualified&&cachedSessionBinding&&cachedSessionControl&&cachedSessionNormalView
                            &&node.tagName==="IFRAME"&&doc.URL===expectedDocument&&node.src===expectedSource
                            &&node.getAttribute("height")==="0"&&node.getAttribute("width")==="0"&&node.style.display==="none"
                            &&typeof node.onload==="function"&&node.getAttribute("onload")===null){
                            const unknown={};
                            const own=(object,key)=>{
                                if(!object||(typeof object!=="object"&&typeof object!=="function"))return unknown;
                                const descriptor=Object.getOwnPropertyDescriptor(object,key);
                                return descriptor&&Object.hasOwn(descriptor,"value")?descriptor.value:unknown;
                            };
                            const ko=own(doc.defaultView,"ko"),contextFor=own(ko,"contextFor");
                            if(typeof contextFor==="function"){
                                const context=contextFor(parent),data=own(context,"$data"),server=own(context,"svr");
                                cachedModeInspected=true;
                                cachedContext=data!==unknown&&data===own(context,"$component")&&own(context,"ko")===ko
                                    &&server!==unknown&&server===own(doc.defaultView,"ServerData")
                                    &&own(data,"fetchSessionsProgressPaginatedState")===55&&typeof own(data,"iFrame_onload")==="function";
                                if(cachedContext){
                                    const interactive=own(data,"isNonInteractiveAuthRequest"),mode=own(data,"sessionPullType"),
                                        enabled=own(server,"fProvideV2SsoImprovements"),serverMode=own(server,"iSessionPullType"),
                                        source=own(server,"urlMsaStaticMeControl");
                                    cachedModeFieldsQualified=(interactive===false||interactive===true||interactive===undefined)
                                        &&Number.isInteger(mode)&&Number.isInteger(serverMode)&&typeof enabled==="boolean"&&typeof source==="string";
                                    cachedInteractive=interactive===false||interactive===undefined;
                                    cachedMsaMode=(mode===1||mode===3)&&mode===serverMode;
                                    cachedLookupEnabled=enabled===true;
                                    cachedSourceMatches=typeof source==="string"&&new URL(source,doc.baseURI).href===expectedSource;
                                    const lookup=own(data,"callMsaStaticMeControl"),isObservable=own(ko,"isObservable"),isComputed=own(ko,"isComputed");
                                    if(typeof isObservable==="function"&&typeof isComputed==="function"
                                        &&isObservable(lookup)&&!isComputed(lookup)){
                                        let peek=unknown;
                                        for(let owner=lookup,depth=0;owner&&depth<3;owner=Object.getPrototypeOf(owner),depth++){
                                            const candidate=own(owner,"peek");if(candidate!==unknown){peek=candidate;break;}
                                        }
                                        cachedLookupStarted=typeof peek==="function"&&peek.call(lookup)===true;
                                    }
                                }
                            }
                        }
                        return { iframe:node.tagName==="IFRAME", ownerDocumentMatches:doc.URL===expectedDocument,
                            sourceMatches:node.src===expectedSource, partnerContainer,
                            partnerBinding:binding==="injectIframe:{url:svr.urlCBPartnerPreload}",
                            partnerHidden:node.getAttribute("height")==="0" && node.getAttribute("width")==="0" && node.style.display==="none",
                            noLoadHandler:node.onload===null && node.getAttribute("onload")===null,
                            fingerprintContainer, fingerprintBinding:binding==="injectDfpIframe:{url:dfpUrl()}",
                            fingerprintFrame:node.id==="iDeviceFingerPrinting" && node.style.visibility==="hidden",
                            cachedSessionBinding,cachedSessionControl,cachedSessionNormalView,cachedSessionTilesView,
                            cachedModeInspected,cachedModeFieldsQualified,cachedContext,cachedInteractive,cachedMsaMode,
                            cachedLookupEnabled,cachedLookupStarted,cachedSourceMatches,
                            cachedCallback:typeof node.onload==="function"&&node.getAttribute("onload")===null };
                    }`,
                };
                let result = await protocol.send("Runtime.callFunctionOn", roleRead);
                const initial = result.result?.value;
                if (!result.exceptionDetails && componentQualified && ["iframe", "ownerDocumentMatches", "sourceMatches",
                    "partnerHidden", "cachedSessionBinding", "cachedSessionControl", "cachedSessionNormalView", "cachedCallback"]
                    .every(key => initial?.[key] === true)) {
                    // V8 cannot certify native framework contextFor/peek calls. They run only after
                    // the closed DOM/source role check and read fixed mode flags, never cache values.
                    result = await protocol.send("Runtime.callFunctionOn", { ...roleRead, throwOnSideEffect: false,
                        arguments: [...roleRead.arguments.slice(0, -1), { value: true }] });
                }
                const value = result.result?.value;
                const keys = ["iframe", "ownerDocumentMatches", "sourceMatches", "partnerContainer", "partnerBinding",
                    "partnerHidden", "noLoadHandler", "fingerprintContainer", "fingerprintBinding", "fingerprintFrame",
                    "cachedSessionBinding", "cachedSessionControl", "cachedSessionNormalView", "cachedSessionTilesView",
                    "cachedModeInspected", "cachedModeFieldsQualified", "cachedContext", "cachedInteractive", "cachedMsaMode",
                    "cachedLookupEnabled", "cachedLookupStarted", "cachedSourceMatches", "cachedCallback"];
                if (result.exceptionDetails || !value || Object.keys(value).length !== keys.length
                    || keys.some(key => typeof value[key] !== "boolean") || scope !== current || scope.abort.signal.aborted
                    || scope.native.authorizeDocument !== document || nativeRun.documentEpoch !== epoch
                    || parents.get(facts.frameId) !== root || scope.page.url() !== document.entry.url) {
                    throw sourceError("NATIVE_SOURCE_FRAME_ROLE_UNQUALIFIED");
                }
                const first = chain.actualInitiator.type === "script" ? chain.actualInitiator.frames[0] : null;
                const reviewedScript = first?.binding === "accepted-current-authorize-script" && first.script
                    && nativeHistoryProducer.partnerPreloadScriptAssets.includes(first.script.publicOrigin + first.script.publicPath);
                const partner = value.iframe && value.ownerDocumentMatches && value.sourceMatches && value.partnerContainer
                    && value.partnerBinding && value.partnerHidden && value.noLoadHandler;
                const fingerprint = value.iframe && value.ownerDocumentMatches && value.sourceMatches
                    && value.fingerprintContainer && value.fingerprintBinding && value.fingerprintFrame;
                const cached = value.iframe && value.ownerDocumentMatches && value.sourceMatches && value.partnerHidden
                    && value.cachedSessionBinding && value.cachedSessionControl && value.cachedSessionNormalView && value.cachedCallback;
                const cachedMode = value.cachedModeInspected && value.cachedModeFieldsQualified && value.cachedContext
                    && value.cachedInteractive && value.cachedMsaMode && value.cachedLookupEnabled && value.cachedLookupStarted
                    && value.cachedSourceMatches;
                return { inspected: true, ...value, reviewedScript: Boolean(reviewedScript),
                    cachedComponentSource: Boolean(componentQualified),
                    deviceRiskOriginMatched: configuration.deviceRiskOrigin === facts.url.origin,
                    role: cached ? "cached-session-lookup" : partner ? "passive-partner-preload" : fingerprint ? "device-fingerprinting" : "unrecognized",
                    qualifiedPartnerPreload: Boolean(partner && reviewedScript),
                    qualifiedCachedSession: Boolean(cached && cachedMode && reviewedScript && componentQualified) };
            } finally {
                if (objectId) await protocol.send("Runtime.releaseObject", { objectId });
            }
        };
        protocol.on("Page.frameAttached", ({ frameId, parentFrameId }) => {
            if (!owned(parentFrameId) || parents.size >= 128) nativeFailure(current, "NATIVE_SOURCE_FRAME_UNQUALIFIED");
            else parents.set(frameId, parentFrameId);
        });
        protocol.on("Page.frameRequestedNavigation", event => {
            if (event.frameId === root && (!current || current.abort.signal.aborted)) revokeAppDocumentContinuity();
            if (current?.native && current.phase === "native-connect" && event.frameId === root) {
                const destination = typeof event.url === "string" && event.url.length <= 16384 ? URL.parse(event.url) : null;
                current.native.lastMainNavigation = destination?.protocol === "https:" && !destination.username && !destination.password
                    ? { url: event.url, reason: event.reason, document: current.native.currentDocument, epoch: nativeRun.documentEpoch }
                    : null;
            }
            if (current?.native && current.phase === "native-connect" && event.reason === "formSubmissionPost"
                && event.frameId === root && nativeAuthCallbackDestination(URL.parse(event.url))) {
                if (current.native.authCallbackNavigation) {
                    nativeFailure(current, "NATIVE_AUTH_CALLBACK_UNQUALIFIED"); return;
                }
                current.native.authCallbackNavigation = {
                    reason: event.reason, mainFrame: true, url: event.url,
                    document: current.native.currentDocument, epoch: nativeRun.documentEpoch,
                };
            }
            if (current?.native && current.phase === "native-connect" && event.reason === "formSubmissionPost"
                && event.frameId === root && nativeAuthContinuationDestination(current, URL.parse(event.url))) {
                if (current.native.authContinuationNavigation) {
                    nativeFailure(current, nativeAuthReturnFailure(true, "network", "duplicate-navigation")); return;
                }
                current.native.authContinuationNavigationUrl = event.url;
                current.native.authContinuationNavigationDocument = nativeAuthContinuationDocument(current);
                current.native.authContinuationNavigation = {
                    reason: event.reason, disposition: event.disposition, mainFrame: true,
                    epoch: nativeRun.documentEpoch,
                };
            }
            if (current?.native && current.phase === "native-connect" && event.reason === "formSubmissionPost"
                && event.frameId === root && nativeAuthReturnDestination(URL.parse(event.url))) {
                if (current.native.authPostNavigation) {
                    nativeFailure(current, nativeAuthReturnFailure(false, "network", "duplicate-navigation")); return;
                }
                current.native.authPostNavigationUrl = event.url;
                current.native.authPostNavigationDocument = current.native.authorizeDocument;
                current.native.authPostNavigation = {
                    reason: event.reason, disposition: event.disposition, mainFrame: true,
                    epoch: nativeRun.documentEpoch,
                };
            }
        });
        protocol.on("Page.frameDetached", ({ frameId, reason }) => {
            const risk = current?.native?.deviceRisk;
            if (reason === "swap" && risk?.frameId === frameId && configuration.deviceRiskOrigin
                && risk.parent === current.native.authorizeDocument && risk.epoch === nativeRun.documentEpoch) {
                if (!risk.childGate?.active) {
                    risk.coveragePending = true;
                    risk.coverageTimer ??= setTimeout(() => nativeFailure(risk.scope, "NATIVE_DEVICE_RISK_FRAME_COVERAGE_UNQUALIFIED"), 2000);
                }
                return;
            }
            if (risk?.frameId === frameId && reason === "remove" && !risk.coveragePending
                && [...risk.requests.values()].every(request => request.finished)
                && (!risk.childGate || risk.childGate.pendingCount === 0)) risk.retired = true;
            parents.delete(frameId);
            if (reason === "swap") nativeFailure(current, "NATIVE_SOURCE_FRAME_COVERAGE_UNQUALIFIED");
        });
        protocol.on("Page.frameNavigated", ({ frame }) => {
            if (!frame.parentId) {
                revokeAppDocumentContinuity();
                if (frame.id !== root) nativeFailure(current, "NATIVE_SOURCE_FRAME_UNQUALIFIED");
                else {
                    const risk = current?.native?.deviceRisk;
                    if (risk && !risk.coveragePending && [...risk.requests.values()].every(request => request.finished)
                        && (!risk.childGate || risk.childGate.pendingCount === 0)) risk.retired = true;
                    parents.clear(); parents.set(root, null);
                    nativeRun.documentEpoch++;
                    const currentDocument = current?.native?.currentDocument;
                    if (currentDocument?.entry.frameId === frame.id && currentDocument.entry.networkId === frame.loaderId) {
                        currentDocument.epoch = nativeRun.documentEpoch;
                    }
                    nativeRun.assets.clear();
                    current?.native?.authorizeScripts.clear();
                    current?.native?.authorizeStaticOrigins.clear();
                    current?.native?.authDocumentRequests.clear();
                    if (current?.native?.authorizeDocument) {
                        if (current.native.authorizeDocument.entry.url === frame.url) {
                            current.native.authorizeDocument.epoch = nativeRun.documentEpoch;
                        } else current.native.authorizeDocument = null;
                    }
                    const destination = URL.parse(frame.url);
                    if (verified && destination && ![origin, "https://m365.cloud.microsoft"].includes(destination.origin)) {
                        nativeFailure(current, "NATIVE_SOURCE_ACCESS_EXPIRED");
                    }
                }
            }
        });
        protocol.on("Page.navigatedWithinDocument", ({ frameId }) => {
            if (frameId === root && (!current || current.abort.signal.aborted)) revokeAppDocumentContinuity();
        });
        protocol.on("close", revokeAppDocumentContinuity);
        await protocol.send("Page.enable");
        const chatActionContext = scope => {
            const run = nativeRun, purpose = scope.phase, lease = scope.lease, document = scope.native.currentDocument;
            const epoch = run.documentEpoch, url = scope.page.url(), owner = ownerId;
            const documentEntry = document?.entry, loaderId = documentEntry?.networkId;
            const generation = lease?.generation ?? scope.native.connectLimits?.generation;
            const deadline = purpose === "native-connect" ? Math.min(run.authDeadline, run.deadline) : run.deadline;
            const currentProof = () => !engineering && scope === current && run === nativeRun && !closed && !browserClosed
                && !scope.abort.signal.aborted && !scope.operationSignal?.aborted && scope.phase === purpose && scope.lease === lease
                && ["native-connect", "native-collection-bootstrap", "chat-discovery", "cowork-discovery", "chat", "cowork"].includes(purpose)
                && (purpose === "native-connect" ? !lease : lease?.kind === "microsoft-read")
                && typeof owner === "string" && owner.length > 0 && Number.isSafeInteger(generation)
                && ownerId === owner && run.ownerId === owner && run.generation === generation
                && scope.page === scopePage && page === scopePage && !page.isClosed() && page.url() === url
                && accountProtocol === protocol && accountProtocolReady && accountGate?.active
                && document && documentEntry && document === scope.native.currentDocument && document.entry === documentEntry
                && documentEntry.networkId === loaderId && document.epoch === epoch
                && run.documentEpoch === epoch && owned(root) && Date.now() < deadline;
            return { document, epoch, url, deadline, current: currentProof, async check() {
                try { if (lease) await lifecycle.assertLease(lease); }
                catch (error) { nativeFailure(scope, error); return false; }
                return currentProof();
            } };
        };
        const chatRpcUrl = url => !engineering && url && [origin, "https://m365.cloud.microsoft"].includes(url.origin)
            && url.pathname.replace(/^\/hwav2(?=\/)/, "") === "/_serverFn/" + nativeHistoryProducer.chatRpcId;
        const gateOptions = {
            mainFrameId: root, ownsFrame: owned, diagnoseFrames: false, keepIdle: true,
            getAncillaryDocument: ancillaryDocument,
            chatActionUrl: (_scope, url) => chatRpcUrl(url),
            async bindChatAction(scope, facts) {
                try {
                    const binding = chatActionContext(scope);
                    const networkId = facts.networkId, requestUrl = facts.url.href, frameId = facts.frameId;
                    const invalid = () => withNativeFailurePredicate(sourceError("NATIVE_CHAT_ACTION_UNQUALIFIED"),
                        "protocol", "chat-action-binding");
                    if (!binding.current() || frameId !== root) throw invalid();
                    const recordFor = () => scope.native.requestOrigins?.get(networkId);
                    await nativeWait(scope, () => Boolean(recordFor()) || scope.native.requestOriginsTruncated
                        || !binding.current(), Math.max(0, Math.min(1000, binding.deadline - Date.now())), "NATIVE_CHAT_ACTION_UNQUALIFIED")
                        .catch(error => { throw withNativeFailurePredicate(error, "protocol", "chat-action-binding"); });
                    const record = recordFor();
                    const currentProof = () => binding.current() && recordFor() === record && record
                        && record.original && !record.duplicate && record.owned && record.frameId === root && record.networkId === networkId
                        && record.method === "POST" && record.url === requestUrl
                        && ["fetch", "xhr"].includes(record.type) && record.document === binding.document
                        && record.epoch === binding.epoch && record.documentUrl === binding.url
                        && record.loaderId === binding.document.entry.networkId;
                    if (!await binding.check() || !currentProof() || record.chatActionDenied) throw invalid();
                    record.chatActionDenied = true;
                    return { deadline: binding.deadline, current: currentProof,
                        check: async () => await binding.check() && currentProof() };
                } catch (error) {
                    nativeFailure(scope, error);
                    throw error;
                }
            },
            chatActionPreflight(scope, facts) {
                const binding = chatActionContext(scope), record = scope.native.requestOrigins?.get(facts.networkId);
                const post = scope.native.requestOrigins?.get(record?.initiatorRequestId);
                const currentProof = () => binding.current() && scope.native.requestOrigins?.get(facts.networkId) === record
                    && record && record.original && !record.duplicate && record.method === "OPTIONS"
                    && record.initiatorType === "preflight" && record.url === facts.url.href
                    && typeof record.initiatorRequestId === "string" && record.initiatorRequestId.length > 0
                    && record.initiatorRequestId.length <= 256
                    && (record.frameId === undefined || record.frameId === root) && facts.frameId === root
                    && record.document === binding.document && record.epoch === binding.epoch && record.documentUrl === binding.url
                    && post?.chatActionDenied === true && post.url === record.url && post.method === "POST"
                    && scope.native.requestOrigins?.get(record.initiatorRequestId) === post;
                return currentProof() ? { networkId: record.initiatorRequestId, current: currentProof,
                    check: binding.check } : null;
            },
            validateBootstrapTransport(scope, entry) {
                return entry.scope === scope && entry.hops === 1 && entry.method === "GET"
                    && entry.initial?.networkId === entry.networkId && entry.initial.frameId === entry.frameId
                    && entry.initial.method === entry.method && entry.initial.url === entry.url && entry.initial.type === entry.type
                    && nativeTransportRefusal(scope, entry.facts, entry.kind) === null;
            },
            bindDeniedImage(scope, facts) {
                return scope.native.requestOrigins?.get(facts.networkId)?.deniedImageProof ?? null;
            },
            telemetryAttemptLimit: nativeRun.attended ? nativeTelemetryAttemptLimits.attended : nativeTelemetryAttemptLimits.unattended,
            getAuthorizationContext: ordinaryPartnerPreload ? scope => {
                const native = scope.native, document = native?.authorizationRoot, limits = native?.connectLimits;
                if (scope !== current || scope.page !== scopePage || accountProtocol !== protocol
                    || scope.phase !== "native-connect" || scope.abort.signal.aborted || scope.operationSignal?.aborted
                    || scope.error || !native || native.authTransition || !limits || limits.ownerId !== nativeRun.ownerId
                    || limits.generation !== nativeRun.generation || limits.authDeadline !== nativeRun.authDeadline
                    || limits.deadline !== nativeRun.deadline || Date.now() >= limits.authDeadline || Date.now() >= limits.deadline
                    || document !== native.currentDocument || document?.epoch !== nativeRun.documentEpoch
                    || document?.entry.scope !== scope || document.entry.responseStatus !== 200 || document.entry.cached
                    || !document.entry.responseAcknowledged || document.entry.terminal !== "finished"
                    || native.authorizationContext !== 0 && !(native.authorizationContext === 1
                        && native.authorizationReentry?.activated === 1 && native.authorizationReentry.retired)) return null;
                return native.authorizationContext;
            } : undefined,
            allowFetchOnlyTelemetryDenial(scope, facts) {
                return ordinaryPartnerPreload && scope === current && scope.page === scopePage && accountProtocol === protocol
                    && scope.phase === "native-connect" && !scope.abort.signal.aborted && Date.now() < nativeRun.deadline
                    && facts.frameId === root && owned(root) && blockedTelemetryDestination(facts.url);
            },
            bindRequestCapacity(scope, facts, { waitForMetadata } = {}) {
                const run = nativeRun, limits = scope.native.connectLimits, phase = scope.phase, lease = scope.lease;
                const collection = !engineering && lease?.kind === "microsoft-read"
                    && ["native-collection-bootstrap", "chat-discovery", "cowork-discovery", "cowork-membership", "chat", "cowork"].includes(phase);
                const original = Object.freeze({ networkId: facts.networkId, frameId: facts.frameId,
                    url: facts.url?.href, method: facts.method, original: facts.original, navigation: facts.navigation });
                let request = scope.native.requestOrigins?.get(original.networkId);
                let preflightRequest = request?.initiatorType === "preflight"
                    ? scope.native.requestOrigins?.get(request.initiatorRequestId) : null;
                const document = request?.document ?? ancillaryDocument(scope), epoch = run.documentEpoch;
                const documentEntry = document?.entry, loaderId = documentEntry?.networkId;
                const pageUrl = scope.page.url(), generation = collection ? lease.generation : limits?.generation, expectedOwner = ownerId;
                // A callback's same-document /home transition does not replace its owning loader.
                const existingImageRole = !collection && facts.url?.origin === "https://aadcdn.msauthimages.net"
                    && scope.native.authReturnAccepted?.networkId === loaderId;
                const imageTransaction = !collection && !existingImageRole && original.method === "GET" && facts.type === "image"
                    && nativeAuthImageOrigins.has(facts.url?.origin)
                    ? nativeReturnImageTransaction(scope, document) : null;
                const imageDocumentCurrent = () => imageTransaction
                    && nativeReturnImageTransaction(scope, document) === imageTransaction
                    && URL.parse(scope.page.url())?.origin === URL.parse(documentEntry.url)?.origin;
                const authDeadline = limits?.authDeadline, operationDeadline = collection ? run.deadline : limits?.deadline;
                const deadline = collection ? operationDeadline : Math.min(authDeadline, operationDeadline);
                let associating = false, late = false, rejection = null;
                const contextFailure = () => {
                    if (scope !== current || scope.error || scope.abort.signal.aborted || scope.operationSignal?.aborted
                        || scope.phase !== phase || scope.lease !== lease
                        || !(collection || phase === "native-connect" && !lease)) return "scope";
                    if (run !== nativeRun || closed || browserClosed || page !== scopePage || scope.page !== scopePage
                        || page.isClosed() || accountProtocol !== protocol || !accountProtocolReady || !accountGate?.active
                        || ownerId !== expectedOwner || run.ownerId !== expectedOwner
                        || !Number.isSafeInteger(generation) || run.generation !== generation
                        || run.deadline !== operationDeadline
                        || (collection ? !verified || leaseScopes.get(lease) !== scope || lease.generation !== generation
                                || original.frameId !== root
                            : limits?.ownerId !== expectedOwner || limits.generation !== generation
                                || limits.authDeadline !== authDeadline || run.authDeadline !== authDeadline
                                || limits.deadline !== operationDeadline)
                        || !owned(original.frameId)) return "custody";
                    if (!document || !documentEntry || document !== ancillaryDocument(scope) || document.entry !== documentEntry
                        || documentEntry.networkId !== loaderId || document.epoch !== epoch
                        || run.documentEpoch !== epoch || scope.page.url() !== pageUrl && !imageDocumentCurrent()) return "document";
                    if (collection && (documentEntry.frameId !== root || documentEntry.responseStatus !== 200
                        || !documentEntry.responseAcknowledged || documentEntry.cached
                        || ![origin, "https://m365.cloud.microsoft"].includes(URL.parse(documentEntry.url)?.origin)
                        || URL.parse(documentEntry.url)?.origin !== URL.parse(pageUrl)?.origin)) return "document";
                    return null;
                };
                const metadataFailure = record => {
                    if (!record) return scope.native.requestOriginsTruncated ? "metadata-capped" : "metadata-missing";
                    if (record.duplicate) return "metadata-duplicate";
                    if (record.original !== original.original || record.networkId !== original.networkId
                        || record.url !== original.url || record.method !== original.method) {
                        return "metadata-mismatch";
                    }
                    const preflight = collection && original.method === "OPTIONS" && record.initiatorType === "preflight";
                    if (preflight) {
                        // Chromium can omit the preflight Network frame/loader. Its exact linked
                        // original supplies document custody, never permission for either request.
                        if (!original.original || original.navigation || original.frameId !== root
                            || !["other", "preflight"].includes(record.type)
                            || record.frameId !== undefined && record.frameId !== root
                            || !preflightRequest || scope.native.requestOrigins?.get(record.initiatorRequestId) !== preflightRequest
                            || preflightRequest.networkId !== record.initiatorRequestId || preflightRequest.networkId === record.networkId
                            || !preflightRequest.original || preflightRequest.duplicate || !preflightRequest.owned
                            || preflightRequest.frameId !== root || !["fetch", "xhr"].includes(preflightRequest.type)
                            || !["GET", "POST"].includes(preflightRequest.method) || preflightRequest.url !== record.url) {
                            return "metadata-mismatch";
                        }
                        if (preflightRequest.document !== document || preflightRequest.epoch !== epoch
                            || preflightRequest.documentUrl !== pageUrl || preflightRequest.loaderId !== loaderId
                            || record.loaderId !== null && record.loaderId !== "" && record.loaderId !== loaderId) {
                            return "metadata-stale";
                        }
                    } else if (!record.owned || record.frameId !== original.frameId) return "metadata-mismatch";
                    if (record.document !== document || record.epoch !== epoch
                        || record.documentUrl !== pageUrl && !(imageDocumentCurrent()
                            && URL.parse(record.documentUrl)?.origin === URL.parse(documentEntry.url)?.origin)
                        || !preflight && (late || collection) && record.loaderId !== (original.navigation ? original.networkId : loaderId)) {
                        return "metadata-stale";
                    }
                    return null;
                };
                const matchedFailure = () => scope.native.requestOrigins?.get(original.networkId) !== request
                    ? "metadata-mismatch" : metadataFailure(request);
                const failureEvidence = reason => ({
                    reason: rejection ?? contextFailure() ?? (reason === "capacity-deadline" ? "deadline" : matchedFailure()) ?? "unavailable",
                    retained: scope.native.requestOrigins?.size ?? 0, limit: nativeRequestOriginLimit,
                    capped: scope.native.requestOriginsTruncated === true,
                });
                const currentBinding = () => contextFailure() === null && (associating || matchedFailure() === null);
                const binding = { deadline, current: currentBinding, failureEvidence };
                if (currentBinding()) return binding;
                if (!waitForMetadata) return null;
                rejection = contextFailure() ?? (request ? matchedFailure() : null);
                const url = facts.url;
                if (!rejection && (!url || url.protocol !== "https:" || url.username || url.password
                    || url.href.length > 16384 || scope.native.deviceRisk?.frames?.has(original.frameId)
                    || !original.navigation && original.frameId !== root)) rejection = "metadata-excluded";
                if (!rejection && scope.native.requestOriginsTruncated) rejection = "metadata-capped";
                if (rejection) return { refused: failureEvidence("capacity-unbound") };
                const until = Math.min(Date.now() + 1000, deadline);
                // This provisional predicate pins custody; association must finish before source admission.
                associating = true;
                binding.associate = async () => {
                    try {
                        while (true) {
                            rejection = contextFailure();
                            if (rejection) return "capacity-owner-changed";
                            if (Date.now() >= deadline) { rejection = "deadline"; return "capacity-deadline"; }
                            const candidate = scope.native.requestOrigins?.get(original.networkId);
                            if (!candidate && scope.native.requestOriginsTruncated) {
                                rejection = "metadata-capped"; return "capacity-unbound";
                            }
                            if (Date.now() >= until) { rejection = "metadata-timeout"; return "capacity-unbound"; }
                            if (candidate) {
                                request = candidate; late = true;
                                preflightRequest = candidate.initiatorType === "preflight"
                                    ? scope.native.requestOrigins?.get(candidate.initiatorRequestId) : null;
                                rejection = metadataFailure(candidate);
                                return rejection ? "capacity-unbound" : null;
                            }
                            try { await delay(Math.max(1, Math.min(10, until - Date.now())), undefined, { signal: scope.abort.signal }); }
                            catch (error) {
                                if (!scope.abort.signal.aborted) throw error;
                                rejection = "scope"; return "capacity-owner-changed";
                            }
                        }
                    } finally { associating = false; }
                };
                return binding;
            },
            async qualifyAppTelemetry(scope, observation) {
                const facts = { ...observation, url: URL.parse(observation.url), navigation: false };
                const role = nativeAppAncillaryRole(scope, facts, false);
                if (role?.kind !== "blocked-app-events-post") return false;
                await nativeWait(scope, () => nativeAppAncillaryRole(scope, facts)?.purpose === role.purpose,
                    1000, "NATIVE_APP_EVENTS_SOURCE_UNQUALIFIED");
                return () => {
                    const currentRole = nativeAppAncillaryRole(scope, facts);
                    return currentRole?.kind === role.kind && currentRole.purpose === role.purpose;
                };
            },
            collectionLoggerCurrent(scope) {
                return !engineering && browserOwnedSignIn() && nativeRun.collectionPrepared
                    && scope === current && scope.lease?.kind === "microsoft-read" && leaseScopes.get(scope.lease) === scope
                    && verified && !scope.error && !scope.abort.signal.aborted && !scope.operationSignal?.aborted
                    && nativeRun.generation === scope.lease.generation && nativeRun.ownerId === ownerId
                    && (["native-collection-bootstrap", "chat-discovery", "cowork-discovery", "cowork-membership", "chat", "cowork"].includes(scope.phase)
                        || scope.phase === "bootstrap" && scope.native.appDocumentBinding
                            && ancillaryDocument(scope) === scope.native.appDocumentBinding.document)
                    && accountProtocol === protocol && accountProtocolReady && accountGate?.active
                    && scope.page === scopePage && page === scopePage && !scopePage.isClosed()
                    && !browserClosed && !closed && Date.now() < nativeRun.deadline;
            },
            async bindCspReport(scope, facts) {
                const run = nativeRun, document = ancillaryDocument(scope), lease = scope.lease, phase = scope.phase;
                const pageUrl = scopePage.url(), epoch = run.documentEpoch, deadline = run.deadline;
                const contextCurrent = () => gateOptions.collectionLoggerCurrent(scope) && run === nativeRun
                    && scope.lease === lease && scope.phase === phase && run.deadline === deadline
                    && document && document === ancillaryDocument(scope) && document.epoch === epoch
                    && epoch === run.documentEpoch && scopePage.url() === pageUrl
                    && document.entry.frameId === root && document.entry.method === "GET"
                    && document.entry.responseStatus === 200 && document.entry.responseAcknowledged && !document.entry.cached
                    && [origin, "https://m365.cloud.microsoft"].includes(URL.parse(document.entry.url)?.origin)
                    && URL.parse(document.entry.url)?.origin === URL.parse(pageUrl)?.origin;
                if (!contextCurrent()) return null;
                await nativeWait(scope, () => Boolean(scope.native.requestOrigins?.has(facts.networkId)
                    || scope.native.requestOriginsTruncated), 1000, "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
                const record = scope.native.requestOrigins?.get(facts.networkId);
                const network = scope.native.networkRecordObservations?.get(facts.networkId);
                const current = () => contextCurrent() && !scope.native.requestOriginsTruncated && record
                    && scope.native.requestOrigins.get(facts.networkId) === record && record.original && !record.duplicate
                    && network && scope.native.networkRecordObservations.get(facts.networkId) === network
                    && network.observation === "original" && network.frame === "root"
                    && network.document === "matched-at-request" && network.loader === "matched-at-request"
                    && record.owned && record.frameId === root && facts.frameId === root && record.method === "POST"
                    && ["other", "cspviolationreport"].includes(record.type) && facts.type === "cspviolationreport"
                    && record.url === facts.url.href && record.document === document && record.epoch === epoch
                    && record.loaderId === document.entry.networkId && record.documentUrl === pageUrl;
                if (!current()) return null;
                return { deadline, current, async check() {
                    try { await lifecycle.assertLease(lease); }
                    catch (error) { nativeFailure(scope, error); return false; }
                    return current();
                } };
            },
            observeNetworkResource(scope, observation) {
                const facts = { url: URL.parse(observation.requestUrl), ...observation, navigation: false };
                if (observation.frameId !== root || !observation.owned || observation.initiatorType !== "other"
                    || !faviconCandidate(facts)) return;
                const records = scope.native.faviconRequests ??= new Map();
                if (records.size >= 8 || records.has(observation.networkId)) {
                    const error = nativeFaviconFailure(scope, "network",
                        records.has(observation.networkId) ? "duplicate-request" : "request-limit", undefined,
                        records.has(observation.networkId) ? "favicon-request-not-duplicate" : "favicon-request-budget");
                    nativeFailure(scope, error); return;
                }
                const document = scope.native.currentDocument, epoch = nativeRun.documentEpoch, pageUrl = scope.page.url();
                const proof = track((async () => {
                    if (!document || document.epoch !== epoch) throw nativeFaviconFailure(scope, "network", "document-context", undefined,
                        !document ? "favicon-document-present" : "favicon-document-epoch");
                    const callback = scope.native.authCallbackAccepted;
                    const callbackSource = () => {
                        const original = scope.native.requestOrigins?.get(callback?.networkId);
                        return scope.phase === "native-connect" && callback?.routed
                            && scope.native.authCallbackAccepted === callback && document.entry.scope === scope
                            && document.entry.method === "POST" && document.entry.hops === 1
                            && document.entry.frameId === root && document.entry.networkId === callback.networkId
                            && document.entry.url === callback.url && nativeAuthCallbackDestination(URL.parse(callback.url))
                            && document.entry.responseStatus === 200 && !document.entry.cached
                            && document.epoch === callback.epoch + 1
                            && original?.original && !original.duplicate && original.owned && original.frameId === root
                            && original.method === "POST" && original.type === "document" && original.url === callback.url
                            && original.document === callback.document && original.epoch === callback.epoch;
                    };
                    const sourceReady = () => document.entry.responseAcknowledged
                        && (document.entry.terminal === "finished" || document.entry.terminal === null && callbackSource());
                    try { await nativeWait(scope, sourceReady, 1000, "NATIVE_FAVICON_UNQUALIFIED"); }
                    catch (error) {
                        throw nativeFaviconFailure(scope, "network", "source-readiness", error,
                            !document.entry.responseAcknowledged ? "favicon-source-response-acknowledged" : "favicon-source-terminal");
                    }
                    let timer, declaration;
                    try {
                        declaration = await Promise.race([
                            scope.page.locator('link[rel~="icon"]').evaluateAll((links, expected) => {
                                if (links.length > 8) return { withinLimit: false, unique: null };
                                return { withinLimit: true, unique: links.filter(link => link.ownerDocument.URL === expected.document
                                    && link.href === expected.url).length === 1 };
                            }, { document: pageUrl, url: observation.requestUrl }),
                            new Promise((_, reject) => { timer = setTimeout(() => reject(sourceError("NATIVE_FAVICON_UNQUALIFIED")), 1000); }),
                        ]);
                        if (!declaration || Object.keys(declaration).length !== 2
                            || typeof declaration.withinLimit !== "boolean"
                            || (declaration.withinLimit ? typeof declaration.unique !== "boolean" : declaration.unique !== null)) {
                            throw sourceError("NATIVE_FAVICON_UNQUALIFIED");
                        }
                    } catch (error) { throw nativeFaviconFailure(scope, "network", "declaration-read", error, "favicon-declaration-readable"); }
                    finally { clearTimeout(timer); }
                    if (!declaration.withinLimit || !declaration.unique) throw nativeFaviconFailure(scope, "network", "declaration-unqualified",
                        undefined, !declaration.withinLimit ? "favicon-declaration-budget" : "favicon-declaration-unique");
                    return () => {
                        if (scope !== current) return "favicon-binding-scope";
                        if (scope.abort.signal.aborted) return "favicon-binding-aborted";
                        if (scope.operationSignal?.aborted) return "favicon-binding-operation";
                        if (scope.page !== scopePage) return "favicon-binding-page";
                        if (accountProtocol !== protocol) return "favicon-binding-protocol";
                        if (!owned(root)) return "favicon-binding-frame";
                        if (scope.page.url() !== pageUrl) return "favicon-binding-url";
                        if (scope.native.currentDocument !== document) return "favicon-binding-document";
                        if (nativeRun.documentEpoch !== epoch || document.epoch !== epoch) return "favicon-binding-epoch";
                        if (document.entry.cached) return "favicon-binding-cache";
                        if (!document.entry.responseAcknowledged) return "favicon-source-response-acknowledged";
                        if (!sourceReady()) return "favicon-source-terminal";
                        return null;
                    };
                })().then(value => ({ value }), error => ({ error })), scope);
                records.set(observation.networkId, { ...observation, epoch, proof, admitted: false, routed: false });
            },
            allowAuthTelemetryDenial(scope, observation) {
                const run = nativeRun, limits = scope.native.connectLimits;
                // Permission to deny the exact collector confers no trust on its caller or evidence.
                const currentDenial = () => ordinaryPartnerPreload && scope === current
                    && !scope.abort.signal.aborted && !scope.operationSignal?.aborted && scope.phase === "native-connect"
                    && scope.page === scopePage && page === scopePage && !page.isClosed() && !browserClosed && !closed
                    && accountProtocol === protocol && accountProtocolReady && accountGate?.active
                    && run === nativeRun && run.ownerId === ownerId && limits?.ownerId === ownerId
                    && Number.isSafeInteger(limits?.generation) && limits.generation === run.generation
                    && Date.now() < limits.authDeadline && Date.now() < limits.deadline
                    && observation.frameId === root && observation.owned && owned(root);
                return currentDenial() ? currentDenial : false;
            },
            observeNetworkDocument: observeAuthenticationChain || ordinaryPartnerPreload ? (scope, observation) => {
                if (scope.phase === "native-connect" && observation.method === "POST" && observation.frameId === root
                    && nativeAuthContinuationDestination(scope, URL.parse(observation.requestUrl))) {
                    const records = scope.native.authContinuationRequests ??= new Map();
                    if (records.size) {
                        nativeFailure(scope, nativeAuthReturnFailure(true, "network", "duplicate-network")); return;
                    }
                    records.set(observation.networkId, { networkId: observation.networkId, frameId: observation.frameId,
                        requestUrl: observation.requestUrl, original: observation.original, hasUserGesture: observation.hasUserGesture,
                        document: nativeAuthContinuationDocument(scope), epoch: nativeRun.documentEpoch });
                }
                if (scope.phase === "native-connect" && observation.method === "POST" && observation.frameId === root
                    && nativeAuthReturnDestination(URL.parse(observation.requestUrl))) {
                    const records = scope.native.authPostRequests ??= new Map();
                    if (records.size) {
                        nativeFailure(scope, nativeAuthReturnFailure(false, "network", "duplicate-network")); return;
                    }
                    records.set(observation.networkId, { networkId: observation.networkId, frameId: observation.frameId,
                        requestUrl: observation.requestUrl, original: observation.original, hasUserGesture: observation.hasUserGesture,
                        document: scope.native.authorizeDocument, epoch: nativeRun.documentEpoch });
                }
                if (scope.native.deviceRisk?.frameId === observation.frameId) return;
                const url = URL.parse(observation.requestUrl);
                const requestedDiagnostic = observeAuthenticationChain && url?.origin === "https://login.live.com";
                const authChild = ordinaryPartnerPreload && scope.phase === "native-connect" && observation.method === "GET"
                    && observation.frameId !== root && owned(observation.frameId) && scope.native.authorizeDocument
                    && accountOnlyRequestDecision({ url, method: observation.method, type: "document", navigation: true,
                        owned: true, original: observation.original, pageOrigin: URL.parse(scope.page.url())?.origin,
                        tokenEndpoint: nativeRun.tokenEndpoint, signInClicked: nativeSignInCurrent(scope),
                        accountSelected: nativeAccountSelectionCurrent(scope) }).denied;
                if (!requestedDiagnostic && !authChild) return;
                if (scope.native.authDocumentRequests.size >= 3 || scope.native.authDocumentRequests.has(observation.networkId)) {
                    nativeFailure(scope, "NATIVE_SOURCE_REQUEST_LIMIT"); return;
                }
                const parent = parents.get(observation.frameId);
                scope.native.authDocumentRequests.set(observation.networkId, { ...observation, scope,
                    epoch: nativeRun.documentEpoch, document: scope.native.authorizeDocument,
                    frameRelation: observation.frameId === root ? "top-level" : parent === root ? "direct-child"
                        : owned(observation.frameId) ? "owned-descendant" : "unowned",
                    parentOwned: parent !== null && parent !== undefined && owned(parent) });
            } : undefined,
            blockedBootstrapChild: blockedBootstrapChildOrigin === null ? null : {
                origin: blockedBootstrapChildOrigin,
                async qualify(scope, frameId, initiatorUrl) {
                    const document = scope.native.authorizeDocument;
                    const script = nativeAuthorizeScript(scope, initiatorUrl);
                    if (scope.phase !== "native-connect" || parents.get(frameId) !== root || !document
                        || document.entry.url !== initiatorUrl && script?.document?.entry !== document.entry
                        || scope.page.url() !== document.entry.url
                        || document.epoch !== nativeRun.documentEpoch || document.entry.cached) return false;
                    await nativeWait(scope, () => document.entry.responseAcknowledged && document.entry.terminal === "finished",
                        1000, "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
                    if (script) await nativeWait(scope, () => script.entry.responseAcknowledged && script.entry.terminal === "finished",
                        1000, "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
                    return scope.native.authorizeDocument === document && document.epoch === nativeRun.documentEpoch
                        && parents.get(frameId) === root && scope.page.url() === document.entry.url && !document.entry.cached
                        && (!script || nativeAuthorizeScript(scope, initiatorUrl) === script && !script.entry.cached);
                },
            },
            getScope: () => current?.page === scopePage && accountProtocol === protocol ? current : null,
            admit: admitNative, track,
            stop(scope, reason, facts, observation) {
                const failure = nativeProtocolFailure(reason, facts, { scope, mainFrameId: root, observation });
                if (nativeStopRecorded(scope)) {
                    recordNativeHostFailure(scope, failure);
                    return;
                }
                const limits = scope?.native?.connectLimits;
                if (reason === "capacity-deadline" && scope === current && scope.phase === "native-connect"
                    && limits?.ownerId === ownerId && limits.generation === nativeRun.generation
                    && limits.authDeadline === nativeRun.authDeadline && limits.deadline === nativeRun.deadline
                    && Date.now() >= Math.min(limits.authDeadline, limits.deadline)) {
                    const details = nativeFailureDetails(failure, "protocol");
                    const timeout = withNativeFailurePredicate(new MicrosoftSessionError("timed-out"),
                        details.predicate.stage, details.predicate.name);
                    if (details.protocolStop) withNativeFailureProtocolStop(timeout, details.protocolStop);
                    recordNativeHostFailure(scope, timeout);
                    scope.abort.abort();
                    scope.observer.block();
                    return;
                }
                if (scope?.native) scope.native.denial ??= { reason, context: accountOnlyDenialContext(facts),
                    provenance: nativeRefusalEvidence(scope, facts) };
                nativeFailure(scope, failure);
            },
            acceptResponse(scope, kind, status) {
                if (status === 401 || status === 403) nativeFailure(scope, "NATIVE_SOURCE_ACCESS_EXPIRED");
                if (kind.startsWith("device-risk-") && status >= 300 && status < 400) {
                    nativeFailure(scope, "NATIVE_DEVICE_RISK_REDIRECT_UNQUALIFIED");
                    return false;
                }
                if (kind === "native-preflight") return status >= 200 && status < 300;
                return status >= 200 && status < 400 && (!["principal", "context", "chat-list", "cowork-list", "routing", "chat", "cowork-detail", "cowork-messages",
                    ...COWORK_MEMBERSHIP_KINDS].includes(kind) || status === 200);
            },
            allowReadFailureResponse(scope, entry) {
                return !engineering && scope === current && scope.lease?.kind === "microsoft-read"
                    && verified && !scope.error && !scope.abort.signal.aborted && !scope.operationSignal?.aborted
                    && nativeRun.generation === scope.lease.generation && nativeRun.ownerId === ownerId
                    && accountProtocol === protocol && accountProtocolReady && accountGate?.active
                    && scope.page === scopePage && !browserClosed && !closed && Date.now() < nativeRun.deadline
                    && entry.frameId === root && entry.method === "GET" && entry.hops === 1 && !entry.cached
                    && entry.facts.original && !entry.facts.navigation && ["fetch", "xhr"].includes(entry.type)
                    && entry.documentEpochAtAdmission === nativeRun.documentEpoch
                    && ["routing", "cowork-list", "cowork-detail", "cowork-messages", "chat", "chat-list"].includes(entry.kind);
            },
            allowUnavailableResponse(scope, entry, status) {
                return (entry.kind === "cowork-schedule" && status === 404
                    || entry.kind === "cowork-trigger" && [403, 404].includes(status))
                    && scope === current && scope.phase === "cowork-membership" && scope.lease?.kind === "microsoft-read"
                    && verified && !scope.error && !scope.abort.signal.aborted && !scope.operationSignal?.aborted
                    && nativeRun.generation === scope.lease.generation && nativeRun.ownerId === ownerId
                    && accountProtocol === protocol && accountProtocolReady && accountGate?.active
                    && scope.page === scopePage && !browserClosed && !closed && Date.now() < nativeRun.deadline
                    && entry.frameId === root && entry.method === "GET" && entry.hops === 1 && !entry.cached
                    && entry.facts.original && !entry.facts.navigation && entry.nativeIdentity?.state === "matched"
                    && entry.documentEpochAtAdmission === nativeRun.documentEpoch
                    && entry.documentAtAdmission === ancillaryDocument(scope);
            },
            bindLocalImage(scope, observation) {
                const run = nativeRun, document = ancillaryDocument(scope);
                const stillCurrent = () => scope === current && run === nativeRun && Boolean(document)
                    && scope.lease?.kind === "microsoft-read" && !scope.error && !scope.abort.signal.aborted && !scope.operationSignal?.aborted
                    && verified && run.generation === scope.lease.generation && run.ownerId === ownerId
                    && accountProtocol === protocol && accountProtocolReady && accountGate?.active
                    && !browserClosed && !closed && !scopePage.isClosed() && scope.page === scopePage && Date.now() < run.deadline
                    && observation.original && observation.frameId === root && observation.loaderId === document?.entry.networkId
                    && document === ancillaryDocument(scope) && document.epoch === run.documentEpoch
                    && document.entry.frameId === root && document.entry.method === "GET" && document.entry.responseStatus === 200
                    && document.entry.responseAcknowledged && !document.entry.cached
                    && [origin, "https://m365.cloud.microsoft"].includes(URL.parse(document.entry.url)?.origin)
                    && URL.parse(document.entry.url)?.origin === URL.parse(scopePage.url())?.origin
                    && observation.documentUrl === scopePage.url();
                return stillCurrent() ? { current: stillCurrent } : null;
            },
            preflightCandidate(scope, facts) {
                try {
                    const kind = nativeData(scope, facts, () => undefined)?.kind;
                    return ["routing", "cowork-list", "cowork-detail", "cowork-messages", ...COWORK_MEMBERSHIP_KINDS].includes(kind)
                        || !kind && accountOnlyRequestDecision({ ...facts, owned: true }).blockOnly === true;
                } catch (error) {
                    if (!engineering) throw error;
                    nativeFailure(scope, error);
                    return false;
                }
            },
            async admitPreflight(scope, facts, original) {
                const metadata = nativeData(scope, facts, () => undefined);
                if (!metadata && accountOnlyRequestDecision(facts).blockOnly === true) {
                    const document = scope.native.currentDocument;
                    if (!original || original.frameId !== root || original.document !== document
                        || original.epoch !== nativeRun.documentEpoch || document?.epoch !== nativeRun.documentEpoch
                        || !document.entry.responseAcknowledged || document.entry.terminal !== "finished" || document.entry.cached) return null;
                    const count = (nativeRun.counts.get("blocked-dependency-preflight") ?? 0) + 1;
                    if (count > 8) { nativeFailure(scope, "NATIVE_SOURCE_REQUEST_LIMIT"); return null; }
                    nativeRun.counts.set("blocked-dependency-preflight", count);
                    return "blocked-dependency-preflight";
                }
                const kind = await admitNative(scope, facts, "preflight-check", () => undefined);
                if (!["routing", "cowork-list", "cowork-detail", "cowork-messages", ...COWORK_MEMBERSHIP_KINDS].includes(kind)) return null;
                const count = (nativeRun.counts.get("native-preflight") ?? 0) + 1;
                if (count > nativeRequestOriginLimit) { nativeFailure(scope, "NATIVE_SOURCE_REQUEST_LIMIT"); return null; }
                nativeRun.counts.set("native-preflight", count);
                return "native-preflight";
            },
            observeRequest(scope, entry, readHeader) {
                if (!scope.native) return;
                if (entry.kind === "blocked-csp-report") return;
                if (["blocked-chat-action", "blocked-chat-action-preflight"].includes(entry.kind)) return;
                if (entry.kind.startsWith("device-risk-")) {
                    const risk = scope.native.deviceRisk;
                    risk.routeEntries.push(entry);
                    if (!risk.requests.has(entry.networkId)) {
                        const timer = setTimeout(() => nativeFailure(scope, "NATIVE_DEVICE_RISK_TIMEOUT"), deviceRiskLimits.requestMs);
                        risk.requests.set(entry.networkId, { bytes: 0, timer, frameId: entry.frameId });
                    }
                    if (entry.kind === "device-risk-document") {
                        risk.frames.get(entry.frameId).document = entry;
                        if (entry.frameId === risk.frameId) risk.documentEntry = entry;
                    }
                    return;
                }
                entry.sourceCaptureId = randomUUID();
                entry.selectedAtRequest = nativeAccountSelectionCurrent(scope);
                entry.documentAtAdmission = ancillaryDocument(scope);
                entry.documentEpochAtAdmission = nativeRun.documentEpoch;
                if (engineering && ["principal", "context", "routing", "chat-list", "cowork-list"].includes(entry.kind)) {
                    engineering.matchRequest(entry.url, entry.method, entry.networkId);
                }
                observeHistoryRequest(scope, entry);
                if (["principal", "context", "chat-list", "cowork-list", "routing", "chat", "cowork-detail", "cowork-messages",
                    ...COWORK_MEMBERSHIP_KINDS].includes(entry.kind)) {
                    const count = scope.native.protocolCounts.get(entry.kind) ?? 1;
                    const slot = sourceSlot(entry.kind, count);
                    scope.native.protocolEntries.set(slot, entry);
                }
                if (entry.kind === "cowork-list" || COWORK_MEMBERSHIP_KINDS.includes(entry.kind)) {
                    const principal = scope.native.principal ?? nativeRun.principal;
                    entry.nativeIdentity = scope.lease?.kind === "microsoft-read"
                        ? compareNativeReadHeaders(readHeader, transport.accountFor(scope.lease))
                        : compareNativeIdentityHeaders(readHeader, principal);
                    entry.principalCaptureId = principal?.provenance?.captureId;
                    if (entry.nativeIdentity.reason === "native-identity-header-mismatch"
                        || entry.nativeIdentity.reason === "native-identity-header-unqualified") {
                        nativeFailure(scope, "NATIVE_SOURCE_ACCOUNT_MISMATCH");
                    }
                    if (engineering && entry.nativeIdentity.state !== "matched") nativeFailure(scope, "NATIVE_ENGINEERING_IDENTITY_UNCONFIRMED");
                    if ((COWORK_MEMBERSHIP_KINDS.includes(entry.kind) || scope.phase === "cowork-membership" && entry.kind === "cowork-list")
                        && entry.nativeIdentity.state !== "matched") {
                        nativeFailure(scope, "NATIVE_COWORK_MEMBERSHIP_ACCOUNT_UNQUALIFIED");
                    }
                }
            },
            observeResponse(scope, entry) {
                const url = URL.parse(entry.url);
                if (entry.type === "document" && entry.frameId === root && entry.responseStatus >= 200 && entry.responseStatus < 300) {
                    if (entry.method === "GET" && entry.responseStatus === 200 && nativeAuthorizationRequest(url)
                        && scope.phase === "native-connect") {
                        if (scope.native.authorizationRoot && scope.native.authorizationRoot.entry !== entry) {
                            beginNativeAuthorizationReentry(scope, entry, scope.native.currentDocument);
                        } else {
                            if (scope.native.principal || scope.native.document?.projectionPending || scope.native.observed.size) {
                                nativeFailure(scope, "NATIVE_AUTH_REENTRY_UNQUALIFIED");
                                throw sourceError("NATIVE_AUTH_REENTRY_UNQUALIFIED");
                            }
                            retireBootstrapAuthority(scope);
                        }
                    }
                    scope.native.currentDocument = { entry, epoch: null, scripts: new Map(), incidentalScripts: new Map(),
                        scriptInventoryPartial: false };
                    if (entry.method === "GET" && nativeAuthorizationRequest(url)) {
                        scope.native.authorizationRoot = scope.native.currentDocument;
                    }
                }
                const currentDocument = scope.native.currentDocument;
                if (entry.kind === "static" && entry.type === "script" && entry.frameId === root && entry.method === "GET"
                    && entry.responseStatus === 200 && entry.hops === 1 && currentDocument?.epoch === nativeRun.documentEpoch
                    && entry.documentAtAdmission === currentDocument && entry.documentEpochAtAdmission === nativeRun.documentEpoch) {
                    const script = { entry, document: currentDocument };
                    if (requiredScriptAssets.has(entry.url)) {
                        if (currentDocument.scripts.has(entry.url)) {
                            currentDocument.scriptInventoryPartial = true;
                            currentDocument.scripts.get(entry.url).ambiguous = true;
                            nativeFailure(scope, withNativeFailurePredicate(sourceError("NATIVE_SOURCE_PROVENANCE_UNQUALIFIED"),
                                "protocol", "script-required-duplicate"));
                            return;
                        }
                        currentDocument.scripts.set(entry.url, script);
                    } else {
                        const existing = currentDocument.incidentalScripts.get(entry.url);
                        let ambiguous = Boolean(existing && existing.entry !== entry);
                        // Invalidate prior references even if the new response cannot enter the capped ledger.
                        for (const row of scope.native.requestOrigins?.values() ?? []) {
                            if (row.url === entry.url && row.scriptResponse?.document === currentDocument
                                && row.scriptResponse.entry !== entry) {
                                row.scriptResponse.ambiguous = true;
                                ambiguous = true;
                            }
                        }
                        if (ambiguous) {
                            script.ambiguous = true;
                            currentDocument.scriptInventoryPartial = true;
                        }
                        if (existing) {
                            if (ambiguous) existing.ambiguous = true;
                        } else if (currentDocument.incidentalScripts.size < incidentalScriptLimit) {
                            currentDocument.incidentalScripts.set(entry.url, script);
                        } else currentDocument.scriptInventoryPartial = true;
                    }
                    const original = scope.native.requestOrigins?.get(entry.networkId);
                    if (original?.document === currentDocument && original.epoch === nativeRun.documentEpoch
                        && original.url === entry.url && original.method === "GET" && original.frameId === root
                        && original.owned && original.original && !original.duplicate) original.scriptResponse = script;
                    if (applicationScriptAssets.has(entry.url)) nativeRun.assets.add(entry.url);
                }
                if (entry.type === "document" && entry.frameId === root && entry.method === "GET" && entry.responseStatus === 200) {
                    scope.native.authorizeDocument = nativeAuthorizationRequest(url)
                        ? { entry, epoch: null } : null;
                }
                if ((blockedBootstrapChildOrigin !== null || observeAuthenticationChain || ordinaryPartnerPreload) && entry.kind === "static" && entry.type === "script" && entry.hops === 1
                    && entry.frameId === root && entry.method === "GET" && entry.responseStatus === 200
                    && scope.native.authorizeDocument?.epoch === nativeRun.documentEpoch
                    && entry.documentAtAdmission?.entry === scope.native.authorizeDocument.entry
                    && entry.documentEpochAtAdmission === nativeRun.documentEpoch
                    && scope.page.url() === scope.native.authorizeDocument.entry.url) {
                    if (helperScriptAssets.has(entry.url)) {
                        if (scope.native.authorizeScripts.has(entry.url)) {
                            nativeFailure(scope, withNativeFailurePredicate(sourceError("NATIVE_SOURCE_PROVENANCE_UNQUALIFIED"),
                                "protocol", "script-required-duplicate"));
                        } else scope.native.authorizeScripts.set(entry.url, { entry, document: scope.native.authorizeDocument });
                    }
                }
                const callback = scope.native.authCallbackAccepted;
                const callbackDocument = entry.method === "POST" && callback?.routed
                    && callback.networkId === entry.networkId && callback.url === entry.url && entry.hops === 1
                    && nativeAuthCallbackDestination(url);
                if (entry.type === "document" && entry.frameId === root && entry.responseStatus === 200
                    && [origin, "https://m365.cloud.microsoft"].includes(url?.origin)
                    && (callbackDocument || entry.method === "GET"
                        && ["/", "/home", "/chat", "/hwav2/chat", "/landingv2",
                            "/cowork", "/cowork/", "/hwav2/cowork", "/hwav2/cowork/"].includes(url.pathname))) {
                    scope.native.document = { entry, captureId: entry.sourceCaptureId };
                }
            },
            observeData(scope, entry, dataLength) {
                if (engineering && entry.type === "document" && [origin, "https://m365.cloud.microsoft"].includes(URL.parse(entry.url)?.origin)) {
                    if (!Number.isSafeInteger(dataLength) || dataLength < 0) { nativeFailure(scope, "NATIVE_ENGINEERING_BYTE_LIMIT"); return; }
                    entry.engineeringBytes = (entry.engineeringBytes ?? 0) + dataLength;
                    if (entry.engineeringBytes > 2 * 1024 * 1024) nativeFailure(scope, "NATIVE_ENGINEERING_BYTE_LIMIT");
                    return;
                }
                if (!entry.kind.startsWith("device-risk-")) return;
                const request = scope.native.deviceRisk?.requests.get(entry.networkId), outcome = scope.native.deviceRiskOutcome;
                if (!request || !Number.isSafeInteger(dataLength) || dataLength < 0) {
                    nativeFailure(scope, "NATIVE_DEVICE_RISK_RESOURCE_UNQUALIFIED"); return;
                }
                request.bytes += dataLength;
                outcome.decodedResponseBytes += dataLength;
                if (request.bytes > deviceRiskLimits.responseBytes || outcome.decodedResponseBytes > deviceRiskLimits.totalResponseBytes) {
                    outcome.failure = "NATIVE_DEVICE_RISK_RESOURCE_LIMIT";
                    nativeFailure(scope, outcome.failure);
                }
            },
            observeTerminal(scope, entry) {
                retainAuthOriginWitness(scope, entry, "network");
                if (entry.readFailureResponse) scope.native.readFailure ??= entry;
                if (preservedTransportKind(entry.kind)) {
                    const key = entry.kind === "bootstrap-health-transport" ? "bootstrapHealthTransport" : "presentationTransport";
                    const outcome = scope.native[key] ??= {
                        networkFailed: 0, networkFinished: 0, sourceQualified: false, disposition: "transport-only-no-authority",
                    };
                    outcome[entry.terminal === "failed" ? "networkFailed" : "networkFinished"]++;
                    return true;
                }
                if (["native-health-ping", "native-worker-preflight"].includes(entry.kind)) {
                    const role = nativeAppAncillaryRole(scope, entry.facts);
                    if (role?.kind !== entry.kind) return false;
                    if (entry.kind === "native-worker-preflight") {
                        const outcome = scope.native.workerPreflight ??= { networkFailed: 0, networkFinished: 0,
                            disposition: "native-response-and-rejection-preserved" };
                        outcome[entry.terminal === "failed" ? "networkFailed" : "networkFinished"]++;
                    } else if (entry.terminal === "failed") {
                        const failures = scope.native.healthPingFailures ??= {
                            loggerInit: 0, mainLoad: 0, disposition: "native-rejection-preserved",
                        };
                        failures[role.purpose]++;
                    }
                    return true;
                }
                if (!entry.kind.startsWith("device-risk-")) return;
                const request = scope.native.deviceRisk?.requests.get(entry.networkId);
                if (!request) { nativeFailure(scope, "NATIVE_DEVICE_RISK_RESOURCE_UNQUALIFIED"); return; }
                clearTimeout(request.timer);
                request.finished = true;
                scope.native.deviceRiskOutcome.completedResponses++;
                if (entry.kind === "device-risk-document" && entry.frameId !== scope.native.deviceRisk.frameId) {
                    scope.native.deviceRiskOutcome.descendantDocuments++;
                }
            },
            responded(scope, kind, method, status, entry) {
                retainAuthOriginWitness(scope, entry, "protocol");
                if (entry.readFailureResponse) scope.native.readFailure ??= entry;
            },
        };
        accountGate = await guardAccountOnlyRequests(protocol, gateOptions);
        if (configuration.deviceRiskOrigin && ordinaryPartnerPreload) {
            protocol.on("Target.attachedToTarget", event => {
                const scope = current, risk = scope?.native?.deviceRisk;
                return track((async () => {
                    if (!scope || !risk || event.targetInfo?.type !== "iframe" || event.targetInfo.targetId !== risk.frameId
                        || event.waitingForDebugger !== true || risk.childProtocol || !risk.frame || risk.frame.isDetached()
                        || parents.get(risk.frameId) !== root || risk.epoch !== nativeRun.documentEpoch) {
                        throw sourceError("NATIVE_DEVICE_RISK_FRAME_COVERAGE_UNQUALIFIED");
                    }
                    risk.coveragePending = true;
                    const childProtocol = await browser.newCDPSession(risk.frame);
                    risk.childProtocol = childProtocol;
                    childProtocol.on("close", () => { risk.protocolClosed = true; });
                    const { frameTree: childTree } = await childProtocol.send("Page.getFrameTree");
                    if (scope !== current || scope.abort.signal.aborted || childTree?.frame?.id !== risk.frameId
                        || childTree.frame.parentId && childTree.frame.parentId !== root
                        || !["about:blank", ""].includes(childTree.frame.url)
                            && URL.parse(childTree.frame.url)?.origin !== risk.origin) {
                        throw sourceError("NATIVE_DEVICE_RISK_HANDOFF_UNQUALIFIED");
                    }
                    await nativeWait(scope, () => risk.documentEntry?.responseAcknowledged && risk.documentEntry.state === "complete",
                        2000, "NATIVE_DEVICE_RISK_HANDOFF_UNQUALIFIED");
                    const inherited = accountGate.transferDeviceResponse(risk.documentEntry);
                    risk.childGate = await guardAccountOnlyRequests(childProtocol, { ...gateOptions,
                        ownsFrame: id => deviceFrameOwned(risk, id) && parents.get(risk.frameId) === root,
                        getScope: () => current === scope && !risk.retired && risk.epoch === nativeRun.documentEpoch ? scope : null,
                        admit: (owner, facts, stage, readBody) => admitNative(owner, { ...facts, deviceRiskTarget: childProtocol }, stage, readBody),
                        blockedBootstrapChild: null,
                        allowAuthTelemetryDenial: undefined,
                        bindRequestCapacity: undefined,
                        chatActionUrl: undefined, bindChatAction: undefined, chatActionPreflight: undefined,
                        allowFetchOnlyTelemetryDenial: undefined,
                        observeNetworkResource: undefined,
                        observeNetworkDocument(owner, observation) {
                            if (observation.frameId === risk.frameId || !deviceFrameOwned(risk, observation.frameId)) return;
                            const node = risk.frames.get(observation.frameId), parent = risk.frames.get(node.parentId);
                            if (!observation.original || observation.method !== "GET"
                                || risk.documentRequests.size >= deviceRiskLimits.requests
                                || risk.documentRequests.has(observation.networkId)) {
                                nativeFailure(owner, "NATIVE_DEVICE_RISK_NAVIGATION_UNQUALIFIED"); return;
                            }
                            risk.documentRequests.set(observation.networkId, { frameId: observation.frameId,
                                url: observation.requestUrl, parentId: node.parentId, parentDocument: parent?.document,
                                epoch: nativeRun.documentEpoch });
                        },
                        preflightCandidate: undefined, admitPreflight: undefined, inheritedResponse: inherited });
                    childProtocol.on("Page.frameAttached", ({ frameId, parentFrameId }) => {
                        if (risk.retired) return;
                        if (typeof frameId !== "string" || !frameId || frameId.length > 256
                            || !deviceFrameOwned(risk, parentFrameId) || risk.frames.has(frameId) || risk.frames.size >= 128) {
                            nativeFailure(scope, "NATIVE_DEVICE_RISK_FRAME_COVERAGE_UNQUALIFIED"); return;
                        }
                        risk.frames.set(frameId, { parentId: parentFrameId, frame: null, document: null });
                        if (!deviceFrameOwned(risk, frameId)) nativeFailure(scope, "NATIVE_DEVICE_RISK_FRAME_COVERAGE_UNQUALIFIED");
                    });
                    childProtocol.on("Page.frameNavigated", ({ frame }) => {
                        if (risk.retired) return;
                        if (!deviceFrameOwned(risk, frame.id)) {
                            nativeFailure(scope, "NATIVE_DEVICE_RISK_FRAME_COVERAGE_UNQUALIFIED"); return;
                        }
                        const node = risk.frames.get(frame.id);
                        if (frame.parentId !== node.parentId || frame.url === "about:blank" && node.document
                            || frame.url !== "about:blank"
                            && (URL.parse(frame.url)?.origin !== risk.origin || frame.url !== node.document?.url
                                || frame.loaderId !== node.document?.networkId)) {
                            nativeFailure(scope, "NATIVE_DEVICE_RISK_FRAME_COVERAGE_UNQUALIFIED");
                        }
                    });
                    childProtocol.on("Page.frameDetached", ({ frameId, reason }) => {
                        if (risk.retired) return;
                        if (frameId === risk.frameId || reason === "swap" || !risk.frames.has(frameId)) {
                            nativeFailure(scope, "NATIVE_DEVICE_RISK_FRAME_COVERAGE_UNQUALIFIED"); return;
                        }
                        const removed = new Set([frameId]);
                        for (let changed = true; changed;) {
                            changed = false;
                            for (const [id, node] of risk.frames) if (!removed.has(id) && removed.has(node.parentId)) {
                                removed.add(id); changed = true;
                            }
                        }
                        if ([...risk.requests.values()].some(request => removed.has(request.frameId) && !request.finished)) {
                            nativeFailure(scope, "NATIVE_DEVICE_RISK_FRAME_COVERAGE_UNQUALIFIED");
                        }
                        for (const id of removed) risk.frames.delete(id);
                    });
                    childProtocol.on("Target.attachedToTarget", () => {
                        if (risk.retired) return;
                        nativeFailure(scope, "NATIVE_DEVICE_RISK_FRAME_COVERAGE_UNQUALIFIED");
                    });
                    await childProtocol.send("Page.enable");
                    await childProtocol.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false,
                        filter: [{ type: "iframe", exclude: false }, { exclude: true }] });
                    if (scope !== current || scope.abort.signal.aborted || risk.epoch !== nativeRun.documentEpoch) {
                        throw sourceError("NATIVE_DEVICE_RISK_HANDOFF_UNQUALIFIED");
                    }
                    risk.coveragePending = false;
                    clearTimeout(risk.coverageTimer);
                    scope.native.deviceRiskOutcome.frameCoverage = "same-bound-helper-target-before-resume";
                    let timer, listener;
                    try {
                        await new Promise((resolve, reject) => {
                            listener = message => {
                                if (message.sessionId !== event.sessionId) return;
                                let result;
                                try { result = JSON.parse(message.message); }
                                catch { reject(sourceError("NATIVE_DEVICE_RISK_HANDOFF_UNQUALIFIED")); return; }
                                if (result.id !== 1) return;
                                if (result.error) reject(sourceError("NATIVE_DEVICE_RISK_HANDOFF_UNQUALIFIED"));
                                else resolve();
                            };
                            protocol.on("Target.receivedMessageFromTarget", listener);
                            timer = setTimeout(() => reject(sourceError("NATIVE_DEVICE_RISK_HANDOFF_UNQUALIFIED")), 2000);
                            void protocol.send("Target.sendMessageToTarget", { sessionId: event.sessionId,
                                message: JSON.stringify({ id: 1, method: "Runtime.runIfWaitingForDebugger", params: {} }) }).catch(reject);
                        });
                    } finally {
                        clearTimeout(timer);
                        if (listener) protocol.off("Target.receivedMessageFromTarget", listener);
                    }
                })().catch(error => nativeFailure(scope, error)), scope);
            });
            await protocol.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false,
                filter: [{ type: "iframe", exclude: false }, { exclude: true }] });
        }
        accountProtocolReady = true;
    }

    async function acceptNativeBootstrap(scope, frame, source) {
        if (scope?.native?.retiredBootstrapTokens.has(source.documentToken)) throw sourceError("NATIVE_AUTH_CONTEXT_RETIRED");
        if (!scope || scope !== current || !(["native-connect", "native-collection-bootstrap"].includes(scope.phase)
                || scope.lease?.kind === "microsoft-read" && ["cowork-discovery", "cowork-membership"].includes(scope.phase)) || scope.abort.signal.aborted
            || frame !== scope.page.mainFrame() || frame.isDetached()
            || typeof source.documentToken !== "string" || source.documentToken.length > 64
            || typeof source.documentUrl !== "string") throw sourceError("NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
        const document = scope.native.document;
        if (!document || document.entry.url !== source.documentUrl || document.entry.frameId !== nativeRun.mainFrameId) {
            throw sourceError("NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
        }
        if (source.state === "started") {
            document.token = source.documentToken;
            return;
        }
        if (document.token !== source.documentToken) throw sourceError("NATIVE_SOURCE_DOCUMENT_CHANGED");
        if (source.state === "unavailable") return;
        if (source.state !== "complete") throw sourceError("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
        if (!["tanstack", "background-loader"].includes(source.bootstrapBranch)) throw sourceError("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
        document.projectionPending = true;
        await nativeWait(scope, () => nativeBuildKnown() && document.entry.responseAcknowledged
            && document.entry.terminal === "finished", 15000, "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
        if (scope.native.document !== document || document.entry.cached) throw sourceError("NATIVE_SOURCE_CACHED_BOOTSTRAP");
        const bytes = Buffer.from(JSON.stringify(source.projected));
        if (bytes.length > 1024 * 1024) throw sourceError("NATIVE_SOURCE_BYTE_LIMIT");
        const principal = projectNativeSourceResponse({ bytes, mime: "application/json", kind: "principal", expectedAccount });
        const observation = { ...nativeObservation(document.entry, document.captureId, new Date().toISOString()),
            requestPath: new URL(document.entry.url).pathname };
        qualifyNativePrincipal(scope, principal, observation, document.entry.selectedAtRequest);
        scope.native.bootstrapBranch = source.bootstrapBranch;
        document.projectionPending = false;
    }

    async function acceptNativeHistoryDocument(scope, frame, source) {
        if (!scope || scope !== current || scope.phase !== "chat-discovery" || scope.lease?.kind !== "microsoft-read"
            || scope.native.collectingSurface !== "chat" || scope.abort.signal.aborted
            || frame !== scope.page.mainFrame() || frame.isDetached()
            || typeof source.documentToken !== "string" || source.documentToken.length > 64
            || nativeHistoryEntry("chat", source.documentUrl) !== "chat-all") {
            throw sourceError("NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
        }
        const document = scope.native.currentDocument;
        if (!document || document.entry.url !== source.documentUrl || document.entry.frameId !== nativeRun.mainFrameId) {
            throw sourceError("NATIVE_SOURCE_DOCUMENT_CHANGED");
        }
        if (source.state === "started") { document.historyToken = source.documentToken; document.historySettled = false; return; }
        if (document.historyToken !== source.documentToken) throw sourceError("NATIVE_SOURCE_DOCUMENT_CHANGED");
        if (source.state === "unavailable") { document.historySettled = true; return; }
        if (source.state !== "complete" || document.historyAccepted) throw sourceError("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
        if (!["tanstack", "background-loader"].includes(source.bootstrapBranch)) throw sourceError("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
        await nativeWait(scope, () => nativeHistoryBuildKnown()
            && document.entry.responseAcknowledged && document.entry.terminal === "finished",
        15000, "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
        if (document !== scope.native.currentDocument || document.entry.cached || document.epoch !== nativeRun.documentEpoch) {
            throw sourceError("NATIVE_SOURCE_DOCUMENT_CHANGED");
        }
        const bytes = Buffer.from(JSON.stringify(source.projected));
        if (bytes.length > 2 * 1024 * 1024) throw sourceError("NATIVE_SOURCE_BYTE_LIMIT");
        const options = { bytes, mime: "application/json" };
        const value = projectNativeSourceResponse({ ...options, kind: "chat-list", store: null });
        const principal = projectNativeSourceResponse({ ...options, kind: "principal", expectedAccount, principalOptional: true });
        const observation = { ...nativeObservation(document.entry, document.entry.sourceCaptureId, new Date().toISOString()),
            requestPath: new URL(document.entry.url).pathname };
        await lifecycle.admit(scope.lease, () => {
            if (scope !== current || scope.abort.signal.aborted || document !== scope.native.currentDocument) {
                throw sourceError("NATIVE_SOURCE_DOCUMENT_CHANGED");
            }
            if (principal) qualifyNativePrincipal(scope, principal, observation, false);
            mergeNativeHistoryList(scope, "chat", value, document.entry, {
                captureId: document.entry.sourceCaptureId, bodyDigest: hash(bytes),
            }, { documentInitializer: true, requestBasis: "ssr-initializer" });
            document.historyAccepted = true;
            document.historySettled = true;
            scope.native.bootstrapBranch = source.bootstrapBranch;
        });
    }

    function engineeringPrincipal(scope, value, observation, selectedAtRequest) {
        if (value === null) return;
        if (!value || Object.keys(value).sort().join(",") !== "accountLabelMatched,namespace,realm,subjectId,tenantId"
            || value.namespace !== nativeHistoryProducer.accountNamespace || value.realm !== nativeHistoryProducer.realm
            || typeof value.accountLabelMatched !== "boolean"
            || ["tenantId", "subjectId"].some(key => typeof value[key] !== "string" || !value[key].length || value[key].length > 1024)) {
            throw sourceError("NATIVE_ENGINEERING_ACCOUNT_SCOPE");
        }
        const key = hash(JSON.stringify([value.namespace, value.realm, value.tenantId, value.subjectId]));
        if (engineeringPrincipalKey && engineeringPrincipalKey !== key) throw sourceError("NATIVE_ENGINEERING_WRONG_IDENTITY");
        if (!engineeringPrincipalKey || value.accountLabelMatched || selectedAtRequest) {
            qualifyNativePrincipal(scope, value, observation, selectedAtRequest);
        }
        if (scope.native.principal?.knownAccountMatched) {
            engineeringPrincipalKey = key;
            if (!engineering.authenticated) engineering.authenticate();
        }
    }
    async function acceptEngineeringMessage(scope, frame, source) {
        if (!engineering || !scope || scope !== current || scope.abort.signal.aborted || frame !== scope.page.mainFrame()
            || frame.isDetached() || ![origin, "https://m365.cloud.microsoft"].includes(URL.parse(frame.url())?.origin)) {
            throw sourceError("NATIVE_ENGINEERING_AUTHORITY_LOST");
        }
        engineering.assertCurrent();
        const fields = value => value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join(",") : "";
        if (source?.type === "engineering-failure") {
            if (fields(source) !== "code,type" || typeof source.code !== "string"
                || !/^NATIVE_ENGINEERING_[A-Z_]{1,70}$/.test(source.code)) throw sourceError("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
            throw sourceError(source.code);
        }
        if (source?.type === "engineering-request") {
            if (fields(source) !== "method,projection,requestId,requestUrlKey,type") throw sourceError("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
            if (["chat-list", "chat-initializer", "cowork-list"].includes(source.projection?.role)) {
                const surface = source.projection.role.startsWith("chat") ? "chat" : "cowork";
                if (nativeHistoryEntry(surface, frame.url()) !== (surface === "chat" ? "chat-all" : "cowork-my-tasks")) {
                    throw sourceError("NATIVE_ENGINEERING_ENTRY_REQUIRED");
                }
            }
            return engineering.prepareRequest(source);
        }
        if (source?.type === "engineering-document") {
            if (!["documentToken,documentUrlKey,state,type", "documentToken,documentUrlKey,projection,state,type"].includes(fields(source))
                || typeof source.documentToken !== "string" || source.documentToken.length > 64) throw sourceError("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
            const document = scope.native.currentDocument;
            if (!document || engineering.urlKey(document.entry.url) !== source.documentUrlKey) throw sourceError("NATIVE_ENGINEERING_DOCUMENT_SHAPE");
            if (source.state === "started") { document.engineeringToken = source.documentToken; return; }
            if (source.state !== "complete" || document.engineeringToken !== source.documentToken
                || fields(source.projection) !== "list,marker,principal,role" || source.projection.role !== "document") {
                throw sourceError("NATIVE_ENGINEERING_DOCUMENT_SHAPE");
            }
            await nativeWait(scope, () => nativeBuildKnown() && document.entry.responseAcknowledged && document.entry.terminal === "finished",
                15000, "NATIVE_ENGINEERING_DOCUMENT_SHAPE");
            if (document !== scope.native.currentDocument || document.entry.cached) throw sourceError("NATIVE_ENGINEERING_DOCUMENT_SHAPE");
            engineeringPrincipal(scope, source.projection.principal,
                { ...nativeObservation(document.entry, document.entry.sourceCaptureId, new Date().toISOString()), requestPath: new URL(document.entry.url).pathname },
                document.entry.selectedAtRequest);
            if (source.projection.list) {
                if (scope.phase !== "native-engineering") throw sourceError("NATIVE_ENGINEERING_INITIALIZER_REQUIRED");
                if (nativeHistoryEntry("chat", frame.url()) !== "chat-all") throw sourceError("NATIVE_ENGINEERING_ENTRY_REQUIRED");
            }
            engineering.acceptDocument(hash(document.entry.networkId), source.projection, document.entry.engineeringBytes);
            return;
        }
        if (source?.type !== "engineering-response" || fields(source) !== "bytes,method,projection,requestId,requestUrlKey,type") {
            throw sourceError("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
        }
        const record = engineering.requestById(source.requestId);
        if (!record || record.method !== source.method || record.requestUrlKey !== source.requestUrlKey) throw sourceError("NATIVE_ENGINEERING_REQUEST_SCOPE");
        const matches = () => [...scope.native.requests].filter(request => scope.native.metadata.get(request)?.engineeringRequestId === source.requestId);
        await nativeWait(scope, () => matches().length > 0, 15000, "NATIVE_ENGINEERING_RESPONSE_STATUS");
        const requests = matches();
        if (requests.length !== 1) throw sourceError("NATIVE_ENGINEERING_DUPLICATE_REQUEST");
        const request = requests[0], metadata = scope.native.metadata.get(request), meta = scope.metadata.get(request);
        const entry = scope.native.protocolEntries.get(metadata.slot);
        if (request.frame() !== frame || metadata.documentEpoch !== nativeRun.documentEpoch || metadata.frameUrl !== frame.url()
            || source.projection?.role !== record.projection.role) throw sourceError("NATIVE_ENGINEERING_AUTHORITY_LOST");
        const role = source.projection.role, expected = role === "routing" ? "endpoint,role"
            : role === "principal" ? "principal,role" : role === "context" ? "principal,role,structure" : "list,marker,principal,role";
        if (fields(source.projection) !== expected) throw sourceError("NATIVE_ENGINEERING_OBSERVER_UNSAFE");
        if (role === "context") validateHistoryContextStructure(source.projection.structure);
        await nativeWait(scope, () => entry?.responseAcknowledged && entry.terminal === "finished", 15000, "NATIVE_ENGINEERING_RESPONSE_STATUS");
        await scope.observer.assertCurrent(request);
        if (entry.cached) throw sourceError("NATIVE_ENGINEERING_RESPONSE_STATUS");
        scope.observer.bodyComplete(request);
        await scope.observer.accept(request, () => {
            if (source.projection.principal !== undefined) engineeringPrincipal(scope, source.projection.principal,
                { ...nativeObservation(entry, meta.captureId, new Date().toISOString()), requestPath: new URL(request.url()).pathname },
                metadata.selectedAtRequest);
            if (role === "routing") {
                const endpoint = URL.parse(source.projection.endpoint);
                if (!endpoint || !/^https:\/\/[a-z0-9][a-z0-9.-]*\.gateway\.prod\.island\.powerapps\.com$/.test(endpoint.origin)
                    || endpoint.href !== endpoint.origin + "/") throw sourceError("NATIVE_ENGINEERING_ROUTING_SHAPE");
                scope.native.gateway = { origin: endpoint.origin };
            }
            engineering.accept(source.requestId, source.projection, source.bytes);
        });
        scope.native.requests.delete(request);
    }
    async function runEngineeringHistory(scope, operation) {
        const principal = scope.native.principal;
        if (!principal?.knownAccountMatched || !engineeringPrincipalKey) throw sourceError("NATIVE_ENGINEERING_IDENTITY_UNCONFIRMED");
        if (!engineering.authenticated) engineering.authenticate();
        await scope.observer.beginPhase("native-engineering", { signal: operation.signal, engineering });
        scope.phase = "native-engineering";
        const destinations = { chat: "https://m365.cloud.microsoft/chat/all", cowork: "https://m365.cloud.microsoft/cowork/#/my-tasks" };
        const assertEntry = surface => {
            engineering.assertCurrent();
            if (nativeHistoryEntry(surface, page.url()) !== (surface === "chat" ? "chat-all" : "cowork-my-tasks")) {
                throw sourceError("NATIVE_ENGINEERING_ENTRY_REQUIRED");
            }
        };
        return runHistoryEngineeringSteps(engineering, {
            async initial(surface) {
                engineering.assertCurrent();
                await page.goto(destinations[surface], { waitUntil: "domcontentloaded" });
                assertEntry(surface);
            },
            async refresh(surface) {
                assertEntry(surface);
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.reload({ waitUntil: "domcontentloaded" });
                assertEntry(surface);
            },
            async page(surface, tail) {
                assertEntry(surface);
                if (!tail) return false;
                let handle;
                try { handle = await page.waitForFunction(async ({ surface, tail, projectionBinding }) => {
                    const matched = [];
                    for (const node of document.querySelectorAll("a[href]")) {
                        if (!node.getClientRects().length || getComputedStyle(node).visibility === "hidden") continue;
                        let url, id;
                        try {
                            url = new URL(node.getAttribute("href"), location.href);
                            if (!["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(url.origin) || url.username || url.password) continue;
                            const path = url.pathname.replace(/^\/hwav2(?=\/)/, "");
                            if (surface === "chat" && path.startsWith("/chat/conversation/")) id = decodeURIComponent(path.slice("/chat/conversation/".length));
                            if (surface === "cowork" && url.hash.startsWith("#/task/")) id = decodeURIComponent(url.hash.slice("#/task/".length)).split(":").at(-1);
                            if (surface === "cowork" && /^\/cowork\/[^/]+$/.test(path)) id = decodeURIComponent(path.split("/").at(-1));
                        } catch { continue; }
                        if (id && await window[projectionBinding].hash(surface + ":" + id) === tail) matched.push(node);
                        if (matched.length > 1) return null;
                    }
                    return matched.length === 1 ? matched[0] : null;
                }, { surface, tail, projectionBinding: engineeringProjectionBinding }, { polling: 100, timeout: 1500 }); }
                catch (error) {
                    engineering.assertCurrent();
                    if (error.name === "TimeoutError") return false;
                    throw error;
                }
                try {
                    const element = handle.asElement();
                    if (!element) return false;
                    engineering.assertCurrent();
                    await element.scrollIntoViewIfNeeded();
                    assertEntry(surface);
                    return true;
                } finally { await handle.dispose(); }
            },
            async wait(done) {
                await nativeWait(scope, () => { engineering.assertCurrent(); return done(); }, 15000, "NATIVE_ENGINEERING_STEP_UNAVAILABLE");
            },
        });
    }

    function mergeNativeHistoryList(scope, surface, value, entry, meta, metadata) {
        const previous = surface === "cowork" && Object.hasOwn(metadata, "membershipInitial")
            ? metadata.membershipInitial ? undefined : scope.native.coworkPopulations.get(metadata.population) : scope.native.lists[surface];
        const queryBinding = scope.native.queryBindings.get(metadata.queryBindingKey ?? surface + "-list") ?? null;
        const documentReset = surface === "chat" && previous?.documentInitialized && metadata.requestBasis === "empty-reset-shape";
        const deferredDocument = surface === "chat" && previous && metadata.documentInitializer === true;
        if (surface === "chat" && previous && previous.store !== value.store) throw sourceError("NATIVE_SOURCE_CONTINUATION_UNQUALIFIED");
        const id = surface === "chat" ? "conversationId" : "sessionId";
        const membershipKey = value.membership ? hash(JSON.stringify({ ...value.membership,
            pinnedIds: value.membership.pinnedIds?.toSorted() ?? null,
            pinnedItems: value.membership.pinnedItems?.toSorted((left, right) =>
                left.conversationId < right.conversationId ? -1 : left.conversationId > right.conversationId ? 1 : 0) ?? null,
        })) : previous?.membershipKey ?? null;
        if (previous?.membershipKey && value.membership && previous.membershipKey !== membershipKey) {
            throw sourceError("NATIVE_SOURCE_DISCOVERY_CHANGED");
        }
        const rows = new Map((previous?.items ?? []).map(item => [item[id], item]));
        const merge = item => {
            if (surface !== "chat") { rows.set(item[id], item); return; }
            const existing = rows.get(item[id]);
            const recency = [existing?.lastActivity, item.lastActivity].filter(Number.isSafeInteger);
            // Any original in-window recency can require reading this history.
            // Retained activity dates still come only from its original messages.
            rows.set(item[id], { ...existing, ...item, ...(recency.length ? { lastActivity: Math.max(...recency) } : {}) });
        };
        for (const item of value.membership?.pinnedItems ?? []) merge(item);
        for (const item of value.items) merge(item);
        const pageKey = hash(JSON.stringify([surface, value.items, value.continuation.state, ...(value.membership ? [value.membership] : [])]));
        const pages = [...new Set([...(previous?.pages ?? []), pageKey])];
        const chainPages = deferredDocument ? previous.chainPages : (documentReset ? 0 : previous?.chainPages ?? 0) + 1;
        if (rows.size > NATIVE_BACKFILL_LIMIT || pages.length > NATIVE_BACKFILL_LIMIT || chainPages > NATIVE_BACKFILL_LIMIT) {
            scope.native.backfillBudget = "membership-budget";
            throw sourceError("NATIVE_SOURCE_DISCOVERY_LIMIT");
        }
        const observation = previous?.observation ?? acceptHistoryObservation(scope, entry, meta, metadata);
        const url = new URL(entry.url);
        const startQualified = deferredDocument ? false : previous?.startQualified ?? (surface === "chat" && value.membership?.marker === "all-chats"
            && value.membership.selected && value.membership.pinnedComplete && observation?.association.state === "ordered"
            && observation.control.entry === "chat-all" && !url.search && !url.hash
            && (metadata.documentInitializer === true || metadata.initializer === true));
        const list = { items: [...rows.values()], continuation: deferredDocument ? previous.continuation : value.continuation, pages,
            ...(surface === "chat" ? { store: value.store, pageTail: deferredDocument ? previous.pageTail : value.items.at(-1)?.conversationId ?? null,
                membershipKey, startQualified, documentInitialized: !deferredDocument
                    && (!documentReset && previous?.documentInitialized === true || metadata.documentInitializer === true) }
                : { population: url.searchParams.get("sessionType") }),
            chain: deferredDocument ? previous.chain : hash(JSON.stringify([documentReset ? null : previous?.chain ?? null, pageKey, value.store ?? null,
                queryBinding])),
            chainPages,
            initial: previous?.initial ?? (metadata.documentInitializer ? "absent" : scope.native.discoveryInitial?.[surface] ?? "unobserved"),
            queryBinding: previous?.queryBinding ?? queryBinding,
            controlObserved: previous?.controlObserved === true || scope.native.controlObserved?.has(surface) === true,
            observation };
        if (surface === "cowork") scope.native.coworkPopulations.set(url.searchParams.get("sessionType"), list);
        if (surface !== "cowork" || !Object.hasOwn(metadata, "membershipInitial")
            || scope.native.expectedCoworkPopulation === undefined || metadata.population === scope.native.expectedCoworkPopulation) {
            scope.native.lists[surface] = list;
        }
    }

    async function acceptCoworkMembershipBody(scope, frame, source) {
        const unavailable = source.state === "unavailable"
            && (source.kind === "cowork-schedule" && source.status === 404
                || source.kind === "cowork-trigger" && [403, 404].includes(source.status));
        if (!scope || scope !== current || scope.abort.signal.aborted || scope.phase !== "cowork-membership"
            || scope.lease?.kind !== "microsoft-read" || frame !== scope.page.mainFrame() || frame.isDetached()
            || !Number.isSafeInteger(source.bytes) || source.bytes < 0 || source.bytes > 2 * 1024 * 1024
            || !unavailable && (source.state !== "complete" || source.status !== 200
                || !/^[a-f0-9]{64}$/.test(source.bodyDigest))
            || source.method !== "GET") throw sourceError("NATIVE_COWORK_MEMBERSHIP_UNQUALIFIED");
        const projected = unavailable ? null : projectCoworkMembership(source.projected, source.kind);
        if (!unavailable && (JSON.stringify(projected) !== JSON.stringify(source.projected)
            || Buffer.byteLength(JSON.stringify(projected)) > 2 * 1024 * 1024)) throw sourceError("NATIVE_COWORK_MEMBERSHIP_UNQUALIFIED");
        const matching = () => [...scope.native.requests].filter(request => request.url() === source.requestUrl
            && request.method() === "GET" && request.frame() === frame
            && scope.native.metadata.get(request)?.kind === source.kind);
        await nativeWait(scope, () => matching().length !== 0, 15000, "NATIVE_SOURCE_RESPONSE_UNQUALIFIED");
        const requests = matching();
        if (requests.length !== 1) throw sourceError("NATIVE_SOURCE_RESPONSE_UNQUALIFIED");
        const request = requests[0], metadata = scope.native.metadata.get(request), meta = scope.metadata.get(request);
        const entry = scope.native.protocolEntries.get(metadata.slot);
        const requestFrameUrl = URL.parse(metadata.frameUrl), frameUrl = URL.parse(frame.url());
        if (metadata.documentEpoch !== nativeRun.documentEpoch || !requestFrameUrl || !frameUrl
            || requestFrameUrl.origin !== frameUrl.origin || requestFrameUrl.pathname !== frameUrl.pathname || requestFrameUrl.search !== frameUrl.search
            || !unavailable && (source.mime !== meta.mime || meta.serialized)) throw sourceError("NATIVE_SOURCE_DOCUMENT_CHANGED");
        await nativeWait(scope, () => entry?.responseAcknowledged && entry.terminal === "finished",
            15000, "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
        if (entry.cached || entry.nativeIdentity?.state !== "matched" || entry.responseStatus !== source.status
            || unavailable && !entry.unavailableResponse) throw sourceError("NATIVE_COWORK_MEMBERSHIP_ACCOUNT_UNQUALIFIED");
        await scope.observer.assertCurrent(request);
        nativeRun.bodyBytes += source.bytes;
        if (nativeRun.bodyBytes > 24 * 1024 * 1024) {
            scope.native.backfillBudget = "byte-budget";
            throw sourceError("NATIVE_SOURCE_BYTE_LIMIT");
        }
        if (unavailable) {
            scope.observer.readFailed(request);
            await lifecycle.admit(scope.lease, () => {
                if (scope !== current || scope.abort.signal.aborted) throw sourceError("NATIVE_SOURCE_CANCELLED");
                scope.native.automationDetails.set(source.kind + ":" + metadata.parentId, null);
                scope.native.membershipPages.add(hash(JSON.stringify([source.kind, metadata.parentId, source.status])));
            });
            scope.native.requests.delete(request);
            return;
        }
        scope.observer.bodyComplete(request);
        await scope.observer.accept(request, () => {
            if (source.kind === "cowork-automations") scope.native.automationParents = projected.automations;
            else scope.native.automationDetails.set(source.kind + ":" + metadata.parentId, projected);
            scope.native.membershipPages.add(hash(JSON.stringify([source.kind, metadata.parentId ?? null, source.bodyDigest])));
        });
        scope.native.requests.delete(request);
    }

    async function acceptNativeBody(scope, frame, source) {
        if (!scope || scope !== current || scope.abort.signal.aborted || frame.page() !== scope.page || frame.isDetached()
            || source.state !== "complete" || source.status !== 200 || typeof source.requestUrl !== "string"
            || !["GET", "POST"].includes(source.method)) throw sourceError("NATIVE_SOURCE_RESPONSE_UNQUALIFIED");
        const maximum = source.kind === "principal" ? 1024 * 1024
            : ["chat-list", "cowork-list", "routing"].includes(source.kind) ? 2 * 1024 * 1024 : maximumBytes;
        if (typeof source.encodedBody !== "string" || source.encodedBody.length > Math.ceil(maximum / 3) * 4
            || !Number.isSafeInteger(source.bytes) || source.bytes < 0 || source.bytes > maximum
            || !/^[a-f0-9]{64}$/.test(source.bodyDigest)) throw sourceError("NATIVE_SOURCE_BYTE_LIMIT");
        const bytes = Buffer.from(source.encodedBody, "base64");
        if (bytes.length !== source.bytes || bytes.toString("base64") !== source.encodedBody || hash(bytes) !== source.bodyDigest) {
            throw sourceError("NATIVE_SOURCE_RESPONSE_UNQUALIFIED");
        }
        const matching = () => [...scope.native.requests].filter(request => request.url() === source.requestUrl
            && request.method() === source.method && request.frame() === frame
            && scope.native.metadata.get(request)?.kind === source.kind);
        await nativeWait(scope, () => matching().length !== 0, 15000, "NATIVE_SOURCE_RESPONSE_UNQUALIFIED");
        const matches = matching();
        if (matches.length !== 1) throw sourceError("NATIVE_SOURCE_RESPONSE_UNQUALIFIED");
        const request = matches[0], metadata = scope.native.metadata.get(request), meta = scope.metadata.get(request);
        const entry = scope.native.protocolEntries.get(metadata.slot);
        if (metadata.documentEpoch !== nativeRun.documentEpoch || metadata.frameUrl !== frame.url()) {
            throw sourceError("NATIVE_SOURCE_DOCUMENT_CHANGED");
        }
        if (source.mime !== meta.mime || source.serialized !== meta.serialized) throw sourceError("NATIVE_SOURCE_RESPONSE_UNQUALIFIED");
        scope.native.requests.delete(request);
        await scope.observer.assertCurrent(request);
        scope.observer.bodyComplete(request);
        Object.assign(meta, { bytes: bytes.length, bodyDigest: source.bodyDigest });
        const options = { bytes, mime: meta.mime, serialized: meta.serialized, kind: source.kind, store: metadata.store };
        if (["principal", "chat-list", "cowork-list", "routing"].includes(source.kind)) {
            await nativeWait(scope, () => entry?.responseAcknowledged && entry.terminal === "finished",
                15000, "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
            const value = projectNativeSourceResponse({ ...options, ...(source.kind === "principal" ? { expectedAccount } : {}) });
            const principal = source.kind === "chat-list" ? projectNativeSourceResponse({
                ...options, kind: "principal", expectedAccount, principalOptional: true,
            }) : null;
            await scope.observer.accept(request, () => {
                if (source.kind === "principal" || principal) {
                    const proof = principal ?? value;
                    const observation = { ...nativeObservation(entry, meta.captureId, new Date().toISOString()),
                        requestPath: new URL(request.url()).pathname };
                    qualifyNativePrincipal(scope, proof, observation, metadata.selectedAtRequest);
                }
                if (source.kind === "routing") {
                    scope.native.gateway = value;
                    if (!entry.cached) scope.native.routingObservation = {
                        ...nativeObservation(entry, meta.captureId, new Date().toISOString()),
                        responseOrigin: new URL(request.url()).origin, endpointOrigin: value.origin,
                    };
                }
                if (source.kind === "chat-list" || source.kind === "cowork-list") {
                    const surface = source.kind === "chat-list" ? "chat" : "cowork";
                    mergeNativeHistoryList(scope, surface, value, entry, meta, metadata);
                    if (surface === "cowork" && entry.nativeIdentity?.state === "matched" && !entry.cached) {
                        scope.native.routedObservation = {
                            ...nativeObservation(entry, meta.captureId, new Date().toISOString()),
                            responseOrigin: new URL(request.url()).origin, requestPath: "/v1/tasks/live",
                            principalCaptureId: entry.principalCaptureId,
                        };
                    } else if (surface === "cowork") scope.native.mappingUnavailable = entry.nativeIdentity?.reason ?? "request-identity-unqualified";
                }
            });
            return;
        }
        nativeRun.bodyBytes += bytes.length;
        if (nativeRun.bodyBytes > 24 * 1024 * 1024) scope.native.backfillBudget = "byte-budget";
        if (nativeRun.bodyBytes > 24 * 1024 * 1024 || meta.serialized || !/^application\/json(?:;|$)/i.test(meta.mime)) {
            throw sourceError("NATIVE_SOURCE_BYTE_LIMIT");
        }
        const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (source.kind === "cowork-detail") {
            if (body?.task?.taskId !== scope.native.coworkComposite || body.task.sessionId !== scope.native.selectedCowork
                || body.snapshot?.sessionId != null && body.snapshot.sessionId !== scope.native.selectedCowork) {
                throw sourceError("NATIVE_SOURCE_ASSOCIATION_FAILED");
            }
            nativeRun.recordCount++;
        } else if (source.kind === "cowork-messages") {
            if (!Array.isArray(body?.events) || body.events.length > 10000
                || body.nextCursor != null && (typeof body.nextCursor !== "string" || body.nextCursor.length > 4096)) {
                throw sourceError("NATIVE_SOURCE_EVENTS_INVALID");
            }
            nativeRun.recordCount += body.events.length;
            await nativeWait(scope, () => scope.native.detailVerified, 20000, "NATIVE_SOURCE_ASSOCIATION_FAILED");
        } else throw sourceError("NATIVE_SOURCE_RESPONSE_UNQUALIFIED");
        if (nativeRun.recordCount > 10000) { scope.native.backfillBudget = "record-budget"; throw sourceError("NATIVE_SOURCE_RECORD_LIMIT"); }
        await scope.observer.accept(request, () => {
            if (source.kind === "cowork-detail") {
                const thread = body.snapshot?.ic3ThreadId;
                if (thread !== undefined) {
                    if (typeof thread !== "string" || !thread || thread.length > 1024 || /[\u0000-\u001f\u007f]/.test(thread)) {
                        throw sourceError("NATIVE_SOURCE_ASSOCIATION_FAILED");
                    }
                    scope.native.threadIds.add(thread);
                }
                scope.native.detailVerified = true;
            } else scope.native.messageCursor = typeof body.nextCursor === "string" && body.nextCursor
                ? { state: "present", value: body.nextCursor }
                : { state: body.nextCursor === null ? "null" : body.nextCursor === "" ? "empty" : "absent" };
            const coworkBuild = nativeCoworkBuild();
            if (!coworkBuild) throw sourceError("NATIVE_SOURCE_BUILD_UNQUALIFIED");
            scope.captures.set(metadata.slot, { body, meta, origin: new URL(request.url()).origin,
                coworkBuild: coworkBuild.id });
        });
    }

    function selectedKind(url) {
        if (!target) return null;
        if (url.origin === origin && url.pathname === target.chatPath) return "chat";
        if (gateway(url) && ["/v1/tasks/live/detail", "/v1/tasks/live/messages"].includes(url.pathname)
            && [url.searchParams.get("sessionId"), url.searchParams.get("threadId")].some(value => selectedIds.has(value))
            && !url.searchParams.has("cursor")
            && [...url.searchParams.keys()].every(key => ["sessionId", "threadId", "pageSize"].includes(key))) {
            return url.pathname.endsWith("/detail") ? "cowork-detail" : "cowork-messages";
        }
        return null;
    }
    function fault(scope, error) {
        revokeAppDocumentContinuity();
        if (scope) scope.continuityRevoked = true;
        const failure = nativeFailureForPublication(error, scope?.lease ? "acquisition" : "connect");
        if (!recordNativeHostFailure(scope, failure)) return;
        if (scope.recordFailure) scope.failureRecordTask ??= scope.recordFailure(scope.error);
        console.error("[workiq-native] source failed", { code: scope.error.code });
    }
    function stopAccount(scope, reason, facts = null) {
        if (scope?.abort.signal.aborted) return;
        if (accountFailure === null) {
            accountFailure = reason;
            accountFailureContext = accountOnlyDenialContext(facts);
        }
        accountGate?.retire();
        if (!scope?.accountToken) return;
        reason = accountFailure;
        scope.accountDenied ??= reason;
        scope.accountDeniedContext = accountFailureContext;
        if (reason === "token-scope") scope.accountToken.mismatch = true;
        if (reason === "token-cap") scope.accountToken.capReached = true;
        if (reason === "token-redirect") scope.accountToken.redirectBlocked = true;
        scope.error ??= new MicrosoftSessionError("account-metadata-unavailable");
        console.info("[workiq-native] account-only stopped", { reason: scope.accountDenied });
        scope.abort.abort();
    }
    function admitAccount(scope, facts, stage) {
        if (!scope || scope !== current || scope.phase !== "account-only" || scope.abort.signal.aborted
            || scope.error || accountFailure || closed || browserClosed || !accountProtocolReady || !accountGate?.active) {
            stopAccount(scope, "protocol-coverage", facts);
            return null;
        }
        const { url, method, type } = facts;
        if (url && ["xhr", "fetch"].includes(type)
            && !/\/(?:subscribe|conversations|conversation|chats|chat|tasks|task|messages|files|history|events|actions)(?:\/|$)/i.test(url.pathname)
            && ([origin, "https://m365.cloud.microsoft", "https://graph.microsoft.com", "https://login.microsoftonline.com",
                "https://login.microsoft.com", "https://autologon.microsoftazuread-sso.com"].includes(url.origin) || gateway(url))) {
            const segments = url.pathname.split("/").filter(Boolean);
            const pathTemplate = "/" + segments.slice(0, 12).map(part => accountPathSegments.has(part) ? part : ":opaque").join("/")
                + (segments.length > 12 ? "/:rest" : "");
            const metadata = JSON.stringify({
                method: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(method) ? method : "OTHER",
                origin: url.origin, pathTemplate,
            });
            if (!scope.accountRoutes.has(metadata)) {
                if (scope.accountRoutes.size >= 16) scope.accountRoutesCapped = true;
                else { scope.accountRoutes.add(metadata); console.info("[workiq-native] account-only request", metadata); }
            }
        }
        const decision = accountOnlyRequestDecision({ ...facts, tokenEndpoint,
            pageOrigin: URL.parse(scope.page.url())?.origin,
            signInClicked: scope.signInClicked, accountSelected: scope.accountSelected });
        if (decision.denied) {
            if (stage === "protocol" && decision.blockOnly === true) return "policy-block";
            stopAccount(scope, decision.denied, facts);
            return null;
        }
        if (decision.kind === "token") {
            const budget = scope.accountToken[facts.method], counter = stage === "route" ? "routeConsumed" : "protocolConsumed";
            if (budget[counter] === 4) { stopAccount(scope, "token-cap", facts); return null; }
            budget[counter]++;
        } else if (decision.kind === "self") {
            const counter = stage === "route" ? "routed" : "protocolConsumed";
            if (scope.accountSelf[counter]) { stopAccount(scope, "self-cap", facts); return null; }
            scope.accountSelf[counter] = true;
        } else if (decision.kind === "self-preflight") {
            if (scope.accountSelfPreflight.consumed) { stopAccount(scope, "self-preflight-cap", facts); return null; }
            scope.accountSelfPreflight.consumed = true;
            scope.accountSelfPreflight.associated = true;
        }
        return decision.kind;
    }
    function recordAccountScript(scope, request, url) {
        const assets = scope.accountScripts;
        if (!assets || scope.phase !== "account-only" || scope.abort.signal.aborted || scope.error) return;
        const raw = request.url();
        const match = /^\/officehub\/bundles\/([a-z][a-z0-9-]{0,119})-([a-f0-9]{8,20})\.js$/.exec(url.pathname);
        if (raw.length > 2048 || raw !== url.origin + url.pathname || url.origin !== "https://res.cdn.office.net"
            || !match || /[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i.test(match[1])
            || privateAssetIds.some(value => value.length >= 8 ? url.pathname.toLowerCase().includes(value)
                : `-${match[1]}-${match[2]}-`.includes(`-${value}-`))
            || accountAlias && `-${match[1]}-`.includes(`-${accountAlias}-`)
            || request.method() !== "GET" || request.redirectedFrom() !== null
            || request.frame() !== scope.page.mainFrame()
            || ![origin, "https://m365.cloud.microsoft"].includes(new URL(scope.page.url()).origin)) {
            assets.omitted = true;
            return;
        }
        if (assets.urls.has(raw)) return;
        if (assets.urls.size === 12) { assets.capped = true; return; }
        assets.urls.add(raw);
    }
    function track(work, scope) {
        const task = work.finally(() => { pending.delete(task); scope?.pending.delete(task); });
        pending.add(task);
        scope?.pending.add(task);
        return task;
    }
    function retireNativeBootstrap(scope) {
        if (!normal || !scope.lease || !nativeRun?.collectionPrepared || !captureResetBinding) return;
        return scope.native.bootstrapRetirement ??= (async () => {
            if (scope !== current || browserClosed || scope.page.isClosed()) return;
            try {
                await scope.page.evaluate(name => {
                    if (typeof window[name] === "function") window[name](true);
                }, captureResetBinding);
            } catch {
                if (browserClosed || scope.page.isClosed()) return;
                scope.cleanupFailed = true;
                scope.continuityRevoked = true;
                revokeAppDocumentContinuity();
                console.error("[workiq-native] bootstrap observation retirement failed", { code: "NATIVE_CHAT_CAPTURE_BINDING_UNQUALIFIED" });
            }
        })();
    }
    function newScope(scopePage, lease = null, appDocumentBinding = null) {
        const scope = { page: scopePage, phase: "bootstrap", captures: new Map(), metadata: new WeakMap(),
            observer: createMicrosoftNativeRequestObserver({ lifecycle, engineering }), abort: new AbortController(),
            accountSelected: false, accountMatched: false, signInClicked: false, error: null, lease,
            identity: null, chatRequest: null, pending: new Set(), releaseTask: null, commitState: "unconfirmed",
            accountRoutes: accountOnlyVerification ? new Set() : null, accountRoutesCapped: false,
            accountDenied: null, accountDeniedContext: null, accountFrameDiagnosis: null, firstPolicyBlock: null, terminalOutcome: null,
            native: normal ? { metadata: new WeakMap(), observed: new Map(), protocolCounts: new Map(),
                attended: nativeRun?.attended === true,
                handoffConfirmed: nativeRun?.handoffConfirmed === true,
                queryBindings: new Map(), protocolEntries: new Map(), requests: new Set(), lists: {}, authorizeScripts: new Map(),
                authorizeStaticOrigins: new Map(),
                historyObservations: new Map(),
                automationParents: null, automationDetails: new Map(), coworkPopulations: new Map(), membershipPages: new Set(),
                authDocumentRequests: new Map(),
                authorizationContext: 0,
                appDocumentBinding,
                authSubmissionIds: new Set(), authSubmissionCounts: { return: 0, continuation: 0, callback: 0 },
                deviceRequestIds: new Set(), retiredDeviceRisks: [], retiredBootstrapTokens: new Set(),
                gateway: null, principal: null, selectedChat: null, selectedCowork: null,
                threadIds: new Set(), messageCursor: null, window: null, counts: { eligible: 0, outside: 0, unqualified: 0 } } : null,
            accountSelf: accountOnlyVerification || normal ? { routed: false, protocolConsumed: false, continued: false } : null,
            accountSelfPreflight: accountOnlyVerification || normal
                ? { consumed: false, associated: false, requestContinued: false, responseContinued: false } : null,
            accountScripts: accountOnlyVerification ? { urls: new Set(), capped: false, omitted: false } : null,
            accountToken: accountOnlyVerification || normal ? {
                POST: { routeConsumed: 0, protocolConsumed: 0, requestContinued: 0, responseContinued: 0 },
                OPTIONS: { routeConsumed: 0, protocolConsumed: 0, requestContinued: 0, responseContinued: 0 },
                errorResponsesContinued: 0, capReached: false, mismatch: false,
                redirectBlocked: false, continuationFailed: false,
            } : null };
        pageScopes.set(scopePage, scope);
        current = scope;
        if (normal && lease) scope.abort.signal.addEventListener("abort", () => { void retireNativeBootstrap(scope); }, { once: true });
        return scope;
    }
    async function idle(scope) {
        scope.phase = "idle";
        scope.observer.block();
        if (normal) return;
        if (accountOnlyVerification) {
            // A denied navigation can still commit Chrome's error document; do not race it with another navigation.
            if (!browserClosed && !scope.page.isClosed()) await scope.page.close();
            return;
        }
        if (!browserClosed && !scope.page.isClosed() && scope.page.url() !== "about:blank") {
            await scope.page.goto("about:blank", { waitUntil: "domcontentloaded" });
        }
    }
    async function release(scope) {
        if (!scope) return;
        if (scope.releaseTask) return scope.releaseTask;
        scope.releaseTask = (async () => {
            const beforeCleanup = scope.observer.snapshot(), capturedResponses = scope.captures.size;
            if (normal && (!browserOwnedSignIn() || nativeRun.collectionPrepared)) retainAppDocumentContinuity(scope);
            if (accountOnlyVerification) accountGate?.retire();
            scope.abort.abort();
            scope.observer.close();
            try {
                await retireNativeBootstrap(scope);
                if (accountOnlyVerification) await Promise.allSettled([...scope.pending]);
                await idle(scope);
            }
            finally {
                await Promise.allSettled([...scope.pending]);
                if (!engineering) console.info(scope.clientRead ? "[workiq-native] native client read settled"
                    : "[workiq-native] original read settled", JSON.stringify({
                    purpose: scope.lease ? "content" : "identity", capturedResponses,
                    commitState: scope.lease ? scope.commitState : "not-applicable",
                    ...(scope.lease ? { sourceComparison: scope.comparison ?? null } : {}),
                    ...(scope.native ? { nativeSource: { producer: scope.clientRead ? "m365-native-client-return-v1" : nativeHistoryProducer.version,
                        accountVerified: verified, window: scope.native.window, liveWindow: scope.native.liveWindow ?? null, counts: scope.native.counts,
                        failure: scope.error?.code ?? null, cleanupFailed: scope.cleanupFailed === true,
                        ...(scope.afterStopFailure ? { afterStopFailure: scope.afterStopFailure } : {}),
                        denial: scope.native.denial ?? null,
                        ...(scope.native.attended ? { attendedSignIn: { display: "visible",
                            flow: visibilityExperiment ? "visibility-experiment" : "direct",
                            userVisibility: scope.native.handoffConfirmed ? "acknowledged-in-window" : "unconfirmed",
                            ...(!browserOwnedSignIn() ? { telemetryAttemptLimit: nativeTelemetryAttemptLimits.attended } : {}),
                            lastRecognizedInteraction: scope.native.attendedInteraction ?? null } } : {}),
                        ...(scope.native.bootstrapTerminal ? { bootstrap: scope.native.bootstrapTerminal } : {}),
                        ...(scope.native.bootstrapBranch ? { bootstrapBranch: scope.native.bootstrapBranch } : {}),
                        ...(scope.blockedBootstrapChild ? { blockedBootstrapChild: scope.blockedBootstrapChild } : {}),
                        ...(scope.blockedPartnerPreload ? { blockedPartnerPreload: scope.blockedPartnerPreload,
                            partnerPreloadRole: scope.native.partnerPreloadRole } : {}),
                        ...(scope.blockedCachedSession ? { blockedCachedSession: scope.blockedCachedSession,
                            cachedSessionRole: scope.native.cachedSessionRole } : {}),
                        ...(scope.blockedAuthTelemetry ? { blockedAuthTelemetry: scope.blockedAuthTelemetry } : {}),
                        ...(scope.blockedAppEvents ? { blockedAppEvents: scope.blockedAppEvents } : {}),
                        ...(scope.blockedChatActions ? { blockedChatActions: scope.blockedChatActions } : {}),
                        ...(scope.blockedCspReports ? { blockedCspReports: scope.blockedCspReports } : {}),
                        ...(scope.native.workerPreflight ? { workerPreflight: scope.native.workerPreflight } : {}),
                        ...(scope.native.bootstrapHealthTransport ? { bootstrapHealthTransport: scope.native.bootstrapHealthTransport } : {}),
                        ...(scope.native.presentationTransport ? { presentationTransport: scope.native.presentationTransport } : {}),
                        ...(scope.native.localImages ? { localImages: scope.native.localImages } : {}),
                        ...(scope.blockedFetchOnlySinkRequests ? { blockedFetchOnlySinkRequests: scope.blockedFetchOnlySinkRequests } : {}),
                        ...(scope.blockedDependencyPreflights ? { blockedDependencyPreflights: scope.blockedDependencyPreflights } : {}),
                        ...(scope.native.authReturnProof ? { authReturnProof: scope.native.authReturnProof } : {}),
                        ...(scope.native.authReturnOutcome ? { authReturn: scope.native.authReturnOutcome } : {}),
                        ...(scope.native.authContinuationProof ? { authContinuationProof: scope.native.authContinuationProof } : {}),
                        ...(scope.native.authContinuationOutcome ? { authContinuation: scope.native.authContinuationOutcome } : {}),
                        ...(scope.native.authCallbackProof ? { authCallbackProof: scope.native.authCallbackProof,
                            authCallbackProtocol: scope.native.authCallbackProtocol } : {}),
                        ...(scope.native.authCallbackOutcome ? { authCallback: scope.native.authCallbackOutcome } : {}),
                        ...(scope.native.authorizationReentry ? { authorizationReentry: { ...scope.native.authorizationReentry,
                            submissions: scope.native.authSubmissionCounts, deviceRequestIdentities: scope.native.deviceRequestIds.size } } : {}),
                        ...(scope.native.healthPingFailures ? { nativeHealthPingFailures: scope.native.healthPingFailures } : {}),
                        ...(scope.native.faviconAdmitted ? { declaredFaviconRequests: scope.native.faviconAdmitted } : {}),
                        ...(scope.native.faviconFailure ? { faviconFailure: scope.native.faviconFailure } : {}),
                        ...(scope.native.returnImageRequests ? { nativeReturnImageRequests: scope.native.returnImageRequests } : {}),
                        ...(scope.native.humanAuthStep ? { humanAuthStep: scope.native.humanAuthStep } : {}),
                        ...(scope.native.deviceRiskOutcome ? { deviceRisk: scope.native.deviceRiskOutcome,
                            deviceRiskRole: scope.native.deviceRiskRole } : {}),
                        sourceRequestRecords: { retained: scope.native.requestOrigins?.size ?? 0,
                            limit: nativeRequestOriginLimit, capped: scope.native.requestOriginsTruncated === true },
                        enteredWithContinuation: scope.native.enteredWithContinuation === true,
                        coverage: "bounded-slice-not-account-complete" } } : {}),
                    ...(scope.accountRoutes ? { accountOnlyRequests: {
                        recorded: scope.accountRoutes.size, capped: scope.accountRoutesCapped,
                        deniedDependency: scope.accountDenied,
                        firstDenialContext: scope.accountDeniedContext,
                        frameDiagnosis: scope.accountFrameDiagnosis,
                        firstPolicyBlock: scope.firstPolicyBlock,
                        terminalOutcome: scope.terminalOutcome,
                        selfRouteConsumed: scope.accountSelf.routed,
                        selfProtocolConsumed: scope.accountSelf.protocolConsumed,
                        self2xxContinued: scope.accountSelf.continued,
                        selfPreflight: scope.accountSelfPreflight,
                        scriptAssets: { urls: [...scope.accountScripts.urls], capped: scope.accountScripts.capped,
                            omitted: scope.accountScripts.omitted },
                        tokenRequests: {
                            posts: scope.accountToken.POST, preflights: scope.accountToken.OPTIONS,
                            errorResponsesContinued: scope.accountToken.errorResponsesContinued,
                            capReached: scope.accountToken.capReached, mismatch: scope.accountToken.mismatch,
                            redirectBlocked: scope.accountToken.redirectBlocked,
                            continuationFailed: scope.accountToken.continuationFailed,
                        },
                    } } : {}),
                    beforeCleanup, afterCleanup: scope.observer.snapshot(),
                }));
                scope.captures.clear();
                scope.native?.requests.clear();
                if (scope.native) {
                    scope.native.lists = {}; scope.native.principal = null; scope.native.gateway = null;
                    scope.native.authorizeScripts.clear();
                    scope.native.authorizeStaticOrigins.clear();
                    scope.native.authPostRequests?.clear();
                    scope.native.authContinuationRequests?.clear();
                    scope.native.authPostNavigationUrl = null;
                    scope.native.authPostNavigationDocument = null;
                    scope.native.authReturnAccepted = null;
                    scope.native.authContinuationAccepted = null;
                    scope.native.authContinuationNavigationUrl = null;
                    scope.native.authContinuationNavigationDocument = null;
                    scope.native.authCallbackAccepted = null;
                    scope.native.authCallbackNavigation = null;
                    scope.native.bootstrapSampleDocument = null;
                    scope.native.faviconRequests?.clear();
                    scope.native.requestOrigins?.clear();
                    scope.native.appDocumentBinding = null;
                }
                scope.accountScripts?.urls.clear();
                if (current === scope) current = null;
            }
        })();
        return scope.releaseTask;
    }
    async function freshPage() {
        const previous = page;
        page = await browser.newPage();
        if (previous && !previous.isClosed()) await previous.close();
        return page;
    }
    async function waitFor(scope, predicate, code) {
        for (let attempt = 0; attempt < 45 && !predicate(); attempt++) {
            if (scope.error) throw scope.error;
            if (scope.abort.signal.aborted || scope !== current || browserClosed) throw sourceError("NATIVE_SOURCE_CANCELLED");
            await delay(1000, undefined, { signal: scope.abort.signal });
        }
        if (scope.error) throw scope.error;
        if (!predicate()) throw sourceError(code);
    }
    async function capture(response) {
        const request = response.request(), scope = requestScopes.get(request);
        if (!scope) return;
        const observation = scope.observer.response(request);
        if (!observation) return;
        const meta = { captureId: randomUUID(), capturedAt: new Date().toISOString(), status: response.status(),
            generation: scope.lease?.generation, kind: observation.kind };
        scope.metadata.set(request, meta);
        try {
            await scope.observer.assertCurrent(request);
            if (normal && [403, 404].includes(response.status())
                && scope.native.protocolEntries.get(scope.native.metadata.get(request)?.slot)?.unavailableResponse) {
                scope.native.requests.add(request);
                return;
            }
            if (normal && response.status() === 503 && request.method() === "GET") {
                const entry = scope.native.protocolEntries.get(scope.native.metadata.get(request)?.slot);
                if (entry?.readFailureResponse) {
                    if (await response.headerValue("retry-after") !== null) throw sourceError("NATIVE_SOURCE_RETRY_AFTER_REQUIRED");
                    scope.observer.readFailed(request);
                    entry.retryAfterAbsent = true;
                    return;
                }
            }
            if (response.status() !== 200) throw sourceError(response.status() === 401 || response.status() === 403
                ? "NATIVE_SOURCE_ACCESS_EXPIRED" : "NATIVE_SOURCE_RESPONSE_STATUS");
            if (normal) {
                meta.mime = await response.headerValue("content-type") ?? "";
                meta.serialized = Boolean(await response.headerValue("x-tss-serialized"));
                scope.native.requests.add(request);
                return;
            }
            if (observation.kind === "chat") return;
            const bound = observation.phase === "identity" ? 1024 * 1024 : maximumBytes;
            const length = await response.headerValue("content-length");
            if (length !== null && Number(length) > bound) throw sourceError("NATIVE_SOURCE_BYTE_LIMIT");
            let timer;
            const bytes = await Promise.race([response.body(), new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(sourceError("NATIVE_SOURCE_BODY_DEADLINE")), 45000);
            })]).finally(() => clearTimeout(timer));
            scope.observer.bodyComplete(request);
            if (bytes.length > bound) throw sourceError("NATIVE_SOURCE_BYTE_LIMIT");
            const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            if (observation.kind === "cowork-detail") {
                if (body?.task?.taskId !== composite || body.task.sessionId !== sessionId
                    || body.snapshot?.sessionId != null && body.snapshot.sessionId !== sessionId) {
                    throw sourceError("NATIVE_SOURCE_ASSOCIATION_FAILED");
                }
            } else if (!Array.isArray(body?.events) || body.events.length > 10000) {
                throw sourceError("NATIVE_SOURCE_EVENTS_INVALID");
            }
            const acceptAliases = () => {
                if (observation.kind !== "cowork-detail") return;
                selectedIds.clear();
                selectedIds.add(composite); selectedIds.add(sessionId);
                if (typeof body.snapshot?.ic3ThreadId === "string") selectedIds.add(body.snapshot.ic3ThreadId);
            };
            if (observation.phase === "identity") {
                await scope.observer.accept(request, () => {
                    acceptAliases();
                    scope.identity = { origin: new URL(response.url()).origin, observedAt: new Date().toISOString() };
                });
                return;
            }
            Object.assign(meta, { bytes: bytes.length, bodyDigest: hash(bytes) });
            await scope.observer.accept(request, () => {
                acceptAliases();
                scope.captures.set(observation.kind, { body, meta, origin: new URL(response.url()).origin });
            });
        } catch (error) {
            scope.observer.readFailed(request);
            fault(scope, error);
        }
    }
    async function guardAccountSelfRedirects(scopePage) {
        const protocol = await browser.newCDPSession(scopePage);
        accountProtocol = protocol;
        const { frameTree: { frame: { id: mainFrameId } } } = await protocol.send("Page.getFrameTree");
        if (typeof mainFrameId !== "string" || !mainFrameId) throw sourceError("NATIVE_ACCOUNT_SELF_GATE_UNAVAILABLE");
        accountGate = await guardAccountOnlyRequests(protocol, {
            mainFrameId, getScope: () => current?.page === scopePage && accountProtocol === protocol ? current : null,
            admit: admitAccount, stop: stopAccount, track,
            responded(scope, kind, method, status) {
                if (kind === "self") scope.accountSelf.continued = true;
                if (kind === "self-preflight") scope.accountSelfPreflight.responseContinued = true;
                if (kind === "token") {
                    scope.accountToken[method].responseContinued++;
                    if (status >= 400) scope.accountToken.errorResponsesContinued++;
                }
            },
        });
        accountProtocolReady = true;
    }
    async function routeOriginal(route) {
        const request = route.request(), url = new URL(request.url()), method = request.method(), type = request.resourceType();
        const kind = selectedKind(url), scope = requestScopes.get(request) ?? current;
        const block = () => route.abort("blockedbyclient");
        let accountKind = null, accountFacts = null;
        try {
            if (closed || browserClosed || !scope || scope !== current) return await block();
            if (normal) {
                let frame;
                try { frame = request.frame(); } catch { nativeFailure(scope, "NATIVE_SOURCE_FRAME_UNQUALIFIED"); return await block(); }
                const facts = { url, method, type, navigation: request.isNavigationRequest(),
                    owned: frame.page() === scope.page && !frame.isDetached(),
                    nativeMainFrame: frame === scope.page.mainFrame(),
                    original: request.redirectedFrom() === null, stage: "route" };
                const risk = scope.native.deviceRisk;
                if (risk && (deviceBrowserFrame(risk, frame) || !risk.frame && frame.parentFrame() === scope.page.mainFrame()
                    && url.href === risk.url && facts.original)) {
                    const matching = () => risk.routeEntries.filter(entry => !entry.routed && entry.url === url.href && entry.method === method);
                    await nativeWait(scope, () => matching().length > 0, 2000, "NATIVE_DEVICE_RISK_FRAME_COVERAGE_UNQUALIFIED");
                    const matches = matching();
                    const entry = matches.length === 1 ? matches[0] : null, node = risk.frames.get(entry?.frameId);
                    const parentFrame = entry?.frameId === risk.frameId ? scope.page.mainFrame() : risk.frames.get(node?.parentId)?.frame;
                    if (!entry || !deviceFrameOwned(risk, entry.frameId) || frame.parentFrame() !== parentFrame
                        || node.frame && node.frame !== frame) {
                        throw sourceError("NATIVE_DEVICE_RISK_HANDOFF_UNQUALIFIED");
                    }
                    entry.routed = true;
                    node.frame ??= frame;
                    if (entry.frameId === risk.frameId) risk.frame ??= frame;
                    facts.deviceRiskFrameId = entry.frameId;
                    facts.deviceRiskDocument = entry.kind === "device-risk-document";
                }
                if (method === "OPTIONS" && !facts.navigation && facts.owned && accountProtocolReady && accountGate?.active
                    && ["routing", "cowork-list", "cowork-detail", "cowork-messages", ...COWORK_MEMBERSHIP_KINDS].includes(
                        nativeData(scope, { ...facts, method: "GET" }, () => undefined)?.kind)) {
                    // The protocol gate alone binds this browser preflight to its actual original GET.
                    return await route.continue();
                }
                const admitted = await admitNative(scope, facts, "route", () => request.postData());
                if (!admitted) return await block();
                if (admitted === "blocked-chat-action") return await block();
                const metadata = observeNative(scope, request, "route");
                if (metadata) return await scope.observer.continueOriginal(request, () => {
                    if (metadata.kind === "chat") scope.chatRequest = request;
                    return route.continue();
                });
                return await route.continue();
            }
            const auth = ["https://login.microsoftonline.com", "https://login.microsoft.com", "https://autologon.microsoftazuread-sso.com"].includes(url.origin);
            if (accountOnlyVerification) {
                accountFacts = { url, method, type, navigation: request.isNavigationRequest(),
                    owned: false, original: request.redirectedFrom() === null, stage: "route" };
                try { accountFacts.owned = request.frame() === scope.page.mainFrame() && request.frame().page() === scope.page; }
                catch { stopAccount(scope, "unowned-frame", accountFacts); }
                accountKind = admitAccount(scope, accountFacts, "route");
                if (!accountKind) return await block();
                if (type === "script") recordAccountScript(scope, request, url);
                return await route.continue();
            }
            if (kind && !request.isNavigationRequest()) {
                if (scope.phase === "identity" && kind !== "cowork-detail") return await block();
                if (method === "OPTIONS" && (await request.headerValue("access-control-request-method")) === "GET") return await route.continue();
                const identityRead = scope.phase === "identity" && kind === "cowork-detail";
                if (method !== "GET" || !identityRead && (!verified || (kind === "chat" ? scope.phase !== "chat" : scope.phase !== "cowork"))) return await block();
                if (kind.startsWith("cowork")) {
                    const tenant = await request.headerValue("x-tenant-id"), subject = await request.headerValue("x-user-id");
                    if (subject?.toLowerCase() !== target.expectedSubject.toLowerCase()
                        || tenant !== null && tenant.toLowerCase() !== target.expectedTenant.toLowerCase()) {
                        throw sourceError("NATIVE_SOURCE_ACCOUNT_MISMATCH");
                    }
                    scope.accountMatched = true;
                }
                try {
                    await scope.observer.continueOriginal(request, () => {
                        if (kind === "chat") scope.chatRequest = request;
                        return route.continue();
                    });
                } catch (error) {
                    if (error.code === "NATIVE_ORIGINAL_REQUEST_ALREADY_CONSUMED") return await block();
                    throw error;
                }
                return;
            }
            const app = [origin, "https://m365.cloud.microsoft"].includes(url.origin);
            if (method === "POST" && request.isNavigationRequest() && app && url.pathname === "/landingv2"
                && scope.signInClicked && scope.accountSelected) return await route.continue();
            if (!["GET", "HEAD", "OPTIONS"].includes(method)) return await block();
            if (gateway(url)) return url.pathname === "/v1/routing" && !url.search ? await route.continue() : await block();
            if (/\/(?:subscribe|conversations|conversation|tasks|messages|files)(?:\/|$)/.test(url.pathname)
                && !(request.isNavigationRequest() && kind === "chat" && scope.phase === "chat")) return await block();
            if (auth || app && request.isNavigationRequest()
                && ["/", "/home", "/login", "/landingv2", "/spalanding", "/cowork/", target.chatPath].includes(url.pathname)) return await route.continue();
            if (["script", "stylesheet", "font", "image"].includes(type)
                && (app || /(^|\.)cdn\.office\.net$|(^|\.)onecdn\.static\.microsoft$|^aadcdn\.msftauth\.net$|^aadcdn\.msauth\.net$|(^|\.)sharepointonline\.com$/.test(url.hostname))) {
                if (type === "script") recordAccountScript(scope, request, url);
                return await route.continue();
            }
            if (url.origin === "https://config.edge.skype.com" && url.pathname === "/config/v1/CHILL/0.0.14"
                || url.origin === "https://res.cdn.office.net" && ["/teams-js/validDomains/json/validDomains.json", "/s01-copilotstudio/cowork/latest/version.json"].includes(url.pathname)
                || url.origin === "https://res.public.onecdn.static.microsoft" && /\.json$/.test(url.pathname)
                || app && ["/healthz", "/client_health_ping", "/events-worker.js"].includes(url.pathname)) return await route.continue();
            return await block();
        } catch (error) {
            if (accountOnlyVerification) {
                if (accountKind === "token") scope.accountToken.continuationFailed = true;
                stopAccount(scope, "route-continuation", accountFacts);
            }
            else if (normal) nativeFailure(scope, error);
            else if (scope) fault(scope, error);
            try { await route.abort(); }
            catch { console.error("[workiq-native] route cleanup failed", { code: "NATIVE_ROUTE_ABORT_FAILED" }); }
        }
    }
    const transport = createMicrosoftNativeReadTransport({
        async open(operation) {
            if (!configuration || closed) throw new MicrosoftSessionError("hooks-unqualified");
            if (!["headless", "visible"].includes(operation.mode) || operation.mode === "visible" && !visibleSignIn) {
                throw new MicrosoftSessionError("invalid-request");
            }
            let connection;
            if (engineering) {
                if (engineering.connectionStarted) throw sourceError("NATIVE_ENGINEERING_ALREADY_STARTED");
                try { connection = engineering.beginConnection(operation); }
                catch (error) { recordNativeEngineeringFailure(engineering, error); throw error; }
            }
            accountFailure = null;
            accountFailureContext = null;
            selectedIds.clear();
            for (const value of normal ? [] : [composite, sessionId, target.coworkThreadId]) selectedIds.add(value);
            if (normal) nativeRun = { deadline: connection?.deadline ?? Date.now() + 300000, assets: new Set(), counts: new Map(),
                attended: operation.mode === "visible", authDeadline: connection?.authDeadline ?? Date.now() + 90000,
                ownerId: operation.ownerId, generation: null, tokenEndpoint: null, principal: null,
                bodyBytes: 0, recordCount: 0, documentEpoch: 0, continuityVersion: 0, collections: 0, lastCommit: null,
                processed: new Map(), waitingHistories: new Set(), discoveryCarry: null, discoveryYieldTurn: new Map(),
                deletionVersion: await exclusiveBoard(context, state => activityDeletionVersion(state), { readOnly: true }) };
            attemptedOwner = operation.ownerId;
            const openingEpoch = ++epoch;
            const assertOpening = () => {
                if (openingEpoch !== epoch || operation.signal.aborted || closed) throw new MicrosoftSessionError("cancelled");
            };
            openings++;
            try {
                const directory = await realpath(configuration.profileDirectory);
                assertOpening();
                const relative = path.relative(process.cwd(), directory);
                if (!relative || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep)) {
                    throw new MicrosoftSessionError("profile-contention");
                }
                const marker = JSON.parse(await readFile(path.join(path.dirname(directory), "profile-owner.json"), "utf8"));
                if (marker.sessionId !== configuration.profileOwnerSessionId || marker.profile !== path.basename(directory)
                    || (await profileOwners(directory)).length) throw new MicrosoftSessionError("profile-contention");
                assertOpening();
                lock = await open(configuration.ownerLockPath, "wx");
                ownerId = operation.ownerId;
                await lock.writeFile(JSON.stringify({ pid: process.pid, owner: ownerId, profile: directory, operation: "native-product-read" }));
                assertOpening();
                browser = await chromium.launchPersistentContext(directory, {
                    channel: "msedge", headless: operation.mode === "headless", chromiumSandbox: true,
                    serviceWorkers: "block", acceptDownloads: false, timeout: 30000,
                    args: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
                });
                browserClosed = false;
                const openedBrowser = browser, openedRun = nativeRun;
                if (engineering) engineering.registerBrowserOwners(await profileOwners(directory));
                browser.on("close", () => {
                    if (browser !== openedBrowser || nativeRun !== openedRun) return;
                    revokeAppDocumentContinuity();
                    browserClosed = true; accountProtocolReady = false; current?.abort.abort();
                    nativeOwnerLost(openedRun, "NATIVE_SOURCE_BROWSER_CLOSED");
                });
                try { assertOpening(); }
                catch (error) { await browser.close(); throw error; }
                if (!browser.pages().every(item => item.url() === "about:blank")) throw new MicrosoftSessionError("profile-contention");
                browser.setDefaultTimeout(10000);
                browser.setDefaultNavigationTimeout(30000);
                const blockSockets = socket => {
                    if (accountOnlyVerification) stopAccount(current, "websocket-dependency");
                    if (normal && current?.native?.deviceRisk && URL.parse(socket.url())?.origin === current.native.deviceRisk.origin) {
                        nativeFailure(current, "NATIVE_DEVICE_RISK_TRANSPORT_UNQUALIFIED");
                    }
                    socket.close();
                };
                if (!browserOwnedSignIn()) {
                    await browser.routeWebSocket("**/*", blockSockets);
                    await browser.route("**/*", routeOriginal);
                }
                browser.on("request", request => {
                    const scope = current;
                    if (!scope || accountOnlyVerification) return;
                    if (browserOwnedSignIn() && !nativeRun.collectionPrepared) return;
                    try {
                        if (normal) {
                            if (!request.isNavigationRequest()) observeNative(scope, request);
                            return;
                        }
                        if (request.isNavigationRequest() || request.method() !== "GET") return;
                        const kind = selectedKind(new URL(request.url()));
                        if (!kind || request.frame().page() !== scope.page) return;
                        requestScopes.set(request, scope);
                        scope.observer.observe(request, kind);
                    }
                    catch (error) { if (normal) nativeFailure(scope, error); else fault(scope, error); }
                });
                browser.on("response", response => {
                    const scope = requestScopes.get(response.request());
                    void track(capture(response).catch(error => {
                        if (scope) fault(scope, error);
                    }), scope);
                });
                browser.on("requestfinished", request => requestScopes.get(request)?.observer.requestFinished(request));
                // Account-only HTTP failures use exact Network IDs in the owned protocol gate, not anonymous duplicate events.
                if (!accountOnlyVerification && !normal) browser.on("requestfailed", request => {
                    const scope = requestScopes.get(request);
                    if (scope?.observer.requestFailed(request) && scope === current && !scope.abort.signal.aborted) {
                        fault(scope, sourceError("NATIVE_ORIGINAL_REQUEST_FAILED"));
                    }
                });
                const binding = "__wireNativeChatRead_" + randomUUID().replaceAll("-", "");
                captureResetBinding = "__wireNativeCapturePhase_" + randomUUID().replaceAll("-", "");
                engineeringProjectionBinding = engineering ? "__wireEngineeringProjection_" + randomUUID().replaceAll("-", "") : null;
                installCaptureBinding = () => browser.exposeBinding(binding, ({ frame }, source) => {
                    const scope = pageScopes.get(frame.page());
                    return track((async () => {
                    try {
                        if (engineering) {
                            if (engineering.complete) {
                                if (source?.type === "engineering-failure") return;
                                throw sourceError("NATIVE_ENGINEERING_SCOPE_CLOSED");
                            }
                            return await acceptEngineeringMessage(scope, frame, source);
                        }
                        if (normal && ![origin, "https://m365.cloud.microsoft"].includes(URL.parse(frame.url())?.origin)) {
                            throw sourceError("NATIVE_CHAT_CONTEXT_INVALID");
                        }
                        if (normal && source?.kind === "principal-document") {
                            if (["native-connect", "native-collection-bootstrap", "cowork-discovery", "cowork-membership"].includes(scope?.phase)) {
                                return await acceptNativeBootstrap(scope, frame, source);
                            }
                            return;
                        }
                        if (normal && source?.kind === "chat-history-document") return await acceptNativeHistoryDocument(scope, frame, source);
                        if (normal && COWORK_MEMBERSHIP_KINDS.includes(source?.kind)) return await acceptCoworkMembershipBody(scope, frame, source);
                        if (normal && source?.state === "read-failed" && source.status === 503 && source.method === "GET") {
                            if (!scope || scope !== current || scope.abort.signal.aborted || frame !== scope.page.mainFrame()) {
                                throw sourceError("NATIVE_SOURCE_RESPONSE_UNQUALIFIED");
                            }
                            const entries = [...scope.native.protocolEntries.values()].filter(entry => entry.url === source.requestUrl
                                && entry.kind === source.kind && entry.method === source.method
                                && entry.readFailureResponse && entry.responseStatus === source.status
                                && entry.documentEpochAtAdmission === nativeRun.documentEpoch);
                            if (entries.length !== 1) throw sourceError("NATIVE_SOURCE_RESPONSE_UNQUALIFIED");
                            scope.native.readFailure ??= entries[0];
                            return;
                        }
                        if (["failed", "cleanup-failed"].includes(source?.state)) {
                            const codes = ["NATIVE_CHAT_CAPTURE_ALREADY_CONSUMED", "NATIVE_CHAT_RESPONSE_UNQUALIFIED",
                                "NATIVE_CHAT_STREAM_DEADLINE", "NATIVE_CHAT_STREAM_BYTE_LIMIT", "NATIVE_CHAT_READER_CANCEL_FAILED",
                                "NATIVE_CHAT_FRAME_LIMIT", "NATIVE_CHAT_STREAM_DECODE_FAILED"];
                            throw sourceError(codes.includes(source.code) ? source.code : "NATIVE_CHAT_CAPTURE_INVALID");
                        }
                        if (normal && source?.kind) return await acceptNativeBody(scope, frame, source);
                        if (!scope || scope !== current || scope.phase !== "chat" || frame !== scope.page.mainFrame()
                            || !(normal ? [origin, "https://m365.cloud.microsoft"] : [origin]).includes(new URL(frame.url()).origin)
                            || !scope.chatRequest) throw sourceError("NATIVE_CHAT_CONTEXT_INVALID");
                        if (normal && (scope.native.metadata.get(scope.chatRequest)?.documentEpoch !== nativeRun.documentEpoch
                            || scope.native.metadata.get(scope.chatRequest)?.frameUrl !== frame.url())) {
                            throw sourceError("NATIVE_SOURCE_DOCUMENT_CHANGED");
                        }
                        await scope.observer.assertCurrent(scope.chatRequest);
                        if (source.state !== "complete" || source.status !== 200 || !Number.isSafeInteger(source.bytes)
                            || source.bytes < 0 || source.bytes > maximumBytes || !Array.isArray(source.frames)
                            || source.frames.length > 256 || !/^[a-f0-9]{64}$/.test(source.bodyDigest)) throw sourceError("NATIVE_CHAT_CAPTURE_INVALID");
                        const conversation = normal ? scope.native.selectedChat : decodeURIComponent(target.chatPath.split("/").at(-1));
                        if (!source.frames.some(item => item.conversationId === conversation)
                            || source.frames.some(item => item.conversationId && item.conversationId !== conversation)
                            || !source.frames.some(item => item.isLastPage === true)) throw sourceError("NATIVE_CHAT_ASSOCIATION_FAILED");
                        const meta = scope.metadata.get(scope.chatRequest);
                        if (!meta) throw sourceError("NATIVE_CHAT_RESPONSE_NOT_OBSERVED");
                        scope.observer.bodyComplete(scope.chatRequest);
                        Object.assign(meta, { bytes: source.bytes, bodyDigest: source.bodyDigest });
                        if (normal) {
                            nativeRun.bodyBytes += source.bytes;
                            if (nativeRun.bodyBytes > 24 * 1024 * 1024) { scope.native.backfillBudget = "byte-budget"; throw sourceError("NATIVE_SOURCE_BYTE_LIMIT"); }
                            nativeRun.recordCount += source.frames.reduce((count, item) => count + (item.messages?.length ?? 0), 0);
                            if (nativeRun.recordCount > 10000) { scope.native.backfillBudget = "record-budget"; throw sourceError("NATIVE_SOURCE_RECORD_LIMIT"); }
                        }
                        await scope.observer.accept(scope.chatRequest, () => scope.captures.set("chat", { body: source.frames, meta,
                            origin: normal ? new URL(scope.chatRequest.url()).origin : origin }));
                    } catch (error) {
                        if (scope) { if (scope.chatRequest) scope.observer.readFailed(scope.chatRequest);
                            if (normal) nativeFailure(scope, error); else fault(scope, error); }
                        throw sourceError(safeCode(error));
                    }
                    })(), scope);
                });
                if (!accountOnlyVerification && !browserOwnedSignIn()) await installCaptureBinding();
                if (engineering) await browser.addInitScript({ content: `(${installHistoryEngineeringCapture.toString()})(${JSON.stringify({
                    binding, projectionBinding: engineeringProjectionBinding,
                })},(${createHistoryEngineeringProjection.toString()})(${JSON.stringify({
                    expectedAccount, salt: engineering.salt,
                })},${sourceProjection.toString()}));` });
                else if (!accountOnlyVerification) {
                    captureScript = `(${installNativeChatCapture.toString()})(${JSON.stringify({
                        origin, path: target?.chatPath, binding,
                        ...(normal ? { nativeHistory: { bootstrapRpcId: nativeHistoryProducer.bootstrapRpcId,
                            chatRpcId: nativeHistoryProducer.chatRpcId, chatInitializerRpcId: nativeHistoryProducer.chatInitializerRpcId,
                            resetBinding: captureResetBinding, coworkMembership: true }, timeoutMs: 20000 } : {}),
                    })},${sourceProjection.toString()},${projectCoworkMembership.toString()},${readNativeAccountMetadata.toString()},${projectNativeBootstrapHistory.toString()});`;
                    if (!browserOwnedSignIn()) await browser.addInitScript({ content: captureScript });
                }
                page = browser.pages()[0] || await browser.newPage();
                const openedPage = page;
                if (browserOwnedSignIn()) {
                    nativeRun.toolGuard = await protectNativeToolTransport({
                        browser, deadline: nativeRun.authDeadline, signal: operation.signal,
                        assertOwner() {
                            if (browser !== openedBrowser || nativeRun !== openedRun || browserClosed || closed
                                || ownerId !== openedRun.ownerId) throw sourceError("NATIVE_TOOL_GUARD_OWNER_LOST");
                        },
                        onFailure(error) {
                            if (nativeRun !== openedRun) return;
                            nativeFailure(current, error);
                            nativeOwnerLost(openedRun, error.code, error.publicCoworkScript);
                        },
                    });
                }
                if (accountOnlyVerification || normal) {
                    browser.on("page", extra => {
                        if (browser !== openedBrowser || nativeRun !== openedRun) return;
                        if (extra === page) return;
                        if (browserOwnedSignIn() && !nativeRun.collectionPrepared) return;
                        if (normal) nativeFailure(current, "NATIVE_SOURCE_UNEXPECTED_PAGE"); else stopAccount(current, "unexpected-page");
                        void track(extra.close().catch(() => {
                            if (normal) nativeFailure(current, "NATIVE_SOURCE_PAGE_CLEANUP_FAILED"); else stopAccount(current, "page-cleanup");
                        }), current);
                    });
                    page.on("crash", () => {
                        if (page !== openedPage || browser !== openedBrowser || nativeRun !== openedRun) return;
                        if (normal) { nativeFailure(current, "NATIVE_SOURCE_PAGE_COVERAGE"); nativeOwnerLost(openedRun, "NATIVE_SOURCE_PAGE_CRASHED"); }
                        else stopAccount(current, "page-coverage");
                    });
                    page.on("close", () => {
                        if (page !== openedPage || browser !== openedBrowser || nativeRun !== openedRun) return;
                        if (current?.native?.attended && current.phase === "native-connect" && !current.abort.signal.aborted) {
                            recordNativeHostFailure(current, new MicrosoftSessionError("window-closed"));
                            current.abort.abort();
                        } else if (normal) { nativeFailure(current, "NATIVE_SOURCE_PAGE_COVERAGE"); nativeOwnerLost(openedRun, "NATIVE_SOURCE_PAGE_CLOSED"); }
                        else stopAccount(current, "page-coverage");
                    });
                    if (browserOwnedSignIn()) {
                        accountProtocol = await browser.newCDPSession(page);
                        browserAccount = await observeBrowserAccountDocument(page, accountProtocol, nativeRun.authDeadline);
                        nativeRun.mainFrameId = browserAccount.frameId;
                        accountProtocolReady = true;
                    } else if (normal) await guardNativePage(page);
                    else await guardAccountSelfRedirects(page);
                }
                assertOpening();
                if (normal && nativeRun.attended) {
                    const run = nativeRun, ownedPage = page, protocol = accountProtocol;
                    const assertPresentation = () => {
                        assertOpening();
                        if (nativeRun !== run || ownerId !== run.ownerId || page !== ownedPage || ownedPage.isClosed()
                            || browserClosed || accountProtocol !== protocol || !accountProtocolReady
                            || !browserOwnedSignIn() && !accountGate?.active) {
                            throw sourceError("NATIVE_WINDOW_PRESENTATION_UNQUALIFIED");
                        }
                        if (Date.now() >= run.authDeadline) throw new MicrosoftSessionError("timed-out");
                    };
                    await presentOwnedSignInWindow(ownedPage, protocol, run.mainFrameId, assertPresentation);
                    assertPresentation();
                    nativeRun.windowPresented = true;
                    const ready = () => {
                        assertPresentation();
                        console.info("[workiq-native] visible sign-in", JSON.stringify({
                            ...nativeHeadfulHostReady, flow: visibilityExperiment ? "visibility-experiment" : "direct",
                            deadline: new Date(nativeRun.authDeadline).toISOString(),
                        }));
                    };
                    if (visibilityExperiment) {
                        const handoff = await presentNativeSignInHandoff(page, {
                            binding: "__wireSignInHandoff_" + randomUUID().replaceAll("-", ""),
                            signal: operation.signal, deadline: nativeRun.authDeadline,
                            onReady: ready,
                        });
                        assertOpening();
                        if (handoff !== "confirmed") throw new MicrosoftSessionError(handoff);
                        nativeRun.handoffConfirmed = true;
                        console.info("[workiq-native] visible sign-in", JSON.stringify({
                            state: "handoff-confirmed", userVisibility: "acknowledged-in-window",
                        }));
                    } else {
                        ready();
                    }
                }
            } catch (error) {
                if (engineering) recordNativeEngineeringFailure(engineering, error);
                throw error;
            } finally { openings--; }
        },
        async verifyAccount(operation) {
            const scope = newScope(page);
            const accountObservation = browserOwnedSignIn() ? browserAccount : null;
            scope.recordHistory = operation.recordHistory;
            scope.recordControlFailure = operation.recordFailure ? error => operation.recordFailure(nativeFailureDetails(error, "connect")) : null;
            scope.operationSignal = operation.signal;
            if (accountOnlyVerification) scope.phase = "account-only";
            if (normal) {
                nativeRun.generation = operation.generation;
                if (engineering) {
                    const run = nativeRun;
                    engineering.bind({ ownerId: run.ownerId, signal: operation.signal, deadline: run.deadline - 20000,
                        ...(run.attended ? { authentication: { ownerId: run.ownerId, generation: operation.generation,
                            deadline: run.authDeadline } } : {}),
                        check: () => nativeRun === run && current === scope && !closed && !browserClosed && !page.isClosed()
                            && ownerId === run.ownerId && run.generation === operation.generation });
                }
                scope.native.connectLimits = Object.freeze({ ownerId: nativeRun.ownerId, generation: nativeRun.generation,
                    deadline: nativeRun.deadline, authDeadline: nativeRun.authDeadline });
                scope.phase = "native-connect";
                if (!browserOwnedSignIn()) await scope.observer.beginPhase("native-connect", { signal: operation.signal });
                if (engineering && nativeRun.windowPresented) engineering.windowReady();
            }
            let abort, originalFailure;
            const verificationDeadline = normal
                ? Math.min(scope.native.connectLimits.authDeadline, scope.native.connectLimits.deadline) : null;
            try {
                if (browserOwnedSignIn()) {
                    let timer, active = true, verificationError;
                    const assertCurrent = () => {
                        nativeRun.toolGuard.assertCurrent();
                        if (!active || scope !== current || scope.abort.signal.aborted || operation.signal.aborted || closed
                            || browserClosed || page.isClosed() || ownerId !== nativeRun.ownerId) {
                            throw scope.error ?? new MicrosoftSessionError("cancelled");
                        }
                        if (Date.now() >= verificationDeadline) throw new MicrosoftSessionError("timed-out");
                    };
                    const observe = async () => {
                        assertCurrent();
                        await page.goto(nativeApplicationEntry, { waitUntil: "commit",
                            timeout: Math.max(1, verificationDeadline - Date.now()) });
                        let principal;
                        while (!(principal = await accountObservation.read(assertCurrent, expectedAccount))) {
                            await delay(100, undefined, { signal: scope.abort.signal });
                            assertCurrent();
                        }
                        assertCurrent();
                        nativeRun.principal = principal;
                        scope.native.bootstrapBranch = accountObservation.bootstrapBranch();
                        verified = true;
                        return { tenantId: principal.tenantId, subjectId: principal.subjectId, knownAccountMatched: true,
                            ...(principal.presentation ? { presentation: principal.presentation } : {}),
                            evidence: { kind: "native-account-metadata", issuer: principal.origin,
                                observedAt: principal.observedAt, namespace: principal.namespace, realm: principal.realm } };
                    };
                    try {
                        return await Promise.race([observe(), new Promise((_, reject) => {
                            timer = setTimeout(() => reject(new MicrosoftSessionError("timed-out")),
                                Math.max(1, verificationDeadline - Date.now()));
                        })]);
                    } catch (error) {
                        verificationError = error;
                        throw error;
                    } finally {
                        active = false; clearTimeout(timer);
                        try { await accountObservation.retire(); }
                        catch (error) {
                            scope.cleanupFailed = true;
                            if (!verificationError) throw error;
                            console.error("[workiq-native] account staging retirement failed", { code: nativeErrorCode(error) });
                        }
                    }
                }
                if (accountOnlyVerification && accountFailure) {
                    stopAccount(scope, accountFailure);
                    throw scope.error;
                }
                const bootstrap = async () => {
                    let phase = accountOnlyVerification || normal ? "native-entry-invoked" : "blank-native-start", ready = false, authorization = 0;
                    if (normal) scope.native.engineeringInvocation = { url: nativeApplicationEntry, frameId: nativeRun.mainFrameId,
                        preexistingNetworkIds: new Set(scope.native.requestOrigins?.keys() ?? []) };
                    await page.goto(accountOnlyVerification || normal ? nativeApplicationEntry : origin + "/", { waitUntil: "domcontentloaded" });
                    for (let attempt = 0; scope.native?.attended ? Date.now() < nativeRun.authDeadline : attempt < 35; attempt++) {
                        if (operation.signal.aborted) throw new MicrosoftSessionError("cancelled");
                        if ((accountOnlyVerification || normal) && scope.error) throw scope.error;
                        if (normal && scope.native.authTransition) await scope.native.authTransition;
                        if (normal && (scope.native.authorizationReentry?.activated ?? 0) !== authorization) {
                            authorization = scope.native.authorizationReentry.activated;
                            ready = false;
                        }
                        await delay(750, undefined, accountOnlyVerification || normal ? { signal: scope.abort.signal } : undefined);
                        const sampledDocument = scope.native?.currentDocument, sampledEpoch = normal ? nativeRun.documentEpoch : null;
                        const sampledUrl = normal ? page.url() : null;
                        const state = await collectBootstrapUIMetadata(page, { phase, expectedAccount });
                        if (normal && scope === current && !scope.abort.signal.aborted
                            && sampledDocument === scope.native.currentDocument && sampledEpoch === nativeRun.documentEpoch
                            && sampledUrl === page.url()) {
                            const principal = scope.native.principal, proof = principal?.provenance;
                            scope.native.bootstrapSampleDocument = sampledDocument;
                            scope.native.bootstrapSnapshot = {
                                iteration: attempt + 1, phase, epoch: sampledEpoch,
                                location: nativeBootstrapRouteEvidence(URL.parse(sampledUrl)),
                                ui: { kind: state.kind, signInMatches: state.signInMatches ?? null,
                                    pickerHeadings: state.pickerHeadings ?? null, knownAccountMatches: state.knownAccountMatches ?? null,
                                    challengeCounts: state.challengeCounts ?? null, recognizedInteraction: state.interaction ?? null,
                                    nativePromptAssessment: "not-established-by-dom-counts" },
                                appReady: ready, buildRecognized: nativeBuildKnown(),
                                principal: { presence: principal ? "observed" : "not-observed",
                                    sourceQualified: proof ? proof.responseStatus === 200
                                        && ["captureId", "requestId", "networkId", "frameId"].every(key =>
                                            typeof proof[key] === "string" && proof[key].length > 0) : null,
                                    namespaceMatches: typeof principal?.namespace === "string"
                                        ? principal.namespace === nativeHistoryProducer.accountNamespace : null,
                                    realmMatches: typeof principal?.realm === "string" ? principal.realm === nativeHistoryProducer.realm : null,
                                    knownAccountMatched: typeof principal?.knownAccountMatched === "boolean" ? principal.knownAccountMatched : null },
                                document: sampledDocument ? { epoch: sampledDocument.epoch,
                                    currentEpoch: sampledDocument.epoch === sampledEpoch,
                                    mainFrame: sampledDocument.entry.frameId === nativeRun.mainFrameId,
                                    original: sampledDocument.entry.hops === 1, method: sampledDocument.entry.method,
                                    responseStatus: sampledDocument.entry.responseStatus,
                                    responseAcknowledged: sampledDocument.entry.responseAcknowledged,
                                    terminal: sampledDocument.entry.terminal ?? null, cached: sampledDocument.entry.cached } : null,
                            };
                        }
                        if (["auth-challenge-control", "auth-picker-ambiguous", "known-account-not-observed"].includes(state.kind)
                            || (accountOnlyVerification || normal) && (state.kind === "app-signin-ambiguous" || state.signInMatches > 1)) {
                            const step = state.interaction ?? (state.kind === "known-account-not-observed" ? "select-work-account" : "ambiguous-sign-in-control");
                            if (!scope.native?.attended) {
                                if (scope.native) scope.native.humanAuthStep = step;
                                console.error("[workiq-native] human sign-in required", { code: "NATIVE_HUMAN_AUTHENTICATION_REQUIRED", step });
                                throw new MicrosoftSessionError("access-refused");
                            }
                        }
                        if (scope.native?.attended && (["auth-challenge-control", "auth-picker-ambiguous", "known-account-not-observed",
                            "app-signin-ambiguous", "app-signin-control", "known-account-picker"].includes(state.kind) || state.signInMatches > 1)) {
                            if (sampledDocument !== scope.native.currentDocument || sampledEpoch !== nativeRun.documentEpoch
                                || sampledUrl !== page.url()) continue;
                            const interaction = state.interaction ?? (state.kind === "app-signin-control" ? "sign-in"
                                : ["known-account-picker", "known-account-not-observed"].includes(state.kind)
                                    ? "select-work-account" : "review-sign-in");
                            if (scope.native.attendedInteraction !== interaction) {
                                if (engineering) {
                                    const run = nativeRun, protocol = accountProtocol;
                                    const assertAttention = () => {
                                        if (closed || browserClosed || scope !== current || scope.abort.signal.aborted || operation.signal.aborted
                                            || nativeRun !== run || ownerId !== run.ownerId || run.generation !== operation.generation
                                            || page !== scope.page || page.isClosed() || accountProtocol !== protocol
                                            || !accountProtocolReady || !accountGate?.active) {
                                            throw new MicrosoftSessionError("cancelled");
                                        }
                                        if (Date.now() >= run.authDeadline) throw new MicrosoftSessionError("timed-out");
                                        if (sampledDocument !== scope.native.currentDocument || sampledEpoch !== run.documentEpoch
                                            || sampledUrl !== page.url()) throw sourceError("NATIVE_SIGNIN_ATTENTION_RETIRED");
                                    };
                                    try {
                                        assertAttention();
                                    }
                                    catch (error) {
                                        if (error.code === "NATIVE_SIGNIN_ATTENTION_RETIRED") continue;
                                        throw error;
                                    }
                                    engineering.humanNeeded(interaction);
                                }
                                scope.native.attendedInteraction = interaction;
                                console.info("[workiq-native] visible sign-in", JSON.stringify({ state: "waiting-for-user", interaction }));
                            }
                            continue;
                        }
                        if (state.kind === "app-signin-control" && !scope.signInClicked) {
                            const button = nativeSignInControl(page);
                            if (await button.count() !== 1) throw new MicrosoftSessionError("wrong-account");
                            scope.signInClicked = true; phase = "native-signin-invoked";
                            if (scope.native) scope.native.signInContext = scope.native.authorizationContext;
                            await button.click();
                        } else if (state.kind === "known-account-picker" && !scope.accountSelected) {
                            if (scope.native?.deviceRisk) {
                                const risk = scope.native.deviceRisk;
                                await nativeWait(scope, () => !risk.coveragePending
                                    && (!risk.childGate || risk.retired || risk.childGate.active && risk.childGate.pendingCount === 0)
                                    && [...risk.requests.values()].every(request => request.finished),
                                deviceRiskLimits.requestMs, "NATIVE_DEVICE_RISK_INCOMPLETE");
                            }
                            const button = knownAccountControl(page, expectedAccount);
                            if (await button.count() !== 1) throw new MicrosoftSessionError("wrong-account");
                            scope.accountSelected = true; phase = "known-account-selection-invoked";
                            if (scope.native) scope.native.accountSelectionContext = scope.native.authorizationContext;
                            await button.click();
                        } else if (normal ? ["app-shell-metadata-only", "app-home-metadata-only"].includes(state.kind)
                            : state.kind === (accountOnlyVerification ? "app-shell-metadata-only" : "app-home-metadata-only")) {
                            ready = true;
                            if (!accountOnlyVerification && !normal) break;
                        }
                        if (scope.native?.bootstrapSnapshot?.iteration === attempt + 1) scope.native.bootstrapSnapshot.appReady = ready;
                        if (normal && ready && nativeBuildKnown()) {
                            if (observeAuthenticationChain) throw sourceError("NATIVE_AUTH_CHAIN_OBSERVATION_COMPLETE");
                            const document = scope.native.currentDocument;
                            if (!document || document.epoch !== nativeRun.documentEpoch
                                || document.entry.responseStatus !== 200 || !document.entry.responseAcknowledged
                                || document.entry.terminal !== "finished") {
                                scope.native.bootstrapUnmet = "app-document-completion";
                                continue;
                            }
                            if (scope.native.document?.projectionPending) {
                                scope.native.bootstrapUnmet = "principal-projection";
                                continue;
                            }
                            scope.native.bootstrapUnmet = null;
                            if (scope.native.principal?.knownAccountMatched) break;
                        }
                    }
                    if (!ready || accountOnlyVerification || normal && (!scope.native.principal
                        || !scope.native.principal.knownAccountMatched || scope.native.bootstrapUnmet != null)) {
                        if (normal) scope.native.bootstrapUnmet ??= !ready ? "app-readiness"
                            : !scope.native.principal ? "principal-presence" : "known-account-match";
                        throw new MicrosoftSessionError(scope.native?.attended && Date.now() >= nativeRun.authDeadline
                            ? "timed-out" : "account-metadata-unavailable");
                    }
                };
                const verification = async (bootstrapCompleted = false) => {
                    if (normal && Date.now() >= verificationDeadline) throw new MicrosoftSessionError("timed-out");
                    if (!bootstrapCompleted) await bootstrap();
                    if (normal && Date.now() >= verificationDeadline) throw new MicrosoftSessionError("timed-out");
                    if (observeAuthenticationChain) throw sourceError("NATIVE_AUTH_CHAIN_OBSERVATION_COMPLETE");
                    if (normal) {
                        const principal = scope.native.principal;
                        if (principal.namespace !== nativeHistoryProducer.accountNamespace || principal.realm !== nativeHistoryProducer.realm) {
                            scope.native.bootstrapUnmet = principal.namespace !== nativeHistoryProducer.accountNamespace
                                ? "principal-namespace" : "principal-realm";
                            throw new MicrosoftSessionError("account-metadata-unavailable");
                        }
                        if (engineering) {
                            await runEngineeringHistory(scope, operation);
                            scope.observer.block();
                            scope.abort.abort();
                            nativeRun.principal = principal;
                            nativeRun.gateway = scope.native.gateway;
                            verified = true;
                            return { tenantId: principal.tenantId, subjectId: principal.subjectId, knownAccountMatched: true,
                                evidence: { kind: "native-account-metadata", issuer: principal.origin, observedAt: principal.observedAt,
                                    namespace: principal.namespace, realm: principal.realm } };
                        }
                        const accountProof = { tenantId: principal.tenantId, subjectId: principal.subjectId, knownAccountMatched: true,
                            ...(principal.presentation ? { presentation: principal.presentation } : {}),
                            evidence: { kind: "native-account-metadata", issuer: principal.origin, observedAt: principal.observedAt,
                                namespace: principal.namespace, realm: principal.realm } };
                        if (operation.needsNativeRouting?.(accountProof)) {
                            await openNativeHistory(scope, "cowork");
                            (scope.native.controlObserved ??= new Set()).add("cowork");
                            await nativeWait(scope, () => Boolean(scope.native.gateway && scope.native.lists.cowork),
                                15000, "NATIVE_SOURCE_ROUTING_IDENTITY_UNQUALIFIED");
                            await settleHistoryObservation(scope, "cowork");
                        }
                        await nativeWait(scope, () => accountGate?.active && accountGate.pendingCount === 0
                            && (!scope.native.deviceRisk?.childGate || scope.native.deviceRisk.retired || scope.native.deviceRisk.childGate.active
                                && scope.native.deviceRisk.childGate.pendingCount === 0) && !scope.native.deviceRisk?.coveragePending,
                            10000, "NATIVE_SOURCE_SETTLEMENT_UNQUALIFIED");
                        if (Date.now() >= verificationDeadline) throw new MicrosoftSessionError("timed-out");
                        const nativeRouting = nativeRoutingWitness(scope);
                        nativeRun.principal = principal;
                        nativeRun.gateway = scope.native.gateway;
                        nativeRun.initialDiscovery = scope.native.lists.cowork ? { ...scope.native.lists.cowork,
                            controlObserved: scope.native.controlObserved?.has("cowork") === true } : null;
                        verified = true;
                        return { ...accountProof,
                            evidence: { ...accountProof.evidence,
                                ...(nativeRouting ? { nativeRouting } : {}) } };
                    }
                    await scope.observer.beginPhase("identity", { signal: operation.signal });
                    scope.phase = "identity";
                    await page.goto(origin + "/cowork/#/task/" + target.coworkFragment, { waitUntil: "domcontentloaded" });
                    await waitFor(scope, () => Boolean(scope.identity), "NATIVE_IDENTITY_READ_INCOMPLETE");
                    await idle(scope);
                    if (scope !== current || operation.signal.aborted || browserClosed || page.isClosed() || !scope.accountMatched) {
                        throw new MicrosoftSessionError("cancelled");
                    }
                    verified = true;
                    return { tenantId: target.expectedTenant, subjectId: target.expectedSubject, knownAccountMatched: true,
                        evidence: { kind: "native-account-metadata", issuer: scope.identity.origin, observedAt: scope.identity.observedAt } };
                };
                if (accountOnlyVerification) {
                    const cancelled = new Promise((_, reject) => {
                        abort = () => reject(scope.error ?? new MicrosoftSessionError("cancelled"));
                        scope.abort.signal.addEventListener("abort", abort, { once: true });
                    });
                    return await Promise.race([verification(), cancelled]);
                } else if (normal && engineering) {
                    let timer;
                    try {
                        await Promise.race([bootstrap(), new Promise((_, reject) => {
                            timer = setTimeout(() => reject(new MicrosoftSessionError("timed-out")), Math.max(1, verificationDeadline - Date.now()));
                        })]);
                    } finally { clearTimeout(timer); }
                    return await verification(true);
                } else if (normal) {
                    let timer;
                    try {
                        return await Promise.race([verification(), new Promise((_, reject) => {
                            timer = setTimeout(() => reject(new MicrosoftSessionError("timed-out")),
                                Math.max(1, verificationDeadline - Date.now()));
                        })]);
                    } finally { clearTimeout(timer); }
                }
                return await verification();
            } catch (error) {
                if (scope.error) error = scope.error;
                else if (scope.controlFailure) error = scope.controlFailure;
                else if (operation.signal.aborted) error = new MicrosoftSessionError("cancelled");
                if (normal) accountGate?.preserveCapacityTimeout(scope, error);
                if (accountObservation) {
                    const predicate = accountObservation.failurePredicate();
                    withNativeFailurePredicate(error, "connect", predicate);
                    scope.native.bootstrapUnmet = predicate;
                    scope.native.bootstrapBranch = accountObservation.bootstrapBranch();
                }
                originalFailure = error;
                if (engineering) recordNativeEngineeringFailure(engineering, error);
                if (accountOnlyVerification || normal) scope.terminalOutcome ??= { outcome: "unverified",
                    reason: error instanceof MicrosoftSessionError ? error.code : "transport-failed" };
                if (normal) scope.native.bootstrapTerminal ??= {
                    reason: nativeErrorCode(error),
                    unmetPrerequisite: scope.native.bootstrapUnmet ?? null,
                    snapshotCurrentAtStop: scope.native.bootstrapSnapshot ? scope === current && !scope.abort.signal.aborted
                        && scope.native.bootstrapSampleDocument === scope.native.currentDocument
                        && scope.native.bootstrapSnapshot.epoch === nativeRun.documentEpoch : null,
                    lastValidSnapshot: scope.native.bootstrapSnapshot ?? null,
                };
                if (normal) {
                    scope.abort.abort();
                    scope.observer.block();
                    try {
                        await operation.recordFailure({
                            ...nativeFailureDetails(error, "connect"),
                            ...(scope.native.faviconFailure ? { faviconFailure: scope.native.faviconFailure } : {}),
                            ...(scope.native.authorizationReentry?.applicationComparison
                                ? { applicationComparison: scope.native.authorizationReentry.applicationComparison } : {}),
                        });
                    } catch (recordError) {
                        console.error("[workiq-native] original connection failure evidence unavailable", { code: nativeErrorCode(recordError) });
                    }
                }
                throw error;
            } finally {
                if (abort) scope.abort.signal.removeEventListener("abort", abort);
                try {
                    if (normal && scope.recordHistory && scope.native.historyObservations.size) {
                        await scope.recordHistory([...scope.native.historyObservations.values()].map(row => row.value));
                    }
                } catch (error) {
                    if (!originalFailure) throw error;
                    console.error("[workiq-native] original history observation unavailable", { code: nativeErrorCode(error) });
                } finally { await release(scope); }
            }
        },
        async background(operation) {
            if (engineering) return;
            if (!normal || !nativeRun?.attended) return;
            const run = nativeRun, ownedPage = page, protocol = accountProtocol;
            const documentEpoch = run.documentEpoch, continuityVersion = run.continuityVersion;
            const assertCurrent = () => {
                operation.assertCurrent();
                if (run !== nativeRun || !verified || current || closed || browserClosed || !ownedPage || ownedPage.isClosed()
                    || page !== ownedPage || operation.ownerId !== ownerId || ownerId !== run.ownerId
                    || run.generation !== operation.generation || run.documentEpoch !== documentEpoch
                    || run.continuityVersion !== continuityVersion || !protocol || protocol !== accountProtocol
                    || !accountProtocolReady || !browserOwnedSignIn() && !accountGate?.active || Date.now() >= run.deadline
                    || Date.now() >= run.authDeadline) throw sourceError("NATIVE_WINDOW_BACKGROUND_UNQUALIFIED");
            };
            assertCurrent();
            const { windowId, bounds } = await protocol.send("Browser.getWindowForTarget");
            assertCurrent();
            if (!Number.isSafeInteger(windowId) || windowId < 0 || !bounds
                || !["normal", "minimized", "maximized", "fullscreen"].includes(bounds.windowState)) {
                throw sourceError("NATIVE_WINDOW_BACKGROUND_UNQUALIFIED");
            }
            const acknowledgement = await protocol.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
            assertCurrent();
            if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)
                || Object.keys(acknowledgement).length) throw sourceError("NATIVE_WINDOW_BACKGROUND_UNQUALIFIED");
            const observed = await protocol.send("Browser.getWindowForTarget");
            assertCurrent();
            if (observed.windowId !== windowId || observed.bounds?.windowState !== "minimized") {
                throw sourceError("NATIVE_WINDOW_BACKGROUND_UNQUALIFIED");
            }
        },
        async stop(operation) {
            const accountObservation = browserAccount, ownedContext = browserClosed ? null : browser, scope = current;
            const clientReader = nativeRun?.sessionReader;
            const toolGuard = nativeRun?.toolGuard;
            browserAccount = null;
            revokeAppDocumentContinuity();
            epoch++;
            verified = false;
            scope?.abort.abort();
            scope?.observer.close();
            try {
                await closeNativeBrowserContext(ownedContext, async () => {
                    try { await accountObservation?.retire(); }
                    catch (error) {
                        console.error("[workiq-native] closing owner after account staging retirement failed", { code: nativeErrorCode(error) });
                    }
                    await clientReader?.retire();
                    await toolGuard?.retire();
                    if (accountOnlyVerification || normal) await release(scope);
                });
            } finally {
                // Keep the gate attached until the owned context is confirmed closed.
                if (browserClosed) { accountGate?.retire(); accountGate = null; accountProtocol = null; accountProtocolReady = false; }
            }
            await release(scope);
            await Promise.allSettled([...pending]);
            current = null;
            if (attemptedOwner === operation.ownerId && !ownerId && !browser && !openings) {
                attemptedOwner = null; page = null;
                return { processExited: true, profileReleased: true };
            }
            if (!configuration) return { processExited: false, profileReleased: false };
            const directory = await realpath(configuration.profileDirectory);
            const owners = await profileOwners(directory);
            // A launch that has not settled can still create the profile owner.
            if (ownerId && !openings) {
                if (lock) { await lock.close(); lock = null; }
                const held = JSON.parse(await readFile(configuration.ownerLockPath, "utf8"));
                if (held.pid !== process.pid || held.owner !== ownerId || held.profile !== directory || owners.length) {
                    throw new MicrosoftSessionError("cleanup-failed");
                }
                await unlink(configuration.ownerLockPath);
                ownerId = null;
            }
            if (!openings) { browser = null; page = null; attemptedOwner = null; }
            return { processExited: owners.length === 0 && openings === 0, profileReleased: owners.length === 0
                && openings === 0 && !existsSync(configuration.ownerLockPath) };
        },
    });
    async function prepareBrowserCollection(scope) {
        await lifecycle.assertLease(scope.lease);
        if (scope !== current || scope.abort.signal.aborted || browser.pages().some(item => item !== page)) {
            throw sourceError("NATIVE_SOURCE_PAGE_COVERAGE");
        }
        // End the browser-owned app document before installing collection-only
        // controls. No pending login request is handed into the evidence gate.
        await page.goto("about:blank", { waitUntil: "load" });
        await lifecycle.assertLease(scope.lease);
        await browserAccount.retire(); browserAccount = null;
        await accountProtocol.detach();
        accountProtocol = null; accountProtocolReady = false;
        nativeRun.collectionPrepared = true;
        await installCaptureBinding();
        await browser.addInitScript({ content: captureScript });
        await browser.routeWebSocket("**/*", socket => socket.close());
        await browser.route("**/*", routeOriginal);
        await guardNativePage(page);
        if (!accountGate.beginCollection(scope)) throw sourceError("NATIVE_SOURCE_SETTLEMENT_UNQUALIFIED");
        await scope.observer.beginPhase("native-collection-bootstrap", { lease: scope.lease });
        scope.phase = "native-collection-bootstrap";
        await lifecycle.assertLease(scope.lease);
        await page.goto(nativeApplicationEntry, { waitUntil: "domcontentloaded" });
        await nativeWait(scope, () => Boolean(scope.native.principal?.knownAccountMatched
            && nativeBuildKnown() && scope.native.currentDocument?.entry.terminal === "finished"
            && scope.pending.size === 0 && accountGate?.active && accountGate.pendingCount === 0),
        15000, "NATIVE_SOURCE_PROVENANCE_UNQUALIFIED");
        await lifecycle.assertLease(scope.lease);
        nativeRun.principal = scope.native.principal;
    }
    async function acquireSessionHistory(lease, collection, recordFailure, previousBackfill, operation) {
        const run = nativeRun;
        await lifecycle.assertLease(lease);
        if (run?.collectionPrepared) {
            await lifecycle.expire(lease);
            throw sourceError("NATIVE_COWORK_CLIENT_SOURCE_SWITCH_RECONNECT");
        }
        if (run?.sessionReader && JSON.stringify(run.sessionReader.surfaces) !== JSON.stringify([...collection.surfaces].sort())) {
            await lifecycle.expire(lease);
            throw sourceError("NATIVE_CLIENT_SOURCE_SWITCH_RECONNECT");
        }
        if (!run || run.collectionPrepared || run !== nativeRun || current || !verified || !browser || browserClosed
            || run.collections && run.lastCommit !== "committed") throw sourceError("NATIVE_COWORK_CLIENT_OWNER_UNAVAILABLE");
        run.collections++;
        run.lastCommit = null;
        run.deadline = Math.min(operation?.deadline ?? Infinity, Date.now() + 300000);
        const scope = newScope(page, lease);
        scope.clientRead = true;
        scope.native.window = previousBackfill?.window ?? nativeHistoryWindow({ windowDays: collection.settings.windowDays });
        scope.recordFailure = recordFailure;
        leaseScopes.set(lease, scope);
        const identity = transport.accountFor(lease);
        const principal = { namespace: identity.namespace, realm: identity.realm,
            tenantId: identity.account.tenantId, subjectId: identity.account.subjectId };
        const assertOwner = () => {
            if (run !== nativeRun || run.ownerId !== ownerId || !verified || closed || browserClosed
                || run.generation !== lease.generation) throw sourceError("NATIVE_COWORK_CLIENT_OWNER_UNAVAILABLE");
        };
        try {
            if (typeof operation?.operationId !== "string") throw sourceError("NATIVE_COWORK_CLIENT_OPERATION_UNQUALIFIED");
            run.sessionReader ??= await openMicrosoftSessionBrowserHost({
                browser, page, principal, deadline: run.deadline, signal: scope.abort.signal,
                toolGuard: run.toolGuard,
                surfaces: collection.surfaces,
                assertOwner, assertLease: () => lifecycle.assertLease(lease),
                observeDocument: observeBrowserAccountDocument,
                async beforeReload() {
                    await browserAccount?.retire();
                    browserAccount = null;
                    await accountProtocol?.detach();
                    accountProtocol = null;
                    accountProtocolReady = false;
                },
                openCowork: () => clickNativeHistoryLink(page, { surface: "cowork",
                    tenantId: principal.tenantId, subjectId: principal.subjectId }),
                onFailure(error) {
                    if (run !== nativeRun) return;
                    if (current?.clientRead) nativeFailure(current, error);
                    else nativeOwnerLost(run, error.code, error.publicCoworkScript);
                },
            });
            await run.sessionReader.begin(run.deadline, { signal: scope.abort.signal,
                assertLease: () => lifecycle.assertLease(lease), operationId: operation.operationId });
            return await acquireMicrosoftSession({ lifecycle, transport, lease, collection,
                reader: run.sessionReader, previousBackfill, recordFailure, counts: scope.native.counts });
        } catch (error) {
            if (!scope.error) nativeFailure(scope, error);
            await recordFailure?.(error);
            throw error;
        }
    }
    async function acquire(lease, collection, recordFailure, previousBackfill, operation, recoveringRead = false) {
        if (!configuration || !verified || !browser || browserClosed || current) throw sourceError("NATIVE_CONNECTION_REQUIRED");
        if (!collection || collection.settings?.paused || !Array.isArray(collection.surfaces) || !collection.surfaces.length
            || collection.surfaces.some(surface => !["chat", "cowork"].includes(surface))) throw sourceError("NATIVE_COLLECTION_CONFIGURATION_REQUIRED");
        if (normal && ordinaryStartup && browserOwnedSignIn()) {
            return acquireSessionHistory(lease, collection, recordFailure, previousBackfill, operation);
        }
        if (nativeRun?.sessionReader) {
            await lifecycle.expire(lease);
            throw sourceError("NATIVE_COWORK_CLIENT_SOURCE_SWITCH_RECONNECT");
        }
        const admittedRun = nativeRun;
        await lifecycle.assertLease(lease);
        if (normal) {
            if (!admittedRun || admittedRun !== nativeRun || !verified || !browser || browserClosed || closed || current) {
                throw sourceError("NATIVE_CONNECTION_REQUIRED");
            }
            if (!recoveringRead && nativeRun.collections && nativeRun.lastCommit !== "committed") throw sourceError("NATIVE_SOURCE_COMMIT_UNCONFIRMED");
            if (!recoveringRead && nativeRun.collections++) {
                nativeRun.counts.clear();
                nativeRun.bodyBytes = 0;
                nativeRun.recordCount = 0;
            }
            nativeRun.lastCommit = null;
            if (!recoveringRead) nativeRun.deadline = Date.now() + 300000;
        }
        const backfill = normal ? createNativeBackfill(lease.partition, collection.settings.windowDays,
            collection.surfaces, collection.privacyRevision, previousBackfill, Date.now(), previousBackfill?.deletionVersion ?? 0) : null;
        const continuation = normal ? nativeRun.discoveryCarry : null;
        let binding;
        const firstBrowserCollection = browserOwnedSignIn() && !nativeRun.collectionPrepared;
        try { binding = normal && !firstBrowserCollection ? await claimAppDocumentContinuity(lease) : null; }
        catch (error) {
            if (normal) revokeAppDocumentContinuity();
            if (backfill && recordFailure) {
                for (const source of backfill.sources) {
                    source.startQualified = false;
                    if (!source.stops.includes("continuity-lost")) source.stops.push("continuity-lost");
                }
                await recordFailure(error, attachNativeBackfill([], backfill));
            }
            throw error;
        }
        if (normal) nativeRun.discoveryCarry = null;
        const scope = newScope(normal ? page : await freshPage(), lease, binding);
        scope.recordFailure = recordFailure ? error => {
            if (backfill) {
                const source = backfill.sources.find(row => row.surface === scope.native.collectingSurface);
                if (source) {
                    const observation = scope.native.historyObservations.get(source.surface)?.value;
                    if (observation) {
                        if (scope.native.historyOwnerRevoked || scope.operationSignal?.aborted) observation.association.state = "owner-lost";
                        source.observation = structuredClone(observation);
                    }
                    const history = source.histories.find(row => row.key === scope.native.collectingHistory);
                    if (history) history.state = "unreadable";
                    const stop = scope.native.backfillBudget ?? (history ? "unreadable-history" : "continuity-lost");
                    if (!source.stops.includes(stop)) {
                        source.stops.push(stop);
                    }
                }
            }
            return recordFailure(error, backfill ? attachNativeBackfill([], backfill) : undefined);
        } : null;
        scope.recordControlFailure = scope.recordFailure;
        const chatCaptures = [], coworkCaptures = [];
        leaseScopes.set(lease, scope);
        try {
            if (normal) {
                if (firstBrowserCollection) {
                    scope.native.bootstrapSurfaces = [...collection.surfaces];
                    await prepareBrowserCollection(scope);
                } else if (browserOwnedSignIn() && !accountGate?.beginCollection(scope)) {
                    throw sourceError("NATIVE_SOURCE_SETTLEMENT_UNQUALIFIED");
                }
                scope.native.window = backfill.window;
                scope.native.liveWindow = nativeHistoryWindow({ windowDays: collection.settings.windowDays });
                const settingsKey = JSON.stringify([collection.settings.windowDays, [...collection.surfaces].sort(), collection.privacyRevision,
                    backfill.deletionVersion ?? 0]);
                if (nativeRun.processedWindow !== settingsKey) {
                    nativeRun.processed.clear();
                    nativeRun.waitingHistories.clear();
                    nativeRun.processedWindow = settingsKey;
                }
                for (const [key, activity] of nativeRun.processed) {
                    if (activity < Date.parse(scope.native.window.from)) nativeRun.processed.delete(key);
                }
                const initialDiscovery = nativeRun.deletionVersion === (backfill.deletionVersion ?? 0) ? nativeRun.initialDiscovery : null;
                nativeRun.initialDiscovery = null;
                if (initialDiscovery) {
                    scope.native.gateway = nativeRun.gateway;
                    scope.native.lists.cowork = initialDiscovery;
                }
                const carry = continuation && continuation.pageUrl === scope.page.url()
                    && continuation.epoch === nativeRun.documentEpoch && continuation.settingsKey === settingsKey
                    && continuation.window.to === backfill.window.to && continuation.window.from === backfill.window.from
                    ? continuation : null;
                const order = carry ? [carry.surface, ...["chat", "cowork"].filter(surface => surface !== carry.surface)]
                    : initialDiscovery || nativeRun.collections === 1 ? ["cowork", "chat"] : ["chat", "cowork"];
                const phases = new Map();
                const phase = async name => {
                    await nativeWait(scope, () => accountGate?.active && accountGate.pendingCount === 0 && scope.pending.size === 0,
                        10000, "NATIVE_SOURCE_SETTLEMENT_UNQUALIFIED");
                    const until = Math.min(Date.now() + 10000, nativeRun.deadline);
                    for (;;) {
                        await lifecycle.assertLease(lease);
                        const ready = await scope.page.evaluate(name =>
                            typeof window[name] === "function" ? window[name]() : null, captureResetBinding);
                        if (ready === true) break;
                        if (ready !== false || Date.now() >= until) throw sourceError("NATIVE_CHAT_CAPTURE_BINDING_UNQUALIFIED");
                        const next = Date.now() + 25;
                        await nativeWait(scope, () => Date.now() >= next, 1000, "NATIVE_SOURCE_SETTLEMENT_UNQUALIFIED");
                    }
                    const iteration = phases.get(name) ?? 0;
                    await scope.observer.beginPhase(name, { lease, iteration });
                    phases.set(name, iteration + 1);
                    scope.phase = name;
                    scope.native.observed.clear(); scope.native.protocolCounts.clear();
                    scope.native.protocolEntries.clear(); scope.native.queryBindings.clear();
                    await lifecycle.assertLease(lease);
                };
                const discover = async (surface, retained = false) => {
                    await phase(surface + "-discovery");
                    scope.native.collectingSurface = surface;
                    scope.native.collectingHistory = null;
                    scope.native.continuingDiscovery = null;
                    const continuing = carry?.surface === surface && !scope.native.usedCarry;
                    const source = backfill.sources.find(row => row.surface === surface);
                    scope.native.backfillSource = source;
                    if (continuing) {
                        scope.native.usedCarry = true;
                        scope.native.continuingDiscovery = surface;
                        scope.native.lists[surface] = carry.list;
                        scope.native.gateway = surface === "cowork" ? carry.gateway : null;
                        if (carry.queryBinding) scope.native.queryBindings.set(surface + "-list", carry.queryBinding);
                    } else if (retained) {
                        source.startQualified = false;
                        scope.native.continuingDiscovery = surface;
                        const queryBinding = scope.native.lists[surface]?.queryBinding;
                        if (queryBinding) scope.native.queryBindings.set(surface + "-list", queryBinding);
                    } else if (!retained) {
                        source.startQualified = false;
                        delete scope.native.lists[surface];
                        if (scope.native.discoveryInitial) delete scope.native.discoveryInitial[surface];
                        await openNativeHistory(scope, surface);
                        (scope.native.controlObserved ??= new Set()).add(surface);
                    }
                    await nativeWait(scope, () => Boolean(scope.native.lists[surface]), 15000, "NATIVE_SOURCE_DISCOVERY_UNQUALIFIED");
                    await nativeWait(scope, () => accountGate?.active && accountGate.pendingCount === 0 && scope.pending.size === 0
                        && (surface !== "chat" || !nativeHistoryBuildKnown()
                            || !scope.native.currentDocument?.historyToken || scope.native.currentDocument.historySettled),
                        15000, "NATIVE_SOURCE_SETTLEMENT_UNQUALIFIED");
                    await settleHistoryObservation(scope, surface);
                    const idKey = surface === "chat" ? "conversationId" : "sessionId";
                    const cursors = continuing ? new Set(carry.cursors) : new Set();
                    const merge = () => {
                        const list = scope.native.lists[surface];
                        source.controlObserved ||= list.controlObserved || scope.native.controlObserved?.has(surface) === true;
                        if (surface === "chat") source.startQualified = list.startQualified === true;
                        if (!source.exhausted || ["empty", "null"].includes(list.continuation.state)) {
                            source.initial = list.initial;
                            source.chain = list.chain;
                            source.chainPages = list.chainPages;
                            if (list.observation) source.observation = structuredClone(list.observation);
                        }
                        source.pages = [...new Set([...source.pages, ...list.pages])];
                        const histories = new Map(source.histories.map(row => [row.key, row]));
                        const otherHistories = backfill.sources.filter(row => row !== source).reduce((count, row) => count + row.histories.length, 0);
                        for (const item of list.items) {
                            if (!Number.isSafeInteger(item.lastActivity)) throw sourceError("NATIVE_SOURCE_DISCOVERY_TIME_UNQUALIFIED");
                            if (item.lastActivity < Date.parse(backfill.window.from)) continue;
                            const key = hash(JSON.stringify([surface, item[idKey]])), previous = histories.get(key);
                            if (!previous && histories.size + otherHistories >= NATIVE_BACKFILL_LIMIT) {
                                if (!source.stops.includes("membership-budget")) source.stops.push("membership-budget");
                                continue;
                            }
                            histories.set(key, previous ? { ...previous, activity: item.lastActivity,
                                state: previous.handledActivity === item.lastActivity ? previous.state
                                    : previous.state === "unreadable" ? "unreadable" : "pending" }
                                : { key, activity: item.lastActivity, handledActivity: null, handledThrough: null, state: "pending" });
                        }
                        source.histories = [...histories.values()];
                        if (source.pages.length > NATIVE_BACKFILL_LIMIT) throw sourceError("NATIVE_SOURCE_DISCOVERY_LIMIT");
                    };
                    merge();
                    while (scope.native.lists[surface].continuation.state === "present") {
                        const list = scope.native.lists[surface], cursor = list.continuation.value;
                        if ((surface === "cowork" ? nativeRun.counts.get("cowork-list") ?? 0
                            : (scope.native.protocolCounts.get(surface + "-list") ?? 0) + Number(retained && !continuing)) >= 16
                            || nativeRun.deadline - Date.now() < 25000) {
                            const reason = nativeRun.deadline - Date.now() < 25000 ? "time-budget" : "page-budget";
                            if (!source.stops.includes(reason)) source.stops.push(reason);
                            scope.native.discoveryBudgetTurns ??= new Map();
                            if (!scope.native.discoveryBudgetTurns.has(surface)) {
                                const nextTurn = nativeRun.discoveryYieldTurn.get(surface) === true;
                                nativeRun.discoveryYieldTurn.set(surface, !nextTurn);
                                scope.native.discoveryBudgetTurns.set(surface, nextTurn);
                            }
                            const forceYield = continuing || scope.native.discoveryBudgetTurns.get(surface);
                            scope.native.nextDiscovery = { surface, list, cursors: [...cursors], pageUrl: scope.page.url(),
                                epoch: nativeRun.documentEpoch, settingsKey, window: { ...backfill.window },
                                gateway: surface === "cowork" ? scope.native.gateway : null,
                                queryBinding: scope.native.queryBindings.get(surface + "-list") ?? null, forceYield };
                            break;
                        }
                        const cursorKey = hash(cursor);
                        const tail = surface === "chat" ? list.pageTail : list.items.at(-1)?.[idKey];
                        if (cursors.has(cursorKey) || cursors.size >= NATIVE_BACKFILL_LIMIT || !tail) throw sourceError("NATIVE_SOURCE_DISCOVERY_LIMIT");
                        cursors.add(cursorKey);
                        await clickNativeHistoryLink(scope.page, { surface, id: tail,
                            tenantId: nativeRun.principal.tenantId, subjectId: nativeRun.principal.subjectId, revealOnly: true,
                            ...(surface === "cowork" ? { taskRows: nativeCoworkRowGuard(scope) } : {}) });
                        await nativeWait(scope, () => scope.native.lists[surface] !== list, 15000, "NATIVE_SOURCE_PAGING_UNQUALIFIED");
                        merge();
                    }
                    if (!["empty", "null", "present"].includes(scope.native.lists[surface].continuation.state)) {
                        throw sourceError("NATIVE_SOURCE_CONTINUATION_UNQUALIFIED");
                    }
                    source.exhausted ||= !source.stops.includes("membership-unqualified")
                        && ["empty", "null"].includes(scope.native.lists[surface].continuation.state);
                    await nativeWait(scope, () => nativeBuildKnown(surface), 5000, "NATIVE_SOURCE_BUILD_UNQUALIFIED");
                    return scope.native.lists[surface].items;
                };
                const discoverCoworkMembership = async initial => {
                    if (!nativeCoworkBuild()?.automationDetailsScriptAsset) return initial;
                    const source = backfill.sources.find(row => row.surface === "cowork");
                    source.startQualified = false;
                    source.exhausted = false;
                    if (!source.stops.includes("membership-unqualified")) source.stops.push("membership-unqualified");
                    const checkpoint = source.coworkCursor ??= { parentAfter: null, referenceAfter: null };
                    const resumed = carry?.membership && !scope.native.usedCarry ? carry : null;
                    const rows = new Map((resumed?.membership.items ?? initial).map(item => [item.sessionId, item]));
                    const references = new Map((resumed?.membership.references ?? []).map(item => [item.sessionId, item]));
                    const assertCurrent = () => {
                        if (scope !== current || nativeRun !== admittedRun || !verified || browserClosed || closed
                            || scope.abort.signal.aborted || scope.operationSignal?.aborted || Date.now() >= nativeRun.deadline) {
                            throw scope.error ?? sourceError("NATIVE_SOURCE_CANCELLED");
                        }
                        if (scope.error) throw scope.error;
                    };
                    const waitForChange = async (ready, milliseconds = 15000) => {
                        const until = Math.min(Date.now() + milliseconds, nativeRun.deadline);
                        await nativeWait(scope, () => ready() || Date.now() >= until, milliseconds + 100,
                            "NATIVE_COWORK_MEMBERSHIP_UNQUALIFIED");
                        return ready();
                    };
                    const rotate = (values, after, key) => {
                        const index = values.findIndex(value => key(value) === after);
                        return index < 0 ? values : [...values.slice(index + 1), ...values.slice(0, index + 1)];
                    };
                    const parentKey = parent => hash(JSON.stringify([parent.kind, parent.id]));
                    scope.native.collectingSurface = "cowork";
                    scope.native.collectingHistory = null;
                    scope.native.backfillSource = source;
                    await phase("cowork-membership");
                    let parents;
                    if (resumed) {
                        scope.native.usedCarry = true;
                        scope.native.automationParents = resumed.membership.parents;
                        scope.native.gateway = resumed.gateway;
                        scope.native.lists.cowork = resumed.list;
                        scope.native.coworkPopulations.set(resumed.list.population, resumed.list);
                        if (resumed.queryBinding) scope.native.queryBindings.set("cowork-list:" + JSON.stringify(resumed.list.population), resumed.queryBinding);
                        parents = [resumed.membership.parent];
                    } else {
                        await lifecycle.assertLease(lease);
                        await openNativeCoworkAutomations(scope.page, nativeRun.coworkEntry, assertCurrent);
                        await nativeWait(scope, () => scope.native.automationParents !== null, 15000,
                            "NATIVE_COWORK_MEMBERSHIP_UNQUALIFIED");
                        parents = rotate(scope.native.automationParents.filter(parent => ["scheduled", "event"].includes(parent.kind)),
                            checkpoint.parentAfter, parentKey).slice(0, 4);
                    }
                    for (const parent of parents) {
                        if ((nativeRun.counts.get("cowork-list") ?? 0) >= 16 || nativeRun.deadline - Date.now() < 25000
                            || nativeRun.bodyBytes > 12 * 1024 * 1024) {
                            const reason = nativeRun.deadline - Date.now() < 25000 ? "time-budget"
                                : nativeRun.bodyBytes > 12 * 1024 * 1024 ? "byte-budget" : "page-budget";
                            if (!source.stops.includes(reason)) source.stops.push(reason);
                            break;
                        }
                        const population = parent.kind === "scheduled" ? "scheduled_run" : "automation_run";
                        let expectsRuns = true;
                        scope.native.expectedCoworkPopulation = population;
                        if (!resumed) {
                            await phase("cowork-membership");
                            scope.native.continuingDiscovery = null;
                            delete scope.native.lists.cowork;
                            delete scope.native.discoveryInitial?.cowork;
                            await lifecycle.assertLease(lease);
                            await openNativeCoworkAutomations(scope.page, nativeRun.coworkEntry, assertCurrent);
                            await openNativeCoworkParent(scope.page, parent, assertCurrent);
                            const key = (parent.kind === "scheduled" ? "cowork-schedule:" : "cowork-trigger:") + parent.id;
                            await nativeWait(scope, () => scope.native.automationDetails.has(key), 15000,
                                "NATIVE_COWORK_MEMBERSHIP_UNQUALIFIED");
                            const detail = scope.native.automationDetails.get(key);
                            const membership = coworkParentReferences(parent, detail, nativeRun.principal);
                            expectsRuns = detail !== null && (parent.kind === "scheduled" || Object.hasOwn(detail, "recent_fires"));
                            for (const reference of membership.references) references.set(reference.sessionId, reference);
                        } else scope.native.continuingDiscovery = "cowork";
                        // A cached native view or an unavailable parent is not an empty run population.
                        if (expectsRuns) await waitForChange(() => scope.native.lists.cowork?.population === population);
                        const cursors = new Set(resumed?.cursors ?? []);
                        let list = scope.native.lists.cowork;
                        while (list?.population === population) {
                            for (const item of list.items) {
                                const previous = rows.get(item.sessionId);
                                if (!previous || item.lastActivity > previous.lastActivity) rows.set(item.sessionId, item);
                            }
                            source.pages = [...new Set([...source.pages, ...list.pages])];
                            if (list.continuation.state !== "present") break;
                            if ((nativeRun.counts.get("cowork-list") ?? 0) >= 16 || nativeRun.deadline - Date.now() < 25000
                                || nativeRun.bodyBytes > 12 * 1024 * 1024) {
                                const reason = nativeRun.deadline - Date.now() < 25000 ? "time-budget"
                                    : nativeRun.bodyBytes > 12 * 1024 * 1024 ? "byte-budget" : "page-budget";
                                if (!source.stops.includes(reason)) source.stops.push(reason);
                                scope.native.nextDiscovery = { surface: "cowork", list, cursors: [...cursors], pageUrl: scope.page.url(),
                                    epoch: nativeRun.documentEpoch, settingsKey, window: { ...backfill.window },
                                    gateway: scope.native.gateway, queryBinding: list.queryBinding,
                                    forceYield: true, membership: { parent, parents: scope.native.automationParents,
                                        items: [...rows.values()], references: [...references.values()] } };
                                break;
                            }
                            const cursorKey = hash(list.continuation.value);
                            if (cursors.has(cursorKey)) throw sourceError("NATIVE_SOURCE_CONTINUATION_UNQUALIFIED");
                            cursors.add(cursorKey);
                            await lifecycle.assertLease(lease);
                            const result = await revealNativeCoworkRuns(scope.page, assertCurrent);
                            if (result === "unavailable" || !await waitForChange(() => scope.native.lists.cowork !== list)) break;
                            list = scope.native.lists.cowork;
                        }
                        if (scope.native.nextDiscovery?.membership) break;
                        checkpoint.parentAfter = parentKey(parent);
                    }
                    scope.native.expectedCoworkPopulation = undefined;
                    for (const list of scope.native.coworkPopulations.values()) {
                        for (const item of list.items) {
                            const previous = rows.get(item.sessionId);
                            if (!previous || item.lastActivity > previous.lastActivity) rows.set(item.sessionId, item);
                        }
                        source.pages = [...new Set([...source.pages, ...list.pages])];
                    }
                    source.pages = [...new Set([...source.pages, ...scope.native.membershipPages])];
                    if (source.pages.length > NATIVE_BACKFILL_LIMIT
                        || new Set([...rows.keys(), ...references.keys()]).size > NATIVE_BACKFILL_LIMIT) {
                        throw sourceError("NATIVE_SOURCE_DISCOVERY_LIMIT");
                    }
                    const histories = new Map(source.histories.map(row => [row.key, row]));
                    const otherCount = backfill.sources.filter(row => row !== source).reduce((count, row) => count + row.histories.length, 0);
                    for (const item of rows.values()) {
                        if (!Number.isSafeInteger(item.lastActivity)) throw sourceError("NATIVE_SOURCE_DISCOVERY_TIME_UNQUALIFIED");
                        if (item.lastActivity < Date.parse(backfill.window.from)) continue;
                        const key = hash(JSON.stringify(["cowork", item.sessionId])), previous = histories.get(key);
                        if (!previous && histories.size + otherCount >= NATIVE_BACKFILL_LIMIT) {
                            if (!source.stops.includes("membership-budget")) source.stops.push("membership-budget");
                            continue;
                        }
                        histories.set(key, previous ? { ...previous, activity: item.lastActivity,
                            state: previous.handledActivity === item.lastActivity ? previous.state : "pending" }
                            : { key, activity: item.lastActivity, handledActivity: null, handledThrough: null, state: "pending" });
                    }
                    source.histories = [...histories.values()];
                    let remaining = NATIVE_BACKFILL_LIMIT - histories.size - otherCount;
                    const undated = rotate([...references.values()].filter(reference => !rows.has(reference.sessionId)),
                        checkpoint.referenceAfter, reference => hash(reference.sessionId))
                        .filter(reference => {
                            if (histories.has(hash(JSON.stringify(["cowork", reference.sessionId])))) return true;
                            if (remaining-- > 0) return true;
                            if (!source.stops.includes("membership-budget")) source.stops.push("membership-budget");
                            return false;
                        })
                        .map(reference => ({ sessionId: reference.sessionId, lastActivity: null }));
                    scope.native.coworkMembershipRead = true;
                    return [...rows.values(), ...undated];
                };
                scope.native.processed = [];
                scope.native.undatedProcessed = [];
                scope.native.selectedHistories = [];
                const unqualifiedHistoryKeys = new Set();
                scope.native.unqualifiedHistoryKeys = unqualifiedHistoryKeys;
                for (const surface of order.filter(value => collection.surfaces.includes(value))) {
                    const priorSource = backfill.sources.find(row => row.surface === surface);
                    const stop = nativeRun.deadline - Date.now() < 25000 ? "time-budget"
                        : nativeRun.bodyBytes > 12 * 1024 * 1024 ? "byte-budget" : null;
                    if (stop) { if (!priorSource.stops.includes(stop)) priorSource.stops.push(stop); break; }
                    let items = surface === "cowork" && carry?.membership ? []
                        : await discover(surface, surface === "cowork" && initialDiscovery
                            && /^\/(?:hwav2\/)?cowork\/?$/.test(new URL(scope.page.url()).pathname));
                    if (surface === "cowork" && (!scope.native.nextDiscovery || carry?.membership)) {
                        items = await discoverCoworkMembership(items);
                    }
                    if (items.some(item => !Number.isSafeInteger(item.lastActivity)
                        && !(surface === "cowork" && scope.native.coworkMembershipRead && item.lastActivity === null))) {
                        throw sourceError("NATIVE_SOURCE_DISCOVERY_TIME_UNQUALIFIED");
                    }
                    const idKey = surface === "chat" ? "conversationId" : "sessionId";
                    const keyFor = item => `${collection.settings.windowDays}:${surface}:${item[idKey]}`;
                    const source = backfill.sources.find(row => row.surface === surface);
                    const histories = new Map(source.histories.map(row => [row.key, row]));
                    const historyFor = item => histories.get(hash(JSON.stringify([surface, item[idKey]])));
                    for (const item of items) {
                        const prior = historyFor(item);
                        if (prior && ["handled", "suppressed"].includes(prior.state) && prior.handledActivity === item.lastActivity
                            && item.lastActivity <= prior.handledThrough) {
                            nativeRun.processed.set(keyFor(item), item.lastActivity);
                        } else nativeRun.processed.delete(keyFor(item));
                    }
                    const continuationAnchor = !(surface === "cowork" && scope.native.coworkMembershipRead) && scope.native.lists[surface].continuation.state === "present"
                        ? surface === "chat" ? scope.native.lists[surface].pageTail : items.at(-1)?.[idKey] : null;
                    const tracked = new Set(source.histories.map(row => row.key));
                    const eligible = items.filter(item => (item.lastActivity === null || item.lastActivity >= Date.parse(scope.native.window.from))
                        && nativeRun.processed.get(keyFor(item)) !== item.lastActivity && item[idKey] !== continuationAnchor
                        && (item.lastActivity === null || tracked.has(hash(JSON.stringify([surface, item[idKey]])))));
                    const byKey = new Map(eligible.map(item => [keyFor(item), item]));
                    const prefix = `${collection.settings.windowDays}:${surface}:`;
                    const visibleKeys = new Set(items.map(keyFor));
                    const anchorKey = continuationAnchor === null ? null : `${prefix}${continuationAnchor}`;
                    for (const key of nativeRun.waitingHistories) {
                        if (key.startsWith(prefix) && visibleKeys.has(key) && key !== anchorKey && !byKey.has(key)) nativeRun.waitingHistories.delete(key);
                    }
                    for (const key of byKey.keys()) {
                        if (nativeRun.waitingHistories.size >= 10000 && !nativeRun.waitingHistories.has(key)) {
                            throw sourceError("NATIVE_SOURCE_PROGRESS_LIMIT");
                        }
                        nativeRun.waitingHistories.add(key);
                    }
                    const waiting = [...nativeRun.waitingHistories].filter(key => byKey.has(key)).map(key => byKey.get(key));
                    const undated = waiting.filter(item => item.lastActivity === null);
                    const backlog = waiting.filter(item => item.lastActivity !== null && historyFor(item)?.handledActivity == null);
                    const changed = waiting.filter(item => item.lastActivity !== null && historyFor(item)?.handledActivity != null);
                    const selected = [...backlog.slice(0, undated.length ? 3 : 4), ...changed.slice(0, undated.length ? 3 : 4), ...undated.slice(0, 2)];
                    for (const item of [...backlog, ...changed, ...undated]) {
                        if (selected.length === 8) break;
                        if (!selected.includes(item)) selected.push(item);
                    }
                    if (eligible.length > selected.length && !source.stops.includes("history-budget")) source.stops.push("history-budget");
                    if (scope.native.nextDiscovery?.surface === surface && scope.native.nextDiscovery.forceYield) break;
                    let returnToHistory = false;
                    for (const [index, item] of selected.entries()) {
                        const stop = nativeRun.deadline - Date.now() < 25000 ? "time-budget"
                            : nativeRun.bodyBytes > 12 * 1024 * 1024 ? "byte-budget"
                                : surface === "chat" && carry?.surface === surface && index > 0 ? "history-budget" : null;
                        if (stop) { if (!source.stops.includes(stop)) source.stops.push(stop); break; }
                        if (returnToHistory && ((nativeRun.counts.get("routing") ?? 0) >= 2
                            || (nativeRun.counts.get("cowork-list") ?? 0) >= 16)) {
                            if (!source.stops.includes("history-budget")) source.stops.push("history-budget");
                            break;
                        }
                        if (index > 0 && (surface === "chat" || returnToHistory)) {
                            const fresh = await discover(surface);
                            if (!fresh.some(row => row[idKey] === item[idKey] && row.lastActivity === item.lastActivity)) {
                                if (returnToHistory && scope.native.nextDiscovery?.surface === surface) break;
                                throw sourceError("NATIVE_SOURCE_DISCOVERY_CHANGED");
                            }
                        }
                        const id = item[idKey];
                        scope.native.collectingSurface = surface;
                        scope.native.collectingHistory = hash(JSON.stringify([surface, id]));
                        await phase(surface);
                        scope.captures.clear(); scope.chatRequest = null;
                        scope.native.detailVerified = false; scope.native.threadIds.clear(); scope.native.messageCursor = null;
                        scope.native.messageContinuations = new Set();
                        if (surface === "chat") scope.native.selectedChat = id;
                        else {
                            scope.native.selectedCowork = id;
                            scope.native.coworkComposite = `${nativeRun.principal.tenantId}:${nativeRun.principal.subjectId}:${id}`;
                        }
                        const navigation = surface === "cowork" && scope.native.coworkMembershipRead
                            ? await openNativeCoworkConversation(scope.page, nativeRun.coworkEntry, scope.native.coworkComposite, () => {
                                if (scope !== current || nativeRun !== admittedRun || scope.abort.signal.aborted || scope.operationSignal?.aborted
                                    || closed || browserClosed || !verified) throw sourceError("NATIVE_SOURCE_CANCELLED");
                                if (scope.error) throw scope.error;
                            })
                            : await clickNativeHistoryLink(scope.page, { surface, id,
                                tenantId: nativeRun.principal.tenantId, subjectId: nativeRun.principal.subjectId,
                                ...(surface === "cowork" ? { taskRows: nativeCoworkRowGuard(scope) } : {}) });
                        returnToHistory = navigation?.kind === "cowork-task-row";
                        const historyUrl = scope.page.url(), historyEpoch = nativeRun.documentEpoch;
                        await nativeWait(scope, () => surface === "chat" ? scope.captures.has("chat")
                            : scope.captures.has("cowork-detail") && scope.captures.has("cowork-messages"),
                        20000, "NATIVE_SOURCE_HISTORY_UNQUALIFIED");
                        if (surface === "chat") chatCaptures.push({ id, value: scope.captures.get("chat") });
                        else {
                            while (scope.native.messageCursor?.state === "present") {
                                const cursor = scope.native.messageCursor;
                                const until = Math.min(Date.now() + 20000, nativeRun.deadline);
                                const assertCurrent = () => {
                                    if (scope.error) throw scope.error;
                                    if (scope !== current || scope.abort.signal.aborted || closed || browserClosed) {
                                        throw sourceError("NATIVE_SOURCE_CANCELLED");
                                    }
                                    if (nativeRun.documentEpoch !== historyEpoch || scope.page.url() !== historyUrl) {
                                        throw sourceError("NATIVE_SOURCE_DOCUMENT_CHANGED");
                                    }
                                };
                                let uiQualified = false;
                                while (scope.native.messageCursor === cursor) {
                                    assertCurrent();
                                    await lifecycle.assertLease(lease);
                                    assertCurrent();
                                    if (Date.now() >= until) throw sourceError(uiQualified
                                        ? "NATIVE_SOURCE_PAGING_UNQUALIFIED" : "NATIVE_SOURCE_BUILD_UNQUALIFIED");
                                    const document = ancillaryDocument(scope);
                                    const asset = nativeCoworkBuild()?.olderMessagesScriptAsset;
                                    const script = asset && nativeDocumentScript(document, asset, scope.native.requestOrigins);
                                    uiQualified = Boolean(script && script.document === document
                                        && document.epoch === historyEpoch && script.entry.responseStatus === 200
                                        && script.entry.responseAcknowledged && script.entry.terminal === "finished" && !script.entry.cached);
                                    const slot = sourceSlot("cowork-messages", scope.native.protocolCounts.get("cowork-messages"));
                                    const latest = scope.native.protocolEntries.get(slot);
                                    if (uiQualified && scope.captures.has(slot) && latest?.responseAcknowledged
                                        && latest.terminal === "finished" && scope.native.messageCursor === cursor) {
                                        await revealNativeOlderMessages(scope.page, historyUrl, assertCurrent);
                                    }
                                    const nextPoll = Math.min(Date.now() + 100, until);
                                    await nativeWait(scope, () => scope.native.messageCursor !== cursor || Date.now() >= nextPoll,
                                        1000, "NATIVE_SOURCE_PAGING_UNQUALIFIED");
                                }
                            }
                            if (!["empty", "null"].includes(scope.native.messageCursor?.state)) throw sourceError("NATIVE_SOURCE_CONTINUATION_UNQUALIFIED");
                            for (const [kind, value] of scope.captures) if (kind.startsWith("cowork-messages")) {
                                coworkCaptures.push({ id, kind, value });
                            }
                            coworkCaptures.push({ id, kind: "cowork-detail", value: scope.captures.get("cowork-detail") });
                        }
                        scope.native.selectedHistories.push({ surface, id, undated: item.lastActivity === null,
                            revisit: surface === "cowork" && scope.captures.get("cowork-detail")?.body.task.state === "running" });
                        if (item.lastActivity === null) {
                            source.coworkCursor.referenceAfter = hash(id);
                            scope.native.undatedProcessed.push(keyFor(item));
                        }
                        else scope.native.processed.push([keyFor(item), item.lastActivity]);
                        scope.native.collectingHistory = null;
                    }
                    if (scope.native.nextDiscovery?.pageUrl === scope.page.url()) break;
                }
                await nativeWait(scope, () => accountGate?.active && accountGate.pendingCount === 0 && scope.pending.size === 0,
                    10000, "NATIVE_SOURCE_SETTLEMENT_UNQUALIFIED");
            } else if (collection.surfaces.includes("cowork")) {
                await scope.observer.beginPhase("cowork", { lease });
                scope.phase = "cowork";
                await scope.page.goto(origin + "/cowork/#/task/" + target.coworkFragment, { waitUntil: "domcontentloaded" });
                await waitFor(scope, () => scope.captures.has("cowork-detail") && scope.captures.has("cowork-messages"), "NATIVE_COWORK_READ_INCOMPLETE");
                await idle(scope);
            }
            if (!normal && collection.surfaces.includes("chat")) {
                await scope.observer.beginPhase("chat", { lease });
                scope.phase = "chat";
                await scope.page.goto(origin + target.chatPath, { waitUntil: "domcontentloaded" });
                await waitFor(scope, () => scope.captures.has("chat"), "NATIVE_CHAT_READ_INCOMPLETE");
            }
            await lifecycle.assertLease(lease);
            const account = transport.accountFor(lease).account, result = [];
            const metadata = value => ({ captureId: value.meta.captureId, capturedAt: value.meta.capturedAt,
                generation: lease.generation, parserVersion: "wire-original-response-v1", sourceSchema: "native-original-json",
                operation: "history-read", origin: value.origin, bodyDigest: value.meta.bodyDigest });
            if (!normal && collection.surfaces.includes("chat")) {
                if (!scope.captures.has("chat")) throw sourceError("NATIVE_CHAT_READ_INCOMPLETE");
                chatCaptures.push({ id: decodeURIComponent(target.chatPath.split("/").at(-1)), value: scope.captures.get("chat") });
            }
            for (const { id, value: chat } of chatCaptures) for (let frame = 0; frame < (chat?.body.length ?? 0); frame++) {
                if (normal) { scope.native.collectingSurface = "chat"; scope.native.collectingHistory = hash(JSON.stringify(["chat", id])); }
                const response = chat.body[frame];
                if (response.isLastPage === true && Object.keys(response).length === 1) continue;
                if (!Array.isArray(response.messages)) throw sourceError("NATIVE_CHAT_FRAME_INVALID");
                for (let index = 0; index < response.messages.length; index++) {
                    const record = response.messages[index];
                    let activity = normal ? nativeHistoryActivity(record, "chat", scope.native.window, nativeHistoryProducer.chatTimeUnit) : null;
                    if (normal && activity.state === "outside") {
                        activity = nativeHistoryActivity(record, "chat", scope.native.liveWindow, nativeHistoryProducer.chatTimeUnit);
                    }
                    if (normal && activity.state !== "in-window") {
                        scope.native.counts[activity.state === "outside" ? "outside" : "unqualified"]++;
                        if (activity.state !== "outside") scope.native.unqualifiedHistoryKeys.add(scope.native.collectingHistory);
                        continue;
                    }
                    const observations = retainNativeChatSourceObservations(decodeNativeChatObservation({
                        scope: { harness: "microsoft-365-copilot", surface: "chat", account,
                            conversationId: id },
                        capture: metadata(chat),
                        ordering: { pageOrdinal: 0, frameOrdinal: frame, recordOrdinal: index, completeness: "response-only" },
                        source: { sourceDocument: chat.meta.captureId, pointer: `/frames/${frame}/messages/${index}`, responsePointer: `/frames/${frame}` },
                        ...(Object.hasOwn(response, "requestId") ? { responseRequestId: response.requestId } : {}),
                        record,
                    }));
                    if (normal) for (const observation of observations) {
                        observation.record.createdAt = activity.value;
                        observation.qualifiedFields.messageCreatedAt = { availability: "recorded", scope: "message", value: activity.value };
                        observation.evidenceReferences.messageCreatedAt = { sourceDocument: chat.meta.captureId,
                            pointer: `/frames/${frame}/messages/${index}/createdAt`, nativeEventId: observation.record.messageId };
                        observation.coverage.push({ kind: "native-history-window", subject: nativeHistoryProducer.version,
                            meaning: "Only source-qualified activity in the fixed backfill or current configured window is retained; discovery and history completeness remain unqualified." });
                        scope.native.counts.eligible++;
                    }
                    result.push(...observations);
                    if (index % 16 === 0) { await setImmediate(); await lifecycle.assertLease(lease); }
                }
            }
            if (!normal) for (const kind of ["cowork-detail", "cowork-messages"]) {
                coworkCaptures.push({ id: sessionId, kind, value: scope.captures.get(kind) });
            }
            const qualifiedCoworkHistories = new Set();
            const coworkActivity = new Map();
            for (const { id, kind, value } of coworkCaptures) {
                if (normal) { scope.native.collectingSurface = "cowork"; scope.native.collectingHistory = hash(JSON.stringify(["cowork", id])); }
                if (!value) {
                    if (collection.surfaces.includes("cowork") && kind !== "cowork-messages-next") throw sourceError("NATIVE_COWORK_READ_INCOMPLETE");
                    continue;
                }
                const coworkProducer = normal ? nativeCoworkBuilds.find(build => build.id === value.coworkBuild) : null;
                if (normal && !coworkProducer) throw sourceError("NATIVE_SOURCE_BUILD_UNQUALIFIED");
                const records = kind === "cowork-detail" ? [value.body] : value.body.events;
                const selectedRecords = records.map((record, index) => ({
                    record, source: { sourceDocument: value.meta.captureId, pointer: kind === "cowork-detail" ? "/detail" : `/events/${index}` },
                    ordering: { pageOrdinal: kind === "cowork-messages-next" ? 1
                        : kind.startsWith("cowork-messages-page-") ? Number(kind.split("-").at(-1)) - 1 : 0,
                    recordOrdinal: index, completeness: "response-only" },
                })).filter(row => {
                    if (!normal) return true;
                    if (kind === "cowork-detail") return qualifiedCoworkHistories.has(id);
                    let activity = nativeHistoryActivity(row.record, "cowork", scope.native.window, coworkProducer.eventTimeUnit);
                    if (activity.state === "outside") activity = nativeHistoryActivity(row.record, "cowork", scope.native.liveWindow, coworkProducer.eventTimeUnit);
                    if (activity.state === "in-window") {
                        coworkActivity.set(id, Math.max(coworkActivity.get(id) ?? 0, Date.parse(activity.calendarInstant)));
                        return true;
                    }
                    scope.native.counts[activity.state === "outside" ? "outside" : "unqualified"]++;
                    if (activity.state !== "outside") scope.native.unqualifiedHistoryKeys.add(scope.native.collectingHistory);
                    return false;
                });
                if (!normal && !selectedRecords.length) throw sourceError("NATIVE_SOURCE_EVENTS_INVALID");
                for (let offset = 0; offset < selectedRecords.length; offset += normal ? 16 : selectedRecords.length) {
                    const batch = normal ? selectedRecords.slice(offset, offset + 16) : selectedRecords;
                    const matchedMessages = coworkProducer?.messageAuthors === true;
                    const observations = adaptCoworkSourceRecordsWithResultFacts(batch, {
                        scope: { harness: "microsoft-365-copilot", surface: "cowork", account,
                            conversationId: id },
                        capture: { ...metadata(value), parserVersion: matchedMessages ? COWORK_MATCHED_RESULT_ADAPTER_VERSION : COWORK_RESULT_ADAPTER_VERSION },
                    });
                    if (normal) for (const [index, observation] of observations.entries()) {
                        if (kind === "cowork-detail") {
                            observation.coverage.push({ kind: "native-history-snapshot", subject: nativeHistoryProducer.version,
                                meaning: "Task state and model are undated snapshot context for qualified in-window observations, not activity or per-call facts." });
                            continue;
                        }
                        qualifiedCoworkHistories.add(id);
                        const row = batch[index];
                        observation.record.data.ts = row.record.data.ts;
                        observation.qualifiedFields.observationTime = { availability: "recorded", scope: "observation",
                            unit: coworkProducer.eventTimeUnit, basis: "cowork.data.ts", value: row.record.data.ts };
                        observation.evidenceReferences.observationTime = { ...row.source,
                            pointer: row.source.pointer + "/data/ts", nativeEventId: row.record.id };
                        observation.coverage.push({ kind: "native-history-window",
                            subject: matchedMessages ? coworkProducer.id : nativeHistoryProducer.version,
                            meaning: "Only source-qualified activity in the fixed backfill or current configured window is retained; discovery and history completeness remain unqualified." });
                        scope.native.counts.eligible++;
                    }
                    result.push(...observations);
                    if (normal) { await setImmediate(); await lifecycle.assertLease(lease); }
                }
                await setImmediate(); await lifecycle.assertLease(lease);
            }
            const unqualifiedHistory = normal && scope.native.selectedHistories.find(({ surface, id }) =>
                scope.native.unqualifiedHistoryKeys.has(hash(JSON.stringify([surface, id]))));
            if (unqualifiedHistory) {
                scope.native.collectingSurface = unqualifiedHistory.surface;
                scope.native.collectingHistory = hash(JSON.stringify([unqualifiedHistory.surface, unqualifiedHistory.id]));
                throw sourceError("NATIVE_NO_QUALIFIED_WINDOW_ACTIVITY");
            }
            if (normal && (scope.error || scope.abort.signal.aborted)) throw scope.error ?? sourceError("NATIVE_SOURCE_CANCELLED");
            await lifecycle.assertLease(lease);
            if (normal) for (const { surface, id, revisit, undated } of scope.native.selectedHistories) {
                const source = backfill.sources.find(row => row.surface === surface), key = hash(JSON.stringify([surface, id]));
                let history = source.histories.find(row => row.key === key);
                if (surface === "cowork" && undated && coworkActivity.has(id)) {
                    if (!history) {
                        history = { key, activity: coworkActivity.get(id), handledActivity: null, handledThrough: null, state: "pending" };
                        source.histories.push(history);
                    } else history.activity = coworkActivity.get(id);
                }
                if (history) {
                    history.state = revisit ? "pending" : "handled"; history.handledActivity = history.activity;
                    history.handledThrough = Math.max(Date.parse(scope.native.liveWindow.to), Date.parse(scope.native.window.to));
                }
            }
            return normal ? attachNativeBackfill(result, backfill) : result;
        } catch (error) {
            if (normal && !recoveringRead && error.code === "NATIVE_SOURCE_TRANSIENT_READ_FAILED") {
                const entry = scope.native.readFailure, until = Math.min(Date.now() + 1000, nativeRun.deadline);
                while (scope === current && !scope.error && !scope.abort.signal.aborted
                    && (accountGate?.pendingCount || scope.pending.size) && Date.now() < until) await delay(25);
                let leaseCurrent = false;
                try { await lifecycle.assertLease(lease); leaseCurrent = true; }
                catch (leaseError) { error = leaseError; }
                if (leaseCurrent && entry?.readFailureResponse && entry.retryAfterAbsent
                    && entry.responseAcknowledged && entry.terminal === "finished"
                    && [...scope.native.protocolEntries.values()].filter(row => row.readFailureResponse).length === 1
                    && entry.documentEpochAtAdmission === nativeRun.documentEpoch
                    && entry.documentAtAdmission === scope.native.currentDocument
                    && scope === current && !scope.error && !scope.abort.signal.aborted && !scope.operationSignal?.aborted
                    && !scope.cleanupFailed && accountGate?.active && accountGate.pendingCount === 0 && scope.pending.size === 0
                    && nativeRun === admittedRun && nativeRun.deadline - Date.now() >= 25000) {
                    scope.readRecovery = true;
                    scope.commitState = "not-published";
                    nativeRun.discoveryCarry = null;
                    console.warn("[workiq-native] confirmed read failed; reinitializing once before publication", {
                        code: "NATIVE_SOURCE_TRANSIENT_READ_FAILED", status: 503,
                    });
                    await release(scope);
                    return acquire(lease, collection, recordFailure, previousBackfill, operation, true);
                }
            }
            const revoked = scope.abort.signal.aborted && !scope.error;
            const failure = normal ? scope.error ?? scope.controlFailure ?? sourceError(scope.abort.signal.aborted ? "NATIVE_SOURCE_CANCELLED" : safeCode(error)) : error;
            if (normal) {
                const detail = nativeFailureDetails(scope.error ?? error, "acquisition");
                withNativeFailurePredicate(failure, detail.predicate.stage, detail.predicate.name);
                if (detail.admission) withNativeFailureAdmission(failure, detail.admission);
                if (detail.protocolStop) withNativeFailureProtocolStop(failure, detail.protocolStop);
            }
            if (normal && !scope.error) {
                if (revoked) fault(scope, failure);
                else nativeFailure(scope, failure);
            }
            if (scope.recordFailure) await (scope.failureRecordTask ??= scope.recordFailure(failure));
            try {
                await release(scope);
                if (normal) {
                    if (scope.expiration) await scope.expiration;
                } else if (scope.error?.code === "NATIVE_SOURCE_ACCESS_EXPIRED") await lifecycle.expire(lease);
            } catch (cleanupError) {
                scope.cleanupFailed = true;
                console.error("[workiq-native] cleanup after original failure is incomplete", {
                    code: nativeErrorCode(cleanupError), firstCode: nativeErrorCode(failure),
                });
            }
            throw failure;
        }
    }
    try {
        // Restore metadata before the server's collector-owned sealed cleanup.
        const unboundStore = await exclusiveBoard(context, state => !state.nativeRetention && !state.nativeReportPolicy);
        const saved = await readNativeCollectionSettings(context);
        lifecycle = await createMicrosoftSession(context, { transport,
            // Preserve prior local WIRE access, never a Microsoft account or collection grant.
            initialWire: ordinaryStartup && unboundStore ? "signed-in" : "signed-out",
            nativeSignInMode: visibleSignIn ? "visible" : "headless",
            ...(sourceAware ? { sourceAware: true, globalCollection: await readGlobalCollectionGate(context) } : {}),
            collection: saved ? { paused: saved.paused, windowDays: saved.windowDays } : { paused: true, windowDays: 30 },
            timeoutMs: normal || ordinaryStartup ? 300000 : 180000,
            persistCollectionSettings: async (settings, token) => {
                if (!settings.paused && !await readNativeCollectionSettings(context)) throw sourceError("NATIVE_COLLECTION_CONFIGURATION_REQUIRED");
                return persistence.persistCollectionSettings(settings, token);
            },
        });
        persistence = await createNativePersistence(context, { lifecycle, transport, backfillTracking: normal || ordinaryStartup,
            ...(configuration || sourceAware ? { preAccount: "metadata-only", configurationIntents: true } : {}),
        });
        unsubscribe = lifecycle.subscribeAuthorizationChange(event => {
            const scope = current;
            if (nativeRun?.liveAppDocument && event.generation !== nativeRun.liveAppDocument.generation) revokeAppDocumentContinuity();
            if (scope?.lease && (!event.microsoftAcquisition || event.generation !== scope.lease.generation)) {
                if (scope.native) scope.native.historyOwnerRevoked = true;
                revokeAppDocumentContinuity();
                scope.abort.abort();
                scope.observer.block();
                if (scope.clientRead) {
                    if (nativeRun?.sessionReader) void nativeRun.sessionReader.cancel().catch(() => {
                        scope.cleanupFailed = true;
                        console.error("[workiq-native] native client cancellation unconfirmed", { code: "NATIVE_COWORK_CLIENT_CANCEL_UNCONFIRMED" });
                    });
                    const lostRun = nativeRun;
                    // Authorization listeners notify; owner teardown runs outside
                    // their non-reentrant callback and rechecks the same owner.
                    ownerNotifications.runInAsyncScope(() => queueMicrotask(() => nativeOwnerLost(lostRun, "NATIVE_SOURCE_AUTHORIZATION_REVOKED")));
                }
            }
        });
        access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence,
            sourceAware, nativeAcquisition: sourceAware ? nativeAcquisition : true,
            nativeScheduling,
            nativeConnection: configuration !== null, acquireNative: acquire,
            ...(ordinaryStartup && !configuration ? { nativeEnrollment: {
                available: () => !closed && !configuration && !existsSync(path.join(context.dataDir, "microsoft-native"))
                    && !existsSync(path.join(context.dataDir, "microsoft-source.json")),
                async prepare(account, admission) {
                    if (closed || configuration) throw sourceError("NATIVE_ENROLLMENT_UNAVAILABLE");
                    const prepared = await prepareMicrosoftNativeConfiguration(context,
                        account ?? enrollmentPolicy?.expectedAccount, admission, enrollmentPolicy);
                    admission.check();
                    configuration = prepared;
                    expectedAccount = prepared.expectedAccount;
                    normal = true;
                },
            } } : {}),
            completeNative: async (ticket, receipt, envelopes, recordBackfill) => {
                const scope = leaseScopes.get(ticket.lease);
                if (scope) scope.commitState = receipt?.status === "committed" ? "committed" : "unconfirmed";
                if (normal && scope) nativeRun.lastCommit = scope.commitState;
                try {
                    const comparison = await persistence.compareCommittedSource(ticket, envelopes);
                    await recordBackfill(comparison);
                    if (normal && scope?.commitState === "committed" && ["matched", "suppressed"].includes(comparison.status)) {
                        for (const [key, activity] of scope.native.processed ?? []) {
                            if (nativeRun.processed.size >= 10000 && !nativeRun.processed.has(key)) {
                                throw sourceError("NATIVE_SOURCE_PROGRESS_LIMIT");
                            }
                            if (activity <= Date.parse(scope.native.liveWindow.to)) nativeRun.processed.set(key, activity);
                            nativeRun.waitingHistories.delete(key);
                        }
                        for (const key of scope.native.undatedProcessed ?? []) nativeRun.waitingHistories.delete(key);
                    }
                    if (normal && scope?.commitState === "committed" && scope.native.nextDiscovery
                        && scope.native.nextDiscovery.pageUrl === scope.page.url()) nativeRun.discoveryCarry = scope.native.nextDiscovery;
                    if (scope) scope.comparison = comparison;
                    else console.info("[workiq-native] source comparison", JSON.stringify(comparison));
                } catch (error) {
                    revokeAppDocumentContinuity();
                    if (scope) scope.continuityRevoked = true;
                    throw error;
                } finally {
                    try {
                        try {
                            if (scope?.clientRead && scope.commitState === "committed" && !scope.error) {
                                await nativeRun.sessionReader.finish();
                            }
                        } catch (error) {
                            if (scope?.clientRead) nativeFailure(scope, error);
                            throw error;
                        } finally {
                            await release(scope);
                        }
                    }
                    finally { leaseScopes.delete(ticket.lease); }
                }
            },
        });
        return Object.freeze({
            access,
            close() {
                if (closeTask) return closeTask;
                closed = true;
                revokeAppDocumentContinuity();
                current?.abort.abort();
                current?.observer.close();
                closeTask = (async () => {
                    await access.stopNativeCollection?.();
                    access.close();
                    persistence.close();
                    unsubscribe?.();
                    await lifecycle.close();
                })().finally(() => ownerNotifications.emitDestroy());
                return closeTask;
            },
        });
    } catch (error) {
        access?.close(); persistence?.close(); unsubscribe?.();
        if (lifecycle) await lifecycle.close();
        ownerNotifications.emitDestroy();
        throw error;
    }
}
