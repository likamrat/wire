import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { FAVICON_PATH, logoSvg } from "../lib/branding.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createCopilotAccountBridge } from "../lib/copilot-account-snapshot.mjs";
import { scopeRecords } from "./analysis-scope-fixture.mjs";
import { profilePNG } from "./source-profile-fixture.mjs";
import { contrast } from "./color-measurements.mjs";
import { lucideIcon } from "../web/ux-icons.mjs";

const proofs = process.env.WIRE_BRAND_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const settled = page => page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving")
    && !document.querySelector("#navigationDrawer").getAnimations().length);

async function brandFixture(t, options = {}) {
    const records = scopeRecords().slice(0, 10);
    for (const [index, record] of records.entries()) {
        record.sourceSessionName = "Cedar release planning";
        record.userPrompt.text = `Find the Cedar release ${index + 1} checklist, calendar milestones and open questions.`;
        record.capturedAt = new Date(Date.now() - index * 3600000).toISOString();
        record.userPrompt.sourceTimestamp = record.capturedAt;
        for (const call of record.toolCalls) {
            call.startedAt = record.capturedAt;
            call.completedAt = new Date(Date.parse(record.capturedAt) + call.durationMs).toISOString();
        }
    }
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, records);
    const access = await createCopilotRuntimeAccess(context);
    const host = { sessionId: "invented-brand-host", rpc: {
        accounts: { get: async () => ({ kind: "activeAccount",
            account: { active: true, kind: "githubDotCom", host: "github.com", login: "synthetic-riley", selectionId: "cedar-profile" },
            authInfo: { type: "user", host: "github.com", login: "synthetic-riley" } }) },
        gitHubAuth: { getStatus: async () => ({ isAuthenticated: true, authType: "user", host: "github.com", login: "synthetic-riley" }) },
    } };
    const bridge = createCopilotAccountBridge(() => host, { expectedSessionId: host.sessionId, binding: "copilot-app" });
    const before = await loadBoardState(context), errors = [], denied = [];
    let runtime, browser;
    t.after(async () => {
        try {
            await browser?.close(); await runtime?.close(); bridge.close(); await access.close();
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const work of cleanup.reverse()) await work(); }
    });
    runtime = await startServer(context, createExportController(context), {
        port: 0, access, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { throw new Error("Providers are blocked in brand proof"); },
            readSource: async () => { throw new Error("Source reads are blocked in brand proof"); },
        },
        githubProfile: { copilot: bridge.copilot, fetch: async url => url.startsWith("https://api.github.com/")
            ? Response.json({ type: "User", id: 70001, login: "synthetic-riley", name: "Riley Chen",
                avatar_url: "https://avatars.githubusercontent.com/u/70001" })
            : new Response(profilePNG, { headers: { "content-type": "image/png" } }) },
    });
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light", ...options });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    const reads = ["/api/session", "/api/access/watch", "/api/snapshot", "/api/collection/status", "/api/assessment/overview",
        "/api/assessment/detail", "/api/evaluation/automatic/summary", "/api/report-artifacts/list", "/api/collection/sources/status", "/api/trends"];
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(runtime.url); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator("#wireAccountTrigger img")).toBeVisible();
    await expect(page.locator("#wireAccountTrigger")).toContainText("Riley Chen");
    return page;
}

async function captureBrand(page, name, data) {
    if (!proofs) return;
    await page.screenshot({ path: path.join(proofs, name + ".png") });
    if (data) await writeFile(path.join(proofs, name + ".json"), JSON.stringify(data, null, 2));
}

test("brand help and adjacent panel control share the normal tooltip owner across themes and layouts", { timeout: 90000 }, async t => {
    const page = await brandFixture(t);
    const brand = page.locator("#shellBrand .brand-home"), toggle = page.locator("#navigationCollapse"), tip = page.getByRole("tooltip");
    const brandNode = await brand.elementHandle(), toggleNode = await toggle.elementHandle();
    for (const [theme, width, scale] of [["light", 1440, 1], ["dark", 940, 1], ["light", 700, 2], ["dark", 390, 1], ["light", 390, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale * 100 + "%"; }, scale);
        await chooseTheme(page, theme);
        if (width < 700) { await page.locator("#navigationToggle").click(); await settled(page); }
        for (const compact of width < 700 ? [false] : [false, true]) {
            if (width >= 700 && await toggle.getAttribute("aria-expanded") === String(compact)) { await toggle.click(); await settled(page); }
            await page.mouse.move(width - 5, 800);
            await brand.hover();
            await expect(tip).toHaveText("WorkIQ Request Explorer"); await expect(tip).toBeVisible();
            const geometry = await brand.evaluate(node => {
                const tip = document.querySelector("#evidence-tooltip"), b = node.getBoundingClientRect(), r = tip.getBoundingClientRect();
                const c = document.querySelector("#navigationCollapse"), control = c.getBoundingClientRect(), style = getComputedStyle(tip);
                const obscured = [...document.querySelectorAll("#shellBrand a,#navigationCollapse,#navigationContent a,#wireSearch,#themePreference,#closeNavigation,#openChartReference,#openAnalyzeFilters,#refreshBtn")]
                    .filter(target => target.checkVisibility() && (!document.querySelector("#navigationDrawer").open || target.closest("#navigationDrawer"))).filter(target => {
                        const box = target.getBoundingClientRect();
                        return r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
                    }).map(target => target.id || target.getAttribute("href"));
                return { brand: b.toJSON(), tip: r.toJSON(), control: control.toJSON(), controlVisible: c.checkVisibility(), obscured,
                    foreground: style.color, background: style.backgroundColor, viewport: innerWidth,
                    overflow: document.documentElement.scrollWidth - innerWidth };
            });
            assert.ok(geometry.tip.x >= 0 && geometry.tip.right <= width && geometry.tip.bottom <= 1000);
            assert.deepEqual(geometry.obscured, [], "Help never covers the home link, navigation or header controls");
            assert.ok(contrast(geometry.foreground, geometry.background) >= 4.5);
            assert.ok(geometry.overflow <= 1);
            await expect(brand).toHaveAccessibleName("WIRE - Work IQ Request Explorer - Analyze");
            await expect(brand).toHaveAccessibleDescription("WorkIQ Request Explorer");
            await expect(brand.locator("button,a")).toHaveCount(0);
            await captureBrand(page, `brand-help-${theme}-${width}-${scale}x-${compact ? "compact" : "expanded"}`, geometry);
            await tip.hover(); await expect(tip).toBeVisible();
            await page.keyboard.press("Escape"); await expect(tip).toBeHidden();
            await page.mouse.move(width - 5, 800);
            await page.locator(width < 700 ? "#closeNavigation" : "#themePreference").focus();
            await brand.focus(); await page.keyboard.press("Shift");
            await expect(tip).toHaveText("WorkIQ Request Explorer"); await expect(brand).toBeFocused();
            await page.keyboard.press("Escape"); await expect(tip).toBeHidden(); await expect(brand).toBeFocused();
            await brand.press("Enter"); await ready(page); await expect(tip).toBeHidden();
            await expect(page.locator('nav [data-nav="analyze"]')).toHaveAttribute("aria-current", "page");
            if (width < 700) {
                await expect(page.locator("#navigationDrawer")).toBeHidden();
                await page.locator("#navigationToggle").click(); await settled(page);
                await expect(toggle).toBeHidden();
                continue;
            }
            const metrics = await toggle.evaluate(node => {
                const box = node.getBoundingClientRect(), glyph = node.querySelector("svg"), g = glyph.getBoundingClientRect();
                const home = document.querySelector(".brand-home").getBoundingClientRect();
                const first = document.querySelector("#sidebar .primary-navigation a").getBoundingClientRect();
                return { box: box.toJSON(), glyph: g.toJSON(), home: home.toJSON(), geometry: glyph.innerHTML,
                    name: glyph.dataset.lucideIcon, gap: first.y - document.querySelector("#sidebar").getBoundingClientRect().y,
                    hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("button") === node };
            });
            assert.equal(metrics.name, "panel-left");
            const official = await page.evaluate(svg => new DOMParser().parseFromString(svg, "text/html").querySelector("svg").innerHTML, lucideIcon("panel-left"));
            assert.equal(metrics.geometry, official);
            assert.equal(metrics.glyph.width, 20); assert.equal(metrics.glyph.height, 20);
            assert.equal(metrics.box.width, 44); assert.equal(metrics.box.height, 44);
            assert.equal(metrics.box.y, metrics.home.y); assert.ok(metrics.box.x >= metrics.home.right + 4);
            assert.equal(metrics.glyph.x + 10, metrics.box.x + 22); assert.equal(metrics.glyph.y + 10, metrics.box.y + 22);
            assert.equal(metrics.gap, 12, "Removing the old collapse row leaves only the rail's normal top inset");
            assert.equal(metrics.hit, true, "The compact target cannot be covered by the toolbar");
            await toggle.hover(); await expect(tip).toHaveText(compact ? "Expand navigation" : "Collapse navigation");
            const hover = await toggle.evaluate(node => getComputedStyle(node).backgroundColor);
            assert.notEqual(hover, "rgba(0, 0, 0, 0)");
            await page.keyboard.press("Escape");
            await toggle.focus(); await page.keyboard.press("Shift");
            await expect(toggle).toBeFocused();
            assert.equal(await toggle.evaluate(node => node.matches(":focus-visible") && parseFloat(getComputedStyle(node).outlineWidth) >= 2), true);
            await captureBrand(page, `panel-control-${theme}-${width}-${scale}x-${compact ? "compact" : "expanded"}`, metrics);
            await toggle.press("Enter"); await settled(page);
            await expect(toggle).toBeFocused();
            await expect(toggle).toHaveAccessibleName(compact ? "Collapse navigation" : "Expand navigation");
            await toggle.press("Enter"); await settled(page);
        }
        if (width < 700) {
            await page.keyboard.press("Escape"); await expect(page.locator("#navigationDrawer")).toBeHidden();
            await expect(page.locator("#navigationToggle")).toBeFocused();
        }
    }
    assert.equal(await brandNode.evaluate(node => node === document.querySelector(".brand-home")), true);
    assert.equal(await toggleNode.evaluate(node => node === document.querySelector("#navigationCollapse")), true);
});

for (const reducedMotion of [null, "reduce", "no-preference"])
test(`brand header and mounted avatar stay registered through real sidebar reversal (${reducedMotion ?? "native"})`, { timeout: 45000 }, async t => {
    const page = await brandFixture(t, { reducedMotion });
    const nativeReduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    const traces = [];
    for (const [width, height] of [[1440, 1000], [940, 1200]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.locator("#navigationCollapse").focus();
        const trace = await page.evaluate(async () => {
            const rail = document.querySelector("#sidebar"), toggle = document.querySelector("#navigationCollapse");
            const home = document.querySelector(".brand-home"), avatar = document.querySelector("#wireAccountTrigger img");
            const samples = [], frame = () => new Promise(resolve => requestAnimationFrame(resolve));
            const rect = node => node.getBoundingClientRect().toJSON();
            let phase = "initial";
            function sample() {
                const layers = [...home.querySelectorAll("svg")].filter(node => getComputedStyle(node).display !== "none");
                samples.push({ phase, at: performance.now(), width: rect(rail).width, header: rect(document.querySelector(".app-header")),
                    mainY: rect(document.querySelector("#main")).y, home: rect(home), control: rect(toggle), avatar: rect(avatar), scrollY,
                    sameHome: home === document.querySelector(".brand-home"), sameAvatar: avatar === document.querySelector("#wireAccountTrigger img"),
                    focus: document.activeElement === toggle, imageSource: avatar.getAttribute("src"),
                    layers: layers.map(node => { const m = node.getScreenCTM(); return { a: m.a, e: m.e, f: m.f, opacity: +getComputedStyle(node).opacity }; }) });
            }
            async function advance(count = 120) {
                for (let i = 0; i < count; i++) {
                    await frame(); sample();
                    if (count === 120 && i > 1 && !rail.hasAttribute("data-navigation-moving")) return;
                }
                if (count === 120) throw new Error("Navigation did not settle");
            }
            sample();
            for (let cycle = 0; cycle < 3; cycle++) for (const action of ["collapse", "expand"]) {
                phase = `${action}-${cycle}`; toggle.click(); await advance();
            }
            phase = "collapse-reversal"; toggle.click(); await advance(4);
            phase = "expand-reversal"; toggle.click(); await advance(3);
            phase = "collapse-again"; toggle.click(); await advance();
            phase = "final-expand"; toggle.click(); await advance();
            return samples;
        });
        const span = read => Math.max(...trace.map(read)) - Math.min(...trace.map(read));
        assert.ok(span(row => row.header.height) < 1); assert.ok(span(row => row.mainY) < 1);
        assert.ok(span(row => row.home.y) < 1); assert.ok(span(row => row.control.y) < 1);
        assert.ok(span(row => row.avatar.x) < 1, "The mounted avatar stays on its horizontal anchor");
        assert.equal(span(row => row.scrollY), 0);
        assert.ok(trace.every(row => row.sameHome && row.sameAvatar && row.focus));
        assert.equal(new Set(trace.map(row => row.imageSource)).size, 1, "The selected profile image is not reloaded or reassociated");
        for (const row of trace) {
            const visible = row.layers.filter(layer => layer.opacity > .01);
            if (visible.length === 2) {
                assert.ok(Math.abs(visible[0].a - visible[1].a) < .001);
                assert.ok(Math.abs(visible[0].e - visible[1].e) < 1 && Math.abs(visible[0].f - visible[1].f) < 1,
                    "The full and compact symbol paint share one path during the crossfade");
            }
        }
        for (const phase of new Set(trace.map(row => row.phase).filter(phase => phase !== "initial"))) {
            const frames = trace.filter(row => row.phase === phase);
            assert.ok(new Set(frames.map(row => Math.round(row.width))).size >= 2, `${phase}: real intermediate frames`);
            const direction = phase.startsWith("collapse") ? -1 : 1;
            for (let i = 1; i < frames.length; i++) {
                assert.ok(direction * (frames[i].width - frames[i - 1].width) >= -.5, `${phase}: width never bounces`);
                assert.ok(direction * (frames[i].avatar.y - frames[i - 1].avatar.y) >= -.5, `${phase}: avatar travels once between footer rows`);
            }
        }
        traces.push({ width, height, nativeReduced, trace });
    }
    for (const destination of ["trends", "reports", "settings", "analyze"]) {
        await page.locator(`nav [data-nav="${destination}"]`).click(); await ready(page);
        await page.locator("#navigationCollapse").click(); await settled(page);
        await expect(page.locator(`nav [data-nav="${destination}"]`)).toHaveAttribute("aria-current", "page");
        await page.locator("#navigationCollapse").click(); await settled(page);
    }
    // Breakpoint changes move the existing brand and return keyboard intent to the drawer trigger.
    await page.locator("#navigationCollapse").focus();
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(page.locator("#navigationToggle")).toBeFocused();
    const drawerTrace = await page.evaluate(async () => {
        const drawer = document.querySelector("#navigationDrawer"), rows = [];
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        for (let cycle = 0; cycle < 3; cycle++) {
            document.querySelector("#navigationToggle").click();
            for (let i = 0; i < (cycle === 2 ? 3 : 24); i++) {
                await frame(); rows.push({ x: drawer.getBoundingClientRect().x, header: document.querySelector(".app-header").getBoundingClientRect().height,
                    mainY: document.querySelector("#main").getBoundingClientRect().y, scrollY });
            }
            document.querySelector("#closeNavigation").click();
            for (let i = 0; i < 120 && drawer.open; i++) { await frame(); }
            if (drawer.open) throw new Error("Drawer did not close");
        }
        return rows;
    });
    assert.ok(new Set(drawerTrace.map(row => Math.round(row.x))).size > 8);
    for (const key of ["header", "mainY", "scrollY"]) assert.equal(new Set(drawerTrace.map(row => row[key])).size, 1);
    await expect(page.locator("#navigationToggle")).toBeFocused();
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), nativeReduced);
    if (proofs) await writeFile(path.join(proofs, `brand-motion-${reducedMotion ?? "native"}.json`), JSON.stringify({ traces, drawerTrace }, null, 2));
});

test("the selected identity paints correctly in the header, compact rail, drawer and favicon", { timeout: 60000 }, async t => {
    const record = fixture("magenta-brand");
    record.capturedAt = new Date().toISOString();
    record.toolCalls[0].startedAt = record.capturedAt;
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, [record]);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => {
        try { await browser.close(); }
        finally {
            try {
                await runtime.close();
                const after = await loadBoardState(context);
                for (const key of ["cards", "evidence", "exports"]) assert.deepEqual(after[key], before[key]);
            } finally { for (const work of cleanup) await work(); }
        }
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const proofs = process.env.WIRE_BRAND_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    const capture = async name => {
        if (proofs) await page.screenshot({ path: path.join(proofs, `${name}.png`), animations: "disabled" });
    };
    const settle = () => page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), FAVICON_PATH);
    for (const uri of [FAVICON_PATH, "/favicon.svg"]) {
        const response = await page.request.get(new URL(uri, runtime.url).href);
        assert.equal(response.status(), 200);
        assert.equal(response.headers()["content-type"], "image/svg+xml; charset=utf-8");
        assert.equal(await response.text(), logoSvg);
    }

    for (const [theme, low, high] of [
        ["light", "rgb(143, 41, 102)", "rgb(198, 57, 141)"],
        ["dark", "rgb(198, 57, 141)", "rgb(217, 124, 180)"],
    ]) {
        await chooseTheme(page, theme);
        const full = page.locator(`#shellBrand .brand-logo[data-brand-theme=${theme}]`);
        await expect(full).toBeVisible();
        await expect(full).toHaveCSS("width", "120px");
        assert.equal(await full.locator("text").count(), 0, "No expanded-name descriptor is painted");
        await expect(page.locator("#shellBrand .brand-home")).toHaveCSS("height", "44px");
        const header = await page.locator(".app-header").boundingBox();
        await capture(`header-${theme}`);

        await page.locator("#navigationCollapse").click(); await settle();
        const compact = page.locator("#shellBrand .brand-compact");
        await expect(compact).toHaveCSS("opacity", "1");
        await expect(full).toHaveCSS("opacity", "0");
        await expect(compact.locator(".brand-low").first()).toHaveCSS("stop-color", low);
        await expect(compact.locator(".brand-high").first()).toHaveCSS("stop-color", high);
        assert.equal((await page.locator(".app-header").boundingBox()).height, header.height);
        await capture(`compact-${theme}`);
        await page.locator("#navigationCollapse").click(); await settle();

        await page.setViewportSize({ width: 390, height: 900 });
        await page.locator("#navigationToggle").click();
        const drawer = page.locator("#navigationDrawer");
        await expect(drawer.locator(`.brand-logo[data-brand-theme=${theme}]`)).toBeVisible();
        await expect(drawer.locator(".brand-compact")).toBeHidden();
        const target = await drawer.locator(".brand-home").boundingBox();
        assert.ok(target.width >= 44 && target.height >= 44);
        await capture(`drawer-${theme}`);
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1440, height: 1000 });
    }

    const favicon = await browser.newPage();
    for (const [scheme, expected] of [["light", "rgb(143, 41, 102)"], ["dark", "rgb(198, 57, 141)"]]) {
        await favicon.emulateMedia({ colorScheme: scheme });
        await favicon.goto(new URL(FAVICON_PATH, runtime.url).href);
        await expect(favicon.locator(".brand-low").first()).toHaveCSS("stop-color", expected);
    }
    assert.deepEqual(errors, []);
});
