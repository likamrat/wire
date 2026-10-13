import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { promptRecord } from "../lib/prompt-authorship.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";

const proofs = process.env.WIRE_CALL_PRESENTATION_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

function harborRecords() {
    return [
        ["archive", "Find the previous launch checklist.", 1800, true, null],
        ["planning", "Find the five latest Harbor launch planning documents.", 2100, false, "user"],
        ["retry", "Three documents are enough. I have signed in; please try again.", 1200, true, "user"],
        ["meeting", "Check the Harbor launch meeting.", null, true, "agent"],
        ["mail", "Find the Harbor launch email.", 1200, true, "user"],
    ].map(([id, text, durationMs, worked, actor], index) => {
        const record = fixture(`harbor-${id}`);
        record.projectId = id === "archive" ? "sample-archive" : "sample-harbor";
        record.project = `Sample workspace: ${id === "archive" ? "Archive" : "Harbor launch"}`;
        record.sourceSessionId = `sample-${id}`;
        record.sourceSessionName = `Sample: ${id === "archive" ? "Older checklist lookup" : "Harbor " + id}`;
        record.userPrompt = promptRecord({ type: "user.message", id: `harbor-prompt-${id}`, timestamp: `2026-10-10T09:0${index}:00.000Z`,
            data: { content: text, ...(actor ? { source: actor === "user" ? "user" : "agent-harbor" } : {}) } });
        record.followUpPrompts = [];
        const target = id === "meeting" ? "/me/events" : id === "mail" ? "/me/messages" : "/me/drive/root/children";
        record.toolCalls = [{ ...record.toolCalls[0], toolCallId: `harbor-call-${id}`, startEventId: `harbor-start-${id}`,
            requestArgs: { entityUrls: [target] }, requestedApiPath: target,
            startedAt: `2026-10-10T09:0${index}:01.000Z`, durationMs,
            completedAt: durationMs === null ? null : new Date(Date.parse(`2026-10-10T09:0${index}:01.000Z`) + durationMs).toISOString(),
            toolSucceeded: worked, reportedOutcome: worked ? "succeeded" : "failed",
            apiResults: worked ? [{ index: 0, path: target, statusCode: 200 }] : [{ index: 0, path: target, statusCode: 401, errorCode: "SignInRequired" }] }];
        return record;
    });
}

async function setup(t, records = harborRecords()) {
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    let providers = 0, snapshot;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { providers++; throw Error("No provider in call presentation proof."); },
            readSource: async () => { providers++; throw Error("No source reads in call presentation proof."); } } });
    const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
    const contextBrowser = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce",
        timezoneId: "UTC", locale: "en-US" });
    const page = await contextBrowser.newPage(), denied = [], errors = [];
    page.setDefaultTimeout(6000);
    const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/evaluation/automatic/summary", "/api/report-artifacts/list"];
    await contextBrowser.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    await contextBrowser.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No real clipboard reads."); }, async writeText(text) { window.copiedCallText = text; },
    } }));
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(denied, []); assert.deepEqual(errors, []); assert.equal(providers, 0);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url); await ready(page); await chooseTheme(page, "dark");
    await page.evaluate(() => document.fonts.ready);
    return { page, runtime, records, snapshot: () => snapshot };
}

async function capture(page, name, locator) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true }); await frames(page);
    const scroll = await page.evaluate(() => scrollY);
    await page.evaluate(() => scrollTo(0, 0)); await frames(page);
    await page.screenshot({ path: path.join(proofs, `${name}-page.png`), fullPage: true });
    await page.evaluate(scroll => scrollTo(0, scroll), scroll); await frames(page);
    if (locator) {
        const box = await locator.boundingBox();
        const available = await page.evaluate(() => innerHeight - document.querySelector(".app-header").getBoundingClientRect().height - 24);
        if (box.height <= available) await locator.screenshot({ path: path.join(proofs, `${name}-focused.png`) });
        else {
            await locator.evaluate(node => scrollBy(0, node.getBoundingClientRect().top
                - document.querySelector(".app-header").getBoundingClientRect().height - 12));
            await frames(page);
            await page.screenshot({ path: path.join(proofs, `${name}-focused.png`) });
        }
    }
    await writeFile(path.join(proofs, `${name}.txt`), await page.locator("#workspace").ariaSnapshot());
}

test("Calls identify the tool and labeled result, with concise sorting and exact context return", async t => {
    const app = await setup(t), { page } = app;
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    await selectActivityOption(page, "callSort", "fastest"); await ready(page);
    const durations = await page.locator(".matched-action .call-duration").allTextContents();
    assert.deepEqual(durations.map(value => value.match(/[\d,]+(?= ms)/)?.[0] ?? null), ["1,200", "1,200", "1,800", "2,100", null]);
    const target = page.locator('.matched-action').filter({ has: page.locator('.request-link[href*="harbor-archive"]') });
    await target.scrollIntoViewIfNeeded();
    await capture(page, "calls-dark", target);
    const geometry = await target.evaluate(node => {
        const rect = selector => { const b = node.querySelector(selector).getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
        return { tool: rect(".card-tool-name"), result: rect(".recorded-result"), card: rect(".full-text"),
            height: node.getBoundingClientRect().height, text: node.textContent };
    });
    const sortCopy = await page.locator("#callSortControls").innerText();
    const archive = app.snapshot().scenarios.find(record => record.scenarioId === "harbor-archive");
    const link = target.locator(".request-link");
    await link.focus(); await frames(page);
    const origin = page.url(), position = await link.boundingBox();
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-tool-call-id", "harbor-call-archive");
    await expect(page.locator("#selectedCall")).toBeFocused();
    await expect(page.locator("#selectedCall")).toContainText("/me/drive/root/children");
    await expect(page.locator("#requestContent")).toContainText("Find the previous launch checklist.");
    await capture(page, "exact-call-dark", page.locator("#selectedCall"));
    const detail = await page.locator("#selectedCall").innerText();
    await page.locator("#contextBack").click(); await ready(page); await frames(page);
    assert.equal(page.url(), origin); await expect(link).toBeFocused();
    assert.ok(Math.abs((await link.boundingBox()).y - position.y) < 3);
    if (proofs) await writeFile(path.join(proofs, "call-presentation.json"), JSON.stringify({ geometry, sortCopy, detail,
        archivePrompt: archive.userPrompt, nativeScrollbar: await page.evaluate(() => innerWidth - document.documentElement.clientWidth) }, null, 2));
    assert.match(geometry.text, /Who sent this was not recorded/, "Missing sender evidence is honest, not guessed from prompt prose");
    assert.doesNotMatch(sortCopy, /canonical record ID|for one record, not task latency/, "Implementation mechanics must not dominate the sort bar");
    assert.ok(geometry.tool.y > geometry.card.y, "The actual prompt leads the separately labeled call facts");
    await expect(target.locator(".activity-card-facts>div").filter({ has: page.locator("dt", { hasText: /^Tool completion:$/ }) }))
        .toContainText("1 Worked");
    const failed = page.locator(".matched-action").filter({ has: page.locator('.request-link[href*="harbor-planning"]') });
    await expect(failed.locator(".action-error")).toHaveText("Reported HTTP 401: SignInRequired");
    await expect(failed.locator("[data-outcome=failure]")).toHaveAttribute("data-count", "1");
    await capture(page, "calls-failed-dark", failed);
    await capture(page, "call-sort-dark", page.locator("#callSortControls"));
});

test("call facts, original text and one-level technical details survive narrow enlarged reading", async t => {
    const records = harborRecords();
    records[0].userPrompt.text += "\n  Keep these original spaces.  \n" + "This is an invented Harbor context paragraph. ".repeat(30);
    const { page } = await setup(t, records), measurements = [];
    for (const [theme, width, scale] of [["light", 1280, 1], ["dark", 375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
        const card = page.locator(".matched-action").filter({ has: page.locator('.request-link[href*="harbor-archive"]') });
        const link = card.locator(".request-link");
        await link.hover();
        await capture(page, `calls-${theme}-${width}-${scale}-hover`, card);
        const before = await link.boundingBox();
        await page.mouse.down(); const pressed = await link.boundingBox();
        await page.mouse.move(0, 0); await page.mouse.up();
        assert.deepEqual(pressed, before, "Press does not move or scale the exact-call action");
        await card.locator(".full-text-toggle").click();
        await expect(card.locator(".full-text-body pre")).toHaveText(records[0].userPrompt.text);
        await card.getByRole("button", { name: "Copy prompt", exact: true }).click();
        assert.equal(await page.evaluate(() => window.copiedCallText), records[0].userPrompt.text);
        await card.locator(".full-text-toggle").click();
        await link.focus(); await page.keyboard.press("Enter"); await ready(page);
        const selected = page.locator("#selectedCall");
        await expect(selected).toHaveAttribute("data-tool-call-id", "harbor-call-archive");
        await expect(page.locator("#requestContent .full-text-content").first()).toHaveText(records[0].userPrompt.text);
        const technical = selected.locator(":scope > .detail-disclosure");
        const summary = technical.locator(":scope > summary");
        await summary.focus(); await page.keyboard.press("Enter");
        await expect(technical).toHaveAttribute("open", "");
        await expect(technical.locator("details")).toHaveCount(0);
        await expect(technical.locator("pre").first()).toHaveText(JSON.stringify(records[0].toolCalls[0].requestArgs, null, 2));
        await technical.getByRole("button", { name: "Copy recorded arguments", exact: true }).click();
        assert.equal(await page.evaluate(() => window.copiedCallText), JSON.stringify(records[0].toolCalls[0].requestArgs, null, 2));
        await capture(page, `exact-${theme}-${width}-${scale}-expanded`, selected);
        const measured = await selected.evaluate(node => ({
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            font: getComputedStyle(node).fontFamily,
            clipped: [...node.querySelectorAll(".call-heading,.call-duration,.action-fields,.recorded-result,dt,dd,summary")]
                .filter(item => item.checkVisibility() && item.scrollWidth > item.clientWidth + 1).map(item => item.className),
            drawers: node.querySelectorAll(".technical-detail details").length,
        }));
        measurements.push({ theme, width, scale, ...measured });
        assert.ok(measured.overflow <= 1); assert.deepEqual(measured.clipped, []); assert.equal(measured.drawers, 0);
        assert.match(measured.font, /Asta Sans/);
        await summary.focus(); await page.keyboard.press("Space");
        await expect(technical).not.toHaveAttribute("open");
        await page.locator("#contextBack").click(); await ready(page);
        await expect(link).toBeFocused();
    }
    if (proofs) await writeFile(path.join(proofs, "responsive-call-reading.json"), JSON.stringify(measurements, null, 2));
});

test("overlapping aliases retain matching versus outside context without duplicate canonical calls", async t => {
    const first = fixture("a-owner"), second = fixture("b-overlap");
    second.toolCalls.unshift(structuredClone(first.toolCalls[0]));
    second.userPrompt.text = "Synthetic overlapping request";
    const { page } = await setup(t, [first, second]);
    const card = page.locator("#activityList .request-row").filter({ hasText: "Synthetic overlapping request" });
    await expect(card).toContainText("1 of 2 Work IQ tool calls matches this view");
    await card.locator(".request-link").click(); await ready(page);
    await expect(page.locator(".journey-item .action-context").filter({ hasText: "1 matching" })).toHaveCount(1);
    await expect(page.locator(".journey-item .action-context").filter({ hasText: "Outside current view" })).toHaveCount(1);
    await expect(page.locator(".full-request-results [data-result-layer=tool] [data-outcome=success]")).toHaveAttribute("data-count", "2");
    const actions = await page.locator(".journey-item[data-action-id]").evaluateAll(nodes => nodes.map(node => node.dataset.actionId));
    assert.equal(new Set(actions).size, actions.length);
});
