import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isPagePath } from "../../lib/page-path.mjs";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../../lib/render.mjs";
import { buildActivityAnalytics } from "../../lib/activity-analytics.mjs";
import { exportCatalogFor, fixture, selectActivityOption, navigateSettings, automaticScoreOffSummary, openSourceEditor, UNBOUND_FIXTURE_BOOTSTRAP } from "../support/helpers.mjs";

const proofDir = process.env.WORKIQ_SETTINGS_HELP_PROOFS;
const records = [fixture("synthetic-settings-help")];

async function setup(t, approved = true) {
    let status = {
        state: approved ? "collecting-on-interval" : "not-configured", revision: 1, configVersion: 1, connected: approved,
        config: approved ? { approved: true, enabled: true, appDbPath: "C:\\synthetic\\data.db",
            sessionRoot: "C:\\synthetic\\session-state", windowDays: 30, pollSeconds: 5 } : null,
        suggestedSource: { appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state" },
        cadence: { pollSeconds: 5 }, metrics: {},
    };
    const mutations = [], errors = [], rejected = [];
    let release, hold = false, fail = false, reads = 0;
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && isPagePath(req.url.split("?")[0])) {
            res.setHeader("Content-Type", "text/html");
            return res.end(renderHtmlShell("a".repeat(64), "settings-help", UNBOUND_FIXTURE_BOOTSTRAP));
        }
        if (req.method === "GET" && ["/favicon.ico", "/favicon.svg"].includes(req.url?.split("?")[0])) return res.writeHead(204).end();
        let body = ""; for await (const part of req) body += part;
        const input = body ? JSON.parse(body) : {};
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/evaluation/automatic/summary") return res.end(JSON.stringify(automaticScoreOffSummary()));
        if (req.url === "/api/snapshot") return res.end(JSON.stringify({
            revision: 1, scenarios: records, exports: [], exportCatalog: exportCatalogFor(records),
            coverage: { notes: ["Synthetic tooltip proof only."] }, collection: status,
            analytics: { ...buildActivityAnalytics(records, input), revision: 1 },
        }));
        if (req.url === "/api/collection/status") { reads++; return res.end(JSON.stringify(status)); }
        if (["/api/collection/now", "/api/collection/enabled", "/api/collection/configure"].includes(req.url)) {
            mutations.push({ endpoint: req.url, input });
            if (hold) await new Promise(resolve => { release = resolve; });
            if (fail) { fail = false; return res.writeHead(409).end(JSON.stringify({ error: "Synthetic unconfirmed write." })); }
            if (req.url.endsWith("/enabled")) status = { ...status, configVersion: status.configVersion + 1,
                config: { ...status.config, enabled: input.enabled } };
            if (req.url.endsWith("/configure")) status = { ...status, configVersion: status.configVersion + 1,
                connected: true, config: { ...input } };
            if (req.url.endsWith("/now")) return res.end(JSON.stringify({ ...status, check: {
                schemaVersion: 2, id: "synthetic-settings-check", revision: 1, configVersion: status.configVersion, completedAt: new Date().toISOString(),
                outcome: "complete", changes: { added: 0, updated: 0, items: [] }, coverage: {},
            } }));
            return res.end(JSON.stringify(status));
        }
        rejected.push(`${req.method} ${req.url}`);
        res.writeHead(403).end(JSON.stringify({ error: "Only synthetic settings are available." }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (new URL(request.url()).origin !== origin) rejected.push(request.url()); });
    t.after(async () => {
        release?.(); await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(errors, []); assert.deepEqual(rejected, []);
    });
    await page.goto(origin + "/#settings");
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    return { page, mutations, status: () => status, reads: () => reads,
        update: patch => { status = { ...status, ...patch }; },
        hold: () => { hold = true; }, fail: () => { fail = true; },
        release: () => { hold = false; release?.(); },
    };
}

const control = (page, id) => page.locator("#" + (id === "collectNow" ? "checkActivity" : id));
test("benign Settings messages stay with their originating section while uncertain failures remain actionable", { timeout: 30000 }, async t => {
    const state = await setup(t), { page } = state;
    for (const changed of [false, true]) {
        await navigateSettings(page, "connection");
        await openSourceEditor(page);
        // Cancel only exists for a real edit; an untouched source has nothing to discard.
        if (changed) {
            await page.locator("#sourceDatabase").fill("C:\\synthetic\\unsaved-data.db");
            await page.locator("#cancelSource").click();
        }
        assert.equal(await page.locator("#sourceCommit").isVisible(), false);
        assert.equal(await page.locator("#sourceDatabase").inputValue(), state.status().config.appDbPath);
        await navigateSettings(page, "data");
        assert.equal(await page.locator("#settingsMessage").isVisible(), false);
        await navigateSettings(page, "display");
        await page.goBack();
        await page.locator("[data-settings-section=privacy]:visible").waitFor();
        assert.equal(await page.locator("#settingsMessage").isVisible(), false, "Back cannot revive an unrelated discard message");
        await page.goForward();
        await page.locator("[data-settings-section=themes]:visible").waitFor();
        await navigateSettings(page, "data");
        await page.reload();
        await page.locator("#workspace[aria-busy=false]").waitFor();
        assert.equal(await page.locator("#settingsMessage").isVisible(), false, "A fresh Data management page has no stale acknowledgement");
        assert.equal(state.status().config.appDbPath, "C:\\synthetic\\data.db");
    }
    await navigateSettings(page, "collection");
    await selectActivityOption(page, "collectionCadence", "15");
    state.hold();
    await page.locator("#connectCollection").click();
    await page.waitForFunction(() => document.querySelector("#collectionCadence").disabled);
    const second = await page.context().newPage();
    await second.goto(page.url().split("#")[0] + "#settings?section=data");
    await second.locator("#workspace[aria-busy=false]").waitFor();
    await page.locator("#settingsCategoryNav [data-category=privacy]").click();
    assert.equal(await page.locator("[data-settings-section=connection]").isVisible(), true, "A pending write still guards navigation");
    state.release();
    await page.waitForFunction(() => !document.querySelector("#collectionCadence").disabled);
    assert.equal(await second.locator("#settingsMessage").isVisible(), false, "A late callback belongs to its originating panel, not an already-open Data management page");
    await second.close();
    await navigateSettings(page, "data");
    assert.equal(await page.locator("#settingsMessage").isVisible(), false, "A preference success cannot follow navigation to Data management");
    assert.equal(state.status().config.pollSeconds, 15);
    await navigateSettings(page, "collection");
    await selectActivityOption(page, "collectionCadence", "30");
    await page.locator("#cancelSource").click();
    assert.equal(await page.locator("#collectionCadence").inputValue(), "15");
    await navigateSettings(page, "data");
    assert.equal(await page.locator("#settingsMessage").isVisible(), false);
    await navigateSettings(page, "collection");
    await selectActivityOption(page, "collectionCadence", "30");
    state.fail();
    await page.locator("#connectCollection").click();
    await page.locator("#reloadSettings").waitFor();
    await navigateSettings(page, "data");
    assert.equal(await page.locator("#settingsMessage").isVisible(), true);
    assert.match(await page.locator("#settingsMessage").textContent(), /Synthetic unconfirmed write.*Change unconfirmed/);
    assert.equal(await page.locator("#reloadSettings").isVisible(), true);
    assert.equal(state.mutations.length, 2, "Navigation and cancellation never repeat either explicit write");
});

async function target(page, id) {
    const button = control(page, id);
    return await button.isDisabled() ? button.locator("..") : button;
}
async function tooltip(page, id, text, mode = "hover") {
    const category = await control(page, id).evaluate(node => node.closest("[data-settings-section]")?.dataset.settingsSection);
    if (category && !await control(page, id).isVisible()) await navigateSettings(page, category);
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.activeElement.blur());
    await page.mouse.move(0, 0);
    const trigger = await target(page, id);
    if (mode === "hover") await trigger.hover();
    else {
        // Enter through real sequential keyboard navigation, including native-disabled actions.
        await trigger.evaluate(node => {
            const sentinel = document.createElement("span"); sentinel.id = "settings-help-tab-start";
            sentinel.tabIndex = -1; node.before(sentinel); sentinel.focus();
        });
        await page.keyboard.press("Tab");
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
        await page.locator("#settings-help-tab-start").evaluate(node => node.remove());
    }
    const bubble = page.getByRole("tooltip");
    await bubble.waitFor({ state: "visible" });
    assert.equal(await bubble.innerText(), text, `${id}/${mode}`);
    assert.equal(await page.locator("#evidence-tooltip").count(), 1);
    assert.equal(await trigger.getAttribute("aria-describedby"), "evidence-tooltip");
    assert.equal(await control(page, id).getAttribute("title"), null);
    assert.equal(await trigger.locator("button button, .ux-help").count(), 0, "No nested action or extra info-button tabstop");
    if (await control(page, id).isDisabled()) {
        assert.equal(await trigger.getAttribute("role"), "group");
        assert.equal(await trigger.getAttribute("aria-label"), await control(page, id).innerText());
        assert.equal(await trigger.getAttribute("tabindex"), "0");
    } else assert.equal(await control(page, id).locator("..").getAttribute("tabindex"), "-1");
    return trigger;
}
async function dismiss(page, trigger) {
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    assert.equal(await trigger.getAttribute("aria-describedby"), null);
}
async function saved(page) {
    await page.waitForFunction(() => !document.querySelector("#collectionCadence").disabled);
}
test("disabled collection actions explain the actual hold without authorizing any work", async t => {
    const state = await setup(t), { page, mutations } = state;
    await selectActivityOption(page, "collectionCadence", "15");
    for (const mode of ["hover", "keyboard"]) {
        const trigger = await tooltip(page, "pauseCollection", "Save or cancel your changes first.", mode);
        await page.getByRole("tooltip").hover();
        assert.equal(await page.getByRole("tooltip").isVisible(), true);
        await dismiss(page, trigger);
    }
    assert.deepEqual(mutations, []);
    state.hold();
    await page.locator("#connectCollection").click();
    await tooltip(page, "pauseCollection", "Saving...", "keyboard");
    state.release(); await saved(page);
    assert.equal(state.status().config.pollSeconds, 15);
    assert.deepEqual(mutations.map(row => row.endpoint), ["/api/collection/configure"]);
});

test("a source draft with a missing path explains why approval is unavailable", async t => {
    const { page, mutations, status } = await setup(t, false);
    await navigateSettings(page, "connection");
    await page.locator("#sourceSessions").fill("");
    await tooltip(page, "connectCollection", "Enter both source paths.", "keyboard");
    assert.deepEqual(mutations, []);
    assert.equal(status().config, null);
});
