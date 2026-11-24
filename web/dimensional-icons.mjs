import { lucideIcon } from "./ux-icons.mjs";
import { serviceIconRole, serviceIconSources } from "./icon-roles.mjs";
export const dimensionalIcons = Object.freeze(Object.fromEntries(Object.entries(serviceIconSources).map(([service, name]) => [
    service, lucideIcon(name, 24, serviceIconRole(service)),
])));
