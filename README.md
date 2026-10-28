# mcp-sluice

An MCP (Model Context Protocol) gateway that bundles multiple MCP servers behind one endpoint.

- **One endpoint, many servers.** Child MCP servers (stdio or Streamable HTTP) are exposed as `<server>__<tool>`.
- **OIDC sign-in.** Clients authenticate with an OIDC provider. [authentik](https://goauthentik.io/) is the reference setup.
- **Per-tool policy.** Each tool gets one of these decisions per user group (`*` for everyone):
  - `allow`: the call goes through.
  - `ask`: the user approves each call through MCP elicitation. Clients without elicitation get a link to an approval page instead.
  - `deny`: the tool is hidden and calls are rejected.
- **Code Mode.** A tool that runs model-written TypeScript which calls the child tools as typed async functions. The script runs in a QuickJS WebAssembly sandbox with no I/O other than those tool calls.
- **Observability.** OpenTelemetry traces, metrics and logs. The bundled stack:
  - Grafana: UI, with sign-in through the same OIDC provider
  - Tempo: traces
  - Loki: logs
  - Prometheus: metrics

## Status

Design phase. Nothing is runnable yet. The design (in Japanese) is [docs/design.md](docs/design.md).

## Security model

- **Who can use it.** The gateway accepts only access tokens issued by the configured OIDC provider for the configured client. The provider's own access policy decides who can sign in.
- **Tokens stay with the gateway.**
  - The token a client sends is never forwarded to a child server.
  - Child servers get credentials that the operator configures per server.
- **Per-user scope.** Policy is evaluated per user and per call.
  - `deny` tools are hidden and rejected.
  - Approvals, suspended requests and approval pages are bound to the user who made the request.
- **Code Mode has no ambient I/O.** Scripts run in a fresh QuickJS WebAssembly context per run. Every tool call from a script goes through the same policy and approval as a direct call. Scripts have none of the following:
  - network
  - filesystem
  - environment variables
  - timers
  - storage that outlives a run
- **Trusted.**
  - The host the gateway runs on.
  - The child servers an operator registers.
  - The OIDC provider.
  - The observability backend.
- **Observability data is sensitive.** Logs contain Code Mode source and audit records; traces carry the source's hash and size. Restrict the observability UI to administrators.

## License

[Apache License 2.0](LICENSE)
