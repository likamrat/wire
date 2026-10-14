import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { recordedInteractionModels } from "../lib/interaction-model.mjs";
import { promptRecord } from "../lib/prompt-authorship.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const proofs = process.env.WIRE_READING_PROOFS;
async function capture(page, name) {
    if (!proofs) return;
    await page.evaluate(() => scrollTo(0, 0)); await frames(page);
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: true });
}

test("activity card and reader form one exact, private reading and return journey", { timeout: 45000 }, async t => {
    const record = fixture("reading-overhaul");
    record.sourceSessionName = "Quarterly research review";
    record.projectId = null; record.project = null;
    record.followUpPrompts = [];
    const promptEvent = { id: "reading-prompt", type: "user.message", timestamp: "2026-10-12T12:40:00.000Z",
        data: { messageId: "p", source: "user", content: "Review the slide deck I created for the research review when I joined the project" } };
    record.userPrompt = promptRecord(promptEvent);
    record.toolCalls = [{ tool: "workiq-ask", toolCallId: "reading-ask", startEventId: "reading-start",
        requestArgs: { question: record.userPrompt.text }, startedAt: "2026-10-12T12:40:10.000Z",
        completedAt: "2026-10-12T12:41:34.892Z", durationMs: 84892, toolSucceeded: true,
        reportedOutcome: "succeeded", apiResults: [], observedGraphHttp: false }];
    const events = [
        promptEvent,
        { id: "reading-response", type: "assistant.message", timestamp: "2026-10-12T12:41:54.090Z",
            data: { wireResponseMetadataVersion: 1, finalAnswer: true, hasResponseText: true, hasToolRequests: false, turnId: "t", originatingMessageId: "p", model: "recorded-model" } },
        { id: "reading-end", type: "assistant.turn_end", timestamp: "2026-10-12T12:41:54.091Z", data: { turnId: "t" } },
    ];
    record.responseTiming = recordedResponseTiming(events, record.userPrompt);
    record.originalModelEvidence = recordedInteractionModels(events, record);
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, [record]);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw Error("No provider in reading proof"); },
            readSource: async () => { throw Error("No source scan in reading proof"); } } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    const errors = [], denied = [], metrics = [];
    let snapshot;
    page.on("response", async response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET"
            || ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary"].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        async writeText(text) { (window.readingCopies ??= []).push(text); },
        readText() { throw Error("No OS clipboard access"); },
    } }));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const action of cleanup) await action(); }
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const [theme, width, scale] of [["dark", 1440, 1], ["light", 1440, 1], ["dark", 390, 1], ["light", 820, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(runtime.url + "#analyze"); await ready(page);
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const coverageOpen = theme === "dark";
        if (await page.locator("#coverage").evaluate(node => node.open) !== coverageOpen) await page.locator("#coverage > summary").click();
        const card = page.locator(".request-row"), open = card.locator(".request-link");
        await expect(card.locator(".response-timing data")).toHaveAttribute("value", "114090");
        await expect(card.locator(".response-timing data")).toHaveText("1:54 min");
        await expect(card.locator(".request-meta")).toContainText("Asked Copilot");
        await expect(card.locator(".request-meta [data-fluent-icon=chat_sparkle_24_regular]")).toHaveCount(1);
        await expect(card.locator(".request-meta [data-fluent-icon=question_circle_24_regular]")).toHaveCount(0);
        await expect(card.locator(".card-context")).toContainText("recorded-model");
        const cardFacts = await card.locator(".activity-card-facts>div").evaluateAll(nodes => nodes.map(node => ({
            key: getComputedStyle(node.querySelector("dt")).fontWeight,
            value: getComputedStyle(node.querySelector("dd")).fontWeight,
        })));
        assert.ok(cardFacts.length && cardFacts.every(fact => fact.key === "600" && fact.value === "400"));
        await card.getByRole("button", { name: "About Asked Copilot; recorded activity categories", exact: true }).click();
        await expect(page.getByRole("tooltip")).toContainText("Recorded attempt");
        await expect(page.getByRole("tooltip")).toContainText("not confirmation of delivery");
        await page.keyboard.press("Escape");
        assert.equal(snapshot.analytics.rows[0].workload, "Unknown");
        const promptStyle = await card.locator(".full-text-preview").evaluate(node => {
            const css = getComputedStyle(node);
            return { font: css.fontFamily, size: css.fontSize, weight: css.fontWeight, style: css.fontStyle };
        });
        await open.focus(); await frames(page);
        const origin = page.url();
        const name = `${theme}-${width}-${scale}x`;
        if (proofs) {
            await capture(page, `${name}-analyze`);
            await card.screenshot({ path: path.join(proofs, `${name}-card.png`) });
        }
        await open.focus(); await frames(page);
        const position = await open.boundingBox();
        await page.keyboard.press("Enter"); await ready(page); await frames(page);
        await expect(page.locator(".request-original .full-text-content")).toHaveText(record.userPrompt.text);
        await expect(page.locator(".request-original .response-timing data")).toHaveAttribute("value", "114090");
        await expect(page.locator(".request-original .response-timing data")).toHaveText("1:54 min");
        await expect(page.locator(".interaction-response")).toContainText(/Capture is off/i);
        await expect(page.locator(".call-heading h3")).toHaveText("workiq-ask");
        await expect(page.locator(".call-heading [data-fluent-icon=chat_sparkle_24_regular]")).toHaveCount(1);
        await expect(page.locator(".call-heading data")).toHaveAttribute("value", "84892");
        await expect(page.locator(".call-heading data")).toHaveText("1:25 min");
        await expect(page.locator("#coverage")).toBeHidden();
        assert.deepEqual(await page.locator(".request-original .full-text-content").evaluate(node => {
            const css = getComputedStyle(node);
            return { font: css.fontFamily, size: css.fontSize, weight: css.fontWeight, style: css.fontStyle };
        }), promptStyle);
        const metricsForView = await page.locator("#requestContent").evaluate(node => ({
            overflow: document.documentElement.scrollWidth - innerWidth,
            controls: [...node.querySelectorAll("button,summary")].filter(node => node.checkVisibility()).map(node => {
                const box = node.getBoundingClientRect();
                return { text: node.textContent, width: box.width, height: box.height, overflow: node.scrollWidth - node.clientWidth };
            }),
            readerTargets: [...node.querySelectorAll(".full-text-reader-actions button")].map(node => {
                const box = node.getBoundingClientRect();
                return { width: box.width, height: box.height };
            }),
            operationAlignment: (() => {
                const icon = node.querySelector(".operation-icon svg").getBoundingClientRect();
                const text = node.querySelector(".call-heading h3").getBoundingClientRect();
                return Math.abs(icon.y + icon.height / 2 - text.y - text.height / 2);
            })(),
            facts: [...node.querySelectorAll(".reader-facts dt")].map(key => ({
                key: getComputedStyle(key).fontWeight, value: getComputedStyle(key.nextElementSibling).fontWeight,
                keyColor: getComputedStyle(key).color, valueColor: getComputedStyle(key.nextElementSibling).color,
            })),
            text: node.innerText,
        }));
        metrics.push({ theme, width, scale, ...metricsForView });
        assert.ok(metricsForView.overflow <= 1);
        assert.ok(metricsForView.controls.every(control => control.overflow <= 1));
        assert.ok(metricsForView.readerTargets.every(control => control.width >= 44 && control.height >= 44));
        assert.ok(metricsForView.operationAlignment <= 1);
        assert.ok(metricsForView.facts.length && metricsForView.facts.every(fact =>
            fact.key === "600" && fact.value === "400" && fact.keyColor !== fact.valueColor));
        await capture(page, `${name}-reader`);
        const prompt = page.locator(".request-original");
        await prompt.getByRole("button", { name: "Copy prompt", exact: true }).click();
        assert.equal(await page.evaluate(() => window.readingCopies.at(-1)), record.userPrompt.text);
        await prompt.getByRole("button", { name: "Hide prompt", exact: true }).click();
        await expect(prompt.locator(".full-text-content")).toHaveCount(0);
        await prompt.getByRole("button", { name: "Read prompt", exact: true }).click();
        const call = page.locator('[data-tool-call-id="reading-ask"]');
        await call.getByText("Technical details", { exact: true }).click();
        await capture(page, `${name}-call-details`);
        await expect(call.locator("details").first()).toHaveAttribute("open", "");
        await expect(call).toContainText("workiq-ask");
        await expect(call).toContainText("12:41:34.892Z");
        await expect(call).toContainText("84892");
        await call.getByRole("button", { name: "Copy recorded arguments", exact: true }).click();
        assert.deepEqual(JSON.parse(await page.evaluate(() => window.readingCopies.at(-1))), record.toolCalls[0].requestArgs);
        await expect(page.locator(".request-support")).toBeVisible();
        await expect(page.locator("#coverage")).toBeHidden();
        const overview = page.locator(".request-context-summaries");
        await expect(overview).toContainText("Completion could not be verified for 1 call.");
        await expect(overview.locator(".assessment-findings")).toContainText("No saved AI review for this request.");
        assert.doesNotMatch(await overview.innerText(), /Notes on full interactions|Unassessed-check reasons|Current activity:|The date filter selects|How to read these results/);
        await expect(overview.locator(".reader-evidence-scope")).toContainText("answer correctness or permission");
        await overview.getByText("Saved check details", { exact: true }).click();
        await expect(overview.locator(".assessment-execution")).toContainText("No qualified outcome");
        await expect(overview.locator(".assessment-secondary-findings")).toContainText("completion event reference not retained");
        await overview.getByText("Saved check details", { exact: true }).click();
        await capture(page, `${name}-details`);
        await call.getByText("Technical details", { exact: true }).click();
        await capture(page, `${name}-review-overview`);
        await call.getByText("Technical details", { exact: true }).click();
        const readerUrl = page.url();
        await overview.getByRole("link", { name: "Collection coverage", exact: true }).click(); await ready(page);
        await expect(page.locator("#collectionStatusView")).toBeVisible();
        await page.goBack(); await ready(page);
        assert.equal(page.url(), readerUrl);
        await expect(overview).toBeVisible();
        await page.locator("#requestReportToggle").click();
        await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
        await expect(page.locator(".request-original .full-text-content")).toHaveText(record.userPrompt.text);
        await page.locator("#requestReportToggle").click();
        await call.getByText("Technical details", { exact: true }).click();
        await page.locator("#contextBack").click(); await ready(page); await frames(page);
        assert.equal(page.url(), origin);
        await expect(open).toBeFocused();
        assert.ok(Math.abs((await open.boundingBox()).y - position.y) < 3);
        await expect(page.locator("#coverage > summary")).toBeVisible();
        assert.equal(await page.locator("#coverage").evaluate(node => node.open), coverageOpen);
    }
    if (proofs) await writeFile(path.join(proofs, "reading-measurements.json"), JSON.stringify(metrics, null, 2));
});
