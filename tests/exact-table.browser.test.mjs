import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture, exportCatalogFor, chooseTheme, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";

const records = Array.from({ length: 30 }, (_, index) => {
    const record = fixture(`exact-table-${index}`);
    record.sourceSessionName = "Synthetic table proof";
    record.toolCalls[0].startedAt = `2026-09-${String(index + 1).padStart(2, "0")}T12:00:00Z`;
    record.toolCalls[0].toolSucceeded = [true, false, null][index % 3];
    record.toolCalls[0].reportedOutcome = ["succeeded", "failed", "unknown"][index % 3];
    record.toolCalls[0].requestedApiPath = index % 2 ? "/me/messages" : "/me/events";
    record.toolCalls[0].requestArgs = { entityUrls: [record.toolCalls[0].requestedApiPath] };
    return record;
});
const proofDir = process.env.WORKIQ_TABLE_PROOFS;
async function setup(t, source = records) {
    const original = structuredClone(source), requests = [], errors = [];
    let latest;
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.end(renderHtmlShell("a".repeat(64), "exact-table-fixture", UNBOUND_FIXTURE_BOOTSTRAP));
            return;
        }
        requests.push(req.url);
        let body = ""; for await (const part of req) body += part;
        res.setHeader("Content-Type", "application/json");
        if (req.url !== "/api/snapshot") {
            res.statusCode = 403;
            res.end('{"error":"Only snapshot reads are permitted in this fixture."}');
            return;
        }
        latest = buildActivityAnalytics(source, JSON.parse(body));
        res.end(JSON.stringify({
            revision: 1, scenarios: source, exports: [],
            coverage: { since: "2026-09-01", until: "2026-09-30", notes: [] },
            exportCatalog: exportCatalogFor(source), analytics: { ...latest, revision: 1 },
        }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const page = await browser.newPage({ timezoneId: "America/Los_Angeles", locale: "en-US", reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("Table proof cannot read clipboard."); },
        writeText() { throw Error("Table proof cannot write clipboard."); },
    } }));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(source, original);
        assert.deepEqual(errors, []);
        assert.ok(requests.every(route => route === "/api/snapshot"));
    });
    if (proofDir) await mkdir(proofDir, { recursive: true });
    return { page, url: `http://127.0.0.1:${server.address().port}/`, current: () => latest, requests };
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function openTable(page) {
    const disclosure = page.locator("#tableDisclosure");
    if (!await disclosure.evaluate(node => node.open)) {
        await disclosure.locator("summary").focus(); await page.keyboard.press("Enter");
    }
}
async function measure(page) {
    return page.evaluate(() => {
        const rect = node => {
            const r = node.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const get = selector => document.querySelector(selector);
        const numeric = [...document.querySelectorAll("#countTable .numeric")].map(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            const text = range.getBoundingClientRect(), box = rect(node), css = getComputedStyle(node);
            return { ...box, textLeft: text.left, textRight: text.right, offset: Math.abs((text.left + text.right) / 2 - (box.left + box.right) / 2),
                align: css.textAlign, size: parseFloat(css.fontSize), figures: css.fontVariantNumeric };
        });
        const summary = rect(get("#tableDisclosure>summary")),
            pager = rect(get("#countTable .list-pager")), caption = rect(get("#countTable caption"));
        return {
            overflow: document.documentElement.scrollWidth - innerWidth,
            table: rect(get("#countTable table")), region: rect(get("#countTable")),
            rowHeights: [...document.querySelectorAll("#countTable tbody tr")].map(row => rect(row).height),
            numeric, summaryToPager: pager.top - summary.bottom, helpVisible: get("#chartReadingNotes").checkVisibility(), pagerToCaption: caption.top - pager.bottom,
            pager, caption, captionPadding: parseFloat(getComputedStyle(get("#countTable caption")).paddingBottom),
            targets: [...document.querySelectorAll("#tableDisclosure summary,#countTable button")].map(rect),
        };
    });
}
function aligned(metrics, scale = 1) {
    assert.ok(metrics.overflow <= 1, "The page does not overflow horizontally");
    assert.ok(metrics.numeric.every(cell => cell.align === "center" && cell.offset < 1), "Header, body and total text use their column centers");
    assert.ok(metrics.numeric.every(cell => cell.size >= 14 * scale && cell.figures.includes("tabular-nums")));
    assert.ok(metrics.numeric.every(cell => cell.textLeft >= cell.left - 1 && cell.textRight <= cell.right + 1), "Large numbers remain inside cells");
    assert.ok(metrics.targets.every(target => target.height >= 44 && target.width >= 44), "Readable table with intact touch targets");
    assert.ok(metrics.caption.width <= metrics.region.width + 1);
    assert.ok(metrics.summaryToPager <= 20, "Exact data follows its heading without an explanation wall");
    assert.equal(metrics.helpVisible, false);
    assert.ok(metrics.pagerToCaption <= 8 && metrics.captionPadding <= 8, "Table-local gaps stay compact");
}

test("shared exact tables stay compact and centered at 375/820/1200 in both themes and 200% text", { timeout: 90000 }, async t => {
    const { page, url } = await setup(t), measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(url); await ready(page); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        assert.ok(await page.locator("#pageIntro").evaluateAll(nodes => nodes.every(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            const bounds = node.getBoundingClientRect();
            return [...range.getClientRects()].every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.bottom <= bounds.bottom + 1);
        })), "Homepage copy wraps within its reading area");
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `home-${theme}-${width}-${scale * 100}.png`), fullPage: true });
        for (const chart of ["time", "workload", "endpoint"]) {
            await page.locator(`[data-chart="${chart}"]`).click(); await ready(page); await openTable(page);
            const metrics = await measure(page);
            aligned(metrics, scale);
            if (scale === 1) {
                assert.ok(metrics.rowHeights.every(height => height <= 50), "Normal rows improve the 69px baseline without shrinking 44px actions");
                assert.ok(metrics.pager.height < 30, "A count-only pager does not reserve button height");
                assert.ok(metrics.table.width <= 780, "Few columns do not stretch across the entire desktop");
            }
            const centerLines = await page.locator("#countTable tr").evaluateAll(rows => rows.map(row =>
                [...row.querySelectorAll(".numeric")].map(cell => { const r = cell.getBoundingClientRect(); return (r.left + r.right) / 2; })));
            assert.ok(centerLines.every(row => row.every((value, index) => Math.abs(value - centerLines[0][index]) < 1)));
            assert.equal(await page.locator("#countTable thead th:not([scope=col]),#countTable tfoot th:not([scope=row])").count(), 0);
            if (proofDir) await page.locator("#tableDisclosure").screenshot({ path: path.join(proofDir, `table-${chart}-${theme}-${width}-${scale * 100}.png`) });
            await page.locator("#countTable").evaluate(node => { node.scrollLeft = node.scrollWidth; });
            const captionLeft = await page.locator("#countTable caption").evaluate(node => node.getBoundingClientRect().left);
            assert.ok(captionLeft >= metrics.region.left - 1, "Time/filter explanation stays visible when the table scrolls");
            await page.locator("#countTable").evaluate(node => { node.scrollLeft = 0; });
            measurements.push({ theme, width, scale, chart, ...metrics });
        }
    }
    if (proofDir) await writeFile(path.join(proofDir, "table-measurements.json"), JSON.stringify(measurements, null, 2));
});

test("homepage purpose, local-history limits, calendar captions, page totals and drilldowns remain explicit", { timeout: 60000 }, async t => {
    const { page, url, current, requests } = await setup(t);
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.goto(url); await ready(page);
    assert.equal(await page.locator("#pageIntro").innerText(), "Explore recorded activity and prepare feedback reports.");
    assert.ok((await page.locator("#pageIntro").innerText()).split(/\s+/).length <= 20);
    const purpose = page.locator("#evidenceExplanation");
    assert.equal(await purpose.isVisible(), false);
    await page.locator("#coverage>summary").focus(); await page.keyboard.press("Enter");
    assert.match(await purpose.innerText(), /Work IQ activity shows tool calls and recorded results/);
    assert.match(await purpose.innerText(), /does not confirm that the whole task was completed correctly/);
    assert.match(await page.locator("#collectionEvidenceDetails").textContent(), /tool name or service category does not prove a Graph request or HTTP status/);
    assert.equal(await purpose.locator("button,a").count(), 0, "Purpose adds no competing actions");
    assert.ok(await purpose.evaluate(node => Boolean(document.querySelector("#filters").compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)));
    await page.locator("#coverage>summary").click();
    assert.equal(await page.locator("#coverageNotice").isVisible(), false);
    const note = await page.locator("#coverageNotice").textContent();
    assert.match(note, /retained evidence.*unavailable Copilot chat history.*gaps/);
    assert.match(note, /Graph requests.*inside hosted Work IQ.*not visible in local logs/);
    assert.doesNotMatch(note, /all.*failed|coverage is incomplete|remain unverified/i);
    for (const [bucket, header, meaning] of [
        ["day", "Date", /by day\./],
        ["week", "Week starting", /Dates are Mondays/],
        ["month", "Month starting", /Dates are the first of each month/],
    ]) {
        await page.goto(`${url}#home?bucket=${bucket}`); await ready(page); await openTable(page);
        assert.equal(await page.locator("#countTable thead th").first().innerText(), header);
        const caption = await page.locator("#countTable caption").innerText();
        assert.match(caption, meaning);
        assert.match(caption, /current filters/);
        assert.doesNotMatch(caption, /bucket/);
        assert.equal(await page.locator("#countTable tfoot th").innerText(), "Total (all rows)");
        assert.equal(await page.locator("#countTable tfoot td").first().innerText(), "30");
        if (bucket === "day") {
            assert.match(caption, /Totals include every page/);
            assert.equal(await page.locator("#countTable tbody tr").count(), 24);
            const before = requests.length;
            await page.getByRole("button", { name: "Next chart rows", exact: true }).focus(); await page.keyboard.press("Enter");
            assert.equal(requests.length, before, "Paging does not refetch or change scope");
            assert.equal(await page.locator("#countTable tbody tr").count(), 6);
            assert.match(await page.locator("#countTable .list-pager").innerText(), /25-30 of 30/);
            assert.equal(await page.locator("#countTable tfoot td").first().innerText(), "30");
            assert.equal(await page.locator("#countTable .list-pager>span").evaluate(node => node === document.activeElement), true);
        }
    }
    await page.goto(`${url}#home?bucket=week&range=custom&from=2026-09-02&to=2026-09-04&session=test-session`);
    await ready(page); await openTable(page);
    assert.equal(await page.locator("#countTable tbody .chart-data-action").innerText(), "Aug 31, 2026");
    assert.equal(await page.locator("#countTable tfoot td").first().innerText(), "3");
    assert.match(await page.locator("#countTable caption").innerText(), /current filters/);
    await page.locator("#countTable .chart-data-action").focus(); await page.keyboard.press("Enter"); await ready(page);
    assert.equal(current().totals.count, 3);
    assert.match(page.url(), /from=2026-09-02/); assert.match(page.url(), /to=2026-09-04/);
    assert.match(page.url(), /session=test-session/);
    assert.equal(await purpose.isVisible(), false);
    await page.goBack(); await ready(page);
    assert.equal(await page.locator("#tableDisclosure").evaluate(node => node.open), true);
    assert.equal(await purpose.isVisible(), false, "Technical explanation stays in its closed disclosure on return");
    await page.locator("#tableDisclosure>summary").focus(); await page.keyboard.press("Space");
    assert.equal(await page.locator("#countTable table").count(), 0);
});

test("long and missing labels, large numbers and empty dates retain readable table layout", { timeout: 60000 }, async t => {
    const source = [fixture("long-path"), fixture("missing-path")];
    source[0].toolCalls[0].requestedApiPath = "/me/" + "long-recorded-path-".repeat(16);
    source[0].toolCalls[0].requestArgs = { entityUrls: [source[0].toolCalls[0].requestedApiPath] };
    delete source[1].toolCalls[0].requestedApiPath;
    source[1].toolCalls[0].requestArgs = {};
    for (const record of source) delete record.capturedAt;
    const { page, url } = await setup(t, source);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`${url}#home?chart=endpoint`); await ready(page); await chooseTheme(page, theme); await openTable(page);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        assert.equal(await page.locator("#countTable tbody tr").count(), 2);
        assert.match(await page.locator("#countTable tbody").innerText(), /no endpoint reported|Not classified|not recorded/i);
        // Typography stress only; these invented strings never enter evidence or analytics.
        await page.locator("#countTable .numeric").evaluateAll(nodes => nodes.forEach(node => { node.textContent = "9,999,999,999,999"; }));
        aligned(await measure(page), scale);
        assert.ok(await page.locator("#countTable .chart-data-action").evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1)));
    }
    await page.goto(url); await ready(page); await openTable(page);
    assert.equal(await page.locator("#countTable table").count(), 0);
    assert.match(await page.locator("#countTable").innerText(), /No chart rows.*2 records without a date/s);
    assert.match(await page.locator("#countTable").innerText(), /Service and API-path views include them/);
});

test("the undated exclusion stays visible on every exact-data page", async t => {
    const undated = fixture("table-undated");
    delete undated.capturedAt;
    const { page, url } = await setup(t, [...records, undated]);
    await page.goto(`${url}#home?bucket=day`); await ready(page); await openTable(page);
    assert.equal(await page.locator("#activityCount").innerText(), "31");
    for (const direction of [null, "Next", "Previous"]) {
        if (direction) await page.getByRole("button", { name: `${direction} chart rows`, exact: true }).click();
        assert.equal(await page.locator("#countTable tfoot td").first().innerText(), "30");
        assert.equal(await page.locator("#countTable .table-note").innerText(), "1 record without a date is excluded here. Service and API-path views include them.");
    }
});
