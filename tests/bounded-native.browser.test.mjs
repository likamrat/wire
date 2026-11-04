import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { createBoundedNativeState } from "../web/bounded-native-state.mjs";
import { mountBoundedNative } from "../web/bounded-native.mjs";
import { searchHitPresentation } from "../web/live-search.mjs";
import { createFilterState } from "../web/client.mjs";
import { createSelectControls } from "../web/select-control.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createReaderSections } from "../web/reader-sections.mjs";
import { createDisclosureState } from "../web/disclosure-state.mjs";
import { SEARCH_MATCH_POLICY_ID } from "../lib/search-text.mjs";
import { openAnalyzeFilters, closeAnalyzeFilters, selectActivityOption, fixture, chooseTheme } from "./helpers.mjs";

const root = process.env.WIRE_BOUNDED_BACKEND_ROOT;
const backend = async file => import(pathToFileURL(path.join(root, file)).href);
function html() {
    const nonce = "bounded-native-ui";
    let page = renderHtmlShell("a".repeat(64), nonce);
    page = page.slice(0, page.lastIndexOf(`<script nonce="${nonce}">`)) + "</body></html>";
    page = page.replace(/<link rel="icon"[^>]*>/, "");
    return page.replace("</body>", `<script nonce="${nonce}">
const $=id=>document.getElementById(id);
const ux=(${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});
mountNavigation(ux);
window.allowed=true;const token={};
const api=Object.assign(async(path,input,options={})=>{
 const response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input),signal:options.signal});
 const value=await response.json();if(!response.ok)throw new Error(value.error);return value;
},{publicationToken:()=>allowed?token:null,isCurrent:value=>allowed&&value===token});
const source=(${createFilterState.toString()})();
const dimensional=(${createDimensionalCharts.toString()})();
const results=(${createRecordedResults.toString()})({screen:true});
const percentageMath=(${createPercentageCharts.toString()})({dimensional,ux,
 results,categories:(${createServiceCategories.toString()})()});
const percentages=percentageMath.mount($("percentageCharts"),{outcomesHost:$("outcomeChart"),dataHost:$("percentageData")});
window.opened=[];window.reader=null;
window.ui=(${mountBoundedNative.toString()})({api,ux,results,createState:${createBoundedNativeState.toString()},
 dimensional,onPage:()=>renderPage(),
 createReaderSections:${createReaderSections.toString()},presentation:(${createDisclosureState.toString()})(),
 renderText:text=>{const p=document.createElement("p");p.textContent=text;return p;},
 sourceLabel:source.sourceLabel,presentHit:${searchHitPresentation.toString()},matchPolicyId:${JSON.stringify(SEARCH_MATCH_POLICY_ID)},active:()=>true,
 openConversation:target=>{
 opened.push(target);reader?.dispose();
 $("overlay").showModal();reader=ui.mountReader({root:$("detail"),...target,isCurrent:()=>allowed&&$("overlay").open});
 }});
window.filters={layer:"tool",groupBy:"workload",filters:{scope:"all"},limit:1};
window.load=async()=>{
 const value=await api("/api/retained/microsoft/query",{schemaVersion:1,revision:null,sources:["microsoft-365-chat","microsoft-365-cowork"],
 analytics:filters,page:{limit:1,after:null}});window.frame={status:"bounded",...value};ui.seed(frame,filters);renderPage();
};
function renderPage(){
 const current=ui.presentation();ui.clearCards();$("activityList").replaceChildren();$("activityPager").replaceChildren();
 if(!allowed){percentages.withdrawAccess();return;}
 if(current.value){
  const empty=${JSON.stringify(buildActivityAnalytics([], { layer: "tool" }))};empty.layer=filters.layer;
  percentages.update(empty,filters,[],current.value);
  $("activityListSummary").textContent=current.value.aggregates.conversations+" conversations";
  for(const item of current.value.page.items)$("activityList").append(ui.card({item,view:current.value}));
  if(!current.value.page.items.length)$("activityList").textContent="No matching activity. Use All dates to include undated activity.";
  $("activityPager").textContent=(current.pageCount?current.pageOffset+1:0)+"-"+(current.pageOffset+current.pageCount)+" of "+current.value.aggregates.conversations;
  for(const [text,index,disabled]of [["Previous",current.pageIndex-1,!current.pageIndex],["Next",current.pageIndex+1,!current.hasNext]]){
   const button=document.createElement("button");button.textContent=text;button.disabled=disabled;
   button.onclick=()=>ui.pageAt(index);$("activityPager").append(button);
  }
 }else{$("activityList").textContent=current.error||"Reading activity page...";if(current.error)percentages.withdrawAccess();}
}
$("loading").hidden=true;$("workspace").hidden=false;$("homeView").hidden=false;$("activityView").hidden=false;
$("wireSearchPanel").hidden=false;
load().then(()=>document.body.dataset.ready="true").catch(error=>{document.body.dataset.error=error.message;});
</script></body>`);
}
async function setup(t, { mainClient = false, github = false, timed = false, long = false, returned = false, extraConversations = 0 } = {}) {
    const { committedNativeReportFixture } = await backend("tests\\native-report-controller-fixture.mjs");
    const { createNativeRetainedViews } = await backend("lib\\native-retained-views.mjs");
    const { chatFixture, coworkFixture } = await backend("tests\\native-read-model-fixtures.mjs");
    const envelopes = [...chatFixture(), ...coworkFixture()];
    for (let index = 0; index < extraConversations; index++) for (const row of chatFixture()) {
        row.scope.conversationId += `-${index}`;
        envelopes.push(row);
    }
    if (returned) for (const [id, count] of [["invented-batch", 3], ["invented-search", 2]]) {
        const row = envelopes.find(row => row.record.event === "tx" && row.record.data.tid === id);
        row.outcomes.nestedApi = { unit: "nested-api-result", availability: "recorded",
            observed: Array.from({ length: count }, (_, index) => ({ index, indexKind: "response-array-position",
                statusCode: 200, errorCode: null, paginationPresent: null, evidenceLevel: "intermediary-reported" })),
            declaredRequestCount: null, declaredRequestCountIsSuccessDenominator: false };
        row.evidenceReferences.returnedResults = { sourceDocument: "invented-native-response", pointer: "/data/out" };
    }
    if (long) {
        const prompt = envelopes.find(row => row.scope.surface === "cowork" && row.qualifiedFields.message?.value.author === "user");
        prompt.qualifiedFields.message.value.text += " Include the pending approvals and returned results, explain which calls failed, and keep unavailable dates separate from recorded dates when comparing the saved conversations.";
    }
    if (timed) for (const row of envelopes.filter(row => row.record.event === "ts")) {
        const value = "2026-01-02T07:30:00.000Z";
        row.record.data.ts = value;
        row.qualifiedFields.observationTime = { availability: "recorded", scope: "observation",
            unit: "iso8601", basis: "cowork.data.ts", value };
        row.evidenceReferences.observationTime = { sourceDocument: "invented-native-response",
            pointer: `/events/${row.ordering.recordOrdinal}/data/ts`, nativeEventId: row.record.id };
    }
    const app = await committedNativeReportFixture(t, { segmented: true, envelopes });
    const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
    const { currentStatePayload } = await backend("lib\\server.mjs");
    const { loadBoardState } = await backend("lib\\store.mjs");
    if (github) {
        const { replaceEvidence } = await backend("lib\\store.mjs");
        await replaceEvidence(app.context, () => ({ records: Array.from({ length: github === true ? 1 : github }, (_, index) => fixture(`bounded-github-${index}`)),
            importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    }
    const runtimeId = "00000000-0000-4000-8000-000000000001";
    const bootstrap = { schemaVersion: 1, mode: "enforced", runtimeId, maxWaitMs: 1000, freshnessMs: 5000,
        collectionMode: "source-aware" };
    async function collection() {
        const microsoft = await app.persistence.status({}, { owner: app.owner }), access = await app.lifecycle.status();
        const github = { state: "disconnected", connected: false, config: null, configVersion: null, revision: microsoft.revision,
            deletionVersion: 0, artifactRevision: 0 };
        return { ...github, sourceAware: { schemaVersion: 1, kind: "source-aware-collection",
            generation: microsoft.generation, authorizationRevision: access.authorizationRevision,
            global: { state: "legacy-compatible", revision: null, actions: [] }, github: { status: github, actions: [] },
            microsoft: { status: microsoft, actions: ["configure", ...microsoft.actions.filter(action => action === "collect-now")],
                configurationOffer: { schemaVersion: 2, kind: "native-configuration-offer",
                    generation: microsoft.generation, authorizationRevision: access.authorizationRevision, globalRevision: null,
                    intent: "save", available: true, expectedRevision: microsoft.configuration.configurationRevision,
                    supportedSurfaces: ["chat", "cowork"], values: { surfaces: microsoft.configuration.surfaces,
                        windowDays: microsoft.configuration.settings.windowDays }, basis: "committed-native", blockers: [] } } } };
    }
    const calls = [];
    const server = createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/") {
                res.setHeader("Content-Type", "text/html");
                return res.end(mainClient ? renderHtmlShell("a".repeat(64), "bounded-main-protocol", bootstrap) : html());
            }
            if (req.url === "/favicon.ico") return res.writeHead(204).end();
            let body = ""; for await (const part of req) body += part;
            const input = body ? JSON.parse(body) : {}, method = req.url.split("/").at(-1);
            const lifecycle = await app.lifecycle.status();
            res.setHeader("Content-Type", "application/json");
            res.setHeader("X-Wire-Runtime", runtimeId); res.setHeader("X-Wire-Generation", String(lifecycle.generation));
            if (mainClient && req.url === "/api/access/watch") {
                await new Promise(resolve => setTimeout(resolve, 50));
                return res.end(JSON.stringify({ ...bootstrap, generation: lifecycle.generation, authorizationRevision: lifecycle.authorizationRevision,
                    wire: "signed-in", retained: true, collection: "enabled" }));
            }
            if (mainClient && req.url === "/api/snapshot") {
                const board = await loadBoardState(app.context);
                const snapshot = await currentStatePayload(app.context, board, input, undefined, app.services);
                const native = { status: "bounded", ...await views.query({ schemaVersion: 1, revision: board.revision,
                    sources: ["microsoft-365-chat", "microsoft-365-cowork"], analytics: input,
                    page: { limit: input.limit ?? 10, after: null } }, app.services.nativeReportAdmission) };
                return res.end(JSON.stringify({ ...snapshot, collection: await collection(), nativeRead: native,
                    analytics: { ...snapshot.analytics, native } }));
            }
            if (mainClient && req.url === "/api/collection/status") return res.end(JSON.stringify(await collection()));
            if (mainClient && req.url === "/api/collection/sources/status") return res.end(JSON.stringify((await collection()).sourceAware));
            if (mainClient && req.url?.startsWith("/api/profile/")) return res.end(JSON.stringify({ github: { phase: "unavailable", profile: null }, lifecycle: null }));
            if (mainClient && !req.url?.startsWith("/api/retained/microsoft/")) {
                return res.writeHead(503).end(JSON.stringify({ error: "This isolated public-consumer proof does not implement control or mutation authority." }));
            }
            assert.ok(["query", "detail", "search", "inventory", "drilldown", "analyze"].includes(method));
            calls.push({ method, input });
            const value = await views[method](input, app.services.nativeReportAdmission);
            res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value));
        } catch (error) { res.writeHead(error.status || 500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch(), page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve)); views.close();
        assert.deepEqual(errors, []);
    });
    const firstSnapshot = mainClient ? page.waitForResponse(response => response.url().endsWith("/api/snapshot")) : null;
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const snapshot = firstSnapshot ? await (await firstSnapshot).json() : null;
    if (!mainClient) await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    else await expect(page.locator("#activityList [data-source-id^='microsoft-365-']")).toHaveCount(Math.min(snapshot.nativeRead.page.limit, 2 + extraConversations));
    return { page, calls, snapshot };
}

test("bounded cards replace pages while full totals stay fixed, and Dates/source transitions use server selection",
    { skip: !root }, async t => {
        const { page, calls } = await setup(t);
        await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        const summary = await page.locator("#outcomeChart").innerText();
        const first = await page.locator("#activityList .activity-card").getAttribute("data-source-id");
        await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
        await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        await expect.poll(() => page.locator("#activityList .activity-card").getAttribute("data-source-id")).not.toBe(first);
        assert.equal(await page.locator("#outcomeChart").innerText(), summary);
        assert.ok(calls.at(-1).input.page.after);
        await expect(page.locator("#activityPager")).toContainText("2-2 of 2");
        await page.locator("#activityPager").getByRole("button", { name: "Previous", exact: true }).click();
        await expect(page.locator("#activityList .activity-card")).toHaveAttribute("data-source-id", first);
        await expect(page.locator("#activityPager")).toContainText("1-1 of 2");
        await page.evaluate(async () => { filters.filters.sources=["microsoft-365-chat"];await load(); });
        await expect(page.locator("#activityList .activity-card")).toHaveAttribute("data-source-id", "microsoft-365-chat");
        await page.evaluate(async () => { filters.filters.from="2026-01-01";filters.filters.to="2026-12-31";await load(); });
        await expect(page.locator("#activityList")).toContainText("No matching activity");
        await expect(page.locator("#activityList")).toContainText("Use All dates to include undated activity");
        await page.evaluate(() => { allowed=false;ui.withdrawAccess(); });
        await expect(page.locator("#activityList .activity-card")).toHaveCount(0);
    });

test("native literal Search opens its exact original ordinal in one detail request and never creates membership",
    { skip: !root }, async t => {
        const { page, calls } = await setup(t);
        await page.evaluate(() => ui.searchChanged({ query:"Read",scope:"everywhere",types:[],
            sources:["microsoft-365-cowork"],revision:frame.revision,pending:false,base:frame }));
        await expect(page.locator("#wireNativeSearch .wire-search-hit").first()).toBeVisible();
        await page.locator("#wireNativeSearch .wire-search-hit").first().click();
        await expect(page.locator("#detail [data-native-ordinal]")).not.toHaveCount(0);
        const target = await page.evaluate(() => opened[0]);
        const detail = calls.filter(call => call.method === "detail" && call.input.at !== undefined);
        assert.equal(detail.length, 1, "Exact Open must not walk preceding pages.");
        assert.equal(detail[0].input.at, target.ordinal);
        assert.equal(detail[0].input.sourceRevision, target.sourceRevision);
        assert.equal(detail[0].input.page.after, null);
        await expect(page.locator("#detail [data-native-ordinal]").first()).toHaveAttribute("data-native-ordinal", String(target.ordinal));
        await page.evaluate(() => { reader.dispose();document.getElementById("overlay").close();ui.searchChanged({
            query:"Read",scope:"analysis",types:[],sources:["microsoft-365-cowork"],revision:frame.revision,pending:false,
            base:frame,analytics:filters }); });
        await expect(page.locator("#wireNativeSearch")).toContainText("3 matching native tool calls");
        assert.equal(calls.filter(call => call.method === "search").length, 1);
        assert.equal(calls.filter(call => call.method === "analyze").length, 1);
        assert.ok(calls.every(call => !Object.hasOwn(call.input, "receipt")));
    });

test("a stale bounded cursor clears the page and does not silently restart or widen the selection",
    { skip: !root }, async t => {
        const { page, calls } = await setup(t);
        await page.route("**/api/retained/microsoft/query", route => {
            const request = route.request().postDataJSON();
            return request.page.after ? route.fulfill({ status: 409, json: { error: "NATIVE_VIEW_CURSOR_STALE" } }) : route.continue();
        });
        await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
        await expect(page.locator("#activityList")).toContainText("NATIVE_VIEW_CURSOR_STALE");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(0);
        assert.equal(calls.filter(call => call.method === "query").length, 1, "No automatic first-page fallback.");
    });

test("the existing select popup pages native inventory options without selecting or accumulating them",
        { skip: !root }, async t => {
            const { page, calls } = await setup(t);
            await page.addScriptTag({ content: `window.makeSelectControls=${createSelectControls.toString()};` });
            await page.evaluate(async () => {
                window.inventoryInput = { schemaVersion:1,revision:frame.revision,viewId:frame.viewId,dimension:"tools",page:{limit:1,after:null} };
                window.optionChanges = 0;
                const select = document.getElementById("toolFilter");
                select.addEventListener("change", () => optionChanges++);
                window.readOptionPage = async after => {
                    window.optionPage = await api("/api/retained/microsoft/inventory",{...inventoryInput,page:{limit:1,after}});
                    const all = document.createElement("option");all.value="all";all.textContent="All tools";
                    select.replaceChildren(all,...optionPage.page.items.map(item=>{
                        const option=document.createElement("option");option.value=item.value;option.textContent=item.label;return option;
                    }));
                };
                await readOptionPage(null);
                const dialog = document.getElementById("analyzeFilterDialog");
                dialog.append(document.getElementById("filters"));
                dialog.showModal();
                window.testSelects = makeSelectControls(ux,{pagingFor:control=>control.id==="toolFilter"?{
                    label:optionPage.page.items.length+" of "+optionPage.aggregates.options+" Microsoft choices",
                    next:optionPage.page.nextCursor?()=>readOptionPage(optionPage.page.nextCursor):undefined,
                    first:()=>readOptionPage(null)
                }:null});
            });
            const before = await page.locator("#toolFilter option").nth(1).getAttribute("value");
            await page.locator("#toolFilter-control").click();
            await page.getByRole("button", { name: "Next Microsoft options", exact: true }).click();
            await expect.poll(() => page.locator("#toolFilter option").nth(1).getAttribute("value")).not.toBe(before);
            await expect(page.locator("#toolFilter option")).toHaveCount(2);
            assert.equal(await page.evaluate(() => optionChanges), 0);
            assert.ok(calls.filter(call => call.method === "inventory").at(-1).input.page.after);
            await expect(page.locator(".select-popup")).toBeVisible();
            await page.getByRole("button", { name: "First Microsoft options", exact: true }).click();
            await expect(page.locator("#toolFilter option").nth(1)).toHaveAttribute("value", before);
            assert.equal(await page.evaluate(() => optionChanges), 0);
            const output = process.env.WIRE_INVENTORY_UI_PROOFS;
            if (output) await mkdir(output, { recursive: true });
            for (const theme of ["light", "dark"]) for (const width of [1440, 768, 390]) {
                await page.locator("#toolFilter-control").press("Escape");
                await page.setViewportSize({ width, height: 1000 });
                await page.evaluate(theme => document.documentElement.dataset.evidenceTheme = theme, theme);
                await page.locator("#toolFilter-control").click();
                const box = await page.locator(".select-popup").boundingBox();
                assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
                if (output) await page.locator(".select-popup").screenshot({ path: path.join(output, `${theme}-${width}.png`) });
            }
        });

test("bounded query and observation detail fit the existing themes and responsive reader",
    { skip: !root }, async t => {
        const { page } = await setup(t), output = process.env.WIRE_BOUNDED_UI_PROOFS;
        if (output) await mkdir(output, { recursive: true });
        await page.evaluate(() => document.getElementById("wireSearchPanel").hidden = true);
        for (const theme of ["light", "dark"]) for (const width of [1440, 768, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(theme => document.documentElement.dataset.evidenceTheme = theme, theme);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            if (output) await page.locator(".analyze-dashboard").screenshot({ path: path.join(output, `${theme}-${width}.png`) });
        }
        await page.locator("#activityList .request-card-open").click();
        await expect(page.locator("#detail [data-reader-section=prompt]")).not.toBeEmpty();
        const width = await page.locator("#detail").evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
        assert.ok(width.scroll <= width.client + 1);
        if (output) await page.locator("#overlay").screenshot({ path: path.join(output, "dark-390-detail.png") });
    });

test("shared Analyze has one grid and roster, with ordinary native prompt reply and canonical calls",
    { skip: !root }, async t => {
        const { page } = await setup(t, { mainClient: true, github: true, timed: true });
        await expect(page.locator("#homeView .analyze-dashboard")).toHaveCount(1);
        await expect(page.locator("#boundedNativeSummary,#boundedNativeCards")).toHaveCount(0);
        await expect(page.locator("#activityList .activity-card")).toHaveCount(3);
        await expect(page.locator("#activityPager")).toContainText("1-3 of 3 activity entries");
        await expect(page.locator("#outcomeChart [data-count-unit]")).toHaveCount(2);
        await page.locator("#activityList [data-source-id=microsoft-365-cowork] .request-card-open").click();
        await expect(page.locator("#requestContent [data-reader-section=prompt]")).toContainText("Read the invented records.");
        await expect(page.locator("#requestContent [data-reader-section=activity] .reader-call")).toHaveCount(3);
        await expect(page.locator("#requestContent [data-reader-section=source]")).toHaveAttribute("data-open", "false");
        await expect(page.locator("#requestContent")).not.toContainText("Observation 1");
    });

test("the ordinary roster pages both sources, restores prior identities and keeps complete totals",
    { skip: !root }, async t => {
        const { page } = await setup(t, { mainClient: true, github: 25, extraConversations: 10 });
        const cards = page.locator("#activityList .activity-card"), pager = page.locator("#activityPager");
        const original = await cards.evaluateAll(nodes => nodes.map(node => node.dataset.viewKey));
        const totals = "GitHub Copilot: 25 Work IQ tool calls / Microsoft: 3 native tool calls";
        await expect(page.locator("#periodResult")).toHaveText(totals);
        await expect(pager).toContainText("1-16 of 37 activity entries");
        for (const [range, count] of [["17-28", 12], ["29-36", 8], ["37-37", 1]]) {
            await pager.getByRole("button", { name: "Next", exact: true }).click();
            await expect(pager).toContainText(`${range} of 37 activity entries`);
            await expect(cards).toHaveCount(count);
            await expect(page.locator("#periodResult")).toHaveText(totals);
        }
        await expect(pager.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
        for (const range of ["29-36", "17-28", "1-16"]) {
            await pager.getByRole("button", { name: "Previous", exact: true }).click();
            await expect(pager).toContainText(`${range} of 37 activity entries`);
        }
        assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.viewKey)), original);
    });

test("ordinary native page failure requires explicit refresh and never restarts or shows a false range",
    { skip: !root }, async t => {
        const { page, calls } = await setup(t, { mainClient: true, extraConversations: 10 });
        const pager = page.locator("#activityPager");
        let refuse = true;
        await page.route("**/api/retained/microsoft/query", route => refuse && route.request().postDataJSON().page.after
            ? route.fulfill({ status: 409, json: { error: "NATIVE_VIEW_CURSOR_STALE" } }) : route.continue());
        await pager.getByRole("button", { name: "Next", exact: true }).click();
        await expect(page.locator("#activityList")).toContainText("NATIVE_VIEW_CURSOR_STALE");
        await expect(pager).toContainText("Microsoft page unavailable");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(0);
        assert.equal(calls.filter(call => call.method === "query").length, 0);
        refuse = false;
        await page.getByRole("button", { name: "Read current activity", exact: true }).click();
        await expect(pager).toContainText("1-8 of 12 activity entries");
        await pager.getByRole("button", { name: "Next", exact: true }).click();
        await expect(pager).toContainText("9-12 of 12 activity entries");
    });

test("a late native page cannot repaint a newer source filter or broaden its roster",
    { skip: !root }, async t => {
        const { page } = await setup(t, { mainClient: true, extraConversations: 10 });
        let release, held = false;
        const gate = new Promise(resolve => { release = resolve; });
        await page.route("**/api/retained/microsoft/query", async route => {
            if (!route.request().postDataJSON().page.after) return route.continue();
            const response = await route.fetch(); held = true;
            await gate; await route.fulfill({ response });
        });
        try {
            await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
            await expect.poll(() => held).toBe(true);
            await selectActivityOption(page, "sourceFilter", "microsoft-365-cowork");
            await closeAnalyzeFilters(page);
            await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
            const identity = await page.locator("#activityList .activity-card").getAttribute("data-view-key");
            release();
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await expect(page.locator("#activityList .activity-card")).toHaveAttribute("data-view-key", identity);
            await expect(page.locator("#activityList .activity-card")).toHaveAttribute("data-source-id", "microsoft-365-cowork");
            await expect(page.locator("#activityPager")).toContainText("1-1 of 1 activity entries");
            await expect(page.locator("#sourceFilter")).toHaveValue("microsoft-365-cowork");
        } finally { release(); }
    });

test("no-call conversation context remains in the single roster without a GitHub empty panel or invented model",
    { skip: !root }, async t => {
        const { page } = await setup(t, { mainClient: true });
        await selectActivityOption(page, "sourceFilter", "microsoft-365-chat");
        await closeAnalyzeFilters(page);
        await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        await expect(page.locator("#activityPager")).toContainText("1-1 of 1 activity entries");
        await expect(page.locator("#outcomeChart")).toContainText("No tool calls recorded.");
        await expect(page.locator("#percentageCharts [data-breakdown=models]")).toContainText("Model names unavailable.");
        await expect(page.locator("#homeView")).not.toContainText("GitHub Copilot: 0");
        await expect(page.locator("#activityView")).not.toContainText("No collected activity yet");
        await selectActivityOption(page, "layerFilter", "reported-api");
        await closeAnalyzeFilters(page);
        await expect(page.locator("#chart")).toContainText("No matching activity");
        await expect(page.locator("#chart")).not.toContainText("Connect a source");
    });

test("shared Microsoft filters retain date drafts, exact result membership and the admitted Reset layout across themes",
    { skip: !root, timeout: 90000 }, async t => {
        const { page, snapshot } = await setup(t, { mainClient: true, github: true, timed: true, returned: true });
        const point = snapshot.nativeRead.timeSeries.points[0];
        const output = process.env.WIRE_NATIVE_ACTIVITY_PROOFS;
        if (output) await mkdir(output, { recursive: true });
        for (const theme of ["light", "dark"]) for (const width of [1440, 768, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            await chooseTheme(page, theme);
            await selectActivityOption(page, "sourceFilter", "microsoft-365-cowork");
            await selectActivityOption(page, "dateFilter", "custom");
            await page.locator("#fromFilter").fill(point.from.slice(0, 10));
            await page.locator("#toFilter").fill(point.to.slice(0, 10));
            await closeAnalyzeFilters(page);
            await expect(page.locator("#periodResult")).toContainText("Microsoft: 3 native tool calls");
            await openAnalyzeFilters(page);
            await page.locator("#applyDates").click();
            await expect(page.locator("#periodResult")).toContainText("Microsoft: 2 native tool calls");
            await selectActivityOption(page, "outcomeFilter", "failure");
            await expect(page.locator("#periodResult")).toContainText("Microsoft: 1 native tool calls");
            await selectActivityOption(page, "toolFilter", "mcp__outlook__MoveMessage");
            await expect(page.locator("#activityList .request-card-count")).toContainText("1 tool call");
            await expect(page.locator("#toolFilter-control .select-value")).toHaveText("mcp__outlook__MoveMessage");
            await expect(page.locator("#toolFilter-control .select-value wbr")).toHaveCount(2);
            await expect(page.locator("#outcomeFilter-control")).toContainText("Tool failed (1)");
            await page.locator("#resetView").scrollIntoViewIfNeeded();
            const geometry = await page.locator("#appliedFilters").evaluate(node => {
                const reset = node.querySelector("#resetView").getBoundingClientRect(), chips = node.querySelector("#filterChips").getBoundingClientRect();
                return { height: reset.height, right: reset.right, top: reset.top, chipTop: chips.top,
                    overflow: document.documentElement.scrollWidth - innerWidth };
            });
            assert.ok(geometry.height >= 44 && geometry.right <= width + 1 && geometry.overflow <= 1);
            assert.ok(await page.locator("#analyzeFilterHeading").evaluate(node =>
                node.getBoundingClientRect().top >= document.getElementById("analyzeFilterDialog").getBoundingClientRect().top),
            "The sticky filter heading remains inside its dialog after scrolling to Reset.");
            await page.locator("#resetView").hover();
            await page.locator("#resetView").focus();
            await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
            await expect(page.locator("#resetView")).toBeFocused();
            if (output) await page.screenshot({ path: path.join(output, `filters-${theme}-${width}.png`) });
            await page.locator("#resetView").click();
            await expect(page.locator("#periodResult")).toContainText("Microsoft: 3 native tool calls");
            await expect(page.locator("#resetView")).toBeDisabled();
            await closeAnalyzeFilters(page);
            await expect(page.locator("#activityList .activity-card")).toHaveCount(3);
            await selectActivityOption(page, "layerFilter", "reported-api");
            await closeAnalyzeFilters(page);
            await expect(page.locator("#periodResult")).toContainText("Microsoft: 5 returned-result observations");
            await expect(page.locator("#outcomeChart [data-count-unit]")).toHaveCount(2);
            await openAnalyzeFilters(page); await page.locator("#resetView").click(); await closeAnalyzeFilters(page);
            await expect(page.locator("#layerFilter")).toHaveValue("tool");
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await selectActivityOption(page, "sourceFilter", "microsoft-365-cowork");
        await page.locator("#resetView").scrollIntoViewIfNeeded();
        assert.ok(await page.locator("#resetView").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        if (output) await page.screenshot({ path: path.join(output, "filters-dark-390-enlarged.png") });
        await page.locator("#resetView").click(); await closeAnalyzeFilters(page);
        await expect(page.locator("#activityList .activity-card")).toHaveCount(3);
    });

test("reported-result tool overflow counts observations rather than their owning call",
    { skip: !root }, async t => {
        const { page } = await setup(t, { returned: true });
        await page.evaluate(async () => { filters.layer = "reported-api"; await load(); });
        await expect(page.locator("#percentageCharts [data-total]")).toHaveAttribute("data-total", "5");
        await expect(page.locator("#percentageCharts .percentage-tool-list")).toContainText("Other tools (1)");
        await expect(page.locator("#percentageCharts .percentage-tool-list [data-category='native-tools:other']")).toHaveAttribute("data-count", "2");
        await page.evaluate(async () => { filters.filters.tools = ["mcp__outlook__MoveMessage"]; await load(); });
        await expect(page.locator("#activityList")).toContainText("No matching activity");
    });

test("native time exact data follows the guide topic independently of the category chart",
    { skip: !root }, async t => {
        const { page, snapshot } = await setup(t, { mainClient: true, timed: true });
        const point = snapshot.nativeRead.timeSeries.points[0];
        assert.ok(point);
        await openAnalyzeFilters(page);
        await page.locator('[data-chart="workload"]').click();
        await closeAnalyzeFilters(page);
        await expect(page.locator("#chart .flat-comparison-action")).toHaveCount(1);
        await page.locator("#openChartReference").click();
        await page.locator("#chartReferenceAllTopics").click();
        await page.locator('button[data-reference-topic="time"]').click();
        await page.locator("#chartReferenceShowData").click();
        const table = page.locator("#chartReferenceData .native-reference").getByRole("table", { name: "Dated calls and results", exact: true });
        await expect(table).toBeVisible();
        const selected = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
            && response.request().postDataJSON().filters.from === point.from
            && response.request().postDataJSON().filters.to === point.to);
        await table.locator("tbody button").first().click();
        const narrowed = await (await selected).json();
        assert.equal(narrowed.nativeRead.aggregates.selectedRows, point.count);
        assert.deepEqual(narrowed.nativeRead.aggregates.outcomes, point.outcomes);
    });

test("native Analyze uses ordinary outcome rings, tool bars, exact columns and recognizable interaction cards",
    { skip: !root }, async t => {
        const { page } = await setup(t, { mainClient: true });
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 3 native tool calls");
        await openAnalyzeFilters(page);
        await selectActivityOption(page, "sourceFilter", "microsoft-365-cowork"); await closeAnalyzeFilters(page);
        await expect(page.locator("#outcomeChart .percentage-ring")).toBeVisible();
        await expect(page.locator("#percentageCharts [data-breakdown=tools] .percentage-bar")).toHaveCount(3);
        await expect(page.locator("#activityList .request-card-prompt")).toHaveText("Read the invented records.");
        await expect(page.locator("#activityList .request-card-categories")).toContainText("mcp__graph__CallGraph");
        await page.locator("#openChartReference").click();
        await expect(page.locator("#chartReferenceExplanation")).toContainText("3 tool calls");
        await page.locator("#chartReferenceShowData").click();
        await expect(page.locator("#chartReferenceData .native-reference")).toContainText("mcp__graph__CallGraph");
        await page.locator("#chartReferenceBack").click();
        await page.locator("#chartReferenceAllTopics").click();
        await page.locator("button[data-reference-topic=paths]").click();
        await page.locator("#chartReferenceShowData").click();
        await expect(page.locator("#chartReferenceData .native-reference")).toContainText("Paths are unavailable");
        await page.locator("#chartReferenceFindInput").fill("CallGraph");
        await expect(page.locator("#chartReferenceData .native-reference")).toContainText("mcp__graph__CallGraph");
        await expect(page.locator("#chartReferenceData .native-reference")).not.toContainText("MoveMessage");
        await expect(page.locator("#chartReferenceData .native-reference")).toContainText("3 tool calls.");
        await page.locator("#closeChartReference").click();
        await page.locator("#percentageCharts .percentage-label").filter({ hasText: "mcp__graph__CallGraph" }).click();
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 1 native tool calls");
        await expect(page.locator("#activityList .request-card-count")).toContainText("1 tool call");
        await page.locator("#activityList .request-card-open").click();
        await expect(page.locator("#requestContent")).toContainText("Read the invented records.");
        await expect(page.locator("#activityList .activity-card[data-detail-active]")).toHaveCount(1);
        await expect(page.locator("#requestContent .reader-call-summary.result-tone-success")).toHaveCount(2);
        await expect(page.locator("#requestContent .reader-call-summary.result-tone-failure")).toHaveCount(1);
        await expect(page.locator("#requestContent")).not.toContainText("not a complete conversation");
    });

test("mixed Analyze preserves separate source populations and native time/outcome drilldowns",
    { skip: !root }, async t => {
        const { page } = await setup(t, { mainClient: true, github: true, timed: true });
        await expect(page.locator("#activityList .activity-card")).toHaveCount(3);
        await expect(page.locator("#activityList [data-source-id^='microsoft-365-']")).toHaveCount(2);
        await expect(page.locator("#outcomeChart .percentage-ring")).toHaveCount(2);
        const nativeColumn = page.locator("#chart .time-column[href*='source=microsoft']");
        await expect(nativeColumn).toHaveCount(1);
        await expect(nativeColumn).toContainText("2 calls");
        await expect(page.locator("#chartFooter")).toContainText("1 undated record.");
        await nativeColumn.click();
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 2 native tool calls");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        await expect(page.locator("#activityList")).toBeVisible();
        await expect(page.locator("#sourceFilter")).toHaveValue("microsoft-365");
        await page.locator("#outcomeChart [data-category=failure] .percentage-label").click();
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 1 native tool calls");
        await expect(page.locator("#activityList .request-card-categories")).toContainText("MoveMessage");
        await page.locator("#openChartReference").click();
        await page.locator("#chartReferenceShowData").click();
        await expect(page.locator("#chartReferenceData .native-reference")).toContainText("Cowork");
    });

test("GitHub exact-table drilldown in mixed Analyze retains its original source denominator",
    { skip: !root }, async t => {
        const { page } = await setup(t, { mainClient: true, github: true, timed: true });
        await page.locator("#openChartReference").click();
        await page.locator("#chartReferenceAllTopics").click();
        await page.locator('button[data-reference-topic="time"]').click();
        await page.locator("#chartReferenceShowData").click();
        const action = page.locator("#chartReferenceData .chart-data-action").first();
        await expect(action).toHaveAttribute("href", /source=github-copilot/);
        await action.click();
        await expect(page.locator("#sourceFilter")).toHaveValue("github-copilot");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        await expect(page.locator("#activityList [data-source-id^='microsoft-365-']")).toHaveCount(0);
        await expect(page.locator("#periodResult")).toContainText("GitHub Copilot: 1 Work IQ tool call");
    });

test("ordinary native Analyze and reader keep shared theme and narrow layouts",
    { skip: !root }, async t => {
        const { page } = await setup(t, { mainClient: true, github: true, long: true });
        const output = process.env.WIRE_NATIVE_ACTIVITY_PROOFS;
        if (output) await mkdir(output, { recursive: true });
        if (output && process.env.WIRE_NATIVE_ACTIVITY_INSPECTOR) {
            const args = [process.env.WIRE_NATIVE_ACTIVITY_INSPECTOR, page.url(), "--app", "--out", path.join(output, "inspector"), "--json"];
            if (process.env.WIRE_NATIVE_ACTIVITY_INSPECTOR_ALLOW) args.push("--allow", process.env.WIRE_NATIVE_ACTIVITY_INSPECTOR_ALLOW);
            const result = await promisify(execFile)(process.execPath, args, { maxBuffer: 4 * 1024 * 1024 }).catch(error => {
                if (!Number.isInteger(error.code)) throw error;
                return { stdout: error.stdout, stderr: error.stderr, code: error.code };
            });
            await writeFile(path.join(output, "inspector-result.json"), result.stdout);
            if (result.stderr) await writeFile(path.join(output, "inspector-stderr.txt"), result.stderr);
            console.log("App inspector exit:", result.code ?? 0);
        }
        for (const theme of ["light", "dark"]) for (const width of [1440, 768, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            await chooseTheme(page, theme);
            await expect(page.locator("#outcomeChart .percentage-ring")).toHaveCount(2);
            await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
            await page.evaluate(() => Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)));
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${theme}/${width}: page overflow`);
            if (output) await page.screenshot({ path: path.join(output, `analyze-${theme}-${width}.png`), fullPage: true });
            await page.locator("#activityList .request-card-open").filter({ hasText: "Read the invented records." }).click();
            await expect(page.locator("#requestContent")).toContainText("Read the invented records.");
            await expect(page.locator("#closeContextSidebar")).toBeInViewport();
            await page.evaluate(() => Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)));
            assert.equal(await page.locator("#contextSidebar").evaluate(node => {
                const box = node.getBoundingClientRect();
                return box.left >= -1 && box.right <= innerWidth + 1;
            }), true, `${theme}/${width}: reader stays on screen`);
            if (output) await page.screenshot({ path: path.join(output, `reader-${theme}-${width}.png`) });
            await page.locator("#closeContextSidebar").click();
        }
    });

test("docked reader leaves native widget tool names readable without orphaning their final character",
    { skip: !root }, async t => {
        const { page } = await setup(t, { mainClient: true, github: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            await page.locator("#activityList [data-source-id=microsoft-365-cowork] .request-card-open").click();
            await expect(page.locator("#requestContent")).toContainText("Read the invented records.");
            await page.evaluate(async () => {
                await document.fonts.ready;
                await Promise.allSettled(document.getAnimations().filter(animation =>
                    animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
            });
            const ending = await page.locator("#percentageCharts [data-breakdown=tools] .percentage-label")
                .filter({ hasText: "mcp__m365_search__SearchM365" }).evaluate(node => {
                    const text = node.firstChild;
                    if (text?.nodeType !== Node.TEXT_NODE || !text.textContent.endsWith("SearchM365")) throw new Error("Missing original tool label.");
                    const range = document.createRange(), length = text.textContent.length;
                    range.setStart(text, length - 2); range.setEnd(text, length - 1);
                    const previous = range.getBoundingClientRect().top;
                    range.setStart(text, length - 1); range.setEnd(text, length);
                    return { previous, last: range.getBoundingClientRect().top };
                });
            assert.ok(Math.abs(ending.last - ending.previous) < 1, `${theme}: the final 5 must not wrap alone`);
            await page.locator("#closeContextSidebar").click();
            await expect(page.locator("#contextSidebar")).toBeHidden();
        }
    });

test("main client composes bounded native pages without presenting GitHub-only totals as Microsoft activity",
    { skip: !root }, async t => {
        // Public DTO/marker composition only. This does not qualify the still-gated additive source host.
        const { page, calls } = await setup(t, { mainClient: true });
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 3 native tool calls");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(2);
        assert.equal(calls.filter(call => call.method === "inventory").length, 0,
            "An accepted snapshot must not prefetch unused Microsoft filter inventories.");
        await openAnalyzeFilters(page);
        const inventoryPath = "**/api/retained/microsoft/inventory";
        let heldSource;
        await page.route(inventoryPath, route => {
            if (route.request().postDataJSON().dimension === "sources") { heldSource = route; return; }
            return route.continue();
        });

        const cancelled = page.waitForEvent("requestfailed", {
            predicate: request => request.url().endsWith("/api/retained/microsoft/inventory")
                && request.postDataJSON().dimension === "sources",
            timeout: 5000,
        });
        await page.locator("#sourceFilter-control").click();
        await expect.poll(() => Boolean(heldSource)).toBe(true);
        await expect(page.locator(".select-popup")).toContainText("Reading Microsoft choices");
        await page.locator("#sourceFilter-control").press("Escape");
        await cancelled;
        await page.unroute(inventoryPath);
        await expect(page.locator(".select-popup")).toBeHidden();
        await expect(page.locator("#sourceFilter")).toHaveValue("all");

        const toolPage = page.waitForResponse(response => response.url().endsWith("/api/retained/microsoft/inventory")
            && response.request().postDataJSON().dimension === "tools");
        await page.locator("#toolFilter-control").click();
        const completeTools = await (await toolPage).json();
        assert.equal(completeTools.aggregates.complete, true);
        for (const item of completeTools.page.items) {
            await expect(page.locator(`.select-popup [data-value=${JSON.stringify(item.value)}]`)).toBeVisible();
        }
        await expect(page.locator("#toolFilter")).toHaveValue("all");
        assert.equal(calls.filter(call => call.method === "inventory" && call.input.dimension === "tools").length, 1);
        await page.locator("#toolFilter-control").press("Escape");
        const beforeSource = calls.filter(call => call.method === "inventory").length;
        await selectActivityOption(page, "sourceFilter", "microsoft-365-cowork");
        assert.ok(calls.filter(call => call.method === "inventory").slice(beforeSource).every(call => call.input.dimension === "sources"),
            "Opening Source must not request other filter dimensions.");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        await expect(page.locator("#activityList .activity-card")).toHaveAttribute("data-source-id", "microsoft-365-cowork");
        await closeAnalyzeFilters(page);
        await page.locator("#activityList .request-card-open").click();
        await expect(page.locator("#contextSidebar")).toBeVisible();
        await expect(page.locator("#requestContent .reader-call")).toHaveCount(3);
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).toBeHidden();
        await page.locator("#wireSearch").fill("Read");
        await expect(page.locator("#wireNativeSearch .wire-search-hit").first()).toBeVisible();
        const beforeOpen = calls.filter(call => call.method === "detail" && call.input.at !== undefined).length;
        await page.locator("#wireNativeSearch .wire-search-hit").first().click();
        await expect(page.locator("#contextSidebar")).toBeVisible();
        await expect(page.locator("#requestContent [data-native-ordinal]")).not.toHaveCount(0);
        assert.equal(calls.filter(call => call.method === "detail" && call.input.at !== undefined).length, beforeOpen + 1);
        assert.ok(Number.isSafeInteger(calls.filter(call => call.method === "detail" && call.input.at !== undefined).at(-1).input.at));
        await page.locator("#closeContextSidebar").click();
        await page.locator("#wireSearch").fill("");
        await selectActivityOption(page, "sourceFilter", "github-copilot");
        await expect(page.locator("#boundedNativeSummary,#boundedNativeCards")).toHaveCount(0);
        await expect(page.locator("#activityList [data-source-id^='microsoft-365-']")).toHaveCount(0);
        assert.equal(calls.filter(call => call.method === "inventory" && call.input.dimension === "tools").length, 1,
            "Changing scope must retire the old tool inventory, not prefetch its replacement.");
    });
