# OpenTUI Agent Replay Prototype

This is an isolated prototype for the talk flow:

- right arrow advances the prepared conversation
- left arrow goes backward
- prepared user input prints into the prompt before it is submitted
- right arrow during prompt printing skips to the full prompt
- forward during agent typing skips to the completed stream
- completing an agent stream moves the visible demo workspace to an exact git ref
- going back from a completed exchange moves the workspace back and removes that exchange from the transcript

The live code is under:

```text
opentui-agent-replay/sandbox/workspace
```

That directory is generated and owned by this prototype. Open it in your IDE
during the presentation, not the parent project.

## Run

```sh
npm install
npm run demo
```

Useful non-interactive commands:

```sh
npm run demo:prepare
npm run status
npm run validate
```

## Safety Model

The prototype does not apply patches to the current project. It creates an
owned sandbox git repository with immutable scenario refs:

- `scenario/step-00-base`
- `scenario/step-01-agent-tests`
- `scenario/step-02-agent-fix`

The visible branch is `scenario/live`. Arrow navigation force-moves only that
branch inside the sandbox.

On startup the app checks:

- a session lock, so two TUIs do not control the sandbox at once
- whether the sandbox has uncommitted changes
- whether `HEAD` matches one of the scenario refs

If the sandbox is dirty or diverged, code moves are disabled. Press `r` in the
TUI to rebuild the sandbox from the scenario refs.
