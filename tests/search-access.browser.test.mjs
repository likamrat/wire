import test from "node:test";
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { createBoardTransport } from "../lib/client-transport.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createSearchWireContract, searchWireContract } from "../lib/search-wire-contract.mjs";
import { createLiveSearchState } from "../web/live-search-state.mjs";
import { mountLiveSearch, liveSearchMarkup, liveSearchStyles, searchHitPresentation, createFrozenReportFrame } from "../web/live-search.mjs";
import { createSearchFields, searchFieldStyles } from "../web/search-field.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { privateFixture } from "./helpers.mjs";
import { createMicrosoftNativeHost } from "../lib/microsoft-native-host.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";

test("unenrolled Microsoft Search cannot retire valid GitHub access in the ordinary source-aware app", async t => {
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) });
    let host, runtime, browser;
    const errors = [], nativeRequests = [], external = [];
    t.after(async () => {
        try {
            await browser?.close();
            await runtime?.close();
            await host?.close();
        } finally { for (const action of cleanup.reverse()) await action(); }
    });
    runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        createAccess: async () => {
            host = await createMicrosoftNativeHost(context, { configuration: null, ordinaryStartup: true,
                sourceAware: true, nativeAcquisition: false });
            return host.access;
        },
    });
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const route = new URL(request.url()).pathname;
        if (route.startsWith("/api/retained/microsoft/")) nativeRequests.push(route);
    });
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === new URL(runtime.url).origin) return route.continue();
        external.push(new URL(route.request().url()).origin);
        return route.abort();
    });
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#collectionNoticeText")).toHaveText("Connect a source in Settings.");
    await expect(page.locator("#collectionNoticeText")).not.toContainText("status is unavailable");
    await page.locator("#wireSearch").fill("workiq-fetch");
    await expect(page.locator("#wireSearchResults button").first()).toBeVisible();
    await expect(page.locator("#wireNativeSearch")).toContainText("Microsoft saved activity is unavailable for Search.");
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#wireSearch")).toBeEnabled();
    assert.deepEqual(nativeRequests, [], "Unavailable native membership is not permission to query the Microsoft reader.");
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
});

// The accepted base predates shared transport access methods. This fixture adds
// only their control seam; private queries/events still use the real transport/runtime.
async function setup(t, { initialAccess = true, initialMode = "enforced", partial = false } = {}) {
    const cleanup = [], app = await searchFixture({ after: action => cleanup.push(action) }, {
        formats: ["html"], reply: false, ...(partial ? { records: searchRecords(24) } : {}),
    });
    if (partial) await appendFile(app.bundles[0].files["product-report.html"], "\nSynthetic changed report.");
    const revision = (await loadBoardState(app.context)).revision;
    const browser = await chromium.launch(), page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/search/")) requests.push(new URL(request.url()).pathname); });
    t.after(async () => {
        await browser.close(); for (const close of cleanup) await close();
        assert.deepEqual(errors, []);
    });
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(app.runtime.url).origin) return route.abort();
        if (url.pathname !== "/") return route.continue();
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head>
<style>${styles}${searchFieldStyles}${liveSearchStyles}</style></head><body>
${liveSearchMarkup}<button id="outside">Outside Search</button><div id="document"></div>
<script>
(async () => {
    const session = await (await fetch("/api/session", {method:"POST",headers:{"Content-Type":"application/json","X-Wire-Session-Protocol":"1"},body:"{}"})).json();
    const base = (${createBoardTransport})(session.capability, undefined, session.accessBootstrap);
    const contract = (${createSearchWireContract})(${JSON.stringify({ matchPolicyId: searchWireContract.matchPolicyId, types: searchWireContract.allTypes })});
    const ux = (${createEvidenceUX})(${JSON.stringify(uxIcons).replaceAll("<", "\\u003c")});
    const model = (${createLiveSearchState})(contract);
    let ready = ${initialAccess}, accessMode = ${JSON.stringify(initialMode)}, token = {}, ui, holdEvents = false, held = [], holdNavigation = false, holdDocument = false;
    let releaseNavigation, releaseDocument, rejectQuery, holdQuery = false, pendingQuery = false, expireOnPresentation = false;
    let navigations = 0, documents = 0, withdrawals = 0, analysis = [], retainedDocument = null;
    const api = async (...args) => {
        const result = await base(...args);
        if (holdQuery && args[0] === "/api/search/query") {
            pendingQuery = true;
            await new Promise((resolve, reject) => { rejectQuery = reject; });
        }
        return result;
    };
    api.publicationToken = () => ready ? token : null;
    api.isCurrent = value => ready && value !== null && value === token;
    api.accessState = () => Object.freeze({ mode: accessMode, readable: ready });
    api.searchEvents = (receive, options) => base.searchEvents(event => {
        if (holdEvents && ["results","opened"].includes(event.event)) held.push(() => receive(event));
        else receive(event);
    }, options);
    ui = (${mountLiveSearch})({
        api, contract, ux, searchFields: (${createSearchFields})(ux), createState: () => model,
        results: (${createRecordedResults})(), presentHit(hit, options) {
            if (expireOnPresentation) { expireOnPresentation = false; ready = false; }
            return (${searchHitPresentation})(hit, options);
        },
        serviceIcon: () => ux.icon("search-service"),
        getAnalysis: () => ({revision:${revision},key:"synthetic-scope",active:true,pending:false}),
        onAnalysis: update => analysis.push(update),
        async navigate(value, {isCurrent}) {
            if (holdNavigation) await new Promise(resolve => { releaseNavigation = resolve; });
            if (!isCurrent()) return false;
            navigations++; history.pushState({destination:value.href}, "", value.href);
            document.getElementById("outside").focus();
            return true;
        },
        async presentDocument(value, {isCurrent}) {
            if (holdDocument) await new Promise(resolve => { releaseDocument = resolve; });
            if (!isCurrent()) return false;
            retainedDocument = {value,isCurrent}; documents++;
            const frame = (${createFrozenReportFrame})(value.text);
            document.getElementById("document").replaceChildren(frame);
            document.getElementById("outside").focus();
            return true;
        },
        onInvalidateOpen(options) {
            if (options?.accessWithdrawn) withdrawals++;
            retainedDocument = null;
            document.getElementById("document").replaceChildren();
            if (options?.accessWithdrawn) analysis = [];
        },
    });
    window.proof = {
        ui, model, api,
        revoke() { ready = false; token = {}; ui.withdrawAccess(); },
        grant() { ready = true; token = {}; return ui.resumeAccess(); },
        replaceConnection(mode) {
            if (accessMode !== "unbound" || mode !== "unbound") token = {};
            accessMode = mode; ui.sessionChanged();
        },
        expire() { ready = false; },
        expireOnPresentation() { expireOnPresentation = true; },
        holdEvents() { holdEvents = true; },
        releaseEvents() { holdEvents = false; const events = held; held = []; events.forEach(deliver => deliver()); },
        holdNavigation() { holdNavigation = true; },
        releaseNavigation() { holdNavigation = false; releaseNavigation?.(); },
        holdDocument() { holdDocument = true; },
        releaseDocument() { holdDocument = false; releaseDocument?.(); },
        holdQuery() { holdQuery = true; },
        rejectQuery() { holdQuery = false; rejectQuery?.(new Error("PRIVATE retired failure")); },
        status() { return {held:held.length,navigations,documents,withdrawals,analysis:analysis.length,
            pendingNavigation:Boolean(releaseNavigation),pendingDocument:Boolean(releaseDocument),pendingQuery,
            retainedDocument:Boolean(retainedDocument),validDocument:retainedDocument?.isCurrent() ?? false}; },
    };
})();
</script></body></html>` });
    });
    await page.goto(app.runtime.url);
    await page.waitForFunction(() => window.proof);
    return { page, requests, runtime: app.runtime };
}

async function empty(page) {
    await expect(page.locator("#wireSearch")).toHaveValue("");
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await expect(page.locator("#wireSearchResults")).toBeEmpty();
    await expect(page.locator("#wireSearchPaging")).toBeEmpty();
    await expect(page.locator("#wireSearchCount")).toBeEmpty();
    await expect(page.locator("#wireSearchCoverage")).toBeEmpty();
    await expect(page.locator("#wireSearchStatus")).toBeEmpty();
    await expect(page.locator("#document")).toBeEmpty();
    assert.deepEqual(await page.evaluate(() => ({
        hits: proof.model.snapshot().matches.hits.length, receipt: proof.model.snapshot().matches.receipt,
        analysis: proof.ui.analysisPreparation(), returnKey: proof.ui.returnKey(), document: proof.status().retainedDocument,
    })), { hits: 0, receipt: null, analysis: null, returnKey: null, document: false });
}

test("known collection fences coalesce read refreshes and respect hidden, analytical and withdrawn Search", async t => {
    const { page, requests, runtime } = await setup(t);
    const queries = () => requests.filter(path => path === "/api/search/query").length;
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    const before = queries();
    for (let index = 0; index < 3; index++) runtime.search.invalidate("collected");
    await expect.poll(queries).toBe(before + 1);
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    assert.equal(queries(), before + 1);
    runtime.search.invalidate("changed");
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    assert.equal(queries(), before + 1, "Unknown changes cannot replay a query automatically.");
    await page.locator("#wireSearchRetry").click();
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    await page.locator("#outside").click();
    const hidden = queries();
    runtime.search.invalidate("collected");
    await expect.poll(() => page.evaluate(() => proof.model.snapshot().state)).toBe("refreshing");
    assert.equal(queries(), hidden);
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await page.locator("#wireSearch").click();
    await expect.poll(queries).toBe(hidden + 1);
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    await page.evaluate(() => proof.ui.analysisScope());
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    const analysis = queries();
    runtime.search.invalidate("collected");
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    assert.equal(queries(), analysis, "Analysis membership cannot rebind independently of its owning scope.");
    await page.evaluate(() => proof.revoke());
    runtime.search.invalidate("collected");
    await empty(page);
    assert.equal(queries(), analysis);
});

test("initial false access and idle withdrawal erase Search without requests, focus or return replay", async t => {
    const { page, requests } = await setup(t, { initialAccess: false });
    await empty(page);
    await expect(page.locator("#wireSearch")).toBeDisabled();
    assert.deepEqual(requests, []);
    await page.evaluate(() => proof.grant());
    assert.deepEqual(requests, [], "Readiness alone cannot start Search");
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    const readableRequests = requests.length;
    await page.evaluate(() => proof.ui.resumeAccess());
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    assert.equal(requests.length, readableRequests, "Readiness with unchanged authority does not disturb retained reading");
    const result = page.locator(".wire-search-hit[data-search-type=interaction]").first();
    await result.click();
    await expect.poll(() => page.evaluate(() => proof.status().navigations)).toBe(1);
    await page.goBack();
    await expect(result).toBeFocused();
    const oldKey = await page.evaluate(() => proof.ui.returnKey());
    assert.ok(oldKey);
    await page.locator("#outside").focus();
    const before = requests.length;
    await page.evaluate(() => { proof.revoke(); proof.ui.withdrawAccess(); });
    await empty(page); await expect(page.locator("#outside")).toBeFocused();
    assert.equal(await page.evaluate(() => proof.status().withdrawals), 2, "One initial withdrawal and one later withdrawal, not duplicate callbacks");
    await page.evaluate(oldKey => {
        proof.grant(); proof.ui.restore(oldKey); proof.ui.changed();
        dispatchEvent(new PageTransitionEvent("pageshow")); dispatchEvent(new PopStateEvent("popstate"));
    }, oldKey);
    await empty(page);
    await page.waitForTimeout(180);
    assert.equal(requests.length, before, "Neither withdrawal nor restored access replays query/open/return work");
    await page.locator("#wireSearch").fill("mechanic");
    await expect(page.locator(".wire-search-hit").first()).toContainText("mechanic");
});

test("withdrawal cancels the pre-dispatch debounce and fences held old events after same-backend readiness", async t => {
    const { page, requests } = await setup(t);
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    const before = requests.length;
    await page.evaluate(() => {
        const input = document.getElementById("wireSearch");
        input.value = "PRIVATE queued query"; input.dispatchEvent(new Event("input"));
        proof.revoke(); proof.grant();
    });
    await page.waitForTimeout(180);
    assert.equal(requests.length, before);
    await empty(page);
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    const beforeExpiry = requests.length;
    await page.evaluate(() => {
        const input = document.getElementById("wireSearch");
        input.value = "PRIVATE expired queued query"; input.dispatchEvent(new Event("input"));
        proof.expire();
    });
    await page.waitForTimeout(180);
    await empty(page);
    assert.equal(requests.length, beforeExpiry, "Dispatch checks freshness even before a withdrawal notification");
    await page.evaluate(() => proof.grant());
    await page.evaluate(() => proof.holdEvents());
    await page.locator("#wireSearch").fill("mechanic");
    await expect.poll(() => page.evaluate(() => proof.status().held)).toBeGreaterThan(0);
    const heldRequests = requests.length;
    await page.evaluate(() => { proof.revoke(); proof.grant(); proof.releaseEvents(); });
    await empty(page);
    assert.equal(requests.length, heldRequests);
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
});

test("held opened events and detached result actions cannot revive old private targets", async t => {
    const { page, requests } = await setup(t);
    await page.locator("#wireSearch").fill("physician");
    const row = page.locator(".wire-search-hit[data-search-type=interaction]").first();
    await expect(row).toBeVisible();
    const retiredRow = await row.elementHandle();
    await page.evaluate(() => proof.holdEvents());
    await row.click();
    await expect.poll(() => page.evaluate(() => proof.status().held)).toBe(1);
    await page.locator("#outside").focus();
    const before = requests.length;
    await page.evaluate(() => { proof.revoke(); proof.grant(); proof.releaseEvents(); });
    await retiredRow.evaluate(node => node.click());
    await empty(page); await expect(page.locator("#outside")).toBeFocused();
    assert.equal(await page.evaluate(() => proof.status().navigations), 0);
    assert.equal(requests.length, before);
});

test("held query errors and expiry cannot repaint private failure or restart an owner", async t => {
    const { page, requests } = await setup(t);
    await page.evaluate(() => proof.holdQuery());
    await page.locator("#wireSearch").fill("physician");
    await expect.poll(() => page.evaluate(() => proof.status().pendingQuery)).toBe(true);
    await page.evaluate(() => { proof.revoke(); proof.grant(); proof.rejectQuery(); });
    await empty(page);
    await page.locator("#wireSearch").fill("mechanic");
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    const before = requests.length;
    await page.evaluate(() => { proof.expire(); proof.ui.changed(); });
    await empty(page); await expect(page.locator("#wireSearch")).toBeDisabled();
    assert.equal(requests.length, before);
    assert.match(await page.evaluate(() => {
        try { proof.ui.prepareAnalysis("PRIVATE old preparation"); } catch (error) { return error.message; }
    }), /access is unavailable/);
    await page.evaluate(() => { proof.ui.sessionChanged(); proof.ui.resumeAccess(); });
    await empty(page);
    assert.equal(requests.length, before);
});

test("freshness loss during result construction cannot append private rows after synchronous clearance", async t => {
    const { page, requests } = await setup(t);
    await page.evaluate(() => proof.expireOnPresentation());
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator("#wireSearch")).toBeDisabled();
    await empty(page);
    const before = requests.length;
    await page.evaluate(() => proof.grant());
    await empty(page);
    assert.equal(requests.length, before);
    await page.locator("#wireSearch").fill("mechanic");
    await expect(page.locator(".wire-search-hit").first()).toContainText("mechanic");
});

test("held route and saved-document continuations cannot navigate, publish or restore focus after withdrawal", async t => {
    const { page } = await setup(t);
    const input = page.locator("#wireSearch");
    await input.fill("physician");
    await expect(page.locator(".wire-search-hit[data-search-type=interaction]").first()).toBeVisible();
    await page.evaluate(() => proof.holdNavigation());
    await page.locator(".wire-search-hit[data-search-type=interaction]").first().click();
    await expect.poll(() => page.evaluate(() => proof.status().pendingNavigation)).toBe(true);
    await page.locator("#outside").focus();
    await page.evaluate(() => {
        proof.revoke(); proof.grant(); history.replaceState({wireSearchReturn:"new-owner-marker"}, "");
        proof.releaseNavigation();
    });
    await empty(page);
    await expect(page.locator("#outside")).toBeFocused();
    assert.equal(await page.evaluate(() => proof.status().navigations), 0);
    assert.equal(await page.evaluate(() => history.state.wireSearchReturn), "new-owner-marker");
    await input.fill("physician");
    const report = page.locator(".wire-search-hit[data-search-type=report]").first();
    await expect(report).toBeVisible(); await page.evaluate(() => proof.holdDocument());
    await report.click();
    await expect.poll(() => page.evaluate(() => proof.status().pendingDocument)).toBe(true);
    await page.locator("#outside").focus();
    await page.evaluate(() => { proof.revoke(); proof.grant(); proof.releaseDocument(); });
    await empty(page); await expect(page.locator("#outside")).toBeFocused();
    assert.equal(await page.evaluate(() => proof.status().documents), 0);
    await input.fill("physician"); await expect(report).toBeVisible();
    const reportIdentity = await report.evaluateHandle(node => node.getAttributeNode("data-search-bundle"));
    const reportLabel = await report.evaluateHandle(node => node.getAttributeNode("aria-label"));
    await report.click();
    await expect(page.locator("#document iframe")).toBeVisible();
    assert.equal(await page.evaluate(() => proof.status().validDocument), true);
    await page.evaluate(() => proof.revoke());
    await empty(page);
    assert.equal(await reportIdentity.evaluate(attribute => attribute.value), "");
    assert.equal(await reportLabel.evaluate(attribute => attribute.value), "");
});

test("withdrawal drops analytical preparation and hidden return intent without a new source request", async t => {
    const { page, requests } = await setup(t);
    await page.evaluate(() => proof.ui.prepareAnalysis("physician"));
    await page.locator("#wireSearch").focus();
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    assert.equal(await page.evaluate(() => proof.ui.analysisPreparation()), "physician");
    await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable:true, get:() => true });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    const before = requests.length;
    await page.evaluate(() => {
        proof.revoke(); proof.grant();
        Object.defineProperty(document, "hidden", { configurable:true, get:() => false });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await empty(page);
    await page.waitForTimeout(180);
    assert.equal(requests.length, before);
    await page.evaluate(() => proof.ui.prepareAnalysis("mechanic"));
    await page.locator("#wireSearch").click();
    await expect(page.locator(".wire-search-hit").first()).toContainText("mechanic");
});

test("only the current explicit unbound mode retains query intent through a fresh owner read", async t => {
    const { page, requests } = await setup(t, { initialMode: "unbound" });
    const input = page.locator("#wireSearch");
    await input.fill("physician");
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    const oldReceipt = await page.evaluate(() => proof.model.snapshot().matches.receipt);
    await page.evaluate(() => proof.replaceConnection("unbound"));
    await expect(input).toHaveValue("physician");
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    assert.notDeepEqual(await page.evaluate(() => proof.model.snapshot().matches.receipt), oldReceipt);
    const before = requests.length;
    await page.evaluate(() => proof.replaceConnection("enforced"));
    await empty(page);
    await page.evaluate(() => proof.ui.resumeAccess());
    await page.waitForTimeout(180);
    assert.equal(requests.length, before, "A currently enforced connection never inherits the original unbound query");
    await input.fill("mechanic");
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    await page.evaluate(() => proof.replaceConnection("unavailable"));
    await empty(page);
});

test("Search erases held generated Text and private Attr handles before replacement and withdrawal", async t => {
    const { page } = await setup(t, { partial: true });
    const input = page.locator("#wireSearch");
    await input.fill("Invented local");
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 1 of");
    await expect(page.locator("#wireSearchCoverage")).toHaveText("Some saved content could not be searched.");
    const hold = () => page.evaluateHandle(() => {
        const texts = [], attrs = [];
        for (const id of ["wireSearchResults", "wireSearchPaging", "wireSearchStatus", "wireSearchCount", "wireSearchCoverage"]) {
            const root = document.getElementById(id), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text; text = walker.nextNode()) if (text.data) texts.push(text);
            for (const node of root.querySelectorAll("*")) for (const name of ["aria-label", "title", "data-search-id", "data-search-bundle"]) {
                const attribute = node.getAttributeNode(name);
                if (attribute?.value) attrs.push(attribute);
            }
        }
        return { texts, attrs };
    });
    const retired = await hold();
    assert.ok(await retired.evaluate(value => value.texts.length > 20 && value.attrs.length > 20));
    await input.fill("mechanic");
    await expect(page.locator(".wire-search-hit").first()).toContainText("mechanic");
    assert.deepEqual(await retired.evaluate(value => ({
        text: value.texts.filter(node => node.data).length, attributes: value.attrs.filter(node => node.value).length,
    })), { text: 0, attributes: 0 });
    await page.evaluate(() => proof.ui.invalidate("PRIVATE synthetic read failure"));
    const oldStatus = await page.locator("#wireSearchStatus").evaluateHandle(node => node.firstChild);
    await page.evaluate(() => proof.ui.invalidate("Replacement failure"));
    assert.equal(await oldStatus.evaluate(node => node.data), "");
    const held = await hold();
    await page.locator("#outside").focus();
    await page.evaluate(() => { proof.revoke(); proof.ui.withdrawAccess(); });
    await empty(page);
    await expect(page.locator("#outside")).toBeFocused();
    assert.deepEqual(await held.evaluate(value => ({
        text: value.texts.filter(node => node.data).length, attributes: value.attrs.filter(node => node.value).length,
    })), { text: 0, attributes: 0 });
    await expect(page.locator("#wireSearchStatus")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("#wireSearchResults")).toHaveAttribute("aria-label", "Search results");
    await page.evaluate(() => proof.grant());
    await input.fill("physician");
    await expect(page.locator(".wire-search-hit").first()).toContainText("physician");
    const idle = await hold();
    await page.evaluate(() => proof.revoke());
    assert.deepEqual(await idle.evaluate(value => ({
        text: value.texts.filter(node => node.data).length, attributes: value.attrs.filter(node => node.value).length,
    })), { text: 0, attributes: 0 });
});

test("Search rejects asynchronous, absent and truthy publication contracts synchronously", async t => {
    const { page, requests } = await setup(t, { initialAccess: false });
    const accepted = await page.evaluate(() => {
        const { api, ui } = proof, token = {};
        const publicationToken = api.publicationToken, isCurrent = api.isCurrent;
        const cases = [
            { token: undefined, result: true }, { token: null, result: true },
            { token: Promise.resolve(token), result: true }, { token: { then() {} }, result: true },
            { token, result: Promise.resolve(true) }, { token, result: "true" }, { token, result: {} },
        ];
        const accepted = cases.map(value => {
            ui.withdrawAccess();
            api.publicationToken = () => value.token;
            api.isCurrent = () => value.result;
            return ui.resumeAccess();
        });
        api.publicationToken = publicationToken; api.isCurrent = isCurrent;
        return accepted;
    });
    assert.deepEqual(accepted, Array(7).fill(false));
    await empty(page); await expect(page.locator("#wireSearch")).toBeDisabled();
    assert.deepEqual(requests, []);
    await page.evaluate(() => proof.grant());
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    const before = requests.length;
    await page.evaluate(() => { proof.api.isCurrent = () => Promise.resolve(true); proof.ui.changed(); });
    await empty(page); await expect(page.locator("#wireSearch")).toBeDisabled();
    assert.equal(requests.length, before, "A Promise is not a current publication verdict for an active Search owner");
});

test("withdrawing authority callouts cannot rebind an originating private preparation to resumed access", async t => {
    const { page, requests } = await setup(t);
    const verdicts = await page.evaluate(() => {
        const { api, ui } = proof, publicationToken = api.publicationToken, isCurrent = api.isCurrent;
        return ["publicationToken", "isCurrent"].map(method => {
            api.publicationToken = publicationToken; api.isCurrent = isCurrent;
            ui.resumeAccess();
            const original = api[method];
            api[method] = (...args) => {
                const value = original(...args);
                api[method] = original;
                ui.withdrawAccess(); ui.resumeAccess();
                return value;
            };
            try { ui.prepareAnalysis("PRIVATE retired preparation"); return "accepted"; }
            catch { return "rejected"; }
        });
    });
    assert.deepEqual(verdicts, ["rejected", "rejected"]);
    await expect(page.locator("#wireSearch")).toHaveValue("");
    assert.deepEqual(requests, []);
});
