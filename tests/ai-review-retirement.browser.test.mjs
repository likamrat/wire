import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { retirementFixture, retirementClient } from "./ai-review-retirement-fixture.mjs";
import { navigateMain, navigateSettings } from "./helpers.mjs";
import { scanReport } from "./report-journey-helpers.mjs";

test("normal Analyze, reader, Settings and Search retain replies and reporting without any rating functionality", { timeout: 45000 }, async t => {
    const cleanups = [], f = await retirementFixture({ after: action => cleanups.push(action) });
    const unexpected = [], errors = [], requests = [];
    const forbidden = () => { unexpected.push("evaluation"); throw new Error("No evaluation work permitted."); };
    const runtime = await startServer(f.context, createExportController(f.context), {
        port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: forbidden, readSource: forbidden, discover: forbidden },
    });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    t.after(async () => {
        try { await browser.close(); await runtime.close(); }
        finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(runtime.url).origin) {
            unexpected.push("external:" + url.origin); return route.abort();
        }
        if (route.request().method() === "POST") requests.push(url.pathname);
        return route.continue();
    });
    await page.addInitScript(() => {
        window.fixtureCopies = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            async writeText(text) { window.fixtureCopies.push(text); },
            readText() { throw new Error("Real clipboard access is forbidden."); },
        } });
    });
    const legacyPending = JSON.stringify({ schemaVersion: 1, kind: "approve", mutationRef: f.mutationRef, receiptToken: f.receiptToken });
    await page.addInitScript(value => sessionStorage.setItem("wire.automaticScore.pending", value), legacyPending);
    const legacyPersonal = JSON.stringify({ mutationRef: f.personalMutationRef, receiptToken: f.receiptToken, action: "set_personal_assessment" });
    await page.addInitScript(value => sessionStorage.setItem("wire.assessment.pending", value), legacyPersonal);
    const api = await retirementClient(runtime);
    const settings = (await api("/api/assessment/consent", { schemaVersion: 1 })).body;
    const enabled = await api("/api/assessment/consent/set", {
        schemaVersion: 1, mutationRef: "mutation-" + randomBytes(16).toString("hex"),
        expectedSourceRevision: settings.basis.sourceRevision, expectedConsentRevision: settings.data.consent.revision,
        policyVersion: 1, enabled: true, categories: ["answer"], confirmed: true,
        sourceConfigRef: settings.data.source.sourceConfigRef, sourceConfigRevision: settings.data.source.sourceConfigRevision,
    });
    assert.equal(enabled.status, 200);
    await runtime.collector.collectNow();
    const answer = "Invented saved reply after review retirement.";
    await appendFile(path.join(f.config.sessionRoot, f.inputs[0].record.sourceSessionId, "events.jsonl"),
        JSON.stringify({ id: "retirement-answer", type: "assistant.message", timestamp: new Date().toISOString(), data: { content: answer } }) + "\n");
    await runtime.collector.collectNow();
    const historical = JSON.stringify((await loadBoardState(f.context)).personalEvaluation.modelEvaluation);
    const personal = JSON.stringify((await loadBoardState(f.context)).personalEvaluation.feedback);
    await page.goto(runtime.url);
    await expect(page.locator('#workspace[aria-busy="false"]')).toBeVisible();
    await expect(page.locator(".request-card-open").first()).toBeVisible();
    assert.equal(await page.locator("[data-automatic-scores],#automaticScoreSetup,[data-settings-section=ai]").count(), 0);
    await page.locator(`.request-card-open[href*="${encodeURIComponent(f.inputs[0].record.scenarioId)}"]`).first().click();
    const reader = page.locator("#contextSidebar");
    await expect(reader).toContainText(answer);
    assert.doesNotMatch(await reader.innerText(), /Automatic scores|AI quality|Saved check details|Local checks do not|Completion-evidence checks|Saved AI review|Personal feedback|Your feedback/i);
    await expect(reader.locator('[data-reader-section="reviews"],[data-feedback-dimension],.assessment-feedback-dialog')).toHaveCount(0);
    if (process.env.WIRE_AI_REMOVAL_PROOFS) {
        await mkdir(process.env.WIRE_AI_REMOVAL_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_AI_REMOVAL_PROOFS, "current-reader.png") });
    }
    await reader.getByRole("button", { name: /^Copy response(?: \d+)?$/ }).last().click();
    assert.ok((await page.evaluate(() => window.fixtureCopies)).includes(answer));
    await reader.getByRole("button", { name: "Add to report", exact: true }).click();
    await page.locator("#closeContextSidebar").click();
    await navigateMain(page, "settings");
    await expect(page.locator("#settingsCategoryNav")).not.toContainText("AI reviews");
    await page.locator("#settingsSearch").fill("automatic scores");
    await expect(page.locator("#settingsSearchCount")).toContainText("No settings match");
    await page.locator("#clearSettingsSearch").click();
    await navigateSettings(page, "privacy");
    await expect(page.locator("#assessmentSetup")).toContainText("Save Copilot replies locally");
    if (process.env.WIRE_AI_REMOVAL_PROOFS) await page.screenshot({ path: path.join(process.env.WIRE_AI_REMOVAL_PROOFS, "current-settings.png") });
    await navigateMain(page, "reports");
    await page.locator("#reportCreateLink").click();
    await expect(page.locator("input[data-report-request]:checked")).toHaveCount(1);
    const preview = await scanReport(page);
    assert.equal(preview.snapshot.evaluationFacts.metricProjectionVersion, 4);
    assert.doesNotMatch(preview.previewHtml, /AI results|AI reviews|Quality results|synthetic-quality-fixture|Personal feedback|Your feedback/);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    const savedResponse = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    assert.equal((await savedResponse).status(), 200);
    assert.equal((await loadBoardState(f.context)).exports.length, 1);
    await navigateMain(page, "analyze");
    await page.locator("#wireSearch").fill("Invented saved reply after review retirement");
    await expect(page.locator("#wireSearchResults")).toContainText("saved reply");
    assert.equal(requests.some(route => route.startsWith("/api/evaluation/")), false);
    assert.equal(requests.includes("/api/assessment/feedback"), false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.automaticScore.pending")), legacyPending,
        "A stale local receipt is neither replayed nor silently erased.");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.assessment.pending")), legacyPersonal);
    assert.equal(JSON.stringify((await loadBoardState(f.context)).personalEvaluation.modelEvaluation), historical);
    assert.equal(JSON.stringify((await loadBoardState(f.context)).personalEvaluation.feedback), personal);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    if (process.env.WIRE_AI_REMOVAL_PROOFS) {
        await mkdir(process.env.WIRE_AI_REMOVAL_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_AI_REMOVAL_PROOFS, "current-search.png"), fullPage: true });
        await writeFile(path.join(process.env.WIRE_AI_REMOVAL_PROOFS, "normal-entry.json"), JSON.stringify({ requests, errors, unexpected }, null, 2));
    }
});
