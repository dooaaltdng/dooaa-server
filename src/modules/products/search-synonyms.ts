/**
 * Everyday words shoppers type, mapped to the words listings actually use.
 * The full-text search treats every word in its query as "any of these", so
 * expanding "phone" to "phone smartphone galaxy tecno …" finds the Galaxy A15
 * and the Spark 20 even though neither title says "phone". Matching is on
 * whole lower-case words; plurals are folded first ("cars" → "car").
 *
 * Keep entries to words that really mean the same thing to a buyer — a broad
 * synonym (e.g. "electronics") floods the results instead of helping.
 */
const SYNONYMS: Record<string, string[]> = {
  phone: ['smartphone', 'mobile', 'galaxy', 'tecno', 'infinix', 'itel', 'iphone', 'redmi', 'spark'],
  smartphone: ['phone', 'mobile', 'galaxy', 'tecno', 'infinix', 'iphone'],
  // Only Apple: someone after an iPhone is not helped by every listing that mentions a phone.
  iphone: ['apple'],
  laptop: ['notebook', 'elitebook', 'macbook', 'thinkpad', 'computer'],
  computer: ['laptop', 'notebook', 'desktop'],
  speaker: ['bluetooth', 'jbl', 'soundbar'],
  powerbank: ['power', 'bank', 'charger'],
  car: ['vehicle', 'toyota', 'honda', 'lexus', 'sedan', 'suv'],
  vehicle: ['car', 'toyota', 'honda', 'lexus', 'suv'],
  suv: ['highlander', 'lexus', 'jeep'],
  house: ['apartment', 'flat', 'duplex', 'bedroom', 'rent'],
  apartment: ['flat', 'duplex', 'bedroom', 'house'],
  flat: ['apartment', 'bedroom'],
  land: ['plot', 'acre'],
  plot: ['land'],
  // Not "boot": that also means a car boot.
  shoe: ['sneaker', 'sneakers', 'loafer', 'footwear'],
  sneaker: ['shoe', 'trainer'],
  bag: ['handbag', 'backpack', 'purse'],
  watch: ['wristwatch', 'casio', 'g-shock'],
  dress: ['gown', 'ankara'],
  gown: ['dress', 'ankara'],
  shirt: ['polo', 'tee', 't-shirt'],
  book: ['paperback', 'novel', 'hardcover'],
  novel: ['book', 'paperback'],
  fridge: ['refrigerator', 'freezer'],
  refrigerator: ['fridge', 'freezer'],
  cooker: ['gas', 'burner', 'stove', 'oven'],
  stove: ['cooker', 'burner'],
  blender: ['grinder', 'mixer'],
  fan: ['standing', 'cooling'],
  perfume: ['parfum', 'fragrance', 'cologne', 'oud'],
  cream: ['lotion', 'moisturiser', 'moisturizer'],
  lotion: ['cream', 'moisturiser'],
  toothbrush: ['oral-b', 'brush'],
  diaper: ['pampers', 'nappy'],
  pram: ['stroller', 'pushchair'],
  stroller: ['pram', 'pushchair'],
  toy: ['lego', 'doll', 'game', 'puzzle'],
  doll: ['barbie'],
  ball: ['football', 'basketball', 'soccer'],
  football: ['soccer', 'ball'],
  gym: ['fitness', 'workout'],
  workout: ['gym', 'fitness'],
  piano: ['keyboard', 'yamaha'],
  keyboard: ['piano'],
  mic: ['microphone'],
  microphone: ['mic'],
};

/** "cars" → "car", "watches" → "watch", "batteries" → "battery"; short words are left alone. */
function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The full-text query for a search term, with each word's synonyms added. */
export function expandSearch(term: string): string {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Set<string>(words);
  for (const word of words) {
    const base = singular(word);
    out.add(base);
    for (const synonym of SYNONYMS[base] ?? []) out.add(synonym);
  }
  return [...out].join(' ');
}
