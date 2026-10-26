import { expandSearch } from './search-synonyms';

describe('search synonyms', () => {
  it('adds what listings call it, keeping the words typed', () => {
    const phone = expandSearch('phone').split(' ');
    expect(phone[0]).toBe('phone');
    expect(phone).toEqual(expect.arrayContaining(['galaxy', 'tecno']));
  });

  it('folds plurals before looking up', () => {
    expect(expandSearch('cars').split(' ')).toEqual(expect.arrayContaining(['cars', 'car', 'toyota']));
    expect(expandSearch('watches').split(' ')).toEqual(expect.arrayContaining(['watch', 'casio']));
  });

  it('leaves unknown words alone and never duplicates', () => {
    expect(expandSearch('Xyzzy')).toBe('xyzzy');
    const words = expandSearch('book books').split(' ');
    expect(new Set(words).size).toBe(words.length);
  });
});
