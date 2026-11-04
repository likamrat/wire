import test from "node:test";
import assert from "node:assert/strict";
import { createHostPaths } from "../lib/host-paths.mjs";

function wsl(overrides = {}) {
    const calls = [];
    const paths = createHostPaths({
        platform: "linux", release: "example-microsoft-standard-WSL2",
        realpath: value => value,
        statfs: () => ({ type: 0x01021997 }),
        translate(direction, value) {
            calls.push([direction, value]);
            return direction === "-u" ? "/mnt/c/" + value.slice(3).replaceAll("\\", "/")
                : "C:\\" + value.slice("/mnt/c/".length).replaceAll("/", "\\");
        },
        ...overrides,
    });
    return { paths, calls };
}
const refused = work => assert.throws(work, { code: "host_path_unavailable", status: 422 });

test("ordinary native Windows and POSIX path behavior needs no interop", () => {
    for (const [platform, location] of [["win32", "C:\\store\\report.html"], ["linux", "/home/example/report.html"]]) {
        const paths = createHostPaths({ platform, release: "native-host",
            translate: () => assert.fail("Native paths do not call a translator."),
            realpath: () => assert.fail("Native lexical behavior stays with the existing caller."),
            statfs: () => assert.fail("Native paths do not probe another filesystem."),
        });
        assert.equal(paths.local(location), location);
        assert.equal(paths.stored(location), location);
        assert.equal(paths.same(location, location), true);
        assert.equal(paths.same(location, location.toUpperCase()), platform === "win32");
    }
});

test("qualified WSL drive paths retain Windows registrations and native filesystem access", () => {
    const { paths } = wsl();
    assert.deepEqual(paths.describe("C:\\store\\data.db"), {
        absolute: true, name: "data.db", directory: "C:\\store", foreignWindows: true,
    });
    assert.equal(paths.local("C:\\store\\data.db"), "/mnt/c/store/data.db");
    assert.equal(paths.stored("/mnt/c/store/report.html"), "C:\\store\\report.html");
    assert.equal(paths.same("/mnt/c/store/report.html", "c:/store/report.html"), true);
    assert.equal(paths.same("/mnt/c/store/report.html", "C:\\other-store\\report.html"), false);
});

test("foreign drive traversal, UNC and ambiguous conversion are refused", () => {
    const { paths, calls } = wsl();
    refused(() => paths.local("C:\\store\\..\\data.db"));
    refused(() => paths.local("\\\\foreign-host\\share\\data.db"));
    assert.deepEqual(calls, [], "Unqualified references never reach a filesystem translator.");
    refused(() => wsl({ translate: () => "/mnt/c/store\n/mnt/d/store\n" }).paths.local("C:\\store"));
    refused(() => wsl({ translate: () => "relative-path" }).paths.local("C:\\store"));
    refused(() => wsl({ translate: direction => direction === "-u" ? "/mnt/c/store" : "D:\\store" }).paths.local("C:\\store"));
});

test("WSL mappings reject missing locations, links and non-Windows filesystems", () => {
    refused(() => wsl({ realpath: value => value.endsWith("missing")
        ? (() => { throw Object.assign(new Error("Missing fixture"), { code: "ENOENT" }); })() : value }).paths.local("C:\\missing"));
    refused(() => wsl({ realpath: () => "/mnt/c/unrelated" }).paths.local("C:\\store"));
    refused(() => wsl({ statfs: () => ({ type: 0xef53 }) }).paths.local("C:\\store"));
    refused(() => wsl({ statfs: () => { throw Object.assign(new Error("Denied fixture"), { code: "EACCES" }); } }).paths.local("C:\\store"));
});

test("ordinary WSL Linux files stay POSIX and cannot adopt Windows registrations", () => {
    const { paths, calls } = wsl({ statfs: () => ({ type: 0xef53 }) });
    assert.equal(paths.stored("/home/example/report.html"), "/home/example/report.html");
    assert.equal(paths.same("/home/example/report.html", "C:\\store\\report.html"), false);
    assert.deepEqual(calls, []);
});
