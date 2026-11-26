import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createCopilotRuntimeAccess } from "../../lib/runtime-access.mjs";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { buildAssessmentModel } from "../../lib/assessment-read-model.mjs";
import { metadata174Schema } from "../collection/copilot-metadata-fixture.mjs";
import { createProfileSource, profilePNG } from "../collection/source-profile-fixture.mjs";
import { privateFixture, navigateMain, navigateSettings, chooseTheme, openSourceEditor } from "../support/helpers.mjs";
import { prepareLandingReport } from "../reports/report-journey-helpers.mjs";

const proofs = process.env.WIRE_FIRST_CONNECTION_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");

async function setup(t, { activity = true, records = [], storageBlocked = false, frontend, activityEvents, profile = false } = {}) {
    const cleanup = [], { root, context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const home = path.join(root, "invented-copilot"), sessionRoot = path.join(home, "session-state");
    const id = randomUUID(), at = new Date().toISOString();
    await mkdir(path.join(sessionRoot, id), { recursive: true });
    const db = profile ? (await createProfileSource(home)).db : new DatabaseSync(path.join(home, "data.db"));
    if (!profile) db.exec(metadata174Schema);
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
        githubProfile: { fetch: async () => { if (profile) return new Response(profilePNG, { headers: { "content-type": "image/png" } });
            blocked.push("profile network"); throw new Error("Profile network is excluded."); } },
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
    return { page, context, runtime, mutations, access, home, sessionId: id, sessionRoot };
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
        start("read", "workiq-fetch", { entityUrls: ["/me/messages"] }),
        end("read", true, { structuredContent: { results: [{ statusCode: 200, path: "/me/calendarView" },
            { statusCode: 403, errorCode: "AccessDenied" }] } }),
        start("lookup", "workiq-retrieve", { query: "Willow handover" }), end("lookup", false),
        start("document", "workiq-fetch", { entityUrls: [longPath] }), end("document", true, { structuredContent: { results: [{ statusCode: 200 }] } }),
        start("assistance", "workiq-ask", { question: "Compare the two notes." }), end("assistance", true, {}),
        { type: "assistant.message", data: { content: "The two sources name different rooms." } },
        { type: "user.message", data: { content: "When does the workshop start?" } },
        start("time", "workiq-fetch", { entityUrls: ["/me/calendarView"] }), end("time", true, {}),
    ].map((event, i) => ({ ...event, timestamp: new Date(now + i * 1000).toISOString() }));
    const { page, runtime, mutations } = await setup(t, { frontend: "react", activityEvents });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        async writeText(value) { window.fixturePromptCopy = value; },
    } }));
    await page.goto(runtime.url); await ready(page);
    await expect(page.locator("#welcomeReviewSource")).toBeVisible();
    await page.locator("#welcomeReviewSource").click(); await page.locator("#connectCollection").click();
    await expect(page.locator("#settingsMessage")).toHaveText("Source approved.");
    await navigateMain(page, "analyze"); await ready(page);
    assert.equal(mutations.filter(m => m.path === "/api/collection/configure").length, 1);
    await expect(page.locator("#activityList .request-row")).toHaveCount(2);
    const card = page.locator("#activityList .read-in-place").filter({ hasText: "Keep both original dates." });
    await expect(card.locator(".card-tool-name").first()).toContainText(/workiq-/);
    await expect(card.locator(".card-identity-field").filter({hasText:"Operation"}).getByText("Asked Copilot", {exact:true})).toBeVisible();
    await expect(card.locator(".card-quotation")).toHaveCount(0);
    await expect(page.locator("#activityView").getByText("Scope details", { exact: true })).toHaveCount(0);
    await expect(page.locator("#activityListSummary")).toContainText("2 interactions");
    const fail = card.getByRole("link", { name: "1 tool call failed" }), issue = card.getByRole("link", { name: /returned entry 2 · HTTP 403/i });
    await expect(fail).toBeVisible(); await expect(issue).toBeVisible();
    for (const [theme, width, scale] of [["light", 1440, 1], ["dark", 1440, 1], ["dark", 390, 1], ["light", 390, 2], ["light", 1024, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(n => { document.documentElement.style.fontSize = n * 100 + "%"; }, scale);
        await card.scrollIntoViewIfNeeded(); await capture(page, `bound-cards-${theme}-${width}`);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await issue.focus(); await page.keyboard.press("Enter");
        await expect(page.locator(".api-result-entry:focus")).toContainText("403");
        const exact = page.locator(".api-result-entry:focus"), batchHelp = exact.getByRole("button", { name: "About batch target" });
        const known = page.locator('#requestContent [data-tool-call-id="read"] .api-result-entry').first();
        await expect(known).toContainText("Calendar");
        await expect(known).toContainText("/me/calendarView");
        await expect(batchHelp).toBeVisible();
        const box = await exact.evaluate(entry => {
            const outer = entry.getBoundingClientRect(), fact = entry.querySelector(".returned-target-help"), text = fact.firstElementChild;
            const first = entry.querySelector(".returned-call-parent").getBoundingClientRect(), help = fact.querySelector("button").getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(fact.querySelector(".metadata-tail-text"));
            return { inset: first.left - outer.left, end: outer.right-help.right, hit: help.height,
                leading: parseFloat(getComputedStyle(text).lineHeight) / parseFloat(getComputedStyle(text).fontSize),
                fits: range.getBoundingClientRect().right <= help.left };
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
    const reading = page.locator("#selectedContext .full-text-content");
    const paragraphs = ["Compare the room booking with the invitation for the Willow workshop.",
        "Monday: library Wednesday: west stairs", "Keep both original dates. Do not send an invitation."];
    await expect(reading.locator("p")).toHaveText(paragraphs, { useInnerText: true });
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixturePromptCopy), prompt);
    await page.locator("#closeContextSidebar").click(); await expect(fail).toBeFocused();
    await page.locator("#wireSearch").click();
    await page.locator("#wireSearch").fill("both original dates");
    await page.locator(".wire-search-hit").filter({ hasText: "both original dates" }).first().click();
    await expect(reading.locator("p")).toHaveText(paragraphs, { useInnerText: true });
    await page.locator("#closeContextSidebar").click(); await expect(page.locator("#wireSearch")).toHaveValue("both original dates");
    await page.keyboard.press("Escape");
    await navigateMain(page, "reports");
    await prepareLandingReport(page, "all");
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
    const picker = page.locator("#reportActivityOptions .read-in-place").filter({ hasText: "Keep both original dates" });
    await expect(picker.locator(".card-identities")).toContainText("Mail");
    await expect(picker.locator(".card-identities")).not.toContainText("Calendar");
    await expect(picker.locator(".request-card-prompt")).toHaveText(paragraphs.join(" "), { useInnerText: true });
    const selected = await picker.locator("input[type=checkbox]").isChecked();
    await capture(page, "bound-picker");
    await picker.locator(".request-card-open").click(); await expect(reading.locator("p")).toHaveText(paragraphs, { useInnerText: true });
    await page.getByRole("button", { name: /Back to (activity|report setup)/ }).click();
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
    assert.equal(await picker.locator("input[type=checkbox]").isChecked(), selected);
    await page.evaluate(() => {
        const row = document.querySelector("#reportActivityOptions .read-in-place");
        window.heldCard = [document.createTreeWalker(row.querySelector(".request-card-open"), NodeFilter.SHOW_TEXT).nextNode(),
            row.querySelector(".request-card-open").getAttributeNode("href")];
    });
    await page.locator("#reportActivityOptions").getByRole("button", { name: "Close", exact: true }).click();
    await navigateMain(page, "analyze");
    await expect(page.locator("#activityView details#coverage")).toHaveCount(0);
    await navigateMain(page, "settings");
    await navigateSettings(page, "connection");
    await page.getByRole("link", { name: "View collection status", exact: true }).click(); await ready(page);
    await expect(page.locator("#collectionEvidenceDetails")).toContainText("Evidence scope");
    await expect(page.locator("#coverageBody")).toContainText("2 interactions");
    await page.locator("#wireAccountTrigger").click(); await page.locator("#wireAccountGate").click();
    await expect(page.locator("#accessShell")).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.heldCard.map(n => n.nodeValue)), ["", ""]);
});

test("fresh enforced entry dismisses once and reaches real retained activity through the existing source approval", { timeout: 60000 }, async t => {
    const { page, runtime, context, mutations } = await setup(t, { frontend: "react" });
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
    await navigateSettings(page, "connection");
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

test("footer Help opens the one help destination without collecting and returns focus on Back", async t => {
    const { page, runtime, mutations } = await setup(t);
    await page.goto(runtime.url); await ready(page);
    await page.keyboard.press("Escape");
    await page.locator("#openEvidenceHelp").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#pageTitle")).toBeFocused();
    await expect(page.locator("#openEvidenceHelp")).toHaveAttribute("aria-current", "page");
    await page.locator('[data-help-topic="counts"]').click();
    await expect(page.locator("#help-counts")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#help-reports")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#firstConnection")).toBeVisible();
    await expect(page.locator("#openEvidenceHelp")).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#navigationToggle").click();
    await page.locator("#navigationDrawer #openEvidenceHelp").click();
    await expect(page.locator("#navigationDrawer")).toBeHidden();
    await expect(page.locator("#pageTitle")).toHaveText("WIRE Help");
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

// One invented chat the Copilot app's own records can count: two model rounds, 11,400 tokens in all.
async function tokenRecordChat(t) {
    const text = "Summarize the invented launch notes.", base = Date.now() - 120000;
    const exchange = (prompt, turns, start, callId) => [
        { type: "user.message", data: { content: prompt, delivery: "idle" } },
        { type: "assistant.turn_start", data: { turnId: turns[0] } },
        { type: "assistant.message", data: { turnId: turns[0], toolRequests: [{ toolCallId: callId }] } },
        { type: "tool.execution_start", data: { toolCallId: callId, toolName: "workiq-fetch", arguments: { entityUrls: ["/me/messages"] } } },
        { type: "tool.execution_complete", data: { toolCallId: callId, success: true, result: { content: "INVENTED" } } },
        { type: "assistant.turn_end", data: { turnId: turns[0] } },
        { type: "assistant.turn_start", data: { turnId: turns[1] } },
        { type: "assistant.message", data: { turnId: turns[1], content: "Invented answer", toolRequests: [] } },
        { type: "assistant.turn_end", data: { turnId: turns[1] } },
    ].map((event, n) => ({ ...event, timestamp: new Date(base + start + n * 1000).toISOString() }));
    const activityEvents = exchange(text, ["a", "b"], 0, "indexed-fetch");
    const fixture = await setup(t, { frontend: "react", activityEvents, profile: true });
    const { page, home, sessionId, sessionRoot } = fixture;
    const indexed = write => { const index = new DatabaseSync(path.join(home, "session-store.db")); try { write(index); } finally { index.close(); } };
    const reply = (events, turn) => new Date(Date.parse(events.find(e => e.data.turnId === turn && e.type === "assistant.message").timestamp) + 4).toISOString();
    const usage = (index, turn, ...row) => index.prepare("INSERT INTO assistant_usage_events (session_id,turn_index,agent_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at) VALUES (?,?,NULL,'gpt-4.1',?,?,?,?,?)").run(sessionId, turn, ...row);
    indexed(index => {
        index.exec(`CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT);
            CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, agent_id TEXT, model TEXT,
                input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT);`);
        index.prepare("INSERT INTO turns VALUES (?,0,?,?)").run(sessionId, text, "Invented answer");
        usage(index, 0, 5000, 100, 4000, 500, reply(activityEvents, "a"));
        usage(index, 0, 6000, 300, 5500, 400, reply(activityEvents, "b"));
    });
    const journal = path.join(sessionRoot, sessionId, "events.jsonl");
    const later = async ms => appendFile(journal, JSON.stringify({ id: randomUUID(),
        timestamp: new Date(base + ms).toISOString(), type: "session.info", data: { infoType: "note", message: "invented" } }) + "\n");
    const refresh = async () => {
        await navigateMain(page, "analyze"); await ready(page);
        const collected = page.waitForResponse(r => new URL(r.url()).pathname === "/api/collection/now");
        await page.locator("#analyzeRefresh").click(); await collected; await ready(page);
    };
    // Refresh, wait for the card's own value, then read the reader: card links go stale mid-refresh.
    const tokens = async card => {
        await refresh();
        const field = page.locator("#activityList").getByRole("link", { name: /^Model tokens:/ });
        await expect(field).toHaveText(card);
        await field.click();
        const reading = page.getByRole("dialog", { name: "Interaction" }).getByRole("region", { name: "Token usage" });
        await expect(reading).toBeVisible();
        const shown = (await reading.innerText()).replace(/\s+/g, " ");
        await page.locator("#closeContextSidebar").click();
        return shown;
    };
    return { ...fixture, text, base, exchange, activityEvents, indexed, reply, usage, journal, later, refresh, tokens };
}

test("Copilot's token records stay unread until turned on in source review; turning them off stops the reads and keeps counted totals", { timeout: 90000 }, async t => {
    const { page, runtime, mutations, home, indexed, usage, reply, later, tokens, activityEvents } = await tokenRecordChat(t);
    const swtch = page.getByRole("switch", { name: "Read Copilot's token records" }), configures = () => mutations.filter(m => m.path === "/api/collection/configure");
    await page.goto(runtime.url); await ready(page);
    await page.locator("#welcomeReviewSource").click();
    await expect(swtch).not.toBeChecked();
    await expect(page.locator("#approvalScope")).not.toContainText("token records");
    const recordsFile = path.join(home, "session-store.db");
    await expect(page.locator("#sourceUsageRecordsFile")).toHaveText(`Reads ${recordsFile}`);
    await expect(page.locator("#sourceUsageRecordsHelp")).toContainText("reads the prompt text only to match calls to prompts and doesn't save it");
    for (const theme of ["light", "dark"]) { await chooseTheme(page, theme); await page.locator("#sourceUsageRecordsRow").scrollIntoViewIfNeeded(); await capture(page, `token-records-off-${theme}`); }
    await page.locator("#connectCollection").click();
    await expect(page.locator("#settingsMessage")).toHaveText("Source approved.");
    assert.equal(Object.hasOwn(configures()[0].body, "usageRecords"), false, "First approval leaves token records out");
    const unread = await tokens("Unavailable");
    assert.doesNotMatch(unread, /11,400|Counted from/);

    await navigateMain(page, "settings"); await openSourceEditor(page);
    await swtch.focus(); await page.keyboard.press("Space");
    await expect(swtch).toBeChecked();
    await expect(page.locator("#approvalScope")).toContainText("including Copilot's token records");
    await expect(page.locator("#connectCollection")).toHaveText("Approve token records");
    const database = page.locator("#sourceDatabase"), approvedPath = await database.inputValue();
    await database.fill(path.join(home, "other", "data.db"));
    await expect(swtch).not.toBeChecked();
    await expect(page.locator("#sourceUsageRecordsFile")).toHaveText(`Reads ${path.join(home, "other", "session-store.db")}`);
    await database.fill(approvedPath); await swtch.check();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme); await page.locator("#sourceSessions").focus(); await page.keyboard.press("Tab");
        await expect(swtch).toBeFocused();
        assert.equal(await page.locator("#sourceUsageRecordsRow .switch-track").evaluate(n => getComputedStyle(n).outlineStyle), "solid", "Keyboard focus paints the switch ring");
        await capture(page, `token-records-on-focus-${theme}`);
    }
    await page.locator("#connectCollection").click();
    await expect(page.locator("#settingsMessage")).toHaveText("Token records approved.");
    assert.equal(configures().at(-1).body.usageRecords, true);
    await expect(page.locator("#approvedUsageRecords")).toHaveText(recordsFile);
    assert.equal(await tokens("Unavailable"), unread, "A chat WIRE already read is not recounted until it changes");

    await later(20000);
    const counted = await tokens(/11,400/);
    assert.match(counted, /11,400/);
    assert.match(counted, /Counted from the Copilot app's own per-call usage records/);

    await navigateMain(page, "settings"); await openSourceEditor(page);
    await swtch.click(); await expect(swtch).not.toBeChecked();
    await expect(page.locator("#connectCollection")).toHaveText("Stop reading token records");
    await page.locator("#connectCollection").click();
    await expect(page.locator("#settingsMessage")).toHaveText("Token records turned off.");
    assert.equal(configures().at(-1).body.usageRecords, false);
    await expect(page.locator("#approvedUsageRecords")).toHaveText("Not read");
    indexed(index => usage(index, 0, 7000, 50, 6000, 0, reply(activityEvents, "b")));
    await later(30000);
    const kept = await tokens(/11,400/);
    assert.match(kept, /11,400/, "Turning records off neither rereads the changed file nor removes the counted total");
});

test("Count tokens in chats already read checks first, counts only after a separate confirmation and checks a lost result without counting again", { timeout: 120000 }, async t => {
    const { page, runtime, context, sessionId, exchange, indexed, usage, reply, journal, refresh, tokens } = await tokenRecordChat(t);
    const sent = pathname => { const requests = []; page.on("request", r => { if (new URL(r.url()).pathname === pathname) requests.push(r); }); return requests; };
    const confirms = sent("/api/usage-records/confirm"), previews = sent("/api/usage-records/preview");
    const response = pathname => page.waitForResponse(r => new URL(r.url()).pathname === pathname);
    const row = page.locator("#usageCountRow"), action = page.locator("#countUsageRecords"), dialog = page.locator("#usageCountDialog");
    const records = async on => {
        await navigateMain(page, "settings"); await openSourceEditor(page);
        const swtch = page.getByRole("switch", { name: "Read Copilot's token records" });
        if (on) await swtch.check(); else await swtch.uncheck();
        await page.locator("#connectCollection").click();
        await expect(page.locator("#settingsMessage")).toHaveText(on ? "Token records approved." : "Token records turned off.");
    };
    await page.goto(runtime.url); await ready(page);
    await page.locator("#welcomeReviewSource").click();
    await page.locator("#connectCollection").click();
    await expect(page.locator("#settingsMessage")).toHaveText("Source approved.");
    await expect(row).toBeHidden();
    assert.doesNotMatch(await tokens("Unavailable"), /11,400/);

    await records(true);
    await expect(row).toBeVisible();
    await expect(action).toHaveText("Check chats");
    assert.equal(previews.length, 0, "Turning records on never checks or counts by itself");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const checked = response("/api/usage-records/preview");
        await action.focus(); await page.keyboard.press("Enter");
        await expect(dialog).toBeVisible();
        await expect(page.locator("#usageCountClose")).toBeFocused();
        assert.equal((await checked).status(), 200);
        await expect(page.locator("#usageCountTitle")).toHaveText("Count tokens for 1 interaction?");
        await expect(page.locator("#usageCountSummary")).toHaveText("1 interaction in 1 chat can be counted · 11,400 tokens");
        await expect(page.locator("#usageCountConfirm")).toHaveText("Count 1 interaction");
        assert.equal(await dialog.getAttribute("data-decision-kind"), null, "Counting is not a destructive decision");
        assert.equal(await dialog.getAttribute("data-decision-phase"), "confirm");
        await page.keyboard.press("Tab");
        await expect(page.locator("#usageCountConfirm")).toBeFocused();
        await capture(page, `count-tokens-preview-${theme}`);
        await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Enter");
        await expect(dialog).toBeHidden();
        await expect(action).toBeFocused();
    }
    assert.equal(confirms.length, 0, "Checking and Cancel save nothing");
    assert.doesNotMatch(await tokens("Unavailable"), /11,400/, "Cancel leaves the interaction unmeasured");

    await navigateMain(page, "settings"); await navigateSettings(page, "source-access");
    const checked = response("/api/usage-records/preview");
    await action.click(); await checked;
    await expect(page.locator("#usageCountSummary")).toContainText("11,400 tokens");
    const committed = response("/api/usage-records/confirm");
    await page.locator("#usageCountConfirm").click();
    assert.equal((await committed).status(), 200);
    await expect(page.locator("#usageCountTitle")).toHaveText("Tokens counted");
    await expect(page.locator("#usageCountStatus")).toHaveText("Counted 1 interaction in 1 chat · 11,400 tokens. Saved reports are unchanged.");
    await page.locator("#usageCountClose").click();
    const counted = await tokens(/11,400/);
    assert.match(counted, /Counted from the Copilot app's own per-call usage records/);
    await page.reload(); await ready(page);
    assert.match(await tokens(/11,400/), /Counted from the Copilot app's own per-call usage records/, "Reload and the next collection keep the total");

    // A second exchange collected while records were off is the next chat already read.
    await records(false);
    await expect(row).toBeHidden();
    const prompt = "List the invented launch owners.", second = exchange(prompt, ["c", "d"], 20000, "second-fetch");
    await appendFile(journal, second.map(e => JSON.stringify({ id: randomUUID(), ...e }) + "\n").join(""));
    indexed(index => {
        index.prepare("INSERT INTO turns VALUES (?,1,?,?)").run(sessionId, prompt, "Invented answer");
        usage(index, 1, 2000, 100, 1500, 0, reply(second, "c"));
        usage(index, 1, 1000, 100, 800, 0, reply(second, "d"));
    });
    await refresh();
    await records(true);
    const again = response("/api/usage-records/preview");
    await action.click(); await again;
    await expect(page.locator("#usageCountSummary")).toHaveText("1 interaction in 1 chat can be counted · 3,200 tokens");
    // The confirmation reaches WIRE and commits, but its response is lost.
    await page.route(url => url.pathname === "/api/usage-records/confirm", async route => { await route.fetch(); await route.abort(); });
    await page.locator("#usageCountConfirm").click();
    await expect(page.locator("#usageCountTitle")).toHaveText("Result not yet confirmed");
    await expect(page.locator("#usageCountConfirm")).toBeHidden();
    await expect(page.locator("#usageCountCheck")).toBeVisible();
    await page.unroute(url => url.pathname === "/api/usage-records/confirm");
    assert.equal(confirms.length, 2);

    await page.reload(); await ready(page);
    await navigateMain(page, "settings"); await navigateSettings(page, "source-access");
    await expect(action).toHaveText("Check result");
    await expect(page.locator("#usageCountNotice")).toContainText("wasn't confirmed");
    await action.click();
    await expect(page.locator("#usageCountClose")).toBeFocused();
    await expect(page.locator("#usageCountConfirm")).toBeHidden();
    const read = response("/api/usage-records/status");
    await page.locator("#usageCountCheck").click();
    assert.equal((await read).status(), 200);
    await expect(page.locator("#usageCountTitle")).toHaveText("Tokens counted");
    await expect(page.locator("#usageCountStatus")).toHaveText("Counted 1 interaction in 1 chat · 3,200 tokens. Saved reports are unchanged.");
    assert.equal(confirms.length, 2, "Check result reads the original receipt and never confirms again");
    await page.locator("#usageCountClose").click();
    await expect(action).toHaveText("Check chats");
    const state = await loadBoardState(context);
    assert.equal(Object.keys(state.usageRecordCounts.operations).length, 2);
    assert.ok(state.evidence.every(r => r.usageCalls?.every(c => c.source === "copilot-usage-index") && r.usageGap === null));
});
