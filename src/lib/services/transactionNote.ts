/**
 * Free-text note a user attaches to a transaction (pure validation).
 * Empty text means "no note"; stored as NULL.
 */
export const NOTE_MAX_LENGTH = 500;

export class NoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteValidationError';
  }
}

/** Trim; empty → null; reject non-strings and over-long notes (code points). */
export function normalizeNote(input: string | null | undefined): string | null {
  if (input == null) return null;
  if (typeof input !== 'string') throw new NoteValidationError('note must be a string or null');
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if ([...trimmed].length > NOTE_MAX_LENGTH) {
    throw new NoteValidationError(`note must be at most ${NOTE_MAX_LENGTH} characters`);
  }
  return trimmed;
}
