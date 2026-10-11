import test from "node:test";
import assert from "node:assert/strict";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";

const charts = createDimensionalCharts();
const keys = Object.keys(charts.outcomeTones);
const values = parts => Object.fromEntries(keys.map(key => [key, parts[key] || 0]));

test("the missing-result band retains its exact share without a non-data top finish", () => {
    const input = { total: 121, maximum: 121, width: 60, values: values({ success: 113, failure: 7, unknown: 1 }) };
    const geometry = charts.flatLayout(input);
    const missing = geometry.segments.find(part => part.key === "unknown");
    assert.equal(missing.count, 1);
    assert.equal(missing.height, 200 / 121);
    assert.equal(geometry.segments[0], missing);
    const svg = charts.flatSvg(input);
    assert.doesNotMatch(svg, /dimensional-cap|dimensional-side|dimensional-glint/);
    assert.match(svg, /data-segment="unknown" data-count="1"/);
    assert.equal(geometry.segments.reduce((sum, part) => sum + part.count, 0), 121);
});

test("flat bands preserve counts, contiguous coverage and tiny positive spans", () => {
    const cases = [
        { success: 99999, unknown: 1 }, { success: 1, failure: 99999 }, { success: 99998, failure: 1, unknown: 1 },
        ...keys.map(key => ({ [key]: 100 })),
        Object.fromEntries(keys.map(key => [key, 1])),
        { success: 0 },
    ];
    for (const parts of cases) for (const width of [60, 116]) {
        const counts = values(parts), total = Object.values(counts).reduce((sum, value) => sum + value, 0);
        const maximum = Math.max(1, total);
        const input = { total, maximum, width, values: counts };
        const before = structuredClone(input), geometry = charts.flatLayout(input), svg = charts.flatSvg(input);
        assert.deepEqual(input, before);
        assert.ok(Math.abs(geometry.segments.reduce((sum, part) => sum + part.height, 0) - geometry.height) < 1e-9);
        for (const [index, part] of geometry.segments.entries()) {
            assert.equal(part.height, part.count / maximum * 200);
            assert.equal(part.count, counts[part.key]);
            if (index) assert.equal(part.bottom, geometry.segments[index - 1].top);
        }
        if (!total) assert.equal(svg, "");
        else {
            assert.doesNotMatch(svg, /dimensional-cap|dimensional-side/);
            assert.equal((svg.match(/<rect /g) || []).length, geometry.segments.length);
        }
    }
    const service = charts.flatSvg({ total: 1, maximum: 1, service: "Mail" });
    assert.match(service, /dimensional-tone-service-mail/);
    const tiny = charts.flatLayout({ total: 1, maximum: 100000, values: values({ unknown: 1 }) });
    assert.equal(tiny.height, 1 / 100000 * 200);
});
