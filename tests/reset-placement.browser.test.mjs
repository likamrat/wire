import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture, exportCatalogFor, automaticScoreOffSummary, chooseTheme, navigateMain, openActivitySessions, selectActivityOption, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";
import { reportContents } from "./report-journey-helpers.mjs";

const proofs = process.env.WIRE_RESET_PLACEMENT_PROOFS;
const filterIds = ["dateFilter", "outcomeFilter", "promptAuthorFilter", "serviceFilter", "projectFilter", "layerFilter", "scopeFilter"];
const readEndpoints = ["/api/snapshot", "/api/evaluation/automatic/summary", "/api/collection/status"];
const lastSnapshot = requests => requests.filter(request => request.path === "/api/snapshot").at(-1).input;
const ready = page => page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function setup(t) {
    const records = Array.from({ length: 10 }, (_, index) => {
        const record = fixture(`reset-placement-${index}`);
        record.sourceSessionId = "invented-reset-chat";
        record.sourceSessionName = "Invented filter placement chat";
        record.projectId = "invented-reset-project";
        record.project = "Invented filter placement project";
        record.userPrompt.text = `Invented filter placement request ${index + 1}`;
        record.followUpPrompts = [];
        record.toolCalls[0].startedAt = record.capturedAt;
        return record;
    });
    const collection = { revision: 1, configVersion: 1, state: "paused", connected: true,
        config: { approved: true, enabled: false, appDbPath: "C:\\Invented\\source.db",
            sessionRoot: "C:\\Invented\\history", windowDays: 30, pollSeconds: 30 },
        cadence: { pollSeconds: 30, browserPollSeconds: 5 }, metrics: {},
        historyCoverage: { eligible: 1, readable: 1, unavailable: 0, limited: 0, pending: 0, affected: 0, excluded: {} },
    };
    const state = { boardId: "invented-reset-placement", revision: 1, scenarios: records, exports: [], collection,
        coverage: { since: "2026-09-01", until: "2026-10-01", notes: [] } };
    const original = structuredClone(state), requests = [], blocked = [], errors = [];
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.end(renderHtmlShell("a".repeat(64), "invented-reset-placement-nonce", UNBOUND_FIXTURE_BOOTSTRAP));
            return;
        }
        let body = ""; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        requests.push({ path: req.url, input });
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/snapshot") {
            res.end(JSON.stringify({ ...state, exportCatalog: exportCatalogFor(records),
                analytics: { ...buildActivityAnalytics(records, input), revision: 1 } }));
        } else if (req.url === "/api/evaluation/automatic/summary") {
            res.end(JSON.stringify(automaticScoreOffSummary()));
        } else if (req.url === "/api/collection/status") {
            res.end(JSON.stringify(collection));
        } else {
            res.statusCode = 403; res.end(JSON.stringify({ error: "Invented read-only fixture." }));
        }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1602, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(6000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), target = new URL(request.url());
        if (target.origin !== url || (request.method() !== "GET" && !readEndpoints.includes(target.pathname))) {
            blocked.push(target.pathname); return route.abort();
        }
        return route.continue();
    });
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(state, original, "Browsing never changes stored records or saved reports");
        assert.deepEqual(blocked, [], "No source, model, export, settings or permission requests");
        assert.deepEqual(errors, []);
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(url + "/#home?service=Calendar"); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    assert.notEqual(await page.locator("#collectionNotice").getAttribute("data-severity"), "error", await page.locator("#collectionNotice").innerText());
    return { page, url, records, requests };
}

async function geometry(page) {
    return page.evaluate(ids => {
        const box = node => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const reset = document.querySelector("#resetView");
        const dates = document.querySelector("#dateFields");
        return { reset: box(reset), first: box(document.querySelector("#dateFilter-control")),
            last: box(document.querySelector("#scopeFilter-control")), host: box(reset.parentElement),
            parent: reset.parentElement.id, scroll: box(document.querySelector(".filter-scroll")),
            dates: dates.checkVisibility() ? box(dates) : null,
            fields: ids.map(id => {
                const control = document.getElementById(id + "-control"), value = control.querySelector(".select-value");
                const label = document.querySelector(`label[for="${id}-control"]`), text = document.createRange();
                text.selectNodeContents(label);
                return { id, ...box(control), visible: control.checkVisibility(),
                    clipped: value.scrollWidth > value.clientWidth + 1,
                    labelLines: text.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight) };
            }),
            overflow: document.documentElement.scrollWidth - innerWidth, viewport: innerWidth };
    }, filterIds);
}

async function capture(page, name, metrics) {
    if (!proofs) return;
    await page.screenshot({ path: path.join(proofs, name + ".png") });
    await page.locator("#filters").screenshot({ path: path.join(proofs, name + "-filters.png") });
    await writeFile(path.join(proofs, name + ".json"), JSON.stringify(metrics, null, 2));
}

test("Reset to Home stays next to its analytical controls, not the far edge of an empty row", async t => {
    const { page } = await setup(t);
    await chooseTheme(page, "dark"); await frames(page);
    const metrics = await geometry(page);
    await capture(page, "filtered-desktop", metrics);
    t.diagnostic(JSON.stringify(metrics));
    const beside = Math.abs(metrics.reset.bottom - metrics.last.bottom) <= 4
        && metrics.reset.x - metrics.last.right >= 0 && metrics.reset.x - metrics.last.right <= 16;
    const below = Math.abs(metrics.reset.x - metrics.first.x) <= 8
        && metrics.reset.y >= metrics.first.bottom && metrics.reset.y - metrics.first.bottom <= 16;
    assert.ok(beside || below, "Reset must be adjacent to the filter controls, not at the far page edge");
});

function grouped(metrics) {
    assert.equal(metrics.parent, "filterTools");
    assert.ok(Math.abs(metrics.reset.x - metrics.scroll.x) <= 4, "Reset follows the leading edge, independently of horizontal filter scrolling");
    assert.ok(Math.abs(metrics.host.width - metrics.reset.width) <= 1, "No full-width empty action row");
    const anchor = metrics.dates || metrics.scroll;
    assert.ok(metrics.reset.y >= anchor.bottom && metrics.reset.y - anchor.bottom <= 8, "Reset immediately follows the analytical controls");
    assert.ok(metrics.reset.height >= 44 && metrics.reset.width >= 44);
    assert.ok(metrics.reset.x >= 0 && metrics.reset.right <= metrics.viewport, "The complete Reset target stays in the viewport");
    assert.ok(metrics.overflow <= 1, "No page-level overflow");
    assert.equal(metrics.fields.length, 7);
    for (const field of metrics.fields) {
        assert.ok(field.visible && field.height >= 44 && !field.clipped, `${field.id}: visible, intrinsically readable, 44px target`);
        assert.ok(field.labelLines <= 1.05, `${field.id}: single-line label`);
        assert.ok(Math.abs(field.y - metrics.first.y) <= 1, `${field.id}: unchanged shared dropdown baseline`);
    }
}

test("default, filtered, long-selection, date and draft states retain the local action in both themes at normal, narrow and 200 percent text", { timeout: 60000 }, async t => {
    const { page, url, requests } = await setup(t);
    const measurements = [];
    for (const theme of ["dark", "light"]) for (const [width, scale] of [[1602, 1], [375, 1], [1602, 2], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const [name, route] of [
            ["default", "#home"],
            ["filtered", "#home?service=Calendar"],
            ["long-selection", "#home?project=invented-reset-project"],
            ["custom-dates", "#home?range=custom&from=2026-09-29&to=2026-10-01"],
            ["activity", "#activity?service=Calendar"],
            ["chat", "#activity?service=Calendar&session=invented-reset-chat"],
        ]) {
            await page.goto(url + "/" + route); await ready(page); await chooseTheme(page, theme);
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
            await page.locator(".filter-scroll").evaluate(node => { node.scrollLeft = 0; });
            await page.locator("#filters").scrollIntoViewIfNeeded(); await frames(page);
            const metrics = await geometry(page), prefix = `${theme}-${width}-${scale}-${name}`;
            measurements.push({ theme, width, scale, name, ...metrics });
            if (name === "default") {
                assert.equal(await page.locator("#resetView").isVisible(), false);
                assert.equal(metrics.host.height, 0, "Canonical Home reserves no empty reset row");
            } else grouped(metrics);
            await capture(page, prefix, metrics);
        }
        await page.goto(url + "/#home?service=Calendar"); await ready(page);
        const route = page.url(), count = await page.locator("#activityCount").textContent();
        const before = requests.filter(request => request.path === "/api/snapshot").length;
        await page.locator("#promptAuthorFilter-control").click();
        const popup = page.locator(".select-popup:visible");
        await popup.locator('[data-value="agent"]').click();
        assert.equal(page.url(), route);
        assert.equal(await page.locator("#activityCount").textContent(), count);
        assert.equal(requests.filter(request => request.path === "/api/snapshot").length, before, "An uncommitted multiselect draft issues no analytical read");
        const bounds = await popup.boundingBox();
        assert.ok(bounds.x >= 8 && bounds.x + bounds.width <= width - 8 + 1);
        assert.equal(await popup.evaluate(node => node.parentElement === document.body), true, "Popup is not clipped by either filter or reset groups");
        await capture(page, `${theme}-${width}-${scale}-draft`, await geometry(page));
        await popup.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(page.url(), route);
        assert.equal(await page.locator("#promptAuthorFilter-control").evaluate(node => node === document.activeElement), true);
        await page.locator("#scopeFilter-control").focus();
        await page.keyboard.press("Tab"); await frames(page);
        assert.equal(await page.evaluate(() => document.activeElement.id), "resetView", "Reset immediately follows the seven-filter keyboard sequence");
        grouped(await geometry(page));
        assert.ok((await page.locator("#resetView").getAttribute("aria-describedby")).split(" ").includes("resetScopeHelp"));
        const focus = await page.locator("#resetView").evaluate(node => ({
            visible: node.matches(":focus-visible"), outline: getComputedStyle(node).outlineStyle,
            clipped: node.scrollWidth > node.clientWidth + 1,
        }));
        assert.ok(focus.visible && focus.outline !== "none" && !focus.clipped, "The native button retains readable keyboard focus");
        const tooltip = page.getByRole("tooltip");
        await tooltip.waitFor({ state: "visible" });
        const tip = await tooltip.boundingBox(), reset = await page.locator("#resetView").boundingBox();
        assert.ok(tip.x >= 8 && tip.x + tip.width <= width - 8 + 1 && tip.y >= 8 && tip.y + tip.height <= 992);
        const gap = tip.y >= reset.y + reset.height ? tip.y - reset.y - reset.height : reset.y - tip.y - tip.height;
        assert.ok(Math.abs(gap - 8) <= 1, "Reset help retains its standard 8px anchor gap");
        await capture(page, `${theme}-${width}-${scale}-reset-focus`, await geometry(page));
        await page.keyboard.press("Escape");
    }
    if (proofs) await writeFile(path.join(proofs, "layout-matrix.json"), JSON.stringify(measurements, null, 2));
});

test("Reset keeps applied versus draft dates and filter Apply/Cancel semantics", async t => {
    const { page, requests } = await setup(t);
    await selectActivityOption(page, "dateFilter", "custom"); await ready(page);
    const before = requests.filter(request => request.path === "/api/snapshot").length, count = await page.locator("#activityCount").textContent();
    await page.locator("#fromFilter").fill("2026-09-30"); await page.locator("#toFilter").fill("");
    await page.locator("#applyDates").click();
    assert.equal(await page.locator("#dateError").isVisible(), true);
    assert.equal(requests.filter(request => request.path === "/api/snapshot").length, before, "Invalid date draft never applies");
    assert.equal(await page.locator("#activityCount").textContent(), count);
    grouped(await geometry(page));
    await page.locator("#toFilter").fill("2026-09-30");
    await page.locator("#applyDates").click(); await ready(page);
    assert.equal(lastSnapshot(requests).filters.from, "2026-09-30");
    assert.equal(lastSnapshot(requests).filters.to, "2026-09-30");
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    assert.deepEqual(lastSnapshot(requests).filters.outcomes, ["success"]);
    await page.locator("#promptAuthorFilter-control").click();
    await page.locator('.select-popup [data-value="agent"]').click();
    const applied = page.url();
    await page.keyboard.press("Escape");
    assert.equal(page.url(), applied, "Escape discards the draft");
    await page.locator("#resetView").click(); await ready(page); await frames(page);
    assert.equal(new URL(page.url()).hash, "#home");
    assert.equal(await page.locator("#dateFields").isVisible(), false);
    assert.equal(await page.locator("#fromFilter").inputValue(), "");
    assert.equal(await page.locator("#toFilter").inputValue(), "");
    assert.deepEqual(lastSnapshot(requests).filters, { scope: "history", includeMetadata: false });
});

test("Home, Activity, chat and request scope share one reset while selection, report choices, Back and focus stay intact", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t);
    await chooseTheme(page, "dark");
    await navigateMain(page, "activity"); await ready(page); await openActivitySessions(page);
    const checkbox = page.locator('.request-row[data-view-key="request:reset-placement-0"] input[type=checkbox]');
    await checkbox.check();
    await page.evaluate(() => { window.originalResetNode = document.querySelector("#resetView"); });
    grouped(await geometry(page));
    await navigateMain(page, "reports"); await ready(page); await reportContents(page);
    await page.locator('[name=promptMode][value=original]').check();
    await page.locator('#formatOptions input[value=json]').check();
    assert.equal(await page.locator("#resetView").isVisible(), false, "Reports has no unrelated analytical reset");
    const selected = await page.locator("#previewSelectionSummary").textContent();
    await navigateMain(page, "activity"); await ready(page);
    const scoped = "#activity?chart=endpoint&bucket=month&range=custom&from=2026-09-29&to=2026-10-01&project=invented-reset-project&service=Calendar&result=success&authors=unknown&scope=all&session=invented-reset-chat&page=2&expanded=true&layer=direct-request&endpoint=%2Fme%2FcalendarView";
    await page.evaluate(hash => { location.hash = hash; }, scoped); await ready(page);
    await page.locator("#activitySearch").fill("Invented private query"); await frames(page);
    const previous = new URL(page.url()).hash;
    assert.ok(!previous.includes("private"), "Private query stays out of the URL");
    grouped(await geometry(page));
    await page.locator(".skip-link").focus(); await page.keyboard.press("Enter"); await frames(page);
    assert.equal(new URL(page.url()).hash, previous, "Skip retains the scoped route");
    assert.equal(await page.evaluate(() => document.activeElement.id), "pageTitle");
    await page.locator("#resetView").click(); await ready(page); await frames(page);
    assert.equal(new URL(page.url()).hash, "#home");
    assert.equal(await page.locator("#activitySearch").inputValue(), "");
    assert.equal(await page.locator("#resetView").isVisible(), false);
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), selected);
    assert.equal(await page.locator('[name=promptMode][value=original]').isChecked(), true);
    assert.equal(await page.locator('#formatOptions input[value=json]').isChecked(), true);
    assert.equal(await page.locator("html").getAttribute("data-evidence-theme"), "dark");
    const { timeContext, ...query } = lastSnapshot(requests);
    assert.deepEqual(query, { layer: "tool", groupBy: "workload", bucket: "week", filters: { scope: "history", includeMetadata: false }, limit: 8 });
    assert.equal(timeContext.timeZone, "UTC");
    assert.equal(await page.evaluate(() => document.activeElement.id), "pageTitle");
    assert.equal(await page.evaluate(() => scrollY), 0);
    const outline = await page.locator("#pageTitle").evaluate(node => getComputedStyle(node).outlineStyle);
    assert.equal(outline, "none", "The accepted passive heading treatment stays intact");
    await page.goBack(); await ready(page); await frames(page);
    assert.equal(new URL(page.url()).hash, previous);
    assert.equal(await page.locator("#activitySearch").inputValue(), "Invented private query");
    await page.goForward(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home");
    await navigateMain(page, "activity"); await ready(page); await openActivitySessions(page);
    assert.equal(await checkbox.isChecked(), true, "Reset never clears selected report membership");
    await page.getByRole("link", { name: "Open analysis for GitHub Copilot chat: Invented filter placement chat", exact: true }).click(); await ready(page);
    grouped(await geometry(page));
    await page.locator('.request-row[data-view-key="request:reset-placement-0"] .request-link').click(); await ready(page);
    assert.equal(await page.locator("#scopeResetActions #resetView").isVisible(), true, "Request keeps its contextual reset host");
    assert.equal(await page.locator("#resetView").count(), 1);
    assert.equal(await page.evaluate(() => window.originalResetNode === document.querySelector("#resetView")), true, "Navigation moves the existing action; it never clones it");
    for (const theme of ["dark", "light"]) for (const [width, scale] of [[1602, 1], [375, 1], [1602, 2], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        const reset = page.locator("#scopeResetActions #resetView");
        await reset.scrollIntoViewIfNeeded(); await frames(page);
        const box = await reset.boundingBox();
        assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width);
        assert.equal(await reset.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (proofs) await page.screenshot({ path: path.join(proofs, `${theme}-${width}-${scale}-request.png`) });
    }
    await page.locator("#resetView").focus(); await page.keyboard.press("Enter"); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home");
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), selected);
    for (const view of ["settings", "collection-status"]) {
        await navigateMain(page, view); await ready(page);
        assert.equal(await page.locator("#resetView").isVisible(), false, `${view} has no unrelated reset`);
    }
});
