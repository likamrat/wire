import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createReaderSections } from "../web/reader-sections.mjs";
import { createDisclosureState } from "../web/disclosure-state.mjs";

test("reader section defaults, remembered state and exact reveal share one visibility owner", async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.setContent('<main id="reader"></main>');
    await page.addScriptTag({ content: createReaderSections.toString() + "\n" + createDisclosureState.toString() });
    const states = await page.evaluate(() => {
        const root = document.getElementById("reader"), presentation = createDisclosureState();
        const make = () => createReaderSections({
            root, presentation, isCurrent: () => true,
            ux: { icon: () => document.createElement("span") },
        });
        const sections = make();
        const prompt = sections.add("prompt", "Prompt", { key: "prompt", collapsible: false });
        const source = sections.add("source", "Source", { key: "source", initialOpen: false });
        const response = sections.add("response", "Response", { key: "response" });
        root.append(prompt.element, source.element, response.element);
        const initial = sections.snapshot(), changes = [];
        source.visibility.subscribe(open => changes.push(open));
        const target = document.createElement("p");
        target.textContent = "Synthetic source identity";
        source.body.append(target);
        sections.reveal(target);
        const revealed = { summary: sections.snapshot(), hidden: source.body.parentElement.hidden,
            expanded: source.toggle.getAttribute("aria-expanded") };
        sections.setAll(false);
        const closed = { summary: sections.snapshot(), promptOpen: prompt.isOpen() };
        sections.dispose();
        root.replaceChildren();
        const next = make();
        const rememberedSource = next.add("source", "Source", { key: "source" });
        const rememberedResponse = next.add("response", "Response", { key: "response" });
        root.append(rememberedSource.element, rememberedResponse.element);
        const remembered = next.snapshot();
        next.dispose();
        return { initial, revealed, closed, remembered, changes };
    });
    assert.deepEqual(states, {
        initial: { total: 2, open: 1, canExpand: true, canCollapse: true },
        revealed: { summary: { total: 2, open: 2, canExpand: false, canCollapse: true }, hidden: false, expanded: "true" },
        closed: { summary: { total: 2, open: 0, canExpand: true, canCollapse: false }, promptOpen: true },
        remembered: { total: 2, open: 0, canExpand: true, canCollapse: false },
        changes: [true, false],
    });
});
