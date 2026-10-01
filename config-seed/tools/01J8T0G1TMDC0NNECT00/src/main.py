"""git-markdown-connector: reference read-only knowledge connector ([07] §8).

Connector contract (called by the connector scheduler with export = list | fetch):
    list(cursor, ctx)       -> {items: [{external_id, title, updated_at}], next_cursor}
    fetch(external_id, ctx) -> {markdown, metadata}

Containers are stateless, so every call shallow-clones (blob-filtered) the configured repository into a temp dir.
`git` reaches the host through the sandbox egress proxy (HTTPS_PROXY is set by the runtime), which means the
repository host MUST appear in this tool's `egress.allow`.
"""
import os
import re
import subprocess
import tempfile
import urllib.parse

GIT_TIMEOUT_S = 300


def _settings(ctx):
    s = ctx.ambient.get("settings") or {}
    url = (s.get("repo_url") or "").strip()
    if not url:
        raise ValueError("connector setting 'repo_url' is required")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise ValueError("repo_url must be an https:// URL (the sandbox only allows HTTP(S) egress)")
    if parsed.username or parsed.password:
        raise ValueError("repo_url must not embed credentials")
    prefix = (s.get("path_prefix") or "").strip().strip("/")
    return url, (s.get("branch") or "main"), prefix, int(s.get("page_size") or 200)


def _git(args, cwd=None):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    res = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=GIT_TIMEOUT_S)
    if res.returncode != 0:
        raise RuntimeError(f"git {args[0]} failed: {res.stderr.strip()[:500]}")
    return res.stdout


def _clone(ctx, url, branch):
    tmp = tempfile.mkdtemp(prefix="bb-gitmd-")
    ctx.log("info", f"cloning {url}@{branch}")
    # Full history of commits (for per-file updated_at) but no blobs until checkout: cheap for docs repos.
    _git(["clone", "--quiet", "--filter=blob:none", "--single-branch", "--branch", branch, url, tmp])
    return tmp


def _markdown_files(repo, prefix):
    out = _git(["ls-files", "-z", "--", f"{prefix}/" if prefix else "."], cwd=repo)
    return sorted(p for p in out.split("\0") if p.lower().endswith((".md", ".markdown")))


def _updated_at(repo, path):
    return _git(["log", "-1", "--format=%cI", "--", path], cwd=repo).strip()


def _title(markdown, path):
    m = re.search(r"^#\s+(.+?)\s*#*\s*$", markdown, re.MULTILINE)
    if m:
        return m.group(1).strip()
    base = os.path.splitext(os.path.basename(path))[0]
    return re.sub(r"[-_]+", " ", base).strip().capitalize() or path


def _source_url(url, branch, path):
    p = urllib.parse.urlparse(url)
    if p.netloc in ("github.com", "www.github.com"):
        repo = p.path.rstrip("/")
        repo = repo[:-4] if repo.endswith(".git") else repo
        return f"https://github.com{repo}/blob/{branch}/{urllib.parse.quote(path)}"
    return None


def list(cursor, ctx):  # noqa: A001 - name fixed by the connector contract
    """Paged enumeration. `cursor` is an opaque offset ("o:<n>"); the scheduler compares updated_at for incrementality."""
    url, branch, prefix, page_size = _settings(ctx)
    repo = _clone(ctx, url, branch)
    files = _markdown_files(repo, prefix)
    start = int(cursor[2:]) if cursor and cursor.startswith("o:") else 0
    page = files[start:start + page_size]
    items = []
    for path in page:
        try:
            with open(os.path.join(repo, path), encoding="utf-8", errors="replace") as fh:
                head = fh.read(4096)
        except OSError:
            head = ""
        items.append({"external_id": path, "title": _title(head, path), "updated_at": _updated_at(repo, path)})
    nxt = start + page_size
    ctx.log("info", f"listed {len(items)} of {len(files)} markdown file(s)", {"offset": start})
    return {"items": items, "next_cursor": f"o:{nxt}" if nxt < len(files) else None}


def fetch(external_id, ctx):
    url, branch, prefix, _ = _settings(ctx)
    norm = os.path.normpath(external_id)
    if norm.startswith("..") or os.path.isabs(norm):
        raise ValueError(f"invalid external_id: {external_id}")
    if prefix and not norm.startswith(prefix + "/"):
        raise ValueError(f"{external_id} is outside path_prefix {prefix}/")
    repo = _clone(ctx, url, branch)
    with open(os.path.join(repo, norm), encoding="utf-8", errors="replace") as fh:
        markdown = fh.read()
    commit = _git(["log", "-1", "--format=%H", "--", norm], cwd=repo).strip()
    return {
        "markdown": markdown,
        "metadata": {
            "title": _title(markdown, norm),
            "external_id": norm,
            "source_url": _source_url(url, branch, norm),
            "repo_url": url,
            "branch": branch,
            "commit": commit,
            "updated_at": _updated_at(repo, norm),
        },
    }


def handler(input, ctx):
    """Manual/debug entry point: {op: 'list', cursor} or {op: 'fetch', external_id}."""
    op = (input or {}).get("op", "list")
    if op == "list":
        return list(input.get("cursor"), ctx)
    if op == "fetch":
        return fetch(input["external_id"], ctx)
    raise ValueError(f"unknown op: {op}")
