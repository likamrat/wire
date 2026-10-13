import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fluentIcon, uxIcons, uxIconSources } from "../web/ux-icons.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { renderHtmlShell } from "../lib/render.mjs";

const require = createRequire(import.meta.url);

test("every authored icon preserves local official Fluent geometry, variant and optical size", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    assert.equal(manifest.dependencies["@fluentui/svg-icons"], "1.1.343");
    assert.equal(lock.packages["node_modules/@fluentui/svg-icons"].version, manifest.dependencies["@fluentui/svg-icons"]);
    assert.equal(lock.packages["node_modules/@fluentui/svg-icons"].license, "MIT");
    for (const [key, svg] of [...Object.entries(uxIcons), ...Object.entries(dimensionalIcons)]) {
        const asset = /data-fluent-icon="([a-z0-9_]+_(16|20|24)_(regular|filled))"/.exec(svg);
        assert.ok(asset, `${key} identifies its package asset`);
        assert.equal(asset[3], key.endsWith("-selected") ? "filled" : "regular");
        const original = readFileSync(require.resolve(`@fluentui/svg-icons/icons/${asset[1]}.svg`), "utf8");
        assert.equal(svg.slice(svg.indexOf(">")), original.slice(original.indexOf(">")), `${key} preserves the official paths`);
        assert.ok(svg.includes(`width="${asset[2]}" height="${asset[2]}" viewBox="0 0 ${asset[2]} ${asset[2]}"`), `${key} has its native optical size`);
        assert.match(svg, /aria-hidden="true" focusable="false" fill="currentColor"/);
        assert.doesNotMatch(svg, /<(?:script|image|foreignObject)\b|\b(?:href|style|onload)=|<title>/i);
        if (Object.hasOwn(uxIconSources, key)) assert.equal(asset[1], uxIconSources[key]);
    }
    assert.ok(Object.isFrozen(uxIcons));
    assert.ok(Object.isFrozen(dimensionalIcons));
    assert.equal(uxIconSources.export, "arrow_export_ltr_20_regular");
    assert.equal(uxIconSources.reset, "arrow_reset_24_regular");
    assert.equal(uxIconSources.refresh, "arrow_clockwise_20_regular");
    assert.equal(uxIconSources.info, "info_16_regular");
    assert.equal(uxIconSources["select-check"], "checkmark_16_regular");
    for (const name of ["check", "result-failure", "unobserved", "result-partial", "result-other", "result-transport"]) {
        assert.match(uxIconSources[`${name}-compact`], /_16_regular$/);
    }
    for (const icon of Object.values(dimensionalIcons)) assert.match(icon, /data-fluent-icon="[a-z_]+_24_regular"/);
    assert.match(dimensionalIcons.Unknown, /question_circle_24_regular/);
    assert.match(dimensionalIcons.Discovery, /book_search_24_regular/);
    assert.deepEqual(Object.fromEntries(Object.entries(uxIconSources).filter(([name]) => name.startsWith("navigation-"))), {
        "navigation-home": "home_24_regular",
        "navigation-analyze": "data_trending_24_regular",
        "navigation-reports": "document_24_regular",
        "navigation-settings": "settings_24_regular",
        "navigation-collapse": "panel_left_contract_24_regular",
        "navigation-expand": "panel_left_expand_24_regular",
    });
});

test("missing Fluent assets and unsupported sizes fail instead of rendering a blank fallback", () => {
    assert.throws(() => fluentIcon("missing_evidence_icon"), /Cannot find module/);
    for (const size of [0, 18, 22, 28, "20"]) assert.throws(() => fluentIcon("copy", size), TypeError);
    assert.throws(() => fluentIcon("../copy"), TypeError);
    assert.throws(() => fluentIcon("home", 20, "outline"), TypeError);
});

test("disclosure and progress cues use official SVGs, not CSS-drawn replacements or external images", () => {
    assert.equal(uxIconSources.disclosure, "chevron_right_16_regular");
    assert.equal(uxIconSources.pending, "spinner_ios_20_regular");
    assert.equal(uxIconSources["pending-small"], "spinner_ios_16_regular");
    const ux = readFileSync(new URL("../web/ux-styles.mjs", import.meta.url), "utf8");
    const reports = readFileSync(new URL("../web/report-journey-styles.mjs", import.meta.url), "utf8");
    assert.match(ux, /\.ux-disclosure>\.disclosure-icon/);
    assert.doesNotMatch(ux, /border-inline-end-color:transparent|border-style:dotted/);
    assert.doesNotMatch(reports, /border-right:1\.5px|rotate\(225deg\)/);
    assert.doesNotMatch(ux + reports, /data:image\/svg\+xml/);
});

test("the shell bundles icons locally without an icon font or remote runtime resource", () => {
    const html = renderHtmlShell("a".repeat(64), "synthetic-icons");
    assert.ok(html.includes("copy_20_regular"));
    assert.ok(html.includes("info_16_regular"));
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
            assert.ok(!glyphs.test(source), `${directory}${entry.name}: use a Fluent glyph for authored icon controls`);
            assert.ok(!/[\u{1f300}-\u{1faff}]/u.test(source), `${directory}${entry.name}: no emoji UI icons`);
        }
    }
});
