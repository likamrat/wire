import test from "node:test";
import assert from "node:assert/strict";
import { createTrendPairModel } from "./trends-pair.mjs";

test("tool reach shares the error rate denominator, not the call share denominator", () => {
    const m = createTrendPairModel(), source = { definitions: { problems: [{ id: "problems", label: "Errors" }],
        tools: [{ id: "fetch", label: "fetch" }], timing: [{ id: "timing", label: "Duration" }] } };
    const choices = m.choices(source), find = (f, mode) => choices.find(c => c.family === f && c.mode === mode);
    const errors = find("problems", "share"), reach = find("tools", "reach"), share = find("tools", "share");
    assert.equal(m.compatible(errors, reach), true);
    assert.equal(m.compatible(errors, share), false);
    const rowIds = ["first", "second"], day = { calls: 3, interactions: 2, timedCalls: 0, values: {
        tools: [{ id: "fetch", count: 2, percent: 200 / 3, eligible: 3, reach: 50, interactions: 1, reachEligible: 2, rowIds }],
        timing: [{ id: "timing", medianMs: null, p95Ms: null, rowIds: [] }] } };
    assert.deepEqual(m.point(day, reach), { amount: 50, numerator: 1, denominator: 2, rowIds });
    assert.equal(m.point(day, share).amount, 200 / 3);
    assert.equal(m.point(day, find("timing", "p95")).amount, null);
});

test("daily correlation skips missing pairs but includes measured zeros; constant readings have no coefficient", () => {
    const m = createTrendPairModel(), a = {family:"rhythm",id:"rhythm",mode:"count"}, b = {family:"timing",id:"timing",mode:"median"};
    const days = [[0,0],[2,20],[1,10],[6,null]].map(([count,medianMs])=>({values:{
        rhythm:[{id:"rhythm",count}], timing:[{id:"timing",medianMs}],
    }}));
    assert.deepEqual(m.correlation(days,a,b),{days:3,r:1});
    assert.deepEqual(m.correlation(days.slice(0,2),a,b),{days:2,r:null});
    for(const day of days) day.values.rhythm[0].count=0;
    assert.deepEqual(m.correlation(days,a,b),{days:3,r:null});
});
