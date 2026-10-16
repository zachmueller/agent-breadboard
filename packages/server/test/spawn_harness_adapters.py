"""Checks for the spawn-harness Strands adapters, run by seed-tools.test.ts (needs strands-agents + strands-harness).

Usage: python3 spawn_harness_adapters.py <spawn-harness src dir>. Exits non-zero on the first failed check.
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, sys.argv[1])

from strands.event_loop import streaming  # noqa: E402

import breadboard_model  # noqa: E402
import main  # noqa: E402

MODEL = "us.anthropic.claude-sonnet-5"


class FakeCtx:
    """The slice of BreadboardContext spawn-harness uses; `replies` is a list of gateway replies (or callables)."""

    def __init__(self, replies, settings=None):
        self.replies = list(replies)
        self.calls = []
        self.logs = []
        self.artifacts = []
        self.ambient = {"invocation": "code-step", "settings": settings or {}}

    def converse(self, messages, **kw):
        self.calls.append({"messages": messages, **kw})
        r = self.replies.pop(0)
        return r(messages, kw) if callable(r) else r

    def log(self, level, msg, data=None):
        self.logs.append((level, msg))

    def create_artifact(self, **a):
        self.artifacts.append(a)
        return {"uid": f"A{len(self.artifacts)}", "revision_id": 1}

    def read_node(self, uid, revision_id=None):
        return {"body_text": ""}


def reply(content, stop="end_turn", usage=None):
    return {"message": {"role": "assistant", "content": content}, "stop_reason": stop, "model_id": MODEL,
            "usage": usage or {"input_tokens": 10, "output_tokens": 5}, "cost_usd": 0.001}


async def collect(gen):
    events = []
    async for e in streaming.process_stream(gen):
        events.append(e)
    return events


def check_reasoning_round_trip():
    reasoning = {"type": "reasoning", "text": "Plan: read then answer.", "signature": "sig-1", "model_id": MODEL, "prefix_fp": "fp-1"}
    redacted = {"type": "reasoning", "text": "", "redacted": "AQID", "model_id": MODEL, "prefix_fp": "fp-1"}
    ctx = FakeCtx([reply([reasoning, redacted, {"type": "text", "text": "hi"}], usage={"input_tokens": 3, "output_tokens": 5, "cache_read_tokens": 900, "cache_write_tokens": 40})])
    m = breadboard_model.BreadboardModel(ctx, preset="medium", effort="high")
    events = asyncio.run(collect(m.stream([{"role": "user", "content": [{"text": "q"}]}], system_prompt="s")))
    stop_reason, message, usage, _ = events[-1]["stop"]
    assert ctx.calls[0]["effort"] == "high", ctx.calls[0]
    assert usage["cacheReadInputTokens"] == 900 and usage["cacheWriteInputTokens"] == 40 and usage["totalTokens"] == 948, usage
    kinds = [list(b)[0] for b in message["content"]]
    assert kinds == ["reasoningContent", "reasoningContent", "text"], kinds
    # Replaying Strands' copy of the message hands the gateway its original blocks (model id and fingerprint kept).
    back = m.to_gateway_messages([{"role": "user", "content": [{"text": "q"}]}, message])
    assert back[1]["content"][0] == reasoning, back[1]["content"][0]
    assert back[1]["content"][1] == redacted, back[1]["content"][1]


def check_forced_tool_and_structured_output():
    assert breadboard_model.forced_tool_name({"tool": {"name": "x"}}, [{"name": "x"}, {"name": "y"}]) == "x"
    assert breadboard_model.forced_tool_name({"any": {}}, [{"name": "only"}]) == "only"
    assert breadboard_model.forced_tool_name({"any": {}}, [{"name": "a"}, {"name": "b"}]) is None
    assert breadboard_model.forced_tool_name({"auto": {}}, [{"name": "a"}]) is None

    from pydantic import BaseModel

    class Verdict(BaseModel):
        ok: bool

    def answer(messages, kw):
        return reply([{"type": "tool_use", "id": "t1", "name": kw["force_tool"], "input": {"ok": True}}], stop="tool_use")

    ctx = FakeCtx([answer])
    m = breadboard_model.BreadboardModel(ctx)

    async def run():
        out = None
        async for e in m.structured_output(Verdict, [{"role": "user", "content": [{"text": "judge"}]}]):
            out = e
        return out

    out = asyncio.run(run())
    assert out["output"] == Verdict(ok=True), out
    assert ctx.calls[0]["force_tool"] == "Verdict", ctx.calls[0]


def check_strands_harness_run():
    """The strands-harness adapter edits the workspace with its built-in tools and returns the usual outputs."""
    # Replies are built when the model is called, inside the workspace (the adapter's working directory).
    replies = [
        lambda _m, _kw: reply([{"type": "reasoning", "text": "Write the file.", "signature": "s1", "model_id": MODEL},
               {"type": "tool_use", "id": "t1", "name": "write", "input": {"path": os.path.join(os.getcwd(), "NOTES.md"), "content": "# Notes\n"}}], stop="tool_use"),
        reply([{"type": "text", "text": "Wrote NOTES.md."}]),
    ]
    ctx = FakeCtx(replies, settings={"harness": "strands-harness", "effort": "low"})
    cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as home:
        os.environ["HOME"] = home
        out = main.handler({"prompt": "Write NOTES.md"}, ctx)
    assert os.getcwd() == cwd, "the working directory is restored"
    assert out["exit"] == "done", out
    assert ctx.calls[0]["effort"] == "low"
    sent = {t["name"] for t in ctx.calls[0]["tools"]}
    assert {"shell", "read", "write", "edit"} <= sent and not sent & {"web_fetch", "web_search", "programmatic_tool_caller"}, sent
    # The second turn replays the first turn's reasoning block as the gateway produced it.
    assistant = [msg for msg in ctx.calls[1]["messages"] if msg["role"] == "assistant"][0]
    assert assistant["content"][0] == {"type": "reasoning", "text": "Write the file.", "signature": "s1", "model_id": MODEL}, assistant
    captured = [a for a in ctx.artifacts if a.get("properties", {}).get("path") == "NOTES.md"]
    assert captured and captured[0]["body"] == "# Notes\n", ctx.artifacts
    summary = [a for a in ctx.artifacts if a["title"] == "Harness summary"][0]
    assert summary["body"] == "Wrote NOTES.md." and summary["properties"]["adapter"] == "strands-harness", summary


check_reasoning_round_trip()
check_forced_tool_and_structured_output()
check_strands_harness_run()
print("ok")
