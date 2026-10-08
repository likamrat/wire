import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fontDataUrl, fontFaceStyles, uiFontStack } from "../lib/typeface.mjs";
import { typographyTokens, tokens } from "../web/tokens.mjs";
import { renderHtmlShell } from "../lib/render.mjs";

test("Asta Sans is the unchanged licensed local variable font, embedded with its license", () => {
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
    assert.match(uiFontStack, /^"Asta Sans","Segoe UI"/);
    assert.match(uiFontStack, /sans-serif$/);
});

test("the shell wires one immutable font and reusable role tokens without a remote dependency", () => {
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
