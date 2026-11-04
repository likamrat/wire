import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { nativeConsumerFixture } from "./native-consumer-fixture.mjs";
import { chatFixture, coworkFixture, multiCallChatFixture } from "./native-read-model-fixtures.mjs";
import { fixture, selectActivityOption, closeAnalyzeFilters, openAnalyzeFilters, chooseTheme, navigateMain } from "./helpers.mjs";
import { chooseReportScope } from "./report-journey-helpers.mjs";

const ready = async page => {
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#message.error:visible")).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
async function capture(page, name) {
    const directory = process.env.WIRE_MICROSOFT_INTERFACE_PROOFS;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)));
    await page.screenshot({ path: path.join(directory, name + ".png"), fullPage: !/reader|narrow/.test(name) });
}
async function gate(page, label) {
    if (await page.locator("#wireAccountTrigger").getAttribute("aria-expanded") !== "true") await page.locator("#wireAccountTrigger").click();
    const action = page.locator("#wireAccountGate");
    await expect(action).toHaveText(label);
    await expect(action).toBeEnabled();
    await action.click();
}

test("Microsoft records use the existing source, widget, reader, Search and account-clearance journeys", { timeout: 60000 }, async t => {
    const cleanup = [], cowork = coworkFixture(), multi = multiCallChatFixture();
    multi.scope.conversationId = "invented-invocation-conversation";
    const nested = cowork.find(row => row.outcomes.nestedApi).outcomes.nestedApi;
    nested.availability = "recorded";
    nested.observed = [
        { index: 0, indexKind: "response-array-position", statusCode: 200, errorCode: null, paginationPresent: null, evidenceLevel: "intermediary-reported" },
        { index: 1, indexKind: "response-array-position", statusCode: null, errorCode: null, paginationPresent: null, evidenceLevel: "intermediary-reported" },
    ];
    const app = await nativeConsumerFixture({ after: work => cleanup.push(work) }, {
        records: [fixture("microsoft-shell-github")], envelopes: [...chatFixture(), ...cowork, multi],
    });
    const api = await app.start(), browser = await chromium.launch();
    const errors = [], external = [], reads = [], previews = [];
    const newPanel = async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
        page.setDefaultTimeout(7000);
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", route => {
            if (new URL(route.request().url()).origin !== new URL(app.url).origin) {
                external.push(route.request().url()); return route.abort();
            }
            if (route.request().url().endsWith("/api/snapshot")) reads.push(route.request().postDataJSON());
            if (route.request().url().endsWith("/api/preview")) previews.push(route.request().postDataJSON());
            return route.continue();
        });
        return page;
    };
    t.after(async () => {
        await browser.close();
        for (const work of cleanup) await work();
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
    });
    const page = await newPanel();
    await page.goto(app.url + "#analyze");
    await ready(page);
    assert.equal(await page.evaluate(() => [...document.fonts].some(face => face.family.replaceAll('"', "") === "Asta Sans" && face.status === "loaded")), true);
    await expect(page.locator("#activityList .request-row")).toHaveCount(4);
    await expect(page.locator("#activityList")).toContainText("An invented question.");
    await expect(page.locator("#outcomeChart .source-outcome-population")).toHaveCount(2);
    await expect(page.locator("#outcomeChart .percentage-ring")).toHaveCount(0);
    await expect(page.locator('#outcomeChart .percentage-content[data-unit-mode="separate"]')).toHaveCSS("display", "block");
    await expect(page.locator("#percentageCharts")).toContainText("Recorded tool calls");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await ready(page);
        await capture(page, "mixed-" + theme);
    }
    await openAnalyzeFilters(page);
    const originalOption = await page.locator('#toolFilter option[value="mcp__graph__CallGraph"]').evaluateHandle(node => ({
        text: node.firstChild, value: node.getAttributeNode("value"),
    }));
    await page.locator("#toolFilter-control").click();
    const popupOption = await page.locator('.select-popup .select-option[data-value="mcp__graph__CallGraph"]').evaluateHandle(node => ({
        text: node.querySelector(".select-option-label").firstChild, value: node.getAttributeNode("data-value"),
    }));
    await page.keyboard.press("Escape");
    for (const [source, count] of [["github-copilot", 1], ["microsoft-365-chat", 2], ["microsoft-365-cowork", 1]]) {
        await selectActivityOption(page, "sourceFilter", source);
        await ready(page);
        assert.deepEqual(reads.at(-1).filters.sources, [source]);
        await closeAnalyzeFilters(page);
        await expect(page.locator("#activityList .request-row")).toHaveCount(count);
        assert.deepEqual(await originalOption.evaluate(value => [value.text.data, value.value.value]), ["", ""]);
        assert.deepEqual(await popupOption.evaluate(value => [value.text.data, value.value.value]), ["", ""]);
        await capture(page, source);
    }
    await selectActivityOption(page, "toolFilter", "mcp__graph__CallGraph");
    await ready(page);
    const retiredTrigger = await page.locator("#toolFilter-control .select-value").evaluateHandle(node => node.firstChild);
    await selectActivityOption(page, "toolFilter", "all");
    await ready(page);
    assert.equal(await retiredTrigger.evaluate(node => node.data), "");
    await closeAnalyzeFilters(page);
    const nativeSnapshot = await api("/api/snapshot", { layer: "tool", filters: { sources: ["microsoft-365-cowork"] } });
    assert.equal(nativeSnapshot.status, 200);
    const native = nativeSnapshot.body.scenarios.find(record => record.sourceId === "microsoft-365-cowork");
    const call = nativeSnapshot.body.analytics.rows.find(row => row.nativeToolNames.includes("mcp__graph__CallGraph"));
    const card = page.locator("#activityList .request-card-open");
    await card.scrollIntoViewIfNeeded();
    const cardTop = (await card.boundingBox()).y;
    await card.click();
    await expect(page.locator("#contextSidebar")).toBeVisible();
    await expect(page.locator("#requestContent")).toContainText("Read the invented records.");
    await expect(page.locator("#contextSidebarFooter")).toContainText("Reports for Microsoft activity are not available");
    await expect(page.locator("#contextSidebarFooter button", { hasText: "Add to report" })).toBeDisabled();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await ready(page);
    await expect(card).toBeFocused();
    assert.ok(Math.abs((await card.boundingBox()).y - cardTop) <= 2);
    assert.equal(new URL(page.url()).searchParams.get("source"), null);
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("source"), "microsoft-365-cowork");
    await page.goto(app.url + "#request?" + new URLSearchParams({ source: "microsoft-365-cowork", request: native.scenarioId, call: call.id }));
    await ready(page);
    await expect(page.locator("#selectedCall")).toContainText("mcp__graph__CallGraph");
    await expect(page.locator("#selectedCall")).toContainText("12 ms");
    await expect(page.locator("#selectedCall")).toContainText("Intermediary-reported HTTP status");
    await capture(page, "native-call-reader");
    const returnedSnapshot = await api("/api/snapshot", { layer: "reported-api", filters: { sources: ["microsoft-365-cowork"] } });
    const returned = returnedSnapshot.body.analytics.rows.find(row => row.scenarioId === native.scenarioId && row.resultIndex === 1);
    await page.goto(app.url + "#request?" + new URLSearchParams({ source: "microsoft-365-cowork", request: native.scenarioId,
        call: returned.id, layer: "reported-api", callRevision: String(nativeSnapshot.body.revision) }));
    await ready(page);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-observation-key", returned.observationKey);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-result-index", "1");
    await expect(page.locator("#selectedCall")).toContainText("Unknown");
    await capture(page, "native-returned-result-reader");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await ready(page);
    await page.locator("#wireSearch").click();
    await page.locator("#wireSearch").fill("An invented card representation");
    const hit = page.locator("#wireSearchResults button").filter({ hasText: "An invented card representation" });
    await expect(hit).toHaveCount(1);
    await hit.click();
    await expect(page.locator("#requestContent")).toContainText("Card text representation");
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toMatch(/^native-message-/);
    await capture(page, "native-search-reader");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await ready(page);
    await page.locator("#wireSearchClear").click();
    await selectActivityOption(page, "sourceFilter", "all");
    await closeAnalyzeFilters(page);
    await navigateMain(page, "reports");
    await page.locator("#reportCreateLink").click();
    await ready(page);
    await chooseReportScope(page, "all");
    await expect(page.locator("#reportsView")).toContainText("Reports for Microsoft activity are not available");
    assert.equal(previews.length, 0);
    await navigateMain(page, "analyze");
    await ready(page);
    await selectActivityOption(page, "layerFilter", "tool");
    await ready(page);
    await selectActivityOption(page, "sourceFilter", "microsoft-365-chat");
    await closeAnalyzeFilters(page);
    await ready(page);
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await openAnalyzeFilters(page);
    await expect(page.locator("#sourceFilter-control")).toContainText("Microsoft 365 Copilot Chat");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await capture(page, "source-narrow-200-dark");
    await chooseTheme(page, "light");
    await capture(page, "source-narrow-200-light");
    await closeAnalyzeFilters(page);
    await page.locator("#activityList .request-card-open").filter({ hasText: "An invented question." }).click();
    await expect(page.locator("#contextSidebar")).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await capture(page, "native-reader-narrow-200-light");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    const idle = await newPanel();
    await idle.goto(app.url + "#analyze?source=microsoft-365-chat");
    await ready(idle);
    const canary = idle.locator(".request-card-prompt").filter({ hasText: "An invented question." });
    const textHandle = await canary.evaluateHandle(node => node.firstChild);
    const anchorHandle = await canary.evaluateHandle(node => node.closest("a").getAttributeNode("href"));
    await canary.click();
    await expect(idle.locator("#requestContent")).toContainText("An invented question.");
    const messageHandle = await idle.locator(".reader-native-message").first().evaluateHandle(node => ({
        id: node.getAttributeNode("id"), text: node.querySelector(".reader-message-text").firstChild,
    }));
    await gate(page, "Sign out of WIRE");
    await expect(idle.locator("#workspace")).toBeHidden();
    await expect(page.locator("#workspace")).toBeHidden();
    assert.equal(await textHandle.evaluate(node => node.data), "");
    assert.equal(await anchorHandle.evaluate(node => node.value), "");
    assert.deepEqual(await messageHandle.evaluate(value => [value.id.value, value.text.data]), ["", ""]);
    assert.equal(await idle.locator("#activityListSummary").textContent(), "");
    await gate(page, "Sign in to WIRE");
    await ready(idle);
    await expect(idle.locator("#activityList")).toContainText("An invented question.");
    assert.equal(await textHandle.evaluate(node => node.data), "");
    assert.equal(await anchorHandle.evaluate(node => node.value), "");
    assert.deepEqual(await messageHandle.evaluate(value => [value.id.value, value.text.data]), ["", ""]);
});

test("a held layer snapshot retires the old Source popup before a fresh accepted choice", async t => {
    const cleanup = [], app = await nativeConsumerFixture({ after: work => cleanup.push(work) }, {
        records: [fixture("source-readiness")], envelopes: [...chatFixture(), ...coworkFixture()],
    });
    await app.start();
    const browser = await chromium.launch(), page = await browser.newPage();
    page.setDefaultTimeout(7000);
    const errors = [], requests = [], external = [];
    const held = Promise.withResolvers(), release = Promise.withResolvers();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(app.url).origin) {
            external.push(route.request().url()); return route.abort();
        }
        return route.continue();
    });
    t.after(async () => {
        release.resolve();
        await browser.close();
        for (const work of cleanup) await work();
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
    });
    await page.goto(app.url + "#reports?task=create&layer=reported-api");
    await ready(page);
    await navigateMain(page, "analyze");
    await ready(page);
    let armed = true;
    await page.route("**/api/snapshot", async route => {
        const input = route.request().postDataJSON();
        requests.push(input);
        if (!armed || input.layer !== "tool") return route.fallback();
        armed = false;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        held.resolve();
        await release.promise;
        await route.fulfill({ response });
    });
    await selectActivityOption(page, "layerFilter", "tool");
    await held.promise;
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator('[data-percentage-card="tools"] h3')).toHaveText("Tools behind tool-returned API results");
    const oldSource = await page.locator('#sourceFilter option[value="microsoft-365-chat"]').elementHandle();
    await page.locator("#sourceFilter-control").click();
    const oldPopup = page.locator('.select-popup .select-option[data-value="microsoft-365-chat"]');
    await expect(oldPopup).toBeVisible();
    const handles = await oldPopup.evaluateHandle(node => ({
        label: node.querySelector(".select-option-label").firstChild, value: node.getAttributeNode("data-value"),
    }));
    assert.equal(requests.length, 1, "Opening Source is not a new filter request.");
    release.resolve();
    await ready(page);
    await expect(page.locator('[data-percentage-card="tools"] h3')).toHaveText("Recorded tool calls");
    assert.equal(await oldSource.evaluate(node => node.isConnected), false);
    await expect(page.locator("#sourceFilter-control")).toHaveAttribute("aria-expanded", "false");
    await expect(oldPopup).toHaveCount(0);
    assert.deepEqual(await handles.evaluate(value => [value.label.data, value.value.value]), ["", ""]);
    await selectActivityOption(page, "sourceFilter", "microsoft-365-chat");
    await ready(page);
    assert.deepEqual(requests.map(input => ({ layer: input.layer, sources: input.filters.sources })), [
        { layer: "tool", sources: undefined }, { layer: "tool", sources: ["microsoft-365-chat"] },
    ]);
    await expect(page.locator("#sourceFilter-control")).toBeFocused();
    await expect(page.locator("#sourceFilter-control")).toContainText("Microsoft 365 Copilot Chat");
    await closeAnalyzeFilters(page);
    await expect(page.locator("#activityList .request-row")).toHaveCount(1);
    await expect(page.locator("#activityList")).toContainText("An invented question.");
    await expect(page.locator("#activityListScope")).toContainText("Source: Microsoft 365 Copilot Chat");
});

test("native Dates and Compare preserve unavailable call time instead of claiming zero", { timeout: 30000 }, async t => {
    const cleanup = [], app = await nativeConsumerFixture({ after: work => cleanup.push(work) }, { records: [fixture("native-date-comparison")] });
    await app.start();
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(app.url).origin ? route.continue() : route.abort());
    t.after(async () => { await browser.close(); for (const work of cleanup) await work(); assert.deepEqual(errors, []); });
    await page.goto(app.url + "#analyze?source=microsoft-365-cowork&range=custom&from=2026-01-01&to=2026-01-02");
    await ready(page);
    await expect(page.locator("#activityList .request-row")).toHaveCount(0);
    await expect(page.locator("#analyzeScopeStatus")).toBeVisible();
    await expect(page.locator("#analyzeScopeStatus")).toContainText("Microsoft call dates are unavailable");
    await capture(page, "native-date-unavailable");
    await page.goto(app.url + "#analyze?" + new URLSearchParams({
        source: "microsoft-365-cowork", compare: "periods",
        aFrom: "2026-09-28", aTo: "2026-10-01", bFrom: "2026-10-02", bTo: "2026-10-03",
    }));
    await ready(page);
    await expect(page.locator("#periodComparisonResults")).toContainText("This is not a count of Microsoft calls");
    await expect(page.locator("#comparisonAcceptedScope")).toContainText("Cowork");
    await capture(page, "native-comparison-unavailable");
    await selectActivityOption(page, "sourceFilter", "github-copilot");
    await closeAnalyzeFilters(page);
    await expect(page.locator("#analyzeFilterDialog")).not.toBeVisible();
    await expect(page.locator("#periodComparisonResults .compare-answer-grid")).toBeVisible();
    await expect(page.locator("#comparisonAcceptedScope")).toContainText("GitHub Copilot");
    await expect(page.locator("#periodComparisonResults")).not.toContainText("Microsoft call dates");
    await selectActivityOption(page, "sourceFilter", "all");
    await closeAnalyzeFilters(page);
    await expect(page.locator("#analyzeFilterDialog")).not.toBeVisible();
    await expect(page.locator("#periodComparisonResults .compare-answer-grid")).toBeVisible();
    await expect(page.locator("#periodComparisonResults")).toContainText("Microsoft call dates are unavailable");
    await capture(page, "mixed-comparison");
});

test("Analyze Search keeps an accepted no-call conversation without retaining unrelated outcome counts", { timeout: 30000 }, async t => {
    const cleanup = [], app = await nativeConsumerFixture({ after: work => cleanup.push(work) }, {
        envelopes: [...chatFixture(), ...coworkFixture()],
    });
    await app.start();
    const browser = await chromium.launch(), page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(app.url).origin ? route.continue() : route.abort());
    t.after(async () => { await browser.close(); for (const work of cleanup) await work(); assert.deepEqual(errors, []); });
    await page.goto(app.url);
    await ready(page);
    await page.locator("#wireSearch").fill("An invented question");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#activityListSummary")).toContainText("1 interaction with 0 matching");
    await expect(page.locator("#activityList .request-row")).toHaveCount(1);
    await expect(page.locator("#activityList")).toContainText("An invented question.");
    await expect(page.locator("#outcomeChart [data-count-unit]")).toHaveCount(0);
    await expect(page.locator("#outcomeChart")).toContainText("No tool calls recorded.");
    await capture(page, "native-no-call-search");
    await page.locator("#wireSearchClear").click();
    await expect(page.locator("#activityList .request-row")).toHaveCount(2);
    await expect(page.locator("#outcomeChart .percentage-ring")).toHaveCount(1);
});
