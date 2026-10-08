import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { styles } from "../web/styles.mjs";
import { percentageChartStyles } from "../web/percentage-charts-styles.mjs";
import { fixture, chooseTheme, selectActivityOption, navigateMain, revealStoredRefresh } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_PERCENTAGE_PROOFS;
const paths = ["/me/messages", "/me/calendar", "/me/drive", "/teams", "/me/contacts", "/me/planner/tasks", "/me/onenote", "/groups", null];
const source = paths.flatMap((endpoint, index) => {
    const record = fixture(`percentage-${index}`);
    record.userPrompt.text = "SYNTHETIC ONLY percentage chart request";
    record.toolCalls = Array.from({ length: index + 1 }, (_, number) => ({
        ...record.toolCalls[0], toolCallId: `percentage-call-${index}-${number}`, startEventId: `percentage-start-${index}-${number}`,
        tool: index % 2 ? "workiq-fetch" : "workiq-call_function", startedAt: "2026-09-30T12:00:00Z",
        requestArgs: endpoint ? { entityUrls: [endpoint] } : {}, requestedApiPath: endpoint,
        toolSucceeded: number === 0 ? false : number === 1 ? undefined : true,
        reportedOutcome: number === 1 ? undefined : number === 2 ? "partial" : number === 0 ? "failed" : "succeeded",
    }));
    return [record];
});

async function runFixture(run) {
    let records = structuredClone(source), revision = 1, failure = false, gate = null, malformed = false;
    const requests = [], errors = [], snapshots = [];
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-percentage-fixture'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'");
            res.end(renderHtmlShell("a".repeat(64), "percentage-fixture")); return;
        }
        let text = ""; for await (const chunk of req) text += chunk;
        requests.push({ route: req.url, text });
        res.setHeader("Content-Type", "application/json");
        if (req.url !== "/api/snapshot") { res.statusCode = 403; res.end('{"error":"Percentage proof allows synthetic snapshot reads only."}'); return; }
        const input = JSON.parse(text), analytics = { ...buildActivityAnalytics(records, input), revision };
        if (malformed && analytics.workloadGroups.length) analytics.workloadGroups[0].total++;
        const response = { revision, scenarios: records, exports: [], coverage: { notes: [] }, analytics };
        snapshots.push({ input, analytics });
        if (gate) await gate;
        if (failure) { res.statusCode = 503; res.end('{"error":"Synthetic read failure"}'); return; }
        res.end(JSON.stringify(response));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch(), context = await browser.newContext({ reducedMotion: "reduce" });
    const url = `http://127.0.0.1:${server.address().port}`;
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    try {
        if (proofDir) await mkdir(proofDir, { recursive: true });
        await run({ context, url, requests, snapshots, change: next => { records = next; revision++; }, fail: value => { failure = value; },
            corrupt: value => { malformed = value; },
            hold: () => { let release; gate = new Promise(resolve => { release = resolve; }); return () => { gate = null; release(); }; } });
        assert.deepEqual(errors, []);
        assert.ok(requests.every(request => request.route === "/api/snapshot"), "No source checks, exports or other writes");
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
async function ready(page) {
    await page.locator(".percentage-section").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
}
async function inspect(page) {
    return page.locator(".percentage-section").evaluate(root => {
        const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        return {
            total: Number(root.dataset.total), layer: root.dataset.layer, scope: root.querySelector(".percentage-scope").textContent,
            root: box(root), cards: [...root.querySelectorAll(".percentage-card")].map(card => ({
                box: box(card), text: card.textContent, denominator: card.querySelector(".percentage-denominator").textContent,
                slices: [...card.querySelectorAll(".percentage-slice,.percentage-bar")].filter(mark => +mark.dataset.count > 0).map(slice => ({
                    count: Number(slice.dataset.count), start: Number(slice.dataset.start || 0), end: Number(slice.dataset.end || slice.dataset.fraction),
                    exact: Number(slice.dataset.exactFraction ?? slice.dataset.fraction),
                    category: slice.dataset.category || slice.closest(".percentage-legend-row").dataset.category, d: slice.getAttribute("d"), color: getComputedStyle(slice).getPropertyValue("--column-mid"),
                })),
                rows: [...card.querySelectorAll(".percentage-legend-row")].map(row => ({
                    box: box(row), count: Number(row.dataset.count), category: row.dataset.category, percent: row.dataset.percentage,
                    text: row.textContent, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth,
                    value: row.querySelector(".percentage-value").textContent,
                    formattedCount: Number(row.dataset.count).toLocaleString(),
                    label: box(row.querySelector(".percentage-label")), valueBox: box(row.querySelector(".percentage-value")),
                    labelFont: getComputedStyle(row.querySelector(".percentage-label")).fontSize,
                    percentFont: getComputedStyle(row.querySelector(".percentage-value strong")).fontSize,
                    countFont: getComputedStyle(row.querySelector(".percentage-value span")).fontSize,
                    pairOverflow: [...row.querySelectorAll(".percentage-value,.percentage-value>*")].some(n => n.scrollWidth > n.clientWidth + 1),
                })),
                bottomSpace: box(card).bottom - box(card.querySelector(".percentage-exact")).bottom,
                content: box(card.querySelector(".percentage-content")),
                heading: box(card.querySelector(".percentage-card-heading")),
                footer: box(card.querySelector(".percentage-exact")),
                visual: card.querySelector(".percentage-visual") ? box(card.querySelector(".percentage-visual")) : null,
                legend: card.querySelector(".percentage-legend") ? box(card.querySelector(".percentage-legend")) : null,
                plates: card.querySelectorAll(".percentage-ground,.dimensional-ground-surface,.dimensional-ground-edge,.dimensional-reflection").length,
                svg: card.querySelector("svg.percentage-ring") ? box(card.querySelector("svg.percentage-ring")) : null,
                geometry: card.querySelector(".percentage-ring") ? {
                    viewBox: card.querySelector(".percentage-ring").getAttribute("viewBox"),
                    depth: Number(card.querySelector(".percentage-ring").dataset.depth),
                    projection: card.querySelector(".percentage-top-faces").getAttribute("transform"),
                    innerClip: card.querySelector(".percentage-inner-faces").getAttribute("clip-path"),
                    faces: [...card.querySelectorAll(".percentage-face")].map(face => ({
                        box: box(face), depth: Number(face.dataset.depth), hidden: face.getAttribute("aria-hidden"),
                        start: Number(face.dataset.start), end: Number(face.dataset.end),
                    })),
                } : null,
                counter: card.querySelector(".percentage-center") ? box(card.querySelector(".percentage-center")) : null,
            })),
            pageOverflow: document.documentElement.scrollWidth > innerWidth,
        };
    });
}
async function screenshot(page, file) {
    await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
    const clip = await page.locator(".percentage-section").boundingBox();
    await page.screenshot({ path: path.join(proofDir, file), clip, fullPage: true });
}
async function contrast(page) {
    return page.locator(".percentage-section").evaluate(root => {
        const rgb = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const luminance = value => rgb(value).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
            .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
        const background = node => {
            for (let parent = node; parent; parent = parent.parentElement) {
                const value = getComputedStyle(parent).backgroundColor;
                if (value !== "rgba(0, 0, 0, 0)" && value !== "transparent") return value;
            }
            throw new Error("No opaque chart background");
        };
        return {
            text: [...root.querySelectorAll("h2,h3,.percentage-scope,.percentage-label,.percentage-value strong,.percentage-value span,.percentage-center strong,.percentage-center span,.percentage-denominator,.percentage-note,summary,button")]
                .filter(node => node.checkVisibility()).map(node => ({ text: node.textContent, ratio: ratio(getComputedStyle(node).color, background(node)) })),
            marks: [...root.querySelectorAll(".percentage-slice,.percentage-bar")].map(node => ({
                category: node.dataset.category || node.parentElement.parentElement.dataset.category,
                ratio: ratio(node.classList.contains("percentage-bar") ? getComputedStyle(node).backgroundColor
                    : node.dataset.thin === "true" ? getComputedStyle(node).fill : getComputedStyle(node).stroke, background(node.parentElement)),
            })),
            icons: [...root.querySelectorAll(".percentage-cue")].map(node => ({
                ratio: ratio(getComputedStyle(node).color, background(node)),
            })),
        };
    });
}
function verify(measurement) {
    assert.equal(measurement.pageOverflow, false);
    for (const card of measurement.cards) {
        assert.equal(card.slices.reduce((sum, slice) => sum + slice.count, 0), measurement.total);
        for (const slice of card.slices) assert.ok(Math.abs(slice.exact - slice.count / measurement.total) < 1e-14, "Canonical shares are not derived from enlarged angles");
        if (card.svg) {
            assert.ok(Math.abs(card.slices.reduce((sum, slice) => sum + slice.end - slice.start, 0) - 1) < 1e-12);
            assert.ok(card.slices.every(slice => slice.end - slice.start >= .03 - 1e-12));
        }
        if (card.svg) {
            assert.ok(Math.abs(card.svg.width / card.svg.height - 240 / 200) < .01, "Viewbox reserves projected geometry and extrusion, not a squeezed square");
            assert.equal(card.geometry.viewBox, "0 0 240 200");
            assert.equal(card.geometry.depth, 22);
            assert.equal(card.plates, 0);
            assert.equal(card.visual.y, card.content.y, "Chart is top-aligned even beside a long legend");
            assert.ok(card.bottomSpace <= 20.1, "Footer finishes the card without a padded empty slab");
            assert.match(card.geometry.innerClip, /^url\(#percentage-/);
            assert.ok(card.counter.y >= card.svg.bottom - 1, "Exact count stays outside the projected hole");
            for (const face of card.geometry.faces) {
                assert.equal(face.depth, 22);
                assert.equal(face.hidden, "true");
                assert.ok(face.box.x >= card.svg.x - 1 && face.box.right <= card.svg.right + 1);
                assert.ok(face.box.y >= card.svg.y - 1 && face.box.bottom <= card.svg.bottom + 1, "All actual paths fit, including clipped rear inner walls");
            }
        }
        for (const row of card.rows) {
            assert.ok(row.box.height >= 44);
            assert.ok(row.box.right <= card.box.right + 1);
            assert.ok(row.scrollWidth <= row.clientWidth + 1, row.text);
            assert.equal(row.value, `${row.percent} (${row.formattedCount})`);
            assert.equal(row.pairOverflow, false, `No clipped count pair: ${row.value}`);
            assert.ok(row.valueBox.right <= row.box.right + 1);
            assert.ok(row.valueBox.bottom <= row.box.bottom + 1);
            assert.ok(row.valueBox.y >= row.label.bottom - 1 || row.valueBox.x >= row.label.right, "Labels and value pairs never overlap");
        }
    }
}

test("projected glass rings at 375/820/1200/1600/2560 in light/navy and 100/200% text", { timeout: 120000 }, async () => runFixture(async ({ context, url }) => {
    const measurements = [], page = await context.newPage();
    await page.goto(url + "/#home?chart=workload"); await ready(page);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 1600, 2560]) for (const textScale of [1, 2]) {
        await page.setViewportSize({ width, height: 1100 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, textScale);
        const measured = await inspect(page); verify(measured);
        assert.equal(measured.total, 45);
        if (width === 2560 && textScale === 1) {
            assert.ok(Math.abs(measured.cards[0].box.y - measured.cards[1].box.y) < 1, "Useful side-by-side composition");
            assert.ok(Math.abs(measured.cards[0].box.height - measured.cards[1].box.height) < 1, "Collapsed pair shares compact intrinsic height");
            for (const lane of ["heading", "content", "footer", "counter"]) {
                assert.ok(Math.abs(measured.cards[0][lane].y - measured.cards[1][lane].y) < 1, `${lane} lane aligns across the pair`);
            }
            for (const card of measured.cards) {
                assert.ok(card.content.width <= 728, "The larger exact ring keeps a bounded reading measure");
                assert.ok(card.visual, "The approved dimensional ring is actually rendered");
                assert.ok(card.legend.x - card.visual.right <= 17, "Ring and legend keep a compact reading gap");
                for (const row of card.rows) {
                    assert.equal(row.labelFont, "14px"); assert.equal(row.percentFont, "14px"); assert.equal(row.countFont, "14px");
                    assert.ok(Math.abs(row.valueBox.right - card.rows[0].valueBox.right) < 1, "Every numeric right edge aligns");
                    assert.ok(Math.abs(row.label.x - card.rows[0].label.x) < 1, "Every label begins in the same column");
                }
            }
        }
        if (width === 375) assert.ok(measured.cards[1].box.y >= measured.cards[0].box.bottom, "Stack cards in narrow containers");
        const columnColors = await page.locator(".dimensional-category").evaluateAll(nodes => nodes.map(node => ({
            id: node.querySelector(".group-name")?.textContent, color: getComputedStyle(node.querySelector(".dimensional-front")).getPropertyValue("--column-mid"),
        })));
        for (const slice of measured.cards[1].slices.filter(slice => !["group:other", "Unknown"].includes(slice.category))) {
            const column = columnColors.find(column => column.id === slice.category);
            if (column) assert.equal(slice.color.trim(), column.color.trim());
        }
        const ratios = await contrast(page);
        for (const item of ratios.text) assert.ok(item.ratio >= 4.5, `${theme}: ${item.text}: ${item.ratio}`);
        for (const item of ratios.marks) assert.ok(item.ratio >= 3, `${theme}: ${item.category} boundary: ${item.ratio}`);
        for (const item of ratios.icons) assert.ok(item.ratio >= 3, `${theme}: non-color icon: ${item.ratio}`);
        const firstRow = page.locator(".percentage-label[href]").first();
        await page.locator("#main").focus();
        await firstRow.focus();
        const focused = await firstRow.boundingBox(), header = await page.locator(".app-header").boundingBox();
        assert.ok(focused.y >= header.y + header.height, `${theme}/${width}/text${textScale}: keyboard focus ${focused.y} stays below header ${header.y + header.height}`);
        await firstRow.hover();
        for (const item of (await contrast(page)).text) assert.ok(item.ratio >= 4.5, `${theme} focused/hovered: ${item.text}: ${item.ratio}`);
        measurements.push({ theme, width, textScale, ratios, ...measured });
        if (proofDir && (textScale === 1 || width === 375)) await screenshot(page, `percentages-${theme}-${width}-text${textScale}.png`);
    }
    if (proofDir) await writeFile(path.join(proofDir, "layout.json"), JSON.stringify(measurements, null, 2));
}));

test("percentages retain selected breakdown, exact data and focus through reload, filter, failure, navigation and fresh snapshots", { timeout: 60000 }, async () => runFixture(async ({ context, url, change, fail, hold, requests, corrupt }) => {
    const page = await context.newPage();
    await page.goto(url); await ready(page);
    const outcomes = page.locator('[data-percentage-card="outcomes"]'), composition = page.locator('[data-percentage-card="composition"]');
    const first = outcomes.locator(".percentage-label[href]").first();
    await first.focus();
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    assert.match(await first.getAttribute("aria-label"), /of 45 Work IQ tool calls/);
    await page.keyboard.press("Escape");
    assert.equal(await first.evaluate(node => node === document.activeElement), true);
    await composition.getByRole("button", { name: "Tool names", exact: true }).click();
    assert.equal(await composition.locator(".percentage-ring").count(), 0);
    assert.equal(await composition.locator(".percentage-bar").count(), 2);
    await composition.locator("summary").click();
    await composition.locator("tbody tr").first().waitFor();
    assert.equal(await composition.locator("tbody tr").count(), 2);
    await composition.locator("summary").focus();
    const focusedKey = await page.evaluate(() => document.activeElement.dataset.viewKey);
    await page.setViewportSize({ width: 820, height: 1000 });
    assert.equal(await page.evaluate(() => document.activeElement.dataset.viewKey), focusedKey, "Container reflow retains the logical focus without overriding the reader's scroll");
    await page.evaluate(() => document.querySelector("#refreshBtn").click()); await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.viewKey), focusedKey);
    assert.equal(await composition.locator("details").getAttribute("open"), "");
    assert.equal(await composition.getByRole("button", { name: "Tool names", exact: true }).getAttribute("aria-pressed"), "true");
    change(structuredClone(source));
    await page.evaluate(() => document.querySelector("#refreshBtn").click()); await ready(page);
    assert.equal(await page.locator(".percentage-section").getAttribute("data-revision"), "2", "Unchanged figures still track the accepted revision");
    const release = hold(), old = await inspect(page);
    await page.evaluate(() => document.querySelector("#refreshBtn").click());
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "true");
    assert.deepEqual((await inspect(page)).cards.map(card => card.denominator), old.cards.map(card => card.denominator));
    release(); await ready(page);
    fail(true);
    await (await revealStoredRefresh(page)).click();
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    assert.equal((await inspect(page)).total, 45);
    assert.match(await page.locator("#message").innerText(), /Synthetic read failure/);
    fail(false);
    const newRecords = structuredClone(source);
    newRecords[0].toolCalls.push({ ...newRecords[0].toolCalls[0], toolCallId: "fresh-synthetic", startEventId: "fresh-synthetic", toolSucceeded: true, reportedOutcome: "succeeded" });
    change(newRecords);
    await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.equal((await inspect(page)).total, 46);
    corrupt(true);
    await (await revealStoredRefresh(page)).click();
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    assert.match(await page.locator("#message").innerText(), /Percentage service groups/);
    assert.equal((await inspect(page)).total, 46);
    assert.equal(await page.locator("#activityCount").innerText(), "46");
    corrupt(false);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    const success = await inspect(page);
    assert.match(success.scope, /Worked only/);
    assert.equal(success.cards[0].slices.length, 1);
    assert.equal(success.cards[0].slices[0].end, 1);
    assert.match(success.cards[0].text, /not task correctness/);
    await navigateMain(page, "activity");
    await navigateMain(page, "home"); await ready(page);
    assert.equal(await composition.getByRole("button", { name: "Tool names", exact: true }).getAttribute("aria-pressed"), "true");
    await page.goBack(); await page.goBack(); await ready(page);
    assert.equal(await composition.getByRole("button", { name: "Tool names", exact: true }).getAttribute("aria-pressed"), "true");
    await selectActivityOption(page, "layerFilter", "reported-api"); await ready(page);
    assert.match((await inspect(page)).cards[0].denominator, /tool-returned API result/);
    change([]);
    await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.equal(await page.locator(".percentage-ring").count(), 0);
    assert.equal(await page.locator(".percentage-empty").count(), 2);
    assert.match(await outcomes.innerText(), /not applicable/);
    assert.ok(requests.every(request => !request.text.includes("SYNTHETIC ONLY")), "No private request text goes into network queries");
}));

test("container-only resize, long names, exact Other members, touch, forced colors and grayscale preserve non-color meaning", { timeout: 60000 }, async () => {
    const browser = await chromium.launch(), context = await browser.newContext({ hasTouch: true, reducedMotion: "reduce" });
    const page = await context.newPage();
    try {
        await page.setViewportSize({ width: 1600, height: 1100 });
        await page.setContent(`<html data-evidence-theme="dark"><head><style>${styles}${percentageChartStyles}</style></head><body><div id="test-host" style="width:1400px;max-width:100%;padding:16px"></div></body></html>`);
        await page.evaluate(({ factory, dimensional, categories, results, ux, icons, serviceIcons, analytics }) => {
            const make = source => (0, eval)(`(${source})`);
            const view = make(factory)({ dimensional: make(dimensional)(), categories: make(categories)(), results: make(results)(), ux: make(ux)(icons), icons: serviceIcons }).mount(document.querySelector("#test-host"));
            const outcomes = ["success", "failure", "unknown", "partial", "other", "transport"];
            for (const outcome of outcomes) analytics.totals[outcome] = 0;
            analytics.rows.forEach((row, index) => {
                row.tool = `workiq-synthetic-very-long-tool-name-${index}-${"full-name-".repeat(8)}`;
                row.outcome = outcomes[index % outcomes.length];
                analytics.totals[row.outcome]++;
            });
            view.update(analytics, { layer: "tool", filters: {} });
        }, { factory: createPercentageCharts.toString(), dimensional: createDimensionalCharts.toString(), categories: createServiceCategories.toString(),
            results: createRecordedResults.toString(), ux: createEvidenceUX.toString(), icons: uxIcons, serviceIcons: dimensionalIcons, analytics: buildActivityAnalytics(source) });
        const wide = await inspect(page); verify(wide);
        await page.evaluate(() => { document.querySelector("#test-host").style.width = "365px"; });
        const narrow = await inspect(page); verify(narrow);
        assert.equal(narrow.cards[0].rows.length, 6, "All recorded outcome categories remain readable");
        assert.ok(narrow.cards[1].box.y >= narrow.cards[0].box.bottom);
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        verify(await inspect(page));
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        const composition = page.locator('[data-percentage-card="composition"]');
        await composition.getByRole("button", { name: "Tool names", exact: true }).tap();
        assert.equal(await composition.locator(".percentage-bar").count(), 6);
        await composition.locator("summary").tap();
        await composition.locator("tbody tr").first().waitFor();
        assert.equal(await composition.locator("tbody tr").count(), 45);
        assert.equal(await composition.locator("tbody small").count(), 40);
        assert.equal(await composition.locator("tfoot td").first().innerText(), "45");
        await composition.locator(".percentage-legend-row").first().tap();
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
        assert.match(await composition.locator(".percentage-legend-row").first().innerText(), /2.2%/);
        const overflow = await composition.evaluate(node => [...node.querySelectorAll("td,th,.percentage-label")].filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent));
        assert.deepEqual(overflow, []);
        await page.emulateMedia({ forcedColors: "active" });
        assert.equal(await page.locator(".percentage-bar").first().evaluate(node => getComputedStyle(node).opacity), "1");
        assert.ok(await page.locator(".percentage-label").first().isVisible());
        if (proofDir) {
            await mkdir(proofDir, { recursive: true });
            await page.locator(".percentage-section").screenshot({ path: path.join(proofDir, "forced-colors-long-tools.png") });
        }
        await page.emulateMedia({ forcedColors: "none" });
        await page.evaluate(() => { document.querySelector("#test-host").style.filter = "grayscale(1)"; });
        assert.equal(await composition.locator("tbody tr").count(), 45);
        if (proofDir) await page.locator(".percentage-section").screenshot({ path: path.join(proofDir, "grayscale-long-tools.png") });
    } finally { await browser.close(); }
});

async function verifyRenderedSurfaces(ring) {
    await ring.scrollIntoViewIfNeeded();
    return ring.evaluate(svg => {
        const f = { outer: 104, inner: 66, depth: Number(svg.dataset.depth) }, top = svg.querySelector(".percentage-top-faces");
        const matrix = top.getScreenCTM(), local = top.transform.baseVal.consolidate().matrix;
        const h = f.depth / local.d, failures = [];
        const slices = [...svg.querySelectorAll(".percentage-slice")];
        const fraction = (x, y) => ((Math.atan2(y, x) - Math.PI / 2) / (Math.PI * 2) + 1) % 1;
        let tested = 0, insideHole = 0, inner = 0, outer = 0, caps = 0;
        // Cast vertical viewing rays through the actual painted scene. The visible
        // surface is analytic, not inferred from class presence or SVG path order.
        for (let x = -113.37; x < 114; x += 4) for (let y = -113.19; y < 177; y += 4) {
            const radius = Math.hypot(x, y);
            let expected = null, angle;
            if (radius > f.inner && radius < f.outer) {
                expected = "percentage-slice"; angle = fraction(x, y); caps++;
            } else if (Math.abs(x) < f.inner && radius < f.inner) {
                const rear = -Math.sqrt(f.inner ** 2 - x ** 2);
                if (y > rear && y < rear + h) { expected = "percentage-inner-wall"; angle = fraction(x, rear); inner++; }
                else insideHole++;
            } else if (Math.abs(x) < f.outer) {
                const front = Math.sqrt(f.outer ** 2 - x ** 2);
                if (y > front && y < front + h) { expected = "percentage-outer-wall"; angle = fraction(x, front); outer++; }
            }
            const p = new DOMPoint(x, y).matrixTransform(matrix);
            if (p.y < 100 || p.y > innerHeight - 1 || p.x < 0 || p.x > innerWidth - 1) continue;
            const hit = document.elementFromPoint(p.x, p.y)?.closest(".percentage-face");
            const actual = hit?.ownerSVGElement === svg ? hit : null;
            const category = slices.find(node => angle >= Number(node.dataset.start) && angle < Number(node.dataset.end))?.dataset.category;
            if (expected ? !actual?.classList.contains(expected) || actual.dataset.category !== category : actual !== null) {
                failures.push({ x, y, expected, category, actual: actual?.getAttribute("class"), actualCategory: actual?.dataset.category });
            }
            tested++;
        }
        const tiny = slices.filter(node => Number(node.dataset.end) - Number(node.dataset.start) < .00001).map(node => {
            const angle = (Number(node.dataset.start) + Number(node.dataset.end)) / 2 * 2 * Math.PI + Math.PI / 2;
            return node.isPointInFill(new DOMPoint(85 * Math.cos(angle), 85 * Math.sin(angle)));
        });
        const projection = { a: local.a, b: local.b, c: local.c, d: local.d };
        const layers = [...svg.children].filter(node => node.matches("g")).map(node => node.getAttribute("class"));
        const floorAbsent = !svg.querySelector(".percentage-ground,.dimensional-ground-surface,.dimensional-ground-edge,.dimensional-reflection,filter");
        const contained = Array.from({ length: 360 }, (_, i) => {
            const angle = i / 360 * Math.PI * 2;
            const p = new DOMPoint(f.outer * Math.cos(angle), f.outer * Math.sin(angle) + h).matrixTransform(local);
            return p.x > 0 && p.x < svg.viewBox.baseVal.width && p.y > 0 && p.y < svg.viewBox.baseVal.height;
        }).every(Boolean);
        const seamCoverage = [0, .25, .5, .75, 1].every(fraction => {
            const angle = fraction * Math.PI * 2 - Math.PI / 2;
            return slices.some(node => node.isPointInFill(new DOMPoint(85 * Math.cos(angle), 85 * Math.sin(angle))));
        });
        return { failures: failures.slice(0, 12), failureCount: failures.length, tested, caps, inner, outer, insideHole, tiny, projection, layers,
            floorAbsent, contained, seamCoverage, centerFilledByTop: slices.some(node => node.isPointInFill(new DOMPoint(0, 0))) };
    });
}

test("both mounted glass rings have exact visible surfaces, native labels and an inert open center", { timeout: 60000 }, async () => runFixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(url); await ready(page);
    const proof = [];
    assert.equal(await page.locator(".percentage-card").count(), 2);
    assert.equal(await page.locator(".percentage-ring").count(), 2);
    assert.equal(await page.locator(".percentage-locator").count(), 0);
    for (const card of await page.locator(".percentage-card").all()) {
        const surfaces = await verifyRenderedSurfaces(card.locator(".percentage-ring"));
        assert.equal(surfaces.failureCount, 0, JSON.stringify(surfaces.failures));
        assert.equal(surfaces.floorAbsent, true);
        assert.equal(surfaces.centerFilledByTop, false);
        const measured = await card.locator(".percentage-legend-row").evaluateAll(rows => rows.map(row => {
            const link = row.querySelector("a");
            return { count: +row.dataset.count,
                label: row.querySelector(".percentage-label").textContent, value: row.querySelector(".percentage-value").textContent,
                href: link?.getAttribute("href"), linkHeight: link?.getBoundingClientRect().height };
        }));
        assert.ok(measured.length > 0);
        assert.equal(measured.reduce((sum, row) => sum + row.count, 0), 45);
        for (const row of measured) {
            assert.ok(row.label && row.value.includes(`(${row.count})`));
            if (row.href) assert.ok(row.linkHeight >= 44);
        }
        const before = page.url();
        const hole = await card.locator(".percentage-top-faces").evaluate(node => {
            const point = new DOMPoint(0, 0).matrixTransform(node.getScreenCTM());
            return { x: point.x, y: point.y };
        });
        await page.mouse.click(hole.x, hole.y);
        assert.equal(page.url(), before, "The open hole never acts as a hidden category target");
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
        proof.push(measured);
    }
    await page.emulateMedia({ forcedColors: "active" });
    for (const card of await page.locator(".percentage-card").all()) {
        await card.locator("summary").click();
        await card.locator("tbody tr").first().waitFor();
        assert.equal(await card.locator("tfoot td").first().innerText(), "45");
        assert.ok(await card.locator(".percentage-cue svg").first().isVisible());
    }
    await page.emulateMedia({ forcedColors: "none" });
    await page.locator(".percentage-section").evaluate(node => { node.style.filter = "grayscale(1)"; });
    assert.equal(await page.locator(".percentage-table").count(), 2);
    assert.equal(await page.locator('.percentage-ring [tabindex]:not([tabindex="-1"])').count(), 0, "Pointer links never duplicate the visible keyboard label targets");
    if (proofDir) await writeFile(path.join(proofDir, "rendered-geometry.json"), JSON.stringify(proof, null, 2));
}));

test("rendered glass surfaces preserve full/half-turn and 0.0001% math with the front-facing small-category orientation", { timeout: 60000 }, async () => {
    const charts = createPercentageCharts({ dimensional: createDimensionalCharts() }), f = charts.frame();
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    try {
        for (const values of [[1], [1, 1], [1, 3], [3, 1], [1, 999999], [999999, 1], [250000, 1, 749999], [749999, 1, 250000], Array(24).fill(1)]) {
            const total = values.reduce((a, b) => a + b), data = charts.partition(values.map((count, i) => ({ id: `slice-${i}`, label: `Slice ${i}`, count })), total,
                { maxSlices: Math.max(2, values.length) });
            let cumulative = 0;
            const geometry = data.rows.sort((a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6))).map(row => {
                const start = cumulative / total;
                cumulative += row.count;
                const end = cumulative / total;
                return { ...row, start, end, ...charts.surfaces(start, end) };
            });
            const face = (part, kind, row) => `<path class="percentage-face ${kind}" data-category="${row.id}" data-start="${part.start}" data-end="${part.end}" d="${part.d}" fill="#278888"/>`;
            const transform = `matrix(1 ${f.shear} 0 ${f.compression} ${f.cx} ${f.cy})`;
            await page.setContent(`<style>body{margin:120px 0 0 100px}svg{width:600px;height:500px}.percentage-face{pointer-events:visibleFill}</style>
                <svg class="percentage-ring" data-depth="${f.depth}" viewBox="0 0 ${f.width} ${f.height}" role="img"><defs><clipPath id="hole"><circle r="${f.inner}"/></clipPath></defs>
                <g class="percentage-inner-faces" transform="${transform}" clip-path="url(#hole)">${geometry.flatMap(g => g.inner.map(part => face(part, "percentage-inner-wall", g))).join("")}</g>
                <g class="percentage-top-faces" transform="${transform}">${geometry.map(g => face({ ...g, d: g.top }, "percentage-slice", g)).join("")}</g>
                <g class="percentage-outer-faces" transform="${transform}">${geometry.flatMap(g => g.outer.map(part => face(part, "percentage-outer-wall", g))).join("")}</g></svg>`);
            const measured = await verifyRenderedSurfaces(page.locator("svg"));
            assert.equal(measured.failureCount, 0, `${values}: ${JSON.stringify(measured.failures)}`);
            assert.equal(measured.centerFilledByTop, false, `Open center for ${values}`);
            assert.equal(measured.seamCoverage, true);
            assert.equal(measured.contained, true);
            assert.ok(measured.tiny.every(Boolean), "Browser fill geometry retains every tiny positive wedge, without enlarging its angular range");
            assert.equal(await page.locator(".percentage-slice").count(), values.length);
            if (values.includes(999999)) assert.equal(measured.tiny.length, 1);
        }
    } finally { await browser.close(); }
});

test("adjacent count pairs format zero, one and large locale values without changing exact table cells", { timeout: 60000 }, async () => {
    const browser = await chromium.launch();
    try {
        for (const locale of ["en-US", "de-DE", "en-IN"]) {
            const context = await browser.newContext({ locale, viewport: { width: 1600, height: 1200 } }), page = await context.newPage();
            await page.setContent(`<html data-evidence-theme="light"><head><style>${styles}${percentageChartStyles}</style></head><body><div id="test-host" style="width:365px;max-width:100%;padding:16px"></div></body></html>`);
            const record = fixture("count-pairs");
            record.toolCalls = Array.from({ length: 12345 }, (_, i) => ({ ...record.toolCalls[0], toolCallId: `large-${i}`,
                startEventId: `large-${i}`, toolSucceeded: i !== 0, reportedOutcome: i === 0 ? "failed" : "succeeded" }));
            await page.evaluate(({ factory, dimensional, categories, results, ux, icons, serviceIcons, analytics }) => {
                const make = source => (0, eval)(`(${source})`);
                make(factory)({ dimensional: make(dimensional)(), categories: make(categories)(), results: make(results)(),
                    ux: make(ux)(icons), icons: serviceIcons }).mount(document.querySelector("#test-host")).update(analytics, { layer: "tool", filters: {} });
            }, { factory: createPercentageCharts.toString(), dimensional: createDimensionalCharts.toString(),
                categories: createServiceCategories.toString(), results: createRecordedResults.toString(),
                ux: createEvidenceUX.toString(), icons: uxIcons, serviceIcons: dimensionalIcons, analytics: buildActivityAnalytics([record]) });
            await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
            const measured = await inspect(page); verify(measured);
            const format = new Intl.NumberFormat(locale);
            assert.deepEqual(measured.cards[0].rows.map(row => row.value), [`>99.9% (${format.format(12344)})`, "<0.1% (1)", "0% (0)"]);
            for (const card of await page.locator(".percentage-card").all()) {
                await card.locator("summary").click();
                assert.equal(await card.locator("tfoot td").first().innerText(), format.format(12345));
                for (const text of await card.locator("tbody td:first-of-type").allTextContents()) assert.doesNotMatch(text, /[()]/);
            }
            const composition = page.locator('[data-percentage-card="composition"]');
            await composition.getByRole("button", { name: "Tool names", exact: true }).click();
            assert.equal(await composition.locator(".percentage-value").textContent(), `100% (${format.format(12345)})`);
            assert.equal(await page.getByRole("tooltip").isVisible(), false);
            assert.match(await composition.locator(".percentage-legend-row").innerText(), new RegExp(format.format(12345).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            if (proofDir) await page.locator(".percentage-section").screenshot({ path: path.join(proofDir, `count-pairs-${locale}-text2.png`) });
            // Stress the longest supported count's typography without manufacturing
            // quadrillions of canonical activity rows in the analytics fixture.
            await page.locator(".percentage-value span").evaluateAll(nodes => {
                for (const node of nodes) node.textContent = `(${Number.MAX_SAFE_INTEGER.toLocaleString()})`;
            });
            const overflow = await page.locator(".percentage-value,.percentage-value>*").evaluateAll(nodes =>
                nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent));
            assert.deepEqual(overflow, [], `${locale}: full-length counts at 200% text fit or wrap`);
            await context.close();
        }
    } finally { await browser.close(); }
});
