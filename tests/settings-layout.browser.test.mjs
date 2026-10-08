import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { privateFixture, navigateSettings, selectActivityOption, chooseTheme, revealStoredRefresh } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WORKIQ_SETTINGS_LAYOUT_PROOFS;
async function ready(page) {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
}
async function setup(t, init) {
    const cleanups = [];
    const { context } = await privateFixture({ after: fn => cleanups.push(fn) });
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1466, height: 1100 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    if (init) await page.addInitScript(init);
    const errors = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (/\/api\/(?:collection\/(?:configure|enabled|now)|export|preview|record|privacy-review)$/.test(new URL(request.url()).pathname)) mutations.push(request.url());
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        for (const cleanup of cleanups) await cleanup();
        assert.deepEqual(errors, []);
        assert.deepEqual(mutations, [], "Layout proof never approves, collects, prepares or exports");
    });
    await page.goto(runtime.url + "#settings?section=display"); await ready(page);
    if (proofs) await mkdir(proofs, { recursive: true });
    return { page, runtime };
}
async function geometry(page, selector) {
    await page.evaluate(() => document.fonts.ready);
    return page.locator(selector).evaluate(pane => {
        const box = node => {
            const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
        };
        return {
            pane: box(pane), overflow: document.documentElement.scrollWidth > innerWidth,
            disclosureTextFits: [...pane.querySelectorAll("details>summary")].filter(node => node.checkVisibility()).every(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                return [...range.getClientRects()].every(rect => rect.bottom <= pane.getBoundingClientRect().bottom + 1);
            }),
            fields: [...pane.querySelectorAll(".settings-field")].map(field => {
                const control = field.querySelector(".select-trigger"), label = field.querySelector("label");
                const style = getComputedStyle(control), paint = getComputedStyle(control, "::before");
                const fieldStyle = getComputedStyle(field), fieldBox = box(field);
                const helpDisclosure = field.querySelector(":scope>details");
                const value = control.querySelector(".select-value");
                return {
                    id: control.id, field: box(field), control: box(control), label: label ? box(label) : null,
                    split: fieldStyle.gridTemplateColumns.split(" ").length === 2,
                    contentTop: fieldBox.y + parseFloat(fieldStyle.paddingTop) + parseFloat(fieldStyle.borderTopWidth),
                    contentBottom: helpDisclosure
                        ? box(helpDisclosure).y - parseFloat(getComputedStyle(helpDisclosure).marginTop) - parseFloat(fieldStyle.rowGap)
                        : fieldBox.bottom - parseFloat(fieldStyle.paddingBottom) - parseFloat(fieldStyle.borderBottomWidth),
                    rowDivider: parseFloat(fieldStyle.borderTopWidth),
                    value: box(value), chevron: box(control.querySelector(".select-chevron")),
                    fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight),
                    clipped: value.scrollWidth > value.clientWidth, text: value.textContent,
                    ink: style.color, fill: paint.backgroundColor, border: paint.borderTopWidth,
                    radius: paint.borderRadius, outline: paint.outlineWidth,
                    help: [...field.querySelectorAll("p")].filter(n => n.checkVisibility()).map(n => ({
                        ...box(n), text: n.textContent, lineHeight: parseFloat(getComputedStyle(n).lineHeight),
                        clipped: n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth,
                    })),
                };
            }),
        };
    });
}
function assertGeometry(data, scale) {
    assert.equal(data.overflow, false, "No document horizontal overflow");
    assert.equal(data.disclosureTextFits, true, "Wrapped disclosure text stays inside its visible pane");
    for (const field of data.fields) {
        assert.ok(field.control.height >= 44);
        assert.ok(field.control.height >= field.lineHeight + 16, "Enlarged type keeps vertical space inside the painted pill");
        assert.equal(field.fontSize, 14 * scale, "Use the shared Fluent control role without shrinking it to fit");
        assert.ok(field.value.height >= field.lineHeight - 1);
        assert.ok(field.control.width <= Math.min(field.field.width, (field.split ? 288 : 576) * scale) + 1,
            "Wide actions use the reference column; compact long values may use the available field width");
        if (field.split) {
            assert.ok(Math.abs(field.control.right - field.field.right) <= 1, "Wide setting controls share the row's right edge");
            assert.ok(Math.abs(field.control.y + field.control.height / 2 - (field.contentTop + field.contentBottom) / 2) <= 1, "The control is centered against its complete label/help group");
        } else assert.ok(Math.abs(field.control.x - field.field.x) <= 1, "Compact setting controls stack at the text edge");
        assert.ok(Math.abs(field.chevron.x - field.value.right - 8) <= 1, "Value and chevron keep the shared 8px icon gap");
        assert.ok(field.chevron.right <= field.control.right - 11);
        assert.equal(field.border, "1px");
        assert.ok(contrast(field.ink, field.fill) >= 4.5, "Selected value retains a readable tonal pair");
        if (field.label) {
            if (field.split) assert.ok(field.label.right + 23 <= field.control.x, "Wide label and action have a deliberate column gap");
            else assert.ok(field.label.bottom + 7 <= field.control.y);
        }
        for (const help of field.help) {
            assert.equal(help.clipped, false);
            if (field.split) {
                assert.ok(help.right + 23 <= field.control.x);
                assert.ok(Math.abs(help.x - field.field.x) <= 1);
            } else {
                assert.ok(help.y >= field.control.bottom + 7);
                assert.ok(Math.abs(help.x - field.control.x) <= 1);
            }
        }
    }
    for (let i = 1; i < data.fields.length; i++) {
        const previous = data.fields[i - 1], current = data.fields[i];
        assert.ok(Math.abs(current.field.y - previous.field.bottom) <= 1, "Stacked setting rows meet at one divider, not detached cards");
        assert.equal(current.rowDivider, 1);
        const previousContent = [previous.control, previous.label, ...previous.help].filter(Boolean);
        const currentContent = [current.control, current.label, ...current.help].filter(Boolean);
        assert.ok(Math.min(...currentContent.map(item => item.y)) - Math.max(...previousContent.map(item => item.bottom)) >= 47,
            "Both sides of the divider retain their 24px row inset");
        assert.ok(Math.abs(current.control.right - previous.control.right) <= 1 || Math.abs(current.control.x - previous.control.x) <= 1, "Peer controls share the wide right or compact left edge");
    }
}
async function assertPopup(page, label) {
    const popup = page.locator(".select-popup");
    await expect(popup).toBeVisible();
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(page.getByRole("option", { name: label, exact: true })).toBeVisible();
    const data = await popup.evaluate(popup => {
        const box = popup.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight,
            overflow: popup.scrollWidth > popup.clientWidth,
            clippedLabels: [...popup.querySelectorAll(".select-option-label")].some(n => n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth) };
    });
    assert.ok(data.left >= 7 && data.right <= data.width - 7);
    assert.ok(data.top >= 7 && data.bottom <= data.height - 7, `Popup stays inside the viewport: ${JSON.stringify(data)}`);
    assert.equal(data.overflow, false);
    assert.equal(data.clippedLabels, false);
}

test("reply saving gives a short connection prerequisite without an implicit opt-in", async t => {
    const { page } = await setup(t);
    await navigateSettings(page, "collection");
    await expect(page.locator("#assessmentSetup")).toHaveText("Connect a supported local Copilot source to save replies.");
    await expect(page.locator("#assessmentSetup input,#assessmentSetup button")).toHaveCount(0);
});

test("Time zone has a named category, matching glyph and help inside its setting rather than a separate section", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const values = [];
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(0, 0);
        if (proofs) await page.screenshot({ path: path.join(proofs, `time-zone-${theme}-closed.png`) });
        await page.locator("#displayScope>summary").click();
        const value = await page.evaluate(() => {
            const category = document.querySelector("#settingsCategoryNav [data-category=display]");
            const scope = document.getElementById("displayScope"), field = document.querySelector(".display-time-field");
            return {
                category: category.textContent, title: document.getElementById("displayTitle").textContent,
                icon: category.querySelector("[data-fluent-icon]").dataset.fluentIcon,
                helpInsideField: field.contains(scope), helpTitle: scope.querySelector("summary").textContent,
                helpBorder: getComputedStyle(scope).borderTopWidth,
            };
        });
        if (proofs) await page.screenshot({ path: path.join(proofs, `time-zone-${theme}-expanded.png`) });
        values.push(value);
        await page.locator("#displayScope>summary").click();
    }
    if (proofs) await writeFile(path.join(proofs, "time-zone-hierarchy.json"), JSON.stringify(values, null, 2));
    for (const value of values) {
        assert.equal(value.category, "Time zone");
        assert.equal(value.title, "Time zone");
        assert.equal(value.icon, "globe_clock_20_regular");
        assert.equal(value.helpInsideField, true);
        assert.equal(value.helpTitle, "About this time zone");
        assert.equal(value.helpBorder, "0px", "Help belongs to this field, not a new settings section");
    }
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1466]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1100 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const control = page.locator("#displayTimeZone-control"), summary = page.locator("#displayScope>summary");
        const before = await control.evaluate(node => {
            const box = node.getBoundingClientRect();
            return { top: box.top + scrollY, width: box.width, height: box.height };
        });
        await summary.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator("#displayScope")).toHaveAttribute("open", "");
        const measured = await page.locator(".display-time-field").evaluate(field => {
            const help = field.querySelector("#displayScope"), summary = help.querySelector("summary");
            const box = field.getBoundingClientRect(), helpBox = help.getBoundingClientRect();
            const control = field.querySelector(".select-trigger").getBoundingClientRect();
            return {
                contained: helpBox.left >= box.left && helpBox.right <= box.right && helpBox.bottom <= box.bottom,
                overflow: document.documentElement.scrollWidth > innerWidth,
                clipped: [...help.querySelectorAll("p,summary")].filter(node => node.checkVisibility())
                    .some(node => node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight),
                outline: getComputedStyle(summary).outlineStyle, height: summary.getBoundingClientRect().height,
                control: { top: control.top + scrollY, width: control.width, height: control.height },
            };
        });
        assert.equal(measured.contained, true);
        assert.equal(measured.overflow, false);
        assert.equal(measured.clipped, false);
        assert.equal(measured.outline, "solid");
        assert.ok(measured.height >= 44);
        assert.deepEqual(measured.control, before, `${theme}/${width}/${scale}: opening help does not move or resize the time-zone choice`);
        if (proofs && width === 375) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proofs, `time-zone-${theme}-${width}-${scale}-expanded.png`), fullPage: true });
        }
        await page.keyboard.press("Enter");
        await expect(page.locator("#displayScope")).not.toHaveAttribute("open", "");
    }
});

test("Time zone has one named heading, proportionate controls and vertically ordered Collection settings at every size", { timeout: 180000 }, async t => {
    const { page } = await setup(t);
    const trigger = page.getByRole("combobox", { name: "Time zone", exact: true });
    await expect(trigger).toHaveCount(1);
    await expect(page.locator("#displayTitle")).toHaveText("Time zone");
    await expect(page.locator("#displayTimeZone")).toHaveAttribute("aria-labelledby", "displayTitle");
    await expect(trigger).toHaveAttribute("aria-labelledby", "displayTitle");
    assert.equal(await page.locator("[data-settings-section=display] label").count(), 0);
    const reference = await geometry(page, "[data-settings-section=display]");
    assertGeometry(reference, 1);
    assert.ok(reference.fields[0].control.width <= 288, "The reference-style setting action column is bounded, not the former 576px");
    assert.ok(reference.fields[0].help[0].height / reference.fields[0].help[0].lineHeight <= 2, "Impact fits two untruncated lines at the desktop reference");
    await expect(page.locator("#displayTimeEffective")).toHaveText("Device zone: America/Los_Angeles.");
    await expect(page.locator("#displayTimeHelp")).toBeHidden();
    const longest = await page.locator("#displayTimeZone").evaluate(select => {
        const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
        context.font = getComputedStyle(document.querySelector("#displayTimeZone-control")).font;
        return [...select.options].map(option => ({ value: option.value, label: option.label, width: context.measureText(option.label).width }))
            .sort((a, b) => b.width - a.width).slice(0, 2);
    });
    const cases = [375, 820, 1200, 2560].map(width => ({ width, narrow: false })).concat({ width: 2560, narrow: true });
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const scale of [1, 2]) for (const config of cases) {
        await page.setViewportSize({ width: config.width, height: 1100 });
        await chooseTheme(page, theme);
        await page.evaluate(({ scale, narrow }) => {
            document.documentElement.style.fontSize = `${scale * 100}%`;
            document.querySelector("#settingsView").style.width = narrow ? "420px" : "";
        }, { scale, narrow: config.narrow });
        await navigateSettings(page, "display");
        await selectActivityOption(page, "displayTimeZone", ""); await ready(page);
        const normal = await geometry(page, "[data-settings-section=display]");
        assertGeometry(normal, scale);
        assert.ok(normal.fields[0].control.width <= 288 * scale);
        for (const zone of longest) {
            await selectActivityOption(page, "displayTimeZone", zone.value); await ready(page);
            const long = await geometry(page, "[data-settings-section=display]");
            assertGeometry(long, scale);
            assert.ok(long.fields[0].control.width >= normal.fields[0].control.width, "Long choices can use more room");
            if (long.fields[0].clipped) {
                await page.keyboard.press("Tab");
                await trigger.focus();
                await expect(page.getByRole("tooltip")).toHaveText(zone.label);
                await page.keyboard.press("Tab");
                await page.mouse.move(0, 0);
                await trigger.hover();
                await expect(page.getByRole("tooltip")).toHaveText(zone.label);
            }
            await trigger.click();
            await assertPopup(page, zone.label);
            await page.keyboard.press("Escape");
            measurements.push({ theme, scale, ...config, zone: zone.value, display: long });
        }
        await navigateSettings(page, "collection");
        const collection = await geometry(page, "[data-settings-section=collection]");
        assertGeometry(collection, scale);
        assert.deepEqual(collection.fields.map(field => field.id), ["collectionWindow-control", "collectionCadence-control"]);
        const visibility = await page.locator("[data-settings-section]").evaluateAll(panes => panes.map(pane => ({ section: pane.dataset.settingsSection, visible: pane.checkVisibility() })));
        assert.deepEqual(visibility.filter(pane => pane.visible).map(pane => pane.section), ["collection"]);
        await expect(trigger).toBeHidden();
        await expect(page.getByRole("textbox", { name: "Copilot metadata database", exact: true })).toHaveCount(0);
        if (config.narrow || config.width === 375) await expect(page.locator("#settingsCategorySummary")).toBeVisible();
        if (config.width === 2560 && !config.narrow && scale === 1) {
            const nav = await page.locator("#settingsCategories").boundingBox();
            assert.ok(nav.x + nav.width < collection.pane.x, "Internal left navigation remains beside the active pane");
        }
        measurements.push({ theme, scale, ...config, collection });
        if (proofs && (config.narrow || config.width === 375 || config.width === 2560)) {
            await page.locator("[data-settings-section=collection]").screenshot({ path: path.join(proofs, `collection-${theme}-${config.width}-${scale}-${config.narrow}.png`) });
            await navigateSettings(page, "display");
            await page.locator("[data-settings-section=display]").screenshot({ path: path.join(proofs, `display-${theme}-${config.width}-${scale}-${config.narrow}.png`) });
        }
    }
    if (proofs) await writeFile(path.join(proofs, "settings-layout-matrix.json"), JSON.stringify(measurements, null, 2));
});

test("simplified Display preserves typeahead, exact override context, pending/failure messaging and native focus states", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    const trigger = page.getByRole("combobox", { name: "Time zone", exact: true });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await trigger.focus();
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("option", { name: "Device default", exact: true })).toHaveAccessibleDescription("America/Los_Angeles");
        await page.keyboard.type("UTC"); await page.keyboard.press("Enter"); await ready(page);
        await expect(page.locator("#displayTimeEffective")).toHaveText("Override: UTC.");
        await expect(page.locator("#displayTimeZoneLink")).toHaveText("UTC");
        await page.locator("#displayScope>summary").click();
        await expect(page.locator("#displayTimeDevice")).toHaveText("Device/browser zone: America/Los_Angeles. Your override uses a different zone.");
        await page.locator("#displayScope>summary").click();
        await trigger.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
        const focused = await geometry(page, "[data-settings-section=display]");
        assert.equal(focused.fields[0].outline, "2px");
        await trigger.hover();
        assertGeometry(await geometry(page, "[data-settings-section=display]"), 1);
        await selectActivityOption(page, "displayTimeZone", ""); await ready(page);
        assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.time-zone")), null);
    }
    let release;
    await page.route("**/api/snapshot", async route => {
        if (route.request().postDataJSON().timeContext.timeZone !== "UTC") return route.continue();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Synthetic unavailable snapshot"}' });
    });
    await selectActivityOption(page, "displayTimeZone", "UTC");
    await expect(page.locator("#displayTimeEffective")).toHaveText("Current view: America/Los_Angeles. Updating the view before changing its time context.");
    await expect(page.locator("#displayTimeZoneLink")).toHaveText("Los Angeles time");
    release(); await ready(page);
    await expect(page.locator("#displayTimeEffective")).toHaveText("Current view: America/Los_Angeles. The selected zone has not loaded; retry the view update.");
    await expect(page.locator("#displayScope")).not.toHaveAttribute("open", "");
    await page.unroute("**/api/snapshot");
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await expect(page.locator("#displayTimeEffective")).toHaveText("Override: UTC.");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#displayTimeZone").evaluate(select => {
            select.disabled = true;
        });
        await expect(trigger).toBeDisabled();
        const disabled = await geometry(page, "[data-settings-section=display]");
        assert.ok(disabled.fields[0].control.height >= 44);
        assert.equal(disabled.fields[0].border, "1px");
        await page.locator("#displayTimeZone").evaluate(select => {
            select.disabled = false;
        });
        await ready(page);
    }
});

test("fallback, unavailable options and storage errors stay visible outside Display help through text enlargement", { timeout: 60000 }, async t => {
    const { page } = await setup(t, () => {
        localStorage.setItem("workiq-evidence.time-zone", "Invalid/Synthetic_Zone");
        Intl.supportedValuesOf = undefined;
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            if (key === "workiq-evidence.time-zone") throw new DOMException("Synthetic denied", "SecurityError");
            return set.call(this, key, value);
        };
    });
    await expect(page.locator("#timeZoneNotice")).toContainText("invalid or unavailable");
    await expect(page.locator("#displayTimeEffective")).toHaveText("Device zone: America/Los_Angeles.");
    await expect(page.locator("#displayTimeHelp")).toContainText("full time zone list");
    await selectActivityOption(page, "displayTimeZone", "UTC"); await ready(page);
    await expect(page.locator("#timeZoneNotice")).toContainText("this panel only until reload");
    await expect(page.locator("#displayTimeZone-control")).toHaveAttribute("aria-describedby", /timeZoneNotice/);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1100 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await expect(page.locator("#displayScope")).not.toHaveAttribute("open", "");
        for (const id of ["timeZoneNotice", "displayTimeHelp"]) {
            const notice = page.locator("#" + id);
            await expect(notice).toBeVisible();
            assert.deepEqual(await notice.evaluate(node => ({
                collapsed: Boolean(node.closest("details:not([open])")),
                clipped: node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth,
            })), { collapsed: false, clipped: false });
        }
        assertGeometry(await geometry(page, "[data-settings-section=display]"), scale);
    }
});
