import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { createAssessmentExperience } from "../web/assessment-experience.mjs";
import { createAssessmentPresentation, createAssessmentWording, createTimingPresentation } from "../web/assessment-presentation.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { createAssessmentControls } from "../web/assessment-controls.mjs";
import { createTextAccess } from "../web/text-access.mjs";
import { createDisclosureState } from "../web/disclosure-state.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { contract, currentView, samples } from "./assessment-ui-fixtures.mjs";

const sourceLabel = "synthetic-scenario";
test("assessment invalidation distinguishes ordinary data from authority and cleanup changes", async t => {
    const browser = await chromium.launch(), page = await browser.newPage();
    t.after(() => browser.close());
    await page.route("https://wire.invalid/", route => route.fulfill({ contentType: "text/html",
        body: '<!doctype html><div id="message"></div>' }));
    await page.goto("https://wire.invalid/");
    await page.addScriptTag({ content: `
        const owner = {};
        const api = Object.assign(async () => { throw Error("No API read is required."); },
            { publicationToken: () => owner, isCurrent: value => value === owner });
        window.reasons = [];
        window.ui = (${createAssessmentExperience.toString()})({api, onChanged() {},
            onInvalidated: (_message, reason) => reasons.push(reason)});
        window.basis = {sourceRevision: 1, membershipRevision: 1, consentRevision: 1, overrideRevision: 1, deletionEpoch: 0};
        ui.receive({schemaVersion: 1, basis, catalog: []});
        ui.receive({schemaVersion: 1, basis: {...basis, sourceRevision: 2, membershipRevision: 2}, catalog: []});
        ui.observe({basis: {...basis, sourceRevision: 3, membershipRevision: 3}});
        ui.observe({basis: {...basis, sourceRevision: 0, membershipRevision: 0}});
        ui.observe({basis: {...basis, sourceRevision: 3, membershipRevision: 3}, pendingCleanup: true, kind: "activity-deletion"});
        for (const key of ["consentRevision", "overrideRevision", "deletionEpoch"]) {
            ui.receive({schemaVersion: 1, basis: {...basis, [key]: 5}, catalog: []});
        }
        ui.receive(null);
    ` });
    assert.deepEqual(await page.evaluate(() => reasons), ["data", "data", "evidence", "evidence", "evidence", "evidence", "evidence", "evidence"]);
});

const answerText = "ARTIFICIAL RESPONSE ONLY\n" + "Exact retained text \u65e5\u672c\u8a9e e\u0301 <not-html> & private. ".repeat(35);
function withResponse() {
    const view = currentView();
    const consent = { ...samples.enabledConsent(), categories: ["answer"] };
    view.basis.consentRevision = 1;
    for (const item of [view.interaction, ...view.observations, ...view.assessments, ...view.metrics]) item.basis = { ...view.basis };
    view.interaction.sourceConfigRef = consent.sourceConfigRef;
    view.interaction.sourceConfigRevision = consent.sourceConfigRevision;
    view.consent = consent;
    view.observations.push({
        schemaVersion: 1, interactionRef: view.interaction.interactionRef, basis: { ...view.basis },
        createdAt: samples.at, evidenceRefs: [samples.id("evidence", 80)], observationRef: samples.id("observation", 80),
        memberRef: null, adapter: "copilot-local-events-v1", kind: "answer", origin: "optional-capture",
        availability: "available", reason: null, occurredAt: samples.at, sourceEventRefs: [samples.id("event", 80)],
        deletionKeys: [...new Set(view.interaction.members.flatMap(member => member.deletionKeys))],
        payload: { textRef: samples.id("text", 80), utf8Bytes: Buffer.byteLength(answerText), completeness: "bounded-fragment", finality: "unverified", credentialScreenVersion: 1, credentialScreen: "passed" },
        captureContext: { consentRevision: 1, sourceConfigRef: consent.sourceConfigRef, sourceConfigRevision: consent.sourceConfigRevision },
    });
    return contract.validateInteractionView(view);
}
function snapshot(view) {
    return {
        schemaVersion: 1, basis: view.basis,
        catalog: [{ scenarioId: sourceLabel, interactionRef: view.interaction.interactionRef, interactionRefs: [view.interaction.interactionRef], status: "retained", reason: null }],
        overview: { interactionRefs: [view.interaction.interactionRef], metrics: view.metrics },
        consent: view.consent, source: { available: true, sourceConfigRef: samples.id("config"), sourceConfigRevision: 1 },
        capabilities: { answer: true, usage: false, explicitAuthorization: false },
    };
}
async function setup(t, initialView = currentView()) {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1200, height: 950 }, reducedMotion: "reduce" });
    const page = await context.newPage(), calls = [], errors = [], unexpected = [];
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); });
    const view = structuredClone(initialView);
    let beforeReply = null;
    const moduleSource = await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8");
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === "https://wire.invalid" && url.pathname === "/") return route.fulfill({
            contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><div id="message"></div><div id="timing"></div><div id="response"></div></main></body></html>',
        });
        if (url.origin === "https://wire.invalid" && url.pathname === "/assets/assessment-contract.mjs") return route.fulfill({ contentType: "text/javascript", body: moduleSource });
        unexpected.push(url.href); return route.abort();
    });
    await page.exposeFunction("syntheticApi", async (path, input) => {
        calls.push({ path, input });
        if (beforeReply) {
            const response = await beforeReply(path, input);
            if (response) return response;
        }
        const envelope = data => ({ ok: true, value: { schemaVersion: 1, basis: view.basis, data } });
        const actions = {
            "/api/assessment/detail": "get_interaction", "/api/assessment/evidence": "get_interaction_evidence",
        };
        contract.validateRequest(actions[path], input);
        if (path.endsWith("/detail")) return envelope(view);
        if (path.endsWith("/evidence")) return envelope({ observationRef: input.observationRef, text: answerText, completeness: "bounded-fragment", finality: "unverified", basis: view.basis });
        throw new Error("Unexpected artificial API path.");
    });
    await page.goto("https://wire.invalid/");
    await page.addStyleTag({ content: styles });
    await page.addScriptTag({ content: `
        window.createExperience = ${createAssessmentExperience.toString()};
        const timing = (${createTimingPresentation.toString()})((${createActivityProjection.toString()})(null, null, ["unknown"]).summarize);
        const wording = (${createAssessmentWording.toString()})();
        window.createPresentation = contract => (${createAssessmentPresentation.toString()})({ ...contract, timing, wording });
        window.createControls = ${createAssessmentControls.toString()};
        window.createText = ${createTextAccess.toString()};
        window.createDisclosure = ${createDisclosureState.toString()};
        window.createUX = ${createEvidenceUX.toString()};
    ` });
    await page.evaluate(icons => {
        const ux = window.createUX(icons);
        const owner = {};
        window.completedCalls = 0;
        window.experience = window.createExperience({
            api: Object.assign(async (path, input) => {
                const result = await window.syntheticApi(path, input);
                window.completedCalls++;
                if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
                return result.value;
            }, { publicationToken: () => owner, isCurrent: token => token === owner }),
            createPresentation: window.createPresentation, createControls: window.createControls,
            ux, textAccess: window.createText(ux, window.createDisclosure()), onChanged() {},
        });
    }, uxIcons);
    await page.evaluate(value => window.experience.receive(value), snapshot(view));
    await page.evaluate(() => document.fonts.ready);
    return {
        page, calls, intercept: callback => { beforeReply = callback; },
        show: () => page.evaluate(label => window.experience.detail(document.getElementById("response"), label,
            { timingHost: document.getElementById("timing") }), sourceLabel),
    };
}

test("reading timing does not disclose reply text; source cleanup withdraws it but artifact cleanup does not", { timeout: 30000 }, async t => {
    const { page, calls, show } = await setup(t, withResponse());
    await show();
    assert.equal(calls.filter(call => call.path.endsWith("/detail")).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith("/evidence")).length, 0);
    await expect(page.locator('#timing [data-definition-id="tool-duration"] data')).toHaveAttribute("value", "1042");
    await expect(page.locator('#timing [data-definition-id="recorded-response-duration"]')).toContainText("Not measured");
    await expect(page.locator("main")).not.toContainText(/Personal feedback|Your feedback|Details and feedback/);
    await page.getByRole("button", { name: "Read response", exact: true }).click();
    const exact = page.getByRole("region", { name: "Retained response text", exact: true }).locator("pre");
    await exact.waitFor();
    assert.equal(await exact.textContent(), answerText);
    assert.equal(await page.locator("not-html").count(), 0);
    assert.equal(calls.filter(call => call.path.endsWith("/evidence")).length, 1);
    await page.getByRole("button", { name: "Hide response", exact: true }).click();
    assert.equal(await page.locator("#response pre").count(), 0);
    await page.getByRole("button", { name: "Read response", exact: true }).click();
    assert.equal(await exact.textContent(), answerText);
    assert.equal(calls.filter(call => call.path.endsWith("/evidence")).length, 1, "Read/hide reuses already-authorized retained text without refetch.");
    await page.evaluate(basis => window.experience.observe({ pendingCleanup: true, kind: "artifact-deletion", basis }), withResponse().basis);
    assert.equal(await exact.textContent(), answerText, "Unrelated saved-object cleanup does not invalidate current source evidence.");
    await page.evaluate(() => window.experience.observe({ pendingCleanup: true, basis: { sourceRevision: 8, membershipRevision: 8, consentRevision: 2, overrideRevision: 0, deletionEpoch: 1 } }));
    assert.equal(await page.locator("#response pre").count(), 0);
    assert.match(await page.locator("#response").textContent(), /cleanup is pending/);
});

test("late evidence response cannot repopulate revoked text", { timeout: 30000 }, async t => {
    const control = await setup(t, withResponse()), { page } = control;
    await control.show();
    let release;
    control.intercept(async (path, input) => {
        if (!path.endsWith("/evidence")) return null;
        return new Promise(resolve => { release = () => resolve({ ok: true, value: { schemaVersion: 1, basis: withResponse().basis, data: {
            observationRef: input.observationRef, text: answerText, completeness: "bounded-fragment", finality: "unverified", basis: withResponse().basis,
        } } }); });
    });
    await page.getByRole("button", { name: "Read response", exact: true }).click();
    await page.getByText("Reading already-retained response...").waitFor();
    await page.evaluate(() => window.experience.invalidate("Response permission was revoked."));
    assert.ok(release); release();
    await page.waitForFunction(() => window.completedCalls === 2);
    assert.equal(await page.locator("#response pre").count(), 0);
    assert.match(await page.locator("#response").textContent(), /permission was revoked/);
});
