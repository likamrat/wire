import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { chooseTheme, navigateMain, navigateSettings, openAnalyzeFilters, closeAnalyzeFilters, selectActivityOption, fixture, privateFixture } from "../support/helpers.mjs";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { contrast } from "../support/color-measurements.mjs";

const proofDir = process.env.WIRE_FILTER_EXPERIENCE_PROOFS;
const ready = page => page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
async function setup(t, options = {}, source) {
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
            snapshotRead = response.json();
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
    return { ...app, page, reads, choose, snapshot: () => snapshotRead };
}

test("filters have one identity, separate refresh/reset jobs, and no collection administration", { timeout: 30000 }, async t => {
    const { page, choose, reads, runtime } = await setup(t);
    assert.equal(await page.locator("#filterHeading [data-lucide-icon=funnel]").count(), 1);
    assert.equal(await page.locator("#activityUpdateSlot,#activityUpdateToggle").count(), 0);
    assert.equal(await page.locator("#appliedFilters #resetView").count(), 1);
    assert.equal(await page.locator("#activityDeleteShortcut, #activityCollectionLink, #freshSourceSetup, .fresh-links").count(), 0);
    assert.equal(await page.locator("#analyzePopulation #freshHelp").isVisible(), false);
    assert.equal(await page.locator("#collectionNotice").isVisible(), false, "Normal pause stays in Settings, not a replacement sidebar-status banner");
    const before = reads.length;
    await openAnalyzeFilters(page);
    await page.locator("#promptAuthorFilter-control").click();
    const popup = page.locator(".select-popup:visible");
    assert.equal(await popup.locator(".select-option .select-toggle").count(), 3);
    assert.equal(await popup.getByRole("switch").count(), 0);
    await popup.locator('[data-value=unknown]').click();
    assert.equal(reads.length, before);
    await popup.getByRole("button", { name: "Cancel", exact: true }).click();
    await choose("outcomeFilter", ["failure"]);
    await expect(page.locator("#resetView")).toHaveAccessibleName("Reset filters");
    await expect(page.locator("#resetView")).toHaveAccessibleDescription("Clear filters and Search. Report choices and saved activity stay unchanged.");
    const resetBox = await page.locator("#resetView").boundingBox();
    assert.ok(resetBox.width >= 44 && resetBox.height >= 44);
    assert.match(await page.locator("#filterChips").innerText(), /Outcome/);
    assert.equal(await page.locator("#outcomeFilter-control").getAttribute("data-filter-active"), "true");
    await page.locator("#resetView").click(); await ready(page);
    assert.equal(await page.locator("#outcomeFilter-control").getAttribute("data-filter-active"), null);
    await navigateMain(page, "settings"); await navigateSettings(page, "connection"); await ready(page);
    assert.match(page.url(), /settings.*section=connection/);
    await navigateSettings(page, "privacy");
    assert.equal(await page.locator("#deleteActivity:visible").count(), 1);
    assert.equal(await page.locator("#recollectActivity:visible").count(), 1);
    await page.goto(runtime.url + "#settings?section=data"); await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "deleteActivity");
    await page.goto(runtime.url + "#settings?section=collection"); await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "collectionWindow-control");
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
    const { page, choose, reads, snapshot, cases } = await setup(t);
    const expected = (await snapshot()).analytics.rows.map(row => row.id).sort();
    await navigateMain(page, "reports"); await ready(page);
    const activity = page.locator("#reportDeskActivity"), picker = page.getByRole("dialog", { name: "Choose activity" });
    await activity.click();
    await picker.getByRole("radio", { name: /^Selected interactions/ }).check();
    await picker.getByRole("searchbox").fill(cases.ownMail.content);
    const member = picker.locator(`input[data-report-request="${cases.ownMail.scenarioId}"]`);
    await member.check();
    await picker.getByRole("button", { name: "Use activity", exact: true }).click();
    await navigateMain(page, "analyze"); await ready(page);
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
    await activity.click();
    await expect(picker.getByRole("radio", { name: /^Selected interactions.*1 chat 1 interaction$/ })).toBeChecked();
    await picker.getByRole("searchbox").fill(cases.ownMail.content);
    await expect(member).toBeChecked();
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

test("outcome option counts follow the accepted layer; unknown authors remain selectable", async t => {
    const { page, choose, snapshot, reads, cases } = await setup(t);
    const all = (await snapshot()).analytics.rows;
    await choose("scopeFilter", "legacy"); await expect(page.locator("#activityCount")).toHaveText("0");
    await choose("scopeFilter", "all"); await expect(page.locator("#activityCount")).toHaveText("15");
    await choose("scopeFilter", "history");
    await choose("serviceFilter", "Discovery");
    const discovery = await snapshot();
    assert.deepEqual(discovery.analytics.rows.map(r => r.toolCallId), cases.schema.callIds);
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator("#periodResult")).toHaveAttribute("data-revision", String(discovery.revision));
    for (const layer of ["reported-api", "direct-request", "recorded-http", "http", "code-reference"]) {
        await choose("layerFilter", layer);
        assert.equal((await snapshot()).analytics.layer, layer);
        assert.equal(reads.at(-1).filters.workloads, undefined);
    }
    await expect(page.locator("#outcomeFilter-control")).toBeDisabled();
    await choose("layerFilter", "tool");
    await choose("promptAuthorFilter", ["unknown"]);
    const expected = [cases.unverified, cases.conflicting, cases.assistance].flatMap(c => c.callIds).sort();
    assert.deepEqual((await snapshot()).analytics.rows.map(r => r.toolCallId).sort(), expected);
    await page.locator("#outcomeFilter-control").click();
    for (const option of await page.locator(".select-popup:visible [role=option]").all()) {
        const outcome = await option.getAttribute("data-value");
        const count = all.filter(row => expected.includes(row.toolCallId) && row.outcome === outcome).length;
        await expect(option.locator(".select-option-count")).toHaveText(String(count));
    }
    await page.keyboard.press("Escape");
});

test("whole Analyze and Settings context stays readable in light/dark, narrow, text zoom and sidebar states", { timeout: 60000 }, async t => {
    const { page, choose } = await setup(t), observations = [];
    if (proofDir) await mkdir(proofDir, { recursive: true });
    await choose("outcomeFilter", ["success", "failure"]);
    await choose("promptAuthorFilter", ["user", "agent"]);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 1], [1440, 2], [375, 2]]) {
        await closeAnalyzeFilters(page); await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${100 * scale}%`; }, scale);
        await openAnalyzeFilters(page);
        await page.waitForFunction(() => !document.querySelector("#analyzeFilterDialog").getAnimations().length);
        const geometry = await page.locator("#filters .select-trigger:visible, #dateFilter-control, #resetView").evaluateAll(nodes => nodes.map(node => {
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
    await closeAnalyzeFilters(page); await page.setViewportSize({ width: 1440, height: 1000 });
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
        await expect(page.locator("#settingsView")).toBeVisible();
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `settings-connection-${theme}.png`), fullPage: true });
        await page.locator('#settingsCategoryNav [data-category=privacy]').click();
        await expect(page.locator("#deleteActivity")).toBeVisible();
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
    await closeAnalyzeFilters(page);
    const refresh = page.locator("#analyzeRefresh");
    const refreshGeometry = () => refresh.evaluate(node => {
        const target = node.getBoundingClientRect(), icon = node.querySelector("svg").getBoundingClientRect();
        return { width: target.width, height: target.height, iconWidth: icon.width, iconHeight: icon.height };
    });
    const enabledRefresh = await refreshGeometry();
    await navigateMain(page, "settings"); await ready(page);
    await choose("collectionWindow", "7");
    await navigateMain(page, "analyze"); await ready(page);
    await expect(refresh).toBeDisabled();
    assert.deepEqual(await refreshGeometry(), enabledRefresh, "Disabled-help ownership does not enlarge the Refresh region");
    const wrapper = refresh.locator("..");
    await wrapper.focus();
    assert.match(await page.getByRole("tooltip").innerText(), /Save or cancel your Settings edits/);
    await page.keyboard.press("Escape");
    const before = reads.length;
    await openAnalyzeFilters(page);
    await page.locator("#promptAuthorFilter-control").click();
    await page.keyboard.press("Escape");
    assert.equal(reads.length, before);
    await navigateMain(page, "settings"); await ready(page);
    await page.locator("#cancelSource").click();
    await navigateMain(page, "analyze"); await ready(page);
    await expect(refresh).toBeEnabled();
});

test("joined Search reaches current Display settings independently of filters", { timeout: 30000 }, async t => {
    const { page, choose, runtime } = await setup(t);
    const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    await choose("promptAuthorFilter", ["user"]);
    await page.locator("#wireSearch").fill("Time zone");
    const setting = page.locator(".wire-search-hit").filter({ has: page.locator(".wire-search-title", { hasText: /^Time zone$/ }) });
    await setting.click(); await page.waitForURL(/section=regional/); await ready(page);
    assert.match(page.url(), /section=regional/);
    assert.equal(await page.evaluate(() => document.activeElement.id), "displayTimeZone-control");
    await choose("displayTimeZone", "UTC");
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.time-zone")), "UTC");
    assert.equal(await page.locator("#sourceCommit").isVisible(), false, "A browser display setting is not a collection change");
    await page.reload(); await ready(page);
    assert.equal(await page.locator("#displayTimeZone").inputValue(), "UTC");
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), reduced);
    await navigateMain(page, "analyze"); await ready(page);
    await expect(page.locator("#promptAuthorFilter")).toHaveValues(["user", "agent", "unknown"]);
    await choose("promptAuthorFilter", ["user"]);
    await closeAnalyzeFilters(page);
    await page.locator("#wireSearch").fill("Delete collected activity");
    await page.locator(".wire-search-hit").filter({ has: page.locator(".wire-search-title", { hasText: /^Review deletion$/ }) }).click();
    await page.waitForURL(/setting=delete-activity/); await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "deleteActivity");
    assert.equal(await page.locator("#deleteDialog").evaluate(node => node.open), false, "Search navigates; it does not even open the deletion flow");
    await page.goBack(); await ready(page);
    await expect(page.locator("#promptAuthorFilter")).toHaveValues(["user"]);
    await page.goto(runtime.url + "#settings?section=connection&setting=collect-now"); await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "checkActivity");
    assert.equal(await page.locator("#sidebarMotionPreference").count(), 0);
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

test("a pending author cancellation has its own target without clipping the selected label", { timeout: 30000 }, async t => {
    const { page, choose } = await metadataListSetup(t, { hasTouch: true });
    await choose("projectFilter", "invented-project-59");
    for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await closeAnalyzeFilters(page); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, 100 * scale);
        await openAnalyzeFilters(page);
        await page.waitForFunction(() => !document.querySelector("#analyzeFilterDialog").getAnimations().length);
        const trigger = page.locator("#promptAuthorFilter-control");
        await trigger.scrollIntoViewIfNeeded();
        const geometry = () => trigger.evaluate(node => {
            const box = el => {
                const { x, y, width, height, right, bottom } = el.getBoundingClientRect();
                return { x, y, width, height, right, bottom };
            };
            const field = node.closest(".result-filter-field"), label = field.querySelector("label");
            return { field: box(field), label: box(label), button: box(node),
                clipped: node.querySelector(".select-value").scrollWidth - node.querySelector(".select-value").clientWidth };
        });
        const before = await geometry(), entered = Promise.withResolvers(), release = Promise.withResolvers(), done = Promise.withResolvers();
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch(); entered.resolve(); await release.promise;
            try { await route.fulfill({ response }); } finally { done.resolve(); }
        }, { times: 1 });
        try {
            await selectActivityOption(page, "promptAuthorFilter", ["user"]); await entered.promise;
            const cancel = page.getByRole("button", { name: "Cancel pending author filter", exact: true });
            await expect(cancel).toBeVisible();
            const pending = await geometry(), box = await cancel.boundingBox();
            assert.deepEqual(pending.field, before.field);
            assert.equal(pending.button.y, before.button.y); assert.equal(pending.button.x, before.button.x);
            assert.ok(box.width >= 44 && box.height >= 44 && box.x >= pending.button.right && box.x + box.width <= pending.field.right + 1);
            assert.ok(pending.button.height >= 44 && pending.clipped <= 1 && box.y >= pending.label.bottom - 1);
            await cancel.tap(); await ready(page); await expect(trigger).toBeFocused();
        } finally { release.resolve(); }
        await done.promise;
        await expect(page.locator("#activityCount")).toHaveText("1");
        await expect(page.locator("#projectFilter")).toHaveValue("invented-project-59");
        await expect(page.locator("#promptAuthorFilter")).toHaveValues(["user", "agent", "unknown"]);
    }
});

test("real long metadata lists retain typeahead, keyboard scrolling, touch targets and no scroll trap", { timeout: 30000 }, async t => {
    const { page, reads } = await metadataListSetup(t, { viewport: { width: 375, height: 1000 }, hasTouch: true });
    await openAnalyzeFilters(page);
    await page.locator("#moreFiltersToggle").tap();
    assert.equal(await page.locator("#projectFilter option").count(), 61);
    for (const scale of [1, 2]) {
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        const trigger = page.locator("#projectFilter-control"), before = reads.length;
        await trigger.tap(); await trigger.press("End");
        assert.equal(await page.locator(".select-option[data-active=true]").getAttribute("data-value"), "invented-project-59");
        const geometry = await page.locator(".select-popup:visible").evaluate(node => {
            const list = node.querySelector("[role=listbox]"), b = list.getBoundingClientRect(), active = list.querySelector("[data-active=true]").getBoundingClientRect();
            return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, scrollTop: list.scrollTop,
                activeTop: active.top, activeBottom: active.bottom, activeHeight: active.height };
        });
        assert.ok(geometry.left >= 8 && geometry.right <= 367 && geometry.top >= 8 && geometry.bottom <= 992);
        assert.ok(geometry.scrollTop > 0 && geometry.activeTop >= geometry.top - 1 && geometry.activeBottom <= geometry.bottom + 1 && geometry.activeHeight >= 44, JSON.stringify(geometry));
        await trigger.press("Home");
        await trigger.pressSequentially("Project 42");
        assert.equal(await page.locator(".select-option[data-active=true]").getAttribute("data-value"), "invented-project-42");
        await trigger.press("Escape");
        assert.equal(reads.length, before);
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
        await trigger.tap(); await trigger.press("End"); await trigger.press("Enter"); await ready(page);
        assert.equal(await page.locator("#projectFilter").inputValue(), "invented-project-59");
        assert.equal(await page.locator("#activityCount").textContent(), "1");
        await page.getByRole("button", { name: /^Remove project filter:/ }).tap(); await ready(page);
        assert.equal(await page.locator("#activityCount").textContent(), "60");
        await page.locator("#chatFilter-control").tap(); await page.keyboard.press("Tab");
        await expect(page.getByRole("combobox", { name: "Find a chat" })).toBeFocused();
        await page.keyboard.press("Tab");
        assert.equal(await page.locator(".select-popup:visible").count(), 0);
        assert.equal(await page.locator("#chatFilter").inputValue(), "all");
        if (proofDir) {
            await page.locator("#projectFilter-control").tap(); await page.keyboard.press("End");
            await page.screenshot({ path: path.join(proofDir, `long-list-375-${scale}.png`) });
            await page.keyboard.press("Escape");
        }
    }
});
