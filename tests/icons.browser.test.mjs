import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { styles } from "../web/styles.mjs";
import { chooseTheme } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_ICON_PROOF_DIR;
const scenarios = ["/me/messages", "/me/events", "/me/drive/root/children"].map((endpoint, index) => ({
    scenarioId: `synthetic-icon-${index}`, sourceSessionId: "synthetic-icon-session", sourceHost: "copilot-app",
    sourceSessionName: "Synthetic icon examples", projectId: "synthetic-icon-project", project: "Synthetic fixtures",
    capturedAt: `2026-09-${10 + index}T12:00:00Z`, workflowState: "ready_to_export",
    userPrompt: { text: `SYNTHETIC ONLY: Inspect example ${index}.`, status: "verbatim", provenance: "synthetic" },
    toolCalls: [{
        tool: "workiq-fetch", toolCallId: `synthetic-icon-call-${index}`, requestedApiPath: endpoint,
        requestArgs: { path: endpoint }, startedAt: `2026-09-${10 + index}T12:00:00Z`,
        toolSucceeded: true, reportedOutcome: "succeeded", apiResults: [],
    }],
}));

function primitives() {
    const ux = createEvidenceUX(icons);
    window.syntheticUX = ux;
    const main = document.querySelector("main");
    for (const name of Object.keys(icons)) {
        const control = document.createElement("button");
        control.className = "icon-action";
        control.dataset.fixtureIcon = name;
        control.setAttribute("aria-label", `Synthetic ${name}`);
        control.append(ux.icon(name));
        ux.tooltip(control, `Synthetic ${name}`);
        main.append(control);
    }
    main.append(ux.helpButton("synthetic category", "Synthetic category explanation."));
    const disabled = document.createElement("button");
    disabled.id = "unavailable";
    disabled.textContent = "Preview synthetic report";
    disabled.disabled = true;
    disabled.addEventListener("click", () => { window.syntheticDisabledActivations = (window.syntheticDisabledActivations || 0) + 1; });
    main.append(disabled);
    ux.explainDisabled(disabled, "Choose a synthetic request first.");
    const exact = "SYNTHETIC displayed text\n  exact spacing";
    main.append(ux.codeBlock(exact, { label: "Synthetic original", copyLabel: "Copy synthetic original" }));
    const dialog = document.querySelector("dialog");
    dialog.append(ux.codeBlock("[SYNTHETIC MASKED]", { label: "Synthetic report copy", copyLabel: "Copy synthetic report copy" }));
    const close = document.createElement("button");
    close.className = "icon-action";
    close.setAttribute("aria-label", "Close synthetic comparison");
    close.append(ux.icon("close"));
    close.addEventListener("click", () => dialog.close());
    ux.tooltip(close, "Close synthetic comparison");
    dialog.prepend(close);
    document.querySelector("#comparison").addEventListener("click", () => dialog.showModal());
}

async function fixture(run) {
    const errors = [], unexpected = [], requests = [];
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && ["/", "/primitives"].includes(req.url)) {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-icons'; style-src 'unsafe-inline'; font-src data:; connect-src 'self'; base-uri 'none'");
            return res.end(req.url === "/"
                ? renderHtmlShell("a".repeat(64), "icons")
                : `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style></head><body><main><h1>Synthetic icon fixture</h1><button id="comparison">Open synthetic comparison</button></main><dialog aria-label="Synthetic comparison"></dialog><script nonce="icons">const icons=${JSON.stringify(uxIcons)};const createEvidenceUX=${createEvidenceUX.toString()};(${primitives.toString()})();</script></body></html>`);
        }
        res.setHeader("Content-Type", "application/json");
        requests.push(req.url);
        if (req.method !== "POST" || req.url !== "/api/snapshot") {
            unexpected.push(`${req.method} ${req.url}`);
            res.statusCode = 403;
            return res.end('{"error":"Only synthetic snapshot reads are allowed."}');
        }
        let body = ""; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        res.end(JSON.stringify({
            boardId: "synthetic-icons", revision: 1, scenarios, exportCatalog: buildExportCatalog(scenarios),
            exports: [{ bundleId: "synthetic-saved", files: { "product-report.html": "synthetic.html", "product-report.pdf": "synthetic.pdf", "product-report.json": "synthetic.json", "product-report.md": "synthetic.md" } }],
            coverage: { since: "2026-09-01", until: "2026-09-30", notes: ["Synthetic only."] },
            analytics: { ...buildActivityAnalytics(scenarios, input), revision: 1 },
        }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ reducedMotion: "reduce" });
        context.setDefaultTimeout(5000);
        const origin = `http://127.0.0.1:${server.address().port}`;
        context.on("page", page => {
            page.on("pageerror", error => errors.push(error.message));
            page.on("request", request => { if (new URL(request.url()).origin !== origin) unexpected.push(request.url()); });
        });
        await context.addInitScript(() => {
            window.syntheticWrites = [];
            window.rejectSyntheticCopy = false;
            Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
                read: () => { throw new Error("No clipboard reads."); },
                readText: () => { throw new Error("No clipboard reads."); },
                writeText: async text => {
                    if (window.rejectSyntheticCopy) throw new DOMException("Synthetic denial.", "NotAllowedError");
                    window.syntheticWrites.push(text);
                },
            } });
        });
        if (proofDir) await mkdir(proofDir, { recursive: true });
        await run({ context, origin, requests });
        assert.deepEqual(errors, [], "No browser errors");
        assert.deepEqual(unexpected, [], "No real clipboard, report, disclosure, import, Graph or external requests");
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function inspectIcons(page, width) {
    const result = await page.locator("svg.wire-icon").evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => {
        const box = node.getBoundingClientRect(), size = Number(node.getAttribute("width")), control = node.closest("button");
        const target = control?.getBoundingClientRect();
        const color = getComputedStyle(node).color;
        let surface = node.parentElement, background;
        while (surface) {
            background = getComputedStyle(surface).backgroundColor;
            if (!["rgba(0, 0, 0, 0)", "transparent"].includes(background)) break;
            surface = surface.parentElement;
        }
        const thumb = control?.querySelector(".theme-thumb");
        if (thumb) {
            const bounds = thumb.getBoundingClientRect(), center = box.x + box.width / 2;
            if (center >= bounds.left && center <= bounds.right) background = getComputedStyle(thumb).backgroundColor;
        }
        const luminance = value => value.match(/[\d.]+/g).slice(0, 3).map(Number)
            .map(n => n / 255 <= .04045 ? n / 255 / 12.92 : ((n / 255 + .055) / 1.055) ** 2.4)
            .reduce((sum, n, index) => sum + n * [.2126, .7152, .0722][index], 0);
        const light = luminance(color), dark = luminance(background || "rgb(255,255,255)");
        return {
            asset: node.dataset.lucideIcon, size, width: box.width, height: box.height,
            hidden: node.getAttribute("aria-hidden"), focusable: node.getAttribute("focusable"),
            contrast: (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05),
            paths: [...node.querySelectorAll("path")].map(item => item.getAttribute("d")),
            iconOnly: !!control && !control.textContent.trim(), label: control?.getAttribute("aria-label"),
            helpOrCopy: control?.matches(".ux-help,.ux-copy"),
            metadataHelp: control?.matches(".metadata-help"), coarse: matchMedia("(pointer:coarse)").matches,
            hitWidth: target?.width, hitHeight: target?.height,
        };
    }));
    const known = Object.fromEntries([...Object.values(uxIcons), ...Object.values(dimensionalIcons)].map(svg => [
        /data-lucide-icon="([^"]+)"/.exec(svg)[1], [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(match => match[1]),
    ]));
    assert.ok(result.length > 0);
    for (const icon of result) {
        assert.deepEqual(icon.paths, known[icon.asset], `${icon.asset}: package geometry`);
        assert.ok([16, 20, 24].includes(icon.size));
        assert.equal(icon.width, icon.size, `${icon.asset}: native optical width`);
        assert.equal(icon.height, icon.size, `${icon.asset}: native optical height`);
        assert.equal(icon.hidden, "true");
        assert.equal(icon.focusable, "false");
        assert.ok(icon.contrast >= 3, `${icon.asset}: contrast ${icon.contrast}`);
        if (icon.iconOnly) assert.ok(icon.label, `${icon.asset}: contextual name`);
        if (icon.helpOrCopy) {
            const minimum = 44;
            assert.ok(icon.hitWidth >= minimum, `${icon.asset}: ${icon.metadataHelp ? "inline metadata" : "standard"} target width`);
            assert.ok(icon.hitHeight >= minimum, `${icon.asset}: ${icon.metadataHelp ? "inline metadata" : "standard"} target height`);
        }
    }
    return result;
}

test("Lucide primitives reject missing icons and keep copy, error and dialog feedback accessible", { timeout: 30000 }, async () => fixture(async ({ context, origin }) => {
    const page = await context.newPage();
    await page.goto(origin + "/primitives");
    const failures = await page.evaluate(() => ["missing", "constructor", "toString"].map(name => {
        try { window.syntheticUX.icon(name); return null; } catch (error) { return error.message; }
    }));
    assert.deepEqual(failures, ["Unknown Lucide icon: missing", "Unknown Lucide icon: constructor", "Unknown Lucide icon: toString"]);
    const malformed = await page.evaluate(() => {
        const bad = createEvidenceUX({ malformed: "<svg><broken", html: "<span>Not SVG</span>" });
        return ["malformed", "html"].map(name => { try { bad.icon(name); return null; } catch (error) { return error.message; } });
    });
    assert.deepEqual(malformed, ["Invalid Lucide icon: malformed", "Invalid Lucide icon: html"]);
    assert.equal(await page.locator('[data-fixture-icon="export"] [data-lucide-icon="file-output"]').count(), 1);
    const copy = page.getByRole("button", { name: "Copy synthetic original", exact: true });
    await copy.focus();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    const before = await copy.boundingBox();
    await copy.click();
    await page.waitForFunction(() => document.querySelector(".ux-copy").dataset.copyState === "success");
    assert.deepEqual(await copy.boundingBox(), before);
    assert.equal(await copy.locator('[data-lucide-icon="check"]').count(), 1);
    assert.equal((await copy.textContent()).trim(), "");
    assert.deepEqual(await page.evaluate(() => window.syntheticWrites), ["SYNTHETIC displayed text\n  exact spacing"]);
    await page.evaluate(() => { window.rejectSyntheticCopy = true; });
    await copy.click();
    await page.getByRole("alert").waitFor();
    assert.equal(await copy.getAttribute("data-copy-state"), "error");
    assert.equal(await copy.locator('[data-lucide-icon="copy"]').count(), 1);
    await page.getByRole("button", { name: "Open synthetic comparison", exact: true }).click();
    await page.getByRole("button", { name: "Copy synthetic report copy", exact: true }).focus();
    await page.getByRole("tooltip").waitFor();
    assert.equal(await page.locator("dialog .ux-tooltip").count(), 1);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog").evaluate(node => node.open), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog").evaluate(node => node.open), false);
}));

test("disabled explanations keep a visible Lucide info target without enabling the action", { timeout: 30000 }, async () => fixture(async ({ context, origin }) => {
    const page = await context.newPage();
    await page.goto(origin + "/primitives");
    const wrapper = page.locator(".ux-disabled-help");
    assert.equal(await wrapper.getAttribute("tabindex"), "0");
    assert.equal(await wrapper.getAttribute("role"), "group");
    const help = wrapper.getByRole("button", { name: "About unavailable Preview synthetic report", exact: true });
    assert.equal(await help.locator('[data-lucide-icon="info"]').count(), 1);
    await help.click();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("tooltip").textContent(), "Choose a synthetic request first.");
    assert.equal(await page.evaluate(() => window.syntheticDisabledActivations || 0), 0);
    assert.equal(await page.locator("#unavailable").isDisabled(), true);
    await page.keyboard.press("Escape");
    await page.locator("#unavailable").evaluate(node => { node.disabled = false; });
    await help.waitFor({ state: "hidden" });
    assert.equal(await wrapper.getAttribute("tabindex"), "-1");
    assert.equal(await wrapper.getAttribute("role"), null);
}));

test("icon hover, focus, disabled help and copy success/error retain contrast in Light and Dark", { timeout: 30000 }, async () => fixture(async ({ context, origin }) => {
    for (const theme of ["light", "dark"]) {
        const page = await context.newPage();
        await page.setViewportSize({ width: 1200, height: 1000 });
        await page.goto(origin + "/primitives");
        await page.evaluate(value => { document.documentElement.dataset.evidenceTheme = value; }, theme);
        const copy = page.getByRole("button", { name: "Copy synthetic original", exact: true });
        await copy.focus();
        assert.equal(await copy.evaluate(node => getComputedStyle(node).outlineStyle), "solid");
        await inspectIcons(page, 1200);
        await page.keyboard.press("Escape");
        await copy.hover();
        await inspectIcons(page, 1200);
        const before = await copy.boundingBox();
        await copy.click();
        await page.waitForFunction(() => document.querySelector(".ux-copy").dataset.copyState === "success");
        assert.deepEqual(await copy.boundingBox(), before);
        await inspectIcons(page, 1200);
        await page.evaluate(() => { window.rejectSyntheticCopy = true; });
        await copy.click();
        await page.getByRole("alert").waitFor();
        assert.deepEqual(await copy.boundingBox(), before);
        await inspectIcons(page, 1200);
        await page.close();
    }
}));

test("integrated navigation, charts, filters, formats and downloads use clean Lucide glyphs in both themes", { timeout: 60000 }, async () => fixture(async ({ context, origin }) => {
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: theme });
        for (const route of ["home", "home?chart=workload", "home?service=Calendar&from=2026-09-01&to=2026-09-30", "activity", "reports", "request?request=synthetic-icon-0&session=synthetic-icon-session"]) {
            await page.goto(`${origin}/#${route}`);
            await ready(page);
            await chooseTheme(page, theme);
            if (route === "home" && width === 375) {
                const controls = await page.locator(".header-inner button").evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => {
                    const b = node.getBoundingClientRect();
                    return { id: node.id, x: b.x, y: b.y, right: b.right, bottom: b.bottom };
                }));
                for (let i = 0; i < controls.length; i++) for (const other of controls.slice(i + 1)) {
                    const item = controls[i];
                    assert.ok(item.right <= other.x + 1 || other.right <= item.x + 1 || item.bottom <= other.y + 1 || other.bottom <= item.y + 1, `${item.id} must not overlap ${other.id}`);
                }
                await page.locator("#navigationToggle").click();
                await page.locator("#navigationDrawer").waitFor({ state: "visible" });
                assert.deepEqual(await page.locator("#navigationDrawer .primary-navigation a").evaluateAll(nodes => nodes.map(node => ({
                    route: node.dataset.nav, label: node.querySelector(".navigation-label").textContent, icon: node.querySelector("[data-lucide-icon]")?.dataset.lucideIcon,
                }))), [
                    { route: "analyze", label: "Analyze", icon: "chart-no-axes-combined" },
                    { route: "reports", label: "Reports", icon: "file-text" },
                    { route: "settings", label: "Settings", icon: "settings" },
                ]);
                await inspectIcons(page, width);
                await page.keyboard.press("Escape");
            }
            if (route === "reports") {
                await page.locator("#savedLibraryTitle").click();
                await page.locator("#bundleList .saved-report-summary").click();
                assert.equal(await page.locator('#contextSidebar button [data-lucide-icon="download"]').count(), 4);
                assert.equal(await page.locator('#formatOptions input[type="checkbox"]').count(), 4);
                await page.locator("#closeContextSidebar").click();
            }
            if (route.includes("service=Calendar")) {
                assert.equal(await page.locator("#filterChips button").count(), 2);
                assert.equal(await page.locator('#filterChips [data-lucide-icon="x"]').count(), 2);
                assert.equal(await page.locator('#resetView [data-lucide-icon="rotate-ccw"]').count(), 1);
                const chip = page.getByRole("button", { name: /^Remove date filter:/ });
                await chip.focus();
                await page.getByRole("tooltip").waitFor();
                await page.keyboard.press("Escape");
            }
            if (route.startsWith("request")) {
                const reader = page.locator(".request-original .full-text-toggle");
                if (await reader.getAttribute("aria-expanded") === "false") await reader.click();
            }
            const icons = await inspectIcons(page, width);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${width}: no page overflow`);
            measurements.push({ theme, width, route, icons });
            if (proofDir && ["home?chart=workload", "reports"].includes(route)) {
                await page.mouse.move(0, 0);
                await page.keyboard.press("Escape");
                await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
                await page.screenshot({ path: path.join(proofDir, `icons-${theme}-${width}-${route === "reports" ? "reports" : "services"}.png`), fullPage: true });
            }
        }
        await page.close();
    }
    if (proofDir) await writeFile(path.join(proofDir, "icon-measurements.json"), JSON.stringify(measurements, null, 2));
}));

test("theme icons keep fixed bounds and touch help uses the shared dismissible tooltip", { timeout: 30000 }, async () => fixture(async ({ context, origin }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 820, height: 1000 });
    await page.goto(origin);
    await ready(page);
    const before = await page.locator("#themePreference").boundingBox();
    for (const theme of ["dark", "light"]) {
        await page.locator("#themePreference").click();
        assert.equal(await page.locator("html").getAttribute("data-evidence-theme"), theme);
        assert.deepEqual(await page.locator("#themePreference").boundingBox(), before);
        for (const asset of ["sun", "moon"]) {
            assert.equal(await page.locator(`#themePreference [data-lucide-icon="${asset}"]`).count(), 1);
        }
        assert.equal(await page.locator("#themePreference").getAttribute("aria-checked"), String(theme === "dark"));
    }
    const touch = await context.browser().newContext({ viewport: { width: 820, height: 1000 }, hasTouch: true, isMobile: true });
    try {
        const mobile = await touch.newPage();
        await mobile.goto(origin);
        await ready(mobile);
        const help = mobile.getByRole("button", { name: "About Service", exact: true });
        const box = await help.boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44);
        await help.tap();
        await mobile.getByRole("tooltip").waitFor({ state: "visible" });
        await mobile.locator("#pageTitle").tap();
        await mobile.getByRole("tooltip").waitFor({ state: "hidden" });
        await inspectIcons(mobile, 820);
        await mobile.goto(origin + "/#request?request=synthetic-icon-0&session=synthetic-icon-session");
        await ready(mobile);
        const reader = mobile.locator(".request-original .full-text-toggle");
        if (await reader.getAttribute("aria-expanded") === "false") await reader.click();
        const icons = await inspectIcons(mobile, 820);
        assert.ok(icons.some(icon => icon.metadataHelp && icon.coarse && icon.hitWidth >= 32));
        assert.ok(icons.some(icon => icon.helpOrCopy && !icon.metadataHelp && icon.hitWidth >= 44));
    } finally { await touch.close(); }
}));

test("theme toggle retains focus without a tooltip blocking the mobile navigation icon", { timeout: 15000 }, async () => fixture(async ({ context, origin }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.goto(origin);
    await ready(page);
    const trigger = page.locator("#themePreference");
    await trigger.click();
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.getByRole("tooltip").isVisible(), false, "Restoring focus is not a new tooltip request");
    await page.locator("#navigationToggle").click();
    await page.locator("#navigationDrawer").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await trigger.hover();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.getByRole("tooltip").hover();
    assert.equal(await page.getByRole("tooltip").isVisible(), true, "A deliberate hover still opens hoverable help");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
}));
