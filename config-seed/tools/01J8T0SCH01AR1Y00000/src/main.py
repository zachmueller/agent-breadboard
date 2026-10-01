"""search-scholarly: Crossref / Semantic Scholar search that returns source Artifacts ([06] §2, [03] §2 lit-review).

Every HTTP call goes through ``ctx.fetch(capability, request)``; the broker validates the capability, attaches any
credential, and audits the call. Nothing here holds a credential.
"""
import json
import re
import urllib.parse

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "in", "is", "it",
    "of", "on", "or", "should", "that", "the", "to", "what", "when", "which", "who", "why", "with", "we", "our",
}


def keywords(query):
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9\-]+", query.lower())
    seen = []
    for w in words:
        if w not in STOPWORDS and w not in seen:
            seen.append(w)
    return seen[:12]


def _strip_tags(text):
    return re.sub(r"<[^>]+>", "", text or "").strip()


def search_crossref(ctx, query, limit, year_from, mailto):
    params = {"query": query, "rows": str(limit), "select": "DOI,title,author,issued,abstract,URL,container-title"}
    if year_from:
        params["filter"] = f"from-pub-date:{year_from}"
    if mailto:
        params["mailto"] = mailto
    res = ctx.fetch("crossref-api", {"url": "https://api.crossref.org/works?" + urllib.parse.urlencode(params), "method": "GET"})
    if res["status"] >= 400:
        raise RuntimeError(f"crossref HTTP {res['status']}")
    items = json.loads(res["body"]).get("message", {}).get("items", [])
    out = []
    for it in items:
        title = (it.get("title") or [""])[0]
        if not title:
            continue
        parts = (it.get("issued", {}).get("date-parts") or [[None]])[0]
        authors = [" ".join(x for x in (a.get("given"), a.get("family")) if x) for a in it.get("author", [])][:8]
        out.append({
            "title": title,
            "authors": authors,
            "year": parts[0] if parts else None,
            "doi": it.get("DOI"),
            "url": it.get("URL") or (f"https://doi.org/{it['DOI']}" if it.get("DOI") else None),
            "venue": (it.get("container-title") or [None])[0],
            "abstract": _strip_tags(it.get("abstract")),
            "provider": "crossref",
        })
    return out


def search_semantic_scholar(ctx, query, limit, year_from):
    params = {"query": query, "limit": str(limit), "fields": "title,authors,year,abstract,externalIds,url,venue"}
    if year_from:
        params["year"] = f"{year_from}-"
    url = "https://api.semanticscholar.org/graph/v1/paper/search?" + urllib.parse.urlencode(params)
    res = ctx.fetch("semantic-scholar-api", {"url": url, "method": "GET"})
    if res["status"] >= 400:
        raise RuntimeError(f"semantic scholar HTTP {res['status']}")
    out = []
    for it in json.loads(res["body"]).get("data", []):
        if not it.get("title"):
            continue
        doi = (it.get("externalIds") or {}).get("DOI")
        out.append({
            "title": it["title"],
            "authors": [a.get("name") for a in it.get("authors", []) if a.get("name")][:8],
            "year": it.get("year"),
            "doi": doi,
            "url": it.get("url") or (f"https://doi.org/{doi}" if doi else None),
            "venue": it.get("venue"),
            "abstract": (it.get("abstract") or "").strip(),
            "provider": "semantic-scholar",
        })
    return out


def source_markdown(r, query):
    lines = [f"# {r['title']}", ""]
    if r.get("authors"):
        lines.append(f"**Authors:** {', '.join(r['authors'])}")
    meta = [x for x in (r.get("venue"), str(r["year"]) if r.get("year") else None) if x]
    if meta:
        lines.append(f"**Published:** {' · '.join(meta)}")
    if r.get("doi"):
        lines.append(f"**DOI:** [{r['doi']}](https://doi.org/{r['doi']})")
    elif r.get("url"):
        lines.append(f"**URL:** {r['url']}")
    lines += ["", "## Abstract", "", r.get("abstract") or "_No abstract available from the provider._", ""]
    lines.append(f"_Found by search-scholarly ({r['provider']}) for: {query}_")
    return "\n".join(lines)


def handler(input, ctx):
    query = (input.get("query") or "").strip()
    if not query:
        raise ValueError("query is required")
    settings = ctx.ambient.get("settings") or {}
    cap = int(settings.get("max_results") or 10)
    limit = max(1, min(cap, int(input.get("limit") or cap)))
    year_from = input.get("year_from")
    providers = settings.get("providers") or ["crossref", "semantic-scholar"]

    hits, notes = [], []
    for provider in providers:
        try:
            if provider == "crossref":
                hits = search_crossref(ctx, query, limit, year_from, settings.get("mailto") or "")
            elif provider == "semantic-scholar":
                hits = search_semantic_scholar(ctx, query, limit, year_from)
            else:
                notes.append(f"unknown provider '{provider}' skipped")
                continue
        except Exception as e:  # broker denial (missing capability) or provider error: try the next provider
            code = getattr(e, "code", type(e).__name__)
            ctx.log("warn", f"{provider} search unavailable: {code}", {"error": str(e)})
            notes.append(f"{provider} unavailable ({code})")
            continue
        if hits:
            break

    if not hits and len(notes) == len(providers):
        kws = keywords(query)
        ctx.log("warn", "no scholarly provider reachable; returning keyword-only stub", {"keywords": kws})
        return {
            "sources": [], "results": [], "degraded": True, "keywords": kws,
            "note": "Scholarly search is unavailable (" + "; ".join(notes) + "). Search the knowledge base with these keywords instead.",
        }

    sources, results = [], []
    for r in hits[:limit]:
        ref = ctx.create_artifact(
            title=r["title"][:200],
            body=source_markdown(r, query),
            tags=["intermediate", "source", f"provider:{r['provider']}"],
            scope="session",
            properties={k: r.get(k) for k in ("doi", "url", "year", "venue", "authors", "provider")},
        )
        sources.append({"uid": ref["uid"], "revision_id": ref["revision_id"]})
        results.append({"uid": ref["uid"], "title": r["title"], "year": r.get("year"), "doi": r.get("doi"), "url": r.get("url"), "provider": r["provider"]})
    ctx.log("info", f"created {len(sources)} source artifact(s)", {"query": query})
    out = {"sources": sources, "results": results, "degraded": False, "keywords": keywords(query)}
    if notes:
        out["note"] = "; ".join(notes)
    if ctx.ambient.get("invocation") == "code-step":
        return {"exit": "found" if sources else "none", "output": out}
    return out
