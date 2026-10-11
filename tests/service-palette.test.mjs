import test from "node:test";
import assert from "node:assert/strict";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { dimensionalColumnStyles } from "../web/dimensional-charts-styles.mjs";
import { tokens } from "../web/tokens.mjs";
import { contrast, hue, pairwise } from "./color-measurements.mjs";

const charts = createDimensionalCharts();
const ids = [...serviceCategories.entries.map(entry => entry.id), "group:other"];

test("every classifier category and Other owns a distinct non-red service palette, independent of results", () => {
    assert.deepEqual(Object.keys(charts.servicePalette), ids);
    assert.equal(new Set(ids.map(id => charts.tone(id))).size, ids.length);
    assert.ok(Object.isFrozen(charts.servicePalette));
    for (const theme of ["light", "dark"]) {
        const themeTokens = tokens.match(new RegExp(`:root\\[data-evidence-theme=${theme}\\] \\{([^}]+)\\}`))[1];
        const backgrounds = ["paper", "canvas", "hover"].map(role => themeTokens.match(new RegExp(`--${role}:(#[a-f0-9]+);`))[1]);
        for (const face of ["top", "mid", "base", "side", "cap", "label"]) {
            const colors = ids.map(id => charts.servicePalette[id][theme][face]);
            assert.equal(new Set(colors).size, ids.length, `${theme} ${face} must not reuse colors`);
            for (const color of colors) {
                const angle = hue(color);
                assert.ok(angle === null || angle >= 40 && angle <= 280, `${theme} ${face} excludes red, pink and coral: ${color} (${angle})`);
            }
        }
        for (const face of ["label", "mid"]) {
            const pairs = pairwise(Object.fromEntries(ids.map(id => [id, charts.servicePalette[id][theme][face]])));
            assert.equal(pairs.length, ids.length * (ids.length - 1) / 2);
            assert.ok(pairs[0].distance >= 7, `${theme} ${face} OKLab distance (x100): ${JSON.stringify(pairs[0])}`);
        }
        for (const id of ids) {
            const entry = charts.servicePalette[id];
            assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry[theme]));
            for (const background of backgrounds) assert.ok(contrast(entry[theme].label, background) >= 4.5, `${id} ${theme} label on ${background}`);
            if (theme === "light") assert.ok(contrast(entry.light.label, "#ffffff") >= 4.5, `${id} on native report paper`);
            for (const [face, color] of Object.entries(entry[theme])) {
                assert.ok(dimensionalColumnStyles.includes(`--chart-${entry.token}-${face}:${color};`));
            }
            assert.ok(!Object.values(charts.outcomeTones).includes(entry.token));
        }
    }
    assert.deepEqual(charts.outcomeTones, { success: "teal", failure: "pink", partial: "orange", unknown: "slate", other: "violet", transport: "cyan" });
});

test("service colors survive factory serialization, reordering, subsets, zero and unrelated outcomes", () => {
    const browser = Function(`return (${createDimensionalCharts.toString()})()`)();
    assert.deepEqual(browser.servicePalette, charts.servicePalette);
    const orders = [ids, [...ids].reverse(), ids.filter((_, index) => index % 2), [ids[9]], [], [...ids.slice(5), ...ids.slice(0, 5)]];
    for (const order of orders) for (const service of order) for (const total of [0, 1, 9, 121]) {
        assert.equal(browser.tone(service), charts.servicePalette[service].token);
        const geometry = browser.layout({ total, maximum: 121, service, plotHeight: 200 });
        assert.equal(geometry.frontHeight, total ? Math.max(36, Math.sqrt(total / 121) * 200) : 0);
        if (total) {
            assert.equal(geometry.segments[0].tone, charts.servicePalette[service].token);
            assert.equal(geometry.segments[0].key, "category");
        }
    }
    for (const other of ["group:other", "Other", "Other (4 groups)", "Other (11 groups)"]) assert.equal(browser.tone(other), "service-other");
    for (const unknown of ["not a service", "constructor", "__proto__", undefined]) assert.equal(browser.tone(unknown), "service-unknown");
    assert.notEqual(browser.tone("group:other"), browser.tone("Unknown"));
});
