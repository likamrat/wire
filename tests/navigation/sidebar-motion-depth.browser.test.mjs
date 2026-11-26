import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, selectActivityOption, revealAnalyzeRecords } from "../support/helpers.mjs";


const proofs = process.env.WIRE_MOTION_DEPTH_PROOFS;

async function setup(t, { nativeScrollbars = false, savedReports = 0, storedMotion = null, reducedMotion = null } = {}) {
    const cleanup = [];
    const records = Array.from({ length: 16 }, (_, i) => {
        const record = fixture(`motion-depth-${i}`);
        record.userPrompt.text = `Find the invented launch checklist ${i}. ` + "Keep the milestones and open questions together. ".repeat(4);
        record.sourceSessionName = `Synthetic motion review ${i}`;
        record.followUpPrompts = [];
        return record;
    });
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const reports = createExportController(context);
    for (let i = 0; i < savedReports; i++) {
        const state = await loadBoardState(context), session = `synthetic-motion-report-${i}`;
        const preview = await reports.preview(session, undefined, {
            title: `Motion handoff report ${i + 1}`, promptMode: "none", formats: ["html", "json"],
        }, { kind: "selected", revision: state.revision, scenarioIds: records.slice(0, i + 1).map(record => record.scenarioId) });
        await reports.review(session, preview.previewId, true);
        await reports.confirm(session, preview.previewId, true);
    }
    const savedState = await loadBoardState(context);
    const runtime = await startServer(context, reports, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined,
        ...(nativeScrollbars ? { ignoreDefaultArgs: ["--hide-scrollbars"] } : {}) });
    if (proofs) await mkdir(proofs, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion,
        ...(proofs ? { recordVideo: { dir: proofs, size: { width: 1440, height: 1000 } } } : {}) });
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (new URL(request.url()).origin !== new URL(runtime.url).origin) external.push(request.url()); });
    await page.addInitScript(value => {
        const key = "workiq-evidence.sidebar-motion";
        if (value !== null) localStorage.setItem(key, value);
        window.retiredMotionReads = [];
        for (const operation of ["getItem", "setItem", "removeItem"]) {
            const original = Storage.prototype[operation];
            Storage.prototype[operation] = function (...args) {
                if (args[0] === key) window.retiredMotionReads.push(operation);
                return original.apply(this, args);
            };
        }
    }, storedMotion);
    t.after(async () => {
        await browser.close();
        await runtime.close();
        const after = await loadBoardState(context);
        for (const action of cleanup) await action();
        for (const key of ["cards", "evidence", "exports"]) assert.deepEqual(after[key], savedState[key], `Sidebar motion cannot change ${key}`);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
    });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return page;
}

async function save(name, value) {
    if (proofs) await writeFile(path.join(proofs, `${name}.json`), JSON.stringify(value, null, 2));
}

// Only the handoff tests hold the real panel and column timelines. A loaded browser
// can otherwise finish their 320ms glide before it dispatches the next user input.
async function controlDockedGlide(page) {
    await page.evaluate(() => {
        const nodes = ["contextSidebar", "main"].map(id => document.getElementById(id));
        let held = false;
        for (const node of nodes) {
            const animate = node.animate;
            node.animate = function (...args) {
                const effect = animate.apply(this, args);
                if (held) queueMicrotask(() => {
                    if (effect.playState === "idle") return;
                    effect.pause();
                    effect.currentTime = effect.effect.getTiming().duration / 4;
                });
                return effect;
            };
        }
        window.holdDockedGlide = () => { held = true; };
        window.resumeDockedGlide = () => {
            held = false;
            for (const node of nodes) for (const effect of node.getAnimations())
                if (effect.playState === "paused") effect.play();
        };
    });
}

test("the retired motion preference stays unread and unchanged through navigation", async t => {
    const page = await setup(t, { storedMotion: "off", reducedMotion: "reduce" });
    await page.locator("#navigationCollapse").click();
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    await page.goto(new URL("#settings?section=display&setting=sidebar-motion", page.url()).href);
    await expect(page.locator("#settingsThemePreference")).toBeVisible();
    await page.locator("#settingsSearch").fill("Sidebar motion");
    await expect(page.locator("#settingsSearchResults a")).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => ({
        reads: window.retiredMotionReads.slice(),
        value: Object.entries(localStorage).find(([key]) => key === "workiq-evidence.sidebar-motion")?.[1],
    })), { reads: [], value: "off" });
});

test("retired motion setting is absent from global Search and cannot return through a stale URL", async t => {
    const page = await setup(t, { reducedMotion: "reduce" });
    await page.locator("#wireSearch").fill("Sidebar motion");
    await selectActivityOption(page, "wireSearchType", "setting");
    await expect(page.locator("#wireSearchStatus")).toHaveText("No matches. Try different words.");
    assert.equal(await page.locator(".wire-search-title").filter({ hasText: /^Sidebar motion$/ }).count(), 0);
    await page.goto(new URL("#settings?section=display&setting=sidebar-motion", page.url()).href);
    await page.reload();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.equal(await page.locator("#sidebarMotionPreference").count(), 0, "Reloading an obsolete deep link cannot recreate the control");
    await expect(page.locator("#settingsThemePreference")).toBeVisible();
    await expect(page.locator("[data-settings-section=themes]")).toBeVisible();
    if (proofs) await page.screenshot({ path: path.join(proofs, "display-without-motion.png") });
});

test("docked contextual glide moves the real main edge with the painted sidebar in both directions", async t => {
    const page = await setup(t);
    await revealAnalyzeRecords(page);
    const frames = await page.evaluate(async () => {
        const panel = document.querySelector("#contextSidebar"), main = document.querySelector("#main");
        const samples = [], frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const sample = phase => {
            const p = panel.getBoundingClientRect(), m = main.getBoundingClientRect();
            samples.push({ phase, at: performance.now(), open: panel.open, panelX: p.x, mainRight: m.right,
                mainWidth: m.width, mode: panel.dataset.mode, moving: panel.getAnimations().length > 0 });
        };
        for (const phase of ["open", "close"]) {
            sample(phase);
            let owners, startedBeforePaint;
            const observer = new MutationObserver(async () => {
                const reader = panel.getAnimations()[0];
                if (!reader) return;
                observer.disconnect();
                const effects = [reader, ...main.getAnimations()];
                startedBeforePaint = effects.some(animation => animation.startTime !== null);
                await Promise.all(effects.map(animation => animation.ready));
                owners = effects.map(animation => ({
                    animation, start: animation.startTime, rate: animation.playbackRate, state: animation.playState,
                }));
                for (const { animation } of owners) animation.pause();
            });
            observer.observe(panel, { attributes: true, attributeFilter: [phase === "open" ? "open" : "inert"] });
            document.querySelector(phase === "open" ? ".request-card-open" : "#closeContextSidebar").click();
            for (let i = 0; i < 120 && !owners; i++) await frame();
            observer.disconnect();
            if (!owners) throw Error(`${phase} never started a docked glide`);
            if (startedBeforePaint) throw Error(`${phase} consumed its clock before the reader could be painted`);
            if (owners.some(owner => owner.start == null || owner.rate <= 0 || owner.state !== "running"))
                throw Error(`${phase} did not start playing on the document timeline`);
            const [reader] = owners;
            // Inspect the same document times, not the same progress on each
            // effect: independently delayed or differently eased edges must fail.
            for (const fraction of [.125, .375, .625]) {
                const time = reader.start + reader.animation.effect.getTiming().duration * fraction / reader.rate;
                for (const { animation, start, rate } of owners) animation.currentTime = (time - start) * rate;
                await frame();
                sample(phase);
            }
            for (const { animation } of owners) animation.play();
            await reader.animation.finished;
            await frame();
            if (panel.open !== (phase === "open")) throw Error(`${phase} did not settle`);
            sample(phase);
        }
        return samples;
    });
    await save("docked-edge-trace", frames);
    for (const phase of ["open", "close"]) {
        const moving = frames.filter(row => row.phase === phase && row.open && row.moving);
        const widths = new Set(moving.map(row => Math.round(row.mainWidth))).size;
        const maxGap = Math.max(...moving.map(row => Math.abs(row.mainRight - row.panelX)));
        t.diagnostic(JSON.stringify({ phase, widths, maxGap }));
        assert.ok(widths >= 3, `${phase}: main width snaps instead of following the sidebar (${widths} painted width)`);
        assert.ok((moving[0].mainWidth - moving.at(-1).mainWidth) * (phase === "open" ? 1 : -1) > 40,
            `${phase}: the main surface must reflow in the direction of the glide`);
        assert.ok(maxGap < 2, `${phase}: main edge must follow the actual exposed sidebar edge, gap ${maxGap}`);
    }
});

test("combined geometry keeps exact origin and history through rapid reversal without leaking into saved inspection", async t => {
    const page = await setup(t, { savedReports: 1 });
    await revealAnalyzeRecords(page);
    const card = page.locator(".request-card-open").nth(2);
    await card.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => ({ y: scrollY, url: location.href, top: document.querySelectorAll(".request-card-open")[2].getBoundingClientRect().top }));
    const box = await card.boundingBox();
    await page.mouse.click(box.x + 30, box.y + 20);
    await page.locator("#contextSidebar[open]").waitFor();
    const panel = page.locator("#contextSidebar");
    const request = page.url();
    const changes = await page.evaluate(() => {
        const values = [];
        for (const id of ["expandInteraction", "expandInteraction", "widenInteraction", "expandInteraction"]) {
            document.getElementById(id).click();
            values.push({ id, y: scrollY, top: document.querySelectorAll(".request-card-open")[2].getBoundingClientRect().top });
        }
        return values;
    });
    await expect(panel).toHaveAttribute("data-mode", "expanded");
    await page.goBack();
    await panel.waitFor({ state: "hidden" });
    await expect(card).toBeFocused();
    assert.equal(page.url(), before.url);
    const after = await page.evaluate(() => ({ y: scrollY, top: document.querySelectorAll(".request-card-open")[2].getBoundingClientRect().top }));
    assert.ok(Math.abs(after.y - before.y) <= 2, `Close returns exact main scroll despite maximized reflow: ${JSON.stringify({ before, changes, after })}`);
    await page.goForward();
    await panel.waitFor();
    assert.equal(page.url(), request);
    await expect(panel).toHaveAttribute("data-mode", "docked");
    await page.evaluate(() => {
        document.querySelector("#expandInteraction").click();
        document.querySelector("#expandInteraction").click();
        document.querySelector("#closeContextSidebar").click();
    });
    await panel.waitFor({ state: "hidden" });
    await expect(card).toBeFocused();
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - before.y) <= 2);
    await navigateMain(page, "reports");
    await page.getByRole("link", { name: "Saved library", exact: true }).click();
    await page.locator('[data-view-key^="inspect-bundle:"]').first().click();
    await panel.waitFor();
    for (const id of ["readerWidthControls", "readerResize", "expandInteraction"]) await expect(page.locator("#" + id)).toBeHidden();
    assert.equal(await panel.evaluate(node => node.hasAttribute("data-interaction-reader")), false);
    assert.equal(await page.locator("#main").evaluate(node => node.inert), false);
    assert.equal(await page.evaluate(() => document.body.style.getPropertyValue("--context-sidebar-width")), "");
    await page.locator("#closeContextSidebar").click();
    await panel.waitFor({ state: "hidden" });
    await expect(page.locator('[data-view-key^="inspect-bundle:"]').first()).toBeFocused();
});

test("in-flight shared motion reverses and replaces content without stale geometry or hit targets", async t => {
    const page = await setup(t);
    await revealAnalyzeRecords(page);
    await controlDockedGlide(page);
    const trace = await page.evaluate(async () => {
        const panel = document.querySelector("#contextSidebar"), main = document.querySelector("#main");
        const rail = document.querySelector("#sidebar"), rows = [...document.querySelectorAll(".request-card-open")];
        const frames = [], events = [], next = () => new Promise(resolve => requestAnimationFrame(resolve));
        let phase = "left-collapse";
        const sample = () => {
            const p = panel.getBoundingClientRect(), m = main.getBoundingClientRect(), r = rail.getBoundingClientRect();
            const selected = document.querySelector(".request-card-open[aria-expanded=true]");
            frames.push({ phase, at: performance.now(), open: panel.open, x: p.x, width: p.width, railWidth: r.width,
                mainX: m.x, mainRight: m.right, mainWidth: m.width, cardY: selected?.getBoundingClientRect().y,
                panelMoving: panel.getAnimations().length > 0, railMoving: rail.hasAttribute("data-navigation-moving") });
        };
        async function advance(count) {
            for (let i = 0; i < count; i++) { await next(); await scheduler.postTask(sample); }
        }
        async function settle(open) {
            for (let i = 0; i < 120; i++) {
                await advance(1);
                if (i > 1 && panel.open === open && !panel.getAnimations().length && !rail.hasAttribute("data-navigation-moving")) return;
            }
            throw new Error("Current motion owner did not settle");
        }
        function event(label, action) {
            const before = { x: panel.getBoundingClientRect().x, mainRight: main.getBoundingClientRect().right };
            action();
            events.push({ label, before, after: { x: panel.getBoundingClientRect().x, mainRight: main.getBoundingClientRect().right,
                cardY: document.querySelector(".request-card-open[aria-expanded=true]")?.getBoundingClientRect().y } });
        }
        document.querySelector("#navigationCollapse").click(); await advance(4);
        phase = "left-reverse"; document.querySelector("#navigationCollapse").click(); await settle(false);
        window.holdDockedGlide();
        phase = "open"; rows[0].click(); await advance(4);
        const animation = panel.getAnimations()[0];
        if (animation?.playState !== "paused" || animation.effect.getComputedTiming().progress <= 0)
            throw new Error("Expected an in-flight reader entrance");
        phase = "replace";
        event("replace", () => rows[1].click());
        if (panel.getAnimations()[0] !== animation) throw new Error("Content replacement replayed entrance");
        await advance(2); window.resumeDockedGlide();
        await settle(true);
        window.holdDockedGlide();
        phase = "close"; document.querySelector("#closeContextSidebar").click(); await advance(4);
        phase = "reverse";
        event("reverse", () => rows[0].click());
        await advance(2); window.resumeDockedGlide();
        await settle(true);
        window.holdDockedGlide();
        phase = "both"; document.querySelector("#navigationCollapse").click(); document.querySelector("#closeContextSidebar").click();
        await advance(2); window.resumeDockedGlide();
        await settle(false);
        const closeState = { mainWidth: main.getBoundingClientRect().width, available: document.body.getBoundingClientRect().right - main.getBoundingClientRect().x,
            mainAnimations: main.getAnimations().length, overflowAnchor: getComputedStyle(main).overflowAnchor };
        return { frames, events, closeState };
    });
    await save("reversal-trace", trace);
    for (const event of trace.events) {
        assert.ok(Math.abs(event.before.x - event.after.x) < 1, `${event.label}: panel jumps at ownership change`);
        assert.ok(Math.abs(event.before.mainRight - event.after.mainRight) < 1, `${event.label}: main jumps at ownership change`);
    }
    for (const phase of ["open", "replace", "close", "reverse", "both"]) {
        const rows = trace.frames.filter(row => row.phase === phase && row.open && row.panelMoving);
        assert.ok(rows.length >= 1, `${phase}: sampled the in-flight layout`);
        assert.ok(rows.every(row => Math.abs(row.x - row.mainRight) < 2), `${phase}: panel and main have different edges`);
        if (phase === "replace") {
            const top = trace.events.find(event => event.label === phase).after.cardY;
            assert.ok(rows.every(row => Math.abs(row.cardY - top) < 3), `Replacement owns its current anchor: ${top}, ${rows.map(row => row.cardY)}`);
        }
    }
    assert.ok(Math.abs(trace.closeState.mainWidth - trace.closeState.available) < 1);
    assert.equal(trace.closeState.mainAnimations, 0);
    assert.equal(trace.closeState.overflowAnchor, "auto");
    await page.locator(".request-card-open").first().click();
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    const hit = await page.locator("#closeContextSidebar").evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, height: rect.height, owns: node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
    });
    assert.ok(hit.width >= 44 && hit.height >= 44 && hit.owns, "Painted Close is also the actual 44px hit target");
});

test("native-modal and docked surfaces keep their proper main layout at normal and enlarged text", async t => {
    const page = await setup(t), results = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [1100, 1], [375, 1], [1440, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await page.locator(".request-card-open").first().scrollIntoViewIfNeeded();
        const evidence = await page.evaluate(async () => {
            const panel = document.querySelector("#contextSidebar"), main = document.querySelector("#main"), samples = [];
            const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
            for (const phase of ["open", "close"]) {
                document.querySelector(phase === "open" ? ".request-card-open" : "#closeContextSidebar").click();
                for (let i = 0; i < 120; i++) {
                    await frame();
                    samples.push({ phase, x: panel.getBoundingClientRect().x, mainWidth: main.getBoundingClientRect().width,
                        mode: panel.dataset.mode, modal: panel.matches(":modal"), open: panel.open, moving: panel.getAnimations().length > 0 });
                    if (i > 2 && panel.open === (phase === "open") && !panel.getAnimations().length) break;
                    if (i === 119) throw new Error(`${phase} did not finish`);
                }
            }
            return samples;
        });
        results.push({ theme, width, scale, evidence });
        for (const phase of ["open", "close"]) {
            const moving = evidence.filter(row => row.phase === phase && row.open && row.moving);
            assert.ok(new Set(moving.map(row => Math.round(row.x))).size >= 3, `${theme}/${width}/${scale}/${phase}: no intermediate geometry`);
            if (width === 1440 && scale === 1) assert.ok(moving.every(row => row.mode === "docked" && !row.modal));
            else {
                assert.ok(moving.every(row => row.mode === "overlay" && row.modal), "Narrow/enlarged mode uses the actual native modal");
                assert.equal(new Set(moving.map(row => row.mainWidth)).size, 1, "Modal leaves the main layout stationary");
            }
        }
        if (width === 375) {
            await page.locator("#navigationToggle").click();
            await page.waitForFunction(() => !document.querySelector("#navigationDrawer").getAnimations().length);
            assert.equal(await page.locator("#navigationDrawer").evaluate(node => node.matches(":modal")), true);
            await page.keyboard.press("Escape");
            await page.locator("#navigationDrawer").waitFor({ state: "hidden" });
            assert.equal(await page.locator("#navigationToggle").evaluate(node => node === document.activeElement), true);
        }
    }
    await save("layout-matrix", results);
});

test("native scrollbar gutters keep main and sidebar edges registered throughout reflow", async t => {
    const page = await setup(t, { nativeScrollbars: true });
    await revealAnalyzeRecords(page);
    const evidence = await page.evaluate(async () => {
        const main = document.querySelector("#main"), panel = document.querySelector("#contextSidebar"), frames = [];
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        for (const phase of ["open", "close"]) {
            document.querySelector(phase === "open" ? ".request-card-open" : "#closeContextSidebar").click();
            for (let i = 0; i < 120; i++) {
                await frame();
                frames.push({ phase, gutter: innerWidth - document.documentElement.clientWidth,
                    mainRight: main.getBoundingClientRect().right, panelX: panel.getBoundingClientRect().x,
                    moving: panel.getAnimations().length > 0, open: panel.open });
                if (i > 2 && panel.open === (phase === "open") && !panel.getAnimations().length) break;
                if (i === 119) throw new Error(`${phase} did not settle with native scrollbars`);
            }
        }
        return frames;
    });

    await save("native-scrollbar-frames", evidence);
    if (process.platform === "win32") assert.ok(evidence.some(row => row.gutter > 0), "Exercise the actual Windows scrollbar gutter");
    assert.ok(evidence.filter(row => row.moving).every(row => Math.abs(row.mainRight - row.panelX) < 2),
        "The real scrollbar gutter cannot become a gap or overlap between the moving edges");
});

test("left-rail reflow crossing the native-modal boundary settles the previous docked animation", async t => {
    const page = await setup(t);
    await page.setViewportSize({ width: 1100, height: 1000 });
    await page.locator("#navigationCollapse").click();
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    const frames = await page.evaluate(async () => {
        const panel = document.querySelector("#contextSidebar"), main = document.querySelector("#main"), rows = [];
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        document.querySelector(".request-card-open").click();
        await frame(); await frame();
        document.querySelector("#navigationCollapse").click();
        for (let i = 0; i < 120; i++) {
            await frame();
            await scheduler.postTask(() => rows.push({ modal: panel.matches(":modal"),
                columnMoving: main.getAnimations().length, panelMoving: panel.getAnimations().length,
                mainRight: main.getBoundingClientRect().right, availableRight: document.body.getBoundingClientRect().right }));
            if (i > 2 && !panel.getAnimations().length && !document.querySelector("#sidebar").hasAttribute("data-navigation-moving")) break;
        }
        return rows;
    });
    await save("docking-boundary", frames);
    assert.ok(frames.some(row => row.modal), "Expanding the left rail crosses the actual readable-column boundary");
    assert.ok(frames.filter(row => row.modal).every(row => !row.columnMoving && !row.panelMoving),
        "The old docked animation cannot continue after native-modal ownership changes");
    assert.ok(Math.abs(frames.at(-1).mainRight - frames.at(-1).availableRight) < 1);
});

test("saved-item replacement keeps its entrance and reverses exit without stale content or focus", async t => {
    const page = await setup(t, { savedReports: 2 });
    await navigateMain(page, "reports");
    await page.getByRole("link", { name: "Saved library", exact: true }).click();
    const result = await page.evaluate(async () => {
        const panel = document.querySelector("#contextSidebar"), main = document.querySelector("#main");
        const rows = [...document.querySelectorAll('[data-view-key^="inspect-bundle:"]')], frames = [];
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        let phase = "open";
        const snapshot = () => ({
            phase, x: panel.getBoundingClientRect().x, mainRight: main.getBoundingClientRect().right,
            moving: panel.getAnimations().length > 0, open: panel.open, inert: panel.inert,
            selected: document.querySelector(".saved-library-row[data-detail-active]")?.dataset.bundleId,
            text: document.querySelector(".saved-report-inspection")?.textContent,
            title: document.querySelector("#contextSidebarTitle")?.textContent,
            bodyTitle: panel.querySelector(".saved-inspector-title")?.textContent,
            titleCount: panel.querySelectorAll(".saved-inspector-title").length,
            label: document.getElementById(panel.getAttribute("aria-labelledby"))?.textContent,
            interactions: Number([...document.querySelectorAll(".saved-inspector-facts>div")]
                .find(row => row.querySelector("dt")?.textContent === "Interactions:")?.querySelector("dd")?.textContent),
            focused: document.activeElement?.id,
        });
        async function advance(count) {
            for (let i = 0; i < count; i++) { await frame(); frames.push(snapshot()); }
        }
        async function settle(open) {
            for (let i = 0; i < 120; i++) {
                await advance(1);
                if (i > 1 && panel.open === open && !panel.getAnimations().length) return;
            }
            throw new Error("Saved inspector did not settle");
        }
        const ids = rows.map(row => row.closest(".saved-library-row").dataset.bundleId);
        const titles = rows.map(row => row.closest(".saved-library-row").querySelector(".saved-report-name").textContent);
        const interactionCounts = [2, 1];
        rows[0].click(); await advance(3);
        const firstBody = document.querySelector(".saved-report-inspection");
        const entrance = panel.getAnimations()[0], column = main.getAnimations()[0];
        const beforeReplace = snapshot();
        phase = "replace"; rows[1].click();
        const afterReplace = snapshot(), sameEntrance = panel.getAnimations()[0] === entrance && main.getAnimations()[0] === column;
        await settle(true);
        const replacement = snapshot(), removedFirst = !firstBody.isConnected;
        const secondBody = document.querySelector(".saved-report-inspection");
        phase = "close"; document.querySelector("#closeContextSidebar").click();
        for (let i = 0; i < 120 && !panel.inert; i++) await advance(1);
        await advance(3);
        const beforeReverse = snapshot();
        phase = "reverse"; rows[0].click();
        const afterReverse = snapshot();
        await settle(true);
        phase = "same-close"; document.querySelector("#closeContextSidebar").click();
        for (let i = 0; i < 120 && !panel.inert; i++) await advance(1);
        await advance(3);
        const beforeSame = snapshot(), retiredExit = panel.getAnimations()[0];
        phase = "same-reverse"; rows[0].click();
        const afterSame = snapshot(), retiredExitState = retiredExit.playState;
        await settle(true);
        return { ids, titles, interactionCounts, beforeReplace, afterReplace, sameEntrance, replacement, removedFirst,
            beforeReverse, afterReverse, beforeSame, afterSame, retiredExitState,
            final: snapshot(), removedSecond: !secondBody.isConnected, frames };
    });
    if (proofs) result.video = await page.video().path();
    await save("saved-item-handoff", result);
    assert.equal(result.beforeReplace.moving, true, "Replace during actual unpaused entrance");
    assert.equal(result.sameEntrance, true, "Saved-item replacement must not cancel or restart either entrance animation");
    assert.ok(Math.abs(result.beforeReplace.x - result.afterReplace.x) < 1);
    assert.ok(Math.abs(result.beforeReplace.mainRight - result.afterReplace.mainRight) < 1);
    assert.equal(result.replacement.selected, result.ids[1]);
    assert.equal(result.replacement.title, result.titles[1]);
    assert.equal(result.replacement.bodyTitle, result.titles[1]);
    assert.equal(result.replacement.label, result.titles[1]);
    assert.equal(result.replacement.titleCount, 1);
    assert.equal(result.replacement.interactions, result.interactionCounts[1]);
    assert.ok(result.removedFirst && result.removedSecond, "Old saved bodies and their controls are released");
    assert.equal(result.beforeReverse.moving, true, "Reverse during actual unpaused exit");
    assert.ok(Math.abs(result.beforeReverse.x - result.afterReverse.x) < 1, "Saved exit reversal preserves the presented edge");
    assert.ok(Math.abs(result.beforeReverse.mainRight - result.afterReverse.mainRight) < 1,
        `Main edge jumps from ${result.beforeReverse.mainRight} to ${result.afterReverse.mainRight}px on reversal`);
    assert.ok(result.beforeSame.moving && Math.abs(result.beforeSame.x - result.afterSame.x) < 1);
    assert.ok(Math.abs(result.beforeSame.mainRight - result.afterSame.mainRight) < 1);
    assert.equal(result.retiredExitState, "idle", "The superseded exit cannot later finish against the reopened owner");
    assert.equal(result.final.selected, result.ids[0]);
    assert.equal(result.final.title, result.titles[0]);
    assert.equal(result.final.bodyTitle, result.titles[0]);
    assert.equal(result.final.label, result.titles[0]);
    assert.equal(result.final.titleCount, 1);
    assert.equal(result.final.interactions, result.interactionCounts[0]);
    assert.equal(result.final.focused, "savedInspectorTitle");
    assert.equal(result.final.inert, false);
    assert.equal(await page.locator("dialog[open]").count(), 1);
    for (const phase of ["replace", "reverse", "same-reverse"]) {
        assert.ok(new Set(result.frames.filter(row => row.phase === phase && row.moving).map(row => Math.round(row.x))).size >= 3);
    }
    await page.keyboard.press("Escape");
    await page.locator("#contextSidebar").waitFor({ state: "hidden" });
    assert.equal(await page.locator('[data-view-key^="inspect-bundle:"]').first().evaluate(node => node === document.activeElement), true);
    const departure = await page.evaluate(async () => {
        const panel = document.querySelector("#contextSidebar");
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        document.querySelector('[data-view-key^="inspect-bundle:"]').click();
        for (let i = 0; i < 120 && (!panel.open || panel.getAnimations().length); i++) await frame();
        document.querySelector("#closeContextSidebar").click();
        for (let i = 0; i < 120 && !panel.inert; i++) await frame();
        const exiting = panel.getAnimations()[0];
        document.querySelector('nav [data-nav="settings"]').click();
        await frame();
        return { wasExiting: Boolean(exiting), retiredState: exiting?.playState, open: panel.open,
            bodyCount: document.querySelectorAll(".saved-report-inspection").length,
            settings: document.querySelector("#settingsView").checkVisibility(),
            mainAnimations: document.querySelector("#main").getAnimations().length };
    });
    await save("saved-item-departure", departure);
    assert.ok(departure.wasExiting && departure.retiredState === "idle" && departure.settings);
    assert.equal(departure.open, false, "A non-inspector departure still takes the original settle/cleanup path");
    assert.equal(departure.bodyCount, 0);
    assert.equal(departure.mainAnimations, 0);
});

test("trusted main-page scrolling revokes exit compensation for a reflow-sensitive anchor", async t => {
    const page = await setup(t, { nativeScrollbars: true });
    await controlDockedGlide(page);
    await revealAnalyzeRecords(page);
    const wideTop = await page.locator(".request-card-open").first().evaluate(node => node.getBoundingClientRect().top + scrollY);
    await page.locator(".request-card-open").first().click();
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    const dockedTop = await page.locator(".request-card-open").first().evaluate(node => node.getBoundingClientRect().top + scrollY);
    assert.ok(Math.abs(dockedTop - wideTop) > 100, "The mounted anchor must actually change document position when the main column reflows");
    await page.evaluate(() => {
        const panel = document.querySelector("#contextSidebar"), main = document.querySelector("#main");
        window.exitScrollProof = { frames: [], programmaticScrolls: [], wheel: null, userY: null, finished: false, initialY: scrollY,
            initialAnchorTop: document.querySelector(".request-card-open").getBoundingClientRect().top };
        const proof = window.exitScrollProof;
        const scrollBy = window.scrollBy;
        window.scrollBy = function (...args) {
            const before = scrollY;
            scrollBy.apply(window, args);
            proof.programmaticScrolls.push({ before, after: scrollY, afterWheel: proof.wheel !== null });
        };
        const read = () => ({
            y: scrollY, open: panel.open, moving: panel.getAnimations().length > 0,
            mainWidth: main.getBoundingClientRect().width,
            anchorTop: document.querySelector(".request-card-open").getBoundingClientRect().top,
            focus: document.activeElement?.id,
        });
        window.addEventListener("wheel", event => {
            if (event.isTrusted) proof.wheelCapture = { y: scrollY, target: event.target.tagName,
                onMain: main.contains(event.target), delta: event.deltaY, scrollCalls: proof.programmaticScrolls.length };
        }, { once: true, capture: true, passive: true });
        document.addEventListener("wheel", event => {
            if (event.isTrusted) {
                proof.wheel = { ...read(), trusted: true, deltaY: event.deltaY,
                    compensated: proof.programmaticScrolls.reduce((sum, row) => sum + row.after - row.before, 0) };
                proof.userY = scrollY;
            }
        }, { once: true, passive: true });
        window.addEventListener("scroll", () => {
            if (proof.wheel && !proof.finished && panel.open) proof.userY = scrollY;
        }, { passive: true });
        const observer = new ResizeObserver(() => { if (proof.wheel) proof.frames.push(read()); });
        observer.observe(main);
        panel.addEventListener("close", () => {
            proof.finished = true;
            proof.final = read();
            window.scrollBy = scrollBy;
            observer.disconnect();
        }, { once: true });
    });
    await page.evaluate(() => window.holdDockedGlide());
    await page.locator("#closeContextSidebar").click();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").inert && document.querySelector("#contextSidebar").getAnimations().length > 0);
    await page.locator("#navigationCollapse").focus();
    const mainX = await page.locator("#main").evaluate(node => {
        const x = node.getBoundingClientRect().left + 16;
        if (!node.contains(document.elementFromPoint(x, 500))) throw new Error("Wheel must target the main page, not the rail divider");
        return x;
    });
    await page.mouse.move(mainX, 500);
    const beforeWheel = await page.evaluate(() => scrollY);
    assert.ok(beforeWheel >= 160, "The test needs room for an upward wheel gesture");
    await page.mouse.wheel(0, -160);
    await page.waitForFunction(() => window.exitScrollProof.wheel?.trusted);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const observed = await page.evaluate(() => ({ capture: window.exitScrollProof.wheelCapture,
        after: window.exitScrollProof.wheel.y, now: scrollY,
        compensation: window.exitScrollProof.programmaticScrolls.slice(window.exitScrollProof.wheelCapture.scrollCalls) }));
    assert.ok(observed.capture.onMain && observed.now < beforeWheel, JSON.stringify({ beforeWheel, ...observed }));
    await page.evaluate(() => window.resumeDockedGlide());
    await page.waitForFunction(() => window.exitScrollProof.finished && window.exitScrollProof.userY !== null);
    const result = await page.evaluate(() => window.exitScrollProof);
    if (proofs) result.video = await page.video().path();
    await save("trusted-exit-scroll", { wideTop, dockedTop, ...result });
    assert.ok(result.wheel.trusted && result.wheel.open && result.wheel.moving, "A real wheel event revokes ownership during exit");
    assert.ok(result.userY < beforeWheel, `The trusted wheel must move the main page from ${beforeWheel}, got ${result.userY}`);
    assert.ok(Math.abs(result.final.y - result.userY) <= 1, `Exit must keep the user's newer scroll ${result.userY}, got ${result.final.y}`);
    assert.ok(result.programmaticScrolls.filter(row => row.afterWheel).every(row => row.before === row.after),
        "Revoked ownership cannot cause another programmatic scroll");
    assert.equal(result.final.focus, "navigationCollapse", "Exit cannot restore old card focus over newer input");
    assert.equal(await page.locator("body").getAttribute("data-context-docked"), null);
    assert.equal(await page.locator("#main").evaluate(node => node.getAnimations().length), 0);
});
