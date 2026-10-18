import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { retirementFixture, retirementClient } from "./ai-review-retirement-fixture.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";

const currentKey = "wire.responseCapture.pending", legacyKey = "wire.assessment.pending";
const identity = () => ({ mutationRef: "mutation-" + randomBytes(16).toString("hex"), receiptToken: randomBytes(32).toString("hex") });
const receipt = (id, action = "set_assessment_consent") => JSON.stringify({ ...id, action });

async function setup(t) {
    const cleanups = [], fixture = await retirementFixture({ after: action => cleanups.push(action) });
    const runtime = await startServer(fixture.context, createExportController(fixture.context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 950 }, reducedMotion: "reduce" });
    const writes = [], statusReads = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.endsWith("/consent/set") || pathname.endsWith("/feedback")) writes.push(pathname);
        if (pathname.endsWith("/mutation/status")) statusReads.push(request.postDataJSON());
    });
    t.after(async () => {
        try { await browser.close(); await runtime.close(); assert.deepEqual(errors, []); }
        finally { for (const action of cleanups.reverse()) await action(); }
    });
    const api = await retirementClient(runtime);
    async function consent(enabled) {
        const current = (await api("/api/assessment/consent", { schemaVersion: 1 })).body, id = identity();
        const result = await api("/api/assessment/consent/set", {
            schemaVersion: 1, ...id, expectedSourceRevision: current.basis.sourceRevision,
            expectedConsentRevision: current.data.consent.revision, policyVersion: 1, enabled, categories: enabled ? ["answer"] : [],
            sourceConfigRef: current.data.source.sourceConfigRef, sourceConfigRevision: current.data.source.sourceConfigRevision, confirmed: true,
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return id;
    }
    async function open(entries, unreadable = false) {
        await page.addInitScript(({ entries, unreadable, legacyKey }) => {
            for (const [key, value] of Object.entries(entries)) sessionStorage.setItem(key, value);
            window.removedReceiptKeys = [];
            const remove = Storage.prototype.removeItem, get = Storage.prototype.getItem;
            Storage.prototype.removeItem = function (key) { window.removedReceiptKeys.push(key); return remove.call(this, key); };
            if (unreadable) Storage.prototype.getItem = function (key) {
                if (this === sessionStorage && key === legacyKey) throw new Error("Invented unreadable receipt storage");
                return get.call(this, key);
            };
        }, { entries, unreadable, legacyKey });
        await page.goto(runtime.url + "#settings?section=privacy");
        await expect(page.getByRole("switch", { name: "Save Copilot replies locally", exact: true })).toBeVisible();
    }
    return { ...fixture, page, writes, statusReads, consent, open };
}

test("retired personal receipt stays untouched while new response-saving consent uses its own key", async t => {
    const f = await setup(t), old = receipt({ mutationRef: f.personalMutationRef, receiptToken: f.receiptToken }, "set_personal_assessment");
    const before = await loadBoardState(f.context);
    await f.open({ [legacyKey]: old });
    const choice = f.page.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
    await expect(choice).toBeEnabled();
    await expect(f.page.locator(".assessment-recovery")).toBeHidden();
    await choice.check();
    await f.page.getByRole("button", { name: "Turn on response saving", exact: true }).click();
    await expect(choice).toBeEnabled();
    await expect(choice).toBeChecked();
    assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), legacyKey), old);
    assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), currentKey), null);
    assert.deepEqual(f.writes, ["/api/assessment/consent/set"]);
    assert.deepEqual(f.statusReads, []);
    const after = await loadBoardState(f.context);
    assert.deepEqual(after.personalEvaluation.feedback, before.personalEvaluation.feedback);
    assert.deepEqual(after.personalEvaluation.mutations[f.personalMutationRef], before.personalEvaluation.mutations[f.personalMutationRef]);
    assert.equal(await f.page.getByText(/Personal feedback|Your feedback/).count(), 0);
});

test("coexisting current and legacy consent receipts block changes and resolve only their exact owning slots", async t => {
    const f = await setup(t), oldId = await f.consent(false), newId = await f.consent(true);
    const old = receipt(oldId), current = receipt(newId), before = await loadBoardState(f.context);
    await f.open({ [legacyKey]: old, [currentKey]: current });
    const choice = f.page.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
    await expect(choice).toBeDisabled();
    await expect(f.page.locator(".assessment-recovery")).toContainText("Two response-saving updates");
    await f.page.getByRole("button", { name: "Check response-saving result", exact: true }).click();
    await expect(f.page.getByRole("button", { name: "Check earlier response-saving result", exact: true })).toBeEnabled();
    assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), currentKey), null);
    assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), legacyKey), old);
    await expect(choice).toBeDisabled();
    await f.page.getByRole("button", { name: "Check earlier response-saving result", exact: true }).click();
    await expect(choice).toBeEnabled(); await expect(choice).toBeChecked();
    assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), legacyKey), null);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.statusReads.map(input => input.mutationRef), [newId.mutationRef, oldId.mutationRef]);
    assert.deepEqual(await loadBoardState(f.context), before, "Status reads cannot restore an older consent or rewrite receipts.");
});

test("a newer receipt cannot be cleared by a late read of an older terminal result", async t => {
    const f = await setup(t), oldId = await f.consent(false), replacement = receipt(identity());
    const before = await loadBoardState(f.context);
    await f.page.route("**/api/assessment/mutation/status", async route => {
        const response = await route.fetch();
        await f.page.evaluate(({ key, replacement }) => sessionStorage.setItem(key, replacement), { key: currentKey, replacement });
        await route.fulfill({ response });
    });
    await f.open({ [currentKey]: receipt(oldId) });
    await f.page.getByRole("button", { name: "Check response-saving result", exact: true }).click();
    await expect(f.page.locator("#message")).toContainText("receipt changed");
    assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), currentKey), replacement);
    assert.deepEqual(await f.page.evaluate(() => window.removedReceiptKeys), []);
    await expect(f.page.getByRole("switch", { name: "Save Copilot replies locally", exact: true })).toBeDisabled();
    assert.deepEqual(f.writes, []);
    assert.deepEqual(await loadBoardState(f.context), before);
});

for (const kind of ["malformed", "unclassifiable-personal", "unreadable"]) test(`${kind} legacy receipt is preserved and blocks new consent without guessing`, async t => {
    const f = await setup(t), before = await loadBoardState(f.context);
    const raw = kind === "malformed" ? "not-json" : kind === "unclassifiable-personal"
        ? receipt({ mutationRef: "not-an-identity", receiptToken: f.receiptToken }, "set_personal_assessment")
        : receipt(identity());
    await f.open({ [legacyKey]: raw }, kind === "unreadable");
    await expect(f.page.getByRole("switch", { name: "Save Copilot replies locally", exact: true })).toBeDisabled();
    await expect(f.page.locator(".assessment-recovery")).toContainText("could not be read");
    assert.deepEqual(await f.page.evaluate(() => window.removedReceiptKeys), []);
    if (kind !== "unreadable") assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), legacyKey), raw);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.statusReads, []);
    assert.deepEqual(await loadBoardState(f.context), before);
});

for (const field of ["mutationRef", "receiptToken"]) test(`array-valued ${field} cannot exempt a malformed personal receipt or permit consent`, async t => {
    const f = await setup(t), before = await loadBoardState(f.context);
    const id = { mutationRef: f.personalMutationRef, receiptToken: f.receiptToken };
    const raw = receipt({ ...id, [field]: [id[field]] }, "set_personal_assessment");
    await f.open({ [legacyKey]: raw });
    const choice = f.page.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
    if (await choice.isEnabled()) {
        await choice.check();
        const response = f.page.waitForResponse(result => result.url().endsWith("/api/assessment/consent/set"));
        await f.page.getByRole("button", { name: "Turn on response saving", exact: true }).click();
        await response;
    }
    assert.deepEqual(f.writes, [], "Malformed receipt storage must prevent a consent mutation, not merely display a warning.");
    assert.deepEqual(f.statusReads, []);
    assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), legacyKey), raw);
    assert.equal(await f.page.evaluate(key => sessionStorage.getItem(key), currentKey), null);
    assert.deepEqual(await f.page.evaluate(() => window.removedReceiptKeys), []);
    assert.deepEqual(await loadBoardState(f.context), before);
    await expect(choice).toBeDisabled();
    await expect(f.page.locator(".assessment-recovery")).toContainText("could not be read");
});
