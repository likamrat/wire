const appOrigin = "https://copilot.cloud.microsoft";
export const nativeApplicationEntry = "https://m365.cloud.microsoft/chat";

// Executed in the original app document. Read only data properties of the
// existing bootstrap; never replace fetch, hydration setters or auth results.
export function readNativeAccountMetadata(reportStatus = false, projectHistory = null) {
    let branch = "tanstack";
    const result = (state, projected = null) => reportStatus ? { state, branch, projected } : projected;
    const fail = () => { throw new Error("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED"); };
    const own = (value, key) => {
        if (!value || typeof value !== "object") return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) return undefined;
        if (!Object.hasOwn(descriptor, "value")) throw new Error("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
        return descriptor.value;
    };
    const background = own(window, "__backgroundSSR");
    if (background !== undefined && typeof background !== "boolean") fail();
    let loader;
    if (background === true) {
        branch = "background-loader";
        loader = own(window, "__backgroundLoaderData");
    } else {
        const transport = own(window, "$_TSR");
        if (transport === undefined) return result("bootstrap-unavailable");
        if (own(transport, "initialized") !== true) return result("bootstrap-uninitialized");
        loader = own(own(own(own(transport, "router"), "dehydratedData"), "copilotBootstrap"), "loaderData");
    }
    if (loader === undefined || loader === null) return result("bootstrap-loader-unavailable");
    if (typeof loader !== "object" || Array.isArray(loader)) fail();
    const routes = Object.keys(loader);
    if (routes.length > 32) throw new Error("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
    let account, signature, label;
    for (const route of routes) {
        const data = own(loader, route), store = own(data, "store"), source = own(store, "accountInfo");
        if (source !== undefined) {
            if (!source || typeof source !== "object" || Array.isArray(source)) fail();
            const value = {};
            for (const key of ["accountType", "objectId", "tenantId", "environment"]) {
                const field = own(source, key);
                if (field !== undefined && (typeof field !== "string" || field.length > 1024)) {
                    throw new Error("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
                }
                if (field !== undefined) value[key] = field;
            }
            const next = JSON.stringify(value);
            if (signature !== undefined && signature !== next) throw new Error("NATIVE_SOURCE_ACCOUNT_MISMATCH");
            account = value; signature = next;
        }
        const current = own(own(store, "identity"), "userPrincipalName");
        if (current !== undefined) {
            if (typeof current !== "string" || current.length > 160
                || label !== undefined && label.toLowerCase() !== current.toLowerCase()) {
                throw new Error("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED");
            }
            label = current;
        }
    }
    if (projectHistory) {
        const history = projectHistory(loader, own);
        return history ? result("available", { ...history, store: { ...history.store,
            ...(account ? { accountInfo: account } : {}),
            ...(label === undefined ? {} : { identity: { userPrincipalName: label } }) } }) : result("history-unavailable");
    }
    return account ? result("available", { store: { accountInfo: account,
        ...(label === undefined ? {} : { identity: { userPrincipalName: label } }) } }) : result("account-unavailable");
}

// Collection only; never included in the account-only startup observer.
export function projectNativeBootstrapHistory(loader, own) {
    const fail = () => { throw new Error("NATIVE_BOOTSTRAP_PROJECTION_UNQUALIFIED"); };
    const routes = Object.keys(loader);
    const historyRoutes = routes.filter(route => {
        const store = own(own(loader, route), "store");
        return ["conversationPageHistoryList", "chatLandingPageHistoryList"].some(key => own(store, key) !== undefined);
    });
    const marked = historyRoutes.filter(route => own(own(loader, route), "historySource") === "all-chats");
    if (marked.length > 1) fail();
    const route = marked[0] ?? (historyRoutes.length === 1 ? historyRoutes[0] : null);
    if (route === null) return null;
    const data = own(loader, route), store = own(data, "store"), history = { store: {} };
    const copy = (source, fields) => {
        const value = {};
        for (const field of fields) {
            const item = own(source, field);
            if (item === undefined) continue;
            if (item !== null && !["string", "number", "boolean"].includes(typeof item)
                || typeof item === "string" && item.length > 4096) fail();
            value[field] = item;
        }
        return value;
    };
    const rows = value => {
        if (!Array.isArray(value) || value.length > 500) fail();
        return Array.from({ length: value.length }, (_, index) =>
            copy(own(value, String(index)), ["conversationId", "createTimeUtc", "updateTimeUtc"]));
    };
    for (const key of ["conversationPageHistoryList", "chatLandingPageHistoryList"]) {
        const list = own(store, key);
        if (list !== undefined) history.store[key] = { ...copy(list, ["syncState"]), chats: rows(own(list, "chats")) };
    }
    Object.assign(history, copy(data, ["historySource"]));
    const flags = own(store, "featureFlags");
    if (flags !== undefined) history.store.featureFlags = copy(flags, ["enableChatLandingPageHistoryStore"]);
    const pinnedIds = own(store, "pinnedChatIds"), pinnedChats = own(store, "pinnedChats");
    if (pinnedIds !== undefined) {
        if (!pinnedIds || typeof pinnedIds !== "object" || Array.isArray(pinnedIds) || Object.keys(pinnedIds).length > 500) fail();
        history.store.pinnedChatIds = Object.fromEntries(Object.keys(pinnedIds).map(id => {
            const pinnedAt = own(pinnedIds, id);
            if (!id.length || id.length > 1024 || !Number.isSafeInteger(pinnedAt) || pinnedAt < 0) fail();
            return [id, pinnedAt];
        }));
    }
    if (pinnedChats !== undefined) history.store.pinnedChats = rows(pinnedChats);
    return history;
}
export const nativeApplicationBuilds = Object.freeze([
    Object.freeze({
        id: "midgard-046dc56a",
        scriptAssets: Object.freeze([
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/runtime.7ec01a27.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.046dc56a.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.vendors.8b58f02e.js",
        ]),
        healthPingCallsites: Object.freeze({
            loggerInit: Object.freeze({ line: 2, column: 20910 }),
            mainLoad: Object.freeze({ line: 2, column: 498420 }),
        }),
    }),
    Object.freeze({
        id: "midgard-154e12e9",
        scriptAssets: Object.freeze([
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/runtime.c5d628ff.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.154e12e9.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.vendors.dcf66375.js",
        ]),
        healthPingCallsites: Object.freeze({
            loggerInit: Object.freeze({ line: 2, column: 19909 }),
            mainLoad: Object.freeze({ line: 2, column: 514977 }),
        }),
        appEventsCallsites: Object.freeze({
            batch: Object.freeze({ line: 2, column: 633361 }),
            flush: Object.freeze({ line: 2, column: 635388 }),
        }),
        workerPreflightCallsite: Object.freeze({ line: 2, column: 849415 }),
    }),
    Object.freeze({
        id: "midgard-6dd02948",
        scriptAssets: Object.freeze([
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/runtime.f099e4f0.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.6dd02948.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.vendors.d31fedd4.js",
        ]),
        healthPingCallsites: Object.freeze({
            loggerInit: Object.freeze({ line: 2, column: 19909 }),
            mainLoad: Object.freeze({ line: 2, column: 516025 }),
        }),
        appEventsCallsites: Object.freeze({
            batch: Object.freeze({ line: 2, column: 634125 }),
            flush: Object.freeze({ line: 2, column: 636152 }),
        }),
        workerPreflightCallsite: Object.freeze({ line: 2, column: 851178 }),
    }),
    Object.freeze({
        id: "midgard-ee6e08b8",
        scriptAssets: Object.freeze([
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/runtime.b93e26e9.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.ee6e08b8.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.vendors.d31fedd4.js",
        ]),
        healthPingCallsites: Object.freeze({
            loggerInit: Object.freeze({ line: 2, column: 19909 }),
            mainLoad: Object.freeze({ line: 2, column: 516025 }),
        }),
        appEventsCallsites: Object.freeze({
            batch: Object.freeze({ line: 2, column: 634125 }),
            flush: Object.freeze({ line: 2, column: 636152 }),
        }),
        workerPreflightCallsite: Object.freeze({ line: 2, column: 851177 }),
    }),
    Object.freeze({
        id: "midgard-d6c807be",
        scriptAssets: Object.freeze([
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/runtime.5b09355d.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.d6c807be.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/index.vendors.afde6380.js",
        ]),
        startupScriptAssets: Object.freeze([
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/graphql.vendors.6cde5440.js",
            "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/react.vendors.66726b7f.js",
        ]),
        healthPingCallsites: Object.freeze({
            loggerInit: Object.freeze({ line: 2, column: 20094 }),
            mainLoad: Object.freeze({ line: 2, column: 514812 }),
        }),
        appEventsCallsites: Object.freeze({
            batch: Object.freeze({ line: 2, column: 635255 }),
            flush: Object.freeze({ line: 2, column: 637322 }),
            directBatch: Object.freeze({ line: 2, column: 621408 }),
            directRetry: Object.freeze({ line: 2, column: 621966 }),
            directFlush: Object.freeze({ line: 2, column: 623359 }),
        }),
        workerPreflightCallsite: Object.freeze({ line: 2, column: 848005 }),
    }),
]);
export const nativeHistoryProducer = Object.freeze({
    version: "m365-native-ui-history-v1",
    accountNamespace: "m365.accountInfo.objectId",
    realm: "prod",
    chatTimeUnit: "iso8601",
    coworkTimeUnit: "epoch-ms",
    coworkScriptAsset: "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/1979.657607ab.js",
    partnerPreloadScriptAssets: Object.freeze([
        "https://aadcdn.msftauth.net/shared/1.0/content/js/ConvergedLogin_PCore_tg1zCo1cm8VzH5kfPPn1ZQ2.js",
        "https://aadcdn.msftauth.net/shared/1.0/content/js/ConvergedLogin_PCore_Z0tfIqn-YAh_QXsCBPIQ0w2.js",
        "https://aadcdn.msauth.net/shared/1.0/content/js/ConvergedLogin_PCore_Z0tfIqn-YAh_QXsCBPIQ0w2.js",
    ]),
    cachedSessionsScriptAsset: "https://aadcdn.msftauth.net/shared/1.0/content/js/asyncchunk/convergedlogin_pfetchsessionsprogress_b37592e66c693da8ed05.js",
    authTelemetryCollector: "https://browser.events.data.microsoft.com/OneCollector/1.0/",
    chatRpcId: "73e9366cfbebe3976abc796ef16c0305213fd6f32aea4731837e2a1f18e54268",
    chatInitializerRpcId: "22ef9231e91dd4cf46350df4f8e31fc54e727335d4a882bc56199bd904815585",
    bootstrapRpcId: "d1ab460bd6165cfc5985242e7248c7435d8b5bd9e2a55fd0fd1022a81319548d",
    scriptAssets: nativeApplicationBuilds[0].scriptAssets,
});
export const nativeCoworkBuilds = Object.freeze([
    Object.freeze({ id: "cowork-1979-657607ab", messageAuthors: false, eventTimeUnit: "epoch-ms",
        scriptAssets: Object.freeze([nativeHistoryProducer.coworkScriptAsset]) }),
    Object.freeze({ id: "cowork-748365-ca29e321", messageAuthors: true, eventTimeUnit: "epoch-ms",
        olderMessagesScriptAsset: "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/73427.cde954e9.js",
        runFeedScriptAsset: "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/scheduled-page.98886159.js",
        automationDetailsScriptAsset: "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/95383.07a452ce.js",
        taskListScriptAsset: "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/66584.d4bf7c45.js",
        scriptAssets: Object.freeze([
            "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/1979.ca29e321.js",
            "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/33954.f0e5741d.js",
            "https://res.cdn.office.net/s01-copilotstudio/cowork/latest/static/js/async/91902.0ae5ea97.js",
        ]) }),
]);
export const nativeCachedSessionBindings = Object.freeze({
    control: "component:{name:'fetch-sessions-control',params:{serverData:svr,sessionPullType:sessionPullType,"
        + "unsafe_desktopSsoDomainToUse:unsafe_domainName,username:username,displayName:displayName},event:{"
        + "updateUserTiles:fetchSessionsProgress_onUpdateUserTiles,executeGctResult:fetchSessionsProgress_onExecuteGctResult,"
        + "handleDssoSuccess:fetchSessionsProgress_onHandleDssoSuccess,desktopSsoFallbackView:fetchSessionsProgress_onDesktopSsoFallbackView,"
        + "incrementAsyncTileRequestCount:fetchSessionsProgress_onIncrementAsyncTileRequestCount,"
        + "decrementAsyncTileRequestCount:fetchSessionsProgress_onDecrementAsyncTileRequestCount,redirect:fetchSessionsProgress_onRedirect}}",
    view: "pageViewComponent:{name:'fetch-sessions-progress-view',params:{serverData:svr,sessionPullType:$loginPage.sessionPullType,"
        + "isInitialView:isInitialState,username:sharedData.username,displayName:sharedData.displayName,"
        + "unsafe_desktopSsoDomainToUse:sharedData.unsafe_desktopSsoDomainToUse,preferredCredential:sharedData.preferredCredential,"
        + "isPushNotification:sharedData.remoteNgcParams.defaultType===1},event:{updateUserTiles:$loginPage.fetchSessions_onUpdateUserTiles,"
        + "executeGctResult:$loginPage.fetchSessions_onExecuteGctResult,submitReady:$loginPage.view_onSubmitReady,redirect:$loginPage.view_onRedirect}}",
});
const shellOrigin = "https://m365.cloud.microsoft";
const authOrigin = "https://login.microsoftonline.com";
const authUiOrigins = new Set([authOrigin, "https://login.microsoft.com"]);
const authPhases = new Set(["native-entry-invoked", "native-signin-invoked", "known-account-selection-invoked"]);
const headingNode = "self::h1 or self::h2 or self::h3 or @role='heading'";

export const nativePublicOriginLabels = Object.freeze({
    [shellOrigin]: "m365-app", [appOrigin]: "copilot-app", [authOrigin]: "entra-login",
    "https://login.microsoft.com": "microsoft-login", "https://autologon.microsoftazuread-sso.com": "entra-sso",
    "https://www.office.com": "office", "https://outlook.office.com": "outlook",
    "https://login.live.com": "consumer-login", "https://login.windows.net": "legacy-login",
    "https://login.microsoftonline.us": "government-login",
});
export const nativePublicRouteLabels = Object.freeze({
    "/": "root", "/home": "home", "/login": "login", "/landingv2": "landing",
    "/spalanding": "spa-landing", "/chat": "chat", "/hwav2/chat": "chat-v2",
    "/blank": "blank", "/bootstrap/mos": "bootstrap-mos", "/externalauth/start": "external-auth-start",
    "/externalauth/end": "external-auth-end", "/signinDev": "sign-in-dev",
    "/Me.htm": "consumer-me", "/oauth20_authorize.srf": "consumer-authorize", "/ppsecure/post.srf": "consumer-post",
    "/{authority}/oauth2/authorize": "entra-authorize",
});
const consumerRoutes = ["/Me.htm", "/oauth20_authorize.srf", "/ppsecure/post.srf"];
function bootstrapDestination(url) {
    const publicOrigin = url && Object.hasOwn(nativePublicOriginLabels, url.origin) ? url.origin : null;
    let route = publicOrigin && Object.hasOwn(nativePublicRouteLabels, url.pathname)
        && !consumerRoutes.includes(url.pathname) && url.pathname !== "/{authority}/oauth2/authorize" ? url.pathname : null;
    if (publicOrigin === "https://login.live.com" && ["/Me.htm", "/oauth20_authorize.srf", "/ppsecure/post.srf"].includes(url.pathname)) {
        route = url.pathname;
    }
    if (publicOrigin === authOrigin && /^\/[^/]+\/oauth2\/(?:v2\.0\/)?authorize$/.test(url.pathname)) {
        route = "/{authority}/oauth2/authorize";
    }
    return { publicOrigin, route };
}
export function nativeBootstrapDestinationLabels(url) {
    const { publicOrigin, route } = bootstrapDestination(url);
    return { originLabel: publicOrigin ? nativePublicOriginLabels[publicOrigin] : "unknown",
        routeLabel: route ? nativePublicRouteLabels[route] : "unknown" };
}
export function nativeBootstrapRouteEvidence(url) {
    const { publicOrigin, route } = bootstrapDestination(url);
    const safeKeys = new Set(["es", "ru", "client_id", "redirect_uri", "response_type", "response_mode", "scope", "prompt",
        "fromcode", "fromCode", "auth", "silent", "sso_reload", "client-request-id", "msaljs", "version", "v", "mkt", "lc", "id", "uaid"]);
    const keys = new Set();
    let unknownKeys = false, duplicateKeys = false, capped = false, count = 0;
    for (const key of url?.searchParams.keys() ?? []) {
        if (++count > 32) { capped = true; break; }
        if (!safeKeys.has(key)) { unknownKeys = true; continue; }
        if (keys.has(key)) duplicateKeys = true;
        keys.add(key);
    }
    return { publicOrigin, route, queryKeys: [...keys].sort(), unknownKeys, duplicateKeys, capped,
        fragmentPresent: Boolean(url?.hash) };
}

export function nativeAuthScriptEvidence(url) {
    if (!url || !["https://aadcdn.msauth.net", "https://aadcdn.msftauth.net"].includes(url.origin)
        || url.search || url.hash || url.username || url.password
        || !/^\/(?:ests|shared)\/[0-9.]+\/content\/(?:js|cdnbundles)\/[A-Za-z][A-Za-z0-9._-]{0,200}\.js$/.test(url.pathname)) return null;
    return { publicOrigin: url.origin, publicPath: url.pathname };
}

function literal(value) {
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes('"')) return `"${value}"`;
    return `concat(${value.split("'").map(part => `'${part}'`).join(`,"'",`)})`;
}
function locationMetadata(page) {
    const url = new URL(page.url());
    return { origin: url.origin, path: url.pathname };
}

export async function presentNativeSignInHandoff(page, { binding, signal, deadline, onReady }) {
    if (page.url() !== "about:blank") throw Object.assign(new Error("The controlled sign-in handoff surface changed."),
        { code: "NATIVE_HANDOFF_SURFACE_UNQUALIFIED" });
    if (signal.aborted) return "cancelled";
    if (page.isClosed()) return "window-closed";
    if (Date.now() >= deadline) return "timed-out";
    const completion = Promise.withResolvers();
    let settled = false;
    const finish = result => {
        if (settled) return false;
        settled = true;
        completion.resolve(result);
        return true;
    };
    const aborted = () => finish("cancelled"), closed = () => finish("window-closed");
    const navigated = frame => {
        if (frame === page.mainFrame() && frame.url() !== "about:blank") finish("cancelled");
    };
    const timer = setTimeout(() => finish("timed-out"), Math.max(1, deadline - Date.now()));
    signal.addEventListener("abort", aborted, { once: true });
    page.on("close", closed);
    page.on("framenavigated", navigated);
    const setup = async () => {
        await page.exposeBinding(binding, ({ frame }, action) => {
            if (settled || signal.aborted || frame !== page.mainFrame() || page.url() !== "about:blank") return false;
            if (Date.now() >= deadline) { finish("timed-out"); return false; }
            return action === "continue" ? finish("confirmed") : action === "cancel" ? finish("cancelled") : false;
        });
        if (settled) return;
        await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
            <title>WIRE - Microsoft sign-in</title><style>
            :root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
            body{margin:0;padding:32px}main{max-width:560px;margin:48px auto}h1{font-size:28px;line-height:1.2}
            p{margin:20px 0}nav{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
            button{font:inherit;min-height:44px;padding:10px 20px;cursor:pointer}button:focus-visible{outline:3px solid Highlight;outline-offset:3px}
            </style></head><body><main><h1>WIRE Microsoft sign-in</h1>
            <p>WIRE will open Microsoft's sign-in page in this window after you continue.</p>
            <p>Use your work account and complete any verification on Microsoft's page. Choose Cancel or close this window to stop.</p>
            <nav aria-label="Sign-in actions"><button id="wire-continue" type="button">Continue to Microsoft</button>
            <button id="wire-cancel" type="button">Cancel</button></nav><p id="wire-status" role="status"></p>
            </main></body></html>`);
        if (!settled) await page.evaluate(name => {
            let submitted = false;
            for (const action of ["continue", "cancel"]) document.getElementById("wire-" + action).addEventListener("click", async event => {
                if (!event.isTrusted || submitted) return;
                submitted = true;
                document.querySelectorAll("button").forEach(button => { button.disabled = true; });
                const status = document.getElementById("wire-status");
                status.textContent = action === "continue" ? "Opening Microsoft sign-in..." : "Cancelling...";
                try {
                    if (!await window[name](action)) status.textContent = "This sign-in attempt is no longer active.";
                } catch { status.textContent = "This sign-in attempt could not continue. Close this window and return to WIRE."; }
            });
        }, binding);
        if (!settled) {
            await page.bringToFront();
            if (Date.now() >= deadline) finish("timed-out");
            else if (!settled) onReady();
        }
    };
    try {
        await Promise.race([setup(), completion.promise]);
        return await completion.promise;
    } finally {
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        page.off("close", closed);
        page.off("framenavigated", navigated);
    }
}

function headings(page, labels) {
    const predicate = labels.map(label => `normalize-space(.)=${literal(label)}`).join(" or ");
    return page.locator(`xpath=//*[(${headingNode}) and (${predicate})]`).filter({ visible: true });
}
export function nativeSignInControl(page) {
    const location = locationMetadata(page);
    const landing = location.origin === appOrigin && ["/", "/home"].includes(location.path);
    const shell = page.url() === nativeApplicationEntry;
    if (!landing && !shell) throw new Error("SIGNIN_CONTROL_SURFACE_UNQUALIFIED");
    const lower = value => `translate(normalize-space(${value}),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')`;
    return page.locator(`xpath=//*[(${landing ? "true()" : "false()"} and self::a and string-length(normalize-space(@href))>0 and
        (@id='hero-banner-sign-in-to-office-365-link' or @id='hero-banner-sign-back-in-to-office-365-link'))
        or ((self::button or self::a or @role='button') and (${lower("@aria-label")}='sign in'
        or ${lower("@aria-label")}='log in' or ${lower(".")}='sign in' or ${lower(".")}='log in'))]`).filter({ visible: true });
}
export function knownAccountControl(page, expectedAccount) {
    const location = locationMetadata(page);
    if (!authUiOrigins.has(location.origin) || /(?:^|\/)fido(?:\/|$)/i.test(location.path) || typeof expectedAccount !== "string"
        || expectedAccount.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedAccount)) {
        throw new Error("KNOWN_ACCOUNT_CONTROL_SCOPE_UNQUALIFIED");
    }
    // Exact direct text only; never return account labels or inspect input values.
    return page.locator(`xpath=//*[normalize-space(text())=${literal(expectedAccount)}]`).filter({ visible: true });
}

export async function collectBootstrapUIMetadata(page, { phase, expectedAccount }) {
    const location = locationMetadata(page);
    if (page.url() === nativeApplicationEntry && authPhases.has(phase)) {
        const signInMatches = await nativeSignInControl(page).count();
        return { ...location, kind: signInMatches === 0 ? "app-shell-metadata-only"
            : phase === "native-entry-invoked" && signInMatches === 1 ? "app-signin-control" : "app-shell-signin-present",
            signInMatches, inspected: ["exact-signin-control-count"], authChallengeInspection: "not-performed-on-app" };
    }
    if (location.origin === shellOrigin && ["/", "/home", "/login", "/landingv2", "/spalanding"].includes(location.path)) {
        return { ...location, kind: "app-bootstrap-transit-metadata-only", domInspected: false };
    }
    if (location.origin === appOrigin && (location.path === "/home"
        || location.path === "/" && authPhases.has(phase))) {
        const signInMatches = await nativeSignInControl(page).count();
        return { ...location, kind: signInMatches === 0 ? "app-home-metadata-only"
            : phase === "blank-native-start" && signInMatches === 1 ? "app-signin-control" : "app-home-signin-present",
            signInMatches, inspected: ["exact-signin-control-count"], authChallengeInspection: "not-performed-on-app" };
    }
    if (location.origin === appOrigin && location.path === "/" && phase === "blank-native-start") {
        const signInMatches = await nativeSignInControl(page).count();
        return { ...location, kind: signInMatches === 1 ? "app-signin-control"
            : signInMatches === 0 ? "app-signin-not-yet-observed" : "app-signin-ambiguous",
            signInMatches, inspected: ["exact-signin-control-count"], authChallengeInspection: "not-performed-on-app" };
    }
    if (location.origin === appOrigin && ["/", "/landingv2", "/login", "/spalanding"].includes(location.path)) {
        return { ...location, kind: "app-bootstrap-transit-metadata-only", domInspected: false };
    }
    if (!authUiOrigins.has(location.origin) || !authPhases.has(phase)) {
        return { ...location, kind: "outside-eligible-bootstrap-ui", domInspected: false };
    }
    const credentials = await page.locator('input[type="password"],input[type="email"],input[name="loginfmt"]').filter({ visible: true }).count();
    const mfaInputs = await page.locator('input[autocomplete="one-time-code"],input[name="otc"],input[name="otcCode"],input[name="verificationCode"],#idTxtBx_SAOTCC_OTC')
        .filter({ visible: true }).count();
    const mfaHeadings = await headings(page, ["Verify your identity", "Approve sign in request", "Approve sign in",
        "Enter code", "Enter the code", "Check your Authenticator app"]).count();
    const consentControls = await page.locator('#idBtn_Accept,#idBtn_Deny,[name="consent"],[name="approval"]').filter({ visible: true }).count();
    const consentHeadings = await headings(page, ["Permissions requested", "Accept these permissions", "Consent on behalf of your organization"]).count();
    const challengeCounts = { credentialControls: credentials, mfaControls: mfaInputs + mfaHeadings,
        consentControls: consentControls + consentHeadings };
    if (Object.values(challengeCounts).some(count => count > 0)) {
        const passwords = credentials ? await page.locator('input[type="password"]').filter({ visible: true }).count() : 0;
        const interaction = challengeCounts.consentControls ? "consent" : challengeCounts.mfaControls ? "mfa"
            : passwords ? passwords === credentials ? "password" : "username-and-password" : "username";
        return { ...location, kind: "auth-challenge-control", challengeCounts, interaction,
            inspected: ["known-credential-mfa-consent-control-counts"], arbitraryAuthTextInspected: false };
    }
    const pickerHeadings = await headings(page, ["Pick an account", "Choose an account"]).count();
    if (pickerHeadings !== 1) {
        return { ...location, kind: pickerHeadings === 0 ? "auth-state-unrecognized" : "auth-picker-ambiguous",
            pickerHeadings, challengeCounts, authorizationEligible: false };
    }
    if (/(?:^|\/)fido(?:\/|$)/i.test(location.path)) {
        return { ...location, kind: "auth-challenge-control", interaction: "select-work-account",
            pickerHeadings, challengeCounts, inspected: ["known-auth-control-counts"], privateLabelsRetained: false };
    }
    if (!["native-entry-invoked", "native-signin-invoked"].includes(phase)) {
        return { ...location, kind: "auth-account-selection-unresolved", pickerHeadings, challengeCounts, authorizationEligible: false };
    }
    const knownAccountMatches = await knownAccountControl(page, expectedAccount).count();
    return { ...location, kind: knownAccountMatches === 1 ? "known-account-picker"
        : knownAccountMatches === 0 ? "known-account-not-observed" : "auth-picker-ambiguous",
        pickerHeadings, knownAccountMatches, challengeCounts,
        inspected: ["known-auth-control-counts", "exact-known-account-count"], privateLabelsRetained: false };
}

export function nativeHistoryEntry(surface, value) {
    const url = typeof value === "string" ? URL.parse(value) : null;
    if (!url || url.username || url.password || !["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(url.origin)) return "unobserved";
    const pathname = url.pathname.replace(/^\/hwav2(?=\/)/, "");
    if (surface === "chat" && pathname === "/chat/all") return "chat-all";
    if (surface !== "cowork" || !["/cowork", "/cowork/"].includes(pathname)) return "unobserved";
    if (url.hash === "#/my-tasks") return "cowork-my-tasks";
    return ["", "#", "#/"].includes(url.hash) ? "cowork-root" : "unobserved";
}

function coworkViewUrl(entry, fragment) {
    const url = URL.parse(entry);
    if (!url || !["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(url.origin)
        || !/^\/(?:hwav2\/)?cowork\/?$/.test(url.pathname) || url.username || url.password) {
        throw Object.assign(new Error("Native Cowork view is unavailable."), { code: "NATIVE_HISTORY_CONTROL_UNQUALIFIED" });
    }
    url.hash = fragment;
    return url.href;
}

export async function openNativeCoworkAutomations(page, entry, assertCurrent) {
    assertCurrent();
    // This is the published native read view, not a synthesized data-API call.
    const target = coworkViewUrl(entry, "/scheduled/manage");
    if (page.url() !== target) await page.goto(target, { waitUntil: "domcontentloaded" });
    assertCurrent();
    if (page.url() !== target) throw Object.assign(new Error("Native automation view changed."),
        { code: "NATIVE_HISTORY_CONTROL_UNQUALIFIED" });
}

export async function openNativeCoworkParent(page, parent, assertCurrent) {
    const fail = () => Object.assign(new Error("Native automation control is unavailable."),
        { code: "NATIVE_HISTORY_CONTROL_UNQUALIFIED" });
    if (!["scheduled", "event"].includes(parent?.kind) || typeof parent.id !== "string" || !parent.id.length) throw fail();
    const rowKey = (parent.kind === "scheduled" ? "schedule:" : "trigger:") + parent.id;
    const row = page.locator(`[data-automation-list] [data-automation-row=${JSON.stringify(rowKey)}]`).filter({ visible: true });
    assertCurrent();
    await row.waitFor({ state: "visible" });
    assertCurrent();
    if (await row.count() !== 1 || !await row.evaluate(node => !node.closest('[inert],[aria-disabled="true"]'))) throw fail();
    assertCurrent();
    await row.press("Enter");
    assertCurrent();
    await page.waitForFunction(({ kind, id }) => {
        const prefix = kind === "scheduled" ? "#/scheduled/manage/" : "#/scheduled/manage/trigger/";
        if (!location.hash.startsWith(prefix)) return false;
        try { return decodeURIComponent(location.hash.slice(prefix.length)) === id; } catch { return false; }
    }, { kind: parent.kind, id: parent.id });
    assertCurrent();
}

export async function revealNativeCoworkRuns(page, assertCurrent) {
    assertCurrent();
    const result = await page.evaluate(() => {
        const roots = [...document.querySelectorAll('[data-section-label="runs"]')]
            .filter(node => node.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
        if (roots.length !== 1) return "unavailable";
        const lists = [...roots[0].querySelectorAll('ul[role="list"]')]
            .filter(node => node.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
        if (lists.length !== 1) return "unavailable";
        if (lists[0].getAttribute("aria-busy") === "true") return "loading";
        const footer = lists[0].nextElementSibling, sentinel = footer?.firstElementChild;
        if (footer?.tagName !== "DIV" || sentinel?.tagName !== "DIV" || sentinel.getAttribute("aria-hidden") !== "true") return "unavailable";
        footer.scrollIntoView({ block: "end", behavior: "instant" });
        return "revealed";
    });
    assertCurrent();
    return result;
}

export async function openNativeCoworkConversation(page, entry, conversationId, assertCurrent) {
    if (typeof conversationId !== "string" || !conversationId.length || conversationId.length > 1024) {
        throw Object.assign(new Error("Native conversation identity is unavailable."), { code: "NATIVE_HISTORY_CONTROL_UNQUALIFIED" });
    }
    assertCurrent();
    await page.goto(coworkViewUrl(entry, "/task/" + encodeURIComponent(conversationId)), { waitUntil: "domcontentloaded" });
    assertCurrent();
}

export async function clickNativeHistoryLink(page, { surface, id = null, tenantId, subjectId, revealOnly = false,
    initialize = false, observe, taskRows } = {}) {
    const unqualified = () => Object.assign(new Error("NATIVE_HISTORY_CONTROL_UNQUALIFIED"), { code: "NATIVE_HISTORY_CONTROL_UNQUALIFIED" });
    const refuseControl = async match => {
        const failure = unqualified();
        try {
            await observe?.({ phase: "selection", target: null, failure,
                control: { match, name: "unobserved", selected: "unobserved" } });
        } catch {
            console.error("[workiq-native] history control observation unavailable", { code: "NATIVE_HISTORY_OBSERVATION_WRITE_FAILED" });
        }
        throw failure;
    };
    if (!["chat", "cowork"].includes(surface) || id !== null && (typeof id !== "string" || id.length > 1024)
        || initialize && (id !== null || revealOnly)) {
        throw unqualified();
    }
    const links = page.locator("a[href]").filter({ visible: true });
    const matches = await links.evaluateAll((nodes, selection) => nodes.flatMap(node => {
        const href = node.getAttribute("href");
        if (!href || href.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(href)) return [];
        let url;
        try { url = new URL(href, location.href); } catch { return []; }
        if (!["https://m365.cloud.microsoft", "https://copilot.cloud.microsoft"].includes(url.origin)
            || url.username || url.password) return [];
        const pathname = url.pathname.replace(/^\/hwav2(?=\/)/, "");
        let matches = false;
        if (selection.id === null) {
            matches = selection.surface === "chat" ? pathname === "/chat/all"
                : (pathname === "/cowork" || pathname === "/cowork/") && ["", "#", "#/"].includes(url.hash)
                    && !["sessionId", "threadId", "taskId", "conversationId"].some(key => url.searchParams.has(key));
        } else if (selection.surface === "chat") {
            try { matches = pathname.startsWith("/chat/conversation/")
                && decodeURIComponent(pathname.slice("/chat/conversation/".length)) === selection.id; }
            catch { return []; }
        } else {
            const composite = `${selection.tenantId}:${selection.subjectId}:${selection.id}`;
            try { matches = pathname === `/cowork/${selection.id}`
                || ["/cowork", "/cowork/"].includes(pathname)
                    && decodeURIComponent(url.hash) === `#/task/${composite}`; }
            catch { return []; }
        }
        return matches ? [href] : [];
    }), { surface, id, tenantId, subjectId });
    const unique = [...new Set(matches)];
    if (unique.length === 0 && surface === "cowork" && id !== null && typeof taskRows === "function") {
        const expectedUrl = page.url();
        const guard = async kind => {
            await taskRows(kind);
            if (page.url() !== expectedUrl) throw unqualified();
        };
        await guard("task");
        const candidates = [`${tenantId}:${subjectId}:${id}`, `feed-${id}`].map(rowId =>
            `ul[role="list"]:not([aria-busy="true"]) > li[data-row-id=${JSON.stringify(rowId)}]`).join(",");
        try { await page.locator(candidates).filter({ visible: true }).first().waitFor({ state: "visible" }); }
        catch (error) { if (error.name === "TimeoutError") throw unqualified(); throw error; }
        await guard("task");
        const rows = await page.locator('ul[role="list"] > li[data-row-id]').filter({ visible: true }).evaluateAll((nodes, selection) =>
            nodes.flatMap(node => {
                const rowId = node.getAttribute("data-row-id");
                const kind = rowId === `${selection.tenantId}:${selection.subjectId}:${selection.id}` ? "task"
                    : rowId === `feed-${selection.id}` ? "feed" : null;
                return kind ? [{ rowId, kind }] : [];
            }), { id, tenantId, subjectId });
        if (rows.length !== 1) throw unqualified();
        const { rowId, kind } = rows[0];
        const row = page.locator(`ul[role="list"] > li[data-row-id=${JSON.stringify(rowId)}]`).filter({ visible: true });
        await guard(kind);
        if (await row.count() !== 1 || !await row.evaluate(node =>
            !node.closest('[inert], [aria-disabled="true"]') && node.parentElement.getAttribute("aria-busy") !== "true"
            && !node.querySelector("[data-select-checkbox]"))) throw unqualified();
        await guard(kind);
        if (revealOnly) {
            const revealed = await row.evaluate((node, expected) => {
                if (location.href !== expected) return false;
                const footer = node.parentElement.nextElementSibling, sentinel = footer?.firstElementChild;
                if (footer?.tagName !== "DIV" || sentinel?.tagName !== "DIV"
                    || sentinel.getAttribute("aria-hidden") !== "true") return false;
                footer.scrollIntoView({ block: "end", behavior: "instant" });
                return true;
            }, expectedUrl);
            if (!revealed) throw unqualified();
        } else await row.press("Enter");
        if (revealOnly) await guard(kind);
        return { kind: "cowork-task-row" };
    }
    if (unique.length !== 1) return refuseControl(unique.length ? "ambiguous" : "missing");
    const control = page.locator(`a[href=${JSON.stringify(unique[0])}]`).filter({ visible: true });
    if (await control.count() !== 1) return refuseControl("ambiguous");
    const href = await control.getAttribute("href");
    if (href !== unique[0]) throw unqualified();
    let viewTarget = null;
    if (observe) {
        const selected = await control.evaluate(node => {
            const label = node.getAttribute("aria-label") ?? node.textContent ?? "";
            const name = label.length <= 80 ? label.trim().toLowerCase().replace(/\s+/g, " ") : "";
            const labels = { history: "history", "all history": "all-history", "all chats": "all-chats", chat: "chat", cowork: "cowork" };
            const current = node.getAttribute("aria-current") ?? node.getAttribute("aria-selected");
            const target = node.getAttribute("aria-controls");
            return { control: { match: "unique", name: Object.hasOwn(labels, name) ? labels[name] : "unobserved",
                selected: ["true", "page"].includes(current) ? "yes" : current === "false" ? "no" : "unobserved" },
            target: target && target.length <= 128 ? target : null };
        });
        viewTarget = selected.target;
        await observe({ phase: "selection", target: new URL(href, page.url()).href, viewTarget, control: selected.control });
    }
    if (observe) await observe({ phase: "invoking" });
    if (revealOnly) await control.scrollIntoViewIfNeeded();
    else if (initialize) {
        const destination = new URL(href, page.url()).href;
        const response = await page.goto(destination, { waitUntil: "domcontentloaded" });
        if (response === null) {
            if (page.url() !== destination) throw unqualified();
            if (observe) await observe({ phase: "invoking" });
            await page.reload({ waitUntil: "domcontentloaded" });
        }
    }
    else await control.click();
    if (observe) {
        await observe({ phase: "settled", view: await readNativeHistoryView(page, viewTarget) });
    }
}

export async function revealNativeOlderMessages(page, expectedUrl, assertCurrent) {
    assertCurrent();
    const state = await page.evaluate(expected => {
        if (location.href !== expected) return "changed";
        const visible = node => node.checkVisibility({ visibilityProperty: true, opacityProperty: true });
        const regions = [...document.querySelectorAll('[data-chat-scroll-container="true"]')].filter(visible);
        if (regions.length === 0) return "pending";
        if (regions.length !== 1) return "unqualified";
        const region = regions[0];
        if (region.getAttribute("role") !== "region"
            || !["legacy", "virtualized"].includes(region.getAttribute("data-timeline-body"))) return "unqualified";
        const loaders = [...region.querySelectorAll("[data-older-messages-loader]")].filter(visible);
        if (loaders.length === 0) return "pending";
        if (loaders.length !== 1) return "unqualified";
        if (loaders[0].querySelector('[role="status"]')) return "loading";
        region.scrollTo({ top: 0, behavior: "instant" });
        return "revealed";
    }, expectedUrl);
    assertCurrent();
    if (state === "changed" || state === "unqualified") {
        const code = state === "changed" ? "NATIVE_SOURCE_DOCUMENT_CHANGED" : "NATIVE_HISTORY_CONTROL_UNQUALIFIED";
        throw Object.assign(new Error(code), { code });
    }
    return state;
}

export async function readNativeHistoryView(page, viewTarget) {
    return page.evaluate(target => {
        const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
        const name = node => {
            const label = node.getAttribute("aria-label") ?? node.textContent ?? "";
            return label.length <= 80 ? label.trim().toLowerCase().replace(/\s+/g, " ") : "";
        };
        const result = { region: "unobserved", heading: "unobserved", search: "unobserved", filter: "unobserved" };
        let regions = target ? [...document.querySelectorAll(`[id=${JSON.stringify(target)}]`)].filter(visible) : [];
        if (regions.length === 1) result.region = "controlled";
        else if (regions.length > 1) { result.region = "ambiguous"; return result; }
        else {
            regions = [...document.querySelectorAll("main,[role=main]")].filter(visible);
            if (regions.length !== 1) { result.region = regions.length ? "ambiguous" : "unobserved"; return result; }
            result.region = "main";
        }
        const root = regions[0], nodes = root.querySelectorAll("h1,h2,[role=heading],input[type=search],[role=searchbox],[role=tab],[role=option],[role=radio],select,[role=combobox],[aria-pressed]");
        if (nodes.length > 64) return { ...result, search: "ambiguous", filter: "ambiguous" };
        const all = [...nodes].filter(visible), headings = all.filter(node => node.matches("h1,h2,[role=heading]"));
        const headingsByName = { history: "history", "all history": "all-history", "all chats": "all-chats" };
        if (headings.length === 1 && Object.hasOwn(headingsByName, name(headings[0]))) result.heading = headingsByName[name(headings[0])];
        const searches = all.filter(node => node.matches("input[type=search],[role=searchbox]"));
        if (searches.length > 1) result.search = "ambiguous";
        else if (searches.length === 1 && typeof searches[0].value === "string") result.search = searches[0].value.length ? "nonempty" : "empty";
        const filters = all.filter(node => node.matches("[role=tab],[role=option],[role=radio],select,[role=combobox],[aria-pressed]"));
        const selected = filters.filter(node => ["aria-selected", "aria-checked", "aria-pressed"].some(key => node.getAttribute(key) === "true"));
        if (selected.length > 1) result.filter = "ambiguous";
        else if (selected.length === 1 && ["all", "all history", "all chats"].includes(name(selected[0]))) result.filter = "all-selected";
        else if (filters.length) result.filter = "restricted-or-unknown";
        return result;
    }, viewTarget);
}
