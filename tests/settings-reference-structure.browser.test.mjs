import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { defaultConsent, validateRequest } from "../lib/assessment-contract.mjs";
import { fixture, exportCatalogFor, chooseTheme, automaticScoreOffSummary, selectActivityOption, openSourceEditor, restoreLegacySearch, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";
import { createSettingsNavigation } from "../web/settings-navigation.mjs";
import { createLocalSearch } from "../web/local-search.mjs";
import { enabledConsent } from "./assessment-contract-fixtures.mjs";

async function setup(t, { approved = true, nonmatchingRecord = false } = {}) {
    const records = [fixture("settings-reference")], reads = [], blocked = [], errors = [];
    if (nonmatchingRecord) {
        const other = fixture("settings-unmatched");
        other.userPrompt.text = "Inspect invented lighthouse records";
        other.followUpPrompts = [];
        records.push(other);
    }
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
    if (!approved) { status.config = null; status.connected = false; status.state = "unconfigured"; assessment.source.available = false; }
    const automatic = automaticScoreOffSummary();
    const server = createServer(async (request, response) => {
        if (request.method === "GET" && request.url === "/") {
            response.setHeader("Content-Type", "text/html");
            response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-settings-reference'; style-src 'unsafe-inline'; font-src data:; connect-src 'self'; base-uri 'none'");
            return response.end(renderHtmlShell("a".repeat(64), "settings-reference", UNBOUND_FIXTURE_BOOTSTRAP));
        }
        if (request.method === "GET" && request.url === "/assets/assessment-contract.mjs") {
            response.setHeader("Content-Type", "text/javascript");
            return response.end(await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8"));
        }
        if (request.method === "GET" && request.url?.split("?")[0] === "/favicon.svg") return response.writeHead(204).end();
        let body = ""; for await (const chunk of request) body += chunk;
        const input = body ? JSON.parse(body) : {};
        response.setHeader("Content-Type", "application/json");
        if (request.method !== "POST" || !["/api/snapshot", "/api/collection/status", "/api/collection/issues", "/api/record/status",
            "/api/assessment/consent", "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(request.url)) {
            blocked.push(`${request.method} ${request.url}`); return response.writeHead(403).end('{"error":"Only explicitly allowed artificial reads are available."}');
        }
        reads.push(request.url);
        if (request.url === "/api/snapshot") return response.end(JSON.stringify({
            revision: 1, scenarios: records, exports: [], coverage: { notes: [] }, collection: status, assessment,
            exportCatalog: exportCatalogFor(records), requestActivity: buildRequestActivity(records),
            analytics: { ...buildActivityAnalytics(records, input), revision: 1 },
        }));
        if (request.url === "/api/collection/status") return response.end(JSON.stringify(status));
        if (request.url === "/api/collection/issues") return response.end(JSON.stringify({ revision: 1, issues: [], historyIssues: [], total: 0 }));
        if (request.url === "/api/record/status") return response.end(JSON.stringify({ attempt: null }));
        if (request.url === "/api/evaluation/automatic/summary") return response.end(JSON.stringify(automatic));
        if (request.url === "/api/assessment/consent") {
            validateRequest("get_assessment_consent", input);
            return response.end(JSON.stringify({ schemaVersion: 1, basis, data: { consent: assessment.consent, source: assessment.source, capabilities: assessment.capabilities } }));
        }
        validateRequest("get_assessment_overview", input);
        return response.end(JSON.stringify({ schemaVersion: 1, basis, data: { interactionRefs: input.interactionRefs, metrics: [] } }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" }), page = await context.newPage();
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
    return { page, reads, status, automatic, origin, assessment };
}
async function captureSwitchState(page, name) {
    const proofs = process.env.WIRE_RESPONSE_SETTINGS_PROOFS;
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => !document.getAnimations().some(animation =>
        animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime)));
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: true });
}
async function category(page, value) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const anchor = page.locator(`#settingsCategoryNav [data-category="${value}"]`);
    if (!await anchor.isVisible()) await page.locator("#settingsCategorySummary").click();
    await anchor.click();
    await page.locator(`[data-settings-section="${value}"]`).waitFor({ state: "visible" });
}

test("response saving belongs to Privacy and saved data with valid forms and compatible old links", { timeout: 20000 }, async t => {
    const { page, reads } = await setup(t);
    await page.goto(page.url().split("#")[0] + "#settings?section=evidence");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator("#assessmentSetup input[type=checkbox]").waitFor();
    assert.equal(await page.locator("#settingsCategoryNav [data-category=evidence]").count(), 0);
    assert.equal(await page.locator("#settingsCategoryNav [aria-current=page]").getAttribute("data-category"), "privacy");
    assert.equal(await page.locator("#assessmentSetup").evaluate(node => node.closest("[data-settings-section]").dataset.settingsSection), "privacy");
    assert.equal(await page.getByRole("heading", { name: "Optional evidence", exact: true }).count(), 0);
    assert.equal(await page.locator("#assessmentSetup form").count(), 1);
    assert.equal(await page.locator("form form").count(), 0);
    assert.equal(await page.locator("#assessmentSetup .settings-reply-help").count(), 1, "One explanation stays with the choice");
    const choice = page.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
    await choice.check();
    await category(page, "connection");
    await page.goBack();
    await choice.waitFor();
    assert.equal(await choice.isChecked(), true, "Moving the row cannot lose an unsaved capture choice");
    await page.getByRole("button", { name: "Discard change", exact: true }).click();
    assert.equal(await choice.isChecked(), false);
    await page.reload();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await choice.waitFor();
    assert.equal(await page.locator("#settingsCategoryNav [aria-current=page]").getAttribute("data-category"), "privacy");
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
    assert.equal(await page.locator(".settings-search .wire-search-icon svg").getAttribute("aria-hidden"), "true");
    for (const value of ["connection", "display", "troubleshooting", "privacy"]) {
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
    assert.equal(await page.locator('[data-settings-section=privacy] .settings-task-row>.settings-row-copy').count(), 3);
    assert.equal(await page.locator(".settings-task-row>#deleteActivity").count(), 1);
    assert.equal(await page.locator(".settings-task-row>#recollectActivity").count(), 1);
    for (const row of await page.locator('[data-settings-section=privacy] .settings-task-row>.settings-row-copy:has(p)').all()) {
        assert.equal(await row.locator("p").count(), 1, "Each Data management entry has one short purpose/effect, not repeated safety paragraphs");
        assert.ok((await row.locator("p").innerText()).split(/\s+/).length <= 22);
    }
    await expect(page.locator('[data-settings-section=privacy] a.button-link[href="#reports"]')).toHaveText("Open saved reports");
    assert.equal(await page.locator("#historyWindowHelp").count(), 0);
    if (process.env.WIRE_SETTINGS_REFERENCE_PROOFS) {
        await mkdir(process.env.WIRE_SETTINGS_REFERENCE_PROOFS, { recursive: true });
        for (const theme of ["light", "dark"]) for (const width of [375, 1200]) {
            await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
            for (const value of ["connection", "privacy", "display", "troubleshooting"]) {
                await category(page, value);
                if (value === "privacy") await page.locator("#assessmentSetup input[type=checkbox]").waitFor();
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
        await category(page, "connection");
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
    await page.locator('[data-settings-section="connection"]').waitFor({ state: "visible" });
    assert.equal(await page.locator("#settingsSearch").inputValue(), "time zone");
    assert.ok(reads.every(route => ["/api/snapshot", "/api/collection/status", "/api/assessment/consent", "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(route)));
});

test("every registered setting and old route opens its exact live destination without an action", { timeout: 45000 }, async t => {
    const { page, origin } = await setup(t);
    const navigation = createSettingsNavigation(createLocalSearch());
    const route = async hash => {
        await page.evaluate(hash => { location.hash = hash; }, hash);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    };
    for (const entry of navigation.entries) {
        await route("#settings?section=troubleshooting");
        await page.locator("#settingsSearch").fill(entry.title);
        await page.locator(`#settingsSearchResults a[data-setting="${entry.id}"]`).click();
        let target = entry.id === "source" ? "editSource" : entry.id === "source-paths" ? "approvedSourceTitle" : entry.target;
        if (["displayTimeZone", "collectionWindow", "collectionCadence"].includes(target)) target += "-control";
        if (entry.id === "save-preferences") {
            await expect(page.locator("#saveCollection")).toBeDisabled();
            assert.equal(await page.locator("#saveCollection").evaluate(node => node.closest(".ux-disabled-help") === document.activeElement), true);
        } else {
            const node = page.locator(`#${target}`);
            await expect(node).toBeVisible();
            if (await node.evaluate(node => node.tagName === "DETAILS")) await expect(node.locator("summary")).toBeFocused();
            else await expect(node).toBeFocused();
        }
        assert.equal(await page.locator("dialog[open]").count(), 0, entry.id);
    }
    for (const [legacy, canonical] of Object.entries(navigation.sectionAliases)) {
        await route(`#settings?section=${legacy}`);
        await expect(page.locator("#settingsCategoryNav [aria-current=page]")).toHaveAttribute("data-category", canonical.section);
        assert.ok(page.url().startsWith(origin));
    }
    await route("#settings?section=collection&setting=automatic-scores");
    await expect(page.locator("#automaticScoreReview")).toHaveCount(0);
    await expect(page.locator("#settingsRouteNotice")).toContainText("Unknown setting");
    await route("#settings?section=collection&setting=assessment-evidence");
    await expect(page.locator("#assessmentSetupTitle")).toBeFocused();
    await route("#settings?issues=1");
    await expect(page.locator("#collectionIssuesTitle")).toBeFocused();
    await route("#settings?section=diagnostics&setting=advanced");
    await expect(page.locator("#collectionSetup>summary")).toBeFocused();
    await route("#settings?section=missing");
    await expect(page.locator("#settingsRouteNotice")).toContainText("Unknown settings category");
    await expect(page.locator("#connectionTitle")).toBeFocused();
});

test("category navigation preserves source and reply drafts, local search, cancellation and independent approvals", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await category(page, "connection");
    await openSourceEditor(page);
    await page.locator("#sourceDatabase").fill("C:\\invented-unsaved\\data.db");
    await page.locator("#sourceSessions").fill("C:\\invented-unsaved\\session-state");
    await selectActivityOption(page, "collectionWindow", "7");
    await selectActivityOption(page, "collectionCadence", "15");
    const sourceNode = await page.locator("#sourceDatabase").elementHandle();
    await expect(page.locator("#checkActivity")).toBeDisabled();
    await expect(page.locator("#preferenceActions")).toBeHidden();
    await category(page, "privacy");
    const choice = page.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
    await choice.check();
    await page.locator("#settingsSearch").fill("Theme");
    await page.locator('#settingsSearchResults a[data-setting="theme"]').click();
    await expect(page.locator("#settingsThemePreference")).toBeFocused();
    assert.equal(await page.locator("dialog[open]").count(), 0);
    await page.goBack();
    await expect(choice).toBeChecked();
    assert.equal(await page.locator("#settingsSearch").inputValue(), "Theme");
    await page.getByRole("button", { name: "Discard change", exact: true }).click();
    await expect(choice).not.toBeChecked();
    await expect(choice).toBeFocused();
    await category(page, "connection");
    assert.equal(await sourceNode.evaluate(node => node === document.getElementById("sourceDatabase")), true);
    await expect(page.locator("#sourceDatabase")).toHaveValue("C:\\invented-unsaved\\data.db");
    await expect(page.locator("#approvalScope")).toContainText("7 days; check every 15 seconds");
    await page.locator("#cancelSource").click();
    await expect(page.locator("#sourceDatabase")).toHaveValue("C:\\artificial\\data.db");
    await expect(page.locator("#editSource")).toBeFocused();
    await selectActivityOption(page, "collectionCadence", "30");
    await category(page, "display");
    await category(page, "connection");
    await expect(page.locator("#collectionCadence")).toHaveValue("30");
    await expect(page.locator("#saveCollection")).toBeEnabled();
    await page.locator("#cancelPreferences").click();
    await expect(page.locator("#collectionCadence")).toHaveValue("5");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await expect(page.locator("#pauseCollection")).toHaveText("Resume collection");
});

test("pending and uncertain settings results survive categories and only explicit recovery reads their outcome", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const packets = [];
    let release;
    await page.route("**/api/collection/configure", async route => {
        packets.push(route.request().postDataJSON());
        await new Promise(resolve => { release = resolve; });
        await route.abort("failed");
    });
    await category(page, "connection");
    await selectActivityOption(page, "collectionCadence", "15");
    await page.locator("#saveCollection").click();
    await expect(page.locator("#collectionCadence")).toBeDisabled();
    await expect(page.locator("#settingsDraftStatus")).toContainText("Wait while");
    await page.locator('#settingsCategoryNav [data-category="privacy"]').click();
    await expect(page.locator('[data-settings-section="connection"]')).toBeVisible();
    release();
    await expect(page.locator("#reloadSettings")).toBeVisible();
    await expect(page.locator("#settingsMessage")).toContainText("No success is assumed");
    await category(page, "privacy");
    await category(page, "display");
    await expect(page.locator("#settingsMessage")).toBeVisible();
    await expect(page.locator("#checkActivity")).toBeDisabled();
    await category(page, "connection");
    await expect(page.locator("#collectionCadence")).toHaveValue("15");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await page.locator("#reloadSettings").click();
    await expect(page.locator("#reloadSettings")).toBeHidden();
    await expect(page.locator("#saveCollection")).toBeEnabled();
    assert.equal(packets.length, 1, "Recovery and rail navigation never replay the write");
    assert.equal(packets[0].enabled, false, "Preference changes preserve paused collection");
    assert.equal(packets[0].appDbPath, "C:\\artificial\\data.db");
    await page.locator("#cancelPreferences").click();
});

test("source preferences, pause and replacement keep their own explicit save gates", { timeout: 30000 }, async t => {
    const { page, status } = await setup(t);
    const writes = [];
    await page.route("**/api/collection/configure", async route => {
        const input = route.request().postDataJSON();
        writes.push({ path: "configure", input });
        assert.equal(input.expectedConfigVersion, status.configVersion);
        status.config = { ...status.config, ...input };
        status.configVersion++;
        await route.fulfill({ json: status });
    });
    await page.route("**/api/collection/enabled", async route => {
        const input = route.request().postDataJSON();
        writes.push({ path: "enabled", input });
        status.config.enabled = input.enabled;
        status.configVersion++;
        await route.fulfill({ json: status });
    });
    await category(page, "connection");
    await selectActivityOption(page, "collectionCadence", "30");
    await page.locator("#saveCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("Preferences saved");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].input.enabled, false);
    assert.equal(writes[0].input.appDbPath, "C:\\artificial\\data.db");
    await page.locator("#pauseCollection").click();
    await expect(page.locator("#pauseCollection")).toHaveText("Pause collection");
    assert.equal(writes[1].path, "enabled");
    await openSourceEditor(page);
    await page.locator("#sourceDatabase").fill("C:\\invented-new\\data.db");
    await page.locator("#sourceSessions").fill("C:\\invented-new\\session-state");
    await page.locator("#sourceSessions").press("Enter");
    assert.equal(writes.length, 2, "Typing a path is not source approval");
    await expect(page.locator("#preferenceActions")).toBeHidden();
    await page.locator("#connectCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("Source approved");
    assert.equal(writes.length, 3);
    assert.equal(writes[2].input.enabled, true);
    assert.equal(writes[2].input.appDbPath, "C:\\invented-new\\data.db");
    await category(page, "privacy");
    await expect(page.getByRole("switch", { name: "Save Copilot replies locally", exact: true })).not.toBeChecked();
    await expect(page.locator("#automaticScoreState,[data-category=ai]")).toHaveCount(0);
});

test("reply-saving pending and uncertain state survives the rail without repeating permission", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const writes = [];
    let release;
    await page.route("**/api/assessment/consent/set", async route => {
        writes.push(route.request().postDataJSON());
        await new Promise(resolve => { release = resolve; });
        await route.abort("failed");
    });
    await category(page, "privacy");
    const choice = page.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
    await choice.check();
    await page.getByRole("button", { name: "Turn on response saving", exact: true }).click();
    await expect(choice).toBeDisabled();
    await category(page, "display");
    release();
    await category(page, "privacy");
    await expect(page.locator("#assessmentSetup [role=alert]")).toContainText("do not repeat the update");
    await expect(choice).toBeDisabled();
    await expect(page.getByRole("button", { name: "Check update result", exact: true })).toBeEnabled();
    await category(page, "connection");
    await category(page, "privacy");
    await expect(choice).toBeDisabled();
    assert.equal(writes.length, 1);
    assert.equal(await page.locator("dialog[open]").count(), 0);
});

test("unapproved source search stays read-only and stale AI status cannot restore retired controls", { timeout: 30000 }, async t => {
    const { page, automatic } = await setup(t, { approved: false });
    await category(page, "connection");
    await expect(page.locator("#reviewSource")).toBeEnabled();
    await expect(page.locator("#checkActivity")).toHaveAccessibleName("Read stored activity");
    for (const query of ["source", "pause", "Refresh"]) {
        await page.locator("#settingsSearch").fill(query);
        const id = query === "pause" ? "collection-state" : query === "Refresh" ? "collect-now" : "source";
        if (id === "collect-now") await expect(page.locator('#settingsSearchResults a[data-setting="collect-now"]')).toContainText("stored activity only");
        await page.locator(`#settingsSearchResults a[data-setting="${id}"]`).click();
        await expect(page.locator(id === "collect-now" ? "#checkActivity" : "#reviewSource")).toBeFocused();
        await expect(page.locator("#sourceEditor")).toBeHidden();
    }
    await category(page, "privacy");
    await expect(page.locator("#assessmentSetup")).toContainText("Connect a supported local Copilot source");
    automatic.snapshot.state = "paused";
    automatic.snapshot.reason = "evaluation-failed";
    await category(page, "display");
    await expect(page.locator("#automaticScoreState,#automaticScoreReview,[data-category=ai]")).toHaveCount(0);
    assert.equal(await page.locator("dialog[open]").count(), 0);
});

test("four current groups retain keyboard focus and readable geometry at 375 and 200 percent in both themes", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    const evidence = [], proofs = process.env.WIRE_SETTINGS_ORGANIZATION_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    const groups = createSettingsNavigation(createLocalSearch()).categories;
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 100], [375, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        await chooseTheme(page, theme);
        for (const group of groups) {
            await category(page, group.id);
            if (group.id === "privacy") await page.locator("#assessmentSetup input").waitFor();
            await expect(page.locator(`#${group.heading}`)).toBeFocused();
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement.checkVisibility()), true);
            const value = await page.evaluate(() => {
                const pane = document.querySelector("[data-settings-section]:not([hidden])");
                const nodes = [...pane.querySelectorAll("button,summary,label,p,h2,h3,a")].filter(node => node.checkVisibility());
                const active = getComputedStyle(document.activeElement);
                const face = getComputedStyle(document.activeElement.matches(".ux-disabled-help")
                    ? document.activeElement.querySelector("button") : document.activeElement, "::before");
                return {
                    overflow: document.documentElement.scrollWidth > innerWidth,
                    clipped: nodes.filter(node => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1).map(node => node.id || node.tagName),
                    targets: nodes.filter(node => node.matches("button,summary,.button-link")).map(node => ({ id: node.id || node.textContent, height: node.getBoundingClientRect().height })),
                    focus: active.outlineStyle !== "none" ? active.outlineStyle : face.outlineStyle,
                    sectionCount: document.querySelectorAll("[data-settings-section]:not([hidden])").length,
                };
            });
            assert.equal(value.overflow, false, `${theme}/${width}/${scale}/${group.id}`);
            assert.deepEqual(value.clipped, [], `${theme}/${width}/${scale}/${group.id}`);
            assert.equal(value.sectionCount, 1);
            assert.equal(value.focus, "solid");
            assert.ok(value.targets.every(target => target.height >= 44));
            evidence.push({ theme, width, scale, group: group.id, ...value });
            if (proofs) {
                await page.keyboard.press("Escape");
                await page.mouse.move(0, 0);
                await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
                await page.screenshot({ path: path.join(proofs, `${theme}-${width}-${scale}-${group.id}.png`), fullPage: true });
            }
        }
    }
    await category(page, "display");
    const previous = await page.locator("html").getAttribute("data-evidence-theme");
    await page.locator("#settingsThemePreference").click();
    const next = previous === "light" ? "dark" : "light";
    await expect(page.locator("html")).toHaveAttribute("data-evidence-theme", next);
    await expect(page.locator("#themePreference")).toHaveAttribute("aria-checked", String(next === "dark"));
    await expect(page.locator("#settingsThemePreference")).toHaveAttribute("aria-checked", String(next === "dark"));
    if (proofs) await writeFile(path.join(proofs, "geometry.json"), JSON.stringify(evidence, null, 2));
});

test("Display and header share switch artwork, native activation, storage updates and errors", async t => {
    const { page, origin } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await category(page, "display");
    const controls = [page.locator("#themePreference"), page.locator("#settingsThemePreference")], evidence = [];
    const other = await page.context().newPage();
    t.after(() => other.close());
    await other.goto(origin + "/#settings?section=display");
    await expect(other.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const control of controls) {
            await expect(control).toHaveAttribute("role", "switch");
            await expect(control).toHaveAttribute("aria-checked", String(theme === "dark"));
            await expect(control.locator(".theme-thumb")).toHaveCSS("transform", `matrix(1, 0, 0, 1, ${theme === "dark" ? 36 : 0}, 0)`);
        }
        const geometry = [];
        for (const control of controls) geometry.push(await control.evaluate(node => {
            const rect = node.getBoundingClientRect();
            const box = element => {
                const value = element.getBoundingClientRect();
                return { x: value.x - rect.x, y: value.y - rect.y, width: value.width, height: value.height };
            };
            return { target: { width: rect.width, height: rect.height }, track: box(node.querySelector(".theme-track")),
                thumb: box(node.querySelector(".theme-thumb")), glyphs: [...node.querySelectorAll("svg")].map(icon => ({
                    name: icon.dataset.lucideIcon, ...box(icon), color: getComputedStyle(icon).color,
                })), artwork: node.querySelector(".theme-track").outerHTML };
        }));
        assert.deepEqual(geometry[0], geometry[1], "Same painted glyphs, thumb/track and target, not just matching SVG names");
        assert.deepEqual(geometry[0].target, { width: 80, height: 44 });
        assert.equal(geometry[0].track.width, 76);
        assert.equal(geometry[0].thumb.width, 32);
        assert.deepEqual(geometry[0].glyphs.map(glyph => [glyph.name, glyph.width, glyph.height]), [["sun", 20, 20], ["moon", 20, 20]]);
        for (const control of controls) for (const action of ["click", "Space", "Enter"]) {
            const wasDark = await control.getAttribute("aria-checked") === "true";
            if (action === "click") await control.click();
            else { await control.focus(); await page.keyboard.press(action); }
            for (const mirrored of controls) await expect(mirrored).toHaveAttribute("aria-checked", String(!wasDark));
            await expect(other.locator("#settingsThemePreference")).toHaveAttribute("aria-checked", String(!wasDark));
        }
        await controls[1].focus();
        await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
        await expect(controls[1]).toBeFocused();
        await expect(controls[1]).toHaveCSS("outline-style", "solid");
        await expect(controls[1]).toHaveAccessibleName("Use dark theme");
        await captureSwitchState(page, `theme-${theme}-synchronized-focus`);
        evidence.push({ theme, geometry });
    }
    await other.locator("#settingsThemePreference").click();
    const storedDark = await other.locator("#settingsThemePreference").getAttribute("aria-checked");
    for (const control of controls) await expect(control).toHaveAttribute("aria-checked", storedDark);
    await chooseTheme(page, "dark");
    await page.evaluate(() => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
            if (key === "workiq-evidence.theme") throw new DOMException("Invented browser storage denial", "QuotaExceededError");
            return set.call(this, key, value);
        };
    });
    await page.locator("#settingsThemePreference").click();
    await expect(page.locator("#themeStorageNotice")).toBeVisible();
    await expect(page.locator("#settingsThemePreference")).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("#settingsThemePreference")).toHaveAttribute("aria-describedby", "themeStorageNotice");
    await expect(page.locator("#settingsThemePreference")).toHaveAccessibleDescription(/theme.*panel|preference.*panel/i);
    await expect(page.locator("#themePreference")).toHaveAttribute("aria-checked", "false");
    await expect(other.locator("#settingsThemePreference")).toHaveAttribute("aria-checked", "true");
    await captureSwitchState(page, "theme-storage-warning");
    await category(page, "connection");
    await category(page, "display");
    await expect(page.getByRole("combobox", { name: "Time zone", exact: true })).toBeVisible();
    await page.locator("#displayTimeZone-control").focus();
    await expect(page.locator("#displayTimeZone-control")).toBeFocused();
    await expect(page.locator("#settingsCategoryNav [aria-current=page]")).toHaveAttribute("data-category", "display");
    const proofs = process.env.WIRE_RESPONSE_SETTINGS_PROOFS;
    if (proofs) await writeFile(path.join(proofs, "theme-switch-geometry.json"), JSON.stringify(evidence, null, 2));
});

for (const theme of ["light", "dark"]) test(`reply switch source, pending, unknown and rejected states stay explicit (${theme})`, { timeout: 30000 }, async t => {
    const { page, assessment } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await chooseTheme(page, theme);
    await category(page, "privacy");
    const pane = page.locator("#assessmentSetup"), choice = pane.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
    const writes = [], reads = [];
    let release, finishRead, reject = false;
    t.after(() => { release?.(); finishRead?.(); });
    await page.route("**/api/assessment/consent/set", async route => {
        writes.push(route.request().postDataJSON());
        if (reject) return route.fulfill({ status: 403, json: { error: "Synthetic source approval changed. No choice was saved." } });
        await new Promise(resolve => { release = resolve; });
        await route.abort("failed");
    });
    await page.route("**/api/assessment/mutation/status", async route => {
        reads.push(route.request().postDataJSON());
        await new Promise(resolve => { finishRead = resolve; });
        await route.fulfill({ json: { schemaVersion: 1, mutationRef: writes[0].mutationRef, phase: "not-started" } });
    });
    await choice.focus(); await page.keyboard.press("Space");
    await expect(choice).toBeChecked();
    await expect(pane.locator(".assessment-applied")).toContainText("not saved yet");
    assert.equal(writes.length, 0);
    await captureSwitchState(page, `${theme}-reply-on-draft`);
    await pane.getByRole("button", { name: "Turn on response saving", exact: true }).click();
    await expect(choice).toBeDisabled();
    await expect(pane.getByRole("button", { name: "Discard change", exact: true })).toBeDisabled();
    await captureSwitchState(page, `${theme}-reply-saving`);
    await category(page, "display"); release();
    await category(page, "privacy");
    await expect(pane.getByRole("alert")).toContainText("do not repeat the update");
    await expect(choice).toBeDisabled();
    await expect(pane.getByRole("button", { name: "Discard change", exact: true })).toHaveCount(0);
    await captureSwitchState(page, `${theme}-reply-unknown`);
    await pane.getByRole("button", { name: "Check update result", exact: true }).click();
    await expect(pane.getByRole("button", { name: "Check update result", exact: true })).toBeDisabled();
    await captureSwitchState(page, `${theme}-reply-checking`);
    await expect.poll(() => reads.length).toBe(1);
    assert.equal(reads[0].mutationRef, writes[0].mutationRef);
    assert.equal(reads[0].receiptToken, writes[0].receiptToken);
    finishRead();
    await expect(choice).toBeEnabled();
    await expect(choice).not.toBeChecked();
    await expect(pane.getByRole("button")).toHaveCount(0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.responseCapture.pending")), null);
    assert.equal(writes.length, 1);
    await captureSwitchState(page, `${theme}-reply-recovered-current-state`);
    reject = true;
    await choice.click();
    await pane.getByRole("button", { name: "Turn on response saving", exact: true }).click();
    await expect(pane.getByRole("alert")).toContainText("Synthetic source approval changed");
    await expect(choice).toBeEnabled();
    assert.equal(writes.length, 2);
    assert.notEqual(writes[1].mutationRef, writes[0].mutationRef);
    await captureSwitchState(page, `${theme}-reply-rejected`);
    await pane.getByRole("button", { name: "Discard change", exact: true }).click();
    assessment.consent = { ...enabledConsent(), sourceConfigRef: assessment.source.sourceConfigRef, categories: ["answer"] };
    assessment.basis.consentRevision = 1;
    await page.reload();
    await expect(choice).toBeChecked();
    await choice.click();
    await expect(pane.getByText(/Turning this off stops future capture/)).toBeVisible();
    await captureSwitchState(page, `${theme}-reply-off-confirmation`);
    await pane.getByRole("button", { name: "Discard change", exact: true }).click();
    assessment.source.sourceConfigRevision++;
    await page.reload();
    await expect(pane.locator(".assessment-applied")).toContainText("source changed");
    await expect(choice).not.toBeChecked();
    await choice.click();
    await expect(pane.getByText(/Enabling capture for this source removes prior/)).toBeVisible();
    await captureSwitchState(page, `${theme}-reply-renewal-confirmation`);
    await pane.getByRole("button", { name: "Discard change", exact: true }).click();
    assessment.source.available = false;
    await page.reload();
    await expect(choice).toBeDisabled();
    await expect(pane.locator(".assessment-applied")).toContainText("source is unavailable");
    await pane.getByRole("button", { name: "Remove previously saved responses", exact: true }).click();
    await expect(pane.getByRole("button", { name: "Turn off and delete responses", exact: true })).toBeEnabled();
    await captureSwitchState(page, `${theme}-reply-unavailable-revoke`);
    await pane.getByRole("button", { name: "Discard change", exact: true }).click();
    assert.equal(writes.length, 2, "Source states, navigation and cancellation never send a write");
    await page.emulateMedia({ forcedColors: "active" });
    await captureSwitchState(page, `${theme}-reply-forced-colors`);
    await page.emulateMedia({ forcedColors: "none" });
    assessment.consent = defaultConsent();
    assessment.basis.consentRevision = 0;
    await page.reload();
    await expect(choice).toHaveCount(0);
    await expect(page.locator(".settings-reply-fallback")).toBeVisible();
    await expect(pane).toContainText("Connect a supported local Copilot source");
    await captureSwitchState(page, `${theme}-reply-source-needed`);
});

test("Troubleshooting returns to unified Activity without losing scope, private query or selection", async t => {
    const { page } = await setup(t, { nonmatchingRecord: true });
    await page.evaluate(() => { location.hash = "#analyze?project=test-project&layer=tool"; });
    await expect(page.locator("#activityTitle")).toHaveText("Activity");
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(2);
    const query = "SYNTHETIC_PRIVATE_PROMPT";
    await restoreLegacySearch(page, query);
    const selected = page.locator("#activityList .request-card-open");
    await expect(selected).toHaveCount(1);
    await selected.click();
    await page.locator("#requestReportToggle").click();
    await page.locator("#closeContextSidebar").click();
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").open);
    for (const help of ["serviceProvenanceHelp", "authorProvenanceHelp"]) {
        await page.locator('nav [data-nav="settings"]').click();
        await category(page, "troubleshooting");
        await page.locator(`#${help}>summary`).click();
        const link = page.locator("#" + help).getByRole("link", { name: "Open Activity in Analyze", exact: true });
        await link.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator("#activityTitle")).toHaveText("Activity");
        const params = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
        assert.equal(params.get("project"), "test-project");
        assert.equal(params.get("layer"), "tool");
        assert.equal(page.url().includes(query), false, "The private query stays out of the URL");
        await expect(page.locator("#activitySearch")).toHaveValue(query);
        await expect(selected).toHaveCount(1);
        await expect(page.locator("#activityCount")).toHaveText("1");
        await expect(page.locator('#activityList a[href*="request=settings-unmatched"]')).toHaveCount(0);
    }
});
