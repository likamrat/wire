import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { mountAnalyzeControls } from "../web/analyze-controls.mjs";
import { createSelectControls } from "../web/select-control.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";

const waitForFilterEntrance = page => page.waitForFunction(() => {
    const dialog = document.getElementById("analyzeFilterDialog");
    return dialog.open && !dialog.hasAttribute("data-closing")
        && !dialog.getAnimations().some(animation => animation.effect?.target === dialog);
});

async function setup(t, { mount = true } = {}) {
    const browser = await chromium.launch(), errors = [], requests = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(requests, []); });
    await page.setContent(renderHtmlShell("a".repeat(64), "withdrawal-fixture").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
    const anchor = "const observer = new MutationObserver(sync);";
    const source = createSelectControls.toString();
    assert.equal(source.split(anchor).length, 2);
    const observedSelect = source.replace(anchor, `window.inspectSelectOwner = () => ({
        typeBuffer, typeTime, frame, active: active?.select.id ?? null,
        entries: [...controls.values()].map(entry => ({
            id: entry.select.id, options: entry.options.map(option => option.label),
            signature: entry.signature, selectedValue: entry.selectedValue, presentation: entry.presentation,
            draft: entry.draft ? [...entry.draft] : null, hasDraftCallback: typeof entry.updateDraft === "function",
            sizer: entry.sizer?.textContent ?? "", value: entry.value.textContent,
        })),
    }); ${anchor}`);
    await page.addScriptTag({ content: `window.mountFilters = ${mountAnalyzeControls.toString()};
        window.makeSelects = ${observedSelect}; window.makeUX = ${createEvidenceUX.toString()};
        window.testIcons = ${JSON.stringify(uxIcons)};` });
    await page.evaluate(mount => {
        document.getElementById("workspace").hidden = false;
        document.getElementById("homeView").hidden = false;
        const sessionReport = document.createElement("button");
        sessionReport.id = "createSessionReport"; sessionReport.textContent = "Create report for this Copilot chat";
        sessionReport.hidden = true; document.getElementById("pageAction").after(sessionReport);
        for (const select of document.querySelectorAll("#filters select")) select.closest("label")?.classList.add("filter-field");
        const card = document.createElement("section");
        card.dataset.percentageCard = "outcomes"; document.getElementById("outcomeChart").append(card);
        const results = document.createElement("div"); results.id = "periodComparisonResults";
        const dates = document.createElement("div"); dates.className = "compare-period-key";
        dates.textContent = "Fixture period choices"; results.append(dates);
        document.getElementById("periodComparison").append(results);
        const comparisonDate = document.createElement("input");
        comparisonDate.type = "date";
        document.getElementById("periodComparisonSetup").append(comparisonDate);
        window.queueNavigationFocus = () => {
            document.getElementById("navigationDrawer").show();
            const compare = document.getElementById("comparePeriods");
            compare.hidden = false;
            compare.setAttribute("aria-expanded", "true");
            compare.click();
        };
        window.privateSelectIds = ["projectFilter", "chatFilter", "toolFilter", "serviceFilter",
            "serviceAssociationFilter", "outcomeFilter", "privateHeadingChoice"];
        const heading = document.createElement("div"); heading.className = "chart-heading";
        const headingSelect = document.createElement("select"); headingSelect.id = "privateHeadingChoice";
        heading.append(headingSelect); document.getElementById("analyzeFilterFields").append(heading);
        for (const id of window.privateSelectIds) {
            const select = document.getElementById(id);
            select.replaceChildren(...["a", "b"].map((value, index) => {
                const option = document.createElement("option");
                option.value = `PRIVATE_${id}_${value}`; option.textContent = `PRIVATE label ${id} ${value}`;
                option.dataset.detail = `PRIVATE detail ${value}`; option.selected = index === 0;
                return option;
            }));
        }
        document.getElementById("layerFilter").value = "code-reference";
        document.getElementById("fromFilter").value = "2026-03-01";
        let token = Object.freeze({ epoch: 1 }), open = true, now = 0, deadline = 5000;
        window.accessBoundary = {
            publicationToken: () => open && now < deadline ? token : null,
            isCurrent: value => open && now < deadline && value !== null && value === token,
            revoke: () => { open = false; },
            expire: () => { now = deadline; },
            grant: () => { token = Object.freeze({ epoch: token.epoch + 1 }); deadline = now + 5000; open = true; },
        };
        window.ux = window.makeUX(window.testIcons);
        if (mount) {
            window.filters = window.mountFilters(window.ux, {
                api: window.accessBoundary,
                motionTiming: { duration: 320, easing: "cubic-bezier(.2,0,0,1)", fill: "both" },
                closeSelect: () => window.selects?.close(),
                closeNavigation: () => { if (document.getElementById("navigationDrawer").open) document.getElementById("navigationDrawer").close(); },
            });
            window.selects = window.makeSelects(window.ux);
            window.filters.context({ analyze: true, compare: false, ordinary: true });
        }
        window.changeEvents = [];
        document.addEventListener("input", event => window.changeEvents.push(["input", event.target.id]));
        document.addEventListener("change", event => window.changeEvents.push(["change", event.target.id]));
        window.clearNativePrivate = () => {
            for (const id of window.privateSelectIds) {
                const select = document.getElementById(id);
                select.replaceChildren(); delete select.dataset.pendingValue;
            }
        };
        window.withdrawOwners = () => {
            window.accessBoundary.revoke();
            document.getElementById("workspace").hidden = true;
            window.clearNativePrivate();
            window.filters.withdrawAccess();
            window.selects.withdrawAccess();
        };
        window.effects = [];
        const focus = HTMLElement.prototype.focus, scroll = Element.prototype.scrollIntoView;
        HTMLElement.prototype.focus = function (...args) { window.effects.push(["focus", this.id]); return focus.apply(this, args); };
        Element.prototype.scrollIntoView = function (...args) { window.effects.push(["scroll", this.id]); return scroll.apply(this, args); };
    }, mount);
    return page;
}

test("missing, partial and malformed control dependencies fail before any owner DOM mutation", async t => {
    const page = await setup(t, { mount: false });
    const results = await page.evaluate(() => {
        const token = Object.freeze({ fixture: "required-control-boundary" });
        const cases = [
            ["omitted", {}],
            ["explicit undefined", { api: undefined }],
            ["null", { api: null }],
            ["empty", { api: {} }],
            ["old callable without control methods", { api() {} }],
            ["missing current check", { api: { publicationToken: () => token } }],
            ["missing token provider", { api: { isCurrent: () => true } }],
            ["noncallable token provider", { api: { publicationToken: token, isCurrent: () => true } }],
            ["noncallable current check", { api: { publicationToken: () => token, isCurrent: true } }],
        ];
        return cases.map(([name, options]) => {
            const before = document.body.innerHTML;
            const observer = new MutationObserver(() => {});
            observer.observe(document.body, { attributes: true, childList: true, subtree: true, characterData: true });
            let error = null;
            try { window.mountFilters(window.ux, { closeSelect() {}, closeNavigation() {}, ...options }); }
            catch (value) { error = { name: value.name, message: value.message }; }
            const mutations = observer.takeRecords().length; observer.disconnect();
            return { name, error, mutations, unchanged: before === document.body.innerHTML };
        });

    });
    assert.deepEqual(results.filter(result => result.error?.name !== "TypeError"
        || result.error.message !== "Analyze controls require the shared publication token interface."
        || result.mutations !== 0 || !result.unchanged), []);
});

test("missing shared motion timing fails before controls change the DOM", async t => {
    const page = await setup(t, { mount: false });
    const result = await page.evaluate(() => {
        const before = document.body.innerHTML;
        let error;
        try {
            window.mountFilters(window.ux, {
                api: window.accessBoundary, closeSelect() {}, closeNavigation() {},
            });
        } catch (value) { error = value.message; }
        return { error, unchanged: document.body.innerHTML === before };
    });
    assert.deepEqual(result, { error: "Analyze controls require the shared sidebar motion timing.", unchanged: true });
});

test("filter withdrawal and route teardown cancel motion synchronously and fence retired completions", async t => {
    const page = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#openAnalyzeFilters").click();
    const retired = await page.evaluate(() => {
        const dialog = document.getElementById("analyzeFilterDialog");
        const animation = dialog.getAnimations().find(item => item.effect.getKeyframes().some(frame => frame.transform));
        animation.pause(); animation.currentTime = 90;
        window.retiredFilterCompletion = animation.onfinish;
        window.withdrawOwners();
        return { open: dialog.open, motion: dialog.getAnimations().length,
            inert: document.getElementById("analyzeFilterPanel").inert,
            privateText: document.getElementById("analyzeScopeCaption").textContent };
    });
    assert.deepEqual(retired, { open: false, motion: 0, inert: false, privateText: "" });
    await page.evaluate(() => {
        window.accessBoundary.grant();
        document.getElementById("workspace").hidden = false;
        window.filters.context({ analyze: true, compare: false, ordinary: true });
        document.getElementById("openAnalyzeFilters").click();
        window.retiredFilterCompletion();
    });
    await expect(page.locator("#analyzeFilterDialog")).toBeVisible();
    await expect(page.locator("#dateFilter-control")).toBeFocused();
    const closed = await page.evaluate(() => {
        window.filters.context({ analyze: false, compare: false, ordinary: false });
        const dialog = document.getElementById("analyzeFilterDialog");
        window.retiredFilterCompletion();
        return { open: dialog.open, motion: dialog.getAnimations().length };
    });
    assert.deepEqual(closed, { open: false, motion: 0 });
});

test("private painting and queued focus require a real token and strictly synchronous true", async t => {
    const page = await setup(t);
    const results = await page.evaluate(() => {
        const originalToken = window.accessBoundary.publicationToken, originalCurrent = window.accessBoundary.isCurrent;
        const value = { text: "PRIVATE rejected scope", parts: ["PRIVATE rejected scope"], activeCount: 1, revision: 91,
            status: "PRIVATE rejected status", error: "PRIVATE rejected error", empty: false };
        const cases = ["null token", "null token with permissive verifier", "undefined token", "stale token", "foreign token", "promise token", "thenable token",
            "false", "undefined", "null", "zero", "one", "string", "object", "boxed boolean", "promise", "thenable"];
        return cases.map(name => {
            window.accessBoundary.publicationToken = originalToken;
            window.accessBoundary.isCurrent = originalCurrent;
            window.accessBoundary.grant();
            window.filters.context({ analyze: true, compare: false, ordinary: true });
            const token = originalToken();
            const tasks = [], nativeQueue = window.queueMicrotask;
            window.queueMicrotask = callback => tasks.push(callback);
            window.queueNavigationFocus();
            window.queueMicrotask = nativeQueue;
            if (name.startsWith("null token") || name === "undefined token") {
                window.accessBoundary.publicationToken = () => name.startsWith("null token") ? null : undefined;
                window.accessBoundary.isCurrent = received => name === "null token with permissive verifier" || received == null;
            } else if (name === "stale token") {
                window.accessBoundary.grant();
                window.accessBoundary.publicationToken = () => token;
            } else if (name === "foreign token") {
                window.accessBoundary.grant();
                const current = originalToken();
                window.accessBoundary.publicationToken = () => Object.freeze({ epoch: current.epoch });
            } else if (name === "promise token" || name === "thenable token") {
                const invalid = name === "promise token" ? Promise.resolve(token) : { then() {} };
                window.accessBoundary.publicationToken = () => invalid;
                window.accessBoundary.isCurrent = received => received === invalid;
            } else {
                const response = { false: false, undefined, null: null, zero: 0, one: 1, string: "true",
                    object: {}, "boxed boolean": new Boolean(true), promise: Promise.resolve(true), thenable: { then() {} } }[name];
                window.accessBoundary.isCurrent = () => response;
            }
            const before = document.getElementById("analyzeScopeSummary").innerHTML;
            const heading = document.getElementById("filterHeading").textContent;
            const dateInert = document.getElementById("dateFields").inert;
            window.effects = [];
            window.filters.context({ analyze: true, compare: true, ordinary: true });
            window.filters.caption(value);
            const coverage = document.createElement("p"); coverage.textContent = "PRIVATE rejected coverage";
            window.filters.sourceCoverage(coverage);
            window.filters.pairedCaption({ ...value, key: "PRIVATE_KEY" });
            document.getElementById("openAnalyzeFilters").click();
            for (const callback of tasks) callback();
            const result = { name, unchanged: before === document.getElementById("analyzeScopeSummary").innerHTML
                    && heading === document.getElementById("filterHeading").textContent
                    && dateInert === document.getElementById("dateFields").inert,
                scope: document.getElementById("analyzeScopeSummary").textContent
                    + (document.getElementById("comparisonAcceptedScope")?.textContent || "")
                    + document.getElementById("analyzeFilterScopeDescription").textContent,
                coverage: document.getElementById("analyzeSourceCoverage").textContent,
                dialogOpen: document.getElementById("analyzeFilterDialog").open,
                effects: [...window.effects] };
            window.filters.withdrawAccess();
            return result;
        });
    });
    assert.deepEqual(results.filter(result => !result.unchanged || /PRIVATE/.test(result.scope + result.coverage)
        || result.dialogOpen || result.effects.length).map(({ name, unchanged, dialogOpen, effects }) => ({ name, unchanged, dialogOpen, effects })), []);
});

test("withdrawal erases owned ordinary and paired presentations without focus or a zero fallback", async t => {
    const page = await setup(t);
    await page.evaluate(() => {
        window.oldScope = { text: "PRIVATE accepted scope; PRIVATE ordinary sibling", parts: ["PRIVATE accepted scope", "PRIVATE ordinary sibling"],
            status: "PRIVATE coverage status", error: "PRIVATE read error",
            activeCount: 4, revision: 19, empty: false };
        window.filters.caption(window.oldScope);
        for (const id of ["pageProject", "periodCoverageText", "sessionAnalysis", "activityListScope", "periodHint", "serviceFocusScope"]) {
            document.getElementById(id).textContent = `PRIVATE ${id}`;
            document.getElementById(id).dataset.revision = "19";
        }
        document.getElementById("periodResult").textContent = "PRIVATE accepted count";
        document.getElementById("serviceFocus").hidden = false;
        const coverage = document.createElement("p"); coverage.textContent = "PRIVATE source coverage";
        window.filters.sourceCoverage(coverage);
        window.filters.context({ analyze: true, compare: true, ordinary: true });
        window.oldPair = { text: "PRIVATE paired scope; PRIVATE paired sibling", parts: ["PRIVATE paired scope", "PRIVATE paired sibling"],
            activeCount: 2, key: "PRIVATE_PAIR", revision: 19 };
        window.filters.pairedCaption(window.oldPair);
        window.ownedData = ["analyzeScopeCaption", "analyzeScopeStatus", "analyzeScopeErrorText", "analyzeScopeSummary",
            "periodResult", "periodHint", "periodCoverageText", "pageProject", "sessionAnalysis", "activityListScope", "analyzeSourceCoverage", "serviceFocusScope"];
        if (document.getElementById("analyzeFilterScopeDescription")) window.ownedData.push("analyzeFilterScopeDescription");
        window.retiredParts = [...document.querySelectorAll("#analyzeScopeCaption .analyze-scope-part,#comparisonAcceptedScope .analyze-scope-part")];
        if (window.retiredParts.length !== 4) throw Error("Union proof requires both ordinary and paired sibling parts.");
        for (const node of [...window.retiredParts, document.getElementById("analyzeFilterScopeDescription")]) {
            node.dataset.privateScope = "PRIVATE scope attribute";
            node.title = "PRIVATE scope title";
            node.setAttribute("aria-label", "PRIVATE scope accessible label");
        }
        document.getElementById("openAnalyzeFilters").click();
    });
    await waitForFilterEntrance(page);
    const result = await page.evaluate(() => {
        document.getElementById("outcomeFilter-control").click();
        const handles = [];
        const capture = (node, site) => {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                if (text.data.includes("PRIVATE") || site === "analyzeFilterCount") handles.push({ kind: "Text", site, node: text });
            }
            for (const element of [node, ...node.querySelectorAll("*")]) {
                for (const attribute of element.attributes) {
                    if (attribute.value.includes("PRIVATE")) handles.push({ kind: "Attr", site, node: attribute });
                }
            }
        };
        for (const id of window.ownedData.filter(id => id !== "analyzeScopeSummary")) capture(document.getElementById(id), id);
        capture(document.getElementById("comparisonAcceptedScope"), "paired-caption");
        capture(document.getElementById("analyzeFilterCount"), "analyzeFilterCount");
        capture(document.querySelector(".select-popup"), "popup");
        capture(document.querySelector("#privateHeadingChoice-control .select-option-sizer"), "sizer");
        for (const id of window.privateSelectIds) capture(document.querySelector(`#${id}-control .select-value`), `value:${id}`);
        handles.push({ kind: "Attr", site: "paired-trigger", node: document.getElementById("openAnalyzeFilters").getAttributeNode("data-pair-key") });
        const sites = new Set(handles.map(handle => handle.site));
        if (!["analyzeScopeCaption", "paired-caption", "analyzeFilterScopeDescription", "popup", "sizer", "value:outcomeFilter", "paired-trigger"]
            .every(site => sites.has(site))) throw Error("The held-node case must capture actual private Text/Attr handles on each owned surface.");
        const safeOption = document.getElementById("layerFilter").selectedOptions[0];
        const safeText = safeOption.firstChild, safeValue = safeOption.getAttributeNode("value");
        const safeNative = { text: safeText.data, value: safeValue.value };
        const safe = { layer: document.getElementById("layerFilter").value, from: document.getElementById("fromFilter").value };
        window.effects = []; window.changeEvents = [];
        window.withdrawOwners(); window.filters.withdrawAccess?.(); window.selects.withdrawAccess?.();
        return {
            fields: window.ownedData.map(id => { const node = document.getElementById(id); return { id, text: node.textContent,
                data: [...node.attributes].filter(attribute => attribute.name.startsWith("data-")).map(attribute => attribute.value) }; }),
            pair: document.getElementById("comparisonAcceptedScope")?.textContent ?? "",
            triggerData: { ...document.getElementById("openAnalyzeFilters").dataset },
            badge: document.getElementById("analyzeFilterCount").textContent,
            describedBy: document.getElementById("openAnalyzeFilters").getAttribute("aria-describedby"),
            open: document.getElementById("analyzeFilterDialog").open, effects: window.effects, changes: window.changeEvents,
            serviceContextHidden: document.getElementById("serviceFocus").hidden,
            retiredParts: window.retiredParts.map(node => ({ text: node.textContent, data: { ...node.dataset },
                title: node.title, label: node.getAttribute("aria-label") })),
            retainedHandles: handles.map(({ kind, site, node }) => ({ kind, site, value: kind === "Text" ? node.data : node.value })),
            safeNative, safeNativeAfter: { text: safeText.data, value: safeValue.value },
            safeNativeConnected: safeOption.isConnected && safeValue.ownerElement === safeOption,
            safe, after: { layer: document.getElementById("layerFilter").value, from: document.getElementById("fromFilter").value },
        };
    });
    assert.ok(result.fields.every(field => !field.text.includes("PRIVATE") && field.data.length === 0), JSON.stringify(result.fields));
    assert.equal(result.pair, ""); assert.deepEqual(result.triggerData, {}); assert.equal(result.badge, "");
    assert.equal(result.describedBy, null); assert.equal(result.open, false);
    assert.equal(result.serviceContextHidden, true);
    assert.deepEqual(result.safe, { layer: "code-reference", from: "2026-03-01" });
    assert.ok(result.retiredParts.every(part => part.text === "" && Object.keys(part.data).length === 0
        && part.title === "" && part.label === null), JSON.stringify(result.retiredParts));
    assert.deepEqual(result.retainedHandles.filter(handle => handle.value !== ""), []);
    assert.deepEqual(result.safeNativeAfter, result.safeNative);
    assert.equal(result.safeNativeConnected, true);
    assert.deepEqual(result.effects, []); assert.deepEqual(result.changes, []); assert.deepEqual(result.after, result.safe);
    await page.evaluate(() => {
        window.filters.caption(window.oldScope); window.filters.pairedCaption(window.oldPair);
        const notice = document.createElement("p"); notice.textContent = "PRIVATE late coverage";
        window.filters.sourceCoverage(notice);
    });
    assert.doesNotMatch(await page.locator("#analyzeScopeSummary").textContent(), /PRIVATE/);
    await expect(page.locator("#analyzeScopeCaption")).toBeEmpty();
    await expect(page.locator("#analyzeSourceCoverage")).toBeEmpty();
});

test("hidden popup and cache clearance is synchronous, and retired popup actions cannot affect fresh re-entry", async t => {
    const page = await setup(t);
    await page.locator("#openAnalyzeFilters").click();
    await page.locator("#outcomeFilter-control").click();
    await page.locator("#outcomeFilter-control").press("P");
    const immediate = await page.evaluate(() => {
        window.oldActions = [...document.querySelectorAll(".select-all,.select-footer button")];
        window.oldRow = document.querySelector(".select-option");
        window.oldOptionsCache = window.inspectSelectOwner();
        if (window.oldOptionsCache.typeBuffer !== "P"
            || !window.oldOptionsCache.entries.find(entry => entry.id === "privateHeadingChoice").sizer.includes("PRIVATE")) {
            throw Error("The fixture must populate real typeahead and hidden intrinsic sizing caches.");
        }
        window.pendingFrames = [];
        window.nativeFrame = window.requestAnimationFrame; window.nativeCancel = window.cancelAnimationFrame;
        window.requestAnimationFrame = callback => { window.pendingFrames.push(callback); return 991; };
        window.cancelAnimationFrame = () => {};
        window.dispatchEvent(new Event("resize"));
        window.observerDelivered = false;
        const observer = new MutationObserver(() => { window.observerDelivered = true; observer.disconnect(); });
        observer.observe(document.body, { subtree: true, childList: true });
        window.effects = []; window.changeEvents = [];
        window.withdrawOwners();
        return { delivered: window.observerDelivered, cache: window.inspectSelectOwner(),
            hiddenPopup: document.querySelector(".select-popup").textContent, effects: window.effects, changes: window.changeEvents };
    });
    assert.equal(immediate.delivered, false);
    assert.equal(immediate.hiddenPopup, "");
    assert.doesNotMatch(JSON.stringify(immediate.cache), /PRIVATE/);
    assert.equal(immediate.cache.typeBuffer, ""); assert.equal(immediate.cache.typeTime, 0); assert.equal(immediate.cache.frame, 0);
    assert.equal(immediate.cache.active, null);
    assert.ok(immediate.cache.entries.every(entry => !entry.hasDraftCallback && entry.draft === null));
    assert.deepEqual(immediate.effects, []); assert.deepEqual(immediate.changes, []);
    await page.evaluate(() => {
        window.requestAnimationFrame = window.nativeFrame; window.cancelAnimationFrame = window.nativeCancel;
        window.accessBoundary.grant();
        const select = document.getElementById("outcomeFilter");
        for (const [value, selected] of [["fresh-a", true], ["fresh-b", false]]) {
            const option = document.createElement("option"); option.value = value; option.textContent = value; option.selected = selected; select.append(option);
        }
        document.getElementById("workspace").hidden = false;
        window.filters.context({ analyze: true, compare: false, ordinary: true });
        window.selects.sync();
        document.getElementById("openAnalyzeFilters").click();
    });
    await waitForFilterEntrance(page);
    const after = await page.evaluate(() => {
        document.getElementById("outcomeFilter-control").click();
        const before = { selected: [...document.querySelectorAll(".select-option")].map(node => node.getAttribute("aria-selected")),
            focus: document.activeElement.id };
        window.effects = []; window.changeEvents = [];
        for (const action of window.oldActions) action.click();
        for (const callback of window.pendingFrames) callback();
        return { before, after: { selected: [...document.querySelectorAll(".select-option")].map(node => node.getAttribute("aria-selected")),
            focus: document.activeElement.id }, open: !document.querySelector(".select-popup").hidden,
            effects: window.effects, changes: window.changeEvents };
    });
    assert.deepEqual(after.after, after.before); assert.equal(after.open, true);
    assert.deepEqual(after.effects, []); assert.deepEqual(after.changes, []);
    await page.locator('.select-option[data-value="fresh-b"]').click();
    await page.locator(".select-apply").click();
    await expect(page.locator("#outcomeFilter")).toHaveValues(["fresh-a", "fresh-b"]);
});

test("queued filter focus and old publication closures cannot cross withdrawal and a fresh token", async t => {
    const page = await setup(t);
    const result = await page.evaluate(() => {
        const oldToken = window.accessBoundary.publicationToken();
        window.pendingTasks = [];
        const nativeQueue = window.queueMicrotask;
        window.queueMicrotask = callback => window.pendingTasks.push(callback);
        window.queueNavigationFocus();
        window.queueMicrotask = nativeQueue;
        const latePublication = () => {
            if (!window.accessBoundary.isCurrent(oldToken)) return;
            window.filters.caption({ text: "PRIVATE retired publication", parts: ["PRIVATE retired publication"],
                status: "", error: "", revision: 1, activeCount: 1, empty: false });
        };
        window.withdrawOwners(); window.accessBoundary.grant();
        document.getElementById("workspace").hidden = false;
        window.filters.context({ analyze: true, compare: false, ordinary: true });
        window.filters.caption({ text: "Fresh accepted scope", parts: ["Fresh accepted scope"],
            status: "", error: "", revision: 2, activeCount: 1, empty: false });
        window.effects = [];
        latePublication();
        for (const callback of window.pendingTasks) callback();
        return { text: document.getElementById("analyzeScopeCaption").textContent, effects: window.effects };
    });
    assert.equal(result.text, "Fresh accepted scope"); assert.deepEqual(result.effects, []);
});

test("owner callbacks consult the shared token at a held freshness deadline", async t => {
    const page = await setup(t);
    const result = await page.evaluate(() => {
        const tasks = [], nativeQueue = window.queueMicrotask;
        window.queueMicrotask = callback => tasks.push(callback);
        window.queueNavigationFocus();
        window.queueMicrotask = nativeQueue;
        window.accessBoundary.expire();
        window.effects = [];
        window.filters.caption({ text: "PRIVATE expired paint", parts: ["PRIVATE expired paint"],
            status: "", error: "", activeCount: 1, revision: 1, empty: false });
        for (const callback of tasks) callback();
        return { text: document.getElementById("analyzeScopeCaption").textContent, effects: window.effects };
    });

    assert.doesNotMatch(result.text, /PRIVATE/); assert.deepEqual(result.effects, []);
});

test("withdrawal scrubs the captured scope even when the widget owner detached its card first", async t => {
    const page = await setup(t);
    const result = await page.evaluate(() => {
        const value = { text: "PRIVATE detached scope", parts: ["PRIVATE detached scope"], status: "PRIVATE detached status", error: "PRIVATE detached error",
            activeCount: 3, revision: 9, empty: false };
        window.filters.caption(value);
        const scope = document.getElementById("analyzeScopeSummary");
        document.getElementById("outcomeChart").replaceChildren();
        window.withdrawOwners();
        const withdrawn = { text: scope.textContent, revision: scope.dataset.revision,
            caption: scope.querySelector("#analyzeScopeCaption").textContent };
        window.accessBoundary.grant();
        const card = document.createElement("section"); card.dataset.percentageCard = "outcomes";
        document.getElementById("outcomeChart").append(card);
        document.getElementById("workspace").hidden = false;
        window.filters.context({ analyze: true, compare: false, ordinary: true });
        window.filters.caption({ ...value, text: "Fresh replacement widget scope", parts: ["Fresh replacement widget scope"],
            status: "", error: "", revision: 10 });
        return { withdrawn, sameOwner: document.getElementById("analyzeScopeSummary") === scope,
            fresh: document.getElementById("analyzeScopeCaption").textContent };
    });
    assert.doesNotMatch(result.withdrawn.text, /PRIVATE/);
    assert.equal(result.withdrawn.caption, ""); assert.equal(result.withdrawn.revision, undefined);
    assert.equal(result.sameOwner, true); assert.equal(result.fresh, "Fresh replacement widget scope");
});

for (const multiple of [false, true]) test(`withdrawal inside a native ${multiple ? "multiple" : "single"} choice stops its remaining change/focus continuation`, async t => {
    const page = await setup(t);
    const id = multiple ? "outcomeFilter" : "projectFilter";
    await page.locator("#openAnalyzeFilters").click();
    if (!multiple) await page.locator("#moreFiltersToggle").click();
    await page.locator(`#${id}-control`).click();
    await page.evaluate(id => {
        document.getElementById(id).addEventListener("input", () => window.withdrawOwners(), { once: true });
        window.effects = []; window.changeEvents = [];
    }, id);
    await page.locator(`.select-option[data-value="PRIVATE_${id}_b"]`).click();
    if (multiple) {
        await page.evaluate(() => { window.effects = []; });
        await page.locator(".select-apply").click();
    }
    const after = await page.evaluate(id => ({ events: window.changeEvents, effects: window.effects,
        value: document.getElementById(id).value, popup: document.querySelector(".select-popup").textContent,
        open: document.getElementById("analyzeFilterDialog").open }), id);
    assert.deepEqual(after.events, [["input", id]]);
    assert.deepEqual(after.effects, []);
    assert.equal(after.value, ""); assert.equal(after.popup, ""); assert.equal(after.open, false);
});
