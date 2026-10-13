import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { chooseTheme, exportCatalogFor, fixture, selectActivityOption, navigateSettings, automaticScoreOffSummary, openSourceEditor } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofDir = process.env.WORKIQ_SETTINGS_HELP_PROOFS;
const copy = {
    editSource: "Open the source editor without changing the approved source.",
    pauseCollection: "Pause future local collection without removing retained evidence.",
    resume: "Resume local collection from the previously approved source.",
    collectNow: "Refresh stored activity and check approved local history. Paused collection stays paused; before approval only stored data is read.",
    reviewSource: "Open the local source paths for review before granting permission.",
    connectCollection: "Approve these local paths and start collection with the chosen preferences.",
    switchSource: "Validate and approve these paths, then collect from the replacement source.",
    switchPaused: "Validate and approve these paths while keeping collection paused.",
    cancelSource: "Discard these source edits without changing the current connection.",
    saveCollection: "Save history and cadence preferences, keeping the approved source and pause state.",
    cancelPreferences: "Discard preference edits and load the current connection settings.",
    reloadSettings: "Read the current connection without replaying the previous action.",
};
const progress = "A local check is in progress; wait for it to finish.";
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
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html");
            return res.end(renderHtmlShell("a".repeat(64), "settings-help"));
        }
        if (req.method === "GET" && ["/favicon.ico", "/favicon.svg"].includes(req.url)) return res.writeHead(204).end();
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
    if (proofDir) await mkdir(proofDir, { recursive: true });
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
        if (changed) await page.locator("#sourceDatabase").fill("C:\\synthetic\\unsaved-data.db");
        await page.locator("#cancelSource").click();
        if (changed) assert.match(await page.locator("#settingsMessage").textContent(), /^Source edits discarded/);
        else assert.equal(await page.locator("#settingsMessage").isVisible(), false, "Closing an unchanged editor needs no cancellation notice");
        await navigateSettings(page, "data");
        assert.equal(await page.locator("#settingsMessage").isVisible(), false);
        await navigateSettings(page, "display");
        await page.goBack();
        await page.locator("[data-settings-section=privacy]:visible").waitFor();
        assert.equal(await page.locator("#settingsMessage").isVisible(), false, "Back cannot revive an unrelated discard message");
        await page.goForward();
        await page.locator("[data-settings-section=display]:visible").waitFor();
        await navigateSettings(page, "data");
        await page.reload();
        await page.locator("#workspace[aria-busy=false]").waitFor();
        assert.equal(await page.locator("#settingsMessage").isVisible(), false, "A fresh Data management page has no stale acknowledgement");
        assert.equal(state.status().config.appDbPath, "C:\\synthetic\\data.db");
    }
    await navigateSettings(page, "collection");
    await selectActivityOption(page, "collectionCadence", "15");
    state.hold();
    await page.locator("#saveCollection").click();
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
    await page.locator("#cancelPreferences").click();
    assert.match(await page.locator("#settingsMessage").textContent(), /Preference edits discarded.*Saved collection settings are unchanged/);
    await navigateSettings(page, "data");
    assert.equal(await page.locator("#settingsMessage").isVisible(), false);
    await navigateSettings(page, "collection");
    await selectActivityOption(page, "collectionCadence", "30");
    state.fail();
    await page.locator("#saveCollection").click();
    await page.locator("#reloadSettings").waitFor();
    await navigateSettings(page, "data");
    assert.equal(await page.locator("#settingsMessage").isVisible(), true);
    assert.match(await page.locator("#settingsMessage").textContent(), /Synthetic unconfirmed write.*No success is assumed/);
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
    if (id === "editSource" && await page.locator("#viewApprovedSource").isVisible()) await page.locator("#viewApprovedSource").click();
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
    assert.equal(await trigger.getAttribute("aria-describedby"), id === "collectNow" && !await control(page, id).isDisabled() ? "freshScope evidence-tooltip" : "evidence-tooltip");
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
    assert.equal(await trigger.getAttribute("aria-describedby"), await trigger.getAttribute("id") === "checkActivity" ? "freshScope" : null);
}
async function saved(page) {
    await page.waitForFunction(() => !document.querySelector("#collectionCadence").disabled);
}
async function geometry(page) {
    await page.evaluate(() => document.fonts.ready);
    return page.locator("#approvedConnection .settings-actions button").evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node), range = document.createRange();
        range.selectNodeContents(node);
        const text = range.getBoundingClientRect(), canvas = document.createElement("canvas").getContext("2d");
        canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const metrics = canvas.measureText(node.textContent);
        return { id: node.id, text: node.textContent, disabled: node.disabled,
            top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height, center: box.top + box.height / 2,
            textCenter: text.top + text.height / 2, baseline: text.bottom - metrics.fontBoundingBoxDescent,
            lineHeight: style.lineHeight, padding: style.padding, border: style.borderWidth };
    }));
}
function assertActionRows(buttons, width, context) {
    for (const [index, box] of buttons.entries()) {
        assert.ok(box.height >= 44, `${context}: actual action target`);
        assert.ok(box.left >= 0 && box.right <= width + 1, `${context}: action fits viewport`);
        for (const other of buttons.slice(index + 1)) {
            if (Math.abs(box.top - other.top) <= 1) {
                for (const key of ["bottom", "height", "center", "textCenter", "baseline"]) {
                    assert.ok(Math.abs(box[key] - other[key]) <= 1, `${context}/${key}: same-row actions align`);
                }
                assert.ok(other.left - box.right >= 7, `${context}: horizontal action gap`);
            } else assert.ok(other.top - box.bottom >= 7, `${context}: wrapped actions form a distinct row`);
        }
    }
}

test("collection actions explain consequences on hover and Tab without writes; Escape, hoverability and polling stay stable", { timeout: 45000 }, async t => {
    const { page, mutations, reads } = await setup(t);
    for (const mode of ["hover", "keyboard"]) for (const id of ["editSource", "pauseCollection", "collectNow"]) {
        const trigger = await tooltip(page, id, copy[id], mode);
        await dismiss(page, trigger);
    }
    const change = await tooltip(page, "editSource", copy.editSource);
    await page.getByRole("tooltip").hover(); await page.waitForTimeout(200);
    assert.equal(await page.getByRole("tooltip").isVisible(), true, "Help is hoverable");
    await page.mouse.move(0, 0); await page.getByRole("tooltip").waitFor({ state: "hidden" });
    await change.hover(); await page.getByRole("tooltip").waitFor({ state: "visible" });
    const focused = await tooltip(page, "pauseCollection", copy.pauseCollection, "keyboard");
    const handle = await focused.elementHandle(), count = reads();
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"), { timeout: 10000 });
    assert.ok(reads() > count);
    assert.equal(await handle.evaluate(node => node === document.activeElement && node.isConnected), true);
    assert.equal(await page.getByRole("tooltip").innerText(), copy.pauseCollection);
    assert.equal(await page.locator('[aria-describedby~="evidence-tooltip"]').count(), 1);
    await dismiss(page, focused);
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"), { timeout: 10000 });
    assert.equal(await page.getByRole("tooltip").isVisible(), false, "Polling does not reopen dismissed help");
    await tooltip(page, "collectNow", copy.collectNow);
    await chooseTheme(page, "dark");
    await tooltip(page, "collectNow", copy.collectNow, "keyboard");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
        document.activeElement.blur();
        document.querySelector("#editSource").setAttribute("aria-describedby", "connectionStatus");
    });
    await control(page, "editSource").focus();
    assert.equal(await control(page, "editSource").getAttribute("aria-describedby"), "connectionStatus evidence-tooltip");
    await page.keyboard.press("Escape");
    assert.equal(await control(page, "editSource").getAttribute("aria-describedby"), "connectionStatus");
    await control(page, "editSource").evaluate(node => node.removeAttribute("aria-describedby"));
    await tooltip(page, "editSource", copy.editSource, "keyboard");
    await page.evaluate(() => { location.hash = "home"; });
    await page.getByRole("tooltip").waitFor({ state: "hidden" });
    assert.equal(await page.locator('[aria-describedby~="evidence-tooltip"]').count(), 0);
    assert.deepEqual(mutations, []);
});

test("disabled and pending collection actions have one reachable explanation, and paused/source-review variants remain accurate", { timeout: 50000 }, async t => {
    const state = await setup(t), { page, mutations } = state;
    await selectActivityOption(page, "collectionCadence", "15");
    const disabled = await tooltip(page, "collectNow", "Save or cancel your Settings edits before refreshing.", "keyboard");
    const before = mutations.length;
    await page.keyboard.press("Enter"); await page.keyboard.press("Space");
    assert.equal(mutations.length, before);
    assert.equal(await control(page, "collectNow").isDisabled(), true);
    assert.equal(await disabled.locator("button").count(), 1);
    await tooltip(page, "saveCollection", copy.saveCollection);
    await tooltip(page, "cancelPreferences", copy.cancelPreferences, "keyboard");
    await control(page, "cancelPreferences").click();
    await tooltip(page, "saveCollection", "Change a preference before saving.", "keyboard");
    await tooltip(page, "cancelPreferences", "There are no preference changes to cancel.", "keyboard");
    await navigateSettings(page, "connection");
    await control(page, "pauseCollection").click(); await saved(page);
    await tooltip(page, "pauseCollection", copy.resume, "keyboard");
    await tooltip(page, "collectNow", copy.collectNow);
    await control(page, "editSource").click();
    await tooltip(page, "collectNow", "Save or cancel your Settings edits before refreshing.", "keyboard");
    await tooltip(page, "connectCollection", "Change a source path before approving a replacement.", "keyboard");
    await control(page, "sourceDatabase").fill("");
    await tooltip(page, "connectCollection", "Enter both local source paths before approving.", "keyboard");
    await control(page, "sourceDatabase").fill("C:\\synthetic-replacement\\data.db");
    await tooltip(page, "connectCollection", copy.switchPaused);
    await tooltip(page, "cancelSource", copy.cancelSource, "keyboard");
    await control(page, "cancelSource").click();
    await control(page, "pauseCollection").click(); await saved(page);
    await control(page, "editSource").click();
    await control(page, "sourceDatabase").fill("C:\\synthetic-replacement\\data.db");
    await tooltip(page, "connectCollection", copy.switchSource, "keyboard");
    await control(page, "cancelSource").click();
    state.hold();
    await control(page, "collectNow").click();
    await page.waitForFunction(() => document.querySelector("#collectNow").disabled);
    for (const id of ["editSource", "pauseCollection", "collectNow"]) {
        const pendingHelp = id === "collectNow" ? "Wait for the current activity update to finish." : progress;
        await tooltip(page, id, pendingHelp, "hover");
        await tooltip(page, id, pendingHelp, "keyboard");
    }
    const pendingCount = mutations.length;
    await page.keyboard.press("Enter"); await page.keyboard.press("Space");
    assert.equal(mutations.length, pendingCount);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const boxes = await geometry(page);
        assertActionRows(boxes, page.viewportSize().width, `Pending ${theme}`);
    }
    state.release(); await saved(page);
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "complete");
    await tooltip(page, "collectNow", copy.collectNow, "keyboard");
    assert.deepEqual(mutations.map(row => row.endpoint), ["/api/collection/enabled", "/api/collection/enabled", "/api/collection/now"]);
});

test("first approval, stale settings and uncertain-response help never imply automatic permission or replay", { timeout: 40000 }, async t => {
    const state = await setup(t, false), { page, mutations } = state;
    await tooltip(page, "reviewSource", copy.reviewSource, "keyboard");
    await control(page, "reviewSource").click();
    await tooltip(page, "connectCollection", copy.connectCollection, "keyboard");
    assert.deepEqual(mutations, []);
    await control(page, "connectCollection").click(); await saved(page);
    await selectActivityOption(page, "collectionCadence", "15");
    state.update({ configVersion: 2 + state.status().configVersion });
    await page.waitForFunction(() => document.querySelector("#settingsDraftStatus").textContent.includes("another panel"));
    await tooltip(page, "saveCollection", "Cancel your edits to load the connection changed in another panel.", "keyboard");
    await control(page, "cancelPreferences").click();
    state.fail();
    await navigateSettings(page, "connection");
    await control(page, "collectNow").click();
    await page.locator("#refreshBtn").waitFor();
    assert.match(await page.locator("#freshContextMessage").innerText(), /Source check outcome unknown/);
    assert.equal(await control(page, "reloadSettings").isVisible(), false, "A source check is not a settings write");
    const count = mutations.length;
    await page.locator("#refreshBtn").click();
    await page.waitForFunction(() => document.querySelector("#freshActivity").dataset.phase === "unconfirmed");
    assert.match(await page.locator("#freshStatus").innerText(), /source check unconfirmed/);
    assert.equal(mutations.length, count);
});

test("painted collection pills and tooltip geometry stay aligned across themes, widths, text sizes and states", { timeout: 120000 }, async t => {
    const { page, mutations } = await setup(t), proof = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) for (const scale of [100, 200]) {
        await page.setViewportSize({ width, height: 1100 });
        await chooseTheme(page, theme);
        await page.evaluate(value => { document.documentElement.style.fontSize = value + "%"; }, scale);
        for (const variant of ["active", "paused", "draft"]) {
            if (variant === "paused") { await control(page, "pauseCollection").click(); await saved(page); }
            if (variant === "draft") await selectActivityOption(page, "collectionCadence", "15");
            await navigateSettings(page, "connection");
            await control(page, "editSource").scrollIntoViewIfNeeded();
            const buttons = await geometry(page);
            assertActionRows(buttons, width, `${theme}/${width}/${scale}`);
            for (const id of ["editSource", "pauseCollection", "collectNow"]) {
                const expected = variant === "draft" ? id === "collectNow" ? "Save or cancel your Settings edits before refreshing." : "Save or cancel your preference changes first."
                    : id === "pauseCollection" && variant === "paused" ? copy.resume : copy[id];
                const trigger = await tooltip(page, id, expected, "keyboard");
                const tip = await page.getByRole("tooltip").evaluate(node => {
                    const b = node.getBoundingClientRect(), s = getComputedStyle(node);
                    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, color: s.color, background: s.backgroundColor,
                        overflowX: node.scrollWidth - node.clientWidth, overflowY: node.scrollHeight - node.clientHeight };
                });
                assert.ok(tip.left >= 7 && tip.right <= width - 7 && tip.top >= 7 && tip.bottom <= 1093);
                assert.ok(tip.overflowX <= 1 && tip.overflowY <= 1);
                assert.ok(contrast(tip.color, tip.background) >= 4.5);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                proof.push({ theme, width, scale, variant, id, buttons, tooltip: tip });
                if (proofDir && id === "collectNow" && variant === "active") await page.screenshot({ path: path.join(proofDir, `collection-help-${theme}-${width}-${scale}.png`) });
                await dismiss(page, trigger);
            }
        }
        await navigateSettings(page, "collection");
        await control(page, "cancelPreferences").click();
        await navigateSettings(page, "connection");
        await control(page, "pauseCollection").click(); await saved(page);
    }
    assert.ok(mutations.every(row => row.endpoint === "/api/collection/enabled"));
    if (proofDir) await writeFile(path.join(proofDir, "collection-help-measurements.json"), JSON.stringify(proof, null, 2));
});
