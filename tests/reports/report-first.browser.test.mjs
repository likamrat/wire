import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, navigateMain } from "../support/helpers.mjs";
import { selectReportFocus, prepareReportPreview, prepareLandingReport, chooseLandingReportDates, viewAllSavedReports } from "./report-journey-helpers.mjs";
import { openDatePicker } from "../analyze/analytics-date-picker.mjs";
import { reviewRecords } from "../support/frontend-fixture.mjs";
import { reportContextFixture } from "./report-context-fixture.mjs";
import { time } from "../../lib/time.mjs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCopilotRuntimeAccess } from "../../lib/runtime-access.mjs";
import { periodFixture } from "../comparison/period-comparison-fixture.mjs";

function records() {
    return Array.from({ length: 8 }, (_, index) => {
        const record = fixture(`report-first-${index}`);
        record.capturedAt = new Date().toISOString();
        record.toolCalls[0].startedAt = record.capturedAt;
        record.userPrompt.text = `REPORT_FIRST_${index} Find mailbox messages for email@example.invalid.`;
        record.toolCalls[0].toolSucceeded = index < 2 ? false : true;
        record.toolCalls[0].reportedOutcome = index < 2 ? "failed" : "succeeded";
        record.toolCalls[0].apiResults = [{ index: 0, statusCode: index < 2 ? 403 : 200 }];
        return record;
    });
}
async function setup(t, { source = records(), route = "#reports", enforced = false, frontend = "bundled", now, hasTouch = false, contextFixture = false, timezoneId = "America/Los_Angeles" } = {}) {
    const cleanup = [], lifetime = { after: work => cleanup.push(work) };
    const { context } = contextFixture ? await reportContextFixture(lifetime) : await privateFixture(lifetime, source);
    const access = enforced ? await createCopilotRuntimeAccess(context) : undefined;
    const runtime = await startServer(context, createExportController(context), { port: 0, frontend, collector: { timers: false }, ...(access ? { access } : {}) });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); await access?.close(); for (const work of cleanup) await work(); });
    const profile = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId, hasTouch });
    const page = await profile.newPage();
    if (now) await page.clock.setFixedTime(new Date(now));
    page.setDefaultTimeout(10000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.stack));
    page.on("request", request => { if (request.method() === "POST") requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
    await page.goto(runtime.url + route);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.deepEqual(errors, []);
    return { page, context, source, errors, requests, runtime };
}
async function prepare(page, preset = "errors") {
    await selectReportFocus(page, preset);
    return prepareSelectedFocus(page);
}

test("Reports opens visible preset actions, keeps Custom last and resumes the same preview", { timeout: 60000 }, async t => {
    const { page, context, requests, errors } = await setup(t, { frontend: "react" });
    const list = page.locator(".report-preset-list"), errorPreset = page.locator("#reportPreset-errors");
    await expect(page.locator(".report-gallery-header h2")).toHaveText("New report");
    assert.deepEqual(await list.locator("[data-report-preset]").evaluateAll(nodes => nodes.map(node => node.dataset.reportPreset)),
        ["all", "errors", "tokens", "completed", "mine", "agent"]);
    await expect(list.locator("li").last()).toContainText("Custom report");
    await expect(list.locator("li").last()).toContainText("Set up");
    await expect(page.locator("#reportDraftsPanel")).toContainText("Drafts");
    await expect(page.locator(".report-desk")).toBeHidden();
    const completedIcon = page.locator("#reportPreset-completed > [data-icon-role=result-success]");
    for (const [theme, width] of [["light",1366],["dark",390]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 900 });
        await navigateMain(page, "compare");
        await page.locator("#comparisonQuickChoice-control").click();
        const peer = page.getByRole("option", { name: "Completed calls", exact: true }).locator("[data-icon-role=result-success]");
        const successInk = await peer.evaluate(icon => getComputedStyle(icon).color);
        await page.keyboard.press("Escape");
        await navigateMain(page, "reports");
        await expect(completedIcon).toHaveCSS("color", successInk);
        const before = await errorPreset.boundingBox();
        await errorPreset.hover(); await errorPreset.focus(); await errorPreset.press("Tab"); await page.keyboard.press("Shift+Tab");
        await expect(errorPreset).toBeFocused();
        await expect(errorPreset).toHaveCSS("text-decoration-line", "none");
        assert.ok(await list.locator(".report-preset-destination").evaluateAll(nodes =>
            nodes.every(node => parseFloat(getComputedStyle(node).fontSize) >= 12)));
        assert.deepEqual(await errorPreset.boundingBox(), before);
        await captureReport(page, `report-entry-${theme}-${width}`);
    }
    await page.emulateMedia({ forcedColors: "active" });
    await expect(completedIcon).toHaveCSS("color", await errorPreset.evaluate(button => getComputedStyle(button).color));
    await page.emulateMedia({ forcedColors: "none" });
    assert.equal(requests.filter(r => r.path === "/api/preview").length, 0);
    const response = page.waitForResponse(r => r.url().endsWith("/api/preview"));
    await errorPreset.press("Enter");
    const first = await (await response).json();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    assert.equal(first.snapshot.reportPopulation.reference.length, 8);
    assert.equal(first.records.length, 2);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.locator("#reportLibraryLink").click();
    await expect(page.locator("#reportResumePreview")).toBeVisible();
    await selectReportFocus(page, "all");
    await page.getByRole("button", { name: "Back to report choices", exact: true }).click();
    const beforeResume = requests.filter(r => r.path === "/api/preview").length;
    await page.locator("#reportResumePreview").click();
    await expect(page.locator("#reportPreviewDrawer")).toBeVisible();
    await expect(page.locator("#reportDeskFocus")).toHaveValue("errors");
    assert.equal(requests.filter(r => r.path === "/api/preview").length, beforeResume);
    assert.equal(requests.filter(r => r.path === "/api/export").length, 0);
    assert.deepEqual(errors, []);
});

for (const [zone,today,tomorrow] of [["America/Los_Angeles","2026-02-28","2026-03-01"],["Asia/Tokyo","2026-03-01","2026-03-02"]]) {
    test(`historical calendars stop at ${today} in ${zone} for the same instant`, async t => {
        const {page,requests}=await setup(t,{frontend:"react",route:"reports",timezoneId:zone,now:"2026-03-01T00:15:00Z"});
        const desk = page.locator("#reportDeskDates"), accepted = await desk.innerText();
        await chooseLandingReportDates(page, "Custom dates");
        const calendar = page.locator("#reportCustomDates"), end=calendar.locator("#reportDateto");
        await expect(end).toHaveAttribute("max",today);
        const previous = calendar.getByRole("button", { name:"Previous month" });
        await previous.press("Enter"); await expect(previous).toBeFocused();
        const next = calendar.getByRole("button", { name:"Next month" });
        await next.press("Enter");
        if (await next.isDisabled()) await expect(calendar.locator('[data-day][tabindex="0"]')).toBeFocused();
        else await expect(next).toBeFocused();
        if (zone === "Asia/Tokyo") await calendar.getByRole("button",{name:"Next month"}).click();
        const last=calendar.locator(`[data-day="${today}"]`);
        await expect(last).toBeEnabled(); await last.focus(); await last.press("ArrowRight"); await expect(last).toBeFocused();
        await expect(calendar.getByRole("button",{name:"Next month"})).toBeDisabled();
        if(zone === "Asia/Tokyo") await expect(calendar.locator(`[data-day="${tomorrow}"]`)).toBeDisabled();
        const written = () => requests.filter(r=>/\/(?:preview|export|period-comparison)$/.test(r.path)).length;
        const before = written();
        await end.fill(tomorrow); await expect(calendar.getByRole("button",{name:"Apply dates",exact:true})).toBeDisabled();
        await expect(calendar.locator("#reportDateStatus")).toHaveText("Choose today or an earlier date.");
        await calendar.getByRole("button",{name:"Cancel"}).click(); await expect(desk).toHaveText(accepted);
        assert.equal(written(),before);
        await navigateMain(page,"compare"); await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
        await openDatePicker(page, "compare", "Custom dates");
        const pair=page.locator("#comparisonCustomDates"), prior=written();
        for (const side of ["A","B"]){
            await expect(pair.locator(`#comparison${side}To`)).toHaveAttribute("max",today);
            await pair.locator(`#comparison${side}From`).fill(today);
            await pair.locator(`#comparison${side}To`).fill(tomorrow);await expect(pair.locator("#applyPeriodComparison")).toBeDisabled();
            await pair.locator(`#comparison${side}To`).fill(today);
        }
        assert.equal(written(),prior);
        await pair.locator("#applyPeriodComparison").click();
        await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
        assert.equal(written(),prior+1);
    });
}

test("an open calendar enables the next month at midnight in the display zone without applying a draft", async t => {
    const {page,requests}=await setup(t,{frontend:"react",route:"reports",now:"2026-03-01T07:59:00Z"});
    await page.clock.install({time:new Date("2026-03-01T07:59:00Z")});
    const desk=page.locator("#reportDeskDates"), accepted=await desk.innerText();
    await chooseLandingReportDates(page, "Custom dates");
    const calendar=page.locator("#reportCustomDates"), end=calendar.locator("#reportDateto");
    await expect(end).toHaveAttribute("max","2026-02-28");
    await calendar.locator("#reportDatefrom").fill("2026-02-27");
    await end.fill("2026-03-01");
    await expect(calendar.getByRole("button",{name:"Next month"})).toBeDisabled();
    await expect(calendar.getByRole("button",{name:"Apply dates",exact:true})).toBeDisabled();
    await page.clock.fastForward(61_000);
    await expect(end).toHaveAttribute("max","2026-03-01");
    await calendar.getByRole("button",{name:"Next month"}).click();
    await expect(calendar.locator('[data-day="2026-03-01"]')).toBeEnabled();
    await expect(calendar.locator('[data-day="2026-03-02"]')).toBeDisabled();
    await expect(calendar.getByRole("button",{name:"Apply dates",exact:true})).toBeEnabled();
    await calendar.getByRole("button",{name:"Cancel"}).click();
    await expect(desk).toHaveText(accepted);
    assert(!requests.some(r=>["/api/preview","/api/export"].includes(r.path)));
});

test("period choices keep exact dates and reserve explanations for restrictions", async t => {
    const { page, requests } = await setup(t, { frontend: "react", route: "trends", source: periodFixture().records, now: "2026-03-10T12:00:00Z" });
    await page.getByRole("button", { name: "Compare periods", exact: true }).click();
    await page.getByRole("button", { name: "Open comparison", exact: true }).click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    const pair = page.locator(".compare-period-key");
    await expect(pair).toContainText("Feb 25–Mar 3, 2026");
    await expect(pair).toContainText("Mar 4–10, 2026");
    await expect(page.locator("#periodComparisonResults")).not.toContainText(/Both collections|Source: GitHub Copilot|compare against|to review/);
    const edit = page.getByRole("button", { name: /^Change selected period:/ });
    await edit.click();
    const calendar = page.locator("#comparisonCustomDates");
    await expect(calendar.locator("legend:visible")).toHaveText(["Selected"]);
    assert.equal(await page.locator(":modal:visible").count(),0);
    await expect(calendar).not.toContainText(/inclusive dates|America\/Los_Angeles/i);
    await calendar.locator("#comparisonBTo").fill("2026-03-01");
    await expect(calendar.locator("#comparisonBStatus")).toContainText(/end.*start/i);
    await expect(calendar.getByRole("button", { name: "Apply dates", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(edit).toBeFocused();
    await expect(edit).toContainText("Mar 4–10, 2026");
    const compareReads = () => requests.filter(request=>request.path === "/api/period-comparison").length;
    const before = compareReads(), baseline = page.getByRole("button",{name:/^Change baseline period:/});
    await baseline.click();
    await expect(calendar.locator("legend:visible")).toHaveText(["Baseline"]);
    await calendar.locator("#comparisonAFrom").fill("2026-03-07");
    await calendar.locator("#comparisonATo").fill("2026-03-07");
    await calendar.getByRole("button",{name:"Apply dates",exact:true}).click();
    await expect(pair).toContainText("Mar 7, 2026");
    await expect(baseline).toBeFocused();
    await expect(edit).toContainText("Mar 4–10, 2026");
    assert.equal(compareReads(),before+1);
});

test("narrow Reports keeps presets available while editing custom dates", async t => {
    const { page, requests } = await setup(t, { frontend: "react", route: "reports", now: "2026-03-10T12:00:00Z" });
    await page.setViewportSize({ width: 375, height: 812 });
    const desk = page.locator("#reportDeskDates"), period = page.locator("#reportPeriodChoices");
    await chooseLandingReportDates(page, "Custom dates");
    await expect(period).not.toContainText(/both endpoints|presets include today|America\/Los_Angeles/i);
    await expect(page.locator("#reportDatefrom")).toHaveValue("2026-03-04");
    await expect(page.locator("#reportDateto")).toHaveValue("2026-03-10");
    await expect(page.locator("#reportCustomDates")).not.toContainText(/inclusive dates|America\/Los_Angeles/i);
    await expect(page.locator("#reportPeriodChoices:popover-open #reportCustomDates")).toBeVisible();
    await page.locator("#reportDatefrom").fill("2026-03-01");
    await period.getByRole("button", { name: "Last 14 days", exact: true }).click();
    await expect(period).toBeHidden();
    await chooseLandingReportDates(page, "Custom dates");
    await expect(page.locator("#reportDatefrom")).toHaveValue("2026-02-25");
    await expect(page.locator("#reportDateto")).toHaveValue("2026-03-10");
    await period.getByRole("button",{name:"Cancel",exact:true}).click();
    await expect(desk).toBeFocused();
    await page.locator("#reportCustomSetup").click();
    const files=page.locator('[popovertarget="reportFileOptions"]');
    await files.click(); await expect(page.locator("#reportFileOptions:popover-open")).toBeVisible();
    assert.equal(await page.locator(":modal:visible").count(),0);
    assert(!requests.some(r=>["/api/preview","/api/export"].includes(r.path)));
});
async function prepareSelectedFocus(page) {
    const response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await prepareReportPreview(page);
    const result = await response, body = await result.json();
    assert.equal(result.status(), 200, body.error);
    await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeVisible();
    return body;
}

async function openReviewPicker(t) {
    const app = await setup(t, { source: reviewRecords(), frontend: "react", now: "2026-11-18T16:00:00Z",
        route: "#analyze?range=custom&from=2026-11-10&to=2026-11-16" });
    app.before = await loadBoardState(app.context);
    await chooseTheme(app.page, "light");
    await navigateMain(app.page, "reports");
    await chooseLandingReportDates(app.page, "Last 14 days");
    app.prepared = await prepare(app.page, "all");
    await app.page.getByRole("button", { name: "Change what's included", exact: true }).click();
    await app.page.getByRole("button", { name: "Change activity selection", exact: true }).click();
    await expect(app.page.locator("#reportActivityOptions")).toBeVisible();
    return app;
}

async function capturePicker(page, name) {
    const proofs = process.env.WIRE_REPORT_FIRST_PROOFS;
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
    await page.screenshot({ path: path.join(proofs, name + ".png") });
    const geometry = await page.locator("#reportActivityOptions").evaluate(picker => ({
        viewport: { width: innerWidth, height: innerHeight, font: getComputedStyle(document.documentElement).fontSize },
        open: picker.matches(":popover-open"),
        regions: [picker, ...picker.querySelectorAll(".report-selection-body,.report-request-page")].map(node => ({
            name: node.id || node.className, height: node.clientHeight, scrollHeight: node.scrollHeight,
            scrollTop: node.scrollTop, overflow: getComputedStyle(node).overflowY,
        })),
    }));
    await writeFile(path.join(proofs, name + ".json"), JSON.stringify(geometry, null, 2));
}

async function captureReport(page, name) {
    const proofs = process.env.WIRE_REPORT_FIRST_PROOFS;
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
    await page.screenshot({ path: path.join(proofs, name + ".png") });
}

test("linked context changes preserve ordinary edited and omitted report copies", { timeout: 60000 }, async t => {
    const source = reviewRecords().slice(0, 2);
    source[1].sourceSessionId = source[0].sourceSessionId;
    const { page, context, errors } = await setup(t, { source, frontend: "react", now: "2026-11-18T16:00:00Z" });
    await chooseLandingReportDates(page, "Last 14 days");
    const initial = await prepare(page, "all");
    const origin = initial.promptReview.find(copy => copy.kind === "origin");
    const tool = initial.promptReview.find(copy => copy.kind === "tool");
    assert.ok(origin && tool);
    await selectActivityOption(page, "preparedReportView", "text");
    async function updateCopy(key, { text, omit }) {
        const copy = page.locator(`.prompt-comparison[data-copy-key="${key}"]`);
        while (!await copy.count()) await page.getByRole("button", { name: "Next report copies", exact: true }).click();
        await copy.getByText("Edit or omit this report copy", { exact: true }).click();
        if (omit) await copy.getByRole("checkbox").check();
        else await copy.locator("textarea").fill(text);
        const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await copy.getByRole("button", { name: "Update report copy", exact: true }).click();
        return (await pending).json();
    }
    await updateCopy(origin.key, { text: "Deliberately revised release wording." });
    await updateCopy(tool.key, { omit: true });
    await captureReport(page, "copy-omitted-before-context");
    let updated;
    for (const enabled of [true, false, true]) {
        await page.getByRole("button", { name: "Change what's included", exact: true }).click();
        const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator("#reportRecordedContext").setChecked(enabled);
        const response = await pending;
        updated = await response.json();
        const copies = updated.records.flatMap(record => record.prompts);
        assert.ok(copies.some(copy => copy.representation === "edited-copy" && copy.text === "Deliberately revised release wording."));
        assert.ok(copies.some(copy => copy.kind === "tool" && copy.omitted && copy.text === null));
        assert.deepEqual(updated.snapshot.reportPopulation, initial.snapshot.reportPopulation);
        await page.locator("#reportIncludeOptions").getByRole("button", { name: "Done", exact: true }).click();
    }
    await captureReport(page, "copy-omitted-after-context");
    await page.locator("#reportPrivacyChoice").click();
    for (const mode of ["original", "none", "masked"]) {
        const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`[name=promptMode][value=${mode}]`).check();
        updated = await (await pending).json();
        assert.deepEqual(updated.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    }
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    const copies = updated.records.flatMap(record => record.prompts);
    assert.ok(copies.some(copy => copy.representation === "edited-copy" && copy.text === "Deliberately revised release wording."));
    assert.ok(copies.some(copy => copy.kind === "tool" && copy.omitted && copy.text === null));
    await page.getByRole("button", { name: "Formats: HTML", exact: true }).click();
    for (const format of ["pdf", "json", "markdown"]) {
        const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value=${format}]`).check();
        updated = await (await pending).json();
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const saved = (await loadBoardState(context)).exports;
    assert.equal(saved.length, 1);
    for (const [name, file] of Object.entries(saved[0].files)) {
        if (name === "coverage-and-redaction-manifest.json") continue;
        const expected = updated.files[name];
        assert.deepEqual(await readFile(file), typeof expected === "string" ? Buffer.from(expected) : Buffer.from(expected.data, "base64"));
    }
    const frozen = JSON.parse(await readFile(saved[0].files["product-report.json"], "utf8"));
    assert.ok(frozen.records.flatMap(record => record.prompts).some(copy => copy.kind === "tool" && copy.omitted));
    assert.doesNotMatch(JSON.stringify(frozen), /Find the decisions from the Cedar launch review/);
    assert.deepEqual(errors, []);
});

test("Reports author pointer drafts stay inside their popover until Apply or Cancel", { timeout: 60000 }, async t => {
    const { page, requests, errors } = await setup(t, { source: reviewRecords().slice(0, 4), frontend: "react",
        now: "2026-11-18T16:00:00Z", hasTouch: true });
    await chooseLandingReportDates(page, "Last 14 days");
    await prepare(page, "all");
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    const trigger = page.getByRole("combobox", { name: "Authors in report", exact: true });
    const reads = requests.filter(request => request.path === "/api/preview").length;
    await trigger.click();
    await page.getByRole("option", { name: "Agent prompts", exact: true }).click();
    await expect(page.locator("#reportIncludeOptions")).toBeVisible();
    await expect(page.locator(".select-popup").getByRole("button", { name: "Apply", exact: true })).toBeVisible();
    await captureReport(page, "author-pointer-draft");
    assert.equal(requests.filter(request => request.path === "/api/preview").length, reads);
    await page.locator(".select-popup").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(trigger).toBeFocused();
    assert.deepEqual(await page.locator("#reportPromptAuthorFilter").evaluate(node =>
        [...node.selectedOptions].map(option => option.value)), ["user", "agent", "unknown"]);
    await trigger.click();
    await page.getByRole("option", { name: "Human prompts", exact: true }).click();
    await page.getByRole("option", { name: "Sender unclear", exact: true }).click();
    const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator(".select-popup").getByRole("button", { name: "Apply", exact: true }).click();
    const updated = await (await pending).json();
    assert.equal(updated.records.length, 1);
    await expect(trigger).toBeFocused();
    await expect(page.locator("#reportIncludeOptions")).toBeVisible();
    await captureReport(page, "author-apply-focus");
    if (process.env.WIRE_REPORT_FIRST_PROOFS) await writeFile(path.join(process.env.WIRE_REPORT_FIRST_PROOFS, "author-apply.json"),
        JSON.stringify({ focused: await trigger.evaluate(node => document.activeElement === node),
            containingPanelOpen: await page.locator("#reportIncludeOptions").evaluate(node => node.matches(":popover-open")),
            includedInteractions: updated.records.length }, null, 2));
    assert.deepEqual(await page.locator("#reportPromptAuthorFilter").evaluate(node =>
        [...node.selectedOptions].map(option => option.value)), ["agent"]);
    await trigger.tap();
    await page.getByRole("option", { name: "Human prompts", exact: true }).tap();
    await page.locator(".select-popup").getByRole("button", { name: "Cancel", exact: true }).tap();
    await expect(trigger).toBeFocused();
    await trigger.press("ArrowDown");
    await trigger.press("Home");
    await trigger.press("Space");
    await trigger.press("Escape");
    await expect(trigger).toBeFocused();
    assert.deepEqual(await page.locator("#reportPromptAuthorFilter").evaluate(node =>
        [...node.selectedOptions].map(option => option.value)), ["agent"]);
    assert.deepEqual(errors, []);
});

test("linked retained replies preserve edits and a shared origin-followup omission through re-entry and Save", { timeout: 60000 }, async t => {
    const { page, context, requests } = await setup(t, { contextFixture: true, frontend: "react", now: "2026-09-30T20:00:00Z" });
    const initial = await prepare(page, "all");
    const frame = page.frameLocator(".report-frame");
    await frame.locator(".wire-reading-interaction>summary").first().click();
    await frame.locator(".wire-example-editor summary").first().click();
    await frame.getByLabel("Prompt in this report", { exact: true }).first().fill("Kept originating edit.");
    const editing = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await frame.getByRole("button", { name: "Update prompt copy", exact: true }).first().click();
    await editing;
    await frame.locator(".wire-reading-interaction>summary").nth(1).click();
    await frame.locator(".wire-example-editor summary").nth(1).click();
    await frame.getByLabel("Leave out this prompt", { exact: true }).nth(1).check();
    const omitting = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await frame.getByRole("button", { name: "Update prompt copy", exact: true }).nth(1).click();
    await omitting;
    let updated;
    for (const enabled of [true, false, true]) {
        await page.getByRole("button", { name: "Change what's included", exact: true }).click();
        const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator("#reportRecordedContext").setChecked(enabled);
        const response = await pending;
        updated = await response.json();
        assert.equal(response.status(), 200, updated.error);
        assert.ok(updated.records.flatMap(record => record.prompts).some(copy => copy.text === "Kept originating edit."));
        assert.ok(updated.records[1].prompts.find(copy => copy.kind === "origin").omitted);
        if (enabled) assert.ok(updated.snapshot.recordedContext.entries.some(copy => copy.kind === "response" && copy.text));
        assert.deepEqual(updated.snapshot.reportPopulation, initial.snapshot.reportPopulation);
        await page.locator("#reportIncludeOptions").getByRole("button", { name: "Done", exact: true }).click();
    }
    await page.locator("#reportPrivacyChoice").click();
    for (const mode of ["original", "none", "masked"]) {
        const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`[name=promptMode][value=${mode}]`).check();
        const response = await pending; updated = await response.json();
        assert.equal(response.status(), 200, updated.error);
    }
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    const including = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#reportRecordedContext").check();
    updated = await (await including).json();
    await page.locator("#reportIncludeOptions").getByRole("button", { name: "Done", exact: true }).click();
    const reply = updated.contextReview.find(copy => copy.kind === "response" && copy.original !== null);
    assert.ok(reply);
    await selectActivityOption(page, "preparedReportView", "text");
    const replyCopy = page.locator(`.prompt-comparison[data-copy-key="${reply.key}"]`);
    while (!await replyCopy.count()) await page.getByRole("button", { name: "Next report copies", exact: true }).click();
    await replyCopy.getByText("Edit or omit this report copy", { exact: true }).click();
    await replyCopy.locator("textarea").fill("Kept retained reply edit.");
    const editingReply = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await replyCopy.getByRole("button", { name: "Update report copy", exact: true }).click();
    updated = await (await editingReply).json();
    await captureReport(page, "shared-context-before-save");
    await page.getByRole("button", { name: "Formats: HTML", exact: true }).click();
    for (const format of ["pdf", "json", "markdown"]) {
        const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value=${format}]`).check();
        updated = await (await pending).json();
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const saved = (await loadBoardState(context)).exports;
    assert.equal(saved.length, 1);
    const snapshot = JSON.parse(await readFile(saved[0].files["product-report.json"], "utf8"));
    assert.ok(snapshot.records[1].prompts.find(copy => copy.kind === "origin").omitted);
    assert.ok(snapshot.records[0].prompts.find(copy => copy.kind === "followup").omitted);
    assert.ok(snapshot.recordedContext.entries.some(copy => copy.kind === "response" && copy.text === "Kept retained reply edit."));
    assert.match(JSON.stringify(snapshot), /Kept originating edit/);
    assert.equal(JSON.stringify(snapshot).includes(initial.records[1].prompts.find(copy => copy.kind === "origin").text), false);
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await selectActivityOption(page, "savedReaderFormat", "markdown");
    const definition = page.locator("#savedReportReader .saved-markdown p").filter({ hasText: "Calls follow each interaction" });
    await expect(definition).toContainText("interaction's retained order");
    await expect(definition).not.toContainText("&#39;");
    await definition.scrollIntoViewIfNeeded();
    await captureReport(page, "saved-markdown-definition");
    const proofs = process.env.WIRE_REPORT_FIRST_PROOFS, directory = proofs && path.join(proofs, "shared-context-saved");
    if (directory) await mkdir(directory, { recursive: true });
    for (const [name, file] of Object.entries(saved[0].files)) {
        if (directory) await writeFile(path.join(directory, name), await readFile(file));
        if (name === "coverage-and-redaction-manifest.json") continue;
        const expected = updated.files[name];
        assert.deepEqual(await readFile(file), typeof expected === "string" ? Buffer.from(expected) : Buffer.from(expected.data, "base64"));
    }
    if (directory) await writeFile(path.join(directory, "roundtrip-receipt.json"), JSON.stringify({
        exportRequests: requests.filter(request => request.path === "/api/export").length,
        preparations: requests.filter(request => request.path === "/api/preview").map(({ body }) => ({
            context: body.options.recordedContext, mode: body.options.promptMode, overrides: body.options.overrides,
        })),
        bundleId: saved[0].bundleId, membership: snapshot.reportPopulation,
    }, null, 2));
});

test("a later user focus choice supersedes pending inline reading restoration", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await prepare(page);
    const frame = page.frameLocator(".report-frame");
    await frame.locator(".wire-reading-interaction>summary").first().click();
    await frame.locator(".wire-example-editor summary").first().click();
    await frame.getByLabel("Prompt in this report", { exact: true }).first().fill("Updated before a newer reading intent.");
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/preview", async route => {
        const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await frame.getByRole("button", { name: "Update prompt copy", exact: true }).first().click();
    await entered.promise;
    const name = page.getByLabel("Report name", { exact: true });
    await name.click();
    const position = await page.evaluate(() => scrollY);
    release.resolve(); await pending;
    await expect(frame.getByRole("button", { name: "Update prompt copy", exact: true }).first()).toBeVisible();
    await expect(name).toBeFocused();
    assert.equal(await page.evaluate(() => scrollY), position);
});

test("inline copy updates retain the outer screen anchor, not just iframe coordinates", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await prepare(page);
    const frame = page.frameLocator(".report-frame");
    await frame.locator(".wire-reading-interaction>summary").first().click();
    await frame.locator(".wire-example-editor summary").first().click();
    const button = frame.getByRole("button", { name: "Update prompt copy", exact: true }).first();
    await frame.getByLabel("Prompt in this report", { exact: true }).first().fill("Outer reading stays here.");
    await button.scrollIntoViewIfNeeded();
    const drawer = page.locator("#reportPreviewDrawer");
    await drawer.evaluate(node => node.scrollTo(0, 197));
    await button.focus();
    const position = async () => ({ outer: await drawer.evaluate(node => node.scrollTop), button: await button.boundingBox() });
    const before = await position();
    assert.ok(before.outer > 150);
    await expect(button).toBeInViewport();
    await captureReport(page, "outer-reading-before");
    const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await button.click();
    await pending;
    await expect(button).toBeFocused();
    await expect.poll(async () => Math.abs((await position()).button.y - before.button.y)).toBeLessThan(3);
    const after = await position();
    assert.ok(Math.abs(after.outer - before.outer) < 3);
    await captureReport(page, "outer-reading-retained");
    if (process.env.WIRE_REPORT_FIRST_PROOFS) await writeFile(path.join(process.env.WIRE_REPORT_FIRST_PROOFS, "outer-reading.json"),
        JSON.stringify({ before, after }, null, 2));
});

test("the normal Reports picker has one reading scroller and retains paging, selection and focus", { timeout: 60000 }, async t => {
    const { page, context, before, prepared, errors } = await openReviewPicker(t);
    assert.equal(prepared.records.length, 241);
    const picker = page.locator("#reportActivityOptions"), body = picker.locator(".report-selection-body");
    const rows = picker.locator(".report-request-page .request-row");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rows).toHaveCount(4);
    await capturePicker(page, "picker-mobile-top");
    const innerScrollers = await body.evaluate(node => [...node.querySelectorAll("*")].filter(child =>
        child.scrollHeight > child.clientHeight + 1 && /^(auto|scroll)$/.test(getComputedStyle(child).overflowY))
        .map(child => ({ className: child.className, height: child.clientHeight, scroll: child.scrollHeight })));
    assert.deepEqual(innerScrollers, [], "Only the picker body, not its relocated request page, owns vertical reading.");
    const first = rows.first();
    await first.scrollIntoViewIfNeeded();
    const start = await body.evaluate(node => node.scrollTop);
    const bounds = await body.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 70);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(start);
    assert.equal(await picker.locator(".report-request-page").evaluate(node => node.scrollTop), 0);
    for (let index = 0; index < 4; index++) {
        await rows.nth(index).locator(".request-card-open").scrollIntoViewIfNeeded();
        await expect(rows.nth(index).locator(".request-card-open")).toBeInViewport();
        await expect(picker.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
        await expect(picker.getByRole("button", { name: "Show report", exact: true })).toBeInViewport();
    }
    await picker.locator('[name=reportScope][value=selected]').check();
    await picker.locator("#report-select-search-0").check();
    await picker.getByRole("button", { name: "Next report requests", exact: true }).click();
    await picker.locator("#report-select-search-4").check();
    await picker.getByRole("button", { name: "Previous report requests", exact: true }).click();
    await expect(picker.locator("#report-select-search-0")).toBeChecked();
    await expect(picker.locator(".report-activity-summary")).toContainText("2 interactions included");
    await picker.getByRole("button", { name: "Close", exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(page.getByRole("button", { name: "Change what's included", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
    await expect(picker.locator("#report-select-search-0")).toBeChecked();
    const preparing = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await picker.getByRole("button", { name: "Show report", exact: true }).click();
    const response = await preparing, selected = await response.json();
    assert.deepEqual(response.request().postDataJSON().selection.scenarioIds.sort(), ["search-0", "search-4"]);
    assert.equal(selected.records.length, 2);
    assert.deepEqual(await loadBoardState(context), before);
    assert.deepEqual(errors, []);
});

test("the normal Reports picker preserves the exact known tool identity when opening its reader", { timeout: 60000 }, async t => {
    const { page, context, before, errors } = await openReviewPicker(t);
    const picker = page.locator("#reportActivityOptions");
    await picker.locator('[name=reportScope][value=selected]').check();
    const check = picker.locator("#report-select-search-0");
    await check.check();
    const row = page.locator("#report-select-search-0").locator("xpath=ancestor::article[1]");
    await capturePicker(page, "picker-known-tool");
    await expect(row.locator(".card-identities")).toContainText("workiq-retrieve");
    await expect(row.locator(".request-card-exception").first()).toHaveText("1 tool call failed");
    await expect(row.locator(".request-card-exception").last()).toHaveText("Returned entry 1 · HTTP 403 · Mail");
    await expect(row).toContainText("Access was denied");
    await expect(row).not.toContainText("WIRE interpretation");
    const origin = page.url();
    const prompt = row.locator(".request-card-open");
    const body = picker.locator(".report-selection-body");
    await prompt.scrollIntoViewIfNeeded();
    const top = await body.evaluate(node => node.scrollTop);
    await prompt.focus(); await page.keyboard.press("Enter");
    const reader = page.locator("#requestContent");
    await expect(reader).toContainText("Find the decisions from the Cedar launch review.");
    await expect(reader.locator(".reader-call-identity-line")).toContainText("workiq-retrieve");
    await expect(reader).toContainText("Access was denied");
    await expect(reader).toContainText("403");
    await capturePicker(page, "picker-known-tool-reader");
    await page.goBack();
    await expect(page).toHaveURL(origin);
    await expect(prompt).toBeFocused();
    await expect(picker).toBeVisible();
    await expect(check).toBeChecked();
    await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(top);
    const successRow = picker.locator(".request-row").filter({has:page.locator("a.card-outcome.result-tone-success")}).first();
    const completed = successRow.locator("a.card-outcome"), choice = successRow.locator("input[type=checkbox]");
    await expect(completed).toHaveText("1 tool call completed");
    const selectedBefore = await choice.isChecked();
    await completed.focus(); await page.keyboard.press("Enter");
    const calls = reader.locator('[data-reader-section="activity"]');
    await expect(calls.locator("h2")).toContainText("1 completed call");
    await expect(calls.locator(".reader-call-row")).toHaveCount(1);
    await page.goBack(); await expect(completed).toBeFocused();
    assert.equal(await choice.isChecked(),selectedBefore);
    await expect(check).toBeChecked();
    await picker.getByRole("button", {name:"Close",exact:true}).click();
    await expect(page.getByRole("button", { name: "Change what's included", exact: true })).toBeVisible();
    assert.deepEqual(await loadBoardState(context), before);
    assert.deepEqual(errors, []);
});

test("the normal Reports picker keeps long plural evidence readable in both themes and enlarged text", { timeout: 60000 }, async t => {
    const { page, context, before, errors } = await openReviewPicker(t);
    const picker = page.locator("#reportActivityOptions"), body = picker.locator(".report-selection-body");
    for (const [theme, width, height, size] of [
        ["light", 390, 844, 100], ["dark", 390, 844, 100],
        ["light", 1440, 1000, 100], ["light", 1024, 1000, 200], ["dark", 1024, 1000, 200],
    ]) {
        await picker.getByRole("button", { name: "Close", exact: true }).click();
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height });
        await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; }, size);
        await page.getByRole("button", { name: "Change what's included", exact: true }).click();
        await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
        await picker.locator("#reportRequestSearch").fill("");
        await body.evaluate(node => { node.scrollTop = 0; });
        await capturePicker(page, `picker-${theme}-${width}-${size}-top`);
        await picker.locator("#reportRequestSearch").fill("Review the Cedar handover");
        const row = picker.locator(".request-row");
        await expect(row).toHaveCount(1);
        await expect(row.locator(".card-identities")).toContainText("workiq-retrieve");
        await expect(row.locator(".request-card-exception")).toHaveText(["1 tool call failed", /Returned entry \d+ · HTTP 403/]);
        await row.scrollIntoViewIfNeeded();
        await capturePicker(page, `picker-${theme}-${width}-${size}-plural`);
        const layout = await body.evaluate(node => ({
            scrollOwner: getComputedStyle(node).overflowY,
            overflow: node.scrollWidth > node.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1,
            nested: [...node.querySelectorAll("*")].filter(child => child.scrollHeight > child.clientHeight + 1
                && /^(auto|scroll)$/.test(getComputedStyle(child).overflowY)).map(child => child.className),
        }));
        assert.deepEqual(layout, { scrollOwner: "auto", overflow: false, nested: [] });
        const footer = await row.locator(".card-reading-actions").boundingBox(), rowBox = await row.boundingBox();
        assert.ok(footer.width > rowBox.width / 2, "Evidence links must not wrap inside the checkbox column.");
        await expect(picker.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
        await expect(picker.getByRole("button", { name: "Show report", exact: true })).toBeInViewport();
        await picker.getByRole("button", { name: "Close", exact: true }).focus();
        await page.keyboard.press("Escape");
        await expect(picker).toBeHidden();
        await expect(page.getByRole("button", { name: "Change what's included", exact: true })).toBeFocused();
        await page.getByRole("button", { name: "Change what's included", exact: true }).click();
        await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
    }
    assert.deepEqual(await loadBoardState(context), before);
    assert.deepEqual(errors, []);
});

test("creation text choice applies before a preset preview without writing a report", { timeout: 60000 }, async t => {
    const { page, context, requests, errors } = await setup(t);
    const choice = page.locator("#reportPrivacyChoice");
    await choice.click();
    await expect(page.locator('#promptOptions [value=masked]')).toBeChecked();
    await expect(page.locator("#additionalMasking")).toBeHidden();
    await page.locator('[name=promptMode][value=none]').check();
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    assert.equal(requests.filter(request => request.path === "/api/preview").length, 0);
    await expect(page.locator("#reportStage1")).toBeVisible();
    const initial = await prepare(page);
    assert.equal(initial.promptMode, "none");
    assert.ok(initial.records.every(record => record.prompts.every(copy => copy.text === null)));
    assert.equal(initial.snapshot.reportPopulation.reference.length, 8);
    assert.equal(initial.records.length, 2);
    await expect(choice).toHaveAttribute("data-prompt-mode", "none");
    await choice.click();
    await expect(page.locator("#additionalMasking")).toBeVisible();
    await expect(page.locator("#additionalMasking summary")).toHaveText("Hide specific words");
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const saved = await loadBoardState(context);
    assert.equal(saved.exports[0].promptMode, "none");
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.locator("#savedReportReader").getByRole("heading", { level: 1 })).toHaveText(initial.title);
    await expect(page.getByRole("article", { name: "Report brief" })).toBeVisible();
    assert.equal(requests.filter(request => request.path === "/api/report/open").at(-1).body.bundleId, initial.bundleId);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    assert.deepEqual(errors, []);
});

test("report menus keep the native choice inside its paint and aligned with the first line", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, { frontend: "bundled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "150%"; });
    await page.evaluate(() => document.fonts.ready);
    await page.locator("#reportCustomSetup").click();
    const formats = page.locator('[popovertarget="reportFileOptions"]');
    await formats.click();
    const panel = page.locator("#reportFileOptions:popover-open");
    await expect.poll(() => panel.evaluate(n => Math.round(document.documentElement.getBoundingClientRect().right - n.getBoundingClientRect().right))).toBeGreaterThanOrEqual(8);
    await page.keyboard.press("Escape");
    await expect(formats).toBeFocused();
    async function inspectRows(selector) {
        const rows = page.locator(selector);
        const boxes = await rows.evaluateAll(nodes => nodes.map(node => {
            const input = node.querySelector("input").getBoundingClientRect(), row = node.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(node.querySelector("strong") || node.lastChild);
            const line = range.getClientRects()[0];
            return { inset: input.left - row.left, gap: line.left - input.right,
                lineOffset: input.top + input.height / 2 - line.top - line.height / 2,
                glyph: [input.width, input.height], height: row.height, overflow: node.scrollWidth - node.clientWidth };
        }));
        assert.ok(boxes.length >= 2);
        for (const box of boxes) {
            assert.deepEqual(box.glyph, [18, 18], "The native glyph must not acquire the target's height");
            assert.ok(box.height >= 44 && box.overflow <= 1 && Math.abs(box.lineOffset) <= 2, JSON.stringify(box));
            assert.equal(box.inset, 12, "Match the interior gutter of the painted filter options");
            assert.equal(box.gap, box.inset, "Balance the interior gutter and distance to the label");
        }
        return rows;
    }
    const modes = page.locator("#promptOptions .prompt-choice");
    const row = modes.first(), input = row.locator("input"), fill = () => row.evaluate(node => getComputedStyle(node).backgroundColor);
    await row.hover(); const hover = await fill(); assert.notEqual(hover, "rgba(0, 0, 0, 0)");
    await page.mouse.down(); assert.notEqual(await fill(), hover); await page.mouse.up();
    await expect(input).toBeChecked();
    await page.keyboard.press("ArrowDown");
    const next = modes.nth(1);
    await expect(next.locator("input")).toBeFocused();
    await expect(next.locator("input")).toBeChecked();
    await expect(next).toHaveCSS("outline-style", "solid");
    await page.locator('#promptOptions [value=masked]').check();
    await page.keyboard.press("Escape");
    assert.equal(requests.filter(request => request.path === "/api/preview").length, 0);
    await prepare(page, "all");
    await page.getByRole("button", { name: /^Formats:/ }).click();
    await inspectRows("#reportFileOptions .format-choices label");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    const inclusion = await inspectRows("#reportIncludeOptions .prompt-choice");
    const count = requests.filter(request => request.path === "/api/preview").length;
    const changed = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await inclusion.first().click({ position: { x: 4, y: 12 } });
    await changed; await expect(inclusion.first().locator("input")).toBeChecked();
    assert.equal(requests.filter(request => request.path === "/api/preview").length, count + 1);
    await page.keyboard.press("Escape");
    await page.locator("#reportPrivacyChoice").click();
    const omitted = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('#reportPrivacyOptions [value=none]').check(); await omitted;
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    const linked = page.locator("label:has(>#reportRecordedContext)");
    await expect(linked.locator("input")).toBeDisabled();
    await linked.hover(); await expect(linked).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("privacy choices have distinct readable state colors and labels in both themes", { timeout: 30000 }, async t => {
    const { page, requests, errors } = await setup(t);
    await page.locator("#reportCustomSetup").click();
    const luminance = channels => channels.map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const colors = new Set();
        for (const [mode, glyph, label] of [["original", "triangle-alert", "Keep chat details"],
            ["none", "message-square-off", "Leave out prompts and replies"], ["masked", "eye-off", "Mask detected details"]]) {
            await page.locator(`[name=promptMode][value=${mode}]`).check();
            const choice = page.locator(`.report-before-prepare [data-prompt-mode=${mode}] strong`);
            await expect(choice).toHaveText(label);
            await expect(choice.locator(`[data-lucide-icon=${glyph}]`)).toHaveCount(1);
            const { ink, paper } = await choice.evaluate((node, variable) => {
                const sample = document.createElement("span");
                sample.style.color = "var(--paper)"; node.append(sample);
                const paper = getComputedStyle(sample).color;
                sample.style.color = `var(${variable})`;
                const ink = getComputedStyle(sample).color; sample.remove();
                return { ink, paper };
            }, ({ masked: "--disclosure-masked", original: "--disclosure-risk", none: "--muted" })[mode]);
            await expect(choice).toHaveCSS("color", ink);
            colors.add(ink);
            const values = [ink, paper].map(color => luminance(color.match(/\d+/g).slice(0, 3).map(Number))).sort((a, b) => a - b);
            assert.ok((values[1] + .05) / (values[0] + .05) >= 4.5, `${theme}/${mode}: ${ink} on ${paper}`);
        }
        assert.equal(colors.size, 3);
    }
    await page.emulateMedia({ forcedColors: "active" });
    await expect(page.locator('.report-before-prepare [value=masked]')).toBeChecked();
    await expect(page.locator('.report-before-prepare [data-lucide-icon=eye-off]')).toBeVisible();
    assert.equal(requests.filter(request => request.path === "/api/preview").length, 0);
    assert.deepEqual(errors, []);
});

test("changing privacy on the landing resumes frozen facts and keeps edited copies", { timeout: 60000 }, async t => {
    const { page, context, source, requests, errors } = await setup(t);
    const initial = await prepare(page);
    const frame = page.frameLocator(".report-frame");
    await frame.locator(".wire-reading-interaction>summary").first().click();
    await frame.locator(".wire-example-editor summary").first().click();
    await frame.getByLabel("Prompt in this report", { exact: true }).first().fill("Edited wording for Avery Chen.");
    const editedResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await frame.getByRole("button", { name: "Update prompt copy", exact: true }).first().click();
    const edited = await (await editedResponse).json();
    const editedCopy = edited.records.flatMap(record => record.prompts).find(copy => copy.text === "Edited wording for Avery Chen.");
    assert.ok(editedCopy);
    await expect(frame.locator(".wire-reading-interaction").first()).toHaveAttribute("open", "");
    await expect(frame.locator(".wire-example-editor").first()).toHaveAttribute("open", "");
    await expect(frame.getByRole("button", { name: "Update prompt copy", exact: true }).first()).toBeFocused();
    await captureReport(page, "inline-copy-keeps-reading");
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    const preparedCount = requests.filter(request => request.path === "/api/preview").length;
    await page.locator('[name=promptMode][value=none]').check();
    assert.equal(requests.filter(request => request.path === "/api/preview").length, preparedCount);
    const state = await loadBoardState(context), added = fixture("later-private-report");
    added.capturedAt = new Date().toISOString(); added.toolCalls[0].startedAt = added.capturedAt;
    await replaceEvidence(context, () => ({ records: [...source, added], importCoverage: state.importCoverage }));
    const omitted = await prepare(page);
    assert.deepEqual(omitted.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    assert.equal(omitted.promptMode, "none");
    await page.locator("#reportPrivacyChoice").click();
    const unmaskedResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[name=promptMode][value=original]').check();
    const unmasked = await (await unmaskedResponse).json();
    assert.deepEqual(unmasked.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    assert.equal(unmasked.records.flatMap(record => record.prompts).find(copy => copy.key === editedCopy.key).text, editedCopy.text);
    await expect(page.locator("#reportPrivacyChoice")).toHaveClass(/chat-details-kept/);
    await expect(page.locator("#reportPrivacyChoice [data-lucide-icon=triangle-alert]")).toHaveCount(1);
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save with chat details", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(errors, []);
});

test("custom focus selection leaves Reports unprepared; preview and Save preserve the frozen failure cohort", { timeout: 60000 }, async t => {
    const { page, context, source, requests, errors } = await setup(t);
    await expect(page.locator("#reportDeskFocus option")).toHaveCount(6);
    await expect(page.locator(".report-progress")).toBeHidden();
    const address = page.url();
    await selectReportFocus(page, "errors");
    await expect(page.locator("#reportDeskFocus")).toHaveValue("errors");
    await expect(page.locator(".report-outline-description")).toContainText("A completed call can contain an API error");
    await expect(page.locator("#prepareReportPreview")).toHaveAccessibleName("Prepare preview");
    await expect(page.locator(".report-frame")).toBeHidden();
    await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeHidden();
    assert.equal(page.url(), address);
    assert.equal(requests.filter(request => request.path === "/api/preview" || request.path === "/api/export").length, 0);
    const initial = await prepareSelectedFocus(page);
    assert.equal(initial.snapshot.reportPopulation.reference.length, 8);
    assert.equal(initial.records.length, 2);
    assert.equal(initial.promptMode, "masked");
    assert.equal(await page.locator(".report-approval .attestation").count(), 0);
    await expect(page.frameLocator(".report-frame").locator("h1")).toHaveText("Errors & failures");
    const state = await loadBoardState(context), added = fixture("arrived-after-preview");
    added.capturedAt = new Date().toISOString(); added.toolCalls[0].startedAt = added.capturedAt;
    await replaceEvidence(context, () => ({ records: [...source, added], importCoverage: state.importCoverage }));
    const rebuilt = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByLabel("Report name", { exact: true }).fill("Mailbox call failures");
    await expect(page.getByLabel("Report name", { exact: true })).toBeFocused();
    await expect(page.frameLocator(".report-frame").locator("h1")).toHaveText("Mailbox call failures");
    const updated = await (await rebuilt).json();
    assert.deepEqual(updated.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    await expect(page.getByLabel("Report name", { exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Formats: HTML", exact: true }).click();
    let preparedFiles = updated.files;
    for (const format of ["pdf", "json", "markdown"]) {
        const response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value="${format}"]`).check();
        const result = await response, body = await result.json();
        assert.equal(result.status(), 200, body.error);
        assert.deepEqual(body.snapshot.reportPopulation, initial.snapshot.reportPopulation);
        preparedFiles = body.files;
    }
    await page.keyboard.press("Escape");
    const save = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Save report", exact: true }).dblclick();
    assert.equal((await save).status(), 200);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const saved = await loadBoardState(context);
    assert.equal(saved.exports.length, 1);
    assert.equal(saved.exports[0].privacyReview.reviewerConfirmed, false);
    assert.equal(requests.filter(request => request.path === "/api/privacy-review").length, 0);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await selectActivityOption(page, "savedReaderFormat", "html");
    for (const [format, name] of [["html", "product-report.html"], ["pdf", "product-report.pdf"], ["json", "product-report.json"], ["markdown", "product-report.md"]]) {
        if (format !== "html") {
            await page.getByRole("combobox", { name: "Viewing", exact: true }).click();
            await page.locator(`.select-popup [data-value="${format}"]`).click();
        }
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download", exact: true }).click();
        const file = await download, bytes = await readFile(await file.path());
        const expected = typeof preparedFiles[name] === "string" ? Buffer.from(preparedFiles[name]) : Buffer.from(preparedFiles[name].data, "base64");
        assert.deepEqual(bytes, expected);
    }
    assert.deepEqual(errors, []);
});

test("fresh reports ignore Analyze restrictions and custom dates replace only an explicit Current period", { timeout: 60000 }, async t => {
    const source = records();
    const today = time.day(new Date().toISOString(), "America/Los_Angeles");
    const prior = new Date(Date.now() - 10 * 86400000).toISOString();
    source[0].capturedAt = prior; source[0].toolCalls[0].startedAt = prior;
    for (const record of source.slice(0, 3)) {
        record.toolCalls[0].requestArgs = { entityUrls: ["/me/messages"] };
        record.toolCalls[0].requestedApiPath = "/me/messages";
    }
    const route = `#reports?task=create&service=Mail&range=custom&from=${today}&to=${today}`;
    const { page, errors, requests } = await setup(t, { source, route });
    const fresh = await prepare(page, "all");
    assert.equal(fresh.records.length, 7, "Fresh scope includes Calendar despite the old Mail filter");
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
    await page.locator('[name=reportScope][value=current]').check();
    const preparing = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#reportActivityOptions").getByRole("button", { name: "Show report", exact: true }).click();
    const current = await (await preparing).json();
    assert.equal(current.records.length, 2);
    const period = page.locator("#reportPeriodChoices"), custom = period.locator("#reportCustomDates");
    const desk = page.locator("#reportDeskDates"), accepted = await desk.innerText();
    const previews = () => requests.filter(request => request.path === "/api/preview").length;
    const beforeDraft = previews();
    await chooseLandingReportDates(page, "Custom dates");
    for (const days of [7, 14, 30]) await expect(period.getByRole("button", { name: `Last ${days} days`, exact: true })).toBeVisible();
    await custom.getByLabel("From", { exact: true }).fill("2026-01-01");
    await custom.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(desk).toHaveText(accepted);
    assert.equal(previews(), beforeDraft);
    assert.equal(await page.frameLocator(".report-frame").locator("[data-report-scenario]").count(), 2);
    await chooseLandingReportDates(page, "Custom dates");
    await custom.getByLabel("From", { exact: true }).fill("2026-01-01");
    const response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await custom.getByRole("button", { name: "Apply dates", exact: true }).click();
    const widened = await response, body = await widened.json();
    assert.equal(widened.status(), 200, body.error);
    assert.deepEqual(body.snapshot.dateSelection, { range: "custom", from: "2026-01-01", to: today });
    assert.equal(previews(), beforeDraft + 1);
    assert.equal(body.records.length, 3, "Mail is retained and the original older interaction is admitted");
    await expect(page.locator("#reportExperienceScope")).toContainText("Based on Analyze filters");
    assert.equal(new URL(page.url()).searchParams.has("from"), false);
    await expect(page.locator("#dateFilter")).toHaveValue("custom");
    assert.deepEqual(errors, []);
});

test("Reports starts with the configured period and files; changing defaults does not replace a frozen draft", { timeout: 60000 }, async t => {
    const source = records().slice(0, 2);
    for (const [index, record] of source.entries()) {
        record.toolCalls[0].startedAt = record.capturedAt = index ? "2026-11-01T19:00:00Z" : "2026-11-08T19:00:00Z";
    }
    const { page, runtime, context, requests, errors } = await setup(t, {
        source, now: "2026-11-20T19:00:00Z", route: "settings?section=reports",
    });
    await selectActivityOption(page, "defaultReportPeriod", "14");
    await page.locator("#defaultFormat-markdown").check();
    await page.locator("#defaultFormat-json").check();
    await page.locator("#defaultFormat-html").uncheck();
    await navigateMain(page, "reports");
    const range = page.locator("#reportPeriodChoices [aria-pressed=true]");
    await expect(range).toHaveText("Last 14 days");
    await expect(page.locator("#formatOptions input:checked")).toHaveCount(2);
    await expect(page.locator("#formatOptions input[value=markdown]")).toBeChecked();
    await expect(page.locator("#formatOptions input[value=json]")).toBeChecked();
    await expect(page.locator('[name=promptMode][value=masked]')).toBeChecked();
    const effects = () => requests.filter(({ path }) => ["/api/preview", "/api/export"].includes(path));
    assert.deepEqual(effects(), []);
    const settings = await page.context().newPage();
    await settings.goto(runtime.url + "settings?section=reports");
    await expect(settings.locator("#defaultReportPeriod")).toHaveValue("14");
    await expect(settings.locator("#defaultFormat-markdown")).toBeChecked();
    await selectActivityOption(settings, "defaultReportPeriod", "30");
    await settings.locator("#defaultFormat-html").check();
    await settings.locator("#defaultFormat-markdown").uncheck();
    await settings.locator("#defaultFormat-json").uncheck();
    await settings.close();
    const preview = await prepare(page, "all");
    assert.deepEqual(preview.snapshot.dateSelection, { range: "14", from: "2026-11-07", to: "2026-11-20" });
    assert.equal(preview.records.length, 1);
    assert.ok(preview.records[0].prompts.some(copy => copy.text?.includes("REPORT_FIRST_0")));
    assert.deepEqual([...preview.formats].sort(), ["json", "markdown"]);
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await page.getByRole("button", { name: "Resume preview", exact: true }).click();
    await expect(range).toHaveText("Last 14 days");
    await expect(page.getByRole("button", { name: /^Formats: .*Markdown/ })).toBeVisible();
    assert.deepEqual(effects().map(request => request.path), ["/api/preview"]);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const [saved] = (await loadBoardState(context)).exports;
    assert.deepEqual(Object.keys(saved.files).sort(), ["coverage-and-redaction-manifest.json", "product-report.json", "product-report.md"]);
    for (const name of ["product-report.json", "product-report.md"]) assert.equal(await readFile(saved.files[name], "utf8"), preview.files[name]);
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await expect(range).toHaveText("Last 30 days");
    await expect(page.getByRole("button", { name: "Formats: HTML", exact: true })).toBeVisible();
    await page.reload();
    await expect(range).toHaveText("Last 30 days");
    await page.locator("#reportCustomSetup").click();
    await expect(page.getByRole("button", { name: "Formats: HTML", exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
});

test("Formats changes only the draft on landing and resumes the frozen population", { timeout: 60000 }, async t => {
    const { page, context, source, requests, errors } = await setup(t);
    const chooser = page.getByRole("dialog", { name: "Formats", exact: true });
    const effects = () => requests.filter(({ path }) => ["/api/preview", "/api/export"].includes(path));
    await page.clock.install();
    await page.locator("#reportCustomSetup").click();
    await page.getByRole("button", { name: "Formats: HTML", exact: true }).click();
    await expect(chooser.locator("label")).toHaveText(["HTML", "PDF", "Markdown", "JSON"]);
    await expect(chooser.getByRole("button")).toHaveCount(0);
    const html = chooser.getByRole("checkbox", { name: "HTML", exact: true });
    await html.uncheck();
    await expect(chooser.getByRole("alert")).toBeVisible();
    await expect(chooser.getByRole("checkbox", { name: "PDF", exact: true })).not.toBeChecked();
    await chooser.getByRole("checkbox", { name: "JSON", exact: true }).check();
    await page.keyboard.press("Escape");
    await page.clock.runFor(1000);
    assert.deepEqual(effects(), [], "Choosing files on landing must not start a debounced preview or write.");
    const initial = await prepare(page, "all");
    assert.deepEqual(initial.formats, ["json"]);
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await page.getByRole("button", { name: "Formats: JSON", exact: true }).click();
    await chooser.getByRole("checkbox", { name: "Markdown", exact: true }).check();
    await page.keyboard.press("Escape");
    await page.clock.runFor(1000);
    assert.equal(effects().length, 1, "A resumed draft stays unprepared until requested.");
    const state = await loadBoardState(context), added = fixture("after-file-choice");
    added.capturedAt = new Date().toISOString(); added.toolCalls[0].startedAt = added.capturedAt;
    await replaceEvidence(context, () => ({ records: [...source, added], importCoverage: state.importCoverage }));
    const rebuilding = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByRole("button", { name: "Resume preview", exact: true }).click();
    const result = await rebuilding, resumed = await result.json();
    assert.equal(result.status(), 200, resumed.error);
    assert.deepEqual(resumed.formats, ["json", "markdown"]);
    assert.equal(effects().at(-1).body.rebuildFrom, initial.previewId);
    assert.deepEqual(resumed.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    await selectActivityOption(page, "preparedReportView", "product-report.md");
    await expect(page.locator("#reportFileInspection .saved-markdown")).toBeVisible();
    await page.getByRole("button", { name: "Formats: Markdown, JSON", exact: true }).click();
    await expect(html).not.toBeChecked();
    await expect(chooser.getByRole("checkbox", { name: "JSON", exact: true })).toBeChecked();
    assert.equal(effects().length, 2, "Viewing a prepared file must neither change the output inventory nor prepare or save it.");
    const removing = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await chooser.getByRole("checkbox", { name: "Markdown", exact: true }).uncheck();
    const remaining = await (await removing).json();
    await page.keyboard.press("Escape");
    assert.deepEqual(remaining.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    await expect(page.locator("#preparedReportView")).toHaveValue("report");
    await expect(page.locator('#preparedReportView option[value="product-report.md"]')).toHaveCount(0);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(errors, []);
});

test("JSON-only saved reports open as readable reports independently of their files", { timeout: 30000 }, async t => {
    const { page, context, requests, errors } = await setup(t);
    const downloads = [];
    page.on("download", download => downloads.push(download));
    await prepare(page);
    await page.getByRole("button", { name: "Formats: HTML", exact: true }).click();
    for (const [format, selected] of [["json", true], ["html", false]]) {
        const ready = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value="${format}"]`).setChecked(selected); await ready;
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const before = await loadBoardState(context), saved = before.exports[0];
    assert.deepEqual(saved.formats, ["json"]);
    await expect(page.getByRole("button", { name: /^Formats:/ })).toBeHidden();
    const bytes = await readFile(saved.files["product-report.json"]);
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await page.getByRole("button", { name: "View report: Errors & failures", exact: true }).click();
    const reader = page.locator("#savedReportReader");
    await expect(reader.getByRole("combobox", { name: "Viewing", exact: true })).toBeVisible();
    await expect(reader.locator(".saved-brief")).toContainText("2 of 8 interactions had recorded errors.");
    assert.deepEqual(await reader.locator("#savedReaderFormat option").evaluateAll(options => options.map(o => [o.value, o.label])), [
        ["report", "Brief"], ["document", "Full report"], ["json", "Structured data (JSON)"], ["manifest", "File list (manifest)"],
    ], "The reader lists this bundle’s files, not all the formats a new report could save.");
    await selectActivityOption(page, "savedReaderFormat", "document");
    await expect(reader.frameLocator("iframe").locator("h1")).toHaveText("Errors & failures");
    await expect(reader.frameLocator("iframe").locator("body")).toContainText("2 of 8 interactions had recorded errors.");
    await expect(reader.locator(".saved-json-tree")).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "Download", exact: true })).toBeHidden();
    const reads = requests.filter(request => request.path === "/api/preview").length;
    await selectActivityOption(page, "savedReaderFormat", "json");
    await expect(reader.locator(".saved-json-tree")).toBeVisible();
    await expect(reader.getByRole("button", { name: "Download", exact: true })).toBeVisible();
    await selectActivityOption(page, "savedReaderFormat", "report");
    await expect(reader.locator(".saved-brief")).toContainText("2 of 8 interactions had recorded errors.");
    assert.equal(requests.filter(request => request.path === "/api/preview").length, reads, "Saved reading never prepares current activity.");
    assert.deepEqual(downloads, []);
    assert.deepEqual(await readFile(saved.files["product-report.json"]), bytes);
    assert.deepEqual(await loadBoardState(context), before);
    await selectActivityOption(page, "savedReaderFormat", "json");
    const pending = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/report/open", async route => {
        const response = await route.fetch(); pending.resolve();
        await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    const late = page.waitForResponse(response => response.url().endsWith("/api/report/open"));
    await selectActivityOption(page, "savedReaderFormat", "report"); await pending.promise;
    await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    release.resolve(); await (await late).finished();
    await expect(reader).toBeHidden();
    await expect(reader).toBeEmpty();
    assert.deepEqual(errors, []);
});

test("withdrawal clears a hidden cached report while an original file is being viewed", { timeout: 30000 }, async t => {
    const { page, runtime, errors } = await setup(t, { enforced: true });
    await prepare(page);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.locator("#savedReportReader .saved-brief")).toBeVisible();
    await page.evaluate(() => { window.heldBrief = document.querySelector("#savedReportReader .saved-brief"); });
    await selectActivityOption(page, "savedReaderFormat", "html");
    assert.equal(await page.evaluate(() => heldBrief.isConnected && !heldBrief.checkVisibility()), true);
    const controller = await page.context().newPage();
    await controller.goto(runtime.url);
    await expect(controller.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await controller.locator("#wireAccountTrigger").click();
    await controller.locator("#wireAccountGate").click();
    await expect(page.locator("#workspace")).toBeHidden();
    assert.deepEqual(await page.evaluate(() => [heldBrief.isConnected, heldBrief.textContent]), [false, ""]);
    assert.deepEqual(errors, []);
});

test("the desk distinguishes an owner-matched pre-publication refusal from a lost Save response", async t => {
    const { page, context, requests } = await setup(t, { enforced: true, frontend: "react" });
    const preview = await prepare(page);
    // Exercise the refusal delivered by the native pre-writer gate without damaging a source.
    await page.route("**/api/export", route => route.fulfill({ status: 409, json: {
        error: "The original source is unavailable.", code: "NATIVE_REPORT_SOURCE_STALE",
        reportSave: { outcome: "not-published", kind: "report", previewId: preview.previewId, bundleId: preview.bundleId },
    } }), { times: 1 });
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportJourneyError")).toContainText("No report was saved.");
    await expect(page.getByRole("button", { name: "Check save status", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await expect(page.locator("#reportGallery")).toBeVisible();
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    assert.equal((await loadBoardState(context)).exports.length, 0);
});

for (const paired of [false, true]) test(`a lost ${paired ? "paired " : ""}direct-Save response recovers the original exact-content receipt without a second write`, { timeout: 60000 }, async t => {
    const { page, context, requests, errors } = await setup(t, paired ? { source: periodFixture().records,
        route: "#analyze?compare=periods&aFrom=2026-03-07&aTo=2026-03-07&bFrom=2026-03-08&bTo=2026-03-09" } : {});
    let preview;
    if (paired) {
        await expect(page.locator("#createPeriodReport")).toBeEnabled();
        const prepared = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator("#createPeriodReport").click();
        preview = await (await prepared).json();
        assert.ok(preview.snapshot.periodComparison);
    } else preview = await prepare(page);
    await page.route("**/api/export", async route => { await route.fetch(); await route.abort("connectionreset"); }, { times: 1 });
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.getByRole("button", { name: "Check save status", exact: true })).toBeVisible();
    const recovery = page.getByRole("button", { name: "Check save status", exact: true });
    await expect(recovery).toBeInViewport();
    const dates = page.locator("#reportDeskDates");
    if (paired) await expect(dates).toBeHidden();
    else await expect(dates).toBeDisabled();
    await expect(page.locator("#reportPeriodChoices")).toBeHidden();
    const gap = await recovery.evaluate(node => node.getBoundingClientRect().top
        - document.querySelector("#reportJourneyError").getBoundingClientRect().bottom);
    assert.ok(gap >= 0 && gap <= 32, `Recovery must accompany its warning, not follow the document: ${gap}px`);
    if (!paired) await captureReport(page, "save-recovery-with-warning");
    const back = page.getByRole("link", { name: paired ? "Back to comparison" : "Back to Reports", exact: true });
    await expect(back).toBeDisabled();
    await back.press("Enter");
    await expect(page.locator("#reportGallery")).toBeHidden();
    await expect(page.getByRole("button", { name: "Check save status", exact: true })).toBeVisible();
    assert.equal((await loadBoardState(context)).exports.length, 1);
    await page.getByRole("button", { name: "Check save status", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const saved = (await loadBoardState(context)).exports[0];
    assert.equal(saved.bundleId, preview.bundleId);
    assert.equal(saved.privacyReview.localSave.contentHash, preview.localSaveRequest.contentHash);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    assert.deepEqual(errors, []);
});

test("prepared Reports leaves useful first-screen reading space at narrow and enlarged sizes", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await prepare(page);
    for (const [theme, width, height, size] of [["light", 390, 844, 100], ["dark", 390, 844, 100],
        ["light", 1024, 1000, 200], ["dark", 1024, 1000, 200], ["light", 1440, 1000, 100]]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height });
        await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; scrollTo(0, 0); }, size);
        await captureReport(page, `prepared-${theme}-${width}-${size}`);
        const top = await page.locator(".report-contained-frame").evaluate(node => node.getBoundingClientRect().top);
        if (process.env.WIRE_REPORT_FIRST_PROOFS) await writeFile(path.join(process.env.WIRE_REPORT_FIRST_PROOFS,
            `prepared-${theme}-${width}-${size}.json`), JSON.stringify({ theme, width, height, size, documentTop: top }, null, 2));
        assert.ok(top <= height * .7, `Report begins at ${top}px of ${height}px`);
        await expect(page.locator("#reportPrivacyChoice")).toBeVisible();
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeVisible();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    }
});

test("new actual HTML keeps exact tool names intact in a keyboard-scrollable narrow table", { timeout: 30000 }, async t => {
    const all = reviewRecords(), { page } = await setup(t, { source: [all[0], all[1], all.at(-1)], frontend: "react",
        now: "2026-11-18T16:00:00Z" });
    await chooseLandingReportDates(page, "Last 14 days");
    await prepare(page, "all");
    await page.setViewportSize({ width: 390, height: 844 });
    await selectActivityOption(page, "preparedReportView", "product-report.html");
    const frame = page.frameLocator("#reportFileInspection iframe");
    const table = frame.locator(".example-calls").first(), region = table.locator("..");
    await table.scrollIntoViewIfNeeded();
    const lines = await table.locator("tbody tr").first().locator("td").nth(1).evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        return [...new Set([...range.getClientRects()].map(rect => rect.top))].length;
    });
    assert.equal(lines, 1, "An exact tool identity must not be fragmented merely to avoid document overflow.");
    await expect(region).toHaveAttribute("tabindex", "0");
    await region.focus();
    await region.press("ArrowRight");
    await expect.poll(() => region.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    await expect(table.locator("td").nth(1)).toHaveText("workiq-retrieve");
    assert.equal(await frame.locator("html").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    if (process.env.WIRE_REPORT_FIRST_PROOFS) await page.screenshot({
        path: path.join(process.env.WIRE_REPORT_FIRST_PROOFS, "new-html-narrow-exact-tool.png"),
    });
});

test("new library metadata reflects ordinary reports saved locally", { timeout: 60000 }, async t => {
    const { page, context, requests, errors } = await setup(t);
    for (const preset of ["errors", "all"]) {
        await prepare(page, preset);
        if (preset === "all") {
            const patterns = page.frameLocator(".report-contained-frame").locator("#patterns");
            await expect(patterns.locator("h2")).toHaveCount(2);
            await expect(patterns.locator("h2").first()).toBeVisible();
        }
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    }
    await expect(page.locator(".saved-report-title")).toHaveCount(2);
    await expect(page.locator("#reportDeskFocus option")).toHaveCount(6);
    await viewAllSavedReports(page);
    await expect(page.locator(".saved-report-privacy").first()).toContainText("Detected personal details hidden");
    await expect(page.locator(".saved-report-period").first()).not.toHaveText("Not recorded");
    await expect(page.getByRole("link", { name: "Compare saved reports" })).toHaveCount(0);
});

for (const resumePrepared of [false, true]) test(`fresh Reports entry after comparison returns to Reports (${resumePrepared ? "prepared return" : "direct Save"})`, { timeout: 30000 }, async t => {
    const { page, context, errors } = await setup(t, { route: "#analyze" });
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await page.getByRole("button", { name: "Timeline", exact: true }).click();
    await page.getByRole("button", { name: "By tool", exact: true }).click();
    const comparison = new URL(page.url()).searchParams;
    await page.locator('nav [data-nav="reports"]').click();
    await expect(page.locator("#reportGallery")).toBeVisible();
    const dates = page.locator("#reportDeskDates"), period = await dates.innerText();
    await dates.click();
    const selectedPreset = page.locator("#reportPeriodChoices [data-report-range][aria-pressed=true]");
    const acceptedPreset = await selectedPreset.innerText();
    await page.keyboard.press("Escape");
    const prepared = await prepare(page);
    assert.equal(prepared.snapshot.periodComparison, undefined);
    await expect(page.locator("#reportLibraryLink")).toHaveText("Back to Reports");
    if (resumePrepared) {
        await page.locator("#reportLibraryLink").click();
        await expect(page.locator("#reportGallery")).toBeVisible();
        await expect(dates).toHaveText(period);
        await prepareLandingReport(page, "errors");
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    assert.equal((await loadBoardState(context)).exports[0].bundleId, prepared.bundleId);
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.locator(".saved-reader-heading .document-back")).toHaveText("Back to Reports");
    await page.locator(".saved-reader-heading .document-back").click();
    await expect(page.locator("#reportGallery")).toBeVisible();
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    await expect(dates).toHaveText(period);
    await expect(page.locator('nav [data-nav="reports"]')).toHaveAttribute("aria-current", "page");
    await dates.click();
    await expect(selectedPreset).toHaveText(acceptedPreset);
    await page.keyboard.press("Escape");
    const address = new URL(page.url());
    assert.equal(address.pathname, "/reports");
    for (const key of ["compare", "comparisonView", "comparisonFocus", "aFrom", "aTo", "bFrom", "bTo", "task", "bundle"]) {
        assert.equal(address.searchParams.has(key), false, key);
    }
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(page.getByRole("button", { name: "By tool", exact: true })).toHaveAttribute("aria-pressed", "true");
    const restored = new URL(page.url()).searchParams;
    for (const key of ["aFrom", "aTo", "bFrom", "bTo", "comparisonView"]) assert.equal(restored.get(key), comparison.get(key), key);
    assert.deepEqual(errors, []);
});

test("retained-period comparison opens its report directly and saves the accepted pair", { timeout: 60000 }, async t => {
    const { page, context, errors } = await setup(t, { source: periodFixture().records, route: "#analyze" });
    await page.locator("#comparePeriods").click();
    await openDatePicker(page, "compare", "Custom dates");
    for (const [label, value] of [["Period A from", "2026-03-07"], ["Period A to", "2026-03-07"],
        ["Period B from", "2026-03-08"], ["Period B to", "2026-03-09"]]) {
        await page.getByLabel(label, { exact: true }).fill(value);
    }
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    await page.getByRole("button", { name: "Timing", exact: true }).click();
    const origin = page.url();
    const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#createPeriodReport").click();
    const response = await pending;
    let prepared = await response.json();
    assert.equal(response.status(), 200, prepared.error);
    assert.ok(prepared.snapshot.periodComparison);
    assert.equal(prepared.localSaveRequest.version, 1);
    await expect(page.locator("#reportStage3")).toBeVisible();
    await expect(page.locator("#reportDeskDates")).toBeHidden();
    await expect(page.locator("#reportLibraryLink")).toHaveText("Back to comparison");
    const acceptedComparison = prepared.snapshot.periodComparison.comparison;
    await page.locator("#reportLibraryLink").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    assert.equal(page.url(), origin);
    await expect(page.getByRole("button", { name: "Timing", exact: true })).toHaveAttribute("aria-pressed", "true");
    const repeated = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#createPeriodReport").click();
    const repeatedResponse = await repeated;
    prepared = await repeatedResponse.json();
    assert.equal(repeatedResponse.status(), 200, prepared.error);
    assert.deepEqual(prepared.snapshot.periodComparison.comparison, acceptedComparison);
    await expect(page.locator("#reportLibraryLink")).toHaveText("Back to comparison");
    let preparedFiles = prepared.files;
    await page.getByRole("button", { name: "Formats: HTML", exact: true }).click();
    for (const format of ["pdf", "json", "markdown"]) {
        const next = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value="${format}"]`).check();
        const rebuilt = await (await next).json();
        const stablePair = value => {
            const copy = structuredClone(value);
            for (const side of Object.values(copy.periods)) {
                assert.ok(Number.isFinite(Date.parse(side.facts.preparedAt)));
                assert.match(side.facts.snapshotRef, /^snapshot-[a-f0-9]+$/);
                delete side.facts.preparedAt; delete side.facts.snapshotRef;
            }
            return copy;
        };
        assert.deepEqual(stablePair(rebuilt.snapshot.periodComparison), stablePair(prepared.snapshot.periodComparison));
        preparedFiles = rebuilt.files;
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    assert.equal((await loadBoardState(context)).exports[0].reportType, "period-comparison");
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.locator(".saved-reader-heading .document-back")).toHaveText("Back to comparison");
    await selectActivityOption(page, "savedReaderFormat", "html");
    for (const [format, name] of [["html", "product-report.html"], ["pdf", "product-report.pdf"], ["json", "product-report.json"], ["markdown", "product-report.md"]]) {
        if (format !== "html") {
            await page.getByRole("combobox", { name: "Viewing", exact: true }).click();
            await page.locator(`.select-popup [data-value="${format}"]`).click();
        }
        const downloaded = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download", exact: true }).click();
        const bytes = await readFile(await (await downloaded).path());
        const expected = typeof preparedFiles[name] === "string" ? Buffer.from(preparedFiles[name]) : Buffer.from(preparedFiles[name].data, "base64");
        assert.deepEqual(bytes, expected);
    }
    await page.locator(".saved-reader-heading .document-back").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    assert.equal(page.url(), origin);
    await expect(page.getByRole("button", { name: "Timing", exact: true })).toHaveAttribute("aria-pressed", "true");
    assert.deepEqual(errors, []);
});

test("access withdrawal erases held example editors and never resumes their old save intent", { timeout: 30000 }, async t => {
    const { page, runtime, context, requests, errors } = await setup(t, { enforced: true });
    await prepare(page);
    const frame = page.frameLocator(".report-frame");
    await frame.locator(".wire-reading-interaction>summary").first().click();
    await frame.locator(".wire-example-editor summary").first().click();
    const note = frame.getByLabel("Your note", { exact: true }).first();
    await note.fill("PRIVATE_UNSAVED_NOTE");
    await page.evaluate(() => {
        const source = document.querySelector(".report-frame").contentDocument;
        window.heldReportNote = source.querySelector(".wire-example-editor textarea");
        window.heldReportTitle = source.querySelector("h1").firstChild;
    });
    await selectActivityOption(page, "preparedReportView", "text");
    const heldCopies = await page.evaluate(() => {
        const root = document.querySelector(".prompt-comparison");
        window.heldOrdinaryCopyText = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) heldOrdinaryCopyText.push(walker.currentNode);
        window.heldOrdinaryCopyKey = root.getAttributeNode("data-copy-key");
        return heldOrdinaryCopyText.filter(text => text.data.includes("REPORT_FIRST_")).length;
    });
    assert.equal(heldCopies, 2, "Both hidden original and masked report-copy nodes are held.");
    const controller = await page.context().newPage();
    await controller.goto(runtime.url);
    await expect(controller.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await controller.locator("#wireAccountTrigger").click();
    await controller.locator("#wireAccountGate").click();
    await expect(page.locator("#workspace")).toBeHidden();
    assert.equal(await page.evaluate(() => window.heldReportNote.value), "");
    assert.equal(await page.evaluate(() => window.heldReportTitle.data), "");
    assert.equal(await page.evaluate(() => heldOrdinaryCopyText.some(text => text.data.includes("REPORT_FIRST_"))), false);
    assert.equal(await page.evaluate(() => heldOrdinaryCopyKey.value), "");
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 0);
    assert.deepEqual(errors, []);
});

test("changing report scope retires prior ordinary copies and their detached edit callbacks", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, { source: reviewRecords().slice(0, 4), frontend: "react",
        now: "2026-11-18T16:00:00Z" });
    await chooseLandingReportDates(page, "Last 14 days");
    await prepare(page, "all");
    await selectActivityOption(page, "preparedReportView", "text");
    await page.getByText("Edit or omit this report copy", { exact: true }).click();
    await page.evaluate(() => {
        const copy = document.querySelector(".prompt-comparison");
        window.retiredScopeTexts = [];
        const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) retiredScopeTexts.push(walker.currentNode);
        window.retiredScopeKey = copy.getAttributeNode("data-copy-key");
        window.retiredScopeField = copy.querySelector("textarea");
        window.retiredScopeApply = copy.querySelector(".report-copy-controls button");
    });
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    const prepared = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await selectActivityOption(page, "reportPromptAuthorFilter", "user");
    assert.equal((await (await prepared).json()).records.length, 3);
    assert.deepEqual(await page.evaluate(() => ({
        privateText: retiredScopeTexts.some(text => /Cedar launch review/.test(text.data)),
        key: retiredScopeKey.value, field: retiredScopeField.value,
    })), { privateText: false, key: "", field: "" });
    const count = requests.filter(request => request.path === "/api/preview").length;
    await page.evaluate(() => retiredScopeApply.click());
    await page.waitForTimeout(450);
    assert.equal(requests.filter(request => request.path === "/api/preview").length, count);
});

test("keep-details warning can cancel or regenerate masked notes and copies before one Save", { timeout: 60000 }, async t => {
    const { page, context, requests, errors } = await setup(t);
    await prepare(page);
    const frame = page.frameLocator(".report-frame");
    await frame.locator(".wire-reading-interaction>summary").first().click();
    await frame.locator(".wire-example-editor summary").first().click();
    await frame.getByLabel("Your note", { exact: true }).first().fill("Expected a result for note@example.invalid.");
    let response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await frame.getByRole("button", { name: "Update note", exact: true }).first().click();
    assert.equal((await response).status(), 200);
    await page.locator("#reportPrivacyChoice").click();
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[name=promptMode][value=original]').check();
    assert.equal((await response).status(), 200);
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.getByRole("button", { name: "Go back", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    const saved = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Mask detected details and save", exact: true }).click();
    const result = await saved;
    assert.equal(result.status(), 200, JSON.stringify(await result.json()));
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const state = await loadBoardState(context);
    assert.equal(state.exports.length, 1);
    assert.equal(state.exports[0].promptMode, "masked");
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    assert.equal(requests.filter(request => request.path === "/api/privacy-review").length, 0);
    assert.deepEqual(errors, []);
});

test("returning to the gallery during preparation retires that result and leaves report choices usable", { timeout: 30000 }, async t => {
    const { page, context, errors } = await setup(t);
    const held = Promise.withResolvers();
    await page.route("**/api/preview", async route => { const response = await route.fetch(); await held.promise; await route.fulfill({ response }); }, { times: 1 });
    await prepareLandingReport(page, "errors");
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "scanning");
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    held.resolve();
    await expect(page.locator("#reportDeskFocus")).toBeEnabled();
    await expect(page.locator("#reportStage1")).toBeVisible();
    await prepare(page);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(errors, []);
});

test("one Reports entry retains an edited frozen draft across Back, explicit resume and browser history", { timeout: 30000 }, async t => {
    const { page, context, source, requests, errors } = await setup(t, { route: "#reports?task=create" });
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    await expect(page.locator("#pageAction")).toBeHidden();
    await expect(page.locator("#reportCreateLink")).toBeHidden();
    const initial = await prepare(page);
    await expect(page.locator("#reportPreviewDrawer")).toHaveJSProperty("open", true);
    const renamed = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByLabel("Report name", { exact: true }).fill("Unfinished mailbox report"); await renamed;
    const frame = page.frameLocator(".report-frame");
    await frame.locator(".wire-reading-interaction>summary").first().click();
    await frame.locator(".wire-example-editor summary").first().click();
    await frame.getByLabel("Your note", { exact: true }).first().fill("Check this permission boundary.");
    const noted = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await frame.getByRole("button", { name: "Update note", exact: true }).first().click();
    const edited = await (await noted).json();
    assert.deepEqual(edited.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    const requestCount = requests.filter(request => request.path === "/api/preview").length;
    const state = await loadBoardState(context), added = fixture("later-not-in-resumed-copy");
    added.capturedAt = new Date().toISOString(); added.toolCalls[0].startedAt = added.capturedAt;
    await replaceEvidence(context, () => ({ records: [...source, added], importCoverage: state.importCoverage }));
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await expect(page.locator("#reportGallery")).toBeVisible();
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    await expect(page.locator("#prepareReportPreview")).toBeFocused();
    await expect(page.locator("#prepareReportPreview")).toHaveAccessibleName("Resume preview");
    await expect(page.locator("#reportDeskFocus")).toHaveValue("errors");
    const sections = page.getByRole("navigation", { name: "Report sections", exact: true });
    await sections.getByRole("link", { name: "Saved library" }).click();
    await expect(sections.getByRole("link", { name: "Saved library" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#reportCreatePanel")).toBeHidden();
    await sections.getByRole("link", { name: "Overview" }).click();
    await expect(page.locator("#prepareReportPreview")).toHaveAccessibleName("Resume preview");
    await prepareReportPreview(page);
    await expect(page.getByLabel("Report name", { exact: true })).toHaveValue("Unfinished mailbox report");
    await expect(page.frameLocator(".report-frame").locator("body")).toContainText("Check this permission boundary.");
    assert.equal(requests.filter(request => request.path === "/api/preview").length, requestCount);
    await page.goBack();
    await expect(page.locator("#reportGallery")).toBeVisible();
    await page.goForward();
    await expect(page.getByLabel("Report name", { exact: true })).toHaveValue("Unfinished mailbox report");
    assert.equal(requests.filter(request => request.path === "/api/preview").length, requestCount);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(errors, []);
});

test("saved names, Files and row actions preserve exact files, paging, search, focus and deletion confirmation", { timeout: 60000 }, async t => {
    const { page, context, errors } = await setup(t);
    let expectedFile;
    for (let index = 1; index <= 8; index++) {
        await prepare(page);
        const renamed = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.getByLabel("Report name", { exact: true }).fill("Return report " + index);
        const prepared = await (await renamed).json();
        if (index === 7) expectedFile = Buffer.from(prepared.files["product-report.html"]);
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    }
    await viewAllSavedReports(page);
    await page.locator("#savedReportSearch").fill("Return report");
    await page.locator("#savedReportOrder-control").click();
    await page.locator('.select-popup [data-value="oldest"]').click();
    assert.equal(await page.locator("#bundleList .list-pager").evaluate(node =>
        Boolean(node.previousElementSibling?.classList.contains("saved-report-table"))), true,
    "Saved-report paging follows the rows in both reading and keyboard order.");
    await page.getByRole("button", { name: "Next saved reports", exact: true }).click();
    await expect(page.locator(".saved-report-title")).toHaveCount(2);
    const title = page.locator(".saved-report-title").first();
    await expect(title.locator(".saved-report-name")).toHaveText("Return report 7");
    await title.focus();
    const y = await page.evaluate(() => scrollY);
    await title.click();
    await expect(page.locator("#savedReportReader")).toBeVisible();
    await page.getByRole("button", { name: "Back to saved reports", exact: true }).click();
    await expect(page.locator("#savedReportSearch")).toHaveValue("Return report");
    await expect(page.locator("#savedReportOrder")).toHaveValue("oldest");
    await expect(page.locator(".saved-report-title")).toHaveCount(2);
    await expect(page.locator(".saved-report-title").first()).toBeFocused();
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - y) < 3);
    const row = page.locator(".saved-library-row").first();
    await row.locator(".saved-report-files").click();
    await expect(row.getByRole("dialog", { name: "Files for Return report 7", exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Web page (HTML)", exact: true }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const file = await download, saved = (await loadBoardState(context)).exports.find(entry => entry.title === "Return report 7");
    assert.ok(saved);
    const bytes = await readFile(await file.path());
    assert.deepEqual(bytes, expectedFile);
    await page.getByRole("button", { name: "Back to saved reports", exact: true }).click();
    await expect(row.locator(".saved-report-files")).toBeFocused();
    await row.getByRole("button", { name: "Inspect details", exact: true }).click();
    await expect(page.locator("#contextSidebar")).toBeVisible();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await row.getByRole("button", { name: "Delete report", exact: true }).click();
    const deletion = page.locator('[aria-labelledby="savedArtifactDeleteTitle"]');
    await expect(deletion).toBeVisible();
    await expect(deletion).toHaveAttribute("aria-busy", "false");
    assert.equal((await loadBoardState(context)).exports.length, 8, "Opening deletion confirmation writes nothing");
    await page.keyboard.press("Escape");
    await page.locator("#savedLibraryOptions").click();
    await expect(page.getByRole("button", { name: "Delete all saved reports", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#savedLibraryManagement")).toBeHidden();
    // Reload a public library address, not a private Search selection from the previous page.
    await page.locator("#clearSavedReportSearch").click();
    await expect(page.locator("#savedReportSearch")).toHaveValue("");
    let legacyId;
    await updateBoardState(context, state => {
        const entry = state.exports.find(entry => entry.title === "Return report 8");
        legacyId = entry.bundleId;
        delete entry.promptMode; delete entry.reportPeriod;
    });
    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#savedReportSearch").fill(legacyId);
    await expect(page.locator(".saved-report-privacy")).toHaveCount(1);
    await expect(page.locator(".saved-report-privacy")).toContainText("Text treatment not recorded");
    await expect(page.locator(".saved-report-period")).toHaveCount(0);
    await expect(page.locator(".saved-period-availability")).toHaveText("The activity period isn't listed for one saved entry.");
    assert.deepEqual(errors, []);
});

test("one-chat and explicit Selected entry keep their complete scope and contextual return", { timeout: 30000 }, async t => {
    const source = records();
    source.forEach((record, index) => {
        record.sourceSessionId = index < 3 ? "first-chat" : "second-chat";
        record.sourceSessionName = index < 3 ? "First chat" : "Second chat";
    });
    source[0].toolCalls[0].startedAt = source[0].capturedAt = "2001-01-01T12:00:00Z";
    const { page, runtime, requests, errors } = await setup(t, { source, route: "settings?section=reports" });
    await selectActivityOption(page, "defaultReportPeriod", "30");
    await page.locator("#defaultFormat-json").check();
    await page.locator("#defaultFormat-html").uncheck();
    await page.goto(runtime.url + "#analyze?session=first-chat");
    await page.locator("#createSessionReport").click();
    const chat = await prepare(page, "all");
    assert.equal(chat.records.length, 3);
    assert.equal(chat.snapshot.dateSelection.range, "capture");
    assert.deepEqual(chat.formats, ["html"]);
    await page.getByRole("link", { name: "Back to Analyze", exact: true }).click();
    await expect(page.locator("#chatFilter")).toHaveValue("first-chat");
    await page.locator('[data-nav="reports"]').click();
    const previewCount = requests.filter(request => request.path === "/api/preview").length;
    await selectReportFocus(page, "all");
    await page.locator("#reportDeskActivity").click();
    await page.locator('[name=reportScope][value=selected]').check();
    const picks = page.locator("#reportActivityOptions input[data-report-request]");
    await expect(picks.first()).toBeVisible();
    await picks.first().uncheck();
    await page.locator("#reportActivityOptions").getByRole("button", { name: "Use activity", exact: true }).click();
    await expect(page.locator("#reportDeskActivity")).toBeFocused();
    await expect(page.locator("#reportDeskActivity")).toContainText("Selected interactions");
    assert.equal(requests.filter(request => request.path === "/api/preview").length, previewCount);
    const selected = await prepareSelectedFocus(page);
    assert.equal(selected.records.length, 2);
    assert.ok(selected.records.every(record => chat.records.some(original => original.scenarioId === record.scenarioId)));
    assert.deepEqual(errors, []);
});

test("withdrawal scrubs retained saved-row titles and menu labels and blocks their old actions", { timeout: 30000 }, async t => {
    const { page, runtime, context, requests, errors } = await setup(t, { enforced: true });
    await prepare(page);
    const renamed = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByLabel("Report name", { exact: true }).fill("PRIVATE_SAVED_TITLE"); await renamed;
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await viewAllSavedReports(page);
    await page.locator(".saved-report-files").click();
    await page.evaluate(() => {
        window.heldSavedTitle = document.querySelector(".saved-report-name").firstChild;
        window.heldSavedLabel = document.querySelector(".saved-report-files").getAttributeNode("aria-label");
        window.heldSavedMenuLabel = document.querySelector(".saved-library-row .saved-report-menu").getAttributeNode("aria-label");
        window.heldSavedAction = document.querySelector(".saved-report-menu button");
    });
    const controller = await page.context().newPage();
    await controller.goto(runtime.url);
    await expect(controller.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await controller.locator("#wireAccountTrigger").click();
    await controller.locator("#wireAccountGate").click();
    await expect(page.locator("#workspace")).toBeHidden();
    assert.deepEqual(await page.evaluate(() => [heldSavedTitle.data, heldSavedLabel.value, heldSavedMenuLabel.value]), ["", "", ""]);
    const before = requests.filter(request => /report-artifacts|\/api\/export/.test(request.path)).length;
    await page.evaluate(() => heldSavedAction.click());
    assert.equal(requests.filter(request => /report-artifacts|\/api\/export/.test(request.path)).length, before);
    assert.equal((await loadBoardState(context)).exports.length, 1);
    assert.deepEqual(errors, []);
});

test("Custom report keeps aligned controls and explanations at compact and wide sizes", { timeout: 60000 }, async t => {
    const { page, requests, errors } = await setup(t);
    const proofs = process.env.WIRE_REPORT_FIRST_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    async function capture(name) {
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, name);
        if (proofs) await page.screenshot({ path: path.join(proofs, name + ".png") });
    }
    const focuses = [
        ["all", "All activity", null],
        ["errors", "Errors & failures", /completed call can contain an API error/i],
        ["completed", "Completed calls", /answer can still be wrong/i],
        ["mine", "Human prompts", /including any calls made by an agent/i],
        ["agent", "Agent prompts", /unknown authors are excluded/i],
    ];
    const compact = page.getByRole("combobox", { name: "Show", exact: true });
    const outline = page.locator(".report-desk");
    await page.locator("#reportCustomSetup").click();
    for (const [theme, width, size] of [["light", 1440, 100], ["dark", 375, 200]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; }, size);
        const narrow = width === 375;
        await expect(compact).toBeVisible();
        if (narrow) {
            const arrow = compact.locator('[data-icon-role="chevron"]');
            await expect(arrow).toHaveCount(1);
            await expect(arrow).toHaveCSS("pointer-events", "none");
            const [field, ink] = await Promise.all([compact.boundingBox(), arrow.boundingBox()]);
            const inset = await compact.evaluate(node => parseFloat(getComputedStyle(node).paddingInlineStart));
            assert.equal(field.x + field.width - ink.x - ink.width, inset);
            assert.equal(field.y + field.height / 2, ink.y + ink.height / 2);
            await compact.focus(); await compact.press("Enter"); await compact.press("Home"); await compact.press("ArrowDown"); await compact.press("Enter");
            await expect(compact).toHaveText("Errors & failures");
        }
        for (const [preset, title, explanation] of focuses) {
            await selectReportFocus(page,preset);
            await expect(compact).toHaveText(title);
            if (explanation) await expect(outline.locator(".report-outline-description")).toHaveText(explanation);
            else await expect(outline.locator(".report-outline-description")).toBeHidden();
        }
        const faces = await outline.locator("#reportDeskFocus-control,#reportDeskDates,#reportUsagequestion-control").evaluateAll(nodes => nodes.map(n => {
            const b = n.getBoundingClientRect(), p = getComputedStyle(n, "::before");
            return { face: b.height - parseFloat(p.top) - parseFloat(p.bottom), target: b.height, top: b.top };
        }));
        assert.ok(faces.every(f => f.target >= 44));
        if (!narrow) {
            assert.ok(faces.every(f => f.face === faces[0].face));
            assert.ok(faces.every(f => f.top === faces[0].top));
        }
        const selectorBox = await compact.boundingBox(), description = await outline.locator(".report-outline-description").boundingBox();
        assert.ok(description.y >= selectorBox.y + selectorBox.height - 1);
        await expect(outline.getByRole("button", { name: "Prepare preview", exact: true })).toBeEnabled();
        await capture(`gallery-${theme}-${width}-${size}`);
    }
    assert.equal(requests.filter(request => request.path === "/api/preview").length, 0);
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await chooseLandingReportDates(page, "Custom dates");
    await expect(page.locator("#reportCustomDates")).toBeVisible();
    await capture("calendar-dark-1280");
    await page.keyboard.press("Escape");
    await prepare(page);
    for (const [theme, width, size] of [["dark", 1280, 100], ["light", 1280, 100], ["dark", 375, 200]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; scrollTo(0, 0); }, size);
        const name = page.getByLabel("Report name", { exact: true });
        await name.focus();
        await expect(name).toHaveAccessibleName("Report name");
        await page.waitForFunction(() => !document.querySelector("#reportPreviewDrawer").getAnimations().length);
        const [field, save] = await Promise.all([name.boundingBox(), page.getByRole("button", { name: "Save report", exact: true }).boundingBox()]);
        assert.ok(save.x >= field.x + field.width + 4 || save.y >= field.y + field.height + 4,
            `Name and Save must remain separate (${width}/${size}): ${JSON.stringify({field,save})}`);
        await capture(`report-${theme}-${width}-${size}`);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.locator("#reportPrivacyChoice").click();
    const ready = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[name=promptMode][value=original]').check(); await ready;
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    const buttons = await page.locator(".report-warning-actions>button:not(.report-warning-back)").evaluateAll(nodes =>
        nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
    assert.deepEqual(buttons[0], buttons[1]);
    await capture("warning-dark-375");
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    assert.deepEqual(errors, []);
});
