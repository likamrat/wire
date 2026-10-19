import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { recordedInteractionModels } from "../lib/interaction-model.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { searchFixture } from "./live-search-fixture.mjs";
import { contrast } from "./color-measurements.mjs";

function clarityRecord() {
    const record = fixture("clarity-sign-in");
    record.sourceSessionName = "Invented workshop preparation";
    record.userPrompt = {
        text: "Find the workshop agenda and list the unresolved decisions.",
        status: "full", sourceEventId: "clarity-prompt", sourceTimestamp: "2026-10-01T12:00:00Z",
        authorship: { actor: "user", basis: "source-user" },
    };
    record.followUpPrompts = [];
    record.toolCalls = [{
        tool: "workiq-retrieve", toolCallId: "clarity-call", startEventId: "clarity-start",
        startedAt: "2026-10-01T12:00:01Z", durationMs: 252,
        toolSucceeded: false, reportedOutcome: "failed", apiResults: [],
        requestArgs: { query: "Invented workshop agenda" },
        failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
            messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required" },
    }];
    const events = [
        { id: "clarity-prompt", type: "user.message", timestamp: record.userPrompt.sourceTimestamp,
            data: { messageId: "clarity-message" } },
        { id: "clarity-response", type: "assistant.message", timestamp: "2026-10-01T12:00:02Z",
            data: { originatingMessageId: "clarity-message", model: "recorded-model", turnId: "clarity-turn" } },
    ];
    record.originalModelEvidence = recordedInteractionModels(events, record);
    return record;
}

async function setup(t, record = clarityRecord()) {
    const cleanup = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, Array.isArray(record) ? record : [record]);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], blocked = [];
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET"
            || ["/api/snapshot", "/api/connect", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(url.pathname))) return route.continue();
        blocked.push(url.pathname);
        return route.abort();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []);
            assert.deepEqual(blocked, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation", "pseudonymKey"]) assert.deepEqual(after[key], before[key]);
        } finally { for (const fn of cleanup) await fn(); }
    });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page, record, runtime };
}

test("a recorded failure explains its cause with the outcome from card to reader", async t => {
    const { page } = await setup(t);
    const card = page.locator(".request-card-open");
    await expect(card.locator('[data-outcome="failure"]')).toContainText("1 Tool failed");
    await expect(card).not.toContainText("Sign-in was required");
    await card.click();
    const call = page.locator('.journey-item[data-tool-call-id="clarity-call"]');
    await expect(call.locator(".call-heading")).toContainText("Sign-in was required");
    await expect(call.locator(".call-heading")).not.toContainText("Tool failed");
    await expect(call.locator(".reader-recorded-signal")).toHaveCount(0);
    assert.equal((await call.innerText()).match(/Sign-in was required/g)?.length, 1);
    await expect(call.locator(".reader-call-duration data")).toHaveAttribute("value", "252");
});

test("model identity is separate from an explained incomplete recording", async t => {
    const { page } = await setup(t);
    await page.locator(".request-card-open").click();
    await expect(page.locator(".interaction-model-fact .model-identity")).toHaveText("recorded-model");
    await expect(page.locator(".model-recording-note")).toContainText("final response");
    await expect(page.locator(".model-identity")).not.toContainText("(partial record)");
});

test("model recording reasons compose one qualified statement without losing any retained reason", async t => {
    const cases = [
        { name: "boundary-truncated", reasons: ["unverified-final-boundary", "truncated-history"],
            expected: "Model history is incomplete: the final response boundary was not verified; a source window or retention limit cut it short." },
        { name: "all-three", reasons: ["missing-response-models", "unverified-final-boundary", "truncated-history"],
            expected: "Model history is incomplete: some responses have no linked model name; the final response boundary was not verified; a source window or retention limit cut it short." },
        { name: "missing", reasons: ["missing-response-models"],
            expected: "Some responses have no linked model name." },
        { name: "boundary", reasons: ["unverified-final-boundary"],
            expected: "Model history may be incomplete: the final response boundary was not verified." },
        { name: "truncated", reasons: ["truncated-history"],
            expected: "Model history is incomplete: a source window or retention limit cut it short." },
    ];
    const records = cases.map(({ name, reasons }) => {
        const record = clarityRecord();
        record.scenarioId = `model-note-${name}`;
        record.sourceSessionId = `model-note-session-${name}`;
        Object.assign(record.originalModelEvidence, {
            sourceSessionId: record.sourceSessionId, partial: reasons.includes("unverified-final-boundary"),
            truncated: reasons.includes("truncated-history"), unlinked: reasons.includes("missing-response-models"),
        });
        return record;
    });
    const { page } = await setup(t, records), proof = process.env.WIRE_MODEL_NOTE_PROOFS, observations = [];
    if (proof) await mkdir(proof, { recursive: true });
    for (const { name, expected, reasons } of cases) {
        await page.locator(`.request-row[data-view-key="request:model-note-${name}"] .request-card-open`).click();
        const note = page.locator("#requestContent .model-recording-note");
        await expect(note).toHaveCount(1);
        await expect(note).toHaveText(expected);
        await expect(page.locator("#requestContent .model-identity")).toHaveText("recorded-model");
        await expect(page.locator(".call-heading .result-cause")).toHaveText("Sign-in was required");
        assert.ok(((await note.textContent()).match(/Model history/g) ?? []).length <= 1);
        if (reasons.length > 1) for (const theme of ["light", "dark"]) {
            await page.setViewportSize({ width: 1440, height: 1000 });
            await page.evaluate(() => document.documentElement.style.fontSize = "100%");
            await chooseTheme(page, theme);
            for (const [width, scale] of [[1440, 1], [375, 2]]) {
                await page.setViewportSize({ width, height: 1000 });
                await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
                await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
                await page.locator("#requestContent .interaction-model-fact").scrollIntoViewIfNeeded();
                const geometry = await note.evaluate(node => ({
                    width: node.getBoundingClientRect().width,
                    rowWidth: node.parentElement.getBoundingClientRect().width,
                    overflow: node.scrollWidth - node.clientWidth,
                    weight: getComputedStyle(node).fontWeight,
                    text: node.textContent,
                }));
                assert.ok(geometry.width > 0 && geometry.width >= geometry.rowWidth - 1);
                assert.ok(geometry.overflow <= 1);
                assert.equal(geometry.weight, "400");
                assert.equal(geometry.text, expected);
                assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
                observations.push({ name, theme, viewportWidth: width, textScale: scale, ...geometry });
                if (proof) await page.screenshot({ path: path.join(proof, `${name}-${theme}-${width}-${scale}.png`) });
            }
        }
        await page.locator("#closeContextSidebar").click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").open);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    }
    if (proof) await writeFile(path.join(proof, "combined-note-proof.json"), JSON.stringify(observations, null, 2));
});

test("returned API failures keep their own codes without borrowing the parent sign-in cause", async t => {
    const record = clarityRecord();
    record.toolCalls[0].apiResults = [null, { unrelated: true },
        { index: 7, errorCode: "MailboxUnavailable", statusCode: 503 },
        { index: 7, errorCode: "InvalidQuery", statusCode: null }];
    const { page, runtime } = await setup(t, record);
    await page.goto(runtime.url + "#analyze?layer=reported-api&mode=calls");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator(".request-card-open").click();
    const calls = page.locator(".api-result-entry");
    await expect(calls).toHaveCount(2);
    await expect(calls.locator(".recorded-result-label")).toHaveText([
        "Tool-reported HTTP 503: MailboxUnavailable",
        "Tool-reported error: InvalidQuery",
    ]);
    await expect(calls.locator(".result-cause")).toHaveCount(0);
    for (const call of await calls.all()) await expect(call).not.toContainText("Sign-in");
});

function representativeRecords() {
    const single = clarityRecord();
    single.originalModelEvidence.partial = false;
    single.originalModelEvidence.truncated = true;
    const mixed = structuredClone(single);
    mixed.scenarioId = "clarity-mixed";
    mixed.userPrompt.sourceEventId = "mixed-prompt";
    mixed.userPrompt.text = "Prepare the invented planning packet from mail, shared files and the team calendar. "
        + "Keep decisions separate from proposals and preserve unresolved questions. ".repeat(4);
    delete mixed.originalModelEvidence;
    const outcomes = ["failed", "failed", "succeeded", "partial", "unknown", "failed"];
    mixed.toolCalls = outcomes.map((reportedOutcome, index) => ({
        ...structuredClone(single.toolCalls[0]), tool: ["workiq-retrieve", "workiq-fetch", "workiq-call_function"][index % 3],
        toolCallId: `mixed-call-${index}`, startEventId: `mixed-start-${index}`,
        startedAt: `2026-10-01T12:0${index}:01Z`, durationMs: index === 4 ? null : 252 + index,
        reportedOutcome, toolSucceeded: reportedOutcome === "failed" ? false : reportedOutcome === "succeeded" ? true : null,
        failureEvidence: index === 0 ? single.toolCalls[0].failureEvidence : index === 5
            ? { version: 1, reason: "error-details-excluded", messageStatus: "text-excluded", messageSignal: "access-denial" } : null,
        requestArgs: index === 1 ? { entityUrls: ["/me/messages/invented-planning-note"] } : { query: "Invented planning packet" },
    }));
    const missing = fixture("clarity-missing");
    missing.userPrompt = { text: null, status: "unavailable", authorship: { actor: "unknown", basis: "legacy-missing" } };
    missing.followUpPrompts = [];
    Object.assign(missing.toolCalls[0], { toolSucceeded: null, reportedOutcome: "unknown", apiResults: [] });
    const worked = fixture("clarity-worked");
    worked.userPrompt = { ...single.userPrompt, text: "Read the recorded calendar entry.", sourceEventId: "worked-prompt" };
    worked.followUpPrompts = [];
    return [single, mixed, missing, worked];
}

test("populated card-to-detail reading stays coherent across themes, scopes, search and report peeks", { timeout: 60000 }, async t => {
    const records = representativeRecords(), cleanup = [];
    const app = await searchFixture({ after: fn => cleanup.push(fn) }, { records, reply: false });
    const initial = await loadBoardState(app.context);
    const preview = await app.exports.preview("clarity-frozen-proof", undefined,
        { promptMode: "original", formats: ["html", "pdf", "json", "markdown"] },
        { kind: "selected", revision: initial.revision, scenarioIds: [records[0].scenarioId] });
    await app.exports.review("clarity-frozen-proof", preview.previewId, true);
    const saved = await app.exports.confirm("clarity-frozen-proof", preview.previewId, true);
    const bytes = new Map();
    for (const file of Object.values(saved.bundle.files)) bytes.set(file, await readFile(file));
    const before = await loadBoardState(app.context);
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], blocked = [], observations = [], proof = process.env.WIRE_CLARITY_PROOFS;
    page.setDefaultTimeout(7000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(app.runtime.url).origin && (request.method() === "GET"
            || ["/api/snapshot", "/api/connect", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
                "/api/search/events", "/api/search/query", "/api/search/open", "/api/search/cancel", "/api/search/status", "/api/search/membership"].includes(url.pathname))) return route.continue();
        blocked.push(url.pathname); return route.abort();
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("Clipboard is outside this reading proof."); },
        writeText() { throw Error("Clipboard is outside this reading proof."); },
    } }));
    t.after(async () => {
        try {
            await browser.close();
            assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
            const after = await loadBoardState(app.context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation", "pseudonymKey"]) assert.deepEqual(after[key], before[key]);
            for (const [file, original] of bytes) assert.deepEqual(await readFile(file), original, "Frozen output bytes stay exact");
            if (proof) await writeFile(path.join(proof, "reading-proof.json"), JSON.stringify({
                observations, frozenHashes: [...bytes.values()].map(value => createHash("sha256").update(value).digest("hex")),
                errors, blocked,
            }, null, 2));
        } finally { for (const fn of cleanup) await fn(); }
    });
    if (proof) await mkdir(proof, { recursive: true });
    const settled = () => page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    async function capture(name, fullPage = false) {
        await settled();
        if (fullPage) await page.evaluate(() => scrollTo(0, 0));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        if (proof) await page.screenshot({ path: path.join(proof, name + ".png"), fullPage });
        observations.push({ name, text: await page.locator("#contextSidebar[open]").count()
            ? await page.locator("#requestContent").innerText() : await page.locator("#activityList").innerText() });
    }
    async function measureReader(name) {
        const measures = await page.locator(".call-heading .result-explained").first().evaluate(node => {
            const reason = node.querySelector(".result-cause"), icon = node.querySelector(".wire-icon");
            const range = document.createRange(); range.selectNodeContents(reason);
            const text = range.getClientRects()[0], glyph = icon.getBoundingClientRect();
            let background = node;
            while (getComputedStyle(background).backgroundColor === "rgba(0, 0, 0, 0)") background = background.parentElement;
            const note = document.querySelector("#requestContent .model-recording-note");
            return { color: getComputedStyle(reason).color, background: getComputedStyle(background).backgroundColor,
                weight: getComputedStyle(reason).fontWeight, firstLineIconOffset: Math.abs(glyph.y + glyph.height / 2 - text.y - text.height / 2),
                noteWidth: note?.getBoundingClientRect().width, rowWidth: note?.parentElement.getBoundingClientRect().width };
        });
        observations.push({ name, measures });
        assert.equal(measures.weight, "400");
        assert.ok(contrast(measures.color, measures.background) >= 4.5);
        assert.ok(measures.firstLineIconOffset < 4, "Failure glyph aligns to the first reason line, not the whole wrapped block");
        assert.ok(measures.noteWidth > 0 && measures.rowWidth > 0, "Measure the current reader, never a hidden origin card");
        assert.ok(measures.noteWidth >= measures.rowWidth - 1, "The model explanation uses the available row instead of an indented narrow column");
    }
    await page.goto(app.runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const single = page.locator('.request-row[data-view-key="request:clarity-sign-in"] .request-card-open');
    const mixed = page.locator('.request-row[data-view-key="request:clarity-mixed"] .request-card-open');
    let exactCall;
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await capture(`${theme}-whole-analyze`, true);
        await page.locator("#resultsLink").click();
        await single.hover();
        await capture(`${theme}-cards-hover`);
        await single.focus();
        await page.keyboard.press("Enter");
        await settled();
        exactCall = await page.locator('[data-tool-call-id="clarity-call"]').getAttribute("data-action-id");
        await expect(page.locator(".call-heading .result-cause")).toBeInViewport();
        await expect(page.locator(".model-recording-note")).toHaveText("Model history is incomplete: a source window or retention limit cut it short.");
        await expect(page.locator(".model-recording-note")).not.toContainText("final response");
        await measureReader(`${theme}-reader-geometry`);
        assert.doesNotMatch(await page.locator("#requestContent").innerText(), /Sign in now|signed out|module failed/i);
        await capture(`${theme}-reader-first-glance`);
        const focusOrder = [];
        if (theme === "light") {
            await expect(page.locator('[data-tool-call-id="clarity-call"]')).toBeFocused();
            for (let index = 0; index < 8; index++) {
                await page.keyboard.press("Shift+Tab");
                const name = await page.evaluate(() => document.activeElement.getAttribute("aria-label") || document.activeElement.textContent);
                focusOrder.push(name.trim());
                if (name === "Copy prompt") break;
            }
        } else focusOrder.push("Restored Copy prompt focus from the same reader");
        observations.push({ name: `${theme}-tab-sequence`, focusOrder });
        await expect(page.getByRole("button", { name: "Copy prompt", exact: true })).toBeFocused();
        await capture(`${theme}-reader-keyboard`);
        await page.locator("#closeContextSidebar").click();
        await settled(); await expect(single).toBeFocused();
        const box = await single.boundingBox();
        await page.mouse.click(box.x + 24, box.y + 24);
        await settled();
        await page.locator("#closeContextSidebar").click(); await settled();
        assert.ok(Math.abs((await single.boundingBox()).y - box.y) < 3, "Pointer return preserves the selected-card reading anchor");
        await mixed.click();
        await expect(page.locator(".request-context-timeline > [data-context-kind=action]")).toHaveCount(6);
        await expect(page.locator(".call-heading .result-cause")).toHaveText(["Sign-in was required", "Error detail not recorded", "Access was denied"]);
        await expect(page.locator('.call-heading [data-outcome="partial"]')).toContainText("Partly worked");
        await expect(page.locator('.call-heading [data-outcome="unknown"] .result-cause')).toHaveCount(0);
        await capture(`${theme}-long-plural-reader`);
        const mainScroll = await page.evaluate(() => scrollY);
        const panel = await page.locator("#contextSidebarBody").boundingBox();
        await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 2);
        await page.mouse.wheel(0, 620);
        await page.waitForFunction(() => document.querySelector("#contextSidebarBody").scrollTop > 200);
        assert.equal(await page.evaluate(() => scrollY), mainScroll);
        await capture(`${theme}-plural-scrolled`);
        await page.locator("#closeContextSidebar").click(); await settled();
        await page.locator('.request-row[data-view-key="request:clarity-missing"] .request-card-open').click();
        await expect(page.locator(".request-original")).toContainText("Prompt not available");
        await expect(page.locator(".model-identity")).toHaveText("Not recorded");
        await expect(page.locator(".call-heading .result-cause")).toHaveCount(0);
        await capture(`${theme}-missing-reader`);
        await page.locator("#closeContextSidebar").click(); await settled();
        await page.locator('.request-row[data-view-key="request:clarity-worked"] .request-card-open').click();
        await expect(page.locator('.call-heading [data-outcome="success"]')).toContainText("Worked");
        await expect(page.locator(".call-heading .result-cause")).toHaveCount(0);
        await capture(`${theme}-worked-reader`);
        await page.locator("#closeContextSidebar").click(); await settled();
    }
    await selectActivityOption(page, "toolFilter", "workiq-fetch");
    await expect(mixed.locator('[data-outcome="failure"]')).toContainText("1 Tool failed");
    await expect(mixed).not.toContainText("Sign-in");
    await mixed.click();
    await expect(page.locator(".reader-scope")).toContainText("2 of 6 Work IQ tool calls match");
    await expect(page.locator(".request-context-timeline")).toContainText("Sign-in was required");
    await expect(page.locator(".action-context").filter({ hasText: /^Matches current view$/ })).toHaveCount(2);
    await page.locator(".reader-scope").scrollIntoViewIfNeeded();
    await capture("filtered-whole-interaction");
    await page.locator("#closeContextSidebar").click(); await settled();
    await selectActivityOption(page, "toolFilter", "all");
    await page.goto(app.runtime.url + "#request?" + new URLSearchParams({ request: records[0].scenarioId, layer: "tool", call: exactCall }));
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await expect(page.locator("#selectedCall")).toBeFocused();
    await expect(page.locator(".model-recording-note")).toContainText("source window or retention limit");
    await capture("explicit-call-target");
    await page.locator("#closeContextSidebar").click(); await settled();
    await page.locator("#wireSearch").fill("workshop agenda");
    const hit = page.locator(".wire-search-hit").filter({ has: page.locator(".wire-search-title", { hasText: records[0].userPrompt.text }) });
    await expect(hit).toHaveCount(1); await hit.click();
    await expect(page.locator(".call-heading .result-cause")).toHaveText("Sign-in was required");
    await capture("search-reader");
    await page.goBack(); await expect(hit).toBeFocused();
    await hit.click();
    await page.locator("#requestReportToggle").click();
    await page.locator("#requestReportContinue").click();
    const reportEntry = page.locator("#reportList .report-entry").filter({ hasText: records[0].userPrompt.text });
    await expect(reportEntry.locator(".result-cause")).toHaveText("Sign-in was required");
    await reportEntry.locator(".request-link").click();
    await expect(page.getByRole("button", { name: "Back to activity", exact: true })).toBeVisible();
    await capture("report-picker-peek");
    for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width: 375, height: 900 });
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "overlay");
        await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop = 0);
        await capture(`${theme}-narrow-200-prompt`);
        await page.locator(".call-heading .result-cause").scrollIntoViewIfNeeded();
        await measureReader(`${theme}-narrow-200-geometry`);
        await capture(`${theme}-narrow-200-cause`);
        assert.ok(await page.getByRole("button", { name: "Back to activity", exact: true }).isVisible());
        await expect(page.locator(".reader-call-duration data")).toHaveAttribute("value", "252");
    }
});
