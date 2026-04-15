---
name: "nemoclaw-user-deploy-remote"
description: "Explains how to run NemoClaw on a remote GPU instance, including the deprecated Brev compatibility path and the preferred installer plus onboard flow. Describes security hardening measures applied to the NemoClaw sandbox container image. Use when reviewing container security, Docker capabilities, process limits, or sandbox hardening controls. Exposes the NemoClaw dashboard on a custom domain using a Cloudflare named tunnel. Explains how Telegram reaches the sandboxed OpenClaw agent through OpenShell-managed processes and onboarding-time channel configuration. Use when setting up Telegram, a chat interface, or messaging integration without relying on nemoclaw start for bridges."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw User Deploy Remote

Explains how to run NemoClaw on a remote GPU instance, including the deprecated Brev compatibility path and the preferred installer plus onboard flow.

## Prerequisites

- The [Brev CLI](https://brev.nvidia.com) installed and authenticated.
- A provider credential for the inference backend you want to use during onboarding.
- NemoClaw installed locally if you plan to use the deprecated `nemoclaw deploy` wrapper. Otherwise, install NemoClaw directly on the remote host after provisioning it.
- `cloudflared` installed (`brev-setup.sh` installs it automatically; see [brev-setup.sh](../../scripts/brev-setup.sh)).
- A Cloudflare account with a domain whose DNS is managed by Cloudflare.
- NemoClaw installed and a sandbox running.
- A machine where you can run `nemoclaw onboard` (local or remote host that runs the gateway and sandbox).
- A Telegram bot token from [BotFather](https://t.me/BotFather).

Run NemoClaw on a remote GPU instance through [Brev](https://brev.nvidia.com).
The preferred path is to provision the VM, run the standard NemoClaw installer on that host, and then run `nemoclaw onboard`.

## Step 1: Quick Start

If your Brev instance is already up and has already been onboarded with a sandbox, start with the standard sandbox chat flow:

```console
$ nemoclaw my-assistant connect
$ openclaw tui
```

This gets you into the sandbox shell first and opens the OpenClaw chat UI right away.
If the VM is fresh, run the standard installer on that host and then run `nemoclaw onboard` before trying `nemoclaw my-assistant connect`.

If you are connecting from your local machine and still need to provision the remote VM, you can still use `nemoclaw deploy <instance-name>` as the legacy compatibility path described below.

## Step 2: Deploy the Instance

> **Warning:** The `nemoclaw deploy` command is deprecated.
> Prefer provisioning the remote host separately, then running the standard NemoClaw installer and `nemoclaw onboard` on that host.

Create a Brev instance and run the legacy compatibility flow:

```console
$ nemoclaw deploy <instance-name>
```

Replace `<instance-name>` with a name for your remote instance, for example `my-gpu-box`.

The legacy compatibility flow performs the following steps on the VM:

1. Installs Docker and the NVIDIA Container Toolkit if a GPU is present.
2. Installs the OpenShell CLI.
3. Runs `nemoclaw onboard` (the setup wizard) to create the gateway, register providers, and launch the sandbox.
4. Starts optional host auxiliary services (for example the cloudflared tunnel) when `cloudflared` is available. Channel messaging is configured during onboarding and runs through OpenShell-managed processes, not through `nemoclaw start`.

By default, the compatibility wrapper asks Brev to provision on `gcp`. Override this with `NEMOCLAW_BREV_PROVIDER` if you need a different Brev cloud provider.

## Step 3: Connect to the Remote Sandbox

After deployment finishes, the deploy command opens an interactive shell inside the remote sandbox.
To reconnect after closing the session, run the command again:

```console
$ nemoclaw deploy <instance-name>
```

## Step 4: Monitor the Remote Sandbox

SSH to the instance and run the OpenShell TUI to monitor activity and approve network requests:

```console
$ ssh <instance-name> 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && openshell term'
```

## Step 5: Verify Inference

Run a test agent prompt inside the remote sandbox:

```console
$ openclaw agent --agent main --local -m "Hello from the remote sandbox" --session-id test
```

## Step 6: Remote Dashboard Access

The NemoClaw dashboard validates the browser origin against an allowlist baked
into the sandbox image at build time.  By default the allowlist only contains
`http://127.0.0.1:18789`.  When accessing the dashboard from a remote browser
(for example through a Brev public URL or an SSH port-forward), set
`CHAT_UI_URL` to the origin the browser will use **before** running setup:

```console
$ export CHAT_UI_URL="https://openclaw0-<id>.brevlab.com"
$ nemoclaw deploy <instance-name>
```

For SSH port-forwarding, the origin is typically `http://127.0.0.1:18789` (the
default), so no extra configuration is needed.

> **Warning:** On Brev, set `CHAT_UI_URL` in the launchable environment configuration so it is
> available when the installer builds the sandbox image. If `CHAT_UI_URL` is not
> set on a headless host, the compatibility wrapper prints a warning.
>
> `NEMOCLAW_DISABLE_DEVICE_AUTH` is also evaluated at image build time.
> If you disable device auth for a remote deployment, any device that can reach the dashboard origin can connect without pairing.
> Avoid this on internet-reachable or shared-network deployments.

## Step 7: Proxy Configuration

NemoClaw routes sandbox traffic through a gateway proxy that defaults to `10.200.0.1:3128`.
If your network requires a different proxy, set `NEMOCLAW_PROXY_HOST` and `NEMOCLAW_PROXY_PORT` before onboarding:

```console
$ export NEMOCLAW_PROXY_HOST=proxy.example.com
$ export NEMOCLAW_PROXY_PORT=8080
$ nemoclaw onboard
```

These values are baked into the sandbox image at build time.
Only alphanumeric characters, dots, hyphens, and colons are accepted for the host.
The port must be numeric (0-65535).
Changing the proxy after onboarding requires re-running `nemoclaw onboard`.

## Step 8: GPU Configuration

The deploy script uses the `NEMOCLAW_GPU` environment variable to select the GPU type.
The default value is `a2-highgpu-1g:nvidia-tesla-a100:1`.
Set this variable before running `nemoclaw deploy` to use a different GPU configuration:

```console
$ export NEMOCLAW_GPU="a2-highgpu-1g:nvidia-tesla-a100:2"
$ nemoclaw deploy <instance-name>
```

---

Expose the NemoClaw dashboard on a stable, custom domain using a Cloudflare named tunnel.

By default, `nemoclaw start` creates a **quick tunnel** that assigns a random, ephemeral `*.trycloudflare.com` URL on every start.
This is convenient for trying things out but unsuitable for production use.
The URL changes every time.

A **named tunnel** ties the service to a domain you control in Cloudflare, giving you:

- A stable URL that never changes (e.g. `https://agent.mycompany.com`).
- Cloudflare Access policies for authentication and access control.
- Persistent routing configuration managed in the Cloudflare Zero Trust dashboard.

## Step 9: Create a Named Tunnel in Cloudflare

Create the tunnel and copy its token from the Cloudflare Zero Trust dashboard.

1. Open the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com).
2. Navigate to **Networks → Tunnels → Create a tunnel**.
3. Select **Cloudflared** as the connector type.
4. Enter a tunnel name (for example, `nemoclaw-prod`) and click **Save tunnel**.
5. Copy the **tunnel token** displayed on the next screen.
   It begins with `eyJ…`.

## Step 10: Configure a Public Hostname

Map the tunnel to the local dashboard port using a public hostname.

Still in the tunnel configuration:

1. Click **Add a public hostname**.
2. Set the fields:
   - For **Subdomain**, enter the subdomain you want, e.g. `agent`.
   - For **Domain**, select the domain managed in your Cloudflare account, e.g. `mycompany.com`.
   - For **Service type**, select `HTTP`.
   - For **URL**, enter `localhost:18789` (or the value of `DASHBOARD_PORT` if you changed it).
3. Click **Save hostname**.

The full public URL is `https://agent.mycompany.com`.

## Step 11: Export Environment Variables

Set the tunnel token so `nemoclaw start` uses the named tunnel instead of a quick tunnel.

```console
$ export CLOUDFLARE_TUNNEL_TOKEN=eyJ...
```

`CLOUDFLARE_TUNNEL_TOKEN` switches `nemoclaw start` from quick-tunnel mode to named-tunnel mode.
The hostname and routing are configured in the Cloudflare dashboard above.
No local variable is needed for the hostname.

## Step 12: Start Services

Run `nemoclaw start` to launch `cloudflared` and any other configured auxiliary services.

```console
$ nemoclaw start
```

The banner prints the custom domain once `cloudflared` has loaded its ingress configuration:

```text
  ┌─────────────────────────────────────────────────────┐
  │  NemoClaw Services                                  │
  │                                                     │
  │  Public URL:  https://agent.mycompany.com           │
  │  Messaging:   via OpenClaw native channels (if configured) │
  │                                                     │
  │  Run 'openshell term' to monitor egress approvals   │
  └─────────────────────────────────────────────────────┘
```

## Step 13: Verify the Tunnel

Confirm that `cloudflared` is running and the tunnel is active.

```console
$ nemoclaw status
```

Check that the `cloudflared` service shows as running and the public URL matches your domain.
You can also verify from the Cloudflare dashboard under **Networks → Tunnels**.
The tunnel status should change to **Healthy** within a few seconds of starting.

## Step 14: Persisting the Configuration

To avoid exporting the token on every shell session, add it to a `.env` file sourced before running `nemoclaw start`.

```bash
# ~/.nemoclaw/.env  (mode 600 — keep this file private)
export CLOUDFLARE_TUNNEL_TOKEN=eyJ...
```

```console
$ source ~/.nemoclaw/.env
$ nemoclaw start
```

> **Warning:** `CLOUDFLARE_TUNNEL_TOKEN` grants full control of your Cloudflare tunnel.
> Store it with the same care as an API key — never commit it to source control.

## Step 15: Stop the Services

Run `nemoclaw stop` to shut down `cloudflared` and all other auxiliary services.

```console
$ nemoclaw stop
```

This stops `cloudflared` and any other auxiliary services.
The Cloudflare tunnel itself remains configured in the dashboard and reconnects automatically the next time you run `nemoclaw start` with the same token.

---

Telegram, Discord, and Slack reach your agent through OpenShell-managed processes and gateway constructs.
NemoClaw configures those channels during `nemoclaw onboard`. Tokens are registered with OpenShell providers, channel configuration is baked into the sandbox image, and runtime delivery stays under OpenShell control.

`nemoclaw start` does not start Telegram (or other chat bridges). It only starts optional host services such as the cloudflared tunnel when that binary is present.
For details, refer to Commands (see the `nemoclaw-user-reference` skill).

## Step 16: Create a Telegram Bot

Open Telegram and send `/newbot` to [@BotFather](https://t.me/BotFather).
Follow the prompts to create a bot and copy the bot token.

## Step 17: Provide the Bot Token and Optional Allowlist

Onboarding reads Telegram credentials from either host environment variables or the NemoClaw credential store (`getCredential` / `saveCredential` in the onboard flow). You do not have to export variables if you enter the token when the wizard asks.

### Option A: Environment variables (CI, scripts, or before you start the wizard)

```console
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
```

Optional comma-separated allowlist (maps to the wizard field “Telegram User ID (for DM access)”):

```console
$ export TELEGRAM_ALLOWED_IDS="123456789,987654321"
```

### Option B: Interactive `nemoclaw onboard`

When the wizard reaches **Messaging channels**, it lists Telegram, Discord, and Slack.
Press **1** to toggle Telegram on or off, then **Enter** when done.
If the token is not already in the environment or credential store, the wizard prompts for it and saves it to the store.
If `TELEGRAM_ALLOWED_IDS` is not set, the wizard can prompt for allowed sender IDs for Telegram DMs (you can leave this blank and rely on OpenClaw pairing instead).
NemoClaw applies that allowlist to Telegram DMs only.
Group chats stay open by default so rebuilt sandboxes do not silently drop Telegram group messages because of an empty group allowlist.

## Step 18: Run `nemoclaw onboard`

Complete the rest of the wizard so the blueprint can create OpenShell providers (for example `<sandbox>-telegram-bridge`), bake channel configuration into the image (`NEMOCLAW_MESSAGING_CHANNELS_B64`), and start the sandbox.

Channel entries in `/sandbox/.openclaw/openclaw.json` are fixed at image build time. Landlock keeps that path read-only at runtime, so you cannot patch messaging config inside a running sandbox.

If you add or change `TELEGRAM_BOT_TOKEN` (or toggle channels) after a sandbox already exists, you typically need to run `nemoclaw onboard` again so the image and provider attachments are rebuilt with the new settings.

For a full first-time flow, refer to Quickstart (see the `nemoclaw-user-get-started` skill).

## Step 19: Confirm Delivery

After the sandbox is running, send a message to your bot in Telegram.
If something fails, use `openshell term` on the host, check gateway logs, and verify network policy allows the Telegram API (see Customize the Network Policy (see the `nemoclaw-user-manage-policy` skill) and the `telegram` preset).

## Step 20: `nemoclaw start` (cloudflared Only)

`nemoclaw start` starts cloudflared when it is installed, which can expose the dashboard with a public URL.
It does not affect Telegram connectivity.

```console
$ nemoclaw start
```

## Reference

- [Sandbox Image Hardening](references/sandbox-hardening.md)

## Related Skills

- `nemoclaw-user-monitor-sandbox` — Monitor Sandbox Activity for sandbox monitoring tools
- `nemoclaw-user-reference` — Commands for the full `deploy` command reference
