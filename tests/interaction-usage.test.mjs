import test from "node:test";
import assert from "node:assert/strict";
import { recordedUsage, usageSummary, usageQuestionGroups } from "../lib/interaction-usage.mjs";
import { retainUsageReceipt } from "../lib/usage-receipts.mjs";

test("an initiator label does not override a delegated or nested model call", () => {
    const usage = {apiCallId:"root-call",model:"gpt-4.1",initiator:"agent",inputTokens:100,outputTokens:5};
    const receipt = (extra = {}, envelope = {}) => retainUsageReceipt({type:"session.usage_record",data:{usage:{...usage,...extra}},...envelope});
    for (const initiator of ["sub-agent","mcp-sampling","unknown"]) assert.equal(receipt({initiator}).data.tokens,null);
    for (const extra of [{interactionType:"conversation-subagent"}, {interactionType:"conversation-compaction"},
        {interactionType:"conversation-background"}, {parentToolCallId:"parent"}, {fusion:{}}]) assert.equal(receipt(extra).data.tokens,null);
    assert.equal(receipt({}, {agentId:"nested"}).data.tokens,null);
});

test("model cohorts split multiple calls by recorded model and preserve measured zero", () => {
    const sample = (model, n) => ({model,tokens:{freshInput:n,cacheRead:0,cacheWrite:0,output:0}});
    const member = usage => ({usage,actor:"user",calls:new Map()});
    const mixed = member(recordedUsage([sample("gpt-4.1",12),sample("new-private-model",3)])), zero = member(recordedUsage([sample("gpt-4.1",0)]));
    const {groups,selected} = usageQuestionGroups([mixed,zero,member(null)],"model");
    assert.equal(selected.length,3);
    assert.deepEqual(groups.map(({label,summary:s})=>[label,s.total,s.metered]),[
        ["gpt-4.1",12,2],["new-private-model",3,1],
    ]);
    assert.equal(usageSummary([zero.usage]).total,0);
    assert.equal(usageSummary([null]).total,null);
});
