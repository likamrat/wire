import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { loadBrowserAssets } from "../lib/browser-assets.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { createBoundedNativeState } from "../web/bounded-native-state.mjs";
import { mountBoundedNative } from "../web/bounded-native.mjs";
import { searchHitPresentation } from "../web/live-search.mjs";
import { createFilterState } from "../web/client.mjs";
import { committedNativeReportFixture } from "./native-report-controller-fixture.mjs";
import { createNativeRetainedViews } from "../lib/native-retained-views.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createReaderSections } from "../web/reader-sections.mjs";
import { createDisclosureState } from "../web/disclosure-state.mjs";
import { SEARCH_MATCH_POLICY_ID } from "../lib/search-text.mjs";
import { openAnalyzeFilters, closeAnalyzeFilters, selectActivityOption, fixture } from "./helpers.mjs";

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
 conversationHref:target=>"#request?parent="+target.conversationId+(target.completedRef?"&completed="+target.completedRef:""),
 openConversation:(target,focus)=>{
 opened.push(target);reader?.dispose();
 $("overlay").showModal();reader=ui.mountReader({root:$("detail"),...target,isCurrent:()=>allowed&&$("overlay").open});
 reader.revealTarget(focus)?.focus();
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
async function setup(t, { mainClient = false, github = false, timed = false, returned = false,
    extraConversations = 0, extraSuccesses = 0, distinctTools = false } = {}) {
    const envelopes = [...chatFixture(), ...coworkFixture()];
    for (let index = 0; index < extraSuccesses; index++) {
        const row = structuredClone(envelopes.find(row => row.record.data?.tid === "invented-search"));
        row.record.id = `seq:${20 + index}`; row.record.data.tid += `-${index}`;
        if (distinctTools) row.qualifiedFields.toolName.value = row.record.data.tn = `mcp__invented__tool${index}`;
        row.ordering.recordOrdinal = 20 + index; envelopes.push(row);
    }
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
    if (github) {
        await replaceEvidence(app.context, () => ({ records: Array.from({ length: github === true ? 1 : github }, (_, index) => {
            const record = fixture(`bounded-github-${index}`);
            if (timed) record.toolCalls[0].startedAt = "2026-01-03T12:00:00Z";
            return record;
        }),
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
    const assets = mainClient ? await loadBrowserAssets({renderer:"react"}) : null;
    const server = createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/") {
                res.setHeader("Content-Type", "text/html");
                return res.end(mainClient ? renderHtmlShell("a".repeat(64), "bounded-main-protocol", bootstrap, assets) : html());
            }
            const asset = req.method === "GET" && assets?.get(req.url);
            if (asset) { res.setHeader("Content-Type",asset.type); return res.end(asset.bytes); }
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

test("compiled workspace keeps the bounded completed selector private and restores its link on Back", async t => {
    const {page,calls} = await setup(t,{mainClient:true,extraSuccesses:11});
    await selectActivityOption(page,"sourceFilter","microsoft-365-cowork");
    // The source control changes before the narrowed snapshot and its inventory owner are installed.
    await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
    await expect(page.locator("#activityList .activity-card")).toHaveAttribute("data-source-id","microsoft-365-cowork");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy","false");
    await selectActivityOption(page,"toolFilter","mcp__m365_search__SearchM365");
    await closeAnalyzeFilters(page);
    const link=page.locator("#activityList").getByRole("link",{name:"12 tool calls completed"});
    await expect(link).toBeVisible();
    // The bounded card supplies names, not per-name call counts.
    const label = page.locator("#activityList .card-identities").getByRole("listitem");
    await expect(label).toHaveText(["mcp__m365_search__SearchM365"]);
    await expect(link).toHaveAttribute("href",/privateView=required/);
    await link.focus();await page.keyboard.press("Enter");
    const reader=page.locator("#requestContent");
    await expect(reader.getByRole("heading",{name:/Completed calls in this selection/})).toBeFocused();
    await expect(reader.locator("[data-native-call-id]")).toHaveCount(10);
    assert.ok(calls.some(c=>c.method==="detail" && c.input.section==="completed"));
    assert.doesNotMatch(page.url(),/[a-f0-9]{64}|mcp__|nativeCompletedRef/);
    await page.goBack();await expect(link).toBeFocused();
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    assert.ok(await label.evaluate(n => n.scrollWidth <= n.clientWidth && n.querySelector(".card-tool-name").getClientRects().length > 1),
        "The long native name wraps inside its label without clipping.");
});

test("completed native card opens only its counted calls across pages, with one arrow and group focus",
    async t => {
        const { page, calls } = await setup(t, { extraSuccesses: 11 });
        const cards = page.locator("#activityList");
        await page.evaluate(async () => { filters.filters.sources = ["microsoft-365-cowork"]; await load(); });
        await expect(cards.locator(".card-outcome")).toContainText("failed");
        await expect(cards.locator(".card-evidence-link")).toHaveCount(0);
        await page.evaluate(async () => { filters.filters.tools = ["mcp__m365_search__SearchM365"]; await load(); });
        const link = cards.getByRole("link", { name: "12 tool calls completed" });
        assert.equal(await page.evaluate(() => {
            const view = structuredClone(ui.presentation().value), item = view.page.items[0];
            delete item.completedRef; // A legacy producer has a real count, but no scoped detail offer.
            const card = ui.card({ view, item }), passive = Boolean(card.querySelector("span.card-outcome"))
                && !card.querySelector("a.card-evidence-link");
            ui.clearCards(card);
            return passive;
        }), true);
        await expect(link).toBeVisible();
        await expect(link.locator(":scope > svg")).toHaveCount(1);
        await expect(link).toHaveAttribute("href", /completed=[a-f0-9]{64}/);
        await link.focus();
        await link.press("Enter");
        const reader = page.locator("#detail"), callsOnPage = reader.locator("[data-native-call-id]");
        await expect(reader.getByRole("heading", { name: /Completed calls in this selection/ })).toBeFocused();
        await expect(callsOnPage).toHaveCount(10);
        await expect(callsOnPage.first().locator(".reader-call-summary .card-outcome-face")).toHaveText("1 tool call completed");
        const ids = await callsOnPage.evaluateAll(nodes => nodes.map(node => node.dataset.nativeCallId));
        await expect(reader).not.toContainText(/MoveMessage|CallGraph|invented question/);
        await reader.getByRole("button", { name: "Next", exact: true }).click();
        await expect(callsOnPage).toHaveCount(2);
        assert.equal(new Set([...ids, ...await callsOnPage.evaluateAll(nodes => nodes.map(node => node.dataset.nativeCallId))]).size, 12);
        await reader.getByRole("button", { name: "Previous", exact: true }).click();
        await expect(callsOnPage).toHaveCount(10);
        assert.deepEqual(await callsOnPage.evaluateAll(nodes => nodes.map(node => node.dataset.nativeCallId)), ids);
        assert.deepEqual(calls.filter(call => call.method === "detail").map(call => call.input.section), ["completed", "completed", "completed"]);
        await page.evaluate(() => { reader.dispose(); document.getElementById("overlay").close(); });
        await expect(link).toBeFocused();
        await expect(link).toHaveAttribute("data-card-origin", "");
        await page.evaluate(() => {
            const root = document.getElementById("detail"); document.getElementById("overlay").showModal();
            reader = ui.mountReader({ root, ...opened[0], completedRef: "0".repeat(64), isCurrent: () => true });
        });
        await expect(reader).toContainText("These exact completed calls are unavailable.");
        await expect(callsOnPage).toHaveCount(0);
        assert.equal(calls.filter(call => call.method === "detail").length, 3);
    });

test("the ordinary roster pages both sources, restores prior identities and keeps complete totals",
    async t => {
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
    async t => {
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
    async t => {
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
    async t => {
        const { page } = await setup(t, { mainClient: true });
        await selectActivityOption(page, "sourceFilter", "microsoft-365-chat");
        await closeAnalyzeFilters(page);
        await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        await expect(page.locator("#activityPager")).toContainText("1-1 of 1 activity entries");
        await expect(page.locator("#outcomeChart")).toContainText("No tool calls recorded.");
        await expect(page.locator("#percentageCharts [data-breakdown=models]")).toContainText("WIRE can’t tell which models these interactions used.");
        await expect(page.locator("#homeView")).not.toContainText("GitHub Copilot: 0");
        await expect(page.locator("#activityView")).not.toContainText("No collected activity yet");
        await selectActivityOption(page, "layerFilter", "reported-api");
        await closeAnalyzeFilters(page);
        await expect(page.locator("#chart")).toContainText("No matching activity");
        await expect(page.locator("#chart")).not.toContainText("Connect a source");
    });

test("Microsoft date drafts apply only on request; Reset restores all sources and reported-result units",
    async t => {
        const { page, snapshot } = await setup(t, { mainClient: true, github: true, timed: true, returned: true });
        const point = snapshot.nativeRead.timeSeries.points[0];
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
    });

test("reported-result tool overflow counts observations rather than their owning call",
    async t => {
        const { page } = await setup(t, { returned: true });
        await page.evaluate(async () => { filters.layer = "reported-api"; await load(); });
        await expect(page.locator("#percentageCharts [data-total]")).toHaveAttribute("data-total", "5");
        await expect(page.locator("#percentageCharts .percentage-tool-list")).toContainText("Other tools (1)");
        await expect(page.locator("#percentageCharts .percentage-tool-list [data-category='native-tools:other']")).toHaveAttribute("data-count", "2");
        await page.evaluate(async () => { filters.filters.tools = ["mcp__outlook__MoveMessage"]; await load(); });
        await expect(page.locator("#activityList")).toContainText("No matching activity");
    });

test("native time exact data follows the guide topic independently of the category chart",
    async t => {
        const { page, snapshot } = await setup(t, { mainClient: true, timed: true });
        const point = snapshot.nativeRead.timeSeries.points[0];
        assert.ok(point);
        await openAnalyzeFilters(page);
        await page.locator('[data-chart="workload"]').click();
        await closeAnalyzeFilters(page);
        await expect(page.locator("#chart .flat-comparison-action")).toHaveCount(1);
        await page.locator("#openChartReference").click();
        await page.locator('#chartReferenceTopics button[data-reference-topic="time"]').click();
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

test("mixed Analyze preserves separate source populations and native time/outcome drilldowns",
    async t => {
        const { page } = await setup(t, { mainClient: true, github: true, timed: true });
        await expect(page.locator("#activityList .activity-card")).toHaveCount(3);
        await expect(page.locator("#activityList [data-source-id^='microsoft-365-']")).toHaveCount(2);
        await expect(page.locator("#outcomeChart .percentage-ring")).toHaveCount(2);
        const nativeColumn = page.locator("#chart .time-column[href*='source=microsoft']");
        await expect(nativeColumn).toHaveCount(1);
        await expect(nativeColumn).toHaveText("2");
        await expect(page.locator("#chartFooter")).toContainText("1 undated record.");
        // The pointer targets inside the column select individual outcomes; the column link selects the day.
        await nativeColumn.press("Enter");
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 2 native tool calls");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        await expect(page.locator("#activityList")).toBeVisible();
        await expect(page.locator("#sourceFilter")).toHaveValue("microsoft-365");
        await page.locator("#outcomeChart [data-category=failure] .percentage-label").click();
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 1 native tool calls");
        await expect(page.locator("#activityList .card-identities")).toContainText("MoveMessage");
        await page.locator("#openChartReference").click();
        await page.locator('#chartReferenceTopics button[data-reference-topic="outcomes"]').click();
        await page.locator("#chartReferenceShowData").click();
        await expect(page.locator("#chartReferenceData .native-reference")).toContainText("Cowork");
    });

test("GitHub exact-table drilldown in mixed Analyze retains its original source denominator",
    async t => {
        const { page } = await setup(t, { mainClient: true, github: true, timed: true });
        await page.locator("#openChartReference").click();
        await page.locator('#chartReferenceTopics button[data-reference-topic="time"]').click();
        await page.locator("#chartReferenceShowData").click();
        const action = page.locator("#chartReferenceData .chart-data-action").first();
        await expect(action).toHaveAttribute("href", /source=github-copilot/);
        await action.click();
        await expect(page.locator("#sourceFilter")).toHaveValue("github-copilot");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        await expect(page.locator("#activityList [data-source-id^='microsoft-365-']")).toHaveCount(0);
        await expect(page.locator("#periodResult")).toContainText("GitHub Copilot: 1 Work IQ tool call");
    });

test("opening and cancelling a native filter reads only its dimension and exact Search opens one ordinal",
    async t => {
        // 101 distinct tools cross the production inventory page limit of 100.
        const { page, calls } = await setup(t, { mainClient: true, extraSuccesses: 98, distinctTools: true });
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 101 native tool calls");
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
        assert.equal(completeTools.page.items.length, 100);
        assert.ok(completeTools.page.nextCursor);
        const firstValue = completeTools.page.items[0].value;
        await expect(page.locator(`.select-popup [data-value=${JSON.stringify(firstValue)}]`)).toBeVisible();
        await page.getByRole("button", { name: "Next Microsoft options" }).click();
        const first = page.locator(`.select-popup [data-value=${JSON.stringify(firstValue)}]`);
        await expect(first).toHaveCount(0);
        await expect(page.locator("#toolFilter option[data-native-inventory=true]")).toHaveCount(1);
        assert.equal(calls.filter(call => call.method === "inventory" && call.input.dimension === "tools").at(-1).input.page.after,
            completeTools.page.nextCursor);
        await page.getByRole("button", { name: "First Microsoft options" }).click();
        await expect(first).toBeVisible();
        await expect(page.locator("#toolFilter")).toHaveValue("all");
        assert.equal(calls.filter(call => call.method === "inventory" && call.input.dimension === "tools").length, 3);
        await page.locator("#toolFilter-control").press("Escape");
        const beforeSource = calls.filter(call => call.method === "inventory").length;
        const narrowed = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
            && response.request().postDataJSON().filters?.sources?.includes("microsoft-365-cowork"));
        await selectActivityOption(page, "sourceFilter", "microsoft-365-cowork");
        const accepted = await narrowed;
        assert.equal(accepted.status(), 200);
        const { nativeRead } = await accepted.json();
        assert.deepEqual(nativeRead.page.items.map(row => row.sourceId), ["microsoft-365-cowork"]);
        const conversation = nativeRead.page.items[0];
        assert.ok(calls.filter(call => call.method === "inventory").slice(beforeSource).every(call => call.input.dimension === "sources"),
            "Opening Source must not request other filter dimensions.");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(1);
        await expect(page.locator("#activityList .activity-card")).toHaveAttribute("data-source-id", "microsoft-365-cowork");
        await closeAnalyzeFilters(page);
        const detailResponse = predicate => page.waitForResponse(response => response.url().endsWith("/api/retained/microsoft/detail")
            && predicate(response.request().postDataJSON()));
        const arrived = Promise.withResolvers(), deliver = Promise.withResolvers();
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch();
            arrived.resolve(response);
            await deliver.promise;
            await route.fulfill({response});
        }, {times: 1});
        try {
            await page.getByRole("button", {name: "Refresh", exact: true}).click();
            const refreshed = (await (await arrived.promise).json()).nativeRead;
            assert.deepEqual([refreshed.sourceRevision, refreshed.revision, refreshed.page.items[0].id],
                [nativeRead.sourceRevision, nativeRead.revision, conversation.id]);
            const link = page.locator("#activityList .request-card-open");
            await link.hover();
            await page.mouse.down();
            deliver.resolve();
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        } finally { deliver.resolve(); }
        const [callResponse] = await Promise.all([
            detailResponse(input => input.section === "calls" && input.conversationId === conversation.id),
            (async () => {
                await page.mouse.up();
                await expect(page.locator("#contextSidebar"), "A press on the same authorized card survives a stored refresh").toBeVisible();
            })(),
        ]);
        assert.equal(callResponse.status(), 200);
        const cardDetail = await callResponse.json();
        assert.equal(cardDetail.revision, nativeRead.revision);
        assert.equal(cardDetail.sourceRevision, nativeRead.sourceRevision);
        assert.equal(cardDetail.sourceId, conversation.sourceId);
        assert.equal(cardDetail.conversationId, conversation.id);
        const callIds = cardDetail.page.items.map(item => item.callSummaries[0].id);
        assert.equal(callIds.length, 10);
        await expect.poll(() => page.locator("#requestContent .reader-call").evaluateAll(rows => rows.map(row => row.dataset.nativeCallId)))
            .toEqual(callIds);
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).toBeHidden();
        const searched = page.waitForResponse(response => response.url().endsWith("/api/retained/microsoft/search")
            && response.request().postDataJSON().query === "Read");
        await page.locator("#wireSearch").fill("Read");
        const searchResponse = await searched;
        assert.equal(searchResponse.status(), 200);
        const result = await searchResponse.json(), hit = result.page.items[0];
        assert.equal(hit.source.sourceId, conversation.sourceId);
        assert.equal(hit.target.conversationId, conversation.id);
        assert.ok(Number.isSafeInteger(hit.target.ordinal));
        const exact = detailResponse(input => input.section === "observations" && input.at === hit.target.ordinal
            && input.conversationId === hit.target.conversationId && input.sourceRevision === result.sourceRevision);
        const beforeOpen = calls.filter(call => call.method === "detail" && call.input.at !== undefined).length;
        await page.locator(`#wireNativeSearch [data-native-search-id="${hit.id}"]`).click();
        await expect(page.locator("#contextSidebar")).toBeVisible();
        const exactResponse = await exact;
        assert.equal(exactResponse.status(), 200);
        const detail = await exactResponse.json();
        assert.equal(detail.revision, result.revision);
        assert.equal(detail.sourceRevision, result.sourceRevision);
        assert.equal(detail.sourceId, hit.source.sourceId);
        assert.equal(detail.conversationId, hit.target.conversationId);
        assert.equal(detail.focusOrdinal, hit.target.ordinal);
        await expect(page.locator(`#requestContent .reader-source-record[data-native-ordinal="${hit.target.ordinal}"]`)).toBeFocused();
        assert.equal(calls.filter(call => call.method === "detail" && call.input.at !== undefined).length, beforeOpen + 1);
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#wireSearch")).toHaveValue("Read");
        await page.locator("#wireSearch").fill("");
        await selectActivityOption(page, "sourceFilter", "github-copilot");
        await expect(page.locator("#boundedNativeSummary,#boundedNativeCards")).toHaveCount(0);
        await expect(page.locator("#activityList [data-source-id^='microsoft-365-']")).toHaveCount(0);
        assert.equal(calls.filter(call => call.method === "inventory" && call.input.dimension === "tools").length, 3,
            "Changing scope must retire the old tool inventory, not prefetch its replacement.");
    });
