import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFieldMarkup, createSearchFields } from "../web/search-field.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { chooseTheme, navigateMain, navigateSettings } from "./helpers.mjs";
import { chooseReportScope } from "./report-journey-helpers.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";

const proofs = process.env.WIRE_SEARCH_FIELD_PROOFS;
async function capture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.screenshot({ path: path.join(proofs, name + ".png") });
}

test("search-field Interface escapes markup, keeps native input, owns one clear callback and releases replaced listeners", async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(`<label for="field">Local field</label>${searchFieldMarkup({
        id: "field", clearId: "field-clear", placeholder: '"><img src=x onerror=alert(1)>', describedBy: 'help" onfocus="alert(1)',
    })}`);
    assert.equal(await page.locator("img").count(), 0);
    assert.equal(await page.locator("#field").getAttribute("placeholder"), '"><img src=x onerror=alert(1)>');
    assert.equal(await page.locator("#field").getAttribute("onfocus"), null);
    await page.addScriptTag({ content: `const fields = (${createSearchFields}) ((${createEvidenceUX})(${JSON.stringify(uxIcons)}));
        const input = document.getElementById("field");
        const calls = [];
        const first = fields.mount(input, {clearLabel:"Clear local field",onInput:event=>calls.push(["first",event?.isComposing ?? false])});
        window.proof = {fields,input,calls,first};` });
    await page.locator("#field").fill("local");
    await expect(page.locator("#field-clear")).toBeVisible();
    await page.locator("#field").evaluate(input => input.setSelectionRange(1, 3));
    assert.deepEqual(await page.evaluate(() => {
        const { first, input } = window.proof;
        first.sync("local");
        return [input.selectionStart, input.selectionEnd];
    }), [1, 3]);
    await page.evaluate(() => {
        const { input, fields } = window.proof;
        window.proof.next = fields.mount(input, { clearLabel: "Clear local field", onInput: event => window.proof.calls.push(["next", event?.isComposing ?? false]) });
        window.proof.first.dispose();
        input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: "字" }));
    });
    await page.locator("#field-clear").click();
    await expect(page.locator("#field")).toHaveValue("");
    await expect(page.locator("#field")).toBeFocused();
    assert.deepEqual(await page.evaluate(() => window.proof.calls), [["first", false], ["next", true], ["next", false]]);
    await page.evaluate(() => {
        const { input, next } = window.proof;
        input.disabled = true; next.sync("locked"); next.clear();
    });
    await expect(page.locator("#field-clear")).toBeDisabled();
    await expect(page.locator("#field")).toHaveValue("locked");
    await page.evaluate(() => {
        const { input, next } = window.proof;
        input.disabled = false; input.readOnly = true; next.sync(); next.clear();
        input.readOnly = false; next.sync(); input.parentElement.inert = true; next.clear();
        input.parentElement.inert = false; next.dispose();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        next.clear();
    });
    await expect(page.locator("#field")).toHaveValue("locked");
    assert.equal(await page.evaluate(() => window.proof.calls.length), 3);
    await page.evaluate(() => {
        const { fields, input, calls } = window.proof;
        window.proof.last = fields.mount(input, {
            clearLabel: "Clear local field", onInput: () => calls.push("typed"), onClear: () => calls.push("cleared"),
            focusAfterClear: () => calls.push("focus"),
        });
    });
    await page.locator("#field-clear").click();
    assert.deepEqual(await page.evaluate(() => window.proof.calls.slice(3)), ["cleared", "focus"]);
});

async function setup(t) {
    const cleanup = [];
    const app = await searchFixture({ after: action => cleanup.push(action) }, {
        records: searchRecords(19), formats: ["html", "json"], reportTitles: ["Hospital workflow", "Garage workflow"],
    });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "no-preference" });
    const errors = [], requests = [], nonlocal = [];
    const sources = Array.from({ length: 19 }, (_, i) => ({ sessionId: `field-chat-${i}`, name: i === 18 ? "Orchard review" : `Synthetic chat ${i}`, eligible: true }));
    const coverage = createCollectionStatus().coverage(sources, sources.map(source => ({ sessionId: source.sessionId, errorCode: "ENOENT", error: "Synthetic missing history" })), []);
    await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(app.runtime.url).origin) { nonlocal.push(url.href); return route.abort(); }
        requests.push({ path: url.pathname, body: route.request().postDataJSON() });
        if (url.pathname === "/api/collection/status") {
            const response = await route.fetch(), status = await response.json();
            return route.fulfill({ response, json: { ...status, historyCoverage: coverage.summary, historyIssues: coverage.issues } });
        }
        if (url.pathname === "/api/recollection/sources") return route.fulfill({ json: {
            sources: sources.map(source => ({ sourceSessionId: source.sessionId, name: source.name, available: true })),
            since: "2026-10-01T00:00:00Z", until: "2026-10-18T00:00:00Z", windowDays: 30, skippedSources: 0,
        } });
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []); assert.deepEqual(nonlocal, []);
        assert.ok(requests.every(request => !/\/(?:confirm|preview|set|configure|collect-now)$/.test(request.path)), "No source/report/permission mutations from field interaction");
    });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    assert.deepEqual(await page.locator(".search-capsule-input").evaluateAll(nodes => nodes.map(node => node.id).sort()),
        ["wireSearch", "settingsSearch", "issueSearch", "savedReportSearch", "reportRequestSearch", "recollectSearch"].sort());
    return { ...app, page, requests };
}

// Compare painted glyph bounds and the reserved text region, not just SVG boxes.
async function geometry(input) {
    return input.evaluate(node => {
        const style = getComputedStyle(node), root = node.closest(".search-capsule"), rect = node.getBoundingClientRect();
        const glyph = root.querySelector(".wire-search-icon svg"), svg = glyph.getBoundingClientRect(), ink = glyph.getBBox();
        const clear = root.querySelector("button"), target = clear.getBoundingClientRect();
        return {
            paint: Object.fromEntries(["fontFamily", "fontSize", "lineHeight", "borderRadius", "paddingLeft", "paddingRight", "backgroundImage", "color"]
                .map(key => [key, style[key]])),
            glyph: { width: svg.width, height: svg.height, inkWidth: ink.width * svg.width / 24, inkHeight: ink.height * svg.height / 24,
                centerOffset: svg.y + svg.height / 2 - rect.y - rect.height / 2, textGap: rect.x + parseFloat(style.paddingLeft) - svg.right },
            clear: { width: target.width, height: target.height, inside: target.x >= rect.x && target.right <= rect.right,
                textGap: target.x - (rect.right - parseFloat(style.paddingRight)),
                reachable: clear.contains(document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2)) },
            width: rect.width, height: rect.height, overflow: document.documentElement.scrollWidth > innerWidth,
        };
    });
}

test("search entries keep their corpus and Escape while Settings uses compact field paint", { timeout: 120000 }, async t => {
    const { page, requests, bundles } = await setup(t), evidence = [];
    const global = page.locator("#wireSearch");
    await global.fill("physician");
    await expect(page.locator("#wireSearchResults button").first()).toBeVisible();
    await global.press("Escape");
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await expect(global).toHaveValue("physician");
    for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        await chooseTheme(page, theme);
        await global.hover();
        await capture(page, `wireSearch-${theme}-hover`);
        await global.click();
        await expect(page.locator("#wireSearchPanel")).toBeVisible();
        await capture(page, `wireSearch-${theme}-typed`);
        const cleared = page.waitForRequest(request => request.url().endsWith("/api/search/query") && request.postDataJSON().query === "");
        await page.locator("#wireSearchClear").click(); await cleared;
        await expect(global).toHaveValue(""); await expect(global).toBeFocused();
        await capture(page, `wireSearch-${theme}-cleared`);
        await global.fill("physician");
        await expect(page.locator("#wireSearchResults button").first()).toBeVisible();
        await global.press("Escape");
        for (const [id, query, open, matched] of [
            ["settingsSearch", "theme", () => navigateMain(page, "settings"), () => expect(page.locator("#settingsSearchResults a[data-setting=theme]")).toBeVisible()],
            ["issueSearch", "Orchard", () => navigateMain(page, "collection-status"), () => expect(page.locator("#issueSearchCount")).toHaveText("1 of 19 chats")],
            ["savedReportSearch", "Hospital workflow", () => navigateMain(page, "reports"), () => expect(page.locator(".saved-library-row")).toHaveAttribute("data-bundle-id", bundles[0].bundleId)],
            ["reportRequestSearch", "physician", () => chooseReportScope(page, "all"), () => expect(page.locator("#reportRequestSearchCount")).toContainText("All 19 remain included")],
            ["recollectSearch", "Orchard", async () => { await navigateMain(page, "settings"); await navigateSettings(page, "data"); await page.locator("#recollectActivity").click(); },
                () => expect(page.locator("#recollectSources input")).toHaveCount(1)],
        ]) {
            await open();
            const input = page.locator("#" + id), clear = input.locator("..").locator("button");
            await expect(input).toBeVisible();
            assert.equal(await page.locator("input[type=search]:visible:not(.search-capsule-input)").count(), 0);
            const identity = await input.elementHandle();
            const searchRequests = requests.filter(request => request.path.startsWith("/api/search/")).length;
            for (const [width, scale] of [[1280, 100], [375, 200]]) {
                await page.setViewportSize({ width, height: 1000 });
                await page.evaluate(scale => { document.documentElement.style.fontSize = scale + "%"; }, scale);
                await input.fill("");
                await input.scrollIntoViewIfNeeded();
                const before = await input.boundingBox();
                await input.hover();
                await capture(page, `${id}-${theme}-${width}-${scale}-hover`);
                await input.fill(query); await matched();
                const measured = await geometry(input), reference = await geometry(global);
                if (id === "settingsSearch") {
                    for (const key of ["fontFamily", "fontSize", "lineHeight", "color"]) assert.equal(measured.paint[key], reference.paint[key], key);
                    assert.equal(measured.paint.backgroundImage, "none");
                    assert.equal(measured.paint.borderRadius, "10px");
                    assert.equal(measured.glyph.width, 16 * scale / 100);
                    assert.equal(measured.glyph.centerOffset, 0);
                    assert.ok(measured.glyph.textGap >= 8 && measured.height >= 44);
                } else {
                    assert.deepEqual(measured.paint, reference.paint, id + " shares global paint and text metrics");
                    assert.deepEqual(measured.glyph, reference.glyph, id + " shares magnifier paint, baseline and text gap");
                    assert.equal(measured.height, reference.height);
                }
                assert.equal(measured.width, before.width);
                assert.equal(measured.height, before.height);
                assert.ok(measured.clear.width >= 44 && measured.clear.height >= 44 && measured.clear.inside && measured.clear.textGap >= 0 && measured.clear.reachable, JSON.stringify(measured));
                assert.equal(measured.overflow, false);
                if (id === "savedReportSearch" && width === 1280) assert.ok(measured.width <= 288, "Library stays compact");
                assert.equal(await input.evaluate((node, original) => node === original, identity), true);
                if (id === "settingsSearch") assert.equal(await input.evaluate(node => getComputedStyle(node.parentElement, "::before").outlineStyle), "solid");
                else await expect(input).toHaveCSS("outline-style", "solid");
                await capture(page, `${id}-${theme}-${width}-${scale}-typed`);
                await clear.click();
                await expect(input).toHaveValue(""); await expect(input).toBeFocused();
                await expect(global).toHaveValue("physician");
                assert.equal((await input.boundingBox()).width, before.width);
                await capture(page, `${id}-${theme}-${width}-${scale}-cleared`);
                evidence.push({ id, theme, width, scale, ...measured });
                await input.fill("unmatched field query");
                if (id !== "recollectSearch") {
                    await input.dispatchEvent("keydown", { key: "Escape", isComposing: true });
                    await expect(input).toHaveValue("unmatched field query");
                    await input.press("Escape"); await expect(input).toHaveValue("");
                } else await clear.click();
            }
            assert.equal(requests.filter(request => request.path.startsWith("/api/search/")).length, searchRequests, "Local fields never send a global query");
            await page.emulateMedia({ forcedColors: "active" });
            await input.focus(); await expect(input).toHaveCSS("background-image", "none");
            if (id === "settingsSearch") assert.equal(await input.evaluate(node => getComputedStyle(node.parentElement, "::before").outlineStyle), "solid");
            else await expect(input).toHaveCSS("outline-style", "solid");
            await capture(page, `${id}-${theme}-forced-colors`);
            await page.emulateMedia({ forcedColors: "none" });
            if (id === "recollectSearch") {
                await page.locator("#recollectSources input").first().check();
                await input.fill("Orchard"); await clear.click();
                await expect(page.locator("#recollectSelected")).toHaveText("1 selected");
                await input.fill("Orchard"); await input.press("Escape");
                await expect(input).toHaveValue("");
                await expect(page.locator("#recollectDialog")).toBeVisible();
                await input.press("Escape");
                await expect(page.locator("#recollectDialog")).not.toBeVisible();
                await page.locator("#recollectActivity").click();
                await expect(input).toHaveValue(""); await expect(clear).toBeHidden();
                await page.locator("#recollectClose").click();
            } else if (id === "settingsSearch") {
                await input.fill("theme");
                await page.locator("#settingsSearchResults a[data-setting=theme]").click();
                await expect(page.locator("[data-settings-section=display]")).toBeVisible();
                await page.goBack(); await expect(input).toHaveValue("theme");
                await clear.click();
            }
            await page.setViewportSize({ width: 1280, height: 1000 });
            await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        }
    }
    await navigateMain(page, "home");
    await page.locator("#comparePeriods").click();
    await page.getByRole("button", { name: "Search this comparison", exact: true }).click();
    await expect(global).toBeFocused();
    await expect(page.locator("#wireSearchScope")).toHaveValue("analysis");
    await expect(page.locator("#comparisonSearch")).toBeHidden();
    await expect(page.locator("#activitySearch")).toBeHidden();
    assert.equal(await page.locator("input[type=search]:visible").count(), 1);
    assert.doesNotMatch(JSON.stringify(requests.filter(request => !request.path.startsWith("/api/search/"))), /unmatched field query|Orchard|Hospital workflow/);
    if (proofs) await writeFile(path.join(proofs, "fields-in-context.json"), JSON.stringify(evidence, null, 2));
});

test("clearing local library and picker fields preserves other queries, history pages and hidden report selection", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t);
    await navigateMain(page, "settings");
    await page.locator("#settingsSearch").fill("theme");
    await navigateMain(page, "reports");
    await page.locator("#savedReportSearch").fill("Hospital");
    await chooseReportScope(page, "all");
    const summary = await page.locator("#scopeSummary").innerText();
    await page.getByRole("button", { name: "Next report requests", exact: true }).click();
    const pageText = await page.locator("#reportList .list-pager").innerText();
    await page.locator("#reportRequestSearch").fill("automobile");
    await expect(page.locator("#reportRequestSearchCount")).toContainText("All 19 remain included");
    await page.locator("#clearReportRequestSearch").click();
    assert.equal(await page.locator("#scopeSummary").innerText(), summary);
    assert.equal(await page.locator("#reportList .list-pager").innerText(), pageText);
    await expect(page.locator("#savedReportSearch")).toHaveValue("Hospital");
    await expect(page.locator("#settingsSearch")).toHaveValue("theme");
    await navigateMain(page, "reports");
    await page.locator("#clearSavedReportSearch").click();
    await expect(page.locator("#settingsSearch")).toHaveValue("theme");
    await navigateMain(page, "settings");
    await expect(page.locator("#settingsSearch")).toHaveValue("theme");
    assert.equal(new URL(page.url()).hash.includes("theme"), false);
    assert.equal(requests.some(request => request.path.startsWith("/api/search/")), false);
});
