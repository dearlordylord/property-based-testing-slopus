# Agent Scenario Replay

Deterministic OpenTUI replay for a tech talk where the audience sees an
agent-like coding session without depending on a live LLM run.

The current implementation is the OpenTUI flow in `opentui-agent-replay/`.
The older patch-application replay runner has been removed from the public
npm scripts because it is not the presentation path anymore.

## Run

```sh
npm install
npm run demo
```

`npm run demo` validates every OpenTUI state, then launches the TUI.

Useful commands:

```sh
npm run tui
npm run tui:prepare
npm run tui:status
npm run tui:validate
npm run check
```

## Controls

- `Right`: advance the scenario
- `Left`: roll back the scenario
- `Right` during prepared prompt typing: skip to the full prompt
- `Right` during agent typing: skip to the completed agent stream and code state
- `r`: rebuild the isolated sandbox
- `q`: quit

## Sandbox

The code shown in your IDE lives here:

```text
opentui-agent-replay/sandbox/workspace
```

That directory is generated. Open this sandbox in your IDE during the talk,
not the repository root.

The sandbox is a git repository with immutable scenario refs and one movable
live branch:

```text
scenario/step-00-base
scenario/step-01-agent-tests
scenario/step-02-agent-fix
scenario/live
```

Arrow navigation moves `scenario/live` between the prewritten refs. It does
not apply patches to this repository.

## Safety

The TUI persists its cursor in `opentui-agent-replay/sandbox/state.json`.
Restarting resumes from the same presentation position.

On startup it checks:

- the sandbox ownership marker before destructive rebuilds
- a session lock so two TUIs cannot control the sandbox at once
- whether the sandbox has uncommitted changes
- whether `HEAD` matches one of the scenario refs

If the sandbox is dirty or diverged, code movement is disabled until you press
`r` to rebuild the isolated sandbox.

`npm run demo` also runs `npm run tui:validate` first. That validation renders
every scenario state with OpenTUI's test renderer and fails if the diff pane
would show `Error parsing diff`.
