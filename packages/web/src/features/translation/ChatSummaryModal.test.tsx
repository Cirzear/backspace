import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSummaryModal } from './ChatSummaryModal';
import { useChatStore } from '../../stores/chatStore';
import * as translationStore from './translationStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn(() => ({})),
  },
}));

vi.mock('./useMessageTranslation', () => ({
  useTranslationSettings: () => ({
    accountId: 'user-1',
    settings: {
      revision: 1,
      connections: [{ id: 'conn-1', name: 'OpenAI', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', hasKey: true }],
      preferences: {
        defaultConnection: 'conn-1',
        engine: null,
        targetLanguage: 'zh-CN',
        consent: true,
        automatic: false,
        showOriginal: true,
        summarizerEnabled: true,
      },
    },
  }),
}));

describe('ChatSummaryModal', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: new Map([
        [
          'channel-1',
          [
            {
              id: '1',
              channelId: 'channel-1',
              userId: 'u1',
              content: '今天讨论一下新功能上线的时间表',
              createdAt: Date.now() - 10000,
              user: { id: 'u1', username: 'alice', displayName: 'Alice' },
            } as any,
            {
              id: '2',
              channelId: 'channel-1',
              userId: 'u2',
              content: '我认为下周二发布比较稳妥',
              createdAt: Date.now() - 5000,
              user: { id: 'u2', username: 'bob', displayName: 'Bob' },
            } as any,
          ],
        ],
      ]),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('generates and renders summary for eligible messages', async () => {
    vi.spyOn(translationStore, 'sendTranslationCommand').mockResolvedValueOnce({
      ok: true,
      outputText: '1. 核心讨论：讨论新功能发布时间。\n2. 达成的共识：暂定下周二上线。',
    });

    render(
      <ChatSummaryModal
        isOpen={true}
        onClose={vi.fn()}
        channelId="channel-1"
        channelName="general"
      />
    );

    expect(await screen.findByText(/核心讨论：讨论新功能发布时间/)).toBeInTheDocument();
    expect(screen.getByText('copySummary')).toBeInTheDocument();
  });

  it('shows empty message notice when channel has no text messages', async () => {
    useChatStore.setState({ messages: new Map([['channel-empty', []]]) });

    render(
      <ChatSummaryModal
        isOpen={true}
        onClose={vi.fn()}
        channelId="channel-empty"
        channelName="empty-channel"
      />
    );

    expect(await screen.findByText('noMessagesToSummarize')).toBeInTheDocument();
  });
});
