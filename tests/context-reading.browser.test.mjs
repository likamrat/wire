import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { assessmentSource } from "../lib/assessment-read-model.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { collectRecordedAnswerCandidates, commitRecordedAnswers } from "../lib/assessment-capture.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { fixture, privateFixture, restoreLegacySearch, chooseTheme } from "./helpers.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const proof = process.env.WIRE_CONTEXT_PROOFS;
const bodyText = "Here are three synthetic documents:\nResearch / Architecture / Design";

async function setup(t, { responses = true, missing = false, extraReplies = [] } = {}) {
    const source = retainedContextFixture();
    const records = source.records.slice(0, 2);
    // Kept as a fragment exactly as supplied to the existing authorized reader.
    records[1].userPrompt.status = "partial";
    if (missing) records[1].followUpPrompts = [{ sourceEventId: "not-retained", status: "unavailable",
        text: "EXCLUDED_UNAVAILABLE_TEXT", authorship: { actor: "unknown", basis: "missing-source" } }];
    else records[1].followUpPrompts = [];
    const unrelated = Array.from({ length: 9 }, (_, i) => {
        const record = fixture("unrelated-" + i);
        record.sourceSessionId = i === 0 ? records[0].sourceSessionId : "other-chat";
        record.userPrompt = { ...record.userPrompt, text: "UNRELATED_RECORD_" + i, sourceEventId: "unrelated-prompt-" + i, sourceTimestamp: "2026-10-01T12:00:00Z" };
        record.followUpPrompts = [];
        return record;
    });
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, [...records, ...unrelated]);
    let closeResources = async () => {};
    t.after(async () => {
        try { await closeResources(); }
        finally { for (const action of cleanup) await action(); }
    });
    const config = { schemaVersion: 1, approved: true, enabled: false, windowDays: 30, pollSeconds: 5,
        sourceAdapter: "copilot-app-sqlite-v156", appDbPath: path.join(context.dataDir, "invented-only.db"),
        sessionRoot: path.join(context.dataDir, "invented-only-events") };
    await mkdir(path.join(context.dataDir, "collector"), { recursive: true });
    await writeFile(path.join(context.dataDir, "collector", "config.json"), JSON.stringify(config));
    const sourceConfig = assessmentSource(await loadBoardState(context), config);
    if (responses) {
        await updateBoardState(context, state => {
            const personal = defaultPersonalEvaluation();
            personal.source = sourceConfig;
            personal.consent = { ...personal.consent, state: "enabled", revision: 1, categories: ["answer"],
                sourceConfigRef: sourceConfig.sourceConfigRef, sourceConfigRevision: sourceConfig.sourceConfigRevision,
                grantedAt: "2026-09-30T11:00:00.000Z", grantOrigin: "explicit-in-app-setup" };
            state.personalEvaluation = personal;
        });
        const candidates = collectRecordedAnswerCandidates(source.events, new Set(["reply-three"]), records[0].sourceSessionId);
        candidates.push(...extraReplies.map(reply => ({ sourceSessionId: records[0].sourceSessionId, ...reply })));
        assert.equal((await commitRecordedAnswers(context, candidates, { consentRevision: 1, source: sourceConfig })).captured, candidates.length);
    }
    let expected = await loadBoardState(context);
    const configBefore = await readFile(path.join(context.dataDir, "collector", "config.json"));
    let forbiddenSourceReads = 0;
    const runtime = await startServer(context, createExportController(context), { port: 0, frontend: "react", collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { forbiddenSourceReads++; throw Error("No provider work in context proof."); },
            readSource: async () => { forbiddenSourceReads++; throw Error("No source reads in context proof."); } } });
    closeResources = () => runtime.close();
    const browser = await chromium.launch();
    closeResources = async () => { await browser.close(); await runtime.close(); };
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(7000);
    const errors = [], denied = [], requests = [], payloadReads = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const updateStatus = url.pathname === "/api/app-update" && request.method() === "POST" && request.postDataJSON()?.action === "status";
        const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/assessment/evidence", "/api/evaluation/automatic/summary"];
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !updateStatus && !allowed.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        requests.push({ path: url.pathname, method: request.method(), body: request.postData() });
        if (url.pathname === "/api/assessment/evidence") payloadReads.push(request.postDataJSON());
        return route.continue();
    });
    await page.addInitScript(() => {
        window.contextClipboard = { writes: [], denied: false };
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw Error("Real clipboard reads are forbidden."); },
            async writeText(text) {
                if (window.contextClipboard.denied) throw new DOMException("Invented clipboard refusal", "NotAllowedError");
                window.contextClipboard.writes.push(text);
            },
        } });
    });
    closeResources = async () => {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.equal(forbiddenSourceReads, 0);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], expected[key], key);
            assert.deepEqual(await readFile(path.join(context.dataDir, "collector", "config.json")), configBefore);
            assert.doesNotMatch(JSON.stringify(requests), /Find five synthetic|Three synthetic documents|Here are three synthetic|Keep these spaces/);
    };
    return { page, runtime, records, context, payloadReads, requests, acceptFixtureChange: async () => { expected = await loadBoardState(context); } };
}

test("normal isolated source opens retained correction, retry and reply immediately; Analyze Back is exact", { timeout: 40000 }, async t => {
    const app = await setup(t), { page, runtime, records, payloadReads } = app;
    await page.goto(runtime.url + "#analyze"); await ready(page);
    assert.equal(payloadReads.length, 0, "Analyze never preloads retained response payloads");
    await restoreLegacySearch(page, "synthetic");
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
    const row = page.locator(`.request-row[data-view-key="request:${records[0].scenarioId}"]`);
    const open = row.locator(".request-card-open");
    await open.focus(); await frames(page);
    const origin = page.url(), position = await open.boundingBox();
    await page.keyboard.press("Enter"); await ready(page);
    await page.getByRole("button", { name: "Source details", exact: true }).click();
    await page.locator(".reader-linked-context > summary").click();
    await expect(page.locator(".interaction-response .full-text-content")).toHaveText(bodyText);
    const reader = page.locator("#requestContent"), linked = reader.locator(".reader-linked-context");
    const timeline = reader.locator(".request-context-timeline");
    await expect(timeline.locator(".reader-call-row")).toHaveCount(1);
    await expect(linked.locator(".reader-call-row")).toHaveAttribute("data-tool-call-id", "retry-lookup");
    for (const copy of await reader.getByRole("button", { name: /^Copy / }).all()) {
        const description = await copy.getAttribute("aria-describedby");
        await expect(page.locator(`[id="${description}"]`)).toHaveText("Copies original text, unmasked.");
    }
    assert.doesNotMatch(await reader.innerText(), /UNRELATED_RECORD|Separate synthetic topic|More unrelated synthetic/);
    assert.deepEqual(await reader.locator(".full-text-content").allTextContents(),
        [records[0].userPrompt.text, records[1].userPrompt.text, bodyText]);
    assert.deepEqual(await reader.locator("li[data-context-kind=action]").evaluateAll(nodes => nodes.map(node => node.dataset.toolCallId)),
        ["failed-lookup", "retry-lookup"]);
    await expect(page.locator("#selectedContext")).toHaveAttribute("data-context-group", records[0].scenarioId);
    const failed = timeline.locator('[data-tool-call-id="failed-lookup"]');
    await expect(failed).toContainText("Re-authentication required");
    await expect(failed).toContainText("This historical error does not establish the account's current sign-in state");
    assert.doesNotMatch(await failed.innerText(), /HTTP 401|HTTP 403|Sign in now/);
    for (const record of records) {
        const prompt = reader.locator(`[data-context-group="${record.scenarioId}"][data-context-kind=prompt]`);
        await expect(prompt.locator("[data-prompt-actor]").first()).toHaveAttribute("data-prompt-actor", promptAuthorship.read(record.userPrompt).actor);
    }
    await expect(linked).toContainText("not inferred task boundaries");
    await expect(failed.locator(".card-outcome-label")).toHaveText("1 tool call failed");
    await expect(linked.locator(".card-outcome-label")).toHaveText("1 tool call completed");
    assert.equal(payloadReads.length, 1, "Only the independently authorized linked answer was read");
    await expect(linked).toContainText("Partial text");
    const correction = linked.locator(`[data-context-group="${records[1].scenarioId}"][data-context-kind=prompt]`);
    const copy = correction.getByRole("button", { name: "Copy following message", exact: true });
    await copy.focus(); await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.contextClipboard.writes)).toEqual([records[1].userPrompt.text]);
    await page.evaluate(() => { window.contextClipboard.denied = true; });
    await copy.click();
    await expect(correction.locator("[role=alert]")).toContainText("Couldn't copy");
    await page.evaluate(() => { window.contextClipboard.denied = false; });
    const response = page.locator(".interaction-response").filter({ has: page.locator(".full-text-content") });
    await response.getByRole("button", { name: /^Copy following linked response$/i }).click();
    assert.deepEqual(await page.evaluate(() => window.contextClipboard.writes), [records[1].userPrompt.text, bodyText]);
    await linked.locator(":scope > summary").click();
    await expect(linked.locator(".full-text-content")).toHaveCount(0);
    await page.goBack(); await ready(page); await frames(page);
    assert.equal(page.url(), origin);
    await expect(page.locator("#activitySearch")).toHaveValue("synthetic");
    await expect(open).toBeFocused();
    assert.ok(Math.abs((await open.boundingBox()).y - position.y) < 3);
    await expect(reader.locator(".full-text-content")).toHaveCount(0);
    await open.click(); await ready(page);
    await linked.locator(":scope > summary").click();
    await expect(linked.locator(".interaction-response .full-text-content")).toHaveText(bodyText);
    for (const [width, scale, theme] of [[1280, 1, "dark"], [375, 2, "light"]]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${100 * scale}%`, scale);
        await frames(page);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await timeline.locator(".full-text-content,button").evaluateAll(nodes => nodes.filter(node => node.checkVisibility())
            .every(node => node.scrollWidth <= node.clientWidth + 1)), true);
        await linked.locator(":scope > summary").press("Enter");
        await expect(correction.locator(".full-text-content")).toHaveCount(0);
        await linked.locator(":scope > summary").press("Space");
        await expect(correction.locator(".full-text-content")).toHaveText(records[1].userPrompt.text);
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.evaluate(() => scrollTo(0, 0)); await frames(page);
            await page.screenshot({ path: path.join(proof, `context-${width}-${scale}x.png`), fullPage: true });
            const align = node => scrollTo(0, scrollY + node.getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().height - 16);
            await timeline.locator(":scope > li").first().evaluate(align);
            await page.screenshot({ path: path.join(proof, `context-${width}-${scale}x-messages.png`) });
            await response.evaluate(align);
            await page.screenshot({ path: path.join(proof, `context-${width}-${scale}x-response.png`) });
            await writeFile(path.join(proof, `context-${width}-${scale}x.txt`), await page.locator("#requestContent").ariaSnapshot());
        }
    }
});

test("deep retained-reply reading returns after authorized payloads settle without losing focus or disclosures", { timeout: 30000 }, async t => {
    const longText = Array.from({ length: 240 }, (_, index) => `LONG_RETAINED_LINE_${index}: invented release evidence and unresolved follow-up decisions.`).join("\n");
    const { page, runtime, records } = await setup(t, { extraReplies: [
        { sourceEventId: "long-answer", messageEventId: "three", at: "2026-09-30T12:00:10.000Z", text: longText },
    ] });
    await page.goto(runtime.url + "#analyze"); await ready(page);
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
    const a = page.locator(`.request-row[data-view-key="request:${records[1].scenarioId}"] .request-card-open`);
    const b = page.locator("#activityList article").filter({ hasText: "UNRELATED_RECORD" }).locator(".request-card-open").first();
    await a.click();
    const reply = page.locator(".interaction-response .full-text-content").filter({ hasText: "LONG_RETAINED_LINE_0:" });
    await expect(reply).toHaveText(longText);
    const technical = page.locator('#requestContent [data-tool-call-id="retry-lookup"] .reader-call-toggle');
    await technical.click();
    await reply.focus();
    await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop += 3500);
    const original = await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop);
    assert.ok(original > 3000, "The reading position requires the retained reply's actual height");
    await b.click();
    assert.doesNotMatch(await page.locator("body").textContent(), /LONG_RETAINED_LINE_0:/);
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    await page.route("**/api/assessment/evidence", route => {
        const delivery = (async () => {
            const response = await route.fetch();
            arrived(); await held;
            await route.fulfill({ response });
        })();
        deliveries.push(delivery);
        return delivery;
    });
    try {
        await a.click(); await pending;
        assert.equal(await reply.count(), 0, "Returning rereads current authorization; it does not keep a hidden response pane");
        release(); await Promise.all(deliveries);
        await expect(reply).toHaveText(longText);
        await expect.poll(async () => Math.abs(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop) - original)).toBeLessThan(3);
        await expect(reply).toBeFocused();
        await expect(technical).toHaveAttribute("aria-expanded", "true");
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.screenshot({ path: path.join(proof, "deep-retained-return.png") });
            await writeFile(path.join(proof, "deep-retained-return.json"), JSON.stringify({
                before: original, after: await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop),
                focus: await reply.evaluate(node => document.activeElement === node),
                disclosureOpen: await technical.getAttribute("open") !== null,
            }, null, 2));
        }
    } finally { release(); await Promise.all(deliveries); }
});

for (const ending of ["complete", "replacement", "revocation", "visibility"]) test(`authorized reply and footer exit paint ends safely on ${ending}`, { timeout: 30000 }, async t => {
    const app = await setup(t), { page, runtime, records, context } = app;
    await page.goto(runtime.url); await ready(page);
    await page.locator("#activityPager").getByRole("button", { name: "Next" }).click();
    await page.locator(`.request-row[data-view-key="request:${records[1].scenarioId}"] .request-card-open`).click();
    const reply = page.locator(".interaction-response .full-text-content").filter({ hasText: "Here are three synthetic documents:" });
    await expect(reply).toHaveText(bodyText);
    await expect(page.locator("#requestContent .interaction-insights[aria-busy=true]")).toHaveCount(0);
    const copy = await page.locator('[data-reader-section="response"]').getByRole("button", { name: "Copy response", exact: true }).elementHandle();
    const before = await page.locator("#requestContent").textContent();
    const footer = await page.locator("#contextSidebarFooter").textContent();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].pause());
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.inert), true, "Exiting paint cannot accept another action");
    const samples = [];
    for (const time of [0, 60, 120, 179]) {
        await page.locator("#contextSidebar").evaluate((node, time) => node.getAnimations()[0].currentTime = time, time);
        await frames(page);
        assert.equal(await page.locator("#requestContent").textContent(), before, "Authorized content stays mounted until ordinary exit ends");
        assert.equal(await page.locator("#contextSidebarFooter").textContent(), footer, "Fixed action paint travels with the body");
        await expect(reply).toHaveText(bodyText);
        const sample = await page.evaluate(() => {
            const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
            return { header: box(".context-sidebar-header"), body: box("#contextSidebarBody"), footer: box("#contextSidebarFooter") };
        });
        assert.equal(sample.header.x, sample.body.x);
        assert.equal(sample.body.x, sample.footer.x);
        samples.push({ time, ...sample });
    }
    if (ending === "replacement") {
        await page.locator("#activityList article").filter({ hasText: "UNRELATED_RECORD" }).locator(".request-card-open").first().click();
        await expect(page.locator(".request-original .full-text-content")).toContainText("UNRELATED_RECORD");
        await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
        await frames(page);
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await expect(page.locator(".request-original .full-text-content")).toContainText("UNRELATED_RECORD");
        assert.equal(await page.locator("#contextSidebar").evaluate(node => node.inert), false);
    } else if (ending === "revocation") {
        await updateBoardState(context, state => {
            state.personalEvaluation.consent = { ...state.personalEvaluation.consent, state: "revoked", revision: 2,
                categories: [], revokedAt: "2026-10-01T12:00:00.000Z" };
        });
        await app.acceptFixtureChange();
        await page.evaluate(() => dispatchEvent(new Event("online")));
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    } else if (ending === "visibility") {
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    } else {
        await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].finish());
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    }
    assert.ok(!(await page.locator("body").textContent()).includes(bodyText), "No stale or hidden reply pane remains");
    await copy.evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.deepEqual(await page.evaluate(() => window.contextClipboard.writes), [], "Detached private Copy cannot recover old payload");
    if (proof) {
        await mkdir(proof, { recursive: true });
        await writeFile(path.join(proof, `authorized-exit-${ending}.json`), JSON.stringify(samples, null, 2));
    }
});

test("a retained-reply read completing during an ordinary exit cannot repaint the inert pane", { timeout: 20000 }, async t => {
    const { page, runtime, records } = await setup(t);
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    await page.route("**/api/assessment/evidence", route => {
        const delivery = (async () => {
            const response = await route.fetch();
            arrived(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    });
    try {
        await page.goto(runtime.url + "#request?request=" + records[1].scenarioId); await ready(page); await pending;
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].pause());
        const before = await page.locator("#requestContent").textContent();
        release(); await Promise.all(deliveries); await frames(page);
        assert.equal(await page.locator("#requestContent").textContent(), before);
        assert.ok(!(await page.locator("body").textContent()).includes(bodyText));
        await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].finish());
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        assert.equal(await page.locator("#requestContent").textContent(), "");
    } finally { release(); await Promise.all(deliveries); }
});

for (const interruption of ["reading", "switch", "revocation"]) test(`pending retained-reading restoration yields to ${interruption}`, { timeout: 30000 }, async t => {
    const text = "DEFERRED_READING_REPLY\n" + "Invented saved evidence with deliberate long reading content.\n".repeat(180);
    const app = await setup(t, { extraReplies: [
        { sourceEventId: "deferred-answer", messageEventId: "three", at: "2026-09-30T12:00:10.000Z", text },
    ] });
    const { page, runtime, records, context } = app;
    await page.goto(runtime.url + "#analyze"); await ready(page);
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
    const a = page.locator(`.request-row[data-view-key="request:${records[1].scenarioId}"] .request-card-open`);
    const b = page.locator("#activityList article").filter({ hasText: "UNRELATED_RECORD" }).locator(".request-card-open").first();
    await a.click();
    const reply = page.locator(".interaction-response .full-text-content").filter({ hasText: "DEFERRED_READING_REPLY" });
    await expect(reply).toHaveText(text);
    await reply.focus();
    await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop += 3000);
    const original = await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop);
    await b.click();
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    await page.route("**/api/assessment/evidence", route => {
        const delivery = (async () => {
            const response = await route.fetch();
            arrived(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    });
    try {
        await a.click(); await pending;
        if (interruption === "reading") {
            await page.locator(".reader-section-jumps").getByRole("button", { name: "Prompt", exact: true }).focus();
            await page.keyboard.press("Control+Home");
            await expect.poll(() => page.locator("#contextSidebarBody").evaluate(node => node.scrollTop)).toBe(0);
        } else if (interruption === "switch") await b.click();
        else {
            await updateBoardState(context, state => {
                state.personalEvaluation.consent = { ...state.personalEvaluation.consent, state: "revoked", revision: 2,
                    categories: [], revokedAt: "2026-10-01T12:00:00.000Z" };
            });
            await app.acceptFixtureChange();
            await page.evaluate(() => dispatchEvent(new Event("online")));
            await expect(page.locator("#unavailableCall")).toContainText("The matching evidence changed");
            await ready(page);
        }
        const current = await page.evaluate(() => ({ focus: document.activeElement.id, route: location.hash, page: scrollY }));
        release(); await Promise.all(deliveries); await frames(page);
        assert.equal(await page.evaluate(() => location.hash), current.route);
        assert.equal(await page.evaluate(() => document.activeElement.id), current.focus);
        assert.equal(await page.evaluate(() => scrollY), current.page);
        if (interruption === "reading") {
            await expect(reply).toHaveText(text);
            assert.equal(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop), 0, "Late reads cannot undo new reading intent");
        } else {
            assert.doesNotMatch(await page.locator("body").textContent(), /DEFERRED_READING_REPLY/);
            if (interruption === "switch") {
                await a.click();
                await expect(reply).toHaveText(text);
                await expect.poll(async () => Math.abs(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop) - original)).toBeLessThan(3);
            }
        }
    } finally { release(); await Promise.all(deliveries); }
});

test("leaving before the shared reader is ready never starts an eager hidden payload read", { timeout: 20000 }, async t => {
    const { page, runtime, records, payloadReads } = await setup(t);
    const held = Promise.withResolvers(), intercepted = Promise.withResolvers();
    const delivered = page.waitForResponse(response => response.url().endsWith("/assets/assessment-contract.mjs"));
    await page.route("**/assets/assessment-contract.mjs", async route => {
        const response = await route.fetch();
        intercepted.resolve(); await held.promise;
        await route.fulfill({ response });
    });
    try {
        await page.goto(runtime.url + "#request?request=" + records[1].scenarioId); await ready(page);
        await intercepted.promise;
        await page.locator('nav [data-nav="analyze"]').click(); await ready(page);
        await expect(page.locator("#contextSidebar")).not.toBeVisible();
    } finally { held.resolve(); }
    await (await delivered).finished(); await frames(page);
    assert.equal(payloadReads.length, 0);
    await expect(page.locator(".interaction-response .full-text-content")).toHaveCount(0);
});

test("each adjacent reply is independently authorized and multiple retained responses keep their real time and completeness", { timeout: 20000 }, async t => {
    const app = await setup(t, { extraReplies: [
        { sourceEventId: "old-answer", messageEventId: "five", at: "2026-09-30T12:00:03.000Z", text: "INACCESSIBLE_NEIGHBOR_RESPONSE" },
        { sourceEventId: "untimed-answer", messageEventId: "three", at: "2026-09-30T12:00:09.000Z", text: "Exact retained response fragment.\r\n  unchanged  " },
    ] });
    const { page, context, records, runtime, payloadReads } = app;
    let excludedRef;
    await updateBoardState(context, state => {
        const old = state.personalEvaluation.captures.find(capture => capture.observation.occurredAt === "2026-09-30T12:00:03.000Z");
        old.observation.captureContext.sourceConfigRevision++;
        excludedRef = old.observation.observationRef;
        const untimed = state.personalEvaluation.captures.find(capture => capture.observation.occurredAt === "2026-09-30T12:00:09.000Z");
        untimed.observation.occurredAt = null;
        untimed.observation.payload.completeness = "bounded-fragment";
    });
    await app.acceptFixtureChange();
    await page.goto(runtime.url + "#request?request=" + records[1].scenarioId); await ready(page);
    await expect(page.locator(".interaction-response .full-text-content")).toHaveCount(2);
    assert.equal(payloadReads.some(input => input.observationRef === excludedRef), false);
    const responses = page.locator('[data-context-kind="response"]');
    await expect(responses.first().locator("time")).toHaveAttribute("datetime", "2026-09-30T12:00:07.000Z");
    await expect(responses.last().locator("time")).toHaveCount(0);
    await expect(responses.last()).toContainText("Partial text");
    assert.deepEqual(await responses.locator(".full-text-content").allTextContents(),
        [bodyText, "Exact retained response fragment.\r\n  unchanged  "]);
    assert.doesNotMatch(await page.locator("#requestContent").innerText(), /INACCESSIBLE_NEIGHBOR_RESPONSE/);
});

test("off capture, missing retained text and unmatched same-chat records remain explicit without payload reads", { timeout: 20000 }, async t => {
    const { page, runtime, records, payloadReads } = await setup(t, { responses: false, missing: true });
    await page.goto(runtime.url + "#request?request=" + records[1].scenarioId); await ready(page);
    await expect(page.locator(".interaction-response:visible")).toHaveCount(1);
    await expect(page.locator(".interaction-response:visible")).toContainText("No assistant reply was saved");
    const linked = page.locator(".reader-linked-context");
    await page.getByRole("button", { name: "Source details" }).click();
    await linked.locator("summary").click();
    await expect(linked).toContainText("Prompt text unavailable");
    assert.doesNotMatch(await page.locator("#requestContent").innerText(), /EXCLUDED_UNAVAILABLE_TEXT|UNRELATED_RECORD/);
    assert.equal(payloadReads.length, 0);
});

test("reconnect rejects an already authorized reply delivered after consent revocation without replaying a source check", { timeout: 20000 }, async t => {
    const app = await setup(t), { page, runtime, records, context } = app;
    let sourceChecks = 0;
    await page.route("**/api/collection/now", async route => {
        sourceChecks++;
        await route.abort();
    });
    const held = Promise.withResolvers(), admitted = Promise.withResolvers();
    t.after(held.resolve);
    await page.route("**/api/assessment/evidence", async route => {
        const response = await route.fetch();
        assert.equal((await response.json()).basis.consentRevision, 1);
        admitted.resolve();
        await held.promise;
        await route.fulfill({ response });
    });
    await page.goto(runtime.url + "#request?request=" + records[1].scenarioId); await ready(page);
    await admitted.promise;
    await updateBoardState(context, state => {
        state.personalEvaluation.consent = { ...state.personalEvaluation.consent, state: "revoked", revision: 2,
            categories: [], revokedAt: "2026-10-01T12:00:00.000Z" };
    });
    await app.acceptFixtureChange();
    const revoked = await loadBoardState(context);
    const revokedSnapshot = page.waitForResponse(async response => {
        if (!response.ok() || !response.url().endsWith("/api/snapshot")) return false;
        const snapshot = await response.json();
        return snapshot.revision === revoked.revision
            && snapshot.assessment?.basis.consentRevision === revoked.personalEvaluation.consent.revision;
    });
    const readerUrl = page.url(), readerDocument = await page.evaluateHandle(() => document);
    let releaseSnapshot, sawSnapshot;
    const snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
    const snapshotStarted = new Promise(resolve => { sawSnapshot = resolve; });
    t.after(() => releaseSnapshot());
    await page.route("**/api/snapshot", async route => {
        sawSnapshot();
        await snapshotGate;
        await route.continue();
    }, { times: 1 });
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await snapshotStarted;
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#requestView")).toBeVisible();
    assert.equal(page.url(), readerUrl);
    assert.equal(await readerDocument.evaluate(node => node === document), true, "Reconnect stays in the same reader document");
    releaseSnapshot();
    await (await revokedSnapshot).finished();
    await ready(page);
    await expect(page.locator("#promptAuthorSummary")).toHaveAttribute("data-revision", String(revoked.revision));
    const revokedResponse = page.locator("#requestContent > .interaction-response");
    await expect(revokedResponse).toContainText("No assistant reply was saved");
    await expect(page.locator(".interaction-response .full-text-content")).toHaveCount(0);
    const staleResponse = page.waitForResponse(response => response.url().endsWith("/api/assessment/evidence"));
    held.resolve();
    const deliveredStale = await staleResponse;
    await deliveredStale.finished();
    assert.equal(deliveredStale.status(), 200);
    assert.equal((await deliveredStale.json()).basis.consentRevision, 1, "The real pre-revocation response arrives after revision 2 was applied");
    await frames(page);
    assert.equal(page.url(), readerUrl);
    assert.equal(await readerDocument.evaluate(node => node === document), true, "Late evidence is rejected without navigating away");
    await expect(page.locator(".interaction-response .full-text-content")).toHaveCount(0);
    await page.unroute("**/api/assessment/evidence");
    const reads = app.payloadReads.length;
    await page.reload(); await ready(page);
    await expect(revokedResponse).toContainText("No assistant reply was saved");
    assert.equal(app.payloadReads.length, reads, "Revoked payloads aren't fetched on reopening");
    assert.equal(sourceChecks, 0, "Reconnect, the late answer and reload never dispatch or replay a source check");
});
