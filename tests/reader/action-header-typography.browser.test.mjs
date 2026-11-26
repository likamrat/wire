import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "../search/live-search-fixture.mjs";
import { fixture, chooseTheme } from "../support/helpers.mjs";

const proofDir = process.env.WORKIQ_ACTION_TYPOGRAPHY_PROOFS;
const exactPath = "/me/messages/{MessageId}?$select=subject&$filter=contains(subject,'\u65e5\u672c\u8a9e <not-markup>')";
const longPath = "/me/messages/" + "LiteralCase{}Segment".repeat(35) + "?$select=Subject&x=\u65e5\u672c\u8a9e";

async function setup(t, record, linkName) {
    const app = await searchFixture(t, { records: [record], frontend: "react", reply: false });
    const browser = await chromium.launch(), page = await browser.newPage({ reducedMotion: "reduce" });
    const errors = [], denied = [], requests = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const updateStatus = url.pathname === "/api/app-update" && request.method() === "POST" && request.postDataJSON()?.action === "status";
        if (url.origin !== new URL(app.runtime.url).origin || (request.method() !== "GET" && !updateStatus && ![
            "/api/snapshot", "/api/assessment/detail", "/api/assessment/overview", "/api/collection/status",
            "/api/evaluation/automatic/summary",
        ].includes(url.pathname))) { denied.push(url.pathname); return route.abort(); }
        requests.push(url.pathname); return route.continue();
    });
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(denied, []); });
    await page.goto(app.runtime.url);
    const entry = linkName ? page.locator("#activityList").getByRole("link", { name: linkName })
        : page.locator("#activityList .card-orientation .card-outcome");
    await entry.press("Enter");
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", `request:${record.scenarioId}`);
    return { page, entry, requests };
}

async function measure(page) {
    await page.evaluate(() => document.fonts.ready);
    return page.locator('[data-reader-section="activity"]').evaluate(activity => {
        const body = document.querySelector("#contextSidebarBody");
        const paths = [...activity.querySelectorAll("code.api-path")].filter(n => n.checkVisibility()).map(n => {
            const css = getComputedStyle(n);
            const clip = body.getBoundingClientRect(), range = document.createRange();
            range.selectNodeContents(n);
            const inside = [...range.getClientRects()].every(rect => rect.left >= clip.left - 1 && rect.right <= clip.right + 1);
            return { text: n.textContent, wrapped: inside && n.scrollWidth <= n.clientWidth + 1,
                role: Object.fromEntries(["fontFamily","fontSize","fontWeight","fontVariantLigatures","whiteSpace",
                    "overflowWrap","userSelect","backgroundColor","padding"].map(p => [p, css[p]])) };
        });
        return { paths, overflow: body.scrollWidth - body.clientWidth,
            headers: [...activity.querySelectorAll(".call-heading")].map(header => {
                const box = header.getBoundingClientRect(), button = header.querySelector("button").getBoundingClientRect();
                const fit = n => { const r = n.getBoundingClientRect();
                    return r.x >= box.x - 1 && r.right <= box.right + 1 && n.scrollWidth <= n.clientWidth + 1; };
                return { tool: header.querySelector(".reader-tool-name").textContent, height: button.height,
                    fits: [...header.querySelectorAll(".reader-call-identity-line,.reader-tool-name,.reader-call-disclosure,.service-cue")].every(fit) };
            }) };
    });
}

async function checkMatrix(page, tools, expectedPaths, name) {
    const measurements = [];
    for (const [theme,width,scale] of [["light",820,1],["light",1200,1],["light",1200,2],["dark",2560,1],["dark",375,1],["dark",375,2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        const result = await measure(page), label = `${theme}-${width}-${scale}`;
        assert.ok(result.overflow <= 1, `${label}: reader fits`);
        assert.deepEqual(result.headers.map(h => h.tool), tools);
        for (const header of result.headers) assert.ok(header.fits && header.height >= 44, `${label}: ${header.tool}`);
        assert.deepEqual(result.paths.map(p => p.text).sort(), [...expectedPaths].sort(), `${label}: literal path content`);
        for (const p of result.paths) {
            assert.ok(p.wrapped, `${label}: complete path fits`);
            assert.deepEqual(p.role, result.paths[0].role, `${label}: same path typography in request and return`);
            assert.match(p.role.fontFamily, /Cascadia Mono/i);
            assert.equal(p.role.fontWeight, "400"); assert.equal(p.role.userSelect, "text");
            assert.equal(p.role.overflowWrap, "anywhere");
        }
        if (scale === 2) assert.equal(parseFloat(result.paths[0].role.fontSize),
            2 * parseFloat(measurements.at(-1).paths[0].role.fontSize), `${label}: respects root text size`);
        measurements.push({ label, ...result });
        if (proofDir && ((width === 1200 && scale === 1) || (width === 375 && scale === 2))) {
            await mkdir(proofDir, { recursive: true });
            await page.locator("#contextSidebar").screenshot({ path: path.join(proofDir, `${name}-${label}.png`) });
        }
    }
    await expect(page.locator("not-markup")).toHaveCount(0);
    if (proofDir) { await mkdir(proofDir, { recursive: true }); await writeFile(path.join(proofDir, `${name}.json`), JSON.stringify(measurements)); }
}

test("requested and returned literal API paths share a readable type role in their owning call", async t => {
    const record = fixture("header-single"), call = record.toolCalls[0];
    call.requestedApiPath = exactPath; call.requestArgs = { entityUrls: [exactPath] };
    call.apiResults = [exactPath, longPath].map((path, index) => ({ index, statusCode: 200, path, evidenceLevel: "intermediary-reported" }));
    const { page, entry, requests } = await setup(t, record);
    const row = page.locator(`[data-tool-call-id="${call.toolCallId}"]`), disclosure = row.locator(".reader-call-toggle");
    await expect(row.locator(".api-result-entry code.api-path")).toHaveText([exactPath, longPath]);
    await disclosure.press("Enter");
    assert.equal(await row.locator(".technical-detail code.api-path").textContent(), exactPath);
    await checkMatrix(page, [call.tool], [exactPath, exactPath, longPath], "single");
    const reads = requests.length; await disclosure.scrollIntoViewIfNeeded(); await disclosure.hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toHaveText(await disclosure.getAttribute("aria-description"));
    await expect(disclosure).toHaveAttribute("aria-describedby", await tip.getAttribute("id"));
    await page.keyboard.press("Escape"); await expect(tip).toBeHidden();
    assert.equal(requests.length, reads, "Tool-purpose help does not read another record");
    await page.goBack(); await expect(entry).toBeFocused();
});

test("repeated and unbroken tool names wrap while each call keeps its own paths and service evidence", async t => {
    const record = fixture("header-multiple"), longName = "workiq-" + "LongToolIdentifier".repeat(12);
    record.toolCalls = [longPath, "/me/drive/root/children", null].map((p,i) => ({
        ...record.toolCalls[0], tool: i === 1 ? longName : "workiq-fetch", toolCallId: `multiple-${i}`,
        startEventId: `multiple-start-${i}`, startedAt: `2026-09-30T12:00:0${i}Z`, requestedApiPath: p,
        requestArgs: p ? { entityUrls: [p] } : {}, apiResults: [],
    }));
    const { page } = await setup(t, record, /^workiq-fetch: open/);
    const rows = page.locator('[data-reader-section="activity"] .reader-call-row');
    await expect(rows).toHaveCount(3);
    for (const row of await rows.all()) await row.locator(".reader-call-toggle").click();
    assert.equal(await rows.nth(0).locator(".technical-detail code.api-path").textContent(), longPath);
    await expect(rows.nth(1).locator(".technical-detail code.api-path")).toHaveText("/me/drive/root/children");
    await expect(rows.nth(2).locator("code.api-path")).toHaveCount(0);
    await expect(rows.nth(2).locator(".reader-call-services")).toContainText(/not recorded/i);
    await checkMatrix(page, ["workiq-fetch",longName,"workiq-fetch"], [longPath,"/me/drive/root/children"], "multiple");
});
