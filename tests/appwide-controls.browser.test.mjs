import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixture, chooseTheme, navigateSettings, closeAnalyzeFilters } from "./helpers.mjs";
import { searchFixture } from "./live-search-fixture.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { renderAccountSettingsFixture } from "./account-settings-presentation-fixture.mjs";
import { contrast } from "./color-measurements.mjs";

const proofDir = process.env.WIRE_VISUAL_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
async function capture(page, name) {
    if (!proofDir) return;
    await mkdir(proofDir, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(proofDir, name + ".png"), fullPage: name === "reports" });
}
function records() {
    return [
        "Find the launch checklist and the owner of the support handoff.",
        "Summarize the calendar changes for the design review.",
        "Find the latest approval in the launch planning thread.",
        "Open the architecture notes about regional failover.",
        "Compare the agenda with the release meeting notes.",
        "List unresolved questions from the rollout review.",
        "Find the support plan for the next release.",
        "Read the notes from the service review.",
    ].map((text, index) => {
        const row = fixture("appwide-" + index);
        row.capturedAt = new Date(Date.now() - index * 86400000).toISOString();
        row.sourceSessionId = "visual-chat-" + index;
        row.sourceSessionName = ["Launch preparation", "Design review", "Rollout planning", "Architecture notes"][index % 4];
        row.project = "Atlas"; row.projectId = "visual-atlas"; row.followUpPrompts = [];
        row.userPrompt = { text, status: "full", sourceTimestamp: row.capturedAt, sourceEventId: "visual-prompt-" + index,
            ...(index === 7 ? {} : { authorship: { actor: index % 3 ? "user" : "agent", basis: index % 3 ? "source-user" : "source-agent" } }) };
        row.toolCalls = Array.from({ length: index < 2 ? 2 : 1 }, (_, call) => ({
            ...row.toolCalls[0], toolCallId: `visual-call-${index}-${call}`, startEventId: `visual-start-${index}-${call}`,
            completionEventId: `visual-end-${index}-${call}`, startedAt: row.capturedAt,
            durationMs: 180 + index * 30, completedAt: new Date(Date.parse(row.capturedAt) + 180 + index * 30).toISOString(),
            requestArgs: { entityUrls: [["/me/messages", "/me/calendarView", "/me/drive/root"][index % 3]] },
            requestedApiPath: ["/me/messages", "/me/calendarView", "/me/drive/root"][index % 3],
            toolSucceeded: index === 7 ? null : index !== 0, reportedOutcome: index === 7 ? "unknown" : index === 0 ? "failed" : "succeeded",
            apiResults: index === 7 ? [] : [{ index: 0, statusCode: index === 0 ? 503 : 200 }],
        }));
        return row;
    });
}

test("shared control roles preserve app journeys, full targets and frozen saved bytes", { timeout: 120000 }, async t => {
    const app = await searchFixture(t, { records: records(), reply: false });
    const originalFiles = new Map();
    const titles = ["Rollout activity", "Release notes", "My planning requests", "Weekly activity", "Agent handoff", "Review notes", "Mailbox calls"];
    for (const [index, title] of titles.entries()) {
        const state = await loadBoardState(app.context), owner = "visual-saved-" + index;
        const preview = await app.exports.preview(owner, undefined, {
            title, promptMode: "masked", formats: index === titles.length - 1 ? ["html", "json", "pdf"] : ["html", "json"],
            dateSelection: { range: "custom", from: new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
            reportFocus: { version: 1, preset: "all", outcome: "all", services: [] },
        }, { kind: "all", revision: state.revision });
        await app.exports.review(owner, preview.previewId, true);
        const { bundle } = await app.exports.confirm(owner, preview.previewId, true);
        for (const file of Object.values(bundle.files)) originalFiles.set(file, await readFile(file));
    }
    const before = await loadBoardState(app.context);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: "UTC" });
    page.setDefaultTimeout(10000);
    const errors = [], writes = [], outside = [], snapshots = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const url = new URL(request.url());
        if (url.origin !== new URL(app.runtime.url).origin && !["blob:", "data:"].includes(url.protocol)) outside.push(request.url());
        if (/\/api\/(?:export|delete|access\/command|collection\/now)$/.test(url.pathname)) writes.push(url.pathname);
        if (url.pathname === "/api/snapshot") snapshots.push(url.pathname);
    });
    await page.goto(app.runtime.url + "#analyze"); await ready(page);
    await expect(page.locator("#activityListSummary")).toContainText("8 interactions with 10 matching Work IQ tool calls");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.waitForFunction(() => document.getAnimations().every(animation =>
            animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity));
        const nav = await page.locator('nav [data-nav=reports]').evaluate(node => ({
            icon: node.querySelector("svg").getBoundingClientRect().width, target: node.getBoundingClientRect().height,
            ink: getComputedStyle(node).color, paper: getComputedStyle(document.documentElement).getPropertyValue("--navigation-paper").trim(),
        }));
        assert.equal(nav.icon, 18); assert.ok(nav.target >= 44);
        assert.ok(contrast(nav.ink, nav.paper) >= 4.5, JSON.stringify({ theme, ...nav }));
        assert.equal(await page.locator(".analyze-chart-main").evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
        await capture(page, "analyze-" + theme);
    }
    const reads = snapshots.length, beforeWidth = (await page.locator("#main").boundingBox()).width;
    await page.locator("#navigationCollapse").click();
    await page.waitForFunction(() => !document.getElementById("sidebar").hasAttribute("data-navigation-moving"));
    assert.equal((await page.locator("#sidebar").boundingBox()).width, 65);
    assert.equal((await page.locator("#main").boundingBox()).width - beforeWidth, 151);
    assert.equal(snapshots.length, reads);
    await page.locator("#navigationCollapse").click(); await page.waitForTimeout(60); await page.locator("#navigationCollapse").click();
    await page.waitForFunction(() => !document.getElementById("sidebar").hasAttribute("data-navigation-moving"));
    await expect(page.locator("#navigationCollapse")).toHaveAttribute("aria-expanded", "false");
    await page.locator("#navigationCollapse").focus(); await page.keyboard.press("Tab");
    assert.equal(await page.locator('nav [data-nav=analyze]').evaluate(node => node.matches(":focus-visible")), true);
    await page.keyboard.press("Escape");
    await page.locator("#navigationCollapse").click(); await page.waitForTimeout(350);
    await page.locator("#openAnalyzeFilters").click(); await page.locator("#outcomeFilter-control").click();
    const acceptedOutcomes = await page.locator("#outcomeFilter").evaluate(node => [...node.selectedOptions].map(option => option.value));
    const draftReads = snapshots.length;
    await page.locator(".select-popup .select-option").first().click();
    assert.equal(snapshots.length, draftReads, "Analyze multi-select changes stay draft until Apply");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(await page.locator("#outcomeFilter").evaluate(node => [...node.selectedOptions].map(option => option.value)), acceptedOutcomes);
    await page.locator("#outcomeFilter-control").press("ArrowDown");
    const focusedOption = page.locator(".select-popup .select-option[data-active=true]");
    assert.equal(await focusedOption.evaluate(node => getComputedStyle(node).outlineWidth), "2px");
    await page.keyboard.press("Escape"); await closeAnalyzeFilters(page);
    await page.locator("#activityList .request-card-open").first().click();
    await expect(page.locator("#contextSidebar")).toBeVisible(); await capture(page, "interaction");
    await page.getByRole("button", { name: "Close interaction", exact: true }).click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await page.locator("#wireSearch").fill("launch");
    await expect(page.locator(".wire-search-hit").first()).toBeVisible();
    await page.locator(".wire-search-hit").first().hover(); await capture(page, "search");
    await page.locator("#wireSearchClear").click();
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await page.locator("#openAnalyzeFilters").click(); await page.locator("#comparisonServices-control").click();
    await expect(page.locator(".select-footer:visible .select-apply")).toHaveCount(0);
    await expect(page.locator(".select-draft-hint:visible")).toHaveCount(0);
    await page.locator('.select-popup [data-value="Mail"]').click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await closeAnalyzeFilters(page); await capture(page, "compare");
    await page.locator('nav [data-nav=reports]').click(); await ready(page);
    await capture(page, "reports");
    const jump = page.locator(".library-page-jump"), input = jump.locator("input"), go = jump.getByRole("button", { name: "Go to page", exact: true });
    await expect(go).toHaveText("Go to page");
    for (const [width, scale] of [[1440, 1], [390, 1], [1440, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = scale * 100 + "%", scale);
        const geometry = await jump.evaluate(node => {
            const input = node.querySelector("input"), button = node.querySelector("button");
            const box = input.getBoundingClientRect(), action = button.getBoundingClientRect();
            return { width: box.width, height: box.height, actionHeight: action.height,
                faceInset: parseFloat(getComputedStyle(input.parentElement, "::before").top),
                actionInset: parseFloat(getComputedStyle(button, "::before").top), overflow: document.documentElement.scrollWidth - innerWidth };
        });
        assert.ok(geometry.width >= 44 && geometry.height >= 44);
        assert.equal(geometry.height, geometry.actionHeight);
        assert.equal(geometry.faceInset, geometry.actionInset);
        assert.equal(geometry.overflow, 0);
        await input.fill("2"); await go.click(); await expect(input).toHaveValue("2");
        await input.fill("1"); await input.press("Enter"); await expect(input).toHaveValue("1");
        await input.fill("3"); assert.equal(await input.evaluate(node => node.checkValidity()), false); await input.fill("1");
        await capture(page, `pager-${width}-${scale}`);
    }
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    await page.getByRole("button", { name: "View report: Mailbox calls", exact: true }).click();
    await expect(page.locator("#savedReportReader iframe")).toBeVisible();
    await page.locator("#savedReaderFormat-control").click();
    await page.locator('.select-popup [data-value="pdf"]').click();
    await expect(page.getByLabel("PDF page", { exact: true })).toBeVisible();
    assert.ok((await page.getByLabel("PDF page", { exact: true }).boundingBox()).width >= 44);
    await capture(page, "saved-pdf");
    await page.locator('nav [data-nav=settings]').click(); await navigateSettings(page, "display");
    await capture(page, "settings");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator('#settingsView .select-trigger:visible').first().click();
    assert.equal(await page.locator(".select-popup").evaluate(node => getComputedStyle(node).animationName), "none");
    await page.keyboard.press("Escape");
    await page.emulateMedia({ forcedColors: "active" });
    await page.locator('nav [data-nav=reports]').click(); await ready(page);
    await page.locator(".library-page-jump input").focus();
    assert.equal(await page.locator(".library-page-jump .number-field").evaluate(node => getComputedStyle(node, "::before").outlineWidth), "2px");
    assert.equal(await page.locator('nav [data-nav=reports]').evaluate(node => getComputedStyle(node).backgroundImage), "none");
    await page.locator("#savedReportOrder-control").click();
    assert.equal(await page.locator("#savedReportOrder-control").evaluate(node => getComputedStyle(node, "::before").backgroundImage), "none");
    await page.keyboard.press("Escape");
    const after = await loadBoardState(app.context);
    for (const key of ["evidence", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key]);
    for (const [file, bytes] of originalFiles) assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual(errors, []); assert.deepEqual(outside, []); assert.deepEqual(writes, []);
});

test("account, Settings and narrow navigation retain their real owners and full targets", { timeout: 30000 }, async t => {
    const server = createServer((request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(renderAccountSettingsFixture());
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("#wireAccountTrigger").click();
    await expect(page.getByRole("menu", { name: "WIRE account" })).toBeVisible();
    await capture(page, "account");
    await page.keyboard.press("Escape");
    await expect(page.locator("#wireAccountTrigger")).toBeFocused();
    await page.locator("#navigationCollapse").click(); await page.waitForTimeout(350);
    await expect(page.locator("#wireAccountTrigger")).toBeVisible();
    assert.ok((await page.locator("#wireAccountTrigger").boundingBox()).width >= 44);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#navigationToggle").click(); await page.waitForTimeout(350);
    await expect(page.locator('#navigationDrawer [data-nav=settings]')).toBeVisible();
    await expect(page.locator("#wireAccountTrigger")).toBeVisible();
    await capture(page, "navigation-narrow");
    await page.keyboard.press("Escape"); await page.waitForTimeout(350);
    await expect(page.locator("#navigationToggle")).toBeFocused();
    assert.deepEqual(await page.evaluate(() => window.fixtureWrites), []);
});
