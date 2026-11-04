import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { hash, readJson, atomicJson } from "../lib/collector-io.mjs";
import { buildAssessmentModel, assessmentSource } from "../lib/assessment-read-model.mjs";
import { maintenanceStateGuard } from "../lib/historical-maintenance.mjs";
import { runFailureCohortMaintenance } from "../lib/failure-cohort-maintenance.mjs";
import { createExportController } from "../lib/export.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), digest = value => hash(JSON.stringify(value));
const envelope = value => "MCP server 'workiq': " + JSON.stringify(value);
const shapeExamples = [
    ["workiq-fetch", envelope({ results: [{ statusCode: 500, error: { error: { code: "InternalServerError", message: "Error while processing response." } } }] })],
    ["workiq-get_schema", envelope({ error: "No handler was registered for the invented endpoint. Discover the supported operations." })],
    ["workiq-get_schema", envelope({ error: "The invented schema is not available for that endpoint." })],
    ["workiq-delete_entity", envelope({ statusCode: 403, data: null, error: { error: { code: "", message: "You cannot access the invented item, or it may not exist." } } })],
    ["workiq-retrieve", "MCP server 'workiq': MCP request failed: Transport " + "InventedTransportLayer<".repeat(12) + " error: HTTP 503 Service Unavailable: upstream connection timeout"],
    ["workiq-fetch", "The invented connection needs renewed authorization. Open the connection settings."],
    ["workiq-fetch", "The invented connection requires a new sign-in before continuing."],
    ["workiq-fetch", envelope({ results: [0, 1, 2, 3, 4].map(index => index < 3
        ? { statusCode: 403, error: { error: { code: "", message: "You cannot access this invented item." } } }
        : { statusCode: 200, data: { body: "EXCLUDED_SUCCESS_BODY" } }) })],
    ["workiq-fetch", "Confidential source material must remain excluded."],
];
const oldFailure = { version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "text-excluded", messageSignal: null };
async function inventory(directory) {
    const files = [];
    async function visit(relative) {
        for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
            const name = path.join(relative, entry.name);
            if (entry.isDirectory()) await visit(name); else files.push({ path: name, sha256: hash(await readFile(path.join(directory, name))) });
        }
    }
    await visit(""); return files;
}
async function fixture(t) {
    const f = await recollectionFixture(t), originals = new Map(), sourcePins = new Map();
    for (const [sourceIndex, file] of f.files.entries()) {
        const initial = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
        const events = [initial[0]], at = Date.parse(initial[0].timestamp);
        for (const [index, [tool, message]] of shapeExamples.entries()) {
            if ((index < 4 ? 0 : 1) !== sourceIndex) continue;
            const id = `cohort-call-${index}`;
            if ([0, 2, 4, 6, 8].includes(index)) events.push({ id: `cohort-prompt-${index}`, type: "user.message",
                timestamp: new Date(at + index * 1000).toISOString(), data: { content: `Invented request group ${index}.` } });
            events.push({ id: id + "-start", type: "tool.execution_start", timestamp: new Date(at + index * 1000 + 1).toISOString(),
                data: { toolName: tool, toolCallId: id, arguments: tool === "workiq-fetch" ? { entityUrls: ["/me/messages"] }
                    : tool === "workiq-get_schema" ? { path: "/invented-schema" } : tool === "workiq-delete_entity"
                        ? { entityUrl: "/planner/plans/invented" } : { query: "Invented arguments only." } } });
            const end = { id: id + "-end", type: "tool.execution_complete", timestamp: new Date(at + index * 1000 + 25).toISOString(),
                data: { toolCallId: id, success: false, error: { code: "failure", message } } };
            events.push(end); originals.set(id, end);
        }
        const lines = events.map(event => JSON.stringify(event) + "\n");
        await writeFile(file, lines.join(""));
        sourcePins.set(initial[0].data.sessionId, { startupBytes: Buffer.byteLength(lines[0]), startupSha256: hash(lines[0]),
            completions: new Map(events.flatMap((event,index) => event.type === "tool.execution_complete" ? [[event.data.toolCallId, {
                offset: Buffer.byteLength(lines.slice(0,index).join("")), bytes: Buffer.byteLength(lines[index]), sha256: hash(lines[index]),
            }]] : [])) });
    }
    await f.collector.collectNow();
    const good = await loadBoardState(f.context), originalRecords = structuredClone(good.evidence);
    const config = f.collector.approvedRecollectionSource();
    const indexFile = path.join(f.context.dataDir,"collector","index.json"), index = await readJson(indexFile), checkpointFiles = [];
    for (const source of [f.sourceId, f.otherSourceId]) {
        const file = path.join(f.context.dataDir,"collector",index.fingerprint,source+".json"), checkpoint = await readJson(file);
        for (const event of checkpoint.events.filter(event=>originals.has(event.data?.toolCallId)&&event.type==="tool.execution_complete")) {
            event.data.wireFailureEvidence = { ...oldFailure }; delete event.data.wireResultEvidence;
            if (event.data.toolCallId === "cohort-call-7") event.data.result.structuredContent.results.forEach(entry=>delete entry.wireErrorDiagnostic);
            else event.data.result.structuredContent.results = [];
        }
        await atomicJson(file,checkpoint); checkpointFiles.push(file);
    }
    await replaceEvidence(f.context, records=>({ records:records.map(record=>({...record,toolCalls:record.toolCalls.map(call=>{
        if (!originals.has(call.toolCallId)) return call;
        const { resultEvidence, ...rest } = call;
        return { ...rest, failureEvidence:{...oldFailure}, apiResults:call.toolCallId==="cohort-call-7"
            ? call.apiResults.map(({errorDiagnostic,...entry})=>entry) : [] };
    })})),importCoverage:good.importCoverage }));
    // Real collection ages out three calls while leaving the fourth pair in that same source context.
    const at = Date.now()-60000, later = [{id:"cohort-later-prompt",type:"user.message",timestamp:new Date(at).toISOString(),data:{content:"Separate later invented work."}}];
    for(let index=0;index<148;index++) later.push(
        {id:`cohort-later-${index}-start`,type:"tool.execution_start",timestamp:new Date(at+index*100+1).toISOString(),
            data:{toolCallId:`cohort-later-${index}`,toolName:"workiq-retrieve",arguments:{query:"Later invented work."}}},
        {id:`cohort-later-${index}-end`,type:"tool.execution_complete",timestamp:new Date(at+index*100+2).toISOString(),data:{toolCallId:`cohort-later-${index}`,success:true}});
    later.push({id:"cohort-next-prompt",type:"user.message",timestamp:new Date(at+20000).toISOString(),data:{content:"Another invented prompt boundary."}});
    await appendFile(f.files[0],later.map(event=>JSON.stringify(event)+"\n").join("")); await f.collector.collectNow();
    const firstContext = await readJson(checkpointFiles[0]);
    assert.ok(!firstContext.events.some(event=>["cohort-call-0","cohort-call-1","cohort-call-2"].includes(event.data?.toolCallId)));
    assert.equal(firstContext.events.filter(event=>event.data?.toolCallId==="cohort-call-3").length,2);
    const reports = createExportController(f.context), stateForReport = await loadBoardState(f.context);
    const preview = await reports.preview("cohort-owner",undefined,{promptMode:"none",formats:["json","html"]},{kind:"all",revision:stateForReport.revision});
    await reports.review("cohort-owner",preview.previewId,true);await reports.confirm("cohort-owner",preview.previewId,true);
    await f.stop();
    const state = await loadBoardState(f.context), model = buildAssessmentModel(state), targets = [];
    for (const record of state.evidence) for (const call of record.toolCalls) if (originals.has(call.toolCallId)) {
        const pin = sourcePins.get(record.sourceSessionId);
        targets.push({scenarioId:record.scenarioId,sourceSessionId:record.sourceSessionId,recordSha256:digest(record),
            interactionRef:model.catalog.find(row=>row.scenarioId===record.scenarioId).interactionRef,
            prompt:{sourceEventId:record.userPrompt.sourceEventId,sourceTimestamp:record.userPrompt.sourceTimestamp,textSha256:hash(record.userPrompt.text)},
            call:Object.fromEntries(["tool","toolCallId","startEventId","startedAt","completionEventId","completedAt"].map(key=>[key,call[key]])),
            sourceEvent:{startupBytes:pin.startupBytes,startupSha256:pin.startupSha256,...pin.completions.get(call.toolCallId)},
            checkpointContextSha256:digest(await readJson(checkpointFiles[record.sourceSessionId===f.sourceId?0:1]))});
    }
    targets.sort((a,b)=>a.call.toolCallId.localeCompare(b.call.toolCallId));
    // A short-lived child's PID can be recycled for a crash-test child on Windows.
    const stoppedPid=2147483000;
    assert.throws(()=>process.kill(stoppedPid,0),{code:"ESRCH"});
    const plan={schemaVersion:1,operationId:randomUUID(),attestation:{packetSha256:hash("invented exact cohort approval"),
        recheckSha256:hash("invented source qualification"),stoppedRuntimePid:stoppedPid,recorderIdle:true,evaluatorIdle:true,noDispatchVerified:true},
        source:{configSha256:hash(await readFile(path.join(f.context.dataDir,"collector","config.json"))),
            indexSha256:hash(await readFile(indexFile)),...assessmentSource(state,config),windowDays:config.windowDays},
        stateGuardSha256:maintenanceStateGuard(state),preservedFiles:(await inventory(f.context.dataDir)).filter(file=>
            file.path!==`${BOARD_ID}.state.json`&&!checkpointFiles.some(checkpoint=>path.relative(f.context.dataDir,checkpoint)===file.path)),
        targets};
    const sourceFiles=[];
    for(const directory of ["lib","web","scripts"])for(const name of (await readdir(path.join(root,directory))).sort())if(name.endsWith(".mjs"))
        sourceFiles.push({path:path.join(directory,name),sha256:hash(await readFile(path.join(root,directory,name)))});
    const sourceIdentity=digest(sourceFiles),sourceManifestFile=path.join(f.root,"cohort-source.json");
    await writeFile(sourceManifestFile,JSON.stringify({root,files:sourceFiles,sourceIdentity}));
    const options={dataDir:f.context.dataDir,planFile:path.join(f.root,"cohort-plan.json"),journalFile:path.join(f.root,"cohort-journal.json"),sourceManifestFile,sourceIdentity};
    const reseal=async()=>{await writeFile(options.planFile,JSON.stringify(plan));options.planSha256=hash(await readFile(options.planFile));};
    await reseal();
    return {...f,get collector(){return f.collector;},plan,options,reseal,state,checkpointFiles,indexFile,allTargets:targets,originalRecords,originals};
}

test("cohort restores eight source diagnostics plus privacy-only metadata, preserves five entries, and survives append/restart",async t=>{
    const f=await fixture(t),storeBefore=await inventory(f.context.dataDir),checkpoints=await Promise.all(f.checkpointFiles.map(readJson));
    const prepared=await runFailureCohortMaintenance({...f.options,mode:"prepare"});
    assert.deepEqual(await inventory(f.context.dataDir),storeBefore);
    const options={...f.options,mode:"apply",reviewSha256:prepared.reviewSha256};
    await runFailureCohortMaintenance(options);
    const state=await loadBoardState(f.context),expected=structuredClone(f.state.evidence);
    for(const record of expected)for(const call of record.toolCalls)if(f.plan.targets.some(t=>t.call.toolCallId===call.toolCallId)){
        const original=f.originalRecords.flatMap(record=>record.toolCalls).find(old=>old.toolCallId===call.toolCallId);
        if(original.failureEvidence.diagnostic)call.failureEvidence.diagnostic=original.failureEvidence.diagnostic;
        if(original.apiResults.length)call.apiResults=call.apiResults.length?call.apiResults.map((entry,index)=>
            original.apiResults[index].errorDiagnostic?{...entry,errorDiagnostic:original.apiResults[index].errorDiagnostic}:entry):original.apiResults;
    }
    assert.deepEqual(state.evidence,expected);
    const five=state.evidence.flatMap(record=>record.toolCalls).find(call=>call.toolCallId==="cohort-call-7");
    assert.deepEqual(five.apiResults.map(entry=>entry.statusCode),[403,403,403,200,200]);
    assert.deepEqual(five.apiResults.map(entry=>Boolean(entry.errorDiagnostic)),[true,true,true,false,false]);
    assert.equal(five.failureEvidence.code,"failure");assert.equal(five.failureEvidence.messageSignal,null);
    assert.equal(Object.hasOwn(five,"resultEvidence"),false);
    const privacy=state.evidence.flatMap(record=>record.toolCalls).find(call=>call.toolCallId==="cohort-call-8");
    assert.deepEqual(privacy.failureEvidence.diagnostic,{version:1,source:"completion-error",status:"sensitive-excluded",code:"failure"});
    assert.doesNotMatch(JSON.stringify(state.evidence),/Confidential source material/);
    assert.deepEqual(privacy.apiResults,[]);
    assert.equal(Object.hasOwn(privacy,"resultEvidence"),false);
    assert.equal(createRecordedResults().failureReason(privacy),"Error details excluded for privacy");
    assert.equal(maintenanceStateGuard(state),maintenanceStateGuard(f.state));
    for(const file of f.plan.preservedFiles)assert.equal(hash(await readFile(path.join(f.context.dataDir,file.path))),file.sha256,file.path);
    const expectedFirst=structuredClone(checkpoints[0]);
    expectedFirst.events.find(event=>event.id==="cohort-call-3-end").data.wireFailureEvidence.diagnostic =
        f.originalRecords.flatMap(record=>record.toolCalls).find(call=>call.toolCallId==="cohort-call-3").failureEvidence.diagnostic;
    assert.deepEqual(await readJson(f.checkpointFiles[0]),expectedFirst,"Only the present pair gains a diagnostic; aged-out calls are not reconstructed.");
    const current=await readJson(f.checkpointFiles[1]),old=structuredClone(checkpoints[1]);
    for(const event of old.events) {
        const updated=current.events.find(e=>e.id===event.id);
        if(event.type==="tool.execution_complete"&&f.plan.targets.some(t=>t.call.completionEventId===event.id)){
            if(updated.data.wireFailureEvidence.diagnostic)event.data.wireFailureEvidence.diagnostic=updated.data.wireFailureEvidence.diagnostic;
            if(event.data.toolCallId==="cohort-call-7")event.data.result.structuredContent.results.forEach((entry,index)=>{
                if(updated.data.result.structuredContent.results[index].wireErrorDiagnostic)entry.wireErrorDiagnostic=updated.data.result.structuredContent.results[index].wireErrorDiagnostic;
            });
        }
    }
    assert.deepEqual(current,old);
    const reports=createExportController(f.context);
    const excluded=await reports.preview("restored-report",undefined,{promptMode:"none",formats:["json"]},{kind:"all",revision:state.revision});
    assert.doesNotMatch(JSON.stringify(excluded.files),/You cannot access this invented item/);
    const included=await reports.preview("restored-report",undefined,{promptMode:"none",resultText:true,formats:["json","html"]},{kind:"all",revision:state.revision});
    assert.match(included.previewHtml,/You cannot access this invented item/);
    assert.match(included.previewHtml,/You cannot access the invented item, or it may not exist/);
    assert.match(included.previewHtml,/HTTP 503 Service Unavailable/);
    for(const file of f.plan.preservedFiles)assert.equal(hash(await readFile(path.join(f.context.dataDir,file.path))),file.sha256,file.path);
    const saved=await inventory(f.context.dataDir);assert.equal((await runFailureCohortMaintenance(options)).alreadyCommitted,true);
    assert.deepEqual(await inventory(f.context.dataDir),saved);
    assert.doesNotMatch(await readFile(f.options.journalFile,"utf8"),/EXCLUDED_|invented item|TransportLayer/);
    await f.restart();
    for(const file of f.files)await appendFile(file,JSON.stringify({id:randomUUID(),type:"assistant.turn_end",timestamp:new Date().toISOString(),data:{turnId:"later"}})+"\n");
    await f.collector.collectNow();
    const after=await loadBoardState(f.context);
    for(const target of f.plan.targets)assert.deepEqual(after.evidence.find(record=>record.scenarioId===target.scenarioId).toolCalls,
        state.evidence.find(record=>record.scenarioId===target.scenarioId).toolCalls);
    assert.match(createRecordedResults().failureReason(five),/Returned entry 1.*cannot access/);
});

test("cohort checkpoint/board interruptions recover the same sealed additive postimages",async t=>{
    for(const boundary of ["checkpoint-1","checkpoint-2","snapshot-staged","board-saved"])await t.test(boundary,async t=>{
        const f=await fixture(t),prepared=await runFailureCohortMaintenance({...f.options,mode:"prepare"});
        const options={...f.options,mode:"apply",reviewSha256:prepared.reviewSha256},url=pathToFileURL(path.join(root,"lib","failure-cohort-maintenance.mjs")).href;
        const child=spawnSync(process.execPath,["--input-type=module","-e",`import{runFailureCohortMaintenance}from${JSON.stringify(url)};await runFailureCohortMaintenance(${JSON.stringify(options)},{onStep(p){if(p===${JSON.stringify(boundary)})process.exit(77);}});`],{cwd:root,encoding:"utf8"});
        assert.equal(child.status,77,child.stderr);
        const result=await runFailureCohortMaintenance(options);assert.equal(result.revision,f.state.revision+1);
        const before=await inventory(f.context.dataDir);assert.equal((await runFailureCohortMaintenance(options)).alreadyCommitted,true);
        assert.deepEqual(await inventory(f.context.dataDir),before);
    });
});

test("cohort refuses entry correspondence conflicts, partial context and stale or unqualified sources without partial repair",async t=>{
    for(const kind of ["entry-status","entry-order","existing-diagnostic","result-carrier","partial-context","duplicate-target","wrong-tool","stale-source","checkpoint-drift","non-useful-source"])await t.test(kind,async t=>{
        const f=await fixture(t),target=f.plan.targets[7];
        if(["entry-status","entry-order","existing-diagnostic","result-carrier"].includes(kind)){
            await replaceEvidence(f.context,records=>({records:records.map(record=>({...record,toolCalls:record.toolCalls.map(call=>{
                if(call.toolCallId!==target.call.toolCallId)return call;
                const next=structuredClone(call);
                if(kind==="entry-status")next.apiResults[0].statusCode=404;
                if(kind==="entry-order")next.apiResults.reverse();
                if(kind==="existing-diagnostic")next.apiResults[0].errorDiagnostic={version:1,source:"workiq-error-json",status:"recorded",message:"Different retained error."};
                if(kind==="result-carrier")next.resultEvidence={version:1,source:"sdk-result",applicationError:true,statusCode:500,contentStatus:"body-excluded",resultCount:5};
                return next;
            })})),importCoverage:f.state.importCoverage}));
            const state=await loadBoardState(f.context),record=state.evidence.find(record=>record.scenarioId===target.scenarioId);
            for(const t of f.plan.targets.filter(t=>t.scenarioId===target.scenarioId))t.recordSha256=digest(record);
        }
        if(kind==="partial-context"){
            const checkpoint=await readJson(f.checkpointFiles[1]);checkpoint.events=checkpoint.events.filter(event=>event.id!==target.call.startEventId);
            await atomicJson(f.checkpointFiles[1],checkpoint);
            for(const t of f.plan.targets.filter(t=>t.sourceSessionId===target.sourceSessionId))t.checkpointContextSha256=digest(checkpoint);
        }
        if(kind==="duplicate-target")f.plan.targets.push(structuredClone(target));
        if(kind==="wrong-tool")target.call.tool="workiq-update_entity";
        if(kind==="stale-source")target.sourceEvent.sha256="0".repeat(64);
        if(kind==="checkpoint-drift"){
            const checkpoint=await readJson(f.checkpointFiles[1]); checkpoint.diagnostics.contextEvictions++;
            await atomicJson(f.checkpointFiles[1],checkpoint);
        }
        if(kind==="non-useful-source"){
            const lines=(await readFile(f.files[1],"utf8")).trimEnd().split("\n");
            const position=lines.findIndex(line=>JSON.parse(line).id===target.call.completionEventId);
            const event=JSON.parse(lines[position]);event.data.error.message="failure";
            const encoded=JSON.stringify(event);
            lines[position]=encoded+" ".repeat(Buffer.byteLength(lines[position])-Buffer.byteLength(encoded));
            await writeFile(f.files[1],lines.join("\n")+"\n");
            target.sourceEvent.bytes=Buffer.byteLength(lines[position]+"\n");target.sourceEvent.sha256=hash(lines[position]+"\n");
        }
        await f.reseal();const before=await inventory(f.context.dataDir);
        await assert.rejects(runFailureCohortMaintenance({...f.options,mode:"prepare"}));
        assert.deepEqual(await inventory(f.context.dataDir),before);
        await assert.rejects(readFile(f.options.journalFile),{code:"ENOENT"});
    });

});

test("long transport diagnostic keeps the original terminal failure on the compact card",()=>{
    const text=shapeExamples[4][1], failure={...oldFailure,diagnostic:{version:1,source:"completion-error",status:"recorded",code:"failure",message:text}};
    const call={failureEvidence:failure,toolSucceeded:false,reportedOutcome:"failed",apiResults:[]};
    const summary=createRecordedResults({screen:true}).failureReason(call);
    assert.equal(summary,"Recorded error: MCP server 'workiq': MCP request failed: Transport ... error: HTTP 503 Service Unavailable: upstream connection timeout");
    assert.match(summary,/HTTP 503 Service Unavailable: upstream connection timeout/);
    assert.ok(summary.length<=260);
    assert.equal(call.failureEvidence.diagnostic.message,text,"Compact excerpts never rewrite retained source wording.");
});

test("literal diagnostic excerpts keep whole boundary tokens and bound unbroken text", () => {
    const presenter = createRecordedResults({ screen: true });
    const excerpt = text => presenter.failureReason({ failureEvidence: { ...oldFailure,
        diagnostic: { version: 1, source: "completion-error", status: "recorded", code: "failure", message: text } } }).slice("Recorded error: ".length);
    assert.equal(excerpt("An ordinary short error."), "An ordinary short error.");
    const head = "h".repeat(72), tail = "t".repeat(160);
    assert.equal(excerpt(head + " " + "middle ".repeat(50) + tail), head + " ... " + tail);
    assert.equal(excerpt(" \tBeginning\n" + "LongType<".repeat(50) + "\r\nEnding remains exact. "), "Beginning ... Ending remains exact.");
    assert.equal(excerpt("x".repeat(300) + " Final words."), "x".repeat(72) + " ... Final words.");
    assert.equal(excerpt("First words. " + "x".repeat(300)), "First words. ... " + "x".repeat(160));
    assert.equal(excerpt("Service response: " + "接続失敗".repeat(100)), "Service response: ... " + "接続失敗".repeat(40));
    assert.equal(excerpt("接続失敗".repeat(100) + " Request timed out."), "接続失敗".repeat(18) + " ... Request timed out.");
    const code = "E_CONNECTION_RESET_".repeat(20);
    assert.equal(excerpt("Recorded code: " + code), "Recorded code: ... " + Array.from(code).slice(-160).join(""));
    const unbroken = "界".repeat(500);
    assert.equal(excerpt(unbroken), "界".repeat(72) + " ... " + "界".repeat(160));
    assert.ok(Array.from(excerpt(unbroken)).length <= 240);
});
