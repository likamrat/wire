import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { createSavedArtifactDeletion } from "../web/saved-artifact-deletion.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { deletionStyles } from "../web/deletion-styles.mjs";

const artifact = { artifactKind: "report", artifactId: "export-00000000-0000-4000-8000-000000000001", label: "Artificial baseline / 6 October" };
async function setup(t, handler, target = artifact) {
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 950 }, reducedMotion: "reduce" });
    const calls = [], errors = [], unexpected = [];
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (route.request().url() === "https://wire.invalid/") return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h2 id="saved" tabindex="-1">Saved reports</h2><button id="open">Delete report</button></main></body></html>',
        });
        unexpected.push(route.request().url()); return route.abort();
    });
    await page.exposeFunction("syntheticArtifactApi", async (path, input) => {
        calls.push({ path, input });
        return handler(path, input);
    });
    await page.goto("https://wire.invalid/");
    await page.addStyleTag({ content: styles + deletionStyles });
    await page.addScriptTag({ content: `
        window.createArtifactDeletion = ${createSavedArtifactDeletion.toString()};
        window.createUX = ${createEvidenceUX.toString()};
    ` });
    await page.evaluate(({ artifact, icons }) => {
        window.deleted = []; window.notices = [];
        window.flow = window.createArtifactDeletion({
            api: async (path, input) => {
                const result = await window.syntheticArtifactApi(path, input);
                if (result.failure) throw new Error(result.failure);
                return result;
            },
            ux: window.createUX(icons),
            onDeleted: async value => { window.deleted.push(value); document.getElementById("open")?.remove(); return true; },
            onError: message => window.notices.push(message),
            fallbackFocus: () => document.getElementById("saved"),
        });
        document.getElementById("open").onclick = event => window.flow.open(artifact, event.currentTarget);
    }, { artifact: target, icons: uxIcons });
    await page.evaluate(() => document.fonts.ready);
    return { page, calls };
}
function preview(operationId = randomUUID()) {
    return {
        operationId, receiptToken: "a".repeat(64), revision: 4, artifactRevision: 1, expiresAt: "2026-10-06T12:02:00.000Z",
        artifact: { artifactKind: artifact.artifactKind, artifactId: artifact.artifactId },
        counts: { managedFiles: 3, managedCopies: 1, savedDependentComparisons: 2 },
    };
}

test("named saved-object deletion has safe cancel, no cascade and centered accessible confirmation", { timeout: 30000 }, async t => {
    const pending = preview();
    const { page, calls } = await setup(t, async path => path.endsWith("/preview") ? pending : { cancelled: true });
    await page.locator("#open").click();
    const dialog = page.locator(".deletion-dialog"), confirm = dialog.locator(".delete-object-confirm");
    await page.waitForFunction(() => !document.querySelector(".delete-object-confirm").disabled);
    assert.match(await dialog.textContent(), /3 managed files and 1 managed copies/);
    assert.match(await dialog.textContent(), /2 saved comparisons keep frozen information/);
    assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(node => node === document.activeElement), true);
    for (const theme of ["light", "dark"]) for (const width of [320, 375, 414, 768, 820, 1200, 2560]) for (const scale of [100, 200]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ theme, scale }) => { document.documentElement.dataset.evidenceTheme = theme; document.documentElement.style.fontSize = `${scale}%`; }, { theme, scale });
        await page.evaluate(() => document.fonts.ready);
        const geometry = await dialog.evaluate(node => {
            const button = node.querySelector(".delete-object-confirm"), box = button.getBoundingClientRect();
            const style = getComputedStyle(button), text = [...button.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
            const range = document.createRange(); range.selectNodeContents(text);
            const glyph = range.getBoundingClientRect();
            return {
                fits: node.scrollWidth <= node.clientWidth + 1 && node.getBoundingClientRect().right <= innerWidth,
                height: box.height, radius: parseFloat(style.borderRadius), controlRadius: parseFloat(style.getPropertyValue("--radius-control")), centered: Math.abs((glyph.left + glyph.right - box.left - box.right) / 2),
                fill: style.backgroundColor, loaded: [...document.fonts].some(face => face.family.includes("Asta Sans") && face.status === "loaded"),
            };
        });
        assert.equal(geometry.fits, true, `${theme}/${width}/${scale}`);
        assert.ok(geometry.height >= 44);
        assert.equal(geometry.radius, geometry.controlRadius, "Danger confirmation preserves the shared action corners");
        assert.ok(geometry.centered <= 1, `${theme}/${width}/${scale} label offset ${geometry.centered}`);
        assert.equal(geometry.loaded, true);
    }
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.locator("#open").evaluate(node => node === document.activeElement), true);
    assert.equal(calls.some(call => call.path.endsWith("/confirm")), false);
    assert.deepEqual(await page.evaluate(() => window.deleted), []);
});

test("lost delete response offers only original-operation status and returns focus after row removal", { timeout: 30000 }, async t => {
    const pending = preview(), completed = { ...pending, kind: "artifact-deletion", phase: "complete" };
    const { page, calls } = await setup(t, async path => {
        if (path.endsWith("/preview")) return pending;
        if (path.endsWith("/confirm")) return { failure: "Artificial lost response." };
        if (path.endsWith("/status")) return completed;
        throw new Error("Unexpected mutation.");
    });
    await page.locator("#open").click();
    const dialog = page.locator(".deletion-dialog");
    await page.waitForFunction(() => !document.querySelector(".delete-object-confirm").disabled);
    await dialog.getByRole("button", { name: "Delete report", exact: true }).click();
    await dialog.getByRole("button", { name: "Check deletion result", exact: true }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Delete report", exact: true }).isVisible(), false);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("#open").click();
    assert.match(await dialog.textContent(), /Check an earlier saved-object deletion/);
    await dialog.getByRole("button", { name: "Check deletion result", exact: true }).click();
    await page.waitForFunction(() => window.deleted.length === 1);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === "saved");
    assert.equal(await page.locator("#saved").evaluate(node => node === document.activeElement), true);
    assert.equal(calls.filter(call => call.path.endsWith("/preview")).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith("/confirm")).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith("/status")).length, 1);
    assert.deepEqual(calls.find(call => call.path.endsWith("/confirm")).input, { operationId: pending.operationId, confirmed: true });
    assert.deepEqual(calls.find(call => call.path.endsWith("/status")).input, { operationId: pending.operationId, receiptToken: pending.receiptToken });
    assert.equal(await page.locator("body").textContent().then(text => text.includes(pending.receiptToken)), false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("wire.saved-artifact-deletion")), null);
});

test("missing counts fail closed and never become zero-count deletion approval", { timeout: 30000 }, async t => {
    const malformed = preview(); delete malformed.counts.managedCopies;
    const { page, calls } = await setup(t, async () => malformed);
    await page.locator("#open").click();
    const dialog = page.locator(".deletion-dialog");
    await dialog.getByRole("alert").waitFor();
    assert.match(await dialog.textContent(), /did not confirm.*Nothing was deleted/);
    assert.equal(await dialog.getByRole("button", { name: "Delete report", exact: true }).isVisible(), false);
    assert.equal(calls.some(call => call.path.endsWith("/confirm")), false);
});

test("bulk confirmation names all reports across pages, preserves exclusions and recovers a lost response without resubmitting", async t => {
    const pending = { ...preview(), scope: "all-reports",
        artifacts: [artifact, { ...artifact, artifactId: "export-00000000-0000-4000-8000-000000000002" }],
        counts: { reports: 2, managedFiles: 10, managedCopies: 2, savedComparisons: 3, savedDependentComparisons: 1 } };
    delete pending.artifact;
    const { page, calls } = await setup(t, async path => {
        if (path.endsWith("/preview")) return pending;
        if (path.endsWith("/cancel")) return { cancelled: true };
        if (path.endsWith("/confirm")) return { failure: "Artificial interrupted connection." };
        if (path.endsWith("/status")) return { ...pending, kind: "artifact-deletion", phase: "complete" };
        throw new Error("Unexpected call");
    }, { scope: "all-reports" });
    await page.locator("#open").click();
    const dialog = page.locator(".deletion-dialog");
    await dialog.getByRole("button", { name: "Delete 2 saved reports", exact: true }).waitFor();
    assert.match(await dialog.innerText(), /all pages.*regardless of search/i);
    assert.match(await dialog.innerText(), /3 saved comparisons/);
    assert.match(await dialog.innerText(), /draft reports.*external downloads/i);
    assert.match(await dialog.innerText(), /Unsaved comparisons using these reports will become invalid/);
    assert.match(await dialog.innerText(), /New reports saved after this preview are not included/);
    assert.match(await dialog.innerText(), /Permanent local deletion.*cannot be undone.*If interrupted, some files may remain/);
    assert.doesNotMatch(await dialog.innerText(), /keep the receipt|sealed|atomic/i);
    assert.equal((await dialog.innerText()).match(/3 saved comparisons/g).length, 1, "Comparison retention is explained once");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(calls.filter(call => call.path.endsWith("/confirm")).length, 0);
    await page.locator("#open").click();
    await dialog.getByRole("button", { name: "Delete 2 saved reports", exact: true }).click();
    await dialog.getByRole("button", { name: "Check deletion result", exact: true }).click();
    await dialog.getByRole("heading", { name: "2 saved reports deleted", exact: true }).waitFor();
    assert.equal(calls.filter(call => call.path.endsWith("/confirm")).length, 1);
    assert.deepEqual(calls.find(call => call.path.endsWith("/preview")).input, { scope: "all-reports" });
    assert.equal((await page.evaluate(() => window.deleted))[0].artifacts.length, 2);
});

test("bulk scope validation and stale-state invalidation never enable an unreviewed deletion", async t => {
    const pending = { ...preview(), scope: "all-reports", artifacts: [artifact],
        counts: { reports: 1, managedFiles: 3, managedCopies: 1, savedComparisons: 0, savedDependentComparisons: 0 } };
    delete pending.artifact;
    for (const change of [
        value => { value.counts.reports = 2; },
        value => { value.artifacts[0].artifactKind = "comparison"; },
        value => { value.artifacts.push({ ...value.artifacts[0] }); value.counts.reports = 2; },
    ]) {
        const invalid = structuredClone(pending); change(invalid);
        await t.test("malformed bound membership fails closed", async t => {
            const { page, calls } = await setup(t, async () => invalid, { scope: "all-reports" });
            await page.locator("#open").click();
            await page.locator(".deletion-dialog").getByRole("alert").waitFor();
            assert.equal(await page.locator(".delete-object-confirm").isVisible(), false);
            assert.equal(calls.some(call => call.path.endsWith("/confirm")), false);
        });
    }
    const { page, calls } = await setup(t, async path => path.endsWith("/preview") ? pending : { cancelled: true }, { scope: "all-reports" });
    await page.locator("#open").click();
    await page.locator(".delete-object-confirm:not([disabled])").waitFor();
    await page.evaluate(() => window.flow.invalidate());
    assert.match(await page.locator(".deletion-dialog").innerText(), /Saved objects changed.*fresh deletion preview/);
    assert.equal(await page.locator(".delete-object-confirm").isVisible(), false);
    assert.equal(calls.some(call => call.path.endsWith("/confirm")), false);
});
