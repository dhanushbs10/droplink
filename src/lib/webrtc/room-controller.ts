import {
  AES_256_KEY_BYTES,
  CONTROL_CHANNEL_LABEL,
  FILE_CHANNEL_LABEL,
  HKDF_INFO,
  HKDF_SALT,
  type Base64Url,
  type ControlMessage,
  type DataChannelLabel,
  type FileChunkFrame,
  type IceCandidate,
  type PeerId,
  type PeerInfo,
  type PeerRole,
  type PresenceStatus,
  type RoomCode,
  type RoomCreatedResponse,
  type RoomInfo,
  type RoomJoinedResponse,
  type RoomPeerJoinedEvent,
  type ServerToClientSignaling,
  type SessionDescription,
  type SignalingError,
} from "@/lib/types/protocol";
import {
  type SignalingClient,
  type SignalingSocket,
} from "@/lib/webrtc/signaling-client";
import { WebRTCManager } from "@/lib/webrtc/webrtc-manager";

export interface RoomControllerOptions {
  signaling: SignalingClient;
  onDataChannelOpen?: (label: DataChannelLabel) => void;
  onDataChannelClosed?: (label: DataChannelLabel) => void;
  onControlMessage?: (message: ControlMessage) => void;
  onChunkReceived?: (frame: FileChunkFrame) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onConnectionFailed?: (reason: string) => void;
  onInternalError?: (error: Error) => void;
  onError?: (error: SignalingError) => void;
}

type LooseEmitter = {
  once: (event: string, listener: (payload: unknown) => void) => void;
  off: (event: string, listener: (payload: unknown) => void) => void;
};

function generateShareToken(): Base64Url {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: Base64Url): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveRoomKey(shareToken: Base64Url): Promise<CryptoKey> {
  const hkdfKey = await globalThis.crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(shareToken),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(HKDF_SALT),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_256_KEY_BYTES * 8 },
    false,
    ["encrypt", "decrypt"]
  );
}

const WAIT_FOR_EVENT_TIMEOUT_MS = 15000;

function waitForEvent<T>(
  socket: SignalingSocket,
  event: keyof ServerToClientSignaling
): Promise<T> {
  const emitter = socket as unknown as LooseEmitter;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off("error", onError as (payload: unknown) => void);
      emitter.off(event, onEvent as (payload: unknown) => void);
      reject(new Error("The signaling server did not respond in time"));
    }, WAIT_FOR_EVENT_TIMEOUT_MS);
    const onError = (error: SignalingError) => {
      clearTimeout(timer);
      emitter.off(event, onEvent as (payload: unknown) => void);
      reject(new Error(error.message));
    };
    const onEvent = (payload: unknown) => {
      clearTimeout(timer);
      emitter.off("error", onError as (payload: unknown) => void);
      resolve(payload as T);
    };
    socket.once("error", onError);
    emitter.once(event, onEvent);
  });
}

export interface InitiatedRoom {
  roomCode: RoomCode;
  shareToken: Base64Url;
}

export class RoomController {
  private readonly signaling: SignalingClient;
  private readonly options: RoomControllerOptions;

  private webrtc: WebRTCManager | null = null;
  private room: RoomInfo | null = null;
  private selfPeerId: PeerId | null = null;
  private targetPeerId: PeerId | null = null;
  private role: PeerRole | null = null;
  private shareToken: Base64Url | null = null;
  private encryptionKey: CryptoKey | null = null;

  private readonly messageListeners = new Set<
    (message: ControlMessage) => void
  >();

  constructor(options: RoomControllerOptions) {
    this.signaling = options.signaling;
    this.options = options;

    const socket = this.signaling.socket;
    socket.on("room:created", (response) => this.applyRoomCreated(response));
    socket.on("room:joined", (response) => this.applyRoomJoined(response));
    socket.on("room:peer-joined", (event) => this.applyPeerJoined(event));
    socket.on("room:peer-left", (event) => {
      if (this.room) {
        this.room.peers = this.room.peers.filter(
          (peer) => peer.peerId !== event.peerId
        );
      }
      if (event.peerId === this.targetPeerId) {
        this.targetPeerId = null;
        // Tear the connection down with the peer, otherwise startWebRTC's
        // `if (this.webrtc) return` guard blocks a future reconnection.
        this.closeWebRTC();
        this.options.onDataChannelClosed?.(CONTROL_CHANNEL_LABEL);
        this.options.onDataChannelClosed?.(FILE_CHANNEL_LABEL);
      }
    });
    socket.on("room:left", () => {
      this.closeWebRTC();
      this.resetSession();
    });
    socket.on("peer:offer", (event) => {
      if (!this.resolveTargetPeer(event.fromPeerId)) return;
      if (!this.webrtc) return;
      void this.webrtc.handleRemoteDescription(event.sessionDescription);
    });
    socket.on("peer:answer", (event) => {
      if (!this.resolveTargetPeer(event.fromPeerId)) return;
      if (!this.webrtc) return;
      void this.webrtc.handleRemoteDescription(event.sessionDescription);
    });
    socket.on("peer:ice-candidate", (event) => {
      if (!this.resolveTargetPeer(event.fromPeerId)) return;
      if (!this.webrtc) return;
      void this.webrtc.handleIceCandidate(event.candidate);
    });
    socket.on("error", (error) => this.options.onError?.(error));
    (
      socket as unknown as {
        on(event: "connect_error", listener: (error: Error) => void): void;
      }
    ).on("connect_error", (error) => {
      this.options.onError?.({
        code: "SERVER_ERROR",
        message: error.message || "Could not reach the signaling server",
      });
    });
    socket.on("disconnect", () => {
      this.closeWebRTC();
      this.resetSession();
      this.options.onDataChannelClosed?.(CONTROL_CHANNEL_LABEL);
      this.options.onDataChannelClosed?.(FILE_CHANNEL_LABEL);
    });
  }

  async initiateRoom(): Promise<InitiatedRoom> {
    this.shareToken = generateShareToken();
    this.encryptionKey = await deriveRoomKey(this.shareToken);
    this.signaling.createRoom();
    const response = await waitForEvent<RoomCreatedResponse>(
      this.signaling.socket,
      "room:created"
    );
    this.applyRoomCreated(response);
    const roomCode = this.room?.roomCode;
    if (!roomCode || !this.shareToken) {
      throw new Error("Room creation failed without a room code");
    }
    return { roomCode, shareToken: this.shareToken };
  }

  async joinRoom(roomCode: RoomCode, shareToken?: Base64Url): Promise<void> {
    if (shareToken) {
      // Keep the token so this peer can also verify a peer's identity proof.
      this.shareToken = shareToken;
      this.encryptionKey = await deriveRoomKey(shareToken);
    } else {
      this.shareToken = null;
      this.encryptionKey = null;
    }
    this.signaling.joinRoom({ roomCode, role: "receiver" });
    const response = await waitForEvent<RoomJoinedResponse>(
      this.signaling.socket,
      "room:joined"
    );
    this.applyRoomJoined(response);
  }

  updatePresence(status: PresenceStatus): void {
    if (!this.room) return;
    this.signaling.updatePresence({
      roomCode: this.room.roomCode,
      status,
    });
  }

  getEncryptionKey(): CryptoKey | null {
    return this.encryptionKey;
  }

  async getSecurityFingerprint(): Promise<string> {
    if (!this.encryptionKey) return "";
    const raw = await globalThis.crypto.subtle.exportKey(
      "raw",
      this.encryptionKey
    );
    const digest = await globalThis.crypto.subtle.digest("SHA-256", raw);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (const byte of bytes) {
      hex += byte.toString(16).padStart(2, "0");
    }
    return hex.slice(0, 6);
  }

  getShareToken(): Base64Url | null {
    return this.shareToken;
  }

  /**
   * Proves possession of the room's share token for a given user id. Anyone
   * who can call this holds the same secret the receiver does, so a peer cannot
   * assert an identity it has not proven.
   */
  async createIdentityProof(userId: string): Promise<string | null> {
    if (!this.shareToken) return null;
    const material = await globalThis.crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(this.shareToken),
      "HMAC",
      false,
      ["sign"]
    );
    const signature = await globalThis.crypto.subtle.sign(
      "HMAC",
      material,
      new TextEncoder().encode(`droplink-identity:${userId}`)
    );
    let binary = "";
    for (const byte of new Uint8Array(signature)) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  getRoom(): RoomInfo | null {
    return this.room;
  }

  sendControlMessage(message: ControlMessage): Promise<boolean> {
    return (this.webrtc?.sendControlMessage(message) ?? Promise.resolve(false));
  }

  async sendChunk(frame: FileChunkFrame): Promise<boolean> {
    return (await this.webrtc?.sendChunk(frame)) ?? false;
  }

  onMessage(listener: (message: ControlMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  isFileChannelOpen(): boolean {
    return this.webrtc?.isFileChannelOpen() ?? false;
  }

  getFileBufferedAmount(): number {
    return this.webrtc?.getFileBufferedAmount() ?? 0;
  }

  waitForFileBufferLow(threshold: number): Promise<boolean> {
    return (
      this.webrtc?.waitForFileBufferLow(threshold) ?? Promise.resolve(true)
    );
  }

  disconnect(): void {
    if (this.room) {
      this.signaling.leaveRoom({
        roomCode: this.room.roomCode,
        reason: "manual",
      });
    }
    this.webrtc?.close();
    this.webrtc = null;
    this.signaling.socket.disconnect();
    this.resetSession();
  }

  private applyRoomCreated(response: RoomCreatedResponse): void {
    this.room = response.room;
    this.selfPeerId = response.selfPeerId;
    this.role = "sender";
    this.startWebRTC(true);
    this.resolveTargetFromRoom();
  }

  private applyRoomJoined(response: RoomJoinedResponse): void {
    this.room = response.room;
    this.selfPeerId = response.selfPeerId;
    this.role = "receiver";
    this.startWebRTC(false);
    this.resolveTargetFromRoom();
  }

  private applyPeerJoined(event: RoomPeerJoinedEvent): void {
    const peer: PeerInfo = event.peer;
    const existing = this.room?.peers.some(
      (candidate) => candidate.peerId === peer.peerId
    );
    if (!existing) {
      this.room?.peers.push(peer);
    }
    if (peer.peerId !== this.selfPeerId && !this.targetPeerId) {
      this.targetPeerId = peer.peerId;
      this.webrtc?.negotiate();
    }
  }

  private resolveTargetFromRoom(): void {
    if (!this.room || !this.selfPeerId) return;
    const peer = this.room.peers.find(
      (candidate) => candidate.peerId !== this.selfPeerId
    );
    if (peer && !this.targetPeerId) {
      this.targetPeerId = peer.peerId;
      this.webrtc?.negotiate();
    }
  }

  private resolveTargetPeer(fromPeerId: PeerId): boolean {
    if (fromPeerId === this.selfPeerId) return false;
    if (!this.room) return false;
    if (this.targetPeerId) return fromPeerId === this.targetPeerId;
    const known = this.room.peers.some(
      (peer) => peer.peerId === fromPeerId
    );
    if (!known) return false;
    this.targetPeerId = fromPeerId;
    return true;
  }

  private startWebRTC(initiator: boolean): void {
    if (this.webrtc) return;
    this.webrtc = new WebRTCManager({
      initiator,
      encryptionKey: this.encryptionKey,
      onSignal: {
        onOffer: this.handleOffer,
        onAnswer: this.handleAnswer,
        onIceCandidate: this.handleIceCandidate,
      },
      onDataChannelOpen: (label) => this.options.onDataChannelOpen?.(label),
      onDataChannelClosed: (label) => this.options.onDataChannelClosed?.(label),
      onControlMessage: (message) => {
        this.options.onControlMessage?.(message);
        for (const listener of this.messageListeners) {
          listener(message);
        }
      },
      onChunkReceived: (frame) => this.options.onChunkReceived?.(frame),
      onReconnecting: () => this.options.onReconnecting?.(),
      onReconnected: () => this.options.onReconnected?.(),
      onConnectionFailed: (reason) =>
        this.options.onConnectionFailed?.(reason),
      onInternalError: (error) => this.options.onInternalError?.(error),
    });
  }

  private readonly handleOffer = (description: SessionDescription): void => {
    if (!this.room || !this.targetPeerId) return;
    this.signaling.sendOffer({
      roomCode: this.room.roomCode,
      targetPeerId: this.targetPeerId,
      sessionDescription: description,
    });
  };

  private readonly handleAnswer = (description: SessionDescription): void => {
    if (!this.room || !this.targetPeerId) return;
    this.signaling.sendAnswer({
      roomCode: this.room.roomCode,
      targetPeerId: this.targetPeerId,
      sessionDescription: description,
    });
  };

  private readonly handleIceCandidate = (candidate: IceCandidate): void => {
    if (!this.room || !this.targetPeerId) return;
    this.signaling.sendIceCandidate({
      roomCode: this.room.roomCode,
      targetPeerId: this.targetPeerId,
      candidate,
    });
  };

  private closeWebRTC(): void {
    this.webrtc?.close();
    this.webrtc = null;
  }

  private resetSession(): void {
    this.room = null;
    this.selfPeerId = null;
    this.targetPeerId = null;
    this.role = null;
    this.shareToken = null;
    this.encryptionKey = null;
  }
}