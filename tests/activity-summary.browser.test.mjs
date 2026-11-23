import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

test("Analyze counts matching calls and parent interactions, never roster-only chats or unidentified calls", async t => {
    const records = [["alpha-human", "alpha", "user", 2], ["alpha-agent", "alpha", "agent", 1],
        ["beta-human", "beta", "user", 2], ["gamma-unverified", "gamma", "unknown", 1]].map(([id, chat, actor, count]) => {
        const row = fixture(id);
        row.sourceSessionId = chat;
        row.userPrompt = { text: `Invented request ${id}`, status: "full", sourceEventId: `prompt-${id}`,
            sourceTimestamp: row.capturedAt, authorship: { actor, basis: { user: "source-user", agent: "source-agent", unknown: "legacy-missing" }[actor] } };
        row.toolCalls = Array.from({ length: count }, (_, i) => {
            const result = id === "gamma-unverified" ? null : !(id === "beta-human" && i === 0);
            return { ...row.toolCalls[0], toolCallId: `${id}-${i}`, startEventId: `start-${id}-${i}`,
                startedAt: row.capturedAt, reportedOutcome: result === null ? "unknown" : result ? "succeeded" : "failed", toolSucceeded: result };
        });
        return row;
    });
    records.push({ ...fixture("unattributed"), sourceSessionId: null, sourceSessionName: null });
    const { context } = await privateFixture(t, records);
    await replaceEvidence(context, () => ({ records, importCoverage: { counts: {}, roster: [
        { sessionId: "archive", name: "Inventory-only chat", projectId: "archive-project", project: "Archive", eligible: true, scanned: true },
    ] } }));
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ timezoneId: "UTC", reducedMotion: "reduce" });
    for (const [query, interactions, calls] of [
        ["scope=all", ["alpha-human", "alpha-agent", "beta-human", "gamma-unverified"], 6],
        ["authors=user", ["alpha-human", "beta-human"], 4],
        ["result=failure", ["beta-human"], 1],
        ["project=archive-project", [], 0],
    ]) {
        await page.goto(`${runtime.url}?${query}`);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#activityCount")).toHaveText(String(calls));
        assert.deepEqual((await page.locator("#activityList article[data-view-key]").evaluateAll(rows => rows.map(row => row.dataset.viewKey))).sort(),
            interactions.map(id => `request:${id}`).sort(), query);
        if (calls) await expect(page.locator("#activityListSummary")).toHaveText(`${interactions.length} interaction${interactions.length === 1 ? "" : "s"} · ${calls} matching tool call${calls === 1 ? "" : "s"}`);
    }
});
