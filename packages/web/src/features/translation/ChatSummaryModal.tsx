import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/ui/Modal';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useTranslationSettings } from './useMessageTranslation';
import { sendTranslationCommand } from './translationStore';
import { translationErrorText } from './errorText';
import { getTargetLanguageName } from './composerPresets';
import { ChatDatePicker } from './ChatDatePicker';
import type { MessageWithUser } from '@backspace/shared';

const EMPTY_MESSAGES: MessageWithUser[] = [];

export type SummaryScopeMode = 'unread' | 'date';

function getTodayIsoDate(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function filterSummaryMessages(
  messages: MessageWithUser[],
  mode: SummaryScopeMode,
  options: { lastReadId?: string | null; selectedDate?: string },
): MessageWithUser[] {
  const eligible = messages.filter((m) => !!m.content && !m.id.startsWith('temp_'));
  if (mode === 'date') {
    const targetDate = options.selectedDate ?? getTodayIsoDate();
    const dayStart = new Date(`${targetDate}T00:00:00`).getTime();
    const dayEnd = new Date(`${targetDate}T23:59:59.999`).getTime();
    return eligible.filter((m) => m.createdAt >= dayStart && m.createdAt <= dayEnd);
  }
  // Mode unread
  if (options.lastReadId) {
    const idx = eligible.findIndex((m) => m.id === options.lastReadId);
    if (idx !== -1) {
      return eligible.slice(idx + 1);
    }
  }
  return eligible;
}

interface ChatSummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  channelId: string;
  channelName: string;
}

export function ChatSummaryModal({ isOpen, onClose, channelId, channelName }: ChatSummaryModalProps) {
  const { t } = useTranslation('translation');
  const { accountId, settings } = useTranslationSettings();
  const messages = useChatStore((s) => s.messages.get(channelId)) ?? EMPTY_MESSAGES;
  const readStates = useChatStore((s) => s.readStates);
  const lastReadId = readStates.get(channelId);

  const [mode, setMode] = useState<SummaryScopeMode>('unread');
  const [selectedDate, setSelectedDate] = useState<string>(getTodayIsoDate);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const currentFilteredMessages = useMemo(
    () => filterSummaryMessages(messages, mode, { lastReadId, selectedDate }),
    [messages, mode, lastReadId, selectedDate],
  );

  const messageDates = useMemo(() => {
    const dates = new Set<string>();
    for (const m of messages) {
      if (m.content && !m.id.startsWith('temp_')) {
        const d = new Date(m.createdAt);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        dates.add(`${year}-${month}-${day}`);
      }
    }
    return dates;
  }, [messages]);

  const handleGenerate = useCallback(async () => {
    if (!accountId) return;

    if (messages.length === 0) {
      setError(t('noMessagesToSummarize'));
      return;
    }

    if (currentFilteredMessages.length === 0) {
      setError(mode === 'unread' ? t('noUnreadMessages') : t('noDateMessages'));
      return;
    }

    setLoading(true);
    setError(null);

    // Safeguard: take up to 80 messages, cap dialogue string at 25,000 characters
    const dialogue = currentFilteredMessages
      .slice(-80)
      .map((m) => `${m.user.displayName || m.user.username}: ${m.content}`)
      .join('\n')
      .slice(-25000);

    const targetLang = settings?.preferences.targetLanguage || 'zh-CN';
    const targetLangName = getTargetLanguageName(targetLang);

    const systemPrompt =
      `你是一个专业的聊天会话摘要助手。请根据提供的群组或私聊对话历史，提取并结构化整理出讨论摘要。` +
      `【语言要求】：请务必使用【${targetLangName}】输出摘要内容。\n` +
      `格式清晰，包括：\n` +
      `1. 核心讨论要点\n` +
      `2. 达成的决议或共识\n` +
      `3. 待办事项或后续行动（若有，标注责任人）\n` +
      `语言表达简洁、准确、地道。`;

    const scopeDesc =
      mode === 'unread' ? '未读消息记录' : `「${selectedDate}」当天的对话记录`;

    const userPrompt = `以下是「${channelName}」的${scopeDesc}（按时间先后顺序）：\n\n${dialogue}\n\n请生成结构化摘要：`;

    const reply = await sendTranslationCommand({
      action: 'aiGenerate',
      accountId,
      systemPrompt,
      userPrompt,
      connectionId: settings?.preferences.summarizerConnection,
    });

    setLoading(false);
    if (reply.ok && 'outputText' in reply) {
      setSummary(reply.outputText);
    } else if (!reply.ok) {
      setError(translationErrorText(reply));
    }
  }, [
    accountId,
    channelName,
    currentFilteredMessages,
    messages.length,
    mode,
    selectedDate,
    settings?.preferences.summarizerConnection,
    settings?.preferences.targetLanguage,
    t,
  ]);

  useEffect(() => {
    if (isOpen && !summary && !loading && !error && currentFilteredMessages.length > 0) {
      void handleGenerate();
    }
  }, [isOpen, summary, loading, error, currentFilteredMessages.length, handleGenerate]);

  useEffect(() => {
    if (isOpen && messages.length === 0) {
      setError(t('noMessagesToSummarize'));
    }
  }, [isOpen, messages.length, t]);

  const handleCopy = () => {
    if (!summary) return;
    void navigator.clipboard.writeText(summary).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const hasConnection = !!(settings?.preferences.summarizerConnection || settings?.preferences.defaultConnection);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`${t('summaryTitle')} — #${channelName}`} maxWidth="max-w-xl">
      <div className="space-y-4">
        {/* Scope selector tabs */}
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-white/[0.06]">
          <div className="flex bg-white/[0.04] rounded-lg p-0.5 border border-white/[0.06]">
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setMode('unread');
                setSummary(null);
                setError(null);
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                mode === 'unread'
                  ? 'bg-accent-primary/20 text-accent-primary border border-accent-primary/30'
                  : 'text-txt-tertiary hover:text-txt-secondary'
              }`}
            >
              📩 {t('summaryModeUnread')}
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setMode('date');
                setSummary(null);
                setError(null);
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                mode === 'date'
                  ? 'bg-accent-primary/20 text-accent-primary border border-accent-primary/30'
                  : 'text-txt-tertiary hover:text-txt-secondary'
              }`}
            >
              📅 {t('summaryModeDate')}
            </button>
          </div>

          <div className="flex items-center gap-2">
            {mode === 'date' && (
              <ChatDatePicker
                value={selectedDate}
                disabled={loading}
                messageDates={messageDates}
                onChange={(newDate) => {
                  setSelectedDate(newDate);
                  setSummary(null);
                  setError(null);
                }}
              />
            )}
            <span className="text-[11px] text-txt-tertiary">
              {t('messagesCountFound', { total: currentFilteredMessages.length })}
            </span>
          </div>
        </div>

        {!hasConnection ? (
          <div className="rounded-lg border border-accent-amber/30 bg-accent-amber/10 p-4 text-sm text-txt-secondary space-y-2">
            <p>{t('missing-connection', { defaultValue: '请先配置 AI 连接。' })}</p>
            <button
              type="button"
              className="rounded px-3 py-1.5 bg-accent-primary text-white text-xs font-medium hover:bg-accent-primary-hover transition-colors"
              onClick={() => {
                onClose();
                useUIStore.getState().openModal('userSettings', { tab: 'translation' });
              }}
            >
              {t('title')}
            </button>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center py-12 space-y-3">
            <div className="w-6 h-6 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-txt-tertiary">{t('generatingSummary')}</p>
          </div>
        ) : error ? (
          <div className="space-y-3 py-4">
            <p role="alert" className="rounded-lg border border-accent-rose/30 bg-accent-rose/10 p-3 text-sm text-txt-danger">
              {error}
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                className="px-3 py-1.5 rounded bg-accent-primary hover:bg-accent-primary-hover text-xs font-medium text-white transition-colors"
                onClick={() => void handleGenerate()}
              >
                {t('generateSummary')}
              </button>
            </div>
          </div>
        ) : summary ? (
          <div className="space-y-4">
            <div className="max-h-[calc(60*var(--app-vh))] overflow-y-auto rounded-lg bg-white/[0.03] border border-white/[0.06] p-4 text-sm text-txt-primary whitespace-pre-wrap leading-relaxed select-text">
              {summary}
            </div>
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                className="px-3 py-1.5 rounded text-xs text-txt-tertiary hover:text-txt-primary hover:bg-white/[0.06] transition-colors"
                onClick={() => void handleGenerate()}
              >
                {t('regenerate')}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="px-4 py-2 rounded bg-accent-primary hover:bg-accent-primary-hover text-xs font-medium text-white transition-colors"
                  onClick={handleCopy}
                >
                  {copied ? t('copied') : t('copySummary')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center py-8">
            <button
              type="button"
              className="px-4 py-2 rounded bg-accent-primary hover:bg-accent-primary-hover text-xs font-medium text-white transition-colors"
              onClick={() => void handleGenerate()}
            >
              {t('generateSummary')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
