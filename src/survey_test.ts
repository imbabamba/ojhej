import { assertEquals } from "@std/assert";
import {
  cleanSurveySetup,
  DEFAULT_SURVEY_QUESTIONS,
  MAX_QUESTION,
  MAX_SURVEY_QUESTIONS,
  MIN_SURVEY_QUESTIONS,
  surveyOf,
} from "./survey.ts";

Deno.test("missing survey data is the original greeting flow", () => {
  assertEquals(surveyOf({}), { mode: "greeting", questions: [] });
  assertEquals(cleanSurveySetup({}), { mode: "greeting", questions: [] });
});

Deno.test("a survey carries between two and five short questions", () => {
  const questions = ["Vad gillar du?", "Vad gör dig glad?"];
  assertEquals(cleanSurveySetup({ mode: "survey", questions }), { mode: "survey", questions });

  assertEquals(
    cleanSurveySetup({ mode: "survey", questions: questions.slice(0, MIN_SURVEY_QUESTIONS - 1) }),
    null,
  );
  assertEquals(
    cleanSurveySetup({
      mode: "survey",
      questions: Array.from({ length: MAX_SURVEY_QUESTIONS + 1 }, () => "En fråga?"),
    }),
    null,
  );
  assertEquals(
    cleanSurveySetup({ mode: "survey", questions: ["A", "x".repeat(MAX_QUESTION + 1)] }),
    null,
  );
});

Deno.test("questions are made into one line and must contain words", () => {
  assertEquals(
    cleanSurveySetup({ mode: "survey", questions: ["  Vad\n gillar du?  ", "Något\tannat?"] }),
    { mode: "survey", questions: ["Vad gillar du?", "Något annat?"] },
  );
  assertEquals(cleanSurveySetup({ mode: "survey", questions: ["Bra?", "  \n "] }), null);
});

Deno.test("a corrupt stored survey gets a safe, useful draft", () => {
  assertEquals(surveyOf({ mode: "survey", questions: [7] }).questions, DEFAULT_SURVEY_QUESTIONS);
  assertEquals(surveyOf({ mode: "something-new", questions: ["A", "B"] }), {
    mode: "greeting",
    questions: [],
  });
});
