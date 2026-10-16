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
async function setup(t, source, consent = prior(), beforeWrite) {
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
    await page.evaluate(snapshot => {
        window.refreshes = 0;
        window.experience = window.makeExperience({
            api: window.syntheticConsentApi, createPresentation: () => ({}), createControls: window.makeControls,
            mountConsent: window.mountConsent, ux: { restoreFocus: node => node?.focus() },
            refresh: () => { window.refreshes++; }, onChanged: () => {}, onNotice: message => { throw new Error(message); },
        });
        window.experience.receive(snapshot);
        return window.experience.setup(document.getElementById("setup"));
    }, snapshot);
    return { page, calls };
}

for (const changed of [
    { name: "source identity", source: { available: true, sourceConfigRef: samples.id("config", 2), sourceConfigRevision: 1 } },
    { name: "source configuration revision", source: { available: true, sourceConfigRef: samples.id("config"), sourceConfigRevision: 2 } },
]) {
    test(`enabled grant for an old ${changed.name} is inactive until explicit renewal for the current source`, { timeout: 30000 }, async t => {
        const { page, calls } = await setup(t, changed.source), pane = page.locator("#setup");
        assert.match(await pane.locator(".assessment-applied").textContent(), /inactive.*source changed/i);
        const check = pane.getByRole("checkbox", { name: "Save Copilot replies locally", exact: true });
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
    const pane = page.locator("#setup"), check = pane.getByRole("checkbox", { name: "Save Copilot replies locally", exact: true });
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
    const pane = page.locator("#setup"), input = pane.getByRole("checkbox", { name: "Save Copilot replies locally", exact: true });
    await input.uncheck();
    await pane.getByRole("button", { name: "Turn off and delete responses", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#setup form").getAttribute("aria-busy") === "true");
    assert.equal(await input.isDisabled(), true);
    assert.equal(await pane.getByRole("button", { name: "Saving...", exact: true }).isDisabled(), true);
    assert.equal(await pane.getByRole("button", { name: "Discard change", exact: true }).isDisabled(), true);
    assert.match(await pane.locator(".assessment-applied").textContent(), /Response saving is on/, "Pending drafts cannot claim to be the applied state");
    assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 1);
    release();
    await pane.getByRole("button", { name: "Check update result", exact: true }).waitFor();
    assert.equal(await input.isDisabled(), true);
    assert.equal(await pane.getByRole("button", { name: "Turn off and delete responses", exact: true }).isDisabled(), true);
    assert.equal(await pane.getByRole("button", { name: "Discard change", exact: true }).count(), 0);
    assert.match(await pane.getByRole("alert").textContent(), /Synthetic unconfirmed.*Check the original result; do not repeat/);
    assert.equal(calls.filter(call => call.path.endsWith("/set")).length, 1);
});
