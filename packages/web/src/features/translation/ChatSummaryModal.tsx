import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/ui/Modal';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useTranslationSettings } from './useMessageTranslation';
import { sendTranslationCommand } from './translationStore';
import { translationErrorText } from './errorText';

interface ChatSummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  channelId: string;
  channelName: string;
}

export function ChatSummaryModal({ isOpen, onClose, channelId, channelName }: ChatSummaryModalProps) {
  const { t } = useTranslation('translation');
  const { accountId, settings } = useTranslationSettings();
  const messages = useChatStore((s) => s.messages.get(channelId) ?? []);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleGenerate = useCallback(async () => {
    if (!accountId) return;
    const eligibleMessages = messages
      .filter((m) => !!m.content && !m.id.startsWith('temp_'))
      .slice(-80);

    if (eligibleMessages.length === 0) {
      setError(t('noMessagesToSummarize'));
      return;
    }

    setLoading(true);
    setError(null);

    const dialogue = eligibleMessages
      .map((m) => `${m.user.displayName || m.user.username}: ${m.content}`)
      .join('\n');

    const reply = await sendTranslationCommand({
      action: 'aiGenerate',
      accountId,
      systemPrompt:
        '你是一个专业的聊天会话摘要助手。请根据提供的群组或私聊对话历史，提取并结构化整理出讨论摘要。格式清晰，包括：\n1. 核心讨论要点\n2. 达成的决议或共识\n3. 待办事项或后续行动（若有，标注责任人）\n语言请与对话内容保持一致，简洁准确。',
      userPrompt: `以下是「${channelName}」的最近对话记录（按时间先后顺序）：\n\n${dialogue}\n\n请生成结构化摘要：`,
      connectionId: settings?.preferences.summarizerConnection,
    });

    setLoading(false);
    if (reply.ok && 'outputText' in reply) {
      setSummary(reply.outputText);
    } else if (!reply.ok) {
      setError(translationErrorText(reply));
    }
  }, [accountId, channelName, messages, settings?.preferences.summarizerConnection, t]);

  useEffect(() => {
    if (isOpen && !summary && !loading && !error) {
      void handleGenerate();
    }
  }, [isOpen, summary, loading, error, handleGenerate]);

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
                className="px-3 py-1.5 rounded bg-white/[0.06] hover:bg-white/[0.1] text-xs font-medium text-txt-primary transition-colors"
                onClick={() => void handleGenerate()}
              >
                {t('retry')}
              </button>
            </div>
          </div>
        ) : summary ? (
          <div className="space-y-4">
            <div className="max-h-[60vh] overflow-y-auto rounded-lg bg-white/[0.03] border border-white/[0.06] p-4 text-sm text-txt-primary whitespace-pre-wrap leading-relaxed select-text">
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
        ) : null}
      </div>
    </Modal>
  );
}
