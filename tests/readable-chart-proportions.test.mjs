import test from "node:test";
import assert from "node:assert/strict";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";

const dimensional = createDimensionalCharts();
const percentages = createPercentageCharts({ dimensional });
const values = (success, failure = 0, unknown = 0) => ({ success, failure, unknown, partial: 0, other: 0, transport: 0 });

test("exact spans preserve zeros, order and totals without inflating positive values", () => {
    for (const counts of [[193, 25, 1], [76, 70, 21, 20, 2, 30], [997, 1, 1, 1], [1, 1, 1, 1, 1, 1], [0, 1, 999999]]) {
        const before = [...counts], total = counts.reduce((sum, count) => sum + count, 0);
        const sizes = counts.map(count => dimensional.geometryPolicy.span(count, total, 1));
        assert.ok(Math.abs(sizes.reduce((a, b) => a + b, 0) - 1) < 1e-12);
        counts.forEach((count, i) => assert.equal(sizes[i], count / total));
        for (let i = 0; i < counts.length; i++) for (let j = 0; j < counts.length; j++) {
            if (counts[i] > counts[j]) assert.ok(sizes[i] >= sizes[j] - 1e-12);
            if (counts[j]) assert.ok(Math.abs(sizes[i] / sizes[j] - counts[i] / counts[j]) < 1e-10, "All positive slices preserve their relative weights");
        }
        assert.deepEqual(counts, before);
    }
});

test("the original two-call column retains its exact count and scale", () => {
    const totals = [9, 28, 9, 121, 50, 2];
    const columns = totals.map(total => dimensional.flatLayout({ total, maximum: 121, plotHeight: 320, width: 84, values: values(total) }));
    assert.equal(columns.at(-1).total, 2);
    assert.equal(columns.at(-1).height, 2 / 121 * 320);
    assert.ok(columns[0].height > columns.at(-1).height);
    assert.equal(columns[0].height, columns[2].height);
    assert.equal(columns[3].height, 320);
    for (const column of columns) {
        assert.equal(column.segments.reduce((sum, part) => sum + part.count, 0), column.total);
        assert.ok(Math.abs(column.segments.reduce((sum, part) => sum + part.height, 0) - column.height) < 1e-10);
        assert.equal(column.width, 84);
    }
    assert.equal(dimensional.flatLayout({ total: 0, maximum: 121, values: values(0) }).height, 0);
});

test("the missing result is a readable data band rather than a false extra gray ending", () => {
    const column = dimensional.flatLayout({ total: 121, maximum: 121, plotHeight: 320, values: values(113, 7, 1) });
    assert.deepEqual(column.segments.map(part => [part.key, part.count]), [["unknown", 1], ["success", 113], ["failure", 7]]);
    assert.equal(column.segments.find(part => part.key === "unknown").height, 1 / 121 * 320);
    assert.equal(column.segments.at(-1).top, 0);
    assert.equal(column.segments.at(-1).key, "failure");
    const tiny = dimensional.flatLayout({ total: 1, maximum: 1000000, values: values(1) });
    assert.equal(tiny.height, 1 / 1000000 * 200);
    const mixed = dimensional.flatLayout({ total: 6, maximum: 1000000,
        values: { success: 1, failure: 1, unknown: 1, partial: 1, other: 1, transport: 1 } });
    assert.ok(mixed.segments.every(part => part.height === 1 / 1000000 * 200));
});

test("flat donut angles and exact shares preserve tiny slices without inflation", () => {
    const data = percentages.partition([
        { id: "success", label: "Worked", count: 193 },
        { id: "failure", label: "Needs attention", count: 25 },
        { id: "unknown", label: "No result recorded", count: 1 },
    ], 219);
    const before = structuredClone(data), visual = percentages.visualSlices(data);
    assert.deepEqual(data, before);
    assert.equal(visual[0].visualStart, 0);
    assert.equal(visual.at(-1).visualEnd, 1);
    const tiny = visual.find(row => row.id === "unknown");
    assert.equal(tiny.visualFraction, 1 / 219);
    assert.equal(tiny.fraction, 1 / 219);
    assert.equal(tiny.percentage, "0.5%");
    assert.equal(tiny.count, 1);
    visual.forEach((row, index) => {
        assert.ok(row.visualEnd > row.visualStart);
        if (index) assert.equal(row.visualStart, visual[index - 1].visualEnd);
    });
});
