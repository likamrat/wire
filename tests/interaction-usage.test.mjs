import test from "node:test";
import assert from "node:assert/strict";
import { firstUsageDays, recordedUsage, usageSummary, usageQuestionGroups } from "../lib/interaction-usage.mjs";
import { createUsageReading } from "../web/usage-reading.mjs";
import { modelRequestKey, retainToolTokens, retainUsageReceipt, toolTokenReadings } from "../lib/usage-receipts.mjs";
import { retainInteractionModelMetadata } from "../lib/interaction-model.mjs";
import { qualifiedResultPaths } from "../lib/history.mjs";

test("Analyze attributes a multi-day interaction once but keeps its later calls inside View by day",()=>{
    const {usageCalendar} = createUsageReading({firstUsageDays});
    const list = [{scenarioId:"a",origin:"one",usage:{total:40}},{scenarioId:"b",origin:"one",usage:{total:40}},
        {scenarioId:"c",origin:"two",usage:{total:0}},{scenarioId:"d",origin:"three",usage:null}];
    const calendar=usageCalendar(list,[
        {scenarioId:"a",startedAt:"2026-10-17"},{scenarioId:"b",startedAt:"2026-10-14"},
        {scenarioId:"c",startedAt:"2026-10-15"},{scenarioId:"d",startedAt:"2026-10-15"},
        {scenarioId:"out-of-scope",startedAt:"2026-10-20"},
    ],s=>s.origin,v=>v);
    assert.deepEqual(calendar,{range:{from:"2026-10-14",to:"2026-10-17"},days:[
        {date:"2026-10-15",total:0,metered:1,eligible:2},{date:"2026-10-14",total:40,metered:1,eligible:1},
    ]});
});

test("a tool operation needs its own original completion and a consistent provider meter", () => {
    const start = {id:"s",type:"tool.execution_start",timestamp:"2026-10-01T00:00:00Z",data:{toolCallId:"c",toolName:"workiq-fetch"}};
    const usage = {model:"tool/model",requestId:"op",totalTokens:0,quotaSnapshots:{private:true}};
    const end = {id:"e",type:"tool.execution_complete",timestamp:"2026-10-01T00:00:01Z",data:{toolCallId:"c",success:false,toolUsage:usage}};
    assert.ok(qualifiedResultPaths([end],[start],new Set(),true).has(end),"a failed call need not return text to have a meter");
    for (const prior of [[],[start,start],[{...start,ephemeral:true}],[{...start,agentId:"other"}]])
        assert.equal(qualifiedResultPaths([end],prior,new Set(),true).size,0);
    const read = u => retainToolTokens({...end,data:{...end.data,toolUsage:u}},"src");
    const meter = read(usage);
    assert.deepEqual(meter,{operationRef:meter.operationRef,input:null,output:null,total:0});
    assert.match(meter.operationRef,/^[a-f0-9]{64}$/);
    for (const u of [{...usage,outputTokens:1},{...usage,totalTokens:3,inputTokens:1,outputTokens:1},
        {...usage,inputTokens:-1},{...usage,accounting:{sourceSessionId:"other",usageId:"u",sequence:1}},
        {model:"tool/model",requestId:"op"},{...usage,requestId:undefined}]) assert.equal(read(u),null);
    assert.equal(retainToolTokens({...end,checkpoint:true},"src"),null);
    assert.deepEqual(read({...usage,totalTokens:undefined,inputTokens:2,outputTokens:9}),
        {...meter,input:2,output:9,total:11});
});

test("reused tool-operation receipts cannot meter two separate invocations", () => {
    const receipt = {operationRef:"a".repeat(64),input:0,output:4,total:4};
    const call = {tool:"workiq-fetch",toolCallId:"call1",startEventId:"s1",completionEventId:"end1",toolTokenReceipt:receipt};
    const other = {...call,toolCallId:"retry",startEventId:"s2",completionEventId:"end2"};
    const record = calls => ({sourceHost:"copilot-app",sourceSessionId:"s",toolCalls:calls});
    assert.equal(toolTokenReadings([record([call,other])]).size,0);
    assert.equal(toolTokenReadings([record([call,{...call,toolTokenReceipt:{...receipt,total:3,output:3}}])]).size,0);
    const separate = {...other,toolTokenReceipt:{...receipt,operationRef:"b".repeat(64)}};
    assert.deepEqual(toolTokenReadings([record([call,separate])]).get(separate),{input:0,output:4,total:4});
});

test("an initiator label does not override a delegated or nested model call", () => {
    const usage = {apiCallId:"root-call",model:"gpt-4.1",initiator:"agent",inputTokens:100,outputTokens:5};
    const receipt = (extra = {}, envelope = {}) => retainUsageReceipt({type:"session.usage_record",data:{usage:{...usage,...extra}},...envelope});
    for (const initiator of ["sub-agent","mcp-sampling","unknown"]) assert.equal(receipt({initiator}).data.tokens,null);
    for (const extra of [{interactionType:"conversation-subagent"}, {interactionType:"conversation-compaction"},
        {interactionType:"conversation-background"}, {parentToolCallId:"parent"}, {fusion:{}}]) assert.equal(receipt(extra).data.tokens,null);
    assert.equal(receipt({}, {agentId:"nested"}).data.tokens,null);
});

test("opaque request keys match old assistant metadata without admitting raw digest lookalikes or credentials", () => {
    const raw = "ab/+".repeat(124) + "xy==", key = modelRequestKey({apiCallId:raw});
    const project = apiCallId => retainInteractionModelMetadata({data:{apiCallId}});
    const receipt = apiCallId => retainUsageReceipt({type:"session.usage_record",data:{usage:{
        apiCallId, model:"example", inputTokens:2, outputTokens:1, accounting:{usageId:apiCallId},
    }}})?.data;
    const incoming = project(raw);
    assert.equal(incoming.apiCallId,null); assert.match(incoming.apiCallRef,/^![a-f0-9]{64}$/);
    assert.equal(modelRequestKey(incoming),key);
    assert.equal(receipt(raw).apiCallId,key); assert.equal(receipt(raw).accounting.id,key);
    assert.notEqual(receipt(raw.replace("xy==","yx==")).apiCallId,key);
    for (const invalid of [key,"A".repeat(513),"ghp_"+"x".repeat(36),raw+"\u0000"])
        assert.equal(receipt(invalid),undefined);
    assert.equal(modelRequestKey(project(key)),null);
    assert.equal(modelRequestKey({apiCallId:"a",apiCallRef:key}),null);
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
