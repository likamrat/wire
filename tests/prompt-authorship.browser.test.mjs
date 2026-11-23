import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { promptInstallation } from "./prompt-authorship-fixture.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { navigateMain, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";
import { prepareReportPreview } from "./report-journey-helpers.mjs";

async function setup(t, { reports = false } = {}) {
    const browser = await chromium.launch();
    // Release Chromium's local connections before the installation's server-close hook.
    t.after(() => browser.close());
    const app = await promptInstallation(t);
    const page = await browser.newPage({ viewport: { width: 1200, height: 950 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    const origin = new URL(app.runtime().url).origin, errors = [], denied = [];
    const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/detail", ...(reports
        ? ["/api/report-artifacts/list", "/api/preview", "/api/privacy-review", "/api/export", "/api/cancel-preview"] : [])];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin === origin && (req.method() === "GET" || allowed.includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(denied, []); });
    const sources = () => Promise.all(app.sourceFiles.map(file => readFile(file)));
    const originalFiles = await sources();
    await app.runtime().collector.collectNow();
    return { app, page, sources, originalFiles };
}

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const card = (page, id) => page.locator(`article[data-view-key="request:${id}"]`);
const nextPage = page => page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
const label = item => ({ user: "Human prompt", agent: "Agent prompt", unknown: "Author unverified" })[item.actor]
    + (item.data.isAutopilotContinuation || item.data.source === "autopilot" ? " (automatic continuation)" : "");

async function inspectOriginal(page, item, name) {
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", `request:${item.scenarioId}`);
    const region = page.getByRole("region", { name, exact: true });
    const text = region.getByLabel("Exact recorded prompt text", { exact: true });
    await expect(text).toBeVisible();
    assert.equal(await text.textContent(), item.data.content);
}

test("collecting the original event repairs an unverified human prompt without rewriting the interaction", { timeout: 30000 }, async t => {
    const { app, page, sources, originalFiles } = await setup(t);
    const human = app.cases.find(i => i.name === "human"), current = await loadBoardState(app.context);
    const records = structuredClone(current.evidence), record = records.find(r => r.scenarioId === human.scenarioId);
    record.userPrompt.authorship = { actor: "unknown", basis: "invalid-source" };
    record.userPrompt.authorshipVersion = 4;
    await replaceEvidence(app.context, () => ({ records, importCoverage: current.importCoverage }));
    await page.goto(app.runtime().url); await ready(page);
    if (!await card(page, human.scenarioId).count()) await nextPage(page);
    const row = card(page, human.scenarioId);
    await expect(row.locator(".request-card-author")).toHaveText("Author unverified");
    await row.locator(".request-card-open").press("Enter");
    await inspectOriginal(page, human, "Author unverified");
    await expect(page.locator(".request-original .reader-state")).toHaveText("Recorded sender details could not be verified");
    await app.runtime().collector.collectNow();
    await page.reload(); await ready(page);
    await inspectOriginal(page, human, "Human prompt");
    await expect(page.locator(".request-original .reader-state")).toHaveCount(0);
    await page.locator("#closeContextSidebar").click();
    if (!await row.count()) await nextPage(page);
    await expect(row.locator(".request-card-author")).toHaveText("Human prompt");
    const after = (await loadBoardState(app.context)).evidence.find(r => r.scenarioId === human.scenarioId);
    assert.deepEqual(after.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
    assert.equal(after.userPrompt.sourceEventId, record.userPrompt.sourceEventId);
    assert.equal(after.userPrompt.text, record.userPrompt.text);
    assert.deepEqual(after.toolCalls, record.toolCalls);
    assert.deepEqual(await sources(), originalFiles);
});

test("Analyze, the reader and a saved report preserve the recorded author and exact original text", { timeout: 90000 }, async t => {
    const { app, page, sources, originalFiles } = await setup(t, { reports: true });
    const before = await loadBoardState(app.context), seen = new Set();
    const selected = app.cases.filter(i => ["human", "kickoff", "automatic", "conflict"].includes(i.name));
    await page.goto(app.runtime().url); await ready(page);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page); await closeAnalyzeFilters(page);
    await expect(page.locator("#activityListSummary")).toHaveText("10 interactions · 10 matching tool calls");
    for (let p = 0; p < 2; p++) {
        if (p) await nextPage(page);
        const keys = await page.locator("#activityList article").evaluateAll(nodes => nodes.map(n => n.dataset.viewKey));
        for (const key of keys) {
            const item = app.cases.find(i => key === `request:${i.scenarioId}`);
            assert.ok(item); assert.ok(!seen.has(key)); seen.add(key);
            const row = card(page, item.scenarioId), link = row.locator(".request-card-open");
            await expect(row.locator(".request-card-author")).toHaveText(label(item));
            await expect(row.locator(".request-card-author")).toHaveAttribute("data-prompt-actor", item.actor);
            await link.press("Enter"); await inspectOriginal(page, item, label(item));
            const reason = page.locator(".request-original .reader-state");
            if (item.actor !== "unknown") await expect(reason).toHaveCount(0);
            else await expect(reason).toHaveText(item.basis === "conflicting-source"
                ? "Origin details could not be reconciled" : "Who sent this was not recorded");
            if (selected.includes(item)) await page.getByRole("button", { name: "Add to report", exact: true }).click();
            await page.goBack(); await expect(link).toBeFocused();
        }
    }
    assert.equal(seen.size, app.cases.length);
    await navigateMain(page, "reports"); await page.locator("#reportDeskActivity").click();
    const picker = page.getByRole("dialog", { name: "Choose activity" });
    await picker.getByRole("radio", { name: /^Selected interactions/ }).check();
    await expect(picker.getByRole("radio", { name: /^Selected interactions/ })).toHaveAccessibleName(/4 interactions/);
    await picker.getByRole("button", { name: "Use activity", exact: true }).click();
    async function prepare(action) {
        const response = page.waitForResponse(r => r.url().endsWith("/api/preview"));
        await action(); const r = await response; assert.equal(r.status(), 200);
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeEnabled();
        return r.json();
    }
    await prepare(() => prepareReportPreview(page));
    await page.getByRole("button", { name: "Formats: HTML", exact: true }).click();
    for (const format of ["json", "markdown"]) await prepare(() => page.locator(`#formatOptions input[value=${format}]`).check());
    await page.keyboard.press("Escape");
    await page.locator("#reportPrivacyChoice").click();
    const omitted = await prepare(() => page.locator('#reportPrivacyOptions input[value=none]').check());
    const omittedOrigins = omitted.records.map(r => r.prompts.find(p => p.kind === "origin"));
    assert.equal(omittedOrigins.length, selected.length);
    assert.deepEqual(omittedOrigins.map(p => [p.text, p.authorship.actor, p.authorship.basis]).sort(),
        selected.map(i => [null, i.actor, i.basis]).sort());
    const preview = await prepare(() => page.locator('#reportPrivacyOptions input[value=original]').check());
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    const confirm = page.getByRole("button", { name: "Save with chat details", exact: true });
    await expect(confirm).toBeVisible();
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
    await confirm.click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const saved = await loadBoardState(app.context);
    assert.equal(saved.exports.length, 1);
    const files = saved.exports[0].files;
    for (const file of ["product-report.html", "product-report.json", "product-report.md"]) {
        assert.equal(await readFile(files[file], "utf8"), preview.files[file]);
    }
    const json = JSON.parse(await readFile(files["product-report.json"], "utf8"));
    const origins = json.records.map(r => r.prompts.find(p => p.kind === "origin"));
    assert.equal(origins.length, selected.length);
    for (const item of selected) {
        assert.deepEqual(origins.find(p => p.text === item.data.content)?.authorship, { actor: item.actor, basis: item.basis });
    }
    const projection = JSON.stringify(json.records);
    for (const item of app.cases) assert.equal(projection.includes(item.promptId), false);
    assert.equal(projection.includes(app.parent), false);
    assert.deepEqual(saved.evidence, before.evidence);
    assert.deepEqual(await sources(), originalFiles);
});
