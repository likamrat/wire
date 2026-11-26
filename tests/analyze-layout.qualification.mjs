import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { frontendRecords } from "./frontend-fixture.mjs";
import { searchFixture } from "./live-search-fixture.mjs";

const standard = ["time", "outcomes", "usage", "interactions", "tools", "services", "models", "authors"];
const previewSelector = "#analyzeLayout [data-tile]";
const homeSelector = ".analyze-chart-main,.analyze-outcome-summary,#activityView,.percentage-card[data-breakdown]:not([data-breakdown=outcomes])";

// Read actual painted rectangles, not CSS grid declarations or the layout helper.
function geometry(selector) {
    const cards = [...document.querySelectorAll(selector)].filter(n => n.checkVisibility()).map(n => {
        const key = n.dataset.tile ?? n.dataset.breakdown ?? (n.id === "activityView" ? "interactions"
            : n.classList.contains("analyze-chart-main") ? "time" : "outcomes");
        return { key, ...n.getBoundingClientRect().toJSON() };
    });
    const left = Math.min(...cards.map(c => c.left)), right = Math.max(...cards.map(c => c.right));
    return {
        dom: cards.map(c => c.key),
        paint: cards.toSorted((a, b) => a.top - b.top || a.left - b.left).map(c => [
            c.key, c.left > left + 1 ? "right" : c.right >= right - 1 ? "full" : "left",
        ]),
        overlaps: cards.flatMap((a, i) => cards.slice(i + 1).filter(b =>
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1).map(b => `${a.key}/${b.key}`)),
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
}

function verify(actual, order, narrow) {
    assert.deepEqual(actual.dom, order);
    assert.deepEqual(actual.paint.map(([key]) => key), order);
    assert.deepEqual(actual.overlaps, []);
    assert.equal(actual.overflow, false);
    const full = ["time","outcomes","usage","interactions"];
    let index = 0;
    while (index < order.length) {
        if (narrow || full.includes(order[index]) || !order[index + 1] || full.includes(order[index+1])) {
            assert.equal(actual.paint[index++][1], "full");
        } else {
            assert.equal(actual.paint[index][1], "left", `${order[index]} should start the row before ${order[index + 1]}`);
            index++;
            assert.equal(actual.paint[index++][1], "right");
        }
    }
}

function settingsRows() {
    return [...document.querySelectorAll("#analyzeLayout li")].map(n => [
        n.dataset.section, n.querySelector('[data-step="-1"]').disabled, n.querySelector('[data-step="1"]').disabled,
    ]);
}

for (const frontend of ["bundled", "react"]) test(`${frontend}: Analyze layout controls, cross-tab placement and cold persistence`, async t => {
    const cleanups = [], errors = [];
    let context;
    t.after(async () => {
        try { await context?.close(); } finally { for (const close of cleanups) await close(); }
    });
    const { runtime, root } = await searchFixture({ after: fn => cleanups.push(fn) },
        { frontend, records: frontendRecords(3), reply: false });
    const settingsUrl = new URL("/settings?section=analyze", runtime.url).href;
    const openProfile = async () => {
        context = await chromium.launchPersistentContext(path.join(root, "layout-chromium"), {
            viewport: { width: 1440, height: 960 }, reducedMotion: "reduce",
        });
        context.on("page", p => p.on("pageerror", e => errors.push(e.message)));
    };
    await openProfile();
    let settings = await context.newPage();
    const home = await context.newPage(), phone = await context.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await settings.goto(settingsUrl);
    await Promise.all([home, phone].map(async page => {
        await page.goto(runtime.url);
        await expect(page.locator("#activityList .activity-card")).toHaveCount(3);
        await page.evaluate(() => document.fonts.ready);
    }));
    const assertSettings = async order => {
        assert.deepEqual(await settings.evaluate(settingsRows), order.map((key, i) => [key, i === 0, i === order.length-1]));
        const preview = await settings.evaluate(geometry, previewSelector);
        verify(preview, order, false);
    };
    const checkHome = async (page, order, narrow) => {
        // Other tabs receive a real browser storage event asynchronously.
        await page.waitForFunction(({ selector, first, signature }) => {
            const nodes = [...document.querySelectorAll(selector)];
            return nodes.length === signature.split(",").length && (first
                ? !document.querySelector(".analyze-ordered-widgets")
                : nodes.map(n => n.dataset.homeSection).join(",") === signature);
        }, { selector: homeSelector, first: order.join() === standard.join(), signature: order.join() },
        { polling: 10, timeout: 5000 });
        verify(await page.evaluate(geometry, homeSelector), order, narrow);
    };
    const order = [...standard];
    async function move(key, step) {
        await settings.locator(`#analyzeLayout li[data-section="${key}"] button[data-step="${step}"]`).press("Enter");
        const index = order.indexOf(key), next = index + step;
        [order[index], order[next]] = [order[next], order[index]];
        await assertSettings(order);
    }
    const checkTabs = async () => {
        await checkHome(phone, order, true);
        await checkHome(home, order, false);
    };
    await assertSettings(order);
    await checkTabs();
    for (const key of standard) {
        const step = key === standard[0] ? 1 : -1;
        await move(key, step);
        if (key === "tools") await checkTabs(); // Full-width Interactions separates two runs of breakdowns.
        await move(key, -step);
    }

    await move("authors", -1);
    await move("authors", -1);
    await move("authors", -1);
    await t.test("placing Authors first among breakdowns matches the preview on both tabs", checkTabs);

    async function coldRead(order) {
        await context.close(); await openProfile();
        settings = await context.newPage(); await settings.goto(settingsUrl);
        await expect(settings.locator("#analyzeLayout")).toBeVisible();
        await assertSettings(order);
        await settings.getByRole("link", { name: "View Analyze" }).click();
        await expect(settings.locator("#activityList .activity-card")).toHaveCount(3);
        await checkHome(settings, order, false);
        await settings.reload();
        await expect(settings.locator("#activityList .activity-card")).toHaveCount(3);
        await checkHome(settings, order, false);
    }
    await t.test("custom and restored layouts survive a browser restart", async () => {
        await move("authors", 1);
        await coldRead(order);
        await settings.goto(settingsUrl);
        await settings.getByRole("button", { name: "Restore WIRE Default Layout" }).click();
        await assertSettings(standard);
        await coldRead(standard);
    });
    assert.deepEqual(errors, []);
});
