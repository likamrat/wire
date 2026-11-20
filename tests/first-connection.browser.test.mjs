import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { metadata174Schema } from "./copilot-metadata-fixture.mjs";
import { privateFixture, navigateMain, chooseTheme } from "./helpers.mjs";

const proofs = process.env.WIRE_FIRST_CONNECTION_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");

async function setup(t, { activity = true, records = [], storageBlocked = false, frontend, activityEvents } = {}) {
    const cleanup = [], { root, context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const home = path.join(root, "invented-copilot"), sessionRoot = path.join(home, "session-state");
    const id = randomUUID(), at = new Date().toISOString();
    await mkdir(path.join(sessionRoot, id), { recursive: true });
    const db = new DatabaseSync(path.join(home, "data.db"));
    db.exec(metadata174Schema);
    db.prepare("INSERT INTO sessions(id,title,session_type) VALUES(?,?,?)").run(id, "Cedar planning notes", "general_chat");
    const events = [
        { type: "session.start", data: { sessionId: id, version: 1 } },
        ...(activityEvents ?? (activity ? [
            { type: "user.message", data: { content: "Find the Cedar planning notes." } },
            { type: "tool.execution_start", data: { toolName: "workiq-fetch", toolCallId: id, arguments: { entityUrls: ["/me/messages"] } } },
            { type: "tool.execution_complete", data: { toolCallId: id, success: true } },
        ] : [])),
    ];
    await writeFile(path.join(sessionRoot, id, "events.jsonl"), events.map(event =>
        JSON.stringify({ id: randomUUID(), timestamp: at, ...event })).join("\n") + "\n");
    const previousHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = home;
    let access, runtime, browser;
    const errors = [], external = [], mutations = [], blocked = [];
    t.after(async () => {
        await browser?.close();
        await runtime?.close();
        await access?.close();
        db.close();
        if (previousHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousHome;
        for (const fn of cleanup.reverse()) await fn();
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        assert.deepEqual(blocked, []);
    });
    access = await createCopilotRuntimeAccess(context);
    runtime = await startServer(context, createExportController(context), {
        port: 0, access, frontend, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { blocked.push("provider"); throw new Error("Providers are excluded from onboarding proof."); },
            readSource: async () => { blocked.push("evaluation source"); throw new Error("Evaluation source reads are excluded."); },
        },
        githubProfile: { fetch: async () => { blocked.push("profile network"); throw new Error("Profile network is excluded."); } },
    });
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    const origin = new URL(runtime.url).origin;
    const writes = ["/api/collection/configure", "/api/collection/enabled", "/api/access/command"];
    page.on("request", request => {
        if (writes.includes(new URL(request.url()).pathname)) mutations.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
    await page.route(url => url.origin !== origin, route => { external.push(route.request().url()); return route.abort(); });
    if (storageBlocked) await page.addInitScript(() => {
        const get = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
            if (key === "workiq-evidence.connection-welcome.v1") throw new Error("Invented unavailable preference storage.");
            return get.call(this, key);
        };
    });
    return { page, context, runtime, mutations, access };
}

async function capture(page, name, fullPage = false) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage });
}

test("enforced React activity caps the home preview while keeping the full request, exact return and scoped report selection", { timeout: 90000 }, async t => {
    const prompt = "Compare the room booking with the invitation for the Willow workshop.\n\n> Monday: library\n> Wednesday: west stairs\n\nKeep both original dates. Do not send an invitation.";
    const longPath = "/me/drive/root:/Workshop materials/Willow session/Facilitator seating and accessibility instructions.docx:/content";
    const start = (id, tool, args) => ({ type: "tool.execution_start", data: { toolCallId: id, toolName: tool, arguments: args } });
    const end = (id, success, result) => ({ type: "tool.execution_complete", data: { toolCallId: id, success,
        ...(success ? { result } : { error: { code: "ToolUnavailable", message: "Synthetic tool unavailable." } }) } });
    const now = Date.now() - 60000;
    const activityEvents = [
        { type: "user.message", data: { content: prompt } },
        start("read", "workiq-fetch", { entityUrls: ["/me/calendarView", "/me/messages", "/me/people"] }),
        end("read", true, { structuredContent: { results: [{ statusCode: 200, path: "/me/calendarView" },
            { statusCode: 403, path: "/me/messages", errorCode: "AccessDenied" }] } }),
        start("lookup", "workiq-retrieve", { query: "Willow handover" }), end("lookup", false),
        start("document", "workiq-fetch", { entityUrls: [longPath] }), end("document", true, { structuredContent: { results: [{ statusCode: 200 }] } }),
        start("assistance", "workiq-ask", { question: "Compare the two notes." }), end("assistance", true, {}),
        { type: "assistant.message", data: { content: "The two sources name different rooms." } },
        { type: "user.message", data: { content: "When does the workshop start?" } },
        start("time", "workiq-fetch", { entityUrls: ["/me/calendarView"] }), end("time", true, {}),
    ].map((event, i) => ({ ...event, timestamp: new Date(now + i * 1000).toISOString() }));
    const { page, runtime, mutations } = await setup(t, { frontend: "react", activityEvents });
    await page.goto(runtime.url); await ready(page);
    await expect(page.locator("#welcomeReviewSource")).toBeVisible();
    await page.locator("#welcomeReviewSource").click(); await page.locator("#connectCollection").click();
    await expect(page.locator("#settingsMessage")).toHaveText("Source approved.");
    await navigateMain(page, "analyze"); await ready(page);
    assert.equal(mutations.filter(m => m.path === "/api/collection/configure").length, 1);
    await expect(page.locator("#activityList .request-row")).toHaveCount(2);
    const card = page.locator("#activityList .read-in-place").filter({ hasText: "Keep both original dates." });
    await expect(card.locator(".card-tool-name").first()).toContainText(/workiq-/);
    await expect(card).toContainText("Asked Copilot"); await expect(card).toContainText("Underlying services not recorded");
    await expect(card.locator(".card-quotation")).toHaveCount(0);
    await expect(page.locator("#activityView").getByText("Scope details", { exact: true })).toHaveCount(0);
    await expect(page.locator("#activityListSummary")).toContainText("2 interactions");
    const fail = card.getByRole("link", { name: "1 tool call failed" }), issue = card.getByRole("link", { name: /result: HTTP 403/i });
    await expect(fail).toBeVisible(); await expect(issue).toBeVisible();
    for (const [theme, width, scale] of [["light", 1440, 1], ["dark", 1440, 1], ["dark", 390, 1], ["light", 390, 2], ["light", 1024, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(n => { document.documentElement.style.fontSize = n * 100 + "%"; }, scale);
        await card.scrollIntoViewIfNeeded(); await capture(page, `bound-cards-${theme}-${width}`);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await issue.focus(); await page.keyboard.press("Enter");
        await expect(page.locator(".api-result-entry:focus")).toContainText("403");
        const exact = page.locator(".api-result-entry:focus"), batchHelp = exact.getByRole("button", { name: "About batch target" });
        await expect(batchHelp).toBeVisible();
        const box = await exact.evaluate(entry => {
            const outer = entry.getBoundingClientRect(), fact = entry.querySelector(".returned-target-help"), text = fact.firstElementChild;
            const first = entry.querySelector(".returned-call-parent").getBoundingClientRect(), help = fact.lastElementChild.getBoundingClientRect();
            return { inset: first.left - outer.left, end: outer.right-help.right, hit: help.height,
                leading: parseFloat(getComputedStyle(text).lineHeight) / parseFloat(getComputedStyle(text).fontSize),
                fits: text.getBoundingClientRect().right <= help.left };
        });
        assert.ok(box.inset >= 10 && box.end >= 10 && box.hit >= 44 && box.leading <= 1.65 && box.fits, JSON.stringify(box));
        await expect(page.locator('#requestContent [data-reader-section="activity"] .reader-call-row')).toHaveCount(4);
        await capture(page, `bound-reader-${theme}-${width}`);
        await page.waitForFunction(() => !document.getAnimations().some(a => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity));
        await batchHelp.focus(); await page.keyboard.press("Enter");
        await expect(page.getByRole("tooltip")).toContainText("position does not identify");
        if (width === 390 && scale === 2) await capture(page, "bound-returned-target-help-enlarged");
        await page.keyboard.press("Escape");
        const documentCall = page.locator('#requestContent [data-tool-call-id="document"]');
        await documentCall.locator(".reader-returned-facts > summary").click();
        await expect(documentCall.locator(".api-path-value")).toContainText("Willow session");
        await expect(documentCall.locator(".path-attribution").last()).toHaveText("Call target; no separate path returned.");
        await documentCall.locator(".api-path-value").scrollIntoViewIfNeeded();
        assert(await documentCall.locator(".api-result-entry").evaluate(n => n.scrollWidth <= n.clientWidth + 1));
        await capture(page, `bound-known-${theme}-${width}`);
        await page.locator("#closeContextSidebar").click(); await expect(issue).toBeFocused();
    }
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.evaluate(() => document.documentElement.style.fontSize = "");
    await fail.click(); await expect(page.locator(".reader-call-row:focus")).toContainText("workiq-retrieve");
    await page.locator(".reader-section-jumps").getByRole("button", { name: "Prompt" }).click();
    assert.equal(await page.locator("#selectedContext .full-text-content").textContent(), prompt);
    await page.locator("#closeContextSidebar").click(); await expect(fail).toBeFocused();
    await page.locator("#wireSearch").click();
    await page.locator("#wireSearch").fill("both original dates");
    await page.locator(".wire-search-hit").filter({ hasText: "both original dates" }).first().click();
    await expect(page.locator("#selectedContext .full-text-content")).toHaveText(prompt);
    await page.locator("#closeContextSidebar").click(); await expect(page.locator("#wireSearch")).toHaveValue("both original dates");
    await page.keyboard.press("Escape");
    await navigateMain(page, "reports");
    await page.locator('[data-report-preset="all"]').click();
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
    const picker = page.locator("#reportActivityOptions .read-in-place").filter({ hasText: "Keep both original dates" });
    await expect(picker.locator(".card-identities")).toContainText("People");
    const quote = picker.locator(".card-quotation");
    await quote.locator("summary").focus(); await page.keyboard.press("Enter");
    await expect(quote).toHaveAttribute("open", ""); await expect(quote).toContainText("> Wednesday: west stairs");
    const selected = await picker.locator("input[type=checkbox]").isChecked();
    await capture(page, "bound-picker");
    await picker.locator(".request-card-open").click(); await expect(page.locator("#selectedContext")).toContainText(prompt);
    await page.getByRole("button", { name: /Back to (activity|report setup)/ }).click();
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
    assert.equal(await picker.locator("input[type=checkbox]").isChecked(), selected);
    await page.evaluate(() => {
        const row = document.querySelector("#reportActivityOptions .read-in-place");
        window.heldCard = [row.querySelector(".request-card-open").firstChild, row.querySelector(".request-card-open").getAttributeNode("href")];
    });
    await page.locator("#reportActivityOptions").getByRole("button", { name: "Close", exact: true }).click();
    await navigateMain(page, "analyze");
    await expect(page.locator("#activityView details#coverage")).toHaveCount(0);
    await page.locator("#openEvidenceHelp").click();
    await page.getByRole("link", { name: "Open collection status", exact: true }).click(); await ready(page);
    await expect(page.locator("#collectionEvidenceDetails")).toContainText("Evidence scope");
    await expect(page.locator("#coverageBody")).toContainText("2 interactions");
    await page.locator("#wireAccountTrigger").click(); await page.locator("#wireAccountGate").click();
    await expect(page.locator("#accessShell")).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.heldCard.map(n => n.nodeValue)), ["", ""]);
});

test("fresh enforced entry dismisses once and reaches real retained activity through the existing source approval", { timeout: 60000 }, async t => {
    const { page, runtime, context, mutations } = await setup(t);
    await page.goto(runtime.url); await ready(page);
    await expect(page.locator("#firstConnectionWelcome")).toBeVisible();
    await expect(page.locator("#welcomeReviewSource")).toBeFocused();
    await expect(page.locator("#homeView")).toBeHidden();
    assert.equal((await runtime.collector.status()).config, null);
    assert.equal(mutations.length, 0);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator("#firstConnectionWelcomeDescription").evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        return [...range.getClientRects()].filter(rect => rect.width).length;
    }), 1, "The welcome sentence fits one desktop line without clipping or smaller type.");
    await capture(page, "welcome-desktop");
    await page.keyboard.press("Escape");
    await expect(page.locator("#firstConnectionReview")).toBeFocused();
    await expect(page.locator("#firstConnectionTitle")).toHaveText("Not connected");
    await page.reload(); await ready(page);
    await expect(page.locator("#firstConnectionWelcome")).toBeHidden();
    await page.locator("#firstConnectionReview").click();
    await expect(page.locator("#sourceEditor")).toBeVisible();
    await expect(page.locator("#sourceReviewSummary")).toBeVisible();
    await expect(page.locator("#sourcePathFields")).toBeHidden();
    await expect(page.locator("#firstCollectionWait")).toBeVisible();
    assert.equal(mutations.length, 0, "Opening review does not grant source permission.");
    await capture(page, "source-review-desktop", true);
    await page.setViewportSize({ width: 390, height: 844 });
    await chooseTheme(page, "dark");
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await capture(page, "source-review-narrow-dark", true);
    await page.evaluate(() => document.documentElement.style.fontSize = "");
    await page.setViewportSize({ width: 1280, height: 900 });
    await chooseTheme(page, "light");
    await page.locator("#cancelSource").click();
    await expect(page.locator("#firstConnectionReview")).toBeFocused();
    await page.locator("#firstConnectionReview").click();
    await page.locator("#changeReviewedPaths").click();
    await expect(page.locator("#sourceDatabase")).toBeFocused();
    const release = Promise.withResolvers(), dispatched = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/collection/configure", async route => { dispatched.resolve(); await release.promise; await route.continue(); });
    await page.locator("#connectCollection").click();
    await dispatched.promise;
    await expect(page.locator("#sourceChangeImpact")).toHaveText("Checking the source and starting collection...");
    assert.equal((await runtime.collector.status()).config, null);
    release.resolve();
    await expect(page.locator("#firstCollectionActivity")).toBeVisible();
    await expect(page.locator("#settingsMessage")).toHaveText("Source approved.");
    assert.equal(mutations.filter(row => row.path === "/api/collection/configure").length, 1);
    const stored = await loadBoardState(context), status = await runtime.collector.status();
    assert.ok(stored.evidence.length > 0, "The ordinary approved source writer committed activity.");
    assert.equal(status.config.windowDays, 30);
    assert.equal(status.config.pollSeconds, 5);
    assert.equal(buildAssessmentModel(stored).consent.state, "off");
    await page.locator("#firstCollectionActivity").click(); await ready(page);
    await expect(page.locator("#firstConnection")).toBeHidden();
    await expect(page.locator("#firstConnectionWelcome")).toBeHidden();
    await expect(page.locator("#activityList")).toContainText("Find the Cedar planning notes.");
    await capture(page, "first-activity");
    await navigateMain(page, "settings");
    await page.locator("#pauseCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("paused");
    await navigateMain(page, "analyze"); await ready(page);
    await page.reload(); await ready(page);
    await expect(page.locator("#firstConnectionWelcome")).toBeHidden();
    await expect(page.locator("#activityList")).toContainText("Find the Cedar planning notes.");
    await page.locator("#wireAccountTrigger").click();
    await page.locator("#wireAccountGate").click();
    await expect(page.locator("#accessShell")).toBeVisible();
    await expect(page.locator("#firstConnectionWelcome")).toBeHidden();
    await expect(page.locator("#firstConnection")).toBeHidden();
});

test("the footer opens the same help task as the Settings rail without collecting, including from the drawer", async t => {
    const { page, runtime, mutations } = await setup(t);
    await page.goto(runtime.url); await ready(page);
    await page.keyboard.press("Escape");
    await page.locator("#openEvidenceHelp").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#troubleshootingTitle")).toBeFocused();
    await expect(page.locator('[data-category="troubleshooting"]')).toHaveAttribute("aria-current", "page");
    await page.locator("#activityCountHelp summary").click();
    await expect(page.locator("#activityCountHelp p")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#firstConnection")).toBeVisible();
    await expect(page.locator("#openEvidenceHelp")).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#navigationToggle").click();
    await page.locator("#navigationDrawer #openEvidenceHelp").click();
    await expect(page.locator("#navigationDrawer")).toBeHidden();
    await expect(page.locator("#troubleshootingTitle")).toBeFocused();
    assert.equal(mutations.length, 0);
});

test("approved empty, pending and failed history stay distinct without replaying collection", { timeout: 45000 }, async t => {
    const { page, runtime, mutations } = await setup(t, { activity: false });
    await page.goto(runtime.url); await ready(page);
    await page.locator("#welcomeReviewSource").click();
    await expect(page.locator("#sourceEditor")).toBeVisible();
    await page.locator("#connectCollection").click();
    await expect(page.locator("#firstCollectionActivity")).toBeVisible();
    await page.locator("#firstCollectionActivity").click(); await ready(page);
    await expect(page.locator("#firstConnectionTitle")).toHaveText("No Work IQ activity found");
    let override = {};
    const alter = status => ({ ...status, ...override,
        ...(override.historyCoverage ? { historyCoverage: { ...status.historyCoverage, ...override.historyCoverage } } : {}) });
    // Keep the real enforced bindings while varying only the invented collector's presentation facts.
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), payload = await response.json();
        const status = alter(payload.collection);
        status.sourceAware = { ...payload.collection.sourceAware, github: {
            ...payload.collection.sourceAware.github, status: alter(payload.collection.sourceAware.github.status),
        } };
        await route.fulfill({ response, json: { ...payload, collection: status } });
    });
    for (const [status, title, copy] of [
        [{ historyCoverage: { pending: 1 } }, "Reading your Copilot history", "The first read may take a few minutes."],
        [{ state: "error", error: "The Copilot history folder could not be opened (EACCES)." }, "Collection cannot check history", "EACCES"],
        [{ historyCoverage: { affected: 1, unavailable: 1, readable: 0 } }, "History is incomplete", "history gaps"],
    ]) {
        override = status;
        await page.reload(); await ready(page);
        await expect(page.locator("#firstConnectionTitle")).toHaveText(title);
        await expect(page.locator("#firstConnectionMessage")).toContainText(copy);
        await expect(page.locator("#homeView")).toBeHidden();
        await expect(page.locator("#firstConnectionWelcome")).toBeHidden();
    }
    assert.equal(mutations.filter(row => row.path === "/api/collection/configure").length, 1);
    override = { historyCoverage: { pending: 1 } };
    for (const theme of ["light", "dark"]) {
        await page.reload(); await ready(page); await chooseTheme(page, theme);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        await capture(page, "waiting-" + theme + "-narrow");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await expect(page.locator("#firstConnectionStatus")).toBeVisible();
    }
});

test("unknown access, explicit Settings entry and unavailable preference storage do not launch or approve setup", { timeout: 30000 }, async t => {
    const { page, runtime, mutations } = await setup(t, { storageBlocked: true });
    const release = Promise.withResolvers(), started = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/access/watch", async route => { started.resolve(); await release.promise; await route.continue(); });
    await page.goto(runtime.url);
    await started.promise;
    await expect(page.locator("#firstConnectionWelcome")).toBeHidden();
    await expect(page.locator("#firstConnection")).toBeHidden();
    release.resolve();
    await ready(page);
    await expect(page.locator("#firstConnectionWelcome")).toBeHidden();
    await expect(page.locator("#firstConnectionStorageNotice")).toContainText("could not be read");
    await expect(page.locator("#firstConnectionReview")).toBeEnabled();
    await page.goto(runtime.url + "#settings?section=connection&setting=source"); await ready(page);
    await expect(page.locator("#sourceEditor")).toBeHidden();
    assert.equal(mutations.length, 0);
    await page.goto(runtime.url); await ready(page);
    await page.locator("#firstConnectionReview").click();
    await expect(page.locator("#sourceEditor")).toBeVisible();
    assert.equal(mutations.length, 0);
    await page.evaluate(() => {
        window.sourceReviewText = [];
        for (const id of ["reviewDatabase", "reviewSessions"]) {
            const walker = document.createTreeWalker(document.getElementById(id), NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) window.sourceReviewText.push(walker.currentNode);
        }
    });
    await page.locator("#wireAccountTrigger").click();
    await page.locator("#wireAccountGate").click();
    await expect(page.locator("#accessShell")).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.sourceReviewText.map(node => node.data)), ["", ""]);
});

test("an interrupted first approval stays in Settings for read-current recovery without a second approval", { timeout: 30000 }, async t => {
    const { page, runtime, mutations } = await setup(t);
    await page.goto(runtime.url); await ready(page);
    await page.locator("#welcomeReviewSource").click();
    await expect(page.locator("#sourceEditor")).toBeVisible();
    await page.route("**/api/collection/configure", async route => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort("connectionreset");
    });

    test("packaged source review keeps pre-write refusal editable; recorder status never offers a blocked write", { timeout: 30000 }, async t => {
        const { page, runtime, mutations } = await setup(t, { frontend: "react" });
        await page.goto(runtime.url); await ready(page);
        await page.locator("#welcomeReviewSource").click();
        await page.locator("#changeReviewedPaths").click();
        const database = page.locator("#sourceDatabase"), selected = await database.inputValue();
        await database.fill(path.join(path.dirname(selected), "absent", "data.db"));
        await page.locator("#connectCollection").click();
        await expect(page.locator("#settingsMessage")).toContainText("Settings were not saved.");
        await expect(page.locator("#reloadSettings")).toBeHidden();
        assert.equal((await runtime.collector.status()).config, null);
        await database.fill(selected);
        await page.locator("#connectCollection").click();
        await expect(page.locator("#firstCollectionActivity")).toBeVisible();
        assert.equal((await runtime.collector.status()).config.approved, true);
        assert.equal(mutations.filter(row => row.path === "/api/collection/configure").length, 2);
        await page.goto(runtime.url + "#collection-status?setting=network-diagnostic");
        await expect(page.locator("#recorderStatus")).toContainText("cannot start a network test");
        await expect(page.locator("#recordBtn")).toBeHidden();
    });
    await page.locator("#connectCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("unconfirmed");
    await expect(page.locator("#firstCollectionWait")).toBeHidden();
    assert.equal((await runtime.collector.status()).config.approved, true);
    await page.locator("#cancelSource").click();
    await expect(page.locator("#settingsView")).toBeVisible();
    await expect(page.locator("#firstConnectionWelcome")).toBeHidden();
    await expect(page.locator("#firstCollectionActivity")).toBeHidden();
    await page.locator("#reloadSettings").click();
    await expect(page.locator("#settingsMessage")).toContainText("earlier change unconfirmed");
    assert.equal(mutations.filter(row => row.path === "/api/collection/configure").length, 1);
});
