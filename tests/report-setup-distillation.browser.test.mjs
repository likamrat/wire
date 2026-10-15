import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { chooseReportScope, openReportLibrary, scanReport, inspectReportCopies } from "./report-journey-helpers.mjs";

async function setup(t) {
    const { context } = await privateFixture(t, [fixture()]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => {
        await browser.close();
        runtime.server.closeAllConnections();
        await runtime.close();
    });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname); });
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(runtime.url + "#reports?task=create");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    return { page, context, writes };
}

async function measure(page, selector) {
    return page.locator(selector).evaluate(root => ({
        words: root.innerText.trim().split(/\s+/).length,
        groups: [...root.querySelectorAll("fieldset, details")].filter(node => node.checkVisibility()).length,
        controls: [...root.querySelectorAll("button,input,select,textarea,summary,a")].filter(node => node.checkVisibility()).length,
        disclosures: [...root.querySelectorAll("details")].filter(node => node.checkVisibility()).length,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
    }));
}

async function capture(page, name, selector = "#reportCreatePanel") {
    const measured = await measure(page, selector);
    console.log(JSON.stringify({ name, ...measured }));
    if (process.env.WIRE_REPORT_SETUP_PROOFS) {
        await mkdir(process.env.WIRE_REPORT_SETUP_PROOFS, { recursive: true });
        await page.evaluate(() => new Promise(resolve => {
            scrollTo({ top: 0, left: 0, behavior: "instant" });
            requestAnimationFrame(() => requestAnimationFrame(resolve));
        }));
        await page.screenshot({ path: path.join(process.env.WIRE_REPORT_SETUP_PROOFS, name + ".png"), fullPage: true });
        await writeFile(path.join(process.env.WIRE_REPORT_SETUP_PROOFS, name + ".json"), JSON.stringify(measured, null, 2));
    }
    return measured;
}

test("Setup keeps every choice with one relevant scope explanation and conditional context consequences", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await capture(page, "setup-default");
    assert.equal(await page.locator(".scope-choice-help:visible").count(), 1);
    assert.equal(await page.locator('[name="reportScope"]:visible').count(), 3);
    assert.equal(await page.locator('[name="promptMode"]:visible').count(), 0);
    assert.equal(await page.locator("#formatOptions input:visible").count(), 0);
    assert.equal(await page.locator("#reportPromptAuthorFilter option").count(), 3);
    assert.equal(await page.locator("#reportRecordedContextHelp").isVisible(), false);
    for (const scope of ["all", "current", "selected"]) {
        await chooseReportScope(page, scope);
        assert.equal(await page.locator(".scope-choice-help:visible").count(), 1);
        assert.equal(await page.locator(`[name=reportScope][value=${scope}]`).isChecked(), true);
        assert.ok((await page.locator("#reportScopeChoiceHelp").innerText()).length > 0);
    }
    await chooseReportScope(page, "all");
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    assert.equal(await page.locator('[name="promptMode"]:visible').count(), 3);
    assert.equal(await page.locator("#formatOptions input:visible").count(), 4);
    for (const mode of ["none", "masked", "original"]) {
        await page.locator(`[name=promptMode][value=${mode}]`).check();
        assert.equal(await page.locator("#promptOptions .prompt-choice > span > span:visible").count(), 1);
        assert.equal(await page.locator("#reportRecordedContext").isDisabled(), mode === "none");
        if (mode === "none") {
            assert.match(await page.locator("#reportRecordedContextHelp").innerText(), /No prompts/);
        } else {
            await page.locator("#reportRecordedContext").check();
            assert.match(await page.locator("#reportRecordedContextHelp").innerText(), /author.*prompt.*Review|author.*prompt.*review/s);
            assert.match(await page.locator("#reportRecordedContextHelp").innerText(), /not.*permission|does not authorize/);
            await page.locator("#reportRecordedContext").uncheck();
            assert.equal(await page.locator("#reportRecordedContextHelp").isVisible(), false);
        }
    }
    await chooseReportScope(page, "all");
    await selectActivityOption(page, "reportPromptAuthorFilter", ["agent"]);
    assert.equal(await page.locator("#reportPromptAuthorSummary").isVisible(), true);
    assert.match(await page.locator("#reportPromptAuthorSummary").innerText(), /left out/);
    await selectActivityOption(page, "reportPromptAuthorFilter", "all");
    assert.equal(await page.locator("#reportPromptAuthorSummary").isVisible(), false);
    assert.equal(await page.locator("#scopeDetails").evaluate(node => node.contains(document.querySelector("#reportTimeContext"))), true);
});

test("An empty library has one honest state and the existing create path instead of unusable search and management", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await openReportLibrary(page);
    await capture(page, "empty-library", "#savedReportsPanel");
    assert.equal(await page.locator("#savedReportSearch").isVisible(), false);
    assert.equal(await page.locator("#savedReportCount").isVisible(), false);
    assert.equal(await page.locator("#savedLibraryHelp").isVisible(), false);
    assert.equal(await page.locator("#savedLibraryManagement").isVisible(), false);
    assert.equal(await page.locator("#savedLibraryTitle").innerText(), "Saved reports");
    assert.match(await page.locator("#bundleList").innerText(), /No local reports have been saved/);
    await page.getByRole("link", { name: "Create a report", exact: true }).click();
    assert.equal(await page.locator("#reportStage1").isVisible(), true);
});

test("Setup remains readable with all controls at desktop and narrow enlarged text in both themes", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await chooseReportScope(page, "all");
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1600, 100], [375, 100], [375, 200]]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale + "%"; }, scale);
        const measured = await capture(page, `setup-${theme}-${width}-${scale}`);
        assert.equal(measured.overflow, false);
        assert.ok(measured.words < 250, "Default Setup removes repeated explanations without removing choices");
        assert.equal(await page.locator(".report-step[aria-current=step]").getAttribute("aria-label"), "2. Contents");
        const clipping = await page.locator("#reportStage2").evaluate(root => [...root.querySelectorAll("label,summary,button")]
            .filter(node => node.checkVisibility() && node.scrollWidth > node.clientWidth + 1).map(node => node.textContent));
        assert.deepEqual(clipping, []);
        const rows = await page.locator("#reportStage2 .prompt-choice").evaluateAll(nodes => nodes.map(node => {
            const style = getComputedStyle(node);
            const contentHeight = Math.max(...[...node.children].map(child => child.getBoundingClientRect().height));
            return { text: node.textContent, actual: node.getBoundingClientRect().height,
                natural: Math.max(44, contentHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
                    + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)) };
        }));
        for (const row of rows) assert.ok(row.actual <= row.natural + 1, `Choice height follows its visible content, not hidden paragraphs: ${JSON.stringify(row)}`);
        await page.locator("#reportRecordedContext").check();
        assert.equal(await page.locator("#reportRecordedContextHelp").isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.locator("#reportRecordedContext").uncheck();
    }
});

test("verified empty transitions through actual review, separate save, frozen reading, deletion and reconnect", { timeout: 60000 }, async t => {
    const { page, context, writes } = await setup(t);
    const before = await loadBoardState(context);
    await chooseReportScope(page, "all");
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    await page.locator("#formatOptions input[value=html]").uncheck();
    assert.equal(await page.locator("#exportBtn").isDisabled(), true);
    await page.locator("#formatOptions input[value=html]").check();
    await scanReport(page);
    await page.frameLocator("#reportReviewBody iframe").locator("h1").waitFor();
    assert.ok((await page.frameLocator("#reportReviewBody iframe").locator("body").innerText()).length > 100);
    await inspectReportCopies(page);
    assert.ok(await page.locator("#reportReviewBody .prompt-comparison").count() > 0);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    assert.equal((await loadBoardState(context)).exports.length, 0, "Review is not Save");
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    const saved = (await loadBoardState(context)).exports[0];
    const frozenBefore = await Promise.all(Object.values(saved.files).map(file => readFile(file)));
    await openReportLibrary(page);
    assert.equal(await page.locator("#savedReportSearch").isVisible(), true);
    assert.equal(await page.locator("#savedLibraryHelp").isVisible(), true);
    assert.equal(await page.locator("#savedLibraryManagement").isVisible(), true);
    await page.locator("#savedReportSearch").fill("no-such-report");
    assert.match(await page.locator("#bundleList").innerText(), /No saved reports match/);
    assert.equal(await page.locator("#savedLibraryManagement").isVisible(), true);
    await page.locator("#savedReportSearch").fill("HTML");
    const open = page.getByRole("button", { name: "Open saved report", exact: true });
    await open.click();
    await page.frameLocator("#savedReportReader iframe").locator("h1").waitFor();
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await page.locator("#savedReportReader").waitFor({ state: "hidden" });
    assert.equal(await open.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#savedReportSearch").inputValue(), "HTML");
    assert.deepEqual(await Promise.all(Object.values(saved.files).map(file => readFile(file))), frozenBefore);
    await page.locator("#savedLibraryManagement > summary").click();
    await page.locator("#deleteAllReports").click();
    await page.getByRole("button", { name: "Delete 1 saved reports", exact: true }).click();
    await page.getByRole("heading", { name: "1 saved reports deleted", exact: true }).waitFor();
    await page.locator(".deletion-dialog:modal").getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(".deletion-dialog:modal").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#savedReportSearch").isVisible(), false);
    await page.waitForFunction(() => document.activeElement?.matches("#savedLibraryTitle,#reportCreateLink") && document.activeElement.checkVisibility());
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => { await gate; await route.continue(); }, { times: 1 });
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await page.locator('#workspace[aria-busy="true"]').waitFor();
    assert.equal(await page.locator("#savedReportSearch").isVisible(), true, "Pending is not verified empty");
    assert.equal(await page.locator("#savedLibraryManagement").isVisible(), true);
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true);
    assert.match(await page.locator("#bundleList").innerText(), /Checking saved reports/);
    await page.locator("#savedReportSearch").focus();
    release();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.equal(await page.locator("#savedReportSearch").isVisible(), false);
    assert.equal(await page.locator("#reportCreateLink").evaluate(node => node === document.activeElement), true);
    await page.route("**/api/snapshot", route => route.abort("connectionreset"), { times: 1 });
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false"
        && document.querySelector("#message [data-stored-refresh-retry]")?.checkVisibility());
    assert.equal(await page.locator("#savedReportSearch").isVisible(), true, "An error is not verified empty");
    assert.match(await page.locator("#bundleList").innerText(), /could not be checked/);
    assert.equal(await page.locator("#deleteAllReports").isDisabled(), true);
    await page.reload();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.equal(await page.locator("#savedReportSearch").isVisible(), false);
    assert.equal(writes.filter(url => url === "/api/preview").length, 1);
    assert.equal(writes.filter(url => url === "/api/privacy-review").length, 1);
    assert.equal(writes.filter(url => url === "/api/export").length, 1);
    assert.equal(writes.filter(url => url === "/api/artifact-deletion/confirm").length, 1);
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
});
