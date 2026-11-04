import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createFixtureRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { retirementFixture } from "./ai-review-retirement-fixture.mjs";
import { createAssessmentExperience } from "../web/assessment-experience.mjs";
import { createAssessmentControls } from "../web/assessment-controls.mjs";
import { mountConsentSetup } from "../web/assessment-control-views.mjs";
import { createAssessmentPresentation, createAssessmentWording, createTimingPresentation } from "../web/assessment-presentation.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { createTextAccess } from "../web/text-access.mjs";
import { createDisclosureState } from "../web/disclosure-state.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";

const { createBoardTransport } = await import(process.env.WIRE_ASSESSMENT_TRANSPORT
    ? pathToFileURL(process.env.WIRE_ASSESSMENT_TRANSPORT).href : new URL("../lib/client-transport.mjs", import.meta.url).href);

test("assessment withdrawal and original recovery use the actual producer and transport across a new local epoch", async t => {
    const cleanup = [], errors = [], unexpected = [], requests = [];
    let lifecycle, access, runtime, browser;
    t.after(async () => {
        try { await browser?.close(); await runtime?.close(); access?.close(); await lifecycle?.close(); }
        finally { for (const action of cleanup.reverse()) await action(); }
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    });
    const fixture = await retirementFixture({ after: action => cleanup.push(action) });
    lifecycle = await createMicrosoftSession(fixture.context, { collection: { paused: false, windowDays: 30 } });
    access = await createFixtureRuntimeAccess(fixture.context, { lifecycle });
    runtime = await startServer(fixture.context, createExportController(fixture.context), {
        port: 0, collector: { timers: false }, access,
        evaluation: {
            evaluatorFactory() { throw Error("Provider operations are forbidden."); },
            readSource() { throw Error("Source reads are forbidden."); },
        },
    });
    browser = await chromium.launch();
    const page = await browser.newPage();
    const origin = new URL(runtime.url).origin;
    const request = async (endpoint, input, capability) => {
        const response = await fetch(origin + endpoint, { method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}) },
            body: JSON.stringify(input) });
        assert.equal(response.status, 200, endpoint);
        return response.json();
    };
    const panel = await request("/api/session", {});
    assert.equal(panel.accessBootstrap.mode, "enforced");
    assert.equal(panel.runtimeId, panel.accessBootstrap.runtimeId);
    await request("/api/access/command", { schemaVersion: 1, action: "wire-sign-in", operationId: randomUUID(),
        generation: (await lifecycle.status()).generation }, panel.capability);
    const current = await request("/api/assessment/consent", { schemaVersion: 1 }, panel.capability);
    const mutationRef = "mutation-" + randomBytes(16).toString("hex"), receiptToken = randomBytes(32).toString("hex");
    const receipt = await request("/api/assessment/consent/set", { schemaVersion: 1, mutationRef, receiptToken,
        expectedSourceRevision: current.basis.sourceRevision, expectedConsentRevision: current.data.consent.revision,
        policyVersion: 1, enabled: true, categories: ["answer"], sourceConfigRef: current.data.source.sourceConfigRef,
        sourceConfigRevision: current.data.source.sourceConfigRevision, confirmed: true }, panel.capability);
    assert.equal(receipt.phase, "complete");
    const stored = JSON.stringify({ action: "set_assessment_consent", mutationRef, receiptToken });
    const before = await loadBoardState(fixture.context), generation = (await lifecycle.status()).generation;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
        if (req.method() === "GET" && url.pathname === "/") return route.fulfill({ contentType: "text/html",
            body: '<main><button id="outside">Other control</button><div id="message"></div><div id="setup"></div></main>' });
        if (req.method() === "GET" && ["/assets/assessment-contract.mjs", "/favicon.svg"].includes(url.pathname)) return route.continue();
        if (req.method() === "POST" && ["/api/access/watch", "/api/snapshot", "/api/assessment/consent", "/api/assessment/mutation/status"].includes(url.pathname)) {
            requests.push({ endpoint: url.pathname, input: req.postDataJSON() }); return route.continue();
        }
        unexpected.push(url.pathname); return route.abort();
    });
    await page.goto(runtime.url);
    await page.addScriptTag({ content: `
        window.makeTransport = ${createBoardTransport.toString()};
        window.makeExperience = ${createAssessmentExperience.toString()};
        window.makeControls = ${createAssessmentControls.toString()};
        window.mountConsent = ${mountConsentSetup.toString()};
        window.makePresentation = ${createAssessmentPresentation.toString()};
        window.makeWording = ${createAssessmentWording.toString()};
        window.makeTiming = ${createTimingPresentation.toString()};
        window.makeProjection = ${createActivityProjection.toString()};
        window.makeText = ${createTextAccess.toString()};
        window.makeDisclosure = ${createDisclosureState.toString()};
        window.makeUX = ${createEvidenceUX.toString()};
    ` });
    await page.evaluate(({ panel, stored, icons }) => {
        sessionStorage.setItem("wire.responseCapture.pending", stored);
        const api = window.api = window.makeTransport(panel.capability, () => {}, panel.accessBootstrap);
        const ux = window.makeUX(icons);
        window.effects = { refresh: 0, changed: 0 };
        window.experience = window.makeExperience({
            api, ux, textAccess: window.makeText(ux, window.makeDisclosure()),
            createPresentation: contract => window.makePresentation({ ...contract, wording: window.makeWording(),
                timing: window.makeTiming(window.makeProjection(null, null, ["unknown"]).summarize) }),
            createControls: window.makeControls, mountConsent: window.mountConsent,
            refresh: () => { window.effects.refresh++; }, onChanged: () => { window.effects.changed++; },
            onNotice: message => { throw Error(message); },
        });
        api.subscribeAccess(state => { if (!state.readable) window.experience.withdrawAccess(); });
        api.startAccess();
    }, { panel, stored, icons: uxIcons });
    await page.waitForFunction(() => window.api.publicationToken() !== null);
    await page.evaluate(async () => {
        window.originalPublication = window.api.publicationToken();
        const snapshot = await window.api("/api/snapshot", {});
        window.experience.receive(snapshot.assessment);
        await window.experience.setup(document.getElementById("setup"));
    });
    await page.getByRole("switch", { name: "Save Copilot replies locally" }).waitFor();
    const privateCount = () => requests.filter(row => row.endpoint !== "/api/access/watch").length;
    const readBefore = privateCount(), url = page.url();
    await page.evaluate(() => {
        document.getElementById("outside").focus();
        window.api.suspendAccess();
    });
    assert.equal(await page.locator("#setup").textContent(), "");
    assert.equal(await page.locator(".assessment-recovery").textContent(), "");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.responseCapture.pending")), stored);
    assert.equal(await page.evaluate(() => document.activeElement.id), "outside");
    assert.equal(privateCount(), readBefore);
    await page.evaluate(() => window.api.startAccess());
    await page.waitForFunction(() => window.api.publicationToken() !== null);
    assert.equal(await page.evaluate(() => window.api.isCurrent(window.originalPublication)), false);
    assert.equal(privateCount(), readBefore, "Readiness alone must not replay private work.");
    await page.evaluate(async () => {
        const snapshot = await window.api("/api/snapshot", {});
        window.experience.receive(snapshot.assessment);
        await window.experience.setup(document.getElementById("setup"));
    });
    const check = page.getByRole("button", { name: "Check response-saving result", exact: true });
    await check.waitFor();
    await check.click();
    await page.waitForFunction(() => sessionStorage.getItem("wire.responseCapture.pending") === null);
    assert.deepEqual(requests.filter(row => row.endpoint.endsWith("/mutation/status")).map(row => row.input),
        [{ schemaVersion: 1, mutationRef, receiptToken }]);
    assert.equal(requests.some(row => row.endpoint.endsWith("/consent/set")), false);
    assert.equal((await lifecycle.status()).generation, generation);
    assert.equal(page.url(), url);
    assert.deepEqual(await loadBoardState(fixture.context), before);
    assert.equal((await page.locator("body").textContent()).includes(receiptToken), false);
    await page.evaluate(() => window.api.suspendAccess());
});
