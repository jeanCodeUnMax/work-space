# Incident Summary – n8n

## Date
2026‑11‑16

## Current State
- **n8n** : **DOWN** (multiple consecutive failures across probes: Agent, Task, Session, Roster, Bridge, Memory, Vec, Content, REST). 
- The system has transitioned from *DEGRADED* to *DOWN* multiple times during the day.

## Observed Symptoms
1. All probes for n8n and associated services consistently report failures.
2. No successful health check was recorded after 18:25 UTC.
3. Logs (not captured here) indicate persistent connection/time‑out errors.

## Root‑Cause Hypothesis (5 Whys)
1. **Why** is n8n down? → The n8n process is not running or unresponsive.
2. **Why** is the process not running? → It crashed or failed to start.
3. **Why** did it crash? → Dependency (PostgreSQL/Redis) unavailable or misconfigured.
4. **Why** is the dependency unavailable? → Service restarted, network partition, or credential expired.
5. **Why** did the dependency become unavailable? → Recent deployment or configuration change.

## Immediate Actions
- Verify that PostgreSQL, Redis, and other dependent services are up: `systemctl status postgresql`, `redis-cli ping`.
- Check n8n logs: `pm2 logs n8n --lines 200`.
- Restart the n8n process: `pm2 restart n8n`.
- If restart fails, inspect configuration file `.env` for wrong database URLs.
- As a temporary measure, point a spare instance of n8n to a healthy database.

## Long‑Term Fix
- Automate health checks: add a cron job that restarts n8n if `pm2 status n8n` shows *stopped*.
- Add alerting on PostgreSQL and Redis service health.
- Document configuration changes and perform rollback if new version introduced the issue.

## Next Update
Will log next status transition once the issue is resolved or further diagnostics are performed.
