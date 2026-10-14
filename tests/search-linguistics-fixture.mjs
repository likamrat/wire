import assert from "node:assert/strict";

export const originalDocuments = [
    "The physician treated an injured patient in the hospital.",
    "The mechanic repaired a broken automobile in the garage.",
    "Employees cannot sign in because their credentials have expired.",
    "The hospital maintenance crew repaired an ambulance engine in the garage.",
    "The clinician scheduled a follow-up visit after the patient's recovery.",
    "The support engineer renewed a revoked service account credential used by automated deployments.",
    "The event planner booked a room for a quarterly staffing discussion.",
    "The warehouse technician repaired a broken conveyor while collecting damaged components.",
    "The researcher compared medical privacy policies without handling a patient's treatment.",
];
const required = (query, must, allowed = must) => ({ query, must, allowed });
const forbidden = query => required(query, []);
// Original frozen F09 bounds: the ambulance repair is permitted, not required.
export const originalExpectations = [
    required("fix my car", [1], [1, 3]),
    required("vehicle servicing", [1], [1, 3]),
    required("Find the car repair and the building where it happened.", [1], [1, 3]),
    required("A doctor cared for somebody who was hurt.", [0]),
    required("People could not log in with an out-of-date password.", [2]),
    ...["Someone stole my car", "Buy a replacement automobile", "warehouse inventory",
        "conveyor production capacity", "vehicle theft", "car insurance quote", "rent a car", "blood donation",
        "A hospital accountant calculated quarterly payroll.", "Distant galaxies contain enormous black holes.",
        "A recipe for chocolate cake and vanilla icing."].map(forbidden),
];
export const rawRequiredPairs = [
    ["fix my car", originalDocuments[1]],
    ["Find the car repair and the building where it happened.", originalDocuments[1]],
    ["fix the pipe", "The plumber repaired a broken pipe in the building."],
];
export const scopeCases = [
    { authority: "primary-negative-contrast", meaning: "Unrequested fake/imaginary objects, fictional actors or imaginary locations",
        must: [], allowed: [], pairs: [
            ["fix my car", "The mechanic repaired an imaginary automobile in the garage."],
            ["fix the pipe", "The plumber repaired a fake pipe in the building."],
            ["fix my car", "The fictional mechanic repaired an automobile in the garage."],
            ["fix my car", "The mechanic repaired an automobile in an imaginary garage."],
        ] },
    { authority: "mechanism-observation", meaning: "Current positive-only proof abstains on both-negated forms",
        must: null, allowed: null, pairs: [
            ["do not fix my car", "The mechanic did not repair an automobile in the garage."],
            ["do not repair my vehicle", "The mechanic did not repair a car."],
            ["do not fix the pipe", "The plumber did not patch the pipe in the building."],
            ["do not fix the pipe", "The plumber did not repair the pipe."],
        ] },
    { authority: "mechanism-observation", meaning: "Current modifier equality/broader-noun proof abstains; semantic acceptance unspecified",
        must: null, allowed: null, pairs: [
            ["fix my car", "The mechanic repaired a miniature automobile in the garage."],
            ["fix my car", "The mechanic repaired a red automobile in the garage."],
            ["fix the fake vehicle", "The mechanic repaired a fake automobile in the garage."],
        ] },
];

export function assertSearchPopulation(actual, expectation) {
    assert.ok(Array.isArray(expectation.must), "Unspecified recall cannot be claimed as qualification: " + expectation.query);
    assert.equal(new Set(actual).size, actual.length, "Duplicate population members: " + expectation.query);
    assert.ok(expectation.must.every(id => actual.includes(id)), "Missing required matches: " + expectation.query);
    assert.ok(actual.every(id => expectation.allowed.includes(id)), "Forbidden matches: " + expectation.query);
}

export const ordinaryDocuments = [
    "The engineer restored the deleted database from yesterday's backup.",
    "The engineer rotated database passwords before deleting an old backup.",
    "The operations team increased the application's memory limit after it kept crashing.",
    "The analyst reviewed memory pricing while the application remained stable.",
    "The accountant reconciled an overdue vendor invoice with a missing bank transfer.",
    "The accountant prepared an estimate for next year's supplier budget.",
    "The technician replaced a frayed network cable to reconnect the office printer.",
    "The designer ordered ink for an office printer brochure.",
    "The administrator revoked a departed employee's access to the shared folder.",
    "The administrator restored an active employee's access after a password reset.",
    "The recruiter moved an interview to Friday because the candidate was unavailable.",
    "The recruiter wrote feedback from a completed interview.",
];
export const comparisonDocuments = [
    "The developer corrected an off-by-one error that omitted the final row of the exported spreadsheet.",
    "The developer removed duplicate spreadsheet columns to reduce the exported file size.",
    "The facilities manager fixed a leaking pipe beneath the kitchen sink.",
    "The facilities manager inspected the kitchen smoke alarm and replaced its battery.",
    "The travel coordinator cancelled a hotel reservation after the conference was postponed.",
    "The travel coordinator booked a return flight for a colleague attending the conference.",
    "The security team renewed a web server certificate before it expired.",
    "The security team disabled a stolen employee laptop and revoked its session tokens.",
    "The analyst anonymized customer email addresses before sharing a survey dataset.",
    "The analyst merged anonymous survey responses into the customer dashboard.",
];
export const prospectiveDocuments = [
    "The network administrator corrected a DNS record that sent the staging website to the wrong server.",
    "The network administrator restricted inbound traffic after discovering an exposed staging port.",
    "The finance clerk refunded a duplicated customer charge after checking the payment receipt.",
    "The finance clerk changed the customer's billing address before the next invoice.",
    "The instructor added captions to the training video so that deaf learners could follow the lesson.",
    "The instructor shortened the training video by removing repeated demonstrations.",
    "The gardener moved a wilting plant into shade and watered its dry soil.",
    "The gardener trimmed dead branches from a tree after a storm.",
];
export const ordinaryExpectations = [
    ...["recover lost records", "stop the app running out of RAM", "late supplier payment",
        "get the printer back online", "remove permissions after someone leaves", "reschedule a job interview"]
        .map((query, index) => required(query, [index * 2])),
    ...["encrypt the database backup", "order more RAM", "raise supplier prices", "replace printer toner",
        "recover deleted documents from the shared folder", "hire the candidate immediately"].map(forbidden),
];
// These retained contrast probes have allowed targets, but no primary required-set
// specification. Empty results establish only absence of forbidden additions.
const unspecified = (query, index) => ({ query, must: null, allowed: [index * 2] });
export const contrastInventories = [
    { name: "comparison", documents: comparisonDocuments, expectations: [
        ...["the spreadsheet download is missing its last record", "stop water dripping under the sink",
            "call off the room booking because the event moved", "keep the website TLS certificate valid",
            "remove identifying contact details from survey results"].map(unspecified),
        ...["restore a deleted spreadsheet", "install a new kitchen sink", "claim a flight delay refund",
            "reset the website administrator password", "send marketing emails to survey participants"].map(forbidden),
    ] },
    { name: "prospective", documents: prospectiveDocuments, expectations: [
        ...["make the test domain resolve to the right machine", "return the extra payment charged twice",
            "provide subtitles for hearing accessibility", "help the drooping plant recover from lack of water"].map(unspecified),
        ...["renew the staging website certificate", "increase the customer's subscription price",
            "translate the lesson into Spanish", "remove insects from the plant"].map(forbidden),
    ] },
];
export const workTemplates = [
    "The developer repaired a pagination defect that omitted older records from the export.",
    "The operator restored the database after a failed schema migration removed an index.",
    "The technician replaced the network cable because the warehouse printer was disconnected.",
    "The accountant reconciled the vendor invoice against three outstanding purchase orders.",
    "The administrator removed a former contractor from the engineering access group.",
    "The designer improved keyboard navigation through the report creation dialog.",
    "The support engineer renewed an expired client certificate on the internal gateway.",
    "The recruiter rescheduled a candidate interview because the interviewer was absent.",
    "The release manager rolled back a deployment after an increase in payment errors.",
    "The mechanic replaced a cracked hose and inspected the cooling system in the garage.",
    "The clinician discussed laboratory results and scheduled a follow-up examination.",
    "The analyst removed duplicate records before calculating the customer retention measure.",
    "The security engineer investigated repeated unsuccessful sign-ins from a test account.",
    "The facilities team repaired the ventilation fan after occupants reported excessive heat.",
    "The product manager reviewed feedback about confusing notification preferences.",
    "The researcher summarized the limitations of a small synthetic evaluation dataset.",
    "The coordinator cancelled the venue reservation after the workshop date changed.",
    "The librarian updated the catalogue after several books were returned late.",
    "The logistics planner rerouted a shipment because the usual bridge was closed.",
    "The developer fixed an integer overflow in the image resizing calculation.",
    "The engineer added a rollback guard around an irreversible database operation.",
    "The analyst compared monthly expenses with the department's approved budget.",
    "The team tested an offline model on invented documents and preserved the raw evidence.",
    "The editor corrected incorrect references in the accessibility documentation.",
    "The engineer reduced contention by releasing the writer lock before file parsing.",
    "The administrator changed a test printer's subnet after checking the approved inventory.",
    "The travel coordinator moved the return flight after the meeting was postponed.",
    "The developer handled a missing response body without reporting a false success.",
    "The quality lead separated missing observations from explicitly failed checks.",
    "The technician inspected a broken conveyor motor and ordered the correct replacement.",
    "The analyst masked contact details before preparing a reviewed survey report.",
    "The release manager verified immutable artifact hashes before sending the build for review.",
];
const projects = ["Orchid", "Aspen", "Cedar", "Maple", "Willow", "Birch", "Elm", "Pine", "Iris", "Juniper", "Laurel", "Moss"];
const reasons = ["availability", "permission", "compatibility", "correctness", "latency", "accessibility", "privacy", "recovery"];
export const repetitiveText = Array.from({ length: 800 }, (_, i) =>
    `The mechanic repaired a broken automobile in the garage. Job number ${i} was recorded in the maintenance ledger.`).join("\n");
export const variedText = Array.from({ length: 20 }, (_, cycle) => workTemplates.map((sentence, i) =>
    `${sentence} This was a ${reasons[(i + cycle) % reasons.length]} review for the invented ${projects[(i * 3 + cycle) % projects.length]} project in cycle ${cycle}.`).join("\n")).join("\n");
