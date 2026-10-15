import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, chooseTheme, openActivitySessions, navigateMain } from "./helpers.mjs";
import { reportContents, inspectReportCopies, openReportLibrary, chooseReportScope } from "./report-journey-helpers.mjs";

test("synthetic full report journey: choices, comparisons, current review, all formats and local downloads", { timeout: 120000 }, async (t) => {
    const source = fixture();
    source.userPrompt.text = "BROWSER_PROMPT Leila Navarro\nleila@example.invalid\npassword='BROWSER_SECRET'\n<script>window.injected=true</script>";
    source.toolCalls.push({ tool: "workiq-ask", toolCallId: "browser-question", requestArgs: { question: "BROWSER_QUESTION Leila Navarro" }, apiResults: [], reportedOutcome: "unknown" });
    const { context } = await privateFixture(t, [source]);
    const initial = await loadBoardState(context);
    const originalBytes = await readFile(path.join(context.dataDir, "private-evidence", initial.evidenceFile));
    const runtime = await startServer(context, createExportController(context), { port: 0 });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: "reduce" });
    const errors = [], external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (!request.url().startsWith(runtime.url) && !request.url().startsWith("about:")) external.push(request.url()); });
    await page.goto(runtime.url);
    await page.locator(".time-column").first().click();
    await page.locator("#activityList .request-row").waitFor();
    await openActivitySessions(page);
    await page.locator("#activityList .request-link").first().click();
    const reader = page.locator(".request-original .full-text-toggle");
    if (await reader.getAttribute("aria-expanded") === "false") await reader.click();
    assert.equal(await page.locator(".request-original pre").textContent(), source.userPrompt.text);
    await page.getByRole("button", { name: "Add to report", exact: true }).click();
    await page.locator("nav [data-nav=reports]").click();
    await reportContents(page);
    await page.waitForFunction(() => !document.querySelector("#exportBtn").disabled);
    assert.equal(await page.locator('[name=promptMode][value=masked]').isChecked(), true);
    for (const format of ["pdf", "json", "markdown"]) await page.locator(`#formatOptions input[value=${format}]`).check();
    await page.getByText("Additional masking", { exact: true }).click();
    await page.locator("#manualTerms").fill("Leila Navarro");

    const proof = process.env.WORKIQ_REPORT_PROOFS;
    if (proof) await mkdir(path.join(proof, "screenshots"), { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 900 });
        await chooseTheme(page, theme);
        await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (proof) await page.screenshot({ path: path.join(proof, "screenshots", `reports-${theme}-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1200, height: 900 });
    for (const mode of ["masked", "none", "original"]) {
        if (mode !== "masked") {
            await chooseReportScope(page, "all");
            await reportContents(page);
            await page.waitForFunction(() => !document.querySelector("#exportBtn").disabled);
            await page.locator(`[name=promptMode][value=${mode}]`).check();
            await page.locator("#manualTerms").fill("");
        }
        const pending = page.waitForResponse((response) => response.url().endsWith("/api/preview"));
        await page.locator("#exportBtn").click();
        let preview = await (await pending).json();
        await page.locator(".attestation input[data-review-control]").waitFor();
        assert.equal(preview.promptMode, mode);
        assert.deepEqual(preview.formats, ["html", "pdf", "json", "markdown"]);
        assert.equal((await loadBoardState(context)).exports.length, mode === "masked" ? 0 : mode === "none" ? 1 : 2);
        assert.equal(await page.locator("#reportStage3").isVisible(), true);
        assert.equal(await page.getByRole("button", { name: "Save report", exact: true }).isVisible(), false);
        assert.equal(await page.frameLocator(".report-frame").locator("script,img,iframe").count(), 0);
        assert.equal((await page.frameLocator(".report-frame").locator(".report-brand h1").innerText()).replace(/\s+/g, " ").trim(), "WIRE Activity report");
        assert.equal(await page.frameLocator(".report-frame").getByRole("heading", { level: 1, name: "WIRE Activity report", exact: true }).count(), 1);
        assert.equal(await page.frameLocator(".report-frame").locator(".report-brand .brand-logo:visible").count(), 1);
        const frameText = await page.frameLocator(".report-frame").locator("body").innerText();
        assert.equal(frameText.includes("BROWSER_PROMPT"), mode !== "none");
        assert.equal(frameText.includes("leila@example.invalid"), mode === "original");
        assert.equal(frameText.includes("BROWSER_SECRET"), false);
        await inspectReportCopies(page);
        if (mode === "none") {
            assert.equal(await page.locator(".prompt-report pre").count(), 0);
            assert.equal(await page.locator(".prompt-original pre").first().isVisible(), false);
        } else {
            assert.equal(await page.locator(".prompt-original pre").first().textContent(), source.userPrompt.text);
            assert.ok(await page.locator(".prompt-report mark.mandatory").count());
        }
        if (proof) await page.locator("#reportStage3").screenshot({ path: path.join(proof, "screenshots", `preview-${mode}-dark.png`) });
        if (mode === "masked") {
            await page.locator(".prompt-comparison").first().getByText("Edit or omit this report copy", { exact: true }).click();
            await page.locator(".prompt-comparison textarea").first().fill("EDITED_BROWSER_COPY\npassword='EDIT_SECRET'");
            await page.getByRole("button", { name: "Rebuild preview", exact: true }).waitFor();
            assert.equal(await page.getByRole("button", { name: "Save report", exact: true }).isVisible(), false);
            const rebuilt = page.waitForResponse((response) => response.url().endsWith("/api/preview"));
            await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
            preview = await (await rebuilt).json();
            await page.locator(".attestation input[data-review-control]").waitFor();
            assert.equal(preview.promptReview[0].original, source.userPrompt.text);
            assert.match(preview.records[0].prompts[0].text, /EDITED_BROWSER_COPY/);
            assert.doesNotMatch(preview.records[0].prompts[0].text, /EDIT_SECRET/);
            await inspectReportCopies(page);
            await page.locator(".prompt-comparison").first().getByText("Edit or omit this report copy", { exact: true }).click();
            await page.locator(".prompt-comparison").first().getByRole("checkbox", { name: "Omit this prompt from the report", exact: true }).check();
            const omitted = page.waitForResponse(response => response.url().endsWith("/api/preview"));
            await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
            preview = await (await omitted).json();
            await page.locator("#reportsView[data-report-phase=ready]").waitFor();
            assert.equal(preview.promptReview[0].omitted, true);
            assert.equal(preview.records[0].prompts[0].text, null);
            assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false);
        }
        await page.locator(".attestation input[data-review-control]").check();
        assert.equal(await page.getByRole("button", { name: "Save report", exact: true }).isVisible(), false);
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await page.locator("#reportsView[data-report-phase=saved]").waitFor();
        await openReportLibrary(page);
        const saved = await loadBoardState(context), latest = saved.exports.at(-1);
        const savedRow = page.locator(`#bundleList [data-bundle-id="${latest.bundleId}"]`);
        await savedRow.locator(".saved-report-summary").click();
        const download = page.waitForEvent("download");
        await page.locator("#contextSidebar").getByRole("button", { name: `Download product-report.json for ${latest.bundleId}`, exact: true }).click();
        const item = await download;
        const downloaded = JSON.parse(await readFile(await item.path(), "utf8"));
        assert.equal(downloaded.promptMode, mode);
        assert.deepEqual(downloaded.records, preview.records);
        await page.locator("#closeContextSidebar").click();
    }
    assert.deepEqual(await readFile(path.join(context.dataDir, "private-evidence", initial.evidenceFile)), originalBytes);
    assert.deepEqual((await loadBoardState(context)).cards, initial.cards);
    assert.equal((await loadBoardState(context)).exports.length, 3);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await navigateMain(page, "activity");
    await page.goBack();
    assert.equal(await page.locator("#reportsView").isVisible(), true);
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator("#exportBtn").focus();
    await page.keyboard.press("Enter");
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false);
    await page.getByRole("button", { name: "Back to contents", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "exportBtn");
});
