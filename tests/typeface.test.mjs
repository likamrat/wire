import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fontDataUrl, fontFaceStyles, uiFontStack } from "../lib/typeface.mjs";
import { typographyTokens, tokens } from "../web/tokens.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { renderPdf } from "../lib/pdf.mjs";

test("the retained Asta asset stays licensed while the current UI uses the reference-aligned system stack", () => {
    const font = readFileSync(new URL("../assets/fonts/asta-sans-latin-variable.woff2", import.meta.url));
    const license = readFileSync(new URL("../assets/fonts/OFL.txt", import.meta.url), "utf8");
    assert.equal(createHash("sha256").update(font).digest("hex"), "ad3079a2c2cef53a0ba3598f7c5a4ae9289982c8b8a426872395846e9fa08e25");
    assert.equal(font.subarray(0, 4).toString(), "wOF2");
    assert.equal(fontDataUrl, `data:font/woff2;base64,${font.toString("base64")}`);
    assert.ok(fontFaceStyles.includes(license));
    assert.match(license, /Copyright 2024 The Asta Sans Project Authors/);
    assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.match(fontFaceStyles, /font-weight:300 800/);
    assert.match(fontFaceStyles, /unicode-range:U\+0000-00FF/);
    assert.equal(uiFontStack, 'Arial,"Helvetica Neue","Segoe UI",sans-serif');
    assert.match(uiFontStack, /sans-serif$/);
});

test("the shell wires shared system typography and retained local font support without a remote dependency", () => {
    const html = renderHtmlShell("a".repeat(64), "fluent-font");
    assert.equal(html.split(fontFaceStyles).length - 1, 1);
    assert.ok(tokens.includes(typographyTokens));
    assert.ok(html.includes(`--font:${uiFontStack}`));
    assert.match(typographyTokens, /--mono:"Cascadia Mono"/);
    for (const role of ["caption", "small", "body", "reading", "control", "title", "section", "dialog", "data-value", "score"]) {
        assert.ok(typographyTokens.includes(`--type-${role}:`), `${role} is a shared role`);
    }
    assert.doesNotMatch(html.replace(fontFaceStyles, ""), /url\(["']?https?:\/\/|<link[^>]+fonts\./i);
});

test("reference typography embeds PDF subsets without reader system-font fallback", async () => {
    const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const html = `<!doctype html><style>:root{${typographyTokens}}body{font-family:var(--font)}h1{font-weight:var(--weight-strong)}</style>
        <h1>WIRE typography</h1><p>Invented retained calls: 12 calls, 3 failed.</p>`;
    const bytes = await renderPdf(html);
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, fontExtraProperties: true });
    try {
        const document = await loading.promise, fonts = new Map();
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number), operators = await page.getOperatorList();
            for (const id of new Set(operators.fnArray.flatMap((op, i) => op === OPS.setFont ? [operators.argsArray[i][0]] : []))) {
                fonts.set(id, page.commonObjs.get(id));
            }
        }
        assert.ok(fonts.size >= 2, "Body and strong heading font programs are present");
        for (const font of fonts.values()) {
            assert.equal(font.missingFile, false, font.name);
            assert.ok(font.data?.byteLength > 0, `${font.name} embeds its font program`);
        }
    } finally { await loading.destroy(); }
});
