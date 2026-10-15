import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, navigateMain, navigateSettings, restoreLegacySearch } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proof = process.env.WIRE_SIDEBAR_PROOFS;

async function setup(t, { savedReport = false, touch = false, beforeNavigate } = {}) {
    const records = Array.from({ length: 18 }, (_, index) => {
        const record = fixture(`sidebar-${index}`);
        record.sourceSessionName = `Invented planning chat ${index}`;
        record.userPrompt = { text: `Find the invented release checklist ${index}. ` + "Keep the original evidence and unresolved decisions together. ".repeat(4),
            status: "full", sourceTimestamp: "2026-09-30T12:00:00Z", sourceEventId: `sidebar-prompt-${index}`,
            authorship: { actor: "user", basis: "source-user" } };
        record.followUpPrompts = [];
        return record;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const reports = createExportController(context);
    if (savedReport) {
        const initial = await loadBoardState(context);
        const preview = await reports.preview("synthetic-sidebar-report", undefined, { promptMode: "none", formats: ["html", "json"] },
            { kind: "selected", revision: initial.revision, scenarioIds: [records[0].scenarioId] });
        await reports.review("synthetic-sidebar-report", preview.previewId, true);
        await reports.confirm("synthetic-sidebar-report", preview.previewId, true);
    }
    const runtime = await startServer(context, reports, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: touch ? 375 : 1440, height: 1000 }, hasTouch: touch, reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push(new URL(request.url())));
    await page.addInitScript(() => {
        window.sidebarCopies = [];
        window.sidebarCopyMode = "success";
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            readText() { throw Error("Real clipboard reads are forbidden."); },
            async writeText(text) {
                if (window.sidebarCopyMode === "denied") throw new DOMException("Invented clipboard denial", "NotAllowedError");
                window.sidebarCopies.push(text);
            },
        } });
    });
    t.after(async () => {
        await browser.close();
        await runtime.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []);
        assert.ok(requests.every(url => url.origin === new URL(runtime.url).origin), "No off-device requests");
    });
    await beforeNavigate?.(page);
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page, runtime, records, requests, context, errors };
}

test("opening during an actual pending overview resumes the retained Analyze summary without recursion", { timeout: 20000 }, async t => {
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    const { page, errors } = await setup(t, { beforeNavigate: page => page.route("**/api/assessment/overview", route => {
        const delivery = (async () => {
            const response = await route.fetch();
            arrived(); await held;
            await route.fulfill({ response });
        })();
        deliveries.push(delivery);
        return delivery;
    }) });
    try {
        await restoreLegacySearch(page, "release checklist 0.");
        await pending;
        await expect(page.locator("#homeInsights")).toHaveAttribute("aria-busy", "true");
        await page.locator("#resultsLink").click();
        await page.locator(".request-card-open").first().click();
        assert.deepEqual(errors, [], "Pending overview must not throw during sidebar entry");
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        release(); await Promise.all(deliveries);
        await expect(page.locator("#homeInsights[aria-busy=true]")).toHaveCount(0);
        await expect(page.locator("#homeInsights .assessment-summary")).toHaveCount(1);
        await expect(page.locator(".request-original pre")).toContainText("checklist 0.");
        await expect(page.locator("#pageTitle")).toHaveText("Analyze");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        await expect(page.locator("#homeInsights .assessment-summary")).toHaveCount(1);
    } finally { release(); await Promise.all(deliveries); }
});

test("closing while the background overview is pending resumes it after exit cleanup", { timeout: 20000 }, async t => {
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    const { page } = await setup(t, { beforeNavigate: page => page.route("**/api/assessment/overview", route => {
        const delivery = (async () => {
            const response = await route.fetch();
            arrived(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    }) });
    try {
        await restoreLegacySearch(page, "release checklist 0.");
        await pending;
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.locator("#resultsLink").click();
        await page.locator(".request-card-open").first().click();
        await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
        await expect(page.locator("#homeInsights")).toHaveAttribute("aria-busy", "true");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        release(); await Promise.all(deliveries);
        await expect(page.locator("#homeInsights[aria-busy=true]")).toHaveCount(0);
        await expect(page.locator("#homeInsights .assessment-summary")).toHaveCount(1);
        await expect(page.locator("#pageTitle")).toHaveText("Analyze");
    } finally { release(); await Promise.all(deliveries); }
});

for (const action of ["Measure definitions", "Automatic scores"]) test(`an origin ${action} action takes ownership before old sidebar cleanup`, { timeout: 20000 }, async t => {
    const { page } = await setup(t, action === "Automatic scores" ? { beforeNavigate: page =>
        page.route("**/api/evaluation/automatic/summary", async route => {
            const response = await route.fetch(), summary = await response.json();
            await route.fulfill({ json: { ...summary, snapshot: { ...summary.snapshot, state: "paused", reason: "source-changed" } } });
        }) } : {});
    await restoreLegacySearch(page, "release checklist 0.");
    await page.locator("#analyzeReviewDetails>summary").click();
    const trigger = page.locator("#homeInsights").getByRole("button", { name: action, exact: true });
    await expect(trigger).toBeVisible();
    await page.locator("#resultsLink").click();
    await page.locator(".request-card-open").first().click();
    await expect(page.locator(".request-original pre")).toContainText("checklist 0.");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    if (action === "Automatic scores") await page.route("**/api/evaluation/automatic/setup", route => {
        const delivery = (async () => {
            const response = await route.fetch();
            arrived(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    });
    try {
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].pause());
        const origin = page.url();
        if (action === "Measure definitions") {
            await trigger.focus();
            await trigger.press("Enter");
        } else {
            await trigger.click();
            await pending;
        }
        await page.locator("#contextSidebar").evaluate(node => { for (const animation of node.getAnimations()) animation.finish(); });
        release(); await Promise.all(deliveries);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const dialog = action === "Measure definitions" ? page.locator('dialog[aria-label="Insight details"]')
            : page.locator("dialog.automatic-score-dialog");
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(action === "Measure definitions" ? "What these results mean" : "Connect a supported local Copilot source");
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        assert.equal(await page.locator("#requestContent").textContent(), "", "Old private paint is gone before the new owner paints");
        assert.equal(page.url(), origin, "Controller acquisition did not require navigation");
        assert.equal(await page.locator("dialog[open]").count(), 1, "The latest dialog remains the only active surface");
        await expect(dialog.locator("button").first()).toBeFocused();
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.screenshot({ path: path.join(proof, action === "Measure definitions" ? "origin-definitions.png" : "origin-automatic-scores.png") });
        }
    } finally { release(); await Promise.all(deliveries); }
});

test("minimal native card opens an anchored sidebar without replacing the Analyze DOM", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#resultsLink").click();
    const card = page.locator("#activityList>.request-row").first();
    assert.equal(await card.locator('input,button,.card-context,.request-meta,.full-text-toggle').count(), 0);
    assert.equal(await card.getByRole("link").count(), 1);
    await page.evaluate(() => { window.originalActivityList = document.querySelector("#activityList").firstElementChild; });
    const link = card.locator("a");
    const before = await card.boundingBox();
    const mainWidth = await page.locator("#main").evaluate(node => node.clientWidth);
    await page.mouse.click(before.x + before.width / 2, before.y + 20);
    await page.locator("#contextSidebar[open]").waitFor();
    assert.equal(await page.locator("#homeView").isVisible(), true);
    assert.equal(await page.evaluate(() => window.originalActivityList === document.querySelector("#activityList").firstElementChild), true);
    assert.ok(Math.abs((await card.boundingBox()).y - before.y) <= 3, "Card vertical anchor retained");
    assert.ok(await page.locator("#main").evaluate(node => node.clientWidth) < mainWidth - 250, "Actual main width is reduced");
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.matches(":modal")), false);
    assert.equal(await link.getAttribute("aria-expanded"), "true");
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.originalActivityList === document.querySelector("#activityList").firstElementChild), true);
    assert.equal(await link.evaluate(node => node === document.activeElement), true);
    assert.ok(Math.abs((await card.boundingBox()).y - before.y) <= 3);
    assert.equal(await page.locator("#main").evaluate(node => node.clientWidth), mainWidth);
    await page.goForward();
    await page.locator("#contextSidebar[open]").waitFor();
    await page.goBack();
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
});

test("personal feedback stays inline and holds a dirty card switch until discarded", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#resultsLink").click();
    const first = page.locator(".request-card-open").first(), second = page.locator(".request-card-open").nth(1);
    await first.click();
    await page.locator("#requestContent [data-insight-details]").first().click();
    assert.equal(await page.locator("dialog[open]").count(), 1, "Only the shared sidebar is open");
    const inline = page.locator("#requestContent .assessment-inline");
    await inline.getByRole("button", { name: "Give personal feedback" }).click();
    await page.locator("#requestContent .assessment-feedback-dialog").getByRole("combobox", { name: "Your assessment", exact: true }).click();
    await page.locator('.select-option[data-value="fail"]').click();
    const original = page.url();
    await second.click();
    assert.equal(page.url(), original, "Dirty switch has not changed route identity");
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    assert.equal(await page.locator("#requestContent .assessment-feedback-dialog select").inputValue(), "fail");
    await page.goBack();
    await expect(page.locator("#contextSidebarGuard")).toBeVisible();
    await expect(page).toHaveURL(original);
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(page.locator("#requestContent .assessment-feedback-dialog [role=combobox]")).toBeFocused();
    await second.click();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    assert.notEqual(page.url(), original);
    assert.equal(await page.locator("#requestContent .assessment-feedback-dialog").count(), 0);
});

test("sidebar adapts the actual columns and remains readable with fixed actions at narrow and doubled text sizes", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    if (proof) await mkdir(proof, { recursive: true });
    const samples = [];
    for (const [theme, width, height, scale, navigation] of [
        ["light", 1440, 1000, 1, "expanded"], ["dark", 1440, 1000, 1, "collapsed"],
        ["dark", 1280, 900, 1, "expanded"], ["light", 820, 720, 1, "expanded"],
        ["dark", 375, 820, 1, "expanded"], ["light", 375, 820, 2, "expanded"],
        ["dark", 420, 820, 2, "expanded"], ["light", 820, 400, 1, "expanded"],
    ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        if (await page.locator("#navigationCollapse").isVisible()
            && await page.locator("html").getAttribute("data-navigation") !== navigation) await page.locator("#navigationCollapse").click();
        await page.locator("#resultsLink").click();
        const link = page.locator(".request-card-open").first();
        await link.scrollIntoViewIfNeeded();
        const entry = await link.boundingBox();
        await page.mouse.click(entry.x + entry.width / 2, Math.max(90, entry.y + 20));
        await page.locator("#contextSidebar[open]").waitFor();
        const copy = page.locator(".request-original .ux-copy");
        await copy.click();
        await expect(copy).toHaveAttribute("data-copy-state", "success");
        const measured = await page.evaluate(() => {
            const panel = document.querySelector("#contextSidebar"), body = document.querySelector("#contextSidebarBody");
            const close = document.querySelector("#closeContextSidebar"), footer = document.querySelector("#contextSidebarFooter");
            const rect = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
            return { modal: panel.matches(":modal"), overflow: document.documentElement.scrollWidth - innerWidth,
                panel: rect(panel), close: rect(close), footer: rect(footer), body: rect(body),
                reportActions: [...footer.querySelectorAll("button")].map(rect),
                main: rect(document.querySelector("#main")), documentY: scrollY,
                promptWeight: getComputedStyle(document.querySelector(".request-original pre")).fontWeight,
                promptStyle: getComputedStyle(document.querySelector(".request-original pre")).fontStyle,
                colors: { page: getComputedStyle(panel).backgroundColor, text: getComputedStyle(body).color,
                    key: getComputedStyle(document.querySelector(".reader-facts dt")).color,
                    icon: getComputedStyle(close).color, focus: getComputedStyle(document.documentElement).getPropertyValue("--focus"),
                    edge: getComputedStyle(panel).borderInlineStartColor },
                shadow: getComputedStyle(panel).boxShadow,
                footerFill: getComputedStyle(footer).backgroundColor,
                facts: [...document.querySelectorAll(".reader-facts dt")].map(dt => {
                    const key = getComputedStyle(dt), value = getComputedStyle(dt.nextElementSibling);
                    return [key.fontFamily === value.fontFamily, key.fontSize === value.fontSize, key.fontWeight === value.fontWeight];
                }) };
        });
        assert.ok(measured.overflow <= 1, JSON.stringify(measured));
        assert.equal(measured.promptWeight, "400");
        assert.equal(measured.promptStyle, "normal");
        assert.ok(contrast(measured.colors.text, measured.colors.page) >= 4.5);
        assert.ok(contrast(measured.colors.key, measured.colors.page) >= 4.5);
        assert.ok(contrast(measured.colors.icon, measured.colors.page) >= 3);
        assert.ok(contrast(measured.colors.focus, measured.colors.page) >= 3);
        assert.equal(measured.colors.edge, "rgba(0, 0, 0, 0)", "The ordinary pane perimeter is decorative, not a control boundary");
        assert.notEqual(measured.shadow, "none");
        assert.equal(measured.footerFill, measured.colors.page, "Fixed actions belong to the same pane surface");
        assert.ok(measured.facts.flat().every(Boolean));
        assert.ok(measured.close.width >= 44 && measured.close.height >= 44);
        assert.ok(measured.close.y >= 0 && measured.close.y + measured.close.height <= height);
        assert.ok(measured.footer.y >= measured.body.y + measured.body.height - 1);
        assert.ok(measured.footer.y + measured.footer.height <= height + 1, JSON.stringify(measured));
        assert.ok(measured.body.height >= 80, "Reading space remains usable");
        if (width >= 1280) {
            assert.ok(measured.main.x + measured.main.width <= measured.panel.x + 1, "No desktop overlay");
            assert.ok(Math.abs(measured.reportActions[0].y - measured.reportActions[1].y) <= 1, "The compact desktop footer remains one action row");
        }
        else assert.equal(measured.modal, true);
        const name = `${theme}-${width}-${height}-${scale}-${navigation}`;
        if (proof) {
            await page.screenshot({ path: path.join(proof, name + "-page.png"), fullPage: true });
            await page.screenshot({ path: path.join(proof, name + "-viewport.png") });
        }
        await page.locator("#requestContent .detail-disclosure>summary").first().click();
        await page.locator("#requestContent [data-insight-details]").first().click();
        const beforeScroll = await page.evaluate(() => scrollY);
        await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop = node.scrollHeight);
        assert.equal(await page.evaluate(() => scrollY), beforeScroll, "Panel scrolling cannot move the document");
        if (proof) await page.screenshot({ path: path.join(proof, name + "-details.png") });
        samples.push({ theme, width, height, scale, navigation, ...measured });
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    }
    if (proof) await writeFile(path.join(proof, "geometry.json"), JSON.stringify(samples, null, 2));
});

test("switching restores current disclosure and scroll state while filters dismiss the interaction", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t);
    await page.locator("#resultsLink").click();
    const a = page.locator(".request-card-open").first(), b = page.locator(".request-card-open").nth(1);
    await a.click();
    const first = page.url();
    const disclosure = page.locator("#requestContent .detail-disclosure").first();
    await disclosure.locator("summary").click();
    await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop = 220);
    const scroll = await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop);
    const reads = requests.filter(url => url.pathname === "/api/snapshot").length;
    await a.click();
    assert.equal(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop), scroll, "The active card does not reset reading");
    await b.click(); assert.notEqual(page.url(), first);
    await a.click();
    assert.equal(page.url(), first);
    await expect(disclosure).toHaveAttribute("open", "");
    assert.equal(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop), scroll);
    assert.equal(requests.filter(url => url.pathname === "/api/snapshot").length, reads, "Switching does not collect or reread the source");
    await selectActivityOption(page, "dateFilter", "7");
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    assert.match(page.url(), /#analyze.*range=7/);
});

test("inline feedback recovers an uncertain committed write without replay after switching interactions", { timeout: 30000 }, async t => {
    const { page, context } = await setup(t);
    let writes = 0;
    await page.route("**/api/assessment/feedback", async route => {
        writes++;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort("connectionreset");
    });

    await page.locator("#resultsLink").click();
    await page.locator(".request-card-open").first().click();
    await page.locator("#requestContent [data-insight-details]").first().click();
    await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
    const feedback = page.locator("#requestContent .assessment-feedback-dialog");
    await feedback.getByRole("combobox", { name: "Your assessment", exact: true }).click();
    await page.locator('.select-option[data-value=pass]').click();
    await feedback.getByRole("button", { name: "Save feedback", exact: true }).click();
    await expect(feedback.getByRole("button", { name: "Check update result", exact: true })).toBeVisible();
    await page.locator(".request-card-open").nth(1).click();
    await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    assert.equal(writes, 1);
    assert.ok(await page.evaluate(() => sessionStorage.getItem("wire.assessment.pending")));
    await page.getByRole("button", { name: "Check earlier update", exact: true }).click();
    await page.waitForFunction(() => sessionStorage.getItem("wire.assessment.pending") === null);
    assert.equal(writes, 1);
    assert.equal((await loadBoardState(context)).personalEvaluation.feedback.records.length, 1);
    assert.equal(await page.locator("dialog[open]").count(), 1);
});

test("all personal-feedback dimensions save and withdraw inline, with explicit unsent Cancel", { timeout: 45000 }, async t => {
    const { page, context } = await setup(t);
    await page.locator("#resultsLink").click();
    await page.locator(".request-card-open").first().click();
    let count = 0;
    async function openFeedback(check) {
        await page.locator("#requestContent [data-insight-details]").first().click();
        const details = page.locator("#inline-insight-details");
        await details.getByRole("combobox", { name: "Personal feedback (optional)", exact: true }).click();
        await page.locator(`.select-option[data-value="${check}"]`).click();
        await details.getByRole("button", { name: "Give personal feedback", exact: true }).click();
        return page.locator("#requestContent .assessment-feedback-dialog");
    }
    async function saved() {
        await expect.poll(async () => (await loadBoardState(context)).personalEvaluation.feedback.records.length).toBe(++count);
        await expect(page.locator("#requestContent .assessment-feedback-dialog:visible")).toHaveCount(0);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#requestContent .interaction-insights[aria-busy=true]")).toHaveCount(0);
    }
    for (const [check, verdict] of [["semantic-answer-correctness", "pass"], ["answer-support-validity", "fail"], ["action-authorization-compliance", "unassessed"]]) {
        let form = await openFeedback(check);
        await form.getByRole("combobox", { name: "Your assessment", exact: true }).click();
        await page.locator(`.select-option[data-value="${verdict}"]`).click();
        if (count === 0) {
            await form.getByRole("button", { name: "Cancel", exact: true }).click();
            await page.getByRole("button", { name: "Discard changes", exact: true }).click();
            await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
            await form.getByRole("combobox", { name: "Your assessment", exact: true }).click();
            await page.locator(`.select-option[data-value="${verdict}"]`).click();
        }
        await form.getByRole("button", { name: "Save feedback", exact: true }).click();
        await saved();
        form = await openFeedback(check);
        await expect(form).toContainText("Saved feedback:");
        await form.getByRole("button", { name: "Withdraw feedback", exact: true }).click();
        await saved();
    }
    const records = (await loadBoardState(context)).personalEvaluation.feedback.records;
    assert.deepEqual(records.map(row => row.assessment.checkId), [
        "semantic-answer-correctness", "semantic-answer-correctness", "answer-support-validity", "answer-support-validity",
        "action-authorization-compliance", "action-authorization-compliance",
    ]);
    assert.deepEqual(records.map(row => row.assessment.withdrawn), [false, true, false, true, false, true]);
    assert.equal(await page.locator("dialog[open]").count(), 1);
});

test("contextual automatic-score setup is inline and never grants approval on entry", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t);
    await page.locator("#resultsLink").click();
    await page.locator(".request-card-open").first().click();
    await page.locator("#requestContent [data-automatic-scores]").first().click();
    await expect(page.locator("#requestContent .automatic-score-dialog")).toContainText("Connect a supported local Copilot source");
    assert.equal(await page.locator("dialog[open]").count(), 1);
    assert.equal(requests.filter(url => /\/(?:approve|revoke|consent\/set|evaluation\/run)$/.test(url.pathname)).length, 0);
    await page.locator("#requestContent .automatic-score-dialog").getByRole("button", { name: "Close automatic scores", exact: true }).click();
    await expect(page.locator("#requestContent .automatic-score-dialog")).toBeHidden();
});

test("inline automatic approval keeps explicit scope and consent fields without a second dialog or submission", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t);
    await page.route("**/api/evaluation/automatic/setup", route => route.fulfill({ json: {
        schemaVersion: 1, sourceRevision: 7, approvalRevision: 0, minimumSessionAiCredits: 30, snapshot: null,
        source: { sourceConfigRef: "sourceconfig-" + "a".repeat(32), sourceConfigRevision: 1, windowDays: 30 },
        method: { provider: "github-copilot", model: "synthetic-model", rubricId: "wire-recorded-interaction-review", rubricVersion: 1 },
        chats: [{ chatRef: "chat-" + "b".repeat(32), name: "Invented approval chat", outsideWindow: 1, requestGroups: 2, shortId: "invented" }],
    } }));
    await page.locator("#resultsLink").click();
    await page.locator(".request-card-open").first().click();
    await page.locator("#requestContent [data-automatic-scores]").first().click();
    const form = page.locator("#requestContent .automatic-score-dialog");
    const approve = form.getByRole("button", { name: "Approve automatic scores", exact: true });
    await expect(approve).toBeDisabled();
    await form.getByRole("checkbox", { name: /Invented approval chat/ }).check();
    await form.getByLabel("Total assessment allowance", { exact: true }).fill("2");
    await form.getByLabel("Total budget (AI credits)", { exact: true }).fill("30");
    await expect(approve).toBeDisabled();
    await form.getByRole("checkbox", { name: /Allow this evidence/ }).check();
    await expect(approve).toBeEnabled();
    await page.setViewportSize({ width: 375, height: 820 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await approve.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.equal(await page.locator("dialog[open]").count(), 1);
    if (proof) await page.screenshot({ path: path.join(proof, "inline-approval-375-200.png") });
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(requests.filter(url => url.pathname.endsWith("/automatic/approve")).length, 0);
});

test("touch Copy activates once, uses a 44px target and reports clipboard denial inline", { timeout: 30000 }, async t => {
    const { page, records } = await setup(t, { touch: true });
    await page.locator("#resultsLink").tap();
    await page.locator(".request-card-open").first().tap();
    const copy = page.locator(".request-original .ux-copy");
    const before = await copy.boundingBox();
    assert.ok(before.width >= 44 && before.height >= 44);
    await copy.tap();
    await expect(copy).toHaveAttribute("data-copy-state", "success");
    assert.deepEqual(await copy.boundingBox(), before);
    assert.deepEqual(await page.evaluate(() => window.sidebarCopies), [records[0].userPrompt.text]);
    await page.evaluate(() => window.sidebarCopyMode = "denied");
    await copy.tap();
    await expect(page.locator(".request-original .ux-copy-status.error")).toContainText("permission was denied");
    assert.equal(await page.evaluate(() => window.sidebarCopies.length), 1);
    assert.equal(await page.locator("dialog[open]").count(), 1);
});

test("motion glides only the sidebar and interrupted close settles to the newest card", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#resultsLink").click();
    const a = page.locator(".request-card-open").first(), b = page.locator(".request-card-open").nth(1);
    await a.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
        window.sidebarMotion = [];
        const card = document.querySelector(".request-row"), panel = document.querySelector("#contextSidebar");
        let count = 0;
        function sample() {
            if (panel.open) window.sidebarMotion.push({ cardY: card.getBoundingClientRect().top,
                panelX: panel.getBoundingClientRect().left, transform: getComputedStyle(panel).transform,
                cardTransform: getComputedStyle(card).transform });
            if (++count < 30) requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
    });
    const box = await a.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 20);
    await page.waitForFunction(() => window.sidebarMotion.length >= 15);
    const samples = await page.evaluate(() => window.sidebarMotion);
    assert.ok(samples.some(sample => sample.panelX > samples.at(-1).panelX + 10), "Actual right-edge glide occurs");
    assert.ok(samples.every(sample => Math.abs(sample.cardY - box.y) < 3 && sample.cardTransform === "none"));
    await page.locator("#closeContextSidebar").click();
    const reversingFrom = await page.locator("#contextSidebar").evaluate(async node => {
        const animation = node.getAnimations()[0];
        animation.pause(); await animation.ready; animation.currentTime = 60;
        await new Promise(resolve => requestAnimationFrame(resolve));
        return getComputedStyle(node).transform;
    });
    await b.click();
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].effect.getKeyframes()[0].transform),
        reversingFrom, "A new card reverses from the presented edge instead of snapping closed first");
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await expect(page.locator(".request-original pre")).toContainText("checklist 1.");
    assert.equal(await page.locator("dialog[open]").count(), 1);
    if (proof) await writeFile(path.join(proof, "motion.json"), JSON.stringify(samples, null, 2));
});

test("soft surfaces preserve functional edges, nav states and Search depth in all four shell states", { timeout: 45000 }, async t => {
    const { page } = await setup(t, { savedReport: true });
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const navigation of ["expanded", "collapsed"]) {
        await chooseTheme(page, theme);
        if (await page.locator("html").getAttribute("data-navigation") !== navigation) await page.locator("#navigationCollapse").click();
        await navigateMain(page, "analyze");
        const paint = await page.evaluate(() => {
            const style = selector => getComputedStyle(document.querySelector(selector));
            const active = document.querySelector('.primary-navigation a[aria-current=page]');
            const widgets = [...document.querySelectorAll(".analyze-population,.analyze-chart-main,.analyze-outcome-summary,#percentageCharts .percentage-card")];
            return {
                widgets: widgets.map(node => ({ border: getComputedStyle(node).borderTopColor, shadow: getComputedStyle(node).boxShadow })),
                active: { fill: getComputedStyle(active).backgroundColor, before: getComputedStyle(active, "::before").content,
                    ink: getComputedStyle(active).color, weight: getComputedStyle(active).fontWeight },
                rail: { fill: style("#sidebar").backgroundColor, edge: style("#sidebar").borderRightColor },
                search: { shadow: style("#wireSearch").boxShadow, border: style("#wireSearch").borderTopColor,
                    fill: style("#wireSearch").backgroundColor },
                width: document.querySelector("#main").clientWidth,
                promptSize: style(".request-card-prompt").fontSize,
            };
        });
        assert.equal(paint.widgets.length, 6);
        assert.ok(paint.widgets.every(widget => widget.border === "rgba(0, 0, 0, 0)" && widget.shadow === "none"));
        assert.equal(paint.active.before, "none", "No redundant active-nav stripe");
        assert.notEqual(paint.active.fill, paint.rail.fill);
        assert.equal(paint.active.weight, "600");
        assert.ok(contrast(paint.active.ink, paint.active.fill) >= 4.5);
        assert.equal(paint.rail.edge, "rgba(0, 0, 0, 0)", "Tonal separation replaces the decorative shell frame");
        assert.notEqual(paint.search.shadow, "none", "Search retains its own elevation");
        assert.ok(contrast(paint.search.border, paint.search.fill) >= 3);
        const nav = page.locator('.primary-navigation a[aria-current=page]');
        await nav.focus();
        assert.ok(await nav.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth)) >= 2);
        await page.mouse.move(500, 100);
        await page.locator("#navigationCollapse").hover();
        const hover = await page.locator("#navigationCollapse").evaluate(node => getComputedStyle(node).backgroundColor);
        await page.mouse.down();
        const pressed = await page.locator("#navigationCollapse").evaluate(node => getComputedStyle(node).backgroundColor);
        await page.mouse.move(500, 100); await page.mouse.up();
        assert.notEqual(hover, pressed, "Collapse has distinct hover and pressed feedback without a box");
        await page.locator(".request-card-open").first().click();
        const pane = await page.locator("#contextSidebar").evaluate(node => {
            const css = getComputedStyle(node), header = getComputedStyle(node.querySelector("header"));
            const footer = getComputedStyle(document.querySelector("#contextSidebarFooter"));
            return { fill: css.backgroundColor, shadow: css.boxShadow, edge: css.borderInlineStartColor,
                edgeWidth: css.borderInlineStartWidth, headerFill: header.backgroundColor, headerEdge: header.borderBottomColor,
                footerFill: footer.backgroundColor, footerEdge: footer.borderTopColor };
        });
        assert.notEqual(pane.shadow, "none", "The contextual pane has its own directional elevation");
        assert.equal(pane.fill, paint.rail.fill);
        assert.equal(pane.edge, "rgba(0, 0, 0, 0)");
        assert.equal(pane.edgeWidth, "1px", "Changing perimeter paint preserves the existing box metrics");
        assert.equal(pane.headerFill, "rgba(0, 0, 0, 0)");
        assert.equal(pane.footerFill, pane.fill);
        assert.equal(pane.headerEdge, "rgba(0, 0, 0, 0)");
        assert.equal(pane.footerEdge, "rgba(0, 0, 0, 0)");
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.screenshot({ path: path.join(proof, `pane-${theme}-${navigation}.png`) });
        }
        await page.emulateMedia({ forcedColors: "active" });
        const forcedPane = await page.locator("#contextSidebar").evaluate(node => {
            const css = getComputedStyle(node);
            return { fill: css.backgroundColor, shadow: css.boxShadow, edge: css.borderInlineStartColor,
                headerEdge: getComputedStyle(node.querySelector("header")).borderBottomColor,
                footerEdge: getComputedStyle(document.querySelector("#contextSidebarFooter")).borderTopColor };
        });
        assert.equal(forcedPane.shadow, "none");
        for (const edge of ["edge", "headerEdge", "footerEdge"]) assert.ok(contrast(forcedPane[edge], forcedPane.fill) >= 3);
        if (proof) await page.screenshot({ path: path.join(proof, `pane-forced-${theme}-${navigation}.png`) });
        await page.emulateMedia({ forcedColors: "none" });
        await page.locator("#closeContextSidebar").click();
        await navigateMain(page, "reports");
        assert.equal(await page.locator("#bundles").evaluate(node => getComputedStyle(node).borderTopColor), "rgba(0, 0, 0, 0)");
        await expect(page.locator(".saved-library-row").first()).toBeVisible();
        assert.notEqual(await page.locator(".saved-library-row").first().evaluate(node => getComputedStyle(node).borderTopColor), "rgba(0, 0, 0, 0)");
        await page.locator("#reportCreateLink").click();
        assert.equal(await page.locator(".report-journey").evaluate(node => getComputedStyle(node).borderTopColor), "rgba(0, 0, 0, 0)");
        await expect(page.locator("#reportList input[type=checkbox]").first()).toBeVisible();
        await page.locator("#reportList input[type=checkbox]").first().check();
        await expect(page.locator("#reportList input[type=checkbox]").first()).toBeChecked();
        await navigateMain(page, "settings");
        assert.equal(await page.locator(".settings-categories").evaluate(node => getComputedStyle(node).borderRightColor), "rgba(0, 0, 0, 0)");
        await expect(page.locator("#saveCollection")).toBeDisabled();
        await expect(page.locator("#cancelPreferences")).toBeDisabled();
        await page.emulateMedia({ forcedColors: "active" });
        const highlighted = await page.locator('.primary-navigation a[aria-current=page]').evaluate(node => ({
            fill: getComputedStyle(node).backgroundColor, ink: getComputedStyle(node).color,
            icon: getComputedStyle(node.querySelector("svg")).color, adjustment: getComputedStyle(node).forcedColorAdjust,
        }));
        assert.equal(highlighted.adjustment, "none");
        assert.equal(highlighted.ink, highlighted.icon);
        assert.ok(contrast(highlighted.ink, highlighted.fill) >= 4.5);
        await page.emulateMedia({ forcedColors: "none" });
        measurements.push({ theme, navigation, ...paint, pane, forcedPane, highlighted });
    }
    for (const theme of ["light", "dark"]) {
        const expanded = measurements.find(row => row.theme === theme && row.navigation === "expanded");
        const collapsed = measurements.find(row => row.theme === theme && row.navigation === "collapsed");
        assert.ok(collapsed.width > expanded.width + 100);
        assert.equal(collapsed.promptSize, expanded.promptSize, "Width is reclaimed without scaling text");
    }
    if (proof) {
        await mkdir(proof, { recursive: true });
        await writeFile(path.join(proof, "soft-surface-states.json"), JSON.stringify(measurements, null, 2));
    }
});

test("four-state panel motion keeps anchors, fixed regions and content replacement coherent", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    const traces = [];
    const settled = () => page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    for (const theme of ["light", "dark"]) for (const navigation of ["expanded", "collapsed"]) {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await chooseTheme(page, theme);
        if (await page.locator("html").getAttribute("data-navigation") !== navigation) await page.locator("#navigationCollapse").click();
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.locator("#resultsLink").click();
        const a = page.locator(".request-card-open").first(), b = page.locator(".request-card-open").nth(1);
        await a.scrollIntoViewIfNeeded();
        const entry = await a.boundingBox(), width = await page.locator("#main").evaluate(node => node.clientWidth);
        await page.evaluate(() => {
            const panel = document.querySelector("#contextSidebar"), card = document.querySelector(".request-card-open");
            window.surfaceMotion = { phase: "open", frames: [], running: true };
            const state = window.surfaceMotion;
            function frame(at) {
                const rect = node => node.getBoundingClientRect();
                const panelRect = rect(panel), css = getComputedStyle(panel);
                state.frames.push({ at, phase: state.phase, open: panel.open,
                    x: panelRect.x, width: panelRect.width, cardY: rect(card).y,
                    transform: css.transform, opacity: css.opacity, cardTransform: getComputedStyle(card).transform,
                    headerX: rect(panel.querySelector("header")).x, bodyX: rect(document.querySelector("#contextSidebarBody")).x,
                    footerX: rect(document.querySelector("#contextSidebarFooter")).x, animations: panel.getAnimations().length,
                    mainWidth: document.querySelector("#main").clientWidth });
                if (state.running) requestAnimationFrame(frame);
            }
            requestAnimationFrame(frame);
        });
        await page.mouse.click(entry.x + entry.width / 2, entry.y + 20);
        await expect(page.locator("#contextSidebar[open]")).toBeVisible(); await settled();
        const panelWidth = await page.locator("#contextSidebar").evaluate(node => node.clientWidth);
        assert.ok(await page.locator("#main").evaluate(node => node.clientWidth) < width - 250);
        const reflow = await page.evaluate(() => {
            const main = document.querySelector("#main").getBoundingClientRect();
            const inside = selector => [...document.querySelectorAll(selector)].filter(node => node.checkVisibility()).every(node => {
                const box = node.getBoundingClientRect();
                return box.left >= main.left && box.right <= main.right + 1;
            });
            const grid = document.querySelector(".analyze-chart-grid");
            return { columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
                widgets: inside("#analyzePopulation,.analyze-chart-main,.analyze-outcome-summary,#percentageCharts .percentage-card"),
                controls: inside("#filters button,#filters input,.percentage-legend-row"),
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                headerLayer: Number(getComputedStyle(document.querySelector(".app-header")).zIndex),
                panelLayer: Number(getComputedStyle(document.querySelector("#contextSidebar")).zIndex) };
        });
        assert.equal(reflow.columns, 1, "Widgets stack for the remaining main column");
        assert.ok(reflow.widgets && reflow.controls && !reflow.overflow, "Widgets, filters and legends fit the true remaining column");
        assert.ok(reflow.panelLayer < reflow.headerLayer, "Docked panel stays below the header and Search");
        await page.evaluate(() => window.surfaceMotion.phase = "replace");
        const bBox = await b.boundingBox();
        await page.mouse.click(bBox.x + bBox.width / 2, bBox.y + 20);
        await expect(page.locator(".request-original pre")).toContainText("checklist 1.");
        const aBox = await a.boundingBox();
        await page.mouse.click(aBox.x + aBox.width / 2, aBox.y + 20);
        await expect(page.locator(".request-original pre")).toContainText("checklist 0.");
        await page.evaluate(() => window.surfaceMotion.phase = "close");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0); await settled();
        await expect(a).toBeFocused();
        assert.ok(Math.abs((await a.boundingBox()).y - entry.y) <= 3);
        assert.equal(await page.locator("#main").evaluate(node => node.clientWidth), width);
        const frames = await page.evaluate(() => { window.surfaceMotion.running = false; return window.surfaceMotion.frames; });
        if (proof) {
            await mkdir(proof, { recursive: true });
            await writeFile(path.join(proof, `panel-motion-${theme}-${navigation}.json`), JSON.stringify({ entry, frames }, null, 2));
        }
        for (const phase of ["open", "close"]) {
            const moving = frames.filter(row => row.phase === phase && row.open && row.animations);
            assert.ok(new Set(moving.map(row => Math.round(row.x))).size >= 3, `${theme}/${navigation}/${phase}: intermediate painted positions`);
            assert.ok(moving.every(row => row.cardTransform === "none" && row.opacity === "1"));
            assert.ok(moving.every(row => Math.abs(row.cardY - entry.y) <= 3),
                `${phase}: card anchor ${entry.y}, observed ${moving.map(row => row.cardY)}`);
            assert.ok(moving.every(row => Math.abs(row.headerX - row.bodyX) <= 1 && Math.abs(row.bodyX - row.footerX) <= 1));
            assert.ok(moving.every(row => row.width >= panelWidth && row.width <= panelWidth + 2), "Panel translates without scaling or morphing");
            assert.equal(new Set(moving.map(row => row.mainWidth)).size, 1, "Docked width does not animate reading text");
            for (let i = 1; i < moving.length; i++) {
                assert.ok(phase === "open" ? moving[i].x <= moving[i - 1].x + 1 : moving[i].x >= moving[i - 1].x - 1,
                    "One directional glide without bounce");
            }
        }
        assert.ok(frames.filter(row => row.phase === "replace").every(row => row.animations === 0), "No entrance replay on replacement");
        traces.push({ theme, navigation, entryY: entry.y, width, reflow, frames });
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(".request-card-open").first().press("Enter");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.getAnimations().length), 0);
    await page.locator("#closeContextSidebar").press("Enter");
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    if (proof) {
        await mkdir(proof, { recursive: true });
        await writeFile(path.join(proof, "four-state-motion.json"), JSON.stringify(traces, null, 2));
    }
});

test("enabling reduced motion settles an in-flight contextual entrance immediately", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#resultsLink").click();
    const link = page.locator(".request-card-open").first();
    await link.scrollIntoViewIfNeeded();
    const box = await link.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 20);
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const motion = await page.locator("#contextSidebar").evaluate(async node => {
        await new Promise(resolve => requestAnimationFrame(resolve));
        return node.getAnimations().map(animation => ({ state: animation.playState, time: animation.currentTime, duration: animation.effect.getTiming().duration }));
    });
    assert.deepEqual(motion, [], "An OS motion-preference change must not leave the running glide behind");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
});

test("owned sidebar history keeps Close, Escape, Back and Forward anchored and restores the caller's scroll mode", { timeout: 45000 }, async t => {
    const { page, runtime } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const measurements = [];
    for (const mode of ["auto", "manual"]) for (const action of ["Close", "Escape", "Back"]) {
        await page.evaluate(mode => history.scrollRestoration = mode, mode);
        await page.locator("#resultsLink").click();
        const link = page.locator(".request-card-open").first();
        await link.scrollIntoViewIfNeeded();
        const entry = await link.boundingBox();
        await page.mouse.click(entry.x + entry.width / 2, entry.y + 20);
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
        await page.evaluate(() => {
            window.historyExit = { frames: [], running: true };
            const trace = window.historyExit;
            function sample() {
                const panel = document.querySelector("#contextSidebar");
                trace.frames.push({ open: panel.open, moving: panel.getAnimations().length > 0,
                    cardY: document.querySelector(".request-card-open").getBoundingClientRect().y });
                if (trace.running) requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
        });
        if (action === "Close") await page.locator("#closeContextSidebar").click();
        else if (action === "Escape") {
            await page.locator("#contextSidebarTitle").focus();
            await page.keyboard.press("Escape");
        } else await page.goBack();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        const frames = await page.evaluate(() => { window.historyExit.running = false; return window.historyExit.frames; });
        assert.ok(frames.some(frame => frame.open && frame.moving));
        assert.ok(frames.every(frame => Math.abs(frame.cardY - entry.y) <= 3), `${mode}/${action}: native restoration moved the card`);
        assert.equal(await page.evaluate(() => history.scrollRestoration), mode);
        await expect(link).toBeFocused();
        await page.goForward();
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
        assert.ok(Math.abs((await link.boundingBox()).y - entry.y) <= 3, "Forward restores the owned sidebar without native scroll");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        assert.equal(await page.evaluate(() => history.scrollRestoration), mode);
        measurements.push({ mode, action, entryY: entry.y, frames });
    }
    await page.evaluate(() => history.scrollRestoration = "auto");
    await page.goto(runtime.url + "#request?request=sidebar-0");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.locator("#homeView")).toBeVisible();
    assert.ok(page.url().startsWith(runtime.url), "Direct entry closes locally rather than navigating out of WIRE");
    assert.equal(await page.evaluate(() => history.scrollRestoration), "auto");
    await page.locator("#resultsLink").click();
    await page.locator(".request-card-open").first().click();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    await navigateMain(page, "settings");
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    assert.equal(await page.evaluate(() => history.scrollRestoration), "auto");
    await page.evaluate(() => history.go(-2));
    await expect(page.locator("#homeView")).toBeVisible();
    await expect(page.locator("#settingsView")).toBeHidden();
    assert.equal(await page.evaluate(() => history.scrollRestoration), "auto", "Skipping the request entry restores the marked origin mode");
    if (proof) {
        await mkdir(proof, { recursive: true });
        await writeFile(path.join(proof, "owned-history-motion.json"), JSON.stringify(measurements, null, 2));
    }
});

test("reduced-motion exit and newer keyboard intent settle without stale focus or docking", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#resultsLink").click();
    const link = page.locator(".request-card-open").first();
    await link.click();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    await page.locator("#closeContextSidebar").click();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(link).toBeFocused();
    assert.equal(await page.locator("body").getAttribute("data-context-docked"), null);
    assert.equal(await page.evaluate(() => history.scrollRestoration), "auto");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await link.click();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].pause());
    await page.locator("#wireSearch").focus();
    await page.keyboard.press("ArrowRight");
    await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].finish());
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.locator("#wireSearch")).toBeFocused();
    assert.equal(await page.locator("body").getAttribute("data-context-docked"), null);
    await page.locator("#wireSearch").press("Escape");
});

test("resizing during entry or exit settles the latest layout without a stale overlay", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#resultsLink").click();
    await page.locator(".request-card-open").first().click();
    await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].pause());
    await page.setViewportSize({ width: 375, height: 820 });
    await expect.poll(() => page.locator("#contextSidebar").evaluate(node => node.matches(":modal") && node.getAnimations().length === 0)).toBe(true);
    await expect(page.locator("#closeContextSidebar")).toBeInViewport();
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].pause());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    assert.equal(await page.locator("body").getAttribute("data-context-docked"), null);
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.inert || node.matches(":modal")), false);
    await expect(page.locator(".request-card-open").first()).toBeFocused();
});

test("leaving during a pending feedback receipt neither retains an interactive form nor replays the write", { timeout: 30000 }, async t => {
    const { page, context } = await setup(t);
    let release, arrived, writes = 0;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    await page.route("**/api/assessment/feedback", route => {
        const delivery = (async () => {
            writes++;
            const response = await route.fetch();
            arrived(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    });
    try {
        await page.locator("#resultsLink").click();
        await page.locator(".request-card-open").first().click();
        await page.locator("#requestContent [data-insight-details]").first().click();
        await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
        const form = page.locator("#requestContent .assessment-feedback-dialog");
        await form.getByRole("combobox", { name: "Your assessment", exact: true }).click();
        await page.locator(".select-option[data-value=pass]").click();
        await form.getByRole("button", { name: "Save feedback", exact: true }).click();
        await pending;
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        assert.equal(await page.locator("#requestContent .assessment-feedback-dialog").count(), 0);
        assert.ok(await page.evaluate(() => sessionStorage.getItem("wire.assessment.pending")));
        release(); await Promise.all(deliveries);
        await page.waitForFunction(() => sessionStorage.getItem("wire.assessment.pending") === null);
        assert.equal(writes, 1);
        assert.equal((await loadBoardState(context)).personalEvaluation.feedback.records.length, 1);
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    } finally { release(); await Promise.all(deliveries); }
});

test("report continuation retains choices and returns to the original sidebar with current canonical membership", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#resultsLink").click();
    const card = page.locator(".request-card-open").first();
    await card.click();
    await page.locator("#requestReportToggle").click();
    await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
    await page.locator("#requestReportContinue").click();
    await expect(page.locator("#reportStage1")).toBeVisible();
    const checked = page.locator("#reportList input:checked");
    assert.equal(await checked.count(), 1);
    await expect(checked.locator("xpath=ancestor::article[1]")).toBeFocused();
    await page.goBack();
    await page.locator("#contextSidebar[open]").waitFor();
    await expect(page.locator("#homeView")).toBeVisible();
    await expect(page.locator("#reportsView")).toBeHidden();
    await expect(page.locator("#requestReportContinue")).toBeFocused();
    await page.locator("#requestReportToggle").click();
    await expect(page.locator("#requestReportContinue")).toBeDisabled();
    await page.locator("#closeContextSidebar").click();
    await expect(card).toBeFocused();
});

test("source invalidation scrubs the old prompt, copy getter and held unsent-feedback transition", { timeout: 30000 }, async t => {
    const { page, context, records } = await setup(t);
    await page.locator("#resultsLink").click();
    await page.locator(".request-card-open").first().click();
    const copy = await page.locator(".request-original .ux-copy").elementHandle();
    await page.locator("#requestContent [data-insight-details]").first().click();
    await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
    await page.locator("#requestContent .assessment-feedback-dialog").getByRole("combobox", { name: "Your assessment", exact: true }).click();
    await page.locator('.select-option[data-value=fail]').click();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebarGuard")).toBeVisible();
    const prior = await loadBoardState(context);
    await replaceEvidence(context, () => ({ records: [], importCoverage: prior.importCoverage }));
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect(page.locator("#requestContent")).toContainText("This interaction is not available");
    await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    assert.equal(await page.locator("#requestContent .assessment-feedback-dialog").count(), 0);
    assert.equal(await page.locator("body").evaluate((node, prompt) => node.textContent.includes(prompt), records[0].userPrompt.text), false);
    await copy.evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(await page.evaluate(() => window.sidebarCopies.length), 0, "Detached private getters cannot copy old evidence");
});

test("a delayed interaction read cannot repaint or focus its successor", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    let release, arrived, heldOnce = false;
    const pending = new Promise(resolve => { arrived = resolve; }), held = new Promise(resolve => { release = resolve; });
    const deliveries = [];
    await page.route("**/api/assessment/detail", route => {
        if (heldOnce) return route.continue();
        heldOnce = true;
        const delivered = (async () => {
            const response = await route.fetch();
            arrived(); await held;
            await route.fulfill({ response });
        })();
        deliveries.push(delivered);
        return delivered;
    });
    try {
        await page.locator("#resultsLink").click();
        await page.locator(".request-card-open").first().click();
        await pending;
        await page.locator(".request-card-open").nth(1).click();
        await expect(page.locator("#requestContent .interaction-insights[aria-busy=true]")).toHaveCount(0);
        const before = await page.locator("#requestContent").innerText();
        const focus = await page.evaluate(() => document.activeElement.id);
        release(); await Promise.all(deliveries);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        assert.equal(await page.locator("#requestContent").innerText(), before);
        assert.equal(await page.evaluate(() => document.activeElement.id), focus);
        await expect(page.locator(".request-original pre")).toContainText("checklist 1.");
    } finally { release(); await Promise.all(deliveries); }
});

test("shared Lucide and screen typography preserve Reports and Settings controls in both themes", { timeout: 45000 }, async t => {
    const { page } = await setup(t, { savedReport: true });
    if (proof) await mkdir(proof, { recursive: true });
    for (const [theme, width, scale] of [["light", 1440, 1], ["dark", 1440, 1], ["light", 375, 2], ["dark", 375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await navigateMain(page, "reports");
        const saved = page.locator("#bundleList .saved-report").first();
        if (await saved.getAttribute("open") === null) await saved.locator("summary").click();
        const downloads = page.locator("#bundleList .report-file-action button:visible");
        assert.ok(await downloads.count() >= 2);
        assert.ok((await downloads.evaluateAll(nodes => nodes.map(node => node.textContent.trim()))).every(text => text === ""));
        if (proof) await page.screenshot({ path: path.join(proof, `reports-library-${theme}-${width}-${scale}.png`), fullPage: true });
        await page.locator("#reportCreateLink").click();
        await page.locator("#reportList input[type=checkbox]").first().check();
        const prompt = page.locator("#reportList .full-text-preview").first();
        assert.deepEqual(await prompt.evaluate(node => [getComputedStyle(node).fontWeight, getComputedStyle(node).fontStyle]), ["400", "normal"]);
        if (proof) await page.screenshot({ path: path.join(proof, `reports-picker-${theme}-${width}-${scale}.png`), fullPage: true });
        await navigateMain(page, "settings");
        await navigateSettings(page, "connection");
        assert.equal(await page.locator("#settingsCategoryNav svg").count(), 0, "Settings category links need no ornamental icons");
        await expect(page.locator("#saveCollection")).toBeDisabled();
        await expect(page.locator("#cancelPreferences")).toBeDisabled();
        if (proof) await page.screenshot({ path: path.join(proof, `settings-${theme}-${width}-${scale}.png`), fullPage: true });
        const roles = await page.locator("svg.wire-icon:visible").evaluateAll(nodes => nodes.map(node => ({
            asset: node.dataset.lucideIcon, fill: getComputedStyle(node).fill, stroke: getComputedStyle(node).stroke,
            hidden: node.getAttribute("aria-hidden"), focusable: node.getAttribute("focusable"),
        })));
        assert.ok(roles.length > 0 && roles.every(role => role.asset && role.fill === "none" && role.stroke !== "none" && role.hidden === "true" && role.focusable === "false"));
        assert.equal(await page.locator('[data-fluent-icon],svg.fluent-icon').count(), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
});
