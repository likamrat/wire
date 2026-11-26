import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { promptRecord } from "../../lib/prompt-authorship.mjs";
import { recordedInteractionModels } from "../../lib/interaction-model.mjs";
import { recordedResponseTiming } from "../../lib/response-timing.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, closeAnalyzeFilters } from "../support/helpers.mjs";
import { contrast } from "../support/color-measurements.mjs";

const proofs = process.env.WIRE_CARD_HIERARCHY_PROOFS;
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
    const runtime = await startServer(context, createExportController(context), {
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

test("tool and target labels stay with their values without overlapping or clipping", async t => {
    const { page } = await setup(t);
    for (const theme of ["light", "dark"]) for (const [width, size] of [[1440, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, size);
        const card = interaction(page, "multiple"), facts = card.locator(".card-identities");
        await expect(facts.getByRole("term")).toHaveText(["Tools", "Targets", "Model tokens"]);
        await expect(facts.getByRole("definition")).toHaveCount(3);
        const targets = await facts.locator("[data-service]").evaluateAll(nodes => nodes.map(node => {
            const { left, top, bottom } = node.getBoundingClientRect();
            return { left, top, bottom };
        }));
        assert.ok(targets.length >= 2 && targets.slice(1).every((r, i) =>
            Math.abs(r.left - targets[0].left) <= 1 && r.top >= targets[i].bottom - 1), "Targets form one vertical list");
        await expect(card.getByRole("button", { name: "Add to report", exact: true })).toBeVisible();
        await expect(card.locator(".request-card-source")).toHaveCount(0);
        const measured = await facts.locator(".card-identity-field").evaluateAll(fields => fields.map(field => {
            const label = field.querySelector("dt"), value = field.querySelector("dd");
            const css = getComputedStyle(label), actual = getComputedStyle(value);
            const a = label.getBoundingClientRect(), b = value.getBoundingClientRect();
            return { labelWeight: css.fontWeight, valueWeight: actual.fontWeight, paper: getComputedStyle(field.closest("article")).backgroundColor,
                label: css.color, value: actual.color, separate: a.bottom <= b.top + 1 || a.right <= b.left + 1,
                clipped: [label, value].some(n => n.scrollWidth > n.clientWidth + 1) };
        }));
        for (const row of measured) {
            assert.equal(row.labelWeight, "400"); assert.equal(row.valueWeight, "400");
            assert.ok(contrast(row.label, row.paper) >= 4.5 && contrast(row.value, row.paper) >= 4.5);
            assert.equal(row.separate, true); assert.equal(row.clipped, false);
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await shot(page, `interaction-${width}-${size}-${theme}`, card);
    }
});

test("filtered tool links keep the exact call and complete interaction separate", async t => {
    const { page, snapshot } = await setup(t);
    const card = interaction(page, "multiple"), tools = card.locator(".card-tool-list");
    const ids = [0, 1, 2].map(i => `call:["harbor-multiple","multiple-${i}"]`);
    await expect(tools.getByRole("link")).toHaveText(["workiq-fetch", "workiq-ask"]);
    await expect(tools.locator(".card-tool-count")).toHaveText(["(2 calls)"]);
    await expect(tools.locator("[data-outcome]")).toHaveCount(0);
    await expect(card.getByRole("link", { name: "1 tool call failed", exact: true })).toBeVisible();
    for (const [name, rows] of [["workiq-fetch", ids.slice(0, 2)], ["workiq-ask", ids.slice(2)]]) {
        await selectActivityOption(page, "toolFilter", name); await closeAnalyzeFilters(page);
        await expect(tools.getByRole("link")).toHaveText([name]);
        await expect(card.locator(".request-card-count")).toHaveText(`${rows.length} of 3 Work IQ tool calls ${rows.length === 1 ? "matches" : "match"} this view`);
        await expect.poll(() => snapshot().analytics.rows.filter(row => row.scenarioId === "hierarchy-multiple").map(row => row.id).sort()).toEqual(rows);
        assert.deepEqual(snapshot().requestActivity.tool.filter(row => row.scenarioId === "hierarchy-multiple").map(row => row.id).sort(), ids);
    }
    const link = tools.getByRole("link", { name: "workiq-ask: open call", exact: true });
    await link.scrollIntoViewIfNeeded(); await link.focus();
    await expect(page.getByRole("tooltip")).toContainText("Asks Copilot or a selected agent");
    await page.keyboard.press("Escape"); await expect(page.getByRole("tooltip")).toBeHidden();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    const before = await link.boundingBox(), url = page.url();
    await link.press("Enter");
    const selected = page.locator('[data-tool-call-id="multiple-2"]');
    await expect(selected).toBeFocused(); await expect(selected).toHaveAttribute("data-action-id", ids[2]);
    await expect(selected).toContainText("1.2 s");
    await expect(page.locator(".reader-call-row")).toHaveCount(3);
    await expect(page.locator('.reader-call-row .action-context').filter({ hasText: "Outside current view" })).toHaveCount(2);
    await page.goBack(); await expect(link).toBeFocused();
    assert.equal(page.url(), url);
    await expect.poll(async () => Math.abs((await link.boundingBox()).y - before.y)).toBeLessThan(3);
    await expect(card.getByRole("button", { name: "Add to report", exact: true })).toBeVisible();
});

test("reader Source keeps recorded, conflicting, missing and tool-only models distinct", async t => {
    const { page } = await setup(t);
    for (const [id, label, value] of [["multiple", "Models", "recorded-model-a then recorded-model-b"],
        ["retry", "Model", "recorded-model-a"], ["archive", "Model", "Not verified (tool metadata only)"],
        ["missing", "Model", "Not recorded"], ["conflicting", "Model", "Conflicting records"]]) {
        const card = interaction(page, id);
        await expect(card.locator(".card-tool-list")).not.toContainText(/recorded-model|tool-hint/);
        await card.locator(".request-card-open").click();
        const source = page.locator('[data-reader-section="source"]');
        await source.getByRole("button", { name: "Source details", exact: true }).click();
        const fact = name => source.getByText(name, { exact: true }).and(source.locator("dt")).locator("..").locator("dd");
        await expect(fact(label)).toHaveText(value);
        if (id === "multiple") {
            await expect(fact("Prompt to final response").locator("data")).toHaveAttribute("value", "3000");
            await expect(page.locator('[data-tool-call-id="multiple-2"] data.call-duration')).toHaveAttribute("value", "1200");
            const chat = fact("Chat").getByRole("link", { name: "Filter to chat: Sample: Harbor launch multiple", exact: true });
            await chat.press("Enter");
            await expect(page.locator("#chatFilter")).toHaveValue("harbor-multiple");
            await expect(page.locator("#activityList article")).toHaveCount(1);
            await page.goBack(); await expect(chat).toBeFocused();
        }
        if (id === "missing") {
            await expect(fact("Chat")).toContainText("Copilot chat name not recorded");
            await expect(fact("Project")).toHaveText("No project associated");
            await expect(card.locator(".request-card-time")).toHaveText("Request time: Not recorded");
            await expect(card).toContainText("Service target not recorded");
            await expect(card).toContainText("No result recorded");
            await expect(page.locator('[data-tool-call-id="missing-0"] .reader-call-duration')).toContainText("Not recorded");
        }
        await page.locator("#closeContextSidebar").click();
        await expect(card.locator(".request-card-open")).toBeFocused();
    }
});

test("long recorded model names and full prompt text wrap without becoming markup", async t => {
    const { page, data } = await setup(t);
    await expect(interaction(page, "empty")).toHaveCount(0); await expect(interaction(page, "unnamed")).toHaveCount(0);
    const sourceName = data.find(record => record.scenarioId === "hierarchy-long").originalModelEvidence.responses[0].model;
    for (const [theme, width, size] of [["light", 1440, 100], ["dark", 375, 200]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, size);
        await interaction(page, "long").locator(".request-card-open").click();
        await page.getByRole("navigation", { name: "In this interaction" }).getByRole("button", { name: "Prompt", exact: true }).click();
        const text = page.locator('[data-reader-section="prompt"] .full-text-content');
        assert.equal(await text.textContent(), longPrompt);
        await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
        assert.equal(await page.evaluate(() => window.copiedHierarchyText), longPrompt);
        const source = page.locator('[data-reader-section="source"]'), toggle = source.getByRole("button", { name: "Source details" });
        if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
        const model = source.locator(".model-identity");
        await expect(model).toHaveText(sourceName); await expect(model.locator("img,script,a,button")).toHaveCount(0);
        for (const value of [model, text]) {
            assert.ok(await value.evaluate(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                const bounds = node.closest("dd, .full-text-body").getBoundingClientRect(), css = getComputedStyle(node);
                return css.fontWeight === "400" && css.fontStyle === "normal" && [...range.getClientRects()].every(rect =>
                    rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.bottom <= bounds.bottom + 1);
            }), `${theme}/${width}: full original glyphs stay inside their reading column`);
        }
        await page.goBack(); await expect(interaction(page, "long").locator(".request-card-open")).toBeFocused();
    }
});

test("the prompt reader keeps exact text, Copy and keyboard return separate from report selection", async t => {
    const data = records();
    data.find(row => row.scenarioId === "hierarchy-archive").userPrompt = {
        ...data.find(row => row.scenarioId === "hierarchy-archive").userPrompt, status: "partial", text: longPrompt,
    };
    data.find(row => row.scenarioId === "hierarchy-missing").userPrompt = { status: "unavailable", text: "DO_NOT_RENDER_UNAVAILABLE_TEXT" };
    data.find(row => row.scenarioId === "hierarchy-multiple").toolCalls[1].failureEvidence = {
        version: 1, reason: "error-code-recorded", code: "E_ACCESSDENIED", messageStatus: "text-excluded", messageSignal: "access-denial",
    };
    const { page } = await setup(t, data, { hasTouch: true });
    const card = interaction(page, "long"), open = card.locator(".request-card-open");
    await expect(interaction(page, "retry").locator(".full-text-toggle")).toHaveCount(0);
    await expect(interaction(page, "missing")).toContainText("Prompt text unavailable");
    await expect(interaction(page, "missing")).not.toContainText("DO_NOT_RENDER_UNAVAILABLE_TEXT");
    await expect(interaction(page, "missing").locator(".full-text-toggle,.ux-copy")).toHaveCount(0);
    const route = page.url();
    const reader = page.locator('#contextSidebar [data-reader-section="prompt"]');
    await open.press("Enter");
    await page.getByRole("navigation", { name: "In this interaction" }).getByRole("button", { name: "Prompt", exact: true }).click();
    const original = reader.locator(".full-text-content");
    await expect(reader.locator(".reader-section-heading")).toBeFocused();
    assert.equal(await original.textContent(), longPrompt);
    await reader.getByRole("button", { name: "Copy prompt", exact: true }).tap();
    assert.equal(await page.evaluate(() => window.copiedHierarchyText), longPrompt);
    const selected = await original.evaluate(node => {
        const range = document.createRange(); range.setStart(node.firstChild, 5); range.setEnd(node.firstChild, 44);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        return selection.toString();
    });
    const refresh = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await refresh; await ready(page);
    assert.equal(await page.evaluate(() => getSelection().toString()), selected, "Exact-text selection survives refresh");
    const toggle = reader.getByRole("button", { name: "Human prompt", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.focus(); await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false"); await expect(toggle).toBeFocused();
    await toggle.tap(); await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.goBack(); await expect(open).toBeFocused();
    assert.equal(page.url(), route);
    await expect(card.getByRole("button", { name: "Add to report", exact: true })).toBeVisible();
    const partial = interaction(page, "archive");
    for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await expect(partial).toContainText("Part of the prompt was retained.");
        const link = partial.locator(".request-card-open");
        await link.tap();
        assert.equal(await original.textContent(), longPrompt);
        await page.goBack(); await expect(link).toBeFocused();
    }
    await interaction(page, "multiple").getByRole("link", { name: "1 tool call failed", exact: true }).click();
    const failed = page.locator('[data-tool-call-id="multiple-1"]');
    await expect(failed).toBeFocused();
    await expect(failed).toContainText("Access was denied");
    await page.getByRole("button", { name: "Source details", exact: true }).click();
    await page.getByRole("button", { name: "Record identifiers", exact: true }).click();
    const code = page.locator(".reader-identifiers").getByText("Call #2 error code", { exact: true });
    await expect(code.locator("..").locator("dd")).toHaveText("E_ACCESSDENIED");
});

test("Analyze prompt excerpts use regular Asta Sans and wrap within the card", async t => {
    const { page, data } = await setup(t);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(() => document.fonts.ready);
        for (const id of ["retry", "archive", "multiple", "missing", "long"]) {
            const selector = `[data-view-key="request:hierarchy-${id}"] .card-excerpt`;
            const excerpt = page.locator(selector), text = data.find(row => row.scenarioId === "hierarchy-" + id).userPrompt.text;
            assert.equal(await excerpt.textContent(), text);
            const measured = await excerpt.evaluate(node => {
                const css = getComputedStyle(node), card = node.closest("article"), box = card.getBoundingClientRect();
                const range = document.createRange(); range.selectNodeContents(node);
                return { weight: css.fontWeight, style: css.fontStyle, size: parseFloat(css.fontSize),
                    timeSize: parseFloat(getComputedStyle(card.querySelector(".request-card-time")).fontSize),
                    overflowsCard: [...range.getClientRects()].some(rect => rect.left < box.left - 1 || rect.right > box.right + 1),
                    clippedVertically: node.scrollHeight > node.clientHeight + 1 };
            });
            assert.equal(measured.style, "normal"); assert.equal(measured.weight, "400");
            assert.ok(measured.size > measured.timeSize);
            assert.equal(measured.overflowsCard, false);
            if (id === "long") assert.equal(measured.clippedVertically, true, "A long original stays bounded in the list");
            const { root } = await cdp.send("DOM.getDocument");
            const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
            const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
            assert.ok(fonts.some(font => /Asta/i.test(font.familyName) && font.glyphCount > 0));
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await cdp.detach();
});
