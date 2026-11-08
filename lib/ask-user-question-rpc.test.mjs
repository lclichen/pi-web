import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runRpcQuestionnaire, CUSTOM_ROW_MARKER, MULTI_SELECT_RESPONSE_MARKER } = await jiti.import(
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

const multiParams = {
  questions: [
    {
      header: "Setup",
      question: "Pick any",
      multiSelect: true,
      options: [
        { label: "A", description: "first" },
        { label: "B", description: "second" },
        { label: "C", description: "third" },
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

test("uses checkbox multi-select when the host advertises support", async () => {
  let offered;
  let selectOpts;
  const ui = {
    supportsMultiSelect: true,
    select: async (_title, options, opts) => {
      offered = options;
      selectOpts = opts;
      return `${MULTI_SELECT_RESPONSE_MARKER}${JSON.stringify({ selected: [0, 2], custom: "extra note" })}`;
    },
    input: async () => {
      throw new Error("must not open the legacy input dialog");
    },
  };
  const result = await runRpcQuestionnaire(ui, multiParams);
  assert.deepEqual(result.answers[0], {
    questionIndex: 0,
    question: "Pick any",
    kind: "multi",
    answer: "extra note",
    selected: ["A", "C"],
  });
  assert.equal(selectOpts.multiSelect, true);
  assert.equal(offered.length, 4);
  assert.ok(offered[3].endsWith(CUSTOM_ROW_MARKER));
});

test("keeps the comma-separated input for hosts without multi-select support", async () => {
  let inputTitle;
  const ui = {
    select: async () => {
      throw new Error("must not use select without the capability flag");
    },
    input: async (title) => {
      inputTitle = title;
      return "1,3";
    },
  };
  const result = await runRpcQuestionnaire(ui, multiParams);
  assert.deepEqual(result.answers[0], {
    questionIndex: 0,
    question: "Pick any",
    kind: "multi",
    answer: null,
    selected: ["A", "C"],
  });
  assert.match(inputTitle, /Pick any/);
  assert.match(inputTitle, /comma-separated/);
});
