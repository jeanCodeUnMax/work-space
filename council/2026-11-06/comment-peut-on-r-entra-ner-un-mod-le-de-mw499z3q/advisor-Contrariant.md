Stance : Le réentraînement massif est une fuite de garantie, la réparation chirurgicale reste l'ingénierie maîtrisée.

Arguments :
1. Réentraînement = perte de traçabilité des weights + coût GPU incalculable + rollback impossible → anti-répétable (données historisées).
2. Patch pilote = supervision de prompts dynamiques + gardes-rails + tests d'invariance → rollback instantané (hypothèse vérifiable par A/B).
3. Données de patch = curation par ingénieurs + métadonnées de bug, pas de « plus de 10 k exemples » → efficace que si les bugs sont ciblés.

Assertion falsifiable : Si un patch de 500 exemples ciblés réduit les erreurs critiques de 40 % tandis qu’un réentraînement complet ne gagne que 5 %, alors la réparation vaut plus que l’entraînement complet.