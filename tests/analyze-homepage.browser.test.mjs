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
    const { runtime } = await searchFixture(t, { frontend, reply:false, records });
    const browser = await chromium.launch(), page = await browser.newPage({viewport:{width:1280,height:960}, ...options});
    const errors = [], snapshots = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/api/app-update", route => fulfillFixtureUpdateStatus(route, new URL(runtime.url).origin));
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/snapshot") snapshots.push(request); });
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); });
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
test("ordinary Analyze entry paints intermediate counts and an accessible responsive donut", async t => {
    const {page,url,snapshots,total} = await setup(t, "react", {reducedMotion:"no-preference", viewport:{width:638,height:1200}});
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
            await page.screenshot({path:path.join(proof, `build-${i}.png`),clip});
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
        await result.screenshot({path:path.join(proof,"settled.png")});
        await writeFile(path.join(proof,"count-frames.json"),JSON.stringify(seen));
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
test("Analyze reads the chosen layout after reload and can restore its original order",async t=>{
    const {page,url,total} = await setup(t,"react",{reducedMotion:"reduce",hasTouch:true});
    await page.goto(new URL("/settings?section=analyze",url).href);
    const field = page.locator("#analyzeLayout"), up = name => field.getByRole("button",{ name:`Move ${name} up`,exact:true });
    await up("Interactions").focus(); await page.keyboard.press("Enter"); await expect(up("Interactions")).toBeFocused();
    await page.keyboard.press("Enter");
    for (let i=0; i<5; i++) await up("Prompt authors").tap();
    await field.getByRole("link",{name:"View Analyze"}).tap();
    const headings = page.locator("#chartTitle:visible,#homeView .percentage-card h3:visible,#activityListSummary:visible,#frontendBreakdowns .percentage-card h3:visible");
    const order = [`${total} interactions · ${total} matching tool calls`,"Prompt authors","Work IQ tool calls over time",
        "Tool call results","Work IQ tool calls","Services and operations","Response models"];
    await expect(headings).toHaveText(order);
    await page.reload(); await expect(headings).toHaveText(order);
    await page.goto(new URL("/settings?section=analyze",url).href);
    await field.getByRole("button",{name:"Restore WIRE layout"}).tap();
    await field.getByRole("link",{name:"View Analyze"}).tap(); await page.reload();
    await expect(headings).toHaveText([order[2],order[3],order[0],order[4],order[5],order[6],order[1]]);
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
