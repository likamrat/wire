import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { fixture, chooseTheme, selectActivityOption, automaticScoreOffSummary, revealStoredRefresh, exportCatalogFor } from "./helpers.mjs";
import { scopeRecords, privateQuery } from "./analysis-scope-fixture.mjs";
import { contrast, measureChartPaint } from "./color-measurements.mjs";
import { chooseReportScope } from "./report-journey-helpers.mjs";

const proofs = process.env.WIRE_BREAKDOWN_PROOFS;
const sorted = values => [...values].sort();
const routeState = url => Object.fromEntries(new URLSearchParams(new URL(url).hash.split("?")[1]));
const ready = async page => {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
};
function records() {
    const extra = fixture("breakdown-coverage");
    extra.userPrompt = { text: `${privateQuery} invented coverage`, status: "full", authorship: { actor: "user", basis: "source-user" } };
    extra.followUpPrompts = [];
    extra.toolCalls = [
        ["workiq-fetch", ["/me/drive/root", "/unrecognized-resource"]],
        ["workiq-call_function", ["https://untrusted.example.invalid/me/drive/root"]],
        ["workiq-get_schema", ["/me/drive/root"]],
        ["workiq-retrieve", []],
    ].map(([tool, paths], i) => ({
        tool, toolCallId: `coverage-${i}`, startEventId: `coverage-start-${i}`,
        requestArgs: paths.length ? { entityUrls: paths } : {}, startedAt: "2026-09-30T12:00:00.000Z",
        reportedOutcome: "partial", apiResults: [],
    }));
    return [...scopeRecords(), extra];
}
async function setup(t, source = records()) {
    const original = structuredClone(source), requests = [], errors = [], denied = [];
    let last, fail = false, corrupt = false, activeSource = source, revision = 1;
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html");
            res.end(renderHtmlShell("a".repeat(64), "breakdown-fixture")); return;
        }
        let body = ""; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body || "{}");
        requests.push({ route: req.url, input });
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST" && req.url === "/api/snapshot") {
            if (fail) { res.writeHead(503); res.end('{"error":"Invented read failure"}'); return; }
            last = buildActivityAnalytics(activeSource, input);
            if (corrupt) last.serviceInvolvement.definition = { ...last.serviceInvolvement.definition, version: 2 };
            res.end(JSON.stringify({ revision, scenarios: activeSource, exports: [], exportCatalog: exportCatalogFor(activeSource),
                requestActivity: buildRequestActivity(activeSource), coverage: { notes: [] }, analytics: { ...last, revision } }));
        } else if (req.method === "POST" && req.url === "/api/evaluation/automatic/summary") {
            res.end(JSON.stringify(automaticScoreOffSummary()));
        } else {
            denied.push(req.url); res.writeHead(403); res.end('{"error":"Invented read-only fixture only."}');
        }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC", locale: "en-US", reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== url) { denied.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(source, original); assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        assert.doesNotMatch(JSON.stringify(requests), new RegExp(privateQuery));
    });
    await page.goto(url + "/#analyze?mode=calls&bucket=day"); await ready(page);
    return { page, url, source, requests, analytics: () => last, fail: value => { fail = value; }, corrupt: value => { corrupt = value; },
        change: value => { activeSource = value; revision++; } };
}
async function capture(page, name, selector = ".percentage-section") {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(proofs, name + ".png"), clip: await page.locator(selector).boundingBox(), fullPage: true });
    await writeFile(path.join(proofs, name + ".txt"), await page.locator(selector).ariaSnapshot());
}
async function visibleIds(page) {
    return sorted(await page.locator("#activityList .matched-action").evaluateAll(nodes => nodes.map(node => node.dataset.actionId)));
}
const card = (page, kind) => page.locator(`[data-percentage-card="${kind}"]`);

test("normal renderer shows Tools and Services together with exact involvement, gaps, preparation and flat geometry", async t => {
    const { page, analytics } = await setup(t);
    const total = analytics().totals.count;
    assert.equal(total, 16);
    await expect(card(page, "tools")).toBeVisible(); await expect(card(page, "services")).toBeVisible();
    assert.equal(await page.locator('[data-percentage-mode]').count(), 0, "Tools never replace Services");
    assert.equal(await card(page, "services").locator("svg.percentage-ring").count(), 0);
    await expect(card(page, "services")).toContainText("3 with missing service details (1 also have known services)");
    await expect(card(page, "services")).toContainText("1 discovery / preparation; not service execution");
    await expect(card(page, "services")).toContainText("1 Search by tool purpose");
    for (const text of ["Not in this record", "Path not recognized", "Target format not supported"]) await expect(card(page, "services")).toContainText(text);
    const serviceRows = await card(page, "services").locator(".percentage-legend-row").evaluateAll(nodes => nodes.map(node => ({
        id: node.dataset.category, count: Number(node.dataset.count), fraction: Number(node.querySelector(".percentage-bar").dataset.fraction),
    })));
    for (const row of serviceRows) {
        const group = analytics().serviceInvolvement.groups.find(group => group.label === row.id);
        assert.equal(row.count, group.total); assert.equal(row.fraction, group.total / total);
    }
    assert.equal(serviceRows.some(row => ["Unknown", "Multiple workloads", "Discovery"].includes(row.id)), false);
    assert.equal(await page.locator("#percentageCharts .percentage-outer-wall,#percentageCharts .percentage-glint").count(), 0);
    await expect(card(page, "outcomes").locator(".percentage-ring")).toHaveAttribute("data-visual-scale", "linear");
    for (const kind of ["tools", "services", "outcomes"]) {
        const summary = card(page, kind).locator("summary");
        const before = await summary.evaluate(node => node.getBoundingClientRect().y + scrollY);
        await summary.click();
        await expect(card(page, kind).locator("table")).toBeVisible();
        const after = await summary.evaluate(node => node.getBoundingClientRect().y + scrollY);
        assert.ok(Math.abs(after - before) < 1, "Exact data expands below the stationary disclosure trigger");
        const exact = await card(page, kind).locator("tbody tr").count();
        assert.ok(exact > 0);
        await expect(card(page, kind).locator("caption")).toContainText(`${total} Work IQ tool calls`);
        const exactLink = card(page, kind).locator("tbody .percentage-label[href]").first();
        await expect(exactLink).toHaveAttribute("href", /^#analyze/);
        const target = await exactLink.boundingBox(); assert.ok(target.width >= 44 && target.height >= 44);
        await card(page, kind).locator("summary").click();
    }
    const partial = card(page, "outcomes").locator('.percentage-slice[data-category="partial"]');
    await partial.scrollIntoViewIfNeeded();
    const point = await partial.evaluate(node => {
        const box = node.closest("svg").getBoundingClientRect();
        const angle = (Number(node.dataset.start) + Number(node.dataset.end)) / 2 * 2 * Math.PI + Math.PI / 2;
        return { x: box.x + (120 + 85 * Math.cos(angle)) / 240 * box.width, y: box.y + (120 + 85 * Math.sin(angle)) / 240 * box.height };
    });
    const partialIds = analytics().rows.filter(row => row.outcome === "partial").map(row => row.id);
    await page.mouse.click(point.x, point.y); await ready(page);
    assert.deepEqual(await visibleIds(page), sorted(partialIds));
    await page.goBack(); await ready(page);
    for (const selector of ['[data-percentage-card="tools"] .percentage-bar-track', '.percentage-ring a']) {
        const allowed = await page.locator(selector).first().evaluate(node => {
            let prevented;
            node.addEventListener("click", event => { prevented = event.defaultPrevented; event.preventDefault(); }, { once: true });
            node.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true, cancelable: true }));
            return !prevented && node.getAttribute("href").startsWith("#analyze");
        });
        assert.ok(allowed, "Native modified links retain their destination and do not invoke the unmodified filter action");
    }
    for (const chart of ["workload", "endpoint"]) {
        await page.locator(`[data-chart="${chart}"]`).click(); await ready(page);
        assert.ok(await page.locator(".flat-comparison-action").count() > 0);
        assert.equal(await page.locator("#chart svg,#chart .dimensional-ground").count(), 0);
        const measures = await page.locator(".flat-comparison-track").evaluateAll(nodes => nodes.map(track => ({
            width: track.getBoundingClientRect().width, maximum: Number(track.closest(".flat-comparison").dataset.maximum),
            parts: [...track.children].map(mark => ({ count: Number(mark.dataset.count), width: mark.getBoundingClientRect().width })),
        })));
        for (const row of measures) for (const part of row.parts) assert.ok(Math.abs(part.width - row.width * part.count / row.maximum) < .02);
        if (chart === "endpoint") {
            const segment = page.locator(".flat-comparison-segment").first();
            const count = await segment.getAttribute("data-count"), total = analytics().groups[0].total;
            await segment.hover();
            await expect(page.getByRole("tooltip")).toContainText(`${count} of ${total} Work IQ tool calls`);
            await page.keyboard.press("Escape");
            await expect(page.getByRole("tooltip")).toBeHidden();
        }
        const index = analytics().groups.findIndex(group => group.total <= 8);
        const expected = analytics().groups[index].drilldownIds, origin = page.url();
        await page.locator(".flat-comparison-action").nth(index).click(); await ready(page);
        assert.deepEqual(sorted(analytics().rows.map(row => row.id)), sorted(expected));
        assert.deepEqual(await visibleIds(page), sorted(expected));
        await page.goBack(); await ready(page); assert.deepEqual(routeState(page.url()), routeState(origin));
        await expect(page.locator(".flat-comparison-action").nth(index)).toBeFocused();
        await page.locator("#tableDisclosure > summary").click();
        await expect(page.locator("#countTable table")).toBeVisible();
        await page.locator("#tableDisclosure > summary").click();
        await capture(page, `comparison-${chart}`, ".chart-panel");
    }
});

test("tool/service/outcome links and context removal keep private search, dates, author union, outcome union and Back selection", async t => {
    const { page, url, source, requests, analytics } = await setup(t);
    await page.goto(url + "/#analyze?mode=calls&range=custom&from=2026-09-30&to=2026-09-30&authors=user&result=failure,success"); await ready(page);
    await page.locator("#activitySearch").fill(privateQuery); await ready(page);
    await selectActivityOption(page, "serviceAssociationFilter", "Files"); await ready(page);
    await expect(page.locator("#serviceFocusScope")).toContainText("context-only");
    const matchingScenarios = new Set(source.filter(record => record.userPrompt.text.includes(privateQuery)).map(record => record.scenarioId));
    const before = analytics().rows.filter(row => matchingScenarios.has(row.scenarioId));
    const known = before.filter(row => row.serviceAssociation.services.includes("Files"));
    await page.locator('[data-analyze-mode="interactions"]').click(); await ready(page);
    const selected = page.locator('.request-row[data-view-key="request:parity-request-0"] input');
    await selected.check();
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    const selectionSummary = await page.locator("#activitySelectionSummary").textContent();
    for (const [kind, category, expected] of [
        ["tools", "tool:workiq-ask", before.filter(row => row.tool === "workiq-ask")],
        ["services", "Files", known],
        ["outcomes", "failure", before.filter(row => row.outcome === "failure")],
    ]) {
        const action = card(page, kind).locator(`.percentage-legend-row[data-category="${category}"] .percentage-label`);
        const origin = page.url(); await action.focus(); await page.keyboard.press("Enter"); await ready(page);
        assert.deepEqual(await visibleIds(page), sorted(expected.map(row => row.id)));
        await expect(page.locator("#activitySearch")).toHaveValue(privateQuery);
        assert.doesNotMatch(page.url(), new RegExp(privateQuery));
        const filters = requests.findLast(request => request.route === "/api/snapshot").input.filters;
        assert.deepEqual(filters.promptAuthors, ["user"]);
        assert.equal(filters.from, "2026-09-30"); assert.equal(filters.to, "2026-09-30");
        assert.equal(analytics().serviceInvolvement.selection.includeMissingService, true, "Server scope is retained");
        if (kind === "services") {
            assert.equal(routeState(page.url()).withinServices, "Files");
            await expect(page.locator("#serviceFocusScope")).toContainText("0 context-only");
        }
        await page.goBack(); await ready(page); assert.deepEqual(routeState(page.url()), routeState(origin));
        await expect(action).toBeFocused();
        await expect(page.locator("#activitySelectionSummary")).toHaveText(selectionSummary);
    }
    await page.getByRole("button", { name: "Remove missing-service context", exact: true }).click(); await ready(page);
    assert.deepEqual(await visibleIds(page), sorted(known.map(row => row.id)));
    await expect(page.locator("#addServiceContext")).toBeVisible();
    await page.goBack(); await ready(page);
    assert.deepEqual(await visibleIds(page), sorted(before.map(row => row.id)));
    await page.locator('[data-analyze-mode="interactions"]').click(); await ready(page);
    await expect(selected).toBeChecked();
});

test("Files-to-Mail chart action cannot admit Mail-only rows; removal, Back, revisions and report membership share the refinement", async t => {
    const source = [fixture("overlap"), fixture("mail-only"), fixture("files-only")];
    source[0].toolCalls[0].requestArgs = { entityUrls: ["/me/drive/root", "/me/messages"] };
    source[1].toolCalls[0].requestArgs = { entityUrls: ["/me/messages"] };
    source[2].toolCalls[0].requestArgs = { entityUrls: ["/me/drive/root"] };
    for (const row of source) delete row.toolCalls[0].requestedApiPath;
    source[0].toolCalls.push({ ...source[0].toolCalls[0], toolCallId: "overlap-context", startEventId: "overlap-context",
        requestArgs: { entityUrls: ["/teams"] } });
    const { page, change, requests } = await setup(t, source);
    await selectActivityOption(page, "serviceAssociationFilter", "Files"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("2");
    const mail = card(page, "services").locator('[data-category="Mail"] .percentage-label');
    await mail.focus(); await page.keyboard.press("Enter"); await ready(page);
    assert.deepEqual(await visibleIds(page), ['call:["test-session","test-call-overlap"]']);
    await expect(page.locator("#filterChips")).toContainText("Mail within current scope");
    await expect(page.locator("#activityCount")).toHaveText("1");
    assert.deepEqual(await card(page, "services").locator(".percentage-legend-row").evaluateAll(nodes => nodes.map(row => row.dataset.percentage)), ["100%", "100%"]);
    assert.deepEqual(requests.findLast(request => request.route === "/api/snapshot").input.filters.services, ["Files"]);
    await page.getByRole("button", { name: "Remove service chart refinement: Mail", exact: true }).click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("2");
    await page.goBack(); await ready(page); await expect(page.locator("#activityCount")).toHaveText("1");
    await page.locator("#pageAction").click(); await ready(page);
    await chooseReportScope(page, "current");
    await expect(page.locator("#scopeSummary")).toContainText("1 request group: 2 Work IQ tool calls");
    await page.goBack(); await ready(page);
    const next = structuredClone(source);
    next[2].toolCalls[0].requestArgs = { entityUrls: ["/me/drive/root", "/me/messages"] };
    change(next); await (await revealStoredRefresh(page)).click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("2");
    assert.deepEqual(await visibleIds(page), sorted(['call:["test-session","test-call-overlap"]', 'call:["test-session","test-call-files-only"]']));
    assert.equal(routeState(page.url()).withinServices, "Mail", "Refinement is recomputed, not a frozen ID list");
    await expect(page.locator("#percentageCharts .percentage-section")).toHaveAttribute("data-revision", "2");
    await page.locator("#pageAction").click(); await ready(page);
    await chooseReportScope(page, "current");
    await expect(page.locator("#scopeSummary")).toContainText("2 request groups: 3 Work IQ tool calls");
    await page.goBack(); await ready(page);
    await selectActivityOption(page, "serviceAssociationFilter", "Mail"); await ready(page);
    assert.equal(routeState(page.url()).withinServices, undefined, "An explicit menu choice replaces chart refinements, keeping menu OR semantics");
    await expect(page.locator("#activityCount")).toHaveText("3");
    assert.ok(requests.every(request => !Object.hasOwn(request.input.filters || {}, "withinServices")), "Chart refinement stays in the existing local slice");
});

test("desktop and narrow 200% light/dark retain full labels, exact shares, contrast and 44px keyboard equivalents", async t => {
    const { page } = await setup(t);
    const evidence = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: width < 600 ? 1800 : 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale); await ready(page);
        const tools = await card(page, "tools").boundingBox(), services = await card(page, "services").boundingBox();
        if (width === 1200) { assert.ok(Math.abs(tools.y - services.y) < 1); assert.ok(services.x >= tools.x + tools.width); }
        else assert.ok(services.y >= tools.y + tools.height);
        const rows = await page.locator(".percentage-label[href]").evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => {
            const box = node.getBoundingClientRect(), css = getComputedStyle(node);
            return { text: node.textContent, width: box.width, height: box.height, scroll: node.scrollWidth, client: node.clientWidth,
                color: css.color, background: getComputedStyle(node.closest(".percentage-card")).backgroundColor };
        }));
        for (const row of rows) {
            assert.ok(row.width >= 44 && row.height >= 44, row.text);
            assert.ok(row.scroll <= row.client + 1, row.text); assert.ok(contrast(row.color, row.background) >= 4.5, row.text);
        }
        const textColors = await page.locator(".percentage-section h2,.percentage-section h3,.percentage-scope,.percentage-denominator,.percentage-service-scope,.percentage-coverage p,.percentage-gap-list dt,.percentage-gap-list dd,.percentage-value").evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => {
            let parent = node;
            while (parent && getComputedStyle(parent).backgroundColor === "rgba(0, 0, 0, 0)") parent = parent.parentElement;
            return { text: node.textContent, color: getComputedStyle(node).color, background: getComputedStyle(parent).backgroundColor };
        }));
        for (const row of textColors) assert.ok(contrast(row.color, row.background) >= 4.5, row.text);
        const marks = await page.evaluate(measureChartPaint, ".percentage-slice,.percentage-bar");
        for (const mark of marks) {
            assert.ok(mark.local && mark.gradient && mark.colors.length === 2, "Each mark uses a local two-stop fade");
            for (const color of mark.colors) assert.ok(contrast(color, mark.background) >= 3, `${theme}: visible entire data fade`);
        }
        await page.keyboard.press("Tab");
        const target = card(page, "services").locator(".percentage-label[href]").first();
        await target.focus(); await expect(target).toBeFocused();
        assert.notEqual(await target.evaluate(node => getComputedStyle(node).outlineStyle), "none");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        evidence.push({ theme, width, scale, rows, textColors, marks, tools, services });
        await capture(page, `${theme}-${width}-text${scale}`);
        if (width === 375) {
            await card(page, "services").locator("summary").click(); await expect(card(page, "services").locator("table")).toBeVisible();
            assert.equal(await card(page, "services").locator("table").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
            await capture(page, `${theme}-${width}-text${scale}-exact`, '[data-percentage-card="services"]');
            await card(page, "services").locator("summary").click();
        }
        await page.locator('[data-chart="endpoint"]').click(); await ready(page);
        await page.keyboard.press("Tab");
        await page.locator(".flat-comparison-action").first().focus();
        const actions = await page.locator(".flat-comparison-action").evaluateAll(nodes => nodes.map(node => {
            const box = node.getBoundingClientRect();
            return { width: box.width, height: box.height, scroll: node.scrollWidth, client: node.clientWidth,
                color: getComputedStyle(node).color, background: getComputedStyle(node.closest(".chart-panel")).backgroundColor };
        }));
        for (const action of actions) {
            assert.ok(action.height >= 44 && action.width >= 44);
            assert.ok(action.scroll <= action.client + 1); assert.ok(contrast(action.color, action.background) >= 4.5);
        }
        evidence.at(-1).operations = actions;
        assert.notEqual(await page.locator(".flat-comparison-action").first().evaluate(node => getComputedStyle(node).outlineStyle), "none");
        await capture(page, `${theme}-${width}-text${scale}-operations`, ".chart-panel");
        await page.locator('[data-chart="time"]').click(); await ready(page);
    }
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    assert.equal(await page.locator(".percentage-bar").first().evaluate(node => getComputedStyle(node).backgroundColor), "rgb(0, 0, 0)");
    if (proofs) await writeFile(path.join(proofs, "measurements.json"), JSON.stringify(evidence, null, 2));
});

test("zero, tiny, empty and incompatible snapshots never fabricate a share or replace accepted results", async t => {
    const row = fixture("breakdown-extreme"), base = row.toolCalls[0];
    row.toolCalls = Array.from({ length: 1001 }, (_, i) => ({
        ...base, toolCallId: `extreme-${i}`, startEventId: `extreme-start-${i}`,
        tool: i ? "workiq-fetch" : "workiq-call_function",
        toolSucceeded: i !== 0, reportedOutcome: i ? "succeeded" : "failed",
    }));
    const { page, fail, corrupt } = await setup(t, [row]);
    const tiny = card(page, "outcomes").locator('[data-category="failure"].percentage-slice');
    const bounds = await tiny.evaluate(node => [Number(node.dataset.start), Number(node.dataset.end), Number(node.dataset.exactFraction)]);
    assert.ok(Math.abs(bounds[1] - bounds[0] - 1 / 1001) < 1e-15);
    assert.equal(bounds[2], 1 / 1001);
    await expect(card(page, "outcomes").locator('.percentage-legend-row[data-category="failure"]')).toContainText("<0.1%");
    await expect(card(page, "outcomes").locator('.percentage-legend-row[data-category="unknown"]')).toContainText("0%");
    await capture(page, "extreme-light");
    await card(page, "tools").locator("summary").click();
    await expect(card(page, "tools").locator("table")).toBeVisible();
    const content = await card(page, "tools").innerText();
    fail(true); await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.equal(await card(page, "tools").innerText(), content);
    fail(false); corrupt(true); await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.equal(await card(page, "tools").innerText(), content);
    await expect(page.locator("#collectionNotice")).toBeVisible();
    corrupt(false); await (await revealStoredRefresh(page)).click(); await ready(page);
    await page.locator("#activitySearch").fill("NO_BREAKDOWN_MATCH"); await ready(page);
    await expect(page.locator(".percentage-section")).toHaveAttribute("data-total", "0");
    assert.equal(await page.locator(".percentage-slice,.percentage-bar").count(), 0);
    await expect(card(page, "tools")).toContainText("Percentages are not applicable");
    await expect(card(page, "tools").locator("tfoot")).toContainText("Not applicable");
    await capture(page, "empty-light");
});

test("returned entries keep their own unit and accepted target refinement while empty code references invent no calls", async t => {
    const { page, analytics } = await setup(t);
    await selectActivityOption(page, "layerFilter", "reported-api"); await ready(page);
    await expect(card(page, "services").locator(".percentage-denominator")).toHaveText("(tool-returned API results)");
    await expect(page.locator(".percentage-section")).toHaveAttribute("data-total", String(analytics().totals.count));
    const group = analytics().serviceInvolvement.groups.find(group => group.label === "Mail");
    await card(page, "services").locator('[data-category="Mail"] .percentage-bar').click(); await ready(page);
    await expect(page.locator(".percentage-section")).toHaveAttribute("data-total", String(group.total));
    assert.deepEqual(await visibleIds(page), sorted(group.drilldownIds));
    await expect(card(page, "services").locator(".percentage-denominator")).toHaveText("(tool-returned API result)");
    await expect(page.locator("#takeaway")).toContainText("1 of 1 Work IQ tool calls");
    await selectActivityOption(page, "layerFilter", "code-reference"); await ready(page);
    await expect(page.locator(".percentage-section")).toHaveAttribute("data-total", "0");
    await expect(card(page, "outcomes")).toContainText("Percentages are not applicable");
    assert.equal(await page.locator(".percentage-slice,.percentage-bar").count(), 0);
});
