import { graphEntityCollections } from "../lib/graph-path-vocabulary.mjs";

// Serialized into the standalone screen as well as used by the bundled renderer.
// Inputs are recorded tool IDs and normalized targets, never prose or result status.
export function createOperationIcons(entityCollections = graphEntityCollections) {
    const collections = new Set(entityCollections);
    const tools = {
        "workiq-ask":"message-circle", "workiq-retrieve":"scan-search", "workiq-fetch":"file-input",
        "workiq-fetch_blob":"binary", "workiq-call_function":"square-function", "workiq-do_action":"play",
        "workiq-create_entity":"square-plus", "workiq-update_entity":"square-pen", "workiq-delete_entity":"square-minus",
        "workiq-search_paths":"route", "workiq-get_schema":"list-tree", "workiq-list_agents":"users-round",
        "owned-graph-http":"globe",
    };
    const graph = {
        delta:["history","Change tracking"], search:["search","Search"], getByIds:["list-filter","Lookup by ID"],
        getMemberGroups:["group","Group membership lookup"], getMemberObjects:["network","Directory membership lookup"],
        getSchedule:["calendar-days","Calendar availability"], findMeetingTimes:["calendar-search","Meeting time search"],
        getMailTips:["mail-question","Recipient mail tips"], getActivitiesByInterval:["chart-column","Activity by time period"],
        getTotalFileCount:["files","File count"], getOffice365ActiveUserDetail:["user-round","Microsoft 365 user activity"],
        getOffice365ActiveUserCounts:["users","Microsoft 365 active user counts"], getEmailActivityUserDetail:["mail-search","Email activity by user"],
        getEmailActivityCounts:["file-chart-column","Email activity counts"], getTeamsUserActivityUserDetail:["message-circle-more","Teams activity by user"],
        getTeamsUserActivityCounts:["chart-bar","Teams activity counts"], getOneDriveUsageAccountDetail:["folder","OneDrive usage by account"],
        getSharePointSiteUsageDetail:["panels-top-left","SharePoint site usage"], getYammerActivityUserDetail:["message-square","Yammer activity by user"],
        getMailboxUsageDetail:["inbox","Mailbox usage"], getManagedDevicesWithAppFailures:["monitor","Devices with app failures"],
        getAllMessages:["messages-square","Message retrieval"], getAllRetainedMessages:["folder-archive","Retained message retrieval"],
        getAllTranscripts:["file-text","Transcript retrieval"], getAllRecordings:["video","Recording retrieval"],
        checkMemberGroups:["user-round-check","Group membership check"], checkMemberObjects:["list-collapse","Directory membership check"],
        validateProperties:["file-check-2","Property validation"], copy:["copy","Item copy"], move:["folder-input","Item move"],
        reply:["reply","Reply"], replyAll:["reply-all","Reply to all"], forward:["forward","Message forwarding"],
        createReply:["message-square-reply","Reply draft"], createReplyAll:["message-circle-reply","Reply-all draft"], createForward:["send-horizontal","Forward draft"],
        send:["send","Send request"], sendMail:["mail-plus","Email send request"], accept:["calendar-check","Meeting acceptance"],
        tentativelyAccept:["calendar-clock","Tentative meeting acceptance"], decline:["calendar-x","Meeting decline"], cancel:["calendar-minus","Meeting cancellation"],
        dismissReminder:["bell-off","Reminder dismissal"], snoozeReminder:["alarm-clock","Reminder snooze"],
        markAsRead:["mail-open","Marking as read"], markAsUnread:["mail","Marking as unread"],
        archive:["archive","Archiving"], unarchive:["archive-restore","Removal from archive"],
        add:["plus","Addition"], remove:["minus","Removal"], complete:["list-checks","Completion request"],
        subscribeToContent:["bell-plus","Content subscription"], unsubscribeFromContent:["bell-minus","Content unsubscription"],
        preview:["eye","Item preview"], invite:["user-plus","Sharing invitation"], createLink:["link","Sharing link creation"],
        assignLicense:["badge","License assignment"], restore:["rotate-ccw","Item restoration"], permanentDelete:["trash-2","Permanent deletion request"],
        checkout:["log-out","File checkout"], checkin:["log-in","File check-in"], refreshSession:["refresh-cw","Session refresh"],
        createSession:["file-plus-2","Session creation"], closeSession:["square-x","Session closure"], calculate:["calculator","Workbook calculation"],
        addPassword:["key-round","Password addition"], removePassword:["lock-keyhole-open","Password removal"],
        addKey:["key-square","Key addition"], removeKey:["key","Key removal"], validatePermission:["shield","Permission check"],
        publish:["upload","Publication"], unpublish:["download","Publication withdrawal"], applySensitivityLabel:["tag","Sensitivity label assignment"],
        getSensitivityLabels:["tags","Sensitivity label lookup"], extractSensitivityLabels:["list-end","Sensitivity label extraction"],
    };
    const slug = name => name.replaceAll("_","-").replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase();
    const toolRole = name => Object.hasOwn(tools,name) ? "operation-" + slug(name.replace(/^workiq-/,"")) : null;
    const purposes = {
        "workiq-retrieve": "Searches work data for matching items and passages.",
        "workiq-fetch": "Reads items or lists from the requested API paths.",
        "workiq-ask": "Asks Copilot or a selected agent for an answer.",
        "workiq-search_paths": "Finds available API paths for an operation.",
        "workiq-get_schema": "Looks up the inputs and outputs for an operation without running it.",
        "workiq-list_agents": "Lists available Copilot agents.",
        "workiq-fetch_blob": "Reads file or attachment content from a requested path.",
        "workiq-call_function": "Calls a read-only API function.",
        "workiq-do_action": "Requests an action at an API path.",
        "workiq-create_entity": "Requests a new item in a collection.",
        "workiq-update_entity": "Requests changes to an existing item.",
        "workiq-delete_entity": "Requests removal of an item.",
    };
    const toolPurpose = name => Object.hasOwn(purposes, name) ? purposes[name] : null;
    const graphRole = name => "operation-graph-" + slug(name);
    const sources = Object.freeze({
        ...Object.fromEntries(Object.entries(tools).map(([k,v]) => [toolRole(k),v])),
        ...Object.fromEntries(Object.entries(graph).map(([k,[glyph]]) => [graphRole(k),glyph])),
        "operation-exchange-id-conversion":"arrow-right-left",
    });
    function pathOperations(row, layer) {
        // A schema path is a discovery subject and a returned path is not a second invocation.
        if (layer !== "tool" || !["workiq-do_action","workiq-call_function"].includes(row?.tool)) return [];
        const operations = new Map();
        for (const target of row.targets?.length ? row.targets : [row.endpoint]) {
            const path = target?.path;
            if (typeof path !== "string" || !path.startsWith("/")) continue;
            const tail = path.slice(path.lastIndexOf("/") + 1);
            const name = /^(?:microsoft\.graph\.)?([a-zA-Z][a-zA-Z0-9]*)(?:\([^/]*\))?$/.exec(tail)?.[1];
            // A bare token at an entity-key position can be the literal ID, not an operation.
            if (tail === name && collections.has(path.split("/").at(-2))) continue;
            if (name && Object.hasOwn(graph,name)) {
                operations.set(name, {label:graph[name][1], operationRole:graphRole(name)});
            }
        }
        return [...operations.values()];
    }
    return { sources, toolRole, toolPurpose, pathOperations };
}
