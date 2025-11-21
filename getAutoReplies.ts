// getAutoReply.ts
import { autoReplies } from "./autoreplies.js";

export function getAutoReply(text: string): string | null {
  const normalized = text.toLowerCase();

  for (const { keywords, reply } of autoReplies) {
    if (keywords.some((kw) => normalized.includes(kw))) {
      return reply;
    }
  }

  return null;
}
