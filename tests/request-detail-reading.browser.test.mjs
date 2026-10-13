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

async function setup(t, { text = "Find the synthetic planning note.", status = "full", actor = "unknown", calls = true, responseText, responseMode = "success", detailError = false, chatOrigin = true, sourceEvent } = {}) {
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
    else Object.assign(record.toolCalls[0], { startedAt: "2026-09-30T12:00:01Z", completedAt: "2026-09-30T12:00:02Z", durationMs: 1000 });
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
                    "/api/assessment/evidence", "/api/evaluation/automatic/summary"].includes(new URL(request.url).pathname));
            assert.deepEqual(unexpected.map(request => new URL(request.url).pathname), [],
                "Only local synthetic reads; no capture, collection, report, feedback or consent changes");
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#request?request=detail-reading"); await ready(page);
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
    const context = page.locator(contextSelector);
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
        if (!(await copy.textContent()).includes("Copy prompt")) failures.push(`${theme}/${width}: Copy is icon-only`);
        const hide = prompt.getByRole("button", { name: "Hide prompt", exact: true });
        if (await hide.textContent() !== "Hide prompt") failures.push(`${theme}/${width}: Hide lacks its visible subject`);
        assert.ok(await page.locator(".request-intro").evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector(".request-original")) & Node.DOCUMENT_POSITION_FOLLOWING)));
        if (!await prompt.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector(".interaction-insights")) & Node.DOCUMENT_POSITION_FOLLOWING))) failures.push(`${theme}/${width}: Derived insights precede actual prompt`);
        if (await prompt.getByText("This older record has no sender details", { exact: true }).count() !== 1) failures.push(`${theme}/${width}: Missing sender details are not explained once`);
        if (await prompt.locator(".reader-details").count() !== 1) failures.push(`${theme}/${width}: Secondary explanations are not grouped`);
        else assert.equal(await prompt.locator(".reader-details").getAttribute("open"), null, "Secondary source/privacy detail is on demand");
        if (!(await prompt.innerText()).includes("unmasked")) failures.push(`${theme}/${width}: Copy privacy is not concise and explicit`);
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
    assert.equal(await status.evaluate(node => node.classList.contains("visually-hidden")), false);
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
                await prompt.locator(".reader-details > summary").click();
                assert.match(await prompt.innerText(), /Only part of the original was recorded/);
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
    assert.match(await copy.textContent(), /Copy response/);
    assert.equal(await host.locator(".full-text-content").textContent(), responseText);
    assert.equal(await host.locator(".reader-details:visible").count(), 1, "Loaded response has one combined source/copy explanation, not stacked duplicates");
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
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
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
    await response.locator(".reader-details > summary").click();
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
        assert.equal(await page.locator(".request-source-label").textContent(), "GitHub Copilot chat");
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
    assert.equal(await page.locator(".request-source-label").textContent(), "Source");
    assert.equal(await page.locator(".request-context-meta .unscoped").textContent(), "Project not recorded");
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
    assert.equal(await page.locator(".request-source-label").textContent(), "GitHub Copilot chat");
    assert.equal(await page.locator(".request-original .reader-state").count(), 0, "Supported host metadata does not retain an unverified-author warning");
    assert.equal(await page.locator(".request-original .full-text-content").textContent(), body);
    const reads = contentReads(requests);
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    await page.waitForFunction(() => window.clipboardProof.writes.length === 1);
    assert.deepEqual(await page.evaluate(() => window.clipboardProof.writes), [body]);
    assert.equal(contentReads(requests), reads);
    await capture(page, "canonical-host-envelope-user");
});
