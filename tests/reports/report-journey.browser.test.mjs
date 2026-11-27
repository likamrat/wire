import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../../lib/store.mjs";
import { privateFixture, fixture, chooseTheme, selectActivityOption } from "../support/helpers.mjs";
import { clickReportOption } from "./report-journey-helpers.mjs";

const text = label => ({ name: label, exact: true });
const collected = (id, prompt) => {
    const r = fixture(id);
    r.toolCalls[0].startedAt = r.capturedAt;
    if (prompt) r.userPrompt.text = prompt;
    return r;
};
const button = (page, label) => page.getByRole("button", text(label));
const phase = (page, state) => expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", state);
const previewBytes = file => typeof file === "string" ? Buffer.from(file) : Buffer.from(file.data, "base64");

async function setup(t, records, pdf) {
    const cleanup = [], releases = [], errors = [], requests = [];
    let runtime, browser;
    t.after(async () => {
        for (const release of releases) release();
        try { await browser?.close(); }
        finally { try { await runtime?.close(); } finally { for (const remove of cleanup) await remove(); } }
        assert.deepEqual(errors, []);
    });
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    runtime = await startServer(context, createExportController(context, undefined, pdf), { port: 0, collector: { timers: false } });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 960 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    await page.clock.setFixedTime(new Date("2026-10-01T12:00:00Z"));
    page.setDefaultTimeout(6000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", req => { if (req.method() === "POST") requests.push({ path: new URL(req.url()).pathname, body: req.postDataJSON() }); });
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(runtime.url).origin && !["blob:", "data:"].includes(url.protocol)) {
            errors.push("Unexpected external request"); return route.abort();
        }
        return route.continue();
    });
    const reports = async () => {
        await page.goto(new URL("/reports", runtime.url).href);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy","false");
        await page.locator("#reportCustomSetup").click();
    };
    await reports();
    const sent = path => requests.filter(req => req.path === path).map(req => req.body);
    async function hold(endpoint, { lost = false } = {}) {
        const release = Promise.withResolvers();
        releases.push(release.resolve);
        await page.route("**" + endpoint, async route => {
            const response = await route.fetch();
            await release.promise;
            if (lost) await route.abort("failed");
            else await route.fulfill({ response });
        }, { times: 1 });
        return release.resolve;
    }
    return { page, context, reports, sent, requests, hold };
}
async function regenerated(page, action) {
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/preview")),action()]);
    const preview = await response.json();
    assert.ok(response.ok(), preview.error);
    await phase(page,"ready");
    return preview;
}
const prepare = page => regenerated(page,() => page.locator("#prepareReportPreview").click());
async function pick(page, ids) {
    await page.getByRole("button",{name:/^Activity source:/}).click();
    const picker = page.locator("#reportActivityOptions");
    await picker.getByRole("radio",{name:/^Selected interactions/}).check();
    for (const id of ids) await picker.locator(`input[data-report-request="${id}"]`).check();
    await picker.getByRole("button",text("Use activity")).click();
}
async function addFormat(page, format) {
    await clickReportOption(page, /^Formats:/);
    const p = await regenerated(page,() => page.locator(`#formatOptions input[value="${format}"]`).check());
    await page.keyboard.press("Escape"); return p;
}
async function save(page, mode) {
    if (mode === "original") {
        await button(page,"Save report").click();
        await expect(button(page,"Save with chat details")).toBeVisible();
    }
    const [response] = await Promise.all([page.waitForResponse(r=>r.url().endsWith("/api/export")),
        button(page, mode === "original" ? "Save with chat details" : "Save report").click()]);
    const value = await response.json();
    assert.ok(response.ok(),value.error);
    await phase(page,"saved");
    return value.bundle;
}

test("expired export capability refuses the original dispatch; only a fresh preview can be explicitly saved", async t => {
    const { page,context,sent,reports } = await setup(t,[collected("rejected-export")]);
    const original = await prepare(page);
    await page.route("**/api/export", async route => {
        const origin = new URL(route.request().url()).origin;
        const released = await page.request.post(origin + "/api/session/release", {
            headers:{Origin:origin,"X-Board-Capability":route.request().headers()["x-board-capability"]},data:{},
        });
        assert.equal(released.status(),200); await route.continue();
    }, {times:1});
    const refused = page.waitForResponse(r=>r.url().endsWith("/api/export"));
    await button(page,"Save report").click();
    const r = await refused;
    assert.equal(r.status(),403); assert.equal((await r.json()).code,"session_expired");
    await phase(page,"blocked");
    await expect(page.locator("#reportJourneyError")).toContainText(/not replayed|No report was saved/);
    await expect(button(page,"Check save status")).toHaveCount(0);
    assert.equal((await loadBoardState(context)).exports.length,0);
    assert.deepEqual(sent("/api/export").map(x=>x.previewId),[original.previewId]);
    await reports(); const fresh = await prepare(page); assert.notEqual(fresh.previewId,original.previewId);
    await save(page,"masked");
    assert.equal((await loadBoardState(context)).exports.length,1);
    assert.deepEqual(sent("/api/export").map(x=>x.previewId),[original.previewId,fresh.previewId]);
});

test("whole-chat reports preserve the selected identities, three disclosure choices and four actual downloaded files", {timeout:90000}, async t => {
    const records = [collected("journey-a","JOURNEY_ORIGINAL leila@example.invalid password='JOURNEY_SECRET' <script>window.injected=true</script>"),
        collected("journey-b"),collected("outside","OUTSIDE_CHAT_MESSAGE")];
    records[0].sourceSessionName = records[1].sourceSessionName = "Calendar follow-up";
    records[1].userPrompt = {text:null,status:"unavailable",provenance:"human-authored"};
    records[2].sourceSessionId = "unselected-session";
    const {page,context,sent} = await setup(t,records);
    const before = await loadBoardState(context), sourceFile = path.join(context.dataDir,"private-evidence",before.evidenceFile);
    const sourceBytes = await readFile(sourceFile), savedFiles = [];
    for (const [index,mode] of ["masked","none","original"].entries()) {
        await page.goto(new URL("/?session=test-session",page.url()).href);
        await page.locator("#createSessionReport").click();
        await expect(page.locator("#reportDeskDates")).toHaveAccessibleName("Dates: All retained dates");
        await page.locator("#reportCustomSetup").click();
        await page.locator(`.report-before-prepare input[value="${mode}"]`).check();
        let p = await prepare(page);
        for (const f of ["pdf","json","markdown"]) p = await addFormat(page,f);
        assert.deepEqual(p.formats,["html","pdf","json","markdown"]);
        assert.deepEqual(sent("/api/preview").findLast(v=>v.selection)?.selection.scenarioIds.sort(),["journey-a","journey-b"]);
        assert.equal(p.records.length,2); assert.equal(p.privacy.reviewerConfirmed,false);
        const doc = page.frameLocator(".report-frame");
        const rendered = await doc.locator("body").innerText();
        assert.equal(rendered.includes("JOURNEY_ORIGINAL"),mode !== "none");
        assert.equal(rendered.includes("leila@example.invalid"),mode === "original");
        assert.doesNotMatch(rendered,/JOURNEY_SECRET|OUTSIDE_CHAT_MESSAGE/);
        await expect(doc.locator("script,img,iframe")).toHaveCount(0);
        if (mode === "original") {
            await button(page,"Save report").click(); await expect(button(page,"Save with chat details")).toBeVisible();
            await button(page,"Go back").click();
        }
        assert.equal((await loadBoardState(context)).exports.length,index);
        const bundle = await save(page,mode);
        await button(page,"Open saved report").click(); const reader = page.locator("#savedReportReader");
        for (const [format,name] of [["html","product-report.html"],["pdf","product-report.pdf"],["json","product-report.json"],["markdown","product-report.md"]]) {
            await selectActivityOption(page,"savedReaderFormat",format);
            const bytes = await readFile(bundle.files[name]); assert.deepEqual(bytes,previewBytes(p.files[name]));
            const [download] = await Promise.all([page.waitForEvent("download"),reader.getByRole("button",text("Download")).click()]);
            assert.equal(download.suggestedFilename(),name); assert.deepEqual(await readFile(await download.path()),bytes);
            savedFiles.push([bundle.files[name],bytes]);
        }
    }
    assert.equal(sent("/api/export").length,3);
    assert.deepEqual((await loadBoardState(context)).cards,before.cards);
    assert.deepEqual(await readFile(sourceFile),sourceBytes);
    for (const [name,bytes] of savedFiles) assert.deepEqual(await readFile(name),bytes);
});

test("finding an interaction in the picker does not narrow the nine frozen members or leak the search words", async t => {
    const {page,context,requests,sent} = await setup(t,Array.from({length:9},(_,i)=>collected(`searched-${i}`,`Synthetic report request ${i}`)));
    await page.locator('.report-before-prepare input[value=none]').check();
    await prepare(page); const frozen = await addFormat(page,"json");
    await button(page,"Change what's included").click(); await button(page,"Change activity selection").click();
    const finder = page.locator("#reportRequestSearch");
    await finder.fill("ReQuEsT 8"); await expect(page.locator("#reportList .report-entry")).toHaveCount(1);
    await expect(page.locator("#reportRequestSearchCount")).toContainText(/1 of 9.*9 remain included/);
    await finder.fill("NO_REPORT_MATCH"); await expect(page.locator("#reportList .report-entry")).toHaveCount(0);
    await expect(page.locator("#reportRequestSearchCount")).toContainText(/0 of 9.*9 remain included/);
    await page.locator("#reportActivityOptions").getByRole("button",text("Close")).click();
    await page.keyboard.press("Escape");
    const saved = await save(page,"none");
    assert.equal(frozen.records.length,9);
    const json = await readFile(saved.files["product-report.json"],"utf8");
    assert.deepEqual(JSON.parse(json).records,frozen.records);
    assert.doesNotMatch(json,/ReQuEsT 8|NO_REPORT_MATCH/);
    assert.doesNotMatch(JSON.stringify(requests),/ReQuEsT 8|NO_REPORT_MATCH/);
    assert.deepEqual(sent("/api/export").map(x=>x.previewId),[frozen.previewId]);
    assert.equal((await loadBoardState(context)).exports.length,1);
});

test("the selected report survives picker browsing; replacing its choice with a different single member needs a new preview", async t => {
    const {page,context,sent} = await setup(t,[collected("scope-a","FIRST_ONLY"),collected("scope-b","SECOND_ONLY")]);
    await pick(page,["scope-a"]); const initial = await prepare(page);
    assert.equal(initial.records.length,1); assert.match(JSON.stringify(initial.records),/FIRST_ONLY/);
    await button(page,"Change what's included").click(); await button(page,"Change activity selection").click();
    const picker = page.locator("#reportActivityOptions"); await picker.locator("#reportRequestSearch").fill("SECOND_ONLY");
    await expect(picker.locator("input[data-report-request=scope-a]")).toHaveCount(0);
    await picker.locator("input[data-report-request=scope-b]").check();
    await picker.locator("#reportRequestSearch").fill(""); await picker.locator("input[data-report-request=scope-a]").uncheck();
    const changed = await regenerated(page,()=>page.locator("#reportContinue").click());
    assert.notEqual(changed.previewId,initial.previewId); assert.equal(changed.records.length,1);
    assert.match(JSON.stringify(changed.records),/SECOND_ONLY/); assert.doesNotMatch(JSON.stringify(changed.records),/FIRST_ONLY/);
    assert.equal((await loadBoardState(context)).exports.length,0); assert.equal(sent("/api/export").length,0);
});

test("an unrelated stored update cannot replace a selected report's prepared copies or bytes", async t => {
    const records = [collected("preserved","FROZEN_SELECTED_WORDING email@example.invalid"),collected("unrelated","OTHER_WORDING")];
    const {page,context,sent} = await setup(t,records); await pick(page,["preserved"]); await prepare(page);
    const p = await addFormat(page,"json"); assert.doesNotMatch(JSON.stringify(p.records),/email@example\.invalid|OTHER_WORDING/);
    records[1].userPrompt.text += " updated"; await replaceEvidence(context,()=>({records}));
    const saved = await save(page,"masked");
    assert.deepEqual(sent("/api/export").map(x=>x.previewId),[p.previewId]);
    for (const name of ["product-report.json","product-report.html"]) assert.deepEqual(await readFile(saved.files[name]),previewBytes(p.files[name]));
    assert.match(JSON.stringify(p.records),/FROZEN_SELECTED_WORDING/); assert.equal(p.records.length,1);
});

for (const change of ["deleted", "changed"]) test(`confirming original text cannot save a selection ${change} after preparation`, async t => {
    const records = [collected("withdrawn-choice"),collected("remaining")];
    const {page,context,sent} = await setup(t,records);
    await pick(page,["withdrawn-choice"]);
    await page.locator('.report-before-prepare input[value=original]').check();
    const p = await prepare(page);
    await button(page,"Save report").click();
    await expect(button(page,"Save with chat details")).toBeVisible();
    if (change === "changed") {
        records[0].toolCalls[0].toolSucceeded = false;
        records[0].toolCalls[0].reportedOutcome = "failed";
    }
    await replaceEvidence(context,()=>({records:change === "deleted" ? records.slice(1) : records}));
    const [response] = await Promise.all([page.waitForResponse(r=>r.url().endsWith("/api/export")),button(page,"Save with chat details").click()]);
    assert.equal(response.status(),409);
    assert.match((await response.json()).error,change === "deleted" ? /Selected evidence changed or was deleted/ : /Selected evidence changed\. Prepare a new report preview/);
    await phase(page,"blocked");
    assert.deepEqual(sent("/api/export").map(r=>r.previewId),[p.previewId]);
    assert.equal(sent("/api/preview").length, 1, "A refused Save must not recapture the changed selection.");
    assert.equal((await loadBoardState(context)).exports.length,0);
});

test("an unsupported source cannot create an empty prepared report", async t => {
    const r = collected("unsupported"); r.sourceHost = "unsupported-invented-host";
    const {page,sent} = await setup(t,[r]);
    await page.getByRole("button",{name:/^Activity source:/}).click();
    await expect(page.locator("#scopeCount-all")).toContainText("0 interactions");
    await page.locator("#reportActivityOptions").getByRole("button",text("Close")).click();
    await page.locator("#prepareReportPreview").click();
    await expect(page.locator("#message")).toContainText("Choose at least one readable interaction");
    await expect(page.locator("#reportPreviewDrawer")).toBeHidden();
    assert.equal(sent("/api/preview").length,0); assert.equal(sent("/api/export").length,0);
});

test("at 375px and 200% type, keyboard preparation and the original-text warning do not save until confirmed", async t => {
    const {page,context,sent} = await setup(t,[collected("keyboard")]);
    await page.setViewportSize({width:375,height:960}); await page.evaluate(()=>document.documentElement.style.fontSize="200%");
    for(const theme of ["light","dark"]) {
        await chooseTheme(page,theme);
        const original = page.locator('.report-before-prepare input[value=original]'); await original.focus(); await original.press("Space");
        const entry = page.locator("#prepareReportPreview");
        await entry.press("Enter"); await phase(page,"ready");
        await button(page,"Save report").press("Enter"); await expect(button(page,"Save with chat details")).toBeInViewport();
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await button(page,"Go back").press("Enter"); await expect(button(page,"Save report")).toBeEnabled();
        await page.goBack();
    }
    assert.equal(sent("/api/preview").length,1, "Keyboard resume preserves the frozen report");
    assert.equal(sent("/api/export").length,0); assert.equal((await loadBoardState(context)).exports.length,0);
});

test("failed PDF preparation writes nothing; a new HTML preview can safely remove detected credentials from edited text", async t => {
    const {page,context,reports,sent} = await setup(t,[collected("render-fail")],async()=>{throw Error("Synthetic PDF unavailable");});
    await prepare(page); await clickReportOption(page, /^Formats:/);
    const failed = page.waitForResponse(r=>r.url().endsWith("/api/preview"));
    await page.locator("#formatOptions input[value=pdf]").check();
    assert.equal((await failed).ok(),false); await phase(page,"blocked");
    await expect(page.locator("#reportJourneyError")).toContainText(/No files were written/);
    await reports(); await prepare(page);
    await selectActivityOption(page,"preparedReportView","text");
    await page.getByText("Edit or omit this report copy",{exact:true}).first().click();
    await page.locator(".report-copy-controls textarea").first().fill("Edited copy password='EDIT_SECRET'");
    const edit = await regenerated(page,()=>button(page,"Update report copy").click());
    assert.doesNotMatch(edit.previewHtml,/EDIT_SECRET/);
    assert.equal(sent("/api/export").length,0); assert.equal((await loadBoardState(context)).exports.length,0);
});

test("cancelled preparation cannot publish after departure and reconnect clears an outstanding disclosure choice", async t => {
    const {page,reports,hold,context,sent} = await setup(t,[collected("cancel-scan")]);
    const release = await hold("/api/preview"), pending = page.waitForRequest(r=>r.url().endsWith("/api/preview"));
    try {
        await page.locator("#prepareReportPreview").click(); await pending; await phase(page,"scanning");
        await page.goBack(); const cancelled = page.waitForResponse(r=>r.url().endsWith("/api/cancel-preview"));
        release(); await cancelled;
        await expect(page.locator("#reportPreviewDrawer")).toBeHidden();
    } finally {release();}
    await reports(); await page.locator('.report-before-prepare input[value=original]').check(); await prepare(page);
    await button(page,"Save report").click(); await expect(button(page,"Save with chat details")).toBeVisible();
    const fresh = page.waitForResponse(r=>r.url().endsWith("/api/snapshot"));
    await page.evaluate(()=>window.dispatchEvent(new Event("online"))); await fresh;
    await expect(button(page,"Save with chat details")).toBeHidden();
    assert.equal(sent("/api/export").length,0); assert.equal((await loadBoardState(context)).exports.length,0);
});

test("uncertain Save recovers only its original receipt without a second export", async t => {
    const {page,context,sent,hold} = await setup(t,[collected("lost-save")]);
    const preview = await prepare(page), release = await hold("/api/export",{lost:true});
    try {
        await button(page,"Save report").click();
        await expect.poll(async()=>(await loadBoardState(context)).exports.length).toBe(1);
        await phase(page,"writing");
        await page.evaluate(()=>{document.dispatchEvent(new Event("visibilitychange"));window.dispatchEvent(new Event("online"));});
        release(); await phase(page,"blocked");
        await expect(page.locator("#reportJourneyError")).toContainText(/may have completed/);
        await expect(page.locator(".report-save-success")).toHaveCount(0);
        // A newer report in the same library is not evidence for this Save.
        const other = createExportController(context), state = await loadBoardState(context);
        const later = await other.preview("independent-fixture", undefined, {title:"Different saved report",formats:["html"],promptMode:"none"}, {kind:"all",revision:state.revision});
        await other.review("independent-fixture",later.previewId,true);
        await other.confirm("independent-fixture",later.previewId,true);
        await button(page,"Check save status").click(); await phase(page,"saved");
        const exports = (await loadBoardState(context)).exports, [saved, successor] = exports;
        assert.equal(exports.length,2); assert.equal(successor.bundleId,later.bundleId);
        assert.equal(saved.bundleId,preview.bundleId); assert.deepEqual(sent("/api/export").map(x=>x.previewId),[preview.previewId]);
        await button(page,"Open saved report").click();
        await expect(page.locator("#savedReportReader").getByRole("heading", { level: 1 })).toHaveText(preview.title);
        assert.equal(sent("/api/report/open").at(-1).bundleId, preview.bundleId);
        assert.deepEqual(await readFile(saved.files["product-report.html"]),previewBytes(preview.files["product-report.html"]));
    } finally {release();}
});

for (const lost of [false,true]) test(`dispatched ${lost ? "unacknowledged" : "acknowledged"} Save locks report edits and retains its receipt across a source withdrawal`, async t => {
    const {page,hold,sent,context} = await setup(t,[collected("held-copy")]);
    const p = await prepare(page);
    await selectActivityOption(page,"preparedReportView","text");
    await page.getByText("Edit or omit this report copy",{exact:true}).first().click();
    const editor = page.locator(".report-copy-controls textarea").first(), update = button(page,"Update report copy").first(), release=await hold("/api/export",{lost});
    try {
        await button(page,"Save report").click();
        await expect.poll(async()=>(await loadBoardState(context)).exports.length).toBe(1);
        await expect(editor).toBeDisabled();
        const [saved] = (await loadBoardState(context)).exports, bytes = await Promise.all(Object.values(saved.files).map(f=>readFile(f)));
        await expect(update).toBeDisabled();
        await editor.evaluate(n=>{n.value="MUST_NOT_ENTER_DRAFT";n.dispatchEvent(new Event("input",{bubbles:true}));});
        await update.dispatchEvent("click");
        await replaceEvidence(context,()=>({records:[]}));
        await updateBoardState(context,s=>{s.deletionVersion=(s.deletionVersion??0)+1;});
        release();
        if(lost){await phase(page,"blocked");await button(page,"Check save status").click();}
        await phase(page,"saved");
        assert.equal(saved.bundleId,p.bundleId);
        assert.deepEqual(sent("/api/export").map(r=>r.previewId),[p.previewId]);
        assert.equal(sent("/api/preview").length,1);
        assert.equal((await loadBoardState(context)).exports.length,1);
        assert.deepEqual(await Promise.all(Object.values(saved.files).map(f=>readFile(f))),bytes);
        assert.deepEqual(await readFile(saved.files["product-report.html"]),previewBytes(p.files["product-report.html"]));
    } finally {release();}
});
