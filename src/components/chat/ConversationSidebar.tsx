'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { LoaderCircle, MessagesSquare, SquarePen, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ConversationListEntry } from '@/lib/services/chatConversationList';
import { cn } from '@/lib/utils';

interface ListProps {
  conversations: ConversationListEntry[];
  activeId: string | null;
  loading: boolean;
  newChatDisabled: boolean;
  onSelect(id: string): void;
  onNewChat(): void;
}

/**
 * The chat-only conversation list (card #67): "New conversation" plus the
 * recent conversations, most recently updated first, the active one
 * highlighted, a spinner on ones still answering. Rendered as a column on
 * md+ and inside ConversationDrawer below md. Global navigation is untouched.
 */
export function ConversationList({ conversations, activeId, loading, newChatDisabled, onSelect, onNewChat }: ListProps) {
  const t = useTranslations('chat');
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        className="h-11 justify-start gap-2 md:h-9"
        onClick={onNewChat}
        disabled={newChatDisabled}
        data-testid="chat-new"
      >
        <SquarePen className="h-4 w-4" aria-hidden />
        {t('newChat')}
      </Button>
      <h2 className="px-1 pt-1 text-xs font-medium text-muted-foreground">{t('conversations')}</h2>
      <nav aria-label={t('conversations')} className="min-h-0 flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{loading ? t('loadingConversations') : t('noConversations')}</p>
        ) : (
          <ul className="space-y-0.5" data-testid="chat-conversations">
            {conversations.map((conversation) => {
              const active = conversation.id === activeId;
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(conversation.id)}
                    aria-current={active ? 'true' : undefined}
                    data-conversation-id={conversation.id}
                    title={conversation.title}
                    className={cn(
                      'flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 py-2 text-start text-sm transition-colors md:min-h-9',
                      active ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
                    )}
                  >
                    <span dir="auto" className="min-w-0 flex-1 truncate">
                      {conversation.title}
                    </span>
                    {conversation.pending && (
                      <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label={t('answering')} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </div>
  );
}

/** Below md: the same list in a start-edge drawer behind a button. */
export function ConversationDrawer({
  open,
  onOpenChange,
  ...listProps
}: ListProps & { open: boolean; onOpenChange(open: boolean): void }) {
  const t = useTranslations('chat');
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Trigger asChild>
        <Button type="button" variant="outline" className="h-10 gap-2 md:hidden" data-testid="chat-drawer-open">
          <MessagesSquare className="h-4 w-4" aria-hidden />
          {t('conversations')}
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 md:hidden" />
        <DialogPrimitive.Content
          data-testid="chat-drawer"
          className="fixed inset-y-0 start-0 z-50 flex w-[85vw] max-w-xs flex-col gap-3 border-e bg-card p-3 pt-[max(env(safe-area-inset-top),0.75rem)] pb-[max(env(safe-area-inset-bottom),0.75rem)] shadow-2xl md:hidden"
        >
          <div className="flex items-center justify-between">
            <DialogPrimitive.Title className="text-sm font-semibold">{t('conversations')}</DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label={t('closeConversations')}
              className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-accent"
            >
              <X className="h-4 w-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="sr-only">{t('conversationsHint')}</DialogPrimitive.Description>
          <ConversationList
            {...listProps}
            onSelect={(id) => {
              listProps.onSelect(id);
              onOpenChange(false);
            }}
            onNewChat={() => {
              listProps.onNewChat();
              onOpenChange(false);
            }}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
