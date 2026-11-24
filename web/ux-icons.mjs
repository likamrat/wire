import assets from "../assets/react-icons-lucide.json" with { type: "json" };
import { uxIconSources, iconSize } from "./icon-roles.mjs";
export { uxIconSources } from "./icon-roles.mjs";

export const lucideLicense = assets.license;

export function lucideIcon(name, size = 20, role = name) {
    if (!Object.hasOwn(assets.glyphs, name)) throw new TypeError(`Unknown React Icons glyph: ${name}`);
    if (![16, 20, 24].includes(size) || !/^[a-z0-9][a-z0-9:-]*$/.test(role)) throw new TypeError("Invalid icon size or role");
    return assets.glyphs[name].replaceAll("WIRE_SIZE", String(size)).replace("WIRE_ROLE", role);
}

export const uxIcons = Object.freeze(Object.fromEntries(Object.entries(uxIconSources)
    .map(([role, name]) => [role, lucideIcon(name, iconSize(role), role)])));
