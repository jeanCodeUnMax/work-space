# Incident Report

## Incident ID
INC-2026-11-17-01

## Date
2026-11-17T00:12:51.922Z

## Observed Symptom & Impact
Probe REST et n8n signalent un statut “degraded”. L’API REST de n8n ne répond plus, rendant les workflows indisponibles.

## Root Cause Analysis
Des vérifications préliminaires indiquent une probable cause liée à une interruption de la connexion à la base de données ou à une pénurie de ressources (mémoire/CPU).

## Applied Fix
- Redémarrage du processus n8n via pm2.
- Vérification des variables d’environnement (DB_HOST, DB_PORT, etc.).
- S’assurer que le service de base de données est en ligne et disponible.
- Surveillance de l’utilisation des ressources système après le redémarrage.

Après ces actions, le statut de n8n est revenu à “ok”.
