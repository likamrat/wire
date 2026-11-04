import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createFixtureRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, restoreLegacySearch, revealStoredRefresh, selectActivityOption } from "./helpers.mjs";
import { chooseReportScope, reportContents } from "./report-journey-helpers.mjs";
import { loadBoardState } from "../lib/store.mjs";

async function setup(t, { signedIn = false, unbound = false, records } = {}) {
    const cleanup = [];
    const { context } = await privateFixture({ after: work => cleanup.push(work) }, records);
    const lifecycle = await createMicrosoftSession(context, { collection: { paused: true, windowDays: 30 } });
    const access = unbound ? undefined : await createFixtureRuntimeAccess(context, { lifecycle });
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false }, access });
    const origin = new URL(runtime.url).origin;
    const session = await fetch(origin + "/api/session", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" }, body: "{}" }).then(response => response.json());
    const command = async action => {
        const status = await fetch(origin + "/api/access/status", { headers: { "X-Board-Capability": session.capability } }).then(response => response.json());
        const response = await fetch(origin + "/api/access/command", { method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json", "X-Board-Capability": session.capability },
            body: JSON.stringify({ schemaVersion: 1, action, operationId: randomUUID(), generation: status.generation }) });
        assert.equal(response.status, 200);
    };
    if (signedIn && !unbound) await command("wire-sign-in");
    const browser = await chromium.launch();
    const requests = [], errors = [], calls = [];
    const newPanel = async () => {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        page.setDefaultTimeout(7000);
        page.on("request", request => {
            const path = new URL(request.url()).pathname;
            if (path.startsWith("/api/")) {
                requests.push(path);
                calls.push({ page, path, capability: request.headers()["x-board-capability"], input: request.postDataJSON() });
            }
        });
        page.on("pageerror", error => errors.push(error.message));
        return page;
    };
    const page = await newPanel();
    t.after(async () => {
        await browser.close(); await runtime.close(); access?.close(); await lifecycle.close();
        for (const work of cleanup) await work();
        assert.deepEqual(errors, []);
    });
    return { page, requests, calls, errors, command, newPanel, url: runtime.url,
        pause: paused => lifecycle.updateCollection({ paused, windowDays: 30 }),
        async denied(capability) {
            const response = await fetch(origin + "/api/state", { headers: { "X-Board-Capability": capability } });
            assert.equal(response.status, 403);
            assert.equal((await response.json()).code, "wire_access_revoked");
        },
        async release(capability) {
            const response = await fetch(origin + "/api/session/release", { method: "POST",
                headers: { Origin: origin, "Content-Type": "application/json", "X-Board-Capability": capability }, body: "{}" });
            assert.equal(response.status, 200);
        },
        async retained() {
            const board = await loadBoardState(context);
            const digest = bytes => createHash("sha256").update(bytes).digest("hex");
            return { board: digest(JSON.stringify(board)), files: await Promise.all(board.exports.flatMap(bundle =>
                Object.values(bundle.files).map(async file => digest(await readFile(file))))) };
        },
    };
}

async function approveReport(page) {
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator("#reportTitle").fill("Synthetic retained save");
    const previewResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const preview = await previewResponse;
    assert.equal(preview.status(), 200, (await preview.json()).error);
    await page.waitForFunction(() => document.getElementById("reportsView").dataset.reportPhase !== "scanning");
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "ready", await page.locator("#reportJourneyError").textContent());
    await page.locator("#reportApproval input").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeEnabled();
}

async function gate(page, text) {
    if (await page.locator("#wireAccountTrigger").getAttribute("aria-expanded") !== "true") await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountGate")).toHaveText(text);
    await expect(page.locator("#wireAccountGate")).toBeEnabled();
    const action = text === "Sign in to WIRE" ? "wire-sign-in" : "wire-sign-out";
    const completed = page.waitForResponse(response => response.url().endsWith("/api/access/command")
        && response.request().postDataJSON()?.action === action);
    await page.locator("#wireAccountGate").click();
    const response = await completed;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).outcome, "completed");
}

async function privateContentAbsent(page) {
    const found = await page.evaluate(() => {
        const privateText = value => /SYNTHETIC_PRIVATE_(?:PROMPT|FOLLOWUP)|SYNTHETIC_LITERAL|Synthetic retained save|Synthetic project/.test(value ?? "");
        return [...document.body.querySelectorAll("*")].flatMap(node => {
            const fields = [...node.attributes].filter(attribute => privateText(attribute.value)).map(attribute => "attribute:" + attribute.name);
            if ([...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && privateText(child.textContent))) fields.push("text");
            if (["INPUT", "TEXTAREA"].includes(node.tagName) && privateText(node.value)) fields.push("value");
            return fields.map(field => ({ tag: node.tagName, id: node.id, className: typeof node.className === "string" ? node.className : "", field }));
        });
    });
    assert.deepEqual(found, [], "visible, hidden and field content contains no synthetic private canary");
    assert.equal(await page.locator("#activityPager").textContent(), "", "private result counts and paging closures are cleared");
    await expect(page.locator("#analyzeTools")).toBeHidden();
}

test("normal refresh preserves an actionable nonprivate shell through access checks and cross-tab WIRE logout", { timeout: 45000 }, async t => {
    const app = await setup(t, { signedIn: true }), { page } = app;
    const first = Promise.withResolvers(), later = Promise.withResolvers(), settingsFirst = Promise.withResolvers();
    let hold = first, held = 0;
    t.after(() => { first.resolve(); later.resolve(); settingsFirst.resolve(); });
    await page.route("**/api/access/watch", async route => {
        const waiting = hold;
        if (waiting) { held++; await waiting.promise; }
        await route.continue();
    });
    const phases = [];
    const capture = async phase => {
        phases.push({ phase, heading: await page.locator("h1:visible").allTextContents(),
            workspace: await page.locator("#workspace").isVisible(),
            settings: await page.locator('[data-nav="settings"]').isVisible(),
            privateText: (await page.content()).includes("SYNTHETIC_PRIVATE_PROMPT") });
        if (process.env.WIRE_STARTUP_PROOFS) {
            await mkdir(process.env.WIRE_STARTUP_PROOFS, { recursive: true });
            await page.screenshot({ path: join(process.env.WIRE_STARTUP_PROOFS, phase + ".png") });
        }
    };
    await page.goto(app.url + "#analyze");
    await expect.poll(() => held).toBe(1);
    await capture("01-first-access-check");
    hold = null; first.resolve();
    await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    await capture("02-saved-analyze");
    hold = later;
    await expect.poll(() => held).toBeGreaterThan(1);
    await expect(page.locator("#workspace")).toBeHidden({ timeout: 10000 });
    await privateContentAbsent(page);
    await capture("03-access-expired");
    for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Access shell fits ${width}px`);
        await capture(`access-expired-${width}`);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('[data-nav="settings"]').click();
    const navigatedWithoutGrant = new URL(page.url()).hash.startsWith("#settings");
    await capture("04-settings-without-private-access");
    hold = null; later.resolve();
    await page.goto(app.url + "#settings?section=connection");
    await expect(page.locator("#wireMicrosoftConnection")).toBeVisible();
    hold = settingsFirst;
    const beforeSettingsWatch = held;
    await page.reload();
    await expect.poll(() => held).toBeGreaterThan(beforeSettingsWatch);
    await capture("05-settings-first-access-check");
    hold = null; settingsFirst.resolve();
    await expect(page.locator("#wireMicrosoftConnection")).toBeVisible();
    await capture("05-settings-current");
    const other = await app.newPanel();
    await other.goto(app.url + "#analyze");
    await expect(other.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    const retained = await app.retained();
    await gate(page, "Sign out of WIRE");
    await expect(other.locator("#message")).toContainText("signed out");
    await privateContentAbsent(page); await privateContentAbsent(other);
    await capture("06-wire-signed-out");
    await other.reload();
    await expect(other.locator("#message")).toContainText("signed out");
    await privateContentAbsent(other);
    await gate(page, "Sign in to WIRE");
    await expect(other.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    assert.deepEqual(await app.retained(), retained);
    t.diagnostic(JSON.stringify({ phases, navigatedWithoutGrant }));
    assert.ok(phases.filter(value => !value.workspace).every(value => value.heading.length === 1),
        "Checking, expired and signed-out states keep the route's nonprivate heading, not an empty screen.");
    assert.ok(navigatedWithoutGrant, "Settings navigation does not require a private activity grant.");
    assert.ok(phases.filter(value => !value.workspace).every(value => !value.privateText));
    assert.deepEqual(app.calls.filter(call => call.path === "/api/access/command").map(call => call.input.action),
        ["wire-sign-out", "wire-sign-in"]);
});

test("a refused first saved read still allows normal Connection Settings without replay", async t => {
    const app = await setup(t, { signedIn: true }), { page } = app;
    await page.route("**/api/snapshot", route => route.fulfill({ status: 409, json: {
        error: "wire_access_global_collection_stale", code: "wire_access_global_collection_stale",
    } }));
    await page.goto(app.url + "#analyze");
    await expect(page.locator("#storedViewRetry")).toBeVisible();
    await page.locator("#accessSettings").click();
    await expect(page.locator("#wireMicrosoftConnection")).toBeVisible();
    await expect(page.locator("#pageTitle")).toHaveText("Settings");
    await expect(page.locator("#storedViewRetry")).toBeVisible();
    assert.equal(app.calls.filter(call => call.path === "/api/access/command").length, 0);
});

test("Microsoft Settings search and deep links reach the accepted host without enabling native commands", async t => {
    const app = await setup(t, { signedIn: true });
    await app.page.goto(app.url + "#settings?setting=microsoft-connection");
    await expect(app.page.locator("#wireMicrosoftConnection")).toBeVisible();
    await expect(app.page.locator("#wireMicrosoftConnection")).toBeFocused();
    await expect(app.page.locator("#wireMicrosoftStatus")).toHaveText("Unavailable");
    await expect(app.page.locator("#wireMicrosoftAction")).toBeDisabled();
    await expect.poll(() => app.calls.filter(call => call.path === "/api/profile/github").length).toBe(1);
    await app.page.locator("#settingsSearch").fill("Cowork");
    const destination = app.page.locator('#settingsSearchResults a[data-setting="microsoft-connection"]');
    await expect(destination).toContainText("Unavailable");
    await destination.click();
    await expect(app.page.locator("#wireMicrosoftConnection")).toBeFocused();
    assert.equal(app.calls.some(call => /microsoft/.test(call.path)), false, "Navigation does not open a native connection.");
    assert.equal(app.calls.filter(call => call.path === "/api/profile/github").length, 1, "Settings navigation does not repeat the shell's local profile read.");
    assert.equal(app.calls.some(call => call.path === "/api/access/command"), false, "No account action is implicit.");
});

test("actual enforced bootstrap watches a false seed without any private request or history restoration", async t => {
    const { page, requests, url } = await setup(t);
    await page.addInitScript(() => {
        history.replaceState({ evidenceView: { url: "#analyze", search: "OLD_PRIVATE_QUERY" } }, "", "#analyze");
    });
    await page.goto(url + "#analyze");
    await expect.poll(() => requests.filter(path => path === "/api/access/watch").length).toBeGreaterThan(0);
    await expect(page.locator("#message")).toContainText("signed out");
    await expect(page.locator("#workspace")).toBeHidden();
    assert.deepEqual(requests.filter(path => !["/api/access/watch", "/api/access/status", "/api/access/receipt", "/api/session"].includes(path)), []);
    assert.doesNotMatch(await page.content(), /OLD_PRIVATE_QUERY/);
    assert.equal(await page.evaluate(() => history.state?.evidenceView?.search), undefined);
});

test("idle revocation erases private activity and fresh access resolves the canonical route with a new request", async t => {
    const { page, requests, command, url } = await setup(t, { signedIn: true });
    await page.goto(url + "#activity?scope=all");
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    const before = requests.filter(path => path === "/api/snapshot").length;
    const canonical = new URL(page.url()).hash;
    await command("wire-sign-out");
    await expect(page.locator("#message")).toContainText("signed out");
    await privateContentAbsent(page);
    assert.equal(requests.filter(path => path === "/api/snapshot").length, before);
    assert.equal(new URL(page.url()).hash, canonical);
    await command("wire-sign-in");
    await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    assert.equal(requests.filter(path => path === "/api/snapshot").length, before + 1);
});

test("access revocation retires a maximized reader and active resize without retained text or geometry replay", { timeout: 30000 }, async t => {
    const record = fixture("combined-reader-withdrawal");
    record.userPrompt.text += " Keep the invented release notes and unresolved decisions separate.".repeat(80);
    const app = await setup(t, { signedIn: true, records: [record] }), { page } = app;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(app.url);
    const plotLink = page.locator("#chart a[href]").first();
    await expect(plotLink).toBeAttached();
    const heldPlotLink = await plotLink.elementHandle();
    await page.locator(".request-card-open").first().click();
    await expect(page.locator("#contextSidebar")).toBeVisible();
    const heldSourceLink = await page.locator("#requestContent .card-chat a").elementHandle();
    assert.ok(heldSourceLink);
    async function staleLinksCannotNavigate() {
        const url = page.url(), reads = app.requests.filter(path => path === "/api/snapshot").length;
        for (const link of [heldPlotLink, heldSourceLink]) {
            assert.equal(await link.evaluate(node => node.dispatchEvent(new MouseEvent("click", {
                bubbles: true, cancelable: true, button: 0,
            }))), false, "Retired data links still cancel their original click.");
        }
        assert.equal(page.url(), url, "A fresh access grant cannot authorize a held data link.");
        assert.equal(app.requests.filter(path => path === "/api/snapshot").length, reads);
    }
    await page.locator("#widenInteraction").click();
    await page.locator("#expandInteraction").click();
    await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "expanded");
    const text = await page.locator('[data-reader-section="prompt"] pre').evaluateHandle(node => node.firstChild);
    await app.command("wire-sign-out");
    await expect(page.locator("#message")).toContainText("signed out");
    await privateContentAbsent(page);
    await staleLinksCannotNavigate();
    assert.equal(await text.evaluate(node => node.data), "");
    assert.equal(await page.locator("#main").evaluate(node => node.inert), false);
    assert.equal(await page.evaluate(() => document.body.hasAttribute("data-reader-expanded")), false);
    await app.command("wire-sign-in");
    await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "docked");
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    await staleLinksCannotNavigate();
    const handle = await page.locator("#readerResize").boundingBox();
    await page.mouse.move(handle.x + 4, handle.y + 200); await page.mouse.down();
    await page.mouse.move(handle.x - 50, handle.y + 200);
    await expect(page.locator("#contextSidebar")).toHaveAttribute("data-resizing", "");
    await app.command("wire-sign-out");
    await expect(page.locator("#message")).toContainText("signed out");
    await page.mouse.up();
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.hasAttribute("data-resizing")), false);
    await privateContentAbsent(page);
});

test("real shared watch clears an idle Search query and held result text without replaying that query after sign-in", async t => {
    const app = await setup(t), controller = app.page, reader = await app.newPanel();
    await controller.goto(app.url + "#analyze?scope=all");
    await reader.goto(app.url + "#analyze?scope=all");
    await gate(controller, "Sign in to WIRE");
    await expect(reader.locator("#workspace")).toBeVisible();
    const query = "SYNTHETIC_PRIVATE_PROMPT";
    await reader.locator("#wireSearch").fill(query);
    const hit = reader.locator("#wireSearchResults button").first();
    await expect(hit).toContainText(query);
    const text = await hit.evaluateHandle((node, query) => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) if (text.data.includes(query)) return text;
        throw new Error("The synthetic private Search result must exist before withdrawal.");
    }, query);
    await gate(controller, "Sign out of WIRE");
    await expect(reader.locator("#message")).toBeVisible();
    await expect(reader.locator("#wireSearch")).toHaveValue("");
    await expect(reader.locator("#wireSearchResults button")).toHaveCount(0);
    assert.equal(await text.evaluate(node => node.data), "");
    await privateContentAbsent(reader);
    const afterWithdrawal = app.calls.length;
    await gate(controller, "Sign in to WIRE");
    await expect(reader.locator("#workspace")).toBeVisible();
    await expect(reader.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(reader.locator("#wireSearch")).toHaveValue("");
    assert.equal(app.calls.slice(afterWithdrawal).some(call => JSON.stringify(call.input).includes(query)), false);
    await reader.locator("#wireSearch").fill(query);
    await expect(reader.locator("#wireSearchResults button").first()).toContainText(query);
});

test("real shared watch clears an idle guide's exact rows and source notes before fresh authorized reopening", async t => {
    const app = await setup(t), controller = app.page, reader = await app.newPanel();
    await controller.goto(app.url + "#analyze?scope=all");
    await reader.goto(app.url + "#analyze?scope=all");
    await gate(controller, "Sign in to WIRE");
    await expect(reader.locator("#workspace")).toBeVisible();
    const openExact = async () => {
        await reader.locator("#openChartReference").click();
        await reader.locator("#chartReferenceAllTopics").click();
        await reader.locator('button[data-reference-topic="services"]').click();
        await reader.locator("#chartReferenceShowData").click();
        await expect(reader.locator("#chartReferenceData tbody tr").first()).toBeVisible();
    };
    await openExact();
    await reader.locator("#chartReferenceSource > summary").click();
    await expect(reader.locator("#meaningMatched")).not.toBeEmpty();
    const cell = await reader.locator("#chartReferenceData tbody td").first().evaluateHandle(node =>
        document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode());
    assert.ok((await cell.evaluate(node => node.data)).length > 0);
    const before = app.calls.filter(call => call.page === reader && call.path === "/api/snapshot").length;
    await gate(controller, "Sign out of WIRE");
    await expect(reader.locator("#message")).toBeVisible();
    await expect(reader.locator("#meaning")).toBeHidden();
    for (const id of ["countTable", "chartReferenceData", "chartReferenceQualification", "meaningMatched", "meaningSources", "meaningBody"]) {
        await expect(reader.locator("#" + id)).toBeEmpty();
    }
    assert.equal(await cell.evaluate(node => node.data), "");
    await privateContentAbsent(reader);
    await gate(controller, "Sign in to WIRE");
    await expect(reader.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    assert.equal(app.calls.filter(call => call.page === reader && call.path === "/api/snapshot").length, before + 1);
    await openExact();
    assert.equal(await cell.evaluate(node => node.data), "");
});

for (const emptyB of [false, true]) test(`real shared watch preserves selected ${emptyB ? "empty B" : "B"} drafts while retiring the old pair and resolving a fresh comparison`, async t => {
    const earlier = fixture("test-earlier"), later = fixture("test-later");
    later.capturedAt = "2026-10-01T12:00:00.000Z";
    const bDate = emptyB ? "2026-10-02" : "2026-10-01";
    const app = await setup(t, { records: [earlier, later] }), controller = app.page, reader = await app.newPanel();
    await controller.goto(app.url + "#analyze?scope=all");
    await reader.goto(app.url + "#analyze?scope=all");
    await gate(controller, "Sign in to WIRE");
    await expect(reader.locator("#workspace")).toBeVisible();
    await reader.locator("#comparePeriods").click();
    for (const [id, value] of [["comparisonAFrom", "2026-09-30"], ["comparisonATo", "2026-09-30"],
        ["comparisonBFrom", bDate], ["comparisonBTo", bDate]]) await reader.locator("#" + id).fill(value);
    await reader.locator("#applyPeriodComparison").click();
    await expect(reader.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await reader.locator("#comparisonRecordsB").click();
    await expect(reader.locator("#comparisonExactRecordsB tbody tr")).toHaveCount(emptyB ? 0 : 1);
    if (emptyB) await expect(reader.locator("#comparisonExactRecordsB")).toContainText("No matching activity");
    const oldLink = await reader.locator("#comparisonExactRecordsA a").first().elementHandle();
    const oldTarget = await oldLink.evaluateHandle(node => node.getAttributeNode("href"));
    const oldCaption = await reader.locator("#comparisonAcceptedScope").elementHandle();
    assert.ok((await oldCaption.textContent()).length > 0);
    assert.ok((await oldTarget.evaluate(attribute => attribute.value)).includes("test-earlier"));
    const canonical = reader.url();
    const before = app.calls.filter(call => call.page === reader && call.path === "/api/period-comparison").length;
    await gate(controller, "Sign out of WIRE");
    await expect(reader.locator("#message")).toBeVisible();
    await expect(reader.locator("#periodComparisonResults")).toBeEmpty();
    assert.equal(await oldCaption.textContent(), "");
    await expect(reader.locator("#comparisonBFrom")).toHaveValue(bDate);
    await expect(reader.locator("#comparisonBTo")).toHaveValue(bDate);
    assert.equal(await oldTarget.evaluate(attribute => attribute.value), "");
    await privateContentAbsent(reader);
    await gate(controller, "Sign in to WIRE");
    await expect(reader.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(reader.locator("#comparisonRecordsB")).toHaveAttribute("aria-selected", "true");
    await expect(reader.locator("#comparisonExactRecordsB tbody tr")).toHaveCount(emptyB ? 0 : 1);
    if (emptyB) await expect(reader.locator("#comparisonExactRecordsB")).toContainText("No matching activity");
    assert.equal(app.calls.filter(call => call.page === reader && call.path === "/api/period-comparison").length, before + 1);
    await oldLink.evaluate(node => node.click());
    assert.equal(reader.url(), canonical);
});

test("real shared watch erases idle Settings source drafts but preserves an unsent history preference without collection", async t => {
    const app = await setup(t), controller = app.page, reader = await app.newPanel();
    await controller.goto(app.url + "#analyze?scope=all");
    await reader.goto(app.url + "#settings?section=connection");
    await gate(controller, "Sign in to WIRE");
    await expect(reader.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await reader.locator("#reviewSource").click();
    const database = "C:\\synthetic-private-draft\\metadata.db", sessions = "C:\\synthetic-private-draft\\sessions";
    await reader.locator("#sourceDatabase").fill(database);
    await reader.locator("#sourceSessions").fill(sessions);
    await selectActivityOption(reader, "collectionWindow", "90");
    await gate(controller, "Sign out of WIRE");
    await expect(reader.locator("#message")).toBeVisible();
    await expect(reader.locator("#sourceDatabase")).toHaveValue("");
    await expect(reader.locator("#sourceSessions")).toHaveValue("");
    await expect(reader.locator("#collectionWindow")).toHaveValue("90");
    await privateContentAbsent(reader);
    await gate(controller, "Sign in to WIRE");
    await expect(reader.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(reader.locator("#collectionWindow")).toHaveValue("90");
    await expect(reader.locator("#sourceDatabase")).not.toHaveValue(database);
    await expect(reader.locator("#sourceSessions")).not.toHaveValue(sessions);
    assert.equal(app.calls.some(call => JSON.stringify(call.input).includes("synthetic-private-draft")), false);
    assert.equal(app.requests.filter(path => ["/api/collection/settings", "/api/collection/approve", "/api/collection/now"].includes(path)).length, 0);
});

test("a real private cross-tab handoff waits for recipient authority and cannot revive a selection retired by sign-out", { timeout: 30000 }, async t => {
    const unrelated = fixture("test-unrelated");
    unrelated.userPrompt.text = "SYNTHETIC_UNRELATED_PROMPT";
    const app = await setup(t, { records: [fixture(), unrelated] }), controller = app.page, source = await app.newPanel();
    await controller.goto(app.url + "#analyze?scope=all");
    await source.goto(app.url + "#analyze?scope=all");
    await gate(controller, "Sign in to WIRE");
    await expect(source.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await restoreLegacySearch(source, "SYNTHETIC_PRIVATE_PROMPT");
    await expect(source.locator("#activityList .request-card-open")).toHaveCount(1);
    const target = source.locator("#outcomeChart").getByRole("link", { name: /^Worked:/ });
    await expect(target).toHaveAttribute("href", /privateView=required/);
    assert.equal((await target.getAttribute("href")).includes("SYNTHETIC_PRIVATE_PROMPT"), false);
    await source.evaluate(() => {
        const take = window.__wireTakePrivateNavigation;
        window.fixtureHandoffClaims = 0;
        window.__wireTakePrivateNavigation = (...args) => { window.fixtureHandoffClaims++; return take(...args); };
    });
    const pendingWatch = Promise.withResolvers(), deliverWatch = Promise.withResolvers(), popupRequests = [];
    let held = false;
    source.context().on("page", page => page.on("pageerror", error => app.errors.push(error.message)));
    source.context().on("request", request => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.startsWith("/api/") && request.frame().page() !== source) popupRequests.push(pathname);
    });
    await source.context().route("**/api/access/watch", async route => {
        if (route.request().frame().page() !== source && !held) {
            held = true; pendingWatch.resolve();
            await deliverWatch.promise;
        }
        await route.continue();
    });
    try {
        const opened = source.context().waitForEvent("page");
        await target.click({ modifiers: ["Control"] });
        const recipient = await opened;
        await pendingWatch.promise;
        assert.equal(await source.evaluate(() => window.fixtureHandoffClaims), 0);
        assert.deepEqual(popupRequests.filter(path => !["/api/access/watch", "/api/access/status", "/api/session"].includes(path)), []);
        await gate(controller, "Sign out of WIRE");
        await expect(source.locator("#message")).toBeVisible();
        deliverWatch.resolve();
        await expect(recipient.locator("#message")).toContainText("signed out");
        assert.equal(await source.evaluate(() => window.fixtureHandoffClaims), 0);
        assert.deepEqual(popupRequests.filter(path => !["/api/access/watch", "/api/access/status", "/api/session"].includes(path)), []);
        await gate(controller, "Sign in to WIRE");
        await expect(recipient.locator("#message")).toContainText("private selection could not be restored");
        await expect(recipient.locator("#activityListSummary")).toBeHidden();
        assert.equal(await source.evaluate(() => window.fixtureHandoffClaims), 1);
        assert.equal(await recipient.evaluate(() => window.opener), null);
        assert.equal(recipient.url().includes("privateView"), false);
        assert.equal(recipient.url().includes("SYNTHETIC_PRIVATE_PROMPT"), false);
    } finally { deliverWatch.resolve(); }
});

test("the shared save callback uses the report owner's verified original identity through a real export", async t => {
    const { page, requests, url } = await setup(t, { signedIn: true });
    await page.goto(url + "#reports?task=create&scope=all");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await approveReport(page);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportSaveBody")).toContainText("Saved on this device.");
    assert.equal(requests.filter(path => path === "/api/export").length, 1);
});

test("actual lifecycle Pause changes control state without clearing retained reading or reloading its snapshot", async t => {
    const app = await setup(t, { signedIn: true });
    await app.page.goto(app.url + "#analyze?scope=all");
    await expect(app.page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    const original = await app.page.locator(".request-card-open").first().elementHandle();
    const snapshots = app.requests.filter(path => path === "/api/snapshot").length;
    for (const paused of [false, true]) {
        const state = app.page.waitForResponse(async response => response.url().endsWith("/api/access/watch")
            && (await response.json()).collection === (paused ? "paused" : "enabled"));
        await app.pause(paused);
        assert.equal((await (await state).json()).retained, true);
        await expect(app.page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
        assert.equal(await original.evaluate(node => node.isConnected), true);
    }
    assert.equal(app.requests.filter(path => path === "/api/snapshot").length, snapshots);
});

test("deadline withdrawal during snapshot publication cannot restore a private model or reveal its workspace", async t => {
    const app = await setup(t, { signedIn: true }), page = app.page;
    let watches = 0;
    await page.route("**/api/access/watch", route => {
        if (++watches === 1) return route.continue();
        // Subsequent real watches stay held until this owned test page closes.
    });
    await page.addInitScript(() => {
        const now = performance.now.bind(performance), fetchNative = fetch.bind(window), json = Response.prototype.json;
        const starts = new WeakMap();
        let logical = null, previous = now(), deadline = null;
        window.armNextSnapshot = false; window.fixtureExpired = false;
        Object.defineProperty(performance, "now", { configurable: true, value() {
            previous = logical === null ? now() : ++logical;
            if (logical !== null && previous >= deadline) window.fixtureExpired = true;
            return previous;
        } });
        window.fetch = async (...args) => {
            const started = previous, response = await fetchNative(...args);
            starts.set(response, started); return response;
        };
        Response.prototype.json = async function () {
            const value = await json.call(this);
            if (this.url.endsWith("/api/access/watch") && value.retained) deadline = starts.get(this) + 5000;
            if (this.url.endsWith("/api/snapshot") && window.armNextSnapshot) {
                window.armNextSnapshot = false;
                logical = deadline - 4;
            }
            return value;
        };
    });
    await page.goto(app.url + "#analyze?scope=all");
    await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    await expect(page.locator("#wireAccountGate")).toBeEnabled();
    const refresh = await revealStoredRefresh(page);
    await page.evaluate(() => { window.armNextSnapshot = true; });
    await refresh.click();
    await page.waitForFunction(() => window.fixtureExpired);
    assert.equal(await page.locator("#workspace").evaluate(node => node.hidden), true);
    await expect(page.locator("#message")).toBeVisible();
    await privateContentAbsent(page);
    assert.equal(app.requests.filter(path => path === "/api/snapshot").length, 2);
});

test("explicit unbound capability renewal settles the original rejected save without stranding its finalizer or retrying export", async t => {
    const app = await setup(t, { unbound: true }), page = app.page;
    await page.goto(app.url + "#reports?task=create&scope=all");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await approveReport(page);
    await page.route("**/api/export", async route => {
        await app.release(route.request().headers()["x-board-capability"]);
        await route.continue();
    });
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportJourneyError")).toContainText("save was rejected before dispatch");
    await expect(page.getByRole("button", { name: "Back to contents", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Check save status", exact: true })).toHaveCount(0);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    assert.equal(app.requests.filter(path => path === "/api/export").length, 1);
    assert.equal(app.requests.filter(path => path === "/api/session").length, 1);
    assert.equal((await app.retained()).files.length, 0);
});

test("explicit unbound lost export delivery remains unknown and recovers the original save without replay", async t => {
    const app = await setup(t, { unbound: true }), page = app.page;
    await page.goto(app.url + "#reports?task=create&scope=all");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await approveReport(page);
    await page.route("**/api/export", async route => {
        assert.equal((await route.fetch()).status(), 200);
        await route.abort("connectionfailed");
    });
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportJourneyError")).toContainText("local write may have completed");
    await expect(page.locator("#clearPreviewSelection")).toBeDisabled();
    await page.getByRole("button", { name: "Check save status", exact: true }).click();
    await expect(page.locator("#reportSaveBody")).toContainText("Saved on this device.");
    await expect(page.locator("#closeDialog")).toBeEnabled();
    await expect(page.locator("#clearPreviewSelection")).toBeEnabled();
    assert.equal(app.requests.filter(path => path === "/api/export").length, 1);
});

test("a retired preview's detached edit cannot invalidate a successor review or cancel its preview", async t => {
    const app = await setup(t, { unbound: true }), page = app.page;
    await page.goto(app.url + "#reports?task=create&scope=all");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await approveReport(page);
    const oldEdit = await page.locator(".prompt-report textarea").first().elementHandle();
    assert.ok(oldEdit);
    await approveReport(page);
    assert.equal(await oldEdit.evaluate(node => node.isConnected), false);
    const cancels = app.requests.filter(path => path === "/api/cancel-preview").length;
    await oldEdit.evaluate(node => {
        node.value = "STALE_OVERRIDE";
        node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "reviewed");
    assert.equal(app.requests.filter(path => path === "/api/cancel-preview").length, cancels);
    assert.equal(app.requests.filter(path => path === "/api/export").length, 0);
});

test("real sign-out clears a private report draft while preserving unsent formats and reusable Contents controls", async t => {
    const app = await setup(t, { signedIn: true }), page = app.page;
    await page.goto(app.url + "#reports?task=create&scope=all");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator("#reportTitle").fill("Synthetic retained save");
    await page.locator("#formatOptions input[value=json]").check();
    await page.locator("#additionalMasking > summary").click();
    await page.locator("#manualTerms").fill("PRIVATE_MASKING_TERM");
    await gate(page, "Sign out of WIRE");
    await expect(page.locator("#message")).toBeVisible();
    await privateContentAbsent(page);
    assert.equal(await page.locator("#manualTerms").inputValue(), "");
    await gate(page, "Sign in to WIRE");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await chooseReportScope(page, "all");
    await reportContents(page);
    await expect(page.locator("#reportTitle")).toHaveValue("");
    await expect(page.locator("#manualTerms")).toHaveValue("");
    await expect(page.locator("#formatOptions input[value=json]")).toBeChecked();
    await expect(page.locator("#contextSidebarFooter").getByRole("button", { name: "Back to activity", exact: true })).toBeVisible();
    await expect(page.locator("#exportBtn")).toBeVisible();
    assert.equal(app.requests.filter(path => ["/api/preview", "/api/export", "/api/cancel-preview"].includes(path)).length, 0);
});

test("real WIRE Sign out clears active and idle panels, preserves an original unknown save and permits only fresh recovery", { timeout: 60000 }, async t => {
    const app = await setup(t), active = app.page, idle = await app.newPanel();
    const frames = [];
    const capture = async (stage, states) => {
        const directory = process.env.WIRE_ACCESS_SCREENSHOTS;
        if (!directory) return;
        const sourceTree = process.env.WIRE_ACCESS_SOURCE_TREE;
        assert.match(sourceTree || "", /^[a-f0-9]{40}$/, "captured proof requires its exact frozen source tree");
        await mkdir(directory, { recursive: true });
        const captured = await Promise.all([["active", active], ["idle", idle]].map(async ([name, page]) => {
            const file = stage + "-" + name + ".png";
            const bytes = await page.screenshot({ path: join(directory, file), fullPage: true });
            return { file, panel: name, state: states[name], sha256: createHash("sha256").update(bytes).digest("hex") };
        }));
        frames.push(...captured);
        await writeFile(join(directory, "frames.json"), JSON.stringify({
            schemaVersion: 1, sourceTree, testFile: "tests/access-client.browser.test.mjs", frames,
        }, null, 2));
    };
    await active.goto(app.url + "#reports?task=create&scope=all");
    await idle.goto(app.url + "#analyze?scope=all");
    assert.equal(await active.locator("#wireAccountGate").count(), 1, "the actual account gate must be wired, not a test-only control");
    await gate(active, "Sign in to WIRE");
    await expect(active.locator("#workspace")).toBeVisible();
    await expect(idle.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    await idle.locator(".request-card-open").first().click();
    await expect(idle.locator("#requestContent")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    const canonical = new URL(idle.url()).hash;
    await idle.evaluate(() => {
        window.fixtureCopyWrites = 0;
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            writeText: () => { window.fixtureCopyWrites++; return new Promise(resolve => { window.finishFixtureCopy = resolve; }); },
        } });
    });
    const copy = idle.locator("#requestContent .ux-copy:visible").first();
    const oldCopy = await copy.elementHandle();
    const oldProject = await idle.locator('#projectFilter option[value="test-project"]').elementHandle();
    const oldProjectText = await oldProject.evaluateHandle(node => node.firstChild);
    const oldProjectValue = await oldProject.evaluateHandle(node => node.getAttributeNode("value"));
    await copy.click();
    assert.equal(await idle.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById("requestContent"));
        const selected = getSelection(); selected.removeAllRanges(); selected.addRange(range);
        return selected.toString().includes("SYNTHETIC_PRIVATE_PROMPT");
    }), true);
    await approveReport(active);
    await capture("01-signed-in", { active: "Signed in; report approved for saving.",
        idle: "Signed in; private interaction visible with selection and a pending copy." });
    const oldTitleText = await active.locator("#pageTitle").evaluateHandle(node => node.firstChild);
    const committed = Promise.withResolvers(), deliver = Promise.withResolvers();
    await active.route("**/api/export", async route => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        committed.resolve();
        await deliver.promise;
        await route.fulfill({ response });
    });
    try {
        await active.getByRole("button", { name: "Save report", exact: true }).click();
        await committed.promise;
        const retained = await app.retained();
        assert.ok(retained.files.length > 0);
        const readsBefore = app.requests.filter(path => path === "/api/snapshot").length;
        assert.equal(await idle.evaluate(() => document.hidden), false);
        await expect(idle.locator("#requestContent")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
        await gate(active, "Sign out of WIRE");
        for (const panel of [active, idle]) {
            await expect(panel.locator("#message")).toBeVisible();
            await expect(panel.locator("#message")).toContainText("signed out");
            await privateContentAbsent(panel);
            await expect(panel.locator("iframe")).toHaveCount(0);
        }
        assert.equal(new URL(idle.url()).hash, canonical);
        assert.equal(await idle.evaluate(() => getSelection().toString()), "");
        assert.equal(await oldTitleText.evaluate(node => node.data), "");
        assert.equal(await oldProjectText.evaluate(node => node.data), "");
        assert.equal(await oldProjectValue.evaluate(node => node.value), "");
        await capture("02-signed-out", { active: "Signed out; private report cleared while the original export response remains held.",
            idle: "Signed out; private reader, selection and held Text/Attr handles cleared." });
        const originalCapability = app.calls.find(call => call.page === idle && call.path === "/api/snapshot").capability;
        await app.denied(originalCapability);
        deliver.resolve();
        await idle.evaluate(async () => { window.finishFixtureCopy(); await Promise.resolve(); });
        await oldCopy.evaluate(node => node.click());
        assert.equal(await idle.evaluate(() => window.fixtureCopyWrites), 1);
        assert.equal(await oldCopy.getAttribute("data-copy-state"), null);
        assert.equal((await idle.locator("body").innerText()).includes("Copied to clipboard."), false);
        await privateContentAbsent(active);
        await privateContentAbsent(idle);
        assert.equal(app.requests.filter(path => path === "/api/snapshot").length, readsBefore);
        await idle.goBack();
        await privateContentAbsent(idle);
        await idle.reload();
        await expect(idle.locator("#message")).toContainText("signed out");
        assert.equal(app.requests.filter(path => path === "/api/snapshot").length, readsBefore);
        const renewals = app.calls.filter(call => call.page === idle && call.path === "/api/session").length;
        await app.release(app.calls.findLast(call => call.page === idle && call.path === "/api/access/watch").capability);
        await expect.poll(() => app.calls.filter(call => call.page === idle && call.path === "/api/session").length).toBe(renewals + 1);
        await expect(idle.locator("#message")).toContainText("signed out");
        assert.equal(app.requests.filter(path => path === "/api/snapshot").length, readsBefore);
        await gate(idle, "Sign in to WIRE");
        await expect(active.locator("#reportSaveBody")).toContainText("original report save is unconfirmed");
        await expect(idle.locator("#workspace")).toBeVisible();
        await active.getByRole("button", { name: "Check save status", exact: true }).click();
        await expect(active.locator("#reportSaveBody")).toContainText("Saved on this device.");
        await expect(active.locator("#closeDialog")).toBeEnabled();
        await expect(active.locator("#clearPreviewSelection")).toBeEnabled();
        await idle.goto(app.url + canonical);
        const beforeCanonicalRead = app.requests.filter(path => path === "/api/snapshot").length;
        await idle.reload();
        await expect(idle.locator("#requestContent")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
        assert.equal(app.requests.filter(path => path === "/api/snapshot").length, beforeCanonicalRead + 1);
        await capture("03-fresh-recovery", { active: "Signed in again; original save verified without another export.",
            idle: "Signed in again; canonical interaction loaded by a fresh request." });
        await active.getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(active.locator("#savedReportReader iframe")).toBeVisible();
        const frozen = await active.locator("#savedReportReader iframe").elementHandle();
        await gate(idle, "Sign out of WIRE");
        for (const panel of [active, idle]) {
            await expect(panel.locator("#message")).toBeVisible();
            await expect(panel.locator("#message")).toContainText("signed out");
            await privateContentAbsent(panel);
        }
        assert.deepEqual(await frozen.evaluate(node => ({ html: node.srcdoc, title: node.title, connected: node.isConnected })),
            { html: "", title: "", connected: false });
        await capture("04-frozen-reader-withdrawn", { active: "Signed out again; frozen saved-report frame blanked and detached.",
            idle: "Signed out again; private reader cleared." });
        assert.equal(app.requests.filter(path => path === "/api/export").length, 1);
        assert.deepEqual(app.calls.filter(call => call.path === "/api/access/command").map(call => call.input.action),
            ["wire-sign-in", "wire-sign-out", "wire-sign-in", "wire-sign-out"]);
        assert.equal(app.requests.filter(path => /\/(?:delete|deletion\/confirm|record$|recollection\/confirm|collection\/now)/.test(path)).length, 0);
        assert.deepEqual(await app.retained(), retained);
    } finally { deliver.resolve(); }
});
