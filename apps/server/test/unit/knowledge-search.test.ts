import { describe, expect, it } from 'vitest';
import { buildAnyTermQuery } from '../../src/modules/knowledge/service.js';

describe('buildAnyTermQuery', () => {
  it("ORs the terms of a natural question as prefix matches", () => {
    expect(buildAnyTermQuery('Toifa B narxi qancha?')).toBe('toifa:* | narxi:* | qancha:*');
  });

  it('drops tokens shorter than three characters', () => {
    expect(buildAnyTermQuery('B va C toifa')).toBe('toifa:*');
  });

  it('keeps non-latin words', () => {
    expect(buildAnyTermQuery('сколько стоит')).toBe('сколько:* | стоит:*');
  });

  it('strips tsquery operators instead of passing them through', () => {
    const q = buildAnyTermQuery("narx & toifa | (kurs) !:* <-> 'x'");
    expect(q).toBe('narx:* | toifa:* | kurs:*');
    expect(q).not.toMatch(/[&()!<>']/);
  });

  it('de-duplicates repeated words', () => {
    expect(buildAnyTermQuery('narxi narxi NARXI')).toBe('narxi:*');
  });

  it('caps the number of terms so a pasted essay cannot build a huge query', () => {
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    expect(buildAnyTermQuery(many).split('|')).toHaveLength(12);
  });

  it('returns an empty string when nothing usable is left', () => {
    expect(buildAnyTermQuery('?! a b')).toBe('');
    expect(buildAnyTermQuery('')).toBe('');
  });
});
