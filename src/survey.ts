/**
 * What happens after somebody scans a code.
 *
 * A greeting is the original open-message flow. A survey replaces that open message with a
 * handful of owner-written questions. The answers take the same privacy-preserving route as a
 * message: straight into the owner's inbox, never into storage.
 *
 * Kept separate from `syfte.ts`: a purpose changes the words around a code, while this changes
 * the interaction behind it. A party code can use either, and so can a completely custom one.
 */

export type ScanMode = "greeting" | "survey";

export interface SurveySetup {
  mode: ScanMode;
  /** Empty for the greeting flow. Between two and five owner-written questions for a survey. */
  questions: string[];
}

export const MIN_SURVEY_QUESTIONS = 2;
export const MAX_SURVEY_QUESTIONS = 5;
export const MAX_QUESTION = 120;
export const MAX_ANSWER = 400;

/** Helpful enough to make the first preview real, and editable before it is saved. */
export const DEFAULT_SURVEY_QUESTIONS: readonly string[] = [
  "Vad får dig att tappa tidsuppfattningen?",
  "Hur ser en riktigt bra första dejt ut för dig?",
  "Vad får dig nästan alltid att skratta?",
];

export function isScanMode(value: unknown): value is ScanMode {
  return value === "greeting" || value === "survey";
}

/** A question is one short line, even if somebody sends control characters around the form. */
function oneLine(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    out +=
      code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 || /\s/u.test(character)
        ? " "
        : character;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/**
 * Wash an owner submission into the only two storable shapes.
 *
 * Missing mode means greeting for compatibility with management pages opened before this
 * feature shipped. A named but unknown mode is refused rather than quietly changing the flow.
 */
export function cleanSurveySetup(
  input: { mode?: unknown; questions?: unknown },
): SurveySetup | null {
  const mode = input.mode === undefined ? "greeting" : input.mode;
  if (!isScanMode(mode)) return null;
  if (mode === "greeting") return { mode, questions: [] };
  if (!Array.isArray(input.questions)) return null;
  if (
    input.questions.length < MIN_SURVEY_QUESTIONS ||
    input.questions.length > MAX_SURVEY_QUESTIONS
  ) return null;

  const questions: string[] = [];
  for (const value of input.questions) {
    if (typeof value !== "string") return null;
    const question = oneLine(value);
    if (question.length === 0 || question.length > MAX_QUESTION) return null;
    questions.push(question);
  }
  return { mode, questions };
}

interface HasSurvey {
  mode?: unknown;
  questions?: unknown;
}

/** Stored data is untrusted; an incomplete survey falls back to a useful, valid draft. */
export function surveyOf(record: HasSurvey): SurveySetup {
  if (record.mode !== "survey") return { mode: "greeting", questions: [] };
  return cleanSurveySetup({ mode: "survey", questions: record.questions }) ?? {
    mode: "survey",
    questions: [...DEFAULT_SURVEY_QUESTIONS],
  };
}
