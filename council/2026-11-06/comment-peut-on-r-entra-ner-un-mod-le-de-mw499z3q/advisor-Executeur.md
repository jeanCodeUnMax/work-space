Stance : Le réentraînement doit être chirurgical, ciblé, pas massif. On répare là où ça coince, pas global.

Argument 1 : Diagnostique ciblé — prélever les échecs réels (watchdog/ discipline_agent) et étiqueter les réponses attendues à la main.

Argument 2 : Fine-tuning dirigé — entraîner sur ≤5% des données, focalisé sur les cas problématiques identifiés, avec ACK serveur obligatoire.

Assertion falsifiable : Si le modèle est affiné sur les 20 prompts critiques les plus fréquents, alors discipline_agent passe de <60 à ≥75/100 sur le cycle de validation serveur suivant.