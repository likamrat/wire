import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mountBoundedNative } from "../web/bounded-native.mjs";
import { createBoundedNativeState } from "../web/bounded-native-state.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";

test("accepted reader authority cannot be resurrected by an older surrounding snapshot", async t => {
    const browser = await chromium.launch(), page = await browser.newPage();
    t.after(() => browser.close());
    await page.setContent('<div id="wireSearchPanel"></div><div id="activityList"></div>');
    await page.addScriptTag({ content: `
        const owner = {};
        const api = Object.assign(async () => { throw Error("No request expected."); },
            { publicationToken: () => owner, isCurrent: value => value === owner });
        const ui = (${mountBoundedNative.toString()})({api, ux: {withdrawAccess() {}},
            results: (${createRecordedResults.toString()})({screen: true}), createState: ${createBoundedNativeState.toString()}});
        const target = {conversationId: "a".repeat(64), sourceId: "microsoft-365-chat", revision: 7, sourceRevision: "b".repeat(64)};
        const view = {revision: 7, sourceRevision: target.sourceRevision, readback: {schemaVersion: 1, snapshotRef: "c".repeat(64),
            committed: null, current: {generation: 1, configurationRevision: 1, privacyRevision: 1}, deletionVersion: 0}};
        window.accepted = ui.acceptReaderTarget(target, view);
        ui.observeReaderAuthority({...view, revision: 9});
        window.stillReadable = ui.hasReaderTarget(target);
        ui.retireReaderAuthority(10);
        window.revoked = ui.hasReaderTarget(target);
        window.oldSnapshotRejected = !ui.acceptReaderTarget(target, view);
        const freshTarget = {...target, revision: 11, sourceRevision: "d".repeat(64)};
        window.fresh = ui.acceptReaderTarget(freshTarget, {...view, revision: 11, sourceRevision: freshTarget.sourceRevision});
        window.oldTargetStillRevoked = !ui.hasReaderTarget(target);
    ` });
    assert.deepEqual(await page.evaluate(() => ({ accepted, stillReadable, revoked, oldSnapshotRejected, fresh, oldTargetStillRevoked })),
        { accepted: true, stillReadable: true, revoked: false, oldSnapshotRejected: true, fresh: true, oldTargetStillRevoked: true });
});

test("card retirement is scoped to its consumer and permanently releases discarded handles", async t => {
    const browser = await chromium.launch(), page = await browser.newPage(), errors = [], svgErrors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
        if (message.type() === "error" && /^Error: <[\w:-]+> attribute [\w:-]+:/i.test(message.text())) svgErrors.push(message.text());
    });
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(svgErrors, []); });
    await page.setContent('<main><div id="wireSearchPanel"></div><div id="activityList"></div><div id="reportList"></div><div id="otherReport"></div></main>');
    await page.addScriptTag({ content: `
        window.allowed = true; window.opens = []; window.copies = [];
        Object.defineProperty(navigator, "clipboard", {value: {async writeText(text) {copies.push(text);}}});
        const owner = {}, ux = (${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});
        const api = Object.assign(async () => {throw Error("No network request belongs in card retirement.");},
            {publicationToken: () => allowed ? owner : null, isCurrent: value => allowed && value === owner});
        window.ui = (${mountBoundedNative.toString()})({
            api, ux, results: (${createRecordedResults.toString()})({screen: true}),
            createState: ${createBoundedNativeState.toString()}, sourceLabel: () => "Chat",
            active: () => true, conversationHref: value => "#request=" + value.conversationId,
            renderText: value => {const article = document.createElement("article"), p = document.createElement("p"); p.textContent = value; article.append(p); return article;}
        });
        window.addCard = (rootId, name) => {
            const selection = document.createElement("span");
            const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = true;
            checkbox.setAttribute("aria-label", "Select " + name); selection.append(checkbox);
            selection.append(ux.copyButton({label: "Copy " + name, getText: () => "Retained " + name}));
            const marker = ux.icon("filter"); marker.dataset.privateRecord = name; selection.append(marker);
            const item = {id: (rootId === "activityList" ? "a" : rootId === "reportList" ? "b" : "c").repeat(64),
                sourceId: "microsoft-365-chat", title: "Retained " + name,
                presentation: {kind: "prompt", tools: ["invented_lookup"], toolCount: 1, contextDateBasis: null},
                selectedRows: 1, outcomes: {success: 1, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0}};
            const article = ui.card({item, view: {revision: 7, sourceRevision: "d".repeat(64), aggregates: {layer: "tool"}},
                selection, onOpen: () => opens.push(name)});
            document.getElementById(rootId).append(article);
            return article;
        };
        window.analyze = addCard("activityList", "Analyze");
        window.report = addCard("reportList", "Report");
        window.other = addCard("otherReport", "Other report");
        window.oldAction = report.querySelector("a");
        window.oldText = report.querySelector(".request-card-prompt").firstChild;
        window.oldHref = oldAction.getAttributeNode("href");
        window.oldKey = report.getAttributeNode("data-view-key");
        window.oldCopy = report.querySelector(".ux-copy");
        window.oldCopyLabel = oldCopy.getAttributeNode("aria-label");
        window.oldSvgAttributes = ["width", "height", "viewBox", "data-private-record"]
            .map(name => report.querySelector("[data-private-record]").getAttributeNode(name));
        window.oldSelectionLabel = report.querySelector("input").getAttributeNode("aria-label");
    ` });
    await page.getByRole("button", { name: "Copy Report", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => copies), ["Retained Report"]);
    await page.evaluate(() => {
        window.retired = ui.clearCards(document.getElementById("reportList"));
        document.getElementById("reportList").replaceChildren();
    });
    await expect(page.locator("#activityList")).toContainText("Retained Analyze");
    await expect(page.locator("#otherReport")).toContainText("Retained Other report");
    assert.deepEqual(await page.evaluate(() => ({
        retired, text: oldText.data, href: oldHref.value, key: oldKey.value, copy: oldCopyLabel.value, selection: oldSelectionLabel.value,
        remaining: ui.clearCards(document.getElementById("reportList")), svg: oldSvgAttributes.map(attribute => attribute.value),
    })), { retired: 1, text: "", href: "", key: "", copy: "", selection: "", remaining: 0, svg: ["", "", "", ""] });
    await page.evaluate(() => {
        report.append(oldAction, oldCopy); document.getElementById("reportList").append(report);
        oldAction.click(); oldCopy.click();
    });
    assert.deepEqual(await page.evaluate(() => ({ opens, copies, retiredAgain: ui.clearCards(report) })),
        { opens: [], copies: ["Retained Report"], retiredAgain: 0 });
    await page.locator("#activityList .request-card-open").click();
    await page.locator("#otherReport .request-card-open").click();
    assert.deepEqual(await page.evaluate(() => opens), ["Analyze", "Other report"]);
    assert.equal(await page.evaluate(() => ui.clearCards()), 1);
    await expect(page.locator("#otherReport")).toContainText("Retained Other report");
    await expect(page.locator("#otherReport input")).toBeChecked();
    await page.evaluate(() => {
        addCard("activityList", "Fresh Analyze");
        addCard("reportList", "Fresh Report");
        allowed = false; ui.withdrawAccess();
    });
    assert.equal(await page.locator("#activityList").textContent(), "");
    assert.equal(await page.locator("#reportList").textContent(), "");
    assert.equal(await page.locator("#otherReport").textContent(), "");
    assert.equal(await page.evaluate(() => ui.clearCards(document.getElementById("otherReport"))), 0);
});
