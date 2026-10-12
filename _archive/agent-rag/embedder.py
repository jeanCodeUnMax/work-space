"""
Embedder Module - Génération des embeddings et stockage vectoriel

Deux étages d'embeddings, volontairement distincts :
- Qdrant : NVIDIA NIM (nvidia/nemotron-3-embed-1b, 2048 dims) — recherche large/catégorique
- Zvec   : modèle local Xenova/all-MiniLM-L6-v2 (384 dims) — recherche sémantique fine

Classes:
    - QdrantEmbedder: Embeddings via API NVIDIA NIM OpenAI-compatible (2048 dim)
    - ZvecEmbedder: Embeddings via le serveur MCP Zvec (local MiniLM, 384 dim)
"""

from typing import List, Dict, Any, Optional
import json


# Endpoints et variables de clé par provider d'embedding (API OpenAI-compatible)
PROVIDER_EMBED_ENDPOINTS = {
    "nvidia": "https://integrate.api.nvidia.com/v1/embeddings",
    "openai": "https://api.openai.com/v1/embeddings",
}
PROVIDER_KEY_ENV = {
    "nvidia": "NVIDIA_API_KEY",
    "openai": "OPENAI_API_KEY",
}


class QdrantEmbedder:
    """
    Gestion des embeddings Qdrant via API OpenAI-compatible.

    Provider configuré via RAG_QDRANT_PROVIDER (nvidia par défaut,
    nemotron-3-embed-1b en 2048 dims).

    Attributes:
        config: Configuration Qdrant depuis config.json
    """

    def __init__(self, config: Dict[str, Any]):
        """
        Initialise l'embedder Qdrant

        Args:
            config: Configuration Qdrant depuis config.json
        """
        self.config = config
        self.provider = config.get("provider", "nvidia")
        self.dimensions = config.get("dimensions", 2048)
        self.model = config.get("model", "nvidia/nemotron-3-embed-1b")
        self.enabled = config.get("enabled", True)
        self.collections = config.get("collections", {})
        # Auth serveur Qdrant : clé optionnelle via config["api_key"] ou env QDRANT_API_KEY.
        # Jamais de clé en dur dans config.json — elle vit dans l'environnement (HKCU).
        import os
        _api_key = config.get("api_key") or os.environ.get("QDRANT_API_KEY", "")
        self._headers = {"api-key": _api_key} if _api_key else {}

    async def embed(self, text: str, input_type: str = "passage") -> List[float]:
        """
        Génère l'embedding via l'API du provider configuré (NVIDIA par défaut).
        input_type: 'passage' pour indexer, 'query' pour chercher (convention NIM).
        """
        if not self.enabled:
            return [0.0] * self.dimensions

        import httpx
        import os

        key_env = PROVIDER_KEY_ENV.get(self.provider, "NVIDIA_API_KEY")
        api_key = os.getenv(key_env) or os.getenv("NVIDIA_API_KEY")
        if not api_key:
            print(f"Warning: {key_env} non trouvée")
            return [0.0] * self.dimensions

        url = self.config.get("embed_url") or PROVIDER_EMBED_ENDPOINTS.get(
            self.provider, PROVIDER_EMBED_ENDPOINTS["nvidia"]
        )
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}"
        }
        payload = {
            "model": self.model,
            "input": [text],
            "input_type": input_type,
            "encoding_format": "float",
        }

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(url, json=payload, headers=headers, timeout=30.0)
                if response.status_code == 200:
                    return response.json()["data"][0]["embedding"]
                else:
                    print(f"Erreur API embedding ({self.provider}): {response.text}")
                    return [0.0] * self.dimensions
        except Exception as e:
            print(f"Erreur génération embedding ({self.provider}): {e}")
            return [0.0] * self.dimensions

    async def embed_batch(
        self,
        texts: List[str],
        input_type: str = "passage",
        batch_size: int = 32
    ) -> List[List[float]]:
        """
        Génère les embeddings de plusieurs textes en appels groupés
        (l'API OpenAI-compatible accepte input[] - un POST par groupe
        au lieu d'un POST par chunk).
        Retourne une liste de vecteurs alignée sur `texts`.
        """
        if not texts:
            return []
        if not self.enabled:
            return [[0.0] * self.dimensions for _ in texts]

        import httpx
        import os

        key_env = PROVIDER_KEY_ENV.get(self.provider, "NVIDIA_API_KEY")
        api_key = os.getenv(key_env) or os.getenv("NVIDIA_API_KEY")
        if not api_key:
            print(f"Warning: {key_env} non trouvée")
            return [[0.0] * self.dimensions for _ in texts]

        url = self.config.get("embed_url") or PROVIDER_EMBED_ENDPOINTS.get(
            self.provider, PROVIDER_EMBED_ENDPOINTS["nvidia"]
        )
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}"
        }

        results: List[List[float]] = []
        for i in range(0, len(texts), batch_size):
            group = texts[i:i + batch_size]
            payload = {
                "model": self.model,
                "input": group,
                "input_type": input_type,
                "encoding_format": "float",
            }
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.post(url, json=payload, headers=headers, timeout=60.0)
                    if response.status_code == 200:
                        data = response.json()["data"]
                        data = sorted(data, key=lambda d: d.get("index", 0))
                        results.extend(d["embedding"] for d in data)
                    else:
                        print(f"Erreur API embedding batch ({self.provider}): {response.text}")
                        results.extend([[0.0] * self.dimensions for _ in group])
            except Exception as e:
                print(f"Erreur génération embedding batch ({self.provider}): {e}")
                results.extend([[0.0] * self.dimensions for _ in group])
        return results
    
    async def store(
        self,
        collection: str,
        chunk_id: str,
        content: str,
        metadata: Dict[str, Any],
        vector: Optional[List[float]] = None
    ) -> bool:
        """
        Stocke un document dans Qdrant via l'API REST
        
        Args:
            collection: Nom de la collection
            chunk_id: ID unique du chunk (Haché si nécessaire)
            content: Contenu textuel
            metadata: Métadonnées du chunk
            
        Returns:
            True si succès
        """
        if not self.enabled:
            return False
            
        import httpx
        import hashlib
        
        url = f"{self.config.get('url', 'http://localhost:6333')}/collections/{collection}/points?wait=true"

        # L'embedding est généré via le provider configuré (NVIDIA NIM par défaut),
        # sauf si un vecteur pré-calculé est fourni (batch embed_batch en amont)
        if vector is None:
            vector = await self.embed(content)

        payload = {"points": [self._build_point(chunk_id, content, metadata, vector)]}
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.put(url, json=payload, headers=self._headers, timeout=30.0)
                if response.status_code != 200:
                    raise Exception(f"API Qdrant error ({response.status_code}): {response.text}")
                return True
        except httpx.ConnectError:
            raise Exception(f"Connexion impossible au serveur Qdrant sur {url}. Le serveur est-il lance?")
        except Exception as e:
            print(f"Erreur stockage Qdrant: {e}")
            raise e

    @staticmethod
    def _point_id(chunk_id: str) -> int:
        """ID numérique Qdrant déterministe dérivé du chunk_id."""
        import hashlib
        return int(hashlib.sha256(chunk_id.encode()).hexdigest()[:16], 16)

    def _build_point(
        self,
        chunk_id: str,
        content: str,
        metadata: Dict[str, Any],
        vector: List[float]
    ) -> Dict[str, Any]:
        """Construit un point Qdrant (id numérique dérivé du chunk_id)."""
        qdrant_id_int = self._point_id(chunk_id)
        # Tag moral Asimov -> boost éthique
        ethics_payload = {}
        tags = metadata.get("tags", {})
        if isinstance(tags, dict):
            context_tags = tags.get("contextuel", {})
            if context_tags.get("moral") == "asimov":
                ethics_payload = {"ethics_level": "high", "boost": 1.5}
        return {
            "id": qdrant_id_int,
            "vector": {"dense": vector},  # Format hybride : vecteur nommé "dense"
            "payload": {
                **metadata,
                **ethics_payload,
                "content": content,
                "source_id": chunk_id
            }
        }

    async def store_batch(
        self,
        collection: str,
        items: List[Dict[str, Any]]
    ) -> bool:
        """
        Stocke plusieurs points en un seul PUT (points[]).
        items: [{"chunk_id": str, "content": str, "metadata": dict, "vector": [...]}]
        """
        if not self.enabled or not items:
            return False

        import httpx
        url = f"{self.config.get('url', 'http://localhost:6333')}/collections/{collection}/points?wait=true"
        payload = {
            "points": [
                self._build_point(it["chunk_id"], it["content"], it["metadata"], it["vector"])
                for it in items
            ]
        }
        try:
            async with httpx.AsyncClient() as client:
                response = await client.put(url, json=payload, headers=self._headers, timeout=60.0)
                if response.status_code != 200:
                    raise Exception(f"API Qdrant error ({response.status_code}): {response.text}")
                return True
        except Exception as e:
            print(f"Erreur stockage batch Qdrant ({len(items)} pts -> {collection}): {e}")
            raise e

    async def search(
        self,
        collection: str,
        query: str,
        limit: int = 10,
        filter_metadata: Dict = None
    ) -> List[Dict[str, Any]]:
        """
        Recherche sémantique dans Qdrant
        """
        if not self.enabled:
            return []
            
        import httpx
        url = f"{self.config.get('url', 'http://localhost:6333')}/collections/{collection}/points/search"
        
        # On génère l'embedding de la requête
        vector = await self.embed(query, input_type="query")
        
        payload = {
            "vector": {"dense": vector},  # Format hybride : vecteur nommé "dense"
            "limit": limit,
            "with_payload": True,
            "with_vector": False
        }
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(url, json=payload, headers=self._headers, timeout=10.0)
                if response.status_code == 200:
                    results = response.json().get("result", [])
                    return results
                return []
        except Exception as e:
            print(f"Erreur recherche Qdrant: {e}")
            return []
    
    async def delete(self, collection: str, chunk_id: str) -> bool:
        """
        Supprime un document de Qdrant
        
        Args:
            collection: Nom de la collection
            chunk_id: ID du chunk à supprimer
            
        Returns:
            True si succès
        """
        try:
            import httpx
            url = f"{self.config.get('url', 'http://localhost:6333')}/collections/{collection}/points/delete"
            
            payload = {
                "filter": {
                    "must": [
                        {
                            "key": "source_id",
                            "match": {"value": chunk_id}
                        }
                    ]
                }
            }
            
            async with httpx.AsyncClient() as client:
                await client.post(url, json=payload, headers=self._headers, timeout=5.0)
                return True
        except Exception as e:
            print(f"Erreur suppression Qdrant: {e}")
            return False

    async def delete_many(self, collection: str, chunk_ids: List[str]) -> int:
        """
        Supprime plusieurs points en un appel (purge avant réindexation).

        Args:
            collection: Nom de la collection
            chunk_ids: IDs de chunks (déterministes) à supprimer

        Returns:
            Nombre de points demandés (Qdrant ne renvoie pas le décompte)
        """
        if not chunk_ids:
            return 0
        try:
            import httpx
            url = f"{self.config.get('url', 'http://localhost:6333')}/collections/{collection}/points/delete?wait=true"
            payload = {"points": [self._point_id(cid) for cid in chunk_ids]}
            async with httpx.AsyncClient() as client:
                resp = await client.post(url, json=payload, headers=self._headers, timeout=30.0)
                if resp.status_code == 200:
                    return len(chunk_ids)
                print(f"Erreur suppression batch Qdrant ({resp.status_code}): {resp.text[:200]}")
                return 0
        except Exception as e:
            print(f"Erreur suppression batch Qdrant: {e}")
            return 0

    async def create_collection(self, name: str) -> bool:
        """
        Crée une nouvelle collection Qdrant
        
        Args:
            name: Nom de la collection
            
        Returns:
            True si succès
        """
        try:
            import httpx
            url = f"{self.config.get('url', 'http://localhost:6333')}/collections/{name}"
            
            payload = {
                "vectors": {
                    "dense": {
                        "size": self.dimensions,
                        "distance": "Cosine"
                    }
                },
                "sparse_vectors": {
                    "text": {
                        "modifier": "idf"
                    }
                }
            }
            
            async with httpx.AsyncClient() as client:
                # Vérifier si elle existe déjà
                check = await client.get(url, headers=self._headers, timeout=2.0)
                if check.status_code != 200:
                    await client.put(url, json=payload, headers=self._headers, timeout=5.0)
                return True
        except Exception as e:
            print(f"Erreur création collection Qdrant: {e}")
            return False


class ZvecEmbedder:
    """
    Gestion des embeddings Zvec (384 dimensions, modèle local MiniLM-L6-v2)

    Cette classe délègue la génération d'embeddings au serveur Zvec MCP,
    qui utilise un modèle d'embedding local (Xenova/all-MiniLM-L6-v2, 384d).
    Zvec = recherche sémantique FINE ; Qdrant (NVIDIA 2048d) = recherche large.
    Ne jamais configurer de provider remote ici.
    
    Attributes:
        config: Configuration Zvec
        model_name: Nom du modèle local
        enabled: Si Zvec est activé
    """
    
    def __init__(self, config: Dict[str, Any]):
        """
        Initialise l'embedder Zvec
        
        Args:
            config: Configuration Zvec depuis config.json
        """
        self.config = config
        self.dimensions = config.get("dimensions", 384)
        self.model = config.get("model", "Xenova/all-MiniLM-L6-v2")
        self.enabled = config.get("enabled", True)
        self.collections = config.get("collections", {})
        self._model = None
        self._tokenizer = None
    
    def _load_model(self):
        """
        Charge le modèle local (lazy loading)
        
        Le modèle n'est chargé que lors de la première utilisation.
        """
        if self._model is None:
            try:
                from transformers import AutoTokenizer, AutoModel
                import torch
                
                self._tokenizer = AutoTokenizer.from_pretrained(self.model)
                self._model = AutoModel.from_pretrained(self.model)
            except ImportError:
                print("Warning: transformers non installé, utilisation MCP uniquement")
                self._model = False
    
    async def embed(self, text: str) -> List[float]:
        """
        Génère l'embedding localement
        
        Note: Cette méthode utilise l'outil MCP zvec qui gère
        automatiquement l'embedding local.
        
        Args:
            text: Texte à embedder
            
        Returns:
            Vecteur de 384 dimensions (géré par MCP)
        """
        # L'embedding est géré automatiquement par le MCP Zvec
        return []
    
    async def store(
        self,
        collection: str,
        chunk_id: str,
        content: str,
        metadata: Dict[str, Any]
    ) -> bool:
        """
        Stocke un document dans Zvec via l'API REST locale
        """
        if not self.enabled:
            return False
        
        import httpx
        url = f"{self.config.get('url', 'http://localhost:8001')}/collections/{collection}/documents"
        
        payload = {
            "id": chunk_id,
            "text": content,
            "metadata": metadata
        }
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(url, json=payload, timeout=20.0)
                if response.status_code not in (200, 201):
                    raise Exception(f"API Zvec error ({response.status_code}): {response.text}")
                return True
        except httpx.ConnectError:
            raise Exception(f"Connexion impossible au serveur Zvec sur {url}. Le serveur est-il lance?")
        except Exception as e:
            print(f"Erreur stockage Zvec: {e}")
            raise e

    async def store_batch(
        self,
        collection: str,
        docs: List[Dict[str, Any]]
    ) -> bool:
        """
        Stocke plusieurs documents en un seul POST {documents: [...]}.
        docs: [{"id": str, "text": str, "metadata": dict}]
        """
        if not self.enabled or not docs:
            return False

        import httpx
        url = f"{self.config.get('url', 'http://localhost:8001')}/collections/{collection}/documents"
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(url, json={"documents": docs}, timeout=60.0)
                if response.status_code not in (200, 201):
                    raise Exception(f"API Zvec error ({response.status_code}): {response.text}")
                return True
        except Exception as e:
            print(f"Erreur stockage batch Zvec ({len(docs)} docs -> {collection}): {e}")
            raise e

    async def search(
        self,
        collection: str,
        query: str,
        limit: int = 10,
        filter_metadata: Dict = None
    ) -> List[Dict[str, Any]]:
        """
        Recherche sémantique dans Zvec
        """
        if not self.enabled:
            return []
        
        import httpx
        url = f"{self.config.get('url', 'http://localhost:8001')}/collections/{collection}/search"
        
        payload = {
            "query": query,
            "limit": limit
        }
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(url, json=payload, timeout=10.0)
                if response.status_code == 200:
                    return response.json().get("results", [])
                return []
        except Exception as e:
            print(f"Erreur recherche Zvec: {e}")
            return []
    
    async def delete(self, collection: str, chunk_id: str) -> bool:
        """
        Supprime un document de Zvec
        
        Args:
            collection: Nom de la collection
            chunk_id: ID du chunk à supprimer
            
        Returns:
            True si succès
        """
        try:
            import httpx
            url = f"{self.config.get('url', 'http://localhost:8001')}/collections/{collection}/documents"
            
            async with httpx.AsyncClient() as client:
                await client.request("DELETE", url, json={"ids": [chunk_id]}, timeout=5.0)
                return True
        except Exception as e:
            print(f"Erreur suppression Zvec: {e}")
            return False

    async def delete_many(self, collection: str, chunk_ids: List[str]) -> int:
        """Supprime plusieurs documents Zvec en un appel (purge réindexation)."""
        if not chunk_ids:
            return 0
        try:
            import httpx
            url = f"{self.config.get('url', 'http://localhost:8001')}/collections/{collection}/documents"
            async with httpx.AsyncClient() as client:
                resp = await client.request("DELETE", url, json={"ids": chunk_ids}, timeout=30.0)
                if resp.status_code == 200:
                    return len(chunk_ids)
                print(f"Erreur suppression batch Zvec ({resp.status_code}): {resp.text[:200]}")
                return 0
        except Exception as e:
            print(f"Erreur suppression batch Zvec: {e}")
            return 0

    async def create_collection(self, name: str) -> bool:
        """
        Crée une nouvelle collection Zvec
        
        Args:
            name: Nom de la collection
            
        Returns:
            True si succès
        """
        try:
            import httpx
            url = f"{self.config.get('url', 'http://localhost:8001')}/collections"
            
            payload = {
                "name": name,
                "distance": "Cosine",
                "enableHybrid": True
            }
            
            async with httpx.AsyncClient() as client:
                await client.post(url, json=payload, timeout=5.0)
                return True
        except Exception as e:
            print(f"Erreur création collection Zvec: {e}")
            return False


class EmbedderManager:
    """
    Gestionnaire centralisé des embedders
    
    Cette classe coordonne les embedders Qdrant et Zvec
    pour faciliter les opérations batch.
    
    Attributes:
        qdrant: Embedder Qdrant
        zvec: Embedder Zvec
        config: Configuration complète
    """
    
    def __init__(self, config: Dict[str, Any]):
        """
        Initialise le gestionnaire d'embedders
        
        Args:
            config: Configuration complète du pipeline RAG
        """
        self.config = config
        embedding_config = config.get("embedding", {})
        
        self.qdrant = QdrantEmbedder(embedding_config.get("qdrant", {}))
        self.zvec = ZvecEmbedder(embedding_config.get("zvec", {}))
    
    async def store_dual(
        self,
        chunk_id: str,
        content: str,
        metadata: Dict[str, Any],
        qdrant_collections: List[str],
        zvec_collections: List[str]
    ) -> Dict[str, bool]:
        """
        Stocke dans les deux stores simultanément
        
        Args:
            chunk_id: ID du chunk
            content: Contenu textuel
            metadata: Métadonnées
            qdrant_collections: Collections Qdrant cibles
            zvec_collections: Collections Zvec cibles
            
        Returns:
            Résultats par store
        """
        results = {
            "qdrant": False,
            "zvec": False
        }
        
        # Stocker dans Qdrant
        for collection in qdrant_collections:
            if await self.qdrant.store(collection, chunk_id, content, metadata):
                results["qdrant"] = True
        
        # Stocker dans Zvec
        for collection in zvec_collections:
            if await self.zvec.store(collection, chunk_id, content, metadata):
                results["zvec"] = True
        
        return results
    
    async def search_dual(
        self,
        query: str,
        qdrant_collections: List[str],
        zvec_collections: List[str],
        limit: int = 10
    ) -> Dict[str, List[Dict]]:
        """
        Recherche dans les deux stores simultanément
        
        Args:
            query: Requête textuelle
            qdrant_collections: Collections Qdrant à rechercher
            zvec_collections: Collections Zvec à rechercher
            limit: Nombre max de résultats par store
            
        Returns:
            Résultats par store
        """
        results = {
            "qdrant": [],
            "zvec": []
        }
        
        # Rechercher dans Qdrant
        for collection in qdrant_collections:
            qdrant_results = await self.qdrant.search(collection, query, limit)
            results["qdrant"].extend(qdrant_results)
        
        # Rechercher dans Zvec
        for collection in zvec_collections:
            zvec_results = await self.zvec.search(collection, query, limit)
            results["zvec"].extend(zvec_results)
        
        return results
    
    async def delete_from_all(self, chunk_id: str) -> bool:
        """
        Supprime un chunk de tous les stores
        
        Args:
            chunk_id: ID du chunk à supprimer
            
        Returns:
            True si au moins une suppression réussie
        """
        success = False
        
        # Supprimer de toutes les collections Qdrant
        for collection in self.qdrant.collections.values():
            if await self.qdrant.delete(collection, chunk_id):
                success = True
        
        # Supprimer de toutes les collections Zvec
        for collection in self.zvec.collections.values():
            if await self.zvec.delete(collection, chunk_id):
                success = True
        
        return success
    
    async def initialize_collections(self) -> Dict[str, bool]:
        """
        Initialise toutes les collections configurées
        
        Returns:
            Résultats de création par collection
        """
        results = {}
        
        # Collections Qdrant
        for name in self.qdrant.collections.values():
            results[f"qdrant:{name}"] = await self.qdrant.create_collection(name)
        
        # Collections Zvec
        for name in self.zvec.collections.values():
            results[f"zvec:{name}"] = await self.zvec.create_collection(name)
        
        return results
