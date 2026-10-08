import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, revealStoredRefresh } from "./helpers.mjs";

const proof = process.env.WIRE_HEADER_PROOFS;
const ready = async page => {
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
};
async function setup(t) {
    const records = [
        ["11111111-1111-4111-8111-111111111111", "Planning review", null],
        ["22222222-2222-4222-8222-222211111111", "Same chat name", "Design"],
        ["33333333-3333-4333-8333-333311111111", "Same chat name", null],
        ["44444444-4444-4444-8444-444444444444", null, null],
        ["55555555-5555-4555-8555-555555555555", "A long recorded chat " + "unbrokentitle".repeat(12) + " \u65e5\u672c\u8a9e", null],
    ].map(([id, name, project], index) => {
        const row = fixture(`header-${index}`);
        Object.assign(row, { sourceSessionId: id, sourceSessionName: name, project, projectId: project ? "project-design" : null });
        row.userPrompt.sourceEventId = `header-message-${index}`;
        row.toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
        return row;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push({ method: request.method(), url: request.url() }));
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No clipboard reads in source-header proof."); },
        writeText() { throw Error("No clipboard writes in source-header proof."); },
    } }));
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            assert.deepEqual(errors, []);
            assert.ok(requests.every(request => new URL(request.url).origin === new URL(runtime.url).origin));
            const unexpected = requests.filter(request => request.method !== "GET" &&
                !["/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
                    "/api/evaluation/automatic/summary"].includes(new URL(request.url).pathname));
            assert.deepEqual(unexpected, [], "No collection/source/provider/report/consent/clipboard actions");
            const after = await loadBoardState(context);
            assert.deepEqual(after.exports, before.exports);
            assert.equal(after.pseudonymKey, before.pseudonymKey);
        } finally { for (const action of cleanup) await action(); }
    });
    return { page, runtime, context, records };
}
async function shot(page, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(proof, `${name}.png`) });
}

test("chat name leads the compact header and exact identity is keyboard-accessible on demand", { timeout: 60000 }, async t => {
    const { page, runtime, records } = await setup(t);
    const id = records[0].sourceSessionId;
    await page.goto(`${runtime.url}#activity?session=${id}`); await ready(page);
    await shot(page, "before-or-after-header");
    assert.equal(await page.locator("#pageTitle").textContent(), "Planning review");
    assert.equal(await page.locator("#pageIdentity").isVisible(), false, "No redundant name field label");
    assert.equal(await page.locator("#pageIntro").isVisible(), false, "No repeated generic description");
    assert.equal((await page.locator(".page-heading").innerText()).includes("without a project"), false, "An absent project is not primary context");
    assert.equal((await page.locator(".page-heading").innerText()).includes(id), false, "Full UUID is not default heading content");
    const details = page.locator("#pageProject .source-header-details");
    assert.equal(await details.getAttribute("open"), null);
    await details.locator("summary").focus(); await page.keyboard.press("Enter");
    assert.match(await details.innerText(), new RegExp(id));
    assert.match(await details.innerText(), /copilot-app/);
    assert.match(await details.innerText(), /Project[\s\S]*Not recorded/);
    assert.equal(await details.locator("summary").evaluate(node => getComputedStyle(node).outlineStyle), "solid");
    await details.locator("summary").press("Space");
    assert.equal(await details.getAttribute("open"), null);
    const titleLink = page.locator("#breadcrumbs").getByRole("link", { name: "GitHub Copilot chat: Planning review", exact: true });
    assert.equal(await titleLink.innerText(), "GitHub Copilot chat", "Breadcrumb does not repeat the large title");
    await titleLink.press("Enter"); await ready(page);
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("session"), id);
    const original = page.url(), popupPromise = page.context().waitForEvent("page");
    await titleLink.click({ modifiers: ["Control"] });
    const popup = await popupPromise;
    try {
        await popup.waitForLoadState(); await ready(popup);
        assert.equal(new URL(popup.url()).hash, new URL(original).hash);
        assert.equal(page.url(), original);
    } finally { await popup.close(); }
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await shot(page, `header-${theme}-${width}-${scale}`);
        assert.equal(await page.locator("#pageTitle").evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    }
    await page.goto(runtime.url + "#request?request=header-0"); await ready(page);
    assert.equal(await page.locator(".request-original").count(), 1);
    const provenance = page.locator(".request-support details").filter({ has: page.locator('summary', { hasText: /^Technical source record$/ }) });
    await provenance.locator("summary").click();
    assert.ok((await provenance.innerText()).includes(id), "Request details keep the same exact source identity on demand");
    await page.locator("#breadcrumbs").getByRole("link", { name: "GitHub Copilot chat: Planning review", exact: true }).click();
    await ready(page);
    assert.equal(await page.locator("#pageTitle").textContent(), "Planning review");
});

test("project, duplicate, long, unnamed and renamed chats keep exact native source identity", { timeout: 60000 }, async t => {
    const { page, runtime, records, context } = await setup(t);
    await page.goto(runtime.url + "#activity"); await ready(page);
    const duplicateReferences = [];
    for (const index of [1, 2, 3, 4]) {
        const record = records[index], group = page.locator(`[data-session-id="${record.sourceSessionId}"]`);
        const title = record.sourceSessionName ?? "Copilot chat name not recorded";
        assert.equal(await group.locator(".session-name").textContent(), title);
        const listReference = await group.locator(".source-reference").allTextContents();
        if ([1, 2, 3].includes(index)) assert.equal(listReference.length, 1, "Ambiguous/unnamed sources have a compact differentiator");
        if ([1, 2].includes(index)) {
            duplicateReferences.push(listReference[0]);
            assert.equal(await group.locator(".session-drill").getAttribute("aria-describedby"), await group.locator(".source-reference").getAttribute("id"));
        }
        await group.locator(".session-drill").click(); await ready(page);
        assert.equal(await page.locator("#pageTitle").textContent(), title);
        if (record.project) assert.match(await page.locator("#pageProject").innerText(), /Design/);
        if (listReference.length) assert.equal(await page.locator("#pageProject .source-reference").textContent(), listReference[0]);
        const details = page.locator("#pageProject .source-header-details");
        await details.locator("summary").click();
        assert.ok((await details.innerText()).includes(record.sourceSessionId));
        for (const theme of ["light", "dark"]) {
            await page.setViewportSize({ width: 375, height: 1000 });
            await page.evaluate(() => document.documentElement.style.fontSize = "200%");
            await chooseTheme(page, theme);
            if (await details.evaluate(node => node.open)) await details.locator("summary").click();
            await shot(page, `${index === 3 ? "unnamed" : index === 4 ? "long" : "duplicate"}-${index}-${theme}`);
            await details.locator("summary").click();
            await details.locator("summary").scrollIntoViewIfNeeded();
            if (proof) await page.screenshot({ path: path.join(proof, `source-facts-${index}-${theme}.png`) });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        }
        assert.notEqual(duplicateReferences[0], duplicateReferences[1], "Colliding eight-character ID suffixes are lengthened, never merged");
        await page.setViewportSize({ width: 1200, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await page.locator("#contextBack").click(); await ready(page);
    }
    const renamed = records[0];
    await page.goto(`${runtime.url}#activity?session=${renamed.sourceSessionId}`); await ready(page);
    await page.locator(".source-header-details > summary").click();
    renamed.sourceSessionName = "Renamed planning review";
    await replaceEvidence(context, () => ({ records, importCoverage: { counts: {}, roster: [] } }));
    await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.equal(await page.locator("#pageTitle").textContent(), renamed.sourceSessionName);
    assert.notEqual(await page.locator(".source-header-details").getAttribute("open"), null, "Source disclosure preference survives a title change");
    assert.ok((await page.locator(".source-header-details").innerText()).includes(renamed.sourceSessionId));
});
