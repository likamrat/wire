import test from "node:test";
import assert from "node:assert/strict";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";

const charts = createDimensionalCharts();
const keys = Object.keys(charts.outcomeTones);
const values = parts => Object.fromEntries(keys.map(key => [key, parts[key] || 0]));

test("the missing-result band is visibly separate from the non-data top finish", () => {
    const input = { total: 121, maximum: 121, width: 60, values: values({ success: 113, failure: 7, unknown: 1 }) };
    const geometry = charts.layout(input);
    const missing = geometry.segments.find(part => part.key === "unknown");
    assert.equal(missing.count, 1);
    assert.ok(missing.height >= 6);
    assert.equal(geometry.segments[0], missing);
    const capArea = geometry.frontWidth * (geometry.depthY + .18 * geometry.depthX);
    const tinyFrontArea = geometry.frontWidth * missing.height;
    assert.ok(capArea > 0, "Depth is actual projected geometry, not a flat substitute");
    assert.ok(tinyFrontArea > 0);
    const svg = charts.svg(input);
    const cap = svg.match(/<path class="dimensional-cap[^>]+>/)?.[0];
    assert.match(cap, /dimensional-cap-clear/);
    assert.doesNotMatch(cap, /dimensional-tone-|data-count|url\(#dimensional-\d+-(teal|pink|slate)/, "The neutral lid cannot claim the top outcome's amount");
    assert.ok(svg.indexOf(cap) < svg.indexOf('class="dimensional-front '), "Exact bands paint after the inward-clipped neutral rim");
    assert.match(svg, /dimensional-outcomes/);
    assert.equal(geometry.segments.reduce((sum, part) => sum + part.count, 0), 121);
});

test("readable bands preserve counts, contiguous coverage and the same nonsemantic cap", () => {
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
        const before = structuredClone(input), geometry = charts.layout(input), svg = charts.svg(input);
        assert.deepEqual(input, before);
        assert.ok(Math.abs(geometry.segments.reduce((sum, part) => sum + part.height, 0) - geometry.frontHeight) < 1e-9);
        for (const [index, part] of geometry.segments.entries()) {
            assert.ok(part.height >= 6 - 1e-10);
            assert.equal(part.count, counts[part.key]);
            if (index) assert.equal(part.bottom, geometry.segments[index - 1].top);
        }
        if (!total) assert.equal(svg, "");
        else {
            assert.match(svg, /dimensional-cap-clear/);
            assert.match(svg, /dimensional-side/);
        }
    }
    const service = charts.svg({ total: 1, maximum: 1, service: "Mail" });
    assert.match(service, /dimensional-cap-clear/, "Service tops are also neutral, never extra category magnitude");
    const tiny = charts.svg({ total: 1, maximum: 100000, values: values({ unknown: 1 }) });
    assert.match(tiny, /data-front-height="36"/);
    assert.match(tiny, /data-adjusted="true"/);
});
