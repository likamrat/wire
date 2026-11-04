import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { activityDeletionVersion } from "../lib/deletion-identities.mjs";
import { createNativeRetainedViews } from "../lib/native-retained-views.mjs";
import { committedNativeReportFixture } from "./native-report-controller-fixture.mjs";
import { coworkFixture, chatFixture, multiCallChatFixture, envelope, recorded } from "./native-read-model-fixtures.mjs";
import { fixture, chooseTheme } from "./helpers.mjs";
import { createGitHubProfile } from "../lib/github-profile.mjs";
import { createGitHubProfileRoutes } from "../lib/github-profile-http.mjs";
import { microsoftProfileView } from "../lib/microsoft-profile.mjs";
import { adaptCoworkSourceRecordsWithResultFacts, COWORK_MATCHED_RESULT_ADAPTER_VERSION } from "../lib/cowork-source-adapter.mjs";
import { coworkSourceContext, sourceObservation } from "./cowork-source-adapter-fixtures.mjs";

const prompt = "**Read** the invented records.\n\nKeep the original order.";
const reply = "## Recorded finding\n\nTwo calls **worked**; one failed.\n\n- Keep unknown results separate.\n- Inspect the recorded evidence.\n\n```json\n{\"recorded\":true}\n```\n\n<script>window.readerInjection=true</script>";
function rows() {
    const values = coworkFixture();
    values[1].qualifiedFields.message.value.text = prompt;
    values.push(envelope("cowork", { id: "seq:20", event: "a", data: {} }, {
        message: recorded({ author: "assistant", representation: "plain-text", text: reply }),
    }, {}, 20));
    values.push(envelope("cowork", { id: "seq:21", event: "u", data: {} }, {
        message: recorded({ author: "user", representation: "follow-up", text: "A later follow-up, not the first prompt." }),
    }, {}, 21));
    const context = envelope("cowork", { id: "seq:22", event: "rc", data: {} }, {}, {}, 22);
    context.messageParts = [{ message: recorded({ author: "unknown", representation: "reply-fragment",
        text: "Distinct unverified fragment alongside authored messages." }),
    evidence: { sourceDocument: "invented-parts", pointer: "/data/content/0", nativeEventId: "seq:22" } }];
    values.push(context);
    return values;
}

function qualifyStarts(values) {
    for (const row of values.filter(row => row.record.event === "ts")) {
        const value = "2026-01-02T07:30:00.000Z";
        row.record.data.ts = value;
        row.qualifiedFields.observationTime = { availability: "recorded", scope: "observation",
            unit: "iso8601", basis: "cowork.data.ts", value };
        row.evidenceReferences.observationTime = { sourceDocument: "invented-native-response",
            pointer: `/events/${row.ordering.recordOrdinal}/data/ts`, nativeEventId: row.record.id };
    }
    return values;
}

async function setup(t, envelopes = rows(), expectedCalls = 3, options = {}) {
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes });
    await replaceEvidence(app.context, () => ({ records: [fixture("reader-github")],
        importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    const runtimeId = "00000000-0000-4000-8000-000000000001";
    const bootstrap = { schemaVersion: 1, mode: "enforced", runtimeId, maxWaitMs: 1000, freshnessMs: 5000, collectionMode: "source-aware" };
    const calls = [], controls = [], errors = [];
    let access = true, stale = false, releaseContext, frozenSnapshot;
    const profile = createGitHubProfile(app.context);
    const profileRoutes = createGitHubProfileRoutes(profile, { ownerActive: () => access });
    const contextGate = new Promise(resolve => { releaseContext = resolve; });
    async function collection() {
        const microsoft = await app.persistence.status({}, { owner: app.owner }), status = await app.lifecycle.status();
        const github = { state: "disconnected", connected: false, config: null, configVersion: null, revision: microsoft.revision,
            deletionVersion: activityDeletionVersion(await loadBoardState(app.context)), artifactRevision: 0 };
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
            if (req.method === "GET" && req.url === "/") {
                res.setHeader("Content-Type", "text/html");
                return res.end(renderHtmlShell("a".repeat(64), "native-reader-proof", bootstrap));
            }
            if (["/favicon.ico", "/favicon.svg"].includes(req.url)) return res.writeHead(204).end();
            if (req.method === "GET" && req.url === "/assets/assessment-contract.mjs") {
                res.setHeader("Content-Type", "text/javascript");
                return res.end(await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8"));
            }
            let body = ""; for await (const part of req) body += part;
            const input = body ? JSON.parse(body) : {}, lifecycle = await app.lifecycle.status();
            res.setHeader("Content-Type", "application/json");
            res.setHeader("X-Wire-Runtime", runtimeId); res.setHeader("X-Wire-Generation", String(lifecycle.generation));
            if (["/api/access/watch", "/api/access/status"].includes(req.url)) {
                await new Promise(resolve => setTimeout(resolve, 50));
                return res.end(JSON.stringify({ ...bootstrap, generation: lifecycle.generation, authorizationRevision: lifecycle.authorizationRevision,
                    wire: access ? "signed-in" : "signed-out", retained: access, collection: access ? "enabled" : "disabled" }));
            }
            if (!access) return res.writeHead(403).end(JSON.stringify({ error: "Fixture access withdrawn." }));
            if (req.url === "/api/snapshot") {
                if (options.freezeSnapshot && frozenSnapshot) return res.end(frozenSnapshot);
                const board = await loadBoardState(app.context);
                const snapshot = await currentStatePayload(app.context, board, input, undefined, app.services);
                const native = { status: "bounded", ...await views.query({ schemaVersion: 1, revision: board.revision,
                    sources: ["microsoft-365-chat", "microsoft-365-cowork"], analytics: input,
                    page: { limit: input.limit ?? 10, after: null } }, app.services.nativeReportAdmission) };
                const payload = JSON.stringify({ ...snapshot, collection: await collection(), nativeRead: native,
                    analytics: { ...snapshot.analytics, native } });
                if (options.freezeSnapshot) frozenSnapshot = payload;
                return res.end(payload);
            }
            if (req.url === "/api/collection/status") return res.end(JSON.stringify(await collection()));
            if (req.url === "/api/collection/sources/status") return res.end(JSON.stringify((await collection()).sourceAware));
            if (req.url === "/api/collection/microsoft/enrollment") return res.end(JSON.stringify({
                schemaVersion: 1, phase: "unavailable", generation: lifecycle.generation, actions: [], reason: "enrollment-unavailable",
            }));
            if (req.url === "/api/profile/github") return res.end(JSON.stringify(await profileRoutes.read(app.owner)));
            if (req.url === "/api/profile/microsoft") return res.end(JSON.stringify(microsoftProfileView(null)));
            if (req.url === "/api/assessment/detail") return res.writeHead(503).end(JSON.stringify({ error: "Assessment is unavailable in this reader fixture." }));
            if (["/api/search/events", "/api/search/status", "/api/search/query", "/api/search/cancel"].some(url => req.url.split("?")[0] === url)) {
                return res.writeHead(503).end(JSON.stringify({ error: "Ordinary Search is unavailable in this native-reader fixture." }));
            }
            if (req.url.startsWith("/api/retained/microsoft/")) {
                const method = req.url.split("/").at(-1);
                assert.ok(["query", "detail", "search", "inventory", "drilldown", "analyze"].includes(method));
                calls.push({ method, input });
                if (options.delayContext && input.section === "context") await contextGate;
                if (options.failCallsOnce && input.section === "calls") {
                    options.failCallsOnce = false;
                    return res.writeHead(503).end(JSON.stringify({ error: "Deliberate fixture read failure." }));
                }
                const value = await views[method](input, app.services.nativeReportAdmission);
                return res.end(JSON.stringify(stale && method === "detail" ? { ...value, sourceRevision: "f".repeat(64) } : value));
            }
            controls.push(req.url);
            return res.writeHead(503).end(JSON.stringify({ error: "No mutation or provider authority in this fixture." }));
        } catch (error) {
            res.writeHead(error.status || 500).end(JSON.stringify({ error: error.message }));
        }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
        if (message.type() === "error" && /^Error: <[\w:-]+> attribute [\w:-]+:/i.test(message.text())) errors.push(message.text());
    });
    await page.addInitScript(() => {
        window.copies = [];
        Object.defineProperty(navigator, "clipboard", { value: { async writeText(text) { window.copies.push(text); } } });
    });
    t.after(async () => {
        releaseContext();
        if (!t.passed) t.diagnostic((await page.locator("body").innerText()).slice(0, 8000));
        await browser.close(); await new Promise(resolve => server.close(resolve)); views.close();
        profileRoutes.close(); await profile.close();
        assert.deepEqual(errors, []); assert.deepEqual(controls, []);
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url);
    const sourceId = options.sourceId ?? "microsoft-365-" + envelopes[0].scope.surface;
    await expect(page.locator(`#activityList .activity-card[data-source-id=${sourceId}]`)).toHaveCount(1);
    const card = page.locator(`#activityList .activity-card[data-source-id=${sourceId}]`);
    await card.locator(".request-card-open").click();
    await expect(page.locator("#requestContent .reader-call")).toHaveCount(expectedCalls);
    async function collect(values) {
        const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, app.services.nativeReportAdmission);
        await app.persistence.commitSegmented(begun.ticket, values);
        app.persistence.retire(begun.ticket);
        return (await loadBoardState(app.context)).revision;
    }
    async function changeAuthority(kind) {
        await updateBoardState(app.context, state => {
            if (kind === "privacy") state.nativeRetention.privacyRevision++;
            else if (kind === "configuration") state.nativeRetention.configurationRevision++;
            else {
                state.deletion ??= { schemaVersion: 1, epoch: 0, identities: [], events: [], contextCalls: [], operations: {} };
                state.deletion.epoch++;
            }
        });
    }
    return { page, calls, card, url, releaseContext, collect, changeAuthority,
        withdraw: () => { access = false; }, stale: () => { stale = true; } };
}

test("normal native reader shows retained error and successful description through shared result rows", async t => {
    const context = coworkSourceContext();
    context.capture.parserVersion = COWORK_MATCHED_RESULT_ADAPTER_VERSION;
    const envelopes = adaptCoworkSourceRecordsWithResultFacts([
        sourceObservation({ id: "reader-error", event: "tx", data: {
            tid: "reader-error-call", tn: "native_document_update", ok: false,
            err: "Permission [write] is required for {folder}." } }),
        sourceObservation({ id: "reader-success", event: "tx", data: {
            tid: "reader-success-call", tn: "native_document_fetch", ok: true,
            d: "Retrieved the selected item.", out: "PRIVATE_BODY_NOT_RETAINED" } }, 1),
        sourceObservation({ id: "reader-generic", event: "tx", data: {
            tid: "reader-generic-call", tn: "native_generic_failure", ok: false, err: "failure" } }, 2),
    ], context);
    const { page } = await setup(t, envelopes, 3);
    const failed = page.locator("#requestContent .reader-call").filter({ hasText: "native_document_update" });
    const succeeded = page.locator("#requestContent .reader-call").filter({ hasText: "native_document_fetch" });
    const generic = page.locator("#requestContent .reader-call").filter({ hasText: "native_generic_failure" });
    await failed.locator(".reader-call-toggle").click();
    await succeeded.locator(".reader-call-toggle").click();
    await generic.locator(".reader-call-toggle").click();
    await expect(succeeded.locator(".reader-call-summary")).toContainText("Tool completed");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await expect(failed).toContainText("Recorded error: Permission [write] is required for {folder}.");
        await expect(failed).not.toContainText("Failure reason was not retained.");
        await expect(succeeded).toContainText("Source description: Retrieved the selected item.");
        await expect(succeeded).toContainText("Response bodies are excluded from activity retention.");
        await expect(succeeded).not.toContainText("Recorded error");
        await expect(generic).toContainText("Recorded error: failure");
        await expect(generic).toContainText("The source supplied a generic failure message; no detailed cause was given.");
        await expect(page.locator("#requestContent")).not.toContainText("PRIVATE_BODY_NOT_RETAINED");
    }
});

test("ongoing collection does not replace the conversation being read", async t => {
    const { page, collect, card } = await setup(t);
    const initialRoute = page.url(), reader = page.locator("#requestContent");
    await page.evaluate(() => {
        window.openMessage = document.querySelector("#requestContent .reader-message");
        window.openCopy = openMessage.querySelector(".ux-copy");
    });
    const later = rows();
    later.push(envelope("cowork", { id: "new-collection-message", event: "u", data: {} }, {
        message: recorded({ author: "user", representation: "plain-text", text: "A newly collected message, outside the open snapshot." }),
    }, {}, 30));
    const revision = await collect(later);
    await expect(page.locator("#activityView")).toHaveAttribute("data-revision", String(revision), { timeout: 15000 });
    assert.equal(page.url(), initialRoute);
    await expect(reader).toContainText("Read the invented records.");
    await expect(reader.locator(".reader-call")).toHaveCount(3);
    await expect(reader).not.toContainText("This exact Microsoft record is unavailable");
    await expect(reader).not.toContainText("A newly collected message");
    assert.equal(await page.evaluate(() => openMessage.isConnected), true, "Ordinary collection must not tear down the displayed reader.");
    await page.evaluate(() => openCopy.click());
    assert.deepEqual(await page.evaluate(() => copies), [prompt]);
    await expect(page.locator("#requestReportToggle")).toBeDisabled();
    await expect(page.locator("#requestReportTitle")).toHaveText("Reopen this conversation from current activity to change report selection.");
    await reader.locator("[data-reader-section=source] .reader-section-toggle").click();
    await expect(reader.locator("[data-reader-section=source] [data-native-ordinal]")).toHaveCount(10);
    await reader.getByRole("button", { name: "Next Microsoft page", exact: true }).click();
    await expect(reader.locator("[data-reader-section=source] [data-native-ordinal]")).toHaveCount(4);
    await expect(reader).not.toContainText("A newly collected message");
    const directory = process.env.WIRE_READER_CONTINUITY_SCREENSHOTS;
    if (directory) {
        await mkdir(directory, { recursive: true });
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length
            && !document.querySelector("#main").getAnimations().length);
        await page.locator("#contextSidebarBody").evaluate(node => { node.scrollTop = 0; });
        await page.screenshot({ path: path.join(directory, "original-reader-after-collection.png") });
    }
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await card.locator(".request-card-open").click();
    await expect(reader).toContainText("A newly collected message, outside the open snapshot.");
    await expect(reader).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#requestReportToggle")).toBeEnabled();
    assert.notEqual(page.url(), initialRoute, "Reopening a current card deliberately selects the newly collected root.");
    if (directory) {
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length
            && !document.querySelector("#main").getAnimations().length);
        await page.screenshot({ path: path.join(directory, "current-reader-after-reopen.png") });
    }
});

test("a fresh accepted Search target opens while the surrounding snapshot stays older", async t => {
    const { page, collect, calls } = await setup(t, rows(), 3, { freezeSnapshot: true });
    const previousRevision = await page.locator("#activityView").getAttribute("data-revision");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    const newer = rows();
    newer.push(envelope("cowork", { id: "fresh-search-message", event: "u", data: {} }, {
        message: recorded({ author: "user", representation: "plain-text", text: "A fresh exact Search passage." }),
    }, {}, 30));
    const newRevision = await collect(newer);
    await page.locator("#wireSearch").fill("A fresh exact Search passage.");
    const hit = page.locator("#wireNativeSearch .wire-search-hit");
    await expect(hit).toHaveCount(1);
    await hit.click();
    await expect(page.locator("#requestContent")).toHaveAttribute("aria-busy", "false");
    const target = page.locator("#requestContent [data-reader-section=source] [data-native-ordinal]").first();
    await expect(target).toContainText("A fresh exact Search passage.");
    await expect(target).toBeFocused();
    await expect(page.locator("#activityView")).toHaveAttribute("data-revision", previousRevision);
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("nativeRevision"), String(newRevision));
    const seeks = calls.filter(call => call.method === "detail" && call.input.at !== undefined);
    assert.equal(seeks.length, 1);
    assert.equal(seeks[0].input.revision, newRevision);
    assert.equal(seeks[0].input.page.after, null);
});

for (const kind of ["privacy", "configuration", "deletion"]) test(`open pinned reader retires on current ${kind} change`, async t => {
    const { page, collect, changeAuthority } = await setup(t);
    const revision = await collect(rows());
    await expect(page.locator("#activityView")).toHaveAttribute("data-revision", String(revision), { timeout: 15000 });
    await expect(page.locator("#requestContent .reader-message")).toHaveCount(3);
    await page.evaluate(() => {
        window.privateCopy = document.querySelector("#requestContent .ux-copy");
        window.privateText = document.querySelector("#requestContent .reader-message h3").firstChild;
        window.privateLabel = privateCopy.getAttributeNode("aria-label");
    });
    await changeAuthority(kind);
    await expect(page.locator("#requestContent .reader-message")).toHaveCount(0, { timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => {
        privateCopy.click();
        return { text: privateText.data, label: privateLabel.value, copies: copies.length };
    }), { text: "", label: "", copies: 0 });
});

test("exact source page labels its page count separately from the complete conversation total", async t => {
    const { page, calls } = await setup(t, [...chatFixture(), ...coworkFixture()], 3, { sourceId: "microsoft-365-cowork" });
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await page.locator("#wireSearch").fill("Read the invented records.");
    const hit = page.locator("#wireNativeSearch .wire-search-hit");
    await expect(hit).toHaveCount(1);
    await hit.click();
    const source = page.locator("#requestContent [data-reader-section=source]");
    await expect(source.locator("[data-native-ordinal]")).toHaveCount(10);
    await expect(source.locator("[data-native-ordinal]").first()).toHaveAttribute("data-native-ordinal", "4");
    await expect(source.locator(".pager")).toContainText("10 on this page / 11 in conversation");
    await expect(source.getByRole("button", { name: "Next Microsoft page", exact: true })).toHaveCount(0);
    const seek = calls.filter(call => call.method === "detail" && call.input.at !== undefined);
    assert.equal(seek.length, 1);
    assert.equal(seek[0].input.at, 4);
    const originalRevision = seek[0].input.revision, originalRoot = seek[0].input.sourceRevision;
    const directory = process.env.WIRE_SOURCE_PAGE_PROOFS;
    if (directory) await mkdir(directory, { recursive: true });
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await source.locator(".pager").scrollIntoViewIfNeeded();
        await expect(source.locator(".pager")).toBeVisible();
        assert.equal(await source.locator(".pager").evaluate(node => node.scrollWidth <= node.clientWidth), true);
        if (directory) {
            await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length
                && !document.querySelector("#main").getAnimations().length);
            await page.screenshot({ path: path.join(directory, `source-seek-page-${width}.png`) });
        }
    }
    await source.getByRole("button", { name: "First Microsoft page", exact: true }).click();
    await expect(source.locator("[data-native-ordinal]").first()).toHaveAttribute("data-native-ordinal", "3");
    await expect(source.locator("[data-native-ordinal]")).toHaveCount(10);
    await source.getByRole("button", { name: "Next Microsoft page", exact: true }).click();
    await expect(source.locator("[data-native-ordinal]")).toHaveCount(1);
    await expect(source.locator("[data-native-ordinal]").first()).toHaveAttribute("data-native-ordinal", "13");
    await expect(source.locator(".pager")).toContainText("1 on this page / 11 in conversation");
    await expect(source.getByRole("button", { name: "Next Microsoft page", exact: true })).toHaveCount(0);
    const last = calls.filter(call => call.method === "detail" && call.input.section === "observations").at(-1).input;
    assert.equal(last.revision, originalRevision);
    assert.equal(last.sourceRevision, originalRoot);
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("nativeOrdinal"), "4");
});

test("shared reader preserves authored order and makes coexisting context discoverable", async t => {
    const { page } = await setup(t);
    const messages = page.locator("#requestContent [data-reader-section=prompt] .reader-message");
    await expect(messages).toHaveCount(3);
    await expect(messages.nth(0)).toContainText("Read the invented records.");
    await expect(messages.nth(1)).toContainText("Recorded finding");
    await expect(messages.nth(2)).toContainText("A later follow-up");
    await page.locator('[data-reader-section=context] .reader-section-toggle').click();
    await expect(page.locator('[data-reader-section=context]')).toContainText("Distinct unverified fragment");
    await expect(page.locator('[data-reader-section=context]')).toContainText("completed");
    assert.equal(await page.evaluate(() => window.readerInjection), undefined);
});

for (const width of [1440, 390]) test(`reader copy states limits once without default tutorials at ${width}px`, async t => {
    const { page } = await setup(t);
    await page.setViewportSize({ width, height: 1000 });
    const reader = page.locator("#requestContent");
    await expect(reader.locator("[data-reader-section=prompt] .reader-section-heading")).toHaveText("Messages");
    await expect(reader.locator("[data-reader-section=activity] .reader-section-context")).toHaveText("Call order unverified");
    await expect(reader).not.toContainText("Saved message order; calls are grouped separately");
    const replyCopy = page.getByRole("button", { name: "Copy reply", exact: true });
    await replyCopy.click();
    assert.deepEqual(await page.evaluate(() => copies), [reply]);
    const context = reader.locator("[data-reader-section=context]");
    await context.locator(".reader-section-toggle").click();
    await expect(context.locator(".reader-section-toggle")).toHaveText("Context (2 saved records)");
    await expect(context).not.toContainText("Other saved text and task updates");
    assert.equal((await context.innerText()).match(/author unverified/g)?.length, 1);
    await expect(context).toContainText("Task: completed");
    await expect(context).toContainText("Distinct unverified fragment");
    const source = reader.locator("[data-reader-section=source]");
    await source.locator(".reader-section-toggle").click();
    await expect(source.locator("[data-native-ordinal]").first()).toBeVisible();
    await expect(source).not.toContainText("Representations and updates are not extra calls");
    await source.getByText("Source fields", { exact: true }).first().click();
    await expect(source.getByRole("button", { name: "Copy source fields", exact: true }).first()).toBeVisible();
    await expect(page.locator("#contextSidebarFooter")).toContainText("Reports include the complete saved conversation.");
    await page.locator("#requestReportToggle").click();
    await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
    if (process.env.WIRE_READER_COPY_SCREENSHOTS) {
        await mkdir(process.env.WIRE_READER_COPY_SCREENSHOTS, { recursive: true });
        await source.locator(".reader-section-toggle").click();
        await page.locator("#contextSidebarBody").evaluate(node => { node.scrollTop = 0; });
        await page.screenshot({ path: path.join(process.env.WIRE_READER_COPY_SCREENSHOTS, `reader-copy-${width}.png`) });
    }
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await page.locator("#activityList [data-source-id=github-copilot] .request-card-open").click();
    await expect(reader.locator(".reader-call-row")).toHaveCount(1);
    await reader.locator("[data-reader-section=source] .reader-section-toggle").click();
    await expect(reader).not.toContainText("unsaved parts of the conversation may be missing");
    await expect(reader.locator(".reader-evidence-scope")).toHaveText("Collection coverage");
    await expect(reader.getByRole("link", { name: "Collection coverage", exact: true })).toBeVisible();
});

test("reader copy keeps original Markdown without layout shift and retires detached handles", async t => {
    const { page, withdraw } = await setup(t);
    const copy = page.getByRole("button", { name: "Copy reply", exact: true });
    const message = page.locator("#requestContent .reader-message").filter({ has: copy });
    await expect(message.locator("strong")).toContainText(["worked"]);
    await expect(message.locator("details")).toHaveCount(0);
    const before = await message.boundingBox();
    await copy.click();
    await expect(copy).toHaveAttribute("data-copy-state", "success");
    const after = await message.boundingBox();
    assert.equal(after.height, before.height);
    assert.deepEqual(await page.evaluate(() => window.copies), [reply]);
    await page.evaluate(() => {
        const message = [...document.querySelectorAll(".reader-message")].find(node => node.textContent.includes("Recorded finding"));
        window.heldMessage = message;
        window.heldText = message.querySelector("strong").firstChild;
        window.heldCopy = message.querySelector(".ux-copy");
        window.heldLabel = window.heldCopy.getAttributeNode("aria-label");
    });
    withdraw();
    await expect(page.locator("#requestContent .reader-message")).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => {
        heldCopy.click();
        return { text: heldText.data, message: heldMessage.textContent, label: heldLabel.value, copies: copies.length };
    }), { text: "", message: "", label: "", copies: 1 });
});

test("call input and raw source collapse scrub text and Copy while exact Open seeks once", async t => {
    const { page, calls } = await setup(t);
    const call = page.locator("#requestContent .reader-call").filter({ hasText: "mcp__graph__CallGraph" });
    await call.locator(".reader-call-toggle").click();
    await expect(call).toContainText("Provider tool duration: 12 ms.");
    await expect(call).toContainText("2 requested; no individual results recorded.");
    assert.match(await call.locator("pre").evaluate(node => getComputedStyle(node).fontFamily), /Mono|Consolas|monospace/i);
    const inputCopy = call.getByRole("button", { name: "Copy input", exact: true });
    await inputCopy.click();
    await expect(inputCopy).toHaveAttribute("data-copy-state", "success");
    await page.evaluate(() => {
        const call = [...document.querySelectorAll(".reader-call")].find(node => node.textContent.includes("mcp__graph__CallGraph"));
        window.heldInput = call.querySelector("pre").firstChild;
        window.inputCopy = call.querySelector(".ux-copy");
    });
    await call.locator(".reader-call-toggle").click();
    assert.equal(await page.evaluate(() => heldInput.data), "");
    await page.evaluate(() => inputCopy.click());
    assert.equal(await page.evaluate(() => copies.length), 1);
    await call.locator(".reader-call-toggle").click();
    await call.getByRole("button", { name: "Open source record", exact: true }).first().click();
    const source = page.locator("#requestContent [data-reader-section=source]");
    await expect(source.locator("[data-native-ordinal]").first()).toBeVisible();
    const seeks = calls.filter(call => call.method === "detail" && call.input.at !== undefined);
    assert.equal(seeks.length, 1);
    await expect(source.locator("[data-native-ordinal]").first()).toHaveAttribute("data-native-ordinal", String(seeks[0].input.at));
    await source.getByText("Source fields", { exact: true }).first().click();
    await expect(source.locator(".ux-copy").first()).toBeVisible();
    await page.evaluate(() => {
        window.rawCopy = document.querySelector("[data-reader-section=source] .ux-copy");
        window.rawText = document.querySelector("[data-reader-section=source] pre").firstChild;
    });
    await source.locator(".reader-section-toggle").click();
    assert.equal(await page.evaluate(() => rawText.data), "");
    await page.evaluate(() => rawCopy.click());
    assert.equal(await page.evaluate(() => copies.length), 1);
});

test("message paging remains bounded, ordered and reversible", async t => {
    const values = rows();
    for (let i = 0; i < 13; i++) values.push(envelope("cowork", { id: "page:" + i, event: i % 2 ? "u" : "a", data: {} }, {
        message: recorded({ author: i % 2 ? "user" : "assistant", representation: "plain-text", text: "Paged message " + i }),
    }, {}, i + 30));
    const { page, calls, card } = await setup(t, values);
    const section = page.locator("#requestContent [data-reader-section=prompt]"), messages = section.locator(".reader-message");
    await expect(messages).toHaveCount(10);
    const first = await messages.first().getAttribute("data-native-ordinal");
    await section.getByRole("button", { name: "Next", exact: true }).click();
    await expect(messages).toHaveCount(6);
    await expect(messages.last()).toContainText("Paged message 12");
    await expect(section.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
    const acceptedCursor = calls.filter(call => call.method === "detail" && call.input.section === "messages").at(-1).input.page.after;
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await card.locator(".request-card-open").click();
    await expect(messages).toHaveCount(6);
    assert.equal(calls.filter(call => call.method === "detail" && call.input.section === "messages").at(-1).input.page.after, acceptedCursor);
    await section.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(messages).toHaveCount(10);
    await expect(messages.first()).toHaveAttribute("data-native-ordinal", first);
    assert.equal(calls.filter(call => call.method === "detail" && call.input.section === "messages").length, 4);
});

test("changed source roots clear section content rather than substituting another page", async t => {
    const { page, stale } = await setup(t);
    stale();
    const source = page.locator("#requestContent [data-reader-section=source]");
    await source.locator(".reader-section-toggle").click();
    await expect(source).toContainText("could not be verified");
    await expect(source.locator("[data-native-ordinal],pre,.ux-copy")).toHaveCount(0);
});

test("native Search opens the original source-qualified passage with one exact observation seek", async t => {
    const { page, calls } = await setup(t);
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await page.locator("#wireSearch").fill("Distinct unverified");
    const hit = page.locator("#wireNativeSearch .wire-search-hit");
    await expect(hit).toHaveCount(1);
    await hit.click();
    const source = page.locator("#requestContent [data-reader-section=source]");
    await expect(source.locator("[data-native-ordinal]").first()).toContainText("Distinct unverified fragment");
    const seeks = calls.filter(call => call.method === "detail" && call.input.at !== undefined);
    assert.equal(seeks.length, 1);
    assert.deepEqual(seeks[0].input.sources, ["microsoft-365-cowork"]);
    assert.equal(seeks[0].input.page.after, null);
    assert.match(seeks[0].input.sourceRevision, /^[a-f0-9]{64}$/);
    await expect(source.locator("[data-native-ordinal]").first()).toHaveAttribute("data-native-ordinal", String(seeks[0].input.at));
    await expect(source.locator("[data-native-ordinal]").first()).toBeFocused();
});

for (const zero of [false, true]) test(`exact Search overrides remembered Source collapse${zero ? " at ordinal zero" : ""}`, async t => {
    const values = rows();
    if (zero) values.unshift(values.splice(1, 1)[0]);
    const { page, calls, card } = await setup(t, values);
    const source = page.locator("#requestContent [data-reader-section=source]");
    await source.locator(".reader-section-toggle").click();
    await expect(source.locator("[data-native-ordinal]").first()).toBeVisible();
    await source.locator(".reader-section-toggle").click();
    await expect(source.locator(".reader-section-toggle")).toHaveAttribute("aria-expanded", "false");
    const ordinaryReads = calls.filter(call => call.method === "detail" && call.input.section === "observations").length;
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await card.locator(".request-card-open").click();
    await expect(page.locator("#requestContent")).toHaveAttribute("aria-busy", "false");
    await expect(source.locator(".reader-section-toggle")).toHaveAttribute("aria-expanded", "false");
    assert.equal(calls.filter(call => call.method === "detail" && call.input.section === "observations").length, ordinaryReads);
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await page.locator("#wireSearch").fill(zero ? "Keep the original order." : "Distinct unverified");
    const hit = page.locator("#wireNativeSearch .wire-search-hit");
    await expect(hit).toHaveCount(1);
    await hit.click();
    await expect(source.locator(".reader-section-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(source.locator("[data-native-ordinal]").first()).toContainText(zero ? "Keep the original order." : "Distinct unverified fragment");
    await expect(page.locator("#requestContent")).toHaveAttribute("aria-busy", "false");
    const seeks = calls.filter(call => call.method === "detail" && call.input.at !== undefined);
    assert.equal(seeks.length, 1);
    if (zero) assert.equal(seeks[0].input.at, 0);
    assert.equal(seeks[0].input.page.after, null);
    await expect(source.locator("[data-native-ordinal]").first()).toHaveAttribute("data-native-ordinal", String(seeks[0].input.at));
    await expect(source.locator("[data-native-ordinal]").first()).toBeFocused();
    const targetOrdinal = seeks[0].input.at;
    const graph = page.locator(".reader-call").filter({ hasText: "mcp__graph__CallGraph" });
    await graph.locator(".reader-call-toggle").click();
    await graph.getByRole("button", { name: "Open source record", exact: true }).first().click();
    await expect(source.locator("[data-native-ordinal]").first()).not.toHaveAttribute("data-native-ordinal", String(targetOrdinal));
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await page.locator("#wireSearch").fill(zero ? "Keep the original order." : "Distinct unverified");
    await expect(hit).toHaveCount(1);
    await hit.click();
    await expect(source.locator("[data-native-ordinal]").first()).toHaveAttribute("data-native-ordinal", String(targetOrdinal));
    await expect(page.locator("#requestContent")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(source.locator("[data-native-ordinal]").first()).toBeFocused();
    const reveal = await source.locator("[data-native-ordinal]").first().evaluate(node => {
        const target = node.getBoundingClientRect(), viewport = document.getElementById("contextSidebarBody").getBoundingClientRect();
        return { top: target.top, bottom: target.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom };
    });
    assert.ok(reveal.top >= reveal.viewportTop - 1 && reveal.bottom <= reveal.viewportBottom + 1,
        "The exact passage must remain in the reading viewport, not under the fixed footer after remembered scroll restoration.");
    const reopenedSeeks = calls.filter(call => call.method === "detail" && call.input.at !== undefined);
    assert.equal(reopenedSeeks.length, 3);
    assert.equal(reopenedSeeks.at(-1).input.at, targetOrdinal);
    assert.equal(reopenedSeeks.at(-1).input.page.after, null);
    if (process.env.WIRE_READER_CORRECTION_SCREENSHOTS) {
        await mkdir(process.env.WIRE_READER_CORRECTION_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_READER_CORRECTION_SCREENSHOTS,
            zero ? "exact-search-ordinal-zero.png" : "exact-search-later-ordinal.png") });
    }
});

test("close and reopen restore the native reader position, disclosure and card focus", async t => {
    const { page, card } = await setup(t);
    await expect(card).toHaveAttribute("data-detail-active", "");
    const call = page.locator(".reader-call").filter({ hasText: "mcp__graph__CallGraph" });
    await call.locator(".reader-call-toggle").click();
    const top = await page.locator("#contextSidebarBody").evaluate(node => { node.scrollTop = 350; return node.scrollTop; });
    assert.ok(top > 100);
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await expect(card.locator(".request-card-open")).toBeFocused();
    await expect(card).not.toHaveAttribute("data-detail-active", "");
    await card.locator(".request-card-open").press("Enter");
    await expect(page.locator(".reader-call")).toHaveCount(3);
    await expect(call.locator(".reader-call-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => page.locator("#contextSidebarBody").evaluate(node => node.scrollTop)).toBe(top);
    await page.goBack();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await page.goForward();
    await expect(page.locator(".reader-call")).toHaveCount(3);
    await expect.poll(() => page.locator("#contextSidebarBody").evaluate(node => node.scrollTop)).toBe(top);
    await page.keyboard.press("Escape");
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await expect(card.locator(".request-card-open")).toBeFocused();
});

test("qualified card dates distinguish selected starts from undated completions", async t => {
    const { card } = await setup(t, qualifyStarts(rows()));
    await expect(card).toContainText("Call started:");
    await expect(card).toContainText("1 undated");
    await expect(card).not.toContainText("Activity date unavailable");
    await expect(card).not.toContainText("Captured");
});

test("loading and failed sections remain explicit, and a late reply cannot repopulate a closed reader", async t => {
    const { page, card, releaseContext } = await setup(t, rows(), 0, { delayContext: true, failCallsOnce: true });
    const activity = page.locator("[data-reader-section=activity]");
    await expect(activity).toContainText("Deliberate fixture read failure.");
    await activity.getByRole("button", { name: "Read first page again", exact: true }).click();
    await expect(page.locator(".reader-call")).toHaveCount(3);
    const context = page.locator("[data-reader-section=context]");
    await context.locator(".reader-section-toggle").click();
    await expect(context).toContainText("Reading saved activity...");
    await expect(page.locator("#requestContent")).toHaveAttribute("aria-busy", "true");
    await page.locator("#closeContextSidebar").click();
    releaseContext();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await expect(page.locator("#requestContent .reader-message")).toHaveCount(0);
    await card.locator(".request-card-open").click();
    await expect(context).toContainText("Distinct unverified fragment");
    await expect(page.locator("#requestContent")).toHaveAttribute("aria-busy", "false");
});

test("failed reader sections keep concise shared copy and independent recovery", async t => {
    const { page, card, stale, calls } = await setup(t);
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await chooseTheme(page, "dark");
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    stale();
    await card.locator(".request-card-open").click();
    const root = page.locator("#requestContent");
    await expect(root).toHaveAttribute("aria-busy", "false");
    await root.locator("[data-reader-section=source] .reader-section-toggle").click();
    for (const section of ["prompt", "activity", "source"]) {
        const host = root.locator(`[data-reader-section=${section}]`);
        await expect(host.locator(".reader-section-content > .reader-state")).toHaveText("Saved Microsoft activity could not be verified.");
        await expect(host.getByRole("button", { name: "Read first page again", exact: true })).toBeEnabled();
    }
    await expect(root).not.toContainText("bounded Microsoft view");
    await expect(root).not.toContainText("no history was collected");
    const prior = calls.filter(call => call.method === "detail" && call.input.section === "calls").length;
    await root.locator("[data-reader-section=activity]").getByRole("button", { name: "Read first page again", exact: true }).click();
    await expect.poll(() => calls.filter(call => call.method === "detail" && call.input.section === "calls").length).toBe(prior + 1);
    await expect(root.locator("[data-reader-section=activity] .reader-state")).toHaveText("Saved Microsoft activity could not be verified.");
    if (process.env.WIRE_READER_ERROR_COPY_PROOFS) {
        await mkdir(process.env.WIRE_READER_ERROR_COPY_PROOFS, { recursive: true });
        await root.locator("[data-reader-section=source]").scrollIntoViewIfNeeded();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
        await page.screenshot({ path: path.join(process.env.WIRE_READER_ERROR_COPY_PROOFS, "error-dark-390-200.png") });
    }
});

test("native reader keeps report action and keyboard controls reachable at enlarged text", async t => {
    const { page } = await setup(t);
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await expect(page.locator("#closeContextSidebar")).toBeVisible();
    await expect(page.locator("#requestReportToggle")).toBeVisible();
    await page.locator("#requestReportToggle").click();
    await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
    await expect(page.locator("#requestReportContinue")).toBeEnabled();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator("#contextSidebarFooter").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.locator("#requestReportToggle").click();
    await expect(page.locator("#requestReportToggle")).toHaveText("Add to report");
});

test("the native card uses the established non-reduced-motion reader glide", async t => {
    const { page, card } = await setup(t);
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await card.locator(".request-card-open").click();
    const frames = await page.evaluate(async () => {
        const frames = [], sidebar = document.getElementById("contextSidebar");
        for (let i = 0; i < 35; i++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const box = sidebar.getBoundingClientRect();
            frames.push({ left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) });
        }
        return frames;
    });
    assert.ok(new Set(frames.map(frame => frame.left)).size > 1, "The existing reader entrance must glide, not jump.");
    assert.ok(frames.at(-1).left >= 0 && frames.at(-1).right <= 1441);
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await expect(card.locator(".request-card-open")).toBeFocused();
});

test("long retained Markdown and code remain complete and locally wrapped", async t => {
    const values = rows(), original = "## Full reply\n\n" + "A retained paragraph with **meaningful emphasis**.\n\n".repeat(30)
        + "```\n" + "long_unbroken_value_".repeat(100) + "\n```\n\nLAST_RETAINED_CHARACTER";
    values.find(row => row.qualifiedFields.message?.value.text === reply).qualifiedFields.message.value.text = original;
    const { page } = await setup(t, values);
    await page.setViewportSize({ width: 390, height: 1000 });
    const message = page.locator(".reader-message").filter({ hasText: "LAST_RETAINED_CHARACTER" });
    await expect(message).toContainText("LAST_RETAINED_CHARACTER");
    assert.equal(await page.locator("#requestContent").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await message.getByRole("button", { name: "Copy reply", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => copies), [original]);
});

test("reader remains usable in both themes and narrow layouts", async t => {
    const values = qualifyStarts(rows());
    values.find(row => row.qualifiedFields.message?.value.text === reply).qualifiedFields.message.value.text = reply.split("\n\n<script>")[0];
    const { page, card } = await setup(t, values);
    const directory = process.env.WIRE_READER_SCREENSHOTS;
    if (directory) await mkdir(directory, { recursive: true });
    for (const theme of ["light", "dark"]) {
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).not.toBeVisible();
        await page.setViewportSize({ width: 1440, height: 1000 });
        await chooseTheme(page, theme);
        await card.locator(".request-card-open").click();
        for (const width of [1440, 768, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            await expect.poll(() => page.locator("#contextSidebar").evaluate(node => {
                const box = node.getBoundingClientRect();
                return box.left >= 0 && box.right <= innerWidth + 1;
            })).toBe(true);
            await page.locator("#contextSidebarBody").evaluate(node => { node.scrollTop = 0; });
            await expect(page.getByRole("button", { name: "Copy prompt", exact: true }).first()).toBeVisible();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.equal(await page.locator("#requestContent").evaluate(node => node.scrollWidth <= node.clientWidth), true);
            await expect(page.locator("#contextSidebarFooter")).toBeVisible();
            if (directory) await page.screenshot({ path: path.join(directory, `reader-${theme}-${width}.png`) });
            const call = page.locator(".reader-call").filter({ hasText: "mcp__graph__CallGraph" });
            const context = page.locator("[data-reader-section=context]");
            await call.locator(".reader-call-toggle").click();
            await context.locator(".reader-section-toggle").click();
            await call.scrollIntoViewIfNeeded();
            await expect(context).toContainText("Distinct unverified fragment");
            if (directory) await page.screenshot({ path: path.join(directory, `reader-details-${theme}-${width}.png`) });
            await call.locator(".reader-call-toggle").click();
            await context.locator(".reader-section-toggle").click();
        }
    }
    if (process.env.WIRE_READER_INSPECT && directory) {
        const result = await promisify(execFile)(process.execPath, [process.env.WIRE_READER_INSPECT, page.url(), "--app",
            "--out", path.join(directory, "inspector"), "--allow", "button-fx,edge-text,gradient,no-title"], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
        t.diagnostic(result.stdout);
    }
});

test("no-call cards state absence once without a duplicate zero footer", async t => {
    const { page, card } = await setup(t, chatFixture(), 0);
    await expect(page.locator("[data-reader-section=activity]")).toContainText("No tool calls were recorded.");
    await expect(card.locator(".request-card-problem")).toHaveText("No recorded calls in this selection.");
    await expect(card.locator(".request-card-count")).toHaveCount(0);
    await expect(card).not.toContainText("0 tool calls");
});

test("Chat shares the card and reader without borrowing call inputs or inventing outcomes", async t => {
    const { page, card } = await setup(t, [...chatFixture(), multiCallChatFixture()], 2);
    await expect(card).toContainText("An invented question.");
    await expect(card).toContainText("2 unverified");
    await expect(card.locator(".request-card-count")).toHaveText("2 tool calls");
    const messages = page.locator("#requestContent [data-reader-section=prompt] .reader-message");
    await expect(messages).toHaveCount(4);
    const image = page.locator(".reader-call").filter({ hasText: "image_gen" });
    const lookup = page.locator(".reader-call").filter({ hasText: "invented_native_lookup" });
    await image.locator(".reader-call-toggle").click();
    await lookup.locator(".reader-call-toggle").click();
    await expect(image).toContainText("First invented input.");
    await expect(image).not.toContainText("Second invented input.");
    await expect(lookup).toContainText("Second invented input.");
    await expect(lookup).not.toContainText("First invented input.");
    await expect(page.locator(".reader-call-summary")).toContainText(["result unverified", "result unverified"]);
    await page.locator("#closeContextSidebar").click();
    await page.locator("#activityList [data-source-id=github-copilot] .request-card-open").click();
    await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(1);
    await expect(page.locator("#requestContent")).not.toContainText("invented_native_lookup");
});

test("context-only conversations reveal retained text without inventing authored messages", async t => {
    const values = rows().filter(row => row.messageParts || row.outcomes.task);
    const { page } = await setup(t, values, 0);
    await expect(page.locator("[data-reader-section=prompt]")).toContainText("No verified prompt or reply text");
    const context = page.locator("[data-reader-section=context]");
    await expect(context.locator(".reader-section-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(context).toContainText("Distinct unverified fragment");
    await expect(context).toContainText("Task: completed");
    await expect(page.locator("[data-reader-section=activity]")).toContainText("No tool calls were recorded.");
    await expect(page.getByRole("button", { name: "Copy text fragment", exact: true })).toBeVisible();
});

test("multipart context states authorship once and keeps each original Copy subject", async t => {
    const values = rows(), contextRow = values.find(row => row.messageParts);
    const second = structuredClone(contextRow.messageParts[0]);
    second.message.value.text = "A second distinct fragment.";
    second.evidence.pointer = "/data/content/1";
    contextRow.messageParts.push(second);
    const { page } = await setup(t, values);
    const context = page.locator("[data-reader-section=context]");
    await context.locator(".reader-section-toggle").click();
    assert.equal((await context.innerText()).match(/author unverified/g)?.length, 1);
    await context.getByRole("button", { name: "Copy text fragment 1", exact: true }).click();
    await context.getByRole("button", { name: "Copy text fragment 2", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => copies), [
        "Distinct unverified fragment alongside authored messages.", "A second distinct fragment.",
    ]);
    await context.locator(".reader-section-toggle").click();
    await expect(context.locator(".reader-message")).toHaveCount(0);
});

test("reader source prose shares flat message geometry without doubling section gaps", async t => {
    const { page } = await setup(t);
    const last = page.locator("[data-reader-section=prompt] .reader-message").last();
    assert.equal(await last.evaluate(node => getComputedStyle(node).marginBottom), "0px");
    const source = page.locator("[data-reader-section=source]");
    await source.locator(".reader-section-toggle").click();
    const record = source.locator(".reader-source-record").filter({ hasText: "Keep the original order." }).first();
    await expect(record.locator(".report-document")).toBeVisible();
    const geometry = await record.evaluate(node => {
        const heading = node.querySelector(":scope > h3"), text = node.querySelector(".report-document"), style = getComputedStyle(text);
        return { padding: style.padding, border: style.borderTopWidth, background: style.backgroundColor,
            gap: text.getBoundingClientRect().top - heading.getBoundingClientRect().bottom };
    });
    assert.deepEqual(geometry, { padding: "0px", border: "0px", background: "rgba(0, 0, 0, 0)", gap: 8 });
    const copy = page.getByRole("button", { name: "Copy prompt", exact: true }).first();
    const control = await copy.evaluate(node => {
        const r = node.getBoundingClientRect(), icon = node.querySelector("svg").getBoundingClientRect();
        return { width: r.width, height: r.height, icon: icon.width,
            x: (r.left + r.right - icon.left - icon.right) / 2, y: (r.top + r.bottom - icon.top - icon.bottom) / 2 };
    });
    assert.deepEqual(control, { width: 44, height: 44, icon: 20, x: 0, y: 0 });
});

test("immediate reader empty and error states use regular body text without a panel", async t => {
    const { page } = await setup(t, rows(), 0, { failCallsOnce: true });
    const error = page.locator("[data-reader-section=activity] .reader-section-content > .reader-state");
    await expect(error).toContainText("Deliberate fixture read failure.");
    assert.deepEqual(await error.evaluate(node => {
        const s = getComputedStyle(node);
        return { size: s.fontSize, weight: s.fontWeight, padding: s.padding, background: s.backgroundColor };
    }), { size: "14px", weight: "400", padding: "0px", background: "rgba(0, 0, 0, 0)" });
});

test("reader visual state matrix uses the shared shell", { skip: !process.env.WIRE_READER_GEOMETRY_PROOFS }, async t => {
    const directory = process.env.WIRE_READER_GEOMETRY_PROOFS, measurements = [];
    await mkdir(directory, { recursive: true });
    async function capture(page, name, focus) {
        if (focus) await focus.scrollIntoViewIfNeeded();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length
            && !document.querySelector("#main").getAnimations().length);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const measured = await page.locator("#requestContent").evaluate(root => {
            const box = node => {
                const r = node.getBoundingClientRect(), s = getComputedStyle(node);
                return { tag: node.tagName, classes: node.className, text: node.textContent.slice(0, 90),
                    x: r.x, y: r.y, width: r.width, height: r.height, padding: s.padding, margin: s.margin,
                    radius: s.borderRadius, font: s.fontFamily, size: s.fontSize, weight: s.fontWeight };
            };
            return { overflow: root.scrollWidth > root.clientWidth, viewportWidth: innerWidth,
                elements: [...root.querySelectorAll(".reader-section-heading,.reader-message-header,.reader-state,.notice,.empty-state,.reader-source-record>.report-document,.reader-call-toggle,.ux-copy")]
                    .filter(node => node.checkVisibility()).map(box),
                close: box(document.getElementById("closeContextSidebar")),
                footer: box(document.getElementById("contextSidebarFooter")) };
        });
        measurements.push({ name, ...measured });
        assert.equal(measured.overflow, false);
        assert.ok(measured.close.x >= 0 && measured.close.x + measured.close.width <= measured.viewportWidth + 1);
        await page.screenshot({ path: path.join(directory, name + ".png") });
    }
    for (const state of ["populated", "empty", "error"]) {
        await t.test(state, async t => {
            const values = state === "empty" ? coworkFixture().slice(0, 1) : rows();
            const answer = values.find(row => row.qualifiedFields.message?.value.text === reply);
            if (answer) answer.qualifiedFields.message.value.text = reply.split("\n\n<script>")[0];
            const { page, card, collect, stale } = await setup(t, values, state === "empty" || state === "error" ? 0 : 3,
                { failCallsOnce: state === "error" });
            for (const theme of ["light", "dark"]) {
                await page.locator("#closeContextSidebar").click();
                await expect(page.locator("#contextSidebar")).not.toBeVisible();
                await page.setViewportSize({ width: 1440, height: 1000 });
                await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
                await chooseTheme(page, theme);
                await card.locator(".request-card-open").click();
                await expect(page.locator("#requestContent")).toHaveAttribute("aria-busy", "false");
                if (state === "error") {
                    stale();
                    const toggle = page.locator("[data-reader-section=source] .reader-section-toggle");
                    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
                    await expect(page.locator("[data-reader-section=source]")).toContainText("could not be verified");
                }
                for (const [width, scale] of [[1440, 100], [390, 100], [390, 200]]) {
                    await page.setViewportSize({ width, height: 1000 });
                    await page.evaluate(scale => { document.documentElement.style.fontSize = scale === 100 ? "" : scale + "%"; }, scale);
                    const prefix = `${state}-${theme}-${width}-${scale}`;
                    await page.locator("#contextSidebarBody").evaluate(node => { node.scrollTop = 0; });
                    await capture(page, prefix + "-normal");
                    if (state === "populated") {
                        const call = page.locator(".reader-call").filter({ hasText: "mcp__graph__CallGraph" });
                        if (await call.locator(".reader-call-toggle").getAttribute("aria-expanded") !== "true") await call.locator(".reader-call-toggle").click();
                        await capture(page, prefix + "-expanded", call);
                        const source = page.locator("[data-reader-section=source]");
                        if (await source.locator(".reader-section-toggle").getAttribute("aria-expanded") !== "true") await source.locator(".reader-section-toggle").click();
                        await expect(source.locator(".reader-source-record")).not.toHaveCount(0);
                        await capture(page, prefix + "-source", source.locator(".reader-source-record").nth(1));
                        await source.locator(".reader-section-toggle").click();
                        await call.locator(".reader-call-toggle").click();
                    } else if (state === "error") {
                        await capture(page, prefix + "-source-error", page.locator("[data-reader-section=source]"));
                    }
                }
            }
            if (state === "populated") {
                await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
                await page.setViewportSize({ width: 390, height: 1000 });
                const revision = await collect(values);
                await expect(page.locator("#activityView")).toHaveAttribute("data-revision", String(revision), { timeout: 15000 });
                await expect(page.locator("#requestReportTitle")).toBeVisible();
                await capture(page, "populated-dark-390-stale-footer");
            }
        });
    }
    await writeFile(path.join(directory, "measurements.json"), JSON.stringify(measurements, null, 2));
});
