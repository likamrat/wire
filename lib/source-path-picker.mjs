import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { BoardError } from "./store.mjs";

const run = promisify(execFile);
const unavailable = detail => new BoardError(`${detail} Enter the path directly. No source settings changed.`, 503);

// The host owns the dialog. The browser supplies only the field, never a command or a directory to list.
export async function pickSourcePath(field, signal) {
    if (!["appDbPath", "sessionRoot"].includes(field)) throw new BoardError("Choose a metadata database or chat history folder.", 422);
    const file = field === "appDbPath";
    const title = file ? "Choose the Copilot metadata database" : "Choose the Copilot chat history folder";
    let executable, args;
    if (process.platform === "win32") {
        executable = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const choose = file
            ? `$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = '${title}'; $d.Filter = 'Copilot metadata (data.db)|data.db'; $d.RestoreDirectory = $true; try { if ($d.ShowDialog($owner) -eq 'OK') { [Console]::WriteLine($d.FileName) } } finally { $d.Dispose() }`
            // Filesystem folders only, with a path edit box and no New folder action.
            : `$shell = New-Object -ComObject Shell.Application; $d = $shell.BrowseForFolder($owner.Handle.ToInt32(), '${title}', 0x251, 0); if ($d) { [Console]::WriteLine($d.Self.Path) }`;
        // With a hidden helper console, an ownerless shell dialog can inherit the initial hidden-window state.
        args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command",
            `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);
             Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::EnableVisualStyles();
             $owner = New-Object System.Windows.Forms.Form; $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.StartPosition = 'CenterScreen';
             try { $owner.Show(); ${choose} } finally { $owner.Dispose() }`];
    } else if (process.platform === "darwin") {
        executable = "/usr/bin/osascript";
        args = ["-e", `try\nreturn POSIX path of (choose ${file ? "file" : "folder"} with prompt "${title}")\non error number -128\nreturn ""\nend try`];
    } else if (process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
        executable = "/usr/bin/zenity";
        args = ["--file-selection", `--title=${title}`, file ? "--file-filter=data.db" : "--directory"];
    } else throw unavailable("WIRE has no desktop picker on this host.");
    let output;
    try {
        ({ stdout: output } = await run(executable, args, { signal, timeout: 120000, windowsHide: true, maxBuffer: 128 * 1024 }));
    } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error.killed) throw unavailable("The source picker timed out.");
        if (process.platform === "linux" && error.code === "ENOENT") throw unavailable("The WIRE host doesn't have the Zenity file picker.");
        if (process.platform === "linux" && error.code === 1 && !error.stderr?.trim()) return null;
        throw unavailable(`WIRE couldn't open the ${file ? "file" : "folder"} picker (${error.code ?? "dialog error"}).`);
    }
    const selected = output.replace(/\r?\n$/, "");
    if (!selected) return null;
    if (!path.isAbsolute(selected) || /[\u0000-\u001f]/.test(selected)) throw unavailable("The picker didn't return a usable local path.");
    return selected;
}
