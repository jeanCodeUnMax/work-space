# Incident Report

## Incident ID
INC-2026-11-16-07

## Date
2026-11-16 18:40:26 UTC

## Observed Symptom
n8n en mode DEGRADÉ : échecs des probes Bridge, Memory, Vec, Content, REST, n8n.

## Root Cause Analysis
1. Le processus n8n ne répond plus (probablement arrêt ou hang).
2. Les probes indiquent un manque de mémoire ou de ressources système.
3. Un service dépendant (Redis ou PostgreSQL) semble indisponible.

## Actions Correctives
- Redémarrage du processus n8n via `pm2 restart n8n`.
- Vérification de la disponibilité des services externes.
- Surveillance des logs (`pm2 logs n8n`).
- Mise à jour des dépendances si nécessaire.
- Ajout de tests de santé automatisés.

## Next Steps
- Monitorer l’état de la plateforme pour détecter toute récurrence.
- Documenter toute modification de configuration.
