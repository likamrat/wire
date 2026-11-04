import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { createRecollectionController } from "../lib/recollection.mjs";
import { createExportController } from "../lib/export.mjs";
import { createSavedArtifactDescriptor } from "../lib/report-artifacts.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { createDeletionFlow, mountDeletion } from "../web/deletion-flow.mjs";
import { mountRecollection, describeRecollection } from "../web/recollection-flow.mjs";
import { createSavedArtifactDeletion } from "../web/saved-artifact-deletion.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { createSearchFields } from "../web/search-field.mjs";
import { createLocalSearch } from "../web/local-search.mjs";
import { createTimeContext } from "../lib/time.mjs";

const owners = {
    deletion: { dialog: "#deleteDialog", open: "#deleteActivity", preview: "#deletePreview", confirm: "#deleteConfirm",
        check: "#deleteCheck", key: "workiq-evidence.deletion-operation", endpoint: "/api/deletion/" },
    recollection: { dialog: "#recollectDialog", open: "#recollectActivity", preview: "#recollectPreview", confirm: "#recollectConfirm",
        check: "#recollectCheck", key: "workiq-evidence.recollection-operation", endpoint: "/api/recollection/" },
    artifact: { dialog: ".deletion-dialog", open: "#artifactOpen", confirm: ".delete-object-confirm",
        check: "[data-decision-action=check]", key: "wire.saved-artifact-deletion", endpoint: "/api/artifact-deletion/" },
};

async function setup(t, kind, grant = "current") {
    const f = await recollectionFixture(t), browser = await chromium.launch();
    f.closeClient(() => browser.close());
    const deletion = createDeletionController(f.context, { describeSavedArtifact: createSavedArtifactDescriptor(f.context) });
    let artifact;
    if (kind === "recollection") {
        const preview = await deletion.preview("fixture", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
        await deletion.confirm("fixture", { operationId: preview.operationId, confirmed: true });
    } else if (kind === "artifact") {
        const exports = createExportController(f.context), state = await loadBoardState(f.context);
        const preview = await exports.preview("fixture", undefined, { promptMode: "none", formats: ["json"] }, { kind: "all", revision: state.revision });
        await exports.review("fixture", preview.previewId, true);
        const { bundle } = await exports.confirm("fixture", preview.previewId, true);
        artifact = { artifactKind: "report", artifactId: bundle.bundleId, label: "PRIVATE_SAVED_TITLE" };
    }
    const recollection = createRecollectionController(f.context);
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const calls = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let pendingGate;
    const releases = [];
    function hold(action, failure = false) {
        let release, entered;
        const held = new Promise(resolve => { release = resolve; });
        const arrived = new Promise(resolve => { entered = resolve; });
        pendingGate = { path: owners[kind].endpoint + action, failure, held, entered };
        releases.push(release);
        return { arrived, release };
    }
    t.after(() => { releases.forEach(release => release()); assert.deepEqual(errors, []); });
    await page.exposeFunction("fixtureApi", async (endpoint, input) => {
        calls.push({ endpoint, input });
        const action = endpoint.split("/").at(-1);
        let value;
        if (kind === "recollection") value = await recollection[action]("panel", input);
        else if (action === "status") value = await deletion.status(input.operationId, "panel", input.receiptToken);
        else if (kind === "artifact") value = await deletion[action === "preview" ? "previewArtifact" : action === "confirm" ? "confirmArtifact" : "cancel"]("panel", input);
        else value = await deletion[action]("panel", input);
        if (endpoint === pendingGate?.path) {
            const gate = pendingGate; pendingGate = null;
            gate.entered(); await gate.held;
            if (gate.failure) return { fixtureError: "PRIVATE_LATE_ERROR" };
        }
        return value;
    });
    const shell = renderHtmlShell("a".repeat(64), "withdrawal-proof", {
        schemaVersion: 1, mode: "unbound", runtimeId: "00000000-0000-4000-8000-000000000011",
    });
    const id = kind === "deletion" ? "deleteDialog" : "recollectDialog";
    const start = shell.indexOf(`<dialog id="${id}"`), markup = kind === "artifact" ? "" : shell.slice(start, shell.indexOf("</dialog>", start) + 9);
    await page.route("**/*", route => {
        assert.equal(route.request().url(), "https://wire.invalid/");
        return route.fulfill({ contentType: "text/html", body: `<html><body><main><div id="message" hidden></div><button id="${owners[kind].open.slice(1)}">Open</button><button id="safe">Safe work</button>${markup}</main></body></html>` });
    });
    await page.goto("https://wire.invalid/");
    await page.addScriptTag({ content: `window.factories = {
        createDeletionFlow: ${createDeletionFlow}, mountDeletion: ${mountDeletion},
        mountRecollection: ${mountRecollection}, describeRecollection: ${describeRecollection},
        createSavedArtifactDeletion: ${createSavedArtifactDeletion}, createEvidenceUX: ${createEvidenceUX},
        createTimeContext: ${createTimeContext}, createLocalSearch: ${createLocalSearch}, createSearchFields: ${createSearchFields}
    };` });
    await page.evaluate(({ kind, icons, artifact, grant }) => {
        const f = window.factories;
        window.accessEpoch = 1; window.accessLive = true; window.notices = []; window.applied = 0;
        window.completedCalls = 0; window.apiCallAttempts = 0; window.grant = grant;
        const api = async (endpoint, input) => {
            window.apiCallAttempts++;
            if (!window.accessLive) throw new Error("Synthetic access unavailable");
            try {
                const value = await window.fixtureApi(endpoint, input);
                if (value?.fixtureError) throw new Error(value.fixtureError);
                return value;
            } finally { window.completedCalls++; }
        };
        api.publicationToken = () => !window.accessLive || window.grant === "null" ? null
            : window.grant === "stale" ? window.accessEpoch - 1 : window.accessEpoch;
        api.isCurrent = token => window.grant === "truthy" ? {} : token !== null && window.accessLive && token === window.accessEpoch;
        window.api = api;
        const ux = f.createEvidenceUX(icons), restoreFocus = ux.restoreFocus;
        window.restoredFocus = 0;
        ux.restoreFocus = (...args) => { window.restoredFocus++; return restoreFocus(...args); };
        window.committed = async () => { window.applied++; if (window.holdApplied) await new Promise(resolve => { window.finishApplied = resolve; }); return true; };
        if (kind === "deletion") {
            window.machine = f.createDeletionFlow();
            window.owner = f.mountDeletion({ api, flow: window.machine, ux,
                timeContext: () => ({ timeZone: "UTC", locale: "en-US" }), onCommitted: window.committed });
        } else if (kind === "recollection") {
            window.owner = f.mountRecollection({ api, ux, time: f.createTimeContext(),
                timeContext: () => ({ timeZone: "UTC", locale: "en-US" }), search: f.createLocalSearch(),
                searchFields: f.createSearchFields(ux), describe: f.describeRecollection, canAct: () => "",
                onChanged: value => window.notices.push(value), onNotice: value => window.notices.push(value),
                onCommitted: window.committed,
                pageSources: (host, rows, renderItem, reset, isCurrent) => {
                    const paint = () => { if (isCurrent()) host.replaceChildren(...rows.map(renderItem)); };
                    window.oldPager = paint; paint();
                } });
        } else {
            window.owner = f.createSavedArtifactDeletion({ api, ux, onDeleted: window.committed,
                onError: value => window.notices.push(value), fallbackFocus: () => document.getElementById("safe") });
            document.getElementById("artifactOpen").onclick = event => window.owner.open(artifact, event.currentTarget);
        }
        window.withdraw = () => {
            window.accessLive = false; window.accessEpoch++;
            window.owner.withdrawAccess(); window.owner.withdrawAccess();
        };
        window.renew = () => { window.accessLive = true; window.accessEpoch++; window.owner.resumeAccess(); };
    }, { kind, icons: uxIcons, artifact, grant });
    async function beginPreview() {
        await page.locator(owners[kind].open).click();
        if (kind === "deletion") await page.locator("#deleteAll").check();
        if (kind === "recollection") {
            await page.locator(`#recollectSources input[value="${f.sourceId}"]`).check();
            await page.locator("#recollectFrom").fill(f.firstDay); await page.locator("#recollectTo").fill(f.firstDay);
        }
        if (owners[kind].preview) await page.locator(owners[kind].preview).click();
    }
    async function preview() {
        await beginPreview();
        await expect(page.locator(owners[kind].confirm)).toBeEnabled();
    }
    async function cleared() {
        assert.equal(await page.locator(owners[kind].dialog).isVisible(), false);
        const retained = await page.locator(owners[kind].dialog).evaluate(dialog => ({
            text: dialog.textContent, values: [...dialog.querySelectorAll("input")].map(input => input.value).join(" "),
            data: [...dialog.attributes].map(attribute => attribute.value).join(" "),
        }));
        assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_|Recollection selected chat|Recollection other chat|records across|previously deleted|managed copies|Oct |2026-/);
        const snapshot = await page.evaluate(() => window.machine?.snapshot() ?? window.owner.snapshot?.());
        if (snapshot) assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|Recollection selected chat|counts|sourceSessionIds|2026-/);
        assert.equal(await page.evaluate(() => document.activeElement.id), "safe");
        assert.equal(await page.evaluate(() => window.restoredFocus), 0, "Privacy withdrawal cannot invoke ordinary return focus");
    }
    return { f, page, calls, hold, preview, beginPreview, cleared, config: owners[kind] };
}

for (const kind of ["deletion", "recollection", "artifact"]) test(`${kind} withdrawal preserves a pending receipt and fences late success until fresh authorized recovery`, { timeout: 30000 }, async t => {
    const { page, calls, hold, preview, cleared, config } = await setup(t, kind);
    await preview();
    const gate = hold("confirm");
    try {
        await page.locator(config.confirm).click(); await gate.arrived;
        const marker = await page.evaluate(key => sessionStorage.getItem(key), config.key);
        const before = calls.length, completed = await page.evaluate(() => window.completedCalls);
        await page.evaluate(() => { window.withdraw(); document.getElementById("safe").focus(); });
        await cleared();
        await page.evaluate(() => window.renew());
        assert.equal(calls.length, before, "Renewal must not dispatch any old call");
        await page.locator(config.open).click();
        await expect(page.locator(config.check)).toBeVisible();
        const recovery = hold("status");
        try {
            await page.locator(config.check).click(); await recovery.arrived;
            gate.release();
            await page.waitForFunction(n => window.completedCalls > n, completed);
            await expect(page.locator(config.dialog)).toHaveAttribute("data-decision-phase", "checking");
            assert.equal(await page.evaluate(key => sessionStorage.getItem(key), config.key), marker);
            assert.equal(await page.evaluate(() => window.applied), 0);
            recovery.release();
            await expect(page.locator(config.dialog)).toHaveAttribute("data-decision-phase", "complete");
        } finally { recovery.release(); }
        assert.equal(calls.filter(call => call.endpoint.endsWith("/confirm")).length, 1);
        assert.equal(calls.filter(call => call.endpoint.endsWith("/cancel")).length, 0);
        assert.deepEqual(calls.at(-1).input, kind === "deletion" ? { operationId: marker } : JSON.parse(marker));
    } finally { gate.release(); }
});

for (const kind of Object.keys(owners)) {
    for (const stage of ["reading-preview", "reviewed-preview"]) test(`${kind} ${stage} withdrawal clears scope and never cancels or replays it on renew`, { timeout: 30000 }, async t => {
        const { page, calls, hold, preview, beginPreview, cleared, config } = await setup(t, kind);
        const gate = stage === "reading-preview" ? hold("preview", true) : null;
        try {
            if (gate) { await beginPreview(); await gate.arrived; } else await preview();
            const before = calls.length, completed = await page.evaluate(() => window.completedCalls);
            await page.evaluate(() => { window.withdraw(); document.getElementById("safe").focus(); });
            await cleared();
            await page.evaluate(() => { window.renew(); window.oldPager?.(); });
            assert.equal(calls.length, before);
            if (gate) { gate.release(); await page.waitForFunction(n => window.completedCalls > n, completed); }
            await cleared();
            assert.equal(await page.evaluate(key => sessionStorage.getItem(key), config.key), null);
            assert.equal(calls.filter(call => /\/(?:confirm|cancel|status)$/.test(call.endpoint)).length, 0);
            await preview();
            await expect(page.locator(config.confirm)).toBeEnabled();
            assert.equal(calls.filter(call => call.endpoint.endsWith("/preview")).length, 2, "Only explicit fresh intent obtains a new preview");
        } finally { gate?.release(); }
    });

    test(`${kind} unknown receipt remains unchanged across a revoked status error and fresh recovery`, { timeout: 30000 }, async t => {
        const { page, calls, hold, preview, cleared, config } = await setup(t, kind);
        await preview();
        const confirm = hold("confirm", true);
        try {
            await page.locator(config.confirm).click(); await confirm.arrived; confirm.release();
            await expect(page.locator(config.check)).toBeVisible();
            const marker = await page.evaluate(key => sessionStorage.getItem(key), config.key);
            const status = hold("status", true);
            try {
                await page.locator(config.check).click(); await status.arrived;
                const count = calls.length, completed = await page.evaluate(() => window.completedCalls);
                await page.evaluate(() => { window.withdraw(); document.getElementById("safe").focus(); window.renew(); });
                await cleared();
                status.release(); await page.waitForFunction(n => window.completedCalls > n, completed);
                await cleared();
                assert.equal(calls.length, count);
                assert.equal(await page.evaluate(key => sessionStorage.getItem(key), config.key), marker);
                await page.locator(config.open).click();
                const recovered = hold("status");
                try {
                    await page.locator(config.check).click(); await recovered.arrived; recovered.release();
                    await expect(page.locator(config.dialog)).toHaveAttribute("data-decision-phase", "complete");
                } finally { recovered.release(); }
                assert.equal(calls.filter(call => call.endpoint.endsWith("/confirm")).length, 1);
                assert.equal(calls.filter(call => call.endpoint.endsWith("/cancel")).length, 0);
                for (const call of calls.filter(call => call.endpoint.endsWith("/status"))) {
                    assert.deepEqual(call.input, kind === "deletion" ? { operationId: marker } : JSON.parse(marker));
                }

            } finally { status.release(); }
        } finally { confirm.release(); }
    });

    test(`${kind} confirmed-result withdrawal fences the later view callback without forgetting its settled outcome`, { timeout: 30000 }, async t => {
        const { page, calls, preview, cleared, config } = await setup(t, kind);
        await preview();
        await page.evaluate(() => { window.holdApplied = true; });
        await page.locator(config.confirm).click();
        await page.waitForFunction(() => typeof window.finishApplied === "function");
        await expect(page.locator(config.dialog)).toHaveAttribute("data-decision-phase", "complete");
        const marker = await page.evaluate(key => sessionStorage.getItem(key), config.key), count = calls.length;
        await page.evaluate(() => { window.withdraw(); document.getElementById("safe").focus(); window.renew(); window.finishApplied(); });
        await cleared();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await cleared();
        assert.equal(calls.length, count);
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), config.key), marker);
        assert.equal(await page.evaluate(() => window.applied), 1);
    });
}

test("recollection withdrawal fences the source-list response and clears its detached paging closure", { timeout: 30000 }, async t => {
    const { page, calls, hold, preview, cleared, config } = await setup(t, "recollection");
    const sources = hold("sources");
    try {
        await page.locator(config.open).click(); await sources.arrived;
        const completed = await page.evaluate(() => window.completedCalls), count = calls.length;
        await page.evaluate(() => { window.withdraw(); document.getElementById("safe").focus(); window.renew(); });
        sources.release(); await page.waitForFunction(n => window.completedCalls > n, completed);
        await cleared();
        assert.equal(calls.length, count);
        assert.equal(await page.locator("#recollectSources").textContent(), "");
        await preview();
        await page.evaluate(() => { window.withdraw(); document.getElementById("safe").focus(); window.renew(); window.oldPager(); });
        await cleared();
        assert.equal(await page.locator("#recollectSources").textContent(), "");
        assert.equal(calls.filter(call => call.endpoint.endsWith("/cancel")).length, 0);
    } finally { sources.release(); }
});

for (const kind of Object.keys(owners)) for (const grant of ["null", "stale", "truthy"]) {
    test(`${kind} ${grant} publication proof cannot dispatch, paint or resume private work`, { timeout: 30000 }, async t => {
        const { page, calls, preview, config } = await setup(t, kind, grant);
        const before = await page.locator(config.dialog).innerHTML();
        await page.locator(config.open).click();
        assert.equal(await page.locator(config.dialog).isVisible(), false);
        assert.equal(await page.locator(config.dialog).innerHTML(), before);
        assert.equal(await page.evaluate(() => window.apiCallAttempts), 0);
        await page.evaluate(() => { window.withdraw(); window.renew(); });
        const withdrawn = await page.locator(config.dialog).innerHTML();
        await page.locator(config.open).click();
        assert.equal(await page.locator(config.dialog).isVisible(), false);
        assert.equal(await page.locator(config.dialog).innerHTML(), withdrawn);
        assert.equal(await page.evaluate(() => window.apiCallAttempts), 0);
        assert.deepEqual(calls, []);
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), config.key), null);
        await page.evaluate(() => { window.grant = "current"; window.renew(); });
        assert.equal(calls.length, 0, "Grant readiness alone does not start an old request");
        await preview();
        await expect(page.locator(config.confirm)).toBeEnabled();
        assert.equal(calls.filter(call => call.endpoint.endsWith("/confirm")).length, 0);
    });
}
