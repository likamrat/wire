import { searchRecords } from "./live-search-fixture.mjs";

export function frontendRecords(count = 240) {
    const prompts = [
        "Find the decisions from the Cedar launch review.",
        "What changed in the Cedar release checklist?",
        "Find the latest planning notes for the Atlas project.",
        "Which project reviews are scheduled this week?",
        "Find the document that lists the Cedar release owners.",
        "Find the messages about the Atlas handover.",
    ];
    return searchRecords(count).map((record, index) => {
        const stamp = `2026-11-${String(10 + index % 7).padStart(2, "0")}T${String(10 + index % 8).padStart(2, "0")}:15:00.000Z`;
        const actor = index % 4 ? "user" : "agent";
        record.title = prompts[index % prompts.length];
        record.sourceSessionId = `invented-frontend-chat-${index % 4}`;
        record.sourceSessionName = index % 2 ? "Cedar launch" : "Atlas planning";
        record.project = index % 2 ? "Cedar launch" : "Atlas planning";
        record.capturedAt = stamp;
        record.userPrompt = { text: `${prompts[index % prompts.length]} Keep the original dates and identify each source.`,
            status: "full", sourceEventId: `frontend-prompt-${index}`, sourceTimestamp: stamp,
            authorship: { actor, basis: `source-${actor}` } };
        record.followUpPrompts = []; record.httpRecords = [];
        const failure = index % 7 === 0;
        Object.assign(record.toolCalls[0], {
            tool: index % 3 ? "workiq-fetch" : "workiq-retrieve",
            startedAt: stamp, completedAt: new Date(Date.parse(stamp) + 600 + index * 31).toISOString(),
            durationMs: 600 + index * 31, completionEventId: `frontend-end-${index}`,
            requestArgs: { entityUrls: [failure ? "/me/messages" : "/me/drive/root/children"] },
            requestedApiPath: failure ? "/me/messages" : "/me/drive/root/children",
            toolSucceeded: !failure, reportedOutcome: failure ? "failed" : "succeeded",
            apiResults: [{ index: 0, path: failure ? "/me/messages" : "/me/drive/root/children",
                statusCode: failure ? 403 : 200, evidenceLevel: "intermediary-reported" }],
            ...(failure ? { failureEvidence: { version: 1, reason: "error-code-recorded", code: "AccessDenied",
                messageStatus: "text-excluded", messageSignal: "access-denial" } } : {}),
        });
        if (!failure && index % 11 === 5) {
            delete record.toolCalls[0].toolSucceeded;
            delete record.toolCalls[0].completionEventId;
            Object.assign(record.toolCalls[0], { reportedOutcome: "unknown", completedAt: null, durationMs: null, apiResults: [] });
        }

        return record;
    });
}

export function reviewRecords() {
    const records = frontendRecords();
    const models = ["gpt-5.4", "claude-sonnet-4.6", "deployment/Exact Model"];
    function modelEvidence(record, names, key) {
        return {
            version: 1, sourceSessionId: record.sourceSessionId, promptEventId: record.userPrompt.sourceEventId,
            promptMessageId: `review-message-${key}`, partial: false, ambiguous: false,
            responses: names.map((model, index) => ({
                eventId: `review-response-${key}-${index}`, apiCallId: `review-api-${key}-${index}`,
                at: new Date(Date.parse(record.capturedAt) + 60000 + index * 1000).toISOString(),
                turnId: `review-turn-${key}-${index}`, model, modelStatus: "recorded",
            })),
        };
    }
    for (const [index, record] of records.entries()) {
        record.projectId = index % 2 ? "invented-cedar" : "invented-atlas";
        const call = record.toolCalls[0];
        if (call.tool === "workiq-retrieve") {
            call.requestArgs = { query: record.userPrompt.text, capabilities: [{ name: index % 7 === 0 ? "Email" : "OneDriveAndSharePoint" }] };
            delete call.requestedApiPath;
        }
        if (index % 6) record.originalModelEvidence = modelEvidence(record,
            index % 10 === 0 ? [models[0], models[1]] : [models[index % models.length]], index);
    }
    const record = structuredClone(records[55]);
    record.scenarioId = "review-plural-activity";
    record.sourceSessionId = "invented-review-thread";
    record.sourceSessionName = "Cedar cross-service handover";
    record.title = "Review Cedar handover evidence across mail, files and calendar";
    record.capturedAt = "2026-11-16T18:00:00.000Z";
    record.userPrompt = {
        text: "Review the Cedar handover before the release decision. Find the file owners, the calendar commitments and the email decisions. "
            + "Keep each call and its returned entries separate. Preserve conflicting results, exact paths, missing durations and access errors. "
            + "A completed tool call is not proof that every returned entry succeeded, and a requested path is not a verified mapping to every result. "
            + "Keep the original dates and identify each source.",
        status: "full", sourceEventId: "review-plural-prompt", sourceTimestamp: record.capturedAt,
        authorship: { actor: "user", basis: "source-user" },
    };
    const base = record.toolCalls[0];
    const longPath = "/sites/cedar-review/drive/items/" + "regional-readiness-and-support-coverage-".repeat(7) + "notes";
    record.toolCalls = [
        { tool: "workiq-fetch", requestArgs: { entityUrls: ["/me/drive/root/children", "/me/messages"] },
            toolSucceeded: true, reportedOutcome: "succeeded", durationMs: 2305,
            apiResults: [{ index: 0, path: "/me/drive/root/children", statusCode: 200, durationMs: 90, evidenceLevel: "intermediary-reported" },
                { index: 1, path: "/me/messages", statusCode: 403, errorCode: "AccessDenied", evidenceLevel: "intermediary-reported" }] },
        { tool: "workiq-retrieve", requestArgs: { query: "Find the Cedar release owner decisions.", capabilities: [{ name: "Email" }] },
            toolSucceeded: false, reportedOutcome: "failed", durationMs: null, apiResults: [],
            failureEvidence: { version: 1, reason: "error-code-recorded", code: "ToolUnavailable", messageStatus: "text-excluded" } },
        { tool: "workiq-fetch", requestArgs: { entityUrls: [longPath, "/me/calendarView"] },
            toolSucceeded: null, reportedOutcome: "partial", durationMs: null,
            apiResults: [{ index: 0, path: longPath, statusCode: 200, evidenceLevel: "intermediary-reported" },
                { index: 1, statusCode: null, evidenceLevel: "intermediary-reported" }] },
        { tool: "workiq-fetch", requestArgs: { entityUrls: ["/me/messages"] },
            toolSucceeded: null, reportedOutcome: "unknown", durationMs: null, apiResults: [] },
    ].map((call, index) => {
        const item = { ...base, ...call, toolCallId: `review-call-${index}`, startEventId: `review-start-${index}`,
            startedAt: new Date(Date.parse(record.capturedAt) + index * 5000).toISOString() };
        delete item.requestedApiPath;
        delete item.completionEventId;
        item.completedAt = null;
        if (call.durationMs !== null) {
            item.completionEventId = `review-end-${index}`;
            item.completedAt = new Date(Date.parse(item.startedAt) + call.durationMs).toISOString();
        }
        return item;
    });
    record.originalModelEvidence = modelEvidence(record, [models[0], models[1]], "plural");
    records.push(record);
    return records;
}

export async function overviewGeometry(page) {
    return page.evaluate(() => {
        const bounds = node => {
            const box = node.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
        };
        const grid = document.querySelector(".analyze-chart-grid"), main = document.querySelector(".analyze-chart-main");
        const summary = document.querySelector(".analyze-outcome-summary"), ring = document.querySelector("#outcomeChart .percentage-ring");
        const value = document.querySelector("#outcomeChart .percentage-total-value"), unit = document.querySelector("#outcomeChart .percentage-total-unit");
        const gridStyle = getComputedStyle(grid), summaryStyle = getComputedStyle(summary);
        const measured = {
            viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
            rootFont: getComputedStyle(document.documentElement).fontSize, fonts: document.fonts.status,
            grid: bounds(grid), main: bounds(main), summary: bounds(summary), gridDisplay: gridStyle.display,
            gridBorder: { top: parseFloat(gridStyle.borderTopWidth), bottom: parseFloat(gridStyle.borderBottomWidth) },
            divider: { inline: parseFloat(summaryStyle.borderInlineStartWidth), top: parseFloat(summaryStyle.borderTopWidth) },
            headings: [...document.querySelectorAll(".percentage-card h3,.chart-heading h2")].map(node => ({
                text: node.textContent, transform: getComputedStyle(node).textTransform,
            })),
            ring: null,
        };
        if (ring?.checkVisibility() && value && unit) {
            const path = ring.querySelector(".percentage-slice"), matrix = path.getScreenCTM();
            const radii = [...path.getAttribute("d").matchAll(/A([\d.]+)\s+([\d.]+)/g)].map(match => Number(match[1]));
            const center = new DOMPoint(0, 0).matrixTransform(matrix), radius = Math.min(...radii) * Math.hypot(matrix.a, matrix.b);
            const text = node => {
                const range = document.createRange();
                range.selectNodeContents(node);
                const box = range.getBoundingClientRect();
                const reach = Math.max(...[box.left, box.right].flatMap(x => [box.top, box.bottom].map(y => Math.hypot(x - center.x, y - center.y))));
                return { text: node.textContent, font: getComputedStyle(node).fontSize, clearance: radius - reach };
            };
            measured.ring = { box: bounds(ring), radius, value: text(value), unit: text(unit) };
        }
        return measured;
    });
}
