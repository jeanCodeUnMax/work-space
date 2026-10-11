"""Everything-style search syntax -> SQL predicates over the index.

Supported subset (Everything-compatible where it overlaps):
  terms            AND of case-insensitive name substrings ("" = exact phrase)
  a|b              OR
  !term            NOT
  * ?              wildcards
  ext:a;b          extension list
  audio:/video:/document:/executable:/picture:/compressed:
                   Everything filter categories
  size:<op><n>[b|kb|mb|gb|pb]   > < >= <= = or range a..b ; buckets:
                   empty tiny small medium large huge giant
  dm:/dc:/da:      date: today yesterday thisweek thismonth thisyear
                   YYYY YYYY-MM YYYY-MM-DD, > < >= <= , a..b
  path:            substring of the parent directory
  parent:          substring of the immediate parent directory
  matchpath:       bare terms match the full display path
  regex:<re>       Python regex on the full display path
  case:            case-sensitive matching for bare terms
  ww:/wholeword:   whole-word match on the name
  startwith:/endwith:  name prefix / suffix
  folder:/type:dir only directories ; file:/type:file only files
  dupe:            unsupported (needs MFT size; use size:0 or fs tools)
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from categories import CATEGORY_ALIASES, extensions_for

_SIZE_UNITS = {
    "b": 1, "kb": 1024, "mb": 1024**2, "gb": 1024**3, "pb": 1024**4,
    "k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4,
}

_SIZE_BUCKETS = {
    "empty": ("=", 0),
    "tiny": ("..", 0, 10 * 1024),
    "small": ("..", 10 * 1024, 100 * 1024),
    "medium": ("..", 100 * 1024, 1024**2),
    "large": ("..", 1024**2, 16 * 1024**2),
    "huge": ("..", 16 * 1024**2, 128 * 1024**2),
    "giant": (">", 128 * 1024**2),
}


@dataclass
class ParsedQuery:
    where: str = "1=1"
    params: list = field(default_factory=list)
    regex_filters: list[re.Pattern] = field(default_factory=list)
    error: str | None = None
    needs_stat: bool = False          # True when size filter present


def _like(term: str) -> str:
    """Everything wildcard term -> SQL LIKE pattern (% _)."""
    out = []
    for ch in term:
        if ch == "*":
            out.append("%")
        elif ch == "?":
            out.append("_")
        elif ch in "%_":
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out)


def _tokens(text: str) -> list[str]:
    """Split on whitespace, keeping double-quoted phrases."""
    return [a or b for a, b in re.findall(r'"([^"]*)"|(\S+)', text)]


def _size_clause(expr: str):
    """Return (sql_fragment, needs_stat) — size is not in the index; handled
    via stat of candidate rows, so we return a Python-side predicate instead."""
    return None  # sizes are post-filters


def _parse_size(expr: str):
    """Parse size expression -> (min_bytes, max_bytes) inclusive bounds."""
    expr = expr.strip().lower()
    if expr in _SIZE_BUCKETS:
        b = _SIZE_BUCKETS[expr]
        if b[0] == "=":
            return (b[1], b[1])
        if b[0] == ">":
            return (b[1] + 1, None)
        return (b[1], b[2])
    m = re.match(r"^(>=|<=|>|<)?(\d+(?:\.\d+)?)([a-z]{0,3})$", expr)
    if m:
        op, num, unit = m.group(1) or "", float(m.group(2)), _SIZE_UNITS.get(m.group(3), 1)
        n = num * unit
        if op == ">":
            return (int(n) + 1, None)
        if op == ">=":
            return (int(n), None)
        if op == "<":
            return (0, int(n) - 1)
        if op == "<=":
            return (0, int(n))
        return (int(n), int(n))
    m = re.match(r"^(\d+(?:\.\d+)?)([a-z]{0,3})\.\.(\d+(?:\.\d+)?)([a-z]{0,3})$", expr)
    if m:
        lo = float(m.group(1)) * _SIZE_UNITS.get(m.group(2), 1)
        hi = float(m.group(3)) * _SIZE_UNITS.get(m.group(4), 1)
        return (int(lo), int(hi))
    m = re.match(r"^(\d+(?:\.\d+)?)\.\.([a-z]{0,3})$", expr)
    if m:  # e.g. 1mb..
        lo = float(m.group(1)) * _SIZE_UNITS.get(m.group(2), 1)
        return (int(lo), None)
    return None


def _date_bound(expr: str) -> float | None:
    """Relative day name or YYYY[-MM[-DD]] -> epoch seconds (start of unit)."""
    now = time.time()
    e = expr.lower()
    lt = time.localtime(now)
    day0 = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    if e in ("today",):
        return day0
    if e in ("yesterday",):
        return day0 - 86400
    if e in ("thisweek", "lastweek"):
        return day0 - lt.tm_wday * 86400 - (7 * 86400 if e == "lastweek" else 0)
    if e in ("thismonth", "lastmonth"):
        y, m = lt.tm_year, lt.tm_mon - (1 if e == "lastmonth" else 0)
        if m == 0:
            y, m = y - 1, 12
        return time.mktime((y, m, 1, 0, 0, 0, 0, 0, -1))
    if e in ("thisyear", "lastyear"):
        return time.mktime((lt.tm_year - (e == "lastyear"), 1, 1, 0, 0, 0, 0, 0, -1))
    m = re.match(r"^(\d{4})(?:[-/](\d{1,2}))?(?:[-/](\d{1,2}))?$", e)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2) or 1), int(m.group(3) or 1)
        try:
            return time.mktime((y, mo, d, 0, 0, 0, 0, 0, -1))
        except (ValueError, OverflowError):
            return None
    return None


def _date_period_end(bound: float, expr: str) -> float:
    """End of the period that 'bound' starts (for exact YYYY/YYYY-MM matches)."""
    lt = time.localtime(bound)
    e = expr.lower()
    if re.match(r"^\d{4}$", e):
        return time.mktime((lt.tm_year + 1, 1, 1, 0, 0, 0, 0, 0, -1))
    if re.match(r"^\d{4}[-/]\d{1,2}$", e):
        y, mo = lt.tm_year, lt.tm_mon + 1
        if mo > 12:
            y, mo = y + 1, 1
        return time.mktime((y, mo, 1, 0, 0, 0, 0, 0, -1))
    return bound + 86400  # day resolution


def parse(text: str) -> ParsedQuery:
    pq = ParsedQuery()
    clauses, post_or = [], []
    case = False
    match_path = False
    # first pass: global modifiers that affect term handling
    for raw in _tokens(text):
        if ":" in raw:
            key = raw.split(":", 1)[0].lower()
            if key == "case":
                case = True
            elif key == "matchpath":
                match_path = True

    name_col = "name"
    collate = "" if case else "COLLATE NOCASE"

    for raw in _tokens(text):
        neg = raw.startswith("!")
        tok = raw[1:] if neg else raw
        if not tok:
            continue
        clause = None
        if ":" in tok:
            key, _, val = tok.partition(":")
            key, val = key.lower(), val
            kl = key.lstrip("no")
            if key in CATEGORY_ALIASES or kl in CATEGORY_ALIASES and key.startswith("no"):
                exts = extensions_for(key if key in CATEGORY_ALIASES else kl)
                if exts:
                    clause = "ext IN (" + ",".join("?" * len(exts)) + ")"
                    pq.params.extend(exts)
            elif key == "ext":
                exts = [x.lstrip(".").lower() for x in val.split(";") if x]
                if exts:
                    clause = "ext IN (" + ",".join("?" * len(exts)) + ")"
                    pq.params.extend(exts)
            elif key in ("size", "dm", "dc", "da", "dates", "datecreated", "dateaccessed", "datemodified"):
                if key == "size":
                    bounds = _parse_size(val)
                    if bounds is None:
                        pq.error = f"invalid size expression: {val!r}"
                        continue
                    pq.needs_stat = True
                    # stored as post-filter marker
                    clause = "1=1"
                    post_or.append(("size", bounds))
                else:
                    op = ""
                    v = val
                    for p in (">=", "<=", ">", "<"):
                        if v.startswith(p):
                            op, v = p, v[len(p):]
                            break
                    if ".." in v:
                        lo_s, hi_s = v.split("..", 1)
                        lo = _date_bound(lo_s) if lo_s else None
                        hi = _date_bound(hi_s) if hi_s else None
                        hi = _date_period_end(hi, hi_s) if hi is not None and re.match(r"^\d{4}([-/]\d{1,2}){0,2}$", hi_s or "") else hi
                        parts, vals = [], []
                        if lo is not None:
                            parts.append("ts >= ?")
                            vals.append(lo)
                        if hi is not None:
                            parts.append("ts < ?")
                            vals.append(hi)
                        clause = "(" + " AND ".join(parts) + ")" if parts else "1=1"
                        pq.params.extend(vals)
                    else:
                        b = _date_bound(v)
                        if b is None:
                            pq.error = f"invalid date expression: {val!r}"
                            continue
                        if op in (">", ">="):
                            clause = "ts >= ?"
                            pq.params.append(b if op == ">=" else b + 1)
                        elif op in ("<", "<="):
                            clause = "ts < ?"
                            pq.params.append(b)
                        else:
                            end = _date_period_end(b, v)
                            clause = "(ts >= ? AND ts < ?)"
                            pq.params.extend([b, end])
            elif key in ("path", "parent", "parentpath"):
                clause = "path LIKE ? ESCAPE '\\' " + collate
                pq.params.append("%" + _like(val) + "%")
            elif key == "matchpath":
                pass
            elif key == "regex":
                try:
                    pq.regex_filters.append(re.compile(val, 0 if case else re.IGNORECASE))
                except re.error as e:
                    pq.error = f"invalid regex {val!r}: {e}"
            elif key == "ww" or key == "wholeword":
                try:
                    pq.regex_filters.append(re.compile(r"\b" + re.escape(val) + r"\b", 0 if case else re.IGNORECASE))
                except re.error:
                    pass
            elif key == "startwith":
                clause = "name LIKE ? ESCAPE '\\' " + collate
                pq.params.append(_like(val) + "%")
            elif key == "endwith":
                clause = "name LIKE ? ESCAPE '\\' " + collate
                pq.params.append("%" + _like(val))
            elif key in ("folder", "type") and (key == "folder" or val in ("dir", "folder")):
                clause = "dir = 1"
            elif key == "file" or (key == "type" and val == "file"):
                clause = "dir = 0"
            elif key in ("dupe", "sizedupe", "content", "attrib", "attributes"):
                pq.error = f"modifier '{key}:' is not supported by this index"
            else:
                # unknown key: treat literally as name term
                clause = "name LIKE ? ESCAPE '\\' " + collate
                pq.params.append("%" + _like(tok) + "%")
        else:
            col = "vol || '\\' || path" if match_path else "name"
            clause = col + " LIKE ? ESCAPE '\\' " + collate
            # A term containing * or ? is a full pattern (anchored both ends,
            # Everything semantics). Otherwise it is a substring match.
            def _pat(term: str) -> str:
                if "*" in term or "?" in term:
                    return _like(term)
                return "%" + _like(term) + "%"

            if "|" in tok:
                parts = [p for p in tok.split("|") if p]
                if len(parts) > 1:
                    subs = " OR ".join(
                        [col + " LIKE ? ESCAPE '\\' " + collate] * len(parts)
                    )
                    clause = f"({subs})"
                    for p in parts:
                        pq.params.append(_pat(p))
                else:
                    pq.params.append(_pat(tok))
            else:
                pq.params.append(_pat(tok))
        if clause:
            clauses.append(("NOT " if neg else "") + clause)

    size_bounds = [b for k, b in post_or if k == "size"]
    pq.size_bounds = size_bounds  # type: ignore[attr-defined]
    pq.where = " AND ".join(clauses) if clauses else "1=1"
    return pq


def display_path(vol: str, path: str) -> str:
    return vol + "\\" + path if path else vol
