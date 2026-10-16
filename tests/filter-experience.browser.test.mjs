import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { chooseTheme, navigateMain, navigateSettings, selectActivityOption, restoreLegacySearch, fixture, privateFixture } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { contrast } from "./color-measurements.mjs";

const proofDir = process.env.WIRE_FILTER_EXPERIENCE_PROOFS;
const geometryDir = process.env.WIRE_FILTER_GEOMETRY_PROOFS;
const ready = page => page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
async function setup(t, options = {}, source, observeSnapshot = response => response.json()) {
    const app = source || await authorFilterFixture(t, { serviceCases: true }), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce", ...options });
    page.setDefaultTimeout(8000);
    const errors = [], denied = [], reads = [];
    let snapshotRead;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const safe = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail", "/api/assessment/consent",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list", "/api/search/events", "/api/search/query", "/api/search/open"];
        if (url.origin !== new URL(app.runtime.url).origin || request.method() !== "GET" && !safe.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        if (url.pathname === "/api/snapshot") reads.push(request.postDataJSON());
        return route.continue();
    });
    page.on("response", response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) {
            // Body decoding may lag the browser's paint; retain this response's identity before awaiting it.
            snapshotRead = { input: response.request().postDataJSON(), body: observeSnapshot(response) };
        }
    });
    const before = await loadBoardState(app.context);
    app.closeClient(async () => {
        await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        const after = await loadBoardState(app.context);
        for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
    });
    await page.goto(app.runtime.url); await ready(page); await page.evaluate(() => document.fonts.ready);
    const choose = async (id, value) => { await selectActivityOption(page, id, value); await ready(page); };
    return { ...app, page, reads, choose, snapshot: () => snapshotRead.body, snapshotInput: () => snapshotRead.input };
}

test("filters have one identity, separate refresh/reset jobs, and no collection administration", { timeout: 30000 }, async t => {
    const { page, choose, reads, runtime } = await setup(t);
    assert.equal(await page.locator("#filterHeading [data-lucide-icon=funnel]").count(), 1);
    assert.equal(await page.locator("#analyzeRefresh #checkActivity").count(), 1);
    assert.equal(await page.locator("#appliedFilters #resetView").count(), 1);
    assert.equal(await page.locator("#resetView").getAttribute("aria-label"), "Reset Analyze");
    assert.equal(await page.locator("#activityDeleteShortcut, #activityCollectionLink, #freshSourceSetup, .fresh-links").count(), 0);
    assert.equal(await page.locator("#analyzePopulation #freshHelp").isVisible(), false);
    assert.equal(await page.locator("#collectionNotice").isVisible(), true, "Paused coverage stays truthful");
    const before = reads.length;
    await page.locator("#promptAuthorFilter-control").click();
    const popup = page.locator(".select-popup:visible");
    assert.equal(await popup.locator(".select-toggle").count(), 3);
    assert.equal(await popup.getByRole("switch").count(), 0);
    await popup.locator('[data-value=unknown]').click();
    assert.equal(reads.length, before);
    await popup.getByRole("button", { name: "Cancel", exact: true }).click();
    await choose("outcomeFilter", ["failure"]);
    assert.match(await page.locator("#filterChips").innerText(), /Outcome/);
    assert.equal(await page.locator("#outcomeFilter-control").getAttribute("data-filter-active"), "true");
    await page.locator("#resetView").click(); await ready(page);
    assert.equal(await page.locator("#outcomeFilter-control").getAttribute("data-filter-active"), null);
    await page.locator("#collectionNoticeAction").click(); await ready(page);
    assert.match(page.url(), /settings.*section=connection/);
    await navigateSettings(page, "privacy");
    assert.equal(await page.locator("#deleteActivity:visible").count(), 1);
    assert.equal(await page.locator("#recollectActivity:visible").count(), 1);
    await page.goto(runtime.url + "#settings?section=data"); await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "deleteActivity");
    await page.goto(runtime.url + "#settings?section=collection"); await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "collectionWindow-control");
});

test("canonical snapshot observation waits for the chosen scope even when Node body decoding lags the rendered view", { timeout: 15000 }, async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const app = await setup(t, {}, undefined, async response => {
        const data = await response.json();
        if (response.request().postDataJSON().filters.workloads?.includes("Discovery")) await gate;
        return data;
    });
    const initial = await app.snapshot();
    const expected = initial.analytics.rows.filter(row => app.cases.schema.callIds.includes(row.toolCallId)).map(row => row.id);
    await app.choose("serviceFilter", "Discovery");
    await app.page.waitForFunction(() => document.querySelector("#serviceFilter").value === "Discovery"
        && document.querySelector("#activityCount").textContent === "1"
        && document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    const observation = app.snapshot();
    release();
    const accepted = await observation;
    assert.deepEqual(app.snapshotInput().filters.workloads, ["Discovery"]);
    assert.equal(await app.page.locator("#periodResult").getAttribute("data-revision"), String(accepted.revision));
    assert.deepEqual(accepted.analytics.rows.map(row => row.id), expected, "Observe the Discovery response, never the earlier all-activity body");
});

test("Reset Analyze remains an icon-only accessible utility beside applied scope", { timeout: 15000 }, async t => {
    const { page, choose } = await setup(t);
    await choose("promptAuthorFilter", ["user"]);
    const reset = page.locator("#appliedFilters #resetView");
    assert.equal(await reset.getAttribute("aria-label"), "Reset Analyze");
    assert.equal(await reset.evaluate(node => node.classList.contains("icon-only")), true);
    assert.equal((await reset.innerText()).trim(), "");
    const box = await reset.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44);
    await reset.focus();
    assert.match(await page.getByRole("tooltip").innerText(), /Reset Analyze.*report selections.*evidence.*preferences/i);
    await page.keyboard.press("Escape");
    await reset.click(); await ready(page);
    assert.equal(await page.locator("#activityCount").textContent(), "15");
});

test("legacy and verified Search Refresh destinations focus the surviving global recovery without reading or replaying", { timeout: 20000 }, async t => {
    const { page, reads, runtime } = await setup(t);
    await page.evaluate(() => sessionStorage.setItem("workiq-evidence.source-check.v1", "pending"));
    await page.reload(); await ready(page);
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented filter failure requiring global recovery" } }), { times: 1 });
    await selectActivityOption(page, "promptAuthorFilter", ["user"]); await ready(page);
    const retry = page.locator("#message [data-stored-refresh-retry]");
    await retry.waitFor({ state: "visible" });
    const message = await page.locator("#message").innerText(), before = reads.length;
    await page.goto(runtime.url + "#settings?setting=collect-now"); await ready(page);
    assert.equal(await retry.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#checkActivity").isVisible(), false);
    assert.equal(await page.locator("#refreshBtn").isVisible(), false);
    assert.equal(await page.locator("#message").innerText(), message);
    assert.equal(await page.locator("#checkActivity:visible, #refreshBtn:visible, #collectionRetry:visible, [data-stored-refresh-retry]:visible").count(), 1);
    assert.equal(reads.length, before, "Same-query Settings navigation cannot refresh away the failure");
    await page.goBack(); await ready(page);
    await page.locator("#wireSearch").fill("Refresh");
    await page.locator(".wire-search-hit").filter({ has: page.locator(".wire-search-title", { hasText: /^Refresh$/ }) }).click();
    await page.waitForURL(/setting=collect-now/); await ready(page);
    assert.equal(await retry.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#message").innerText(), message);
    assert.equal(await page.locator("#checkActivity:visible, #refreshBtn:visible, #collectionRetry:visible, [data-stored-refresh-retry]:visible").count(), 1);
    assert.equal(reads.length, before, "Search navigation cannot dispatch stored/source recovery");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("workiq-evidence.source-check.v1")), "pending");
});

test("settled Outcome and Author each have one removal entry with one dispatch and surviving focus", { timeout: 20000 }, async t => {
    const { page, choose, reads } = await setup(t);
    await choose("promptAuthorFilter", ["user"]);
    await choose("outcomeFilter", ["failure"]);
    for (const [name, inline, trigger] of [["author", "clearPromptAuthorFilter", "promptAuthorFilter-control"], ["outcome", "clearResultFilter", "outcomeFilter-control"]]) {
        const chip = page.getByRole("button", { name: new RegExp(`^Remove ${name} filter:`) });
        assert.equal(await chip.count(), 1);
        assert.equal(await page.locator("#" + inline).isVisible(), false, "No duplicate settled clear control");
        const before = reads.length;
        await chip.focus(); await page.keyboard.press("Enter"); await ready(page);
        assert.equal(reads.length, before + 1);
        assert.equal(await chip.count(), 0);
        assert.equal(await page.evaluate(() => document.activeElement.id), trigger);
    }
    assert.equal(await page.locator("#activityCount").textContent(), "15");
});

test("pending filter cancellation preserves All, fences late replies and does not lose report selection", { timeout: 30000 }, async t => {
    const releases = [];
    t.after(() => releases.forEach(release => release()));
    const { page, choose, reads, snapshot } = await setup(t);
    const expected = (await snapshot()).analytics.rows.map(row => row.id).sort();
    await page.locator(".request-card-open").first().click(); await ready(page);
    await page.locator("#requestReportToggle").click();
    await page.locator("#closeContextSidebar").click(); await ready(page);
    for (const [id, key, name, inline, first, second] of [
        ["promptAuthorFilter", "promptAuthors", "author", "clearPromptAuthorFilter", "user", "agent"],
        ["outcomeFilter", "outcomes", "outcome", "clearResultFilter", "failure", "success"],
    ]) for (const accepted of [false, true]) {
        if (accepted) await choose(id, [first]);
        const chip = page.getByRole("button", { name: new RegExp(`^Remove ${name} filter:`) });
        const priorChip = accepted ? await chip.innerText() : null;
        let enter, release;
        const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
        releases.push(release);
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch();
            enter(route.request().postDataJSON());
            await gate; await route.fulfill({ response });
        }, { times: 1 });
        const requested = accepted ? second : first;
        await selectActivityOption(page, id, [requested]);
        assert.deepEqual((await entered).filters[key], [requested]);
        const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
            && response.request().postDataJSON().filters[key]?.[0] === requested);
        const cancel = accepted ? chip : page.locator("#" + inline);
        if (accepted) {
            assert.equal(await chip.innerText(), priorChip, "The chip still names the accepted scope, not the pending intent");
            assert.equal(await page.locator("#" + inline).isVisible(), false);
        } else {
            assert.equal(await chip.count(), 0, "Accepted All has no applied chip to remove");
            assert.equal(await cancel.getAttribute("aria-label"), `Cancel pending ${name} filter`);
            assert.equal(await cancel.isVisible(), true);
        }
        const before = reads.length;
        const cleared = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
            && !response.request().postDataJSON().filters[key]);
        await cancel.focus(); await page.keyboard.press("Enter");
        const response = await cleared; await ready(page);
        assert.deepEqual((await response.json()).analytics.rows.map(row => row.id).sort(), expected);
        assert.equal(reads.length, before + 1);
        assert.equal(await page.evaluate(() => document.activeElement.id), id + "-control");
        assert.equal(await page.locator("#" + inline).isVisible(), false);
        release(); await (await late).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator("#activityCount").textContent(), "15", "Late superseded scope cannot replace the accepted All population");
        assert.equal(await page.locator("#" + id).evaluate(node => node.selectedOptions.length === node.options.length), true);
        assert.equal(await chip.count(), 0);
    }
    await navigateMain(page, "reports"); await ready(page);
    await page.locator("#reportCreateLink").click(); await ready(page);
    assert.match(await page.locator("#reportPromptAuthorSummary").textContent(), /1 of 1 request groups/);
});

test("removing a disabled Outcome chip keeps its activity layer and focuses the surviving label", { timeout: 15000 }, async t => {
    const { page, choose, reads } = await setup(t);
    await choose("outcomeFilter", ["failure"]);
    await choose("layerFilter", "code-reference");
    assert.equal(await page.locator("#outcomeFilter-control").isDisabled(), true);
    const before = reads.length, chip = page.getByRole("button", { name: /^Remove outcome filter:/ });
    await chip.focus(); await page.keyboard.press("Enter"); await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "resultFilterLabel");
    assert.equal(await page.locator("#outcomeFilter-control").isDisabled(), true);
    assert.equal(await page.locator("#layerFilter").inputValue(), "code-reference");
    assert.equal(reads.length, before + 1);
    assert.equal(reads.at(-1).filters.outcomes, undefined);
    assert.equal(await page.locator("#activityCount").textContent(), "0");
});

test("all filter kinds retain canonical rows, drafts, counts, Back and report membership", { timeout: 60000 }, async t => {
    const app = await setup(t), { page, choose, reads } = app;
    const all = (await app.snapshot()).analytics.rows, observations = [];
    const ids = keys => keys.flatMap(key => app.cases[key].callIds).map(id => all.find(row => row.toolCallId === id).id).sort();
    const check = async (name, keys) => {
        const snapshot = await app.snapshot(), actual = snapshot.analytics.rows.map(row => row.id).sort();
        assert.deepEqual(actual, ids(keys), name);
        assert.equal(snapshot.analytics.totals.count, actual.length);
        assert.equal(Number(await page.locator("#activityCount").textContent()), actual.length);
        assert.equal(await page.locator("#periodResult").getAttribute("data-revision"), String(snapshot.revision));
        observations.push({ name, ids: actual, filters: app.snapshotInput().filters, revision: snapshot.revision });
    };
    // The current product selects report membership in the interaction reader.
    await page.locator(".request-card-open").first().click(); await ready(page);
    await page.locator("#requestReportToggle").click();
    await page.locator("#closeContextSidebar").click(); await ready(page);
    await choose("serviceAssociationFilter", "Files");
    await check("service plus explicit context", ["otherAgent", "multiFiles", "failedFiles", "partialFiles", "missingUser", "missingAgent", "assistance"]);
    await page.getByRole("button", { name: "Remove missing-service context", exact: true }).click(); await ready(page);
    await check("strict service", ["otherAgent", "multiFiles", "failedFiles", "partialFiles"]);
    await choose("serviceFilter", "Mail"); await check("exclusive category AND service", []);
    await choose("serviceFilter", "all");
    await page.locator("#addServiceContext").click(); await ready(page);
    await choose("toolFilter", "workiq-fetch");
    await choose("dateFilter", "custom");
    await page.locator("#fromFilter").fill(app.olderDay); await page.locator("#toFilter").fill(app.olderDay);
    await page.locator("#applyDates").click(); await ready(page);
    await check("inclusive custom day AND tool", ["otherAgent", "multiFiles", "failedFiles", "partialFiles", "missingUser"]);
    for (const id of ["promptAuthorFilter", "outcomeFilter"]) {
        const before = reads.length, trigger = page.locator(`#${id}-control`);
        await trigger.click();
        const popup = page.locator(".select-popup:visible");
        if (id === "outcomeFilter") {
            const labels = await popup.locator(".select-option-count").allTextContents();
            const values = await popup.locator(".select-option").evaluateAll(nodes => nodes.map(node => node.dataset.value));
            const snapshot = await app.snapshot();
            assert.deepEqual(labels, values.map(key => String(snapshot.analytics.resultFacet.totals[key])));
        }
        await popup.getByRole("checkbox").click();
        assert.equal(await popup.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
        await popup.getByRole("button", { name: "Cancel", exact: true }).click();
        await trigger.press("ArrowDown"); await trigger.press(id === "promptAuthorFilter" ? "a" : "t");
        assert.equal(await page.locator(".select-option[data-active=true]").getAttribute("data-value"), id === "promptAuthorFilter" ? "agent" : "failure");
        await trigger.press("Space"); await trigger.press("Escape");
        await trigger.click(); await popup.getByRole("option").first().click(); await page.locator("#filterHeading").click();
        assert.equal(reads.length, before, "Draft, All, Cancel, Escape and outside do not query");
    }
    await choose("promptAuthorFilter", ["user", "agent"]);
    assert.deepEqual(reads.at(-1).filters.promptAuthors, ["user", "agent"]);
    await choose("promptAuthorFilter", ["user"]);
    await choose("outcomeFilter", ["failure"]); await check("AND failed outcome and My prompts", ["missingUser"]);
    await choose("outcomeFilter", ["success", "failure"]); await check("OR within Outcome", ["multiFiles", "partialFiles", "missingUser"]);
    await choose("projectFilter", app.projectId);
    await choose("chatFilter", app.chatId);
    await page.locator("#moreFiltersToggle").click();
    assert.match(await page.locator("#moreFiltersToggle").innerText(), /2 active/);
    assert.match(await page.locator("#filterChips").innerText(), /Invented project A.*Invented author conversation/s);
    await restoreLegacySearch(page, app.cases.missingUser.content);
    assert.equal(await page.locator(".request-row").count(), 1);
    await page.getByRole("button", { name: "Remove private search", exact: true }).click(); await ready(page);
    await page.goBack(); await ready(page);
    assert.equal(await page.locator(".request-row").count(), 1);
    await page.locator("#resetView").click(); await ready(page);
    assert.equal((await app.snapshot()).analytics.totals.count, 15);
    await navigateMain(page, "reports"); await ready(page);
    await page.locator("#reportCreateLink").click(); await ready(page);
    assert.match(await page.locator("#reportPromptAuthorSummary").textContent(), /1 of 1 request groups/);
    await navigateMain(page, "analyze"); await ready(page);
    await choose("scopeFilter", "legacy"); assert.equal((await app.snapshot()).analytics.totals.count, 0);
    await choose("scopeFilter", "all"); assert.equal((await app.snapshot()).analytics.totals.count, 15);
    await choose("scopeFilter", "history");
    await choose("serviceFilter", "Discovery"); await check("Discovery is still preparation", ["schema"]);
    for (const layer of ["reported-api", "direct-request", "recorded-http", "http", "code-reference"]) {
        await choose("layerFilter", layer);
        assert.equal(reads.at(-1).layer, layer);
        assert.equal(reads.at(-1).filters.workloads, undefined);
    }
    assert.equal(await page.locator("#outcomeFilter-control").isDisabled(), true);
    assert.match(await page.locator("#resultFilterScope").innerText(), /execution is not observed/);
    await choose("layerFilter", "tool");
    await choose("promptAuthorFilter", ["unknown"]);
    await check("unverified is selectable, not silently known", ["unverified", "conflicting", "assistance"]);
    await page.getByRole("button", { name: /^Remove author filter:/ }).click(); await ready(page);
    assert.equal((await app.snapshot()).analytics.totals.count, 15);
    if (proofDir) {
        await mkdir(proofDir, { recursive: true });
        await writeFile(path.join(proofDir, "canonical-populations.json"), JSON.stringify(observations, null, 2));
    }
});

test("whole Analyze and Settings context stays readable in light/dark, narrow, text zoom and sidebar states", { timeout: 60000 }, async t => {
    const { page, choose } = await setup(t), observations = [];
    if (proofDir) await mkdir(proofDir, { recursive: true });
    await choose("outcomeFilter", ["success", "failure"]);
    await choose("promptAuthorFilter", ["user", "agent"]);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 1], [1440, 2], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${100 * scale}%`; }, scale);
        await page.evaluate(() => scrollTo(0, 0));
        const geometry = await page.locator("#filters .select-trigger:visible, #resetView, #checkActivity").evaluateAll(nodes => nodes.map(node => {
            const b = node.getBoundingClientRect(), text = node.querySelector(".select-value");
            return { id: node.id, width: b.width, height: b.height, left: b.left, right: b.right, clipped: text ? text.scrollWidth - text.clientWidth : 0 };
        }));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        for (const b of geometry) assert.ok(b.width >= 44 && b.height >= 44 && b.left >= 0 && b.right <= width + 1 && b.clipped <= 1, JSON.stringify(b));
        const name = `${theme}-${width}-${scale}`;
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `analyze-${name}.png`), fullPage: true });
        await page.locator("#promptAuthorFilter-control").click();
        const popup = page.locator(".select-popup:visible"), box = await popup.boundingBox();
        assert.ok(box.x >= 8 && box.x + box.width <= width - 7 && box.y >= 8 && box.y + box.height <= 993);
        assert.equal(await popup.evaluate(node => getComputedStyle(node).animationName), "none");
        const paint = await popup.locator(".select-option").evaluateAll(nodes => nodes.map(node => {
            const background = getComputedStyle(node).backgroundColor === "rgba(0, 0, 0, 0)"
                ? getComputedStyle(node.closest(".select-popup")).backgroundColor : getComputedStyle(node).backgroundColor;
            const toggle = node.querySelector(".select-toggle");
            return { color: getComputedStyle(node.querySelector(".select-option-label")).color, background,
                thumb: getComputedStyle(toggle, "::after").backgroundColor, track: getComputedStyle(toggle).backgroundColor };
        }));
        for (const row of paint) {
            assert.ok(contrast(row.color, row.background) >= 4.5, `${name}: selected text contrast ${JSON.stringify(row)}`);
            assert.ok(contrast(row.thumb, row.track) >= 3, `${name}: selection mark contrast ${JSON.stringify(row)}`);
        }
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `menu-${name}.png`) });
        await page.keyboard.press("Escape");
        assert.equal(await page.evaluate(() => document.activeElement.id), "promptAuthorFilter-control");
        observations.push({ theme, width, scale, geometry, popup: box, paint });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#navigationCollapse").click();
        await page.locator(".request-card-open").first().click(); await ready(page);
        await page.evaluate(() => scrollTo(0, 0));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `sidebar-${theme}.png`) });
        await page.locator("#closeContextSidebar").click(); await ready(page);
        await navigateMain(page, "settings"); await ready(page);
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `settings-connection-${theme}.png`), fullPage: true });
        await page.locator('#settingsCategoryNav [data-category=privacy]').click();
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `settings-privacy-${theme}.png`), fullPage: true });
        await navigateMain(page, "analyze"); await ready(page);
    }
    if (proofDir) await writeFile(path.join(proofDir, "geometry.json"), JSON.stringify(observations, null, 2));
});

test("failed filter reads keep the accepted population and Settings drafts still block Refresh", { timeout: 30000 }, async t => {
    const { page, choose, reads, snapshot } = await setup(t);
    const baseline = (await snapshot()).analytics.rows.map(row => row.id).sort();
    let entered, release;
    const pending = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        entered(); await gate;
        await route.fulfill({ status: 503, json: { error: "Invented filter read failure" } });
    }, { times: 1 });
    await selectActivityOption(page, "promptAuthorFilter", ["user"]); await pending;
    assert.equal(await page.locator("#activityCount").textContent(), "15");
    assert.deepEqual((await snapshot()).analytics.rows.map(row => row.id).sort(), baseline);
    release(); await ready(page);
    assert.match(await page.locator("#message").innerText(), /Invented filter read failure/);
    assert.equal(await page.locator("#activityCount").textContent(), "15");
    assert.deepEqual(await page.locator("#promptAuthorFilter").evaluate(node => [...node.selectedOptions].map(option => option.value)), ["user", "agent", "unknown"]);
    await page.locator("[data-stored-refresh-retry]:visible").click(); await ready(page);
    assert.equal(await page.locator("#message").isVisible(), false);
    assert.deepEqual((await snapshot()).analytics.rows.map(row => row.id).sort(), baseline, "Recovery reads the last accepted scope");
    await choose("promptAuthorFilter", ["user"]);
    assert.ok((await snapshot()).analytics.rows.every(row => row.promptAuthor === "user"));
    await page.locator("#resetView").click(); await ready(page);
    const refreshGeometry = () => page.locator("#checkActivity").evaluate(node => {
        const target = node.getBoundingClientRect(), icon = node.querySelector("svg").getBoundingClientRect();
        const parent = node.parentElement.getBoundingClientRect();
        return { width: target.width, height: target.height, iconWidth: icon.width, iconHeight: icon.height,
            parentWidth: parent.width, parentHeight: parent.height };
    });
    const enabledRefresh = await refreshGeometry();
    await navigateMain(page, "settings"); await ready(page);
    await choose("collectionWindow", "7");
    await navigateMain(page, "analyze"); await ready(page);
    assert.equal(await page.locator("#checkActivity").isDisabled(), true);
    assert.deepEqual(await refreshGeometry(), enabledRefresh, "Disabled-help ownership does not enlarge the Refresh region");
    const wrapper = page.locator("#checkActivity").locator("..");
    await wrapper.focus();
    assert.match(await page.getByRole("tooltip").innerText(), /Save or cancel your Settings edits/);
    await page.keyboard.press("Escape");
    const before = reads.length;
    await page.locator("#promptAuthorFilter-control").click();
    await page.keyboard.press("Escape");
    assert.equal(reads.length, before);
    await navigateMain(page, "settings"); await ready(page);
    await page.locator("#cancelPreferences").click();
    await navigateMain(page, "analyze"); await ready(page);
    assert.equal(await page.locator("#checkActivity").isDisabled(), false);
});

test("joined Search reaches existing Settings targets and sidebar motion persists independently of filters", { timeout: 30000 }, async t => {
    const { page, choose, runtime } = await setup(t);
    const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    await choose("promptAuthorFilter", ["user"]);
    await page.locator("#wireSearch").fill("Sidebar motion");
    const motion = page.locator(".wire-search-hit").filter({ has: page.locator(".wire-search-title", { hasText: /^Sidebar motion$/ }) });
    await motion.click(); await page.waitForURL(/section=display/); await ready(page);
    assert.match(page.url(), /section=display/);
    assert.equal(await page.evaluate(() => document.activeElement.id), "sidebarMotionPreference-control");
    assert.equal(await page.locator("#sidebarMotionPreference").inputValue(), "system");
    await choose("sidebarMotionPreference", "on");
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.sidebar-motion")), "on");
    assert.equal(await page.locator("#saveCollection").isDisabled(), true);
    await page.reload(); await ready(page);
    assert.equal(await page.locator("#sidebarMotionPreference").inputValue(), "on");
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), reduced);
    await choose("sidebarMotionPreference", "off");
    await navigateMain(page, "analyze"); await ready(page);
    assert.equal(await page.locator("#promptAuthorFilter").evaluate(node => node.selectedOptions[0].value), "user");
    await page.locator("#wireSearch").fill("Delete collected activity");
    await page.locator(".wire-search-hit").filter({ has: page.locator(".wire-search-title", { hasText: /^Review deletion$/ }) }).click();
    await page.waitForURL(/setting=delete-activity/); await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "deleteActivity");
    assert.equal(await page.locator("#deleteDialog").evaluate(node => node.open), false, "Search navigates; it does not even open the deletion flow");
    await page.goBack(); await ready(page);
    assert.equal(await page.locator("#promptAuthorFilter").evaluate(node => node.selectedOptions[0].value), "user");
    await page.goto(runtime.url + "#settings?section=connection&setting=collect-now"); await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "checkActivity");
    assert.equal(await page.locator("html").getAttribute("data-sidebar-motion"), "off");
});

async function metadataListSetup(t, options) {
    const records = Array.from({ length: 60 }, (_, index) => {
        const record = fixture("filter-list-" + index), label = String(index).padStart(2, "0");
        record.projectId = "invented-project-" + label;
        record.project = `Project ${label} with a deliberately long invented name for wrapping`;
        record.sourceSessionId = "invented-chat-" + label;
        record.sourceSessionName = `Chat ${label} with a deliberately long invented name for wrapping`;
        record.toolCalls[0].startedAt = record.capturedAt;
        return record;
    });
    const cleanups = [], { context } = await privateFixture({ after: cleanup => cleanups.push(cleanup) }, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw Error("Providers forbidden in filter list proof"); } } });
    let closeClient;
    t.after(async () => { try { await closeClient?.(); } finally { await runtime.close(); for (const cleanup of cleanups) await cleanup(); } });
    return setup(t, options, {
        context, runtime, closeClient: close => { closeClient = close; },
    });
}

test("filter icon layout separates glyphs, text lines and interactive targets", { timeout: 30000 }, async t => {
    const releases = [];
    t.after(() => releases.forEach(release => release()));
    const { page, choose, reads, snapshot } = await metadataListSetup(t, { hasTouch: true }), observations = [];
    if (geometryDir) await mkdir(geometryDir, { recursive: true });
    await choose("outcomeFilter", ["success", "failure"]);
    await choose("promptAuthorFilter", ["unknown"]);
    await choose("projectFilter", "invented-project-59");
    async function measure() {
        return page.evaluate(() => {
            const box = node => {
                if (!node || !node.checkVisibility()) return null;
                const b = node.getBoundingClientRect();
                return { x: b.x, y: b.y, documentY: b.y + scrollY, width: b.width, height: b.height, right: b.right, bottom: b.bottom };
            };
            const textBox = node => {
                const range = document.createRange(); range.selectNodeContents(node);
                const b = range.getBoundingClientRect();
                return { x: b.x, y: b.y, documentY: b.y + scrollY, width: b.width, height: b.height, right: b.right, bottom: b.bottom };
            };
            const glyph = svg => {
                if (!svg?.checkVisibility()) return null;
                const b = svg.getBBox(), matrix = svg.getScreenCTM();
                const a = new DOMPoint(b.x, b.y).matrixTransform(matrix), z = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(matrix);
                const stroke = parseFloat(getComputedStyle(svg).strokeWidth) / 2;
                const edge = new DOMPoint(b.x - stroke, b.y - stroke).matrixTransform(matrix);
                const end = new DOMPoint(b.x + b.width + stroke, b.y + b.height + stroke).matrixTransform(matrix);
                return { display: box(svg), path: { x: a.x, y: a.y, width: z.x - a.x, height: z.y - a.y },
                    strokeEnvelope: { x: edge.x, y: edge.y, width: end.x - edge.x, height: end.y - edge.y } };
            };
            return {
                overflow: document.documentElement.scrollWidth - innerWidth,
                fields: [...document.querySelectorAll("#filters .filter-field,#filters .result-filter-field")].map(field => {
                    const label = field.querySelector("label"), heading = field.querySelector(".help-heading");
                    const help = field.querySelector(".ux-help"), trigger = field.querySelector(".select-trigger");
                    const clear = field.querySelector(".filter-clear"), css = getComputedStyle(heading), fieldCss = getComputedStyle(field);
                    return { id: trigger.dataset.selectId, field: box(field), label: textBox(label), labelLine: box(label), heading: box(heading),
                        help: box(help), helpGlyph: glyph(help.querySelector("svg")), trigger: box(trigger),
                        value: textBox(trigger.querySelector(".select-value")), valueOverflow: trigger.querySelector(".select-value").scrollWidth - trigger.querySelector(".select-value").clientWidth,
                        clear: box(clear), clearGlyph: glyph(clear?.querySelector("svg")),
                        lineHeight: css.lineHeight, minHeight: css.minHeight, padding: css.padding, margin: css.margin,
                        rowGap: fieldCss.rowGap, columns: fieldCss.gridTemplateColumns };
                }),
                utilities: ["resetView", "checkActivity"].map(id => {
                    const node = document.getElementById(id);
                    return { id, target: box(node), glyph: glyph(node.querySelector("svg")), parent: box(node.parentElement),
                        padding: getComputedStyle(node).padding, margin: getComputedStyle(node).margin };
                }),
            };
        });
    }
    const stable = model => model.fields.map(field => [field.id, ...["field", "labelLine", "help", "trigger", "clear"]
        .map(key => field[key] && [field[key].x, field[key].documentY, field[key].width, field[key].height])]);
    const overlaps = (a, b) => a && b && Math.min(a.right, b.right) - Math.max(a.x, b.x) > .5
        && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > .5;
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [1200, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; scrollTo(0, 0); }, scale);
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const normal = await measure(), variants = {};
        if (theme === "light" && width === 1440) {
            const field = page.locator(".filter-field").filter({ has: page.locator("#dateFilter") });
            for (const [name, hideHelp, collapseReserve] of [["help-out-of-flow", true, false], ["reserve-only", false, true], ["both", true, true]]) {
                await field.evaluate((node, { hideHelp, collapseReserve }) => {
                    node.querySelector(".ux-help").style.display = hideHelp ? "none" : "";
                    node.querySelector(".help-heading").style.minHeight = collapseReserve ? "0" : "";
                }, { hideHelp, collapseReserve });
                variants[name] = (await measure()).fields.find(item => item.id === "dateFilter");
            }
            await field.evaluate(node => {
                node.querySelector(".ux-help").style.removeProperty("display");
                node.querySelector(".help-heading").style.removeProperty("min-height");
            });
        }
        const observation = { theme, width, scale, normal, variants };
        observations.push(observation);
        if (geometryDir) await page.screenshot({ path: path.join(geometryDir, `filters-${theme}-${width}-${scale}.png`), fullPage: true });
        assert.ok(normal.overflow <= 1);
        for (const utility of normal.utilities) {
            assert.equal(utility.target.width, 44, utility.id);
            assert.equal(utility.target.height, 44, utility.id);
            assert.equal(utility.glyph.display.width, 20, utility.id);
            assert.equal(utility.glyph.display.height, 20, utility.id);
        }
        for (const field of normal.fields) {
            assert.ok(field.help.width >= 44 && field.help.height >= 44, field.id);
            assert.ok(field.trigger.height >= 44, field.id);
            assert.ok(field.valueOverflow <= 1, `${field.id}: reserved utilities cannot squeeze text outside the trigger`);
            if (field.clear) assert.ok(field.clear.width >= 44 && field.clear.height >= 44, field.id);
            assert.ok(Math.abs(field.trigger.y - field.labelLine.bottom - parseFloat(field.rowGap)) < 1,
                `${field.id}: utility targets must not add height between the label line and value control`);
            for (const [a, b] of [["labelLine", "help"], ["labelLine", "clear"], ["trigger", "help"], ["trigger", "clear"], ["help", "clear"]]) {
                assert.equal(Boolean(overlaps(field[a], field[b])), false, `${field.id}: ${a}/${b} may not share a hit region`);
            }
            const adjacent = field.clear || field.help;
            assert.ok(Math.abs(adjacent.x - field.trigger.right - parseFloat(field.rowGap)) < 1, `${field.id}: no phantom utility-width gap after the control`);
            assert.ok(Math.abs(field.help.right - field.field.right) < 1, `${field.id}: the utility region ends at its field, not in another action`);
        }
        assert.ok(normal.fields.find(field => field.id === "projectFilter").value.height > 30 * scale, "Real long project values wrap instead of clipping");
        const help = page.locator(".filter-field").filter({ has: page.locator("#dateFilter") }).locator(".ux-help");
        const before = reads.length;
        await help.hover();
        observation.hover = await measure();
        assert.deepEqual(stable(observation.hover), stable(normal), "Hover does not change field layout");
        await help.focus(); await help.press("Tab"); await page.keyboard.press("Shift+Tab");
        observation.focus = await measure();
        assert.deepEqual(stable(observation.focus), stable(normal), "Keyboard focus does not change field layout");
        assert.equal(await help.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle !== "none"), true);
        await page.keyboard.press("Escape");
        await help.tap(); await page.getByRole("tooltip").waitFor({ state: "visible" }); await page.keyboard.press("Escape");
        assert.equal(reads.length, before, "Help targets cannot activate a nearby value or query");

        await page.locator("#outcomeFilter-control").click();
        const popup = page.locator(".select-popup:visible"), popupBox = await popup.boundingBox();
        assert.ok(popupBox.x >= 8 && popupBox.x + popupBox.width <= width - 7 && popupBox.y >= 8 && popupBox.y + popupBox.height <= 993);
        observation.menu = await popup.locator(".select-option").evaluateAll(nodes => nodes.map(node => {
            const label = node.querySelector(".select-option-label"), marker = node.querySelector(".select-toggle");
            const height = node.getBoundingClientRect().height, markerHeight = marker.getBoundingClientRect().height;
            marker.style.display = "none";
            const withoutMarker = node.getBoundingClientRect().height;
            marker.style.removeProperty("display");
            return { height, withoutMarker, markerHeight, lineHeight: parseFloat(getComputedStyle(label).lineHeight),
                role: node.getAttribute("role"), markerHidden: marker.getAttribute("aria-hidden") };
        }));
        for (const row of observation.menu) {
            assert.equal(row.height, row.withoutMarker, "Decorative selection marks do not inflate option rows");
            assert.ok(row.height >= 44 && row.markerHeight <= row.lineHeight);
            assert.equal(row.role, "option"); assert.equal(row.markerHidden, "true");
        }
        if (geometryDir) await page.screenshot({ path: path.join(geometryDir, `menu-${theme}-${width}-${scale}.png`) });
        await page.keyboard.press("Escape");
        assert.equal(await page.evaluate(() => document.activeElement.id), "outcomeFilter-control");
        assert.equal(reads.length, before);
        const clear = page.getByRole("button", { name: /^Remove outcome filter:/ });
        await clear.focus(); await clear.press("Tab"); await page.keyboard.press("Shift+Tab");
        assert.equal(await clear.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle !== "none"), true);
        assert.deepEqual(stable(await measure()), stable(normal));
        await page.keyboard.press("Escape");
        await clear.tap(); await ready(page);
        assert.equal(reads.length, before + 1, "Settled chip removal applies exactly once");
        await choose("outcomeFilter", ["success", "failure"]);
        await page.getByRole("button", { name: /^Remove author filter:/ }).tap(); await ready(page);
        const expectedIds = (await snapshot()).analytics.rows.map(row => row.id).sort();
        const beforePending = (await measure()).fields.find(field => field.id === "promptAuthorFilter");
        let enter, release;
        const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
        releases.push(release);
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch(); enter();
            await gate; await route.fulfill({ response });
        }, { times: 1 });
        await selectActivityOption(page, "promptAuthorFilter", ["user"]); await entered;
        const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
            && response.request().postDataJSON().filters.promptAuthors?.[0] === "user");
        observation.pending = await measure();
        const pendingAuthor = observation.pending.fields.find(field => field.id === "promptAuthorFilter");
        assert.ok(pendingAuthor.clear.width >= 44 && pendingAuthor.clear.height >= 44);
        assert.equal(pendingAuthor.valueOverflow, 0);
        assert.equal(pendingAuthor.field.height, beforePending.field.height, "The unique pending action does not inflate the field");
        assert.ok(Math.abs(pendingAuthor.trigger.documentY - beforePending.trigger.documentY) < 1);
        assert.equal(Boolean(overlaps(pendingAuthor.clear, pendingAuthor.help) || overlaps(pendingAuthor.clear, pendingAuthor.trigger)
            || overlaps(pendingAuthor.clear, pendingAuthor.labelLine)), false);
        assert.equal(pendingAuthor.clear.x - pendingAuthor.trigger.right, 4);
        assert.equal(pendingAuthor.help.x - pendingAuthor.clear.right, 4);
        const cancel = page.getByRole("button", { name: "Cancel pending author filter", exact: true }), pendingReads = reads.length;
        const cancelled = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
            && !response.request().postDataJSON().filters.promptAuthors);
        if (geometryDir) await page.screenshot({ path: path.join(geometryDir, `pending-${theme}-${width}-${scale}.png`) });
        await cancel.focus(); await page.keyboard.press("Enter");
        const accepted = await cancelled; await ready(page);
        assert.deepEqual((await accepted.json()).analytics.rows.map(row => row.id).sort(), expectedIds);
        assert.equal(reads.length, pendingReads + 1);
        assert.equal(await page.evaluate(() => document.activeElement.id), "promptAuthorFilter-control");
        release(); await (await late).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator("#activityCount").textContent(), "1");
        await choose("promptAuthorFilter", ["unknown"]);
    }
    await choose("layerFilter", "code-reference");
    assert.equal(await page.locator("#outcomeFilter-control").isDisabled(), true);
    const disabled = await measure(), beforeDisabled = reads.length;
    await page.locator("#outcomeFilter-control").evaluate(node => node.click());
    assert.equal(reads.length, beforeDisabled);
    assert.equal(await page.locator(".select-popup:visible").count(), 0);
    for (const field of disabled.fields) assert.ok(Math.abs(field.trigger.y - field.labelLine.bottom - parseFloat(field.rowGap)) < 1);
    if (geometryDir) await writeFile(path.join(geometryDir, "disabled-layout.json"), JSON.stringify(disabled, null, 2));
    if (geometryDir) await writeFile(path.join(geometryDir, "icon-layout.json"), JSON.stringify(observations, null, 2));
    t.diagnostic(JSON.stringify(observations.map(item => ({
        theme: item.theme, width: item.width, scale: item.scale,
        fields: item.normal.fields.length,
        inkGap: [...new Set(item.normal.fields.map(field => field.trigger.y - field.label.bottom))],
        minimumHelpTarget: Math.min(...item.normal.fields.map(field => Math.min(field.help.width, field.help.height))),
        pendingCancelTarget: item.pending.fields.find(field => field.id === "promptAuthorFilter").clear,
    }))));
});

test("primary width budgets match actual single-choice and pending multi-choice requirements", { timeout: 30000 }, async t => {
    const releases = [];
    t.after(() => releases.forEach(release => release()));
    const { page, choose } = await setup(t), observations = [];
    async function measure(name) {
        const result = await page.locator(".filter-scroll").evaluate(root => {
            const box = node => {
                const b = node.getBoundingClientRect();
                return { x: b.x, y: b.y + scrollY, width: b.width, height: b.height, right: b.right };
            };
            const unwrappedWidth = node => {
                const clone = node.cloneNode(true);
                clone.style.cssText = `position:fixed;visibility:hidden;white-space:nowrap;width:max-content;max-width:none;font:${getComputedStyle(node).font}`;
                for (const child of clone.querySelectorAll("*")) child.style.whiteSpace = "nowrap";
                node.parentElement.append(clone);
                const width = clone.getBoundingClientRect().width;
                clone.remove();
                return width;
            };
            return { region: box(root), fields: [...root.querySelectorAll(".select-trigger")].map(trigger => {
                const field = trigger.closest(".filter-field,.result-filter-field"), help = field.querySelector(".ux-help");
                const label = field.querySelector("label"), value = trigger.querySelector(".select-value"), css = getComputedStyle(trigger);
                const cancel = field.querySelector(".filter-clear:not([hidden])"), gap = parseFloat(getComputedStyle(field).columnGap);
                const requiredControl = Math.max(44, unwrappedWidth(value) + trigger.querySelector(".select-chevron").getBoundingClientRect().width
                    + parseFloat(css.columnGap) + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight));
                return { id: trigger.dataset.selectId, value: value.textContent, field: box(field), trigger: box(trigger), help: box(help), cancel: cancel ? box(cancel) : null,
                    requiredControl, requiredField: Math.max(unwrappedWidth(label) + 2 * parseFloat(css.paddingLeft), requiredControl + (cancel ? 44 + gap : 0)) + help.getBoundingClientRect().width + gap,
                    clipped: value.scrollWidth - value.clientWidth };
            }) };
        });
        observations.push({ name, ...result });
        if (geometryDir) {
            await mkdir(geometryDir, { recursive: true });
            await page.screenshot({ path: path.join(geometryDir, `width-${name}.png`), fullPage: true });
        }
        return result;
    }
    const normal = await measure("all");
    await choose("dateFilter", "30");
    await choose("toolFilter", "workiq-get_schema");
    await choose("serviceAssociationFilter", "Calendar");
    await choose("outcomeFilter", ["failure"]);
    await choose("promptAuthorFilter", ["unknown"]);
    await measure("real-long-choices");
    await page.locator("#resetView").click(); await ready(page);
    for (const [id, value] of [["outcomeFilter", "failure"], ["promptAuthorFilter", "user"]]) {
        let enter, release;
        const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
        releases.push(release);
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch(); enter();
            await gate; await route.fulfill({ response });
        }, { times: 1 });
        await selectActivityOption(page, id, [value]); await entered;
        await measure(id + "-first-pending");
        release(); await ready(page);
        await page.locator("#resetView").click(); await ready(page);
    }
    if (geometryDir) {
        await mkdir(geometryDir, { recursive: true });
        await writeFile(path.join(geometryDir, "field-width-budgets.json"), JSON.stringify(observations, null, 2));
    }
    t.diagnostic(JSON.stringify(observations.map(item => ({ state: item.name, available: item.region.width,
        rows: new Set(item.fields.map(field => field.trigger.y)).size,
        fieldWidths: item.fields.map(field => field.field.width),
        requiredWidths: item.fields.map(field => field.requiredField) }))));
    assert.equal(new Set(normal.fields.map(field => field.trigger.y)).size, 1, "The actual normal 1440px requirements fit without an orphan Author row");
    for (const item of observations) for (const field of item.fields) {
        assert.ok(field.clipped <= 1, `${item.name}/${field.id}`);
        assert.ok(field.trigger.width >= field.requiredControl, `${item.name}/${field.id}: the real caption fits its value budget`);
        if (item.name.endsWith("-first-pending")) {
            const initial = normal.fields.find(value => value.id === field.id);
            assert.deepEqual(field.field, initial.field, `${field.id}: first-pending cancellation does not move or resize the field`);
            assert.equal(field.trigger.x, initial.trigger.x);
            assert.equal(field.trigger.y, initial.trigger.y);
        }
    }
});

test("real long metadata lists retain typeahead, keyboard scrolling, touch targets and no scroll trap", { timeout: 30000 }, async t => {
    const { page, reads } = await metadataListSetup(t, { viewport: { width: 375, height: 1000 }, hasTouch: true });
    await page.locator("#moreFiltersToggle").tap();
    assert.equal(await page.locator("#projectFilter option").count(), 61);
    for (const scale of [1, 2]) {
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        const trigger = page.locator("#projectFilter-control"), before = reads.length;
        await trigger.tap(); await trigger.press("End");
        assert.equal(await page.locator(".select-option[data-active=true]").getAttribute("data-value"), "invented-project-59");
        const geometry = await page.locator(".select-popup:visible").evaluate(node => {
            const b = node.getBoundingClientRect(), active = node.querySelector("[data-active=true]").getBoundingClientRect();
            return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, scrollTop: node.scrollTop,
                activeTop: active.top, activeBottom: active.bottom, activeHeight: active.height };
        });
        assert.ok(geometry.left >= 8 && geometry.right <= 367 && geometry.top >= 8 && geometry.bottom <= 992);
        assert.ok(geometry.scrollTop > 0 && geometry.activeTop >= geometry.top && geometry.activeBottom <= geometry.bottom && geometry.activeHeight >= 44);
        await trigger.press("Home");
        await trigger.pressSequentially("Project 42");
        assert.equal(await page.locator(".select-option[data-active=true]").getAttribute("data-value"), "invented-project-42");
        await trigger.press("Escape");
        assert.equal(reads.length, before);
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
        await trigger.tap(); await trigger.press("End"); await trigger.press("Enter"); await ready(page);
        assert.equal(await page.locator("#projectFilter").inputValue(), "invented-project-59");
        assert.equal(await page.locator("#activityCount").textContent(), "1");
        await page.getByRole("button", { name: /^Remove copilot project filter:/ }).tap(); await ready(page);
        assert.equal(await page.locator("#activityCount").textContent(), "60");
        await page.locator("#chatFilter-control").tap(); await page.keyboard.press("Tab");
        assert.equal(await page.locator(".select-popup:visible").count(), 0);
        assert.equal(await page.locator("#chatFilter").inputValue(), "all");
        if (proofDir) {
            await page.locator("#projectFilter-control").tap(); await page.keyboard.press("End");
            await page.screenshot({ path: path.join(proofDir, `long-list-375-${scale}.png`) });
            await page.keyboard.press("Escape");
        }
    }
});
