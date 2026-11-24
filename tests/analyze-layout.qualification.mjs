import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { frontendRecords } from "./frontend-fixture.mjs";
import { searchFixture } from "./live-search-fixture.mjs";

const standard = ["time", "outcomes", "usage", "interactions", "tools", "services", "models", "authors"];
const permutations = standard.reduce((n, _, i) => n * (i+1), 1);
const previewSelector = "#analyzeLayout [data-tile]";
const homeSelector = ".analyze-chart-main,.analyze-outcome-summary,#activityView,.percentage-card[data-breakdown]:not([data-breakdown=outcomes])";

// Inserting each new item alternately from the right and the left visits all
// permutations exactly once; consecutive layouts differ by one arrow press.
function* adjacentOrders(keys) {
    if (!keys.length) { yield []; return; }
    let forward = false;
    for (const shorter of adjacentOrders(keys.slice(0, -1))) {
        for (let i = 0; i <= shorter.length; i++) {
            const copy = [...shorter];
            copy.splice(forward ? i : shorter.length - i, 0, keys.at(-1));
            yield copy;
        }
        forward = !forward;
    }
}

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
    let index = 0;
    while (index < order.length) {
        if (narrow || order[index] === "interactions" || !order[index + 1] || order[index + 1] === "interactions") {
            assert.equal(actual.paint[index++][1], "full");
        } else {
            assert.equal(actual.paint[index++][1], "left");
            assert.equal(actual.paint[index++][1], "right");
        }
    }
}

function settingsRows() {
    return [...document.querySelectorAll("#analyzeLayout li")].map(n => [
        n.dataset.section, n.querySelector('[data-step="-1"]').disabled, n.querySelector('[data-step="1"]').disabled,
    ]);
}

for (const frontend of ["bundled", "react"]) test(`${frontend}: all ${permutations} Analyze layouts and cold persistence`, async t => {
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
    const seen = new Set(), moved = new Set();
    let previous;
    for (const order of adjacentOrders(standard)) {
        const signature = order.join();
        assert.ok(!seen.has(signature));
        try {
            if (previous) {
                const i = previous.findIndex((key, index) => key !== order[index]);
                // Both buttons implement the swap. Prefer untested controls, then alternate.
                const up = `${previous[i + 1]}/-1`, down = `${previous[i]}/1`;
                const useUp = !moved.has(up) || moved.has(down) && seen.size % 2 === 0;
                const key = previous[useUp ? i + 1 : i], step = useUp ? -1 : 1;
                await settings.locator(`#analyzeLayout li[data-section="${key}"] button[data-step="${step}"]`).press("Enter");
                moved.add(`${key}/${step}`);
            }
            await Promise.all([assertSettings(order), checkHome(home, order, false), checkHome(phone, order, true)]);
        } catch (cause) {
            throw new Error(`Layout ${seen.size + 1}/${permutations} (${signature}) after ${previous?.join() ?? "fresh entry"}`, { cause });
        }
        seen.add(signature); previous = order;
    }
    assert.equal(seen.size, permutations);
    assert.equal(moved.size, standard.length*2);
    t.diagnostic(`${seen.size} distinct orders, ${moved.size} arrow controls, preview plus wide and phone Analyze`);

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
    await coldRead(previous);
    await settings.goto(settingsUrl);
    await settings.getByRole("button", { name: "Restore WIRE layout" }).click();
    await assertSettings(standard);
    await coldRead(standard);
    assert.deepEqual(errors, []);
});
