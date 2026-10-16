"""spawn-harness — Strands adapters ([06] §3).

Breadboard is the harness's *user*: we build a Strands agent, hand it the step's task prompt as the user turn,
forward its event stream into the Session code-step log via ``ctx.log``, and map declared outputs to Artifacts.
The harness's model turns go through the Breadboard model gateway (``breadboard_model.BreadboardModel`` over
``ctx.converse``), so they use presets and fallback, count against the Session's budget, and show up in its cost.

Two adapters share everything but the agent: ``strands`` builds a plain Strands ``Agent`` with four workspace tools;
``strands-harness`` builds Strands Harness (``create_harness``: shell/read/write/edit tools, context management,
todos, a helper subagent), with the features Breadboard already owns turned off (memory, sessions, skills).
"""
import fnmatch
import os
import pathlib
import subprocess
import tempfile
import time

MAX_FILE_BYTES = 200_000
CMD_TIMEOUT_S = 120

HARNESS_SYSTEM_PROMPT = """You are a software engineering agent running inside an isolated sandbox container.
Your user is Breadboard, an orchestration system, not a person: it sends you one task and reads your final answer.
There is no human to answer questions mid-task, so:
- Make the most reasonable assumption when something is ambiguous, and list every assumption in your final answer.
- Work only inside the workspace directory: {workspace}. Paths you pass to tools are relative to it.
- Prefer small, reviewable changes that follow the existing code's conventions. Do not reformat unrelated code.
- Verify your work (build, tests, linters) with run_command when the project supports it, and report the results honestly.
- Never invent results, test output, or file contents. If you could not finish, say exactly what remains.
- Network access is restricted; package installs or downloads may fail. Report such failures rather than working around them.
Finish with a concise Markdown summary: what you changed and why, files touched, verification performed, assumptions, open issues."""

# Strands Harness brings its own agent contract; this is the domain block appended to it.
HARNESS_INSTRUCTIONS = """Your user is Breadboard, an orchestration system, not a person: it sends you one task and reads your final answer.
There is no human to answer questions mid-task: make the most reasonable assumption when something is ambiguous, and list every assumption in your final answer.
Work only inside the workspace directory {workspace} (your working directory); file tools take absolute paths under it.
Prefer small, reviewable changes that follow the existing code's conventions. Do not reformat unrelated code.
Verify your work (build, tests, linters) when the project supports it, and report the results honestly. Never invent results, test output, or file contents.
Network access is restricted; package installs or downloads may fail. Report such failures rather than working around them.
Finish with a concise Markdown summary: what you changed and why, files touched, verification performed, assumptions, open issues."""

# Breadboard owns durability (step boundaries), memory (Knowledge), and the network policy (default-deny egress), so
# the harness gets only its workspace tools and helper subagent.
HARNESS_BUILTIN_TOOLS = ["shell", "read", "write", "edit", "subagent"]
ADAPTERS = ("strands", "strands-harness")


def _ret(ctx, exit_name, output):
    return {"exit": exit_name, "output": output} if ctx.ambient.get("invocation") == "code-step" else output


def _ref(r):
    return {"uid": r["uid"], "revision_id": r["revision_id"]}


def _run(args, cwd, timeout=CMD_TIMEOUT_S):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    return subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)


def _prepare_workspace(ctx, repo_url):
    ws = tempfile.mkdtemp(prefix="bb-harness-")
    if not repo_url:
        return ws, False
    ctx.log("info", f"cloning workspace {repo_url}")
    res = _run(["git", "clone", "--quiet", "--depth", "50", repo_url, ws], cwd=None, timeout=600)
    if res.returncode != 0:
        raise RuntimeError(f"workspace clone failed (is the host in egress.allow?): {res.stderr.strip()[:400]}")
    return ws, True


def _compose_prompt(ctx, inp):
    if inp.get("prompt"):
        return inp["prompt"]
    parts = []
    task = inp.get("task") or {}
    if task.get("title"):
        parts.append(f"# Task: {task['title']}")
    if task.get("body"):
        parts += ["", task["body"]]
    plan = inp.get("plan_artifact")
    if plan and plan.get("uid"):
        node = ctx.read_node(plan["uid"], plan.get("revision_id"))
        parts += ["", "## Plan to follow", "", node.get("body_text") or str(node.get("body") or "")]
    if inp.get("feedback"):
        parts += ["", "## Reviewer feedback on your previous attempt (address every point)", ""]
        parts += [f"- {f}" for f in inp["feedback"]]
    if not parts:
        raise ValueError("spawn-harness needs `prompt`, or `task`/`plan_artifact` to compose one")
    return "\n".join(parts)


def _make_tools(strands_tool, ws):
    root = pathlib.Path(ws).resolve()

    def inside(rel):
        p = (root / rel).resolve()
        if p != root and root not in p.parents:
            raise ValueError(f"path escapes the workspace: {rel}")
        return p

    @strands_tool
    def list_files(path: str = ".") -> str:
        """List files under a workspace directory (recursive, max 500 entries, .git excluded)."""
        base = inside(path)
        out = []
        for p in sorted(base.rglob("*")):
            if ".git" in p.parts or not p.is_file():
                continue
            out.append(str(p.relative_to(root)))
            if len(out) >= 500:
                out.append("... (truncated)")
                break
        return "\n".join(out) or "(empty)"

    @strands_tool
    def read_file(path: str) -> str:
        """Read a UTF-8 text file from the workspace."""
        data = inside(path).read_text(encoding="utf-8", errors="replace")
        return data if len(data) <= MAX_FILE_BYTES else data[:MAX_FILE_BYTES] + "\n... (truncated)"

    @strands_tool
    def write_file(path: str, content: str) -> str:
        """Create or overwrite a text file in the workspace (parent directories are created)."""
        p = inside(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"wrote {len(content)} chars to {path}"

    @strands_tool
    def run_command(command: str) -> str:
        """Run a shell command in the workspace root (120 s timeout). Returns exit code, stdout and stderr."""
        try:
            res = subprocess.run(command, shell=True, cwd=root, capture_output=True, text=True, timeout=CMD_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            return f"timed out after {CMD_TIMEOUT_S}s"
        return f"exit={res.returncode}\n--- stdout ---\n{res.stdout[-8000:]}\n--- stderr ---\n{res.stderr[-4000:]}"

    return [list_files, read_file, write_file, run_command]


class _Forwarder:
    """Strands callback handler: forwards completed messages and tool starts into the Session code log."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.transcript = []
        self.seen_tools = set()

    def __call__(self, **kw):
        tu = kw.get("current_tool_use")
        if tu and tu.get("toolUseId") and tu["toolUseId"] not in self.seen_tools:
            self.seen_tools.add(tu["toolUseId"])
            self.ctx.log("info", f"harness tool call: {tu.get('name')}", {"tool_use_id": tu["toolUseId"]})
        msg = kw.get("message")
        if msg:
            self._message(msg)
        if kw.get("force_stop"):
            self.ctx.log("warn", "harness force-stopped", {"reason": str(kw.get("force_stop_reason", ""))})

    def _message(self, msg):
        role = msg.get("role", "?")
        for block in msg.get("content", []):
            if "text" in block and block["text"].strip():
                self.transcript.append(f"### {role}\n\n{block['text'].strip()}\n")
                self.ctx.log("info", f"harness {role} turn", {"text": block["text"][:4000]})
            elif "toolUse" in block:
                t = block["toolUse"]
                self.transcript.append(f"### tool call: {t.get('name')}\n\n```json\n{t.get('input')}\n```\n")
                self.ctx.log("debug", f"harness tool input: {t.get('name')}", {"input": t.get("input")})
            elif "toolResult" in block:
                r = block["toolResult"]
                text = "\n".join(c.get("text", "") for c in r.get("content", []) if isinstance(c, dict))
                self.transcript.append(f"### tool result ({r.get('status', '?')})\n\n```\n{text[:4000]}\n```\n")
                self.ctx.log("debug", "harness tool result", {"status": r.get("status"), "text": text[:2000]})


def _changed_paths(ws, is_repo):
    if not is_repo:
        return None
    res = _run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=ws)
    return {line[3:].split(" -> ")[-1] for line in res.stdout.splitlines() if len(line) > 3}


def _matches(rel, pattern):
    """Glob match on the workspace-relative path; a leading `**/` also matches at the root (fnmatch needs a slash)."""
    return fnmatch.fnmatch(rel, pattern) or (pattern.startswith("**/") and fnmatch.fnmatch(rel, pattern[3:]))


def _capture(ctx, ws, is_repo, patterns, max_files):
    changed = _changed_paths(ws, is_repo)
    root = pathlib.Path(ws)
    refs = []
    for p in sorted(root.rglob("*")):
        rel = str(p.relative_to(root))
        if ".git" in p.parts or not p.is_file():
            continue
        if changed is not None and rel not in changed:
            continue  # in a checkout, only capture files the harness created or modified
        if not any(_matches(rel, pat) or fnmatch.fnmatch(p.name, pat) for pat in patterns):
            continue
        if p.stat().st_size > MAX_FILE_BYTES:
            ctx.log("warn", f"not capturing {rel}: larger than {MAX_FILE_BYTES} bytes")
            continue
        refs.append(_ref(ctx.create_artifact(
            title=rel, body=p.read_text(encoding="utf-8", errors="replace"),
            tags=["intermediate", "harness-output"], scope="session", properties={"path": rel},
        )))
        if len(refs) >= max_files:
            ctx.log("warn", f"capture limit of {max_files} files reached")
            break
    return refs


def _build_agent(adapter, model, ws, forward):
    """The adapter's agent; raises ImportError when its package is missing from the sandbox image."""
    if adapter == "strands-harness":
        from strands_harness import create_harness

        return create_harness(
            model=model,
            instructions=HARNESS_INSTRUCTIONS.format(workspace=ws),
            builtin_tools=HARNESS_BUILTIN_TOOLS,
            memory=False,
            session=False,
            skills=False,
            caching=False,  # the Breadboard gateway places the cache points
            callback_handler=forward,
        )
    from strands import Agent, tool as strands_tool

    return Agent(model=model, system_prompt=HARNESS_SYSTEM_PROMPT.format(workspace=ws), tools=_make_tools(strands_tool, ws), callback_handler=forward)


def handler(input, ctx):
    inp = input or {}
    settings = ctx.ambient.get("settings") or {}
    adapter = settings.get("harness") or "strands"
    if adapter not in ADAPTERS:
        return _ret(ctx, "failed", {"error": f"unsupported harness adapter: {adapter}"})
    try:
        from breadboard_model import BreadboardModel
    except ImportError:
        return _ret(ctx, "failed", {"error": "strands not installed — add strands-agents to the python sandbox image"})

    try:
        prompt = _compose_prompt(ctx, inp)
        ws, is_repo = _prepare_workspace(ctx, (settings.get("workspace_repo") or "").strip())
    except Exception as e:
        return _ret(ctx, "failed", {"error": str(e)})

    preset = settings.get("preset") or "medium"
    model_id = settings.get("model_id") or None
    effort = settings.get("effort") or None
    forward = _Forwarder(ctx)
    try:
        agent = _build_agent(adapter, BreadboardModel(ctx, preset=preset, model_id=model_id, effort=effort), ws, forward)
    except ImportError as e:
        return _ret(ctx, "failed", {"error": f"{adapter} adapter unavailable ({e}) — add it to the python sandbox image"})
    ctx.log("info", f"starting {adapter}", {"preset": preset, "model_id": model_id, "effort": effort, "workspace_is_repo": is_repo})
    started = time.time()
    cwd = os.getcwd()
    try:
        os.chdir(ws)  # the harness's built-in tools resolve paths against the working directory
        result = agent(prompt)
    except Exception as e:  # model/tool-loop failure: still keep what we saw
        ctx.log("error", f"harness failed: {e}")
        transcript = ctx.create_artifact(title="Harness transcript (failed run)", body="\n".join(forward.transcript) or "_empty_",
                                         tags=["intermediate", "harness-transcript"], scope="session")
        return _ret(ctx, "failed", {"error": str(e), "transcript_artifact": _ref(transcript)})
    finally:
        os.chdir(cwd)

    elapsed = round(time.time() - started, 1)
    final_text = str(result).strip() or "_The harness returned no final message._"
    usage = {}
    metrics = getattr(result, "metrics", None)
    if metrics is not None and getattr(metrics, "accumulated_usage", None):
        usage = dict(metrics.accumulated_usage)
    # The per-turn spend is already on the Session (gateway turns); this is the harness's own tally.
    ctx.log("info", "harness finished", {"stop_reason": str(getattr(result, "stop_reason", "")), "elapsed_s": elapsed, "usage": usage})

    # Summary + patch carry no explicit scope/tag: the calling step's `artifacts:` declaration (or the Breadboard
    # default) decides whether they are reviewable deliverables or session scratch.
    summary = ctx.create_artifact(title="Harness summary", body=final_text, tags=["harness-summary"],
                                  properties={"adapter": adapter, "preset": preset, "model_id": model_id, "effort": effort, "elapsed_s": elapsed, "usage": usage})
    transcript = ctx.create_artifact(title="Harness transcript", body="\n".join(forward.transcript) or "_empty_",
                                     tags=["intermediate", "harness-transcript"], scope="session")
    patch_ref = None
    if is_repo:
        diff = _run(["git", "diff", "--stat", "--patch"], cwd=ws).stdout
        if diff.strip():
            patch_ref = _ref(ctx.create_artifact(title="Harness patch", body=f"```diff\n{diff[:MAX_FILE_BYTES]}\n```",
                                                 tags=["harness-patch"]))
    files = _capture(ctx, ws, is_repo, inp.get("capture") or ["**/*.md"], int(settings.get("max_capture_files") or 20))

    return _ret(ctx, "done", {
        "summary_artifact": _ref(summary),
        "transcript_artifact": _ref(transcript),
        "patch_artifact": patch_ref,
        "files": files,
        "stop_reason": str(getattr(result, "stop_reason", "")),
        "usage": usage,
    })
