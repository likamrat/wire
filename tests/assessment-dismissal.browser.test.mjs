import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { fixture, privateFixture, revealStoredRefresh } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { contrast } from "./color-measurements.mjs";
import { randomUUID } from "node:crypto";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";

async function setup(t, { mutations = false } = {}) {
    const cleanup = [];
    const records = Array.from({ length: 62 }, (_, index) => ({
        ...fixture(`dismissal-${index}`), sourceSessionId: `artificial-session-${index % 36}`,
    }));
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 950 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const errors = [], blocked = [], calls = [];
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            const after = await loadBoardState(context);
            assert.deepEqual(after.evidence, before.evidence);
            if (!mutations) assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
            assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
        } finally { for (const action of cleanup) await action(); }
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = url.origin === new URL(runtime.url).origin && (
            request.method() === "GET" && ["/", "/favicon.svg", "/assets/assessment-contract.mjs"].includes(url.pathname) ||
            request.method() === "POST" && ["/api/session", "/api/snapshot", "/api/collection/status", "/api/record/status", "/api/assessment/detail", "/api/assessment/overview",
                "/api/assessment/mutation/status", ...(mutations ? ["/api/assessment/feedback"] : [])].includes(url.pathname));
        if (!allowed) { blocked.push(`${request.method()} ${url.pathname}`); return route.abort(); }
        calls.push(url.pathname); return route.continue();
    });
    await page.addInitScript(() => {
        window.dismissalEvents = [];
        for (const type of ["click", "cancel", "close"]) document.addEventListener(type, event => {
            window.dismissalEvents.push({ type, tag: event.target.tagName, text: event.target instanceof HTMLButtonElement ? event.target.textContent : null,
                trusted: event.isTrusted, connected: event.target.isConnected, modal: document.querySelectorAll(":modal").length });
        }, true);
    });
    async function go(hash = "#home") {
        await page.goto(runtime.url + hash);
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        await page.locator(`${hash === "#home" ? "#homeInsights" : ".interaction-insights"} .assessment-grid`).waitFor();
        await page.evaluate(() => document.fonts.ready);
    }
    return { page, runtime, context, calls, go };
}
const homeTrigger = page => page.locator("#homeInsights .assessment-heading button");
const details = page => page.getByRole("dialog", { name: "Insight details", exact: true });
async function released(page, trigger) {
    await page.waitForFunction(() => document.querySelectorAll(":modal").length === 0);
    assert.equal(await page.locator("dialog[open]").count(), 0);
    await trigger.evaluate(node => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest("[inert]"))), false);
}
async function picture(page, name) {
    if (!process.env.WIRE_DISMISSAL_PROOFS) return;
    await mkdir(process.env.WIRE_DISMISSAL_PROOFS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.WIRE_DISMISSAL_PROOFS, name + ".png") });
}

test("Home aggregate real Close and Escape release the connected top layer after normal status polling", { timeout: 30000 }, async t => {
    const { page, calls, go } = await setup(t);
    await go();
    const trigger = homeTrigger(page);
    await trigger.click();
    await details(page).getByText("Recorded measures and definitions", { exact: true }).click();
    const before = calls.filter(value => value === "/api/collection/status").length;
    await page.waitForTimeout(5600);
    assert.ok(calls.filter(value => value === "/api/collection/status").length > before);
    await details(page).getByRole("button", { name: "Close", exact: true }).click();
    await released(page, trigger);
    await trigger.click();
    await page.keyboard.press("Escape");
    await released(page, trigger);
    await page.waitForTimeout(5600);
    await released(page, trigger);
    const events = await page.evaluate(() => window.dismissalEvents);
    assert.equal(events.filter(event => event.type === "click" && /definitions|Details and feedback/i.test(event.text)).length, 2);
    assert.ok(events.some(event => event.type === "click" && event.text === "Close" && event.trusted && event.connected && event.modal === 1));
    assert.ok(events.some(event => event.type === "cancel" && event.trusted && event.connected));
    await (await revealStoredRefresh(page)).click();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.equal(await page.locator(":modal").count(), 0);
});

test("Home Close restores its replacement trigger after a same-basis snapshot rerender", { timeout: 20000 }, async t => {
    const { page, go } = await setup(t);
    await go();
    const trigger = homeTrigger(page);
    await trigger.click();
    await trigger.evaluate(node => { window.oldInsightTrigger = node; });
    const next = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await next; await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.waitForFunction(() => !window.oldInsightTrigger.isConnected);
    await details(page).getByRole("button", { name: "Close", exact: true }).click();
    await released(page, trigger);
    await page.evaluate(() => window.oldInsightTrigger.click());
    assert.equal(await page.locator(":modal").count(), 0, "Detached old controls cannot reactivate the details panel.");
    await trigger.click();
    await page.keyboard.press("Escape");
    await released(page, trigger);
});

test("authoritative insight invalidation keeps keyboard focus in the dismissible panel", { timeout: 20000 }, async t => {
    const { page, context, go } = await setup(t, { mutations: true });
    await go();
    await homeTrigger(page).click();
    const model = buildAssessmentModel(await loadBoardState(context));
    await executeAssessmentAction(context, "synthetic-dismissal", "set_personal_assessment", {
        schemaVersion: 1, mutationRef: "mutation-" + randomUUID().replaceAll("-", ""),
        interactionRef: model.catalog[0].interactionRef, expectedBasis: model.basis,
        checkId: "semantic-answer-correctness", verdict: "pass", withdraw: false,
    });
    await details(page).getByRole("heading", { name: "Insights changed", exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await details(page).evaluate(node => node.contains(document.activeElement)), true, "Replacing an invalidated body must not leave focus on the inert background.");
    await details(page).getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(":modal"));
});

test("repeated Home opens, child clicks and keyboard focus never leak into the background or resurrect a dismissed panel", { timeout: 20000 }, async t => {
    const { page, go } = await setup(t);
    await go();
    const trigger = homeTrigger(page);
    for (let index = 0; index < 8; index++) {
        await trigger.click();
        const dialog = details(page);
        await dialog.getByText("Recorded measures and definitions", { exact: true }).click();
        await dialog.locator(".assessment-definition h3").first().click();
        assert.equal(await page.locator(":modal").count(), 1);
        await page.locator("#refreshBtn").focus();
        assert.equal(await page.locator("#refreshBtn").evaluate(node => node === document.activeElement), false, "Native modal inertness remains in force.");
        await dialog.getByRole("button", { name: "Close", exact: true }).focus();
        await page.keyboard.press("Tab");
        assert.equal(await dialog.locator("summary").first().evaluate(node => node === document.activeElement), true);
        if (index % 2) await page.keyboard.press("Escape");
        else await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await released(page, trigger);
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: index % 2 ? 1200 : 768, height: 950 });
        await page.evaluate(() => { document.documentElement.dataset.evidenceTheme = document.documentElement.dataset.evidenceTheme === "dark" ? "light" : "dark"; });
        assert.equal(await page.locator(":modal").count(), 0);
    }
});

test("shared shell confirmation exits through Close, Escape and native Back without sending the confirmed action", { timeout: 20000 }, async t => {
    const { page, go, calls } = await setup(t);
    await go();
    await page.evaluate(() => { location.hash = "#collection-status"; });
    await page.locator("#collectionStatusView").waitFor();
    await page.locator("#recorderDiagnostics > summary").click();
    await page.waitForFunction(() => !document.getElementById("recordBtn").disabled);
    for (const action of ["Close", "Escape", "Back"]) {
        await page.locator("#recordBtn").click();
        assert.equal(await page.locator("#overlay:modal").count(), 1);
        if (action === "Close") await page.locator("#closeDialog").click();
        else if (action === "Escape") await page.keyboard.press("Escape");
        else await page.goBack();
        await page.waitForFunction(() => !document.querySelector(":modal"));
        if (action !== "Back") await page.waitForFunction(() => document.activeElement.id === "recordBtn");
    }
    assert.equal(await page.locator("#homeView").isVisible(), true);
    assert.equal(calls.includes("/api/record"), false);
});

test("Home definitions stay contextual and Close stays visible after content scroll at narrow and enlarged sizes", { timeout: 60000 }, async t => {
    const { page, go } = await setup(t);
    await go();
    for (const theme of ["light", "dark"]) for (const width of [320, 375, 768, 1200, 2560]) for (const size of [100, 200]) {
        await page.setViewportSize({ width, height: 950 });
        await page.evaluate(({ theme, size }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = `${size}%`;
        }, { theme, size });
        const trigger = homeTrigger(page);
        assert.equal(await trigger.textContent(), "Measure definitions");
        const placement = await trigger.evaluate(node => {
            const group = node.parentElement.getBoundingClientRect(), heading = node.parentElement.querySelector("h2").getBoundingClientRect(), button = node.getBoundingClientRect();
            return { fits: button.left >= group.left && button.right <= group.right + 1,
                gap: button.top < heading.bottom ? button.left - heading.right : button.top - heading.bottom,
                wrapped: button.top >= heading.bottom };
        });
        assert.ok(placement.fits && placement.gap >= 7 && (!placement.wrapped || placement.gap <= 16),
            `${theme}/${width}/${size}: definitions share the Insights header without crowding or overflow`);
        await trigger.click();
        const dialog = details(page);
        assert.equal(await dialog.getByRole("button", { name: "Give personal feedback" }).count(), 0);
        assert.equal(await dialog.locator("details").evaluateAll(nodes => nodes.some(node => node.open)), false);
        const titleWordLines = await dialog.locator(".dialog-head h2").evaluate(node => {
            const range = document.createRange();
            range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, "Insight".length);
            return range.getClientRects().length;
        });
        assert.equal(titleWordLines, 1, `Title words stay intact at ${theme}/${width}/${size}`);
        if (width === 1200 && size === 100) await picture(page, `definitions-entry-${theme}`);
        await dialog.getByText("Recorded measures and definitions", { exact: true }).click();
        const before = await page.evaluate(() => scrollY);
        await dialog.locator(".assessment-definition").last().scrollIntoViewIfNeeded();
        const close = dialog.getByRole("button", { name: "Close", exact: true });
        const bounds = await close.evaluate(node => {
            const box = node.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, right: box.right, left: box.left, height: box.height,
                hit: node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
        });
        const colors = await dialog.evaluate(node => {
            const head = node.querySelector(".dialog-head");
            const close = head.querySelector("button"), body = node.querySelector(".assessment-dialog-body");
            return {
                close: getComputedStyle(close).color, header: getComputedStyle(head).backgroundColor,
                text: getComputedStyle(body).color, background: getComputedStyle(node).backgroundColor,
            };
        });
        assert.ok(contrast(colors.close, colors.header) >= 4.5, `Close contrast ${theme}/${width}/${size}`);
        assert.ok(contrast(colors.text, colors.background) >= 4.5, `Body contrast ${theme}/${width}/${size}`);
        assert.ok(bounds.top >= 0 && bounds.bottom <= 950 && bounds.left >= 0 && bounds.right <= width && bounds.height >= 44 && bounds.hit,
            `${theme}/${width}/${size}: visible actionable Close ${JSON.stringify(bounds)}`);
        await dialog.hover(); await page.mouse.wheel(0, 3000); await page.waitForTimeout(50);
        assert.equal(await page.evaluate(() => scrollY), before, "Wheel does not scroll the inert background page.");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await page.evaluate(() => [...document.fonts].some(face => face.family.includes("Asta Sans") && face.status === "loaded")), true);
        if (width === 320 && size === 200 || width === 1200 && size === 100) await picture(page, `definitions-${theme}-${width}-${size}`);
        await close.click(); await released(page, trigger);
    }
});

test("feedback status READ can be dismissed without cancelling or replaying the committed write", { timeout: 25000 }, async t => {
    const { page, context, go } = await setup(t, { mutations: true });
    let writes = 0, entered, release;
    const reading = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    await page.route("**/api/assessment/feedback", async route => {
        writes++;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort("connectionreset");
    });
    await page.route("**/api/assessment/mutation/status", async route => {
        const response = await route.fetch();
        entered(); await hold;
        await route.fulfill({ response });
    });
    try {
        await go("#request?request=dismissal-0");
        await page.locator(".interaction-insights .assessment-heading button").click();
        await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
        const feedback = page.getByRole("dialog", { name: "Your feedback: answer correctness", exact: true, includeHidden: true });
        await feedback.getByRole("combobox", { name: "Your assessment", exact: true }).click();
        await page.getByRole("option", { name: "Correct", exact: true }).click();
        await feedback.getByRole("button", { name: "Save feedback", exact: true }).click();
        await feedback.getByRole("button", { name: "Check update result", exact: true }).click();
        await reading;
        await page.keyboard.press("Escape");
        assert.equal(await feedback.evaluate(node => node.open), false, "An in-flight receipt READ is not an irreversible mutation.");
        assert.notEqual(await page.evaluate(() => sessionStorage.getItem("wire.assessment.pending")), null);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(":modal").count(), 0);
        release();
        await page.waitForFunction(() => sessionStorage.getItem("wire.assessment.pending") === null);
        assert.equal(await page.locator(":modal").count(), 0);
        assert.equal(writes, 1);
        assert.equal((await loadBoardState(context)).personalEvaluation.feedback.records.length, 1);
    } finally { release(); }
});

for (const outcome of ["complete", "lost-response"]) test(`closing a saving feedback view preserves its ${outcome} operation without affecting a newer interaction`, { timeout: 25000 }, async t => {
    const { page, context, runtime, go } = await setup(t, { mutations: true });
    let entered, release, writes = 0, savedReceipt;
    const committed = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    await page.route("**/api/assessment/feedback", async route => {
        writes++;
        savedReceipt = route.request().postDataJSON();
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        entered(); await hold;
        if (outcome === "complete") await route.fulfill({ response });
        else await route.abort("connectionreset");
    });
    try {
        await go("#request?request=dismissal-0");
        await page.locator(".interaction-insights .assessment-heading button").click();
        await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
        const feedback = page.getByRole("dialog", { name: "Your feedback: answer correctness", exact: true, includeHidden: true });
        await feedback.getByRole("combobox", { name: "Your assessment", exact: true }).click();
        await page.getByRole("option", { name: "Correct", exact: true }).click();
        await feedback.getByRole("button", { name: "Save feedback", exact: true }).click();
        await committed;
        assert.match(await feedback.textContent(), /Closing this panel does not cancel the update/);
        await feedback.getByRole("button", { name: "Close", exact: true }).click();
        assert.equal(await feedback.evaluate(node => node.open), false);
        await details(page).getByRole("button", { name: "Close", exact: true }).click();
        const receipt = await page.evaluate(() => JSON.parse(sessionStorage.getItem("wire.assessment.pending")));
        assert.equal(receipt.mutationRef, savedReceipt.mutationRef);
        assert.equal(receipt.receiptToken, savedReceipt.receiptToken);
        await page.evaluate(() => { location.hash = "#request?request=dismissal-1"; });
        await page.locator(".interaction-insights .assessment-grid").waitFor();
        await page.locator(".interaction-insights .assessment-heading button").click();
        const current = await page.locator(".interaction-insights").getAttribute("data-insight-key");
        release();
        if (outcome === "complete") await page.waitForFunction(() => sessionStorage.getItem("wire.assessment.pending") === null);
        else {
            await details(page).getByRole("button", { name: "Close", exact: true }).click();
            await page.getByRole("button", { name: "Check earlier update", exact: true }).click();
            await page.waitForFunction(() => sessionStorage.getItem("wire.assessment.pending") === null);
        }
        assert.ok(page.url().startsWith(runtime.url));
        assert.equal(new URL(page.url()).hash, "#request?request=dismissal-1");
        if (outcome === "complete") {
            assert.equal(await details(page).isVisible(), true, "An earlier write cannot close a newer details view.");
            await page.keyboard.press("Escape");
        }
        assert.equal(await page.locator(":modal").count(), 0);
        assert.ok(current.includes("detail:"));
        assert.equal(writes, 1);
        const records = (await loadBoardState(context)).personalEvaluation.feedback.records;
        assert.equal(records.length, 1);
        assert.equal(records[0].assessment.interactionRef, savedReceipt.interactionRef);
    } finally { release(); }
});
