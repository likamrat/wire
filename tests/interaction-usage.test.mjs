import test from "node:test";
import assert from "node:assert/strict";
import { priceUsage, usageSummary, pricingSnapshot, formatUsd, usageQuestionGroups } from "../lib/interaction-usage.mjs";
import { retainUsageReceipt } from "../lib/usage-receipts.mjs";

test("an initiator label does not override a delegated or nested model call", () => {
    const usage = {apiCallId:"root-call",model:"gpt-4.1",initiator:"agent",inputTokens:100,outputTokens:5};
    const receipt = (extra = {}, envelope = {}) => retainUsageReceipt({type:"session.usage_record",data:{usage:{...usage,...extra}},...envelope});
    for (const initiator of ["sub-agent","mcp-sampling","unknown"]) assert.equal(receipt({initiator}).data.tokens,null);
    for (const extra of [{interactionType:"conversation-subagent"}, {interactionType:"conversation-compaction"},
        {interactionType:"conversation-background"}, {parentToolCallId:"parent"}, {fusion:{}}]) assert.equal(receipt(extra).data.tokens,null);
    assert.equal(receipt({}, {agentId:"nested"}).data.tokens,null);
});

test("cache buckets, exact aliases and the long-context boundary apply per request", () => {
    const haiku = { model: "claude-haiku-5.5", tokens: { freshInput: 10000, cacheRead: 89000, cacheWrite: 1000, output: 5000 } };
    const longer = { ...haiku, tokens: { ...haiku.tokens, freshInput: 10001 } };
    const u = priceUsage([haiku, longer]);
    assert.equal(u.steps[0].usd, (10000 * .1 + 89000 * .01 + 1000 * .125 + 5000 * .5) / 1e6);
    assert.ok(Math.abs(u.steps[1].usd - (u.steps[0].usd + .1 / 1e6) * 5) < 1e-12);
    assert.equal(formatUsd(u.steps[0].usd), "<$0.01");
    const mixed = priceUsage([haiku, { ...haiku, model: "claude-haiku-5.5-preview" }]);
    assert.equal(mixed.usd, null);
    const all = usageSummary([u, mixed, null]);
    assert.deepEqual([all.metered, all.eligible, all.priced, all.unpriced], [2, 3, 1, 1]);
    assert.equal(all.usd, u.usd); assert.equal(all.models[0].usd, u.usd);
    const changed = structuredClone(pricingSnapshot);
    changed.models["claude-haiku-5-5"].output *= 2;
    assert.notEqual(priceUsage([haiku], changed).usd, u.steps[0].usd);
    assert.equal(usageSummary([null]).total, null); assert.equal(usageSummary([mixed]).usd, null);
});

test("model cohorts split a mixed receipt, preserve measured zero and exclude partially priced parents", () => {
    const sample = (model, n) => ({model,tokens:{freshInput:n,cacheRead:0,cacheWrite:0,output:0}});
    const member = usage => ({usage,actor:"user",calls:new Map()});
    const mixed = member(priceUsage([sample("gpt-4.1",12),sample("new-private-model",3)])), zero = member(priceUsage([sample("gpt-4.1",0)]));
    const {groups,selected} = usageQuestionGroups([mixed,zero,member(null)],"model");
    assert.equal(selected.length,3);
    assert.deepEqual(groups.map(({label,summary:s})=>[label,s.total,s.metered,s.priced,s.usd]),[
        ["gpt-4.1",12,2,1,0],["new-private-model",3,1,0,null],
    ]);
    assert.equal(usageSummary([zero.usage]).total,0); assert.equal(formatUsd(zero.usage.usd),"~$0.00");
});
