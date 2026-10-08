import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createReportComparison, reportComparisonStyles } from "../web/report-comparison.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { tokens } from "../web/tokens.mjs";
import { fontFaceStyles } from "../lib/typeface.mjs";

const ratio = (metric, pass) => ({
    metric, kind: "pass-rate", definitionId: `${metric}-checks`, definitionVersion: 1, unit: "percent",
    basis: "user-assessment", aggregation: "pass-rate", boundary: "eligible-interactions", state: "available",
    coverage: { count: 100, eligible: 110 }, numerator: pass, denominator: 100,
});
function model(known = true) {
    const report = (id, success, accuracy, trust) => ({
        schemaVersion: 1, bundleId: `export-${id}`, snapshotHash: id.repeat(64), disclosureReviewed: true, patternVersion: 1,
        metrics: { accuracy: ratio("accuracy", accuracy), "answer-trust": ratio("answer-trust", trust) },
        toolRows: Array.from({ length: 100 }, (_, index) => ({ id: `${id}-${index}`, patternId: "mail", outcome: !known ? "unknown" : index < success ? "success" : "failure" })),
        patterns: [{
            patternId: "mail", unitKind: "tool-call", tool: "workiq-fetch", workload: "Mail", attribution: "requested-single-target",
            targetShape: "single", available: true, endpoints: [{ pathTemplate: "/me/messages", method: null, apiVersion: null, queryKeys: [] }],
        }],
        scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "synthetic-fixture", callTimesAvailable: false, historyComplete: false },
    });
    return compareFrozenReportFacts(report("a", 76, 25, 50), report("b", 88, 90, 75), { identityRelation: "same-namespace" });
}

test("comparison uses the loaded font and remains readable across root-text sizes and themes", { timeout: 120000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext();
        const requests = [];
        await context.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
        const page = await context.newPage(), errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent(`<html data-evidence-theme="light"><head><style>${fontFaceStyles}${tokens}${reportComparisonStyles}
            *{box-sizing:border-box}body{margin:0;padding:24px;background:var(--page);font-family:var(--font)}
            main{max-width:1100px;margin:auto} .proof-label{font-size:var(--type-caption);color:var(--muted)}</style></head>
            <body><main><p class="proof-label">Synthetic component proof · not collected evidence</p><div id="comparison"></div></main></body></html>`);
        await page.addScriptTag({ content: `window.component=(${createReportComparison.toString()})();window.inspectCount=0;` });
        await page.evaluate(value => {
            window.component.render(document.querySelector("#comparison"), value, { onInspectPattern: id => { window.inspected = id; window.inspectCount++; } });
        }, model());
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.fonts.check('14px "Asta Sans"')), true);
        const cdp = await context.newCDPSession(page);
        await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
        const doc = await cdp.send("DOM.getDocument");
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: ".comparison-metric-value" });
        const fonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        assert.ok(fonts.fonts.some(font => font.isCustomFont && /Asta/i.test(font.familyName)), "The metric uses embedded Asta, not a fallback");
        for (const theme of ["light", "dark"]) for (const width of [320, 375, 414, 768, 1200, 2560]) for (const size of ["100%", "200%"]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(({ theme, size }) => {
                document.documentElement.dataset.evidenceTheme = theme;
                document.documentElement.style.fontSize = size;
            }, { theme, size });
            const bounds = await page.evaluate(() => ({
                page: document.documentElement.scrollWidth, width: innerWidth,
                clipped: [...document.querySelectorAll(".comparison-metric-value,.comparison-score-value,.comparison-pattern-title")]
                    .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent),
            }));
            assert.ok(bounds.page <= width + 1, `${theme}/${width}/${size}: horizontal page overflow ${bounds.page}`);
            assert.deepEqual(bounds.clipped, [], `${theme}/${width}/${size}: clipped values`);
            if (process.env.WIRE_REPORT_PROOFS && size === "100%" && (width === 1200 && theme === "light" || width === 375 && theme === "dark")) {
                await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.WIRE_REPORT_PROOFS, `comparison-${theme}-${width}.png`), fullPage: true });
            }
        }
        const inspect = page.getByRole("button", { name: "Mail · workiq-fetch" });
        await inspect.hover();
        assert.equal(await inspect.evaluate(node => getComputedStyle(node).textDecorationLine), "none", "Comparison actions do not regain hover underlines");
        assert.equal(await inspect.evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)", "Text-only comparison actions do not paint a hover slab");
        await inspect.focus();
        await page.keyboard.press("Shift");
        assert.equal(await inspect.evaluate(node => getComputedStyle(node).outlineStyle), "solid", "Comparison action retains keyboard focus");
        await inspect.click();
        assert.deepEqual(await page.evaluate(() => [window.inspected, window.inspectCount]), ["mail", 1]);
        await page.evaluate(value => window.component.render(document.querySelector("#comparison"), value), model(false));
        assert.deepEqual(await page.locator(".comparison-score-value").allTextContents(), ["Not scored", "Not scored"]);
        await page.evaluate(() => window.component.clear(document.querySelector("#comparison")));
        assert.equal(await page.locator("#comparison").innerText(), "");
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, []);
    } finally { await browser.close(); }
});
