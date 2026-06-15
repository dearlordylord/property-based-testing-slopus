import {
  BoxRenderable,
  DiffRenderable,
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

type Exchange = {
  id: string;
  user: string;
  assistant: string;
  codeFrom: number;
  codeTo: number;
};

type CodeState = {
  id: string;
  sourceRef: string;
  commitMessage: string;
};

type ViewState = {
  id: string;
  exchange: number;
  phase: Phase;
  code: number;
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

const codeStates: CodeState[] = [
  {
    id: "throw-only",
    sourceRef: "08e2cfe",
    commitMessage: "scenario: add throws and the test expects it"
  },
  {
    id: "one-plus-two",
    sourceRef: "5433a31",
    commitMessage: "scenario: satisfy one example with return 3"
  },
  {
    id: "two-plus-two",
    sourceRef: "44790fd",
    commitMessage: "scenario: satisfy two examples with special cases"
  },
  {
    id: "commutative",
    sourceRef: "d774c08",
    commitMessage: "scenario: add commutativity property"
  },
  {
    id: "doubling-by-one",
    sourceRef: "93421d1",
    commitMessage: "scenario: add one-plus-one law"
  },
  {
    id: "zero-identity",
    sourceRef: "6aa5f2b",
    commitMessage: "scenario: add zero identity"
  },
  {
    id: "associative",
    sourceRef: "85a8a9d",
    commitMessage: "scenario: add associativity"
  },
  {
    id: "property-only",
    sourceRef: "ea923e5",
    commitMessage: "scenario: remove explicit examples"
  },
  {
    id: "warped-addition",
    sourceRef: "HEAD",
    commitMessage: "scenario: satisfy laws with warped addition"
  }
];

const codeRefs = codeStates.map(
  (state, index) => `scenario/step-${String(index).padStart(2, "0")}-${state.id}`
);

const exchanges: Exchange[] = [
  {
    id: "one-plus-two",
    user: "Stay adversarial. Add a test that add(1, 2) returns 3, then make it pass.",
    assistant:
      "The cheapest implementation is not addition. The suite only observes one point, so I can remove the throw behavior and return 3 for every call. That makes the new example green while preserving almost no useful semantics.",
    codeFrom: 0,
    codeTo: 1
  },
  {
    id: "two-plus-two",
    user:
      "Still adversarial. Keep the previous test, add add(2, 2) === 4, and make everything pass.",
    assistant:
      "Two examples still only form a tiny lookup table. I can add the smallest branch that returns 4 for equal arguments and keep returning 3 everywhere else. The implementation is lazy, but the current examples cannot distinguish it from real addition.",
    codeFrom: 1,
    codeTo: 2
  },
  {
    id: "commutative",
    user:
      "Add a fast-check property: add(x, y) must equal add(y, x). Stay adversarial in the implementation.",
    assistant:
      "Commutativity is the first real pressure. I do not need real addition yet; I only need symmetry. The existing special cases are already symmetric enough, so the property turns many input pairs into checks without forcing the actual numeric meaning of addition.",
    codeFrom: 2,
    codeTo: 3
  },
  {
    id: "doubling-by-one",
    user:
      "Add the law add(1, add(1, x)) === add(2, x), and keep the adversarial implementation passing.",
    assistant:
      "This law forces behavior across generated x values, but I can still satisfy the equation by making calls involving 1 and 2 collapse through matching branches. For example with x = 6, both sides reduce through the same fake values, so the property passes while the function is still not addition.",
    codeFrom: 3,
    codeTo: 4
  },
  {
    id: "zero-identity",
    user: "Add identity: add(x, 0) === x. Keep all previous properties passing.",
    assistant:
      "Identity reaches every generated x, so the table hack has to grow into a partial algebra. I will preserve x whenever either side is zero, keep the hand-built behavior for 1 and 2, and still return a fake value outside the pressure points.",
    codeFrom: 4,
    codeTo: 5
  },
  {
    id: "associative",
    user:
      "Add associativity: add(x, add(y, z)) === add(add(x, y), z). Keep the suite green.",
    assistant:
      "Associativity composes the operation with itself, which makes the previous fake algebra hard to maintain. The cheapest passing implementation is now to use JavaScript arithmetic without spelling it as a plus expression: a - -b.",
    codeFrom: 5,
    codeTo: 6
  },
  {
    id: "remove-examples",
    user: "Now remove the explicit example-based tests and commit the property-only suite.",
    assistant:
      "The examples have done their teaching job. The remaining suite is property-only: commutativity, zero identity, associativity, and the one-plus-one law. It still passes with the current implementation, so the cassette can show the shift from point checks to laws.",
    codeFrom: 6,
    codeTo: 7
  },
  {
    id: "warped-addition",
    user:
      "Without adding an oracle or constraining the input domain, make the algebraic laws pass with a weird implementation where add(500, 500) is not 1000.",
    assistant:
      "I can keep the algebraic structure and still change the representation. The new operation warps the numbers 1000 and 1001, performs normal addition in warped coordinates, then warps the result back. The laws still hold globally, but add(500, 500) now returns 1001. This is why laws are powerful pressure, not a complete oracle for intended meaning.",
    codeFrom: 7,
    codeTo: 8
  }
];

const phases: Phase[] = ["input-empty", "input-typing", "input", "user", "typing", "complete"];

const viewStates: ViewState[] = exchanges.flatMap((exchange, exchangeIndex) =>
  phases.map((phase) => ({
    id: `e${exchangeIndex}-${phase}`,
    exchange: exchangeIndex,
    phase,
    code: phase === "complete" ? exchange.codeTo : exchange.codeFrom
  }))
);

const completeCursorByExchange = new Map<number, number>(
  exchanges.map((_, index) => [index, index * phases.length + 5])
);

const inputCursorByExchange = new Map<number, number>(
  exchanges.map((_, index) => [index, index * phases.length + 2])
);

const inputStartCursorByExchange = new Map<number, number>(
  exchanges.map((_, index) => [index, index * phases.length])
);

const recoveryCursorByCode = new Map<number, number>(
  codeStates.map((_, code) => [code, code === 0 ? 0 : code * phases.length - 1])
);

let cursor = 0;
let health: Health = { kind: "ok", detail: "ready" };
let typingChars = 0;
let typingTimer: ReturnType<typeof setInterval> | undefined;
let codeMoveBlocked = false;

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
  if (
    !existsSync(workspaceDir) ||
    !existsSync(ownerFile) ||
    !existsSync(path.join(workspaceDir, ".git")) ||
    codeRefs.some((ref) => !gitSucceeds(["rev-parse", "--verify", ref], workspaceDir))
  ) {
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

  for (const file of sourceFiles) {
    const target = path.join(workspaceDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readSourceFileAtRef(codeStates[index].sourceRef, file));
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

  const transcriptText = new TextRenderable(renderer, {
    id: "transcript",
    width: "100%",
    height: "100%",
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
    flexGrow: 1,
    height: "100%",
    padding: 1
  });

  const diffView = new DiffRenderable(renderer, {
    id: "diff",
    width: "100%",
    height: "100%",
    diff: "",
    view: "unified",
    filetype: "typescript",
    wrapMode: "none",
    showLineNumbers: true
  });

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

  transcriptPanel.add(transcriptText);
  diffPanel.add(diffView);
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
    diffView.diff = buildDiff(state);
    renderer.requestRender();
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
    cursor = inputCursor;
    typingChars = exchanges[state.exchange].user.length;
    saveState({ cursor, updatedAt: new Date().toISOString() });
    render();
  };

  const completeAgentTyping = (): void => {
    const state = viewStates[cursor];
    if (state.phase !== "typing") {
      return;
    }

    const completeCursor = completeCursorByExchange.get(state.exchange);
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
        const previousComplete = completeCursorByExchange.get(state.exchange - 1);
        if (previousComplete !== undefined) {
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
  const healthText = `${health.kind}: ${health.detail}`;
  return [
    "OpenTUI cached agent replay",
    `left/right: step  r: rebuild sandbox  q: quit  phase: ${phase}  code: ${codeRef}  ${healthText}`
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

  return blocks.length > 0
    ? blocks.join("\n\n")
    : "No sent messages yet.";
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
  return `${role}\n${text}`;
}

function buildDiff(state: ViewState): string {
  if (state.phase !== "complete") {
    const exchange = exchanges[state.exchange];
    return diffForCodeRange(exchange.codeFrom, exchange.codeTo);
  }

  const exchange = exchanges[state.exchange];
  return diffForCodeRange(exchange.codeFrom, exchange.codeTo);
}

async function validateUi(): Promise<void> {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const container = new BoxRenderable(setup.renderer, {
    width: "100%",
    height: "100%"
  });
  const diffView = new DiffRenderable(setup.renderer, {
    width: "100%",
    height: "100%",
    diff: "",
    view: "unified",
    wrapMode: "none",
    showLineNumbers: true
  });

  try {
    container.add(diffView);
    setup.renderer.root.add(container);

    for (const state of viewStates) {
      diffView.diff = buildDiff(state);
      await setup.renderOnce();
      await setup.flush();

      const frame = setup.captureCharFrame();
      if (frame.includes("Error parsing diff")) {
        throw new Error(`OpenTUI diff failed to render for state ${state.id}`);
      }
    }

    await setup.waitForVisualIdle();
    console.log(`Validated ${viewStates.length} OpenTUI states.`);
  } finally {
    setup.renderer.destroy();
  }
}

function diffForCodeRange(from: number, to: number): string {
  return gitRawOutput(["diff", "--no-ext-diff", `${codeRefs[from]}..${codeRefs[to]}`], workspaceDir);
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
