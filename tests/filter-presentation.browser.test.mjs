import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { chooseTheme, selectActivityOption } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";
import { createSelectControls } from "../web/select-control.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";

const proofDir = process.env.WIRE_FILTER_PRESENTATION_PROOFS;
const ready = page => page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
const fields = [
    ["dateFilter", "Dates"], ["toolFilter", "Tool"], ["serviceAssociationFilter", "Service involved"],
    ["outcomeFilter", "Outcome"], ["promptAuthorFilter", "Prompt author"],
    ["serviceFilter", "Activity category"], ["projectFilter", "Copilot project"],
    ["chatFilter", "Copilot chat"], ["layerFilter", "Evidence layer"], ["scopeFilter", "Collection"],
];

test("all filter menus use clean paper surfaces and self-explanatory controls without losing feedback", { timeout: 60000 }, async t => {
    const app = await authorFilterFixture(t, { serviceCases: true }), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC", hasTouch: true });
    page.setDefaultTimeout(8000);
    const errors = [], denied = [], reads = [], observations = [], violations = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const safe = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary", "/api/report-artifacts/list"];
        if (url.origin !== new URL(app.runtime.url).origin || request.method() !== "GET" && !safe.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        if (url.pathname === "/api/snapshot") reads.push(request.postDataJSON());
        return route.continue();
    });
    app.closeClient(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(denied, []); });
    if (proofDir) await mkdir(proofDir, { recursive: true });
    await page.goto(app.runtime.url); await ready(page);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(async scale => {
            document.documentElement.style.fontSize = `${scale * 100}%`;
            await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            scrollTo(0, 0);
        }, scale);
        const name = `${theme}-${width}-${scale}`, paper = theme === "light" ? "rgb(255, 255, 255)" : "rgb(25, 25, 25)";
        if (await page.locator("#filters .ux-help").count()) violations.push(`${name}: routine field info targets remain`);
        if (proofDir) await page.screenshot({ path: path.join(proofDir, `context-${name}.png`), fullPage: true });
        if (!await page.locator("#moreFilters").evaluate(node => node.open)) await page.locator("#moreFiltersToggle").click();
        const before = reads.length;
        for (const [id, label] of fields) {
            const trigger = page.locator("#" + id + "-control");
            const actualLabel = await page.locator(`label[for="${id}-control"]`).innerText();
            if (actualLabel !== label) violations.push(`${name}/${id}: label is ${actualLabel}`);
            await trigger.click();
            const popup = page.locator(".select-popup:visible");
            const paint = await popup.evaluate((node, id) => {
                const trigger = document.getElementById(id + "-control");
                const css = getComputedStyle(node), b = node.getBoundingClientRect();
                const rows = [...node.querySelectorAll(".select-option")].map(row => {
                    const label = row.querySelector(".result-option-label") || row.querySelector(".select-option-label");
                    return { value: row.dataset.value, background: getComputedStyle(row).backgroundColor,
                        color: getComputedStyle(label).color, height: row.getBoundingClientRect().height,
                        selected: row.getAttribute("aria-selected"), role: row.getAttribute("role") };
                });
                const apply = node.querySelector(".select-apply");
                return { background: css.backgroundColor, trigger: getComputedStyle(trigger, "::before").backgroundColor,
                    rows, apply: apply && getComputedStyle(apply, "::before").backgroundColor,
                    routineHint: node.querySelector(".select-draft-hint:not([hidden]),.select-validation:not([hidden])")?.textContent || "",
                    all: node.querySelector(".select-all")?.textContent.trim() || "",
                    box: { x: b.x, y: b.y, right: b.right, bottom: b.bottom } };
            }, id);
            if (paint.background !== paper || paint.trigger !== paper) violations.push(`${name}/${id}: trigger/menu is not paper`);
            if (paint.rows.some(row => !["rgba(0, 0, 0, 0)", paper].includes(row.background))) violations.push(`${name}/${id}: filled option slabs`);
            if (paint.apply && paint.apply !== paper) violations.push(`${name}/${id}: filled Apply capsule`);
            if (paint.routineHint) violations.push(`${name}/${id}: routine draft instruction remains`);
            if (paint.all && !paint.all.startsWith("All ")) violations.push(`${name}/${id}: imperative All caption`);
            assert.ok(paint.box.x >= 8 && paint.box.right <= width - 7 && paint.box.y >= 8 && paint.box.bottom <= 993);
            for (const row of paint.rows) {
                assert.ok(row.height >= 44, `${name}/${id}/${row.value}`);
                assert.equal(row.role, "option");
                assert.ok(contrast(row.color, paper) >= 4.5, `${name}/${id}/${row.value}: text contrast`);
            }
            assert.deepEqual(await popup.locator("[aria-describedby],[aria-labelledby]").evaluateAll(nodes => nodes.flatMap(node =>
                ["aria-describedby", "aria-labelledby"].flatMap(name => (node.getAttribute(name) || "").split(/\s+/).filter(id => id && !document.getElementById(id))))), [],
            "Menu names and descriptions never refer to removed help");
            if (proofDir && ["outcomeFilter", "promptAuthorFilter", "serviceFilter", "layerFilter"].includes(id)) {
                await page.screenshot({ path: path.join(proofDir, `menu-${id}-${name}.png`) });
            }
            if (["outcomeFilter", "promptAuthorFilter"].includes(id)) {
                await popup.getByRole("checkbox").click();
                assert.equal(await popup.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
                assert.match(await popup.innerText(), /Select at least one/);
                if (proofDir && id === "outcomeFilter") await page.screenshot({ path: path.join(proofDir, `empty-${name}.png`) });
                await popup.getByRole("option").first().click();
                assert.equal(await popup.getByRole("button", { name: "Apply", exact: true }).isDisabled(), false);
                assert.equal(await popup.locator(".select-validation:visible").count(), 0);
                assert.equal(await popup.getByRole("checkbox").getAttribute("aria-checked"), "mixed");
                const first = popup.getByRole("option").first();
                assert.equal(await first.getAttribute("aria-selected"), "true");
                assert.ok(["rgba(0, 0, 0, 0)", paper].includes(await first.evaluate(node => getComputedStyle(node).backgroundColor)));
                assert.equal(await popup.locator(".select-apply").evaluate(node => getComputedStyle(node, "::before").backgroundColor), paper);
                assert.notEqual(await popup.locator(".select-apply").evaluate(node => getComputedStyle(node, "::before").borderColor),
                    await popup.getByRole("button", { name: "Cancel", exact: true }).evaluate(node => getComputedStyle(node, "::before").borderColor));
                if (proofDir && id === "outcomeFilter") await page.screenshot({ path: path.join(proofDir, `partial-${name}.png`) });
                await popup.getByRole("button", { name: "Cancel", exact: true }).click();
            } else {
                await trigger.press("End"); await trigger.press("Escape");
            }
            assert.equal(await page.evaluate(() => document.activeElement.id), id + "-control");
            await trigger.press("ArrowDown");
            const focused = page.locator(".select-popup:visible .select-option[data-active=true]");
            assert.equal(await trigger.getAttribute("aria-activedescendant"), await focused.getAttribute("id"));
            assert.equal(await focused.evaluate(node => getComputedStyle(node).outlineStyle), "solid");
            assert.ok(await focused.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth)) >= 2);
            assert.ok(contrast(await focused.evaluate(node => getComputedStyle(node).outlineColor), paper) >= 3);
            if (proofDir && id === "outcomeFilter") await page.screenshot({ path: path.join(proofDir, `keyboard-${name}.png`) });
            await trigger.press("Escape");
            observations.push({ name, id, label: actualLabel, ...paint });
        }
        assert.equal(reads.length, before, "Opening, navigating and discarding menus cannot apply a filter or operate collection");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.locator("#moreFiltersToggle").click();
        await selectActivityOption(page, "outcomeFilter", ["failure"]); await ready(page);
        await selectActivityOption(page, "promptAuthorFilter", ["user"]); await ready(page);
        const activePaint = await page.locator("#filters .select-trigger[data-filter-active=true]").evaluateAll(nodes =>
            nodes.map(node => getComputedStyle(node, "::before").backgroundColor));
        assert.equal(activePaint.length, 2);
        assert.ok(activePaint.every(color => color === paper));
        if (proofDir) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proofDir, `active-${name}.png`), fullPage: true });
        }
        await page.getByRole("button", { name: /^Remove outcome filter:/ }).click(); await ready(page);
        await page.getByRole("button", { name: /^Remove author filter:/ }).click(); await ready(page);
    }
    await selectActivityOption(page, "layerFilter", "code-reference"); await ready(page);
    assert.equal(await page.locator("#outcomeFilter-control").isDisabled(), true);
    assert.match(await page.locator("#resultFilterScope").innerText(), /execution is not observed/);
    assert.equal(await page.locator("#outcomeFilter-control").evaluate(node => getComputedStyle(node, "::before").borderStyle), "dashed");
    if (proofDir) await writeFile(path.join(proofDir, "presentation.json"), JSON.stringify({ observations, violations, reads: reads.length }, null, 2));
    assert.deepEqual(violations, []);
});

test("native opt-in outside Analyze reuses the filter presentation without changing single-choice semantics", { timeout: 20000 }, async t => {
    const browser = await chromium.launch(), page = await browser.newPage({ reducedMotion: "reduce" }), errors = [], external = [];
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(external, []); });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => { external.push(route.request().url()); return route.abort(); });
    await page.setContent(`<style>${styles}</style><section aria-label="Isolated presentation contract">
        <label>Search scope<select id="scope" data-select-presentation="filter"><option value="everywhere">Everywhere</option><option value="analysis">Current Analyze scope</option></select></label>
        <label>Result type<select id="type" data-select-presentation="filter"><option value="">All types</option><option value="setting">Settings</option></select></label>
        <label>Ordinary select<select id="ordinary"><option>First</option><option>Second</option></select></label>
        <label>Ordinary multiple<select id="ordinaryMultiple" multiple data-select-mode="multiple"><option selected>First</option><option selected>Second</option></select></label>
        <button class="wire-search-hit">Invented result, not a filter option</button>
    </section>`);
    await page.addScriptTag({ content: `window.controlChanges=[];document.addEventListener("change",event=>controlChanges.push(event.target.id));
        window.controls=(${createSelectControls.toString()})((${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)}));` });
    for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => {
            document.documentElement.dataset.evidenceTheme = theme;
            for (const id of ["scope", "type"]) document.getElementById(id).selectedIndex = 0;
            window.controlChanges = []; window.controls.sync();
        }, theme);
        const paper = theme === "light" ? "rgb(255, 255, 255)" : "rgb(25, 25, 25)";
        for (const [id, value] of [["scope", "analysis"], ["type", "setting"]]) {
            const trigger = page.locator(`#${id}-control`);
            assert.equal(await trigger.evaluate(node => node.classList.contains("select-trigger-filter")), true);
            assert.equal(await trigger.evaluate(node => getComputedStyle(node, "::before").backgroundColor), paper);
            assert.equal(await trigger.evaluate(node => getComputedStyle(node).borderRadius), "24px");
            assert.equal(await trigger.evaluate(node => getComputedStyle(node).fontWeight), "400");
            await trigger.click();
            const popup = page.locator(".select-popup:visible");
            assert.equal(await popup.evaluate(node => node.classList.contains("select-popup-filter")), true);
            assert.equal(await popup.getByRole("listbox").getAttribute("aria-multiselectable"), null);
            assert.equal(await popup.locator(".select-toggle,.select-footer,.select-all").count(), 0);
            await trigger.press("ArrowDown"); await trigger.press("Enter");
            assert.equal(await page.locator("#" + id).inputValue(), value);
            assert.equal(await page.evaluate(id => window.controlChanges.filter(value => value === id).length, id), 1);
        }
        await page.locator("#ordinary-control").click();
        assert.equal(await page.locator(".select-popup:visible").evaluate(node => node.classList.contains("select-popup-filter")), false);
        await page.keyboard.press("Escape");
        await page.locator("#ordinaryMultiple-control").click();
        const ordinaryPopup = page.locator(".select-popup:visible");
        assert.equal(await ordinaryPopup.evaluate(node => node.classList.contains("select-popup-filter")), false);
        assert.equal(await ordinaryPopup.getByRole("listbox").getAttribute("aria-multiselectable"), "true");
        assert.match(await ordinaryPopup.locator(".select-draft-hint").innerText(), /Apply/);
        assert.equal(await ordinaryPopup.locator(".select-apply").evaluate(node => node.classList.contains("primary")), true);
        await ordinaryPopup.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(await page.locator(".wire-search-hit").evaluate(node => node.classList.contains("select-trigger-filter")), false);
        assert.equal(await page.locator(".wire-search-hit .select-toggle").count(), 0);
    }
});
