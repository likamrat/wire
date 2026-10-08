import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, openActivitySessions } from "./helpers.mjs";

const proofs = process.env.WORKIQ_CONTEXTUAL_PROOFS;
const baseline = process.env.WORKIQ_CONTEXTUAL_BASELINE === "1";
const slice = "range=custom&from=2026-09-29&to=2026-10-01&service=Calendar&scope=all";
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t) {
    const records = Array.from({ length: 3 }, (_, i) => {
        const record = fixture("context-" + i);
        record.sourceSessionName = "Synthetic contextual actions";
        record.userPrompt.text = "Synthetic contextual request " + i;
        record.toolCalls[0].startedAt = record.capturedAt;
        return record;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const controller = createExportController(context);
    const initial = await loadBoardState(context);
    const saved = await controller.preview("synthetic-context", undefined, { promptMode: "none", formats: ["html"] },
        { kind: "selected", revision: initial.revision, scenarioIds: ["context-0"] });
    await controller.review("synthetic-context", saved.previewId, true);
    await controller.confirm("synthetic-context", saved.previewId, true);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const posts = [], errors = [];
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
        const push = history.pushState;
        window.contextPushes = 0;
        history.pushState = function (...args) { window.contextPushes++; return push.apply(this, args); };
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key], before[key], key);
            assert.ok(posts.every(value => ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(value)), posts.join(", "));
            assert.deepEqual(errors, []);
        } finally { for (const action of cleanup) await action(); }
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(runtime.url + "#activity?" + slice); await ready(page);
    await openActivitySessions(page);
    await page.locator("#activityList input[type=checkbox]").first().check();
    return { page, runtime, posts };
}
async function geometry(page) {
    return page.evaluate(() => {
        const box = node => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const nodes = [...document.querySelectorAll("#pageHeadingActions button,#pageHeadingActions a,[data-clear-selection]")]
            .filter(node => node.checkVisibility());
        const unique = [...new Set(nodes)];
        return {
            actions: unique.map(node => {
                const style = getComputedStyle(node), r = box(node), range = document.createRange();
                range.selectNodeContents(node);
                const textRects = [...range.getClientRects()];
                const label = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
                if (label) range.selectNodeContents(label);
                const labelBox = label ? range.getBoundingClientRect() : null;
                const icon = node.querySelector("svg");
                return { ...r, id: node.id, label: node.textContent.trim(), parent: node.parentElement.id,
                    font: parseFloat(style.fontSize), fill: style.backgroundColor, border: style.borderColor,
                    labelBottom: labelBox?.bottom, iconCenter: icon ? box(icon).y + box(icon).height / 2 : null,
                    decoration: style.textDecorationLine, disabled: node.disabled === true,
                    clipped: textRects.some(t => t.width && (t.left < r.x - 1 || t.right > r.right + 1 || t.top < r.y - 1 || t.bottom > r.bottom + 1)),
                    nested: node.querySelectorAll("a,button,input,[tabindex]").length };
            }),
            summary: box(document.querySelector("#reportsView").hidden
                ? document.querySelector("#activitySelectionSummary") : document.querySelector("#previewSelectionSummary")),
            heading: box(document.querySelector("#pageTitle")),
            overflow: document.documentElement.scrollWidth - innerWidth,
        };
    });
}
function fits(metrics, width, text = 100) {
    assert.ok(metrics.overflow <= 1, "No page overflow");
    for (const action of metrics.actions) {
        assert.ok(action.height >= 44, `${action.label}: 44px target`);
        assert.ok(action.font >= 14 * text / 100, `${action.label}: approved Fluent control role, never shrunk to fit`);
        assert.ok(action.x >= 0 && action.right <= width + 1, `${action.label}: within viewport`);
        assert.equal(action.clipped, false, `${action.label}: full label`);
        assert.equal(action.nested, 0);
        assert.equal(action.decoration, "none");
    }
}
function adjacent(metrics) {
    const [first, ...rest] = metrics.actions;
    for (const action of rest) {
        assert.ok(Math.abs(action.y - first.y) <= 1, "All contextual actions share one row");
        assert.ok(Math.abs(action.labelBottom - first.labelBottom) <= 1, "Text baselines align");
    }
    for (const action of metrics.actions) if (action.iconCenter !== null) assert.ok(Math.abs(action.iconCenter - action.y - action.height / 2) <= 1, "Fluent icon is optically centered");
    for (let i = 1; i < metrics.actions.length; i++) {
        const gap = metrics.actions[i].x - metrics.actions[i - 1].right;
        assert.ok(gap >= 7 && gap <= 9, `Adjacent 8px gap, received ${gap}`);
    }
    assert.ok(Math.abs(first.x - metrics.summary.x) <= 1, "Actions align with their scope summary");
    assert.ok(first.y - metrics.summary.bottom <= 48, "Context and actions stay together");
}

test("context actions reproduce Reports and share one adjacent, wrapping scope group across views", { timeout: 120000 }, async t => {
    const { page } = await setup(t), measurements = [];
    await navigateMain(page, "reports"); await ready(page);
    if (baseline) {
        await chooseTheme(page, "dark");
        const measured = await geometry(page);
        assert.ok(measured.actions.find(a => a.label === "Clear selection").y > measured.actions.find(a => a.label === "Reset to Home").bottom + 20);
        if (proofs) {
            await page.screenshot({ path: path.join(proofs, "before-reports-dark-1200.png"), fullPage: true });
            await writeFile(path.join(proofs, "before-geometry.json"), JSON.stringify(measured, null, 2));
        }
        return;
    }
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const text of [100, 200]) {
        await page.setViewportSize({ width, height: 1100 });
        await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; }, text);
        await page.mouse.move(0, 0);
        await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
        const metrics = await geometry(page);
        fits(metrics, width, text);
        assert.deepEqual(metrics.actions.map(a => a.label), ["Back to activity", "Clear selection"]);
        assert.equal(await page.locator("#scopeResetActions #resetView").isVisible(), true);
        if (width >= 1200 && text === 100) adjacent(metrics);
        for (let i = 1; i < metrics.actions.length; i++) {
            const current = metrics.actions[i], previous = metrics.actions[i - 1];
            assert.ok(current.y >= previous.y, "Visual and DOM order agree when wrapping");
        }
        measurements.push({ theme, width, text, view: "reports", ...metrics });
        assert.ok(await page.locator(".page-heading").evaluate(node => node.getBoundingClientRect().height
            <= [...node.children].filter(child => child.checkVisibility()).reduce((sum, child) => sum + child.getBoundingClientRect().height, 24)),
        "Heading has no reserved blank height");
        if (proofs) await page.screenshot({ path: path.join(proofs, `reports-${theme}-${width}-${text}.png`), fullPage: true });
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.locator("#pageAction").click(); await ready(page);
    await openActivitySessions(page);
    for (const view of ["activity", "chat", "request", "home"]) {
        if (view === "chat") await page.locator(".session-drill").first().click();
        if (view === "request") { await openActivitySessions(page); await page.locator(".request-link").first().click(); }
        if (view === "home") await navigateMain(page, "home");
        await ready(page);
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const text of [100, 200]) {
            await page.setViewportSize({ width, height: 1100 });
            await chooseTheme(page, theme);
            await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; scrollTo(0, 0); }, text);
            const metrics = await geometry(page);
            fits(metrics, width, text);
            if (width >= 1200 && text === 100) adjacent(metrics);
            assert.equal(metrics.actions.at(-1).label, "Clear selection");
            measurements.push({ view, theme, width, text, ...metrics });
            if (proofs && width === 375 && text === 200) await page.screenshot({ path: path.join(proofs, `${view}-${theme}-${width}-${text}.png`), fullPage: true });
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await page.setViewportSize({ width: 1200, height: 1000 });
    }
    if (proofs) await writeFile(path.join(proofs, "after-geometry.json"), JSON.stringify(measurements, null, 2));
});

test("context actions retain native destinations, private search, draft membership and stable focus", { timeout: 60000, skip: baseline }, async t => {
    const { page, posts } = await setup(t);
    await page.locator("#activitySearch").fill("contextual request");
    await page.waitForFunction(() => history.state?.evidenceView?.search === "contextual request");
    const origin = page.url();
    await page.locator(".session-drill").first().click(); await ready(page);
    const back = page.locator("#contextBack"), reset = page.locator("#resetView"), clear = page.locator("#activityClearSelection");
    await back.focus(); await page.keyboard.press("Shift");
    assert.equal(await back.evaluate(node => node.matches(":focus-visible")), true);
    await page.keyboard.press("Tab");
    assert.equal(await clear.evaluate(node => node === document.activeElement), true);
    await reset.focus();
    assert.equal(await reset.evaluate(node => node.closest("#filters") !== null), true);
    await back.hover();
    assert.equal(await back.evaluate(node => getComputedStyle(node).textDecorationLine), "none");
    const originalNode = await back.elementHandle();
    await back.focus();
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
    assert.equal(await originalNode.evaluate(node => node === document.activeElement && node.isConnected), true);
    const pushes = await page.evaluate(() => window.contextPushes);
    await page.keyboard.press("Enter"); await ready(page);
    assert.equal(page.url(), origin);
    assert.equal(await page.evaluate(() => window.contextPushes), pushes + 1);
    assert.equal(await page.locator("#activitySearch").inputValue(), "contextual request");
    assert.ok(!page.url().includes("contextual"));
    await openActivitySessions(page);
    await page.locator("#activityList input[type=checkbox]").nth(1).check();
    await page.locator("#activityList input[type=checkbox]").nth(2).check();
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), "One report · 3 request groups included");
    await navigateMain(page, "reports"); await ready(page);
    const reportBack = page.locator("#pageAction");
    const point = await reportBack.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const x = rect.left + 5, y = rect.top + rect.height / 2;
        return { x, y, owns: document.elementFromPoint(x, y)?.closest("a") === node };
    });
    assert.equal(point.owns, true);
    const beforeEdge = await page.evaluate(() => window.contextPushes);
    await page.mouse.click(point.x, point.y); await ready(page);
    assert.equal(page.url(), origin);
    assert.equal(await page.evaluate(() => window.contextPushes), beforeEdge + 1);
    const membership = await page.locator("#activitySelectionSummary").textContent();
    await reset.click(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home");
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), membership);
    assert.equal(await page.locator("#activitySearch").inputValue(), "");
    await page.goBack(); await ready(page);
    assert.equal(page.url(), origin);
    assert.equal(await page.locator("#activitySearch").inputValue(), "contextual request");
    await page.goForward(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home");
    const beforeClear = posts.length;
    await clear.click();
    assert.equal(posts.length, beforeClear, "Clear performs no persisted mutation");
    assert.equal(await page.locator("#reportSelectionBar").isVisible(), false, "No empty action row on default Home");
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), "No requests selected");
    await navigateMain(page, "reports"); await ready(page);
    assert.equal(await page.locator("#pageHeadingActions [data-clear-selection]:visible").count(), 1);
    await page.locator("#reportClearSelection").click();
    assert.equal(await page.locator("#exportBtn").isDisabled(), true);
    assert.equal(await page.locator("#previewSelectionSummary").textContent(), "No requests selected");
    assert.match(await page.locator("#savedReportCount").textContent(), /^1 saved report\./);
});

test("long contextual labels wrap inside a narrow panel on a wide host, including disabled controls", { timeout: 30000, skip: baseline }, async t => {
    const { page } = await setup(t);
    await navigateMain(page, "reports"); await ready(page);
    await page.setViewportSize({ width: 2560, height: 1100 });
    for (const theme of ["light", "dark"]) for (const text of [100, 200]) {
        await chooseTheme(page, theme);
        await page.evaluate(size => {
            document.documentElement.style.fontSize = size + "%";
            const main = document.querySelector("main");
            main.style.width = "375px"; main.style.marginInline = "0";
            document.querySelector("#pageAction").textContent = "Return to the previously filtered Copilot activity";
            document.querySelector("#reportClearSelection").textContent = "Clear the selected request groups from this report";
            document.querySelector("#reportClearSelection").disabled = true;
            document.querySelector("#resetView").lastChild.textContent = "Reset the current activity view";
            document.activeElement.blur(); scrollTo(0, 0);
        }, text);
        const metrics = await geometry(page); fits(metrics, 375, text);
        const font = await page.locator("#pageAction").evaluate(node => parseFloat(getComputedStyle(node).fontSize));
        assert.ok(font >= (text === 200 ? 28 : 14), "No control-role font shrink to fit");
        assert.equal(await page.locator("#reportClearSelection").isDisabled(), true);
        await page.locator("#resetView").focus(); await page.keyboard.press("Tab");
        assert.equal(await page.locator("#reportClearSelection").evaluate(node => node === document.activeElement), false);
        if (proofs) {
            await page.mouse.move(0, 0);
            await page.screenshot({ path: path.join(proofs, `narrow-host-${theme}-${text}.png`), fullPage: true });
        }
    }
});

test("empty Activity selection retains compact feedback without reclaiming the analytical reset action", { timeout: 30000, skip: baseline }, async t => {
    const { page } = await setup(t);
    const before = await page.locator("#reportSelectionBar").boundingBox();
    await page.locator("#activityClearSelection").click();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const metrics = await page.evaluate(() => {
            const box = node => node.getBoundingClientRect();
            const heading = box(document.querySelector(".page-heading"));
            const copy = box(document.querySelector(".page-heading>div:first-child"));
            const actions = box(document.querySelector("#pageHeadingActions"));
            return { headingHeight: heading.height, copyHeight: copy.height, headingTop: heading.top,
                headingBottom: heading.bottom, actionTop: actions.top, actionBottom: actions.bottom };
        });
        assert.equal((await page.locator("#reportSelectionBar").boundingBox()).height, before.height);
        assert.ok(metrics.actionTop >= metrics.headingTop && metrics.actionBottom <= metrics.headingBottom);
        assert.equal(await page.locator("#activitySelectionContext").isVisible(), true);
        assert.equal(await page.locator("#activityClearSelection").isDisabled(), true);
        assert.equal(await page.locator("#filters #resetView").count(), 1);
        assert.ok((await page.locator("#resetView").boundingBox()).height >= 44);
    }
});
