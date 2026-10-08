import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { fixture, exportCatalogFor, chooseTheme, openActivitySessions, privateFixture } from "./helpers.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";

const proofs = process.env.WORKIQ_FLUENT_PROOFS;
const baseline = process.env.WORKIQ_FLUENT_BASELINE === "1";
const routes = ["home", "activity", "request?request=fluent-system", "reports",
    "settings?section=connection&setting=source-paths", "settings?section=collection",
    "settings?section=evidence", "settings?section=data", "collection-status"];

async function setup(t) {
    const records = [fixture("fluent-system")], requests = [], errors = [];
    const status = {
        state: "collecting-on-interval", revision: 1, configVersion: 1, connected: true,
        config: { approved: true, enabled: true, windowDays: 30, pollSeconds: 5,
            appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state" },
        lastCheckedAt: "2026-10-05T12:00:00Z", cadence: { pollSeconds: 5 }, metrics: {},
        discovery: { counts: { sessions: 1, dispositions: { eligible: 1 }, skippedByLimit: 0, unmappedWorkspaces: 0 } },
        historyCoverage: { eligible: 1, readable: 1, unavailable: 0, limited: 0, affected: 0, pending: 0 },
    };
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/assets/assessment-contract.mjs") {
            res.setHeader("Content-Type", "text/javascript");
            return res.end(await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8"));
        }
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-fluent-system'; style-src 'unsafe-inline'; font-src data:; connect-src 'self'; base-uri 'none'");
            return res.end(renderHtmlShell("a".repeat(64), "fluent-system"));
        }
        requests.push(req.url);
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/collection/status") return res.end(JSON.stringify(status));
        if (req.url !== "/api/snapshot") {
            res.statusCode = 403;
            return res.end('{"error":"Fluent proof permits synthetic snapshot/status reads only."}');
        }
        let body = ""; for await (const chunk of req) body += chunk;
        res.end(JSON.stringify({
            revision: 1, scenarios: records, exports: [], coverage: { notes: [] }, collection: status,
            exportCatalog: exportCatalogFor(records), requestActivity: buildRequestActivity(records),
            analytics: { ...buildActivityAnalytics(records, JSON.parse(body)), revision: 1 },
        }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(7000);
    page.on("pageerror", error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", route => {
        if (route.request().url().startsWith(origin + "/")) return route.continue();
        errors.push("Unexpected non-fixture network request");
        return route.abort();
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("Fluent proof cannot read clipboard."); },
        writeText() { throw Error("Fluent proof cannot write clipboard."); },
    } }));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(errors, []);
        assert.ok(requests.every(url => ["/api/snapshot", "/api/collection/status"].includes(url)), JSON.stringify(requests));
    });
    return { page, origin };
}

async function measure(page) {
    return page.evaluate(() => {
        const properties = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "borderRadius",
            "paddingInlineStart", "paddingInlineEnd", "columnGap", "color", "backgroundColor", "borderColor"];
        const selectors = ["h1", "h2", "h3", ".muted", ".primary-navigation a", "button:not(.ux-help):not(.time-column)",
            ".button-link", ".primary", ".select-trigger", ".recorded-result", "code.api-path", ".settings-paths dd",
            ".assessment-value", ".assessment-qualification", ".report-step", "input[type=text]", "table"];
        return {
            fontLoaded: [...document.fonts].some(font => font.family === "Asta Sans" && font.status === "loaded"),
            viewport: innerWidth, rootSize: getComputedStyle(document.documentElement).fontSize,
            rootOverflow: document.documentElement.scrollWidth - innerWidth,
            rootOverflowPolicy: getComputedStyle(document.documentElement).overflowX,
            samples: selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(node => node.checkVisibility()).slice(0, 6).map(node => {
                const css = getComputedStyle(node), rect = node.getBoundingClientRect(), before = getComputedStyle(node, "::before");
                const paint = before.content !== "none" && before.zIndex === "-1" ? before : css;
                return {
                    selector, id: node.id, tag: node.tagName,
                    styles: Object.fromEntries(properties.map(key => [key, css[key]])),
                    box: { x: rect.x, right: rect.right, width: rect.width, height: rect.height },
                    paint: { radius: paint.borderRadius, fill: paint.backgroundColor, border: paint.borderColor },
                    icons: [...node.querySelectorAll(".fluent-icon")].filter(icon => icon.checkVisibility()).map(icon => ({
                        asset: icon.dataset.fluentIcon, width: icon.getBoundingClientRect().width, height: icon.getBoundingClientRect().height,
                    })),
                };
            })),
        };
    });
}

test("Fluent roles are rendered consistently across real views, themes and root-text sizes", { timeout: 180000 }, async t => {
    const { page, origin } = await setup(t), matrix = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const route of routes) {
        await page.goto(origin + "/#" + route);
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        await openActivitySessions(page);
        await page.evaluate(() => document.fonts.ready);
        for (const theme of ["light", "dark"]) for (const width of baseline ? [1200] : [320, 375, 414, 768, 1200, 2560]) for (const scale of baseline ? [1] : [1, 2]) {
            await chooseTheme(page, theme);
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
            const result = await measure(page), label = `${route}/${theme}/${width}/${scale}`;
            matrix.push({ route, theme, width, scale, ...result });
            if (!baseline) {
                assert.equal(result.fontLoaded, true, `${label}: embedded actual Asta font loaded`);
                assert.ok(result.rootOverflow <= 1, `${label}: no document overflow`);
                assert.notEqual(result.rootOverflowPolicy, "clip", `${label}: no global clipping workaround`);
                for (const sample of result.samples) {
                    const mono = sample.selector === "code.api-path";
                    assert.match(sample.styles.fontFamily, mono ? /Cascadia Mono/ : /Asta Sans/, `${label}/${sample.selector}`);
                    if (sample.selector === "h1") {
                        const settingsTitle = route.startsWith("settings") && width >= 700;
                        assert.equal(sample.styles.fontSize, `${(settingsTitle ? 32 : 24) * scale}px`);
                        assert.equal(sample.styles.fontWeight, "600");
                        assert.ok(Math.abs(parseFloat(sample.styles.lineHeight) - (settingsTitle ? 40 : 32) * scale) < .01);
                    }
                    if (sample.selector === "code.api-path") {
                        assert.equal(sample.styles.fontSize, `${14 * scale}px`);
                        assert.equal(sample.styles.fontWeight, "400");
                    }
                    if (sample.selector === ".select-trigger" || sample.selector === ".button-link" || sample.selector === ".primary-navigation a") {
                        assert.equal(sample.styles.fontSize, `${14 * scale}px`, `${label}: consistent control role`);
                    }
                    if (sample.selector === ".primary-navigation a") {
                        assert.equal(sample.icons.length, 1, `${label}: exactly one visible navigation variant`);
                    }
                    if (sample.selector === ".primary") assert.equal(sample.styles.borderRadius, "8px", `${label}: filled/disabled primary retains its distinct Fluent shape`);
                    if (sample.id === "checkActivity" || sample.tag === "INPUT" || sample.selector === ".button-link") {
                        assert.ok(sample.box.height >= 44, `${label}/${sample.id}: target preserved`);
                        assert.ok(sample.box.x >= -1 && sample.box.right <= width + 1, `${label}/${sample.id}: full target fits`);
                    }
                }
            }
            if (proofs && ((width === 1200 && scale === 1) || (width === 320 && scale === 2))) {
                await page.screenshot({ path: path.join(proofs, `${route.replaceAll(/[^a-z0-9]/gi, "-")}-${theme}-${width}-${scale}.png`), fullPage: true });
            }
        }
    }
    if (proofs) await writeFile(path.join(proofs, "computed-role-matrix.json"), JSON.stringify(matrix, null, 2));
});

test("real server CSP loads Asta glyphs offline while unsupported scripts retain system fallbacks", { timeout: 30000 }, async t => {
    const { context } = await privateFixture(t, [fixture("fluent-font-server")]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage();
    const response = await page.goto(runtime.url + "#home");
    assert.match(response.headers()["content-security-policy"], /(?:^|;\s*)font-src data:(?:;|$)/);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(async () => {
        const probe = document.createElement("span");
        probe.id = "unicodeFallback";
        probe.textContent = "\u65e5\u672c\u8a9e \u0627\u0644\u0639\u0631\u0628\u064a\u0629";
        document.querySelector("main").append(probe);
        await document.fonts.ready;
    });
    const session = await page.context().newCDPSession(page);
    await session.send("DOM.enable"); await session.send("CSS.enable");
    const document = await session.send("DOM.getDocument");
    const fontsFor = async selector => {
        const { nodeId } = await session.send("DOM.querySelector", { nodeId: document.root.nodeId, selector });
        return (await session.send("CSS.getPlatformFontsForNode", { nodeId })).fonts;
    };
    const title = await fontsFor("#pageTitle"), fallback = await fontsFor("#unicodeFallback");
    assert.ok(title.some(font => font.postScriptName.startsWith("Asta-Sans-") && font.isCustomFont && font.glyphCount > 0), JSON.stringify(title));
    assert.ok(fallback.some(font => !font.isCustomFont && font.glyphCount > 0), JSON.stringify(fallback));
    if (proofs) await writeFile(path.join(proofs, "actual-platform-fonts.json"), JSON.stringify({ title, fallback }, null, 2));
});

test("request report-selection context wraps as a group instead of squeezing its heading beside the action", { timeout: 30000 }, async t => {
    const { page, origin } = await setup(t);
    await page.goto(origin + "/#request?request=fluent-system");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    for (const theme of ["light", "dark"]) for (const width of [320, 375, 768, 1200]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.evaluate(() => document.fonts.ready);
        const geometry = await page.locator(".request-actions").evaluate(section => {
            const rect = node => {
                const b = node.getBoundingClientRect();
                return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom };
            };
            const context = section.querySelector(":scope>div"), action = section.querySelector("#requestReportToggle");
            const title = section.querySelector("h2"), text = document.createRange();
            text.selectNodeContents(title);
            return {
                section: rect(section), context: rect(context), action: rect(action),
                contentWidth: section.clientWidth, rootSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
                titleLines: new Set([...text.getClientRects()].map(box => box.y)).size,
                clipped: context.scrollWidth > context.clientWidth || action.scrollWidth > action.clientWidth,
            };
        });
        assert.ok(geometry.context.width >= Math.min(12 * geometry.rootSize, geometry.contentWidth) - 1,
            `${theme}/${width}/${scale}: report context gets a readable text track`);
        assert.equal(geometry.titleLines, 1, "The short section heading is not broken into fragments");
        assert.equal(geometry.clipped, false);
        assert.ok(geometry.action.height >= 44);
        assert.ok(geometry.action.x >= geometry.section.x - 1 && geometry.action.right <= geometry.section.right + 1);
        const sameRow = geometry.action.x >= geometry.context.right;
        assert.ok(sameRow || geometry.action.y >= geometry.context.bottom + 11, "The complete action moves below the complete context with the section gap");
        await page.locator("#requestReportToggle").focus();
        await page.keyboard.press("Shift");
        assert.ok(await page.locator("#requestReportToggle").evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle !== "none"));
    }
});

test("actual text and icon groups remain centered with generated and existing progress markers", { timeout: 60000 }, async t => {
    const { page, origin } = await setup(t), matrix = [];
    await page.goto(origin + "/#home?from=2026-09-01&to=2026-10-01");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(({ source, icons }) => {
        const script = document.createElement("script");
        script.nonce = "fluent-system";
        script.textContent = `window.fluentFixtureUX = (${source})(${JSON.stringify(icons)});`;
        document.body.append(script);
    }, { source: createEvidenceUX.toString(), icons: uxIcons });
    for (const theme of ["light", "dark"]) for (const width of [320, 1200]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.evaluate(() => document.fonts.ready);
        for (const selector of ["#applyDates", "#checkActivity", "#pageAction"]) {
            let idle;
            for (const pending of [false, true, false]) {
                const result = await page.locator(selector).evaluate((node, pending) => {
                    window.fluentFixtureUX.pending(node, pending);
                    const range = document.createRange();
                    const text = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
                    range.selectNodeContents(text);
                    const label = range.getBoundingClientRect(), box = node.getBoundingClientRect();
                    const marker = node.querySelector(":scope>[data-progress-icon]"), icon = marker.getBoundingClientRect();
                    const existing = marker.matches("svg"), css = getComputedStyle(node);
                    return {
                        existing, width: box.width, height: box.height, midpoint: box.x + box.width / 2,
                        labelMidpoint: label.x + label.width / 2,
                        groupMidpoint: (Math.min(icon.x, label.x) + Math.max(icon.right, label.right)) / 2,
                        wrapped: new Set([...range.getClientRects()].map(rect => rect.y)).size > 1,
                        labelColumnMidpoint: (icon.right + parseFloat(css.columnGap) + box.right - parseFloat(css.paddingRight) - parseFloat(css.borderRightWidth)) / 2,
                        iconCenterY: icon.y + icon.height / 2, centerY: box.y + box.height / 2,
                        pending: node.dataset.pending, ariaBusy: node.getAttribute("aria-busy"),
                        markerVisible: getComputedStyle(marker).visibility,
                        fontLoaded: [...document.fonts].some(font => font.family === "Asta Sans" && font.status === "loaded"),
                    };
                }, pending);
                assert.equal(result.fontLoaded, true);
                assert.ok(result.height >= 44);
                const measured = result.existing && !result.wrapped ? result.groupMidpoint : result.labelMidpoint;
                const expected = result.existing && result.wrapped ? result.labelColumnMidpoint : result.midpoint;
                assert.ok(Math.abs(measured - expected) <= 1,
                    `${theme}/${width}/${scale}/${selector}/${pending}: actual visible content midpoint ${JSON.stringify(result)}`);
                if (result.existing) assert.ok(Math.abs(result.iconCenterY - result.centerY) <= 1, "The glyph stays vertically centered beside wrapped text");
                assert.equal(result.pending, String(pending));
                if (selector !== "#pageAction") assert.equal(result.ariaBusy, String(pending));
                if (idle) {
                    assert.equal(result.width, idle.width, "Loading does not shift control or neighbors");
                    assert.equal(result.height, idle.height, "Loading does not add lines");
                } else idle = result;
                matrix.push({ theme, width, scale, selector, ...result });
            }
        }
    }
    if (proofs) await writeFile(path.join(proofs, "actual-control-centering.json"), JSON.stringify(matrix, null, 2));
});

test("populated saved-report comparison inherits Fluent roles without changing frozen source reports", { timeout: 90000 }, async t => {
    const records = ["earlier", "later"].map(id => {
        const record = fixture(`fluent-${id}`);
        record.userPrompt.sourceEventId = `fluent-${id}-message`;
        return record;
    });
    records[1].toolCalls[0].toolSucceeded = false;
    records[1].toolCalls[0].reportedOutcome = "failed";
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const controller = createExportController(context), bundles = [];
    const timeContext = { timeZone: "UTC", locale: "en-US" };
    for (const record of records) {
        const state = await loadBoardState(context);
        const preview = await controller.preview("fluent-report-seed", undefined,
            { promptMode: "none", formats: ["html", "json"], timeContext },
            { kind: "selected", revision: state.revision, scenarioIds: [record.scenarioId] });
        await controller.review("fluent-report-seed", preview.previewId, true, timeContext);
        bundles.push((await controller.confirm("fluent-report-seed", preview.previewId, true, timeContext)).bundle);
    }
    const hashSources = async () => Promise.all(bundles.flatMap(bundle => Object.values(bundle.files)).map(async file =>
        createHash("sha256").update(await readFile(file)).digest("hex")));
    const original = await hashSources();
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(7000);
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            assert.deepEqual(await hashSources(), original, "Viewing and resizing never rewrites saved source report bytes");
            assert.deepEqual(errors, []);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator("#bundles>summary").click();
    const row = page.locator("#bundleList summary").filter({ hasText: bundles[0].bundleId }).locator("..");
    await row.locator(":scope>summary").click();
    await row.getByRole("button", { name: "Compare saved reports", exact: true }).click();
    const workspace = page.locator("#comparisonWorkspace");
    await workspace.locator("select").first().locator("option").nth(1).waitFor({ state: "attached" });
    for (const [index, label] of ["Baseline report", "Later report"].entries()) {
        await workspace.getByRole("combobox", { name: label, exact: true }).click();
        await page.locator(`.select-popup .select-option[data-value="${bundles[index].bundleId}"]`).click();
    }
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    await workspace.locator(".report-comparison").waitFor();
    const matrix = [];
    for (const theme of ["light", "dark"]) for (const width of [320, 375, 414, 768, 1200, 2560]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.evaluate(() => document.fonts.ready);
        const result = await workspace.evaluate(root => ({
            fontLoaded: [...document.fonts].some(face => face.family === "Asta Sans" && face.status === "loaded"),
            pageOverflow: document.documentElement.scrollWidth - innerWidth,
            overflow: root.scrollWidth - root.clientWidth,
            fields: [...root.querySelectorAll(".comparison-selectors>.select-field")].map(field => {
                const labelNode = field.querySelector(":scope>label");
                const label = labelNode.getBoundingClientRect();
                const control = field.querySelector(":scope>.select-control").getBoundingClientRect();
                const text = document.createRange(); text.selectNodeContents(labelNode);
                return { gap: control.top - label.bottom, height: field.getBoundingClientRect().height,
                    contentHeight: label.height + control.height, labelHeight: label.height,
                    textLines: new Set([...text.getClientRects()].map(rect => rect.y)).size,
                    lineHeight: parseFloat(getComputedStyle(labelNode).lineHeight) };
            }),
            samples: [...root.querySelectorAll("h2,h3,caption,.comparison-meta,.comparison-metric-value,button,.select-trigger")]
                .filter(node => node.checkVisibility()).map(node => {
                    const style = getComputedStyle(node), box = node.getBoundingClientRect();
                    return { tag: node.tagName, className: node.className, font: style.fontFamily, size: style.fontSize,
                        weight: style.fontWeight, leading: style.lineHeight, radius: style.borderRadius,
                        height: box.height, clipped: node.scrollWidth > node.clientWidth + 1 };
                }),
        }));
        assert.equal(result.fontLoaded, true);
        assert.ok(result.pageOverflow <= 1 && result.overflow <= 1, `${theme}/${width}/${scale}: comparison fits without global clipping`);
        assert.equal(result.fields.length, 2);
        for (const field of result.fields) {
            assert.ok(Math.abs(field.gap - 4) <= 1, `${theme}/${width}/${scale}: comparison label and control share the 4px field gap ${JSON.stringify(field)}`);
            assert.ok(Math.abs(field.height - field.contentHeight - 4) <= 1, "No stretched blank label region");
            assert.ok(field.labelHeight <= field.textLines * field.lineHeight + 1, `${theme}/${width}/${scale}: label height follows rendered text, not a vertical flex basis ${JSON.stringify(field)}`);
        }
        for (const sample of result.samples) {
            assert.match(sample.font, sample.className.split(" ").includes("comparison-endpoint") ? /Cascadia Mono/ : /Asta Sans/, sample.className);
            assert.equal(sample.clipped, false, `${theme}/${width}/${scale}/${sample.className}: complete text`);
            if (sample.tag === "BUTTON") {
                assert.equal(sample.size, `${14 * scale}px`, "Comparison actions use the same control role");
                assert.ok(sample.height >= 44);
            }
        }
        matrix.push({ theme, width, scale, ...result });
        if (proofs && ((width === 1200 && scale === 1) || (width === 320 && scale === 2))) {
            await mkdir(proofs, { recursive: true });
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proofs, `comparison-${theme}-${width}-${scale}.png`), fullPage: true });
        }
    }
    if (proofs) await writeFile(path.join(proofs, "comparison-role-matrix.json"), JSON.stringify(matrix, null, 2));
});
