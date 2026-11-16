import zlib from 'zlib';
import { WorkerNode } from '../types/whatsapp.js';

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

export interface ZipEntryInput {
  name: string;
  content: string | Buffer;
}

/**
 * Builds a standard PKZIP buffer using Node built-in zlib (zero external dependencies).
 */
export function buildZipArchive(entries: ZipEntryInput[]): Buffer {
  const now = new Date();
  const { dosTime, dosDate } = toDosTimeDate(now);
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const cleanName = entry.name.replace(/^\/+/, '');
    const nameBuf = Buffer.from(cleanName, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, 'utf8');
    const compressedBuf = zlib.deflateRawSync(rawBuf);
    const crc = crc32(rawBuf);

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Signature
    localHeader.writeUInt16LE(20, 4); // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(8, 8); // Compression: Deflate
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra length

    localChunks.push(localHeader, nameBuf, compressedBuf);

    // Central Directory Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(8, 10); // Compression: Deflate
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedBuf.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra length
    centralHeader.writeUInt16LE(0, 32); // Comment length
    centralHeader.writeUInt16LE(0, 34); // Disk start
    centralHeader.writeUInt16LE(0, 36); // Internal attrs
    centralHeader.writeUInt32LE(0, 38); // External attrs
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header

    centralChunks.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressedBuf.length;
  }

  const centralDirBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD Signature
  eocd.writeUInt16LE(0, 4); // Disk number
  eocd.writeUInt16LE(0, 6); // Disk where central dir starts
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...localChunks, centralDirBuf, eocd]);
}

function buildMetaAiHelperSource(): string {
  return `import crypto from 'crypto';
import {
  META_AI_JID,
  aesDecryptGCM,
  areJidsSameUser,
  buildAckStanza,
  encodeSignedDeviceIdentity,
  encodeWAMessage,
  generateMessageIDV2,
  generateWAMessage,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  isJidBot,
  isJidMetaAI,
  jidDecode,
  jidNormalizedUser,
  parseAndInjectE2ESessions,
  proto,
  unpadRandomMax16
} from '@whiskeysockets/baileys';

const DEFAULT_META_AI_BOT_JID = '867051314767696@bot';
const DEFAULT_META_AI_PERSONA_ID = '867051314767696';
const FALLBACK_META_AI_JIDS = ['13135550002@s.whatsapp.net', META_AI_JID];
const HARD_TIMEOUT_MS = 34000;
const SILENT_FALLBACK_RETRY_MS = 9500;
const SETTLE_DEBOUNCE_MS = 1800;

const sessionQueues = new Map();
const activeWaiters = new Map();
const sessionMetaAiLids = new Map();
const sessionPreferredMetaJid = new Map();
const sessionBotEntries = new Map();
const sessionBotPersonas = new Map();
const pendingBotSecrets = new Map();
const sessionLatestBotSecret = new Map();
const sessionRejectedBotJids = new Map();
const botSignalReadyCache = new Map();
const wrappedSockets = new WeakMap();

export function isMetaAiJid(jid) {
  if (!jid || typeof jid !== 'string') return false;
  const trimmed = jid.trim();
  if (!trimmed) return false;
  try { if (typeof isJidMetaAI === 'function' && isJidMetaAI(trimmed)) return true; } catch {}
  try { if (typeof isJidBot === 'function' && isJidBot(trimmed)) return true; } catch {}
  try {
    if (areJidsSameUser(trimmed, DEFAULT_META_AI_BOT_JID)) return true;
    if (areJidsSameUser(trimmed, '13135550002@s.whatsapp.net')) return true;
  } catch {}
  let normalized = trimmed.toLowerCase();
  try { normalized = jidNormalizedUser(trimmed).toLowerCase(); } catch {}
  const [userPart = '', domainPart = ''] = normalized.split('@');
  const bareUser = userPart.split(':')[0];
  if (domainPart === 'bot') return true;
  if (bareUser === '867051314767696' || bareUser === '13135550002') return true;
  if (/^1313555\\d{4}$/.test(bareUser) || /^131655500\\d{2}$/.test(bareUser)) return true;
  return normalized === 'meta_ai@s.whatsapp.net';
}

function safeNormalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  try { return jidNormalizedUser(jid.trim()) || jid.trim(); } catch { return jid.trim(); }
}

function isRoutableOutgoingMetaJid(jid) {
  if (!jid || typeof jid !== 'string') return false;
  const clean = jid.trim();
  return clean.endsWith('@bot') || clean.endsWith('@lid') || clean.endsWith('@s.whatsapp.net');
}

export function isSessionMetaAiJid(sessionId, jid) {
  if (!jid || typeof jid !== 'string') return false;
  if (isMetaAiJid(jid)) return true;
  const knownLid = sessionMetaAiLids.get(sessionId);
  if (knownLid) {
    try { if (knownLid === jid || areJidsSameUser(knownLid, jid)) return true; } catch { if (knownLid === jid) return true; }
  }
  const bots = sessionBotEntries.get(sessionId)?.entries || [];
  for (const b of bots) {
    try { if (b.jid === jid || areJidsSameUser(b.jid, jid)) return true; } catch { if (b.jid === jid) return true; }
  }
  return false;
}

function rememberSessionMetaAiLid(sessionId, candidateJid, setPreferred = false) {
  if (!sessionId || !candidateJid || typeof candidateJid !== 'string') return;
  const clean = candidateJid.trim();
  if (!isRoutableOutgoingMetaJid(clean)) return;
  if (clean.endsWith('@lid')) sessionMetaAiLids.set(sessionId, clean);
  if (setPreferred && (clean.endsWith('@lid') || isMetaAiJid(clean))) {
    sessionPreferredMetaJid.set(sessionId, clean);
  }
}

function storePendingBotSecret(sessionId, msgId, botJid, messageSecret) {
  const now = Date.now();
  for (const [k, v] of pendingBotSecrets.entries()) {
    if (v.expiresAt <= now) pendingBotSecrets.delete(k);
  }
  const entry = { sessionId, msgId, botJid, messageSecret: Buffer.from(messageSecret), expiresAt: now + 90000 };
  pendingBotSecrets.set(\`\${sessionId}::\${msgId}\`, entry);
  sessionLatestBotSecret.set(sessionId, entry);
}

function decryptMsmsgCiphertext({ messageSecret, encPayload, encIv, msgIds, origSenders, modificationSenders }) {
  if (!messageSecret?.length || !encPayload?.length || !encIv?.length) return null;
  const payloadBuf = Buffer.from(encPayload);
  const ivBuf = Buffer.from(encIv);
  const secretBuf = Buffer.from(messageSecret);
  const botSecretBuf = Buffer.from(crypto.hkdfSync('sha256', secretBuf, Buffer.alloc(0), Buffer.from('Bot Message', 'utf8'), 32));
  const uniqueIds = Array.from(new Set(msgIds.filter(Boolean)));
  const uniqueOrig = Array.from(new Set(origSenders.filter(Boolean)));
  const uniqueMod = Array.from(new Set(modificationSenders.filter(Boolean)));
  for (const { ikm, modType } of [{ ikm: botSecretBuf, modType: '' }, { ikm: secretBuf, modType: 'Bot Message' }]) {
    for (const msgId of uniqueIds) {
      for (const origSender of uniqueOrig) {
        for (const modSender of uniqueMod) {
          try {
            const useCaseSecret = Buffer.concat([
              Buffer.from(msgId, 'utf8'),
              Buffer.from(origSender, 'utf8'),
              Buffer.from(modSender, 'utf8'),
              Buffer.from(modType, 'utf8')
            ]);
            const aesKey = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), useCaseSecret, 32));
            const aad = Buffer.from(\`\${msgId}\\u0000\${modSender}\`, 'utf8');
            const plaintext = aesDecryptGCM(payloadBuf, aesKey, ivBuf, aad);
            const decoded = proto.Message.decode(plaintext);
            if (decoded && typeof decoded === 'object') return decoded;
          } catch {}
        }
      }
    }
  }
  return null;
}

function unwrapMessage(message, depth = 0) {
  if (!message || typeof message !== 'object' || depth > 8) return null;
  const nested =
    message.editedMessage?.message ||
    message.protocolMessage?.editedMessage ||
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.deviceSentMessage?.message ||
    message.documentWithCaptionMessage?.message ||
    message.associatedChildMessage?.message ||
    message.botInvokeMessage?.message;
  if (nested) return unwrapMessage(nested, depth + 1);
  return message;
}

function extractTextFromMessage(message) {
  const unwrapped = unwrapMessage(message);
  if (!unwrapped) return '';
  let richText = '';
  const rich = unwrapped.richResponseMessage || message?.richResponseMessage;
  if (rich && Array.isArray(rich.submessages)) {
    const parts = [];
    for (const sub of rich.submessages) {
      const t = sub?.messageText || sub?.text || sub?.caption || '';
      if (typeof t === 'string' && t.trim()) parts.push(t.trim());
    }
    richText = parts.join('\\n').trim();
  }
  const text =
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.imageMessage?.caption ||
    unwrapped.videoMessage?.caption ||
    unwrapped.documentMessage?.caption ||
    richText ||
    '';
  return typeof text === 'string' ? text.trim() : '';
}

function isPlaceholderReply(text) {
  const n = String(text || '').trim();
  if (!n) return true;
  if (/^(\\.{1,6}|…+)$/.test(n)) return true;
  return /^(thinking|memikirkan|sedang berpikir|sedang memproses|processing|generating|loading|mengetik|typing)(\\.{0,5}|…)?$/i.test(n);
}

function finalizeWaiter(sessionId, result) {
  const w = activeWaiters.get(sessionId);
  if (!w || w.settled) return;
  w.settled = true;
  clearTimeout(w.hardTimer);
  if (w.settleTimer) clearTimeout(w.settleTimer);
  if (w.retryTimer) clearTimeout(w.retryTimer);
  activeWaiters.delete(sessionId);
  w.resolve(result);
}

function ingestCandidateText(sessionId, rawText, sourceJid) {
  const w = activeWaiters.get(sessionId);
  if (!w || w.settled) return;
  const trimmed = String(rawText || '').trim();
  if (!trimmed || trimmed === w.promptSent.trim()) return;
  w.hasSignal = true;
  if (isPlaceholderReply(trimmed)) return;
  if (sourceJid) rememberSessionMetaAiLid(sessionId, sourceJid, true);
  w.latestText = trimmed;
  if (w.settleTimer) clearTimeout(w.settleTimer);
  w.settleTimer = setTimeout(() => {
    const cur = activeWaiters.get(sessionId);
    if (cur && !cur.settled && cur.latestText) {
      finalizeWaiter(sessionId, { ok: true, text: cur.latestText });
    }
  }, SETTLE_DEBOUNCE_MS);
}

export function handleMetaAiIncomingUpsert(sessionId, msg) {
  const candidateJids = [
    msg?.key?.remoteJid,
    msg?.key?.remoteJidAlt,
    msg?.key?.participant,
    msg?.message?.deviceSentMessage?.destinationJid
  ].filter(Boolean);
  const isRich = Boolean(
    activeWaiters.has(sessionId) &&
      (msg?.message?.richResponseMessage ||
        msg?.message?.editedMessage?.message?.richResponseMessage ||
        msg?.message?.protocolMessage?.editedMessage?.richResponseMessage)
  );
  if (!isRich && !candidateJids.some(j => isSessionMetaAiJid(sessionId, j))) return false;
  for (const j of candidateJids) {
    if (j.endsWith('@lid') || isMetaAiJid(j) || isRich) rememberSessionMetaAiLid(sessionId, j, !msg?.key?.fromMe);
  }
  if (msg?.key?.fromMe) return true;
  const text = extractTextFromMessage(msg?.message);
  if (text) ingestCandidateText(sessionId, text, candidateJids[0]);
  return true;
}

export function handleMetaAiIncomingUpdate(sessionId, updates) {
  if (!Array.isArray(updates)) return 0;
  let count = 0;
  for (const item of updates) {
    const jids = [item?.key?.remoteJid, item?.key?.remoteJidAlt, item?.key?.participant].filter(Boolean);
    if (!jids.some(j => isSessionMetaAiJid(sessionId, j))) continue;
    count++;
    if (item?.key?.fromMe) continue;
    const candidateMsg = item?.update?.message || item?.update?.messageStubParameters?.[0] || item?.message || null;
    const text = typeof candidateMsg === 'string' ? candidateMsg.trim() : extractTextFromMessage(candidateMsg);
    if (text) ingestCandidateText(sessionId, text, jids[0]);
  }
  return count;
}

async function handleRawMetaAiNode(sessionId, sock, node) {
  const from = String(node?.attrs?.from || '');
  const participant = node?.attrs?.participant ? String(node.attrs.participant) : undefined;
  const msgId = String(node?.attrs?.id || '');
  const rawSender = participant || from;
  const normSender = safeNormalizeJid(rawSender);
  const metaNode = getBinaryNodeChild(node, 'meta');
  const botNode = getBinaryNodeChild(node, 'bot');
  const unavailableNode = getBinaryNodeChild(node, 'unavailable');
  const targetId = String(metaNode?.attrs?.target_id || metaNode?.attrs?.['target-id'] || '').trim();
  const targetSenderRaw = String(metaNode?.attrs?.target_sender_jid || metaNode?.attrs?.target_sender || '').trim();
  const editType = String(botNode?.attrs?.edit || node?.attrs?.edit || '').trim().toLowerCase();
  const editTargetId = String(botNode?.attrs?.edit_target_id || botNode?.attrs?.['edit-target-id'] || '').trim();
  const children = Array.isArray(node.content) ? node.content : [];
  const cryptoNodes = children.filter(c => c && (c.tag === 'enc' || c.tag === 'plaintext') && c.content instanceof Uint8Array);

  const ownIdRaw = String(sock?.authState?.creds?.me?.id || sock?.user?.id || '').trim();
  const ownLidRaw = String(sock?.authState?.creds?.me?.lid || sock?.user?.lid || '').trim();
  const origSenders = [safeNormalizeJid(targetSenderRaw), targetSenderRaw, safeNormalizeJid(ownLidRaw), safeNormalizeJid(ownIdRaw), ownLidRaw, ownIdRaw].filter(Boolean);
  const primaryDecryptId = (editType === 'inner' || editType === 'last') && editTargetId ? editTargetId : msgId;
  const modSenders = [normSender, rawSender].filter(Boolean);

  const secretCandidates = [];
  const latest = sessionLatestBotSecret.get(sessionId);
  if (targetId && pendingBotSecrets.get(\`\${sessionId}::\${targetId}\`)?.messageSecret) {
    secretCandidates.push(pendingBotSecrets.get(\`\${sessionId}::\${targetId}\`).messageSecret);
  }
  if (latest?.messageSecret && !secretCandidates.includes(latest.messageSecret)) {
    secretCandidates.push(latest.messageSecret);
  }
  const msgIdCandidates = [targetId, latest?.msgId, primaryDecryptId, msgId, editTargetId].filter(Boolean);

  let decryptedProtoMsg = null;
  for (const cNode of cryptoNodes) {
    const e2eType = cNode.tag === 'plaintext' ? 'plaintext' : String(cNode.attrs?.type || '');
    try {
      if (e2eType === 'msmsg') {
        const msMsg = proto.MessageSecretMessage.decode(cNode.content);
        if (msMsg?.encPayload?.length && msMsg?.encIv?.length) {
          for (const sec of secretCandidates) {
            const dec = decryptMsmsgCiphertext({
              messageSecret: sec,
              encPayload: msMsg.encPayload,
              encIv: msMsg.encIv,
              msgIds: msgIdCandidates,
              origSenders,
              modificationSenders: modSenders
            });
            if (dec) { decryptedProtoMsg = dec; break; }
          }
        }
      } else if (e2eType === 'plaintext') {
        decryptedProtoMsg = proto.Message.decode(cNode.content);
      } else if ((e2eType === 'msg' || e2eType === 'pkmsg') && sock?.signalRepository?.decryptMessage) {
        const plainBuf = await sock.signalRepository.decryptMessage({ jid: rawSender, type: e2eType, ciphertext: cNode.content });
        decryptedProtoMsg = proto.Message.decode(unpadRandomMax16(plainBuf));
      }
    } catch {}
    if (decryptedProtoMsg) break;
  }

  if (typeof sock?.sendNode === 'function') {
    try {
      await sock.sendNode(buildAckStanza(node, undefined, sock?.authState?.creds?.me?.id));
    } catch {}
  }

  if (decryptedProtoMsg) {
    handleMetaAiIncomingUpsert(sessionId, {
      key: { remoteJid: from, fromMe: false, id: msgId, participant },
      message: decryptedProtoMsg
    });
    return true;
  }
  if (unavailableNode) {
    const uType = String(unavailableNode.attrs?.type || 'unavailable');
    const w = activeWaiters.get(sessionId);
    if (w && !w.settled && uType === 'bot_unavailable_fanout') {
      w.lastAckError = 'Fitur Meta AI belum aktif pada akun WhatsApp ini karena belum pernah memulai percakapan dengan Meta AI di aplikasi WhatsApp.';
    }
  }
  return true;
}

export function attachMetaAiRawSocketHandlers(sock, sessionId) {
  const ws = sock?.ws;
  if (!ws || typeof ws.emit !== 'function') return () => {};
  const existing = wrappedSockets.get(ws);
  if (existing) {
    existing.sessionId = sessionId;
    existing.socket = sock;
    existing.active = true;
    return () => { existing.active = false; existing.socket = null; };
  }
  const state = { active: true, sessionId, socket: sock };
  wrappedSockets.set(ws, state);
  const origEmit = ws.emit.bind(ws);
  ws.emit = function (event, ...args) {
    if (state.active && state.socket) {
      if (event === 'CB:message' && args[0]) {
        const n = args[0];
        const from = n?.attrs?.from;
        const part = n?.attrs?.participant;
        const encNodes = getBinaryNodeChildren(n, 'enc');
        if (
          n?.tag === 'message' &&
          (isSessionMetaAiJid(state.sessionId, from) ||
            isSessionMetaAiJid(state.sessionId, part) ||
            (typeof from === 'string' && from.endsWith('@bot')) ||
            encNodes.some(e => e?.attrs?.type === 'msmsg'))
        ) {
          void handleRawMetaAiNode(state.sessionId, state.socket, n).catch(() => {});
          return true;
        }
      } else if ((event === 'CB:ack,class:message' || (event === 'CB:ack' && args[0]?.attrs?.class === 'message')) && args[0]) {
        const ackId = String(args[0]?.attrs?.id || '').trim();
        const ackErr = String(args[0]?.attrs?.error || '').trim();
        const w = activeWaiters.get(state.sessionId);
        if (ackId && ackErr && w && !w.settled && w.pendingAckMsgIds.has(ackId)) {
          w.lastAckError = ackErr === '463'
            ? 'Pengiriman ke Meta AI dibatasi oleh layanan WhatsApp. Pastikan akun sudah pernah chat dengan Meta AI terlebih dahulu.'
            : ackErr === '488'
              ? 'Fitur Meta AI belum didukung atau belum aktif pada sesi perangkat WhatsApp ini.'
              : 'Layanan Meta AI pada WhatsApp sedang mengalami kendala pengiriman.';
          if (w.fallbackAttemptFn) void w.fallbackAttemptFn();
        }
      }
    }
    return origEmit(event, ...args);
  };
  return () => { state.active = false; state.socket = null; };
}

async function fetchAccountBotList(sessionId, sock) {
  const cached = sessionBotEntries.get(sessionId);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;
  if (typeof sock?.getBotListV2 !== 'function') return [];
  try {
    const raw = await Promise.race([sock.getBotListV2(), new Promise(r => setTimeout(() => r([]), 5000))]);
    const list = Array.isArray(raw) ? raw : [];
    const entries = [];
    let pMap = sessionBotPersonas.get(sessionId);
    if (!pMap) { pMap = new Map(); sessionBotPersonas.set(sessionId, pMap); }
    for (const item of list) {
      const jid = String(item?.jid || '').trim();
      if (!jid) continue;
      const personaId = item?.personaId ? String(item.personaId).trim() : undefined;
      entries.push({ jid, personaId });
      if (personaId) pMap.set(jid, personaId);
    }
    sessionBotEntries.set(sessionId, { entries, expiresAt: Date.now() + 600000 });
    return entries;
  } catch {
    return [];
  }
}

async function ensureBotSignalSession(sessionId, sock, targetJid) {
  if (!targetJid.endsWith('@bot')) return true;
  if (botSignalReadyCache.get(\`\${sessionId}::\${targetJid}\`) > Date.now()) return true;
  const repo = sock?.signalRepository;
  try {
    if (repo?.validateSession) {
      const res = await repo.validateSession(targetJid);
      if (res?.exists) {
        botSignalReadyCache.set(\`\${sessionId}::\${targetJid}\`, Date.now() + 240000);
        return true;
      }
    }
    if (typeof sock?.query === 'function' && repo) {
      const iq = await Promise.race([
        sock.query({
          tag: 'iq',
          attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'encrypt' },
          content: [{ tag: 'key', attrs: {}, content: [{ tag: 'user', attrs: { jid: targetJid } }] }]
        }, 4500),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4500))
      ]);
      if (iq) {
        await parseAndInjectE2ESessions(iq, repo);
        if (repo.validateSession) {
          const check = await repo.validateSession(targetJid);
          if (check?.exists) {
            botSignalReadyCache.set(\`\${sessionId}::\${targetJid}\`, Date.now() + 240000);
            return true;
          }
        } else {
          botSignalReadyCache.set(\`\${sessionId}::\${targetJid}\`, Date.now() + 240000);
          return true;
        }
      }
    }
  } catch {}
  return false;
}

async function ensureWorkerPnDeviceAndSession(sock, targetJid) {
  if (targetJid.endsWith('@bot')) return true;
  const repo = sock?.signalRepository;
  let hasSession = false;
  try {
    if (repo?.validateSession) {
      hasSession = Boolean((await repo.validateSession(targetJid))?.exists);
    }
    if (!hasSession && typeof sock?.assertSessions === 'function') {
      await Promise.race([sock.assertSessions([targetJid]), new Promise(r => setTimeout(r, 3500))]).catch(() => {});
      if (repo?.validateSession) {
        hasSession = Boolean((await repo.validateSession(targetJid))?.exists);
      }
    }
    if (!hasSession && typeof sock?.query === 'function' && repo) {
      const iq = await Promise.race([
        sock.query({
          tag: 'iq',
          attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'encrypt' },
          content: [{ tag: 'key', attrs: {}, content: [{ tag: 'user', attrs: { jid: targetJid } }] }]
        }, 4500),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4500))
      ]);
      if (iq) {
        await parseAndInjectE2ESessions(iq, repo);
        hasSession = repo.validateSession ? Boolean((await repo.validateSession(targetJid))?.exists) : true;
      }
    }
  } catch {}
  return hasSession;
}

async function sendPromptSingleJid(sessionId, sock, targetJid, promptText, waiter, allowPlaintextFallback = false) {
  const isBotDomain = targetJid.endsWith('@bot');
  let botSignalOk = true;
  if (isBotDomain) {
    botSignalOk = await ensureBotSignalSession(sessionId, sock, targetJid);
    if (!botSignalOk && !allowPlaintextFallback) {
      throw new Error('Sesi enkripsi Meta AI pada perangkat ini belum tersedia dari server WhatsApp.');
    }
  } else {
    await ensureWorkerPnDeviceAndSession(sock, targetJid);
  }
  const userJid = sock?.authState?.creds?.me?.id || sock?.user?.id || '';
  const msgId = generateMessageIDV2(userJid);
  const messageSecret = crypto.randomBytes(32);
  storePendingBotSecret(sessionId, msgId, targetJid, messageSecret);
  if (waiter && !waiter.settled) waiter.pendingAckMsgIds.add(msgId);

  const personaId = sessionBotPersonas.get(sessionId)?.get(targetJid) ||
    (targetJid.startsWith('867051314767696') ? DEFAULT_META_AI_PERSONA_ID : undefined);

  if (typeof sock?.relayMessage === 'function' && userJid) {
    const fullMsg = await generateWAMessage(targetJid, { text: promptText }, { userJid, messageId: msgId });
    if (fullMsg.message) {
      fullMsg.message.messageContextInfo = {
        ...(fullMsg.message.messageContextInfo || {}),
        messageSecret,
        ...(isBotDomain && personaId ? { botMetadata: { personaId } } : {})
      };
    }
    if (isBotDomain && !botSignalOk && allowPlaintextFallback && typeof sock?.sendNode === 'function') {
      await Promise.race([
        sock.sendNode({
          tag: 'message',
          attrs: { id: msgId, to: targetJid, type: 'text' },
          content: [{ tag: 'plaintext', attrs: {}, content: encodeWAMessage(fullMsg.message) }]
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout mengirim prompt Meta AI')), 10000))
      ]);
      return targetJid;
    }
    await Promise.race([
      sock.relayMessage(targetJid, fullMsg.message, { messageId: msgId }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout mengirim prompt Meta AI')), 10000))
    ]);
    return targetJid;
  }

  const sent = await Promise.race([
    sock.sendMessage(targetJid, { text: promptText }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout mengirim prompt Meta AI')), 10000))
  ]);
  if (sent?.key?.id) {
    const realSec = sent?.message?.messageContextInfo?.messageSecret;
    if (realSec?.length) storePendingBotSecret(sessionId, sent.key.id, sent?.key?.remoteJid || targetJid, Buffer.from(realSec));
    waiter?.pendingAckMsgIds.add(sent.key.id);
  }
  return sent?.key?.remoteJid || targetJid;
}

export async function executeMetaAiPromptOnSocket(sock, sessionId, promptText) {
  const prev = sessionQueues.get(sessionId) || Promise.resolve();
  const runTask = prev.catch(() => {}).then(async () => {
    attachMetaAiRawSocketHandlers(sock, sessionId);
    const [bots, lidMapped] = await Promise.all([
      fetchAccountBotList(sessionId, sock),
      sock?.signalRepository?.lidMapping?.getLIDForPN
        ? Promise.race([
            sock.signalRepository.lidMapping.getLIDForPN('13135550002@s.whatsapp.net'),
            new Promise(r => setTimeout(() => r(null), 2000))
          ]).catch(() => null)
        : Promise.resolve(null)
    ]);
    if (typeof lidMapped === 'string' && lidMapped.endsWith('@lid')) {
      sessionMetaAiLids.set(sessionId, lidMapped);
    }
    const candidates = Array.from(new Set([
      sessionPreferredMetaJid.get(sessionId),
      ...bots.map(b => b.jid),
      sessionMetaAiLids.get(sessionId),
      DEFAULT_META_AI_BOT_JID,
      ...FALLBACK_META_AI_JIDS
    ].filter(isRoutableOutgoingMetaJid)));

    if (activeWaiters.has(sessionId)) {
      finalizeWaiter(sessionId, { ok: false, reason: 'Digantikan antrean baru.' });
    }

    return await new Promise(async (resolve) => {
      const hardTimer = setTimeout(() => {
        const cur = activeWaiters.get(sessionId);
        if (cur && !cur.settled && cur.latestText) {
          finalizeWaiter(sessionId, { ok: true, text: cur.latestText });
        } else {
          finalizeWaiter(sessionId, { ok: false, reason: cur?.lastAckError || 'Meta AI timeout (tidak merespons).' });
        }
      }, HARD_TIMEOUT_MS);

      const waiter = {
        sessionId,
        promptSent: promptText,
        latestText: '',
        hasSignal: false,
        settled: false,
        pendingAckMsgIds: new Set(),
        lastAckError: '',
        fallbackAttemptFn: null,
        resolve,
        hardTimer,
        settleTimer: null,
        retryTimer: null
      };
      activeWaiters.set(sessionId, waiter);

      let idx = 0;
      let triedPlaintext = false;
      const tryNext = async () => {
        if (waiter.settled || waiter.hasSignal || waiter.latestText) return false;
        while (idx < candidates.length) {
          const jid = candidates[idx++];
          try {
            await sendPromptSingleJid(sessionId, sock, jid, promptText, waiter, false);
            if (!waiter.settled && !waiter.hasSignal) {
              waiter.retryTimer = setTimeout(() => { void tryNext(); }, SILENT_FALLBACK_RETRY_MS);
            }
            return true;
          } catch {}
        }
        if (!triedPlaintext) {
          triedPlaintext = true;
          const botJid = candidates.find(j => j.endsWith('@bot')) || DEFAULT_META_AI_BOT_JID;
          try {
            await sendPromptSingleJid(sessionId, sock, botJid, promptText, waiter, true);
            return true;
          } catch {}
        }
        return false;
      };
      waiter.fallbackAttemptFn = tryNext;
      const ok = await tryNext();
      if (!ok && !waiter.settled) {
        finalizeWaiter(sessionId, { ok: false, reason: 'Sesi enkripsi Meta AI belum tersedia pada perangkat tertaut ini.' });
      }
    });
  });
  sessionQueues.set(sessionId, runTask);
  return await runTask;
}

export function clearMetaAiSessionCache(sessionId) {
  sessionMetaAiLids.delete(sessionId);
  sessionPreferredMetaJid.delete(sessionId);
  sessionBotEntries.delete(sessionId);
  if (activeWaiters.has(sessionId)) {
    finalizeWaiter(sessionId, { ok: false, reason: 'Sesi dihentikan.' });
  }
}
`;
}

function buildWorkerMjsSource(): string {
  return `import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocketImport, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import {
  attachMetaAiRawSocketHandlers,
  clearMetaAiSessionCache,
  executeMetaAiPromptOnSocket,
  handleMetaAiIncomingUpdate,
  handleMetaAiIncomingUpsert
} from './metaAiHelper.mjs';

const makeWASocket = makeWASocketImport?.default || makeWASocketImport;

let fileConfig = {};
try {
  const cfgPath = path.join(process.cwd(), 'worker.config.json');
  if (fs.existsSync(cfgPath)) {
    fileConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }
} catch {}

const MASTER_URL = String(process.env.MASTER_URL || fileConfig.masterUrl || '').trim().replace(/\\/+$/, '');
const NODE_ID = String(process.env.NODE_ID || fileConfig.nodeId || '').trim();
const NODE_SECRET = String(process.env.NODE_SECRET || '').trim();
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS || fileConfig.maxSessions || 10));
const PROVIDER = String(process.env.WORKER_PROVIDER || fileConfig.provider || 'northflank').trim();
const PORT = Number(process.env.PORT || 3000) || 3000;
const AUTH_BASE_DIR = path.resolve(process.env.BAILEYS_AUTH_DIR || path.join(os.tmpdir(), 'japriin_worker_auth'));
const BAILEYS_BROWSER = ['Windows', 'Chrome', '128.0.0'];
const SILENT_LOGGER = pino({ level: 'silent' });

if (!fs.existsSync(AUTH_BASE_DIR)) {
  fs.mkdirSync(AUTH_BASE_DIR, { recursive: true, mode: 0o700 });
}

if (!MASTER_URL || !NODE_ID || !NODE_SECRET) {
  console.error('[Japriin Worker] ERROR: MASTER_URL, NODE_ID, dan NODE_SECRET wajib dikonfigurasi pada Environment Variables!');
  process.exit(1);
}

let discoveredPublicUrl = String(
  process.env.WORKER_PUBLIC_URL ||
    process.env.NF_PUBLIC_URL ||
    process.env.NORTHFLANK_PUBLIC_URL ||
    process.env.PUBLIC_URL ||
    ''
)
  .trim()
  .replace(/\\/+$/, '');

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str || '', 'utf8').digest('hex');
}

function signPayload(method, urlPath, bodyStr) {
  const ts = String(Date.now());
  const msg = \`\${ts}.\${method.toUpperCase()}.\${urlPath}.\${sha256Hex(bodyStr)}\`;
  const sig = crypto.createHmac('sha256', NODE_SECRET).update(msg).digest('hex');
  return { ts, sig };
}

function verifyMasterSignature(req) {
  const ts = String(req.headers['x-master-timestamp'] || '').trim();
  const sig = String(req.headers['x-master-signature'] || '').trim();
  if (!ts || !sig) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 120000) return false;
  const rawBody = typeof req.rawBodyStr === 'string' ? req.rawBodyStr : '';
  const expectedMsg = \`\${ts}.\${req.method.toUpperCase()}.\${req.originalUrl.split('?')[0]}.\${sha256Hex(rawBody)}\`;
  const expectedSig = crypto.createHmac('sha256', NODE_SECRET).update(expectedMsg).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function callMaster(method, apiPath, bodyObj) {
  const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : '';
  const { ts, sig } = signPayload(method, apiPath, bodyStr);
  const res = await fetch(\`\${MASTER_URL}\${apiPath}\`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-worker-id': NODE_ID,
      'x-worker-timestamp': ts,
      'x-worker-signature': sig
    },
    ...(bodyObj !== undefined ? { body: bodyStr } : {}),
    signal: AbortSignal.timeout(25000)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    throw new Error(json?.error || \`Master HTTP \${res.status}\`);
  }
  return json || { success: true };
}

// ======================================================
// LOCAL BAILEYS SESSION ENGINE ON WORKER
// ======================================================
const activeSessions = new Map();
const startLocks = new Map();
const authBackupTimers = new Map();
const reconnectTimers = new Map();
const ephemeralIdleTimers = new Map();
const ephemeralSessions = new Set();
const processedMsgIds = new Map();
const recentOutgoing = new Map();

let cachedWaVersion = null;
let cachedWaVersionAt = 0;
async function resolveWaVersion() {
  if (cachedWaVersion && Date.now() - cachedWaVersionAt < 12 * 3600 * 1000) return cachedWaVersion;
  try {
    const { version } = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))
    ]);
    cachedWaVersion = version;
    cachedWaVersionAt = Date.now();
    return version;
  } catch {
    return [2, 3000, 1027934701];
  }
}

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\\D/g, '');
  if (!d) return '';
  if (d.startsWith('620')) d = '62' + d.slice(3);
  else if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8') && d.length >= 8) d = '62' + d;
  return d;
}

function sanitizeSid(raw) {
  return String(raw || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function sessionHasCredsOnDisk(sessionId) {
  const sid = sanitizeSid(sessionId);
  if (!sid) return false;
  try {
    const credsPath = path.join(AUTH_BASE_DIR, sid, 'creds.json');
    if (!fs.existsSync(credsPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    return Boolean(parsed && (parsed.registered || parsed?.me?.id));
  } catch {
    return false;
  }
}

async function notifyMasterSessionEvent(payload, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      await callMaster('POST', '/api/worker-bridge/session-event', payload);
      return true;
    } catch {
      if (i < retries) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  return false;
}

function isSocketOpen(sock) {
  if (!sock) return false;
  if (sock.ws) {
    if (typeof sock.ws.isOpen === 'boolean') return sock.ws.isOpen;
    const innerRs = sock.ws.socket?.readyState;
    if (typeof innerRs === 'number') return innerRs === 1;
    const rs = sock.ws.readyState;
    if (typeof rs === 'number') return rs === 1;
  }
  return Boolean(sock?.user?.id || sock?.authState?.creds?.registered);
}

function collectAuthFiles(sessionId) {
  const dir = path.join(AUTH_BASE_DIR, sessionId);
  if (!fs.existsSync(dir)) return null;
  const files = {};
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const fp = path.join(dir, name);
    try {
      if (fs.statSync(fp).size > 512 * 1024) continue;
      files[name] = fs.readFileSync(fp, 'utf8');
    } catch {}
  }
  return files['creds.json'] ? files : null;
}

function scheduleAuthBackup(sessionId, immediate = false) {
  if (authBackupTimers.has(sessionId)) clearTimeout(authBackupTimers.get(sessionId));
  const run = async () => {
    authBackupTimers.delete(sessionId);
    const files = collectAuthFiles(sessionId);
    if (!files) return;
    try {
      await callMaster('POST', '/api/worker-bridge/auth-backup', { sessionId, authFiles: files });
    } catch (e) {
      console.warn(\`[Worker AuthBackup] \${sessionId}: \${e?.message}\`);
    }
  };
  if (immediate) void run();
  else {
    const t = setTimeout(run, 3500);
    t.unref?.();
    authBackupTimers.set(sessionId, t);
  }
}

function clearTimers(sessionId) {
  if (authBackupTimers.has(sessionId)) { clearTimeout(authBackupTimers.get(sessionId)); authBackupTimers.delete(sessionId); }
  if (reconnectTimers.has(sessionId)) { clearTimeout(reconnectTimers.get(sessionId)); reconnectTimers.delete(sessionId); }
  if (ephemeralIdleTimers.has(sessionId)) { clearTimeout(ephemeralIdleTimers.get(sessionId)); ephemeralIdleTimers.delete(sessionId); }
}

function scheduleEphemeralStop(sessionId, delayMs = 25000) {
  const sid = sanitizeSid(sessionId);
  if (!sid) return;
  ephemeralSessions.add(sid);
  if (ephemeralIdleTimers.has(sid)) {
    clearTimeout(ephemeralIdleTimers.get(sid));
  }
  const t = setTimeout(() => {
    ephemeralIdleTimers.delete(sid);
    ephemeralSessions.delete(sid);
    void stopSession(sid, true).catch(() => {});
  }, delayMs);
  t.unref?.();
  ephemeralIdleTimers.set(sid, t);
}

async function stopSession(sessionId, purgeLocal = false) {
  clearTimers(sessionId);
  ephemeralSessions.delete(sessionId);
  clearMetaAiSessionCache(sessionId);
  const existing = activeSessions.get(sessionId);
  if (existing) {
    try {
      existing.detachRaw?.();
      existing.socket?.ev?.removeAllListeners?.('connection.update');
      existing.socket?.ev?.removeAllListeners?.('creds.update');
      existing.socket?.ev?.removeAllListeners?.('messages.upsert');
      existing.socket?.ev?.removeAllListeners?.('messages.update');
      existing.socket?.ws?.removeAllListeners?.();
      existing.socket?.ws?.close?.();
      existing.socket?.end?.(undefined);
    } catch {}
    activeSessions.delete(sessionId);
  }
  if (purgeLocal) {
    try { fs.rmSync(path.join(AUTH_BASE_DIR, sessionId), { recursive: true, force: true }); } catch {}
  }
}

function buildSocketConfig(version, authState) {
  return {
    version,
    logger: SILENT_LOGGER,
    printQRInTerminal: false,
    auth: authState,
    browser: BAILEYS_BROWSER,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
    linkPreviewImageThumbnailWidth: 0,
    markOnlineOnConnect: false,
    shouldIgnoreJid: (jid) => !jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter'),
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 2
  };
}

function rememberOutgoing(text) {
  if (!text) return;
  recentOutgoing.set(text.trim(), Date.now());
  if (recentOutgoing.size > 200) {
    const now = Date.now();
    for (const [k, v] of recentOutgoing.entries()) {
      if (now - v > 45000) recentOutgoing.delete(k);
    }
  }
}

function attachMessageHandlers(sock, sessionId, stateObj) {
  stateObj.detachRaw = attachMetaAiRawSocketHandlers(sock, sessionId);

  sock.ev.on('messages.update', (updates) => {
    try { handleMetaAiIncomingUpdate(sessionId, updates); } catch {}
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (m.type !== 'notify' && m.type !== 'append') return;
      for (const msg of m.messages) {
        if (!msg.message) continue;
        const remoteJid = msg.key?.remoteJid || msg.message?.deviceSentMessage?.destinationJid;
        if (!remoteJid) continue;
        if (handleMetaAiIncomingUpsert(sessionId, msg)) continue;
        if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) continue;

        const msgId = msg.key?.id;
        if (msgId && processedMsgIds.has(msgId)) continue;
        if (m.type === 'append') {
          const rawTs = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp?.low || 0);
          if (rawTs > 0 && Math.floor(Date.now() / 1000) - rawTs > 45) continue;
        }

        const innerMsg =
          msg.message?.deviceSentMessage?.message ||
          msg.message?.ephemeralMessage?.message ||
          msg.message?.viewOnceMessage?.message ||
          msg.message?.viewOnceMessageV2?.message ||
          msg.message?.documentWithCaptionMessage?.message ||
          msg.message;
        const hasMediaAttachment = Boolean(innerMsg?.imageMessage || innerMsg?.documentMessage || msg.message?.imageMessage || msg.message?.documentMessage);
        const rawText = (
          innerMsg?.conversation ||
          innerMsg?.extendedTextMessage?.text ||
          innerMsg?.imageMessage?.caption ||
          innerMsg?.videoMessage?.caption ||
          innerMsg?.documentMessage?.caption ||
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          ''
        ).trim();

        if (!rawText && (!hasMediaAttachment || msg.key.fromMe)) continue;
        const messageText = rawText || '[Pelanggan mengirim lampiran gambar/dokumen bukti pembayaran]';
        if (rawText && recentOutgoing.has(rawText) && Date.now() - recentOutgoing.get(rawText) < 45000) continue;

        if (msg.key.fromMe && !messageText.startsWith('/')) continue;
        if (ephemeralSessions.has(sessionId) && !msg.key.fromMe) continue;
        if (msgId) {
          processedMsgIds.set(msgId, Date.now());
          if (processedMsgIds.size > 400) {
            const oldest = processedMsgIds.keys().next().value;
            if (oldest) processedMsgIds.delete(oldest);
          }
        }

        const senderPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0];
        const senderName = msg.pushName || 'Pengguna WhatsApp';

        const decision = await callMaster('POST', '/api/worker-bridge/incoming-message', {
          sessionId,
          userId: stateObj.userId,
          connectedPhone: stateObj.phoneNumber,
          senderPhone,
          senderName,
          remoteJid,
          messageText,
          rawMessageText: rawText,
          hasMediaAttachment,
          fromMe: Boolean(msg.key.fromMe),
          msgId
        });

        let finalDecision = decision;
        if (decision?.action === 'ask_meta_ai' && decision?.metaPrompt) {
          const aiRes = await executeMetaAiPromptOnSocket(sock, sessionId, decision.metaPrompt);
          finalDecision = await callMaster('POST', '/api/worker-bridge/finalize-ai-reply', {
            sessionId,
            userId: decision.userId || stateObj.userId,
            senderPhone,
            senderName,
            rawMessageText: rawText,
            hasMediaAttachment,
            aiOk: Boolean(aiRes?.ok && aiRes?.text),
            aiRawText: aiRes?.text || '',
            aiErrorReason: aiRes?.reason || '',
            orderContextPayload: decision.orderContextPayload || null
          });
        }

        const replyText = String(finalDecision?.replyText || '').trim();
        if (!replyText) continue;

        const antiBan = finalDecision?.antiBan || { enabled: true, min_delay_seconds: 1, max_delay_seconds: 4, typing_simulation: true, read_receipt_simulation: true };
        if (!msg.key.fromMe && antiBan.read_receipt_simulation) {
          await new Promise(r => setTimeout(r, 120 + crypto.randomInt(0, 200)));
          await sock.readMessages([msg.key]).catch(() => {});
        }
        if (antiBan.enabled) {
          const minS = Math.max(1, Number(antiBan.min_delay_seconds) || 1);
          const maxS = Math.max(minS, Number(antiBan.max_delay_seconds) || 4);
          const delayMs = Math.min(maxS * 1000, Math.round(minS * 1000 + Math.random() * ((maxS - minS) * 1000)));
          if (antiBan.typing_simulation) await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
          await new Promise(r => setTimeout(r, delayMs));
          if (antiBan.typing_simulation) await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }

        rememberOutgoing(replyText);
        let sentOk = false;
        let sentMsgId = \`worker_out_\${Date.now()}\`;
        let sendErr = '';
        try {
          if (finalDecision?.sendQrisImage && (finalDecision?.qrisImageBase64 || finalDecision?.qrisPublicUrl)) {
            const imgSrc = finalDecision.qrisImageBase64
              ? Buffer.from(finalDecision.qrisImageBase64, 'base64')
              : { url: finalDecision.qrisPublicUrl };
            const sent = await sock.sendMessage(remoteJid, { image: imgSrc, caption: replyText });
            sentMsgId = sent?.key?.id || sentMsgId;
            sentOk = true;
          } else {
            const sent = await sock.sendMessage(remoteJid, { text: replyText });
            sentMsgId = sent?.key?.id || sentMsgId;
            sentOk = true;
          }
        } catch (err) {
          sendErr = err?.message || 'Gagal kirim balasan';
        }

        await callMaster('POST', '/api/worker-bridge/log-result', {
          sessionId,
          userId: finalDecision?.userId || stateObj.userId,
          senderPhone,
          senderName,
          messageText,
          replyText,
          wamId: sentMsgId,
          success: sentOk,
          errorDetail: sendErr,
          isAi: Boolean(finalDecision?.isAi),
          matchedRuleId: finalDecision?.matchedRuleId || undefined
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('[Worker Message Upsert Error]', err?.message || err);
    }
  });
}

async function startOrRestoreSession(rawSessionId, phoneNumber, userId, authFilesOverride) {
  const sessionId = sanitizeSid(rawSessionId);
  if (!sessionId) throw new Error('ID sesi tidak valid.');

  const existing = activeSessions.get(sessionId);
  if (existing && existing.status === 'connected' && isSocketOpen(existing.socket)) {
    if (userId) existing.userId = userId;
    return existing;
  }
  if (existing && existing.status === 'connecting' && existing.socket && Date.now() - existing.lastUpdated < 30000) {
    return existing;
  }
  if (startLocks.has(sessionId)) return await startLocks.get(sessionId);

  const task = (async () => {
    try {
      await stopSession(sessionId, false);
      const dir = path.join(AUTH_BASE_DIR, sessionId);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (authFilesOverride && typeof authFilesOverride === 'object') {
        for (const [fn, content] of Object.entries(authFilesOverride)) {
          if (fn.endsWith('.json') && typeof content === 'string') {
            fs.writeFileSync(path.join(dir, path.basename(fn)), content, 'utf8');
          }
        }
      }

      const { state, saveCreds } = await useMultiFileAuthState(dir);
      const version = await resolveWaVersion();
      const sock = makeWASocket(buildSocketConfig(version, state));

      const stateObj = {
        sessionId,
        userId: userId || '',
        socket: sock,
        status: 'connecting',
        qrCodeUrl: null,
        pairingCode: null,
        phoneNumber: phoneNumber ? normalizePhone(phoneNumber) : null,
        lastUpdated: Date.now(),
        retryCount: 0,
        detachRaw: null
      };
      activeSessions.set(sessionId, stateObj);

      let saveQueue = Promise.resolve();
      sock.ev.on('creds.update', () => {
        saveQueue = saveQueue.then(async () => {
          try {
            await saveCreds();
            scheduleAuthBackup(sessionId, false);
          } catch {}
        });
      });

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          try {
            stateObj.qrCodeUrl = await QRCode.toDataURL(qr, { margin: 2, width: 300 });
            stateObj.lastUpdated = Date.now();
          } catch {}
        }
        if (connection === 'open') {
          const rawPhone = sock.user?.id ? sock.user.id.split('@')[0].split(':')[0] : '';
          const connectedPhone = normalizePhone(rawPhone || phoneNumber || stateObj.phoneNumber || '');
          stateObj.status = 'connected';
          stateObj.phoneNumber = connectedPhone;
          stateObj.qrCodeUrl = null;
          stateObj.pairingCode = null;
          stateObj.retryCount = 0;
          stateObj.lastUpdated = Date.now();
          scheduleAuthBackup(sessionId, true);
          await notifyMasterSessionEvent({
            event: 'open',
            sessionId,
            userId: stateObj.userId,
            phoneNumber: connectedPhone
          }, 3);
        } else if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          const isFatal =
            code === DisconnectReason.loggedOut ||
            code === 401 ||
            code === 403 ||
            code === DisconnectReason.badSession;
          const hasCreds = sessionHasCredsOnDisk(sessionId) || fs.existsSync(path.join(AUTH_BASE_DIR, sessionId, 'creds.json'));
          const latest = activeSessions.get(sessionId);
          if (latest && latest.socket && latest.socket !== sock) {
            return;
          }
          if (isFatal) {
            await stopSession(sessionId, true);
            await notifyMasterSessionEvent({
              event: 'fatal_close',
              sessionId,
              userId: stateObj.userId,
              phoneNumber: stateObj.phoneNumber,
              statusCode: code
            }, 2);
            return;
          }
          if (!hasCreds && code !== DisconnectReason.restartRequired) {
            await stopSession(sessionId, false);
            return;
          }
          stateObj.retryCount = (stateObj.retryCount || 0) + 1;
          if (stateObj.retryCount <= 5) {
            try {
              stateObj.detachRaw?.();
              sock.ev?.removeAllListeners?.('connection.update');
              sock.ev?.removeAllListeners?.('creds.update');
              sock.ev?.removeAllListeners?.('messages.upsert');
              sock.ev?.removeAllListeners?.('messages.update');
              sock.end?.(undefined);
            } catch {}
            clearMetaAiSessionCache(sessionId);
            stateObj.socket = null;
            stateObj.qrCodeUrl = null;
            stateObj.pairingCode = null;
            stateObj.status = 'connecting';
            stateObj.lastUpdated = Date.now();
            activeSessions.set(sessionId, stateObj);

            const waitMs = Math.min(25000, 2000 * Math.pow(2, stateObj.retryCount - 1));
            if (reconnectTimers.has(sessionId)) clearTimeout(reconnectTimers.get(sessionId));
            const t = setTimeout(() => {
              reconnectTimers.delete(sessionId);
              void startOrRestoreSession(sessionId, stateObj.phoneNumber, stateObj.userId).catch(() => {});
            }, waitMs);
            t.unref?.();
            reconnectTimers.set(sessionId, t);
          } else {
            await stopSession(sessionId, false);
            await notifyMasterSessionEvent({
              event: 'disconnected',
              sessionId,
              userId: stateObj.userId,
              phoneNumber: stateObj.phoneNumber,
              statusCode: code
            }, 2);
          }
        }
      });

      attachMessageHandlers(sock, sessionId, stateObj);
      return stateObj;
    } finally {
      startLocks.delete(sessionId);
    }
  })();

  startLocks.set(sessionId, task);
  return await task;
}

async function requestPairing(rawSessionId, phoneNumber, userId) {
  const sessionId = sanitizeSid(rawSessionId);
  const cleanPhone = normalizePhone(phoneNumber);
  if (!cleanPhone || cleanPhone.length < 9) throw new Error('Format nomor WhatsApp tidak valid.');
  await stopSession(sessionId, true);
  const dir = path.join(AUTH_BASE_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const version = await resolveWaVersion();
  const sock = makeWASocket(buildSocketConfig(version, state));

  const stateObj = {
    sessionId,
    userId: userId || '',
    socket: sock,
    status: 'connecting',
    qrCodeUrl: null,
    pairingCode: null,
    phoneNumber: cleanPhone,
    lastUpdated: Date.now(),
    retryCount: 0,
    detachRaw: null
  };
  activeSessions.set(sessionId, stateObj);

  sock.ev.on('creds.update', async () => {
    try { await saveCreds(); scheduleAuthBackup(sessionId, false); } catch {}
  });
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      const rawPhone = sock.user?.id ? sock.user.id.split('@')[0].split(':')[0] : '';
      const connectedPhone = normalizePhone(rawPhone || cleanPhone);
      stateObj.status = 'connected';
      stateObj.phoneNumber = connectedPhone;
      stateObj.pairingCode = null;
      stateObj.lastUpdated = Date.now();
      scheduleAuthBackup(sessionId, true);
      await notifyMasterSessionEvent({
        event: 'open',
        sessionId,
        userId: stateObj.userId,
        phoneNumber: connectedPhone
      }, 3);
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const isFatal = code === DisconnectReason.loggedOut || code === 401 || code === 403;
      const hasCreds = sessionHasCredsOnDisk(sessionId) || fs.existsSync(path.join(AUTH_BASE_DIR, sessionId, 'creds.json'));
      const latest = activeSessions.get(sessionId);
      if (latest && latest.socket && latest.socket !== sock) {
        return;
      }
      if (isFatal) {
        await stopSession(sessionId, true);
        await notifyMasterSessionEvent({
          event: 'fatal_close',
          sessionId,
          userId: stateObj.userId,
          phoneNumber: stateObj.phoneNumber,
          statusCode: code
        }, 2);
      } else if (hasCreds && code === DisconnectReason.restartRequired) {
        try {
          stateObj.detachRaw?.();
          sock.ev?.removeAllListeners?.('connection.update');
          sock.ev?.removeAllListeners?.('creds.update');
          sock.ev?.removeAllListeners?.('messages.upsert');
          sock.ev?.removeAllListeners?.('messages.update');
          sock.end?.(undefined);
        } catch {}
        stateObj.socket = null;
        stateObj.pairingCode = null;
        stateObj.status = 'connecting';
        stateObj.lastUpdated = Date.now();
        activeSessions.set(sessionId, stateObj);
        void startOrRestoreSession(sessionId, cleanPhone, userId).catch(() => {});
      } else {
        await stopSession(sessionId, false);
      }
    }
  });
  attachMessageHandlers(sock, sessionId, stateObj);

  await new Promise(r => setTimeout(r, 1500));
  const code = await Promise.race([
    sock.requestPairingCode(cleanPhone),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout meminta pairing code dari WhatsApp')), 15000))
  ]);
  const formatted = String(code || '').match(/.{1,4}/g)?.join('-') || String(code || '');
  stateObj.pairingCode = formatted;
  return formatted;
}

async function executeWorkerCommand(cmdType, payload) {
  switch (cmdType) {
    case 'ping_verify': {
      const tel = collectTelemetry();
      return {
        ok: true,
        nodeId: NODE_ID,
        provider: PROVIDER,
        activeSessions: tel.activeSessions,
        maxSessions: MAX_SESSIONS,
        ramUsedMb: tel.ramUsedMb,
        cpuPercent: tel.cpuPercent,
        uptimeSeconds: tel.uptimeSeconds,
        sessionIds: tel.sessionIds,
        sessions: tel.sessions
      };
    }

    case 'list_sessions': {
      const tel = collectTelemetry();
      return {
        sessions: tel.sessions,
        sessionIds: tel.sessionIds
      };
    }

    case 'start_session': {
      ephemeralSessions.delete(sanitizeSid(payload.sessionId));
      const st = await startOrRestoreSession(payload.sessionId, payload.phoneNumber, payload.userId, payload.authFiles);
      let tries = 0;
      while (tries < 8 && st.status !== 'connected' && !st.qrCodeUrl) {
        await new Promise(r => setTimeout(r, 500));
        tries++;
      }
      return {
        sessionId: st.sessionId,
        status: st.status,
        qrCodeUrl: st.qrCodeUrl,
        phoneNumber: st.phoneNumber
      };
    }

    case 'request_pairing': {
      ephemeralSessions.delete(sanitizeSid(payload.sessionId));
      const code = await requestPairing(payload.sessionId, payload.phoneNumber, payload.userId);
      return {
        sessionId: payload.sessionId,
        pairingCode: code,
        status: 'connecting'
      };
    }

    case 'get_status': {
      const sid = sanitizeSid(payload.sessionId);
      const st = activeSessions.get(sid);
      const hasCreds = sessionHasCredsOnDisk(sid);
      if (!st) {
        return { sessionId: payload.sessionId, status: 'disconnected', hasCreds, qrCodeUrl: null, pairingCode: null, phoneNumber: null };
      }
      const effectiveStatus = isSocketOpen(st.socket) ? 'connected' : st.status;
      return {
        sessionId: st.sessionId,
        status: effectiveStatus,
        hasCreds: Boolean(hasCreds || effectiveStatus === 'connected'),
        qrCodeUrl: st.qrCodeUrl,
        pairingCode: st.pairingCode,
        phoneNumber: st.phoneNumber
      };
    }

    case 'reconnect_session': {
      ephemeralSessions.delete(sanitizeSid(payload.sessionId));
      const st = await startOrRestoreSession(payload.sessionId, payload.phoneNumber, payload.userId, payload.authFiles);
      let tries = 0;
      while (tries < 10 && st.status !== 'connected') {
        await new Promise(r => setTimeout(r, 500));
        tries++;
      }
      return {
        sessionId: st.sessionId,
        connected: st.status === 'connected' && isSocketOpen(st.socket),
        status: st.status,
        phoneNumber: st.phoneNumber
      };
    }

    case 'stop_session': {
      await stopSession(sanitizeSid(payload.sessionId), Boolean(payload.purge));
      return { stopped: true };
    }

    case 'send_text': {
      const sid = sanitizeSid(payload.sessionId);
      let st = activeSessions.get(sid);
      if ((!st || !st.socket || !isSocketOpen(st.socket)) && payload.authFiles && payload.authFiles['creds.json']) {
        if (payload.sendOnlyEphemeral) ephemeralSessions.add(sid);
        st = await startOrRestoreSession(sid, payload.phoneNumber, payload.userId, payload.authFiles);
        let tries = 0;
        while (tries < 24 && (st.status !== 'connected' || !isSocketOpen(st.socket))) {
          await new Promise(r => setTimeout(r, 500));
          tries++;
        }
      }
      if (!st || !st.socket || !isSocketOpen(st.socket)) {
        throw new Error('Perangkat WhatsApp sedang tidak terhubung.');
      }
      const clean = normalizePhone(payload.recipientPhone);
      const jid = \`\${clean}@s.whatsapp.net\`;
      rememberOutgoing(payload.text);
      await st.socket.sendPresenceUpdate('composing', jid).catch(() => {});
      await new Promise(r => setTimeout(r, 200));
      const sent = await st.socket.sendMessage(jid, { text: String(payload.text || '') });
      if (payload.sendOnlyEphemeral) scheduleEphemeralStop(sid, 25000);
      return { success: true, wam_id: sent?.key?.id || \`wk_\${Date.now()}\` };
    }

    case 'send_media': {
      const sid = sanitizeSid(payload.sessionId);
      let st = activeSessions.get(sid);
      if ((!st || !st.socket || !isSocketOpen(st.socket)) && payload.authFiles && payload.authFiles['creds.json']) {
        if (payload.sendOnlyEphemeral) ephemeralSessions.add(sid);
        st = await startOrRestoreSession(sid, payload.phoneNumber, payload.userId, payload.authFiles);
        let tries = 0;
        while (tries < 24 && (st.status !== 'connected' || !isSocketOpen(st.socket))) {
          await new Promise(r => setTimeout(r, 500));
          tries++;
        }
      }
      if (!st || !st.socket || !isSocketOpen(st.socket)) {
        throw new Error('Perangkat WhatsApp sedang tidak terhubung.');
      }
      const clean = normalizePhone(payload.recipientPhone);
      const jid = \`\${clean}@s.whatsapp.net\`;
      const mediaData = payload.mediaBase64 ? Buffer.from(payload.mediaBase64, 'base64') : { url: payload.mediaUrl };
      let content = {};
      if (payload.mediaType === 'image') content = { image: mediaData, ...(payload.caption ? { caption: payload.caption } : {}) };
      else if (payload.mediaType === 'video') content = { video: mediaData, ...(payload.caption ? { caption: payload.caption } : {}) };
      else if (payload.mediaType === 'audio') content = { audio: mediaData, mimetype: payload.mimetype || 'audio/mpeg', ptt: false };
      else content = { document: mediaData, mimetype: payload.mimetype || 'application/pdf', fileName: payload.fileName || 'document.pdf', ...(payload.caption ? { caption: payload.caption } : {}) };
      if (payload.caption) rememberOutgoing(payload.caption);
      const sent = await st.socket.sendMessage(jid, content);
      if (payload.sendOnlyEphemeral) scheduleEphemeralStop(sid, 25000);
      return { success: true, wam_id: sent?.key?.id || \`wk_med_\${Date.now()}\` };
    }

    case 'ask_meta_ai': {
      const st = activeSessions.get(sanitizeSid(payload.sessionId));
      if (!st || !st.socket || !isSocketOpen(st.socket)) {
        return { ok: false, reason: 'Perangkat WhatsApp belum terhubung.' };
      }
      const res = await executeMetaAiPromptOnSocket(st.socket, st.sessionId, String(payload.promptText || ''));
      return { ...res, phoneNumber: st.phoneNumber };
    }

    default:
      throw new Error(\`Perintah worker tidak dikenal: \${cmdType}\`);
  }
}

// ======================================================
// EXPRESS INTERNAL SERVER & HEALTH CHECKS
// ======================================================
const app = express();
app.disable('x-powered-by');
app.use(express.json({
  limit: '16mb',
  verify: (req, _res, buf) => { req.rawBodyStr = buf.toString('utf8'); }
}));

app.use((req, _res, next) => {
  if (!discoveredPublicUrl) {
    const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (rawHost && !/^(localhost|127\\.|0\\.0\\.0\\.0)/.test(rawHost) && /^[a-zA-Z0-9.-]+(:\\d{1,5})?$/.test(rawHost)) {
      const proto = String(req.headers['x-forwarded-proto'] || '').includes('https') || req.secure ? 'https' : 'http';
      discoveredPublicUrl = \`\${proto}://\${rawHost}\`;
    }
  }
  next();
});

app.get(['/', '/health'], (_req, res) => {
  res.json({
    ok: true,
    service: 'japriin-wa-worker',
    nodeId: NODE_ID,
    provider: PROVIDER,
    activeSessions: activeSessions.size,
    maxSessions: MAX_SESSIONS,
    ramUsedMb: Math.round(process.memoryUsage().rss / (1024 * 1024))
  });
});

app.post('/internal/verify', (req, res) => {
  if (!verifyMasterSignature(req)) return res.status(401).json({ ok: false, error: 'Unauthorized signature' });
  const challenge = String(req.body?.challenge || '');
  const proof = crypto.createHmac('sha256', NODE_SECRET).update(challenge).digest('hex');
  res.json({ ok: true, nodeId: NODE_ID, proof });
});

app.post('/internal/command', async (req, res) => {
  if (!verifyMasterSignature(req)) return res.status(401).json({ ok: false, error: 'Unauthorized signature' });
  try {
    const data = await executeWorkerCommand(req.body?.type, req.body?.payload || {});
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, error: err?.message || 'Worker command failed' });
  }
});

// ======================================================
// STARTUP REGISTRATION, HEARTBEAT, RESTORE & RELAY POLL
// ======================================================
let lastCpuUsage = process.cpuUsage();
let lastCpuAt = Date.now();
function sampleCpuPercent() {
  const now = Date.now();
  const elapsedMs = Math.max(1, now - lastCpuAt);
  const delta = process.cpuUsage(lastCpuUsage);
  lastCpuUsage = process.cpuUsage();
  lastCpuAt = now;
  const totalCpuMs = (delta.user + delta.system) / 1000;
  const cores = Math.max(1, os.cpus()?.length || 1);
  return Math.min(100, Math.max(0, Math.round((totalCpuMs / (elapsedMs * cores)) * 1000) / 10));
}

function collectTelemetry() {
  const sessionList = [];
  for (const s of activeSessions.values()) {
    const liveStatus = isSocketOpen(s.socket) ? 'connected' : s.status;
    sessionList.push({
      sessionId: s.sessionId,
      userId: s.userId,
      status: liveStatus,
      hasCreds: Boolean(liveStatus === 'connected' || sessionHasCredsOnDisk(s.sessionId)),
      phoneNumber: s.phoneNumber,
      qrCodeUrl: s.qrCodeUrl,
      pairingCode: s.pairingCode
    });
  }
  return {
    baseUrl: discoveredPublicUrl,
    provider: PROVIDER,
    maxSessions: MAX_SESSIONS,
    activeSessions: sessionList.filter(s => s.status === 'connected').length,
    totalTracked: sessionList.length,
    sessionIds: sessionList.map(s => s.sessionId),
    sessions: sessionList,
    ramUsedMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    ramTotalMb: Math.round(os.totalmem() / (1024 * 1024)),
    cpuPercent: sampleCpuPercent(),
    uptimeSeconds: Math.round(process.uptime()),
    platform: \`\${os.platform()}/\${os.arch()}\`,
    version: '1.0.0'
  };
}

let isBurstPollingUntil = 0;
let pollInFlight = false;
async function pollRelayCommandsOnce() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const res = await callMaster('GET', '/api/worker-bridge/poll');
    const commands = Array.isArray(res?.commands) ? res.commands : [];
    if (commands.length > 0) {
      isBurstPollingUntil = Date.now() + 20000;
      for (const cmd of commands) {
        try {
          const resultData = await executeWorkerCommand(cmd.type, cmd.payload || {});
          await callMaster('POST', '/api/worker-bridge/command-result', {
            commandId: cmd.id,
            success: true,
            data: resultData
          });
        } catch (err) {
          await callMaster('POST', '/api/worker-bridge/command-result', {
            commandId: cmd.id,
            success: false,
            error: err?.message || 'Command failed'
          }).catch(() => {});
        }
      }
    }
  } catch {}
  finally { pollInFlight = false; }
}

async function bootstrapWorker() {
  console.log(\`[Japriin Worker] Node=\${NODE_ID} Provider=\${PROVIDER} Master=\${MASTER_URL}\`);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await callMaster('POST', '/api/worker-bridge/register', collectTelemetry());
      console.log('[Japriin Worker] Berhasil registrasi & terverifikasi otomatis dengan Master!');
      break;
    } catch (err) {
      console.warn(\`[Japriin Worker] Register percobaan \${attempt}/5 gagal: \${err?.message}\`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  try {
    const assigned = await callMaster('GET', '/api/worker-bridge/my-sessions');
    const items = Array.isArray(assigned?.sessions) ? assigned.sessions : [];
    console.log(\`[Japriin Worker] Memulihkan \${items.length} sesi tersimpan dari Master...\`);
    for (const item of items) {
      await startOrRestoreSession(item.id, item.phone_number, item.user_id, item.authFiles).catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
    }
    if (items.length > 0) {
      setTimeout(() => {
        void callMaster('POST', '/api/worker-bridge/heartbeat', collectTelemetry()).catch(() => {});
      }, 2500);
    }
  } catch (err) {
    console.warn('[Japriin Worker] Gagal tarik sesi awal:', err?.message);
  }

  const hbTimer = setInterval(() => {
    void callMaster('POST', '/api/worker-bridge/heartbeat', collectTelemetry()).catch(() => {});
  }, 25000);
  hbTimer.unref?.();

  const schedulePoll = () => {
    const interval = Date.now() < isBurstPollingUntil ? 700 : 2500;
    const t = setTimeout(async () => {
      await pollRelayCommandsOnce();
      schedulePoll();
    }, interval);
    t.unref?.();
  };
  schedulePoll();
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(\`[Japriin Worker] Listening on port \${PORT}\`);
  void bootstrapWorker();
});
`;
}

export function generateWorkerZipBuffer(params: {
  node: WorkerNode;
  masterUrl: string;
}): Buffer {
  const { node, masterUrl } = params;
  const cleanMaster = String(masterUrl || 'https://domain-anda.com').trim().replace(/\/+$/, '');

  const packageJson = JSON.stringify(
    {
      name: `japriin-wa-worker-${node.id}`,
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: {
        start: 'node worker.mjs'
      },
      dependencies: {
        '@whiskeysockets/baileys': '^7.0.0-rc14',
        express: '^4.21.2',
        pino: '^10.4.0',
        qrcode: '^1.5.4'
      }
    },
    null,
    2
  );

  const dockerfile = `FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache git ca-certificates
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "worker.mjs"]
`;

  const workerConfigJson = JSON.stringify(
    {
      nodeId: node.id,
      nodeName: node.name,
      masterUrl: cleanMaster,
      maxSessions: node.max_sessions || 10,
      provider: node.provider || 'northflank'
    },
    null,
    2
  );

  const envExample = `PORT=3000
MASTER_URL=${cleanMaster}
NODE_ID=${node.id}
NODE_SECRET=SALIN_NODE_SECRET_DARI_DASHBOARD_SUPERADMIN_JAPRIIN
MAX_SESSIONS=${node.max_sessions || 10}
WORKER_PROVIDER=${node.provider || 'northflank'}
# Opsional (otomatis terdeteksi jika dikosongkan):
WORKER_PUBLIC_URL=
`;

  const gitignore = `node_modules/
.env
.env.*
!.env.example
tmp/
`;

  const dockerignore = `node_modules
.env
.git
`;

  const readme = `# Japriin WA Worker (${node.name})

Paket ini adalah **Worker Baileys Ringan** untuk dijalankan di **Northflank (Free Developer Plan)** atau VPS Docker.
User aplikasi Japriin tidak akan pernah diarahkan ke sini — seluruh komunikasi berjalan aman di balik layar antara aplikasi utama (**Master**) dan **Worker** ini dengan tanda tangan **HMAC-SHA256**.

## Cara Deploy ke Northflank (Free)
1. Upload / push isi folder ZIP ini ke repository Git (GitHub/GitLab) Anda (file \`.gitignore\` otomatis melindungi agar \`.env\` tidak ikut ter-upload).
2. Login ke Northflank -> **Create Service** -> pilih **Build Service from Git** -> hubungkan ke repo Anda.
3. Pada bagian **Build Options**, pilih **Dockerfile** (sudah tersedia di root ZIP).
4. Pada bagian **Resources (Free Tier)**, pilih instance kecil (misal 256MB-512MB RAM).
5. Buka tab **Environment** di Northflank dan tambahkan Environment Variable wajib:
   - \`NODE_SECRET\` = *(Salin nilai NODE_SECRET dari Dashboard Superadmin Japriin)*
   - \`MASTER_URL\` = \`${cleanMaster}\` *(sudah ada di worker.config.json, boleh ditulis ulang di env)*
   - \`NODE_ID\` = \`${node.id}\`
   - \`MAX_SESSIONS\` = \`${node.max_sessions || 10}\`
6. Klik **Deploy**. Begitu container menyala, Worker ini akan **otomatis melapor dan terverifikasi** di Dashboard Superadmin Japriin!

> Catatan: Disk Northflank Free bersifat sementara. Worker ini otomatis mem-backup kredensial login WhatsApp ke aplikasi utama Japriin agar saat container restart sesi tidak perlu scan QR ulang.
`;

  return buildZipArchive([
    { name: 'package.json', content: packageJson + '\n' },
    { name: 'Dockerfile', content: dockerfile },
    { name: '.dockerignore', content: dockerignore },
    { name: '.gitignore', content: gitignore },
    { name: '.env.example', content: envExample },
    { name: 'worker.config.json', content: workerConfigJson + '\n' },
    { name: 'README-NORTHFLANK.md', content: readme },
    { name: 'metaAiHelper.mjs', content: buildMetaAiHelperSource() },
    { name: 'worker.mjs', content: buildWorkerMjsSource() }
  ]);
}
