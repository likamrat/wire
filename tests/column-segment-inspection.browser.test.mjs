import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const source = [9, 28, 9, 121, 50, 2].map((total, week) => {
    const record = fixture(`section-inspection-${week}`);
    record.userPrompt.text = "Invented column section inspection";
    record.capturedAt = new Date(Date.UTC(2026, 7, 31 + week * 7, 12)).toISOString();
    record.toolCalls = Array.from({ length: total }, (_, index) => {
        const failures = [0, 6, 2, 7, 10, 0][week], missing = week === 3 && index === total - 1;
        const worked = !missing && index < total - failures - (week === 3 ? 1 : 0);
        return { ...record.toolCalls[0], toolCallId: `section-${week}-${index}`, startEventId: `section-start-${week}-${index}`,
            startedAt: record.capturedAt, toolSucceeded: missing ? undefined : worked,
            reportedOutcome: missing ? undefined : worked ? "succeeded" : "failed", apiResults: [] };
    });
    return record;
});

test("actual green, pink and one-record column surfaces expose their own result without redundant controls", async t => {
    const requests = [], errors = [], before = structuredClone(source);
    const server = createServer(async (req, res) => {
        if (req.method === "GET") { res.end(renderHtmlShell("a".repeat(64), "section-inspection")); return; }
        let text = ""; for await (const chunk of req) text += chunk;
        requests.push(req.url);
        res.setHeader("Content-Type", "application/json");
        if (req.url !== "/api/snapshot") { res.writeHead(403); res.end('{"error":"Invented snapshot reads only"}'); return; }
        res.end(JSON.stringify({ revision: 1, scenarios: source, exports: [], coverage: { notes: [] },
            analytics: { ...buildActivityAnalytics(source, JSON.parse(text)), revision: 1 } }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", hasTouch: true });
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(2000);
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(source, before); assert.deepEqual(errors, []);
        assert.ok(requests.every(route => route === "/api/snapshot"));
    });
    const ready = () => page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.goto(`http://127.0.0.1:${server.address().port}`); await ready();
    await page.evaluate(() => document.fonts.ready);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        if (process.env.WORKIQ_SECTION_PROOFS) {
            await mkdir(process.env.WORKIQ_SECTION_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WORKIQ_SECTION_PROOFS, `home-${theme}.png`), fullPage: true });
        }
        await page.locator(".chart-panel").scrollIntoViewIfNeeded();
        const column = page.locator(".time-column").nth(3);
        assert.deepEqual(await page.locator(".dimensional-column").evaluateAll(nodes => nodes.map(node => +node.dataset.plotHeight)), Array(6).fill(320), "All original-case columns use one shared readable scale");
        assert.ok(Number(await page.locator(".dimensional-column").last().getAttribute("data-front-height")) > 40, "Two calls is now a readable body");
        assert.equal(await page.locator(".chart-size-note").count(), 1);
        assert.match(await page.locator(".chart-size-note").textContent(), /Visual sizes adjusted/);
        assert.equal(await column.locator(".dimensional-column").getAttribute("width"), "84");
        for (const [key, text] of [["success", "Worked: 113 of 121"], ["failure", "Tool failed: 7 of 121"], ["unknown", "No result recorded: 1 of 121"]]) {
            const face = column.locator(`.dimensional-front.${key}`);
            await face.scrollIntoViewIfNeeded();
            const point = await face.evaluate(node => {
                const p = new DOMPoint(node.width.baseVal.value / 2, node.y.baseVal.value + node.height.baseVal.value / 2).matrixTransform(node.getScreenCTM());
                return { x: p.x, y: p.y };
            });
            await page.mouse.move(4, 4); await page.mouse.move(point.x, point.y);
            const tip = page.getByRole("tooltip");
            await page.clock.runFor(1);
            assert.equal(await tip.isVisible(), true, "Thin chart surfaces do not require dwelling through the ordinary control delay");
            assert.ok((await tip.innerText()).startsWith(text), `${key}: the hovered result, not a whole-column summary`);
            if (key === "unknown") {
                assert.match(await tip.innerText(), /\(0.8%\)/);
                const material = await face.evaluate(node => ({
                    fill: getComputedStyle(node).fill, opacity: getComputedStyle(node).fillOpacity,
                    previousInk: getComputedStyle(node).getPropertyValue("--column-label").trim(),
                    background: getComputedStyle(node.closest(".chart-panel")).backgroundColor,
                }));
                assert.equal(material.opacity, "1");
                assert.ok(contrast(material.fill, material.background) >= 3, "The softer data material still has non-text contrast");
                assert.ok(contrast(material.fill, material.background) < contrast(material.previousInk, material.background), "A tiny missing-result band no longer uses the aggressive label ink");
            }
            assert.equal(Number(await face.getAttribute("data-count")), [113, 7, 1][["success", "failure", "unknown"].indexOf(key)]);
            assert.ok(Number(await face.getAttribute("height")) >= 6 - 1e-10);
            if (process.env.WORKIQ_SECTION_PROOFS) {
                await mkdir(process.env.WORKIQ_SECTION_PROOFS, { recursive: true });
                await page.locator(".chart-panel").screenshot({ path: path.join(process.env.WORKIQ_SECTION_PROOFS, `${theme}-${key}.png`) });
            }
            const side = column.locator(`.dimensional-side[data-outcome=${key}]`);
            const sidePoint = await side.evaluate(node => {
                const box = node.getBBox(), p = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(node.getScreenCTM());
                return { x: p.x, y: p.y };
            });
            await page.mouse.move(sidePoint.x, sidePoint.y); await page.clock.runFor(1);
            assert.ok((await tip.innerText()).startsWith(text), "The same section remains inspectable across both actual facets");
            await page.keyboard.press("Escape");
            await tip.waitFor({ state: "hidden" });
        }
        assert.equal(await page.locator("#chart .ux-help,.dimensional-small-results").count(), 0);
        await page.mouse.move(4, 4);
        await column.focus();
        assert.equal(await page.getByRole("tooltip").isVisible(), false, "Count focus remains a quiet native drilldown target");
        await page.keyboard.press("Enter"); await ready();
        assert.match(await page.locator("#viewingContext").innerText(), /121 Work IQ tool calls/);
        await page.goBack(); await ready();
        assert.deepEqual(await page.locator(".dimensional-count").allTextContents(), ["9 calls", "28 calls", "9 calls", "121 calls", "50 calls", "2 calls"]);
        await page.getByRole("tooltip").waitFor({ state: "hidden" });
        await column.locator(".failure").tap(); await ready();
        assert.match(await page.locator("#viewingContext").innerText(), /121 Work IQ tool calls/);
        await page.goBack(); await ready();
    }
    const sizes = () => page.locator(".dimensional-column").evaluateAll(nodes => nodes.map(node => [node.dataset.plotHeight, node.getAttribute("width"), node.getAttribute("height")]));
    const acceptedSizes = await sizes();
    await page.evaluate(() => document.querySelector("#refreshBtn").click()); await ready();
    assert.deepEqual(await sizes(), acceptedSizes, "Unchanged accepted data cannot bounce between compact and expanded geometry on polling");
    await selectActivityOption(page, "outcomeFilter", "unknown"); await ready();
    assert.deepEqual(await page.locator(".dimensional-column").evaluateAll(nodes => nodes.map(node => +node.dataset.plotHeight)), [320], "A filtered view keeps the same readable height budget");
    await page.goBack(); await ready();
    assert.deepEqual(await sizes(), acceptedSizes, "Back restores the same common reading scale");
    await page.locator('[data-chart=workload]').click(); await ready();
    assert.ok((await sizes()).every(([extent]) => extent === "320"), "Service scenes share the readable height budget");
    await page.locator('[data-chart=time]').click(); await ready();
    await page.setViewportSize({ width: 375, height: 1000 });
    if (process.env.WORKIQ_SECTION_PROOFS) await page.screenshot({ path: path.join(process.env.WORKIQ_SECTION_PROOFS, "home-narrow.png"), fullPage: true });
    await page.locator('[data-chart=endpoint]').click(); await ready();
    const tiny = page.locator(".dimensional-action").first().locator(".dimensional-front.unknown");
    await tiny.scrollIntoViewIfNeeded();
    const p = await tiny.evaluate(node => {
        const point = new DOMPoint(node.width.baseVal.value / 2, node.y.baseVal.value + node.height.baseVal.value / 2).matrixTransform(node.getScreenCTM());
        return { x: point.x, y: point.y };
    });
    await page.mouse.move(4, 4); await page.mouse.move(p.x, p.y); await page.clock.runFor(1);
    assert.match(await page.getByRole("tooltip").innerText(), /No result recorded: 1 of 219.*\(0.5%\)/);
    const tip = await page.getByRole("tooltip").boundingBox();
    assert.ok(tip.x >= 0 && tip.x + tip.width <= 375, "Inspection stays inside the narrow viewport");
    await page.keyboard.press("Escape");
    await page.locator("#tableDisclosure>summary").click();
    assert.match(await page.locator("#countTable").innerText(), /No result recorded/);
});
