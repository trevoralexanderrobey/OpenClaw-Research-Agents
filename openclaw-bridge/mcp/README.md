# MCP Integration Layer (Phase 4)

This directory contains the controlled research + mutation MCP integration layer.

Constraints:
- Input validation must use strict Zod schemas.
- Unknown fields are rejected.
- Base MCP protections are mandatory for all MCP modules.
- Research methods are read-only and allowlisted.
- Mutation methods are operator-only and two-phase committed.
- No dynamic domain configuration is allowed.
