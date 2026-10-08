import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { chooseTheme, selectActivityOption } from "./helpers.mjs";

const proofs = process.env.WIRE_PRIMARY_FILTER_PROOFS;
const ids = ["dateFilter", "outcomeFilter", "promptAuthorFilter"];
const ready = page => page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");

async function setup(t) {
    const app = await authorFilterFixture(t), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const errors = [], blocked = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(app.runtime.url).origin || /\/api\/(?:collection\/(?:now|configure|enabled)|evaluation\/(?:start|automatic\/(?:approve|revoke)))/.test(url.pathname)) {
            blocked.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    app.closeClient(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(blocked, []); });
    await page.goto(app.runtime.url); await ready(page);
    if (proofs) await mkdir(proofs, { recursive: true });
    return { ...app, page };
}

async function geometry(page) {
    return page.evaluate(ids => {
        const box = node => {
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
        };
        const fields = ids.map(id => {
            const control = document.getElementById(id + "-control");
            const label = document.querySelector(`label[for="${id}-control"]`);
            const value = control.querySelector(".select-value");
            const labelRange = document.createRange();
            labelRange.selectNodeContents(label);
            const labelText = labelRange.getBoundingClientRect();
            return { id, control: box(control), label: box(label), labelText: { x: labelText.x, y: labelText.y, bottom: labelText.bottom }, value: box(value),
                textClipped: value.scrollWidth > value.clientWidth + 1 };
        });
        return { fields, overflow: document.documentElement.scrollWidth - innerWidth,
            row: box(document.querySelector(".period-controls")) };
    }, ids);
}
const range = values => Math.max(...values) - Math.min(...values);
function aligned(layout, stacked) {
    assert.ok(layout.overflow <= 1, "No page-level horizontal overflow");
    assert.ok(range(layout.fields.map(field => field.control.width)) <= 1, "The three dropdowns use equal widths");
    assert.ok(layout.fields.every(field => field.control.height >= 44 && !field.textClipped), "Labels stay readable with 44px hit targets");
    assert.ok(range(layout.fields.map(field => field.label.x - field.control.x)) <= 1, "Label insets are consistent");
    if (stacked) {
        assert.ok(range(layout.fields.map(field => field.control.x)) <= 1, "Stacked controls align on the same left edge");
        for (let index = 1; index < layout.fields.length; index++) {
            assert.ok(layout.fields[index].label.y >= layout.fields[index - 1].control.bottom, "Stacked fields never overlap");
        }
    } else {
        assert.ok(range(layout.fields.map(field => field.control.y)) <= 1, "Dropdown top edges align");
        assert.ok(range(layout.fields.map(field => field.control.height)) <= 1, "Dropdown heights match");
        assert.ok(range(layout.fields.map(field => field.labelText.y)) <= 1, "Label text shares one baseline");
        const gaps = layout.fields.slice(1).map((field, index) => field.control.x - layout.fields[index].control.right);
        assert.ok(gaps.every(gap => gap >= 12 && gap <= 20), "No invisible clear-button gutters between filters");
        assert.ok(range(gaps) <= 1, "Field gaps are uniform");
    }
}

test("primary filters have equal widths, aligned labels and compact consistent gaps", { timeout: 45000 }, async t => {
    const { page } = await setup(t), measurements = [];
    for (const theme of ["dark", "light"]) for (const width of [1200, 1040, 820, 375]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.locator("#filters").scrollIntoViewIfNeeded();
        const layout = await geometry(page);
        if (proofs) await page.locator("#filters").screenshot({ path: path.join(proofs, `primary-${theme}-${width}.png`) });
        aligned(layout, width <= 820);
        measurements.push({ theme, width, ...layout });
    }
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    const enlarged = await geometry(page);
    aligned(enlarged, true);
    if (proofs) {
        await page.locator("#filters").screenshot({ path: path.join(proofs, "primary-200-percent.png") });
        await writeFile(path.join(proofs, "geometry.json"), JSON.stringify([...measurements, { scale: 2, ...enlarged }], null, 2));
    }
});

async function applyValues(page, id, values) {
    await page.locator(`[data-select-id="${id}"]`).click();
    const popup = page.locator(".select-popup:visible");
    for (const option of await popup.locator(".select-option").all()) {
        const wanted = values.includes(await option.getAttribute("data-value"));
        if ((await option.getAttribute("aria-selected") === "true") !== wanted) await option.click();
    }
    await popup.getByRole("button", { name: "Apply", exact: true }).click(); await ready(page);
}

test("active clear actions and custom dates keep dropdown geometry and filtering intact", { timeout: 45000 }, async t => {
    const { page, olderDay } = await setup(t);
    const original = await geometry(page);
    await applyValues(page, "outcomeFilter", ["failure"]);
    await applyValues(page, "promptAuthorFilter", ["user"]);
    assert.equal(await page.locator("#activityCount").textContent(), "1");
    const filtered = await geometry(page);
    aligned(filtered, false);
    for (const [index, field] of filtered.fields.entries()) {
        assert.ok(Math.abs(field.control.x - original.fields[index].control.x) <= 1);
        assert.ok(Math.abs(field.control.width - original.fields[index].control.width) <= 1, "Showing Clear does not shrink the dropdown");
    }
    for (const id of ["clearResultFilter", "clearPromptAuthorFilter"]) {
        const clear = page.locator("#" + id), bounds = await clear.boundingBox();
        assert.ok(bounds.width >= 44 && bounds.height >= 44);
        const field = filtered.fields[id === "clearResultFilter" ? 1 : 2];
        assert.ok(bounds.y + bounds.height <= field.control.y + 1, "Clear is above its dropdown, not an extra inter-field gap");
        assert.ok(bounds.x >= field.label.right, "Clear does not overlap its label");
    }
    if (proofs) await page.locator("#filters").screenshot({ path: path.join(proofs, "primary-active.png") });
    await page.getByRole("button", { name: "Clear prompt author filter", exact: true }).click(); await ready(page);
    assert.equal(await page.locator("#activityCount").textContent(), "2");
    await page.getByRole("button", { name: "Clear recorded result filter", exact: true }).click(); await ready(page);
    assert.equal(await page.locator("#activityCount").textContent(), "8");
    await selectActivityOption(page, "dateFilter", "custom"); await ready(page);
    aligned(await geometry(page), false);
    const custom = await page.locator("#dateFields").boundingBox(), layout = await geometry(page);
    assert.ok(custom.y >= Math.max(...layout.fields.map(field => field.control.bottom)), "Custom dates occupy their own row");
    await page.locator("#fromFilter").fill(olderDay); await page.locator("#toFilter").fill(olderDay);
    await page.locator("#applyDates").click(); await ready(page);
    assert.equal(await page.locator("#activityCount").textContent(), "5");
    if (proofs) await page.locator("#filters").screenshot({ path: path.join(proofs, "primary-custom-dates.png") });
    await page.locator('[data-select-id="promptAuthorFilter"]').click();
    const popup = page.locator(".select-popup:visible");
    await popup.locator('[data-value="agent"]').click();
    await popup.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.locator("#activityCount").textContent(), "5");
});
