import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, revealAnalyzeRecords } from "./helpers.mjs";
import { contract, samples, retainedResponse } from "./assessment-ui-fixtures.mjs";
import { contrast } from "./color-measurements.mjs";
import { promptRecord, promptAuthorship } from "../lib/prompt-authorship.mjs";
import { recordedInteractionModels } from "../lib/interaction-model.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";

const proof = process.env.WIRE_DETAIL_PROOFS;
const ready = page => page.locator('#workspace[aria-busy="false"]').waitFor();
const exact = "SYNTHETIC original prompt\n  Preserve these spaces.  \nJapanese: \u65e5\u672c\u8a9e; Hebrew: \u05e9\u05dc\u05d5\u05dd; emoji: \ud83d\udc69\u200d\ud83d\udcbb; e\u0301\n";

async function setup(t, { text = "Find the synthetic planning note.", status = "full", actor = "unknown", calls = true, responseText, responseMode = "success", detailError = false, chatOrigin = true, sourceEvent, entry = "reader", modelTiming = false, responseDurationMs = 108640, neighbor = false } = {}) {
    const record = fixture("detail-reading");
    record.sourceSessionName = "Synthetic planning chat";
    if (!chatOrigin) record.sourceHost = "imported-json";
    record.project = null; record.projectId = null;
    record.userPrompt = { text, status, sourceTimestamp: "2026-09-30T12:00:00Z", sourceEventId: "synthetic-prompt",
        authorship: { actor, basis: { user: "source-user", agent: "source-agent", unknown: "legacy-missing" }[actor] } };
    if (sourceEvent) {
        record.userPrompt = promptRecord(sourceEvent);
        record.sourceSessionName = "Synthetic coordinator chat";
    }
    record.followUpPrompts = [];
    if (!calls) record.toolCalls = [];
    else if (Array.isArray(calls)) record.toolCalls = calls.map((call, index) => ({
        ...record.toolCalls[0], toolCallId: `synthetic-reading-call-${index}`, startEventId: `synthetic-reading-start-${index}`,
        startedAt: `2026-09-30T12:0${index}:01Z`, completedAt: `2026-09-30T12:0${index}:02Z`, durationMs: 1000,
        ...call,
    }));
    else Object.assign(record.toolCalls[0], { startedAt: "2026-09-30T12:00:01Z", completedAt: "2026-09-30T12:00:02Z", durationMs: 1000 });
    if (modelTiming) {
        const events = [
            { id: record.userPrompt.sourceEventId, type: "user.message", timestamp: record.userPrompt.sourceTimestamp, data: { messageId: "synthetic-logical-prompt" } },
            { id: "synthetic-response", type: "assistant.message", timestamp: new Date(Date.parse(record.userPrompt.sourceTimestamp) + responseDurationMs).toISOString(), data: {
                originatingMessageId: "synthetic-logical-prompt", apiCallId: "synthetic-api-anchor", model: "synthetic-model",
                content: "Synthetic final response for metadata only.", turnId: "synthetic-turn", phase: "final_answer", toolRequests: [],
            } },
            { id: "synthetic-end", type: "assistant.turn_end", timestamp: new Date(Date.parse(record.userPrompt.sourceTimestamp) + responseDurationMs + 60).toISOString(), data: { turnId: "synthetic-turn" } },
        ];
        record.responseTiming = recordedResponseTiming(events, record.userPrompt);
        record.originalModelEvidence = recordedInteractionModels(events, record);
    }
    const cleanup = [];
    const records = [record];
    if (neighbor) {
        const other = fixture("detail-neighbor");
        other.userPrompt = { ...other.userPrompt, text: "A separate invented request with no saved reply.", sourceEventId: "neighbor-prompt",
            sourceTimestamp: "2026-09-29T12:00:00Z" };
        other.capturedAt = "2026-09-29T12:00:00Z";
        records.push(other);
    }
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    let expectedEvidence = before.evidence;
    let expectedCards = before.cards;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    const requests = [], errors = [];
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push({ url: request.url(), method: request.method() }));
    await page.addInitScript(() => {
        window.clipboardProof = { attempts: [], writes: [], reads: 0, mode: "success" };
        window.installClipboardProof = () => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            readText() { window.clipboardProof.reads++; throw new Error("Real clipboard reads are forbidden."); },
            async writeText(value) {
                const proof = window.clipboardProof;
                proof.attempts.push(value);
                if (proof.mode === "denied") throw new DOMException("Synthetic permission refusal", "NotAllowedError");
                if (proof.mode === "pending") await new Promise(resolve => { window.finishClipboardProof = resolve; });
                proof.writes.push(value);
            },
        } });
        window.installClipboardProof();
    });
    const responseState = { mode: responseMode, finish: null };
    if (responseText !== undefined) {
        const view = retainedResponse(responseText, record);
        const envelope = data => ({ schemaVersion: 1, basis: view.basis, data });
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch(), value = await response.json();
            value.assessment = {
                schemaVersion: 1, basis: view.basis,
                catalog: [{ scenarioId: record.scenarioId, interactionRef: view.interaction.interactionRef, interactionRefs: [view.interaction.interactionRef], status: "retained", reason: null }],
                overview: { interactionRefs: [view.interaction.interactionRef], metrics: view.metrics },
                consent: view.consent, source: { available: true, sourceConfigRef: samples.id("config"), sourceConfigRevision: 1 },
                capabilities: { answer: true, usage: false, explicitAuthorization: false },
            };
            await route.fulfill({ response, json: value });
        });
        await page.route("**/api/assessment/detail", route => route.fulfill({ json: envelope(view) }));
        await page.route("**/api/collection/status", async route => {
            const response = await route.fetch(), value = await response.json();
            value.assessment = { ...value.assessment, basis: view.basis };
            await route.fulfill({ response, json: value });
        });
        await page.route("**/api/assessment/overview", route => route.fulfill({ json: envelope({ interactionRefs: [view.interaction.interactionRef], metrics: view.metrics }) }));
        await page.route("**/api/assessment/evidence", async route => {
            const input = route.request().postDataJSON();
            contract.validateRequest("get_interaction_evidence", input);
            if (responseState.mode === "pending") await new Promise(resolve => { responseState.finish = resolve; });
            if (responseState.mode === "error") return route.fulfill({ status: 503, json: { error: "Synthetic retained-text read failed." } });
            await route.fulfill({ json: envelope({ observationRef: input.observationRef, text: responseText,
                completeness: "bounded-fragment", finality: "unverified", basis: view.basis }) });
        });
    }
    if (detailError) await page.route("**/api/assessment/detail", route => route.fulfill({ status: 503, json: { error: "Synthetic local insight read failed." } }));
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key],
                key === "evidence" ? expectedEvidence : key === "cards" ? expectedCards : before[key], key);
            assert.deepEqual(errors, []);
            assert.ok(requests.every(request => new URL(request.url).origin === new URL(runtime.url).origin), "No external requests");
            const unexpected = requests.filter(request => request.method === "POST" &&
                !["/api/snapshot", "/api/connect", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
                    "/api/assessment/evidence"].includes(new URL(request.url).pathname));
            assert.deepEqual(unexpected.map(request => new URL(request.url).pathname), [],
                "Only local synthetic reads; no capture, collection, report, feedback or consent changes");
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + (entry === "card" ? "" : "#request?request=detail-reading")); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    if (entry !== "card") await expect(page.locator(".interaction-response[aria-busy=true]")).toHaveCount(0);
    const addUnrelatedRecord = async () => {
        const unrelated = fixture("detail-unrelated");
        unrelated.sourceSessionId = "unrelated-fixture-session";
        await replaceEvidence(context, () => ({ records: [...records, unrelated],
            importCoverage: { counts: { includedSessions: 2, includedProjects: 1 }, roster: [] } }));
        const updated = await loadBoardState(context);
        for (const id of Object.keys(before.cards)) assert.deepEqual(updated.cards[id], before.cards[id]);
        assert.deepEqual(Object.keys(updated.cards).sort(), [...Object.keys(before.cards), unrelated.scenarioId].sort());
        assert.equal(updated.cards[unrelated.scenarioId].workflowState, "captured");
        expectedEvidence = updated.evidence;
        expectedCards = updated.cards;
    };
    return { page, record, requests, runtime, responseState, addUnrelatedRecord };
}
async function capture(page, name, contextSelector = ".request-intro") {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.mouse.move(0, 0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(proof, `${name}.png`), fullPage: true });
    await page.screenshot({ path: path.join(proof, `${name}-viewport.png`) });
    const context = page.locator(contextSelector + ":visible").first();
    if (await context.count()) {
        await context.evaluate(node => {
            const body = document.querySelector("#contextSidebarBody");
            if (body.contains(node)) body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - 16;
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        await page.screenshot({ path: path.join(proof, `${name}-reading-context.png`) });
    }
}
function contentReads(requests) {
    return requests.filter(request => ["/api/snapshot", "/api/assessment/detail", "/api/assessment/evidence"].includes(new URL(request.url).pathname)).length;
}
const section = (page, name) => page.locator(`[data-reader-section="${name}"]`);
async function openCall(call) {
    const toggle = call.locator(".reader-call-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}
async function openSource(page) {
    const source = section(page, "source"), toggle = source.locator(".reader-section-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    return source;
}
async function openIdentifiers(source) {
    const toggle = source.getByRole("button", { name: "Record identifiers", exact: true }).first();
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}
async function readerTheme(page, theme, width, scale) {
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "docked");
    await chooseTheme(page, theme);
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
    const splitFits = await page.evaluate(() => document.documentElement.clientWidth - document.querySelector("#main").getBoundingClientRect().left
        >= 62 * parseFloat(getComputedStyle(document.documentElement).fontSize));
    await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", splitFits ? "docked" : "overlay");
}

test("normal-entry Copy feedback never moves the prompt or adds a status row", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { actor: "user", text: exact, entry: "card" });
    await revealAnalyzeRecords(page);
    await page.locator("#activityList .request-card-open").click();
    await ready(page);
    await page.locator(".interaction-response .reader-empty").waitFor();
    const copy = page.getByRole("button", { name: "Copy prompt", exact: true });
    const geometry = () => section(page, "prompt").evaluate(root => {
        const box = selector => {
            const { x, y, width, height } = root.querySelector(selector).getBoundingClientRect();
            return { x, y, width, height };
        };
        return { prompt: box(".full-text-content"), header: box(".full-text-header"),
            actions: box(".reader-section-actions"), section: root.getBoundingClientRect().toJSON(),
            scrollY, paneScroll: document.querySelector("#contextSidebarBody").scrollTop,
            paneHeight: document.querySelector("#contextSidebarBody").scrollHeight, pageHeight: document.documentElement.scrollHeight };
    });
    const measurements = [];
    for (const [theme, width, scale] of [["dark", 1440, 1], ["light", 1440, 1], ["dark", 375, 2], ["light", 375, 2]]) {
        await readerTheme(page, theme, width, scale);
        await copy.focus();
        const before = await geometry();
        await page.evaluate(() => { window.clipboardProof.mode = "pending"; });
        await copy.press("Enter");
        assert.equal(await copy.getAttribute("aria-busy"), "true");
        assert.deepEqual(await geometry(), before, "Pending copy uses the existing button, not a new line");
        await page.evaluate(() => window.finishClipboardProof());
        await expect(copy).toHaveAttribute("data-copy-state", "success");
        const after = await geometry();
        measurements.push({ theme, width, scale, before, after });
        assert.equal(await copy.evaluate(node => node === document.activeElement), true);
        assert.deepEqual(after, before, "Copy success must not insert a line, move the prompt/facts, scroll, or change page height");
        const status = section(page, "prompt").locator(".ux-copy-status");
        assert.equal(await status.getAttribute("role"), "status");
        assert.equal(await status.getAttribute("aria-live"), "polite");
        assert.equal(await status.textContent(), "Copied to clipboard.");
        const box = await status.boundingBox();
        assert.ok(box.height <= 1 && box.width <= 1, "Announcement is out of flow; no blank space is reserved");
    }
    if (proof) {
        await mkdir(proof, { recursive: true });
        await writeFile(path.join(proof, "copy-geometry.json"), JSON.stringify(measurements, null, 2));
    }
    assert.deepEqual(await page.evaluate(() => window.clipboardProof.writes), Array(4).fill(exact));
});

test("reader exposes exact operations and useful evidence without identifier buttons or a nested review gate", { timeout: 30000 }, async t => {
    const { page, record } = await setup(t, { actor: "user", modelTiming: true, responseDurationMs: 677960, entry: "card", calls: [{
        tool: "workiq-ask", requestArgs: { question: "Find the invented planning note.", timeZone: "UTC" },
        requestedApiPath: null, apiResults: [], durationMs: 73728,
        startedAt: "2026-09-30T12:00:01.107Z", completedAt: "2026-09-30T12:01:14.835Z",
        parentInvocationEvidence: "source-field-absent", parallelGroupEvidence: "adapter-not-supported",
    }] });
    await revealAnalyzeRecords(page);
    await page.locator("#activityList .request-card-open").click();
    await ready(page);
    await page.locator(".interaction-response .reader-empty").waitFor();
    const reader = page.locator("#requestContent"), call = reader.locator("[data-tool-call-id]");
    await expect(call.locator(".reader-call-identity-line")).toHaveText("workiq-ask");
    await expect(call.locator(".reader-call-summary")).toContainText("Call #1");
    assert.equal(await call.locator(".reader-tool-name").innerText(), "workiq-ask");
    await expect(call.locator(".interaction-response")).toHaveCount(0);
    assert.match(await reader.locator(":scope > .reader-response-availability").innerText(), /No assistant reply was saved.*Saving is off by default/s);
    assert.equal(await reader.locator(".request-context-summaries>summary").count(), 0);
    await expect(reader.getByRole("heading", { name: "Reviews", exact: true })).toHaveCount(0);
    const pick = page.locator("#contextSidebarFooter").getByRole("button", { name: "Add to report", exact: true });
    assert.ok((await pick.boundingBox()).y >= (await page.locator("#contextSidebarBody").boundingBox()).y
        + (await page.locator("#contextSidebarBody").boundingBox()).height);
    const originalRoute = page.url();
    await pick.click();
    assert.equal(await page.locator("#requestReportToggle").textContent(), "Remove from report");
    assert.equal(page.url(), originalRoute);
    await page.locator("#requestReportToggle").click();
    const details = call.locator(".technical-detail"), source = await openSource(page);
    await openIdentifiers(source);
    await openCall(call);
    await expect(details).toBeVisible();
    await expect(call.locator(":scope > details")).toHaveCount(0);
    await expect(source.locator(".reader-fields>div").filter({ has: page.getByText("Call #1 ID", { exact: true }) }).locator("dd")).toHaveText(record.toolCalls[0].toolCallId);
    assert.equal(await source.getByRole("button", { name: /^Copy .*id$/i }).count(), 0);
    assert.doesNotMatch(await source.innerText(), /HTTP not|parent invocation|parallel group|independent or serial/i,
        "Absent adapter fields are not a problem or next step for the reader; no routine machinery recital");
    const args = call.getByRole("button", { name: "Copy recorded arguments", exact: true });
    await args.click();
    assert.equal(await page.evaluate(() => window.clipboardProof.writes.at(-1)), JSON.stringify(record.toolCalls[0].requestArgs, null, 2));
    await page.evaluate(() => { window.clipboardProof.mode = "denied"; });
    await args.click();
    assert.match(await call.locator("[role=alert]").innerText(), /permission was denied/);
    await page.evaluate(() => { window.clipboardProof.mode = "success"; });
    await args.click();
    assert.equal(await call.locator("[role=alert]").count(), 0, "Retry clears the prior failure");
    await capture(page, "reader-tool-evidence", "[data-tool-call-id]");
    const saved = reader.locator(".assessment-saved-details");
    await expect(saved).toHaveCount(0);
    assert.match(await source.innerText(), /synthetic-prompt/);
    assert.equal(await source.locator(".ux-copy").count(), 0);
    await expect(call.locator('.reader-call-duration data[value="73728"]')).toHaveCount(1);
    await expect(source.locator('.response-timing data[value="677960"]')).toHaveText("677,960 ms (677.96 s)");
    await expect(source.locator(".reader-recorded-at time")).toHaveAttribute("datetime", record.userPrompt.sourceTimestamp);
    await expect(reader.locator(".reader-local-timing,.single-interaction-measures,.automatic-score-dialog")).toHaveCount(0);
    await expect(reader.getByRole("button", { name: /personal feedback|automatic scores|save feedback/i })).toHaveCount(0);
    assert.equal(await page.locator("dialog[open]").count(), 1);
    const sourceToggle = source.locator(".reader-section-toggle");
    await sourceToggle.focus(); await sourceToggle.press("Enter");
    await expect(sourceToggle).toHaveAttribute("aria-expanded", "false");
    await sourceToggle.press("Space");
    await expect(sourceToggle).toBeFocused();
    const readerUrl = page.url();
    await reader.getByRole("link", { name: "Collection coverage", exact: true }).click(); await ready(page);
    assert.equal(await page.locator("#collectionStatusView").isVisible(), true);
    await page.goBack(); await ready(page);
    assert.equal(page.url(), readerUrl);
    await reader.getByRole("link", { name: "Filter to chat: Synthetic planning chat", exact: true }).click(); await ready(page);
    assert.match(page.url(), /session=/);
    await page.goBack(); await ready(page);
    assert.equal(page.url(), readerUrl);
    const measure = [];
    for (const [theme, width, scale] of [["dark", 1440, 1], ["light", 1440, 1], ["dark", 375, 2], ["light", 375, 2]]) {
        await readerTheme(page, theme, width, scale);
        const style = await reader.locator(".full-text-body").evaluate(node => ({
            fill: getComputedStyle(node).backgroundColor, edge: getComputedStyle(node).borderInlineStartColor,
            ink: getComputedStyle(node.querySelector("pre")).color,
            overflow: document.documentElement.scrollWidth - innerWidth,
        }));
        assert.ok(contrast(style.ink, style.fill) >= 4.5);
        assert.ok(contrast(style.edge, style.fill) >= 3);
        assert.ok(style.overflow <= 1);
        measure.push({ theme, width, scale, ...style });
        await capture(page, `reader-finished-${theme}-${width}-${scale}`, ".request-original");
    }
    if (proof) await writeFile(path.join(proof, "reader-comprehension.json"), JSON.stringify({
        checks: ["Exact workiq-ask visible without expansion", "Reported call outcome separate from missing reply",
            "Report selection in fixed footer; no automatic navigation", "Synthetic exact arguments copied",
            "Clipboard failure explicit and retry clears it", "Selectable exact IDs without copy buttons",
            "No retired reviews, editors or replacement panels", "Exact call and final-response duration stay distinct",
            "Source disclosure retains native keyboard focus",
            "Chat filter and Collection coverage navigate and return"], measure,
    }, null, 2));
});

test("card-to-reader continuity includes aligned actions, compact expanded facts and the exact return position", { timeout: 60000 }, async t => {
    const text = "Review the planning presentation from the Northline kickoff and identify the decisions still waiting for an owner.";
    const { page, record } = await setup(t, { actor: "user", text, entry: "card", modelTiming: true, calls: [{
        tool: "workiq-ask", requestArgs: { question: "Find the invented Northline kickoff presentation.\n  Keep this exact indentation.", timeZone: "UTC" },
        requestedApiPath: null, apiResults: [], durationMs: 73728,
        startedAt: "2026-09-30T12:00:01.107Z", completedAt: "2026-09-30T12:01:14.835Z",
        parentInvocationEvidence: "source-field-absent", parallelGroupEvidence: "adapter-not-supported",
    }] });
    const metrics = [];
    for (const [theme, width, scale] of [["dark", 1440, 1], ["light", 1440, 1], ["dark", 420, 2], ["light", 420, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await revealAnalyzeRecords(page);
        const card = page.locator("#activityList>.request-row"), open = card.locator(".request-card-open");
        await expect(card.locator(".request-card-prompt")).toContainText(text);
        await expect(card).toContainText("Asked Copilot");
        await expect(card.locator("input,button")).toHaveCount(0);
        await open.scrollIntoViewIfNeeded();
        const cardType = await card.locator(".request-card-prompt").evaluate(node => {
            const style = getComputedStyle(node);
            return { font: style.fontFamily, size: style.fontSize, weight: style.fontWeight, style: style.fontStyle };
        });
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.screenshot({ path: path.join(proof, `continuity-${theme}-${width}-${scale}-card.png`) });
        }
        const origin = page.url(), position = await open.boundingBox();
        await page.mouse.click(position.x + position.width / 2, position.y + position.height / 2); await ready(page);
        await page.locator(".interaction-response .reader-empty").waitFor();
        const prompt = section(page, "prompt"), call = page.locator('[data-tool-call-id="synthetic-reading-call-0"]');
        const source = await openSource(page);
        assert.match(await source.locator(".interaction-model-fact").innerText(), /synthetic-model/);
        assert.equal(await source.locator(".response-timing data").getAttribute("value"), "108640");
        const copy = prompt.getByRole("button", { name: "Copy prompt", exact: true });
        await expect(prompt.locator(".reader-section-toggle")).toHaveCount(0);
        await capture(page, `continuity-${theme}-${width}-${scale}-reader`);
        const measures = await page.locator("#requestContent").evaluate(root => {
            const node = root.querySelector('[data-reader-section="prompt"]'), source = root.querySelector('[data-reader-section="source"]');
            const box = element => {
                const r = element.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height, center: r.y + r.height / 2 };
            };
            const controls = [...node.querySelectorAll(":scope>.reader-section-heading button")];
            const style = getComputedStyle(node.querySelector(".full-text-content"));
            return {
                promptType: { font: style.fontFamily, size: style.fontSize, weight: style.fontWeight, style: style.fontStyle },
                controls: controls.map(control => ({ ...box(control), marginTop: getComputedStyle(control).marginTop })),
                content: box(node.querySelector(".full-text-content")),
                keys: [...source.querySelectorAll("dt")].map(key => ({ weight: getComputedStyle(key).fontWeight, color: getComputedStyle(key).color })),
                values: [...source.querySelectorAll("dd")].map(value => ({ weight: getComputedStyle(value).fontWeight, color: getComputedStyle(value).color,
                    left: value.getBoundingClientRect().left - value.previousElementSibling.getBoundingClientRect().left,
                    gap: value.getBoundingClientRect().top - value.previousElementSibling.getBoundingClientRect().bottom,
                    inlineGap: value.getBoundingClientRect().left - value.previousElementSibling.getBoundingClientRect().right,
                    top: value.getBoundingClientRect().top - value.previousElementSibling.getBoundingClientRect().top })),
            };
        });
        await copy.click();
        assert.equal(await page.evaluate(() => window.clipboardProof.writes.at(-1)), text);
        await expect(copy).toBeFocused();
        assert.equal(await prompt.locator(".full-text-content").textContent(), text);
        const details = call.locator(".technical-detail");
        await openCall(call);
        await expect(details).toBeVisible();
        await expect(call.locator(":scope>details")).toHaveCount(0);
        await call.getByRole("button", { name: "Copy recorded arguments", exact: true }).click();
        assert.equal(await page.evaluate(() => window.clipboardProof.writes.at(-1)), JSON.stringify(record.toolCalls[0].requestArgs, null, 2));
        await capture(page, `continuity-${theme}-${width}-${scale}-expanded`, '[data-tool-call-id="synthetic-reading-call-0"]');
        const technical = await details.innerText();
        const expanded = await details.evaluate(node => ({
            height: node.getBoundingClientRect().height,
            emptyRows: [...node.querySelectorAll("dd")].filter(value => /^(Not recorded|Not in this record|Not supplied by source|Not collected by this adapter|false|true)$/u.test(value.textContent)).length,
            helpButtons: node.querySelectorAll(".ux-help").length,
            overflow: document.documentElement.scrollWidth - innerWidth,
            keyWeights: [...node.querySelectorAll("dt")].map(key => getComputedStyle(key).fontWeight),
        }));
        metrics.push({ theme, width, scale, cardType, ...measures, technical, expanded });
        await page.getByRole("button", { name: "Add to report", exact: true }).click();
        assert.equal(await page.locator("#requestReportToggle").textContent(), "Remove from report");
        await page.locator("#requestReportToggle").click();
        await page.goBack(); await ready(page);
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        assert.equal(page.url(), origin);
        assert.equal(await open.evaluate(node => node === document.activeElement), true);
        assert.ok(Math.abs((await open.boundingBox()).y - position.y) < 3, "Back restores the card entry position");
        await expect(card.getByRole("checkbox")).toHaveCount(0);
    }
    if (proof) await writeFile(path.join(proof, "continuity-metrics.json"), JSON.stringify(metrics, null, 2));
    for (const measurement of metrics) {
        const { cardType, promptType, controls, keys, values, expanded, width, scale } = measurement;
        assert.equal(promptType.font, cardType.font, "The full prompt keeps the card's font family");
        assert.equal(promptType.size, `${14 * scale}px`, "The reader uses its current body-text role");
        assert.equal(cardType.size, `${16 * scale}px`, "The card retains its recognition-text role");
        assert.equal(promptType.weight, "400");
        assert.equal(promptType.style, "normal");
        assert.equal(controls.length, 1, "The always-readable prompt has Copy, not a retired folding control");
        assert.ok(controls.every(control => control.height >= 44 && control.width >= 44));
        assert.ok(keys.length > 0 && values.length === keys.length, "Measure the current Source details metadata, not an empty former prompt host");
        assert.ok(keys.every(key => key.weight === "400" && values.every(value => value.weight === key.weight && value.color !== key.color)));
        assert.ok(values.every(value => Math.abs(value.top) <= 1 && value.inlineGap >= 6 && value.inlineGap <= 10
            || Math.abs(value.left) <= 1 && value.gap >= 0 && value.gap <= 4), "Context facts stay inline or wrap cleanly to their shared left edge without overlap");
        assert.equal(expanded.emptyRows, 0, "Missing technical fields are consolidated, not repeated as empty rows");
        assert.equal(expanded.helpButtons, 0, "Expanded facts explain necessary limits directly, not through a tooltip per fact");
        assert.ok(expanded.overflow <= 1, `${width}/${scale}: expanded technical details fit`);
        assert.ok(expanded.keyWeights.every(weight => weight === "400"));
        if (width === 1440) assert.ok(expanded.height < 600, "One simple call's expanded detail fits a readable group, rather than a page of empty fields");
    }
});

test("reader distillation keeps a legible story without repeated empty fields or per-text About disclosures", { timeout: 60000 }, async t => {
    const calls = Array.from({ length: 7 }, (_, index) => ({
        tool: index === 5 ? "workiq-fetch_blob" : "workiq-retrieve",
        requestArgs: {}, requestedApiPath: null, apiResults: [],
        toolSucceeded: index !== 5, reportedOutcome: index === 5 ? "failed" : "succeeded",
    }));
    const { page, runtime } = await setup(t, { actor: "agent", text: exact + "Read the retained planning notes. ".repeat(16), calls });
    await page.goto(runtime.url + "#request?request=detail-reading&tool=workiq-fetch_blob"); await ready(page);
    await page.locator(".interaction-response .reader-empty").waitFor();
    const timeline = page.locator(".request-context-timeline");
    await capture(page, "distilled-multicall-light");
    assert.equal(await timeline.locator(".reader-details").count(), 0, "No repeated About prompt/response disclosures");
    assert.equal(await timeline.locator(":scope > li[data-context-kind=action]").count(), 7);
    const visible = await timeline.innerText();
    assert.doesNotMatch(visible, /API path\s+Not recorded|API metadata: None recorded/);
    await expect(timeline.getByText("Outside current view", { exact: true })).toHaveCount(6);
    await expect(timeline.getByText("Matches current view", { exact: true })).toHaveCount(1);
    assert.match(visible, /Failure reason was not saved/);
    assert.doesNotMatch(visible, /Historical call evidence only/);
    assert.match(await page.locator("#requestContent > .reader-response-availability").innerText(), /No assistant reply was saved.*Saving is off by default/s);
    assert.match(await page.locator(".reader-scope").innerText(), /1 of 7.*match/);
    assert.equal(await timeline.locator(".context-selected-label").count(), 0, "A direct interaction entry needs no Selected prompt badge");
    const action = timeline.locator("[data-tool-call-id=synthetic-reading-call-0]");
    await openCall(action);
    await openSource(page);
    await expect(action.locator(".technical-detail")).toBeVisible();
    await expect(action.locator("details,.call-api-summary,.returned-api-entries")).toHaveCount(0);
    await expect(action.locator(".recorded-arguments pre")).toHaveText("{}");
    for (const [theme, width, scale] of [["light", 1200, 1], ["dark", 1200, 1], ["dark", 375, 2], ["light", 375, 2]]) {
        await readerTheme(page, theme, width, scale);
        const styles = await page.locator("#requestContent").evaluate(root => {
            const nodes = [...root.querySelectorAll(".full-text-header h2, .interaction-response > h2, .call-heading h3")];
            return {
                headings: nodes.map(node => ({ size: getComputedStyle(node).fontSize, font: getComputedStyle(node).fontFamily, color: getComputedStyle(node).color })),
                overflow: document.documentElement.scrollWidth - innerWidth,
                facts: [...root.querySelectorAll(".reader-facts > dl > div")].map(node => node.getBoundingClientRect().x),
                keyWeights: [...root.querySelectorAll(".reader-facts dt")].map(node => getComputedStyle(node).fontWeight),
                values: [...root.querySelectorAll(".reader-facts dd")].map(node => ({
                    x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y,
                    keyX: node.previousElementSibling.getBoundingClientRect().left,
                    keyBottom: node.previousElementSibling.getBoundingClientRect().bottom,
                    keyY: node.previousElementSibling.getBoundingClientRect().top,
                    keyRight: node.previousElementSibling.getBoundingClientRect().right,
                })),
            };
        });
        assert.equal(new Set(styles.headings.map(style => style.size)).size, 1, "Prompt, response and call headings share one type role");
        assert.ok(styles.headings.every(style => style.font.includes("Asta Sans")));
        assert.ok(styles.overflow <= 1, `${theme}/${width}/${scale} does not overflow`);
        assert.ok(styles.facts.every(x => x >= 0 && x < width), "Compact metadata wraps within the reading column");
        assert.equal(new Set(styles.keyWeights).size, 1, "Metadata keys share one weight");
        assert.ok(styles.values.length > 0);
        assert.ok(styles.values.every(value => Math.abs(value.y - value.keyY) <= 1 && value.x - value.keyRight >= 6 && value.x - value.keyRight <= 10
            || Math.abs(value.x - value.keyX) <= 1 && value.y - value.keyBottom >= 0 && value.y - value.keyBottom <= 4),
            "Context values use a compact inline row or wrap below on the same left edge");
        await capture(page, `distilled-multicall-${theme}-${width}-${scale}`, '[data-tool-call-id="synthetic-reading-call-5"]');
    }
});

test("reader failure copy is concise while sign-in signals and unknown outcomes stay distinct", { timeout: 30000 }, async t => {
    const failed = { tool: "workiq-fetch_blob", requestArgs: {}, requestedApiPath: null, apiResults: [],
        toolSucceeded: false, reportedOutcome: "failed" };
    const { page } = await setup(t, { actor: "user", calls: [
        failed,
        { ...failed, failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
            messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required" } },
        { ...failed, failureEvidence: { version: 1, reason: "no-structured-error",
            messageStatus: "text-excluded", messageSignal: "access-denial" } },
        { ...failed, toolSucceeded: undefined, reportedOutcome: undefined },
    ] });
    const calls = page.locator(".request-context-timeline > li[data-context-kind=action]");
    await page.locator(".interaction-response .reader-empty").waitFor();
    if (proof) {
        await mkdir(proof, { recursive: true });
        for (const [theme, width, scale] of [["light", 1200, 1], ["dark", 375, 2]]) {
            await readerTheme(page, theme, width, scale);
            for (const [index, name] of ["missing-cause", "sign-in-required", "access-denial", "unknown-outcome"].entries()) {
                await calls.nth(index).screenshot({ path: path.join(proof, `failure-${name}-${theme}-${width}-${scale}.png`) });
            }
        }
    }
    assert.deepEqual(await calls.locator(".call-heading .result-cause").allTextContents(),
        ["Failure reason was not saved", "Work IQ required sign-in at the time", "Access was denied"]);
    await expect(calls.locator(".reader-recorded-signal")).toHaveCount(0);
    assert.equal(await calls.locator(":scope > .context-help-note").count(), 0, "No repeated historical-access lecture between calls");
    for (const [index, call] of (await calls.all()).entries()) {
        const visible = await call.innerText();
        assert.doesNotMatch(visible, /WIRE cannot establish|HTTP 401|HTTP 403|Sign in now|Historical call evidence only|Error prose is not retained|No downstream service target is available/);
        await expect(call.locator('[data-attribution-kind="attribution-gap"]')).toContainText("No usable service target is present");
        if (index === 3) {
            assert.doesNotMatch(visible, /Tool failed|sign-in|access denial|Failure cause|No error details/);
            continue;
        }
        assert.equal(await call.getByRole("button", { name: /sign in|retry|authenticate/i }).count(), 0, "Historical signals never add a sign-in or retry action");
        await expect(call.locator(":scope > details")).toHaveCount(0);
        const details = call.locator(".technical-detail");
        if (index === 0) {
            assert.doesNotMatch(visible, /source omitted|collection excluded|sign-in|access denial|Historical call evidence only/,
                "The retained-record gap must not invent an omission/exclusion cause or historical access signal");
        } else {
            await expect(call.locator(".call-heading .result-cause")).toHaveText(index === 1 ? "Work IQ required sign-in at the time" : "Access was denied");
        }
    }
});

test("expanded details retain contradictory completion, real linkage and exact diagnostic arguments", async t => {
    const args = { entityUrls: ["/me/messages"], script: "  synthetic diagnostic\n  preserve indentation" };
    const { page } = await setup(t, { actor: "user", calls: [{
        requestArgs: args, requestedApiPath: "/me/messages",
        reportedOutcome: "succeeded", toolSucceeded: false, parentToolCallId: "synthetic-parent", parallelGroup: "synthetic-group",
        observedGraphHttp: true, apiResults: [{ index: 0, statusCode: 403, errorCode: "SyntheticAccessDenied", evidenceLevel: "intermediary-reported" }],
    }, { requestArgs: {}, requestedApiPath: null, apiResults: [], reportedOutcome: undefined, toolSucceeded: undefined }] });
    const calls = page.locator(".request-context-timeline > li[data-context-kind=action]");
    const details = calls.first().locator(".technical-detail");
    await openCall(calls.first());
    await expect(details).toBeVisible();
    await expect(calls.first().locator(":scope > details")).toHaveCount(0);
    assert.match(await details.innerText(), /Reported outcome\s+succeeded\s+Execution success\s+false/);
    const source = await openSource(page);
    await openIdentifiers(source);
    await expect(source.locator(".reader-fields>div").filter({ has: page.getByText("Call #1 parent invocation", { exact: true }) }).locator("dd")).toHaveText("synthetic-parent");
    await expect(source.locator(".reader-fields>div").filter({ has: page.getByText("Call #1 parallel group", { exact: true }) }).locator("dd")).toHaveText("synthetic-group");
    assert.match(await details.innerText(), /HTTP directly observed/);
    assert.match(await calls.first().innerText(), /intermediary-reported/);
    assert.match(await calls.first().innerText(), /403/);
    assert.match(await calls.first().innerText(), /SyntheticAccessDenied/);
    assert.doesNotMatch(await source.innerText(), /Missing linkage|No parent|does not collect parallel/);
    await expect(details.locator(".recorded-arguments")).toContainText("/me/messages");
    await details.getByRole("button", { name: "Copy recorded arguments", exact: true }).click();
    assert.equal(await page.evaluate(() => window.clipboardProof.writes.at(-1)), JSON.stringify(args, null, 2));
    await details.getByRole("button", { name: "Copy script", exact: true }).click();
    assert.equal(await page.evaluate(() => window.clipboardProof.writes.at(-1)), args.script);
    assert.doesNotMatch(await calls.nth(1).innerText(), /Tool failed|Failure cause/);
    await capture(page, "contradictory-completion-expanded");
});

test("normal request page leads with readable content and explicit, scoped reader actions", { timeout: 60000 }, async t => {
    const { page, requests } = await setup(t), failures = [];
    for (const theme of ["light", "dark"]) for (const { width, scale } of [{ width: 1200, scale: 1 }, { width: 375, scale: 2 }]) {
        await readerTheme(page, theme, width, scale);
        await capture(page, `whole-page-${theme}-${width}-${scale}`);
        const prompt = page.locator(".request-original");
        assert.equal(await prompt.locator(".full-text-content").textContent(), "Find the synthetic planning note.");
        const owner = section(page, "prompt"), copy = owner.getByRole("button", { name: "Copy prompt", exact: true });
        assert.equal((await copy.textContent()).trim(), "");
        await expect(copy.locator('svg[aria-hidden="true"]')).toHaveCount(1);
        await expect(owner.locator(".reader-section-toggle")).toHaveCount(0);
        await expect(prompt.locator(".full-text-toggle")).toHaveCount(0);
        assert.ok(await prompt.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector(".request-intro")) & Node.DOCUMENT_POSITION_FOLLOWING)));
        await expect(page.locator(".interaction-insights,[data-reader-section=reviews]")).toHaveCount(0);
        if (await prompt.getByText("This older record has no sender details", { exact: true }).count() !== 1) failures.push(`${theme}/${width}: Missing sender details are not explained once`);
        if (await prompt.locator(".reader-details").count() !== 0) failures.push(`${theme}/${width}: Redundant About disclosure remains`);
        const description = await copy.getAttribute("aria-describedby");
        if (!(await page.locator(`[id="${description}"]`).textContent()).includes("unmasked")) failures.push(`${theme}/${width}: Copy privacy is not concise and explicit`);
        await expect(page.locator("#reader-copy-notice")).toHaveCount(0);
        const route = page.url(), selection = await page.locator("#activitySelectionSummary").textContent(), reads = contentReads(requests);
        const source = await openSource(page), toggle = source.locator(".reader-section-toggle");
        await expect(source.locator(".response-timing data"), "Missing final-response evidence cannot borrow the recorded tool latency").toHaveCount(0);
        await expect(section(page, "activity").locator('.reader-call-duration data[value="1000"]')).toHaveCount(1);
        await toggle.press("Enter");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await toggle.press("Space");
        assert.equal(await prompt.locator(".full-text-content").textContent(), "Find the synthetic planning note.");
        assert.equal(page.url(), route);
        assert.equal(await page.locator("#activitySelectionSummary").textContent(), selection);
        assert.equal(contentReads(requests), reads, "Source disclosure uses authorized in-memory facts without hiding or re-reading the prompt");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    }
    assert.deepEqual(failures, []);
});

test("normal-page Copy writes only the full exact retained prompt and reports real success or failure", { timeout: 60000 }, async t => {
    const body = exact + "Long retained wording. ".repeat(100) + "\nEND OF PROMPT\n";
    const { page, requests } = await setup(t, { text: body, status: "partial" });
    const prompt = page.locator(".request-original");
    assert.equal(await prompt.locator(".full-text-content").textContent(), body, "Opening an interaction immediately shows even a long retained prompt");
    const owner = section(page, "prompt"), copy = owner.getByRole("button", { name: "Copy prompt", exact: true });
    const reads = contentReads(requests);
    await copy.focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.clipboardProof.writes.length === 1);
    assert.deepEqual(await page.evaluate(() => window.clipboardProof.writes), [body]);
    assert.equal(await copy.evaluate(node => node === document.activeElement), true);
    const status = owner.locator(".ux-copy-status");
    assert.equal(await status.textContent(), "Copied to clipboard.");
    assert.equal(await status.evaluate(node => node.classList.contains("visually-hidden")), true, "Success is announced without inserting a line; the local check icon confirms visually");
    await page.evaluate(() => { window.clipboardProof.mode = "denied"; });
    await copy.click();
    await owner.locator(".ux-copy-status[role=alert]").waitFor();
    assert.match(await status.textContent(), /Couldn't copy.*permission was denied/);
    assert.equal(await copy.getAttribute("data-copy-state"), "error");
    assert.deepEqual(await page.evaluate(() => window.clipboardProof.writes), [body]);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
    await copy.click();
    assert.match(await status.textContent(), /Clipboard access is unavailable/);
    await capture(page, "clipboard-unavailable");
    await page.evaluate(() => { window.installClipboardProof(); window.clipboardProof.mode = "pending"; });
    await copy.click();
    assert.equal(await copy.getAttribute("aria-disabled"), "true");
    assert.equal(await status.textContent(), "Writing to clipboard...");
    await copy.press("Enter");
    assert.equal(await page.evaluate(() => window.clipboardProof.attempts.length), 3, "Pending activation is not replayed");
    await page.evaluate(() => window.finishClipboardProof());
    await page.waitForFunction(() => window.clipboardProof.writes.length === 2);
    assert.deepEqual(await page.evaluate(() => window.clipboardProof.writes), [body, body]);
    assert.equal(contentReads(requests), reads, "Copy never requests source/evidence, metadata, response or report data");
    await copy.click();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await page.evaluate(() => window.finishClipboardProof());
    await page.waitForFunction(() => window.clipboardProof.writes.length === 3);
    assert.equal(await owner.locator(".full-text-content,.ux-copy,.ux-copy-status").count(), 0, "Late clipboard completion does not reopen hidden text or restore external stale feedback");
    await page.locator(".request-card-open").click();
    assert.equal(await prompt.locator(".full-text-content").textContent(), body);
    assert.equal(await page.evaluate(() => window.clipboardProof.reads), 0);
    await capture(page, "clipboard-success");
    if (proof) await writeFile(path.join(proof, "clipboard-proof.json"), JSON.stringify({
        seam: "Owned browser navigator.clipboard seam, not the OS clipboard", exactPayloadLength: body.length,
        copies: 3, deniedAttempt: true, unavailableApi: true, duplicatePendingBlocked: true, hiddenReaderStayedHidden: true, sourceReadsOnCopy: 0,
    }, null, 2));
});

test("unavailable and zero-action requests stay honest; partial/full prompt copies preserve every byte", { timeout: 60000 }, async t => {
    for (const [status, text, actor] of [
        ["unavailable", "UNAVAILABLE_TEXT_MUST_NOT_BE_COPIED", "unknown"],
        ["full", "", "unknown"],
        ["full", "Short exact prompt.\r\n  trailing spaces  \n", "user"],
        ["partial", exact + "<not-html>&literal", "agent"],
    ]) {
        const { page, requests } = await setup(t, { status, text, actor, calls: false });
        const prompt = page.locator(".request-original");
        assert.equal(await section(page, "prompt").locator(".reader-section-heading [data-prompt-actor]").getAttribute("data-prompt-actor"), actor);
        await page.getByText("No individual action details were retained.", { exact: true }).waitFor();
        if (!text || status === "unavailable") {
            assert.equal(await section(page, "prompt").locator(".full-text-toggle,.ux-copy,.full-text-content").count(), 0);
            assert.match(await prompt.innerText(), status === "unavailable" ? /Prompt text unavailable/ : /No prompt text retained/);
            assert.doesNotMatch(await prompt.innerText(), /UNAVAILABLE_TEXT_MUST_NOT_BE_COPIED/);
        } else {
            const reads = contentReads(requests);
            await section(page, "prompt").getByRole("button", { name: "Copy prompt", exact: true }).click();
            await page.waitForFunction(() => window.clipboardProof.writes.length === 1);
            assert.deepEqual(await page.evaluate(() => window.clipboardProof.writes), [text]);
            assert.equal(contentReads(requests), reads);
            if (status === "partial") {
                assert.equal(await prompt.getByText("Partial text", { exact: true }).count(), 1);
                assert.equal(await prompt.locator(".reader-state-partial").isVisible(), true);
            }
        }
        await capture(page, `availability-${status}-${actor}-${text ? "text" : "empty"}`);
    }
});

for (const newerInput of [false, true]) test(`unrelated accepted refresh preserves ${newerInput ? "newer disclosure focus" : "focused prompt"} and reading position`, async t => {
    const body = exact + "Long retained wording. ".repeat(100) + "\nEND OF PROMPT\n";
    const { page, addUnrelatedRecord } = await setup(t, { text: body, entry: "card" });
    await page.locator('.request-card-open[href*="request=detail-reading"]').click();
    await page.waitForFunction(() => !document.getElementById("contextSidebar").getAnimations().length);
    const text = page.locator(".request-original .full-text-content");
    await text.focus();
    await expect(text).toBeFocused();
    await addUnrelatedRecord();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        entered.resolve(); await release.promise;
        await route.fulfill({ response });
    }, { times: 1 });
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await entered.promise;
    const focused = newerInput ? section(page, "source").locator(".reader-section-toggle") : text;
    if (newerInput) await focused.click();
    await expect(focused).toBeFocused();
    const before = await focused.boundingBox();
    release.resolve();
    await refreshed; await ready(page);
    await expect(focused).toBeFocused();
    await expect(page.locator("#contextSidebarBody [aria-busy=true]")).toHaveCount(0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await text.textContent(), body);
    const after = await focused.boundingBox();
    assert.ok(Math.abs(after.y - before.y) <= 1, `An unrelated accepted refresh preserves the latest reading position: ${before.y} -> ${after.y}`);
    if (newerInput) await expect(section(page, "source")).toHaveAttribute("data-open", "true");
});

test("normal response reader opens retained text immediately with explicit Retry, exact Copy and local Hide", { timeout: 60000 }, async t => {
    const responseText = "SYNTHETIC RESPONSE ONLY\r\n  exact response spaces  \n"
        + exact.replace("SYNTHETIC original prompt", "A retained response fragment") + "END OF RESPONSE";
    const { page, requests, responseState } = await setup(t, { responseText, responseMode: "pending", neighbor: true });
    const owner = section(page, "response"), host = owner.locator(".interaction-response");
    const evidenceReads = () => requests.filter(request => new URL(request.url).pathname === "/api/assessment/evidence").length;
    const read = host.getByRole("button", { name: "Read response", exact: true });
    await read.waitFor();
    await host.getByText("Reading already-retained response...", { exact: true }).waitFor();
    assert.equal(await read.isDisabled(), true);
    assert.equal(evidenceReads(), 1);
    await capture(page, "response-busy", ".interaction-response");
    responseState.mode = "error"; responseState.finish();
    await host.locator(".error").waitFor();
    assert.equal(await host.locator(".error").getAttribute("role"), "alert");
    assert.match(await host.innerText(), /Synthetic retained-text read failed/);
    assert.equal(await host.locator(".ux-copy").count(), 0);
    const retry = host.getByRole("button", { name: "Retry response", exact: true });
    assert.equal(await retry.isDisabled(), false);
    assert.equal(evidenceReads(), 1, "An eager-read failure is not automatically retried");
    await capture(page, "response-error", ".interaction-response");
    responseState.mode = "success";
    await retry.click();
    const copy = owner.getByRole("button", { name: "Copy response", exact: true });
    await copy.waitFor();
    await expect(host.locator(".full-text-content")).toBeFocused();
    await expect(owner.getByRole("button", { name: "Hide response", exact: true })).toHaveCount(0);
    assert.equal((await copy.textContent()).trim(), "");
    assert.equal(await copy.getAttribute("aria-label"), "Copy response");
    assert.equal(await host.locator(".full-text-content").textContent(), responseText);
    await expect(host.locator("..")).toHaveAttribute("data-context-group", "detail-reading");
    assert.equal(await host.locator(".reader-details:visible").count(), 0, "Response qualifications and copy privacy stay visible without another disclosure");
    assert.equal(await owner.getByRole("heading").count(), 1, "One visible Response section heading orients the retained text");
    assert.match(await host.innerText(), /Final-answer status unverified/);
    const reads = evidenceReads();
    await copy.click();
    await page.waitForFunction(() => window.clipboardProof.writes.length === 1);
    assert.deepEqual(await page.evaluate(() => window.clipboardProof.writes), [responseText]);
    assert.equal(evidenceReads(), reads, "Copy does not request any evidence");
    await owner.locator(".reader-section-toggle").press("Enter");
    assert.equal(await owner.locator(".full-text-content,.ux-copy").count(), 0);
    await owner.locator(".reader-section-toggle").press("Space");
    await expect(host.locator(".full-text-content")).toHaveText(responseText);
    assert.equal(await host.locator(".full-text-content").textContent(), responseText);
    assert.equal(evidenceReads(), reads + 1, "Reopening makes exactly one authorized already-retained evidence read, never a source/provider operation");
    assert.equal(await page.locator(".request-original .full-text-content").textContent(), "Find the synthetic planning note.");
    for (const theme of ["light", "dark"]) for (const { width, scale } of [{ width: 1200, scale: 1 }, { width: 375, scale: 2 }]) {
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await page.locator(".request-card-open").first().click();
        await host.locator(".full-text-content").waitFor();
        assert.equal(await host.locator(".full-text-content").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await capture(page, `response-retained-${theme}-${width}-${scale}`, ".interaction-response");
    }
    const readsBeforeNeighbor = evidenceReads();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await page.locator('.request-card-open[href*="request=detail-neighbor"]').click();
    await expect(page.locator('.interaction-response[data-context-group="detail-neighbor"] .reader-empty')).toBeVisible();
    await expect(page.locator("#requestContent")).not.toContainText(responseText);
    assert.equal(evidenceReads(), readsBeforeNeighbor, "A neighboring interaction cannot read or inherit the selected interaction's reply");
});

test("a retained-evidence detail error cannot leave the response falsely busy or add a retired host", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { detailError: true });
    const response = page.locator(".interaction-response");
    await response.getByText("Response availability could not be read.", { exact: true }).waitFor();
    assert.equal(await response.getByRole("alert").count(), 1);
    assert.equal(await response.getAttribute("aria-busy"), null);
    assert.equal(await response.locator("h2").textContent(), "Copilot reply");
    await expect(page.locator(".interaction-insights")).toHaveCount(0);
    assert.equal(await response.locator(".reader-details").count(), 0);
    assert.match(await response.innerText(), /Synthetic local insight read failed/);
    assert.equal(await page.locator(".request-original .full-text-content").textContent(), "Find the synthetic planning note.");
    await capture(page, "whole-page-insight-error");
});

test("composed author helpers give truthful readable source and actor cues on the normal detail page", { timeout: 60000 }, async t => {
    const colors = {};
    for (const [actor, label] of [["user", "My prompt"], ["agent", "Agent prompt"], ["unknown", "Author unverified"]]) {
        const { page } = await setup(t, { actor });
        const heading = section(page, "prompt").locator(".reader-section-heading [data-prompt-actor]");
        assert.equal(await heading.textContent(), label);
        await expect(heading).toHaveAttribute("data-prompt-actor", actor);
        await openSource(page);
        await expect(page.locator(".reader-source dt")).toHaveText("Copilot Chat");
        await expect(page.locator(".reader-source dd")).toHaveText("Synthetic planning chat");
        if (actor === "unknown") await expect(page.locator(".request-original").getByText("This older record has no sender details", { exact: true })).toHaveCount(1);
        for (const theme of ["light", "dark"]) for (const { width, scale } of [{ width: 1200, scale: 1 }, { width: 375, scale: 2 }]) {
            await readerTheme(page, theme, width, scale);
            const paint = await heading.evaluate(node => {
                let background = node;
                while (background.parentElement && ["rgba(0, 0, 0, 0)", "transparent"].includes(getComputedStyle(background).backgroundColor)) background = background.parentElement;
                return { color: getComputedStyle(node).color, background: getComputedStyle(background).backgroundColor,
                    clipped: node.scrollWidth > node.clientWidth + 1 };
            });
            assert.ok(contrast(paint.color, paint.background) >= 4.5, `${theme}/${actor}: readable author cue`);
            assert.equal(paint.clipped, false);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            colors[theme] ??= {};
            colors[theme][actor] = { color: paint.color, label: await heading.textContent() };
            await capture(page, `author-${actor}-${theme}-${width}-${scale}`);
        }
    }
    for (const [theme, values] of Object.entries(colors)) assert.equal(new Set(Object.values(values).map(value => value.label)).size, 3, `${theme}: explicit role words distinguish user, agent and unknown without inventing color meaning`);
    const { page } = await setup(t, { chatOrigin: false });
    assert.equal(await section(page, "prompt").locator(".reader-section-heading [data-prompt-actor]").textContent(), "Author unverified");
    assert.match(await (await openSource(page)).innerText(), /No project associated/);
});

test("canonical host-envelope normalization reaches My prompt without copying wrapper metadata", { timeout: 30000 }, async t => {
    const body = "COPIED_BODY_ONLY\r\nCheck the synthetic MCP guide.\n";
    const timestamp = "2026-09-30T12:00:00.000Z";
    const sourceEvent = {
        id: "synthetic-canvas-user-event", type: "user.message", timestamp,
        data: { content: body, messageId: "11111111-1111-4111-8111-111111111111", delivery: "idle", agentMode: "interactive",
            transformedContent: `<current_datetime>${timestamp}</current_datetime>\n\n${body}\n\n<canvas-context>Opaque untrusted attachment. Author: agent-not-authority.</canvas-context>` },
    };
    const { page, record, requests } = await setup(t, { sourceEvent });
    assert.deepEqual(record.userPrompt.authorship, { actor: "user", basis: "host-direct-input" });
    assert.equal(record.userPrompt.authorshipVersion, promptAuthorship.version);
    assert.equal(await section(page, "prompt").locator(".reader-section-heading [data-prompt-actor]").textContent(), "My prompt");
    await openSource(page);
    await expect(page.locator(".reader-source dt")).toHaveText("Copilot Chat");
    await expect(page.locator(".reader-source dd")).toHaveText("Synthetic coordinator chat");
    assert.equal(await page.locator(".request-original .reader-state").count(), 0, "Supported host metadata does not retain an unverified-author warning");
    assert.equal(await page.locator(".request-original .full-text-content").textContent(), body);
    const reads = contentReads(requests);
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    await page.waitForFunction(() => window.clipboardProof.writes.length === 1);
    assert.deepEqual(await page.evaluate(() => window.clipboardProof.writes), [body]);
    assert.equal(contentReads(requests), reads);
    await capture(page, "canonical-host-envelope-user");
});
