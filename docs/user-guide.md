# Use WIRE

WIRE reads supported, approved local GitHub Copilot app history. It helps you
inspect recorded Work IQ activity, find retained text and prepare reviewed
reports. It does not rerun your prompts or judge answer correctness.

Follow [setup](../README.md#start) first. The examples below use invented data,
not a person's account or workplace history.

## Read the overview

**Analyze** shows recorded outcomes, activity over time, tools, services and
available response-model names. The interactions below use the same accepted
filters. Open **Filters** to change Dates, Tool, Service involved, Outcome or
Prompt author; **More filters** holds the additional choices.

![Analyze showing 10 calls in 8 interactions, tool outcomes and separate service associations.](images/analyze.png)

*Mock data: 8 interactions contain 10 calls. The missing model names are
unavailable evidence, not zero model usage. Retained activity remains readable
even while collection is disconnected.*

Start with the count and unit. One interaction can contain several calls; a
call can involve more than one service. Service shares can therefore overlap.
Tool completion means the source recorded completion, not that the answer was
correct. Returned API entries, Graph call sites and HTTP recorder captures
have their own units and must not be added to tool-call totals.

Dates filter retained activity; they do not approve older source reads.
Custom dates include both days in the selected display time zone. Missing
history and records without qualified times remain explicit. No matches means
no matching retained evidence, not proof that no activity occurred.

Author and Outcome choices remain a draft until **Apply**. **Reset filters**
clears browsing restrictions, not collected activity or report selections.
**Chart guide** explains the displayed measures and provides exact numbers.

## Inspect an interaction

Open a card to read its prompt and recorded activity in the right-hand reader.
Each call keeps its own result, timing and available error details. Open a
call's disclosure for exact input; **Source details** holds provenance and
identifiers. Close or Back returns to the originating results.

Drag the reader's left edge or use its minus/plus buttons to narrow or widen
it. **Maximize interaction** fills the workspace below the toolbar;
**Restore reader width** returns to your chosen width while keeping your place.
**Close interaction** leaves the reader instead. When space is limited, WIRE
uses a single-pane reader and hides the sizing controls.

![An interaction reader beside its card, showing a failed call and its separately attributed returned HTTP results.](images/interaction.png)

*The failed call and its returned HTTP entries are different evidence.
WIRE does not reconstruct error details that were not saved.*

**My prompt**, **Agent prompt** and **Author unverified** describe supported
origin evidence, not who executed or authorized every call. Choosing My and
Agent is not the same as All, which also includes unverified authors.

**Tool latency** is the recorded call interval. **Prompt to final response**
has a separate qualified message-to-response boundary; concurrent calls are
not added into a task duration. Missing timing is not zero.

Copy controls copy the exact retained original, unmasked. A saved Copilot reply
is the assistant's text, not a tool result. Reply saving starts off and requires
separate approval in **Settings > Privacy & saved data > Recorded replies**.
Enabling it does not restore previously omitted replies.

**Add to report** changes selection only. To choose contents and create a
file, continue with [Create and compare reports](reporting.md).

## Find saved text

Type in the stationary **Search** field. Results appear as you type; there is
no Submit step. `POWER` and `owerp` both find `PowerPoint`. A phrase matches
that literal sequence, not scattered words, inferred intent or synonyms.

![Search for POWER returning two interaction matches and a matching excerpt from a saved report.](images/literal-search.png)

*Everywhere finds items without narrowing Analyze. This example also says saved
replies are unavailable for Search; three matches do not establish complete
coverage of those replies.*

**Everywhere** searches authorized retained content and navigation destinations
across pages. **Current Analyze scope** deliberately narrows the analytical
population and current-view report membership. Selected interactions and All
collected activity report scopes remain separate.

Open a result to inspect its exact verified destination. Back restores the
Search context while it remains authorized. Missing, changed or unreadable
content is not silently replaced with a nearby result. Search runs locally,
without AI, providers, new collection or credit spending. Its query is not
placed in URLs or saved as a persistent Search index.

## Keep collection and saved data separate

**Settings > Connection & updates** owns source approval, history window,
check frequency and Pause. **Refresh** checks approved local history;
**Read stored activity** only rereads WIRE's retained view. Paused collection
stays paused after a deliberate local-history check. **Collection status**
explains missing files, bounded reads and other known coverage gaps.

**Sign out of WIRE** stops collection and hides saved private activity without
deleting it or signing other applications out. A neutral Account icon means
WIRE has no verified desktop-selected profile, not that collection needs a
different GitHub CLI login.

In **Privacy & saved data**, **Review deletion** previews an exact activity
scope before separate confirmation. **Read history again > Choose chats**
is a different, deliberate reread of selected approved history; restoring
deleted original prompts is an independent choice. Neither filter reset nor
ordinary Refresh performs these actions. Saved reports and external downloads
can retain copies after activity deletion.

If a change's result is uncertain, use its offered status/result check rather
than repeating the action. See [collection and recovery](collection.md) for
the exact effects and limits, and [reports](reporting.md#compare) to compare
retained periods or saved reports.
