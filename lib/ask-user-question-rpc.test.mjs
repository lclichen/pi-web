import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runRpcQuestionnaire, CUSTOM_ROW_MARKER } = await jiti.import(
  "../pi-config/agent/extensions/rpiv-ask-user-question/rpc-fallback.ts",
);

const params = {
  questions: [
    {
      header: "Setup",
      question: "Pick one",
      options: [
        { label: "A", description: "first" },
        { label: "B", description: "second" },
      ],
    },
  ],
};

test("accepts an inline custom answer from the marked select response", async () => {
  let offered;
  let inputCalls = 0;
  const ui = {
    select: async (_title, options) => {
      offered = options;
      return `${CUSTOM_ROW_MARKER}typed answer`;
    },
    input: async () => {
      inputCalls += 1;
      return "must not open";
    },
  };
  const result = await runRpcQuestionnaire(ui, params);
  assert.deepEqual(result, {
    answers: [{ questionIndex: 0, question: "Pick one", kind: "custom", answer: "typed answer" }],
    cancelled: false,
  });
  assert.equal(inputCalls, 0, "inline answers must not open a second input dialog");
  assert.equal(offered.length, 3);
  assert.ok(offered[2].endsWith(CUSTOM_ROW_MARKER));
  assert.match(offered[2].slice(0, -CUSTOM_ROW_MARKER.length), /^3\. .+/);
});

test("keeps the select → input walk for hosts that select the row verbatim", async () => {
  let inputTitle;
  const ui = {
    select: async (_title, options) => options[2],
    input: async (title) => {
      inputTitle = title;
      return "typed from input";
    },
  };
  const result = await runRpcQuestionnaire(ui, params);
  assert.deepEqual(result.answers[0], {
    questionIndex: 0,
    question: "Pick one",
    kind: "custom",
    answer: "typed from input",
  });
  assert.match(inputTitle, /Pick one/);
});

test("a numeric inline answer stays custom instead of becoming an option index", async () => {
  const ui = {
    select: async () => `${CUSTOM_ROW_MARKER}42`,
    input: async () => "unused",
  };
  const result = await runRpcQuestionnaire(ui, params);
  assert.equal(result.answers[0].kind, "custom");
  assert.equal(result.answers[0].answer, "42");
});
