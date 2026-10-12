import { describe, expect, it } from 'vitest';
import { composerMentions } from './composerMentions';

// Two people with the same shown name, as two members of one space can be.
const names = new Map([['123', 'Alice'], ['456', 'Alice']]);
const model = (value: string) => composerMentions(value, (userId) => names.get(userId) ?? null);

describe('composer mention display and wire offsets', () => {
  it('shows a known token by name and keeps the id out of the text', () => {
    expect(model('Hi <@123> there').text).toBe('Hi @Alice there');
  });
  it('preserves separate IDs for identically named members', () => {
    const result = model('<@123> <@456>');
    expect(result.update('@Alice @Alice!').value).toBe('<@123> <@456>!');
  });
  it('maps cursor offsets before and after a mention', () => {
    const result = model('Hi <@123> !');
    expect(result.toWire(10)).toBe(10);
    expect(result.toDisplay(9)).toBe(9);
    expect(result.toWire(6)).toBe(3);
    expect(result.toWire(6, true)).toBe(9);
  });
  it('deletes a whole selected token with backspace rather than corrupting its ID', () => {
    expect(model('<@123> ').update('@Alic ', 5)).toEqual({ value: ' ', wireCursor: 0 });
    expect(model('<@123> ').update('Alice ', 0)).toEqual({ value: ' ', wireCursor: 0 });
  });
  it('replaces the whole token when a character is typed inside a shown mention', () => {
    expect(model('<@123> hi').update('@Alxice hi', 4)).toEqual({ value: 'x hi', wireCursor: 1 });
  });
  it('edits ordinary text and preserves mentions around the edit', () => {
    expect(model('Hi <@123>!').update('Hey @Alice!', 3).value).toBe('Hey <@123>!');
    expect(model('<@123> hello').update('@Alice hello!', 13).value).toBe('<@123> hello!');
  });
  it('replaces a selection across mentions and supports emoji insertion', () => {
    expect(model('a <@123> b').replace({ start: 2, end: 8, text: '😀' })).toEqual({ value: 'a 😀 b', wireCursor: 4 });
  });
  it('does not turn pasted display names into implicit mentions', () => {
    expect(model('').update('@Alice').value).toBe('@Alice');
  });
  it('keeps code and unknown tokens literal', () => {
    const value = '\x60<@123>\x60 <@unknown>';
    expect(model(value).text).toBe(value);
    expect(model(value).parts.every((p) => !p.mention)).toBe(true);
  });
  it('shows role tokens by name and paints @everyone and @here, as the sent message does', () => {
    const roles = new Map([['r1', 'Mods']]);
    const withRoles = (value: string) => composerMentions(value, (userId) => names.get(userId) ?? null, (roleId) => roles.get(roleId) ?? null);
    const result = withRoles('<@&r1> @everyone @here <@&gone>');
    expect(result.text).toBe('@Mods @everyone @here <@&gone>');
    expect(result.parts.filter((p) => p.painted).map((p) => p.text)).toEqual(['@Mods', '@everyone', '@here']);
    // A role is one unit like a user; @everyone stays text to edit.
    expect(result.parts.filter((p) => p.mention).map((p) => p.text)).toEqual(['@Mods']);
    expect(result.update('@Mods @every @here <@&gone>', 12).value).toBe('<@&r1> @every @here <@&gone>');
    expect(result.update('@Mod @everyone @here <@&gone>', 4).value).toBe(' @everyone @here <@&gone>');
  });
  it('paints nothing inside code, and no role without a role resolver', () => {
    const value = '\x60@everyone <@&r1>\x60 <@&r1>';
    expect(model(value).text).toBe(value);
    expect(model(value).parts.every((p) => !p.painted)).toBe(true);
  });
  it('maps a draft offset inside a token to the shown mention start', () => {
    const result = model('Hi <@123> !');
    expect(result.toDisplay(5)).toBe(3);
    expect(result.toDisplay(result.text.length + 10)).toBe(result.text.length);
  });
});
