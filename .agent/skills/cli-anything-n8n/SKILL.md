# cli-anything-n8n — controle n8n via le proxy auth

Base :  — cookie de session injecte cote proxy, aucune auth a gerer.

- GET  /ctl/workflows                        liste
- GET  /ctl/workflows/:id                    detail
- POST /ctl/workflows                        creer {name,nodes,connections,settings}
- POST /ctl/workflows/:id/activate|deactivate|archive
- DELETE /ctl/workflows/:id                  archive+delete auto
- GET  /ctl/workflows/:id/executions         historique exec
- Webhook node: URL live =  une fois le workflow ACTIVE (test URL /webhook-test/ sinon).

Format workflow n8n 2.x : nodes[] {parameters,id,name,type,typeVersion,position[,webhookId]}, connections {nom:{main:[[{node,type:'main',index:0}]]}}.
