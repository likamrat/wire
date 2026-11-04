import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";
import { fidelityEvents, collectFidelity, legacyFidelityRecord } from "./evidence-fidelity-fixture.mjs";
import path from "node:path";
import { mkdir } from "node:fs/promises";

test("cards, reader and author filters explain fresh and retained failures without changing stored evidence", { timeout: 60000 }, async t => {
    const source = fidelityEvents("user", Date.now() - 60000);
    const records = ["user", "agent", "unknown"].map(actor => collectFidelity(fidelityEvents(actor, Date.now() - 60000),
        { sessionId: `invented-${actor}` }));
    const legacy = legacyFidelityRecord(source);
    legacy.scenarioId = "invented-legacy"; legacy.sourceSessionId = "invented-legacy";
    records.push(legacy);
    const cleanups = [], { context } = await privateFixture({ after: fn => cleanups.push(fn) }, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const before = await loadBoardState(context), errors = [], forbidden = [];
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await loadBoardState(context), before);
            assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET"
            || ["/api/snapshot", "/api/connect", "/api/collection/status", "/api/assessment/detail",
                "/api/assessment/overview", "/api/evaluation/automatic/summary", "/api/report-artifacts/list"].includes(url.pathname))) return route.continue();
        forbidden.push(url.pathname); return route.abort();
    });
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    const card = id => page.locator(`.request-row[data-view-key="request:${id}"] .request-card-open`);
    const reason = "Work IQ reported HTTP 503 (Service unavailable). No further error details are retained.";
    for (const [index, actor] of ["user", "agent", "unknown"].entries()) {
        await expect(card(records[index].scenarioId)).toContainText({ user: "My prompt", agent: "Agent prompt", unknown: "Author unverified" }[actor]);
        await expect(card(records[index].scenarioId)).toContainText(reason);
    }
    await expect(card("invented-legacy")).toContainText("The tool reported HTTP 503 (Service unavailable). No further error details are retained.");
    await expect(card("invented-legacy")).toContainText("Author unverified");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await card(records[0].scenarioId).click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
        const reader = page.locator("#requestContent");
        await expect(reader).toContainText("My prompt");
        await expect(reader).toContainText(reason);
        await expect(reader).not.toContainText(/unsupported format|Request timed out|try again/i);
        await expect(reader).toContainText("The recorded path does not identify a named app. The call still counts; its result is shown separately.");
        await expect(reader).not.toContainText(/Inspect the recorded request|named-app service counts|Other identified targets/);
        if (process.env.WIRE_FIDELITY_PROOFS) {
            await mkdir(process.env.WIRE_FIDELITY_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_FIDELITY_PROOFS, `fidelity-${theme}.png`) });
        }
        await page.locator("#closeContextSidebar").click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    }
    for (const [id, label, expectedReason] of [
        ["invented-legacy", "Author unverified", "The tool reported HTTP 503 (Service unavailable). No further error details are retained."],
        [records[1].scenarioId, "Agent prompt", reason],
        [records[2].scenarioId, "Author unverified", reason],
    ]) {
        await card(id).click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
        await expect(page.locator("#requestContent")).toContainText(label);
        await expect(page.locator("#requestContent")).toContainText(expectedReason);
        await expect(page.locator("#requestContent")).not.toContainText(/unsupported format|Request timed out|try again/i);
        await page.locator("#closeContextSidebar").click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    }
    await selectActivityOption(page, "promptAuthorFilter", ["user"]);
    await closeAnalyzeFilters(page);
    await expect(page.locator(".request-card-open")).toHaveCount(1);
    await expect(card(records[0].scenarioId)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 });
    await card(records[0].scenarioId).click();
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    await expect(page.locator("#requestContent")).toContainText(reason);
    assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
});
