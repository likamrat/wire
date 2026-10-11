import test from "node:test";
import assert from "node:assert/strict";
import { reportContents } from "./report-journey-helpers.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { exportCatalogFor, navigateMain, selectActivityOption, chooseTheme, openActivitySessions } from "./helpers.mjs";

const scenarios = ["IQ-OS", "skills", null].map((project, index) => ({
    scenarioId: `synthetic-visual-${index}`, sourceSessionId: `synthetic-session-${index}`, sourceHost: "copilot-app",
    sourceSessionName: `Synthetic session ${index + 1}`, project, projectId: project ? `synthetic-project-${index}` : null,
    capturedAt: `2026-01-${10 + index}T12:00:00Z`, isLegacy: false, workflowState: "ready_to_export",
    userPrompt: { text: `SYNTHETIC ONLY: Inspect calendar example ${index + 1}.`, status: "verbatim", provenance: "synthetic" },
    toolCalls: [{
        tool: "workiq-fetch", toolCallId: `synthetic-call-${index}`, requestedApiPath: "/me/events", requestArgs: { path: "/me/events" },
        toolSucceeded: true, reportedOutcome: "succeeded", startedAt: `2026-01-${10 + index}T12:00:00Z`, apiResults: [],
    }],
}));

async function fixture(run) {
    const requests = [], rejected = [], errors = [];
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/assets/assessment-contract.mjs") {
            res.setHeader("Content-Type", "text/javascript; charset=utf-8");
            res.end(await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8"));
            return;
        }
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-visual-fixture'; style-src 'unsafe-inline'; font-src data:; connect-src 'self'; base-uri 'none'");
            res.end(renderHtmlShell("a".repeat(64), "visual-fixture"));
            return;
        }
        res.setHeader("Content-Type", "application/json");
        requests.push(req.url);
        if (req.method !== "POST" || req.url !== "/api/snapshot") {
            rejected.push(`${req.method} ${req.url}`);
            res.writeHead(403).end(JSON.stringify({ error: "Only synthetic snapshot reads are allowed." }));
            return;
        }
        let body = ""; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        res.end(JSON.stringify({
            boardId: "synthetic-visual-board", revision: 1, scenarios, exports: [],
            exportCatalog: exportCatalogFor(scenarios),
            coverage: { since: "2026-01-01", until: "2026-01-31", notes: ["Synthetic visual fixture only."] },
            analytics: { ...buildActivityAnalytics(scenarios, input), revision: 1 },
        }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ colorScheme: "light", reducedMotion: "reduce" });
        const origin = `http://127.0.0.1:${server.address().port}`;
        context.on("page", (page) => {
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("request", (request) => {
                if (new URL(request.url()).origin !== origin) rejected.push(request.url());
            });
        });
        await run({ context, origin, requests });
        assert.deepEqual(errors, [], "No browser errors");
        assert.deepEqual(rejected, [], "No preview, disclosure, export, import or external requests");
    } finally {
        await browser?.close();
        await new Promise((resolve) => server.close(resolve));
    }
}

async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    const fontLoaded = await page.evaluate(async () => {
        const style = getComputedStyle(document.querySelector(".brand-caption"));
        await document.fonts.ready;
        return style.fontFamily.startsWith("Arial") && document.fonts.check(`${style.fontWeight} ${style.fontSize} Arial`);
    });
    assert.equal(fontLoaded, true, "Header proof uses the available reference-aligned system font");
    if (await page.locator("#moreFilters").isVisible() && await page.locator("#moreFilters").getAttribute("open") === null) await page.locator("#moreFilters>summary").click();
    await openActivitySessions(page);
}
async function dimensions(page, selector) {
    return page.locator(selector).evaluateAll((nodes) => nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
}
function equalPeers(peers, description) {
    assert.ok(peers.length > 0, `${description} exist`);
    for (const key of ["width", "height"]) {
        assert.ok(Math.max(...peers.map((p) => p[key])) - Math.min(...peers.map((p) => p[key])) < 1, `${description} share ${key}`);
    }
    assert.ok(peers.every((p) => p.height >= 44), `${description} have 44px hit targets`);
}

test("WIRE pairs its approved wordmark with a visible subtitle and accessible Home link", { timeout: 60000 }, async () => fixture(async ({ context, origin }) => {
    for (const theme of ["Light", "Dark"]) for (const width of [375, 820, 1200]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(origin);
        await ready(page);
        await chooseTheme(page, theme);
        for (const view of ["home", "activity", "reports", "request"]) {
            if (view === "request") {
                await navigateMain(page, "activity");
                await ready(page);
                await page.locator("#activityList .request-link").first().click();
            } else await navigateMain(page, view);
            await ready(page);
            assert.equal(await page.locator(`#${view}View`).isVisible(), true);
            const brand = page.getByRole("link", { name: "WIRE - Work IQ Request Explorer - Home", exact: true });
            assert.equal(await page.title(), "WIRE - Work IQ Request Explorer");
            const logo = brand.locator(`.brand-logo[data-brand-theme=${theme.toLowerCase()}]`);
            assert.equal(await brand.locator(".brand-logo:visible").count(), 1);
            assert.equal(await logo.isVisible(), true);
            assert.equal(await logo.getAttribute("aria-hidden"), "true");
            assert.equal(await logo.getAttribute("focusable"), "false");
            assert.equal(await logo.locator('[id$="-expression"]').count(), 0, "The approved wordmark has no face");
            assert.equal(await logo.locator('[id$="-letter-e"]').getAttribute("d"), "M426 201 V90 H489 M426 189 H489");
            const logoSize = await logo.boundingBox();
            assert.equal(logoSize.width, 165);
            assert.equal(logoSize.height, 52);
            assert.match(await brand.getAttribute("href"), /^#home(?:\?|$)/);
            assert.equal(await brand.getAttribute("href"), await page.locator("nav [data-nav=home]").getAttribute("href"));
            const title = await page.locator(".brand").evaluate((node) => {
                const colorProbe = document.createElement("span");
                colorProbe.style.color = "var(--ink)";
                node.append(colorProbe);
                const ink = getComputedStyle(colorProbe).color;
                colorProbe.remove();
                const walker = document.createTreeWalker(node.querySelector(".brand-caption"), NodeFilter.SHOW_TEXT);
                const characters = [];
                while (walker.nextNode()) {
                    const text = walker.currentNode;
                    const style = getComputedStyle(text.parentElement);
                    for (let offset = 0; offset < text.length; offset++) {
                        const range = document.createRange();
                        range.setStart(text, offset);
                        range.setEnd(text, offset + 1);
                        const rect = range.getBoundingClientRect();
                        characters.push({
                            weight: style.fontWeight, color: style.color, family: style.fontFamily,
                            size: style.fontSize, leading: style.lineHeight, verticalAlign: style.verticalAlign,
                            top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
                        });
                    }
                }
                const bounds = (element) => {
                    const rect = element.getBoundingClientRect();
                    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, center: rect.top + rect.height / 2 };
                };
                return {
                    text: node.querySelector(".brand-caption").textContent, characters, ink,
                    family: getComputedStyle(document.body).fontFamily,
                    caption: bounds(node.querySelector(".brand-caption")), logo: bounds([...node.querySelectorAll(".brand-logo")].find(logo => logo.checkVisibility())),
                    brand: bounds(node), nav: bounds(document.querySelector(innerWidth < 700 ? "#navigationToggle" : ".app-sidebar")),
                    main: bounds(document.querySelector("#main")), header: bounds(document.querySelector(".app-header")),
                    theme: bounds(document.querySelector("#themePreference")), refresh: bounds(document.querySelector("#refreshBtn")),
                };
            });
            const label = `${theme}/${width}/${view}`;
            assert.equal(title.text, "Work IQ Request Explorer", `${label}: visible acronym expansion`);
            assert.ok(title.caption.top >= title.logo.bottom, `${label}: subtitle sits underneath, not beside the wordmark`);
            const first = title.characters[0];
            assert.equal(first.weight, "600", `${label}: deliberate semibold branding`);
            assert.equal(first.color, title.ink, `${label}: readable foreground ink`);
            assert.equal(first.family, title.family, `${label}: existing UI font`);
            assert.equal(first.size, "13px", `${label}: slightly larger subtitle`);
            for (const char of title.characters) {
                for (const property of ["weight", "color", "family", "size", "leading", "verticalAlign", "top", "bottom"]) {
                    assert.equal(char[property], first[property], `${label}: consistent ${property} across every character`);
                }
                assert.ok(char.left >= title.brand.left && char.right <= title.brand.right + 1, `${label}: no title clipping`);
            }
            for (const box of [title.brand, title.nav, title.theme, title.refresh]) {
                assert.ok(box.left >= 0 && box.right <= width, `${label}: header stays in viewport`);
            }
            assert.ok(Math.abs(title.brand.center - title.theme.center) < 1, `${label}: title and appearance align`);
            assert.ok(title.brand.right <= title.theme.left, `${label}: title does not overlap appearance`);
            assert.ok(title.nav.right <= title.refresh.left, `${label}: navigation does not overlap refresh`);
            if (width >= 700) {
                assert.ok(Math.abs(title.brand.center - title.refresh.center) < 1, `${label}: desktop header remains one row`);
                assert.ok(title.nav.right <= title.main.left, `${label}: sidebar does not overlap content`);
                assert.ok(title.nav.top >= title.header.bottom - 1, `${label}: sidebar stays below header`);
            } else {
                assert.ok(Math.abs(title.theme.right - title.refresh.right) < 1, `${label}: icon aligns with the right header edge`);
                assert.ok(Math.abs(title.nav.center - title.refresh.center) < 1, `${label}: menu and refresh align`);
                assert.ok(title.nav.top >= title.brand.bottom, `${label}: mobile navigation remains below title`);
            }
            await brand.focus();
            await page.keyboard.press("Tab");
            await page.keyboard.press("Shift+Tab");
            assert.equal(await brand.evaluate((node) => getComputedStyle(node).outlineStyle), "solid", `${label}: visible keyboard focus`);
            await page.keyboard.press("Enter");
            await ready(page);
            assert.equal(await page.locator("#homeView").isVisible(), true, `${label}: title navigates Home`);
        }
        await page.close();
    }
}));

test("the complete wordmark subtitle stays on one line at narrow widths and enlarged text", { timeout: 60000 }, async () => fixture(async ({ context, origin }) => {
    for (const width of [320, 375, 820, 1200]) for (const theme of ["Light", "Dark"]) for (const scale of [1, 2]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(origin);
        await ready(page);
        await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        const brand = page.getByRole("link", { name: "WIRE - Work IQ Request Explorer - Home", exact: true });
        const caption = page.locator(".brand-caption");
        const logo = brand.locator(".brand-logo:visible");
        const metrics = await caption.evaluate(async node => {
            const style = getComputedStyle(node);
            await document.fonts.ready;
            const range = document.createRange();
            range.selectNodeContents(node);
            const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
            const header = document.querySelector(".header-inner");
            const children = [...header.children].filter(child => child.checkVisibility()).map(child => child.getBoundingClientRect());
            const luminance = color => {
                const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
                    const channel = value / 255;
                    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
                });
                return .2126 * r + .7152 * g + .0722 * b;
            };
            const foreground = luminance(style.color);
            const background = luminance(getComputedStyle(document.querySelector(".app-header")).backgroundColor);
            return {
                loaded: style.fontFamily.startsWith("Arial") && document.fonts.check(`${style.fontWeight} ${style.fontSize} Arial`),
                lines: new Set(rects.map(rect => rect.top.toFixed(2))).size,
                clipped: node.scrollWidth > node.clientWidth + 1,
                textRight: Math.max(...rects.map(rect => rect.right)),
                fontSize: Number.parseFloat(style.fontSize), weight: style.fontWeight,
                whiteSpace: style.whiteSpace, textOverflow: style.textOverflow,
                contrast: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05),
                overlap: children.some((a, index) => children.slice(index + 1).some(b =>
                    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)),
                headerHeight: document.querySelector(".app-header").getBoundingClientRect().height,
            };
        });
        const label = `${theme}/${width}/${scale}x`;
        assert.equal(metrics.loaded, true, `${label}: actual semibold Asta is loaded`);
        assert.equal(metrics.lines, 1, `${label}: the full expansion occupies exactly one line`);
        assert.equal(metrics.clipped, false, `${label}: no concealed text`);
        assert.ok(metrics.textRight <= width, `${label}: every glyph remains inside the viewport`);
        assert.equal(metrics.whiteSpace, "nowrap");
        assert.notEqual(metrics.textOverflow, "ellipsis");
        assert.equal(metrics.weight, "600");
        assert.ok(Math.abs(metrics.fontSize - Math.min(13 * scale, (width - 40) / 12)) < .01, `${label}: measured narrow-viewport fit`);
        assert.ok(metrics.contrast >= 4.5, `${label}: caption contrast`);
        assert.equal(metrics.overlap, false, `${label}: surrounding controls move rather than overlap`);
        if (width >= 820 && scale === 1) assert.ok(metrics.headerHeight <= 80, `${label}: compact desktop header`);
        assert.equal(await caption.innerText(), "Work IQ Request Explorer");
        assert.equal(await logo.getAttribute("data-brand-theme"), theme.toLowerCase());
        const a = await caption.boundingBox(), b = await logo.boundingBox();
        assert.equal(b.width, 165, "Approved artwork width is not reduced to make text fit");
        assert.equal(b.height, 52, "Approved artwork height remains unchanged");
        assert.ok(a.y >= b.y + b.height, "Subtitle remains below the logo");
        assert.ok(a.x >= 0 && a.x + a.width <= width, "One-line caption stays within the viewport");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const ids = await brand.locator("[id]").evaluateAll(nodes => nodes.map(node => node.id));
        assert.equal(ids.length, new Set(ids).size);
        await page.close();
    }
}));

test("appearance toggle preserves keyboard semantics, focus, layout and in-progress report choices", { timeout: 30000 }, async () => fixture(async ({ context, origin, requests }) => {
    const page = await context.newPage();
    await page.goto(origin + "/#activity");
    await ready(page);
    await page.locator("#activityList input").first().check();
    await navigateMain(page, "reports");
    await reportContents(page);
    await page.locator("input[name=promptMode][value=original]").check();
    await page.locator(".format-choices input[value=pdf]").check();
    await page.locator("#formatOptions details > summary").click();
    await page.locator("#manualTerms").fill("Synthetic masking draft");
    const requestCount = requests.length;
    const route = page.url();
    const trigger = page.locator("#themePreference");
    const bounds = await trigger.boundingBox();
    assert.equal(await trigger.getAttribute("aria-haspopup"), null);
    assert.equal(await trigger.getAttribute("aria-expanded"), null);
    await trigger.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await trigger.evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
    assert.equal(await page.getByRole("tooltip").innerText(), "Switch to dark theme");
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement.id), "themePreference");
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    await page.keyboard.press("Enter");
    assert.equal(await trigger.getAttribute("aria-label"), "Dark theme");
    assert.equal(await trigger.getAttribute("role"), "switch");
    assert.equal(await trigger.getAttribute("aria-checked"), "true");
    assert.equal(await page.evaluate(() => document.activeElement.id), "themePreference");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.evidenceTheme), "dark");
    await page.keyboard.press("Space");
    assert.equal(await trigger.getAttribute("aria-label"), "Dark theme");
    assert.equal(await trigger.getAttribute("aria-checked"), "false");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.evidenceTheme), "light");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "refreshBtn");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "themePreference");
    await trigger.click();
    await page.locator("#pageTitle").click({ position: { x: 4, y: 4 } });
    assert.equal(await page.locator("#themeMenu, [role=menuitemradio]").count(), 0);
    assert.deepEqual(await trigger.boundingBox(), bounds, "Theme icons never move peer controls");
    assert.equal(await page.locator("input[name=promptMode][value=original]").isChecked(), true);
    assert.equal(await page.locator(".format-choices input[value=pdf]").isChecked(), true);
    assert.equal(await page.locator("#manualTerms").inputValue(), "Synthetic masking draft");
    assert.equal(await page.locator("#previewSelectionSummary").innerText(), "One report · 1 request group included");
    assert.equal(page.url(), route, "Theme does not replace route state");
    assert.equal(requests.length, requestCount, "Theme never reloads activity or invalidates a report");
}));

test("Copilot project context and equal report controls stay readable at narrow and wide sizes", { timeout: 60000 }, async () => fixture(async ({ context, origin }) => {
    for (const theme of ["Light", "Dark"]) for (const width of [375, 820, 1200]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(origin + "/#activity");
        await ready(page);
        await chooseTheme(page, theme);
        assert.match(await page.locator("#projectContextHelp").textContent(), /Copilot project context, not necessarily a GitHub repository/);
        assert.match(await page.locator("#projectFilter-control").ariaSnapshot(), /combobox "GitHub Copilot project"/);
        assert.equal(await page.locator("#projectFilter-control").getAttribute("aria-describedby"), "projectContextHelp");
        assert.deepEqual((await page.locator(".session-meta .project-context strong").allTextContents()).sort(), ["IQ-OS", "skills"]);
        assert.equal(await page.locator("#activityList .project-context.unscoped").innerText(), "Copilot chat without a project");
        assert.equal(await page.locator(".session-meta").count(), 3);
        assert.equal(await page.locator(".project-context a").count(), 0, "Project names are not invented repository links");
        await page.locator("#activityList .request-link").last().click();
        await ready(page);
        assert.match(await page.locator(".request-intro .project-context").innerText(), /Copilot project\s+IQ-OS/);
        await page.goBack();
        await ready(page);
        await selectActivityOption(page, "projectFilter", "unscoped");
        await ready(page);
        assert.equal(await page.locator("#activityList .request-link").count(), 1);
        await page.locator("#activityList .request-link").click();
        await ready(page);
        assert.equal(await page.locator(".request-intro .project-context").innerText(), "Copilot chat without a project");
        await page.goBack();
        await ready(page);
        await page.locator("#activityList input").check();
        await navigateMain(page, "reports");
        await reportContents(page);
        assert.equal(await page.locator("#projectContextHelp").isVisible(), false, "Reports omit unrelated context prose");
        const modes = await dimensions(page, ".prompt-choice");
        const formats = await dimensions(page, ".format-choices label");
        assert.equal(modes.length, 3);
        assert.equal(formats.length, 4);
        equalPeers(modes, "Prompt-mode rows");
        equalPeers(formats, "Format pills");
        const columns = await dimensions(page, ".report-options fieldset");
        assert.ok(Math.abs(columns[0].width - columns[1].width) < 1, "Report columns have equal widths");
        if (width >= 1000) assert.ok(Math.abs(columns[0].y - columns[1].y) < 1, "Wide-content legends align");
        else assert.ok(columns[1].y >= columns[0].y + columns[0].height, "Narrow reports stack beside the sidebar");
        const overflow = await page.evaluate(() => [...document.body.querySelectorAll("*")].filter((node) => node.checkVisibility() && !node.closest(".visually-hidden,.skip-link")).filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width && (rect.right > innerWidth + 1 || rect.left < -1);
        }).map((node) => node.id || node.className || node.tagName));
        assert.deepEqual(overflow, [], `${theme}/${width}: no clipping`);
        await page.close();
    }
}));
