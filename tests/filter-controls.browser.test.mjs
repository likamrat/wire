import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { navigateMain, openActivitySessions, selectActivityOption, chooseTheme } from "./helpers.mjs";

const proofDir = process.env.WIRE_FILTER_CONTROLS_PROOFS;
const ready = async page => {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    assert.deepEqual(await page.locator("#message:is(.error,.stale):visible").allTextContents(), []);
};

test("shared filters preserve exact service cohorts, drafts, history, report membership and readable controls", { timeout: 90000 }, async t => {
    const app = await authorFilterFixture(t, { serviceCases: true }), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const errors = [], denied = [], requests = [], observations = [];
    let snapshot;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary"];
        if (url.origin !== new URL(app.runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        if (url.pathname === "/api/snapshot") requests.push(request.postDataJSON());
        return route.continue();
    });
    page.on("response", async response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    app.closeClient(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(denied, []); });
    await page.goto(app.runtime.url); await ready(page);
    const all = snapshot.analytics.rows;
    assert.equal(all.length, 15);
    const ids = keys => keys.flatMap(key => app.cases[key].callIds).map(id => all.find(row => row.toolCallId === id).id).sort();
    const exact = (name, keys) => {
        const actual = snapshot.analytics.rows.map(row => row.id).sort(), expected = ids(keys);
        assert.deepEqual(actual, expected, name);
        assert.equal(snapshot.analytics.totals.count, expected.length);
        assert.equal(new Set(actual).size, actual.length);
        observations.push({ name, ids: actual, filters: requests.at(-1).filters });
    };
    const choose = async (id, value) => { await selectActivityOption(page, id, value); await ready(page); };
    if (proofDir) await mkdir(proofDir, { recursive: true });
    assert.equal(await page.locator("#moreFilters").evaluate(node => node.open), false);
    assert.deepEqual(await page.locator(".filter-scroll .select-trigger").evaluateAll(nodes => nodes.map(node => node.dataset.selectId)),
        ["dateFilter", "toolFilter", "serviceAssociationFilter", "outcomeFilter", "promptAuthorFilter"]);

    await navigateMain(page, "activity"); await ready(page);
    for (const key of ["ownMail", "agentMail", "unverified"]) {
        await page.locator("#activitySearch").fill(app.cases[key].content);
        await openActivitySessions(page);
        await page.locator(`.request-row[data-view-key="request:${app.cases[key].scenarioId}"] input`).check();
    }
    await page.locator("#clearActivitySearch").click();
    await navigateMain(page, "home"); await ready(page);
    await choose("serviceAssociationFilter", "Files");
    exact("Files plus explicit context", ["otherAgent", "multiFiles", "failedFiles", "partialFiles", "missingUser", "missingAgent", "assistance"]);
    assert.deepEqual(snapshot.analytics.serviceInvolvement.selection.knownMatchIds.sort(), ids(["otherAgent", "multiFiles", "failedFiles", "partialFiles"]));
    assert.deepEqual(snapshot.analytics.serviceInvolvement.selection.contextOnlyIds.sort(), ids(["missingUser", "missingAgent", "assistance"]));
    assert.match(await page.locator("#serviceFocusScope").innerText(), /Files \+ calls with missing service details\. 4 known matches; 3 context-only/);
    await page.getByRole("button", { name: "Remove missing-service context", exact: true }).click(); await ready(page);
    exact("Strict Files", ["otherAgent", "multiFiles", "failedFiles", "partialFiles"]);
    assert.match(page.url(), /includeMissingService=false/);
    assert.equal(await page.evaluate(() => document.activeElement.id), "serviceAssociationFilter-control");
    await choose("serviceFilter", "Mail");
    exact("Service associations AND exclusive category stay independent", []);
    assert.equal(await page.locator("#activityCount").textContent(), "0");
    await choose("serviceFilter", "all");
    await page.locator("#moreFilters > summary").click();
    await page.locator("#addServiceContext").click(); await ready(page);
    exact("Explicitly add missing-service context again", ["otherAgent", "multiFiles", "failedFiles", "partialFiles", "missingUser", "missingAgent", "assistance"]);
    await page.getByRole("button", { name: "Remove missing-service context", exact: true }).click(); await ready(page);
    await page.goBack(); await ready(page);
    exact("Back restores context", ["otherAgent", "multiFiles", "failedFiles", "partialFiles", "missingUser", "missingAgent", "assistance"]);
    await choose("toolFilter", "workiq-fetch");
    exact("Files plus context AND tool", ["otherAgent", "multiFiles", "failedFiles", "partialFiles", "missingUser", "missingAgent"]);
    await choose("dateFilter", "custom");
    await page.locator("#fromFilter").fill(app.olderDay); await page.locator("#toFilter").fill(app.olderDay);
    await page.locator("#applyDates").click(); await ready(page);
    exact("AND custom inclusive date", ["otherAgent", "multiFiles", "failedFiles", "partialFiles", "missingUser"]);

    for (const id of ["promptAuthorFilter", "outcomeFilter"]) {
        const before = requests.length, trigger = page.locator(`#${id}-control`);
        await trigger.click();
        const popup = page.locator(".select-popup:visible");
        await popup.getByRole("checkbox").click();
        assert.equal(await popup.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true, "Empty draft never means All");
        await popup.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
        await trigger.press("ArrowDown"); await trigger.press(id === "promptAuthorFilter" ? "a" : "t");
        assert.equal(await page.locator(".select-option[data-active=true]").getAttribute("data-value"), id === "promptAuthorFilter" ? "agent" : "failure");
        await trigger.press("Space"); await trigger.press("Escape");
        await trigger.click(); await popup.getByRole("option").first().click(); await page.locator("#pageTitle").click();
        assert.equal(await trigger.getAttribute("aria-expanded"), "false");
        assert.equal(requests.length, before, "Opening, ticking, typeahead, Cancel/Escape/outside never apply");
    }
    await choose("promptAuthorFilter", ["user", "agent"]);
    assert.deepEqual(requests.at(-1).filters.promptAuthors, ["user", "agent"], "User plus agent is not All");
    const authorTrigger = page.locator("#promptAuthorFilter-control"), beforeAuthor = requests.length;
    await authorTrigger.click(); await authorTrigger.press("Home"); await authorTrigger.press("ArrowDown"); await authorTrigger.press("Space");
    assert.equal(requests.length, beforeAuthor);
    await authorTrigger.press("Tab"); await page.keyboard.press("Enter"); await ready(page);
    assert.equal(requests.length, beforeAuthor + 1, "Keyboard Apply commits the author draft exactly once");
    assert.equal(await page.evaluate(() => document.activeElement.id), "promptAuthorFilter-control");
    exact("AND user author", ["multiFiles", "partialFiles", "missingUser"]);
    const beforeOutcome = requests.length;
    await choose("outcomeFilter", ["failure"]);
    assert.equal(requests.length, beforeOutcome + 1, "Apply dispatches exactly once");
    exact("AND failed outcome", ["missingUser"]);
    await choose("outcomeFilter", ["success", "failure"]);
    exact("Outcome OR, cross-field AND", ["multiFiles", "partialFiles", "missingUser"]);
    await choose("projectFilter", app.projectId);
    await page.locator("#moreFilters > summary").click();
    assert.match(await page.locator("#filterChips").innerText(), /Invented project A/);
    assert.match(await page.locator("#moreFilters > summary").innerText(), /1 active/);
    await navigateMain(page, "activity"); await ready(page);
    await page.getByRole("link", { name: "Filter to Copilot chat: Invented author conversation", exact: true }).first().click(); await ready(page);
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    exact("Scoped chat preserves every filter", ["multiFiles", "partialFiles", "missingUser"]);
    assert.equal(requests.at(-1).filters.projectIds[0], app.projectId);
    assert.deepEqual(await page.locator(".matched-action").evaluateAll(nodes => nodes.map(node => node.dataset.actionId).sort()), ids(["multiFiles", "partialFiles", "missingUser"]));
    assert.equal(await page.locator(".matched-action .service-context-label").count(), 1);
    await page.goBack(); await ready(page); await page.goBack(); await ready(page);
    exact("Back returns equivalent analytical scope", ["multiFiles", "partialFiles", "missingUser"]);
    await page.locator("#activitySearch").fill(app.cases.missingUser.content);
    await openActivitySessions(page);
    assert.match(await page.locator("#serviceFocusScope").innerText(), /0 known matches; 1 context-only/);
    assert.deepEqual(await page.locator(".request-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey)), [`request:${app.cases.missingUser.scenarioId}`]);
    await page.locator("#clearActivitySearch").click();
    assert.match(await page.locator("#serviceFocusScope").innerText(), /2 known matches; 1 context-only/);
    await page.getByRole("button", { name: "Remove copilot project filter: Invented project A", exact: true }).click(); await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "moreFiltersToggle", "Clearing a hidden secondary field focuses More filters without opening it");
    assert.equal(await page.locator("#moreFilters").evaluate(node => node.open), false);
    await choose("projectFilter", app.projectId);
    await page.locator("#moreFiltersToggle").click();

    for (const [width, scale, theme] of [[1200, 1, "light"], [375, 2, "dark"]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.evaluate(() => document.fonts.ready);
        const geometry = await page.locator(".filter-scroll .select-trigger, #filterChips .filter-chip").evaluateAll(nodes => nodes.map(node => {
            const box = node.getBoundingClientRect(), text = node.querySelector(".select-value") || node;
            return { id: node.id || node.getAttribute("aria-label"), width: box.width, height: box.height, left: box.left, right: box.right,
                overflow: text.scrollWidth - text.clientWidth, clipped: text.scrollHeight - text.clientHeight };
        }));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        for (const box of geometry) assert.ok(box.height >= 44 && box.left >= 0 && box.right <= width + 1 && box.overflow <= 1 && box.clipped <= 1, JSON.stringify(box));
        if (proofDir) {
            await page.locator(".filter-scroll").screenshot({ path: path.join(proofDir, `filters-${width}-${scale}-${theme}.png`) });
            await page.locator("#filterChips").screenshot({ path: path.join(proofDir, `active-${width}-${scale}-${theme}.png`) });
            await page.locator("#serviceFocus").screenshot({ path: path.join(proofDir, `scope-${width}-${scale}-${theme}.png`) });
        }
        observations.push({ width, scale, theme, geometry });
        await page.locator("#promptAuthorFilter-control").click();
        const popup = page.locator(".select-popup:visible");
        const box = await popup.boundingBox();
        assert.ok(box.x >= 8 && box.x + box.width <= width - 7 && box.y >= 8 && box.y + box.height <= 993);
        await page.keyboard.press("Escape");
        assert.equal(await page.evaluate(() => document.activeElement.id), "promptAuthorFilter-control");
    }
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await navigateMain(page, "reports"); await ready(page);
    await page.locator("#reportCreateLink").click(); await ready(page);
    assert.match(await page.locator("#reportPromptAuthorSummary").textContent(), /3 of 3 interactions/);
    await choose("reportPromptAuthorFilter", ["user"]);
    assert.match(await page.locator("#reportPromptAuthorSummary").textContent(), /1 of 3 interactions/);
    await navigateMain(page, "home"); await ready(page);
    await page.locator("#resetView").click(); await ready(page);
    assert.equal(snapshot.analytics.totals.count, 15);
    await navigateMain(page, "reports"); await ready(page);
    await page.locator("#reportCreateLink").click(); await ready(page);
    assert.match(await page.locator("#reportPromptAuthorSummary").textContent(), /1 of 3 interactions/, "Reset preserves explicit report-author membership and hidden selection");

    for (const alias of ["home", "overview", "activity", "calls"]) {
        await page.goto(app.runtime.url + `#${alias}?services=Files&tool=workiq-fetch`); await ready(page);
        exact(`${alias} direct link is strict by default`, ["otherAgent", "multiFiles", "failedFiles", "partialFiles"]);
    }
    await page.goto(app.runtime.url + "#home?service=Files"); await ready(page);
    assert.equal(snapshot.analytics.rows.some(row => row.toolCallId === app.cases.multiFiles.callIds[0]), false, "Legacy service parameter stays exclusive category-v3");
    assert.ok(snapshot.analytics.rows.every(row => row.workload === "Files"));
    assert.equal(requests.at(-1).filters.services, undefined);
    await choose("serviceFilter", "Discovery");
    exact("Existing Discovery category remains preparation", ["schema"]);
    await choose("layerFilter", "reported-api");
    assert.equal(requests.at(-1).filters.workloads, undefined, "Existing layer invalidation removes tool-only Discovery");
    await page.goto(app.runtime.url + "#home?services=Files&layer=reported-api"); await ready(page);
    assert.equal(snapshot.analytics.rows.some(row => row.toolCallId === app.cases.multiFiles.callIds[0]), false, "Unattributed returned results never inherit multi-target parent services");
    await choose("layerFilter", "code-reference");
    assert.equal(await page.locator("#outcomeFilter-control").isDisabled(), true);
    assert.match(await page.locator("#resultFilterScope").innerText(), /execution is not observed/);
    assert.equal(snapshot.analytics.totals.count, 0);
    if (proofDir) await writeFile(path.join(proofDir, "proof.json"), JSON.stringify({ observations, snapshotReads: requests.length, errors, denied }, null, 2));
});
