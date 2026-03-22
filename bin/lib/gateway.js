// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Gateway container discovery — shared utilities for locating the OpenShell
// gateway container and its Docker network IP.  Used by both ollama-container
// and lmstudio-container sidecars.
//
// ── Sidecar networking trust model ──────────────────────────────
//
// Sidecar containers (Ollama, LM Studio) run with `--network container:<gateway>`,
// sharing the gateway's full network namespace.  This is a deliberate design
// choice that avoids host-networking complexity (WSL2, Colima, binding 0.0.0.0)
// by letting the sidecar and gateway share localhost.
//
// Security implications:
//
//  1. The sidecar can see all network traffic on the gateway's interfaces.
//  2. The sidecar listens on ports visible to k3s pods (this is desired — it
//     enables inference routing through the gateway).
//  3. The sidecar can also reach k3s internal services (API server, kubelet,
//     etcd) since they share the same network namespace.
//  4. Sidecar containers run as root with --gpus all and no capability drops.
//
// This is acceptable because:
//
//  - The gateway is already the trust boundary — it runs k3s and controls all
//    sandbox networking.  The sidecar does not gain privileges the gateway
//    doesn't already have.
//  - Sidecar images (ollama/ollama, lmstudio/llmster-preview) are first-party
//    or curated images, not user-supplied.
//  - The sidecar has no inbound exposure beyond inference ports (11434, 1234).
//
// Future hardening options: iptables rules inside the gateway to restrict
// sidecar-initiated connections to only the inference ports, or running
// sidecars with --cap-drop ALL and a minimal seccomp profile.

const { runCapture } = require("./runner");

const GATEWAY_CONTAINER_PREFIX = "openshell-cluster-nemoclaw";

/**
 * Find the running OpenShell gateway container name.
 */
function findGatewayContainer() {
  const output = runCapture(
    `docker ps --filter "name=${GATEWAY_CONTAINER_PREFIX}" --format '{{.Names}}' 2>/dev/null`,
    { ignoreError: true }
  );
  if (!output) return null;
  // Take the first match
  return output.split("\n").map((l) => l.trim()).filter(Boolean)[0] || null;
}

/**
 * Get the gateway container's IP address on the Docker network.
 *
 * k3s pods reach the sidecar via this IP (not 127.0.0.1, which is the pod's
 * own loopback). The sidecar shares the gateway's network namespace, so
 * the gateway IP + sidecar port routes correctly.
 */
function getGatewayIp() {
  const gateway = findGatewayContainer();
  if (!gateway) {
    console.warn("  [warn] Gateway container not found — falling back to 127.0.0.1");
    return "127.0.0.1";
  }
  const ip = runCapture(
    `docker inspect ${gateway} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null`,
    { ignoreError: true }
  );
  return ip || "127.0.0.1";
}

module.exports = {
  GATEWAY_CONTAINER_PREFIX,
  findGatewayContainer,
  getGatewayIp,
};
