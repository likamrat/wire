import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { createTextAccess } from "../web/text-access.mjs";

test("complete reader actions stay beside their subject without changing default or list DOM", async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent("<main></main>");
    await page.addScriptTag({ content: `window.createTextAccess = (${createTextAccess.toString()});` });
    const shape = await page.evaluate(() => {
        const open = new Map();
        window.copies = [];
        const ux = { utility: (node, _icon, label) => { node.textContent = label; }, copyButton: ({ label, getText }) => {
            const node = document.createElement("button");
            node.className = "ux-copy";
            node.textContent = label;
            node.addEventListener("click", () => window.copies.push(getText()));
            return node;
        } };
        const access = window.createTextAccess(ux, {
            isOpen: (key, initial) => open.has(key) ? open.get(key) : initial,
            setOpen: (key, value) => open.set(key, value),
        }, { label: () => "My prompt", read: () => ({ actor: "user", basis: "source-user" }), reason: () => "Recorded user source." });
        const source = { status: "full", text: "Keep the original text.\n  Including these spaces.  " };
        const ordinary = access.render(source, { key: "default", mode: "complete", initialOpen: true });
        const explicitDefault = access.render(source, { key: "default", mode: "complete", initialOpen: true, contentFirst: false, allowCopy: true });
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
            contentControlsInHeader: content.querySelector(".full-text-reader-actions").parentElement.className,
        };
    });

    assert.equal(shape.defaultSame, true);
    assert.equal(shape.previewSame, true);
    assert.equal(shape.inlineOptInOnly, true);
    assert.equal(shape.defaultControlsInHeader, "full-text-header");
    assert.deepEqual(shape.defaultOrder, ["full-text-header", "full-text-unavailable", "full-text-body", "reader-details"]);
    assert.deepEqual(shape.contentOrder, ["full-text-header", "full-text-unavailable", "full-text-body"]);
    assert.equal(shape.contentControlsInHeader, "full-text-header");
    const story = page.locator("#story");
    await story.getByRole("button", { name: "Hide prompt", exact: true }).focus();
    await expect(story.getByRole("button", { name: "Hide prompt", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(story.getByRole("button", { name: "Copy prompt", exact: true })).toBeFocused();
    await page.keyboard.press("Space");
    assert.deepEqual(await page.evaluate(() => window.copies), ["Keep the original text.\n  Including these spaces.  "]);
    await page.keyboard.press("Tab");
    await expect(story.locator("pre")).toBeFocused();
    await story.getByRole("button", { name: "Hide prompt", exact: true }).click();
    await expect(story.locator("pre,.ux-copy,.reader-copy-scope")).toHaveCount(0);
    await expect(story.getByRole("button", { name: "Read prompt", exact: true })).toBeFocused();
    await story.getByRole("button", { name: "Read prompt", exact: true }).press("Enter");
    await expect(story.locator("pre")).toHaveText("Keep the original text.\n  Including these spaces.  ");
    await expect(story.locator(".ux-copy,.reader-copy-scope")).toHaveCount(2);
});

test("read-only text opt-out preserves exact reading, notices and owner cleanup without copy machinery", async t => {
    const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent("<main></main><aside></aside>");
    await page.addScriptTag({ content: `window.createTextAccess = (${createTextAccess.toString()});` });
    const result = await page.evaluate(() => {
        const states = new Map(), source = { status: "partial", text: "  Exact retained text.\n" + "More source text. ".repeat(30) };
        let released = false;
        const access = window.createTextAccess({
            utility: (node, _icon, label) => { node.textContent = label; },
            copyButton: () => { throw Error("No copy action requested"); },
            codeBlock: () => { throw Error("A generic code block would recreate copy machinery"); },
        }, {
            isOpen: (key, fallback) => states.has(key) ? states.get(key) : fallback,
            setOpen: (key, value) => states.set(key, value),
        });
        const preview = access.render(source, { key: "read-only", allowCopy: false, notice: "Caller source boundary." });
        document.querySelector("main").append(preview);
        preview.querySelector(".full-text-toggle").click();
        const text = preview.querySelector("pre");
        text.focus();
        const owned = access.render(source, { key: "owned", subject: "response", mode: "complete", contentFirst: true,
            allowCopy: false, actionsHost: document.querySelector("aside"), notice: "Keep this caller notice.",
            visibility: { isOpen: () => true, subscribe: () => () => { released = true; } } });
        const missing = access.render({ status: "unavailable" }, { key: "missing", subject: "response", mode: "complete",
            contentFirst: true, allowCopy: false });
        const local = access.render(source, { key: "local", mode: "complete", initialOpen: true, allowCopy: false });
        document.querySelector("main").append(owned, missing, local);
        access.release(local);
        const result = { text: text.textContent, expected: source.text, focused: document.activeElement === text,
            notice: preview.textContent.includes("Caller source boundary."),
            partial: preview.textContent.includes("Only part of the original was recorded"),
            ownedNotice: owned.textContent.includes("Keep this caller notice."),
            emptyActions: document.querySelectorAll(".full-text-reader-actions:empty,.full-text-actions:empty").length,
            copyText: /copy|local only|clipboard/i.test(preview.textContent),
            hostChildren: document.querySelector("aside").childElementCount };
        access.release(owned);
        result.released = released && !owned.querySelector(".full-text-body");
        preview.querySelector(".full-text-toggle").click();
        result.collapsed = !preview.querySelector(".full-text-body");
        return result;
    });
    assert.equal(result.text, result.expected); assert.equal(result.focused, true);
    assert.equal(result.notice, true); assert.equal(result.partial, true); assert.equal(result.ownedNotice, true);
    assert.equal(result.emptyActions, 0); assert.equal(result.hostChildren, 0); assert.equal(result.copyText, false);
    assert.equal(result.released, true); assert.equal(result.collapsed, true);
});
