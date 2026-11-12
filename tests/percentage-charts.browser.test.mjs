import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { styles } from "../web/styles.mjs";
import { fixture } from "./helpers.mjs";
import { coworkFixture } from "./native-read-model-fixtures.mjs";
import { projectRetainedNativeRecords } from "../lib/retained-population.mjs";
import { createPromptAuthorship } from "../lib/prompt-authorship.mjs";

async function setup(t, locale = "en-US", includeAuthors = false) {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ locale, viewport: { width: 1200, height: 1000 }, hasTouch: true, reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
    t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(requests, []); });
    await page.setContent(`<style>${styles}</style><div id="host" style="width:100%;max-width:100%;padding:16px"></div>`);
    await page.evaluate(({ percentage, dimensional, categories, results, ux, icons, serviceIcons, authorship, includeAuthors }) => {
        const make = source => (0, eval)(`(${source})`);
        window.chosen = [];
        window.view = make(percentage)({ dimensional: make(dimensional)(), categories: make(categories)(),
            results: make(results)(), ux: make(ux)(icons), icons: serviceIcons, authorship: make(authorship)(),
            createLink: (kind, row) => {
                const link = document.createElement("a");
                link.href = `#analyze?test=${encodeURIComponent(row.id)}`;
                link.addEventListener("click", event => { event.preventDefault(); window.chosen.push([kind, row.id]); });
                return link;
            },
        }).mount(document.querySelector("#host"), { includeAuthors });
    }, { percentage: createPercentageCharts.toString(), dimensional: createDimensionalCharts.toString(),
        categories: createServiceCategories.toString(), results: createRecordedResults.toString(), ux: createEvidenceUX.toString(),
        icons: uxIcons, serviceIcons: dimensionalIcons, authorship: createPromptAuthorship.toString(), includeAuthors });
    return page;
}

test("prompt shares separate native conversations and erase exact authorship facts on withdrawal", async t => {
    const page = await setup(t, "en-US", true), record = fixture("prompt-native-qualification");
    record.userPrompt.authorship = { actor: "user", basis: "source-user" };
    const native = projectRetainedNativeRecords(coworkFixture()).records;
    const card = page.locator('[data-breakdown="authors"]');
    const render = async (records, bounded) => {
        const analytics = buildActivityAnalytics(records);
        await page.evaluate(({ analytics, records, bounded }) => window.view.update(analytics,
            { layer: "tool", filters: {} }, records, bounded), { analytics, records, bounded });
    };
    await render([record, ...native]);
    await expect(card).toHaveAttribute("data-total", "1");
    await expect(card.locator(".percentage-value")).toHaveText(["100% (1)", "0% (0)", "0% (0)"]);
    await expect(card.locator(".percentage-denominator")).toHaveText("GitHub Copilot: 1 matching interaction");
    await expect(card.locator(".percentage-content")).toContainText(`Prompt authorship unavailable for ${native.length} Microsoft 365`);
    const bounded = { aggregates: { complete: true, layer: "tool", conversations: 3, selectedRows: 0,
        outcomes: { success: 0, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0 } },
    toolGroups: { complete: true, groups: [], other: null }, sourceGroups: [] };
    await render([], bounded);
    await expect(card.locator(".percentage-value")).toHaveCount(0);
    await expect(card.locator(".percentage-denominator")).toBeHidden();
    await expect(card.locator(".percentage-content")).toHaveText("Prompt authorship unavailable for 3 Microsoft 365 conversations.");
    await card.locator("summary").click();
    await expect(card.locator(".percentage-exact .percentage-empty")).toHaveCount(1);
    await card.locator("summary").click(); await card.locator("summary").click();
    await expect(card.locator(".percentage-exact .percentage-empty")).toHaveCount(1);
    await render([record]);
    await expect(card.locator(".percentage-denominator")).toBeVisible();
    await expect(card.locator(".percentage-table tbody th")).toHaveText(["My prompts", "Agent prompts", "Author unverified"]);
    await page.evaluate(() => window.view.withdrawAccess());
    await expect(card.locator(".percentage-legend,.percentage-table,[data-count]")).toHaveCount(0);
    assert.equal(await card.getAttribute("data-total"), null);
    await expect(card.locator(".percentage-denominator")).toBeEmpty();
});
async function update(page, counts, longNames = false) {
    const record = fixture("percentage-regression"), base = record.toolCalls[0];
    record.toolCalls = counts.flatMap((count, outcome) => Array.from({ length: count }, (_, index) => ({
        ...base, toolCallId: `${outcome}-${index}`, startEventId: `start-${outcome}-${index}`,
        tool: base.tool,
        toolSucceeded: outcome === 0 ? true : outcome === 1 ? false : undefined,
        reportedOutcome: ["succeeded", "failed", "unknown"][outcome],
    })));
    const analytics = buildActivityAnalytics([record]);
    if (longNames) analytics.rows.forEach((row, index) => { row.tool = `workiq-long-name-${index}-${"unbroken".repeat(12)}`; });
    await page.evaluate(analytics => window.view.update(analytics, { layer: "tool", filters: {} }), analytics);
    return analytics;
}

test("result chart titles and accessible names follow accepted units and clear on withdrawal", async t => {
    const page = await setup(t), record = fixture("result-title");
    const card = page.locator('[data-percentage-card="outcomes"]');
    const titles = { tool: "Tool call results", "reported-api": "Returned result statuses",
        "direct-request": "Graph request-site status", "recorded-http": "Visible Graph statuses",
        http: "HTTP record results", "code-reference": "Code references" };
    const envelopes = coworkFixture();
    envelopes.find(row => row.record.id === "seq:8").outcomes.nestedApi = {
        unit: "nested-api-result", availability: "recorded", declaredRequestCount: 2,
        declaredRequestCountIsSuccessDenominator: false,
        observed: [{ index: 0, indexKind: "response-array-position", statusCode: 200,
            errorCode: null, paginationPresent: null, evidenceLevel: "intermediary-reported" }],
    };
    const native = projectRetainedNativeRecords(envelopes).records;
    for (const [layer, title] of Object.entries(titles)) {
        const analytics = buildActivityAnalytics([record], { layer });
        await page.evaluate(analytics => window.view.update(analytics, { layer: analytics.layer, filters: {} }), analytics);
        await expect(card).toHaveAccessibleName(title);
        const model = await page.evaluate(() => window.view.referenceModel());
        assert.equal(model.total, analytics.totals.count);
        assert.deepEqual(Object.fromEntries(model.outcomes.rows.map(row => [row.id, row.count])),
            Object.fromEntries(Object.entries(analytics.totals).filter(([key]) => ["success", "failure", "unknown", "partial", "other", "transport"].includes(key))));
        if (analytics.totals.count) await expect(card.locator(".percentage-ring")).toHaveAttribute("aria-label", new RegExp("^" + title + "\\."));
    }
    for (const layer of ["tool", "reported-api"]) {
        const analytics = buildActivityAnalytics([record, ...native], { layer });
        assert.equal(analytics.measurementEligibility.outcomeRate, "separate-unit-populations-only");
        await page.evaluate(analytics => window.view.update(analytics, { layer: analytics.layer, filters: {} }), analytics);
        await expect(card).toHaveAccessibleName("Results by source");
        await expect(card.locator(".percentage-content")).toHaveAttribute("data-unit-mode", "separate");
        assert.equal(await card.locator(".percentage-ring").count(), 0);
        assert.deepEqual(await card.locator("[data-count-unit]").evaluateAll(nodes => nodes.map(node => node.dataset.countUnit)),
            analytics.unitPopulations.map(population => population.unit));
        for (const population of analytics.unitPopulations) {
            const values = card.locator(`[data-count-unit="${population.unit}"] .percentage-value`);
            const results = createRecordedResults(), percentages = createPercentageCharts();
            assert.deepEqual(await values.allTextContents(), results.entries(layer, population.totals)
                .map(entry => `${percentages.percent(entry.count, population.totals.count)} (${entry.count.toLocaleString()})`));
        }
    }
    await page.evaluate(() => window.view.withdrawAccess());
    await expect(card).toHaveAccessibleName("Results");
});

test("access withdrawal drops the chart model and all private exact content without inventing zero", async t => {
    const page = await setup(t);
    const analytics = await update(page, [3, 1, 0]);
    await page.locator("details").first().evaluate(node => { node.open = true; });
    await expect(page.locator(".percentage-table")).toHaveCount(1);
    await page.evaluate(() => { window.view.withdrawAccess(); window.view.withdrawAccess(); });
    assert.equal(await page.evaluate(() => window.view.referenceModel()), null);
    assert.equal(await page.locator(".percentage-table,.percentage-ring,.percentage-legend").count(), 0);
    assert.equal(await page.locator("[data-total],[data-revision],[data-count]").count(), 0);
    assert.equal((await page.locator(".percentage-denominator").allTextContents()).join(""), "");
    assert.equal(await page.evaluate(() => {
        try { window.view.renderExact("outcomes", document.createElement("div")); return false; }
        catch (error) { return error instanceof TypeError; }
    }), true);
    await page.evaluate(analytics => window.view.update(analytics, { layer: "tool", filters: {} }), analytics);
    await expect(page.locator(".percentage-ring")).toHaveCount(1);
});

test("flat outcome paint retains exact tiny/full circles, inert centers, local fills and separate keyboard labels", async t => {
    const page = await setup(t);
    for (const theme of ["light", "dark"]) for (const counts of [[193, 25, 1], [1022, 1, 1], [1, 0, 0], [1, 1, 0], [0, 0, 1], [0, 0, 0]]) {
        await page.evaluate(theme => { document.documentElement.dataset.evidenceTheme = theme; }, theme);
        await update(page, counts);
        const total = counts.reduce((sum, count) => sum + count, 0);
        assert.equal(await page.locator(".percentage-ring").count(), total ? 1 : 0);
        for (const slice of await page.locator(".percentage-slice").all()) {
            const measured = await slice.evaluate(node => {
                const start = +node.dataset.start, end = +node.dataset.end;
                const angle = (start + (end - start) * .37) * Math.PI * 2 + Math.PI / 2;
                const local = new DOMPoint(85 * Math.cos(angle), 85 * Math.sin(angle));
                const point = local.matrixTransform(node.getScreenCTM());
                const id = node.getAttribute("fill").match(/^url\(#(.+)\)$/)[1];
                return { start, end, count: +node.dataset.count, exact: +node.dataset.exactFraction,
                    contains: node.isPointInFill(local), center: node.isPointInFill(new DOMPoint(0, 0)),
                    localFill: Boolean(node.ownerSVGElement.querySelector(`[id="${id}"]`)), x: point.x, y: point.y };
            });
            assert.equal(measured.exact, measured.count / total);
            assert.ok(Math.abs(measured.end - measured.start - measured.exact) < 1e-14);
            assert.ok(measured.contains && measured.localFill && !measured.center, JSON.stringify({ counts, measured }));
            await slice.scrollIntoViewIfNeeded();
            const point = await slice.evaluate(node => {
                const angle = (+node.dataset.start + +node.dataset.end) / 2 * Math.PI * 2 + Math.PI / 2;
                const p = new DOMPoint(85 * Math.cos(angle), 85 * Math.sin(angle)).matrixTransform(node.getScreenCTM());
                return { x: p.x, y: p.y };
            });
            const count = await page.evaluate(() => window.chosen.length);
            await page.mouse.click(point.x, point.y);
            assert.equal(await page.evaluate(() => window.chosen.length), count + 1);
            const category = await slice.getAttribute("data-category");
            assert.deepEqual(await page.evaluate(() => window.chosen.at(-1)), ["outcomes", category]);
            const label = page.locator(`[data-percentage-card="outcomes"] .percentage-legend-row[data-category="${category}"] .percentage-label`);
            await label.focus(); await page.keyboard.press("Enter");
            await expect(label).toBeFocused();
            assert.equal(await page.evaluate(() => window.chosen.length), count + 2);
            assert.equal(await slice.locator("..").getAttribute("tabindex"), "-1");
            assert.ok(await slice.locator("..").evaluate(node => {
                let prevented;
                node.addEventListener("click", event => { prevented = event.defaultPrevented; event.preventDefault(); }, { once: true });
                node.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true, cancelable: true }));
                return !prevented;
            }));
        }
        assert.equal(await page.locator(".percentage-outer-wall,.percentage-inner-wall,.percentage-glint").count(), 0);
    }
});

test("outcome emphasis preserves light fades, accepted dark fills and forced colors with explicit or OS themes", async t => {
    const page = await setup(t);
    await update(page, [6, 1, 1]);
    const label = page.locator('[data-percentage-card="outcomes"] [data-category="failure"] .percentage-label');
    const slice = page.locator('.percentage-slice[data-category="failure"]');
    for (const os of ["light", "dark"]) for (const explicit of [null, "light", "dark"]) {
        await page.emulateMedia({ colorScheme: os, forcedColors: "none" });
        await page.evaluate(theme => {
            if (theme) document.documentElement.dataset.evidenceTheme = theme;
            else document.documentElement.removeAttribute("data-evidence-theme");
        }, explicit);
        await label.focus();
        const paint = await slice.evaluate(node => {
            const css = getComputedStyle(node);
            return { fill: css.fill, filter: css.filter };
        });
        if ((explicit || os) === "light") {
            assert.match(paint.fill, /^url\(/);
            assert.equal(paint.filter, "brightness(0.9)");
        } else {
            assert.equal(paint.fill, "rgb(242, 139, 130)");
            assert.equal(paint.filter, "none");
        }
        await page.emulateMedia({ forcedColors: "active" });
        assert.equal(await slice.evaluate(node => getComputedStyle(node).filter), "none");
        assert.doesNotMatch(await slice.evaluate(node => getComputedStyle(node).fill), /^url\(/);
    }
});

test("all long tool names remain visible with exact tables and stable disclosures across container resize and forced colors", async t => {
    const page = await setup(t);
    await update(page, [20, 20, 5], true);
    const card = page.locator('[data-percentage-card="tools"]');
    assert.equal(await card.locator(".percentage-legend-row").count(), 45);
    const summary = card.locator("summary");
    const before = await summary.evaluate(node => node.getBoundingClientRect().y + scrollY);
    await summary.click(); await expect(card.locator("tbody tr")).toHaveCount(45);
    assert.ok(Math.abs(await summary.evaluate(node => node.getBoundingClientRect().y + scrollY) - before) < 1);
    for (const width of [1200, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale * 100 + "%"; }, scale);
        await summary.focus(); await expect(summary).toBeFocused();
        assert.deepEqual(await card.locator(".percentage-label,tbody th,tbody td,tfoot th,tfoot td").evaluateAll(nodes =>
            nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent)), []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    }
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await expect(card.locator("tfoot")).toContainText("45");
    assert.equal(await card.locator(".percentage-bar").first().evaluate(node => getComputedStyle(node).opacity), "1");
    await page.emulateMedia({ forcedColors: "none" });
    await page.evaluate(() => { document.querySelector("#host").style.filter = "grayscale(1)"; });
    await expect(card.locator("tbody tr")).toHaveCount(45);
});

test("locale count pairs retain zero, one, large and maximum-safe typography without corrupting exact cells", async t => {
    for (const locale of ["en-US", "de-DE", "en-IN"]) {
        const page = await setup(t, locale), format = new Intl.NumberFormat(locale);
        await update(page, [12344, 1, 0]);
        await page.setViewportSize({ width: 375, height: 1200 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        assert.deepEqual(await page.locator('[data-percentage-card="outcomes"] .percentage-value').allTextContents(),
            [`>99.9% (${format.format(12344)})`, "<0.1% (1)", "0% (0)"]);
        for (const card of await page.locator(".percentage-card").all()) {
            await card.locator("summary").click();
            for (const text of await card.locator("tbody td:first-of-type").allTextContents()) assert.doesNotMatch(text, /[()]/);
        }
        await page.locator(".percentage-value span").evaluateAll(nodes => {
            for (const node of nodes) node.textContent = `(${Number.MAX_SAFE_INTEGER.toLocaleString()})`;
        });
        assert.deepEqual(await page.locator(".percentage-value,.percentage-value>*").evaluateAll(nodes =>
            nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent)), []);
        await page.close();
    }
});
