import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const proofDir = process.env.WIRE_INTERACTION_ROW_PROOFS;
const phase = process.env.WIRE_INTERACTION_ROW_PHASE || "after";
function records() {
    return [
        ["short", "Find the latest notes for the Northline review.", "user"],
        ["second", "Check the calendar for the next design review.", "agent"],
        ["third", "List the files shared for Friday's workshop.", "user"],
        ["missing", "Find the documents referenced in the planning meeting.", "unknown"],
        ["long", "Compare the two recorded planning discussions. " + "Keep the original wording and explain which open questions still need an owner. ".repeat(14), "user"],
        ["multiple", "Find the proposal and check the related meeting before drafting a response.", "agent"],
    ].map(([id, text, actor], index) => {
        const row = fixture(`row-${id}`);
        row.sourceSessionId = `row-chat-${index % 2}`;
        row.sourceSessionName = index % 2 ? "Workshop preparation" : "Northline planning";
        row.project = "Invented Northline project";
        row.projectType = "folder";
        row.userPrompt = { text, status: "full", sourceEventId: `row-prompt-${id}`,
            sourceTimestamp: new Date(Date.UTC(2026, 9, 10, 16, 20 - index)).toISOString(),
            authorship: { actor, basis: actor === "unknown" ? "not-recorded" : `source-${actor}` } };
        row.followUpPrompts = [];
        row.toolCalls[0] = { ...row.toolCalls[0], startedAt: row.userPrompt.sourceTimestamp,
            completedAt: new Date(Date.parse(row.userPrompt.sourceTimestamp) + 1200).toISOString(), durationMs: 1200,
            requestArgs: { entityUrls: id === "missing" ? [] : [index % 2 ? "/me/events" : "/me/drive/root"] },
            requestedApiPath: id === "missing" ? undefined : index % 2 ? "/me/events" : "/me/drive/root" };
        if (id === "multiple") row.toolCalls.push({ ...structuredClone(row.toolCalls[0]),
            tool: "workiq-ask", toolCallId: "row-multiple-extra", startEventId: "row-multiple-extra-start",
            requestArgs: { question: "Find the invented proposal" }, requestedApiPath: undefined,
            toolSucceeded: false, reportedOutcome: "failed", apiResults: [{ index: 0, statusCode: 503 }] });
        return row;
    });
}
async function setup(t) {
    const cleanup = [], evidence = records();
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, evidence);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw new Error("Provider calls forbidden"); },
            readSource: async () => { throw new Error("Source rereads forbidden"); } } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(6000);
    const errors = [], denied = [];
    const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/evaluation/automatic/summary", "/api/report-artifacts/list"];
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
        window.rowCopies = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw new Error("Real clipboard reads forbidden"); },
            async writeText(text) { window.rowCopies.push(text); },
        } });
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url); await ready(page); await page.evaluate(() => document.fonts.ready);
    return { page, evidence };
}
async function capture(page, name) {
    if (!proofDir) return;
    await mkdir(proofDir, { recursive: true });
    await frames(page);
    await page.screenshot({ path: path.join(proofDir, `${phase}-${name}.png`) });
    await writeFile(path.join(proofDir, `${phase}-${name}.txt`), await page.locator("#activityView").ariaSnapshot());
}
const card = (page, id) => page.locator(`#activityList>.request-row[data-view-key="request:row-${id}"]`);
async function geometry(page) {
    return page.locator("#activityList>.request-row").evaluateAll(nodes => nodes.map(row => {
        const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
        const timestamp = [...row.querySelectorAll(".activity-card-facts>div")].find(node => node.querySelector("dt").textContent === "Message recorded:").querySelector("dd");
        return { key: row.dataset.viewKey, row: box(row), text: box(row.querySelector(".full-text")),
            open: box(row.querySelector(".request-link")), source: box(row.querySelector(".card-chat")),
            project: box(row.querySelector(".project-context")), timestamp: box(timestamp),
            meta: box(row.querySelector(".request-meta")), tools: box(row.querySelector(".interaction-tools")),
            results: box(row.querySelector(".recorded-results")),
            factFonts: [".interaction-tools", ".request-meta", ".card-outcomes"].map(selector => getComputedStyle(row.querySelector(selector)).fontSize),
            provenanceFonts: [row.querySelector(".project-context"), timestamp].map(node => getComputedStyle(node).fontSize),
            promptFont: getComputedStyle(row.querySelector(".full-text-preview")).fontSize };
    }));
}

test("interaction rows group prompt/open and call facts without losing evidence, actions or selection", { timeout: 30000 }, async t => {
    const { page, evidence } = await setup(t);
    await page.locator("#resultsLink").click(); await frames(page);
    const before = await geometry(page);
    await capture(page, "desktop-light");
    await chooseTheme(page, "dark");
    await page.locator("#resultsLink").click();
    await capture(page, "desktop-dark");
    for (const [id, text] of [["short", evidence[0].userPrompt.text], ["missing", evidence[3].userPrompt.text]]) {
        await expect(card(page, id).locator(".full-text-preview")).toHaveText(text);
        await expect(card(page, id)).toContainText("workiq-fetch");
        await expect(card(page, id).locator("dt")).toContainText(["Message recorded"]);
    }
    await expect(card(page, "missing").locator(".full-text-preview-label")).toHaveText("Prompt");
    await expect(card(page, "missing").locator(".full-text-preview-label")).toHaveAttribute("data-prompt-actor", "unknown");
    await expect(card(page, "missing")).toContainText("Service not shown");
    assert.deepEqual((await card(page, "multiple").locator(".card-tool-name").allTextContents()).sort(), ["workiq-ask", "workiq-fetch"]);
    await expect(card(page, "multiple").locator('[data-outcome="success"]')).toHaveAttribute("data-count", "1");
    await expect(card(page, "multiple").locator('[data-outcome="failure"]')).toHaveAttribute("data-count", "1");
    await expect(card(page, "multiple").locator(".result-unit,.card-result-scope")).toHaveCount(0);
    const long = card(page, "long");
    await card(page, "missing").evaluate(node => node.scrollIntoView({ block: "start" }));
    await capture(page, "long-and-multiple");
    await chooseTheme(page, "light");
    await card(page, "missing").evaluate(node => node.scrollIntoView({ block: "start" }));
    await capture(page, "long-and-multiple-light");
    await long.locator(".full-text-toggle").click();
    await expect(long.locator(".full-text-body pre")).toHaveText(evidence[4].userPrompt.text);
    await long.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.rowCopies), [evidence[4].userPrompt.text]);
    await capture(page, "long-expanded");
    await long.locator(".full-text-toggle").click();
    const missingHelp = card(page, "missing").getByRole("button", { name: /About .*author/i });
    await missingHelp.focus();
    await expect(page.getByRole("tooltip")).toContainText("Author unverified");
    await page.keyboard.press("Escape");
    const serviceHelp = card(page, "short").getByRole("button", { name: /About Files/ });
    await serviceHelp.focus();
    await expect(page.getByRole("tooltip")).toContainText("Files");
    await page.keyboard.press("Escape");
    await card(page, "short").locator("input").check();
    await selectActivityOption(page, "promptAuthorFilter", "agent"); await ready(page);
    await expect(card(page, "short")).toHaveCount(0);
    await expect(page.locator("#activitySelectionCompact")).toContainText("1 in report");
    await selectActivityOption(page, "promptAuthorFilter", "all"); await ready(page);
    await expect(card(page, "short").locator("input")).toBeChecked();
    await card(page, "short").locator(".card-chat a").click(); await ready(page);
    await expect(page.locator("#activityList>.request-row")).toHaveCount(3);
    await page.goBack(); await ready(page);
    await expect(page.locator("#activityList>.request-row")).toHaveCount(6);
    const open = card(page, "short").locator(".request-link");
    await open.focus(); await frames(page);
    const savedY = (await open.boundingBox()).y;
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:row-short");
    await page.goBack(); await ready(page); await frames(page);
    await expect(open).toBeFocused();
    assert.ok(Math.abs((await open.boundingBox()).y - savedY) < 3);
    if (proofDir) await writeFile(path.join(proofDir, `${phase}-geometry.json`), JSON.stringify(before, null, 2));
    const short = before[0];
    assert.ok(short.open.y < short.text.y + 8, "Open belongs beside the prompt, not on an extra row below it");
    assert.ok(short.tools.y < short.meta.y, "Tools have their own list before separate category metadata");
    assert.ok(short.results.y >= short.meta.bottom, "Matching outcomes stay with their tool/activity summary");
    assert.equal(new Set(short.factFonts).size, 1, "Tool, service and call count use one text size");
    assert.equal(new Set(short.provenanceFonts).size, 1, "Project and recorded time share one metadata size");
    assert.ok(short.timestamp.y >= short.project.bottom, "Project and time have distinct stacked key/value rows");
    assert.ok(short.project.y > short.source.y, "Source action leads its project/time metadata");
});

test("narrow enlarged rows retain full labels, touch targets and keyboard reading", { timeout: 20000 }, async t => {
    const { page, evidence } = await setup(t);
    await page.setViewportSize({ width: 375, height: 900 }); await chooseTheme(page, "dark");
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.locator("#resultsLink").click(); await frames(page);
    await capture(page, "narrow-200-results");
    const long = card(page, "long");
    await long.locator(".full-text-toggle").focus(); await page.keyboard.press("Enter");
    await expect(long.locator(".full-text-body pre")).toHaveText(evidence[4].userPrompt.text);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await long.locator(".full-text-toggle").focus(); await page.keyboard.press("Enter");
    const short = card(page, "short");
    await short.locator("input").focus();
    await page.keyboard.press("Space");
    await expect(short.locator("input")).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(short.locator(".request-link")).toBeFocused();
    for (const target of [short.locator(".interaction-select"), short.locator(".request-link"), short.locator(".card-chat a")]) {
        const box = await target.boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44);
    }
    await capture(page, "narrow-200-row");
    const savedY = (await short.locator(".request-link").boundingBox()).y;
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:row-short");
    await page.goBack(); await ready(page); await frames(page);
    await expect(short.locator(".request-link")).toBeFocused();
    assert.ok(Math.abs((await short.locator(".request-link").boundingBox()).y - savedY) < 3);
    await short.locator(".request-meta").evaluate(node => node.scrollIntoView({ block: "start" }));
    await capture(page, "narrow-200-evidence");
    await card(page, "missing").locator(".full-text-preview-label").evaluate(node => node.scrollIntoView({ block: "start" }));
    await capture(page, "narrow-200-missing");
    await card(page, "multiple").locator(".interaction-tools").evaluate(node => node.scrollIntoView({ block: "start" }));
    await capture(page, "narrow-200-multiple");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
});
