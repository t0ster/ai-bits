# Simple AI SDK Chat

An anonymous visitor's chat with a generic assistant, stored as durable threads.

## Language

**Thread**:
A persisted conversation belonging to a visitor.

**Selected thread**:
The thread a visitor returns to when reopening chat. A visitor may have no selected thread before sending a message or after choosing to start over.

**Initial history**:
The completed messages supplied when a thread is first created, ending with the user message awaiting a response.

**Model tool**:
A tool the model may call during generation (`getCurrentTime`, `rollDice`). Its call and result persist as tool parts of the assistant message.

**Command**:
A slash message (`/help`) answered by the backend without a model call. Its reply is a display-only tool part, never advertised to the model.
