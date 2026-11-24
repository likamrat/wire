import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCollector } from "../lib/collector.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createProfileSource } from "./source-profile-fixture.mjs";

// One source installation and one independent WIRE store; all text is invented.
export async function usagePreview(t, frontend = "react") {
    const root = await mkdtemp(path.join(tmpdir(), "wire-token-preview-"));
    t.after(() => rm(root, {recursive:true,force:true}));
    const config = { appDbPath: path.join(root,"data.db"), sessionRoot: path.join(root,"session-state") };
    await mkdir(config.sessionRoot);
    const { db } = await createProfileSource(root);
    const examples = [
        ["Launch notes",17,"user",["retrieve","fetch","fetch"],"claude-sonnet-5-5",[[5000,8000,1000,1000],[3000,10000,1000,1000]],[7000,4000,1000]],
        ["Follow-up summary",17,"agent",["fetch"],"claude-opus-5-5",[[13000,45000,1500,2500]],[10000]],
        ["Find review owners",18,"user",["retrieve"],"gpt-4.1",[[10000,20000,0,3000]],[8500]],
        ["Consolidate changes",18,"agent",["retrieve","ask"],"claude-sonnet-5-5",[[18000,53000,7000,4000]],[9000,4000]],
        ["Meeting outline",19,null,["ask"],"preview-model",[[7000,21000,1000,1500]],[6000]],
        ["Search for notes",19,"user",["retrieve","retrieve"],null,[],[257,null]],
        ["Draft next steps",20,"agent",["fetch","ask"],"claude-opus-5-5",[[12000,72000,4000,4500]],[12500,6200]],
        ["Read project brief",20,"user",["fetch"],"gpt-4.1",[[4000,7000,0,1000]],[2500]],
    ];
    try {
        db.exec("UPDATE accounts SET settings_json='{}'");
        for (const [index,[title, day, actor, tools, model, calls, sizes]] of examples.entries()) {
            const id=randomUUID(), messageId=randomUUID(), interactionId=randomUUID(), receipts=[], events=[];
            const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
            const time = midnight.getTime() - (21-day)*86400000 + (10+index)*3600000;
            const event=(type,data)=>events.push({ type,data,id:randomUUID(),timestamp:new Date(time+events.length*100).toISOString() });
            db.prepare("INSERT INTO sessions(id,title,session_type) VALUES(?,?,'chat')").run(id,title);
            const direct = index === 2;
            event("session.start",{sessionId:id,version:1}); event("user.message",{content:title,...(direct?{}:{messageId}),interactionId,...(actor?{source:actor==="agent"?"agent-invented":actor}: {})});
            const promptId=events.at(-1).id, link=direct?{interactionId}:{model,originatingMessageId:messageId};
            const turnId=randomUUID(), apiCallId=index === 0 ? "ab/+".repeat(124)+"xy==" : randomUUID(), toolIds=tools.map(()=>randomUUID());
            event("assistant.message",{...link,apiCallId,turnId,toolRequests:toolIds.map(toolCallId=>({toolCallId}))});
            if(calls.length) receipts.push(apiCallId);
            tools.forEach((tool,i)=>{
                event("tool.execution_start",{toolName:`workiq-${tool}`,mcpToolName:tool,mcpServerName:"workiq",toolCallId:toolIds[i],turnId,
                    arguments:tool==="fetch"?{entityUrls:["/me/calendarView"]}:tool==="retrieve"?{query:title,capabilities:[{name:"Email"}]}:{question:title}});
                const toolUsage = index === 0 && i === 1 ? {requestId:randomUUID(),model:"tool-service",inputTokens:0,outputTokens:27,totalTokens:27}
                    : index === 5 && i === 1 ? {requestId:randomUUID(),model:"tool-service",inputTokens:11} : null;
                event("tool.execution_complete",{toolCallId:toolIds[i],success:!(index === 5 && i === 1),
                    ...(toolUsage ? {toolUsage} : {}), ...(sizes[i]!==null?{result:{content:"a".repeat(sizes[i]*4)}}:{})});
            });
            const finalId=calls.length>1?randomUUID():apiCallId;
            if(calls.length>1) receipts.push(finalId);
            event("assistant.message",{...link,apiCallId:finalId,turnId,...(direct?{}:{phase:"final_answer",content:"Invented completion."}),toolRequests:[]});
            event("assistant.turn_end",{turnId});
            if(direct){const end=events.at(-1).id;event("session.completion_receipt",{schemaVersion:1,attempt:1,stopReason:"natural",
                eventRange:{startEventId:promptId,endEventId:end},sourceEventId:end,successfulToolCount:tools.length,failedToolCount:0});}
            for(const [i,[fresh,read,write,out]] of calls.entries()) event("session.usage_record",{usage:{apiCallId:receipts[i],interactionId,model,initiator:i?"agent":"user",
                inputTokens:fresh+read+write,cacheReadTokens:read,cacheWriteTokens:write,outputTokens:out,
                accounting:{sourceSessionId:id,sequence:i+1,usageId:receipts[i]}}});
            const dir=path.join(config.sessionRoot,id);await mkdir(dir);await writeFile(path.join(dir,"events.jsonl"),events.map(e=>JSON.stringify(e)).join("\n")+"\n");
        }
    } finally {db.close();}
    const context={dataDir:path.join(root,"wire-store")};
    const collector=await createCollector(context,{timers:false});
    try {
        await collector.configure({...config,approved:true,enabled:false,windowDays:90,pollSeconds:30});
        await collector.collectNow();
    } finally {await collector.close();}
    const access=await createCopilotRuntimeAccess(context);
    t.after(()=>access.close());
    const runtime=await startServer(context,createExportController(context),{port:0,frontend,access,collector:{timers:false},
        githubProfile:{fetch(){throw Error("No network profile requests in the usage fixture.");}},
        evaluation:{evaluatorFactory(){throw Error("No providers in the usage fixture.");}}});
    t.after(()=>runtime.close());
    return {context,runtime};
}
