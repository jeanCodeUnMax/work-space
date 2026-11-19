**Stance** : Le réentraînement complet est un pari statistique ; la « chirurgie » ciblée (LoRA, activation patching, model editing) est la seule voie falsifiable.

1. **Données** : LoRA (rank 8-32) modifie <1 % des poids et préserve 95-99 % des benchmarks existants (Hu et al. 2021, reproduction indépendante).
2. **Mesure** : Model editing (ROME, MEMIT) localise les faits dans des couches MLP précises ; taux de succès 80-90 % sur CounterFact, mais généralisation hors distribution <30 % (Meng et al. 2022/2023).
3. **Précédent** : Aucun « chirurgien » n'a démontré de correction persistante sans régression mesurée sur MMLU/HELM après 100+ éditions séquentielles.

**Assertion falsifiable** : Si une méthode d'édition revendique >95 % de réussite factuelle + <2 % de régression MMLU après 500 éditions séquentielles sans réentraînement, je la valide ; sinon c'est du marketing.