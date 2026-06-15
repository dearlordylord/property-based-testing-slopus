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

const sourceFiles = ["src/add.ts", "src/add.test.ts"];

const twoPlusTwoTestSource = `import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { add } from "./add.js";

describe("add", () => {
  it("returns 4 for 2+2", () => {
    assert.equal(add(2, 2), 4);
  });
});
`;

const twoExamplesTestSource = `import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { add } from "./add.js";

describe("add", () => {
  it("returns 4 for 2+2", () => {
    assert.equal(add(2, 2), 4);
  });

  it("returns 3 for 1+2", () => {
    assert.equal(add(1, 2), 3);
  });
});
`;

const commutativeTestSource = `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { add } from "./add.js";

describe("add", () => {
  it("returns 4 for 2+2", () => {
    assert.equal(add(2, 2), 4);
  });

  it("returns 3 for 1+2", () => {
    assert.equal(add(1, 2), 3);
  });

  it("is commutative", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        assert.equal(add(a, b), add(b, a));
      }),
      { examples: [[1, 2]] }
    );
  });
});
`;

const doublingByOneTestSource = `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { add } from "./add.js";

describe("add", () => {
  it("returns 4 for 2+2", () => {
    assert.equal(add(2, 2), 4);
  });

  it("returns 3 for 1+2", () => {
    assert.equal(add(1, 2), 3);
  });

  it("is commutative", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        assert.equal(add(a, b), add(b, a));
      }),
      { examples: [[1, 2]] }
    );
  });

  it("adding 1 twice equals adding 2 once", () => {
    fc.assert(
      fc.property(fc.integer(), (x) => {
        assert.equal(add(1, add(1, x)), add(2, x));
      })
    );
  });
});
`;

const zeroIdentityTestSource = `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { add } from "./add.js";

describe("add", () => {
  it("returns 4 for 2+2", () => {
    assert.equal(add(2, 2), 4);
  });

  it("returns 3 for 1+2", () => {
    assert.equal(add(1, 2), 3);
  });

  it("is commutative", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        assert.equal(add(a, b), add(b, a));
      }),
      { examples: [[1, 2]] }
    );
  });

  it("adding 1 twice equals adding 2 once", () => {
    fc.assert(
      fc.property(fc.integer(), (x) => {
        assert.equal(add(1, add(1, x)), add(2, x));
      })
    );
  });

  it("has zero as identity on the right", () => {
    fc.assert(
      fc.property(fc.integer(), (x) => {
        assert.equal(add(x, 0), x);
      })
    );
  });
});
`;

const associativeTestSource = `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { add } from "./add.js";

describe("add", () => {
  it("returns 4 for 2+2", () => {
    assert.equal(add(2, 2), 4);
  });

  it("returns 3 for 1+2", () => {
    assert.equal(add(1, 2), 3);
  });

  it("is commutative", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        assert.equal(add(a, b), add(b, a));
      }),
      { examples: [[1, 2]] }
    );
  });

  it("adding 1 twice equals adding 2 once", () => {
    fc.assert(
      fc.property(fc.integer(), (x) => {
        assert.equal(add(1, add(1, x)), add(2, x));
      })
    );
  });

  it("has zero as identity on the right", () => {
    fc.assert(
      fc.property(fc.integer(), (x) => {
        assert.equal(add(x, 0), x);
      })
    );
  });

  it("is associative", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), fc.integer(), (x, y, z) => {
        assert.equal(add(x, add(y, z)), add(add(x, y), z));
      })
    );
  });
});
`;

const propertyOnlyTestSource = `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { add } from "./add.js";

describe("add", () => {
  it("is commutative", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        assert.equal(add(a, b), add(b, a));
      }),
      { examples: [[1, 2]] }
    );
  });

  it("adding 1 twice equals adding 2 once", () => {
    fc.assert(
      fc.property(fc.integer(), (x) => {
        assert.equal(add(1, add(1, x)), add(2, x));
      })
    );
  });

  it("has zero as identity on the right", () => {
    fc.assert(
      fc.property(fc.integer(), (x) => {
        assert.equal(add(x, 0), x);
      })
    );
  });

  it("is associative", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), fc.integer(), (x, y, z) => {
        assert.equal(add(x, add(y, z)), add(add(x, y), z));
      })
    );
  });
});
`;

const returnFourAddSource = `export function add(a: number, b: number): number {
  return 4;
}

export default add;
`;

const twoExamplesAddSource = `export function add(a: number, b: number): number {
  if (a === 1 && b === 2) {
    return 3;
  }

  return 4;
}

export default add;
`;

const commutativePatchAddSource = `export function add(a: number, b: number): number {
  if (a !== b) {
    return 3;
  }

  return 4;
}

export default add;
`;

const zeroEndpointAddSource = `export function add(a: number, b: number): number {
  if (b === 0) {
    return a;
  }

  if (a === 0) {
    return b;
  }

  if (a === 1) {
    return b === 2 || b === 4 ? 3 : 4;
  }
  if (b === 1) {
    return a === 2 || a === 4 ? 3 : 4;
  }
  if (a === 2) {
    return b === 2 || b === 4 ? 4 : 3;
  }
  if (b === 2) {
    return a === 2 || a === 4 ? 4 : 3;
  }
  if (a === 1 && b === 1) {
    return 4;
  }
  return 3;
}

export default add;
`;

const zeroAndOneOneAddSource = `export function add(a: number, b: number): number {
  if (b === 0) {
    return a;
  }

  if (a === 0) {
    return b;
  }

  if (a === 1 && b === 1) {
    return 2;
  }

  if (a === 1) {
    return b === 2 || b === 4 ? 3 : 4;
  }
  if (b === 1) {
    return a === 2 || a === 4 ? 3 : 4;
  }
  if (a === 2) {
    return b === 2 || b === 4 ? 4 : 3;
  }
  if (b === 2) {
    return a === 2 || a === 4 ? 4 : 3;
  }
  return 3;
}

export default add;
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
    id: "two-plus-two-test",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.test.ts": twoPlusTwoTestSource,
    },
    commitMessage: "User adds test for add(2, 2)",
  },
  {
    id: "two-plus-two-implementation",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": returnFourAddSource,
      "src/add.test.ts": twoPlusTwoTestSource,
    },
    commitMessage: "Agent returns 4 for add(2, 2)",
  },
  {
    id: "one-plus-two-test",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": returnFourAddSource,
      "src/add.test.ts": twoExamplesTestSource,
    },
    commitMessage: "User adds test for add(1, 2)",
  },
  {
    id: "one-plus-two-implementation",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": twoExamplesAddSource,
      "src/add.test.ts": twoExamplesTestSource,
    },
    commitMessage: "Agent handles add(1, 2)",
  },
  {
    id: "commutative-test",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": twoExamplesAddSource,
      "src/add.test.ts": commutativeTestSource,
    },
    commitMessage: "User adds commutativity property",
  },
  {
    id: "commutative-implementation",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": commutativePatchAddSource,
      "src/add.test.ts": commutativeTestSource,
    },
    commitMessage: "Agent handles commutativity",
  },
  {
    id: "doubling-by-one-test",
    sourceRef: "08e2cfe",
    fileContents: {
      "src/add.ts": commutativePatchAddSource,
      "src/add.test.ts": doublingByOneTestSource,
    },
    commitMessage: "User adds add-one-twice property",
  },
  {
    id: "doubling-by-one-implementation",
    sourceRef: "93421d1",
    fileContents: {
      "src/add.test.ts": doublingByOneTestSource,
    },
    commitMessage: "Agent handles add-one-twice property",
  },
  {
    id: "zero-identity-test",
    sourceRef: "93421d1",
    fileContents: {
      "src/add.test.ts": zeroIdentityTestSource,
    },
    commitMessage: "User adds right-identity property",
  },
  {
    id: "zero-identity-implementation",
    sourceRef: "93421d1",
    fileContents: {
      "src/add.ts": zeroEndpointAddSource,
      "src/add.test.ts": zeroIdentityTestSource,
    },
    commitMessage: "Agent handles zero counterexample",
  },
  {
    id: "zero-identity-add-one-one",
    sourceRef: "93421d1",
    fileContents: {
      "src/add.ts": zeroAndOneOneAddSource,
      "src/add.test.ts": zeroIdentityTestSource,
    },
    commitMessage: "Agent repairs add-one-twice fallout",
  },
  {
    id: "associative-test",
    sourceRef: "93421d1",
    fileContents: {
      "src/add.ts": zeroAndOneOneAddSource,
      "src/add.test.ts": associativeTestSource,
    },
    commitMessage: "User adds associativity property",
  },
  {
    id: "associative-implementation",
    sourceRef: "85a8a9d",
    fileContents: {
      "src/add.test.ts": associativeTestSource,
    },
    commitMessage: "Agent switches to real addition",
  },
  {
    id: "property-only-tests",
    sourceRef: "85a8a9d",
    fileContents: {
      "src/add.test.ts": propertyOnlyTestSource,
    },
    commitMessage: "User removes example tests",
  },
  {
    id: "warped-addition",
    sourceRef: "HEAD",
    fileContents: {
      "src/add.test.ts": propertyOnlyTestSource,
    },
    commitMessage: "Agent adds warped algebraic implementation",
  },
];

const codeRefs = codeStates.map(
  (state, index) => `scenario/step-${String(index).padStart(2, "0")}-${state.id}`
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
    id: "two-plus-two",
    user: "The test now checks that add(2, 2) returns 4. Make it pass.",
    assistant: "Absolutely, I made it pass. Since the expected result is 4, the function now returns 4.",
    codeFrom: 1,
    codeTo: 3,
    preAgentCodeSteps: [2],
    codeSteps: [3],
  },
  {
    id: "one-plus-two",
    user: "The test now also checks that add(1, 2) returns 3. Make it pass.",
    assistant: "You absolutely right, I added the exact case for that input. If it sees 1 and 2, it returns 3; otherwise it keeps returning 4.",
    codeFrom: 3,
    codeTo: 5,
    preAgentCodeSteps: [4],
    codeSteps: [5],
  },
  {
    id: "commutative",
    user: "The test now checks commutativity. Make it pass.",
    assistant: "Absolutely, I made unequal inputs agree in either order. Equal inputs still keep the old answer.",
    codeFrom: 5,
    codeTo: 7,
    preAgentCodeSteps: [6],
    codeSteps: [7],
    lawCard: {
      title: "Commutativity",
      formula: "X + Y = Y + X",
      art: [
        "┌───┐     ┌───┐        ┌───┐     ┌───┐",
        "│ X │  +  │ Y │   =    │ Y │  +  │ X │",
        "└───┘     └───┘        └───┘     └───┘",
      ],
    },
  },
  {
    id: "doubling-by-one",
    user: "The test now checks that adding one twice behaves like adding two once. Make it pass.",
    assistant: "Absolutely, I added the smallest friendly shortcut for that shape. The function now recognizes the extra cases the property asks for.",
    codeFrom: 7,
    codeTo: 9,
    preAgentCodeSteps: [8],
    codeSteps: [9],
    lawCard: {
      title: "One twice is two",
      formula: "1 + (1 + X) = 2 + X",
      art: [
        "┌───┐   ┌───┐   ┌───┐      ┌───┐   ┌───┐",
        "│ 1 │ + │ 1 │ + │ X │  =   │ 2 │ + │ X │",
        "└───┘   └───┘   └───┘      └───┘   └───┘",
      ],
    },
  },
  {
    id: "zero-identity",
    user: "The test now checks that zero is a right identity. Make it pass.",
    assistant: "Absolutely. The property found x = 0 first, so I handled zero on either side. Then the older add-one-twice property found x = 0 too, so I patched add(1, 1) to keep that chain happy.",
    codeFrom: 9,
    codeTo: 12,
    preAgentCodeSteps: [10],
    codeSteps: [11, 12],
    lawCard: {
      title: "Right identity",
      formula: "X + 0 = X",
      art: [
        "┌───┐     ┌───┐        ┌───┐",
        "│ X │  +  │ 0 │   =    │ X │",
        "└───┘     └───┘        └───┘",
      ],
    },
  },
  {
    id: "associative",
    user: "The test now checks associativity. Make it pass.",
    assistant: "Absolutely, I made the implementation use real numeric addition. That satisfies the earlier cases and the associativity property.",
    codeFrom: 12,
    codeTo: 14,
    preAgentCodeSteps: [13],
    codeSteps: [14],
    lawCard: {
      title: "Associativity",
      formula: "(X + Y) + Z = X + (Y + Z)",
      art: [
        "┌─────────┐     ┌───┐        ┌───┐     ┌─────────┐",
        "│ X  +  Y │  +  │ Z │   =    │ X │  +  │ Y  +  Z │",
        "└─────────┘     └───┘        └───┘     └─────────┘",
      ],
    },
  },
  {
    id: "property-only",
    user: "I removed the example tests; the suite is property-only now.",
    assistant: "Understood. No implementation change is needed for that step; the code already passes the property-only suite.",
    codeFrom: 14,
    codeTo: 15,
    preAgentCodeSteps: [15],
    codeSteps: [],
  },
  {
    id: "warped-addition",
    user: "Can you make the implementation weird but still algebraically valid under the properties? It should satisfy the laws, but add(500, 500) should not be 1000.",
    assistant: "Absolutely. I wrapped addition in a tiny isomorphism: map values through a swap, add there, then map back. The properties still hold, but add(500, 500) lands on 1001.",
    codeFrom: 15,
    codeTo: 16,
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
          test: "tsx --test src/add.test.ts"
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
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, codeStates[index].fileContents?.[file] ?? readSourceFileAtRef(fileRef, file));
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
        height: 7,
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
      const section = new BoxRenderable(renderer, {
        id: `diff-section-live-${index}`,
        width: "100%",
        ...(isTestFile ? { height: 8 } : { flexGrow: 1 }),
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
    blocks.push(formatMessage("USER", exchanges[i].user));
    blocks.push(formatMessage("AGENT", exchanges[i].assistant));
  }

  const current = exchanges[state.exchange];
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
  return diffByFileForExchange(exchange, state.visibleCodeSteps);
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
    { id: "one-plus-two", requiresAgentImplementation: true },
    { id: "two-plus-two", requiresAgentImplementation: true },
    { id: "commutative", requiresAgentImplementation: true },
    { id: "doubling-by-one", requiresAgentImplementation: true },
    { id: "zero-identity", requiresAgentImplementation: true },
    { id: "associative", requiresAgentImplementation: true },
    { id: "property-only", requiresAgentImplementation: false },
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

    if (contract.requiresAgentImplementation && !appendedSlots.some((slot) => slot.file === "src/add.ts")) {
      throw new Error("Exchange " + contract.id + " must append an implementation diff after the assistant response.");
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
  for (const file of sourceFiles) {
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
    const inputCursor = inputCursorByExchange.get(exchangeIndex);
    if (inputCursor === undefined || viewStates[inputCursor + 1]?.phase !== "user") {
      throw new Error(
        `Cassette contract failed: exchange ${exchangeIndex} prompt typing does not auto-submit to transcript`
      );
    }
  }

  validateOnePlusTwoSplitContract();
  validateUserOwnedTestContracts();
  validateLawCardContract();

  for (const [exchangeIndex, completeCursor] of finalCompleteCursorByExchange.entries()) {
    if (exchangeIndex >= exchanges.length - 1) {
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

    if (state.visibleCodeSteps > 0 && renderedSlots.length === 0) {
      throw new Error(`Cassette contract failed: ${state.id} would render no diff widgets`);
    }

    for (const { file, diff } of renderedSlots) {
      if (!isRenderableGitDiff(diff)) {
        throw new Error(`Cassette contract failed: ${state.id} would render an invalid diff for ${file}`);
      }
    }
  }
}

function validateLawCardContract(): void {
  const expectedCards = [
    { id: "commutative", formula: "X + Y = Y + X" },
    { id: "doubling-by-one", formula: "1 + (1 + X) = 2 + X" },
    { id: "zero-identity", formula: "X + 0 = X" },
    { id: "associative", formula: "(X + Y) + Z = X + (Y + Z)" },
  ];

  for (const expected of expectedCards) {
    const exchangeIndex = exchanges.findIndex((exchange) => exchange.id === expected.id);
    if (exchangeIndex < 0) {
      throw new Error(`Cassette contract failed: ${expected.id} exchange is missing`);
    }

    const inputCursor = inputCursorByExchange.get(exchangeIndex);
    if (inputCursor === undefined) {
      throw new Error(`Cassette contract failed: ${expected.id} input cursor is missing`);
    }

    const card = lawCardForState(viewStates[inputCursor]);
    if (!card || card.formula !== expected.formula || card.art.length === 0) {
      throw new Error(`Cassette contract failed: ${expected.id} law card is missing or incomplete`);
    }
  }
}

function validateOnePlusTwoSplitContract(): void {
  const exchangeIndex = exchanges.findIndex((exchange) => exchange.id === "one-plus-two");
  if (exchangeIndex < 0) {
    throw new Error("Cassette contract failed: one-plus-two exchange is missing");
  }

  const inputCursor = inputCursorByExchange.get(exchangeIndex);
  const completeCursor = finalCompleteCursorByExchange.get(exchangeIndex);
  if (inputCursor === undefined || completeCursor === undefined) {
    throw new Error("Cassette contract failed: one-plus-two cursors are missing");
  }

  const beforeAgentSlots = renderedDiffSlotsForState(viewStates[inputCursor]);
  if (
    beforeAgentSlots.length !== 1 ||
    beforeAgentSlots[0].file !== "src/add.test.ts" ||
    !beforeAgentSlots[0].diff.includes("returns 3 for 1+2")
  ) {
    throw new Error("Cassette contract failed: one-plus-two must show only the user-added test before agent work");
  }

  const afterAgentSlots = renderedDiffSlotsForState(viewStates[completeCursor]);
  if (
    afterAgentSlots.length !== 2 ||
    afterAgentSlots[0].file !== "src/add.test.ts" ||
    afterAgentSlots[1].file !== "src/add.ts" ||
    !afterAgentSlots[1].diff.includes("return 3")
  ) {
    throw new Error(
      "Cassette contract failed: one-plus-two must append the implementation diff after the test diff"
    );
  }
}

function diffForExchange(exchange: Exchange, visibleSteps: number): string {
  const diffsByFile = diffByFileForExchange(exchange, visibleSteps);
  return [...diffsByFile]
    .map(([file, diff]) => `${file}\n${diff.trimEnd()}`)
    .join("\n\n");
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
