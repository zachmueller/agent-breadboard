"""Strands model provider backed by the Breadboard model gateway (``ctx.converse``).

The harness holds no AWS credentials: every model turn goes through the Breadboard API, so presets, fallback, the
Session's budget, and cost tracking apply exactly as they do for Subagent steps ([06] §3). Strands speaks the Bedrock
Converse message shapes; the gateway speaks Breadboard chat blocks. This module translates between the two.
"""
import asyncio
import json
import time

from strands.models.model import Model

STOP_REASONS = ("end_turn", "tool_use", "max_tokens", "stop_sequence")


def to_gateway_messages(messages):
    """Strands (Converse-shaped) messages -> gateway chat messages. Reasoning, image, and document blocks are dropped."""
    out = []
    for m in messages:
        blocks, results = [], 0
        for c in m.get("content", []):
            if "text" in c:
                blocks.append({"type": "text", "text": c["text"]})
            elif "toolUse" in c:
                tu = c["toolUse"]
                blocks.append({"type": "tool_use", "id": tu["toolUseId"], "name": tu["name"], "input": tu.get("input") or {}})
            elif "toolResult" in c:
                tr = c["toolResult"]
                parts = [p["text"] if "text" in p else json.dumps(p["json"]) for p in tr.get("content", []) if "text" in p or "json" in p]
                blocks.append({"type": "tool_result", "tool_use_id": tr["toolUseId"], "content": "\n".join(parts),
                               "is_error": tr.get("status") == "error"})
                results += 1
        if blocks:
            out.append({"role": "tool" if results == len(blocks) else m["role"], "content": blocks})
    return out


def to_gateway_tools(tool_specs):
    return [{"name": t["name"], "description": t.get("description") or t["name"],
             "input_schema": (t.get("inputSchema") or {}).get("json") or {"type": "object"}} for t in tool_specs or []]


def to_stream_events(res, latency_ms):
    """A gateway reply -> Strands stream events (Converse stream shape)."""
    yield {"messageStart": {"role": "assistant"}}
    for b in res["message"]["content"]:
        if b["type"] == "text":
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": b["text"]}}}
            yield {"contentBlockStop": {}}
        elif b["type"] == "tool_use":
            yield {"contentBlockStart": {"start": {"toolUse": {"name": b["name"], "toolUseId": b["id"]}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(b.get("input") or {})}}}}
            yield {"contentBlockStop": {}}
    stop = res.get("stop_reason")
    yield {"messageStop": {"stopReason": stop if stop in STOP_REASONS else "end_turn"}}
    u = res.get("usage") or {}
    i, o = u.get("input_tokens", 0), u.get("output_tokens", 0)
    yield {"metadata": {"usage": {"inputTokens": i, "outputTokens": o, "totalTokens": i + o}, "metrics": {"latencyMs": latency_ms}}}


class BreadboardModel(Model):
    """`config`: `preset` (gateway tier), `model_id` (explicit override), `max_tokens`."""

    def __init__(self, ctx, **config):
        self.ctx = ctx
        self.config = dict(config)

    def update_config(self, **model_config):
        self.config.update(model_config)

    def get_config(self):
        return dict(self.config)

    async def stream(self, messages, tool_specs=None, system_prompt=None, *, tool_choice=None, **kwargs):
        started = time.time()
        options = {k: v for k, v in self.config.items() if v}
        # ctx.converse is a blocking HTTP call; keep the agent's event loop free while it runs.
        res = await asyncio.to_thread(self.ctx.converse, to_gateway_messages(messages), system=system_prompt,
                                      tools=to_gateway_tools(tool_specs) or None, **options)
        for event in to_stream_events(res, int((time.time() - started) * 1000)):
            yield event

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        raise NotImplementedError("structured output is not supported through the Breadboard gateway adapter")
        yield  # pragma: no cover - makes this an async generator, as the interface requires
