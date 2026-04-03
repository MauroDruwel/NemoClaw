---
name: nemoclaw-deploy-remote
description: Configure custom domain for the cloudflared tunnel. Use when setting up a stable domain, configuring Cloudflare tunnel routing, or deploying to production with a custom tunnel. Provisions a remote GPU VM with NemoClaw using Brev deployment. Use when deploying to a cloud GPU, setting up a remote NemoClaw instance, or configuring Brev. Describes security hardening measures applied to the NemoClaw sandbox container image. Use when reviewing container security, Docker capabilities, process limits, or sandbox hardening controls. Forwards messages between Telegram and the sandboxed OpenClaw agent. Use when setting up a Telegram bot bridge, connecting a chat interface, or configuring Telegram integration.
---

# NemoClaw Deploy Remote

Configure custom domain for the cloudflared tunnel. Use when setting up a stable domain, configuring Cloudflare tunnel routing, or deploying to production with a custom tunnel.

## Prerequisites

All options require:
- **cloudflared installed** on your host machine. Download from [Cloudflare Zero Trust](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
- **A Cloudflare account** at [dash.cloudflare.com](https://dash.cloudflare.com).
- **A domain managed by Cloudflare** (your domain must use Cloudflare's nameservers).
- The [Brev CLI](https://brev.nvidia.com) installed and authenticated.
- An NVIDIA API key from [build.nvidia.com](https://build.nvidia.com).
- NemoClaw installed locally. Follow the Quickstart (see the `nemoclaw-get-started` skill) install steps.
- A running NemoClaw sandbox, either local or remote.
- A Telegram bot token from [BotFather](https://t.me/BotFather).

By default, NemoClaw uses temporary `trycloudflare.com` URLs that change each time you restart the sandbox.
This guide shows you how to configure a stable, custom domain using Cloudflare tunnels.

Custom tunnel domains are useful for:

- **Development**: A consistent URL for testing integrations and webhooks
- **Production**: Stable domain routing for always-on assistants
- **Webhooks**: Reliable callback URLs for external services

## Step 1: Three Options

You can configure a custom domain in three ways:

1. **Option A: Tunnel Token** — Set a token in your Zero Trust dashboard (best for infrastructure/DevOps teams)
2. **Option B: Browser Login** — One-time browser authentication (best for local development)
3. **Default** — No config needed; get a free temporary `trycloudflare.com` URL (good for quick testing)

## Step 2: Option A: Tunnel Token (Zero Trust Dashboard)

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

## Step 3: Option B: Browser Login (CLI-Native)

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

## Step 4: Default Behavior (No Environment Variables)

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

## Step 5: Environment Variable Reference

| Variable | Option | Description | Required |
|----------|--------|-------------|----------|
| `CLOUDFLARE_TUNNEL_TOKEN` | A | Tunnel token from Cloudflare Zero Trust dashboard | Yes (for Option A) |
| `CLOUDFLARE_TUNNEL_HOSTNAME` | A, B | Custom domain for display (Option A) or routing (Option B) | Optional (A); Required (B) |

### Priority

If both variables are set, `CLOUDFLARE_TUNNEL_TOKEN` takes precedence. NemoClaw will use the token-based tunnel and ignore the hostname setting (though it may still display in logs).

## Step 6: When to Use Which Option

| Use Case | Recommended | Why |
|----------|-------------|-----|
| Infrastructure/DevOps team managing tunnels centrally | **Option A** | Token is stored in secrets management, no browser needed |
| Local development on your machine | **Option B** | One-time login, simple to set up |
| Quick testing or short-lived demos | **Default** | No setup, free, automatic cleanup |
| Production deployment with named routes | **Option A** | Token-based tunnels offer more control and centralized management |

## Step 7: Security Considerations

:::warning
Your tunnel domain is **publicly accessible** over the internet.

Ensure that your NemoClaw sandbox has appropriate security measures in place:

- Keep device authentication enabled in the sandbox policy.
- Use strong credentials for any services exposed through the tunnel.
- Monitor the OpenShell TUI for unexpected network requests.
- Restrict access by IP using Cloudflare firewall rules.
- Store tunnel tokens securely (never commit to version control).
:::

---

Run NemoClaw on a remote GPU instance through [Brev](https://brev.nvidia.com).
The deploy command provisions the VM, installs dependencies, and connects you to a running sandbox.

## Step 8: Quick Start

If your Brev instance is already up and you want to try NemoClaw immediately, start with the sandbox chat flow:

```console
$ nemoclaw my-assistant connect
$ openclaw tui
```

This gets you into the sandbox shell first and opens the OpenClaw chat UI right away.

If you are connecting from your local machine and still need to provision the remote VM, use `nemoclaw deploy <instance-name>` as described below.

## Step 9: Deploy the Instance

> **Warning:** The `nemoclaw deploy` command is experimental and may not work as expected.

Create a Brev instance and run the NemoClaw setup:

```console
$ nemoclaw deploy <instance-name>
```

Replace `<instance-name>` with a name for your remote instance, for example `my-gpu-box`.

The deploy script performs the following steps on the VM:

1. Installs Docker and the NVIDIA Container Toolkit if a GPU is present.
2. Installs the OpenShell CLI.
3. Runs `nemoclaw onboard` (the setup wizard) to create the gateway, register providers, and launch the sandbox.
4. Starts auxiliary services, such as the Telegram bridge and cloudflared tunnel.

By default, the tunnel uses a temporary `trycloudflare.com` URL. For production deployments with a stable custom domain, configure `NEMOCLAW_TUNNEL_HOSTNAME` or `NEMOCLAW_CLOUDFLARED_CONFIG` before running `nemoclaw deploy`. See Configure a Custom Cloudflare Tunnel Domain (see the `nemoclaw-deploy-remote` skill) for details.

## Step 10: Connect to the Remote Sandbox

After deployment finishes, the deploy command opens an interactive shell inside the remote sandbox.
To reconnect after closing the session, run the deploy command again:

```console
$ nemoclaw deploy <instance-name>
```

## Step 11: Monitor the Remote Sandbox

SSH to the instance and run the OpenShell TUI to monitor activity and approve network requests:

```console
$ ssh <instance-name> 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && openshell term'
```

## Step 12: Verify Inference

Run a test agent prompt inside the remote sandbox:

```console
$ openclaw agent --agent main --local -m "Hello from the remote sandbox" --session-id test
```

## Step 13: Remote Dashboard Access

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

> **Note:** On Brev, set `CHAT_UI_URL` in the launchable environment configuration so it is
> available when the setup script builds the sandbox image.  If `CHAT_UI_URL` is
> not set on a headless host, `brev-setup.sh` prints a warning.

## Step 14: GPU Configuration

The deploy script uses the `NEMOCLAW_GPU` environment variable to select the GPU type.
The default value is `a2-highgpu-1g:nvidia-tesla-a100:1`.
Set this variable before running `nemoclaw deploy` to use a different GPU configuration:

```console
$ export NEMOCLAW_GPU="a2-highgpu-1g:nvidia-tesla-a100:2"
$ nemoclaw deploy <instance-name>
```

---

Forward messages between a Telegram bot and the OpenClaw agent running inside the sandbox.
The Telegram bridge is an auxiliary service managed by `nemoclaw start`.

## Step 15: Create a Telegram Bot

Open Telegram and send `/newbot` to [@BotFather](https://t.me/BotFather).
Follow the prompts to create a bot and receive a bot token.

## Step 16: Set the Environment Variable

Export the bot token as an environment variable:

```console
$ export TELEGRAM_BOT_TOKEN=<your-bot-token>
```

## Step 17: Start Auxiliary Services

Start the Telegram bridge and other auxiliary services:

```console
$ nemoclaw start
```

The `start` command launches the following services:

- The Telegram bridge forwards messages between Telegram and the agent.
- The cloudflared tunnel provides external access to the sandbox.

The Telegram bridge starts only when the `TELEGRAM_BOT_TOKEN` environment variable is set.

## Step 18: Verify the Services

Check that the Telegram bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services.

## Step 19: Send a Message

Open Telegram, find your bot, and send a message.
The bridge forwards the message to the OpenClaw agent inside the sandbox and returns the agent response.

## Step 20: Restrict Access by Chat ID

To restrict which Telegram chats can interact with the agent, set the `ALLOWED_CHAT_IDS` environment variable to a comma-separated list of Telegram chat IDs:

```console
$ export ALLOWED_CHAT_IDS="123456789,987654321"
$ nemoclaw start
```

## Step 21: Stop the Services

To stop the Telegram bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Reference

- [Sandbox Image Hardening](references/sandbox-hardening.md)

## Related Skills

- `nemoclaw-reference` — Commands for the full `start` and `stop` command reference
- `nemoclaw-monitor-sandbox` — Monitor Sandbox Activity for sandbox monitoring tools
