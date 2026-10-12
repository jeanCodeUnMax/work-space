"""Purge les entites 'workspace:acp-backup' + ses fichiers 'contains' des deux stores.
Garde : un file:<sha> peut etre partage par un autre workspace (meme contenu) -> on ne
supprime que les entites non referencees par un autre workspace. Backup avant.
"""
import sqlite3, os, datetime

DBS = [
    r"F:/Sqlite-DB/current_workspace/agentmemory/graph/memory_mcp.db",
    r"F:/Sqlite-DB/current_workspace/graph/memory_mcp.db",
]
BAKDIR = r"F:/Sqlite-DB/_backups"
os.makedirs(BAKDIR, exist_ok=True)
WS = "workspace:acp-backup"

for db_path in DBS:
    print("==", db_path)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = os.path.join(BAKDIR, os.path.basename(os.path.dirname(os.path.dirname(db_path)))
                       + "-prepurge-" + stamp + ".db")
    src = sqlite3.connect(db_path)
    b = sqlite3.connect(bak); src.backup(b); b.close()
    print("  backup ->", bak)

    c = sqlite3.connect(db_path)
    c.execute("PRAGMA busy_timeout=15000")
    try:
        c.execute("BEGIN IMMEDIATE")
        # file entities portees par acp-backup
        files = [r[0] for r in c.execute(
            "SELECT to_entity FROM relations WHERE from_entity=? AND relationType='contains'",
            (WS,))]
        # ne garder que celles non partagees par un autre workspace:*
        shared = {r[0] for r in c.execute(
            "SELECT DISTINCT to_entity FROM relations WHERE relationType='contains' AND from_entity != ? AND from_entity LIKE 'workspace:%'",
            (WS,))}
        to_del = [f for f in files if f not in shared]
        print(f"  files acp={len(files)} partages={len(files)-len(to_del)} a_suppr={len(to_del)}")

        n_obs = 0
        for name in to_del:
            n_obs += c.execute(
                "DELETE FROM observations WHERE entity_id=(SELECT id FROM entities WHERE name=?)",
                (name,)).rowcount
            c.execute("DELETE FROM relations WHERE from_entity=? OR to_entity=?", (name, name))
            c.execute("DELETE FROM entities WHERE name=?", (name,))
        # le workspace entity lui-meme
        c.execute("DELETE FROM relations WHERE from_entity=? OR to_entity=?", (WS, WS))
        c.execute("DELETE FROM observations WHERE entity_id=(SELECT id FROM entities WHERE name=?)", (WS,))
        c.execute("DELETE FROM entities WHERE name=?", (WS,))
        c.execute("COMMIT")
        print(f"  purge ok : {len(to_del)} entites file + workspace, {n_obs} observations")
    except Exception as e:
        c.execute("ROLLBACK"); print("  ROLLBACK:", e); raise
    finally:
        c.close()
