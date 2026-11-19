# Incident Report

## Incident ID
INC-2026-11-16-04

## Date
2026-11-16

## Observed Symptom & Impact
- Status: **DEGRADED**
- Affected probes: Vec, Content, REST, n8n
- n8n is partially responsive; REST endpoints return 5xx, Vec and Content workflows fail, but some core features remain operational.

## Root Cause Analysis
- The n8n process is running but its internal service discovery fails due to a corrupted `credentials` cache in the `~/.config/n8n` folder.
- The corrupted cache prevents the Vec and Content workers from establishing connections, leading to 500 errors on REST calls.

## Applied Fix
- Cleared the corrupted credentials cache by deleting `~/.config/n8n/credentials.json`.
- Restarted n8n via `pm2 restart n8n`.
- Verified all probes are now healthy.

## Verification
- All REST endpoints now return 200.
- Vec and Content workflows execute successfully.
- No new errors in `n8n.log`.

---

**Next Steps**
- Implement a health check script that monitors the cache file integrity.
- Schedule a routine cleanup of cache files to prevent recurrence.
