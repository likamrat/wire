import test from "node:test";
import assert from "node:assert/strict";
import { projectPrompts } from "../lib/prompt-projection.mjs";
import { fixture } from "./helpers.mjs";

test("masked copies retain original prose and show local replacements without changing the source", () => {
    const source = fixture();
    source.userPrompt.text = "Ask Leila Navarro\nat leila@example.invalid about <script>notes</script>.";
    source.toolCalls.push({ tool: "workiq-ask", requestArgs: { question: "Follow up with leila@example.invalid" } });
    const before = structuredClone(source);
    const result = projectPrompts(source, "scenario-safe", { promptMode: "masked", manualTerms: ["Leila Navarro"] });
    assert.equal(result.prompts[0].text, "Ask [manual redaction]\nat [email identifier removed] about <script>notes</script>.");
    assert.equal(result.review[0].original, source.userPrompt.text);
    assert.ok(result.review[0].segments.some((segment) => segment.category === "email_identifiers"));
    assert.match(result.prompts.at(-1).text, /\[email identifier removed\]/);
    assert.deepEqual(source, before);
});

test("original mode removes credential URLs, short assignments, signed URLs and private keys without a raw bypass", () => {
    const source = fixture();
    source.userPrompt.text = "Keep Leila Navarro\nhttps://user:URL_SECRET@host.invalid/path\nhttps://host.invalid/file?sig=SIGNATURE_SECRET\npassword: x!\n-----BEGIN RSA PRIVATE KEY-----\nKEY_TAIL_SECRET";
    const result = projectPrompts(source, "safe", { promptMode: "original" });
    assert.match(result.prompts[0].text, /Leila Navarro/);
    assert.doesNotMatch(result.prompts[0].text, /URL_SECRET|SIGNATURE_SECRET|x!|KEY_TAIL_SECRET/);
    assert.equal(result.prompts[0].changes.filter((c) => c.mandatory).length, 4);
    assert.equal(result.prompts[0].representation, "original-with-mandatory-or-manual-removals");
});

test("manual literal masking handles Unicode and regex punctuation without changing adjacent text", () => {
    const source = fixture();
    source.userPrompt.text = "İ before Leila (A+B) after";
    const result = projectPrompts(source, "safe", { manualTerms: ["Leila (A+B)"] });
    assert.equal(result.prompts[0].text, "İ before [manual redaction] after");
});
