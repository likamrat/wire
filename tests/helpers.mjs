import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { replaceEvidence } from "../lib/store.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";
import { collectorFor } from "../lib/collector.mjs";
import { AUTOMATIC_SCORE_METHOD, planAutomaticScore } from "../lib/automatic-score-policy.mjs";

// Fake-HTTP UI fixtures only; real runtimes must provide their own handshake descriptor.
export const UNBOUND_FIXTURE_BOOTSTRAP = Object.freeze({
    schemaVersion: 1, mode: "unbound", runtimeId: "00000000-0000-4000-8000-000000000001",
});

export function automaticScoreOffSummary() {
    return {
        schemaVersion: 1, approvalRevision: 0, source: null, method: AUTOMATIC_SCORE_METHOD,
        snapshot: { ...planAutomaticScore({ approval: null }), approval: null,
            usage: { callsReserved: 0, spentAiCredits: 0, costUnknown: false, active: false, cleanupPending: false } },
    };
}

export function exportCatalogFor(records) {
    const { requests, excluded } = buildExportCatalog(records);
    return { requests, excluded };
}

export async function completeNativeScroll(page, scroll, action) {
    const completion = await scroll.evaluateHandle(node => {
        const start = node.scrollLeft, state = { done: false };
        const finish = () => {
            if (node.scrollLeft === start) return;
            state.done = true;
            node.removeEventListener("scrollend", finish);
        };
        state.dispose = () => node.removeEventListener("scrollend", finish);
        node.addEventListener("scrollend", finish);
        return state;
    });
    try {
        await action();
        await page.waitForFunction(state => state.done, completion);
    } finally {
        await completion.evaluate(state => state.dispose());
        await completion.dispose();
    }
}

export async function navigateMain(page, view) {
    await closeAnalyzeFilters(page);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    async function revealNavigation() {
        const trigger = page.locator("#navigationToggle");
        if (await trigger.isVisible() && await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
    }
    if (view === "collection-status") {
        const link = page.locator('a[href^="#collection-status"]:visible').first();
        if (await link.count()) await link.click();
        else {
            await revealNavigation();
            await page.locator('nav [data-nav="settings"]').click();
            await page.locator('a[href^="#collection-status"]:visible').first().click();
        }
        return;
    }
    await revealNavigation();
    await page.locator(`nav [data-nav=${["home", "activity", "overview"].includes(view) ? "analyze" : view}]`).click();
}

export async function revealStoredRefresh(page) {
    // Collection actions live in the existing Settings task, never in navigation.
    const retry = page.locator("#refreshBtn:visible, #collectionRetry:visible, [data-stored-refresh-retry]:visible").first();
    if (await retry.count()) return retry;
    if (!await page.locator("#checkActivity").isVisible()) {
        await navigateMain(page, "settings");
        await navigateSettings(page, "connection");
    }
    if (await retry.count()) return retry;
    return page.locator("#checkActivity");
}

export async function restoreLegacySearch(page, search) {
    await page.evaluate(search => {
        history.replaceState({ ...history.state, evidenceView: { ...history.state?.evidenceView, url: location.hash, search } }, "");
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    }, search);
    await page.waitForFunction(search => document.querySelector("#activitySearch").value === search
        && document.querySelector("#workspace").getAttribute("aria-busy") === "false", search);
}

export async function navigateSettings(page, category) {
    category = { collection: "connection", history: "connection", data: "privacy", evidence: "privacy" }[category] || category;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const link = page.locator(`#settingsCategoryNav [data-category=${category}]`);
    if (!await link.isVisible()) await page.locator("#settingsCategorySummary").click();
    await link.click();
    await page.locator(`[data-settings-section=${category}]`).waitFor({ state: "visible" });
}

export async function openSourceEditor(page) {
    const inspect = page.locator("#viewApprovedSource");
    if (await inspect.isVisible()) await inspect.click();
    await page.locator("#editSource").click();
}

// Compatibility helper: Analyze already renders matching interactions directly.
export async function openActivitySessions(page) {
    await closeAnalyzeFilters(page);
    if (!await page.locator("#activityView").isVisible()) return;
    const closed = page.locator(".session-toggle[aria-expanded=false]");
    while (await closed.count()) await closed.first().click();
}

export async function chooseTheme(page, value) {
    const theme = value.toLowerCase();
    if (!["light", "dark"].includes(theme)) throw new TypeError("Theme fixtures require light or dark.");
    const filterOpen = await page.locator("#analyzeFilterDialog").count() && await page.locator("#analyzeFilterDialog").evaluate(node => node.open);
    if (filterOpen) await closeAnalyzeFilters(page);
    if (await page.locator("html").getAttribute("data-evidence-theme") !== theme) {
        await page.getByRole("switch", { name: "Dark theme", exact: true }).click();
    }
    await page.waitForFunction((expected) => document.documentElement.dataset.evidenceTheme === expected, theme);
    if (filterOpen) await openAnalyzeFilters(page);
}

export async function openAnalyzeFilters(page) {
    const trigger = page.locator("#openAnalyzeFilters");
    if (await trigger.count() && await trigger.isVisible() && await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
}

export async function closeAnalyzeFilters(page) {
    const close = page.locator("#closeAnalyzeFilters");
    if (await close.count() && await close.isVisible()) {
        await close.click();
        await page.locator("#analyzeFilterDialog").waitFor({ state: "hidden" });
    }
}

export async function revealAnalyzeRecords(page) {
    await closeAnalyzeFilters(page);
    if (!await page.locator("#activityView").isVisible()
        || await page.locator("#contextSidebar").evaluate(node => node.open)
        || await page.locator("#navigationDrawer").evaluate(node => node.open)) {
        await navigateMain(page, "analyze");
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").open
            && !document.querySelector("#navigationDrawer").open);
    }
    const summary = page.locator("#activityListSummary");
    await summary.focus();
    await page.locator("#activityListContext").evaluate(node => node.scrollIntoView({ block: "start" }));
}

export async function revealSavedDataRead(page) {
    if (!await page.locator("#collectionStatusView").isVisible()) {
        await navigateMain(page, "settings");
        await navigateSettings(page, "connection");
        await page.locator("#settingsStatusLink a").click();
    }
    if (!await page.locator("#collectionSetup").evaluate(node => node.open)) {
        await page.locator("#collectionSetup > summary").click();
    }
    return page.locator("#freshStoredRead");
}

export async function selectActivityOption(page, id, value) {
    const trigger = page.locator(`[data-select-id=${JSON.stringify(id)}]`);
    if (["wireSearchScope", "wireSearchType"].includes(id)) {
        if (await page.locator("#" + id).inputValue() === value) return;
        await openSearchFilters(page);
    }
    if (!await trigger.isVisible() && await page.locator("#filters").locator(`[data-select-id=${JSON.stringify(id)}]`).count()) await openAnalyzeFilters(page);
    if (!await trigger.isVisible() && await page.locator("#moreFilters").locator(`[data-select-id=${JSON.stringify(id)}]`).count()) await page.locator("#moreFilters > summary").click();
    if (!await trigger.isVisible() && ["collectionWindow", "collectionCadence"].includes(id)) await navigateSettings(page, "connection");
    await trigger.click();
    if (await page.locator(`#${id}`).evaluate(node => node.multiple)) {
        const values = await page.locator(`#${id} option`).evaluateAll(nodes => nodes.map(node => node.value));
        const wanted = value === "all" ? values : Array.isArray(value) ? value : [String(value)];
        for (const item of values) {
            const row = page.locator(`.select-popup .select-option[data-value=${JSON.stringify(item)}]`);
            if ((await row.getAttribute("aria-selected") === "true") !== wanted.includes(item)) await row.click();
        }
        await page.getByRole("button", { name: "Apply", exact: true }).click();
        return;
    }
    await page.locator(`.select-popup .select-option[data-value=${JSON.stringify(String(value))}]`).click();
}

export async function setLegacyTimeBucket(page, bucket) {
    await page.evaluate(async bucket => {
        const [view, query = ""] = location.hash.split("?");
        const params = new URLSearchParams(query);
        params.set("bucket", bucket);
        const hash = `${view || "#analyze"}?${params}`;
        if (hash === location.hash) return;
        await new Promise(resolve => {
            addEventListener("hashchange", () => requestAnimationFrame(resolve), { once: true });
            location.hash = hash;
        });
    }, bucket);
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
}

export async function openSearchFilters(page) {
    await closeAnalyzeFilters(page);
    await page.locator("#wireSearch").focus();
    await page.locator(".wire-search-filters").waitFor({ state: "visible" });
}

// These invented records exist only in isolated tests, never in application data.
export function fixture(id = "test-scenario") {
    return {
        scenarioId: id, title: "Synthetic calendar request", sourceSessionId: "test-session",
        projectId: "test-project", project: "Synthetic project", sourceHost: "copilot-app",
        capturedAt: "2026-09-30T12:00:00.000Z", workloadKind: "recorded-history", family: "reads_functions",
        userPrompt: { text: "SYNTHETIC_PRIVATE_PROMPT owner: Example Person email@example.invalid", status: "full", provenance: "human-authored" },
        followUpPrompts: [{ text: "SYNTHETIC_PRIVATE_FOLLOWUP", status: "full", provenance: "human-authored" }],
        toolCalls: [{
            tool: "workiq-fetch", toolCallId: `test-call-${id}`, startEventId: `test-start-${id}`,
            requestArgs: { entityUrls: ["/me/calendarView?$filter=SYNTHETIC_LITERAL"] },
            requestedApiPath: "/me/calendarView", toolSucceeded: true, reportedOutcome: "succeeded",
            apiResults: [{ index: 0, statusCode: 200, evidenceLevel: "intermediary-reported" }],
            observedGraphHttp: false,
        }],
        evidenceLayer: "workiq-intermediary", sourceEligibility: { archivedAt: null },
        sample: false,
    };
}

export async function privateFixture(t, records = [fixture()]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "workiq-evidence-test-"));
    const context = { dataDir: path.join(root, "data"), sessionId: "test-session" };
    t.after(async () => { await collectorFor(context)?.close(); await rm(root, { recursive: true, force: true }); });
    await replaceEvidence(context, () => ({ records, importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    return { root, context };
}
