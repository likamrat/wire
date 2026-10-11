import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { buildAssessmentModel, assessmentOverview, buildReportFacts } from "../lib/assessment-read-model.mjs";
import { createControlHelp } from "../lib/control-help.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { renderComparisonHtml } from "../lib/report-presentation.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { adaptReportMetric } from "../lib/report-facts.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { contract, quality, samples } from "./assessment-ui-fixtures.mjs";
import { fixture, exportCatalogFor, automaticScoreOffSummary, chooseTheme } from "./helpers.mjs";

function syntheticResults() {
    const records = ["assessed", "mixed", "missing"].map(name => fixture(`plain-${name}`));
    for (const [index, record] of records.entries()) {
        record.userPrompt = { ...record.userPrompt, text: "List the synthetic calendar items.",
            sourceEventId: `prompt-${index}`, sourceTimestamp: record.capturedAt };
        if (index < 2) Object.assign(record.toolCalls[0], {
            completionEventId: `complete-${index}`, startedAt: record.capturedAt,
            completedAt: `2026-09-30T12:00:0${index + 1}.000Z`, durationMs: (index + 1) * 1000,
        });
    }
    records[0].toolCalls.push({ ...records[0].toolCalls[0], toolCallId: "parallel-call", startEventId: "parallel-start",
        completionEventId: "parallel-end", completedAt: "2026-09-30T12:00:03.000Z", durationMs: 3000 });
    records[0].responseTiming = {
        schemaVersion: 1, status: "measured", boundary: "recorded-request-to-final-answer",
        promptEventId: "prompt-0", requestedAt: records[0].capturedAt,
        respondedAt: "2026-09-30T12:00:12.000Z", completedAt: "2026-09-30T12:00:12.100Z",
        durationMs: 12000, finalEventId: "final-0", completionEventId: "turn-0", association: "explicit-message-link",
    };
    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: records, exports: [] };
    const model = buildAssessmentModel(state);
    for (const [index, view] of [...model.details.values()].entries()) {
        if (index === 2) continue;
        for (const [slot, dimension] of ["accuracy", "answer-trust", "action-trust"].entries()) {
            const verdict = index === 0 ? dimension === "answer-trust" ? "fail" : "pass"
                : dimension === "accuracy" ? "fail" : "unassessed";
            const metric = quality(dimension, { pass: +(verdict === "pass"), fail: +(verdict === "fail"),
                unassessed: +(verdict === "unassessed"), personal: true, offset: index * 10 });
            Object.assign(metric, {
                basis: { ...view.basis }, origin: "model-assessed", metricRef: samples.id("metric", 900 + index * 10 + slot),
                checkId: { accuracy: "request-requirements-corroborated", "answer-trust": "recorded-answer-support", "action-trust": "action-intent-alignment" }[dimension],
                eligibleUnitRefs: [view.interaction.interactionRef],
                coveredUnitRefs: verdict === "unassessed" ? [] : [view.interaction.interactionRef],
                unassessedReasons: verdict === "unassessed" ? [{ reason: "missing-evidence", count: 1 }] : [],
                evaluator: { provider: "github-copilot", model: "synthetic-review-model", rubricId: "wire-recorded-interaction-review", rubricVersion: 1 },
            });
            if (verdict === "unassessed") metric.reason = "missing-evidence";
            if (index === 1 && dimension === "action-trust") Object.assign(metric, {
                status: "evaluator-error", reason: "evaluator-failure",
                counts: { pass: 0, fail: 0, unassessed: 0, evaluatorError: 1 },
                unassessedReasons: [],
            });
            view.metrics.push(contract.validateMetric(metric));
        }
        view.reviewStatus.assessment.result = index === 0 ? "assessed" : "partial";
        view.reviewStatus.assessment.unavailableReason = index === 0 ? null : "other-unavailable";
        view.reviewStatus.assessment.latestAttempt = "complete";
        contract.validateInteractionView(view);
    }
    model.overview = assessmentOverview(state, model, [...model.details.keys()]);
    const facts = structuredClone(buildReportFacts(records, state).facts);
    facts.metrics.push(...structuredClone(model.overview.metrics.filter(metric => metric.origin === "model-assessed")));
    return { records, state, model, facts };
}

test("plain explanations work in the normal renderer for mixed and missing results, keyboard and touch", { timeout: 60000 }, async t => {
    const { records, state, model, facts } = syntheticResults(), glossary = createControlHelp(serviceCategories).glossary;
    const original = JSON.stringify({ records, facts, metrics: model.overview.metrics });
    const errors = [], rejected = [], proof = [];
    const collection = { state: "not-configured", revision: 1, configVersion: 0, connected: false, config: null,
        cadence: { pollSeconds: 5 }, metrics: {}, historyIssues: [] };
    const report = id => ({ schemaVersion: 1, bundleId: `export-${id}`, snapshotHash: id.repeat(64),
        disclosureReviewed: true, patternVersion: 1, metrics: facts.metrics.filter(metric => contract.CURRENT_DIMENSIONS.includes(metric.dimension)).map(adaptReportMetric), toolRows: [],
        scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "synthetic", callTimesAvailable: false, historyComplete: false } });
    const comparison = compareFrozenReportFacts(report("a"), report("b"));
    const reportHtml = (await buildSanitizedBundle(records, state.pseudonymKey,
        { promptMode: "none", formats: ["html"] }, undefined, undefined, facts)).previewHtml;
    const comparisonHtml = renderComparisonHtml(comparison, { bundleId: "export-synthetic", preparedAtDisplay: "Synthetic comparison",
        sourceReports: [comparison.baseline, comparison.later] });
    const server = createServer(async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET" && ["/", "/synthetic-report", "/synthetic-comparison"].includes(req.url)) {
            res.setHeader("Content-Type", "text/html");
            return res.end(req.url === "/" ? renderHtmlShell("a".repeat(64), "plain-language") : req.url === "/synthetic-report" ? reportHtml : comparisonHtml);
        }
        if (req.method === "GET" && req.url === "/favicon.ico") return res.writeHead(204).end();
        if (req.method === "GET" && req.url === "/assets/assessment-contract.mjs") {
            res.setHeader("Content-Type", "text/javascript");
            return res.end(await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url)));
        }
        if (req.method === "POST" && ["/api/collection/status", "/api/record/status", "/api/evaluation/automatic/summary"].includes(req.url)) {
            return res.end(JSON.stringify(req.url === "/api/collection/status" ? collection
                : req.url === "/api/record/status" ? { attempt: null } : automaticScoreOffSummary()));
        }
        if (req.method === "POST" && ["/api/snapshot", "/api/assessment/overview", "/api/assessment/detail"].includes(req.url)) {
            let text = ""; for await (const chunk of req) text += chunk;
            const input = JSON.parse(text);
            if (req.url !== "/api/snapshot") return res.end(JSON.stringify({ schemaVersion: 1, basis: model.basis,
                data: req.url.endsWith("/detail") ? model.details.get(input.interactionRef) : assessmentOverview(state, model, input.interactionRefs) }));
            return res.end(JSON.stringify({ revision: 1, scenarios: records, exports: [], exportCatalog: exportCatalogFor(records), collection,
                assessment: { schemaVersion: 1, basis: model.basis, catalog: model.catalog, overview: model.overview,
                    consent: model.consent, source: model.source, capabilities: model.capabilities },
                coverage: { since: "2026-09-01", until: "2026-09-30", notes: [] },
                analytics: { ...buildActivityAnalytics(records, input), revision: 1 } }));
        }
        rejected.push(`${req.method} ${req.url}`);
        res.writeHead(403).end('{"error":"Only synthetic read endpoints are available."}');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(errors, []); assert.deepEqual(rejected, []);
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, hasTouch: true, reducedMotion: "reduce" });
    await context.route("**/*", route => {
        if (new URL(route.request().url()).origin !== origin) { rejected.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    const proofDir = process.env.WIRE_PLAIN_LANGUAGE_PROOFS;
    if (proofDir) await mkdir(proofDir, { recursive: true });
    async function capture(name, locator) {
        proof.push({ name, text: await locator.innerText() });
        if (proofDir) await locator.screenshot({ path: path.join(proofDir, `${name}.png`) });
    }
    for (const route of ["#home", "#activity"]) {
        await page.goto(origin + route);
        const insights = page.locator("#homeInsights");
        if (!await insights.locator(".assessment-saved-details").evaluate(node => node.open)) await insights.locator(".assessment-saved-details > summary").click();
        await insights.locator(".assessment-grid").waitFor();
        const text = await insights.innerText();
        assert.match(text, /2 of 3 requests assessed/);
        assert.match(text, /1 of 3 requests assessed/);
        assert.match(text, /3 of 4 calls timed/);
        assert.match(text, /1 of 3 requests timed/);
        assert.doesNotMatch(text, /three AI checks cover the same/);
        const help = insights.getByRole("button", { name: "About Accuracy", exact: true });
        await page.mouse.move(0, 0);
        await help.hover();
        await page.getByRole("tooltip").waitFor();
        assert.equal(await page.getByRole("tooltip").innerText(), glossary.accuracy.definition);
        await page.keyboard.press("Escape");
        await capture(route.slice(1), insights);
    }
    for (const [id, expected] of [["plain-assessed", /0 passed.*1 failed/s], ["plain-mixed", /Insufficient recorded evidence[\s\S]*evaluator error/], ["plain-missing", /not assessed|No verdict/]]) {
        await page.goto(origin + `#request?request=${id}`);
        const insights = page.locator(".interaction-insights");
        if (!await insights.locator(".assessment-saved-details").evaluate(node => node.open)) await insights.locator(".assessment-saved-details > summary").click();
        await insights.locator(".assessment-grid").waitFor();
        assert.match(await insights.innerText(), expected);
        await capture(id, insights);
    }
    const insights = page.locator(".interaction-insights");
    for (const theme of ["light", "dark"]) for (const [width, size] of [[1280, 100], [375, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(size => document.documentElement.style.fontSize = `${size}%`, size);
        for (const term of ["accuracy", "speed", "trust"]) {
            const help = insights.getByRole("button", { name: `About ${glossary[term].label}`, exact: true }).first();
            await help.focus();
            await page.keyboard.press("Enter");
            const tooltip = page.getByRole("tooltip");
            await tooltip.waitFor();
            assert.equal(await tooltip.innerText(), glossary[term].definition);
            const geometry = await tooltip.evaluate(node => {
                const r = node.getBoundingClientRect();
                return { fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
                    noClip: node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1 };
            });
            assert.ok(geometry.fits && geometry.noClip, `${theme}/${width}/${size}/${term}: full explanation remains visible`);
            const target = await help.boundingBox();
            assert.ok(target.width >= 44 && target.height >= 44);
            assert.equal(await help.getAttribute("aria-describedby"), "evidence-tooltip");
            assert.equal(await help.evaluate(node => node === document.activeElement), true);
            assert.equal(await help.evaluate(node => getComputedStyle(node).outlineStyle !== "none"), true);
            await capture(`${theme}-${width}-${size}-${term}`, tooltip);
            await page.keyboard.press("Escape");
            await page.waitForTimeout(220);
            assert.equal(await tooltip.isVisible(), false);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    }
    const help = insights.getByRole("button", { name: "About Accuracy", exact: true });
    await help.tap(); await page.getByRole("tooltip").waitFor();
    await insights.getByRole("heading", { name: "Insights", exact: true }).tap();
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    const details = insights.getByRole("button", { name: "Details and feedback", exact: true });
    await details.click();
    const dialog = page.getByRole("dialog", { name: "Insight details", exact: true });
    await dialog.getByText("Glossary", { exact: true }).click();
    assert.match(await dialog.innerText(), /passed plus failed/);
    assert.match(await dialog.innerText(), /lower middle/);
    await capture("glossary-enlarged", dialog);
    await page.keyboard.press("Escape");
    assert.equal(await details.evaluate(node => node === document.activeElement), true);
    for (const route of ["/synthetic-report", "/synthetic-comparison"]) {
        await page.goto(origin + route);
        for (const theme of ["light", "dark"]) {
            await page.evaluate(theme => { document.documentElement.dataset.evidenceTheme = theme; document.documentElement.style.fontSize = "200%"; }, theme);
            const notes = page.locator(route === "/synthetic-report" ? "#quality" : ".reading-notes");
            if (await notes.evaluate(node => node.tagName === "DETAILS" && !node.open)) await notes.locator("summary").click();
            assert.match(await notes.innerText(), /A successful tool call does not prove the answer was correct/);
            assert.match(await notes.innerText(), /Missing results are left out/);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            await capture(`${route.slice(1)}-${theme}`, notes);
        }
    }
    assert.equal(JSON.stringify({ records, facts, metrics: model.overview.metrics }), original, "Presentation leaves facts unchanged.");
    if (proofDir) await writeFile(path.join(proofDir, "rendered-copy.json"), JSON.stringify(proof, null, 2));
});
