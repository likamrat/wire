import test from "node:test";
import assert from "node:assert/strict";
import { reportContents } from "./report-journey-helpers.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { exportCatalogFor, navigateMain, selectActivityOption, chooseTheme, openActivitySessions, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";

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
            res.end(renderHtmlShell("a".repeat(64), "visual-fixture", UNBOUND_FIXTURE_BOOTSTRAP));
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
    await page.evaluate(() => document.fonts.ready);
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
        assert.equal(await page.locator("#projectContextHelp").count(), 0);
        assert.match(await page.locator("#projectFilter-control").ariaSnapshot(), /combobox "Copilot project"/);
        assert.equal(await page.locator("#projectFilter-control").getAttribute("aria-describedby"), null);
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
        assert.equal(await page.locator("#projectContextHelp").count(), 0, "No redundant project helper is retained in any view");
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
