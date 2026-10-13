import { fluentIcon } from "./ux-icons.mjs";

const services = {
    Mail: "mail", Calendar: "calendar", Files: "folder", Teams: "people_team",
    People: "person", Tasks: "task_list_ltr", Notes: "notebook", Directory: "organization",
    Search: "search", Discovery: "book_search", "Multiple workloads": "grid", "Platform metadata": "code", Unknown: "question_circle",
    "group:other": "apps_list",
};

export const dimensionalIcons = Object.freeze(Object.fromEntries(Object.entries(services).map(([service, name]) => [
    service, fluentIcon(name, 24),
])));
