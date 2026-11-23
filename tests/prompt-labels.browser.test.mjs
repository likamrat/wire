import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { buildAssessmentModel, assessmentOverview } from "../lib/assessment-read-model.mjs";
import { fixture, exportCatalogFor, automaticScoreOffSummary, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { createTextAccess } from "../web/text-access.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { createDisclosureState } from "../web/disclosure-state.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
const original = "ARTIFICIAL PROMPT ONLY\n  Preserve these spaces  \n" +
    "Compare invented calendar entries without executing this prompt. ".repeat(24) +
    "\nUnicode: \u65e5\u672c\u8a9e e\u0301 \ud83d\udc69\u200d\ud83d\ude80\nEND";

function records() {
    return [
        ["unverified", "recorded-user-message-origin-unverified", "full", original],
        ["coordinator", "coordinator-message", "full", "The user instructed: artificial forwarded message."],
        ["legacy-human", "human-authored", "full", "Artificial legacy attribution, not verified identity."],
        ["missing", "unavailable", "unavailable", null],
        ["inferred", undefined, "partial", "Artificial inferred prompt fragment."],
    ].map(([id, provenance, status, text]) => {
        const record = fixture(id);
        record.sourceSessionName = "Artificial prompt-label proof";
        record.userPrompt = { status, provenance, text, sourceEventId: `${id}-message` };
        record.followUpPrompts = [{ text: "Artificial next message.", status: "full", provenance: "coordinator-message",
            association: "Nearest following user message only; follow-up relationship inferred, not confirmed." }];
        record.toolCalls[0].startedAt = "2026-10-06T12:00:00.000Z";
        record.toolCalls[0].requestArgs = { entityUrls: ["/me/events"], filter: "subject eq 'Artificial API filter'" };
        return record;
    });
}

async function setup(t) {
    const sources = records(), before = structuredClone(sources);
    const state = { revision: 7, evidence: sources, exports: [], pseudonymKey: "a".repeat(64) };
    const model = buildAssessmentModel(state);
    const moduleSource = await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8");
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", timezoneId: "America/Los_Angeles" });
    const page = await context.newPage(), unexpected = [], errors = [], calls = [];
    page.setDefaultTimeout(6000);
    page.on("pageerror", error => errors.push(error.message));
    await context.addInitScript(() => {
        window.syntheticCopies = [];
        window.copyDenied = false;
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw new Error("No clipboard reads in artificial proof."); },
            async writeText(text) {
                if (window.copyDenied) throw new DOMException("Artificial denial", "NotAllowedError");
                window.syntheticCopies.push(text);
            },
        } });
    });
    await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== "https://wire.invalid") { unexpected.push(url.href); return route.abort(); }
        if (request.method() === "GET" && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: renderHtmlShell("a".repeat(64), "artificial-prompt-proof", UNBOUND_FIXTURE_BOOTSTRAP) });
        if (request.method() === "GET" && url.pathname === "/assets/assessment-contract.mjs") return route.fulfill({ contentType: "text/javascript", body: moduleSource });
        if (request.method() === "GET" && url.pathname === "/favicon.svg") return route.fulfill({ status: 204 });
        const input = request.postDataJSON();
        calls.push(url.pathname);
        const envelope = data => ({ schemaVersion: 1, basis: model.basis, data });
        if (url.pathname === "/api/evaluation/automatic/summary") return route.fulfill({ json: automaticScoreOffSummary() });
        if (url.pathname === "/api/snapshot") return route.fulfill({ json: {
            revision: 7, scenarios: sources, exports: [], coverage: { since: "2026-10-01", until: "2026-10-06", notes: [] },
            analytics: { ...buildActivityAnalytics(sources, input), revision: 7 },
            requestActivity: buildRequestActivity(sources), exportCatalog: exportCatalogFor(sources),
            assessment: { schemaVersion: 1, basis: model.basis, catalog: model.catalog, overview: model.overview,
                consent: model.consent, source: model.source, capabilities: model.capabilities },
        } });
        if (url.pathname === "/api/assessment/detail") return route.fulfill({ json: envelope(model.details.get(input.interactionRef)) });
        if (url.pathname === "/api/assessment/overview") return route.fulfill({ json: envelope(assessmentOverview(state, model, input.interactionRefs)) });
        unexpected.push(url.pathname);
        return route.abort();
    });
    t.after(async () => {
        await browser.close();
        assert.deepEqual(unexpected, [], "Every browser request is intercepted; no runtime, external access or mutation");
        assert.deepEqual(errors, []);
        assert.deepEqual(sources, before, "Original retained data is untouched");
    });
    return { page, sources, calls };
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await page.evaluate(() => document.fonts.ready);
}

test("actual history attribution never promotes a user role or forwarded wording to verified human identity", () => {
    const source = { sessionId: "synthetic-session", appId: "synthetic-app" };
    for (const text of ["The user instructed: artificial coordinator wording.", "<cross_session_message>Artificial forwarded text</cross_session_message>"]) {
        const extracted = extractScenarios([
            { id: "prompt", type: "user.message", timestamp: "2026-10-06T12:00:00Z", data: { content: text } },
            { id: "call", type: "tool.execution_start", timestamp: "2026-10-06T12:00:01Z",
                data: { toolName: "workiq-ask", mcpServerName: "workiq", toolCallId: "synthetic-call", arguments: { question: "Artificial agent-to-tool question." } } },
        ], source, "2026-10-06T00:00:00Z", "2026-10-07T00:00:00Z").scenarios[0];
        assert.equal(extracted.userPrompt.provenance, "recorded-user-message-origin-unverified");
        assert.equal(extracted.userPrompt.authorship.actor, "unknown");
        assert.equal(extracted.userPrompt.text, text);
        assert.equal(extracted.toolCalls[0].requestArgs.question, "Artificial agent-to-tool question.");
        assert.match(extracted.promptAssociation, /inferred/);
    }
});

test("legacy provenance and forwarded wording cannot supply a verified author on the card or reader", async t => {
    const { page, sources } = await setup(t);
    await page.goto("https://wire.invalid/"); await ready(page);
    for (const source of sources) {
        const card = page.locator(`article[data-view-key="request:${source.scenarioId}"]`);
        await expect(card.locator(".request-card-author")).toHaveText("Author unverified");
        await card.locator(".request-card-open").press("Enter");
        const section = page.locator('[data-reader-section="prompt"]');
        await expect(section.getByRole("heading")).toContainText("Author unverified");
        await expect(section).toContainText("This older record has no sender details");
        if (source.userPrompt.text === null) {
            await expect(section).toContainText("Prompt text unavailable");
            await expect(section.getByRole("button", { name: "Copy prompt" })).toHaveCount(0);
        } else {
            if (source.userPrompt.status === "partial") await expect(section).toContainText("Partial text");
            assert.equal(await section.locator("pre").textContent(), source.userPrompt.text);
        }
        await page.goBack(); await expect(card.locator(".request-card-open")).toBeFocused();
    }
});

test("keyboard Copy takes the complete retained prompt and a denial leaves it readable", async t => {
    const { page } = await setup(t);
    await page.goto("https://wire.invalid/#request?request=unverified"); await ready(page);
    const section = page.locator('[data-reader-section="prompt"]');
    const toggle = section.getByRole("button", { name: "Author unverified", exact: true });
    const copy = section.getByRole("button", { name: "Copy prompt", exact: true }), text = section.locator(".full-text-content");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    assert.equal(await text.textContent(), original);
    await toggle.press("Enter"); await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.press("Tab"); await expect(copy).toBeFocused();
    await copy.press("Enter");
    await expect.poll(() => page.evaluate(() => window.syntheticCopies)).toEqual([original]);
    await page.evaluate(() => { window.copyDenied = true; });
    await copy.click();
    await expect(section.getByRole("alert")).toContainText(/copy/i);
    assert.equal(await text.textContent(), original);
    for (const [width, scale] of [[1200, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        assert.ok(await text.evaluate(n => n.scrollWidth <= n.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1));
        const rect = await copy.boundingBox(); assert.ok(rect.width >= 44 && rect.height >= 44);
    }
});

test("response subject keeps its existing reader labels and is never relabeled a prompt", { timeout: 15000 }, async t => {
    const browser = await chromium.launch(), page = await browser.newPage();
    t.after(() => browser.close());
    await page.route("**/*", route => route.abort());
    await page.setContent('<!doctype html><html><body><main id="reader"></main></body></html>');
    await page.addStyleTag({ content: styles });
    await page.addScriptTag({ content: `
        const createAccess = ${createTextAccess.toString()};
        const createUX = ${createEvidenceUX.toString()};
        const createDisclosure = ${createDisclosureState.toString()};
        document.querySelector("#reader").append(createAccess(createUX(${JSON.stringify(uxIcons)}), createDisclosure())
            .render({status:"full",text:"Artificial assistant response"}, {key:"response-proof",subject:"response",mode:"complete"}));
    ` });
    assert.equal(await page.locator("h3").textContent(), "Retained response text");
    assert.equal(await page.getByRole("button", { name: "Hide response", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Copy response", exact: true }).count(), 1);
    assert.equal(await page.getByText("Author unverified", { exact: true }).count(), 0);
});
