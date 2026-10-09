import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { privateFixture, fixture, chooseTheme, navigateMain, openActivitySessions, selectActivityOption, revealStoredRefresh } from "./helpers.mjs";
import { chooseReportScope, reportContents, scanReport, inspectReportCopies, openReportCreation } from "./report-journey-helpers.mjs";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { contrast } from "./color-measurements.mjs";

test("report hierarchy belongs to the current task, with local actions and consistent disclosures", { timeout: 60000 }, async t => {
    const { context } = await privateFixture(t, [fixture("hierarchy")]);
    const runtime = await startServer(context, createExportController(context), { port: 0 });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    await page.goto(runtime.url + "#reports?session=test-session");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await openReportCreation(page);
    assert.equal(await page.locator("#resetView").isVisible(), false, "Analytical reset does not belong to Reports.");
    assert.equal(await page.locator("#reportClearSelection").isVisible(), false, "An empty selection has nothing to clear.");
    const hints = await page.locator(".report-step-hint").evaluateAll(nodes => nodes.map(node => ({
        text: node.textContent, rect: node.getBoundingClientRect().toJSON(),
    })));
    assert.ok(hints.every(hint => hint.rect.width <= 1 && hint.rect.height <= 1), "Step prerequisites stay accessible without detached tile prose.");
    assert.match(hints[1].text, /Choose at least one readable request/);
    const typography = await page.locator("#scopeDetails>summary,#reportRequests>summary,#bundles>summary").evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight];
    }));
    assert.deepEqual(typography[0], typography[1]);
    assert.deepEqual(typography[1], typography[2]);
    assert.equal(await page.locator("#reportStage1>.report-stage-actions").getByRole("button", { name: "Choose requests in Activity", exact: true }).count(), 1);
    assert.equal(await page.locator("#reportStage1>.report-stage-actions").getByRole("button", { name: "Continue to contents", exact: true }).isDisabled(), true);
    assert.ok((await page.locator("#reportStepTitle1").boundingBox()).y < 600, "The chosen creation task remains in the first viewport below its workspace switch.");
    await chooseReportScope(page, "all");
    await page.locator(".report-other-scope>summary").click();
    assert.ok((await page.getByRole("button", { name: "Continue to contents", exact: true }).boundingBox()).y < 1000);
    await reportContents(page);
    await scanReport(page);
    const reviewFooter = page.locator("#reportStage3>.report-stage-actions");
    assert.equal(await reviewFooter.getByRole("button", { name: "Back to contents", exact: true }).count(), 1);
    assert.equal(await reviewFooter.getByRole("button", { name: "Complete disclosure review", exact: true }).count(), 1);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    const saveFooter = page.locator("#reportStage4>.report-stage-actions");
    assert.equal(await saveFooter.getByRole("button", { name: "Back to review", exact: true }).count(), 1);
    assert.equal(await saveFooter.getByRole("button", { name: "Confirm local export", exact: true }).count(), 1);
    assert.equal(await page.locator("#reportStage4 .report-save-summary").isVisible(), true);
    await page.getByRole("button", { name: "Back to review", exact: true }).click();
    assert.equal(await reviewFooter.getByRole("button", { name: "Continue to save", exact: true }).isVisible(), true);
    await page.getByRole("button", { name: "Continue to save", exact: true }).click();
    assert.equal(await saveFooter.getByRole("button", { name: "Confirm local export", exact: true }).isEnabled(), true);
});

test("normal report journey remains readable through scope, pending, dirty, recovery and saved states", { timeout: 180000 }, async t => {
    const app = await authorFilterFixture(t), browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    app.closeClient(() => browser.close());
    const proofs = process.env.WIRE_REPORT_JOURNEY_PROOFS, measurements = [], errors = [], external = [], requests = [];
    const digest = bytes => createHash("sha256").update(bytes).digest("hex");
    const sourceHashes = await Promise.all(app.sourceFiles.map(async file => digest(await readFile(file))));
    if (proofs) await mkdir(proofs, { recursive: true });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(app.runtime.url).origin) {
            external.push(route.request().url());
            return route.abort();
        }
        return route.continue();
    });
    const ready = () => page.locator('#workspace[aria-busy="false"]').waitFor();
    async function capture(name, comprehensive = false) {
        for (const theme of ["light", "dark"]) {
            for (const [width, text] of comprehensive ? [[1440, 100], [820, 100], [375, 100], [1200, 200], [375, 200]] : [[1440, 100], [375, 200]]) {
                await page.setViewportSize({ width, height: 1000 });
                await chooseTheme(page, theme);
                await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; }, text);
                await page.evaluate(() => document.fonts.ready);
                const measured = await page.evaluate(() => {
                    const root = document.querySelector("#reportsView"), panel = root.querySelector(".report-stage:not([hidden])");
                    const shown = node => node.checkVisibility({ checkVisibilityCSS: true });
                    const rect = node => {
                        const box = node.getBoundingClientRect();
                        return { label: node.textContent.trim(), x: box.x, y: box.y, right: box.right, bottom: box.bottom,
                            width: box.width, height: box.height, clipped: node.scrollWidth > node.clientWidth + 1 };
                    };
                    const background = node => {
                        for (let current = node; current; current = current.parentElement) {
                            const value = getComputedStyle(current).backgroundColor;
                            if (value !== "rgba(0, 0, 0, 0)") return value;
                        }
                        return getComputedStyle(document.documentElement).backgroundColor;
                    };
                    const controls = [...root.querySelectorAll("button,summary")].filter(shown);
                    const colors = [...root.querySelectorAll(".report-progress-label,[aria-current=step],.report-stage:not([hidden])>h3,.report-choice-summary,.report-scope-gap,.report-save-success,.report-stage:not([hidden]) .primary:not(:disabled)")].filter(shown).map(node => {
                        const paint = getComputedStyle(node, "::before").backgroundColor;
                        return { label: node.textContent.trim(), foreground: getComputedStyle(node).color,
                            background: node.matches("button.primary") && paint !== "rgba(0, 0, 0, 0)" ? paint : background(node) };
                    });
                    const buttons = controls.filter(node => node.tagName === "BUTTON").map(rect);
                    const overlaps = buttons.flatMap((a, index) => buttons.slice(index + 1).filter(b =>
                        Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1
                    ).map(b => [a.label, b.label]));
                    return { step: root.dataset.reportStep, phase: root.dataset.reportPhase,
                        height: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1,
                        controls: controls.map(rect), overlaps, colors, panel: rect(panel) };
                });
                assert.equal(measured.overflow, false, `${name}/${theme}/${width}/${text}: page fits`);
                assert.deepEqual(measured.overlaps, [], `${name}/${theme}/${width}/${text}: independent controls do not overlap`);
                assert.deepEqual(measured.controls.filter(control => control.height < 44 || control.clipped), [], `${name}/${theme}/${width}/${text}: readable 44px targets`);
                for (const color of measured.colors) assert.ok(contrast(color.foreground, color.background) >= 4.5, `${name}/${theme}: contrast for ${color.label}`);
                measurements.push({ name, theme, width, text, ...measured });
                if (proofs) {
                    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
                    await page.screenshot({ path: path.join(proofs, `${name}-${theme}-${width}-${text}.png`), fullPage: true });
                    if (name === "review" && width === 1440) {
                        await page.locator(".report-frame").scrollIntoViewIfNeeded();
                        await page.frameLocator(".report-frame").locator("h1").waitFor();
                        await page.waitForTimeout(150);
                        await page.screenshot({ path: path.join(proofs, `${name}-document-${theme}.png`) });
                    }
                }
            }
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    }
    async function hold(endpoint) {
        let release, arrived;
        const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
        await page.route(`**${endpoint}`, async route => {
            const response = await route.fetch();
            arrived();
            await held;
            await route.fulfill({ response });
        }, { times: 1 });
        return { pending, release };
    }
    await page.goto(app.runtime.url + "#reports?task=create"); await ready();
    await capture("empty", true);
    assert.equal(requests.filter(endpoint => endpoint === "/api/preview").length, 0);
    await navigateMain(page, "activity"); await ready(); await openActivitySessions(page);
    for (const key of ["ownMail", "agentMail", "unverified"]) await page.locator(`.request-row[data-view-key="request:${app.cases[key].scenarioId}"] input`).check();
    await selectActivityOption(page, "promptAuthorFilter", ["user"]); await ready();
    await navigateMain(page, "reports"); await ready();
    await openReportCreation(page);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /3 request groups/);
    await selectActivityOption(page, "reportPromptAuthorFilter", ["user", "agent"]);
    assert.match(await page.locator("#reportPromptAuthorSummary").textContent(), /2 of 3 request groups/);
    await capture("selected", true);
    await chooseReportScope(page, "current");
    assert.match(await page.locator("#reportPromptAuthorSummary").textContent(), /2 of 2 request groups/);
    await chooseReportScope(page, "all");
    assert.match(await page.locator("#reportPromptAuthorSummary").textContent(), /5 of 7 request groups/);
    await capture("all-known-authors");
    await chooseReportScope(page, "selected");
    await selectActivityOption(page, "reportPromptAuthorFilter", ["user"]);
    await reportContents(page);
    for (const mode of ["none", "original", "masked"]) await page.locator(`[name=promptMode][value=${mode}]`).check();
    for (const format of ["pdf", "json", "markdown"]) await page.locator(`#formatOptions input[value=${format}]`).check();
    await capture("contents", true);
    const waiting = await hold("/api/preview");
    await page.locator("#exportBtn").click(); await waiting.pending;
    await capture("scanning");
    assert.equal(await page.getByRole("button", { name: "4. Save", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
    const cancelled = page.waitForResponse(response => response.url().endsWith("/api/cancel-preview"));
    waiting.release(); await cancelled;
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-step"), "2");
    await page.route("**/api/preview", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic scan unavailable" }) }), { times: 1 });
    await openReportCreation(page);
    await page.locator("#exportBtn").click();
    await page.locator("#reportsView[data-report-phase=blocked]").waitFor();
    await capture("scan-error");
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
    const preview = await scanReport(page);
    assert.equal(preview.records.length, 1);
    assert.equal(preview.records[0].toolCalls.length, 2);
    assert.deepEqual(preview.snapshot.selectionScope.promptAuthors, ["user"]);
    assert.equal(preview.snapshot.selectionScope.baseRequestGroups, 3);
    await capture("review", true);
    await inspectReportCopies(page);
    await page.locator(".prompt-comparison").first().getByText("Edit or omit this report copy", { exact: true }).click();
    await page.locator(".prompt-comparison textarea").first().fill("Invented revised report copy");
    assert.equal(await page.getByRole("button", { name: "Complete disclosure review", exact: true }).isDisabled(), true);
    await capture("dirty");
    await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), false);
    await page.locator(".attestation input[data-review-control]").check();
    const reviewing = await hold("/api/privacy-review");
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click(); await reviewing.pending;
    await capture("review-pending");
    reviewing.release();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    await capture("save", true);
    await page.getByRole("button", { name: "Back to review", exact: true }).click();
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
    assert.equal(await (await revealStoredRefresh(page)).isDisabled(), true);
    const scans = requests.filter(endpoint => endpoint === "/api/preview").length;
    await openReportCreation(page);
    await page.locator("#exportBtn").click();
    await page.getByRole("button", { name: "Continue to save", exact: true }).click();
    assert.equal(requests.filter(endpoint => endpoint === "/api/preview").length, scans);
    const writing = await hold("/api/export");
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click(); await writing.pending;
    assert.equal(await page.getByRole("button", { name: "Back to review", exact: true }).isDisabled(), true);
    await capture("save-pending");
    writing.release();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    assert.doesNotMatch(await page.locator("#message").innerText(), /Local report saved:/, "Inline success does not leave a duplicate global success banner for the next draft.");
    await capture("saved", true);
    const saved = (await loadBoardState(app.context)).exports[0];
    const frozenHashes = await Promise.all(Object.values(saved.files).map(async file => digest(await readFile(file))));
    assert.equal(requests.filter(endpoint => endpoint === "/api/export").length, 1);
    await page.locator("#reportStage4").getByRole("button", { name: "Start a new report", exact: true }).click();
    await chooseReportScope(page, "all"); await reportContents(page);
    await page.locator("[name=promptMode][value=none]").check();
    await scanReport(page);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    await page.route("**/api/export", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=blocked]").waitFor();
    await capture("uncertain-save");
    assert.equal(await page.locator(".report-journey .notice.error:visible").count(), 1, "One current error, not duplicate confirmation feedback.");
    assert.match(await page.locator("#reportJourneyError").textContent(), /may have completed/);
    assert.equal(requests.filter(endpoint => endpoint === "/api/export").length, 2);
    await (await revealStoredRefresh(page)).click(); await ready();
    assert.match(await page.locator("#savedReportCount").textContent(), /^2 reports/);
    assert.equal(requests.filter(endpoint => endpoint === "/api/export").length, 2, "Recovery reads history, never replays the mutation.");
    await capture("history-recovery");
    assert.deepEqual(await Promise.all(Object.values(saved.files).map(async file => digest(await readFile(file)))), frozenHashes);
    assert.deepEqual(await Promise.all(app.sourceFiles.map(async file => digest(await readFile(file)))), sourceHashes);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.ok(!requests.some(endpoint => /\/api\/collection\/(?:now|configure|enabled)|\/api\/assessment\/(?:feedback|consent\/set)/.test(endpoint)));
    if (proofs) await writeFile(path.join(proofs, "measurements.json"), JSON.stringify({ synthetic: true, requests, measurements }, null, 2));
    t.diagnostic(`${measurements.length} actual renderer states measured; sources and prior saved bytes unchanged.`);
});
