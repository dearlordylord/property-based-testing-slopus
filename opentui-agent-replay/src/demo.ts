import {
  BoxRenderable,
  DiffRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
  type KeyEvent
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type Phase = "input-empty" | "input-typing" | "input" | "user" | "typing" | "complete";

type LawCard = {
  title: string;
  formula: string;
  art: string[];
};

type Exchange = {
  id: string;
  user: string;
  assistant: string;
  codeFrom: number;
  codeTo: number;
  preAgentCodeSteps?: number[];
  codeSteps?: number[];
  hiddenDiffFiles?: string[];
  silent?: boolean;
  lawCard?: LawCard;
};

type CodeState = {
  id: string;
  sourceRef?: string;
  fileRefs?: Record<string, string>;
  fileContents?: Record<string, string>;
  commitMessage: string;
};

type ViewState = {
  id: string;
  exchange: number;
  phase: Phase;
  code: number;
  visibleCodeSteps: number;
};

type PersistedState = {
  cursor: number;
  updatedAt: string;
};

type SessionLock = {
  pid: number;
  startedAt: string;
};

type Health =
  | { kind: "ok"; detail: string }
  | { kind: "recovered"; detail: string }
  | { kind: "dirty"; detail: string }
  | { kind: "diverged"; detail: string };

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const sourceRepoDir = path.resolve(projectDir, "..");
const sandboxDir = path.join(projectDir, "sandbox");
const workspaceDir = path.join(sandboxDir, "workspace");
const stateFile = path.join(sandboxDir, "state.json");
const lockFile = path.join(sandboxDir, "session.lock.json");
const ownerFile = path.join(sandboxDir, ".owned-by-opentui-agent-replay");

const sourceFiles = [
  "src/add.ts",
  "src/add.test.ts",
  "src/sort.ts",
  "src/sort.test.ts",
  "src/query.ts",
  "src/query.test.ts",
];

type TestSnippet = {
  name: string;
  body: string;
  needsFastCheck?: boolean;
  needsManualRandomInteger?: boolean;
};

const testSnippet = (
  name: string,
  body: string,
  needsFastCheck = false,
  needsManualRandomInteger = false
): TestSnippet => ({
  name,
  body,
  needsFastCheck,
  needsManualRandomInteger,
});

const indent = (source: string, spaces: number) =>
  source
    .trim()
    .split("\n")
    .map((line) => " ".repeat(spaces) + line)
    .join("\n");

const renderTestSnippet = (snippet: TestSnippet) =>
  `  it("${snippet.name}", () => {\n${indent(snippet.body, 4)}\n  });`;

const makeAddTestSource = (snippets: TestSnippet[]) => {
  const usesFastCheck = snippets.some((snippet) => snippet.needsFastCheck);
  const imports = [
    `import { describe, it } from "node:test";`,
    `import assert from "node:assert/strict";`,
  ];

  if (usesFastCheck) {
    imports.push(`import fc from "fast-check";`);
  }

  const fastCheckSetup = usesFastCheck
    ? `\nconst minSafeInput = Number.MIN_SAFE_INTEGER + 2;
const maxSafeInput = Number.MAX_SAFE_INTEGER - 2;
const sampledInteger = fc.integer({ min: minSafeInput, max: maxSafeInput });\n`
    : "";
  const randomIntegerSetup = snippets.some((snippet) => snippet.needsManualRandomInteger)
    ? `\nconst randomSmallInteger = () => Math.floor(Math.random() * 9) - 3;\n`
    : "";

  return `${imports.join("\n")}\n\nimport { add } from "./add.js";\n${fastCheckSetup}${randomIntegerSetup}\ndescribe("add", () => {\n${snippets
    .map(renderTestSnippet)
    .join("\n\n")}\n});\n`;
};

const commentLines = (source: string) =>
  source
    .split("\n")
    .map((line) => `  // ${line}`)
    .join("\n");

const makeAddTestSourceWithCommentedExamples = (
  commentedSnippets: TestSnippet[],
  activeSnippets: TestSnippet[]
) => {
  const usesFastCheck = activeSnippets.some((snippet) => snippet.needsFastCheck);
  const imports = [
    `import { describe, it } from "node:test";`,
    `import assert from "node:assert/strict";`,
  ];

  if (usesFastCheck) {
    imports.push(`import fc from "fast-check";`);
  }

  const fastCheckSetup = usesFastCheck
    ? `\nconst minSafeInput = Number.MIN_SAFE_INTEGER + 2;
const maxSafeInput = Number.MAX_SAFE_INTEGER - 2;
const sampledInteger = fc.integer({ min: minSafeInput, max: maxSafeInput });\n`
    : "";
  const randomIntegerSetup = activeSnippets.some((snippet) => snippet.needsManualRandomInteger)
    ? `\nconst randomSmallInteger = () => Math.floor(Math.random() * 9) - 3;\n`
    : "";
  const commented = commentedSnippets
    .map((snippet) => commentLines(renderTestSnippet(snippet).trimEnd()))
    .join("\n\n");
  const active = activeSnippets.map(renderTestSnippet).join("\n\n");

  return `${imports.join("\n")}\n\nimport { add } from "./add.js";\n${fastCheckSetup}${randomIntegerSetup}\ndescribe("add", () => {\n${commented}\n\n${active}\n});\n`;
};

const exampleTwoPlusTwo = testSnippet(
  "returns 4 for 2+2",
  `assert.equal(add(2, 2), 4);`
);
const exampleOnePlusThree = testSnippet(
  "returns 4 for 1+3",
  `assert.equal(add(1, 3), 4);`
);
const exampleNegativeOnePlusThree = testSnippet(
  "returns 2 for -1+3",
  `assert.equal(add(-1, 3), 2);`
);
const exampleThreePlusFive = testSnippet(
  "returns 8 for 3+5",
  `assert.equal(add(3, 5), 8);`
);
const exampleTwentySevenPlusFifteen = testSnippet(
  "returns 42 for 27+15",
  `assert.equal(add(27, 15), 42);`
);
const randomAdditionOracle = testSnippet(
  "matches numeric addition for random integers",
  `for (let run = 0; run < 1000; run += 1) {
  const a = randomSmallInteger();
  const b = randomSmallInteger();

  assert.equal(add(a, b), a + b);
}`,
  false,
  true
);
const swappedInputsProperty = testSnippet(
  "gives the same answer after swapping inputs",
  `for (let run = 0; run < 1000; run += 1) {
  const a = randomSmallInteger();
  const b = randomSmallInteger();

  assert.equal(add(a, b), add(b, a));
}`,
  false,
  true
);
const zeroCaseProperty = testSnippet(
  "returns x when adding zero",
  `for (let run = 0; run < 1000; run += 1) {
  const x = randomSmallInteger();

  assert.equal(add(x, 0), x);
}`,
  false,
  true
);
const doublingByOneProperty = testSnippet(
  "adding 1 twice equals adding 2 once",
  `for (let run = 0; run < 1000; run += 1) {
  const x = randomSmallInteger();

  assert.equal(add(add(x, 1), 1), add(x, 2));
}`,
  false,
  true
);
const fastCheckSwappedInputsProperty = testSnippet(
  "gives the same answer after swapping inputs",
  `fc.assert(
  fc.property(sampledInteger, sampledInteger, (a, b) => {
    assert.equal(add(a, b), add(b, a));
  }),
  { numRuns: 1000 }
);`,
  true
);
const fastCheckDoublingByOneProperty = testSnippet(
  "adding 1 twice equals adding 2 once",
  `fc.assert(
  fc.property(sampledInteger, (x) => {
    assert.equal(add(add(x, 1), 1), add(x, 2));
  }),
  { numRuns: 1000 }
);`,
  true
);
const fastCheckZeroCaseProperty = testSnippet(
  "returns x when adding zero",
  `fc.assert(
  fc.property(sampledInteger, (x) => {
    assert.equal(add(x, 0), x);
  }),
  { numRuns: 1000 }
);`,
  true
);

const exampleTests = [exampleTwoPlusTwo, exampleOnePlusThree];
const counterexampleTests = [...exampleTests, exampleNegativeOnePlusThree];
const expandedExampleTests = [
  ...counterexampleTests,
  exampleThreePlusFive,
  exampleTwentySevenPlusFifteen,
];
const swappedInputsTests = [...expandedExampleTests, swappedInputsProperty];
const commentedSwappedInputsTests = [swappedInputsProperty];
const doublingByOneTests = [...commentedSwappedInputsTests, doublingByOneProperty];
const zeroCaseTests = [...doublingByOneTests, zeroCaseProperty];
const fastCheckRefactoredTests = [
  fastCheckSwappedInputsProperty,
  fastCheckDoublingByOneProperty,
  fastCheckZeroCaseProperty,
];
const propertyOnlyTests = [
  fastCheckSwappedInputsProperty,
  fastCheckDoublingByOneProperty,
  fastCheckZeroCaseProperty,
];

const firstExamplesTestSource = makeAddTestSource(exampleTests);
const negativeExampleTestSource = makeAddTestSource(counterexampleTests);
const moreExamplesTestSource = makeAddTestSource(expandedExampleTests);
const randomAdditionOracleTestSource = makeAddTestSource([
  ...expandedExampleTests,
  randomAdditionOracle,
]);
const swappedInputsTestSource = makeAddTestSource(swappedInputsTests);
const commentedSwappedInputsTestSource = makeAddTestSourceWithCommentedExamples(
  expandedExampleTests,
  commentedSwappedInputsTests
);
const zeroCaseTestSource = makeAddTestSourceWithCommentedExamples(
  expandedExampleTests,
  zeroCaseTests
);
const fastCheckRefactoredTestSource = makeAddTestSourceWithCommentedExamples(
  expandedExampleTests,
  fastCheckRefactoredTests
);
const doublingByOneTestSource = makeAddTestSourceWithCommentedExamples(
  expandedExampleTests,
  doublingByOneTests
);
const propertyOnlyTestSource = makeAddTestSource(propertyOnlyTests);

const returnFourAddSource = `export function add(a: number, b: number): number {
  return 4;
}

export default add;
`;

const negativeExampleAddSource = `export function add(a: number, b: number): number {
  if (a === -1 && b === 3) {
    return 2;
  }

  return 4;
}

export default add;
`;

const moreExamplesAddSource = `export function add(a: number, b: number): number {
  if (a === -1 && b === 3) {
    return 2;
  }

  if (a === 3 && b === 5) {
    return 8;
  }

  if (a === 27 && b === 15) {
    return 42;
  }

  return 4;
}

export default add;
`;

const multiplyAddSource = `export function add(a: number, b: number): number {
  return a * b;
}

export default add;
`;

const subtractAddSource = `export function add(a: number, b: number): number {
  return a - b;
}

export default add;
`;

const returnZeroAddSource = `export function add(a: number, b: number): number {
  return 0;
}

export default add;
`;

const finalAdditionAddSource = `export function add(a: number, b: number): number {
  return a + b;
}

export default add;
`;

const sortSource = `export function sortNumbers(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export default sortNumbers;
`;

const sortTestSource = `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { sortNumbers } from "./sort.js";

const sampledInteger = fc.integer({
  min: Number.MIN_SAFE_INTEGER,
  max: Number.MAX_SAFE_INTEGER,
});
const sampledArray = fc.array(sampledInteger, { maxLength: 100 });

const frequencies = (values: number[]) => {
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
};

describe("sortNumbers", () => {
  it("returns values in ascending order", () => {
    fc.assert(
      fc.property(sampledArray, (values) => {
        const sorted = sortNumbers(values);

        for (let index = 1; index < sorted.length; index += 1) {
          assert.ok(sorted[index - 1] <= sorted[index]);
        }
      })
    );
  });

  it("keeps the same bag of values", () => {
    fc.assert(
      fc.property(sampledArray, (values) => {
        assert.deepEqual(frequencies(sortNumbers(values)), frequencies(values));
      })
    );
  });
});
`;

const querySource = `export function buildQuery(params: Record<string, string>): string {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    query.set(key, value);
  }

  return query.toString();
}

export function parseQuery(query: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of new URLSearchParams(query)) {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return result;
}
`;

const queryTestSource = `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { buildQuery, parseQuery } from "./query.js";

const queryParams = fc
  .dictionary(fc.string(), fc.string())
  .map((params) => ({ ...params }));

describe("query strings", () => {
  it("round-trips dictionaries through build and parse", () => {
    fc.assert(
      fc.property(queryParams, (params) => {
        assert.deepEqual(parseQuery(buildQuery(params)), params);
      })
    );
  });
});
`;

const codeStates: CodeState[] = [
  {
    id: "empty",
    commitMessage: "Empty project scaffold",
  },
  {
    id: "throw-only",
    sourceRef: "08e2cfe",
    commitMessage: "Agent adds throwing implementation and throw test",
  },
  {
    id: "same-result-examples-test",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.test.ts": firstExamplesTestSource,
    },
    commitMessage: "User adds two examples with the same result",
  },
  {
    id: "constant-four-implementation",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": returnFourAddSource,
      "src/add.test.ts": firstExamplesTestSource,
    },
    commitMessage: "Agent returns 4 for every input",
  },
  {
    id: "negative-example-test",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": returnFourAddSource,
      "src/add.test.ts": negativeExampleTestSource,
    },
    commitMessage: "User adds negative-input counterexample",
  },
  {
    id: "negative-example-implementation",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": negativeExampleAddSource,
      "src/add.test.ts": negativeExampleTestSource,
    },
    commitMessage: "Agent handles exact negative counterexample",
  },
  {
    id: "more-examples-test",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": negativeExampleAddSource,
      "src/add.test.ts": moreExamplesTestSource,
    },
    commitMessage: "User adds more exact examples",
  },
  {
    id: "more-examples-implementation",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": moreExamplesAddSource,
      "src/add.test.ts": moreExamplesTestSource,
    },
    commitMessage: "Agent handles more exact examples",
  },
  {
    id: "random-addition-oracle-test",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": moreExamplesAddSource,
      "src/add.test.ts": randomAdditionOracleTestSource,
    },
    commitMessage: "User adds random oracle test",
  },
  {
    id: "manual-swapped-inputs-test",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": moreExamplesAddSource,
      "src/add.test.ts": swappedInputsTestSource,
    },
    commitMessage: "User replaces oracle with swapped-input relation",
  },
  {
    id: "commented-examples-swapped-inputs-test",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": moreExamplesAddSource,
      "src/add.test.ts": commentedSwappedInputsTestSource,
    },
    commitMessage: "User comments example tests",
  },
  {
    id: "multiply-implementation",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": multiplyAddSource,
      "src/add.test.ts": commentedSwappedInputsTestSource,
    },
    commitMessage: "Agent switches to multiplication",
  },
  {
    id: "doubling-by-one-test",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": multiplyAddSource,
      "src/add.test.ts": doublingByOneTestSource,
    },
    commitMessage: "User adds add-one-twice property",
  },
  {
    id: "subtraction-attempt",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": subtractAddSource,
      "src/add.test.ts": doublingByOneTestSource,
    },
    commitMessage: "Agent tries subtraction",
  },
  {
    id: "return-zero-implementation",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": returnZeroAddSource,
      "src/add.test.ts": doublingByOneTestSource,
    },
    commitMessage: "Agent switches to return zero",
  },
  {
    id: "zero-case-test",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": returnZeroAddSource,
      "src/add.test.ts": zeroCaseTestSource,
    },
    commitMessage: "User adds zero case property",
  },
  {
    id: "zero-case-implementation",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": finalAdditionAddSource,
      "src/add.test.ts": zeroCaseTestSource,
    },
    commitMessage: "Agent switches to final addition implementation",
  },
  {
    id: "fastcheck-refactor-tests",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": finalAdditionAddSource,
      "src/add.test.ts": fastCheckRefactoredTestSource,
    },
    commitMessage: "User refactors randomized tests to fast-check",
  },
  {
    id: "property-only-tests",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": finalAdditionAddSource,
      "src/add.test.ts": propertyOnlyTestSource,
    },
    commitMessage: "User removes example tests",
  },
  {
    id: "sort-properties",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": finalAdditionAddSource,
      "src/add.test.ts": propertyOnlyTestSource,
      "src/sort.ts": sortSource,
      "src/sort.test.ts": sortTestSource,
    },
    commitMessage: "User adds sort properties",
  },
  {
    id: "query-roundtrip",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": finalAdditionAddSource,
      "src/add.test.ts": propertyOnlyTestSource,
      "src/sort.ts": sortSource,
      "src/sort.test.ts": sortTestSource,
      "src/query.ts": querySource,
      "src/query.test.ts": queryTestSource,
    },
    commitMessage: "User adds query round-trip property",
  },
];

const codeRefs = codeStates.map(
  (state, index) => `scenario/code-${String(index).padStart(2, "0")}-${state.id}`
);

const exchanges: Exchange[] = [
  {
    id: "init-add",
    user: "Initialize this project with an add function and a tiny test. It can throw for now; I just want the shape in place.",
    assistant: "Absolutely. I added the add function and the first tiny test. The function politely throws for now, and the test checks exactly that.",
    codeFrom: 0,
    codeTo: 1,
  },
  {
    id: "same-result-examples",
    user: "The tests now check that add(2, 2) returns 4 and add(1, 3) returns 4. Make them pass.",
    assistant: "Absolutely, I made them pass.",
    codeFrom: 1,
    codeTo: 3,
    preAgentCodeSteps: [2],
    codeSteps: [3],
    hiddenDiffFiles: ["src/add.ts"],
  },
  {
    id: "negative-example",
    user: "The test now also checks that add(-1, 3) returns 2. Make it pass.",
    assistant: "Absolutely, I made it pass.",
    codeFrom: 3,
    codeTo: 5,
    preAgentCodeSteps: [4],
    codeSteps: [5],
    hiddenDiffFiles: ["src/add.ts"],
  },
  {
    id: "more-examples",
    user: "The tests now also check that add(3, 5) returns 8 and add(27, 15) returns 42. Make them pass.",
    assistant: "Absolutely, I made them pass.",
    codeFrom: 5,
    codeTo: 7,
    preAgentCodeSteps: [6],
    codeSteps: [7],
    hiddenDiffFiles: ["src/add.ts"],
  },
  {
    id: "random-addition-oracle",
    user: "...",
    assistant: "...",
    codeFrom: 7,
    codeTo: 8,
    preAgentCodeSteps: [8],
    codeSteps: [],
  },
  {
    id: "swapped-inputs",
    user: "maybe just pass this test?",
    assistant: "Absolutely, I used multiplication. Multiplication gives the same answer after swapping inputs, so this passes that relation.",
    codeFrom: 8,
    codeTo: 11,
    preAgentCodeSteps: [9, 10],
    codeSteps: [11],
    lawCard: {
      title: "Swap inputs",
      formula: "same answer after swapping inputs",
      art: [
        "┌───┐     ┌───┐        ┌───┐     ┌───┐",
        "│ X │  ?  │ Y │   =    │ Y │  ?  │ X │",
        "└───┘     └───┘        └───┘     └───┘",
      ],
    },
  },
  {
    id: "doubling-by-one",
    user: "please pass this test too",
    assistant: "Absolutely, I tried subtraction. Subtracting one twice behaves like subtracting two once.",
    codeFrom: 11,
    codeTo: 13,
    preAgentCodeSteps: [12],
    codeSteps: [13],
    lawCard: {
      title: "One twice is two",
      formula: "(X + 1) + 1 = X + 2",
      art: [
        "┌───┐   ┌───┐   ┌───┐      ┌───┐   ┌───┐",
        "│ X │ + │ 1 │ + │ 1 │  =   │ X │ + │ 2 │",
        "└───┘   └───┘   └───┘      └───┘   └───┘",
      ],
    },
  },
  {
    id: "tests-still-fail",
    user: "you just failed the first test, could you up your game bro",
    assistant: "You are absolutely right! it passes both of your tests now",
    codeFrom: 13,
    codeTo: 14,
  },
  {
    id: "zero-case",
    user: "The test now checks that add(x, 0) returns x. Make it pass.",
    assistant: "Absolutely, I changed it to return a + b.",
    codeFrom: 14,
    codeTo: 16,
    preAgentCodeSteps: [15],
    codeSteps: [16],
    lawCard: {
      title: "Zero case",
      formula: "X + 0 = X",
      art: [
        "┌───┐     ┌───┐        ┌───┐",
        "│ X │  +  │ 0 │   =    │ X │",
        "└───┘     └───┘        └───┘",
      ],
    },
  },
  {
    id: "laws-summary",
    user: "...",
    assistant: "...",
    codeFrom: 16,
    codeTo: 16,
    preAgentCodeSteps: [16],
    codeSteps: [],
    lawCard: {
      title: "T̶e̶s̶t̶s̶ → Specs",
      formula: "commutativity + associativity + identity",
      art: [
        "COMMUTATIVITY",
        "┌───┐     ┌───┐        ┌───┐     ┌───┐",
        "│ X │  +  │ Y │   =    │ Y │  +  │ X │",
        "└───┘     └───┘        └───┘     └───┘",
        "",
        "ASSOCIATIVITY",
        "┌─────────┐     ┌───┐        ┌───┐     ┌─────────┐",
        "│ X  +  Y │  +  │ Z │   =    │ X │  +  │ Y  +  Z │",
        "└─────────┘     └───┘        └───┘     └─────────┘",
        "",
        "IDENTITY",
        "┌───┐     ┌───┐        ┌───┐",
        "│ X │  +  │ 0 │   =    │ X │",
        "└───┘     └───┘        └───┘",
      ],
    },
  },
  {
    id: "fastcheck-refactor",
    user: "I replaced the manual randomized tests with FastCheck and removed the old example tests.",
    assistant: "Absolutely, no implementation change is needed.",
    codeFrom: 16,
    codeTo: 18,
    preAgentCodeSteps: [18],
    codeSteps: [],
  },
  {
    id: "sort-example",
    user: "...",
    assistant: "...",
    codeFrom: 18,
    codeTo: 19,
    codeSteps: [19],
    lawCard: {
      title: "Real case: sort",
      formula: "ordered + same bag",
      art: [
        "ORDERED",
        "┌────┐  <=  ┌────┐  <=  ┌────┐",
        "│ x₀ │      │ x₁ │      │ x₂ │",
        "└────┘      └────┘      └────┘",
        "",
        "SAME BAG",
        "before: [3, 1, 2, 1]",
        "after:  [1, 1, 2, 3]",
      ],
    },
  },
  {
    id: "query-roundtrip",
    user: "...",
    assistant: "...",
    codeFrom: 19,
    codeTo: 20,
    codeSteps: [20],
    hiddenDiffFiles: ["src/query.ts"],
  },
  {
    id: "idempotency-examples",
    user: "...",
    assistant: "...",
    codeFrom: 20,
    codeTo: 20,
    preAgentCodeSteps: [20],
    codeSteps: [],
    lawCard: {
      title: "Idempotency",
      formula: "f(f(x)) = f(x)",
      art: [
        "migrate(migrate(data)) = migrate(data)",
        "format(format(src))   = format(src)",
        "escape(escape(s))     = escape(s)",
        "sort(sort(xs))        = sort(xs)",
        "dedupe(dedupe(xs))    = dedupe(xs)",
      ],
    },
  },
];
const viewStates = buildViewStates();
const inputStartCursorByExchange = cursorMapForPhase("input-empty");
const inputCursorByExchange = cursorMapForPhase("input");
const firstCompleteCursorByExchange = cursorMapForPhase("complete", "first");
const finalCompleteCursorByExchange = cursorMapForPhase("complete", "last");
const recoveryCursorByCode = buildRecoveryCursorByCode();

let cursor = 0;
let typingChars = 0;
let typingTimer: NodeJS.Timeout | undefined;
let health: Health = { kind: "ok", detail: "not started" };
let codeMoveBlocked = false;

function buildViewStates(): ViewState[] {
  return exchanges.flatMap((exchange, exchangeIndex) => {
    const preAgentSteps = exchangePreAgentCodeSteps(exchange);
    const agentSteps = exchangeAgentCodeSteps(exchange);
    const preAgentCode = preAgentSteps.at(-1) ?? exchange.codeFrom;
    const visiblePreAgentSteps = preAgentSteps.length;
    if (exchange.silent) {
      return [
        {
          id: exchange.id + "-diff",
          exchange: exchangeIndex,
          phase: "complete",
          code: preAgentCode,
          visibleCodeSteps: visiblePreAgentSteps,
        },
      ];
    }

    const states: ViewState[] = [
      {
        id: exchange.id + "-input-empty",
        exchange: exchangeIndex,
        phase: "input-empty",
        code: preAgentCode,
        visibleCodeSteps: visiblePreAgentSteps,
      },
      {
        id: exchange.id + "-input-typing",
        exchange: exchangeIndex,
        phase: "input-typing",
        code: preAgentCode,
        visibleCodeSteps: visiblePreAgentSteps,
      },
      {
        id: exchange.id + "-input",
        exchange: exchangeIndex,
        phase: "input",
        code: preAgentCode,
        visibleCodeSteps: visiblePreAgentSteps,
      },
      {
        id: exchange.id + "-user",
        exchange: exchangeIndex,
        phase: "user",
        code: preAgentCode,
        visibleCodeSteps: visiblePreAgentSteps,
      },
      {
        id: exchange.id + "-typing",
        exchange: exchangeIndex,
        phase: "typing",
        code: preAgentCode,
        visibleCodeSteps: visiblePreAgentSteps,
      },
    ];

    if (agentSteps.length === 0) {
      states.push({
        id: exchange.id + "-complete",
        exchange: exchangeIndex,
        phase: "complete",
        code: preAgentCode,
        visibleCodeSteps: visiblePreAgentSteps,
      });
      return states;
    }

    for (let index = 0; index < agentSteps.length; index += 1) {
      states.push({
        id: exchange.id + "-complete-" + String(index + 1),
        exchange: exchangeIndex,
        phase: "complete",
        code: agentSteps[index],
        visibleCodeSteps: visiblePreAgentSteps + index + 1,
      });
    }

    return states;
  });
}

function cursorMapForPhase(phase: Phase, edge: "first" | "last" = "first"): Map<number, number> {
  const map = new Map<number, number>();
  for (let index = 0; index < viewStates.length; index += 1) {
    const state = viewStates[index];
    if (state.phase !== phase) {
      continue;
    }

    if (edge === "first" && map.has(state.exchange)) {
      continue;
    }

    map.set(state.exchange, index);
  }
  return map;
}

function buildRecoveryCursorByCode(): Map<number, number> {
  const map = new Map<number, number>();
  for (let index = 0; index < viewStates.length; index += 1) {
    const code = viewStates[index].code;
    if (!map.has(code)) {
      map.set(code, index);
    }
  }
  return map;
}


function exchangeCodeSteps(exchange: Exchange): number[] {
  return [...exchangePreAgentCodeSteps(exchange), ...exchangeAgentCodeSteps(exchange)];
}

function exchangePreAgentCodeSteps(exchange: Exchange): number[] {
  return exchange.preAgentCodeSteps ?? [];
}

function exchangeAgentCodeSteps(exchange: Exchange): number[] {
  return exchange.codeSteps ?? [exchange.codeTo];
}

function main(): void {
  const args = new Set(process.argv.slice(2));

  if (args.has("--prepare-only")) {
    prepareSandbox();
    console.log(`Prepared sandbox workspace: ${workspaceDir}`);
    return;
  }

  if (args.has("--status-only")) {
    ensureSandboxExists();
    const state = reconcileState();
    console.log(JSON.stringify(readStatus(state), null, 2));
    return;
  }

  if (args.has("--validate-ui")) {
    ensureSandboxExists();
    validateUi().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
    return;
  }

  ensureSandboxExists();
  acquireLock();
  process.on("exit", releaseLock);
  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(143));

  const persisted = reconcileState();
  cursor = persisted.cursor;
  runTui().catch((error: unknown) => {
    restoreTerminalAfterError();
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    shutdown(1);
  });
}

function prepareSandbox(): void {
  assertSafeSandboxDelete();
  rmSync(sandboxDir, { recursive: true, force: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(ownerFile, "This sandbox is owned by opentui-agent-replay.\n");

  git(["init"], workspaceDir);
  git(["config", "user.name", "Agent Replay"], workspaceDir);
  git(["config", "user.email", "agent-replay@example.invalid"], workspaceDir);
  writeFileSync(path.join(workspaceDir, ".git", "info", "exclude"), ".scenario-replay/\n");

  for (let index = 0; index < codeStates.length; index += 1) {
    writeSnapshot(index);
    git(["add", "."], workspaceDir);
    git(["commit", "-m", codeStates[index].commitMessage], workspaceDir);
    git(["branch", "-f", codeRefs[index]], workspaceDir);
  }

  switchCodeTo(0, { allowForce: true });
  saveState({ cursor: 0, updatedAt: new Date().toISOString() });
}

function ensureSandboxExists(): void {
  if (!existsSync(workspaceDir) || !existsSync(ownerFile) || !existsSync(path.join(workspaceDir, ".git"))) {
    prepareSandbox();
    return;
  }

  if (codeRefs.some((ref) => !gitSucceeds(["rev-parse", "--verify", ref], workspaceDir))) {
    if (isWorkspaceDirty()) {
      throw new Error(
        "The existing sandbox is dirty and belongs to an older cassette; refusing to rebuild it automatically."
      );
    }
    prepareSandbox();
  }
}

function assertSafeSandboxDelete(): void {
  if (existsSync(sandboxDir) && !existsSync(ownerFile)) {
    throw new Error(
      `Refusing to delete ${sandboxDir}; it is not marked as an owned replay sandbox.`
    );
  }
}

function writeSnapshot(index: number): void {
  rmSync(path.join(workspaceDir, "src"), { recursive: true, force: true });
  rmSync(path.join(workspaceDir, "package.json"), { force: true });
  mkdirSync(path.join(workspaceDir, "src"), { recursive: true });

  writeFileSync(
    path.join(workspaceDir, "package.json"),
    `${JSON.stringify(
      {
        name: "add-adversary-cassette",
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: {
          test: "tsx --test src/*.test.ts"
        },
        devDependencies: {
          "fast-check": "^4.8.0",
          tsx: "^4.22.4"
        }
      },
      null,
      2
    )}\n`
  );

  const sourceRef = codeStates[index].sourceRef;
  if (!sourceRef) {
    return;
  }

  for (const file of sourceFiles) {
    const fileRef = codeStates[index].fileRefs?.[file] ?? sourceRef;
    const target = path.join(workspaceDir, file);
    const explicitContent = codeStates[index].fileContents?.[file];
    if (explicitContent === undefined && !gitSucceeds(["cat-file", "-e", `${fileRef}:${file}`], sourceRepoDir)) {
      continue;
    }

    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, explicitContent ?? readSourceFileAtRef(fileRef, file));
  }
}

function readSourceFileAtRef(ref: string, file: string): string {
  return gitRawOutput(["show", `${ref}:${file}`], sourceRepoDir);
}

function acquireLock(): void {
  mkdirSync(sandboxDir, { recursive: true });

  if (existsSync(lockFile)) {
    const lock = readJson<SessionLock>(lockFile);
    if (lock && isPidAlive(lock.pid)) {
      throw new Error(
        `Another replay session appears to be running as pid ${lock.pid}. Remove ${lockFile} only if that process is gone.`
      );
    }
  }

  writeJson(lockFile, {
    pid: process.pid,
    startedAt: new Date().toISOString()
  });
}

function releaseLock(): void {
  const lock = readJson<SessionLock>(lockFile);
  if (lock?.pid === process.pid) {
    rmSync(lockFile, { force: true });
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reconcileState(): PersistedState {
  const saved = readState();
  let next = clampState(saved);
  health = { kind: "ok", detail: "state and workspace agree" };
  codeMoveBlocked = false;

  if (isWorkspaceDirty()) {
    health = {
      kind: "dirty",
      detail: "workspace has uncommitted changes; code moves are disabled until reset"
    };
    codeMoveBlocked = true;
    return next;
  }

  const head = gitOutput(["rev-parse", "HEAD"], workspaceDir);
  const expected = refCommit(codeRefs[viewStates[next.cursor].code]);

  if (head === expected) {
    return next;
  }

  const knownCode = codeRefs.findIndex((ref) => refCommit(ref) === head);
  const recoveryCursor = recoveryCursorByCode.get(knownCode);
  if (recoveryCursor !== undefined) {
    next = { cursor: recoveryCursor, updatedAt: new Date().toISOString() };
    saveState(next);
    health = {
      kind: "recovered",
      detail: `workspace HEAD matched ${codeRefs[knownCode]}; UI cursor was reconciled`
    };
    return next;
  }

  health = {
    kind: "diverged",
    detail: "workspace HEAD is not one of this scenario's code refs"
  };
  codeMoveBlocked = true;
  return next;
}

function readStatus(state: PersistedState): object {
  return {
    sandboxDir,
    workspaceDir,
    cursor: state.cursor,
    viewState: viewStates[state.cursor],
    health,
    dirty: isWorkspaceDirty(),
    head: existsSync(path.join(workspaceDir, ".git"))
      ? gitOutput(["rev-parse", "--short", "HEAD"], workspaceDir)
      : null
  };
}

async function runTui(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    targetFps: 30,
    backgroundColor: "#101214"
  });

  let rendererDestroyed = false;
  const destroy = (): void => {
    if (!rendererDestroyed) {
      rendererDestroyed = true;
      renderer.destroy();
    }
  };

  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#101214",
    padding: 1,
    gap: 1
  });

  const header = new TextRenderable(renderer, {
    id: "header",
    height: 2,
    width: "100%",
    fg: "#d6deeb",
    content: ""
  });

  const main = new BoxRenderable(renderer, {
    id: "main",
    flexGrow: 1,
    width: "100%",
    flexDirection: "row",
    gap: 1
  });

  const transcriptPanel = new BoxRenderable(renderer, {
    id: "transcript-panel",
    title: " Slopus 6.7 ",
    titleColor: "#80cbc4",
    border: true,
    borderStyle: "rounded",
    borderColor: "#3b4148",
    width: "48%",
    height: "100%",
    padding: 1
  });

  const transcriptScroll = new ScrollBoxRenderable(renderer, {
    id: "transcript-scroll",
    width: "100%",
    height: "100%",
    stickyScroll: true,
    stickyStart: "bottom"
  });

  const transcriptText = new TextRenderable(renderer, {
    id: "transcript",
    width: "100%",
    height: "auto",
    wrapMode: "word",
    fg: "#d6deeb",
    content: ""
  });

  const diffPanel = new BoxRenderable(renderer, {
    id: "diff-panel",
    title: " code diff ",
    titleColor: "#c3e88d",
    border: true,
    borderStyle: "rounded",
    borderColor: "#3b4148",
    width: "50%",
    height: "100%",
    flexDirection: "column",
    gap: 1,
    padding: 1
  });

  const emptyDiffPlaceholder = new TextRenderable(renderer, {
    id: "diff-empty-placeholder",
    width: "100%",
    height: "100%",
    fg: "#5f6872",
    content: ""
  });

  let activeDiffSlotIds: string[] = [];
  let activeDiffSlotKey = "";

  const inputPanel = new BoxRenderable(renderer, {
    id: "input-panel",
    title: " prompt ",
    titleColor: "#ffcb6b",
    border: true,
    borderStyle: "rounded",
    borderColor: "#3b4148",
    width: "100%",
    height: 5,
    padding: 1
  });

  const inputText = new TextRenderable(renderer, {
    id: "input",
    width: "100%",
    height: "100%",
    wrapMode: "word",
    fg: "#ffcb6b",
    content: ""
  });

  transcriptScroll.add(transcriptText);
  transcriptPanel.add(transcriptScroll);
  diffPanel.add(emptyDiffPlaceholder);
  inputPanel.add(inputText);
  main.add(transcriptPanel);
  main.add(diffPanel);
  root.add(header);
  root.add(main);
  root.add(inputPanel);
  renderer.root.add(root);

  const render = (): void => {
    const state = viewStates[cursor];
    header.content = buildHeader(state);
    transcriptText.content = buildTranscript(state);
    inputText.content = buildInput(state);
    renderDiffSlots(state);
    renderer.requestRender();
  };

  const renderDiffSlots = (state: ViewState): void => {
    const slots = renderedDiffSlotsForState(state);
    const lawCard = lawCardForState(state);
    const lawKey = lawCard
      ? [lawCard.title, lawCard.formula, ...lawCard.art].join("\0")
      : "";
    const slotKey = `${lawKey}\0\0${slots.map(({ file, diff }) => `${file}\0${diff}`).join("\0\0")}`;

    if (slotKey === activeDiffSlotKey) {
      return;
    }

    for (const id of activeDiffSlotIds) {
      diffPanel.remove(id);
    }
    activeDiffSlotIds = [];
    activeDiffSlotKey = slotKey;
    emptyDiffPlaceholder.visible = !lawCard && slots.length === 0;

    if (lawCard) {
      const section = new BoxRenderable(renderer, {
        id: "law-card-live",
        width: "100%",
        height: lawCardHeight(lawCard),
        flexDirection: "column",
        alignItems: "center",
        border: true,
        borderStyle: "rounded",
        borderColor: "#54606d",
        title: ` ${lawCard.title} `,
        titleColor: "#ffcb6b",
        padding: 0
      });

      const text = new TextRenderable(renderer, {
        id: "law-card-text-live",
        width: lawCardWidth(lawCard),
        height: "100%",
        fg: "#d6deeb",
        content: centeredLawArt(lawCard)
      });

      section.add(text);
      diffPanel.add(section);
      activeDiffSlotIds.push(section.id);
    }

    for (let index = 0; index < slots.length; index += 1) {
      const { file, diff } = slots[index];
      const isTestFile = file.endsWith(".test.ts");
      const isOnlyVisibleDiff = slots.length === 1;
      const section = new BoxRenderable(renderer, {
        id: `diff-section-live-${index}`,
        width: "100%",
        ...(isTestFile && !isOnlyVisibleDiff ? { height: 8 } : { flexGrow: 1 }),
        flexDirection: "column",
        gap: 0
      });

      const label = new TextRenderable(renderer, {
        id: `diff-file-live-${index}`,
        width: "100%",
        height: 1,
        fg: "#c3e88d",
        content: file
      });

      const scroll = new ScrollBoxRenderable(renderer, {
        id: `diff-scroll-live-${index}`,
        width: "100%",
        height: "100%",
        scrollY: true,
        scrollX: false,
        viewportCulling: false,
        verticalScrollbarOptions: {
          visible: "always"
        }
      });

      const view = new DiffRenderable(renderer, {
        id: `diff-live-${index}`,
        width: "100%",
        height: diffHeight(diff),
        diff,
        view: "unified",
        filetype: "typescript",
        wrapMode: "none",
        showLineNumbers: true
      });

      section.add(label);
      scroll.add(view);
      section.add(scroll);
      diffPanel.add(section);
      activeDiffSlotIds.push(section.id);
    }
  };

  const enterState = (nextCursor: number): void => {
    stopTyping();
    cursor = clampCursor(nextCursor);
    typingChars = 0;
    saveState({ cursor, updatedAt: new Date().toISOString() });
    render();
  };

  const completeInputTyping = (): void => {
    const state = viewStates[cursor];
    if (state.phase !== "input-typing") {
      return;
    }

    const inputCursor = inputCursorByExchange.get(state.exchange);
    if (inputCursor === undefined) {
      return;
    }

    stopTyping();
    cursor = inputCursor + 1;
    typingChars = exchanges[state.exchange].user.length;
    saveState({ cursor, updatedAt: new Date().toISOString() });
    render();
  };

  const completeAgentTyping = (): void => {
    const state = viewStates[cursor];
    if (state.phase !== "typing") {
      return;
    }

    const completeCursor = finalCompleteCursorByExchange.get(state.exchange);
    if (completeCursor === undefined) {
      return;
    }

    const completeState = viewStates[completeCursor];
    if (!moveCode(completeState.code)) {
      render();
      return;
    }

    stopTyping();
    cursor = completeCursor;
    typingChars = exchanges[state.exchange].assistant.length;
    saveState({ cursor, updatedAt: new Date().toISOString() });
    render();
  };

  const startInputTyping = (): void => {
    stopTyping();
    typingChars = 0;
    cursor += 1;
    saveState({ cursor, updatedAt: new Date().toISOString() });
    render();
    scheduleTypingTimer();
  };

  const jumpToInputTyping = (nextCursor: number): void => {
    const nextState = viewStates[clampCursor(nextCursor)];
    if (!moveCode(nextState.code)) {
      render();
      return;
    }

    stopTyping();
    typingChars = 0;
    cursor = clampCursor(nextCursor);
    saveState({ cursor, updatedAt: new Date().toISOString() });
    render();
    scheduleTypingTimer();
  };

  const startAgentTyping = (): void => {
    stopTyping();
    typingChars = 0;
    cursor += 1;
    saveState({ cursor, updatedAt: new Date().toISOString() });
    render();
    scheduleTypingTimer();
  };

  const scheduleTypingTimer = (): void => {
    stopTyping();
    typingTimer = setInterval(() => {
      const state = viewStates[cursor];
      const exchange = exchanges[state.exchange];
      const text =
        state.phase === "input-typing"
          ? exchange.user
          : state.phase === "typing"
            ? exchange.assistant
            : "";

      if (text.length === 0) {
        stopTyping();
        return;
      }

      typingChars = Math.min(text.length, typingChars + 4);
      render();
      if (typingChars >= text.length) {
        if (state.phase === "input-typing") {
          completeInputTyping();
        } else {
          completeAgentTyping();
        }
      }
    }, 28);
  };

  const forward = (): void => {
    const state = viewStates[cursor];
    if (state.phase === "input-typing") {
      completeInputTyping();
      return;
    }

    if (state.phase === "typing") {
      completeAgentTyping();
      return;
    }

    if (state.phase === "complete") {
      if (cursor < viewStates.length - 1) {
        const nextState = viewStates[cursor + 1];
        if (nextState.phase === "input-empty") {
          jumpToInputTyping(cursor + 2);
          return;
        }
        if (nextState.phase === "complete" && nextState.exchange === state.exchange) {
          if (!moveCode(nextState.code)) {
            render();
            return;
          }
        }
        enterState(cursor + 1);
      }
      return;
    }

    if (state.phase === "user") {
      startAgentTyping();
      return;
    }

    if (state.phase === "input-empty") {
      startInputTyping();
      return;
    }

    enterState(cursor + 1);
  };

  const backward = (): void => {
    const state = viewStates[cursor];

    if (state.phase === "input-empty") {
      if (state.exchange > 0) {
        const previousComplete = finalCompleteCursorByExchange.get(state.exchange - 1);
        if (previousComplete !== undefined) {
          if (!moveCode(viewStates[previousComplete].code)) {
            render();
            return;
          }
          enterState(previousComplete);
        }
      }
      return;
    }

    if (state.phase === "input-typing" || state.phase === "input") {
      const inputStartCursor = inputStartCursorByExchange.get(state.exchange);
      if (inputStartCursor !== undefined) {
        enterState(inputStartCursor);
      }
      return;
    }

    if (state.phase === "complete") {
      const previousState = viewStates[cursor - 1];
      if (previousState?.phase === "complete" && previousState.exchange === state.exchange) {
        if (!moveCode(previousState.code)) {
          render();
          return;
        }
        enterState(cursor - 1);
        return;
      }
    }

    const previousState = viewStates[cursor - 1];
    if (previousState?.phase === "complete" && exchanges[previousState.exchange].silent) {
      if (!moveCode(previousState.code)) {
        render();
        return;
      }
      enterState(cursor - 1);
      return;
    }

    const inputCursor = inputCursorByExchange.get(state.exchange);
    if (inputCursor === undefined) {
      return;
    }

    const inputState = viewStates[inputCursor];
    if (!moveCode(inputState.code)) {
      render();
      return;
    }

    enterState(inputCursor);
  };

  const resetSandboxFromUi = (): void => {
    prepareSandbox();
    health = { kind: "ok", detail: "sandbox rebuilt from scenario refs" };
    codeMoveBlocked = false;
    cursor = 0;
    typingChars = 0;
    render();
  };

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.name === "right") {
      forward();
    } else if (key.name === "left") {
      backward();
    } else if (key.name === "r") {
      resetSandboxFromUi();
    } else if (key.name === "q" || (key.ctrl && key.name === "c")) {
      stopTyping();
      destroy();
      releaseLock();
      process.exit(0);
    }
  });

  try {
    render();
    if (viewStates[cursor].phase === "input-typing" || viewStates[cursor].phase === "typing") {
      scheduleTypingTimer();
    }
  } finally {
    process.once("exit", destroy);
  }
}

function buildHeader(state: ViewState): string {
  const codeRef = codeRefs[state.code];
  const phase = state.phase.padEnd(8, " ");
  const step = `${String(cursor).padStart(2, "0")}/${viewStates.length - 1}`;
  const exchangeId = exchanges[state.exchange].id;
  const healthText = `${health.kind}: ${health.detail}`;
  return [
    "OpenTUI cached agent replay",
    `left/right: step  r: rebuild sandbox  q: quit  step: ${step}  id: ${state.id}  exchange: ${exchangeId}  phase: ${phase}  code: ${codeRef}  ${healthText}`
  ].join("\n");
}

function buildTranscript(state: ViewState): string {
  const blocks: string[] = [];

  for (let i = 0; i < state.exchange; i += 1) {
    if (exchanges[i].silent) {
      continue;
    }

    blocks.push(formatMessage("USER", exchanges[i].user));
    blocks.push(formatMessage("AGENT", exchanges[i].assistant));
  }

  const current = exchanges[state.exchange];
  if (current.silent) {
    return blocks.length > 0 ? blocks.join("\n\n") : "No sent messages yet.";
  }

  if (state.phase === "user" || state.phase === "typing" || state.phase === "complete") {
    blocks.push(formatMessage("USER", current.user));
  }

  if (state.phase === "typing") {
    const visible = current.assistant.slice(0, typingChars);
    blocks.push(formatMessage("AGENT", `${visible}${typingChars < current.assistant.length ? "..." : ""}`));
  } else if (state.phase === "complete") {
    blocks.push(formatMessage("AGENT", current.assistant));
  }

  return blocks.length > 0 ? blocks.join("\n\n") : "No sent messages yet.";
}

function buildInput(state: ViewState): string {
  const userText = exchanges[state.exchange].user;
  if (exchanges[state.exchange].silent) {
    return "";
  }

  if (state.phase === "input-typing") {
    return userText.slice(0, typingChars);
  }
  if (state.phase === "input") {
    return userText;
  }
  return "";
}

function formatMessage(role: string, text: string): string {
  const label = role === "USER" ? "You" : "Slopus";
  return `${label}: ${text}`;
}

function buildDiff(state: ViewState): string {
  const diffsByFile = buildDiffByFile(state);
  return [...diffsByFile]
    .map(([file, diff]) => `${file}\n${diff.trimEnd()}`)
    .join("\n\n");
}

function buildDiffByFile(state: ViewState): Map<string, string> {
  const exchange = exchanges[state.exchange];
  return visibleDiffByFileForExchange(exchange, state.visibleCodeSteps);
}

function renderedDiffSlotsForState(state: ViewState): Array<{ file: string; diff: string }> {
  const diffsByFile = buildDiffByFile(state);
  return [...diffsByFile]
    .map(([file, diff]) => ({ file, diff }))
    .filter(({ diff }) => isRenderableGitDiff(diff));
}

function lawCardForState(state: ViewState): LawCard | undefined {
  if (state.visibleCodeSteps === 0) {
    return undefined;
  }

  return exchanges[state.exchange].lawCard;
}

function lawCardWidth(card: LawCard): number {
  return Math.max(...card.art.map((line) => line.length));
}

function lawCardHeight(card: LawCard): number {
  return Math.max(7, Math.min(20, card.art.length + 4));
}

function centeredLawArt(card: LawCard): string {
  const width = lawCardWidth(card);
  return card.art
    .map((line) => `${" ".repeat(Math.floor((width - line.length) / 2))}${line}`)
    .join("\n");
}

function diffHeight(diff: string): number {
  return Math.max(1, diff.split("\n").length + 1);
}

function validateUserOwnedTestContracts(): void {
  const contracts = [
    { id: "negative-example", requiresAgentImplementation: true },
    { id: "same-result-examples", requiresAgentImplementation: true },
    { id: "more-examples", requiresAgentImplementation: true },
    { id: "random-addition-oracle", requiresAgentImplementation: false },
    { id: "swapped-inputs", requiresAgentImplementation: true },
    { id: "doubling-by-one", requiresAgentImplementation: true },
    { id: "zero-case", requiresAgentImplementation: true },
    { id: "fastcheck-refactor", requiresAgentImplementation: false },
  ];

  for (const contract of contracts) {
    const exchange = exchanges.find((candidate) => candidate.id === contract.id);
    if (!exchange) {
      throw new Error("Missing cassette exchange: " + contract.id);
    }

    if (exchangePreAgentCodeSteps(exchange).length === 0) {
      throw new Error("Exchange " + contract.id + " must show the user-owned test diff before the assistant response.");
    }

    const exchangeIndex = exchanges.indexOf(exchange);
    if (exchange.silent) {
      const completeCursor = finalCompleteCursorByExchange.get(exchangeIndex);
      if (completeCursor === undefined) {
        throw new Error("Exchange " + contract.id + " is missing its silent diff state.");
      }

      if (exchange.user !== "" || exchange.assistant !== "") {
        throw new Error("Exchange " + contract.id + " is silent but still has transcript text.");
      }

      const renderedSlots = renderedDiffSlotsForState(viewStates[completeCursor]);
      if (
        renderedSlots.length !== 1 ||
        renderedSlots[0].file !== "src/add.test.ts" ||
        renderedSlots.some((slot) => slot.file === "src/add.ts")
      ) {
        throw new Error("Exchange " + contract.id + " must render only the user-owned test diff.");
      }

      continue;
    }

    const inputCursor = inputCursorByExchange.get(exchangeIndex);
    const finalCursor = finalCompleteCursorByExchange.get(exchangeIndex);
    if (inputCursor === undefined || finalCursor === undefined) {
      throw new Error("Exchange " + contract.id + " is missing input or completion states.");
    }

    const beforeAgentSlots = renderedDiffSlotsForState(viewStates[inputCursor]);
    const afterAgentSlots = renderedDiffSlotsForState(viewStates[finalCursor]);
    const appendedSlots = afterAgentSlots.slice(beforeAgentSlots.length);

    if (!beforeAgentSlots.some((slot) => slot.file === "src/add.test.ts")) {
      throw new Error("Exchange " + contract.id + " must show the user-owned test diff before the assistant response.");
    }

    if (beforeAgentSlots.some((slot) => slot.file === "src/add.ts")) {
      throw new Error("Exchange " + contract.id + " shows implementation changes before the assistant response.");
    }

    if (appendedSlots.some((slot) => slot.file === "src/add.test.ts")) {
      throw new Error("Exchange " + contract.id + " lets the assistant write or delete tests.");
    }

    const hidesImplementationDiff = exchange.hiddenDiffFiles?.includes("src/add.ts") ?? false;
    const actualAppendedDiffs = diffByFileForExchange(exchange, viewStates[finalCursor].visibleCodeSteps);
    const hasActualImplementationDiff = actualAppendedDiffs.has("src/add.ts");

    if (
      contract.requiresAgentImplementation &&
      !hidesImplementationDiff &&
      !appendedSlots.some((slot) => slot.file === "src/add.ts")
    ) {
      throw new Error("Exchange " + contract.id + " must append an implementation diff after the assistant response.");
    }

    if (contract.requiresAgentImplementation && hidesImplementationDiff && !hasActualImplementationDiff) {
      throw new Error("Exchange " + contract.id + " hides an implementation diff that does not exist.");
    }
  }
}

async function validateUi(): Promise<void> {
  validateCassetteContract();

  for (const state of viewStates) {
    for (const [slotIndex, { file, diff }] of renderedDiffSlotsForState(state).entries()) {
      await validateDiffRenderable(state.id, slotIndex, file, diff);
    }
  }

  console.log(`Validated ${viewStates.length} OpenTUI states.`);
}

async function validateDiffRenderable(
  stateId: string,
  slotIndex: number,
  file: string,
  diff: string
): Promise<void> {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const container = new BoxRenderable(setup.renderer, {
    width: "100%",
    height: "100%"
  });

  try {
    const diffView = new DiffRenderable(setup.renderer, {
      id: `validation-diff-${stateId}-${slotIndex}`,
      width: "100%",
      height: "100%",
      diff,
      view: "unified",
      filetype: "typescript",
      wrapMode: "none",
      showLineNumbers: true
    });

    container.add(diffView);
    setup.renderer.root.add(container);
    await setup.renderOnce();
    await setup.flush();

    const frame = setup.captureCharFrame();
    if (frame.includes("Error parsing diff")) {
      throw new Error(
        `OpenTUI diff failed to render for state ${stateId}, slot ${slotIndex}, file ${file}\n${frame
          .split("\n")
          .slice(0, 8)
          .join("\n")}`
      );
    }
  } finally {
    setup.renderer.destroy();
  }
}

function validateCassetteContract(): void {
  const initComplete = viewStates.find(
    (state) => state.exchange === 0 && state.phase === "complete"
  );

  if (!initComplete) {
    throw new Error("Cassette contract failed: init exchange has no complete state");
  }

  const initDiff = buildDiff(initComplete);
  for (const file of ["src/add.ts", "src/add.test.ts"]) {
    if (!hasGroupedFileDiff(initDiff, file)) {
      throw new Error(`Cassette contract failed: init grouped diff is missing ${file}`);
    }
  }

  if (!initDiff.includes("export function add")) {
    throw new Error("Cassette contract failed: init diff does not include add implementation");
  }

  if (!initDiff.includes("assert.throws")) {
    throw new Error("Cassette contract failed: init diff does not include throw-expecting test");
  }

  for (const exchange of exchanges) {
    const text = `${exchange.user}\n${exchange.assistant}`;
    if (/\badversar/i.test(text)) {
      throw new Error(`Cassette contract failed: exchange ${exchange.id} uses explicit adversary wording`);
    }
    if (/cheapest implementation/i.test(text)) {
      throw new Error(`Cassette contract failed: exchange ${exchange.id} explains the trick too directly`);
    }
  }

  for (let exchangeIndex = 0; exchangeIndex < exchanges.length; exchangeIndex += 1) {
    if (exchanges[exchangeIndex].silent) {
      continue;
    }

    const inputCursor = inputCursorByExchange.get(exchangeIndex);
    if (inputCursor === undefined || viewStates[inputCursor + 1]?.phase !== "user") {
      throw new Error(
        `Cassette contract failed: exchange ${exchangeIndex} prompt typing does not auto-submit to transcript`
      );
    }
  }

  validateNegativeExampleSplitContract();
  validateMoreExamplesSplitContract();
  validateSortExampleContract();
  validateQueryRoundtripContract();
  validateUserOwnedTestContracts();
  validateHiddenDiffContracts();
  validateSilentNavigationContract();
  validateLawCardContract();

  for (const [exchangeIndex, completeCursor] of finalCompleteCursorByExchange.entries()) {
    if (exchangeIndex >= exchanges.length - 1) {
      continue;
    }

    if (exchanges[exchangeIndex + 1]?.silent) {
      continue;
    }

    const nextState = viewStates[completeCursor + 1];
    const typingState = viewStates[completeCursor + 2];
    if (nextState?.phase !== "input-empty" || typingState?.phase !== "input-typing") {
      throw new Error(
        `Cassette contract failed: exchange ${exchangeIndex} cannot skip from complete to next prompt typing`
      );
    }
  }

  for (const state of viewStates) {
    const renderedSlots = renderedDiffSlotsForState(state);
    if (state.visibleCodeSteps === 0 && renderedSlots.length > 0) {
      throw new Error(`Cassette contract failed: ${state.id} renders unexpected diffs`);
    }

    if (state.visibleCodeSteps > 0 && renderedSlots.length === 0 && !lawCardForState(state)) {
      throw new Error(`Cassette contract failed: ${state.id} would render no diff widgets`);
    }

    for (const { file, diff } of renderedSlots) {
      if (!isRenderableGitDiff(diff)) {
        throw new Error(`Cassette contract failed: ${state.id} would render an invalid diff for ${file}`);
      }
    }
  }
}

function validateHiddenDiffContracts(): void {
  const hiddenCursors = [
    { cursor: 11, exchange: "same-result-examples" },
    { cursor: 17, exchange: "negative-example" },
    { cursor: 23, exchange: "more-examples" },
  ];

  for (const expected of hiddenCursors) {
    const state = viewStates[expected.cursor];
    if (!state || exchanges[state.exchange].id !== expected.exchange) {
      throw new Error(
        `Cassette contract failed: cursor ${expected.cursor} no longer points at ${expected.exchange}`
      );
    }

    if (state.phase !== "complete") {
      throw new Error(
        `Cassette contract failed: cursor ${expected.cursor} must be the completed ${expected.exchange} state`
      );
    }

    const renderedSlots = renderedDiffSlotsForState(state);
    if (renderedSlots.some((slot) => slot.file === "src/add.ts")) {
      throw new Error(`Cassette contract failed: cursor ${expected.cursor} must not render the add.ts diff`);
    }

    const renderedDiff = renderedSlots.map((slot) => slot.diff).join("\n");
    if (renderedDiff.includes("return 4")) {
      throw new Error(`Cassette contract failed: cursor ${expected.cursor} still renders add.ts fallback code`);
    }
  }
}

function validateSilentNavigationContract(): void {
  for (let index = 1; index < viewStates.length; index += 1) {
    const previousState = viewStates[index - 1];
    const state = viewStates[index];
    if (previousState.phase !== "complete" || !exchanges[previousState.exchange].silent) {
      continue;
    }

    if (state.exchange !== previousState.exchange + 1) {
      throw new Error("Cassette contract failed: silent state is not followed by the next exchange");
    }
  }
}

function validateLawCardContract(): void {
  const expectedCards = [
    { id: "swapped-inputs", formula: "same answer after swapping inputs" },
    { id: "doubling-by-one", formula: "(X + 1) + 1 = X + 2" },
    { id: "zero-case", formula: "X + 0 = X" },
    { id: "laws-summary", formula: "commutativity + associativity + identity" },
    { id: "sort-example", formula: "ordered + same bag" },
    { id: "idempotency-examples", formula: "f(f(x)) = f(x)" },
  ];

  for (const expected of expectedCards) {
    const exchangeIndex = exchanges.findIndex((exchange) => exchange.id === expected.id);
    if (exchangeIndex < 0) {
      throw new Error(`Cassette contract failed: ${expected.id} exchange is missing`);
    }

    const completeCursor = finalCompleteCursorByExchange.get(exchangeIndex);
    if (completeCursor === undefined) {
      throw new Error(`Cassette contract failed: ${expected.id} completion cursor is missing`);
    }

    const card = lawCardForState(viewStates[completeCursor]);
    if (!card || card.formula !== expected.formula || card.art.length === 0) {
      throw new Error(`Cassette contract failed: ${expected.id} law card is missing or incomplete`);
    }
  }
}

function validateNegativeExampleSplitContract(): void {
  const exchangeIndex = exchanges.findIndex((exchange) => exchange.id === "negative-example");
  if (exchangeIndex < 0) {
    throw new Error("Cassette contract failed: negative-example exchange is missing");
  }

  const inputCursor = inputCursorByExchange.get(exchangeIndex);
  const completeCursor = finalCompleteCursorByExchange.get(exchangeIndex);
  if (inputCursor === undefined || completeCursor === undefined) {
    throw new Error("Cassette contract failed: negative-example cursors are missing");
  }

  const beforeAgentSlots = renderedDiffSlotsForState(viewStates[inputCursor]);
  if (
    beforeAgentSlots.length !== 1 ||
    beforeAgentSlots[0].file !== "src/add.test.ts" ||
    !beforeAgentSlots[0].diff.includes("returns 2 for -1+3")
  ) {
    throw new Error("Cassette contract failed: negative-example must show only the user-added test before agent work");
  }

  const afterAgentSlots = renderedDiffSlotsForState(viewStates[completeCursor]);
  if (
    afterAgentSlots.length !== 1 ||
    afterAgentSlots[0].file !== "src/add.test.ts" ||
    afterAgentSlots.some((slot) => slot.file === "src/add.ts")
  ) {
    throw new Error(
      "Cassette contract failed: negative-example must keep the implementation diff hidden"
    );
  }

  const actualDiffs = diffByFileForExchange(exchanges[exchangeIndex], viewStates[completeCursor].visibleCodeSteps);
  if (!actualDiffs.get("src/add.ts")?.includes("return 2")) {
    throw new Error("Cassette contract failed: negative-example hidden implementation diff is missing");
  }
}

function validateMoreExamplesSplitContract(): void {
  const exchangeIndex = exchanges.findIndex((exchange) => exchange.id === "more-examples");
  if (exchangeIndex < 0) {
    throw new Error("Cassette contract failed: more-examples exchange is missing");
  }

  const inputCursor = inputCursorByExchange.get(exchangeIndex);
  const completeCursor = finalCompleteCursorByExchange.get(exchangeIndex);
  if (inputCursor === undefined || completeCursor === undefined) {
    throw new Error("Cassette contract failed: more-examples cursors are missing");
  }

  const beforeAgentSlots = renderedDiffSlotsForState(viewStates[inputCursor]);
  if (
    beforeAgentSlots.length !== 1 ||
    beforeAgentSlots[0].file !== "src/add.test.ts" ||
    !beforeAgentSlots[0].diff.includes("returns 8 for 3+5") ||
    !beforeAgentSlots[0].diff.includes("returns 42 for 27+15")
  ) {
    throw new Error("Cassette contract failed: more-examples must show only the user-added tests before agent work");
  }

  const afterAgentSlots = renderedDiffSlotsForState(viewStates[completeCursor]);
  if (
    afterAgentSlots.length !== 1 ||
    afterAgentSlots[0].file !== "src/add.test.ts" ||
    afterAgentSlots.some((slot) => slot.file === "src/add.ts")
  ) {
    throw new Error("Cassette contract failed: more-examples must keep the implementation diff hidden");
  }

  const actualDiffs = diffByFileForExchange(exchanges[exchangeIndex], viewStates[completeCursor].visibleCodeSteps);
  const hiddenAddDiff = actualDiffs.get("src/add.ts") ?? "";
  if (!hiddenAddDiff.includes("return 8") || !hiddenAddDiff.includes("return 42")) {
    throw new Error("Cassette contract failed: more-examples hidden implementation diff is missing");
  }
}

function validateSortExampleContract(): void {
  const exchangeIndex = exchanges.findIndex((exchange) => exchange.id === "sort-example");
  if (exchangeIndex < 0) {
    throw new Error("Cassette contract failed: sort-example exchange is missing");
  }

  const completeCursor = finalCompleteCursorByExchange.get(exchangeIndex);
  if (completeCursor === undefined) {
    throw new Error("Cassette contract failed: sort-example completion state is missing");
  }

  const renderedSlots = renderedDiffSlotsForState(viewStates[completeCursor]);
  if (!renderedSlots.some((slot) => slot.file === "src/sort.ts")) {
    throw new Error("Cassette contract failed: sort-example must render src/sort.ts");
  }

  if (!renderedSlots.some((slot) => slot.file === "src/sort.test.ts")) {
    throw new Error("Cassette contract failed: sort-example must render src/sort.test.ts");
  }

  const renderedDiff = renderedSlots.map((slot) => slot.diff).join("\n");
  if (
    !renderedDiff.includes("sortNumbers") ||
    !renderedDiff.includes("returns values in ascending order") ||
    renderedDiff.includes("does not change after sorting again")
  ) {
    throw new Error("Cassette contract failed: sort-example diff is missing sort implementation or tests");
  }
}

function validateQueryRoundtripContract(): void {
  const exchangeIndex = exchanges.findIndex((exchange) => exchange.id === "query-roundtrip");
  if (exchangeIndex < 0) {
    throw new Error("Cassette contract failed: query-roundtrip exchange is missing");
  }

  const completeCursor = finalCompleteCursorByExchange.get(exchangeIndex);
  if (completeCursor === undefined) {
    throw new Error("Cassette contract failed: query-roundtrip completion state is missing");
  }

  if (lawCardForState(viewStates[completeCursor])) {
    throw new Error("Cassette contract failed: query-roundtrip must be a code diff, not a banner");
  }

  const renderedSlots = renderedDiffSlotsForState(viewStates[completeCursor]);
  if (renderedSlots.some((slot) => slot.file === "src/query.ts")) {
    throw new Error("Cassette contract failed: query-roundtrip must hide src/query.ts");
  }

  if (renderedSlots.length !== 1 || renderedSlots[0].file !== "src/query.test.ts") {
    throw new Error("Cassette contract failed: query-roundtrip must render only src/query.test.ts");
  }

  const actualDiffs = diffByFileForExchange(exchanges[exchangeIndex], viewStates[completeCursor].visibleCodeSteps);
  if (!actualDiffs.has("src/query.ts")) {
    throw new Error("Cassette contract failed: query-roundtrip hidden source file is missing");
  }

  const renderedDiff = renderedSlots.map((slot) => slot.diff).join("\n");
  if (
    !renderedDiff.includes(".dictionary(fc.string(), fc.string())") ||
    !renderedDiff.includes("fc.property(queryParams, (params)") ||
    !renderedDiff.includes("parseQuery(buildQuery(params))")
  ) {
    throw new Error("Cassette contract failed: query-roundtrip diff is missing the round-trip property");
  }
}

function diffForExchange(exchange: Exchange, visibleSteps: number): string {
  const diffsByFile = diffByFileForExchange(exchange, visibleSteps);
  return [...diffsByFile]
    .map(([file, diff]) => `${file}\n${diff.trimEnd()}`)
    .join("\n\n");
}

function visibleDiffByFileForExchange(exchange: Exchange, visibleSteps: number): Map<string, string> {
  const hiddenFiles = new Set(exchange.hiddenDiffFiles ?? []);
  return new Map(
    [...diffByFileForExchange(exchange, visibleSteps)].filter(([file]) => !hiddenFiles.has(file))
  );
}

function diffByFileForExchange(exchange: Exchange, visibleSteps: number): Map<string, string> {
  const steps = exchangeCodeSteps(exchange).slice(0, visibleSteps);
  let from = exchange.codeFrom;
  const diffsByFile = new Map<string, string[]>();

  for (const to of steps) {
    for (const file of filesForCodeRange(from, to)) {
      const diff = diffForCodeFileRange(from, to, file);
      if (diff.trim().length > 0) {
        const existing = diffsByFile.get(file) ?? [];
        existing.push(diff.trimEnd());
        diffsByFile.set(file, existing);
      }
    }
    from = to;
  }

  return new Map([...diffsByFile].map(([file, diffs]) => [file, diffs.join("\n")]));
}

function filesForExchange(exchange: Exchange, visibleSteps: number): string[] {
  const steps = exchangeCodeSteps(exchange).slice(0, visibleSteps);
  let from = exchange.codeFrom;
  const files = new Set<string>();

  for (const to of steps) {
    for (const file of filesForCodeRange(from, to)) {
      files.add(file);
    }
    from = to;
  }

  return [...files];
}

function filesForCodeRange(from: number, to: number): string[] {
  return gitOutput(
    ["diff", "--name-only", `${codeRefs[from]}..${codeRefs[to]}`, "--", ...sourceFiles],
    workspaceDir
  )
    .split("\n")
    .filter((line) => line.length > 0);
}

function diffForCodeFileRange(from: number, to: number, file: string): string {
  return gitRawOutput(
    ["diff", "--no-ext-diff", "--unified=0", `${codeRefs[from]}..${codeRefs[to]}`, "--", file],
    workspaceDir
  );
}

function hasGroupedFileDiff(diff: string, file: string): boolean {
  const index = diff.indexOf(`${file}\n`);
  if (index < 0) {
    return false;
  }

  const rest = diff.slice(index + file.length + 1);
  return rest.includes(`diff --git a/${file} b/${file}`);
}

function isRenderableGitDiff(diff: string): boolean {
  return (
    diff.includes("diff --git ") &&
    diff.includes("\n--- ") &&
    diff.includes("\n+++ ") &&
    diff.includes("\n@@")
  );
}

function firstRenderableDiff(): string {
  for (const state of viewStates) {
    const rendered = renderedDiffSlotsForState(state)[0];
    if (rendered) {
      return rendered.diff;
    }
  }

  throw new Error("Cassette contract failed: no renderable diffs exist");
}

function moveCode(code: number): boolean {
  if (codeMoveBlocked || isWorkspaceDirty()) {
    health = {
      kind: "dirty",
      detail: "workspace is dirty or diverged; press r to rebuild the isolated sandbox"
    };
    codeMoveBlocked = true;
    return false;
  }

  switchCodeTo(code, { allowForce: true });
  health = { kind: "ok", detail: `workspace moved to ${codeRefs[code]}` };
  return true;
}

function switchCodeTo(code: number, options: { allowForce: boolean }): void {
  const args = options.allowForce
    ? ["switch", "-f", "-C", "scenario/live", codeRefs[code]]
    : ["switch", "-C", "scenario/live", codeRefs[code]];
  git(args, workspaceDir);
}

function stopTyping(): void {
  if (typingTimer) {
    clearInterval(typingTimer);
    typingTimer = undefined;
  }
}

function readState(): PersistedState | undefined {
  return readJson<PersistedState>(stateFile);
}

function saveState(state: PersistedState): void {
  writeJson(stateFile, state);
}

function clampState(state: PersistedState | undefined): PersistedState {
  return {
    cursor: clampCursor(state?.cursor ?? 0),
    updatedAt: state?.updatedAt ?? new Date().toISOString()
  };
}

function clampCursor(value: number): number {
  if (!Number.isInteger(value)) {
    return 0;
  }
  return Math.max(0, Math.min(viewStates.length - 1, value));
}

function isWorkspaceDirty(): boolean {
  if (!existsSync(path.join(workspaceDir, ".git"))) {
    return false;
  }
  return gitOutput(["status", "--porcelain"], workspaceDir).length > 0;
}

function refCommit(ref: string): string {
  return gitOutput(["rev-parse", ref], workspaceDir);
}

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    const output = `${result.stderr}\n${result.stdout}`.trim();
    throw new Error(`git ${args.join(" ")} failed${output ? `\n${output}` : ""}`);
  }
}

function gitSucceeds(args: string[], cwd: string): boolean {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });
  return result.status === 0;
}

function gitOutput(args: string[], cwd: string): string {
  return gitRawOutput(args, cwd).trimEnd();
}

function gitRawOutput(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    const output = `${result.stderr}\n${result.stdout}`.trim();
    throw new Error(`git ${args.join(" ")} failed${output ? `\n${output}` : ""}`);
  }

  return result.stdout;
}

function readJson<T>(file: string): T | undefined {
  try {
    if (!existsSync(file)) {
      return undefined;
    }
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function restoreTerminalAfterError(): void {
  stopTyping();
  releaseLock();
}

function shutdown(code: number): never {
  stopTyping();
  releaseLock();
  process.exit(code);
}

main();
