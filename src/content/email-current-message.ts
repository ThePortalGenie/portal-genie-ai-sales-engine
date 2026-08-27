export type QuoteStripConfidence = "HIGH" | "MEDIUM" | "LOW";

export type CurrentMessageSplit = {
  currentMessageText: string;
  fullCleanedBody: string;
  quoteStrippingConfidence: QuoteStripConfidence;
  strippedQuotedHistory: boolean;
  strippedSignatureOrDisclaimer: boolean;
};

const ORIGINAL_MESSAGE = /(?:^|\n)[ \t]*-{2,}\s*Original Message\s*-{2,}[ \t]*(?:\n|$)/i;
const FORWARDED_MESSAGE = /(?:^|\n)[ \t]*-{2,}\s*Forwarded message\s*-{2,}[ \t]*(?:\n|$)/i;
const BEGIN_FORWARDED = /(?:^|\n)Begin forwarded message:?[ \t]*(?:\n|$)/i;
const GMAIL_WROTE = /(?:^|\n)On [^\n]{8,160} wrote:[ \t]*(?:\n|$)/i;
const GMAIL_WROTE_WRAPPED = /(?:^|\n)On [^\n]{8,80}\n[^\n]{0,80} wrote:[ \t]*(?:\n|$)/i;
const RFC_SIGNATURE = /(?:^|\n)--[ \t]*\n/;
const DISCLAIMER =
  /(?:^|\n)(?:disclaimer\s*:|this (?:e-?mail|message)(?: and any attachments)? (?:is|are) (?:confidential|privileged|intended))/i;

function firstMatchIndex(text: string, patterns: RegExp[]): number {
  let best = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match.index >= 0 && (best < 0 || match.index < best)) {
      best = match.index;
    }
  }
  return best;
}

/**
 * Zoho/Outlook often splits a display name across lines:
 * From: Sumeré
 * van Staden < sumere@example.com >
 * Sent: Monday, June 22, 2026 2:58 PM
 * To: Geoff ...
 */
export function findOutlookQuoteIndex(text: string): number {
  const fromLine = /(?:^|\n)From:[ \t]*\S/gi;
  let best = -1;
  let match: RegExpExecArray | null;
  while ((match = fromLine.exec(text))) {
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    const window = text.slice(start, start + 600);
    const lines = window.split(/\n/).slice(0, 8);
    if (lines.length < 2) continue;
    const sentAt = lines.findIndex((line) => /^(Sent|Date):[ \t]/i.test(line));
    if (sentAt < 1 || sentAt > 5) continue;
    const hasToOrSubject = lines.slice(sentAt, sentAt + 4).some((line) => /^(To|Cc|Subject):[ \t]/i.test(line));
    const hasEmail = /<[^>\n]*@[^>\n]+>/.test(lines.slice(0, sentAt + 1).join("\n"));
    if (!hasToOrSubject && !hasEmail) continue;
    if (best < 0 || start < best) best = start;
  }
  return best;
}

function collapse(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripTrailingSignature(current: string): { text: string; stripped: boolean; confidence: QuoteStripConfidence } {
  const rfc = RFC_SIGNATURE.exec(current);
  if (rfc && rfc.index > 8) {
    const kept = collapse(current.slice(0, rfc.index));
    if (kept.length >= 12 && kept.length / current.length >= 0.2) {
      return { text: kept, stripped: true, confidence: "HIGH" };
    }
  }

  const disclaimer = DISCLAIMER.exec(current);
  if (disclaimer && disclaimer.index > 12) {
    const kept = collapse(current.slice(0, disclaimer.index));
    if (kept.length >= 12 && kept.length / current.length >= 0.15) {
      return { text: kept, stripped: true, confidence: "MEDIUM" };
    }
  }

  const regards = /(?:^|\n)(kind regards|best regards|warm regards|yours sincerely|many thanks|thanks and regards)[,.]?[ \t]*\n/i.exec(
    current,
  );
  if (regards && regards.index > 12) {
    const after = current.slice(regards.index + regards[0].length);
    if (DISCLAIMER.test(after) || /confidential|privileged|unsubscribe|the portal genie/i.test(after)) {
      const kept = collapse(current.slice(0, regards.index));
      if (kept.length >= 20) {
        return { text: kept, stripped: true, confidence: "MEDIUM" };
      }
    }
  }

  return { text: collapse(current), stripped: false, confidence: "HIGH" };
}

/**
 * Split a cleaned plain-text email into the current message vs quoted history.
 * Conservative: if a boundary is unclear, keep the full text.
 */
export function splitCurrentEmailMessage(fullCleanedBody: string): CurrentMessageSplit {
  const full = collapse(fullCleanedBody ?? "");
  if (!full) {
    return {
      currentMessageText: "",
      fullCleanedBody: "",
      quoteStrippingConfidence: "HIGH",
      strippedQuotedHistory: false,
      strippedSignatureOrDisclaimer: false,
    };
  }

  const quoteIndex = firstMatchIndex(full, [
    ORIGINAL_MESSAGE,
    FORWARDED_MESSAGE,
    BEGIN_FORWARDED,
    GMAIL_WROTE,
    GMAIL_WROTE_WRAPPED,
  ]);
  const outlookIndex = findOutlookQuoteIndex(full);
  const boundary = [quoteIndex, outlookIndex].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? -1;

  if (boundary === 0) {
    return {
      currentMessageText: full,
      fullCleanedBody: full,
      quoteStrippingConfidence: "LOW",
      strippedQuotedHistory: false,
      strippedSignatureOrDisclaimer: false,
    };
  }

  let current = full;
  let strippedQuoted = false;
  let quoteConfidence: QuoteStripConfidence = "LOW";

  if (boundary > 0) {
    const candidate = collapse(full.slice(0, boundary));
    if (candidate.length >= 12 && candidate.length / full.length >= 0.08) {
      current = candidate;
      strippedQuoted = true;
      quoteConfidence = boundary / full.length <= 0.85 ? "HIGH" : "MEDIUM";
    } else {
      return {
        currentMessageText: full,
        fullCleanedBody: full,
        quoteStrippingConfidence: "LOW",
        strippedQuotedHistory: false,
        strippedSignatureOrDisclaimer: false,
      };
    }
  }

  const signature = stripTrailingSignature(current);
  const finalText = signature.text || current;
  if (!strippedQuoted && !signature.stripped) {
    quoteConfidence = "LOW";
  } else if (strippedQuoted && signature.stripped) {
    quoteConfidence = quoteConfidence === "HIGH" && signature.confidence === "HIGH" ? "HIGH" : "MEDIUM";
  } else if (!strippedQuoted && signature.stripped) {
    quoteConfidence = signature.confidence;
  }

  return {
    currentMessageText: finalText,
    fullCleanedBody: full,
    quoteStrippingConfidence: quoteConfidence,
    strippedQuotedHistory: strippedQuoted,
    strippedSignatureOrDisclaimer: signature.stripped,
  };
}

export function fingerprintEmailText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 320);
}
