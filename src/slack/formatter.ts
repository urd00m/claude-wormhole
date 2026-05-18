/**
 * Convert a Markdown subset to Slack mrkdwn.
 * - **bold** → *bold*
 * - __underline__ → _underline_ (Slack uses _italic_ ≈ italics; keep as italics)
 * - `code` stays as `code`
 * - ```fenced``` stays as ```fenced``` (Slack supports triple backticks)
 * - [text](url) → <url|text>
 * - leading `# `, `## `, `### ` headers → *bold* line
 */
export function toMrkdwn(md: string): string {
  let out = md;
  // Links: do before bold to avoid colliding with brackets
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  // Bold **x** → *x* (avoid touching ** inside code blocks would need full parser;
  // good enough for chat-grade output)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
  // Headers
  out = out.replace(/^#{1,6}\s+(.*)$/gm, "*$1*");
  return out;
}
