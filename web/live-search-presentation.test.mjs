import test from "node:test";
import assert from "node:assert/strict";
import * as search from "./live-search.mjs";

test("literal body matches use the supplied original UTF-16 range without rematching or changing text", () => {
    const hit = { title: "Invented report", excerpt: "The PowerPoint outline is ready.", source: { label: "Saved report / release" },
        textMatch: { field: "content", start: 104, end: 109, excerptStart: 100 } };
    assert.deepEqual(search.searchHitPresentation(hit), {
        title: [{ text: "Invented report", match: false }],
        excerpt: [{ text: "The ", match: false }, { text: "Power", match: true }, { text: "Point outline is ready.", match: false }],
        source: [{ text: "Saved report / release", match: false }],
    });

});

test("match metadata fails closed on invalid fields, bounds, surrogate splits or inconsistent original text", () => {
    const original = "A \u{1f680} PowerPoint";
    const hit = { title: original, excerpt: original, source: { label: original },
        textMatch: { field: "title", start: 5, end: 10, excerptStart: 0 } };
    for (const change of [
        { field: "unknown" }, { start: -1 }, { start: 5.5 }, { end: 999 }, { end: 5 },
        { excerptStart: 6 }, { start: 3 }, { end: 3 }, { extra: true },
    ]) assert.throws(() => search.searchHitPresentation({ ...hit, textMatch: { ...hit.textMatch, ...change } }), /Search match/);
    assert.throws(() => search.searchHitPresentation({ ...hit, excerpt: "A different excerpt" }), /Search match/);
    const parts = search.searchHitPresentation(hit);
    assert.equal(parts.title.map(part => part.text).join(""), original);
    assert.equal(parts.title.find(part => part.match).text, "Power");
    assert.deepEqual(parts.excerpt, [], "A title match does not duplicate its excerpt");
});

test("title, body and source duplicates collapse without losing the provided visible match", () => {
    for (const field of ["title", "content", "source"]) {
        const hit = { title: "PowerPoint", excerpt: "PowerPoint", source: { label: "PowerPoint" },
            textMatch: { field, start: 0, end: 5, excerptStart: 0 } };
        const marked = [{ text: "Power", match: true }, { text: "Point", match: false }];
        assert.deepEqual(search.searchHitPresentation(hit), {
            title: field === "source" ? [] : marked, excerpt: [], source: field === "source" ? marked : [],
        });
    }
    const title = "<img src=x onerror=alert(1)>";
    const source = "Original \u{1f680} PowerPoint source";
    const start = source.indexOf("Power");
    const hit = { title, excerpt: source, source: { label: source },
        textMatch: { field: "source", start, end: start + 5, excerptStart: 0 } };
    const shown = search.searchHitPresentation(hit);
    assert.deepEqual(shown.title, [{ text: title, match: false }], "Markup-looking text stays unparsed");
    assert.equal(shown.source.map(part => part.text).join(""), source);
    assert.equal(shown.source.find(part => part.match).text, "Power");
    assert.deepEqual(shown.excerpt, []);
});

test("original Greek, ligature and astral text survive serialized presentation without browser folding", () => {
    const serialized = new Function("return (" + search.searchHitPresentation.toString() + ")")();
    for (const [title, start, end, expected] of [
        ["\u039f\u03a3", 1, 2, "\u03a3"],
        ["\u03bf\u03c2", 1, 2, "\u03c2"],
        ["o\ufb03ce", 1, 2, "\ufb03"],
        ["\u{1f680} PowerPoint", 3, 8, "Power"],
    ]) {
        const hit = { title, excerpt: title, source: { label: "Invented Unicode source" },
            textMatch: { field: "title", start, end, excerptStart: 0 } };
        const shown = serialized(hit);
        assert.equal(shown.title.map(part => part.text).join(""), title);
        assert.equal(shown.title.find(part => part.match).text, expected);
        assert.deepEqual(shown, search.searchHitPresentation(hit));
    }
});

test("navigation context stays human-readable without replacing an actually matched source", () => {
    const hit = { type: "view", title: "Recorded timing", excerpt: "Recorded timing",
        source: { label: "WIRE navigation" }, target: { kind: "route", href: "#analyze?mode=calls" },
        textMatch: { field: "title", start: 0, end: 3, excerptStart: 0 } };
    assert.deepEqual(search.searchHitPresentation(hit).source, [{ text: "Analyze", match: false }]);
    const sourceMatch = { ...hit, excerpt: hit.source.label, textMatch: { field: "source", start: 5, end: 15, excerptStart: 0 } };
    assert.deepEqual(search.searchHitPresentation(sourceMatch).source, [
        { text: "WIRE ", match: false }, { text: "navigation", match: true },
    ]);
});

test("formatted body previews stay match-centered without changing the original hit or supplied range", () => {
    const excerpt = "ected records: product-report.json.\n\nUser prompt\n  full source / retained-original\n\n"
        + "Prepare the PowerPoint handoff and the quarterly release notes.\n\nworkiq-fetch: recorded result.\n\nscenar";
    const from = excerpt.indexOf("Power");
    const hit = { title: "WIRE activity report", excerpt, source: { label: "Approved frozen report" },
        textMatch: { field: "content", start: 900 + from, end: 905 + from, excerptStart: 900 } };
    const before = structuredClone(hit), shown = search.searchHitPresentation(hit);
    assert.equal(shown.excerpt.map(part => part.text).join(""),
        "... Prepare the PowerPoint handoff and the quarterly release notes. ...");
    assert.equal(shown.excerpt.find(part => part.match).text, "Power");
    assert.deepEqual(hit, before);
    const serialized = new Function("return (" + search.searchHitPresentation.toString() + ")")();
    assert.deepEqual(serialized(hit), shown);
});

test("body context stays bounded and grapheme-safe but never truncates a supplied long match", () => {
    const cluster = "\u{1f469}\u200d\u{1f680}", match = "Original matched content ".repeat(20);
    const prefix = cluster.repeat(70), suffix = " e\u0301".repeat(70);
    const hit = { title: "Invented report", excerpt: prefix + match + suffix, source: { label: "Saved report" },
        textMatch: { field: "content", start: prefix.length, end: prefix.length + match.length, excerptStart: 0 } };
    const shown = search.searchHitPresentation(hit);
    assert.equal(shown.excerpt.find(part => part.match).text, match);
    const context = shown.excerpt.filter(part => !part.match).map(part => part.text).join("");
    assert.ok([...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(context)].length <= 100);
    assert.doesNotMatch(context.replaceAll(cluster, "").replaceAll("e\u0301", ""), /[\u200d\u0301]|\p{Extended_Pictographic}/u);
});

test("unmatched retained captions omit only full-value whitespace and terminal-punctuation recitals", () => {
    const title = "Who can review the dashboard layout for NOVA?";
    const start = title.indexOf("NOVA");
    const hit = { type: "interaction", title, excerpt: title,
        source: { kind: "retained-activity", label: "Who can review the dashboard layout for NOVA" },
        textMatch: { field: "title", start, end: start + 4, excerptStart: 0 } };
    const original = structuredClone(hit);
    const shown = search.searchHitPresentation(hit);
    assert.deepEqual(shown.source, []);
    assert.equal(shown.title.map(part => part.text).join(""), title);
    assert.equal(shown.title.find(part => part.match).text, "NOVA");
    assert.deepEqual(hit, original);
    assert.deepEqual(search.searchHitPresentation({ ...hit, source: { ...hit.source, label: " Who can review the\ndashboard layout for NOVA! " } }).source, []);
    for (const label of ["", " \n "]) {
        assert.deepEqual(search.searchHitPresentation({ ...hit, source: { ...hit.source, label } }).source, [], "No empty optional-source slot");
    }
    for (const label of [
        "Who can review the dashboard layout for NOVA after approval",
        "Who can review the dashboard layout for NOVA - not yet approved",
        "Who can review the dashboard layout for nova",
        "Who can review the dashboard layout for NOVA: draft",
    ]) assert.equal(search.searchHitPresentation({ ...hit, source: { ...hit.source, label } }).source.map(part => part.text).join(""), label);
    const saved = { ...hit, source: { ...hit.source, kind: "saved-report" } };
    assert.equal(search.searchHitPresentation(saved).source.map(part => part.text).join(""), hit.source.label);
});

test("matched sources remain source evidence even when an original title is identical or near-identical", () => {
    for (const title of ["NOVA", "NOVA?"]) {
        const hit = { type: "interaction", title, excerpt: "NOVA",
            source: { kind: "retained-activity", label: "NOVA" },
            textMatch: { field: "source", start: 0, end: 4, excerptStart: 0 } };
        const original = structuredClone(hit), shown = search.searchHitPresentation(hit);
        assert.deepEqual(shown.source, [{ text: "NOVA", match: true }]);
        assert.deepEqual(shown.title, title === "NOVA" ? [] : [{ text: title, match: false }]);
        assert.deepEqual(hit, original);
    }
});
