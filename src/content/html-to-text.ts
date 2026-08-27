/**
 * Deterministic HTML-to-text for untrusted CRM email bodies.
 * Do not use an LLM. Do not treat the result as a verified CRM fact.
 */

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code > 0) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return " ";
        }
      }
      return " ";
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

function looksLikeCssOrTemplateNoise(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("@") || trimmed.startsWith("div.") || trimmed.startsWith("span.")) return true;
  if (/^[#.][A-Za-z0-9_-]+\s*(\{|\{|,)/.test(trimmed)) return true;
  if (/@media|!important|mso-|zm_[A-Za-z0-9_]+/.test(trimmed) && trimmed.length < 200) return true;
  if (/\{[^}]{0,120}:[^}]{0,120}\}/.test(trimmed) && !/\s{2,}|[.!?]/.test(trimmed)) return true;
  if (/^(font-family|font-size|line-height|margin|padding|border|color|background|width|height|display|max-width)\s*:/i.test(trimmed)) {
    return true;
  }
  if (/https?:\/\/[^ ]*(track|open|pixel|beacon|click)[^ ]*/i.test(trimmed) && trimmed.split(/\s+/).length <= 3) {
    return true;
  }
  return false;
}

export function htmlToPlainText(input: string, maxChars = 20_000): { text: string; truncated: boolean } {
  if (!input.trim()) {
    return { text: "", truncated: false };
  }

  let html = input.replace(/\r\n/g, "\n");
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  html = html.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  html = html.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  html = html.replace(/<head\b[\s\S]*?<\/head>/gi, " ");
  html = html.replace(/<!--[\s\S]*?-->/g, " ");
  html = html.replace(/<img\b[^>]*>/gi, " ");
  html = html.replace(/<br\s*\/?>/gi, "\n");
  html = html.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|section|article|header|footer)>/gi, "\n");
  html = html.replace(/<\/td>/gi, " ");
  html = html.replace(/<[^>]+>/g, " ");
  html = decodeEntities(html);
  html = html.replace(/@media[^{]*\{[\s\S]*?\}/gi, " ");
  html = html.replace(/\bdiv\.[A-Za-z0-9_-]+[^{]*\{[^}]*\}/g, " ");

  const lines = html
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => !looksLikeCssOrTemplateNoise(line));

  let text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = text.length > maxChars;
  if (truncated) {
    text = `${text.slice(0, maxChars)}…`;
  }
  return { text, truncated };
}
