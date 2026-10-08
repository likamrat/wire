import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { promptInstallation } from "./prompt-authorship-fixture.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { chooseTheme, navigateMain, openActivitySessions, selectActivityOption, revealStoredRefresh } from "./helpers.mjs";
import { reportContents, scanReport, inspectReportCopies } from "./report-journey-helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proof = process.env.WIRE_PROMPT_PROOFS;
const ready = async page => {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await page.evaluate(() => document.fonts.ready);
};

test("an older retained human prompt changes from unverified to Your through original-event collection and reload", { timeout: 30000 }, async t => {
    const app = await promptInstallation(t);
    await app.runtime().collector.collectNow();
    const human = app.cases.find(item => item.name === "human"), current = await loadBoardState(app.context);
    const records = structuredClone(current.evidence), record = records.find(record => record.scenarioId === human.scenarioId);
    delete record.userPrompt.authorship;
    delete record.userPrompt.authorshipVersion;
    await replaceEvidence(app.context, () => ({ records, importCoverage: current.importCoverage }));
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 950 }, reducedMotion: "reduce" });
    t.after(() => browser.close());
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === new URL(app.runtime().url).origin) return route.continue();
        external.push(route.request().url()); return route.abort();
    });
    await page.goto(app.runtime().url + `#request?request=${encodeURIComponent(human.scenarioId)}`); await ready(page);
    const reader = page.locator(".request-original");
    assert.equal(await reader.getByRole("heading", { name: "Copilot chat prompt", exact: true }).count(), 1);
    assert.equal(await reader.locator(".reader-state").textContent(), "Author unverified");
    if (proof) { await mkdir(proof, { recursive: true }); await reader.screenshot({ path: path.join(proof, "retained-human-before.png") }); }
    await app.runtime().collector.collectNow();
    await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.equal(await reader.getByRole("heading", { name: "Your prompt", exact: true }).count(), 1);
    assert.doesNotMatch(await reader.innerText(), /Author unverified/);
    assert.equal(await reader.locator("pre").textContent(), human.data.content);
    if (proof) await reader.screenshot({ path: path.join(proof, "retained-human-after.png") });
    await navigateMain(page, "activity"); await ready(page);
    await page.locator("#activitySearch").fill(human.data.content); await openActivitySessions(page);
    assert.equal(await page.locator(`.request-row[data-view-key="request:${human.scenarioId}"] .full-text-preview-label`).textContent(), "Your prompt");
    const after = (await loadBoardState(app.context)).evidence.find(record => record.scenarioId === human.scenarioId);
    assert.equal(after.userPrompt.sourceEventId, record.userPrompt.sourceEventId);
    assert.equal(after.userPrompt.text, record.userPrompt.text);
    assert.deepEqual(after.toolCalls, record.toolCalls);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
});

test("collector -> real server -> Activity, reader and new report preserve truthful authorship", { timeout: 90000 }, async t => {
    const app = await promptInstallation(t);
    await app.runtime().collector.collectNow();
    const before = await loadBoardState(app.context), sourceBytes = await Promise.all(app.sourceFiles.map(file => readFile(file)));
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 950 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const errors = [], external = [], writes = [], metrics = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("request", request => {
        if (/\/api\/(?:collection|deletion|assessment\/(?:consent|feedback))\//.test(request.url()) && request.method() === "POST") writes.push(new URL(request.url()).pathname);
    });
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === new URL(app.runtime().url).origin) return route.continue();
        external.push(route.request().url()); return route.abort();
    });
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []); });
    if (proof) await mkdir(proof, { recursive: true });
    await page.goto(app.runtime().url + "#activity"); await ready(page); await openActivitySessions(page);
    for (const item of app.cases) {
        await page.locator("#activitySearch").fill(item.data.content.slice(0, 40)); await ready(page); await openActivitySessions(page);
        const row = page.locator(`.request-row[data-view-key="request:${item.scenarioId}"]`);
        const caption = item.actor === "user" ? "Your prompt" : item.actor === "agent" ? "Agent prompt" : "Copilot chat prompt / author unverified";
        assert.equal(await row.locator(".full-text-preview-label").textContent(), caption, item.name);
    }
    await page.locator("#activitySearch").fill(""); await ready(page);
    await navigateMain(page, "home"); await ready(page);
    await page.locator('[data-select-id="outcomeFilter"]').click();
    for (const option of await page.locator(".select-popup:visible .select-option").all()) {
        const wanted = await option.getAttribute("data-value") === "success";
        if ((await option.getAttribute("aria-selected") === "true") !== wanted) await option.click();
    }
    await page.locator(".select-popup:visible").getByRole("button", { name: "Apply", exact: true }).click(); await ready(page);
    await navigateMain(page, "activity"); await ready(page); await openActivitySessions(page);
    assert.match(await page.locator("#activityListSummary").textContent(), new RegExp(`${app.cases.length} request groups`), "Authorship does not change outcome filtering");
    await page.locator("#activitySearch").fill("Invented planning-only kickoff"); await ready(page); await openActivitySessions(page);
    const kickoff = app.cases[0], row = page.locator(`.request-row[data-view-key="request:${kickoff.scenarioId}"]`);
    await row.locator("input").check();
    const listRead = row.getByRole("button", { name: "Read full prompt", exact: true });
    await listRead.focus(); await page.keyboard.press("Enter");
    assert.equal(await row.locator(".ux-code-label").textContent(), "Agent prompt / local only");
    assert.equal(await row.locator("pre").textContent(), kickoff.data.content);
    await row.getByRole("link", { name: "View interaction", exact: true }).click(); await ready(page);
    const reader = page.locator(".request-original");
    await reader.getByRole("button", { name: "Read prompt", exact: true }).focus(); await page.keyboard.press("Enter");
    assert.equal(await reader.locator("pre").textContent(), kickoff.data.content);
    assert.equal(await reader.locator("pre").getAttribute("aria-label"), "Exact recorded prompt text");
    assert.equal(await reader.getByRole("button", { name: "Copy prompt", exact: true }).count(), 1);
    assert.equal(await reader.locator(".full-text-toggle").evaluate(node => document.activeElement === node), true);
    await page.goBack(); await ready(page);
    assert.equal(await row.locator("input").isChecked(), true);
    assert.equal(await row.getByRole("button", { name: "Hide prompt", exact: true }).getAttribute("aria-expanded"), "true");
    await row.getByRole("button", { name: "Hide prompt", exact: true }).click();
    for (const theme of ["light", "dark"]) for (const width of [1200, 375]) {
        await page.setViewportSize({ width, height: 950 }); await chooseTheme(page, theme);
        await row.scrollIntoViewIfNeeded();
        const layout = await row.evaluate(node => {
            const label = node.querySelector(".full-text-preview-label"), style = getComputedStyle(label);
            const background = getComputedStyle(node).backgroundColor;
            return { overflow: document.documentElement.scrollWidth - innerWidth,
                label: label.textContent, color: style.color, background, labelOverflow: label.scrollWidth - label.clientWidth };
        });
        assert.ok(layout.overflow <= 1 && layout.labelOverflow <= 1);
        assert.ok(contrast(layout.color, layout.background) >= 4.5);
        metrics.push({ surface: "activity", theme, width, ...layout });
        if (proof) await row.screenshot({ path: path.join(proof, `activity-${theme}-${width}.png`) });
    }
    for (const item of app.cases) {
        await page.goto(app.runtime().url + `#request?request=${encodeURIComponent(item.scenarioId)}`); await ready(page);
        const label = promptAuthorship.label({ authorship: { actor: item.actor, basis: item.basis } }, { originKind: "copilot-chat" });
        assert.equal(await reader.getByRole("heading", { name: label, exact: true }).count(), 1, item.name);
        if (item.actor === "unknown") assert.match(await reader.innerText(), /Author unverified/);
        else assert.doesNotMatch(await reader.innerText(), /Author unverified/);
        const toggle = reader.locator(".full-text-toggle");
        if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
        assert.equal(await reader.locator("pre").textContent(), item.data.content);
        assert.equal(await reader.locator("pre").getAttribute("aria-label"), "Exact recorded prompt text");
        if (["human", "agent", "legacy"].includes(item.name)) for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
            if (proof) await reader.screenshot({ path: path.join(proof, `reader-${item.name}-${theme}-375.png`) });
        }
        if (item.name === "human") await page.getByRole("button", { name: "Add to report", exact: true }).click();
    }
    await page.setViewportSize({ width: 1200, height: 950 });
    await navigateMain(page, "reports"); await ready(page);
    await page.locator("#reportRequests > summary").click();
    assert.deepEqual((await page.locator("#reportList .full-text-preview-label").allTextContents()).sort(), ["Agent prompt", "Your prompt"]);
    await reportContents(page);
    await page.locator('[name=promptMode][value=original]').check();
    for (const format of ["json", "markdown"]) await page.locator(`#formatOptions input[value=${format}]`).check();
    const preview = await scanReport(page);
    const frame = page.frameLocator(".report-frame");
    assert.equal(await frame.locator(".prompt h4").filter({ hasText: /^User prompt$/ }).count(), 1);
    assert.equal(await frame.locator(".prompt h4").filter({ hasText: /^Agent prompt$/ }).count(), 1);
    await frame.locator(".prompt-record > summary").first().click();
    await inspectReportCopies(page);
    assert.ok((await page.locator(".prompt-comparison > summary").allTextContents()).some(text => text.startsWith("Agent prompt")));
    assert.ok((await page.locator(".prompt-comparison > summary").allTextContents()).some(text => text.startsWith("Your prompt")));
    if (proof) {
        await page.locator(".report-frame").screenshot({ path: path.join(proof, "new-report.png") });
        await frame.locator(".prompt-record > summary").nth(1).click();
        await frame.getByRole("heading", { level: 4, name: "User prompt", exact: true }).locator("..")
            .screenshot({ path: path.join(proof, "new-report-user.png") });
    }
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    const saved = await loadBoardState(app.context);
    assert.equal(saved.exports.length, 1);
    assert.deepEqual(saved.evidence, before.evidence);
    const bundle = await buildSanitizedBundle(before.evidence, before.pseudonymKey, { promptMode: "none", formats: ["json"] });
    for (const record of bundle.records) {
        const origin = record.prompts.find(prompt => prompt.kind === "origin");
        assert.equal(origin.text, null);
        assert.deepEqual(Object.keys(origin.authorship).sort(), ["actor", "basis"]);
    }
    const projection = JSON.stringify(preview.records);
    for (const item of app.cases) assert.equal(projection.includes(item.promptId), false, "No raw prompt event IDs in reports");
    assert.equal(projection.includes(app.parent), false, "No raw creator IDs in reports");
    assert.deepEqual(await Promise.all(app.sourceFiles.map(file => readFile(file))), sourceBytes);
    if (proof) await writeFile(path.join(proof, "authorship-proof.json"), JSON.stringify({
        cases: app.cases.map(({ name, actor, basis }) => ({ name, actor, basis })),
        observations: metrics, reportActors: preview.records.map(record => record.prompts.find(prompt => prompt.kind === "origin").authorship),
        errors, external, forbiddenWrites: writes, exactTextPreserved: true, membershipUnchanged: true,
    }, null, 2));
});
