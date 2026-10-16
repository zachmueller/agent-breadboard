"""
Breadboard sandbox runtime for Python tool extensions ([06] §2.1).
Reads one RunnerRequest JSON document from stdin, imports the tool entrypoint, calls `handler(input, ctx)`
(or `list`/`fetch` for connectors), and writes RunnerMessage JSON lines to stdout.
Every ctx primitive is an authenticated HTTP call to the Breadboard API, so grants are enforced server-side.
"""
import importlib.util
import json
import os
import sys
import threading
import urllib.request
import urllib.error
from datetime import datetime, timezone


def _emit(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


class BreadboardError(Exception):
    def __init__(self, code, message, detail=None):
        super().__init__(message)
        self.code = code
        self.detail = detail


class BreadboardContext:
    def __init__(self, ambient, base_url, token):
        self.ambient = ambient
        self._base = base_url.rstrip("/")
        self._token = token

    # -- transport -------------------------------------------------------
    def _call(self, name, body):
        data = json.dumps(body or {}).encode("utf-8")
        req = urllib.request.Request(
            f"{self._base}/api/v1/primitives/{name}",
            data=data,
            method="POST",
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self._token}",
                "x-breadboard-execution": self.ambient.get("execution_key", ""),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                text = res.read().decode("utf-8")
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", errors="replace")
            try:
                err = json.loads(text).get("error", {})
            except Exception:
                err = {"code": "internal", "message": text}
            raise BreadboardError(err.get("code", "internal"), err.get("message", "primitive failed"), err.get("detail"))

    def log(self, level, message, data=None):
        _emit({"kind": "log", "level": level, "message": message, "data": data, "at": datetime.now(timezone.utc).isoformat()})

    # -- content ---------------------------------------------------------
    def create_artifact(self, **a):
        return self._call("create_artifact", a)

    def update_artifact(self, **a):
        return self._call("update_artifact", a)

    def read_node(self, uid, revision_id=None):
        return self._call("read_node", {"uid": uid, "revision_id": revision_id})

    def add_comment(self, **a):
        return self._call("add_comment", a)

    def emit_edge(self, **a):
        return self._call("emit_edge", a)

    def tag_need_input(self, **a):
        return self._call("tag_need_input", a)

    # -- knowledge -------------------------------------------------------
    def query_knowledge(self, **a):
        return self._call("query_knowledge", a)

    def read_note(self, uid):
        return self._call("read_note", {"uid": uid})

    def propose_note_edit(self, **a):
        return self._call("propose_note_edit", a)

    # -- intake ----------------------------------------------------------
    def create_task(self, **a):
        return self._call("create_task", a)

    def find_similar_tasks(self, **a):
        return self._call("find_similar_tasks", a)

    # -- sessions --------------------------------------------------------
    def run_circuit(self, uid, input, wait=True):
        return self._call("run_circuit", {"circuit": uid, "input": input, "wait": wait})

    def get_session_summary(self, session_id):
        return self._call("get_session_summary", {"session_id": session_id})

    def run_tool(self, uid, input, settings=None):
        return self._call("run_tool", {"tool": uid, "input": input, "settings": settings})

    # -- broker ----------------------------------------------------------
    def fetch(self, capability, request):
        return self._call("broker_fetch", {"capability": capability, "request": request})

    # -- models ----------------------------------------------------------
    def converse(self, messages, system=None, tools=None, preset=None, model_id=None, max_tokens=None, temperature=None, effort=None, force_tool=None):
        """One model turn through the Breadboard model gateway (the tool must declare the `model` capability).

        Messages and the reply use the gateway's chat format: {"role", "content": [{"type": "text" | "tool_use" |
        "tool_result" | "reasoning", ...}]}; pass reasoning blocks back unchanged on the next turn. `effort` (low…max)
        is ignored by models that do not reason; `force_tool` makes the model call that tool. Spend lands on the
        Session like any other model call.
        """
        body = {"messages": messages, "system": system, "tools": tools, "preset": preset, "model_id": model_id,
                "max_tokens": max_tokens, "temperature": temperature, "effort": effort, "force_tool": force_tool}
        return self._call("model_converse", {k: v for k, v in body.items() if v is not None})

    # -- evals -----------------------------------------------------------
    def record_score(self, **a):
        return self._call("record_score", a)

    def get_rubric(self, circuit_uid):
        return self._call("get_rubric", {"circuit_uid": circuit_uid})

    def read_config(self, ref):
        return self._call("read_config", {"ref": ref})


def _load_module(workdir, entrypoint):
    path = os.path.join(workdir, entrypoint)
    spec = importlib.util.spec_from_file_location("breadboard_tool", path)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, os.path.dirname(path))
    spec.loader.exec_module(mod)
    return mod


def main():
    workdir = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    req = json.loads(sys.stdin.read())
    timeout_ms = req.get("timeout_ms", 120000)

    def _timeout():
        _emit({"kind": "error", "message": f"tool timed out after {timeout_ms}ms"})
        os._exit(1)

    t = threading.Timer(timeout_ms / 1000.0, _timeout)
    t.daemon = True
    t.start()
    try:
        ctx = BreadboardContext(req["ambient"], req["api"]["base_url"], req["api"]["token"])
        mod = _load_module(workdir, req["entrypoint"])
        export = req.get("export") or "handler"
        fn = getattr(mod, export, None)
        if fn is None:
            raise RuntimeError(f"entrypoint {req['entrypoint']} does not define '{export}'")
        inp = req.get("input")
        if export == "handler":
            value = fn(inp, ctx)
        else:
            args = inp if isinstance(inp, list) else [inp]
            value = fn(*args, ctx)
        _emit({"kind": "result", "value": value})
        t.cancel()
        sys.exit(0)
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001
        import traceback

        t.cancel()
        _emit({"kind": "error", "message": str(e), "stack": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
