// Serialized into the shell; service wording comes from the shared category glossary.
export function createControlHelp(categories) {
    const glossary = Object.freeze({
        accuracy: Object.freeze({ label: "Accuracy", definition: "Did the answer meet the request? Separately approved model assessments check recorded evidence; your optional feedback stays separate. Passed divided by passed plus failed, with assessed interaction coverage. Tool success is not answer correctness." }),
        speed: Object.freeze({ label: "Speed", definition: "Tool calls: call start to recorded completion. Final response: recorded request to final response, not tool-call time. Values are medians (middle recorded times), shown in seconds. Exact milliseconds remain in the details. Coverage counts timed calls or requests separately." }),
        trust: Object.freeze({ label: "Trust", definition: "Two separate checks: support for the answer and alignment of actions with recorded intent. Model assessment is not independent ground truth or proof of authorization. Personal feedback remains separate." }),
        "answer-trust": Object.freeze({ label: "Answer trust", definition: "Is there evidence supporting the answer? Having an answer or a citation alone does not verify it." }),
        "action-trust": Object.freeze({ label: "Action trust", definition: "Model assessments check whether actions align with recorded intent, not whether a person authorized them. Personal authorization feedback is a separate verdict. Tool success or an accepted HTTP request proves neither." }),
        coverage: Object.freeze({ label: "Coverage", definition: "How many included items have the evidence needed for a measure. For example, 8 / 10 timed means two calls have no usable timing." }),
        unassessed: Object.freeze({ label: "Unassessed", definition: "No supported verdict is available. This is neither a pass nor a failure. The nearby explanation says what is missing; personal feedback remains optional." }),
    });
    const layers = Object.freeze({
        tool: "Recorded Work IQ tool attempts; a successful tool result does not prove the whole task was correct.",
        "direct-request": "Graph request sites found in recorded commands or invocations, not measured network calls or proof that a response arrived.",
        "recorded-http": "Request sites with an HTTP response status visible in history; these are a subset of recorded Graph request sites, not extra requests.",
        "reported-api": "API results returned by a Work IQ tool, not directly observed responses; one call may return several results, and some calls have none.",
        http: "Network request and response records from the explicitly instrumented HTTP recorder, not all Office work or hidden Work IQ traffic.",
        "code-reference": "Graph paths found in recorded code; references alone do not establish that a request ran or a response arrived.",
    });
    const options = Object.freeze({
        dateFilter: Object.freeze({
            capture: "Use the selected collection without an additional date limit; this does not collect new history.",
            "7": "Today and the preceding six calendar days in the display time zone, not the last seven days present in the collection.",
            "30": "Today and the preceding 29 calendar days in the display time zone, not the last 30 days present in the collection.",
            custom: "Choose From and To, then Apply dates; both boundary days are included in the display time zone.",
        }),
        layerFilter: layers,
        bucketFilter: Object.freeze({
            day: "Group dated records by local calendar day; daylight-saving changes can make a day shorter or longer than 24 hours.",
            week: "Group dated records into Monday-starting calendar weeks; the current date filters still apply.",
            month: "Group dated records by calendar month; the current date filters still apply.",
        }),
        scopeFilter: Object.freeze({
            history: "Use collected current-history records; this is not a live feed or a new history scan.",
            legacy: "Use the preserved earlier snapshot only; it may be incomplete and is not refreshed by changing this choice.",
            all: "Include current activity and preserved records together, counting identifiable overlapping evidence once.",
        }),
    });
    const fields = Object.freeze({
        layerFilter: "Work IQ calls, returned API entries, Graph call sites, Graph statuses, recorder captures and code references are separate views. They overlap; do not add their counts.",
        scopeFilter: "Choose the source collection for this view; changing it does not import history or alter preserved evidence.",
        bucketFilter: "Change calendar grouping, not the activity, result or date filters; undated records cannot appear on the time chart.",
        activitySearch: "Find a phrase in retained prompt text, titles, project names or GitHub Copilot chat names in the current filters, before paging. Case and punctuation are ignored. The phrase stays in this browser, out of URLs. Escape or Clear search restores the unsearched list.",
    });
    const charts = Object.freeze({
        time: "Compare the selected activity's counts over time; records without dates are not plotted, and a period with no records is not proof that no work happened.",
        workload: "Compare the same selected activity by service; color names the service, and labels retain exact recorded counts.",
        activityCategory: "Compare tool calls by activity category: data-service targets or preparatory Discovery. Categories do not describe hidden downstream traffic or whether a call worked.",
        endpoint: "Compare the same selected activity by normalized API path; one multi-target Work IQ call remains one call, not one count per path.",
    });
    const reportScopes = Object.freeze({
        all: "Every eligible collected group, including preserved evidence. View filters and private search do not limit it. No new scan.",
        current: "Groups matching your filters and private search across all pages, with each group's full eligible evidence.",
        selected: "Only groups you selected, including those hidden by browsing filters.",
    });
    const actions = Object.freeze({
        refreshBtn: "Read the latest stored data without checking source history or reloading the app. Filters and report selections stay.",
        checkActivity: "Read new calls and results from approved local Copilot history.",
        resetView: "Clear browsing filters, private search, chat/request scope and the outer page. Return to all retained dates and Home's weekly Work IQ chart. Report selections/options, review labels and theme stay.",
        importBtn: "Read the approved, mapped local history sources again and update the collection; missing or excluded history stays explicitly unverified.",
        recordBtn: "Optional HTTP recorder test. Sends one public Graph request after confirmation; saves its outcome locally, separately from workplace activity.",
        exportBtn: "Prepare report files in memory for local review; no files are saved until disclosure review and final confirmation.",
        download: "Download another copy of an already saved report; it keeps that report's reviewed content and prompt mode, not your current choices.",
        selectRequest: "Choose this request group for a report; selection does not change recorded results or review labels.",
        removeRequest: "Remove this request from the report selection only; its evidence and previously saved reports remain.",
        review: "Change only this request's review label; this does not certify correctness, grant disclosure approval or make it eligible for export.",
        showAll: "Show the categories grouped under Other separately; the selected evidence and its total do not change.",
        clipboard: "Copy exactly the displayed text to your system clipboard; export masking is not applied by this action.",
    });
    const notices = Object.freeze({
        clipboard: "Original prompts and recorded arguments are private. Copy places the displayed text on your system clipboard, where other apps may access it; export masking is not applied.",
        download: "Downloads keep the prompt mode and reviewed content of the saved report. Changing today's report choices does not change older files.",
        followup: "A nearby follow-up prompt is an inferred association, not proof that it caused or evaluated these actions.",
        requestJourney: "This journey shows all retained actions for the request group, not only actions matching the current chart filters.",
    });
    const reviewStates = Object.freeze({
        captured: "No review label has been advanced for this request; this does not block a report's separate disclosure review.",
        reviewing: "Marked as being reviewed; recorded results and report eligibility are unchanged.",
        ready_to_export: "Marked ready by a review-label action, not privacy-approved; every export still requires its own disclosure review.",
        exported: "A retained label from an earlier export; it is not reusable disclosure approval for a new report.",
    });
    const facts = Object.freeze({
        "Execution success": "The tool's recorded completion flag, not a judgment about whether the user's task was completed correctly.",
        "HTTP observed": "Yes only for an owned HTTP capture; Work IQ can use Office services without exposing its downstream network traffic here.",
        "Result attribution": "How this result was recorded: tool-returned metadata, visible output and owned HTTP captures are different evidence sources.",
        "Parent invocation": "The recorded invocation containing this tool call, when available; grouping does not establish causal intent.",
        "Parallel group": "Calls associated with the same recorded parallel group, not a measured overlap or dependency guarantee.",
        "Snapshot revision": "The local collection version used for this view; a new version invalidates a previously prepared report review.",
        "Tool outcome": "The tool's retained outcome label, separate from the HTTP status and from whole-task correctness.",
        "Tool call ID": "The recorded identifier of this tool attempt; together with its source Copilot chat it distinguishes calls that share a tool name.",
        "Duration": "Recorded elapsed milliseconds for this action when available, not total task time; missing duration is not zero.",
        "Reported status": "A network response status returned by the tool, not an independently observed HTTP response.",
        "Reported error": "An error code retained from a tool-returned API result, not a judgment about the whole request.",
        "Provenance": "Where the retained prompt came from; a recorded user-message event is not by itself proof that a human authored it.",
        "Status": "Whether the prompt was retained fully, partially or not at all; unavailable text is never reconstructed.",
        "Source event": "The source log event linked to this text; an event identifier is not a timestamp or proof of human authorship.",
        "Copilot chat ID": "The recorded GitHub Copilot chat containing this request group, not a project or an individual tool call. Technical records retain the sourceSessionId field.",
        "GitHub Copilot project": "Copilot's project context for this conversation, not necessarily a GitHub repository.",
        "Prompt association": "How actions were linked to nearby recorded messages; proximity does not prove intent or causality.",
        "Coverage": "Known limits of the retained evidence, not proof that all actions or downstream traffic were observed.",
        "Assessment": "A retained interpretation of the evidence, separate from measured tool results and HTTP statuses.",
        "Collection": "The source collection selected for this view; choosing it does not collect or modify evidence.",
        "Coverage checked": "When source coverage was checked, not when the displayed work occurred or proof that collection is complete.",
        "Request groups": "Groups of retained actions associated with a recorded request; a group is not one tool call or proof of a completed task.",
        "Copilot chats without a project": "Recorded GitHub Copilot chats without an associated project; missing project context does not exclude their evidence.",
        "Sources scanned": "Mapped sources inspected by the collection's Graph scan, not chats guaranteed to contain Graph traffic.",
        "Request sites": layers["direct-request"],
        "Visible statuses": layers["recorded-http"],
        "Code references": layers["code-reference"],
        "Synthetic refs excluded": "Known example or test references excluded from the collection scan's activity evidence.",
    });
    function resultMeaning(key, layer = "tool") {
        if (layer === "code-reference") return "Execution was not observed.";
        return ({
            success: layer === "tool" ? "The tool completed successfully." : "An HTTP 2xx response was recorded.",
            failure: layer === "tool" ? "The tool reported a failure." : layer === "reported-api" ? "An HTTP 4xx/5xx status or an error code was returned." : "An HTTP 4xx/5xx response was recorded.",
            unknown: "No usable result was retained; this is not evidence of success or failure.",
            partial: "The tool reported partial, not complete, success.",
            other: "An informational (1xx) or redirect (3xx) HTTP status was recorded.",
            transport: "The HTTP recorder recorded a connection failure without a response.",
        })[key] || "";
    }
    function resultHelp(key, layer = "tool") {
        if (layer === "code-reference") return "Code references do not have execution results; a result filter does not establish that the code ran.";
        if (key === "success") return layer === "tool"
            ? "The recorded tool completed successfully; this does not establish that your request was answered correctly."
            : "A 2xx response status was recorded in this evidence layer; this does not establish whole-task correctness.";
        return ({
            failure: layer === "tool"
                ? "The tool recorded a failure, not necessarily a failure of the whole request."
                : layer === "reported-api" ? "The tool returned a 4xx/5xx status or an error code; other actions in the request may have worked."
                    : "A 4xx or 5xx response status was recorded; this is not the outcome of the whole request.",
            unknown: "No usable completion or result status was retained in this evidence layer; missing evidence is not success or failure.",
            partial: "The tool reported a partial outcome rather than complete success; the wider task result remains unverified.",
            other: "A result was recorded outside success or failure, such as an informational 1xx or redirect 3xx status.",
            transport: "The owned recorder retained a connection failure without a response; the whole request's final outcome remains unverified.",
        })[key] || "";
    }
    function describeOption({ id, value }, { layer = "tool" } = {}) {
        if (id === "serviceFilter") {
            if (value === "all") return `${layer === "tool" ? "Keep every activity category, including preparatory Discovery" : "Keep every service category allowed in this activity view"}; hidden platform diagnostics remain separate from ordinary Office activity.`;
            const category = categories.entries.find((entry) => entry.id === value || entry.label === value);
            return category ? category.description : "This service value is not recognized; use Reset to Home to choose a supported category.";
        }
        if (id === "projectFilter") return value === "all"
            ? "Keep records from all Copilot projects and Copilot chats without a project."
            : value === "unscoped" ? "Only records without a Copilot project; these are not missing or failed requests."
                : "Records associated with this Copilot project, which is not necessarily a GitHub repository.";
        if (id === "outcomeFilter") return value === "all"
            ? "Keep every recorded result in this activity layer, including unknown results. Menu counts are before result filtering; other filters still apply. Tool results do not establish whole-task correctness."
            : resultHelp(value, layer) || "This result value is not recognized; use Reset to Home to choose a supported result.";
        if (!Object.hasOwn(options, id)) return "";
        return options[id][value] || "This selection is not recognized; use Reset to Home to choose a supported option.";
    }
    function categoryGuide(values, layer = "tool") {
        const entries = categories.used(values);
        const distinctions = {
            Discovery: "Discovery: API, schema or agent lookup, not data execution.",
            Search: "Search and retrieval: may span sources.",
            "Multiple workloads": "More than one service: one call, different services.",
            Unknown: "Service not shown: insufficient service evidence, not failure.",
            "Platform metadata": "Platform diagnostics: metadata or batch endpoints, not each batch operation.",
        };
        const services = entries.filter(entry => !Object.hasOwn(distinctions, entry.id));
        return [
            services.length ? `${services.map(entry => entry.label).join(", ")} ${services.length === 1 ? "names" : "name"} recorded service targets, not hidden traffic.` : "Categories follow recorded targets and tool metadata.",
            ...entries.filter(entry => entry.id !== "Discovery" || layer === "tool").map(entry => distinctions[entry.id]).filter(Boolean),
        ].join(" ");
    }
    const failureEvidence = Object.freeze({
        unknown: "Failure cause unavailable in retained evidence. WIRE cannot establish whether the source omitted it or earlier collection excluded it.",
        "error-details-excluded": "Error details were excluded by WIRE's metadata-only collection; no supported error code was retained.",
        "result-content-excluded": "Completion text was excluded by WIRE's metadata-only collection; no structured error code was available.",
        "no-structured-error": "The source completion records failure but provides no supported structured error code.",
        "unsupported-error-format": "The source error format is not supported by WIRE's metadata-only collector.",
    });
    const failureMessageStatus = Object.freeze({
        "not-supplied": "No typed error message was supplied with this completion.",
        "unsupported-format": "The error message was in an unsupported format; it was not retained.",
        "size-excluded": "The error message exceeded the 8 KiB inspection limit; it was not inspected for a message signal or retained.",
        "sensitive-excluded": "The error message matched credential screening; it was not retained or used for a message signal.",
        "text-excluded": "Error prose is not retained. A message signal, when shown, describes wording in the tool error, not a verified cause, access policy, authorization or observed HTTP response. Stack traces and response bodies are excluded.",
    });
    const invocationAbsence = Object.freeze({
        parentSource: { label: "Not supplied by source", help: "The collected start event had no parentToolCallId field value. This does not establish that the call had no parent." },
        unknownParent: { label: "Unavailable in retained evidence", help: "No parent identifier is retained. WIRE cannot establish whether the source omitted it or an earlier collection format excluded it; this does not mean there was no parent." },
        parallelAdapter: { label: "Not collected by this adapter", help: "The Copilot history adapter does not collect parallel-group identifiers. This is a WIRE collection limit, not evidence that the calls ran serially; overlap is not inferred as a group." },
        unknownParallel: { label: "Unavailable in retained evidence", help: "No parallel-group identifier is retained, and WIRE cannot establish why it is absent. Missing grouping does not mean the call was not parallel." },
    });
    return Object.freeze({ glossary, layers, options, fields, charts, reportScopes, actions, notices, reviewStates, facts, failureEvidence, failureMessageStatus, invocationAbsence, resultMeaning, resultHelp, describeOption, categoryGuide });
}
