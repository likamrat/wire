import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { fixture, exportCatalogFor, automaticScoreOffSummary, navigateSettings, navigateMain, chooseTheme, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";
import { enabledConsent } from "./assessment-contract-fixtures.mjs";
import * as contract from "../lib/assessment-contract.mjs";

for (const [theme, width, scale] of [["light", 1440, 100], ["dark", 375, 200]]) {
    test(`full Settings navigation presents one original reply recovery in ${theme}`, { timeout: 30000 }, async t => {
        const records = [fixture("synthetic-recovery-navigation")];
        const basis = { sourceRevision: 1, membershipRevision: 1, consentRevision: 1, overrideRevision: 0, deletionEpoch: 0 };
        const source = { available: true, sourceConfigRef: "config-" + "1".repeat(32), sourceConfigRevision: 1 };
        const consent = { ...enabledConsent(), sourceConfigRef: source.sourceConfigRef, categories: ["answer"] };
        const assessment = { schemaVersion: 1, basis, catalog: [], overview: { interactionRefs: [], metrics: [] },
            consent, source, capabilities: { answer: true, usage: false, explicitAuthorization: false } };
        const collection = { revision: 1, configVersion: 1, state: "running", connected: true,
            config: { approved: true, enabled: true, appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\chats", windowDays: 30, pollSeconds: 5 },
            cadence: { pollSeconds: 5 }, metrics: {}, discovery: { counts: { sessions: 1, dispositions: { eligible: 1 } } },
            historyCoverage: { eligible: 1, readable: 1, unavailable: 0, limited: 0, affected: 0, pending: 0 }, historyIssues: [] };
        const before = JSON.stringify({ records, assessment, collection });
        const contractSource = await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8");
        const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
        const calls = [], errors = [], unexpected = [];
        let issued, release, statusPhase = "pending";
        const held = new Promise(resolve => { release = resolve; });
        t.after(async () => {
            release(); await browser.close();
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
            assert.equal(JSON.stringify({ records, assessment, collection }), before);
        });
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", async route => {
            const request = route.request(), url = new URL(request.url());
            const json = value => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
            if (url.origin !== "https://wire.invalid") { unexpected.push(url.href); return route.abort(); }
            if (request.method() === "GET") {
                if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: renderHtmlShell("a".repeat(64), "recovery-navigation", UNBOUND_FIXTURE_BOOTSTRAP) });
                if (url.pathname === "/assets/assessment-contract.mjs") return route.fulfill({ contentType: "text/javascript", body: contractSource });
                if (url.pathname === "/favicon.svg") return route.fulfill({ status: 204 });
            }
            const input = request.postDataJSON();
            calls.push({ endpoint: url.pathname, input });
            if (url.pathname === "/api/snapshot") return json({ revision: 1, scenarios: records, exports: [], coverage: { notes: [] }, collection, assessment,
                exportCatalog: exportCatalogFor(records), requestActivity: buildRequestActivity(records), analytics: { ...buildActivityAnalytics(records, input), revision: 1 } });
            if (url.pathname === "/api/collection/status") return json(collection);
            if (url.pathname === "/api/evaluation/automatic/summary") return json(automaticScoreOffSummary());
            if (url.pathname === "/api/assessment/consent") return json({ schemaVersion: 1, basis, data: { consent, source, capabilities: assessment.capabilities } });
            if (url.pathname === "/api/assessment/consent/set") {
                contract.validateRequest("set_assessment_consent", input);
                assert.equal(issued, undefined, "No consent mutation may be replayed.");
                assert.equal(input.enabled, false); assert.equal(input.confirmed, true);
                assert.equal(input.sourceConfigRef, source.sourceConfigRef);
                assert.equal(input.sourceConfigRevision, source.sourceConfigRevision);
                assert.equal(input.expectedConsentRevision, consent.revision);
                assert.equal(input.expectedSourceRevision, basis.sourceRevision);
                issued = input; await held;
                return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic response could not be confirmed." }) });
            }
            if (url.pathname === "/api/assessment/mutation/status") {
                assert.deepEqual(input, { schemaVersion: 1, mutationRef: issued.mutationRef, receiptToken: issued.receiptToken });
                return json({ schemaVersion: 1, mutationRef: issued.mutationRef, phase: statusPhase });
            }
            unexpected.push(url.pathname); return route.abort();
        });
        await page.addInitScript(({ scale }) => {
            document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = `${scale}%`; });
        }, { theme, scale });
        await page.goto("https://wire.invalid/#settings?section=privacy");
        await page.locator("#workspace[aria-busy=false]").waitFor();
        await chooseTheme(page, theme);
        const choice = page.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
        await choice.waitFor(); assert.equal(await choice.isChecked(), true);
        await choice.uncheck();
        await page.getByRole("button", { name: "Discard change", exact: true }).click();
        assert.equal(await choice.isChecked(), true);
        assert.equal(issued, undefined);
        await choice.uncheck();
        await page.getByRole("button", { name: "Turn off and delete responses", exact: true }).click();
        await page.locator("#assessmentSetup form[aria-busy=true]").waitFor();
        assert.equal(await choice.isDisabled(), true);
        const proof = process.env.WIRE_DECISION_PROOF_DIR;
        if (proof) await mkdir(proof, { recursive: true });
        async function capture(phase) {
            if (!proof) return;
            await page.mouse.move(1, 1);
            await page.evaluate(() => { scrollTo(0, 0); return document.fonts.ready; });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.screenshot({ path: path.join(proof, `reply-${phase}-${theme}-${width}-${scale}.png`), fullPage: true });
        }
        await capture("pending");
        release();
        const action = page.getByRole("button", { name: "Check response-saving result", exact: true });
        await action.waitFor();
        assert.equal(await action.count(), 1);
        assert.equal(await page.locator("#assessmentSetup .assessment-recovery").count(), 1);
        assert.equal(await page.getByRole("button", { name: "Check update result", exact: true }).count(), 0);
        await capture("unknown");
        const raw = await page.evaluate(() => sessionStorage.getItem("wire.responseCapture.pending"));
        await navigateSettings(page, "display");
        assert.equal(await page.locator("#assessmentSetup .assessment-recovery").count(), 0);
        assert.equal(await action.isVisible(), true);
        assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest(".assessment-recovery"))), false, "Navigation must not steal focus to recovery.");
        await capture("away");
        await action.focus(); await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector(".assessment-recovery p").textContent.includes("still pending"));
        await navigateSettings(page, "privacy");
        assert.equal(await page.locator("#assessmentSetup .assessment-recovery").count(), 1);
        assert.match(await page.locator(".assessment-recovery").innerText(), /still pending/);
        assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.responseCapture.pending")), raw);
        await navigateMain(page, "analyze");
        assert.equal(await action.isVisible(), true);
        assert.equal(await page.locator("#assessmentSetup .assessment-recovery").count(), 0);
        await navigateMain(page, "settings");
        await navigateSettings(page, "privacy");
        assert.equal(await page.locator("#assessmentSetup .assessment-recovery").count(), 1);
        await page.emulateMedia({ forcedColors: "active" });
        assert.equal(await action.isEnabled(), true);
        await capture("forced");
        await page.emulateMedia({ forcedColors: "none" });
        statusPhase = "not-started";
        await action.click();
        await page.waitForFunction(() => sessionStorage.getItem("wire.responseCapture.pending") === null);
        assert.equal(calls.filter(value => value.endpoint.endsWith("/consent/set")).length, 1);
        assert.equal(calls.filter(value => value.endpoint.endsWith("/mutation/status")).length, 2);
        assert.equal(await page.locator("body").textContent().then(text => text.includes(issued.receiptToken)), false);
    });
}
