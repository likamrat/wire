import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";
import { contract, samples } from "./assessment-ui-fixtures.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { contrast } from "./color-measurements.mjs";
import { promptRecord, promptAuthorship } from "../lib/prompt-authorship.mjs";
import { recordedInteractionModels } from "../lib/interaction-model.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";

const proof = process.env.WIRE_DETAIL_PROOFS;
const ready = page => page.locator('#workspace[aria-busy="false"]').waitFor();
const exact = "SYNTHETIC original prompt\n  Preserve these spaces.  \nJapanese: \u65e5\u672c\u8a9e; Hebrew: \u05e9\u05dc\u05d5\u05dd; emoji: \ud83d\udc69\u200d\ud83d\udcbb; e\u0301\n";

function retainedResponse(text, record) {
    const model = buildAssessmentModel({ revision: 1, pseudonymKey: "a".repeat(64), evidence: [record], exports: [] });
    const view = [...model.details.values()][0], consent = { ...samples.enabledConsent(), categories: ["answer"] };
    view.basis.consentRevision = 1;
    for (const item of [view.interaction, ...view.observations, ...view.assessments, ...view.metrics]) item.basis = { ...view.basis };
    Object.assign(view.interaction, { sourceConfigRef: consent.sourceConfigRef, sourceConfigRevision: consent.sourceConfigRevision });
    view.consent = consent;
    view.observations.push({
        schemaVersion: 1, interactionRef: view.interaction.interactionRef, basis: { ...view.basis },
        createdAt: samples.at, evidenceRefs: [samples.id("evidence", 80)], observationRef: samples.id("observation", 80),
        memberRef: null, adapter: "copilot-local-events-v1", kind: "answer", origin: "optional-capture",
        availability: "available", reason: null, occurredAt: samples.at, sourceEventRefs: [samples.id("event", 80)],
        deletionKeys: [...new Set(view.interaction.members.flatMap(member => member.deletionKeys))],
        payload: { textRef: samples.id("text", 80), utf8Bytes: Buffer.byteLength(text), completeness: "bounded-fragment", finality: "unverified", credentialScreenVersion: 1, credentialScreen: "passed" },
        captureContext: { consentRevision: 1, sourceConfigRef: consent.sourceConfigRef, sourceConfigRevision: consent.sourceConfigRevision },
    });
    return contract.validateInteractionView(view);
}

async function setup(t, { text = "Find the synthetic planning note.", status = "full", actor = "unknown", calls = true, responseText, responseMode = "success", detailError = false, chatOrigin = true, sourceEvent, entry = "reader", modelTiming = false } = {}) {
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
            { id: "synthetic-response", type: "assistant.message", timestamp: "2026-09-30T12:01:48.640Z", data: {
                originatingMessageId: "synthetic-logical-prompt", apiCallId: "synthetic-api-anchor", model: "synthetic-model",
                content: "Synthetic final response for metadata only.", turnId: "synthetic-turn", phase: "final_answer", toolRequests: [],
            } },
            { id: "synthetic-end", type: "assistant.turn_end", timestamp: "2026-09-30T12:01:48.700Z", data: { turnId: "synthetic-turn" } },
        ];
        record.responseTiming = recordedResponseTiming(events, record.userPrompt);
        record.originalModelEvidence = recordedInteractionModels(events, record);
    }
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, [record]);
    const before = await loadBoardState(context);
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
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []);
            assert.ok(requests.every(request => new URL(request.url).origin === new URL(runtime.url).origin), "No external requests");
            const unexpected = requests.filter(request => request.method === "POST" &&
                !["/api/snapshot", "/api/connect", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
                    "/api/assessment/evidence", "/api/evaluation/automatic/summary", "/api/evaluation/automatic/setup"].includes(new URL(request.url).pathname));
            assert.deepEqual(unexpected.map(request => new URL(request.url).pathname), [],
                "Only local synthetic reads; no capture, collection, report, feedback or consent changes");
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + (entry === "card" ? "" : "#request?request=detail-reading")); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    return { page, record, requests, runtime, responseState };
}
async function capture(page, name, contextSelector = ".request-intro") {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.mouse.move(0, 0);
    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(proof, `${name}.png`), fullPage: true });
    await page.screenshot({ path: path.join(proof, `${name}-viewport.png`) });
    const context = page.locator(contextSelector + ":visible").first();
    if (await context.count()) {
        await context.evaluate(node => scrollTo(0, scrollY + node.getBoundingClientRect().top
            - document.querySelector(".app-header").getBoundingClientRect().height - 16));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        await page.screenshot({ path: path.join(proof, `${name}-reading-context.png`) });
    }
}
function contentReads(requests) {
    return requests.filter(request => ["/api/snapshot", "/api/assessment/detail", "/api/assessment/evidence"].includes(new URL(request.url).pathname)).length;
}

test("normal-entry Copy feedback never moves the prompt or adds a status row", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { actor: "user", text: exact, entry: "card" });
    await page.locator("#resultsLink").click();
    await page.locator("#activityList>.request-row").getByRole("link", { name: "View interaction", exact: true }).click();
    await ready(page);
    await page.locator(".interaction-response .reader-empty").waitFor();
    const copy = page.getByRole("button", { name: "Copy prompt", exact: true });
    const geometry = () => page.locator(".request-original").evaluate(root => {
        const box = selector => {
            const { x, y, width, height } = root.querySelector(selector).getBoundingClientRect();
            return { x, y, width, height };
        };
        return { prompt: box(".full-text-content"), header: box(".full-text-header"),
            actions: box(".full-text-reader-actions"), facts: box(".reader-facts"),
            scrollY, pageHeight: document.documentElement.scrollHeight };
    });
    const measurements = [];
    for (const [theme, width, scale] of [["dark", 1440, 1], ["light", 1440, 1], ["dark", 375, 2], ["light", 375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await copy.focus();
        const before = await geometry();
        await page.evaluate(() => { window.clipboardProof.mode = "pending"; });
        await copy.press("Enter");
        assert.equal(await copy.getAttribute("aria-busy"), "true");
        assert.deepEqual(await geometry(), before, "Pending copy uses the existing button, not a new line");
        await page.evaluate(() => window.finishClipboardProof());
        await page.waitForFunction(() => document.querySelector(".request-original .ux-copy").dataset.copyState === "success");
        const after = await geometry();
        measurements.push({ theme, width, scale, before, after });
        assert.equal(await copy.evaluate(node => node === document.activeElement), true);
        assert.deepEqual(after, before, "Copy success must not insert a line, move the prompt/facts, scroll, or change page height");
        const status = page.locator(".request-original .ux-copy-status");
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
    const { page, record } = await setup(t, { actor: "user", modelTiming: true, entry: "card", calls: [{
        tool: "workiq-ask", requestArgs: { question: "Find the invented planning note.", timeZone: "UTC" },
        requestedApiPath: null, apiResults: [], durationMs: 73728,
        startedAt: "2026-09-30T12:00:01.107Z", completedAt: "2026-09-30T12:01:14.835Z",
        parentInvocationEvidence: "source-field-absent", parallelGroupEvidence: "adapter-not-supported",
    }] });
    await page.locator("#resultsLink").click();
    await page.locator("#activityList>.request-row").getByRole("link", { name: "View interaction", exact: true }).click();
    await ready(page);
    await page.locator(".interaction-response .reader-empty").waitFor();
    const reader = page.locator("#requestContent"), call = reader.locator("[data-tool-call-id]");
    assert.equal(await call.locator(".call-heading h3").innerText(), "workiq-ask");
    assert.match(await call.locator(".interaction-response").innerText(), /No saved response\. Capture is off\./);
    assert.equal(await reader.locator(".request-context-summaries>summary").count(), 0);
    assert.equal(await reader.getByRole("heading", { name: "Reviews", exact: true }).isVisible(), true);
    const pick = reader.getByRole("button", { name: "Add to report", exact: true });
    assert.ok((await pick.boundingBox()).y < (await reader.locator(".full-text-content").boundingBox()).y);
    await pick.click();
    assert.equal(await reader.getByRole("button", { name: "Remove from report", exact: true }).isVisible(), true);
    await reader.getByRole("button", { name: "Remove from report", exact: true }).click();
    const details = call.locator(":scope > details");
    await details.locator("summary").focus(); await page.keyboard.press("Enter");
    assert.equal(await details.evaluate(node => node.open), true);
    assert.equal(await details.locator(".reader-identifier").textContent(), record.toolCalls[0].toolCallId);
    assert.equal(await details.getByRole("button", { name: /^Copy .*id$/i }).count(), 0);
    assert.doesNotMatch(await details.innerText(), /HTTP not|parent invocation|parallel group|independent or serial/i,
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
    await details.locator("summary").click();
    const saved = reader.locator(".assessment-saved-details");
    await saved.locator("summary").click();
    assert.match(await saved.innerText(), /Saved execution checks|Completion/);
    await saved.locator("summary").click();
    const source = reader.locator(".request-support>details");
    await source.locator("summary").click();
    assert.match(await source.innerText(), /synthetic-prompt/);
    assert.equal(await source.locator(".ux-copy").count(), 0);
    await source.locator("summary").click();
    const feedback = reader.getByRole("button", { name: "Details and feedback", exact: true });
    await feedback.click();
    assert.equal(await page.getByRole("dialog").isVisible(), true);
    await page.getByRole("dialog").getByText("Recorded measures and definitions", { exact: true }).click();
    assert.ok(await page.getByRole("dialog").locator(".single-interaction-measures").isVisible());
    await page.keyboard.press("Escape");
    assert.equal(await feedback.evaluate(node => node === document.activeElement), true);
    const automatic = reader.getByRole("button", { name: "Automatic scores", exact: true });
    await automatic.click();
    assert.equal(await page.getByRole("dialog", { name: "Automatic scores", exact: true }).isVisible(), true);
    await page.getByRole("dialog", { name: "Automatic scores", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(await automatic.evaluate(node => node === document.activeElement), true);
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
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
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
            "Report selection above prompt; no automatic navigation", "Synthetic exact arguments copied",
            "Clipboard failure explicit and retry clears it", "Selectable exact IDs without copy buttons",
            "Review state visible without outer disclosure", "Saved checks and source details independently operable",
            "Definitions dialog opens, Escape restores focus", "Automatic scores opens and closes without approval",
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
        await page.locator("#resultsLink").click();
        const card = page.locator("#activityList>.request-row"), open = card.getByRole("link", { name: "View interaction", exact: true });
        assert.match(await card.innerText(), /synthetic-model/);
        assert.equal(await card.locator(".response-timing data").getAttribute("value"), "108640");
        await open.scrollIntoViewIfNeeded();
        const cardType = await card.locator(".full-text-preview").evaluate(node => {
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
        const prompt = page.locator(".request-original"), call = page.locator('[data-tool-call-id="synthetic-reading-call-0"]');
        assert.match(await prompt.locator(".interaction-model-fact").innerText(), /synthetic-model/);
        assert.equal(await prompt.locator(".response-timing data").getAttribute("value"), "108640");
        const read = prompt.locator(".full-text-toggle"), copy = prompt.getByRole("button", { name: "Copy prompt", exact: true });
        if (await read.getAttribute("aria-expanded") === "false") await read.click();
        await capture(page, `continuity-${theme}-${width}-${scale}-reader`);
        const measures = await prompt.evaluate(node => {
            const box = element => {
                const r = element.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height, center: r.y + r.height / 2 };
            };
            const controls = [...node.querySelectorAll(".full-text-reader-actions>button")];
            const style = getComputedStyle(node.querySelector(".full-text-content"));
            return {
                promptType: { font: style.fontFamily, size: style.fontSize, weight: style.fontWeight, style: style.fontStyle },
                controls: controls.map(control => ({ ...box(control), marginTop: getComputedStyle(control).marginTop })),
                content: box(node.querySelector(".full-text-content")),
                keys: [...node.querySelectorAll("dt")].map(key => ({ weight: getComputedStyle(key).fontWeight, color: getComputedStyle(key).color })),
                values: [...node.querySelectorAll("dd")].map(value => ({ weight: getComputedStyle(value).fontWeight, color: getComputedStyle(value).color })),
            };
        });
        await copy.click();
        assert.equal(await page.evaluate(() => window.clipboardProof.writes.at(-1)), text);
        await read.focus(); await page.keyboard.press("Enter");
        assert.equal(await prompt.locator(".full-text-content,.ux-copy").count(), 0);
        assert.equal(await read.evaluate(node => node === document.activeElement), true);
        await page.keyboard.press("Space");
        assert.equal(await prompt.locator(".full-text-content").textContent(), text);
        const details = call.locator(":scope > details");
        if (!await details.evaluate(node => node.open)) await details.locator(":scope > summary").click();
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
        await details.locator(":scope > summary").click();
        await page.getByRole("button", { name: "Add to report", exact: true }).click();
        assert.equal(await page.locator("#requestReportToggle").textContent(), "Remove from report");
        await page.locator("#requestReportToggle").click();
        await page.getByRole("link", { name: "Back to results", exact: true }).click(); await ready(page);
        assert.equal(page.url(), origin);
        assert.equal(await open.evaluate(node => node === document.activeElement), true);
        assert.ok(Math.abs((await open.boundingBox()).y - position.y) < 3, "Back restores the card entry position");
        assert.equal(await card.getByRole("checkbox").isChecked(), false);
    }
    if (proof) await writeFile(path.join(proof, "continuity-metrics.json"), JSON.stringify(metrics, null, 2));
    for (const measurement of metrics) {
        const { cardType, promptType, controls, keys, values, expanded, width, scale } = measurement;
        assert.deepEqual(promptType, cardType, "The full prompt keeps the card's exact font role and bold-italic emphasis");
        assert.ok(controls.every(control => control.height >= 44 && control.width >= 44));
        if (width === 1440) {
            assert.ok(Math.abs(controls[0].center - controls[1].center) <= 1, "Hide and Copy are optically centered on one row");
            assert.ok(Math.abs(controls[0].height - controls[1].height) <= 1, "Hide and Copy have equal visible and hit-target heights");
        }
        assert.ok(keys.every(key => Number(key.weight) >= 500 && values.every(value => Number(value.weight) < Number(key.weight) && value.color !== key.color)));
        assert.equal(expanded.emptyRows, 0, "Missing technical fields are consolidated, not repeated as empty rows");
        assert.equal(expanded.helpButtons, 0, "Expanded facts explain necessary limits directly, not through a tooltip per fact");
        assert.ok(expanded.overflow <= 1, `${width}/${scale}: expanded technical details fit`);
        assert.ok(expanded.keyWeights.every(weight => Number(weight) >= 500));
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
    assert.doesNotMatch(visible, /API path\s+Not recorded|API metadata: None recorded|Outside current view/);
    assert.match(visible, /Failure cause unavailable/);
    assert.doesNotMatch(visible, /Historical call evidence only/);
    assert.match(visible, /No saved response\. Capture is off\./);
    assert.match(await page.locator(".reader-scope").innerText(), /1 of 7.*match/);
    assert.equal(await timeline.locator(".context-selected-label").count(), 0, "A direct interaction entry needs no Selected prompt badge");
    const action = timeline.locator("[data-tool-call-id=synthetic-reading-call-0]");
    await action.locator("details > summary").click();
    assert.match(await action.innerText(), /No API result metadata recorded/);
    await action.locator("details > summary").click();
    for (const [theme, width, scale] of [["light", 1200, 1], ["dark", 1200, 1], ["dark", 375, 2], ["light", 375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        const styles = await page.locator("#requestContent").evaluate(root => {
            const nodes = [...root.querySelectorAll(".full-text-header h2, .interaction-response > h2, .call-heading h3")];
            return {
                headings: nodes.map(node => ({ size: getComputedStyle(node).fontSize, font: getComputedStyle(node).fontFamily, color: getComputedStyle(node).color })),
                overflow: document.documentElement.scrollWidth - innerWidth,
                facts: [...root.querySelectorAll(".reader-facts > dl > div")].map(node => node.getBoundingClientRect().x),
                keyWeights: [...root.querySelectorAll(".reader-facts dt")].map(node => getComputedStyle(node).fontWeight),
                values: [...root.querySelectorAll(".reader-facts dd")].map(node => ({
                    x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y,
                    keyEnd: node.previousElementSibling.getBoundingClientRect().right,
                    keyY: node.previousElementSibling.getBoundingClientRect().y,
                })),
            };
        });
        assert.equal(new Set(styles.headings.map(style => style.size)).size, 1, "Prompt, response and call headings share one type role");
        assert.ok(styles.headings.every(style => style.font.includes("Asta Sans")));
        assert.ok(styles.overflow <= 1, `${theme}/${width}/${scale} does not overflow`);
        assert.ok(styles.facts.every(x => x >= 0 && x < width), "Compact metadata wraps within the reading column");
        assert.equal(new Set(styles.keyWeights).size, 1, "Metadata keys share one weight");
        assert.ok(styles.values.every(value => Math.abs(value.x - value.keyEnd - 8) < 1 || value.y > value.keyY),
            "Each ordinary value follows its own bold key, wrapping below only when needed");
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
            await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
            await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
            for (const [index, name] of ["missing-cause", "sign-in-required", "access-denial", "unknown-outcome"].entries()) {
                await calls.nth(index).screenshot({ path: path.join(proof, `failure-${name}-${theme}-${width}-${scale}.png`) });
            }
        }
    }
    assert.deepEqual(await calls.locator(":scope > .action-error").allTextContents(),
        ["Failure cause unavailable.", "Work IQ sign-in was required", "Tool error mentions access denial"]);
    assert.equal(await calls.locator(":scope > .context-help-note").count(), 0, "No repeated historical-access lecture between calls");
    for (const [index, call] of (await calls.all()).entries()) {
        const visible = await call.innerText();
        assert.doesNotMatch(visible, /WIRE cannot establish|Historical call evidence only|HTTP 401|HTTP 403|Sign in now/);
        if (index === 3) {
            assert.doesNotMatch(visible, /Tool failed|sign-in|access denial|Failure cause/);
            continue;
        }
        assert.equal(await call.getByRole("button", { name: /sign in|retry|authenticate/i }).count(), 0, "Historical signals never add a sign-in or retry action");
        const details = call.locator(":scope > details");
        await details.locator("summary").click();
        assert.match(await details.innerText(), /does not establish current sign-in or permission state/);
        if (index === 0) assert.match(await details.innerText(), /whether the source omitted it or earlier collection excluded it/);
        else assert.match(await details.innerText(), /not a verified cause, access policy, authorization or observed HTTP response/);
        await details.locator("summary").click();
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
    const details = calls.first().locator(":scope > details");
    await details.locator(":scope > summary").click();
    assert.match(await details.innerText(), /Reported outcome\s+succeeded\s+Execution success\s+false/);
    assert.match(await details.innerText(), /synthetic-parent/);
    assert.match(await details.innerText(), /synthetic-group/);
    assert.match(await details.innerText(), /HTTP directly observed/);
    assert.match(await details.innerText(), /intermediary-reported/);
    assert.match(await details.innerText(), /403/);
    assert.match(await details.innerText(), /SyntheticAccessDenied/);
    assert.doesNotMatch(await details.innerText(), /Missing linkage|No parent|does not collect parallel/);
    assert.equal(await calls.first().locator(":scope > .action-fields code").textContent(), "/me/messages");
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
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await capture(page, `whole-page-${theme}-${width}-${scale}`);
        const prompt = page.locator(".request-original");
        assert.equal(await prompt.locator(".full-text-content").textContent(), "Find the synthetic planning note.");
        const copy = prompt.getByRole("button", { name: "Copy prompt", exact: true });
        if ((await copy.textContent()).trim() !== "Copy") failures.push(`${theme}/${width}: Copy needs a visible label beside its subject`);
        const hide = prompt.getByRole("button", { name: "Hide prompt", exact: true });
        if (await hide.textContent() !== "Hide") failures.push(`${theme}/${width}: Hide needs a visible label beside its subject`);
        assert.ok(await page.locator(".request-intro").evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector(".request-original")) & Node.DOCUMENT_POSITION_FOLLOWING)));
        if (!await prompt.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector(".interaction-insights")) & Node.DOCUMENT_POSITION_FOLLOWING))) failures.push(`${theme}/${width}: Derived insights precede actual prompt`);
        if (await prompt.getByText("This older record has no sender details", { exact: true }).count() !== 1) failures.push(`${theme}/${width}: Missing sender details are not explained once`);
        if (await prompt.locator(".reader-details").count() !== 0) failures.push(`${theme}/${width}: Redundant About disclosure remains`);
        if (!(await page.locator("#reader-copy-notice").innerText()).includes("unmasked")) failures.push(`${theme}/${width}: Copy privacy is not concise and explicit`);
        const route = page.url(), selection = await page.locator("#activitySelectionSummary").textContent(), reads = contentReads(requests);
        await hide.focus(); await page.keyboard.press("Enter");
        assert.equal(await prompt.locator(".full-text-content,.ux-copy").count(), 0, "Hide removes only the retained text and its copy action");
        assert.equal(await prompt.locator("h2").count(), 1, "Reader orientation remains");
        await prompt.getByRole("button", { name: "Read prompt", exact: true }).press("Space");
        assert.equal(await prompt.locator(".full-text-content").textContent(), "Find the synthetic planning note.");
        assert.equal(page.url(), route);
        assert.equal(await page.locator("#activitySelectionSummary").textContent(), selection);
        assert.equal(contentReads(requests), reads, "Read/Hide uses the authorized in-memory text, not another source query");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    }
    assert.deepEqual(failures, []);
});

test("normal-page Copy writes only the full exact retained prompt and reports real success or failure", { timeout: 60000 }, async t => {
    const body = exact + "Long retained wording. ".repeat(100) + "\nEND OF PROMPT\n";
    const { page, requests } = await setup(t, { text: body, status: "partial" });
    const prompt = page.locator(".request-original");
    assert.equal(await prompt.locator(".full-text-content").textContent(), body, "Opening an interaction immediately shows even a long retained prompt");
    const copy = prompt.getByRole("button", { name: "Copy prompt", exact: true });
    const reads = contentReads(requests);
    await copy.focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.clipboardProof.writes.length === 1);
    assert.deepEqual(await page.evaluate(() => window.clipboardProof.writes), [body]);
    assert.equal(await copy.evaluate(node => node === document.activeElement), true);
    const status = prompt.locator(".ux-copy-status");
    assert.equal(await status.textContent(), "Copied to clipboard.");
    assert.equal(await status.evaluate(node => node.classList.contains("visually-hidden")), true, "Success is announced without inserting a line; the local check icon confirms visually");
    await page.evaluate(() => { window.clipboardProof.mode = "denied"; });
    await copy.click();
    await page.locator(".request-original .ux-copy-status[role=alert]").waitFor();
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
    await copy.click();
    await prompt.getByRole("button", { name: "Hide prompt", exact: true }).click();
    await page.evaluate(() => window.finishClipboardProof());
    await page.waitForFunction(() => window.clipboardProof.writes.length === 3);
    assert.equal(await prompt.locator(".full-text-content,.ux-copy-status").count(), 0, "Late clipboard completion does not reopen hidden text or restore stale feedback");
    await prompt.getByRole("button", { name: "Read prompt", exact: true }).click();
    assert.equal(await prompt.locator(".full-text-content").textContent(), body);
    assert.equal(await page.evaluate(() => window.clipboardProof.reads), 0);
    assert.equal(contentReads(requests), reads, "Copy never requests source/evidence, metadata, response or report data");
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
        assert.equal(await prompt.locator("h2").getAttribute("data-prompt-actor"), actor);
        await page.getByText("No individual action details were retained.", { exact: true }).waitFor();
        if (!text || status === "unavailable") {
            assert.equal(await prompt.locator(".full-text-toggle,.ux-copy,.full-text-content").count(), 0);
            assert.match(await prompt.innerText(), /Prompt not available/);
            assert.doesNotMatch(await prompt.innerText(), /UNAVAILABLE_TEXT_MUST_NOT_BE_COPIED/);
        } else {
            const reads = contentReads(requests);
            await prompt.getByRole("button", { name: "Copy prompt", exact: true }).click();
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

test("normal response reader opens retained text immediately with explicit Retry, exact Copy and local Hide", { timeout: 60000 }, async t => {
    const responseText = "SYNTHETIC RESPONSE ONLY\r\n  exact response spaces  \n"
        + exact.replace("SYNTHETIC original prompt", "A retained response fragment") + "END OF RESPONSE";
    const { page, requests, responseState } = await setup(t, { responseText, responseMode: "pending" });
    const host = page.locator(".interaction-response:visible");
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
    assert.equal(await read.isDisabled(), false);
    assert.equal(evidenceReads(), 1, "An eager-read failure is not automatically retried");
    await capture(page, "response-error", ".interaction-response");
    responseState.mode = "success";
    await read.click();
    const copy = host.getByRole("button", { name: "Copy response", exact: true });
    await copy.waitFor();
    assert.equal(await host.getByRole("button", { name: "Hide response", exact: true }).evaluate(node => node === document.activeElement), true, "Reading response restores focus to its reader action");
    assert.equal((await copy.textContent()).trim(), "");
    assert.equal(await copy.getAttribute("aria-label"), "Copy response");
    assert.equal(await host.locator(".full-text-content").textContent(), responseText);
    assert.equal(await host.locator(".reader-details:visible").count(), 0, "Response qualifications and copy privacy stay visible without another disclosure");
    assert.equal(await host.getByRole("heading").count(), 1, "The retained response has one heading, not a second nested title");
    assert.match(await host.innerText(), /Final-answer status unverified/);
    const reads = evidenceReads();
    await copy.click();
    await page.waitForFunction(() => window.clipboardProof.writes.length === 1);
    assert.deepEqual(await page.evaluate(() => window.clipboardProof.writes), [responseText]);
    await host.getByRole("button", { name: "Hide response", exact: true }).press("Enter");
    assert.equal(await host.locator(".full-text-content,.ux-copy").count(), 0);
    await host.getByRole("button", { name: "Read response", exact: true }).press("Space");
    assert.equal(await host.locator(".full-text-content").textContent(), responseText);
    assert.equal(evidenceReads(), reads, "Copy/Hide/reopen use only this authorized in-memory response");
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
});

test("an insight read error cannot leave the response section falsely busy", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { detailError: true });
    const response = page.locator(".interaction-response");
    await response.getByText("Response availability could not be read.", { exact: true }).waitFor();
    assert.equal(await response.getByRole("alert").count(), 1);
    assert.equal(await response.getAttribute("aria-busy"), null);
    assert.equal(await response.getByRole("heading", { name: "Response", exact: true }).count(), 1);
    assert.equal(await page.locator(".interaction-insights").getByRole("heading", { name: "Insights", exact: true }).count(), 1);
    assert.equal(await response.locator(".reader-details").count(), 0);
    assert.match(await response.innerText(), /Synthetic local insight read failed/);
    assert.equal(await page.locator(".request-original .full-text-content").textContent(), "Find the synthetic planning note.");
    await capture(page, "whole-page-insight-error");
});

test("composed author helpers give truthful readable source and actor cues on the normal detail page", { timeout: 60000 }, async t => {
    const colors = {};
    for (const [actor, label] of [["user", "Your prompt"], ["agent", "Agent prompt"], ["unknown", "Copilot chat prompt"]]) {
        const { page } = await setup(t, { actor });
        const heading = page.locator(".request-original h2");
        assert.equal(await heading.textContent(), label);
        assert.match(await page.locator(".reader-source").textContent(), /Chat:Synthetic planning chat/);
        for (const theme of ["light", "dark"]) for (const { width, scale } of [{ width: 1200, scale: 1 }, { width: 375, scale: 2 }]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
            await chooseTheme(page, theme);
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
            colors[theme][actor] = paint.color;
            await capture(page, `author-${actor}-${theme}-${width}-${scale}`);
        }
    }
    for (const [theme, values] of Object.entries(colors)) assert.equal(new Set(Object.values(values)).size, 3, `${theme}: user, agent and unknown cues stay distinct`);
    const { page } = await setup(t, { chatOrigin: false });
    assert.equal(await page.locator(".request-original h2").textContent(), "Prompt");
    await page.locator(".request-support>details>summary").click();
    assert.match(await page.locator(".request-support").innerText(), /No project associated/);
});

test("canonical host-envelope normalization reaches Your prompt without copying wrapper metadata", { timeout: 30000 }, async t => {
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
    assert.equal(await page.locator(".request-original h2").textContent(), "Your prompt");
    assert.match(await page.locator(".reader-source").textContent(), /Chat:Synthetic coordinator chat/);
    assert.equal(await page.locator(".request-original .reader-state").count(), 0, "Supported host metadata does not retain an unverified-author warning");
    assert.equal(await page.locator(".request-original .full-text-content").textContent(), body);
    const reads = contentReads(requests);
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    await page.waitForFunction(() => window.clipboardProof.writes.length === 1);
    assert.deepEqual(await page.evaluate(() => window.clipboardProof.writes), [body]);
    assert.equal(contentReads(requests), reads);
    await capture(page, "canonical-host-envelope-user");
});
