// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");

const SESSION_VERSION = 1;
const SESSION_DIR = path.join(process.env.HOME || "/tmp", ".nemoclaw");
const SESSION_FILE = path.join(SESSION_DIR, "onboard-session.json");
const VALID_STEP_STATES = new Set(["pending", "in_progress", "complete", "failed", "skipped"]);

function ensureSessionDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
}

function sessionPath() {
  return SESSION_FILE;
}

function defaultSteps() {
  return {
    preflight: { status: "pending", startedAt: null, completedAt: null, error: null },
    gateway: { status: "pending", startedAt: null, completedAt: null, error: null },
    sandbox: { status: "pending", startedAt: null, completedAt: null, error: null },
    provider_selection: { status: "pending", startedAt: null, completedAt: null, error: null },
    inference: { status: "pending", startedAt: null, completedAt: null, error: null },
    openclaw: { status: "pending", startedAt: null, completedAt: null, error: null },
    policies: { status: "pending", startedAt: null, completedAt: null, error: null },
  };
}

function createSession(overrides = {}) {
  const now = new Date().toISOString();
  return {
    version: SESSION_VERSION,
    sessionId: overrides.sessionId || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    resumable: true,
    status: "in_progress",
    mode: overrides.mode || "interactive",
    startedAt: overrides.startedAt || now,
    updatedAt: overrides.updatedAt || now,
    lastStepStarted: overrides.lastStepStarted || null,
    lastCompletedStep: overrides.lastCompletedStep || null,
    failure: overrides.failure || null,
    sandboxName: overrides.sandboxName || null,
    provider: overrides.provider || null,
    model: overrides.model || null,
    metadata: {
      gatewayName: overrides.metadata?.gatewayName || "nemoclaw",
    },
    steps: {
      ...defaultSteps(),
      ...(overrides.steps || {}),
    },
  };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeFailure(input) {
  if (!input) return null;
  const step = typeof input.step === "string" ? input.step : null;
  const message = typeof input.message === "string" ? input.message.slice(0, 240) : null;
  const recordedAt = typeof input.recordedAt === "string" ? input.recordedAt : new Date().toISOString();
  return step || message ? { step, message, recordedAt } : null;
}

function validateStep(step) {
  if (!isObject(step)) return false;
  if (!VALID_STEP_STATES.has(step.status)) return false;
  return true;
}

function normalizeSession(data) {
  if (!isObject(data) || data.version !== SESSION_VERSION) return null;
  const normalized = createSession({
    sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
    mode: typeof data.mode === "string" ? data.mode : undefined,
    startedAt: typeof data.startedAt === "string" ? data.startedAt : undefined,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : undefined,
    sandboxName: typeof data.sandboxName === "string" ? data.sandboxName : null,
    provider: typeof data.provider === "string" ? data.provider : null,
    model: typeof data.model === "string" ? data.model : null,
    lastStepStarted: typeof data.lastStepStarted === "string" ? data.lastStepStarted : null,
    lastCompletedStep: typeof data.lastCompletedStep === "string" ? data.lastCompletedStep : null,
    failure: sanitizeFailure(data.failure),
    metadata: isObject(data.metadata) ? data.metadata : undefined,
  });
  normalized.resumable = data.resumable !== false;
  normalized.status = typeof data.status === "string" ? data.status : normalized.status;

  if (isObject(data.steps)) {
    for (const [name, step] of Object.entries(data.steps)) {
      if (Object.prototype.hasOwnProperty.call(normalized.steps, name) && validateStep(step)) {
        normalized.steps[name] = {
          status: step.status,
          startedAt: typeof step.startedAt === "string" ? step.startedAt : null,
          completedAt: typeof step.completedAt === "string" ? step.completedAt : null,
          error: typeof step.error === "string" ? step.error.slice(0, 240) : null,
        };
      }
    }
  }

  return normalized;
}

function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    return normalizeSession(parsed);
  } catch {
    return null;
  }
}

function saveSession(session) {
  const normalized = normalizeSession(session) || createSession();
  normalized.updatedAt = new Date().toISOString();
  ensureSessionDir();
  const tmpFile = path.join(
    SESSION_DIR,
    `.onboard-session.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  fs.writeFileSync(tmpFile, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, SESSION_FILE);
  return normalized;
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch {}
}

function updateSession(mutator) {
  const current = loadSession() || createSession();
  const next = typeof mutator === "function" ? mutator(current) || current : current;
  return saveSession(next);
}

function markStepStarted(stepName) {
  return updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    step.status = "in_progress";
    step.startedAt = new Date().toISOString();
    step.error = null;
    session.lastStepStarted = stepName;
    session.failure = null;
    session.status = "in_progress";
    return session;
  });
}

function markStepComplete(stepName, updates = {}) {
  return updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    step.status = "complete";
    step.completedAt = new Date().toISOString();
    step.error = null;
    session.lastCompletedStep = stepName;
    session.failure = null;
    Object.assign(session, filterSafeUpdates(updates));
    return session;
  });
}

function markStepFailed(stepName, message = null) {
  return updateSession((session) => {
    const step = session.steps[stepName];
    if (!step) return session;
    step.status = "failed";
    step.error = typeof message === "string" ? message.slice(0, 240) : null;
    session.failure = sanitizeFailure({
      step: stepName,
      message,
      recordedAt: new Date().toISOString(),
    });
    session.status = "failed";
    return session;
  });
}

function completeSession(updates = {}) {
  return updateSession((session) => {
    Object.assign(session, filterSafeUpdates(updates));
    session.status = "complete";
    session.failure = null;
    return session;
  });
}

function filterSafeUpdates(updates) {
  const safe = {};
  if (!isObject(updates)) return safe;
  if (typeof updates.sandboxName === "string") safe.sandboxName = updates.sandboxName;
  if (typeof updates.provider === "string") safe.provider = updates.provider;
  if (typeof updates.model === "string") safe.model = updates.model;
  if (isObject(updates.metadata)) {
    safe.metadata = {};
    if (typeof updates.metadata.gatewayName === "string") {
      safe.metadata.gatewayName = updates.metadata.gatewayName;
    }
  }
  return safe;
}

function summarizeForDebug(session = loadSession()) {
  if (!session) return null;
  return {
    version: session.version,
    sessionId: session.sessionId,
    status: session.status,
    resumable: session.resumable,
    mode: session.mode,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    sandboxName: session.sandboxName,
    provider: session.provider,
    model: session.model,
    lastStepStarted: session.lastStepStarted,
    lastCompletedStep: session.lastCompletedStep,
    failure: session.failure,
    steps: Object.fromEntries(
      Object.entries(session.steps).map(([name, step]) => [
        name,
        {
          status: step.status,
          startedAt: step.startedAt,
          completedAt: step.completedAt,
          error: step.error,
        },
      ])
    ),
  };
}

module.exports = {
  SESSION_DIR,
  SESSION_FILE,
  SESSION_VERSION,
  clearSession,
  completeSession,
  createSession,
  loadSession,
  markStepComplete,
  markStepFailed,
  markStepStarted,
  saveSession,
  sessionPath,
  summarizeForDebug,
  updateSession,
};
