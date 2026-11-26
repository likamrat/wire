import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../../lib/activity-analytics.mjs";
import { exportCatalogFor, navigateMain, chooseTheme, openActivitySessions, automaticScoreOffSummary, UNBOUND_FIXTURE_BOOTSTRAP, fixture as recordedInteraction, privateFixture } from "../support/helpers.mjs";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { prepareLandingReport } from "../reports/report-journey-helpers.mjs";

const proofDir = process.env.WORKIQ_THEME_PROOF_DIR;
const records = ["/me/messages", "/me/events", "/me/drive/root/children", "/teams/fixture/channels", "/me/people", "/me/todo/lists"].map((apiPath, index) => ({
    scenarioId: `synthetic-theme-${index}`, sourceSessionId: "synthetic-theme-session", sourceHost: "copilot-app",
    sourceSessionName: "Synthetic theme examples", project: "Synthetic fixtures", projectId: "synthetic-project",
    isLegacy: false, capturedAt: `2026-01-${10 + index}T12:00:00Z`, workflowState: "ready_to_export",
    userPrompt: { text: `SYNTHETIC ONLY: Inspect example ${index + 1} without changing workplace data.`, status: "verbatim", provenance: "synthetic" },
    toolCalls: [{
        tool: "workiq-fetch", toolCallId: `synthetic-call-${index}`, requestedApiPath: apiPath, requestArgs: { path: apiPath },
        toolSucceeded: index % 3 === 0 ? true : index % 3 === 1 ? false : null,
        reportedOutcome: index % 3 === 0 ? "succeeded" : index % 3 === 1 ? "failed" : "unknown",
        startedAt: `2026-01-${10 + index}T12:00:00Z`, apiResults: [],
    }],
}));

async function fixture(run, hostMode = "") {
    const state = { boardId: "synthetic-theme-board", revision: 1, scenarios: records, exports: [], coverage: { since: "2026-01-01", until: "2026-01-31", notes: ["Synthetic fixture only."] } };
    const requests = [], errors = [];
    const server = createServer(async (req, res) => {
        const json = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-theme-fixture'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'");
            res.end(renderHtmlShell("a".repeat(64), "theme-fixture", UNBOUND_FIXTURE_BOOTSTRAP).replace('<html lang="en">', `<html lang="en" data-color-mode="${hostMode}">`));
            return;
        }
        requests.push(req.url);
        let text = ""; for await (const chunk of req) text += chunk;
        const input = JSON.parse(text);
        if (req.url === "/api/snapshot") return json({ ...state, exportCatalog: exportCatalogFor(records),
            requestActivity: buildRequestActivity(records), analytics: { ...buildActivityAnalytics(records, input), revision: 1 } });
        if (req.url === "/api/collection/status") return json({ state: "needs-setup", config: { approved: false, enabled: false } });
        if (req.url === "/api/evaluation/automatic/summary") return json(automaticScoreOffSummary());
        res.statusCode = 403;
        json({ error: "Mutations are forbidden in the theme fixture." });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ colorScheme: "light" });
    const url = `http://127.0.0.1:${server.address().port}/`;
    context.on("page", (page) => {
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => assert.equal(new URL(request.url()).origin, new URL(url).origin, "No external resources"));
    });
    try {
        if (proofDir) await mkdir(proofDir, { recursive: true });
        await run({ context, url, requests });
        assert.deepEqual(errors, []);
        assert.deepEqual(requests.filter(route => !["/api/snapshot", "/api/collection/status", "/api/evaluation/automatic/summary"].includes(route)), [],
            "Appearance tests do not prepare or save reports, collect history or write preferences to the server");
    } finally {
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
}

async function shot(page, name) {
    if (proofDir) await page.screenshot({ path: path.join(proofDir, `${name}.png`), fullPage: true });
}
async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await openActivitySessions(page);
}
async function resolved(page, theme) {
    await page.waitForFunction((expected) => document.documentElement.dataset.evidenceTheme === expected, theme);
    assert.equal(await page.locator("body").evaluate((node) => getComputedStyle(node).colorScheme), theme);
}
async function firstPaintTheme(page) {
    await page.waitForFunction(() => Object.hasOwn(window, "firstTheme"));
    return page.evaluate(() => window.firstTheme);
}

async function switchPosition(page, theme) {
    await resolved(page, theme);
    await page.waitForFunction((expected) => {
        const thumb = document.querySelector(".theme-thumb");
        return getComputedStyle(thumb).transform === `matrix(1, 0, 0, 1, ${expected === "dark" ? 26 : 0}, 0)`;
    }, theme);
    const control = page.getByRole("switch", { name: "Dark theme", exact: true, checked: theme === "dark" });
    assert.equal(await control.count(), 1);
    const geometry = await control.evaluate((node) => {
        const rect = (element) => {
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height, centerX: box.x + box.width / 2, centerY: box.y + box.height / 2 };
        };
        return {
            control: rect(node), track: rect(node.querySelector(".theme-track")), thumb: rect(node.querySelector(".theme-thumb")),
            sun: rect(node.querySelector(".theme-sun")), moon: rect(node.querySelector(".theme-moon")),
            assets: [...node.querySelectorAll("svg")].map((icon) => icon.dataset.lucideIcon),
        };
    });
    assert.equal(geometry.control.width, 56);
    assert.equal(geometry.control.height, 44);
    assert.equal(geometry.track.width, 56);
    assert.equal(geometry.track.height, 30);
    assert.equal(geometry.thumb.width, 20);
    assert.equal(geometry.thumb.height, 20);
    assert.deepEqual(geometry.assets, ["sun", "moon"]);
    assert.equal(geometry.moon.x - (geometry.sun.x + geometry.sun.width), 10, "Visible space between the two icon boxes");
    assert.equal(geometry.thumb.centerX, geometry[theme === "dark" ? "moon" : "sun"].centerX);
    assert.equal(geometry.thumb.centerY, geometry.sun.centerY);
    assert.equal(geometry.thumb.centerY, geometry.moon.centerY);
    assert.equal(geometry.sun.centerX - geometry.track.x, geometry.track.x + geometry.track.width - geometry.moon.centerX, "Balanced icon centers");
    assert.equal(await control.locator("button, a, input, [tabindex]").count(), 0, "Single native activation target, not nested controls");
    assert.equal(await control.innerText(), "");
    return geometry;
}

// Measure computed colors against their composed backgrounds, not source hex proxies.
async function inspect(page) {
    const result = await page.evaluate(() => {
        // Decode the browser's computed color, including normalized color(srgb ...)
        // from color-mix(), onto the same 0–255 scale as rgb().
        const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
        const colors = new Map();
        function rgba(value) {
            if (!colors.has(value)) {
                if (!CSS.supports("color", value)) throw new Error("Unsupported computed paint: " + value);
                pixel.clearRect(0, 0, 1, 1);
                pixel.fillStyle = value;
                pixel.fillRect(0, 0, 1, 1);
                const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
                colors.set(value, [r, g, b, a / 255]);
            }
            return colors.get(value);
        }
        function background(node) {
            if (!node) return [255, 255, 255];
            const color = rgba(getComputedStyle(node).backgroundColor), alpha = color[3] ?? 1;
            const surface = alpha === 1 ? color.slice(0, 3) : background(node.parentElement).map((value, index) => color[index] * alpha + value * (1 - alpha));
            const face = getComputedStyle(node, "::before");
            if (face.content === "none" || face.display === "none") return surface;
            const ink = rgba(face.backgroundColor), opacity = (ink[3] ?? 1) * Number(face.opacity);
            return surface.map((value, index) => ink[index] * opacity + value * (1 - opacity));
        }
        function contrast(a, b) {
            function luminance(rgb) { return rgb.slice(0, 3).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0); }
            const x = luminance(a), y = luminance(b);
            return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
        }
        const ratios = [], failures = [], overflow = [], cardOutcomeRatios = {};
        for (const node of document.body.querySelectorAll("*")) {
            if (!node.checkVisibility({ visibilityProperty: true }) || node.closest(".visually-hidden, .skip-link") || node.tagName === "OPTION") continue;
            const box = node.getBoundingClientRect();
            const scroller = node.closest(".dimensional-scroll,#countTable,.token-history-scroll");
            if (!scroller && (box.right > innerWidth + 1 || box.left < -1)) overflow.push(node.id || node.className || node.tagName);
            if (scroller) {
                const bounds = scroller.getBoundingClientRect();
                if (bounds.right > innerWidth + 1 || bounds.left < -1) overflow.push("dimensional-scroll");
                const keyboard = scroller.matches(".token-history-scroll") ? scroller.querySelector("input[type=range]:enabled") : scroller;
                if (scroller.scrollWidth > scroller.clientWidth && (getComputedStyle(scroller).overflowX !== "auto" || keyboard?.tabIndex !== 0)) overflow.push("inaccessible-chart-overflow");
            }
            const hasText = [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
            if (!hasText && !node.matches("input:not([type=checkbox]),select")) continue;
            const style = getComputedStyle(node), bg = background(node);
            const ratio = contrast(rgba(style.color), bg);
            const label = node.id || node.className || node.tagName;
            ratios.push(ratio);
            if (node.classList.contains("card-outcome-label")) cardOutcomeRatios[node.textContent.trim()] = ratio;
            if (ratio < 4.5) failures.push({ label, ratio, color: style.color, bg });
            if (node.matches("input[placeholder]")) {
                const placeholderRatio = contrast(rgba(getComputedStyle(node, "::placeholder").color), bg);
                ratios.push(placeholderRatio);
                if (placeholderRatio < 4.5) failures.push({ label: label + " placeholder", ratio: placeholderRatio });
            }
        }
        const marks = [...document.querySelectorAll(".time-segment,.bar-part,.swatch")].filter((node) => node.checkVisibility()).map((node) => {
            const style = getComputedStyle(node);
            if (node.classList.contains("dimensional-front") && style.stroke === "none") {
                const edge = node.closest("svg").querySelector(`.dimensional-edge.dimensional-tone-${node.parentElement.className.baseVal.replace("dimensional-tone-", "")}`);
                if (edge && node.parentElement.dataset.thin !== "true") {
                    return contrast(rgba(getComputedStyle(edge).stroke), background(edge.parentElement));
                }
                const ink = rgba(style.fill), bg = background(node.parentElement);
                const alpha = (ink[3] ?? 1) * Number(style.fillOpacity) * Number(style.opacity);
                return contrast(ink.slice(0, 3).map((value, index) => value * alpha + bg[index] * (1 - alpha)), bg);
            }
            return contrast(rgba(node.classList.contains("dimensional-front") ? style.stroke : style.backgroundColor), background(node.parentElement));
        });
        const controls = [...document.querySelectorAll("select,input:not([type=checkbox]):not([type=radio])")].filter((node) => node.checkVisibility()).map((node) => {
            const style = getComputedStyle(node);
            const outside = background(node.parentElement);
            let inside = background(node), edges = [rgba(style.borderTopColor)];
            // Search paints its face and perimeter in padding-box and border-box layers.
            if (style.backgroundClip === "padding-box, border-box" && style.backgroundImage.includes("linear-gradient")) {
                const stops = style.backgroundImage.match(/(?:rgba?|color)\([^)]*\)/g)?.map(rgba);
                if (!stops || stops.length < 4) throw new Error("Unrecognized layered control paint: " + node.id);
                inside = stops[0]; edges = stops.slice(2);
            }
            return Math.min(...edges.flatMap(edge => [contrast(edge, inside), contrast(edge, outside)]));
        });
        const focus = [...document.querySelectorAll(":focus-visible")].filter((node) => node.checkVisibility()).map((node) => contrast(rgba(getComputedStyle(node).outlineColor), background(node.parentElement)));
        const toggle = document.querySelector("#themePreference");
        const track = toggle.querySelector(".theme-track"), thumb = toggle.querySelector(".theme-thumb");
        const thumbBox = thumb.getBoundingClientRect();
        const iconContrast = Math.min(...[...track.querySelectorAll("svg")].map((icon) => {
            const box = icon.getBoundingClientRect(), x = box.x + box.width / 2;
            const surface = x >= thumbBox.left && x <= thumbBox.right ? thumb : track;
            return contrast(rgba(getComputedStyle(icon).color), background(surface));
        }));
        const thumbContrast = contrast(background(thumb), background(track));
        return { textMinimum: Math.min(...ratios), cardOutcomeRatios, markMinimum: marks.length ? Math.min(...marks) : null, controlMinimum: controls.length ? Math.min(...controls) : null, focusMinimum: focus.length ? Math.min(...focus) : null, iconContrast, thumbContrast, failures, overflow };
    });
    assert.deepEqual(result.failures, [], "Visible text must reach 4.5:1");
    assert.deepEqual(result.overflow, [], "No clipped or horizontally overflowing elements");
    if (result.markMinimum !== null) assert.ok(result.markMinimum >= 3, `Chart marks ${result.markMinimum}`);
    if (result.controlMinimum !== null) assert.ok(result.controlMinimum >= 3, `Control boundaries ${result.controlMinimum}`);
    if (result.focusMinimum !== null) assert.ok(result.focusMinimum >= 3, `Focus ring ${result.focusMinimum}`);
    assert.ok(result.iconContrast >= 3, `Theme icon ${result.iconContrast}`);
    assert.ok(result.thumbContrast >= 3, `Selected thumb ${result.thumbContrast}`);
    return result;
}

test("sliding switch shows both initial positions, toggles once per pointer/key activation and never shifts the header", { timeout: 60000 }, async () => fixture(async ({ context, url, requests }) => {
    const proof = [];
    for (const initial of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((theme) => {
            localStorage.setItem("workiq-evidence.theme", theme);
            const setItem = Storage.prototype.setItem;
            window.themeWrites = [];
            Storage.prototype.setItem = function (key, value) {
                window.themeWrites.push({ key, value });
                return setItem.call(this, key, value);
            };
            requestAnimationFrame(function captureFirstSwitchFrame() {
                const node = document.querySelector("#themePreference");
                const thumb = node?.querySelector(".theme-thumb");
                if (!thumb) { requestAnimationFrame(captureFirstSwitchFrame); return; }
                window.initialSwitch = {
                    theme: document.documentElement.dataset.evidenceTheme,
                    checked: node?.getAttribute("aria-checked"),
                    icons: node?.querySelectorAll("svg").length,
                    transform: getComputedStyle(thumb).transform,
                };
            });
        }, initial);
        await page.goto(url);
        await ready(page);
        await page.waitForFunction(() => window.initialSwitch);
        assert.deepEqual(await page.evaluate(() => window.initialSwitch), {
            theme: initial, checked: String(initial === "dark"), icons: 2,
            transform: `matrix(1, 0, 0, 1, ${initial === "dark" ? 26 : 0}, 0)`,
        }, "Saved appearance and thumb position are correct at first animation frame");
        const geometry = await switchPosition(page, initial);
        await shot(page, `switch-${initial}-${width}`);
        const layout = () => page.locator(".app-header, .brand, #themePreference, #navigationToggle").evaluateAll((nodes) => nodes.map((node) => {
            const box = node.getBoundingClientRect();
            return { id: node.id || node.className, x: box.x, y: box.y, width: box.width, height: box.height };
        }));
        const bounds = await layout(), requestCount = requests.length, route = page.url();
        const control = page.getByRole("switch", { name: "Dark theme", exact: true });
        assert.equal(await control.locator(".theme-thumb").evaluate((node) => getComputedStyle(node).transitionProperty), "transform");
        assert.equal(await control.locator(".theme-thumb").evaluate((node) => getComputedStyle(node).transitionDuration), "0.16s");
        const expectedWrites = [];
        let current = initial;
        for (const activate of [
            () => control.click({ position: { x: geometry.sun.centerX - geometry.control.x, y: geometry.sun.centerY - geometry.control.y } }),
            () => control.click({ position: { x: geometry.moon.centerX - geometry.control.x, y: geometry.moon.centerY - geometry.control.y } }),
            () => control.press("Enter"),
            () => control.press("Space"),
        ]) {
            await activate();
            current = current === "light" ? "dark" : "light";
            await switchPosition(page, current);
            expectedWrites.push({ key: "workiq-evidence.theme", value: current });
            assert.deepEqual(await page.evaluate(() => window.themeWrites), expectedWrites, "Exactly one preference write per activation, no other storage keys");
            assert.equal(await control.evaluate((node) => node === document.activeElement), true);
            assert.deepEqual(await layout(), bounds);
            assert.equal(page.url(), route);
            assert.equal(requests.length, requestCount, "Theme performs no data requests or mutations");
            await page.waitForTimeout(220);
            assert.equal(await page.getByRole("tooltip").isVisible(), false, "Activation cancels pending/visible tooltip, including its timer");
        }
        await control.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await control.evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
        assert.equal(await page.getByRole("tooltip").innerText(), `Switch to ${initial === "dark" ? "light" : "dark"} theme`);
        assert.equal(await control.getAttribute("aria-describedby"), "evidence-tooltip");
        proof.push({ theme: initial, width, geometry, contrast: await inspect(page), activations: expectedWrites.length, dataRequests: requests.length - requestCount });
        await page.keyboard.press("Escape");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await control.click();
        await switchPosition(page, initial === "dark" ? "light" : "dark");
        assert.equal(await control.locator(".theme-thumb").evaluate((node) => getComputedStyle(node).transitionDuration), "0s");
        assert.equal(await control.locator(".theme-thumb").evaluate((node) => node.getAnimations().length), 0);
        assert.deepEqual(await layout(), bounds);
        await page.close();
    }
    if (proofDir) await writeFile(path.join(proofDir, "switch-interaction.json"), JSON.stringify(proof, null, 2));
}));

test("one-click theme persists before paint, ignores later host/OS changes and synchronizes only concrete choices", { timeout: 30000 }, async () => fixture(async ({ context, url, requests }) => {
    const page = await context.newPage();
    await page.goto(url);
    await ready(page);
    await resolved(page, "light");
    await page.getByRole("switch", { name: "Dark theme", exact: true, checked: false }).click();
    await resolved(page, "dark");
    await page.getByRole("switch", { name: "Dark theme", exact: true, checked: true }).click();
    await resolved(page, "light");
    await chooseTheme(page, "Dark");
    await navigateMain(page, "analyze");
    await resolved(page, "dark");
    await page.addInitScript(() => requestAnimationFrame(() => { window.firstTheme = document.documentElement.dataset.evidenceTheme; }));
    await page.reload();
    await ready(page);
    assert.equal(await firstPaintTheme(page), "dark");
    await switchPosition(page, "dark");
    assert.equal(await page.locator("#themePreference").evaluate((node) => node.value), "dark");
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.theme")), "dark");
    const readsBefore = requests.length;
    const explicitBackground = await page.locator("body").evaluate(node => getComputedStyle(node).backgroundColor);
    await page.evaluate(() => {
        document.documentElement.setAttribute("data-color-mode", "light");
        const style = document.createElement("style");
        style.textContent = ":root,body{--background-color-default:#000;--text-color-default:#000;--text-color-muted:#000}";
        document.head.append(style);
    });
    await resolved(page, "dark");
    assert.equal(await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor), explicitBackground);
    await page.emulateMedia({ colorScheme: "light" });
    await resolved(page, "dark");
    await chooseTheme(page, "Light");
    await resolved(page, "light");
    await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "light"));
    await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "dark"));
    await resolved(page, "light");
    await page.evaluate(() => {
        document.documentElement.removeAttribute("data-color-mode");
        document.body.setAttribute("data-color-mode", "dark");
    });
    await resolved(page, "light");
    await page.evaluate(() => document.body.removeAttribute("data-color-mode"));
    await page.emulateMedia({ colorScheme: "dark" });
    await resolved(page, "light");
    assert.equal(requests.length, readsBefore, "Theme changes must not revalidate data or touch previews");
    const second = await context.newPage();
    await second.goto(url);
    await ready(second);
    await chooseTheme(second, "Dark");
    await switchPosition(page, "dark");
    await page.getByRole("switch", { name: "Dark theme", exact: true, checked: true }).click();
    await switchPosition(second, "light");
    for (const value of ["system", "invalid", null]) {
        await page.evaluate((value) => value === null ? localStorage.removeItem("workiq-evidence.theme") : localStorage.setItem("workiq-evidence.theme", value), value);
        await second.waitForTimeout(50);
        await resolved(second, "light");
    }
    await page.evaluate(() => localStorage.clear());
    await second.waitForTimeout(50);
    await resolved(second, "light");
    await chooseTheme(second, "Dark");
    await resolved(page, "dark");
}));

async function recordedApp(t) {
    const record = recordedInteraction("theme-report");
    record.toolCalls[0].startedAt = record.capturedAt = new Date().toISOString();
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const profile = await browser.newContext({ colorScheme: "light", reducedMotion: "reduce" });
    return { runtime, page: await profile.newPage(), profile };
}

test("a real switch in another panel changes appearance without invalidating a frozen report preview", async t => {
    const { runtime, page, profile } = await recordedApp(t), other = await profile.newPage();
    await page.goto(new URL("/reports", runtime.url).href);
    const made = page.waitForResponse(res => res.url().endsWith("/api/preview") && res.ok());
    await prepareLandingReport(page, "all");
    const { previewId } = await (await made).json();
    assert.ok(previewId);
    const report = page.locator("#reportReviewBody").frameLocator("iframe:visible").locator("h1");
    await report.waitFor();
    const title = await report.innerText(), url = page.url();
    assert.ok(title.trim());
    await other.goto(runtime.url); await ready(other);
    const operations = [];
    page.on("request", req => { if (req.method() === "POST" && /\/api\/(?:snapshot|cancel-preview|preview|privacy-review|export)$/.test(req.url())) operations.push(req.url()); });
    await other.getByRole("switch", { name: "Dark theme", exact: true }).click();
    await resolved(page, "dark");
    assert.equal(await page.locator("#themePreference").getAttribute("aria-checked"), "true");
    assert.equal(await report.innerText(), title);
    assert.equal(page.url(), url);
    assert.deepEqual(operations, [], "Theme sync does not replace or save the prepared report");
});

test("theme changes retain a filtered activity selection without touching source or review state", async t => {
    const { runtime, page } = await recordedApp(t), requests = [];
    page.on("request", req => { if (req.method() === "POST" && /\/api\/(?:snapshot|preview|export|collection\/now)$/.test(req.url())) requests.push(req.url()); });
    await page.goto(new URL("/?result=success", runtime.url).href);
    await ready(page);
    const card = page.locator("#activityList article").first();
    await card.getByRole("button", { name: "Add to report", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Report drafts", exact: true });
    await picker.getByRole("button", { name: "New draft", exact: true }).click();
    await picker.getByLabel("Draft name").fill("Lantern review");
    await picker.getByRole("button", { name: "Create draft and add" }).click();
    const membership = card.getByRole("button", { name: /In draft: Lantern review/ });
    await membership.waitFor();
    await page.getByRole("switch", { name: "Dark theme", exact: true }).focus();
    const route = page.url(), count = requests.length;
    const before = await page.locator("#activityList article").allTextContents();
    const filters = () => page.locator("#filters select").evaluateAll((nodes) => nodes.map((node) => [node.id, node.value]));
    const values = await filters();
    assert.ok(values.some(([id, value]) => id === "outcomeFilter" && value === "success"));
    await page.getByRole("switch", { name: "Dark theme", exact: true }).click();
    await resolved(page, "dark");
    assert.equal(page.url(), route);
    assert.deepEqual(await filters(), values);
    assert.deepEqual(await page.locator("#activityList article").allTextContents(), before);
    assert.equal(await membership.isVisible(), true);
    assert.equal(requests.length, count, "Only appearance changed; no source/review/export action");
});

test("quota failure shows a local-only notice and a later toggle saves after recovery", async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.addInitScript(() => {
        const original = Storage.prototype.setItem;
        window.restoreThemeStorage = () => { Storage.prototype.setItem = original; };
        Storage.prototype.setItem = function () { throw new DOMException("Synthetic quota failure", "QuotaExceededError"); };
    });
    await page.goto(url);
    await ready(page);
    assert.equal(await page.locator("#themeStorageNotice").isVisible(), true);
    await chooseTheme(page, "dark");
    await resolved(page, "dark");
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.theme")), null);
    await page.evaluate(() => window.restoreThemeStorage());
    await chooseTheme(page, "light");
    assert.equal(await page.locator("#themeStorageNotice").isVisible(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.theme")), "light");
}));

for (const [stored, host] of [["system", "dark"], [null, "invalid"], ["invalid", "dark"]]) {
    test(`${stored ?? "unset"} migrates before paint using ${host === "dark" ? "host" : "OS"} appearance exactly once`, async () => fixture(async ({ context, url, requests }) => {
        const page = await context.newPage();
        const expected = host === "dark" ? "dark" : "light";
        await page.addInitScript((stored) => {
            if (stored !== null && localStorage.getItem("workiq-evidence.theme") === null) localStorage.setItem("workiq-evidence.theme", stored);
            requestAnimationFrame(() => { window.firstTheme = document.documentElement.dataset.evidenceTheme; });
        }, stored);
        await page.goto(url);
        await ready(page);
        await resolved(page, expected);
        assert.equal(await firstPaintTheme(page), expected);
        assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.theme")), expected);
        const before = requests.length;
        await page.evaluate(() => {
            document.documentElement.setAttribute("data-color-mode", "light");
            document.body.setAttribute("data-color-mode", "dark");
        });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(50);
        await resolved(page, expected);
        assert.equal(requests.length, before);
        await page.reload();
        await ready(page);
        await resolved(page, expected);
        assert.equal(await firstPaintTheme(page), expected);
    }, host));
}

test("theme switch help names its next action without opening a menu at narrow and desktop sizes", async () => fixture(async ({ context, url }) => {
    for (const [theme, width] of [["light", 375], ["dark", 1200]]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(url);
        await ready(page);
        await chooseTheme(page, theme[0].toUpperCase() + theme.slice(1));
        const trigger = page.locator("#themePreference");
        assert.equal(await trigger.innerText(), "");
        assert.equal(await trigger.locator("svg").count(), 2);
        assert.equal(await trigger.locator(".theme-track, .theme-thumb").count(), 2);
        assert.equal(await page.locator("#themeMenu, #themeHelp, [data-theme-choice]").count(), 0);
        assert.equal(await trigger.getAttribute("aria-haspopup"), null);
        assert.equal(await trigger.getAttribute("aria-expanded"), null);
        const bounds = await trigger.boundingBox();
        assert.equal(bounds.width, 56);
        assert.equal(bounds.height, 44);
        const action = `Switch to ${theme === "light" ? "dark" : "light"} theme`;
        assert.equal(await trigger.getAttribute("aria-label"), "Dark theme");
        assert.equal(await trigger.getAttribute("aria-checked"), String(theme === "dark"));
        assert.equal(await trigger.getAttribute("role"), "switch");
        await page.mouse.move(0, 0);
        await trigger.hover();
        await page.getByRole("tooltip").waitFor();
        assert.equal(await page.getByRole("tooltip").innerText(), action);
        await page.keyboard.press("Escape");
        await page.mouse.move(0, 0);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await inspect(page);
        await resolved(page, theme);
        await page.close();
    }
}));

test("loading, error, storage denial, keyboard and reduced motion remain usable in both themes", { timeout: 60000 }, async () => fixture(async ({ context, url }) => {
    for (const [theme, width] of [["dark", 375], ["light", 1200]]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Blocked in synthetic test", "SecurityError"); } }));
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        await page.route("**/api/snapshot", async (route) => { await gate; await route.fulfill({ status: 503, json: { error: "Synthetic unavailable snapshot." } }); });
        await page.goto(url);
        await resolved(page, theme);
        await page.locator("#themeStorageNotice").waitFor({ state: "visible" });
        await inspect(page);
        await shot(page, `${theme}-${width}-loading`);
        release();
        await page.locator("#message.error").waitFor({ state: "visible" });
        await inspect(page);
        await shot(page, `${theme}-${width}-error`);
        await page.unroute("**/api/snapshot");
        const retry = page.getByRole("button", { name: /retry|try again|read stored activity/i });
        assert.equal(await retry.count(), 1, await page.locator("main").ariaSnapshot());
        await retry.click();
        await ready(page);
        await page.keyboard.press("Tab");
        await page.locator("#themePreference").focus();
        assert.equal(await page.locator("#themePreference").evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
        await inspect(page);
        await page.keyboard.press("Enter");
        await resolved(page, theme === "light" ? "dark" : "light");
        await page.keyboard.press("Space");
        await resolved(page, theme);
        assert.equal(await page.locator("#themeStorageNotice").isVisible(), true);
        assert.equal(await page.locator("#themePreference").evaluate((node) => getComputedStyle(node).transitionDuration), "0s");
        assert.equal(await page.locator("#themePreference .theme-thumb").evaluate((node) => getComputedStyle(node).transitionDuration), "0s");
        await page.close();
    }
}));
