import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { defaultConsent, validateRequest } from "../lib/assessment-contract.mjs";
import { fixture, exportCatalogFor, chooseTheme } from "./helpers.mjs";

async function setup(t) {
    const records = [fixture("settings-reference")], reads = [], blocked = [], errors = [];
    const basis = { sourceRevision: 1, membershipRevision: 1, consentRevision: 0, overrideRevision: 0, deletionEpoch: 0 };
    const assessment = {
        schemaVersion: 1, basis, catalog: [], overview: { interactionRefs: [], metrics: [] }, consent: defaultConsent(),
        source: { available: true, sourceConfigRef: "config-" + "1".repeat(32), sourceConfigRevision: 1 },
        capabilities: { answer: true, usage: false, explicitAuthorization: false },
    };
    const status = {
        revision: 1, configVersion: 1, state: "paused", connected: true,
        config: { approved: true, enabled: false, appDbPath: "C:\\artificial\\data.db", sessionRoot: "C:\\artificial\\session-state", windowDays: 30, pollSeconds: 5 },
        lastCheckedAt: "2026-10-05T12:00:00Z", cadence: { pollSeconds: 5 }, metrics: {},
        discovery: { counts: { sessions: 1, dispositions: { eligible: 1 }, skippedByLimit: 0, unmappedWorkspaces: 0 } },
        historyCoverage: { eligible: 1, readable: 1, unavailable: 0, limited: 0, affected: 0, pending: 0 }, historyIssues: [],
    };
    const server = createServer(async (request, response) => {
        if (request.method === "GET" && request.url === "/") {
            response.setHeader("Content-Type", "text/html");
            response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-settings-reference'; style-src 'unsafe-inline'; font-src data:; connect-src 'self'; base-uri 'none'");
            return response.end(renderHtmlShell("a".repeat(64), "settings-reference"));
        }
        if (request.method === "GET" && request.url === "/assets/assessment-contract.mjs") {
            response.setHeader("Content-Type", "text/javascript");
            return response.end(await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8"));
        }
        if (request.method === "GET" && request.url === "/favicon.svg") return response.writeHead(204).end();
        let body = ""; for await (const chunk of request) body += chunk;
        const input = body ? JSON.parse(body) : {};
        response.setHeader("Content-Type", "application/json");
        if (request.method !== "POST" || !["/api/snapshot", "/api/collection/status", "/api/assessment/consent", "/api/assessment/overview"].includes(request.url)) {
            blocked.push(`${request.method} ${request.url}`); return response.writeHead(403).end('{"error":"Only explicitly allowed artificial reads are available."}');
        }
        reads.push(request.url);
        if (request.url === "/api/snapshot") return response.end(JSON.stringify({
            revision: 1, scenarios: records, exports: [], coverage: { notes: [] }, collection: status, assessment,
            exportCatalog: exportCatalogFor(records), requestActivity: buildRequestActivity(records),
            analytics: { ...buildActivityAnalytics(records, input), revision: 1 },
        }));
        if (request.url === "/api/collection/status") return response.end(JSON.stringify(status));
        if (request.url === "/api/assessment/consent") {
            validateRequest("get_assessment_consent", input);
            return response.end(JSON.stringify({ schemaVersion: 1, basis, data: { consent: assessment.consent, source: assessment.source, capabilities: assessment.capabilities } }));
        }
        validateRequest("get_assessment_overview", input);
        return response.end(JSON.stringify({ schemaVersion: 1, basis, data: { interactionRefs: input.interactionRefs, metrics: [] } }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    const origin = `http://127.0.0.1:${server.address().port}`;
    page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        blocked.push(route.request().url()); return route.abort();
    });
    t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); assert.deepEqual(blocked, []); });
    await page.goto(origin + "/#settings?section=display");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page, reads };
}
async function category(page, value) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const anchor = page.locator(`#settingsCategoryNav [data-category="${value}"]`);
    if (!await anchor.isVisible()) await page.locator("#settingsCategorySummary").click();
    await anchor.click();
    await page.locator(`[data-settings-section="${value}"]`).waitFor({ state: "visible" });
}

test("response saving belongs to Collection preferences with valid forms and compatible old links", { timeout: 20000 }, async t => {
    const { page, reads } = await setup(t);
    await page.goto(page.url().split("#")[0] + "#settings?section=evidence");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator("#assessmentSetup input[type=checkbox]").waitFor();
    assert.equal(await page.locator("#settingsCategoryNav [data-category=evidence]").count(), 0);
    assert.equal(await page.locator("#settingsCategoryNav [aria-current=page]").getAttribute("data-category"), "collection");
    assert.equal(await page.locator("#assessmentSetup").evaluate(node => node.closest("[data-settings-section]").dataset.settingsSection), "collection");
    assert.equal(await page.getByRole("heading", { name: "Optional evidence", exact: true }).count(), 0);
    assert.equal(await page.locator("#assessmentSetup form").count(), 1);
    assert.equal(await page.locator("form form").count(), 0);
    assert.equal(await page.locator("#assessmentSetup>section>p").count(), 1, "Current state stays; a separate introductory paragraph is unnecessary");
    const choice = page.getByRole("checkbox", { name: "Save Copilot replies locally", exact: true });
    await choice.check();
    await category(page, "data");
    await page.goBack();
    await choice.waitFor();
    assert.equal(await choice.isChecked(), true, "Moving the row cannot lose an unsaved capture choice");
    await page.getByRole("button", { name: "Discard change", exact: true }).click();
    assert.equal(await choice.isChecked(), false);
    await page.reload();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await choice.waitFor();
    assert.equal(await page.locator("#settingsCategoryNav [aria-current=page]").getAttribute("data-category"), "collection");
    assert.equal(reads.some(route => route.endsWith("/set")), false);
});

test("Settings uses a compact search/category rail and flat pane without changing native destinations", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    assert.equal(await page.locator(".settings-layout>.settings-rail").count(), 1);
    assert.equal(await page.locator(".settings-rail .settings-search").count(), 1);
    assert.equal(await page.locator(".settings-rail #settingsCategories").count(), 1);
    assert.equal(await page.locator(".settings-rail .settings-status-link").count(), 1);
    assert.equal(await page.locator(".settings-layout>.settings-content").count(), 1);
    assert.equal(await page.locator("#settingsSearch").getAttribute("placeholder"), "Search settings");
    assert.equal(await page.locator(".settings-search-icon").getAttribute("aria-hidden"), "true");
    for (const value of ["display", "connection", "collection", "data"]) {
        await category(page, value);
        const row = page.locator(`#settingsCategoryNav [data-category="${value}"]`);
        assert.equal(await row.getAttribute("aria-current"), "page");
        assert.match(await row.getAttribute("href"), /#settings\?/);
        assert.equal(await row.locator(".fluent-icon[aria-hidden=true]").count(), 1);
        assert.equal(await row.locator(".settings-category-label").count(), 1);
        const measure = await row.evaluate(node => {
            const style = getComputedStyle(node), pane = getComputedStyle(document.querySelector("[data-settings-section]:not([hidden])"));
            return {
                border: parseFloat(style.borderTopWidth), height: node.getBoundingClientRect().height, radius: parseFloat(style.borderRadius),
                paneRadius: parseFloat(pane.borderRadius), selectedFill: style.backgroundColor,
            };
        });
        assert.equal(measure.border, 0);
        assert.ok(measure.height >= 44);
        assert.equal(measure.radius, 6);
        assert.equal(measure.paneRadius, 0);
        assert.notEqual(measure.selectedFill, "rgba(0, 0, 0, 0)");
    }
    assert.equal(await page.locator('#dataManagementTitle').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator(".settings-task-row>.settings-row-copy").count(), 2);
    assert.equal(await page.locator(".settings-task-row>#deleteActivity").count(), 1);
    assert.equal(await page.locator(".settings-task-row>#recollectActivity").count(), 1);
    for (const row of await page.locator(".settings-task-row>.settings-row-copy").all()) {
        assert.equal(await row.locator("p").count(), 1, "Each Data management entry has one short purpose/effect, not repeated safety paragraphs");
        assert.ok((await row.locator("p").innerText()).split(/\s+/).length <= 22);
    }
    for (const selector of ["#historyWindowHelp", "#eventCadenceHelp"]) {
        assert.ok((await page.locator(selector).textContent()).split(/\s+/).length <= 15, "Technical collection limits belong in the existing detail hierarchy");
    }
    if (process.env.WIRE_SETTINGS_REFERENCE_PROOFS) {
        await mkdir(process.env.WIRE_SETTINGS_REFERENCE_PROOFS, { recursive: true });
        for (const theme of ["light", "dark"]) for (const width of [375, 1200]) {
            await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
            for (const value of ["display", "connection", "collection", "data"]) {
                await category(page, value);
                if (value === "collection") await page.locator("#assessmentSetup .assessment-applied").waitFor();
                await page.evaluate(() => document.fonts.ready);
                await page.evaluate(() => scrollTo(0, 0));
                await page.mouse.move(0, 0);
                await page.screenshot({ path: path.join(process.env.WIRE_SETTINGS_REFERENCE_PROOFS, `settings-${value}-${theme}-${width}.png`), fullPage: true });
            }
        }
    }
});

test("Settings rail search stays accessible on narrow panels and only navigates to named controls", { timeout: 45000 }, async t => {
    const { page, reads } = await setup(t);
    for (const theme of ["light", "dark"]) for (const width of [320, 375, 414, 768, 820, 1200, 2560]) for (const size of [100, 200]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, size);
        await page.evaluate(() => document.fonts.ready);
        await category(page, "collection");
        assert.equal(await page.getByRole("searchbox", { name: "Search settings", exact: true }).isVisible(), true);
        assert.ok((await page.locator("#settingsSearch").boundingBox()).height >= 44, "The actual search input, not only its painted wrapper, keeps a 44px target.");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${theme}/${width}/${size}`);
        for (const selector of ["#collectionWindow-control", "#collectionCadence-control"]) {
            assert.ok((await page.locator(selector).boundingBox()).height >= 44);
        }
        if (width >= 1200 && size === 100) {
            const placement = await page.evaluate(() => {
                const rail = document.querySelector(".settings-rail").getBoundingClientRect();
                const search = document.querySelector(".settings-search").getBoundingClientRect();
                const divider = document.getElementById("settingsCategories").getBoundingClientRect();
                const content = document.querySelector(".settings-content").getBoundingClientRect();
                return { inRail: search.left >= rail.left && search.right <= rail.right + 1, gap: content.left - divider.right, border: getComputedStyle(document.getElementById("settingsCategories")).borderInlineEndWidth };
            });
            assert.equal(placement.inRail, true);
            assert.ok(Math.abs(placement.gap - 48) <= 1);
            assert.equal(placement.border, "1px");
        }
    }
    await page.getByRole("searchbox", { name: "Search settings", exact: true }).fill("time zone");
    await page.locator('#settingsSearchResults a[data-setting="time-zone"]').click();
    await page.locator('[data-settings-section="display"]').waitFor({ state: "visible" });
    assert.equal(await page.locator("#displayTimeZone-control").evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#settingsSearch").inputValue(), "time zone");
    assert.doesNotMatch(page.url(), /time%20zone|time\+zone/);
    await page.goBack();
    await page.locator('[data-settings-section="collection"]').waitFor({ state: "visible" });
    assert.equal(await page.locator("#settingsSearch").inputValue(), "time zone");
    assert.ok(reads.every(route => ["/api/snapshot", "/api/collection/status", "/api/assessment/consent", "/api/assessment/overview"].includes(route)));
});
