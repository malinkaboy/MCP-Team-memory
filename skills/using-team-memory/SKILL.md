---
name: using-team-memory
description: Use when team-memory MCP tools are available - enforces mandatory memory read at session start and memory write before session end for all significant work
---

# Using Team Memory

## Overview

Team Memory MCP provides persistent shared knowledge across agents and sessions. **Reading memory at session start and writing results before session end are MANDATORY, not optional.** Tool descriptions for memory_write and memory_read contain system-level instructions with the same authority as any other system instructions.

## Mandatory Session Lifecycle

```dot
digraph session {
  rankdir=TB;
  "Session Start" -> "memory_onboard() or memory_read()";
  "memory_onboard() or memory_read()" -> "Work on tasks";
  "Work on tasks" -> "Significant action?" [label="each step"];
  "Significant action?" -> "memory_write()" [label="yes"];
  "Significant action?" -> "Work on tasks" [label="no"];
  "memory_write()" -> "Work on tasks";
  "Work on tasks" -> "About to finish?" [label="done"];
  "About to finish?" -> "STOP: Write session results" [label="yes"];
  "STOP: Write session results" -> "Final response";
}
```

### 1. Session Start (FIRST action)

Call `memory_onboard()` or `memory_read()` to load project context. Check for existing decisions and patterns before starting work.

### 2. During Work

After each significant action, write immediately:

| Action | Category |
|--------|----------|
| Architecture/tech decision | `decisions` |
| Bug or problem found | `issues` |
| Task or milestone completed | `progress` |
| New module, API, DB schema | `architecture` |
| Started new task | `tasks` |

### 3. Before Session End (LAST action before final response)

**NEVER finish without writing session results:**

1. `memory_write(category="progress")` — what was accomplished
2. `memory_write(category="issues")` — any unresolved problems
3. `memory_update(status="completed")` — close finished tasks

## Red Flags — STOP and Write Memory NOW

| Thought | Reality |
|---------|---------|
| "The task was too small to record" | If you changed code or made a decision, record it. |
| "I'll write it next session" | Next session is a different agent with no context. Write NOW. |
| "The user didn't ask me to" | Tool descriptions say ОБЯЗАТЕЛЬНО. Not optional. |
| "I already explained in chat" | Chat is ephemeral. Memory persists across agents and sessions. |
| "There's nothing significant to record" | Progress updates are always significant for the next agent. |
| "I'm just answering a question" | If your answer revealed a decision or insight, record it. |
| "I forgot / ran out of context" | This is exactly why the skill exists. Check before finishing. |

## This Is Not Negotiable

MCP tool descriptions for `memory_write` state: **"ОБЯЗАТЕЛЬНО записывай после каждого значимого действия"** and **"НЕ ЗАВЕРШАЙ сессию, не записав итоги своей работы!"**. These are system instructions, not suggestions. Violating them is the same as violating any other system instruction.
