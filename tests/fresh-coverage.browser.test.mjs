import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme, navigateMain } from "./helpers.mjs";

test("freshness groups source help with the action and explains check-wide gaps", { timeout: 90000 }, async t => {
    const { context } = await privateFixture(t);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1644, height: 1050 }, reducedMotion: "reduce", timezoneId: "America/Los_Angeles" });
    const errors = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() === "POST" && !["/api/snapshot", "/api/collection/status", "/api/session", "/api/session/release", "/api/collection/now", "/api/evaluation/automatic/summary"].includes(new URL(request.url()).pathname)) mutations.push(new URL(request.url()).pathname);
    });
    const coverage = { eligible: 7, readable: 3, unavailable: 4, limited: 1, pending: 1, affected: 5,
        groups: { missing: 4, context: 1 }, excluded: { archived: 2 } };
    const check = { schemaVersion: 2, id: "synthetic-check", configVersion: "synthetic-config", revision: before.revision,
        beforeRevision: before.revision, startedAt: "2026-10-08T16:47:54Z", completedAt: "2026-10-08T16:47:55Z",
        outcome: "partial", changes: { added: 0, updated: 0, items: [] }, coverage,
        eligibleSources: 7, sourcesChecked: 7, pendingSources: 1, partialSources: 0, skippedSources: 0 };
    const status = () => ({ state: "paused", configVersion: check.configVersion, revision: before.revision,
        config: { approved: true, enabled: false, windowDays: 30, pollSeconds: 5 }, connected: true,
        discovery: { counts: { sessions: 9, eligible: 7, skippedByLimit: 0 } },
        historyCoverage: coverage, metrics: {}, cadence: { pollSeconds: 5 },
        lastCheckedAt: check.completedAt, lastNewDataAt: null });
    let detailedReads = 0, checks = 0, nextCheck = check, failCheck = false, gate;
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), payload = await response.json();
        await route.fulfill({ response, json: { ...payload, collection: status() } });
    });
    await page.route("**/api/collection/status", async route => {
        const detailed = route.request().postDataJSON().details === true;
        if (detailed) detailedReads++;
        await route.fulfill({ json: { ...status(), ...(detailed ? { historyIssues: [
            { sessionId: "invented-missing", name: "Invented missing chat", reasons: ["missing"], unavailable: true, hasPriorEvidence: false },
        ] } : {}) } });
    });
    await page.route("**/api/collection/now", async route => {
        checks++;
        if (gate) await gate;
        await route.fulfill(failCheck ? { status: 422, json: { error: "Synthetic collection error; previous view kept." } } : { json: { ...status(), check: nextCheck } });
    });
    await page.goto(runtime.url);
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await page.locator("#checkActivity").click();
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "partial");
    await page.evaluate(() => document.fonts.ready);
    const failures = [];
    const action = await page.locator("#checkActivity").boundingBox(), help = await page.locator("#freshHelp>summary").boundingBox();
    if (!(help.x >= action.x + action.width && help.x - action.x - action.width <= 28 && Math.abs(help.y - action.y) <= 4)) failures.push("Source and collection must sit beside its check action, not at the far page edge");
    const warning = await page.locator("#freshIssues").innerText();
    if (!/4 unavailable/.test(warning) || !/1 with limits/.test(warning) || !/1 still reading/.test(warning)) failures.push("The visible warning must name known unavailable, limited and pending chat counts");
    await page.locator("#freshHelp>summary").click();
    if (!/all eligible.*not.*view.*filters/i.test(await page.locator("#freshHelp").innerText())) failures.push("Help must distinguish check-wide history gaps from the current filtered view");
    assert.match(await page.locator("#freshCoverageDetails").innerText(), /4 Copilot chats: Saved Copilot chat history file not found/);
    assert.match(await page.locator("#freshCoverageDetails").innerText(), /cannot recreate an absent file/);
    assert.match(await page.locator("#freshCoverageDetails").innerText(), /1 Copilot chat: Some request-to-action links/);
    assert.match(await page.locator("#freshCoverageDetails").innerText(), /grouped once.*other limits/);
    assert.doesNotMatch(await page.locator("#freshCoverageDetails").innerText(), /\[object/);
    assert.equal(detailedReads, 0, "Opening source help must not fetch the personal issue inventory");
    if (process.env.WIRE_FRESH_PROOF_DIR) {
        await mkdir(process.env.WIRE_FRESH_PROOF_DIR, { recursive: true });
        await page.locator("#freshHelp>summary").click();
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            await page.screenshot({ path: path.join(process.env.WIRE_FRESH_PROOF_DIR, `${theme}-wide.png`), fullPage: true });
        }
    }
    assert.deepEqual(failures, []);
    if (await page.locator("#freshHelp").evaluate(node => node.open)) await page.locator("#freshHelp>summary").click();
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1644]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1050 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; scrollTo(0, 0); }, scale);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const boxes = async () => page.evaluate(() => Object.fromEntries(["checkActivity", "freshHelp", "freshStatus"].map(id => {
            const node = id === "freshHelp" ? document.querySelector("#freshHelp>summary") : document.getElementById(id);
            const box = node.getBoundingClientRect();
            return [id, { x: box.x, y: box.y + scrollY, width: box.width, height: box.height }];
        })));
        const anchor = await boxes();
        for (const [state, overrides] of [
            ["no-new", { outcome: "complete", coverage: {}, pendingSources: 0 }],
            ["new", { outcome: "complete", coverage: {}, pendingSources: 0, beforeRevision: before.revision - 1, changes: { added: 1, updated: 0, items: [] } }],
            ["partial", {}],
            ["unavailable", { coverage: { unavailable: 7, limited: 0, groups: { missing: 7 } }, pendingSources: 0 }],
            ["unfinished", { coverage: {}, pendingSources: 0, partialSources: 1 }],
            ["error", {}],
        ]) {
            nextCheck = { ...check, ...overrides, id: `${theme}-${width}-${scale}-${state}` };
            failCheck = state === "error";
            let release;
            gate = new Promise(resolve => { release = resolve; });
            await page.locator("#checkActivity").focus(); await page.keyboard.press("Enter");
            await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "checking");
            assert.equal(await page.locator("#checkActivity").isDisabled(), true);
            assert.equal(await page.locator("#checkActivity .pending-indicator").evaluate(node => getComputedStyle(node).animationName), "none");
            for (const id of ["checkActivity", "freshHelp", "freshStatus"]) {
                const box = (await boxes())[id];
                assert.ok(Math.abs(box.x - anchor[id].x) <= 1 && Math.abs(box.y - anchor[id].y) <= 1, `${theme}/${width}/${scale}/${state}/${id}: stable pending anchor`);
            }
            release(); gate = undefined;
            await page.waitForFunction(() => ["complete", "partial", "error"].includes(document.querySelector("#freshActivity").dataset.phase) && !document.querySelector("#checkActivity").disabled);
            const completedBoxes = await boxes();
            for (const id of ["checkActivity", "freshHelp", "freshStatus"]) {
                assert.ok(Math.abs(completedBoxes[id].x - anchor[id].x) <= 1 && Math.abs(completedBoxes[id].y - anchor[id].y) <= 1, `${theme}/${width}/${scale}/${state}/${id}: stable result anchor`);
            }
            assert.equal(await page.locator("#checkActivity").evaluate(node => node === document.activeElement), true);
            assert.equal(await page.locator("#activityCount").innerText(), "1");
            assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "1");
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            if (state === "partial") {
                await page.locator("#freshHelp>summary").focus(); await page.keyboard.press("Enter");
                assert.equal(await page.locator("#freshHelp>summary").evaluate(node => getComputedStyle(node).outlineStyle !== "none"), true);
                assert.match(await page.locator("#freshHelp").innerText(), /cannot establish whether missing activity belongs in this view/);
                assert.equal(await page.locator("#freshHelpBody #refreshBtn").count(), 1, "Reload stays in the contextual disclosure");
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                const clipped = await page.locator("#freshHelp p,#freshHelp dt,#freshHelp dd").evaluateAll(nodes => nodes.filter(node => {
                    const r = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
                    return [...range.getClientRects()].some(box => box.width && (box.left < r.left - 1 || box.right > r.right + 1 || box.bottom > r.bottom + 1));
                }).map(node => node.textContent));
                assert.deepEqual(clipped, []);
                if (process.env.WIRE_FRESH_PROOF_DIR && (width === 1644 && scale === 1 || width === 375 && scale === 2)) {
                    await page.screenshot({ path: path.join(process.env.WIRE_FRESH_PROOF_DIR, `${theme}-${width}-${scale}-explanation.png`), fullPage: true });
                }
                await page.keyboard.press("Enter");
            }
            measurements.push({ theme, width, scale, state, boxes: completedBoxes });
        }
        if (process.env.WIRE_FRESH_PROOF_DIR) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(process.env.WIRE_FRESH_PROOF_DIR, `${theme}-${width}-${scale}-error.png`), fullPage: true });
        }
    }
    if (process.env.WIRE_FRESH_PROOF_DIR) await writeFile(path.join(process.env.WIRE_FRESH_PROOF_DIR, "state-layout.json"), JSON.stringify(measurements, null, 2));
    assert.equal(detailedReads, 0, "No personal issue inventory fetched by repeated checks, help, themes or text resizing");
    await navigateMain(page, "collection-status");
    await page.locator(".history-reason>summary").first().waitFor();
    assert.ok(detailedReads > 0);
    await page.locator(".history-reason>summary").first().click();
    await page.locator(".history-issue>summary").first().click();
    assert.match(await page.locator(".history-reason").first().innerText(), /cannot recreate an absent file/);
    assert.equal(checks, 73);
    assert.deepEqual(errors, []);
    assert.deepEqual(mutations, []);
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.cards, before.cards);
    assert.deepEqual(after.exports, before.exports);
});
