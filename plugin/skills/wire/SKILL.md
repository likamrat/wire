---
name: wire
description: Answers questions about the user's recorded Work IQ activity with WIRE (Work IQ Request Explorer). Use when the user asks what their Work IQ prompts, tool calls or results did, why a Work IQ call failed, how often something happened, to find a past prompt or reply, or to open WIRE.
---

# WIRE

WIRE keeps a local, on-device record of the user's GitHub Copilot app conversations that used Work IQ: the prompt, the Work IQ tool calls, and what each call returned. It runs inside the Copilot app. The first WIRE tool call or canvas open starts it if it isn't already running.

## Choose the right tool

| The user wants to… | Use |
| --- | --- |
| Know whether WIRE is collecting, from which source, and how much it holds | `wire_status` |
| Count or compare activity: prompts, calls, returned entries, outcomes, services, authors, failure reasons | `wire_analytics` |
| Find a specific prompt, reply, action or saved report by its words | `wire_search` |
| Look through evidence, read a full conversation, or prepare a report | Open the WIRE canvas |

To open the canvas, call `open_canvas` with `canvasId: "workiq-evidence-board"` and no input. Reuse the same `instanceId` to bring an open panel back.

## Answering well

- Name the specific tool or API operation and its recorded outcome, including any recorded error code, status and reason. "A call failed" is not an answer.
- Keep the units straight: a prompt can make several tool calls, and a call can return several entries. Say which one a number counts.
- `wire_search` is literal, case-insensitive text matching. It doesn't infer meaning, so try the user's exact words, then shorter fragments.
- If `wire_status` shows collection paused, not approved or failing, say so before giving numbers; the counts may be incomplete.
- Search can't read text inside saved PDF reports while WIRE runs in the Copilot app. Search coverage lists this as an issue; mention it when the user is looking for report content.

## What stays with the user

- Approving a history source, pausing collection, deleting evidence and saving reports are the user's decisions. Do them in the canvas only when the user asks. Never confirm a report's disclosure on the user's behalf.
- The tools only read. They never change WIRE's evidence.

## If WIRE won't start

The tool or canvas error names the cause. Usually another program is using port 4000, or the data folder was written by a newer WIRE. Report the message as it is. Update the plugin with `copilot plugin update wire`.
