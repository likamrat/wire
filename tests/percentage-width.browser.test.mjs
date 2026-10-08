import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture, chooseTheme, selectActivityOption } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_PERCENTAGE_WIDTH_PROOFS;
const endpoints = ["/me/messages", "/me/calendar", "/me/drive", "/teams", "/me/contacts", "/me/planner/tasks", "/me/onenote", "/groups", null];
const records = endpoints.map((endpoint, index) => {
    const record = fixture(`width-${index}`);
    record.userPrompt.text = "SYNTHETIC percentage width fixture";
    record.toolCalls = Array.from({ length: index + 1 }, (_, number) => ({
        ...record.toolCalls[0], toolCallId: `width-call-${index}-${number}`, startEventId: `width-start-${index}-${number}`,
        startedAt: `2026-09-${String(index + 1).padStart(2, "0")}T12:00:00Z`,
        tool: index % 2 ? "workiq-fetch" : "workiq-call_function", requestArgs: endpoint ? { entityUrls: [endpoint] } : {}, requestedApiPath: endpoint,
        toolSucceeded: number === 0 ? false : number === 1 ? undefined : true,
        reportedOutcome: number === 1 ? undefined : number === 0 ? "failed" : "succeeded",
    }));
    return record;
});

async function setup(t) {
    const browser = await chromium.launch();
    const page = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 1920, height: 1200 } });
    const errors = [], requests = [];
    let source = records, revision = 1;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://percentage-width.test/**", async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() === "GET" && url.pathname === "/") {
            await route.fulfill({ contentType: "text/html", body: renderHtmlShell("a".repeat(64), "percentage-width") });
            return;
        }
        requests.push(url.pathname);
        if (url.pathname !== "/api/snapshot") {
            await route.fulfill({ status: 403, json: { error: "Only synthetic snapshot reads are allowed." } });
            return;
        }
        const analytics = { ...buildActivityAnalytics(source, request.postDataJSON()), revision };
        await route.fulfill({ json: { revision, scenarios: source, exports: [], coverage: { notes: [] }, analytics } });
    });
    t.after(async () => {
        await browser.close();
        assert.deepEqual(errors, []);
        assert.ok(requests.every(url => url === "/api/snapshot"), "No checks, report actions or private-store writes");
    });
    if (proofDir) await mkdir(proofDir, { recursive: true });
    await page.goto("http://percentage-width.test/#home?bucket=week");
    await ready(page);
    return { page, change: next => { source = next; revision++; return revision; } };
}

async function ready(page) {
    await page.waitForFunction(() => document.querySelector(".percentage-section") &&
        document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function measure(page) {
    return page.evaluate(() => {
        const box = node => {
            const r = node.getBoundingClientRect(), css = getComputedStyle(node);
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
                maxWidth: css.maxWidth, columns: css.gridTemplateColumns, gap: css.columnGap, boxSizing: css.boxSizing,
                paddingLeft: parseFloat(css.paddingLeft), paddingRight: parseFloat(css.paddingRight),
                scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
        };
        const section = document.querySelector(".percentage-section");
        return {
            viewport: innerWidth, rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
            overflow: document.documentElement.scrollWidth - innerWidth,
            main: box(document.querySelector("#main")), workspace: box(document.querySelector("#workspace")),
            home: box(document.querySelector("#homeView")), upper: box(document.querySelector(".chart-panel")),
            section: box(section), heading: box(section.querySelector(".percentage-heading")),
            grid: box(section.querySelector(".percentage-panels")), total: Number(section.dataset.total),
            revision: section.dataset.revision,
            cards: [...section.querySelectorAll(".percentage-card")].map(card => ({
                ...box(card), heading: box(card.querySelector(".percentage-card-heading")),
                content: box(card.querySelector(".percentage-content")), footer: box(card.querySelector(".percentage-exact")),
                expanded: card.querySelector(".percentage-exact").open,
                counter: card.querySelector(".percentage-center") && box(card.querySelector(".percentage-center")),
                visual: card.querySelector(".percentage-visual") && box(card.querySelector(".percentage-visual")),
                legend: card.querySelector(".percentage-legend") && box(card.querySelector(".percentage-legend")),
                slices: [...card.querySelectorAll(".percentage-slice,.percentage-bar")].filter(slice => +slice.dataset.count).map(slice => ({
                    count: Number(slice.dataset.count), start: Number(slice.dataset.start || 0), end: Number(slice.dataset.end || slice.dataset.fraction), path: slice.getAttribute("d"),
                    exact: Number(slice.dataset.exactFraction ?? slice.dataset.fraction),
                })),
                rows: [...card.querySelectorAll(".percentage-legend-row")].map(row => ({
                    ...box(row), label: box(row.querySelector(".percentage-label")), value: box(row.querySelector(".percentage-value")),
                    labelText: row.querySelector(".percentage-label").textContent, pair: row.querySelector(".percentage-value").textContent,
                    percent: row.dataset.percentage, count: Number(row.dataset.count).toLocaleString(),
                    font: getComputedStyle(row.querySelector(".percentage-label")).fontSize,
                    clipped: [...row.querySelectorAll(".percentage-label,.percentage-value,.percentage-value>*")]
                        .some(node => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1),
                })),
            })),
            columns: [...document.querySelectorAll(".dimensional-column")].map(svg => ({
                total: Number(svg.dataset.total), maximum: Number(svg.dataset.maximum), edge: Number(svg.dataset.frontHeight),
            })),
        };
    });
}

function aligned(m) {
    const close = (a, b, label) => assert.ok(Math.abs(a - b) <= 1, `${label}: ${a} vs ${b} at ${m.viewport}px / ${m.rootFont}px text`);
    assert.ok(m.overflow <= 1, "No page-level horizontal overflow");
    close(m.upper.x, m.workspace.x, "Upper panel retains workspace left edge");
    close(m.upper.right, m.workspace.right, "Upper panel retains full workspace right edge");
    for (const [name, box] of Object.entries({ section: m.section, grid: m.grid })) {
        close(box.x, m.upper.x, `${name} left edge`);
        close(box.right, m.upper.right, `${name} right edge`);
    }
    close(m.heading.x, m.upper.x, "Section heading left edge");
    const [left, right] = m.cards, twoUp = Math.abs(left.y - right.y) <= 1;
    assert.equal(twoUp, m.section.width >= 64 * m.rootFont, "Actual container and text size select two-up, never host screen width");
    close(left.width, right.width, "Equal card widths");
    close(left.x, m.upper.x, "First card left edge");
    close(right.right, m.upper.right, "Last card right edge");
    if (twoUp) {
        close(right.x - left.right, 20, "Existing deliberate gutter");
        close(left.width + 20 + right.width, m.upper.width, "Combined outer border boxes");
        if (!left.expanded && !right.expanded) {
            close(left.height, right.height, "Collapsed equal heights");
            for (const lane of ["heading", "content", "footer", "counter"]) {
                if (lane === "counter" && Boolean(left.visual) !== Boolean(right.visual)) continue;
                if (left[lane] && right[lane]) close(left[lane].y, right[lane].y, `Aligned ${lane} lane`);
            }
        }
    } else {
        close(left.right, m.upper.right, "Stacked first card right edge");
        close(right.x, m.upper.x, "Stacked second card left edge");
        assert.ok(right.y >= left.bottom, "No phantom narrow column");
    }
    for (const card of m.cards) {
        assert.ok(card.content.width <= 48 * m.rootFont - 40 + 1, "Inner reading measure stays bounded");
        if (card.visual) {
            assert.ok(card.visual.width <= 22.5 * m.rootFont + 1, "Exact-angle ring has a bounded readable size");
            assert.equal(card.slices.reduce((sum, slice) => sum + slice.count, 0), m.total);
            for (const slice of card.slices) assert.ok(Math.abs(slice.exact - slice.count / m.total) < 1e-14);
            assert.ok(Math.abs(card.slices.reduce((sum, slice) => sum + slice.end - slice.start, 0) - 1) < 1e-12);
        }
        assert.ok(card.bottom - card.footer.bottom <= (card.expanded ? 28.1 : 20.1), "Only card padding and the expanded table's 8px end margin follow the footer");
        assert.ok(card.footer.width <= 48 * m.rootFont - 40 + 1, "Exact-data disclosure keeps its reading measure");
        for (const row of card.rows) {
            assert.ok(row.height >= 44);
            assert.equal(row.clipped, false, row.labelText);
            assert.equal(row.pair, `${row.percent} (${row.count})`);
            assert.ok(row.value.x >= row.label.right - 1 || row.value.y >= row.label.bottom - 1, "Label and count pair do not overlap");
            assert.ok(row.value.right <= card.right && row.right <= card.right);
            close(row.label.x, card.rows[0].label.x, "Shared legend label column");
            close(row.value.right, card.rows[0].value.right, "Shared legend numeric column");
            assert.equal(parseFloat(row.font), m.rootFont * .875, "Typography does not scale with viewport");
        }
    }
    for (const column of m.columns) assert.ok(Math.abs(column.edge - Math.max(36, Math.sqrt(column.total / column.maximum) * 320)) < .01, "The shared readable height scale is stable");
}

async function save(name, measurements) {
    if (proofDir) await writeFile(path.join(proofDir, `${name}.json`), JSON.stringify(measurements, null, 2));
}

test("percentage border boxes match full-width columns at desktop, ultrawide, narrow and enlarged text", { timeout: 120000 }, async t => {
    const { page } = await setup(t), measurements = [];
    for (const theme of ["light", "dark"]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        for (const width of [375, 820, 1200, 1466, 1920, 2560, 3440]) {
            await page.setViewportSize({ width, height: 1200 }); await ready(page);
            measurements.push({ theme, scale, ...await measure(page) });
            if (proofDir && scale === 1 && theme === "dark" && [1466, 1920, 3440].includes(width)) {
                await page.locator(".chart-panel").scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(proofDir, `width-${width}.png`), fullPage: true });
            }
        }
    }
    await save("width-matrix", measurements);
    for (const m of measurements) { assert.equal(m.total, 45); aligned(m); }
});

test("container-only wide/narrow/wide, disclosures, switches, drawer and snapshots retain full-width boundaries", { timeout: 60000 }, async t => {
    const { page, change } = await setup(t), measurements = [];
    await page.setViewportSize({ width: 3440, height: 1200 }); await ready(page);
    const original = await measure(page);
    const row = page.locator(".percentage-label[href]").first();
    await row.focus(); await page.keyboard.press("Escape");
    const focusKey = await row.getAttribute("data-view-key");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await row.focus(); await page.keyboard.press("Escape");
        for (const scale of [1, 2]) for (const width of [480, 400, 2400]) {
            await page.evaluate(({ scale, width }) => {
                document.documentElement.style.fontSize = `${scale * 100}%`;
                const main = document.querySelector("#main"), css = getComputedStyle(main);
                main.style.width = `${width + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight)}px`;
            }, { scale, width });
            await ready(page);
            const m = await measure(page); aligned(m); measurements.push({ theme, scale, container: width, ...m });
            assert.equal(m.section.width, width, "Fixture constrains the actual chart/percentage content box");
            assert.equal(await page.evaluate(() => document.activeElement.dataset.viewKey), focusKey, "CSS reflow preserves focus");
        }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; document.querySelector("#main").style.width = ""; });
    await ready(page);
    const restored = await measure(page); aligned(restored);
    assert.equal(restored.upper.width, original.upper.width);
    assert.deepEqual(restored.cards.map(card => card.slices), original.cards.map(card => card.slices));
    const composition = page.locator('[data-percentage-card="composition"]');
    await composition.getByRole("button", { name: "Tool names", exact: true }).click(); await ready(page); aligned(await measure(page));
    await composition.locator("summary").click(); aligned(await measure(page));
    await composition.locator("summary").click();
    await composition.getByRole("button", { name: "Services", exact: true }).click(); await ready(page);
    await row.focus(); await page.keyboard.press("Escape");
    const before = await measure(page);
    const revision = change(structuredClone(records));
    await page.evaluate(() => document.querySelector("#refreshBtn").click()); await ready(page);
    await page.waitForFunction(revision => document.querySelector(".percentage-section").dataset.revision === String(revision), revision);
    const after = await measure(page); aligned(after);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.viewKey), focusKey);
    assert.deepEqual(after.cards.map(card => [card.x, card.width, card.height]), before.cards.map(card => [card.x, card.width, card.height]));
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page); aligned(await measure(page));
    assert.equal((await measure(page)).cards[0].slices.length, 1);
    await page.setViewportSize({ width: 375, height: 1000 }); await ready(page);
    const narrow = await measure(page);
    await page.locator("#navigationToggle").click(); await page.keyboard.press("Escape");
    const closed = await measure(page); aligned(closed);
    assert.equal(closed.upper.width, narrow.upper.width);
    for (const source of [records.slice(0, 1), []]) {
        change(source);
        await page.evaluate(() => document.querySelector("#refreshBtn").click()); await ready(page);
        await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
        for (const width of [375, 1920, 3440]) {
            await page.setViewportSize({ width, height: 1200 }); await ready(page);
            const m = await measure(page); aligned(m); measurements.push({ sourceCount: source.length, ...m });
            assert.equal(m.total, source.reduce((sum, record) => sum + record.toolCalls.length, 0));
        }
    }
    await save("width-interactions", measurements);
});
