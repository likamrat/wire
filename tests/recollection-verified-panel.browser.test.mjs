import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { createTimeContext } from "../lib/time.mjs";
import { describeRecollection, mountRecollection, recollectionMarkup, recollectionStyles } from "../web/recollection-flow.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { createSearchFields } from "../web/search-field.mjs";

const mode = "verified-records-only", coverage = "day-incomplete";
const operationId = "11111111-2222-4333-8444-555555555555", continuation = "22222222-3333-4444-8555-666666666666";
const receiptToken = "f".repeat(64), memberIds = ["a".repeat(64), "b".repeat(64)];
const day = "2026-03-16", since = `${day}T00:00:00Z`, until = `${day}T23:59:59Z`;
const timeContext = { timeZone: "UTC", locale: "en-US" };
const sources = { since, until, windowDays: 1, newOnly: true, exactRecordsAvailable: true,
    sources: ["Copper", "Tin"].map(name => ({ sourceSessionId: name, name, available: true })) };
const scope = { sourceSessionIds: ["Copper"], from: day, to: day, timeContext, since, until, bounds: { from: since, to: until } };
const counts = { proposed: 2, added: 0, excluded: 4, unknown: 2 };
const preview = () => ({ mode, coverage, operationId, receiptToken, scope, expiresAt: new Date(Date.now() + 120000).toISOString(),
    counts, omittedRegions: 3, availability: sources.sources.slice(0, 1),
    exactMembers: memberIds.map(memberId => ({ memberId, tool: "Invented tool", startedAt: since, outcome: "unknown", witness: "never-render-span" })) });
const receipt = { operationId, phase: "complete", mode, coverage, counts: { ...counts, added: 2 }, omittedRegions: 3, memberIds };
const progress = { bytesRead: 12, totalBytesRead: 12, remainingBytes: 16 };

// Use the panel's real markup, mount and private-text owner. All API replies are invented;
// even the page navigation is fulfilled locally, with no server, history files or store.
async function fixture(t) {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const calls = [], replies = [];
    await page.route("**/*", route => route.request().url() === "http://panel.invalid/" ? route.fulfill({
        contentType: "text/html", body: `<style>[hidden]{display:none!important}${recollectionStyles}</style><button id="recollectActivity">Choose chats</button>${recollectionMarkup}`,
    }) : route.abort());
    await page.exposeFunction("panelApi", (route, body) => {
        calls.push([route.split("/").at(-1), body]);
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        if (!reply) throw Error(`Unexpected request: ${route}`);
        return reply;
    });
    async function mount() {
        await page.goto("http://panel.invalid/");
        await page.addScriptTag({ content: `
            const ux = (${createEvidenceUX})(${JSON.stringify(uxIcons)});
            window.panel = (${mountRecollection})({ api: Object.assign(panelApi, { publicationToken: () => 1, isCurrent: t => t === 1 }),
                time: (${createTimeContext})(), timeContext: () => (${JSON.stringify(timeContext)}), ux, describe: ${describeRecollection},
                searchFields: (${createSearchFields})(ux), search: { matches: () => true }, onCommitted: async () => true,
                pageSources: (host, rows, row) => host.replaceChildren(...rows.map(row)) });` });
    }
    await mount();
    const el = id => page.locator(`#recollect${id}`);
    const open = async (reply = sources) => { replies.push(reply); await el("Activity").click(); await el("Sources").getByText("Copper").waitFor(); };
    const choose = async () => {
        await el("Operation").selectOption(mode);
        await el("Sources").getByLabel("Copper").check(); await el("From").fill(day);
    };
    return { page, mount, calls, replies, el, open, choose };
}

test("exact panel keeps stepped writes bound to the reviewed membership and recovers only the original receipt", async t => {
    const { page, mount, calls, replies, el, open, choose } = await fixture(t);
    await open();
    await expect(el("Operation")).toHaveValue("strict");
    await choose();
    await expect(el("To")).toBeHidden();
    await expect(el("Sources").getByLabel("Tin")).toBeDisabled();
    const reviewed = preview(), step = { operationId, continuation, expiresAt: reviewed.expiresAt, progress };
    replies.push({ ...step, phase: "reading" }, reviewed, { ...step, phase: "verifying" }, new Error("Response lost"));
    await el("Preview").click(); await el("Continue").click();
    await expect(el("ExactMembers").getByRole("listitem")).toHaveCount(2);
    for (const id of memberIds) await expect(el("ExactMembers")).toContainText(`Outcome: unknown. Source-qualified record ID: ${id}`);
    await expect(el("Dialog")).not.toContainText("never-render-span");
    await expect(el("ExactCounts")).toHaveText(/Day coverage is incomplete.*2 proposed; 0 added; 4 excluded.*Unknown outcomes among proposed calls: 2.*Omitted regions: 3/);
    await el("Confirm").click(); await el("Continue").click(); await expect(el("Check")).toBeVisible();
    assert.deepEqual(calls, [
        ["sources", {}], ["preview", { sourceSessionIds: ["Copper"], from: day, to: day, timeContext, restorePrompts: false, mode }],
        ["preview", { operationId, continuation, mode }], ["confirm", { operationId, confirmed: true, mode }],
        ["confirm", { operationId, continuation, mode }],
    ]);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("workiq-evidence.recollection-operation"))), { operationId, receiptToken });
    await mount(); await el("Activity").click();
    replies.push({ ...receipt, operationId: continuation }, receipt);
    await el("Check").click(); await expect(el("Status")).toContainText("does not match");
    await el("Check").click(); await expect(el("Title")).toHaveText("2 verified calls added");
    await expect(el("ScopeUnavailable")).toBeVisible();
    await expect(el("ExactCounts")).toContainText("2 proposed; 2 added; 4 excluded");
    await expect(el("ExactMembers").getByRole("listitem")).toHaveText(memberIds.map(id => `Source-qualified record ID: ${id}`));
    assert.deepEqual(calls.slice(5), Array(2).fill(["status", { operationId, receiptToken }]));
    assert.deepEqual(await page.evaluate(() => {
        const list = document.querySelector("#recollectExactMembers");
        const held = [...list.children].map(li => li.firstChild);
        panel.withdrawAccess();
        return held.map(node => node.data);
    }), ["", ""]);
    assert.equal(calls.length, 7);
});

test("strict is dark by default; exact rejects mismatched scope, malformed membership and expired previews", async t => {
    const { page, calls, replies, el, open, choose } = await fixture(t);
    await open({ ...sources, exactRecordsAvailable: "true" }); await expect(el("Operation")).toBeHidden();
    await el("Sources").getByLabel("Copper").check(); await el("From").fill(day); await el("To").fill(day);
    replies.push(preview()); await el("Preview").click();
    await expect(el("Status")).toContainText("Nothing can be confirmed");
    assert.equal(Object.hasOwn(calls.at(-1)[1], "mode"), false);
    await el("Close").click(); await open(); await choose();
    for (const bad of [{ mode: undefined }, { scope: { ...scope, sourceSessionIds: ["Tin"] } },
        { memberIds, exactMembers: Array(2).fill(preview().exactMembers[0]) }, { expiresAt: "2001-01-01T00:00:00Z" }]) {
        replies.push({ ...preview(), ...bad }); await el("Preview").click();
        await expect(el("Status")).toHaveText(/Preview failed|preview expired/);
        await expect(el("Confirm")).toBeHidden();
    }
    const reviewed = preview();
    replies.push(reviewed, {}); await el("Preview").click(); await expect(el("Confirm")).toBeEnabled();
    await page.evaluate(() => { window.heldRow = document.querySelector("#recollectExactMembers li").firstChild; });
    await el("Change").click();
    assert.equal(await page.evaluate(() => window.heldRow.data), "");
    assert.deepEqual(calls.at(-1), ["cancel", { operationId }]);
    replies.push(reviewed); await el("Preview").click(); await expect(el("Confirm")).toBeEnabled();
    assert.equal(await page.evaluate(() => {
        const row = document.querySelector("#recollectExactMembers li").firstChild;
        panel.withdrawAccess(); document.querySelector("#recollectConfirm").click();
        return row.data;
    }), "");
    assert.deepEqual(calls.map(c => c[0]), ["sources", "preview", "sources", "preview", "preview", "preview", "preview", "preview", "cancel", "preview"]);
});

test("stopping verification leaves only the original receipt to check; no new preview or confirm", async t => {
    const { page, calls, replies, el, open, choose } = await fixture(t);
    await open(); await choose();
    const reviewed = preview();
    replies.push(reviewed, { phase: "verifying", operationId, continuation, expiresAt: reviewed.expiresAt, progress }, {});
    await el("Preview").click(); await el("Confirm").click(); await expect(el("Continue")).toBeVisible();
    await page.evaluate(() => { window.heldRow = document.querySelector("#recollectExactMembers li").firstChild; });
    await el("Close").click(); await expect(el("Dialog")).toBeHidden();
    await el("Activity").click(); await expect(el("Check")).toBeVisible(); await expect(el("Continue")).toBeHidden();
    assert.equal(await page.evaluate(() => window.heldRow.data), "");
    replies.push({ phase: "not-started", operationId }); await el("Check").click();
    await expect(el("Status")).toContainText("Nothing was replayed");
    assert.deepEqual(calls.slice(-2), [["cancel", { operationId }], ["status", { operationId, receiptToken }]]);
    assert.equal(calls.length, 5);
});

test("strict stays the default on an enabled runtime, including both continuation routes", async t => {
    const { el, calls, replies, open } = await fixture(t);
    await open(); await el("Sources").getByLabel("Copper").check();
    await el("From").fill(day); await el("To").fill(day);
    const { expiresAt } = preview(), step = { operationId, expiresAt, continuation, progress };
    replies.push({ ...step, phase: "reading" }, { operationId, receiptToken, scope, expiresAt,
        availability: sources.sources.slice(0, 1), boundary: "Strict review.", counts: { records: 1 } },
    { ...step, phase: "verifying" }, { operationId, phase: "complete", counts: { records: 1 } });
    await el("Preview").click(); await el("Continue").click(); await expect(el("ExactReview")).toBeHidden();
    await el("Confirm").click(); await el("Continue").click(); await expect(el("Title")).toHaveText("1 record read again");
    assert.deepEqual(calls.slice(1), [
        ["preview", { sourceSessionIds: ["Copper"], from: day, to: day, timeContext, restorePrompts: false }],
        ["preview", { operationId, continuation }], ["confirm", { operationId, confirmed: true }], ["confirm", { operationId, continuation }],
    ]);
});
