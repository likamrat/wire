// Invented retained samples only, on the real application with source timers disabled.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { buildSanitizedBundle, createExportController } from "../../lib/export.mjs";
import { recordedResponseTiming } from "../../lib/response-timing.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "../support/helpers.mjs";
import { contrast } from "../support/color-measurements.mjs";
import { createTimingPresentation, renderRecordedTiming } from "../../web/assessment-presentation.mjs";
import { buildReportFacts } from "../../lib/assessment-read-model.mjs";
import { matrixRecords } from "../reports/report-evidence-matrix-fixtures.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const proofs = process.env.WIRE_RECORDED_TIMING_PROOFS;
const start = Date.UTC(2026, 8, 30, 12), stamp = delta => new Date(start + delta).toISOString();
function responseTiming(record, durationMs) {
    return recordedResponseTiming([
        { id: record.userPrompt.sourceEventId, type: "user.message", timestamp: stamp(0), data: { messageId: "prompt" } },
        { id: "response", type: "assistant.message", timestamp: stamp(durationMs), data: {
            wireResponseMetadataVersion: 1, finalAnswer: true, hasResponseText: true, hasToolRequests: false,
            turnId: "turn", originatingMessageId: "prompt",
        } },
        { id: "end", type: "assistant.turn_end", timestamp: stamp(durationMs + 1), data: { turnId: "turn" } },
    ], record.userPrompt);
}
function records() {
    return ["ALPHA", "BETA"].map((name, i) => {
        const row = fixture(`timing-${name}`);
        row.sourceSessionId = `timing-source-${name}`;
        row.sourceSessionName = `Invented ${name}`;
        row.userPrompt = { ...row.userPrompt, text: `SYNTHETIC_TIMING_${name}`, sourceEventId: `prompt-${i}`, sourceTimestamp: stamp(0) };
        row.followUpPrompts = [];
        row.toolCalls = (i === 0 ? [0, 2000, 900000] : [1000, null]).map((durationMs, j) => ({
            ...structuredClone(row.toolCalls[0]), toolCallId: `call-${i}-${j}`, startEventId: `start-${i}-${j}`,
            requestArgs: durationMs === null ? {} : { entityUrls: [j === 0 ? "/me/calendarView" : "/me/messages"] },
            requestedApiPath: durationMs === null ? null : j === 0 ? "/me/calendarView" : "/me/messages",
            completionEventId: durationMs === null ? null : `end-${i}-${j}`,
            startedAt: stamp(0), completedAt: durationMs === null ? null : stamp(durationMs), durationMs,
            toolSucceeded: durationMs === null ? null : true, reportedOutcome: durationMs === null ? "unknown" : "succeeded",
        }));
        if (i === 0) row.responseTiming = responseTiming(row, 677960);
        return row;
    });
}
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const rowFor = (page, name = "ALPHA") => page.locator("#activityList .request-row").filter({ hasText: `SYNTHETIC_TIMING_${name}` });
async function setup(t) {
    const source = records(), cleanup = [], requests = [], errors = [], denied = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, source);
    const server = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { denied.push("provider"); throw Error("No provider work in timing proof."); },
            readSource: async () => { denied.push("source"); throw Error("No source reads in timing proof."); },
        } });
    const browser = await chromium.launch(), page = await browser.newPage({
        viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US",
    });
    page.setDefaultTimeout(8000);
    const allowed = new Set(["/api/snapshot", "/api/collection/status", "/api/assessment/detail",
        "/api/assessment/overview", "/api/evaluation/automatic/summary"]);
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && !allowed.has(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        if (request.method() !== "GET") requests.push({ path: url.pathname, body: request.postDataJSON() });
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        try {
            await browser.close(); await server.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.doesNotMatch(JSON.stringify(requests), /SYNTHETIC_TIMING/);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(server.url + "#analyze"); await ready(page);
    return { page, source, context, requests };
}

test("Source keeps the whole prompt interval in a filtered reader; missing, rejected and zero timing stay distinct", async t => {
    const { page, requests } = await setup(t);
    await selectActivityOption(page, "serviceAssociationFilter", "Calendar"); await ready(page);
    const reader = page.locator("#requestContent");
    const final = reader.locator(".response-timing");
    async function open(name) {
        await rowFor(page, name).locator(".request-card-open").click();
        await expect(reader).toHaveAttribute("data-view-key", `request:timing-${name}`);
        const source = reader.getByRole("button", { name: "Source details" });
        if (await source.getAttribute("aria-expanded") === "false") await source.click();
    }
    assert.equal(requests.filter(r => r.path === "/api/assessment/detail").length, 0);
    await open("ALPHA");
    await expect(final.locator("data")).toHaveAttribute("value", "677960");
    await expect(reader.locator('[data-tool-call-id="call-0-0"] .reader-call-duration data')).toHaveAttribute("value", "0");
    await page.goBack();
    await expect(rowFor(page).locator(".request-card-open")).toBeFocused();
    await open("BETA");
    await expect(final).toHaveCount(0);
    await page.locator("#closeContextSidebar").click();
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json();
        snapshot.assessment.catalog.find(row => row.scenarioId === "timing-ALPHA").responseTiming.sourceRevision++;
        await route.fulfill({ response, json: snapshot });
    });
    await page.reload(); await ready(page);
    await open("ALPHA");
    await expect(final.getByRole("alert")).toHaveText("Timing could not be read");
    await expect(final.locator("data")).toHaveCount(0);
});

test("prompt timing is readable in both themes at desktop and narrow doubled text", { timeout: 45000 }, async t => {
    const { page } = await setup(t), measurements = [];
    await rowFor(page).locator(".request-card-open").click();
    await page.getByRole("button", { name: "Source details" }).click();
    const timing = page.locator("#requestContent .response-timing");
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 1], [375, 2]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        await timing.scrollIntoViewIfNeeded();
        const metrics = await timing.evaluate(root => {
            const nodes = [...root.querySelectorAll("*")].filter(node => node.checkVisibility());
            return { clipped: nodes.filter(node => node.clientWidth && node.scrollWidth > node.clientWidth + 1).map(node => node.className),
                colors: nodes.filter(node => node.matches("dt,data")).map(node => ({ fg: getComputedStyle(node).color,
                    bg: getComputedStyle(document.body).backgroundColor })),
                overflow: document.documentElement.scrollWidth - innerWidth };
        });
        assert.deepEqual(metrics.clipped, []); assert.ok(metrics.overflow <= 1);
        for (const color of metrics.colors) assert.ok(contrast(color.fg, color.bg) >= 4.5, `${theme} timing text`);
        await expect(timing.locator("data")).toHaveAttribute("value", "677960");
        await expect(timing.locator("details,button,.timing-scale")).toHaveCount(0);
        measurements.push({ theme, width, scale, ...metrics });
        if (proofs) await timing.screenshot({ path: path.join(proofs, `prompt-timing-${theme}-${width}-${scale}.png`) });
    }
    if (proofs) await writeFile(path.join(proofs, "prompt-timing-measurements.json"), JSON.stringify(measurements, null, 2));
});

test("retained aggregate renderer still preserves exact values for optional definitions", async t => {
    const browser = await chromium.launch(), page = await browser.newPage();
    t.after(() => browser.close());
    await page.setContent('<div id="timing"></div>');
    const timing = createTimingPresentation();
    for (const [value, text] of [[0, "0 s"], [Number.MIN_VALUE, "<0.01 s"],
        [1001.1, "1 s"], [60001, "1 min 0 s"], [null, "Not measured"]]) {
        const row = timing.fromSummary({ sampleCount: value === null ? 0 : 2, p50Ms: value, p95Ms: value }, 3, "tool-start-to-completion");
        await page.evaluate(({ render, row }) => {
            (0, eval)(`(${render})`)(document.querySelector("#timing"), [row]);
        }, { render: renderRecordedTiming.toString(), row });
        await expect(page.locator("data")).toHaveCount(1);
        await expect(page.locator("data")).toHaveText(text);
        if (value !== null) await expect(page.locator("data")).toHaveAttribute("value", String(value));
        else await expect(page.locator("data")).not.toHaveAttribute("value");
        await expect(page.locator("#timing")).toContainText("Missing timing is not zero.");
        await expect(page.locator("#timing details,#timing button,.timing-scale")).toHaveCount(0);
        await expect(page.locator("#timing")).not.toContainText("Boundary ID");
        await expect(page.locator("[data-timing-boundary]")).toHaveAttribute("aria-label", "Tool latency: Call start to recorded completion");
    }
});

test("Tool latency in newly rendered HTML Markdown and PDF keeps exact values and readable theme layouts", { timeout: 60000 }, async t => {
    const records = matrixRecords("tool-latency", ["success", "success", "success", "unknown"], { durations: [0, 7, 1200, null] });
    const key = "a".repeat(64), state = { revision: 1, pseudonymKey: key, evidence: records };
    const facts = buildReportFacts(records, state).facts, before = JSON.stringify(facts);
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["html", "markdown", "pdf", "json"] },
        undefined, undefined, facts);
    const loading = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
    let pdfText = "";
    try {
        const pdf = await loading.promise;
        for (let number = 1; number <= pdf.numPages; number++) {
            pdfText += (await (await pdf.getPage(number)).getTextContent()).items.map(item => item.str).join(" ") + "\n";
        }
    } finally { await loading.destroy(); }
    for (const content of [bundle.previewHtml, bundle.files["product-report.md"], pdfText]) {
        assert.match(content, /Tool latency/);
        assert.match(content, /7 ms/);
        assert.match(content, /1\.2 s/);
        assert.match(content, /3 of 4 calls timed/);
        assert.doesNotMatch(content, /call duration|tool-call duration/i);
    }
    assert.equal(JSON.stringify(facts), before);
    const json = JSON.parse(bundle.files["product-report.json"]);
    const metric = json.evaluationFacts.metrics.find(metric => metric.definitionId === "tool-duration");
    assert.equal(metric.boundary, "tool-start-to-completion");
    assert.equal(metric.value, 7);
    assert.deepEqual(metric.samples.map(sample => sample.value).sort((a, b) => a - b), [0, 7, 1200]);
    const browser = await chromium.launch(), page = await browser.newPage({ javaScriptEnabled: false });
    t.after(() => browser.close());
    const denied = [];
    await page.route("**/*", route => { denied.push(route.request().url()); return route.abort(); });
    await page.setContent(bundle.previewHtml);
    const toolRow = page.locator("#timing tbody tr").filter({ hasText: /^Tool latency/ });
    await expect(toolRow).toHaveCount(1);
    await expect(toolRow.locator("td").first()).toHaveText("7 ms");
    await expect(toolRow.locator("td").last()).toHaveText("1,200 ms (1.2 s)");
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1280, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ theme, scale }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = `${scale * 100}%`;
        }, { theme, scale });
        const geometry = await toolRow.evaluate(root => ({
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            clipped: [...root.querySelectorAll("th,td")].filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent),
        }));
        assert.ok(geometry.overflow <= 1); assert.deepEqual(geometry.clipped, []);
        if (proofs) {
            await mkdir(proofs, { recursive: true });
            await page.locator("#timing").screenshot({ path: path.join(proofs, `tool-latency-report-${theme}-${width}-${scale}.png`) });
        }
    }
    assert.deepEqual(denied, []);
});
