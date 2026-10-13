import { fileURLToPath } from "node:url";
import { SearchError, readVerifiedFile, searchHash } from "./search-model-assets.mjs";

const parser = "https://raw.githubusercontent.com/spencermountain/compromise/263fab53e01f18c8ba2ed5c69fb128c7116a3185/";
const dictionary = "https://raw.githubusercontent.com/moos/wordnet-db/9e5cbc56523450c50d6655c8ba47bcb9fabf7935/";
const file = (name, bytes, sha256, url) => Object.freeze({ name, bytes, sha256, url });
export const SEARCH_LINGUISTICS = Object.freeze({
    version: "compromise14.17-wordnet3.1-noun-verb-v1",
    parserRevision: "263fab53e01f18c8ba2ed5c69fb128c7116a3185",
    dictionaryRevision: "9e5cbc56523450c50d6655c8ba47bcb9fabf7935",
    files: Object.freeze([
        file("compromise/builds/three/compromise-three.mjs", 357898, "fb8df631c8835f6608e9291bcab31da10d904e9b70f941d9943c08c3fe3a6929", parser + "builds/three/compromise-three.mjs"),
        file("compromise/LICENSE", 1079, "b6ced567b9d97d31961c5923fc41f109d796979511f04591366b5241b93097d6", parser + "LICENSE"),
        file("compromise/package.json", 4259, "5d3d37817a4bcf7176df5438d6871664e45940c0f2ea8b2ad0fa17b499cbda77", parser + "package.json"),
        file("wordnet-db/dict/data.noun", 15325523, "2cad22fe43461ee7ae61a564ae6a518c57445c8597e53542caddb5c26a6a5d94", dictionary + "dict/data.noun"),
        file("wordnet-db/dict/index.noun", 4792749, "799fad7c8084eb0f6f2a32ec737a251c85f51adb8b2603eb02bfebc4ce5ffa3d", dictionary + "dict/index.noun"),
        file("wordnet-db/dict/data.verb", 2778475, "eb1cf196dab6e1b815a1c86fa20c909fb7413b2f34250d7fe60a0fb35ef59e03", dictionary + "dict/data.verb"),
        file("wordnet-db/dict/index.verb", 524435, "e65b2d67274c8a5f9ba6f696fdc73f4546db2a138b362a3be582e3787c879c7a", dictionary + "dict/index.verb"),
        file("wordnet-db/LICENSE", 1625, "7731175a77952e259390b496fab905e57118b8d19ad3a8383c67eee724ff443f", dictionary + "LICENSE"),
        file("wordnet-db/README.md", 3077, "f0a3278010c2aad0b4e6336e8c3b1e7183e09d058094ef7369916428cc921301", dictionary + "README.md"),
        file("wordnet-db/package.json", 571, "747a50877ff8cdd6937fd36f26933248785a9aed61829cf8e374c766f705126c", dictionary + "package.json"),
    ]),
});
export const SEARCH_LINGUISTICS_ID = searchHash(JSON.stringify(SEARCH_LINGUISTICS));
export const SEARCH_INTENT_POLICY = Object.freeze({
    version: "bound-lexical-event-v5", resources: SEARCH_LINGUISTICS_ID,
    baseline: "unchanged exact-prefix-cosine-v2",
    grammar: "complete-simple-event-compromise-wordnet-v4",
    entailment: "positive-only; no unmatched source qualifiers; modified nominals require identical qualifiers and head lemma",
    enabled: "explicit linguisticsDirectory only", purpose: "partial-recall-increment",
    scope: "single complete sentence; role-bound operation, arguments, location and polarity; explicit unsupported grammar",
    limits: "F09 and ordinary-work recall remain open; unqualified source modifiers and all negative adjunct proofs abstain",
});
export const SEARCH_INTENT_POLICY_ID = searchHash(JSON.stringify(SEARCH_INTENT_POLICY));
export const defaultSearchLinguisticsDirectory = fileURLToPath(new URL(`../assets/search-linguistics/${SEARCH_LINGUISTICS_ID}/`, import.meta.url));

export async function readSearchLinguistics(directory) {
    if (typeof directory !== "string") throw new TypeError("An explicit linguistic resource directory is required.");
    const files = {};
    for (const spec of SEARCH_LINGUISTICS.files) files[spec.name] = await readVerifiedFile(directory, spec, "linguistics");
    if (JSON.parse(files["compromise/package.json"]).version !== "14.17.0"
        || JSON.parse(files["wordnet-db/package.json"]).version !== "3.1.14") throw new SearchError("linguistics-incompatible");
    return files;
}
