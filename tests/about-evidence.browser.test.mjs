import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { extractGraphActivities } from "../lib/graph-history.mjs";
import { fixture, exportCatalogFor, chooseTheme, automaticScoreOffSummary, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";

const records = [fixture("about-one"), fixture("about-two")];
records[0].toolCalls[0].startedAt = "2026-09-29T12:00:00Z";
records[1].toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
records[1].sourceSessionId = "about-second-chat";
records[1].projectId = null;
const coverage = {
    since: "2026-09-06T12:00:00Z", until: "2026-10-06T12:00:00Z", checkedAt: "2026-10-06T12:00:00Z",
    graphHistory: {
        sourceCountBasis: "retained-scan-history",
        counts: { sourcesScanned: 5, sourcesRequested: 3, requestedDirectSites: 0, outputVisibleStatuses: 0, codeReferences: 7, syntheticReferences: 2 },
    },
    notes: ["Synthetic missing-history limitation; earlier evidence is retained.", "Synthetic source note <script>never execute</script>."],
};
async function ready(page) { await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false"); }
async function setup(t, source = records, sourceCoverage = coverage) {
    const originals = structuredClone([source, sourceCoverage]), errors = [], writes = [];
    let last, holdZone;
    const status = {
        revision: 1, configVersion: 1, state: "collecting-on-interval", connected: true,
        config: { approved: true, enabled: true, appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\history", windowDays: 7, pollSeconds: 5 },
        lastCheckedAt: "2026-10-06T12:10:00Z", lastNewDataAt: "2026-10-06T12:00:00Z", cadence: { pollSeconds: 5 },
        historyCoverage: { readable: 2, unavailable: 1, limited: 0, pending: 1, eligible: 3, excluded: {} },
        historyIssues: [], metrics: {}, lastCheckWarning: "Synthetic partial check: a saved chat could not be read.",
    };
    const server = createServer(async (req, res) => {
        if (req.url === "/" && req.method === "GET") { res.setHeader("Content-Type", "text/html"); return res.end(renderHtmlShell("a".repeat(64), "about-fixture", UNBOUND_FIXTURE_BOOTSTRAP)); }
        if (req.method === "GET" && ["/favicon.ico", "/favicon.svg"].includes(req.url?.split("?")[0])) return res.writeHead(204).end();
        let body = ""; for await (const part of req) body += part;
        const input = body ? JSON.parse(body) : {};
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST" && req.url === "/api/evaluation/automatic/summary") return res.end(JSON.stringify(automaticScoreOffSummary()));
        if (req.url === "/api/snapshot") {
            if (holdZone && input.timeContext.timeZone === "UTC") await holdZone;
            last = buildActivityAnalytics(source, input);
            return res.end(JSON.stringify({
                revision: 1, scenarios: source,
                sessions: [{ sessionId: "metadata-only", name: "Metadata-only source", eligible: true }],
                exports: [], exportCatalog: exportCatalogFor(source), coverage: sourceCoverage, collection: status,
                analytics: { ...last, revision: 1 },
            }));
        }
        if (req.url === "/api/collection/status") return res.end(JSON.stringify(status));
        writes.push(req.url); res.writeHead(403).end('{"error":"Only snapshot and status reads are allowed."}');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "America/Los_Angeles", locale: "en-US", reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No clipboard reads."); }, writeText() { throw Error("No clipboard writes."); },
    } }));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(errors, []); assert.deepEqual(writes, []);
        assert.deepEqual([source, sourceCoverage], originals, "No fixture evidence or counts changed");
    });
    return { page, url: `http://127.0.0.1:${server.address().port}/`, current: () => last,
        holdUtc: () => { let release; holdZone = new Promise(resolve => { release = resolve; }); return () => { release(); holdZone = null; }; } };
}
test("Analyze shows current counts without a scope accordion or an empty warning row", async t => {
    const { page, url } = await setup(t);
    await page.goto(url); await ready(page);
    const activity = page.locator("#activityView");
    await expect(activity.locator("#coverage, #coverageBody")).toHaveCount(0);
    await expect(activity.locator("#activityListSummary")).toBeVisible();
    assert.equal(await activity.locator("#coverageNotice").boundingBox(), null);
});

test("Collection status holds distinct scope/check/scan meanings, canonical counts and unchanged source notes", { timeout: 30000 }, async t => {
    const { page, url, current } = await setup(t);
    await page.goto(url + "#home?range=custom&from=2026-09-30&to=2026-09-30"); await ready(page);
    const c = current().coverage;
    assert.match(await page.locator("#coverageBody").innerText(), new RegExp(`${c.scenarioCount} interaction.*${c.sessionCount} Copilot chat.*${c.projectCount} project`));
    assert.equal(c.sessionCount, 1, "Metadata-only and date-excluded chats are not evidence-bearing counts");
    assert.equal(await page.locator("#coverageNotice").isVisible(), false, "No missing chat identity or unscanned Graph layer in this view");
    await page.locator("#openEvidenceHelp").click();
    await page.getByRole("link", { name: "Open collection status", exact: true }).click(); await ready(page);
    if (!await page.locator("#collectionSetup").evaluate(n => n.open)) await page.locator("#collectionSetup>summary").click();
    await expect(page.locator("#collectionSetup")).toHaveAttribute("open", "");
    assert.equal(await page.locator("#collectionSetup>summary").evaluate(n => n === document.activeElement), true);
    const facts = Object.fromEntries(await page.locator("#collectionEvidenceDetails dt").evaluateAll(nodes => nodes.map(n => [n.textContent, n.nextElementSibling.textContent])));
    assert.equal(facts["Listed sources read at least once"], "5");
    assert.equal(facts["Sources currently eligible for collection"], "3");
    assert.equal(facts["Recorded request sites"], "0");
    assert.equal(facts["Code references (not executions)"], "7");
    assert.equal(facts["Approved collection window"], "7 days of local history");
    assert.equal(facts["Selected date filter"], "Sep 30, 2026 to Sep 30, 2026");
    assert.equal(facts["Dated records in this view"], "Sep 30, 2026 to Sep 30, 2026");
    assert.equal(facts["Collection window at this snapshot"], "Sep 6, 2026 to Oct 6, 2026");
    assert.match(facts["Snapshot coverage checked"], /5:00:00 AM GMT-7/);
    assert.match(await page.locator("#collectionExactCheck").innerText(), /5:10:00 AM GMT-7/);
    const details = await page.locator("#collectionEvidenceDetails").innerText();
    assert.doesNotMatch(details, /5 of 3/);
    assert.match(details, /no longer eligible.*separate counts/s);
    assert.match(details, /Code references do not show that code ran/);
    assert.match(details, /HTTP statuses are a subset.*not extra requests/);
    assert.match(details, /Owned HTTP captures are separate opt-in public metadata tests/);
    assert.ok(coverage.notes.every(note => details.includes(note)));
    assert.equal(await page.locator("#collectionEvidenceDetails script,#collectionEvidenceDetails details").count(), 0);
    assert.match(await page.locator("#settingsDiagnosticError").innerText(), /partial check/);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(value => { document.documentElement.style.fontSize = `${value * 100}%`; }, scale);
        const clipped = await page.locator("#collectionEvidenceDetails p,#collectionEvidenceDetails dt,#collectionEvidenceDetails dd,#collectionEvidenceDetails li").evaluateAll(nodes => nodes.flatMap(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            const box = node.getBoundingClientRect();
            return [...range.getClientRects()].some(r => r.x < box.x - 1 || r.right > box.right + 1 || r.bottom > box.bottom + 1) ? [node.textContent] : [];
        }));
        assert.deepEqual(clipped, [], `${theme}/${width}/${scale}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
});

test("unknown, empty and code-only evidence stay distinct, including a pending time-zone change", { timeout: 30000 }, async t => {
    const code = extractGraphActivities([
        { id: "about-code-message", type: "user.message", timestamp: "2026-09-30T00:00:00Z", data: { content: "Synthetic code reference" } },
        { id: "about-code-start", type: "tool.execution_start", timestamp: "2026-09-30T00:01:00Z", data: { toolName: "powershell", toolCallId: "about-code-call", arguments: { command: "git diff # https://graph.microsoft.com/v1.0/me/messages" } } },
    ], { sessionId: "about-code-chat" }).scenarios;
    const { page, url, current, holdUtc } = await setup(t, code, { ...coverage, graphHistory: null });
    await page.goto(url + "#home?layer=code-reference"); await ready(page);
    assert.equal(current().totals.count, 1);
    assert.equal(current().coverage.sessionCount, 1);
    assert.match(await page.locator("#activityCoverageGap").innerText(), /coverage is unknown/i);
    await page.goto(url + "#home?layer=direct-request"); await ready(page);
    assert.equal(current().totals.count, 0);
    assert.match(await page.locator("#coverageBody").innerText(), /0 interactions from 0 Copilot chats/);
    const release = holdUtc();
    try {
        await page.evaluate(() => {
            localStorage.setItem("workiq-evidence.time-zone", "UTC");
            window.dispatchEvent(new StorageEvent("storage", { key: "workiq-evidence.time-zone", newValue: "UTC" }));
        });
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
        assert.equal(await page.locator("#displayTimeZone").inputValue(), "UTC");
        assert.match(await page.locator("#displayTimeEffective").textContent(), /Updating time zone\. Still using America\/Los_Angeles/);
        assert.match(await page.locator("#collectionEvidenceDetails").textContent(), /5:00:00 AM GMT-7/);
        assert.doesNotMatch(await page.locator("#activityCoverageGap").innerText(), /GMT|UTC/);
    } finally { release(); }
    await ready(page);
    assert.match(await page.locator("#displayTimeZone option:checked").textContent(), /UTC/);
    assert.match(await page.locator("#collectionEvidenceDetails").textContent(), /12:00:00 PM GMT/);
});
