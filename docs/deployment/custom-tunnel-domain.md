---
title:
  page: "Configure a Custom Cloudflare Tunnel Domain for NemoClaw"
  nav: "Custom Tunnel Domain"
description:
  main: "Set up a stable, predictable domain for your NemoClaw sandbox using Cloudflare tunnels."
  agent: "Configure custom domain for the cloudflared tunnel. Use when setting up a stable domain, configuring Cloudflare tunnel routing, or deploying to production with a named tunnel."
keywords: ["nemoclaw cloudflare tunnel domain", "custom tunnel domain", "cloudflared config"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "deployment", "cloudflare", "tunnel", "nemoclaw"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Configure a Custom Cloudflare Tunnel Domain

By default, NemoClaw uses temporary `trycloudflare.com` URLs that change each time you restart the sandbox.
This guide shows you how to configure a stable, custom domain for predictable external access to your sandbox.

Cloudflare tunnel domains are useful for:
- **Development**: A consistent URL for testing integrations
- **Webhooks**: Reliable callback URLs for external services
- **Production**: Stable domain routing for production deployments

## Prerequisites

Before you begin, ensure you have:

- **cloudflared installed** on your host machine. Download from [Cloudflare Zero Trust](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
- **A Cloudflare account** at [dash.cloudflare.com](https://dash.cloudflare.com).
- **A domain managed by Cloudflare**. The domain must be set up as a Cloudflare zone so the tunnel can route traffic to it.

## Option A: Quick Tunnel with a Custom Hostname

Use this approach for development and testing. Quick tunnels use legacy tunnel authentication and do not require creating a named tunnel.

### Step 1: Authenticate with Cloudflare

Authenticate `cloudflared` with your Cloudflare account:

```bash
$ cloudflared login
```

A browser window opens automatically. Sign in with your Cloudflare account and authorize `cloudflared` to create tunnels on your behalf.
After authorization, `cloudflared` saves your credentials locally.

### Step 2: Set the Custom Hostname Environment Variable

Export the environment variable with your custom domain:

```bash
$ export NEMOCLAW_TUNNEL_HOSTNAME=clawie.example.com
```

Replace `clawie.example.com` with your domain. The domain must be managed by your Cloudflare zone.

### Step 3: Start NemoClaw

Start the sandbox and auxiliary services:

```bash
$ nemoclaw start
```

The cloudflared tunnel will use your custom hostname. When the tunnel is ready, you will see output showing the URL:

```
Tunnel running at https://clawie.example.com
```

:::note
Quick tunnels use legacy tunnel authentication. For production deployments with more control over tunnel routing and credentials, see **Option B: Named Tunnel (Recommended for Production)** below.
:::

## Option B: Named Tunnel (Recommended for Production)

Use this approach for production deployments. Named tunnels provide:
- Persistent tunnel credentials tied to a specific tunnel
- Named routes for multiple destinations
- Better control over DNS routing and ingress rules
- A centralized `config.yml` for managing tunnel behavior

### Step 1: Authenticate with Cloudflare

If you haven't already, authenticate `cloudflared`:

```bash
$ cloudflared login
```

### Step 2: Create a Named Tunnel

Create a new named tunnel called `nemoclaw`:

```bash
$ cloudflared tunnel create nemoclaw
```

`cloudflared` creates a tunnel and saves its ID and credentials to `~/.cloudflared/`.
You'll see output like:

```
Tunnel credentials written to /home/user/.cloudflared/<tunnel-id>.json
Tunnel <tunnel-id> created. Manage further with the 'cloudflared' CLI or at

https://dash.cloudflare.com/dns/example.com?to=/bulk-routing/routes/tunnel/<tunnel-id>
```

Save the `<tunnel-id>` for the next step.

### Step 3: Add the Tunnel Route

Route your custom domain to the tunnel:

```bash
$ cloudflared tunnel route dns nemoclaw clawie.example.com
```

This creates a DNS CNAME record pointing `clawie.example.com` to your Cloudflare tunnel.

### Step 4: Create the Tunnel Configuration File

Create a `config.yml` file in `~/.cloudflared/config.yml`:

```yaml
# Tunnel credentials
tunnel: <tunnel-id>
credentials-file: /home/user/.cloudflared/<tunnel-id>.json

# Logging
loglevel: info

# Ingress rules route traffic to the local NemoClaw sandbox
ingress:
  # Route the custom domain to the sandbox
  - hostname: clawie.example.com
    service: http://localhost:18789
  # Catch-all for other requests
  - service: http_status:404
```

Replace:
- `<tunnel-id>` with the tunnel ID from Step 2
- `/home/user` with your home directory path
- `clawie.example.com` with your domain
- `18789` with the sandbox dashboard port (usually 18789)

:::warning
Keep the `credentials-file` path consistent. The credentials file must be readable and contain valid tunnel credentials.
:::

### Step 5: Set the Configuration Path Environment Variable

Export the path to your configuration file:

```bash
$ export NEMOCLAW_CLOUDFLARED_CONFIG=~/.cloudflared/config.yml
```

### Step 6: Start NemoClaw

Start the sandbox and tunnel:

```bash
$ nemoclaw start
```

The cloudflared tunnel will use your named tunnel and the custom domain configured in `config.yml`:

```
Tunnel running at https://clawie.example.com
```

## Default Behavior (No Environment Variables)

If neither `NEMOCLAW_TUNNEL_HOSTNAME` nor `NEMOCLAW_CLOUDFLARED_CONFIG` is set, NemoClaw uses the default temporary tunnel:

```bash
$ nemoclaw start
```

This creates a temporary `trycloudflare.com` URL that is valid for 24 hours. The URL changes each time you restart the tunnel.

Use this for:
- Local testing and development
- Short-lived demos
- Situations where a stable domain is not required

## Environment Variable Priority

NemoClaw checks environment variables in this order:

1. **`NEMOCLAW_CLOUDFLARED_CONFIG`** — Path to a `config.yml` file (takes precedence)
2. **`NEMOCLAW_TUNNEL_HOSTNAME`** — Custom domain with quick tunnel authentication
3. **Default** — Temporary `trycloudflare.com` URL

If both variables are set, `NEMOCLAW_CLOUDFLARED_CONFIG` is used.

## Security Considerations

:::warning
Your tunnel domain is **publicly accessible** over the internet.
Ensure that your NemoClaw sandbox has appropriate security measures in place:

- Keep device authentication enabled in the sandbox policy.
- Use strong credentials for any services exposed through the tunnel.
- Monitor the OpenShell TUI for unexpected network requests.
- Restrict access by IP if possible using Cloudflare firewall rules.
:::

## Troubleshooting

### Tunnel fails to start

- Verify `cloudflared` is installed: `cloudflared --version`
- Verify you are authenticated: `cloudflared tunnel list`
- Check that the domain is managed by your Cloudflare zone

### "Permission denied" on credentials file

Ensure the credentials file in `~/.cloudflared/` is readable:

```bash
$ ls -la ~/.cloudflared/<tunnel-id>.json
```

The file should have `600` or `644` permissions.

### DNS not resolving

- Verify the tunnel route was created: `cloudflared tunnel route list`
- Check your Cloudflare dashboard for the CNAME record
- Wait a few minutes for DNS propagation

## Related Topics

- [Deploy NemoClaw to a Remote GPU Instance](deploy-to-remote-gpu.md) for remote deployment with custom domains.
- [Set Up the Telegram Bridge](set-up-telegram-bridge.md) to integrate Telegram chat with your sandbox.
- [Commands](../reference/commands.md) for the full `start` and `stop` command reference.
