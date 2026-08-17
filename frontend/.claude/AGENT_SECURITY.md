# Agent Security Guidelines

## Agent Permission Separation

To maintain security, agents should follow the principle of least privilege:

### Research Agents (Read-Only)
These agents should only have read permissions:
- **Tools**: Read, Grep, Glob, WebSearch, WebFetch
- **No Write Access**: Cannot modify files
- **Examples**: docs-lookup, code-explorer, conversation-analyzer

### Code Writing Agents
These agents can modify code:
- **Tools**: Read, Grep, Glob, Write, Edit
- **Limited Web Access**: Should not have WebSearch + Write simultaneously
- **Examples**: code-reviewer, build-error-resolver, refactor-cleaner

### Hybrid Agents (Use with Caution)
Agents that need both research and writing capabilities:
- **Require explicit approval** before granting both WebSearch and Write
- **Use case**: Feature development that requires researching APIs and implementing code
- **Mitigation**: Use two-step workflow - research first, then write

## Project-Specific Agent Configuration

For this project (Palink-AI), we use:

1. **Research Phase**: Use read-only agents for exploration
2. **Implementation Phase**: Use code-writing agents for changes
3. **Review Phase**: Use code-reviewer agent (read-only analysis)

## Security Checklist

- [ ] Research agents do not have Write/Edit permissions
- [ ] Code-writing agents have limited web access
- [ ] Agents with Bash access are reviewed for necessity
- [ ] MCP servers are restricted to project directories
- [ ] API keys are stored in environment variables, not config files
