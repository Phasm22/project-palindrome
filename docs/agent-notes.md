# agent-notes.md

The agent operates in an environment with:
- A home LAN (192.168.68.0/22)
- A lab VLAN (172.16.0.0/22) where Project Palindrome hosts live
- A WireGuard VPN (10.16.0.0/24)
- OPNsense acts as the lab firewall/router
- Cisco 2960G handles VLANs and trunks
- Proxmox cluster hosts future Palindrome VMs
- Pi-hole provides DNS metrics

Only Palindrome hosts are managed by the agent.
