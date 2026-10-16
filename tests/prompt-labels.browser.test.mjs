import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { buildAssessmentModel, assessmentOverview } from "../lib/assessment-read-model.mjs";
import { fixture, exportCatalogFor, chooseTheme, openActivitySessions, navigateMain, automaticScoreOffSummary } from "./helpers.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { createTextAccess } from "../web/text-access.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { createDisclosureState } from "../web/disclosure-state.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
const proofs = process.env.WIRE_PROMPT_PROOFS;
const original = "ARTIFICIAL PROMPT ONLY\n  Preserve these spaces  \n" +
    "Compare invented calendar entries without executing this prompt. ".repeat(24) +
    "\nUnicode: \u65e5\u672c\u8a9e e\u0301 \ud83d\udc69\u200d\ud83d\ude80\nEND";
const warning = "Copy includes the complete retained prompt body only, without export masking. It does not include chat details, warnings, the response or the rest of this page. Other apps and clipboard history may access your system clipboard.";

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
        if (request.method() === "GET" && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: renderHtmlShell("a".repeat(64), "artificial-prompt-proof") });
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

test("wired Activity and detail readers use Prompt without inventing author identity", { timeout: 45000 }, async t => {
    const { page, sources } = await setup(t);
    await page.goto("https://wire.invalid/#activity"); await ready(page); await openActivitySessions(page);
    assert.deepEqual(await page.locator(".request-row .full-text-preview-label").allTextContents(), sources.map(() => "Copilot chat prompt / This older record has no sender details"));
    assert.equal(await page.getByRole("button", { name: "Read more", exact: true }).count(), 1);
    const row = page.locator(".request-row").filter({ hasText: "ARTIFICIAL PROMPT ONLY" });
    await row.locator("input").check();
    await row.getByRole("button", { name: "Read more", exact: true }).click();
    assert.equal(await row.locator(".ux-code-label").textContent(), "Copilot chat prompt / local only");
    await row.getByRole("link", { name: "View interaction", exact: true }).click(); await ready(page);
    await page.goBack(); await ready(page);
    assert.equal(await row.locator("input").isChecked(), true);
    assert.equal(await row.getByRole("button", { name: "Read less", exact: true }).getAttribute("aria-expanded"), "true");
    await navigateMain(page, "reports"); await ready(page);
    await page.locator("#reportRequests > summary").click();
    assert.deepEqual(await page.locator("#reportList .full-text-preview-label").allTextContents(), ["Copilot chat prompt / This older record has no sender details"]);
    assert.match(await page.locator("#reportRequestSearchHelp").textContent(), /retained prompt text/);
    for (const source of sources) {
        await page.goto(`https://wire.invalid/#request?request=${source.scenarioId}`); await ready(page);
        const reader = page.locator(".request-original");
        assert.equal(await reader.getByRole("heading", { name: "Copilot chat prompt", exact: true }).count(), 1);
        assert.doesNotMatch(await reader.innerText(), /My prompt|User prompt|Agent prompt|Request text/);
        if (source.userPrompt.status === "unavailable") {
            assert.match(await reader.innerText(), /Prompt not available/);
            assert.equal(await reader.locator("button").count(), 0);
        } else {
            assert.equal(await reader.getByText("This older record has no sender details", { exact: true }).count(), 1);
            const toggle = reader.locator(".full-text-toggle");
            if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
            assert.equal(await reader.locator("pre").textContent(), source.userPrompt.text);
            assert.equal(await reader.locator("pre").getAttribute("aria-label"), "Exact recorded prompt text");
            assert.equal(await reader.getByRole("button", { name: "Copy prompt", exact: true }).count(), 1);
        }
    }
    await page.getByText("Technical source record", { exact: true }).click();
    await page.getByText("Nearby follow-ups / inferred associations", { exact: true }).click();
    await page.locator("summary").filter({ hasText: /^Follow-up 1 \/ prompt$/ }).click();
    assert.match(await page.locator(".request-support").innerText(), /inferred association/);
    await page.getByText("Technical details", { exact: true }).last().click();
    await page.locator("summary").filter({ hasText: /^Exact recorded arguments \/ local only$/ }).click();
    assert.match(await page.locator(".journey-pages pre").innerText(), /Artificial API filter/);
    assert.equal(await page.getByRole("heading", { name: "Agent prompt", exact: true }).count(), 0);
});

test("Prompt reader keeps exact copy, keyboard focus, disclosure and synthetic light/navy reflow", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    await page.goto("https://wire.invalid/#request?request=unverified"); await ready(page);
    const reader = page.locator(".request-original"), toggle = reader.locator(".full-text-toggle");
    const route = page.url(), selection = await page.locator("#activitySelectionSummary").textContent();
    assert.equal(await toggle.textContent(), "Read prompt");
    assert.equal(await toggle.getAttribute("aria-label"), "Read prompt");
    assert.equal(await reader.locator("pre").count(), 0);
    await toggle.focus(); await page.keyboard.press("Enter");
    assert.equal(await toggle.getAttribute("aria-label"), "Hide prompt");
    assert.equal(await toggle.evaluate(node => document.activeElement === node), true);
    assert.equal(await reader.locator("pre").textContent(), original);
    await reader.locator(".reader-details > summary").click();
    assert.equal(await reader.getByText(warning, { exact: true }).count(), 1);
    const copy = reader.getByRole("button", { name: "Copy prompt", exact: true });
    await toggle.focus();
    await page.keyboard.press("Tab");
    assert.equal(await copy.evaluate(node => document.activeElement === node), true);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.syntheticCopies.length === 1);
    assert.deepEqual(await page.evaluate(() => window.syntheticCopies), [original]);
    await page.evaluate(() => { window.copyDenied = true; });
    await copy.click();
    assert.match(await reader.getByRole("alert").textContent(), /Couldn't copy/);
    await toggle.focus(); await page.keyboard.press("Space");
    assert.equal(await reader.locator("pre,.ux-copy-status").count(), 0);
    await page.keyboard.press("Enter");
    assert.equal(page.url(), route);
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), selection);
    const metrics = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [375, 1200]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const measure = await reader.evaluate(node => ({
            overflow: document.documentElement.scrollWidth - innerWidth,
            textOverflow: node.querySelector("pre").scrollWidth - node.querySelector("pre").clientWidth,
            heading: node.querySelector("h2").textContent,
            controls: [...node.querySelectorAll(".full-text-header button")].map(button => {
                const box = button.getBoundingClientRect();
                return { width: box.width, height: box.height, overflow: button.scrollWidth - button.clientWidth };
            }),
        }));
        assert.ok(measure.overflow <= 1 && measure.textOverflow <= 1, `${theme}/${width}/${scale}: no overflow`);
        assert.equal(measure.heading, "Copilot chat prompt");
        assert.equal(measure.controls.length, 2);
        assert.ok(measure.controls.every(control => control.width >= 44 && control.height >= 44 && control.overflow <= 1));
        assert.equal(await reader.locator("pre").textContent(), original);
        metrics.push({ theme, width, scale, ...measure });
    }
    if (proofs) {
        await writeFile(path.join(proofs, "prompt-layout.json"), JSON.stringify(metrics, null, 2));
        await page.goto("https://wire.invalid/#request?request=coordinator"); await ready(page);
        for (const theme of ["light", "dark"]) for (const width of [375, 1200]) for (const scale of [1, 2]) {
            await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; scrollTo(0, 0); }, scale);
            await reader.screenshot({ path: path.join(proofs, `prompt-${theme}-${width}-${scale}x.png`) });
        }
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
