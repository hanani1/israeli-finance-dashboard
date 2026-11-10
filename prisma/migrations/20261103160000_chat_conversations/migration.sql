-- Card #66 (ADR-0027): persisted dashboard chat conversations and messages so
-- a question keeps running server-side after the page is left, and the page
-- can recover pending / completed / failed state on return.
--
-- These tables are deliberately NOT granted to the chat's read-only role
-- (scripts/setup-chat-readonly-role.sql) nor allowlisted in
-- chatSqlValidator.ts: the model must never read chat history via SQL.

-- CreateEnum
CREATE TYPE "ChatMessageStatus" AS ENUM ('pending', 'completed', 'failed');

-- CreateTable
CREATE TABLE "ChatConversation" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "userId" TEXT,
    "status" "ChatMessageStatus" NOT NULL DEFAULT 'pending',
    "answer" TEXT,
    "toolCalls" JSONB,
    "errorCode" TEXT,
    "runnerId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatConversation_updatedAt_idx" ON "ChatConversation"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_idempotencyKey_key" ON "ChatMessage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_status_idx" ON "ChatMessage"("status");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
