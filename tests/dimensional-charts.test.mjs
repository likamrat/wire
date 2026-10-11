import test from "node:test";
import assert from "node:assert/strict";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";

const charts = createDimensionalCharts();
const values = (success, failure = 0) => ({ success, failure, unknown: 0, partial: 0, other: 0, transport: 0 });

test("flat time columns use one exact linear scale without minimum bodies or result sections", () => {
    const maximum = 100_000, plotHeight = 200;
    for (const total of [0, 1, 2, 20, 200, maximum]) {
        const input = { total, maximum, plotHeight, values: values(Math.max(0, total - 1), Math.min(1, total)) };
        const original = structuredClone(input), flat = charts.flatLayout(input);
        assert.equal(flat.height, total / maximum * plotHeight);
        assert.ok(Math.abs(flat.segments.reduce((sum, segment) => sum + segment.height, 0) - flat.height) < 1e-12);
        assert.equal(flat.segments.reduce((sum, segment) => sum + segment.count, 0), total);
        for (const segment of flat.segments) assert.ok(Math.abs(segment.height - segment.count / maximum * plotHeight) < 1e-12);
        assert.deepEqual(input, original);
        const svg = charts.flatSvg(input);
        if (!total) assert.equal(svg, "");
        else {
            assert.match(svg, /aria-hidden="true"/);
            assert.doesNotMatch(svg, /matrix|transform|path |stroke|glint|cap|side|ground/);
            assert.equal((svg.match(/<linearGradient /g) || []).length, flat.segments.length);
            for (const reference of svg.matchAll(/fill="url\(#([^"]+)\)"/g)) assert.ok(svg.includes(`id="${reference[1]}"`));
        }
    }
    const browser = new Function(`return (${createDimensionalCharts.toString()})()`)();
    const mixed = { total: 121, maximum: 200, values: { success: 50, unknown: 9, partial: 28, other: 9, transport: 2, failure: 23 } };
    assert.deepEqual(browser.flatLayout(mixed), charts.flatLayout(mixed));
    const withoutSequence = svg => svg.replaceAll(/flat-time-\d+-/g, "flat-time-id-");
    assert.equal(withoutSequence(browser.flatSvg(mixed)), withoutSequence(charts.flatSvg(mixed)));
    assert.notEqual(browser.flatSvg(mixed), browser.flatSvg(mixed), "Repeated charts never share local gradient IDs");
    assert.deepEqual(charts.flatLayout(mixed).segments.map(part => part.key), ["unknown", "success", "partial", "other", "transport", "failure"]);
    assert.equal(charts.flatLayout({ total: 1, maximum: 200, values: values(1), service: "Files" }).height, 1);
    const extreme = charts.flatLayout({ total: Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER,
        values: values(Number.MAX_SAFE_INTEGER - 1, 1) });
    assert.equal(extreme.segments.at(-1).height, 1 / Number.MAX_SAFE_INTEGER * 200, "Subtraction of painted heights cannot erase a tiny positive segment");
});

test("flat count geometry rejects invalid values and preserves contiguous exact outcome boundaries", () => {
    const input = { total: 4, maximum: 4, values: values(3, 1) };
    const flat = charts.flatLayout(input);
    assert.equal(flat.segments[0].top, flat.segments[1].bottom);
    assert.equal(flat.segments.at(-1).top, 0);
    for (const total of [-1, .5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => charts.flatLayout({ ...input, total }), /safe count/);
    assert.throws(() => charts.flatLayout({ ...input, maximum: 3 }), /denominator/);
    assert.throws(() => charts.flatLayout({ ...input, values: values(4, 1) }), /must equal/);
    assert.throws(() => charts.flatLayout({ ...input, values: { success: 4 } }), /Every recorded/);
    for (const width of [0, -1, Infinity]) assert.throws(() => charts.flatLayout({ ...input, width }), /positive/);
    for (const plotHeight of [0, -1, Infinity]) assert.throws(() => charts.flatLayout({ ...input, plotHeight }), /positive|finite/);
});

test("shared span validates exact counts independently of presentation", () => {
    for (const extent of [0, 100, 200, 360]) for (const total of [0, 1, 2, 20, 200]) {
        assert.equal(charts.geometryPolicy.span(total, 200, extent), total / 200 * extent);
    }
    assert.equal(charts.geometryPolicy.span(0, 0, 200), 0);
    for (const invalid of [-1, NaN, Infinity, .5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => charts.geometryPolicy.span(invalid, 200, 200));
        assert.throws(() => charts.geometryPolicy.span(1, invalid, 200));
    }
    assert.throws(() => charts.geometryPolicy.span(201, 200, 200));
    for (const extent of [-1, Infinity, NaN]) assert.throws(() => charts.geometryPolicy.span(1, 200, extent));
});

test("browser factory stays serializable and unknown service identity is never worked", () => {
    const browserFactory = new Function(`return (${createDimensionalCharts.toString()})()`)();
    for (const value of ["Unknown", "unrecognized", "constructor", "__proto__"]) assert.equal(browserFactory.tone(value), "service-unknown");
    const input = { total: 1, maximum: 1, values: values(1) };
    assert.deepEqual(browserFactory.flatLayout(input), charts.flatLayout(input));
    const svg = browserFactory.flatSvg({ total: 1, maximum: 1, service: '"><script>' });
    assert.match(svg, /dimensional-tone-service-unknown/);
    assert.doesNotMatch(svg.replace('xmlns="http://www.w3.org/2000/svg"', ""), /https?:|<script|foreignObject|animate/);
});
