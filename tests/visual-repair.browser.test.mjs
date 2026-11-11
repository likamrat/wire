import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createProfileSource, profilePNG } from "./source-profile-fixture.mjs";
import { fixture, privateFixture, chooseTheme, navigateSettings, navigateMain, selectActivityOption, revealSavedDataRead } from "./helpers.mjs";

async function setup(t, { reports = false, rosterCount = 0 } = {}) {
    const cleanup = [], { root, context } = await privateFixture({ after: work => cleanup.push(work) },
        Array.from({ length: 60 }, (_, index) => {
            const record = fixture("visual-repair-" + index);
            record.capturedAt = new Date(Date.now() - index * 3600000).toISOString();
            record.userPrompt.text = "Find the release checklist and its recorded owner.";
            record.followUpPrompts = [];
            return record;
        }));
    const records = (await loadBoardState(context)).evidence;
    const roster = Array.from({ length: rosterCount }, (_, index) => ({
        sessionId: ["prefix-a12345678", "prefix-b12345678", "test-session"][index] || `invented-roster-${index}`,
        name: index < 2 ? "Repeated" : `Invented roster conversation ${index}`,
        eligible: true, scanned: true, disposition: "included",
    }));
    if (rosterCount) {
        records[0].sourceSessionId = roster[0].sessionId;
        records[1].sourceSessionId = roster[1].sessionId;
        await replaceEvidence(context, () => ({ records, importCoverage: { counts: {}, roster } }));
    }
    const source = await createProfileSource(root);
    const access = await createCopilotRuntimeAccess(context), exports = createExportController(context);
    let runtime, browser;
    t.after(async () => {
        await browser?.close(); await runtime?.close(); await access.close(); source.db.close();
        for (const work of cleanup.reverse()) await work();
    });
    runtime = await startServer(context, exports, { port: 0, access, collector: { timers: false },
        githubProfile: { fetch: async () => new Response(profilePNG, { headers: { "content-type": "image/png" } }) } });
    const origin = new URL(runtime.url).origin;
    const session = await fetch(origin + "/api/session", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" }, body: "{}" }).then(r => r.json());
    const configured = await fetch(origin + "/api/collection/configure", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Board-Capability": session.capability },
        body: JSON.stringify({ appDbPath: source.appDbPath, sessionRoot: source.sessionRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 60 }) });
    assert.equal(configured.status, 200);
    if (reports) {
        const preview = await exports.preview("visual-repair", undefined, { title: "Calendar activity", formats: ["html"], promptMode: "masked" },
            { kind: "all", revision: (await loadBoardState(context)).revision });
        await exports.review("visual-repair", preview.previewId, true);
        await exports.confirm("visual-repair", preview.previewId, true);
    }
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(url => url.origin !== origin, route => route.abort());
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(runtime.url + "#analyze");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#wireAccountTrigger img")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return { page, context, records, roster };
}

test("the loaded avatar keeps its horizontal position at collapse, reversal and settle", async t => {
    const { page } = await setup(t);
    for (const reducedMotion of ["no-preference", "reduce"]) {
        await page.emulateMedia({ reducedMotion });
        const samples = await page.evaluate(async () => {
            const image = document.querySelector("#wireAccountTrigger img"), button = document.getElementById("navigationCollapse");
            const samples = [], sample = () => {
                const avatar = image.getBoundingClientRect(), settings = document.querySelector('nav [data-nav=settings]').getBoundingClientRect();
                samples.push({ x: avatar.x, y: avatar.y, bottom: avatar.bottom, settingsY: settings.y,
                    connected: image === document.querySelector("#wireAccountTrigger img") && image.complete && image.naturalWidth > 0 });
            };
            sample(); button.click(); sample();
            await new Promise(resolve => setTimeout(resolve, 80));
            sample(); button.click(); sample();
            await new Promise(resolve => {
                const frame = () => { sample(); if (document.getElementById("sidebar").hasAttribute("data-navigation-moving")) requestAnimationFrame(frame); else resolve(); };
                requestAnimationFrame(frame);
            });
            button.click();
            await new Promise(resolve => {
                const frame = () => { sample(); if (document.getElementById("sidebar").hasAttribute("data-navigation-moving")) requestAnimationFrame(frame); else resolve(); };
                requestAnimationFrame(frame);
            });
            sample();
            return samples;
        });
        assert.ok(samples.every(s => Math.abs(s.x - samples[0].x) <= 1), JSON.stringify(samples));
        assert.ok(samples.every(s => s.connected));
        assert.ok(samples.at(-1).bottom < samples.at(-1).settingsY, "Collapsed avatar stays above Settings");
        await page.locator("#navigationCollapse").click();
        await page.waitForFunction(() => !document.getElementById("sidebar").hasAttribute("data-navigation-moving"));
    }
});

test("chart grouping, category states and report identity remain readable at enlarged width", async t => {
    const { page } = await setup(t, { reports: true });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const chart = await page.locator(".analyze-chart-main").evaluate(n => ({ bg: getComputedStyle(n).backgroundColor, shadow: getComputedStyle(n).boxShadow }));
        assert.notEqual(chart.bg, "rgba(0, 0, 0, 0)"); assert.equal(chart.shadow, "none");
    }
    await page.locator('nav [data-nav=settings]').click(); await navigateSettings(page, "privacy");
    const privacy = page.locator('#settingsCategoryNav [data-category=privacy]'), display = page.locator('#settingsCategoryNav [data-category=display]');
    await display.hover();
    assert.notEqual(await privacy.evaluate(n => getComputedStyle(n, "::before").content), "none");
    assert.equal(await display.evaluate(n => getComputedStyle(n, "::before").content), "none");
    await display.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    assert.equal(await display.evaluate(n => getComputedStyle(n).outlineStyle), "solid");
    await page.locator('nav [data-nav=reports]').click();
    const title = page.getByRole("button", { name: "View report: Calendar activity", exact: true });
    await expect(title.locator("[data-lucide-icon=file-text]")).toHaveCount(1);
    await expect(page.locator(".saved-report-privacy")).toContainText("Personal details hidden where detected");
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "150%");
    const layout = await page.locator(".saved-library-row").evaluate(row => {
        const label = row.querySelector(".saved-report-name"), name = label.getBoundingClientRect(), period = row.querySelector(".saved-report-period").getBoundingClientRect();
        const wordLines = [...label.textContent.matchAll(/\S+/g)].map(word => {
            const range = document.createRange();
            range.setStart(label.firstChild, word.index); range.setEnd(label.firstChild, word.index + word[0].length);
            return range.getClientRects().length;
        });
        return { wordLines, nameBottom: name.bottom, periodY: period.y };
    });
    assert.ok(layout.wordLines.every(lines => lines === 1), JSON.stringify(layout));
    assert.ok(layout.periodY >= layout.nameBottom, "Period moves below the full-width identity before the name is squeezed");
});

test("destination feedback precedes its snapshot without presenting an unaccepted chart scope", async t => {
    const { page } = await setup(t), started = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/snapshot", async route => { started.resolve(); await release.promise; await route.continue(); });
    await page.locator("#comparePeriods").click(); await started.promise;
    const pending = await page.evaluate(() => ({
        selected: document.getElementById("comparePeriods").getAttribute("aria-current"),
        busy: document.getElementById("workspace").getAttribute("aria-busy"),
        home: document.getElementById("homeView").checkVisibility(),
        notice: document.getElementById("navigationPending")?.textContent,
    }));
    assert.equal(pending.selected, "page");
    assert.equal(pending.busy, "true");
    assert.equal(pending.home, false);
    assert.match(pending.notice, /Compare periods/);
    release.resolve();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(page.locator("#navigationPending")).toBeHidden();
    await page.locator('nav [data-nav=settings]').click();
    await expect(page.locator("#settingsView")).toBeVisible();
});

for (const outcome of ["failure", "superseded"]) test(`pending destination ${outcome} preserves the accepted or newer route`, async t => {
    const { page } = await setup(t), started = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    let held = false;
    await page.route("**/api/snapshot", async route => {
        if (held) return route.continue();
        held = true; started.resolve(); await release.promise;
        if (outcome === "failure") return route.fulfill({ status: 503, contentType: "application/json", json: { error: "Invented stored read failure." } });
        return route.continue();
    });
    await page.locator("#comparePeriods").click(); await started.promise;
    if (outcome === "superseded") {
        await page.locator('nav [data-nav=reports]').click();
        await expect(page.locator("#reportsView")).toBeVisible();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    }
    const response = page.waitForResponse(r => r.url().endsWith("/api/snapshot"));
    release.resolve(); await response;
    if (outcome === "failure") {
        await expect(page.locator("#message")).toContainText("Invented stored read failure.");
        await expect(page.locator('nav [data-nav=analyze]')).toHaveAttribute("aria-current", "page");
        await expect(page.locator("#homeView")).toBeVisible();
    } else {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(page.locator('nav [data-nav=reports]')).toHaveAttribute("aria-current", "page");
        await expect(page.locator("#reportsView")).toBeVisible();
    }
    await expect(page.locator("#navigationPending")).toBeHidden();
});

test("large roster labels preserve every option, selected identity, source updates and withdrawal", { timeout: 60000 }, async t => {
    const { page, context, records, roster } = await setup(t, { rosterCount: 4000 });
    const selectedId = roster[0].sessionId;
    const catalog = () => page.locator("#chatFilter option").evaluateAll(nodes => nodes.map(n => ({ value: n.value, label: n.textContent })));
    const before = await catalog();
    assert.equal(before.length, 4001);
    assert.equal(before.find(n => n.value === selectedId).label, "Repeated (Chat ...a12345678)");
    assert.equal(before.find(n => n.value === roster[1].sessionId).label, "Repeated (Chat ...b12345678)");
    await selectActivityOption(page, "chatFilter", selectedId);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await navigateMain(page, "settings");
    for (const section of ["privacy", "display", "connection"]) {
        await navigateSettings(page, section);
        assert.deepEqual(await catalog(), before);
        await expect(page.locator("#chatFilter")).toHaveValue(selectedId);
    }
    await navigateMain(page, "analyze");
    await expect(page.locator("#pageProject .source-reference")).toHaveText("Chat ...a12345678");
    await page.locator("#activityList .request-card-open").first().click();
    assert.ok((await page.locator("#requestContent .source-reference").allTextContents()).includes("Chat ...a12345678"));
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    const old = await page.locator(`#chatFilter option[value="${selectedId}"]`).elementHandle();
    roster[0].name = "Renamed source";
    await replaceEvidence(context, () => ({ records, importCoverage: { counts: {}, roster } }));
    const read = await revealSavedDataRead(page);
    await read.click();
    await expect(page.locator(`#chatFilter option[value="${selectedId}"]`)).toHaveText("Renamed source");
    await expect(page.locator("#chatFilter")).toHaveValue(selectedId);
    assert.equal(await old.evaluate(n => n.textContent), "");
    const held = await page.locator(`#chatFilter option[value="${selectedId}"]`).elementHandle();
    await page.locator("#wireAccountTrigger").click();
    await page.locator("#wireAccountGate").click();
    await expect(page.locator("#workspace")).toBeHidden();
    assert.equal(await held.evaluate(n => n.textContent), "");
    assert.equal((await catalog()).some(n => n.label.includes("Renamed source") || n.label.includes("Invented roster")), false);
});
