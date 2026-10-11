import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { discoveryFixture } from "./discovery-fixtures.mjs";
import { chooseTheme } from "./helpers.mjs";
import { createDimensionalReportChart, dimensionalReportStyles } from "../lib/dimensional-report.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";

const proofDir = process.env.WORKIQ_LABEL_PROOFS;
const record = discoveryFixture();
record.toolCalls = [record.toolCalls[0], { ...record.toolCalls[0], toolCallId: "discovery-second", startEventId: "discovery-second-start" },
    { ...record.toolCalls[1], toolSucceeded: true, reportedOutcome: "succeeded" }];

test("Discovery and one/two-line API labels share a text-only first-line lane at the same font and gap", async t => {
    const records = [record], original = structuredClone(records), requests = [], errors = [];
    let visibleRecords = records;
    const server = createServer(async (req, res) => {
        if (req.method === "GET") { res.end(renderHtmlShell("a".repeat(64), "label-lanes")); return; }
        let text = ""; for await (const part of req) text += part;
        requests.push(req.url);
        res.setHeader("Content-Type", "application/json");
        if (req.url !== "/api/snapshot") { res.writeHead(403); res.end('{"error":"Only invented snapshot reads are allowed."}'); return; }
        res.end(JSON.stringify({ revision: 1, scenarios: visibleRecords, exports: [], coverage: { notes: [] },
            analytics: { ...buildActivityAnalytics(visibleRecords, JSON.parse(text)), revision: 1 } }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(records, original); assert.deepEqual(errors, []);
        assert.ok(requests.every(route => ["/api/snapshot", "/api/evaluation/automatic/summary"].includes(route)), "Only snapshot and read-only score summary may be requested; unsupported summary reads receive 403");
    });
    const ready = async () => {
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    };
    const measure = () => page.locator(".dimensional-category").evaluateAll(nodes => nodes.map(node => {
        const label = node.querySelector(".group-name"), range = document.createRange();
        range.selectNodeContents(label);
        const lines = [...range.getClientRects()], css = getComputedStyle(label);
        const cell = node.getBoundingClientRect(), stage = node.querySelector(".dimensional-stage").getBoundingClientRect();
        const value = node.querySelector(".dimensional-count").getBoundingClientRect();
        const svg = node.querySelector(".dimensional-column"), paint = svg.getBoundingClientRect();
        return {
            label: label.textContent, firstY: lines[0].y, firstBottom: lines[0].bottom, lastBottom: lines.at(-1).bottom,
            lineCount: lines.length, center: cell.x + cell.width / 2, labelCenter: label.getBoundingClientRect().x + label.getBoundingClientRect().width / 2,
            valueCenter: value.x + value.width / 2, paintCenter: paint.x + paint.width / 2,
            topGap: label.getBoundingClientRect().y - stage.bottom,
            font: { family: css.fontFamily, size: css.fontSize, weight: css.fontWeight, lineHeight: css.lineHeight },
            count: Number(svg.dataset.total), visualHeight: Number(svg.dataset.frontHeight),
            iconCount: node.querySelectorAll(".dimensional-category-icon,.dimensional-color-key").length,
            clipped: lines.some(line => line.x < cell.x - 1 || line.right > cell.right + 1),
        };
    }));
    await page.goto(`http://127.0.0.1:${server.address().port}/#home?chart=workload`); await ready();
    const evidence = [];
    if (proofDir) await mkdir(proofDir, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        let service;
        for (const mode of ["workload", "endpoint"]) {
            await page.locator(`[data-chart="${mode}"]`).click(); await ready();
            const measured = await measure();
            evidence.push({ theme, width, scale, mode, measured });
            if (proofDir) {
                await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
                const clip = await page.locator(".chart-panel").boundingBox();
                await page.screenshot({ path: path.join(proofDir, `${theme}-${width}-text${scale}-${mode}.png`), fullPage: true, clip });
                await writeFile(path.join(proofDir, "label-lanes.json"), JSON.stringify(evidence, null, 2));
            }
            assert.ok(await page.evaluate(() => document.fonts.check("500 14px Arial")), "Measure the available product font");
            for (const row of measured) {
                assert.equal(row.iconCount, 0, "Category names need no separate icon row beneath the columns");
                assert.ok(Math.abs(row.firstY - measured[0].firstY) < 1, "Single and multiline labels begin on the same first line");
                assert.ok(Math.abs(row.firstBottom - measured[0].firstBottom) < 1, "The visible first text baseline is aligned");
                assert.deepEqual(row.font, measured[0].font, "One category-label typography role");
                assert.equal(row.font.size, `${14 * scale}px`);
                assert.equal(row.font.weight, "500");
                assert.ok(row.topGap >= 23 && row.topGap <= 24 * scale + 1, "One deliberate gap from the common ground line");
                assert.ok(Math.abs(row.labelCenter - row.center) < 1);
                assert.ok(Math.abs(row.valueCenter - row.paintCenter) < 1, "Count labels remain centered on the projected column");
                assert.equal(row.clipped, false);
            }
            if (mode === "workload") {
                assert.deepEqual(measured.map(row => row.label), ["Discovery"]);
                assert.equal(measured[0].count, 3);
                service = measured[0];
            } else {
                assert.deepEqual(measured.map(row => row.count), [2, 1]);
                assert.equal(measured[0].label, "API discovery");
                assert.match(measured[1].label, /Schema lookup - Schema path: \/me\/messages/);
                assert.deepEqual(measured[0].font, service.font);
                assert.equal(measured[0].topGap, service.topGap, "Service and API labels have the same floor-to-text spacing");
                assert.ok(measured[1].lineCount > 1);
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            if (mode === "endpoint" && width === 375) {
                await page.locator(".dimensional-action").last().focus();
                const lastLabel = page.locator(".group-name").last();
                const bounds = await lastLabel.boundingBox();
                assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, "The full multiline category remains horizontally reachable");
                if (proofDir) {
                    await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
                    await page.screenshot({ path: path.join(proofDir, `${theme}-${width}-text${scale}-endpoint-last.png`), fullPage: true, clip: await page.locator(".chart-panel").boundingBox() });
                }
            }
        }
    }
    await page.setViewportSize({ width: 1200, height: 1000 }); await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    await ready();
    const originalLabels = (await measure()).map(row => row.label);
    const action = page.locator(".dimensional-action").last();
    await action.focus(); await page.keyboard.press("Enter"); await ready();
    assert.match(await page.locator("#viewingContext").textContent(), /1 Work IQ tool call/);
    await page.goBack(); await ready();
    assert.deepEqual((await measure()).map(row => row.label), originalLabels);
    await action.locator(".dimensional-count").click(); await ready();
    assert.match(await page.locator("#viewingContext").textContent(), /1 Work IQ tool call/);
    visibleRecords = [{ ...record, scenarioId: "label-unknown", toolCalls: [{
        ...record.toolCalls[0], tool: "workiq-fetch", requestArgs: {}, requestedApiPath: null,
    }] }];
    await page.goto(`http://127.0.0.1:${server.address().port}/#home?chart=workload`); await ready();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme); await ready();
        const [unknown] = await measure();
        assert.equal(unknown.label, serviceCategories.describe("Unknown").label);
        assert.equal(unknown.iconCount, 0);
        assert.equal(unknown.topGap, 24);
        assert.equal(unknown.lineCount, 1, "The missing-service name needs no empty icon/multiline reservation");
        if (proofDir) {
            await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
            await page.screenshot({ path: path.join(proofDir, `${theme}-unknown.png`), fullPage: true, clip: await page.locator(".chart-panel").boundingBox() });
        }
    }
});

test("new report labels already flow from the first line without an icon track or changed print sizing", async t => {
    const groups = [2, 1].map((total, index) => ({
        total, label: index ? "Schema lookup - Schema path: /me/messages" : "API discovery",
        success: total, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0,
    }));
    const html = createDimensionalReportChart()({ layer: "tool", unit: "Work IQ tool calls", visibleGroups: groups });
    const browser = await chromium.launch(), page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 850, height: 900 } });
    t.after(() => browser.close());
    await page.setContent(`<style>body{margin:24px;font-family:Arial}*{box-sizing:border-box}${dimensionalReportStyles}</style>${html}`);
    await page.emulateMedia({ media: "print" });
    const labels = await page.locator(".dimensional-report-label").evaluateAll(nodes => nodes.map(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        return { firstY: range.getClientRects()[0].y, text: node.textContent, size: getComputedStyle(node).fontSize };
    }));
    assert.deepEqual(labels.map(label => label.text), groups.map(group => group.label));
    assert.ok(Math.abs(labels[0].firstY - labels[1].firstY) < 1);
    assert.ok(labels.every(label => label.size === "13px"), "The separate compact report typography is not an affected shared app-label consumer");
    assert.equal(await page.locator(".dimensional-category-icon,.dimensional-color-key").count(), 0);
});
