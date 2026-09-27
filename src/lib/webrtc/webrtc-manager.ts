import {
  CONTROL_CHANNEL_LABEL,
  CONTROL_MAX_BYTES,
  CONTROL_MESSAGE_KINDS,
  FILE_CHANNEL_LABEL,
  FILE_CHUNK_HEADER_BYTES,
  FILE_CHUNK_HEADER_OFFSET,
  FILE_CHUNK_INDEX_OFFSET,
  FILE_CHUNK_PAYLOAD_OFFSET,
  GCM_CHUNK_NONCE_BYTES,
  GCM_TAG_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_CHUNK_SIZE,
  MAX_TOTAL_CHUNKS,
  TEXT_MAX_BYTES,
  type CipherEnvelope,
  type ControlMessage,
  type DataChannelLabel,
  type FileChunkFrame,
  type IceCandidate,
  type SessionDescription,
} from "@/lib/types/protocol";
import {
  decryptControlMessage,
  decryptPayload,
  encryptControlMessage,
  encryptPayload,
} from "@/lib/webrtc/crypto";

export interface SdpSignalHandlers {
  onOffer?: (description: SessionDescription) => void;
  onAnswer?: (description: SessionDescription) => void;
  onIceCandidate?: (candidate: IceCandidate) => void;
}

export interface WebRTCManagerOptions {
  initiator: boolean;
  encryptionKey?: CryptoKey | null;
  onSignal?: SdpSignalHandlers;
  onDataChannelOpen?: (label: DataChannelLabel) => void;
  onDataChannelClosed?: (label: DataChannelLabel) => void;
  onControlMessage?: (message: ControlMessage) => void;
  onChunkReceived?: (frame: FileChunkFrame) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onConnectionFailed?: (reason: string) => void;
  onInternalError?: (error: Error) => void;
  iceServers?: RTCIceServer[];
}

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

const FILE_BUFFER_HIGH_WATERMARK = 2 * 1024 * 1024;
const FILE_BUFFER_LOW_WATERMARK = 512 * 1024;
const BUFFER_DRAIN_TIMEOUT_MS = 10000;
const RECONNECT_TIMEOUT_MS = 15000;
const MAX_FILE_NAME_BYTES = 1024;
const MAX_MIME_TYPE_BYTES = 1024;
const MAX_RESUME_CHUNKS = 2000;
const MAX_TRACKED_FILE_IDS = 256;

// Bounds for chunks buffered before their file-start header arrives. Without a
// global cap, a peer can exhaust the tab's memory by spraying unique file ids.
const MAX_PENDING_FILE_IDS = 32;
const MAX_PENDING_CHUNKS_PER_FILE = 512;
const MAX_PENDING_CHUNK_BYTES = 8 * 1024 * 1024;

function byteLengthOf(value: string): number {
  return new TextEncoder().encode(value).length;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseControlMessage(data: string): ControlMessage {
  if (byteLengthOf(data) > CONTROL_MAX_BYTES) {
    throw new Error("Control message exceeds the size limit");
  }
  const message: unknown = JSON.parse(data);
  if (typeof message !== "object" || message === null) {
    throw new Error("Control message is not a JSON object");
  }
  const kind = (message as { kind?: unknown }).kind;
  if (
    typeof kind !== "string" ||
    !(CONTROL_MESSAGE_KINDS as readonly string[]).includes(kind)
  ) {
    throw new Error(`Unknown control message kind: ${String(kind)}`);
  }
  validateControlMessage(message as ControlMessage);
  return message as ControlMessage;
}

function validateControlMessage(message: ControlMessage): void {
  switch (message.kind) {
    case "text-message": {
      if (byteLengthOf(message.text) > TEXT_MAX_BYTES) {
        throw new Error("Text message exceeds the size limit");
      }
      break;
    }
    case "file-start": {
      if (
        !Number.isInteger(message.fileId) ||
        message.fileId < 0 ||
        message.fileId > 0x7fffffff
      ) {
        throw new Error("File id is not valid");
      }
      if (
        !Number.isInteger(message.totalChunks) ||
        message.totalChunks < 0 ||
        message.totalChunks > MAX_TOTAL_CHUNKS
      ) {
        throw new Error("Chunk count is not valid");
      }
      if (
        typeof message.fileSize !== "number" ||
        !Number.isFinite(message.fileSize) ||
        message.fileSize < 0 ||
        message.fileSize > MAX_FILE_BYTES
      ) {
        throw new Error("File size is not valid");
      }
      if (
        typeof message.fileName !== "string" ||
        message.fileName.length === 0 ||
        byteLengthOf(message.fileName) > MAX_FILE_NAME_BYTES
      ) {
        throw new Error("File name is not valid");
      }
      if (
        typeof message.mimeType !== "string" ||
        byteLengthOf(message.mimeType) > MAX_MIME_TYPE_BYTES
      ) {
        throw new Error("Mime type is not valid");
      }
      break;
    }
    case "file-resume-req": {
      if (
        !Number.isInteger(message.fileId) ||
        message.fileId < 0 ||
        message.fileId > 0x7fffffff
      ) {
        throw new Error("File id is not valid");
      }
      if (
        !Array.isArray(message.missingChunks) ||
        message.missingChunks.length > MAX_RESUME_CHUNKS
      ) {
        throw new Error("Resume request is not valid");
      }
      // Every index must be a non-negative integer. Negative values would make
      // Blob.slice read from the end of the file, and duplicates would corrupt
      // the transfer accounting and cause a permanent "incomplete" verdict.
      for (const index of message.missingChunks) {
        if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) {
          throw new Error("Resume request contains an invalid chunk index");
        }
      }
      break;
    }
    case "file-end": {
      if (
        !Number.isInteger(message.fileId) ||
        message.fileId < 0 ||
        message.fileId > 0x7fffffff
      ) {
        throw new Error("File id is not valid");
      }
      if (
        !Number.isInteger(message.chunksVerified) ||
        message.chunksVerified < 0
      ) {
        throw new Error("Chunk verification is not valid");
      }
      break;
    }
    case "file-ack":
    case "file-start-ack":
    case "file-end-ack": {
      if (
        !Number.isInteger(message.fileId) ||
        message.fileId < 0 ||
        message.fileId > 0x7fffffff
      ) {
        throw new Error("File id is not valid");
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Per-chunk AES-GCM nonce: `seed(8) || fileId(4) || chunkIndex(4)`.
 *
 * The chunk index MUST be part of the nonce. Reusing a (key, nonce) pair under
 * AES-GCM is catastrophic: it leaks the XOR of plaintexts and destroys
 * authentication. The previous `seed || fileId` form was identical for every
 * chunk of a file, and a resumed transfer re-encrypted the same chunk under the
 * same nonce again.
 */
function chunkNonce(
  seed: Uint8Array,
  fileId: number,
  chunkIndex: number
): Uint8Array {
  const nonce = new Uint8Array(GCM_CHUNK_NONCE_BYTES);
  nonce.set(seed.subarray(0, 8), 0);
  const view = new DataView(nonce.buffer);
  view.setUint32(8, fileId, false);
  view.setUint32(12, chunkIndex >>> 0, false);
  return nonce;
}

async function parseChunkFrame(
  buffer: ArrayBuffer,
  encryptionKey: CryptoKey | null,
  seed: Uint8Array
): Promise<FileChunkFrame> {
  if (buffer.byteLength < FILE_CHUNK_PAYLOAD_OFFSET) {
    throw new Error("Chunk frame is shorter than its header");
  }
  const view = new DataView(buffer);
  const fileId = view.getUint32(FILE_CHUNK_HEADER_OFFSET, false);
  const chunkIndex = view.getUint32(FILE_CHUNK_INDEX_OFFSET, false);
  const maxCipherLength = MAX_FILE_CHUNK_SIZE + GCM_TAG_BYTES;
  const ciphertext = buffer.slice(FILE_CHUNK_PAYLOAD_OFFSET);
  let payload = ciphertext;
  if (encryptionKey) {
    if (ciphertext.byteLength > maxCipherLength) {
      throw new Error("Chunk payload is too large");
    }
    payload = await decryptPayload(
      encryptionKey,
      ciphertext,
      chunkNonce(seed, fileId, chunkIndex).buffer as ArrayBuffer
    );
  }
  if (payload.byteLength > MAX_FILE_CHUNK_SIZE) {
    throw new Error("Chunk payload is too large");
  }
  return { fileId, chunkIndex, payload };
}

async function toText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  return new TextDecoder().decode(data as ArrayBuffer);
}

async function toArrayBuffer(data: unknown): Promise<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Blob) return data.arrayBuffer();
  throw new Error("Chunk frame arrived with an unexpected payload type");
}

export class WebRTCManager {
  private readonly initiator: boolean;
  private readonly polite: boolean;
  private readonly options: WebRTCManagerOptions;
  private readonly pc: RTCPeerConnection;
  private readonly encryptionKey: CryptoKey | null;
  private pendingFileChunkBytes = 0;
  private readonly fileSeeds = new Map<number, Uint8Array>();
  private readonly pendingIceCandidates: IceCandidate[] = [];
  private readonly pendingFileChunks = new Map<number, ArrayBuffer[]>();


  private controlChannel: RTCDataChannel | null = null;
  private fileChannel: RTCDataChannel | null = null;

  private sendQueue: Promise<void> = Promise.resolve();

  private makingOffer = false;
  private ignoreOffer = false;
  private reconnecting = false;
  private reconnectFailedReported = false;
  private reconnectDeadlineId: ReturnType<typeof setTimeout> | null = null;
  private remoteDescriptionSet = false;

  constructor(options: WebRTCManagerOptions) {
    this.initiator = options.initiator;
    this.polite = !options.initiator;
    this.options = options;
    this.encryptionKey = options.encryptionKey ?? null;

    this.pc = new RTCPeerConnection({
      iceServers: options.iceServers ?? DEFAULT_ICE_SERVERS,
    });

    this.pc.onnegotiationneeded = () => {
      if (this.initiator) {
        void this.makeOffer();
      }
    };
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.onSignal?.onIceCandidate?.(event.candidate.toJSON());
      }
    };
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      if (state === "disconnected" || state === "failed") {
        this.handleConnectionDrop();
      } else if (
        (state === "connected" || state === "completed") &&
        this.reconnecting
      ) {
        this.reconnecting = false;
        this.reconnectFailedReported = false;
        this.clearReconnectDeadline();
        this.options.onReconnected?.();
      }
    };
    this.pc.onconnectionstatechange = () => {
      if (
        this.pc.connectionState === "failed" &&
        !this.reconnectFailedReported
      ) {
        this.reconnectFailedReported = true;
        this.clearReconnectDeadline();
        this.options.onConnectionFailed?.("Peer connection failed");
      }
    };
    this.pc.ondatachannel = (event) => {
      this.attachChannel(event.channel);
    };
  }

  negotiate(): void {
    if (!this.initiator) return;
    if (!this.controlChannel) {
      this.createDataChannels();
    }
    void this.makeOffer();
  }

  private scheduleReconnectDeadline(): void {
    if (this.reconnectDeadlineId !== null) return;
    this.reconnectDeadlineId = setTimeout(() => {
      this.reconnectDeadlineId = null;
      if (this.reconnecting && !this.reconnectFailedReported) {
        this.reconnectFailedReported = true;
        this.options.onConnectionFailed?.(
          "The connection could not be re-established in time"
        );
      }
    }, RECONNECT_TIMEOUT_MS);
  }

  private clearReconnectDeadline(): void {
    if (this.reconnectDeadlineId !== null) {
      clearTimeout(this.reconnectDeadlineId);
      this.reconnectDeadlineId = null;
    }
  }

  private handleConnectionDrop(): void {
    if (this.pc.signalingState === "closed" || this.reconnecting) return;
    this.reconnecting = true;
    this.options.onReconnecting?.();
    this.scheduleReconnectDeadline();
    this.pc.restartIce();
    void this.makeOffer();
  }

  async handleRemoteDescription(description: SessionDescription): Promise<void> {
    const offerCollision =
      description.type === "offer" &&
      (this.makingOffer || this.pc.signalingState !== "stable");
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;
    try {
      await this.pc.setRemoteDescription(description);
      this.remoteDescriptionSet = true;
      await this.flushPendingIceCandidates();
      if (description.type === "offer") {
        await this.pc.setLocalDescription();
        const local = this.pc.localDescription;
        if (local) {
          this.options.onSignal?.onAnswer?.(local.toJSON());
        }
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  async handleIceCandidate(candidate: IceCandidate): Promise<void> {
    if (!candidate || typeof candidate !== "object") return;
    if (!this.remoteDescriptionSet) {
      this.pendingIceCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      this.pendingIceCandidates.push(candidate);
      void this.flushPendingIceCandidates();
    }
  }

  private async flushPendingIceCandidates(): Promise<void> {
    while (this.pendingIceCandidates.length > 0) {
      const candidate = this.pendingIceCandidates[0];
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        this.reportError(error);
        this.pendingIceCandidates.shift();
        return;
      }
      this.pendingIceCandidates.shift();
    }
  }

  async sendControlMessage(message: ControlMessage): Promise<boolean> {
    const channel = this.controlChannel;
    if (!channel || channel.readyState !== "open") return false;

    const shouldEncrypt = !!this.encryptionKey;
    if (message.kind === "file-start" && shouldEncrypt) {
      const seed = new Uint8Array(8);
      globalThis.crypto.getRandomValues(seed);
      this.fileSeeds.set(message.fileId, seed);
      message.fileNonce = bytesToBase64Url(seed);
      if (this.fileSeeds.size > MAX_TRACKED_FILE_IDS) {
        const oldest = this.fileSeeds.keys().next().value;
        if (oldest !== undefined) this.fileSeeds.delete(oldest);
      }
    } else if (message.kind === "file-start" && !shouldEncrypt) {
      message.fileNonce = undefined;
    }

    const task = async (): Promise<void> => {
      const wire = JSON.stringify(message);
      if (byteLengthOf(wire) > CONTROL_MAX_BYTES) {
        throw new Error("Control message exceeds the size limit");
      }
      if (!shouldEncrypt) {
        channel.send(wire);
        return;
      }
      const envelope = await encryptControlMessage(
        this.encryptionKey as CryptoKey,
        wire
      );
      channel.send(JSON.stringify(envelope));
    };

    const scheduled = this.sendQueue.then(task);
    this.sendQueue = scheduled.catch(() => undefined);
    try {
      await scheduled;
      return true;
    } catch {
      return false;
    }
  }

  async sendChunk(frame: FileChunkFrame): Promise<boolean> {
    const channel = this.fileChannel;
    if (!channel || channel.readyState !== "open") return false;
    if (
      !Number.isInteger(frame.fileId) ||
      frame.fileId < 0 ||
      frame.fileId > 0x7fffffff
    ) {
      throw new Error("File id is not valid");
    }
    if (
      !Number.isInteger(frame.chunkIndex) ||
      frame.chunkIndex < 0 ||
      frame.chunkIndex > 0x7fffffff
    ) {
      throw new Error("Chunk index is not valid");
    }
    if (frame.payload.byteLength > MAX_FILE_CHUNK_SIZE) {
      throw new Error("Chunk payload exceeds the size limit");
    }
    const shouldEncrypt = !!this.encryptionKey;
    let seed: Uint8Array | undefined;
    if (shouldEncrypt) {
      seed = this.fileSeeds.get(frame.fileId);
      if (!seed) {
        throw new Error("Chunk was sent before the file was started");
      }
    }
    if (channel.bufferedAmount > FILE_BUFFER_HIGH_WATERMARK) {
      const drained = await this.waitForFileBufferLow(
        FILE_BUFFER_LOW_WATERMARK,
        BUFFER_DRAIN_TIMEOUT_MS
      );
      if (!drained || channel.readyState !== "open") return false;
    }

    const header = new Uint8Array(FILE_CHUNK_HEADER_BYTES);
    const view = new DataView(header.buffer);
    view.setUint32(FILE_CHUNK_HEADER_OFFSET, frame.fileId, false);
    view.setUint32(FILE_CHUNK_INDEX_OFFSET, frame.chunkIndex, false);

    let payload = frame.payload;
    if (shouldEncrypt && seed) {
      payload = await encryptPayload(
        this.encryptionKey as CryptoKey,
        payload,
        chunkNonce(seed, frame.fileId, frame.chunkIndex).buffer as ArrayBuffer
      );
      if (payload.byteLength !== frame.payload.byteLength + GCM_TAG_BYTES) {
        throw new Error("Encrypted chunk is the wrong length");
      }
    }

    const merged = new Uint8Array(header.byteLength + payload.byteLength);
    merged.set(header, FILE_CHUNK_HEADER_OFFSET);
    merged.set(new Uint8Array(payload), FILE_CHUNK_PAYLOAD_OFFSET);

    channel.send(merged.buffer);
    return true;
  }

  isFileChannelOpen(): boolean {
    return this.fileChannel?.readyState === "open";
  }

  getFileBufferedAmount(): number {
    return this.fileChannel?.bufferedAmount ?? 0;
  }

  waitForFileBufferLow(
    threshold: number,
    timeoutMs = BUFFER_DRAIN_TIMEOUT_MS
  ): Promise<boolean> {
    const channel = this.fileChannel;
    if (!channel || channel.bufferedAmount <= threshold) {
      return Promise.resolve(true);
    }
    channel.bufferedAmountLowThreshold = Math.min(
      threshold,
      channel.bufferedAmount - 1
    );
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve(false);
      }, timeoutMs);
      const onLow = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve(true);
      };
      channel.addEventListener("bufferedamountlow", onLow);
    });
  }

  close(): void {
    this.clearReconnectDeadline();
    this.pendingFileChunks.clear();
    for (const channel of [this.controlChannel, this.fileChannel]) {
      if (channel && channel.readyState !== "closed") {
        channel.close();
      }
    }
    this.pc.close();
  }

  private async makeOffer(): Promise<void> {
    if (this.pc.signalingState !== "stable" || this.makingOffer) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      const local = this.pc.localDescription;
      if (local) {
        this.options.onSignal?.onOffer?.(local.toJSON());
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      this.makingOffer = false;
    }
  }

  private createDataChannels(): void {
    const control = this.pc.createDataChannel(CONTROL_CHANNEL_LABEL, {
      ordered: true,
    });
    const file = this.pc.createDataChannel(FILE_CHANNEL_LABEL, {
      ordered: false,
    });
    this.attachChannel(control);
    this.attachChannel(file);
  }

  private attachChannel(channel: RTCDataChannel): void {
    if (channel.label === CONTROL_CHANNEL_LABEL) {
      this.controlChannel = channel;
    } else if (channel.label === FILE_CHANNEL_LABEL) {
      this.fileChannel = channel;
    } else {
      channel.close();
      return;
    }

    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      this.options.onDataChannelOpen?.(channelLabel(channel.label));
    };
    channel.onclose = () => {
      this.options.onDataChannelClosed?.(channelLabel(channel.label));
    };
    channel.onmessage = (event) => {
      void this.routeMessage(channel.label as DataChannelLabel, event.data);
    };
  }

  private async routeMessage(
    label: DataChannelLabel,
    data: unknown
  ): Promise<void> {
    if (label === CONTROL_CHANNEL_LABEL) {
      try {
        const wireText = await toText(data);
        let isEnvelope = false;
        let envelope: CipherEnvelope | null = null;
        try {
          const maybe = JSON.parse(wireText) as unknown;
          if (
            maybe !== null &&
            typeof maybe === "object" &&
            (maybe as { v?: unknown }).v === 1 &&
            typeof (maybe as { nonce?: unknown }).nonce === "string" &&
            typeof (maybe as { ciphertext?: unknown }).ciphertext === "string"
          ) {
            isEnvelope = true;
            envelope = maybe as CipherEnvelope;
          }
        } catch {
          isEnvelope = false;
        }

        let plainText: string;
        if (isEnvelope) {
          if (!this.encryptionKey) {
            throw new Error(
              "This room was created with a share link. Join using the full link, or have the sender share just the room code so both sides use the same mode."
            );
          }
          plainText = await decryptControlMessage(
            this.encryptionKey,
            envelope as CipherEnvelope
          );
        } else {
          // Fail closed. A keyed peer must never silently accept plaintext: that
          // would let a malicious peer strip confidentiality with one message.
          if (this.encryptionKey) {
            throw new Error(
              "The peer sent an unencrypted control message. This room is encrypted, so the connection was rejected to protect your data. Use the full share link on both sides, or the room code on both sides."
            );
          }
          plainText = wireText;
        }

        const message = parseControlMessage(plainText);
        if (message.kind === "file-start" && message.fileNonce) {
          try {
            const seed = seedFromBase64Url(message.fileNonce);
            this.fileSeeds.set(message.fileId, seed);
            if (this.fileSeeds.size > MAX_TRACKED_FILE_IDS) {
              const oldest = this.fileSeeds.keys().next().value;
              if (oldest !== undefined) this.fileSeeds.delete(oldest);
            }
            const pending = this.pendingFileChunks.get(message.fileId);
            if (pending) {
              this.pendingFileChunks.delete(message.fileId);
              for (const buffered of pending) {
                this.pendingFileChunkBytes = Math.max(
                  0,
                  this.pendingFileChunkBytes - buffered.byteLength
                );
                const frame = await parseChunkFrame(
                  buffered,
                  this.encryptionKey,
                  seed
                );
                this.options.onChunkReceived?.(frame);
              }
            }
          } catch {
            // A malformed seed is a protocol error, not a reason to silently
            // fall back to plaintext for the rest of the session.
            this.pendingFileChunks.delete(message.fileId);
            this.reportError(
              new Error(
                `The peer sent an invalid encryption seed for file ${message.fileId}.`
              )
            );
          }
        } else if (message.kind === "file-end") {
          this.fileSeeds.delete(message.fileId);
          this.pendingFileChunks.delete(message.fileId);
        }
        this.options.onControlMessage?.(message);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("not a valid cipher envelope")
        ) {
          this.reportError(
            new Error(
              "The peers are using different encryption settings. Use the full share link on both sides, or the room code on both sides."
            )
          );
        } else {
          this.reportError(error);
        }
      }
      return;
    }
    try {
      const buffer = await toArrayBuffer(data);
      if (buffer.byteLength < FILE_CHUNK_PAYLOAD_OFFSET) {
        throw new Error("Chunk frame is shorter than its header");
      }
      const fileId = new DataView(buffer).getUint32(
        FILE_CHUNK_HEADER_OFFSET,
        false
      );
      const shouldDecrypt = !!this.encryptionKey;
      let seed = this.fileSeeds.get(fileId);
      if (shouldDecrypt && !seed) {
        // Buffer chunks that arrive before their file-start. This is bounded on
        // purpose: a peer must not be able to exhaust memory by spraying frames
        // for file ids that were never announced (or by flooding one id).
        if (
          this.pendingFileChunks.size >= MAX_PENDING_FILE_IDS ||
          this.pendingFileChunkBytes + buffer.byteLength > MAX_PENDING_CHUNK_BYTES
        ) {
          this.clearPendingFileChunks();
          throw new Error(
            "Too much data arrived before the file headers; the transfer was rejected"
          );
        }
        const list = this.pendingFileChunks.get(fileId) ?? [];
        if (list.length >= MAX_PENDING_CHUNKS_PER_FILE) {
          this.clearPendingFileChunks();
          throw new Error(
            "Too many chunks arrived before the file header"
          );
        }
        list.push(buffer.slice(0));
        this.pendingFileChunks.set(fileId, list);
        this.pendingFileChunkBytes += buffer.byteLength;
        return;
      }
      if (!shouldDecrypt) {
        seed = new Uint8Array(8);
      }
      this.options.onChunkReceived?.(
        await parseChunkFrame(
          buffer,
          shouldDecrypt ? this.encryptionKey : null,
          seed as Uint8Array
        )
      );
    } catch (error) {
      this.reportError(error);
    }
  }

  private clearPendingFileChunks(): void {
    this.pendingFileChunks.clear();
    this.pendingFileChunkBytes = 0;
  }

  private reportError(error: unknown): void {
    const normalized =
      error instanceof Error ? error : new Error("WebRTC operation failed");
    this.options.onInternalError?.(normalized);
  }
}

function channelLabel(label: string): DataChannelLabel {
  return label === CONTROL_CHANNEL_LABEL
    ? CONTROL_CHANNEL_LABEL
    : FILE_CHANNEL_LABEL;
}

function seedFromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const seed = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    seed[i] = binary.charCodeAt(i);
  }
  if (seed.byteLength !== 8) {
    throw new Error("File nonce has the wrong length");
  }
  return seed;
}