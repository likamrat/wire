import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { openAnalyzeFilters, closeAnalyzeFilters, selectActivityOption, navigateMain, fixture, chooseTheme } from "./helpers.mjs";

const root = process.env.WIRE_BOUNDED_BACKEND_ROOT;
const backend = async file => import(pathToFileURL(path.join(root, file)).href);

for (const { segmented, incompleteText = false } of [{ segmented: false }, { segmented: true }, { segmented: true, incompleteText: true }]) test(incompleteText
    ? "incomplete Microsoft text keeps Search unavailable with readable recovery and diagnostic identity"
    : `current UI uses the composed v${segmented ? 2 : 1} source-aware HTTP graph and respects its withheld acquisition gate`,
    { skip: !root, timeout: 90000 }, async t => {
        const { privateFixture } = await backend("tests\\helpers.mjs");
        const { chatFixture, coworkFixture, absent } = await backend("tests\\native-read-model-fixtures.mjs");
        const { createMicrosoftNativeReadTransport } = await backend("lib\\microsoft-native-transport.mjs");
        const { createMicrosoftSession } = await backend("lib\\microsoft-session.mjs");
        const { createNativePersistence } = await backend("lib\\native-persistence.mjs");
        const { createNativeRuntimeAccess } = await backend("lib\\runtime-access.mjs");
        const { startServer } = await backend("lib\\server.mjs");
        const { createExportController } = await backend("lib\\export.mjs");
        const { loadBoardState, updateBoardState } = await backend("lib\\store.mjs");
        const { savedNativeReportFixture } = await backend("tests\\native-report-controller-fixture.mjs");
        const { nativeConversationIdentity } = await backend("lib\\native-read-model.mjs");
        const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, [fixture("bounded-native-github")]);
        const envelopes = [...chatFixture(), ...coworkFixture()], account = envelopes[0].scope.account;
        if (incompleteText) envelopes[0].qualifiedFields.message = absent("field-absent-from-read-response");
        let persistence, access, runtime, browser, acquisitions = 0;
        const transport = createMicrosoftNativeReadTransport({
            async open() {},
            async verifyAccount() { return { tenantId: account.tenantId, subjectId: account.subjectId, knownAccountMatched: true,
                chat: true, cowork: true, evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } }; },
            async stop() { return { processExited: true, profileReleased: true }; },
        });
        const lifecycle = await createMicrosoftSession(context, { transport, sourceAware: true, globalCollection: null,
            collection: { paused: true, windowDays: 30 },
            persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token) });
        t.after(async () => {
            await browser?.close(); await runtime?.close(); access?.close(); persistence?.close(); await lifecycle.close();
            for (const work of cleanup.reverse()) await work();
        });
        persistence = await createNativePersistence(context, { lifecycle, transport, preAccount: "metadata-only", configurationIntents: true });
        access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence,
            sourceAware: true, nativeConnection: true, nativeAcquisition: false,
            async acquireNative() { acquisitions++; throw new Error("No acquisition is permitted in bounded UI qualification."); } });
        runtime = await startServer(context, createExportController(context), { port: 0, access, collector: { timers: false } });
        const origin = new URL(runtime.url).origin;
        async function post(route, input, capability) {
            const response = await fetch(origin + route, { method: "POST", headers: {
                Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}),
            }, body: JSON.stringify(input) });
            const body = await response.json();
            assert.equal(response.status, 200, body.error);
            return body;
        }
        const setup = await post("/api/session", {});
        for (const action of ["wire-sign-in", "microsoft-connect"]) await post("/api/access/command", {
            schemaVersion: 1, action, operationId: randomUUID(), generation: (await lifecycle.status()).generation,
        }, setup.capability);
        const offer = (await post("/api/collection/sources/status", {}, setup.capability)).microsoft.configurationOffer;
        await post("/api/collection/microsoft/configure", {
            schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
            globalRevision: offer.globalRevision, expectedRevision: offer.expectedRevision,
            surfaces: offer.values.surfaces, windowDays: offer.values.windowDays,
        }, setup.capability);
        // Existing fixture producer seeds the retained store; the runtime acquisition path stays withheld.
        const admission = { owner: "bounded-ui-existing-fixture", check() {}, dispatched() {} };
        const pending = await (segmented ? persistence.beginSegmented : persistence.begin)({ operationId: randomUUID() }, admission);
        await (segmented ? persistence.commitSegmented : persistence.commit)(pending.ticket, envelopes);
        await persistence.retire(pending.ticket);
        const saved = segmented ? null : await savedNativeReportFixture({ context, persistence, services: {
            nativeReportAdmission: admission, nativeRecords: [...new Set(envelopes.map(record => nativeConversationIdentity(record.scope)))]
                .map(scenarioId => ({ scenarioId })),
        } });
        const handshake = await post("/api/session", {});
        assert.equal(handshake.accessBootstrap.collectionMode, "source-aware");
        browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], writes = [], previews = [], groups = [], analyses = [], eligibilityReads = [], deletionPreviews = [], artifactWrites = [];
        const proofs = process.env.WIRE_VISUAL_FINISH_PROOFS || process.env.WIRE_COMPOSED_HTTP_PROOFS;
        if (proofs) await mkdir(proofs, { recursive: true });
        async function captureGraph(name) {
            if (!proofs || !segmented) return;
            if (process.env.WIRE_VISUAL_FINISH_PROOFS && name.endsWith("reader")) return;
            if (process.env.WIRE_VISUAL_FINISH_ONLY && !process.env.WIRE_VISUAL_FINISH_ONLY.split(",").includes(name)) return;
            for (const theme of ["light", "dark"]) {
                await page.setViewportSize({ width: 1440, height: 1000 });
                await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
                await chooseTheme(page, theme);
                for (const [width, text] of [[1440, 100], [768, 100], [390, 100], [390, 200]]) {
                    await page.setViewportSize({ width, height: 1000 });
                    await page.evaluate(value => { document.documentElement.style.fontSize = value + "%"; }, text);
                    await page.evaluate(async () => {
                        await document.fonts.ready;
                        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    });
                    await page.waitForFunction(() => document.getAnimations().filter(animation =>
                        animation.effect?.getComputedTiming().iterations !== Infinity).every(animation => animation.playState !== "running"));
                    if (name.startsWith("search-")) await page.locator("#wireSearch").click();
                    else {
                        await page.locator("#analyzeFilterDialog").evaluate(node => { if (node.open) node.scrollTop = 0; });
                        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
                    }
                    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
                    await page.screenshot({ path: path.join(proofs,
                        `v${segmented ? 2 : 1}-${name}-${theme}-${width}-${text}.png`),
                    fullPage: ["analyze", "context-only"].includes(name) });
                    if (process.env.WIRE_VISUAL_FINISH_PROOFS) {
                        const metrics = await page.evaluate(() => [...document.querySelectorAll(
                            ".notice,.empty-state,.percentage-card-heading,#collectionNotice,#boundedFilterNotice,.wire-search-set>h3,.wire-search-set>p,.filter-chip,.analyze-filter-heading,.section-heading,#openChartReference,#analyzeRefresh,#openAnalyzeFilters",
                        )].filter(node => node.checkVisibility({ visibilityProperty: true })).map(node => {
                            const style = getComputedStyle(node), rect = node.getBoundingClientRect(), next = node.nextElementSibling;
                            return { id: node.id, className: node.className, text: node.textContent.trim().slice(0, 120),
                                x: rect.x, y: rect.y, width: rect.width, height: rect.height, fontSize: style.fontSize, lineHeight: style.lineHeight,
                                icons: [...node.querySelectorAll(".wire-icon")].map(icon => {
                                    const bounds = icon.getBoundingClientRect();
                                    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
                                }),
                                padding: style.padding, radius: style.borderRadius, margin: style.margin, shadow: style.boxShadow,
                                next: next?.id || next?.tagName, nextGap: next ? next.getBoundingClientRect().top - rect.bottom : null };
                        }));
                        await writeFile(path.join(proofs, `v2-${name}-${theme}-${width}-${text}.json`), JSON.stringify(metrics, null, 2));
                        const toolbar = metrics.filter(item => ["openChartReference", "analyzeRefresh", "openAnalyzeFilters"].includes(item.id));
                        for (const [index, a] of toolbar.entries()) for (const b of toolbar.slice(index + 1)) {
                            const horizontal = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
                            const vertical = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
                            assert.ok(horizontal <= 1 || vertical <= 1, `${name}/${width}/${text}: toolbar targets do not overlap`);
                        }
                        if (name === "context-only") {
                            await expect(page.locator("#analyzeEmptyScope")).toBeHidden();
                            const empty = await page.locator("#chart>.empty-state").evaluate(node => ({
                                x: node.getBoundingClientRect().x, height: node.getBoundingClientRect().height,
                                label: node.firstElementChild.getBoundingClientRect().height,
                                headingX: document.getElementById("chartTitle").getBoundingClientRect().x,
                                background: getComputedStyle(node).backgroundColor,
                            }));
                            assert.ok(Math.abs(empty.x - empty.headingX) <= 1 && empty.height <= empty.label + 24,
                                "An empty chart uses the existing panel, not a tall inner message box.");
                            assert.equal(empty.background, "rgba(0, 0, 0, 0)");
                        }
                        if (name.startsWith("search-")) {
                            for (const notice of metrics.filter(item => item.className === "notice" && !item.id)) {
                                assert.equal(notice.radius, "0px", "A passive Search status must not look like an input.");
                                assert.equal(notice.shadow, "none");
                            }
                        }
                        if (name === "search-empty") await expect(page.locator("#wireNativeSearch .pager")).toHaveCount(0);
                    }
                    if (name.endsWith("reader")) {
                        const bounds = await page.locator("#contextSidebar").boundingBox();
                        assert.ok(bounds && bounds.y >= -1 && bounds.y + bounds.height <= 1001,
                            `${name}/${theme}/${width}/${text}: reader vertical bounds ${JSON.stringify(bounds)}`);
                        await expect(page.locator("#contextSidebarFooter button:visible").first()).toBeInViewport();
                    }
                }
            }
            await page.setViewportSize({ width: 1440, height: 1000 });
            await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        }
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => {
            if (message.type() === "error" && /^Error: <[\w:-]+> attribute [\w:-]+:/i.test(message.text())) errors.push(message.text());
        });
        page.on("response", response => {
            if (new URL(response.url()).pathname === "/api/retained/microsoft/drilldown" && response.ok()) {
                void response.json().then(value => groups.push(value));
            }
            if (new URL(response.url()).pathname === "/api/retained/microsoft/analyze" && response.ok()) {
                void response.json().then(value => analyses.push({ value, input: response.request().postDataJSON() }));
            }
        });
        await page.route(origin + "/", route => route.fulfill({ contentType: "text/html",
            body: renderHtmlShell(handshake.capability, "composed-source-ui", handshake.accessBootstrap) }));
        page.on("request", request => {
            const pathname = new URL(request.url()).pathname;
            if (/^\/api\/collection\/.*(?:configure|enabled|now)$/.test(pathname)) writes.push(pathname);
            if (pathname === "/api/preview") previews.push(request.postDataJSON());
            if (pathname === "/api/artifact-deletion/eligibility") eligibilityReads.push(request.postDataJSON());
            if (pathname === "/api/artifact-deletion/preview") deletionPreviews.push(request.postDataJSON());
            if (pathname === "/api/artifact-deletion/confirm") artifactWrites.push(request.postDataJSON());
        });
        await page.goto(origin + "/");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 3 native tool calls");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(3);
        if (incompleteText) {
            const failure = page.waitForResponse(response => response.url().endsWith("/api/retained/microsoft/analyze"));
            await page.locator("#wireSearch").fill("invented");
            await selectActivityOption(page, "wireSearchScope", "analysis");
            const response = await failure, diagnostic = await response.json();
            assert.equal(response.status(), 428);
            assert.equal(diagnostic.code, "NATIVE_VIEW_TEXT_COVERAGE_UNAVAILABLE");
            const explanation = "Some saved Microsoft text is unavailable. Search cannot verify all matching activity.";
            assert.equal(diagnostic.error, explanation);
            await expect(page.locator("#wireNativeSearch .notice")).toHaveText(explanation);
            await expect(page.locator("#wireNativeSearch")).not.toContainText(diagnostic.code);
            await expect(page.locator("#periodResult")).toContainText("Microsoft: current totals unavailable");
            await expect(page.locator("#periodResult")).not.toContainText("Microsoft: 0");
            const retry = page.waitForResponse(value => value.url().endsWith("/api/retained/microsoft/analyze"));
            await page.getByRole("button", { name: "Retry Microsoft Analyze Search", exact: true }).click();
            const retried = await retry;
            assert.equal(retried.status(), 428);
            assert.deepEqual(retried.request().postDataJSON(), response.request().postDataJSON(), "Retry preserves the original analytical scope.");
            assert.equal((await retried.json()).code, diagnostic.code);
            await expect(page.locator("#wireNativeSearch .notice")).toHaveText(explanation);
            await captureGraph("search-error");
            assert.equal(acquisitions, 0);
            assert.deepEqual(writes, []);
            assert.deepEqual(errors, []);
            return;
        }
        await captureGraph("analyze");
        if (proofs && segmented) {
            await openAnalyzeFilters(page);
            await captureGraph("filters");
            await closeAnalyzeFilters(page);
        }
        const copyOutput = process.env.WIRE_ANALYZE_COPY_PROOFS;
        async function captureCopy(name, open, close) {
            if (!copyOutput || !segmented || process.env.WIRE_ANALYZE_COPY_SOURCE_ONLY) return;
            await mkdir(copyOutput, { recursive: true });
            for (const theme of ["light", "dark"]) for (const width of [1440, 768, 390]) {
                await page.setViewportSize({ width, height: 1000 });
                await chooseTheme(page, theme);
                await open?.();
                await page.evaluate(async () => {
                    await document.fonts.ready;
                    await Promise.allSettled(document.getAnimations().filter(animation =>
                        animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
                });
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
                await page.screenshot({ path: path.join(copyOutput, `${name}-${theme}-${width}.png`), fullPage: !open });
                await close?.();
            }
            await page.setViewportSize({ width: 1440, height: 1000 });
            await chooseTheme(page, "light");
        }
        await captureCopy("analyze");
        await captureCopy("filters", () => openAnalyzeFilters(page), () => closeAnalyzeFilters(page));
        await captureCopy("guide", () => page.locator("#openChartReference").click(), async () => {
            await page.locator("#closeChartReference").click();
            await expect(page.locator("#meaning")).toBeHidden();
        });
        await expect(page.locator("#outcomeChart")).not.toContainText("Outcome rates are not combined");
        await expect(page.locator("#activityPager")).not.toContainText("chronology is not inferred");
        await expect(page.locator("#percentageCharts [data-breakdown=models] .percentage-content p")).toHaveCount(1);
        await expect(page.locator("#chartFooter")).toContainText("3 undated");
        await openAnalyzeFilters(page);
        await expect(page.locator("#analyzeViewControls")).not.toContainText("changes presentation");
        const sourceInventory = page.waitForResponse(response => response.url().endsWith("/api/retained/microsoft/inventory")
            && response.request().postDataJSON().dimension === "sources");
        await page.locator("#sourceFilter-control").click();
        const sourceValues = await (await sourceInventory).json();
        assert.equal(sourceValues.page.items.find(item => item.value === "microsoft-365-chat").count, 0,
            "The producer count is calls, despite the available no-call Chat conversation.");
        await page.locator("#sourceFilter-control").press("Escape");
        await page.locator("#sourceFilter-control").click();
        for (const value of ["microsoft-365-chat", "microsoft-365-cowork"]) {
            const option = page.locator(`.select-popup [data-value="${value}"]`);
            await expect(option).toBeVisible();
            await expect(option.locator(".select-option-detail")).toHaveCount(0);
        }
        await expect(page.locator(".select-popup .select-footer")).toHaveCount(0);
        if (copyOutput && segmented) {
            await page.locator(".select-popup").screenshot({ path: path.join(copyOutput, "source-options.png") });
        }
        await page.locator("#sourceFilter-control").press("Escape");
        await closeAnalyzeFilters(page);
        await page.locator("#openChartReference").click();
        await expect(page.locator("#chartReferenceExplanation")).not.toContainText("outcome rates stay separate");
        await page.locator("#closeChartReference").click();
        await expect(page.locator("#meaning")).toBeHidden();
        await page.locator("#activityList .request-card-open").filter({ hasText: "SYNTHETIC_PRIVATE_PROMPT" }).click();
        await expect(page.locator("#requestContent")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
        await captureGraph("github-reader");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).toBeHidden();
        await page.locator("#wireSearch").fill("SYNTHETIC_PRIVATE_PROMPT");
        await expect(page.locator("#wireSearchResults button").first()).toBeVisible();
        await page.locator("#wireSearchResults button").first().click();
        await expect(page.locator("#requestContent")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).toBeHidden();
        await page.locator("#wireSearch").fill("");
        await selectActivityOption(page, "sourceFilter", "microsoft-365-cowork"); await closeAnalyzeFilters(page);
        await openAnalyzeFilters(page);
        await page.locator("#toolFilter-control").click();
        await expect.poll(() => page.locator("#toolFilter option[data-native-inventory=true]").count()).toBe(3);
        await page.locator('.select-popup [data-value="mcp__graph__CallGraph"]').click(); await closeAnalyzeFilters(page);
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 1 native tool calls");
        if (process.env.WIRE_VISUAL_FINISH_PROOFS) {
            await openAnalyzeFilters(page);
            await captureGraph("filtered-controls");
            await closeAnalyzeFilters(page);
        }
        await openAnalyzeFilters(page);
        await page.locator("#toolFilter-control").click();
        await expect.poll(() => page.locator("#toolFilter option[data-native-inventory=true]").count()).toBe(3);
        await page.locator("#toolFilter-control").press("Escape"); await closeAnalyzeFilters(page);
        await openAnalyzeFilters(page);
        await page.locator('[data-chart="workload"]').click(); await closeAnalyzeFilters(page);
        await page.locator("#chart .flat-comparison-action[href*='nativeGroup=']").first().click();
        await expect(page.locator('[aria-label="Remove Microsoft group restriction"]')).toHaveCount(1);
        const groupId = new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("nativeGroup");
        await expect(page.locator("#outcomeChart .percentage-label[href]").first()).toHaveAttribute("href", new RegExp(`nativeGroup=${groupId}`));
        await expect(page.locator("#activityListScope")).toContainText("Microsoft group:");
        await selectActivityOption(page, "toolFilter", "all"); await closeAnalyzeFilters(page);
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 3 native tool calls");
        await expect(page.locator('[aria-label="Remove Microsoft group restriction"]')).toHaveCount(1);
        await navigateMain(page, "reports");
        await page.getByRole("link", { name: "Create a report", exact: true }).click();
        await page.locator('[name=reportScope][value=current]').check();
        const originalGroup = groups.at(-1);
        assert.ok(originalGroup?.viewId);
        await expect(page.locator("#scopeSummary")).toContainText("1 retained Microsoft conversation");
        await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        await page.getByRole("button", { name: "Prepare report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        assert.equal(previews.at(-1).nativeViewId, originalGroup.viewId);
        await navigateMain(page, "analyze");
        await openAnalyzeFilters(page);
        await page.getByRole("button", { name: "Remove Microsoft group restriction", exact: true }).click();
        await closeAnalyzeFilters(page);
        await page.locator("#wireSearch").fill("CallGraph");
        await page.locator("#wireSearchScope-control").click();
        await page.locator('.select-popup [data-value="analysis"]').click();
        await expect.poll(() => analyses.length).toBeGreaterThan(0);
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 1 native tool calls");
        await expect(page.locator("#wireNativeSearch")).toContainText("1 matching native tool calls");
        const baseView = analyses.at(-1).input.viewId;
        await page.locator("#wireSearch").fill("Read");
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 3 native tool calls");
        await expect(page.locator("#wireNativeSearch")).toContainText("3 matching native tool calls");
        if (process.env.WIRE_VISUAL_FINISH_PROOFS) await captureGraph("search-results");
        assert.equal(analyses.at(-1).input.viewId, baseView, "Typed replacements keep the unrefined original base.");
        await page.route("**/api/retained/microsoft/analyze", route => {
            const query = route.request().postDataJSON().query;
            return query === "coverage unavailable" ? route.fulfill({ status: 428, json: {
                error: "Some saved Microsoft text is unavailable. Search cannot verify all matching activity.", code: "NATIVE_VIEW_TEXT_COVERAGE_UNAVAILABLE",
            } }) : query === "stale view" ? route.fulfill({ status: 409, json: {
                error: "NATIVE_VIEW_SELECTION_STALE", code: "NATIVE_VIEW_SELECTION_STALE",
            } }) : route.continue();
        });
        for (const [query, reason] of [["coverage unavailable", "Some saved Microsoft text is unavailable."], ["stale view", "NATIVE_VIEW_SELECTION_STALE"]]) {
            await page.locator("#wireSearch").fill(query);
            await expect(page.locator("#boundedFilterNotice")).toContainText(reason);
            await expect(page.locator("#activityList [data-source-id^='microsoft-365-']")).toHaveCount(0);
            await expect(page.locator("#periodResult")).not.toContainText("Microsoft: 0");
            if (process.env.WIRE_VISUAL_FINISH_PROOFS && query === "coverage unavailable") await captureGraph("search-error");
        }
        await page.locator("#wireSearch").fill("CallGraph");
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 1 native tool calls");
        await page.locator("#wireSearch").press("Escape");
        await navigateMain(page, "reports");
        await page.getByRole("link", { name: /^(Create a report|Continue draft)$/ }).click();
        await page.getByRole("button", { name: "1. Activity", exact: true }).click();
        await page.locator('[name=reportScope][value=all]').check();
        await page.locator('[name=reportScope][value=current]').check();
        await expect(page.locator("#scopeSummary")).toContainText("complete evidence and may contain more calls");
        const analysisView = analyses.at(-1).value.viewId;
        await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        await page.getByRole("button", { name: "Prepare report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        assert.equal(previews.at(-1).nativeViewId, analysisView);
        await navigateMain(page, "analyze");
        await page.locator("#wireSearch").click();
        await page.locator("#wireSearchScope-control").click();
        await page.locator('.select-popup [data-value="everywhere"]').click();
        await page.locator("#wireSearch").fill("");
        await selectActivityOption(page, "sourceFilter", "microsoft-365-chat"); await closeAnalyzeFilters(page);
        await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        if (process.env.WIRE_VISUAL_FINISH_PROOFS) await captureGraph("context-only");
        if (process.env.WIRE_VISUAL_FINISH_PROOFS) {
            await page.locator("#wireSearch").fill("unmatched invented visual phrase");
            await expect(page.locator("#wireNativeSearch")).toContainText("0 matches across saved dates.");
            await captureGraph("search-empty");
            await page.locator("#wireSearch").fill("");
        }
        await page.locator("#activityList .request-card-open").click();
        await expect(page.locator("#requestContent [data-reader-section=prompt]")).toContainText("An invented question.");
        await captureGraph("chat-reader");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).toBeHidden();
        await selectActivityOption(page, "sourceFilter", "microsoft-365-cowork"); await closeAnalyzeFilters(page);
        await page.locator("#wireSearch").fill("Read");
        await expect(page.locator("#wireNativeSearch .wire-search-hit").first()).toBeVisible();
        await page.locator("#wireNativeSearch .wire-search-hit").first().click();
        await expect(page.locator("#requestContent [data-native-ordinal]")).not.toHaveCount(0);
        await captureGraph("exact-native-reader");
        await page.locator("#closeContextSidebar").click();
        await page.goto(origin + "/#settings?section=connection");
        await expect(page.locator("#collectMicrosoftActivity")).toBeDisabled();
        await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Unavailable");
        await expect(page.locator("#globalCollectionStatus")).toHaveText("Source settings apply");
        if (saved) {
            await navigateMain(page, "reports");
            await page.reload();
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            await page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${saved.bundle.bundleId}"]`).click();
            await expect(page.getByRole("button", { name: "Delete report", exact: true })).toBeEnabled();
            if (process.env.WIRE_ARTIFACT_ELIGIBILITY_PROOFS) {
                await mkdir(process.env.WIRE_ARTIFACT_ELIGIBILITY_PROOFS, { recursive: true });
                await page.locator("#contextSidebar").screenshot({
                    path: path.join(process.env.WIRE_ARTIFACT_ELIGIBILITY_PROOFS, "qualified-inspector.png"),
                });
            }
            assert.deepEqual(eligibilityReads, []);
            assert.deepEqual(deletionPreviews, []);
            await expect(page.locator("#deleteAllReports")).toBeDisabled();
            let releaseSnapshot, snapshotHeld = false, hold = true;
            const resumed = new Promise(resolve => { releaseSnapshot = resolve; });
            t.after(() => releaseSnapshot());
            await page.route("**/api/snapshot", async route => {
                if (!hold) return route.continue();
                hold = false;
                const response = await route.fetch();
                snapshotHeld = true;
                await resumed;
                await route.fulfill({ response });
            });
            await updateBoardState(context, state => { state.continuation = "Existing fixture revision changed."; });
            await expect.poll(() => snapshotHeld, { timeout: 15000 }).toBe(true);
            try {
                await expect(page.locator(".saved-report-inspection").getByRole("button", { name: "Delete report", exact: true })).toBeEnabled();
                assert.deepEqual(deletionPreviews, [], "A background stored read does not prepare deletion.");
            }
            finally { releaseSnapshot(); }
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            await expect(page.locator("#message")).not.toContainText("Activity paging requires");
            assert.deepEqual(deletionPreviews, []);
            await expect(page.getByRole("button", { name: "Check Delete availability", exact: true })).toHaveCount(0);
            await expect(page.locator(".saved-report-inspection").getByRole("button", { name: "Delete report", exact: true })).toBeEnabled();
            await page.getByRole("button", { name: "Delete report", exact: true }).click();
            const deletion = page.locator('dialog[aria-labelledby="savedArtifactDeleteTitle"]');
            await expect(deletion).toHaveAttribute("data-decision-phase", "confirm");
            assert.equal(deletionPreviews.at(-1).artifactKind, "report");
            assert.equal(deletionPreviews.at(-1).artifactId, saved.bundle.bundleId);
            await expect(deletion).toContainText("Collected activity");
            await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
            await expect(page.locator(".saved-report-inspection").getByRole("button", { name: "Delete report", exact: true })).toBeFocused();
            await page.route("**/api/artifact-deletion/preview", async route => {
                const response = await route.fetch();
                await route.fulfill({ response, status: 403,
                    json: { error: "Artifact access unavailable", code: "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE" } });
            });
            await page.getByRole("button", { name: "Delete report", exact: true }).click();
            await expect(deletion).toHaveAttribute("data-decision-phase", "error");
            await expect(deletion).toContainText("Artifact access unavailable");
            await expect(deletion.getByRole("button", { name: "Delete report", exact: true })).toBeHidden();
            assert.deepEqual(eligibilityReads, []);
            assert.deepEqual(artifactWrites, []);
            assert.ok((await loadBoardState(context)).exports.some(item => item.bundleId === saved.bundle.bundleId));
        }
        assert.equal(acquisitions, 0);
        assert.deepEqual(writes, []);
        assert.deepEqual(errors, []);
    });
