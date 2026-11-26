import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { fixture, privateFixture, chooseTheme, revealAnalyzeRecords, navigateMain } from "../support/helpers.mjs";
import { prepareLandingReport } from "../reports/report-journey-helpers.mjs";
import { contract, retainedResponse, samples } from "../evaluation/assessment-ui-fixtures.mjs";
import { graphMatrixRecord } from "../reports/report-evidence-matrix-fixtures.mjs";
import { loadBoardState, replaceEvidence } from "../../lib/store.mjs";
import { qualityDisplayFixture } from "../evaluation/quality-display-fixtures.mjs";

const proofs = process.env.WIRE_READER_PROOFS;
async function captureCorrection(page, name, sectionName, focusSelector) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "docked");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", width < 700 ? "overlay" : "docked");
        await page.locator(focusSelector ?? `[data-reader-section="${sectionName}"]>.reader-section-heading`).evaluate((node, focused) => {
            const body = document.querySelector("#contextSidebarBody");
            body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - (focused ? 96 : 12);
        }, Boolean(focusSelector));
        assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        await page.screenshot({ path: path.join(proofs, `${name}-${theme}-${width}-${scale}.png`) });
    }
}

function readerRecord() {
    const record = fixture("reader-approved");
    record.sourceSessionName = "Invented release review";
    record.userPrompt = {
        text: "Find the invented release notes in mail and shared files.\n  Keep unresolved questions separate.",
        status: "full", sourceEventId: "invented-reader-prompt",
        sourceTimestamp: "2026-09-30T12:00:00.000Z",
        authorship: { actor: "user", basis: "source-user" },
    };
    record.followUpPrompts = [];
    record.toolCalls = [{
        ...record.toolCalls[0], toolCallId: "invented-reader-call",
        requestArgs: { entityUrls: ["/me/messages/invented-note", "/sites/invented/drive/items/release-notes"] },
        requestedApiPath: null, apiResults: [],
        startedAt: "2026-09-30T12:00:02.000Z", completedAt: "2026-09-30T12:00:03.000Z", durationMs: 1000,
    }];
    record.promptAssociation = "Nearest preceding recorded user.message; association is inferred, not a proven causal link. Follow-ups remain separate prompt-group scenarios.";
    record.coverageNote = "Recorded Work IQ invocation, not observed Graph HTTP. Result entity/body content excluded. Missing completions and truncated logs are disclosed in the source roster.";
    return record;
}

async function setup(t, records = [readerRecord()], { responseText, assessmentFixture, responseCompleteness = "bounded-fragment", motion = "reduce", sidebarMotion, saveFrozen = false, initialStorage = {}, touch = false } = {}) {
    const cleanups = [];
    const { context } = await privateFixture({ after: action => cleanups.push(action) }, records);
    const reports = createExportController(context);
    let frozen;
    if (saveFrozen) {
        const state = await loadBoardState(context);
        const preview = await reports.preview("invented-reader-report", undefined, { promptMode: "original", formats: ["html", "pdf", "json", "markdown"] },
            { kind: "selected", revision: state.revision, scenarioIds: [records[0].scenarioId] });
        await reports.review("invented-reader-report", preview.previewId, true);
        const saved = await reports.confirm("invented-reader-report", preview.previewId, true);
        frozen = { files: saved.bundle.files, exports: (await loadBoardState(context)).exports, bytes: new Map() };
        for (const file of Object.values(frozen.files)) frozen.bytes.set(file, await readFile(file));
    }
    let providerCalls = 0;
    const runtime = await startServer(context, reports, { port: 0, collector: { timers: false }, evaluation: {
        evaluatorFactory: async () => { providerCalls++; throw Error("No provider work in reader proof."); },
        readSource: async () => { providerCalls++; throw Error("No source reads in reader proof."); },
    } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: motion, hasTouch: touch });
    const errors = [], requests = [];
    page.setDefaultTimeout(6000);
    page.on("pageerror", error => errors.push(error.stack));
    page.on("request", request => requests.push({ path: new URL(request.url()).pathname, origin: new URL(request.url()).origin }));
    await page.route("**/api/evaluation/**", route => route.abort("blockedbyclient"));
    await page.addInitScript(storage => {
        for (const [key, value] of Object.entries(storage)) sessionStorage.setItem(key, value);
        window.readerCopies = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            readText() { throw Error("Real clipboard reads are forbidden."); },
            async writeText(text) { window.readerCopies.push(text); },
        } });
    }, initialStorage);
    let assessmentView;
    if (responseText !== undefined || assessmentFixture) {
        const texts = responseText === undefined ? [] : Array.isArray(responseText) ? responseText : [responseText];
        const view = assessmentView = assessmentFixture ?? retainedResponse(texts[0], records[0]);
        const first = view.observations.find(item => item.kind === "answer"), responseTexts = new Map(first ? [[first.observationRef, texts[0]]] : []);
        if (first?.payload && responseText !== undefined) first.payload.completeness = responseCompleteness;
        for (let index = 1; index < texts.length; index++) {
            const answer = structuredClone(first);
            answer.observationRef = samples.id("observation", 80 + index);
            answer.sourceEventRefs = [samples.id("event", 80 + index)];
            answer.evidenceRefs = [samples.id("evidence", 80 + index)];
            answer.occurredAt = new Date(Date.parse(first.occurredAt) + index * 1000).toISOString();
            answer.payload = { ...answer.payload, textRef: samples.id("text", 80 + index), utf8Bytes: Buffer.byteLength(texts[index]) };
            view.observations.push(answer);
            responseTexts.set(answer.observationRef, texts[index]);
        }
        contract.validateInteractionView(view);
        const envelope = data => ({ schemaVersion: 1, basis: view.basis, data });
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch(), value = await response.json();
            value.assessment = {
                schemaVersion: 1, basis: view.basis,
                catalog: [{ scenarioId: records[0].scenarioId, interactionRef: view.interaction.interactionRef,
                    interactionRefs: [view.interaction.interactionRef], status: "retained", reason: null }],
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
            await route.fulfill({ json: envelope({ observationRef: input.observationRef, text: responseTexts.get(input.observationRef),
                completeness: responseCompleteness, finality: "unverified", basis: view.basis }) });
        });
    }
    t.after(async () => {
        try {
            await browser.close();
            await runtime.close();
            assert.equal(providerCalls, 0);
            assert.deepEqual(errors, []);
            assert.ok(requests.every(request => request.origin === new URL(runtime.url).origin), "No external requests");
            assert.ok(!requests.some(request => /\/(?:approve|run|recollect|replay|refresh|save)$/.test(request.path)), "Reading does not dispatch consequential work");
            assert.ok(!requests.some(request => request.path.startsWith("/api/evaluation/") || request.path === "/api/assessment/feedback"), "No retired-feature reads or writes");
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });

    if (sidebarMotion) await page.addInitScript(value => localStorage.setItem("workiq-evidence.sidebar-motion", value), sidebarMotion);
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    return { page, records, context, runtime, assessmentView, frozen };
}

async function readerSettled(page) {
    await page.waitForFunction(() => ["contextSidebar", "main", "sidebar"].every(id =>
        !document.getElementById(id).getAnimations().some(animation => animation.playState === "running")));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const sourceToggle = page => page.getByRole("button", { name: "Source details", exact: true });

async function readerShot(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.screenshot({ path: path.join(proofs, name + ".png") });
}

for (const withReply of [false, true]) test(`reader section jumps pair named icons with their real destinations (reply: ${withReply})`, async t => {
    const record = readerRecord();
    if (withReply) record.toolCalls = Array.from({ length: 4 }, (_, i) => ({
        ...record.toolCalls[0], toolCallId: `workshop-call-${i}`, startEventId: `workshop-start-${i}`,
        ...(i === 3 ? { toolSucceeded: false, reportedOutcome: "failed", errorMessage: "The workshop lookup timed out.", apiResults: [] } : {}),
    }));
    const { page } = await setup(t, [record], withReply ? { responseText: "The invented release notes are ready." } : {});
    const jumps = page.getByRole("navigation", { name: "In this interaction" });
    if (withReply) {
        const activity = page.locator('[data-reader-section="activity"]');
        const full = activity.getByRole("link", { name: "Show full activity" });
        if (await full.isVisible()) await full.click();
        await expect(activity.locator("h2 > button").first()).toHaveText("4 recorded calls");
        await expect(activity.locator(".reader-call-row")).toHaveCount(4);
    }
    const destinations = [["Prompt", "prompt", "message-square"], ["Activity", "activity", "rotate-ccw-clock"], ["Tokens", "usage", "layers"],
        ...(withReply ? [["Reply", "response", "message-square-reply"]] : []), ["Source", "source", "list-tree"]];
    if (withReply) await expect(page.locator('[data-reader-section=response] pre')).toBeVisible();
    await chooseTheme(page, withReply ? "light" : "dark");
    for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 950 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await readerSettled(page);
        await jumps.scrollIntoViewIfNeeded();
        await readerShot(page, `section-jumps-${withReply ? "with-reply" : "ordinary"}-${width}`);
        await expect(jumps.getByRole("button")).toHaveText([...destinations.map(([label]) => label), "Add to report", "Hide"]);
        await expect(jumps.getByRole("button", { name: "Add to report" })).toHaveAttribute("aria-haspopup", "dialog");
        for (const [label, name, icon] of destinations) {
            const control = jumps.getByRole("button", { name: label, exact: true });
            await expect(control.locator("svg")).toHaveAttribute("data-lucide-icon", icon);
            await expect(control.locator("svg")).toHaveAttribute("aria-hidden", "true");
            await control.focus(); await page.keyboard.press("Shift");
            await expect(control).toHaveCSS("outline-style", "solid");
            assert.ok(await control.evaluate(node => {
                const rect = node.getBoundingClientRect(), body = document.getElementById("contextSidebarBody");
                const glyph = node.querySelector("svg").getBoundingClientRect(), range = document.createRange();
                range.selectNodeContents(node.lastChild);
                const label = range.getBoundingClientRect();
                return rect.height >= 44 && rect.width <= body.clientWidth && body.scrollWidth <= body.clientWidth + 1
                    && glyph.width > 0 && glyph.right < label.left && label.right <= rect.right
                    && Math.abs((glyph.top + glyph.bottom - label.top - label.bottom) / 2) <= 2;
            }));
            const section = page.locator(`[data-reader-section="${name}"]`);
            const toggle = section.locator(":scope > h2 > .reader-section-toggle");
            if (await toggle.getAttribute("aria-expanded") === "true") await toggle.press("Space");
            await expect(section.locator(":scope > .reader-section-clip")).toHaveJSProperty("inert", true);
            await control.press("Enter");
            await expect(section.locator(":scope > h2")).toBeFocused();
            await expect(section).toHaveAttribute("data-open", "true");
            await expect(control).toHaveAttribute("aria-current", "location");
            await expect(jumps.locator("[aria-current]")).toHaveCount(1);
        }
    }
});

function longReaderRecord() {
    const record = readerRecord();
    record.userPrompt.text = Array.from({ length: 60 }, (_, i) =>
        `Milestone ${i + 1}: Review the invented Northstar release evidence, keep unresolved decisions distinct, and preserve the original source references. `).join("");
    record.toolCalls.push({
        ...record.toolCalls[0], toolCallId: "invented-second-call", startEventId: "invented-second-start", tool: "workiq-get_schema",
        toolSucceeded: false, reportedOutcome: "failed", errorMessage: "Schema not found: /teams/invented/channels/release/startMigration",
        apiResults: [{ index: 0, statusCode: 404, errorCode: "NotFound", errorMessage: "The invented target was not found.", evidenceLevel: "intermediary-reported" }],
    });
    record.graphActivities = [{ ...graphMatrixRecord("reader-geometry-reference").graphActivities[0],
        activityId: "invented-geometry-reference", sourceSessionId: record.sourceSessionId,
        scenarioId: record.scenarioId, evidenceLevel: "code-reference", httpStatus: null, statusBasis: "none" }];
    return record;
}

// Keep a character on the current line, not a scrollTop proxy that passes despite reflow.
async function rememberReaderLine(page, offset = 2400) {
    const expand = page.locator('[data-reader-section="prompt"] .prompt-preview-toggle[aria-expanded=false]');
    if (await expand.isVisible()) await expand.click();
    return page.locator('[data-reader-section="prompt"] pre').evaluate((node, offset) => {
        const body = document.querySelector("#contextSidebarBody"), text = node.firstChild;
        const range = document.createRange();
        range.setStart(text, Math.min(offset, text.length - 1));
        range.setEnd(text, range.startOffset + 1);
        body.scrollTop += range.getBoundingClientRect().top - body.getBoundingClientRect().top - 64;
        const paragraph = document.createRange();
        paragraph.selectNodeContents(node);
        const line = [...paragraph.getClientRects()].find(rect => rect.top >= body.getBoundingClientRect().top + 16);
        const caret = document.caretPositionFromPoint(line.left + 2, line.top + line.height / 2);
        range.setStart(caret.offsetNode, caret.offset); range.setEnd(caret.offsetNode, caret.offset + 1);
        window.readerProofRange = range;
        return range.getBoundingClientRect().top - body.getBoundingClientRect().top;
    }, offset);
}

async function readerLineTop(page) {
    return page.evaluate(() => window.readerProofRange.getBoundingClientRect().top - document.querySelector("#contextSidebarBody").getBoundingClientRect().top);
}

test("combined reader preserves a visible text line, identity, disclosure and chosen width across drag and maximize/restore", { timeout: 45000 }, async t => {
    const record = longReaderRecord();
    const { page } = await setup(t, [record], { motion: "no-preference" });
    await readerSettled(page);
    await expect(page.locator("#requestContent .reader-call-row[data-tool-call-id]")).toHaveCount(2);
    await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(3);
    await expect(page.locator('[data-reader-section="activity"]')).toContainText("Execution not observed");
    const panel = page.locator("#contextSidebar"), width = () => panel.evaluate(node => node.getBoundingClientRect().width);
    const originalWidth = await width(), originalURL = page.url();
    await page.locator('[data-reader-section="source"] .reader-section-toggle').click();
    await page.evaluate(() => { window.originalReader = document.querySelector("#requestContent"); });
    for (const theme of ["dark", "light"]) {
        await chooseTheme(page, theme);
        const line = await rememberReaderLine(page);
        await page.locator("#readerResize").focus();
        await page.keyboard.press("Home");
        assert.ok(Math.abs(await width() - 416) < 1);
        assert.ok(Math.abs(await readerLineTop(page) - line) <= 24, "Narrowing retains the visible characters, not old scroll pixels");
        await page.keyboard.press("ArrowLeft");
        assert.ok(Math.abs(await width() - 448) < 1);
        const handle = await page.locator("#readerResize").boundingBox();
        await page.mouse.move(handle.x + 5, handle.y + 250);
        await page.mouse.down();
        await page.mouse.move(handle.x - 139, handle.y + 250, { steps: 8 });
        await page.mouse.up();
        const chosen = await width();
        assert.ok(Math.abs(chosen - 592) < 2, `Pointer drag width ${chosen}`);
        const afterDrag = await readerLineTop(page);
        assert.ok(Math.abs(afterDrag - line) <= 24, `Drag preserves a reflowed line (${afterDrag} vs ${line})`);
        await readerShot(page, `combined-${theme}-docked`);
        await page.locator("#expandInteraction").focus();
        await page.keyboard.press("Enter");
        await expect(panel).toHaveAttribute("data-mode", "expanded");
        await expect(page.getByRole("button", { name: "Restore reader width", exact: true })).toBeFocused();
        assert.ok(await width() > chosen + 300);
        assert.ok(Math.abs(await readerLineTop(page) - afterDrag) <= 24);
        const currentLine = await rememberReaderLine(page, 4000);
        await readerShot(page, `combined-${theme}-expanded`);
        await page.keyboard.press("Enter");
        await expect(panel).toHaveAttribute("data-mode", "docked");
        assert.ok(Math.abs(await width() - chosen) < 1, "Restore uses the chosen width");
        assert.ok(Math.abs(await readerLineTop(page) - currentLine) <= 24, "Restore keeps current reading, not the pre-maximize location");
        assert.equal(await page.evaluate(() => window.originalReader === document.querySelector("#requestContent")), true);
        await expect(page.locator('[data-reader-section="source"]')).toHaveAttribute("data-open", "true");
        assert.equal(page.url(), originalURL, "Geometry does not create history entries");
        for (const [id, glyph] of [["narrowInteraction", "minus"], ["widenInteraction", "plus"], ["expandInteraction", "maximize-2"]]) {
            const control = page.locator("#" + id);
            assert.equal((await control.innerText()).trim(), "");
            await expect(control.locator("svg")).toHaveAttribute("data-lucide-icon", glyph);
            const box = await control.boundingBox();
            assert.equal(box.width, 44); assert.equal(box.height, 44);
        }
        await page.locator('[data-reader-section="activity"]').evaluate(node => {
            const body = document.querySelector("#contextSidebarBody");
            body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top;
        });
        await readerShot(page, `combined-${theme}-activity`);
    }
    await page.locator("#expandInteraction").hover();
    await expect(page.locator(".ux-tooltip:visible")).toHaveText("Maximize interaction");
    await page.locator("#expandInteraction").click();
    await expect(page.locator("#expandInteraction svg")).toHaveAttribute("data-lucide-icon", "minimize-2");
    await page.locator("#closeContextSidebar").click();
    await expect(panel).not.toBeVisible();
    await expect(page.locator(".request-card-open").first()).toBeFocused();
    assert.equal(await page.locator("#main").evaluate(node => node.inert), false);
    await page.locator(".request-card-open").first().click();
    await readerSettled(page);
    assert.ok(Math.abs(await width() - originalWidth) < 1, "Fresh opening retains the existing default");
    const failed = page.locator('[data-tool-call-id="invented-second-call"]');
    await expect(failed).toBeFocused();
    await expect(failed).toBeInViewport();
});

test("combined reader bounds, touch alternatives and responsive single-pane preserve the current reading", { timeout: 30000 }, async t => {
    const { page } = await setup(t, [longReaderRecord()], { touch: true });
    await readerSettled(page);
    const panel = page.locator("#contextSidebar");
    await page.locator("#narrowInteraction").tap();
    await expect(page.locator("#readerResize")).toHaveAttribute("aria-valuenow", "512");
    await page.locator("#widenInteraction").tap();
    await expect(page.locator("#readerResize")).toHaveAttribute("aria-valuenow", "544");
    await page.locator("#readerResize").focus(); await page.keyboard.press("End");
    const max = Number(await page.locator("#readerResize").getAttribute("aria-valuemax"));
    assert.ok(max <= 736);
    await expect(page.locator("#widenInteraction")).toHaveAttribute("aria-disabled", "true");
    assert.ok(await page.locator("#main").evaluate(node => node.getBoundingClientRect().width >= 576));
    const line = await rememberReaderLine(page);
    await page.setViewportSize({ width: 1100, height: 1000 });
    await expect(panel).toHaveAttribute("data-mode", "overlay");
    assert.equal(await panel.evaluate(node => node.matches(":modal")), true);
    for (const id of ["readerResize", "readerWidthControls", "expandInteraction"]) await expect(page.locator("#" + id)).toBeHidden();
    assert.ok(Math.abs(await readerLineTop(page) - line) <= 24);
    await page.setViewportSize({ width: 390, height: 900 }); await readerSettled(page);
    assert.ok(Math.abs(await readerLineTop(page) - line) <= 24, `Narrow viewport preserves the same text line: ${await readerLineTop(page)} vs ${line}`);
    assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await readerShot(page, "combined-narrow");
    await page.setViewportSize({ width: 1440, height: 1000 }); await readerSettled(page);
    await expect(panel).toHaveAttribute("data-mode", "docked");
    await expect(page.locator("#readerResize")).toHaveAttribute("aria-valuenow", String(max));
    const enlargedLine = await rememberReaderLine(page);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await expect(panel).toHaveAttribute("data-mode", "overlay");
    assert.ok(Math.abs(await readerLineTop(page) - enlargedLine) <= 46, `Enlarged text preserves the same reading: ${await readerLineTop(page)} vs ${enlargedLine}`);
    assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await expect(page.locator("#closeContextSidebar")).toBeInViewport();
    await readerShot(page, "combined-enlarged");
    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
});

test("Source identifiers can be selected without copying or folding the prompt", async t => {
    const { page, records } = await setup(t);
    await sourceToggle(page).press("Enter");
    await page.getByRole("button", { name: "Record identifiers" }).press("Enter");
    const id = page.getByText(records[0].userPrompt.sourceEventId, { exact: true });
    await id.click({ clickCount: 3 });
    assert.equal(await page.evaluate(() => getSelection().toString().trimEnd()), records[0].userPrompt.sourceEventId);
    assert.deepEqual(await page.evaluate(() => window.readerCopies), []);
    await expect(page.locator('[data-reader-section="prompt"] pre')).toHaveText(records[0].userPrompt.text);
});

test("retained response has one section owner that clears and restores exact text and Copy", { timeout: 20000 }, async t => {
    const exact = "Invented retained response.\n  Keep these spaces and the ending newline.\n";
    const { page } = await setup(t, [readerRecord()], { responseText: exact });
    const response = page.locator('[data-reader-section="response"]');
    await expect(response.locator("pre")).toHaveText(exact);
    assert.equal(await response.getByRole("button", { name: "Hide response", exact: true }).count(), 0);
    await response.getByRole("button", { name: "Copy response", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [exact]);
    await response.locator(".reader-section-toggle").click();
    await expect(response.locator("pre")).toHaveCount(0);
    await expect(response.getByRole("button", { name: "Copy response", exact: true })).toHaveCount(0);
    await response.locator(".reader-section-toggle").click();
    await response.getByRole("button", { name: "Read response", exact: true }).click();
    await expect(response.locator("pre")).toHaveText(exact);
    await response.getByRole("button", { name: "Copy response", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [exact, exact]);
});

test("a recorded code argument and its enclosing call copy independently, byte for byte", async t => {
    const record = readerRecord(), code = "  // Invented code; never execute it.\nreturn { retained: true, count: 0 };\n";
    const args = { functionUrl: "/me/calendar/getSchedule", code, custom: { preserve: [false, 0, "unknown-key"] } };
    Object.assign(record.toolCalls[0], { tool: "workiq-call_function", requestArgs: args });
    const { page } = await setup(t, [record]);
    const call = page.locator('[data-tool-call-id="invented-reader-call"]');
    await call.locator(".reader-call-toggle").click();
    await call.getByRole("button", { name: "Copy recorded arguments", exact: true }).click();
    await call.getByRole("button", { name: "Copy code", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [JSON.stringify(args, null, 2), code]);
});

test("response folding fences a late read and keeps failed reads behind explicit Retry", { timeout: 25000 }, async t => {
    const text = "Invented exact response with trailing spaces.  \n";
    const { page } = await setup(t, [readerRecord()], { responseText: text });
    const response = page.locator('[data-reader-section="response"]'), toggle = response.locator(".reader-section-toggle");
    await expect(response.locator("pre")).toHaveText(text);
    const oldCopy = await response.getByRole("button", { name: "Copy response", exact: true }).elementHandle();
    let release, arrive, reads = 0;
    const held = new Promise(resolve => release = resolve), arrived = new Promise(resolve => arrive = resolve);
    const deliveries = [];
    const delayed = route => {
        const delivery = (async () => {
            reads++;
            const request = route.request().postDataJSON();
            arrive(); await held;
            await route.fulfill({ json: { schemaVersion: 1, basis: request.expectedBasis, data: {
                observationRef: request.observationRef, basis: request.expectedBasis, text,
                completeness: "bounded-fragment", finality: "unverified",
            } } });
        })();
        deliveries.push(delivery); return delivery;
    };
    await page.route("**/api/assessment/evidence", delayed);
    try {
        await toggle.click(); await toggle.click();
        const read = response.getByRole("button", { name: "Read response", exact: true });
        await expect(read).toBeVisible();
        assert.equal(reads, 0, "Expanding the section is not an evidence read");
        await read.click(); await arrived;
        await toggle.press("Space");
        await expect(response).toHaveAttribute("data-open", "false");
        release(); await Promise.all(deliveries);
        await expect(response.locator("pre,.ux-copy")).toHaveCount(0);
        await oldCopy.evaluate(node => node.click());
        assert.deepEqual(await page.evaluate(() => window.readerCopies), []);
        assert.equal(reads, 1);
    } finally { release(); await Promise.all(deliveries); await page.unroute("**/api/assessment/evidence", delayed); }
    await toggle.press("Enter");
    await expect(response).toHaveAttribute("data-open", "true");
    await expect(response).toContainText("Read response");
    await response.getByRole("button", { name: "Read response", exact: true }).click();
    await expect(response.locator("pre")).toHaveText(text);
    let failures = 0;
    const failed = route => { failures++; return route.fulfill({ status: 503, json: { error: "Invented retained evidence unavailable" } }); };
    await page.route("**/api/assessment/evidence", failed);
    await toggle.click(); await toggle.click();
    await response.getByRole("button", { name: "Read response", exact: true }).click();
    await expect(response.getByRole("button", { name: "Retry response", exact: true })).toBeVisible();
    await toggle.click(); await toggle.click();
    await expect(response.getByRole("button", { name: "Retry response", exact: true })).toBeVisible();
    assert.equal(failures, 1, "Folding is not a Retry operation");
    await page.unroute("**/api/assessment/evidence", failed);
    await response.getByRole("button", { name: "Retry response", exact: true }).click();
    await expect(response.locator("pre")).toHaveText(text);
});

test("capture revocation scrubs response text and fences an in-flight old-basis read", { timeout: 25000 }, async t => {
    const text = "Invented response revoked before its delayed read completed.";
    const { page, assessmentView } = await setup(t, [readerRecord()], { responseText: text });
    const response = page.locator('[data-reader-section="response"]');
    await expect(response.locator("pre")).toHaveText(text);
    const oldCopy = await response.getByRole("button", { name: "Copy response", exact: true }).elementHandle();
    let release, arrive;
    const held = new Promise(resolve => release = resolve), arrived = new Promise(resolve => arrive = resolve), deliveries = [];
    await page.route("**/api/assessment/evidence", route => {
        const delivery = (async () => {
            const request = route.request().postDataJSON();
            arrive(); await held;
            await route.fulfill({ json: { schemaVersion: 1, basis: request.expectedBasis, data: {
                observationRef: request.observationRef, basis: request.expectedBasis, text,
                completeness: "bounded-fragment", finality: "unverified",
            } } });
        })();
        deliveries.push(delivery); return delivery;
    });

    try {
        await response.locator(".reader-section-toggle").click();
        await response.locator(".reader-section-toggle").click();
        await response.getByRole("button", { name: "Read response", exact: true }).click();
        await arrived;
        assessmentView.consent = { ...contract.defaultConsent(), revision: 2 };
        assessmentView.basis.consentRevision = 2;
        assessmentView.observations = assessmentView.observations.filter(item => item.origin !== "optional-capture");
        for (const item of [assessmentView.interaction, ...assessmentView.observations, ...assessmentView.assessments, ...assessmentView.metrics]) item.basis = { ...assessmentView.basis };
        await page.evaluate(() => dispatchEvent(new Event("online")));
        await expect(page.locator("#requestContent")).toContainText("Saving is off");
        await expect(page.locator("#requestContent")).not.toContainText("Saving is off by default");
        release(); await Promise.all(deliveries);
        assert.equal(await page.locator("#requestContent").evaluate((node, text) => node.textContent.includes(text), text), false);
        await expect(page.getByRole("button", { name: "Copy response", exact: true })).toHaveCount(0);
        await oldCopy.evaluate(node => node.click());
        assert.deepEqual(await page.evaluate(() => window.readerCopies), []);
    } finally { release(); await Promise.all(deliveries); }
});

test("plural responses keep separate exact subjects beneath one shared section owner", { timeout: 20000 }, async t => {
    const texts = ["Invented first response.\n  Its own spacing.\n", "Invented second response, not a replacement final answer.  \n"];
    const { page, assessmentView } = await setup(t, [readerRecord()], { responseText: texts });
    const response = page.locator('[data-reader-section="response"]');
    await expect(response.locator("pre")).toHaveCount(2);
    await expect(response.locator(".reader-section-toggle")).toHaveCount(1);
    for (let index = 0; index < texts.length; index++) {
        await response.getByRole("button", { name: `Copy response ${index + 1}`, exact: true }).click();
        await expect(response.locator(".reader-response-list>.journey-item").nth(index).locator("time"))
            .toHaveAttribute("datetime", assessmentView.observations.filter(item => item.kind === "answer")[index].occurredAt);
    }
    assert.deepEqual(await page.evaluate(() => window.readerCopies), texts);
    await response.locator(".reader-section-toggle").click();
    await expect(response.locator("pre,.ux-copy")).toHaveCount(0);
    await response.locator(".reader-section-toggle").click();
    const replies = response.locator(".reader-response-list>.journey-item");
    for (const item of await replies.all()) await item.getByRole("button", { name: "Read response", exact: true }).click();
    await expect(response.locator("pre")).toHaveCount(2);
    await expect(response.getByText("Final-answer status unverified", { exact: true })).toHaveCount(2);
});

test("missing prompt and action facts stay explicit, while contradictory completion values remain visible", { timeout: 20000 }, async t => {
    const missing = readerRecord();
    missing.userPrompt = { status: "unavailable", text: null, sourceEventId: null, sourceTimestamp: null,
        authorship: { actor: "unknown", basis: "conflicting-source" } };
    missing.toolCalls = [];
    const conflict = readerRecord();
    conflict.scenarioId = "reader-conflict";
    conflict.sourceSessionId = "invented-separate-chat";
    conflict.toolCalls[0].reportedOutcome = "failed";
    conflict.toolCalls[0].toolSucceeded = true;
    const { page, runtime } = await setup(t, [missing, conflict]);
    // No-action groups have no matching Analyze card; the supported exact link still opens them.
    await page.goto(runtime.url + "#request?request=" + encodeURIComponent(missing.scenarioId));
    const prompt = page.locator('[data-reader-section="prompt"]');
    await expect(prompt).toContainText("Sender unclear");
    await expect(prompt).toContainText("Origin details could not be reconciled");
    await expect(prompt).toContainText("Prompt text unavailable");
    await expect(page.locator('[data-reader-section="activity"]')).toContainText("No individual action details were retained");
    await expect(prompt.locator("pre,.ux-copy")).toHaveCount(0);
    await sourceToggle(page).click();
    await expect(page.locator('[data-reader-section="source"] .reader-recorded-at')).toHaveText("Recorded time not available.");
    await captureCorrection(page, "ec92-missing-evidence", "prompt");
    await page.locator("#closeContextSidebar").click();
    await page.locator(`[data-view-key="request:${conflict.scenarioId}"] .request-card-open`).click();
    const activity = page.locator('[data-reader-section="activity"]');
    const toggle = activity.locator(".reader-call-toggle");
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await expect(activity.locator(".reader-fields>div").filter({ has: page.getByText("Reported outcome", { exact: true }) })).toHaveText("Reported outcomefailed");
    await expect(activity.locator(".reader-fields>div").filter({ has: page.getByText("Execution success", { exact: true }) })).toHaveText("Execution successtrue");
});

for (const [sidebarMotion, motion, enabled] of [
    ["on", "reduce", false], ["off", "no-preference", true],
]) test(`Source folding follows native ${motion}, ignoring retired ${sidebarMotion}, with one reversible owner`, { timeout: 20000 }, async t => {
    const { page } = await setup(t, [readerRecord()], { sidebarMotion, motion });
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    const source = page.locator('[data-reader-section="source"]'), toggle = sourceToggle(page);
    await toggle.click();
    await page.waitForFunction(() => !document.querySelector('[data-reader-section=source] .reader-section-clip').getAnimations().length);
    const state = await toggle.evaluate(async button => {
        const clip = button.closest("section").querySelector(".reader-section-clip");
        button.click();
        const animation = clip.getAnimations()[0];
        window.readerFold = animation;
        const frames = [];
        for (let i = 0; i < 3; i++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            frames.push(clip.getBoundingClientRect().height);
        }
        return { animated: Boolean(animation), frames };
    });
    assert.equal(state.animated, enabled);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    if (enabled) {
        assert.ok(new Set(state.frames).size > 1, "Folding has actual unpaused intermediate heights");
        const reversed = await toggle.evaluate(button => {
            const clip = button.closest("section").querySelector(".reader-section-clip"), height = clip.getBoundingClientRect().height;
            button.click();
            const animation = clip.getAnimations()[0];
            const result = { height, start: parseFloat(animation.effect.getKeyframes()[0].height), old: window.readerFold.playState };
            window.readerFold = animation;
            return result;
        });
        assert.ok(Math.abs(reversed.start - reversed.height) < 1);
        assert.equal(reversed.old, "idle");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect(source.locator(".reader-section-clip")).not.toHaveAttribute("inert", "");
        assert.equal(await source.locator(".reader-section-clip").evaluate(node => node.getAnimations().length), 0);
    } else await toggle.click();
    const identifiers = source.getByRole("button", { name: "Record identifiers" });
    await expect(identifiers).toBeVisible();
    await toggle.focus(); await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    await expect(identifiers).toBeHidden();
    await toggle.press("Space");
    await expect(identifiers).toBeVisible();
    await expect(toggle).toBeFocused();
});

test("reader folding, exact Copy and report peek leave every frozen format byte-identical", { timeout: 30000 }, async t => {
    const record = readerRecord();
    const { page, context, frozen } = await setup(t, [record], { saveFrozen: true });
    const fold = page.locator("#requestContent .reader-call-toggle").first();
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await fold.click();
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [record.userPrompt.text]);
    await page.locator("#closeContextSidebar").click();
    await navigateMain(page, "reports");
    await prepareLandingReport(page, "all");
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
    const peek = page.locator("#reportActivityOptions .request-card-open").first();
    await peek.click();
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", `request:${record.scenarioId}`);
    await expect(page.locator('[data-reader-section="prompt"] pre')).toHaveText(record.userPrompt.text);
    await fold.click();
    await page.goBack();
    await expect(peek).toBeFocused();
    assert.deepEqual((await loadBoardState(context)).exports, frozen.exports);
    const hashes = {};
    for (const [name, file] of Object.entries(frozen.files)) {
        const after = await readFile(file);
        assert.deepEqual(after, frozen.bytes.get(file), name);
        hashes[name] = createHash("sha256").update(after).digest("hex");
    }
    for (const extension of ["html", "pdf", "json", "md"]) assert.ok(Object.keys(hashes).some(name => name.endsWith("." + extension)));
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await writeFile(path.join(proofs, "frozen-output-hashes.json"), JSON.stringify(hashes, null, 2));
    }
});

test("retirement: historical model judgments do not create current reader panels or placeholders", { timeout: 20000 }, async t => {
    const record = readerRecord();
    const { model, state } = qualityDisplayFixture({ records: [record], judgments: [{ accuracy: "pass", "answer-trust": "fail", "action-trust": "unassessed" }] });
    assert.equal(state.personalEvaluation.modelEvaluation.records[0].assessments.length, 3);
    const historical = structuredClone(state.personalEvaluation);
    const view = [...model.details.values()][0];
    const { page } = await setup(t, [record], { assessmentFixture: view });
    const reader = page.locator("#requestContent");
    await expect(reader.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(reader.locator('[data-reader-section="reviews"],.single-interaction-measures,.assessment-finding-group,.reader-check-counts')).toHaveCount(0);
    assert.doesNotMatch(await reader.innerText(), /synthetic-quality-fixture|wire-recorded-interaction-review|AI judgments|Local checks|No saved reviews/);
    await expect(reader.locator(".reader-call-duration")).toHaveText("Call duration: 1 s");
    await expect(reader.locator(".request-original pre")).toHaveText(record.userPrompt.text);
    assert.deepEqual(state.personalEvaluation, historical);
    await captureCorrection(page, "retired-history-reading", "prompt");
});

test("correction: same-evidence persisted pageshow restores live owners only after authorization and preserves Back", { timeout: 25000 }, async t => {
    const { page, records } = await setup(t);
    await expect(page.locator('#requestContent [aria-busy="true"]')).toHaveCount(0);
    const oldToggle = await sourceToggle(page).elementHandle();
    const oldCopy = await page.getByRole("button", { name: "Copy prompt", exact: true }).elementHandle();
    let release, arrive;
    const held = new Promise(resolve => release = resolve), arrived = new Promise(resolve => arrive = resolve), deliveries = [];
    const holdSnapshot = route => {
        const delivery = (async () => {
            const response = await route.fetch();
            arrive(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    };
    await page.route("**/api/snapshot", holdSnapshot);
    // Chromium refuses native BFCache for this server's no-store JS requests.
    // Exercise its persisted lifecycle handlers without changing that cache policy.
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    assert.equal(await page.locator("#contextSidebarGuard").isVisible(), false, "A disposed reader leaves no old departure guard");
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    try {
        await arrived;
        await expect(sourceToggle(page)).toHaveCount(0);
        release(); await Promise.all(deliveries);
    } finally { release(); await Promise.all(deliveries); await page.unroute("**/api/snapshot", holdSnapshot); }
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await oldToggle.evaluate(node => node.click());
    await oldCopy.evaluate(node => node.click());
    await expect(sourceToggle(page)).toHaveAttribute("aria-expanded", "false");
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [], "Disposed controls cannot fold or copy the successor reader");
    await sourceToggle(page).click();
    await expect(sourceToggle(page)).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [records[0].userPrompt.text]);
    await page.goBack();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.locator(".request-card-open")).toBeFocused();
});

test("retirement: a pending historical personal receipt is preserved without blocking reading or replaying writes", { timeout: 20000 }, async t => {
    const receipt = JSON.stringify({ action: "set_personal_assessment", mutationRef: "mutation-" + "b".repeat(32), receiptToken: "c".repeat(64) });
    const { page, context, records } = await setup(t, [readerRecord()], {
        initialStorage: { "wire.assessment.pending": receipt },
    });
    const before = (await loadBoardState(context)).personalEvaluation;
    await sourceToggle(page).click();
    await expect(sourceToggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    await sourceToggle(page).click();
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [records[0].userPrompt.text]);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.assessment.pending")), receipt);
    assert.deepEqual((await loadBoardState(context)).personalEvaluation, before);
});

test("correction: missing and unsupported prompt completeness remain qualified exactly once", { timeout: 20000 }, async t => {
    for (const status of [undefined, "unsupported-future-status", "full", "partial", "unavailable"]) {
        const record = readerRecord();
        if (status === undefined) delete record.userPrompt.status;
        else record.userPrompt.status = status;
        const { page } = await setup(t, [record]);
        const prompt = page.locator('[data-reader-section="prompt"]');
        await expect(prompt.getByText("Text completeness not verified", { exact: true })).toHaveCount(status === undefined || status === "unsupported-future-status" ? 1 : 0);
        await expect(prompt.getByText("Partial text", { exact: true })).toHaveCount(status === "partial" ? 1 : 0);
        if (status === "unavailable") {
            await expect(prompt.locator("pre,.ux-copy")).toHaveCount(0);
            await expect(prompt).toContainText("Prompt text unavailable");
        } else {
            await prompt.getByRole("button", { name: "Copy prompt", exact: true }).click();
            assert.deepEqual(await page.evaluate(() => window.readerCopies), [record.userPrompt.text]);
        }
        if (status === undefined) await captureCorrection(page, "unverified-completeness", "prompt");
    }
});

for (const [reason, label, captureOff] of [
    ["credential-excluded", "The reply was excluded by credential screening.", false],
    ["capture-limit", "The reply exceeded the saving limit.", true],
]) for (const source of ["observation", "legacy-qualified-record"]) test(`correction: recorded response availability retains ${reason} from ${source} independently of current capture`, { timeout: 20000 }, async t => {
    const record = readerRecord(), view = retainedResponse("Never-readable invented response", record);
    if (source === "observation") {
        Object.assign(view.observations.find(item => item.kind === "answer"), { availability: "unavailable", reason, payload: null });
    } else {
        view.observations = view.observations.filter(item => item.kind !== "answer");
        view.metrics.push({
            ...samples.makeRatio(0, 0, 1), metricRef: samples.id("metric", 999), basis: { ...view.basis },
            dimension: "evidence", checkId: "answer-evidence-present", checkVersion: 1,
            eligibleUnitRefs: [view.interaction.interactionRef], reason, unassessedReasons: [{ reason, count: 1 }],
        });
    }
    if (captureOff) view.consent = { ...contract.defaultConsent(), revision: view.basis.consentRevision };
    contract.validateInteractionView(view);
    const { page } = await setup(t, [record], { assessmentFixture: view });
    await expect(page.locator("#requestContent").getByText(label, { exact: true })).toHaveCount(1);
    await expect(page.locator('[data-reader-section="response"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy response", exact: true })).toHaveCount(0);
    await captureCorrection(page, reason, "activity", `[data-reason="${reason}"]`);
});

test("requested sources stay with recorded input, without detached result caveats on failed or unsupported calls", { timeout: 20000 }, async t => {
    const record = readerRecord();
    record.toolCalls[0].tool = "workiq-retrieve";
    record.toolCalls[0].requestArgs = { query: "Invented request", capabilities: [{ name: "Email" }, { name: "TeamsMessages" }] };
    record.toolCalls.push({ ...record.toolCalls[0], toolCallId: "invented-unsupported-capability",
        startEventId: "invented-unsupported-start", durationMs: 252, completedAt: "2026-09-30T12:00:02.252Z",
        toolSucceeded: false, reportedOutcome: "failed",
        failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
            messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required" },
        requestArgs: { query: "Invented fallback", capabilities: [{ name: "Email", unsupported: true }] } });
    record.toolCalls.push({ ...record.toolCalls[0], toolCallId: "invented-partial-capability",
        startEventId: "invented-partial-start", toolSucceeded: null, reportedOutcome: "unknown",
        requestArgs: { query: "Invented partial scope", capabilities: [{ name: "Email" }, { name: "InventedUnrecognizedSource" }] } });
    const { page, context } = await setup(t, [record]);
    const before = await loadBoardState(context);
    const known = page.locator('[data-tool-call-id="invented-reader-call"]');
    const fallback = page.locator('[data-tool-call-id="invented-unsupported-capability"]');
    const partial = page.locator('[data-tool-call-id="invented-partial-capability"]');
    for (const call of [known, fallback, partial]) {
        await call.locator(".reader-call-toggle").click();
        await expect(call).not.toContainText("This does not show which sources returned results");
        await expect(call).not.toContainText("No results");
    }
    await expect(known).toContainText("Requested sources");
    await expect(known.getByText("Email", { exact: true })).toHaveCount(1);
    await expect(known.getByText("Teams messages", { exact: true })).toHaveCount(1);
    await expect(fallback).not.toContainText("Requested sources");
    await expect(fallback).toContainText('"unsupported": true');
    await expect(fallback).toContainText('"name": "Email"');
    await expect(fallback.locator(".call-heading")).toContainText("Work IQ required sign-in at the time");
    await expect(fallback.locator(".reader-call-duration")).toHaveText("Call duration: 252 ms");
    await expect(partial).toContainText('"name": "Email"');
    await expect(partial).toContainText('"name": "InventedUnrecognizedSource"');
    await expect(partial.locator(".reader-entry-label")).toHaveText("Call #3");
    await expect(partial.locator(".call-heading")).toContainText("has no recorded result");
    assert.deepEqual(await loadBoardState(context), before);
});

for (const outcome of ["read-failure", "revoked-source"]) test(`correction: persisted restoration does not revive private owners after ${outcome}`, { timeout: 20000 }, async t => {
    const { page, context } = await setup(t);
    const oldCopy = await page.getByRole("button", { name: "Copy prompt", exact: true }).elementHandle();
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    if (outcome === "read-failure") {
        await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented recovery read failure" } }));
    } else {
        const prior = await loadBoardState(context);
        await replaceEvidence(context, () => ({ records: [], importCoverage: prior.importCoverage }));
    }
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("button", { name: "Copy prompt", exact: true })).toHaveCount(0);
    await expect(sourceToggle(page)).toHaveCount(0);
    await oldCopy.evaluate(node => node.click());
    assert.deepEqual(await page.evaluate(() => window.readerCopies), []);
    if (outcome === "read-failure") {
        await expect(page.locator("#message")).toContainText("Invented recovery read failure");
        await page.unroute("**/api/snapshot");
        await page.evaluate(() => dispatchEvent(new Event("online")));
        await expect(page.getByRole("button", { name: "Copy prompt", exact: true })).toBeVisible();
    } else await expect(page.locator("#unavailableCall")).toContainText("These completed calls are unavailable");
});

test("correction: an older snapshot finishing after pagehide cannot revive the disposed reader", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    let release, arrive;
    const held = new Promise(resolve => release = resolve), arrived = new Promise(resolve => arrive = resolve), deliveries = [];
    await page.route("**/api/snapshot", route => {
        const delivery = (async () => {
            const response = await route.fetch(); arrive(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    });
    try {
        await page.evaluate(() => dispatchEvent(new Event("online")));
        await arrived;
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
        const returned = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
        release(); await Promise.all(deliveries); await (await returned).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.getByRole("button", { name: "Copy prompt", exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "Collapse all sections", exact: true }).count(), 0);
        const inactiveRead = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
        await page.evaluate(() => dispatchEvent(new Event("online")));
        await (await inactiveRead).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.unroute("**/api/snapshot");
        await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented post-suspension read failure" } }));
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
        await expect(page.locator("#message")).toContainText("Invented post-suspension read failure");
        assert.equal(await page.getByRole("button", { name: "Copy prompt", exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "Collapse all sections", exact: true }).count(), 0);
    } finally { release(); await Promise.all(deliveries); }
});

test("EC92 recorded duration does not invent a missing completion or show local-measure machinery", { timeout: 20000 }, async t => {
    const record = readerRecord();
    record.toolCalls[0].completedAt = null;
    const { page, context } = await setup(t, [record]);
    const before = await loadBoardState(context), reader = page.locator("#requestContent");
    await expect(reader.locator('.reader-call-duration data[value="1000"]')).toHaveCount(1);
    await expect(reader.locator(".reader-timing-table,.reader-local-timing,.reader-local-quality")).toHaveCount(0);
    await expect(reader.locator(".response-timing")).toHaveCount(0);
    assert.doesNotMatch(await reader.innerText(), /Median|P95|Not measured|Boundary not verified|Local checks/);
    const retained = before.evidence.find(item => item.scenarioId === record.scenarioId).toolCalls[0];
    assert.equal(retained.completedAt, null);
    assert.equal(retained.durationMs, 1000);
    await reader.locator(".reader-call-toggle").click();
    await expect(reader.getByText("Recorded end", { exact: true })).toHaveCount(0);
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
    await captureCorrection(page, "recorded-duration-missing-completion", "activity");
});

test("retirement: stale A reader controls cannot fold or copy B or steal its focus", { timeout: 20000 }, async t => {
    const a = readerRecord(), b = structuredClone(a);
    b.scenarioId = "reader-guard-b";
    b.sourceSessionId = "invented-reader-b-chat";
    b.sourceSessionName = "Invented B chat";
    b.userPrompt.sourceEventId = "invented-reader-b-prompt";
    b.userPrompt.text = "Invented B prompt; separate reading owner.\n  Preserve these bytes.";
    b.toolCalls[0].toolCallId = "invented-reader-b-call";
    const { page, context } = await setup(t, [a, b]);
    await page.locator('[data-view-key="request:reader-approved"] .request-card-open').click();
    const foldA = await sourceToggle(page).elementHandle();
    const copyA = await page.getByRole("button", { name: "Copy prompt", exact: true }).elementHandle();
    await page.locator('[data-view-key="request:reader-guard-b"] .request-card-open').click();
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:reader-guard-b");
    const promptB = page.locator('[data-reader-section="prompt"]');
    const focusB = sourceToggle(page);
    await focusB.focus();
    const stored = (await loadBoardState(context)).personalEvaluation;
    await foldA.evaluate(node => node.click());
    await copyA.evaluate(node => node.click());
    await expect(promptB.locator("pre")).toHaveText(b.userPrompt.text);
    await expect(focusB).toHaveAttribute("aria-expanded", "false");
    await expect(focusB).toBeFocused();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), []);
    await promptB.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [b.userPrompt.text]);
    await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toHaveCount(0);
    assert.deepEqual((await loadBoardState(context)).personalEvaluation, stored, "No feedback write or replay");
    await captureCorrection(page, "stale-reader-successor", "prompt");
});

test("EC92 HTTP records retain exact individual durations and raw boundaries without derived timing recitals", { timeout: 20000 }, async t => {
    const record = readerRecord();
    record.httpRecords = [20, 80, 45].map((durationMs, index) => ({
        recordId: `invented-boundary-http-${index}`, classification: "direct-graph-http", synthetic: false,
        observedGraphHttp: index < 2, responseOrigin: index < 2 ? "https://graph.microsoft.com" : null,
        method: "GET", apiVersion: "v1.0", responsePath: { path: "/me/drive/root", query: [] },
        startedAt: "2026-09-30T12:00:04.000Z", durationMs,
        durationBoundary: index < 2 ? "request dispatch to response headers" : "request dispatch to transport error",
        status: index < 2 ? 200 : null, transportError: index < 2 ? null : "TimeoutError",
    }));
    const { page } = await setup(t, [record]);
    await page.locator("#closeContextSidebar").click();
    await page.locator("#activityList .card-tool-name").click();
    const activity = page.locator('[data-reader-section="activity"]');
    const records = activity.locator(".journey-item").filter({ has: page.getByText("Explicit HTTP recorder", { exact: true }) });
    await expect(records).toHaveCount(3);
    for (const [index, http] of record.httpRecords.entries()) {
        const entry = records.nth(index);
        await entry.locator(".reader-call-toggle").click();
        await expect(entry.locator(".reader-call-duration")).toHaveText(`Recorded duration: ${http.durationMs} ms`);
        await expect(entry.locator(".reader-call-duration data")).toHaveAttribute("value", String(http.durationMs));
        await entry.getByRole("button", { name: "Copy recorder details", exact: true }).click();
        assert.equal(await page.evaluate(() => window.readerCopies.at(-1)), JSON.stringify(http, null, 2));
        await expect(entry.locator("pre")).toContainText(http.durationBoundary);
    }
    assert.doesNotMatch(await activity.innerText(), /Median|P95|local measure/);
    await expect(page.locator(".reader-local-timing")).toHaveCount(0);
    await captureCorrection(page, "http-recorded-boundaries", "activity");
});

test("EC92 concise failure presentation retains distinct retention exclusions", { timeout: 20000 }, async t => {
    const record = readerRecord(), original = record.toolCalls[0];
    record.toolCalls = ["size-excluded", "sensitive-excluded", "unsupported-format"].map((messageStatus, index) => ({
        ...original, toolCallId: "invented-retention-" + index, startEventId: "invented-retention-start-" + index,
        toolSucceeded: false, reportedOutcome: "failed",
        failureEvidence: { version: 1, reason: "no-structured-error", messageStatus, messageSignal: null },
    }));
    const { page } = await setup(t, [record]);
    const calls = page.locator('[data-reader-section="activity"] [data-tool-call-id]');
    await expect(calls).toHaveCount(record.toolCalls.length);
    for (const [index, call] of (await calls.all()).entries()) {
        await expect(call.locator(".call-heading .result-cause")).toHaveText(["Error details were too long to save", "Error details omitted for privacy", "WIRE could not extract a readable reason from the recorded error"][index]);
        await expect(call.locator(".reader-recorded-signal")).toHaveCount(0);
        await expect(call.getByRole("button", { name: /sign in|retry|authenticate/i })).toHaveCount(0);
        assert.doesNotMatch(await call.innerText(), /Recorded error signal:|HTTP 401|HTTP 403/);
    }
});

test("EC92 final assembly keeps timing with its subject and only useful reading sections", { timeout: 25000 }, async t => {
    const record = readerRecord(), exact = "Invented retained reply.\n  Preserve this ending.\n";
    record.userPrompt.sourceTimestamp = "2026-09-30T12:00:00.321Z";
    const { page, assessmentView } = await setup(t, [record], { responseText: exact });
    const reader = page.locator("#requestContent");
    const response = reader.locator('[data-reader-section="response"]');
    await expect(response.locator(".full-text-content")).toHaveText(exact);
    assert.deepEqual(await reader.locator(":scope > [data-reader-section]").evaluateAll(nodes => nodes.map(node => node.dataset.readerSection)),
        ["prompt", "activity", "usage", "response", "source"]);
    await expect(response.locator(".reader-section-toggle")).toHaveText("Copilot reply");
    await expect(reader.locator('[data-reader-section="source"] .reader-section-toggle')).toHaveText("Source details");
    await sourceToggle(page).click();
    await expect(reader.locator('[data-reader-section="source"] time')).toHaveAttribute("datetime", record.userPrompt.sourceTimestamp);
    const answer = assessmentView.observations.find(item => item.kind === "answer");
    await expect(response.locator("time")).toHaveAttribute("datetime", answer.occurredAt);
    await expect(reader.locator(".reader-timing-table,.reader-local-timing,.single-interaction-measures")).toHaveCount(0);
    await expect(reader.getByRole("button", { name: /personal feedback|automatic scores|evaluate|save feedback/i })).toHaveCount(0);
    assert.doesNotMatch(await reader.innerText(), /Local checks|Median|P95|AI review|Choose a verdict/);
    await response.getByRole("button", { name: "Copy response", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [exact]);
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "overlay");
    const targets = await response.locator(".reader-section-heading").evaluate(node => {
        const toggle = node.querySelector(".reader-section-toggle").getBoundingClientRect();
        const copy = node.querySelector(".ux-copy").getBoundingClientRect();
        return { separate: copy.left >= toggle.right, aligned: Math.abs(copy.top + copy.height / 2 - toggle.top - toggle.height / 2) <= 1,
            copyWidth: copy.width, copyHeight: copy.height };
    });
    assert.ok(targets.separate && targets.aligned && targets.copyWidth >= 44 && targets.copyHeight >= 44, JSON.stringify(targets));
    await captureCorrection(page, "ec92-final-prompt", "prompt");
    await captureCorrection(page, "ec92-final-response", "response");
});

test("following message Copy belongs only to the open linked context", { timeout: 25000 }, async t => {
    const record = readerRecord();
    record.userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    record.userPrompt.text = "Review the invented directory preference recorded for this example. ".repeat(5);
    const following = "Separate work: compare the invented handoff notes and identify unresolved owners. ".repeat(5);
    record.followUpPrompts = [{ text: following, status: "full", sourceEventId: "invented-following-work",
        sourceTimestamp: "2026-09-30T12:01:00.000Z", authorship: { actor: "agent", basis: "source-agent" } }];
    const { page } = await setup(t, [record]);
    const reader = page.locator("#requestContent");
    await sourceToggle(page).click();
    const linked = reader.locator('[data-reader-section="source"] .reader-linked-context');
    await expect(linked).not.toHaveAttribute("open", "");
    await expect(linked.locator(".full-text-content,.ux-copy")).toHaveCount(0);
    await linked.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    await expect(linked.locator(".full-text-content")).toHaveText(following);
    await expect(linked.locator(".reader-context-heading")).toHaveText("Following message · Agent prompt");
    assert.equal(await linked.locator("[data-prompt-actor=agent]").evaluate(node => getComputedStyle(node).color),
        await reader.locator('[data-reader-section="prompt"] [data-prompt-actor=agent]').first().evaluate(node => getComputedStyle(node).color),
        "Subordinate context retains the shared author meaning without a primary prompt treatment");
    if (process.env.WIRE_READER_STORY_PROOFS) {
        await linked.evaluate(node => {
            const scroll = document.getElementById("contextSidebarBody");
            scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 64;
        });
        await page.screenshot({ path: path.join(process.env.WIRE_READER_STORY_PROOFS, "story-linked-open-dark-375-2.png") });
    }
    const followingCopy = linked.getByRole("button", { name: "Copy following message", exact: true });
    await followingCopy.click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [following]);
    const staleCopy = await followingCopy.elementHandle();
    await linked.locator(":scope > summary").click();
    await expect(linked.locator(".full-text-content,.ux-copy")).toHaveCount(0);
    await staleCopy.evaluate(node => node.click());
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [following]);
    await linked.locator(":scope > summary").click();
    await expect(linked.locator(".full-text-content")).toHaveText(following);
    await reader.locator('[data-reader-section="source"] .reader-section-toggle').click();
    await expect(linked.locator(".full-text-content,.ux-copy")).toHaveCount(0);
    await reader.locator('[data-reader-section="source"] .reader-section-toggle').click();
    await expect(linked.locator(".full-text-content")).toHaveText(following);
});

test("target-only caption consolidation preserves numbered paths and distinct request parameters", { timeout: 20000 }, async t => {
    const record = readerRecord(), first = record.toolCalls[0];
    first.requestArgs = { entityUrls: ["/me?$select=preferredLanguage"], timeZone: "UTC" };
    const paths = ["/me/messages/invented-item", "/me/drive/items/invented-file"];
    record.toolCalls.push(
        { ...first, toolCallId: "invented-numbered-paths", startEventId: "invented-numbered-start", requestArgs: { entityUrls: paths } },
        { ...first, toolCallId: "invented-prose-and-path", startEventId: "invented-prose-start",
            requestArgs: { query: "  Keep this invented request separate.\n", entityUrls: [paths[1]], timeZone: "UTC", capabilities: [{ name: "OneDriveAndSharePoint" }] } });
    const { page } = await setup(t, [record]);
    const calls = page.locator(".request-context-timeline [data-tool-call-id]");
    for (const row of await calls.all()) await row.locator(".reader-call-toggle").click();
    await expect(calls.nth(0).locator(".reader-input-label")).toHaveText("Requested path");
    await expect(calls.nth(0).locator(".reader-request-paths dt")).toHaveCount(0);
    await expect(calls.nth(0).locator(".reader-input>.reader-fields")).toHaveText("Time zoneUTC");
    await expect(calls.nth(1).locator(".reader-input-label")).toHaveText("Requested paths");
    await expect(calls.nth(1).locator("ol.reader-request-paths>li code")).toHaveText(paths);
    assert.equal(await calls.nth(1).locator("ol.reader-request-paths").evaluate(node => getComputedStyle(node).listStyleType), "decimal");
    assert.equal(await calls.nth(1).locator("ol.reader-request-paths>li").first().evaluate(node => getComputedStyle(node).display), "list-item");
    await expect(calls.nth(1).getByRole("button", { name: "Copy recorded arguments", exact: true })).toHaveCount(0);
    const prose = calls.nth(2);
    await expect(prose.locator(".reader-input-label")).toHaveText("Recorded request");
    await expect(prose.locator(".reader-request-text")).toHaveText(record.toolCalls[2].requestArgs.query);
    await expect(prose.locator("dl.reader-request-paths dt")).toHaveText("Requested path");
    await expect(prose.locator("dl.reader-request-paths code")).toHaveText(paths[1]);
    await expect(prose.locator(".reader-input>.reader-fields dt")).toHaveText(["Requested sources", "Time zone"]);
    await prose.getByRole("button", { name: "Copy recorded arguments", exact: true }).click();
    assert.equal(await page.evaluate(() => window.readerCopies.at(-1)), JSON.stringify(record.toolCalls[2].requestArgs, null, 2));
    await page.setViewportSize({ width: 375, height: 950 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const target = calls.first().locator(".reader-input-value code");
    await expect(target).toHaveText(first.requestArgs.entityUrls[0]);
    assert.ok(await target.evaluate(node => {
        const body = document.querySelector("#contextSidebarBody"), token = "preferredLanguage";
        const text = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.data.includes(token));
        if (!text) return false;
        const start = text.textContent.indexOf(token), range = document.createRange();
        range.setStart(text, start); range.setEnd(text, start + token.length);
        return body.scrollWidth <= body.clientWidth + 1 && range.getClientRects().length === 1;
    }), "A query parameter that fits is not broken or clipped at enlarged text.");
    await captureCorrection(page, "caption-known-input", "activity");
});
