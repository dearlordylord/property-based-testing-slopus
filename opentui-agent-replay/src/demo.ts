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
const sandboxDir = path.join(projectDir, "sandbox");
const workspaceDir = path.join(sandboxDir, "workspace");
const stateFile = path.join(sandboxDir, "state.json");
const lockFile = path.join(sandboxDir, "session.lock.json");
const ownerFile = path.join(sandboxDir, ".owned-by-opentui-agent-replay");

const codeRefs = [
  "scenario/step-00-base",
  "scenario/step-01-agent-tests",
  "scenario/step-02-agent-fix"
];

const exchanges: Exchange[] = [
  {
    id: "add-property-tests",
    user:
      "Add property-style tests around the discount helper. The valid discount percent range is 0 through 100.",
    assistant:
      "I am going to add the discount helper and cover the domain with generated boundary-like cases. The first pass will assert that valid percentages keep the price between zero and the original price, and that invalid percentages throw. That gives the talk a clean failing edge: values above 100 should be rejected before the calculation runs.",
    codeFrom: 0,
    codeTo: 1
  },
  {
    id: "fix-upper-bound",
    user:
      "The test catches 101 percent. Fix the implementation without loosening the property.",
    assistant:
      "The failure is the missing upper-bound guard. I will keep the property as the contract and update the helper so any non-integer, negative, or greater-than-100 percentage is rejected before returning the rounded discounted price.",
    codeFrom: 1,
    codeTo: 2
  }
];

const viewStates: ViewState[] = [
  { id: "e0-input-empty", exchange: 0, phase: "input-empty", code: 0 },
  { id: "e0-input-typing", exchange: 0, phase: "input-typing", code: 0 },
  { id: "e0-input", exchange: 0, phase: "input", code: 0 },
  { id: "e0-user", exchange: 0, phase: "user", code: 0 },
  { id: "e0-typing", exchange: 0, phase: "typing", code: 0 },
  { id: "e0-complete", exchange: 0, phase: "complete", code: 1 },
  { id: "e1-input-empty", exchange: 1, phase: "input-empty", code: 1 },
  { id: "e1-input-typing", exchange: 1, phase: "input-typing", code: 1 },
  { id: "e1-input", exchange: 1, phase: "input", code: 1 },
  { id: "e1-user", exchange: 1, phase: "user", code: 1 },
  { id: "e1-typing", exchange: 1, phase: "typing", code: 1 },
  { id: "e1-complete", exchange: 1, phase: "complete", code: 2 }
];

const completeCursorByExchange = new Map<number, number>([
  [0, 5],
  [1, 11]
]);

const inputCursorByExchange = new Map<number, number>([
  [0, 2],
  [1, 8]
]);

const inputStartCursorByExchange = new Map<number, number>([
  [0, 0],
  [1, 6]
]);

const recoveryCursorByCode = new Map<number, number>([
  [0, 0],
  [1, 5],
  [2, 11]
]);

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

  writeSnapshot(0);
  git(["add", "."], workspaceDir);
  git(["commit", "-m", "scenario: base"], workspaceDir);
  git(["branch", "-f", codeRefs[0]], workspaceDir);

  writeSnapshot(1);
  git(["add", "."], workspaceDir);
  git(["commit", "-m", "scenario: add property tests"], workspaceDir);
  git(["branch", "-f", codeRefs[1]], workspaceDir);

  writeSnapshot(2);
  git(["add", "."], workspaceDir);
  git(["commit", "-m", "scenario: fix discount upper bound"], workspaceDir);
  git(["branch", "-f", codeRefs[2]], workspaceDir);

  switchCodeTo(0, { allowForce: true });
  saveState({ cursor: 0, updatedAt: new Date().toISOString() });
}

function ensureSandboxExists(): void {
  if (!existsSync(workspaceDir) || !existsSync(ownerFile)) {
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
  rmSync(path.join(workspaceDir, "test"), { recursive: true, force: true });
  mkdirSync(path.join(workspaceDir, "src"), { recursive: true });

  writeFileSync(
    path.join(workspaceDir, "package.json"),
    `${JSON.stringify(
      {
        name: "discount-demo-workspace",
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: {
          test: "vitest run"
        },
        devDependencies: {
          vitest: "^3.2.4"
        }
      },
      null,
      2
    )}\n`
  );

  if (index === 0) {
    writeFileSync(
      path.join(workspaceDir, "src", "discount.ts"),
      `export function applyDiscount(priceCents: number, percent: number): number {
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new RangeError("priceCents must be a non-negative integer");
  }
  if (!Number.isInteger(percent) || percent < 0) {
    throw new RangeError("percent must be an integer from 0 through 100");
  }

  return Math.round(priceCents * (1 - percent / 100));
}
`
    );
    return;
  }

  mkdirSync(path.join(workspaceDir, "test"), { recursive: true });
  writeFileSync(
    path.join(workspaceDir, "test", "discount.property.test.ts"),
    `import { describe, expect, it } from "vitest";
import { applyDiscount } from "../src/discount";

describe("applyDiscount", () => {
  it("valid discounts keep prices between zero and the original price", () => {
    for (let priceCents = 0; priceCents <= 25_000; priceCents += 137) {
      for (let percent = 0; percent <= 100; percent += 1) {
        const result = applyDiscount(priceCents, percent);

        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(priceCents);
      }
    }
  });

  it("zero percent returns the original price", () => {
    for (let priceCents = 0; priceCents <= 25_000; priceCents += 331) {
      expect(applyDiscount(priceCents, 0)).toBe(priceCents);
    }
  });

  it("rejects percentages outside the accepted domain", () => {
    for (const percent of [-10, -1, 101, 150]) {
      expect(() => applyDiscount(5_000, percent)).toThrow(RangeError);
    }
  });
});
`
  );

  const percentGuard =
    index === 1
      ? "!Number.isInteger(percent) || percent < 0"
      : "!Number.isInteger(percent) || percent < 0 || percent > 100";

  writeFileSync(
    path.join(workspaceDir, "src", "discount.ts"),
    `export function applyDiscount(priceCents: number, percent: number): number {
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new RangeError("priceCents must be a non-negative integer");
  }
  if (${percentGuard}) {
    throw new RangeError("percent must be an integer from 0 through 100");
  }

  return Math.round(priceCents * (1 - percent / 100));
}
`
  );
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
