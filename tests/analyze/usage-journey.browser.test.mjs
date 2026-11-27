import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { loadBoardState } from "../../lib/store.mjs";
import { readSavedArtifactFile, readSavedReportView } from "../../lib/report-artifacts.mjs";
import { pdfDocumentText } from "../../lib/search-corpus-pdf.mjs";
import { usagePreview } from "./usage-preview-fixture.mjs";
import { selectActivityOption, chooseTheme, openAnalyzeFilters, closeAnalyzeFilters, navigateMain, navigateSettings } from "../support/helpers.mjs";
import { prepareLandingReport, chooseLandingReportDates, clickReportOption } from "../reports/report-journey-helpers.mjs";

for (const frontend of ["react","bundled"]) test(`${frontend}: model readings follow the selected app catalog without changing evidence`, async t => {
    const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();});
    const {runtime,context,config}=await usagePreview({after:f=>cleanup.push(f)},frontend,{catalogModels:true});
    const db=new DatabaseSync(config.appDbPath);cleanup.push(()=>db.close());
    const before=await loadBoardState(context),browser=await chromium.launch();cleanup.push(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1500,height:950},timezoneId:"UTC"});
    const pairs={"gpt-6-astra":"GPT-6 Astra","gpt-6.1-sol":"GPT-6.1 Sol","gpt-6.2-sol":"GPT-6.2 Sol","gpt-5.6-sol":"GPT-5.6 Sol"};
    const read=()=>page.waitForResponse(r=>r.url().endsWith("/api/snapshot")&&r.ok());
    const initial=read();await page.goto(runtime.url);const snapshot=await (await initial).json();
    assert.deepEqual(snapshot.modelNames,pairs,"Only exact selected-account IDs present in retained evidence leave the server.");
    const widget=page.locator('[data-percentage-card="models"]');
    const raw=id=>widget.locator(`[data-category="${id}"] .percentage-label`);
    for (const [id,label] of Object.entries(pairs)) await expect(raw(id)).toHaveText(label);
    await expect(raw("deployment-z9")).toHaveText("deployment-z9");
    const count=await widget.getAttribute("data-total");
    const setName=name=>{
        const key="copilot-available-models-v2", catalog=JSON.parse(db.prepare("SELECT value FROM app_state WHERE key=?").get(key).value);
        catalog.scopedModels.workspace=catalog.scopedModels.workspace.filter(row=>row.id!=="deployment-z9");
        catalog.scopedModels.workspace.push({id:"deployment-z9",name});db.prepare("UPDATE app_state SET value=? WHERE key=?").run(JSON.stringify(catalog),key);
    };
    const refresh=async()=>{
        const response=read();
        const button=page.getByRole("button",{name:"Refresh",exact:true});
        if (await button.isVisible()) await button.click(); else await page.reload();
        const updated=await (await response).json();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy","false");
        return updated.modelNames;
    };
    setName("Northern Lantern");assert.equal((await refresh())["deployment-z9"],"Northern Lantern");
    await expect(raw("deployment-z9")).toHaveText("Northern Lantern");await expect(widget).toHaveAttribute("data-total",count);
    await raw("deployment-z9").hover();await expect(page.locator(".ux-tooltip:visible")).toContainText("Recorded as deployment-z9");
    await widget.getByRole("button",{name:"Token share",exact:true}).click();
    const share=id=>widget.locator(`.usage-model [data-recorded-model="${id}"]`);
    for (const [id,label] of Object.entries(pairs)) await expect(share(id)).toHaveText(label);
    await expect(share("no-entry")).toHaveText("no-entry");
    await expect(share("deployment-z9")).toHaveText("Northern Lantern");
    await share("deployment-z9").click();
    const cards=page.locator("#activityList article");await expect(cards).toHaveCount(1);await expect(cards.first()).toContainText("Meeting outline");
    const opener=cards.first().getByRole("link",{name:/^Model tokens:/});await opener.click();
    const receipt=page.locator('.usage-timeline [data-recorded-model="deployment-z9"]');await expect(receipt).toHaveText("Northern Lantern");
    await expect(page.locator(".usage-headline")).toContainText("30,500 tokens");
    await page.locator('[data-reader-section="source"] .reader-section-toggle').click();
    await expect(page.locator('[data-reader-section="source"] [data-recorded-model="deployment-z9"]')).toHaveText("Northern Lantern");
    await page.keyboard.press("Escape");await expect(opener).toBeFocused();
    setName("Orchard Atlas");assert.equal((await refresh())["deployment-z9"],"Orchard Atlas");
    await expect(share("deployment-z9")).toHaveText("Orchard Atlas");await expect(cards).toHaveCount(1);
    await opener.click();await expect(receipt).toHaveText("Orchard Atlas");await page.keyboard.press("Escape");
    await page.goto(new URL("/trends?section=charts",runtime.url).href);
    await page.getByRole("navigation",{name:"Trend measures"}).getByRole("button",{name:"Response models",exact:true}).click();
    const trends=page.locator('.trends-panel[data-family="models"]');
    await expect(trends.locator(".trends-legend-row").filter({hasText:"Orchard Atlas"})).toHaveCount(1);
    db.prepare("DELETE FROM app_state WHERE key=?").run("copilot-available-models-v2");
    assert.deepEqual(await refresh(),{});
    await expect(trends.locator(".trends-legend-row").filter({hasText:"deployment-z9"})).toHaveCount(1);
    await expect(page.getByText("Orchard Atlas",{exact:true}).filter({visible:true})).toHaveCount(0);
    db.prepare("INSERT INTO app_state(key,value) VALUES(?,?)").run("copilot-available-models-v2",JSON.stringify({
        accountId:"workspace",models:[{id:"deployment-z9",name:"Restored display name"}]}));
    const historical=snapshot.scenarios.find(s=>s.userPrompt?.text==="Meeting outline").userPrompt.sourceTimestamp.slice(0,10);
    await page.goto(runtime.url+`#analyze?range=custom&from=${historical}&to=${historical}`);
    await expect(raw("deployment-z9")).toHaveText("Restored display name");
    await expect(page.locator("#activityList article").filter({hasText:"Meeting outline"})).toHaveCount(1);
    const signOut=page.waitForResponse(r=>r.url().endsWith("/api/access/command")&&r.request().postDataJSON().action==="wire-sign-out");
    await page.locator("#wireAccountTrigger").click();await page.locator("#wireAccountGate").click();
    assert.equal((await (await signOut).json()).outcome,"completed");
    await expect(page.getByText("Restored display name",{exact:true})).toHaveCount(0);
    const after=await loadBoardState(context);assert.equal(after.evidenceRevision,before.evidenceRevision);
    assert.deepEqual(after.evidence,before.evidence);assert.deepEqual(after.exports,before.exports);
});

test("Token usage preset leads with frozen contributors and authors through JSON-only saved Open", {timeout:60000}, async t => {
    const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();});
    const {runtime,context}=await usagePreview({after:f=>cleanup.push(f)},"react");
    const browser=await chromium.launch();cleanup.push(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1366,height:900},timezoneId:"UTC"});
    const requests=[];page.on("request",r=>{if(r.method()==="POST")requests.push(new URL(r.url()).pathname);});
    await page.goto(runtime.url+"reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await chooseTheme(page,"light");
    const response=page.waitForResponse(r=>r.url().endsWith("/api/preview"));
    await page.locator("#reportPreset-tokens").click();
    let prepared=await(await response).json();
    const frozen=prepared.snapshot.usageFacts, facts=frozen.cohorts.selected;
    assert.equal(prepared.title,"Token usage");
    assert.equal(prepared.snapshot.reportPopulation.focus.preset,"all");
    assert.equal(facts.total,342000);
    assert.equal(facts.metered,7);assert.equal(facts.eligible,8);
    assert.equal(facts.rows.length,8);assert.equal(facts.rows.filter(r=>r.total===null).length,1);
    assert.equal(frozen.readingVersion,4);
    assert.equal(frozen.version,2);
    assert.deepEqual(facts.authors.map(g=>[g.label,g.metered,g.eligible,g.total]),
        [["Agent",3,3,236500],["Human",3,4,75000],["Sender unclear",1,1,30500]]);
    const frame=page.frameLocator(".report-frame"), usage=frame.locator("#usage-selected");
    await expect(usage).toBeVisible();
    const navigation=frame.getByRole("navigation",{name:"Report sections"});
    await expect(navigation.getByRole("link")).toHaveText(["Overview","Prompt authors","Ranked interactions","Coverage","Settings"]);
    assert.deepEqual(await navigation.locator("a>svg:first-child").evaluateAll(icons=>icons.map(svg=>svg.dataset.lucideIcon)),
        ["layout-grid","users-round","message-square","layers","settings"]);
    const settings=navigation.getByRole("link",{name:"Settings",exact:true});
    if(process.env.WIRE_USAGE_PROOFS) await page.screenshot({path:path.join(process.env.WIRE_USAGE_PROOFS,"token-report-preset.png"),animations:"disabled"});
    await navigation.getByRole("link",{name:"Prompt authors",exact:true}).click();
    const reader=page.locator('iframe[title="Prepared report"]');
    const position=await reader.evaluate(node=>node.contentWindow.scrollY);
    await settings.press("Enter");
    await expect(page.getByRole("dialog",{name:"Report settings",exact:true})).toBeVisible();
    if(process.env.WIRE_USAGE_PROOFS) await page.screenshot({path:path.join(process.env.WIRE_USAGE_PROOFS,"token-report-settings.png"),animations:"disabled"});
    await page.goBack();
    await expect(settings).toBeFocused();
    assert.equal(await reader.evaluate(node=>node.contentWindow.scrollY),position);
    const width=await reader.evaluate(node=>node.clientWidth);
    await page.getByRole("button",{name:"Maximize preview",exact:true}).click();
    await expect.poll(()=>reader.evaluate(node=>node.clientWidth)).toBeGreaterThan(width);
    await page.getByRole("button",{name:"Restore preview",exact:true}).click();
    await expect.poll(()=>reader.evaluate(node=>node.clientWidth)).toBe(width);
    const finding="3 interactions account for 69.2% of recorded tokens";
    await expect(usage.locator(":scope>h3")).toHaveText(finding);
    await expect(usage).toContainText("236,500 of 342,000 recorded tokens");
    await expect(usage).toContainText("7 of 8 interactions measured");
    await expect(usage).toContainText("missing usage is not estimated");
    await expect(usage.getByRole("row").filter({hasText:"Sender unclear"})).toContainText("30,500");
    await expect(usage).toContainText("342,000 recorded tokens");
    await expect(usage).toContainText("Not recorded");
    await expect(usage.locator("xpath=..")).toHaveJSProperty("open",true);
    assert.equal(requests.filter(p=>p==="/api/preview").length,1);
    assert.equal(requests.filter(p=>p==="/api/export").length,0);
    await usage.getByRole("link",{name:"View ranked interactions",exact:true}).click();
    const ranked=usage.locator("#usage-selected-interactions tbody tr");
    for(const row of [ranked.first(),ranked.last()]) {
        const link=row.getByRole("link"), ref=(await link.getAttribute("href")).split("#").at(-1);
        await link.click();await expect(frame.locator(`[id="${ref}"]`)).toBeVisible();
    }
    await settings.click();
    await page.getByRole("button",{name:"Formats: HTML",exact:true}).click();
    for(const format of ["json","markdown","pdf"]) {
        const changed=page.waitForResponse(r=>r.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value=${format}]`).check();
        prepared=await(await changed).json();assert.deepEqual(prepared.snapshot.usageFacts,frozen);
    }
    const pdf=(await pdfDocumentText(Buffer.from(prepared.files["product-report.pdf"].data,"base64"))).content.replace(/\s+/g," ");
    for(const text of [prepared.files["product-report.html"],prepared.files["product-report.md"],pdf]) {
        assert.ok(text.includes(finding));assert.ok(text.includes("236,500"));assert.ok(text.includes("Sender unclear"));
    }
    assert.ok(prepared.files["product-report.html"].indexOf('id="usage-selected"') < prepared.files["product-report.html"].indexOf('id="finding"'));
    for(const format of ["html","markdown","pdf"]) {
        const changed=page.waitForResponse(r=>r.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value=${format}]`).uncheck();
        prepared=await(await changed).json();assert.deepEqual(prepared.snapshot.usageFacts,frozen);
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button",{name:"Save report",exact:true}).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase","saved");
    const state=await loadBoardState(context);
    assert.equal(state.exports.length,1);assert.deepEqual(state.exports[0].formats,["json"]);
    const saved=await readSavedArtifactFile(context,state,prepared.bundleId,"report","json");
    assert.deepEqual(JSON.parse(saved.bytes).usageFacts,frozen);
    const readable=await readSavedReportView(context,state,prepared.bundleId);
    assert.ok(readable.text.includes(finding));assert.ok(readable.text.includes("Sender unclear"));
    await page.getByRole("button",{name:"Open saved report",exact:true}).click();
    await expect(page.locator("#savedReportReader .saved-brief")).toHaveCount(0);
    const savedUsage=page.frameLocator("#savedReportReader iframe").locator("#usage-selected");
    await expect(savedUsage.locator(":scope>h3")).toHaveText(finding);
    await expect(savedUsage.locator("xpath=..")).toHaveJSProperty("open",true);
    if(process.env.WIRE_USAGE_PROOFS) {
        await page.screenshot({path:path.join(process.env.WIRE_USAGE_PROOFS,"token-report-saved.png"),animations:"disabled"});
        await writeFile(path.join(process.env.WIRE_USAGE_PROOFS,"token-report-snapshot.json"),saved.bytes);
        const manifest=await readSavedArtifactFile(context,state,prepared.bundleId,"report","manifest");
        await writeFile(path.join(process.env.WIRE_USAGE_PROOFS,"token-report-manifest.json"),manifest.bytes);
        await writeFile(path.join(process.env.WIRE_USAGE_PROOFS,"token-report-binding.json"),JSON.stringify({bundleId:prepared.bundleId,manifestHash:saved.manifestHash}));
    }
    assert.equal(requests.filter(p=>p==="/api/export").length,1);
});

test("Token usage keeps recorded zero distinct from an unmeasured period", async t=>{
    const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();});
    const {runtime}=await usagePreview({after:f=>cleanup.push(f)},"react",{sparse:true,measuredZero:true});
    const browser=await chromium.launch();cleanup.push(()=>browser.close());
    const page=await browser.newPage({viewport:{width:390,height:900},timezoneId:"UTC"});
    await page.goto(runtime.url+"reports");await page.locator('#workspace[aria-busy="false"]').waitFor();
    await chooseTheme(page,"dark");
    const read=async()=>{
        const response=page.waitForResponse(r=>r.url().endsWith("/api/preview"));
        await page.locator("#reportPreset-tokens").click();return(await response).json();
    };
    const zero=await read(), usage=page.frameLocator(".report-frame").locator("#usage-selected");
    assert.deepEqual([zero.snapshot.usageFacts.cohorts.selected.total,zero.snapshot.usageFacts.cohorts.selected.metered,zero.snapshot.usageFacts.cohorts.selected.eligible],[0,1,2]);
    await expect(usage.locator(":scope>h3")).toHaveText("The recorded token total is 0");
    await expect(usage).toContainText("1 of 2 interactions measured");
    assert.doesNotMatch(await usage.innerText(),/NaN|Infinity|100(?:\.0)?%/);
    if(process.env.WIRE_USAGE_PROOFS) await page.screenshot({path:path.join(process.env.WIRE_USAGE_PROOFS,"token-report-zero.png"),animations:"disabled"});
    await page.locator("#reportLibraryLink").click();
    await chooseLandingReportDates(page,"Custom dates");
    const yesterday=new Date();yesterday.setUTCDate(yesterday.getUTCDate()-1);
    const date=yesterday.toISOString().slice(0,10);
    await page.locator("#reportDatefrom").fill(date);await page.locator("#reportDateto").fill(date);
    await page.locator("#reportCustomDates").getByRole("button",{name:"Apply dates",exact:true}).click();
    const missing=await read();
    assert.deepEqual([missing.snapshot.usageFacts.cohorts.selected.total,missing.snapshot.usageFacts.cohorts.selected.metered,missing.snapshot.usageFacts.cohorts.selected.eligible],[null,0,1]);
    await expect(usage.locator(":scope>h3")).toHaveText("No verified token counts");
    await expect(usage).toContainText("0 of 1 interaction measured");
    await expect(usage).toContainText("Not recorded");
    assert.doesNotMatch(await usage.innerText(),/NaN|Infinity|account.*%/);
    if(process.env.WIRE_USAGE_PROOFS) await page.screenshot({path:path.join(process.env.WIRE_USAGE_PROOFS,"token-report-unmeasured.png"),animations:"disabled"});
});

for (const [frontend,width] of [["react",1440],["bundled",390]]) test(`${frontend}: Analyze explains sparse token usage and opens the actual measured day`,async t=>{
    const cleanup=[]; t.after(async()=>{for(const close of cleanup.reverse()) await close();});
    const {runtime}=await usagePreview({after:f=>cleanup.push(f)},frontend,{sparse:true});
    const browser=await chromium.launch(); cleanup.push(()=>browser.close());
    const page=await browser.newPage({viewport:{width,height:900},timezoneId:"America/Los_Angeles",hasTouch:width<500});
    await page.goto(runtime.url);
    if (width<500) await chooseTheme(page,"dark");
    const card=page.locator("#analyzeUsage"), date=card.locator(".token-day-date a"), slider=card.getByRole("slider",{name:"Inspect daily token usage"});
    await expect(card.locator(".token-history-total")).toHaveCount(0);
    await expect(slider).toHaveAccessibleDescription("200,000 tokens in this period. 1 of 2 interactions measured.");
    await expect(card.locator(".token-day-reading")).toHaveAttribute("aria-hidden","true");
    await expect(card.locator(".token-history-plot")).toHaveCSS("cursor","default");
    await expect(card.locator(".token-hover-point")).toHaveCSS("opacity","0");
    await expect(card).not.toContainText("Recorded tokens");
    await expect(card.locator("[data-measured-day]")).toHaveCount(1);
    await expect(card.locator(".token-line")).toHaveCount(0);
    await expect(card).not.toContainText("Work IQ activity");
    const lastTick=card.locator(".token-history-dates time").last();await lastTick.scrollIntoViewIfNeeded();
    const labelBox=await lastTick.boundingBox(),box=await slider.boundingBox(),endX=labelBox.x+labelBox.width/2,endY=box.y+box.height/2;
    if(width<500) await page.touchscreen.tap(endX,endY);
    else await lastTick.hover();
    await expect(slider).toHaveAttribute("aria-valuetext",/Token count unavailable · 0 of 1 measured/);
    if(width>=500) {
        await lastTick.click();
        await date.hover();await expect(slider).toHaveAttribute("aria-valuetext",/Token count unavailable/);
    }
    await slider.press("ArrowLeft");await expect(slider).toHaveAttribute("aria-valuetext",/No matching activity/);
    await slider.press("Home");await expect(slider).toHaveAttribute("aria-valuetext",/200,000 tokens/);
    if(width>=500) {
        const point=card.locator(".token-column");await point.scrollIntoViewIfNeeded();
        const b=await point.boundingBox();
        await page.mouse.move(b.x+b.width+24,b.y+b.height/2);await expect(card.locator(".token-day-reading")).toHaveCSS("opacity","0");
        await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await expect(card.locator(".token-day-reading")).toHaveCSS("opacity","1");
        await page.mouse.click(b.x+b.width/2,b.y+b.height/2);
    }
    const expected=new Date(); expected.setUTCHours(10,0,0,0); expected.setUTCDate(expected.getUTCDate()-20);
    const dateText=expected.toLocaleDateString("en-US",{timeZone:"America/Los_Angeles",year:"numeric",month:"short",day:"numeric"});
    await expect(date).toHaveText(dateText);
    if (process.env.WIRE_USAGE_PROOFS) await card.screenshot({path:path.join(process.env.WIRE_USAGE_PROOFS,`${frontend}-${width}-usage-dated.png`)});
    if(width<500) await date.tap();else await date.press("Enter");
    const panel=page.locator(".trends-panel[data-family=usage]");
    await expect(panel).toContainText("200,000 tokens");
    await expect(panel).toContainText("1 of 2 interactions metered");
    await expect(panel.getByRole("button",{name:"View 2 calls"})).toBeVisible();
    await panel.getByRole("button",{name:"View daily values",exact:true}).click();
    await expect(page.getByRole("dialog").getByRole("row").filter({hasText:dateText})).toContainText("200,000 tokens");
    await page.keyboard.press("Escape"); await page.getByRole("button",{name:"Back to Analyze"}).click();
    await expect(date).toBeFocused();
    const models=page.locator('[data-percentage-card="models"]');
    await models.getByRole("button",{name:"Token share",exact:true}).click();
    const row=models.locator(".usage-model");
    await expect(row).toHaveCount(1);
    await expect(row.locator(".percentage-value")).toHaveText("200,000 tokens");
    await expect(row.locator(".percentage-bar-track")).toHaveCount(0);
    await expect(models).not.toContainText("interactions metered.");
    await row.getByRole("link").click();
    await expect(page.locator("#activityList article")).toHaveCount(1);
    await expect(page.locator("#activityList article")).toContainText("Review calendar");
});

test("a metered zero is a baseline marker, not an invented column, unknown or empty day",async t=>{
    const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();});
    const {runtime}=await usagePreview({after:f=>cleanup.push(f)},"react",{sparse:true,measuredZero:true});
    const browser=await chromium.launch();cleanup.push(()=>browser.close());
    const page=await browser.newPage();await page.goto(runtime.url);
    const chart=page.locator("#analyzeUsage");
    await chart.getByRole("slider").press("End");await chart.getByRole("slider").press("ArrowLeft");
    await expect(chart.locator(".token-day-value")).toHaveText("0 tokens");
    await expect(chart.locator(".token-zero")).toHaveCount(1);await expect(chart.locator(".token-line")).toHaveCount(0);
    await chart.getByRole("slider").press("ArrowRight");
    await expect(chart.locator(".token-day-value")).toHaveText("Token count unavailable");
});

for(const frontend of ["react","bundled"])test(`${frontend}: daily chart readings cannot obscure a hovered point or clip date labels`,async t=>{
    const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();});
    const {runtime}=await usagePreview({after:f=>cleanup.push(f)},frontend);
    const browser=await chromium.launch();cleanup.push(()=>browser.close());
    const page=await browser.newPage({timezoneId:"UTC",reducedMotion:"reduce"});await page.goto(runtime.url);
    const card=page.locator("#analyzeUsage"),plot=card.locator(".token-history-plot"),slider=plot.getByRole("slider");
    await expect(plot.locator(".token-column")).toHaveCount(4);
    for(const [width,scale] of [[1440,1],[768,1],[390,1],[390,2],[320,1]]) {
        await page.setViewportSize({width,height:955});
        await page.evaluate(s=>{document.documentElement.style.fontSize=`${100*s}%`;},scale);
        await card.evaluate(c=>c.scrollIntoView({block:"center"}));await page.evaluate(()=>document.fonts.ready);
        for(let i=0;i<4;i++){
            const tick=card.locator(".token-history-dates time").nth(i);await tick.scrollIntoViewIfNeeded();
            const point=await plot.locator(".token-column").nth(i).boundingBox(),x=point.x+point.width/2,y=point.y+point.height/2;
            await page.mouse.move(x,y);await expect(slider).toHaveValue(String(i));
            await expect(card.locator(".token-day-reading")).toHaveCSS("opacity","1");
            assert.deepEqual(await card.evaluate((c,{x,y})=>{
                const issues=[],rect=n=>n.getBoundingClientRect(),bounds=rect(c),p=c.querySelector(".token-history-plot");
                const read=c.querySelector(".token-day-reading"),detail=rect(read),target=document.elementFromPoint(x,y);
                if(!p.contains(target) || getComputedStyle(target).cursor!=="default")issues.push("hover blocked or cursor changed");
                if(x>=detail.left-3 && x<=detail.right+3 && y>=detail.top-3 && y<=detail.bottom+3)issues.push("reading covers its hovered point");
                if(Math.hypot(Math.max(0,detail.left-x,x-detail.right),Math.max(0,detail.top-y,y-detail.bottom))>25)issues.push("reading detached from hovered point");
                const glyphs=n=>{const r=document.createRange();r.selectNodeContents(n);return [...r.getClientRects()];};
                const view=rect(c.querySelector(".token-history-scroll"));
                const ticks=[...c.querySelectorAll(".token-history-dates time")].flatMap(glyphs).filter(b=>b.left>=view.left && b.right<=view.right);
                const overlap=(a,b)=>a.left<b.right-.5 && a.right>b.left+.5 && a.top<b.bottom-.5 && a.bottom>b.top+.5;
                if(ticks.some((a,i)=>ticks.slice(i+1).some(b=>overlap(a,b))))issues.push("date labels overlap");
                if([...ticks,...[...c.querySelectorAll(".token-history-scale span")].flatMap(glyphs)].some(b=>overlap(b,detail)))issues.push("tooltip hides scale or dates");
                if(ticks.some(b=>b.left<bounds.left || b.right>bounds.right || b.bottom>bounds.bottom || b.top<bounds.top))issues.push("axis label clipped");
                const text=[...glyphs(read.querySelector(".token-day-value")),...glyphs(read.querySelector(".token-day-date"))];
                if(text.some(b=>b.left<detail.left-1 || b.right>detail.right+1 || b.bottom>detail.bottom+1 || b.top<detail.top-1
                    || b.left<0 || b.right>innerWidth || b.bottom>innerHeight || b.top<0))issues.push("tooltip text clipped");
                return issues;
            },{x,y}),[],`${width}px / ${scale*100}% text / day ${i}`);
        }
        await page.keyboard.press("Escape");await expect(card.locator(".token-day-reading")).toHaveCSS("opacity","0");
        await page.mouse.move(0,0);
    }
});

test("the Analyze time axis names every selected day, including empty dates and dates beyond a full window",async t=>{
    const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();});
    const {runtime}=await usagePreview({after:f=>cleanup.push(f)},"react");
    const browser=await chromium.launch();cleanup.push(()=>browser.close());
    const page=await browser.newPage({viewport:{width:390,height:900},timezoneId:"America/Los_Angeles",hasTouch:true});
    const chart=page.locator("#analyzeUsage"),labels=chart.locator(".token-history-dates time"), slider=chart.getByRole("slider");
    const iso=(from,i)=>new Date(Date.parse(from+"T00:00:00Z")+i*86400000).toISOString().slice(0,10);
    for(const [from,length] of [["2026-09-04",81],["2026-12-30",7],["2024-02-28",3],["2025-03-08",1],["2025-03-08",103]]){
        await page.goto(new URL(`/?range=custom&from=${from}&to=${iso(from,length-1)}`,runtime.url).href);
        const dates=Array.from({length},(_,i)=>iso(from,i));await expect(labels).toHaveCount(Math.min(length,90));
        const read=()=>labels.evaluateAll(nodes=>nodes.map(n=>n.dateTime));
        assert.deepEqual(await read(),dates.slice(0,90));
        if(length>90){
            await chart.getByRole("button",{name:"Later days"}).click();assert.deepEqual(await read(),dates.slice(90));
            await chart.getByRole("button",{name:"Earlier days"}).click();assert.deepEqual(await read(),dates.slice(0,90));
        }
        await slider.press("End");await expect(slider).toHaveValue(String(length-1));
        await expect(labels.last()).toBeInViewport();
        await slider.press("Home");await expect(labels.first()).toBeInViewport();
        assert.ok(await chart.evaluate(c=>c.scrollWidth<=c.clientWidth+1));
        await slider.press("Escape");await expect(chart.locator(".token-day-reading")).toHaveCSS("opacity","0");
        await expect(chart).not.toContainText(/interactions measured/);
    }
});

for(const frontend of ["bundled","react"])test(`${frontend}: both Analyze date axes clear real scrollbars and columns retain their dated scale`,async t=>{
    const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();});
    const {runtime}=await usagePreview({after:f=>cleanup.push(f)},frontend,{sparse:true,measuredZero:true});
    const browser=await chromium.launch({channel:process.env.WIRE_FRONTEND_BROWSER,ignoreDefaultArgs:["--hide-scrollbars"],
        args:["--disable-features=OverlayScrollbar,FluentOverlayScrollbar"]});
    cleanup.push(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1440,height:1050},timezoneId:"UTC",reducedMotion:"reduce"});
    await page.goto(runtime.url);await page.evaluate(()=>document.fonts.ready);
    for(const [width,scale] of [[1440,1],[390,1],[768,2]]){
        await page.setViewportSize({width,height:1050});
        await page.evaluate(scale=>{document.documentElement.style.fontSize=`${scale*100}%`;},scale);
        for(const selector of [".token-history-scroll","#chart .dimensional-scroll"]){
            const scroll=page.locator(selector);await scroll.scrollIntoViewIfNeeded();
            for(const fraction of [0,.5,1]){
                await scroll.evaluate((node,fraction)=>{node.scrollLeft=fraction*(node.scrollWidth-node.clientWidth);},fraction);
                const ink=await scroll.evaluate(node=>{
                    const box=node.getBoundingClientRect(),bottom=box.top+node.clientTop+node.clientHeight;
                    const rects=[...node.querySelectorAll(".token-history-dates time,.dimensional-time-labels>*")].flatMap(label=>{
                        const range=document.createRange();range.selectNodeContents(label);
                        return [...range.getClientRects()].filter(rect=>rect.left>=box.left && rect.right<=box.right);
                    });
                    return {count:rects.length,clearance:Math.min(...rects.map(rect=>bottom-rect.bottom)),
                        verticalOverflow:node.scrollHeight-node.clientHeight,
                        horizontalOverflow:node.scrollWidth-node.clientWidth,scrollbar:node.offsetHeight-node.clientHeight};
                });
                assert.ok(ink.count>0,`${selector}: readable dates at ${fraction}`);
                assert.ok(ink.clearance>=8,`${selector}/${width}/${scale}: full date line box clears scroll viewport by ${ink.clearance}px`);
                assert.ok(ink.verticalOverflow<=1,`${selector}: no hidden descenders or unintended vertical scroll`);
                if(width===390){
                    assert.ok(ink.horizontalOverflow>0,"long dates remain horizontally scrollable");
                    if(process.env.WIRE_FRONTEND_BROWSER)assert.ok(ink.scrollbar>0,"qualification uses a non-overlay native scrollbar");
                }
            }
            if(process.env.WIRE_USAGE_PROOFS)await page.locator(selector.startsWith(".token")?"#analyzeUsage":".analyze-chart-main")
                .screenshot({path:path.join(process.env.WIRE_USAGE_PROOFS,`${frontend}-${width}-${scale}-${selector.startsWith(".token")?"tokens":"activity"}-scrollbar.png`)});
        }
        const aligned=await page.locator("#analyzeUsage").evaluate(card=>{
            const baseline=card.querySelector(".token-axis").getBoundingClientRect().top;
            return [...card.querySelectorAll("[data-measured-day]")].map(mark=>{
                const rect=mark.getBoundingClientRect(),label=card.querySelector(`time[datetime="${mark.dataset.measuredDay}"]`).getBoundingClientRect();
                return {centerDifference:Math.abs(rect.left+rect.width/2-label.left-label.width/2),
                    baselineDifference:Math.abs((mark.matches("rect")?rect.bottom:rect.top+rect.height/2)-baseline),
                    zero:mark.classList.contains("token-zero")};
            });
        });
        assert.equal(aligned.length,2,"only measured days have marks; missing days get no invented height");
        assert.equal(aligned.filter(mark=>mark.zero).length,1);
        for(const mark of aligned){assert.ok(mark.centerDifference<1);assert.ok(mark.baselineDifference<1);}
    }
});

for(const frontend of ["react","bundled"])test(`${frontend}: activity hover uses the token reading surface without covering its date axis`,async t=>{
    const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();});
    const {runtime}=await usagePreview({after:f=>cleanup.push(f)},frontend);
    const browser=await chromium.launch();cleanup.push(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1440,height:1050},timezoneId:"UTC",reducedMotion:"reduce"});
    await page.goto(runtime.url);
    const target=page.locator("#chart .time-segment-link[data-segment=success]").nth(2),tip=page.locator("#evidence-tooltip");
    for(const [width,theme,scale] of [[1440,"light",1],[1440,"dark",1],[390,"light",1],[390,"dark",2]]){
        await page.setViewportSize({width,height:1050});await chooseTheme(page,theme);
        await page.evaluate(scale=>{document.documentElement.style.fontSize=`${scale*100}%`;},scale);
        await target.scrollIntoViewIfNeeded();
        const mark=await target.boundingBox(),x=mark.x+mark.width/2,y=mark.y+mark.height/2;
        await page.mouse.move(0,0);await page.mouse.move(x,y);
        await expect(tip).toBeVisible();await expect(tip).toHaveAttribute("data-tone","chart");
        await expect(tip).toContainText("Tool completed: 2 of 3 Work IQ tool calls");
        assert.ok((await tip.textContent()).includes("\n"),"Date and count have separate reading lines");
        const values=await tip.evaluate((node,{x,y})=>{
            const a=getComputedStyle(node),b=getComputedStyle(document.querySelector(".token-day-reading")),box=node.getBoundingClientRect();
            const rects=[...document.querySelectorAll("#chart .dimensional-time-labels")].map(node=>node.getBoundingClientRect());
            const overlap=rect=>rect.left<box.right && rect.right>box.left && rect.top<box.bottom && rect.bottom>box.top;
            const fields=["backgroundColor","color","borderTopColor","borderRadius","fontFamily","fontSize","fontWeight","paddingTop","paddingLeft","boxShadow"];
            return {same:fields.filter(key=>a[key]!==b[key]),axisCovered:rects.some(overlap),
                pointerCovered:x>=box.left && x<=box.right && y>=box.top && y<=box.bottom,
                clipped:box.left<0 || box.right>Math.min(innerWidth,document.documentElement.getBoundingClientRect().width)
                    || box.top<0 || box.bottom>innerHeight,
                detached:Math.hypot(Math.max(0,box.left-x,x-box.right),Math.max(0,box.top-y,y-box.bottom))>30};
        },{x,y});
        assert.deepEqual(values,{same:[],axisCovered:false,pointerCovered:false,clipped:false,detached:false});
        if(process.env.WIRE_USAGE_PROOFS)await page.screenshot({path:path.join(process.env.WIRE_USAGE_PROOFS,`${frontend}-${width}-${theme}-chart-hover.png`)});
        await page.keyboard.press("Escape");await expect(tip).toBeHidden();
    }
});

for(const frontend of ["react","bundled"])test(`${frontend}: tapping a scrolled day keeps the touched date and scroll position`,async t=>{
    const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();});
    const {runtime}=await usagePreview({after:f=>cleanup.push(f)},frontend);
    const browser=await chromium.launch();cleanup.push(()=>browser.close());
    const page=await browser.newPage({viewport:{width:390,height:900},hasTouch:true,timezoneId:"UTC"});
    await page.goto(new URL("/?range=custom&from=2026-08-20&to=2026-11-24",runtime.url).href);
    const chart=page.locator("#analyzeUsage"),slider=chart.getByRole("slider"),scroll=chart.locator(".token-history-scroll");
    const offset=()=>scroll.evaluate(s=>s.scrollLeft);
    await expect(slider).toHaveAttribute("max","96");await slider.press("End");
    for(const [date,index] of [["2026-11-21",93],["2026-10-14",55]]){
        if(index===55){await slider.press("End");await chart.getByRole("button",{name:"Earlier days"}).tap();}
        await slider.press("Escape");
        await expect(chart.locator(".token-day-reading")).toHaveAttribute("aria-hidden","true");
        const tick=chart.locator(`time[datetime="${date}"]`);
        await tick.evaluate(t=>t.scrollIntoView({block:"center",inline:"center"}));
        const before=await offset(),label=await tick.boundingBox(),plot=await slider.boundingBox();
        const x=label.x+label.width/2,y=plot.y+plot.height/2;
        await page.touchscreen.tap(x,y);
        await expect(slider).toHaveValue(String(index));
        await expect(chart.locator(".token-day-date")).toHaveText(new Date(date+"T12:00Z").toLocaleDateString("en-US",{dateStyle:"medium",timeZone:"UTC"}));
        assert.equal(await offset(),before,"a tap must not move the date strip");
        const fold=page.locator("#analyzeCollapse-usage");
        await fold.tap();await expect(slider).not.toBeVisible();
        await fold.tap();await expect(slider).toBeVisible();
        await expect(slider).toHaveValue(String(index));
        assert.equal(await offset(),before,"collapse and expand preserve the paged chart's horizontal position");
        await tick.evaluate(t=>t.scrollIntoView({block:"center",inline:"nearest"}));
        if(index===55){
            const restoredLabel=await tick.boundingBox(),restoredPlot=await slider.boundingBox();
            const x=restoredLabel.x+restoredLabel.width/2,y=restoredPlot.y+restoredPlot.height/2;
            const session=await page.context().newCDPSession(page);
            const touch=(type,points)=>session.send("Input.dispatchTouchEvent",{type,touchPoints:points});
            await touch("touchStart",[{x,y}]);
            for(const delta of [15,40,70,100])await touch("touchMove",[{x:x-delta,y}]);
            await touch("touchEnd",[]);await session.detach();
            await expect.poll(offset).toBeGreaterThan(before+30);
            await expect(slider).toHaveValue(String(index));
            await expect(chart.locator(".token-day-reading")).toHaveAttribute("aria-hidden","true");
        }
    }
});

for (const [frontend,width] of [["react",1360],["bundled",390]]) test(`${frontend}: Most tokens reorders the same cards and both Analyze defaults survive reopening`,async t=>{
    const cleanup=[]; t.after(async()=>{for(const close of cleanup.reverse()) await close();});
    const {runtime}=await usagePreview({after:f=>cleanup.push(f)},frontend,{paginated:true});
    const browser=await chromium.launch(); cleanup.push(()=>browser.close());
    const context=await browser.newContext({viewport:{width,height:900},timezoneId:"UTC",reducedMotion:"reduce",hasTouch:width===390});
    const settings=await context.newPage();
    await settings.goto(new URL("/settings?section=analyze",runtime.url).href);
    await expect(settings.locator("#defaultAnalyzeSort-control")).toHaveText("Most recent");
    await settings.locator("#analyzeLayout").getByRole("button",{name:"Move Interactions up",exact:true}).click();
    const day=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);
    const page=await context.newPage();
    await page.goto(new URL(`/?range=custom&from=${day(4)}&to=${day(1)}`,runtime.url).href);
    await expect(page.locator("#activityList article")).toHaveCount(8);
    await openAnalyzeFilters(page);
    await selectActivityOption(page,"promptAuthorFilter",["user"]); await closeAnalyzeFilters(page);
    const prompts=p=>p.locator("#activityList article .request-card-prompt");
    const recent=["Read project brief","Search for notes","Find review owners","Launch notes"];
    const byTokens=["Find review owners","Launch notes","Read project brief","Search for notes"];
    const layout=p=>p.locator(".analyze-chart-main:visible,.analyze-outcome-summary:visible,#analyzeUsage:visible,#activityView:visible,.percentage-card[data-breakdown]:not([data-breakdown=outcomes]):visible")
        .evaluateAll(nodes=>nodes.map(n=>({key:n.id || n.dataset.breakdown || n.className,x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y}))
            .sort((a,b)=>a.y-b.y || a.x-b.x).map(n=>n.key));
    await expect(prompts(page)).toHaveText(recent);
    const initialLayout=await layout(page), scope=page.url(), summary=await page.locator("#activityListSummary").innerText();
    const listControl=page.locator("#activityUsageSort-control");
    for (const [label,order] of [["Most tokens",byTokens],["Most recent",recent]]) {
        if (width===390) await listControl.tap(); else await listControl.press("Enter");
        const option=page.getByRole("option",{name:label,exact:true});
        if (width===390) await option.tap();
        else {
            await listControl.press(label==="Most tokens"?"ArrowDown":"ArrowUp");
            await expect(option).toHaveAttribute("data-active","true");
            await listControl.press("Enter");
        }
        await expect(listControl).toHaveText(label);
        await expect(prompts(page)).toHaveText(order);
        if (label==="Most tokens") await expect(page.locator("#activityList article .usage-chip")).toHaveText(["33,000","30,000","12,000","Unavailable"]);
        assert.equal(page.url(),scope); assert.equal(await page.locator("#activityListSummary").innerText(),summary);
        await expect(page.locator("#analyzeUsage").getByRole("slider")).toHaveAccessibleDescription("75,000 tokens in this period. 3 of 4 interactions measured.");
        assert.deepEqual(await layout(page),initialLayout);
    }
    const allRecent=["Read project brief","Draft next steps","Search for notes","Meeting outline","Consolidate changes","Find review owners","Follow-up summary","Launch notes"];
    const allTokens=["Earlier planning","Draft next steps","Consolidate changes","Follow-up summary","Find review owners","Meeting outline","Launch notes","Read project brief"];
    for (const [choice,label,order,override] of [["tokens","Most tokens",allTokens,"recent"],["recent","Most recent",allRecent,"tokens"]]) {
        await selectActivityOption(settings,"defaultAnalyzeSort",choice);
        await settings.getByRole("link",{name:"View Analyze",exact:true}).click();
        await expect(prompts(settings)).toHaveText(order);
        await expect(settings.locator("#activityUsageSort-control")).toHaveText(label);
        await navigateMain(settings,"settings"); await navigateSettings(settings,"analyze");
        await settings.reload();
        await expect(settings.locator("#defaultAnalyzeSort-control")).toHaveText(label);
        const fresh=await context.newPage(); await fresh.goto(runtime.url);
        await expect(fresh.locator("#activityUsageSort-control")).toHaveText(label);
        await expect(prompts(fresh)).toHaveText(order);
        const pager=fresh.getByRole("navigation",{name:"Analyze result pages"});
        await pager.getByRole("button",{name:"Next",exact:true}).click();
        await expect(prompts(fresh)).toHaveText([choice==="recent"?"Earlier planning":"Search for notes"]);
        await selectActivityOption(fresh,"activityUsageSort",override);
        await expect(prompts(fresh)).toHaveText(override==="recent"?allRecent:allTokens);
        await expect(pager).toContainText("1-8 of 9");
        await fresh.reload();
        await expect(prompts(fresh)).toHaveText(order);
        await expect(fresh.locator("#activityUsageSort-control")).toHaveText(label);
        await fresh.close();
        await expect(listControl).toHaveText("Most recent");
        await expect(prompts(page)).toHaveText(recent);
    }
});

for (const [frontend,width] of [["react",1360],["bundled",390]]) test(`${frontend}: scoped usage questions from homepage to frozen report (${width}px)`, async t => {
    const cleanups=[]; t.after(async()=>{ for (const close of cleanups.reverse()) await close(); });
    const {runtime} = await usagePreview({after:f=>cleanups.push(f)},frontend);
    const browser=await chromium.launch(); cleanups.push(()=>browser.close());
    const context=await browser.newContext({viewport:{width,height:900},timezoneId:"UTC",reducedMotion:"reduce",hasTouch:width<500});
    const page=await context.newPage(), errors=[];
    page.on("pageerror",e=>errors.push(e.message)); page.setDefaultTimeout(8000);
    const capture=async(name, target) => {
        if (!process.env.WIRE_USAGE_PROOFS) return;
        await target.scrollIntoViewIfNeeded(); await page.evaluate(()=>document.fonts.ready);
        await page.screenshot({path:path.join(process.env.WIRE_USAGE_PROOFS,`${frontend}-${width}-${name}.png`)});
    };
    await page.goto(runtime.url);
    const widget=page.locator("#analyzeUsage");
    if (width < 500) await chooseTheme(page,"dark");
    await expect(widget.getByRole("slider")).toHaveAccessibleDescription("342,000 tokens in this period. 7 of 8 interactions measured.");
    await expect(widget.locator(".token-column")).toHaveCount(4);
    await expect(widget.locator(".token-line")).toHaveCount(0);
    await widget.getByRole("slider").press("End");await expect(widget.locator(".token-day-value")).toContainText("104,500 tokens");
    await widget.getByRole("slider").press("ArrowLeft");await expect(widget.locator(".token-day-value")).toHaveText("30,500 tokens (partial)");
    await widget.getByRole("slider").press("Escape");
    await page.locator("#analyzeUsageTitle").click();
    if (process.env.WIRE_USAGE_PROOFS) await widget.screenshot({path:path.join(process.env.WIRE_USAGE_PROOFS,`${frontend}-${width}-simple-line.png`)});
    await expect(widget).not.toContainText(/cost|price|\$/i);
    await capture("home",widget);
    const models=page.locator('[data-percentage-card="models"]');
    const modelName = "claude-sonnet-5-5", rows = page.locator("#activityList article");
    const idsFor = async titles => Promise.all(titles.map(title=>rows.filter({has:page.getByText(title,{exact:true})}).getAttribute("data-view-key")));
    const measuredIds = await idsFor(["Consolidate changes","Launch notes"]), [unmeteredId] = await idsFor(["Search for notes"]);
    const interactions=models.getByRole("button",{name:"Interactions",exact:true});
    const shares=models.getByRole("button",{name:"Token share",exact:true});
    await expect(interactions).toHaveAttribute("aria-pressed","true");
    await expect(interactions).toHaveCSS("text-decoration-line","none");
    const widthBefore=(await interactions.boundingBox()).width;
    await shares.focus(); await shares.press("Space"); await expect(shares).toBeFocused();
    await expect(shares).toHaveAttribute("aria-pressed","true");
    await expect(shares).toHaveCSS("text-decoration-line","none");
    await expect(interactions).toHaveAttribute("aria-pressed","false");
    assert.equal((await interactions.boundingBox()).width,widthBefore);
    const readings = models.locator(".usage-model");
    await expect(readings).toHaveCount(4);
    await page.setViewportSize({width:1800,height:900});
    const first = await readings.nth(0).boundingBox(), second = await readings.nth(1).boundingBox();
    assert.ok(Math.abs(first.y-second.y)<1 && second.x>=first.x+first.width-1, "Wide token readings share a row");
    const totals = await readings.locator(".percentage-value").allTextContents();
    assert.deepEqual(totals,["45% (154,500 tokens)","33% (112,000 tokens)","13% (45,000 tokens)","9% (30,500 tokens)"]);
    await capture("model-shares-paired",models);
    await page.setViewportSize({width:390,height:900});
    const narrow = await readings.evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().y));
    assert.ok(narrow.every((y,i)=>!i || y>narrow[i-1]),"Narrow token readings remain in ranked order");
    await page.setViewportSize({width,height:900});
    const modelDisplay = "Claude Sonnet 5.5";
    const meteredModel = models.getByRole("link",{name:`${modelDisplay} (${modelName}): 33% (112,000 tokens). View 2 metered interactions.`,exact:true});
    await expect(meteredModel).toHaveText(modelDisplay);await expect(meteredModel).toHaveAttribute("data-recorded-model",modelName);
    if (width < 500) await meteredModel.tap(); else await meteredModel.press("Enter");
    await expect(page.locator("#activityListSummary")).toHaveText(`${modelName}: 2 metered interactions`);
    const cardIds = () => rows.evaluateAll(nodes=>nodes.map(n=>n.dataset.viewKey).sort());
    assert.deepEqual(await cardIds(),measuredIds.toSorted());
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription(new RegExp(`Activity list · Metered model: ${modelName}`));
    await page.goBack(); await expect(meteredModel).toBeFocused();
    const modelTrend = models.getByRole("link",{name:"View trend: Tokens by response model"});
    await modelTrend.press("Enter");
    const dailyModels = page.locator('.trends-panel:visible[data-family="usage"]');
    const modelPoints = dailyModels.locator(`[data-trend-mark][data-series="model:${modelName}"]`);
    for (const [ago,tokens,expected,numberOfCalls,parent] of [[4,"30,000","Launch notes",3,measuredIds[1]],[3,"82,000","Consolidate changes",2,measuredIds[0]]]) {
        const date=new Date(Date.now()-ago*86400000).toLocaleDateString("en-US",{timeZone:"UTC",year:"numeric",month:"short",day:"numeric"});
        await modelPoints.and(page.locator(`[aria-label^="${date}:"][aria-label$=", ${tokens} tokens"]`)).press("Enter");
        await dailyModels.getByRole("button",{name:`View ${numberOfCalls} calls`}).click();
        await expect(page.locator(".trends-evidence-row .trends-evidence-context")).toHaveText(Array(numberOfCalls).fill(expected));
        await page.locator(".trends-evidence-row a").first().click();
        await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key",parent); await page.goBack();
        await expect(page.locator("#contextSidebar")).not.toBeVisible();
        if (await page.locator(".trends-dialog[open]").count()) await page.keyboard.press("Escape");
    }
    await page.getByRole("button",{name:"Back to Analyze"}).click(); await expect(modelTrend).toBeFocused();
    await expect(shares).toHaveAttribute("aria-pressed","true");
    if (width < 500) await interactions.tap(); else await interactions.click();
    await expect(interactions).toHaveAttribute("aria-pressed","true");
    await capture("model-selector",models);
    const modelRow = models.locator(`[data-category="${modelName}"] .percentage-label`);
    await expect(modelRow).toHaveText(modelDisplay);
    const filterButton = page.locator("#openAnalyzeFilters"), chips = page.locator("#filterChips");
    const clearModel = chips.getByRole("button",{name:`Remove Activity list · Model: ${modelName}`,exact:true});
    await modelRow.click(); await expect(rows).toHaveCount(3);
    assert.deepEqual(await cardIds(),[...measuredIds,unmeteredId].sort());
    await expect(filterButton).toHaveText("1 filter applied");
    await expect(filterButton).toHaveAccessibleDescription(/Activity list · Model: claude-sonnet-5-5/);
    await openAnalyzeFilters(page); await expect(clearModel).toBeVisible();
    await capture("model-filter",clearModel);
    await selectActivityOption(page,"toolFilter","workiq-fetch"); await closeAnalyzeFilters(page);
    await expect(rows).toHaveCount(1); await expect(rows.first()).toContainText("Launch notes");
    await expect(filterButton).toHaveText("2 filters applied");
    await openAnalyzeFilters(page); await clearModel.press("Enter");
    await expect(clearModel).toHaveCount(0); await expect(chips).toContainText("workiq-fetch");
    await closeAnalyzeFilters(page); await expect(rows).toHaveCount(4); await expect(filterButton).toHaveText("1 filter applied");
    await shares.click();
    const scopedModel = models.getByRole("link",{name:`${modelDisplay} (${modelName}): 15% (30,000 tokens). View 1 metered interaction.`,exact:true});
    await scopedModel.click();
    await expect(page.locator("#activityListSummary")).toHaveText(`${modelName}: 1 metered interaction`);
    assert.deepEqual(await cardIds(),[measuredIds[1]]);
    await page.goBack(); await expect(scopedModel).toBeFocused();
    await interactions.click();
    await modelRow.click(); await expect(rows).toHaveCount(1);
    await rows.first().locator(".request-card-open").first().click(); await page.goBack();
    await expect(rows).toHaveCount(1); await openAnalyzeFilters(page); await expect(clearModel).toBeVisible();
    await page.locator("#resetView").click(); await closeAnalyzeFilters(page);
    await expect(rows).toHaveCount(8); await expect(filterButton).toHaveText("Filters");
    assert.ok(!page.url().includes(modelName));
    const day=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);
    await page.goto(new URL(`/?range=custom&from=${day(2)}&to=${day(2)}`,runtime.url).href);
    await expect(widget.getByRole("slider")).toHaveAccessibleDescription("30,500 tokens in this period. 1 of 2 interactions measured.");
    await widget.getByRole("link",{name:/View by day/}).click();
    const periodUsage = page.locator(".trends-panel[data-family=usage]");
    await expect(periodUsage).toContainText("30,500 tokens");
    await expect(periodUsage.locator(".trends-plot svg")).toBeVisible();
    await page.goto(runtime.url);
    await expect(widget.getByRole("slider")).toHaveAccessibleDescription(/342,000 tokens/);
    await page.goto(new URL("/settings?section=analyze",runtime.url).href);
    await selectActivityOption(page,"defaultAnalyzeSort","tokens");
    await selectActivityOption(page,"defaultAnalyzeRange","7");
    await page.getByRole("link",{name:"View Analyze",exact:true}).click();
    const cards=page.locator("#activityList article");
    await expect(cards.first()).toContainText("Draft next steps");
    await selectActivityOption(page,"activityUsageSort","recent");
    const missing=cards.filter({hasText:"Search for notes"});
    await expect(missing.locator(".usage-chip")).toHaveText("Unavailable");
    await missing.locator(".request-card-open").first().click();
    const missingJump=page.getByRole("navigation",{name:"In this interaction"}).getByRole("button",{name:"Tokens",exact:true});
    await missingJump.scrollIntoViewIfNeeded();await missingJump.click();
    await expect(page.locator("[data-reader-section=usage] h2")).toBeFocused();
    await expect(page.locator("[data-reader-section=usage]")).toContainText("No token counts matched this prompt's model calls.");
    const tokenReader=page.locator("[data-reader-section=usage]");
    await expect(tokenReader.locator(".usage-timeline li").filter({hasText:"Call #1"})).toContainText("1,028 bytes (~257 tokens) of returned text");
    async function callDetails(ordinal) {
        const call=page.locator("[data-reader-section=activity] .reader-call-row").filter({has:page.locator(".reader-entry-label",{hasText:`Call #${ordinal}`})});
        const toggle=call.locator(".reader-call-toggle");
        if (await toggle.getAttribute("aria-expanded")!=="true") await toggle.press("Enter");
        return call.locator(".technical-detail");
    }
    const failedCall=await callDetails(2);
    await expect(failedCall).toContainText("11 input");
    await expect(failedCall).toContainText("output not recorded");
    await expect(failedCall).toContainText("Size unavailable");
    await page.keyboard.press("Escape"); await expect(missing.locator(".request-card-open").first()).toBeFocused();
    await expect(page.locator("#activityUsageSort")).toHaveValue("recent");
    await page.reload(); await expect(cards.first()).toContainText("Draft next steps");
    const outline=cards.filter({hasText:"Meeting outline"});
    await expect(outline.locator(".usage-chip")).toHaveText("30,500");
    const usageLink=outline.locator(".card-reading-details .usage-chip");
    await usageLink.scrollIntoViewIfNeeded();await page.mouse.move(0,0);
    await usageLink.hover();await expect(page.getByRole("tooltip")).toContainText("model requests");
    await page.keyboard.press("Escape");await page.mouse.move(0,0);
    await usageLink.press("Tab");await page.keyboard.press("Shift+Tab");
    await expect(usageLink).toBeFocused();await expect(page.getByRole("tooltip")).toContainText("model requests");
    await usageLink.press("Enter");
    const reader=page.locator("[data-reader-section=usage]");
    await expect(reader.locator("h2")).toBeFocused();
    await expect(reader).toContainText("30,500 tokens"); await expect(reader).toContainText("preview-model");
    await capture("reader-tokens",reader);
    await page.keyboard.press("Escape");
    await expect(usageLink).toBeFocused();
    const direct = cards.filter({hasText:"Find review owners"}).locator(".request-card-open").first();
    await direct.click(); await expect(reader.locator(".usage-timeline li").filter({hasText:"workiq-retrieve"})).toContainText("34,000 bytes (~8,500 tokens) of returned text");
    await expect(reader.locator(".usage-context")).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(direct).toBeFocused();
    const launchOpen=cards.filter({hasText:"Launch notes"}).locator(".request-card-open").first();
    await launchOpen.click();
    await expect(reader).toContainText("30,000 tokens · 2 model calls");
    const fetchDetails=await callDetails(2);
    await expect(fetchDetails).toContainText("27 tokens");
    await expect(fetchDetails).toContainText("0 input");
    await expect(fetchDetails).toContainText("27 output");
    await expect(fetchDetails).toContainText("~4,000 tokens");
    await capture("call-tokens",fetchDetails);
    const repeat=await callDetails(3);
    await expect(repeat).toContainText("No verified count for this call");
    await expect(repeat).toContainText("~1,000 tokens");
    await expect(repeat).not.toContainText(/30,000|27 output/);
    await page.keyboard.press("Escape"); await expect(launchOpen).toBeFocused();
    await widget.getByRole("link",{name:/View by day/}).press("Enter");
    const panel=page.locator(".trends-panel[data-family=usage]");
    await expect(panel).toContainText("342,000 tokens");
    await selectActivityOption(page,"trendsUsagequestion","author");
    await expect(panel.locator(".trends-legend-row").filter({hasText:"Human"})).toContainText("75,000 tokens");
    await expect(panel.locator(".trends-legend-row").filter({hasText:"Agent"})).toContainText("236,500 tokens");
    await expect(panel.locator(".trends-legend-row").filter({hasText:"Sender unclear"})).toContainText("30,500 tokens");
    await capture("trends-author", panel.locator(".trends-plot"));
    await selectActivityOption(page,"trendsUsagequestion","tool");
    await expect(panel).toContainText("330,000 tokens"); await expect(panel).toContainText("1 without a token count");
    await panel.getByRole("button",{name:"View daily values",exact:true}).click();
    const toolRow=page.getByRole("table",{name:"Usage in the entire period"}).getByRole("row",{name:/workiq-fetch/});
    await expect(toolRow).toContainText("184,500"); await expect(toolRow).toContainText("~27,500 tokens (4 / 4 calls)");
    await page.keyboard.press("Escape");
    await selectActivityOption(page,"trendsUsagethreshold","60000");
    await expect(panel).toContainText("236,500 tokens");
    await selectActivityOption(page,"trendsUsagequestion","model");
    await expect(panel.locator(".trends-legend-row").filter({hasText:"claude-opus-5-5"})).toContainText("154,500 tokens");
    await page.getByRole("button",{name:"Back to Analyze"}).click();
    await expect(widget.getByRole("link",{name:/View by day/})).toBeFocused();
    assert.equal(new URL(page.url()).search,"");
    await page.goto(new URL(`/compare?aFrom=${day(4)}&aTo=${day(3)}&bFrom=${day(2)}&bTo=${day(1)}`,runtime.url).href);
    await selectActivityOption(page,"compareUsagequestion","author");
    const compared=page.getByRole("table",{name:"Recorded tokens by group"}).getByRole("row",{name:/Human/});
    await expect(compared).toContainText("63,000"); await expect(compared).toContainText("12,000");
    await capture("compare-author",compared);
    await expect(page.locator(".compare-usage")).not.toContainText(/cost|price|\$/i);
    const paired=page.waitForResponse(r=>r.url().endsWith("/api/preview"));
    await page.locator("#createPeriodReport").click();
    const pairedResponse=await paired, pair=await pairedResponse.json();
    assert.equal(pairedResponse.status(),200,pair.error);
    assert.equal(pair.snapshot.usageFacts.cohorts.baseline.groups.find(g=>g.label==="Human").total,63000);
    assert.equal(pair.snapshot.usageFacts.cohorts.later.groups.find(g=>g.label==="Human").total,12000);
    await page.goto(new URL("/reports",runtime.url).href);
    await page.locator("#reportCustomSetup").click();
    await selectActivityOption(page,"reportUsagequestion","tool");
    await selectActivityOption(page,"reportUsagethreshold","60000");
    await selectActivityOption(page,"reportUsageauthor","agent");
    await selectActivityOption(page,"reportUsagetool","workiq-fetch");
    await page.getByRole("button",{name:"View in Trends",exact:true}).click();
    await expect(panel).toContainText("154,500 tokens · 2 of 2 interactions metered");
    assert.doesNotMatch(page.url(),/agent|fetch|60000/);
    const prepared=page.waitForResponse(r=>r.url().endsWith("/api/preview"));
    await panel.getByRole("button",{name:"Preview this report"}).click();
    const response=await prepared, result=await response.json();
    assert.equal(response.status(),200,result.error);
    const facts=result.snapshot.usageFacts.cohorts.selected;
    assert.equal(result.snapshot.records.length,2); assert.equal(facts.total,154500);
    assert.doesNotMatch(JSON.stringify(result.snapshot),/Search for notes|Find review owners|Launch notes/);
    assert.deepEqual(facts.groups.map(g=>[g.label,g.total]),[["workiq-fetch",154500],["workiq-ask",92500]]);
    await expect(page.getByRole("button",{name:"Save report",exact:true})).toBeEnabled();
    await capture("report",page.getByRole("button",{name:"Save report",exact:true}));
    const updated = page.waitForResponse(r=>r.url().endsWith("/api/preview"));
    await clickReportOption(page, "Change what's included");
    await page.locator("#usageRows").check();
    const tokenOnly = await (await updated).json();
    assert.deepEqual(tokenOnly.snapshot.records.map(r=>r.scenarioId), result.snapshot.records.map(r=>r.scenarioId));
    assert.deepEqual(tokenOnly.snapshot.usageFacts.cohorts.selected.rows.map(r=>r.total),[92500,62000]);
    assert.doesNotMatch(JSON.stringify(tokenOnly.snapshot.usageFacts),/"usd"|"pricing"|"priced"/);
    await page.keyboard.press("Escape");
    await page.getByRole("button",{name:"Save report",exact:true}).click();
    await page.getByRole("button",{name:"Open saved report",exact:true}).click();
    await expect(page.locator("#savedReportReader")).toContainText("Tools in high-usage interactions");
    await expect(page.locator("#savedReportReader .saved-brief")).toContainText("154,500 tokens");
    await selectActivityOption(page,"savedReaderFormat","document");
    const content = page.frameLocator("#savedReportReader iframe").locator("#usage-selected");
    await expect(content).toContainText("154,500 tokens"); await expect(content).not.toContainText("Est. USD");
    await capture("saved-reading",page.locator("#savedReportReader iframe"));
    const home = await context.newPage(); await home.goto(runtime.url);
    await expect(home.locator("#analyzeUsageContent").getByRole("slider")).toHaveAccessibleDescription(/342,000 tokens/);
    if (!await home.locator("#wireAccountTrigger").isVisible()) await home.locator("#navigationToggle").click();
    await home.locator("#wireAccountTrigger").click();
    await expect(home.locator("#wireAccountGate")).toHaveText("Sign out of this instance");
    await home.locator("#wireAccountGate").click();
    await expect(home.locator("#analyzeUsageContent")).toBeEmpty();
    await expect(page.locator("#savedReportReader iframe")).toHaveCount(0);
    assert.deepEqual(errors,[]);
});

test("normal React entry exposes exact interaction tokens, scoped shares, reader and Trends", async t => {
    const cleanup=[]; t.after(async()=>{for(const close of cleanup.reverse()) await close();});
    const {runtime}=await usagePreview({after:f=>cleanup.push(f)});
    const browser=await chromium.launch();cleanup.push(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1320,height:900},timezoneId:"UTC"}), errors=[];
    page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(7500);
    await page.goto(runtime.url);
    const cards=page.locator("#activityList article");
    await expect(cards).toHaveCount(8); await expect(page.locator(".usage-chip:not(.usage-missing)")).toHaveCount(7);
    await selectActivityOption(page,"activityUsageSort","tokens");
    await expect(cards.first()).toContainText("Draft next steps");await expect(cards.last()).toContainText("Search for notes");
    await expect(cards.filter({hasText:"Find review owners"}).getByRole("link",{name:"Model tokens: 33,000. Show token details"})).toHaveText("33,000");
    await page.getByRole("button",{name:"Token share",exact:true}).click();
    await expect(page.locator(".usage-model").first()).toBeVisible();
    await expect(page.locator('.usage-model [data-recorded-model="gpt-6.2-sol"]')).toHaveText("GPT-6.2 Sol");
    const receiptLink=cards.filter({hasText:"Find review owners"}).getByRole("link",{name:/^Model tokens:/});
    await receiptLink.click();
    await expect(page.locator('.usage-timeline [data-recorded-model="gpt-6.2-sol"]')).toHaveText("GPT-6.2 Sol");
    await page.keyboard.press("Escape");await expect(receiptLink).toBeFocused();
    const unsized=cards.filter({hasText:"Read project brief"}).locator(".request-card-open").first();
    await unsized.click();
    await expect(page.locator("[data-reader-section=activity]")).toContainText("2 returned entries");
    const usage=page.locator("[data-reader-section=usage]");
    await expect(usage).toContainText("12,000 tokens");
    await expect(usage).toContainText("No returned-text size was saved for this interaction.");
    await page.keyboard.press("Escape");await expect(unsized).toBeFocused();
    const partial=cards.filter({hasText:"Search for notes"}).locator(".request-card-open").first();
    await partial.click();
    await expect(usage).toContainText("1,028 bytes (~257 tokens) of text. Measured for 1 of 2 calls.");
    await expect(page.locator("[data-reader-section=activity]")).toContainText("1004: Work IQ took too long to respond");
    await page.keyboard.press("Escape");await expect(partial).toBeFocused();
    await expect(page.locator("[data-percentage-card=models]").getByRole("list",{name:"Model token counts from 7 of 8 matching interactions"})).toBeVisible();
    const launch=cards.filter({hasText:"Launch notes"}), open=launch.locator(".request-card-open").first();
    await open.click();const reading=page.locator("[data-reader-section=usage]");
    await expect(reading).toContainText("30,000 tokens · 2 model calls");
    await expect(reading).toContainText("Work IQ returned 48,000 bytes (~12,000 tokens) of text");
    await expect(reading.locator(".usage-timeline li")).toHaveCount(5);
    await chooseTheme(page, "dark");
    await expect(reading.getByRole("row",{name:"Generated output 2,000"})).toBeVisible();
    await page.setViewportSize({width:390,height:844});await page.keyboard.press("Escape");await expect(open).toBeFocused();
    await launch.getByRole("button",{name:"Hide",exact:true}).click();
    await expect(cards).toHaveCount(7);
    await page.getByRole("button",{name:"Hidden cards (1)"}).click();
    await page.getByRole("dialog",{name:"Hidden cards"}).getByRole("button",{name:"Restore",exact:true}).click();
    await expect(launch.locator(".usage-chip")).toHaveText("30,000");
    await page.goto(new URL("/settings?section=reports",runtime.url).href);
    await expect(page.locator("#costRateReference")).toHaveCount(0);
    await page.goto(new URL("/trends?section=charts",runtime.url).href);
    await page.getByRole("navigation",{name:"Trend measures"}).getByRole("button",{name:"Token usage",exact:true}).click();
    const panel=page.locator('.trends-panel[data-family="usage"]');
    await expect(panel).toContainText("7 of 8 interactions metered");
    await expect(panel).toContainText("342,000 tokens");
    await panel.getByRole("button",{name:"Compare measures",exact:true}).click();
    await expect(page.locator(".trends-panel-pair")).toContainText("Token usage");
    await page.goto(new URL("/compare",runtime.url).href);
    await expect(page.getByRole("table",{name:"Whole interactions with matching records"})).toContainText("342,000");
    await expect(page.getByRole("table",{name:"Tokens by model"})).toContainText("claude-opus-5-5");
    await page.setViewportSize({width:1320,height:900});
    const day=daysAgo=>new Date(Date.now()-daysAgo*86400000).toISOString().slice(0,10);
    await page.goto(new URL(`/compare?aFrom=${day(4)}&aTo=${day(3)}&bFrom=${day(2)}&bTo=${day(1)}`,runtime.url).href);
    const usageTable=page.getByRole("table",{name:"Whole interactions with matching records"});
    await expect(usageTable.getByRole("row",{name:/Metered tokens/})).toContainText("207,000");
    await expect(usageTable.getByRole("row",{name:/Metered tokens/})).toContainText("135,000");
    const tracks=await page.locator(".compare-changes .compare-period-readings,.compare-usage table").evaluateAll(tables=>
        tables.map(t=>[...t.tBodies[0].rows[0].cells].map(c=>{const b=c.getBoundingClientRect();return b.left+b.width/2;})));
    assert.equal(tracks.length,3);
    for(const centers of tracks.slice(1)) assert.ok(centers.every((x,i)=>Math.abs(x-tracks[0][i])<1),"All Compare readings use the same column centers");
    await page.setViewportSize({width:390,height:844});
    const narrow=await usageTable.locator("tbody tr").first().evaluate(row=>[...row.cells].map(c=>c.getBoundingClientRect().top));
    assert.ok(narrow[0]<narrow[1] && narrow[1]===narrow[2] && narrow[2]<narrow[3],"Row label, period pair, then change");
    await page.setViewportSize({width:1320,height:900});
    await page.goto(new URL("/reports",runtime.url).href);
    const prepare = async action => {
        const result=page.waitForResponse(r=>r.url().endsWith("/api/preview"));
        await action(); const response=await result, value=await response.json();
        assert.equal(response.status(),200,value.error);
        await expect(page.getByRole("button",{name:"Save report",exact:true})).toBeEnabled();
        return value;
    };
    const initial=await prepare(()=>prepareLandingReport(page,"all"));
    assert.equal(initial.snapshot.usageFacts.cohorts.selected.total,342000);
    await clickReportOption(page, "Change what's included");
    await expect(page.locator("#usageRows")).not.toBeChecked();
    const withoutTokens=await prepare(()=>page.locator("#usageTokens").uncheck());
    assert.equal(withoutTokens.snapshot.usageFacts,undefined);
    assert.deepEqual(errors,[]);
});

test("save the same single interaction total seen on its card and reader", async t => {
    const cleanup=[]; t.after(async()=>{for(const close of cleanup.reverse()) await close();});
    const {runtime}=await usagePreview({after:f=>cleanup.push(f)});
    const browser=await chromium.launch(); cleanup.push(()=>browser.close());
    const page=await browser.newPage(); await page.goto(runtime.url);
    const card=page.locator("#activityList article").filter({hasText:"Launch notes"});
    await expect(card.locator(".usage-chip")).toHaveText("30,000");
    await card.locator(".request-card-open").first().click();
    await expect(page.locator("[data-reader-section=usage]")).toContainText("30,000 tokens · 2 model calls");
    await page.keyboard.press("Escape"); await expect(card.locator(".request-card-open").first()).toBeFocused();
    await card.getByRole("button",{name:"Add to report",exact:true}).click();
    const picker=page.getByRole("dialog",{name:"Report drafts",exact:true});
    await picker.getByRole("button",{name:"New draft",exact:true}).click();
    await picker.getByLabel("Draft name").fill("Launch notes review");
    await picker.getByRole("button",{name:"Create draft and add"}).click();
    await expect(card.locator(".report-draft-trigger")).toContainText("Launch notes review");
    await navigateMain(page,"reports");
    await page.locator("#reportDraftsPanel").getByRole("button",{name:/^Launch notes review\b/}).click();
    const read=page.waitForResponse(r=>r.url().endsWith("/api/preview"));
    await page.locator("#prepareReportPreview").click();
    const snapshot=(await (await read).json()).snapshot;
    assert.deepEqual([snapshot.records.length,snapshot.usageFacts.cohorts.selected.eligible,snapshot.usageFacts.cohorts.selected.total],[1,1,30000]);
    await page.getByRole("button",{name:"Save report",exact:true}).click();
    await page.getByRole("button",{name:"Open saved report",exact:true}).click();
    await expect(page.locator("#savedReportReader .saved-brief")).toContainText("30,000 tokens across 1 interaction");
});
