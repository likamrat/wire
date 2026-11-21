import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { assertSameCanvasAdapter } from "../lib/update-source.mjs";

test("an unchanged extension entry cannot mask changed imported code or on-disk canvas artwork", async t => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "wire-adapter-"));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const [installed, staged] = ["installed","staged"].map(dir => path.join(temp, dir));
    for (const dir of [installed, staged]) {
        await mkdir(path.join(dir, "lib"), { recursive: true });
        await mkdir(path.join(dir, "assets"));
        await writeFile(path.join(dir, "extension.mjs"), 'import {render} from "./lib/canvas.mjs"; globalThis.render=render;');
        await writeFile(path.join(dir, "lib/canvas.mjs"), 'import {readFileSync} from "node:fs"; export const render=()=>readFileSync(new URL("../assets/icon.svg",import.meta.url),"utf8");');
        await writeFile(path.join(dir, "assets/icon.svg"), "<svg/>");
    }
    await assertSameCanvasAdapter(installed, staged);
    await writeFile(path.join(staged, "assets/icon.svg"), "<svg>different</svg>");
    await assert.rejects(assertSameCanvasAdapter(installed, staged), /canvas.*manually/i);
    await writeFile(path.join(staged, "assets/icon.svg"), "<svg/>");
    await writeFile(path.join(staged, "lib/canvas.mjs"), 'export const render=()=>"new";');
    await assert.rejects(assertSameCanvasAdapter(installed, staged), /canvas.*manually/i);
});
