import test from "node:test";
import assert from "node:assert/strict";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";

const dimensional = createDimensionalCharts();
const percentages = createPercentageCharts({ dimensional });
const values = (success, failure = 0, unknown = 0) => ({ success, failure, unknown, partial: 0, other: 0, transport: 0 });

test("readability allocation preserves zeros, order and totals while making every positive span usable", () => {
    const allocate = dimensional.geometryPolicy.allocate;
    assert.deepEqual(allocate([0, 0], 1, .03), [0, 0]);
    for (const counts of [[193, 25, 1], [76, 70, 21, 20, 2, 30], [997, 1, 1, 1], [1, 1, 1, 1, 1, 1], [0, 1, 999999]]) {
        const before = [...counts], sizes = allocate(counts, 1, .03);
        assert.ok(Math.abs(sizes.reduce((a, b) => a + b, 0) - 1) < 1e-12);
        counts.forEach((count, i) => assert.ok(count ? sizes[i] >= .03 - 1e-12 : sizes[i] === 0));
        for (let i = 0; i < counts.length; i++) for (let j = 0; j < counts.length; j++) {
            if (counts[i] > counts[j]) assert.ok(sizes[i] >= sizes[j] - 1e-12);
            if (sizes[i] > .03 + 1e-12 && sizes[j] > .03 + 1e-12) assert.ok(Math.abs(sizes[i] / sizes[j] - counts[i] / counts[j]) < 1e-10, "Non-minimum slices preserve their relative weights");
        }
        assert.deepEqual(counts, before);
    }
    for (const counts of [[-1], [NaN], [1.2], [Number.MAX_SAFE_INTEGER, 1]]) assert.throws(() => allocate(counts, 1, .03));
    assert.throws(() => allocate([1, 1], 1, .6), /fit/);
});

test("the original two-call column is a readable solid, not a plate, without changing its count", () => {
    const totals = [9, 28, 9, 121, 50, 2];
    const columns = totals.map(total => dimensional.layout({ total, maximum: 121, plotHeight: 320, width: 84, values: values(total) }));
    assert.equal(columns.at(-1).total, 2);
    assert.ok(columns.at(-1).frontHeight >= 40 && columns.at(-1).frontHeight < 60);
    assert.ok(columns[0].frontHeight > columns.at(-1).frontHeight);
    assert.equal(columns[0].frontHeight, columns[2].frontHeight);
    assert.equal(columns[3].frontHeight, 320);
    for (const column of columns) {
        assert.equal(column.segments.reduce((sum, part) => sum + part.count, 0), column.total);
        assert.ok(Math.abs(column.segments.reduce((sum, part) => sum + part.height, 0) - column.frontHeight) < 1e-10);
        assert.equal(column.paintedCenter, 42);
    }
    assert.equal(dimensional.layout({ total: 0, maximum: 121, values: values(0) }).height, 0);
});

test("the missing result is a readable data band rather than a false extra gray ending", () => {
    const column = dimensional.layout({ total: 121, maximum: 121, plotHeight: 320, values: values(113, 7, 1) });
    assert.deepEqual(column.segments.map(part => [part.key, part.count]), [["unknown", 1], ["success", 113], ["failure", 7]]);
    assert.ok(column.segments.find(part => part.key === "unknown").height >= 6);
    assert.equal(column.segments.at(-1).top, 0);
    assert.equal(column.segments.at(-1).key, "failure");
    const tiny = dimensional.layout({ total: 1, maximum: 1000000, values: values(1) });
    assert.ok(tiny.frontHeight >= 36);
    const mixed = dimensional.layout({ total: 6, maximum: 1000000,
        values: { success: 1, failure: 1, unknown: 1, partial: 1, other: 1, transport: 1 } });
    assert.ok(mixed.segments.every(part => part.height >= 6 - 1e-10));
});

test("visual donut angles may enlarge tiny slices while exact shares and canonical partitions remain untouched", () => {
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
    assert.ok(tiny.visualFraction >= .03);
    assert.equal(tiny.fraction, 1 / 219);
    assert.equal(tiny.percentage, "0.5%");
    assert.equal(tiny.count, 1);
    visual.forEach((row, index) => {
        assert.ok(row.visualEnd > row.visualStart);
        if (index) assert.equal(row.visualStart, visual[index - 1].visualEnd);
    });
});
