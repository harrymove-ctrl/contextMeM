// Pure text/sentence heuristics with ZERO heavy deps (no cheerio / node:fs).
// Extracted so leaf consumers (facts.ts, and the Cloudflare Worker bundle that
// imports it) can reuse them without dragging web.ts's HTML stack — which pulls
// cheerio and trips "__dirname is not defined" in the Workers runtime.

import { unique } from "./utils.js";

export function rankedContextSentences(context: string, terms: string[]): string[] {
  const keywords = unique(terms.map((term) => term.trim().toLowerCase()).filter((term) => term.length >= 4));
  const seen = new Set<string>();
  const scored = context
    .split(/(?:\n{2,}|(?<=[.!?])\s+)/g)
    .map(cleanMarkdownText)
    .filter((sentence) => isUsefulContextSentence(sentence))
    .filter((sentence) => {
      const key = sentence.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((sentence, index) => {
      const lower = sentence.toLowerCase();
      const score = keywords.reduce((sum, keyword) => sum + (lower.includes(keyword) ? 2 : 0), 0) + domainTermScore(lower) - Math.min(index, 80) * 0.01;
      return { sentence, score };
    })
    .sort((a, b) => b.score - a.score);

  const selected = scored.filter((item) => item.score > 0).map((item) => item.sentence);
  return (selected.length ? selected : scored.map((item) => item.sentence)).slice(0, 8);
}

export function firstReadableSentence(markdown: string): string | undefined {
  return rankedContextSentences(markdown, [])[0];
}

function cleanMarkdownText(value: string): string {
  return value
    .replace(/^URL:\s*\S+\s*/i, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulContextSentence(sentence: string): boolean {
  if (sentence.length < 32 || sentence.length > 520) return false;
  if (/^https?:\/\//i.test(sentence)) return false;
  if (/^\/[\w./-]+(?:\s+\/[\w./-]+)*$/.test(sentence)) return false;
  if (/^(info|table of contents|direct link|previous|next)$/i.test(sentence)) return false;
  return /[a-z]/i.test(sentence);
}

function domainTermScore(lower: string): number {
  return ["walrus", "sui", "developer", "api", "sdk", "storage", "encryption", "seal", "site", "user"].reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
}
