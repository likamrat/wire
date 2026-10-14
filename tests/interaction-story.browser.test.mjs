import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { promptRecord } from "../lib/prompt-authorship.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { recordedInteractionModels } from "../lib/interaction-model.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

test("a completed call without a saved reply is not three zero-score review cards", { timeout: 30000 }, async t => {
    const record = fixture("unreviewed-story");
    record.sourceSessionName = "Launch deck review";
    record.projectId = null; record.project = null;
    const prompt = { id: "story-prompt", type: "user.message", timestamp: "2026-10-12T12:00:00Z",
        data: { source: "user", messageId: "story-message", content: "Review the invented launch deck." } };
    record.userPrompt = promptRecord(prompt);
    record.followUpPrompts = [];
    record.toolCalls = [{ tool: "workiq-ask", toolCallId: "story-call", startEventId: "story-start", completionEventId: "story-end",
        startedAt: "2026-10-12T12:00:10Z", completedAt: "2026-10-12T12:01:34.892Z", durationMs: 84892,
        toolSucceeded: true, reportedOutcome: "succeeded", requestArgs: {
            question: "Find the launch deck drafted for the internal planning workshop. Identify its title and date, then review the slides in order. Explain whether the intended audience and central claim are clear, whether the supporting examples match the conclusions, where assumptions need evidence, and which three edits would most improve readability. Use only the recorded document content, and say when a detail cannot be checked.",
            timeZone: "UTC",
        }, apiResults: [] }];
    const events = [prompt,
        { id: "story-final", type: "assistant.message", timestamp: "2026-10-12T12:01:54.089Z",
            data: { originatingMessageId: "story-message", phase: "final_answer", toolRequests: [], model: "recorded-model", content: "Invented reply metadata only.", turnId: "story-turn" } },
        { id: "story-turn-end", type: "assistant.turn_end", timestamp: "2026-10-12T12:01:54.090Z", data: { turnId: "story-turn" } },
    ];
    record.responseTiming = recordedResponseTiming(events, record.userPrompt);
    record.originalModelEvidence = recordedInteractionModels(events, record);
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, [record]);
    const before = await loadBoardState(context), runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    const denied = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET"
            || ["/api/snapshot", "/api/assessment/detail", "/api/assessment/overview", "/api/collection/status", "/api/evaluation/automatic/summary"].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(denied, []); assert.deepEqual(errors, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key]);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#request?request=unreviewed-story");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.waitForFunction(() => !document.querySelector("#requestContent .assessment-loading"));
    const reader = page.locator("#requestContent");
    while (await reader.locator("details:not([open]) > summary:visible").count()) await reader.locator("details:not([open]) > summary:visible").first().click();
    await expect(reader.locator(".call-heading")).toContainText("1 Worked");
    await expect(reader.locator(".interaction-response")).toContainText("No saved response.");
    await expect(reader.locator(".interaction-response .reader-empty")).toHaveText("No saved response. Capture is off.");
    await expect(reader.locator(".interaction-response .reader-response-note")).toHaveCount(0);
    await expect(reader.locator(".recorded-arguments .ux-code-label")).toHaveText("Tool input (recorded)");
    await expect(reader.locator(".response-timing data")).toHaveAttribute("value", "114089");
    await expect(reader.locator(".assessment-check")).toHaveCount(0);
    assert.doesNotMatch(await reader.innerText(), /0 of 1 request assessed|No pass percentage|Local rules do not assess quality/);
    assert.doesNotMatch(await reader.innerText(), /Review Automatic scores to approve|Saving replies alone does not enable/);
    await expect(reader).toContainText("No saved AI review for this request.");
    const proofs = process.env.WIRE_STORY_PROOFS;
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await writeFile(path.join(proofs, "expanded-reader.txt"), await reader.innerText());
        for (const theme of ["dark", "light"]) {
            await chooseTheme(page, theme);
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proofs, theme + "-expanded-reader.png"), fullPage: true });
        }
    }
    await reader.getByRole("button", { name: "Details and feedback", exact: true }).click();
    const dialog = page.getByRole("dialog");
    while (await dialog.locator("details:not([open]) > summary:visible").count()) await dialog.locator("details:not([open]) > summary:visible").first().click();
    assert.doesNotMatch(await dialog.innerText(), /0 \/ 1 assessed|0 \/ 0 positive|Pass-share colors|Each median is/);
    await expect(dialog).toContainText("84892 ms");
    await expect(dialog).toContainText("unsupported-check");
    await expect(dialog).toContainText("semantic-answer-correctness");
    await expect(dialog.locator('[data-metric-ref][data-origin="automatic-local"]')).toHaveCount(8);
    await expect(dialog.locator('tr[data-metric-group="unreviewed"]')).toHaveCount(1);
    assert.ok(await dialog.locator(".single-measure-value").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).fontWeight === "400")));
    await expect(dialog).toContainText("Boundary not verified");
    await expect(dialog).toContainText("114089 ms");
    await expect(dialog.locator('[data-metric-status="unassessed"][data-value="null"][data-denominator="0"]')).toHaveCount(4);
    await expect(dialog.locator('[data-check-id="semantic-answer-correctness"]')).toHaveAttribute("data-unassessed", "1");
    await expect(dialog.locator('[data-check-id="semantic-answer-correctness"]')).toHaveAttribute("data-covered", "0");
    await expect(dialog.locator('[data-check-id="semantic-answer-correctness"]')).toHaveAttribute("data-eligible", "1");
    await expect(dialog.locator('tr[data-check-id="recorded-tool-success"]')).toHaveAttribute("data-pass", "1");
    if (proofs) {
        await writeFile(path.join(proofs, "expanded-definitions.txt"), await dialog.innerText());
        await page.setViewportSize({ width: 1280, height: 1800 });
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(proofs, "light-expanded-definitions.png") });
        await page.setViewportSize({ width: 390, height: 1000 });
        assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        await page.screenshot({ path: path.join(proofs, "narrow-expanded-definitions.png") });
        await dialog.locator("tr").last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(proofs, "narrow-final-definition.png") });
    }
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 1000 });
    assert.equal(await reader.locator(".recorded-arguments>pre").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    assert.deepEqual(JSON.parse(await reader.locator(".recorded-arguments>pre").textContent()), record.toolCalls[0].requestArgs);
    if (proofs) {
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(proofs, "narrow-expanded-reader.png"), fullPage: true });
    }
});
