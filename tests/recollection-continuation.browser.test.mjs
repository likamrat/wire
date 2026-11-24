import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { navigateMain, navigateSettings } from "./helpers.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { TAIL_LIMITS } from "../lib/collector-io.mjs";

async function largeChat(t, { collision = false } = {}) {
    const f = await recollectionFixture(t);
    await f.collector.setEnabled(true);
    await f.stop();
    const file = f.files[0], row = (id, type, data, day = f.firstDay) =>
        JSON.stringify({ id, type, data, timestamp: `${day}T13:00:00.000Z` }) + "\n";
    const filler = "x".repeat(900 * 1024);
    const lateStart = row("late-start", "tool.execution_start", { toolCallId: "late", toolName: "workiq-fetch", arguments: { entityUrls: ["/me"] } });
    await appendFile(file, row("before", "user.message", { content: "One invented selected call." }) + lateStart);
    for (let i = 0; i < 36; i++) await appendFile(file, row(`padding-${i}`, "invented.padding", { padding: filler }));
    assert.ok((await stat(file)).size < TAIL_LIMITS.cycleBytes);
    await appendFile(file, row("split", "invented.padding", { padding: filler }) + row("split2", "invented.padding", { padding: filler })
        + (collision ? row("conflicting-start", "tool.execution_start", { toolCallId: "late", toolName: "workiq-fetch", arguments: { entityUrls: ["/me/drive"] } }) : lateStart)
        + row("late-end", "tool.execution_complete", { toolCallId: "late", success: true })
        + row("late-only", "user.message", { content: "A distinct late request." })
        + row("other-start", "tool.execution_start", { toolCallId: "second-late", toolName: "workiq-fetch", arguments: { entityUrls: ["/me/messages"] } })
        + row("outside", "user.message", { content: "Outside the selected day." }, f.secondDay)
        + row("outside-start", "tool.execution_start", { toolCallId: "outside", toolName: "workiq-fetch", arguments: { entityUrls: ["/me"] } }, f.secondDay));
    assert.ok((await stat(file)).size > TAIL_LIMITS.cycleBytes);
    return f;
}

test("one-day recovery continues past its first read budget before offering the reviewed calls", { timeout: 30000 }, async t => {
    const f = await largeChat(t);
    let runtime, access, browser;
    try {
        runtime = await startServer(f.context, createExportController(f.context), { port: 0, frontend: "bundled", collector: { timers: false },
            createAccess: async () => access = await createCopilotRuntimeAccess(f.context) });
        browser = await chromium.launch();
        const page = await browser.newPage({ timezoneId: "UTC", reducedMotion: "reduce" });
        await page.route("**/*", route => new URL(route.request().url()).origin === new URL(runtime.url).origin ? route.continue() : route.abort());
        await page.goto(runtime.url); await page.locator("#workspace[aria-busy=false]").waitFor();
        await navigateMain(page, "settings"); await navigateSettings(page, "data");
        await page.locator("#recollectActivity").click();
        await page.locator(`#recollectSources input[value="${f.sourceId}"]`).check();
        await page.locator("#recollectFrom").fill(f.firstDay); await page.locator("#recollectTo").fill(f.firstDay);
        const submit = async (control, action) => {
            const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/recollection/" + action);
            await page.locator(control).click(); const r = await response, body = await r.json();
            assert.equal(r.status(), 200, JSON.stringify(body)); return body;
        };
        const refusedPart = await submit("#recollectPreview", "preview");
        await appendFile(f.files[0], "\n");
        const refused = page.waitForResponse(r => new URL(r.url()).pathname === "/api/recollection/preview");
        await page.locator("#recollectContinue").click();
        assert.equal((await refused).status(), 409);
        await expect(page.locator("#recollectStatus")).toContainText("Preview failed. Nothing changed.");
        await expect(page.locator("#recollectPreview")).toBeEnabled({ timeout: 1000 });
        assert.equal(await page.locator("#recollectForm").evaluate(form => form.inert), false);
        const part = await submit("#recollectPreview", "preview");
        assert.notEqual(part.operationId, refusedPart.operationId);
        assert.equal(part.phase, "reading", "a covered prefix is not a final preview");
        assert.ok(part.progress.remainingBytes > 0 && part.progress.bytesRead <= TAIL_LIMITS.cycleBytes);
        assert.equal(part.counts, undefined);
        await expect(page.locator("#recollectConfirm")).toBeHidden();
        const preview = await submit("#recollectContinue", "preview");
        assert.equal(preview.operationId, part.operationId);
        assert.equal(preview.counts.newRecords, 2);
        assert.equal(preview.availability[0].unreadBytes, 0);
        assert.equal(preview.expiresAt, part.expiresAt);
        assert.ok(preview.progress.bytesRead <= TAIL_LIMITS.cycleBytes);
        assert.equal(preview.progress.totalBytesRead, part.progress.bytesRead + preview.progress.bytesRead);
        assert.ok(preview.progress.totalBytesRead >= (await stat(f.files[0])).size);
        const verifying = await submit("#recollectConfirm", "confirm");
        assert.equal(verifying.phase, "verifying");
        assert.equal((await loadBoardState(f.context)).recollection?.operations?.[part.operationId], undefined);
        const done = await submit("#recollectContinue", "confirm");
        assert.equal(done.operationId, part.operationId); assert.equal(done.phase, "complete");
        assert.deepEqual((await loadBoardState(f.context)).evidence.flatMap(r => r.toolCalls)
            .filter(c => c.recollection?.operationId === done.operationId).map(c => [c.toolCallId, c.completionEventId]), [["late", "late-end"], ["second-late", null]]);
    } finally { await browser?.close(); await runtime?.close(); await access?.close(); }
});

for (const ageOut of [false, true]) test(`oldest partly approved day ${ageOut ? "refuses a reviewed call leaving the window" : "continues while the reviewed calls remain eligible"}`, async t => {
    const f = await largeChat(t);
    await appendFile(f.files[0], [
        { id: "before-window-prompt", type: "user.message", data: { content: "Outside the approved part of this day." } },
        { id: "before-window-start", type: "tool.execution_start", data: { toolCallId: "before-window", toolName: "workiq-fetch" } },
    ].map(e => JSON.stringify({ ...e, timestamp: `${f.firstDay}T12:59:57.000Z` }) + "\n").join(""));
    // Both proposed calls occur at 13:00:00. The fixture approval is seven days.
    let clock = Date.parse(`${f.firstDay}T12:59:58.000Z`) + 7 * 86400000;
    t.mock.method(Date, "now", () => clock);
    await withRuntime(f, async ({ post, scope }) => {
        const part = (await post("preview", scope)).body;
        assert.equal(part.phase, "reading");
        clock += 1000;
        const next = await post("preview", continuation(part));
        assert.equal(next.status, 200, next.body.error);
        assert.equal(next.body.counts.newRecords, 2);
        assert.equal(next.body.scope.since, `${f.firstDay}T12:59:58.000Z`);
        const verify = await post("confirm", { operationId: part.operationId, confirmed: true });
        assert.equal(verify.body.phase, "verifying", verify.body.error);
        if (ageOut) clock += 1500;
        const final = await post("confirm", continuation(verify.body));
        assert.equal(final.status, ageOut ? 409 : 200, final.body.error);
        if (ageOut) assert.match(final.body.error, /approved window/i);
        const state = await loadBoardState(f.context);
        const calls = state.evidence.flatMap(r => r.toolCalls);
        assert.deepEqual(calls.filter(c => c.recollection?.operationId === part.operationId).map(c => c.toolCallId).sort(),
            ageOut ? [] : ["late", "second-late"]);
        assert.equal(calls.some(c => c.toolCallId === "before-window"), false);
        assert.equal(state.recollection?.operations?.[part.operationId]?.phase, ageOut ? undefined : "complete");
    });
});

test("a continued review refuses ambiguous raw call identities on opposite sides of its boundary", async t => {
    const f = await largeChat(t, { collision: true });
    await withRuntime(f, async ({ post, scope }) => {
        const part = await post("preview", scope);
        assert.equal(part.body.phase, "reading");
        const next = await post("preview", continuation(part.body));
        assert.equal(next.status, 409);
        assert.match(next.body.error, /ambiguous/i);
        assert.equal((await loadBoardState(f.context)).recollection?.operations?.[part.body.operationId], undefined);
    });
});

test("continued reads cannot change owner or scope, outlive cancellation, source changes, sign-out or restart", async t => {
    const f = await largeChat(t);
    let old;
    await withRuntime(f, async ({ post, scope, session, panel, api, access }) => {
        const start = async () => {
            const p = await post("preview", scope);
            assert.equal(p.status, 200); assert.equal(p.body.phase, "reading"); return p.body;
        };
        let p = await start();
        const other = await session();
        assert.equal((await post("preview", continuation(p), other)).status, 409);
        assert.equal((await post("preview", { ...continuation(p), from: f.secondDay })).status, 422);
        assert.equal((await post("confirm", { operationId: p.operationId, confirmed: true })).status, 409);
        assert.equal((await post("cancel", { operationId: p.operationId })).status, 200);
        assert.equal((await post("preview", continuation(p))).status, 409);
        p = await start();
        await appendFile(f.files[0], "\n");
        assert.equal((await post("preview", continuation(p))).status, 409);
        p = await start();
        await copyFile(f.files[0], f.files[0] + ".copy");
        await rename(f.files[0] + ".copy", f.files[0]);
        assert.equal((await post("preview", continuation(p))).status, 409);
        p = await start();
        const preview = (await post("preview", continuation(p))).body;
        assert.equal(preview.counts.newRecords, 2);
        assert.equal((await post("preview", continuation(p))).status, 409);
        const verify = await post("confirm", { operationId: p.operationId, confirmed: true });
        assert.equal(verify.body.phase, "verifying");
        const receipt = { operationId: p.operationId, receiptToken: preview.receiptToken };
        assert.equal((await post("status", receipt, other)).body.phase, "verification-incomplete");
        await post("cancel", { operationId: p.operationId });
        assert.equal((await post("confirm", continuation(verify.body))).status, 409);
        assert.equal((await post("status", receipt, other)).body.phase, "not-started");
        p = await start();
        const switchAccess = async action => {
            const r = await api("/api/access/command", { schemaVersion: 1, action, operationId: randomUUID(),
                generation: (await access.status()).generation }, panel);
            assert.equal(r.status, 200);
        };
        await switchAccess("wire-sign-out");
        assert.equal((await post("preview", continuation(p))).status, 403);
        await switchAccess("wire-sign-in");
        assert.equal((await post("preview", continuation(p))).status, 409);
        old = await start();
    });
    await withRuntime(f, async ({ post }) => {
        assert.equal((await post("preview", continuation(old))).status, 409);
        const state = await loadBoardState(f.context);
        assert.equal(state.evidence.some(r => r.toolCalls.some(c => c.toolCallId === "late")), false);
    });
});

test("visiting the end does not turn an oversized entry into complete coverage", async t => {
    const f = await largeChat(t);
    await appendFile(f.files[0], JSON.stringify({ type: "tool.execution_complete", id: "omitted", timestamp: `${f.firstDay}T14:00:00.000Z`,
        data: { toolCallId: "second-late", success: true, result: { content: "x".repeat(TAIL_LIMITS.maxLineBytes) } } }) + "\n");
    await withRuntime(f, async ({ post, scope }) => {
        const part = (await post("preview", scope)).body;
        const final = await post("preview", continuation(part));
        assert.equal(final.status, 422); assert.match(final.body.error, /1 oversized entries/);
        assert.equal(final.body.counts, undefined);
        assert.equal((await post("confirm", { operationId: part.operationId, confirmed: true })).status, 409);
        assert.equal((await loadBoardState(f.context)).evidence.some(r => r.toolCalls.some(c => c.toolCallId === "late")), false);
    });
});

const continuation = part => ({ operationId: part.operationId, continuation: part.continuation });
async function withRuntime(f, run) {
    let runtime, access;
    try {
        runtime = await startServer(f.context, createExportController(f.context), { port: 0, collector: { timers: false },
            createAccess: async () => access = await createCopilotRuntimeAccess(f.context) });
        const origin = new URL(runtime.url).origin;
        const api = async (route, input, panel) => {
            const r = await fetch(origin + route, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json",
                "X-Wire-Session-Protocol": "1", ...(panel ? { "X-Board-Capability": panel } : {}) }, body: JSON.stringify(input) });
            return { status: r.status, body: await r.json() };
        };
        const session = () => api("/api/session", {}).then(r => r.body.capability), panel = await session();
        await run({ scope: { sourceSessionIds: [f.sourceId], from: f.firstDay, to: f.firstDay, timeContext: { timeZone: "UTC", locale: "en-US" }, restorePrompts: false },
            api, session, panel, access, post: (name, data, cap = panel) => api("/api/recollection/" + name, data, cap) });
    } finally { await runtime?.close(); await access?.close(); }
}
