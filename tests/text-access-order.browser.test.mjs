import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { createTextAccess } from "../web/text-access.mjs";

test("content-first complete readers opt in without changing default or list DOM", async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent("<main></main>");
    await page.addScriptTag({ content: `window.createTextAccess = (${createTextAccess.toString()});` });
    const shape = await page.evaluate(() => {
        const open = new Map();
        window.copies = [];
        const ux = { copyButton: ({ label, getText }) => {
            const node = document.createElement("button");
            node.className = "ux-copy";
            node.textContent = label;
            node.addEventListener("click", () => window.copies.push(getText()));
            return node;
        } };
        const access = window.createTextAccess(ux, {
            isOpen: (key, initial) => open.has(key) ? open.get(key) : initial,
            setOpen: (key, value) => open.set(key, value),
        }, { label: () => "Your prompt", read: () => ({ actor: "user", basis: "source-user" }), reason: () => "Recorded user source." });
        const source = { status: "full", text: "Keep the original text.\n  Including these spaces.  " };
        const ordinary = access.render(source, { key: "default", mode: "complete", initialOpen: true });
        const explicitDefault = access.render(source, { key: "default", mode: "complete", initialOpen: true, contentFirst: false });
        const content = access.render(source, { key: "story", mode: "complete", initialOpen: true, contentFirst: true });
        const preview = access.render(source, { key: "list" });
        const unchangedPreview = access.render(source, { key: "list", contentFirst: true });
        const explicitPreview = access.render(source, { key: "list", inlinePreview: false });
        const completeWithInline = access.render(source, { key: "default", mode: "complete", initialOpen: true, inlinePreview: true });
        ordinary.id = "ordinary";
        content.id = "story";
        document.querySelector("main").append(ordinary, content);
        return {
            defaultSame: ordinary.innerHTML === explicitDefault.innerHTML,
            previewSame: preview.outerHTML === unchangedPreview.outerHTML,
            inlineOptInOnly: preview.outerHTML === explicitPreview.outerHTML && ordinary.innerHTML === completeWithInline.innerHTML,
            defaultControlsInHeader: ordinary.querySelector(".full-text-reader-actions").parentElement.className,
            defaultOrder: [...ordinary.children].map(node => node.className),
            contentOrder: [...content.children].map(node => node.className),
        };
    });
    assert.equal(shape.defaultSame, true);
    assert.equal(shape.previewSame, true);
    assert.equal(shape.inlineOptInOnly, true);
    assert.equal(shape.defaultControlsInHeader, "full-text-header");
    assert.deepEqual(shape.defaultOrder, ["full-text-header", "full-text-unavailable", "full-text-body", "reader-details"]);
    assert.deepEqual(shape.contentOrder, ["full-text-header", "full-text-unavailable", "full-text-body", "full-text-reader-actions"]);
    const story = page.locator("#story");
    await story.locator("pre").focus();
    await page.keyboard.press("Tab");
    await expect(story.getByRole("button", { name: "Hide prompt", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(story.getByRole("button", { name: "Copy prompt", exact: true })).toBeFocused();
    await page.keyboard.press("Space");
    assert.deepEqual(await page.evaluate(() => window.copies), ["Keep the original text.\n  Including these spaces.  "]);
    await story.getByRole("button", { name: "Hide prompt", exact: true }).click();
    await expect(story.locator("pre,.ux-copy,.reader-copy-scope")).toHaveCount(0);
    await expect(story.getByRole("button", { name: "Read prompt", exact: true })).toBeFocused();
    await story.getByRole("button", { name: "Read prompt", exact: true }).press("Enter");
    await expect(story.locator("pre")).toHaveText("Keep the original text.\n  Including these spaces.  ");
    await expect(story.locator(".ux-copy,.reader-copy-scope")).toHaveCount(2);
});
