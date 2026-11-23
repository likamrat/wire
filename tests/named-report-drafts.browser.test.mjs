import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { privateFixture, fixture, navigateMain } from "./helpers.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { contrast } from "./color-measurements.mjs";
import { palettes } from "../web/theme.mjs";

test("Analyze keeps adjacent cards' call actions with their identities even when the prompt has a long problem", async t => {
    const records = [fixture("layout-problem"), fixture("layout-operations"), fixture("layout-sparse")];
    const prompts = ["Check the workshop timetable against my mail and calendar. Find the invitation with the updated room and tell me which decisions still need a reply.",
        "Find the people on the release thread and prepare a reply to everyone. Leave it as a draft.", "Find the agenda for Monday."];
    const calls = [
        [["ask", {question:"Check the workshop"}, 3], ["fetch", {entityUrls:["/me/messages","/me/calendar/events"]}, 5]],
        [["fetch", {entityUrls:["/me/messages","/me/people"]}, 4], ["do_action", {actionUrl:"/me/messages/{id}/createReplyAll"}, 1],
            ["do_action", {actionUrl:"/me/translateExchangeIds"}, 1]],
        [["fetch", {entityUrls:["/me/calendar/events"]}, 1]],
    ];
    records.forEach((record,i) => {
        record.capturedAt = `2026-11-16T1${8-i}:00:00Z`;
        record.userPrompt = {text:prompts[i],status:"full",sourceTimestamp:record.capturedAt,authorship:{actor:"user",basis:"source-user"}};
        record.toolCalls = calls[i].flatMap(([tool,requestArgs,n],group) => Array.from({length:n},(_,j) => ({
            tool:`workiq-${tool}`,requestArgs,toolCallId:`layout-${i}-${group}-${j}`,startEventId:`start-${i}-${group}-${j}`,
            startedAt:record.capturedAt,reportedOutcome:!i && !group ? "failed" : "succeeded",toolSucceeded:!!(i || group),apiResults:[],
            ...(!i && !group ? {failureEvidence:{version:1,reason:"error-code-recorded",code:"ToolUnavailable",
                messageStatus:"text-excluded"}} : {}),
        })));
    });
    const cleanup = [], {context} = await privateFixture({after:f => cleanup.push(f)},records);
    const access = await createCopilotRuntimeAccess(context);
    const server = await startServer(context,createExportController(context),{port:0,frontend:"react",access,collector:{timers:false}});
    const browser=await chromium.launch(), page=await browser.newPage({reducedMotion:"reduce",timezoneId:"UTC"});
    t.after(async()=>{await browser.close();await server.close();await access.close();for(const f of cleanup.reverse())await f();});
    await page.clock.setFixedTime(new Date("2026-11-18T12:00:00Z"));
    await page.goto(server.url+"#analyze?range=custom&from=2026-11-10&to=2026-11-16");
    const cards=page.locator("#activityList .activity-card"), proof=process.env.WIRE_CARD_LAYOUT_PROOFS, gaps=[];
    await expect(cards).toHaveCount(3);
    await expect(cards.first().locator(".card-problem-area")).toBeVisible();
    await expect(cards.first().locator(".report-draft-trigger")).toBeVisible();
    if(proof) await mkdir(proof,{recursive:true});
    for(const [width,scale] of [[1440,1],[768,1],[390,1.5]]) for(const theme of ["light","dark"]) {
        await page.setViewportSize({width,height:1000}); await page.evaluate(([scale,theme])=>{
            document.documentElement.style.fontSize=`${scale*100}%`;
            document.documentElement.dataset.evidencePalette="blue";document.documentElement.dataset.evidenceTheme=theme;
        },[scale,theme]);
        await page.evaluate(()=>document.fonts.ready);
        await cards.first().evaluate(n=>scrollBy(0,n.getBoundingClientRect().top-document.querySelector(".app-header").getBoundingClientRect().bottom-12));
        if(proof) await page.screenshot({path:path.join(proof,`${theme}-${width}.png`)});
        for(const card of await cards.all()){
            const bounds=await card.evaluate(n=>{
                const key=n.querySelector(".card-identities").getBoundingClientRect(),foot=n.querySelector(".card-reading-actions").getBoundingClientRect();
                return {gap:foot.top-key.bottom,clipped:n.scrollWidth>n.clientWidth+1};
            });
            assert.equal(bounds.clipped,false); gaps.push({width,theme,...bounds});
        }
    }
    const op=cards.nth(1).getByRole("link",{name:/Reply-all draft: open call/});
    if(proof) await writeFile(path.join(proof,"gaps.json"),JSON.stringify(gaps));
    assert.ok(gaps.every(r=>r.gap>=-1 && r.gap<=16), JSON.stringify(gaps));
    await expect(cards.locator(".card-tool-list svg")).toHaveCount(0);
    await op.press("Enter"); await expect(page.locator('[data-tool-call-id="layout-1-1-0"]')).toBeFocused();
    await page.goBack(); await expect(op).toBeFocused();
});

test("report actions and call counts keep their columns while palettes distinguish add and remove", { timeout: 90000 }, async t => {
    const counts = [1, 3, 4, 12];
    const records = counts.map((n, i) => {
        const r = fixture(`column-${i}`);
        r.capturedAt = new Date().toISOString(); r.userPrompt.sourceTimestamp = r.capturedAt;
        r.toolCalls = Array.from({ length: n }, (_, j) => ({ ...r.toolCalls[0], toolCallId: `column-${i}-${j}`,
            startEventId: `start-${i}-${j}`, startedAt: r.capturedAt }));
        return r;
    });
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const access = await createCopilotRuntimeAccess(context);
    const server = await startServer(context, createExportController(context), { port: 0, frontend: "react", access, collector: { timers: false } });
    const browser = await chromium.launch(process.env.WIRE_FRONTEND_BROWSER ? { channel: process.env.WIRE_FRONTEND_BROWSER } : {});
    t.after(async () => { await browser.close(); await server.close(); await access.close(); for (const fn of cleanup.reverse()) await fn(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    await page.goto(server.url + "#analyze");
    const rows = page.locator("#activityList .card-reading-actions"), action = rows.first().locator(".report-draft-trigger");
    await expect(rows).toHaveCount(4);
    const geometry = () => rows.evaluateAll(footers => footers.map(footer => {
        const b = footer.querySelector(".report-draft-trigger"), link = footer.querySelector(".card-panel-link");
        const rect = el => el.getBoundingClientRect();
        const text = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect(); };
        return [rect(b.querySelector("svg")).x, text(b.lastElementChild).x, rect(link.querySelector("svg")).x,
            text(link.lastChild).x, rect(footer).height];
    }));
    const picker = page.getByRole("dialog", { name: "Report drafts", exact: true });
    const notice = page.locator(".report-draft-confirmation");
    const ink = button => button.evaluate(node => {
        // Chromium can report interpolated colors in OKLab. Sample their actual sRGB paint.
        const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
        return [getComputedStyle(node).color, getComputedStyle(node, node.matches(".report-draft-trigger") ? "::before" : null).backgroundColor]
            .map(value => {
                ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
                return `rgb(${[...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).join(",")})`;
            });
    });
    for (const [width, scale] of [[1440, 1], [390, 1.25]]) {
        await page.setViewportSize({ width, height: 900 }); await page.evaluate(n => document.documentElement.style.fontSize = `${n * 100}%`, scale);
        await expect(action.locator("span")).toBeVisible(); await expect(action.locator("svg")).toHaveAttribute("data-lucide-icon", "clipboard-plus");
        const before = await geometry();
        for (const row of before) assert.deepEqual(row.slice(0, 4), before[0].slice(0, 4));
        for (const palette of Object.keys(palettes)) for (const theme of ["light", "dark"]) {
            await page.evaluate(([palette, theme]) => {
                document.documentElement.dataset.evidencePalette = palette; document.documentElement.dataset.evidenceTheme = theme;
            }, [palette, theme]);
            const verify = async control => { const [fg,bg] = await ink(control); assert.ok(contrast(fg,bg) >= 4.5, `${palette}/${theme}: ${fg} on ${bg}`); };
            await page.mouse.move(0, 0); await verify(action); await action.hover(); await verify(action);
            await action.click();
            await expect(picker.getByRole("button", { name: "New draft", exact: true })).toBeEnabled();
            if (await picker.getByRole("button", { name: "Add to Launch readiness" }).count() === 0) {
                await picker.getByRole("button", { name: "New draft", exact: true }).click();
                await picker.getByLabel("Draft name").fill("Launch readiness"); await picker.getByRole("button", { name: "Create draft and add" }).click();
            } else await picker.getByRole("button", { name: "Add to Launch readiness" }).click();
            await expect(notice.getByRole("status")).toHaveText("Added to Launch readiness"); await verify(notice);
            await expect(action.locator("svg")).toHaveAttribute("data-lucide-icon","clipboard-check");
            assert.deepEqual(await geometry(), before);
            await action.click(); await picker.getByRole("button", { name: "Remove from Launch readiness" }).click();
            await expect(notice).toHaveText("Removed from Launch readiness"); await verify(notice);
            await expect(notice.locator("svg")).toHaveAttribute("data-lucide-icon","clipboard-minus");
        }
    }
});

test("Analyze and its reader edit named drafts through Save and Open, then deleting a draft resets only its cards", { timeout: 90000 }, async t => {
    const records = ["x", "y"].map((id, i) => {
        const r = fixture(id);
        r.capturedAt = new Date().toISOString(); r.userPrompt.text = i ? "Find the handoff schedule." : "Find the release checklist.";
        r.userPrompt.sourceTimestamp = r.capturedAt; r.userPrompt.authorship = { actor: "user", basis: "source-user" }; r.toolCalls[0].startedAt = r.capturedAt;
        r.toolCalls[0].toolSucceeded = !i; r.toolCalls[0].reportedOutcome = i ? "failed" : "succeeded";
        return r;
    });
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const access = await createCopilotRuntimeAccess(context);
    const server = await startServer(context, createExportController(context), { port: 0, frontend: "react", access, collector: { timers: false } });
    const browser = await chromium.launch(process.env.WIRE_FRONTEND_BROWSER ? { channel: process.env.WIRE_FRONTEND_BROWSER } : {});
    t.after(async () => { await browser.close(); await server.close(); await access.close(); for (const fn of cleanup.reverse()) await fn(); });
    const profile = await browser.newContext({ viewport: { width: 1280, height: 880 } });
    const page = await profile.newPage();
    page.setDefaultTimeout(6000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const preparations = [];
    profile.on("request", r => { if (r.url().endsWith("/api/preview") || r.url().endsWith("/api/export")) preparations.push(r.url()); });
    const proof = process.env.WIRE_FRONTEND_PROOFS;
    async function capture(name) {
        if (!proof) return;
        await mkdir(proof, { recursive: true });
        await page.screenshot({ path: path.join(proof, `draft-${name}.png`) });
    }
    await page.goto(server.url + "#analyze");
    const card = id => page.locator(`#activityList [data-view-key="request:${id}"]`);
    const action = id => card(id).locator(".report-draft-trigger");
    const panel = page.getByRole("dialog", { name: "Report drafts", exact: true });
    const reader = page.locator("#contextSidebar"), readerAction = reader.locator(".reader-section-jumps .report-draft-trigger");
    const delayedList = Promise.withResolvers(), releaseList = Promise.withResolvers();
    await page.route("**/api/report-drafts/list", async route => {
        delayedList.resolve(); await releaseList.promise; await route.continue();
    }, { times: 1 });
    t.after(() => releaseList.resolve());
    const staleTab = await profile.newPage();
    await staleTab.goto(server.url + "#analyze");
    await expect(staleTab.locator("#activityList .report-draft-trigger").first()).toBeVisible();
    await action("x").click();
    await delayedList.promise;
    await expect(panel.getByRole("searchbox")).toBeVisible();
    try {
        await expect(panel.getByRole("searchbox", { name: "Search drafts" })).toBeFocused();
        await expect(panel).toContainText("Loading drafts");
        await expect(panel).not.toContainText("No drafts yet.");
        await expect(panel.getByRole("button", { name: "New draft", exact: true })).toBeDisabled();
    } finally { releaseList.resolve(); }
    await expect(panel).toContainText("No drafts yet.");
    await expect(panel.getByRole("button", { name: "New draft", exact: true }).locator("svg")).toHaveAttribute("data-icon-role", "draft-create");
    await expect(panel.getByLabel("Draft name", { exact: true })).toBeHidden();
    await expect(panel.getByRole("link", { name: "Saved library" })).toHaveAttribute("href", /reports\?.*task=library/);
    await capture("empty");
    await panel.getByRole("button", { name: "New draft", exact: true }).click();
    await expect(panel.getByRole("searchbox")).toBeVisible();
    const fieldHeights = await panel.locator("input").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height));
    assert.ok(fieldHeights.every(h => h > 0 && h <= 40), `Compact search and name fields: ${fieldHeights}`);
    const searchBounds = await panel.getByRole("searchbox").boundingBox(), nameBounds = await panel.getByLabel("Draft name").boundingBox();
    assert.ok(nameBounds.width <= searchBounds.width * .75, "The naming field is narrower than the main search.");
    await capture("create");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(panel.getByRole("button", { name: "New draft", exact: true })).toBeFocused();
    await panel.getByRole("button", { name: "New draft", exact: true }).press("Enter");
    await panel.getByLabel("Draft name").fill("Release review");
    await panel.getByRole("button", { name: "Create draft and add" }).click();
    await expect(action("x")).toContainText("Release review");
    const openDraft = text => page.getByRole("button", { name: `Added to ${text}. Open draft`, exact: true });
    await expect(panel).toHaveCount(0);
    await expect(action("x")).toHaveText("In draft: Release review"); await expect(action("y")).toHaveText("Add to report");
    await capture("card-confirmed");
    await page.keyboard.press("Tab"); await expect(openDraft("Release review")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/reports(?:\?|$)/);
    await expect(page.locator("#namedReportDraft option:checked")).toHaveText("Release review");
    assert.deepEqual(preparations, []);
    await capture("opened-from-card");
    await navigateMain(page, "analyze");
    // This panel's accepted Analyze snapshot predates creation in the other panel.
    await staleTab.locator("#activityList .report-draft-trigger").first().click();
    const stalePicker = staleTab.getByRole("dialog", { name: "Report drafts", exact: true });
    await expect(stalePicker.locator(".draft-choice")).toHaveText(/Release review/);
    await stalePicker.getByRole("link", { name: "Saved library", exact: true }).click();
    await expect(staleTab).toHaveURL(/\/reports\?.*task=library/);
    await expect(stalePicker).toHaveCount(0);
    await staleTab.close();
    await card("y").locator(".request-card-open").click(); await expect(readerAction).toBeVisible();
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    await page.waitForFunction(() => document.querySelector("#contextSidebar").dataset.mode === "docked" && !document.getAnimations().some(a => a.playState === "running"));
    const anchor = () => page.evaluate(() => [location.href, scrollY, document.querySelector("#contextSidebarBody").scrollTop]);
    // The first access/status publication and sidebar sizing can still settle after the entrance animation.
    await page.evaluate(() => new Promise(resolve => {
        let prior, stableAt = performance.now();
        function frame() {
            const sample = [scrollY, document.querySelector("#main").offsetWidth, document.documentElement.scrollHeight].join(":");
            if (sample !== prior) { prior = sample; stableAt = performance.now(); }
            if (performance.now() - stableAt >= 1100) resolve(); else requestAnimationFrame(frame);
        }
        frame();
    }));
    const before = await anchor();
    await capture("reader");
    const source = reader.getByRole("button", { name: "Source", exact: true });
    const style = b => b.evaluate(n => {
        const s = getComputedStyle(n), g = getComputedStyle(n.querySelector("svg"));
        return [s.fontSize, s.minHeight, s.columnGap, s.textDecorationLine, g.width, g.height, n.getBoundingClientRect().y];
    });
    assert.deepEqual(await style(readerAction), await style(source));
    const endPadding = control => control.evaluate(node => {
        const text = document.createRange(); text.selectNodeContents(node.lastChild);
        return node.getBoundingClientRect().right - text.getBoundingClientRect().right;
    });
    await readerAction.hover();
    assert.ok(Math.abs(await endPadding(readerAction) - await endPadding(source)) <= 1, "The label uses Source's end padding, not the spare width of the strip");
    assert.equal(await readerAction.getAttribute("title"), null);
    await expect(page.getByRole("tooltip")).toBeHidden();
    assert.equal((await style(readerAction))[3], "none");
    await page.mouse.down(); assert.equal((await style(readerAction))[3], "none"); await page.mouse.up();
    await page.keyboard.press("Escape"); await expect(readerAction).toBeFocused();
    await readerAction.click(); await expect(panel.getByRole("button", { name: "Add to Release review" })).toBeVisible();
    await capture("picker");
    await panel.getByRole("searchbox").fill("name that does not exist");
    await expect(panel).toContainText("No matching drafts."); await expect(panel).not.toContainText("No drafts yet.");
    await expect(panel.getByLabel("Draft name", { exact: true })).toBeHidden();
    await panel.getByRole("button", { name: "Clear draft search" }).click();
    await panel.getByRole("searchbox").press("ArrowDown");
    await expect(panel.getByRole("button", { name: "Add to Release review" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(readerAction).toContainText("Release review"); await expect(readerAction).toBeFocused();
    assert.deepEqual(await anchor(), before);
    await readerAction.click(); await panel.getByRole("button", { name: "New draft" }).click();
    const handoff = "Handoff: regional checklist, support coverage and rollout readiness across all workspaces";
    await panel.getByLabel("Draft name").fill(handoff); await panel.getByRole("button", { name: "Create draft and add" }).click();
    await expect(readerAction).toHaveText(`In drafts: Release review, ${handoff}`);
    await expect(action("y")).toHaveText(`In drafts: Release review, ${handoff}`);
    const newTab = profile.waitForEvent("page");
    await openDraft(handoff).click();
    const openedDraft = await newTab;
    await expect(openedDraft.locator("#namedReportDraft option:checked")).toHaveText(handoff);
    if (proof) await openedDraft.screenshot({ path: path.join(proof, "draft-opened-from-reader.png") });
    await expect(reader).toBeVisible(); await expect(page).toHaveURL(/\/request/);
    assert.deepEqual(preparations, []);
    await openedDraft.close(); await page.bringToFront();
    await expect(action("y").locator("svg")).toHaveAttribute("data-lucide-icon", "clipboard-check");
    await readerAction.click(); await panel.getByRole("searchbox").fill("lease");
    await expect(panel.getByRole("button", { name: `Remove from ${handoff}` })).toHaveCount(0);
    await capture("filter"); await panel.getByRole("button", { name: "Remove from Release review" }).click();
    await expect(readerAction).toContainText("Handoff"); await expect(readerAction).not.toContainText("Release review");
    assert.deepEqual(await anchor(), before); await capture("added");
    await page.locator("#closeContextSidebar").click(); await page.reload();
    await expect(action("x")).toHaveText("In draft: Release review"); await expect(action("y")).toHaveText(`In draft: ${handoff}`);
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => document.documentElement.style.fontSize = "125%");
    await card("y").locator(".request-card-open").click(); await readerAction.hover();
    await expect(page.getByRole("tooltip")).toHaveText(`In draft: ${handoff}`);
    const box = await readerAction.boundingBox(), strip = await reader.locator(".reader-section-jumps").boundingBox();
    assert.ok(box.height >= 44 && box.x + box.width <= strip.x + strip.width + 1, "The long name fits the strip at enlarged text");
    await readerAction.click();
    await panel.getByRole("searchbox").fill("review"); await capture("narrow-filter"); await page.keyboard.press("Escape");
    await expect(readerAction).toBeFocused(); await expect(reader).toBeVisible(); await page.locator("#closeContextSidebar").click();
    await page.setViewportSize({ width: 1280, height: 880 }); await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
    for (const [i, draftName] of ["Release review", handoff].entries()) {
        await navigateMain(page, "reports");
        await page.getByRole("combobox", { name: "Report draft", exact: true }).click();
        await page.getByRole("option", { name: draftName, exact: true }).click();
        await page.getByRole("button", { name: /^Formats:/ }).click();
        await page.locator("#formatOptions input[value=json]").check();
        await page.keyboard.press("Escape");
        const preparing = page.waitForResponse(r => r.url().endsWith("/api/preview"));
        await page.locator("#prepareReportPreview").click(); const response = await preparing, prepared = await response.json();
        assert.equal(response.status(), 200, prepared.error);
        assert.equal(prepared.snapshot.selectionScope.requestGroups, 1);
        assert.ok(JSON.stringify(prepared.snapshot).includes(records[i].userPrompt.text));
        assert.ok(!JSON.stringify(prepared.snapshot).includes(records[1-i].userPrompt.text));
        if (!i) {
            // A later edit from a second panel must not recapture the currently prepared selection.
            const other = await page.context().newPage(); await other.goto(server.url + "#analyze");
            const otherButton = other.locator('#activityList [data-view-key="request:y"] .report-draft-trigger');
            await otherButton.click(); await other.getByRole("button", { name: "Add to Release review", exact: true }).click();
            await expect(otherButton).toContainText(`In drafts: Release review, ${handoff}`); await other.close();
        }
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const bundle = (await loadBoardState(context)).exports.find(b => b.bundleId === prepared.bundleId);
        const json = JSON.parse(await readFile(bundle.files["product-report.json"], "utf8"));
        assert.ok(JSON.stringify(json).includes(records[i].userPrompt.text));
        assert.ok(!JSON.stringify(json).includes(records[1-i].userPrompt.text));
        await page.getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.locator("#savedReportReader .saved-brief")).toBeVisible();
        const reopened = page.waitForResponse(r => r.url().endsWith("/api/report/open"));
        await page.reload();
        const verified = await reopened; assert.equal(verified.status(), 200);
        const documentText = JSON.stringify(await verified.json());
        assert.ok(documentText.includes(records[i].userPrompt.text));
        assert.ok(!documentText.includes(records[1-i].userPrompt.text));
        await expect(page.locator("#savedReportReader .saved-brief")).toBeVisible();
        await capture(`reopened-${i}`);
        await page.goto(server.url + "#analyze");
    }
    const beforeDelete = await loadBoardState(context);
    const original = await profile.newPage();
    await original.goto(server.url + "#analyze");
    const originalCard = id => original.locator(`#activityList [data-view-key="request:${id}"] .report-draft-trigger`);
    await expect(originalCard("x")).toHaveText("In draft: Release review");
    await expect(originalCard("y")).toHaveText(`In drafts: Release review, ${handoff}`);
    await page.bringToFront();
    const filePaths = beforeDelete.exports.flatMap(bundle => Object.values(bundle.files));
    const savedBytes = await Promise.all(filePaths.map(file => readFile(file)));
    const deleteRequests = [];
    page.on("request", request => {
        if (request.url().endsWith("/api/report-drafts/edit")) deleteRequests.push(request.postDataJSON());
    });
    const remove = page.getByRole("button", { name: "Delete draft", exact: true });
    async function reviewDeletion(name) {
        await navigateMain(page, "reports");
        await page.getByRole("combobox", { name: "Report draft", exact: true }).click();
        await page.getByRole("option", { name, exact: true }).click();
        await remove.click();
        return page.getByRole("dialog", { name: `Delete “${name}”?`, exact: true });
    }
    const decision = await reviewDeletion("Release review");
    await expect(decision.getByRole("button", { name: "Cancel" })).toBeFocused();
    await capture("delete-confirm");
    await decision.getByRole("button", { name: "Cancel" }).click();
    await expect(remove).toBeFocused();
    assert.deepEqual(deleteRequests, []);
    await expect(page.locator("#namedReportDraft option:checked")).toHaveText("Release review");
    await expect(page.locator(".report-draft-membership")).toHaveText("2 interactions in this draft");
    await remove.click();
    await decision.getByRole("button", { name: "Delete draft" }).click();
    await expect(page.locator("#namedReportDraft option:checked")).toHaveText("New report");
    await expect(originalCard("x")).toHaveText("Add to report");
    await expect(originalCard("y")).toHaveText(`In draft: ${handoff}`);
    await original.close();
    await navigateMain(page, "analyze");
    await expect(action("x")).toHaveText("Add to report");
    await expect(action("y")).toHaveText(`In draft: ${handoff}`);
    await page.reload();
    await expect(action("x").locator("svg")).toHaveAttribute("data-icon-role", "report-add");
    await expect(action("y")).toHaveText(`In draft: ${handoff}`);
    await card("y").scrollIntoViewIfNeeded();
    await capture("cards-after-deletion");
    const lastDecision = await reviewDeletion(handoff);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "125%"; document.documentElement.dataset.evidenceTheme = "dark"; });
    await expect(lastDecision.getByRole("button", { name: "Delete draft" })).toBeInViewport();
    await capture("delete-confirm-narrow");
    // The writer commits, but the response never reaches the panel.
    await page.route("**/api/report-drafts/edit", async route => {
        assert.ok((await route.fetch()).ok()); await route.abort();
    }, { times: 1 });
    await lastDecision.getByRole("button", { name: "Delete draft" }).click();
    await expect(page.locator(".report-draft-membership")).toBeHidden();
    await expect(page.getByRole("combobox", { name: "Report draft", exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Activity source: All retained activity" })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 880 });
    await navigateMain(page, "analyze"); await page.reload();
    await expect(action("x")).toHaveText("Add to report"); await expect(action("y")).toHaveText("Add to report");
    await action("x").click(); await expect(panel).toContainText("No drafts yet.");
    assert.equal(deleteRequests.length, 2);
    const afterDelete = await loadBoardState(context);
    assert.deepEqual(afterDelete.evidence, beforeDelete.evidence);
    assert.deepEqual(afterDelete.exports, beforeDelete.exports);
    assert.deepEqual(await Promise.all(filePaths.map(file => readFile(file))), savedBytes);
    assert.deepEqual(errors, []);
});
