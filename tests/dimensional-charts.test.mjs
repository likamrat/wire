import test from "node:test";
import assert from "node:assert/strict";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";

const charts = createDimensionalCharts();
const values = (success, failure = 0) => ({ success, failure, unknown: 0, partial: 0, other: 0, transport: 0 });
const model = (total, maximum = 100, extra = {}) => charts.layout({ total, maximum, values: values(total), ...extra });

test("glass columns share a readability scale independent of material and projection", () => {
    assert.equal(model(30).frontHeight, model(30, 100, { service: "Teams" }).frontHeight);
    assert.equal(model(80).frontHeight / model(20).frontHeight, 2);
    assert.equal(model(100).frontHeight, 280);
    assert.equal(model(100, 100, { width: 36 }).frontHeight, model(100).frontHeight);
    assert.equal(model(20).depthY, model(80).depthY);
    assert.equal(model(20).depthX, model(80).depthX);
    assert.ok(model(100).faceted);
    assert.ok(model(100).depthY > 0);
    assert.equal(model(100).height, 280 + model(100).rise + model(100).depthY);
});

test("zero has no data paint while tiny positives use the disclosed minimum visual height", () => {
    assert.equal(model(0).height, 0);
    assert.equal(model(0).faceted, false);
    assert.equal(charts.svg({ total: 0, maximum: 100, values: values(0) }), "");
    const tiny = model(1, 100_000);
    assert.equal(tiny.frontHeight, 36);
    assert.equal(tiny.rawFrontHeight, 1 / 100_000 * 280);
    assert.equal(tiny.adjusted, true);
    assert.equal(tiny.height, tiny.frontHeight + tiny.rise + tiny.depthY);
    for (const value of [-1, NaN, Infinity, .5]) assert.throws(() => model(value), /safe count/);
    assert.throws(() => model(101), /maximum/);
    assert.throws(() => model(1, 0), /maximum/);
    assert.throws(() => model(1, 100, { width: 0 }), /positive/);
});

test("approved small-value cases retain real facets and a centered projected axis", () => {
    for (const width of [36, 60, 116]) for (const total of [9, 28, 9, 121, 50, 2]) {
        const column = model(total, 121, { width });
        assert.ok(column.faceted);
        assert.equal(column.frontHeight, Math.max(36, Math.sqrt(total / 121) * 280));
        assert.equal(column.paintedCenter, column.paintedWidth / 2);
        assert.ok(Math.abs(column.frontCenter - column.paintedCenter - column.depthX / 2) < 1e-12);
        assert.equal(column.frontWidth + column.depthX, width);
        assert.ok(column.rise + column.depthY < width * .2 + 1e-10, "Restrained depth cannot hide a small vertical band");
    }
    assert.ok(model(2, 121, { width: 60 }).frontHeight >= 36);
    assert.ok(model(1, 121).frontHeight >= 36);
});

test("stacked results preserve exact counts and contiguous boundaries without mutating inputs", () => {
    const input = { total: 100, maximum: 200, values: values(81, 19) }, before = structuredClone(input);
    const column = charts.layout(input);
    assert.equal(column.frontHeight, Math.sqrt(.5) * 280);
    assert.ok(Math.abs(column.segments[0].height - .81 * column.frontHeight) < 1e-10);
    assert.ok(Math.abs(column.segments[1].height - .19 * column.frontHeight) < 1e-10);
    assert.equal(column.segments[0].top, column.segments[1].bottom);
    assert.equal(column.segments.at(-1).top, 0);
    assert.equal(column.segments.reduce((sum, part) => sum + part.count, 0), 100);
    assert.deepEqual(input, before);
    assert.throws(() => charts.layout({ ...input, total: 101 }), /must equal/);
    assert.throws(() => charts.layout({ ...input, values: { success: 100 } }), /Every recorded/);
});

test("SVG uses actual projected faces, restrained glass and a nonsemantic lid, not flat gradient rectangles", () => {
    const first = charts.svg({ total: 100, maximum: 100, values: values(100) }, "time-stack");
    const second = charts.svg({ total: 40, maximum: 100, service: "Mail" });
    for (const token of ["matrix(1 -.18", "dimensional-side", "dimensional-cap-clear", "dimensional-glint", "linearGradient"]) assert.ok(first.includes(token));
    assert.match(second, /dimensional-tone-service-mail/);
    assert.match(first, /data-front-height="280"/);
    assert.ok(first.indexOf('class="dimensional-cap ') < first.indexOf('class="dimensional-front '));
    assert.doesNotMatch(first.replace('xmlns="http://www.w3.org/2000/svg"', ""), /https?:|<script|foreignObject|animate/);
    assert.throws(() => charts.svg({ total: 1, maximum: 1, values: values(1) }, '"><script>'), /classes/);
});

test("one level plane uses constant projection and non-overlapping slots", () => {
    for (const length of [0, 1, 2, 4, 9, 45]) {
        const scene = charts.scene({ length, maximum: 100 });
        assert.equal(scene.recede, 0);
        assert.equal(scene.dimensions.frontHeight, 280);
        for (const [index, column] of scene.columns.entries()) {
            assert.equal(column.base, scene.base);
            assert.equal(column.offset, 0);
            if (index) assert.ok(column.center - scene.columns[index - 1].center - 116 >= 8);
        }
        assert.equal(charts.scene({ length, maximum: 100, time: true }).recede, 0);
    }
    const plane = charts.plane(charts.scene({ length: 4, maximum: 100 }));
    assert.match(plane, /aria-hidden="true"/);
    assert.match(plane, /dimensional-ground-surface/);
    assert.match(plane, /dimensional-ground-edge/);
    assert.doesNotMatch(plane, /filter|dimensional-reflection/);
});

test("ordering and report chunking cannot move a shared scale's zero baseline", () => {
    const maximum = 100000, base = charts.scene({ length: 1, maximum }).base;
    for (const totals of [[0], [1], [28, 75, 28], [0, 1, maximum], [maximum, 1, 0], [75, 28], [28, 75]]) {
        const scene = charts.scene({ length: totals.length, maximum, totals });
        assert.equal(scene.base, base);
        assert.ok(scene.columns.every(column => column.base === base));
    }
    assert.throws(() => charts.scene({ length: 2, maximum, totals: [1] }), /Scene counts/);
    assert.throws(() => charts.scene({ length: 1, maximum, totals: [maximum + 1] }), /Scene counts/);
});

test("browser factory stays serializable and unknown service identity is never worked", () => {
    const browserFactory = new Function(`return (${createDimensionalCharts.toString()})()`)();
    for (const value of ["Unknown", "unrecognized", "constructor", "__proto__"]) assert.equal(browserFactory.tone(value), "service-unknown");
    assert.deepEqual(browserFactory.layout({ total: 1, maximum: 1, values: values(1) }), model(1, 1));
});
