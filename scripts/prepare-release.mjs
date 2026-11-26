import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { latestRelease, newerRelease, releaseTag } from "../lib/wire-release.mjs";

const repository = "likamrat/wire";
const remote = `https://github.com/${repository}.git`;
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim();
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", windowsHide: true }).trim();
export function prepareNotes(from, target, tag) {
    if (!oid.test(from) || !oid.test(target) || !releaseTag.test(tag)) throw Error("Supply full commit IDs and a vMAJOR.MINOR.PATCH version.");
    git("merge-base", "--is-ancestor", from, target);
    if (from === target) throw Error("There are no new changes to release.");
    const changes = git("log", "--no-merges", "--reverse", "--format=%s", `${from}..${target}`).split("\n").filter(Boolean);
    if (!changes.length) throw Error("No change summaries found; review the release range.");
    return `## What's new in ${tag}\n\n### Changed\n\n${changes.map(s => `- ${s}`).join("\n")}\n`;
}
function versionFor(target, requested, latest) {
    if (latest) {
        const [major, minor, patch] = latest.tag.slice(1).split(".").map(Number);
        const tag = requested ?? `v${major}.${minor}.${patch + 1}`;
        if (!newerRelease(tag, latest.tag)) throw Error(`Choose a version newer than ${latest.tag}.`);
        return tag;
    }
    if (!requested || !releaseTag.test(requested)) throw Error("The first release needs an explicit --version vMAJOR.MINOR.PATCH.");
    const pkg = JSON.parse(git("show", `${target}:package.json`));
    const lock = JSON.parse(git("show", `${target}:package-lock.json`));
    if (![pkg.version, lock.version, lock.packages?.[""]?.version].every(version => version === requested.slice(1))) {
        throw Error(`The first release ${requested} must match package.json and both root package-lock.json versions at the selected commit.`);
    }
    return requested;
}
async function run() {
    const { values } = parseArgs({ options: { commit:{type:"string"}, version:{type:"string"}, baseline:{type:"string"}, draft:{type:"boolean"} } });
    const target = values.commit;
    if (!oid.test(target ?? "")) throw Error("Choose the exact main commit with --commit FULL_SHA.");
    const main = git("ls-remote", remote, "refs/heads/main").split("\t")[0];
    if (!oid.test(main)) throw Error("Could not resolve official main.");
    git("merge-base", "--is-ancestor", target, main);
    const latest = await latestRelease();
    if (latest && values.baseline) throw Error("--baseline is only for the first release.");
    const tag = versionFor(target, values.version, latest);
    let from = values.baseline;
    if (latest) {
        const ref = `refs/tags/${latest.tag}`;
        const refs = new Map(git("ls-remote",remote,ref,`${ref}^{}`).split("\n").map(l=>l.split("\t").reverse()));
        from = refs.get(`${ref}^{}`) ?? refs.get(ref);
    }
    if (!oid.test(from ?? "")) throw Error("The first release needs --baseline FULL_SHA (last previously delivered commit).");
    const body = prepareNotes(from, target, tag);
    console.log(`${tag} · ${target}\nChanges after ${from}\n\n${body}`);
    if (!values.draft) return;
    const existing = JSON.parse(gh("api","--paginate","--slurp",`repos/${repository}/releases?per_page=100`)).flat();
    const found = existing.find(r=>r.tag_name===tag);
    if (found?.draft && found.target_commitish===target && !git("ls-remote",remote,`refs/tags/${tag}`)) {
        console.log(`Draft already prepared: ${found.html_url}. Your reviewed notes were not changed.`);
        return;
    }
    if (found || git("ls-remote",remote,`refs/tags/${tag}`)) throw Error(`${tag} already exists. Review the existing release and target; no changes made.`);
    const pending = existing.find(r=>r.draft && releaseTag.test(r.tag_name));
    if (pending) throw Error(`Review the existing stable release draft ${pending.tag_name} before preparing another. No changes made.`);
    // A release created from a branch name could tag a later commit at publish time.
    console.log(gh("release","create",tag,"--repo",repository,"--target",target,"--title",tag,"--notes",body,"--draft"));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { await run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
