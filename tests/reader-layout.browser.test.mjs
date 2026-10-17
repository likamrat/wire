import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";
import { contract, retainedResponse, samples } from "./assessment-ui-fixtures.mjs";
import { graphMatrixRecord } from "./report-evidence-matrix-fixtures.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { recordedInteractionModels } from "../lib/interaction-model.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { searchFixture } from "./live-search-fixture.mjs";

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

async function setup(t, records = [readerRecord()], { responseText, assessmentFixture, responseCompleteness = "bounded-fragment", motion = "reduce", sidebarMotion, saveFrozen = false, initialStorage = {} } = {}) {
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: motion });
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
    await page.locator("#resultsLink").click();
    await page.locator(".request-card-open").first().click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    return { page, records, context, runtime, assessmentView, frozen };
}

test("approved reader opens the prompt first with useful sections and one visibility owner", { timeout: 20000 }, async t => {
    const { page, records } = await setup(t);
    const reader = page.locator("#requestContent");
    await expect(reader.locator("[data-reader-section]").first()).toHaveAttribute("data-reader-section", "prompt");
    await expect(reader.locator('[data-reader-section="prompt"] pre')).toHaveText(records[0].userPrompt.text);
    await expect(reader.locator('[data-reader-section="timing"],[data-reader-section="reviews"]')).toHaveCount(0);
    await expect(reader.locator('[data-reader-section="prompt"] time')).toHaveAttribute("datetime", records[0].userPrompt.sourceTimestamp);
    await expect(reader.locator('[data-reader-section="activity"]')).toContainText("workiq-fetch");
    await expect(reader.locator('[data-reader-section="source"]')).toContainText("invented-reader-call");
    await expect(reader.getByRole("button", { name: "Hide prompt", exact: true })).toHaveCount(0);
    await expect(reader.locator(".journey-item > details")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Collapse all sections", exact: true })).toBeVisible();
    const sourceId = reader.locator('[data-reader-section="source"] code').first();
    await sourceId.click({ clickCount: 3 });
    assert.equal(await page.evaluate(() => getSelection().toString().trimEnd()), records[0].userPrompt.sourceEventId);
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await expect(reader.locator(".full-text-body")).toHaveCount(0);
    await expect(reader.locator(".reader-section-toggle[aria-expanded=true]")).toHaveCount(0);
    await page.getByRole("button", { name: "Expand all sections", exact: true }).click();
    await expect(reader.locator('[data-reader-section="prompt"] pre')).toHaveText(records[0].userPrompt.text);
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
    await expect(response.locator("pre")).toHaveText(exact);
    await response.getByRole("button", { name: "Copy response", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [exact, exact]);
});

test("retirement: bulk folding has no personal editor and leaves report actions outside reading", { timeout: 20000 }, async t => {
    const { page, context } = await setup(t);
    const before = (await loadBoardState(context)).personalEvaluation, url = page.url();
    await expect(page.locator('[data-reader-section="reviews"],[data-personal-feedback],[data-feedback-dimension]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /personal feedback|save feedback|give personal feedback/i })).toHaveCount(0);
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await expect(page.locator(".reader-section-toggle[aria-expanded=true]")).toHaveCount(0);
    await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    await page.locator("#requestReportToggle").click();
    await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
    await page.locator("#requestReportToggle").click();
    await page.getByRole("button", { name: "Expand all sections", exact: true }).click();
    await expect(page.locator(".reader-section-toggle[aria-expanded=true]")).toHaveCount(3);
    assert.equal(page.url(), url);
    assert.deepEqual((await loadBoardState(context)).personalEvaluation, before);
});

test("plural inputs and mixed evidence retain exact scopes and readable geometry in both themes", { timeout: 60000 }, async t => {
    const record = readerRecord(), original = record.toolCalls[0];
    record.project = null; record.projectId = null;
    record.userPrompt.text += "\n" + "Keep the invented release decisions and their source notes together. ".repeat(5);
    record.userPrompt.status = "partial";
    record.userPrompt.sourceEventId = "invented-event-" + "a".repeat(64);
    record.userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    const script = "  // Invented code; never execute it.\nreturn { retained: true, count: 0 };\n";
    record.toolCalls.push({
        ...original, tool: "workiq-retrieve", toolCallId: "invented-reader-retrieve", startEventId: "invented-retrieve-start",
        requestArgs: { query: "  Find the invented handoff notes.\n", capabilities: [{ name: "Email" }, { name: "TeamsMessages" }, { name: "OneDriveAndSharePoint" }] },
        startedAt: "2026-09-30T12:00:02.500Z", completedAt: "2026-09-30T12:00:04.000Z", durationMs: 1500,
        toolSucceeded: false, reportedOutcome: "failed",
    }, {
        ...original, tool: "workiq-ask", toolCallId: "invented-reader-ask", startEventId: "invented-ask-start",
        requestArgs: { question: "Summarize the invented unresolved decisions." },
        startedAt: "2026-09-30T12:00:05.000Z", completedAt: null, durationMs: null, toolSucceeded: null, reportedOutcome: "unknown",
    }, {
        ...original, tool: "workiq-call_function", toolCallId: "invented-reader-script", startEventId: "invented-script-start",
        requestArgs: { functionUrl: "/me/calendar/getSchedule", code: script, custom: { preserve: [false, 0, "unknown-key"] } },
        startedAt: "2026-09-30T12:00:05.100Z", completedAt: "2026-09-30T12:00:05.100Z", durationMs: 0,
    });
    const graphs = graphMatrixRecord("reader-graph").graphActivities;
    assert.ok(graphs.some(item => item.evidenceLevel === "output-visible-http"));
    record.graphActivities = [
        { ...graphs[0], activityId: "invented-reader-reference", sourceSessionId: record.sourceSessionId,
            scenarioId: record.scenarioId, evidenceLevel: "code-reference", httpStatus: null, statusBasis: "none" },
        { ...graphs.find(item => item.evidenceLevel === "output-visible-http"), activityId: "invented-reader-graph",
            sourceSessionId: record.sourceSessionId, scenarioId: record.scenarioId },
    ];
    record.httpRecords = [{
        recordId: "invented-reader-http", classification: "direct-graph-http", synthetic: false,
        observedGraphHttp: true, responseOrigin: "https://graph.microsoft.com", method: "GET", apiVersion: "v1.0",
        responsePath: { path: "/me/drive/root", query: [] }, startedAt: "2026-09-30T12:00:07.000Z",
        completedAt: "2026-09-30T12:00:07.020Z", durationMs: 20, status: 503, transportError: null,
    }];
    const events = [
        { id: record.userPrompt.sourceEventId, type: "user.message", timestamp: record.userPrompt.sourceTimestamp, data: { messageId: "invented-logical-message" } },
        { id: "invented-final", type: "assistant.message", timestamp: "2026-09-30T12:00:10.000Z",
            data: { originatingMessageId: "invented-logical-message", apiCallId: "invented-api", model: "invented-model",
                content: "Invented final answer metadata.", turnId: "invented-turn", phase: "final_answer", toolRequests: [] } },
        { id: "invented-turn-end", type: "assistant.turn_end", timestamp: "2026-09-30T12:00:10.010Z", data: { turnId: "invented-turn" } },
    ];
    record.responseTiming = recordedResponseTiming(events, record.userPrompt);
    record.originalModelEvidence = recordedInteractionModels(events, record);
    const { page } = await setup(t, [record]);
    const reader = page.locator("#requestContent"), activity = reader.locator('[data-reader-section="activity"]');
    await expect(reader.locator('[data-reader-section="prompt"]')).toContainText("Agent prompt");
    await expect(reader.locator('[data-reader-section="prompt"]')).toContainText("Partial text");
    await expect(reader.locator('[data-reader-section="source"]')).toContainText("No project associated");
    await expect(reader.locator(".response-timing data")).toHaveAttribute("value", "10000");
    await expect(reader.locator('.reader-call-duration data[value="0"]')).toHaveCount(1);
    await expect(reader.locator('[data-reader-section="prompt"] .response-timing')).toContainText("Prompt to final response");
    await expect(activity).toContainText("Graph code reference");
    await expect(activity).toContainText("Execution not observed");
    await expect(activity).toContainText("Explicit HTTP recorder");
    await expect(activity).toContainText("503");
    const fetch = activity.locator('[data-tool-call-id="invented-reader-call"]');
    await expect(fetch.locator(".reader-values .service-cue")).toHaveCount(2);
    const retrieve = activity.locator('[data-tool-call-id="invented-reader-retrieve"]');
    await expect(retrieve.locator(".reader-input>.reader-fields .reader-values>li")).toHaveCount(3);
    await expect(retrieve).toContainText("Requested sources");
    const scripted = activity.locator('[data-tool-call-id="invented-reader-script"]');
    await scripted.getByRole("button", { name: "Copy recorded arguments", exact: true }).click();
    assert.equal(await page.evaluate(() => window.readerCopies.at(-1)), JSON.stringify(record.toolCalls[3].requestArgs, null, 2));
    await scripted.getByRole("button", { name: "Copy code", exact: true }).click();
    assert.equal(await page.evaluate(() => window.readerCopies.at(-1)), script);
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "docked");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", scale === 1 ? "docked" : "overlay");
        const measured = await fetch.locator(".reader-input").evaluate(input => {
            const label = input.querySelector(".reader-input-label"), heading = input.querySelector(".reader-input-heading"), value = input.querySelector(".reader-input-value code");
            const l = heading.getBoundingClientRect(), v = value.getBoundingClientRect();
            const root = document.getElementById("contextSidebarBody");
            return { gap: v.top - l.bottom, targetCopies: input.querySelectorAll(".ux-copy").length,
                unusedWidth: input.getBoundingClientRect().width - input.querySelector(".reader-input-value").getBoundingClientRect().width,
                overflow: root.scrollWidth - root.clientWidth,
                labels: getComputedStyle(label).fontSize, values: getComputedStyle(value).fontSize };
        });
        assert.ok(measured.gap >= 0 && measured.gap <= 6, `${theme}/${width}/${scale}: path caption/value gap ${measured.gap}`);
        assert.equal(measured.targetCopies, 0);
        assert.ok(measured.unusedWidth <= 1, "Target text does not retain an empty Copy column");
        const requestCopy = await retrieve.getByRole("button", { name: "Copy recorded arguments", exact: true }).boundingBox();
        assert.ok(requestCopy.width >= 44 && requestCopy.height >= 44);
        assert.ok(measured.overflow <= 1);
        assert.equal(measured.labels, measured.values);
        const fieldAlignment = await reader.locator(".reader-fields>div").evaluateAll(nodes => nodes.map(node => {
            const label = node.querySelector("dt").getBoundingClientRect(), value = node.querySelector("dd").getBoundingClientRect();
            return { left: value.left - label.left, gap: value.top - label.bottom,
                inlineContext: Boolean(node.closest(".reader-facts,.reader-response-timing")),
                inlineGap: value.left - label.right, top: value.top - label.top };
        }));
        assert.ok(fieldAlignment.every(value => Math.abs(value.left) <= 1 && value.gap >= 0 && value.gap <= 4
            || value.inlineContext && Math.abs(value.top) <= 1 && value.inlineGap >= 6 && value.inlineGap <= 10), JSON.stringify(fieldAlignment));
        const source = reader.locator('[data-reader-section="source"]');
        assert.equal(await source.locator(".reader-identifier").first().evaluate(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            getSelection().removeAllRanges(); getSelection().addRange(range);
            const exact = getSelection().toString() === node.textContent;
            getSelection().removeAllRanges(); return exact;
        }), true);
        await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop = 0);
        measurements.push({ theme, width, scale, ...measured });
        if (proofs) {
            await mkdir(proofs, { recursive: true });
            await page.screenshot({ path: path.join(proofs, `reader-${theme}-${width}-${scale}.png`), fullPage: false });
            for (const section of ["activity", "source"]) {
                await reader.locator(`[data-reader-section="${section}"]>.reader-section-heading`).evaluate(node => {
                    const body = document.getElementById("contextSidebarBody");
                    body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
                });
                await page.screenshot({ path: path.join(proofs, `reader-${section}-${theme}-${width}-${scale}.png`) });
            }
        }
    }
    if (proofs) await writeFile(path.join(proofs, "reader-geometry.json"), JSON.stringify(measurements, null, 2));
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
        await toggle.click(); await toggle.click(); await arrived;
        await toggle.click();
        release(); await Promise.all(deliveries);
        await expect(response.locator("pre,.ux-copy")).toHaveCount(0);
        await oldCopy.evaluate(node => node.click());
        assert.deepEqual(await page.evaluate(() => window.readerCopies), []);
        assert.equal(reads, 1);
    } finally { release(); await Promise.all(deliveries); await page.unroute("**/api/assessment/evidence", delayed); }
    await toggle.click();
    await expect(response.locator("pre")).toHaveText(text);
    let failures = 0;
    const failed = route => { failures++; return route.fulfill({ status: 503, json: { error: "Invented retained evidence unavailable" } }); };
    await page.route("**/api/assessment/evidence", failed);
    await toggle.click(); await toggle.click();
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
        await arrived;
        assessmentView.consent = { ...contract.defaultConsent(), revision: 2 };
        assessmentView.basis.consentRevision = 2;
        assessmentView.observations = assessmentView.observations.filter(item => item.origin !== "optional-capture");
        for (const item of [assessmentView.interaction, ...assessmentView.observations, ...assessmentView.assessments, ...assessmentView.metrics]) item.basis = { ...assessmentView.basis };
        await page.evaluate(() => dispatchEvent(new Event("online")));
        await expect(page.locator("#requestContent")).toContainText("Capture is off");
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
    await expect(prompt).toContainText("Author unverified");
    await expect(prompt).toContainText("Recorded sender details disagree");
    await expect(prompt).toContainText("Prompt not available");
    await expect(page.locator('[data-reader-section="activity"]')).toContainText("No individual action details were retained");
    await expect(prompt.locator("pre,.ux-copy")).toHaveCount(0);
    await expect(page.locator('[data-reader-section="source"] .reader-fields>div').filter({ has: page.getByText("Source event", { exact: true }) })).toContainText("Not recorded");
    await expect(prompt.locator(".reader-recorded-at")).toHaveText("Recorded time not available.");
    await captureCorrection(page, "ec92-missing-evidence", "prompt");
    await page.locator("#closeContextSidebar").click();
    await page.locator(`a.request-card-open[href*="${conflict.scenarioId}"]`).click();
    const activity = page.locator('[data-reader-section="activity"]');
    await expect(activity.locator(".reader-fields>div").filter({ has: page.getByText("Reported outcome", { exact: true }) })).toHaveText("Reported outcomefailed");
    await expect(activity.locator(".reader-fields>div").filter({ has: page.getByText("Execution success", { exact: true }) })).toHaveText("Execution successtrue");
});

for (const [sidebarMotion, motion, enabled] of [
    ["on", "reduce", true], ["off", "no-preference", false], ["system", "reduce", false], ["system", "no-preference", true],
]) test(`section folding uses effective ${sidebarMotion}/${motion} motion and one reversible owner`, { timeout: 20000 }, async t => {
    const { page } = await setup(t, [readerRecord()], { sidebarMotion, motion });
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    const prompt = page.locator('[data-reader-section="prompt"]'), toggle = prompt.locator(".reader-section-toggle");
    const state = await toggle.evaluate(button => {
        const clip = button.closest("section").querySelector(".reader-section-clip");
        button.click();
        const animation = clip.getAnimations()[0];
        if (animation) { animation.pause(); animation.currentTime = 90; }
        window.readerFold = animation;
        return { animated: Boolean(animation), frames: animation?.effect.getKeyframes() };
    });
    assert.equal(state.animated, enabled);
    await expect(prompt.locator("pre,.ux-copy")).toHaveCount(0);
    if (enabled) {
        assert.ok(parseFloat(state.frames[0].height) > 0);
        assert.equal(state.frames[1].height, "0px");
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        const reversed = await toggle.evaluate(button => {
            const clip = button.closest("section").querySelector(".reader-section-clip"), height = clip.getBoundingClientRect().height;
            button.click();
            const animation = clip.getAnimations()[0];
            animation.pause();
            const result = { height, start: parseFloat(animation.effect.getKeyframes()[0].height), old: window.readerFold.playState };
            window.readerFold = animation;
            return result;
        });
        assert.ok(Math.abs(reversed.start - reversed.height) < 1);
        assert.equal(reversed.old, "idle");
        await page.evaluate(() => {
            localStorage.setItem("workiq-evidence.sidebar-motion", "off");
            dispatchEvent(new StorageEvent("storage", { key: "workiq-evidence.sidebar-motion", newValue: "off", storageArea: localStorage }));
        });
        await expect(prompt.locator(".reader-section-clip")).not.toHaveAttribute("inert", "");
        assert.equal(await prompt.locator(".reader-section-clip").evaluate(node => node.getAnimations().length), 0);
    } else await toggle.click();
    await expect(prompt.locator("pre")).toHaveCount(1);
    await toggle.focus(); await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    await expect(page.getByRole("button", { name: "Collapse all sections", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Expand all sections", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Expand all sections", exact: true }).click();
    await expect(page.getByRole("button", { name: "Collapse all sections", exact: true })).toBeFocused();
    await expect(prompt.locator("pre")).toHaveCount(1);
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await expect(page.getByRole("button", { name: "Expand all sections", exact: true })).toBeFocused();
    await expect(page.locator(".reader-section-toggle[aria-expanded=true]")).toHaveCount(0);
});

test("reader folding, exact Copy and report peek leave every frozen format byte-identical", { timeout: 30000 }, async t => {
    const { page, context, frozen } = await setup(t, [readerRecord()], { saveFrozen: true });
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await page.getByRole("button", { name: "Expand all sections", exact: true }).click();
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    await page.locator("#requestReportToggle").click();
    await page.locator("#requestReportContinue").click();
    await page.locator("#reportList .request-link").click();
    await expect(page.locator('[data-reader-section="prompt"]')).toBeVisible();
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await page.getByRole("button", { name: "Expand all sections", exact: true }).click();
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
    await expect(reader.locator(".reader-call-duration")).toHaveText("Tool latency: 1 s");
    await expect(reader.locator(".request-original pre")).toHaveText(record.userPrompt.text);
    assert.deepEqual(state.personalEvaluation, historical);
    await captureCorrection(page, "retired-history-reading", "prompt");
});

test("correction: same-evidence persisted pageshow restores live owners only after authorization and preserves Back", { timeout: 25000 }, async t => {
    const { page, records } = await setup(t);
    await expect(page.locator('#requestContent [aria-busy="true"]')).toHaveCount(0);
    const oldCollapse = await page.getByRole("button", { name: "Collapse all sections", exact: true }).elementHandle();
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
        assert.equal(await page.getByRole("button", { name: "Collapse all sections", exact: true }).count(), 0);
        release(); await Promise.all(deliveries);
    } finally { release(); await Promise.all(deliveries); await page.unroute("**/api/snapshot", holdSnapshot); }
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await oldCollapse.evaluate(node => node.click());
    await oldCopy.evaluate(node => node.click());
    await expect(page.locator(".reader-section-toggle[aria-expanded=false]")).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [], "Disposed controls cannot fold or copy the successor reader");
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await expect(page.locator('[data-reader-section="prompt"] pre')).toHaveCount(0);
    await page.getByRole("button", { name: "Expand all sections", exact: true }).click();
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [records[0].userPrompt.text]);
    await page.goBack();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.locator(".request-card-open")).toBeFocused();
});

test("retirement: bulk folding during an authorized response read never acquires retired owners", { timeout: 25000 }, async t => {
    const exact = "Invented bulk-fold response.\n";
    const { page } = await setup(t, [readerRecord()], { responseText: exact });
    const response = page.locator('[data-reader-section="response"]');
    await expect(response.locator("pre")).toHaveText(exact);
    await response.locator(".reader-section-toggle").click();
    let release, arrive;
    const held = new Promise(resolve => release = resolve), arrived = new Promise(resolve => arrive = resolve), deliveries = [];
    const holdEvidence = route => {
        const delivery = (async () => {
            const response = await route.fetch(); arrive(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    };
    await page.route("**/api/assessment/evidence", holdEvidence);
    try {
        await response.locator(".reader-section-toggle").click();
        await arrived;
        await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
        await expect(page.locator(".reader-section-toggle[aria-expanded=true]")).toHaveCount(0);
        release(); await Promise.all(deliveries);
        await expect(response.locator("pre,.ux-copy")).toHaveCount(0);
        await expect(page.locator("#contextSidebarGuard")).toBeHidden();
        await expect(page.locator("#requestContent [data-automatic-scores],.automatic-score-dialog,[data-personal-feedback]")).toHaveCount(0);
    } finally { release(); await Promise.all(deliveries); await page.unroute("**/api/assessment/evidence", holdEvidence); }
    await page.getByRole("button", { name: "Expand all sections", exact: true }).click();
    await expect(response.locator("pre")).toHaveText(exact);
    await response.getByRole("button", { name: "Copy response", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [exact]);
});

test("retirement: a pending historical personal receipt is preserved without blocking reading or replaying writes", { timeout: 20000 }, async t => {
    const receipt = JSON.stringify({ action: "set_personal_assessment", mutationRef: "mutation-" + "b".repeat(32), receiptToken: "c".repeat(64) });
    const { page, context, records } = await setup(t, [readerRecord()], {
        initialStorage: { "wire.assessment.pending": receipt },
    });
    const before = (await loadBoardState(context)).personalEvaluation;
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await expect(page.locator(".reader-section-toggle[aria-expanded=true]")).toHaveCount(0);
    await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    await page.getByRole("button", { name: "Expand all sections", exact: true }).click();
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
            await expect(prompt).toContainText("Prompt not available");
        } else {
            await prompt.getByRole("button", { name: "Copy prompt", exact: true }).click();
            assert.deepEqual(await page.evaluate(() => window.readerCopies), [record.userPrompt.text]);
        }
        if (status === undefined) await captureCorrection(page, "unverified-completeness", "prompt");
    }
});

for (const [reason, label, captureOff] of [
    ["credential-excluded", "Recorded response was excluded by credential screening.", false],
    ["capture-limit", "Recorded response exceeded the capture limit.", true],
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

test("correction: Requested sources replaces only the redundant recognized-capability recital", { timeout: 20000 }, async t => {
    const record = readerRecord();
    record.toolCalls[0].tool = "workiq-retrieve";
    record.toolCalls[0].requestArgs = { query: "Invented request", capabilities: [{ name: "Email" }, { name: "TeamsMessages" }] };
    record.toolCalls.push({ ...record.toolCalls[0], toolCallId: "invented-unsupported-capability",
        requestArgs: { query: "Invented fallback", capabilities: [{ name: "Email", unsupported: true }] } });
    const { page } = await setup(t, [record]);
    const known = page.locator('[data-tool-call-id="invented-reader-call"]');
    await expect(known).toContainText("Requested sources");
    assert.ok(!(await known.innerText()).includes("This does not show which sources returned results"));
    const fallback = page.locator('[data-tool-call-id="invented-unsupported-capability"]');
    await expect(fallback).toContainText('"unsupported": true');
    await expect(fallback).toContainText("This does not show which sources returned results");
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
    await expect(page.getByRole("button", { name: "Collapse all sections", exact: true })).toHaveCount(0);
    await oldCopy.evaluate(node => node.click());
    assert.deepEqual(await page.evaluate(() => window.readerCopies), []);
    if (outcome === "read-failure") {
        await expect(page.locator("#message")).toContainText("Invented recovery read failure");
        await page.unroute("**/api/snapshot");
        await page.evaluate(() => dispatchEvent(new Event("online")));
        await expect(page.getByRole("button", { name: "Copy prompt", exact: true })).toBeVisible();
    } else await expect(page.locator("#requestContent")).toContainText("This interaction is not available");
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
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await page.getByRole("button", { name: "Expand all sections", exact: true }).click();
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
    await page.locator('.request-card-open[href*="request=reader-approved"]').click();
    const foldA = await page.getByRole("button", { name: "Collapse all sections", exact: true }).elementHandle();
    const copyA = await page.getByRole("button", { name: "Copy prompt", exact: true }).elementHandle();
    await page.locator('.request-card-open[href*="request=reader-guard-b"]').click();
    await expect(page).toHaveURL(/request=reader-guard-b/);
    const promptB = page.locator('[data-reader-section="prompt"]');
    const focusB = promptB.locator(".reader-section-toggle");
    await focusB.focus();
    const stored = (await loadBoardState(context)).personalEvaluation;
    await foldA.evaluate(node => node.click());
    await copyA.evaluate(node => node.click());
    await expect(promptB.locator("pre")).toHaveText(b.userPrompt.text);
    await expect(page.locator(".reader-section-toggle[aria-expanded=false]")).toHaveCount(0);
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
    const activity = page.locator('[data-reader-section="activity"]');
    const records = activity.locator(".journey-item").filter({ has: page.getByText("Explicit HTTP recorder", { exact: true }) });
    await expect(records).toHaveCount(3);
    for (const [index, http] of record.httpRecords.entries()) {
        const entry = records.nth(index);
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

test("EC92 released presentation keeps compact identities, explicit durations and scoped Copy", { timeout: 30000 }, async t => {
    const record = readerRecord(), first = record.toolCalls[0];
    record.userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    record.userPrompt.sourceTimestamp = "2026-09-30T12:00:00.321Z";
    first.requestArgs.timeZone = "UTC";
    first.durationMs = 7; first.startedAt = "2026-09-30T12:00:02.001Z"; first.completedAt = "2026-09-30T12:00:02.008Z";
    record.toolCalls.push(
        { ...first, toolCallId: "invented-ec92-zero", startEventId: "invented-zero-start", durationMs: 0,
            startedAt: "2026-09-30T12:00:03.500Z", completedAt: "2026-09-30T12:00:03.500Z" },
        { ...first, toolCallId: "invented-ec92-request", startEventId: "invented-query-start", tool: "workiq-retrieve",
            requestArgs: { query: "  Find the invented release notes.\n", capabilities: [{ name: "Email" }] }, durationMs: null,
            startedAt: "2026-09-30T12:00:04.123Z", completedAt: null },
        { ...first, toolCallId: "invented-ec92-unknown", startEventId: "invented-extra-start",
            requestArgs: { entityUrls: ["/me/messages/invented"], unsupported: false }, durationMs: null,
            startedAt: "2026-09-30T12:00:05.456Z", completedAt: null });
    const { page } = await setup(t, [record]);
    const reader = page.locator("#requestContent"), prompt = reader.locator('[data-reader-section="prompt"]');
    const timestamp = reader.locator(`time[datetime="${record.userPrompt.sourceTimestamp}"]`);
    await expect(timestamp).toHaveCount(1);
    assert.doesNotMatch(await timestamp.innerText(), /\d{1,2}:\d{2}:\d{2}[.,]\d/);
    await expect(timestamp).toHaveAttribute("title", record.userPrompt.sourceTimestamp);
    await expect(prompt.locator(".reader-section-toggle")).toHaveText("Agent prompt");
    await expect(prompt.getByRole("heading")).toHaveCount(1);
    const fetch = reader.locator('[data-tool-call-id="invented-reader-call"]');
    await expect(fetch.locator(".reader-call-identity")).toHaveText(/Call 1\s*·\s*Tool: workiq-fetch/);
    await expect(fetch.locator("dt").filter({ hasText: /^Result$/ })).toHaveCount(0);
    await expect(fetch.locator(".reader-call-duration")).toHaveText("Tool latency: 7 ms");
    await expect(fetch.locator(".reader-call-duration data")).toHaveAttribute("value", "7");
    await expect(reader.locator('[data-tool-call-id="invented-ec92-zero"] .reader-call-duration')).toHaveText("Tool latency: 0 ms");
    await expect(fetch.getByRole("button", { name: "Copy recorded arguments", exact: true })).toHaveCount(0);
    await expect(fetch.locator(".reader-input-heading .service-cue")).toHaveCount(2);
    await expect(fetch.locator(".reader-input-value code")).toHaveText(first.requestArgs.entityUrls);
    await expect(fetch.locator(".reader-input>.reader-fields dd")).toHaveText("UTC");
    const query = reader.locator('[data-tool-call-id="invented-ec92-request"]');
    await expect(query.locator(".reader-call-duration")).toHaveText("Tool latency: Not recorded");
    await query.getByRole("button", { name: "Copy recorded arguments", exact: true }).click();
    assert.equal(await page.evaluate(() => window.readerCopies.at(-1)), JSON.stringify(record.toolCalls[2].requestArgs, null, 2));
    const unknown = reader.locator('[data-tool-call-id="invented-ec92-unknown"]');
    await unknown.getByRole("button", { name: "Copy recorded arguments", exact: true }).click();
    assert.equal(await page.evaluate(() => window.readerCopies.at(-1)), JSON.stringify(record.toolCalls[3].requestArgs, null, 2));
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "docked");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", scale === 1 ? "docked" : "overlay");
        await prompt.locator(".reader-section-toggle").hover();
        await prompt.locator(".reader-section-toggle").focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(prompt.locator(".reader-section-toggle")).toBeFocused();
        const geometry = await page.evaluate(() => {
            const toggle = document.querySelector('[data-reader-section="prompt"] .reader-section-toggle');
            const label = toggle.querySelector("[data-prompt-actor]");
            const card = document.querySelector('.request-card-open [data-prompt-actor="agent"]');
            const input = document.querySelector('[data-tool-call-id="invented-reader-call"] .reader-input');
            const outcome = document.querySelector('[data-tool-call-id="invented-reader-call"] .reader-call-summary .recorded-result');
            const box = input.getBoundingClientRect(), value = input.querySelector(".reader-input-value").getBoundingClientRect();
            return { radius: parseFloat(getComputedStyle(toggle).borderRadius), before: getComputedStyle(toggle, "::before").content,
                fill: getComputedStyle(toggle).backgroundColor, focusWidth: parseFloat(getComputedStyle(toggle).outlineWidth),
                outcomeShadow: getComputedStyle(outcome).boxShadow,
                sameAuthorColor: getComputedStyle(label).color === getComputedStyle(card).color,
                unusedTargetWidth: box.width - value.width,
                overflow: document.getElementById("contextSidebarBody").scrollWidth - document.getElementById("contextSidebarBody").clientWidth,
                copyTargets: [...document.querySelectorAll("#requestContent .ux-copy")].filter(node => node.checkVisibility())
                    .map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })) };
        });
        assert.ok(geometry.radius <= 2 && geometry.before === "none", JSON.stringify(geometry));
        assert.equal(geometry.fill, "rgba(0, 0, 0, 0)");
        assert.ok(geometry.focusWidth >= 2);
        assert.equal(geometry.outcomeShadow, "none");
        assert.equal(geometry.sameAuthorColor, true);
        assert.ok(geometry.unusedTargetWidth <= 1 && geometry.overflow <= 1, JSON.stringify(geometry));
        assert.ok(geometry.copyTargets.every(target => target.width >= 44 && target.height >= 44));
        if (proofs) {
            await mkdir(proofs, { recursive: true });
            await prompt.locator(".full-text-body").click();
            await page.mouse.move(0, 0);
            await expect(page.locator("#evidence-tooltip")).toBeHidden();
            await page.screenshot({ path: path.join(proofs, `bounded-prompt-${theme}-${width}-${scale}.png`) });
            await fetch.locator(".call-heading").evaluate(node => {
                const body = document.getElementById("contextSidebarBody");
                body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - 16;
            });
            await page.screenshot({ path: path.join(proofs, `bounded-calls-${theme}-${width}-${scale}.png`) });
            await writeFile(path.join(proofs, `bounded-geometry-${theme}-${width}-${scale}.json`),
                JSON.stringify({ qualification: "Internal EC92 fixture proof on the composed source; not a user-test build or deployment.", ...geometry }, null, 2));
        }
    }
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
    await expect(calls.nth(0)).toContainText("exceeded the 8 KiB inspection limit");
    await expect(calls.nth(1)).toContainText("matched credential screening");
    await expect(calls.nth(2)).toContainText("unsupported format");
    for (const call of await calls.all()) {
        await expect(call.locator(".reader-recorded-signal")).toHaveText("No error details recorded.");
        await expect(call.getByRole("button", { name: /sign in|retry|authenticate/i })).toHaveCount(0);
        assert.doesNotMatch(await call.innerText(), /Recorded error signal:|HTTP 401|HTTP 403/);
    }
});

test("EC92 final assembly keeps timing with its subject and only useful reading sections", { timeout: 25000 }, async t => {
    const record = readerRecord(), exact = "Invented retained reply.\n  Preserve this ending.\n";
    record.userPrompt.sourceTimestamp = "2026-09-30T12:00:00.321Z";
    const { page, assessmentView } = await setup(t, [record], { responseText: exact });
    const reader = page.locator("#requestContent"), prompt = reader.locator('[data-reader-section="prompt"]');
    const response = reader.locator('[data-reader-section="response"]');
    await expect(response.locator(".full-text-content")).toHaveText(exact);
    assert.deepEqual(await reader.locator(":scope > [data-reader-section]").evaluateAll(nodes => nodes.map(node => node.dataset.readerSection)),
        ["prompt", "activity", "response", "source"]);
    await expect(response.locator(".reader-section-toggle")).toHaveText("Recorded response");
    await expect(reader.locator('[data-reader-section="source"] .reader-section-toggle')).toHaveText("Source details");
    await expect(prompt.locator("time")).toHaveAttribute("datetime", record.userPrompt.sourceTimestamp);
    await expect(prompt.locator("time")).toHaveAttribute("title", record.userPrompt.sourceTimestamp);
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

test("reader story separates the recorded request, interaction response and optional following context", { timeout: 25000 }, async t => {
    const record = readerRecord(), requestPath = "/me?$select=preferredLanguage";
    record.userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    record.userPrompt.text = "Review the invented directory preference recorded for this example. ".repeat(5);
    Object.assign(record.toolCalls[0], {
        requestArgs: { entityUrls: [requestPath] }, durationMs: 237,
        toolSucceeded: false, reportedOutcome: "failed",
        failureEvidence: { version: 1, reason: "no-structured-error", messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required" },
    });
    const following = "Separate work: compare the invented handoff notes and identify unresolved owners. ".repeat(5);
    record.followUpPrompts = [{ text: following, status: "full", sourceEventId: "invented-following-work",
        sourceTimestamp: "2026-09-30T12:01:00.000Z", authorship: { actor: "agent", basis: "source-agent" } }];
    const otherAttempt = structuredClone(record);
    otherAttempt.scenarioId = "invented-distinct-attempt";
    otherAttempt.userPrompt.sourceEventId = "invented-distinct-prompt";
    otherAttempt.userPrompt.sourceTimestamp = "2026-09-30T12:30:00.000Z";
    otherAttempt.followUpPrompts = [];
    Object.assign(otherAttempt.toolCalls[0], { toolCallId: "invented-distinct-call", startEventId: "invented-distinct-start",
        startedAt: "2026-09-30T12:30:02.000Z", completedAt: "2026-09-30T12:30:03.000Z",
        toolSucceeded: true, reportedOutcome: "succeeded", failureEvidence: null });
    const { page, context } = await setup(t, [record, otherAttempt]);
    await page.locator('.request-card-open[href*="request=reader-approved"]').click();
    await expect(page.locator(".request-card-open")).toHaveCount(2);
    const reader = page.locator("#requestContent"), call = reader.locator('[data-tool-call-id="invented-reader-call"]');
    await expect(reader.getByText("No saved response. Capture is off.", { exact: true })).toHaveCount(1);
    await expect(call.locator(".reader-input-value code")).toHaveText(requestPath);
    await expect(call.locator(".reader-input-heading .service-cue")).toHaveText("People");
    await expect(call.locator(".reader-recorded-signal")).toHaveText("Recorded error signal: sign-in required.");
    const observations = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", scale === 1 ? "docked" : "overlay");
        const observed = await reader.evaluate(root => {
            const call = root.querySelector('[data-tool-call-id="invented-reader-call"]');
            const target = call.querySelector(".reader-input-value code"), input = call.querySelector(".reader-input");
            const box = node => { const value = node.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; };
            const responseHeading = root.querySelector(":scope > .reader-response-availability > h2");
            const text = [...target.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.includes("preferredLanguage"));
            const token = document.createRange(), offset = text.textContent.indexOf("preferredLanguage");
            token.setStart(text, offset); token.setEnd(text, offset + "preferredLanguage".length);
            return {
                primaryPrompts: [...root.querySelectorAll('[data-text-subject=request] .full-text-content')].filter(node => node.checkVisibility()).length,
                responseInsideCall: Boolean(call.querySelector(".interaction-response")),
                requestCaption: input.querySelector(".reader-input-label").textContent,
                pathCaptionCount: input.querySelectorAll(".reader-input-label,.reader-request-paths dt").length,
                rawPath: target.textContent, path: box(target), input: box(input),
                queryTokenLines: token.getClientRects().length,
                responseHeading: responseHeading && { ...box(responseHeading), clip: getComputedStyle(responseHeading).clipPath },
                overflow: document.getElementById("contextSidebarBody").scrollWidth - document.getElementById("contextSidebarBody").clientWidth,
            };
        });
        observations.push({ theme, width, scale, ...observed });
        const directory = process.env.WIRE_READER_STORY_PROOFS;
        if (directory) {
            await mkdir(directory, { recursive: true });
            await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop = 0);
            await page.screenshot({ path: path.join(directory, `story-prompt-${theme}-${width}-${scale}.png`) });
            await call.evaluate(node => {
                const scroll = document.getElementById("contextSidebarBody");
                scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 64;
            });
            await page.screenshot({ path: path.join(directory, `story-activity-${theme}-${width}-${scale}.png`) });
            await writeFile(path.join(directory, "story-measurements.json"), JSON.stringify(observations, null, 2));
        }
    }
    assert.equal((await loadBoardState(context)).evidence.length, 2, "Similar prompt text does not merge genuine attempts");
    for (const observed of observations) {
        assert.equal(observed.rawPath, requestPath, "The retained relative request is not malformed or rewritten");
        assert.ok(observed.overflow <= 1);
        assert.equal(observed.queryTokenLines, 1, "A query token that fits wraps at a meaningful separator, not a final orphaned character");
        assert.ok(observed.responseHeading?.height >= 20 && observed.responseHeading.clip === "none", "Availability has a visible subject heading");
        assert.equal(observed.pathCaptionCount, 1, "A target-only request has one path caption, not stacked request/path labels");
        assert.deepEqual({ primaryPrompts: observed.primaryPrompts, responseInsideCall: observed.responseInsideCall, requestCaption: observed.requestCaption },
            { primaryPrompts: 1, responseInsideCall: false, requestCaption: "Requested path" });
    }
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

test("reader story keeps the complete visible sequence across response states, plural calls and long requests", { timeout: 30000 }, async t => {
    for (const [responseState, outcome] of [["absent", "success"], ["partial", "failure"], ["full", "unknown"]]) {
        const record = readerRecord(), first = record.toolCalls[0], exact = "Invented saved reply.\n  Keep its exact bytes.\n";
        const paths = ["/me/drive/items/" + "long-invented-resource-".repeat(12) + "?$select=name,webUrl", "/me?$select=preferredLanguage&$expand=manager"];
        Object.assign(first, { requestArgs: { entityUrls: paths }, toolSucceeded: outcome === "unknown" ? null : outcome === "success",
            reportedOutcome: outcome === "unknown" ? "unknown" : outcome === "success" ? "succeeded" : "failed" });
        record.toolCalls.push({ ...first, toolCallId: "invented-second-call", startEventId: "invented-second-start",
            requestArgs: { query: "  Invented query with retained spacing.\n", capabilities: [{ name: "Email" }] } });
        record.followUpPrompts = [{ text: "A separate invented follow-up fragment.", status: "partial",
            sourceEventId: "invented-fragment", sourceTimestamp: "2026-09-30T12:10:00.000Z",
            authorship: { actor: "unknown", basis: "legacy-missing" } }];
        const options = responseState === "absent" ? {} : { responseText: exact,
            responseCompleteness: responseState === "full" ? "full-record" : "bounded-fragment" };
        const { page, context } = await setup(t, [record], options), reader = page.locator("#requestContent");
        await expect(reader.locator('[aria-busy="true"]')).toHaveCount(0);
        const response = reader.locator('[data-reader-section="response"]'), before = (await loadBoardState(context)).evidence;
        if (responseState !== "absent") {
            await expect(response.locator(".full-text-content")).toHaveText(exact);
            await expect(response.getByText("Partial text", { exact: true })).toHaveCount(responseState === "partial" ? 1 : 0);
            await response.getByRole("button", { name: "Copy response", exact: true }).click();
            assert.equal(await page.evaluate(() => window.readerCopies.at(-1)), exact);
        } else await expect(reader.locator(":scope > .reader-response-availability")).toContainText("No saved response. Capture is off.");
        const expected = ["prompt", "activity", responseState === "absent" ? "availability" : "response", "source"];
        assert.deepEqual(await reader.evaluate(root => [...root.children].filter(node => node.checkVisibility()
            && (node.dataset.readerSection || node.classList.contains("reader-response-availability")))
            .map(node => node.dataset.readerSection ?? "availability")), expected);
        const call = reader.locator('[data-tool-call-id="invented-reader-call"]');
        await expect(call.locator(".reader-request-paths code")).toHaveText(paths);
        await expect(reader.locator(".journey-item .reader-response-availability")).toHaveCount(0);
        await expect(reader.locator(".reader-linked-context .full-text-content")).toHaveCount(0);
        await expect(reader.locator('.request-context-timeline [data-context-kind="action"]')).toHaveCount(2);
        await expect(call.locator(".recorded-result-label")).toHaveText({ success: "Worked", failure: "Tool failed", unknown: "No result recorded" }[outcome]);
        for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
            await page.setViewportSize({ width: 1440, height: 1000 });
            await page.evaluate(() => document.documentElement.style.fontSize = "100%");
            await chooseTheme(page, theme);
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
            await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", scale === 1 ? "docked" : "overlay");
            const geometry = await call.locator(".reader-request-paths code").evaluateAll(nodes => nodes.map(node => ({
                text: node.textContent, overflow: node.scrollWidth - node.clientWidth,
                font: getComputedStyle(node).fontFamily, size: getComputedStyle(node).fontSize, weight: getComputedStyle(node).fontWeight,
            })));
            for (const value of geometry) {
                assert.ok(value.overflow <= 1);
                assert.match(value.font, /Asta Sans/);
                assert.equal(value.size, `${14 * scale}px`);
                assert.equal(value.weight, "400");
            }
            assert.deepEqual(geometry.map(value => value.text), paths);
            assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        }
        assert.deepEqual((await loadBoardState(context)).evidence, before);
    }
});

test("reader story remains scoped when opened through actual Search and report peek", { timeout: 30000 }, async t => {
    const record = readerRecord(), cleanup = [], marker = "Invented Orchid directory review";
    record.userPrompt.text = marker; record.userPrompt.authorship = { actor: "agent", basis: "source-agent" };
    record.toolCalls[0].requestArgs = { entityUrls: ["/me?$select=preferredLanguage"] };
    record.followUpPrompts = [{ text: "Independent invented work, not a second selected prompt.", status: "full",
        sourceEventId: "invented-search-following", sourceTimestamp: "2026-09-30T12:01:00Z",
        authorship: { actor: "agent", basis: "source-agent" } }];
    const app = await searchFixture({ after: fn => cleanup.push(fn) }, { records: [record], reply: false });
    const browser = await chromium.launch(), page = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.stack));
    page.on("request", request => requests.push(new URL(request.url())));
    t.after(async () => {
        await browser.close(); for (const fn of cleanup) await fn();
        assert.deepEqual(errors, []);
        assert.ok(requests.every(url => url.origin === new URL(app.runtime.url).origin));
        assert.ok(!requests.some(url => /\/api\/(?:preview|privacy-review|export|assessment\/feedback|assessment\/consent\/set)$/.test(url.pathname)));
    });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#wireSearch").fill("Orchid");
    const hit = page.locator(".wire-search-hit").filter({ has: page.locator(".wire-search-title", { hasText: marker }) });
    await expect(hit).toHaveCount(1);
    const verify = async () => {
        await expect(page.locator(".request-original pre")).toHaveText(marker);
        await expect(page.locator(".reader-linked-context")).not.toHaveAttribute("open", "");
        await expect(page.locator(".reader-linked-context .full-text-content")).toHaveCount(0);
        await expect(page.locator(".request-context-timeline .reader-response-availability")).toHaveCount(0);
        await expect(page.locator("#requestContent > .reader-response-availability")).toContainText("No saved response.");
        await expect(page.locator(".reader-request-paths code")).toHaveText(record.toolCalls[0].requestArgs.entityUrls);
    };
    await hit.click(); await verify();
    await page.goBack(); await expect(hit).toBeFocused();
    await hit.click(); await verify();
    await page.locator("#requestReportToggle").click();
    await page.locator("#requestReportContinue").click();
    await page.locator("#reportList .request-link").click();
    await verify();
    await expect(page.getByRole("button", { name: "Back to activity", exact: true })).toBeVisible();
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
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
    await captureCorrection(page, "caption-known-input", "activity");
});
