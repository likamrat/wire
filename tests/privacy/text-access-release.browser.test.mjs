import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createTextAccess } from "../../web/text-access.mjs";
import { createDisclosureState } from "../../web/disclosure-state.mjs";
import { createEvidenceUX } from "../../web/ux.mjs";
import { uxIcons } from "../../web/ux-icons.mjs";
import { createMessageMarkdown } from "../../web/message-markdown.mjs";

async function setup(t) {
    const browser = await chromium.launch(), page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); });
    await page.setContent('<main><button id="outside">Other control</button><div id="home"></div><aside id="actions"></aside></main>');
    await page.addScriptTag({ content: `
        window.makeTextAccess = ${createTextAccess.toString()};
        window.makeDisclosure = ${createDisclosureState.toString()};
        window.makeUX = ${createEvidenceUX.toString()};
        window.makeMessageText = ${createMessageMarkdown.toString()};
    ` });
    await page.evaluate(icons => {
        window.copies = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw Error("Real clipboard reads are forbidden."); },
            writeText: async text => { window.copies.push(text); },
        } });
        window.ux = window.makeUX(icons);
        window.access = window.makeTextAccess(window.ux, window.makeDisclosure());
    }, uxIcons);
    return page;
}

test("full card text wraps at the available width without rewriting its source, then retires synchronously", async t => {
    const page = await setup(t);
    await page.addStyleTag({ content: ".request-card-prompt{font:16px/24px sans-serif;white-space:pre-wrap;margin:0}#home{width:900px}" });
    const source = "Review the workshop reference notes, confirm the recorded room layout, and keep the preparation order. ".repeat(2);
    await page.evaluate(text => {
        const source = { status: "full", text };
        window.preview = window.access.renderCardPreview(source);
        document.querySelector("#home").append(window.preview);
    }, source);
    const height = () => page.evaluate(() => window.preview.clientHeight);
    const wide = await height();
    assert.equal(await page.locator(".request-card-prompt").textContent(), source);
    await page.locator("#home").evaluate(node => node.style.width = "240px");
    assert.ok(await height() > wide);
    await page.locator("#home").evaluate(node => node.style.width = "900px");
    assert.equal(await height(), wide);
    const released = await page.evaluate(() => {
        const nodes = [...window.preview.childNodes];
        window.access.release(window.preview);
        document.fonts.dispatchEvent(new Event("loadingdone"));
        window.preview.style.width = "100px";
        return { text: window.preview.textContent, heldText: nodes.map(node => node.textContent).join("") };
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(released.text, "");
    assert.equal(released.heldText, "");
    assert.equal(await page.evaluate(() => window.preview.textContent), "");
});

for (const mode of ["complete", "preview", "short-preview"]) test(`release synchronously erases ${mode} and retained old toggle bodies`, async t => {
    const page = await setup(t);
    const result = await page.evaluate(mode => {
        const source = { status: "full", text: mode === "short-preview" ? "PRIVATE_SHORT_TEXT Owner13579bdf-2468-4ace-9bdf-0123456789ab"
            : "PRIVATE_RETAINED_TEXT\n" + "Exact source text. ".repeat(40) };
        const root = window.access.render(source, { key: "PRIVATE_RECORD_ID-" + mode, mode: mode === "complete" ? "complete" : "preview",
            initialOpen: true });
        root.id = "safe-reader-root";
        const safeClass = root.className;
        const home = document.getElementById("home");
        home.append(root);
        const toggle = root.querySelector(".full-text-toggle"), pre = root.querySelector("pre");
        const copy = root.querySelector(".ux-copy"), preview = root.querySelector(".full-text-preview");
        const identifier = root.querySelector(".text-preview-identifier");
        const privateAttributes = [root, ...root.querySelectorAll("*")].flatMap(node =>
            [...node.attributes].filter(attribute => attribute.value.includes("PRIVATE_RECORD_ID")));
        const removedLabels = [...root.querySelectorAll("[aria-label]")].map(node => node.getAttributeNode("aria-label"));
        const generatedKey = root.getAttributeNode("data-view-key").value;
        const before = root.textContent;
        document.getElementById("outside").focus();
        window.access.release(root);
        window.access.release(root);
        const cleared = root.textContent;
        root.remove();
        home.append(root);
        if (pre) home.append(pre);
        if (copy) home.append(copy);
        if (toggle) {
            home.append(toggle);
            toggle.click();
            toggle.click();
        }
        copy?.click();
        return { before, cleared, text: home.textContent, retainedPre: pre?.textContent ?? "",
            generatedKey, attributes: privateAttributes.map(attribute => attribute.value),
            labels: removedLabels.map(attribute => attribute.value), safeRoot: root.id === "safe-reader-root" && root.className === safeClass,
            retainedPreview: preview?.textContent ?? "", copies: window.copies,
            retainedIdentifier: identifier?.textContent ?? "",
            focus: document.activeElement.id, originalIntact: source.text.startsWith("PRIVATE_") };
    }, mode);
    assert.match(result.before, /PRIVATE_/);
    assert.equal(result.cleared, "");
    assert.equal(result.generatedKey, "text:PRIVATE_RECORD_ID-" + mode);
    assert.ok(result.attributes.length > 0);
    assert.deepEqual(result.attributes, result.attributes.map(() => ""));
    assert.deepEqual(result.labels, result.labels.map(() => ""));
    assert.equal(result.safeRoot, true);
    assert.doesNotMatch(result.text, /PRIVATE_|Exact source text/);
    assert.equal(result.retainedPre, "");
    assert.equal(result.retainedPreview, "");
    assert.equal(result.retainedIdentifier, "");
    assert.deepEqual(result.copies, []);
    assert.equal(result.focus, "outside");
    assert.equal(result.originalIntact, true);
});

test("a retained visibility callback cannot paint after release, even when reattached", async t => {
    const page = await setup(t);
    const result = await page.evaluate(() => {
        let callback, unsubscribed = 0;
        const root = window.access.render({ status: "full", text: "PRIVATE_LATE_RESPONSE" }, {
            key: "late-response", subject: "response", mode: "complete", initialOpen: true, contentFirst: true,
            actionsHost: document.getElementById("actions"),
            visibility: { isOpen: () => true, isCurrent: () => true,
                subscribe(listener) { callback = listener; return () => { unsubscribed++; }; } },
        });
        document.getElementById("home").append(root);
        window.access.release(root);
        document.getElementById("outside").focus();
        callback(true);
        return { text: root.textContent, actions: document.getElementById("actions").textContent,
            focus: document.activeElement.id, unsubscribed };
    });
    assert.deepEqual(result, { text: "", actions: "", focus: "outside", unsubscribed: 1 });
});

test("authorized reveal and exact Copy work, but released getters and late Copy completion cannot revive text or focus", async t => {
    const page = await setup(t);
    const result = await page.evaluate(async () => {
        const original = "PRIVATE_AUTHORIZED_TEXT\n  Exact spacing \u65e5\u672c\u8a9e  ";
        const makeCopy = window.ux.copyButton;
        let getter, finishCopy;
        window.ux.copyButton = options => { getter = options.getText; return makeCopy(options); };
        const root = window.access.render({ status: "full", text: original }, { key: "authorized", mode: "complete", initialOpen: false });
        document.getElementById("home").append(root);
        root.querySelector(".full-text-toggle").click();
        const pre = root.querySelector("pre"), exact = pre.textContent;
        root.querySelector(".ux-copy").click();
        await Promise.resolve();
        root.querySelector(".full-text-toggle").click();
        root.querySelector(".full-text-toggle").click();
        const livePre = root.querySelector("pre"), copy = root.querySelector(".ux-copy"), retainedGetter = getter;
        const held = new Promise(resolve => { finishCopy = resolve; });
        navigator.clipboard.writeText = text => { window.copies.push(text); return held; };
        copy.click();
        document.getElementById("outside").focus();
        window.access.release(root);
        document.getElementById("home").append(livePre);
        const releasedValue = retainedGetter();
        finishCopy();
        await held; await Promise.resolve();
        return { exact, original, copies: window.copies, releasedValue, retainedText: livePre.textContent, previousText: pre.textContent,
            text: root.textContent, focus: document.activeElement.id };
    });
    assert.equal(result.exact, result.original);
    assert.deepEqual(result.copies, [result.original, result.original], "Already-dispatched synthetic copies are not retroactively undone.");
    assert.equal(result.releasedValue, null);
    assert.equal(result.retainedText, "");
    assert.equal(result.previousText, "");
    assert.equal(result.text, "");
    assert.equal(result.focus, "outside");
});

test("detached toggles cannot change reading state and a failed release remains explicitly retryable", async t => {
    const page = await setup(t);
    const result = await page.evaluate(() => {
        let throwOnce = true, callback;
        const root = window.access.render({ status: "full", text: "PRIVATE_DETACHED_TEXT" }, {
            key: "detached", mode: "complete", initialOpen: false,
        });
        document.getElementById("home").append(root);
        const toggle = root.querySelector(".full-text-toggle");
        root.remove(); toggle.click();
        const detachedOpened = window.access.isOpen("detached", false);
        document.getElementById("home").append(root); toggle.click();
        const authorizedText = root.querySelector("pre").textContent;
        const owned = window.access.render({ status: "full", text: "PRIVATE_RELEASE_RETRY" }, {
            key: "retry", mode: "complete", visibility: { isOpen: () => true, isCurrent: () => true,
                subscribe(fn) { callback = fn; return () => { if (throwOnce) { throwOnce = false; throw Error("Expected cleanup failure"); } }; } },
        });
        document.getElementById("home").append(owned);
        let error;
        try { window.access.release(owned); } catch (failure) { error = failure.message; }
        callback(true);
        window.access.release(owned);
        return { detachedOpened, authorizedText, error, retryText: owned.textContent };
    });
    assert.deepEqual(result, { detachedOpened: false, authorizedText: "PRIVATE_DETACHED_TEXT",
        error: "Expected cleanup failure", retryText: "" });
});

test("formatted message text, links and a delayed parser cannot outlive release or withdrawal", async t => {
    const page = await setup(t);
    await page.addScriptTag({ path: new URL("../../node_modules/marked/lib/marked.umd.js", import.meta.url).pathname.replace(/^\/(\w:)/u, "$1") });
    const result = await page.evaluate(async () => {
        const markdown = "PRIVATE **reply** with [PRIVATE link](https://example.invalid/PRIVATE_PATH)";
        const home = document.getElementById("home"), copies = [];
        // Parser already loaded: a released reader leaves no text or URL in retained nodes and Attrs.
        const loaded = window.makeMessageText({ marked: window.marked });
        const access = window.makeTextAccess(window.ux, window.makeDisclosure(), undefined, undefined, loaded);
        const root = access.render({ status: "full", text: markdown }, { key: "formatted", mode: "complete", subject: "response", initialOpen: true });
        home.append(root);
        const anchor = root.querySelector("a[href]"), href = anchor.getAttributeNode("href"), body = root.querySelector(".message-markdown");
        const formatted = body.dataset.messageFormat;
        access.release(root);
        home.append(anchor, body);
        copies.push(anchor.getAttribute("href"), href.value, anchor.textContent, body.textContent, home.textContent);
        // Parser still loading: released, cleared and withdrawn targets are never formatted or refilled afterwards.
        let resolve;
        const delayed = window.makeMessageText(() => new Promise(done => resolve = done));
        const lateAccess = window.makeTextAccess(window.ux, window.makeDisclosure(), undefined, undefined, delayed);
        const released = lateAccess.render({ status: "full", text: markdown }, { key: "released", mode: "complete", subject: "response", initialOpen: true });
        const withdrawn = lateAccess.render({ status: "full", text: markdown + " again" }, { key: "withdrawn", mode: "complete", subject: "response", initialOpen: true });
        home.append(released, withdrawn);
        const heldReleased = released.querySelector(".message-markdown"), heldWithdrawn = withdrawn.querySelector(".message-markdown");
        const pendingBefore = [heldReleased.dataset.messageFormat, heldWithdrawn.dataset.messageFormat];
        lateAccess.release(released);
        home.append(heldReleased);
        delayed.clear();
        const plain = document.createElement("p");
        plain.textContent = "Ordinary words only";
        delayed.preview(plain, plain.textContent);
        await new Promise(done => setTimeout(done));
        resolve({ marked: window.marked });
        await new Promise(done => setTimeout(done, 20));
        return { formatted, copies, pendingBefore,
            released: [heldReleased.textContent, heldReleased.dataset.messageFormat, heldReleased.isConnected],
            withdrawn: [heldWithdrawn.isConnected, heldWithdrawn.dataset.messageFormat, withdrawn.querySelectorAll("a,strong").length],
            plain: plain.textContent };
    });
    assert.equal(result.formatted, "markdown");
    assert.deepEqual(result.copies, [null, "", "", "", ""]);
    assert.deepEqual(result.pendingBefore, ["pending", "pending"]);
    assert.deepEqual(result.released, ["", "pending", true], "A released target is not formatted when the parser arrives");
    assert.deepEqual(result.withdrawn, [true, "pending", 0], "Withdrawal drops deferred targets even while loading");
    assert.equal(result.plain, "Ordinary words only");
});
