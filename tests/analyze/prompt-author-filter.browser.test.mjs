import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { navigateMain, openActivitySessions, openAnalyzeFilters, selectActivityOption, chooseTheme } from "../support/helpers.mjs";
import { selectReportFocus } from "../reports/report-journey-helpers.mjs";
import { contrast } from "../support/color-measurements.mjs";

const proofDir = process.env.WIRE_AUTHOR_FILTER_PROOFS;
const ready = async page => {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await page.evaluate(() => document.fonts.ready);
};
async function setAuthors(page, values, id = "promptAuthorFilter", finish = "Apply") {
    if (id === "promptAuthorFilter") await openAnalyzeFilters(page);
    await page.locator(`[data-select-id="${id}"]`).click();
    const popup = page.locator(".select-popup:visible");
    for (const value of ["user", "agent", "unknown"]) {
        const option = popup.locator(`[data-value="${value}"]`);
        if ((await option.getAttribute("aria-selected") === "true") !== values.includes(value)) await option.click();
    }
    if (finish === "Escape") await page.keyboard.press("Escape");
    else await popup.getByRole("button", { name: finish, exact: true }).click();
    if (finish === "Apply") await ready(page);
}
async function setup(t) {
    const app = await authorFilterFixture(t), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 950 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const errors = [], blocked = [], requests = [];
    let snapshot;
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(app.runtime.url).origin) { blocked.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    page.on("request", request => {
        if (request.url().endsWith("/api/snapshot")) requests.push(request.postDataJSON());
        const pathname = new URL(request.url()).pathname;
        if (/\/api\/(?:collection\/(?:now|configure|enabled)|assessment\/(?:feedback|consent\/set))/.test(pathname)
            || pathname.startsWith("/api/evaluation/") && !["/api/evaluation/automatic/summary", "/api/evaluation/automatic/status", "/api/evaluation/status"].includes(pathname)) blocked.push(pathname);
    });
    page.on("response", async response => {
        if (!response.ok()) return;
        if (response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    app.closeClient(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(blocked, []); });
    await page.goto(app.runtime.url); await ready(page);
    return { ...app, page, requests, snapshot: () => snapshot };
}
test("shared author menu applies whole interactions, preserves draft/cancel and conversation/history scope", { timeout: 60000 }, async t => {
    const app = await setup(t), { page } = app;
    assert.equal(app.snapshot().analytics.totals.count, 8);
    const before = app.requests.length;
    await setAuthors(page, ["user"], "promptAuthorFilter", "Cancel");
    assert.equal(app.requests.length, before);
    await page.locator('[data-select-id="promptAuthorFilter"]').click();
    const emptyDraft = page.locator(".select-popup:visible");
    await emptyDraft.getByRole("checkbox", { name: "All authors", exact: true }).click();
    assert.equal(await emptyDraft.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
    assert.equal(await emptyDraft.locator(".select-validation").textContent(), "Select at least one prompt author.");
    assert.equal(app.requests.length, before);
    await emptyDraft.getByRole("button", { name: "Cancel", exact: true }).click();
    await setAuthors(page, ["agent"], "promptAuthorFilter", "Escape");
    assert.equal(app.requests.length, before);
    await page.locator('[data-select-id="promptAuthorFilter"]').click();
    await page.locator('.select-popup:visible [data-value="unknown"]').click();
    await page.locator("#pageTitle").click();
    assert.equal(app.requests.length, before, "Outside dismissal discards the draft");
    await setAuthors(page, ["user"]);
    assert.equal(app.snapshot().analytics.totals.count, 3);
    assert.deepEqual(new Set(app.snapshot().analytics.rows.map(row => row.scenarioId)), new Set([app.cases.ownMail.scenarioId, app.cases.ownCalendar.scenarioId]));
    assert.doesNotMatch(page.url(), /[?&]authors=/);
    await selectActivityOption(page, "chatFilter", app.chatId); await ready(page);
    assert.doesNotMatch(page.url(), /[?&]authors=/);
    assert.equal(app.snapshot().analytics.totals.count, 3);
    assert.deepEqual(new Set(app.snapshot().analytics.rows.map(row => row.scenarioId)), new Set([app.cases.ownMail.scenarioId, app.cases.ownCalendar.scenarioId]));
    await setAuthors(page, ["agent"]);
    assert.equal(app.snapshot().analytics.totals.count, 2);
    await setAuthors(page, ["user", "agent"]);
    assert.equal(app.snapshot().analytics.totals.count, 5);
    assert.match(await page.locator("#filterChips").innerText(), /Human and agent prompts/);
    const length = await page.evaluate(() => history.length);
    await setAuthors(page, ["unknown"]);
    assert.equal(app.snapshot().analytics.totals.count, 2);
    assert.deepEqual(app.requests.at(-1).filters.promptAuthors, ["unknown"]);
    assert.equal(await page.evaluate(() => history.length), length);
    await page.getByRole("button", { name: /^Remove author filter:/ }).click(); await ready(page);
    assert.equal(app.snapshot().analytics.totals.count, 7);
    assert.equal(new URL(page.url()).searchParams.has("authors"), false);
});

test("report author filtering preserves selected base membership and complete eligible calls", async t => {
    const { page, cases } = await setup(t);
    await navigateMain(page, "reports");
    await selectReportFocus(page, "all");
    await page.locator("#reportDeskActivity").click();
    const picker = page.locator("#reportActivityOptions");
    await picker.locator('[name=reportScope][value=selected]').check();
    const wanted = new Set([cases.ownMail.scenarioId, cases.agentMail.scenarioId, cases.unverified.scenarioId]);
    const next = picker.getByRole("button", { name: "Next report requests", exact: true });
    do {
        const ids = await picker.locator("input[data-report-request]").evaluateAll(nodes => nodes.map(node => node.id));
        assert.ok(ids.length > 0);
        for (const id of ids) await picker.locator(`[id="${id}"]`).setChecked(wanted.has(id.slice("report-select-".length)));
        if (!await next.isEnabled()) break;
        await next.click();
    } while (true);
    await picker.getByRole("button", { name: "Use activity", exact: true }).click();
    await page.locator('[name=promptMode][value=none]').check();
    const read = () => page.waitForResponse(response => response.url().endsWith("/api/preview") && response.ok());
    let response = read(); await page.locator("#prepareReportPreview").click();
    assert.equal((await (await response).json()).records.length, wanted.size);
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    response = read(); await setAuthors(page, ["user"], "reportPromptAuthorFilter");
    const preview = await (await response).json();
    assert.deepEqual(preview.snapshot.selectionScope.promptAuthors, ["user"]);
    assert.equal(preview.snapshot.selectionScope.baseRequestGroups, wanted.size);
    assert.equal(preview.snapshot.selectionScope.requestGroups, 1);
    assert.equal(preview.snapshot.selectionScope.workIqActions, 2);
    assert.equal(preview.records.length, 1);
    assert.equal(preview.records[0].toolCalls.length, 2);
    assert.ok(preview.records[0].prompts.every(prompt => prompt.text === null));
});
test("author choice composes with dates, result, service and chat scope before pagination", { timeout: 60000 }, async t => {
    const app = await setup(t), { page } = app;
    await selectActivityOption(page, "chatFilter", app.chatId); await ready(page);
    await setAuthors(page, ["user"]);
    await selectActivityOption(page, "serviceFilter", "Mail"); await ready(page);
    await page.locator('[data-select-id="outcomeFilter"]').click();
    const popup = page.locator(".select-popup:visible");
    for (const option of await popup.locator(".select-option").all()) {
        const wanted = await option.getAttribute("data-value") === "failure";
        if ((await option.getAttribute("aria-selected") === "true") !== wanted) await option.click();
    }
    await popup.getByRole("button", { name: "Apply", exact: true }).click(); await ready(page);
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill(app.olderDay);
    await page.locator("#toFilter").fill(app.olderDay);
    await page.locator("#applyDates").click(); await ready(page);
    const data = app.snapshot();
    assert.equal(data.analytics.totals.count, 1);
    assert.deepEqual(data.analytics.rows.map(row => row.scenarioId), [app.cases.ownMail.scenarioId]);
    assert.equal(data.sessionAnalysis.totals.count, 2, "Conversation context retains the full result scope, still narrowed to Human prompts");
    assert.deepEqual(app.requests.at(-1).filters.promptAuthors, ["user"]);
    assert.deepEqual(app.requests.at(-1).filters.outcomes, ["failure"]);
    assert.deepEqual(app.requests.at(-1).filters.workloads, ["Mail"]);
    assert.equal(await page.locator("#activityList .request-row").count(), 1);
    await selectActivityOption(page, "serviceFilter", "Files"); await ready(page);
    assert.equal(app.snapshot().analytics.totals.count, 0);
    assert.equal(await page.locator(".request-row:visible,.matched-action:visible").count(), 0);
    assert.deepEqual(await page.locator("#promptAuthorFilter").evaluate(node => [...node.selectedOptions].map(option => option.value)), ["user"]);
    await page.locator("#resetView").click(); await ready(page);
    assert.equal(app.snapshot().analytics.totals.count, 8);
    assert.equal(new URL(page.url()).pathname, "/");
});

test("pending, failed and late author reads never relabel old counts as a new selection", { timeout: 60000 }, async t => {
    const app = await setup(t), { page } = app;
    let release, entered, failAgent = false;
    const gate = new Promise(resolve => { release = resolve; });
    const held = new Promise(resolve => { entered = resolve; });
    await page.route("**/api/snapshot", async route => {
        const value = route.request().postDataJSON().filters.promptAuthors?.join(",");
        if (value === "user") {
            const response = await route.fetch(); entered(); await gate;
            await route.fulfill({ response });
        } else if (value === "agent" && failAgent) {
            await route.fulfill({ status: 503, json: { error: "Invented author read failed.", code: "synthetic_author_failure" } });
        } else await route.continue();
    });
    app.closeClient(async () => { release(); });
    const first = setAuthors(page, ["user"]);
    await held;
    assert.equal(await page.locator("#activityCount").textContent(), "8");
    assert.deepEqual(await page.locator("#promptAuthorFilter").evaluate(node => [...node.selectedOptions].map(option => option.value)), ["user", "agent", "unknown"]);
    await setAuthors(page, ["unknown"]);
    assert.equal(await page.locator("#activityCount").textContent(), "2");
    release(); await first;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("#activityCount").textContent(), "2");
    assert.deepEqual(await page.locator("#promptAuthorFilter").evaluate(node => [...node.selectedOptions].map(option => option.value)), ["unknown"]);
    failAgent = true;
    await setAuthors(page, ["agent"]);
    assert.match(await page.locator("#message").textContent(), /last recorded snapshot|could not update/i);
    assert.equal(await page.locator("#activityCount").textContent(), "2");
    assert.deepEqual(await page.locator("#promptAuthorFilter").evaluate(node => [...node.selectedOptions].map(option => option.value)), ["unknown"]);
    assert.doesNotMatch(page.url(), /[?&]authors=/);
});

test("author cues and Apply controls remain readable in light/navy and narrow layouts", { timeout: 60000 }, async t => {
    const app = await setup(t), { page } = app, observations = [];
    await navigateMain(page, "activity"); await ready(page); await openActivitySessions(page);
    if (proofDir) await mkdir(proofDir, { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [1200, 375]) {
        await page.setViewportSize({ width, height: 950 }); await chooseTheme(page, theme);
        const cues = await page.locator(".request-row .request-card-author[data-prompt-actor]").evaluateAll(nodes => nodes.map(node => {
            let parent = node, background;
            while (parent && (!background || background === "rgba(0, 0, 0, 0)")) { background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement; }
            return { actor: node.dataset.promptActor, text: node.textContent, color: getComputedStyle(node).color, background };
        }));
        assert.ok(cues.some(cue => cue.actor === "user" && cue.text === "Human prompt"));
        assert.ok(cues.some(cue => cue.actor === "agent" && cue.text === "Agent prompt"));
        for (const cue of cues) assert.ok(contrast(cue.color, cue.background) >= 4.5, `${theme}/${width}/${cue.actor} contrast`);

        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (proofDir) for (const actor of ["user", "agent", "unknown"]) {
            await page.locator(".request-row").filter({ has: page.locator(`[data-prompt-actor="${actor}"]`) }).first()
                .screenshot({ path: path.join(proofDir, `author-row-${actor}-${theme}-${width}.png`) });
        }
        await openAnalyzeFilters(page);
        await page.locator('[data-select-id="promptAuthorFilter"]').click();
        const popup = page.locator(".select-popup:visible");
        assert.equal(await popup.locator(".select-draft-hint,.select-validation:visible").count(), 0);
        assert.doesNotMatch(await popup.innerText(), /statuses|one result/);
        const box = await popup.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 951);
        const apply = await popup.getByRole("button", { name: "Apply", exact: true }).boundingBox();
        assert.ok(apply.height >= 44);
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `author-menu-${theme}-${width}.png`) });
        await popup.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.locator('[data-select-id="outcomeFilter"]').click();
        assert.equal(await page.locator(".select-popup:visible .select-draft-hint,.select-popup:visible .select-validation:visible").count(), 0);
        await page.locator(".select-popup:visible").getByRole("button", { name: "Cancel", exact: true }).click();
        observations.push({ theme, width, cues, popup: box });
    }
    if (proofDir) await writeFile(path.join(proofDir, "author-filter-visual.json"), JSON.stringify(observations, null, 2));
});
