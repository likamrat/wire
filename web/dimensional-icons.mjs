import { lucideIcon } from "./ux-icons.mjs";

const services = {
    Mail: "mail", Calendar: "calendar", Files: "folder", Teams: "users-round",
    People: "user-round", Tasks: "list-todo", Notes: "notebook", Directory: "network",
    Search: "search", Discovery: "book-open", "Multiple workloads": "grid-2x2", "Platform metadata": "code-xml", Unknown: "circle-question-mark",
    "group:other": "layout-grid",
    Assistance: "message-circle",
};

export const dimensionalIcons = Object.freeze(Object.fromEntries(Object.entries(services).map(([service, name]) => [
    service, lucideIcon(name, 24),
])));
