import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createDimensionalReportChart, dimensionalReportStyles } from "../lib/dimensional-report.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture } from "./helpers.mjs";
import { styles } from "../web/styles.mjs";

const charts = createDimensionalCharts(), proofDir = process.env.WORKIQ_CHART_POLICY_PROOFS;
const values = total => ({ success: total, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0 });

test("shared policy preserves exact spans, zero and bounded outlines without selecting a chart algorithm", () => {
    const policy = charts.geometryPolicy;
    for (const extent of [0, 100, 200, 360]) for (const count of [0, 1, 2, 20, 200]) {
        assert.equal(policy.span(count, 200, extent), count / 200 * extent);
    }
    assert.equal(policy.span(0, 0, 200), 0);
    assert.equal(policy.span(1, 100000, 200), .002);
    for (const span of [0, .0001, .002, 1, 2, 3, 20, 200]) {
        assert.ok(policy.outlineWidth(span) <= span * .2);
        assert.ok(policy.outlineWidth(span) <= 1);
        assert.equal(policy.needsDetail(span), span > 0 && span < 3);
    }
    for (const invalid of [-1, NaN, Infinity]) {
        assert.throws(() => policy.span(invalid, 200, 200));
        assert.throws(() => policy.outlineWidth(invalid));
        assert.throws(() => policy.needsDetail(invalid));
    }
    assert.throws(() => policy.span(201, 200, 200));
    assert.throws(() => policy.span(1, 200, Infinity));
});

test("service columns preserve small painted data edges beside neutral decorative lids", async t => {
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    const cases = [0, 1, 2, 20, 200];
    for (const theme of ["light", "dark"]) {
        await page.setContent(`<html data-evidence-theme="${theme}"><style>${styles}</style><body><main style="padding:24px;max-width:none"><h2>Synthetic common maximum: 200 calls</h2><div id="columns" style="display:flex;align-items:end;gap:48px;padding:40px 0">${cases.map(total =>
            `<div><p>${total} ${total === 1 ? "call" : "calls"}</p>${charts.svg({ total, maximum: 200, service: "Mail" })}</div>`).join("")}</div></main></body></html>`);
        const measurements = await page.locator(".dimensional-column").evaluateAll(nodes => nodes.map(svg => {
            const front = svg.querySelector(".dimensional-front"), height = front.height.baseVal.value;
            const after = [...svg.querySelectorAll(".dimensional-front,.dimensional-side,.dimensional-cap,.dimensional-rim")].filter(node =>
                node === front || front.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
            let covered = 0;
            for (let i = 0; i < 100; i++) {
                const screen = new DOMPoint(32, height * (i + .5) / 100).matrixTransform(front.getScreenCTM());
                if (after.some(node => {
                    const point = screen.matrixTransform(node.getScreenCTM().inverse());
                    const clipId = node.getAttribute("clip-path")?.match(/^url\(#(.+)\)$/)?.[1];
                    const clip = clipId ? document.getElementById(clipId)?.firstElementChild : null;
                    return getComputedStyle(node).stroke !== "none" && node.isPointInStroke(point) && (!clip || clip.isPointInFill(point));
                })) covered++;
            }
            const cap = svg.querySelector(".dimensional-cap");
            return { total: +svg.dataset.total, height, covered, frontArea: front.width.baseVal.value * height,
                capFill: cap && getComputedStyle(cap).fill, depth: +svg.dataset.depth,
                sideCount: svg.querySelectorAll(".dimensional-side").length,
                countFill: getComputedStyle(front).fill };
        }));
        t.diagnostic(JSON.stringify({ theme, measurements }));
        assert.equal(await page.locator("#columns>div").first().locator("svg").count(), 0);
        for (const row of measurements) {
            assert.ok(Math.abs(row.height - Math.max(36, Math.sqrt(row.total / 200) * 280)) < .0001);
            assert.ok(row.frontArea > 0);
            assert.ok(row.depth > 0);
            assert.equal(row.sideCount, 1);
            assert.ok(row.capFill !== row.countFill, "The neutral lid cannot claim category magnitude");
            assert.match(row.countFill, /^(?:url\("#dimensional-|rgb)/, "Material gradient or opaque thin-band color");
            assert.ok(row.covered <= 25, `${row.total}: outline covers ${row.covered}% of data centerline`);
        }
        if (proofDir) {
            await mkdir(proofDir, { recursive: true });
            await page.locator("main").screenshot({ path: path.join(proofDir, `service-common-scale-${theme}.png`) });
        }
    }
});

test("the shared policy reaches serialized columns, donut/bar consumers and newly rendered reports", async t => {
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
    await page.route("**/*", route => route.abort());
    await page.setContent(`<html data-evidence-theme="light"><style>${styles}</style><body><main id="host"></main></body></html>`);
    const record = fixture("chart-policy");
    record.toolCalls = Array.from({ length: 219 }, (_, index) => ({ ...record.toolCalls[0],
        toolCallId: `policy-${index}`, startEventId: `policy-start-${index}`,
        tool: index < 193 ? "workiq-fetch" : index < 218 ? "workiq-call_function" : "workiq-ask",
        toolSucceeded: index < 193 ? true : index < 218 ? false : undefined,
        reportedOutcome: index < 193 ? "succeeded" : index < 218 ? "failed" : undefined,
    }));
    const measured = await page.evaluate(({ columns, percentages, results, categories, ux, icons, serviceIcons, analytics }) => {
        const make = source => (0, eval)(`(${source})`);
        const dimensional = make(columns)();
        const instance = make(percentages)({ dimensional, results: make(results)(), categories: make(categories)(),
            ux: make(ux)(icons), icons: serviceIcons }).mount(document.querySelector("#host"));
        instance.update(analytics, { layer: "tool", filters: {} });
        return { model: dimensional.layout({ total: 1, maximum: 200, service: "Mail" }),
            span: dimensional.geometryPolicy.span(1, 219, 360),
            outline: dimensional.geometryPolicy.outlineWidth(1) };
    }, { columns: createDimensionalCharts.toString(), percentages: createPercentageCharts.toString(), results: createRecordedResults.toString(),
        categories: createServiceCategories.toString(), ux: createEvidenceUX.toString(), icons: uxIcons, serviceIcons: dimensionalIcons,
        analytics: buildActivityAnalytics([record]) });
    assert.deepEqual(measured.model, charts.layout({ total: 1, maximum: 200, service: "Mail" }));
    assert.equal(measured.span, 360 / 219);
    assert.equal(measured.outline, charts.geometryPolicy.outlineWidth(1));
    const slices = await page.locator('[data-percentage-card="outcomes"] .percentage-slice').evaluateAll(nodes => nodes.map(node => ({
        count: +node.dataset.count, fraction: +node.dataset.exactFraction, visual: +node.dataset.end - +node.dataset.start,
    })));
    assert.equal(slices.length, 3);
    for (const slice of slices) {
        assert.ok(Math.abs(slice.fraction - slice.count / 219) < 1e-14);
        assert.ok(slice.visual >= .03 - 1e-12);
    }
    await page.getByRole("button", { name: "Tool names", exact: true }).click();
    const bars = await page.locator(".percentage-tool-list .percentage-bar").evaluateAll(nodes => nodes.map(node => ({
        fraction: +node.dataset.fraction, width: node.getBoundingClientRect().width, track: node.parentElement.getBoundingClientRect().width,
        text: node.closest(".percentage-legend-row").querySelector(".percentage-value").textContent,
    })));
    assert.equal(bars.length, 3);
    for (const bar of bars) assert.ok(Math.abs(bar.width - bar.track * bar.fraction) < .02, JSON.stringify(bar));
    assert.equal(bars.at(-1).text, "0.5% (1)");
    const groups = [1, 2, 20, 200].map(total => ({ label: `Synthetic ${total}`, total, ...values(total) }));
    const report = createDimensionalReportChart()({ layer: "tool", unit: "synthetic calls", visibleGroups: groups });
    await page.setContent(`<style>${dimensionalReportStyles}</style>${report}`);
    assert.equal(await page.locator(".dimensional-column").count(), 4);
    for (const [index, svg] of (await page.locator(".dimensional-column").all()).entries()) {
        assert.equal(await svg.getAttribute("data-front-height"), String(Math.max(36, Math.sqrt(groups[index].total / 200) * 280)));
        assert.equal(await svg.locator(".dimensional-cap,.dimensional-side").count(), 2);
    }
});
