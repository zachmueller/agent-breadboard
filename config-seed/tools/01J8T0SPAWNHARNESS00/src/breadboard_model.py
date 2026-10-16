"""Strands model provider backed by the Breadboard model gateway (``ctx.converse``).

The harness holds no AWS credentials: every model turn goes through the Breadboard API, so presets, fallback, prompt
caching, the Session's budget, and cost tracking apply exactly as they do for Subagent steps ([06] §3). Strands speaks
the Bedrock Converse message shapes; the gateway speaks Breadboard chat blocks. This module translates between the two.

Reasoning blocks round-trip verbatim: the gateway's block (with the model id and prefix fingerprint it is bound to) is
remembered by signature, so when Strands replays the Converse-shaped block the original goes back to the gateway.
"""
import asyncio
import base64
import json
import time

from strands.models.model import Model

STOP_REASONS = ("end_turn", "tool_use", "max_tokens", "stop_sequence")
# Config keys sent to the gateway; the rest (e.g. `context_window_limit`) are for Strands itself.
GATEWAY_OPTIONS = ("preset", "model_id", "max_tokens", "effort")
# The smallest context among the preset fallbacks, so Strands' compaction triggers early rather than late.
DEFAULT_CONTEXT_WINDOW = 200_000


class BreadboardModel(Model):
    """`config`: `preset` (gateway tier), `model_id` (explicit override), `max_tokens`, `effort` (low…max), and
    `context_window_limit` (Strands' compaction threshold; not sent to the gateway)."""

    def __init__(self, ctx, **config):
        self.ctx = ctx
        self.config = {"context_window_limit": DEFAULT_CONTEXT_WINDOW, **config}
        # Gateway reasoning blocks by signature (or redacted payload), for verbatim replay.
        self._reasoning = {}
        self._last_model_id = None

    def update_config(self, **model_config):
        self.config.update(model_config)

    def get_config(self):
        return dict(self.config)

    # -- Strands (Converse-shaped) -> gateway ------------------------------------------------------------------
    def _reasoning_to_gateway(self, rc):
        if rc.get("redactedContent"):
            raw = rc["redactedContent"]
            key = base64.b64encode(raw if isinstance(raw, (bytes, bytearray)) else bytes(raw)).decode()
            return self._reasoning.get(key) or {"type": "reasoning", "text": "", "redacted": key, "model_id": self._last_model_id or ""}
        rt = rc.get("reasoningText") or {}
        sig = rt.get("signature")
        if sig and sig in self._reasoning:
            return self._reasoning[sig]
        block = {"type": "reasoning", "text": rt.get("text", ""), "model_id": self._last_model_id or ""}
        if sig:
            block["signature"] = sig
        return block

    def to_gateway_messages(self, messages):
        """Strands messages -> gateway chat messages. Image and document blocks are dropped."""
        out = []
        for m in messages:
            blocks, results = [], 0
            for c in m.get("content", []):
                if "text" in c:
                    blocks.append({"type": "text", "text": c["text"]})
                elif "reasoningContent" in c:
                    blocks.append(self._reasoning_to_gateway(c["reasoningContent"]))
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

    # -- gateway -> Strands stream events ----------------------------------------------------------------------
    def to_stream_events(self, res, latency_ms):
        """A gateway reply -> Strands stream events (Converse stream shape)."""
        self._last_model_id = res.get("model_id") or self._last_model_id
        yield {"messageStart": {"role": "assistant"}}
        for b in res["message"]["content"]:
            if b["type"] == "text":
                yield {"contentBlockStart": {"start": {}}}
                yield {"contentBlockDelta": {"delta": {"text": b["text"]}}}
                yield {"contentBlockStop": {}}
            elif b["type"] == "reasoning":
                yield {"contentBlockStart": {"start": {}}}
                if b.get("redacted"):
                    self._reasoning[b["redacted"]] = b
                    yield {"contentBlockDelta": {"delta": {"reasoningContent": {"redactedContent": base64.b64decode(b["redacted"])}}}}
                else:
                    yield {"contentBlockDelta": {"delta": {"reasoningContent": {"text": b.get("text", "")}}}}
                    if b.get("signature"):
                        self._reasoning[b["signature"]] = b
                        yield {"contentBlockDelta": {"delta": {"reasoningContent": {"signature": b["signature"]}}}}
                yield {"contentBlockStop": {}}
            elif b["type"] == "tool_use":
                yield {"contentBlockStart": {"start": {"toolUse": {"name": b["name"], "toolUseId": b["id"]}}}}
                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(b.get("input") or {})}}}}
                yield {"contentBlockStop": {}}
        stop = res.get("stop_reason")
        yield {"messageStop": {"stopReason": stop if stop in STOP_REASONS else "end_turn"}}
        u = res.get("usage") or {}
        i, o = u.get("input_tokens", 0), u.get("output_tokens", 0)
        cr, cw = u.get("cache_read_tokens", 0), u.get("cache_write_tokens", 0)
        usage = {"inputTokens": i, "outputTokens": o, "totalTokens": i + o + cr + cw}
        if cr:
            usage["cacheReadInputTokens"] = cr
        if cw:
            usage["cacheWriteInputTokens"] = cw
        yield {"metadata": {"usage": usage, "metrics": {"latencyMs": latency_ms}}}

    # -- Model interface ---------------------------------------------------------------------------------------
    async def stream(self, messages, tool_specs=None, system_prompt=None, *, tool_choice=None, **kwargs):
        started = time.time()
        options = {k: v for k, v in self.config.items() if v and k in GATEWAY_OPTIONS}
        tools = to_gateway_tools(tool_specs) or None
        force = forced_tool_name(tool_choice, tools)
        if force:
            options["force_tool"] = force
        # ctx.converse is a blocking HTTP call; keep the agent's event loop free while it runs.
        res = await asyncio.to_thread(self.ctx.converse, self.to_gateway_messages(messages), system=system_prompt, tools=tools, **options)
        for event in self.to_stream_events(res, int((time.time() - started) * 1000)):
            yield event

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        from strands.event_loop import streaming
        from strands.tools import convert_pydantic_to_tool_spec

        spec = convert_pydantic_to_tool_spec(output_model)
        events = self.stream(prompt, tool_specs=[spec], system_prompt=system_prompt, tool_choice={"tool": {"name": spec["name"]}})
        event = None
        async for event in streaming.process_stream(events):
            yield event
        _stop, message, _usage, _metrics = event["stop"]
        for block in message["content"]:
            if block.get("toolUse") and block["toolUse"]["name"] == spec["name"]:
                yield {"output": output_model(**block["toolUse"]["input"])}
                return
        raise ValueError(f"the model did not call `{spec['name']}` for structured output")


def to_gateway_tools(tool_specs):
    return [{"name": t["name"], "description": t.get("description") or t["name"],
             "input_schema": (t.get("inputSchema") or {}).get("json") or {"type": "object"}} for t in tool_specs or []]


def forced_tool_name(tool_choice, tools):
    """Strands `tool_choice` -> the gateway's `force_tool` (`any` needs exactly one tool to name)."""
    if not tool_choice or not tools:
        return None
    if "tool" in tool_choice:
        return tool_choice["tool"].get("name")
    if "any" in tool_choice and len(tools) == 1:
        return tools[0]["name"]
    return None
