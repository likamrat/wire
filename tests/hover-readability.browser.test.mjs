import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { exportCatalogFor, fixture, chooseTheme, navigateMain, navigateSettings, openActivitySessions, selectActivityOption, revealStoredRefresh, openSourceEditor } from "./helpers.mjs";
import { chooseReportScope, reportContents } from "./report-journey-helpers.mjs";
import { contrast } from "./color-measurements.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";

const proofDir = process.env.WORKIQ_HOVER_PROOFS;
const records = Array.from({ length: 14 }, (_, index) => ({
    ...fixture(`hover-${index}`),
    workflowState: "captured",
    sourceSessionName: "Synthetic hover examples",
    userPrompt: { text: `Synthetic request ${index + 1}: inspect calendar examples.`, status: "full", provenance: "human-authored" },
    toolCalls: [{ ...fixture().toolCalls[0], toolCallId: `hover-call-${index}`, startEventId: `hover-start-${index}`,
        toolSucceeded: index % 3 === 0 ? true : index % 3 === 1 ? false : null,
        reportedOutcome: index % 3 === 0 ? "succeeded" : index % 3 === 1 ? "failed" : "unknown",
        apiResults: [],
    }],
}));

async function setup(t) {
    const requests = [], errors = [];
    let status = {
        state: "collecting-on-interval", revision: 1, configVersion: "synthetic-unchanged",
        config: { approved: true, enabled: true, appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state", pollSeconds: 5, windowDays: 30 },
        connected: true, cadence: { pollSeconds: 5 }, metrics: {},
        discovery: { counts: { sessions: 1, dispositions: { eligible: 1 }, skippedByLimit: 0, unmappedWorkspaces: 0 } },
        historyCoverage: { eligible: 1, readable: 1, unavailable: 0, limited: 0, affected: 0, pending: 0 },
    };
    const preview = {
        previewId: "synthetic-hover-preview", records: [{}], promptMode: "masked", formats: ["markdown"],
        privacy: { allSelectedFieldsScanned: true, reviewerConfirmed: false, originatingPrompts: 1, followUpPrompts: 0, toolArgumentObjects: 1,
            stringsScanned: 2, categories: {}, transformation: "Synthetic only.", limitations: ["Synthetic fixture, not human approval."] },
        files: { "product-report.md": "# Synthetic report\n\nNo workplace content.\n\n[Documentation](https://example.invalid)\n\n## Actions\n\nSynthetic calendar examples." },
        promptReview: [{ key: "hover-0:request", label: "Synthetic request", representation: "masked", status: "full",
            original: "Synthetic calendar examples.", text: "Synthetic calendar examples.", segments: [{ text: "Synthetic calendar examples." }], changes: [], omitted: false }],
    };
    const bundle = { bundleId: "synthetic-hover-bundle", bundleDir: "C:\\synthetic\\report", files: { "product-report.md": "C:\\synthetic\\report\\product-report.md" } };
    const state = {
        boardId: "synthetic-hover-board", revision: 1, scenarios: records, exports: [],
        coverage: { since: "2026-09-01", until: "2026-10-05", notes: ["Synthetic only."] },
    };
    const server = createServer(async (request, response) => {
        if (request.method === "GET") {
            response.setHeader("Content-Type", "text/html");
            response.end(renderHtmlShell("a".repeat(64), "hover-fixture"));
            return;
        }
        requests.push(request.url);
        let text = ""; for await (const chunk of request) text += chunk;
        const input = JSON.parse(text);
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/api/collection/status") return response.end(JSON.stringify(status));
        if (request.url === "/api/preview" || request.url === "/api/privacy-review") {
            return response.end(JSON.stringify({ ...preview, privacy: { ...preview.privacy, reviewerConfirmed: request.url === "/api/privacy-review" } }));
        }
        if (request.url === "/api/cancel-preview") return response.end(JSON.stringify({ cancelled: true }));
        if (request.url === "/api/export") {
            state.exports = [bundle];
            return response.end(JSON.stringify({ bundle }));
        }
        if (request.url === "/api/snapshot") {
            response.end(JSON.stringify({ ...state, exportCatalog: exportCatalogFor(records),
                collection: status, analytics: { ...buildActivityAnalytics(records, input), revision: 1 } }));
            return;
        }
        response.statusCode = 403;
        response.end(JSON.stringify({ error: "Only synthetic snapshot reads are allowed." }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 960 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    if (proofDir) await mkdir(proofDir, { recursive: true });
    t.after(async () => {
        if (proofDir && !t.passed) await writeFile(path.join(proofDir, "fixture-state.txt"), await page.locator("body").innerText());
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        assert.deepEqual(errors, []);
        assert.ok(requests.every(url => ["/api/snapshot", "/api/collection/status", "/api/preview", "/api/privacy-review", "/api/cancel-preview", "/api/export"].includes(url)),
            "Only the in-memory fixture serves synthetic report states; no collection writes, clipboard, imports, recording or external requests");
    });
    return { page, url: `http://127.0.0.1:${server.address().port}/`, setStatus: patch => { status = { ...status, ...patch }; } };
}

// Pseudo-element pill paint is behind its label, not in the ancestor background chain.
async function measure(locator) {
    return locator.evaluate(root => {
        const rgba = value => {
            if (value === "transparent") return [0, 0, 0, 0];
            const parts = value.match(/[\d.]+/g)?.map(Number);
            if (!parts || !/^rgba?\(/.test(value)) throw new Error(`Unsupported painted color ${value}`);
            return [...parts.slice(0, 3), parts[3] ?? 1];
        };
        const blend = (front, back) => front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3]));
        function background(node) {
            if (!node) return [255, 255, 255];
            const style = getComputedStyle(node);
            let result = blend(rgba(style.backgroundColor), background(node.parentElement));
            const before = getComputedStyle(node, "::before");
            if (before.content !== "none" && before.position === "absolute" && before.zIndex === "-1") result = blend(rgba(before.backgroundColor), result);
            return result;
        }
        function ratio(a, b) {
            const luminance = color => color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
                .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
            const x = luminance(a), y = luminance(b);
            return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
        }
        const results = [];
        for (const node of [root, ...root.querySelectorAll("*")]) {
            if (!node.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || node.closest(".visually-hidden")) continue;
            const text = [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
            const icon = node.matches("svg.fluent-icon,.select-chevron,.select-check,.theme-track svg");
            if (!text && !icon && !node.matches("input:not([type=checkbox]):not([type=radio]),textarea")) continue;
            const style = getComputedStyle(node);
            let bg = background(node);
            if (node.matches(".theme-track svg")) {
                const thumb = node.closest(".theme-track").querySelector(".theme-thumb");
                const box = node.getBoundingClientRect(), selected = thumb.getBoundingClientRect();
                if (box.x + box.width / 2 > selected.left && box.x + box.width / 2 < selected.right) bg = background(thumb);
            }
            let opacity = 1;
            for (let parent = node; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
            const iconPaint = icon ? getComputedStyle(node.querySelector("path") || node) : null;
            const foreground = iconPaint ? iconPaint.fill === "none" ? iconPaint.stroke : iconPaint.fill : style.color;
            const fg = rgba(foreground); fg[3] *= opacity;
            const painted = blend(fg, bg);
            results.push({ kind: icon ? "icon" : "text", label: node.id || (typeof node.className === "string" ? node.className : node.tagName),
                foreground, background: bg, opacity, ratio: ratio(painted, bg) });
            if (node === root && node.matches(":focus-visible")) {
                const before = getComputedStyle(node, "::before");
                const outline = style.outlineStyle !== "none" ? style : before;
                if (outline.outlineStyle !== "none") results.push({ kind: "icon", label: "focus ring",
                    foreground: outline.outlineColor, background: background(node.parentElement),
                    ratio: ratio(rgba(outline.outlineColor).slice(0, 3), background(node.parentElement)) });
            }
        }
        return results;
    });
}

async function inspectStates(page, locator, family, matrix) {
    assert.equal(await locator.count(), 1, `${family}: one mounted representative`);
    assert.equal(await locator.isVisible(), true, `${family}: visible representative`);
    await locator.scrollIntoViewIfNeeded();
    const record = async state => {
        const painted = await measure(locator);
        assert.ok(painted.length, `${family} has measured text or meaningful icons`);
        matrix.push({ theme: await page.locator("html").getAttribute("data-evidence-theme"), family, state, painted });
    };
    await page.mouse.move(0, 0);
    await locator.evaluate(node => document.activeElement?.blur());
    await record("rest");
    await locator.hover();
    assert.equal(await locator.evaluate(node => node.matches(":hover")), true);
    await record("hover");
    if (!await locator.isDisabled()) {
        await page.mouse.down();
        await record("pressed");
        await page.mouse.move(0, 0); await page.mouse.up();
        if (await locator.evaluate(node => node.matches("button,a,input,summary,[tabindex]"))) {
            await locator.focus(); await page.keyboard.press("Shift");
            await locator.hover();
            await record("focus-visible+hover");
            const ring = await locator.evaluate(node => {
                const target = node.matches(".select-trigger") ? getComputedStyle(node, "::before") : getComputedStyle(node);
                return { visible: node.matches(":focus-visible"), width: parseFloat(target.outlineWidth), style: target.outlineStyle };
            });
            assert.ok(ring.visible && ring.width >= 1 && ring.style !== "none", `${family}: keyboard focus retained`);
        }
    }
    await page.mouse.move(0, 0);
    await locator.evaluate(node => document.activeElement?.blur());
    await record("leave");
}

test("component family hover matrix uses mounted routes and their effective painted surfaces", { timeout: 180000 }, async t => {
    const { page, url, setStatus } = await setup(t), matrix = [];
    const ready = () => page.locator('#workspace[aria-busy="false"]').waitFor();
    const inspect = (selector, family) => inspectStates(page, page.locator(selector).first(), family, matrix);
    for (const theme of ["light", "dark"]) {
        await page.goto(url + "#home?scope=all"); await ready(); await chooseTheme(page, theme);
        await inspect("#pageAction", "secondary chooser link pill");
        await revealStoredRefresh(page);
        await inspect("#refreshBtn", "quiet refresh");
        await inspect("#checkActivity", "primary fresh activity");
        await inspect("#themePreference", "appearance switch");
        await inspect(".primary-navigation a[aria-current=page]", "selected navigation pill");
        await inspect(".primary-navigation a[data-nav=activity]", "unselected navigation pill");
        await inspect("nav [data-nav=reports]", "Reports navigation");
        await inspect(".view-switch button[aria-pressed=true]", "selected chart tab");
        await inspect(".view-switch button[aria-pressed=false]", "unselected chart tab");
        await inspect("[data-select-id=dateFilter]", "period select trigger");
        await inspect("[data-select-id=bucketFilter]", "time scale quiet trigger");
        await inspect("#outcomeFilter-control", "result filter");
        for (const tone of ["success", "failure", "unknown"]) {
            await selectActivityOption(page, "outcomeFilter", tone); await ready();
            await inspect("#outcomeFilter-control", `${tone} result filter`);
        }
        await inspect("#clearResultFilter", "result clear tooltip trigger");
        await page.mouse.move(0, 0); await page.locator("#clearResultFilter").hover();
        await page.getByRole("tooltip").waitFor();
        matrix.push({ theme, family: "tooltip portal", state: "hover", painted: await measure(page.getByRole("tooltip")) });
        await page.keyboard.press("Escape");
        await page.locator("#clearResultFilter").click(); await ready();
        await inspect("#tableDisclosure>summary", "exact table disclosure");
        if (!await page.locator("#tableDisclosure").evaluate(node => node.open)) await page.locator("#tableDisclosure>summary").click();
        await inspect(".exact-data-table .chart-data-action", "exact table drilldown");
        await inspect(".exact-data-table tbody tr", "hovered exact table row");
        await inspect("[data-select-id=serviceFilter]", "filter select trigger");
        await page.locator("[data-select-id=serviceFilter]").click();
        await inspect(".select-popup [aria-selected=true]", "selected option");
        await inspect(".select-popup [aria-selected=false]", "unselected option");
        await page.locator("[data-select-id=serviceFilter]").focus();
        await page.keyboard.press("Escape");
        await selectActivityOption(page, "serviceFilter", "Calendar"); await ready();
        await inspect(".filter-chip", "applied filter chip");
        await navigateMain(page, "activity"); await ready();
        await inspect(".session-toggle", "chat disclosure");
        await inspect(".session-drill", "chat drilldown link");
        for (const tone of ["success", "failure"]) await inspect(`.session-summary .result-link[data-outcome=${tone}]`, `${tone} result link pill`);
        await inspect(".session-summary .recorded-result[data-outcome=unknown]", "unknown recorded result");
        await openActivitySessions(page);
        await inspect(".request-row", "request row with nested label");
        await inspect(".request-row .request-link", "request navigation link");
        await inspect(".list-pager button:not(:disabled)", "pagination action");
        await page.locator(".request-row .request-link").first().click(); await ready();
        await inspect("#contextBack", "request back pill");
        const requestDisclosure = page.locator("#requestView details>summary");
        for (const summary of await requestDisclosure.all()) if (await summary.isVisible()) await summary.click();
        if (await page.locator(".ux-copy:visible").count()) await inspect(".ux-copy:visible", "copy exact text icon");
        await navigateMain(page, "reports"); await ready();
        await chooseReportScope(page, "selected");
        await inspect(".report-entry-actions .primary", "primary choose requests");
        await inspect(".report-step[aria-current=step]", "current report stage");
        await inspect(".report-step:disabled", "disabled report stage");
        await inspect(".report-stage-actions button:disabled", "disabled primary action");
        await chooseReportScope(page, "all");
        await inspect(".scope-choice:has(input:checked)", "selected report scope");
        await inspect(".scope-choice:has(input:not(:checked))", "unselected report scope");
        await inspect(".report-stage-actions .primary", "primary continue");
        if (!await page.locator("#reportRequests").evaluate(node => node.open)) await page.locator("#reportRequests>summary").click();
        await inspect(".report-entry .actions button", "optional review label action");
        await reportContents(page);
        await inspect(".prompt-choice:has(input:checked)", "selected prompt choice");
        await inspect(".prompt-choice:has(input:not(:checked))", "unselected prompt choice");
        await inspect(".format-choices label:has(input:checked)", "selected report format");
        await inspect(".format-choices label:has(input:not(:checked))", "unselected report format");
        await inspect("#exportBtn", "primary scan preview");
        await page.locator("#exportBtn").click();
        await page.locator("#reportsView[data-report-phase=ready]").waitFor();
        await inspect(".report-review-body>.attestation", "disclosure attestation");
        await inspect(".report-review-body button[data-review-control]", "disabled review action");
        await page.locator(".report-copy-inspection>summary").click();
        await inspect(".prompt-comparison>summary", "report copy disclosure");
        await inspect(".prompt-original .ux-copy", "original copy icon");
        await inspect(".report-document", "report preview text surface");
        await page.locator(".attestation input[data-review-control]").check();
        await inspect(".report-review-body button[data-review-control]", "primary disclosure review");
        await page.locator(".report-review-body button[data-review-control]").click();
        await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
        await inspect("#reportStage3 button[data-review-control]", "primary confirm save");
        await page.locator("#reportStage3 button[data-review-control]").click();
        await page.locator("#reportsView[data-report-phase=saved]").waitFor();
        await inspect(".report-downloads button", "saved download action");
        await navigateMain(page, "settings"); await ready();
        await inspect("#editSource", "change source");
        await inspect("#pauseCollection", "pause collection");
        await inspect("#collectNow", "quiet collect now");
        await navigateSettings(page, "collection");
        await inspect("#saveCollection", "disabled save preferences");
        await selectActivityOption(page, "collectionCadence", "15");
        await inspect("#saveCollection", "dirty save preferences");
        await inspect("#cancelPreferences", "discard preferences");
        await page.locator("#cancelPreferences").click();
        await navigateSettings(page, "connection");
        await openSourceEditor(page);
        await page.locator("#sourceDatabase").fill("C:\\synthetic\\different.db");
        await inspect("#sourceDatabase", "source path input");
        await inspect("#connectCollection", "primary source approval");
        await inspect("#cancelSource", "cancel source review");
        await page.locator("#cancelSource").click();
        setStatus({ config: null, state: "not-configured", connected: false });
        await page.goto(url + "#settings"); await ready(); await chooseTheme(page, theme);
        await inspect("#reviewSource", "primary unconnected setup");
        setStatus({ config: { approved: true, enabled: true, appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state", pollSeconds: 5, windowDays: 30 }, state: "collecting-on-interval", connected: true });
    }
    if (proofDir) await writeFile(path.join(proofDir, "family-matrix.json"), JSON.stringify(matrix, null, 2));
    const failures = matrix.flatMap(row => row.painted.filter(item => item.ratio < (item.kind === "icon" ? 3 : 4.5)).map(item => ({ theme: row.theme, family: row.family, state: row.state, ...item })));
    assert.deepEqual(failures, [], "All measured label/icon paint must remain readable");
});

test("actual report choose-requests primary retains readable text when hovered", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    const results = [];
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const control = page.getByRole("button", { name: "Choose requests in Activity", exact: true });
        await control.hover();
        const painted = await measure(control);
        results.push({ theme, state: "hover", painted });
        if (proofDir) await control.screenshot({ path: path.join(proofDir, `choose-requests-${theme}.png`) });
    }
    if (proofDir) await writeFile(path.join(proofDir, "primary-regression.json"), JSON.stringify(results, null, 2));
    for (const result of results) assert.ok(result.painted.every(item => item.ratio >= 4.5), JSON.stringify(result));
});

test("primary foreground and fill remain paired throughout theme changes while hovered", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t), timeline = [];
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(url + "#reports"); await page.locator('#workspace[aria-busy="false"]').waitFor();
    const control = page.getByRole("button", { name: "Choose requests in Activity", exact: true });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme); await page.waitForTimeout(180); await control.hover();
        await page.waitForTimeout(180);
        await page.locator("#themePreference").focus();
        await page.evaluate(() => {
            window.hoverFrames = [];
            const start = performance.now(), node = document.querySelector(".report-entry-actions .primary");
            function sample() {
                const css = getComputedStyle(node), before = getComputedStyle(node, "::before");
                const surface = before.content !== "none" && before.zIndex === "-1" ? before : css;
                window.hoverFrames.push({ at: performance.now() - start, foreground: css.color, background: surface.backgroundColor, hovered: node.matches(":hover") });
                if (performance.now() - start < 320) requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
        });
        await page.keyboard.press("Space");
        await page.waitForTimeout(350);
        const frames = await page.evaluate(() => window.hoverFrames);
        timeline.push(...frames.map(frame => ({ from: theme, ...frame, ratio: contrast(frame.foreground, frame.background) })));
    }
    if (proofDir) await writeFile(path.join(proofDir, "transition-matrix.json"), JSON.stringify(timeline, null, 2));
    assert.ok(timeline.every(frame => frame.hovered), "Keyboard theme switch does not move the pointer off the primary");
    assert.ok(timeline.every(frame => frame.ratio >= 4.5), JSON.stringify(timeline.filter(frame => frame.ratio < 4.5)));
});

test("select and secondary surfaces change atomically with their theme foreground", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t), timeline = [];
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(url + "#home?scope=all"); await page.locator('#workspace[aria-busy="false"]').waitFor();
    for (const selector of ["#pageAction", "[data-select-id=dateFilter]"]) for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme); await page.waitForTimeout(180);
        const control = page.locator(selector);
        await page.locator("#themePreference").focus();
        await control.hover(); await page.waitForTimeout(180);
        await page.evaluate(selector => {
            window.hoverFrames = [];
            const start = performance.now(), node = document.querySelector(selector);
            function sample() {
                const css = getComputedStyle(node), before = getComputedStyle(node, "::before");
                window.hoverFrames.push({ at: performance.now() - start, foreground: css.color,
                    background: before.content !== "none" && before.zIndex === "-1" ? before.backgroundColor : css.backgroundColor, hovered: node.matches(":hover") });
                if (performance.now() - start < 320) requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
        }, selector);
        await page.keyboard.press("Space"); await page.waitForTimeout(350);
        timeline.push(...(await page.evaluate(() => window.hoverFrames)).map(frame => ({ selector, from: theme, ...frame, ratio: contrast(frame.foreground, frame.background) })));
    }
    if (proofDir) await writeFile(path.join(proofDir, "secondary-transition-matrix.json"), JSON.stringify(timeline, null, 2));
    assert.ok(timeline.every(frame => frame.hovered));
    assert.ok(timeline.every(frame => frame.ratio >= 4.5), JSON.stringify(timeline.filter(frame => frame.ratio < 4.5)));
});

test("responsive hover, keyboard focus, and labels survive narrow/large layouts and doubled root text", { timeout: 90000 }, async t => {
    const { page, url } = await setup(t), matrix = [], layouts = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 1200, 1920]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 960 });
        await page.goto(url + "#reports"); await page.locator('#workspace[aria-busy="false"]').waitFor();
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${100 * scale}%`; }, scale);
        const primary = page.getByRole("button", { name: "Choose requests in Activity", exact: true });
        await inspectStates(page, primary, `primary at ${width}/${scale * 100}%`, matrix);
        await primary.hover();
        const boxes = await primary.evaluate(node => {
            const bounds = node.getBoundingClientRect(), range = document.createRange();
            range.selectNodeContents(node);
            return { width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth,
                clipped: [...range.getClientRects()].some(r => r.left < bounds.left - 1 || r.right > bounds.right + 1 || r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1),
                control: { width: bounds.width, height: bounds.height } };
        });
        assert.equal(boxes.clipped, false); assert.ok(boxes.overflow <= 1);
        layouts.push({ theme, width, scale, ...boxes });
        if (proofDir) await primary.screenshot({ path: path.join(proofDir, `primary-${theme}-${width}-${scale * 100}.png`) });
        await navigateMain(page, "home");
        await inspectStates(page, page.locator("#pageAction"), `chooser at ${width}/${scale * 100}%`, matrix);
        await inspectStates(page, page.locator("[data-select-id=dateFilter]"), `select at ${width}/${scale * 100}%`, matrix);
        await page.locator("[data-select-id=dateFilter]").click();
        await inspectStates(page, page.locator(".select-popup [aria-selected=true]"), `selected portal at ${width}/${scale * 100}%`, matrix);
        const popup = await page.locator(".select-popup").boundingBox();
        assert.ok(popup.x >= 0 && popup.x + popup.width <= width + 1, "Portal stays within viewport");
        await page.locator("[data-select-id=dateFilter]").focus(); await page.keyboard.press("Escape");
    }
    if (proofDir) await writeFile(path.join(proofDir, "responsive-matrix.json"), JSON.stringify({ matrix, layouts }, null, 2));
    const failures = matrix.flatMap(row => row.painted.filter(item => item.ratio < (item.kind === "icon" ? 3 : 4.5)).map(item => ({ theme: row.theme, family: row.family, state: row.state, ...item })));
    assert.deepEqual(failures, []);
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto(url + "#reports"); await page.locator('#workspace[aria-busy="false"]').waitFor();
    const primary = page.getByRole("button", { name: "Choose requests in Activity", exact: true });
    await inspectStates(page, primary, "forced colors primary", []);
    const forced = await measure(primary);
    assert.ok(forced.every(item => item.ratio >= (item.kind === "icon" ? 3 : 4.5)));
});

test("conditional issues, errors, draft links, and copy states use readable semantic paint", { timeout: 60000 }, async t => {
    const { page, url, setStatus } = await setup(t), matrix = [];
    const sources = Array.from({ length: 8 }, (_, index) => ({ sessionId: `synthetic-issue-${index}`, name: `Synthetic unavailable chat ${index}`, eligible: true }));
    const cursors = sources.map(source => ({ sessionId: source.sessionId, error: "Synthetic missing history", errorCode: "ENOENT", lastAttemptAt: "2026-10-05T01:00:00Z" }));
    const { summary, issues } = createCollectionStatus().coverage(sources, cursors);
    const inspect = (selector, family) => inspectStates(page, page.locator(selector).first(), family, matrix);
    for (const theme of ["light", "dark"]) {
        for (const severity of ["warning", "error"]) {
            setStatus({ historyCoverage: { ...summary, eligible: severity === "warning" ? 9 : 8, readable: severity === "warning" ? 1 : 0 }, historyIssues: issues });
            await page.goto(url + "#settings?section=diagnostics"); await page.locator('#workspace[aria-busy="false"]').waitFor(); await chooseTheme(page, theme);
            if (!await page.locator(".history-reason").first().evaluate(node => node.open)) await page.locator(".history-reason>summary").first().click();
            await page.locator(".history-issue").first().waitFor();
            await inspect(".history-reason>summary", "history reason disclosure");
            await inspect(".history-issue>summary", "history issue disclosure");
            await inspect("#collectionIssueGroups .list-pager button:not(:disabled)", "issues pagination");
        }
        await navigateMain(page, "settings");
        await navigateSettings(page, "connection");
        await openSourceEditor(page);
        await page.locator("#sourceDatabase").fill("C:\\synthetic\\changed.db");
        await navigateMain(page, "home");
        await inspect("#settingsDraftNotice a", "draft return inline link");
        await page.locator("#settingsDraftNotice a").hover();
        assert.equal(await page.locator("#settingsDraftNotice a").evaluate(node => getComputedStyle(node).textDecorationLine), "none");
        await navigateMain(page, "settings"); await page.locator("#cancelSource").click();
        await navigateMain(page, "home");
        await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Synthetic interrupted snapshot" } }));
        await (await revealStoredRefresh(page)).click();
        await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
        await inspectStates(page, page.getByRole("button", { name: "Try again", exact: true }), "error retry", matrix);
        await page.unroute("**/api/snapshot");
        await page.goto(url + "#request?request=hover-0"); await page.locator('#workspace[aria-busy="false"]').waitFor();
        for (const summary of await page.locator("#requestView details>summary").all()) if (await summary.isVisible()) await summary.click();
        const copy = page.locator(".ux-copy:visible").first();
        assert.equal(await copy.isVisible(), true);
        for (const state of ["success", "error"]) {
            await copy.evaluate((node, state) => { node.dataset.copyState = state; }, state);
            await inspectStates(page, copy, `synthetic copy ${state}`, matrix);
        }
        await copy.evaluate(node => { delete node.dataset.copyState; });
    }
    if (proofDir) await writeFile(path.join(proofDir, "conditional-matrix.json"), JSON.stringify(matrix, null, 2));
    assert.deepEqual(matrix.flatMap(row => row.painted.filter(item => item.ratio < (item.kind === "icon" ? 3 : 4.5)).map(item => ({ family: row.family, theme: row.theme, state: row.state, ...item }))), []);
});
