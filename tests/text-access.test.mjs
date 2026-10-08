import test from "node:test";
import assert from "node:assert/strict";
import { createTextAccess } from "../web/text-access.mjs";

test("compact previews respect complete Unicode graphemes and never rewrite source values", () => {
    const access = createTextAccess();
    const source = { status: "full", text: " \n" + "a".repeat(169) + "\ud83d\udc69\u200d\ud83d\ude80" + "suffix" };
    const before = structuredClone(source);
    assert.equal(access.excerpt(source), "a".repeat(169) + "\ud83d\udc69\u200d\ud83d\ude80...");
    assert.deepEqual(source, before);
    assert.equal(access.excerpt({ status: "full", text: "Short request" }), "Short request");
    assert.equal(access.excerpt({ status: "unavailable", text: "hidden" }), "Prompt not available");
    assert.equal(access.excerpt({ status: "full", text: "\n " }), "Prompt not available");
});

test("compact excerpts end before a partial word without splitting long URLs or Unicode graphemes", () => {
    const access = createTextAccess();
    assert.equal(access.excerpt({ text: "A recorded message about implementation" }, 30), "A recorded message about...");
    assert.equal(access.excerpt({ text: "Short message next" }, 13), "Short message...");
    const url = "https://example.invalid/" + "a".repeat(200);
    assert.equal(access.excerpt({ text: url }), url.slice(0, 170) + "...");
    const unicode = "\u65e5\ud83d\ude80e\u0301".repeat(70);
    assert.equal([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(access.excerpt({ text: unicode }).slice(0, -3))].length, 170);
});
