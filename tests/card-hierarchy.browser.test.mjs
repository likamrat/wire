import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { promptRecord } from "../lib/prompt-authorship.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";

const proofs = process.env.WIRE_CARD_HIERARCHY_PROOFS;
const baseline = process.env.WIRE_CARD_HIERARCHY_BASELINE;
const serve = baseline ? (await import(pathToFileURL(path.join(baseline, "lib", "server.mjs")))).startServer : startServer;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const longTool = "workiq-call_function";
const longPrompt = "Find every Harbor launch planning document, then check the meeting and email. " +
    "Keep the original text, including this italic glyph sample: fjgy. ".repeat(22) + "\n  End of exact retained prompt.  ";

function records() {
    return [
        ["retry", "Three documents are enough. I have signed in; please try again.", "user"],
        ["multiple", "Find the launch documents, check tomorrow's calendar and look for the handover email.", "agent-helper"],
        ["archive", "Find the previous launch checklist.", undefined],
        ["long", longPrompt, "user"],
        ["missing", "Read the launch notes if available.", undefined],
        ["empty", "No tool evidence was saved for this prompt.", "user"],
        ["unnamed", "A retained call has no recorded tool name.", "user"],
    ].map(([id, text, source], index) => {
        const record = fixture(`hierarchy-${id}`);
        record.sourceSessionId = `harbor-${id}`;
        record.sourceSessionName = `Sample: ${id === "archive" ? "Older checklist lookup" : "Harbor launch " + id}`;
        record.project = "Sample workspace: Harbor launch";
        record.userPrompt = promptRecord({ type: "user.message", id: `prompt-${id}`, timestamp: `2026-10-10T09:3${9 - index}:00Z`,
            data: { content: text, ...(source ? { source } : {}) } });
        record.followUpPrompts = [];
        const base = record.toolCalls[0];
        const names = id === "multiple" ? ["workiq-fetch", "workiq-fetch", "workiq-ask"] : [id === "long" ? longTool : "workiq-fetch"];
        record.toolCalls = names.map((tool, i) => ({
            ...base, tool, toolCallId: `${id}-${i}`, startEventId: `start-${id}-${i}`,
            startedAt: `2026-10-10T09:3${9 - index}:01Z`, durationMs: i ? 1200 : 1800,
            requestArgs: { entityUrls: [i === 2 ? "/me/messages" : i === 1 ? "/me/events" : id === "long" ? "/me/drive/" + "long-path/".repeat(20) : "/me/drive/root/children"] },
            requestedApiPath: null, apiResults: [],
            toolSucceeded: i === 1 ? false : id === "missing" ? null : true,
            reportedOutcome: i === 1 ? "failed" : id === "missing" ? "unknown" : "succeeded",
        }));
        if (id === "long") {
            record.sourceSessionName += " " + "Very long recorded chat name ".repeat(10);
            record.project += " " + "Long project name ".repeat(10);
        }
        if (id === "missing") {
            record.sourceSessionName = null; record.projectId = null; record.project = null;
            record.userPrompt.sourceTimestamp = null;
            record.toolCalls[0] = { tool: "workiq-fetch", toolCallId: "missing-0", startEventId: "start-missing-0", requestArgs: {}, apiResults: [] };
        }
        if (id === "empty") record.toolCalls = [];
        if (id === "unnamed") record.toolCalls[0].tool = null;
        return record;
    });
}

async function setup(t) {
    const cleanup = [], data = records(), { context, root } = await privateFixture({ after: fn => cleanup.push(fn) }, data);
    const before = await loadBoardState(context);
    let providers = 0;
    const runtime = await serve(context, createExportController(context), {
        port: 0, collector: { timers: false }, search: { modelDirectory: path.join(root, "not-provisioned") },
        evaluation: { evaluatorFactory: async () => { providers++; throw Error("No model work in card hierarchy proof."); },
            readSource: async () => { providers++; throw Error("No source reads in card hierarchy proof."); } },
    });
    const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
    const contextBrowser = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
    const page = await contextBrowser.newPage(), denied = [], errors = [];
    let snapshot;
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/evaluation/automatic/summary", "/api/report-artifacts/list"];
    await contextBrowser.route("**/*", route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== new URL(runtime.url).origin || req.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    contextBrowser.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    await contextBrowser.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No real clipboard access."); }, async writeText(text) { window.copiedHierarchyText = text; },
    } }));
    page.setDefaultTimeout(6000);
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(denied, []); assert.deepEqual(errors, []); assert.equal(providers, 0);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const fn of cleanup) await fn(); }
    });
    await page.goto(runtime.url); await ready(page); await page.evaluate(() => document.fonts.ready);
    return { page, data, snapshot: () => snapshot };
}

async function shot(page, name, card) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await card.evaluate(node => scrollBy(0, node.getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().height - 12));
    await frames(page);
    await page.screenshot({ path: path.join(proofs, `${name}-viewport.png`) });
    await page.evaluate(() => scrollTo(0, 0)); await frames(page);
    await page.screenshot({ path: path.join(proofs, `${name}-page.png`), fullPage: true });
    await writeFile(path.join(proofs, `${name}.txt`), await page.locator("#activityView").ariaSnapshot());
}
const interaction = (page, id) => page.locator(`.request-row[data-view-key="request:hierarchy-${id}"]`);
const callCard = (page, id) => page.locator(".matched-action").filter({ has: page.locator(`.request-link[href*="hierarchy-${id}"]`) }).first();

test("Interactions and Calls share emphasized prompts, stacked facts and distinct tools", async t => {
    const { page } = await setup(t), measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        for (const mode of ["interactions", "calls"]) {
            await page.locator(`[data-analyze-mode="${mode}"]`).click(); await ready(page);
            const card = mode === "interactions" ? interaction(page, "multiple") : callCard(page, "multiple");
            await shot(page, `${mode}-${theme}-${width}`, card);
            measurements.push(await card.evaluate((node, context) => ({
                ...context,
                prompts: [...node.querySelectorAll(".full-text-preview")].map(p => ({ text: p.textContent, weight: getComputedStyle(p).fontWeight, style: getComputedStyle(p).fontStyle })),
                facts: [...node.querySelectorAll(".activity-card-facts > div")].map(row => ({
                    label: row.querySelector("dt")?.textContent, value: row.querySelector("dd")?.textContent,
                    labelWeight: getComputedStyle(row.querySelector("dt")).fontWeight,
                    valueWeight: getComputedStyle(row.querySelector("dd")).fontWeight,
                    textWeights: [...row.querySelectorAll("dd,dd *")].filter(node => !node.closest(".card-tool-name")
                        && [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim()))
                        .map(node => ({ text: node.textContent, weight: getComputedStyle(node).fontWeight })),
                    top: row.getBoundingClientRect().top, bottom: row.getBoundingClientRect().bottom,
                    labelCount: row.querySelectorAll(":scope>dt").length, valueCount: row.querySelectorAll(":scope>dd").length,
                })),
            }), { mode, theme, width }));
        }
    }
    if (proofs) await writeFile(path.join(proofs, "hierarchy-measurements.json"), JSON.stringify(measurements, null, 2));
    for (const row of measurements) {
        assert.ok(row.prompts.every(p => Number(p.weight) >= 700 && p.style === "italic"), `${row.mode}: actual prompt is bold and italic`);
        assert.ok(row.facts.length >= 4, `${row.mode}: categories are semantic key/value rows`);
        assert.ok(row.facts.every(fact => fact.label && fact.value && Number(fact.labelWeight) >= 700
            && fact.valueWeight === "400" && fact.labelCount === 1 && fact.valueCount === 1));
        assert.deepEqual(row.facts.flatMap(fact => fact.textWeights).filter(text => text.weight !== "400"), [],
            `${row.mode}: actual metadata values, not just their containers, have normal weight`);
        assert.ok(row.facts.every((fact, index) => !index || fact.top >= row.facts[index - 1].bottom),
            `${row.mode}: one category follows another without overlap`);
    }
});

const fact = (card, label) => card.locator(".activity-card-facts>div").filter({ has: card.page().locator("dt").filter({ hasText: new RegExp(`^${label}$`) }) });

async function pointAt(page, target) {
    await target.evaluate(node => scrollBy(0, node.getBoundingClientRect().top - innerHeight / 2));
    await frames(page);
    const box = await target.boundingBox(), point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    assert.ok(await target.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), point), "Pointer reaches actual target");
    return { ...point, top: box.y };
}

test("scoped tool lists retain individual names and counts without assigning aggregate outcomes", async t => {
    const { page, snapshot } = await setup(t);
    const canonicalIds = [0, 1, 2].map(index => `call:["harbor-multiple","multiple-${index}"]`);
    assert.deepEqual(snapshot().analytics.rows.filter(row => row.scenarioId === "hierarchy-multiple").map(row => row.id).sort(), canonicalIds);
    const multi = interaction(page, "multiple");
    await expect(multi.locator(".card-tool-name")).toHaveText(["workiq-fetch", "workiq-ask"]);
    await expect(multi.locator(".card-tool-count")).toHaveText(["2 calls", "1 call"]);
    await expect(multi.locator(".interaction-tools [data-outcome]")).toHaveCount(0);
    await expect(multi.locator("[data-outcome=failure]")).toHaveAttribute("data-count", "1");
    await expect(fact(multi, "Matching results")).toContainText("3 of 3 Work IQ tool calls match this view");
    const selection = multi.locator(".interaction-select");
    const check = await pointAt(page, selection); await page.mouse.click(check.x, check.y);
    await expect(multi.locator("input")).toBeChecked();
    await selectActivityOption(page, "toolFilter", "workiq-ask"); await ready(page);
    await expect(multi.locator(".card-tool-name")).toHaveText(["workiq-ask"]);
    await expect(multi.locator(".card-tool-count")).toHaveText(["1 call"]);
    await expect(fact(multi, "Tools in this view")).toBeVisible();
    await expect(fact(multi, "Matching results")).toContainText("1 of 3 Work IQ tool calls matches this view");
    await expect(multi.locator("[data-outcome=failure]")).toHaveCount(0);
    assert.deepEqual(snapshot().analytics.rows.map(row => row.id), [canonicalIds[2]]);
    assert.deepEqual(snapshot().requestActivity.tool.filter(row => row.scenarioId === "hierarchy-multiple").map(row => row.id).sort(), canonicalIds);
    await chooseTheme(page, "light");
    await shot(page, "interactions-filtered-multiple-light-1440", multi);
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    const call = callCard(page, "multiple");
    await expect(call.locator(".card-tool-name")).toHaveText("workiq-ask");
    await expect(page.locator("#activityList .matched-action")).toHaveCount(1);
    await expect(call).toHaveAttribute("data-action-id", canonicalIds[2]);
    await expect(fact(call, "Activity category")).toHaveText("Activity categoryMail");
    await expect(fact(call, "Tool completion").locator("[data-outcome=success]")).toHaveAttribute("data-count", "1");
    await shot(page, "calls-filtered-multiple-light-1440", call);
    const open = call.locator(".request-link"), point = await pointAt(page, open), url = page.url();
    await page.mouse.click(point.x, point.y); await ready(page);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-tool-call-id", "multiple-2");
    await expect(page.locator("#requestContent")).toContainText("Outside current view");
    await page.locator("#contextBack").click(); await ready(page); await frames(page);
    assert.equal(page.url(), url); await expect(open).toBeFocused();
    assert.ok(Math.abs((await open.boundingBox()).y - point.top) < 3, "Back returns native pointer entry position");
    await page.locator('[data-analyze-mode="interactions"]').click(); await ready(page);
    await expect(multi.locator("input")).toBeChecked();
    await selectActivityOption(page, "toolFilter", "all"); await ready(page);
    const chat = fact(multi, "Copilot chat").getByRole("link");
    await expect(chat).toHaveAccessibleName("Filter to chat: Sample: Harbor launch multiple");
    await chat.focus(); const original = page.url(); await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator(".request-row")).toHaveCount(1);
    await page.goBack(); await ready(page); await expect(chat).toBeFocused();
    assert.equal(page.url(), original); await expect(multi.locator("input")).toBeChecked();
    const opened = page.context().waitForEvent("page");
    const href = await chat.getAttribute("href");
    await chat.click({ modifiers: ["Control"] });
    const popup = await opened;
    try {
        await popup.waitForLoadState(); await ready(popup);
        assert.equal(new URL(popup.url()).hash, href); assert.equal(page.url(), original);
    } finally { await popup.close(); }
    await selectActivityOption(page, "toolFilter", "workiq-ask"); await ready(page);
    await chooseTheme(page, "dark");
    await page.setViewportSize({ width: 375, height: 1000 });
    await shot(page, "interactions-filtered-multiple-dark-375", multi);
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    await expect(call).toHaveAttribute("data-action-id", canonicalIds[2]);
    await shot(page, "calls-filtered-multiple-dark-375", call);
});

test("bold italic original reading, missing values and long metadata stay accessible without changing other readers", async t => {
    const { page, data } = await setup(t);
    await expect(interaction(page, "empty")).toHaveCount(0);
    await expect(interaction(page, "unnamed")).toHaveCount(0);
    await expect(fact(interaction(page, "missing"), "Request time")).toContainText("Not recorded");
    await expect(fact(interaction(page, "missing"), "Copilot project")).toContainText("No project associated");
    await expect(interaction(page, "missing").locator("[data-outcome=unknown]")).toHaveAttribute("data-count", "1");
    await expect(interaction(page, "archive")).toContainText("Who sent this was not recorded");
    const measurements = [];
    for (const [width, scale] of [[1440, 1], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        for (const mode of ["interactions", "calls"]) {
            await page.locator(`[data-analyze-mode="${mode}"]`).click(); await ready(page);
            if (mode === "calls") await expect(callCard(page, "unnamed")).toHaveCount(0);
            const missing = mode === "interactions" ? interaction(page, "missing") : callCard(page, "missing");
            await expect(fact(missing, "Copilot chat")).toContainText("Copilot chat name not recorded");
            await expect(fact(missing, "Copilot project")).toContainText("No project associated");
            await expect(fact(missing, "Request time")).toContainText("Not recorded");
            await expect(missing.locator("[data-outcome=unknown]")).toHaveAttribute("data-count", "1");
            if (mode === "calls") {
                await expect(fact(missing, "Call duration")).toContainText("Duration unavailable");
                await expect(fact(missing, "API path")).toContainText("Not recorded");
            }
            for (const id of ["retry", "multiple", "archive"]) {
                const card = mode === "interactions" ? interaction(page, id) : callCard(page, id);
                assert.deepEqual(await card.locator(".full-text-preview").evaluate(node => ({
                    weight: getComputedStyle(node).fontWeight, style: getComputedStyle(node).fontStyle,
                })), { weight: "700", style: "italic" });
            }
            const card = mode === "interactions" ? interaction(page, "long") : callCard(page, "long");
            await expect(card.locator(".card-tool-name")).toHaveText(longTool);
            await card.locator(".full-text-toggle").click();
            const full = card.locator(".full-text-body pre");
            assert.equal(await full.textContent(), data.find(record => record.scenarioId === "hierarchy-long").userPrompt.text);
            const shape = await full.evaluate(node => {
                const css = getComputedStyle(node), rect = node.getBoundingClientRect(), range = document.createRange();
                const outside = [];
                for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(node.textContent)) {
                    if (!part.segment.trim()) continue;
                    range.setStart(node.firstChild, part.index); range.setEnd(node.firstChild, part.index + part.segment.length);
                    if ([...range.getClientRects()].some(box => box.left < rect.left - 1 || box.right > rect.right + 1 || box.bottom > rect.bottom + 1)) outside.push(part.index);
                }
                return { weight: css.fontWeight, style: css.fontStyle, overflow: css.overflow, maxHeight: css.maxHeight,
                    width: node.clientWidth, scrollWidth: node.scrollWidth,
                    outside,
                    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
            });
            assert.equal(shape.weight, "700"); assert.equal(shape.style, "italic"); assert.equal(shape.overflow, "visible");
            assert.equal(shape.maxHeight, "none"); assert.deepEqual(shape.outside, [], JSON.stringify({ width, scale, mode, shape })); assert.ok(shape.pageOverflow <= 1);
            measurements.push({ viewportWidth: width, rootTextScale: scale, mode, ...shape });
            await card.getByRole("button", { name: "Copy prompt", exact: true }).click();
            assert.equal(await page.evaluate(() => window.copiedHierarchyText), longPrompt);
            await shot(page, `${mode}-long-${width}-${scale}`, card);
            await card.locator(".full-text-toggle").click();
            assert.deepEqual(await card.locator(".activity-card-facts dt,.activity-card-facts dd").evaluateAll(nodes =>
                nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent)), []);
        }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await callCard(page, "long").locator(".request-link").click(); await ready(page);
    const readerStyle = await page.locator(".request-original .full-text-content").first().evaluate(node => getComputedStyle(node).fontStyle);
    assert.equal(readerStyle, "normal", "The separate exact reader is not restyled by activity-card emphasis");
    if (proofs) await writeFile(path.join(proofs, "reading-geometry.json"), JSON.stringify(measurements, null, 2));
});
