import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

function candidates(env = process.env, platform = process.platform) {
    if (env.WIRE_PDF_BROWSER) return [env.WIRE_PDF_BROWSER];
    if (platform === "darwin") {
        return ["Microsoft Edge", "Google Chrome", "Chromium"].flatMap(name =>
            ["/Applications", path.join(os.homedir(), "Applications")].map(base => path.join(base, `${name}.app`, "Contents", "MacOS", name)));
    }
    if (platform === "win32") {
        const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
        return roots.flatMap(root => [path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
            path.join(root, "Google", "Chrome", "Application", "chrome.exe")]);
    }
    const names = ["microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
    return (env.PATH ?? "").split(path.delimiter).filter(Boolean).flatMap(directory => names.map(name => path.join(directory, name)));
}

export async function findPdfBrowser(options) {
    for (const file of candidates(options?.env, options?.platform)) {
        try { await access(file, constants.X_OK); return file; } catch {}
    }
    return null;
}

// A minimal DevTools-protocol session over --remote-debugging-pipe; no port is opened.
export async function openBrowserPage(executable, { timeoutMs = 60000 } = {}) {
    const profile = await mkdtemp(path.join(os.tmpdir(), "wire-pdf-"));
    const child = spawn(executable, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
        "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-default-apps",
        "--disable-background-networking", "--disable-component-update", "--mute-audio", "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
    const pending = new Map(), listeners = new Set();
    let nextId = 0, buffer = "", failure = null;
    const fail = error => {
        failure ??= error;
        for (const { reject } of pending.values()) reject(failure);
        pending.clear();
    };
    const timer = setTimeout(() => { fail(new Error("PDF browser timed out.")); child.kill(); }, timeoutMs);
    child.once("error", fail);
    child.once("exit", () => fail(new Error("PDF browser exited.")));
    child.stdio[3].on("error", fail);
    child.stdio[4].on("data", chunk => {
        buffer += chunk.toString("utf8");
        let end;
        while ((end = buffer.indexOf("\0")) >= 0) {
            const message = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            if (message.id !== undefined && pending.has(message.id)) {
                const { resolve, reject } = pending.get(message.id);
                pending.delete(message.id);
                message.error ? reject(new Error(message.error.message)) : resolve(message.result);
            } else for (const listener of listeners) listener(message);
        }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
    async function close() {
        clearTimeout(timer);
        if (child.exitCode === null && !failure) await Promise.race([send("Browser.close").catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
        if (child.exitCode === null) {
            const exited = new Promise(resolve => child.once("exit", resolve));
            child.kill();
            await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
        }
        await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
    try {
        const { targetId } = await send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
        const page = (method, params) => send(method, params, sessionId);
        return { page, sessionId, onEvent: listener => listeners.add(listener), close };
    } catch (error) {
        await close();
        throw error;
    }
}
