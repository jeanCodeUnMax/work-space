"""
Pipeline Module - Orchestration complète du système RAG

Ce module implémente le pipeline principal qui coordonne tous les
composants RAG: chunking, tagging, routing, embedding et fusion.

Classes:
    - RAGPipeline: Pipeline principal d'indexation et recherche
"""

from typing import List, Dict, Any, Optional, Iterable, Tuple
from pathlib import Path
import json
import asyncio
import fnmatch
import argparse
import hashlib
import re
import sys

# Support exécution en script direct (python pipeline.py) sans package.
try:
    from .chunker import Chunker, Chunk, ChunkType
    from .tagger import Tagger, Tag, TagCategory
    from .router import Router, RoutingDecision, StoreTarget
    from .embedder import EmbedderManager
    from .fusion import FusionEngine, SearchResult
    from .utils.env_loader import merge_config_with_env, get_workspace_root
except ImportError:  # pragma: no cover - fallback script
    base_dir = Path(__file__).resolve().parent
    if str(base_dir) not in sys.path:
        sys.path.insert(0, str(base_dir))
    from chunker import Chunker, Chunk, ChunkType
    from tagger import Tagger, Tag, TagCategory
    from router import Router, RoutingDecision, StoreTarget
    from embedder import EmbedderManager
    from fusion import FusionEngine, SearchResult
    from utils.env_loader import merge_config_with_env, get_workspace_root


class RagIgnore:
    """
    Matcher .ragignore — sous-ensemble de la syntaxe gitignore.

    Supporte : commentaires (#), negation (!), ancrage racine (/motif),
    motif basename sans '/', dossiers ('motif/'), '*'/'?' intra-segment,
    '**' inter-segments. Derniere regle qui matche l'emporte.
    """

    # Filet de securite NON negociable : jamais indexable, meme si
    # .ragignore contiendrait une negation.
    SAFETY_PATTERNS: Tuple[str, ...] = (
        ".git/",
        ".env",
        ".env.*",
        "*.key",
        "*.pem",
        "*.pfx",
        "*.db",
        "*.db-shm",
        "*.db-wal",
        ".venv/",
        "venv/",
        "node_modules/",
        "__pycache__/",
        "memory-database/",
    )

    def __init__(self, lines: Iterable[str] = ()):
        self.rules: List[Tuple[bool, "re.Pattern"]] = []
        for raw in lines:
            rule = self._compile(raw)
            if rule:
                self.rules.append(rule)

    @staticmethod
    def _compile(line: str) -> Optional[Tuple[bool, "re.Pattern"]]:
        line = line.strip()
        if not line or line.startswith("#"):
            return None
        neg = line.startswith("!")
        if neg:
            line = line[1:].strip()
        if not line:
            return None
        dir_only = line.endswith("/")
        if dir_only:
            line = line[:-1]
        anchored = "/" in line
        line = line.lstrip("/")
        if not line:
            return None

        i, out = 0, []
        while i < len(line):
            c = line[i]
            if c == "*":
                if line[i:i + 2] == "**":
                    out.append(".*")
                    i += 2
                else:
                    out.append("[^/]*")
                    i += 1
            elif c == "?":
                out.append("[^/]")
                i += 1
            else:
                out.append(re.escape(c))
                i += 1
        body = "".join(out)
        base = f"^{body}" if anchored else f"(^|/){body}"
        return neg, re.compile(base + "(/|$)")

    @classmethod
    def load(cls, root: Path) -> "RagIgnore":
        """Charge <root>/.ragignore s'il existe."""
        f = root / ".ragignore"
        if f.exists():
            try:
                return cls(f.read_text(encoding="utf-8", errors="ignore").splitlines())
            except OSError:
                pass
        return cls()

    @classmethod
    def safety(cls) -> "RagIgnore":
        return cls(cls.SAFETY_PATTERNS)

    def match(self, relpath: str) -> bool:
        """True si relpath (posix, relatif a la racine) est exclu."""
        excluded = False
        for neg, rx in self.rules:
            if rx.search(relpath):
                excluded = not neg
        return excluded


_RAGIGNORE_CACHE: Dict[str, Tuple["RagIgnore", "RagIgnore"]] = {}


def _find_ragignore_base(path: Path) -> Path:
    """Remonte les ancetres de path jusqu'au dossier contenant .ragignore
    (semantique gitignore : le fichier s'applique a sa racine).
    Fallback : workspace root s'il contient le chemin, sinon le dossier
    de depart. NB: chemins lexicaux (absolute, pas resolve) — une jonction
    comme memory-database doit matcher ses patterns, pas sa cible."""
    d = path.absolute() if path.is_dir() else path.absolute().parent
    cur = d
    while True:
        if (cur / ".ragignore").is_file():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    try:
        ws = get_workspace_root().resolve()
        d.relative_to(ws)
        return ws
    except (ValueError, Exception):
        return d


def _ragignore_for(path: Path) -> Tuple[Path, "RagIgnore", "RagIgnore"]:
    """Retourne (base, filet_securite, regles_utilisateur) pour un chemin."""
    base = _find_ragignore_base(path)
    key = str(base)
    if key not in _RAGIGNORE_CACHE:
        _RAGIGNORE_CACHE[key] = (RagIgnore.safety(), RagIgnore.load(base))
    safety, user = _RAGIGNORE_CACHE[key]
    return base, safety, user


def path_is_ignored(file_path) -> bool:
    """True si le chemin est exclu par le filet de securite ou .ragignore."""
    p = Path(file_path).absolute()
    base, safety, user = _ragignore_for(p)
    try:
        rel = p.relative_to(base).as_posix()
    except ValueError:
        return False
    return safety.match(rel) or user.match(rel)


# ---------------------------------------------------------------------------
# Etat d'indexation — resume sur interruption + purge avant reindexation.
# Fichier runtime : .agent/rag/index-state.json (jamais commite/deploye).
# Cle = source_file canonique (relatif posix sous la racine .ragignore).
# Une entree "done" n'est ecrite qu'apres succes complet : un fichier tue
# en plein indexage garde done:false -> retraite au run suivant (et les ids
# deterministes font de la reindexation un overwrite, pas un doublon).
# ---------------------------------------------------------------------------

_INDEX_STATE_PATH = Path(__file__).resolve().parent / "index-state.json"


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _load_index_state() -> Dict[str, Any]:
    try:
        return json.loads(_INDEX_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"files": {}}


def _save_index_state(state: Dict[str, Any]) -> None:
    try:
        tmp = _INDEX_STATE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_INDEX_STATE_PATH)
    except OSError:
        pass


def _canon_source(source_file: str) -> str:
    """Cle canonique du fichier : relatif posix sous la racine .ragignore,
    sinon absolu posix (uniformise les appels dir-ingest relatif vs
    single-file absolu)."""
    p = Path(source_file)
    if not p.is_absolute():
        return p.as_posix()
    try:
        return p.absolute().relative_to(_find_ragignore_base(p)).as_posix()
    except ValueError:
        return p.absolute().as_posix()


class RAGPipeline:
    """
    Pipeline principal RAG
    
    Orchestre le flux complet d'indexation et de recherche:
    1. Chunking: Découpage intelligent du document
    2. Tagging: Attribution de tags multi-dimensionnels
    3. Routing: Détermination des stores cibles
    4. Embedding: Génération et stockage des embeddings
    5. Memory: Stockage des relations dans Memory MCP
    
    Attributes:
        config: Configuration complète
        config_path: Chemin du fichier de configuration
        chunker: Module de chunking
        tagger: Module de tagging
        router: Module de routage
        embedder: Gestionnaire d'embeddings
        fusion: Moteur de fusion
    
    Example:
        >>> pipeline = RAGPipeline()
        >>> report = await pipeline.index_file("document.md")
        >>> results = await pipeline.search("requete")
    """
    
    def __init__(self, config_path: str = None):
        """
        Initialise le pipeline RAG
        
        Args:
            config_path: Chemin vers le fichier de configuration.
                        Par défaut: .agent/rag/config.json
        """
        # Charger la configuration
        if config_path is None:
            config_path = str(Path(__file__).parent / "config.json")
        
        self.config_path = config_path
        self.config = self._load_config(config_path)
        
        # Initialiser les composants
        self.chunker = Chunker(self.config)
        self.tagger = Tagger(self.config)
        self.router = Router(self.config)
        self.embedder = EmbedderManager(self.config)
        self.fusion = FusionEngine(self.config)
        self.cache_config = (
            self.config.get("cache", {}).get("search", {"enabled": True, "max_entries": 50})
        )
        self._search_cache: Dict[str, List[SearchResult]] = {}
    
    def _load_config(self, config_path: str) -> Dict[str, Any]:
        """
        Charge la configuration depuis un fichier JSON
        
        Les variables d'environnement ont priorité sur le JSON.
        
        Args:
            config_path: Chemin du fichier
            
        Returns:
            Configuration fusionnée avec les variables d'environnement
        """
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
        except FileNotFoundError:
            print(f"Warning: Config non trouvée à {config_path}, utilisation des défauts")
            config = self._default_config()
        except json.JSONDecodeError as e:
            print(f"Warning: Erreur JSON dans config: {e}, utilisation des défauts")
            config = self._default_config()
        
        # Fusionner avec les variables d'environnement
        config = merge_config_with_env(config)
        
        return config
    
    def _default_config(self) -> Dict[str, Any]:
        """
        Retourne une configuration par défaut
        
        Returns:
            Configuration par défaut
        """
        return {
            "chunking": {
                "default_size": 300,
                "overlap_percent": 10,
                "min_chunk_size": 50,
                "max_chunk_size": 1000,
                "types": {
                    "atomic": {"min": 50, "max": 100},
                    "modular": {"min": 200, "max": 500},
                    "contextual": {"min": 500, "max": 1000},
                    "structural": {"min": 100, "max": 2000}
                }
            },
            "tagging": {
                "auto_detect": True,
                "min_confidence": 0.7,
                "max_tags_per_chunk": 10
            },
            "routing": {
                "strategy": "dual",
                "fallback": "both"
            },
            "embedding": {
                "qdrant": {"enabled": True, "dimensions": 2048, "collections": {}},
                "zvec": {"enabled": True, "dimensions": 384, "collections": {}}
            },
            "fusion": {
                "weights": {"qdrant": 0.4, "zvec": 0.4, "memory": 0.2},
                "max_results": 20,
                "min_results": 5,
                "deduplication": True
            },
            "cache": {
                "search": {"enabled": True, "max_entries": 50}
            }
        }
    
    async def ingest_workspace(
        self,
        root_path: Optional[str] = None,
        include_ext: Iterable[str] = (".md", ".txt", ".py", ".json", ".yaml", ".yml"),
        exclude_globs: Iterable[str] = (
            "**/.git/**",
            "**/.venv/**",
            "**/venv/**",
            "**/__pycache__/**",
            "**/.cursor/**",
            "**/.devin/**",
            "**/node_modules/**",
            "**/dist/**",
            "**/build/**",
            "**/coverage/**",
            "**/.kilo/**",
            "**/.next/**",
            "**/target/**",
            "**/memory-database/**",  # jonction -> F:/Sqlite-DB (les DBs ne s'indexent pas elles-memes)
        ),
    ) -> Dict[str, Any]:
        """
        Indexe récursivement les fichiers du workspace.

        Chemins strictement relatifs (aucun chemin absolu n'est construit).
        """

        root = Path(root_path) if root_path else get_workspace_root()
        report: Dict[str, Any] = {
            "status": "success",
            "files_indexed": 0,
            "files_skipped": 0,
            "errors": [],
            "details": [],
        }

        ignore_base, safety, rag = _ragignore_for(root)

        def _is_excluded(p: Path) -> bool:
            try:
                rel = p.relative_to(ignore_base).as_posix()
            except ValueError:
                rel = str(p)
            if safety.match(rel) or rag.match(rel):
                return True
            return any(fnmatch.fnmatch(rel, pattern) for pattern in exclude_globs)

        eligible = [
            p for p in root.rglob("*")
            if p.is_file()
            and p.suffix.lower() in include_ext
            and not _is_excluded(p)
        ]
        total = len(eligible)
        print(f"[*] {total} fichiers eligibles")

        istate = _load_index_state()["files"]

        for i, file_path in enumerate(eligible, 1):
            rel_path = str(file_path.relative_to(root))
            try:
                content = file_path.read_text(encoding="utf-8", errors="ignore")
                key = _canon_source(rel_path)
                entry = istate.get(key)
                if entry and entry.get("done") and entry.get("sha256") == _content_hash(content):
                    report["files_skipped"] += 1
                    if i % 100 == 0:
                        print(f"[ingest] {i}/{total} (skipped: {report['files_skipped']})")
                    continue
                doc_type = self._guess_doc_type(file_path.suffix.lower())
                res = await self.index_document(
                    content=content,
                    doc_type=doc_type,
                    source_file=rel_path,
                    metadata={"source": "workspace", "relative_path": rel_path},
                )
                report["files_indexed"] += 1
                report["details"].append({"file": rel_path, "chunks": res.get("chunks_created", 0)})
                print(f"[ingest] {i}/{total} {rel_path} ({res.get('chunks_created', 0)} chunks)")
            except Exception as e:
                report["status"] = "error" if report["files_indexed"] == 0 else "partial"
                report["errors"].append(f"{file_path}: {e}")
                print(f"[!] Erreur critique sur {file_path}: {e}")

        return report

    def _guess_doc_type(self, suffix: str) -> str:
        if suffix in {".py", ".js", ".ts", ".tsx", ".jsx"}:
            return "code"
        if suffix in {".md", ".markdown"}:
            return "markdown"
        if suffix in {".json", ".yaml", ".yml"}:
            return "json"
        return "text"

    async def index_document(
        self,
        content: str,
        doc_type: str = "text",
        source_file: Optional[str] = None,
        metadata: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        Indexe un document complet
        
        Args:
            content: Contenu du document
            doc_type: Type de document (text, code, markdown, json)
            source_file: Fichier source optionnel
            metadata: Métadonnées additionnelles
            
        Returns:
            Rapport d'indexation
        """
        report = {
            "status": "success",
            "chunks_created": 0,
            "tags_generated": 0,
            "qdrant_stored": 0,
            "zvec_stored": 0,
            "memory_relations": 0,
            "errors": [],
            "chunks": []
        }

        # Clé canonique + état d'indexation (skip si inchangé, purge si réindexation)
        if source_file:
            source_file = _canon_source(source_file)
        istate = _load_index_state()
        content_sha = _content_hash(content)
        prev = istate["files"].get(source_file) if source_file else None
        if prev and prev.get("done") and prev.get("sha256") == content_sha:
            return {**report, "status": "skipped", "reason": "unchanged",
                    "chunks_created": int(prev.get("chunks", 0))}

        try:
            if prev:
                # Réindexation : purge des anciens chunks (ids déterministes)
                await self._purge_source(source_file, int(prev.get("chunks", 0)))

            # 1. Chunking
            chunks = self.chunker.chunk_document(
                content=content,
                doc_type=doc_type,
                source_file=source_file
            )
            report["chunks_created"] = len(chunks)

            # 1b. Pré-tagging + routing pour savoir quels chunks vont dans Qdrant,
            # puis embedding groupé (un appel NIM par batch au lieu d'un par chunk)
            prepared = []
            qdrant_texts = []
            for chunk in chunks:
                tags = self.tagger.tag_chunk(chunk)
                routing = self.router.route(chunk, tags)
                prepared.append((chunk, tags, routing))
                if routing.should_index_qdrant():
                    qdrant_texts.append(chunk.content)
            qdrant_vectors = await self.embedder.qdrant.embed_batch(qdrant_texts)
            vector_by_id = {}
            v_idx = 0
            for chunk, _tags, routing in prepared:
                if routing.should_index_qdrant():
                    vector_by_id[chunk.id] = qdrant_vectors[v_idx]
                    v_idx += 1

            # 2. Traitement de chaque chunk (accumulation -> flush batch en fin de fichier)
            store_sink = {"qdrant": {}, "zvec": {}, "memory": {"entities": [], "relations": []}}
            for chunk, tags, routing in prepared:
                try:
                    chunk_report = await self._process_chunk(
                        chunk=chunk,
                        metadata=metadata,
                        tags=tags,
                        routing=routing,
                        qdrant_vector=vector_by_id.get(chunk.id),
                        store_sink=store_sink
                    )

                    report["tags_generated"] += chunk_report.get("tags_count", 0)
                    report["qdrant_stored"] += chunk_report.get("qdrant_stored", 0)
                    report["zvec_stored"] += chunk_report.get("zvec_stored", 0)
                    report["memory_relations"] += chunk_report.get("memory_relations", 0)
                    report["chunks"].append(chunk_report)

                except Exception as e:
                    report["errors"].append(f"Chunk {chunk.id}: {str(e)}")

            # 3. Flush batch : un appel HTTP par collection / par type
            for collection, items in store_sink["qdrant"].items():
                try:
                    await self.embedder.qdrant.store_batch(collection, items)
                except Exception as e:
                    report["errors"].append(f"Qdrant batch {collection}: {e}")
            for collection, docs in store_sink["zvec"].items():
                try:
                    await self.embedder.zvec.store_batch(collection, docs)
                except Exception as e:
                    report["errors"].append(f"Zvec batch {collection}: {e}")
            await self._post_memory(
                store_sink["memory"]["entities"],
                store_sink["memory"]["relations"]
            )

            # Checkpoint : fichier marqué "done" uniquement sans erreurs
            # (interruption ou erreurs partielles -> retraité au prochain run)
            if source_file and not report["errors"]:
                istate["files"][source_file] = {
                    "sha256": content_sha,
                    "chunks": len(chunks),
                    "done": True,
                }
                _save_index_state(istate)

        except Exception as e:
            report["status"] = "error"
            report["errors"].append(str(e))
        
        return report
    
    async def _process_chunk(
        self,
        chunk: Chunk,
        metadata: Optional[Dict] = None,
        tags: Optional[List[Tag]] = None,
        routing=None,
        qdrant_vector: Optional[List[float]] = None,
        store_sink: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        Traite un chunk individuel
        
        Args:
            chunk: Chunk à traiter
            metadata: Métadonnées additionnelles
            
        Returns:
            Rapport de traitement du chunk
        """
        report = {
            "chunk_id": chunk.id,
            "tags_count": 0,
            "qdrant_stored": 0,
            "zvec_stored": 0,
            "memory_relations": 0,
            "routing": None
        }
        
        # 1. Tagging (pré-calculé si fourni)
        if tags is None:
            tags = self.tagger.tag_chunk(chunk)
        report["tags_count"] = len(tags)

        # 2. Routing (pré-calculé si fourni)
        if routing is None:
            routing = self.router.route(chunk, tags)
        report["routing"] = routing.to_dict()
        
        # 3. Préparer les métadonnées
        chunk_metadata = {
            **(metadata or {}),
            **chunk.metadata,
            "tags": [t.to_dict() for t in tags],
            "routing": routing.to_dict(),
            "source_file": chunk.source_file,
            "chunk_type": chunk.type.value
        }
        
        # 4-6. Stockage : si store_sink fourni, on accumule pour flush batch
        # par fichier (un appel HTTP par collection au lieu d'un par chunk)
        if store_sink is not None:
            if routing.should_index_qdrant():
                for collection in routing.qdrant_collections:
                    store_sink["qdrant"].setdefault(collection, []).append({
                        "chunk_id": chunk.id, "content": chunk.content,
                        "metadata": chunk_metadata, "vector": qdrant_vector
                    })
                    report["qdrant_stored"] += 1
            if routing.should_index_zvec():
                for collection in routing.zvec_collections:
                    store_sink["zvec"].setdefault(collection, []).append({
                        "id": chunk.id, "text": chunk.content, "metadata": chunk_metadata
                    })
                    report["zvec_stored"] += 1
            entities, relations = self._build_memory_payload(chunk, tags)
            store_sink["memory"]["entities"].extend(entities)
            store_sink["memory"]["relations"].extend(relations)
            report["memory_relations"] = 1
            return report

        # 4. Stockage Qdrant (vecteur pré-calculé si embed_batch a tourné en amont)
        if routing.should_index_qdrant():
            for collection in routing.qdrant_collections:
                success = await self.embedder.qdrant.store(
                    collection=collection,
                    chunk_id=chunk.id,
                    content=chunk.content,
                    metadata=chunk_metadata,
                    vector=qdrant_vector
                )
                if success:
                    report["qdrant_stored"] += 1

        # 5. Stockage Zvec
        if routing.should_index_zvec():
            for collection in routing.zvec_collections:
                success = await self.embedder.zvec.store(
                    collection=collection,
                    chunk_id=chunk.id,
                    content=chunk.content,
                    metadata=chunk_metadata
                )
                if success:
                    report["zvec_stored"] += 1

        # 6. Memory MCP (relations)
        await self._store_memory_relations(chunk, tags)
        report["memory_relations"] = 1

        return report
    
    def _build_memory_payload(self, chunk: Chunk, tags: List[Tag]):
        """Construit (entities, relations) Memory MCP pour un chunk, sans HTTP."""
        entities = [{
            "name": chunk.id,
            "entityType": "chunk",
            "observations": [f"Source: {chunk.source_file}", chunk.content[:1000]]
        }]
        relations = []
        seen_tags = set()
        for tag in tags:
            tag_category = tag.category.value if hasattr(tag.category, 'value') else str(tag.category)
            tag_name = f"tag:{tag_category}:{tag.key}:{tag.value}"
            if tag_name in seen_tags:
                continue
            seen_tags.add(tag_name)
            tag_desc = f"{tag_category}/{tag.key}={tag.value} (confidence={tag.confidence:.2f})"
            entities.append({"name": tag_name, "entityType": "tag", "observations": [tag_desc]})
            relations.append({
                "from": chunk.id,
                "to": tag_name,
                "relationType": "has_tag"
            })
        return entities, relations

    async def _post_memory(self, entities: List[Dict], relations: List[Dict]) -> None:
        """Flush batch des entités/relations Memory MCP (une requête par type)."""
        import httpx
        url_base = self.config.get("memory_mcp", {}).get("url", "http://localhost:8002")
        if not entities and not relations:
            return
        try:
            async with httpx.AsyncClient() as client:
                if entities:
                    # Dedup par nom d'entité (le payload batch peut contenir des doublons de tags)
                    seen = set()
                    uniq = [e for e in entities if not (e["name"] in seen or seen.add(e["name"]))]
                    await client.post(f"{url_base}/entities", json={"entities": uniq}, timeout=30.0)
                if relations:
                    await client.post(f"{url_base}/relations", json={"relations": relations}, timeout=30.0)
        except Exception as e:
            print(f"Note: Erreur stockage Memory MCP (Ignoré): {e}")

    async def _store_memory_relations(self, chunk: Chunk, tags: List[Tag]) -> None:
        """
        Stocke les relations dans Memory MCP via l'API REST locale
        """
        entities, relations = self._build_memory_payload(chunk, tags)
        await self._post_memory(entities, relations)

    async def _purge_source(self, source_file: str, old_count: int) -> None:
        """
        Purge les anciens chunks d'un fichier avant réindexation.

        Les ids étant déterministes ("<source>::chunk-NNNN"), on supprime la
        plage 0..old_count dans les trois stores. Sans effet si old_count=0
        (données pré-déterministes : un cycle de réindexation les remplace).
        """
        if not source_file or old_count <= 0:
            return
        ids = [f"{source_file}::chunk-{i:04d}" for i in range(old_count)]

        qdrant_cols = (
            self.config.get("embedding", {}).get("qdrant", {}).get("collections") or {}
        ).values()
        for collection in qdrant_cols:
            await self.embedder.qdrant.delete_many(collection, ids)

        zvec_cols = (
            self.config.get("embedding", {}).get("zvec", {}).get("collections") or {}
        ).values()
        for collection in zvec_cols:
            await self.embedder.zvec.delete_many(collection, ids)

        try:
            import httpx
            url_base = self.config.get("memory_mcp", {}).get("url", "http://localhost:8002")
            async with httpx.AsyncClient() as client:
                await client.request(
                    "DELETE", f"{url_base}/entities",
                    json={"names": ids}, timeout=30.0
                )
        except Exception as e:
            print(f"Note: purge Memory MCP ignorée: {e}")

    async def index_file(self, file_path: str) -> Dict[str, Any]:
        """
        Indexe un fichier
        
        Args:
            file_path: Chemin du fichier
            
        Returns:
            Rapport d'indexation
        """
        path = Path(file_path)
        
        # Vérifier l'existence
        if not path.exists():
            return {
                "status": "error",
                "errors": [f"Fichier non trouvé: {file_path}"]
            }
        
        # Détecter le type
        suffix = path.suffix.lower()
        type_map = {
            ".py": "code",
            ".js": "code",
            ".ts": "code",
            ".jsx": "code",
            ".tsx": "code",
            ".java": "code",
            ".go": "code",
            ".rs": "code",
            ".c": "code",
            ".cpp": "code",
            ".h": "code",
            ".md": "markdown",
            ".markdown": "markdown",
            ".json": "json",
            ".yaml": "config",
            ".yml": "config",
            ".toml": "config",
            ".ini": "config",
            ".env": "config",
            ".txt": "text",
            ".log": "log",
        }
        doc_type = type_map.get(suffix, "text")
        
        # Lire le contenu
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as e:
            return {
                "status": "error",
                "errors": [f"Erreur lecture: {str(e)}"]
            }
        
        # Indexer
        return await self.index_document(
            content=content,
            doc_type=doc_type,
            source_file=str(path),
            metadata={
                "file_name": path.name,
                "file_extension": suffix,
                "file_size": path.stat().st_size if path.exists() else 0
            }
        )
    
    async def index_directory(
        self,
        dir_path: str,
        extensions: List[str] = None,
        exclude_patterns: List[str] = None
    ) -> Dict[str, Any]:
        """
        Indexe tous les fichiers d'un répertoire
        
        Args:
            dir_path: Chemin du répertoire
            extensions: Extensions à inclure (optionnel)
            exclude_patterns: Patterns à exclure (optionnel)
            
        Returns:
            Rapport d'indexation global
        """
        dir_path = Path(dir_path)
        
        if not dir_path.is_dir():
            return {
                "status": "error",
                "errors": [f"Répertoire non trouvé: {dir_path}"]
            }
        
        # Extensions par défaut
        if extensions is None:
            extensions = [
                ".py", ".js", ".ts", ".jsx", ".tsx",
                ".md", ".json", ".yaml", ".yml",
                ".txt"
            ]
        
        # Exclusions : filet de sécurité + .ragignore (source unique) ;
        # exclude_patterns explicites restent honorés en complément.
        ignore_base, safety, rag = _ragignore_for(dir_path)
        if exclude_patterns is None:
            exclude_patterns = []
        
        report = {
            "status": "success",
            "files_processed": 0,
            "files_failed": 0,
            "total_chunks": 0,
            "total_tags": 0,
            "errors": [],
            "files": []
        }
        
        # Parcourir les fichiers
        for file_path in dir_path.rglob("*"):
            # Vérifier l'extension
            if file_path.suffix.lower() not in extensions:
                continue

            # Vérifier les exclusions (.ragignore + filet de sécurité + patterns)
            # NB: absolute() volontaire — resolve() dereferencerait les jonctions
            try:
                rel = file_path.absolute().relative_to(ignore_base).as_posix()
            except ValueError:
                rel = str(file_path)
            if safety.match(rel) or rag.match(rel):
                continue
            if any(pattern in str(file_path) for pattern in exclude_patterns):
                continue
            
            # Indexer le fichier
            file_report = await self.index_file(str(file_path))
            
            if file_report.get("status") == "success":
                report["files_processed"] += 1
                report["total_chunks"] += file_report.get("chunks_created", 0)
                report["total_tags"] += file_report.get("tags_generated", 0)
            else:
                report["files_failed"] += 1
            
            report["files"].append({
                "path": str(file_path),
                "status": file_report.get("status"),
                "chunks": file_report.get("chunks_created", 0)
            })
        
        return report
    
    async def search(
        self,
        query: str,
        collections: Optional[List[str]] = None,
        limit: int = 10,
        filters: Optional[Dict] = None
    ) -> List[SearchResult]:
        """
        Recherche hybride
        
        Args:
            query: Requête textuelle
            collections: Collections spécifiques (optionnel)
            limit: Nombre max de résultats
            filters: Filtres de métadonnées (optionnel)
            
        Returns:
            Résultats fusionnés
        """
        # Cache clé (query + collections + limit + filters)
        cache_key = self._make_cache_key(query, collections, limit, filters)
        if self._cache_enabled():
            cached = self._search_cache.get(cache_key)
            if cached is not None:
                return cached[:limit]

        qdrant_collections = collections or list(self.embedder.qdrant.collections.values())
        zvec_collections = collections or list(self.embedder.zvec.collections.values())

        results = await self.embedder.search_dual(
            query=query,
            qdrant_collections=qdrant_collections,
            zvec_collections=zvec_collections,
            limit=limit
        )

        memory_relations = await self._get_memory_relations(query)

        fused_results = await self.fusion.fuse(
            qdrant_results=results.get("qdrant", []),
            zvec_results=results.get("zvec", []),
            memory_relations=memory_relations
        )

        # Mise en cache (LRU simple)
        if self._cache_enabled():
            max_entries = int(self.cache_config.get("max_entries", 50))
            self._search_cache[cache_key] = fused_results[:limit]
            if max_entries > 0 and len(self._search_cache) > max_entries:
                first_key = next(iter(self._search_cache))
                self._search_cache.pop(first_key, None)

        return fused_results[:limit]

    def _make_cache_key(
        self,
        query: str,
        collections: Optional[List[str]],
        limit: int,
        filters: Optional[Dict]
    ) -> str:
        cols = tuple(collections) if collections else ()
        filt = tuple(sorted(filters.items())) if filters else ()
        return f"{query}|{cols}|{limit}|{filt}"

    def _cache_enabled(self) -> bool:
        return bool(self.cache_config.get("enabled", True))

    def clear_search_cache(self) -> None:
        self._search_cache.clear()
    
    async def _get_memory_relations(self, query: str) -> List[Dict]:
        """
        Récupère les relations depuis Memory MCP
        
        Args:
            query: Requête pour la recherche
            
        Returns:
            Liste de relations
        """
        import httpx
        url_base = self.config.get("memory_mcp", {}).get("url", "http://localhost:8002")
        
        try:
            async with httpx.AsyncClient() as client:
                # Recherche par similarité (si supporté par le bridge REST du MCP)
                response = await client.get(f"{url_base}/search?query={query}", timeout=5.0)
                if response.status_code == 200:
                    return response.json().get("results", [])
        except Exception as e:
            print(f"Erreur recherche Memory MCP: {e}")
        
        return []
    
    async def delete(self, chunk_id: str) -> Dict[str, Any]:
        """
        Supprime un chunk de tous les stores
        
        Args:
            chunk_id: ID du chunk
            
        Returns:
            Rapport de suppression
        """
        report = {
            "status": "success",
            "chunk_id": chunk_id,
            "qdrant_deleted": False,
            "zvec_deleted": False,
            "memory_deleted": False
        }
        
        # Supprimer des stores vectoriels
        report["qdrant_deleted"] = await self.embedder.qdrant.delete("all", chunk_id)
        report["zvec_deleted"] = await self.embedder.zvec.delete("all", chunk_id)
        
        # Supprimer de Memory MCP
        await self._delete_memory_entity(chunk_id)
        report["memory_deleted"] = True
        
        return report
    
    async def _delete_memory_entity(self, chunk_id: str) -> None:
        """
        Supprime l'entité de Memory MCP
        
        Args:
            chunk_id: ID du chunk
        """
        import httpx
        url_base = self.config.get("memory_mcp", {}).get("url", "http://localhost:8002")
        
        try:
            async with httpx.AsyncClient() as client:
                # 1. Identifier les entités liées au fichier
                # 2. Supprimer les entités
                await client.request("DELETE", f"{url_base}/entities", json={"source": file_path}, timeout=5.0)
        except Exception as e:
            print(f"Erreur nettoyage Memory MCP: {e}")
            
        success = True
        return success
    
    def get_stats(self) -> Dict[str, Any]:
        """
        Retourne les statistiques du pipeline
        
        Returns:
            Statistiques de configuration
        """
        return {
            "config_path": self.config_path,
            "chunking": {
                "default_size": self.chunker.chunking_config.get("default_size"),
                "overlap_percent": self.chunker.chunking_config.get("overlap_percent")
            },
            "tagging": {
                "min_confidence": self.tagger.tagging_config.get("min_confidence"),
                "max_tags": self.tagger.tagging_config.get("max_tags_per_chunk")
            },
            "embedding": {
                "qdrant_enabled": self.embedder.qdrant.enabled,
                "qdrant_dimensions": self.embedder.qdrant.dimensions,
                "zvec_enabled": self.embedder.zvec.enabled,
                "zvec_dimensions": self.embedder.zvec.dimensions
            },
            "fusion": {
                "weights": self.fusion.weights
            }
        }
    
    async def initialize(self) -> Dict[str, bool]:
        """
        Initialise toutes les collections vectorielles
        
        Returns:
            Résultats d'initialisation
        """
        return await self.embedder.initialize_collections()


# Fonction utilitaire pour créer un pipeline rapidement
def create_pipeline(config_path: str = None) -> RAGPipeline:
    """
    Crée un pipeline RAG
    
    Args:
        config_path: Chemin vers la configuration (optionnel)
        
    Returns:
        Instance de RAGPipeline
    """
    return RAGPipeline(config_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="RAG Pipeline CLI (relative paths only)")
    parser.add_argument("command", choices=["ingest", "search"], help="Action à exécuter")
    parser.add_argument("--query", dest="query", help="Requête de recherche (search)")
    parser.add_argument("--root", dest="root", default=".", help="Racine workspace (ingest)")
    parser.add_argument("--limit", dest="limit", type=int, default=10, help="Limite résultats (search)")
    args = parser.parse_args()

    async def _main():
        pipeline = RAGPipeline()
        if args.command == "ingest":
            report = await pipeline.ingest_workspace(root_path=args.root)
            print(json.dumps(report, ensure_ascii=False, indent=2))
        elif args.command == "search":
            query = args.query or "test"
            results = await pipeline.search(query=query, limit=args.limit)
            print(json.dumps([r.to_dict() for r in results], ensure_ascii=False, indent=2))

    asyncio.run(_main())
