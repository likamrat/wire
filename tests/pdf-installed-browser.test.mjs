import test from "node:test";
import assert from "node:assert/strict";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { findPdfBrowser } from "../lib/pdf-browser.mjs";

const browser = await findPdfBrowser();
const skip = browser ? false : "No installed Edge or Chrome";
const text = async bytes => {
    const document = await getDocument({ data: new Uint8Array(bytes) }).promise;
    return (await (await document.getPage(1)).getTextContent()).items.map(item => item.str).join(" ");
};

test("installed-browser PDFs keep page scripts off", { skip }, async () => {
    const bytes = await renderPdf(`<!doctype html><p id="x">static text</p><script>document.getElementById("x").textContent = "scripted text"</script>`, { browser });
    const content = await text(bytes);
    assert.match(content, /static text/);
    assert.doesNotMatch(content, /scripted text/);
});

test("installed-browser PDFs refuse any network request", { skip }, async () => {
    await assert.rejects(renderPdf(`<!doctype html><p>report</p><img src="http://127.0.0.1:9/pixel.png">`, { browser }),
        error => error.status === 500 && /No files were exported/.test(error.message));
});

test("a missing PDF browser is reported as unavailable without exporting", async () => {
    await assert.rejects(renderPdf("<p>report</p>", { browser: "/nonexistent/wire-pdf-browser" }),
        error => error.status === 503 && /Install Microsoft Edge or Google Chrome/.test(error.message));
});
