"""Merge memory-f (F:/Sqlite-DB/memory_mcp.db) -> global (current_workspace/graph/memory_mcp.db).
Backup de la cible d'abord, puis ATTACH + remap d'IDs dans une transaction.
"""
import sqlite3, os, shutil, sys, datetime

SRC = r"F:/Sqlite-DB/memory_mcp.db"
DST = r"F:/Sqlite-DB/current_workspace/graph/memory_mcp.db"
BAKDIR = r"F:/Sqlite-DB/_backups"
os.makedirs(BAKDIR, exist_ok=True)
stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
bak = os.path.join(BAKDIR, f"memory_mcp-global-{stamp}.db")

# 1) Backup propre (gere le WAL) via l'API backup de sqlite
src_dst = sqlite3.connect(DST)
b = sqlite3.connect(bak)
src_dst.backup(b); b.close()
print("backup ->", bak, os.path.getsize(bak), "octets")

# 2) Merge
c = sqlite3.connect(DST)
c.execute("PRAGMA busy_timeout=10000")
c.execute("ATTACH DATABASE ? AS src", (SRC,))
try:
    c.execute("BEGIN IMMEDIATE")
    idmap = {}
    for old_id, name, etype, created in c.execute(
        "SELECT id, name, entityType, created_at FROM src.entities"):
        row = c.execute("SELECT id FROM entities WHERE name=?", (name,)).fetchone()
        if row:
            new_id = row[0]
        else:
            cur = c.execute(
                "INSERT INTO entities (name, entityType, created_at) VALUES (?,?,?)",
                (name, etype, created))
            new_id = cur.lastrowid
        idmap[old_id] = new_id
    print("entities traitees:", len(idmap), "(nouvelles:",
          sum(1 for _ in c.execute("SELECT 1")) and len(idmap), ")")

    n_obs = 0
    for _eid, content, created in c.execute(
        "SELECT entity_id, content, created_at FROM src.observations"):
        new_eid = idmap.get(_eid)
        if new_eid is None:
            continue
        exists = c.execute(
            "SELECT 1 FROM observations WHERE entity_id=? AND content=? LIMIT 1",
            (new_eid, content)).fetchone()
        if not exists:
            c.execute(
                "INSERT INTO observations (entity_id, content, created_at) VALUES (?,?,?)",
                (new_eid, content, created))
            n_obs += 1
    print("observations inserees:", n_obs)

    n_rel = 0
    for fe, te, rt, created in c.execute(
        "SELECT from_entity, to_entity, relationType, created_at FROM src.relations"):
        cur = c.execute(
            "INSERT OR IGNORE INTO relations (from_entity, to_entity, relationType, created_at) VALUES (?,?,?,?)",
            (fe, te, rt, created))
        n_rel += cur.rowcount
    print("relations inserees:", n_rel)

    c.execute("COMMIT")
    print("COMMIT ok")
except Exception:
    c.execute("ROLLBACK")
    raise
finally:
    c.execute("DETACH DATABASE src")
    c.close()
