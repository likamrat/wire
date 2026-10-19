import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createAssessmentExperience } from "../web/assessment-experience.mjs";
import { createAssessmentControls } from "../web/assessment-controls.mjs";
import { mountConsentSetup } from "../web/assessment-control-views.mjs";
import { contract, samples } from "./assessment-ui-fixtures.mjs";
import { styles } from "../web/styles.mjs";
import { assessmentPresentationStyles } from "../web/assessment-presentation.mjs";

const prior = () => ({ ...samples.enabledConsent(), categories: ["answer"] });
const initialBasis = { ...samples.basis(), consentRevision: 1 };
async function setup(t, source, consent = prior(), beforeWrite, options = {}) {
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, reducedMotion: "reduce" });
    const calls = [], errors = [], unexpected = [];
    const moduleSource = await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8");
    const snapshot = {
        schemaVersion: 1, basis: initialBasis, catalog: [], overview: { interactionRefs: [], metrics: [] },
        consent, source, capabilities: { answer: true, usage: false, explicitAuthorization: false },
    };
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() === "GET" && url.origin === "https://wire.invalid" && url.pathname === "/") return route.fulfill({
            contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><div id="message"></div><section><h2>Recorded replies</h2><div id="setup"></div></section></main></body></html>',
        });
        if (request.method() === "GET" && url.origin === "https://wire.invalid" && url.pathname === "/assets/assessment-contract.mjs") return route.fulfill({ contentType: "text/javascript", body: moduleSource });
        unexpected.push(url.href); return route.abort();
    });
    await page.exposeFunction("syntheticConsentApi", async (path, input) => {
        calls.push({ path, input });
        if (path === "/api/assessment/consent") {
            contract.validateRequest("get_assessment_consent", input);
            return { schemaVersion: 1, basis: initialBasis, data: { consent, source, capabilities: snapshot.capabilities } };
        }
        if (path === "/api/assessment/mutation/status") {
            contract.validateRequest("get_mutation_status", input);
            assert.equal(typeof options.status, "function", "Only explicitly simulated receipt reads are allowed.");
            return options.status(input);
        }
        assert.equal(path, "/api/assessment/consent/set");
        contract.validateRequest("set_assessment_consent", input);
        await beforeWrite?.();
        const next = {
            ...consent, state: input.enabled ? "enabled" : "revoked", categories: input.categories,
            revision: consent.revision + 1, sourceConfigRef: input.sourceConfigRef, sourceConfigRevision: input.sourceConfigRevision,
            revokedAt: input.enabled ? null : samples.at,
        };
        contract.validateConsent(next);
        return { schemaVersion: 1, mutationRef: input.mutationRef, phase: "complete", basis: { ...initialBasis, consentRevision: next.revision }, data: { consent: next } };
    });
    await page.goto("https://wire.invalid/");
    await page.addStyleTag({ content: styles + assessmentPresentationStyles });
    await page.addScriptTag({ content: `
        window.makeExperience = ${createAssessmentExperience.toString()};
        window.makeControls = ${createAssessmentControls.toString()};
        window.mountConsent = ${mountConsentSetup.toString()};
    ` });
    await page.evaluate(({ snapshot, stored }) => {
        for (const [key, value] of Object.entries(stored)) sessionStorage.setItem(key, value);
        window.refreshes = 0;
        window.experience = window.makeExperience({
            api: window.syntheticConsentApi, createPresentation: () => ({}), createControls: window.makeControls,
            mountConsent: window.mountConsent, ux: { restoreFocus: node => node?.focus() },
            refresh: () => { window.refreshes++; }, onChanged: () => {}, onNotice: message => { throw new Error(message); },
        });
        window.experience.receive(snapshot);
        return window.experience.setup(document.getElementById("setup"));
    }, { snapshot, stored: options.stored ?? {} });
    return { page, calls };
}

for (const changed of [
    { name: "source identity", source: { available: true, sourceConfigRef: samples.id("config", 2), sourceConfigRevision: 1 } },
    { name: "source configuration revision", source: { available: true, sourceConfigRef: samples.id("config"), sourceConfigRevision: 2 } },
]) {
    test(`enabled grant for an old ${changed.name} is inactive until explicit renewal for the current source`, { timeout: 30000 }, async t => {
        const { page, calls } = await setup(t, changed.source), pane = page.locator("#setup");
        assert.match(await pane.locator(".assessment-applied").textContent(), /inactive.*source changed/i);
        const check = pane.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
        assert.equal(await check.isChecked(), false);
        assert.equal(await pane.getByRole("button", { name: "Save response setting", exact: true, includeHidden: true }).isEnabled(), false);
        assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 0);
        await check.check();
        assert.equal(await pane.getByRole("button", { name: "Turn on response saving", exact: true }).isEnabled(), true);
        assert.equal(await pane.getByRole("button", { name: "Turn on response saving", exact: true }).evaluate(node => node.classList.contains("danger")), true,
            "Renewal purges prior optional evidence, unlike first-time capture");
        assert.equal(await pane.getByText("Enabling capture for this source removes prior saved response text and dependent retained annotations. Ordinary collected activity and saved reports stay available.", { exact: true }).isVisible(), true);
        await pane.getByRole("button", { name: "Discard change", exact: true }).click();
        assert.equal(await check.isChecked(), false);
        assert.equal(await pane.getByRole("button", { name: "Save response setting", exact: true, includeHidden: true }).evaluate(node => node.classList.contains("danger")), false);
        assert.equal(await pane.getByText(/Enabling capture for this source removes/).isVisible(), false);
        assert.match(await pane.locator(".assessment-applied").textContent(), /inactive.*source changed/i);
        assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 0);
        await check.check();
        await pane.getByRole("button", { name: "Turn on response saving", exact: true }).click();
        await page.waitForFunction(() => window.refreshes === 1);
        const writes = calls.filter(call => call.path.endsWith("/set"));
        assert.equal(writes.length, 1);
        assert.equal(writes[0].input.sourceConfigRef, changed.source.sourceConfigRef);
        assert.equal(writes[0].input.sourceConfigRevision, changed.source.sourceConfigRevision);
        assert.equal(writes[0].input.expectedConsentRevision, 1);
        assert.equal(writes[0].input.expectedSourceRevision, initialBasis.sourceRevision);
        assert.equal(writes[0].input.confirmed, true);
        assert.deepEqual(writes[0].input.categories, ["answer"]);
        const capture = {
            category: "answer", adapter: "copilot-local-events-v1", expectedConsentRevision: prior().revision,
            sourceConfigRef: changed.source.sourceConfigRef, sourceConfigRevision: changed.source.sourceConfigRevision,
            sourceApproved: true, alreadyRecorded: true, credentialScreen: "passed", utf8Bytes: 24,
            retainedItemCount: 0, retainedTotalBytes: 0,
        };
        assert.deepEqual(contract.captureDecision(prior(), capture), { allowed: false, reason: "stale-source" }, "The old grant never authorizes this current source.");
        assert.equal(await pane.locator("input[type=checkbox]").isChecked(), true);
        assert.equal(await pane.locator(".assessment-applied").isVisible(), false);
        assert.equal(await pane.getByRole("button", { name: "Save response setting", exact: true, includeHidden: true }).isEnabled(), false);
    });
}

test("same-source enabled state stays unchanged and disabled until edited", { timeout: 30000 }, async t => {
    const { page, calls } = await setup(t, { available: true, sourceConfigRef: samples.id("config"), sourceConfigRevision: 1 });
    const pane = page.locator("#setup"), check = pane.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
    assert.equal(await pane.getByRole("button", { name: "Remove previously saved responses", exact: true }).isVisible(), false);
    assert.equal(await pane.getByText(/Enabling capture for this source removes/).isVisible(), false);
    assert.equal(await check.isChecked(), true);
    assert.equal(await pane.getByRole("button", { name: "Save response setting", exact: true, includeHidden: true }).isEnabled(), false);
    await check.uncheck();
    assert.equal(await pane.getByRole("button", { name: "Turn off and delete responses", exact: true }).isEnabled(), true);
    assert.equal(await pane.getByRole("button", { name: "Turn off and delete responses", exact: true }).evaluate(node => node.classList.contains("danger")), true);
    await pane.getByRole("button", { name: "Discard change", exact: true }).click();
    assert.equal(await check.isChecked(), true);
    assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 0);
});

test("a changed-source prior grant can be revoked without renewing or enabling capture", { timeout: 30000 }, async t => {
    const source = { available: true, sourceConfigRef: samples.id("config", 2), sourceConfigRevision: 3 };
    const { page, calls } = await setup(t, source), pane = page.locator("#setup");
    assert.equal(await pane.getByRole("button", { name: "Remove previously saved responses", exact: true }).evaluate(node => node.classList.contains("danger")), true);
    await pane.getByRole("button", { name: "Remove previously saved responses", exact: true }).click();
    assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 0);
    await pane.getByRole("button", { name: "Discard change", exact: true }).click();
    assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 0);
    await pane.getByRole("button", { name: "Remove previously saved responses", exact: true }).click();
    await pane.getByRole("button", { name: "Turn off and delete responses", exact: true }).click();
    await page.waitForFunction(() => window.refreshes === 1);
    const writes = calls.filter(call => call.path.endsWith("/set"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].input.enabled, false);
    assert.deepEqual(writes[0].input.categories, []);
    assert.equal(writes[0].input.sourceConfigRef, source.sourceConfigRef);
    assert.equal(writes[0].input.sourceConfigRevision, source.sourceConfigRevision);
});

test("unavailable current source never claims active capture and still permits revocation of the prior grant", { timeout: 30000 }, async t => {
    const { page, calls } = await setup(t, { available: false, sourceConfigRef: null, sourceConfigRevision: 0 });
    const pane = page.locator("#setup");
    assert.match(await pane.locator(".assessment-applied").textContent(), /inactive.*source is unavailable/i);
    const revoke = pane.getByRole("button", { name: "Remove previously saved responses", exact: true });
    assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 0);
    await revoke.click();
    const save = pane.getByRole("button", { name: "Turn off and delete responses", exact: true });
    assert.equal(await save.isEnabled(), true, "Revocation first creates an explicit draft, not an automatic write.");
    assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 0);
    await save.click();
    await page.waitForFunction(() => window.refreshes === 1);
    const writes = calls.filter(call => call.path.endsWith("/set"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].input.enabled, false);
    assert.equal(writes[0].input.sourceConfigRef, prior().sourceConfigRef);
    assert.equal(writes[0].input.sourceConfigRevision, prior().sourceConfigRevision);
    assert.deepEqual(writes[0].input.categories, []);
});

test("response saving keeps pending and uncertain writes explicit without offering a false discard", { timeout: 30000 }, async t => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const { page, calls } = await setup(t, { available: true, sourceConfigRef: samples.id("config"), sourceConfigRevision: 1 }, prior(), async () => {
        await held;
        throw new Error("Synthetic unconfirmed response-saving update.");
    });
    const pane = page.locator("#setup"), input = pane.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
    await input.uncheck();
    await pane.getByRole("button", { name: "Turn off and delete responses", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#setup form").getAttribute("aria-busy") === "true");
    assert.equal(await input.isDisabled(), true);
    assert.equal(await pane.getByRole("button", { name: "Saving...", exact: true }).isDisabled(), true);
    assert.equal(await pane.getByRole("button", { name: "Discard change", exact: true }).isDisabled(), true);
    assert.match(await pane.locator(".assessment-applied").textContent(), /Response saving is on/, "Pending drafts cannot claim to be the applied state");
    assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 1);
    release();
    await pane.getByRole("button", { name: "Check response-saving result", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Check response-saving result", exact: true }).count(), 1);
    assert.equal(await pane.getByRole("button", { name: "Check update result", exact: true }).count(), 0);
    assert.equal(await input.isDisabled(), true);
    assert.equal(await pane.getByRole("button", { name: "Turn off and delete responses", exact: true }).isDisabled(), true);
    assert.equal(await pane.getByRole("button", { name: "Discard change", exact: true }).count(), 0);
    assert.match(await pane.getByRole("alert").textContent(), /Synthetic unconfirmed.*Check the original result; do not repeat/);
    assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 1);
});

test("matching reply recovery follows its rendered owner, preserves focus and keeps the latest original-receipt read", { timeout: 30000 }, async t => {
    const currentKey = "wire.responseCapture.pending", legacyKey = "wire.assessment.pending";
    const { page, calls } = await setup(t, { available: true, sourceConfigRef: samples.id("config"), sourceConfigRevision: 1 },
        prior(), () => { throw new Error("Synthetic unknown response-saving result."); }, {
            status: input => ({ schemaVersion: 1, mutationRef: input.mutationRef, phase: "pending" }),
        });
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.evaluate(() => { document.documentElement.dataset.evidenceTheme = "dark"; document.documentElement.style.fontSize = "200%"; });
    await page.getByRole("switch").uncheck();
    assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 0);
    await page.getByRole("button", { name: "Turn off and delete responses", exact: true }).click();
    const notice = page.locator(".assessment-recovery"), action = notice.getByRole("button");
    await action.waitFor();
    const raw = await page.evaluate(key => sessionStorage.getItem(key), currentKey);
    assert.equal(await page.locator("#setup .assessment-recovery").count(), 1);
    assert.equal(await page.getByRole("alert").count(), 1);
    assert.equal(await page.getByRole("button", { name: "Check update result", exact: true }).count(), 0);
    await action.focus();
    const migration = await page.evaluate(() => {
        const node = document.activeElement, host = document.getElementById("setup");
        let finish = window.experience.prepareRecoveryPresentation();
        host.hidden = true; finish();
        const away = document.activeElement === node && !host.contains(node);
        finish = window.experience.prepareRecoveryPresentation();
        host.hidden = false; finish();
        return { away, returned: document.activeElement === node && host.contains(node) };
    });
    assert.deepEqual(migration, { away: true, returned: true });
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    assert.equal(await page.locator("#setup .assessment-recovery").count(), 1, "Viewport scrolling never changes ownership.");
    for (const value of [
        { ...JSON.parse(raw), mutationRef: samples.id("mutation", 96) },
        { ...JSON.parse(raw), receiptToken: "b".repeat(64) },
        { ...JSON.parse(raw), receiptToken: undefined },
    ]) {
        await page.evaluate(async ({ key, value }) => {
            sessionStorage.setItem(key, JSON.stringify(value));
            await window.experience.setup(document.getElementById("setup"));
        }, { key: currentKey, value });
        assert.equal(await page.locator("#setup .assessment-recovery").count(), 0);
        assert.equal(await notice.isVisible(), true);
        assert.deepEqual(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), currentKey), JSON.parse(JSON.stringify(value)));
    }
    await page.evaluate(async ({ currentKey, legacyKey, raw }) => {
        sessionStorage.setItem(currentKey, raw); sessionStorage.setItem(legacyKey, raw);
        await window.experience.setup(document.getElementById("setup"));
    }, { currentKey, legacyKey, raw });
    assert.equal(await page.locator("#setup .assessment-recovery").count(), 0);
    await page.evaluate(async ({ legacyKey }) => {
        sessionStorage.removeItem(legacyKey);
        const finish = window.experience.prepareRecoveryPresentation();
        document.getElementById("setup").hidden = true; finish();
    }, { legacyKey });
    await action.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".assessment-recovery p").textContent.includes("still pending"));
    await page.evaluate(() => {
        const finish = window.experience.prepareRecoveryPresentation();
        document.getElementById("setup").hidden = false; finish();
    });
    assert.equal(await page.locator("#setup .assessment-recovery").count(), 1);
    assert.match(await notice.innerText(), /still pending/);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), currentKey), raw);
    const reads = calls.filter(call => call.path.endsWith("/mutation/status"));
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0].input, { schemaVersion: 1, mutationRef: JSON.parse(raw).mutationRef, receiptToken: JSON.parse(raw).receiptToken });
    assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 1);
    await page.evaluate(async () => {
        window.experience.receive(null);
        await window.experience.setup(document.getElementById("setup"));
    });
    assert.equal(await page.locator("#setup .assessment-recovery").count(), 0);
    assert.equal(await notice.isVisible(), true, "Replacing unavailable inline content must not detach unresolved global recovery.");
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), currentKey), raw);
});

for (const kind of ["legacy", "multiple", "missing-token", "malformed"]) test(`${kind} receipts stay global without automatic reads or writes`, async t => {
    const value = { action: "set_assessment_consent", mutationRef: samples.id("mutation", 97), receiptToken: "c".repeat(64) };
    const raw = JSON.stringify(value);
    const stored = kind === "legacy" ? { "wire.assessment.pending": raw }
        : kind === "multiple" ? { "wire.responseCapture.pending": raw, "wire.assessment.pending": raw }
            : { "wire.responseCapture.pending": kind === "malformed" ? "not-json" : JSON.stringify({ ...value, receiptToken: undefined }) };
    const { page, calls } = await setup(t, { available: true, sourceConfigRef: samples.id("config"), sourceConfigRevision: 1 }, prior(), undefined, { stored });
    assert.equal(await page.locator(".assessment-recovery").isVisible(), true);
    assert.equal(await page.locator("#setup .assessment-recovery").count(), 0);
    assert.equal(await page.getByRole("switch").isDisabled(), true);
    assert.deepEqual(calls.map(value => value.path), ["/api/assessment/consent"]);
    for (const [key, value] of Object.entries(stored)) assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key), value);
});
