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
        delta:"history", search:"search", getByIds:"list-filter", getMemberGroups:"group", getMemberObjects:"network",
        getSchedule:"calendar-days", findMeetingTimes:"calendar-search", getMailTips:"mail-question", getActivitiesByInterval:"chart-column",
        getTotalFileCount:"files", getOffice365ActiveUserDetail:"user-round", getOffice365ActiveUserCounts:"users",
        getEmailActivityUserDetail:"mail-search", getEmailActivityCounts:"file-chart-column", getTeamsUserActivityUserDetail:"message-circle-more",
        getTeamsUserActivityCounts:"chart-bar", getOneDriveUsageAccountDetail:"folder", getSharePointSiteUsageDetail:"panels-top-left",
        getYammerActivityUserDetail:"message-square", getMailboxUsageDetail:"inbox", getManagedDevicesWithAppFailures:"monitor",
        getAllMessages:"messages-square", getAllRetainedMessages:"folder-archive", getAllTranscripts:"file-text", getAllRecordings:"video",
        checkMemberGroups:"user-round-check", checkMemberObjects:"list-collapse", validateProperties:"file-check-2",
        copy:"copy", move:"folder-input", reply:"reply", replyAll:"reply-all", forward:"forward",
        createReply:"message-square-reply", createReplyAll:"message-circle-reply", createForward:"send-horizontal",
        send:"send", sendMail:"mail-plus", accept:"calendar-check", tentativelyAccept:"calendar-clock",
        decline:"calendar-x", cancel:"calendar-minus", dismissReminder:"bell-off", snoozeReminder:"alarm-clock",
        markAsRead:"mail-open", markAsUnread:"mail", archive:"archive", unarchive:"archive-restore",
        add:"plus", remove:"minus", complete:"list-checks", subscribeToContent:"bell-plus", unsubscribeFromContent:"bell-minus",
        preview:"eye", invite:"user-plus", createLink:"link", assignLicense:"badge", restore:"rotate-ccw",
        permanentDelete:"trash-2", checkout:"log-out", checkin:"log-in", refreshSession:"refresh-cw",
        createSession:"file-plus-2", closeSession:"square-x", calculate:"calculator", addPassword:"key-round",
        removePassword:"lock-keyhole-open", addKey:"key-square", removeKey:"key", validatePermission:"shield",
        publish:"upload", unpublish:"download", applySensitivityLabel:"tag", getSensitivityLabels:"tags", extractSensitivityLabels:"list-end",
    };
    const slug = name => name.replaceAll("_","-").replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase();
    const toolRole = name => Object.hasOwn(tools,name) ? "operation-" + slug(name.replace(/^workiq-/,"")) : null;
    const graphRole = name => "operation-graph-" + slug(name);
    const sources = Object.freeze({
        ...Object.fromEntries(Object.entries(tools).map(([k,v]) => [toolRole(k),v])),
        ...Object.fromEntries(Object.entries(graph).map(([k,v]) => [graphRole(k),v])),
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
                const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
                operations.set(name, {label:words[0].toUpperCase() + words.slice(1).toLowerCase(), operationRole:graphRole(name)});
            }
        }
        return [...operations.values()];
    }
    return { sources, toolRole, pathOperations };
}
