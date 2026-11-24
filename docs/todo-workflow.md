# Using a TODO list with steers

A shared `TODO.md` is an optional way to keep track of work across agents and sessions. You can keep using your issue tracker or work directly in chat.

When a follow-up comes to mind, start a message with `TODO:` and describe the outcome you want. In this workflow, the active steer adds it to the project list, combines it with any existing item for the same work, and records dependencies that affect when it can start. For example, `TODO: Document how to adopt an existing steer from the Paseo composer` can sit alongside the feature it depends on.

When you ask the steer to continue the TODOs, it works through the actionable items. It can delegate independent pieces to workers, review their results, and mark items complete once it has verified them. It works on other items while workers run or a decision is pending. When the remaining work requires input, it records the outstanding decisions in its checkpoint.

The list tracks what is left across the project. A [checkpoint](steer-instructions.md#answer-format) records the current task, its verification, and the next step so another steer can pick it up after a handoff.
