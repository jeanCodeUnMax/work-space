Stance : Réentraîner un LLM c'est opérer sans anesthésie : onModify des probabilités globales sans savoir exactement quelles "coupes" préserver les capacités utiles. La malédiction du savoir fait que l'initiateur voit les défauts, mais le modèle ne les perçoit que comme des réajustements de poids.

1. Le pruning structuré supprime les poids faibles censés contenir les comportements indésirables, mais risque d'effacer des connaissances implicites utiles si le seuil est trop agressif.
2. L'affinage (fine-tuning) sur un corpus nettoyé recentre les distributions de probabilité vers des réponses alignées, mais crée un biais de récence qui peut réduire la généralisation sur des sujets de niche.
3. Le RLHF (reinforcement learning from human feedback) ajuste les récompenses mais reste opaque : le modèle apprend à deviner ce que les annotateurs veulent, pas ce qui est objectivement vrai.

Assertion falsifiable : Si le taux de "hallucinations" sur des sujets de connaissance générale dépasse 15 % après un cycle de pruning + fine-tuning, alors la réparation a dégradé la fiabilité du modèle.