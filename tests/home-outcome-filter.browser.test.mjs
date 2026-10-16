import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { extractGraphActivities } from "../lib/graph-history.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { uxIconSources } from "../web/ux-icons.mjs";
import { contrast } from "./color-measurements.mjs";
import { fixture, privateFixture, selectActivityOption, navigateMain, chooseTheme, openActivitySessions, revealStoredRefresh, setLegacyTimeBucket } from "./helpers.mjs";

const outcomes = ["success", "failure", "unknown", "partial", "other", "transport"];
const proofs = process.env.WORKIQ_OUTCOME_PROOFS;
const resultDefinitions = createRecordedResults();

function records() {
    return ["succeeded", "failed", undefined, "partial"].map((outcome, index) => {
        const record = fixture(`shared-result-${index}`);
        record.userPrompt.text = `Synthetic shared result ${index}`;
        record.toolCalls[0] = {
            ...record.toolCalls[0], toolSucceeded: undefined, reportedOutcome: outcome,
            tool: index % 2 ? "workiq-call_function" : "workiq-fetch",
            startedAt: `2026-09-${10 + index * 5}T12:00:00Z`,
            requestArgs: { entityUrls: [index % 2 ? "/me/messages" : "/me/calendar"] },
            requestedApiPath: index % 2 ? "/me/messages" : "/me/calendar",
        };
        return record;
    });
}
async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t, source = records(), { touch = false } = {}) {
    const { context } = await privateFixture(t, source);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 960 }, reducedMotion: "reduce", hasTouch: touch });
    page.setDefaultTimeout(10000);
    const reads = [], errors = [], writes = [], snapshotRequests = [];
    let observedInitialSnapshot;
    const initialSnapshot = new Promise(resolve => { observedInitialSnapshot = resolve; });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() === "POST") {
            const pathname = new URL(request.url()).pathname;
            if (pathname === "/api/snapshot") snapshotRequests.push(request.postDataJSON());
            if (!["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview", "/api/report-artifacts/list", "/api/evaluation/automatic/summary"].includes(pathname)) writes.push(pathname);
        }
    });
    page.on("response", async response => {
        if (response.url().endsWith("/api/snapshot") && response.ok()) {
            reads.push({ input: response.request().postDataJSON(), snapshot: await response.json() });
            observedInitialSnapshot();
        }
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        assert.deepEqual(errors, []);
        assert.deepEqual(writes, [], "Outcome filters cannot mutate collection, evidence, review or reports");
    });
    await page.goto(runtime.url); await ready(page); await initialSnapshot;
    return { page, reads, snapshotRequests, context, runtime, source };
}

const number = value => Number(value.replaceAll(",", ""));

test("scope reading stays content-sized and legible without changing populated or empty evidence", { timeout: 60000 }, async t => {
    const directory = process.env.WORKIQ_SCOPE_READING_PROOFS;
    const referencePath = process.env.WORKIQ_SCOPE_READING_BASE;
    const reference = referencePath ? JSON.parse(await readFile(referencePath, "utf8")) : null;
    const measurements = [];
    let callIndex = 0;
    const source = Array.from({ length: 62 }, (_, group) => {
        const record = fixture(`scope-reading-${group}`);
        record.sourceSessionId = `scope-reading-chat-${group % 36}`;
        record.sourceSessionName = `Invented scope reading chat ${group % 36}`;
        record.toolCalls = Array.from({ length: group < 33 ? 4 : 3 }, () => {
            const index = callIndex++;
            return { ...record.toolCalls[0], toolCallId: `scope-reading-call-${index}`, startEventId: `scope-reading-start-${index}`,
                startedAt: new Date(Date.UTC(2026, 8, 4 + index % 33, 12)).toISOString(),
                toolSucceeded: index < 193 ? true : index < 218 ? false : null,
                reportedOutcome: index < 193 ? "succeeded" : index < 218 ? "failed" : undefined };
        });
        return record;
    });
    if (directory) await mkdir(directory, { recursive: true });
    for (const [state, rows] of [["populated", source], ["empty", []]]) {
        const cleanup = [];
        try {
            const { page, snapshotRequests } = await setup({ after: action => cleanup.push(action) }, rows);
            for (const theme of ["light", "dark"]) for (const width of [1920, 1200, 375]) for (const scale of [1, 2]) {
                await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
                await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
                await page.evaluate(() => document.fonts.ready);
                const key = `${state}-${theme}-${width}-${scale}`;
                const summary = page.locator("#meaning>summary"), reading = page.locator("#meaningReading>summary");
                if (await page.locator("#meaning").evaluate(node => node.open)) await summary.click();
                if (directory && scale === 1 && width === 1920) {
                    await page.evaluate(() => scrollTo(0, 0));
                    await page.screenshot({ path: path.join(directory, `${key}-normal-page.png`), fullPage: true });
                }
                const requestCount = snapshotRequests.length, route = page.url();
                await summary.focus(); await summary.press("Enter");
                if (!await page.locator("#meaningReading").evaluate(node => node.open)) { await reading.focus(); await reading.press("Enter"); }
                const value = await page.locator("#meaning").evaluate(root => {
                    const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
                    const textWidth = node => {
                        const range = document.createRange(); range.selectNodeContents(node);
                        return Math.max(0, ...[...range.getClientRects()].map(r => r.right - node.getBoundingClientRect().left));
                    };
                    const grid = selector => {
                        const node = root.querySelector(selector), children = [...node.children], css = getComputedStyle(node);
                        return { box: box(node), columns: css.gridTemplateColumns, rowGap: parseFloat(css.rowGap), columnGap: parseFloat(css.columnGap),
                            items: children.map(child => ({ box: box(child), contentWidth: Math.max(...[...child.children].map(textWidth)) })) };
                    };
                    const reading = root.querySelector("#chartReadingNotes dl"), readingCss = getComputedStyle(reading);
                    const prose = [...root.querySelectorAll("dt,dd,p,h3,summary")].filter(node => node.checkVisibility()).map(node => {
                        const range = document.createRange(); range.selectNodeContents(node);
                        const r = node.getBoundingClientRect(), css = getComputedStyle(node);
                        return { text: node.textContent, size: parseFloat(css.fontSize), lineHeight: parseFloat(css.lineHeight), color: css.color,
                            clipped: [...range.getClientRects()].some(line => line.left < r.left - 1 || line.right > r.right + 1 || line.bottom > r.bottom + 1) };
                    });
                    return { scope: grid(".scope-facts"), results: grid(".result-definitions"), panel: box(root),
                        reading: { size: parseFloat(readingCss.fontSize), lineHeight: parseFloat(readingCss.lineHeight), color: readingCss.color, box: box(reading) },
                        body: { size: parseFloat(getComputedStyle(root.querySelector("#meaningText")).fontSize), color: getComputedStyle(root.querySelector("#meaningText")).color },
                        summaries: [...root.querySelectorAll("summary")].map(node => ({ box: box(node), size: getComputedStyle(node).fontSize, padding: getComputedStyle(node).padding })),
                        facts: [...root.querySelectorAll(".scope-facts dd")].map(node => node.textContent),
                        content: root.innerText, prose, overflow: document.documentElement.scrollWidth > innerWidth,
                        cues: [...root.querySelectorAll(".result-definitions dt")].map(node => ({ key: node.dataset.outcome, color: getComputedStyle(node).color, icon: node.querySelector("svg").dataset.fluentIcon })),
                    };
                });
                measurements.push({ key, state, theme, width, scale, ...value });
                if (directory) {
                    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
                    await page.screenshot({ path: path.join(directory, `${key}-panel.png`), fullPage: true, clip: await page.locator("#meaning").boundingBox() });
                    await summary.evaluate(node => scrollTo(0, scrollY + node.getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().height - 12));
                    await page.screenshot({ path: path.join(directory, `${key}-viewport.png`) });
                }
                assert.equal(value.facts[1], `${state === "empty" ? 0 : 219} Work IQ tool calls`);
                assert.equal(value.facts[2], `${state === "empty" ? 0 : 36} Copilot chats`);
                assert.match(value.facts[3], new RegExp(`^${state === "empty" ? 0 : 62} request groups.*full retained interactions`));
                assert.equal(value.cues.length, 6);
                await reading.press("Enter");
                assert.equal(await page.locator("#chartReadingNotes").isVisible(), false);
                assert.equal(await reading.evaluate(node => node === document.activeElement), true);
                await summary.focus(); await summary.press("Enter");
                assert.equal(await page.locator("#meaning").evaluate(node => node.open), false);
                await summary.press("Enter");
                assert.equal(await page.locator("#meaningReading").evaluate(node => node.open), false);
                assert.equal(snapshotRequests.length, requestCount, "Reading and layout changes do not request or change evidence");
                assert.equal(page.url(), route);
            }
        } finally {
            for (const action of cleanup.reverse()) await action();
        }
    }
    if (directory) await writeFile(path.join(directory, "measurements.json"), JSON.stringify(measurements, null, 2));
    for (const current of measurements) {
        assert.equal(current.overflow, false, current.key);
        assert.ok(current.prose.every(item => !item.clipped), `${current.key}: full readable text stays inside its box`);
        assert.equal(current.reading.size, current.body.size, `${current.key}: guidance uses the existing reading role, not caption sizing`);
        assert.equal(current.reading.color, current.body.color, `${current.key}: guidance uses readable body ink`);
        assert.ok(current.reading.lineHeight >= current.reading.size * 1.5);
        assert.ok(current.summaries.every(row => row.box.height >= 44));
        if (current.width === 1920 && current.scale === 1) {
            const firstColumnContent = Math.max(current.scope.items[0].contentWidth, current.scope.items[2].contentWidth);
            assert.ok(Math.abs(current.scope.items[1].box.x - current.scope.items[0].box.x - firstColumnContent - current.scope.columnGap) <= 1,
                "The scope gap starts after its actual content rather than an empty fractional track");
            const narrower = measurements.find(item => item.state === current.state && item.theme === current.theme && item.width === 1200 && item.scale === 1);
            assert.equal(current.results.box.width, narrower.results.box.width, "Extra page width cannot spread out the result definitions");
        }
        const before = reference?.find(item => item.key === current.key);
        if (before) {
            assert.equal(current.content, before.content, `${current.key}: no facts or caveats removed`);
            assert.deepEqual(current.cues, before.cues, `${current.key}: no status color/icon change`);
            assert.deepEqual(current.summaries.map(row => ({ size: row.size, padding: row.padding, height: row.box.height })),
                before.summaries.map(row => ({ size: row.size, padding: row.padding, height: row.box.height })), "Disclosure row geometry remains unchanged");
            if (current.width === 1920 && current.scale === 1) {
                assert.ok(current.scope.items[1].box.x < before.scope.items[1].box.x, "Current scope's second column follows its content instead of half the page");
                assert.ok(current.results.items[1].box.x < before.results.items[1].box.x, "Result meanings use a bounded reading layout");
                assert.ok(current.results.rowGap < before.results.rowGap, "Result meanings have less unused row spacing");
            }
        }
    }
});

const selectedResults = page => page.locator("#outcomeFilter").evaluate(node => [...node.selectedOptions].map(option => option.value));
async function facetCount(page, key) {
    if (key === "all") return number((await page.locator("#outcomeFilter").getAttribute("data-all-label")).match(/\(([\d,]+)\)$/)[1]);
    const label = await page.locator(`#outcomeFilter option[value="${key}"]`).textContent();
    return number(label.match(/\(([\d,]+)\)$/)[1]);
}
async function reconcileView(page, snapshot, expectedPeriod = "All dates") {
    const data = snapshot.analytics, total = data.totals.count;
    assert.equal(number(await page.locator("#activityCount").innerText()), total);
    assert.equal(Number(await page.locator(".percentage-section").getAttribute("data-total")), total);
    for (const selector of ["#homeView", "#periodResult", "#resultSummary", ".percentage-section"]) {
        assert.equal(await page.locator(selector).getAttribute("data-revision"), String(snapshot.revision));
    }
    assert.equal(await page.locator("#activityUnit").innerText(), resultDefinitions.unit(data.layer, total));
    assert.equal(await page.locator("#periodResult").innerText(), `${total} ${resultDefinitions.unit(data.layer, total)} (${expectedPeriod})`);
    const barTotals = await page.locator("#chart .dimensional-column").evaluateAll(nodes => nodes.map(node => Number(node.dataset.total)));
    assert.equal(barTotals.reduce((sum, value) => sum + value, 0) + data.timeSeries.undatedCount, total);
    if (!new URL(page.url()).hash.includes("chart=workload")) {
        const segments = await page.locator("#chart .time-segment").evaluateAll(nodes => nodes.map(node => ({
            outcome: ["success", "failure", "unknown", "partial", "other", "transport"].find(key => node.classList.contains(key)),
            count: Number(node.dataset.count),
        })));
        for (const key of outcomes) assert.equal(segments.filter(row => row.outcome === key).reduce((sum, row) => sum + row.count, 0), data.totals[key]);
    }
    if (total) {
        if (!await page.locator("#tableDisclosure").evaluate(node => node.open)) await page.locator("#tableDisclosure > summary").click();
        assert.equal(number(await page.locator("#countTable tfoot td").first().innerText()), total - data.timeSeries.undatedCount);
    }
    for (const card of ["outcomes", "composition"]) {
        const root = page.locator(`[data-percentage-card=${card}]`);
        const legend = await root.locator(".percentage-legend-row").evaluateAll(nodes => nodes.map(node => ({
            category: node.dataset.category, count: Number(node.dataset.count), percent: node.dataset.percentage,
        })));
        assert.equal(legend.reduce((sum, row) => sum + row.count, 0), total);
        if (card === "outcomes") for (const row of legend) assert.equal(row.count, data.totals[row.category]);
        if (total && data.totals[data.rows[0].outcome] === total && card === "outcomes") assert.equal(legend.find(row => row.count).percent, "100%");
        const details = root.locator(".percentage-exact");
        if (!await details.evaluate(node => node.open)) await details.locator("summary").click();
        await details.locator(".percentage-table").waitFor();
        const counts = await details.locator("tbody tr").evaluateAll(nodes => nodes.map(node => Number(node.querySelector("td").textContent.replaceAll(",", ""))));
        assert.equal(counts.reduce((sum, value) => sum + value, 0), total);
        assert.equal(number(await details.locator("tfoot td").first().innerText()), total);
    }
}

test("multiple results stay a draft until Apply; cancel, Escape and outside leave the accepted view untouched", async t => {
    const { page, reads, snapshotRequests } = await setup(t);
    const trigger = page.getByRole("combobox", { name: "Result", exact: true });
    const original = page.url(), before = snapshotRequests.length;
    for (const dismissal of ["Cancel", "Escape", "outside"]) {
        await trigger.click();
        assert.equal(await page.getByRole("listbox", { name: "Result", exact: true }).getAttribute("aria-multiselectable"), "true");
        await page.locator(".select-all").click();
        assert.equal(await page.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
        assert.equal(await page.locator(".select-draft-hint").innerText(), "Select at least one result.");
        await page.getByRole("option", { name: "Tool failed (1)", exact: true }).click();
        await page.getByRole("option", { name: "Partly worked (1)", exact: true }).click();
        assert.equal(await trigger.getAttribute("aria-expanded"), "true");
        assert.deepEqual(await selectedResults(page), outcomes, "Draft never changes native form values");
        assert.equal(await page.locator("#activityCount").innerText(), "4");
        assert.equal(snapshotRequests.length, before);
        assert.equal(page.url(), original);
        if (dismissal === "Cancel") await page.getByRole("button", { name: "Cancel", exact: true }).click();
        else if (dismissal === "Escape") await page.keyboard.press("Escape");
        else await page.locator("#pageTitle").click();
        assert.equal(await trigger.getAttribute("aria-expanded"), "false");
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    }
    await selectActivityOption(page, "outcomeFilter", ["failure", "partial"]); await ready(page);
    assert.equal(snapshotRequests.length, before + 1, "One Apply produces one snapshot request");
    assert.deepEqual(reads.at(-1).input.filters.outcomes, ["failure", "partial"]);
    assert.deepEqual(await selectedResults(page), ["failure", "partial"]);
    assert.equal(await trigger.locator(".select-value").innerText(), "2 statuses");
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("result"), "failure,partial");
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    assert.match(await page.locator("#homeInsightScope").textContent(), /2 request groups.*full retained interactions/);
    assert.match(await page.locator("#scopeCount-current").textContent(), /2 request groups/);
    assert.match(await page.locator("#scopeCount-all").textContent(), /4 request groups/);
    assert.match(await page.locator("#scopeCount-selected").textContent(), /0 request groups/);
    for (const chart of ["time", "workload", "endpoint"]) {
        await page.locator(`[data-chart=${chart}]`).click(); await ready(page);
        await reconcileView(page, reads.at(-1).snapshot);
        assert.equal(await facetCount(page, "all"), 4);
        for (const key of outcomes) assert.equal(await facetCount(page, key), ["other", "transport"].includes(key) ? 0 : 1);
    }
    await page.reload(); await ready(page);
    assert.deepEqual(await selectedResults(page), ["failure", "partial"]);
    await selectActivityOption(page, "outcomeFilter", ["success", "unknown"]); await ready(page);
    await page.goBack(); await ready(page);
    assert.deepEqual(await selectedResults(page), ["failure", "partial"]);
    await page.goForward(); await ready(page);
    assert.deepEqual(await selectedResults(page), ["success", "unknown"]);
    await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
    await page.getByRole("button", { name: /^Remove outcome filter:/ }).click(); await ready(page);
    assert.deepEqual(await selectedResults(page), outcomes);
    assert.equal(await page.locator("#serviceFilter").inputValue(), "Calendar");
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
});

test("multi-result keyboard toggles do not apply until the Apply button is activated", async t => {
    const { page, reads, snapshotRequests } = await setup(t);
    const trigger = page.locator("#outcomeFilter-control"), before = snapshotRequests.length;
    await trigger.focus(); await trigger.press("ArrowDown");
    await page.locator(".select-all").click();
    await trigger.press("w"); await trigger.press("Space");
    await trigger.press("End"); await trigger.press("Enter");
    assert.deepEqual(await selectedResults(page), outcomes);
    assert.equal(snapshotRequests.length, before);
    assert.deepEqual(await page.locator(".select-option[aria-selected=true]").evaluateAll(nodes => nodes.map(node => node.dataset.value)), ["success", "transport"]);
    await trigger.press("Tab");
    assert.equal(await page.getByRole("button", { name: "Apply", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter"); await ready(page);
    assert.deepEqual(await selectedResults(page), ["success", "transport"]);
    assert.deepEqual(reads.at(-1).input.filters.outcomes, ["success", "transport"]);
    assert.equal(await page.locator("#activityCount").innerText(), "1", "Zero-count transport remains a selected real category");
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
});

test("late, failed and equal-count mismatched unions cannot replace the accepted result set", async t => {
    const { page, reads } = await setup(t);
    await selectActivityOption(page, "outcomeFilter", ["success", "unknown"]); await ready(page);
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        if (route.request().postDataJSON().filters.outcomes?.join(",") === "failure,partial") await hold;
        await route.fulfill({ response });
    });
    await selectActivityOption(page, "outcomeFilter", ["failure", "partial"]);
    assert.equal(await page.locator("#workspace").getAttribute("aria-busy"), "true");
    assert.deepEqual(await selectedResults(page), ["success", "unknown"]);
    assert.equal(await page.locator("#outcomeFilter-control").innerText(), "2 statuses");
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    await selectActivityOption(page, "outcomeFilter", ["success", "partial"]); await ready(page);
    const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
        && response.request().postDataJSON().filters.outcomes?.join(",") === "failure,partial");
    release(); await late;
    assert.deepEqual(await selectedResults(page), ["success", "partial"]);
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Synthetic union failure" } }));
    await selectActivityOption(page, "outcomeFilter", ["unknown", "other"]); await ready(page);
    assert.match(await page.locator("#message").innerText(), /Synthetic union failure/);
    assert.deepEqual(await selectedResults(page), ["success", "partial"]);
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("result"), "success,partial");
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", async route => {
        const input = route.request().postDataJSON();
        const response = await route.fetch({ postData: JSON.stringify({ ...input, filters: { ...input.filters, outcomes: ["unknown", "partial"] } }) });
        await route.fulfill({ response });
    });
    await selectActivityOption(page, "outcomeFilter", ["success", "failure"]); await ready(page);
    assert.match(await page.locator("#message").innerText(), /result filter does not match/);
    assert.deepEqual(await selectedResults(page), ["success", "partial"]);
    await page.unroute("**/api/snapshot");
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    await reconcileView(page, reads.at(-1).snapshot);
});

test("finishing a previously applied read preserves a newer draft without committing it", async t => {
    const { page, snapshotRequests } = await setup(t);
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        await hold;
        await route.fulfill({ response });
    });
    await selectActivityOption(page, "outcomeFilter", ["failure", "partial"]);
    const requests = snapshotRequests.length;
    await page.locator("#outcomeFilter-control").click();
    await page.locator(".select-all").click();
    await page.locator('.select-option[data-value="success"]').click();
    await page.locator('.select-option[data-value="unknown"]').click();
    release(); await ready(page);
    assert.equal(await page.locator("#outcomeFilter-control").getAttribute("aria-expanded"), "true");
    assert.deepEqual(await page.locator(".select-option[aria-selected=true]").evaluateAll(nodes => nodes.map(node => node.dataset.value)), ["success", "unknown"]);
    assert.deepEqual(await selectedResults(page), ["failure", "partial"], "Only the previously applied set is accepted");
    assert.equal(snapshotRequests.length, requests, "Finishing an earlier read never submits the newer draft");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(await selectedResults(page), ["failure", "partial"]);
    assert.equal(snapshotRequests.length, requests);
});

test("multi-result choices and Apply remain readable in light/navy, narrow layouts and enlarged text", { timeout: 60000 }, async t => {
    const { page } = await setup(t, records(), { touch: true });
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [375, 1200]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await selectActivityOption(page, "outcomeFilter", ["success", "transport"]); await ready(page);
        await page.locator("#outcomeFilter-control").click();
        assert.deepEqual(await page.locator(".select-option[aria-selected=true]").evaluateAll(nodes => nodes.map(node => node.dataset.value)), ["success", "transport"]);
        assert.equal(await page.getByRole("listbox").locator("button,input").count(), 0, "Apply and Cancel are outside the option tree");
        const popup = await page.locator(".select-popup").boundingBox();
        assert.ok(popup.x >= 7 && popup.x + popup.width <= width - 7 && popup.y >= 7 && popup.y + popup.height <= 993);
        for (const row of await page.getByRole("option").all()) {
            await row.scrollIntoViewIfNeeded();
            assert.equal(await row.evaluate(node => node.scrollWidth > node.clientWidth), false);
            const icon = row.locator(".result-legend-icon svg"), box = await icon.boundingBox();
            assert.equal(box.width, 20); assert.equal(box.height, 20);
            assert.ok((await row.boundingBox()).height >= 44);
        }
        await page.locator(".select-all").scrollIntoViewIfNeeded();
        if (proofs) await page.screenshot({ path: path.join(proofs, `multi-${theme}-${width}-${scale}-choices.png`) });
        await page.getByRole("button", { name: "Apply", exact: true }).focus();
        for (const name of ["Apply", "Cancel"]) {
            const button = page.getByRole("button", { name, exact: true }), box = await button.boundingBox();
            assert.ok(box.width >= 44 && box.height >= 44);
        }
        if (proofs) await page.screenshot({ path: path.join(proofs, `multi-${theme}-${width}-${scale}-actions.png`) });
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#outcomeFilter-control").evaluate(node => node === document.activeElement), true);
        assert.deepEqual(await selectedResults(page), ["success", "transport"]);
        assert.equal(await page.locator("#activityCount").innerText(), "1");
        if (!await page.locator("#meaning").evaluate(node => node.open)) await page.locator("#meaning>summary").click();
        assert.equal(await page.locator("#meaningMatched").innerText(), "1 Work IQ tool call");
        assert.match(await page.locator("#homeInsightScope").innerText(), /1 request group.*full retained interactions/);
        assert.equal(await page.locator("#meaning dt[data-outcome]").count(), 6);
        if (proofs) {
            await page.locator("#meaning").scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(proofs, `scope-${theme}-${width}-${scale}.png`) });
        }
    }
});

test("adjacent supporting disclosures share typography and proportional closed-row spacing", { timeout: 30000 }, async t => {
    const { page } = await setup(t, [fixture("disclosure-rhythm")]);
    const directory = process.env.WORKIQ_DISCLOSURE_PROOFS, measurements = [];
    if (directory) await mkdir(directory, { recursive: true });
    await page.locator("#meaning>summary").click();
    for (const theme of ["light", "dark"]) for (const width of [1200, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await page.evaluate(() => document.fonts.ready);
        const value = await page.evaluate(() => {
            const ids = ["meaningReading", "serviceDefinitions", "coverage"];
            const rect = node => {
                const box = node.getBoundingClientRect();
                return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
            };
            const rows = ids.map(id => {
                const parent = document.getElementById(id), summary = parent.querySelector(":scope>summary");
                const css = getComputedStyle(summary), container = getComputedStyle(parent), marker = getComputedStyle(summary, "::marker");
                const range = document.createRange(); range.selectNodeContents(summary);
                return { id, summary: rect(summary), parent: rect(parent),
                    type: { family: css.fontFamily, size: css.fontSize, weight: css.fontWeight, lineHeight: css.lineHeight },
                    marker: { size: marker.fontSize, weight: marker.fontWeight, lineHeight: marker.lineHeight, position: css.listStylePosition },
                    padding: css.padding, minHeight: css.minHeight, margin: css.margin,
                    parentSpacing: { padding: container.padding, margin: container.margin, borderTop: container.borderTopWidth, borderBottom: container.borderBottomWidth },
                    lines: [...range.getClientRects()].map(box => ({ x: box.x, y: box.y, right: box.right, bottom: box.bottom })),
                };
            });
            return { rows, gaps: [rows[1].summary.y - rows[0].summary.bottom, rows[2].summary.y - rows[1].summary.bottom],
                overflow: document.documentElement.scrollWidth > innerWidth, scrollY };
        });
        measurements.push({ theme, width, scale, ...value });
        if (directory) {
            const first = value.rows[0].parent, last = value.rows.at(-1).summary;
            await page.screenshot({ path: path.join(directory, `rows-${theme}-${width}-${scale}-closed.png`), fullPage: true,
                clip: { x: first.x, y: first.y + value.scrollY, width: Math.max(...value.rows.map(row => row.summary.right)) - first.x, height: last.bottom - first.y } });
        }
    }
    if (directory) await writeFile(path.join(directory, "row-measurements.json"), JSON.stringify(measurements, null, 2));
    for (const value of measurements) {
        const reference = value.rows[1];
        for (const row of value.rows) {
            assert.deepEqual(row.type, reference.type, `${value.theme}/${value.width}/${value.scale}/${row.id}: same supporting text role`);
            assert.deepEqual(row.marker, reference.marker, `${row.id}: marker follows the same text role`);
            assert.equal(row.padding, reference.padding, `${row.id}: shared summary padding`);
            assert.ok(row.summary.height >= 44, `${row.id}: accessible target`);
            assert.ok(row.lines.every(line => line.x >= row.summary.x - 1 && line.right <= row.summary.right + 1 && line.bottom <= row.summary.bottom + 1), `${row.id}: full wrapped text`);
        }
        assert.ok(Math.abs(value.gaps[0] - value.gaps[1]) <= 1, `${value.theme}/${value.width}/${value.scale}: consistent inter-row spacing ${value.gaps}`);
        assert.equal(value.overflow, false);
    }
});

test("supporting disclosure roles keep open content, keyboard focus and navigation state across Home and Reports", { timeout: 40000 }, async t => {
    const { page } = await setup(t, [fixture("supporting-roles")]);
    const directory = process.env.WORKIQ_DISCLOSURE_PROOFS;
    const home = ["meaningReading", "serviceDefinitions", "coverage"], reports = ["reportRequests", "bundles"];
    if (directory) await mkdir(directory, { recursive: true });
    async function shape(id) {
        return page.locator(`#${id}>summary`).evaluate(node => {
            const style = getComputedStyle(node), marker = getComputedStyle(node, "::marker"), box = node.getBoundingClientRect();
            const range = document.createRange(); range.selectNodeContents(node);
            return { role: [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.padding, marker.fontSize, marker.fontWeight, marker.lineHeight],
                height: box.height, font: parseFloat(style.fontSize), outline: style.outlineStyle,
                clipped: [...range.getClientRects()].some(line => line.left < box.left - 1 || line.right > box.right + 1 || line.bottom > box.bottom + 1) };
        });
    }
    for (const theme of ["light", "dark"]) for (const width of [1200, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        if (!await page.locator("#meaning").evaluate(node => node.open)) await page.locator("#meaning>summary").click();
        const reference = await shape("meaningReading");
        assert.ok(await page.locator("#meaning h3").first().evaluate(node => parseFloat(getComputedStyle(node).fontSize)) > reference.font, "Primary section heading stays distinct");
        for (const id of home) {
            const parent = page.locator("#" + id), summary = parent.locator(":scope>summary");
            if (await parent.evaluate(node => node.open)) await summary.click();
            const closed = await shape(id);
            assert.deepEqual(closed.role, reference.role);
            assert.ok(closed.height >= 44 && !closed.clipped);
            await summary.focus(); await summary.press("Enter");
            assert.equal(await parent.evaluate(node => node.open), true);
            assert.equal(await parent.locator(":scope>:not(summary)").first().isVisible(), true);
            assert.equal(await summary.evaluate(node => node === document.activeElement), true);
            const opened = await shape(id);
            assert.deepEqual(opened.role, reference.role);
            assert.notEqual(opened.outline, "none");
            if (directory) await summary.screenshot({ path: path.join(directory, `${id}-${theme}-${width}-${scale}-open.png`) });
            await summary.press("Space");
            assert.equal(await parent.evaluate(node => node.open), false);
            assert.equal(await summary.evaluate(node => node === document.activeElement), true);
            await summary.press("Enter");
        }
        assert.match(await page.locator("#chartReadingNotes").innerText(), /square-root scale.*minimum visible sizes.*Counts stay exact; percentages use the actual totals.*Weeks start Monday.*Review labels/s);
        assert.match(await page.locator("#coverage").innerText(), /does not confirm.*completed correctly/s);
        await navigateMain(page, "activity"); await ready(page);
        await navigateMain(page, "home"); await ready(page);
        for (const id of home) assert.equal(await page.locator("#" + id).evaluate(node => node.open), true, `${id}: open choice survives navigation`);
        await navigateMain(page, "reports"); await ready(page);
        for (const id of reports) {
            const parent = page.locator("#" + id), summary = parent.locator(":scope>summary");
            const measured = await shape(id);
            assert.deepEqual(measured.role, reference.role, `${id}: equivalent supporting role, not a one-row override`);
            assert.ok(measured.height >= 44 && !measured.clipped);
            if (await parent.evaluate(node => node.open)) await summary.click();
            await summary.focus(); await summary.press("Enter");
            assert.equal(await parent.evaluate(node => node.open), true);
            assert.equal(await summary.evaluate(node => node === document.activeElement), true);
            await summary.press("Space");
            assert.equal(await parent.evaluate(node => node.open), false);
        }
        await navigateMain(page, "home"); await ready(page);
        assert.equal(await page.locator("#activityCount").innerText(), "1");
        assert.deepEqual(await selectedResults(page), outcomes);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
});

test("one styled Outcome dropdown shares the single applied-filter removal entry", async t => {
    const { page, reads } = await setup(t);
    assert.equal(await page.locator("#activityCount").innerText(), "4");
    assert.equal(await page.getByRole("combobox", { name: "Result", exact: true }).count(), 1);
    await selectActivityOption(page, "outcomeFilter", "success");
    await ready(page);
    assert.match(page.url(), /#home\?result=success$/);
    assert.equal(await page.locator("#homeView").isVisible(), true);
    assert.deepEqual(reads.at(-1).input.filters.outcomes, ["success"]);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.equal(await page.locator("#moreFilters #outcomeFilter").count(), 0);
    assert.equal(await page.getByRole("button", { name: /^Remove result filter/ }).count(), 0);
    assert.equal(await page.locator("#resultSummary button button").count(), 0);
    assert.equal(await page.getByRole("button", { name: /^Remove outcome filter:/ }).count(), 1);
    assert.equal(await page.locator("#clearResultFilter").isVisible(), false);
    await page.locator("#outcomeFilter-control").click();
    assert.equal(await page.getByRole("option").count(), 6);
    assert.equal(await page.getByRole("option", { name: "Worked (1)", exact: true }).getAttribute("aria-selected"), "true");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Remove outcome filter:/ }).click(); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "4");
    assert.equal(await page.locator("#outcomeFilter-control").evaluate(node => node === document.activeElement), true);
});

test("the shared dropdown precedes every Home chart and keeps pre-outcome counts with an All reset", async t => {
    const { page, reads } = await setup(t);
    const baseline = reads.at(-1).snapshot.analytics;
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    const selected = reads.at(-1).snapshot.analytics;
    assert.deepEqual(selected.resultFacet, { scope: "before-outcome", totals: baseline.totals, rows: baseline.rows });
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    assert.equal(await page.locator("#outcomeFilter-control").evaluate(node => node === document.activeElement), true);
    assert.equal(await facetCount(page, "failure"), 1);
    assert.equal(await facetCount(page, "partial"), 1);
    assert.equal(await facetCount(page, "all"), 4);
    assert.equal(await page.locator("#resultSummary").evaluate(node =>
        [document.querySelector(".insight-header"), document.querySelector(".chart-panel"), document.querySelector("#percentageCharts")]
            .every(chart => Boolean(node.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING))), true);
    assert.match(await page.locator("#resultFilterScope").innerText(), /All charts: Worked only/);
    assert.match(await page.locator(".percentage-scope").innerText(), /Worked only/);
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "4");
    assert.deepEqual(await selectedResults(page), outcomes);
});

test("each outcome updates time, service, API, tool-name and exact percentages from one accepted snapshot", { timeout: 60000 }, async t => {
    const { page, reads } = await setup(t);
    for (const key of [...outcomes, "all"]) {
        await selectActivityOption(page, "outcomeFilter", key); await ready(page);
        assert.equal(await page.locator("#outcomeFilter-control").evaluate(node => node === document.activeElement), true);
        assert.deepEqual(await selectedResults(page), key === "all" ? outcomes : [key]);
        assert.equal(await page.locator("#homeView").isVisible(), true);
        for (const chart of ["time", "workload", "endpoint"]) {
            await page.locator(`[data-chart=${chart}]`).click(); await ready(page);
            await reconcileView(page, reads.at(-1).snapshot);
            for (const mode of ["tools", "services"]) {
                await page.locator(`[data-percentage-mode=${mode}]`).click();
                await reconcileView(page, reads.at(-1).snapshot);
            }
            assert.deepEqual(await selectedResults(page), key === "all" ? outcomes : [key]);
        }
        await page.locator("[data-chart=time]").click(); await ready(page);
        for (const bucket of ["day", "month", "week"]) {
            await setLegacyTimeBucket(page, bucket); await ready(page);
            await reconcileView(page, reads.at(-1).snapshot);
            assert.deepEqual(reads.at(-1).input.filters.outcomes, key === "all" ? undefined : [key]);
        }
    }
});

test("empty selection, synchronized refinements, deep links and Back/Forward keep one result filter", async t => {
    const { page, reads, runtime } = await setup(t);
    await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "0");
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "failure");
    assert.equal(await facetCount(page, "all"), 2);
    assert.match(await page.locator("#chart").innerText(), /No matching results in this view.*Remove the Outcome chip/s);
    await reconcileView(page, reads.at(-1).snapshot);
    await page.getByRole("button", { name: /^Remove outcome filter:/ }).click(); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    assert.equal(await page.locator("#outcomeFilter-control").evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#serviceFilter").inputValue(), "Calendar");
    await selectActivityOption(page, "outcomeFilter", "unknown"); await ready(page);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "unknown");
    const unknownUrl = page.url();
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    await page.goBack(); await ready(page);
    assert.equal(page.url(), unknownUrl);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "unknown");
    await page.goForward(); await ready(page);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    await page.reload(); await ready(page);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    await page.goto(runtime.url + "#home?result=partial"); await ready(page);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "partial");
    await page.locator("#resetView").click(); await ready(page);
    assert.deepEqual(await selectedResults(page), outcomes);
    assert.equal(await page.locator("#activityCount").innerText(), "4");
});

test("Home filtering preserves report membership, private Activity search and distinct chat-result drilldowns", async t => {
    const { page } = await setup(t);
    await navigateMain(page, "activity"); await ready(page); await openActivitySessions(page);
    await page.locator("#activityList .request-row input").first().check();
    assert.match(await page.locator("#scopeCount-selected").textContent(), /1 request group/);
    await page.locator("#activitySearch").fill("Synthetic shared result 0");
    await navigateMain(page, "home"); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "4", "Private Activity search is not a Home chart filter");
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    assert.match(await page.locator("#scopeCount-selected").textContent(), /1 request group/);
    assert.doesNotMatch(page.url(), /Synthetic|shared/);
    await page.locator("#activityClearSelection").click();
    assert.match(await page.locator("#scopeCount-selected").textContent(), /0 request groups/);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "failure");
    await navigateMain(page, "activity"); await ready(page);
    assert.equal(await page.locator("#activitySearch").inputValue(), "Synthetic shared result 0");
    await page.locator("#clearActivitySearch").click();
    await page.locator("#activityList a.result-link[data-outcome=failure]").first().click(); await ready(page);
    assert.match(page.url(), /#activity.*result=failure.*session=/);
    assert.equal(await page.locator("#sessionAnalysis").isVisible(), true);
});

test("HTTP, returned-result and Graph layers retain their units; code references cannot claim tool success", async t => {
    const source = records();
    for (const [index, record] of source.entries()) record.toolCalls[0].apiResults = [{ index: 0, statusCode: [200, 503, null, 302][index] }];
    source[0].httpRecords = [200, 503, null, 302, null].map((status, index) => ({
        recordId: `shared-http-${index}`, classification: "direct-graph-http", synthetic: false,
        observedGraphHttp: status !== null, responseOrigin: status !== null ? "https://graph.microsoft.com" : null,
        apiVersion: "v1.0", method: "GET", responsePath: { path: "/me/messages", query: [] }, status,
        transportError: index === 4 ? "TimeoutError" : null, startedAt: "2026-09-20T12:00:00Z",
    }));
    const graphSource = { sessionId: "11111111-1111-4111-8111-111111111111", projectId: "test-project", eligible: true,
        checkedAt: "2026-10-04T00:00:00Z", archiveEvidence: { archived_at: null, workspaces: [] } };
    const events = [{ id: "prompt", type: "user.message", timestamp: "2026-09-20T12:00:00Z", data: { content: "Synthetic graph history" } }];
    for (const [index, output] of ["HTTP/2 200", "HTTP/2 503", "No retained status", ""].entries()) {
        events.push({ id: `start-${index}`, type: "tool.execution_start", timestamp: "2026-09-20T12:00:00Z",
            data: { toolCallId: `graph-${index}`, toolName: "powershell", arguments: { command: index === 3
                ? "git diff -- src/api.ts # https://graph.microsoft.com/v1.0/me/messages" : "curl 'https://graph.microsoft.com/v1.0/me/messages'" } } });
        events.push({ id: `end-${index}`, type: "tool.execution_complete", timestamp: "2026-09-20T12:01:00Z",
            data: { toolCallId: `graph-${index}`, success: true, result: { content: output } } });
    }
    source.push(...extractGraphActivities(events, graphSource).scenarios);
    const { page } = await setup(t, source);
    for (const layer of ["reported-api", "http", "direct-request", "recorded-http"]) {
        await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
        const layerRead = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().layer === layer);
        await selectActivityOption(page, "layerFilter", layer);
        const baseline = (await (await layerRead).json()).analytics;
        await ready(page);
        const keys = outcomes.filter(key => baseline.totals[key]);
        for (const key of keys) {
            const resultRead = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
                && response.request().postDataJSON().filters.outcomes?.[0] === key);
            await selectActivityOption(page, "outcomeFilter", key);
            const snapshot = await (await resultRead).json();
            await ready(page);
            assert.equal(number(await page.locator("#activityCount").innerText()), baseline.totals[key]);
            assert.deepEqual(snapshot.analytics.resultFacet, baseline.resultFacet);
            assert.ok((await page.locator("#resultSummary").innerText()).includes(resultDefinitions.labels(layer)[key]));
            assert.doesNotMatch(await page.locator("#resultSummary").innerText(), /Worked|Tool failed/);
            await reconcileView(page, snapshot);
        }
    }
    await selectActivityOption(page, "layerFilter", "code-reference"); await ready(page);
    assert.equal(await page.locator("#resultSummary [role=combobox]").count(), 1);
    assert.match(await page.locator("#resultFilterScope").innerText(), /unavailable.*execution is not observed/);
    assert.equal(await page.locator("#outcomeFilter").isDisabled(), true);
    await page.getByRole("button", { name: /^Remove outcome filter:/ }).click(); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.equal(await page.locator("#activityUnit").innerText(), "Graph code reference");
    assert.doesNotMatch(await page.locator("#resultSummary").innerText(), /Worked|Tool failed/);
});

test("pending, failed, late and malformed reads keep the complete last accepted chart and facet", async t => {
    const { page } = await setup(t);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    await page.evaluate(() => {
        window.acceptedChart = document.querySelector("#chart").firstChild;
        window.acceptedRing = document.querySelector(".percentage-ring");
    });
    const accepted = await page.locator("#resultSummary").innerText();
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().filters.outcomes?.[0] === "failure") {
            const response = await route.fetch();
            await hold;
            await route.fulfill({ response });
        } else await route.continue();
    });
    await selectActivityOption(page, "outcomeFilter", "failure");
    assert.equal(await page.locator("#workspace").getAttribute("aria-busy"), "true");
    assert.equal((await page.locator("#resultSummary").innerText()).replace(" Updating view...", ""), accepted);
    assert.equal(await page.evaluate(() => document.querySelector("#chart").firstChild === window.acceptedChart
        && document.querySelector(".percentage-ring") === window.acceptedRing), true);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    assert.match(await page.locator("#resultFilterScope").innerText(), /Updating view/);
    assert.equal(await page.locator("#resultSummary").getAttribute("aria-busy"), "true");
    await selectActivityOption(page, "outcomeFilter", "unknown"); await ready(page);
    const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().filters.outcomes?.[0] === "failure");
    release(); await late;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "unknown");
    assert.match(page.url(), /result=unknown/);
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Synthetic result filter failure" } }));
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "unknown");
    assert.match(await page.locator("#message").innerText(), /Synthetic result filter failure/);
    assert.match(await page.locator("#periodResult").innerText(), /Previous results/);
    assert.match(page.url(), /result=unknown/);
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json();
        snapshot.analytics.resultFacet.totals.count++;
        await route.fulfill({ response, json: snapshot });
    });
    await selectActivityOption(page, "outcomeFilter", "partial"); await ready(page);
    assert.match(await page.locator("#message").innerText(), /Available result counts do not match/);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "unknown");
    await page.unroute("**/api/snapshot");
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "4");
});

test("new retained records while filtered update the same revision and preserve dropdown focus", async t => {
    const { page, reads, context, source } = await setup(t);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    const previousRevision = reads.at(-1).snapshot.revision;
    const added = structuredClone(source[1]);
    added.scenarioId = "new-failure";
    added.toolCalls[0].toolCallId = "new-failure-call";
    added.toolCalls[0].startEventId = "new-failure-event";
    await replaceEvidence(context, () => ({ records: [...source, added] }));
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await (await revealStoredRefresh(page)).click();
    const snapshot = await (await refreshed).json();
    await ready(page);
    assert.ok(snapshot.revision > previousRevision);
    assert.equal(await facetCount(page, "failure"), 2);
    assert.equal(await facetCount(page, "all"), 5);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    await reconcileView(page, snapshot);
    await page.locator("#outcomeFilter-control").focus();
    const state = await loadBoardState(context);
    const updated = structuredClone(source);
    updated[2].toolCalls[0].reportedOutcome = "succeeded";
    const background = page.waitForResponse(async response => response.url().endsWith("/api/snapshot") && response.ok()
        && (await response.json()).revision > state.revision, { timeout: 10000 });
    await replaceEvidence(context, () => ({ records: [...updated, added] }));
    await background; await ready(page);
    assert.equal(await page.locator("#activityCount").innerText(), "2");
    assert.equal(await facetCount(page, "all"), 5);
    assert.equal(await page.locator("#outcomeFilter-control").evaluate(node => node === document.activeElement), true);
});

test("equal-size snapshots from a different outcome cannot be accepted as the selected result", async t => {
    const { page } = await setup(t);
    await page.route("**/api/snapshot", async route => {
        const input = route.request().postDataJSON();
        const response = await route.fetch({ postData: JSON.stringify({ ...input, filters: { ...input.filters, outcomes: ["failure"] } }) });
        await route.fulfill({ response });
    });
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    assert.match(await page.locator("#message").textContent(), /result filter does not match/i);
    assert.deepEqual(await selectedResults(page), outcomes);
    assert.equal(await page.locator("#activityCount").innerText(), "4");
});

test("all-zero facets still offer every canonical outcome and a single local recovery", async t => {
    const { page, reads } = await setup(t, []);
    for (const key of outcomes) {
        assert.equal(await facetCount(page, key), 0);
        await selectActivityOption(page, "outcomeFilter", key); await ready(page);
        assert.equal(await page.locator("#outcomeFilter").inputValue(), key);
        assert.equal(await page.locator("#activityCount").innerText(), "0");
        assert.equal(await page.getByRole("button", { name: /^Remove outcome filter:/ }).count(), 1);
        assert.equal(await page.locator("#clearResultFilter").isVisible(), false);
        assert.equal(await page.locator("#chart button").count(), 0, "Recovery belongs to the filter, not a second reset");
        assert.deepEqual(reads.at(-1).input.filters.outcomes, [key]);
    }
    await page.getByRole("button", { name: /^Remove outcome filter:/ }).press("Enter"); await ready(page);
    assert.deepEqual(await selectedResults(page), outcomes);
    assert.equal(await page.getByRole("button", { name: /^Remove outcome filter:/ }).count(), 0);
});

test("newer dates and clearing supersede a held selection without losing scope or unsubmitted date edits", async t => {
    const { page, reads } = await setup(t);
    await selectActivityOption(page, "projectFilter", "test-project"); await ready(page);
    await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
    await selectActivityOption(page, "scopeFilter", "all"); await ready(page);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    await selectActivityOption(page, "dateFilter", "custom"); await ready(page);
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const pendingRequests = [];
    await page.route("**/api/snapshot", async route => {
        const input = route.request().postDataJSON();
        if (input.filters.outcomes?.[0] === "failure") {
            const response = await route.fetch();
            pendingRequests.push(input); await hold; await route.fulfill({ response });
        } else await route.continue();
    });
    await selectActivityOption(page, "outcomeFilter", "failure");
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    assert.equal(await page.locator("#resultFilterScope").getAttribute("data-pending"), "true");
    await page.locator("#fromFilter").fill("2026-09-20"); await page.locator("#toFilter").fill("2026-09-20");
    await page.locator("#applyDates").click();
    await page.locator("#fromFilter").fill("2026-09-21");
    await page.getByRole("button", { name: /^Remove outcome filter:/ }).click(); await ready(page);
    assert.deepEqual(await selectedResults(page), outcomes);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.equal(await page.locator("#fromFilter").inputValue(), "2026-09-21", "Unsubmitted draft is not the applied period");
    assert.equal(await page.locator("#outcomeFilter-control").evaluate(node => node === document.activeElement), true);
    assert.deepEqual(reads.at(-1).input.filters, {
        scope: "all", includeMetadata: false, projectIds: ["test-project"], workloads: ["Calendar"],
        from: "2026-09-20", to: "2026-09-20",
    });
    await reconcileView(page, reads.at(-1).snapshot, "Sep 20, 2026");
    const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
        && response.request().postDataJSON().filters.from === "2026-09-20" && response.request().postDataJSON().filters.outcomes?.[0] === "failure");
    release(); await late;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(pendingRequests.length, 2);
    assert.deepEqual(await selectedResults(page), outcomes);
    assert.equal(await page.locator("#activityCount").innerText(), "1");
    assert.equal(await page.locator("#fromFilter").inputValue(), "2026-09-21");
    assert.doesNotMatch(page.url(), /result=/);
});

test("choosing the accepted value cancels newer intent and an unchanged background poll preserves the open menu", async t => {
    const { page } = await setup(t);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        if (route.request().postDataJSON().filters.outcomes?.[0] === "failure") await hold;
        await route.fulfill({ response });
    });
    await selectActivityOption(page, "outcomeFilter", "failure");
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().filters.outcomes?.[0] === "failure");
    release(); await late;
    assert.match(page.url(), /result=success/);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
    await page.locator("#outcomeFilter-control").press("ArrowDown");
    await page.locator("#outcomeFilter-control").press("ArrowDown");
    const activeId = await page.locator("#outcomeFilter-control").getAttribute("aria-activedescendant");
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"), { timeout: 10000 });
    assert.equal(await page.locator("#outcomeFilter-control").getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("#outcomeFilter-control").getAttribute("aria-activedescendant"), activeId);
    await page.keyboard.press("Escape");
});

test("every option keeps its canonical Fluent glyph and themed outcome ink with readable selected and hover states", async t => {
    const { page } = await setup(t);
    const tones = createDimensionalCharts().outcomeTones;
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
        await page.locator("#outcomeFilter-control").click();
        for (const outcome of outcomes) {
            const option = page.locator(`.select-option[data-value="${outcome}"]`);
            await option.hover();
            const measured = await option.evaluate((node, tone) => {
                const icon = node.querySelector(".result-legend-icon"), svg = icon.querySelector("svg");
                const label = node.querySelector(".result-option-label");
                const probe = document.createElement("span"); probe.style.color = `var(--chart-${tone}-label)`; node.append(probe);
                const canonical = getComputedStyle(probe).color; probe.remove();
                return { icon: svg.dataset.fluentIcon, hidden: svg.getAttribute("aria-hidden"), color: getComputedStyle(icon).color,
                    canonical, ink: getComputedStyle(label).color,
                    fill: getComputedStyle(node).backgroundColor, text: label.textContent, overflow: node.scrollWidth > node.clientWidth };
            }, tones[outcome]);
            assert.equal(measured.icon, uxIconSources[resultDefinitions.icon(outcome)]);
            assert.equal(measured.hidden, "true");
            assert.equal(measured.color, measured.canonical);
            assert.ok(contrast(measured.ink, measured.fill) >= 4.5, `${theme}/${outcome}: label`);
            assert.ok(contrast(measured.color, measured.fill) >= 3, `${theme}/${outcome}: icon`);
            assert.ok(measured.text.startsWith(resultDefinitions.labels("tool")[outcome]));
            assert.equal(measured.overflow, false);
            assert.equal(await option.innerText(), await page.locator(`#outcomeFilter option[value="${outcome}"]`).innerText());
            assert.equal(await option.locator(".select-option-description, .select-option-detail, [title]").count(), 0);
            assert.equal(await page.getByRole("tooltip").isVisible(), false);
        }
        if (proofs) {
            await mkdir(proofs, { recursive: true });
            await page.locator("#outcomeFilter-control").press("Home");
            await page.screenshot({ path: path.join(proofs, `dropdown-menu-${theme}.png`) });
        }
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#outcomeFilter-control [title],#clearResultFilter[title]").count(), 0);
    }
});

test("Recorded result help keeps count scope and correctness limits outside choices", async t => {
    const { page, reads } = await setup(t);
    const help = page.getByRole("button", { name: "About Recorded result", exact: true });
    const count = reads.length, url = page.url();
    await help.focus();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    assert.match(await page.getByRole("tooltip").innerText(), /before result filtering.*other filters.*do not establish whole-task correctness/);
    await page.keyboard.press("Escape");
    assert.equal(reads.length, count);
    assert.equal(page.url(), url);
    await page.locator("#meaning>summary").click();
    assert.equal(await page.locator("#meaningBody dt").count(), outcomes.length, "Zero-count results retain definitions");
    assert.match(await page.locator("#meaningBody").innerText(), /not evidence of success or failure/);
    assert.match(await page.locator("#meaningBody").innerText(), /partial, not complete/);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    await navigateMain(page, "activity"); await ready(page);
    await help.click();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    assert.match(await page.getByRole("tooltip").innerText(), /does not establish that your request was answered correctly/);
    await page.keyboard.press("Escape");
    await page.locator("#outcomeFilter-control").click();
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    await page.keyboard.press("Escape");
    await selectActivityOption(page, "outcomeFilter", "unknown"); await ready(page);
    await help.focus();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    assert.match(await page.getByRole("tooltip").innerText(), /missing evidence is not success or failure/);
    await page.keyboard.press("Escape");
});

test("Activity reuses the result field and keeps its private-search clear beside the input", async t => {
    const { page } = await setup(t);
    const field = await page.locator("#resultSummary").elementHandle();
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    await navigateMain(page, "activity"); await ready(page);
    assert.equal(await field.evaluate(node => node === document.querySelector("#resultSummary")), true);
    assert.equal(await page.locator("#filters #outcomeFilter-control").isVisible(), true);
    assert.equal(await page.locator("#moreFilters #outcomeFilter-control").count(), 0);
    await page.locator("#activitySearch").fill("Synthetic shared result 0");
    assert.equal(await page.locator("#clearActivitySearch").getAttribute("aria-label"), "Clear activity search");
    assert.equal(await page.locator("#activitySearch").evaluate(node => node.parentElement.contains(document.querySelector("#clearActivitySearch"))), true);
    await page.getByRole("button", { name: /^Remove outcome filter:/ }).click(); await ready(page);
    assert.equal(await page.locator("#activitySearch").inputValue(), "Synthetic shared result 0");
    assert.deepEqual(await selectedResults(page), outcomes);
    await page.reload(); await ready(page);
    assert.equal(await page.locator("#activitySearch").inputValue(), "Synthetic shared result 0");
    await page.locator("#clearActivitySearch").click();
    assert.equal(await page.locator("#activitySearch").inputValue(), "");
    assert.equal(await page.locator("#activitySearch").evaluate(node => node === document.activeElement), true);
    assert.doesNotMatch(page.url(), /Synthetic|shared/);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.locator("#activitySearch").fill("Synthetic");
        const sizes = await page.locator(".search-input-row:has(#activitySearch)").evaluate(node => {
            const input = node.querySelector("input").getBoundingClientRect(), clear = node.querySelector("button").getBoundingClientRect();
            return { trailing: clear.left >= input.right, sameRow: Math.abs(clear.top + clear.height / 2 - input.top - input.height / 2) < 1,
                target: clear.width >= 44 && clear.height >= 44, overflow: node.scrollWidth > node.clientWidth || document.documentElement.scrollWidth > innerWidth };
        });
        assert.deepEqual(sizes, { trailing: true, sameRow: true, target: true, overflow: false }, `${theme}/${width}/${scale}`);
        await page.locator("#clearActivitySearch").press("Enter");
        assert.equal(await page.locator("#activitySearch").inputValue(), "");
    }
});

test("shared dropdown and trailing clear keep keyboard/touch targets and full labels in both themes", { timeout: 90000 }, async t => {
    const { page } = await setup(t, records(), { touch: true });
    const measurements = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 960 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        const choice = page.locator("#outcomeFilter-control");
        await choice.scrollIntoViewIfNeeded();
        await choice.focus(); await page.keyboard.press("Enter");
        await page.locator(".select-all").click();
        await page.keyboard.press("w");
        assert.equal(await page.locator(".select-option[data-active=true]").getAttribute("data-value"), "success", `${theme}/${width}/${scale}: typeahead`);
        await page.keyboard.press("Enter"); await page.keyboard.press("Tab"); await page.keyboard.press("Enter"); await ready(page);
        assert.equal(await choice.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator("#outcomeFilter").inputValue(), "success");
        await choice.scrollIntoViewIfNeeded();
        const sizes = await page.locator("#resultSummary .select-trigger, #filterChips [aria-label^='Remove outcome filter:']").evaluateAll(nodes => nodes.map(node => {
            const box = node.getBoundingClientRect(), style = getComputedStyle(node);
            return { width: box.width, height: box.height, right: box.right, scroll: node.scrollWidth - node.clientWidth,
                outline: style.outlineStyle, text: node.textContent };
        }));
        assert.ok(sizes.every(size => size.width >= 44 && size.height >= 44 && size.right <= width && size.scroll <= 1), `${theme}/${width}/${scale}`);
        assert.equal(await page.locator("#resultSummary .ux-help").count(), 1);
        assert.equal(await page.locator("#resultSummary [role=combobox]").count(), 1);
        assert.equal(await page.locator("#resultSummary").getAttribute("aria-describedby"), "resultFilterScope");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const geometry = await page.locator("#resultSummary").evaluate(node => {
            const trigger = node.querySelector("[role=combobox]").getBoundingClientRect();
            const clear = document.querySelector("#filterChips [aria-label^='Remove outcome filter:']");
            return { inAppliedScope: Boolean(clear.closest("#appliedFilters")), belowField: clear.getBoundingClientRect().top >= trigger.bottom,
                selectedFits: node.querySelector(".select-value").scrollWidth <= node.querySelector(".select-value").clientWidth };
        });
        assert.deepEqual(geometry, { inAppliedScope: true, belowField: true, selectedFits: true });
        await choice.press("ArrowDown");
        assert.equal(await page.getByRole("option", { name: "Worked (1)", exact: true }).getAttribute("aria-selected"), "true");
        assert.equal(await page.getByRole("option").count(), 6);
        if (proofs) await page.screenshot({ path: path.join(proofs, `menu-${theme}-${width}-${scale}.png`) });
        assert.deepEqual(await page.getByRole("option").allInnerTexts(), await page.locator("#outcomeFilter option").allTextContents());
        assert.equal(await page.locator(".select-option-description, .select-option-detail").count(), 0);
        const optionSizes = await page.getByRole("option").evaluateAll(nodes => nodes.map(node => ({
            overflow: node.scrollWidth > node.clientWidth, height: node.getBoundingClientRect().height,
        })));
        assert.ok(optionSizes.every(row => !row.overflow && row.height >= 44), `${theme}/${width}/${scale}: ${JSON.stringify(optionSizes)}; coarse=${await page.evaluate(() => matchMedia("(pointer:coarse)").matches)}`);
        await page.keyboard.press("Escape");
        const clear = page.getByRole("button", { name: /^Remove outcome filter:/ });
        await clear.focus(); await clear.press("Tab"); await page.keyboard.press("Shift+Tab");
        assert.equal(await clear.evaluate(node => node === document.activeElement), true);
        assert.equal(await clear.evaluate(node => getComputedStyle(node).outlineStyle !== "none"), true);
        measurements.push({ theme, width, scale, sizes });
        if (proofs) {
            await page.keyboard.press("Escape");
            await page.mouse.move(0, 0);
            await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
            await page.screenshot({ path: path.join(proofs, `outcome-${theme}-${width}-${scale}.png`) });
        }
        const controlWidth = (await choice.boundingBox()).width;
        await clear.tap(); await ready(page);
        assert.deepEqual(await selectedResults(page), outcomes);
        assert.equal(await clear.count(), 0);
        assert.equal((await choice.boundingBox()).width, controlWidth);
    }
    await page.locator("#outcomeFilter-control").focus(); await page.keyboard.press("Space");
    await page.locator(".select-all").click();
    await page.keyboard.press("n"); await page.keyboard.press("o"); await page.keyboard.press("Enter");
    await page.keyboard.press("Tab"); await page.keyboard.press("Enter"); await ready(page);
    assert.equal(await page.locator("#outcomeFilter").inputValue(), "unknown");
    assert.equal(await page.locator("#outcomeFilter-control").evaluate(node => node === document.activeElement), true);
    await page.getByRole("button", { name: /^Remove outcome filter:/ }).focus(); await page.keyboard.press("Space"); await ready(page);
    assert.deepEqual(await selectedResults(page), outcomes);
    await page.evaluate(() => { document.querySelector("#main").style.maxWidth = "375px"; });
    await selectActivityOption(page, "outcomeFilter", "unknown"); await ready(page);
    assert.equal(await page.locator("#resultSummary").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    if (proofs) await writeFile(path.join(proofs, "outcome-layout.json"), JSON.stringify(measurements, null, 2));
});
