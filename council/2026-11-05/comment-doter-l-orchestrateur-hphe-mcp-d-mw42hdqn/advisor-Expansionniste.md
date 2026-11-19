L'orchestrateur doit imposer un cadre de conformité obligatoire, transformant chaque étape en preuve vérifiable sans recourir à des canaux parallèles.
Push de tâches via le canal unique (dispatch_task) avec accusé de réception cryptographiquement signé, garantissant que l'agent a bien reçu l'instruction.
Le serveur de vérification exige un artefact signé (hash + timestamp) stocké dans un dépôt immuable, éliminant toute déclaration auto‑signée.
Les relances automatiques sont déclenchées par le watchdog qui interroge le statut de l'artefact et, en cas d'absence, notifie l'agent puis escalade limitée à un humain pré‑approuvé.
L'escalade est bornée par un timeout configurable (ex. 2h) après lequel le processus passe en mode « human‑override » sans créer de canal additionnel.
Cette configuration crée une boucle de rétroaction fermée où chaque action est traçable, auditée et obligatoire, tout en respectant la loi du canal unique.
En combinant ces mécanismes, on amplifie la transparence et la responsabilité, réduisant les risques de fuite ou de falsification.
Si, après mise en œuvre, un agent peut déclarer faussement la livraison sans que le serveur détecte une anomalie de hash ou de timestamp, alors le mécanisme est inefficace.