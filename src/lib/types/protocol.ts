export const PROTOCOL_VERSION = 1;

export const ROOM_CAPACITY = 2;
export const ROOM_CODE_LENGTH = 8;
export const ROOM_CODE_PATTERN = /^[A-HJKMNP-Z2-9]{8}$/;

export const MAX_FILE_CHUNK_SIZE = 16 * 1024;
export const FILE_CHUNK_HEADER_BYTES = 8;
export const MAX_CHUNK_FRAME_SIZE = FILE_CHUNK_HEADER_BYTES + MAX_FILE_CHUNK_SIZE;

// Transfer ceilings. The advertised chunk count drives loop bounds on the
// receiver, so it must be derived from a bounded file size rather than trusted
// from the wire.
export const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB
export const MAX_TOTAL_CHUNKS = Math.ceil(MAX_FILE_BYTES / MAX_FILE_CHUNK_SIZE);

export const CONTROL_MAX_BYTES = 16 * 1024;
export const TEXT_MAX_BYTES = 8 * 1024;

export const GCM_TAG_BYTES = 16;
export const GCM_NONCE_BYTES = 12;
/**
 * File chunks use a longer nonce so that both the file id and the chunk index
 * fit alongside the per-file seed. Reusing a (key, nonce) pair under AES-GCM
 * leaks the XOR of plaintexts and voids authentication, so the chunk index must
 * be part of the nonce. 96-bit nonces remain the default for control messages.
 */
export const GCM_CHUNK_NONCE_BYTES = 16;
export const AES_256_KEY_BYTES = 32;

export const HKDF_SALT = "droplink-signal-v1";
export const HKDF_INFO = "droplink-aes-256-gcm-v1";

// ---------------------------------------------------------------------------
// Identity and roles
// ---------------------------------------------------------------------------

export type RoomCode = string;
export type PeerId = string;
export type FileId = number;
export type ChunkIndex = number;
export type Base64Url = string;

export type PeerRole = "sender" | "receiver";
export type PresenceStatus = "online" | "idle";
export type LeaveReason = "manual" | "disconnect" | "timeout";

export type SessionDescription = RTCSessionDescriptionInit;
export type IceCandidate = RTCIceCandidateInit;

export interface PeerInfo {
  peerId: PeerId;
  role: PeerRole;
  presenceStatus: PresenceStatus;
  displayName?: string;
}

export interface RoomInfo {
  roomCode: RoomCode;
  peers: PeerInfo[];
  createdAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Signaling: client to server
// ---------------------------------------------------------------------------

export interface RoomCreateRequest {
  clientProtocolVersion: number;
}

export interface RoomJoinRequest {
  roomCode: RoomCode;
  role: PeerRole;
  clientProtocolVersion?: number;
  displayName?: string;
  resumeToken?: string;
}

export interface RoomLeaveRequest {
  roomCode: RoomCode;
  reason: LeaveReason;
}

export interface PeerOfferRequest {
  roomCode: RoomCode;
  targetPeerId: PeerId;
  sessionDescription: SessionDescription;
}

export interface PeerAnswerRequest {
  roomCode: RoomCode;
  targetPeerId: PeerId;
  sessionDescription: SessionDescription;
}

export interface PeerIceCandidateRequest {
  roomCode: RoomCode;
  targetPeerId: PeerId;
  candidate: IceCandidate;
}

export interface PresenceUpdateRequest {
  roomCode: RoomCode;
  status: PresenceStatus;
}

export interface ClientToServerSignaling {
  "room:create": (request: RoomCreateRequest) => void;
  "room:join": (request: RoomJoinRequest) => void;
  "room:leave": (request: RoomLeaveRequest) => void;
  "peer:offer": (request: PeerOfferRequest) => void;
  "peer:answer": (request: PeerAnswerRequest) => void;
  "peer:ice-candidate": (request: PeerIceCandidateRequest) => void;
  "presence:update": (request: PresenceUpdateRequest) => void;
}

// ---------------------------------------------------------------------------
// Signaling: server to client
// ---------------------------------------------------------------------------

export interface RoomCreatedResponse {
  room: RoomInfo;
  selfPeerId: PeerId;
}

export interface RoomJoinedResponse {
  room: RoomInfo;
  selfPeerId: PeerId;
}

export interface RoomPeerJoinedEvent {
  peer: PeerInfo;
}

export interface RoomPeerLeftEvent {
  peerId: PeerId;
  reason: LeaveReason;
}

export interface RoomLeftEvent {
  roomCode: RoomCode;
  reason: LeaveReason;
}

export interface RemoteOfferEvent {
  fromPeerId: PeerId;
  sessionDescription: SessionDescription;
}

export interface RemoteAnswerEvent {
  fromPeerId: PeerId;
  sessionDescription: SessionDescription;
}

export interface RemoteIceCandidateEvent {
  fromPeerId: PeerId;
  candidate: IceCandidate;
}

export interface PresenceUpdateEvent {
  peerId: PeerId;
  status: PresenceStatus;
}

export const SIGNALING_ERROR_CODES = [
  "PROTOCOL_VERSION_MISMATCH",
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "ROOM_EXPIRED",
  "ALREADY_IN_ROOM",
  "PEER_NOT_FOUND",
  "INVALID_ROOM_CODE",
  "INVALID_MESSAGE",
  "SIGNALING_TIMEOUT",
  "SERVER_ERROR",
  "RATE_LIMITED",
] as const;

export type SignalingErrorCode = (typeof SIGNALING_ERROR_CODES)[number];

export interface SignalingError {
  code: SignalingErrorCode;
  message: string;
  context?: Record<string, unknown>;
}

export interface ServerToClientSignaling {
  "room:created": (response: RoomCreatedResponse) => void;
  "room:joined": (response: RoomJoinedResponse) => void;
  "room:peer-joined": (event: RoomPeerJoinedEvent) => void;
  "room:peer-left": (event: RoomPeerLeftEvent) => void;
  "room:left": (event: RoomLeftEvent) => void;
  "peer:offer": (event: RemoteOfferEvent) => void;
  "peer:answer": (event: RemoteAnswerEvent) => void;
  "peer:ice-candidate": (event: RemoteIceCandidateEvent) => void;
  "presence:update": (event: PresenceUpdateEvent) => void;
  error: (error: SignalingError) => void;
}

// ---------------------------------------------------------------------------
// DataChannel transport
// ---------------------------------------------------------------------------

export const CONTROL_CHANNEL_LABEL = "droplink-control";
export const FILE_CHANNEL_LABEL = "droplink-file";

export type DataChannelLabel = typeof CONTROL_CHANNEL_LABEL | typeof FILE_CHANNEL_LABEL;

export interface ControlChannelConfig {
  label: typeof CONTROL_CHANNEL_LABEL;
  ordered: true;
  reliable: true;
}

export interface FileChannelConfig {
  label: typeof FILE_CHANNEL_LABEL;
  ordered: false;
  reliable: true;
}

export type DataChannelConfig = ControlChannelConfig | FileChannelConfig;

export interface CipherEnvelope {
  v: 1;
  nonce: Base64Url;
  ciphertext: Base64Url;
}

// ---------------------------------------------------------------------------
// Control messages (decrypted plaintext)
// ---------------------------------------------------------------------------

export const CONTROL_MESSAGE_KINDS = [
  "text-message",
  "text-message-ack",
  "share-mode",
  "file-start",
  "file-start-ack",
  "file-ack",
  "file-resume-req",
  "file-end",
  "file-end-ack",
  "profile-share",
] as const;

export type ControlMessageKind = (typeof CONTROL_MESSAGE_KINDS)[number];

export type TextCategory = "text" | "password" | "code";

export interface TextMessage {
  kind: "text-message";
  messageId: string;
  category: TextCategory;
  language?: string;
  text: string;
}

export interface TextMessageAck {
  kind: "text-message-ack";
  messageId: string;
}

export type ShareMode = "active" | "idle";

export interface ShareModeMessage {
  kind: "share-mode";
  mode: ShareMode;
}

export interface FileStart {
  kind: "file-start";
  fileId: FileId;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: ChunkIndex;
  fileNonce?: Base64Url;
}

export interface FileStartAck {
  kind: "file-start-ack";
  fileId: FileId;
}

export interface FileChunkAck {
  kind: "file-ack";
  fileId: FileId;
  chunkIndex: ChunkIndex;
}

export interface FileResumeRequest {
  kind: "file-resume-req";
  fileId: FileId;
  missingChunks: ChunkIndex[];
}

export interface FileChecksum {
  algorithm: "sha-256";
  hex: string;
}

export interface FileEnd {
  kind: "file-end";
  fileId: FileId;
  chunksVerified: number;
  checksum?: FileChecksum;
}

export interface FileEndAck {
  kind: "file-end-ack";
  fileId: FileId;
}

export interface ProfileShareMessage {
  kind: "profile-share";
  userId: string;
  username: string;
  /**
   * HMAC over `userId`, keyed by the room's share token. Both peers hold the
   * token, so this proves the claim was made by someone who actually has it,
   * rather than an arbitrary id asserted over the data channel.
   */
  identityProof?: string;
}

export type ControlMessage =
  | TextMessage
  | TextMessageAck
  | ShareModeMessage
  | FileStart
  | FileStartAck
  | FileChunkAck
  | FileResumeRequest
  | FileEnd
  | FileEndAck
  | ProfileShareMessage;

// ---------------------------------------------------------------------------
// Binary file chunk frame
// ---------------------------------------------------------------------------

export interface FileChunkFrame {
  fileId: FileId;
  chunkIndex: ChunkIndex;
  payload: ArrayBuffer;
}

export const FILE_CHUNK_HEADER_OFFSET = 0;
export const FILE_CHUNK_INDEX_OFFSET = 4;
export const FILE_CHUNK_PAYLOAD_OFFSET = 8;

// ---------------------------------------------------------------------------
// Share link and key derivation
// ---------------------------------------------------------------------------

export interface JoinShareLink {
  protocol: 1;
  roomCode: RoomCode;
  shareToken: Base64Url;
}

export interface RoomKeySpec {
  shareToken: Base64Url;
  salt: string;
  info: string;
  keyBytes: number;
}