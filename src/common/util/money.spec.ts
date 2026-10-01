import { allocate, formatNaira, formatNairaCompact, fromKobo, multiplyMoney, percentOf, roundMoney, subtractMoney, sumMoney, toKobo } from './money';

describe('money', () => {
  it('converts to and from kobo without float drift', () => {
    expect(toKobo(0.1 + 0.2)).toBe(30);
    expect(toKobo(1.005)).toBe(101);
    expect(toKobo(278.99)).toBe(27899);
    expect(fromKobo(27899)).toBe(278.99);
    expect(roundMoney(10.005)).toBe(10.01);
  });

  it('adds and subtracts exactly', () => {
    expect(sumMoney(0.1, 0.2)).toBe(0.3);
    expect(sumMoney(1_789_000, 12_000, 8_000)).toBe(1_809_000);
    expect(subtractMoney(100, 33.33, 33.33)).toBe(33.34);
    expect(sumMoney()).toBe(0);
  });

  it('takes percentages in kobo', () => {
    expect(percentOf(400_000, 0.5)).toBe(2_000);
    expect(percentOf(126.99, 10)).toBe(12.7);
    expect(percentOf(1, 0.5)).toBe(0.01);
    expect(multiplyMoney(126.99, 3)).toBe(380.97);
  });

  it('allocates a total across weights so parts always sum back exactly', () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(sumMoney(...parts)).toBe(100);
    expect(parts).toEqual([33.34, 33.33, 33.33]);
    expect(allocate(40_000, [400_000, 720_000, 280_000])).toEqual([11_428.57, 20_571.43, 8_000]);
    expect(sumMoney(...allocate(0.05, [3, 3, 3, 3]))).toBe(0.05);
    expect(allocate(10, [])).toEqual([]);
    expect(allocate(10, [0, 0])).toEqual([5, 5]);
  });

  it('formats Naira the way the apps print it', () => {
    expect(formatNaira(400_000)).toBe('₦400,000');
    expect(formatNaira(1_230_740.5)).toBe('₦1,230,740.50');
    expect(formatNairaCompact(1_200_000)).toBe('₦1.2M');
    expect(formatNairaCompact(284_000)).toBe('₦284k');
    expect(formatNairaCompact(3_400_000_000)).toBe('₦3.4B');
    expect(formatNairaCompact(950)).toBe('₦950');
  });
});
