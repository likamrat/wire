import test from "node:test";
import assert from "node:assert/strict";
import { mountAnalyzeReferenceEntry } from "./analyze-reference-entry.mjs";

test("one movable reference entry invokes only its caller-owned action when available", () => {
    const trigger = new EventTarget();
    trigger.checkVisibility = () => true;
    const host = { hidden: true };
    let opens = 0;
    const entry = mountAnalyzeReferenceEntry({ host, trigger, openReference: () => { opens++; } });
    trigger.dispatchEvent(new Event("click"));
    assert.equal(opens, 0);
    entry.show(true);
    trigger.dispatchEvent(new Event("click"));
    assert.equal(opens, 1);
    entry.show(false);
    trigger.dispatchEvent(new Event("click"));
    assert.equal(opens, 1);
    entry.dispose();
    entry.show(true);
    trigger.dispatchEvent(new Event("click"));
    assert.equal(opens, 1);
});
