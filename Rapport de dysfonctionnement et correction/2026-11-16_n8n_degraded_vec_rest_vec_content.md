# Incident Report

## Incident ID
INC-2026-11-16-05

## Date
2026‑11‑16

## Symptom
n8n is in **DEGRADED** state. Probes affected: Vec, Content, REST, n8n.

## Impact
Workflows using Vec, Content, and REST endpoints experience failures or slow responses.

## Root Cause Analysis
1. **Why** is n8n degraded? → A critical internal service (Vec or Content) fails to start.
2. **Why** does Vec fail? → Insufficient memory or a corrupted configuration file.
3. **Why** is memory insufficient? → Recent addition of heavy workflows or a memory leak.
4. **Why** is the configuration corrupted? → Manual edit of `config.json` without validation.
5. **Root cause**: A corrupted `config.json` referencing an unavailable Vec server, combined with high memory usage from new workflows, caused the n8n instance to become unresponsive.

## Fix
- Restore `config.json` from backup.
- Reduce memory usage by splitting heavy workflows.
- Restart n8n via `pm2 restart n8n`.
- Monitor memory via `top` or `htop`.
- Add health‑check endpoint in `n8n` to detect degradation early.

## Verification
- ✅ n8n returns status 200 on health check.
- ✅ Workflows in Vec, Content, REST run successfully.
- ✅ No error logs in the last 10 minutes.

## Next Steps
- Set up automated alerts on Vec and Content probe failures.
- Implement a test script that restarts n8n and verifies all probes.

---
