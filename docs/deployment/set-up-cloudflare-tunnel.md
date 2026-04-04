---
title:
  page: "Set Up a Cloudflare Tunnel for NemoClaw"
  nav: "Set Up Cloudflare Tunnel"
description: "Expose the NemoClaw dashboard on a custom domain using a Cloudflare named tunnel."
keywords: ["nemoclaw cloudflare tunnel", "cloudflare named tunnel", "custom domain nemoclaw", "cloudflared nemoclaw"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "cloudflare", "deployment", "nemoclaw", "networking"]
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

# Set Up a Cloudflare Tunnel

Expose the NemoClaw dashboard on a stable, custom domain using a Cloudflare named tunnel.

By default, `nemoclaw start` creates a **quick tunnel** that assigns a random, ephemeral
`*.trycloudflare.com` URL on every start. This is convenient for trying things out but
unsuitable for production use — the URL changes every time.

A **named tunnel** ties the service to a domain you control in Cloudflare, giving you:

- A stable URL that never changes (e.g. `https://agent.mycompany.com`).
- Cloudflare Access policies for authentication and access control.
- Persistent routing configuration managed in the Cloudflare Zero Trust dashboard.

## Prerequisites

- `cloudflared` installed (`brev-setup.sh` installs it automatically; see [brev-setup.sh](../../scripts/brev-setup.sh)).
- A Cloudflare account with a domain whose DNS is managed by Cloudflare.
- NemoClaw installed and a sandbox running. Follow the [Quickstart](../get-started/quickstart.md).

## Step 1: Create a Named Tunnel in Cloudflare

1. Open the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com).
2. Navigate to **Networks → Tunnels → Create a tunnel**.
3. Select **Cloudflared** as the connector type.
4. Enter a tunnel name (for example, `nemoclaw-prod`) and click **Save tunnel**.
5. Copy the **tunnel token** displayed on the next screen. It begins with `eyJ…`.

## Step 2: Configure a Public Hostname

Still in the tunnel configuration:

1. Click **Add a public hostname**.
2. Set the fields:
   - **Subdomain**: the subdomain you want, e.g. `agent`
   - **Domain**: the domain managed in your Cloudflare account, e.g. `mycompany.com`
   - **Service type**: `HTTP`
   - **URL**: `localhost:18789` (or the value of `DASHBOARD_PORT` if you changed it)
3. Click **Save hostname**.

The full public URL will be `https://agent.mycompany.com`.

## Step 3: Export Environment Variables

```console
$ export CLOUDFLARE_TUNNEL_TOKEN=eyJ...
```

`CLOUDFLARE_TUNNEL_TOKEN` switches `nemoclaw start` from quick-tunnel mode to named-tunnel
mode. The hostname and routing are configured in the Cloudflare dashboard above — no local
variable is needed.

## Step 4: Start Services

```console
$ nemoclaw start
```

The banner prints the custom domain once `cloudflared` has loaded its ingress configuration:

```
  ┌─────────────────────────────────────────────────────┐
  │  NemoClaw Services                                  │
  │                                                     │
  │  Public URL:  https://agent.mycompany.com           │
  │  Telegram:    not started (no token)                │
  │                                                     │
  │  Run 'openshell term' to monitor egress approvals   │
  └─────────────────────────────────────────────────────┘
```

## Step 5: Verify the Tunnel

```console
$ nemoclaw status
```

Check that the `cloudflared` service shows as running and the public URL matches your domain.

You can also verify from the Cloudflare dashboard under **Networks → Tunnels** — the tunnel
status should change to **Healthy** within a few seconds of starting.

## Persisting the Configuration

To avoid exporting the variables on every shell session, add them to your shell profile or a
`.env` file that is sourced before running `nemoclaw start`:

```bash
# ~/.nemoclaw/.env  (mode 600 — keep this file private)
export CLOUDFLARE_TUNNEL_TOKEN=eyJ...
```

```console
$ source ~/.nemoclaw/.env
$ nemoclaw start
```

:::{warning}
`CLOUDFLARE_TUNNEL_TOKEN` grants full control of your Cloudflare tunnel.
Store it with the same care as an API key — never commit it to source control.
:::

## Stop the Services

```console
$ nemoclaw stop
```

This stops `cloudflared` and any other auxiliary services. The Cloudflare tunnel itself
remains configured in the dashboard and reconnects automatically the next time you run
`nemoclaw start` with the same token.

## Troubleshooting

**`cloudflared` not found**
: Install via `scripts/brev-setup.sh` or download directly from the
  [cloudflared releases page](https://github.com/cloudflare/cloudflared/releases).

**Tunnel shows "Inactive" in the dashboard**
: Make sure `nemoclaw start` completed without errors and `nemoclaw status` shows
  `cloudflared` as running.

**Custom hostname not resolving**
: Check that the domain's DNS is managed by Cloudflare (nameservers point to Cloudflare)
  and that the public hostname was saved in the tunnel configuration.

**Quick tunnel still used instead of named tunnel**
: Verify `CLOUDFLARE_TUNNEL_TOKEN` is exported in the current shell before running
  `nemoclaw start`.

## Related Topics

- [Set Up the Telegram Bridge](set-up-telegram-bridge.md) — combine with a named tunnel for a stable Telegram-accessible agent.
- [Deploy NemoClaw to a Remote GPU Instance](deploy-to-remote-gpu.md) — run on a Brev GPU VM with a public URL.
- [Commands](../reference/commands.md) — full `start`, `stop`, and `status` command reference.
