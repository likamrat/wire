import test from "node:test";
import assert from "node:assert/strict";
import { firstUsageDays, recordedUsage, usageSummary, usageQuestionGroups } from "../lib/interaction-usage.mjs";
import { createUsageReading } from "../web/usage-reading.mjs";
import { modelRequestKey, retainedReceiptContext, retainedUsage, retainToolTokens, retainUsageReceipt, toolTokenReadings } from "../lib/usage-receipts.mjs";
import { retainInteractionModelMetadata } from "../lib/interaction-model.mjs";
import { qualifiedResultPaths } from "../lib/history.mjs";

test("Analyze attributes a multi-day interaction once but keeps its later calls inside View by day",()=>{
    const {usageCalendar} = createUsageReading({firstUsageDays});
    const list = [{scenarioId:"a",origin:"one",usage:{total:40}},{scenarioId:"b",origin:"one",usage:{total:40}},
        {scenarioId:"c",origin:"two",usage:{total:0}},{scenarioId:"d",origin:"three",usage:null}];
    const calendar=usageCalendar(list,[
        {scenarioId:"a",startedAt:"2026-10-17"},{scenarioId:"b",startedAt:"2026-10-14"},
        {scenarioId:"a",startedAt:"2026-10-15"},{scenarioId:"c",startedAt:"2026-10-15"},{scenarioId:"d",startedAt:"2026-10-15"},
        {scenarioId:"out-of-scope",startedAt:"2026-10-20"},
    ],s=>s.origin,v=>v);
    assert.deepEqual(calendar,{range:{from:"2026-10-14",to:"2026-10-17"},days:[
        {date:"2026-10-17",total:0,metered:0,eligible:0,active:1},
        {date:"2026-10-15",total:0,metered:1,eligible:2,active:3},{date:"2026-10-14",total:40,metered:1,eligible:1,active:1},
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

test("pending request-only metering excludes rival run, message, request and delegated claims", () => {
    const p = { id:"prompt", type:"user.message", timestamp:"2026-10-29T12:00:00Z", data:{ wireUsageOrigin:"run", messageId:"msg" } };
    const a = { id:"response", type:"assistant.message", data:{ wireUsageOrigin:"run", originatingMessageId:"msg", wireOriginalModel:{ apiCallId:"api" } } };
    const r = { id:"receipt", type:"session.usage_record", data:{ apiCallId:"api" } };
    const record = { sourceSessionId:"s", userPrompt:{ sourceEventId:p.id, sourceTimestamp:p.timestamp }, toolCalls:[{ startEventId:"tool" }] };
    const kept = (events, target = record) => retainedReceiptContext([...events,r],[target],"s").includes(r);
    assert.equal(kept([p,a]), true);
    for (const events of [[p,a,{ ...p,id:"other",data:{ ...p.data,messageId:"other" } }],
        [p,a,{ ...a,id:"rival",data:{ ...a.data,wireUsageOrigin:"different" } }],
        [p,{ ...a,data:{ ...a.data,originatingMessageId:"different" } }],
        [p,{ ...a,agentId:"delegate" }], [{ ...p,data:{ ...p.data,wireUsageExcluded:true } },a]]) {
        assert.equal(kept(events), false);
    }
    assert.equal(kept([p,a],{ ...record,sourceSessionId:"other" }), false);
    assert.equal(kept([p,a],{ ...record,assessmentMembershipPruned:true }), false);
});

function sharedRun() {
    let ordinal = 0;
    const e = (id, type, data) => ({ id, type, timestamp:new Date(1700000000000 + ordinal++).toISOString(), data });
    const receipt = (id, input) => e(`receipt-${id}`, "session.usage_record",
        { apiCallId:id, origin:"shared", model:"example", tokens:{input,freshInput:null,cacheRead:null,cacheWrite:null,output:1} });
    const records = [], events = [];
    for (const n of [1,2]) {
        const prompt = e(`prompt-${n}`, "user.message", {messageId:`message-${n}`,wireUsageOrigin:"shared"});
        records.push({sourceSessionId:"source",userPrompt:{sourceEventId:prompt.id,sourceTimestamp:prompt.timestamp},
            toolCalls:[{startEventId:`start-${n}`,toolCallId:`tool-${n}`}]});
        const response = (id, api, extra) => e(id, "assistant.message", {wireUsageOrigin:"shared",
            originatingMessageId:`message-${n}`,turnId:`turn-${n}`,wireOriginalModel:{apiCallId:api,model:"example"},...extra});
        events.push(prompt, response(`request-${n}`,`request-api-${n}`,{hasToolRequests:true,wireToolRequestIds:[`tool-${n}`]}),
            e(`start-${n}`,"tool.execution_start",{toolCallId:`tool-${n}`}),receipt(`request-api-${n}`,10*n),
            response(`answer-${n}`,`answer-api-${n}`,{finalAnswer:true}),receipt(`answer-api-${n}`,20*n),
            e(`end-${n}`,"assistant.turn_end",{turnId:`turn-${n}`}));
    }
    return {events,records};
}

test("a reused telemetry run can meter two independently closed exact-message request sets", () => {
    const {events,records} = sharedRun(), before = structuredClone(events);
    const first = retainedUsage(events,records[0],false), second = retainedUsage(events,records[1],false);
    assert.deepEqual(first?.map(r=>r.apiCallId),["request-api-1","answer-api-1"]);
    assert.deepEqual(second?.map(r=>r.apiCallId),["request-api-2","answer-api-2"]);
    assert.deepEqual([recordedUsage(first).total,recordedUsage(second).total],[32,62]);
    assert.deepEqual(first[0].linkedToolStarts,["start-1"]);
    assert.deepEqual(second[0].linkedToolStarts,["start-2"]);
    assert.deepEqual(events,before,"The shared original claim is preserved, not deleted to force a match");
});

test("independent-message metering never bypasses ambiguous ownership, privacy, partial receipts or closure", () => {
    const cases = [
        events => { delete events.find(e=>e.id==="answer-1").data.originatingMessageId; },
        events => { events.find(e=>e.id==="answer-2").data.wireOriginalModel.apiCallId="answer-api-1"; },
        events => { events.find(e=>e.id==="answer-2").agentId="nested"; },
        events => { events.find(e=>e.id==="prompt-2").data.wirePromptCapture={reason:"credential-excluded"}; },
        events => { events.find(e=>e.id==="receipt-answer-api-1").data.origin="different"; },
        events => { events.find(e=>e.id==="receipt-answer-api-1").data.accounting={source:"another-source"}; },
        events => { events.push({...events.find(e=>e.id==="receipt-answer-api-2"),id:"run-only",data:{
            apiCallId:"unowned",origin:"shared",model:"example",tokens:{input:1,output:1}}}); },
        events => { events.splice(events.findIndex(e=>e.id==="receipt-answer-api-1"),1); },
        events => { events.find(e=>e.id==="answer-1").data.finalAnswer=false; },
        events => { events.splice(3,0,{id:"delegate",type:"subagent.started",data:{}}); },
        events => { events.find(e=>e.id==="answer-2").data.wireToolRequestIds=["tool-1"]; },
    ];
    for (const change of cases) {
        const {events,records} = sharedRun();
        change(events);
        let refusal;
        assert.equal(retainedUsage(events,records[0],false,reason=>{refusal=reason;return null;}),null);
        assert.ok(refusal,"An incomplete or conflicting original must retain an explicit refusal");
    }
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

test("longer base64 provider request IDs join model and receipt sides without admitting malformed or rival keys", () => {
    const long = (seed, pad = "") => (seed.repeat(129)).slice(0, 516 - pad.length) + pad;
    const raw = long("Qz9+"), rival = long("Qz9/");
    const project = apiCallId => ({version:1,model:"example",modelStatus:"recorded",originatingMessageId:"message",
        ...retainInteractionModelMetadata({data:{apiCallId,model:"example"}})});
    const receipt = (id, apiCallId, input) => ({...retainUsageReceipt({id,type:"session.usage_record",timestamp:new Date(1700000000000+input).toISOString(),
        data:{usage:{apiCallId,model:"example",inputTokens:input,outputTokens:1,accounting:{usageId:apiCallId}}}})});
    let ordinal = 0;
    const e = (id, type, data) => ({id,type,timestamp:new Date(1700000000000 + ordinal++).toISOString(),data});
    const prompt = e("prompt","user.message",{messageId:"message",wireUsageOrigin:"run"});
    const events = [prompt,
        e("request","assistant.message",{wireUsageOrigin:"run",originatingMessageId:"message",turnId:"turn",
            hasToolRequests:true,wireToolRequestIds:["tool"],wireOriginalModel:project(raw)}),
        e("start","tool.execution_start",{toolCallId:"tool"}), receipt("receipt-request",raw,10),
        e("answer","assistant.message",{wireUsageOrigin:"run",originatingMessageId:"message",turnId:"turn",
            finalAnswer:true,wireOriginalModel:project("short-answer-id")}), receipt("receipt-answer","short-answer-id",20),
        e("end","assistant.turn_end",{turnId:"turn"})];
    const record = {sourceSessionId:"source",userPrompt:{sourceEventId:prompt.id,sourceTimestamp:prompt.timestamp},
        toolCalls:[{startEventId:"start",toolCallId:"tool"}]};
    assert.equal(events[1].data.wireOriginalModel.apiCallId,null);
    assert.equal(events[3].data.apiCallId,events[1].data.wireOriginalModel.apiCallRef);
    assert.equal(events[3].data.accounting.id,events[3].data.apiCallId);
    assert.equal(JSON.stringify(events).includes(raw),false,"The raw opaque ID is not retained");
    assert.equal(recordedUsage(retainedUsage(events,record,false)).total,32);
    const swapped = structuredClone(events);
    swapped[3] = receipt("receipt-request",rival,10);
    let refusal;
    assert.equal(retainedUsage(swapped,record,false,reason=>{refusal=reason;return null;}),null);
    assert.ok(refusal,"A different long ID never stands in for the owned request");
    for (const valid of [long("Qz9-"),long("Qz9+","=="),long("Qz9_").slice(0,515)])
        assert.match(modelRequestKey({apiCallId:valid}),/^![a-f0-9]{64}$/);
    for (const invalid of [long("Qz9+").slice(0,513),long("a+-b"),long("Qz9+").slice(0,514)+"=A",long("Qz9+").slice(0,514)+"=",
        "Qz9+".repeat(1025),long("Qz9-").slice(0,476)+"ghp_"+"x".repeat(36),long("Qz.9")])
        assert.equal(modelRequestKey({apiCallId:invalid}),null);
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
    const repeated = recordedUsage([sample("gpt-4.1",5),sample("gpt-4.1",7)]);
    const identified = usageSummary(new Map([["mixed",mixed.usage],["repeated",repeated],["zero",zero.usage],["missing",null]]));
    assert.deepEqual(identified.models.map(row=>[row.model,row.total,row.interactions,row.interactionIds]),[
        ["gpt-4.1",24,3,["mixed","repeated","zero"]],["new-private-model",3,1,["mixed"]],
    ]);
});
