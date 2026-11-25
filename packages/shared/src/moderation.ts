// Small built-in list (EN + TR); admins extend it via settings.chatBlockedWords.
export const BASE_BLOCKED_WORDS = [
  'fuck',
  'shit',
  'cunt',
  'nigger',
  'faggot',
  'retard',
  'amk',
  'aq',
  'orospu',
  'piç',
  'siktir',
  'yarrak',
  'göt',
  'ibne',
  'pezevenk',
];

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function maskBlockedWords(
  text: string,
  extra: string[] = [],
): { text: string; masked: boolean } {
  const words = [...BASE_BLOCKED_WORDS, ...extra].filter(Boolean);
  if (!words.length) return { text, masked: false };
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(${words.map(escape).join('|')})(?![\\p{L}\\p{N}])`,
    'giu',
  );
  let masked = false;
  const out = text.replace(re, (m) => {
    masked = true;
    return '•'.repeat([...m].length);
  });
  return { text: out, masked };
}
