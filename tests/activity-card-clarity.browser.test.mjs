import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

const proofs = process.env.WIRE_CARD_PROOFS;
const longPrompt = "Please revise the workshop checklist without adding new sections or changing its scope. Several steps repeat or conflict: equipment checks must finish before the room opens. Preserve the remaining notes and confirm each correction.";
const shortPrompt = "Where did the workshop preparation stop? Continue checking the remaining equipment and explain what is still needed before opening.";

function records() {
    return Array.from({ length: 8 }, (_, index) => {
        const record = fixture("card-clarity-" + index);
        record.userPrompt = { text: index === 1 ? "" : index === 0 ? shortPrompt : longPrompt,
            status: "full", authorship: { actor: index === 0 ? "user" : "agent", basis: index === 0 ? "source-user" : "autopilot" },
            sourceEventId: "prompt-" + index, sourceTimestamp: new Date(Date.UTC(2026, 9, 18, 12, 8 - index)).toISOString() };
        record.followUpPrompts = index === 1 ? [{ ...record.userPrompt, sourceEventId: "empty-follow-up" }] : [];
        record.toolCalls = Array.from({ length: index === 2 ? 6 : 1 }, (_, call) => ({
            tool: index === 1 ? "workiq-retrieve" : "workiq-fetch",
            toolCallId: "clarity-call-" + index + "-" + call, startEventId: "clarity-start-" + index + "-" + call,
            startedAt: record.userPrompt.sourceTimestamp, requestArgs: { query: "SYNTHETIC_ARGUMENT_NOT_A_PROMPT" },
            reportedOutcome: index < 2 || call > 3 ? "failed" : "succeeded",
            toolSucceeded: !(index < 2 || call > 3), apiResults: [],
            ...index === 1 ? { failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
                messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required" } } : {},
        }));
        return record;
    });
}

async function setup(t, evidence = records()) {
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, evidence);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const errors = [], denied = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const fn of cleanup) await fn(); }
    });
    await page.goto(runtime.url + "#analyze");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page };
}

async function measure(page) {
    return page.locator(".request-card-open").evaluateAll(nodes => nodes.map(node => {
        const prompt = node.querySelector(".request-card-prompt"), style = getComputedStyle(prompt);
        const range = document.createRange(); range.selectNodeContents(prompt);
        const box = prompt.getBoundingClientRect();
        const lines = [...new Set([...range.getClientRects()].filter(rect => rect.height > 0 && rect.y < box.bottom)
            .map(rect => Math.round(rect.y)))];
        const card = node.getBoundingClientRect();
        return { card: card.toJSON(), prompt: box.toJSON(), lines: lines.length,
            font: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
            weight: style.fontWeight,
            outcomes: [...node.querySelectorAll(".recorded-result")].map(n => n.getBoundingClientRect().toJSON()),
            authors: [...node.querySelectorAll(".request-card-author")].flatMap(n => [...n.getClientRects()].map(r => r.toJSON())),
            time: node.querySelector(".request-card-time").getBoundingClientRect().toJSON(),
            text: prompt.textContent };
    }));
}

async function capture(page, name, metrics) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.mouse.move(0, 0);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(proofs, name + "-page.png"), fullPage: true });
    const clip = await page.locator("#activityList").evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
    });
    await page.screenshot({ path: path.join(proofs, name + "-list.png"), fullPage: true, clip });
    if (await page.locator("#contextSidebar").isVisible()) {
        await page.locator("#contextSidebar").screenshot({ path: path.join(proofs, name + "-reader.png") });
    }
    await writeFile(path.join(proofs, name + ".json"), JSON.stringify(metrics, null, 2));
}

test("Activity recognition never becomes a three-line paragraph at the live composed width", async t => {
    const { page } = await setup(t);
    const views = [];
    for (const [width, scale] of [[1440, 1], [1024, 1.4], [820, 2], [390, 1], [390, 2]]) {
        for (const theme of ["dark", "light"]) {
            await page.setViewportSize({ width, height: 1000 });
            await chooseTheme(page, theme);
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
            await page.waitForFunction(() => !document.documentElement.getAnimations({ subtree: true })
                .some(animation => animation.playState === "running" && Number.isFinite(animation.effect.getComputedTiming().iterations)));
            const metrics = await measure(page), name = `${width}-${scale}-${theme}`;
            await capture(page, name, metrics);
            views.push({ name, metrics });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ": no page overflow");
        }
    }
    assert.equal(views[0].metrics.length, 8);
    assert.equal(views[0].metrics[0].fontSize, "14px");
    assert.equal(views[0].metrics[0].card.width, 1196);
    for (const { name, metrics } of views) {
        assert.ok(metrics.every(row => row.lines <= 2), name + ": " + JSON.stringify(metrics.map(row => ({ lines: row.lines, height: row.card.height }))));
        assert.ok(metrics.every(row => row.authors.every(box => box.left >= row.card.left && box.right <= row.card.right)),
            name + ": author must remain wholly readable");
        for (const row of metrics) {
            assert.match(row.font, /Asta Sans/);
            assert.equal(row.weight, "400");
            assert.ok(row.card.height >= 44, name + ": full-card target");
            assert.ok(row.outcomes.every(box => box.top >= row.prompt.bottom && box.left >= row.card.left && box.right <= row.card.right),
                name + ": outcomes stay separate from the preview and inside the card");
            assert.ok(row.time.top >= row.prompt.bottom && row.time.right <= row.card.right, name + ": time stays readable");
            for (const outcome of row.outcomes) {
                if (Math.abs(row.time.top - outcome.top) < 4) {
                    assert.ok(Math.abs(row.time.top + row.time.height / 2 - outcome.top - outcome.height / 2) <= 1,
                        name + ": time and outcome share their row's optical center");
                }
            }
        }
    }
    assert.ok(views[0].metrics.every(row => row.lines === 1), "Wide cards use one recognition line.");
});

test("An empty retained agent message remains recognizable without pretending its arguments are a prompt", async t => {
    const { page } = await setup(t);
    const card = page.locator('.request-card-open[href*="card-clarity-1"]');
    await expect(card).not.toContainText("Prompt not available");
    await expect(card.locator(".request-card-author")).toHaveText("Automatic continuation");
    await expect(card).toContainText("No new message was sent.");
    await expect(card).toContainText("workiq-retrieve");
    await expect(card).not.toContainText("SYNTHETIC_ARGUMENT_NOT_A_PROMPT");
    await card.click();
    await expect(page.locator("#requestContent")).toContainText("Sign-in was required");
    await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(1);
    await expect(page.locator("#requestContent")).not.toContainText(shortPrompt);
    await expect(page.locator("#requestContent")).not.toContainText(longPrompt);
    const prompt = page.locator('[data-reader-section="prompt"]');
    await expect(prompt).toContainText("Automatic continuation");
    await expect(prompt).toContainText("No new message was sent.");
    await expect(prompt.locator("pre, .ux-copy")).toHaveCount(0);
    await capture(page, "automatic-reader", []);
    await page.goBack();
    await expect(card).toBeFocused();
});

test("bounded card preview still opens the full exact authorized message and returns to its link", async t => {
    const { page } = await setup(t);
    const card = page.locator('.request-card-open[href*="card-clarity-2"]');
    await expect(card.locator("button,input,a")).toHaveCount(0);
    await card.focus(); await page.keyboard.press("Enter");
    await expect(page.locator('[data-reader-section="prompt"] .full-text-content')).toHaveText(longPrompt);
    await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(6);
    await page.goBack();
    await expect(card).toBeFocused();
});

test("unavailable and empty nonautomatic records retain their own identity without false continuation or recovery", async t => {
    const evidence = records();
    evidence[0].userPrompt = { ...evidence[0].userPrompt, text: null, status: "unavailable" };
    evidence[1].userPrompt = { ...evidence[1].userPrompt, text: "EXCLUDED_TEXT_MUST_NOT_APPEAR", status: "unavailable" };
    evidence[2].userPrompt = { ...evidence[2].userPrompt, text: "", authorship: { actor: "unknown", basis: "conflicting-source" } };
    const { page } = await setup(t, evidence);
    for (const [index, label, notice] of [[0, "My activity", "Prompt text unavailable"],
        [1, "Agent activity", "Prompt text unavailable"], [2, "Author unverified", "No prompt text retained"]]) {
        const card = page.locator(`.request-card-open[href*="card-clarity-${index}"]`);
        await expect(card.locator(".request-card-author")).toHaveText(label);
        await expect(card).toContainText(notice);
        await expect(card).not.toContainText("Automatic continuation");
        await card.click();
        const prompt = page.locator('[data-reader-section="prompt"]');
        await expect(prompt).toContainText(notice + ".");
        await expect(prompt.locator("pre, .ux-copy")).toHaveCount(0);
        await expect(page.locator("#requestContent")).not.toContainText("EXCLUDED_TEXT_MUST_NOT_APPEAR");
        await page.goBack();
    }
});

test("cards and the reader distinguish observed automatic control, known gaps and unknown absence", async t => {
    const evidence = records();
    evidence[1].userPrompt = { ...evidence[1].userPrompt,
        authorship: { actor: "unknown", basis: "conflicting-source" },
        capture: { version: 1, kind: "automatic-continuation", original: "empty", hostContext: "not-collected", reason: null } };
    evidence[0].userPrompt = { text: null, status: "unavailable", authorship: { actor: "unknown", basis: "missing-source" },
        capture: { version: 1, kind: "unknown", original: "unavailable", hostContext: "unknown", reason: "malformed-line" } };
    evidence[2].userPrompt = { text: "", status: "full", authorship: { actor: "unknown", basis: "legacy-missing" } };
    const { page } = await setup(t, evidence);
    for (const [index, label, notice] of [
        [1, "Automatic continuation", "No new message was sent."],
        [0, "Author unverified", "Prompt unavailable: a saved history entry could not be read."],
        [2, "Author unverified", "No prompt text retained"],
    ]) {
        const card = page.locator(`.request-card-open[href*="card-clarity-${index}"]`);
        await expect(card.locator(".request-card-author")).toHaveText(label);
        await expect(card.locator(".request-card-author")).toHaveAttribute("data-prompt-actor", "unknown");
        await expect(card).toContainText(notice);
        await card.click();
        const prompt = page.locator('[data-reader-section="prompt"]');
        await expect(prompt).toContainText(notice);
        await expect(prompt.locator("pre, .ux-copy")).toHaveCount(0);
        if (index === 1) {
            await expect(prompt.locator("h2")).toHaveText("Automatic continuation");
            await expect(prompt).not.toContainText("Prompt unavailable");
        } else await expect(prompt).not.toContainText("No new message was sent");
        await capture(page, `capture-state-${index}`, []);
        await page.goBack();
    }
});
