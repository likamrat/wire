import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { styles } from "../web/styles.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture } from "./helpers.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { distance } from "./color-measurements.mjs";

const keys = ["success", "failure", "unknown", "partial", "other", "transport"];
function analyticsFor(values, services, revision = 1) {
    const total = values.reduce((a, b) => a + b, 0), record = fixture("tiny-proof");
    record.toolCalls = Array.from({ length: total }, (_, i) => ({ ...record.toolCalls[0], toolCallId: `tiny-${i}`, startEventId: `tiny-start-${i}` }));
    const analytics = { ...buildActivityAnalytics(total ? [record] : []), revision };
    const outcomes = values.flatMap((count, i) => Array(count).fill(keys[i]));
    const workloads = (services || [["Mail", total]]).flatMap(([name, count]) => Array(count).fill(name));
    assert.equal(workloads.length, total);
    for (const key of keys) analytics.totals[key] = 0;
    analytics.rows.forEach((row, i) => { row.outcome = outcomes[i]; row.workload = workloads[i]; analytics.totals[row.outcome]++; });
    analytics.workloadGroups = [...new Set(workloads)].map(label => ({ label, total: workloads.filter(value => value === label).length }));
    return analytics;
}
async function setup(t) {
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1100 }, hasTouch: true });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); });
    await page.route("**/*", route => route.abort());
    await page.setContent(`<html data-evidence-theme="dark"><style>${styles}</style><main id="host" style="width:100%;margin:0;padding:16px"></main></html>`);
    await page.evaluate(({ columns, percentages, categories, results, ux, icons, services }) => {
        const make = source => (0, eval)(`(${source})`);
        window.visits = [];
        window.charts = make(percentages)({ dimensional: make(columns)(), categories: make(categories)(), results: make(results)(),
            ux: make(ux)(icons), icons: services, createLink: (kind, row) => {
                if (kind === "tools" || kind === "services" && row.id === "group:other") return null;
                const link = document.createElement("a"); link.href = `#${kind}-${row.id}`;
                link.onclick = event => { event.preventDefault(); window.visits.push([kind, row.id]); };
                return link;
            } });
        window.view = window.charts.mount(document.querySelector("#host"));
    }, { columns: createDimensionalCharts.toString(), percentages: createPercentageCharts.toString(), categories: createServiceCategories.toString(),
        results: createRecordedResults.toString(), ux: createEvidenceUX.toString(), icons: uxIcons, services: dimensionalIcons });
    return page;
}
const update = (page, analytics, filters = {}) => page.evaluate(({ analytics, filters }) => window.view.update(analytics, { layer: "tool", filters }), { analytics, filters });
// Canonical shares stay exact; user-approved visual minimums are disclosed.
async function verify(page, total) {
    assert.equal(await page.locator(".percentage-locator,.percentage-associations,.ux-help").count(), 0);
    assert.equal(await page.locator(".percentage-ring").count(), total ? 2 : 0);
    for (const card of await page.locator(".percentage-card").all()) {
        const rows = await card.locator(".percentage-legend-row").evaluateAll(nodes => nodes.map(row => ({
            count: +row.dataset.count, text: row.textContent, height: row.getBoundingClientRect().height,
        })));
        assert.equal(rows.reduce((sum, row) => sum + row.count, 0), total);
        for (const row of rows) assert.ok(row.height >= 44);
        const slices = await card.locator(".percentage-slice").evaluateAll(nodes => nodes.map(slice => ({
            count: +slice.dataset.count, fraction: +slice.dataset.end - +slice.dataset.start, exact: +slice.dataset.exactFraction,
            thin: slice.dataset.thin === "true", opacity: getComputedStyle(slice).fillOpacity, stroke: getComputedStyle(slice).stroke,
        })));
        assert.equal(slices.reduce((sum, slice) => sum + slice.count, 0), total);
        for (const slice of slices) {
            assert.equal(slice.exact, slice.count / total);
            assert.ok(slice.fraction >= .03 - 1e-12, "Every positive category has the disclosed minimum visual slice");
            if (slice.thin) { assert.equal(slice.opacity, "1"); assert.equal(slice.stroke, "none"); }
        }
        if (!await card.locator("details").evaluate(node => node.open)) await card.locator("summary").click();
        assert.equal(await card.locator("tfoot td").first().textContent(), total.toLocaleString());
        assert.equal((await card.locator("tbody td:first-of-type").allTextContents()).reduce((sum, text) => sum + Number(text.replaceAll(",", "")), 0), total);
    }
}
test("193/25/1 remains numerically exact with a visible enlarged small slice and no leader", async t => {
    const page = await setup(t); await update(page, analyticsFor([193, 25, 1])); await verify(page, 219);
    const row = page.locator('[data-percentage-card=outcomes] .percentage-legend-row[data-category=unknown]');
    assert.equal(await row.locator(".percentage-value").textContent(), "0.5% (1)");
    assert.match(await row.locator("a").getAttribute("aria-label"), /No result recorded: 1 of 219/);
});
test("one-of-219 paints a usable enlarged slice at natural size and supports actual mark and label actions", async t => {
    const page = await setup(t), proof = [];
    await update(page, analyticsFor([193, 25, 1]));
    for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => document.documentElement.dataset.evidenceTheme = theme, theme);
        await page.evaluate(() => document.fonts.ready);
        const card = page.locator('[data-percentage-card=outcomes]');
        await card.scrollIntoViewIfNeeded();
        const wall = card.locator('.percentage-outer-wall[data-category=unknown]');
        const measured = await wall.evaluate(node => {
            const svg = node.closest("svg"), f = window.charts.frame();
            const p = window.charts.point(f.outer, (+node.dataset.start + +node.dataset.end) / 2, f.depth / 2);
            const screen = new DOMPoint(p.x, p.y).matrixTransform(node.getScreenCTM());
            const bounds = svg.getBoundingClientRect(), band = node.getBoundingClientRect();
            return { x: screen.x, y: screen.y, localX: screen.x - bounds.x, localY: screen.y - bounds.y,
                width: band.width, height: band.height, ringWidth: bounds.width,
                background: getComputedStyle(node.closest(".percentage-card")).backgroundColor.match(/\d+/g).map(Number).slice(0, 3) };
        });
        assert.equal(measured.ringWidth, 360, "Evidence is natural layout size, not a magnified crop");
        assert.ok(measured.width > 28 && measured.height >= 33, "The authorized minimum slice is visibly targetable, not another hairline");
        const image = await card.locator(".percentage-ring").screenshot();
        const pixels = await page.evaluate(async ({ image, measured }) => {
            const img = new Image(); img.src = image; await img.decode();
            const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
            const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0);
            const samples = Array.from({ length: 17 }, (_, i) =>
                [...ctx.getImageData(Math.round(measured.localX) + i - 8, Math.round(measured.localY), 1, 1).data].slice(0, 3));
            const visible = color => color.some((v, i) => Math.abs(v - measured.background[i]) >= 12);
            return { samples, materialPixels: samples.filter(visible).length };
        }, { image: `data:image/png;base64,${image.toString("base64")}`, measured });
        assert.ok(pixels.materialPixels >= 12, "The enlarged category is a painted surface, not just a larger invisible hit area");
        await page.mouse.click(measured.x, measured.y);
        const label = card.locator('.percentage-legend-row[data-category=unknown] .percentage-label');
        await label.focus(); await page.keyboard.press("Enter");
        assert.deepEqual((await page.evaluate(() => window.visits)).slice(-2), [["outcomes", "unknown"], ["outcomes", "unknown"]]);
        assert.equal(await label.evaluate(node => getComputedStyle(node).textDecorationLine), "none");
        assert.equal(await label.evaluate(node => getComputedStyle(node).outlineStyle), "solid");
        await page.locator("h3").first().click();
        proof.push({ theme, ...measured, ...pixels });
        if (process.env.WORKIQ_PERCENTAGE_PROOFS) {
            await mkdir(process.env.WORKIQ_PERCENTAGE_PROOFS, { recursive: true });
            await card.screenshot({ path: path.join(process.env.WORKIQ_PERCENTAGE_PROOFS, `tiny-natural-${theme}.png`) });
        }
    }
    t.diagnostic(JSON.stringify(proof));
    if (process.env.WORKIQ_PERCENTAGE_PROOFS) await writeFile(path.join(process.env.WORKIQ_PERCENTAGE_PROOFS, "tiny-natural.json"), JSON.stringify(proof, null, 2));
});
test("unknown, mixed-service and Other hover/focus visibly select only their own actual donut faces", async t => {
    const page = await setup(t), decoder = await page.context().browser().newPage();
    await update(page, analyticsFor([193, 25, 1], [["Search", 76], ["Unknown", 70], ["Calendar", 21], ["Mail", 20],
        ["Multiple workloads", 2], ["Teams", 20], ["Files", 6], ["People", 2], ["Tasks", 2]]));
    await page.evaluate(() => document.fonts.ready);
    const selected = panel => panel.locator(".percentage-face.percentage-active").evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.category))]);
    for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => document.documentElement.dataset.evidenceTheme = theme, theme);
        for (const [card, category, expected] of [["outcomes", "unknown", "0.5% (1)"], ["composition", "Multiple workloads", "0.9% (2)"], ["composition", "group:other", "13.7% (30)"]]) {
            const panel = page.locator(`[data-percentage-card="${card}"]`), row = panel.locator(`.percentage-legend-row[data-category="${category}"]`);
            assert.match(await panel.locator(".percentage-denominator").textContent(), /small slices enlarged/, "A standalone donut discloses its adjusted angles in the existing unit line");
            const label = row.locator(".percentage-label");
            await panel.scrollIntoViewIfNeeded(); await page.evaluate(() => document.activeElement.blur()); await page.mouse.move(1, 1);
            const wall = panel.locator(`.percentage-outer-wall[data-category="${category}"]`).first();
            const point = await wall.evaluate(node => {
                const f = window.charts.frame(), p = window.charts.point(f.outer, (+node.dataset.start + +node.dataset.end) / 2, f.depth / 2);
                const screen = new DOMPoint(p.x, p.y).matrixTransform(node.getScreenCTM());
                const box = node.closest("svg").getBoundingClientRect();
                return { x: screen.x, y: screen.y, localX: screen.x - box.x, localY: screen.y - box.y };
            });
            const sample = async () => decoder.evaluate(async ({ image, point }) => {
                const img = new Image(); img.src = image; await img.decode();
                const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
                const context = canvas.getContext("2d"); context.drawImage(img, 0, 0);
                return `rgb(${[...context.getImageData(Math.floor(point.localX), Math.floor(point.localY), 1, 1).data].slice(0, 3)})`;
            }, { image: `data:image/png;base64,${(await panel.locator(".percentage-ring").screenshot()).toString("base64")}`, point });
            const before = await sample();
            await label.hover();
            assert.deepEqual(await selected(panel), [category]);
            const after = await sample();
            assert.ok(distance(before, after) >= 3, `${theme}/${category}: the actual face, not just a CSS class, visibly changes`);
            assert.equal(await row.locator(".percentage-value").textContent(), expected);
            assert.equal(await row.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
            await page.mouse.move(1, 1);
            await page.mouse.move(point.x, point.y);
            assert.deepEqual(await selected(panel), [category], "Direct face hover maps to the same legend category");
            await page.keyboard.press("Tab"); await label.focus();
            assert.deepEqual(await selected(panel), [category], "Keyboard inspection has the same unambiguous in-chart state");
            assert.equal(await label.evaluate(node => getComputedStyle(node).outlineStyle), "solid");
            if (category === "group:other") {
                const visits = await page.evaluate(() => window.visits.length);
                await page.keyboard.press("Enter");
                assert.equal(await page.evaluate(() => window.visits.length), visits, "Informational Other inspection does not invent a filter action");
                const peer = panel.locator('.percentage-outer-wall[data-category="Search"]').first();
                const peerPoint = await peer.evaluate(node => {
                    const f = window.charts.frame(), p = window.charts.point(f.outer, (+node.dataset.start + +node.dataset.end) / 2, f.depth / 2);
                    const screen = new DOMPoint(p.x, p.y).matrixTransform(node.getScreenCTM());
                    return { x: screen.x, y: screen.y };
                });
                await page.mouse.move(peerPoint.x, peerPoint.y);
                assert.deepEqual(await selected(panel), ["Search"]);
                await page.keyboard.press("Tab"); await label.focus();
                assert.deepEqual(await selected(panel), [category]);
                await page.mouse.move(peerPoint.x + 1, peerPoint.y);
                assert.deepEqual(await selected(panel), ["Search"], "Resuming pointer movement inside a face supersedes the prior keyboard inspection");
            }
        }
    }
});
test("zero/full/balanced/extreme and adjacent tiny categories reconcile exact counts", async t => {
    const page = await setup(t);
    for (const values of [[0, 0, 0], [1, 0, 0], [1, 1, 1], [999, 0, 1], [997, 1, 1, 1], [998, 1, 1], [9999, 0, 1], [193, 25, 1], [193, 25, 2]]) {
        const analytics = analyticsFor(values, undefined, values.reduce((a, b) => a + b));
        await update(page, analytics); await verify(page, analytics.totals.count);
        assert.equal(await page.locator(".percentage-section").getAttribute("data-revision"), String(analytics.revision));
        if (values[0] === 9999) assert.equal(await page.locator('[data-percentage-card=outcomes] [data-category=unknown] .percentage-value').textContent(), "<0.1% (1)");
    }
});
test("reserved unknown/multiple service identities survive an aggregated majority", async t => {
    const page = await setup(t), services = ["Mail", "Teams", "Files", "Tasks", "Calendar", "Notes"].map(name => [name, 100]);
    services.push(["Unknown", 1], ["Multiple workloads", 1]);
    await update(page, analyticsFor([600, 1, 1], services)); await verify(page, 602);
    for (const id of ["Unknown", "Multiple workloads"]) assert.equal(await page.locator(`[data-percentage-card=composition] .percentage-legend-row[data-category="${id}"]`).getAttribute("data-count"), "1");
    assert.equal(await page.locator('.percentage-legend-row[data-category="group:other"]').getAttribute("data-count"), "300");
});
test("tiny categories stay independent around quarter-turn boundaries", async t => {
    const page = await setup(t);
    for (const [count, largest] of [[12, 100], [6, 300]]) {
        const services = Array.from({ length: count }, (_, i) => [`Synthetic service ${i}`, i < 3 ? largest : 100]);
        services.push(["Unknown", 1], ["Multiple workloads", 1]);
        const total = services.reduce((sum, row) => sum + row[1], 0);
        await update(page, analyticsFor([total - 2, 1, 1], services)); await verify(page, total);
    }
});
test("one-call outcome uses visible native pointer/keyboard/touch actions without hover", async t => {
    const page = await setup(t); await update(page, analyticsFor([193, 25, 1]));
    const link = page.locator('[data-percentage-card=outcomes] [data-category=unknown] a');
    await link.hover(); await page.waitForTimeout(250); assert.equal(await page.getByRole("tooltip").isVisible(), false);
    await link.click(); await link.focus(); await page.keyboard.press("Enter"); await link.tap();
    assert.deepEqual(await page.evaluate(() => window.visits), Array(3).fill(["outcomes", "unknown"]));
    assert.ok((await link.boundingBox()).height >= 44);
});
test("legend interaction is text-sized and never paints the rejected full-row hover block", async t => {
    const page = await setup(t); await update(page, analyticsFor([193, 25, 1]));
    const scope = page.locator(".percentage-scope");
    assert.equal(await page.locator(".percentage-section").getAttribute("aria-describedby"), await scope.getAttribute("id"));
    assert.match(await scope.textContent(), /Share of this applied view/);
    assert.equal(await scope.evaluate(node => node.classList.contains("visually-hidden")), true);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 1], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.evaluate(({ theme, scale }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = `${scale * 100}%`;
        }, { theme, scale });
        const row = page.locator('[data-percentage-card=outcomes] .percentage-legend-row[data-category=unknown]');
        const link = row.locator(".percentage-label");
        await link.hover();
        assert.equal(await row.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
        assert.equal(await link.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
        assert.equal(await link.evaluate(node => getComputedStyle(node).textDecorationLine), "none");
        assert.equal(await link.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        await link.focus();
        assert.equal(await link.evaluate(node => getComputedStyle(node).outlineStyle), "solid");
        assert.ok(await link.evaluate(node => parseFloat(getComputedStyle(node).borderRadius)) > 0);
        assert.ok((await link.boundingBox()).height >= 44);
    }
});
test("375px legends keep fitting label/value pairs on one row and wrap only enlarged labels", async t => {
    const page = await setup(t); await update(page, analyticsFor([193, 25, 1]));
    await page.setViewportSize({ width: 375, height: 1100 });
    for (const theme of ["light", "dark"]) for (const scale of [1, 2]) {
        await page.evaluate(({ theme, scale }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = `${scale * 100}%`;
        }, { theme, scale });
        const rows = await page.locator('[data-percentage-card=outcomes] .percentage-legend-row').evaluateAll(nodes => nodes.map(row => {
            const label = row.querySelector(".percentage-label"), value = row.querySelector(".percentage-value");
            const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
            const font = getComputedStyle(label), canvas = document.createElement("canvas").getContext("2d");
            canvas.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
            const longestWord = Math.max(...label.textContent.split(/\s+/).map(word => canvas.measureText(word).width));
            return { name: label.textContent, label: box(label), value: box(value), longestWord, clipped: [label, value].some(node => node.scrollWidth > node.clientWidth + 1) };
        }));
        for (const row of rows) {
            assert.ok(row.value.x >= row.label.right - 1, `${row.name}: no forced indented value line`);
            assert.ok(row.value.y < row.label.bottom && row.value.bottom > row.label.y, `${row.name}: label and value share a row`);
            assert.ok(Math.abs(row.value.right - rows[0].value.right) < 1, "Numeric right edges stay aligned");
            assert.equal(row.clipped, false);
            assert.ok(row.label.width >= row.longestWord - 1, `${row.name}: ordinary words wrap intact instead of stranding a final letter`);
        }
        if (scale === 1) assert.ok(rows.every(row => row.label.height <= 44), "All reference labels fit at normal text size");
        else assert.ok(rows.at(-1).label.height > rows[0].label.height, "Only the longer enlarged label needs more lines");
    }
});
test("adjacent tiny rows remain readable at 320/375/768/1200/2560 and 100/200% text in both themes", async t => {
    const page = await setup(t); await update(page, analyticsFor([997, 1, 1, 1]));
    for (const theme of ["light", "dark"]) for (const width of [320, 375, 768, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.evaluate(({ theme, scale }) => { document.documentElement.dataset.evidenceTheme = theme; document.documentElement.style.fontSize = `${scale * 100}%`; }, { theme, scale });
        await verify(page, 1000);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(await page.locator(".percentage-label,.percentage-value").evaluateAll(nodes => nodes.filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent)), []);
    }
});
test("multiple chart instances and replaced rows never resurrect removed help", async t => {
    const page = await setup(t), analytics = analyticsFor([193, 25, 1]);
    await update(page, analytics);
    await page.evaluate(analytics => { const host = document.createElement("div"); document.body.append(host); window.charts.mount(host).update(analytics, { layer: "tool", filters: {} }); }, analytics);
    const link = page.locator('#host [data-category=unknown] a').first();
    await link.focus(); await link.hover(); await page.keyboard.press("Escape");
    await update(page, { ...analytics, revision: 2 }, { scope: "all" });
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    assert.equal(await link.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator(".percentage-section").count(), 2);
});
