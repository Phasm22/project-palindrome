#!/bin/bash
# Add Datastore.Allocate permission to AdminPlus role
# This is needed for cloud-init snippets on the 'local' datastore

echo "🔧 Adding Datastore.Allocate permission to AdminPlus role..."
echo ""
echo "Run this on the yin node:"
echo ""
echo "  pveum role modify AdminPlus -privs \"Datastore.Allocate,Datastore.AllocateSpace,Datastore.AllocateTemplate,Datastore.Audit,VM.Allocate,VM.Audit,VM.Clone,VM.Config.CDROM,VM.Config.CPU,VM.Config.Cloudinit,VM.Config.Disk,VM.Config.HWType,VM.Config.Memory,VM.Config.Network,VM.Config.Options,VM.Monitor,VM.PowerMgmt\""
echo ""
echo "Or check current permissions:"
echo "  pveum role show AdminPlus"
echo ""
echo "💡 Note: After modifying the role, you may need to recreate the token:"
echo "   pveum user token delete llm@pve llm-agent"
echo "   pveum user token add llm@pve llm-agent --privsep 0"

