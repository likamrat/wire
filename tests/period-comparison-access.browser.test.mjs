import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, restoreLegacySearch } from "./helpers.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";

// Only the agreed transport boundary is controlled. Requests and comparison admission remain real.
function accessBoundary(options) {
    let open = true, epoch = 0, override = null;
    const issued = new WeakMap();
    const control = { generation: 7, calls: 0, navigations: 0, accepted: 0, pairs: [], holdNext: false, pending: null };
    const publicationToken = () => {
        if (!open) return null;
        const token = Object.freeze({}); issued.set(token, epoch); return token;
    };
    const isCurrent = token => Boolean(token && open && issued.get(token) === epoch);
    const api = Object.assign(async (...args) => {
        if (args[0] === "/api/period-comparison") {
            control.calls++;
            if (!open) throw Error("Private dispatch while unavailable.");
            const hold = control.holdNext; control.holdNext = false;
            const value = await options.api(...args);
            if (hold) return new Promise((resolve, reject) => {
                control.pending = { resolve: () => { control.pending = null; resolve(value); },
                    reject: () => { control.pending = null; reject(Error("PRIVATE_LATE_ERROR")); } };
            });
            return value;
        }
        return options.api(...args);
    }, { publicationToken, isCurrent });
    const owner = assessmentFactories.periodComparison.mount({
        ...options, api,
        getContext: () => ({ ...options.getContext(), ...override }),
        navigate: (...args) => {
            control.navigations++;
            const result = options.navigate(...args);
            return control.holdNavigation ? Promise.resolve(result).then(value => new Promise(resolve => {
                control.finishNavigation = () => resolve(value);
            })) : result;
        },
        onPairChange: pair => {
            options.onPairChange?.(pair);
            control.pairs.push(pair ? { key: pair.key, revision: pair.revision } : null);
            if (pair && control.withdrawOnPublish) { control.withdrawOnPublish = false; control.withdraw(); }
        },
        onAccepted: (...args) => { options.onAccepted?.(...args); control.accepted++; },
        recordLink: (...args) => {
            const link = options.recordLink(...args);
            if (control.withdrawDuringPaint) { control.withdrawDuringPaint = false; control.withdraw(); }
            return link;
        },
    });
    control.withdraw = () => {
        open = false; epoch++;
        override = { snapshot: null, search: "", semanticSearch: undefined, isLoading: true, isStale: true };
        options.root.hidden = true; options.setup.hidden = true;
        owner.withdrawAccess();
    };
    control.resume = () => { open = true; return owner.resumeAccess(); };
    control.expire = () => { open = false; epoch++; };
    control.token = publicationToken;
    control.isCurrent = isCurrent;
    control.removeMethods = () => { delete api.publicationToken; delete api.isCurrent; };
    control.fresh = async () => {
        const token = publicationToken(), current = options.getContext();
        const snapshot = await options.api("/api/snapshot", current.options);
        if (!isCurrent(token)) throw Error("Fresh fixture snapshot was withdrawn.");
        override = { snapshot, search: "", semanticSearch: undefined, isLoading: false, isStale: false };
        await owner.update();
    };
    window.compareAccess = control; window.periodComparisonOwner = owner;
    return owner;
}

async function setup(t, { privateSearch = false, holdImport } = {}) {
    const { records } = periodFixture();
    for (const record of records) record.title = "PRIVATE_COMPARE_TITLE";
    let cleanup;
    const { context } = await privateFixture({ after: fn => { cleanup = fn; } }, records);
    const before = await loadBoardState(context), errors = [], denied = [];
    const server = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory() { throw Error("Provider denied."); }, readSource() { throw Error("Source read denied."); } },
    });
    const browser = await chromium.launch();
    t.after(async () => {
        try { await browser.close(); await server.close(); assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.deepEqual(await loadBoardState(context), before); } finally { await cleanup(); }
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/New_York", reducedMotion: "reduce" });
    let enteredImport, releaseImport;
    const importReady = new Promise(resolve => { enteredImport = resolve; });
    const importRelease = new Promise(resolve => { releaseImport = resolve; });
    if (holdImport) holdImport({ ready: importReady, release: releaseImport });
    t.after(() => releaseImport());
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && ![
            "/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/overview",
            "/api/assessment/detail", "/api/evaluation/automatic/summary", "/api/period-comparison",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        if (holdImport && url.pathname === "/assets/period-comparison-math.mjs") {
            enteredImport(); await importRelease; return route.continue();
        }
        if (url.pathname === "/" && request.method() === "GET") {
            const response = await route.fetch(), html = await response.text();
            const binding = "const periodComparisonUI = assessmentFactories.periodComparison.mount({";
            assert.ok(html.includes(binding));
            const body = html.replace(binding, `const periodComparisonUI = (${accessBoundary.toString()})({`);
            return route.fulfill({ response, body });
        }
        return route.continue();
    });
    await page.goto(server.url + "#analyze?services=Files&includeMissingService=true");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    if (privateSearch) await restoreLegacySearch(page, "PRIVATE_COMPARE_TITLE");
    return page;
}
async function compare(page, emptyB = false, waitForPair = true) {
    await page.locator("#comparePeriods").click();
    for (const [side, values] of [["A", ["2026-03-07", "2026-03-07"]], ["B", emptyB ? ["2025-03-08", "2025-03-09"] : ["2026-03-08", "2026-03-09"]]])
        for (const [index, bound] of ["From", "To"].entries()) await page.locator(`#comparison${side}${bound}`).fill(values[index]);
    await page.locator("#applyPeriodComparison").click();
    if (waitForPair) await expect.poll(() => page.evaluate(() => Boolean(window.periodComparisonOwner.acceptedPair()))).toBe(true);
}

test("Compare withdrawal scrubs private DOM/getters without navigation, fetch or safe-date reset", { timeout: 30000 }, async t => {
    const page = await setup(t, { privateSearch: true });
    await compare(page);
    await page.locator("#comparisonRecordsB").click();
    const before = await page.evaluate(() => {
        window.oldEntry = window.periodComparisonOwner.acceptedPair();
        window.oldLink = document.querySelector("#comparisonExactRecordsA a");
        window.oldText = window.oldLink.firstChild;
        window.oldHrefAttribute = window.oldLink.getAttributeNode("href");
        window.oldTitle = document.querySelector(".compare-record-context").firstChild;
        window.oldCount = document.querySelector("#outcomeFilter option[data-count]").getAttributeNode("data-count");
        window.oldPanel = document.querySelector("#comparisonExactRecordsB");
        return { dates: [...document.querySelectorAll("#periodComparisonSetup input[type=date]")].map(node => node.value),
            url: location.href, calls: window.compareAccess.calls, navigations: window.compareAccess.navigations };
    });
    await page.evaluate(() => { window.compareAccess.withdraw(); window.periodComparisonOwner.withdrawAccess(); });
    const after = await page.evaluate(() => ({
        dates: [...document.querySelectorAll("#periodComparisonSetup input[type=date]")].map(node => node.value),
        url: location.href, calls: window.compareAccess.calls, navigations: window.compareAccess.navigations,
        pair: window.periodComparisonOwner.acceptedPair(), target: window.periodComparisonOwner.recordsTarget(window.oldEntry),
        search: document.getElementById("comparisonSearch").value, contents: document.getElementById("periodComparisonResults").textContent,
        oldText: window.oldLink.textContent + window.oldPanel.textContent, oldHref: window.oldLink.getAttribute("href"),
        oldId: window.oldLink.id, published: window.compareAccess.pairs.at(-1),
        oldTextValue: window.oldText.data, oldHrefValue: window.oldHrefAttribute.value,
        oldTitleValue: window.oldTitle.data, oldCountValue: window.oldCount.value,
        countAttributes: document.querySelectorAll("#outcomeFilter option[data-count]").length,
    }));
    assert.deepEqual({ dates: after.dates, url: after.url, calls: after.calls, navigations: after.navigations }, before);
    assert.deepEqual([after.pair, after.target, after.oldHref, after.published], [null, null, null, null]);
    assert.deepEqual([after.search, after.contents, after.oldText, after.oldId], ["", "", "", ""]);
    assert.deepEqual([after.oldTextValue, after.oldHrefValue], ["", ""]);
    assert.deepEqual([after.oldTitleValue, after.oldCountValue], ["", ""]);
    assert.equal(after.countAttributes, 0);
});

test("withdrawal during accepted publication blocks restoration and result orientation", { timeout: 30000 }, async t => {
    const page = await setup(t);
    await page.evaluate(() => { window.compareAccess.withdrawOnPublish = true; });
    await compare(page, false, false);
    await expect.poll(() => page.evaluate(() => window.compareAccess.withdrawOnPublish)).toBe(false);
    assert.deepEqual(await page.evaluate(() => ({
        pair: window.periodComparisonOwner.acceptedPair(), accepted: window.compareAccess.accepted,
        text: document.getElementById("periodComparisonResults").textContent,
        last: window.compareAccess.pairs.at(-1),
    })), { pair: null, accepted: 0, text: "", last: null });
});

test("withdrawal during record construction cannot repopulate private DOM", { timeout: 30000 }, async t => {
    const page = await setup(t);
    await page.evaluate(() => { window.compareAccess.withdrawDuringPaint = true; });
    await compare(page, false, false);
    await expect.poll(() => page.evaluate(() => window.compareAccess.withdrawDuringPaint)).toBe(false);
    assert.deepEqual(await page.evaluate(() => ({
        contents: document.getElementById("periodComparisonResults").textContent,
        pair: window.periodComparisonOwner.acceptedPair(), accepted: window.compareAccess.accepted,
    })), { contents: "", pair: null, accepted: 0 });
});

for (const emptyB of [false, true]) test(`fresh access keeps safe selected B without reviving its old targets (${emptyB ? "empty B" : "populated B"})`, { timeout: 30000 }, async t => {
    const page = await setup(t);
    await compare(page, emptyB);
    await page.locator("#comparisonRecordsB").click();
    const before = await page.evaluate(() => {
        window.oldEntry = window.periodComparisonOwner.acceptedPair();
        window.oldLink = document.querySelector("#comparisonExactRecordsA a");
        return { calls: window.compareAccess.calls, url: location.href, key: window.oldEntry.key };
    });
    await page.evaluate(() => { window.compareAccess.withdraw(); window.compareAccess.resume(); });
    assert.equal(await page.evaluate(() => window.compareAccess.calls), before.calls);
    assert.equal(await page.evaluate(() => window.periodComparisonOwner.acceptedPair()), null);
    await expect(page.locator("#periodComparison")).toBeHidden();
    await page.evaluate(() => window.compareAccess.fresh());
    await expect(page.locator("#comparisonRecordsB")).toHaveAttribute("aria-selected", "true");
    assert.equal(await page.evaluate(() => window.compareAccess.calls), before.calls + 1);
    assert.notEqual(await page.evaluate(() => window.periodComparisonOwner.acceptedPair().key), before.key);
    assert.equal(await page.evaluate(() => window.periodComparisonOwner.recordsTarget(window.oldEntry)), null);
    if (emptyB) await expect(page.locator("#comparisonExactRecordsB")).toContainText("No matching activity");
    await page.evaluate(() => window.oldLink.click());
    assert.equal(page.url(), before.url);
});

test("unchanged publication authority keeps a held read current", { timeout: 30000 }, async t => {
    const page = await setup(t);
    await page.evaluate(() => { window.compareAccess.holdNext = true; window.lease = window.compareAccess.token(); });
    await compare(page, false, false);
    await expect.poll(() => page.evaluate(() => Boolean(window.compareAccess.pending))).toBe(true);
    assert.equal(await page.evaluate(() => window.compareAccess.isCurrent(window.lease)), true);
    await page.evaluate(() => window.compareAccess.pending.resolve());
    await expect.poll(() => page.evaluate(() => Boolean(window.periodComparisonOwner.acceptedPair()))).toBe(true);
    assert.equal(await page.evaluate(() => window.compareAccess.calls), 1);
});

for (const completion of ["resolve", "reject"]) test(`old decoded ${completion} cannot publish or finalize a fresh same-generation read`, { timeout: 30000 }, async t => {
    const page = await setup(t);
    await compare(page);
    await page.evaluate(() => { window.compareAccess.holdNext = true; });
    await page.locator("#applyPeriodComparison").click();
    await expect.poll(() => page.evaluate(() => Boolean(window.compareAccess.pending))).toBe(true);
    await page.evaluate(() => {
        window.oldRead = window.compareAccess.pending; window.oldLease = window.compareAccess.token();
        window.compareAccess.withdraw(); window.compareAccess.resume();
    });
    assert.equal(await page.evaluate(() => window.compareAccess.calls), 2);
    assert.equal(await page.evaluate(() => window.compareAccess.isCurrent(window.oldLease)), false);
    await page.evaluate(() => { window.compareAccess.holdNext = true; window.freshRead = window.compareAccess.fresh(); });
    await expect.poll(() => page.evaluate(() => window.compareAccess.pending !== window.oldRead)).toBe(true);
    await page.evaluate(() => { window.newRead = window.compareAccess.pending; });
    await expect(page.locator("#periodComparisonResults")).toHaveAttribute("aria-busy", "true");
    await page.evaluate(kind => window.oldRead[kind](), completion);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator("#periodComparisonResults")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Reading both periods...");
    assert.equal(await page.evaluate(() => window.periodComparisonOwner.acceptedPair()), null);
    assert.equal(await page.evaluate(() => window.compareAccess.calls), 3);
    await page.evaluate(async () => { window.newRead.resolve(); await window.freshRead; });
    assert.ok(await page.evaluate(() => window.periodComparisonOwner.acceptedPair()));
    assert.equal(await page.evaluate(() => window.compareAccess.accepted), 2);
    await expect(page.locator("#periodComparisonStatus")).not.toContainText("PRIVATE_LATE_ERROR");
});

for (const action of ["expiry", "withdrawal and newer focus"]) test(`late entry completion respects ${action}`, { timeout: 30000 }, async t => {
    const page = await setup(t);
    await page.evaluate(() => { window.compareAccess.holdNavigation = true; });
    await page.locator("#comparePeriods").click();
    await expect.poll(() => page.evaluate(() => typeof window.compareAccess.finishNavigation)).toBe("function");
    if (action === "expiry") await page.evaluate(() => window.compareAccess.expire());
    else {
        await page.evaluate(() => { window.compareAccess.withdraw(); window.compareAccess.resume(); });
        await page.locator("#wireSearch").focus();
    }
    const focus = await page.evaluate(() => document.activeElement.id);
    await page.evaluate(() => window.compareAccess.finishNavigation());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => document.activeElement.id), focus);
    assert.equal(await page.evaluate(() => window.compareAccess.calls), 0);
    assert.equal(await page.evaluate(() => window.compareAccess.navigations), 1);
});

test("safe date drafts survive withdrawal and do not dispatch until explicitly compared", { timeout: 30000 }, async t => {
    const page = await setup(t);
    await compare(page);
    await page.locator("#comparisonAFrom").fill("2026-03-06");
    const calls = await page.evaluate(() => window.compareAccess.calls);
    await page.evaluate(async () => { window.compareAccess.withdraw(); window.compareAccess.resume(); await window.compareAccess.fresh(); });
    await expect(page.locator("#comparisonAFrom")).toHaveValue("2026-03-06");
    assert.equal(await page.evaluate(() => window.compareAccess.calls), calls);
    assert.equal(await page.evaluate(() => window.periodComparisonOwner.acceptedPair()), null);
    await page.locator("#applyPeriodComparison").click();
    await expect.poll(() => page.evaluate(() => window.periodComparisonOwner.acceptedPair()?.comparison.periods.baseline.range.from)).toBe("2026-03-06");
    assert.equal(await page.evaluate(() => window.compareAccess.calls), calls + 1);
});

for (const invalidation of ["expire", "removeMethods"]) test(`Compare fails closed when publication checks ${invalidation}`, { timeout: 30000 }, async t => {
    const page = await setup(t);
    await compare(page);
    const calls = await page.evaluate(() => window.compareAccess.calls);
    await page.evaluate(action => window.compareAccess[action](), invalidation);
    assert.equal(await page.evaluate(() => window.periodComparisonOwner.acceptedPair()), null);
    await page.evaluate(() => window.periodComparisonOwner.update());
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    assert.equal(await page.evaluate(() => window.periodComparisonOwner.resumeAccess()), false);
    const navigation = await page.evaluate(() => window.compareAccess.navigations);
    await page.evaluate(() => {
        document.getElementById("comparePeriods").click();
        document.getElementById("applyPeriodComparison").click();
    });
    assert.equal(await page.evaluate(() => window.compareAccess.navigations), navigation);
    assert.equal(await page.evaluate(() => window.compareAccess.calls), calls);
});

test("late static import cannot dispatch a retired comparison and fresh access creates a new read", { timeout: 30000 }, async t => {
    let gate;
    const page = await setup(t, { holdImport: value => { gate = value; } });
    await compare(page, false, false); await gate.ready;
    assert.equal(await page.evaluate(() => window.compareAccess.calls), 0);
    await page.evaluate(() => { window.compareAccess.withdraw(); window.compareAccess.resume(); });
    await page.locator("#wireSearch").focus();
    const imported = page.waitForResponse(response => new URL(response.url()).pathname === "/assets/period-comparison-math.mjs");
    gate.release(); await (await imported).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.compareAccess.calls), 0);
    assert.equal(await page.evaluate(() => window.periodComparisonOwner.acceptedPair()), null);
    await expect(page.locator("#periodComparison")).toBeHidden();
    await page.evaluate(() => window.compareAccess.fresh());
    assert.equal(await page.evaluate(() => window.compareAccess.calls), 1);
    assert.ok(await page.evaluate(() => window.periodComparisonOwner.acceptedPair()));
    await expect(page.locator("#wireSearch")).toBeFocused();
});
