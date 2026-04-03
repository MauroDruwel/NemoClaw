---
title:
  page: "Configure a Custom Cloudflare Tunnel Domain for NemoClaw"
  nav: "Custom Tunnel Domain"
description:
  main: "Set up a stable, predictable domain for your NemoClaw sandbox using Cloudflare tunnels."
  agent: "Configure custom domain for the cloudflared tunnel. Use when setting up a stable domain, configuring Cloudflare tunnel routing, or deploying to production with a custom tunnel."
keywords: ["nemoclaw cloudflare tunnel domain", "custom tunnel domain", "cloudflare tunnel token", "cloudflared config"]
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
This guide shows you how to configure a stable, custom domain using Cloudflare tunnels.

Custom tunnel domains are useful for:

- **Development**: A consistent URL for testing integrations and webhooks
- **Production**: Stable domain routing for always-on assistants
- **Webhooks**: Reliable callback URLs for external services

## Three Options

You can configure a custom domain in three ways:

1. **Option A: Tunnel Token** — Set a token in your Zero Trust dashboard (best for infrastructure/DevOps teams)
2. **Option B: Browser Login** — One-time browser authentication (best for local development)
3. **Default** — No config needed; get a free temporary `trycloudflare.com` URL (good for quick testing)

## Prerequisites

All options require:

- **cloudflared installed** on your host machine. Download from [Cloudflare Zero Trust](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
- **A Cloudflare account** at [dash.cloudflare.com](https://dash.cloudflare.com).

For Options A and B, you also need:

- **A domain managed by Cloudflare** (your domain must use Cloudflare's nameservers).

## Option A: Tunnel Token (Zero Trust Dashboard)

Use this approach if you manage Cloudflare infrastructure through the dashboard or have organizational tunnel policies.
The token encodes all tunnel settings, so you don't need to set hostname separately.
**The hostname environment variable is optional and only affects the banner display.**

### Prerequisites

- Cloudflare account with Zero Trust enabled
- A Cloudflare-managed domain

### Step 1: Create a Tunnel in Zero Trust Dashboard

1. Sign in to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/).
2. Go to **Networks** > **Tunnels**.
3. Click **Create a tunnel**.
4. Enter a name (e.g., `nemoclaw`) and click **Save tunnel**.
5. Select the environment (Linux/Mac/Windows/Docker).
6. Copy the installation and token. Save this for the next step.

### Step 2: Set the Token Environment Variable

Export the tunnel token:

```bash
$ export CLOUDFLARE_TUNNEL_TOKEN="<your-token-here>"
```

### Step 3: (Optional) Set the Hostname for Display

If you want NemoClaw to show a custom domain in the startup banner, also set:

```bash
$ export CLOUDFLARE_TUNNEL_HOSTNAME=clawie.example.com
```

This is purely for display — the token controls the actual routing.

### Step 4: Start NemoClaw

Start the sandbox and tunnel:

```bash
$ nemoclaw start
```

The tunnel will start with your token. You should see output like:

```bash
Tunnel running at https://clawie.example.com
```

Or if you didn't set the hostname, you'll see the actual tunnel URL from your dashboard.

## Option B: Browser Login (CLI-Native)

Use this approach for local development or if you prefer one-time browser authentication.
**Both environment variables are required for this option.**

### Prerequisites

- Cloudflare account with a domain on Cloudflare-managed DNS
- One-time browser access to authorize cloudflared

### Step 1: Authenticate with Cloudflare (Browser)

Run the login command:

```bash
$ cloudflared login
```

A browser window opens automatically. Sign in with your Cloudflare account and authorize `cloudflared` to manage tunnels.
After authorization, your credentials are saved locally.

### Step 2: Set the Hostname Environment Variable

Export your custom domain:

```bash
$ export CLOUDFLARE_TUNNEL_HOSTNAME=clawie.example.com
```

Replace `clawie.example.com` with your domain. The domain must be on a Cloudflare-managed DNS zone.

### Step 3: Start NemoClaw

Start the sandbox and tunnel:

```bash
$ nemoclaw start
```

NemoClaw passes your hostname to cloudflared, which handles DNS setup automatically:

```bash
Tunnel running at https://clawie.example.com
```

:::note
Behind the scenes, NemoClaw runs:

```bash
cloudflared tunnel --hostname clawie.example.com run
```

The credentials from `cloudflared login` are automatically picked up.
:::

## Default Behavior (No Environment Variables)

If you don't set `CLOUDFLARE_TUNNEL_TOKEN` or `CLOUDFLARE_TUNNEL_HOSTNAME`, NemoClaw uses the default temporary tunnel:

```bash
$ nemoclaw start
```

This creates a free, temporary `trycloudflare.com` URL that is valid for 24 hours. The URL changes each time you restart the tunnel.

Use this for:

- Quick testing and demos
- Local development
- Short-lived connections

Example output:

```bash
Tunnel running at https://randomly-generated-url.trycloudflare.com
```

## Environment Variable Reference

| Variable | Option | Description | Required |
|----------|--------|-------------|----------|
| `CLOUDFLARE_TUNNEL_TOKEN` | A | Tunnel token from Cloudflare Zero Trust dashboard | Yes (for Option A) |
| `CLOUDFLARE_TUNNEL_HOSTNAME` | A, B | Custom domain for display (Option A) or routing (Option B) | Optional (A); Required (B) |

### Priority

If both variables are set, `CLOUDFLARE_TUNNEL_TOKEN` takes precedence. NemoClaw will use the token-based tunnel and ignore the hostname setting (though it may still display in logs).

## When to Use Which Option

| Use Case | Recommended | Why |
|----------|-------------|-----|
| Infrastructure/DevOps team managing tunnels centrally | **Option A** | Token is stored in secrets management, no browser needed |
| Local development on your machine | **Option B** | One-time login, simple to set up |
| Quick testing or short-lived demos | **Default** | No setup, free, automatic cleanup |
| Production deployment with named routes | **Option A** | Token-based tunnels offer more control and centralized management |

## Security Considerations

:::warning
Your tunnel domain is **publicly accessible** over the internet.

Ensure that your NemoClaw sandbox has appropriate security measures in place:

- Keep device authentication enabled in the sandbox policy.
- Use strong credentials for any services exposed through the tunnel.
- Monitor the OpenShell TUI for unexpected network requests.
- Restrict access by IP using Cloudflare firewall rules.
- Store tunnel tokens securely (never commit to version control).
:::

## Troubleshooting

### Tunnel fails to start

- Verify `cloudflared` is installed: `cloudflared --version`
- For Option B, verify you are authenticated: `cloudflared tunnel list`
- For Option A, check that the token is valid and not expired

### "Tunnel not found" error

- For Option B: Run `cloudflared login` again
- For Option A: Verify the token is correct and the tunnel exists in your Cloudflare dashboard
- Ensure the domain is on a Cloudflare-managed DNS zone

### Custom hostname not resolving

- For Option B: Wait a few minutes for DNS propagation
- Check the Cloudflare dashboard for CNAME records
- Verify the domain is in your Cloudflare zone

## Related Topics

- [Deploy NemoClaw to a Remote GPU Instance](deploy-to-remote-gpu.md) for remote deployment with custom domains.
- [Set Up the Telegram Bridge](set-up-telegram-bridge.md) to integrate Telegram chat with your sandbox.
- [Commands](../reference/commands.md) for the full `start` and `stop` command reference.
