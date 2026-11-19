#!/bin/bash
cd "C:/data-sys/hephaistos2-kit"
declare -A R=( [chat-mvmw59wa]="PREMIERS-PRINCIPES" [chat-mvmtldvy]="EXPANSIONNISTE" [chat-mvpfinfra]="EXECUTEUR" [chat-mvmw5chd]="OUTSIDER" [chat-de8acfde-0423-4480-ad11-aa4519daeee6]="CONTRARIANT" [chat-58bb1bda-11b7-4f4d-9ade-5b9bf43820e3]="EMPIRIQUE" )
for s in "${!R[@]}"; do
  node .agent/agent-bridge/acp-inject.js --provider hephaistos --session "$s" --cwd "C:/data-sys/hephaistos2-kit" \
    --prompt "Tu es l'advisor ${R[$s]} du LLM-Council. Lis .agent/skills/llm-council/SKILL.md et .agent/council/PROTOCOL.md pour connaitre ton role et le protocole (2 tours : analyse sous ton angle -> fichier advisor-<ROLE>.md -> annonce sur .agent/comms.jsonl ; puis peer-review anonymisee). Reponds PONG." \
    --wait turn --timeout 120 | tail -2
done
