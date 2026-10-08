import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";

const proof = process.env.WIRE_SELECTION_STABILITY_PROOFS;
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function setup(t, width, longNames, { aliases = false } = {}) {
    const records = Array.from({ length: 12 }, (_, i) => {
        const row = fixture(`steady-selection-${i}`);
        row.sourceSessionId = `steady-chat-${Math.floor(i / 4)}`;
        row.sourceSessionName = longNames ? `Invented planning conversation ${Math.floor(i / 4) + 1} for the cross-team launch and weekly milestones` : `Invented chat ${Math.floor(i / 4) + 1}`;
        row.project = longNames ? "Invented project with a long wrapping name for shared planning and delivery" : "Invented planning";
        row.userPrompt = { ...row.userPrompt, sourceEventId: `prompt-${i}`, text: `Invented request ${i + 1}. ` + "Review the fictional milestones and summarize the next step. ".repeat(8) };
        row.followUpPrompts = [];
        return row;
    });
    if (aliases) records[1].toolCalls.unshift(structuredClone(records[0].toolCalls[0]));
    const cleanup = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    const requests = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    t.after(async () => {
        await browser.close(); await runtime.close();
        const after = await loadBoardState(context);
        assert.deepEqual(after.evidence, before.evidence);
        assert.deepEqual(after.exports, before.exports);
        assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
        for (const fn of cleanup) await fn();
        assert.deepEqual(errors, []);
        assert.ok(requests.every(url => ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(url)), JSON.stringify(requests));
    });
    await page.goto(runtime.url + "#activity");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#activityInsights")).not.toHaveAttribute("aria-busy", "true");
    await page.evaluate(() => document.fonts.ready);
    return { page, requests, runtime };
}
async function observe(page, checkbox) {
    await checkbox.evaluate(node => {
        const row = node.closest(".request-row"), chat = node.closest(".session-group");
        const box = element => {
            const r = element.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, documentY: r.y + scrollY };
        };
        const trace = [];
        let running = true;
        const sample = () => ({
            scrollY, checkbox: box(node), row: box(row), chat: box(chat),
            reportBar: box(document.querySelector("#reportSelectionBar")),
            sessionMeta: box(chat.querySelector(".session-meta")),
            checked: node.checked, same: node.isConnected && row.isConnected,
            focus: document.activeElement === node,
            chatOpen: chat.querySelector(".session-toggle").getAttribute("aria-expanded"),
            selected: document.querySelector("#activitySelectionSummary").textContent,
            local: chat.querySelector("[data-session-selection]").textContent,
            promptOpen: row.querySelector(".full-text-toggle")?.getAttribute("aria-expanded"),
        });
        trace.push(sample());
        const next = () => { if (running) { trace.push(sample()); requestAnimationFrame(next); } };
        requestAnimationFrame(next);
        window.stopSelectionTrace = () => { running = false; trace.push(sample()); return trace; };
    });
}
async function capture(page, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.screenshot({ path: path.join(proof, name + ".png") });
}

for (const [width, longNames, scale] of [[1200, false, 1], [1200, true, 1], [375, true, 1], [375, true, 2]]) test(`request selection keeps its reading anchor at ${width}px/${scale * 100}% with ${longNames ? "wrapping" : "short"} names`, { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, width, longNames);
    if (width === 375) await chooseTheme(page, "dark");
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${100 * scale}%`; }, scale);
    const chat = page.locator('.session-group[data-session-id="steady-chat-1"]');
    await chat.locator(".session-toggle").click();
    const checkbox = chat.locator(".request-row input[type=checkbox]").nth(2);
    await checkbox.scrollIntoViewIfNeeded();
    await page.evaluate(id => {
        const node = document.getElementById(id);
        scrollTo(0, scrollY + node.getBoundingClientRect().top - 450);
    }, await checkbox.getAttribute("id"));
    await checkbox.focus(); await frames(page);
    const initialRequests = requests.length, url = page.url(), failures = [];
    for (const action of ["pointer-select", "pointer-clear", "keyboard-select", "keyboard-clear"]) {
        await observe(page, checkbox);
        await capture(page, `${width}-${longNames}-${scale}-${action}-before`);
        if (action.startsWith("pointer")) await checkbox.click(); else await page.keyboard.press("Space");
        await frames(page);
        await capture(page, `${width}-${longNames}-${scale}-${action}-after`);
        const trace = await page.evaluate(() => window.stopSelectionTrace());
        if (proof) await writeFile(path.join(proof, `${width}-${longNames}-${scale}-${action}.json`), JSON.stringify(trace, null, 2));
        const before = trace[0], last = trace.at(-1);
        t.diagnostic(JSON.stringify({ action, before: { y: before.checkbox.y, scroll: before.scrollY, documentY: before.row.documentY, bar: before.reportBar.height, meta: before.sessionMeta.height },
            after: { y: last.checkbox.y, scroll: last.scrollY, documentY: last.row.documentY, bar: last.reportBar.height, meta: last.sessionMeta.height } }));
        for (const sample of trace) {
            if (sample.checkbox.y !== before.checkbox.y || sample.scrollY !== before.scrollY || sample.row.y !== before.row.y) failures.push({ action, before, sample });
            assert.ok(sample.same && sample.focus);
            assert.equal(sample.chatOpen, "true");
            assert.deepEqual(sample.chat, before.chat, "Chat context remains fixed, not just the anchored checkbox.");
            assert.deepEqual(sample.sessionMeta, before.sessionMeta);
            assert.deepEqual(sample.reportBar, before.reportBar);
        }
        assert.equal(last.checked, action.endsWith("select"));
        assert.equal(page.url(), url);
    }
    assert.equal(requests.length, initialRequests, "Checkbox changes are local selection only.");
    assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 1)));
});

test("multiple selection across chats keeps digit growth and an expanded prompt in place", async t => {
    const { page } = await setup(t, 1200, true);
    for (const toggle of await page.locator(".session-toggle").all()) await toggle.click();
    const boxes = page.locator(".request-row input[type=checkbox]");
    for (let i = 0; i < 9; i++) await boxes.nth(i).check();
    const tenth = boxes.nth(9), row = tenth.locator("..");
    await row.locator(".full-text-toggle").click();
    await tenth.scrollIntoViewIfNeeded();
    await page.evaluate(id => { const r = document.getElementById(id).getBoundingClientRect(); scrollTo(0, scrollY + r.top - 350); }, await tenth.getAttribute("id"));
    await tenth.focus(); await frames(page);
    await observe(page, tenth);
    await capture(page, "multiple-expanded-before");
    await page.keyboard.press("Space"); await frames(page);
    await capture(page, "multiple-expanded-after");
    const trace = await page.evaluate(() => window.stopSelectionTrace());
    if (proof) await writeFile(path.join(proof, "multiple-expanded.json"), JSON.stringify(trace, null, 2));
    for (const frame of trace) {
        assert.equal(frame.scrollY, trace[0].scrollY);
        assert.deepEqual(frame.checkbox, trace[0].checkbox);
        assert.deepEqual(frame.row, trace[0].row);
        assert.deepEqual(frame.reportBar, trace[0].reportBar);
        assert.equal(frame.promptOpen, "true");
        assert.ok(frame.same && frame.focus);
    }
    assert.equal(await boxes.filter({ visible: true }).evaluateAll(nodes => nodes.filter(node => node.checked).length), 10);
    await expect(page.locator("#scopeCount-selected")).toHaveText("10 request groups");
    await expect(page.locator("#activitySelectionCompact")).toHaveText("10 in report");
    await expect(page.locator("#activitySelectionSummary")).toHaveText("One report · 10 request groups included");
    const local = row.locator("xpath=ancestor::section[contains(@class,'session-group')]").locator(".session-selected");
    await expect(local).toHaveText("2 in report");
    assert.match(await local.getAttribute("title"), /Complete eligible request groups, not only matching calls/);
});

test("selection and later read completion do not reclaim a user's subsequent scroll", { timeout: 20000 }, async t => {
    const { page } = await setup(t, 1200, true);
    const chat = page.locator('.session-group[data-session-id="steady-chat-1"]');
    await chat.locator(".session-toggle").click();
    const checkbox = chat.locator(".request-row input[type=checkbox]").nth(1);
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/collection/status", async route => {
        const response = await route.fetch(); enter(); await gate; await route.fulfill({ response });
    }, { times: 1 });
    t.after(() => release());
    await entered;
    await checkbox.scrollIntoViewIfNeeded(); await checkbox.click(); await frames(page);
    await page.mouse.move(1100, 700);
    await page.mouse.wheel(0, 230);
    await page.waitForFunction(() => !document.querySelector("#workspace").matches('[aria-busy="true"]'));
    await page.waitForTimeout(150);
    const userPosition = await page.evaluate(id => ({ scroll: scrollY, y: document.getElementById(id).getBoundingClientRect().y }), await checkbox.getAttribute("id"));
    const response = page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
    release(); await response; await frames(page); await page.waitForTimeout(150);
    const after = await page.evaluate(id => ({ scroll: scrollY, y: document.getElementById(id).getBoundingClientRect().y }), await checkbox.getAttribute("id"));
    assert.deepEqual(after, userPosition, "No deferred callback moves back to the selection-time reading position.");
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeFocused();
    await expect(chat.locator(".session-toggle")).toHaveAttribute("aria-expanded", "true");
    await capture(page, "after-user-scroll");
});

test("selection summary preserves canonical alias membership and full-scope detail without header movement", async t => {
    const { page } = await setup(t, 1200, true, { aliases: true });
    const chat = page.locator('.session-group[data-session-id="steady-chat-0"]');
    await chat.locator(".session-toggle").click();
    const checkbox = chat.locator('.request-row input[id="select-request-steady-selection-1"]');
    await chat.scrollIntoViewIfNeeded();
    await checkbox.scrollIntoViewIfNeeded(); await checkbox.focus(); await frames(page);
    await observe(page, checkbox);
    await capture(page, "chat-context-before");
    await checkbox.click(); await frames(page);
    await capture(page, "chat-context-selected");
    const trace = await page.evaluate(() => window.stopSelectionTrace());
    for (const sample of trace) {
        assert.equal(sample.scrollY, trace[0].scrollY);
        assert.deepEqual(sample.checkbox, trace[0].checkbox);
        assert.deepEqual(sample.chat, trace[0].chat);
    }
    await expect(page.locator("#activitySelectionCompact")).toHaveText("2 in report");
    await expect(page.locator("#activitySelectionSummary")).toHaveText("One report · 2 request groups included");
    await expect(page.locator("#scopeCount-selected")).toHaveText("2 request groups");
    await expect(chat.locator(".session-selected")).toHaveText("2 in report");
    assert.match(await chat.locator(".session-selected").getAttribute("title"), /2 request groups in this Copilot chat.*Complete eligible request groups/);
    await page.evaluate(() => scrollTo(0, 0));
    await capture(page, "selection-toolbar-selected");
    await checkbox.scrollIntoViewIfNeeded();
    await checkbox.uncheck(); await frames(page);
    await expect(page.locator("#activitySelectionCompact")).toHaveText("0 in report");
    await expect(page.locator("#activitySelectionSummary")).toHaveText("No requests selected");
    await expect(page.locator("#activityClearSelection")).toBeDisabled();
    await expect(checkbox).toBeFocused();
    await page.evaluate(() => scrollTo(0, 0));
    await capture(page, "selection-toolbar-empty");
});
