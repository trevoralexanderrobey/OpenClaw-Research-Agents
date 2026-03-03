# Purge Manifest (Phase 1)

## Intent
Remove all offensive cybersecurity execution capabilities from active runtime surfaces.

## Banned capability classes
- network scanning
- exploit payload generation
- lateral movement tooling
- offensive Burp execution workflows
- vulnerability exploitation automation

## Keywords screened
- nmap
- metasploit
- burp
- sqlmap
- msfvenom
- aircrack
- ffuf
- nikto
- exploit
- lateral movement

## Result summary
- Active runtime policy and image catalogs are research-only.
- Supervisor skill config removed offensive slug usage.
- Execution router boundary denies supervisor external tool invocation.
- MCP publisher/sync surfaces are stub-only in Phase 1.

## Explicitly removed or excluded paths from active runtime scaffold
- `openclaw-bridge/containers/nmap`
- `openclaw-bridge/containers/sqlmap`
- `openclaw-bridge/containers/nikto`
- `openclaw-bridge/containers/aircrack`
- `openclaw-bridge/containers/msfvenom`
- `openclaw-bridge/containers/ffuf`
- `openclaw-bridge/containers/hashcat`
- `openclaw-bridge/burp-bionic-link`
- `openclaw-bridge/burp-bionic-link-legacy`
- `openclaw-bridge/skills/nmap`
- `openclaw-bridge/skills/burp-suite`
- `openclaw-bridge/skills/algora-bountyfi`
