# Incident Report

## Incident ID
INC-2026-11-16-07

## Date
2026-11-16 18:40:51

## Observed Symptom & Impact
- n8n status: DEGRADED
- Failed probes: Memory, Vec, Content, REST, n8n
- Workflows fail to execute and webhooks stop responding.

## Root Cause Analysis
The issue appears to stem from a memory leak or excessive resource usage in n8n, causing downstream services (Vec, Content, REST) to time out. A recent configuration change to increase concurrency without scaling resources likely contributed.

## Applied Fix
- Restarted n8n service using `pm2 restart n8n`.
- Reduced concurrency settings in `config.json` to match available RAM.
- Monitored memory usage with `pm2 monit` and ensured no further leaks.

## Verification
- All probes now report OK.
- Workflows execute successfully.
- No new errors in logs for the past 2 hours.

---

### Notes
- A detailed review of memory usage patterns is scheduled for next sprint.
- Consider setting up alerts for memory thresholds.
