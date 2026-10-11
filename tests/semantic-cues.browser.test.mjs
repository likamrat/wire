import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { uxIconSources } from "../web/ux-icons.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { renderHtmlReport } from "../lib/product-report.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { fixture, exportCatalogFor, chooseTheme } from "./helpers.mjs";
import { rgb, pairwise, contrast } from "./color-measurements.mjs";

const proofs = process.env.WORKIQ_CUE_PROOFS;
const charts = createDimensionalCharts(), results = createRecordedResults();
const records = [
    ["/me/messages"], ["/me/events"], ["/me/drive"], ["/teams"], ["/me/people"], ["/planner/tasks"],
    ["/me/onenote/pages"], ["/groups"], ["/search/query"], ["/me/events", "/unclassified"], ["/$batch"], ["/unclassified"], ["/me/messages"],
].map((targets, index) => {
    const record = fixture(`semantic-cue-${index}`);
    record.sourceSessionName = "Synthetic cue examples";
    record.toolCalls[0] = {
        ...record.toolCalls[0], requestedApiPath: targets.length === 1 ? targets[0] : null,
        tool: index === 12 ? "workiq-get_schema" : record.toolCalls[0].tool,
        requestArgs: index === 12 ? { path: "/me/messages", operationType: "fetch" } : { entityUrls: targets }, startedAt: "2026-09-30T12:00:00Z",
        toolSucceeded: [true, false, null, null][index % 4],
        reportedOutcome: ["succeeded", "failed", "unknown", "partial"][index % 4], apiResults: [],
    };
    return record;
});
const iconName = markup => /data-fluent-icon="([^"]+)"/.exec(markup)[1];
const expectedServices = serviceCategories.entries.map(entry => ({
    ...entry, tone: charts.tone(entry.id), icon: iconName(dimensionalIcons[entry.id]),
}));

test("all outcome and classifier cues keep the canonical semantic palette and glyphs", () => {
    assert.deepEqual(charts.outcomeTones, { success: "teal", failure: "pink", partial: "orange", unknown: "slate", other: "violet", transport: "cyan" });
    assert.deepEqual(Object.fromEntries(expectedServices.map(entry => [entry.id, entry.tone])), {
        Mail: "service-mail", Calendar: "service-calendar", Files: "service-files", Teams: "service-teams", People: "service-people", Tasks: "service-tasks",
        Notes: "service-notes", Directory: "service-directory", Search: "service-search", Discovery: "service-discovery", "Multiple workloads": "service-multiple", "Platform metadata": "service-diagnostics", Unknown: "service-unknown",
    });
    const serialized = Function(`return (${createRecordedResults.toString()})()`)();
    for (const [key, icon] of Object.entries({ success: "check", failure: "result-failure", unknown: "unobserved", partial: "result-partial", other: "result-other", transport: "result-transport" })) {
        assert.equal(results.icon(key), icon); assert.equal(serialized.icon(key), icon);
        assert.equal(results.entries("tool", results.summarize([{ id: "one", outcome: key }]))[0].icon, icon);
    }
    assert.throws(() => results.icon("unrecorded-value"), /recorded outcome/);
    assert.equal(charts.tone("group:other"), "service-other");
});

async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function expand(page) {
    for (const id of ["meaning", "serviceDefinitions"]) {
        if (!await page.locator(`#${id}`).evaluate(node => node.open)) {
            await page.locator(`#${id}>summary`).focus();
            await page.keyboard.press("Enter");
        }
    }
}
async function app(run) {
    const before = structuredClone(records), posts = [], errors = [];
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.end(renderHtmlShell("a".repeat(64), "cue-fixture"));
            return;
        }
        posts.push(req.url);
        let body = ""; for await (const part of req) body += part;
        res.setHeader("Content-Type", "application/json");
        if (req.url !== "/api/snapshot") { res.writeHead(403); res.end('{"error":"Cue fixture permits snapshot reads only."}'); return; }
        const input = JSON.parse(body);
        // Exercise the complete classifier vocabulary, including explicit diagnostics.
        const analytics = buildActivityAnalytics(records, { ...input, filters: { ...input.filters, includeMetadata: true } });
        res.end(JSON.stringify({
            revision: 1, scenarios: records, exports: [], coverage: { since: "2026-09-01", until: "2026-09-30", notes: [] },
            analytics: { ...analytics, revision: 1 }, requestActivity: buildRequestActivity(records), exportCatalog: exportCatalogFor(records),
        }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch(), context = await browser.newContext({ reducedMotion: "reduce", timezoneId: "America/Los_Angeles" });
    context.setDefaultTimeout(5000);
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    await context.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No clipboard reads in cue proof."); },
        writeText() { throw Error("No clipboard writes in cue proof."); },
    } }));
    try {
        if (proofs) await mkdir(proofs, { recursive: true });
        await run(context, `http://127.0.0.1:${server.address().port}`);
        assert.deepEqual(records, before);
        assert.deepEqual(errors, []);
        assert.ok(posts.every(route => ["/api/snapshot", "/api/evaluation/automatic/summary"].includes(route)), "Only snapshot and read-only summary requests; no review, export, import, collection or configuration mutation");
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

async function measure(page, selector = "#meaning,#serviceDefinitions") {
    return page.locator(selector).evaluateAll(sections => {
        const rgb = value => value.match(/[\d.]+/g).map(Number);
        const lum = rgb => rgb.slice(0, 3).map(n => n / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
        const contrast = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
        const background = node => {
            let value = [255, 255, 255];
            const ancestors = []; for (let n = node; n; n = n.parentElement) ancestors.unshift(n);
            for (const n of ancestors) {
                const color = rgb(getComputedStyle(n).backgroundColor), alpha = color[3] ?? 1;
                value = color.slice(0, 3).map((c, i) => c * alpha + value[i] * (1 - alpha));
            }
            return value;
        };
        const rect = node => { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom }; };
        const cues = sections.flatMap(section => [...section.querySelectorAll(".semantic-cue")]).map(node => {
            const svg = node.querySelector("svg"), label = node.querySelector(":scope>span"), style = getComputedStyle(node);
            return {
                text: node.textContent, service: node.dataset.service, outcome: node.dataset.outcome, color: style.color,
                icon: svg.dataset.fluentIcon, hidden: svg.getAttribute("aria-hidden"), focusable: svg.getAttribute("focusable"),
                contrast: contrast(rgb(style.color), background(node)),
                iconContrast: contrast(rgb(getComputedStyle(svg).fill), background(svg)),
                iconBox: rect(svg), labelBox: rect(label), box: rect(node),
                lineHeight: parseFloat(style.lineHeight), cursor: style.cursor, tabIndex: node.tabIndex,
                clipped: [...label.getClientRects()].some(r => r.right > node.getBoundingClientRect().right + 1),
            };
        });
        const text = sections.flatMap(section => [...section.querySelectorAll("p,dt,dd,summary")]).map(node => {
            const box = node.getBoundingClientRect(), walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            const fragments = []; let textNode;
            while ((textNode = walker.nextNode())) {
                const range = document.createRange(); range.selectNodeContents(textNode);
                fragments.push(...range.getClientRects());
            }
            return {
                text: node.textContent, contrast: contrast(rgb(getComputedStyle(node).color), background(node)),
                clipped: fragments.some(r => r.x < box.x - 1 || r.right > box.right + 1),
            };
        });
        return {
            cues, text, overflow: document.documentElement.scrollWidth - innerWidth,
            glossaryColumns: new Set([...document.querySelectorAll(".glossary-entry")].map(n => Math.round(n.getBoundingClientRect().x))).size,
        };
    });
}
function assertReadable(value) {
    assert.ok(value.overflow <= 1, "No page overflow");
    for (const text of value.text) {
        assert.ok(text.contrast >= 4.5, `${text.text}: ${text.contrast}`);
        assert.equal(text.clipped, false, `${text.text}: text fragments stay inside their own reading column`);
    }
    for (const cue of value.cues) {
        assert.ok(cue.contrast >= 4.5 && cue.iconContrast >= 3, `${cue.text}: text=${cue.contrast}, icon=${cue.iconContrast}`);
        assert.equal(cue.hidden, "true"); assert.equal(cue.focusable, "false");
        assert.equal(cue.tabIndex, -1); assert.notEqual(cue.cursor, "pointer");
        assert.equal(cue.iconBox.width, 20); assert.equal(cue.iconBox.height, 20);
        assert.ok(Math.abs(cue.iconBox.y + 10 - cue.box.y - cue.lineHeight / 2) < 1, `${cue.text}: first-line alignment`);
        assert.ok(cue.iconBox.right + 7 <= cue.labelBox.x && cue.labelBox.right <= cue.box.right + 1);
        assert.equal(cue.clipped, false);
    }
}
async function screenshotSections(page, name) {
    if (!proofs) return;
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    const clip = await page.evaluate(() => {
        const boxes = ["meaning", "serviceDefinitions"].map(id => document.getElementById(id).getBoundingClientRect());
        const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y)) + scrollY;
        return { x, y, width: Math.max(...boxes.map(b => b.right)) - x, height: Math.max(...boxes.map(b => b.bottom)) + scrollY - y };
    });
    await page.screenshot({ path: path.join(proofs, `${name}.png`), clip, fullPage: true });
}

test("expanded result and every service definition retain readable cues when text grows before opening at 375/820/1200 and 200%", { timeout: 60000 }, async () => app(async (context, url) => {
    const page = await context.newPage(), measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(url); await ready(page); await chooseTheme(page, theme);
        assert.equal(await page.locator("#meaning").evaluate(n => n.open), false);
        await page.evaluate(value => { document.documentElement.style.fontSize = `${value * 100}%`; }, scale);
        await expand(page);
        const value = await measure(page); assertReadable(value);
        const outcomeCues = value.cues.filter(c => c.outcome);
        assert.equal(new Set(outcomeCues.map(c => c.color)).size, 6, "Six distinct rendered outcome inks");
        assert.equal(new Set(outcomeCues.map(c => c.icon)).size, 6, "Six distinct canonical glyphs, including partial");
        assert.equal(value.glossaryColumns, width > 700 ? 2 : 1);
        assert.deepEqual(value.cues.filter(c => c.service).map(c => c.service), expectedServices.map(c => c.id));
        for (const entry of expectedServices) {
            const cue = value.cues.find(c => c.service === entry.id);
            assert.equal(cue.text, entry.label); assert.equal(cue.icon, entry.icon);
            const canonical = await page.locator("html").evaluate((node, tone) => {
                const probe = document.createElement("span"); probe.style.color = `var(--chart-${tone}-label)`; node.append(probe);
                const color = getComputedStyle(probe).color; probe.remove(); return color;
            }, entry.tone);
            assert.equal(cue.color, canonical);
            assert.deepEqual(rgb(cue.color), rgb(charts.servicePalette[entry.id][theme].label));
        }
        const serviceColors = Object.fromEntries(value.cues.filter(cue => cue.service).map(cue => [cue.service, cue.color]));
        assert.equal(new Set(Object.values(serviceColors)).size, expectedServices.length);
        const distances = pairwise(serviceColors);
        assert.ok(distances[0].distance >= 7, `${theme}: ${JSON.stringify(distances[0])}`);
        await page.locator("#outcomeFilter-control").click();
        for (const cue of value.cues.filter(c => c.outcome)) {
            assert.equal(cue.icon, uxIconSources[results.icon(cue.outcome)]);
            const legend = page.locator(`.select-option .result-tone-${cue.outcome}`);
            assert.equal(await legend.evaluate(n => getComputedStyle(n).color), cue.color);
        }
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#meaningText").innerText(), "Tool completion is not answer correctness.");
        assert.deepEqual(await page.locator("#meaning h3").allTextContents(), ["Current scope", "Result meanings"]);
        assert.equal(await page.locator("#meaningReading").evaluate(node => node.open), false);
        await page.locator("#meaningReading>summary").click();
        assert.deepEqual(await page.locator("#chartReadingNotes dt").allTextContents(), ["Chart scale", "Chart colors", "Dates and grouping", "Evidence limits"]);
        assert.match(await page.locator("#chartReadingNotes").innerText(), /not an observed Graph HTTP response/);
        await page.locator("#meaningReading>summary").click();
        assert.match(await page.locator('[data-outcome="unknown"]+dd').innerText(), /not evidence of success or failure/);
        assert.equal(await page.locator("#meaning dt :is(button,a),#serviceDefinitions dt :is(button,a)").count(), 0);
        await screenshotSections(page, `synthetic-${theme}-${width}-${scale * 100}`);
        measurements.push({ theme, width, scale, ...value, pairwiseOklab100: distances });
        if (scale === 2) {
            await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
            await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
            assertReadable(await measure(page));
        }
        await page.locator("#meaning>summary").focus(); await page.keyboard.press("Enter");
        assert.equal(await page.locator("#meaning").evaluate(n => n.open), false);
    }
    if (proofs) await writeFile(path.join(proofs, "contrast-and-mapping.json"), JSON.stringify(measurements, null, 2));
}));

test("forced colors, grayscale, grouped Other and request chips keep exact icons, labels and distinct interactions", { timeout: 40000 }, async () => app(async (context, url) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.goto(url + "/#home?chart=workload"); await ready(page); await expand(page);
    const other = page.locator('.flat-comparison-row:has([data-group-id="group:other"])');
    assert.equal(await other.locator(".dimensional-category-icon").count(), 0, "Column labels omit the redundant icon lane; glossary and result glyphs remain unchanged");
    assert.ok((await other.locator(".group-name").textContent()).includes("Other"));
    assert.equal(await other.locator(".dimensional-tone-service-other").count(), 1);
    const start = page.url();
    assert.equal(await other.locator(".ux-help").count(), 0);
    assert.match(await other.locator(".flat-comparison-action").getAttribute("aria-label"), /Show all categories/);
    assert.equal(page.url(), start);
    await page.keyboard.press("Escape");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.emulateMedia({ forcedColors: "active", colorScheme: theme });
        const value = await measure(page); assertReadable(value);
        assert.equal(new Set(value.cues.map(c => c.color)).size, 1, "Words and glyphs distinguish states with system colors");
        await screenshotSections(page, `forced-${theme}`);
        await page.emulateMedia({ forcedColors: "none" });
        await page.evaluate(() => { document.body.style.filter = "grayscale(1)"; });
        assertReadable(await measure(page));
        await screenshotSections(page, `grayscale-${theme}`);
        await page.evaluate(() => { document.body.style.filter = ""; });
    }
    await page.goto(url + "/#activity"); await ready(page);
    const chips = page.locator(".request-row .recorded-result");
    assert.ok(await chips.count() >= 3);
    for (const chip of await chips.all()) {
        const key = await chip.getAttribute("data-outcome");
        assert.equal(await chip.locator("svg").getAttribute("data-fluent-icon"), uxIconSources[results.icon(key)]);
        assert.ok((await chip.getAttribute("class")).includes(`result-tone-${key}`));
        assert.equal(await chip.evaluate(n => n.tagName), "SPAN");
    }
}));

async function chartColors(page, selector, theme) {
    const rows = await page.locator(selector).evaluateAll(nodes => nodes.map(node => {
        const mark = node.querySelector(".flat-comparison-segment");
        const ancestors = []; for (let n = node; n; n = n.parentElement) ancestors.unshift(n);
        let background = [255, 255, 255];
        for (const ancestor of ancestors) {
            const color = getComputedStyle(ancestor).backgroundColor.match(/[\d.]+/g).map(Number), alpha = color[3] ?? 1;
            background = color.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
        }
        return {
            label: node.querySelector(".group-name").textContent, tone: [...mark.classList].find(value => value.startsWith("dimensional-tone-"))?.replace("dimensional-tone-", ""),
            color: getComputedStyle(mark).getPropertyValue("--column-label").trim(), background: `rgb(${background.join(",")})`,
            mid: getComputedStyle(mark).getPropertyValue("--column-mid"),
            total: Number(node.dataset.total), maximum: Number(node.closest(".flat-comparison").dataset.maximum),
            width: mark.getBoundingClientRect().width, track: mark.parentElement.getBoundingClientRect().width,
            labelClipped: (() => {
                const label = node.querySelector(".group-name"), range = document.createRange();
                range.selectNodeContents(label);
                const box = label.getBoundingClientRect();
                return [...range.getClientRects()].some(rect => rect.left < box.left - 1 || rect.right > box.right + 1);
            })(),
        };
    }));
    for (const row of rows) {
        const entry = row.tone === "service-other" ? { id: "group:other" } : expectedServices.find(entry => entry.tone === row.tone);
        assert.ok(entry, row.label);
        row.service = entry.id;
        assert.deepEqual(rgb(row.color), rgb(charts.servicePalette[entry.id][theme].label), row.label);
        assert.deepEqual(rgb(row.mid), rgb(charts.servicePalette[entry.id][theme].mid), row.label);
        row.markContrast = contrast(row.color, row.background);
        assert.ok(row.markContrast >= 3, `${row.label}: ${row.markContrast}`);
        assert.ok(Math.abs(row.width - row.track * row.total / row.maximum) <= .03);
        assert.equal(row.labelClipped, false, row.label);
    }
    assert.equal(new Set(rows.map(row => row.color)).size, rows.length);
    return rows;
}

test("rendered service charts preserve canonical color/name identities without icon rows through Other, filters and empty views", { timeout: 40000 }, async () => app(async (context, url) => {
    const page = await context.newPage(), evidence = [];
    await page.setViewportSize({ width: 1200, height: 1000 });
    for (const theme of ["light", "dark"]) {
        await page.goto(url + "/#home?chart=workload"); await ready(page); await chooseTheme(page, theme);
        const grouped = await chartColors(page, "#chart .flat-comparison-action", theme);
        assert.equal(grouped.length, 9);
        assert.ok(grouped.some(row => row.service === "group:other"));
        await page.getByRole("button", { name: "Show all", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll("#chart .flat-comparison-action").length === 13);
        const expanded = await chartColors(page, "#chart .flat-comparison-action", theme);
        for (const row of grouped.filter(row => row.service !== "group:other")) {
            assert.equal(expanded.find(entry => entry.service === row.service).color, row.color);
        }
        assert.equal(await page.getByRole("tooltip").isVisible(), false, "Chart expansion restores focus without resurrecting dismissed help");
        await page.locator("#chart .flat-comparison-action").first().focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await page.locator("#chart .flat-comparison-action").first().evaluate(node => node === document.activeElement), true);
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
        const tooltip = await page.locator("#chart .flat-comparison-action").first().getAttribute("aria-label");
        assert.ok(tooltip.includes(expanded[0].label));
        assert.match(tooltip, /1 Work IQ tool call;/);
        await page.keyboard.press("Escape");
        await page.goto(url + "/#home?chart=workload&service=People"); await ready(page);
        const subset = await chartColors(page, "#chart .flat-comparison-action", theme);
        assert.equal(subset.length, 1);
        assert.equal(subset[0].color, expanded.find(entry => entry.service === "People").color);
        const all = [...serviceCategories.entries, serviceCategories.describe("group:other", 4)];
        for (const ids of [all.map(entry => entry.id), all.map(entry => entry.id).reverse(), [], ["Unknown", "group:other"]]) {
            await page.evaluate(({ factory, icons, entries, ids }) => {
                document.getElementById("paletteChartFixture")?.remove();
                const fixture = document.createElement("section"); fixture.id = "paletteChartFixture"; fixture.className = "chart-panel";
                const dimensions = Function(`return (${factory})()`)();
                fixture.append(dimensions.comparisonView({
                    groups: ids.map(id => ({ id, label: id, total: 9 })), serviceMode: true, icons,
                    label: group => entries.find(entry => entry.id === group.id).label,
                    summary: group => `${group.total} synthetic calls`, onSelect() {}, tooltip() {},
                }));
                document.querySelector("main").append(fixture);
            }, { factory: createDimensionalCharts.toString(), icons: dimensionalIcons, entries: all, ids });
            const rendered = await chartColors(page, "#paletteChartFixture .flat-comparison-action", theme);
            assert.deepEqual(rendered.map(row => row.service), ids);
            if (ids.length === all.length) {
                const pairs = pairwise(Object.fromEntries(rendered.map(row => [row.service, row.mid])));
                assert.equal(pairs.length, all.length * (all.length - 1) / 2); assert.ok(pairs[0].distance >= 7);
                evidence.push({ theme, rows: rendered, pairwiseOklab100: pairs });
                if (ids[0] === "Mail") {
                    for (const width of [375, 820, 1200]) for (const scale of [1, 2]) {
                        await page.setViewportSize({ width, height: 1000 });
                        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 16}px`; }, scale);
                        await chartColors(page, "#paletteChartFixture .flat-comparison-action", theme);
                        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
                        if (proofs) await page.locator("#paletteChartFixture").screenshot({ path: path.join(proofs, `all-chart-${theme}-${width}-${scale * 100}.png`) });
                    }
                    await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
                    for (const mode of ["forced", "grayscale"]) {
                        await page.emulateMedia({ forcedColors: mode === "forced" ? "active" : "none", colorScheme: theme });
                        await page.evaluate(mode => { document.body.style.filter = mode === "grayscale" ? "grayscale(1)" : ""; }, mode);
                        const cues = await page.locator("#paletteChartFixture .group-name").evaluateAll(nodes => nodes.map(node => ({
                            name: node.textContent, color: getComputedStyle(node).color,
                        })));
                        assert.equal(new Set(cues.map(cue => cue.name)).size, all.length, "Visible names preserve every identity without under-column glyphs");
                        if (mode === "forced") assert.equal(new Set(cues.map(cue => cue.color)).size, 1);
                        if (proofs) await page.locator("#paletteChartFixture").screenshot({ path: path.join(proofs, `all-chart-${theme}-${mode}.png`) });
                    }
                    await page.emulateMedia({ forcedColors: "none" });
                    await page.evaluate(() => { document.body.style.filter = ""; });
                }
            }
        }
    }
    if (proofs) await writeFile(path.join(proofs, "rendered-chart-colors.json"), JSON.stringify(evidence, null, 2));
}));

test("new synthetic human reports share category/result cues while JSON stays semantic and PDF text remains bounded", { timeout: 60000 }, async () => {
    const original = structuredClone(records);
    const bundle = await buildSanitizedBundle(records, "a".repeat(64), { promptMode: "none", formats: ["html", "pdf", "json", "markdown"] });
    assert.deepEqual(records, original);
    assert.equal(bundle.privacy.reviewerConfirmed, false);
    const snapshot = JSON.parse(bundle.files["product-report.json"]);
    for (const entry of snapshot.serviceCategories) assert.deepEqual(Object.keys(entry), ["id", "label", "description"]);
    const html = bundle.files["product-report.html"], network = [], reportMeasurements = [];
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ javaScriptEnabled: false });
        await page.route("**/*", route => { network.push(route.request().url()); return route.abort(); });
        await page.setContent(html);
        for (const media of ["screen", "print"]) for (const width of media === "screen" ? [375, 820, 1200] : [820]) {
            await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ media });
            const measured = await page.locator(".service-glossary").evaluate(node => ({
                labels: [...node.querySelectorAll("dt")].map(row => row.textContent),
                descriptions: [...node.querySelectorAll("dd")].map(row => row.textContent),
                overflow: document.documentElement.scrollWidth - innerWidth,
                clipped: [...node.querySelectorAll("dt,dd")].filter(row => row.scrollWidth > row.clientWidth + 1).map(row => row.textContent),
            }));
            assert.ok(measured.overflow <= 1);
            assert.deepEqual(measured.clipped, []);
            assert.deepEqual(measured.labels, snapshot.serviceCategories.map(entry => entry.label));
            assert.deepEqual(measured.descriptions, snapshot.serviceCategories.map(entry => entry.description));
            reportMeasurements.push({ media, width, ...measured });
            if (proofs && width === 820) await page.locator(".service-glossary").screenshot({ path: path.join(proofs, `synthetic-report-${media}.png`) });
        }
        assert.deepEqual(network, []);
    } finally { await browser.close(); }
    const loading = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
    const document = await loading.promise, pages = [];
    try {
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number), viewport = page.getViewport({ scale: 1 }), content = await page.getTextContent();
            for (const item of content.items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2, item.str);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1, item.str);
            }
            const text = content.items.map(item => item.str ?? "").join(" "); pages.push(text);
            if (proofs && text.includes("Services in this report")) {
                const view = page.getViewport({ scale: 1.5 }), canvas = document.canvasFactory.create(Math.ceil(view.width), Math.ceil(view.height));
                await page.render({ canvasContext: canvas.context, viewport: view }).promise;
                await writeFile(path.join(proofs, `synthetic-pdf-page-${number}.png`), canvas.canvas.toBuffer("image/png"));
                document.canvasFactory.destroy(canvas);
            }
        }
    } finally { await loading.destroy(); }
    const text = pages.join(" ").replace(/\s+/g, " ");
    for (const entry of snapshot.serviceCategories) {
        assert.ok(text.includes(entry.label), entry.label);
        assert.ok(text.replace(/\s+/g, "").includes(entry.description.replace(/\s+/g, "")), entry.description);
    }
    assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_PROMPT|SYNTHETIC_PRIVATE_FOLLOWUP/);
    if (proofs) {
        await writeFile(path.join(proofs, "synthetic-report.html"), html);
        await writeFile(path.join(proofs, "synthetic-report.pdf"), bundle.files["product-report.pdf"]);
        await writeFile(path.join(proofs, "synthetic-report-proof.json"), JSON.stringify({ pages: pages.length, services: snapshot.serviceCategories, network, sourceUnchanged: true, reviewerConfirmed: false, measurements: reportMeasurements }, null, 2));
    }
});

test("script-free human report rendering covers even categories withheld by the current privacy path projection", { timeout: 30000 }, async () => {
    const bundle = await buildSanitizedBundle(records, "a".repeat(64), { promptMode: "none", formats: ["json"] });
    // These invented structural paths exercise the renderer, not disclosure approval.
    // The genuine bundle test above keeps the existing projection completely intact.
    const projectedFixture = bundle.records.map((record, index) => ({
        ...record, toolCalls: record.toolCalls.map(call => ({
            ...call,
            requestedApiPath: records[index].toolCalls[0].requestedApiPath,
            requestArgs: structuredClone(records[index].toolCalls[0].requestArgs),
        })),
    }));
    const html = renderHtmlReport(projectedFixture);
    const browser = await chromium.launch(), measurements = [];
    try {
        const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 820, height: 1000 } });
        await page.route("**/*", route => { throw new Error(`No network in synthetic report: ${route.request().url()}`); });
        await page.setContent(html);
        for (const media of ["screen", "print"]) {
            await page.emulateMedia({ media });
            const measured = await page.locator(".service-glossary").evaluate(node => ({
                labels: [...node.querySelectorAll("dt")].map(row => row.textContent),
                overflow: document.documentElement.scrollWidth - innerWidth,
            }));
            assert.ok(measured.overflow <= 1);
            assert.deepEqual(measured.labels, serviceCategories.entries.map(entry => entry.label));
            measurements.push({ media, ...measured });
            if (proofs) await page.locator(".service-glossary").screenshot({ path: path.join(proofs, `all-service-report-${media}.png`) });
        }
    } finally { await browser.close(); }
    const bytes = await renderPdf(html);
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const pdf = await loading.promise, text = [];
    try {
        for (let number = 1; number <= pdf.numPages; number++) {
            const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 }), content = await page.getTextContent();
            for (const item of content.items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2, item.str);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1, item.str);
            }
            text.push(content.items.map(item => item.str ?? "").join(" "));
        }
    } finally { await loading.destroy(); }
    for (const entry of serviceCategories.entries) assert.ok(text.join(" ").replace(/\s+/g, " ").includes(entry.label), entry.id);
    assert.doesNotMatch(text.join(" "), /SYNTHETIC_PRIVATE_PROMPT|SYNTHETIC_PRIVATE_FOLLOWUP/);
    if (proofs) {
        await writeFile(path.join(proofs, "all-service-renderer-report.html"), html);
        await writeFile(path.join(proofs, "all-service-renderer-report.pdf"), bytes);
        await writeFile(path.join(proofs, "all-service-renderer-report-proof.json"), JSON.stringify({ syntheticRendererFixture: true, disclosureApproved: false, measurements }, null, 2));
    }
});
