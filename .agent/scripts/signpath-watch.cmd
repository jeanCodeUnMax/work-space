@echo off
rem hphe-signpath-watch — surveillance reponse SignPath (certificat OSS Cerbere).
rem Lance par la tache planifiee hphe-signpath-watch (toutes les heures).
rem Le script ecrit lui-meme dans .agent\logs\signpath-watch.log.
node "C:\Program Files\Projet-complet\hephaistos2-kit\.agent\scripts\signpath-watch.mjs"
