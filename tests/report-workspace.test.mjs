import test from "node:test";
import assert from "node:assert/strict";
import * as experience from "../web/report-experience.mjs";

test("one Reports landing joins choices and saved reports without replacing reading or comparison", () => {
    const view = experience.reportWorkspacePresentation;
    for (const task of [undefined, "create"]) {
        assert.deepEqual(view({ task }, { step: 1 }), {
            landing: true, prepared: false, saved: false, comparing: false,
        });

    }
    assert.deepEqual(view({ task: "create" }, { step: 3 }), {
        landing: false, prepared: true, saved: false, comparing: false,
    });
    assert.deepEqual(view({ bundle: "saved-file", task: "create" }, { step: 3 }), {
        landing: false, prepared: false, saved: true, comparing: false,
    });
    assert.deepEqual(view({ task: "compare" }, { step: 3 }), {
        landing: false, prepared: false, saved: false, comparing: true,
    });
    assert.equal(view({}, { step: 3 }).landing, true, "The Reports navigation target is always the combined landing.");
});

test("returning to Reports cannot hide an unresolved original Save behind the landing", () => {
    assert.deepEqual(experience.reportWorkspacePresentation({}, { step: 3, saveUnconfirmed: true }), {
        landing: false, prepared: true, saved: false, comparing: false,
    });
});
