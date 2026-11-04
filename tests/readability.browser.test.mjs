import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture as sourceFixture, exportCatalogFor, chooseTheme, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";

const endpoints = ["/me/messages", "/me/events", "/me/drive", "/teams", "/me/people", "/planner/tasks", "/search/query", "/unknown"];
const records = endpoints.map((endpoint, i) => {
    const record = sourceFixture(`readability-${i}`);
    record.sourceSessionName = "Synthetic readability examples";
    record.toolCalls[0] = {
        ...record.toolCalls[0], requestedApiPath: endpoint, requestArgs: { entityUrls: [endpoint] },
        startedAt: `2026-09-${i < 4 ? "01" : "03"}T12:00:00Z`,
        toolSucceeded: i % 3 === 0 ? true : i % 3 === 1 ? false : null,
        reportedOutcome: i === 7 ? "partial" : i % 3 === 0 ? "succeeded" : i % 3 === 1 ? "failed" : "unknown",
        apiResults: [{ index: 0, statusCode: [200, 429, null, 302][i % 4] }],
    };
    return record;
});
records[0].graphActivities = [200, 429, 302, null, "code"].map((status, i) => ({
    activityId: `readability-graph-${i}`, sourceSessionId: records[0].sourceSessionId,
    scenarioId: records[0].scenarioId, toolCallId: `readability-shell-${i}`, startEventId: `readability-start-${i}`,
    startedAt: "2026-09-03T12:00:00Z", tool: "shell",
    evidenceLevel: status === "code" ? "code-reference" : status === null ? "requested-direct-graph" : "output-visible-http",
    endpoint: { path: "/me/messages", method: "GET", apiVersion: "v1.0", queryShape: [] },
    workload: "Mail", method: "GET", httpStatus: typeof status === "number" ? status : null,
    statusBasis: typeof status === "number" ? "explicit-output-status" : "none",
    requestCount: null, countUnit: "recorded-request-site", confidence: "high", synthetic: false,
    sourceKind: "inline-command", requestBasis: "request-command",
    fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: false }, evidenceRefs: [],
}));
records[0].httpRecords = [200, 503, 302, null].map((status, i) => ({
    recordId: `readability-http-${i}`, classification: "direct-graph-http", synthetic: false,
    sourceSessionId: records[0].sourceSessionId, observedGraphHttp: status !== null,
    startedAt: "2026-09-03T12:00:00Z", status, transportError: status === null ? "TimeoutError" : null,
    responseOrigin: status === null ? null : "https://graph.microsoft.com", apiVersion: "v1.0",
    method: "GET", responsePath: { path: "/$metadata", query: [] },
}));
const coverage = {
    since: "2026-09-01", until: "2026-09-30", checkedAt: "2026-10-01T12:00:00Z",
    graphHistory: { counts: { sourcesScanned: 8, sourcesRequested: 10, requestedDirectSites: 4, outputVisibleStatuses: 3, codeReferences: 1, syntheticReferences: 2 } },
    notes: [
        "Source roster reports missing logs; coverage is not a complete history claim.",
        "Graph scan limitation: unresolved network target (5).",
        "Graph scan limitation: source reference not execution (1).",
        "SYNTHETIC source note <script>must remain text, never markup</script>.",
    ],
};
records[0].toolCalls[0].apiResults.push({ index: 1, errorCode: "SYNTHETIC_ERROR_WITHOUT_HTTP_STATUS" });
const proofDir = process.env.WORKIQ_READABILITY_PROOFS;

async function fixture(run, source = records, sourceCoverage = coverage) {
    const original = structuredClone(source), requests = [], errors = [];
    let last;
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.end(renderHtmlShell("a".repeat(64), "readability-fixture", UNBOUND_FIXTURE_BOOTSTRAP));
            return;
        }
        requests.push(req.url);
        let text = ""; for await (const part of req) text += part;
        const input = JSON.parse(text);
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/snapshot") {
            last = buildActivityAnalytics(source, input);
            res.end(JSON.stringify({ revision: 1, scenarios: source, exports: [], coverage: sourceCoverage, exportCatalog: exportCatalogFor(source), analytics: { ...last, revision: 1 } }));
        } else {
            res.statusCode = 403;
            res.end('{"error":"Readability fixture permits snapshot reads only."}');
        }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch(), context = await browser.newContext({ timezoneId: "America/Los_Angeles", locale: "en-US", reducedMotion: "reduce" });
    context.setDefaultTimeout(5000);
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    await context.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw new Error("No clipboard reads in readability proof."); },
        writeText() { throw new Error("No clipboard writes in readability proof."); },
    } }));
    try {
        if (proofDir) await mkdir(proofDir, { recursive: true });
        await run({ context, url: `http://127.0.0.1:${server.address().port}`, current: () => last });
        assert.deepEqual(source, original, "Rendering cannot rewrite source evidence");
        assert.deepEqual(errors, []);
        assert.ok(requests.every(route => route === "/api/snapshot"));
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
}
async function expand(page) {
    for (const id of ["meaning", "serviceDefinitions", "tableDisclosure", "coverage"]) {
        if (!await page.locator(`#${id}`).isVisible()) continue;
        if (!await page.locator(`#${id}`).evaluate(node => node.open)) {
            await page.locator(`#${id}>summary`).focus();
            await page.keyboard.press("Enter");
        }
    }
}

test("expanded reading sections use clear hierarchy, bounded text and aligned numbers in both themes at 375/820/1200/1440", { timeout: 60000 }, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage(), measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(url); await ready(page); await expand(page);
        await chooseTheme(page, theme);
        assert.equal(await page.locator("#coverage details").count(), 0);
        assert.equal(await page.locator("#collectionSetup").evaluate(node => node.open), false);
        assert.match(await page.locator("#coverageNotice").innerText(), /unavailable Copilot chat history may leave gaps.*hosted Work IQ.*not visible in local logs/);
        assert.deepEqual(await page.locator(".evidence-notes li").allTextContents(), [
            ...buildActivityAnalytics(records).warnings.filter(w => w.code !== "tool-not-http").map(w => w.message), ...coverage.notes,
        ]);
        assert.equal(await page.locator("#collectionEvidenceDetails script").count(), 0);
        assert.equal(await page.locator("#coverageBody #meaningText").count(), 0);
        const measure = await page.evaluate(() => {
            const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width, height: r.height }; };
            const bg = getComputedStyle(document.body).backgroundColor;
            const lum = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
            const sample = selector => [...document.querySelectorAll(selector)].map(node => {
                const s = getComputedStyle(node);
                return { size: parseFloat(s.fontSize), line: parseFloat(s.lineHeight), weight: Number(s.fontWeight), align: s.textAlign, tabular: s.fontVariantNumeric, contrast: (Math.max(lum(s.color), lum(bg)) + .05) / (Math.min(lum(s.color), lum(bg)) + .05), ...rect(node) };
            });
            return {
                overflow: document.documentElement.scrollWidth - innerWidth,
                headings: sample(".reading-section>summary"),
                text: sample("#meaning p,#meaning dd,#serviceDefinitions dd,#coverageBody p,.evidence-notes li"),
                numeric: sample(".exact-data-table .numeric"),
                definitions: sample(".glossary-entry"), glossary: rect(document.querySelector("#serviceDefinitions")),
                caption: rect(document.querySelector("#countTable caption")), tableRegion: rect(document.querySelector("#countTable")),
                scroll: document.querySelector("#countTable").scrollWidth - document.querySelector("#countTable").clientWidth,
            };
        });
        assert.ok(measure.overflow <= 1);
        assert.ok(measure.headings.every(h => h.size >= 18 && h.weight >= 600));
        assert.ok(measure.text.every(p => p.size >= 16 && p.line / p.size >= 1.5 && p.contrast >= 4.5));
        assert.ok(measure.text.every(p => p.width <= 65 * 16), "Prose has a bounded reading measure");
        assert.ok(measure.numeric.every(c => c.size >= 14 && c.align === "center" && c.tabular.includes("tabular-nums") && c.contrast >= 4.5));
        const columns = await page.locator("#countTable tr").evaluateAll(rows => rows.map(r => [...r.querySelectorAll(".numeric")].map(n => n.getBoundingClientRect().right)));
        assert.ok(columns.every(row => row.every((right, i) => Math.abs(right - columns[0][i]) < 1)));
        assert.ok(measure.caption.width <= measure.tableRegion.width + 1, "Unit and timezone caption wrap within the visible region");
        if (width === 375) assert.ok(measure.scroll > 0, "Only the exact table scrolls");
        else assert.equal(new Set(measure.definitions.map(d => Math.round(d.x))).size, 2, "Glossary uses two deliberate columns");
        assert.doesNotMatch(await page.locator("#serviceDefinitions").innerText(), /identified in the recorded activity/);
        await page.locator("#countTable").evaluate(node => { node.scrollLeft = node.scrollWidth; });
        const captionLeft = await page.locator("#countTable caption").evaluate(node => node.getBoundingClientRect().left);
        assert.ok(captionLeft >= measure.tableRegion.x - 1, "The unit/zone stays visible while numeric columns scroll");
        await page.locator("#countTable").evaluate(node => { node.scrollLeft = 0; });
        if (proofDir) {
            await page.screenshot({ path: path.join(proofDir, `readability-${theme}-${width}-expanded.png`), fullPage: true });
            await page.evaluate(() => window.scrollTo(0, document.querySelector("#meaning").getBoundingClientRect().top + scrollY - 100));
            await page.screenshot({ path: path.join(proofDir, `readability-${theme}-${width}-reading.png`) });
        }
        measurements.push({ theme, width, ...measure });
    }
    if (proofDir) await writeFile(path.join(proofDir, "readability-measurements.json"), JSON.stringify(measurements, null, 2));
}));

test("exact numeric columns reconcile all six activity layers, chart groups, gaps and keyboard drilldown", { timeout: 60000 }, async () => fixture(async ({ context, url, current }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 820, height: 950 });
    for (const layer of ["tool", "reported-api", "direct-request", "recorded-http", "http", "code-reference"]) for (const chart of ["time", "workload", "endpoint"]) {
        await page.goto(`${url}/#home?layer=${layer}&chart=${chart}&bucket=day`); await ready(page); await expand(page);
        const analytics = current(), groups = chart === "time" ? analytics.timeSeries.points : analytics.groups;
        const headers = await page.locator("#countTable thead th").allTextContents();
        assert.equal(headers[1], "Total");
        if (layer === "code-reference") assert.deepEqual(headers.slice(1), ["Total"], "Code references have no invented outcome columns");
        else if (layer === "tool") assert.deepEqual(headers.slice(1), ["Total", "Tool completed", "Tool failed", "No result recorded", "Partial completion"]);
        else assert.ok(headers.includes("HTTP 2xx") && !headers.includes("Tool completed"));
        if (layer === "reported-api") {
            assert.ok(headers.includes("Error result") && headers.includes("No status / error"));
            assert.match(await page.locator("#countTable caption").innerText(), /or a reported error code/);
            assert.ok(analytics.rows.some(row => row.outcome === "failure" && row.status === null));
        }
        if (layer === "recorded-http") assert.ok(!headers.includes("No status"), "Visible-status subset cannot imply missing-status records");
        const numeric = await page.locator("#countTable tbody tr").evaluateAll(rows => rows.map(row => [...row.querySelectorAll(".numeric")].map(c => Number(c.textContent.replaceAll(",", "")))));
        assert.deepEqual(numeric.map(row => row[0]), groups.map(g => g.total));
        if (layer !== "code-reference") for (const row of numeric) assert.equal(row.slice(1).reduce((a, b) => a + b, 0), row[0]);
        const footer = await page.locator("#countTable tfoot .numeric").allTextContents();
        assert.equal(Number(footer[0]), groups.reduce((sum, g) => sum + g.total, 0));
        if (chart === "time") {
            assert.doesNotMatch(await page.locator("#countTable caption").innerText(), /America\/Los_Angeles/);
            assert.match(await page.locator("#displayTimeZone option:checked").textContent(), /America\/Los_Angeles/);
        }
        assert.deepEqual(await page.locator("#serviceDefinitions dt").allTextContents(), serviceCategories.used(analytics.workloadGroups.map(g => g.label)).map(e => e.label));
        const action = page.locator("#countTable .chart-data-action").first();
        await action.focus(); await page.keyboard.press("Enter"); await ready(page);
        assert.match(page.url(), /#activity/);
        assert.equal(current().totals.count, groups.find(g => g.total > 0).total);
        await page.goBack(); await ready(page);
    }
}));

test("unknown scan coverage and undated rows stay explicit; empty charts never invent rows", { timeout: 30000 }, async () => {
    const undated = sourceFixture("readability-undated");
    delete undated.capturedAt;
    await fixture(async ({ context, url }) => {
        const page = await context.newPage();
        await page.goto(url); await ready(page); await expand(page);
        assert.match(await page.locator("#countTable").innerText(), /No chart rows.*1 record without a date/s);
        assert.match(await page.locator("#collectionEvidenceDetails").textContent(), /Coverage is unknown, not zero/);
        assert.equal(await page.locator("#countTable table").count(), 0);
        await page.locator('[data-chart="workload"]').click(); await ready(page);
        assert.deepEqual(await page.locator("#countTable tbody td.numeric").allTextContents(), ["1", "1", "0", "0"]);
    }, [undated], { notes: [] });
    await fixture(async ({ context, url }) => {
        const page = await context.newPage();
        await page.goto(url); await ready(page); await expand(page);
        assert.equal(await page.locator("#serviceDefinitions").isVisible(), false);
        assert.equal(await page.locator("#countTable tr").count(), 0);
        assert.match(await page.locator("#countTable").innerText(), /No chart rows/);
    }, [], { notes: [] });
});
