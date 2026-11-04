import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { mountChartReference, chartReferenceMarkup, chartReferenceFacts } from "../web/chart-reference.mjs";
import { createChartReferenceState } from "../web/chart-reference-state.mjs";
import { chartReferenceStyles } from "../web/chart-reference-styles.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createControlHelp } from "../lib/control-help.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { createSelectControls } from "../web/select-control.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { extractGraphActivities } from "../lib/graph-history.mjs";
import { styles } from "../web/styles.mjs";
import { fixture } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_CHART_REFERENCE_PROOFS;

test("guide access requires both publication hooks without a legacy allow fallback", () => {
    assert.throws(() => mountChartReference({}), /requires publicationToken and isCurrent/);
    assert.throws(() => mountChartReference({ publicationToken: () => ({}) }), /requires publicationToken and isCurrent/);
    assert.throws(() => mountChartReference({ isCurrent: () => true }), /requires publicationToken and isCurrent/);
});

async function setup(t, { layer = "tool", source } = {}) {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
    t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(requests, []); });
    const record = fixture("chart-guide");
    const base = record.toolCalls[0];
    record.toolCalls = Array.from({ length: 6 }, (_, index) => ({
        ...base, toolCallId: `guide-call-${index}`, startEventId: `guide-start-${index}`,
        toolSucceeded: index < 4 ? true : index === 4 ? false : undefined,
        reportedOutcome: index < 4 ? "succeeded" : index === 4 ? "failed" : "unknown",
    }));
    record.toolCalls[0].requestArgs = { entityUrls: ["/me/messages", "/teams/sample-team/channels/sample-channel/messages"] };
    record.toolCalls[0].requestedApiPath = undefined;
    record.toolCalls[1].requestArgs = { entityUrls: ["/me/drive/root/children"] };
    record.toolCalls[1].requestedApiPath = "/me/drive/root/children";
    const records = source ?? [record];
    const analytics = buildActivityAnalytics(records, { layer });
    await page.setContent(`<style>${styles}${chartReferenceStyles}</style>
        <button id="openChartReference" type="button">How to read these charts</button>
        <div id="fixtureCharts" hidden></div><div id="fixtureExact" hidden></div><section id="analyzeReference" hidden>${chartReferenceMarkup}</section>`);
    await page.evaluate(({ factories, icons, analytics, records, layer }) => {
        const make = source => (0, eval)(`(${source})`);
        const results = make(factories.results)(), categories = make(factories.categories)(), dimensional = make(factories.dimensional)();
        const ux = make(factories.ux)(icons);
        const percentages = make(factories.percentage)({ results, categories, dimensional, ux,
            createLink(kind, row) {
                const link = document.createElement("a"); link.href = `#accepted-${kind}-${encodeURIComponent(row.id)}`;
                return link;
            },
        }).mount(document.getElementById("fixtureCharts"), { dataHost: document.getElementById("fixtureExact"), includeModels: true });
        percentages.update(analytics, { layer, filters: {} }, records);
        window.context = { key: "accepted-one", revision: 1, layer, available: true, canOpenData: true,
            mode: "analyze", ...make(factories.facts)(analytics, percentages.referenceModel()), qualification: "", notice: "" };
        window.compareOpens = 0;
        window.guideAccess = { allowed: true, token: Object.freeze({}) };
        window.guideAccess.verify = token => window.guideAccess.allowed && token === window.guideAccess.token;
        window.contextReads = 0;
        window.referenceNotices = [];
        window.referenceSelects = make(factories.select)(ux);
        window.guideResizeCallbacks = [];
        const NativeResizeObserver = window.ResizeObserver;
        window.ResizeObserver = class {
            constructor(callback) {
                this.entry = { callback, targets: [] };
                window.guideResizeCallbacks.push(this.entry);
                this.observer = new NativeResizeObserver(callback);
            }
            observe(node) { this.entry.targets.push(node.id); this.observer.observe(node); }
            disconnect() { this.observer.disconnect(); }
        };
        window.guide = make(factories.mount)({
            host: document.getElementById("analyzeReference"), root: document.getElementById("meaning"), trigger: document.getElementById("openChartReference"),
            createState: make(factories.state), ux, results, categories, dimensional, help: make(factories.help)(categories),
            motionTiming: { duration: 320, easing: "cubic-bezier(.2,0,0,1)", fill: "both" },
            publicationToken: () => window.guideAccess.allowed ? window.guideAccess.token : null,
            isCurrent: token => window.guideAccess.verify(token),
            readContext: () => { window.contextReads++; window.onGuideRead?.(); return window.context; },
            renderExact: (topic, host, identity, presentation) => {
                window.guideRenderScope = presentation;
                if (window.changeBeforeExact) window.context = { ...window.context, key: "changed-before-exact", revision: 2 };
                if (identity.key !== window.context.key || identity.revision !== window.context.revision) {
                    return { status: "unavailable", reason: "The chart view changed. Open its current exact data." };
                }
                percentages.renderExact(topic, host);
                window.onGuideExact?.(host);
                return { status: "ready" };
            },
            openComparisonRecords: () => { window.compareOpens++; window.guide.leave(); },
            onUnavailable: message => window.referenceNotices.push(message),
        });

        document.getElementById("openChartReference").addEventListener("click", () => window.guide.open());
    }, {
        factories: { mount: mountChartReference.toString(), state: createChartReferenceState.toString(), facts: chartReferenceFacts.toString(),
            percentage: createPercentageCharts.toString(), dimensional: createDimensionalCharts.toString(),
            categories: createServiceCategories.toString(), help: createControlHelp.toString(),
            results: createRecordedResults.toString(), ux: createEvidenceUX.toString(), select: createSelectControls.toString() },
        icons: uxIcons, analytics, records, layer,
    });
    if (proofDir) await mkdir(proofDir, { recursive: true });
    return page;
}

test("guide access withdrawal clears retained private content synchronously without navigation or focus", async t => {
    const page = await setup(t);
    await page.evaluate(() => {
        window.context = { ...window.context, qualification: "PRIVATE_GUIDE_QUALIFICATION", coverage: "PRIVATE_GUIDE_COVERAGE" };
    });
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    assert.ok(await page.locator("#chartReferenceData tbody tr").count());
    const cleared = await page.evaluate(() => {
        window.retiredGuideCapture = window.guide.capture();
        const heldText = [];
        for (const id of ["chartReferenceExplanation", "chartReferenceQualification", "chartReferenceData"]) {
            const walker = document.createTreeWalker(document.getElementById(id), NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) heldText.push(walker.currentNode);
        }
        const heldAttributes = [document.getElementById("meaning").getAttributeNode("data-revision"),
            document.querySelector("#chartReferenceData a").getAttributeNode("href")];
        const beforeText = heldText.map(node => node.data), beforeAttributes = heldAttributes.map(attribute => attribute.value);
        const ids = ["periodLabel", "meaningMatched", "meaningSources", "takeaway", "meaningBody", "chartReadingNotes", "serviceDefinitions", "countTable", "percentageData"];
        for (const id of ids) document.getElementById(id).append(document.createTextNode("PRIVATE_GUIDE_SOURCE"));
        document.getElementById("chartReferenceFindInput").value = "PRIVATE_GUIDE_FIND";
        const retainedTable = document.getElementById("countTable");
        const before = { href: location.href, history: history.length };
        const focused = [];
        document.addEventListener("focusin", event => focused.push(event.target.id), { once: true });
        const removedWithData = [], replace = Element.prototype.replaceChildren, remove = Element.prototype.removeAttributeNode;
        Element.prototype.replaceChildren = function (...children) {
            if (heldText.some(node => this.contains(node) && node.data !== "")) removedWithData.push("text");
            return replace.apply(this, children);
        };
        Element.prototype.removeAttributeNode = function (attribute) {
            if (heldAttributes.includes(attribute) && attribute.value !== "") removedWithData.push("attribute");
            return remove.call(this, attribute);
        };
        try {
            window.guideAccess.allowed = false;
            window.guide.withdrawAccess();
            window.guide.withdrawAccess();
        } finally {
            Element.prototype.replaceChildren = replace;
            Element.prototype.removeAttributeNode = remove;
        }
        return { before, after: { href: location.href, history: history.length }, focused, beforeText, beforeAttributes,
            removedWithData,
            heldText: heldText.map(node => node.data), heldAttributes: heldAttributes.map(attribute => attribute.value),
            text: document.getElementById("meaning").textContent,
            value: document.getElementById("chartReferenceFindInput").value,
            table: retainedTable.textContent, rows: document.querySelectorAll("#chartReferenceData tr").length,
            open: document.getElementById("meaning").open, hostHidden: document.getElementById("analyzeReference").hidden,
            capture: window.guide.capture(), state: window.guide.value() };
    });
    assert.deepEqual(cleared.after, cleared.before);
    assert.deepEqual(cleared.focused, []);
    assert.ok(cleared.beforeText.some(text => text.includes("PRIVATE_GUIDE_QUALIFICATION")), "Hold actual generated qualification Text nodes");
    assert.equal(cleared.beforeAttributes[0], "1");
    assert.match(cleared.beforeAttributes[1], /^#accepted-/, "Hold the actual generated exact-link Attr");
    assert.deepEqual(cleared.heldText, cleared.beforeText.map(() => ""));
    assert.deepEqual(cleared.heldAttributes, ["", ""]);
    assert.deepEqual(cleared.removedWithData, [], "Private values are blank before their nodes or attributes are detached");
    assert.doesNotMatch(cleared.text, /PRIVATE_GUIDE_|66\.7%/);
    assert.match(cleared.text, /Worked means tool completion, not answer correctness\./);
    assert.equal(cleared.value, "");
    assert.equal(cleared.table, "");
    assert.equal(cleared.rows, 0);
    assert.equal(cleared.open, false);
    assert.equal(cleared.hostHidden, true);
    assert.equal(cleared.capture, null);
    assert.equal(cleared.state.view, "closed");
});

test("guide access rejects closed publication and old captures across a fresh epoch", async t => {
    const page = await setup(t);
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    const result = await page.evaluate(() => {
        const saved = window.guide.capture(), reads = window.contextReads;
        window.guideAccess.allowed = false;
        window.guide.withdrawAccess();
        window.guide.open();
        const deniedRestore = window.guide.restore(saved);
        const denied = { open: document.getElementById("meaning").open, reads: window.contextReads };
        window.guideAccess.token = Object.freeze({});
        window.guideAccess.allowed = true;
        window.guide.refresh();
        const oldRestore = window.guide.restore(saved);
        const beforeFreshOpen = { open: document.getElementById("meaning").open, reads: window.contextReads };
        window.guide.open();
        const fresh = window.guide.capture();
        const lateRestore = window.guide.restore(saved);
        return { reads, deniedRestore, denied, oldRestore, beforeFreshOpen, lateRestore,
            freshToken: fresh.publicationToken === window.guideAccess.token,
            stillOpen: document.getElementById("meaning").open, current: window.guide.capture().key };
    });
    assert.equal(result.deniedRestore, false);
    assert.deepEqual(result.denied, { open: false, reads: result.reads });
    assert.equal(result.oldRestore, false);
    assert.deepEqual(result.beforeFreshOpen, { open: false, reads: result.reads });
    assert.equal(result.freshToken, true);
    assert.equal(result.lateRestore, false);
    assert.equal(result.stillOpen, true);
    assert.equal(result.current, "accepted-one");
});

test("guide access requires synchronous tokens and exact-true verifier results", async t => {
    const page = await setup(t);
    const results = await page.evaluate(() => {
        const results = [];
        for (const malformed of ["promise-false", "promise-true", "string", "object", "number"]) {
            window.guideAccess.token = Object.freeze({});
            window.guideAccess.verify = token => window.guideAccess.allowed && token === window.guideAccess.token;
            window.guide.open();
            const saved = window.guide.capture(), reads = window.contextReads;
            window.guideAccess.verify = () => ({
                "promise-false": Promise.resolve(false), "promise-true": Promise.resolve(true),
                string: "true", object: { allowed: true }, number: 1,
            })[malformed];
            const capture = window.guide.capture();
            const restore = window.guide.restore(saved);
            window.guide.open();
            const notified = window.guide.notify("PRIVATE_MALFORMED_VERIFIER");
            results.push({ malformed, capture, restore, notified, reads: window.contextReads - reads,
                open: document.getElementById("meaning").open });
        }
        const asynchronousTokens = [];
        for (const token of [Promise.resolve({}), { then() {} }]) {
            window.guide.withdrawAccess();
            window.guideAccess.token = token;
            let verified = 0;
            window.guideAccess.verify = value => { verified++; return value === token; };
            const reads = window.contextReads;
            window.guide.open();
            asynchronousTokens.push({ reads: window.contextReads - reads, verified,
                open: document.getElementById("meaning").open });
        }
        window.guide.withdrawAccess();
        window.guideAccess.token = Object.freeze({});
        window.guideAccess.verify = token => token === window.guideAccess.token;
        window.guide.open();
        return { results, asynchronousTokens, reopened: document.getElementById("meaning").open };
    });
    for (const result of results.results) assert.deepEqual(result, {
        malformed: result.malformed, capture: null, restore: false, notified: false, reads: 0, open: false,
    });
    assert.deepEqual(results.asynchronousTokens, [
        { reads: 0, verified: 0, open: false }, { reads: 0, verified: 0, open: false },
    ]);
    assert.equal(results.reopened, true);
});

test("guide access fences retained exact callbacks on expiry and after a new publication", async t => {
    const page = await setup(t);
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    const expired = await page.evaluate(() => {
        window.retiredExactScope = window.guideRenderScope;
        window.guideAccess.allowed = false;
        return { admitted: window.retiredExactScope.isCurrent(), rows: document.querySelectorAll("#chartReferenceData tr").length,
            open: document.getElementById("meaning").open };
    });
    assert.deepEqual(expired, { admitted: false, rows: 0, open: false });
    await page.evaluate(() => { window.guideAccess.token = Object.freeze({}); window.guideAccess.allowed = true; window.guide.open(); });
    await page.locator("#chartReferenceShowData").click();
    const fresh = await page.evaluate(() => ({
        old: window.retiredExactScope.isCurrent(), current: window.guideRenderScope.isCurrent(),
        rows: document.querySelectorAll("#chartReferenceData tbody tr").length, open: document.getElementById("meaning").open,
    }));
    assert.deepEqual(fresh, { old: false, current: true, rows: 6, open: true });
});

test("guide access blocks late notices and retired resize focus callbacks", async t => {
    const page = await setup(t);
    await page.locator("#openChartReference").click();
    const result = await page.evaluate(() => {
        const retired = window.guideResizeCallbacks.find(entry => entry.targets.includes("meaning"));
        window.guideAccess.allowed = false;
        const notification = window.guide.notify("PRIVATE_LATE_NOTICE");
        window.guide.withdrawAccess();
        window.guideAccess.token = Object.freeze({});
        window.guideAccess.allowed = true;
        window.guide.open();
        const focused = document.activeElement.id, scroll = Element.prototype.scrollIntoView;
        let scrolls = 0;
        Element.prototype.scrollIntoView = function (...args) { scrolls++; return scroll.apply(this, args); };
        try { retired.callback([]); }
        finally { Element.prototype.scrollIntoView = scroll; }
        return { notification, scrolls, focused, afterFocus: document.activeElement.id,
            text: document.getElementById("meaning").textContent, open: document.getElementById("meaning").open };
    });
    assert.equal(result.notification, false);
    assert.equal(result.scrolls, 0);
    assert.equal(result.afterFocus, result.focused);
    assert.equal(result.open, true);
    assert.doesNotMatch(result.text, /PRIVATE_LATE_NOTICE/);
});

test("guide access rejects reentrant context and exact-render publication after withdrawal", async t => {
    const page = await setup(t);
    await page.evaluate(() => {
        window.onGuideRead = () => {
            window.guideAccess.allowed = false; window.guide.withdrawAccess();
            throw new Error("PRIVATE_RETIRED_CONTEXT_ERROR");
        };
        window.guide.open();
    });
    assert.equal(await page.locator("#meaning").evaluate(node => node.open), false);
    assert.equal(await page.locator(".chart-reference-value").count(), 0);
    await page.evaluate(() => {
        window.onGuideRead = null;
        window.guideAccess.token = Object.freeze({});
        window.guideAccess.allowed = true;
        window.guide.open();
        window.onGuideExact = host => {
            window.guideAccess.allowed = false;
            window.guide.withdrawAccess();
            host.append("PRIVATE_LATE_RENDER");
            throw new Error("PRIVATE_LATE_ERROR");
        };
    });
    await page.locator("#chartReferenceShowData").click();
    assert.equal(await page.locator("#meaning").evaluate(node => node.open), false);
    assert.doesNotMatch(await page.locator("#meaning").textContent(), /PRIVATE_LATE|66\.7%/);
    assert.equal(await page.locator("#chartReferenceData tr").count(), 0);
});

test("chart guide uses accepted chart facts, native exact links and a text-only entry", async t => {
    const page = await setup(t);
    await page.locator("#openChartReference").click();
    assert.equal(await page.locator("#openChartReference svg").count(), 0);
    assert.match(await page.locator("#chartReferenceExplanation").innerText(), /4 \(66.7%\)/);
    assert.doesNotMatch(await page.locator("#meaning").innerText(), /All retained dates|All services|All authors|Current collection/);
    assert.equal(await page.locator("#chartReferenceTopics .chart-reference-topic-group").count(), 0);
    assert.equal(await page.locator("#chartReferenceTopics button").count(), 7);
    assert.equal(await page.locator("#chartReferenceTopics").isVisible(), false);
    await page.locator("#chartReferenceShowData").click();
    assert.equal(await page.locator("#chartReferenceData tbody tr").count(), 6);
    assert.equal(await page.locator("#chartReferenceData tfoot td").first().innerText(), "6");
    assert.equal(await page.locator("#chartReferenceData a").first().getAttribute("href"), "#accepted-outcomes-success");
    await page.locator("#chartReferenceBack").click();
    assert.equal(await page.locator("#chartReferenceShowData").evaluate(node => document.activeElement === node), true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("meaning").open);
    assert.equal(await page.locator("#meaning").evaluate(node => node.open), false);
    assert.equal(await page.locator("#analyzeReference").isVisible(), false);
    assert.equal(await page.locator("#openChartReference").evaluate(node => document.activeElement === node), true);
});

test("guide qualification fallback is whole accepted text, never a substitute for empty or unavailable parts", async t => {
    const page = await setup(t);
    const text = "Standalone scope; original \u00b7 identity: punctuation", coverage = "Coverage stays separately qualified.";
    await page.evaluate(({ text, coverage }) => { window.context = { ...window.context, qualification: text, coverage }; }, { text, coverage });
    await page.locator("#openChartReference").click();
    assert.deepEqual(await page.locator("#chartReferenceGuide .chart-reference-qualification").allTextContents(), [text, coverage]);
    assert.equal(await page.locator("#chartReferenceGuide .analyze-scope-part").count(), 0);
    await page.locator("#chartReferenceShowData").click();
    assert.equal(await page.locator("#chartReferenceQualification").textContent(), text + " " + coverage);
    await page.locator("#chartReferenceBack").click();
    await page.evaluate(() => { window.context = { ...window.context, qualificationParts: [] }; window.guide.refresh(); });
    assert.deepEqual(await page.locator("#chartReferenceGuide .chart-reference-qualification").allTextContents(), [coverage]);
    assert.equal(await page.locator("#chartReferenceQualification").textContent(), coverage);
    await page.evaluate(() => {
        window.context = { ...window.context, qualificationParts: undefined, available: false, canOpenData: false,
            unavailableReason: "No accepted scope." };
        window.guide.refresh();
    });
    assert.deepEqual(await page.locator("#chartReferenceGuide .chart-reference-qualification").allTextContents(), [coverage]);
    assert.equal(await page.locator("#chartReferenceQualification").textContent(), coverage);
    assert.equal(await page.locator("#chartReferenceShowData").isDisabled(), true);
});

test("stale and unavailable views never invent zero or silently activate exact data", async t => {
    const page = await setup(t);
    await page.locator("#openChartReference").click();
    await page.evaluate(() => {
        window.context = { ...window.context, key: "pending-two", canOpenData: false,
            notice: "Changing filters. Earlier accepted numbers are still shown.",
            unavailableReason: "Wait for the current view before opening matching records." };
        window.guide.refresh();
    });

    assert.match(await page.locator("#chartReferenceExplanation").innerText(), /4 \(66.7%\)/);
    assert.equal(await page.locator("#chartReferenceShowData").isDisabled(), true);
    await page.evaluate(() => {
        window.context = { ...window.context, key: "unavailable", available: false, model: null, facts: null,
            notice: "Chart numbers are unavailable.", unavailableReason: "Read the current view before opening exact data." };
        window.guide.refresh();
    });
    assert.equal(await page.locator("#meaning .chart-reference-definition>.chart-reference-value").count(), 0);
    assert.match(await page.locator("#chartReferenceNotice").innerText(), /unavailable/);
});

test("source-defined units keep counts without pooled outcome or service shares", async t => {
    const page = await setup(t);
    await page.evaluate(() => {
        window.context = { ...window.context, model: { ...window.context.model, separateUnits: true } };
    });
    await page.locator("#openChartReference").click();
    assert.equal(await page.locator("#chartReferenceTopicTitle").innerText(), "Results by source");
    assert.equal(await page.locator("#chartReferenceExplanation .chart-reference-share").count(), 0);
    assert.match(await page.locator("#chartReferenceExplanation").innerText(), /These results use different source units/);
    assert.equal((await page.locator(".chart-reference-definition>.chart-reference-value").first().innerText()).trim(), "4");
    await page.locator("#chartReferenceAllTopics").click();
    await page.locator('button[data-reference-topic="services"]').click();
    assert.equal(await page.locator("#chartReferenceExplanation .chart-reference-share").count(), 0);
    assert.equal(await page.locator(".chart-reference-service-track:visible").count(), 0);
    assert.match(await page.locator("#chartReferenceExplanation").innerText(), /counts can overlap/);
    assert.doesNotMatch(await page.locator("#chartReferenceExplanation").innerText(), /Shares use all|%/);
});

test("exact rendering rejects an accepted-context change instead of mixing generations", async t => {
    const page = await setup(t);
    await page.locator("#openChartReference").click();
    await page.evaluate(() => { window.changeBeforeExact = true; });
    await page.locator("#chartReferenceShowData").click();
    assert.equal(await page.locator("#chartReferenceData table").count(), 0);
    assert.match(await page.locator("#chartReferenceData").innerText(), /chart view changed/);
    assert.equal(await page.locator("#chartReferenceSource").isVisible(), false);
});

test("guide facts cannot borrow a different layer's labels or denominator", async t => {
    const page = await setup(t);
    await assert.rejects(page.evaluate(() => {
        window.context = { ...window.context, layer: "code-reference" };
        window.guide.open();
    }), /accepted layer and denominator/);
    assert.equal(await page.locator("#meaning").evaluate(node => node.open), false);
});

for (const layer of ["tool", "reported-api", "direct-request", "recorded-http", "http", "code-reference"]) {
    test(`guide and exact table preserve ${layer} units and evidence limits`, async t => {
        const record = fixture("guide-layer");
        record.toolCalls[0].apiResults = [{ index: 0, statusCode: 200 }, { index: 1, statusCode: 403 }, { index: 2 }];
        const events = [
            { id: "prompt", type: "user.message", timestamp: "2026-09-30T12:00:00Z", data: { content: "Synthetic chart guide example" } },
            { id: "start", type: "tool.execution_start", timestamp: "2026-09-30T12:00:01Z", data: {
                toolName: "powershell", toolCallId: "guide-graph", arguments: { command: "curl https://graph.microsoft.com/v1.0/me/messages" },
            } },
        ];
        const references = structuredClone(events);
        references[1].data.arguments.command = "git diff # https://graph.microsoft.com/v1.0/me/messages";
        const source = [record, ...extractGraphActivities(events, { sessionId: "guide-graph" }).scenarios,
            ...extractGraphActivities(references, { sessionId: "guide-code" }).scenarios];
        const expected = buildActivityAnalytics(source, { layer });
        const page = await setup(t, { layer, source });
        const title = createRecordedResults().outcomeTitle(layer);
        await page.locator("#openChartReference").click();
        assert.equal(await page.locator("#chartReferenceTopicTitle").innerText(), title);
        await page.locator("#chartReferenceAllTopics").click();
        assert.equal(await page.locator('button[data-reference-topic="outcomes"]').innerText(), title);
        await page.locator('button[data-reference-topic="outcomes"]').click();
        assert.match(await page.locator(".chart-reference-group-heading").innerText(),
            new RegExp(`${expected.totals.count} ${createRecordedResults().unit(layer, expected.totals.count)}`));
        if (layer === "code-reference") {
            assert.match(await page.locator("#chartReferenceExplanation").innerText(), /Execution not observed/);
            assert.doesNotMatch(await page.locator("#chartReferenceExplanation").innerText(), /HTTP 2xx|Worked/);
        }
        await page.locator("#chartReferenceShowData").click();
        assert.equal(await page.locator("#chartReferenceDataTitle").innerText(), title);
        assert.equal(await page.locator("#chartReferenceData tfoot td").first().innerText(), String(expected.totals.count));
        if (layer === "code-reference") {
            assert.equal(await page.locator("#chartReferenceData tbody tr").count(), 1);
            assert.doesNotMatch(await page.locator("#chartReferenceData table").innerText(), /HTTP 2xx|HTTP 4xx/);
        }
    });
}

test("comparison help delegates to the existing roster without rendering a second period list", async t => {
    const page = await setup(t);
    await page.evaluate(() => {
        window.context = { ...window.context, mode: "comparison", key: "accepted-comparison" };
    });
    await page.locator("#openChartReference").click();
    assert.equal(await page.locator("#meaning .chart-reference-definition>.chart-reference-value").count(), 0);
    assert.equal(await page.locator("#meaning [role=tab],#meaning [data-period-side]").count(), 0);
    assert.deepEqual((await page.locator(".chart-reference-topic").allTextContents()).map(text => text.trim()),
        ["Results by period", "Call timing", "Reading the comparison"]);
    await page.getByRole("button", { name: "View period records", exact: true }).click();
    assert.equal(await page.evaluate(() => window.compareOpens), 1);
});

test("the caller can restore exact-data reading only for the same accepted context", async t => {
    const page = await setup(t);
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    await page.locator("#chartReferenceBack").focus();
    await page.evaluate(() => { window.savedReference = window.guide.capture(); window.guide.leave(); });
    assert.equal(await page.locator("#meaning").evaluate(node => node.open), false);
    assert.equal(await page.evaluate(() => window.guide.restore(window.savedReference)), true);
    assert.equal(await page.locator("#meaning").getAttribute("data-reference-view"), "data");
    assert.equal(await page.locator("#chartReferenceBack").evaluate(node => document.activeElement === node), true);
    await page.evaluate(() => {
        window.guide.leave();
        window.context = { ...window.context, key: "new-accepted-revision", revision: 2 };
    });
    assert.equal(await page.evaluate(() => window.guide.restore(window.savedReference)), false);
    assert.match((await page.evaluate(() => window.referenceNotices)).at(-1), /no longer current/);
    assert.equal(await page.locator("#meaning").evaluate(node => node.open), false);
});

test("missing time coverage is unavailable rather than an invented zero", async t => {
    const page = await setup(t);
    await page.evaluate(() => {
        window.context = { ...window.context, facts: { ...window.context.facts, undatedCount: undefined } };
        window.guide.open("time");
    });
    const text = await page.locator("#chartReferenceExplanation").innerText();
    assert.match(text, /Dated and undated counts are unavailable/);
    assert.doesNotMatch(text, /0 without a usable date/);
});

test("a queued native close event cannot close a newly restored guide", async t => {
    const page = await setup(t);
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    await page.locator("#chartReferenceBack").focus();
    await page.evaluate(async () => {
        const saved = window.guide.capture();
        window.guide.leave();
        window.guide.restore(saved);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(await page.locator("#meaning").evaluate(node => node.open), true);
    assert.equal(await page.locator("#chartReferenceBack").evaluate(node => document.activeElement === node), true);
});

test("guide details reflow in both themes and at 200% text without hidden focus", async t => {
    const page = await setup(t);
    for (const theme of ["light", "dark"]) for (const width of [1440, 768, 390]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ theme, scale }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = `${scale * 100}%`;
            window.guide.open("services");
        }, { theme, scale });
        await page.locator("#meaning").evaluate(async node => {
            await Promise.allSettled(node.getAnimations({ subtree: true }).map(animation => animation.finished));
        });
        const geometry = await page.locator("#meaning").evaluate(root => {
            const box = root.getBoundingClientRect();
            const controls = [...root.querySelectorAll("button,select,summary")].filter(node => node.checkVisibility());
            return { overflow: document.documentElement.scrollWidth - innerWidth, dialogOverflow: root.scrollWidth - root.clientWidth,
                controls: controls.map(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height }; }),
                left: box.left, right: box.right };
        });

        assert.ok(geometry.overflow <= 1 && geometry.dialogOverflow <= 1, `${theme}/${width}/${scale}: no horizontal overflow`);
        assert.ok(geometry.controls.every(r => r.height >= 44 && r.left >= geometry.left && r.right <= geometry.right), "Full targets remain inside the dialog");
        await page.locator("#chartReferenceShowData").focus();
        const focus = await page.locator("#chartReferenceShowData").evaluate(node => {
            const r = node.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            const viewport = node.closest("dialog").getBoundingClientRect();
            return { visible: node.contains(hit), fullyVisible: r.top >= viewport.top + 6 && r.bottom <= viewport.bottom - 6,
                top: r.top, bottom: r.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom, hit: hit?.id || hit?.tagName };
        });
        assert.equal(focus.visible, true, `${theme}/${width}/${scale}: ${JSON.stringify(focus)}`);
        assert.equal(focus.fullyVisible, true, `${theme}/${width}/${scale}: full focus target ${JSON.stringify(focus)}`);
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `services-${theme}-${width}-${scale * 100}.png`), fullPage: true });
    }
});

test("the flat index and exact data preserve topmost Escape without mutating chart context", async t => {
    const page = await setup(t);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceAllTopics").click();
    await page.locator('[data-reference-topic="services"]').click();
    assert.equal(await page.locator("#chartReferenceTopicTitle").innerText(), "Services and operations");
    assert.equal(await page.evaluate(() => window.context.key), "accepted-one");
    await page.locator("#chartReferenceShowData").click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#meaning").evaluate(node => node.open), true);
    assert.equal(await page.locator("#chartReferenceShowData").evaluate(node => document.activeElement === node), true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("meaning").open);
    assert.equal(await page.locator("#meaning").evaluate(node => node.open), false);
});

test("responsive navigation keeps focus on a visible guide control", async t => {
    const page = await setup(t);
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceAllTopics").click();
    await page.locator('[data-reference-topic="services"]').focus();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.activeElement.checkVisibility() && document.getElementById("meaning").contains(document.activeElement));
    const focus = await page.evaluate(() => ({
        id: document.activeElement.id, tag: document.activeElement.tagName, topic: document.activeElement.dataset.referenceTopic,
        visible: document.activeElement.checkVisibility() && document.getElementById("meaning").contains(document.activeElement),
    }));
    assert.equal(focus.visible, true, JSON.stringify(focus));
    assert.equal(focus.topic, "services");
});
