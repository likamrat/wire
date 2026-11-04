import { execFileSync } from "node:child_process";
import { realpathSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BoardError } from "./store.mjs";

const windowsDrive = value => typeof value === "string" && /^[a-z]:[\\/]/i.test(value);
const drvfsType = 0x01021997;
const unavailable = () => Object.assign(new BoardError(
    "This Windows location cannot be verified on this host. No foreign or linked location was used.", 422),
{ code: "host_path_unavailable" });

export function createHostPaths({ platform = process.platform, release = os.release(),
    realpath = realpathSync, statfs = statfsSync,
    translate = (direction, value) => execFileSync("wslpath", ["-a", direction, value], {
        encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
    }) } = {}) {
    const native = platform === "win32" ? path.win32 : path.posix;
    const wsl = platform === "linux" && /microsoft/i.test(release);
    const foreign = value => wsl && windowsDrive(value);
    function describe(value) {
        if (typeof value !== "string" || /[\u0000-\u001f]/.test(value)) throw unavailable();
        const syntax = foreign(value) ? path.win32 : native;
        return { absolute: syntax.isAbsolute(value), name: syntax.basename(value),
            directory: syntax.dirname(value), foreignWindows: foreign(value) };
    }
    function converted(direction, value) {
        let output;
        try { output = translate(direction, value); }
        catch (error) { throw Object.assign(unavailable(), { cause: error }); }
        if (typeof output !== "string") throw unavailable();
        output = output.replace(/\r?\n$/, "");
        if (!output || /[\u0000-\u001f]/.test(output)) throw unavailable();
        return output;
    }
    function checkedWindows(value) {
        if (!windowsDrive(value) || value.split(/[\\/]/).some(part => part === "." || part === "..")
            || /[\u0000-\u001f]/.test(value)) throw unavailable();
        return path.win32.resolve(value);
    }
    function existingAncestor(value) {
        let current = native.resolve(value);
        for (;;) {
            try {
                if (native.resolve(realpath(current)) !== current) throw unavailable();
                return current;
            } catch (error) {
                if (error.code !== "ENOENT") throw Object.assign(unavailable(), { cause: error });
                const parent = native.dirname(current);
                if (parent === current) throw unavailable();
                current = parent;
            }
        }
    }
    function filesystemType(value) {
        try {
            const type = Number(statfs(value).type);
            if (!Number.isSafeInteger(type)) throw unavailable();
            return type;
        } catch (error) { throw Object.assign(unavailable(), { cause: error }); }
    }
    function qualify(nativePath, windowsPath) {
        const logical = checkedWindows(windowsPath);
        if (!path.posix.isAbsolute(nativePath)) throw unavailable();
        const normalized = path.posix.resolve(nativePath), ancestor = existingAncestor(normalized);
        if (filesystemType(ancestor) !== drvfsType) throw unavailable();
        const returned = converted("-u", logical);
        if (!path.posix.isAbsolute(returned) || path.posix.resolve(returned) !== normalized
            || checkedWindows(converted("-w", normalized)).toLowerCase() !== logical.toLowerCase()) {
            throw unavailable();
        }
        return normalized;
    }
    function local(value) {
        const info = describe(value);
        if (!info.absolute) throw unavailable();
        if (!info.foreignWindows) return native.resolve(value);
        const logical = checkedWindows(value);
        const result = qualify(converted("-u", logical), logical);
        try { if (native.resolve(realpath(result)) !== result) throw unavailable(); }
        catch (error) { throw Object.assign(unavailable(), { cause: error }); }
        return result;
    }
    function stored(value) {
        if (!describe(value).absolute || foreign(value)) throw unavailable();
        const normalized = native.resolve(value);
        if (!wsl) return normalized;
        const ancestor = existingAncestor(normalized);
        if (filesystemType(ancestor) !== drvfsType) return normalized;
        const logical = checkedWindows(converted("-w", normalized));
        qualify(normalized, logical);
        return logical;
    }
    function same(nativePath, registeredPath) {
        const registered = describe(registeredPath);
        if (!registered.absolute) return false;
        if (registered.foreignWindows) {
            const logical = stored(nativePath);
            return windowsDrive(logical) && logical.toLowerCase() === checkedWindows(registeredPath).toLowerCase();
        }
        const left = native.resolve(nativePath), right = native.resolve(registeredPath);
        return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
    }
    return Object.freeze({ describe, local, stored, same });
}

export const hostPaths = createHostPaths();
