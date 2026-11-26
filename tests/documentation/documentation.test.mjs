import test from "node:test";
import assert from "node:assert/strict";
import { rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { documentationRepository } from "./documentation-fixture.mjs";
import { renderGuide, resolveTargets, githubSlug } from "../../lib/documentation-render.mjs";
import { createDocumentationRoutes } from "../../lib/documentation-http.mjs";

test("installed guides remain pinned; explicitly previewed branches bind text and images to one revision", async t => {
    const repo = await documentationRepository(t);
    let clock = Date.parse("2026-10-02T09:00:00Z");
    const source = repo.source({ now: () => clock });

    const before = await source.catalog("official");
    assert.equal(before.source.kind, "build", "nothing fetched yet: the guides come from the running copy");
    assert.equal(before.source.commit, repo.head());
    assert.equal(before.source.canCheck, true);

    const published = await repo.publish("docs/user-guide.md", "# Use WIRE\n\nNewer guidance from main.\n\n## Trends\n\nText.\n", "Docs only");
    assert.deepEqual(await source.check({ force: true }), { checked: true });
    const after = await source.catalog("official");
    assert.equal(after.source.kind, "build");
    assert.equal(after.source.commit, repo.head());
    assert.equal(after.source.failedAt, null);
    assert.ok(after.source.checkedAt);
    const selection = (await source.branches()).find(item=>item.branch==="main");
    const preview = await source.catalog("branch",selection);
    assert.equal(preview.source.commit,published);
    const page = await source.page(preview.source.revision, "user-guide");
    assert.match(page.html, /Newer guidance from main/);
    assert.match(page.sourceUrl, new RegExp(`/blob/${published}/docs/user-guide\\.md$`));
    assert.equal(repo.head(), before.source.commit, "the running checkout is unchanged");
    const imageFile = "docs/images/trends-overview.png";
    const originalImage = await source.asset(before.source.revision,imageFile);
    const nextImage = Buffer.concat([originalImage,Buffer.from("fixture illustration change")]);
    await repo.publish(imageFile,nextImage,"Revise guide artwork");
    await assert.rejects(source.catalog("branch",selection),{code:"documentation_branch_changed"});
    const moved = await source.catalog("branch",(await source.branches()).find(item=>item.branch==="main"));
    assert.deepEqual(await source.asset(moved.source.revision,imageFile),nextImage);
    assert.deepEqual(await source.asset(preview.source.revision,imageFile),originalImage);

    clock += 60_000;
    assert.deepEqual(await source.check(), { checked: false }, "automatic checks are spaced out");

    await rename(repo.origin, repo.origin + ".offline");
    await source.check({ force: true });
    const offline = await source.catalog("official");
    assert.equal(offline.source.kind, "build");
    assert.equal(offline.source.commit, repo.head());
    assert.match((await source.page(preview.source.revision,"user-guide")).html,/Newer guidance/);
    await assert.rejects(source.branches(),/Couldn't list/);
    assert.ok(offline.source.failedAt > offline.source.checkedAt);
    assert.match(offline.source.failure, /Couldn't reach GitHub main/);
});

test("a copy that does not track the official repository never fetches", async t => {
    const repo = await documentationRepository(t);
    const source = repo.source({ fixtureRemote: null });
    assert.deepEqual(await source.check({ force: true }), { checked: false });
    const catalog = await source.catalog("official");
    assert.equal(catalog.source.kind, "build");
    assert.equal(catalog.source.canCheck, false);
    assert.equal((await source.catalog("checkout")).source.comparedWith, "commit", "a fork compares edits with its own last commit");
});

test("This checkout previews saved guide edits, scoped to guides and their images", async t => {
    const repo = await documentationRepository(t);
    const source = repo.source();
    await source.check({ force: true });
    const clean = await source.catalog("checkout");
    assert.equal(clean.source.kind, "checkout");
    assert.deepEqual(clean.source.changed, {}, "line endings alone do not count as edits");
    assert.equal(clean.source.comparedWith, "main");

    await appendFile(path.join(repo.work, "docs", "user-guide.md"), "\nA local paragraph.\n");
    await writeFile(path.join(repo.work, "docs", "draft-guide.md"), "# Draft guide\n\nNot committed.\n");
    await writeFile(path.join(repo.work, "notes.txt"), "private");
    const edited = await source.catalog("checkout");
    assert.notEqual(edited.source.revision, clean.source.revision);
    assert.deepEqual(edited.source.changed, { "docs/draft-guide.md": "new", "docs/user-guide.md": "edited" });
    assert.equal(await source.version(), edited.source.revision);
    assert.match((await source.page(edited.source.revision, "user-guide")).html, /A local paragraph/);
    assert.equal((await source.page(edited.source.revision, "user-guide")).sourceUrl, null);
    assert.equal(await source.asset(edited.source.revision, "notes.txt"), null);
    assert.equal(await source.asset(edited.source.revision, "../package.json"), null);
    assert.ok((await source.asset(edited.source.revision, "docs/images/trends-overview.png"))?.length);

    await appendFile(path.join(repo.work, "docs", "user-guide.md"), "\nAnother save.\n");
    await assert.rejects(source.page(edited.source.revision, "user-guide"), { status: 409, code: "documentation_revision_changed" });
    await assert.rejects(source.page("git:" + "0".repeat(40), "user-guide"), { status: 409 }, "revisions must have been issued");
});

test("a managed WIRE does not offer a checkout preview", async t => {
    const repo = await documentationRepository(t);
    const source = repo.source({ gitDir: path.join(repo.work, ".git") });
    assert.equal((await source.catalog("official")).source.checkout, false);
    await assert.rejects(source.catalog("checkout"), { status: 409 });
});

test("guides render GitHub headings and resolve every address against one revision", () => {
    assert.equal(githubSlug(`Punctuation: "quotes", commas & ampersands — dashes, too?`), "punctuation-quotes-commas--ampersands--dashes-too");
    const rendered = renderGuide("# Title\n\n## Same\n\n## Same\n\nSee[^1] :rocket:\n\n[^1]: Note.\n\n[a](other.md#same) [b](#same-1) [c](javascript:alert(1)) [d](https://example.invalid/x) [e](missing.md) [f](../lib/x.mjs)\n");
    assert.deepEqual(rendered.headings.map(heading => heading.id), ["same", "same-1"], "the title is not part of the outline");
    assert.match(rendered.html, /🚀/);
    assert.match(rendered.html, /doc-footnotes/);
    const targets = resolveTargets(rendered.html, { file: "docs/guide.md", guides: new Map([["docs/guide.md", "guide"], ["docs/other.md", "other"]]),
        anchors: new Map([["docs/other.md", new Set(["same"])], ["docs/guide.md", new Set(rendered.anchors)]]),
        exists: file => file === "lib/x.mjs" ? "file" : null, read: () => null, webUrl: (kind, file) => `https://github.example/${kind}/${file}` });
    assert.deepEqual(targets["other.md#same"], { kind: "guide", guide: "other", fragment: "same" });
    assert.equal(targets["#same-1"].kind, "fragment");
    assert.equal(targets["javascript:alert(1)"].kind, "unsafe");
    assert.equal(targets["https://example.invalid/x"].kind, "external");
    assert.equal(targets["missing.md"].kind, "missing");
    assert.equal(targets["../lib/x.mjs"].kind, "repository");
});

test("guide images load only through a live panel's ticket from the same origin", async t => {
    const repo = await documentationRepository(t);
    const source = repo.source();
    let active = true;
    const routes = createDocumentationRoutes(source, { ownerActive: () => active });
    const catalog = await routes.handle("/api/documentation/catalog", {}, "owner-a");
    const page = await routes.handle("/api/documentation/page", { revision: catalog.source.revision, guide: "rendering-check" }, "owner-a");
    await assert.rejects(routes.handle("/api/documentation/page",{revision:catalog.source.revision,guide:"rendering-check"},"owner-b"),{status:409});
    assert.match(page.assetBase, /^\/api\/documentation\/asset\/[a-f0-9]{64}\/$/);
    await assert.rejects(routes.handle("/api/documentation/page", { revision: catalog.source.revision, guide: "../../package" }, "owner-a"), { status: 404 });
    await assert.rejects(routes.handle("/api/documentation/catalog", { source: "official", path: "/" }, "owner-a"), { status: 422 });
    const get = async (url, headers = { "sec-fetch-site": "same-origin" }) => {
        const response = { status: 0, headers: {}, writeHead(status, values) { this.status = status; this.headers = values; }, end(body) { this.body = body; } };
        await routes.asset({ method: "GET", url, headers }, response);
        return response;
    };
    const image = await get(page.assetBase + "docs/images/trends-overview.png");
    assert.equal(image.status, 200);
    assert.equal(image.headers["Content-Type"], "image/png");
    assert.equal(image.headers["X-Content-Type-Options"], "nosniff");
    await assert.rejects(get(page.assetBase + "docs/images/trends-overview.png", { "sec-fetch-site": "cross-site" }), { status: 403 });
    await assert.rejects(get(page.assetBase + "package.json"), { status: 404 });
    await assert.rejects(get(page.assetBase.replace(/[a-f0-9]{64}/, "f".repeat(64)) + "docs/images/trends-overview.png"), { status: 404 });
    active = false;
    await assert.rejects(get(page.assetBase + "docs/images/trends-overview.png"), { status: 404 }, "tickets end with the panel");
});
