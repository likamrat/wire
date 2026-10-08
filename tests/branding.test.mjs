import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION, PRODUCT_TITLE, logoSvg, wordmarkSvg, darkWordmarkSvg, brandMark, brandDarkMark } from "../lib/branding.mjs";
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
        const drawing = svg.replace(/\s*<(title|desc)\b[^>]*>[\s\S]*?<\/\1>/g, "");
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
    for (const [markup, theme] of [[brandMark, "light"], [brandDarkMark, "dark"]]) {
        assert.match(markup, /class="brand-logo" aria-hidden="true" focusable="false"/);
        assert.ok(markup.includes(`data-brand-theme="${theme}"`));
        assert.doesNotMatch(markup, /<title|<desc|aria-labelledby|role="img"/);
        const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
        assert.ok([...ids].every(id => id.startsWith(`wire-${theme}-`)));
        for (const [, target] of markup.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.has(target));
    }
    const ids = [...(brandMark + brandDarkMark).matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, "Theme variants do not create duplicate document IDs");
});

test("the application uses WIRE, the approved local mark and a same-origin favicon", () => {
    const html = renderHtmlShell("a".repeat(64), "synthetic-branding");
    assert.match(html, /<title>WIRE - Work IQ Request Explorer<\/title>/);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
    assert.match(html, /<div class="brand"><a class="brand-home" href="#home" data-nav="home" aria-label="WIRE - Work IQ Request Explorer - Home">/);
    assert.ok(html.includes(`${brandMark}${brandDarkMark}</a><span class="brand-caption">Work IQ Request Explorer</span></div>`));
    assert.ok(html.includes(brandMark));
    assert.ok(html.includes(brandDarkMark));
    assert.doesNotMatch(html, /class="brand-name"/);
    assert.doesNotMatch(html, /Work IQ Evidence/);
    assert.doesNotMatch(html, /<(?:img|link|script)[^>]+(?:src|href)=["']https?:/i);
});
