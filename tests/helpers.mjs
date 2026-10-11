import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { replaceEvidence } from "../lib/store.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";
import { collectorFor } from "../lib/collector.mjs";
import { AUTOMATIC_SCORE_METHOD, planAutomaticScore } from "../lib/automatic-score-policy.mjs";

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

export async function navigateMain(page, view) {
    const link = page.locator(`nav [data-nav=${view}]`);
    await page.waitForFunction(() => {
        const mobile = matchMedia("(max-width:699px)").matches;
        return document.querySelector("#navigationContent")?.parentElement?.id === (mobile ? "drawerContent" : "sidebar")
            && document.querySelector("#navigationToggle").hidden === !mobile;
    });
    if (!await link.isVisible()) await page.locator("#navigationToggle").click();
    await link.click();
}

export async function revealStoredRefresh(page) {
    const control = page.locator("#refreshBtn");
    if (await page.locator("#savedReportsPanel #refreshBtn").count() && !await page.locator("#savedReportsPanel").isVisible()) await page.locator("#reportLibraryLink").click();
    for (const id of ["freshHelp", "bundles", "savedLibraryHelp", "coverage"]) {
        const owner = page.locator(`#${id}`);
        if (await owner.locator("#refreshBtn").count() && !await owner.evaluate(node => node.open)) {
            await owner.locator(":scope > summary").click();
        }
    }
    return control;
}

export async function navigateSettings(page, category) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const link = page.locator(`#settingsCategoryNav [data-category=${category}]`);
    if (!await link.isVisible()) await page.locator("#settingsCategorySummary").click();
    await link.click();
    await page.locator(`[data-settings-section=${category}]`).waitFor({ state: "visible" });
}

// Tests inspecting request cards deliberately open the visible session groups.
// Default-closed behavior is exercised separately in disclosure.browser.test.mjs.
export async function openActivitySessions(page) {
    if (!await page.locator("#activityView").isVisible()) return;
    const closed = page.locator(".session-toggle[aria-expanded=false]");
    while (await closed.count()) await closed.first().click();
}

export async function chooseTheme(page, value) {
    const theme = value.toLowerCase();
    if (!["light", "dark"].includes(theme)) throw new TypeError("Theme fixtures require light or dark.");
    if (await page.locator("html").getAttribute("data-evidence-theme") !== theme) {
        await page.getByRole("switch", { name: "Dark theme", exact: true }).click();
    }
    await page.waitForFunction((expected) => document.documentElement.dataset.evidenceTheme === expected, theme);
}

export async function selectActivityOption(page, id, value) {
    const trigger = page.locator(`[data-select-id=${JSON.stringify(id)}]`);
    if (!await trigger.isVisible() && await page.locator("#moreFilters").locator(`[data-select-id=${JSON.stringify(id)}]`).count()) await page.locator("#moreFilters > summary").click();
    if (!await trigger.isVisible() && ["collectionWindow", "collectionCadence"].includes(id)) await navigateSettings(page, "collection");
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
