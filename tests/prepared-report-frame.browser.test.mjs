import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createFrozenReportFrame } from "../web/live-search.mjs";
import { createPreparedReportFrame } from "../web/report-journey.mjs";

test("only the prepared frame grows and scales; hostile active content stays inert and released callbacks stop", { timeout: 30000 }, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
    const external = [];
    await page.route("**/*", route => { external.push(route.request().url()); return route.abort(); });
    await page.setContent("<style>html{scroll-padding-top:60px}body{margin:0}iframe{display:block;width:100%;border:0}.report-inspection-tabs{height:44px;position:sticky;top:0;background:white}</style><div class=report-inspection-tabs>Report</div><main></main>");
    const html = `<!doctype html><html><head><base href="https://outside.invalid/"><meta http-equiv="refresh" content="0;url=https://outside.invalid/refresh">
        <style>@import url("https://outside.invalid/style");body{margin:0;padding:20px;font-size:1rem}p{line-height:1.6}section{padding:10px}</style></head>
        <body><h1>Invented prepared report</h1><a href="#last">Last section</a><a href="https://outside.invalid/leave">External link</a>
        <button onclick="parent.executed=true">Inline handler</button><form action="https://outside.invalid/submit"><button>Submit</button></form>
        <img src="https://outside.invalid/image"><script>parent.executed=true</script><iframe src="https://outside.invalid/frame"></iframe>
        ${"<p>Invented report text with enough detail to require ordinary reading and natural line wrapping.</p>".repeat(30)}
        <details><summary>More retained detail</summary>${"<p>Expanded evidence.</p>".repeat(20)}</details><section id="last">Last section content</section></body></html>`;
    await page.evaluate(({ html, prepared, frozen }) => {
        window.readerErrors = [];
        window.reader = (0, eval)(`(${prepared})`)(html, (0, eval)(`(${frozen})`), { onError: message => window.readerErrors.push(message) });
        document.querySelector("main").append(window.reader.frame);
        window.savedFrame = (0, eval)(`(${frozen})`)(html);
    }, { html, prepared: createPreparedReportFrame.toString(), frozen: createFrozenReportFrame.toString() });
    const frame = page.frameLocator("iframe");
    await frame.locator("h1").waitFor();
    await page.waitForFunction(() => document.querySelector("iframe").clientHeight > 1500);
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-same-origin");
    assert.equal(await page.evaluate(() => window.savedFrame.getAttribute("sandbox")), "");
    assert.equal(await frame.locator("script,iframe,base,meta[http-equiv=refresh]").count(), 0);
    await frame.getByText("External link", { exact: true }).click();
    await frame.getByRole("button", { name: "Inline handler", exact: true }).click();
    await frame.getByRole("button", { name: "Submit", exact: true }).click();
    assert.equal(await page.evaluate(() => window.executed), undefined);
    const before = await page.locator("iframe").evaluate(node => node.clientHeight);
    await frame.locator("details>summary").click();
    await page.waitForFunction(height => document.querySelector("iframe").clientHeight > height, before);
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.waitForFunction(() => getComputedStyle(document.querySelector("iframe").contentDocument.body).fontSize === "32px");
    await frame.getByRole("link", { name: "Last section", exact: true }).click();
    assert.ok(await page.evaluate(() => scrollY > 1000));
    assert.equal(await frame.locator("html").evaluate(node => node.scrollHeight <= innerHeight + 1), true);
    assert.equal(page.url(), "about:blank");
    await page.evaluate(() => { window.reader.dispose(); window.releasedHeight = window.reader.frame.style.height; document.documentElement.style.fontSize = "100%"; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.reader.frame.style.height === window.releasedHeight), true);
    assert.deepEqual(await page.evaluate(() => window.readerErrors), []);
    assert.deepEqual(external, []);
});

test("a viewport-dependent hostile layout fails explicitly instead of growing in a resize loop", { timeout: 10000 }, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent("<main></main>");
    await page.evaluate(({ prepared, frozen }) => {
        window.layoutErrors = [];
        window.reader = (0, eval)(`(${prepared})`)("<style>body{min-height:100vh;margin:20px}</style><p>Invented loop fixture</p>",
            (0, eval)(`(${frozen})`), { onError: message => window.layoutErrors.push(message) });
        document.querySelector("main").append(window.reader.frame);
    }, { prepared: createPreparedReportFrame.toString(), frozen: createFrozenReportFrame.toString() });
    await page.waitForFunction(() => window.layoutErrors.length === 1, null, { timeout: 1000 });
    assert.match(await page.evaluate(() => window.layoutErrors[0]), /layout.*settle/);
    assert.equal(await page.locator("iframe").count(), 0);
});
