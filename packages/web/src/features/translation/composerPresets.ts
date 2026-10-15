import type { ComposerAction } from '@backspace/shared/translation';

/**
 * Default actions available out-of-the-box.
 * User requirement: By default, ONLY 'polish' is retained.
 */
export const DEFAULT_COMPOSER_ACTIONS: ComposerAction[] = [
  {
    id: 'polish',
    label: '润色文笔',
    icon: '✨',
    systemPrompt:
      '你是一个专业的写作助手。请对用户的聊天草稿进行润色与优化，提升语句流畅度与表达清晰度，保持原意不变。直接输出修改后的文本，不要添加任何说明或客套话。',
    enabled: true,
  },
];

/**
 * Preset examples available as templates for users to add on demand.
 * Not active by default.
 */
export const PRESET_COMPOSER_EXAMPLES: Omit<ComposerAction, 'enabled'>[] = [
  {
    id: 'professional',
    label: '商务正式',
    icon: '💼',
    systemPrompt:
      '你是一个专业的职场沟通专家。请将用户的聊天草稿改写为礼貌、严谨、专业的商务职场语气。直接输出修改后的文本，不要添加任何解释。',
  },
  {
    id: 'concise',
    label: '简短精炼',
    icon: '⚡',
    systemPrompt:
      '你是一个沟通效率专家。请将用户的聊天草稿进行提炼和精简，去掉冗余字句，使其简明扼要。直接输出精简后的文本。',
  },
  {
    id: 'elaborate',
    label: '扩充丰富',
    icon: '📝',
    systemPrompt:
      '你是一个内容丰富助手。请在保留原意的前提下，适当补充细节和上下文，使其表达更详实充分。直接输出改写后的文本。',
  },
  {
    id: 'grammar',
    label: '纠正错别字与语法',
    icon: '🔍',
    systemPrompt:
      '你是一个严格的文字校对专家。请纠正用户草稿中的错别字、标点误用和语病。直接输出纠正后的文本。',
  },
  {
    id: 'translateToEnglish',
    label: '翻译为英文',
    icon: '🌐',
    systemPrompt:
      '你是一个专业翻译专家。请将用户的草稿翻译成地道、自然、准确的英文。直接输出翻译后的英文文本。',
  },
];

/**
 * Returns the localized label if a translation key exists (for built-in presets),
 * otherwise returns the user-defined label string.
 */
const PRESET_IDS = new Set(['polish', 'professional', 'concise', 'elaborate', 'grammar', 'translateToEnglish']);

export function getActionDisplayLabel(action: { id: string; label: string }, t: (key: any) => string): string {
  const translated = t(action.id);
  if (PRESET_IDS.has(action.id) || (translated && translated !== action.id)) {
    return translated;
  }
  return action.label;
}

export const TARGET_LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  zh: '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  ru: 'Русский',
  ar: 'العربية',
};

export function getTargetLanguageName(lang?: string | null): string {
  if (!lang) return '简体中文';
  return TARGET_LANGUAGE_NAMES[lang] || TARGET_LANGUAGE_NAMES[lang.split('-')[0] ?? ''] || lang;
}
