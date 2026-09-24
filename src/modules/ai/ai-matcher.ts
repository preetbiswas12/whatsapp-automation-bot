/**
 * Pure text-matching helpers for AI pattern learning (ported from the standalone ai-bot).
 * Kept side-effect free so it can be unit-tested and reused by any store.
 */

const STOP_WORDS = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them',
  'their', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and',
  'but', 'if', 'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by',
  'for', 'with', 'about', 'against', 'between', 'through', 'during', 'before',
  'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on',
  'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there',
  'when', 'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should',
  'now', 'hi', 'hello', 'hey', 'thanks', 'thank', 'please', 'yes', 'no', 'ok',
  'okay', 'bye', 'morning', 'evening', 'night',
]);

/** Normalize a message into a set of meaningful keywords (max 20). */
export function extractKeywords(text: string): string[] {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word))
    .slice(0, 20);
}

/** Jaccard similarity between two keyword lists: |A ∩ B| / |A ∪ B| */
export function jaccardSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

export interface AiPatternMatch {
  pattern: AiPattern;
  confidence: number;
}

export interface AiPattern {
  id: string;
  keywords: string[];
  originalMessage: string;
  reply: string;
  summary: string;
  uses: number;
  createdAt: string;
  lastUsed: string;
}

/** Find the best matching pattern for a message, if any, above the threshold. */
export function findBestMatch(patterns: AiPattern[], text: string, threshold: number): AiPatternMatch | null {
  const keywords = extractKeywords(text);
  if (!keywords.length) return null;

  let best: AiPattern | null = null;
  let bestConfidence = 0;

  for (const pattern of patterns) {
    const score = jaccardSimilarity(pattern.keywords || [], keywords);
    if (score > bestConfidence) {
      bestConfidence = score;
      best = pattern;
    }
  }

  if (best && bestConfidence >= threshold) {
    return { pattern: best, confidence: bestConfidence };
  }
  return null;
}