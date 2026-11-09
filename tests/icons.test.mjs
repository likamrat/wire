import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { lucideIcon, lucideLicense, uxIcons, uxIconSources } from "../web/ux-icons.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { renderHtmlShell } from "../lib/render.mjs";

const require = createRequire(import.meta.url);

test("every authored icon preserves local official Lucide geometry and qualified package identity", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    assert.equal(manifest.dependencies["lucide-static"], "1.52.0");
    assert.equal(manifest.dependencies["@fluentui/svg-icons"], undefined);
    assert.equal(lock.packages["node_modules/lucide-static"].version, manifest.dependencies["lucide-static"]);
    assert.equal(lock.packages["node_modules/lucide-static"].license, "ISC");
    assert.equal(lock.packages["node_modules/lucide-static"].integrity, "sha512-0zZYihAze4ZmUCcyNa9OkWYqn/Y5f9AdTh02AZIxMtP5ravcTTfoSIAnUPBH6ZvKxt+ZW28JB0ldzLRyD82fcw==");
    assert.ok(Object.keys(uxIcons).length > 0);
    assert.ok(Object.keys(dimensionalIcons).length > 0);
    for (const [key, svg] of [...Object.entries(uxIcons), ...Object.entries(dimensionalIcons)]) {
        const asset = /data-lucide-icon="([a-z0-9-]+)" data-icon-size="(16|20|24)"/.exec(svg);
        assert.ok(asset, `${key} identifies its package asset`);
        const file = readFileSync(require.resolve(`lucide-static/icons/${asset[1]}.svg`), "utf8");
        const original = file.slice(file.indexOf("<svg"));
        assert.equal(svg.slice(svg.indexOf(">")), original.slice(original.indexOf(">")), `${key} preserves the official paths`);
        assert.match(svg, /viewBox="0 0 24 24"/);
        assert.ok(svg.includes(`width="${asset[2]}"`) && svg.includes(`height="${asset[2]}"`));
        assert.match(svg, /aria-hidden="true" focusable="false"/);
        assert.match(svg, /fill="none"/); assert.match(svg, /stroke="currentColor"/); assert.match(svg, /stroke-width="2"/);
        assert.doesNotMatch(svg, /<(?:script|image|foreignObject)\b|\b(?:href|style|onload)=|<title>/i);
        if (Object.hasOwn(uxIconSources, key)) assert.equal(asset[1], uxIconSources[key]);
    }
    assert.ok(Object.isFrozen(uxIcons));
    assert.ok(Object.isFrozen(dimensionalIcons));
    assert.equal(uxIcons["compare-periods"], lucideIcon("scale", 20));
    assert.equal(uxIconSources["collapse-sections"], "fold-vertical");
    assert.equal(uxIconSources["expand-sections"], "unfold-vertical");
    assert.equal(uxIconSources.filter, "funnel");
    assert.equal(uxIconSources.export, "file-output");
    assert.equal(uxIconSources.reset, "rotate-ccw");
    assert.equal(uxIconSources.refresh, "refresh-cw");
    assert.equal(uxIconSources.info, "info");
    assert.equal(uxIconSources["select-check"], "check");
    for (const name of ["check", "result-failure", "unobserved", "result-partial", "result-other", "result-transport"]) {
        assert.match(uxIcons[`${name}-compact`], /data-icon-size="16"/);
    }
    for (const icon of Object.values(dimensionalIcons)) assert.match(icon, /data-icon-size="24"/);
    assert.match(dimensionalIcons.Unknown, /circle-question-mark/);
    assert.match(dimensionalIcons.Discovery, /book-open/);
    assert.deepEqual(Object.fromEntries(Object.entries(uxIconSources).filter(([name]) => name.startsWith("navigation-"))), {
        "navigation-home": "house",
        "navigation-analyze": "chart-column",
        "navigation-reports": "clipboard-list",
        "navigation-settings": "settings",
        "navigation-records": "rotate-ccw-clock",
        "navigation-compare": "scale",
        "navigation-create-report": "file-text",
        "navigation-collapse": "panel-left",
        "navigation-expand": "panel-left",
    });
    assert.equal(uxIcons["navigation-analyze"], lucideIcon("chart-column", 24));
    assert.equal(uxIcons["navigation-reports"], lucideIcon("clipboard-list", 24));
    assert.equal(uxIcons["navigation-records"], lucideIcon("rotate-ccw-clock", 24));
    assert.equal(uxIcons["navigation-compare"], lucideIcon("scale", 24));
    assert.equal(uxIcons["navigation-create-report"], lucideIcon("file-text", 24));
    assert.equal(uxIcons["search-analysis"], lucideIcon("chart-no-axes-combined", 24));
    assert.equal(uxIcons.reports, lucideIcon("file-text", 20));
});

test("missing Lucide assets and unsupported sizes fail instead of rendering a blank fallback", () => {
    assert.throws(() => lucideIcon("missing-evidence-icon"), /Cannot find module/);
    for (const size of [0, 18, 22, 28, "20"]) assert.throws(() => lucideIcon("copy", size), TypeError);
    assert.throws(() => lucideIcon("../copy"), TypeError);
});

test("reader maximize and restore have distinct official Lucide glyphs at the control size", () => {
    assert.equal(uxIcons["reader-maximize"], lucideIcon("maximize-2", 20));
    assert.equal(uxIcons["reader-restore"], lucideIcon("minimize-2", 20));
    assert.notEqual(uxIcons["reader-maximize"], uxIcons["reader-restore"]);
});

test("Search reuses the established Settings and report glyphs rather than alternative artwork", () => {
    assert.equal(uxIconSources["search-setting"], uxIconSources.settings);
    assert.equal(uxIconSources["search-report"], uxIconSources.reports);
    assert.equal(uxIcons["search-setting"], lucideIcon(uxIconSources.settings, 16));
});

test("disclosure and progress cues use official SVGs, not CSS-drawn replacements or external images", () => {
    assert.equal(uxIconSources.disclosure, "chevron-right");
    assert.equal(uxIconSources.pending, "loader-circle");
    assert.equal(uxIconSources["pending-small"], "loader-circle");
    const ux = readFileSync(new URL("../web/ux-styles.mjs", import.meta.url), "utf8");
    const reports = readFileSync(new URL("../web/report-journey-styles.mjs", import.meta.url), "utf8");
    assert.match(ux, /\.ux-disclosure>\.disclosure-icon/);
    assert.doesNotMatch(ux, /border-inline-end-color:transparent|border-style:dotted/);
    assert.doesNotMatch(reports, /border-right:1\.5px|rotate\(225deg\)/);
    assert.doesNotMatch(ux + reports, /data:image\/svg\+xml/);
});

test("the shell bundles icons locally without an icon font or remote runtime resource", () => {
    const html = renderHtmlShell("a".repeat(64), "synthetic-icons");
    assert.ok(html.includes('data-lucide-icon='));
    assert.ok(html.includes(lucideLicense.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")));
    assert.match(lucideLicense, /Copyright \(c\) 2026 Lucide Icons and Contributors/);
    assert.match(lucideLicense, /Copyright \(c\) 2013-present Cole Bemis/);
    assert.doesNotMatch(html, /data-fluent-icon|fluent-icon|data-wire-icon/);
    assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i);
    assert.doesNotMatch(html, /fonts\.google|cdn\.jsdelivr|unpkg\.com/i);
    assert.match(html, /font-family:"Asta Sans";src:url\("data:font\/woff2;base64,/);
    for (const file of ["native-report-output", "report-presentation", "pdf"]) {
        const source = readFileSync(new URL(`../lib/${file}.mjs`, import.meta.url), "utf8");
        assert.doesNotMatch(source, /(?:ux-icons|dimensional-icons|ux-styles|semantic-cue-styles|metadata-styles|percentage-charts-styles)\.mjs/,
            `${file} does not inherit screen icon registrations or alignment styles`);
    }
});

test("static action lookups resolve, including export and every newly integrated control", () => {
    for (const relative of ["../web/client.mjs", "../web/theme-control.mjs", "../web/ux.mjs"]) {
        const source = readFileSync(new URL(relative, import.meta.url), "utf8");
        for (const [, name] of source.matchAll(/\bicon\(["']([^"']+)["']\)/g)) {
            assert.ok(Object.hasOwn(uxIcons, name), `${relative}: missing ${name} icon`);
        }
    }
    for (const name of ["home", "activity", "reports", "settings", "export", "menu", "close", "refresh", "reset", "download"]) {
        assert.equal(typeof uxIcons[name], "string", `${name} action has an official asset`);
    }
});

test("authored app controls do not regress to Unicode or emoji icon shorthands", () => {
    const glyphs = /[×✕✖✓✔☀☾☰⌂ℹ⚠↻↺▾▸▼▶]|\\u(?:00d7|2713|2714|2715|2716|2630|2139|26a0|21bb|21ba)/iu;
    for (const directory of ["../web/", "../lib/"]) {
        const root = new URL(directory, import.meta.url);
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
            const source = readFileSync(new URL(entry.name, root), "utf8");
            assert.ok(!glyphs.test(source), `${directory}${entry.name}: use a Lucide glyph for authored icon controls`);
            assert.ok(!/[\u{1f300}-\u{1faff}]/u.test(source), `${directory}${entry.name}: no emoji UI icons`);
        }
    }
});
