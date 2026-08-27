export type DatedEmail = {
  at?: string | null;
  direction: string;
};

function dated(emails: DatedEmail[]): Array<DatedEmail & { at: string }> {
  return emails
    .filter((item): item is DatedEmail & { at: string } => typeof item.at === "string" && !Number.isNaN(Date.parse(item.at)))
    .filter((item) => item.direction === "outbound" || item.direction === "inbound")
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/**
 * One unanswered outbound sequence exists when the Contact's latest dated email is outbound.
 * This is not the same as a trailing consecutive outbound streak.
 */
export function hasUnansweredOutboundSequence(emails: DatedEmail[]): boolean {
  const items = dated(emails);
  const last = items[items.length - 1];
  return last?.direction === "outbound";
}

/** Consecutive outbound emails after the last inbound (selected-Contact streak). */
export function trailingOutboundStreak(emails: DatedEmail[]): number {
  let streak = 0;
  for (const email of dated(emails)) {
    if (email.direction === "outbound") streak += 1;
    else streak = 0;
  }
  return streak;
}

export function organisationUnansweredSequences(
  emails: Array<DatedEmail & { ownerRecordId: string; ownerName?: string }>,
): {
  organisation_unanswered_sequences: number;
  by_contact: Array<{ contact_id: string; name?: string; unanswered_sequence: boolean; trailing_outbound_streak: number }>;
} {
  const grouped = new Map<string, { name?: string; emails: DatedEmail[] }>();
  for (const email of emails) {
    const row = grouped.get(email.ownerRecordId) ?? { name: email.ownerName, emails: [] };
    if (email.ownerName) row.name = email.ownerName;
    row.emails.push(email);
    grouped.set(email.ownerRecordId, row);
  }
  const by_contact = [...grouped.entries()].map(([contact_id, row]) => ({
    contact_id,
    name: row.name,
    unanswered_sequence: hasUnansweredOutboundSequence(row.emails),
    trailing_outbound_streak: trailingOutboundStreak(row.emails),
  }));
  return {
    organisation_unanswered_sequences: by_contact.filter((item) => item.unanswered_sequence).length,
    by_contact,
  };
}
