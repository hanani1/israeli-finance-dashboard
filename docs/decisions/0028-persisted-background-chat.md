# ADR-0028: Persisted chat conversations with background runs and a chat-only sidebar

- **Date:** 2026-11-03
- **Status:** Accepted (amends ADR-0026 §5 "Retention" and its "persistent chat history" non-goal)
- **Area:** AI / Reliability / UI / Privacy
- **Owners:** Finance Dashboard maintainers

## Context

ADR-0026 kept chat history in server memory (15-minute TTL), and `POST /api/chat` waited
for the whole model loop. That loop can take several CLI rounds of up to 120 s each.
Leaving or refreshing `/chat` lost the pending answer, and a restart lost every
conversation. Trello #66 asks that a question keep running after the user leaves, that the
page recover pending, completed and failed state, and that a question never run twice.
Trello #67 asks for a ChatGPT-style conversation list on `/chat` only.

## Decision

1. **Postgres stores the conversations.** Migration `20261103160000_chat_conversations`
   adds two tables:
   - `ChatConversation(id, title, createdAt, updatedAt)`. The title is the first question
     with whitespace collapsed, cut to 60 characters, and never changed afterwards.
   - `ChatMessage`. Each row holds one question and its answer, with `status` (`pending` |
     `completed` | `failed`), `answer`, `toolCalls` (the lookup summaries only, never
     raw rows), `errorCode` (a curated code, never CLI stderr), `idempotencyKey` (unique),
     `userId` (the member filter the question was asked under), `runnerId`, `attempts`,
     `startedAt`, `completedAt`, `createdAt` and `updatedAt`.
2. **Questions run in the background, in the app process.** `POST /api/chat` validates the
   request, rate limits it, inserts a pending row and returns at once: 202, or 200 for a
   replayed key. The loop then runs on the process-wide serialized queue, so the
   serialization and rate limit from ADR-0026 still hold. It does not depend on the HTTP
   request. The page polls `GET /api/chat/conversations/[id]` every 1.5 s while a question
   is pending. The app runs on a single host, so we use no job queue or worker. The cost
   is that a run does not survive a restart (point 4).
3. **A pure state machine controls status changes** (`chatConversation.ts`):
   `pending → completed` is terminal, `pending → failed`, and `failed → pending` only through
   an explicit retry. Every write is a compare-and-set on (`status`, `runnerId`). A late
   result from a run that was already recovered therefore cannot overwrite newer state,
   and a completed answer is never re-run.
4. **Recovering pending rows that can no longer finish.** Each server process has a random
   `runnerId`. A pending row whose `runnerId` is not the current one belongs to a dead
   process, so it is marked `failed/interrupted`. This check runs when the service first
   starts and again before every view, list, submit or retry. Our own pending rows also
   fail with `timeout` in two cases. The first is a run older than rounds × `CHAT_TIMEOUT_MS`
   + 60 s; the CLI and DB timeouts should end such a run first, so this is only a backstop.
   The second is a row that has waited in the queue for more than 60 minutes. A failed
   message shows a localized error with a **Try again** button
   (`POST /api/chat/messages/[id]/retry`), which re-runs it in place.
5. **Idempotency.** The client generates a 128-bit key per question
   (`crypto.getRandomValues`, which also works on plain-http LAN origins). It stores the
   pending send in `sessionStorage` until the server answers and posts with
   `keepalive: true`, so the request survives a page close. A refresh replays the stored
   send with the same key and gets the same message back. If the key exists with a
   different question, the server returns 409 `idempotency-conflict`. A unique-violation
   race resolves to the existing row. If a conversation already has a pending question, a
   second question returns 409 `busy`.
6. **The history replayed to the model comes from the database.** It is made of the
   completed turns before the question in the same conversation. The ADR-0026 caps still
   apply: 6 turns, 8,000 characters, and 2,000 characters per answer. The in-memory
   `ChatHistoryStore` is removed, and the conversation id replaces the old `sessionKey`.
7. **The model cannot read chat history.** `ChatConversation` and `ChatMessage` are not in
   `CHAT_TABLE_COLUMNS`, so the validator rejects them (this is tested), and
   `setup-chat-readonly-role.sql` does not grant them. `chatReadonlyDb.verifyRole` now
   also refuses to run when `CHAT_DB_URL` can SELECT either table. The rows are read and
   written only through the app's read-write client.
8. **Nothing secret reaches the client.** Responses carry ids, the question, the answer,
   the lookup summaries and an error code. They do not carry `runnerId`, `userId`, CLI
   output or configuration. The browser stores only the active conversation id
   (`localStorage`) and the pending send (`sessionStorage`).
9. **Every chat route has the same gate.** The routes are `GET /api/chat/conversations`,
   `GET /api/chat/conversations/[id]` and `POST /api/chat/messages/[id]/retry`. Like
   `POST /api/chat`, each needs `CHAT_ENABLED` and `isLoopbackRequest`
   (`chatHttp.chatAccessDenied`), sits behind the middleware CSRF/Host guard, and is
   wrapped in `withRouteErrors` (ADR-0027).
10. **The conversation sidebar appears only on `/chat`** (#67). It lists the 50 most
    recently updated conversations, highlights the active one, offers "New conversation",
    and loads a conversation when you select it. It shows a pending marker while a
    question is running. On screens narrower than `md` the list opens as a drawer from the
    start edge behind a button, which keeps it RTL-aware. The global Sidebar and BottomNav
    do not change. The list comes from `GET /api/chat/conversations`. Local updates go
    through `chatConversationList.upsertConversation`, which keeps the order stable and
    never changes a title. While another conversation is pending, the list re-polls every
    3 s.

## Consequences

### Positive
- Leaving or refreshing `/chat`, or closing the tab, no longer loses a question. The answer
  is there on return, and a refresh or double-submit never runs the question twice.
- No conversation is stuck "thinking" forever. A restart or timeout ends as a failed message
  with a retry button.
- Conversations survive restarts and can be revisited from the sidebar.

### Negative / risks
- **Retention changes.** Questions and answers now live in plaintext in the finance
  database with no automatic expiry. Answers can quote amounts, balances and merchant
  names, but they never contain credentials or account numbers, which the chat cannot
  read. Before this change nothing was persisted. Database backups and dumps now include
  chat history. Deleting conversations and a retention window are follow-ups.
- A question that is running when the app restarts is not resumed. It becomes
  `interrupted` and must be retried by hand. This is deliberate: an automatic re-run after
  a crash could run a question twice.
- Polling adds one small request every 1.5 s, and only while a question is pending.

## Alternatives considered
- **A durable job table plus a separate worker.** Rejected for now. The app runs as one
  process on one host, and the worker would need the CLI and the read-only role. The
  process-local queue plus `runnerId` recovery covers the acceptance criteria.
- **Server-sent events or streaming instead of polling.** Deferred. Polling is simpler,
  works through the existing guards, and recovers naturally after a refresh.
- **Granting the chat role SELECT on the history** so the model could "remember". Rejected.
  The server already replays a capped history, and SQL access would let a prompt-injected
  question read all past conversations.

## References
- Trello #66, #67; ADR-0026 (chat design), ADR-0027 (`withRouteErrors`)
- `src/lib/services/chatConversation.ts`, `chatStore.ts`, `chatService.ts`, `chatHttp.ts`
- `src/app/api/chat/**`, `src/app/chat/page.tsx`
