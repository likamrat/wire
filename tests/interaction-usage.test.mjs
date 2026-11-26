import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { firstUsageDays, recordedUsage, usageSummary, usageQuestionGroups } from "../lib/interaction-usage.mjs";
import { createUsageReading } from "../web/usage-reading.mjs";
import { modelRequestKey, retainedReceiptContext, retainedUsage, retainToolTokens, retainUsageReceipt, toolTokenReadings, usageMatcherEvents } from "../lib/usage-receipts.mjs";
import { retainInteractionModelMetadata } from "../lib/interaction-model.mjs";
import { qualifiedResultPaths } from "../lib/history.mjs";
import { indexedUsage, indexedTurnUnchanged, readUsageIndex } from "../lib/copilot-usage-index.mjs";
import { continuingUsageContext, extendsExchange, retainEvent } from "../lib/collector.mjs";

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
        events => { events.find(e=>e.id==="answer-1").data.finalAnswer=false; events.splice(events.findIndex(e=>e.id==="prompt-2")); },
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

function steeredRun() {
    let ordinal = 0;
    const e = (id, type, data, extra = {}) => ({ id, type, timestamp:new Date(1700000000000 + 1000 * ordinal++).toISOString(), data, ...extra });
    const reply = (n, extra) => e(`reply-${n}`, "assistant.message", {wireUsageOrigin:"run",originatingMessageId:"root",turnId:`t-${n}`,
        wireOriginalModel:{apiCallId:`api-${n}`,model:"example"},...extra});
    const receipt = n => e(`receipt-${n}`, "session.usage_record", {apiCallId:`api-${n}`,origin:"run",model:"example",
        tokens:{freshInput:10*n,cacheRead:0,cacheWrite:0,output:n}});
    const round = (n, extra) => [e(`start-${n}`,"assistant.turn_start",{turnId:`t-${n}`}), receipt(n), reply(n, extra), e(`end-${n}`,"assistant.turn_end",{turnId:`t-${n}`})];
    const events = [e("prompt","user.message",{content:"Find the notes",messageId:"root",wireUsageOrigin:"run",wireDelivery:"idle"}),
        ...round(1,{hasToolRequests:true,wireToolRequestIds:["tool"]}), e("tool-start","tool.execution_start",{toolCallId:"tool"}),
        e("steer","user.message",{content:"Only this week",messageId:"steer",wireUsageOrigin:"run",wireDelivery:"steering"}),
        ...round(2,{hasToolRequests:true}), ...round(3,{finalAnswer:true})];
    const record = {sourceSessionId:"source",userPrompt:{sourceEventId:"prompt",sourceTimestamp:events[0].timestamp,text:"Find the notes"},
        toolCalls:[{startEventId:"tool-start",toolCallId:"tool"}]};
    return {events,record};
}

test("a steering message continues its interaction, so every model call after it is counted with the root prompt", () => {
    const {events,record} = steeredRun();
    const calls = retainedUsage(events,record,false);
    assert.deepEqual(calls?.map(c=>c.apiCallId),["api-1","api-2","api-3"]);
    assert.equal(recordedUsage(calls).total,66);
    for (const change of [
        events => { events.find(e=>e.id==="steer").data.wireDelivery="idle"; },
        events => { events.find(e=>e.id==="steer").data.wireUsageOrigin="other"; },
        events => { delete events.find(e=>e.id==="steer").data.wireDelivery; },
        events => { events.find(e=>e.id==="steer").agentId="nested"; },
    ]) {
        const run = steeredRun(); change(run.events);
        assert.equal(retainedUsage(run.events,run.record,false),null,"Only a recorded steering delivery into the same run continues it");
    }
});

test("the app's per-call index meters a prompt only when its rows match the journal's own model rounds", () => {
    const {events,record} = steeredRun();
    const journal = events.filter(e => e.type !== "session.usage_record");
    const at = id => new Date(Date.parse(journal.find(e=>e.id===id).timestamp) + 3).toISOString();
    const index = {sessionId:"source",turns:[{turn:0,text:"Find the notes",complete:true}],
        rows:[1,2,3].map(n => ({id:n,turn:0,agent:null,model:"example",input:100*n,output:n,cacheRead:90*n,cacheWrite:0,at:at(`reply-${n}`)}))};
    const calls = indexedUsage(journal,record,index);
    assert.equal(calls.length,3); assert.equal(recordedUsage(calls).total,606);
    assert.ok(calls.every(c => c.source === "copilot-usage-index" && c.tokens.freshInput === c.tokens.output * 10));
    const refusal = mutate => { const copy = structuredClone(index); mutate(copy); let why; indexedUsage(journal,record,copy,r=>{why=r;return null;}); return why; };
    assert.equal(refusal(i => i.rows.pop()),"index-incomplete","A journal round without an indexed call is not a complete total");
    assert.equal(refusal(i => { i.rows[0].at = journal[0].timestamp; }),"index-incomplete","A row outside the prompt's rounds is not this prompt's");
    assert.equal(refusal(i => i.turns.push({turn:1,text:"Find the notes",complete:true})),"index-prompt-unbound","Repeated prompt text must match occurrence for occurrence");
    const open = structuredClone(index); open.turns[0].complete = false;
    assert.equal(refusal(i => { i.turns[0].complete = false; }),"index-turn-open","An unanswered last turn may still be running");
    const bounded = [...journal, { id:"next", type:"user.message", timestamp:new Date(1800000000000).toISOString(), data:{ content:"Next", wireDelivery:"idle" } }];
    assert.ok(indexedUsage(bounded,record,open).every(c => c.unfinished),"Once the next prompt begins, its recorded calls count and say it stopped early");
    assert.equal(refusal(i => { i.rows[1].cacheRead = 500; }),"index-invalid-row");
    assert.equal(refusal(i => i.turns.push({turn:1,text:"Unseen later prompt",complete:true})),"index-boundary","An unbounded exchange is not counted");
});

test("the index reader tells an absent index from one it cannot read", async t => {
    const {DatabaseSync} = await import("node:sqlite"), {mkdtemp,rm} = await import("node:fs/promises"), path = await import("node:path"), os = await import("node:os");
    const dir = await mkdtemp(path.join(os.tmpdir(),"wire-usage-index-")); t.after(() => rm(dir,{recursive:true,force:true}));
    const file = path.join(dir,"session-store.db"), db = new DatabaseSync(file);
    db.exec(`CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT);
        CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, agent_id TEXT, model TEXT, input_tokens INTEGER,
            output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT);
        INSERT INTO turns VALUES ('s',0,'Hello','Done'); INSERT INTO assistant_usage_events VALUES (1,'s',0,NULL,'m',10,2,4,1,'2026-01-01T00:00:00Z');`);
    db.close();
    const index = readUsageIndex(file,"s");
    assert.deepEqual(index.turns,[{turn:0,text:"Hello",complete:true}]);
    assert.equal(index.rows[0].input,10);
    assert.equal(readUsageIndex(path.join(dir,"absent.db"),"s"),null,"No file means no records");
    assert.throws(() => readUsageIndex(file,"s",{ open(){ throw Object.assign(new Error("locked"),{ code:"ERR_SQLITE_ERROR" }); } }),
        e => e.code === "usage_index_unreadable" && e.reason === "open");
    const old = new DatabaseSync(file); old.exec("DROP TABLE assistant_usage_events"); old.close();
    assert.throws(() => readUsageIndex(file,"s"), e => e.code === "usage_index_unreadable" && e.reason === "schema","An unknown shape is a failed read, not an empty index");
});
test("a skipped or withheld entry only blocks a total when it falls between the prompt and the next prompt", () => {
    const gap = id => ({ id, type: "wire.history_gap", data: { reason: "oversized-line", offset: 1 } });
    const before = steeredRun(); before.events.unshift(gap("wire-gap-before"));
    assert.equal(recordedUsage(retainedUsage(before.events,before.record,false)).total,66,"A pasted image earlier in the chat does not hide this exchange");
    const withheld = steeredRun(); withheld.events[0].data = { ...withheld.events[0].data, content: null, wirePromptCapture: { reason: "credential-excluded" } };
    assert.equal(recordedUsage(retainedUsage(withheld.events,withheld.record,false)).total,66,"Withheld prompt text does not change its exact model counts");
    const inside = steeredRun(); inside.events.splice(6,0,gap("wire-gap-inside"));
    assert.equal(retainedUsage(inside.events,inside.record,false),null);
    const after = steeredRun(); after.events.push(gap("wire-gap-after"));
    assert.equal(retainedUsage(after.events,after.record,false),null,"An unread entry before the next prompt could continue this exchange");
    after.events.push({ id:"next", type:"user.message", timestamp:new Date(1800000000000).toISOString(), data:{ messageId:"next", wireUsageOrigin:"next" } });
    assert.equal(retainedUsage(after.events,after.record,false),null);
});
test("compacting a long open exchange never leaves a smaller exact total", () => {
    let n = 0;
    const e = (type, data) => ({ id: `e-${n}`, type, timestamp: new Date(1700000000000 + 1000 * n++).toISOString(), data });
    const events = [e("wire.history_gap", { reason: "oversized-line", offset: 1 }), e("user.message", { messageId: "m", wireUsageOrigin: "run", wireDelivery: "idle" })];
    const prompt = events[1], record = { sourceSessionId: "s", userPrompt: { sourceEventId: prompt.id, sourceTimestamp: prompt.timestamp }, toolCalls: [{ startEventId: "tool-start", toolCallId: "tool" }] };
    for (let i = 0; i < 101; i++) {
        events.push(e("assistant.turn_start", { turnId: `t${i}` }),
            e("session.usage_record", { apiCallId: `api-${i}`, origin: null, model: "m1", tokens: { freshInput: 10, cacheRead: 0, cacheWrite: 0, output: 1 } }),
            e("assistant.message", { originatingMessageId: "m", wireUsageOrigin: "run", turnId: `t${i}`, wireOriginalModel: { apiCallId: `api-${i}`, model: "m1" },
                ...(i === 0 ? { hasToolRequests: true, wireToolRequestIds: ["tool"] } : i === 100 ? { finalAnswer: true } : {}) }),
            ...(i === 0 ? [{ ...e("tool.execution_start", { toolCallId: "tool" }), id: "tool-start" }] : []),
            e("assistant.turn_end", { turnId: `t${i}` }));
    }
    const kept = continuingUsageContext(events, [record], "s", { contextEvictions: 0 });
    const calls = retainedUsage(usageMatcherEvents(kept), record, false);
    assert.ok(calls === null || recordedUsage(calls).total === 1111, `compaction produced ${calls && recordedUsage(calls).total}`);
    assert.equal(recordedUsage(calls).total, 1111, "The open exchange keeps every round it needs");
});

test("an indexed total stays only while the app records the same closed turn, and index model names are screened", () => {
    const row = id => ({ id, turn: 0, agent: null, model: "m", input: 10, output: 2, cacheRead: 4, cacheWrite: 1, at: "2026-01-01T00:00:0" + id + "Z" });
    const index = { sessionId: "s", turns: [{ turn: 0, text: "x", complete: true }], rows: [row(1), row(2)] };
    const key = id => `wire-usage-index-${createHash("sha256").update(`usage-index:s:${id}`).digest("hex")}`;
    const calls = index.rows.map(r => ({ receiptId: key(r.id), apiCallId: `!${key(r.id).slice(17)}`, origin: null, at: new Date(r.at).toISOString(), model: "m",
        tokens: { freshInput: 5, cacheRead: 4, cacheWrite: 1, output: 2 }, source: "copilot-usage-index" }));
    assert.equal(indexedTurnUnchanged(index, calls), true);
    assert.equal(indexedTurnUnchanged({ ...index, rows: [row(1), { ...row(2), output: 3 }] }, calls), false, "A corrected amount on the same row makes the total stale");
    assert.equal(indexedTurnUnchanged({ ...index, rows: [row(1), { ...row(2), model: "n" }] }, calls), false);
    assert.equal(indexedTurnUnchanged({ ...index, rows: [...index.rows, row(3)] }, calls), false, "A later call in the same turn makes the total stale");
    assert.equal(indexedTurnUnchanged({ ...index, turns: [{ turn: 0, text: "x", complete: false }] }, calls), false);
    const { events, record } = steeredRun(), journal = events.filter(x => x.type !== "session.usage_record");
    const at = id => new Date(Date.parse(journal.find(x => x.id === id).timestamp) + 3).toISOString();
    let why; indexedUsage(journal, record, { sessionId: "source", turns: [{ turn: 0, text: "Find the notes", complete: true }],
        rows: [1, 2, 3].map(i => ({ id: i, turn: 0, agent: null, model: i === 2 ? "ghp_" + "z".repeat(36) : "m", input: 9, output: 1, cacheRead: 0, cacheWrite: 0, at: at(`reply-${i}`) })) },
        r => { why = r; return null; });
    assert.equal(why, "index-invalid-row");
});
test("an assistant message the producer writes after a background notification is not a rival reply", () => {
    const run = () => { const r = steeredRun(), diag = { credentialExclusions:0 }, ctx = { metering:true, sourceSessionId:"source" }, at = r.events.findIndex(e => e.id === "start-2") + 1;
        const notice = retainEvent({ id:"notice", type:"system.notification", timestamp:r.events[at].timestamp, data:{ kind:{ type:"shell_completed" }, content:"done" } },diag,ctx);
        const note = retainEvent({ id:"note", type:"assistant.message", timestamp:r.events[at].timestamp,
            data:{ messageId:"note-m", content:"Reading the finished command.", toolRequests:[{ toolCallId:"note-tool" }] } },diag,ctx);
        return { ...r, notice, note, at }; };
    const plain = run(); plain.events.splice(plain.at,0,plain.note);
    assert.deepEqual(plain.notice.data,{},"No notification content is retained");
    assert.equal(retainedUsage(plain.events,plain.record,false),null,"Without a notification just before it, a message missing links is still unaccounted");
    const noted = run(); noted.events.splice(noted.at,0,noted.notice,noted.note);
    assert.equal(recordedUsage(retainedUsage(noted.events,noted.record,false)).total,66);
    const later = Array.from({ length:305 },(_,i) => ({ id:`later-${i}`, type:"assistant.turn_start", timestamp:new Date(1800000000000 + i).toISOString(), data:{ turnId:`later-${i}` } }));
    const aged = [...noted.events,...later];
    const kept = continuingUsageContext(aged,[{ ...noted.record, usageCalls:retainedUsage(noted.events,noted.record,false) }],"source",{ contextEvictions:0 });
    assert.ok(kept.some(e => e.id === "notice"),"Compaction of a long open exchange keeps the sanitized notification");
    const modelled = run(); modelled.note.data.wireOriginalModel = { ...modelled.note.data.wireOriginalModel, model:"example" }; modelled.events.splice(modelled.at,0,modelled.notice,modelled.note);
    assert.equal(retainedUsage(modelled.events,modelled.record,false),null,"A reply with recorded model metadata is a model call, not a producer note");
    const unmetered = run(), before = unmetered.events.findIndex(e => e.id === "start-3");
    unmetered.events.splice(before,0,{ id:"start-x", type:"assistant.turn_start", timestamp:unmetered.events[before].timestamp, data:{ turnId:"t-x" } },
        unmetered.notice,unmetered.note,{ id:"end-x", type:"assistant.turn_end", timestamp:unmetered.events[before].timestamp, data:{ turnId:"t-x" } });
    assert.equal(retainedUsage(unmetered.events,unmetered.record,false),null,"A notification does not make an otherwise unmetered round free");
});
test("replies to a later prompt that repeat the first prompt's message id belong to their own run", () => {
    const {events,record} = steeredRun(), at = Date.parse(events.at(-1).timestamp);
    const e = (id, type, data, n) => ({ id, type, timestamp:new Date(at + 1000 * n).toISOString(), data });
    events.push(e("next","user.message",{content:"And last week?",messageId:"next",wireUsageOrigin:"later",wireDelivery:"idle"},1),
        e("start-9","assistant.turn_start",{turnId:"t-9"},2),
        e("receipt-9","session.usage_record",{apiCallId:"api-9",origin:"later",model:"example",tokens:{freshInput:90,cacheRead:0,cacheWrite:0,output:9}},3),
        e("reply-9","assistant.message",{wireUsageOrigin:"later",originatingMessageId:"root",turnId:"t-9",finalAnswer:true,
            wireOriginalModel:{apiCallId:"api-9",model:"example"}},4), e("end-9","assistant.turn_end",{turnId:"t-9"},5));
    assert.equal(recordedUsage(retainedUsage(events,record,false)).total,66,"The later run's call is not part of the first exchange");
    events.splice(events.findIndex(x => x.id === "end-9"),0,e("tool-9","tool.execution_start",{toolCallId:"later-tool"},4.5));
    assert.equal(retainedUsage(events,{...record,toolCalls:[...record.toolCalls,{startEventId:"tool-9",toolCallId:"later-tool"}]},false),null,
        "A record that also groups the later prompt's call cannot take only the first exchange's total");
    const gapped = [...events]; gapped.splice(gapped.findIndex(x => x.id === "start-2"),0,{ id:"wire-gap-x", type:"wire.history_gap", data:{ reason:"oversized-line", offset:1 } });
    assert.equal(retainedUsage(gapped,{...record,toolCalls:[...record.toolCalls,{startEventId:"tool-9",toolCallId:"later-tool"}]},false,r=>r),"conflicting-link",
        "Known foreign membership is a conflict even when a gap would otherwise preserve a total");
    events.find(x => x.id === "reply-9").data.wireUsageOrigin = "run";
    assert.equal(retainedUsage(events,record,false),null,"A reply under the first run after the next prompt still conflicts");
});
test("an exchange that stopped before a final answer counts every recorded call once the next prompt bounds it", () => {
    const cut = () => { const run = steeredRun(); run.events.splice(run.events.findIndex(e => e.id === "start-3")); return run; };
    const lone = cut();
    assert.equal(retainedUsage(lone.events,lone.record,false),null,"Without a later prompt the exchange may still be running");
    const next = { id:"next", type:"user.message", timestamp:new Date(1800000000000).toISOString(), data:{ messageId:"next", wireUsageOrigin:"later", wireDelivery:"idle" } };
    const bounded = cut(); bounded.events.push(next);
    const calls = retainedUsage(bounded.events,bounded.record,false);
    assert.deepEqual(calls.map(c => c.apiCallId),["api-1","api-2"]); assert.ok(calls.every(c => c.unfinished));
    const late = cut(); late.events.push(next, { ...late.events.find(e => e.id === "reply-2"), id:"late-reply", timestamp:new Date(1800000001000).toISOString(),
        data:{ ...late.events.find(e => e.id === "reply-2").data, wireOriginalModel:{ apiCallId:"api-9", model:"example" } } });
    assert.equal(retainedUsage(late.events,late.record,false),null,"A reply to it after the next prompt means it had not stopped");
    const shut = cut(); shut.events.push({ id:"bye", type:"session.shutdown", timestamp:new Date(1800000000000).toISOString(), data:{} });
    assert.deepEqual(retainedUsage(shut.events,shut.record,false).map(c => c.apiCallId),["api-1","api-2"],"The producer ending the session also ends the exchange");
    shut.events.push({ ...shut.events.find(e => e.id === "reply-2"), id:"after-resume", timestamp:new Date(1800000002000).toISOString(),
        data:{ ...shut.events.find(e => e.id === "reply-2").data, wireOriginalModel:{ apiCallId:"api-8", model:"example" } } });
    assert.equal(retainedUsage(shut.events,shut.record,false),null,"Work resumed after the shutdown means it had not ended");
    const resumed = steeredRun(); resumed.events.splice(resumed.events.findIndex(e => e.id === "start-3"),0,{ id:"bye-2", type:"session.shutdown", timestamp:resumed.events[0].timestamp, data:{} });
    assert.equal(retainedUsage(resumed.events,resumed.record,false),null,"A final answer after a shutdown is resumed work, not this exchange");
    const unbound = cut(); unbound.events.push({ id:"receipt-4", type:"session.usage_record", timestamp:new Date(1799999999000).toISOString(),
        data:{ apiCallId:"api-4", model:"example", tokens:{ freshInput:40, cacheRead:0, cacheWrite:0, output:4 } } }, next);
    assert.equal(retainedUsage(unbound.events,unbound.record,false),null,"An unbound receipt inside the exchange contests the total");
    const compacted = continuingUsageContext(unbound.events,[unbound.record],"source",{ contextEvictions:0 });
    assert.equal(retainedUsage(usageMatcherEvents(compacted),unbound.record,false),null,"Dropping that receipt must not let a smaller total through");
    const sameRun = cut(); sameRun.events.push({ ...unbound.events.at(-2), data:{ ...unbound.events.at(-2).data, origin:"run" } }, next);
    assert.equal(recordedUsage(retainedUsage(sameRun.events,sameRun.record,false)).total,77,"A request-only call under the same run still spent tokens");
    assert.equal(recordedUsage(retainedUsage(usageMatcherEvents(continuingUsageContext(sameRun.events,[sameRun.record],"source",{ contextEvictions:0 })),sameRun.record,false)).total,77);
});
test("successive compactions of a run-linked exchange and its nesting marker never yield a smaller exact total", () => {
    for (const nested of [false, true]) {
        let n = 0;
        const e = (type, data) => ({ id: `c-${n}`, type, timestamp: new Date(1700000000000 + 1000 * n++).toISOString(), data });
        const prompt = e("user.message", { wireUsageOrigin: "run", wireDelivery: "idle" });
        const record = { sourceSessionId: "s", userPrompt: { sourceEventId: prompt.id, sourceTimestamp: prompt.timestamp }, toolCalls: [{ startEventId: "tool-start", toolCallId: "tool" }] };
        const round = (i, extra = {}) => [e("assistant.turn_start", { turnId: `t${i}` }),
            e("session.usage_record", { apiCallId: `api-${i}`, origin: null, model: "m1", tokens: { freshInput: 10, cacheRead: 0, cacheWrite: 0, output: 1 } }),
            e("assistant.message", { wireUsageOrigin: "run", turnId: `t${i}`, wireOriginalModel: { apiCallId: `api-${i}`, model: "m1" }, ...extra }),
            ...(i === 0 ? [{ ...e("tool.execution_start", { toolCallId: "tool" }), id: "tool-start" }] : []), e("assistant.turn_end", { turnId: `t${i}` })];
        let context = [prompt, ...round(0, { hasToolRequests: true, wireToolRequestIds: ["tool"] }), ...(nested ? [e("subagent.started", {})] : [])];
        for (const batch of [[1, 60], [60, 101]]) {
            for (let i = batch[0]; i < batch[1]; i++) context.push(...round(i, i === 100 ? { finalAnswer: true } : {}));
            context = continuingUsageContext(context, [record], "s", { contextEvictions: 0 });
        }
        const calls = retainedUsage(usageMatcherEvents(context), record, false);
        if (nested) assert.equal(calls, null, "Compaction must not erase the nesting that makes the main-agent total incomplete");
        else assert.equal(recordedUsage(calls)?.total, 1111);
    }
});
test("pruning an earlier exchange's rounds reports missing history instead of a smaller total", () => {
    let n = 0;
    const e = (type, data) => ({ id: `p-${n}`, type, timestamp: new Date(1700000000000 + 1000 * n++).toISOString(), data });
    const prompt = e("user.message", { wireUsageOrigin: "run", wireDelivery: "idle" });
    const record = { sourceSessionId: "s", userPrompt: { sourceEventId: prompt.id, sourceTimestamp: prompt.timestamp }, toolCalls: [{ startEventId: "tool-start", toolCallId: "tool" }] };
    const events = [prompt];
    for (let i = 0; i < 101; i++) events.push(e("assistant.turn_start", { turnId: `t${i}` }),
        e("assistant.message", { wireUsageOrigin: "run", turnId: `t${i}`, wireOriginalModel: { apiCallId: `api-${i}`, model: "m1" }, ...(i === 0 ? { hasToolRequests: true, wireToolRequestIds: ["tool"] } : {}) }),
        ...(i < 100 ? [e("session.usage_record", { apiCallId: `api-${i}`, origin: "run", model: "m1", tokens: { freshInput: 10, cacheRead: 0, cacheWrite: 0, output: 1 } })] : []),
        ...(i === 0 ? [{ ...e("tool.execution_start", { toolCallId: "tool" }), id: "tool-start" }] : []), e("assistant.turn_end", { turnId: `t${i}` }));
    events.push(e("user.message", { wireUsageOrigin: "next", wireDelivery: "idle", messageId: "next" }));
    for (let i = 0; i < 120; i++) events.push(e("assistant.turn_start", { turnId: `n${i}` }), e("assistant.turn_end", { turnId: `n${i}` }));
    const kept = continuingUsageContext(events, [record], "s", { contextEvictions: 0 });
    kept.push(e("session.usage_record", { apiCallId: "api-100", origin: "run", model: "m1", tokens: { freshInput: 10, cacheRead: 0, cacheWrite: 0, output: 1 } }));
    let why; const calls = retainedUsage(usageMatcherEvents(kept), record, false, r => { why = r; return null; });
    assert.ok(calls === null || recordedUsage(calls).total === 1111, `pruning produced ${calls && recordedUsage(calls).total}`);
});
function reviewFixture(messageId = false) {
    let clock = 1700000000000;
    const event = (id, type, data) => ({ id, type, timestamp: new Date(clock += 1000).toISOString(), data });
    const prompt = event("p", "user.message", { content: "Invented question", wireUsageOrigin: "run", wireDelivery: "idle", ...(messageId ? { messageId: "root" } : {}) });
    const record = { scenarioId: "scenario", sourceHost: "copilot-app", sourceSessionId: "s",
        userPrompt: { sourceEventId: prompt.id, sourceTimestamp: prompt.timestamp, text: prompt.data.content }, toolCalls: [{ startEventId: "tool", toolCallId: "tool" }] };
    return { event, prompt, record };
}

test("a late last receipt after compaction reports missing history, not a smaller total", () => {
    const { event: e, prompt, record } = reviewFixture(), events = [prompt];
    for (let n = 0; n < 101; n++) events.push(e(`s${n}`, "assistant.turn_start", { turnId: `t${n}` }),
        e(`r${n}`, "assistant.message", { turnId: `t${n}`, wireUsageOrigin: "run", wireOriginalModel: { apiCallId: `api${n}`, model: "example" },
            hasToolRequests: true, ...(n === 80 ? { wireToolRequestIds: ["tool"] } : {}) }),
        ...(n === 80 ? [e("tool", "tool.execution_start", { toolCallId: "tool" }), e("done", "tool.execution_complete", { toolCallId: "tool", success: true })] : []),
        e(`u${n}`, "session.usage_record", { apiCallId: `api${n}`, origin: null, model: "example", tokens: { freshInput: 10, cacheRead: 0, cacheWrite: 0, output: 1 } }),
        e(`z${n}`, "assistant.turn_end", { turnId: `t${n}` }));
    const late = events.find(x => x.id === "u100"), pending = events.filter(x => x !== late);
    pending.push(e("next", "user.message", { content: "Independent question", wireUsageOrigin: "other", wireDelivery: "idle" }),
        e("next-start", "assistant.turn_start", { turnId: "next-turn" }));
    late.timestamp = new Date(Date.parse(pending.at(-1).timestamp) + 1000).toISOString();
    assert.equal(recordedUsage(retainedUsage([...pending, late], record, false)).total, 1111);
    let reason;
    const calls = retainedUsage(usageMatcherEvents([...continuingUsageContext(pending, [record], "s", { contextEvictions: 0 }), late]), record, false,
        value => { reason = value; return null; });
    assert.equal(calls, null, `Incorrect exact total: ${calls && recordedUsage(calls).total}`);
    assert.equal(reason, "history-gap");
});

test("an identical redelivery after compaction does not retire a verified indexed total", () => {
    const { event: e, prompt, record } = reviewFixture(true), journal = [prompt], rows = [];
    for (let n = 0; n < 800; n++) {
        const start = e(`s${n}`, "assistant.turn_start", { turnId: `t${n}` });
        const reply = e(`r${n}`, "assistant.message", { turnId: `t${n}`, wireUsageOrigin: "run", originatingMessageId: "root",
            wireOriginalModel: { apiCallId: `api${n}`, model: "example" }, hasToolRequests: n !== 799, finalAnswer: n === 799, ...(n === 0 ? { wireToolRequestIds: ["tool"] } : {}) });
        journal.push(start, reply, ...(n === 0 ? [e("tool", "tool.execution_start", { toolCallId: "tool" }), e("done", "tool.execution_complete", { toolCallId: "tool", success: true })] : []),
            e(`z${n}`, "assistant.turn_end", { turnId: `t${n}` }));
        rows.push({ id: n + 1, turn: 0, agent: null, model: "example", input: 10, output: 1, cacheRead: 0, cacheWrite: 0, at: reply.timestamp });
    }
    const index = { sessionId: "s", turns: [{ turn: 0, text: prompt.data.content, complete: true }], rows };
    record.usageCalls = indexedUsage(journal, record, index);
    assert.equal(recordedUsage(record.usageCalls).total, 8800);
    const context = continuingUsageContext(journal, [record], "s", { contextEvictions: 0 });
    const incoming = [journal.find(x => x.id === "r799")], events = usageMatcherEvents([...context, ...incoming]);
    assert.equal(extendsExchange(events, incoming, record, new Set(context.map(x => x.id))) || !indexedTurnUnchanged(index, record.usageCalls), false);
});

function nestingRun(kind) {
    let clock = 1700000000000;
    const e = (id, type, data, extra = {}) => ({ id, type, timestamp: new Date(clock += 1000).toISOString(), data, ...extra });
    const prompt = e("p", "user.message", { content: "Invented question", messageId: "root", wireUsageOrigin: "run", wireDelivery: "idle" });
    const record = { sourceSessionId: "s", userPrompt: { sourceEventId: prompt.id, sourceTimestamp: prompt.timestamp }, toolCalls: [{ startEventId: "tool", toolCallId: "tool" }] };
    const events = [prompt];
    if (kind === "subagent") events.push(e("nested", "subagent.started", {}));
    else if (kind === "nested-tool") events.push(e("nested-start", "tool.execution_start", { toolCallId: "nested", toolName: "workiq-fetch", parentToolCallId: "parent" }, { agentId: "child" }),
        e("nested-end", "tool.execution_complete", { toolCallId: "nested", success: true }, { agentId: "child" }));
    // An unsupported nested start is not retained; only its completion remains.
    else events.push(e("nested-end", "tool.execution_complete", { toolCallId: "nested", success: true }, { agentId: "child" }));
    for (let n = 0; n < 160; n++) events.push(e(`noise-start-${n}`, "tool.execution_start", { toolCallId: `noise-${n}`, toolName: "workiq-fetch" }),
        e(`noise-end-${n}`, "tool.execution_complete", { toolCallId: `noise-${n}`, success: true }));
    for (let n = 0; n < 2; n++) events.push(e(`s${n}`, "assistant.turn_start", { turnId: `t${n}` }),
        e(`r${n}`, "assistant.message", { turnId: `t${n}`, originatingMessageId: "root", wireUsageOrigin: "run", wireOriginalModel: { apiCallId: `api${n}`, model: "example" },
            hasToolRequests: n === 0, finalAnswer: n === 1, ...(n === 0 ? { wireToolRequestIds: ["tool"] } : {}) }),
        ...(n === 0 ? [e("tool", "tool.execution_start", { toolCallId: "tool" }), e("done", "tool.execution_complete", { toolCallId: "tool", success: true })] : []),
        e(`u${n}`, "session.usage_record", { apiCallId: `api${n}`, origin: "run", model: "example", tokens: { freshInput: 10, cacheRead: 0, cacheWrite: 0, output: 1 } }),
        e(`z${n}`, "assistant.turn_end", { turnId: `t${n}` }));
    events.push(e("next", "user.message", { content: "Next question", messageId: "next", wireUsageOrigin: "other", wireDelivery: "idle" }));
    return { events, record };
}

for (const kind of ["subagent", "nested-tool", "orphan-nested-completion"]) test(`compaction preserves an older exchange's ${kind} completeness barrier`, () => {
    const { events, record } = nestingRun(kind);
    let before; assert.equal(retainedUsage(events, record, false, r => { before = r; return null; }), null);
    assert.equal(before, "incomplete-or-nested");
    let reason;
    const calls = retainedUsage(usageMatcherEvents(continuingUsageContext(events, [record], "s", { contextEvictions: 0 })), record, false, r => { reason = r; return null; });
    assert.equal(calls, null, `Incorrect exact total: ${calls && recordedUsage(calls).total}`);
    assert.ok(["history-gap", "incomplete-or-nested"].includes(reason), reason);
});
