// Keyword parser used by the browser-voice fallback (and typed commands) to map
// what the runner said onto the same tools Grok calls.

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20 };
const NUM = '(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twenty)';
const num = (s) => (s == null ? null : Number.isNaN(Number(s)) ? WORD_NUMBERS[s] ?? null : Number(s));

const CATEGORY_WORDS = [
  ['smoothie', /smoothie|juice|boba|bubble tea|acai/],
  ['coffee', /coffee|latte|cafe|café|espresso/],
  ['grocery', /grocer|market|supermarket/],
  ['atm', /\batm\b|cash|\bbank\b/],
  ['treat', /ice cream|bakery|treat|dessert|donut|pastry/],
  ['any', /anywhere|surprise|somewhere/],
];

function distanceIn(t) {
  if (/half marathon/.test(t)) return 13.1;
  const m = t.match(new RegExp(`${NUM}\\s*-?\\s*(k|km|kilometers?|miles?|mi)\\b`));
  if (!m) return null;
  const n = num(m[1]);
  return /^k/.test(m[2]) ? Math.round(n * 0.621371 * 10) / 10 : n;
}

export function parseCommand(raw) {
  const t = raw.toLowerCase().replace(/,/g, '').replace(/\$/g, ' $');

  let m = t.match(/\b(?:route|option|number)\s+([abc]|one|two|three|[123])\b/) || t.match(/\b(first|second|third)\b(?:\s+(?:one|route|option))?/);
  if (m && !/\b(plan|find)\b/.test(t)) {
    const map = { a: 'A', b: 'B', c: 'C', one: 'A', two: 'B', three: 'C', 1: 'A', 2: 'B', 3: 'C', first: 'A', second: 'B', third: 'C' };
    return { tool: 'choose_route', args: { option: map[m[1]] } };
  }

  m = t.match(new RegExp(`\\b(?:spent|bought|paid|cost|was)\\b.*?\\$?\\s*${NUM}`));
  if (m && /spent|bought|paid|cost/.test(t)) return { tool: 'log_purchase', args: { amount_dollars: num(m[1]) } };

  m = t.match(new RegExp(`\\b(?:move|transfer|put|save|send|add)\\b.*?\\$?\\s*${NUM}`));
  if (m && !distanceIn(t)) return { tool: 'transfer_to_savings', args: { amount_dollars: num(m[1]), reason: 'Voice transfer' } };

  const distance = distanceIn(t);
  const category = CATEGORY_WORDS.find(([, re]) => re.test(t))?.[0];
  if (/\b(plan|find|route|run|jog|take me|want)\b/.test(t) && (distance || category)) {
    const budget = t.match(new RegExp(`(?:under|less than|budget(?: of)?|max|up to|below)\\s*\\$?\\s*${NUM}`));
    return {
      tool: 'plan_routes',
      args: {
        distance_miles: distance ?? undefined,
        destination_type: category ?? undefined,
        budget_dollars: budget ? num(budget[1]) : undefined,
      },
    };
  }

  if (/\b(start|begin|let'?s go|go go)\b/.test(t)) return { tool: 'start_run', args: {} };
  if (/\b(end|stop|finish)\b/.test(t)) return { tool: 'end_run', args: {} };
  if (/sav|fund|goal|balance|money|bank|account|how much/.test(t)) return { tool: 'get_savings', args: {} };
  if (/how far|status|pace|distance|time|left|next turn|where|turn|how am i/.test(t)) return { tool: 'get_run_status', args: {} };
  return null;
}
