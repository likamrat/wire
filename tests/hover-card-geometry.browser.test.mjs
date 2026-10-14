import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain } from "./helpers.mjs";

const proofs = process.env.WIRE_HOVER_CARD_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");

function records() {
    return ["Files", "Calendar", "Mail", "Files", "Files"].map((service, index) => {
        const record = fixture(`polish-${index}`);
        const target = { Files: "/me/drive/root/children", Calendar: "/me/events", Mail: "/me/messages" }[service];
        record.sourceSessionName = "Sample: Lantern launch planning";
        record.project = "Sample workspace: Lantern";
        record.userPrompt = { text: [
            "Three documents are enough. I have signed in; please try again.",
            "Find the Lantern launch planning meeting on my calendar.",
            "Find the latest launch update in my mail.",
            "Find the five latest Lantern launch planning documents.",
            "Find the launch checklist.",
        ][index], status: "full", provenance: "human-authored",
        authorship: { actor: "user", basis: "source-user" }, sourceTimestamp: `2026-09-30T12:0${index}:00.000Z` };
        record.followUpPrompts = [];
        record.toolCalls = [{ ...record.toolCalls[0], requestArgs: { entityUrls: [target] }, requestedApiPath: target,
            toolSucceeded: index !== 3, reportedOutcome: index === 3 ? "failed" : "succeeded",
            startedAt: `2026-09-30T12:0${index}:01.000Z`, completedAt: `2026-09-30T12:0${index}:02.000Z` }];
        return record;
    });
}

async function setup(t, data = records(), { savedReport = false } = {}) {
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, data);
    if (savedReport) {
        const hash = value => createHash("sha256").update(value).digest("hex");
        const bundleId = `export-${randomUUID()}`, folder = path.join(context.dataDir, "exports", bundleId, "files");
        const name = "product-report.html", manifestName = "coverage-and-redaction-manifest.json";
        const html = "<!doctype html><html lang=en><title>Invented hover proof</title><h1>Sample Lantern report</h1><p>Invented saved copy.</p></html>";
        const manifest = JSON.stringify({ bundleId, kind: "report", privacyReview: { reviewerConfirmed: true },
            files: { [name]: { sha256: hash(html), bytes: Buffer.byteLength(html) } } });
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, name), html); await writeFile(path.join(folder, manifestName), manifest);
        await updateBoardState(context, state => { state.exports.push({ bundleId, kind: "report", bundleDir: folder,
            formats: ["html"], promptMode: "none", preparedAt: "2026-09-30T12:15:00.000Z",
            selectionScope: { requestGroups: 5 }, privacyReview: { reviewerConfirmed: true }, manifestHash: hash(manifest),
            files: { [name]: path.join(folder, name), [manifestName]: path.join(folder, manifestName) } }); });
    }
    const before = await loadBoardState(context);
    let providerCalls = 0;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { providerCalls++; throw Error("No providers in component polish proof."); },
            readSource: async () => { providerCalls++; throw Error("No source reads in component polish proof."); } } });
    const browser = await chromium.launch(), page = await browser.newPage({
        viewport: { width: 1280, height: 1000 }, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce",
    });
    const errors = [], denied = [], reads = new Set(["/api/snapshot", "/api/collection/status",
        "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
        ...(savedReport ? ["/api/report/open"] : [])]);
    page.setDefaultTimeout(6000);
    await page.context().route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !reads.has(url.pathname)) {
            denied.push(`${request.method()} ${url.pathname}`); return route.abort();
        }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No live clipboard reads."); },
        async writeText(text) { window.copiedText = text; },
    } }));
    t.after(async () => {
        try {
            if (proofs && !t.passed) {
                await mkdir(proofs, { recursive: true });
                await writeFile(path.join(proofs, "failure-surface.txt"), await page.locator("body").ariaSnapshot());
            }
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.equal(providerCalls, 0);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    return { page, url: runtime.url };
}

async function capture(page, name, locator) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.screenshot({ path: path.join(proofs, `${name}-page.png`), fullPage: true });
    if (locator) await locator.screenshot({ path: path.join(proofs, `${name}-focused.png`) });
}

async function targetGeometry(locator) {
    return locator.evaluate(node => {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        const range = document.createRange(); range.selectNodeContents(node);
        const text = range.getBoundingClientRect(), before = getComputedStyle(node, "::before"), after = getComputedStyle(node, "::after");
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, textWidth: text.width, background: style.backgroundColor,
            radius: style.borderRadius, outline: style.outline, href: node.getAttribute("href"), color: style.color,
            transform: style.transform,
            centerHitsTarget: node.contains(document.elementFromPoint(point.x, point.y)),
            before: { content: before.content, width: before.width, height: before.height, background: before.backgroundColor },
            after: { content: after.content, width: after.width, height: after.height, background: after.backgroundColor } };
    });
}

test("production Calendar label has content-sized paint and hit geometry with the correct service destination", async t => {
    const { page } = await setup(t);
    await chooseTheme(page, "dark");
    const card = page.locator('[data-percentage-card="services"]');
    const calendar = card.locator(".percentage-label").filter({ hasText: /^Calendar$/ });
    await calendar.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    const rest = await targetGeometry(calendar);
    const neighbors = card.locator(".percentage-label").filter({ hasNotText: /^Calendar$/ });
    const neighborBefore = await neighbors.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
    await calendar.hover();
    const hover = await targetGeometry(calendar);
    await capture(page, "calendar-hover", card);
    const neighborAfter = await neighbors.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
    if (proofs) await writeFile(path.join(proofs, "calendar-geometry.json"), JSON.stringify({ rest, hover, neighborBefore, neighborAfter }, null, 2));
    assert.equal(hover.centerHitsTarget, true, "The label itself receives its center pointer");
    assert.equal(hover.before.content, "none", "No detached pseudo-element produces the oversized paint");
    assert.ok(hover.width <= hover.textWidth + 24, `Calendar hit/paint width ${hover.width} must follow its ${hover.textWidth}px label, not the free row width`);
    assert.ok(hover.height >= 44, "Compact paint must not shrink the accessible target");
    assert.equal(rest.width, hover.width); assert.equal(rest.height, hover.height);
    assert.deepEqual(neighborAfter, neighborBefore, "Hover must not paint neighboring service labels");
    const gap = await calendar.evaluate(node => {
        const label = node.getBoundingClientRect(), value = node.parentElement.querySelector(".percentage-value").getBoundingClientRect();
        const x = (label.right + value.left) / 2, y = label.top + label.height / 2;
        return { x, y, hitsLabel: node.contains(document.elementFromPoint(x, y)) };
    });
    assert.equal(gap.hitsLabel, false, "The empty grid track is not a hidden extension of the Calendar target");
    await page.mouse.move(gap.x, gap.y);
    assert.equal(await calendar.evaluate(node => node.matches(":hover")), false);
    assert.equal((await targetGeometry(calendar)).background, rest.background);
    await calendar.click(); await ready(page);
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("withinServices"), "Calendar");
    await expect(page.locator("#activityList")).toContainText("Find the Lantern launch planning meeting");
    await expect(page.locator("#activityList .request-row")).toHaveCount(1);
});

async function inspectTarget(page, target, family, matrix, { keyboard = true, minimum = 44 } = {}) {
    await target.scrollIntoViewIfNeeded();
    await target.evaluate(node => node.blur());
    await page.mouse.move(0, 0);
    const rest = await targetGeometry(target);
    await target.hover();
    const hover = await targetGeometry(target);
    assert.ok(hover.width >= minimum && hover.height >= minimum, `${family}: usable target ${hover.width}x${hover.height}`);
    assert.equal(hover.centerHitsTarget, true, `${family}: center hits the actual control`);
    assert.equal(hover.width, rest.width); assert.equal(hover.height, rest.height);
    assert.equal(hover.x, rest.x); assert.equal(hover.y, rest.y);
    assert.equal(hover.transform, rest.transform, `${family}: no scale or translation`);
    await page.mouse.down();
    const pressed = await targetGeometry(target);
    assert.equal(pressed.width, rest.width); assert.equal(pressed.height, rest.height);
    assert.equal(pressed.x, rest.x); assert.equal(pressed.y, rest.y);
    assert.equal(pressed.transform, rest.transform, `${family}: no press movement`);
    await page.mouse.move(0, 0); await page.mouse.up();
    let focus;
    if (keyboard) {
        await target.focus(); await page.keyboard.press("Shift");
        focus = await target.evaluate(node => {
            const style = getComputedStyle(node), before = getComputedStyle(node, "::before");
            return { visible: node.matches(":focus-visible"), outline: style.outlineStyle !== "none" ? style.outlineWidth : before.outlineWidth,
                style: style.outlineStyle !== "none" ? style.outlineStyle : before.outlineStyle };
        });
        assert.ok(focus.visible && parseFloat(focus.outline) >= 2 && focus.style !== "none", `${family}: conspicuous keyboard focus`);
        await target.evaluate(node => node.blur());
    }
    matrix.push({ family, rest, hover, pressed, focus });
}

test("bounded production hover families retain aligned targets without painting inert rows", async t => {
    const { page } = await setup(t, records(), { savedReport: true }), matrix = [];
    for (const theme of ["light", "dark"]) {
        await navigateMain(page, "analyze"); await ready(page); await chooseTheme(page, theme);
        const inspect = (target, name, options) => inspectTarget(page, target, `${theme}: ${name}`, matrix, options);
        for (const family of ["tools", "services"]) await inspect(page.locator(`[data-percentage-card="${family}"] .percentage-label`).first(), `${family} label`);
        await inspect(page.locator("#outcomeChart .percentage-label").first(), "outcome label");
        await page.locator('[data-chart="workload"]').click(); await ready(page);
        await inspect(page.locator(".flat-comparison-action").first(), "whole chart-row link");
        const trigger = page.locator('[data-select-id="dateFilter"]');
        await inspect(trigger, "dropdown trigger");
        await trigger.click();
        const selected = page.locator('.select-popup .select-option[aria-selected="true"]').first();
        const unselected = page.locator('.select-popup .select-option[aria-selected="false"]').first();
        await inspect(selected, "selected dropdown option", { keyboard: false });
        await inspect(unselected, "unselected dropdown option", { keyboard: false });
        assert.notEqual(await selected.getAttribute("aria-selected"), await unselected.getAttribute("aria-selected"));
        await page.keyboard.press("Escape");
        const request = page.locator("#activityList>.request-row").first();
        await request.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0);
        const rowRest = await request.evaluate(node => getComputedStyle(node).backgroundColor);
        await request.locator(".request-link").hover();
        assert.equal(await request.evaluate(node => getComputedStyle(node).backgroundColor), rowRest, "Only the nested action paints, not the inert request card");
        await inspect(request.locator(".request-link"), "request action link");
        await inspect(request.locator(".card-chat a"), "filter-to-chat link");
        await inspect(request.locator(".metadata-help-with-label"), "service explanation", { minimum: 24 });
        for (const outcome of ["success", "failure"]) {
            const badge = page.locator(`#activityList .recorded-result[data-outcome="${outcome}"]`).first();
            await badge.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0);
            const rest = await targetGeometry(badge);
            await badge.hover();
            const hover = await targetGeometry(badge);
            assert.equal(rest.background, hover.background, "An inert result pill must not gain action hover paint");
            assert.equal(rest.width, hover.width); assert.equal(rest.height, hover.height);
            assert.equal(await badge.evaluate(node => node.tabIndex), -1);
            matrix.push({ family: `${theme}: static ${outcome} pill`, rest, hover });
        }
        await request.locator(".card-chat a").click(); await ready(page);
        await inspect(page.getByRole("region", { name: "Copilot chat analysis", exact: true }).locator(".result-link[data-outcome=failure]"), "scoped failed-call link pill");
        await page.goBack(); await ready(page);
        await inspect(page.locator("#meaning>summary"), "chart data disclosure");
        await page.locator("#meaning>summary").click();
        const tableRow = page.locator(".exact-data-table tbody tr").first();
        await tableRow.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0);
        const tableRest = await tableRow.evaluate(node => getComputedStyle(node).backgroundColor);
        await tableRow.locator(".chart-data-action").hover();
        const tableHover = await tableRow.evaluate(node => getComputedStyle(node).backgroundColor);
        matrix.push({ family: `${theme}: inert exact-table row`, rest: tableRest, hover: tableHover });
        await inspect(tableRow.locator(".chart-data-action"), "exact table drilldown");
        await page.locator("#meaning>summary").click();
        await navigateMain(page, "reports"); await ready(page);
        const saved = page.locator("#bundleList .saved-report");
        await inspect(saved.locator("summary"), "saved report Manage disclosure");
        const open = page.locator("#bundleList").getByRole("button", { name: "Open saved report", exact: true });
        await inspect(open, "saved report Open");
        await open.click();
        await expect(page.frameLocator(".saved-report-dialog iframe").locator("h1")).toHaveText("Sample Lantern report");
        const close = page.getByRole("button", { name: "Back to report library", exact: true });
        await inspect(close, "dialog Close");
        await close.click(); await expect(open).toBeFocused();
        await page.locator("#reportCreateLink").click();
        const disabled = page.locator(".report-step:disabled").first();
        await inspect(disabled, "disabled report step", { keyboard: false });
        await expect(disabled).toBeDisabled();
        await page.locator('[name="reportScope"][value="all"]').check();
        if (!await page.locator("#reportRequests").evaluate(node => node.open)) await page.locator("#reportRequests>summary").click();
        await inspect(page.locator(".report-entry .request-link").first(), "report request link");
        await page.locator(".report-entry .request-link").first().click(); await ready(page);
        await inspect(page.locator("#contextBack"), "request Back");
    }
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await writeFile(path.join(proofs, "family-geometry.json"), JSON.stringify(matrix, null, 2));
    }
    for (const item of matrix.filter(row => row.family.includes("inert exact-table row"))) {
        assert.equal(item.hover, item.rest, `${item.family}: hovering a nested link must not imply the whole row is clickable`);
    }
});

test("compact labels keep pointer, pressed and keyboard bounds at narrow and doubled text sizes", async t => {
    const { page } = await setup(t), matrix = [];
    for (const [theme, width, scale] of [["light", 1280, 1], ["dark", 1280, 1], ["light", 375, 1], ["dark", 375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        const card = page.locator('[data-percentage-card="services"]');
        const calendar = card.locator(".percentage-label").filter({ hasText: /^Calendar$/ });
        await inspectTarget(page, calendar, `${theme}/${width}/${scale}: Calendar`, matrix);
        const geometry = matrix.at(-1);
        assert.ok(geometry.hover.width <= geometry.hover.textWidth + 24);
        assert.notEqual(geometry.hover.background, geometry.pressed.background, "Pressed remains distinct from pointer hover");
        await calendar.hover();
        await capture(page, `calendar-${theme}-${width}-${scale}`, card);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.deepEqual(await card.locator(".percentage-label").evaluateAll(nodes => nodes.filter(node =>
            node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1).map(node => node.textContent)), []);
    }
    if (proofs) await writeFile(path.join(proofs, "responsive-label-geometry.json"), JSON.stringify(matrix, null, 2));
});

test("compact service and request links retain native modified navigation", async t => {
    const { page } = await setup(t);
    for (const link of [
        page.locator('[data-percentage-card="services"] .percentage-label').filter({ hasText: /^Calendar$/ }),
        page.locator("#activityList .request-link").first(),
        page.locator("#activityList .card-chat a").first(),
    ]) {
        const parentURL = page.url(), href = await link.getAttribute("href");
        const opened = page.context().waitForEvent("page");
        await link.click({ modifiers: ["Control"] });
        const popup = await opened;
        try {
            await popup.waitForLoadState(); await ready(popup);
            assert.equal(popup.url(), new URL(href, parentURL).href);
            assert.equal(page.url(), parentURL, "A modified click leaves the current reading position and route in place");
        } finally { await popup.close(); }
    }
});
