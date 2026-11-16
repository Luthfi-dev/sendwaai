import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import {
  addMessageLog,
  addBroadcastHistory,
  addSession,
  deductUserAiQuota,
  deductUserDailyQuota,
  canUseAiQuota,
  deleteSession,
  extractUserIdFromSessionId,
  getActiveCatalogForAi,
  getAntiBanSettings,
  getAutoReplyRules,
  getSessionById,
  getSessionsByUserId,
  getSubscriptionPlans,
  getSystemConfig,
  getUserById,
  getWhatsAppSessions,
  getWorkerClusterConfig,
  getWorkerNodeById,
  getWorkerNodes,
  initDbFile,
  isPhoneMetaAiVerifiedForUser,
  isSessionOwnedByUserId,
  markUserMetaAiVerified,
  resolveEffectiveSessionAiSettings,
  resolveOrderNotificationRecipientPhone,
  resolvePrimarySuperadminContactPhone,
  updateSession,
  updateUser,
  updateWorkerNode,
  clearSessionExpiryAlertSent,
  cancelQueuedSessionExpiryNotifications,
  isUserAutoReplyAllowed,
  isFreeAutoReplyExpired,
  enforceFreeAutoReplyExpirationForUser,
  sweepExpiredFreeAutoReplyUsers
} from './db.js';
import { decryptData, safeEqual } from './security.js';
import {
  deleteBaileysAuthFromMysql,
  isMysqlConfigured,
  loadBaileysAuthFromMysql,
  saveBaileysAuthToMysql
} from './mysqlService.js';
import {
  buildMetaAiPrompt,
  cleanMetaAiReply,
  reconcileCatalogImageLinksInReply,
  stripCustomerCodeTags
} from './metaAiService.js';
import {
  buildDeterministicOrderFallbackReply,
  completeAndConsumeVerifiedPaidOrder,
  formatOwnerOrderNotificationMessage,
  getOrCreateCustomerContext,
  parseAndHandleAiPaymentDirectives,
  prepareOrderFlowForIncomingMessage,
  recordCustomerTurn
} from './orderAssistant.js';
import { WorkerNode, WorkerNodeProvider } from '../types/whatsapp.js';

const AUTH_DIR = path.resolve(process.cwd(), 'baileys_auth_sessions');
const CATALOG_UPLOAD_DIR = path.resolve(process.cwd(), 'uploads', 'catalog');
const SAFE_LOCAL_CATALOG_FILE_RE = /^(?:prod|qris)_[a-f0-9-]+\.(png|jpg|webp|gif)$/i;
const SAFE_AUTH_FILENAME_RE = /^[a-zA-Z0-9_.-]+\.json$/;

const WORKER_HEARTBEAT_STALE_MS = 95 * 1000;
const WORKER_HMAC_REPLAY_WINDOW_MS = 120 * 1000;
const MAX_AUTH_FILES_PER_BACKUP = 60;
const MAX_AUTH_FILE_BYTES = 512 * 1024;
const MAX_AUTH_TOTAL_BYTES = 8 * 1024 * 1024;

export interface RemoteSessionRuntime {
  sessionId: string;
  userId?: string;
  workerNodeId: string;
  workerNodeName?: string;
  status: 'connected' | 'connecting' | 'disconnected';
  hasCreds?: boolean;
  qrCodeUrl: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  lastUpdated: number;
}

interface PendingRelayCommand {
  id: string;
  type: string;
  payload: any;
  createdAt: number;
}

interface CommandWaiter {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const remoteSessionStates = new Map<string, RemoteSessionRuntime>();
const pendingRelayCommands = new Map<string, PendingRelayCommand[]>();
const commandWaiters = new Map<string, CommandWaiter>();
const remoteCommandDialogs = new Map<string, { step: string; updatedAt: number }>();

type NotifyExpiredCallback = (params: {
  sessionId: string;
  sessionName?: string;
  expiredPhone?: string;
  userId?: string;
  reason?: string;
}) => Promise<{ notified: boolean; skipped?: string; queued?: boolean }>;

type SendOrQueueSuperadminWaCallback = (params: {
  recipientPhone: string;
  message: string;
  category: 'order_notification' | 'password_reset' | 'system_otp' | 'session_expired';
  ownerUserId?: string;
  sessionId?: string;
  expiredPhone?: string;
  invoiceNumber?: string;
}) => Promise<{ sent: boolean; queued: boolean; queueId?: string; sessionId?: string; error?: string }>;

type DrainSuperadminQueueCallback = (reason?: string) => Promise<any>;

let notifyExpiredCb: NotifyExpiredCallback | null = null;
let sendOrQueueSuperadminWaCb: SendOrQueueSuperadminWaCallback | null = null;
let drainSuperadminQueueCb: DrainSuperadminQueueCallback | null = null;

export function registerWorkerClusterCallbacks(callbacks: {
  notifyUserSessionExpired?: NotifyExpiredCallback;
  sendOrQueueViaSuperadminWa?: SendOrQueueSuperadminWaCallback;
  drainSuperadminWaQueue?: DrainSuperadminQueueCallback;
}) {
  if (callbacks.notifyUserSessionExpired) notifyExpiredCb = callbacks.notifyUserSessionExpired;
  if (callbacks.sendOrQueueViaSuperadminWa) sendOrQueueSuperadminWaCb = callbacks.sendOrQueueViaSuperadminWa;
  if (callbacks.drainSuperadminWaQueue) drainSuperadminQueueCb = callbacks.drainSuperadminWaQueue;
}

// Background watchdog: mark silent online workers offline after 95s & expire stale remote sessions
const workerWatchdogTimer = setInterval(() => {
  const now = Date.now();
  const nodes = getWorkerNodes();
  for (const node of nodes) {
    if (node.status === 'disabled') continue;
    if (node.status === 'online' && node.last_heartbeat_at) {
      const hbAge = now - new Date(node.last_heartbeat_at).getTime();
      if (Number.isFinite(hbAge) && hbAge > WORKER_HEARTBEAT_STALE_MS) {
        updateWorkerNode(
          node.id,
          {
            status: 'offline',
            last_error: 'Heartbeat worker terhenti > 95 detik'
          },
          false
        );
        for (const [sid, rt] of remoteSessionStates.entries()) {
          if (rt.workerNodeId === node.id && rt.status !== 'disconnected') {
            remoteSessionStates.set(sid, {
              ...rt,
              status: 'disconnected',
              lastUpdated: now
            });
          }
        }
      }
    }
  }
  for (const [k, d] of remoteCommandDialogs.entries()) {
    if (now - d.updatedAt > 15 * 60 * 1000) remoteCommandDialogs.delete(k);
  }
}, 30000);
workerWatchdogTimer.unref?.();

function normalizePhoneDigits(phone?: string | null): string {
  if (!phone) return '';
  let clean = String(phone).replace(/\D/g, '');
  if (clean.startsWith('00')) clean = clean.slice(2);
  if (clean.startsWith('620')) clean = '62' + clean.slice(3);
  else if (clean.startsWith('0')) clean = '62' + clean.slice(1);
  else if (clean.startsWith('8') && clean.length >= 8) clean = '62' + clean;
  return clean;
}

function sanitizeSessionIdSafe(rawId?: string): string | null {
  const cleaned = String(rawId || '').trim();
  if (!cleaned || !/^[a-zA-Z0-9_.-]{1,128}$/.test(cleaned) || cleaned.includes('..')) {
    return null;
  }
  return cleaned;
}

export function isBlockedWorkerHost(rawHostOrUrl: string): boolean {
  const val = String(rawHostOrUrl || '').trim().toLowerCase();
  if (!val) return true;
  let hostname = val;
  try {
    hostname = val.includes('://')
      ? new URL(val).hostname.toLowerCase()
      : val.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return true;
  }
  if (!hostname) return true;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname === '::' ||
    hostname === '169.254.169.254' ||
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata' ||
    hostname === '100.100.100.200' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local')
  ) {
    return true;
  }
  return false;
}

export function isSafeWorkerBaseUrl(rawUrl?: string | null): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 512) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (isBlockedWorkerHost(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function decryptNodeSecret(node: Pick<WorkerNode, 'node_secret'>): string {
  if (!node?.node_secret) return '';
  return decryptData(String(node.node_secret)).trim();
}

function sha256Hex(str: string): string {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

export function signMasterRequestHeaders(
  plainSecret: string,
  method: string,
  urlPath: string,
  bodyStr = ''
): { ts: string; sig: string } {
  const ts = String(Date.now());
  const msg = `${ts}.${method.toUpperCase()}.${urlPath}.${sha256Hex(bodyStr)}`;
  const sig = crypto.createHmac('sha256', plainSecret).update(msg).digest('hex');
  return { ts, sig };
}

export function verifyWorkerHmacSignature(node: WorkerNode, req: Request): boolean {
  const plainSecret = decryptNodeSecret(node);
  if (!plainSecret) return false;

  const tsStr = String(req.headers['x-worker-timestamp'] || '').trim();
  const sig = String(req.headers['x-worker-signature'] || '').trim();
  if (!tsStr || !sig) return false;

  const tsNum = Number(tsStr);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > WORKER_HMAC_REPLAY_WINDOW_MS) {
    return false;
  }

  const rawBuf = (req as any).rawBody;
  const rawBodyStr = Buffer.isBuffer(rawBuf)
    ? rawBuf.toString('utf8')
    : req.method.toUpperCase() === 'GET'
      ? ''
      : req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0
        ? JSON.stringify(req.body)
        : '';

  const urlPath = String(req.originalUrl || req.url || '').split('?')[0];
  const expectedMsg = `${tsStr}.${req.method.toUpperCase()}.${urlPath}.${sha256Hex(rawBodyStr)}`;
  const expectedSig = crypto.createHmac('sha256', plainSecret).update(expectedMsg).digest('hex');
  return safeEqual(sig, expectedSig);
}

function isNodeAlive(node: WorkerNode, now = Date.now()): boolean {
  if (!node || node.status === 'disabled' || !node.is_verified) return false;
  if (node.status !== 'online') return false;
  if (!node.last_heartbeat_at) return false;
  const hbMs = new Date(node.last_heartbeat_at).getTime();
  return Number.isFinite(hbMs) && now - hbMs <= WORKER_HEARTBEAT_STALE_MS;
}

export function touchWorkerNodeAlive(
  node: WorkerNode,
  sessionsTelemetry?: any[],
  extraUpdates?: Partial<WorkerNode>
): WorkerNode {
  if (!node || node.status === 'disabled') return node;
  const nowIso = new Date().toISOString();
  const telemetryArr = Array.isArray(sessionsTelemetry) ? sessionsTelemetry : null;
  const sessionIds = telemetryArr
    ? (telemetryArr.map((s: any) => sanitizeSessionIdSafe(s?.sessionId)).filter(Boolean) as string[])
    : undefined;

  const updated = updateWorkerNode(
    node.id,
    {
      status: 'online',
      is_verified: true,
      verified_at: node.verified_at || nowIso,
      last_heartbeat_at: nowIso,
      last_error: '',
      ...(sessionIds ? { session_ids: sessionIds, active_sessions: telemetryArr!.filter((s: any) => s?.status === 'connected').length } : {}),
      ...(extraUpdates || {})
    },
    false
  );

  if (telemetryArr) {
    updateRemoteRuntimeFromTelemetry(updated || node, telemetryArr);
  }
  return updated || node;
}

export function markRemoteSessionLiveFromWorkerActivity(
  node: WorkerNode,
  rawSessionId: string,
  candidateUserId?: string,
  candidatePhone?: string
): void {
  if (!node || node.status === 'disabled') return;
  const sessionId = sanitizeSessionIdSafe(rawSessionId);
  if (!sessionId) return;

  const aliveNode = touchWorkerNodeAlive(node);
  const owner = resolveVerifiedWorkerSessionOwner(sessionId, candidateUserId, candidatePhone);
  if (!owner) return;

  const dbSess = getSessionById(sessionId);
  const existingRt = remoteSessionStates.get(sessionId);
  const cleanPhone = normalizePhoneDigits(candidatePhone || existingRt?.phoneNumber || dbSess?.phone_number || '');

  remoteSessionStates.set(sessionId, {
    sessionId,
    userId: owner.id,
    workerNodeId: aliveNode.id,
    workerNodeName: aliveNode.name,
    status: 'connected',
    qrCodeUrl: existingRt?.qrCodeUrl ?? null,
    pairingCode: existingRt?.pairingCode ?? null,
    phoneNumber: cleanPhone || null,
    lastUpdated: Date.now()
  });

  const existingIds = Array.isArray(aliveNode.session_ids) ? aliveNode.session_ids : [];
  if (!existingIds.includes(sessionId)) {
    const nextIds = [...existingIds, sessionId];
    updateWorkerNode(
      aliveNode.id,
      {
        session_ids: nextIds,
        active_sessions: Math.max(aliveNode.active_sessions || 0, nextIds.length)
      },
      false
    );
  }

  reconcileRemoteWorkerSessionsIntoDb(owner.id);
}

function safeSessionAuthDir(sessionId: string): string | null {
  const cleanId = sanitizeSessionIdSafe(sessionId);
  if (!cleanId) return null;
  const resolved = path.resolve(AUTH_DIR, cleanId);
  if (!resolved.startsWith(AUTH_DIR + path.sep)) return null;
  return resolved;
}

function sanitizeIncomingAuthFiles(rawFiles: unknown): Record<string, string> | null {
  if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) return null;
  const entries = Object.entries(rawFiles as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_AUTH_FILES_PER_BACKUP) return null;

  const cleanMap: Record<string, string> = {};
  let totalBytes = 0;

  for (const [rawKey, rawVal] of entries) {
    const fileName = path.basename(String(rawKey || ''));
    if (fileName !== rawKey || !SAFE_AUTH_FILENAME_RE.test(fileName)) {
      continue;
    }
    if (typeof rawVal !== 'string') continue;
    const byteLen = Buffer.byteLength(rawVal, 'utf8');
    if (byteLen === 0 || byteLen > MAX_AUTH_FILE_BYTES) continue;
    totalBytes += byteLen;
    if (totalBytes > MAX_AUTH_TOTAL_BYTES) break;
    cleanMap[fileName] = rawVal;
  }

  return Object.keys(cleanMap).length > 0 ? cleanMap : null;
}

export async function saveWorkerAuthFilesOnMaster(
  rawSessionId: string,
  rawAuthFiles: unknown
): Promise<{ savedCount: number }> {
  const sessionId = sanitizeSessionIdSafe(rawSessionId);
  if (!sessionId) throw new Error('ID sesi tidak valid.');

  const cleanMap = sanitizeIncomingAuthFiles(rawAuthFiles);
  if (!cleanMap) throw new Error('Format file auth tidak valid atau melebihi batas.');

  const folder = safeSessionAuthDir(sessionId);
  if (!folder) throw new Error('Path folder sesi tidak valid.');

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  }

  for (const [fn, content] of Object.entries(cleanMap)) {
    const dest = path.resolve(folder, fn);
    if (!dest.startsWith(folder + path.sep)) continue;
    await fs.promises.writeFile(dest, content, { encoding: 'utf8', mode: 0o600 });
  }

  if (isMysqlConfigured()) {
    await saveBaileysAuthToMysql(sessionId, cleanMap).catch(() => {});
  }

  return { savedCount: Object.keys(cleanMap).length };
}

export async function loadWorkerAuthFilesFromMaster(
  rawSessionId: string
): Promise<Record<string, string> | undefined> {
  const sessionId = sanitizeSessionIdSafe(rawSessionId);
  if (!sessionId) return undefined;

  const folder = safeSessionAuthDir(sessionId);
  if (folder && fs.existsSync(folder)) {
    try {
      const files: Record<string, string> = {};
      for (const name of fs.readdirSync(folder)) {
        if (!SAFE_AUTH_FILENAME_RE.test(name)) continue;
        const fp = path.resolve(folder, name);
        if (!fp.startsWith(folder + path.sep)) continue;
        const st = fs.statSync(fp);
        if (!st.isFile() || st.size <= 0 || st.size > MAX_AUTH_FILE_BYTES) continue;
        files[name] = fs.readFileSync(fp, 'utf8');
      }
      if (files['creds.json']) {
        return files;
      }
    } catch {
      // Fallback to MySQL
    }
  }

  if (isMysqlConfigured()) {
    const fromMysql = await loadBaileysAuthFromMysql(sessionId).catch(() => null);
    if (fromMysql && typeof fromMysql === 'object' && fromMysql['creds.json']) {
      return sanitizeIncomingAuthFiles(fromMysql) || undefined;
    }
  }

  return undefined;
}

function purgeMasterAuthCopiesForSession(sessionId: string) {
  const folder = safeSessionAuthDir(sessionId);
  if (folder && fs.existsSync(folder)) {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {}
  }
  deleteBaileysAuthFromMysql(sessionId).catch(() => {});
}

function resolveLocalCatalogQrisBase64(url?: string): string | undefined {
  if (!url) return undefined;
  let relPath = String(url).trim();
  if (/^https?:\/\//i.test(relPath)) {
    try {
      relPath = new URL(relPath).pathname;
    } catch {
      return undefined;
    }
  }
  if (!relPath.startsWith('/api/catalog/images/')) return undefined;
  const filename = path.basename(relPath);
  if (!SAFE_LOCAL_CATALOG_FILE_RE.test(filename)) return undefined;
  const resolved = path.resolve(CATALOG_UPLOAD_DIR, filename);
  if (!resolved.startsWith(CATALOG_UPLOAD_DIR + path.sep)) return undefined;
  try {
    if (!fs.existsSync(resolved)) return undefined;
    const st = fs.statSync(resolved);
    if (!st.isFile() || st.size < 50 || st.size > 4 * 1024 * 1024) return undefined;
    return fs.readFileSync(resolved).toString('base64');
  } catch {
    return undefined;
  }
}

export async function sendCommandToWorker(
  node: WorkerNode,
  type: string,
  payload: any,
  timeoutMs = 24000
): Promise<any> {
  if (node.status === 'disabled') {
    throw new Error(`Worker "${node.name}" sedang dinonaktifkan.`);
  }

  const plainSecret = decryptNodeSecret(node);
  if (!plainSecret) {
    throw new Error(`Secret Worker "${node.name}" tidak tersedia.`);
  }

  const deadline = Date.now() + timeoutMs;

  // Try direct_https push first if a safe public base_url exists and mode is not explicitly relay_poll
  if (node.base_url && isSafeWorkerBaseUrl(node.base_url) && node.connection_mode !== 'relay_poll') {
    const cleanBase = node.base_url.trim().replace(/\/+$/, '');
    const apiPath = '/internal/command';
    const bodyStr = JSON.stringify({ type, payload });
    const { ts, sig } = signMasterRequestHeaders(plainSecret, 'POST', apiPath, bodyStr);
    try {
      const resp = await fetch(`${cleanBase}${apiPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-master-timestamp': ts,
          'x-master-signature': sig
        },
        body: bodyStr,
        signal: AbortSignal.timeout(Math.min(timeoutMs, 14000))
      });
      const json: any = await resp.json().catch(() => null);
      if (resp.ok && json?.success) {
        return json.data;
      }
      if (resp.status === 400 && json?.error) {
        throw new Error(json.error);
      }
    } catch (err: any) {
      // Only propagate explicit worker command execution errors; fall through to relay poll on network/HTTP timeout
      if (err?.message && !/fetch|network|timeout|aborted|ECONN|ENOTFOUND|HTTP/i.test(err.message)) {
        throw err;
      }
    }
  }

  const remainingMs = Math.max(3000, deadline - Date.now());

  // Relay Queue fallback (for NAT / private container URLs or transient direct errors)
  const commandId = `cmd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      commandWaiters.delete(commandId);
      const q = pendingRelayCommands.get(node.id);
      if (q) {
        pendingRelayCommands.set(
          node.id,
          q.filter(c => c.id !== commandId)
        );
      }
      reject(new Error(`Timeout menunggu respon dari Worker "${node.name}" (${type}).`));
    }, remainingMs);

    commandWaiters.set(commandId, { resolve, reject, timer });

    const queue = pendingRelayCommands.get(node.id) || [];
    queue.push({ id: commandId, type, payload, createdAt: Date.now() });
    if (queue.length > 100) {
      queue.splice(0, queue.length - 100);
    }
    pendingRelayCommands.set(node.id, queue);
  });
}

export async function verifyWorkerNodeConnectivity(nodeId: string): Promise<{
  verified: boolean;
  mode: 'direct_https' | 'relay_poll';
  message: string;
  telemetry?: any;
}> {
  const node = getWorkerNodeById(nodeId);
  if (!node) {
    throw new Error('Worker Node tidak ditemukan.');
  }
  const plainSecret = decryptNodeSecret(node);
  if (!plainSecret) {
    throw new Error('Node secret tidak valid.');
  }

  if (node.base_url && isSafeWorkerBaseUrl(node.base_url)) {
    const cleanBase = node.base_url.trim().replace(/\/+$/, '');
    const challenge = crypto.randomBytes(24).toString('hex');
    const bodyStr = JSON.stringify({ challenge });
    const { ts, sig } = signMasterRequestHeaders(plainSecret, 'POST', '/internal/verify', bodyStr);
    const expectedProof = crypto.createHmac('sha256', plainSecret).update(challenge).digest('hex');

    try {
      const res = await fetch(`${cleanBase}/internal/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-master-timestamp': ts,
          'x-master-signature': sig
        },
        body: bodyStr,
        signal: AbortSignal.timeout(10000)
      });
      const json: any = await res.json().catch(() => null);
      if (res.ok && json?.ok && typeof json?.proof === 'string' && safeEqual(json.proof, expectedProof)) {
        const nowIso = new Date().toISOString();
        const telemetry = await sendCommandToWorker(node, 'ping_verify', {}, 10000).catch(() => null);
        updateWorkerNode(node.id, {
          is_verified: true,
          verified_at: nowIso,
          last_heartbeat_at: nowIso,
          status: node.status === 'disabled' ? 'disabled' : 'online',
          connection_mode: 'direct_https',
          last_error: '',
          ...(telemetry
            ? {
                active_sessions: Number(telemetry.activeSessions ?? node.active_sessions) || 0,
                max_sessions: Number(telemetry.maxSessions ?? node.max_sessions) || node.max_sessions,
                ram_used_mb: Number(telemetry.ramUsedMb) || node.ram_used_mb,
                uptime_seconds: Number(telemetry.uptimeSeconds) || node.uptime_seconds
              }
            : {})
        });
        return {
          verified: true,
          mode: 'direct_https',
          message: `Worker "${node.name}" terverifikasi aktif (Direct HTTPS)!`,
          telemetry
        };
      }
    } catch {
      // Fallback to relay verification
    }
  }

  // Fallback to relay poll verification
  try {
    const telemetry = await sendCommandToWorker(node, 'ping_verify', {}, 12000);
    const nowIso = new Date().toISOString();
    updateWorkerNode(node.id, {
      is_verified: true,
      verified_at: nowIso,
      last_heartbeat_at: nowIso,
      status: node.status === 'disabled' ? 'disabled' : 'online',
      connection_mode: isSafeWorkerBaseUrl(node.base_url) ? node.connection_mode || 'relay_poll' : 'relay_poll',
      last_error: '',
      ...(telemetry
        ? {
            active_sessions: Number(telemetry.activeSessions ?? node.active_sessions) || 0,
            max_sessions: Number(telemetry.maxSessions ?? node.max_sessions) || node.max_sessions,
            ram_used_mb: Number(telemetry.ramUsedMb) || node.ram_used_mb,
            uptime_seconds: Number(telemetry.uptimeSeconds) || node.uptime_seconds
          }
        : {})
    });
    return {
      verified: true,
      mode: 'relay_poll',
      message: `Worker "${node.name}" terverifikasi aktif melalui Jalur Relay Outbound!`,
      telemetry
    };
  } catch (err: any) {
    const errMsg = err?.message || 'Worker tidak merespons challenge verifikasi.';
    updateWorkerNode(node.id, {
      last_error: errMsg
    });
    return {
      verified: false,
      mode: 'relay_poll',
      message: `Worker "${node.name}" belum merespons (${errMsg}). Pastikan container Northflank sudah Deploy & Status Running dengan NODE_SECRET yang sesuai.`
    };
  }
}

export type ExecutionTargetResult =
  | { mode: 'worker'; node: WorkerNode }
  | { mode: 'local' }
  | {
      mode: 'rejected_no_worker';
      code: 'NO_AVAILABLE_WORKER';
      error: string;
      support_phone: string;
      support_display_phone: string;
      support_wa_link: string;
    };

export function selectExecutionTargetForSession(
  sessionId?: string,
  options?: { allowAnyOnlineFallback?: boolean }
): ExecutionTargetResult {
  const now = Date.now();
  const nodes = getWorkerNodes();
  const clusterCfg = getWorkerClusterConfig();

  // 1. Check pinned node if session exists
  if (sessionId) {
    const dbSess = getSessionById(sessionId);
    if (dbSess?.worker_node_id && dbSess.worker_node_id !== 'local') {
      const pinned = nodes.find(n => n.id === dbSess.worker_node_id);
      if (pinned && isNodeAlive(pinned, now)) {
        const pinnedCount = Math.max(pinned.active_sessions || 0, pinned.session_ids?.length || 0);
        if (pinned.session_ids?.includes(sessionId) || pinnedCount < (pinned.max_sessions || 10) || options?.allowAnyOnlineFallback) {
          return { mode: 'worker', node: pinned };
        }
      }
    }
  }

  // 2. Pick best alive worker with remaining slot capacity (least loaded first)
  const aliveWorkers = nodes.filter(n => isNodeAlive(n, now));
  const candidatesWithSlot = aliveWorkers
    .map(n => {
      const used = Math.max(n.active_sessions || 0, n.session_ids?.length || 0);
      const maxS = Math.max(1, n.max_sessions || 10);
      return { node: n, used, remaining: maxS - used };
    })
    .filter(item => item.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining || a.used - b.used);

  if (candidatesWithSlot.length > 0) {
    return { mode: 'worker', node: candidatesWithSlot[0].node };
  }

  if (options?.allowAnyOnlineFallback && aliveWorkers.length > 0) {
    const leastBusy = [...aliveWorkers].sort((a, b) => (a.active_sessions || 0) - (b.active_sessions || 0))[0];
    return { mode: 'worker', node: leastBusy };
  }

  // 3. Fallback to main hosting ONLY if Superadmin allows local Baileys
  if (clusterCfg.local_baileys_enabled !== false) {
    return { mode: 'local' };
  }

  // 4. Local Baileys explicitly disabled & no worker available -> reject with Tim Japriin contact notification
  const contact = resolvePrimarySuperadminContactPhone();
  const phoneDisplay = contact.phone ? contact.displayPhone : 'Admin Pusat';
  return {
    mode: 'rejected_no_worker',
    code: 'NO_AVAILABLE_WORKER',
    error: `Penyambungan perangkat WhatsApp belum dapat diproses karena kapasitas layanan saat ini penuh atau sedang dalam pemeliharaan. Silakan hubungi Tim Japriin melalui WhatsApp ${phoneDisplay} untuk bantuan aktivasi layanan.`,
    support_phone: contact.phone,
    support_display_phone: contact.displayPhone,
    support_wa_link: contact.waLink
  };
}

function resolveVerifiedWorkerSessionOwner(
  sessionId: string,
  candidateUserId?: string,
  candidatePhone?: string
) {
  const db = initDbFile();
  const dbSess = getSessionById(sessionId);
  const cleanPhone = normalizePhoneDigits(candidatePhone || dbSess?.phone_number || '');

  const validateActiveOwner = (u: ReturnType<typeof getUserById>) =>
    u && u.is_active && u.email_verified ? u : null;

  // Authoritative owner from existing DB session first (never allow cross-tenant reassignment)
  if (dbSess?.user_id) {
    return validateActiveOwner(getUserById(dbSess.user_id));
  }

  if (candidateUserId) {
    const u = validateActiveOwner(getUserById(candidateUserId));
    if (u) return u;
  }

  const extractedId = extractUserIdFromSessionId(sessionId, db.users);
  if (extractedId) {
    const u = validateActiveOwner(getUserById(extractedId));
    if (u) return u;
  }

  if (cleanPhone && cleanPhone.length >= 8) {
    const matchedSess = db.sessions.find(
      s => s.user_id && s.phone_number && normalizePhoneDigits(s.phone_number) === cleanPhone
    );
    if (matchedSess?.user_id) {
      const u = validateActiveOwner(getUserById(matchedSess.user_id));
      if (u) return u;
    }

    const matchedUser = db.users.find(
      u => u.phone && normalizePhoneDigits(u.phone) === cleanPhone
    );
    if (matchedUser) {
      return validateActiveOwner(matchedUser);
    }
  }

  return null;
}

export function getAllRemoteSessionRuntimes(): RemoteSessionRuntime[] {
  return Array.from(remoteSessionStates.values());
}

export function reconcileRemoteWorkerSessionsIntoDb(targetUserId?: string): number {
  const now = Date.now();
  const nodesMap = new Map(getWorkerNodes().map(n => [n.id, n]));
  const db = initDbFile();
  let reconciled = 0;

  for (const rt of Array.from(remoteSessionStates.values())) {
    if (rt.status !== 'connected' && rt.status !== 'connecting') continue;
    const node = nodesMap.get(rt.workerNodeId);
    if (!node || node.status === 'disabled' || !node.is_verified) continue;
    const recentlyUpdated = Boolean(rt.lastUpdated && now - rt.lastUpdated <= 120_000);
    if (!isNodeAlive(node, now) && !recentlyUpdated) continue;
    if (!isNodeAlive(node, now) && recentlyUpdated) {
      touchWorkerNodeAlive(node);
    }

    const owner = resolveVerifiedWorkerSessionOwner(rt.sessionId, rt.userId, rt.phoneNumber || undefined);
    if (!owner) {
      // Unregistered/disabled/deleted owner -> tear down orphan worker session immediately
      if (rt.status === 'connected') {
        remoteSessionStates.delete(rt.sessionId);
        void sendCommandToWorker(node, 'stop_session', { sessionId: rt.sessionId, purge: true }, 10000).catch(() => {});
      }
      continue;
    }

    if (targetUserId && owner.id !== targetUserId) continue;

    const cleanPhone = normalizePhoneDigits(rt.phoneNumber || '');
    let existingDb = db.sessions.find(s => s.id === rt.sessionId) || null;
    if (!existingDb && cleanPhone.length >= 8) {
      existingDb =
        db.sessions.find(
          s =>
            s.user_id === owner.id &&
            s.phone_number &&
            normalizePhoneDigits(s.phone_number) === cleanPhone
        ) || null;
    }

    const expRes = enforceFreeAutoReplyExpirationForUser(owner.id);
    const freshOwner = expRes.user || owner;
    const expiryDate = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
    const isSessionDateExpired = Boolean(existingDb?.expires_at && Date.parse(existingDb.expires_at) <= now);

    if (isSessionDateExpired && existingDb) {
      remoteSessionStates.delete(rt.sessionId);
      void sendCommandToWorker(node, 'stop_session', { sessionId: rt.sessionId, purge: true }, 10000).catch(() => {});
      deleteSession(existingDb.id);
      purgeMasterAuthCopiesForSession(existingDb.id);
      continue;
    }

    if (rt.status === 'connected') {
      if (!existingDb) {
        const userHasPrimary = getSessionsByUserId(freshOwner.id).some(s => s.is_primary);
        addSession({
          id: rt.sessionId,
          session_name: cleanPhone ? `WA - ${cleanPhone}` : `WA - ${rt.sessionId}`,
          phone_number: cleanPhone,
          auth_method: rt.sessionId.includes('pair') ? 'pairing_code' : 'qr_code',
          status: 'connected',
          user_id: freshOwner.id,
          is_primary: !userHasPrimary,
          worker_node_id: node.id,
          worker_node_name: node.name,
          connected_at: new Date(now).toISOString(),
          expires_at: expiryDate
        });
        reconciled++;
      } else {
        const needsUpdate =
          existingDb.status !== 'connected' ||
          existingDb.worker_node_id !== node.id ||
          existingDb.worker_node_name !== node.name ||
          (cleanPhone.length >= 8 && normalizePhoneDigits(existingDb.phone_number) !== cleanPhone) ||
          !existingDb.user_id;
        if (needsUpdate) {
          updateSession(existingDb.id, {
            status: 'connected',
            phone_number: cleanPhone || existingDb.phone_number,
            user_id: existingDb.user_id || freshOwner.id,
            worker_node_id: node.id,
            worker_node_name: node.name,
            connected_at: existingDb.connected_at || new Date(now).toISOString(),
            expires_at: existingDb.expires_at || expiryDate
          });
          reconciled++;
        }
      }

      if (rt.userId !== freshOwner.id) {
        remoteSessionStates.set(rt.sessionId, { ...rt, userId: freshOwner.id });
      }

      const clearKeys = [rt.sessionId, `${freshOwner.id}:${rt.sessionId}`];
      if (cleanPhone) clearKeys.push(`${freshOwner.id}:${cleanPhone}`);
      clearSessionExpiryAlertSent(clearKeys);
      cancelQueuedSessionExpiryNotifications({
        userId: freshOwner.id,
        sessionId: rt.sessionId,
        phone: cleanPhone || undefined
      });

      if (isFreeAutoReplyExpired(freshOwner) || !isUserAutoReplyAllowed(freshOwner)) {
        if (expRes.expiredNow || isFreeAutoReplyExpired(freshOwner)) {
          scheduleWorkerDormantDetach(node, rt.sessionId, 5000);
        }
      }
    } else if (rt.status === 'connecting' && existingDb && existingDb.worker_node_id !== node.id) {
      updateSession(existingDb.id, {
        worker_node_id: node.id,
        worker_node_name: node.name
      });
    }
  }

  return reconciled;
}

function updateRemoteRuntimeFromTelemetry(
  node: WorkerNode,
  sessionsTelemetry: any[]
) {
  const now = Date.now();
  const activeSids = new Set<string>();
  for (const s of sessionsTelemetry) {
    const sid = sanitizeSessionIdSafe(s?.sessionId);
    if (!sid) continue;
    activeSids.add(sid);
    const status: 'connected' | 'connecting' | 'disconnected' =
      s?.status === 'connected' ? 'connected' : s?.status === 'connecting' ? 'connecting' : 'disconnected';
    const prevRt = remoteSessionStates.get(sid);
    remoteSessionStates.set(sid, {
      sessionId: sid,
      userId: s?.userId || getSessionById(sid)?.user_id || prevRt?.userId,
      workerNodeId: node.id,
      workerNodeName: node.name,
      status,
      hasCreds: Boolean(s?.hasCreds || status === 'connected' || prevRt?.hasCreds),
      qrCodeUrl: typeof s?.qrCodeUrl === 'string' ? s.qrCodeUrl : null,
      pairingCode: typeof s?.pairingCode === 'string' ? s.pairingCode : null,
      phoneNumber: s?.phoneNumber ? normalizePhoneDigits(String(s.phoneNumber)) : prevRt?.phoneNumber || null,
      lastUpdated: now
    });
  }

  // Mark any session pinned in memory to this worker as disconnected if absent from telemetry past the 35s reconnect grace window
  for (const [sid, rt] of remoteSessionStates.entries()) {
    if (
      rt.workerNodeId === node.id &&
      !activeSids.has(sid) &&
      rt.status !== 'disconnected' &&
      now - (rt.lastUpdated || 0) > 35000
    ) {
      remoteSessionStates.set(sid, { ...rt, status: 'disconnected', lastUpdated: now });
    }
  }

  reconcileRemoteWorkerSessionsIntoDb();
}

export function handleWorkerRegister(node: WorkerNode, body: any): WorkerNode {
  const nowIso = new Date().toISOString();
  const sessionsArr = Array.isArray(body?.sessions) ? body.sessions : [];
  const sessionIds = Array.isArray(body?.sessionIds)
    ? body.sessionIds.map((x: any) => sanitizeSessionIdSafe(String(x))).filter(Boolean) as string[]
    : sessionsArr.map((s: any) => sanitizeSessionIdSafe(s?.sessionId)).filter(Boolean) as string[];

  const discoveredBaseUrl = isSafeWorkerBaseUrl(body?.baseUrl)
    ? String(body.baseUrl).trim().replace(/\/+$/, '')
    : node.base_url;

  const validProviders: WorkerNodeProvider[] = ['northflank', 'vps', 'docker', 'other'];
  const provider = validProviders.includes(body?.provider) ? (body.provider as WorkerNodeProvider) : node.provider;

  const updated = updateWorkerNode(node.id, {
    provider,
    base_url: discoveredBaseUrl || '',
    connection_mode: discoveredBaseUrl ? 'direct_https' : 'relay_poll',
    max_sessions: Math.max(1, Math.min(500, Number(body?.maxSessions) || node.max_sessions || 10)),
    active_sessions: Number(body?.activeSessions ?? sessionIds.length) || 0,
    session_ids: sessionIds,
    ram_used_mb: body?.ramUsedMb !== undefined ? Number(body.ramUsedMb) : node.ram_used_mb,
    ram_total_mb: body?.ramTotalMb !== undefined ? Number(body.ramTotalMb) : node.ram_total_mb,
    cpu_percent: body?.cpuPercent !== undefined ? Number(body.cpuPercent) : node.cpu_percent,
    uptime_seconds: body?.uptimeSeconds !== undefined ? Number(body.uptimeSeconds) : node.uptime_seconds,
    platform: typeof body?.platform === 'string' ? body.platform.slice(0, 60) : node.platform,
    version: typeof body?.version === 'string' ? body.version.slice(0, 30) : node.version,
    status: node.status === 'disabled' ? 'disabled' : 'online',
    is_verified: true,
    verified_at: node.verified_at || nowIso,
    last_heartbeat_at: nowIso,
    last_error: ''
  });

  if (sessionsArr.length > 0) {
    updateRemoteRuntimeFromTelemetry(updated || node, sessionsArr);
  }
  return updated || node;
}

export function handleWorkerHeartbeat(node: WorkerNode, body: any): WorkerNode {
  const nowIso = new Date().toISOString();
  const sessionsArr = Array.isArray(body?.sessions) ? body.sessions : [];
  const sessionIds = Array.isArray(body?.sessionIds)
    ? body.sessionIds.map((x: any) => sanitizeSessionIdSafe(String(x))).filter(Boolean) as string[]
    : sessionsArr.map((s: any) => sanitizeSessionIdSafe(s?.sessionId)).filter(Boolean) as string[];

  const discoveredBaseUrl = !node.base_url && isSafeWorkerBaseUrl(body?.baseUrl)
    ? String(body.baseUrl).trim().replace(/\/+$/, '')
    : node.base_url;

  const updated = updateWorkerNode(
    node.id,
    {
      ...(discoveredBaseUrl && !node.base_url ? { base_url: discoveredBaseUrl, connection_mode: 'direct_https' as const } : {}),
      active_sessions: Number(body?.activeSessions ?? sessionIds.length) || 0,
      session_ids: sessionIds,
      ram_used_mb: body?.ramUsedMb !== undefined ? Number(body.ramUsedMb) : node.ram_used_mb,
      ram_total_mb: body?.ramTotalMb !== undefined ? Number(body.ramTotalMb) : node.ram_total_mb,
      cpu_percent: body?.cpuPercent !== undefined ? Number(body.cpuPercent) : node.cpu_percent,
      uptime_seconds: body?.uptimeSeconds !== undefined ? Number(body.uptimeSeconds) : node.uptime_seconds,
      status: node.status === 'disabled' ? 'disabled' : 'online',
      is_verified: true,
      verified_at: node.verified_at || nowIso,
      last_heartbeat_at: nowIso,
      last_error: ''
    },
    false
  );

  updateRemoteRuntimeFromTelemetry(updated || node, sessionsArr);

  // Immediately tell worker to kill & purge any session whose DB row is expired or owner is inactive
  const liveNode = updated || node;
  if (liveNode.status !== 'disabled') {
    const nowMs = Date.now();
    for (const s of sessionsArr) {
      const sid = sanitizeSessionIdSafe(s?.sessionId);
      if (!sid) continue;
      const dbSess = getSessionById(sid);
      const isExpired = Boolean(dbSess?.expires_at && Date.parse(dbSess.expires_at) <= nowMs);
      const owner = dbSess?.user_id ? getUserById(dbSess.user_id) : null;
      const ownerInactive = Boolean(dbSess && (!owner || !owner.is_active || !owner.email_verified));
      if (isExpired || ownerInactive) {
        remoteSessionStates.delete(sid);
        if (dbSess) {
          deleteSession(dbSess.id);
          purgeMasterAuthCopiesForSession(dbSess.id);
        }
        void sendCommandToWorker(liveNode, 'stop_session', { sessionId: sid, purge: true }, 10000).catch(() => {});
      }
    }
  }

  return liveNode;
}

export function pollRelayCommandsForWorker(nodeId: string): PendingRelayCommand[] {
  const node = getWorkerNodeById(nodeId);
  if (node && node.status !== 'disabled') {
    touchWorkerNodeAlive(node);
  }
  const queue = pendingRelayCommands.get(nodeId) || [];
  if (queue.length === 0) return [];
  const now = Date.now();
  const fresh = queue.filter(cmd => now - cmd.createdAt <= 45000);
  pendingRelayCommands.delete(nodeId);
  return fresh;
}

export function submitRelayCommandResult(params: {
  commandId: string;
  success: boolean;
  data?: any;
  error?: string;
}): boolean {
  const waiter = commandWaiters.get(params.commandId);
  if (!waiter) return false;
  clearTimeout(waiter.timer);
  commandWaiters.delete(params.commandId);
  if (params.success) {
    waiter.resolve(params.data);
  } else {
    waiter.reject(new Error(params.error || 'Command worker gagal dieksekusi.'));
  }
  return true;
}

export async function getWorkerAssignedSessionsWithAuth(node: WorkerNode): Promise<
  Array<{ id: string; phone_number: string; user_id?: string; authFiles?: Record<string, string> }>
> {
  sweepExpiredFreeAutoReplyUsers();
  const dbSessions = getWhatsAppSessions();
  const assigned = dbSessions.filter(s => {
    if (!s.id || s.status === 'disconnected') return false;
    if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return false;
    const owner = s.user_id ? getUserById(s.user_id) : null;
    if (!owner || !isUserAutoReplyAllowed(owner)) return false;
    return s.worker_node_id === node.id;
  });

  const out: Array<{ id: string; phone_number: string; user_id?: string; authFiles?: Record<string, string> }> = [];
  for (const s of assigned) {
    const authFiles = await loadWorkerAuthFilesFromMaster(s.id).catch(() => undefined);
    if (!authFiles || !authFiles['creds.json']) continue;
    out.push({
      id: s.id,
      phone_number: s.phone_number,
      user_id: s.user_id,
      authFiles
    });
  }
  return out;
}

export function verifyWorkerSessionOwnership(node: WorkerNode, rawSessionId: string): {
  ok: boolean;
  sessionId?: string;
  reason?: string;
} {
  const sessionId = sanitizeSessionIdSafe(rawSessionId);
  if (!sessionId) return { ok: false, reason: 'ID sesi tidak valid.' };
  const dbSess = getSessionById(sessionId);
  if (dbSess?.worker_node_id && dbSess.worker_node_id !== node.id) {
    return { ok: false, reason: 'Sesi tersebut terdaftar pada Worker Node lain.' };
  }
  return { ok: true, sessionId };
}

export async function handleWorkerSessionEvent(node: WorkerNode, body: any): Promise<{ ok: boolean }> {
  touchWorkerNodeAlive(node);
  const event = String(body?.event || '').trim();
  const check = verifyWorkerSessionOwnership(node, String(body?.sessionId || ''));
  if (!check.ok || !check.sessionId) {
    throw new Error(check.reason || 'Kepemilikan sesi tidak sah.');
  }
  const sessionId = check.sessionId;
  const phoneNumber = normalizePhoneDigits(body?.phoneNumber || '');
  const db = initDbFile();
  const existingDb = getSessionById(sessionId);

  let ownerUserId = existingDb?.user_id || (body?.userId ? String(body.userId) : undefined);
  if (!ownerUserId) {
    ownerUserId = extractUserIdFromSessionId(sessionId, db.users);
  }
  if (!ownerUserId && phoneNumber.length >= 8) {
    const phoneOwner = db.users.find(u => u.phone && normalizePhoneDigits(u.phone) === phoneNumber);
    if (phoneOwner) ownerUserId = phoneOwner.id;
  }
  const owner = ownerUserId ? getUserById(ownerUserId) : null;

  if (event === 'open') {
    if (!owner || !owner.is_active || !owner.email_verified) {
      // Unregistered/disabled user -> stop worker session immediately
      void sendCommandToWorker(node, 'stop_session', { sessionId, purge: true }, 10000).catch(() => {});
      return { ok: false };
    }
    if (existingDb?.expires_at && Date.parse(existingDb.expires_at) <= Date.now()) {
      remoteSessionStates.delete(sessionId);
      deleteSession(existingDb.id);
      purgeMasterAuthCopiesForSession(existingDb.id);
      void sendCommandToWorker(node, 'stop_session', { sessionId, purge: true }, 10000).catch(() => {});
      return { ok: false };
    }

    const connectedPhone = phoneNumber || normalizePhoneDigits(existingDb?.phone_number || '');
    const now = Date.now();
    remoteSessionStates.set(sessionId, {
      sessionId,
      userId: owner.id,
      workerNodeId: node.id,
      workerNodeName: node.name,
      status: 'connected',
      hasCreds: true,
      qrCodeUrl: null,
      pairingCode: null,
      phoneNumber: connectedPhone || null,
      lastUpdated: now
    });

    const clearKeys = [sessionId, `${owner.id}:${sessionId}`];
    if (connectedPhone) clearKeys.push(`${owner.id}:${connectedPhone}`);
    clearSessionExpiryAlertSent(clearKeys);
    cancelQueuedSessionExpiryNotifications({
      userId: owner.id,
      sessionId,
      phone: connectedPhone || undefined
    });

    const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    if (existingDb) {
      updateSession(existingDb.id, {
        id: sessionId,
        status: 'connected',
        phone_number: connectedPhone || existingDb.phone_number,
        user_id: owner.id,
        worker_node_id: node.id,
        worker_node_name: node.name,
        connected_at: existingDb.status === 'connected' ? (existingDb.connected_at || new Date().toISOString()) : new Date().toISOString(),
        expires_at: existingDb.expires_at || expiryDate
      });
    } else {
      addSession({
        id: sessionId,
        session_name: `WA - ${connectedPhone || sessionId}`,
        phone_number: connectedPhone,
        auth_method: 'qr_code',
        status: 'connected',
        user_id: owner.id,
        is_primary: true,
        worker_node_id: node.id,
        worker_node_name: node.name,
        expires_at: expiryDate
      });
    }

    if (
      owner.role !== 'admin' &&
      owner.ai_enabled === true &&
      Array.isArray(owner.meta_ai_verified_phones) &&
      owner.meta_ai_verified_phones.length > 0 &&
      !isPhoneMetaAiVerifiedForUser(owner, connectedPhone)
    ) {
      updateUser(owner.id, { ai_enabled: false });
    }

    if (owner.role === 'admin' && drainSuperadminQueueCb) {
      setTimeout(() => {
        drainSuperadminQueueCb?.('worker_admin_open').catch(() => {});
      }, 2500);
    }

    const expRes = enforceFreeAutoReplyExpirationForUser(owner.id);
    const freshOwner = expRes.user || owner;
    if (!isUserAutoReplyAllowed(freshOwner)) {
      scheduleWorkerDormantDetach(node, sessionId, 15000);
    }

    return { ok: true };
  }

  if (event === 'fatal_close' || event === 'disconnected') {
    const existingMeta = existingDb;
    const resolvedPhone = phoneNumber || normalizePhoneDigits(existingMeta?.phone_number || '');
    remoteSessionStates.set(sessionId, {
      sessionId,
      userId: owner?.id,
      workerNodeId: node.id,
      workerNodeName: node.name,
      status: 'disconnected',
      qrCodeUrl: null,
      pairingCode: null,
      phoneNumber: resolvedPhone || null,
      lastUpdated: Date.now()
    });

    if (event === 'fatal_close') {
      if (notifyExpiredCb && (existingMeta?.status === 'connected' || resolvedPhone)) {
        const sc = Number(body?.statusCode || 0);
        await notifyExpiredCb({
          sessionId,
          sessionName: existingMeta?.session_name,
          expiredPhone: resolvedPhone,
          userId: owner?.id || existingMeta?.user_id,
          reason:
            sc === 401
              ? 'perangkat telah keluar dari menu Perangkat Tertaut pada aplikasi WhatsApp Anda'
              : 'tautan perangkat WhatsApp telah terputus sehingga perlu ditautkan ulang'
        }).catch(() => {});
      }
      remoteSessionStates.delete(sessionId);
      deleteSession(sessionId);
      purgeMasterAuthCopiesForSession(sessionId);
    } else {
      if (notifyExpiredCb && existingMeta?.status === 'connected') {
        await notifyExpiredCb({
          sessionId,
          sessionName: existingMeta?.session_name,
          expiredPhone: resolvedPhone,
          userId: owner?.id || existingMeta?.user_id,
          reason: 'koneksi perangkat WhatsApp terputus dan belum dapat tersambung kembali secara otomatis'
        }).catch(() => {});
      }
      remoteSessionStates.delete(sessionId);
      deleteSession(sessionId);
      purgeMasterAuthCopiesForSession(sessionId);
      void sendCommandToWorker(node, 'stop_session', { sessionId, purge: true }, 10000).catch(() => {});
    }
    return { ok: true };
  }

  return { ok: true };
}

// =========================================================================
// WORKER -> MASTER INCOMING CHAT & /SEND BRIDGE EVALUATION
// =========================================================================

function parseSlashSendTasks(rawArgs: string): Array<{ targetPhone: string; messageToSend: string }> {
  const cleanedInput = rawArgs.replace(/^\/(?:send|broadcast|kirim|kirimpesan)\b\s*/i, '').trim();
  if (!cleanedInput) return [];

  const nonEmptyLines = cleanedInput
    .split(/\r?\n/)
    .map(l => l.replace(/^\/(?:send|broadcast|kirim|kirimpesan)\b\s*/i, '').trim())
    .filter(Boolean);

  if (nonEmptyLines.length > 1) {
    const perLineTasks: Array<{ targetPhone: string; messageToSend: string }> = [];
    let allLinesHaveOwnMsg = true;
    for (const line of nonEmptyLines) {
      const m = line.match(/^(\+?[0-9][0-9\-()]{7,15})\s*[:|\-]?\s+(.+)$/);
      if (m) {
        const digits = m[1].replace(/\D/g, '');
        const msg = m[2].trim();
        const msgDigitsOnly = msg.replace(/[\s,;+\-()]/g, '');
        const looksLikePhoneList = /^[0-9]+$/.test(msgDigitsOnly) && msgDigitsOnly.length >= 8;
        if (digits.length >= 8 && digits.length <= 16 && msg && !looksLikePhoneList) {
          perLineTasks.push({ targetPhone: digits, messageToSend: msg });
        } else {
          allLinesHaveOwnMsg = false;
          break;
        }
      } else {
        allLinesHaveOwnMsg = false;
        break;
      }
    }
    if (allLinesHaveOwnMsg && perLineTasks.length > 1) return perLineTasks;
  }

  if (cleanedInput.includes('|')) {
    const pipeIdx = cleanedInput.indexOf('|');
    const phones = cleanedInput
      .substring(0, pipeIdx)
      .split(/[\s,;]+/)
      .map(p => p.replace(/\D/g, ''))
      .filter(p => p.length >= 8 && p.length <= 16);
    const msgPart = cleanedInput.substring(pipeIdx + 1).trim();
    if (phones.length > 0 && msgPart) {
      return Array.from(new Set(phones)).map(targetPhone => ({ targetPhone, messageToSend: msgPart }));
    }
  }

  const phones: string[] = [];
  let pos = 0;
  while (pos < cleanedInput.length) {
    const wsMatch = cleanedInput.slice(pos).match(/^[\s,;]+/);
    if (wsMatch) pos += wsMatch[0].length;
    const tokMatch = cleanedInput.slice(pos).match(/^([^\s]+)/);
    if (!tokMatch) break;
    const token = tokMatch[1];
    const subParts = token.split(/[,;]+/).filter(Boolean);
    const isAllPhones =
      subParts.length > 0 &&
      subParts.every(sp => {
        const digits = sp.replace(/\D/g, '');
        return /^[\d+\-()]+$/.test(sp) && digits.length >= 8 && digits.length <= 16;
      });
    if (isAllPhones) {
      subParts.forEach(sp => phones.push(sp.replace(/\D/g, '')));
      pos += token.length;
    } else {
      break;
    }
  }
  if (phones.length > 0) {
    const msgPart = cleanedInput.slice(pos).replace(/^[\s:,\-|]+/, '').trim();
    if (msgPart) {
      return Array.from(new Set(phones)).map(targetPhone => ({ targetPhone, messageToSend: msgPart }));
    }
  }

  const flexMatch = cleanedInput.match(/^(\+?[0-9][0-9\-\s]{7,17}?)\s+([\s\S]+)$/);
  if (flexMatch) {
    const digits = flexMatch[1].replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 16 && flexMatch[2].trim()) {
      return [{ targetPhone: digits, messageToSend: flexMatch[2].trim() }];
    }
  }

  return [];
}

export async function evaluateWorkerIncomingMessage(node: WorkerNode, body: any): Promise<any> {
  touchWorkerNodeAlive(node);
  const check = verifyWorkerSessionOwnership(node, String(body?.sessionId || ''));
  if (!check.ok || !check.sessionId) {
    return { action: 'ignore' };
  }
  const sessionId = check.sessionId;
  const senderPhoneRaw = String(body?.senderPhone || '').trim();
  const cleanSender = senderPhoneRaw.replace(/\D/g, '');
  const senderName = String(body?.senderName || 'Pelanggan').trim().slice(0, 120) || 'Pelanggan';
  const remoteJid = String(body?.remoteJid || '').trim();
  const messageText = String(body?.messageText || '').trim();
  const rawMessageText = String(body?.rawMessageText || '').trim();
  const hasMediaAttachment = Boolean(body?.hasMediaAttachment);
  const fromMe = Boolean(body?.fromMe);
  const connectedPhone = normalizePhoneDigits(body?.connectedPhone || '');

  const db = initDbFile();
  let dbSession = getSessionById(sessionId);
  if (!dbSession && connectedPhone) {
    dbSession =
      db.sessions.find(s => s.phone_number && normalizePhoneDigits(s.phone_number) === connectedPhone) || null;
  }

  let sessionUserId = dbSession?.user_id || (body?.userId ? String(body.userId) : undefined);
  if (!sessionUserId && connectedPhone) {
    const matched = db.users.find(u => u.phone && normalizePhoneDigits(u.phone) === connectedPhone);
    if (matched) sessionUserId = matched.id;
  }
  if (!sessionUserId) {
    sessionUserId = extractUserIdFromSessionId(sessionId, db.users);
  }
  const sessionUser = sessionUserId ? getUserById(sessionUserId) : null;

  if (sessionUser && sessionUser.is_active && sessionUser.email_verified) {
    markRemoteSessionLiveFromWorkerActivity(node, sessionId, sessionUser.id, connectedPhone);
    dbSession = getSessionById(sessionId) || dbSession;
  }

  // Check remote slash command (/send, /broadcast, /status, /help, /batal)
  const senderUser =
    db.users.find(u => {
      if (!u.phone) return false;
      const p = normalizePhoneDigits(u.phone);
      return p === cleanSender || (p.length >= 8 && cleanSender.endsWith(p.slice(-8)));
    }) || sessionUser;

  const isSelf = Boolean(
    fromMe ||
      (connectedPhone &&
        (cleanSender === connectedPhone ||
          (connectedPhone.length >= 8 && cleanSender.endsWith(connectedPhone.slice(-8)))))
  );
  const isOwner = Boolean(
    senderUser?.phone &&
      (normalizePhoneDigits(senderUser.phone) === cleanSender ||
        (cleanSender.length >= 8 && cleanSender.endsWith(normalizePhoneDigits(senderUser.phone).slice(-8))))
  );
  const isAllowed = Boolean(
    senderUser?.allowed_numbers &&
      senderUser.allowed_numbers.some(
        n => normalizePhoneDigits(n) === cleanSender || cleanSender.endsWith(normalizePhoneDigits(n).slice(-8))
      )
  );

  const stateKey = `${sessionId}:${remoteJid || cleanSender}`;
  const dialog = remoteCommandDialogs.get(stateKey);
  const hasActiveDialog = Boolean(dialog && Date.now() - dialog.updatedAt <= 15 * 60 * 1000);
  const isSlash = messageText.startsWith('/');

  if (isSlash || hasActiveDialog || isSelf || isOwner || isAllowed) {
    if (isSlash) {
      const cmd = messageText.split(/\s+/)[0].toLowerCase();
      if (cmd === '/batal' || cmd === '/cancel') {
        remoteCommandDialogs.delete(stateKey);
        return { action: 'reply', replyText: '✓ *Perintah interaktif telah dibatalkan.*' };
      }
      if (cmd === '/status' || cmd === '/saldo' || cmd === '/kuota' || cmd === '/cekkuota' || cmd === '/statusbot') {
        const u = senderUser || sessionUser;
        const plans = getSubscriptionPlans();
        const plan = plans.find(p => p.id === u?.plan_id) || plans[0];
        const usedToday = u?.daily_messages_sent || 0;
        const remainingToday = Math.max(0, (plan?.daily_msg_limit || 100) - usedToday);
        return {
          action: 'reply',
          replyText:
            `📊 *Status Layanan WhatsApp*\n\n` +
            `• Akun: *${u?.name || 'Operator'}* (@${u?.username || 'user'})\n` +
            `• Paket: *${plan?.name || 'Pro'}*\n` +
            `• Nomor Terhubung: *${connectedPhone || 'Terhubung'}*\n` +
            `• Sisa Kuota Hari Ini: *${remainingToday} / ${plan?.daily_msg_limit || 100} pesan*\n` +
            `• Status Koneksi: *TERHUBUNG (Aktif)*`
        };
      }
      if (cmd === '/help' || cmd === '/bantuan' || cmd === '/menu') {
        return {
          action: 'reply',
          replyText:
            `🤖 *Panduan Perintah WhatsApp*\n\n` +
            `1️⃣ */send <nomor_tujuan> <isi_pesan>*\n` +
            `2️⃣ */broadcast <nomor1>,<nomor2> <isi_pesan>*\n` +
            `3️⃣ */status* — Cek sisa kuota & status koneksi\n` +
            `4️⃣ */batal* — Batalkan dialog pengiriman aktif`
        };
      }
      if (cmd === '/send' || cmd === '/broadcast' || cmd === '/kirim' || cmd === '/kirimpesan') {
        const fullArgs = messageText.substring(cmd.length).trim();
        const tasks = parseSlashSendTasks(fullArgs);
        if (tasks.length === 0) {
          remoteCommandDialogs.set(stateKey, { step: 'awaiting_direct_target', updatedAt: Date.now() });
          return {
            action: 'reply',
            replyText:
              `📱 *Template Kirim Pesan & Broadcast*\n\nBalas pesan ini dengan format:\n*08123456789 Halo kak, pesanan Anda siap!*\n\n_Ketik */batal* untuk membatalkan._`
          };
        }
        remoteCommandDialogs.delete(stateKey);
        return await executeWorkerSlashTasks(node, sessionId, senderUser || sessionUser, connectedPhone, tasks);
      }
      return {
        action: 'reply',
        replyText: `ℹ️ Perintah *${cmd}* tidak dikenali. Gunakan */send*, */broadcast*, */status*, atau */help*.`
      };
    }

    if (hasActiveDialog && dialog?.step === 'awaiting_direct_target') {
      const tasks = parseSlashSendTasks(messageText);
      if (tasks.length > 0) {
        remoteCommandDialogs.delete(stateKey);
        return await executeWorkerSlashTasks(node, sessionId, senderUser || sessionUser, connectedPhone, tasks);
      }
      return {
        action: 'reply',
        replyText: `⚠️ Format belum sesuai. Contoh: *08123456789 Halo kak, pesanan siap* (atau ketik */batal*).`
      };
    }

    // Anti-loop: normal messages from own/owner number are silently ignored
    return { action: 'ignore' };
  }

  // Normal incoming customer chat
  if (!sessionUser || !sessionUser.is_active || !sessionUser.email_verified) {
    void sendCommandToWorker(node, 'stop_session', { sessionId, purge: true }, 10000).catch(() => {});
    return { action: 'ignore' };
  }

  if (dbSession?.expires_at && Date.parse(dbSession.expires_at) < Date.now()) {
    scheduleWorkerDormantDetach(node, sessionId, 3000);
    return { action: 'ignore' };
  }

  const expRes = enforceFreeAutoReplyExpirationForUser(sessionUser.id);
  const freshSessionUser = expRes.user || sessionUser;
  if (!isUserAutoReplyAllowed(freshSessionUser)) {
    if (expRes.expiredNow) {
      void sendCommandToWorker(node, 'stop_session', { sessionId, purge: true }, 10000).catch(() => {});
    }
    return { action: 'ignore' };
  }

  const resolvedOwnerId = sessionUser.id;
  const scopeId = resolvedOwnerId || sessionId;
  const antiBan = getAntiBanSettings();
  const rules = getAutoReplyRules(resolvedOwnerId).filter(r => r.is_active);
  const textLower = messageText.toLowerCase().trim();

  let matchedRule = null;
  for (const rule of rules) {
    const kw = rule.keyword.toLowerCase().trim();
    if (rule.match_type === 'exact' && textLower === kw) {
      matchedRule = rule;
      break;
    }
    if (rule.match_type === 'startsWith' && textLower.startsWith(kw)) {
      matchedRule = rule;
      break;
    }
    if (rule.match_type === 'contains' && textLower.includes(kw)) {
      matchedRule = rule;
      break;
    }
  }

  if (matchedRule) {
    const replyText = matchedRule.response_text
      .replace(/\{nama\}/gi, senderName)
      .replace(/\{pesan\}/gi, messageText);
    recordCustomerTurn(scopeId, senderPhoneRaw, 'customer', messageText);
    recordCustomerTurn(scopeId, senderPhoneRaw, 'assistant', replyText);
    return {
      action: 'reply',
      userId: resolvedOwnerId,
      replyText,
      isAi: false,
      matchedRuleId: matchedRule.id,
      antiBan
    };
  }

  const sysConfig = getSystemConfig();
  const effectiveAi = resolveEffectiveSessionAiSettings({
    user: sessionUser,
    session: dbSession,
    sysConfig
  });

  const activeCatalog = getActiveCatalogForAi(resolvedOwnerId);
  const orderFlow = prepareOrderFlowForIncomingMessage({
    scopeId,
    senderPhone: senderPhoneRaw,
    messageText,
    catalog: activeCatalog,
    hasMediaAttachment
  });
  const priorHistory = orderFlow.context.history.slice(-6).map(h => ({ role: h.role, text: h.text }));
  recordCustomerTurn(scopeId, senderPhoneRaw, 'customer', messageText);

  if (orderFlow.directReply) {
    const sendQrisImage = Boolean(orderFlow.directReply.sendQrisImage);
    const qrisImageBase64 = sendQrisImage
      ? resolveLocalCatalogQrisBase64(orderFlow.directReply.qrisImageUrl || orderFlow.directReply.qrisPublicUrl)
      : undefined;
    recordCustomerTurn(scopeId, senderPhoneRaw, 'assistant', orderFlow.directReply.text);
    return {
      action: 'reply',
      userId: resolvedOwnerId,
      replyText: orderFlow.directReply.text,
      isAi: false,
      sendQrisImage,
      qrisImageBase64,
      qrisPublicUrl: orderFlow.directReply.qrisPublicUrl,
      antiBan
    };
  }

  const aiQuotaCheck = canUseAiQuota(resolvedOwnerId);
  if (effectiveAi.aiEnabled && aiQuotaCheck.allowed) {
    const metaPrompt = buildMetaAiPrompt({
      userId: resolvedOwnerId,
      sessionId,
      senderPhone: senderPhoneRaw,
      senderName,
      messageBody: rawMessageText || messageText,
      customSystemPrompt: effectiveAi.systemPrompt,
      autoReplyRules: rules,
      catalogShopName: activeCatalog.shopName,
      catalogProducts: activeCatalog.enabled ? activeCatalog.products : undefined,
      customerCode: orderFlow.context.customerCode,
      customerHistory: priorHistory,
      orderSummary: orderFlow.orderSummaryForPrompt || undefined,
      paymentSummary: orderFlow.paymentSummaryForPrompt || undefined
    });

    return {
      action: 'ask_meta_ai',
      userId: resolvedOwnerId,
      metaPrompt,
      orderContextPayload: {
        customerCode: orderFlow.context.customerCode,
        isPaymentSubmission: orderFlow.isPaymentSubmission,
        hasMediaAttachment
      },
      antiBan
    };
  }

  // Deterministic order fallback or default CS fallback
  let replyText = '';
  if (orderFlow.context.cart.length > 0) {
    const det = buildDeterministicOrderFallbackReply({
      context: orderFlow.context,
      catalog: activeCatalog,
      messageText,
      isPaymentSubmission: orderFlow.isPaymentSubmission
    });
    if (det) replyText = det;
  }

  if (!replyText && freshSessionUser.default_cs_reply_enabled === true) {
    const tpl =
      freshSessionUser.default_cs_reply_text ||
      freshSessionUser.custom_offline_message ||
      sysConfig.ai_config.offline_fallback_message ||
      'Halo *{nama}*, terima kasih telah menghubungi kami. Tim Customer Service kami akan segera membalas pesan Anda sesegera mungkin.';
    replyText = tpl.replace(/\{nama\}/gi, senderName).replace(/\{pesan\}/gi, messageText);
  }

  if (replyText) {
    recordCustomerTurn(scopeId, senderPhoneRaw, 'assistant', replyText);
  }

  return {
    action: replyText ? 'reply' : 'ignore',
    userId: resolvedOwnerId,
    replyText,
    isAi: false,
    antiBan
  };
}

async function executeWorkerSlashTasks(
  node: WorkerNode,
  sessionId: string,
  user: ReturnType<typeof getUserById> | null,
  connectedPhone: string,
  tasks: Array<{ targetPhone: string; messageToSend: string }>
): Promise<any> {
  if (tasks.length === 1) {
    const { targetPhone, messageToSend } = tasks[0];
    if (user) {
      const q = deductUserDailyQuota(user.id);
      if (!q.allowed) {
        return { action: 'reply', replyText: `❌ *Gagal Kirim:* ${q.message || 'Kuota harian habis.'}` };
      }
    }
    const cleanTarget = normalizePhoneDigits(targetPhone);
    try {
      const sent = await sendCommandToWorker(
        node,
        'send_text',
        { sessionId, recipientPhone: cleanTarget, text: messageToSend },
        20000
      );
      addMessageLog({
        wam_id: sent?.wam_id || `wcmd_${Date.now()}`,
        session_id: sessionId,
        user_id: user?.id,
        sender_phone: cleanTarget,
        sender_name: `Tujuan (${cleanTarget})`,
        message_body: messageToSend,
        direction: 'outgoing',
        status: 'Sukses',
        reply_body: 'Dikirim via Remote WhatsApp Command (/send)'
      });
      return {
        action: 'reply',
        replyText:
          `✅ *Pesan Berhasil Terkirim!*\n\n• Nomor Tujuan: *${cleanTarget}*\n• Isi Pesan: "${messageToSend}"\n• Melalui Nomor: *${connectedPhone || 'Layanan WhatsApp'}*`
      };
    } catch (err: any) {
      return {
        action: 'reply',
        replyText: `❌ *Gagal mengirim pesan ke ${cleanTarget}:* ${err?.message || 'Terjadi kendala saat mengirim pesan'}`
      };
    }
  }

  let successCount = 0;
  let failedCount = 0;
  const successPhones: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const cleanTarget = normalizePhoneDigits(tasks[i].targetPhone);
    if (!cleanTarget || cleanTarget.length < 8) {
      failedCount++;
      continue;
    }
    if (user) {
      const q = deductUserDailyQuota(user.id);
      if (!q.allowed) {
        failedCount++;
        continue;
      }
    }
    try {
      const sent = await sendCommandToWorker(
        node,
        'send_text',
        { sessionId, recipientPhone: cleanTarget, text: tasks[i].messageToSend },
        20000
      );
      successCount++;
      successPhones.push(cleanTarget);
      addMessageLog({
        wam_id: sent?.wam_id || `wbc_${Date.now()}_${i}`,
        session_id: sessionId,
        user_id: user?.id,
        sender_phone: cleanTarget,
        sender_name: `Broadcast (${cleanTarget})`,
        message_body: tasks[i].messageToSend,
        direction: 'outgoing',
        status: 'Sukses',
        reply_body: 'Dikirim via Broadcast WhatsApp (/broadcast)'
      });
    } catch {
      failedCount++;
    }
    if (i < tasks.length - 1) {
      await new Promise(r => setTimeout(r, 900));
    }
  }

  addBroadcastHistory({
    user_id: user?.id,
    session_id: sessionId,
    recipients_count: tasks.length,
    message: tasks[0]?.messageToSend || 'Broadcast Multi-Pesan',
    status: failedCount === tasks.length ? 'failed' : 'completed',
    success_count: successCount,
    failed_count: failedCount
  });

  return {
    action: 'reply',
    replyText:
      `✅ *Broadcast Selesai Diproses!*\n\n` +
      `• Total Tujuan: *${tasks.length} Nomor*\n` +
      `• Berhasil Terkirim: *${successCount} Nomor*\n` +
      `• Gagal: *${failedCount} Nomor*` +
      (successPhones.length > 0 ? `\n• Penerima: *${successPhones.slice(0, 6).join(', ')}*` : '')
  };
}

export async function finalizeWorkerAiReply(node: WorkerNode, body: any): Promise<any> {
  touchWorkerNodeAlive(node);
  const check = verifyWorkerSessionOwnership(node, String(body?.sessionId || ''));
  if (!check.ok || !check.sessionId) {
    throw new Error(check.reason || 'Sesi tidak sah.');
  }
  const sessionId = check.sessionId;
  markRemoteSessionLiveFromWorkerActivity(node, sessionId, body?.userId, body?.connectedPhone);
  const senderPhone = String(body?.senderPhone || '').trim();
  const senderName = String(body?.senderName || 'Pelanggan').trim();
  const rawMessageText = String(body?.rawMessageText || '').trim();
  const hasMediaAttachment = Boolean(body?.hasMediaAttachment);
  const aiOk = Boolean(body?.aiOk);
  const aiRawText = String(body?.aiRawText || '').trim();
  const aiErrorReason = String(body?.aiErrorReason || '').trim();
  const payloadCtx = body?.orderContextPayload || {};

  const dbSess = getSessionById(sessionId);
  const userId = String(body?.userId || dbSess?.user_id || '').trim();
  const sessionUser = userId ? getUserById(userId) : null;
  const scopeId = userId || sessionId;
  const antiBan = getAntiBanSettings();
  const activeCatalog = getActiveCatalogForAi(userId);
  const sysConfig = getSystemConfig();

  const ctx = getOrCreateCustomerContext(scopeId, senderPhone);
  const isPaymentSubmission = Boolean(payloadCtx?.isPaymentSubmission);

  let replyText = '';
  let isAi = false;
  let sendQrisImage = false;
  let qrisImageUrl: string | undefined;
  let qrisPublicUrl: string | undefined;
  let orderPaidVerified = false;

  if (aiOk && aiRawText) {
    const cleanedBase = cleanMetaAiReply(aiRawText) || stripCustomerCodeTags(aiRawText);
    const cleaned = reconcileCatalogImageLinksInReply(
      cleanedBase,
      rawMessageText,
      activeCatalog.enabled ? activeCatalog.products : undefined
    );
    const directive = parseAndHandleAiPaymentDirectives(cleaned, activeCatalog, {
      customerContext: ctx,
      isPaymentSubmission
    });
    replyText = directive.cleanText;
    sendQrisImage = directive.sendQrisImage;
    qrisImageUrl = directive.qrisImageUrl;
    qrisPublicUrl = directive.qrisPublicUrl;
    orderPaidVerified = directive.orderPaidVerified;
    isAi = true;

    const sessPhone = dbSess?.phone_number || remoteSessionStates.get(sessionId)?.phoneNumber;
    if (sessionUser && sessPhone && !isPhoneMetaAiVerifiedForUser(sessionUser, sessPhone)) {
      markUserMetaAiVerified(sessionUser.id, sessPhone);
    }
  } else if (aiErrorReason) {
    const sessPhone = dbSess?.phone_number || remoteSessionStates.get(sessionId)?.phoneNumber;
    const aiErrorCode = String(body?.aiErrorCode || '').trim();
    if (
      sessionUser &&
      sessionUser.role !== 'admin' &&
      sessPhone &&
      !isPhoneMetaAiVerifiedForUser(sessionUser, sessPhone) &&
      (aiErrorCode === 'bot_unavailable_fanout' ||
        aiErrorCode === 'ACK_463' ||
        aiErrorCode === 'ACK_488' ||
        /bot_unavailable_fanout|belum pernah memulai percakapan dengan Meta AI|belum didukung atau belum aktif|dibatasi oleh layanan WhatsApp|error 463|error 488/i.test(
          aiErrorReason
        ))
    ) {
      if (dbSess) updateSession(dbSess.id, { ai_enabled: false });
      const hasAny = Array.isArray(sessionUser.meta_ai_verified_phones) && sessionUser.meta_ai_verified_phones.length > 0;
      if (!hasAny) updateUser(sessionUser.id, { ai_enabled: false });
    }
  }

  if (!replyText && ctx.cart.length > 0) {
    const det = buildDeterministicOrderFallbackReply({
      context: ctx,
      catalog: activeCatalog,
      messageText: rawMessageText,
      isPaymentSubmission
    });
    if (det) replyText = det;
  }

  if (!replyText && sessionUser && isUserAutoReplyAllowed(sessionUser) && sessionUser.default_cs_reply_enabled === true) {
    const tpl =
      sessionUser.default_cs_reply_text ||
      sessionUser.custom_offline_message ||
      sysConfig.ai_config.offline_fallback_message ||
      'Halo *{nama}*, terima kasih telah menghubungi kami. Tim Customer Service kami akan segera membalas pesan Anda sesegera mungkin.';
    replyText = tpl.replace(/\{nama\}/gi, senderName).replace(/\{pesan\}/gi, rawMessageText);
  }

  if (replyText) {
    recordCustomerTurn(scopeId, senderPhone, 'assistant', replyText);
  }

  if (orderPaidVerified) {
    const paidSnapshot = completeAndConsumeVerifiedPaidOrder(scopeId, senderPhone);
    if (paidSnapshot) {
      const ownerTargetPhone =
        resolveOrderNotificationRecipientPhone(userId) || activeCatalog.orderNotifyPhone || '';
      if (ownerTargetPhone && sendOrQueueSuperadminWaCb) {
        const ownerMsg = formatOwnerOrderNotificationMessage({
          snapshot: paidSnapshot,
          shopName: activeCatalog.shopName,
          customerPhone: senderPhone,
          customerName: senderName,
          customerNote: rawMessageText,
          hasMediaAttachment
        });
        await sendOrQueueSuperadminWaCb({
          recipientPhone: ownerTargetPhone,
          message: ownerMsg,
          category: 'order_notification',
          ownerUserId: userId,
          invoiceNumber: paidSnapshot.invoiceNumber
        }).catch(() => {});
      }
    }
  }

  const qrisImageBase64 = sendQrisImage
    ? resolveLocalCatalogQrisBase64(qrisImageUrl || qrisPublicUrl)
    : undefined;

  return {
    action: replyText ? 'reply' : 'ignore',
    userId,
    replyText,
    isAi,
    sendQrisImage,
    qrisImageBase64,
    qrisPublicUrl,
    antiBan
  };
}

export function recordWorkerMessageLogResult(node: WorkerNode, body: any): void {
  touchWorkerNodeAlive(node);
  const check = verifyWorkerSessionOwnership(node, String(body?.sessionId || ''));
  if (!check.ok || !check.sessionId) return;
  const sessionId = check.sessionId;
  markRemoteSessionLiveFromWorkerActivity(node, sessionId, body?.userId, body?.connectedPhone);
  const dbSess = getSessionById(sessionId);
  const userId = String(body?.userId || dbSess?.user_id || '').trim() || undefined;
  const success = Boolean(body?.success);
  const isAi = Boolean(body?.isAi);

  if (success && userId) {
    deductUserDailyQuota(userId);
    if (isAi) deductUserAiQuota(userId);
  }

  addMessageLog({
    wam_id: String(body?.wamId || `w_in_${Date.now()}`),
    session_id: dbSess?.id || sessionId,
    user_id: userId,
    sender_phone: String(body?.senderPhone || ''),
    sender_name: String(body?.senderName || 'Pelanggan'),
    message_body: String(body?.messageText || ''),
    direction: 'incoming',
    status: success ? 'Sukses' : 'Diterima',
    reply_body: body?.replyText ? String(body.replyText) : undefined,
    error_detail: body?.errorDetail ? String(body.errorDetail) : undefined,
    ai_generated: isAi,
    matched_rule_id: body?.matchedRuleId ? String(body.matchedRuleId) : undefined
  });
}

// =========================================================================
// MASTER -> WORKER SESSION & MESSAGING OPERATIONS
// =========================================================================

function runtimeStatusPriority(status: 'connected' | 'connecting' | 'disconnected'): number {
  return status === 'connected' ? 3 : status === 'connecting' ? 2 : 1;
}

export function getBestRemoteSessionRuntimeForSession(
  sessionId: string,
  phoneNumber?: string | null,
  userId?: string | null
): RemoteSessionRuntime | null {
  const direct = sessionId ? remoteSessionStates.get(sessionId) : undefined;
  if (direct && direct.status === 'connected') return direct;

  const cleanPhone = normalizePhoneDigits(phoneNumber || '');
  const canonicalUserId = userId ? getUserById(userId)?.id || userId : undefined;
  const matches: RemoteSessionRuntime[] = [];
  if (direct) matches.push(direct);

  for (const rt of remoteSessionStates.values()) {
    if (rt.sessionId === sessionId) {
      if (!matches.includes(rt)) matches.push(rt);
      continue;
    }
    const rtCanonicalUser = rt.userId ? getUserById(rt.userId)?.id || rt.userId : undefined;
    if (canonicalUserId && rtCanonicalUser && rtCanonicalUser !== canonicalUserId) continue;
    const rtPhone = normalizePhoneDigits(rt.phoneNumber || '');
    if (
      cleanPhone.length >= 8 &&
      rtPhone.length >= 8 &&
      (rtPhone === cleanPhone || rtPhone.endsWith(cleanPhone.slice(-8)))
    ) {
      matches.push(rt);
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const pDiff = runtimeStatusPriority(b.status) - runtimeStatusPriority(a.status);
    if (pDiff !== 0) return pDiff;
    return (b.lastUpdated || 0) - (a.lastUpdated || 0);
  });
  return matches[0];
}

export function getRemoteSessionRuntime(sessionIdOrPhone: string): RemoteSessionRuntime | null {
  if (!sessionIdOrPhone) return null;
  const direct = remoteSessionStates.get(sessionIdOrPhone);
  if (direct && direct.status === 'connected') return direct;

  const cleanPhone = normalizePhoneDigits(sessionIdOrPhone);
  const matches: RemoteSessionRuntime[] = [];
  if (direct) matches.push(direct);

  if (cleanPhone.length >= 8) {
    for (const rt of remoteSessionStates.values()) {
      const rtPhone = normalizePhoneDigits(rt.phoneNumber || '');
      if (rtPhone && (rtPhone === cleanPhone || rtPhone.endsWith(cleanPhone.slice(-8)))) {
        if (!matches.includes(rt)) matches.push(rt);
      }
    }
  }

  if (matches.length === 0) return direct || null;
  matches.sort((a, b) => {
    const pDiff = runtimeStatusPriority(b.status) - runtimeStatusPriority(a.status);
    if (pDiff !== 0) return pDiff;
    return (b.lastUpdated || 0) - (a.lastUpdated || 0);
  });
  return matches[0];
}

export function findRemoteConnectedSessionForUser(
  userId?: string,
  preferredSessionId?: string
): RemoteSessionRuntime | null {
  const now = Date.now();
  const nodesMap = new Map(getWorkerNodes().map(n => [n.id, n]));
  const canonicalUserId = userId ? getUserById(userId)?.id || userId : undefined;

  const isRtLive = (rt: RemoteSessionRuntime) => {
    if (rt.status !== 'connected') return false;
    const node = nodesMap.get(rt.workerNodeId);
    return Boolean(node && isNodeAlive(node, now));
  };

  if (preferredSessionId) {
    const rt = remoteSessionStates.get(preferredSessionId);
    const rtOwner = rt?.userId ? getUserById(rt.userId)?.id || rt.userId : undefined;
    if (rt && isRtLive(rt) && (!canonicalUserId || !rtOwner || rtOwner === canonicalUserId)) {
      return rt;
    }
  }

  const userSessions = userId ? getSessionsByUserId(userId) : [];
  for (const rt of remoteSessionStates.values()) {
    if (!isRtLive(rt)) continue;
    if (!canonicalUserId) return rt;
    const rtOwner = rt.userId ? getUserById(rt.userId)?.id || rt.userId : undefined;
    if (
      rtOwner === canonicalUserId ||
      isSessionOwnedByUserId(rt.sessionId, canonicalUserId) ||
      userSessions.some(s => s.id === rt.sessionId)
    ) {
      return rt;
    }
  }
  return null;
}

export function getAllRemoteConnectedSessions(): Array<{
  sessionId: string;
  userId?: string;
  phoneNumber?: string;
  workerNodeId?: string;
  workerNodeName?: string;
}> {
  const now = Date.now();
  const nodesMap = new Map(getWorkerNodes().map(n => [n.id, n]));
  const result: Array<{
    sessionId: string;
    userId?: string;
    phoneNumber?: string;
    workerNodeId?: string;
    workerNodeName?: string;
  }> = [];

  for (const rt of remoteSessionStates.values()) {
    if (rt.status !== 'connected') continue;
    const node = nodesMap.get(rt.workerNodeId);
    if (!node || !isNodeAlive(node, now)) continue;
    result.push({
      sessionId: rt.sessionId,
      userId: rt.userId,
      phoneNumber: rt.phoneNumber || undefined,
      workerNodeId: rt.workerNodeId,
      workerNodeName: rt.workerNodeName
    });
  }
  return result;
}

export function getPinnedAliveWorkerForSession(sessionId: string): WorkerNode | null {
  const dbSess = getSessionById(sessionId);
  const rt = remoteSessionStates.get(sessionId);
  const nodeId = dbSess?.worker_node_id || rt?.workerNodeId;
  if (!nodeId || nodeId === 'local') return null;
  const node = getWorkerNodeById(nodeId);
  if (!node || !isNodeAlive(node)) return null;
  return node;
}

export async function startSessionOnWorker(
  node: WorkerNode,
  params: { sessionId: string; phoneNumber?: string; userId?: string }
): Promise<RemoteSessionRuntime> {
  const authFiles = await loadWorkerAuthFilesFromMaster(params.sessionId).catch(() => undefined);
  const res = await sendCommandToWorker(
    node,
    'start_session',
    {
      sessionId: params.sessionId,
      phoneNumber: params.phoneNumber,
      userId: params.userId,
      authFiles
    },
    32000
  );

  const rt: RemoteSessionRuntime = {
    sessionId: params.sessionId,
    userId: params.userId,
    workerNodeId: node.id,
    workerNodeName: node.name,
    status: res?.status === 'connected' ? 'connected' : res?.status === 'disconnected' ? 'disconnected' : 'connecting',
    qrCodeUrl: res?.qrCodeUrl || null,
    pairingCode: null,
    phoneNumber: res?.phoneNumber ? normalizePhoneDigits(res.phoneNumber) : params.phoneNumber || null,
    lastUpdated: Date.now()
  };
  remoteSessionStates.set(params.sessionId, rt);

  const dbSess = getSessionById(params.sessionId);
  if (dbSess) {
    updateSession(dbSess.id, { worker_node_id: node.id, worker_node_name: node.name });
  }
  return rt;
}

export async function requestPairingOnWorker(
  node: WorkerNode,
  params: { sessionId: string; phoneNumber: string; userId?: string }
): Promise<string> {
  const cleanPhone = normalizePhoneDigits(params.phoneNumber);
  const res = await sendCommandToWorker(
    node,
    'request_pairing',
    {
      sessionId: params.sessionId,
      phoneNumber: cleanPhone,
      userId: params.userId
    },
    22000
  );
  const pairingCode = String(res?.pairingCode || '').trim();
  if (!pairingCode) {
    throw new Error('Worker tidak mengembalikan Kode Pairing.');
  }

  remoteSessionStates.set(params.sessionId, {
    sessionId: params.sessionId,
    userId: params.userId,
    workerNodeId: node.id,
    workerNodeName: node.name,
    status: 'connecting',
    qrCodeUrl: null,
    pairingCode,
    phoneNumber: cleanPhone,
    lastUpdated: Date.now()
  });

  const existingDbSess = getSessionById(params.sessionId);
  const defaultExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  if (!existingDbSess) {
    addSession({
      id: params.sessionId,
      session_name: `WA Pair - ${cleanPhone}`,
      phone_number: cleanPhone,
      auth_method: 'pairing_code',
      status: 'connecting',
      user_id: params.userId,
      is_primary: true,
      worker_node_id: node.id,
      worker_node_name: node.name,
      expires_at: defaultExpires
    });
  } else {
    updateSession(existingDbSess.id, {
      user_id: params.userId || existingDbSess.user_id,
      id: params.sessionId,
      worker_node_id: node.id,
      worker_node_name: node.name,
      expires_at: existingDbSess.expires_at || defaultExpires
    });
  }

  return pairingCode;
}

export async function refreshWorkerSessionStatus(sessionId: string): Promise<RemoteSessionRuntime | null> {
  const dbSess = getSessionById(sessionId);
  const candidateNodes: WorkerNode[] = [];
  const pinnedAlive = getPinnedAliveWorkerForSession(sessionId);
  if (pinnedAlive) candidateNodes.push(pinnedAlive);

  if (dbSess?.worker_node_id && dbSess.worker_node_id !== 'local') {
    const pinnedAny = getWorkerNodeById(dbSess.worker_node_id);
    if (pinnedAny && pinnedAny.status !== 'disabled' && pinnedAny.is_verified && !candidateNodes.some(n => n.id === pinnedAny.id)) {
      candidateNodes.push(pinnedAny);
    }
  }

  for (const n of getWorkerNodes()) {
    if (n.status === 'disabled' || !n.is_verified) continue;
    if (Array.isArray(n.session_ids) && n.session_ids.includes(sessionId) && !candidateNodes.some(x => x.id === n.id)) {
      candidateNodes.push(n);
    }
  }

  // If still no matching worker pinned, allow probing verified non-disabled workers
  if (candidateNodes.length === 0) {
    for (const n of getWorkerNodes()) {
      if (n.status !== 'disabled' && n.is_verified) {
        candidateNodes.push(n);
      }
    }
  }

  const cached = getBestRemoteSessionRuntimeForSession(sessionId, dbSess?.phone_number, dbSess?.user_id);
  for (const node of candidateNodes.slice(0, 5)) {
    try {
      const res = await sendCommandToWorker(node, 'get_status', { sessionId }, 5000);
      if (res) {
        touchWorkerNodeAlive(node);
        const status: 'connected' | 'connecting' | 'disconnected' =
          res.status === 'connected' ? 'connected' : res.status === 'connecting' ? 'connecting' : 'disconnected';
        if (status === 'disconnected' && candidateNodes.length > 1 && cached?.status === 'connected') {
          continue;
        }
        const next: RemoteSessionRuntime = {
          sessionId,
          userId: cached?.userId || dbSess?.user_id,
          workerNodeId: node.id,
          workerNodeName: node.name,
          status,
          hasCreds: Boolean(res.hasCreds || status === 'connected' || cached?.hasCreds),
          qrCodeUrl: res.qrCodeUrl || null,
          pairingCode: res.pairingCode || null,
          phoneNumber: res.phoneNumber ? normalizePhoneDigits(res.phoneNumber) : cached?.phoneNumber || dbSess?.phone_number || null,
          lastUpdated: Date.now()
        };
        if (status !== 'disconnected' || !cached || cached.workerNodeId === node.id) {
          remoteSessionStates.set(sessionId, next);
        }
        if (status === 'connected' || status === 'connecting') {
          return next;
        }
      }
    } catch {
      // Try next candidate worker
    }
  }
  return getBestRemoteSessionRuntimeForSession(sessionId, dbSess?.phone_number, dbSess?.user_id) || cached;
}

export async function probeRemoteWorkerSessions(targetUserId?: string): Promise<number> {
  const activeWorkers = getWorkerNodes().filter(n => n.status !== 'disabled' && n.is_verified);

  // 1. Poll telemetry from every non-disabled verified worker (even if watchdog previously flagged it offline)
  if (activeWorkers.length > 0) {
    await Promise.race([
      Promise.allSettled(
        activeWorkers.map(async node => {
          try {
            const listRes = await sendCommandToWorker(node, 'list_sessions', {}, 4000).catch(async () => {
              return await sendCommandToWorker(node, 'ping_verify', {}, 4000);
            });
            if (listRes) {
              const sessionsTelemetry = Array.isArray(listRes?.sessions) ? listRes.sessions : undefined;
              touchWorkerNodeAlive(node, sessionsTelemetry);
            }
          } catch {
            // Worker truly unreachable right now
          }
        })
      ),
      new Promise(resolve => setTimeout(resolve, 4200))
    ]);
  }

  const candidateIds = new Set<string>();
  const dbList = targetUserId ? getSessionsByUserId(targetUserId) : getWhatsAppSessions();
  for (const s of dbList) {
    const rt = getBestRemoteSessionRuntimeForSession(s.id, s.phone_number, s.user_id);
    if (!rt || rt.status !== 'connected') {
      if ((s.worker_node_id && s.worker_node_id !== 'local') || activeWorkers.length > 0) {
        candidateIds.add(s.id);
      }
    }
  }
  for (const rt of remoteSessionStates.values()) {
    if (rt.status === 'connected') continue;
    if (targetUserId) {
      const owner = resolveVerifiedWorkerSessionOwner(rt.sessionId, rt.userId, rt.phoneNumber || undefined);
      if (!owner || owner.id !== targetUserId) continue;
    }
    candidateIds.add(rt.sessionId);
  }
  for (const node of activeWorkers) {
    for (const sid of node.session_ids || []) {
      const existingRt = remoteSessionStates.get(sid);
      if (existingRt?.status === 'connected') continue;
      if (targetUserId) {
        const owner = resolveVerifiedWorkerSessionOwner(sid, undefined, undefined);
        const rawMatch = isSessionOwnedByUserId(sid, targetUserId);
        if (!rawMatch && (!owner || owner.id !== targetUserId)) continue;
      }
      candidateIds.add(sid);
    }
  }

  if (candidateIds.size > 0 && activeWorkers.length > 0) {
    await Promise.race([
      Promise.allSettled(Array.from(candidateIds).slice(0, 25).map(sid => refreshWorkerSessionStatus(sid))),
      new Promise(resolve => setTimeout(resolve, 4500))
    ]);
  }

  return reconcileRemoteWorkerSessionsIntoDb(targetUserId);
}

export async function reconnectSessionOnWorker(
  sessionId: string,
  userId?: string
): Promise<{
  handled: boolean;
  connected: boolean;
  runtime_status: 'connected' | 'connecting' | 'disconnected';
  needs_rescan: boolean;
  session_id: string;
  phone_number?: string;
  error?: string;
  code?: string;
  support_phone?: string;
  support_display_phone?: string;
  support_wa_link?: string;
}> {
  const dbSess = getSessionById(sessionId);
  let targetNode = getPinnedAliveWorkerForSession(sessionId);

  if (!targetNode) {
    const clusterCfg = getWorkerClusterConfig();
    const sel = selectExecutionTargetForSession(sessionId, { allowAnyOnlineFallback: true });
    if (sel.mode === 'worker') {
      targetNode = sel.node;
    } else if (clusterCfg.local_baileys_enabled !== false) {
      return {
        handled: false,
        connected: false,
        runtime_status: 'disconnected',
        needs_rescan: false,
        session_id: sessionId,
        phone_number: dbSess?.phone_number
      };
    } else {
      return {
        handled: true,
        connected: false,
        runtime_status: 'disconnected',
        needs_rescan: false,
        session_id: sessionId,
        phone_number: dbSess?.phone_number,
        error: sel.mode === 'rejected_no_worker' ? sel.error : 'Layanan penyambungan WhatsApp sedang penuh atau dalam pemeliharaan.',
        code: sel.mode === 'rejected_no_worker' ? sel.code : 'NO_AVAILABLE_WORKER',
        support_phone: sel.mode === 'rejected_no_worker' ? sel.support_phone : undefined,
        support_display_phone: sel.mode === 'rejected_no_worker' ? sel.support_display_phone : undefined,
        support_wa_link: sel.mode === 'rejected_no_worker' ? sel.support_wa_link : undefined
      };
    }
  }

  const authFiles = await loadWorkerAuthFilesFromMaster(sessionId).catch(() => undefined);
  if (!authFiles || !authFiles['creds.json']) {
    return {
      handled: true,
      connected: false,
      runtime_status: 'disconnected',
      needs_rescan: true,
      session_id: sessionId,
      phone_number: dbSess?.phone_number
    };
  }

  const res = await sendCommandToWorker(
    targetNode,
    'reconnect_session',
    {
      sessionId,
      phoneNumber: dbSess?.phone_number,
      userId: userId || dbSess?.user_id,
      authFiles
    },
    32000
  );

  const isConn = Boolean(res?.connected || res?.status === 'connected');
  remoteSessionStates.set(sessionId, {
    sessionId,
    userId: userId || dbSess?.user_id,
    workerNodeId: targetNode.id,
    workerNodeName: targetNode.name,
    status: isConn ? 'connected' : res?.status === 'connecting' ? 'connecting' : 'disconnected',
    qrCodeUrl: null,
    pairingCode: null,
    phoneNumber: res?.phoneNumber || dbSess?.phone_number || null,
    lastUpdated: Date.now()
  });

  if (dbSess && dbSess.worker_node_id !== targetNode.id) {
    updateSession(dbSess.id, { worker_node_id: targetNode.id, worker_node_name: targetNode.name });
  }

  const resolvedUid = userId || dbSess?.user_id;
  const owner = resolvedUid ? getUserById(resolvedUid) : null;
  if (isConn && owner && !isUserAutoReplyAllowed(owner)) {
    scheduleWorkerDormantDetach(targetNode, sessionId, 15000);
  }

  return {
    handled: true,
    connected: isConn,
    runtime_status: isConn ? 'connected' : res?.status === 'connecting' ? 'connecting' : 'disconnected',
    needs_rescan: false,
    session_id: sessionId,
    phone_number: res?.phoneNumber || dbSess?.phone_number
  };
}

const workerDormantDetachTimers = new Map<string, NodeJS.Timeout>();

export function cancelWorkerDormantDetach(sessionId: string): void {
  const existing = workerDormantDetachTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    workerDormantDetachTimers.delete(sessionId);
  }
}

export function scheduleWorkerDormantDetach(node: WorkerNode, sessionId: string, delayMs = 15000): void {
  cancelWorkerDormantDetach(sessionId);
  const t = setTimeout(() => {
    workerDormantDetachTimers.delete(sessionId);
    const dbSess = getSessionById(sessionId);
    const owner = dbSess?.user_id ? getUserById(dbSess.user_id) : null;
    const isSessExpired = Boolean(dbSess?.expires_at && Date.parse(dbSess.expires_at) <= Date.now());
    if (owner && isUserAutoReplyAllowed(owner) && !isSessExpired) return;
    remoteSessionStates.delete(sessionId);
    void sendCommandToWorker(node, 'stop_session', { sessionId, purge: true }, 12000).catch(() => {});
  }, delayMs);
  t.unref?.();
  workerDormantDetachTimers.set(sessionId, t);
}

export async function stopSessionOnWorker(sessionId: string, purge = true): Promise<boolean> {
  cancelWorkerDormantDetach(sessionId);
  const rtNodeId = remoteSessionStates.get(sessionId)?.workerNodeId;
  const dbNodeId = getSessionById(sessionId)?.worker_node_id;
  let node = getPinnedAliveWorkerForSession(sessionId);
  if (!node && (rtNodeId || dbNodeId)) {
    const candidate = getWorkerNodeById(rtNodeId || dbNodeId || '');
    if (candidate && candidate.status !== 'disabled') {
      node = candidate;
    }
  }
  remoteSessionStates.delete(sessionId);
  if (!node) return false;
  if (Array.isArray(node.session_ids) && node.session_ids.includes(sessionId)) {
    updateWorkerNode(
      node.id,
      { session_ids: node.session_ids.filter(id => id !== sessionId) },
      false
    );
  }
  try {
    await sendCommandToWorker(node, 'stop_session', { sessionId, purge }, 12000);
    return true;
  } catch {
    return false;
  }
}

export async function sendTextViaWorker(
  node: WorkerNode,
  sessionId: string,
  recipientPhone: string,
  text: string,
  options?: {
    authFiles?: Record<string, string>;
    sendOnlyEphemeral?: boolean;
    userId?: string;
    phoneNumber?: string;
  }
): Promise<{ success: true; wam_id: string }> {
  const res = await sendCommandToWorker(
    node,
    'send_text',
    {
      sessionId,
      recipientPhone: normalizePhoneDigits(recipientPhone),
      text,
      ...(options?.authFiles ? { authFiles: options.authFiles } : {}),
      ...(options?.sendOnlyEphemeral ? { sendOnlyEphemeral: true } : {}),
      ...(options?.userId ? { userId: options.userId } : {}),
      ...(options?.phoneNumber ? { phoneNumber: options.phoneNumber } : {})
    },
    options?.authFiles ? 34000 : 22000
  );
  return {
    success: true,
    wam_id: String(res?.wam_id || `wk_${Date.now()}`)
  };
}

export async function sendMediaViaWorker(
  node: WorkerNode,
  sessionId: string,
  recipientPhone: string,
  payload: {
    mediaType: 'image' | 'document' | 'video' | 'audio';
    mediaBuffer?: Buffer;
    mediaUrl?: string;
    mimetype?: string;
    fileName?: string;
    caption?: string;
  },
  options?: {
    authFiles?: Record<string, string>;
    sendOnlyEphemeral?: boolean;
    userId?: string;
    phoneNumber?: string;
  }
): Promise<{ success: true; wam_id: string }> {
  const res = await sendCommandToWorker(
    node,
    'send_media',
    {
      sessionId,
      recipientPhone: normalizePhoneDigits(recipientPhone),
      mediaType: payload.mediaType,
      mediaBase64: payload.mediaBuffer ? payload.mediaBuffer.toString('base64') : undefined,
      mediaUrl: payload.mediaUrl,
      mimetype: payload.mimetype,
      fileName: payload.fileName,
      caption: payload.caption,
      ...(options?.authFiles ? { authFiles: options.authFiles } : {}),
      ...(options?.sendOnlyEphemeral ? { sendOnlyEphemeral: true } : {}),
      ...(options?.userId ? { userId: options.userId } : {}),
      ...(options?.phoneNumber ? { phoneNumber: options.phoneNumber } : {})
    },
    36000
  );
  return {
    success: true,
    wam_id: String(res?.wam_id || `wk_med_${Date.now()}`)
  };
}

export async function askMetaAiViaWorker(
  node: WorkerNode,
  sessionId: string,
  promptText: string
): Promise<{ ok: boolean; text?: string; reason?: string; phoneNumber?: string }> {
  const res = await sendCommandToWorker(
    node,
    'ask_meta_ai',
    { sessionId, promptText },
    38000
  );
  return {
    ok: Boolean(res?.ok && res?.text),
    text: res?.text ? String(res.text) : undefined,
    reason: res?.reason ? String(res.reason) : undefined,
    phoneNumber: res?.phoneNumber ? normalizePhoneDigits(res.phoneNumber) : undefined
  };
}

export async function verifyMetaAiViaWorker(
  node: WorkerNode,
  sessionId: string
): Promise<{
  ok: boolean;
  connected: boolean;
  verified: boolean;
  code: 'WA_NOT_CONNECTED' | 'VERIFIED' | 'META_AI_NEEDS_FIRST_CHAT';
  sessionId: string;
  phoneNumber?: string;
  hasOfficialBotEntry: boolean;
  botReplyPreview?: string;
  diagnosticReason?: string;
  message: string;
}> {
  const probeRes = await askMetaAiViaWorker(node, sessionId, 'Halo, tes koneksi singkat ya. Cukup balas singkat saja.');
  if (probeRes.ok && probeRes.text) {
    const preview = cleanMetaAiReply(probeRes.text) || stripCustomerCodeTags(probeRes.text);
    return {
      ok: true,
      connected: true,
      verified: true,
      code: 'VERIFIED',
      sessionId,
      phoneNumber: probeRes.phoneNumber,
      hasOfficialBotEntry: true,
      botReplyPreview: preview.slice(0, 220),
      message: 'Meta AI aktif dan berhasil merespons! Fitur Meta AI Balas Otomatis siap diaktifkan.'
    };
  }
  return {
    ok: false,
    connected: true,
    verified: false,
    code: 'META_AI_NEEDS_FIRST_CHAT',
    sessionId,
    phoneNumber: probeRes.phoneNumber,
    hasOfficialBotEntry: false,
    diagnosticReason: probeRes.reason || 'Meta AI tidak merespons sapaan awal.',
    message:
      'Nomor WhatsApp ini belum pernah chat atau belum mengaktifkan Meta AI di aplikasi WhatsApp. Silakan chat Meta AI dulu di WhatsApp sampai dibalas, lalu klik Verifikasi.'
  };
}
