import { SEARCH_INTENT_POLICY_ID } from "./search-linguistics-assets.mjs";

const normalize = text => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "_");
const directives = new Set(["find", "show", "locate", "search", "retrieve", "list"]);
const spatial = new Set(["in", "at", "inside", "within", "under", "beneath", "above", "near", "outside"]);
const genericPronouns = new Set(["i", "you", "we", "they", "he", "she", "it", "someone", "somebody", "anyone", "anybody"]);
const deicticPossessives = new Set(["my", "your", "our", "his", "her", "its", "their"]);
const articles = new Set(["a", "an", "the"]);
const negativeQuantifiers = new Set(["no", "none", "neither", "nobody", "nothing", "nowhere", "no-one"]);

export function createSearchIntent(nlp, lexical) {
    const unsupported = reason => ({ policyId: SEARCH_INTENT_POLICY_ID, state: "unsupported", reason });
    function noun(tokens) {
        if (tokens.some(token => token.tags.includes("Negative") || negativeQuantifiers.has(token.normal)
            || token.tags.includes("Determiner") && !articles.has(token.normal)
            || token.tags.includes("Possessive") && !deicticPossessives.has(token.normal))) return null;
        const first = tokens.findIndex(token => !token.tags.includes("Determiner") && !token.tags.includes("Possessive"));
        const content = first < 0 ? [] : tokens.slice(first);
        const head = content.at(-1);
        // Only a complete simple noun phrase is supported. Arbitrary tokens or noun
        // compounds cannot become disposable adjectives around the last noun.
        if (!head?.tags.includes("Noun") || spatial.has(head.normal)
            || head.tags.includes("Pronoun") && !genericPronouns.has(head.normal)
            || content.slice(0, -1).some(token => !token.tags.includes("Adjective")
                || spatial.has(token.normal) || token.tags.some(tag => ["Noun", "Verb", "Value", "Negative"].includes(tag)))) return null;
        const lemma = normalize(nlp(head.text).nouns().toSingular().text() || head.normal);
        return { lemma, pos: "n", start: content[0].start, end: content.at(-1).end,
            qualifiers: content.filter(token => token !== head).map(token => normalize(token.normal)),
            generic: head.tags.includes("Pronoun") || genericPronouns.has(lemma),
            actorTagged: head.tags.includes("Actor") || head.tags.includes("Person") };
    }
    function verbSenses(lemma, hasObject, objectIsActor) {
        return lexical.lookup(lemma, "v").filter(sense => {
            const frames = lexical.synset(sense.id).frames.filter(frame => frame.word === 0 || frame.word === sense.word).map(frame => frame.number);
            // WordNet's intransitive, person-object and thing-object frame families.
            return frames.some(frame => (hasObject ? objectIsActor ? [9, 10] : [8, 11] : [1, 2, 3]).includes(frame));
        });
    }
    function nominalEvent(body) {
        const head = body.at(-1);
        if (!head?.tags.includes("Noun")) return null;
        const lemma = normalize(nlp(head.text).nouns().toSingular().text() || head.normal);
        // Lexicographer classes noun.act and noun.event, not arbitrary noun senses.
        const derivations = lexical.eventNounVerbs(lemma).filter(group => [4, 11].includes(lexical.synset(group.noun.id).lexicalFile));
        const verbs = derivations.flatMap(group => group.verbs.map(value => ({ ...value, pos: "v" })));
        const patient = noun(body.slice(0, -1));
        if (!verbs.length || !patient) return null;
        return { patient, operation: { lemma, pos: "v", start: head.start, end: head.end,
            senses: verbs.filter(sense => verbSenses(sense.lemma, true, patient.actorTagged).some(value => value.id === sense.id)) } };
    }
    function parse(text, kind) {
        if (typeof text !== "string" || !["query", "record"].includes(kind)) throw new TypeError("Intent text and role required");
        const doc = nlp(text), sentences = doc.json({ offset: true, terms: { offset: true } });
        if (sentences.length !== 1) return unsupported("multiple-sentences");
        const tokens = sentences.flatMap(sentence => sentence.terms).map(token => {
            const start = token.offset?.start, end = start + token.offset?.length;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || text.slice(start, end) !== token.text) throw new TypeError("Intent source offset mismatch");
            return { text: token.text, normal: token.normal, tags: token.tags, start, end, index: token.index[1] };
        });
        if (!tokens.length) return unsupported("empty");
        let verbs = doc.verbs().json(), body = tokens;
        if (verbs.some(verb => verb.verb.prefix || verb.verb.preAdverbs?.length || verb.verb.postAdverbs?.length)) return unsupported("predicate-modifier");
        if (kind === "query" && verbs.length && directives.has(normalize(verbs[0].verb.infinitive))
            && verbs[0].terms[0].index[1] === 0) {
            if (verbs[0].verb.negative || verbs[0].verb.auxiliary) return unsupported("modified-directive");
            const last = verbs[0].terms.at(-1).index[1];
            body = body.filter(token => token.index > last); verbs = verbs.slice(1);
        }
        let operation, actor, patient, location, polarity = "positive";
        const relativeIndex = body.findIndex(token => token.normal === "where");
        if (relativeIndex >= 0 && kind === "query") {
            const coordination = body.slice(0, relativeIndex).flatMap((token, i) => token.normal === "and" ? [i] : []);
            const relative = body.slice(relativeIndex + 1), occurrence = verbs.length === 1 ? verbs[0] : null;
            if (coordination.length !== 1 || !occurrence || occurrence.verb.negative || occurrence.verb.auxiliary
                || !relative[0]?.tags.includes("Pronoun") || relative[0].normal !== "it"
                || occurrence.terms[0].index[1] !== relative[1]?.index
                || occurrence.terms.at(-1).index[1] !== relative.at(-1)?.index) return unsupported("event-location-reference");
            const referent = nominalEvent(body.slice(0, coordination[0]));
            location = noun(body.slice(coordination[0] + 1, relativeIndex));
            // An event-occurrence reference may bind backward; a different subordinate action may not.
            const concept = lexical.lookup("happen", "v");
            const grounded = verbSenses(normalize(occurrence.verb.infinitive), false, false).some(source => concept.some(target => source.id === target.id));
            if (!referent || !location || !grounded) return unsupported("unresolved-event-location");
            ({ operation, patient } = referent); location.relation = "event-site";
        } else if (body.some(token => ["where", "when", "which", "who", "whose", "that"].includes(token.normal))) {
            return unsupported("relative-attachment");
        } else if (body.some(token => token.tags.includes("Conjunction"))) return unsupported("coordination");
        else if (!verbs.length) {
            const nominal = nominalEvent(body);
            if (!nominal) return unsupported("event-noun-derivation");
            ({ operation, patient } = nominal);
        } else {
            if (verbs.length !== 1) return unsupported("multiple-predicates");
            const verb = verbs[0], info = verb.verb, first = verb.terms[0].index[1], last = verb.terms.at(-1).index[1];
            if (info.grammar.copula || /passive|perfect|modal/u.test(info.grammar.form ?? "")
                || verb.terms.some(token => token.tags.includes("Modal"))) return unsupported("voice-or-modality");
            const before = body.filter(token => token.index < first), after = body.filter(token => token.index > last);
            const preposition = after.findIndex(token => token.tags.includes("Preposition") || spatial.has(token.normal));
            const direct = preposition < 0 ? after : after.slice(0, preposition);
            patient = direct.length ? noun(direct) : null;
            if (direct.length && !patient) return unsupported("direct-object");
            if (before.length) {
                const parsed = noun(before);
                if (!parsed) return unsupported("subject");
                if (kind === "query" && verb.terms.some(token => token.tags.includes("Gerund")) && !after.length
                    && !parsed.actorTagged && !parsed.generic) patient = parsed;
                else actor = parsed;
            }
            if (preposition >= 0) {
                const prep = after[preposition];
                if (!spatial.has(prep.normal) || after.slice(preposition + 1).some(token => token.tags.includes("Preposition"))) return unsupported("prepositional-attachment");
                location = noun(after.slice(preposition + 1));
                if (!location) return unsupported("location");
                location.relation = ["in", "inside", "within"].includes(prep.normal) ? "inside" : prep.normal;
            }
            operation = { lemma: normalize(info.infinitive), pos: "v",
                start: tokens.find(token => token.index === first).start, end: tokens.find(token => token.index === last).end,
                senses: verbSenses(normalize(info.infinitive), Boolean(patient), patient?.actorTagged ?? false) };
            polarity = info.negative ? "negative" : "positive";
        }
        if (!operation.senses.length) return unsupported("operation-sense");
        const args = [];
        if (actor && !actor.generic) args.push({ ...actor, role: "actor", senses: lexical.lookup(actor.lemma, "n") });
        if (patient && !patient.generic) args.push({ ...patient, role: "patient", senses: lexical.lookup(patient.lemma, "n") });
        const locations = location ? [{ ...location, senses: lexical.lookup(location.lemma, "n") }] : [];
        if ([...args, ...locations].some(node => !node.senses.length)) return unsupported("argument-lexeme");
        return { policyId: SEARCH_INTENT_POLICY_ID, state: "supported", characters: text.length, operation, arguments: args, locations, polarity };
    }
    function proof(actual, wanted, pos) {
        if (wanted.relation === "event-site" && !["inside", "at"].includes(actual.relation)) return false;
        if (wanted.relation && wanted.relation !== "event-site" && wanted.relation !== actual.relation) return false;
        const qualifiers = actual.qualifiers ?? [], requestedQualifiers = wanted.qualifiers ?? [];
        // Adjective tags do not establish subsectivity. Preserve the complete modified
        // nominal instead of assuming a modified noun entails its unmodified head.
        if (qualifiers.length !== requestedQualifiers.length
            || qualifiers.some((qualifier, index) => qualifier !== requestedQualifiers[index])
            || qualifiers.length && actual.lemma !== wanted.lemma) return false;
        return actual.senses.some(source => wanted.senses.some(target => lexical.directedProof(source.id, target.id, pos) !== null));
    }
    function covers(required, actual, role, index = 0, used = new Set()) {
        if (index === required.length) return actual.every((node, i) => !node.qualifiers?.length || used.has(i));
        return actual.some((node, i) => {
            if (used.has(i) || role && node.role !== required[index].role || !proof(node, required[index], "n")) return false;
            return covers(required, actual, role, index + 1, new Set([...used, i]));
        });
    }
    return {
        parse,
        matches(query, record) {
            // Positive subsumption reverses under negation, and these intents do not
            // preserve the quantified event domain needed for a sound negative proof.
            return query.state === "supported" && record.state === "supported"
                && query.polarity === "positive" && record.polarity === "positive"
                && proof(record.operation, query.operation, "v")
                && covers(query.arguments, record.arguments, true) && covers(query.locations, record.locations, false);
        },
    };
}

export function validSearchIntent(value, text) {
    if (!value || value.policyId !== SEARCH_INTENT_POLICY_ID) return false;
    if (value.state === "unsupported") return Object.keys(value).length === 3 && typeof value.reason === "string" && /^[a-z-]+$/.test(value.reason);
    if (value.state !== "supported" || value.characters !== text.length || !["positive", "negative"].includes(value.polarity)
        || !Array.isArray(value.arguments) || !Array.isArray(value.locations)) return false;
    const term = (node, pos) => node && node.pos === pos && typeof node.lemma === "string" && node.lemma.length > 0
        && Number.isSafeInteger(node.start) && Number.isSafeInteger(node.end) && node.start >= 0 && node.start < node.end && node.end <= text.length
        && Array.isArray(node.senses) && node.senses.length > 0 && node.senses.every(sense => sense && new RegExp(`^${pos}:\\d{8}$`).test(sense.id)
            && Number.isInteger(sense.word) && sense.word > 0 && typeof sense.lemma === "string")
        && (pos === "v" || Array.isArray(node.qualifiers) && node.qualifiers.every(word => typeof word === "string"));
    return term(value.operation, "v") && value.arguments.every(node => ["actor", "patient"].includes(node.role) && term(node, "n"))
        && value.locations.every(node => term(node, "n"));
}
