import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { buildAssessmentModel, assessmentOverview } from "../lib/assessment-read-model.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { fixture, exportCatalogFor, chooseTheme, openActivitySessions, automaticScoreOffSummary } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WIRE_REQUEST_METADATA_PROOFS;
const baseline = process.env.WIRE_REQUEST_METADATA_BASELINE;
const render = baseline
    ? (await import(pathToFileURL(path.join(baseline, "lib", "render.mjs")))).renderHtmlShell : renderHtmlShell;
const targets = [
    ["/me/messages"], ["/me/events"], ["/me/drive"], ["/teams"], ["/me/people"], ["/planner/tasks"],
    ["/me/onenote/pages"], ["/groups"], ["/search/query"], null,
    ["/me/events", "/unclassified"], ["/$batch"], ["/unclassified"],
];
const records = targets.map((paths, index) => {
    const record = fixture(`request-metadata-${index}`);
    record.sourceSessionId = `synthetic-chat-${index}`;
    record.sourceSessionName = `Synthetic ${serviceCategories.entries[index].label} request`;
    record.userPrompt = {
        text: index % 2 ? "Find the synthetic project update and summarize the recorded activity." : "Find the response to the synthetic project email.",
        status: "full", provenance: index % 2 ? "coordinator-message" : "human-authored",
        authorship: index % 2 ? { actor: "agent", basis: "source-agent" } : { actor: "user", basis: "source-user" },
        sourceEventId: `synthetic-message-${index}`,
        sourceTimestamp: "2026-09-30T12:02:00.000Z",
    };
    record.toolCalls[0] = { ...record.toolCalls[0],
        tool: paths ? "workiq-fetch" : "workiq-search_paths",
        requestedApiPath: paths?.length === 1 ? paths[0] : null,
        requestArgs: paths ? { entityUrls: paths } : { query: "synthetic preparation" },
        startedAt: "2026-09-30T12:03:00.000Z",
    };
    return record;
});
const long = structuredClone(records[0]);
long.scenarioId = "request-metadata-long";
long.sourceSessionId = "synthetic-chat-long";
long.sourceSessionName = "Synthetic multiple-category request";
long.userPrompt.text = "Compare recorded activity across the synthetic categories without inferring a hidden service.";
delete long.userPrompt.sourceTimestamp;
long.toolCalls = records.flatMap(record => structuredClone(record.toolCalls));
long.toolCalls.forEach((call, index) => { call.toolCallId = `synthetic-long-${String(index).padStart(2, "0")}`; });
records.push(long);
const unavailable = structuredClone(records[12]);
unavailable.scenarioId = "request-metadata-unavailable";
unavailable.sourceSessionId = "synthetic-chat-unavailable";
unavailable.sourceSessionName = "Synthetic unavailable metadata";
unavailable.userPrompt = { text: "Synthetic request with no retained timing or service.", status: "full", provenance: "recorded-user-message-origin-unverified" };
unavailable.toolCalls[0] = { tool: "workiq-ask", toolCallId: "synthetic-unavailable", requestArgs: { question: "Synthetic" }, apiResults: [] };
records.push(unavailable);

async function setup(t, contextOptions = {}) {
    const rejected = [], errors = [], requests = [], original = JSON.stringify(records);
    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: records, exports: [] };
    const model = buildAssessmentModel(state);
    const collection = { state: "not-configured", revision: 1, configVersion: 0, connected: false, config: null,
        cadence: { pollSeconds: 5 }, metrics: {}, historyIssues: [] };
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html");
            return res.end(render("a".repeat(64), "request-metadata"));
        }
        if (req.method === "GET" && ["/favicon.ico", "/favicon.svg"].includes(req.url)) return res.writeHead(204).end();
        if (req.method === "GET" && req.url === "/assets/assessment-contract.mjs") {
            res.setHeader("Content-Type", "text/javascript");
            return res.end(await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url)));
        }
        requests.push(`${req.method} ${req.url}`);
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST" && ["/api/collection/status", "/api/record/status", "/api/evaluation/automatic/summary"].includes(req.url)) {
            return res.end(JSON.stringify(req.url === "/api/record/status" ? { attempt: null }
                : req.url === "/api/evaluation/automatic/summary" ? automaticScoreOffSummary() : collection));
        }
        if (req.method === "POST" && ["/api/assessment/overview", "/api/assessment/detail", "/api/assessment/consent", "/api/snapshot"].includes(req.url)) {
            let body = ""; for await (const part of req) body += part;
            const input = JSON.parse(body);
            if (req.url === "/api/snapshot") return res.end(JSON.stringify({
                revision: 1, scenarios: records, exports: [], exportCatalog: exportCatalogFor(records), collection,
                requestActivity: buildRequestActivity(records),
                assessment: { schemaVersion: 1, basis: model.basis, catalog: model.catalog, overview: model.overview,
                    consent: model.consent, source: model.source, capabilities: model.capabilities },
                coverage: { since: "2026-09-01", until: "2026-09-30", notes: ["Invented request metadata only."] },
                analytics: { ...buildActivityAnalytics(records, { ...input, filters: { ...input.filters, includeMetadata: true } }), revision: 1 },
            }));
            const data = req.url.endsWith("/consent") ? { consent: model.consent, source: model.source, capabilities: model.capabilities }
                : req.url.endsWith("/detail") ? model.details.get(input.interactionRef) : assessmentOverview(state, model, input.interactionRefs);
            return res.end(JSON.stringify({ schemaVersion: 1, basis: model.basis, data }));
        }
        rejected.push(`${req.method} ${req.url}`);
        res.writeHead(403).end('{"error":"Synthetic request-metadata proof rejects non-read operations."}');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce",
        timezoneId: "America/Los_Angeles", locale: "en-US", ...contextOptions });
    await context.route("**/*", route => {
        if (new URL(route.request().url()).origin !== origin) { rejected.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    await context.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No clipboard access in request metadata proof."); },
        writeText() { throw Error("No clipboard access in request metadata proof."); },
    } }));
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(rejected, []); assert.deepEqual(errors, []);
        assert.equal(JSON.stringify(records), original);
    });
    await page.goto(origin + "/#activity?range=capture");
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await page.evaluate(() => document.fonts.ready);
    await openActivitySessions(page);
    if (proofs) await mkdir(proofs, { recursive: true });
    return { page, requests, origin };
}

async function geometry(card) {
    return card.evaluate(card => {
        const row = card.querySelector(".request-meta"), help = row.querySelector(".metadata-help");
        const rect = node => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const text = node => {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), boxes = [];
            while (walker.nextNode()) {
                if (!walker.currentNode.textContent.trim()) continue;
                const range = document.createRange(); range.selectNodeContents(walker.currentNode);
                boxes.push(...[...range.getClientRects()].map(r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height })));
            }
            return boxes;
        };
        const style = node => Object.fromEntries(["display", "gap", "columnGap", "justifyContent", "flexGrow", "gridTemplateColumns", "width", "padding", "margin", "lineHeight", "fontSize"].map(key => [key, getComputedStyle(node)[key]]));
        return {
            row: rect(row), rowStyle: style(row), card: rect(card), contentStyle: style(row.parentElement),
            background: getComputedStyle(card).backgroundColor, textColor: getComputedStyle(row).color,
            overflow: row.scrollWidth - row.clientWidth,
            help: rect(help), helpStyle: style(help), helpIcon: rect(help.querySelector(".metadata-tail-end>svg") || help.querySelector("svg")),
            items: [...row.querySelectorAll(":scope>.metadata-item")].map(item => ({
                box: rect(item), style: style(item), text: text(item.querySelector(".metadata-label")),
                label: item.querySelector(".metadata-label").textContent,
                separator: item.querySelector(".metadata-separator") ? rect(item.querySelector(".metadata-separator")) : null,
            })),
            cues: [...row.querySelectorAll(".service-cue")].map(cue => ({
                service: cue.dataset.service, text: cue.textContent, color: getComputedStyle(cue).color, className: cue.className,
                icon: cue.querySelector("svg")?.dataset.fluentIcon, box: rect(cue), iconBox: cue.querySelector("svg") ? rect(cue.querySelector("svg")) : null,
                hidden: cue.querySelector("svg")?.getAttribute("aria-hidden"), focusable: cue.querySelector("svg")?.getAttribute("focusable"),
            })),
        };
    });
}

const mailCard = page => page.locator(".request-row").filter({ has: page.locator('input[id="select-request-request-metadata-0"]') });
const iconName = markup => /data-fluent-icon="([^"]+)"/.exec(markup)[1];
const center = box => box.y + box.height / 2;
const overlaps = (a, b) => a.x < b.right - .1 && a.right > b.x + .1 && a.y < b.bottom - .1 && a.bottom > b.y + .1;

async function showRecord(page, origin, record) {
    await page.goto(`${origin}/#activity?range=capture&session=${record.sourceSessionId}`);
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await openActivitySessions(page);
    const card = page.locator(".request-row");
    assert.equal(await card.count(), 1);
    return card;
}

async function capture(page, node, name) {
    if (!proofs) return;
    const viewport = page.viewportSize();
    const height = Math.max(viewport.height, Math.ceil((await node.boundingBox()).height) + 300);
    // The app owns a scroll pane; a taller capture avoids blank off-pane pixels.
    await page.setViewportSize({ ...viewport, height });
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement?.blur());
    await node.screenshot({ path: path.join(proofs, `${name}.png`) });
    await page.setViewportSize(viewport);
}

function assertLayout(measure) {
    const [category, time] = measure.items;
    assert.equal(measure.items.length, 2);
    assert.ok(measure.overflow <= 1, "Metadata does not overflow.");
    assert.ok(measure.help.width >= 44 && measure.help.height >= 44);
    assert.ok(measure.help.right <= time.box.x + .1 || measure.help.bottom <= time.box.y + .1, "Help never covers the timestamp.");
    for (const item of measure.items) for (const text of item.text) {
        assert.ok(text.x >= measure.row.x - 1 && text.right <= measure.row.right + 1, "Full label/date text stays in the row.");
        assert.ok(text.y >= item.box.y - 1 && text.bottom <= item.box.bottom + 1, "Text is not vertically clipped.");
    }
    for (const text of time.text) assert.equal(overlaps(measure.help, text), false);
    assert.ok(Math.abs(center(category.text.at(-1)) - center(measure.helpIcon)) <= 1, "Info glyph follows the final label line.");
    assert.ok(Math.abs(measure.helpIcon.x - category.text.at(-1).right - 4) <= .2, "Label-to-info glyph is 4px.");
    if (Math.abs(category.box.y - time.box.y) < 1) {
        assert.ok(Math.abs(center(category.text[0]) - center(time.text[0])) <= 1, "Category and date share a baseline.");
        assert.ok(Math.abs(time.box.x - measure.helpIcon.right - 4) <= .2, "Only 4px follows the info glyph, with no trailing hit-area whitespace.");
        assert.ok(Math.abs(time.box.x - measure.help.right - 4) <= .2, "The separator follows the actual target.");
    } else {
        assert.ok(time.box.y >= category.box.bottom, "Timing wraps below the category.");
        assert.ok(Math.abs(time.box.x - measure.row.x) <= 1, "Wrapped time starts at the row edge.");
    }
    assert.ok(time.text[0].x - time.separator.right >= 3.8 && time.text[0].x - time.separator.right <= 4.2, "Separator remains attached to the timestamp.");
    for (const cue of measure.cues) {
        assert.ok(Math.abs(center(cue.iconBox) - center(category.text[0])) <= 1, "Service pictogram aligns to the first label line.");
        assert.equal(cue.hidden, "true");
        assert.equal(cue.focusable, "false");
        assert.ok(contrast(cue.color, measure.background) >= 3, "Service pictogram remains visible against its card.");
    }
    assert.ok(contrast(measure.textColor, measure.background) >= 4.5, "Metadata text remains readable.");
}

test("request metadata pairs the canonical service cue with content-sized timing", async t => {
    const { page } = await setup(t);
    const card = mailCard(page);
    await card.scrollIntoViewIfNeeded();
    const measure = await geometry(card);
    t.diagnostic(JSON.stringify(measure));
    if (proofs) {
        await capture(page, card, "mail-context");
        await writeFile(path.join(proofs, "mail-geometry.json"), JSON.stringify(measure, null, 2));
    }
    assert.equal(measure.cues.length, 1, "Mail needs a service pictogram, not only an information-help glyph.");
    assert.equal(measure.cues[0].icon, iconName(dimensionalIcons.Mail));
    assert.equal(measure.cues[0].hidden, "true");
    assert.equal(measure.cues[0].focusable, "false");
    assert.ok(measure.help.width >= 44 && measure.help.height >= 44);
    assert.ok(measure.items[1].box.x - measure.items[0].box.right <= 4.1, "Ordinary content-sized metadata gap.");
    assertLayout(measure);
});

test("normal request metadata context through themes, narrow widths and 200% text", { timeout: 60000 }, async t => {
    const { page, origin } = await setup(t), measurements = [];
    for (const [kind, record] of [["mail", records[0]], ["long", long], ["unavailable", unavailable]]) {
        const card = await showRecord(page, origin, record);
        for (const theme of ["light", "dark"]) for (const width of [1280, 820, 375]) for (const scale of [1, 2]) {
            await page.setViewportSize({ width, height: 1000 });
            await chooseTheme(page, theme);
            await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
            await card.scrollIntoViewIfNeeded();
            measurements.push({ kind, theme, width, scale, ...await geometry(card) });
            await capture(page, card, `${kind}-${theme}-${width}-${scale}`);
            if (proofs && kind === "mail" && scale === 1 && width !== 820) {
                await capture(page, page.locator(".session-group"), `activity-${theme}-${width}`);
            }
        }
    }
    if (proofs) await writeFile(path.join(proofs, "context-geometry.json"), JSON.stringify(measurements, null, 2));
    for (const measure of measurements) {
        assertLayout(measure);
        assert.equal(measure.items[1].label, measure.kind === "unavailable" ? "Request time not recorded"
            : measure.kind === "long" ? "First timed action: Sep 30, 2026, 5:03 AM" : "Message recorded: Sep 30, 2026, 5:02 AM");
    }
    t.diagnostic(`${measurements.length} normal-renderer category/time layouts.`);
});

test("every supported category and ambiguous request uses its approved local cue without changing labels or meaning", { timeout: 45000 }, async t => {
    const { page, origin } = await setup(t), inventory = [];
    for (const theme of ["light", "dark"]) for (const [index, record] of records.entries()) {
        const card = await showRecord(page, origin, record);
        await chooseTheme(page, theme);
        const measure = await geometry(card);
        const entry = serviceCategories.entries[index] || serviceCategories.describe(index === 13 ? "Multiple workloads" : "Unknown");
        inventory.push({ id: record.scenarioId, theme, ...measure });
        assert.equal(measure.cues.length, 1);
        assert.equal(measure.cues[0].service, entry.id);
        assert.equal(measure.cues[0].icon, iconName(dimensionalIcons[entry.id]));
        assert.ok(measure.cues[0].className.includes(`dimensional-tone-${createDimensionalCharts().tone(entry.id)}`));
        assert.equal(measure.items[0].label, index === 13 ? serviceCategories.entries.map(entry => entry.label).join(", ") : entry.label);
        assertLayout(measure);
        const help = card.locator(".metadata-help");
        assert.match(await help.getAttribute("aria-label"), /^About .+; recorded activity categories$/);
        assert.ok((await help.getAttribute("aria-label")).includes(measure.items[0].label), "Help accessible name includes its visible label.");
        t.diagnostic(`Category help keyboard visit: ${theme}/${index}/${entry.id}`);
        await card.locator(".request-link").focus();
        await page.keyboard.press("Tab");
        assert.equal(await help.evaluate(node => node === document.activeElement), true, "A deliberate keyboard visit reaches category help.");
        await page.getByRole("tooltip").waitFor();
        assert.ok((await page.getByRole("tooltip").textContent()).includes(entry.description));
        await page.keyboard.press("Escape");
        await help.focus();
        assert.equal(await page.getByRole("tooltip").isVisible(), false, "Programmatic refocus after Escape is not a new keyboard visit.");
        await capture(page, card, `category-${theme}-${index}`);
    }
    if (proofs) await writeFile(path.join(proofs, "category-inventory.json"), JSON.stringify(inventory, null, 2));
});

test("category help remains a nonmutating help action for hover, keyboard, touch and outside dismissal", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, { hasTouch: true });
    const card = mailCard(page), help = card.locator(".metadata-help");
    await card.scrollIntoViewIfNeeded();
    const before = await geometry(card), url = page.url();
    const controls = async () => ({
        author: await card.locator("[data-prompt-actor]").textContent(),
        selected: await card.locator('input[type="checkbox"]').isChecked(),
        results: await card.locator(".recorded-results").textContent(),
        href: await card.locator(".request-link").getAttribute("href"),
    });
    const original = await controls();
    assert.match(original.author, /Your prompt/);
    const readonlyCount = requests.length;
    await help.hover();
    await page.getByRole("tooltip").waitFor();
    const paint = await help.evaluate(button => ({
        background: getComputedStyle(button).backgroundColor,
        infoColor: getComputedStyle(button.querySelector(".metadata-tail-end>svg")).color,
        ink: getComputedStyle(document.documentElement).getPropertyValue("--ink").trim(),
    }));
    assert.equal(paint.background, "rgba(0, 0, 0, 0)", "Hover never paints the large target.");
    await page.getByRole("tooltip").hover();
    assert.equal(await page.getByRole("tooltip").isVisible(), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    await card.locator(".request-link").focus();
    await page.keyboard.press("Tab");
    assert.equal(await help.evaluate(node => node === document.activeElement), true, "Natural reading/link/help keyboard order.");
    await page.getByRole("tooltip").waitFor();
    assert.equal(await help.getAttribute("aria-describedby"), "evidence-tooltip");
    assert.ok(await help.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth) >= 2), "Keyboard focus is visible.");
    const popup = await help.evaluate(button => {
        const icon = button.querySelector(".metadata-tail-end>svg").getBoundingClientRect();
        const tip = document.querySelector("[role=tooltip]").getBoundingClientRect();
        return { gap: tip.top >= icon.bottom ? tip.top - icon.bottom : icon.top - tip.bottom,
            fits: tip.left >= 8 && tip.right <= innerWidth - 8 && tip.top >= 8 && tip.bottom <= innerHeight - 8 };
    });
    assert.ok(Math.abs(popup.gap - 8) <= 1 && popup.fits, "The existing portal stays anchored 8px from the info glyph, not the new service pictogram.");
    for (const key of ["Enter", "Space"]) {
        await page.keyboard.press("Escape");
        await page.keyboard.press(key);
        await page.getByRole("tooltip").waitFor();
    }
    await page.keyboard.press("Escape");
    await help.tap();
    await page.getByRole("tooltip").waitFor();
    await page.touchscreen.tap(2, 2);
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    assert.equal(await help.getAttribute("aria-describedby"), null);
    assert.deepEqual(await controls(), original);
    assert.equal(page.url(), url);
    assert.equal(requests.length, readonlyCount, "Help does not request evidence, filter, select, export or navigate.");
    const { background: beforeBackground, ...beforeLayout } = before;
    const { background: afterBackground, ...afterLayout } = await geometry(card);
    assert.deepEqual(afterLayout, beforeLayout, "Help interaction never moves the metadata; ordinary card hover paint is independent.");
});

test("narrow and enlarged category help keeps its full pointer target and keyboard focus", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { hasTouch: true }), states = [];
    const card = mailCard(page), help = card.locator(".metadata-help");
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1280, 2], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await help.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.activeElement?.blur());
        await page.keyboard.press("Escape");
        const target = await help.evaluate(button => {
            const target = button.getBoundingClientRect();
            return { targetWidth: target.width, targetHeight: target.height,
                hitCorners: [[target.x + 2, target.y + 2], [target.right - 2, target.y + 2], [target.x + 2, target.bottom - 2], [target.right - 2, target.bottom - 2]]
                    .every(([x, y]) => button.contains(document.elementFromPoint(x, y))) };
        });
        t.diagnostic(`Interaction state: ${theme}, ${width}px, ${scale * 100}% text`);
        await help.hover();
        await page.getByRole("tooltip").waitFor();
        assert.equal(await help.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
        await page.mouse.down();
        assert.equal(await help.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
        await page.mouse.up();
        await page.keyboard.press("Escape");
        await card.locator(".request-link").focus();
        await page.keyboard.press("Tab");
        assert.equal(await help.evaluate(node => node === document.activeElement), true);
        assert.ok(await help.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth) >= 2));
        await page.getByRole("tooltip").waitFor();
        await page.keyboard.press("Escape");
        for (const key of ["Enter", "Space"]) {
            await page.keyboard.press(key);
            await page.getByRole("tooltip").waitFor();
            await page.keyboard.press("Escape");
        }
        await help.tap();
        await page.getByRole("tooltip").waitFor();
        const state = await help.evaluate(button => {
            const icon = button.querySelector(".metadata-tail-end>svg").getBoundingClientRect();
            const popup = document.querySelector("[role=tooltip]").getBoundingClientRect();
            return {
                popupGap: popup.top >= icon.bottom ? popup.top - icon.bottom : icon.top - popup.bottom,
                popupFits: popup.left >= 8 && popup.right <= innerWidth - 8 && popup.top >= 8 && popup.bottom <= innerHeight - 8,
            };
        });
        states.push({ theme, width, scale, ...target, ...state });
        assert.ok(target.hitCorners && target.targetWidth >= 44 && target.targetHeight >= 44);
        assert.ok(Math.abs(state.popupGap - 8) <= 1 && state.popupFits);
        await page.touchscreen.tap(2, 2);
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
        assert.equal(await card.locator('input[type="checkbox"]').isChecked(), false);
    }
    if (proofs) await writeFile(path.join(proofs, "interaction-states.json"), JSON.stringify(states, null, 2));
});
