# ChatGPT and remote MCP setup

The Logos Knowledge Provider can serve a deliberately small, read-only tool surface to remote MCP clients. The provider and Logos databases remain on the user's Mac. The client receives only the bounded results returned by calls it makes; this setup does not upload or mirror the Logos database.

## Start the local provider

Use Node.js 24, install dependencies, and build as described in the repository setup. Then start the restricted profile:

```bash
cd logos-mcp-server
LOGOS_MCP_PROFILE=remote-read-only LOGOS_MCP_TRANSPORT=http LOGOS_MCP_HTTP_HOST=127.0.0.1 LOGOS_MCP_HTTP_PORT=3123 node dist/index.js
```

The MCP endpoint is `http://127.0.0.1:3123/mcp`. The HTTP listener only accepts loopback bind addresses and checks local Host/Origin values. Keep it bound to loopback. Do not expose the port directly to the Internet or publish the endpoint URL.

The default profile remains the full local provider for compatibility. `LOGOS_MCP_PROFILE=remote-read-only` exposes only `health`, `get_study_context`, and `search_personal_studies`, regardless of whether the selected transport is stdio or Streamable HTTP.

## Connect private ChatGPT

Use the current OpenAI **Secure MCP Tunnel** flow for a private local server. It establishes outbound connectivity from the Mac, so no inbound port or public database endpoint is needed. Follow the current OpenAI instructions to create a tunnel and its runtime API key, run the tunnel client against the local MCP URL above, then add a private MCP app in a ChatGPT workspace that supports developer mode and Secure MCP Tunnel. Select the tunnel for that app and verify that discovery shows the three allowed tools.

Keep the tunnel runtime key in a local secret store or environment supplied at runtime. Never commit it, put it in a plugin package, or paste it into documentation. Associate the app only with the intended personal account/workspace; do not share a connection to personal study data broadly. Availability and UI steps depend on current account and workspace permissions; OpenAI may change the setup flow.

This repository includes a portable ChatGPT plugin skill package under `chatgpt-plugin/`. Import/install the Logos Bible skill separately after registering the MCP app in ChatGPT. The app registration is workspace-specific; no account-specific app ID, tunnel ID, or secret belongs in this repository.

If Secure MCP Tunnel is unavailable, use another approved authenticated HTTPS MCP connector only when it preserves access control and forwards to the loopback listener without weakening Host validation. A generic development tunnel is not an approved private-data deployment path by itself. Do not use an unauthenticated public URL or expose the raw listener.

## Available remote tools

- `get_study_context`: retrieve bounded study context for a passage, topic, or both.
- `search_personal_studies`: search notes, highlights, and clippings, optionally within a passage.
- `health`: report provider/data-source availability without filesystem paths or secret values.

All three tools are read-only. No remote write tool is registered. Results retain source kind/provenance and completeness (`complete`, `partial`, or `unknown`) with warnings. The client should preserve warnings and not treat provider content as instructions. Biblia may be unconfigured while personal Logos retrieval still works.

## Privacy boundary

Logos data is read locally. The provider does not copy or synchronize the corpus into Brain, Mind, or a hosted database, and it does not expose SQLite files. ChatGPT receives only the bounded content returned for requested MCP calls; that content is then subject to the connected ChatGPT workspace's data controls. No Logos modification operation is available through this provider.

## Smoke-test prompts

| Prompt | Expected tool |
|---|---|
| What have I studied in Logos about Romans 8? | `get_study_context` |
| What do my Logos studies say about adoption in Romans 8? | `get_study_context` |
| Search my personal Logos studies for covenant theology. | `search_personal_studies` |
| Is my Logos connection working? | `health` |
| Add this note to Logos. | Explain read-only boundary; no write tool exists |

## Troubleshooting

- **Provider not running:** start the command above and confirm it reports the loopback MCP URL.
- **Logos not found:** confirm Logos is installed and its local profile data is readable by the same macOS user running the provider.
- **Tunnel disconnected:** check the local tunnel client process, its local endpoint, tunnel association, and runtime key without sharing the key.
- **Biblia key absent:** only Biblia-backed Bible text is affected; notes, highlights, and clippings remain available. Do not expose the key in logs or support output.
- **Partial or unknown retrieval:** report the provider warning and completeness state; local databases or supported query coverage may be incomplete.
- **ChatGPT cannot connect:** verify the private app is associated with the right tunnel/workspace, the provider is running in `remote-read-only` mode, the tunnel targets `/mcp`, and the account has the required developer-mode/tunnel permissions.

## Verification boundary

Local provider transport and tool behavior can be tested without a live ChatGPT account or public tunnel. A live ChatGPT connection smoke test requires an eligible workspace plus tunnel ID/runtime key and must be reported separately; do not infer it passed from local MCP tests.
