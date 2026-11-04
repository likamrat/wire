import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { navigateMain } from "./helpers.mjs";
import { microsoftProfileView } from "../lib/microsoft-profile.mjs";

const backendRoot = process.env.WIRE_REPORT_BACKEND_ROOT;
const backend = file => import(pathToFileURL(path.join(backendRoot, file)).href);

test("report UI keeps original Current/All/Selected receipts through edits, reviews native copies and never dispatches Save", { skip: !backendRoot, timeout: 60000 }, async t => {
    const { committedNativeReportFixture } = await backend("tests\\native-report-controller-fixture.mjs");
    const { chatFixture, coworkFixture } = await backend("tests\\native-read-model-fixtures.mjs");
    const { createNativeRuntimeAccess } = await backend("lib\\runtime-access.mjs");
    const { currentStatePayload, executeAction } = await backend("lib\\server.mjs");
    const { createExportController } = await backend("lib\\export.mjs");
    const { loadBoardState, replaceEvidence } = await backend("lib\\store.mjs");
    const { fixture } = await backend("tests\\helpers.mjs");
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes: [...chatFixture(), ...coworkFixture()] });
    await replaceEvidence(app.context, () => ({ records: [{ ...fixture("github-kept"), followUpPrompts: [] }],
        importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    const access = await createNativeRuntimeAccess(app.context, { lifecycle: app.lifecycle, nativePersistence: app.persistence,
        acquireNative() { assert.fail("Report preview never acquires source"); } });
    const guard = await access.read("native-report-ui-owner");
    const service = { sourceAware: true,
        ...access.nativeReportsFor(guard, { check() {}, dispatched() { assert.fail("Native report saving remains gated"); } }),
        nativeRetained: access.nativeRetainedFor(guard, { check() {} }),
        nativeReportViewResolver: binding => access.nativeReportViewFor(guard, { check() {} }, binding),
        nativePersistenceStatus: value => access.nativePersistenceStatus(value, { owner: guard.owner, check() {} }),
    };
    const exports = createExportController(app.context, () => assert.fail("Native writer remains gated"));
    const runtimeId = "00000000-0000-4000-8000-000000000001";
    const bootstrap = { schemaVersion: 1, mode: "enforced", runtimeId, maxWaitMs: 1000, freshnessMs: 5000, collectionMode: "source-aware" };
    const snapshots = [], previews = [], prepared = [], saves = [], errors = [];
    let rejectPreview = false;
    async function collection() {
        const microsoft = await app.persistence.status({}, { owner: app.owner }), status = await app.lifecycle.status();
        const github = { state: "disconnected", connected: false, config: null, configVersion: null, revision: microsoft.revision,
            deletionVersion: 0, artifactRevision: 0 };
        return { ...github, sourceAware: { schemaVersion: 1, kind: "source-aware-collection",
            generation: microsoft.generation, authorizationRevision: status.authorizationRevision,
            global: { state: "legacy-compatible", revision: null, actions: [] }, github: { status: github, actions: [] },
            microsoft: { status: microsoft, actions: ["configure", ...microsoft.actions.filter(action => action === "collect-now")],
                configurationOffer: { schemaVersion: 2, kind: "native-configuration-offer",
                    generation: microsoft.generation, authorizationRevision: status.authorizationRevision, globalRevision: null,
                    intent: "save", available: true, expectedRevision: microsoft.configuration.configurationRevision,
                    supportedSurfaces: ["chat", "cowork"], values: { surfaces: microsoft.configuration.surfaces,
                        windowDays: microsoft.configuration.settings.windowDays }, basis: "committed-native", blockers: [] } } } };
    }
    const server = createServer(async (req, res) => {
        try {
            if (req.url === "/" && req.method === "GET") {
                res.setHeader("Content-Type", "text/html"); return res.end(renderHtmlShell("a".repeat(64), "native-report-proof", bootstrap));
            }
            if (req.url === "/favicon.ico") return res.writeHead(204).end();
            let raw = ""; for await (const chunk of req) raw += chunk;
            const input = raw ? JSON.parse(raw) : {}, status = await app.lifecycle.status();
            res.setHeader("Content-Type", "application/json");
            res.setHeader("X-Wire-Runtime", runtimeId); res.setHeader("X-Wire-Generation", String(status.generation));
            let result;
            if (req.url === "/api/access/watch") {
                await new Promise(resolve => setTimeout(resolve, 50));
                result = { ...bootstrap, generation: status.generation, authorizationRevision: status.authorizationRevision,
                    wire: "signed-in", retained: true, collection: "enabled" };
            } else if (req.url === "/api/snapshot") {
                result = { ...await currentStatePayload(app.context, undefined, input, undefined, service), collection: await collection() };
                snapshots.push(result);
            } else if (req.url === "/api/collection/status") result = await collection();
            else if (req.url === "/api/collection/sources/status") result = (await collection()).sourceAware;
            else if (req.url === "/api/profile/microsoft") result = microsoftProfileView(
                access.microsoftProfileFor ? await access.microsoftProfileFor(guard) : null);
            else if (req.url.startsWith("/api/retained/microsoft/")) result = await service.nativeRetained[req.url.split("/").at(-1)](input);
            else if (req.url === "/api/preview") {
                previews.push(input);
                if (rejectPreview) throw Object.assign(new Error("Original native view expired. Select a current view."), { status: 409 });
                result = await executeAction(app.context, exports, guard.owner, "preview_export", input, service);
                prepared.push(result);
            } else if (req.url === "/api/privacy-review") result = await exports.review(guard.owner, input.previewId, input.disclosureReviewed, input.timeContext, service);
            else if (req.url === "/api/cancel-preview") { exports.cancel(guard.owner, input.previewId); result = {}; }
            else if (req.url === "/api/export") { saves.push(input); throw Object.assign(new Error("Native Save is not admitted"), { status: 503 }); }
            else throw Object.assign(new Error("Unsupported isolated report proof route"), { status: 503 });
            res.end(JSON.stringify(result));
        } catch (error) { res.writeHead(error.status ?? 500).end(JSON.stringify({ error: error.message, code: error.code })); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); guard.release(); access.close(); assert.deepEqual(errors, []); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#periodResult")).toContainText("3 native tool calls");
    await navigateMain(page, "reports");
    await page.getByRole("link", { name: "Create a report", exact: true }).click();
    await page.locator('[name=reportScope][value=current]').check();
    const original = snapshots.at(-1).nativeRead;
    await expect(page.locator("#scopeSummary")).toContainText("2 retained Microsoft conversations");
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    await page.locator("#reportTitle").fill("Reviewed native preview");
    await page.locator('[name=promptMode][value=original]').check();
    await page.getByRole("button", { name: "Prepare report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    assert.equal(previews.at(-1).nativeViewId, original.viewId);
    assert.deepEqual(previews.at(-1).selection.scenarioIds, ["github-kept"]);
    assert.equal(previews.at(-1).selection.kind, "current");
    assert.equal(previews.at(-1).selection.revision, original.revision);
    await page.getByRole("tab", { name: /^Text \(/ }).click();
    await page.getByRole("button", { name: "Next report copies", exact: true }).click();
    await expect(page.locator("#reportTextInspection")).toContainText("Microsoft user message");
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeDisabled();
    assert.deepEqual(saves, []);
    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await navigateMain(page, "reports");
    await page.getByRole("link", { name: "Create a report", exact: true }).click();
    await page.locator('[name=reportScope][value=all]').check();
    const all = snapshots.at(-1).nativeRead;
    await expect(page.locator("#scopeSummary")).toContainText("conversations will be counted");
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    rejectPreview = true;
    await page.getByRole("button", { name: "Prepare report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "blocked");
    assert.equal(previews.at(-1).nativeViewId, all.allViewId);
    assert.equal(previews.at(-1).selection.kind, "all");
    assert.equal(Object.hasOwn(previews.at(-1).selection, "scenarioIds"), false);
    const attempts = previews.length;
    assert.equal(await page.getByRole("button", { name: "Prepare report", exact: true }).isDisabled(), true);
    assert.equal(previews.length, attempts, "A refused original view is not automatically retried with a different receipt");
    rejectPreview = false;
    await page.getByRole("button", { name: "1. Activity", exact: true }).click();
    await expect(page.locator("#scopeExplanation")).toBeVisible();
    await page.getByRole("button", { name: "Use current activity for this report scope", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to contents", exact: true })).toBeEnabled();
    const refreshed = snapshots.at(-1).nativeRead;
    assert.notEqual(refreshed.allViewId, all.allViewId);
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    await page.getByRole("button", { name: "Prepare report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    assert.equal(previews.at(-1).nativeViewId, refreshed.allViewId);
    assert.equal(previews.length, attempts + 1);
    assert.equal((await loadBoardState(app.context)).exports.length, 0);

    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await navigateMain(page, "analyze");
    const choice = page.locator('#activityList .request-row[data-source-id^="microsoft-365-"]').first();
    const pickedId = (await choice.getAttribute("data-view-key")).slice("request:".length), pickedView = snapshots.at(-1).nativeRead.viewId;
    await choice.locator(".request-card-open").click();
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Add to report", exact: true }).click();
    await expect(page.locator("#activitySelectionSummary")).toContainText("1 retained Microsoft conversation selected");
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Remove from report", exact: true }).click();
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Add to report", exact: true }).click();
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Continue to report", exact: true }).click();
    await expect(page.locator('[name=reportScope][value=selected]')).toBeChecked();
    await expect(page.locator("#report-native-select-" + pickedId)).toBeChecked();
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    await page.getByRole("button", { name: "Prepare report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    assert.deepEqual(previews.at(-1).selection.scenarioIds, [pickedId]);
    assert.equal(prepared.at(-1).snapshot.records.length, 1);
    await page.getByRole("button", { name: "1. Activity", exact: true }).click();
    await page.locator('input[data-report-request="github-kept"]').check();
    const other = page.locator("#reportList input[data-native-report-request]").last();
    await other.check(); await other.uncheck();
    await expect(page.locator("#scopeSummary")).toContainText("1 GitHub interaction");
    await expect(page.locator("#scopeSummary")).toContainText("1 retained Microsoft conversation selected");
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    await page.locator("#reportTitle").fill("Selected retained conversations");
    await page.getByRole("button", { name: "Prepare report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    assert.equal(previews.at(-1).nativeViewId, pickedView);
    assert.equal(previews.at(-1).selection.kind, "selected");
    assert.deepEqual(previews.at(-1).selection.scenarioIds, ["github-kept", pickedId]);
    assert.equal(prepared.at(-1).snapshot.records.length, 2, "Exactly one selected native conversation and one GitHub interaction.");
    await page.getByRole("tab", { name: /^Files \(/ }).click();
    const files = page.locator("#reportFileInspection");
    assert.equal(await files.getByRole("button", { name: /Download/ }).count(), 0);
    for (const name of ["product-report.html", "coverage-and-redaction-manifest.json"]) {
        await page.locator(`#preparedReportFile [data-file-name="${name}"]`).click();
        await files.getByRole("button", { name: "Source", exact: true }).click();
        assert.equal(await files.locator(`pre[aria-label="${name}"]`).textContent() === prepared.at(-1).files[name], true,
            "Design-A Source keeps the exact native/mixed prepared bytes.");
        await files.getByRole("button", { name: name.endsWith(".json") ? "Tree" : "Preview", exact: true }).click();
    }
    await page.getByRole("tab", { name: "Report", exact: true }).click();
    await expect(page.locator("#reportApproval input[data-review-control]")).not.toBeChecked();
    await page.getByRole("button", { name: "1. Activity", exact: true }).click();
    await page.getByRole("button", { name: "Clear Microsoft selection", exact: true }).click();
    await expect(page.locator('input[data-report-request="github-kept"]')).toBeChecked();
    await expect(page.locator("#report-native-select-" + pickedId)).not.toBeChecked();
    await expect(page.locator("#scopeCount-selected")).toContainText("1 interaction");
    await page.getByRole("button", { name: "Clear selection", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue to contents", exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#reportList input[data-native-report-request]")).toHaveCount(2);
    assert.deepEqual(saves, []);
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
});
