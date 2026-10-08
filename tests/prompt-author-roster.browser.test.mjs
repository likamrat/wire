import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";

const ready = page => page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
async function chooseAuthors(page, values, wait = true) {
    await page.locator('[data-select-id="promptAuthorFilter"]').click();
    const popup = page.locator(".select-popup:visible");
    for (const actor of ["user", "agent", "unknown"]) {
        const option = popup.locator(`[data-value="${actor}"]`);
        if ((await option.getAttribute("aria-selected") === "true") !== values.includes(actor)) await option.click();
    }
    const response = wait ? page.waitForResponse(value => value.url().endsWith("/api/snapshot")) : null;
    await popup.getByRole("button", { name: "Apply", exact: true }).click();
    if (wait) { await response; await ready(page); }
}

async function setup(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-author-roster-"));
    const config = { appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state"),
        approved: true, enabled: false, windowDays: 30, pollSeconds: 5 };
    await mkdir(config.sessionRoot);
    const db = new DatabaseSync(config.appDbPath);
    db.exec(`PRAGMA user_version=166;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT,created_by TEXT,creator_session_id TEXT);`);
    const actors = new Map();
    const timestamp = Date.now() - 60000;
    const event = (type, data, offset = 0) => ({ id: randomUUID(), type, data, timestamp: new Date(timestamp + offset).toISOString() });
    for (const [index, actor] of [...Array(10).fill("agent"), ...Array(3).fill("unknown"), null].entries()) {
        const id = randomUUID();
        actors.set(id, actor);
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(id, `Invented roster chat ${index + 1}`, "chat", null, "local");
        const events = [event("session.start", { sessionId: id, version: 1 })];
        if (actor) {
            events.push(event("user.message", { content: `Invented request ${index + 1}`,
                ...(actor === "agent" ? { source: `agent-${randomUUID()}` } : {}) }, 10),
            event("tool.execution_start", { toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch",
                toolCallId: `invented-roster-call-${index}`, arguments: { entityUrls: ["/me/messages"] } }, 20),
            event("tool.execution_complete", { toolCallId: `invented-roster-call-${index}`, success: true }, 30));
        }
        const directory = path.join(config.sessionRoot, id);
        await mkdir(directory);
        await writeFile(path.join(directory, "events.jsonl"), events.map(value => JSON.stringify(value) + "\n").join(""));
    }
    const context = { dataDir: path.join(root, "private") }, denied = { provider: 0, scoringRead: 0 };
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false }, evaluation: {
        evaluatorFactory: async () => { denied.provider++; throw new Error("No provider allowed in author roster proof"); },
        readSource: async () => { denied.scoringRead++; throw new Error("No scoring source read allowed in author roster proof"); },
    } });
    const beforeApproval = structuredClone((await loadBoardState(context)).personalEvaluation?.modelEvaluation?.automatic?.approval);
    let browser, releasePending = () => {};
    const errors = [], forbidden = [];
    t.after(async () => {
        releasePending();
        try {
            await browser?.close();
            assert.deepEqual(errors, []);
            assert.deepEqual(forbidden, []);
            assert.deepEqual(denied, { provider: 0, scoringRead: 0 });
            assert.deepEqual((await loadBoardState(context)).personalEvaluation?.modelEvaluation?.automatic?.approval, beforeApproval);
        } finally { await runtime.close(); db.close(); await rm(root, { recursive: true, force: true }); }
    });
    await runtime.collector.configure(config);
    await runtime.collector.collectNow();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 950 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || /\/api\/(?:collection\/(?:now|configure|enabled)|evaluation\/(?:start|automatic\/(?:approve|revoke)))/.test(url.pathname)) {
            forbidden.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    await page.goto(runtime.url + "#activity"); await ready(page);
    const displayedIds = () => page.locator("#activityList .session-group").evaluateAll(nodes => nodes.map(node => node.dataset.sessionId));
    const displayedCount = async () => {
        const summary = await page.locator("#periodResult").textContent();
        const count = summary.match(/\bwith (\d+) Work IQ tool calls?\b/);
        assert.ok(count, `Expected a recorded call count in the displayed period summary: ${summary}`);
        return Number(count[1]);
    };
    return { page, actors, displayedCount, displayedIds, setPendingRelease: fn => { releasePending = fn; } };
}

test("accepted author filters exclude empty roster chats before pagination while All preserves metadata browsing", { timeout: 45000 }, async t => {
    const app = await setup(t), { page } = app;
    assert.equal(await app.displayedCount(), 13);
    assert.equal((await app.displayedIds()).length, 8);
    assert.match(await page.locator("#activityPager").textContent(), /1-8 of 14/);

    await chooseAuthors(page, ["user"]);
    assert.equal(await app.displayedCount(), 0);
    assert.deepEqual(await app.displayedIds(), [], "Your-only must not resurrect agent/unknown chats as empty groups");
    assert.equal(await page.getByRole("heading", { name: "No requests match", exact: true }).count(), 1);
    assert.equal(await page.locator("#activityPager").textContent(), "");
    assert.equal(await page.locator("#activityInsights .assessment-fact").count(), 0);

    await chooseAuthors(page, ["user", "agent"]);
    assert.equal(await app.displayedCount(), 10);
    const first = await app.displayedIds();
    assert.equal(first.length, 8);
    assert.ok(first.every(id => app.actors.get(id) === "agent"));
    assert.match(await page.locator("#activityPager").textContent(), /1-8 of 10/);
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click(); await ready(page);
    const second = await app.displayedIds();
    assert.equal(second.length, 2);
    assert.ok(second.every(id => app.actors.get(id) === "agent"));
    assert.equal(new Set([...first, ...second]).size, 10);
    assert.match(await page.locator("#activityPager").textContent(), /9-10 of 10/);

    await chooseAuthors(page, ["unknown"]);
    const unknown = await app.displayedIds();
    assert.equal(unknown.length, 3);
    assert.ok(unknown.every(id => app.actors.get(id) === "unknown"));
    assert.equal(await app.displayedCount(), 3);
    assert.match(await page.locator("#activityPager").textContent(), /1-3 of 3/);
    assert.equal(await page.locator("#activityPager button").count(), 0);

    await chooseAuthors(page, ["user", "agent", "unknown"]);
    const allFirst = await app.displayedIds();
    assert.match(await page.locator("#activityPager").textContent(), /1-8 of 14/);
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click(); await ready(page);
    const all = new Set([...allFirst, ...await app.displayedIds()]);
    assert.equal(all.size, 14);
    assert.ok([...all].some(id => app.actors.get(id) === null), "All keeps the eligible chat with no retained activity");
});

test("roster fallback follows accepted authors during pending and failed reads, not requested authors", { timeout: 45000 }, async t => {
    const app = await setup(t), { page } = app;
    let entered, release;
    const held = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    app.setPendingRelease(release);
    await page.route("**/api/snapshot", async route => {
        const selected = route.request().postDataJSON().filters.promptAuthors;
        if (selected?.join(",") !== "user") return route.continue();
        const response = await route.fetch();
        entered(); await gate;
        await route.fulfill({ response });
    });
    await chooseAuthors(page, ["user"], false); await held;
    await page.locator("#activitySearch").fill("Invented");
    assert.deepEqual(await page.locator("#promptAuthorFilter").evaluate(node => [...node.selectedOptions].map(option => option.value)), ["user", "agent", "unknown"]);
    assert.equal((await app.displayedIds()).length, 8, "Accepted All roster stays while Your-only is pending");
    assert.match(await page.locator("#activityPager").textContent(), /1-8 of 14/);
    release(); await ready(page);
    assert.deepEqual(await app.displayedIds(), []);

    await page.unroute("**/api/snapshot");
    let failingEntered, failRelease;
    const failingHeld = new Promise(resolve => { failingEntered = resolve; });
    const failGate = new Promise(resolve => { failRelease = resolve; });
    app.setPendingRelease(failRelease);
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().filters.promptAuthors) return route.continue();
        failingEntered(); await failGate;
        await route.fulfill({ status: 503, json: { error: "Invented All-author read failure." } });
    });
    await chooseAuthors(page, ["user", "agent", "unknown"], false); await failingHeld;
    await page.locator("#activitySearch").fill("");
    assert.deepEqual(await page.locator("#promptAuthorFilter").evaluate(node => [...node.selectedOptions].map(option => option.value)), ["user"]);
    assert.deepEqual(await app.displayedIds(), [], "Requested All cannot reinsert roster chats while accepted Your-only is pending");
    failRelease(); await ready(page);
    assert.deepEqual(await app.displayedIds(), []);
    assert.equal(await page.locator("#activityPager").textContent(), "");
    assert.equal(await page.getByRole("heading", { name: "No requests match", exact: true }).count(), 1);
    assert.match(page.url(), /authors=user/);
    assert.match(await page.locator("#message").textContent(), /could not update|last recorded snapshot/i);
});
