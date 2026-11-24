import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { frontendRecords } from "./frontend-fixture.mjs";
import { chooseTheme, fulfillFixtureUpdateStatus } from "./helpers.mjs";
import { palettes } from "../web/theme.mjs";

const proof = process.env.WIRE_ANALYZE_HOMEPAGE_PROOFS;
async function setup(t, frontend = "react", options = {}) {
    const records = frontendRecords(12);
    const cleanups = [], errors = [], snapshots = [];
    let browser;
    t.after(async () => {
        // Disconnect the client before asking its runtime to drain.
        try { await browser?.close(); }
        finally { for (const cleanup of cleanups) await cleanup(); }
        assert.deepEqual(errors, []);
    });
    const { runtime } = await searchFixture({ after: fn => cleanups.push(fn) }, { frontend, reply:false, records });
    browser = await chromium.launch();
    const page = await browser.newPage({viewport:{width:1280,height:960}, ...options});
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/api/app-update", async route => {
        if (await fulfillFixtureUpdateStatus(route, new URL(runtime.url).origin)) return;
        errors.push("Unexpected app-update request");
        await route.abort();
    });
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/snapshot") snapshots.push(request); });
    return {page, url:runtime.url, snapshots, total:records.reduce((n,r)=>n+r.toolCalls.length,0)};
}
async function sampleEntry(page, total) {
    await page.addInitScript(expected => {
        window.countFrames = [];
        const deadline = performance.now() + 5000;
        function sample() {
            const node = document.querySelector("#outcomeChart .percentage-total-value");
            if (node?.checkVisibility() && node.getBoundingClientRect().top < innerHeight) {
                const paint = getComputedStyle(node, "::after").content;
                const digits = /^"(\d+)"/.exec(paint);
                const n = Number(digits?.[1] ?? node.innerText);
                if (Number.isFinite(n) && n !== window.countFrames.at(-1)) window.countFrames.push(n);
            }
            if (window.countFrames.at(-1) !== expected && performance.now() < deadline) requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
    }, total);
}
for (const frontend of ["bundled", "react"]) test(`ordinary Analyze entry paints intermediate counts and an accessible responsive donut (${frontend})`, async t => {
    const {page,url,snapshots,total} = await setup(t, frontend, {reducedMotion:"no-preference", viewport:{width:638,height:1200}});
    await sampleEntry(page,total); await page.goto(url);
    const result = page.locator("#outcomeChart"), center = result.locator(".percentage-total-value");
    await expect(result.locator(".percentage-total-link")).toHaveAccessibleName(`View all ${total} Work IQ tool calls`);
    await expect(result.locator(".percentage-ring")).toBeVisible();
    const zero = page.locator('[data-breakdown=authors] .percentage-legend-row[data-count="0"] .percentage-value');
    await expect(zero).toContainText("(0)");
    await expect(page.locator('[data-breakdown=models] .percentage-empty')).toHaveText("WIRE can’t tell which models these interactions used.");
    const requests = snapshots.length;
    if (proof) {
        await mkdir(proof, { recursive:true });
        const clip = await result.boundingBox();
        for (let i = 0; i < 3; i++) {
            await page.screenshot({path:path.join(proof, `${frontend}-build-${i}.png`),clip});
            await page.waitForTimeout(100);
        }
    }
    await page.waitForFunction(n => window.countFrames.at(-1) === n,total);
    await expect(center).toHaveText(String(total));
    const seen = await page.evaluate(() => window.countFrames);
    assert.ok(seen.some(n => n > 0 && n < total) && seen.every((n,i) => !i || seen[i-1] < n), JSON.stringify(seen));
    assert.equal(seen.at(-1),total);
    assert.equal(snapshots.length,requests);
    if (proof) {
        await result.screenshot({path:path.join(proof,`${frontend}-settled.png`)});
        await writeFile(path.join(proof,`${frontend}-count-frames.json`),JSON.stringify(seen));
    }
    await chooseTheme(page,"dark");
    await page.setViewportSize({width:390,height:1000});
    const ring = await result.locator(".percentage-ring").boundingBox(), legend = await result.locator(".percentage-legend").boundingBox();
    assert.ok(ring.width > 90 && legend.y >= ring.y + ring.height - 1);
    await page.emulateMedia({reducedMotion:"reduce"}); await page.reload();
    await expect(center).toHaveText(String(total)); await expect(result.locator(".percentage-ring")).toBeVisible();
    await page.waitForFunction(n => window.countFrames.at(-1) === n,total);
    assert.deepEqual(await page.evaluate(()=>window.countFrames),[total]);
});
for (const frontend of ["bundled", "react"]) for (const width of [1440, 390])
test(`Analyze paints the Settings layout on entry, reorder, reload and Restore (${frontend}, ${width}px)`,async t=>{
    const {page,url,snapshots} = await setup(t,frontend,{reducedMotion:"reduce",hasTouch:true, viewport:{width,height:960}});
    const settings = new URL("/settings?section=analyze",url).href, observations = [];
    const field = page.locator("#analyzeLayout"), up = name => field.getByRole("button",{ name:`Move ${name} up`,exact:true });
    const settingsOrder = () => field.locator("li").evaluateAll(nodes => nodes.map(node => node.dataset.section));
    const preview = field.locator("figure");
    const previewColumns = new Map();
    async function samplePreview(stage) {
        await expect(preview).toBeVisible();
        const tiles = await preview.locator("[data-tile]").evaluateAll(nodes => nodes.map(node => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return { key:node.dataset.tile,x,y,width,height };
        }).sort((a,b)=>a.y-b.y || a.x-b.x));
        assert.deepEqual(tiles.map(tile=>tile.key),await settingsOrder(),`${stage}: preview updates in place`);
        const left = Math.min(...tiles.map(tile=>tile.x)), right = Math.max(...tiles.map(tile=>tile.x+tile.width));
        for (const tile of tiles.filter(tile=>width===390 || tile.key==="interactions")) {
            assert.equal(tile.x,left); assert.ok(Math.abs(tile.x+tile.width-right)<=1,`${stage}: full-width ${tile.key}`);
        }
        previewColumns.set(stage,tiles.map(tile=>[tile.key,tile.x > left+1,tile.width >= right-left-1]));
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        if (proof) await field.screenshot({ path:path.join(proof,`${frontend}-${width}-settings-${stage}.png`) });
        return tiles;
    }
    async function observe(stage) {
        await expect(page.locator("#activityList .activity-card")).toHaveCount(8);
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const cards = await page.locator(".analyze-chart-main:visible,.analyze-outcome-summary:visible,#activityView:visible,"
            + ".percentage-card[data-breakdown]:not([data-breakdown=outcomes]):visible").evaluateAll(nodes => nodes.map(node => {
            const key = node.dataset.breakdown ?? (node.id === "activityView" ? "interactions"
                : node.classList.contains("analyze-chart-main") ? "time" : "outcomes");
            const { x, y, width, height } = node.getBoundingClientRect();
            return { key, x, y, width, height };
        }));
        observations.push({stage,cards});
        if (proof) {
            await mkdir(proof,{recursive:true});
            const file = path.join(proof,`${frontend}-${width}-${stage}`);
            await writeFile(`${file}.json`,JSON.stringify(cards,null,2));
            await page.screenshot({path:`${file}.png`,fullPage:true});
        }
    }
    await page.goto(url); await observe("fresh");
    await page.goto(settings);
    const standard = await settingsOrder();
    await samplePreview("standard");
    const reads = snapshots.length;
    await up("Interactions").focus(); await page.keyboard.press("Enter"); await expect(up("Interactions")).toBeFocused();
    const intermediate = await samplePreview("one-move");
    if (width===1440) assert.equal(intermediate[0].width,intermediate[1].width,"a chart alone before Interactions spans the preview");
    await expect(preview.locator("[data-moved]")).toHaveAttribute("data-tile","interactions");
    assert.equal(snapshots.length,reads,"moving a section does not read evidence");
    await field.getByRole("link",{name:"View Analyze"}).tap();
    await observe("one-move");
    await page.goto(settings); await up("Interactions").press("Enter");
    for (let i=0; i<5; i++) await up("Prompt authors").tap();
    const chosen = await settingsOrder();
    assert.deepEqual(chosen.slice(0,2),["interactions","authors"]);
    await samplePreview("chosen");
    if (width===1440) await chooseTheme(page,"dark");
    await page.reload(); await samplePreview("persisted");
    await field.getByRole("link",{name:"View Analyze"}).tap();
    await observe("chosen"); await page.reload(); await observe("reloaded");
    await page.goto(settings);
    await field.getByRole("button",{name:"Restore WIRE layout"}).tap();
    assert.deepEqual(await settingsOrder(),standard);
    await samplePreview("restored"); await expect(preview.locator("[data-moved]")).toHaveCount(0);
    await field.getByRole("link",{name:"View Analyze"}).tap(); await observe("restored");
    await page.reload(); await observe("restored-reload");
    for (const {stage,cards} of observations) {
        const order = stage==="one-move" ? intermediate.map(tile=>tile.key) : ["chosen","reloaded"].includes(stage) ? chosen : standard;
        const painted = cards.toSorted((a,b) => a.y-b.y || a.x-b.x);
        assert.deepEqual(painted.map(card=>card.key),order,`${stage}: painted reading order`);
        assert.deepEqual(cards.map(card=>card.key),order,`${stage}: document reading order`);
        const left = Math.min(...cards.map(card=>card.x)), right = Math.max(...cards.map(card=>card.x+card.width));
        const previewStage = {fresh:"standard","one-move":"one-move",chosen:"chosen",reloaded:"persisted",restored:"restored","restored-reload":"restored"}[stage];
        assert.deepEqual(painted.map(card=>[card.key,card.x > left+1,card.x <= left+1 && card.x+card.width >= right-1]),
            previewColumns.get(previewStage),`${stage}: each section occupies the column or full row shown in Settings`);
        const list = cards.find(card=>card.key==="interactions");
        for (const card of cards) if (card !== list) {
            assert.ok(card.y+card.height <= list.y+1 || list.y+list.height <= card.y+1,`${stage}: Interactions has its own row`);
        }
        const [first,second] = painted.filter(card=>card!==list);
        if (width===390) assert.ok(painted.every((card,i)=>!i || card.y>=painted[i-1].y+painted[i-1].height-1),`${stage}: stacked`);
        else if (stage!=="one-move") assert.ok(second.x>=first.x+first.width-1 && Math.abs(second.y-first.y)<=1,`${stage}: side by side`);
    }
});
test("moving the pointer tints just its stationary interaction in every appearance",async t=>{
    const {page,url} = await setup(t,"react",{reducedMotion:"reduce"});
    await page.goto(url);
    const cards = page.locator("#activityList .activity-card");
    await expect(cards).toHaveCount(8);
    const styles = () => cards.evaluateAll(nodes => nodes.map(n=>{
        const box=n.getBoundingClientRect(),style=getComputedStyle(n);
        return [style.backgroundColor,style.transform,box.x,box.y+scrollY,box.width,box.height];
    }));
    for (const palette of Object.keys(palettes)) {
        await page.goto(new URL("/settings?section=themes",url).href);
        await page.locator(`label:has(#palette-${palette})`).click();
        await page.goto(url);
        for (const mode of ["light","dark"]) {
            await chooseTheme(page,mode); await expect(page.locator("html")).toHaveAttribute("data-evidence-palette",palette);
            await page.mouse.move(0,0); const rest=await styles();
            for (const i of [0,1,-1]) {
                if (i===-1) await page.mouse.move(0,0);
                else await cards.nth(i).hover({position:{x:28,y:24}});
                const pointer=await styles();
                assert.deepEqual(pointer.flatMap(([paint],k)=>paint===rest[k][0]?[]:[k]),i<0?[]:[i],`${palette}/${mode}`);
                assert.deepEqual(pointer.map(v=>v.slice(1)),rest.map(v=>v.slice(1)));
            }
        }
    }
    const card=cards.first(), link=card.locator("a").first();
    const prompt=card.locator(".card-excerpt");
    await prompt.scrollIntoViewIfNeeded();
    const text=await prompt.boundingBox(), here=page.url();
    await page.mouse.move(text.x+3,text.y+8); await page.mouse.down();
    await page.mouse.move(text.x+65,text.y+8,{steps:6}); await page.mouse.up();
    assert.ok((await page.evaluate(()=>getSelection().toString())).trim());
    assert.equal(page.url(),here);
    await link.focus(); await expect(link).toBeFocused();
    await expect(card).not.toHaveAttribute("role","link");
    await link.press("Enter"); await expect(page.locator("#contextSidebar")).toBeVisible();
});
