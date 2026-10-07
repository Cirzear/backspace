import { describe, it, expect } from 'vitest';
import { PermissionBits } from './permissions';
import { withOverrideBits } from './overrideBits';

const VIEW = PermissionBits.VIEW_CHANNEL;
const SEND = PermissionBits.SEND_MESSAGES;
const REACT = PermissionBits.ADD_REACTIONS;

describe('withOverrideBits', () => {
  it('denies a bit and keeps every other bit of the row', () => {
    expect(withOverrideBits({ allow: REACT, deny: SEND }, VIEW, 'deny')).toEqual({ allow: REACT, deny: SEND | VIEW });
  });

  it('moves a bit from allow to deny and back', () => {
    expect(withOverrideBits({ allow: VIEW | REACT, deny: 0n }, VIEW, 'deny')).toEqual({ allow: REACT, deny: VIEW });
    expect(withOverrideBits({ allow: 0n, deny: VIEW | SEND }, VIEW, 'allow')).toEqual({ allow: VIEW, deny: SEND });
  });

  it('clears a bit to neutral and keeps the rest', () => {
    expect(withOverrideBits({ allow: 0n, deny: VIEW | SEND }, VIEW, 'neutral')).toEqual({ allow: 0n, deny: SEND });
  });

  it('answers null when the row would set nothing, which removes it', () => {
    expect(withOverrideBits({ allow: 0n, deny: VIEW }, VIEW, 'neutral')).toBeNull();
    expect(withOverrideBits(null, VIEW, 'neutral')).toBeNull();
  });

  it('starts a row where there is none', () => {
    expect(withOverrideBits(null, VIEW, 'deny')).toEqual({ allow: 0n, deny: VIEW });
  });
});
