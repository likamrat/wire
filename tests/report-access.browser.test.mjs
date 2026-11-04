import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mountReportComparisonJourney } from "../web/report-comparison-journey.mjs";
import { createReportSaveIdentity } from "../web/report-draft.mjs";
import { createPreparedReportFrame, createReportJourney } from "../web/report-journey.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { createSavedFilePreview, createPreparedFileInspection } from "../web/saved-file-preview.mjs";
import { createFrozenReportFrame } from "../web/live-search.mjs";

function fileInspection(host, files, options) {
    return createPreparedFileInspection(host, files, { ...options,
        createPreview: (target, value, settings) => createSavedFilePreview(target, value, { ...settings, frozenFrame: createFrozenReportFrame }),
    });
}

async function pageFor(t) {
    const browser = await chromium.launch(), page = await browser.newPage();
    t.after(() => browser.close());
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<h1 id="pageTitle" tabindex="-1">Reports</h1><main id="comparison"></main>' }));
    await page.goto("http://127.0.0.1/report-owner-fixture");
    page.setDefaultTimeout(5000);
    await page.addScriptTag({ content: [createReportSaveIdentity, mountReportComparisonJourney, createPreparedReportFrame, createReportJourney,
        createSavedFilePreview, createPreparedFileInspection, createFrozenReportFrame, fileInspection].map(fn => fn.toString()).join("\n") });
    return page;
}

test("mounted report owners reject absent or malformed authority/verifier dependencies before touching private roots", async t => {
    const page = await pageFor(t), html = renderHtmlShell("a".repeat(64), "report-access-test");
    const observations = await page.evaluate(html => {
        const token = {}, api = Object.assign(async () => { throw new Error("No dispatch expected"); }, {
            publicationToken: () => token, isCurrent: value => value === token,
        });
        const methods = ["prepareSaveIdentity", "matchesSaveIdentity", "saveIdentity", "invalidatePrepared", "dispatched",
            "uncertain", "settled", "withdrawAccess", "resumeAccess"];
        const good = { api, createSaveIdentity: createReportSaveIdentity, readSavedReports: async () => [] };
        const cases = [
            ["absent", {}],
            ["factory-only", { createSaveIdentity: createReportSaveIdentity }],
            ["api-only", { api }],
            ["missing-publication-token", { ...good, api: { isCurrent: () => true } }],
            ["missing-current-check", { ...good, api: { publicationToken: () => token } }],
            ["nonfunction-factory", { ...good, createSaveIdentity: {} }],
            ["null-verifier", { ...good, createSaveIdentity: () => null }],
            ...methods.map(method => ["invalid-" + method, { ...good, createSaveIdentity: options => ({
                ...createReportSaveIdentity(options), [method]: null,
            }) }]),
        ];
        const observations = [];
        for (const owner of ["ordinary", "comparison"]) for (const [name, options] of cases) {
            const parsed = new DOMParser().parseFromString(html, "text/html");
            document.body.replaceChildren(parsed.querySelector("#reportsView"));
            const root = document.querySelector("#reportsView"), before = root.innerHTML;
            let error;
            try {
                if (owner === "ordinary") createReportJourney({ root, ...options });
                else mountReportComparisonJourney(root, options);
            } catch (cause) { error = { type: cause.name, message: cause.message }; }
            observations.push({ owner, name, error, untouched: root.innerHTML === before });
        }
        return observations;
    }, html);
    for (const result of observations) {
        assert.equal(result.error?.type, "TypeError", JSON.stringify(result));
        assert.match(result.error.message, /publication authority|verifier interface/);
        assert.equal(result.untouched, true, JSON.stringify(result));
    }
    assert.equal(observations.length, 32);
});

test("valid mounted interfaces with null, undefined or stale tokens cannot paint, prepare, dispatch or acquire escrow", async t => {
    const page = await pageFor(t), html = renderHtmlShell("a".repeat(64), "report-access-test");
    const results = await page.evaluate(async html => {
        const results = [];
        for (const mode of ["null", "undefined", "stale"]) {
            let dispatches = 0;
            const token = {};
            const api = Object.assign(async () => { dispatches++; throw new Error("No dispatch expected"); }, {
                publicationToken: () => mode === "null" ? null : mode === "undefined" ? undefined : token,
                isCurrent: () => mode !== "stale",
            });
            const parsed = new DOMParser().parseFromString(html, "text/html");
            document.body.replaceChildren(parsed.querySelector("#reportsView"));
            const root = document.querySelector("#reportsView");
            const ordinary = createReportJourney({ root, api, createSaveIdentity: createReportSaveIdentity, readSavedReports: async () => [] });
            ordinary.update({ scopeReady: true, requestCount: 1, title: "PRIVATE TITLE", entry: { sessionName: "PRIVATE CHAT" } });
            const scan = ordinary.beginScan();
            let rejected = false;
            try { await ordinary.prepareSaveIdentity({ previewId: "private-preview", bundleId: "private-bundle", title: "PRIVATE TITLE" }); }
            catch { rejected = true; }
            results.push({ mode, owner: "ordinary", scan, rejected, text: root.textContent,
                snapshot: ordinary.snapshot(), escrow: ordinary.saveIdentity(), resumed: ordinary.resumeAccess() });
            const comparison = mountReportComparisonJourney(root, { api, createSaveIdentity: createReportSaveIdentity });
            comparison.receive([{ kind: "report", bundleId: "private-bundle", title: "PRIVATE TITLE" }]);
            await comparison.open("private-bundle");
            results.push({ mode, owner: "comparison", text: root.textContent, escrow: comparison.saveIdentity(), resumed: comparison.resumeAccess(), dispatches });
        }
        return results;
    }, html);
    for (const result of results) {
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private-bundle|private-preview/);
        assert.equal(result.escrow, null);
        assert.equal(result.resumed, false);
        if (result.owner === "ordinary") { assert.equal(result.scan, null); assert.equal(result.rejected, true); }
        else assert.equal(result.dispatches, 0);
    }
});

for (const held of ["inspect", "preview", "review", "save", "open", "hash", "match"]) test(`comparison withdrawal clears private owners and fences late ${held} without cancel or replay`, async t => {
    const page = await pageFor(t);
    await page.evaluate(held => {
        window.calls = []; window.errors = [];
        window.allowed = true; window.epoch = {};
        window.hold = held;
        window.sources = ["earlier-private", "later-private"].map(bundleId => ({
            bundleId, kind: "report", title: "PRIVATE SOURCE TITLE " + bundleId, preparedAt: "2026-10-01",
            requestGroupCount: 2, formats: ["html"], comparisonEligibility: "available",
        }));
        window.available = [...window.sources];
        window.result = {
            kind: "comparison", previewId: "preview-original", bundleId: "bundle-original", title: "PRIVATE REVIEW TITLE",
            comparison: { private: "PRIVATE FACTS" }, privacy: { allSelectedFieldsScanned: true },
            previewHtml: "<h1>PRIVATE DOCUMENT</h1>",
            files: { "comparison-report.html": "PRIVATE BYTES", "coverage-and-redaction-manifest.json": '{"reviewerConfirmed":false}' },
        };
        const responses = {
            inspect: { comparison: { private: "PRIVATE FACTS" } },
            preview: window.result,
            review: { ...window.result, privacy: { allSelectedFieldsScanned: true, reviewerConfirmed: true },
                files: { ...window.result.files, "coverage-and-redaction-manifest.json": '{"reviewerConfirmed":true}' } },
            save: { bundle: { bundleId: "bundle-original", kind: "comparison", title: "PRIVATE REVIEW TITLE" } },
            open: { comparison: { private: "PRIVATE SAVED FACTS" }, artifact: { title: "PRIVATE SAVED TITLE" } },
        };
        const api = async (path, body) => {
            const action = path.split("/").at(-1);
            window.calls.push(action);
            if (action === "list") return { artifacts: window.available };
            if (action === held) return new Promise(resolve => { window.releaseHeld = () => resolve(responses[action]); });
            if (action === "cancel") return {};
            return responses[action];
        };
        api.publicationToken = () => window.allowed ? window.epoch : null;
        api.isCurrent = token => window.allowed && token !== null && token === window.epoch;
        let hashes = 0;
        window.journey = mountReportComparisonJourney(document.querySelector("#comparison"), {
            createFileInspection: fileInspection,
            api, createSaveIdentity: options => createReportSaveIdentity({ ...options, digest: bytes => {
                const result = crypto.subtle.digest("SHA-256", bytes);
                hashes++;
                return held === "hash" || held === "match" && hashes === 2 ? new Promise(resolve => { window.releaseHeld = () => result.then(resolve); }) : result;
            } }),
            renderer: { render(root, facts) { root.textContent = JSON.stringify(facts); }, clear(root) { root.replaceChildren(); } },
            timeContext: () => ({ timeZone: "UTC", locale: "en-US" }),
            refresh: async () => { window.calls.push("fresh-list"); return window.available; },
            onError: message => window.errors.push(message), inspectSource() {},
        });
    }, held);
    if (held === "open") {
        await page.evaluate(() => { window.pending = window.journey.open("saved-private-id"); });
    } else {
        await page.evaluate(() => window.journey.open());
        const choices = page.locator(".comparison-selectors select");
        await choices.nth(0).selectOption("earlier-private");
        await choices.nth(1).selectOption("later-private");
        await page.getByRole("button", { name: "Compare reports", exact: true }).click();
        if (held !== "inspect") {
            await page.locator("#comparisonReportTitle").fill("PRIVATE REVIEW TITLE");
            await page.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
            if (!["preview"].includes(held)) {
                await page.locator("iframe").waitFor();
                await page.getByRole("checkbox", { name: /reviewed this frozen comparison/ }).check();
                await page.getByRole("button", { name: "Approve for local saving" }).click();
                if (["save", "hash", "match"].includes(held)) await page.getByRole("button", { name: "Save comparison", exact: true }).click();
            }
        }
    }
    await page.waitForFunction(() => typeof window.releaseHeld === "function");
    const result = await page.evaluate(() => {
        const owner = document.querySelector("#comparison");
        window.retiredFrame = owner.querySelector("iframe");
        window.retiredFileTexts = [...owner.querySelectorAll("pre")];
        window.retiredButtons = [...owner.querySelectorAll("button")];
        window.allowed = false;
        window.journey.withdrawAccess(); window.journey.withdrawAccess();
        return { text: owner.textContent, values: [...owner.querySelectorAll("input,select,textarea")].map(node => node.value),
            html: owner.innerHTML, title: window.journey.title(), fileTexts: window.retiredFileTexts.map(node => node.textContent),
            escrow: window.journey.saveIdentity(), calls: [...window.calls] };
    });
    assert.doesNotMatch(JSON.stringify([result.text, result.values, result.html, result.title, result.fileTexts, result.escrow]), /PRIVATE|earlier-private|later-private|saved-private-id/);
    if (["save", "match"].includes(held)) {
        assert.equal(result.escrow.bundleId, "bundle-original");
        assert.equal(result.escrow.unknown, true);
        assert.equal(result.escrow.dispatched, true);
    } else assert.equal(result.escrow, null);
    await page.evaluate(async () => {
        window.retiredButtons.forEach(button => { button.disabled = false; button.click(); });
        window.releaseHeld();
        await window.pending;
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.deepEqual(await page.evaluate(() => window.calls), result.calls, "Withdrawal/late completion never cancels or repeats a request");
    assert.doesNotMatch(await page.locator("#comparison").evaluate(node => node.innerHTML), /PRIVATE/);
    assert.deepEqual(await page.evaluate(() => window.errors), []);
    if (["save", "match"].includes(held)) {
        await page.evaluate(async () => {
            window.allowed = true; window.epoch = {};
            window.journey.resumeAccess();
            window.available = [{ bundleId: "bundle-original", kind: "comparison", title: "Wrong identity" }];
            await window.journey.recoverSave();
        });
        assert.equal(await page.evaluate(() => window.journey.saveIdentity().unknown), true);
        await page.evaluate(async () => {
            window.available = [{ bundleId: "bundle-original", kind: "comparison", title: "PRIVATE REVIEW TITLE" }];
            await window.journey.recoverSave();
        });
        assert.equal(await page.evaluate(() => window.journey.saveIdentity()), null);
        assert.equal((await page.evaluate(() => window.calls)).filter(action => action === "save").length, 1);
    }
});

for (const authority of ["current", "withdrawn", "expired", "replaced", "resumed"]) test(`superseded comparison preview cleanup uses only its original ${authority} publication`, async t => {
    const page = await pageFor(t);
    const result = await page.evaluate(async authority => {
        let allowed = true, epoch = {};
        const original = epoch, calls = [], errors = [];
        const sources = ["earlier", "later"].map(bundleId => ({
            bundleId, kind: "report", title: bundleId, comparisonEligibility: "available",
        }));
        const preview = id => ({
            kind: "comparison", previewId: id, bundleId: "bundle-" + id, title: id,
            comparison: { id }, privacy: { allSelectedFieldsScanned: true },
            previewHtml: "<p>" + id + "</p>", files: { "comparison-report.html": id },
        });
        const oldResponse = Promise.withResolvers(), newResponse = Promise.withResolvers(), cleanup = Promise.withResolvers();
        const api = Object.assign(async (path, body) => {
            const action = path.split("/").at(-1);
            calls.push({ action, body, originalGrant: epoch === original });
            if (action === "inspect") return { comparison: { id: "facts" } };
            if (action === "preview") return calls.filter(call => call.action === "preview").length === 1 ? oldResponse.promise : newResponse.promise;
            if (action === "cancel") return body.previewId === "old-preview" ? cleanup.promise : {};
            throw new Error("Unexpected request " + action);
        }, {
            publicationToken: () => allowed ? epoch : null,
            isCurrent: token => allowed && token !== null && token === epoch,
        });
        const root = document.querySelector("#comparison");
        const journey = mountReportComparisonJourney(root, {
            createFileInspection: fileInspection,
            api, createSaveIdentity: createReportSaveIdentity, timeContext: () => ({ timeZone: "UTC", locale: "en-US" }),
            renderer: { render(node, facts) { node.textContent = facts.id; }, clear(node) { node.replaceChildren(); } },
            onError: error => errors.push(error),
        });
        journey.receive(sources);
        const selects = root.querySelectorAll("select");
        for (const [index, id] of ["earlier", "later"].entries()) {
            selects[index].value = id;
            selects[index].dispatchEvent(new Event("change"));
        }
        const click = label => [...root.querySelectorAll("button")].find(node => node.textContent === label).click();
        const settle = () => new Promise(resolve => setTimeout(resolve, 0));
        click("Compare reports"); await settle();
        click("Prepare comparison copy");
        journey.invalidate("Superseded by another report preparation.", false, { force: true });
        if (authority === "withdrawn" || authority === "resumed") {
            allowed = false; journey.withdrawAccess();
            if (authority === "resumed") { allowed = true; epoch = {}; journey.resumeAccess(); }
        } else if (authority === "expired") allowed = false;
        else if (authority === "replaced") epoch = {};
        if (authority === "current") click("Prepare comparison copy");
        oldResponse.resolve(preview("old-preview")); await settle();
        const afterOld = { calls: [...calls], busy: journey.isBusy(),
            frames: [...root.querySelectorAll("iframe")].map(frame => frame.srcdoc), errors: [...errors] };
        let successorFrames;
        if (authority === "current") {
            newResponse.resolve(preview("new-preview")); await settle();
            successorFrames = [...root.querySelectorAll("iframe")].map(frame => frame.srcdoc);
            journey.invalidate("Retire the successor independently.", false, { force: true });
            if (calls.some(call => call.action === "cancel" && call.body.previewId === "old-preview")) cleanup.reject(new Error("Late cleanup failure"));
            else cleanup.resolve({});
            await settle();
        }
        return { afterOld, calls, errors, successorFrames, escrow: journey.saveIdentity(),
            frames: [...root.querySelectorAll("iframe")].map(frame => frame.srcdoc), busy: journey.isBusy() };
    }, authority);
    const cancellations = result.afterOld.calls.filter(call => call.action === "cancel");
    assert.deepEqual(cancellations, authority === "current"
        ? [{ action: "cancel", body: { previewId: "old-preview" }, originalGrant: true }] : []);
    assert.deepEqual(result.afterOld.frames, []);
    assert.deepEqual(result.afterOld.errors, []);
    assert.equal(result.escrow, null);
    assert.deepEqual(result.errors, []);
    if (authority === "current") {
        assert.equal(result.afterOld.busy, true, "Old cleanup/finalization must not unlock the newer pending Prepare");
        assert.deepEqual(result.successorFrames, ["<p>new-preview</p>"]);
        assert.deepEqual(result.calls.filter(call => call.action === "cancel").map(call => call.body.previewId), ["old-preview", "new-preview"]);
        assert.equal(result.calls.filter(call => call.action === "preview").length, 2);
    } else assert.equal(result.calls.filter(call => call.action === "preview").length, 1);
});

test("ordinary journey clears actual shell draft/review DOM and retains only original opaque recovery", async t => {
    const page = await pageFor(t);
    const html = renderHtmlShell("a".repeat(64), "report-access-test");
    await page.evaluate(html => {
        const parsed = new DOMParser().parseFromString(html, "text/html");
        document.body.replaceChildren(parsed.querySelector("#reportsView"));
        document.querySelector("#reportsView").hidden = false;
        window.allowed = true; window.epoch = {};
        const api = { publicationToken: () => window.allowed ? window.epoch : null,
            isCurrent: token => window.allowed && token !== null && token === window.epoch };
        window.originalReads = 0; window.downloads = 0;
        window.journey = createReportJourney({ root: document.querySelector("#reportsView"), api, createSaveIdentity: createReportSaveIdentity,
            readSavedReports: async () => { window.originalReads++; return window.available; }, downloadFile: async () => { window.downloads++; } });
        const preview = { previewId: "preview-original", bundleId: "bundle-original", title: "PRIVATE TITLE", privacy: { allSelectedFieldsScanned: true } };
        window.journey.update({ requestCount: 19, sourceSessionCount: 7, scopeReady: true,
            authorFiltered: true, authorLabel: "PRIVATE AUTHOR", entry: { sessionName: "PRIVATE CHAT" }, title: "PRIVATE TITLE" });
        window.retainedMetadata = {
            scopeAuthors: document.querySelector(".report-content-authors"),
            contextName: document.querySelector(".report-entry-name"),
            activityChats: document.querySelector("#reportActivitySummary").children[0],
            activityInteractions: document.querySelector("#reportActivitySummary").children[1],
        };
        window.readMetadata = () => Object.fromEntries(Object.entries(window.retainedMetadata).map(([key, node]) => [key, node.textContent]));
        window.contextExplanation = document.querySelector(".report-entry-context").lastElementChild;
        document.querySelector("#reportTitle").value = "PRIVATE TITLE";
        document.querySelector("#manualTerms").value = "PRIVATE TERM";
        document.querySelector("#reportList").textContent = "PRIVATE SELECTION";
        window.journey.beginScan();
        const host = window.journey.reviewHost;
        host.innerHTML = '<p>PRIVATE REPORT BODY</p><textarea>PRIVATE COPY</textarea><iframe title="PRIVATE DOCUMENT" srcdoc="<p>PRIVATE BYTES</p>"></iframe>';
        window.retiredTextarea = host.querySelector("textarea"); window.retiredFrame = host.querySelector("iframe");
        window.journey.previewReady(preview);
        window.journey.reviewed();
        window.preparedIdentity = window.journey.prepareSaveIdentity(preview);
    }, html);
    assert.deepEqual(await page.evaluate(() => window.readMetadata()), {
        scopeAuthors: "Authors: PRIVATE AUTHOR", contextName: "PRIVATE CHAT",
        activityChats: "7 chats", activityInteractions: "19 interactions included",
    });
    await page.evaluate(async () => {
        await window.preparedIdentity;
        window.originalEscrow = window.journey.saveIdentity();
        window.journey.writing(true);
        window.allowed = false; window.journey.withdrawAccess(); window.journey.withdrawAccess();
    });
    const scrubbed = await page.evaluate(() => ({
        html: document.querySelector("#reportsView").innerHTML,
        values: [...document.querySelectorAll("input,textarea,select")].map(node => node.value),
        detached: [window.retiredTextarea.value, window.retiredTextarea.textContent, window.retiredFrame.srcdoc, window.retiredFrame.title],
        state: window.journey.snapshot(), escrow: window.journey.saveIdentity(),
        metadata: window.readMetadata(),
        metadataConnected: Object.values(window.retainedMetadata).every(node => node.isConnected),
        explanationConnected: window.contextExplanation.isConnected,
        explanation: window.contextExplanation.textContent,
    }));
    assert.deepEqual(scrubbed.metadata, { scopeAuthors: "", contextName: "", activityChats: "", activityInteractions: "" },
        "Withdrawal must erase private values held by the persistent hierarchy nodes, not just their ancestors");
    assert.doesNotMatch(JSON.stringify(scrubbed), /PRIVATE/);
    assert.equal(scrubbed.metadataConnected, true);
    assert.equal(scrubbed.explanationConnected, true);
    assert.equal(scrubbed.explanation, "Saved activity across all retained dates and services. New interactions are not added automatically.");
    assert.equal(scrubbed.state.saveUnconfirmed, true);
    assert.deepEqual(scrubbed.escrow, { ...await page.evaluate(() => window.originalEscrow), dispatched: true, unknown: true });
    await page.evaluate(() => {
        window.allowed = true; window.epoch = {}; window.journey.resumeAccess();
        window.available = [{ bundleId: "bundle-original", kind: "report", title: "PRIVATE TITLE", files: { "product-report.html": true } }];
    });
    await page.getByRole("button", { name: "Check save status", exact: true }).click();
    await page.waitForFunction(() => window.journey.snapshot().phase === "saved");
    assert.equal(await page.evaluate(() => window.originalReads), 1);
    assert.equal(await page.evaluate(() => window.journey.saveIdentity()), null);
    await page.evaluate(() => {
        window.retiredDownload = [...document.querySelectorAll("button")].find(node => node.textContent === "Download");
        window.allowed = false; window.journey.withdrawAccess();
        window.retiredDownload.click();
    });
    assert.equal(await page.evaluate(() => window.downloads), 0);
    const reentry = await page.evaluate(() => {
        window.allowed = true; window.epoch = {}; window.journey.resumeAccess();
        const returned = window.journey.go(1);
        window.journey.update({ requestCount: 3, sourceSessionCount: 1, scopeReady: true,
            authorFiltered: true, authorLabel: "FRESH AUTHOR", entry: { sessionName: "FRESH CHAT" } });
        return { returned, metadata: window.readMetadata(), context: document.querySelector(".report-entry-context").textContent,
            activity: document.querySelector("#reportActivitySummary").textContent,
            metadataConnected: Object.values(window.retainedMetadata).every(node => node.isConnected),
            explanationConnected: window.contextExplanation.isConnected };
    });
    assert.equal(reentry.returned, true);
    assert.deepEqual(reentry.metadata, { scopeAuthors: "Authors: FRESH AUTHOR", contextName: "FRESH CHAT",
        activityChats: "1 chat", activityInteractions: "3 interactions included" });
    assert.equal(reentry.context, `FRESH CHAT ${scrubbed.explanation}`);
    assert.equal(reentry.activity, "1 chat 3 interactions included");
    assert.equal(reentry.metadataConnected, true);
    assert.equal(reentry.explanationConnected, true);
    await page.evaluate(() => {
        window.allowed = false; window.journey.withdrawAccess();
        window.retiredDownload.click();
    });
    assert.deepEqual(await page.evaluate(() => window.readMetadata()), {
        scopeAuthors: "", contextName: "", activityChats: "", activityInteractions: "",
    });
    assert.equal(await page.evaluate(() => window.downloads), 0);
});

test("prepared frame withdrawal erases same-origin document and fences late measurement/navigation", async t => {
    const page = await pageFor(t);
    await page.evaluate(() => {
        window.valid = true; window.frameErrors = [];
        window.reader = createPreparedReportFrame('<h1>PRIVATE FRAME TITLE</h1><a href="#private">Read</a><p id="private">PRIVATE FRAME BODY</p>',
            (html, doc) => { const frame = doc.createElement("iframe"); frame.srcdoc = html; return frame; },
            { isCurrent: () => window.valid, onError: error => window.frameErrors.push(error) });
        document.querySelector("#comparison").append(window.reader.frame);
    });
    await page.frameLocator("iframe").getByText("PRIVATE FRAME BODY", { exact: true }).waitFor();
    const result = await page.evaluate(async () => {
        const frame = window.reader.frame, doc = frame.contentDocument;
        window.valid = false; window.reader.withdrawAccess(); window.reader.withdrawAccess();
        window.dispatchEvent(new Event("resize"));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { connected: frame.isConnected, title: frame.title, source: frame.srcdoc, retainedDocument: doc.documentElement.textContent,
            errors: window.frameErrors, active: document.activeElement.id };
    });
    assert.equal(result.connected, false);
    assert.equal(result.title, "");
    assert.equal(result.source, "");
    assert.equal(result.retainedDocument, "");
    assert.deepEqual(result.errors, []);
});
