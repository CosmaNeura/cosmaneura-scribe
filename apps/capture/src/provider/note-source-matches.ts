import type { CreatorReviewView } from "../../../review-ui/src/creator-review-api";
import type { TranscriptEvidenceReference } from "../../../review-ui/src/transcript-tools";
import { isUuid } from "../../../review-ui/src/contracts";
import { reviewedSource, sameSource, type CoreDraft } from "./core-notes";

export interface NoteSourceMatch extends TranscriptEvidenceReference {
  readonly startMs: number;
}
interface Candidate { readonly text: string; readonly block: string | null; readonly match: NoteSourceMatch }
interface MatchBudget { comparisons: number; characters: number }
const roles: Readonly<Record<string, string>> = {
  clinician: "Clinician", patient: "Patient", other: "Other speaker", unknown: "Unidentified speaker",
};

/** Exact wording in the displayed version, not a record of the model's citations.
 * Inputs are the already parsed/authorized note and review pair. No I/O occurs. */
export function noteSourceMatches(draft: CoreDraft, view: CreatorReviewView): ReadonlyMap<string, readonly NoteSourceMatch[]> {
  const result = new Map<string, readonly NoteSourceMatch[]>();
  try {
    if (draft.status !== "draft" || !draft.fields || !draft.field_order || !draft.note_ref || !draft.note_sha256
      || draft.session_id !== view.session_id || !sameSource(draft.reviewed_source, reviewedSource(view))
      || draft.scribe_source_id !== view.working?.working_transcript_id) return result;
  } catch { return result; }
  const source = view.source!, working = view.working;
  const originals = new Map(source.segments.map(segment => [segment.source_segment_id, segment]));
  if (originals.size !== source.segments.length || working.source_transcript_version !== source.source_transcript_version
    || new Set(working.segments.map(segment => segment.source_segment_id)).size !== working.segments.length) return result;
  const byText = new Map<string, Candidate | null>(), candidates: Candidate[] = [];
  // Count worst-case string work, not just candidate count: many long turns
  // with the same opening must not hold up the note editor for this optional aid.
  const budget: MatchBudget = { comparisons: 50_000, characters: 2_000_000 };
  for (const segment of working.segments) {
    const original = originals.get(segment.source_segment_id), text = segment.content;
    if (!original || !isUuid(segment.source_segment_id) || original.source_segment_version !== segment.source_segment_version
      || !Number.isSafeInteger(original.start_ms) || original.start_ms < 0) return result;
    if (typeof text !== "string" || text.length === 0 || !["english_source", "spanish_translation"].includes(segment.resolution)) continue;
    budget.characters -= text.length * 2;
    if (budget.characters < 0) return result;
    const role = roles[segment.speaker_role];
    const candidate: Candidate = { text, block: role ? `Transcript — ${role}:\n${text}` : null, match: {
      working_transcript_id: working.working_transcript_id, working_transcript_version: working.working_transcript_version,
      source_transcript_version: source.source_transcript_version, source_segment_id: segment.source_segment_id,
      source_segment_version: segment.source_segment_version, startMs: original.start_ms,
    } };
    candidates.push(candidate);
    // Equal words in two different turns never justify choosing either one.
    byText.set(text, byText.has(text) ? null : candidate);
  }
  // Bound optional matching work across the whole note; ordinary comparison is
  // still available when a pathological/large input exhausts this reading aid.
  for (const key of draft.field_order) {
    const text = draft.fields[key];
    if (!text || text === "Not mentioned in transcript" || /(?:^|\n\n)Clinician's saved scratch notes:\n/u.test(text)) continue;
    const quoted = uniqueBlocks(text, candidates, budget);
    if (quoted === null) continue;
    const raw = byText.get(text);
    // Raw text and a formatted block may themselves have different matches.
    if (byText.has(text) && quoted.length) continue;
    if (quoted.some(candidate => byText.get(candidate.text) !== candidate)) continue;
    const matches = raw ? [raw.match] : quoted.map(candidate => candidate.match);
    if (matches.length && new Set(matches.map(match => match.source_segment_id)).size === matches.length) {
      result.set(key, matches.sort((a, b) => a.startMs - b.startMs));
    }
  }
  return result;
}

/** Consume the whole field, never split utterances at their internal newlines.
 * Two valid decompositions (including a long utterance containing block headers)
 * are ambiguous. Depth/work exhaustion also yields no links, never a best guess. */
function uniqueBlocks(text: string, candidates: readonly Candidate[], budget: MatchBudget): Candidate[] | null {
  const memo = new Map<number, Candidate[] | null>();
  let exhausted = false;
  const walk = (offset: number, depth: number): Candidate[] | null => {
    if (depth > 100) { exhausted = true; return null; }
    if (memo.has(offset)) return memo.get(offset)!;
    let found: Candidate[] | undefined;
    for (const candidate of candidates) {
      if (--budget.comparisons < 0) { exhausted = true; return null; }
      budget.characters -= Math.min(candidate.block?.length ?? 0, text.length - offset);
      if (budget.characters < 0) { exhausted = true; return null; }
      if (!candidate.block || !text.startsWith(candidate.block, offset)) continue;
      const end = offset + candidate.block.length;
      let tail: Candidate[] | null;
      if (end === text.length) tail = [];
      else if (text.slice(end, end + 2) === "\n\n") {
        tail = walk(end + 2, depth + 1);
        if (tail?.length === 0) continue;
      } else continue;
      if (tail === null || found) { memo.set(offset, null); return null; }
      found = [candidate, ...tail];
    }
    const value = found ?? [];
    memo.set(offset, value); return value;
  };
  const result = walk(0, 0);
  return exhausted ? null : result;
}
