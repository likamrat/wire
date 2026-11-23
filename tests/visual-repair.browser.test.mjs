import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createProfileSource, profilePNG } from "./source-profile-fixture.mjs";
import { fixture, privateFixture, chooseTheme, navigateSettings, navigateMain, selectActivityOption, revealSavedDataRead } from "./helpers.mjs";
import { openReportLibrary } from "./report-journey-helpers.mjs";

async function setup(t, { reports = false, rosterCount = 0, frontend, hasTouch = false, entry = "#analyze" } = {}) {
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
    runtime = await startServer(context, exports, { port: 0, access, frontend, collector: { timers: false },
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
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", hasTouch });
    const page = await browserContext.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(url => url.origin !== origin, route => route.abort());
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(runtime.url + entry);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#wireAccountTrigger img")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return { page, context, records, roster };
}

for (const hasTouch of [false, true])
test(`footer utilities group closely without sharing hit targets (${hasTouch ? "touch" : "mouse"})`, async t => {
    const { page } = await setup(t, { hasTouch });
    const utilities = page.getByRole("navigation", { name: "Utility navigation" });
    const settings = utilities.getByRole("link", { name: "Settings" });
    await settings.click();
    await expect(settings).toHaveAttribute("aria-current", "page");
    await chooseTheme(page, "light");
    await page.mouse.move(1000, 800);
    const targets = utilities.locator(":scope > :is(a,button)");
    const boxes = await targets.evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect();
        return { label: node.getAttribute("aria-label"), box: box.toJSON(), glyph: node.querySelector("svg").getBoundingClientRect().toJSON(),
            hit: [box.left + 1, box.right - 1].every(x => node.contains(document.elementFromPoint(x, box.top + box.height / 2))) };
    }));
    const dir = process.env.WIRE_FOOTER_PROOFS;
    if (dir && !hasTouch) {
        await mkdir(dir, { recursive: true });
        await page.screenshot({ path: path.join(dir, "screen.png") });
        // Identical viewport coordinates include the edge of the rail in both revisions.
        await page.screenshot({ path: path.join(dir, "footer.png"), clip: { x: 0, y: page.viewportSize().height - 76, width: 320, height: 76 } });
        const boxesFor = await page.evaluate(() => Object.fromEntries(["#sidebar", "#navigationFooter", "#wireAccountTrigger",
            ".wire-account-avatar img", ".wire-account-copy"].map(s => [s, document.querySelector(s).getBoundingClientRect().toJSON()])));
        await writeFile(path.join(dir, "geometry.json"), JSON.stringify({ boxesFor, boxes }, null, 2));
    }
    assert.deepEqual(boxes.map(item => item.label), ["Help", "Feedback", "Settings"]);
    const minimum = hasTouch ? 44 : 32;
    const footprint = boxes.at(-1).box.right - boxes[0].box.left;
    assert.ok(hasTouch || footprint <= 100, `Expanded desktop utilities take ${footprint}px`);
    await page.locator("#wireAccountTrigger").focus();
    for (const [index, { box, hit }] of boxes.entries()) {
        assert.ok(box.width >= minimum && box.height >= 44 && hit);
        if (index) assert.ok(box.left >= boxes[index - 1].box.right);
        await page.keyboard.press("Tab");
        await expect(targets.nth(index)).toBeFocused();
        await expect(targets.nth(index)).toHaveCSS("outline-style", "solid");
        if (dir && !hasTouch && index === 1) await page.screenshot({ path: path.join(dir, "feedback-focus.png") });
    }
});

for (const frontend of ["bundled", "react"])
test(`${frontend}: sidebar feedback prefills the GitHub new issue title and optional description`, async t => {
    const { page } = await setup(t, { frontend });
    const feedback = page.getByRole("button", { name: "Feedback", exact: true });
    const help = page.getByRole("link", { name: "Help", exact: true });
    const panel = page.getByRole("dialog", { name: "Report a bug or suggest a feature" });
    const title = panel.getByRole("textbox", { name: "Title", exact: true });
    const description = panel.getByRole("textbox", { name: "Description (optional)" });
    const openIssue = panel.getByRole("button", { name: "Open on GitHub" });
    const summary = "Remember filters & dates #2";
    const example = "Please keep the filter visible.\nA&B #1 + 👋";
    const opens = [];
    // Fulfill the new tab's navigation locally. No request reaches GitHub.
    await page.context().route(url => url.hostname === "github.com", route => {
        opens.push(route.request());
        return route.fulfill({ contentType: "text/html", body: "<title>Intercepted new issue</title>" });
    });
    await expect(help).toHaveCount(1);
    await expect(page.locator("#navigationFooter #wireAccountTrigger img")).toBeVisible();
    for (const [theme, layout] of [["light", "expanded"], ["dark", "collapsed"], ["dark", "drawer"]]) {
        await chooseTheme(page, theme);
        if (layout === "collapsed") await page.getByRole("button", { name: "Collapse navigation" }).click();
        if (layout === "drawer") {
            await page.setViewportSize({ width: 375, height: 800 });
            await page.locator("#navigationToggle").click();
        }
        await feedback.focus(); await page.keyboard.press("Enter");
        await expect(title).toBeFocused(); await expect(openIssue).toBeDisabled();
        const bounds = await panel.boundingBox(), anchor = await feedback.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1);
        assert.ok(Math.abs(anchor.y - bounds.y - bounds.height - 6) < 2, JSON.stringify({ bounds, anchor }));
        await title.fill("   "); await expect(openIssue).toBeDisabled();
        if (layout === "expanded") await description.fill(example);
        await expect(openIssue).toBeDisabled();
        await title.fill(summary); await expect(openIssue).toBeEnabled();
        if (layout !== "drawer") {
            const [tab] = await Promise.all([page.context().waitForEvent("page"), openIssue.click()]);
            await expect(tab).toHaveTitle("Intercepted new issue");
            const url = new URL(tab.url());
            assert.equal(url.origin + url.pathname, "https://github.com/likamrat/wire/issues/new");
            assert.deepEqual([...url.searchParams], layout === "expanded" ? [["title", summary], ["body", example]] : [["title", summary]]);
            assert.equal(opens.at(-1).method(), "GET"); assert.equal(opens.at(-1).headers().referer, undefined);
            assert.equal(await tab.evaluate(() => window.opener === null), true);
            await tab.close();
            await panel.getByRole("button", { name: "Cancel" }).click();
        } else await page.keyboard.press("Escape");
        await expect(panel).toBeHidden(); await expect(feedback).toBeFocused();
        await page.keyboard.press("Space"); await expect(title).toHaveValue(""); await expect(description).toHaveValue("");
        await page.keyboard.press("Escape"); await expect(feedback).toBeFocused();
        if (layout === "drawer") {
            await expect(page.locator("#navigationDrawer")).toBeVisible();
            await page.keyboard.press("Escape"); await expect(page.locator("#navigationToggle")).toBeFocused();
        }
    }
    assert.equal(opens.length, 2);
});

test("the navigation edge never paints parallel resize lines or leaves a grip after collapse", async t => {
    const { page } = await setup(t, { frontend: "react" });
    const divider = page.locator(".navigation-resize"), collapse = page.locator("#navigationCollapse");
    const rail = page.locator("#sidebar"), dir = process.env.WIRE_SIDEBAR_SEAM_PROOFS;
    if (dir) await mkdir(dir, {recursive: true});
    const read = async state => {
        const r = await rail.boundingBox();
        const clip = {x: Math.round(r.x + r.width) - 14, y: Math.round(r.y + r.height / 2) - 64, width: 30, height: 65};
        const bytes = await page.screenshot({clip, animations:"disabled"});
        if (dir) await page.screenshot({ path: path.join(dir, state + ".png") });
        return page.evaluate(async ({ png }) => {
            const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], {type:"image/png"}));
            const ctx = document.createElement("canvas").getContext("2d");
            ctx.drawImage(bitmap, 0, 0);
            const colors = new Set(["--accent", "--focus"].map(role => {
                ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(role).trim();
                return ctx.fillStyle;
            }));
            // Sample above and through the grip: a full-height outline paints both rows.
            return [0, bitmap.height - 1].map(y => {
                const pixels = ctx.getImageData(0, y, bitmap.width, 1).data;
                let runs = 0, last = false;
                for (let i = 0; i < pixels.length; i += 4) {
                    const ink = colors.has("#" + [...pixels.slice(i, i + 3)].map(v => v.toString(16).padStart(2, "0")).join(""));
                    if (ink && !last) runs++;
                    last = ink;
                }
                return runs;
            });
        }, {png: bytes.toString("base64")});
    };
    for (const [palette, theme] of [["blue", "light"], ["petrol", "light"], ["blue", "dark"]]) {
        await chooseTheme(page, theme);
        await page.evaluate(p => document.documentElement.dataset.evidencePalette = p, palette);
        const edge = {}, record = async state => { edge[state] = await read(`${palette}-${theme}-${state}`); };
        await page.mouse.move(900, 150);
        await record("expanded");
        const handle = await divider.boundingBox(), x = handle.x + handle.width / 2, y = handle.y + 90;
        await page.mouse.move(x, y); await divider.hover(); await record("hover");
        await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x + 45,y,{steps:5}); await record("drag");
        await page.mouse.up(); await page.mouse.move(900,150);
        await record("released");
        const width = await rail.evaluate(n => n.offsetWidth);
        await divider.focus(); await divider.press("ArrowRight"); await page.keyboard.press("ArrowLeft");
        assert.ok(await divider.evaluate(n => n.matches(":focus-visible")));
        await record("keyboard");
        await collapse.press("Enter");
        await expect(divider).toBeHidden();
        await page.waitForFunction(() => !document.getElementById("sidebar").hasAttribute("data-navigation-moving"));
        await record("collapsed");
        await collapse.press("Enter");
        await expect.poll(() => rail.evaluate(n => n.offsetWidth)).toBe(width);
        if (dir) await writeFile(path.join(dir, `${palette}-${theme}.json`), JSON.stringify(edge));
        for (const state of ["expanded","released","collapsed"]) assert.deepEqual(edge[state], [0, 0], `${theme}/${palette}: ${state}`);
        for (const state of ["hover","drag","keyboard"]) assert.deepEqual(edge[state], [0, 1], `${theme}/${palette}: ${state}`);
    }
});

test("the left divider resizes live, remembers the release and leaves the narrow drawer alone", async t => {
    const { page } = await setup(t, { frontend: "react" });
    const divider = page.getByRole("separator", { name: "Navigation width" });
    const rail = page.locator("#sidebar"), collapse = page.locator("#navigationCollapse");
    const width = () => rail.evaluate(node => Math.round(node.getBoundingClientRect().width));
    await expect(divider).toBeVisible({ timeout: 1000 });
    const defaultWidth = await width();
    const handle = await divider.boundingBox(), x = handle.x + handle.width / 2, y = handle.y + 120;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 55, y);
    await expect.poll(width).toBe(defaultWidth + 55);
    await page.keyboard.press("Escape"); await page.mouse.up(); await expect.poll(width).toBe(defaultWidth);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 96, y, { steps: 6 });
    await expect.poll(width).toBe(defaultWidth + 96);
    assert.ok(Math.abs((await page.locator("#main").boundingBox()).x - await width()) <= 1);
    await page.mouse.up();
    await collapse.click(); await expect(divider).toBeHidden();
    await collapse.click(); await expect.poll(width).toBe(defaultWidth + 96);
    await page.reload(); await expect(divider).toHaveAttribute("aria-valuenow", String(defaultWidth + 96));
    const sibling = await page.context().newPage();
    await sibling.goto(page.url());
    const otherDivider = sibling.getByRole("separator", { name: "Navigation width" });
    await expect(otherDivider).toHaveAttribute("aria-valuenow", String(defaultWidth + 96));
    await divider.focus(); await page.keyboard.press("ArrowRight");
    await expect.poll(width).toBe(defaultWidth + 112);
    await expect(otherDivider).toHaveAttribute("aria-valuenow", String(defaultWidth + 112));
    await sibling.close();
    await page.keyboard.press("End"); const wide = await width();
    await page.setViewportSize({ width: 760, height: 900 }); await expect.poll(width).toBeLessThan(wide);
    await page.setViewportSize({ width: 390, height: 900 }); await expect(divider).toBeHidden();
    await page.locator("#navigationToggle").click(); await expect(page.locator("#navigationDrawer")).toBeVisible();
    await expect(divider).toBeHidden(); await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 1000 }); await expect.poll(width).toBe(wide);
    await divider.dblclick(); await expect.poll(width).toBe(defaultWidth);
});

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
    const privacy = page.locator('#settingsCategoryNav [data-category=privacy]'), display = page.locator('#settingsCategoryNav [data-category=themes]');
    await display.hover();
    assert.notEqual(await privacy.evaluate(n => getComputedStyle(n, "::before").content), "none");
    assert.equal(await display.evaluate(n => getComputedStyle(n, "::before").content), "none");
    await display.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    assert.equal(await display.evaluate(n => getComputedStyle(n).outlineStyle), "solid");
    await page.locator('nav [data-nav=reports]').click();
    const title = page.getByRole("button", { name: "View report: Calendar activity", exact: true });
    await expect(title.locator("[data-lucide-icon=file-text]")).toHaveCount(1);
    await openReportLibrary(page);
    const row = page.locator("#bundleList .saved-library-row").filter({ hasText: "Calendar activity" });
    await expect(row.locator(".saved-report-privacy")).toContainText("Detected personal details hidden");
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "150%");
    const layout = await row.evaluate(row => {
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

test("when Compare cannot open, Analyze keeps the accepted filter and results", async t => {
    const { page } = await setup(t, { entry: "?result=failure" });
    const summary = page.locator("#activityListSummary");
    await expect(summary).toHaveText("0 interactions · 0 matching tool calls");
    await page.route("**/api/snapshot", route => route.fulfill({
        status: 503, json: { error: "Invented stored read failure." },
    }), { times: 1 });
    await page.getByRole("link", { name: "Compare", exact: true }).click();
    await expect(page.locator("#message")).toContainText("Invented stored read failure.");
    await expect(page.locator('nav [data-nav=analyze]')).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#outcomeFilter")).toHaveValues(["failure"]);
    await expect(summary).toBeVisible();
    await expect(summary).toHaveText("0 interactions · 0 matching tool calls");
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
