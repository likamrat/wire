import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createSavedArtifactDeletion } from "../web/saved-artifact-deletion.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { deletionStyles } from "../web/deletion-styles.mjs";

const operationId = "00000000-0000-4000-8000-000000000001";
const artifact = { artifactKind: "report", artifactId: "export-00000000-0000-4000-8000-000000000002", label: "Artificial saved report" };
const receipt = { operationId, receiptToken: "a".repeat(64) };
const preview = { ...receipt, artifact, counts: { managedFiles: 1, managedCopies: 0, savedDependentComparisons: 0 } };
function deferred() {
    let resolve;
    const promise = new Promise(value => { resolve = value; });
    return { promise, resolve };
}
async function setup(t, api, onDeleted = async () => true, stored = null) {
    const browser = await chromium.launch(), page = await browser.newPage();
    const errors = [], calls = [];
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.request().url() === "https://wire.invalid/"
        ? route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><main><h2 id="destination" tabindex="-1">Destination</h2><button id="open">Open saved object</button></main></body></html>' })
        : route.abort());
    await page.exposeFunction("fakeApi", async (route, input) => { calls.push({ route, input }); return api(route, input); });
    await page.exposeFunction("refreshSaved", onDeleted);
    await page.goto("https://wire.invalid/");
    await page.addStyleTag({ content: styles + deletionStyles });
    await page.addScriptTag({ content: `window.makeFlow=${createSavedArtifactDeletion.toString()};window.makeUx=${createEvidenceUX.toString()};` });
    await page.evaluate(({ artifact, receipt, icons }) => {
        if (receipt) sessionStorage.setItem("wire.saved-artifact-deletion", JSON.stringify(receipt));
        window.applied = false;
        window.flow = window.makeFlow({
            api: window.fakeApi, ux: window.makeUx(icons),
            onDeleted: async value => { const result = await window.refreshSaved(value); window.applied = true; return result; },
            onError: message => { throw new Error(message); }, fallbackFocus: () => document.getElementById("destination"),
        });
        document.getElementById("open").onclick = event => window.flow.open(artifact, event.currentTarget);
        window.addEventListener("hashchange", () => { window.flow.leave(); document.getElementById("destination").focus(); });
    }, { artifact, receipt: stored, icons: uxIcons });
    return { page, calls };
}

test("receipt READ closes on route leave and late completion/refresh never reopens or steals destination focus", async t => {
    const read = deferred(), reading = deferred(), refresh = deferred(), refreshing = deferred();
    t.after(() => { read.resolve(); refresh.resolve(); });
    const { page, calls } = await setup(t, async route => {
        assert.equal(route, "/api/artifact-deletion/status");
        reading.resolve(); await read.promise;
        return { operationId, kind: "artifact-deletion", phase: "complete", artifact };
    }, async () => { refreshing.resolve(); await refresh.promise; return true; }, receipt);
    await page.locator("#open").click();
    await page.getByRole("button", { name: "Check deletion result", exact: true }).click();
    await reading.promise;
    await page.evaluate(() => { location.hash = "#destination"; });
    await page.waitForFunction(() => !document.querySelector(":modal"));
    assert.equal(await page.locator("#destination").evaluate(node => node === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("wire.saved-artifact-deletion"))), receipt);
    await page.evaluate(artifact => window.flow.open(artifact, document.getElementById("open")), artifact);
    assert.equal(calls.length, 1, "A closed pending read cannot start another operation.");
    read.resolve(); await refreshing.promise;
    await page.evaluate(artifact => window.flow.open(artifact, document.getElementById("open")), artifact);
    assert.equal(calls.length, 1, "An outstanding list refresh still excludes a parallel operation.");
    refresh.resolve(); await page.waitForFunction(() => window.applied);
    assert.equal(await page.locator(":modal").count(), 0);
    assert.equal(await page.locator("#destination").evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.saved-artifact-deletion")), null);
});

test("preview READ is dismissible and cancelled once, while confirmed WRITE keeps its original dismissal guard", async t => {
    const read = deferred(), reading = deferred(), writing = deferred(), write = deferred();
    t.after(() => { read.resolve(); write.resolve(); });
    let previews = 0;
    const { page, calls } = await setup(t, async route => {
        if (route.endsWith("/preview")) {
            if (++previews === 1) { reading.resolve(); await read.promise; }
            return preview;
        }
        if (route.endsWith("/cancel")) return { cancelled: true };
        if (route.endsWith("/confirm")) { writing.resolve(); await write.promise; return { operationId, kind: "artifact-deletion", phase: "complete", artifact }; }
        throw new Error("Unexpected operation.");
    });
    await page.locator("#open").click(); await reading.promise;
    await page.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(await page.locator(":modal").count(), 0);
    await page.evaluate(artifact => window.flow.open(artifact, document.getElementById("open")), artifact);
    assert.equal(previews, 1);
    read.resolve();
    await page.waitForFunction(() => document.querySelector("dialog").getAttribute("aria-busy") === "false");
    assert.equal(calls.filter(call => call.route.endsWith("/cancel")).length, 1);
    await page.locator("#open").click();
    await page.getByRole("button", { name: "Delete report", exact: true }).click(); await writing.promise;
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(":modal").count(), 1);
    assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true);
    write.resolve(); await page.waitForFunction(() => window.applied);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(calls.filter(call => call.route.endsWith("/confirm")).length, 1);
});
