import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, readdir, mkdir, appendFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { usagePreview } from "../analyze/usage-preview-fixture.mjs";
import { stoppedRuntimePid } from "../support/stopped-runtime-fixture.mjs";
import { createCollector } from "../../lib/collector.mjs";
import { atomicJson, hash, sourceFileStamp } from "../../lib/collector-io.mjs";
import { loadBoardState, replaceEvidence } from "../../lib/store.mjs";
import { createExportController } from "../../lib/export.mjs";
import { createCopilotRuntimeAccess } from "../../lib/runtime-access.mjs";
import { startServer } from "../../lib/server.mjs";
import { assessmentSource } from "../../lib/assessment-read-model.mjs";
import { sourceHost } from "../../lib/source-host.mjs";
import { readSourceMetadata } from "../../lib/source-reader.mjs";
import { completionReferenceStore } from "../../lib/checkpoint-references.mjs";
import { sessionStorage } from "../../lib/microsoft-session-state.mjs";
import { maintenanceStateGuard } from "../../lib/historical-maintenance.mjs";
import { runReturnedTextRepair } from "../../lib/returned-text-repair.mjs";

const digest = value => hash(JSON.stringify(value));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = async file => JSON.parse(await readFile(file));
async function fixture(t) {
    const {context,config,root:temp} = await usagePreview(t,"react",{offline:true});
    const sid=randomUUID(), pid=randomUUID(), request=randomUUID(), interactionId=randomUUID(), messageId=randomUUID(), apiCallId=randomUUID(), turnId=randomUUID();
    const members=["retrieve","retrieve","fetch","ask"].map((tool,i)=>({tool,toolCallId:randomUUID(),startEventId:randomUUID(),completionEventId:randomUUID(),
        bytes:[31,9,65,null][i]}));
    const db=new DatabaseSync(config.appDbPath);
    try { db.prepare("INSERT INTO sessions(id,title,session_type) VALUES(?,?,'chat')").run(sid,"Invented size qualification");
        db.exec("CREATE TABLE session_managed_mcp_event_display_names(session_id TEXT NOT NULL,event_id TEXT NOT NULL,display_name TEXT NOT NULL,PRIMARY KEY(session_id,event_id))");
        for(const c of members) db.prepare("INSERT INTO session_managed_mcp_event_display_names VALUES(?,?,'Work IQ')").run(sid,c.startEventId);
    }
    finally { db.close(); }
    const dir=path.join(config.sessionRoot,sid), file=path.join(dir,"events.jsonl"), events=[];
    await mkdir(dir);
    const time=Date.now()-40000, add=(type,data,id=randomUUID())=>{const e={id,type,timestamp:new Date(time+events.length*50).toISOString(),data};events.push(e);return e;};
    add("session.start",{sessionId:sid,version:1});add("user.message",{content:"Invented byte-size review",messageId,interactionId},pid);
    const link={originatingMessageId:messageId,interactionId,turnId,model:"gpt-6.2-sol",apiCallId};
    add("assistant.message",{...link,toolRequests:members.map(c=>({toolCallId:c.toolCallId}))},request);
    for (const c of members) {
        add("tool.execution_start",{toolCallId:c.toolCallId,mcpServerName:"cc-fixture",mcpToolName:c.tool,toolName:`cc-fixture-${c.tool}`,turnId,
            arguments:c.tool==="fetch"?{entityUrls:["/me/calendarView"]}:c.tool==="retrieve"?{query:"Invented query",capabilities:[{name:"Email"}]}:{question:"Invented question"}},c.startEventId);
        add("tool.execution_complete",{toolCallId:c.toolCallId,turnId,success:c.bytes!==null,...(c.bytes===null
            ? {error:{message:"MCP error 1004: Work IQ took too long to respond"}}
            : {result:{content:"x".repeat(c.bytes),...(c.tool==="fetch"?{structuredContent:{results:[{statusCode:200},{statusCode:200}]}}:{})}})},c.completionEventId);
    }
    add("assistant.message",{...link,phase:"final_answer",content:"Invented reply",toolRequests:[]});add("assistant.turn_end",{turnId});
    add("session.usage_record",{usage:{interactionId,apiCallId,model:"gpt-6.2-sol",inputTokens:40,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:2}});
    await writeFile(file,events.map(e=>JSON.stringify(e)+"\n").join(""));
    const collector=await createCollector(context,{timers:false});
    let approved;
    try {await collector.collectNow(); approved=collector.approvedRecollectionSource();} finally {await collector.close();}
    const good=await loadBoardState(context),record=good.evidence.find(r=>r.userPrompt?.sourceEventId===pid);
    const collectorDir=path.join(context.dataDir,"collector"),idxFile=path.join(collectorDir,"index.json"),index=await read(idxFile);
    const cpFile=path.join(collectorDir,index.fingerprint,sid+".json"),cp=await read(cpFile),oldCp=structuredClone(cp),old=structuredClone(record);
    const targetCalls=members.slice(0,3).map(({bytes,toolCallId,startEventId,completionEventId})=>{
        const c=old.toolCalls.find(c=>c.toolCallId===toolCallId), e=oldCp.events.find(e=>e.id===completionEventId);
        assert.equal(c.returnedTextBytes,bytes);assert.equal(e.data.wireReturnedTextBytes,bytes);
        delete c.returnedTextBytes;delete e.data.wireReturnedTextBytes;
        return {tool:c.tool,toolCallId,startEventId,completionEventId,startedAt:c.startedAt,completedAt:c.completedAt,requestEventId:request,
            bytes,callBefore:digest(c),callAfter:digest({...c,returnedTextBytes:bytes}),completionBefore:digest(e),
            completionAfter:digest({...e,data:{...e.data,wireReturnedTextBytes:bytes}})};
    });
    await replaceEvidence(context,records=>({records:records.map(r=>r.scenarioId===record.scenarioId?old:r),importCoverage:good.importCoverage}));
    await atomicJson(cpFile,oldCp);
    const stale=await loadBoardState(context), reports=createExportController(context);
    const preview=await reports.preview("fixture",undefined,{promptMode:"none",formats:["json"]},{kind:"selected",scenarioIds:[record.scenarioId],revision:stale.revision});
    await reports.review("fixture",preview.previewId,true);
    const frozen=(await reports.confirm("fixture",preview.previewId,true)).bundle;
    const state=await loadBoardState(context), profile=await readSourceMetadata(sourceHost(approved),{profileOnly:true});
    const metadata=await readSourceMetadata(sourceHost(approved),{includeIdentity:true}),{checkedAt,...mapping}=metadata.roster.find(r=>r.sessionId===sid);
    const pinned=new Set([pid,request,...members.slice(0,3).flatMap(c=>[c.startEventId,c.completionEventId])]);
    const target={kind:"workiq-returned-text-bytes-v1",scenarioId:record.scenarioId,sourceSessionId:sid,prompt:{sourceEventId:pid,sourceTimestamp:record.userPrompt.sourceTimestamp},
        accountSha256:digest([profile.sourceIdentity,profile.account.host,profile.account.id,profile.account.login.toLowerCase()]),mappingSha256:digest(mapping),
        lifecycleSha256:digest(await sessionStorage(context).read()),storeRef:completionReferenceStore(state,context.dataDir),recordSha256:digest(old),
        checkpointSha256:digest(oldCp),sourceStampSha256:hash(sourceFileStamp(await stat(file))),
        originalsSha256:digest(events.filter(e=>pinned.has(e.id)).map(e=>[e.id,hash(JSON.stringify(e)+"\n")])),calls:targetCalls};
    const preservedFiles=await Promise.all(Object.values(frozen.files).map(async file=>({path:path.relative(context.dataDir,file),sha256:hash(await readFile(file))})));
    const plan={schemaVersion:1,operationId:randomUUID(),attestation:{packetSha256:hash("invented review"),recheckSha256:hash("invented predicates"),
        stoppedRuntimePid:await stoppedRuntimePid(t),recorderIdle:true,evaluatorIdle:true,noDispatchVerified:true},
        source:{...assessmentSource(state,approved),windowDays:approved.windowDays,configSha256:hash(await readFile(path.join(collectorDir,"config.json"))),indexSha256:hash(await readFile(idxFile))},
        stateGuardSha256:maintenanceStateGuard(state),preservedFiles,targets:[target]};
    const paths=[];
    for(const folder of ["lib","scripts","web"])for(const f of (await readdir(path.join(root,folder))).filter(f=>f.endsWith(".mjs")).sort()){
        const p=path.join(folder,f);paths.push({path:p,sha256:hash(await readFile(path.join(root,p)))});
    }
    const sourceIdentity=digest(paths), options={dataDir:context.dataDir,planFile:path.join(temp,"size-review.json"),planSha256:digest(plan),
        journalFile:path.join(temp,"size-journal.json"),sourceManifestFile:path.join(temp,"source-manifest.json"),sourceIdentity};
    await atomicJson(options.planFile,plan);await atomicJson(options.sourceManifestFile,{root,files:paths,sourceIdentity});
    return {options,plan,context,file,good,record,old,cpFile,cp,oldCp,state,idxFile,indexBefore:await readFile(idxFile),preservedFiles};
}

test("byte-size correction refuses changed inputs and reconciles exactly six fields through restart and append", async t=>{
    const f=await fixture(t), run=(mode,opts={},hooks)=>runReturnedTextRepair({...f.options,mode,...opts},hooks);
    const o=f.options, prepared=JSON.parse(execFileSync(process.execPath,[path.join(root,"scripts","maintain-returned-text.mjs"),
        "--mode","prepare","--data-dir",o.dataDir,"--plan",o.planFile,"--plan-sha256",o.planSha256,"--journal",o.journalFile,
        "--source-manifest",o.sourceManifestFile,"--source-identity",o.sourceIdentity],{encoding:"utf8"})), seal={reviewSha256:prepared.reviewSha256};
    const drift=structuredClone(f.oldCp);drift.events.find(e=>e.id===f.plan.targets[0].calls[0].completionEventId).data.wireReturnedTextBytes=0;
    await atomicJson(f.cpFile,drift);
    await assert.rejects(run("apply",seal),/Checkpoint pre\/postimage drift/);
    assert.deepEqual(await read(f.cpFile),drift);
    await atomicJson(f.cpFile,f.oldCp);
    await assert.rejects(run("resume",seal),/prior dispatch is uncertain/);
    await assert.rejects(run("apply",seal,{onStep:phase=>{if(phase==="checkpoint-1")throw Error("invented interruption");}}),/invented interruption/);
    assert.deepEqual((await loadBoardState(f.context,{readOnly:true})).evidence,f.state.evidence);
    await assert.rejects(createCollector(f.context,{timers:false}),e=>e.code==="RETAINED_REPAIR_PENDING");
    await assert.rejects(run("apply",seal),/undispatched/);
    await assert.rejects(run("resume",{reviewSha256:hash("a different review")}),/journal mismatch/);
    assert.equal((await run("resume",seal)).status,"complete");
    const receiptBytes=await readFile(f.options.journalFile);
    assert.equal((await run("resume",seal)).alreadyCommitted,true);
    assert.deepEqual(await readFile(f.options.journalFile),receiptBytes);
    assert.deepEqual(await readFile(f.idxFile),f.indexBefore);
    const fixed=await loadBoardState(f.context), expected=structuredClone(f.state.evidence);
    const record=expected.find(r=>r.scenarioId===f.old.scenarioId), expectedCp=structuredClone(f.oldCp);
    for(const c of f.plan.targets[0].calls){
        record.toolCalls.find(v=>v.toolCallId===c.toolCallId).returnedTextBytes=c.bytes;
        expectedCp.events.find(e=>e.id===c.completionEventId).data.wireReturnedTextBytes=c.bytes;
    }
    assert.deepEqual(fixed.evidence,expected);assert.deepEqual(await read(f.cpFile),expectedCp);
    assert.equal(fixed.revision,f.state.revision+1);assert.equal(fixed.evidenceRevision,f.state.evidenceRevision+1);
    assert.equal(maintenanceStateGuard(fixed),maintenanceStateGuard(f.state));
    const collector=await createCollector(f.context,{timers:false});
    try {await appendFile(f.file,JSON.stringify({id:randomUUID(),type:"assistant.turn_end",timestamp:new Date().toISOString(),data:{turnId:"unrelated"}})+"\n");
        await collector.collectNow();} finally {await collector.close();}
    assert.deepEqual((await loadBoardState(f.context)).evidence,expected);
    const afterCp=await read(f.cpFile);
    for(const c of record.toolCalls)assert.deepEqual(afterCp.events.find(e=>e.id===c.completionEventId),expectedCp.events.find(e=>e.id===c.completionEventId));
    for(const fz of f.preservedFiles)assert.equal(hash(await readFile(path.join(f.context.dataDir,fz.path))),fz.sha256);
    const access=await createCopilotRuntimeAccess(f.context);
    let runtime,browser;
    try {
        runtime=await startServer(f.context,createExportController(f.context),{port:0,collector:{timers:false},access});
        browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1480,height:960}});
        await page.goto(runtime.url);
        await page.locator("#activityList article").filter({hasText:"Invented byte-size review"}).locator(".request-card-open").first().click();
        const usage=page.locator("[data-reader-section=usage]");
        await expect(usage).toContainText(`${record.toolCalls.slice(0,3).reduce((n,c)=>n+c.returnedTextBytes,0).toLocaleString("en-US")} bytes`);
        await expect(usage).toContainText("Measured for 3 of 4 calls.");await expect(usage).toContainText("GPT-6.2 Sol");
        await expect(page.locator("[data-reader-section=activity]")).toContainText("1004: Work IQ took too long to respond");
    } finally {await browser?.close();await runtime?.close();await access.close();}
});

test("byte-size correction refuses changed account, connector mapping or source bytes before dispatch", async t=>{
    const f=await fixture(t), run=(mode,opts={})=>runReturnedTextRepair({...f.options,mode,...opts});
    const prepared=await run("prepare"), seal={reviewSha256:prepared.reviewSha256};
    const config=await read(path.join(f.context.dataDir,"collector","config.json")),db=new DatabaseSync(config.appDbPath);
    try {
        db.exec("UPDATE projects SET github_account_id='default'");
        await assert.rejects(run("apply",seal),/account changed/);
        db.exec("UPDATE projects SET github_account_id='workspace'");
        const [tgt]=f.plan.targets, [c]=tgt.calls;
        const rename=db.prepare("UPDATE session_managed_mcp_event_display_names SET display_name=? WHERE session_id=? AND event_id=?");
        rename.run("Unrelated connector",tgt.sourceSessionId,c.startEventId);
        await assert.rejects(run("apply",seal),/mapping changed/);
        rename.run("Work IQ",tgt.sourceSessionId,c.startEventId);
    } finally {db.close();}
    await appendFile(f.file,"\n");
    await assert.rejects(run("apply",seal),/journal changed/);
    assert.equal((await read(f.options.journalFile)).phase,"prepared");
    assert.deepEqual(await read(f.cpFile),f.oldCp);assert.deepEqual(await readFile(f.idxFile),f.indexBefore);
    assert.deepEqual((await loadBoardState(f.context,{readOnly:true})).evidence,f.state.evidence);
});
