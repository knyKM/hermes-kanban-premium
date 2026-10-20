"""Kanban Premium — rotas somente leitura em /api/plugins/kanban-premium/.

Complementa o plugin Kanban nativo com o que o board não mostra:

* ``GET /cards?ids=t_a,t_b&board=x``  profile + modelo/provider de cada card
  (modelo real da sessão do worker quando existe; senão override do card;
  senão o modelo configurado no profile).
* ``GET /tasks/{id}/activity?board=x&run=N``  sessão do worker: retornos do
  chat (mensagens do assistente + chamadas de ferramenta resumidas) e arquivos
  modificados (write_file/patch, artefatos declarados no complete, git status
  do worktree e arquivos gerados no workspace).

Nada aqui escreve em banco: kanban.db e state.db são abertos em ``mode=ro``.
Todo texto que sai passa por ``agent.redact.redact_sensitive_text(force=True)``.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import time
from contextlib import closing
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query

router = APIRouter()

_ID_RE = re.compile(r"^t_[0-9a-f]{4,32}$")
_PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_SESSION_LINE = re.compile(r"^\s*Session:\s*(\S+)", re.M)

_MAX_TEXT = 6000        # por mensagem do assistente
_MAX_TOOL_OUT = 1200    # prévia do retorno de ferramenta
_MAX_ITEMS = 400        # itens de timeline por resposta
_FILE_TOOLS = {"write_file", "patch", "edit_file", "str_replace_editor", "create_file"}


# --------------------------------------------------------------- helpers

def _redact(text: Any) -> str:
    s = "" if text is None else str(text)
    try:
        from agent.redact import redact_sensitive_text
        return redact_sensitive_text(s, force=True)
    except Exception:
        return s


def _clip(s: str, n: int) -> str:
    s = s or ""
    return s if len(s) <= n else s[:n] + f"\n… (+{len(s) - n} caracteres)"


def _root() -> Path:
    from hermes_cli import kanban_db
    return kanban_db.kanban_home()


def _hermes_root() -> Path:
    from hermes_constants import get_default_hermes_root
    return get_default_hermes_root()


def _ro(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"{Path(path).as_uri()}?mode=ro", uri=True, timeout=3)
    conn.row_factory = sqlite3.Row
    return conn


def _board_db(slug: str) -> Path:
    from hermes_cli import kanban_db
    return kanban_db.kanban_db_path(board=slug)


def _boards(preferred: Optional[str]) -> list[str]:
    from hermes_cli import kanban_db
    from hermes_cli.kanban_db_boards import list_boards
    slugs = []
    if preferred:
        try:
            slugs.append(kanban_db._normalize_board_slug(preferred) or kanban_db.DEFAULT_BOARD)
        except ValueError:
            raise HTTPException(status_code=400, detail="board inválido")
    for b in list_boards(include_archived=False):
        s = b.get("slug") or b.get("name")
        if s and s not in slugs:
            slugs.append(s)
    return slugs


def _find_board(task_id: str, preferred: Optional[str]) -> str:
    for slug in _boards(preferred):
        db = _board_db(slug)
        if not db.exists():
            continue
        with closing(_ro(db)) as c:
            if c.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                return slug
    raise HTTPException(status_code=404, detail=f"task {task_id} não encontrada")


def _state_db(profile: Optional[str]) -> Optional[Path]:
    if not profile or not _PROFILE_RE.match(profile):
        return None
    root = _hermes_root()
    p = root / "state.db" if profile == "default" else root / "profiles" / profile / "state.db"
    return p if p.exists() else None


_PROFILE_CACHE: dict[str, Any] = {"at": 0.0, "data": {}}


def _profile_models() -> dict[str, dict]:
    now = time.time()
    if now - _PROFILE_CACHE["at"] < 30:
        return _PROFILE_CACHE["data"]
    data: dict[str, dict] = {}
    try:
        from hermes_cli import profiles as profiles_mod
        for p in profiles_mod.list_profiles(lazy_skill_count=True):
            data[p.name] = {"model": p.model or "", "provider": p.provider or ""}
    except Exception:
        pass
    _PROFILE_CACHE.update(at=now, data=data)
    return data


def _run_meta(raw: Optional[str]) -> dict:
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def _log_session(slug: str, task_id: str) -> Optional[str]:
    try:
        from hermes_cli import kanban_db
        p = kanban_db.worker_log_path(task_id, board=slug)
        if not p.exists():
            return None
        with open(p, "rb") as f:
            head = f.read(600).decode("utf-8", "replace")
        m = _SESSION_LINE.search(head)
        return m.group(1) if m else None
    except Exception:
        return None


def _runs(conn: sqlite3.Connection, task_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT id, profile, status, outcome, started_at, ended_at, summary, metadata, error "
        "FROM task_runs WHERE task_id=? ORDER BY id", (task_id,)).fetchall()
    return [dict(r) for r in rows]


def _session_id_for(slug: str, task: sqlite3.Row, run: Optional[dict], is_latest: bool) -> Optional[str]:
    if run:
        sid = _run_meta(run.get("metadata")).get("worker_session_id")
        if sid:
            return str(sid)
    if is_latest:
        if task["session_id"]:
            return str(task["session_id"])
        return _log_session(slug, task["id"])
    return None


def _session_row(profile: Optional[str], sid: Optional[str]) -> Optional[dict]:
    db = _state_db(profile)
    if not db or not sid:
        return None
    with closing(_ro(db)) as c:
        r = c.execute(
            "SELECT id, model, billing_provider, started_at, ended_at, message_count, tool_call_count, "
            "input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, estimated_cost_usd, "
            "actual_cost_usd, cwd, title, last_activity_at FROM sessions WHERE id=?", (sid,)).fetchone()
        return dict(r) if r else None


# ---------------------------------------------------------------- /cards

@router.get("/cards")
def cards(ids: str = Query(..., max_length=6000), board: Optional[str] = Query(None)):
    want = [i for i in (x.strip() for x in ids.split(",")) if _ID_RE.match(i)][:300]
    if not want:
        return {"cards": {}}
    prof = _profile_models()
    out: dict[str, dict] = {}
    remaining = set(want)
    for slug in _boards(board):
        if not remaining:
            break
        db = _board_db(slug)
        if not db.exists():
            continue
        with closing(_ro(db)) as c:
            q = ",".join("?" * len(remaining))
            tasks = c.execute(
                f"SELECT id, assignee, status, model_override, provider_override, session_id "
                f"FROM tasks WHERE id IN ({q})", tuple(remaining)).fetchall()
            for t in tasks:
                remaining.discard(t["id"])
                run = c.execute(
                    "SELECT id, profile, status, outcome, ended_at, metadata FROM task_runs "
                    "WHERE task_id=? ORDER BY id DESC LIMIT 1", (t["id"],)).fetchone()
                run = dict(run) if run else None
                profile = (run or {}).get("profile") or t["assignee"]
                info = {"board": slug, "profile": profile or "", "status": t["status"],
                        "model": "", "provider": "", "source": "", "live": False}
                sid = _session_id_for(slug, t, run, True) if run else None
                sess = None
                try:
                    sess = _session_row(profile, sid)
                except Exception:
                    sess = None
                if sess and sess.get("model"):
                    info.update(model=sess["model"], provider=sess.get("billing_provider") or "", source="session")
                elif t["model_override"]:
                    info.update(model=t["model_override"], provider=t["provider_override"] or "", source="override")
                elif profile and profile in prof:
                    info.update(model=prof[profile]["model"], provider=prof[profile]["provider"], source="profile")
                info["live"] = bool(run and run.get("ended_at") is None and t["status"] == "running")
                out[t["id"]] = info
    return {"cards": out}


# ------------------------------------------------------------- /activity

def _tool_output(raw: str) -> tuple[str, bool]:
    """Texto legível do retorno de ferramenta + flag de sucesso."""
    raw = raw or ""
    ok = True
    try:
        v = json.loads(raw)
    except Exception:
        return raw, ok
    if isinstance(v, dict):
        if v.get("success") is False or v.get("status") == "error" or (v.get("error") and not v.get("output")):
            ok = False
        if isinstance(v.get("exit_code"), int) and v["exit_code"] != 0:
            ok = False
        for k in ("output", "content", "result", "diff", "error", "message"):
            if isinstance(v.get(k), str) and v[k].strip():
                return v[k], ok
    return json.dumps(v, ensure_ascii=False, indent=1), ok


def _tool_label(name: str, args: dict) -> str:
    for k in ("path", "file_path", "filename", "url", "query", "pattern", "command", "code", "task_id", "title", "name"):
        v = args.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip().splitlines()[0][:220]
    return ""


def _patch_paths(args: dict) -> list[str]:
    paths = []
    p = args.get("path") or args.get("file_path")
    if isinstance(p, str) and p:
        paths.append(p)
    body = args.get("patch") or args.get("input") or ""
    if isinstance(body, str):
        for m in re.finditer(r"^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$", body, re.M):
            paths.append(m.group(1).strip())
    return paths


def _norm_path(p: str, cwd: Optional[str]) -> str:
    p = p.strip().strip('"').strip("'")
    m = re.match(r"^/([a-zA-Z])/(.*)$", p)  # /c/Users/... (git-bash)
    if m:
        p = f"{m.group(1).upper()}:/{m.group(2)}"
    if cwd and not re.match(r"^([a-zA-Z]:[\\/]|/|\\\\)", p):
        p = str(Path(cwd) / p)
    return p.replace("\\", "/")


def _file_entry(files: dict, path: str, action: str, ts: Optional[float], source: str):
    key = path.lower() if os.name == "nt" else path
    e = files.get(key)
    if not e:
        e = files[key] = {"path": path, "actions": [], "count": 0, "first_at": ts, "last_at": ts, "sources": []}
    if action not in e["actions"]:
        e["actions"].append(action)
    if source not in e["sources"]:
        e["sources"].append(source)
    e["count"] += 1
    if ts:
        e["last_at"] = max(e["last_at"] or ts, ts)
        e["first_at"] = min(e["first_at"] or ts, ts)


def _git_changes(path: Optional[str]) -> list[tuple[str, str]]:
    if not path or not Path(path).is_dir():
        return []
    try:
        r = subprocess.run(["git", "-C", path, "status", "--porcelain=v1", "-uall"],
                           capture_output=True, text=True, timeout=5,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if r.returncode != 0:
            return []
        out = []
        for line in r.stdout.splitlines()[:300]:
            code, rel = line[:2], line[3:].strip()
            if " -> " in rel:
                rel = rel.split(" -> ", 1)[1]
            action = {"??": "criado", "A": "criado", "D": "removido", "R": "renomeado"}.get(
                code.strip()[:2] if code.strip() == "??" else code.strip()[:1], "editado")
            out.append((str(Path(path) / rel), action))
        return out
    except Exception:
        return []


def _workspace_files(path: Optional[str], since: Optional[float]) -> list[tuple[str, float]]:
    if not path or not Path(path).is_dir():
        return []
    out = []
    try:
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__", ".venv", "venv")]
            for f in files:
                fp = Path(root) / f
                try:
                    mt = fp.stat().st_mtime
                except OSError:
                    continue
                if since is None or mt >= since - 5:
                    out.append((str(fp), mt))
                if len(out) >= 200:
                    return out
    except Exception:
        pass
    return out


@router.get("/tasks/{task_id}/activity")
def activity(task_id: str, board: Optional[str] = Query(None), run: Optional[int] = Query(None, ge=1),
             after: int = Query(0, ge=0)):
    if not _ID_RE.match(task_id):
        raise HTTPException(status_code=400, detail="id inválido")
    slug = _find_board(task_id, board)
    with closing(_ro(_board_db(slug))) as c:
        task = c.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        runs = _runs(c, task_id)

    chosen = None
    if runs:
        chosen = next((r for r in runs if r["id"] == run), None) if run else runs[-1]
        if chosen is None:
            raise HTTPException(status_code=404, detail=f"run {run} não encontrada")
    is_latest = bool(chosen is None or chosen is runs[-1])
    profile = (chosen or {}).get("profile") or task["assignee"]
    sid = _session_id_for(slug, task, chosen, is_latest) if chosen else None

    prof = _profile_models()
    session = None
    try:
        session = _session_row(profile, sid)
    except Exception:
        session = None
    model = (session or {}).get("model") or task["model_override"] or (prof.get(profile or "", {}).get("model", ""))
    provider = (session or {}).get("billing_provider") or task["provider_override"] or (prof.get(profile or "", {}).get("provider", ""))

    items: list[dict] = []
    files: dict[str, dict] = {}
    cwd = (session or {}).get("cwd") or task["workspace_path"]
    last_id = after
    db = _state_db(profile)
    if session and db:
        with closing(_ro(db)) as s:
            rows = s.execute(
                "SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason "
                "FROM messages WHERE session_id=? ORDER BY id", (sid,)).fetchall()
        results: dict[str, dict] = {}
        for r in rows:
            if r["role"] == "tool" and r["tool_call_id"]:
                results[r["tool_call_id"]] = dict(r)
        for r in rows:
            last_id = max(last_id, r["id"])
            ts = r["timestamp"]
            if r["role"] == "assistant":
                text = (r["content"] or "").strip()
                calls = []
                if r["tool_calls"]:
                    try:
                        calls = json.loads(r["tool_calls"]) or []
                    except Exception:
                        calls = []
                if text and r["id"] > after:
                    items.append({"id": r["id"], "kind": "assistant", "ts": ts, "text": _redact(_clip(text, _MAX_TEXT)),
                                  "final": not calls})
                for n, tc in enumerate(calls):
                    fn = (tc or {}).get("function") or {}
                    name = fn.get("name") or "tool"
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except Exception:
                        args = {}
                    if not isinstance(args, dict):
                        args = {}
                    res = results.get(tc.get("id") or "")
                    out, ok = _tool_output((res or {}).get("content") or "")
                    if name in _FILE_TOOLS and ok:
                        for pth in (_patch_paths(args) if name != "write_file" else [args.get("path") or ""]):
                            if pth:
                                _file_entry(files, _norm_path(pth, cwd), "patch" if name == "patch" else "escrita", ts, "ferramenta")
                    if r["id"] > after:
                        items.append({"id": f"{r['id']}.{n}", "kind": "tool", "name": name, "ts": ts, "ok": ok,
                                      "label": _redact(_tool_label(name, args)),
                                      "output": _redact(_clip(out, _MAX_TOOL_OUT))})
            elif r["role"] == "user" and r["id"] > after:
                items.append({"id": r["id"], "kind": "user", "ts": ts,
                              "text": _redact(_clip((r["content"] or "").strip(), 1500))})
        if len(items) > _MAX_ITEMS:
            items = items[-_MAX_ITEMS:]

    meta = _run_meta((chosen or {}).get("metadata"))
    for a in meta.get("artifacts") or []:
        if isinstance(a, str) and a.strip():
            _file_entry(files, _norm_path(a.replace("\\\\", "\\"), cwd), "artefato", None, "complete")
    for pth, action in _git_changes(task["workspace_path"]):
        _file_entry(files, _norm_path(pth, None), action, None, "git")
    since = (chosen or {}).get("started_at")
    for pth, mt in _workspace_files(task["workspace_path"], since):
        _file_entry(files, _norm_path(pth, None), "workspace", mt, "workspace")

    file_list = []
    ws = (task["workspace_path"] or "").replace("\\", "/").lower()
    for e in files.values():
        p = Path(e["path"])
        try:
            st = p.stat()
            e["exists"], e["size"] = True, st.st_size
        except OSError:
            e["exists"], e["size"] = False, None
        e["in_workspace"] = bool(ws) and e["path"].lower().startswith(ws)
        e["path"] = _redact(e["path"])
        file_list.append(e)
    file_list.sort(key=lambda e: (e["in_workspace"], -(e["last_at"] or 0)))

    live = bool(chosen and chosen.get("ended_at") is None and task["status"] == "running")
    return {
        "task_id": task_id, "board": slug, "status": task["status"],
        "profile": profile or "", "model": model or "", "provider": provider or "",
        "live": live,
        "run": ({k: chosen.get(k) for k in ("id", "profile", "status", "outcome", "started_at", "ended_at", "error")}
                | {"summary": _redact(chosen.get("summary") or "")}) if chosen else None,
        "runs": [{"id": r["id"], "profile": r["profile"], "outcome": r["outcome"], "started_at": r["started_at"],
                  "ended_at": r["ended_at"]} for r in runs],
        "session": ({k: session.get(k) for k in ("id", "started_at", "ended_at", "message_count", "tool_call_count",
                                                  "input_tokens", "output_tokens", "cache_read_tokens",
                                                  "reasoning_tokens", "estimated_cost_usd", "actual_cost_usd",
                                                  "last_activity_at")} if session else None),
        "session_hint": None if session else ("sem execução ainda" if not runs else "sessão do worker não encontrada"),
        "items": items, "cursor": last_id, "incremental": after > 0,
        "files": file_list,
        "workspace": task["workspace_path"] or "",
    }
