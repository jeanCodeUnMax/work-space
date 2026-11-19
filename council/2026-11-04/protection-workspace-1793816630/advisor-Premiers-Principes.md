Stance : La question masque un problème plus fondamental : la confiance en les agents. Avant de protéger le workspace, il faut définir quels agents sont autorisés et quels droits ils possèdent.

- Argument 1 : La granularité des permissions est essentielle. Un modèle de contrôle d’accès basé sur des rôles (RBAC) ou attributs (ABAC) empêche tout agent non‑autorisé d’écrire ou de supprimer des fichiers critiques, tout en conservant la modularité pour les agents légitimes.
- Argument 2 : Le versioning et les snapshots doivent être automatisés et immuables. En stockant chaque snapshot dans un stockage chiffré et en utilisant des hachages de contenu, on garantit la restauration fiable sans que les agents puissent écraser l’historique.
- Argument 3 : Le chiffrement de bout‑en‑bout du workspace, couplé à des clés gérées par un service de secret, empêche la lecture ou la modification non autorisée tout en permettant aux agents possédant les bonnes credentials de travailler de façon transparente.

Assertion falsifiable : Si l’on désactive les contrôles d’accès (RBAC/ABAC) tout en maintenant snapshots et chiffrement, alors un agent malveillant pourra écraser un fichier de configuration sans que le système détecte l’altération.
