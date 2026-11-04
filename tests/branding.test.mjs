import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION, PRODUCT_TITLE, logoSvg, wordmarkSvg, darkWordmarkSvg, lockupSvg, darkLockupSvg, brandMark, brandDarkMark, brandLockup, brandDarkLockup, brandCompactMark } from "../lib/branding.mjs";
import { fontDataUrl } from "../lib/typeface.mjs";
import { renderHtmlShell } from "../lib/render.mjs";

test("WIRE preserves both approved middle-bar wordmarks and uses only local paint references", () => {
    assert.equal(PRODUCT_NAME, "WIRE");
    assert.equal(PRODUCT_DESCRIPTION, "Work IQ Request Explorer");
    assert.equal(PRODUCT_TITLE, "WIRE - Work IQ Request Explorer");
    for (const [svg, hash] of [
        [wordmarkSvg, "d8941e2fcbe1e8ffd86d992cbf5c8524b8767c335f1414f84e35ff6a83b76418"],
        [darkWordmarkSvg, "d012ff4eb660bd2943667b44f577404f35c6a0fbc1e72f483dde8b88ce6e5741"],
    ]) {
        assert.match(svg, /viewBox="24 62 500 158"/);
        const drawing = svg.replaceAll("\r\n", "\n").replace(/\s*<(title|desc)\b[^>]*>[\s\S]*?<\/\1>/g, "");
        assert.equal(createHash("sha256").update(drawing).digest("hex"), hash);
        assert.match(svg, /<title id="title">WIRE - Work IQ Request Explorer<\/title>/);
        assert.match(svg, /id="letter-e"[^>]+d="M426 201 V90 H489 M426 189 H489"/);
        assert.doesNotMatch(svg, /unapproved|draft|provisional|<script|<image|<foreignObject|\bhref=|\bon[a-z]+=/i);
        const ids = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
        for (const [, target] of svg.matchAll(/url\(([^)]+)\)/g)) {
            assert.match(target, /^#[a-z0-9-]+$/);
            assert.ok(ids.has(target.slice(1)), "Every paint/clip is defined inside the asset");
        }
    }
    assert.match(logoSvg, /<title id="title">WIRE<\/title>/);
    assert.doesNotMatch(logoSvg, /<script|<image|<foreignObject|expression|letter-e|url\(/i);
});

test("inline light and dark wordmarks keep independent IDs and decorative semantics", () => {
    for (const [markup, theme] of [[brandMark, "light"], [brandDarkMark, "dark"], [brandLockup, "light"], [brandDarkLockup, "dark"]]) {
        assert.match(markup, /class="brand-logo" aria-hidden="true" focusable="false"/);
        assert.ok(markup.includes(`data-brand-theme="${theme}"`));
        assert.doesNotMatch(markup, /<title|<desc|aria-labelledby|role="img"/);
        const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
        assert.ok([...ids].every(id => id.startsWith(`wire-${theme}-`)));
        for (const [, target] of markup.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.has(target));
    }
    const ids = [...(brandMark + brandDarkMark).matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, "Theme variants do not create duplicate document IDs");
    assert.match(brandCompactMark, /class="brand-compact" aria-hidden="true" focusable="false"/);
    assert.doesNotMatch(brandCompactMark, /<title|\bid=|aria-labelledby|role="img"/);
    assert.equal(brandCompactMark.match(/<path[\s\S]*?\/>/)[0], logoSvg.match(/<path[\s\S]*?\/>/)[0],
        "The inline compact W keeps the approved path and paint unchanged");
});

test("standalone screen/README lockups add only the licensed descriptor to unchanged artwork", () => {
    for (const [lockup, wordmark] of [[lockupSvg, wordmarkSvg], [darkLockupSvg, darkWordmarkSvg]]) {
        assert.ok(lockup.includes(fontDataUrl), "Standalone images embed the exact bundled font");
        assert.match(lockup, /SIL OPEN FONT LICENSE/);
        assert.match(lockup, /<text id="descriptor"[^>]+font-size="40"[^>]+>Work IQ Request Explorer<\/text>/);
        const artwork = lockup.replace('viewBox="24 62 500 204"', 'viewBox="24 62 500 158"')
            .replace(/<style>[\s\S]*?<\/style>\s*/, "")
            .replace(/  <text id="descriptor"[^>]*>[^<]+<\/text>\r?\n/, "");
        const normalize = value => value.replaceAll("\r\n", "\n").replace(/[ \t]+$/gm, "");
        assert.equal(normalize(artwork), normalize(wordmark), "Every original paint, path, transform and proportion is preserved");
    }
    for (const mark of [brandLockup, brandDarkLockup]) {
        assert.doesNotMatch(mark, /<style|data:font/, "Inline lockups reuse the application's embedded font");
        assert.equal((mark.match(/>Work IQ Request Explorer<\/text>/g) || []).length, 1);
    }
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    assert.match(readme, /srcset="assets\/wire-lockup-dark.svg"/);
    assert.match(readme, /src="assets\/wire-lockup.svg" alt="WIRE - Work IQ Request Explorer" width="316"/);
    assert.doesNotMatch(readme, /<sub>|<br>/);
    assert.match(readme, /<\/p>\s+I built WIRE \(Work IQ Request Explorer\)/);
});

test("the application uses WIRE, the approved local mark and a same-origin favicon", () => {
    const html = renderHtmlShell("a".repeat(64), "synthetic-branding");
    assert.match(html, /<title>WIRE - Work IQ Request Explorer<\/title>/);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
    assert.match(html, /<div id="shellBrand" class="brand"><a class="brand-home" href="#analyze" data-nav="analyze" aria-label="WIRE - Work IQ Request Explorer - Analyze">/);
    assert.ok(html.includes(`${brandLockup}${brandDarkLockup}${brandCompactMark}</a></div>`));
    assert.ok(html.includes(`<template id="reportBrand">${brandMark}${brandDarkMark}</template>`),
        "Saved readers have a separate unchanged report asset source");
    assert.doesNotMatch(html, /brand-caption/);
    assert.doesNotMatch(html, /class="brand-name"/);
    assert.doesNotMatch(html, /Work IQ Evidence/);
    assert.doesNotMatch(html, /<(?:img|link|script)[^>]+(?:src|href)=["']https?:/i);
});
