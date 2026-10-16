import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, automaticScoreOffSummary, selectActivityOption, chooseTheme } from "./helpers.mjs";
import { contract, retainedResponse, samples, openPersonalFeedback } from "./assessment-ui-fixtures.mjs";
import { graphMatrixRecord } from "./report-evidence-matrix-fixtures.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { recordedInteractionModels } from "../lib/interaction-model.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";

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

async function setup(t, records = [readerRecord()], { responseText, assessmentFixture, motion = "reduce", sidebarMotion, saveFrozen = false } = {}) {
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
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push({ path: new URL(request.url()).pathname, origin: new URL(request.url()).origin }));
    await page.route("**/api/evaluation/**", route => new URL(route.request().url()).pathname === "/api/evaluation/automatic/summary"
        ? route.fulfill({ json: automaticScoreOffSummary() }) : route.abort("blockedbyclient"));
    await page.addInitScript(() => {
        window.readerCopies = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            readText() { throw Error("Real clipboard reads are forbidden."); },
            async writeText(text) { window.readerCopies.push(text); },
        } });
    });
    let assessmentView;
    if (responseText !== undefined || assessmentFixture) {
        const texts = responseText === undefined ? [] : Array.isArray(responseText) ? responseText : [responseText];
        const view = assessmentView = assessmentFixture ?? retainedResponse(texts[0], records[0]);
        const first = view.observations.find(item => item.kind === "answer"), responseTexts = new Map(first ? [[first.observationRef, texts[0]]] : []);
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
                completeness: "bounded-fragment", finality: "unverified", basis: view.basis }) });
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
    await expect(reader.locator('[data-reader-section="timing"]')).toBeVisible();
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

test("personal feedback enters the existing form directly and bulk folding honors its unsent guard", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const reviews = page.locator('[data-reader-section="reviews"]');
    await reviews.getByRole("button", { name: "Personal feedback", exact: true }).click();
    const dimension = reviews.locator("select[data-feedback-dimension]");
    await expect(dimension).toHaveCount(1);
    await selectActivityOption(page, await dimension.getAttribute("id"), "semantic-answer-correctness");
    await expect(reviews.getByRole("button", { name: "Save feedback", exact: true })).toBeVisible();
    await expect(reviews.getByRole("button", { name: "Give personal feedback", exact: true })).toHaveCount(0);
    await selectActivityOption(page, "feedback-verdict-semantic-answer-correctness", "pass");
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await expect(page.locator("#contextSidebarGuard")).toBeVisible();
    await expect(page.locator(".reader-section-toggle[aria-expanded=false]")).toHaveCount(0);
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(reviews.locator("#feedback-verdict-semantic-answer-correctness")).toHaveValue("pass");
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(reviews.locator(".reader-section-toggle")).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Expand all sections", exact: true }).click();
    await expect(reviews.locator("#feedback-verdict-semantic-answer-correctness")).toHaveValue("");
    await expect(reviews.getByRole("button", { name: "Save feedback", exact: true })).toBeDisabled();
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
    await expect(reader.locator('.reader-timing-table data[value="0"]')).toHaveCount(1);
    await expect(activity).toContainText("Graph code reference");
    await expect(activity).toContainText("Execution not observed");
    await expect(activity).toContainText("Explicit HTTP recorder");
    await expect(activity).toContainText("503");
    const fetch = activity.locator('[data-tool-call-id="invented-reader-call"]');
    await expect(fetch.locator(".reader-values .service-cue")).toHaveCount(2);
    const retrieve = activity.locator('[data-tool-call-id="invented-reader-retrieve"]');
    await expect(retrieve.locator(".reader-input .reader-values>li")).toHaveCount(3);
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
            const label = input.querySelector(".reader-input-label"), value = input.querySelector(".reader-input-value code"), copy = input.querySelector(".ux-copy");
            const l = label.getBoundingClientRect(), v = value.getBoundingClientRect(), c = copy.getBoundingClientRect();
            const root = document.getElementById("contextSidebarBody");
            return { gap: v.top - l.bottom, target: { width: c.width, height: c.height }, overflow: root.scrollWidth - root.clientWidth,
                labels: getComputedStyle(label).fontSize, values: getComputedStyle(value).fontSize };
        });
        assert.ok(measured.gap >= 0 && measured.gap <= 4, `${theme}/${width}/${scale}: label/value gap ${measured.gap}`);
        assert.ok(measured.target.width >= 44 && measured.target.height >= 44);
        assert.ok(measured.overflow <= 1);
        assert.equal(measured.labels, measured.values);
        const fieldAlignment = await reader.locator(".reader-fields>div").evaluateAll(nodes => nodes.map(node => {
            const label = node.querySelector("dt").getBoundingClientRect(), value = node.querySelector("dd").getBoundingClientRect();
            return { left: value.left - label.left, gap: value.top - label.bottom };
        }));
        assert.ok(fieldAlignment.every(value => Math.abs(value.left) <= 1 && value.gap >= 0 && value.gap <= 4), JSON.stringify(fieldAlignment));
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
    const { page } = await setup(t, [readerRecord()], { responseText: texts });
    const response = page.locator('[data-reader-section="response"]');
    await expect(response.locator("pre")).toHaveCount(2);
    await expect(response.locator(".reader-section-toggle")).toHaveCount(1);
    for (let index = 0; index < texts.length; index++) {
        await response.getByRole("button", { name: `Copy response ${index + 1}`, exact: true }).click();
        await expect(page.locator('[data-reader-section="timing"]').getByText(`Response ${index + 1} recorded`, { exact: true })).toHaveCount(1);
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
    await expect(prompt).toContainText("No individual action details were retained");
    await expect(prompt.locator("pre,.ux-copy")).toHaveCount(0);
    await expect(page.locator('[data-reader-section="source"] .reader-fields>div').filter({ has: page.getByText("Source event", { exact: true }) })).toContainText("Not recorded");
    await expect(page.locator('[data-reader-section="timing"]')).toContainText("Not recorded");
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

test("saved model reviews have one visible scoped definition table without repeating local checks", { timeout: 20000 }, async t => {
    const record = readerRecord();
    const { model } = qualityDisplayFixture({ records: [record], judgments: [{ accuracy: "pass", "answer-trust": "fail", "action-trust": "unassessed" }] });
    const view = [...model.details.values()][0];
    const { page } = await setup(t, [record], { assessmentFixture: view });
    const reviews = page.locator('[data-reader-section="reviews"]');
    await expect(reviews.locator('.single-interaction-measures tr[data-origin="model-assessed"]')).toHaveCount(3);
    await expect(reviews.locator('.single-interaction-measures [data-origin="automatic-local"]')).toHaveCount(0);
    await expect(reviews.locator('.assessment-finding-group[data-finding-origin="model-assessed"]')).toHaveCount(0);
    await expect(reviews).toContainText("synthetic-quality-fixture");
    await expect(reviews).toContainText("wire-recorded-interaction-review");
    await expect(reviews.locator("details")).toHaveCount(0);
    assert.equal(await reviews.evaluate(node => node.innerText.split("AI judgments can be wrong. Matching the request is not proof of human permission.").length - 1), 1);
    await expect(reviews.locator(".reader-check-counts dt+dd")).toHaveCount(3);
    if (proofs) for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await reviews.locator(".reader-section-heading").evaluate(node => {
            const body = document.getElementById("contextSidebarBody");
            body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
        });
        await mkdir(proofs, { recursive: true });
        await page.screenshot({ path: path.join(proofs, `reader-reviews-${theme}.png`) });
    }
});

test("correction: same-evidence persisted pageshow restores live owners only after authorization and preserves Back", { timeout: 25000 }, async t => {
    const { page, records } = await setup(t);
    await expect(page.locator('#requestContent [aria-busy="true"]')).toHaveCount(0);
    await openPersonalFeedback(page);
    await selectActivityOption(page, "feedback-verdict-semantic-answer-correctness", "pass");
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await expect(page.locator("#contextSidebarGuard")).toBeVisible();
    const oldDiscard = await page.getByRole("button", { name: "Discard changes", exact: true }).elementHandle();
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
    assert.equal(await page.locator("#contextSidebarGuard").isVisible(), false, "A disposed editor cannot leave an actionable old discard callback");
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    try {
        await arrived;
        assert.equal(await page.getByRole("button", { name: "Collapse all sections", exact: true }).count(), 0);
        release(); await Promise.all(deliveries);
    } finally { release(); await Promise.all(deliveries); await page.unroute("**/api/snapshot", holdSnapshot); }
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await expect(page.locator('[data-reader-section="prompt"] pre')).toHaveCount(0);
    await page.getByRole("button", { name: "Expand all sections", exact: true }).click();
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.readerCopies), [records[0].userPrompt.text]);
    const freshForm = await openPersonalFeedback(page);
    await selectActivityOption(page, "feedback-verdict-semantic-answer-correctness", "fail");
    await oldDiscard.evaluate(node => node.click());
    assert.equal(await freshForm.locator("#feedback-verdict-semantic-answer-correctness").inputValue(), "fail",
        "A detached discard control cannot clear the successor editor");
    await freshForm.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await page.goBack();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.locator(".request-card-open")).toBeFocused();
});

test("correction: deferred fold rechecks automatic setup opened after feedback Save", { timeout: 25000 }, async t => {
    const { page } = await setup(t);
    await page.route("**/api/evaluation/automatic/setup", route => route.fulfill({ json: {
        schemaVersion: 1, sourceRevision: 7, approvalRevision: 0, minimumSessionAiCredits: 30, snapshot: null,
        source: { sourceConfigRef: "sourceconfig-" + "a".repeat(32), sourceConfigRevision: 1, windowDays: 30 },
        method: { provider: "github-copilot", model: "invented-review-model", rubricId: "wire-recorded-interaction-review", rubricVersion: 1 },
        chats: [{ chatRef: "chat-" + "b".repeat(32), name: "Invented approval scope", outsideWindow: 0, requestGroups: 1, shortId: "invented" }],
    } }));
    const form = await openPersonalFeedback(page);
    await selectActivityOption(page, "feedback-verdict-semantic-answer-correctness", "pass");
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    const obsoleteDiscard = await page.getByRole("button", { name: "Discard changes", exact: true }).elementHandle();
    let release, arrive;
    const held = new Promise(resolve => release = resolve), arrived = new Promise(resolve => arrive = resolve), deliveries = [];
    await page.route("**/api/snapshot", route => {
        const delivery = (async () => {
            const response = await route.fetch(); arrive(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    });
    try {
        await form.getByRole("button", { name: "Save feedback", exact: true }).click();
        await arrived;
        await expect(form).toBeHidden();
        await expect(page.locator("#contextSidebarGuard")).toBeHidden();
        await page.locator("#requestContent [data-automatic-scores]").click();
        await expect(page.locator("#requestContent .automatic-score-dialog")).toBeVisible();
        await obsoleteDiscard.evaluate(node => node.click());
        await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
        await expect(page.locator('[data-reader-section="reviews"] .reader-section-notice')).toContainText("Close Automatic scores");
        assert.equal(await page.locator(".reader-section-toggle[aria-expanded=false]").count(), 0);
        assert.equal(await page.locator("#requestContent .automatic-score-dialog").isVisible(), true);
        await expect(page.locator("#requestContent .automatic-score-dialog").getByRole("checkbox", { name: /Allow this evidence/ })).not.toBeChecked();
    } finally { release(); await Promise.all(deliveries); }
});

test("correction: deferred fold rechecks a feedback Save that became pending", { timeout: 25000 }, async t => {
    const { page } = await setup(t);
    const form = await openPersonalFeedback(page);
    await selectActivityOption(page, "feedback-verdict-semantic-answer-correctness", "pass");
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await expect(page.locator("#contextSidebarGuard")).toBeVisible();
    let release, arrived, writes = 0;
    const held = new Promise(resolve => release = resolve), pending = new Promise(resolve => arrived = resolve), deliveries = [];
    await page.route("**/api/assessment/feedback", route => {
        const delivery = (async () => {
            writes++; const response = await route.fetch();
            arrived(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    });
    try {
        await form.getByRole("button", { name: "Save feedback", exact: true }).click();
        await pending;
        await page.getByRole("button", { name: "Discard changes", exact: true }).click();
        assert.equal(await page.locator(".reader-section-toggle[aria-expanded=false]").count(), 0, "The deferred fold must recheck the now-pending form immediately");
        assert.equal(await form.isVisible(), true);
        assert.equal(writes, 1);
    } finally { release(); await Promise.all(deliveries); }
    await page.waitForFunction(() => sessionStorage.getItem("wire.assessment.pending") === null);
    assert.equal(writes, 1);
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
    ["credential-excluded", "Text was excluded by credential screening.", false],
    ["capture-limit", "Some evidence was left out because it exceeded the saving limit.", true],
]) test(`correction: recorded response availability retains ${reason} independently of current capture`, { timeout: 20000 }, async t => {
    const record = readerRecord(), view = retainedResponse("Never-readable invented response", record);
    view.observations = view.observations.filter(item => item.kind !== "answer");
    for (const item of [...view.assessments, ...view.metrics].filter(item => item.checkId === "answer-evidence-present")) {
        item.reason = reason;
        if (item.metricRef) item.unassessedReasons = [{ reason, count: 1 }];
    }
    if (captureOff) view.consent = { ...contract.defaultConsent(), revision: view.basis.consentRevision };
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

test("correction: local timing qualification and unsupported quality checks retain separate truthful homes", { timeout: 20000 }, async t => {
    const record = readerRecord();
    record.toolCalls[0].completedAt = null;
    const { page } = await setup(t, [record]);
    const timing = page.locator('[data-reader-section="timing"]');
    await expect(timing.locator('.reader-timing-table data[value="1000"]')).toHaveCount(1);
    const checks = timing.locator(".reader-local-timing");
    await expect(checks.locator('[data-definition-id="tool-duration"]')).toContainText("Not measured");
    await expect(checks.locator('[data-definition-id="interaction-latency"]')).toContainText("Boundary not verified");
    await expect(page.locator('[data-reader-section="reviews"] .reader-local-quality')).toContainText("Local checks do not assess");
    await expect(timing.locator('[data-definition-id="recorded-response-duration"]')).toHaveCount(0);
    await captureCorrection(page, "local-timing-qualification", "timing");
});

test("remaining: a connected stale discard from cleared A cannot cancel B's draft or focus", { timeout: 20000 }, async t => {
    const a = readerRecord(), b = structuredClone(a);
    b.scenarioId = "reader-guard-b";
    b.sourceSessionId = "invented-reader-b-chat";
    b.sourceSessionName = "Invented B chat";
    b.userPrompt.sourceEventId = "invented-reader-b-prompt";
    b.userPrompt.text = "Invented B prompt; separate feedback owner.";
    b.toolCalls[0].toolCallId = "invented-reader-b-call";
    const { page, context } = await setup(t, [a, b]);
    await page.locator('.request-card-open[href*="request=reader-approved"]').click();
    const formA = await openPersonalFeedback(page);
    await selectActivityOption(page, "feedback-verdict-semantic-answer-correctness", "pass");
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    const discardA = await page.getByRole("button", { name: "Discard changes", exact: true }).elementHandle();
    await selectActivityOption(page, "feedback-verdict-semantic-answer-correctness", "");
    await expect(formA.getByRole("button", { name: "Save feedback", exact: true })).toBeDisabled();
    const guardAfterReset = await page.locator("#contextSidebarGuard").isVisible();
    await page.locator('.request-card-open[href*="request=reader-guard-b"]').click();
    await expect(page).toHaveURL(/request=reader-guard-b/);
    const formB = await openPersonalFeedback(page);
    await selectActivityOption(page, "feedback-verdict-semantic-answer-correctness", "fail");
    const focusB = formB.getByRole("combobox", { name: "Your assessment", exact: true });
    await focusB.focus();
    const draft = () => formB.evaluate(node => JSON.stringify([...node.querySelectorAll("input,select,textarea")]
        .map(field => [field.id, field.value, field.disabled])));
    const before = await draft(), stored = (await loadBoardState(context)).personalEvaluation;
    if (await discardA.evaluate(node => node.isConnected)) {
        await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    } else await discardA.evaluate(node => node.click());
    assert.equal(await draft(), before, "The originating editor must be checked before any discard mutation");
    await expect(focusB).toBeFocused();
    await expect(formB.getByRole("button", { name: "Save feedback", exact: true })).toBeEnabled();
    await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    assert.equal(guardAfterReset, false, "Clearing the originating draft also clears its obsolete confirmation");
    assert.deepEqual((await loadBoardState(context)).personalEvaluation, stored, "No feedback write or replay");
    await captureCorrection(page, "stale-guard-successor", "reviews");
});

test("remaining: recorded HTTP response and transport measures retain their explicit boundaries once", { timeout: 20000 }, async t => {
    const record = readerRecord();
    record.httpRecords = [20, 80, 45].map((durationMs, index) => ({
        recordId: `invented-boundary-http-${index}`, classification: "direct-graph-http", synthetic: false,
        observedGraphHttp: index < 2, responseOrigin: index < 2 ? "https://graph.microsoft.com" : null,
        method: "GET", apiVersion: "v1.0", responsePath: { path: "/me/drive/root", query: [] },
        startedAt: "2026-09-30T12:00:04.000Z", durationMs, durationBoundary: "request dispatch to response headers",
        status: index < 2 ? 200 : null, transportError: index < 2 ? null : "TimeoutError",
    }));
    const { page } = await setup(t, [record]);
    const timing = page.locator('[data-reader-section="timing"]');
    for (const [definition, boundary, value, coverage] of [
        ["http-response-duration", "Dispatch to response headers", "20", "2 of 2 HTTP responses timed"],
        ["http-error-duration", "Dispatch to transport error", "45", "1 of 1 HTTP transport error timed"],
    ]) {
        const field = timing.locator(`[data-definition-id="${definition}"]`);
        await expect(field.locator("data")).toHaveAttribute("value", value);
        await expect(field).toHaveAttribute("data-measurement-basis", "owned-monotonic-clock");
        assert.equal((await field.innerText()).split(boundary).length - 1, 1, "Visible recorded boundary has one scoped home");
        await expect(field).toContainText(coverage);
    }
    await expect(timing.locator('[data-definition-id="http-response-duration"]')).toContainText("Median 0.02 s; P95 0.08 s");
    await expect(timing.locator('[data-definition-id="http-error-duration"]')).toContainText("0.05 s single measured sample");
    await captureCorrection(page, "http-response-boundary", "timing", '[data-definition-id="http-response-duration"]');
    await captureCorrection(page, "http-transport-boundary", "timing", '[data-definition-id="http-error-duration"]');
});
