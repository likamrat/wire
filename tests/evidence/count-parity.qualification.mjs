import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { metadata174Schema } from "../collection/copilot-metadata-fixture.mjs";
import { selectActivityOption } from "../support/helpers.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const ordered = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const matches = (actual, expected, message) => assert.deepEqual(ordered(actual), ordered(expected), message);

async function sourceCorpus(home) {
    const root = path.join(home, "session-state"), dbFile = path.join(home, "data.db");
    await mkdir(root, { recursive: true });
    const db = new DatabaseSync(dbFile);
    const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), calls = [];
    try {
        db.exec(metadata174Schema);
        for (let s = 0; s < 3; s++) {
            const session = `00000000-0000-4000-8000-00000000000${s}`;
            db.prepare("INSERT INTO sessions(id,title,session_type) VALUES(?,?,?)").run(session, `Invented roster ${s}`, "general_chat");
            let clock = Date.parse(`${day}T${s === 0 ? "01" : "15"}:00:00Z`);
            const events = [], add = (id, type, data) => {
                const timestamp = new Date(clock++).toISOString();
                events.push({ id, type, data, timestamp });
                return timestamp;
            };
            add(`startup-${s}`, "session.start", { sessionId: session, version: 1 });
            for (let n = 0; n < (s === 0 ? 1 : s === 1 ? 9 : 0); n++) {
                const prompt = `prompt-${s}-${n}`, scenario = `history-${session}-${prompt}`;
                add(prompt, "user.message", { content: s === 0 ? "Check the invented marigold request." : `Check invented item ${n}.` });
                const names = s === 0 ? ["fetch", "retrieve", "fetch"] : ["fetch"];
                for (const [i, name] of names.entries()) {
                    // Reuse a raw call ID across two sources: name and raw ID alone are not canonical identity.
                    const id = `call-${n}-${i}`, start = `start-${s}-${n}-${i}`, tool = `workiq-${name}`;
                    const args = name === "retrieve" ? { query: "invented" }
                        : { entityUrls: s === 0 && i === 0 ? ["/me/messages", "/me/calendarView"] : ["/me/messages"] };
                    const startedAt = add(start, "tool.execution_start", { toolName: tool, mcpToolName: name, mcpServerName: "workiq", toolCallId: id, arguments: args });
                    const outcome = s === 0 ? ["success", "failure", "unknown"][i] : "success";
                    const end = outcome === "unknown" ? null : `end-${s}-${n}-${i}`;
                    if (end) add(end, "tool.execution_complete", { toolCallId: id, success: outcome === "success",
                        ...(outcome === "failure" ? { error: { code: "Unavailable", message: "Invented search failed." } }
                            : s === 0 ? { result: { structuredContent: { results: [{ statusCode: 200 }, { statusCode: 403 }] } } } : {}) });
                    calls.push({ session, scenario, id, start, end, tool, outcome, startedAt, key: `call:${JSON.stringify([session, id])}` });
                }
            }
            if (s === 2) add("empty-prompt", "user.message", { content: "An invented message without a qualifying call." });
            await mkdir(path.join(root, session));
            await writeFile(path.join(root, session, "events.jsonl"), events.map(e => JSON.stringify(e) + "\n").join(""));
        }
    } finally { db.close(); }
    return { day, calls, dbFile };
}

async function launch(checkout, store, home, networkGuard, contributor) {
    const child = fork(path.join(checkout, "scripts", "start.mjs"), [...(contributor ? ["--contributor"] : []), "--port", "0"], {
        cwd: checkout, env: { ...process.env, COPILOT_HOME: home, LOCALAPPDATA: store, WORKIQ_EVIDENCE_DATA_DIR: contributor ? "" : store },
        execArgv: ["--import", pathToFileURL(networkGuard).href], silent: true,
    });
    const exited = once(child, "exit");
    const stop = async () => { if (child.connected) child.disconnect(); await exited; };
    let timer;
    try {
        const url = await new Promise((resolve, reject) => {
            let stdout = "", stderr = "";
            child.stderr.on("data", data => { stderr = (stderr + data).slice(-2000); });
            child.stdout.on("data", data => { stdout += data; const match = /ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout); if (match) resolve(match[1]); });
            child.once("error", reject);
            child.once("exit", code => reject(new Error(`Disposable WIRE exited (${code}): ${stderr}`)));
            timer = setTimeout(() => reject(new Error("Disposable WIRE did not become ready.")), 15000);
        });
        return { url, stop };
    } catch (error) { await stop(); throw error; }
    finally { clearTimeout(timer); }
}

async function qualify(checkout, store, home, corpus, networkGuard, browser, contributor = false) {
    const app = await launch(checkout, store, home, networkGuard, contributor), origin = new URL(app.url).origin;
    const context = await browser.newContext({ viewport: { width: 1400, height: 980 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const page = await context.newPage(), requests = [], errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await context.route(url => url.origin !== origin, route => { requests.push(route.request().url()); return route.abort(); });
    let panel;
    const post = async (route, input) => {
        const response = await context.request.post(origin + route, { headers: { Origin: origin, "X-Wire-Session-Protocol": "1",
            ...(panel ? { "X-Board-Capability": panel } : {}) }, data: input });
        assert.equal(response.status(), 200, route);
        return response.json();
    };
    try {
        const session = await post("/api/session", {});
        assert.equal(session.accessBootstrap.mode, "enforced");
        assert.equal(session.accessBootstrap.collectionMode, "copilot-only");
        panel = session.capability;
        await page.goto(app.url); await page.locator("#dismissFirstConnection").click();
        await page.locator("#firstConnectionReview").click();
        await expect(page.locator("#reviewDatabase")).toHaveText(corpus.dbFile);
        await page.locator("#connectCollection").click(); await page.locator("#firstCollectionActivity").click();
        assert.equal(await page.locator("body").evaluate(node => node.classList.contains("wire-frontend-react")), contributor);
        const options = { layer: "tool", timeContext: { timeZone: "UTC", locale: "en-US" }, filters: { scope: "history" } };
        const snapshot = await post("/api/snapshot", options), all = corpus.calls;
        const tuple = row => [row.id, row.sourceSessionId, row.toolCallId, row.scenarioId, row.outcome];
        const wanted = c => [c.key, c.session, c.id, c.scenario, c.outcome];
        const retained = snapshot.scenarios.flatMap(s => s.toolCalls.map(c => [s.sourceSessionId, s.scenarioId, c.toolCallId, c.startEventId, c.completionEventId]));
        matches(retained, all.map(c => [c.session, c.scenario, c.id, c.start, c.end]), "source starts, ends and owning prompts");
        matches(snapshot.requestActivity.tool.map(tuple), all.map(wanted), "complete retained context");
        const parent = all[0], returned = snapshot.requestActivity["reported-api"];
        matches(returned.map(r => [r.parentCallId, r.scenarioId, r.resultIndex, r.status]), [[parent.key, parent.scenario, 0, 200], [parent.key, parent.scenario, 1, 403]]);
        assert.equal(snapshot.scenarios.flatMap(s => s.toolCalls).find(c => c.startEventId === all[2].start).toolSucceeded, null);
        const signatures = {};
        async function rows(label, filters, population, tz = "UTC") {
            const a = await post("/api/analytics", { ...options, filters: { ...options.filters, ...filters }, timeContext: { ...options.timeContext, timeZone: tz } });
            matches(a.rows.map(tuple), population.map(wanted), label);
            assert.equal(a.totals.count, population.length, label);
            matches(a.population.scenarioIds, new Set(population.map(c => c.scenario)), label);
            assert.equal(a.revision, snapshot.revision, `${label} changed revision`);
            signatures[label] = ordered(a.rows.map(tuple));
        }
        await rows("all", {}, all);
        await rows("failure", { outcomes: ["failure"] }, [all[1]]);
        await rows("unknown", { outcomes: ["unknown"] }, [all[2]]);
        await rows("tool", { tools: ["workiq-retrieve"] }, [all[1]]);
        await rows("Calendar", { services: ["Calendar"], sources: ["github-copilot"] }, [parent]);
        await rows("empty", { tools: ["workiq-delete_entity"] }, []);
        await rows("UTC day", { from: corpus.day, to: corpus.day }, all);
        await rows("Los Angeles day", { from: corpus.day, to: corpus.day }, all.slice(3), "America/Los_Angeles");
        const cards = page.locator("#activityList .request-card-open");
        const cardIds = () => cards.evaluateAll(links => links.map(link => new URLSearchParams(new URL(link.href).hash.split("?")[1]).get("request")));
        const caption = async (interactions, calls) => {
            await expect(page.locator("#activityListSummary")).toHaveText(new RegExp(`^${interactions} interactions?\\b.*?\\b${calls} matching .*calls?`, "i"));
        };
        await caption(10, 12); await expect(cards).toHaveCount(8);
        const first = await cardIds();
        await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
        await caption(10, 12); await expect(cards).toHaveCount(2);
        matches([...first, ...await cardIds()], new Set(all.map(c => c.scenario)), "rendered parents across both pages");
        await expect(page.locator("#homeView")).toHaveAttribute("data-revision", String(snapshot.revision));
        await page.goto(app.url + "#analyze?result=partial");
        await caption(0, 0); await expect(page.locator("#activityView")).toBeVisible(); await expect(cards).toHaveCount(0);
        await page.goto(app.url + "#analyze?services=Calendar&source=github-copilot");
        await caption(1, 1); matches(await cardIds(), [parent.scenario]);
        await page.goto(app.url + "#analyze?tool=workiq-retrieve&result=failure&source=github-copilot");
        await caption(1, 1); matches(await cardIds(), [parent.scenario]);
        await cards.click();
        await expect(page.locator("[data-reader-section=activity] [data-tool-call-id]")).toHaveCount(3);
        await page.locator("#closeContextSidebar").click();
        await page.goto(app.url + "#analyze?scope=history&range=capture");
        await caption(10, 12);
        await page.locator("#wireSearch").fill("marigold");
        await selectActivityOption(page, "wireSearchScope", "analysis");
        await expect(page.locator("#wireSearchResults").getByRole("button", { name: /Open interaction: Check the invented marigold request/ })).toHaveCount(1);
        // Reply retention was never enabled. One available hit (or none) is not complete Search membership.
        await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Counts and Current reports are unavailable");
        await expect(page.locator("#activityView")).toBeHidden();
        await page.locator("#wireSearch").fill("absent-count-probe");
        await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
        await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Counts and Current reports are unavailable");
        await expect(page.locator("#activityView")).toBeHidden();
        await page.locator("#wireSearch").fill(""); await caption(10, 12);
        assert.deepEqual(requests, []); assert.deepEqual(errors, []);
        return signatures;
    } finally {
        try { if (panel) await post("/api/session/release", {}); }
        finally { try { await context.close(); } finally { await app.stop(); } }
    }
}

test("normal main and feature startup agree on source-qualified counts and parent membership", { timeout: 90000 }, async () => {
    assert.ok(process.env.WIRE_COUNT_REFERENCE_ROOT && path.isAbsolute(process.env.WIRE_COUNT_REFERENCE_ROOT),
        "Set WIRE_COUNT_REFERENCE_ROOT to a separately built, trusted local reference checkout.");
    const reference = await realpath(process.env.WIRE_COUNT_REFERENCE_ROOT);
    assert.notEqual(reference, await realpath(repo));
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-count-parity-")), home = path.join(root, "invented-copilot");
    let browser;
    try {
        const corpus = await sourceCorpus(home), guard = path.join(root, "no-external-fetch.mjs");
        await writeFile(guard, "globalThis.fetch = () => { throw Error('Count qualification does not permit backend network requests.'); };\n");
        browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
        const referenceResult = await qualify(reference, path.join(root, "reference"), home, corpus, guard, browser);
        const candidateResult = await qualify(repo, path.join(root, "candidate"), home, corpus, guard, browser, true);
        assert.deepEqual(candidateResult, referenceResult);
    } finally { try { await browser?.close(); } finally { await rm(root, { recursive: true, force: true }); } }
});
