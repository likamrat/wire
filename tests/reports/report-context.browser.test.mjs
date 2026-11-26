import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../../lib/store.mjs";
import { reportContextFixture } from "./report-context-fixture.mjs";
import { selectReportFocus } from "./report-journey-helpers.mjs";

for (const action of ["recover", "revoke", "late-preview"]) test(`selected report with linked reply: ${action}`, async t => {
    const cleanup = [], { context, records } = await reportContextFixture({ after: fn => cleanup.push(fn) });
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const gate = Promise.withResolvers();
    t.after(async () => {
        gate.resolve(); await browser.close(); await runtime.close();
        for (const fn of cleanup) await fn();
    });
    const page = await browser.newPage({ reducedMotion: "reduce" }), posts = [];
    page.setDefaultTimeout(7000);
    page.on("request", req => { if (req.method() === "POST") posts.push({ path: new URL(req.url()).pathname, body: req.postDataJSON() }); });
    await page.goto(new URL("/reports", runtime.url).href);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await selectReportFocus(page, "all");
    await page.locator("#reportDeskActivity").click();
    const picker = page.getByRole("dialog", { name: "Choose activity" });
    await picker.getByRole("radio", { name: /^Selected interactions/ }).check();
    await picker.locator(`[data-report-request="${records[1].scenarioId}"]`).check();
    await picker.getByRole("button", { name: "Use activity", exact: true }).click();
    await page.locator("#prepareReportPreview").click();
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    const produced = Promise.withResolvers(), delivered = page.waitForResponse("**/api/preview");
    if (action === "late-preview") await page.route("**/api/preview", async route => {
        const response = await route.fetch(); produced.resolve(await response.json());
        await gate.promise; await route.fulfill({ response });
    }, { times: 1 });
    await page.locator("#reportRecordedContext").check();
    const prepared = action === "late-preview" ? await produced.promise : await (await delivered).json();
    assert.ok(prepared.contextReview.some(copy => copy.kind === "response" && copy.text?.includes("Here are three synthetic")));
    assert.equal(prepared.records.length, 1);
    assert.doesNotMatch(JSON.stringify(prepared), /UNRELATED_CONTEXT_MUST_NOT_APPEAR/);
    if (action !== "late-preview") {
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await page.locator("#reportIncludeOptions").getByRole("button", { name: "Done" }).click();
    }
    if (action === "recover") {
        await page.route("**/api/export", async route => {
            const response = await route.fetch(); assert.equal(response.status(), 200);
            await route.abort("connectionreset");
        }, { times: 1 });
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.getByRole("button", { name: "Check save status" })).toBeEnabled();
        const [saved] = (await loadBoardState(context)).exports;
        assert.equal(saved.bundleId, prepared.bundleId);
        assert.deepEqual(saved.scenarioIds, [records[1].scenarioId]);
        assert.equal(saved.privacyReview.reviewerConfirmed, false);
        await page.getByRole("button", { name: "Check save status" }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        await page.getByRole("button", { name: "Open saved report" }).click();
        await expect(page.locator("#savedReportReader")).toBeVisible();
        assert.equal(await readFile(saved.files["product-report.html"], "utf8"), prepared.files["product-report.html"]);
        assert.deepEqual(posts.filter(r => r.path === "/api/export").map(r => r.body.previewId), [prepared.previewId]);
    } else {
        await updateBoardState(context, state => {
            state.personalEvaluation.consent = { ...state.personalEvaluation.consent, state: "revoked", revision: 2,
                categories: [], revokedAt: "2026-10-01T00:00:00.000Z" };
        });
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "draft", { timeout: 12000 });
        gate.resolve(); await (await delivered).finished();
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeHidden();
        await expect(page.locator("#reportReviewBody")).not.toContainText("Here are three synthetic");
        assert.deepEqual((await loadBoardState(context)).exports, []);
    }
    assert.deepEqual(posts.filter(r => r.path === "/api/privacy-review"), []);
});
