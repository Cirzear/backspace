import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { MemberWithUser } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { useSpaceStore } from '../../stores/spaceStore';
import type { MentionOption } from './mentionOptions';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { useUIStore } from '../../stores/uiStore';


function MentionMemberRow({
  member,
  isSelected,
  selectedRef,
  onSelect,
  roleColor,
  mobile,
}: {
  member: MemberWithUser;
  isSelected: boolean;
  selectedRef: React.RefObject<HTMLDivElement>;
  onSelect: (member: MemberWithUser) => void;
  roleColor: string | undefined;
  mobile: boolean;
}) {
  const canonical = useCanonicalUserView(member.user);
  const displayName = canonical.displayName ?? canonical.username;
  // Mobile: ≥44 px tap target per Apple HIG; desktop: compact list.
  const rowSizing = mobile
    ? 'gap-3 px-3 py-2.5 min-h-[44px]'
    : 'gap-2.5 px-2 py-1.5';
  return (
    <div
      ref={isSelected ? selectedRef : undefined}
      onClick={() => onSelect(member)}
      className={`flex items-center mx-1 rounded cursor-pointer transition-colors ${rowSizing} ${
        isSelected ? 'bg-interactive-selected' : 'hover:bg-interactive-hover'
      }`}
    >
      <Avatar
        src={canonical.avatar}
        name={displayName}
        size={mobile ? 28 : 24}
        status={canonical.status}
        userId={canonical.homeUserId ?? canonical.id}
        user={canonical}
      />
      <span
        className={`${mobile ? 'text-[15px]' : 'text-[14px]'} font-medium truncate`}
        style={roleColor ? { color: roleColor } : undefined}
      >
        {displayName}
      </span>
      {canonical.displayName && (
        <span className="text-[12px] text-txt-tertiary truncate">
          @{canonical.username}
        </span>
      )}
    </div>
  );
}

interface MentionPopoverProps {
  options: MentionOption[];
  selectedIndex: number;
  onSelect: (option: MentionOption) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function MentionPopover({ options, selectedIndex, onSelect, anchorRef }: MentionPopoverProps) {
  const { t } = useTranslation('common');
  const mobile = useUIStore(s => s.isMobile);
  const ownerId = useSpaceStore(s => s.spaces.find(space => space.id === s.currentSpaceId)?.ownerId);
  const selectedRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const { style } = useFloatingPosition(anchorRef, floatingRef, { placement: 'top', align: 'start', offset: 4, enabled: options.length > 0 });
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: 'nearest' }); }, [selectedIndex]);
  if (!options.length) return null;
  return createPortal(<>
    <div ref={floatingRef} style={style}
      className="w-[280px] max-w-[calc(100*var(--app-vw)-16px)] glass rounded-lg max-h-[320px] overflow-y-auto scrollbar-thin">
      <div className="px-2 py-1.5 text-[11px] font-bold text-txt-tertiary">{t('labels.suggestions')}</div>
      {options.map((option, index) => {
        if (option.kind === 'user') {
          const member = option.member;
          const role = [...(member.roles ?? [])].sort((a, b) => b.position - a.position)[0];
          return <MentionMemberRow key={option.token} member={member} isSelected={index === selectedIndex}
            selectedRef={selectedRef} onSelect={() => onSelect(option)} roleColor={role?.color ?? (member.userId === ownerId ? '#fda4af' : undefined)} mobile={mobile} />;
        }
        return <div key={option.token} ref={index === selectedIndex ? selectedRef : undefined}
          onClick={() => onSelect(option)} style={{ color: option.color }}
          className={'flex items-center mx-1 px-3 rounded cursor-pointer min-h-[44px] ' + (index === selectedIndex ? 'bg-interactive-selected' : 'hover:bg-interactive-hover')}>
          {option.label}
        </div>;
      })}
    </div>
  </>, document.body);
}
