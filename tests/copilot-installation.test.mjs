import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { privateFixture } from "./helpers.mjs";
import { resolveCopilotInstallation } from "../lib/copilot-installation.mjs";

test("historical installation resolver stays filesystem-only and strict", async t => {
    const { context } = await privateFixture(t), local = path.join(context.dataDir, "invented-installation");
    const sdkPath = path.join(local, "Programs", "GitHub Copilot", "copilot-sdk", "index.js");
    const cliPath = path.join(local, "Microsoft", "WinGet", "Links", "copilot.exe");
    for (const file of [sdkPath, cliPath]) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "NON-EXECUTABLE SYNTHETIC FIXTURE; NEVER LAUNCH");
    }
    const environment = { LOCALAPPDATA: local };
    assert.deepEqual(await resolveCopilotInstallation(environment), { sdkPath, cliPath });
    for (const [value, suffix] of [["", "path-invalid"], ["relative", "path-invalid"], [local, "not-file"], [path.join(local, "absent"), "unavailable"]]) {
        for (const kind of ["sdk", "cli"]) await assert.rejects(resolveCopilotInstallation({
            ...environment, ["WORKIQ_EVIDENCE_COPILOT_" + kind.toUpperCase()]: value,
        }), error => error.code === `copilot-${kind}-${suffix}`);
    }
    await assert.rejects(resolveCopilotInstallation({ ...environment, COPILOT_PROVIDER_TEST: "invented" }),
        error => error.code === "copilot-provider-unapproved");
});
