"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileDown } from "lucide-react";

import { BackgroundOne } from "@/components/backgrounds/BackgroundOne";
import { Button } from "@/components/ui/button";
import { Grain } from "@/components/landing/grain";
import ShareDashboard, { ReceivedMessages } from "@/components/share-dashboard";
import { rememberPeer, shareProfile } from "@/lib/supabase/buddies";
import { RoomController } from "@/lib/webrtc/room-controller";
import { initializeSignaling } from "@/lib/webrtc/signaling-client";
import {
  CONTROL_CHANNEL_LABEL,
  FILE_CHANNEL_LABEL,
  ROOM_CODE_PATTERN,
  type Base64Url,
  type FileChunkFrame,
  type FileStart,
  type RoomCode,
} from "@/lib/types/protocol";

type Status =
  | "idle"
  | "connecting"
  | "connected"
  | "receiving"
  | "sending"
  | "paused"
  | "reconnecting"
  | "complete"
  | "error";

const STATUS_LABEL: Record<Status, string> = {
  idle: "No share link",
  connecting: "Connecting to peer...",
  connected: "Connected",
  receiving: "Receiving...",
  sending: "Sending...",
  paused: "Transfer paused",
  reconnecting: "Reconnecting...",
  complete: "Transfer complete",
  error: "Something went wrong",
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function parseJoinHash(hash: string): {
  roomCode: RoomCode;
  shareToken: Base64Url;
} | null {
  if (!hash.startsWith("#!/join/")) return null;
  const raw = hash.slice("#!/join/".length);
  const tokenIndex = raw.indexOf("?t=");
  if (tokenIndex === -1) return null;
  const roomCode = raw.slice(0, tokenIndex);
  const shareToken = raw.slice(tokenIndex + 3);
  if (!ROOM_CODE_PATTERN.test(roomCode)) return null;
  if (!SHARE_TOKEN_PATTERN.test(shareToken)) return null;
  return {
    roomCode: roomCode as RoomCode,
    shareToken: shareToken as Base64Url,
  };
}

const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function parseShareInput(input: string): {
  roomCode: RoomCode;
  shareToken: Base64Url;
} | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let hash: string;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    const allowedHosts = new Set<string>(["localhost"]);
    if (typeof window !== "undefined") {
      allowedHosts.add(window.location.host.toLowerCase());
      allowedHosts.add(window.location.hostname.toLowerCase());
    }
    const isAllowed =
      allowedHosts.has(hostname) ||
      hostname.endsWith(".vercel.app");
    if (!isAllowed) return null;
    hash = url.hash;
  } catch {
    hash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  }
  return parseJoinHash(hash);
}

function StatusDot({ status }: { status: Status }) {
  const color =
    status === "connected" || status === "complete"
      ? "bg-zinc-300"
      : status === "receiving" ||
          status === "sending" ||
          status === "connecting" ||
          status === "reconnecting"
        ? "bg-zinc-400"
        : "bg-zinc-600";
  return <span className={`h-1.5 w-1.5 rounded-[1px] ${color}`} />;
}

function SectionHead({ title }: { title: string }) {
  return (
    <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 sm:text-3xl">
      {title}
    </h2>
  );
}

export default function ReceivePage() {
  const controllerRef = useRef<RoomController | null>(null);
  const [activeController, setActiveController] =
    useState<RoomController | null>(null);

  const metaRef = useRef<Map<number, FileStart>>(new Map());
  const chunkStoreRef = useRef<Map<number, Map<number, Uint8Array<ArrayBuffer>>>>(
    new Map()
  );
  const bytesRef = useRef<Map<number, number>>(new Map());
  const receivedChunksRef = useRef<Map<number, Set<number>>>(new Map());

  const [status, setStatus] = useState<Status>("idle");
  const [fileName, setFileName] = useState<string | null>(null);
  const [totalFileSize, setTotalFileSize] = useState(0);
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [channelsOpen, setChannelsOpen] = useState({
    [CONTROL_CHANNEL_LABEL]: false,
    [FILE_CHANNEL_LABEL]: false,
  });
  const [receivedCount, setReceivedCount] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [showLinkInput, setShowLinkInput] = useState(false);

  const connected = channelsOpen[CONTROL_CHANNEL_LABEL];
  const effectiveStatus: Status = reconnecting
    ? "reconnecting"
    : (status === "idle" || status === "connecting") && connected
      ? "connected"
      : status;
  const showJoinPanel = status === "idle" || status === "error";

  const startJoin = useCallback(
    async (
      roomCode: RoomCode,
      shareToken?: Base64Url,
      isDisposed: () => boolean = () => false,
    ) => {
      const previous = controllerRef.current;
      if (previous) {
        previous.disconnect();
        controllerRef.current = null;
      }

      const signaling = initializeSignaling();

      const requestResume = async (): Promise<void> => {
        const client = controllerRef.current;
        if (!client || !client.isFileChannelOpen()) return;
        let target: { fileId: number; totalChunks: number } | null = null;
        for (const [fileId, entry] of metaRef.current) {
          const acquired = receivedChunksRef.current.get(fileId)?.size ?? 0;
          if (acquired < entry.totalChunks) {
            if (!target || fileId > target.fileId) {
              target = { fileId, totalChunks: entry.totalChunks };
            }
          }
        }
        if (!target) return;
        const acquired =
          receivedChunksRef.current.get(target.fileId) ?? new Set<number>();
        const missingChunks: number[] = [];
        for (let index = 0; index < target.totalChunks; index += 1) {
          if (!acquired.has(index)) missingChunks.push(index);
        }
        for (let index = 0; index < missingChunks.length; index += 2000) {
          const batch = missingChunks.slice(index, index + 2000);
          await client.sendControlMessage({
            kind: "file-resume-req",
            fileId: target.fileId,
            missingChunks: batch,
          });
        }
        setStatus("receiving");
        setErrorMessage(null);
      };

      const controller = new RoomController({
        signaling,
        onDataChannelOpen: (label) => {
          setChannelsOpen((prev) => ({ ...prev, [label]: true }));
          if (label === CONTROL_CHANNEL_LABEL) {
            queueMicrotask(() => void requestResume());
            if (controllerRef.current) {
              void shareProfile(controllerRef.current);
            }
          }
        },
        onDataChannelClosed: (label) => {
          setChannelsOpen((prev) => ({ ...prev, [label]: false }));
          if (metaRef.current.size > 0) {
            setStatus("paused");
          }
        },
        onControlMessage: (message) => {
          if (message.kind === "file-start") {
            metaRef.current.set(message.fileId, message);
            bytesRef.current.set(message.fileId, 0);
            setFileName(message.fileName);
            setTotalFileSize(message.fileSize);
            setProgress(0);
            setStatus("receiving");
          } else if (message.kind === "file-end") {
            const entry = metaRef.current.get(message.fileId);
            const byFile = chunkStoreRef.current.get(message.fileId);
            const receivedChunks =
              receivedChunksRef.current.get(message.fileId) ?? new Set<number>();
            const acquiredBytes = bytesRef.current.get(message.fileId) ?? 0;
            if (
              entry &&
              byFile &&
              receivedChunks.size === entry.totalChunks &&
              acquiredBytes === entry.fileSize
            ) {
              const parts: BlobPart[] = [];
              for (let i = 0; i < entry.totalChunks; i += 1) {
                const chunk = byFile.get(i);
                if (chunk) parts.push(chunk);
              }
              const blob = new Blob(parts, { type: entry.mimeType });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = entry.fileName;
              anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              chunkStoreRef.current.delete(message.fileId);
              metaRef.current.delete(message.fileId);
              bytesRef.current.delete(message.fileId);
              receivedChunksRef.current.delete(message.fileId);
              setStatus("complete");
            } else {
              setErrorMessage(
                "The transfer was incomplete. Ask the sender to resume or resend the file."
              );
              setStatus("error");
            }
          }
        },
        onChunkReceived: (frame: FileChunkFrame) => {
          const metaEntry = metaRef.current.get(frame.fileId);
          if (metaEntry && frame.chunkIndex >= metaEntry.totalChunks) {
            return;
          }
          let byFile = chunkStoreRef.current.get(frame.fileId);
          if (!byFile) {
            byFile = new Map();
            chunkStoreRef.current.set(frame.fileId, byFile);
          }
          byFile.set(frame.chunkIndex, new Uint8Array(frame.payload));

          let receivedChunks = receivedChunksRef.current.get(frame.fileId);
          if (!receivedChunks) {
            receivedChunks = new Set();
            receivedChunksRef.current.set(frame.fileId, receivedChunks);
          }
          receivedChunks.add(frame.chunkIndex);

          const previous = bytesRef.current.get(frame.fileId) ?? 0;
          const updated = previous + frame.payload.byteLength;
          bytesRef.current.set(frame.fileId, updated);

          controllerRef.current?.sendControlMessage({
            kind: "file-ack",
            fileId: frame.fileId,
            chunkIndex: frame.chunkIndex,
          });

          const entry = metaRef.current.get(frame.fileId);
          if (entry) {
            setProgress(
              Math.min(
                100,
                Math.round(
                  entry.fileSize === 0
                    ? 100
                    : (updated / entry.fileSize) * 100
                )
              )
            );
          }
        },
        onError: (error) => {
          if (!isDisposed()) {
            setErrorMessage(error.message);
            setStatus("error");
          }
        },
        onReconnecting: () => setReconnecting(true),
        onReconnected: () => setReconnecting(false),
        onInternalError: (error) => {
          if (!isDisposed()) {
            setErrorMessage(error.message);
          }
        },
        onConnectionFailed: (reason) => {
          if (!isDisposed()) {
            setErrorMessage(
              `${reason}. Ask the sender to create a new room and resend this link.`,
            );
            setStatus("error");
          }
        },
      });
      controllerRef.current = controller;
      setActiveController(controller);

      setStatus("connecting");
      setErrorMessage(null);
      try {
        await controller.joinRoom(roomCode, shareToken);
      } catch (error) {
        if (!isDisposed()) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Failed to connect to the signaling server",
          );
          setStatus("error");
        }
      }
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    const meta = metaRef.current;
    const chunks = chunkStoreRef.current;
    const bytes = bytesRef.current;
    const receivedChunks = receivedChunksRef.current;
    const parsed = parseJoinHash(window.location.hash);
    if (parsed) {
      const { roomCode, shareToken } = parsed;
      queueMicrotask(() => void startJoin(roomCode, shareToken, () => disposed));
    }
    return () => {
      disposed = true;
      controllerRef.current?.disconnect();
      controllerRef.current = null;
      setActiveController(null);
      meta.clear();
      chunks.clear();
      bytes.clear();
      receivedChunks.clear();
    };
  }, [startJoin]);

  useEffect(() => {
    if (!activeController) return;
    return activeController.onMessage((message) => {
      if (message.kind === "text-message") {
        setReceivedCount((prev) => prev + 1);
      } else if (message.kind === "profile-share") {
        void rememberPeer(activeController, message);
      }
    });
  }, [activeController]);

  const joinByCode = () => {
    const code = codeInput.trim();
    if (!ROOM_CODE_PATTERN.test(code)) {
      setErrorMessage(
        "That room code is not valid. Codes are 8 characters made up of letters and numbers."
      );
      return;
    }
    void startJoin(code as RoomCode);
  };

  const joinFromInput = () => {
    const parsed = parseShareInput(linkInput);
    if (!parsed) {
      setErrorMessage(
        "That link does not contain a valid room code and share token. Paste the full link, including everything after the hash."
      );
      return;
    }
    void startJoin(parsed.roomCode, parsed.shareToken);
  };

  return (
    <div className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 pb-24 pt-12 sm:px-8 sm:pt-16">
      <BackgroundOne />
      <Grain />

      <div className="flex items-start justify-between gap-6">
        <h1 className="text-5xl font-semibold tracking-[-0.03em] text-zinc-100 sm:text-6xl">
          Receive
        </h1>
        <div className="inline-flex h-8 shrink-0 items-center gap-2 rounded-[4px] border border-zinc-800 bg-zinc-900/60 px-3 font-mono text-[11px] uppercase tracking-wider text-zinc-300">
          <StatusDot status={effectiveStatus} />
          {STATUS_LABEL[effectiveStatus]}
        </div>
      </div>
      <p className="mt-4 max-w-md text-base text-zinc-400">
        Enter the room code to start receiving files, or send one back while
        connected.
      </p>

      <div className="mt-12 flex w-full flex-col gap-10">
        {showJoinPanel && (
          <section className="border-t border-zinc-800 py-10">
            <SectionHead title="Join" />
            <div className="mt-7 sm:pl-10">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  joinByCode();
                }}
                className="flex w-full flex-col gap-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    id="room-code-input"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={codeInput}
                    onChange={(e) =>
                      setCodeInput(
                        e.target.value
                          .replace(/[^a-zA-Z0-9]/g, "")
                          .toUpperCase()
                          .slice(0, 8)
                      )
                    }
                    placeholder="e.g. 7QKDLX2P"
                    className="h-12 flex-1 rounded-[4px] border border-zinc-800 bg-zinc-950 px-4 font-mono text-lg uppercase tracking-[0.2em] text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-600"
                  />
                  <Button
                    type="submit"
                    size="lg"
                    className="h-12 rounded-[4px]"
                    disabled={codeInput.trim().length < 8}
                  >
                    Join
                  </Button>
                </div>
                <p className="text-xs text-zinc-500">
                  Ask the sender for the room code shown on their screen.
                </p>
              </form>

              <div className="mt-6 border-t border-zinc-800 pt-5">
                <button
                  type="button"
                  onClick={() => setShowLinkInput((value) => !value)}
                  className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500 transition-colors hover:text-zinc-200"
                >
                  {showLinkInput
                    ? "Hide link entry"
                    : "Join with a share link instead"}
                </button>
                {showLinkInput && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      joinFromInput();
                    }}
                    className="mt-4 flex flex-col gap-2 sm:flex-row"
                  >
                    <input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={linkInput}
                      onChange={(e) => setLinkInput(e.target.value)}
                      placeholder={`${typeof window !== "undefined" ? window.location.origin : "https://droplink1.vercel.app"}/receive#!/join/...`}
                      className="h-10 flex-1 rounded-[4px] border border-zinc-800 bg-zinc-950 px-3 font-mono text-sm text-zinc-200 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-600"
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      size="lg"
                      className="rounded-[4px]"
                      disabled={linkInput.trim().length === 0}
                    >
                      Join
                    </Button>
                  </form>
                )}
              </div>
            </div>
          </section>
        )}

        {!showJoinPanel && !connected && (
          <section className="border-t border-zinc-800 py-10">
            <SectionHead title="Connect" />
            <div className="mt-7 sm:pl-10">
              <p className="font-mono text-sm uppercase tracking-[0.25em] text-zinc-400">
                Connecting to peer...
              </p>
            </div>
          </section>
        )}

        {connected && activeController && (
          <div className="flex w-full flex-col lg:flex-row lg:items-start lg:gap-0">
            <div className="flex min-w-0 flex-1 flex-col">
              {fileName &&
              (status === "receiving" ||
                status === "complete" ||
                progress > 0) && (
                <section className="border-t border-zinc-800 py-10">
                  <SectionHead title="Receive" />
                  <div className="mt-7 sm:pl-10">
                    <div className="flex w-full flex-col gap-3">
                      <div className="flex items-center justify-between gap-4">
                        <span className="flex min-w-0 items-center gap-2">
                          <FileDown className="h-4 w-4 shrink-0 text-zinc-400" />
                          <span className="truncate font-mono text-sm text-zinc-200">
                            {fileName}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-xs text-zinc-500">
                          {formatBytes(totalFileSize)} {" / "} {progress}%
                        </span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-[2px] bg-zinc-800">
                        <div
                          className="h-full rounded-[2px] bg-zinc-300 transition-[width] duration-200"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </section>
              )}

              <section className="border-t border-zinc-800 py-10">
                <SectionHead title="Share" />
                <div className="mt-7 sm:pl-10">
                  <ShareDashboard controller={activeController} />
                </div>
              </section>
            </div>

            <div
              className={`w-full shrink-0 lg:w-[22rem] ${
                receivedCount === 0 ? "hidden" : ""
              }`}
            >
              <div className="flex w-full flex-col border-t border-zinc-800 py-10 lg:border-l lg:border-t-0 lg:py-0 lg:pl-10">
                <ReceivedMessages controller={activeController} />
              </div>
            </div>
          </div>
        )}

        {errorMessage && (
          <p className="w-full rounded-[6px] border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-400">
            {errorMessage}
          </p>
        )}
      </div>
    </div>
  );
}