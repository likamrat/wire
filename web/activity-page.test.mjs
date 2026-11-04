import test from "node:test";
import assert from "node:assert/strict";
import { activityPage } from "./activity-page.mjs";

test("one roster pages both complete populations without invented chronology or a 1-0 range", () => {
    assert.equal(activityPage({ github: 0 }).first, 0);
    assert.deepEqual(activityPage({ github: 73, native: 2 }), {
        index: 0, pages: 10, total: 75, first: 1, last: 10, githubOffset: 0, githubLimit: 8, nativePage: 0,
    });

    assert.deepEqual(activityPage({ index: 1, github: 73, native: 2 }), {
        index: 1, pages: 10, total: 75, first: 11, last: 18, githubOffset: 8, githubLimit: 8, nativePage: null,
    });
    const seen = new Set();
    for (let index = 0; index < 4; index++) {
        const page = activityPage({ index, github: 9, native: 31 });
        for (let item = page.first; item <= page.last; item++) assert.equal(seen.has(item), false), seen.add(item);
    }
    assert.equal(seen.size, 40);
});

test("byte-short native windows use accepted offsets and reject impossible page metadata", () => {
    const windows = [
        { index: 0, offset: 0, count: 1, hasNext: true },
        { index: 1, offset: 1, count: 1, hasNext: true },
        { index: 2, offset: 2, count: 2, hasNext: true },
        { index: 3, offset: 4, count: 1, hasNext: false },
    ];
    assert.deepEqual(windows.map(nativeWindow => {
        const page = activityPage({ index: nativeWindow.index, github: 17, native: 5, nativeWindow });
        return [page.first, page.last];
    }), [[1, 9], [10, 18], [19, 21], [22, 22]]);
    const afterNative = activityPage({ index: 3, github: 40, native: 2,
        nativeWindow: { index: 1, offset: 1, count: 1, hasNext: false } });
    assert.deepEqual([afterNative.nativePage, afterNative.first, afterNative.last], [null, 27, 34]);
    for (const nativeWindow of [
        { index: -1, offset: 0, count: 1, hasNext: true },
        { index: 0, offset: 0, count: 6, hasNext: false },
        { index: 0, offset: 0, count: 1, hasNext: false },
        { index: 1, offset: 1, count: 4, hasNext: true },
    ]) assert.throws(() => activityPage({ github: 17, native: 5, nativeWindow }), TypeError);
});
