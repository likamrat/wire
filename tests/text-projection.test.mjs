import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { fixture } from "./helpers.mjs";

test("included long prompt copies stay complete in HTML, Markdown, JSON and PDF without exposing omitted originals", { timeout: 120000 }, async t => {
    const source = fixture("text-projection");
    const longToken = "syntheticunbrokentext".repeat(120);
    source.userPrompt.text = "SYNTHETIC_START\n  preserve these spaces  \n" + longToken +
        "\nUnicode: Montr\u00e9al, \u0391\u03b8\u03ae\u03bd\u03b1.\nsynthetic.person@example.invalid\nSYNTHETIC_FINAL";
    source.followUpPrompts = [{ status: "partial", text: "SYNTHETIC_RECORDED_FRAGMENT", provenance: "human-authored" }];
    const before = structuredClone(source);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    for (const promptMode of ["none", "masked", "original"]) {
        const bundle = await buildSanitizedBundle([source], "b".repeat(64), { promptMode, formats: ["html", "pdf", "json", "markdown"] });
        const projected = bundle.records[0].prompts;
        const page = await browser.newPage();
        await page.setContent(bundle.files["product-report.html"]);
        await page.locator("details").evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
        const included = projected.filter(prompt => prompt.text !== null).map(prompt => prompt.text);
        assert.deepEqual(await page.locator(".prompt pre").allTextContents(), included);
        for (const width of [375, 820, 1200]) {
            await page.setViewportSize({ width, height: 900 });
            assert.equal(await page.locator(".prompt pre").evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), true);
        }
        for (const text of included) {
            assert.ok(bundle.files["product-report.md"].includes(text.split("\n").map(line => "    " + line).join("\n")));
        }
        assert.deepEqual(JSON.parse(bundle.files["product-report.json"]).records, bundle.records);
        const loading = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
        const pdf = await loading.promise;
        let pdfText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
            const pdfPage = await pdf.getPage(i), size = pdfPage.getViewport({ scale: 1 });
            const { items } = await pdfPage.getTextContent();
            for (const item of items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= 0 && item.transform[4] + item.width <= size.width + 2, "PDF text must fit the page horizontally");
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= size.height + 1, "PDF text must fit the page vertically");
            }
            pdfText += items.map(item => item.str || "").join("");
        }
        await loading.destroy();
        for (const text of [await page.locator("body").textContent(), bundle.files["product-report.md"], pdfText]) {
            assert.equal(text.includes("SYNTHETIC_FINAL"), promptMode !== "none");
            assert.equal(text.includes("synthetic.person@example.invalid"), promptMode === "original");
            if (promptMode !== "none") {
                assert.ok(text.replace(/\s/gu, "").includes(longToken), "Included wording is complete, not merely the excerpt");
                assert.match(text, /Only part of the original was recorded/);
            }
        }
        await page.close();
    }
    assert.deepEqual(source, before);
});
