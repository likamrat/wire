import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createAssessmentExperience } from "../web/assessment-experience.mjs";
import { createAssessmentPresentation, createAssessmentWording, renderAssessmentSummary, assessmentPresentationStyles, createTimingPresentation, renderRecordedTiming } from "../web/assessment-presentation.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { createAssessmentControls } from "../web/assessment-controls.mjs";
import { mountConsentSetup, mountPersonalFeedback } from "../web/assessment-control-views.mjs";
import { createTextAccess } from "../web/text-access.mjs";
import { createDisclosureState } from "../web/disclosure-state.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { createControlHelp } from "../lib/control-help.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { contract, currentView, samples, quality } from "./assessment-ui-fixtures.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";

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
    let view = structuredClone(initialView), beforeReply = null, feedbackReceipt = null;
    const moduleSource = await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8");
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === "https://wire.invalid" && url.pathname === "/") return route.fulfill({
            contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><div id="message"></div><div id="summary"></div><div id="response"></div><div id="setup"></div></main></body></html>',
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
            "/api/assessment/detail": "get_interaction", "/api/assessment/overview": "get_assessment_overview",
            "/api/assessment/consent": "get_assessment_consent", "/api/assessment/evidence": "get_interaction_evidence",
            "/api/assessment/feedback": "set_personal_assessment", "/api/assessment/mutation/status": "get_mutation_status",
        };
        contract.validateRequest(actions[path], input);
        if (path.endsWith("/detail")) return envelope(view);
        if (path.endsWith("/overview")) return envelope({ interactionRefs: input.interactionRefs, metrics: input.interactionRefs.length ? view.metrics : [] });
        if (path.endsWith("/consent")) return envelope({ consent: view.consent, source: snapshot(view).source, capabilities: snapshot(view).capabilities });
        if (path.endsWith("/evidence")) return envelope({ observationRef: input.observationRef, text: answerText, completeness: "bounded-fragment", finality: "unverified", basis: view.basis });
        if (path.endsWith("/feedback")) {
            const assessment = {
                ...samples.makeAssessment(true), interactionRef: view.interaction.interactionRef, unitRef: view.interaction.interactionRef,
                checkId: input.checkId, verdict: input.verdict, basis: { ...view.basis, sourceRevision: view.basis.sourceRevision + 1, membershipRevision: view.basis.membershipRevision + 1, overrideRevision: view.basis.overrideRevision + 1 },
            };
            feedbackReceipt = { schemaVersion: 1, mutationRef: input.mutationRef, phase: "complete", basis: assessment.basis, data: { assessment } };
            return { ok: false, message: "Artificial lost mutation response." };
        }
        if (path.endsWith("/mutation/status")) return { ok: true, value: feedbackReceipt ?? { schemaVersion: 1, mutationRef: input.mutationRef, phase: "not-started" } };
        throw new Error("Unexpected artificial API path.");
    });
    await page.goto("https://wire.invalid/");
    await page.addStyleTag({ content: styles + assessmentPresentationStyles });
    await page.addScriptTag({ content: `
        window.createExperience = ${createAssessmentExperience.toString()};
        const timing = (${createTimingPresentation.toString()})((${createActivityProjection.toString()})(null, null, ["unknown"]).summarize);
        const renderTiming = ${renderRecordedTiming.toString()};
        const wording = (${createAssessmentWording.toString()})();
        window.createPresentation = contract => (${createAssessmentPresentation.toString()})({ ...contract, timing, wording });
        window.renderSummary = (root, model, options) => (${renderAssessmentSummary.toString()})(root, model, { ...options, renderTiming, wording });
        window.createControls = ${createAssessmentControls.toString()};
        window.mountConsent = ${mountConsentSetup.toString()};
        window.mountFeedback = (root, options) => (${mountPersonalFeedback.toString()})(root, { ...options, wording });
        window.createText = ${createTextAccess.toString()};
        window.createDisclosure = ${createDisclosureState.toString()};
        window.createUX = ${createEvidenceUX.toString()};
    ` });
    await page.evaluate(({ icons, glossary }) => {
        const ux = window.createUX(icons);
        window.refreshCount = 0; window.changedCount = 0; window.notices = [];
        window.experience = window.createExperience({
            api: async (path, input) => {
                const result = await window.syntheticApi(path, input);
                if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
                return result.value;
            },
            createPresentation: window.createPresentation, renderSummary: window.renderSummary, createControls: window.createControls,
            mountConsent: window.mountConsent, mountFeedback: window.mountFeedback,
            ux, glossary, textAccess: window.createText(ux, window.createDisclosure()),
            refresh: () => { window.refreshCount++; }, onChanged: () => { window.changedCount++; }, onNotice: message => window.notices.push(message),
        });
    }, { icons: uxIcons, glossary: createControlHelp(createServiceCategories()).glossary });
    await page.evaluate(value => window.experience.receive(value), snapshot(view));
    await page.evaluate(() => document.fonts.ready);
    return {
        page, calls, setView: value => { view = value; }, intercept: callback => { beforeReply = callback; },
        show: () => page.evaluate(label => window.experience.detail(document.getElementById("summary"), document.getElementById("response"), label), sourceLabel),
        receive: value => page.evaluate(value => window.experience.receive(value), snapshot(value)),
    };
}

test("single definition table retains evaluator provider, review model and rubric provenance", async t => {
    const { model } = qualityDisplayFixture({ requests: 1, calls: 1, judgments: ["fail"] });
    const view = [...model.details.values()][0], evidence = view.metrics.find(metric => metric.checkId === "answer-evidence-present");
    Object.assign(evidence, { status: "evaluator-error", reason: "evaluator-failure",
        counts: { pass: 0, fail: 0, unassessed: 0, evaluatorError: 1 }, unassessedReasons: [] });
    contract.validateInteractionView(view);
    const before = structuredClone(view);
    const { page, show, calls } = await setup(t, view);
    await show();
    await page.getByRole("button", { name: "Details and feedback", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Insight details", exact: true });
    await dialog.getByText("Recorded measures and definitions", { exact: true }).click();
    const error = dialog.locator('[data-check-id="answer-evidence-present"]');
    assert.equal(await error.locator(".single-measure-value.error").textContent(), "Check unavailable");
    assert.doesNotMatch(await error.innerText(), /No readable reply saved/);
    for (const metric of view.metrics.filter(metric => metric.origin === "model-assessed")) {
        const row = dialog.locator(`[data-metric-ref="${metric.metricRef}"]`);
        assert.equal(await row.locator(".single-measure-evaluator").textContent(),
            `Review model: ${metric.evaluator.provider} / ${metric.evaluator.model}; rubric ${metric.evaluator.rubricId} v${metric.evaluator.rubricVersion}`);
        assert.deepEqual(await row.evaluate(node => ({
            provider: node.dataset.evaluatorProvider, model: node.dataset.evaluatorModel,
            rubricId: node.dataset.evaluatorRubricId, rubricVersion: Number(node.dataset.evaluatorRubricVersion),
        })), metric.evaluator);
        assert.equal(await row.getAttribute("data-metric-status"), metric.status);
        assert.equal(await row.getAttribute("data-value"), String(metric.value));
    }
    assert.deepEqual(view, before);
    assert.ok(calls.every(call => call.path.endsWith("/detail")));
    if (process.env.WIRE_STORY_BASIS_PROOFS) {
        await mkdir(process.env.WIRE_STORY_BASIS_PROOFS, { recursive: true });
        await page.setViewportSize({ width: 1280, height: 2200 });
        await page.screenshot({ path: path.join(process.env.WIRE_STORY_BASIS_PROOFS, "review-basis-and-error.png") });
    }
});

test("single definition grouping keeps differing causes and temporal qualifications separate", async t => {
    for (const kind of ["cause", "time"]) await t.test(kind, async t => {
        const view = currentView(), metric = view.metrics.find(metric => metric.dimension === "accuracy");
        if (kind === "cause") metric.unassessedReasons = [{ reason: "missing-evidence", count: 1 }];
        else metric.observedTime = { state: "withheld", firstAt: null, lastAt: null, datedUnits: 0, undatedUnits: 1 };
        contract.validateInteractionView(view);
        const before = structuredClone(view), { page, show } = await setup(t, view);
        await show();
        await page.getByRole("button", { name: "Details and feedback", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Insight details", exact: true });
        await dialog.getByText("Recorded measures and definitions", { exact: true }).click();
        const row = dialog.locator(`tr[data-metric-ref="${metric.metricRef}"]`);
        assert.equal(await row.count(), 1, "A distinct qualification must not merge into the common placeholder row");
        assert.equal(await row.getAttribute("data-unassessed-reasons"), JSON.stringify(metric.unassessedReasons ?? null));
        assert.equal(await row.getAttribute("data-observed-time"), JSON.stringify(metric.observedTime));
        if (kind === "cause") assert.match(await row.innerText(), /1 missing-evidence/);
        assert.deepEqual(view, before);
    });
});

test("interaction insights preserve separate trust states and request private response only on explicit Read", { timeout: 30000 }, async t => {
    const { page, calls, show } = await setup(t, withResponse());
    await show();
    assert.equal(calls.filter(call => call.path.endsWith("/detail")).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith("/evidence")).length, 0);
    assert.deepEqual(await page.locator('#summary .assessment-check .assessment-value').allTextContents(), ["No result", "No result", "No result"]);
    assert.doesNotMatch(await page.locator("#summary").textContent(), /Whole-interaction latency/);
    assert.match(await page.locator("#summary").textContent(), /Results for 0 of 1 request/);
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

test("late evidence response cannot repopulate revoked text or supersede a newer view", { timeout: 30000 }, async t => {
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
    await page.waitForFunction(() => !document.querySelector("#response")?.textContent.includes("Reading already-retained"));
    assert.equal(await page.locator("#response pre").count(), 0);
    assert.match(await page.locator("#response").textContent(), /permission was revoked/);
});

test("personal feedback uncertain result recovers by status without replay and accepts committed next basis", { timeout: 30000 }, async t => {
    const { page, calls, show } = await setup(t);
    await show();
    await page.getByRole("button", { name: "Details and feedback", exact: true }).click();
    await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Your feedback: answer correctness", exact: true });
    await dialog.getByRole("combobox", { name: "Your assessment", exact: true }).selectOption("pass");
    await dialog.getByRole("button", { name: "Save feedback", exact: true }).click();
    await dialog.getByRole("button", { name: "Check update result", exact: true }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Save feedback", exact: true }).isEnabled(), false);
    await dialog.getByRole("button", { name: "Check update result", exact: true }).click();
    await page.waitForFunction(() => window.refreshCount === 1);
    assert.equal(await dialog.isVisible(), false, "A confirmed update closes the editor before refreshing current insights.");
    assert.equal(calls.filter(call => call.path.endsWith("/feedback")).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith("/mutation/status")).length, 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.assessment.pending")), null);
});

test("compact insight controls reflow in both themes at all approved widths and enlarged root text", { timeout: 30000 }, async t => {
    const view = currentView();
    const personal = {
        ...samples.makeAssessment(true), interactionRef: view.interaction.interactionRef,
        unitRef: view.interaction.interactionRef, basis: { ...view.basis },
    };
    view.assessments.push(personal);
    const metric = quality("accuracy", { pass: 1, unassessed: 0, personal: true });
    Object.assign(metric, {
        basis: { ...view.basis }, eligibleUnitRefs: [view.interaction.interactionRef],
        coveredUnitRefs: [view.interaction.interactionRef], evidenceRefs: [personal.assessmentRef],
    });
    view.metrics.push(metric);
    view.reviewStatus.assessment.personalFeedback = true;
    contract.validateInteractionView(view);
    const { page, show } = await setup(t, view);
    await show();
    for (const theme of ["light", "dark"]) for (const width of [320, 375, 414, 768, 820, 1200, 2560]) for (const size of [100, 200]) {
        await page.setViewportSize({ width, height: 950 });
        await page.evaluate(({ theme, size }) => { document.documentElement.dataset.evidenceTheme = theme; document.documentElement.style.fontSize = `${size}%`; }, { theme, size });
        await page.evaluate(() => document.fonts.ready);
        const result = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            clipped: [...document.querySelectorAll("#summary p,#summary h3,#summary button")].some(node => node.scrollWidth > node.clientWidth + 1),
            buttonHeight: document.querySelector("#summary button").getBoundingClientRect().height,
            fontReady: getComputedStyle(document.body).fontFamily.startsWith("Arial") && document.fonts.check("14px Arial"),
        }));
        assert.equal(result.overflow, false, `${theme}/${width}/${size}`);
        assert.equal(result.clipped, false, `${theme}/${width}/${size}`);
        assert.ok(result.buttonHeight >= 44);
        assert.equal(result.fontReady, true, "The reference-aligned UI font is available.");
        await page.getByRole("button", { name: "Details and feedback", exact: true }).click();
        await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
        const feedback = page.getByRole("dialog", { name: "Your feedback: answer correctness", exact: true });
        const bounds = await feedback.evaluate(node => ({
            right: node.getBoundingClientRect().right, left: node.getBoundingClientRect().left,
            fits: node.scrollWidth <= node.clientWidth + 1,
        }));
        assert.ok(bounds.left >= 0 && bounds.right <= width + 1 && bounds.fits, `Feedback ${theme}/${width}/${size}`);
        await feedback.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.keyboard.press("Escape");
    }
});
