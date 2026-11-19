Stance: The JIT skills‑mux protocol is essential for high‑upside, safe, dynamic skill activation.  
It isolates skill execution via an ephemeral mount in .agents/skills, eliminating state leakage and enabling instant rollback.  
The route‑vet‑activate‑execute‑deactivate pipeline enforces deterministic safety checks before any skill runs.  
The vet stage implements cryptographic integrity checks and access‑control policies to block suspicious or blocked skills.  
Observable logs and cryptographic hashes at each stage provide verifiable evidence for audit and rapid incident response.  
Invariants such as single‑activation, no‑leakage, and atomic deactivation are enforced by the protocol.  
The protocol’s design amplifies reliability by allowing safe, incremental skill updates without downtime.  
If any invariant is violated (e.g., double activation or crash during activation), the system must halt and raise a BLOCKED_SUSPICIOUS event.  
This assertion is falsifiable: a recorded violation of any listed invariant during a production run proves the protocol ineffective.  
Therefore, rigorous validation and continuous observable proof are required to validate the protocol’s safety and upside.