import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { buildRequestActivity } from "../lib/activity-analytics.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

const longPath = "/Users/{User-ID}/messages?$filter=" + "Case%2F<not-markup>\u65e5\u672c\u8a9e\u05e9\u05dc\u05d5\u05dd".repeat(30) + "&Last=Keep+This";
function source(id = "result-card", route = "/me/messages") {
    const record = fixture(id);
    record.userPrompt.text = "Synthetic result presentation.";
    record.toolCalls[0].requestArgs = { entityUrls: [route] };
    record.toolCalls[0].requestedApiPath = route;
    record.toolCalls[0].apiResults = [{ index: 0, statusCode: 204, evidenceLevel: "intermediary-reported" }];
    return record;
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t, records) {
    const before = JSON.stringify(records);
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const errors = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() !== "GET" && !(request.method() === "POST" && ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(new URL(request.url()).pathname))) mutations.push(request.url());
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No clipboard reads in result tests."); },
        writeText() { throw Error("No clipboard writes in result tests."); },
    } }));
    t.after(async () => {
        await browser.close(); await runtime.close();
        assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
        assert.equal(JSON.stringify(records), before);
    });
    return { page, url: runtime.url };
}
async function outcomes(node) {
    return node.locator(".recorded-result").evaluateAll(nodes =>
        Object.fromEntries(nodes.map(n => [n.dataset.outcome, Number(n.dataset.count)])));
}

test("recorded results distinguish completion, tool metadata and literal API fields without new actions", { timeout: 30000 }, async t => {
    const record = source();
    const { page, url } = await setup(t, [record]);
    await page.goto(url + "#request?request=result-card"); await ready(page);
    const card = page.locator(".request-outcome"), fields = card.locator(".request-outcome-action");
    assert.deepEqual(await card.locator(".result-heading").allTextContents(), ["Tool completion", "API metadata from tool"]);
    assert.deepEqual(await card.locator(".result-unit").allTextContents(), ["1 Work IQ tool call", "1 tool-returned API result"]);
    assert.deepEqual(await outcomes(card.locator('[data-result-layer=tool]')), { success: 1 });
    assert.deepEqual(await outcomes(card.locator('[data-result-layer=reported-api]')), { success: 1 });
    assert.match(await card.innerText(), /Completion is not correctness.*tool-reported, not directly observed/s);
    assert.match(await card.innerText(), /HTTP 2xx/);
    assert.doesNotMatch(await card.innerText(), /HTTP 200|HTTP 204|workiq-fetch \/ Mail/);
    assert.deepEqual(await fields.locator("dt").allTextContents(), ["Tool", "Service", "API path"]);
    assert.equal(await fields.locator(".action-tool").textContent(), "workiq-fetch");
    assert.equal(await fields.locator(".action-service").textContent(), "Mail");
    assert.equal(await fields.locator("code.api-path").textContent(), "/me/messages");
    assert.equal(await fields.locator("a,button,[role=button]").count(), 0);
    assert.equal(await page.locator(".journey-item code.api-path").textContent(), "/me/messages");
    const pathNode = fields.locator("code");
    assert.equal(await pathNode.evaluate(node => {
        const selection = getSelection(), range = document.createRange();
        range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range);
        return selection.toString();
    }), "/me/messages");
    await page.locator(".journey-item").getByText("Technical details", { exact: true }).click();
    assert.match(await page.locator(".journey-item .facts").allTextContents().then(parts => parts.join(" ")), /Reported status204/);
    assert.deepEqual(createRecordedResults().summarize(buildRequestActivity([record])["reported-api"]),
        { count: 1, success: 1, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0 });
});

test("multi-call and batched returned results preserve status, service and exact path associations", { timeout: 30000 }, async t => {
    const record = source("batch");
    const first = record.toolCalls[0];
    first.requestArgs.entityUrls = ["/me/messages?Case=A", "/me/calendar/events?Case=B"];
    first.reportedOutcome = "partial";
    first.apiResults = [{ ignored: true }, { index: 99, path: "/me/messages?Case=A", statusCode: 200 },
        { index: 99, path: "/me/calendar/events?Case=B", statusCode: 429, errorCode: "Synthetic_Error" }, { index: 0 }];
    const second = { ...structuredClone(first), tool: "workiq-call_function", toolCallId: "second-call", startEventId: "second-start",
        reportedOutcome: "succeeded", requestedApiPath: "/me/drive/root/children?Case=C", requestArgs: {},
        apiResults: [{ index: 0, path: "/me/drive/root/children?Case=Returned", statusCode: 201 }] };
    record.toolCalls.push(second);
    const { page, url } = await setup(t, [record]);
    const snapshot = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.goto(url + "#request?request=batch"); await ready(page);
    const response = await snapshot;
    assert.equal(response.status(), 200, await response.text());
    assert.deepEqual(await outcomes(page.locator(".full-request-results [data-result-layer=tool]")), { success: 1, partial: 1 });
    assert.deepEqual(await outcomes(page.locator(".full-request-results [data-result-layer=reported-api]")), { success: 2, failure: 1, unknown: 1 });
    assert.equal(await page.locator(".request-outcome-action").count(), 0, "No first-call fields attached to a multi-call aggregate");
    const firstCard = page.locator(`[data-tool-call-id="${first.toolCallId}"]`), secondCard = page.locator('[data-tool-call-id="second-call"]');
    assert.deepEqual(await firstCard.locator(":scope > .action-fields code").allTextContents(), first.requestArgs.entityUrls);
    await firstCard.locator(".returned-api-details > summary").click();
    const entries = firstCard.locator(".api-result-entry");
    assert.equal(await entries.count(), 3);
    assert.equal(await entries.nth(0).locator(".api-path").textContent(), "/me/messages?Case=A");
    assert.match(await entries.nth(0).innerText(), /Call service/);
    assert.equal(await entries.nth(0).locator(".action-service").textContent(), "More than one service");
    assert.deepEqual(await outcomes(entries.nth(0)), { success: 1 });
    assert.equal(await entries.nth(1).locator(".api-path").textContent(), "/me/calendar/events?Case=B");
    assert.equal(await entries.nth(1).locator(".action-service").textContent(), "More than one service", "The canonical call service category is not reclassified from one returned path");
    assert.deepEqual(await outcomes(entries.nth(1)), { failure: 1 });
    assert.equal(await entries.nth(2).locator(".api-path").count(), 0);
    assert.match(await entries.nth(2).innerText(), /Not attributed to a target in this batch/);
    assert.deepEqual(await outcomes(entries.nth(2)), { unknown: 1 });
    await secondCard.locator(".returned-api-details > summary").click();
    assert.equal(await secondCard.locator(".api-result-entry .api-path").textContent(), "/me/drive/root/children?Case=Returned");
    assert.equal(await secondCard.locator(".api-result-entry .action-service").textContent(), "Files");
    assert.doesNotMatch(await firstCard.innerText(), /Case=Returned/);
    assert.doesNotMatch(await secondCard.innerText(), /Case=A|Case=B/);
});

test("absent paths, unknown completion, API absence and inapplicable tool evidence stay distinct", { timeout: 30000 }, async t => {
    const missing = source("missing");
    missing.toolCalls[0].toolSucceeded = null;
    missing.toolCalls[0].reportedOutcome = "unknown";
    missing.toolCalls[0].apiResults = [];
    missing.toolCalls[0].requestedApiPath = null;
    missing.toolCalls[0].requestArgs = {};
    const code = source("code");
    code.toolCalls = [];
    code.graphActivities = [{
        activityId: "code-reference", sourceSessionId: code.sourceSessionId, scenarioId: code.scenarioId,
        toolCallId: "shell", startEventId: "shell-start", startedAt: "2026-09-30T12:00:00Z", tool: "shell",
        method: "GET", evidenceLevel: "code-reference", endpoint: { path: "/me/messages?Keep=Case", method: "GET", apiVersion: "v1.0", queryShape: [] },
        workload: "Mail", httpStatus: null, statusBasis: "none",
        requestCount: null, countUnit: "recorded-request-site", confidence: "high", synthetic: false,
        sourceKind: "inline-command", requestBasis: "request-command",
        fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: false }, evidenceRefs: [],
    }];
    const { page, url } = await setup(t, [missing, code]);
    await page.goto(url + "#request?request=missing"); await ready(page);
    assert.match(await page.locator(".request-outcome").innerText(), /No result recorded.*API metadata: None recorded/s);
    assert.equal(await page.locator(".request-outcome-action .api-path-value").textContent(), "Not recorded");
    assert.equal(await page.locator(".request-outcome .api-path").count(), 0);
    await page.goto(url + "#request?request=code"); await ready(page);
    assert.equal(await page.locator(".request-outcome [data-result-layer=reported-api],.request-outcome .result-missing-api").count(), 0);
    assert.match(await page.locator(".request-outcome").innerText(), /Execution not observed/);
    assert.equal(await page.locator(".journey-item .api-path").textContent(), "/me/messages?Keep=Case");
    assert.match(await page.locator(".journey-item").innerText(), /Referenced API path/);
    assert.doesNotMatch(await page.locator(".request-outcome").innerText(), /Worked|HTTP 2xx/);
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), data = await response.json();
        delete data.requestActivity["reported-api"];
        await route.fulfill({ response, json: data });
    });
    await page.goto(url + "#request?request=missing");
    await page.reload(); await ready(page);
    assert.match(await page.locator(".full-request-results").innerText(), /API results: result counts unavailable/);
    assert.equal(await page.locator(".full-request-results .result-missing-api").count(), 0, "Unavailable metadata is not shown as a known empty set");
});

test("matching result navigation keeps exact paths, selected scope and native focus", { timeout: 30000 }, async t => {
    const record = source("matching", "/me/messages/{Message-ID}?Case=%2F&x=<tag>");
    record.toolCalls[0].toolSucceeded = false;
    record.toolCalls[0].apiResults = [{ index: 0, statusCode: 403 }];
    const { page, url } = await setup(t, [record]);
    await page.goto(url + "#activity?session=test-session&result=failure"); await ready(page);
    assert.equal(await page.locator(".matched-action .api-path").textContent(), record.toolCalls[0].requestArgs.entityUrls[0]);
    assert.equal(await page.locator(".matched-action tag").count(), 0);
    const link = page.locator(".matched-action a[href*='#request']");
    await link.focus();
    assert.equal(await link.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle !== "none"), true);
    await page.keyboard.press("Enter"); await ready(page);
    assert.match(page.url(), /request=matching/);
    await page.locator("#requestContent").getByRole("button", { name: "Add to report", exact: true }).click();
    assert.equal(await page.locator("#requestContent").getByRole("button", { name: "Remove from report", exact: true }).count(), 1);
    await page.locator("#contextBack").click(); await ready(page);
    assert.match(page.url(), /result=failure/);
    assert.equal(await page.locator(".matched-action").count(), 1);
});

test("legacy aliases use the canonical call's exact paths, including start-event identities", { timeout: 30000 }, async t => {
    const current = source("canonical", "/me/messages?Source=Current");
    delete current.toolCalls[0].toolCallId;
    current.toolCalls[0].apiResults = [{ index: 0, statusCode: 204, path: "/me/messages?Source=Returned" }];
    const legacy = structuredClone(current);
    legacy.scenarioId = "legacy-alias";
    legacy.isLegacy = true;
    legacy.toolCalls[0].requestedApiPath = "/me/calendar?Source=Older";
    legacy.toolCalls[0].requestArgs.entityUrls = ["/me/calendar?Source=Older"];
    legacy.toolCalls[0].apiResults[0].path = "/me/calendar?Source=OlderResult";
    const { page, url } = await setup(t, [legacy, current]);
    const snapshot = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.goto(url + "#request?request=legacy-alias"); await ready(page);
    const response = await snapshot;
    assert.equal(response.status(), 200, await response.text());
    assert.equal(await page.locator(".request-outcome-action .api-path").textContent(), "/me/messages?Source=Current");
    assert.equal(await page.locator(".journey-item > .action-fields .api-path").textContent(), "/me/messages?Source=Current");
    await page.locator(".request-outcome .returned-api-details > summary").click();
    assert.equal(await page.locator(".request-outcome .api-result-entry .api-path").textContent(), "/me/messages?Source=Returned");
    assert.equal(await page.locator(".full-request-results [data-result-layer=tool] .result-unit").textContent(), "1 Work IQ tool call");
    assert.doesNotMatch(await page.locator(".request-outcome").innerText(), /Source=Older/);
});

test("returned-result pages retain every canonical entry without assigning the first target to the rest", { timeout: 30000 }, async t => {
    const record = source("many-results");
    record.toolCalls[0].apiResults = Array.from({ length: 8 }, (_, index) => ({
        index, path: `/me/messages/{Result-${index}}?Exact=%2F`,
        statusCode: index % 3 === 0 ? 204 : index % 3 === 1 ? 429 : null,
    }));
    const { page, url } = await setup(t, [record]);
    await page.goto(url + "#request?request=many-results"); await ready(page);
    const summary = page.locator(".request-outcome");
    assert.deepEqual(await outcomes(summary.locator(".full-request-results [data-result-layer=reported-api]")), { success: 3, failure: 3, unknown: 2 });
    await summary.locator(".returned-api-details > summary").click();
    assert.equal(await summary.locator(".api-result-entry").count(), 6);
    assert.deepEqual(await summary.locator(".api-result-entry code.api-path").allTextContents(), record.toolCalls[0].apiResults.slice(0, 6).map(result => result.path));
    const next = summary.getByRole("button", { name: "Next returned results", exact: true });
    await next.focus(); await page.keyboard.press("Enter");
    assert.deepEqual(await summary.locator(".api-result-entry code.api-path").allTextContents(), record.toolCalls[0].apiResults.slice(6).map(result => result.path));
    assert.deepEqual(await outcomes(summary.locator(".full-request-results [data-result-layer=reported-api]")), { success: 3, failure: 3, unknown: 2 });
    await summary.getByRole("button", { name: "Previous returned results", exact: true }).click();
    assert.equal(await summary.locator(".api-result-entry").count(), 6);
});

test("result hierarchy and literal paths reflow in both themes at all widths and enlarged text", { timeout: 90000 }, async t => {
    const simple = source("simple"), long = source("long", longPath);
    const { page, url } = await setup(t, [simple, long]);
    const proofs = process.env.WORKIQ_RESULT_PROOFS, metrics = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const request of [simple, long]) {
        await page.goto(url + "#request?request=" + request.scenarioId); await ready(page);
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
            await chooseTheme(page, theme);
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
            const card = page.locator(".request-outcome");
            const geometry = await card.evaluate(node => {
                const code = node.querySelector("code.api-path"), box = code.getBoundingClientRect(), range = document.createRange();
                const clipped = [];
                for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(code.textContent)) {
                    range.setStart(code.firstChild, part.index); range.setEnd(code.firstChild, part.index + part.segment.length);
                    for (const glyph of range.getClientRects()) if (glyph.left < box.left - 1 || glyph.right > box.right + 1 || glyph.top < box.top - 1 || glyph.bottom > box.bottom + 1) clipped.push(part.index);
                }
                const style = getComputedStyle(code);
                return { clipped, width: box.width, height: box.height, cardHeight: node.getBoundingClientRect().height,
                    pageOverflow: document.documentElement.scrollWidth - innerWidth,
                    font: style.fontFamily, size: style.fontSize, weight: style.fontWeight,
                    pathColor: style.color, pathBackground: style.backgroundColor,
                    badFields: [...node.querySelectorAll("dt,dd,.result-description,.recorded-result")].filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.className) };
            });
            assert.equal(await card.locator("code.api-path").textContent(), request.toolCalls[0].requestArgs.entityUrls[0]);
            assert.deepEqual(geometry.clipped, [], `${request.scenarioId}/${theme}/${width}/${scale}: retained glyphs must not clip`);
            assert.deepEqual(geometry.badFields, [], `${theme}/${width}/${scale}: fields and result capsules must not overflow`);
            assert.ok(geometry.pageOverflow <= 1);
            assert.equal(await card.locator("not-markup").count(), 0);
            assert.equal(await card.locator("code.api-path").evaluate(node => node.closest("button,a") === null && getComputedStyle(node).userSelect === "text"), true);
            const shared = await page.locator("#requestContent code.api-path").evaluateAll(nodes => nodes.map(n => {
                const s = getComputedStyle(n); return [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight];
            }));
            assert.deepEqual(shared[0], shared[1], "Summary and timeline share one API-path typography role");
            metrics.push({ request: request.scenarioId, theme, viewport: width, scale, ...geometry });
            if (proofs && (request === simple || width === 375)) await card.screenshot({ path: path.join(proofs, `${request.scenarioId}-${theme}-${width}-${scale * 100}.png`) });
        }
    }
    if (proofs) await writeFile(path.join(proofs, "result-layout.json"), JSON.stringify(metrics, null, 2));
});
