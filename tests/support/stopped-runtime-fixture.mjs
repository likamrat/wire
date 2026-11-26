import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

export async function stoppedRuntimePid(t) {
    if (process.platform !== "win32") {
        const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
        assert.equal(exited.status, 0);
        return exited.pid;
    }
    // Windows may reuse a PID as soon as its last handle closes. Hold the actual
    // exited process object until this test (including its maintenance CLI) finishes.
    const script = `
        $ErrorActionPreference = 'Stop'
        $child = New-Object System.Diagnostics.Process
        try {
            $child.StartInfo.FileName = $env:WIRE_FIXTURE_NODE
            $child.StartInfo.Arguments = '-e "void 0"'
            $child.StartInfo.UseShellExecute = $false
            [void]$child.Start()
            $handle = $child.SafeHandle
            $child.WaitForExit()
            if ($child.ExitCode -ne 0 -or $handle.IsClosed) { throw 'Fixture child did not exit normally' }
            [Console]::WriteLine($child.Id)
            [void][Console]::ReadLine()
        } finally { $child.Dispose() }`;
    const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["pipe", "pipe", "inherit"], windowsHide: true, env: { ...process.env, WIRE_FIXTURE_NODE: process.execPath },
    });
    const closed = once(holder, "close");
    const lines = createInterface({ input: holder.stdout });
    t.after(async () => {
        holder.stdin.end();
        assert.equal((await closed)[0], 0);
    });
    const [line] = await Promise.race([once(lines, "line"), closed.then(() => { throw Error("Stopped fixture PID not received"); })]);
    assert.match(line, /^[1-9]\d*$/);
    const pid = Number(line);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    return pid;
}
