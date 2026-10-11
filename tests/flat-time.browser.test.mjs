import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture, chooseTheme, selectActivityOption, automaticScoreOffSummary, restoreLegacySearch } from "./helpers.mjs";
import { scopeRecords, privateQuery } from "./analysis-scope-fixture.mjs";
import { rgb, contrast, measureChartPaint } from "./color-measurements.mjs";

const proofs = process.env.WIRE_TIME_PROOFS;
const ready = async page => {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
};
const sorted = values => [...values].sort();
function records() {
    return [
        ["2026-03-08T07:59:59Z", 1], ["2026-03-08T08:00:00Z", 4],
        ["2026-03-09T07:00:00Z", 1], ["2026-03-11T12:00:00Z", 2], [null, 1],
    ].map(([stamp, total], index) => {
        const row = fixture(`flat-time-${index}`);
        row.capturedAt = stamp;
        row.userPrompt = { text: `Invented time view ${index}`, status: "full",
            authorship: { actor: "user", basis: "source-user" }, sourceTimestamp: stamp };
        row.followUpPrompts = [];
        row.toolCalls = Array.from({ length: total }, (_, ordinal) => ({
            ...row.toolCalls[0], toolCallId: `time-call-${index}-${ordinal}`, startEventId: `time-start-${index}-${ordinal}`,
            startedAt: stamp, apiResults: [], toolSucceeded: ordinal === 1 ? false : ordinal === 3 ? undefined : true,
            reportedOutcome: ordinal === 1 ? "failed" : ordinal === 3 ? "unknown" : "succeeded",
        }));
        return row;
    });
}
async function setup(t, source = records(), zone = "America/Los_Angeles") {
    const original = structuredClone(source), requests = [], errors = [], denied = [];
    let last;
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html");
            res.end(renderHtmlShell("a".repeat(64), "flat-time-fixture")); return;
        }
        let body = ""; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body || "{}");
        requests.push({ route: req.url, input });
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST" && req.url === "/api/snapshot") {
            last = buildActivityAnalytics(source, input);
            res.end(JSON.stringify({ revision: 1, scenarios: source, exports: [], coverage: { notes: [] },
                analytics: { ...last, revision: 1 } }));
        } else if (req.method === "POST" && req.url === "/api/evaluation/automatic/summary") {
            res.end(JSON.stringify(automaticScoreOffSummary()));
        } else {
            denied.push(req.url); res.writeHead(403); res.end('{"error":"Only invented read-only fixtures are available."}');
        }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch(), page = await browser.newPage({
        viewport: { width: 1200, height: 1000 }, timezoneId: zone, locale: "en-US", reducedMotion: "reduce",
    });
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
    await page.goto(url + "/#analyze?bucket=day"); await ready(page);
    return { page, url, requests, analytics: () => last };
}
async function capture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.locator(".chart-panel").screenshot({ path: path.join(proofs, name + ".png") });
    await writeFile(path.join(proofs, name + ".txt"), await page.locator(".chart-panel").ariaSnapshot());
}

test("time view keeps readable exact labels, focus and 44px equivalents in both themes and narrow 200% text", async t => {
    const { page } = await setup(t);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: width < 600 ? 1800 : 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await ready(page);
        await page.keyboard.press("Tab");
        await page.locator(".time-column").first().focus();
        const measurements = await page.locator("#chart .dimensional-count").evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect(), ink = document.createRange(); ink.selectNodeContents(node);
            return { text: node.textContent, width: rect.width, height: rect.height,
                inkWidth: ink.getBoundingClientRect().width, font: parseFloat(getComputedStyle(node).fontSize) };
        }));
        assert.deepEqual(measurements.map(row => row.text), ["1 call", "4 calls", "1 call", "0 calls", "2 calls"]);
        assert.ok(measurements.every(row => row.height >= 44 && row.width >= row.inkWidth && row.font >= 16 * scale));
        assert.notEqual(await page.locator(".time-column .dimensional-count").first().evaluate(node => getComputedStyle(node).outlineStyle), "none");
        const colors = await page.evaluate(measureChartPaint, ".flat-time-segment");
        for (const color of colors) {
            assert.ok(color.local && color.gradient && color.colors.length === 2, "Each exact rectangle has its own local fade");
            for (const endpoint of color.colors) {
                const fill = rgb(endpoint), back = rgb(color.background);
                const painted = `rgb(${fill.map((channel, index) => channel * color.opacity + back[index] * (1 - color.opacity)).join(",")})`;
                assert.ok(contrast(painted, color.background) >= 3, `${theme}: the entire fade remains visible against its panel`);
            }
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await capture(page, `${theme}-${width}-text${scale}`);
        await page.locator(".time-column").last().focus();
        const visible = await page.locator(".time-column .dimensional-count").last().evaluate(node => {
            const box = node.getBoundingClientRect(), clip = node.closest(".dimensional-scroll").getBoundingClientRect();
            return box.left >= Math.max(0, clip.left) && box.right <= Math.min(innerWidth, clip.right);
        });
        assert.ok(visible, "Focus reveals the whole last exact-count action, not just a data sliver");
        if (!await page.locator("#tableDisclosure").evaluate(node => node.open)) await page.locator("#tableDisclosure > summary").click();
        assert.deepEqual(await page.locator("#countTable tbody td:nth-child(2)").allTextContents(), ["1", "4", "1", "0", "2"]);
        for (const action of await page.locator("#countTable .chart-data-action").all()) {
            const box = await action.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
        }
        await page.locator("#tableDisclosure > summary").click();
    }
    await page.setViewportSize({ width: 1200, height: 1000 }); await ready(page);
    await page.locator(".time-column").last().focus();
    await page.setViewportSize({ width: 375, height: 1800 }); await ready(page);
    const last = await page.locator(".time-column .dimensional-count").last().boundingBox();
    assert.ok(last.x >= 0 && last.x + last.width <= 375, "Resizing keeps the focused count fully in view");
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await expect(page.locator(".time-column").last()).toBeFocused();
    const forced = await page.locator(".flat-time-segment").first().evaluate(node => ({
        fill: getComputedStyle(node).fill, opacity: getComputedStyle(node).fillOpacity,
    }));
    assert.equal(forced.fill, "rgb(0, 0, 0)"); assert.equal(forced.opacity, "1");
    assert.equal(await page.locator(".time-column").first().evaluate(node => getComputedStyle(node).transitionDuration), "0s");
});

test("source bins, shares, DST and partial bounds drill into the same Analyze IDs and return", async t => {
    const { page, url, analytics } = await setup(t);
    assert.equal(analytics().totals.count, 9);
    assert.equal(analytics().timeSeries.undatedCount, 1);
    assert.deepEqual(analytics().timeSeries.points.map(point => [point.date, point.total]),
        [["2026-03-07", 1], ["2026-03-08", 4], ["2026-03-09", 1], ["2026-03-10", 0], ["2026-03-11", 2]]);
    await expect(page.locator("#chartFooter")).toContainText("1 undated");
    await expect(page.locator("#chartFooter")).toContainText("not proof no activity occurred");
    assert.equal(await page.locator("#chart .dimensional-ground,#chart .dimensional-cap").count(), 0);
    const columns = await page.locator(".flat-time-column").evaluateAll(nodes => nodes.map(svg => ({
        total: Number(svg.dataset.total), maximum: Number(svg.dataset.maximum), plotHeight: Number(svg.dataset.plotHeight),
        height: svg.getBoundingClientRect().height,
        parts: [...svg.querySelectorAll("rect")].map(node => ({ count: Number(node.dataset.count), height: node.getBoundingClientRect().height })),
    })));
    assert.deepEqual(columns.map(column => column.total), [1, 4, 1, 2]);
    for (const column of columns) {
        assert.ok(Math.abs(column.height - column.total / column.maximum * column.plotHeight) < .01);
        for (const part of column.parts) assert.ok(Math.abs(part.height - part.count / column.maximum * column.plotHeight) < .01);
    }
    assert.equal(await page.locator(".time-zero svg,.time-zero rect").count(), 0);
    await expect(page.locator(".time-column").nth(1)).toHaveAttribute("aria-label", /2 worked \(50%\).*1 tool failed \(25%\).*1 no result recorded \(25%\)/i);
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    const origin = page.url(), ids = analytics().timeSeries.points[1].drilldownIds;
    await page.locator(".time-column").nth(1).focus(); await page.keyboard.press("Enter"); await ready(page);
    assert.deepEqual(sorted(analytics().rows.map(row => row.id)), sorted(ids));
    assert.deepEqual(sorted(await page.locator("#activityList .matched-action").evaluateAll(nodes => nodes.map(node => node.dataset.actionId))), sorted(ids));
    assert.deepEqual(analytics().dateRange, { from: "2026-03-08T08:00:00.000Z", to: "2026-03-09T07:00:00.000Z", toExclusive: true });
    await page.goBack(); await ready(page);
    assert.equal(page.url(), origin);
    await expect(page.locator(".time-column").nth(1)).toBeFocused();
    for (const bucket of ["week", "month"]) {
        await page.goto(url + `/#analyze?mode=calls&bucket=${bucket}&range=custom&from=2026-03-08T09%3A00%3A00.000Z&to=2026-03-11T12%3A00%3A00.000Z`);
        await ready(page);
        const point = analytics().timeSeries.points.at(-1), expected = point.drilldownIds, before = page.url();
        await page.locator(".time-column").last().click(); await ready(page);
        assert.deepEqual(sorted(analytics().rows.map(row => row.id)), sorted(expected));
        assert.equal(analytics().dateRange.to, "2026-03-11T12:00:00.000Z");
        await page.goBack(); await ready(page); assert.equal(page.url(), before);
        assert.equal(await page.locator("#bucketFilter").inputValue(), bucket);
    }
});

test("date links retain private query, Author, Outcome, service context and canonical membership", async t => {
    const source = scopeRecords();
    for (const row of source) for (const call of row.toolCalls) {
        call.startedAt = row.scenarioId === "parity-request-6" ? "2026-03-09T07:00:00Z" : "2026-03-08T10:00:00Z";
    }
    const { page, analytics } = await setup(t, source);
    await restoreLegacySearch(page, privateQuery);
    await selectActivityOption(page, "serviceAssociationFilter", "Files"); await ready(page);
    await selectActivityOption(page, "promptAuthorFilter", "user"); await ready(page);
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("3");
    await expect(page.locator("#serviceFocusScope")).toContainText("2 known matches; 1 context-only");
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    const before = page.url(), point = analytics().timeSeries.points[0];
    await page.locator(".time-column").first().click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("2");
    assert.deepEqual(sorted(await page.locator("#activityList .matched-action").evaluateAll(nodes => nodes.map(node => node.dataset.actionId))), sorted(point.drilldownIds));
    await expect(page.locator("#activitySearch")).toHaveValue(privateQuery);
    assert.doesNotMatch(page.url(), new RegExp(privateQuery));
    assert.equal(analytics().serviceInvolvement.selection.includeMissingService, true);
    assert.deepEqual(analytics().serviceInvolvement.selection.services, ["Files"]);
    await page.goBack(); await ready(page);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.split("?")[1])),
        Object.fromEntries(new URLSearchParams(new URL(before).hash.split("?")[1])));
    await expect(page.locator("#activityCount")).toHaveText("3");
});

test("tiny and extreme source counts remain linear and actionable; empty and undated views invent no bins", async t => {
    const source = records().slice(0, 2), large = source[1].toolCalls[0];
    source[1].toolCalls = Array.from({ length: 200 }, (_, index) => ({
        ...large, toolCallId: `extreme-${index}`, startEventId: `extreme-start-${index}`,
        toolSucceeded: index !== 0, reportedOutcome: index === 0 ? "failed" : "succeeded",
    }));
    const { page } = await setup(t, source);
    await expect(page.locator("#activityCount")).toHaveText("201");
    const tiny = page.locator(".flat-time-column").first();
    assert.ok(Math.abs((await tiny.boundingBox()).height - .8) < .01, "1 / 200 is .8px of the compact 160px plot, not a minimum bar");
    const failure = page.locator('.flat-time-column [data-segment="failure"]').last();
    assert.ok(Math.abs((await failure.boundingBox()).height - .8) < .01, "The tiny outcome is not inflated either");
    const count = page.locator(".time-column .dimensional-count").first();
    const target = await count.boundingBox(); assert.ok(target.width >= 44 && target.height >= 44);
    await capture(page, "extreme-light");
    await count.click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("1");
    await page.goBack(); await ready(page);
    await restoreLegacySearch(page, "NO_TIME_MATCH");
    await expect(page.locator("#activityCount")).toHaveText("0");
    await expect(page.locator("#chart")).toContainText("No activity in this slice");
    assert.equal(await page.locator(".flat-time-column,.time-zero").count(), 0);
    const undated = await setup(t, [records().at(-1)]);
    await expect(undated.page.locator("#activityCount")).toHaveText("1");
    await expect(undated.page.locator("#chart")).toContainText("No dated activity is available");
    await expect(undated.page.locator("#chartFooter")).toContainText("1 undated");
    assert.equal(await undated.page.locator(".flat-time-column,.time-zero").count(), 0);
});

test("actual tiny result marks expose exact count/share tooltips and quiet keyboard links", async t => {
    const row = fixture("section-inspection"), base = row.toolCalls[0];
    row.toolCalls = Array.from({ length: 121 }, (_, index) => ({
        ...base, toolCallId: `section-${index}`, startEventId: `section-start-${index}`,
        toolSucceeded: index < 113 ? true : index < 120 ? false : undefined,
        reportedOutcome: index < 113 ? "succeeded" : index < 120 ? "failed" : undefined,
    }));
    const { page } = await setup(t, [row], "UTC");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const column = page.locator(".time-column");
        for (const [key, count] of [["success", 113], ["failure", 7], ["unknown", 1]]) {
            const mark = column.locator(`[data-segment="${key}"]`);
            await mark.hover();
            await expect(page.getByRole("tooltip")).toContainText(`${count} of 121 Work IQ tool calls`);
            if (key === "unknown") await expect(page.getByRole("tooltip")).toContainText("(0.8%)");
            assert.equal(await mark.getAttribute("data-count"), String(count));
            assert.equal(Number(await mark.getAttribute("height")), count / 121 * 160);
            await page.keyboard.press("Escape"); await expect(page.getByRole("tooltip")).toBeHidden();
        }
        await column.focus();
        await expect(page.getByRole("tooltip")).toBeHidden();
        await page.keyboard.press("Enter"); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText("121");
        await page.goBack(); await ready(page);
        await page.setViewportSize({ width: 375, height: 1000 });
        await page.locator('[data-chart="endpoint"]').click(); await ready(page);
        const mark = page.locator('.flat-comparison-segment[data-segment="unknown"]');
        await mark.hover();
        await expect(page.getByRole("tooltip")).toContainText("1 of 121");
        const box = await page.getByRole("tooltip").boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 375);
        await page.keyboard.press("Escape");
        await page.locator('[data-chart="time"]').click(); await ready(page);
    }
});
