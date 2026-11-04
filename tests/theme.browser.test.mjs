import test from "node:test";
import assert from "node:assert/strict";
import { reportContents } from "./report-journey-helpers.mjs";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { exportCatalogFor, navigateMain, chooseTheme, openActivitySessions, automaticScoreOffSummary, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";

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
        if (req.url === "/api/snapshot") return json({ ...state, exportCatalog: exportCatalogFor(records), analytics: { ...buildActivityAnalytics(records, input), revision: 1 } });
        if (req.url === "/api/evaluation/automatic/summary") return json(automaticScoreOffSummary());
        if (req.url === "/api/cancel-preview") {
            assert.deepEqual(input, { previewId: "synthetic-theme-preview" });
            return json({ cancelled: true });
        }
        if (req.url === "/api/preview") return json({
            previewId: "synthetic-theme-preview", records: [{}],
            privacy: { allSelectedFieldsScanned: true, reviewerConfirmed: false, originatingPrompts: 1, followUpPrompts: 0, toolArgumentObjects: 1, stringsScanned: 2, categories: {}, transformation: "Synthetic technical projection.", limitations: ["Synthetic test, not human approval."] },
            files: { "product-report.md": "# Synthetic activity report\n\nOriginal requests are withheld.\n\n## Recorded actions\n\n| Path | Count | Result |\n|---|---:|---|\n| /me/events | 1 | Worked |\n\n<details>\n<summary>Evidence limitations</summary>\n\n- A tool completion does not verify task correctness.\n\n</details>" },
        });
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
        assert.ok(requests.every((route) => ["/api/snapshot", "/api/preview", "/api/cancel-preview", "/api/evaluation/automatic/summary"].includes(route)), "Only reads, preview and in-memory cancellation; no disclosure attestations, imports or persistent mutations");
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
        return getComputedStyle(thumb).transform === `matrix(1, 0, 0, 1, ${expected === "dark" ? 36 : 0}, 0)`;
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
            assets: [...node.querySelectorAll("svg")].map((icon) => icon.dataset.fluentIcon),
        };
    });
    assert.equal(geometry.control.width, 80);
    assert.equal(geometry.control.height, 44);
    assert.equal(geometry.track.width, 76);
    assert.equal(geometry.track.height, 36);
    assert.equal(geometry.thumb.width, 32);
    assert.equal(geometry.thumb.height, 32);
    assert.deepEqual(geometry.assets, ["weather_sunny_20_regular", "weather_moon_20_regular"]);
    assert.equal(geometry.moon.centerX - geometry.sun.centerX, 36);
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
        function rgba(value) { return value.match(/[\d.]+/g).map(Number); }
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
        const ratios = [], failures = [], overflow = [];
        for (const node of document.body.querySelectorAll("*")) {
            if (!node.checkVisibility({ visibilityProperty: true }) || node.closest(".visually-hidden, .skip-link") || node.tagName === "OPTION") continue;
            const box = node.getBoundingClientRect();
            const scroller = node.closest(".dimensional-scroll,#countTable");
            if (!scroller && (box.right > innerWidth + 1 || box.left < -1)) overflow.push(node.id || node.className || node.tagName);
            if (scroller) {
                const bounds = scroller.getBoundingClientRect();
                if (bounds.right > innerWidth + 1 || bounds.left < -1) overflow.push("dimensional-scroll");
                if (scroller.scrollWidth > scroller.clientWidth && (getComputedStyle(scroller).overflowX !== "auto" || scroller.tabIndex !== 0)) overflow.push("inaccessible-chart-overflow");
            }
            const hasText = [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
            if (!hasText && !node.matches("input:not([type=checkbox]),select")) continue;
            const style = getComputedStyle(node), bg = background(node);
            const ratio = contrast(rgba(style.color), bg);
            const label = node.id || node.className || node.tagName;
            ratios.push(ratio);
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
            return Math.min(contrast(rgba(style.borderTopColor), background(node)), contrast(rgba(style.borderTopColor), background(node.parentElement)));
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
        return { textMinimum: Math.min(...ratios), markMinimum: marks.length ? Math.min(...marks) : null, controlMinimum: controls.length ? Math.min(...controls) : null, focusMinimum: focus.length ? Math.min(...focus) : null, iconContrast, thumbContrast, failures, overflow };
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
            transform: `matrix(1, 0, 0, 1, ${initial === "dark" ? 36 : 0}, 0)`,
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
            () => control.click({ position: { x: 22, y: 22 } }),
            () => control.click({ position: { x: 58, y: 22 } }),
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
    await page.locator("nav [data-nav=activity]").click();
    await resolved(page, "dark");
    await page.addInitScript(() => requestAnimationFrame(() => { window.firstTheme = document.documentElement.dataset.evidenceTheme; }));
    await page.reload();
    await ready(page);
    assert.equal(await firstPaintTheme(page), "dark");
    await switchPosition(page, "dark");
    assert.equal(await page.locator("#themePreference").evaluate((node) => node.value), "dark");
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), ["workiq-evidence.theme"]);
    const readsBefore = requests.length;
    await page.evaluate(() => {
        document.documentElement.setAttribute("data-color-mode", "light");
        const style = document.createElement("style");
        style.textContent = ":root,body{--background-color-default:#000;--text-color-default:#000;--text-color-muted:#000}";
        document.head.append(style);
    });
    await resolved(page, "dark");
    assert.equal(await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(20, 34, 54)");
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

test("a real switch in another panel changes appearance without invalidating a frozen report preview", { timeout: 15000 }, async () => fixture(async ({ context, url, requests }) => {
    const page = await context.newPage(), other = await context.newPage();
    await page.goto(url + "#activity");
    await ready(page);
    await page.locator("#activityList input").first().check();
    await navigateMain(page, "reports");
    await reportContents(page);
    await page.locator("#exportBtn").click();
    await page.locator(".attestation input").waitFor();
    await other.goto(url);
    await ready(other);
    const count = requests.length, route = page.url();
    const before = await page.locator("#reportReviewBody").innerHTML();
    await other.getByRole("switch", { name: "Dark theme", exact: true }).click();
    await resolved(page, "dark");
    assert.equal(await page.locator("#themePreference").getAttribute("aria-checked"), "true");
    assert.equal(await page.locator("#reportStage3").isVisible(), true);
    assert.equal(await page.locator("#reportReviewBody").innerHTML(), before, "Frozen preview and disclosure state are unchanged");
    assert.equal(await page.locator(".attestation input").isChecked(), false);
    assert.equal(await page.getByRole("button", { name: "Save report", exact: true, includeHidden: true }).isDisabled(), true);
    assert.equal(page.url(), route);
    assert.equal(requests.length, count, "No refetch, preview cancellation, review or export request on theme change");
}));

test("theme changes retain a filtered activity selection without touching source or review state", async () => fixture(async ({ context, url, requests }) => {
    const page = await context.newPage();
    await page.goto(url + "#activity?result=success&scope=history");
    await ready(page);
    await page.locator("#activityList input").first().check();
    await page.getByRole("switch", { name: "Dark theme", exact: true }).focus();
    const route = page.url(), count = requests.length;
    const before = await page.locator("#activityView").innerHTML();
    const filters = () => page.locator("#filters select").evaluateAll((nodes) => nodes.map((node) => [node.id, node.value]));
    const values = await filters();
    assert.ok(values.some(([id, value]) => id === "outcomeFilter" && value === "success"));
    await page.getByRole("switch", { name: "Dark theme", exact: true }).click();
    await resolved(page, "dark");
    assert.equal(page.url(), route);
    assert.deepEqual(await filters(), values);
    assert.equal(await page.locator("#activityView").innerHTML(), before);
    assert.equal(await page.locator("#activityList input").first().isChecked(), true);
    assert.equal(requests.length, count, "Only appearance changed; no source/review/export action");
}));

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

for (const stored of ["system", null, "invalid"]) for (const host of ["dark", "invalid"]) {
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

test("both themes cover all views, privacy preview, and 375/820/1200 layouts with rendered contrast", { timeout: 120000 }, async () => fixture(async ({ context, url }) => {
    const proof = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 640, 820, 1200]) {
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
        assert.equal(bounds.width, 80);
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
        const capture = async (view) => {
            await resolved(page, theme);
            proof.push({ theme, width, view, ...await inspect(page) });
            await shot(page, `${theme}-${width}-${view}`);
        };
        await capture("home-time");
        for (const [chart, view] of [["workload", "home-service"], ["endpoint", "home-path"]]) {
            await page.locator(`[data-chart=${chart}]`).click();
            await ready(page);
            await page.locator(".chart-row").first().hover();
            await inspect(page);
            await page.mouse.move(0, 0);
            await capture(view);
        }
        await page.locator(".chart-row").first().click();
        await ready(page);
        await page.locator("#activityList input").first().check();
        await capture("activity");
        await page.locator("#activityList .request-link").first().click();
        await ready(page);
        await capture("request");
        await page.goBack();
        await navigateMain(page, "reports");
        await reportContents(page);
        await capture("reports");
        await page.locator("#exportBtn").click();
        await page.locator(".attestation input").waitFor();
        await page.locator(".report-document > details > summary").first().click();
        await capture("privacy-preview");
        const steps = await page.locator(".privacy-steps li").evaluateAll((nodes) => nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top };
        }));
        for (let index = 1; index < steps.length; index++) if (steps[index].top === steps[index - 1].top) assert.ok(steps[index].left - steps[index - 1].right >= 12, "Disclosure steps do not overlap");
        assert.equal(await page.locator(".attestation input").isChecked(), false);
        assert.equal(await page.getByRole("button", { name: "Save report", exact: true, includeHidden: true }).isDisabled(), true);
        await page.goBack();
        await page.locator("#overlay").waitFor({ state: "hidden" });
        await page.locator("#activitySearch").fill("no synthetic match");
        await capture("empty");
        await page.locator("#activitySearch").fill("");
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await ready(page);
        await page.locator("#activityList .request-link").first().click({ timeout: 3000 });
        await resolved(page, theme);
        await page.close();
    }
    if (proofDir) await writeFile(path.join(proofDir, "rendered-contrast.json"), JSON.stringify(proof, null, 2));
}));

test("loading, error, storage denial, keyboard and reduced motion remain usable in both themes", { timeout: 60000 }, async () => fixture(async ({ context, url }) => {
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
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
        await page.getByRole("button", { name: "Try again" }).click();
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
        assert.equal(await page.locator(".theme-thumb").evaluate((node) => getComputedStyle(node).transitionDuration), "0s");
        await page.close();
    }
}));
