// Normal app shell and read paths, backed only by invented in-memory facts.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { buildAssessmentModel, assessmentOverview } from "../lib/assessment-read-model.mjs";
import * as contract from "../lib/assessment-contract.mjs";
import { createAssessmentPresentation } from "../web/assessment-presentation.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { fixture, exportCatalogFor, chooseTheme, navigateMain, automaticScoreOffSummary } from "./helpers.mjs";

const proofs = process.env.WIRE_INSIGHT_PROOFS;
const render = process.env.WIRE_INSIGHT_BASELINE
    ? (await import(pathToFileURL(path.join(process.env.WIRE_INSIGHT_BASELINE, "lib", "render.mjs")))).renderHtmlShell : renderHtmlShell;
const formatter = createAssessmentPresentation(contract);
const checks = { accuracy: "request-requirements-corroborated", "answer-trust": "recorded-answer-support", "action-trust": "action-intent-alignment" };
function records(supplied = false) {
    let callIndex = 0;
    return Array.from({ length: supplied ? 69 : 4 }, (_, index) => {
        const record = fixture(`hierarchy-${index}`), start = Date.UTC(2026, 9, 1, 12, index);
        record.sourceSessionId = `hierarchy-chat-${index}`;
        record.userPrompt = { ...record.userPrompt, text: `Synthetic hierarchy request ${index}`, sourceEventId: `prompt-${index}`, sourceTimestamp: new Date(start).toISOString() };
        record.followUpPrompts = [];
        record.toolCalls = Array.from({ length: supplied ? index < 19 ? 4 : 3 : 1 }, () => {
            const call = structuredClone(record.toolCalls[0]), id = callIndex++;
            Object.assign(call, { toolCallId: `call-${id}`, startEventId: `start-${id}`, completionEventId: `end-${id}`, startedAt: new Date(start).toISOString() });
            const duration = supplied ? 2955 : 3072;
            if (id < (supplied ? 225 : 3)) Object.assign(call, { completedAt: new Date(start + duration).toISOString(), durationMs: duration });
            return call;
        });
        if (index < (supplied ? 8 : 2)) record.responseTiming = recordedResponseTiming([
            { id: `prompt-${index}`, type: "user.message", timestamp: new Date(start).toISOString(), data: { messageId: "p" } },
            { id: `answer-${index}`, type: "assistant.message", timestamp: new Date(start + (supplied ? 16820 : 29713)).toISOString(), data: {
                wireResponseMetadataVersion: 1, hasResponseText: true, finalAnswer: true, hasToolRequests: false, turnId: "t", originatingMessageId: "p",
            } },
            { id: `turn-${index}`, type: "assistant.turn_end", timestamp: new Date(start + (supplied ? 16821 : 29714)).toISOString(), data: { turnId: "t" } },
        ], record.userPrompt);
        return record;
    });
}
function withQuality(metrics, mode) {
    if (mode === "unassessed") return metrics;
    if (mode === "mixed") return [...withQuality(metrics, "ordinary"), ...withQuality(metrics, "personal").slice(metrics.length).map(metric => ({
        ...metric, metricRef: metric.metricRef.replace("0000", "1000"),
    }))];
    const additions = metrics.filter(metric => checks[metric.dimension]).map((original, index) => {
        const metric = structuredClone(original), eligible = metric.coverage.eligible;
        const unavailable = ["error", "insufficient"].includes(mode);
        const covered = unavailable ? 0 : mode === "one-of-69" ? 1 : mode === "different" ? Math.min(index, eligible) : mode === "ordinary" ? Math.min(3, eligible) : eligible;
        const pass = mode === "zero" || mode === "personal" && index === 2 ? 0 : mode === "ordinary" ? Math.min(2, covered) : covered;
        Object.assign(metric, {
            metricRef: `metric-${(900 + index).toString(16).padStart(32, "0")}`,
            origin: mode === "personal" ? "user-personal" : "model-assessed",
            checkId: mode === "personal" ? original.checkId : checks[metric.dimension],
            status: covered ? "measured" : mode === "error" ? "evaluator-error" : "unassessed",
            value: covered ? pass / covered : null, reason: covered ? null : mode === "error" ? "evaluator-failure" : "missing-evidence",
            numerator: pass, denominator: covered, coverage: { covered, eligible },
            counts: { pass, fail: covered - pass, unassessed: mode === "error" ? 0 : eligible - covered, evaluatorError: mode === "error" ? eligible : 0 },
            unassessedReasons: mode === "error" || covered === eligible ? [] : [{ reason: "missing-evidence", count: eligible - covered }],
            coveredUnitRefs: metric.eligibleUnitRefs.slice(0, covered),
            evidenceRefs: covered ? [`evidence-${(900 + index).toString(16).padStart(32, "0")}`] : [],
        });
        if (mode !== "personal") metric.evaluator = { provider: "github-copilot", model: "synthetic-only", rubricId: "wire-recorded-interaction-review", rubricVersion: 1 };
        return contract.validateMetric(metric);
    });
    return [...metrics, ...additions];
}
async function setup(t, { supplied = false } = {}) {
    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: records(supplied), exports: [] }, before = structuredClone(state);
    const model = buildAssessmentModel(state), rejected = [], errors = [], calls = [];
    let mode = "unassessed", automaticState = "off";
    const collection = { state: "not-configured", revision: 1, configVersion: 0, connected: false, config: null,
        cadence: { pollSeconds: 5 }, metrics: {}, historyIssues: [] };
    const overview = refs => {
        const result = assessmentOverview(state, model, refs);
        return { ...result, metrics: withQuality(result.metrics, mode) };
    };
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html");
            return res.end(render("a".repeat(64), "synthetic-hierarchy"));
        }
        if (req.method === "GET" && req.url === "/favicon.ico") return res.writeHead(204).end();
        if (req.method === "GET" && req.url === "/assets/assessment-contract.mjs") {
            res.setHeader("Content-Type", "text/javascript");
            return res.end(await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url)));
        }
        let text = ""; for await (const part of req) text += part;
        const input = text ? JSON.parse(text) : {};
        calls.push({ method: req.method, path: req.url, input });
        res.setHeader("Content-Type", "application/json");
        const json = value => res.end(JSON.stringify(value));
        if (req.method === "POST" && req.url === "/api/collection/status") return json(collection);
        if (req.method === "POST" && req.url === "/api/evaluation/automatic/summary") {
            const summary = automaticScoreOffSummary();
            summary.snapshot.state = automaticState;
            summary.snapshot.reason = automaticState === "assessing" ? "in-progress" : summary.snapshot.reason;
            return json(summary);
        }
        if (req.method === "POST" && req.url === "/api/snapshot") return json({
            revision: 1, scenarios: state.evidence, exports: [], exportCatalog: exportCatalogFor(state.evidence), collection,
            assessment: { schemaVersion: 1, basis: model.basis, catalog: model.catalog, overview: overview(model.overview.interactionRefs),
                consent: model.consent, source: model.source, capabilities: model.capabilities },
            coverage: { since: "2026-10-01", until: "2026-10-01", notes: ["Synthetic presentation proof only."] },
            analytics: { ...buildActivityAnalytics(state.evidence, input), revision: 1 },
        });
        if (req.method === "POST" && req.url === "/api/assessment/overview") {
            contract.validateRequest("get_assessment_overview", input);
            return json({ schemaVersion: 1, basis: model.basis, data: overview(input.interactionRefs) });
        }
        if (req.method === "POST" && req.url === "/api/assessment/detail") {
            contract.validateRequest("get_interaction", input);
            const detail = structuredClone(model.details.get(input.interactionRef));
            detail.metrics = withQuality(detail.metrics, mode);
            contract.validateInteractionView(detail);
            return json({ schemaVersion: 1, basis: model.basis, data: detail });
        }
        rejected.push(`${req.method} ${req.url}`);
        res.writeHead(403).end('{"error":"Only synthetic presentation reads are allowed."}');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== origin) { rejected.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw new Error("Clipboard reads forbidden."); }, writeText() { throw new Error("Clipboard writes forbidden."); },
    } }));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(rejected, []); assert.deepEqual(errors, []); assert.deepEqual(state, before);
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    return { page, origin, calls, model, overview, setMode: value => { mode = value; },
        setAutomaticState: value => { automaticState = value; } };
}
async function ready(page, host) {
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator(`${host} .assessment-grid`).waitFor().catch(error => {
        return page.locator(host).innerText().then(text => { throw new Error(`${text}\n${error.message}`); });
    });
    await page.evaluate(() => document.fonts.ready);
}
async function capture(page, host, name) {
    if (!proofs) return;
    await page.evaluate(() => scrollTo(0, 0));
    const clip = await host.evaluate(node => {
        const r = node.getBoundingClientRect();
        return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
    });
    await page.screenshot({ path: path.join(proofs, `${name}-insights.png`), fullPage: true, clip });
    await page.screenshot({ path: path.join(proofs, `${name}-context.png`), fullPage: true });
}
async function geometry(host) {
    return host.evaluate(root => {
        const box = node => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const text = node => {
            if (!node) return null;
            const css = getComputedStyle(node), range = document.createRange();
            range.selectNodeContents(node);
            return { text: node.textContent, tag: node.tagName, box: box(node),
                textBoxes: [...range.getClientRects()].map(r => ({ x: r.x, right: r.right, y: r.y, bottom: r.bottom })),
                font: css.fontFamily, size: css.fontSize, weight: css.fontWeight, line: css.lineHeight, color: css.color };
        };
        return { overflow: document.documentElement.scrollWidth > innerWidth + 1, background: getComputedStyle(document.body).backgroundColor,
            textScale: parseFloat(getComputedStyle(document.documentElement).fontSize) / 16,
            fontLoaded: [...document.fonts].some(font => font.family.includes("Asta Sans") && font.status === "loaded"),
            groups: [...root.querySelectorAll(".assessment-dimension,.assessment-timing")].map(group => ({
                title: group.querySelector("h3,h4").textContent, box: box(group),
                rows: [...group.querySelectorAll(".assessment-fact")].map(row => ({
                    dimension: row.dataset.dimension, band: row.dataset.band, bandVersion: row.dataset.bandVersion,
                    display: getComputedStyle(row).display, border: getComputedStyle(row).borderTopWidth,
                    borderColor: getComputedStyle(row).borderTopColor, box: box(row),
                    label: text(row.querySelector(".assessment-fact-label")), value: text(row.querySelector(".assessment-value")),
                    coverage: text(row.querySelector(".assessment-coverage")), origin: text(row.querySelector(".assessment-origin")),
                    reason: text(row.querySelector(".assessment-unavailable-reason,.assessment-qualification")),
                })),
            })) };
    });
}
function contrast(foreground, background) {
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function hierarchyIssues(layout) {
    const issues = [];
    for (const group of layout.groups) for (const [index, row] of group.rows.entries()) {
        const prefix = `${row.dimension}/${index}`;
        if (!row.label || row.label.tag !== "H4") issues.push(`${prefix}: missing measure heading`);
        const quality = row.dimension !== "speed";
        for (const [role, item, size] of [["label", row.label, 16], ["value", row.value, quality ? 16 : 22], ["coverage", row.coverage, 16]]) {
            if (item && Math.abs(parseFloat(item.size) - size * layout.textScale) > 0.01) issues.push(`${prefix}: ${role} is not the required ${size}px text role`);
        }
        if (row.label && row.dimension === "accuracy" && row.label.text !== "Answer correctness") issues.push(`${prefix}: incorrect Accuracy measure label`);
        const parts = [row.label, row.coverage, row.value].filter(Boolean);
        for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
            const x = parts[a].box, y = parts[b].box;
            if (Math.min(x.right, y.right) > Math.max(x.x, y.x) + 1
                && Math.min(x.bottom, y.bottom) > Math.max(x.y, y.y) + 1) issues.push(`${prefix}: reading cells overlap`);
        }
        if (index && row.border !== "1px") issues.push(`${prefix}: missing restrained divider`);
        for (const item of [row.label, row.value, row.coverage, row.origin, row.reason].filter(Boolean)) {
            if (contrast(item.color, layout.background) < 4.5) issues.push(`${prefix}: insufficient contrast for ${item.text}`);
            if (item.box.x < group.box.x - 1 || item.box.right > group.box.right + 1
                || item.textBoxes.some(rect => rect.x < item.box.x - 1 || rect.right > item.box.right + 1
                    || rect.y < item.box.y - 2 || rect.bottom > item.box.bottom + 2)) issues.push(`${prefix}: clipped ${item.text}`);
        }
    }
    for (const [index, group] of layout.groups.entries()) if (index && group.box.y < layout.groups[index - 1].box.bottom) {
        issues.push(`${group.title}: assessment groups overlap`);
    }
    if (layout.overflow) issues.push("Page has horizontal overflow");
    if (!layout.fontLoaded) issues.push("Asta Sans did not load");
    return issues;
}
async function assertFacts(host, model) {
    for (const dimension of ["accuracy", "answer-trust", "action-trust"]) {
        const facts = host.locator(`[data-dimension="${dimension}"]`);
        const group = model.evidence.quality[dimension], expected = group.rows.length ? group.rows : [group];
        assert.deepEqual(await facts.locator(".assessment-value").allTextContents(), expected.map(row => {
            const personal = model.groups[dimension].find(raw => raw.metricRef === row.metricRef)?.personalVerdict;
            return personal ?? (row.assessed > 0 && row.counts ? `${row.counts.pass} passed ${row.counts.fail} failed` : row.resultLabel ?? row.headline);
        }));
        assert.deepEqual(await facts.locator(".assessment-coverage").allTextContents(), expected.map(row => row.coverageLabel));
        assert.deepEqual(await facts.evaluateAll(nodes => nodes.map(node => node.dataset.band)), expected.map(() => "neutral"));
        for (const [index, row] of expected.entries()) {
            if (row.provenance) assert.ok((await facts.nth(index).textContent()).includes(row.provenance.label));
        }
    }
    assert.equal(await host.locator("[data-dimension=cost]").count(), 0);
}
test("Insights lead with check coverage and align dividers across normal surfaces and states", { timeout: 120000 }, async t => {
    const f = await setup(t), { page } = f, evidence = [], issues = [];
    for (const mode of ["unassessed", "ordinary", "zero", "full", "personal", "mixed", "different", "error", "insufficient"]) {
        f.setMode(mode);
        await page.goto("about:blank");
        await page.goto(f.origin + "#home"); await ready(page, "#homeInsights");
        const host = page.locator("#homeInsights");
        const expected = formatter.summarize(f.overview(f.model.overview.interactionRefs).metrics);
        const widths = ["ordinary", "personal"].includes(mode) ? [1440, 768, 464, 472, 375] : [1440, 375];
        const layouts = ["ordinary", "personal", "unassessed"].includes(mode)
            ? ["light", "dark"].flatMap(theme => widths.flatMap(width => [100, 200].map(zoom => [theme, width, zoom])))
            : [["light", 1440, 100], ["dark", 375, 200]];
        for (const [theme, width, zoom] of layouts) {
            await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
            await page.evaluate(zoom => { document.documentElement.style.fontSize = zoom + "%"; }, zoom);
            await page.mouse.move(0, 0);
            await assertFacts(host, expected);
            assert.deepEqual(await host.locator('[data-dimension="speed"] .assessment-value').allTextContents(), ["3.07 s", "29.71 s"]);
            assert.deepEqual(await host.locator('[data-dimension="speed"] .assessment-coverage').allTextContents(), ["3 of 4 calls timed", "2 of 4 requests timed"]);
            const layout = await geometry(host), name = `${mode}-${theme}-${width}-${zoom}`;
            assert.ok(layout.groups[0].box.bottom <= layout.groups[1].box.y, "Checks remain separate rows at every size.");
            evidence.push({ name, ...layout }); issues.push(...hierarchyIssues(layout).map(issue => `${name}: ${issue}`));
            if (proofs && ["unassessed", "ordinary", "personal", "mixed", "different", "error"].includes(mode)) {
                await capture(page, host, name);
            }
        }
    }
    f.setMode("personal");
    await page.goto("about:blank");
    await page.goto(f.origin + "#home"); await ready(page, "#homeInsights");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await navigateMain(page, "activity"); await ready(page, "#activityInsights");
    const activity = page.locator("#activityInsights");
    await assertFacts(activity, formatter.summarize(f.overview(f.model.overview.interactionRefs).metrics));
    await page.locator("#activitySearch").fill("Synthetic hierarchy request 0");
    await page.waitForFunction(() => document.querySelector("#activityInsights")?.textContent.includes("1 of 1 request assessed")
        && document.querySelector("#activityInsights")?.getAttribute("aria-busy") !== "true");
    const ref = f.model.catalog.find(row => row.scenarioId === "hierarchy-0").interactionRef;
    await assertFacts(activity, formatter.summarize(f.overview([ref]).metrics));
    const selected = await geometry(activity);
    evidence.push({ name: "activity-filtered", ...selected }); issues.push(...hierarchyIssues(selected));
    await capture(page, activity, "activity-filtered");
    assert.ok(f.calls.some(call => call.path.endsWith("/overview") && call.input.interactionRefs.length === 1));
    await page.goto(f.origin + "#activity?session=hierarchy-chat-0"); await ready(page, "#activityInsights");
    await assertFacts(activity, formatter.summarize(f.overview([ref]).metrics));
    assert.match(await activity.locator(".assessment-scope").innerText(), /full retained interaction/);
    await capture(page, activity, "chat-scoped");
    await page.goto(f.origin + "#request?request=hierarchy-0"); await ready(page, ".interaction-insights");
    const detail = page.locator(".interaction-insights");
    await assertFacts(detail, formatter.summarize(withQuality(f.model.details.get(ref).metrics, "personal"), { singleInteraction: true }));
    assert.deepEqual(await detail.locator('.assessment-check .assessment-value').allTextContents(), ["Correct", "Supported", "Not authorized"]);
    for (const theme of ["light", "dark"]) for (const width of [1440, 375, 320]) for (const zoom of [100, 200]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(zoom => { document.documentElement.style.fontSize = zoom + "%"; }, zoom);
        const layout = await geometry(detail), name = `detail-personal-${theme}-${width}-${zoom}`;
        evidence.push({ name, ...layout }); issues.push(...hierarchyIssues(layout).map(issue => `${name}: ${issue}`));
        await capture(page, detail, name);
    }
    await page.goBack(); await ready(page, "#activityInsights");
    await assertFacts(activity, formatter.summarize(f.overview([ref]).metrics));
    f.setMode("unassessed"); f.setAutomaticState("assessing");
    await page.goto("about:blank");
    await page.goto(f.origin + "#home"); await ready(page, "#homeInsights");
    await page.waitForFunction(() => document.querySelector("#homeInsights .assessment-scoring-status")?.textContent.includes("Assessing"));
    assert.match(await page.locator("#homeInsights").innerText(), /Automatic scores: Assessing.*values below cover only this view's included interactions/);
    assert.deepEqual(await page.locator('#homeInsights [data-dimension="accuracy"] .assessment-value').allTextContents(), ["Quality not assessed"]);
    evidence.push({ name: "pending", text: await page.locator("#homeInsights").innerText() });
    if (proofs) await writeFile(path.join(proofs, "geometry.json"), JSON.stringify({ evidence, issues, calls: f.calls }, null, 2));
    assert.deepEqual(issues, []);
});

test("one of 69 checked requests reads before passed counts without hiding exact evidence", { timeout: 60000 }, async t => {
    const f = await setup(t, { supplied: true }), { page } = f;
    f.setMode("one-of-69");
    await page.goto(f.origin + "#home"); await ready(page, "#homeInsights");
    const host = page.locator("#homeInsights"), layouts = [];
    for (const [theme, width, zoom] of [["light", 1440, 100], ["dark", 1440, 100], ["dark", 375, 200]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(zoom => { document.documentElement.style.fontSize = zoom + "%"; }, zoom);
        const name = `one-of-69-${theme}-${width}-${zoom}`;
        await capture(page, host, name);
        layouts.push({ name, ...await geometry(host) });
    }
    if (proofs) await writeFile(path.join(proofs, "one-of-69.json"), JSON.stringify(layouts, null, 2));
    assert.deepEqual(layouts.flatMap(hierarchyIssues), []);
    assert.match(await host.locator(".assessment-takeaway").innerText(), /Missing assessments are not failed answers/);
    assert.deepEqual(await host.locator(".assessment-check .assessment-coverage").allTextContents(), Array(3).fill("1 of 69 requests assessed"));
    assert.deepEqual(await host.locator(".assessment-check .assessment-value").allTextContents(), Array(3).fill("1 passed 0 failed"));
    assert.deepEqual(await host.locator('[data-dimension="speed"] .assessment-value').allTextContents(), ["2.96 s", "16.82 s"]);
    assert.deepEqual(await host.locator('[data-dimension="speed"] .assessment-coverage').allTextContents(), ["225 of 226 calls timed", "8 of 69 requests timed"]);
    assert.doesNotMatch(await host.locator(".assessment-grid").innerText(), /100%|independent ground truth|proof of authorization/);
    await host.getByText("How to read these results", { exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.match(await host.locator(".assessment-reading-help").innerText(), /None means the answer failed or a review is queued/);
    assert.match(await host.locator(".assessment-reading-help").innerText(), /One request can have several tool calls/);
    assert.match(await host.locator(".assessment-reading-help").innerText(), /does not prove a person gave permission/);
    const readingHelp = host.getByText("How to read these results", { exact: true });
    assert.ok((await readingHelp.boundingBox()).height >= 44);
    await readingHelp.tap();
    assert.equal(await host.locator(".assessment-reading-help").evaluate(node => node.open), false);
    await host.getByRole("button", { name: "Measure definitions", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Insight details", exact: true });
    await dialog.getByText("Recorded measures and definitions", { exact: true }).click();
    const detail = await dialog.innerText();
    for (const exact of ["100%", "1 / 1 passed; 1 / 69 assessed", "2,955 ms", "16,820 ms",
        "Model synthetic-only; rubric wire-recorded-interaction-review v1"]) assert.ok(detail.includes(exact), exact);
    assert.match(detail, /actions match the recorded request.*does not prove a person gave permission/);
    await page.keyboard.press("Escape");
    assert.equal(await host.getByRole("button", { name: "Measure definitions", exact: true }).evaluate(node => node === document.activeElement), true);
});

test("Insights help and definitions remain accessible without initiating actions", { timeout: 60000 }, async t => {
    const { page, origin } = await setup(t);
    await page.goto(origin + "#home"); await ready(page, "#homeInsights");
    const host = page.locator("#homeInsights"), tooltip = page.locator("#evidence-tooltip");
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) for (const zoom of [100, 200]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(zoom => { document.documentElement.style.fontSize = zoom + "%"; }, zoom);
        for (const dimension of ["Accuracy", "Speed", "Trust"]) {
        const help = host.getByRole("button", { name: `About ${dimension}`, exact: true }).first();
        await help.scrollIntoViewIfNeeded(); await help.focus();
        const target = await help.evaluate(node => {
            const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
            const label = node.previousElementSibling, range = document.createRange(); range.selectNodeContents(label);
            const last = [...range.getClientRects()].at(-1), icon = node.querySelector("svg").getBoundingClientRect();
            return { width: rect.width, height: rect.height, outline: css.outlineWidth,
                gap: icon.left - last.right, wrapped: icon.top >= last.bottom && icon.left <= label.getBoundingClientRect().left + 5 };
        });
        assert.ok(target.width >= 44 && target.height >= 44); assert.notEqual(target.outline, "0px");
        assert.ok(Math.abs(target.gap - 4) < 1 || target.wrapped, `${dimension}/${theme}/${width}/${zoom}: help gap ${target.gap}`);
        await page.keyboard.press("Enter"); await tooltip.waitFor({ state: "visible" });
        assert.match(await tooltip.innerText(), dimension === "Accuracy" ? /tool can work.*wrong answer/ : dimension === "Trust" ? /does not prove a person gave permission/ : /separate times.*seconds/);
        const anchor = await help.evaluate(node => {
            const icon = node.querySelector("svg").getBoundingClientRect(), popup = document.querySelector("#evidence-tooltip").getBoundingClientRect();
            return Math.min(Math.abs(popup.top - icon.bottom), Math.abs(icon.top - popup.bottom));
        });
        assert.ok(Math.abs(anchor - 8) < 1);
        await page.keyboard.press("Escape"); assert.equal(await tooltip.isVisible(), false);
        await help.hover();
        assert.equal(await help.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
        await page.mouse.move(0, 0); await page.keyboard.press("Escape");
        await help.tap(); await tooltip.waitFor({ state: "visible" });
        await host.locator("h2").click(); assert.equal(await tooltip.isVisible(), false);
        }
    }
    const trigger = host.getByRole("button", { name: "Measure definitions", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Insight details", exact: true });
    await dialog.getByText("Recorded measures and definitions", { exact: true }).click();
    assert.match(await dialog.innerText(), /Call start to recorded completion/);
    assert.match(await dialog.innerText(), /Recorded request to final response; not tool-call time/);
    assert.match(await dialog.innerText(), /actions match the request, not whether a person gave permission/);
    await page.keyboard.press("Escape");
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    assert.equal(await host.getByRole("button", { name: "Automatic scores", exact: true }).isVisible(), true);
});
