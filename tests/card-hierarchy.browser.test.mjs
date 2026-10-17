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
import { recordedInteractionModels } from "../lib/interaction-model.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { contrast, rgb } from "./color-measurements.mjs";

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
        ["conflicting", "Read the recorded deployment choice without guessing.", "user"],
    ].map(([id, text, source], index) => {
        const record = fixture(`hierarchy-${id}`);
        record.sourceSessionId = `harbor-${id}`;
        record.sourceSessionName = `Sample: ${id === "archive" ? "Older checklist lookup" : "Harbor launch " + id}`;
        record.project = "Sample workspace: Harbor launch";
        const user = { type: "user.message", id: `prompt-${id}`, timestamp: `2026-10-10T09:3${9 - index}:00Z`,
            data: { content: text, messageId: `logical-${id}`, ...(source ? { source } : {}) } };
        record.userPrompt = promptRecord(user);
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
        if (id === "archive") record.toolCalls[0].model = "tool-hint";
        if (["retry", "multiple", "long", "conflicting"].includes(id)) {
            const models = ["multiple", "conflicting"].includes(id) ? ["recorded-model-a", "recorded-model-b"]
                : id === "long" ? ["model-" + "LongRecordedName".repeat(28) + "<img src=x>"] : ["recorded-model-a"];
            const responses = models.map((model, index) => ({ id: `response-${id}-${index}`, type: "assistant.message",
                timestamp: new Date(Date.parse(user.timestamp) + 2000 + index * 1000).toISOString(),
                data: { model, originatingMessageId: user.data.messageId, apiCallId: `api-${id}-${id === "conflicting" ? 0 : index}`,
                    turnId: `turn-${id}-${index}`, phase: "final_answer", toolRequests: [], content: "Invented reply, not model metadata" },
            }));
            const last = responses.at(-1);
            const events = [user, ...responses, { id: `end-${id}`, type: "assistant.turn_end",
                timestamp: new Date(Date.parse(last.timestamp) + 10).toISOString(), data: { turnId: last.data.turnId } }];
            record.originalModelEvidence = recordedInteractionModels(events, record);
            record.responseTiming = recordedResponseTiming(events, record.userPrompt);
        }
        return record;
    });
}

async function setup(t, data = records(), { hasTouch = false } = {}) {
    const cleanup = [], { context, root } = await privateFixture({ after: fn => cleanup.push(fn) }, data);
    const before = await loadBoardState(context);
    let providers = 0;
    const runtime = await serve(context, createExportController(context), {
        port: 0, collector: { timers: false }, search: { modelDirectory: path.join(root, "not-provisioned") },
        evaluation: { evaluatorFactory: async () => { providers++; throw Error("No model work in card hierarchy proof."); },
            readSource: async () => { providers++; throw Error("No source reads in card hierarchy proof."); } },
    });
    const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
    const contextBrowser = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC", hasTouch });
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
    await card.screenshot({ path: path.join(proofs, `${name}-whole-card.png`) });
    await page.evaluate(() => scrollTo(0, 0)); await frames(page);
    await page.screenshot({ path: path.join(proofs, `${name}-page.png`), fullPage: true });
    await writeFile(path.join(proofs, `${name}.txt`), await page.locator("#activityView").ariaSnapshot());
}
const interaction = (page, id) => page.locator(`.request-row[data-view-key="request:hierarchy-${id}"]`);
const callCard = (page, id) => page.locator(".matched-action").filter({ has: page.locator(`.request-link[href*="hierarchy-${id}"]`) }).first();

test("card facts have uniform key and value ink without blank chat rows or detached prompt actions", async t => {
    const data = records();
    const long = data.find(row => row.scenarioId === "hierarchy-long");
    long.sourceSessionName = "Harbor launch: final handover";
    long.project = "Harbor launch";
    long.originalModelEvidence.responses[0].model = "recorded-model-a";
    const repeated = data.find(row => row.scenarioId === "hierarchy-archive");
    repeated.toolCalls.push({ ...repeated.toolCalls[0], toolCallId: "archive-repeat", startEventId: "start-archive-repeat" });
    const { page } = await setup(t, data), measurements = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [820, 1], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        for (const mode of ["interactions", "calls"]) {
            await page.locator(`[data-analyze-mode="${mode}"]`).click(); await ready(page);
            const card = mode === "interactions" ? interaction(page, "long") : callCard(page, "long");
            const compact = mode === "interactions" ? interaction(page, "retry") : callCard(page, "retry");
            if (mode === "interactions") {
                await expect(compact.locator(".card-tool-count")).toHaveCount(0);
                await expect(interaction(page, "archive").locator(".card-tool-count")).toHaveText("(2 calls)");
                await expect(interaction(page, "multiple").locator(".card-tool-count")).toHaveText(["(2 calls)", "(1 call)"]);
            }
            measurements.push(await compact.evaluate((node, state) => {
                const css = getComputedStyle(node), facts = node.querySelector(".card-context");
                const chat = facts.firstElementChild, project = chat.nextElementSibling;
                const textBox = element => {
                    const range = document.createRange(); range.selectNodeContents(element);
                    return range.getBoundingClientRect();
                };
                return { ...state, height: node.getBoundingClientRect().height,
                    key: css.getPropertyValue("--muted").trim(), ink: css.getPropertyValue("--ink").trim(), paper: css.backgroundColor,
                    keys: [...node.querySelectorAll(".activity-card-facts dt")].map(item => getComputedStyle(item).color),
                    values: [...node.querySelectorAll(".activity-card-facts dd,.card-tool-count,.card-chat>a,.request-meta,.semantic-cue>span")]
                        .map(item => ({ text: item.textContent, color: getComputedStyle(item).color })),
                    chatLineHeight: parseFloat(getComputedStyle(chat.querySelector("dd")).lineHeight),
                    chatHeight: chat.getBoundingClientRect().height,
                    chatGap: textBox(project.querySelector("dd")).top - textBox(chat.querySelector("a")).bottom,
                    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
            }, { theme, width, scale, mode }));
            measurements.at(-1).prompt = await card.evaluate(node => {
                const control = node.querySelector(".full-text-toggle");
                return { label: control.textContent, inPassage: !!control.closest(".full-text-passage"),
                    statusRows: node.querySelectorAll(".full-text-preview-state").length,
                    outlined: getComputedStyle(control, "::before").content !== "none" };
            });
            if (proofs && width !== 820 && scale === 1) {
                await mkdir(proofs, { recursive: true });
                await compact.screenshot({ path: path.join(proofs, `compact-short-${mode}-${theme}-${width}.png`) });
                await card.screenshot({ path: path.join(proofs, `compact-long-${mode}-${theme}-${width}.png`) });
                if (mode === "interactions") await interaction(page, "archive").screenshot({ path: path.join(proofs, `compact-repeat-${theme}-${width}.png`) });
            }
        }
    }
    if (proofs) await writeFile(path.join(proofs, "compact-card-measurements.json"), JSON.stringify(measurements, null, 2));
    for (const row of measurements) {
        assert.ok(row.keys.every(color => contrast(color, row.key) === 1 && contrast(color, row.paper) >= 4.5),
            "All metadata keys share one readable neutral role");
        assert.ok(row.values.every(value => contrast(value.color, row.ink) === 1),
            `${row.mode}/${row.theme}: nested values use theme ink, not key/semantic color: ${JSON.stringify(row.values)}`);
        assert.ok(row.overflow <= 1);
        if (row.width === 1440 && row.scale === 1) {
            assert.ok(row.chatHeight <= Math.max(24, row.chatLineHeight) + 1, "Chat link must not reserve a blank 44px fact row");
            assert.ok(row.chatGap <= 10, "Chat and project values follow the same compact row rhythm");
        }
        assert.deepEqual(row.prompt, { label: "Read more", inPassage: true, statusRows: 0, outlined: false },
            "A truncated prompt has an in-context text action, not a second outlined navigation action or preview status row");
    }
});

test("in-context prompt reading preserves exact copy, touch, focus, selection, Back and source gaps", async t => {
    const data = records();
    data.find(row => row.scenarioId === "hierarchy-archive").userPrompt = {
        ...data.find(row => row.scenarioId === "hierarchy-archive").userPrompt, status: "partial", text: longPrompt,
    };
    data.find(row => row.scenarioId === "hierarchy-missing").userPrompt = { status: "unavailable", text: "DO_NOT_RENDER_UNAVAILABLE_TEXT" };
    data.find(row => row.scenarioId === "hierarchy-multiple").toolCalls[1].failureEvidence = {
        version: 1, reason: "error-code-recorded", code: "E_ACCESSDENIED", messageStatus: "text-excluded", messageSignal: "access-denial",
    };
    const { page } = await setup(t, data, { hasTouch: true });
    const card = interaction(page, "long"), toggle = card.locator(".full-text-toggle");
    await expect(interaction(page, "retry").locator(".full-text-toggle")).toHaveCount(0);
    await expect(interaction(page, "missing")).toContainText("Prompt not available");
    await expect(interaction(page, "missing")).not.toContainText("DO_NOT_RENDER_UNAVAILABLE_TEXT");
    await expect(interaction(page, "missing").locator(".full-text-toggle,.ux-copy")).toHaveCount(0);
    await card.locator("input").check();
    const route = page.url();
    await toggle.focus(); await page.keyboard.press("Enter");
    await expect(toggle).toHaveText("Read less"); await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    assert.equal(await card.locator("pre").textContent(), longPrompt);
    assert.equal(page.url(), route);
    await expect(card.locator("input")).toBeChecked();
    await card.getByRole("button", { name: "Copy prompt", exact: true }).tap();
    assert.equal(await page.evaluate(() => window.copiedHierarchyText), longPrompt);
    const selected = await card.locator("pre").evaluate(node => {
        const range = document.createRange(); range.setStart(node.firstChild, 5); range.setEnd(node.firstChild, 44);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        return selection.toString();
    });
    const refresh = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await refresh; await ready(page);
    assert.equal(await page.evaluate(() => getSelection().toString()), selected, "Exact-text selection survives refresh");
    await card.locator(".request-link").click(); await ready(page);
    await page.locator("#contextBack").click(); await ready(page);
    await expect(card.locator(".request-link")).toBeFocused();
    await expect(toggle).toHaveText("Read less"); await expect(card.locator("input")).toBeChecked();
    await toggle.focus(); await page.keyboard.press("Space");
    await expect(toggle).toHaveText("Read more"); await expect(toggle).toBeFocused();
    await expect(card.locator(".full-text-body")).toHaveCount(0);
    assert.equal(await toggle.evaluate(node => getComputedStyle(node).outlineStyle !== "none"), true);
    await toggle.tap(); await expect(toggle).toHaveText("Read less");
    await toggle.tap(); await expect(toggle).toHaveText("Read more");
    const partial = interaction(page, "archive");
    for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await expect(partial).toContainText("Only part of the original was recorded. Missing text is not reconstructed.");
        await partial.locator(".full-text-toggle").tap();
        await expect(partial.locator(".full-text-availability")).toBeVisible();
        assert.equal(await partial.locator("pre").textContent(), longPrompt);
        await partial.locator(".full-text-toggle").tap();
    }
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    const failure = page.locator(".matched-action").filter({ has: page.locator("[data-outcome=failure]") });
    await expect(failure).toContainText("Tool error mentions access denial");
    await expect(failure).toContainText("Tool error: E_ACCESSDENIED");
    if (proofs) await shot(page, "compact-failure-with-access-denial", failure);
});

test("prompt emphasis fits the whole card's reading rhythm in both views", async t => {
    const { page } = await setup(t), measurements = [];
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        for (const mode of ["interactions", "calls"]) {
            await page.locator(`[data-analyze-mode="${mode}"]`).click(); await ready(page);
            for (const id of ["retry", "archive", "multiple", "missing", "long"]) {
                const card = mode === "interactions" ? interaction(page, id) : callCard(page, id);
                await card.evaluate(node => scrollBy(0, node.getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().height - 12));
                await frames(page);
                const prompt = card.locator(".full-text-preview");
                const measured = await prompt.evaluate(node => {
                    const css = getComputedStyle(node), rect = node.getBoundingClientRect();
                    const card = node.closest(".activity-card"), cardBox = card.getBoundingClientRect();
                    const range = document.createRange(); range.selectNodeContents(node);
                    return { text: node.textContent, font: css.fontFamily, fontSize: css.fontSize, lineHeight: css.lineHeight,
                        weight: css.fontWeight, style: css.fontStyle, textWidth: rect.width, height: rect.height,
                        cardHeight: cardBox.height, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                        metadataSize: getComputedStyle(card.querySelector("dd")).fontSize,
                        clipped: [...range.getClientRects()].some(box => box.left < rect.left - 1 || box.right > rect.right + 1 || box.bottom > rect.bottom + 1) };
                });

                const { root } = await cdp.send("DOM.getDocument");
                const selector = mode === "interactions" ? `[data-view-key="request:hierarchy-${id}"] .full-text-preview`
                    : `.matched-action:has(.request-link[href*="hierarchy-${id}"]) .full-text-preview`;
                const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
                const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
                measurements.push({ theme, width, mode, id, ...measured, fonts });
                assert.equal(measured.style, "italic");
                assert.equal(measured.weight, "600", "Prompt emphasis uses the existing strong weight, not a heavier heading weight");
                assert.equal(measured.fontSize, measured.metadataSize, "Prompt stays at the established body size, not a display heading");
                assert.ok(fonts.some(font => /Asta/i.test(font.familyName) && font.glyphCount > 0), "Actual prompt glyphs use Asta, not only a declared font stack");
                assert.equal(measured.clipped, false); assert.ok(measured.overflow <= 1);
                if (proofs) {
                    await mkdir(proofs, { recursive: true });
                    await page.screenshot({ path: path.join(proofs, `prompt-${mode}-${id}-${theme}-${width}.png`) });
                }
            }
        }
    }
    await cdp.detach();
    if (proofs) await writeFile(path.join(proofs, "prompt-rhythm.json"), JSON.stringify(measurements, null, 2));
});

test("compact author and category help stays aligned, keyboard reachable and separate from other actions", async t => {
    const { page } = await setup(t);
    for (const theme of ["light", "dark"]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width: 375, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        const card = interaction(page, "archive");
        for (const control of [card.getByRole("button", { name: "About prompt author" }), card.getByRole("button", { name: /^About Files/ })]) {
            const shape = await control.evaluate(node => {
                const end = node.closest(".metadata-tail-end") ?? node.querySelector(".metadata-tail-end");
                const target = node.getBoundingClientRect(), icon = end.querySelector("svg").getBoundingClientRect();
                const range = document.createRange(); range.selectNodeContents(end.querySelector(".metadata-tail-text"));
                const text = range.getBoundingClientRect();
                return { width: target.width, height: target.height, iconWidth: icon.width,
                    centerDelta: Math.abs(icon.y + icon.height / 2 - text.y - text.height / 2),
                    glyphGap: icon.x - text.right };
            });
            assert.ok(shape.width >= 24 && shape.height >= 24 && shape.width >= shape.iconWidth);
            assert.ok(shape.centerDelta <= 2, JSON.stringify(shape));
            assert.ok(shape.glyphGap >= 4 && shape.glyphGap <= 8, JSON.stringify(shape));
            await control.focus(); await page.keyboard.press("Enter");
            await expect(page.getByRole("tooltip")).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(card.locator("input")).not.toBeChecked();
            await expect(page.locator("#activityView")).toBeVisible();
        }
    }
});

test("static whole-card evidence covers filtered boundaries and sustained full reading", { skip: !proofs }, async t => {
    const data = records();
    data.find(row => row.scenarioId === "hierarchy-retry").userPrompt.text = longPrompt;
    const { page } = await setup(t, data), measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        for (const mode of ["interactions", "calls"]) {
            await page.locator(`[data-analyze-mode="${mode}"]`).click(); await ready(page);
            const card = mode === "interactions" ? interaction(page, "retry") : callCard(page, "retry");
            await card.locator(".full-text-toggle").click();
            await shot(page, `expanded-${mode}-${theme}-${width}`, card);
            await card.locator(".full-text-toggle").click();
            const multiple = mode === "interactions" ? interaction(page, "multiple") : callCard(page, "multiple");
            await shot(page, `normal-${mode}-${theme}-${width}`, multiple);
            if (mode === "calls") await shot(page, `failed-call-${theme}-${width}`,
                page.locator(".matched-action").filter({ has: page.locator("[data-outcome=failure]") }).first());
            measurements.push(await multiple.evaluate((node, state) => ({
                ...state, height: node.getBoundingClientRect().height,
                text: node.textContent, prompt: node.querySelector(".full-text-preview").textContent,
                keys: [...node.querySelectorAll("dt")].map(key => ({ text: key.textContent, color: getComputedStyle(key).color, weight: getComputedStyle(key).fontWeight })),
            }), { theme, width, mode }));
        }
        await selectActivityOption(page, "toolFilter", "workiq-ask"); await ready(page);
        for (const mode of ["interactions", "calls"]) {
            await page.locator(`[data-analyze-mode="${mode}"]`).click(); await ready(page);
            await shot(page, `filtered-${mode}-${theme}-${width}`, mode === "interactions" ? interaction(page, "multiple") : callCard(page, "multiple"));
        }
        await selectActivityOption(page, "toolFilter", "all"); await ready(page);
    }
    await writeFile(path.join(proofs, "whole-card-composition.json"), JSON.stringify(measurements, null, 2));
});

test("Interactions and Calls share emphasized prompts, nonoverlapping facts and distinct tools", async t => {
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
                    group: row.parentElement.className,
                    labelColor: getComputedStyle(row.querySelector("dt")).color,
                    valueColor: getComputedStyle(row.querySelector("dd")).color,
                    paper: getComputedStyle(node).backgroundColor,
                    valueWeight: getComputedStyle(row.querySelector("dd")).fontWeight,
                    textWeights: [...row.querySelectorAll("dd,dd *")].filter(node => !node.closest(".card-tool-name")
                        && [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim()))
                        .map(node => ({ text: node.textContent, weight: getComputedStyle(node).fontWeight })),
                    top: row.getBoundingClientRect().top, bottom: row.getBoundingClientRect().bottom,
                    left: row.getBoundingClientRect().left, right: row.getBoundingClientRect().right,
                    labelCount: row.querySelectorAll(":scope>dt").length, valueCount: row.querySelectorAll(":scope>dd").length,
                })),
            }), { mode, theme, width }));
        }
    }
    if (proofs) await writeFile(path.join(proofs, "hierarchy-measurements.json"), JSON.stringify(measurements, null, 2));
    for (const row of measurements) {
        assert.ok(row.prompts.every(p => p.weight === "600" && p.style === "italic"), `${row.mode}: actual prompt has restrained strong italic emphasis`);
        assert.ok(row.facts.length >= 4, `${row.mode}: categories are semantic key/value rows`);
        assert.ok(row.facts.every(fact => fact.label && fact.value && fact.labelWeight === "600"
            && fact.valueWeight === "400" && fact.labelCount === 1 && fact.valueCount === 1));
        for (const fact of row.facts) {
            assert.notEqual(fact.labelColor, fact.valueColor, "Strong neutral keys remain distinct from ordinary values");
            assert.ok(Number(fact.labelWeight) > Number(fact.valueWeight));
            assert.ok(contrast(fact.labelColor, fact.paper) >= 4.5, "Neutral keys retain readable contrast");
            assert.equal(new Set(rgb(fact.labelColor)).size, 1, "Keys use an achromatic screen role");
        }
        assert.deepEqual(row.facts.flatMap(fact => fact.textWeights).filter(text => text.weight !== "400"), [],
            `${row.mode}: actual metadata values, not just their containers, have normal weight`);
        assert.ok(row.facts.every((fact, index) => !index || fact.group !== row.facts[index - 1].group
            || fact.top >= row.facts[index - 1].bottom || fact.left >= row.facts[index - 1].right),
            `${row.mode}: compact facts wrap without overlapping`);
    }
});

const fact = (card, label) => card.locator(".activity-card-facts>div").filter({ has: card.page().locator("dt").filter({ hasText: new RegExp(`^${label}:$`) }) });

test("card keys have one colon without changing values or distinctive value paint", async t => {
    const { page } = await setup(t), measurements = [];
    for (const [theme, width] of [["light", 1440], ["dark", 375]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        for (const mode of ["interactions", "calls"]) {
            await page.locator(`[data-analyze-mode="${mode}"]`).click(); await ready(page);
            const card = mode === "interactions" ? interaction(page, "multiple") : callCard(page, "multiple");
            await shot(page, `keys-${mode}-${theme}-${width}`, card);
            const measured = await card.evaluate(node => {
                const appearance = element => {
                    const css = getComputedStyle(element);
                    return { text: element.textContent, color: css.color, background: css.backgroundColor, padding: css.padding,
                        border: css.border, radius: css.borderRadius, font: css.font, width: element.getBoundingClientRect().width,
                        height: element.getBoundingClientRect().height };
                };
                return { keys: [...node.querySelectorAll(".activity-card-facts dt")].map(item => item.textContent),
                    values: [...node.querySelectorAll(".activity-card-facts dd")].map(item => item.textContent),
                    origin: node.querySelector(".full-text-preview-label").textContent,
                    distinct: [...node.querySelectorAll(".recorded-result,code.api-path,.service-cue svg")].map(appearance),
                    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    clipped: [...node.querySelectorAll(".activity-card-facts dt,.activity-card-facts dd")].filter(item =>
                        !item.matches(".card-operation>dt") && item.scrollWidth > item.clientWidth + 1).map(item => item.textContent) };
            });
            measurements.push({ theme, width, mode, ...measured });
        }
    }
    if (proofs) await writeFile(path.join(proofs, "key-punctuation.json"), JSON.stringify(measurements, null, 2));
    for (const row of measurements) {
        assert.ok(row.keys.length && row.keys.every(label => /[^:]:$/.test(label) && !label.endsWith("::")), "Exactly one visible separator on actual metadata keys");
        assert.equal(row.origin, "Agent prompt", "Standalone prompt label is not punctuated");
        assert.ok(row.overflow <= 1); assert.deepEqual(row.clipped, []);
    }
});

test("paired cards retain the same paper surface, content inset and actor cue", async t => {
    const { page } = await setup(t), pairs = [];
    await selectActivityOption(page, "toolFilter", "workiq-ask"); await ready(page);
    for (const [theme, width] of [["light", 1440], ["dark", 375]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        const pair = { theme, width };
        for (const mode of ["interactions", "calls"]) {
            await page.locator(`[data-analyze-mode="${mode}"]`).click(); await ready(page);
            const card = mode === "interactions" ? interaction(page, "multiple") : callCard(page, "multiple");
            await shot(page, `surface-${mode}-${theme}-${width}`, card);
            pair[mode] = await card.evaluate(node => {
                const css = getComputedStyle(node), cue = getComputedStyle(node.querySelector(".full-text-preview-label"));
                // Native borders snap to device pixels; compare with an independent 3px border in this renderer.
                const reference = document.createElement("span");
                reference.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;border-inline-start:3px solid";
                node.append(reference);
                const intendedCueWidth = getComputedStyle(reference).borderInlineStartWidth;
                reference.remove();
                const bounds = node.getBoundingClientRect(), prompt = node.querySelector(".full-text").getBoundingClientRect();
                return { background: css.backgroundColor, padding: css.padding, border: css.borderBottom,
                    topBorder: css.borderTopWidth, radius: css.borderRadius, margin: css.marginTop,
                    cueWidth: cue.borderInlineStartWidth, cueColor: cue.borderInlineStartColor, cuePadding: cue.paddingInlineStart,
                    intendedCueWidth, devicePixelRatio,
                    inset: prompt.left - bounds.left,
                    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    checkboxes: node.querySelectorAll("input[type=checkbox]").length };
            });
        }
        pairs.push(pair);
    }
    if (proofs) await writeFile(path.join(proofs, "surface-pairs.json"), JSON.stringify(pairs, null, 2));
    for (const { theme, interactions, calls } of pairs) {
        for (const key of ["background", "padding", "border", "topBorder", "radius", "margin", "cueWidth", "cueColor", "cuePadding"]) {
            assert.equal(calls[key], interactions[key], `${theme}: shared ${key}`);
        }
        assert.ok(calls.inset >= 8 && interactions.inset >= 8);
        assert.equal(calls.checkboxes, 0); assert.equal(interactions.checkboxes, 1);
        assert.ok(parseFloat(calls.cueWidth) > 0, "The actor cue remains present");
        assert.equal(calls.cueWidth, calls.intendedCueWidth, "Calls uses the native rendered width of the intended 3px cue");
        assert.equal(interactions.cueWidth, interactions.intendedCueWidth, "Interactions uses the native rendered width of the intended 3px cue");
        assert.ok(calls.overflow <= 1 && interactions.overflow <= 1);
    }
});

test("recorded models use the same stacked card fact and exact reader context without tool attribution", async t => {
    const { page, data, snapshot } = await setup(t);
    const multi = interaction(page, "multiple");
    await expect(fact(multi, "Models").locator("dd")).toHaveText("recorded-model-a then recorded-model-b");
    await expect(fact(interaction(page, "missing"), "Model").locator("dd")).toHaveText("Not recorded");
    await expect(fact(interaction(page, "retry"), "Model").locator("dd")).toHaveText("recorded-model-a");
    await expect(fact(interaction(page, "conflicting"), "Model").locator("dd")).toHaveText("Conflicting records");
    await expect(fact(interaction(page, "archive"), "Final response").locator("dd")).toHaveText("Not recorded");
    await expect(multi.locator(".card-activity .response-timing")).toBeVisible();
    await expect(fact(interaction(page, "archive"), "Model").locator("dd")).toHaveText("Not verified (tool metadata only)");
    await expect(multi.locator(".response-timing data")).toHaveAttribute("value", "3000");
    assert.equal(snapshot().assessment.catalog.find(row => row.scenarioId === "hierarchy-multiple").responseTiming.durationMs, 3000);
    assert.deepEqual(await fact(multi, "Models").evaluate(node => ({
        labelWeight: getComputedStyle(node.querySelector("dt")).fontWeight,
        valueWeight: getComputedStyle(node.querySelector("dd")).fontWeight,
        controls: node.querySelectorAll("a,button,input,details,[tabindex]").length,
        next: node.nextElementSibling?.querySelector("dt")?.textContent,
    })), { labelWeight: "600", valueWeight: "400", controls: 0, next: undefined });
    await selectActivityOption(page, "toolFilter", "workiq-ask"); await ready(page);
    await expect(fact(multi, "Models").locator("dd")).toHaveText("recorded-model-a then recorded-model-b");
    await expect(multi.locator(".response-timing data")).toHaveAttribute("value", "3000");
    await expect(multi.locator(".card-tool-name")).toHaveText(["workiq-ask"]);
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    const call = callCard(page, "multiple");
    await expect(fact(call, "Interaction model").locator("dd")).toHaveText("recorded-model-a then recorded-model-b");
    await expect(fact(call, "Tool latency").locator("dd")).toHaveText("1.2 s");
    await expect(fact(call, "Tool latency").locator("data")).toHaveAttribute("value", "1200");
    await expect(call.locator(".response-timing")).toHaveCount(0);
    await expect(call.locator(".interaction-tools")).not.toContainText("recorded-model");
    const link = call.getByRole("link", { name: "Open exact call in context" });
    await link.focus(); await page.keyboard.press("Enter"); await ready(page);
    const reader = page.locator(".request-original .interaction-model-fact");
    await expect(reader.locator("dt")).toHaveText("Models:");
    await expect(reader.locator("dd")).toHaveText("recorded-model-a then recorded-model-b");
    await expect(page.locator(".request-original .response-timing dt")).toHaveText("Final response:");
    await expect(page.locator(".request-original .response-timing data")).toHaveAttribute("value", "3000");
    assert.equal(await reader.evaluate(node => node.previousElementSibling?.className), "activity-card-facts reader-source");
    await page.locator(".request-original").getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.equal(await page.evaluate(() => window.copiedHierarchyText), data.find(row => row.scenarioId === "hierarchy-multiple").userPrompt.text);
    for (const [theme, width] of [["light", 1440], ["dark", 375]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await expect(reader.locator("dd")).toHaveText("recorded-model-a then recorded-model-b");
        assert.deepEqual(await page.locator(".request-original").evaluate(node => ({
            keys: [...node.querySelectorAll(".reader-response-timing dt,.interaction-model-fact dt")].map(item => item.textContent),
            weights: [...node.querySelectorAll(".reader-response-timing dt,.interaction-model-fact dt")].map(item => getComputedStyle(item).fontWeight),
            values: [...node.querySelectorAll(".reader-response-timing dd,.interaction-model-fact dd")].map(item => getComputedStyle(item).fontWeight),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        })), { keys: ["Models:", "Final response:"], weights: ["600", "600"], values: ["400", "400"], overflow: 0 });
        if (proofs) {
            await mkdir(proofs, { recursive: true });
            await page.screenshot({ path: path.join(proofs, `combined-reader-${theme}-${width}.png`), fullPage: true });
            await writeFile(path.join(proofs, `combined-reader-${theme}-${width}.txt`), await page.locator("#requestContent").ariaSnapshot());
        }
    }
    assert.match(await reader.ariaSnapshot(), /Models.*|recorded-model-a/);
    await page.goBack(); await ready(page);
    await expect(fact(callCard(page, "multiple"), "Interaction model").locator("dd")).toHaveText("recorded-model-a then recorded-model-b");
});

async function pointAt(page, target) {
    await target.evaluate(node => scrollBy(0, node.getBoundingClientRect().top - innerHeight / 2));
    await frames(page);
    const box = await target.boundingBox(), point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    assert.ok(await target.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), point), "Pointer reaches actual target");
    return { ...point, top: box.y };
}

test("scoped tool lists retain individual names and counts without assigning aggregate outcomes", async t => {
    const data = records(), repeated = data.find(row => row.scenarioId === "hierarchy-archive");
    repeated.toolCalls.push({ ...repeated.toolCalls[0], toolCallId: "archive-repeat", startEventId: "start-archive-repeat" });
    const { page, snapshot } = await setup(t, data);
    page.screenshot = () => { throw new Error("Screenshots are forbidden in the native return-position proof."); };
    const canonicalIds = [0, 1, 2].map(index => `call:["harbor-multiple","multiple-${index}"]`);
    assert.deepEqual(snapshot().analytics.rows.filter(row => row.scenarioId === "hierarchy-multiple").map(row => row.id).sort(), canonicalIds);
    const multi = interaction(page, "multiple");
    await expect(multi.locator(".card-tool-name")).toHaveText(["workiq-fetch", "workiq-ask"]);
    await expect(fact(multi, "Tools")).toBeVisible();
    await expect(multi.locator(".card-tool-count")).toHaveText(["(2 calls)", "(1 call)"]);
    await expect(fact(interaction(page, "retry"), "Tool")).toHaveText("Tool:workiq-fetch");
    await expect(interaction(page, "retry").locator(".card-tool-count")).toHaveCount(0);
    await expect(fact(interaction(page, "archive"), "Tool")).toHaveText("Tool:workiq-fetch (2 calls)");
    await expect(multi.locator(".interaction-tools [data-outcome]")).toHaveCount(0);
    await expect(multi.locator("[data-outcome=failure]")).toHaveAttribute("data-count", "1");
    await expect(multi.locator(".card-result-scope,.result-unit")).toHaveCount(0);
    await expect(multi.locator(".card-outcomes")).toHaveAccessibleName("Matching results only: 3 of 3 Work IQ tool calls match this view");
    const selection = multi.locator(".interaction-select");
    const check = await pointAt(page, selection); await page.mouse.click(check.x, check.y);
    await expect(multi.locator("input")).toBeChecked();
    await selectActivityOption(page, "toolFilter", "workiq-ask"); await ready(page);
    await expect(multi.locator(".card-tool-name")).toHaveText(["workiq-ask"]);
    await expect(multi.locator(".card-tool-count")).toHaveCount(0);
    await expect(fact(multi, "Tool")).toBeVisible();
    await expect(multi.locator(".card-result-scope")).toHaveText("1 of 3 Work IQ tool calls in this view");
    await expect(multi.locator("[data-outcome=failure]")).toHaveCount(0);
    assert.deepEqual(snapshot().analytics.rows.map(row => row.id), [canonicalIds[2]]);
    assert.deepEqual(snapshot().requestActivity.tool.filter(row => row.scenarioId === "hierarchy-multiple").map(row => row.id).sort(), canonicalIds);
    await selectActivityOption(page, "toolFilter", "workiq-fetch"); await ready(page);
    await expect(multi.locator(".card-tool-count")).toHaveText("(2 calls)");
    await expect(multi.locator(".card-result-scope")).toHaveText("2 of 3 Work IQ tool calls in this view");
    await expect(multi.locator("[data-outcome=success]")).toHaveAttribute("data-count", "1");
    await expect(multi.locator("[data-outcome=failure]")).toHaveAttribute("data-count", "1");
    await selectActivityOption(page, "toolFilter", "workiq-ask"); await ready(page);
    await chooseTheme(page, "light");
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    const call = callCard(page, "multiple");
    await expect(call.locator(".card-tool-name")).toHaveText("workiq-ask");
    await expect(page.locator("#activityList .matched-action")).toHaveCount(1);
    await expect(call).toHaveAttribute("data-action-id", canonicalIds[2]);
    await expect(fact(call, "Activity category")).toHaveText("Activity category:Mail");
    await expect(call.locator(".card-outcomes [data-outcome=success]")).toHaveAttribute("data-count", "1");
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
    const chat = fact(multi, "Chat").getByRole("link");
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
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    await expect(call).toHaveAttribute("data-action-id", canonicalIds[2]);
});

test("emphasized previews and calm full reading retain exact text, missing values and long metadata", async t => {
    const { page, data } = await setup(t);
    await expect(interaction(page, "empty")).toHaveCount(0);
    await expect(interaction(page, "unnamed")).toHaveCount(0);
    await expect(fact(interaction(page, "missing"), "Request time")).toContainText("Not recorded");
    await expect(fact(interaction(page, "missing"), "Copilot project")).toHaveCount(0);
    await expect(interaction(page, "missing").locator("[data-outcome=unknown]")).toHaveAttribute("data-count", "1");
    await expect(interaction(page, "archive").locator(".full-text-preview-label")).toHaveText("Prompt");
    await expect(interaction(page, "archive").locator(".full-text-preview-label")).toHaveAttribute("data-prompt-actor", "unknown");
    await interaction(page, "archive").getByRole("button", { name: "About prompt author" }).focus();
    await expect(page.getByRole("tooltip")).toContainText("Author unverified");
    await page.keyboard.press("Escape");
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [1440, 2], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        for (const mode of ["interactions", "calls"]) {
            await page.locator(`[data-analyze-mode="${mode}"]`).click(); await ready(page);
            if (mode === "calls") await expect(callCard(page, "unnamed")).toHaveCount(0);
            const missing = mode === "interactions" ? interaction(page, "missing") : callCard(page, "missing");
            await expect(fact(missing, mode === "interactions" ? "Chat" : "Copilot chat")).toContainText("Copilot chat name not recorded");
            if (mode === "calls") await expect(fact(missing, "Copilot project")).toContainText("No project associated");
            else await expect(fact(missing, "Copilot project")).toHaveCount(0);
            await expect(fact(missing, "Request time")).toContainText("Not recorded");
            await expect(missing.locator("[data-outcome=unknown]")).toHaveAttribute("data-count", "1");
            if (mode === "calls") {
                await expect(fact(missing, "Tool latency")).toContainText("Not recorded");
                await expect(fact(missing, "API path")).toContainText("Not recorded");
            }
            for (const id of ["retry", "multiple", "archive"]) {
                const card = mode === "interactions" ? interaction(page, id) : callCard(page, id);
                assert.deepEqual(await card.locator(".full-text-preview").evaluate(node => ({
                    weight: getComputedStyle(node).fontWeight, style: getComputedStyle(node).fontStyle,
                })), { weight: "600", style: "italic" });
            }
            const card = mode === "interactions" ? interaction(page, "long") : callCard(page, "long");
            await expect(card.locator(".card-tool-name")).toHaveText(longTool);
            const model = fact(card, mode === "interactions" ? "Model" : "Interaction model").locator("dd");
            await expect(model).toHaveText(data.find(record => record.scenarioId === "hierarchy-long").originalModelEvidence.responses[0].model);
            await expect(model.locator("img,script,a,button")).toHaveCount(0);
            assert.ok(await model.evaluate(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                const box = node.getBoundingClientRect();
                return [...range.getClientRects()].every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1)
                    && getComputedStyle(node).fontWeight === "400";
            }), "The exact long model label wraps as ordinary text, not HTML");
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
            assert.equal(shape.weight, "400"); assert.equal(shape.style, "normal"); assert.equal(shape.overflow, "visible");
            assert.equal(shape.maxHeight, "none"); assert.deepEqual(shape.outside, [], JSON.stringify({ width, scale, mode, shape })); assert.ok(shape.pageOverflow <= 1);
            measurements.push({ theme, viewportWidth: width, rootTextScale: scale, mode, ...shape });
            await card.getByRole("button", { name: "Copy prompt", exact: true }).click();
            assert.equal(await page.evaluate(() => window.copiedHierarchyText), longPrompt);
            await shot(page, `${mode}-long-${theme}-${width}-${scale}`, card);
            await card.locator(".full-text-toggle").click();
            assert.deepEqual(await card.locator(".activity-card-facts dt,.activity-card-facts dd").evaluateAll(nodes =>
                nodes.filter(node => !node.matches(".card-operation>dt") && node.scrollWidth > node.clientWidth + 1).map(node => node.textContent)), []);
        }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await callCard(page, "long").locator(".request-link").click(); await ready(page);
    const readerStyle = await page.locator(".request-original .full-text-content").first().evaluate(node => getComputedStyle(node).fontStyle);
    assert.equal(readerStyle, "italic", "The exact prompt carries the same restrained emphasis from card to reader");
    if (proofs) await writeFile(path.join(proofs, "reading-geometry.json"), JSON.stringify(measurements, null, 2));
});
