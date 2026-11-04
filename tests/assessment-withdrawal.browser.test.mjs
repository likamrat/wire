import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { createAssessmentControls } from "../web/assessment-controls.mjs";
import { mountConsentSetup } from "../web/assessment-control-views.mjs";
import { createAssessmentExperience } from "../web/assessment-experience.mjs";
import { createAssessmentPresentation, createAssessmentWording, createTimingPresentation } from "../web/assessment-presentation.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { createTextAccess } from "../web/text-access.mjs";
import { createDisclosureState } from "../web/disclosure-state.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { contract, currentView, samples } from "./assessment-ui-fixtures.mjs";

async function setup(t, { loadContract = true } = {}) {
    const browser = await chromium.launch(), page = await browser.newPage();
    const errors = [], unexpected = [];
    const source = await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8");
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === "https://wire.invalid" && url.pathname === "/") return route.fulfill({
            contentType: "text/html",
            body: '<main><button id="outside">Unrelated control</button><div id="message"></div><div id="setup"></div><div id="response"></div></main>',
        });
        if (url.origin === "https://wire.invalid" && url.pathname === "/assets/assessment-contract.mjs") {
            return route.fulfill({ contentType: "text/javascript", body: source });
        }
        unexpected.push(url.href); return route.abort();
    });
    t.after(async () => {
        await browser.close();
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    });
    await page.goto("https://wire.invalid/");
    await page.addScriptTag({ content: `
        window.makeControls = ${createAssessmentControls.toString()};
        window.mountConsent = ${mountConsentSetup.toString()};
    ` });
    if (loadContract) await page.evaluate(async () => { window.contract = await import("/assets/assessment-contract.mjs"); });
    return page;
}

async function setupExperience(t, { initialGrant = true } = {}) {
    const page = await setup(t, { loadContract: false }), calls = [];
    const view = currentView();
    view.basis.consentRevision = 1;
    view.consent = { ...samples.enabledConsent(), categories: ["answer"] };
    view.interaction.sourceConfigRef = view.consent.sourceConfigRef;
    view.interaction.sourceConfigRevision = view.consent.sourceConfigRevision;
    for (const item of [view.interaction, ...view.observations, ...view.assessments, ...view.metrics]) item.basis = { ...view.basis };
    const responseText = "PRIVATE_RETAINED_RESPONSE\n  Preserve every exact character.";
    view.observations.push({
        schemaVersion: 1, interactionRef: view.interaction.interactionRef, basis: { ...view.basis },
        createdAt: samples.at, evidenceRefs: [samples.id("evidence", 80)], observationRef: samples.id("observation", 80),
        memberRef: null, adapter: "copilot-local-events-v1", kind: "answer", origin: "optional-capture",
        availability: "available", reason: null, occurredAt: samples.at, sourceEventRefs: [samples.id("event", 80)],
        deletionKeys: [...new Set(view.interaction.members.flatMap(member => member.deletionKeys))],
        payload: { textRef: samples.id("text", 80), utf8Bytes: Buffer.byteLength(responseText),
            completeness: "full-record", finality: "unverified", credentialScreenVersion: 1, credentialScreen: "passed" },
        captureContext: { consentRevision: 1, sourceConfigRef: view.consent.sourceConfigRef, sourceConfigRevision: view.consent.sourceConfigRevision },
    });
    contract.validateInteractionView(view);
    const snapshot = { schemaVersion: 1, basis: view.basis,
        catalog: [{ scenarioId: "private-response", interactionRef: view.interaction.interactionRef, status: "retained", reason: null }],
        overview: { interactionRefs: [view.interaction.interactionRef], metrics: view.metrics },
        consent: view.consent, source: { available: true, sourceConfigRef: view.consent.sourceConfigRef, sourceConfigRevision: view.consent.sourceConfigRevision },
        capabilities: { answer: true, usage: false, explicitAuthorization: false } };
    let beforeReply;
    await page.exposeFunction("syntheticApi", async (endpoint, input) => {
        calls.push({ endpoint, input });
        const intercepted = await beforeReply?.(endpoint, input);
        if (intercepted !== undefined) return intercepted;
        if (endpoint.endsWith("/detail")) return { schemaVersion: 1, basis: view.basis, data: view };
        if (endpoint.endsWith("/evidence")) return { schemaVersion: 1, basis: view.basis,
            data: { observationRef: samples.id("observation", 80), text: responseText, completeness: "full-record",
                finality: "unverified", basis: view.basis } };
        if (endpoint.endsWith("/consent")) return { schemaVersion: 1, basis: view.basis,
            data: { consent: view.consent, source: snapshot.source, capabilities: snapshot.capabilities } };
        if (endpoint.endsWith("/consent/set") || endpoint.endsWith("/mutation/status")) {
            return { schemaVersion: 1, mutationRef: input.mutationRef, phase: "pending" };
        }
        throw Error("Unexpected assessment endpoint: " + endpoint);
    });
    await page.addScriptTag({ content: `
        window.makeExperience = ${createAssessmentExperience.toString()};
        window.makePresentation = ${createAssessmentPresentation.toString()};
        window.makeWording = ${createAssessmentWording.toString()};
        window.makeTiming = ${createTimingPresentation.toString()};
        window.makeProjection = ${createActivityProjection.toString()};
        window.makeText = ${createTextAccess.toString()};
        window.makeDisclosure = ${createDisclosureState.toString()};
        window.makeUX = ${createEvidenceUX.toString()};
    ` });
    await page.evaluate(({ icons, snapshot, initialGrant }) => {
        let current = {}, granted = initialGrant;
        window.completedCalls = 0;
        const api = async (endpoint, input) => {
            try { return await window.syntheticApi(endpoint, input); }
            finally { window.completedCalls++; }
        };
        api.publicationToken = () => granted ? current : null;
        api.isCurrent = token => granted && token !== null && token === current;
        window.setGrant = value => { granted = value; current = {}; };
        window.api = api;
        window.effects = { refresh: 0, changed: 0, saved: 0, notices: [] };
        window.invalidations = [];
        window.retainedControls = [];
        window.copies = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw Error("Real clipboard access is forbidden."); },
            writeText: async text => { window.copies.push(text); },
        } });
        const ux = window.makeUX(icons);
        const textAccess = window.makeText(ux, window.makeDisclosure()), renderText = textAccess.render;
        textAccess.render = (...args) => {
            const previous = window.insideTextRender;
            window.insideTextRender = true;
            try {
                const root = renderText(...args);
                window.producedTextRoots?.push(root);
                return root;
            } finally { window.insideTextRender = previous; }
        };
        window.experience = window.makeExperience({
            api, ux, textAccess,
            createPresentation: contract => window.makePresentation({ ...contract, wording: window.makeWording(),
                timing: window.makeTiming(window.makeProjection(null, null, ["unknown"]).summarize) }),
            createControls: contract => {
                const controls = window.makeControls(contract);
                return { ...controls, consent: (...args) => {
                    const control = controls.consent(...args);
                    window.retainedControls.push(control);
                    return control;
                } };
            },
            mountConsent: window.mountConsent,
            refresh: () => { window.effects.refresh++; }, onChanged: () => { window.effects.changed++; window.onChangedEffect?.(); },
            onSaved: () => { window.effects.saved++; }, onNotice: message => { window.effects.notices.push(message); },
            onInvalidated: message => { window.invalidations.push(message); },
        });
        window.freshSnapshot = snapshot;
        window.experience.receive(snapshot);
    }, { icons: uxIcons, snapshot, initialGrant });
    return { page, calls, view, snapshot, responseText, intercept: callback => { beforeReply = callback; },
        showSetup: () => page.evaluate(() => window.experience.setup(document.getElementById("setup"))),
        showResponse: (options = { eager: true, contentFirst: true }) => page.evaluate(options =>
            window.experience.detail(document.getElementById("response"), "private-response", options), options),
        withdraw: () => page.evaluate(() => { window.setGrant(false); window.experience.withdrawAccess(); }) };
}

test("consent disposal clears retained form state and handlers synchronously without affecting fresh setup", async t => {
    const page = await setup(t);
    const result = await page.evaluate(consent => {
        const source = { available: true, sourceConfigRef: consent.sourceConfigRef, sourceConfigRevision: consent.sourceConfigRevision,
            sourceRevision: 7, capabilities: { answer: true, usage: false, explicitAuthorization: false } };
        const before = JSON.stringify({ consent, source }), controls = window.makeControls(window.contract);
        const root = document.getElementById("setup"), packets = [];
        const control = controls.consent(consent, source);
        const view = window.mountConsent(root, { control, currentSource: source, sourceLabel: "PRIVATE_SOURCE_LABEL",
            onSubmit: packet => packets.push(packet), onCheck: packet => packets.push(packet),
            onCancel: () => {}, onRender: () => () => {} });
        const input = root.querySelector("input"), form = root.querySelector("form");
        const submit = root.querySelector('button[type="submit"]'), retainedLabel = root.querySelector(".assessment-source");
        control.edit({ enabled: false, categories: [] }); view.render();
        const busy = form.getAttributeNode("aria-busy");
        document.getElementById("outside").focus();
        control.dispose(); view.dispose(); view.dispose();
        input.checked = true;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        submit.click();
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        view.render(); view.focus();
        const withdrawn = {
            count: packets.length, text: root.textContent, retainedText: retainedLabel.textContent,
            formText: form.textContent, busy: busy.value, focused: document.activeElement.id, offered: view.recoveryPresentation().offered,
        };
        const freshControl = controls.consent(consent, source);
        window.mountConsent(root, { control: freshControl, currentSource: source, sourceLabel: "Current approved source",
            onSubmit: packet => packets.push(packet), onCheck: packet => packets.push(packet), onCancel: () => {} });
        const freshInput = root.querySelector("input");
        freshInput.checked = false;
        freshInput.dispatchEvent(new Event("change", { bubbles: true }));
        root.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        return { withdrawn, packets, unchanged: JSON.stringify({ consent, source }) === before };
    }, { ...samples.enabledConsent(), categories: ["answer"] });
    assert.deepEqual(result.withdrawn, { count: 0, text: "", retainedText: "", formText: "", busy: "", focused: "outside", offered: false });
    assert.equal(result.unchanged, true);
    assert.equal(result.packets.length, 1);
    assert.equal(result.packets[0].action, "set_assessment_consent");
    assert.equal(result.packets[0].input.enabled, false);
});

test("a missing shared publication gate fails explicitly instead of allowing private legacy work", async t => {
    const page = await setup(t);
    await page.addScriptTag({ content: `window.makeExperience = ${createAssessmentExperience.toString()};` });
    const result = await page.evaluate(() => {
        let calls = 0, error;
        try { window.makeExperience({ api: async () => { calls++; } }); }
        catch (failure) { error = { name: failure.name, message: failure.message }; }
        return { calls, error, recoveryHosts: document.querySelectorAll(".assessment-recovery").length };
    });
    assert.deepEqual(result, { calls: 0, recoveryHosts: 0,
        error: { name: "TypeError", message: "Assessment evidence requires the shared publication guard." } });
});

test("assessment withdrawal clears actual response and consent owners before observer cleanup without dispatch", async t => {
    const f = await setupExperience(t);
    await f.showSetup(); await f.showResponse();
    await f.page.getByText(f.responseText, { exact: true }).waitFor();
    const beforeCalls = f.calls.length;
    const cleared = await f.page.evaluate(() => {
        const response = document.getElementById("response"), settings = document.getElementById("setup");
        const insightKey = response.getAttributeNode("data-insight-key");
        const generatedInsight = insightKey?.value.startsWith("detail:");
        const pre = response.querySelector("pre"), oldCopy = response.querySelector(".ux-copy");
        const textLabel = pre.getAttributeNode("aria-label");
        const oldToggle = response.querySelector(".full-text-toggle"), input = settings.querySelector("input");
        const form = settings.querySelector("form");
        document.getElementById("outside").focus();
        window.setGrant(false);
        window.experience.withdrawAccess();
        window.experience.withdrawAccess();
        oldToggle?.click(); oldCopy?.click();
        input.dispatchEvent(new Event("change", { bubbles: true }));
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        return { response: response.textContent, settings: settings.textContent, retainedText: pre.textContent,
            generatedInsight, insightValue: insightKey.value,
            textLabel: textLabel.value, responseId: response.id,
            applied: window.retainedControls[0].snapshot().applied, focus: document.activeElement.id,
            copies: window.copies, effects: window.effects };
    });
    assert.deepEqual(cleared, { response: "", settings: "", retainedText: "", applied: null,
        generatedInsight: true, insightValue: "", textLabel: "", responseId: "response",
        focus: "outside", copies: [], effects: { refresh: 0, changed: 0, saved: 0, notices: [] } });
    assert.equal(f.calls.length, beforeCalls);
    await f.page.evaluate(async () => {
        window.experience.receive(window.freshSnapshot);
        await window.experience.detail(document.getElementById("response"), "private-response", { eager: true });
        await window.experience.setup(document.getElementById("setup"));
    });
    assert.equal(f.calls.length, beforeCalls);
    assert.equal(await f.page.locator("#setup").textContent(), "");
    assert.equal(await f.page.locator("#response").textContent(), "");
});

for (const path of ["withdraw", "selection-replacement"]) test(`multi-answer error handles are scrubbed before ${path}`, async t => {
    const f = await setupExperience(t);
    const first = f.view.observations.find(item => item.kind === "answer");
    const second = { ...structuredClone(first), observationRef: samples.id("observation", 95) };
    f.view.observations.push(second);
    let fail = true;
    f.intercept((endpoint, input) => {
        if (!endpoint.endsWith("/evidence")) return;
        if (fail) throw Error("PRIVATE_RESPONSE_READ_ERROR");
        return { schemaVersion: 1, basis: f.view.basis, data: {
            observationRef: input.observationRef, text: "PRIVATE_SELECTED_RESPONSE",
            completeness: "full-record", finality: "unverified", basis: f.view.basis,
        } };
    });
    const options = { eager: false, contentFirst: false };
    await f.showResponse(options);
    await f.page.getByRole("button", { name: "Read response", exact: true }).click();
    await f.page.getByText("PRIVATE_RESPONSE_READ_ERROR", { exact: true }).waitFor();
    const before = await f.page.evaluate(() => {
        window.heldAnswerOptions = [...document.querySelectorAll("#response select option")].map(node => node.getAttributeNode("value"));
        window.heldAnswerError = document.querySelector("#response .error").firstChild;
        return { values: window.heldAnswerOptions.map(attribute => attribute.value), error: window.heldAnswerError.data };
    });
    assert.deepEqual(before, { values: [first.observationRef, second.observationRef], error: "PRIVATE_RESPONSE_READ_ERROR" });
    if (path === "selection-replacement") {
        await f.page.locator("#response select").selectOption(second.observationRef);
        assert.equal(await f.page.evaluate(() => window.heldAnswerError.data), "");
        assert.deepEqual(await f.page.locator("#response option").evaluateAll(nodes => nodes.map(node => node.value)), before.values);
        fail = false;
        await f.page.getByRole("button", { name: "Read response", exact: true }).click();
        await f.page.getByText("PRIVATE_SELECTED_RESPONSE", { exact: true }).waitFor();
        assert.equal(f.calls.filter(call => call.endpoint.endsWith("/evidence")).at(-1).input.observationRef, second.observationRef);
        await f.page.evaluate(() => {
            window.heldAnswerBody = document.querySelector("#response pre").firstChild;
            window.heldAnswerKey = document.querySelector("#response .full-text").getAttributeNode("data-view-key");
        });
        await f.showResponse(options);
        const replaced = await f.page.evaluate(() => ({
            values: window.heldAnswerOptions.map(attribute => attribute.value),
            error: window.heldAnswerError.data, body: window.heldAnswerBody.data, key: window.heldAnswerKey.value,
        }));
        assert.deepEqual(replaced, { values: ["", ""], error: "", body: "", key: "" });
        assert.deepEqual(await f.page.locator("#response option").evaluateAll(nodes => nodes.map(node => node.value)), before.values);
        fail = true;
        await f.page.getByRole("button", { name: "Read response", exact: true }).click();
        await f.page.getByText("PRIVATE_RESPONSE_READ_ERROR", { exact: true }).waitFor();
        await f.page.evaluate(() => { window.heldRetryError = document.querySelector("#response .error").firstChild; });
        fail = false;
        await f.page.getByRole("button", { name: "Read response", exact: true }).click();
        await f.page.getByText("PRIVATE_SELECTED_RESPONSE", { exact: true }).waitFor();
        assert.equal(await f.page.evaluate(() => window.heldRetryError.data), "");
        await f.page.evaluate(() => {
            const host = document.getElementById("response"), next = document.createElement("div");
            window.detachedAnswerBody = host.querySelector("pre").firstChild;
            window.detachedAnswerOptions = [...host.querySelectorAll("option")].map(node => node.getAttributeNode("value"));
            window.detachedInsight = host.getAttributeNode("data-insight-key");
            next.id = host.id;
            host.replaceWith(next);
        });
        await f.showResponse(options);
        assert.deepEqual(await f.page.evaluate(() => ({
            values: window.detachedAnswerOptions.map(attribute => attribute.value), body: window.detachedAnswerBody.data,
        })), { values: ["", ""], body: "" });
    }
    const calls = f.calls.length;
    await f.withdraw();
    assert.deepEqual(await f.page.evaluate(() => ({
        values: window.heldAnswerOptions.map(attribute => attribute.value), error: window.heldAnswerError.data,
        text: document.getElementById("response").textContent, root: document.getElementById("response").id,
    })), { values: ["", ""], error: "", text: "", root: "response" });
    if (path === "selection-replacement") assert.equal(await f.page.evaluate(() => window.detachedInsight.value), "");
    assert.equal(f.calls.length, calls, "Teardown neither reads nor replays an operation.");
});

test("non-null synchronous publication requires an exactly true synchronous verdict", async t => {
    const results = [];
    for (const kind of ["undefined-token", "promise-token", "truthy-verdict", "promise-verdict"]) {
        const f = await setupExperience(t, { initialGrant: false });
        const text = await f.page.evaluate(async kind => {
            const token = {};
            window.api.publicationToken = () => kind === "undefined-token" ? undefined
                : kind === "promise-token" ? Promise.resolve(token) : token;
            window.api.isCurrent = () => kind === "truthy-verdict" ? 1
                : kind === "promise-verdict" ? Promise.resolve(false) : true;
            window.experience.receive(window.freshSnapshot);
            await window.experience.setup(document.getElementById("setup"));
            return document.getElementById("setup").textContent;
        }, kind);
        results.push({ kind, calls: f.calls.length, painted: text.length > 0 });
    }
    assert.deepEqual(results, results.map(({ kind }) => ({ kind, calls: 0, painted: false })));
});

for (const newer of [false, true]) test(`text produced across visibility withdrawal is released without clearing ${newer ? "newer work" : "the retired reader"}`, async t => {
    const f = await setupExperience(t);
    await f.page.evaluate(async newer => {
        window.producedTextRoots = [];
        const host = document.getElementById("response");
        let retired = false;
        const visibility = {
            isCurrent() {
                if (window.insideTextRender && !retired) {
                    retired = true;
                    window.retiredReader = host.querySelector("[aria-busy=true]");
                    window.setGrant(false); window.experience.withdrawAccess();
                    if (newer) {
                        window.setGrant(true); window.experience.receive(window.freshSnapshot);
                        window.newerDetail = window.experience.detail(host, "private-response", { eager: true, contentFirst: true });
                    }
                }
                return !retired;
            },
            isOpen: () => true,
            subscribe: () => () => {},
        };
        await window.experience.detail(host, "private-response", { eager: true, contentFirst: true, visibility });
    }, newer);
    await f.page.waitForFunction(() => window.producedTextRoots.length > 0);
    if (newer) await f.page.getByText(f.responseText, { exact: true }).waitFor();
    const result = await f.page.evaluate(() => ({
        retired: { connected: window.retiredReader.isConnected, text: window.retiredReader.textContent },
        produced: { text: window.producedTextRoots[0].textContent, key: window.producedTextRoots[0].getAttribute("data-view-key") },
        currentText: document.getElementById("response").textContent,
    }));
    assert.deepEqual(result.retired, { connected: false, text: "" });
    assert.deepEqual(result.produced, { text: "", key: null });
    if (newer) {
        assert.match(result.currentText, /PRIVATE_RETAINED_RESPONSE/);
        assert.equal(f.calls.filter(call => call.endpoint.endsWith("/detail")).length, 2);
    } else assert.equal(result.currentText, "");
});

test("placement withdrawal cannot refill retired detail cache or invoke later placements", async t => {
    const f = await setupExperience(t);
    const answer = f.view.observations.find(item => item.kind === "answer");
    f.view.observations.push({ ...structuredClone(answer), observationRef: samples.id("observation", 95) });
    await f.page.evaluate(async () => {
        window.placements = 0;
        await window.experience.detail(document.getElementById("response"), "private-response", {
            eager: true,
            placeResponse() {
                window.placements++;
                window.setGrant(false); window.experience.withdrawAccess();
                return null;
            },
        });
        window.setGrant(true); window.experience.receive(window.freshSnapshot);
        await window.experience.detail(document.getElementById("response"), "private-response", { eager: false });
    });
    assert.equal(f.calls.filter(call => call.endpoint.endsWith("/detail")).length, 2);
    assert.equal(await f.page.evaluate(() => window.placements), 1);
    assert.equal(await f.page.locator("#response option").count(), 2);
});

test("a reentrant newer detail owns its pending feedback and rendered response", async t => {
    const f = await setupExperience(t);
    let release, started, details = 0;
    const held = new Promise(resolve => { release = resolve; });
    const issued = new Promise(resolve => { started = resolve; });
    t.after(() => release());
    f.intercept(async endpoint => {
        if (!endpoint.endsWith("/detail") || ++details !== 2) return;
        started(); await held;
    });
    await f.page.evaluate(() => window.experience.detail(document.getElementById("response"), "private-response", {
        eager: true,
        placeResponse() {
            window.newerDetail = window.experience.detail(document.getElementById("response"), "private-response", { eager: false });
            return null;
        },
    }));
    await issued;
    assert.equal(await f.page.locator("#response").getAttribute("aria-busy"), "true");
    assert.match(await f.page.locator("#response").textContent(), /Reading recorded insights/);
    release();
    await f.page.evaluate(() => window.newerDetail);
    assert.equal(await f.page.locator("#response").getAttribute("aria-busy"), null);
    assert.equal(await f.page.locator("#response").evaluate(node => node.hidden), false);
    assert.equal(await f.page.getByRole("button", { name: "Read response", exact: true }).count(), 1);
    assert.equal(f.calls.filter(call => call.endpoint.endsWith("/detail")).length, 2);
});

for (const outcome of ["success", "error"]) test(`late consent ${outcome} cannot paint across withdrawal and a fresh grant`, async t => {
    const f = await setupExperience(t);
    let release, started;
    const held = new Promise(resolve => { release = resolve; });
    const issued = new Promise(resolve => { started = resolve; });
    t.after(() => release());
    f.intercept(async endpoint => {
        if (!endpoint.endsWith("/consent")) return;
        started(); await held;
        if (outcome === "error") throw Error("PRIVATE_LATE_CONSENT_ERROR");
        return { schemaVersion: 1, basis: f.snapshot.basis,
            data: { consent: f.snapshot.consent, source: f.snapshot.source, capabilities: f.snapshot.capabilities } };
    });
    const old = f.showSetup();
    await issued;
    await f.withdraw();
    await f.page.evaluate(() => { window.setGrant(true); window.experience.receive(window.freshSnapshot); });
    release(); await old;
    assert.equal(await f.page.locator("#setup").textContent(), "");
    assert.equal(f.calls.length, 1);
    f.intercept(null);
    await f.showSetup();
    assert.equal(f.calls.length, 2);
    assert.equal(await f.page.getByRole("switch", { name: "Save Copilot replies locally" }).isChecked(), true);
});

test("a queued setup import cannot dispatch the retired request after fresh readiness", async t => {
    const f = await setupExperience(t);
    let release, started;
    const held = new Promise(resolve => { release = resolve; });
    const issued = new Promise(resolve => { started = resolve; });
    const source = await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8");
    t.after(() => release());
    await f.page.route("**/assets/assessment-contract.mjs", async route => {
        started(); await held;
        await route.fulfill({ contentType: "text/javascript", body: source });
    });
    const old = f.showSetup();
    await issued;
    await f.withdraw();
    await f.page.evaluate(() => { window.setGrant(true); window.experience.receive(window.freshSnapshot); });
    release(); await old;
    assert.equal(f.calls.length, 0);
    assert.equal(await f.page.locator("#setup").textContent(), "");
    await f.showSetup();
    assert.equal(f.calls.length, 1);
});

test("evidence publication checks access again after the held private read", async t => {
    const f = await setupExperience(t);
    let release, started;
    const held = new Promise(resolve => { release = resolve; });
    const issued = new Promise(resolve => { started = resolve; });
    t.after(() => release());
    f.intercept(async endpoint => {
        if (!endpoint.endsWith("/evidence")) return;
        started(); await held;
        return { schemaVersion: 1, basis: f.view.basis,
            data: { observationRef: samples.id("observation", 80), text: f.responseText,
                completeness: "full-record", finality: "unverified", basis: f.view.basis } };
    });
    await f.showResponse();
    await issued;
    await f.page.evaluate(() => window.setGrant(false));
    release();
    await f.page.waitForFunction(() => window.completedCalls === 2);
    assert.doesNotMatch(await f.page.locator("#response").textContent(), /PRIVATE_RETAINED_RESPONSE/);
    assert.equal(await f.page.locator("#response pre").count(), 0);
});

for (const outcome of ["complete", "error"]) test(`withdrawn consent ${outcome} preserves its original receipt without late effects`, async t => {
    const f = await setupExperience(t);
    let release, started, original;
    const held = new Promise(resolve => { release = resolve; });
    const issued = new Promise(resolve => { started = resolve; });
    t.after(() => release());
    f.intercept(async (endpoint, input) => {
        if (!endpoint.endsWith("/consent/set")) return;
        original = input;
        started(); await held;
        if (outcome === "error") throw Error("PRIVATE_LATE_MUTATION_ERROR");
        const consent = { ...f.view.consent, state: "revoked", categories: [],
            revision: f.view.consent.revision + 1, revokedAt: samples.at };
        return { schemaVersion: 1, mutationRef: input.mutationRef, phase: "complete",
            basis: { ...f.view.basis, consentRevision: consent.revision }, data: { consent } };
    });
    await f.showSetup();
    await f.page.getByRole("switch", { name: "Save Copilot replies locally" }).uncheck();
    await f.page.getByRole("button", { name: "Turn off and delete responses", exact: true }).click();
    await issued;
    const saved = await f.page.evaluate(() => sessionStorage.getItem("wire.responseCapture.pending"));
    assert.deepEqual(JSON.parse(saved), { mutationRef: original.mutationRef, action: "set_assessment_consent", receiptToken: original.receiptToken });
    await f.withdraw();
    await f.page.evaluate(() => { window.setGrant(true); window.experience.receive(window.freshSnapshot); });
    const recoveryBeforeCompletion = await f.page.locator(".assessment-recovery").textContent();
    release();
    await f.page.waitForFunction(() => window.completedCalls === 2);
    assert.equal(await f.page.evaluate(() => sessionStorage.getItem("wire.responseCapture.pending")), saved);
    assert.equal(await f.page.locator("#setup").textContent(), "");
    assert.equal(await f.page.locator(".assessment-recovery").textContent(), recoveryBeforeCompletion);
    assert.deepEqual(await f.page.evaluate(() => window.effects), { refresh: 0, changed: 0, saved: 0, notices: [] });
    assert.equal(f.calls.filter(call => call.endpoint.endsWith("/consent/set")).length, 1);
});

test("fresh authorized recovery checks the original opaque operation without replaying consent", async t => {
    const f = await setupExperience(t);
    await f.showSetup();
    await f.page.getByRole("switch", { name: "Save Copilot replies locally" }).uncheck();
    await f.page.getByRole("button", { name: "Turn off and delete responses", exact: true }).click();
    await f.page.getByRole("button", { name: "Check response-saving result", exact: true }).waitFor();
    const saved = await f.page.evaluate(() => sessionStorage.getItem("wire.responseCapture.pending"));
    const original = JSON.parse(saved);
    await f.withdraw();
    await f.page.evaluate(() => { window.setGrant(true); window.experience.receive(window.freshSnapshot); });
    assert.equal(await f.page.getByRole("button", { name: "Check response-saving result", exact: true }).isVisible(), true,
        "Fresh accepted state restores the original recovery notice even before Settings is opened.");
    assert.equal(f.calls.filter(call => call.endpoint.endsWith("/mutation/status")).length, 0);
    await f.showSetup();
    await f.page.getByRole("button", { name: "Check response-saving result", exact: true }).click();
    await f.page.waitForFunction(() => document.querySelector(".assessment-recovery").textContent.includes("still pending"));
    assert.equal(await f.page.evaluate(() => sessionStorage.getItem("wire.responseCapture.pending")), saved);
    assert.equal(f.calls.filter(call => call.endpoint.endsWith("/consent/set")).length, 1);
    assert.deepEqual(f.calls.filter(call => call.endpoint.endsWith("/mutation/status")).map(call => call.input),
        [{ schemaVersion: 1, mutationRef: original.mutationRef, receiptToken: original.receiptToken }]);
});

test("initial unavailable access creates no private request, consent or empty-response claim", async t => {
    const f = await setupExperience(t, { initialGrant: false });
    await f.showSetup(); await f.showResponse();
    assert.equal(f.calls.length, 0);
    assert.equal(await f.page.locator("#setup").textContent(), "");
    assert.equal(await f.page.locator("#response").textContent(), "");
    await f.page.evaluate(() => { window.setGrant(true); window.experience.receive(window.freshSnapshot); });
    await f.showSetup();
    assert.equal(f.calls.length, 1);
    assert.equal(await f.page.getByRole("switch", { name: "Save Copilot replies locally" }).isChecked(), true);
});

test("a fresh grant without a fresh snapshot cannot reuse cached private evidence or claim an absent response", async t => {
    const f = await setupExperience(t);
    await f.showResponse();
    await f.page.getByText(f.responseText, { exact: true }).waitFor();
    await f.withdraw();
    await f.page.evaluate(() => window.setGrant(true));
    await f.showResponse(); await f.showSetup();
    assert.equal(f.calls.length, 2);
    assert.doesNotMatch(await f.page.locator("#response").textContent(), /PRIVATE_RETAINED_RESPONSE|No response text retained|No saved response/);
    assert.equal(await f.page.getByRole("switch", { name: "Save Copilot replies locally" }).count(), 0);
    await f.page.evaluate(() => window.experience.receive(window.freshSnapshot));
    await f.showResponse();
    await f.page.getByText(f.responseText, { exact: true }).waitFor();
    assert.equal(f.calls.filter(call => call.endpoint.endsWith("/detail")).length, 2);
    assert.equal(f.calls.filter(call => call.endpoint.endsWith("/evidence")).length, 2);
});

for (const outcome of ["terminal", "error"]) test(`late original-receipt ${outcome} cannot clear uncertainty, paint or restore focus`, async t => {
    const f = await setupExperience(t);
    await f.showSetup();
    await f.page.getByRole("switch", { name: "Save Copilot replies locally" }).uncheck();
    await f.page.getByRole("button", { name: "Turn off and delete responses", exact: true }).click();
    const check = f.page.getByRole("button", { name: "Check response-saving result", exact: true });
    await check.waitFor();
    const saved = await f.page.evaluate(() => sessionStorage.getItem("wire.responseCapture.pending"));
    let release, started;
    const held = new Promise(resolve => { release = resolve; });
    const issued = new Promise(resolve => { started = resolve; });
    t.after(() => release());
    f.intercept(async (endpoint, input) => {
        if (!endpoint.endsWith("/mutation/status")) return;
        started(); await held;
        if (outcome === "error") throw Error("PRIVATE_LATE_RECEIPT_ERROR");
        return { schemaVersion: 1, mutationRef: input.mutationRef, phase: "not-started" };
    });
    await check.click(); await issued;
    await f.withdraw();
    await f.page.evaluate(() => {
        window.setGrant(true); window.experience.receive(window.freshSnapshot);
        document.getElementById("outside").focus();
    });
    const recoveryBeforeCompletion = await f.page.locator(".assessment-recovery").textContent();
    release();
    await f.page.waitForFunction(() => window.completedCalls === 3);
    assert.equal(await f.page.evaluate(() => sessionStorage.getItem("wire.responseCapture.pending")), saved);
    assert.equal(await f.page.locator(".assessment-recovery").textContent(), recoveryBeforeCompletion);
    assert.equal(await f.page.evaluate(() => document.activeElement.id), "outside");
    assert.deepEqual(await f.page.evaluate(() => window.effects), { refresh: 0, changed: 0, saved: 0, notices: [] });
});

test("receipt callbacks cannot publish saved feedback or refresh after synchronous owner withdrawal", async t => {
    const f = await setupExperience(t);
    f.intercept((endpoint, input) => {
        if (!endpoint.endsWith("/consent/set")) return;
        const consent = { ...f.view.consent, state: "revoked", categories: [],
            revision: f.view.consent.revision + 1, revokedAt: samples.at };
        return { schemaVersion: 1, mutationRef: input.mutationRef, phase: "complete",
            basis: { ...f.view.basis, consentRevision: consent.revision }, data: { consent } };
    });
    await f.showSetup();
    await f.page.evaluate(() => {
        window.onChangedEffect = () => { window.setGrant(false); window.experience.withdrawAccess(); };
    });
    await f.page.getByRole("switch", { name: "Save Copilot replies locally" }).uncheck();
    await f.page.getByRole("button", { name: "Turn off and delete responses", exact: true }).click();
    await f.page.waitForFunction(() => window.completedCalls === 2);
    assert.deepEqual(await f.page.evaluate(() => window.effects), { refresh: 0, changed: 1, saved: 0, notices: [] });
    assert.equal(await f.page.locator("#setup").textContent(), "");
});

test("assessment clearance failure propagates and can be retried without dispatch or permission restoration", async t => {
    const f = await setupExperience(t);
    await f.showSetup();
    const before = f.calls.length;
    const result = await f.page.evaluate(() => {
        const control = window.retainedControls[0], dispose = control.dispose;
        control.dispose = () => { throw Error("Expected owner clearance failure"); };
        window.setGrant(false);
        let error;
        try { window.experience.withdrawAccess(); } catch (failure) { error = failure.message; }
        control.dispose = dispose;
        window.experience.withdrawAccess();
        return { error, text: document.getElementById("setup").textContent,
            publication: window.api.publicationToken(), effects: window.effects };
    });
    assert.deepEqual(result, { error: "Expected owner clearance failure", text: "", publication: null,
        effects: { refresh: 0, changed: 0, saved: 0, notices: [] } });
    assert.equal(f.calls.length, before);
});

test("invalidation cannot forward its private reason after a nested publication check withdraws access", async t => {
    const f = await setupExperience(t);
    await f.showSetup();
    await f.showResponse();
    await f.page.getByText(f.responseText, { exact: true }).waitFor();
    const result = await f.page.evaluate(() => {
        const publication = window.api.publicationToken;
        let checks = 0;
        window.api.publicationToken = () => {
            if (++checks === 2) { window.setGrant(false); window.experience.withdrawAccess(); }
            return publication();
        };
        window.experience.invalidate("PRIVATE_STALE_INVALIDATION");
        return { invalidations: window.invalidations, text: document.getElementById("setup").textContent,
            response: document.getElementById("response").textContent };
    });
    assert.deepEqual(result, { invalidations: [], text: "", response: "" });
});

for (const outcome of ["success", "error"]) test(`held user response ${outcome} cannot repaint, reenable or refocus its released reader`, async t => {
    const f = await setupExperience(t);
    let release, started;
    const held = new Promise(resolve => { release = resolve; });
    const issued = new Promise(resolve => { started = resolve; });
    t.after(() => release());
    f.intercept(async endpoint => {
        if (!endpoint.endsWith("/evidence")) return;
        started(); await held;
        if (outcome === "error") throw Error("PRIVATE_RELEASED_RESPONSE_ERROR");
        return { schemaVersion: 1, basis: f.view.basis, data: {
            observationRef: samples.id("observation", 80), text: f.responseText,
            completeness: "full-record", finality: "unverified", basis: f.view.basis,
        } };
    });
    await f.showResponse({ eager: false, contentFirst: true });
    const load = f.page.getByRole("button", { name: "Read response", exact: true });
    await load.evaluate(node => { window.oldResponseLoad = node; });
    await load.click(); await issued;
    await f.withdraw();
    await f.page.locator("#outside").focus();
    release();
    await f.page.waitForFunction(() => window.completedCalls === 2);
    assert.equal(await f.page.locator("#response").textContent(), "");
    assert.equal(await f.page.evaluate(() => window.oldResponseLoad.disabled), true);
    assert.equal(await f.page.evaluate(() => document.activeElement.id), "outside");
    assert.equal(f.calls.length, 2);
});
