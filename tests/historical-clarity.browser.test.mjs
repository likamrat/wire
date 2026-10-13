import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { startServer as startCandidateServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, openActivitySessions } from "./helpers.mjs";

const text = "Invented cost question: explain the USD number without submitting anything. " +
    "Keep this complete recorded request readable when only the failed call is shown. ".repeat(3) +
    "\n  Exact retained ending with spacing.  \nEND_OF_INVENTED_PROMPT";
const ready = page => page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
const startServer = process.env.WIRE_HISTORICAL_BASELINE
    ? (await import(pathToFileURL(path.join(process.env.WIRE_HISTORICAL_BASELINE, "lib", "server.mjs")))).startServer : startCandidateServer;

test("historical failure context exposes provenance and compact preview with complete owned reading", { timeout: 120000 }, async t => {
    const record = fixture("historical-reading");
    record.sourceSessionName = "Invented usage question";
    record.followUpPrompts = [];
    record.userPrompt = { text, status: "full", sourceEventId: "invented-prompt", sourceTimestamp: "2026-09-30T12:00:00.000Z",
        authorship: { actor: "unknown", basis: "system-source" } };
    const call = record.toolCalls[0];
    Object.assign(call, { tool: "workiq-retrieve", toolSucceeded: false, reportedOutcome: "failed",
        requestedApiPath: null, requestArgs: {}, apiResults: [], startedAt: "2026-09-30T12:00:01.000Z",
        completedAt: "2026-09-30T12:03:01.024Z", durationMs: 180024,
        failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "text-excluded", messageSignal: "request-timeout" } });
    record.toolCalls.push({ ...call, toolCallId: "invented-success-1", startEventId: "invented-start-2", toolSucceeded: true, reportedOutcome: "succeeded", failureEvidence: undefined },
        { ...call, toolCallId: "invented-success-2", startEventId: "invented-start-3", toolSucceeded: true, reportedOutcome: "succeeded", failureEvidence: undefined });
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce", hasTouch: true });
    const blocked = [], errors = [];
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(runtime.url).origin || url.pathname.startsWith("/api/") &&
            !["/api/snapshot", "/api/assessment/detail", "/api/assessment/overview", "/api/collection/status", "/api/session", "/api/evaluation/automatic/summary"].includes(url.pathname)) {
            blocked.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
        window.ownedCopies = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw Error("No real clipboard"); },
            async writeText(value) { window.ownedCopies.push(value); },
        } });
    });
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(blocked, []); assert.deepEqual(errors, []); });
    const proofs = process.env.WIRE_HISTORICAL_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    const metrics = [];
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.goto(runtime.url + "#activity?session=test-session&result=failure&range=capture"); await ready(page);
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const content = page.locator(".matched-action .full-text").first();
        assert.equal(await page.locator(".matched-action").count(), 1);
        assert.ok((await content.locator(".full-text-preview").textContent()).length < text.length);
        if (proofs) {
            await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
            await page.screenshot({ path: path.join(proofs, `context-${theme}-${width}-${scale}.png`), fullPage: true });
        }
        const toggle = content.locator(".full-text-toggle");
        await toggle.focus(); await page.keyboard.press("Enter");
        assert.equal(await content.locator("pre").textContent(), text);
        await content.getByRole("button", { name: "Copy prompt", exact: true }).click();
        assert.equal(await page.evaluate(() => window.ownedCopies.at(-1)), text);
        const geometry = await content.locator("pre").evaluate(node => ({
            characters: node.textContent.length, fullWidth: node.scrollWidth <= node.clientWidth + 1,
            fullHeight: node.scrollHeight <= node.clientHeight + 1,
            pageFits: document.documentElement.scrollWidth <= innerWidth + 1,
        }));
        assert.ok(geometry.fullWidth && geometry.fullHeight && geometry.pageFits, JSON.stringify({ theme, width, scale, geometry }));
        if (proofs) {
            await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
            await page.screenshot({ path: path.join(proofs, `expanded-${theme}-${width}-${scale}.png`), fullPage: true });
            const bounds = await page.locator(".matched-action").boundingBox();
            await page.screenshot({ path: path.join(proofs, `detail-${theme}-${width}-${scale}.png`), fullPage: true, clip: bounds });
        }
        metrics.push({ theme, width, scale, ...geometry });
        await toggle.focus(); await page.keyboard.press("Space");
        assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        assert.equal(await content.locator("pre").count(), 0);
        assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
    }
    if (proofs) await writeFile(path.join(proofs, "reading-metrics.json"), JSON.stringify(metrics, null, 2));
    const content = page.locator(".matched-action .full-text").first();
    assert.equal(await content.locator(".full-text-preview-state").count(), 0);
    assert.equal(await content.getByRole("button", { name: "Read more", exact: true }).count(), 1);
    const help = content.getByRole("button", { name: "About prompt author", exact: true });
    await help.focus(); await page.keyboard.press("Enter");
    assert.match(await page.getByRole("tooltip").innerText(), /system-supplied context/);
    assert.match(await page.getByRole("tooltip").innerText(), /not.*sign-in/i);
    assert.equal(await help.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
    assert.ok(await help.evaluate(node => node.getBoundingClientRect().width >= 44 && node.getBoundingClientRect().height >= 44));
    await page.keyboard.press("Escape");
    await content.locator(".full-text-toggle").click();
    const response = page.waitForResponse(value => value.url().endsWith("/api/snapshot"));
    await replaceEvidence(context, () => ({ records: [record, fixture("unrelated-new")], importCoverage: { roster: [], counts: {} } }));
    await page.evaluate(() => window.dispatchEvent(new Event("online"))); await response; await ready(page);
    assert.equal(await content.locator("pre").textContent(), text, "Read state survives unrelated snapshot");
    await content.getByRole("link", { name: "Open exact call in context", exact: true }).click(); await ready(page);
    assert.equal(await page.locator(".request-original .full-text-content").textContent(), text);
    assert.match(await page.locator("#requestContent .action-error").first().innerText(), /MCP request timeout/);
    assert.doesNotMatch(await page.locator("#requestContent .action-error").first().innerText(), /No HTTP status or downstream cause/);
    await page.goBack(); await ready(page);
    assert.equal(await content.locator("pre").textContent(), text, "Back preserves inline expansion");
    await page.goto(runtime.url + "#activity?range=capture"); await ready(page); await openActivitySessions(page);
    const row = page.locator(".request-row").filter({ hasText: "Invented cost question" });
    assert.equal(await row.getByRole("button", { name: "Read more", exact: true }).count(), 1);
    await row.locator(".full-text-toggle").click();
    const changed = structuredClone(record);
    changed.userPrompt = { ...changed.userPrompt, text: "Replaced invented prompt body", status: "full" };
    const next = page.waitForResponse(value => value.url().endsWith("/api/snapshot"));
    await replaceEvidence(context, () => ({ records: [changed], importCoverage: { roster: [], counts: {} } }));
    await page.evaluate(() => window.dispatchEvent(new Event("online"))); await next; await ready(page);
    assert.doesNotMatch(await page.locator("#activityList").innerText(), /END_OF_INVENTED_PROMPT/);
    assert.equal(await page.locator(".request-row .full-text-preview").textContent(), changed.userPrompt.text);
    assert.equal(await page.locator(".request-row .ux-copy,.request-row pre").count(), 0, "No stale expanded body or copy after scope evidence changes");
});
