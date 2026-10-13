import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { renderHtmlShell } from "../lib/render.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { assessmentOverview, invalidateAssessmentCache } from "../lib/assessment-read-model.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { automaticScoreOffSummary, chooseTheme, navigateMain, openActivitySessions } from "./helpers.mjs";

const proofs = process.env.WIRE_APP_QUALITY_PROOFS;
async function openFixture(t, options) {
    const { state, model } = qualityDisplayFixture(options), original = structuredClone(state);
    invalidateAssessmentCache();
    const denied = [], errors = [], reads = [];
    const contractSource = await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8");
    const server = createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/") {
                res.setHeader("Content-Type", "text/html"); res.end(renderHtmlShell("a".repeat(64), "quality-fixture")); return;
            }
            if (req.method === "GET" && req.url === "/assets/assessment-contract.mjs") {
                res.setHeader("Content-Type", "text/javascript"); res.end(contractSource); return;
            }
            if (req.method === "GET" && req.url === "/favicon.svg") { res.statusCode = 204; res.end(); return; }
            let body = ""; for await (const chunk of req) body += chunk;
            const input = JSON.parse(body || "{}");
            const envelope = data => ({ schemaVersion: 1, basis: model.basis, data });
            let data;
            if (req.url === "/api/snapshot") data = await currentStatePayload({ dataDir: path.join(os.tmpdir(), "wire-quality-memory-only") }, state, input);
            else if (req.url === "/api/assessment/overview") data = envelope(assessmentOverview(state, model, input.interactionRefs));
            else if (req.url === "/api/assessment/detail") data = envelope(model.details.get(input.interactionRef));
            else if (req.url === "/api/evaluation/automatic/summary") data = automaticScoreOffSummary();
            else if (req.url === "/api/collection/status") data = { state: "paused", config: null, revision: state.revision };
            else { denied.push(`${req.method} ${req.url}`); res.statusCode = 403; data = { error: "This fixture permits read-only app requests." }; }
            if (options?.omitAttemptHistory) {
                data = structuredClone(data);
                if (data.assessment?.overview) delete data.assessment.overview.assessmentAttempts;
                if (data.data) delete data.data.assessmentAttempts;
            }
            reads.push(req.url); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data));
        } catch (error) {
            errors.push(error.message); res.statusCode = 500; res.end(JSON.stringify({ error: error.message }));
        }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === url) return route.continue();
        denied.push(route.request().url()); return route.abort();
    });
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.deepEqual(state, original);
        assert.ok(reads.every(route => !/approve|evaluate|feedback|export|collect-now|capture/.test(route)));
    });
    return { page, url, model, state };
}
async function ready(page, host) {
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator(`${host} .assessment-grid`).waitFor();
    await page.evaluate(() => document.fonts.ready);
}
async function capture(page, host, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.evaluate(() => scrollTo(0, 0));
    const clip = await page.locator(host).evaluate(node => {
        const box = node.getBoundingClientRect();
        return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height };
    });
    await page.screenshot({ path: path.join(proofs, `${name}.png`), fullPage: true, clip });
    await writeFile(path.join(proofs, `${name}.txt`), await page.locator(host).innerText());
}
async function readable(page, host) {
    const facts = await page.locator(host).evaluate(node => {
        const rect = node.getBoundingClientRect();
        return {
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            outside: [...node.querySelectorAll(".assessment-cell,.assessment-fact-label")].some(child => {
                const box = child.getBoundingClientRect(); return box.left < rect.left - 1 || box.right > rect.right + 1;
            }),
            targets: [...node.querySelectorAll("button,summary")].filter(child => child.checkVisibility()).map(child => child.getBoundingClientRect().height),
            headings: [...node.querySelectorAll("h3,h4")].map(child => child.textContent),
        };
    });
    assert.equal(facts.overflow, false); assert.equal(facts.outside, false);
    assert.ok(facts.targets.every(height => height >= 44));
    assert.ok(facts.headings.includes("Quality assessment")); assert.ok(!facts.headings.includes("Recorded timing"));
}
const cases = [
    { name: "unassessed", options: {}, assessed: 0, eligible: 18 },
    { name: "partial", options: { requests: 108, calls: 228, judgments: ["pass", "pass"] }, assessed: 2, eligible: 108 },
    { name: "complete", options: { requests: 4, calls: 9, judgments: ["pass", "pass", "pass", "pass"] }, assessed: 4, eligible: 4 },
    { name: "mixed", options: { requests: 6, calls: 13, judgments: ["pass", "fail", "unassessed", "error"] }, assessed: 2, eligible: 6 },
    { name: "insufficient", options: { requests: 3, calls: 7, judgments: ["unassessed", "unassessed"] }, assessed: 0, eligible: 3 },
];
for (const scenario of cases) test(`quality readout: ${scenario.name} source facts remain count-led across app surfaces`, { timeout: 60000 }, async t => {
    const { page, url } = await openFixture(t, scenario.options);
    await page.goto(url + "#home"); await ready(page, "#homeInsights");
    const home = page.locator("#homeInsights");
    assert.doesNotMatch(await home.innerText(), /Results for|Other recorded measures|677\.96 s/);
    assert.match(await home.innerText(), /Tool execution/);
    const accuracy = home.locator('[data-quality-dimension="accuracy"]');
    assert.match(await accuracy.innerText(), new RegExp(`${scenario.assessed} of ${scenario.eligible} requests assessed`));
    assert.equal(await accuracy.locator(".assessment-primary-percent").count(), 0);
    if (scenario.assessed < scenario.eligible) assert.match(await accuracy.innerText(), new RegExp(`${scenario.eligible - scenario.assessed} (?:requests )?not assessed`));
    if (scenario.name === "partial") {
        assert.match(await accuracy.innerText(), /2 passed/); assert.match(await accuracy.innerText(), /106 requests not assessed/);
        assert.doesNotMatch(await accuracy.locator(".assessment-value").innerText(), /100%/);
    }
    if (scenario.name === "mixed") {
        assert.match(await accuracy.innerText(), /1 passed/); assert.match(await accuracy.innerText(), /1 failed/);
        assert.match(await accuracy.innerText(), /insufficient|not enough evidence/i);
        assert.match(await home.locator('[data-attempt-state="failed"]').innerText(), /1 request.*Evaluator attempt failed/s);
    }
    assert.equal(await home.locator(".assessment-timing").count(), 0);
    const timing = page.locator("#activityList .response-timing data").first();
    assert.equal(await timing.innerText(), "11 min 17.96 s");
    assert.equal(await timing.getAttribute("value"), "677960");
    for (const [width, size, theme] of [[1440, 100, "light"], [1200, 100, "dark"], [375, 100, "light"], [375, 200, "dark"]]) {
        await page.setViewportSize({ width, height: 1100 }); await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, size);
        await readable(page, "#homeInsights");
        await capture(page, "#homeInsights", `${scenario.name}-home-${width}-${size}-${theme}`);
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    const homeAccuracy = await accuracy.textContent();
    await navigateMain(page, "activity"); await ready(page, "#activityInsights");
    assert.equal(await page.locator('#activityInsights [data-quality-dimension="accuracy"]').textContent(), homeAccuracy);
    await capture(page, "#activityInsights", `${scenario.name}-activity`);
    await page.locator("#activitySearch").fill("Invented quality request 0");
    await page.waitForFunction(() => document.querySelector('#activityInsights [data-quality-dimension="accuracy"]')?.textContent.includes("of 1 request"));
    await openActivitySessions(page);
    const selected = page.locator('.request-row input[type="checkbox"]').first();
    await selected.check();
    await page.getByRole("link", { name: "View interaction", exact: true }).first().click();
    await ready(page, ".interaction-insights");
    await readable(page, ".interaction-insights"); await capture(page, ".interaction-insights", `${scenario.name}-detail`);
    const trigger = page.locator(".interaction-insights [data-insight-details]");
    await trigger.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Insight details", exact: true });
    await dialog.waitFor();
    await dialog.getByText("Recorded measures and definitions", { exact: true }).click();
    assert.match(await dialog.innerText(), /677,960 ms/);
    assert.match(await dialog.innerText(), /Recorded request to final response; not tool-call time/);
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    await page.goBack(); await ready(page, "#activityInsights");
    assert.equal(await page.locator("#activitySearch").inputValue(), "Invented quality request 0");
    assert.equal(await selected.isChecked(), true);
    await page.locator(".skip-link").focus(); await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id === "main" || document.querySelector("#main").contains(document.activeElement)), true);
    if (scenario.name === "mixed") {
        await page.goto(url + "#request?request=quality-request-3"); await ready(page, ".interaction-insights");
        assert.match(await page.locator(".assessment-review-status").innerText(), /evaluator failure, not a failed answer or action verdict/);
        assert.deepEqual(await page.locator(".interaction-insights .assessment-check .assessment-value").allTextContents(),
            ["Quality not assessed", "Quality not assessed", "Quality not assessed"]);
        await capture(page, ".interaction-insights", "evaluator-error-detail");
    }
});

test("missing final-response timing and historical attempt metadata remain visible unknowns", { timeout: 30000 }, async t => {
    const { page, url } = await openFixture(t, { requests: 3, calls: 7, finalDuration: null, omitAttemptHistory: true });
    await page.goto(url + "#home"); await ready(page, "#homeInsights");
    const host = page.locator("#homeInsights");
    assert.match(await host.locator(".assessment-attempts").innerText(), /Assessment attempt history unavailable/);
    assert.equal(await host.locator("[data-attempt-state=none]").count(), 0);
    assert.equal(await host.locator(".assessment-timing").count(), 0);
    assert.deepEqual(await page.locator("#activityList .response-timing dd").allTextContents(), Array(3).fill("Not recorded"));
    await capture(page, "#homeInsights", "historical-unknown-and-missing-timing");
});
