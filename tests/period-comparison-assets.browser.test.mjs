import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";

test("real runtime loads only the exact pure comparison module closure with unchanged HTTP boundaries", { timeout: 30000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-comparison-assets-"));
    let runtime, browser;
    t.after(async () => {
        await browser?.close();
        await runtime?.close();
        await rm(root, { recursive: true, force: true });
    });
    runtime = await startServer({ dataDir: path.join(root, "data") }, { discard() {}, discardAll() {} },
        { port: 0, collector: { timers: false } });
    const assets = [
        "/assets/assessment-contract.mjs", "/assets/period-comparison-math.mjs", "/assets/report-outcome-comparison.mjs",
        "/assets/report-metric-comparison.mjs", "/assets/wire-report-metric-adapter.mjs", "/assets/report-result-contract.mjs",
        "/web/recorded-results.mjs",
    ];
    for (const asset of assets) {
        const response = await fetch(new URL(asset, runtime.url));
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /text\/javascript/);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.match(response.headers.get("content-security-policy"), /default-src 'none'; script-src 'nonce-[^']+' 'self'/);
        assert.equal((await fetch(new URL(asset, runtime.url), { headers: { Origin: "https://example.invalid" } })).status, 403);
    }
    for (const asset of ["/assets/period-comparison.mjs", "/assets/store.mjs", "/assets/period-comparison-math.mjs?file=store.mjs",
        "/web/client.mjs", "/web/recorded-results.mjs?file=client.mjs", "/assets/recorded-results.mjs"]) {
        assert.equal((await fetch(new URL(asset, runtime.url))).status, 403);
    }
    browser = await chromium.launch();
    const page = await browser.newPage(), loaded = new Set(), denied = [], errors = [];
    const origin = new URL(runtime.url).origin;
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
        if (url.origin !== origin || !["/health", ...assets].includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        if (assets.includes(url.pathname)) loaded.add(url.pathname);
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    // The health document has no application startup, source discovery or API reads.
    await page.goto(new URL("/health", runtime.url).href);
    const { state, input } = periodFixture(), response = buildPeriodComparison(state, input);
    const comparison = await page.evaluate(async periods => {
        const { comparePeriodCohorts } = await import("/assets/period-comparison-math.mjs");
        return comparePeriodCohorts(periods.baseline, periods.later);
    }, response.periods);
    assert.deepEqual(comparison, response.comparison);
    const resultComparison = await page.evaluate(async periods => {
        const { compareReportResultFacts } = await import("/assets/report-result-contract.mjs");
        return compareReportResultFacts(periods.baseline.resultFacts, periods.later.resultFacts);
    }, response.periods);
    assert.deepEqual(resultComparison, response.resultComparison);
    assert.equal(comparison.matchingCallTiming.median.delta.value, 3000);
    assert.deepEqual([...loaded].sort(), assets.sort());
    assert.deepEqual(denied, []); assert.deepEqual(errors, []);
});
