import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION, PRODUCT_TITLE, FAVICON_PATH, logoSvg, darkLogoSvg,
    wordmarkSvg, darkWordmarkSvg, lockupSvg, darkLockupSvg,
    brandMark, brandDarkMark, brandV1Mark, brandV1DarkMark, brandLockup, brandDarkLockup, brandCompactMark } from "../lib/branding.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { currentReportPresentation, hasSupportedReportPresentation, reportBrandHeader } from "../lib/report-presentation.mjs";

function localPaint(svg) {
    assert.doesNotMatch(svg, /<script|<image|<foreignObject|\bhref=|\bon[a-z]+=/i);
    const ids = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    for (const [, target] of svg.matchAll(/url\(([^)]+)\)/g)) {
        assert.match(target, /^#[a-z0-9-]+$/);
        assert.ok(ids.has(target.slice(1)), "Every paint/clip is defined inside the asset");
    }
}

test("historical report wordmarks retain their exact approved artwork and local paint", () => {
    assert.equal(PRODUCT_NAME, "WIRE");
    assert.equal(PRODUCT_DESCRIPTION, "Work IQ Request Explorer");
    assert.equal(PRODUCT_TITLE, "WIRE - Work IQ Request Explorer");
    for (const [svg, hash] of [
        [wordmarkSvg, "d8941e2fcbe1e8ffd86d992cbf5c8524b8767c335f1414f84e35ff6a83b76418"],
        [darkWordmarkSvg, "d012ff4eb660bd2943667b44f577404f35c6a0fbc1e72f483dde8b88ce6e5741"],
    ]) {
        const drawing = svg.replaceAll("\r\n", "\n").replace(/\s*<(title|desc)\b[^>]*>[\s\S]*?<\/\1>/g, "");
        assert.equal(createHash("sha256").update(drawing).digest("hex"), hash);
        assert.match(svg, /viewBox="24 62 500 158"/);
        localPaint(svg);
    }
});

test("the selected identity is deterministic vector artwork with a shared compact coordinate system", () => {
    execFileSync(process.execPath, ["scripts/build-brand-lockups.mjs", "--check"], { cwd: new URL("..", import.meta.url) });
    const artwork = JSON.parse(readFileSync(new URL("../assets/wire-brand.json", import.meta.url), "utf8"));
    for (const svg of [lockupSvg, darkLockupSvg, logoSvg, darkLogoSvg]) {
        localPaint(svg);
        assert.match(svg, /<title id="title">WIRE<\/title>/);
        assert.ok(svg.includes(artwork.symbol.outline));
        assert.ok(svg.includes(artwork.symbol.shade));
        assert.doesNotMatch(svg, /<text|data:font|Work IQ Request Explorer|id="descriptor"/);
    }
    for (const svg of [lockupSvg, darkLockupSvg]) {
        assert.match(svg, /viewBox="0 0 402 82"/);
        assert.ok(svg.includes(artwork.lettering.path));
    }
    for (const svg of [logoSvg, darkLogoSvg]) {
        assert.match(svg, /viewBox="0 0 82 82"/);
        assert.ok(!svg.includes(artwork.lettering.path));
    }
    assert.equal(lockupSvg.match(/<g transform="([^"]+)"/)[1], logoSvg.match(/<g transform="([^"]+)"/)[1],
        "Full and compact marks register the same symbol through the sidebar glide");
    assert.match(lockupSvg, /stop-color="#8f2966"/);
    assert.match(lockupSvg, /stop-color="#c6398d"/);
    assert.match(darkLockupSvg, /stop-color="#d97cb4"/);
    assert.match(logoSvg, /@media\(prefers-color-scheme:dark\)/);
});

test("inline identity layers keep decorative semantics and independent paint IDs", () => {
    for (const [markup, theme] of [[brandMark, "light"], [brandDarkMark, "dark"], [brandV1Mark, "light"], [brandV1DarkMark, "dark"], [brandLockup, "light"], [brandDarkLockup, "dark"]]) {
        assert.match(markup, /class="brand-logo" aria-hidden="true" focusable="false"/);
        assert.ok(markup.includes(`data-brand-theme="${theme}"`));
        assert.doesNotMatch(markup, /<title|<desc|<style|aria-labelledby|role="img"/);
        localPaint(markup);
    }
    assert.match(brandCompactMark, /class="brand-compact" aria-hidden="true" focusable="false"/);
    assert.doesNotMatch(brandCompactMark, /<title|<desc|<style|aria-labelledby|role="img"/);
    localPaint(brandCompactMark);
    const combined = brandLockup + brandDarkLockup + brandCompactMark;
    const ids = [...combined.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, "Visible brand layers cannot collide on a paint/clip definition");
});

test("frozen presentation, not global screen branding, chooses the report identity", () => {
    for (const presentation of [{ schemaVersion: 3 }, { schemaVersion: 3, originExplanationVersion: 1 }]) {
        assert.ok(hasSupportedReportPresentation({ presentation }));
        const header = reportBrandHeader("Historical", { presentation });
        assert.ok(header.includes(brandMark + brandDarkMark));
        assert.ok(!header.includes(brandLockup));
    }
    const v1 = { presentation: { schemaVersion: 3, originExplanationVersion: 1, brandVersion: 1 } };
    assert.ok(hasSupportedReportPresentation(v1));
    const frozenHeader = reportBrandHeader("Shipped Human Path", v1);
    assert.ok(frozenHeader.includes(brandV1Mark + brandV1DarkMark));
    assert.ok(!frozenHeader.includes(brandLockup));
    const header = reportBrandHeader("Current", { presentation: currentReportPresentation });
    assert.ok(header.includes(brandLockup + brandDarkLockup));
    assert.ok(!header.includes(brandMark));
    assert.throws(() => reportBrandHeader("Unknown", { presentation: { brandVersion: 999 } }), /Unsupported frozen report brand/);
});

test("README and application use the current identity without a painted descriptor", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    assert.match(readme, /srcset="assets\/wire-lockup-dark.svg\?v=human-path-2"/);
    assert.match(readme, /src="assets\/wire-lockup.svg\?v=human-path-2" alt="WIRE" width="560"/);
    assert.match(readme, /<\/p>\s+# Work IQ Request Explorer(?:\r?\n){2}/);
    const html = renderHtmlShell("a".repeat(64), "synthetic-branding");
    assert.ok(html.includes(`<link rel="icon" type="image/svg+xml" href="${FAVICON_PATH}">`));
    assert.ok(html.includes(`${brandLockup}${brandDarkLockup}${brandCompactMark}</a></div>`));
    assert.ok(html.includes(`<template id="reportBrand">${brandMark}${brandDarkMark}</template>`),
        "Historical readers retain their original theme assets");
    assert.ok(html.includes(`<template id="reportBrandV1">${brandV1Mark}${brandV1DarkMark}</template>`),
        "Shipped Human Path Markdown previews retain their declared artwork");
    assert.ok(html.includes(`<template id="reportBrandV2">${brandLockup}${brandDarkLockup}</template>`),
        "Current Markdown previews use the declared current identity");
    assert.doesNotMatch(html, /brand-caption|class="brand-name"/);
    assert.doesNotMatch(html, /<(?:img|link|script)[^>]+(?:src|href)=["']https?:/i);
});
