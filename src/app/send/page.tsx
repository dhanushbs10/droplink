"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Copy, FileDown, Link2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

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
  type FileChunkFrame,
  type FileStart,
  type RoomCode,
} from "@/lib/types/protocol";

/**
 * Build the share link against the origin that is actually serving the page.
 * A build-time NEXT_PUBLIC_SITE_URL can be unset or stale (pointing at a domain
 * this deployment does not own), which produces share links that dead-end for
 * the receiver. window.location is authoritative at runtime, so prefer it and
 * fall back to the env value only during SSR.
 */
function resolveSiteUrl(): string {
  if (typeof window !== "undefined" && window.location.origin) {
    return window.location.origin;
  }
  return process.env.NEXT_PUBLIC_SITE_URL ?? "https://droplink1.vercel.app";
}

type Status =
  | "idle"
  | "starting"
  | "waiting"
  | "connected"
  | "sending"
  | "receiving"
  | "paused"
  | "reconnecting"
  | "complete"
  | "error";

const STATUS_LABEL: Record<Status, string> = {
  idle: "Ready",
  starting: "Initializing room...",
  waiting: "Waiting for receiver...",
  connected: "Connected",
  sending: "Sending...",
  receiving: "Receiving...",
  paused: "Transfer paused",
  reconnecting: "Reconnecting...",
  complete: "Transfer complete",
  error: "Something went wrong",
};

function StatusDot({ status }: { status: Status }) {
  const color =
    status === "connected" || status === "complete"
      ? "bg-zinc-300"
      : status === "sending" ||
          status === "receiving" ||
          status === "waiting" ||
          status === "starting" ||
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

function RoomPanel({
  roomCode,
  shareLink,
  copied,
  copiedCode,
  onCopyRoomCode,
  onCopyShareLink,
}: {
  roomCode: RoomCode;
  shareLink: string;
  copied: boolean;
  copiedCode: boolean;
  onCopyRoomCode: () => void;
  onCopyShareLink: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
            Room code
          </span>
          <span className="mt-3 break-all font-mono text-4xl font-semibold tracking-[0.15em] text-zinc-100 sm:text-5xl">
            {roomCode}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {shareLink && (
            <div
              title="Scan to join"
              className="flex shrink-0 rounded-[4px] border border-zinc-800 bg-zinc-950 p-2"
            >
              <QRCodeSVG
                value={shareLink}
                size={128}
                level="M"
                bgColor="#09090b"
                fgColor="#f4f4f5"
                marginSize={1}
              />
            </div>
          )}
          <Button
            size="sm"
            onClick={onCopyRoomCode}
            className="gap-2 rounded-[4px]"
          >
            {copiedCode ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {copiedCode ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
          Share link
        </span>
        <div className="flex items-center gap-2 rounded-[4px] border border-zinc-800 bg-zinc-950 py-1.5 pl-3 pr-1.5">
          <input
            readOnly
            value={shareLink ?? ""}
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-zinc-400 outline-none"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={onCopyShareLink}
            className="shrink-0 gap-2 rounded-[4px]"
          >
            {copied ? (
              <Check className="h-4 w-4" />
            ) : (
              <Link2 className="h-4 w-4" />
            )}
            {copied ? "Copied" : "Copy Link"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function SendPage() {
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
  const [roomCode, setRoomCode] = useState<RoomCode | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [incoming, setIncoming] = useState<{
    fileName: string;
    fileSize: number;
    progress: number;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [channelsOpen, setChannelsOpen] = useState({
    [CONTROL_CHANNEL_LABEL]: false,
    [FILE_CHANNEL_LABEL]: false,
  });
  const [receivedCount, setReceivedCount] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);

  const connected = channelsOpen[CONTROL_CHANNEL_LABEL];
  const effectiveStatus: Status = reconnecting
    ? "reconnecting"
    : (status === "idle" ||
        status === "starting" ||
        status === "waiting") &&
        connected
      ? "connected"
      : status;

  useEffect(() => {
    if (controllerRef.current) return;
    let disposed = false;
    const meta = metaRef.current;
    const chunks = chunkStoreRef.current;
    const bytes = bytesRef.current;
    const receivedChunks = receivedChunksRef.current;

    const setup = async () => {
      try {
        const signaling = initializeSignaling();
        const controller = new RoomController({
          signaling,
          onDataChannelOpen: (label) => {
            setChannelsOpen((prev) => ({ ...prev, [label]: true }));
            if (label === CONTROL_CHANNEL_LABEL && controllerRef.current) {
              void shareProfile(controllerRef.current);
            }
          },
          onDataChannelClosed: (label) =>
            setChannelsOpen((prev) => ({ ...prev, [label]: false })),
          onControlMessage: (message) => {
            if (message.kind === "file-start") {
              meta.set(message.fileId, message);
              bytes.set(message.fileId, 0);
              setIncoming({
                fileName: message.fileName,
                fileSize: message.fileSize,
                progress: 0,
              });
              setStatus("receiving");
            } else if (message.kind === "file-end") {
              const entry = meta.get(message.fileId);
              const byFile = chunks.get(message.fileId);
              const receivedChunks =
                receivedChunksRef.current.get(message.fileId) ??
                new Set<number>();
              const acquiredBytes = bytes.get(message.fileId) ?? 0;
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
                chunks.delete(message.fileId);
                meta.delete(message.fileId);
                bytes.delete(message.fileId);
                receivedChunksRef.current.delete(message.fileId);
                setIncoming((prev) =>
                  prev ? { ...prev, progress: 100 } : prev
                );
              } else {
                setErrorMessage(
                  "The transfer was incomplete. Ask the peer to resume or resend the file."
                );
              }
            }
          },
          onChunkReceived: (frame: FileChunkFrame) => {
            const metaEntry = meta.get(frame.fileId);
            if (metaEntry && frame.chunkIndex >= metaEntry.totalChunks) {
              return;
            }
            let byFile = chunks.get(frame.fileId);
            if (!byFile) {
              byFile = new Map();
              chunks.set(frame.fileId, byFile);
            }
            byFile.set(frame.chunkIndex, new Uint8Array(frame.payload));

            let receivedChunks = receivedChunksRef.current.get(frame.fileId);
            if (!receivedChunks) {
              receivedChunks = new Set();
              receivedChunksRef.current.set(frame.fileId, receivedChunks);
            }
            receivedChunks.add(frame.chunkIndex);

            const previous = bytes.get(frame.fileId) ?? 0;
            const updated = previous + frame.payload.byteLength;
            bytes.set(frame.fileId, updated);

            controllerRef.current?.sendControlMessage({
              kind: "file-ack",
              fileId: frame.fileId,
              chunkIndex: frame.chunkIndex,
            });

            const entry = meta.get(frame.fileId);
            if (entry) {
              setIncoming((prev) =>
                prev
                  ? {
                      ...prev,
                      progress: Math.min(
                        100,
                        Math.round(
                          entry.fileSize === 0
                            ? 100
                            : (updated / entry.fileSize) * 100
                        )
                      ),
                    }
                  : prev
              );
            }
          },
          onConnectionFailed: (reason) => {
            setErrorMessage(
              `${reason}. The link dropped before the transfer could start; create a new room and retry.`
            );
            setStatus("error");
          },
          onReconnecting: () => setReconnecting(true),
          onReconnected: () => setReconnecting(false),
          onInternalError: (error) => {
            if (!disposed) {
              setErrorMessage(error.message);
            }
          },
          onError: (error) => setErrorMessage(error.message),
        });
        if (disposed) {
          controller.disconnect();
          return;
        }
        controllerRef.current = controller;
        setActiveController(controller);
      } catch (error) {
        if (!disposed) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Failed to start the signaling session"
          );
          setStatus("error");
        }
      }
    };

    void setup();

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
  }, []);

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

  const initializeRoom = async () => {
    const controller = controllerRef.current;
    if (!controller) return;
    setStatus("starting");
    setErrorMessage(null);
    try {
      const initiated = await controller.initiateRoom();
      setRoomCode(initiated.roomCode);
      setShareLink(
        `${resolveSiteUrl()}/receive#!/join/${initiated.roomCode}?t=${initiated.shareToken}`
      );
      setStatus("waiting");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Failed to initialize the room"
      );
      setStatus("error");
    }
  };

  const copyShareLink = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErrorMessage("Could not write to the clipboard");
    }
  };

  const copyRoomCode = async () => {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      setErrorMessage("Could not write to the clipboard");
    }
  };

  return (
    <div className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 pb-24 pt-12 sm:px-8 sm:pt-16">
      <BackgroundOne />
      <Grain />

      <div className="flex items-start justify-between gap-6">
        <h1 className="text-5xl font-semibold tracking-[-0.03em] text-zinc-100 sm:text-6xl">
          Send
        </h1>
        <div className="inline-flex h-8 shrink-0 items-center gap-2 rounded-[4px] border border-zinc-800 bg-zinc-900/60 px-3 font-mono text-[11px] uppercase tracking-wider text-zinc-300">
          <StatusDot status={effectiveStatus} />
          {STATUS_LABEL[effectiveStatus]}
        </div>
      </div>
      <p className="mt-4 max-w-md text-base text-zinc-400">
        Initialize a room, share the link, and transfer files directly.
      </p>

      <div className="mt-12 flex w-full flex-col gap-10">
        {!roomCode ? (
          <section className="border-t border-zinc-800 py-10">
            <SectionHead title="Room" />
            <div className="mt-7 sm:pl-10">
              <Button
                size="lg"
                disabled={status === "starting"}
                onClick={() => void initializeRoom()}
                className="rounded-[4px]"
              >
                Initialize Room
                <ArrowRight className="h-4 w-4" />
              </Button>
              <p className="mt-4 max-w-sm text-sm text-zinc-500">
                Creates an 8-character room code and a share link for the
                receiver.
              </p>
            </div>
          </section>
        ) : connected && activeController ? (
          <div className="flex w-full flex-col lg:flex-row lg:items-start lg:gap-0">
            <div className="flex min-w-0 flex-1 flex-col">
              <section className="border-t border-zinc-800 py-10">
                <SectionHead title="Room" />
                <div className="mt-7 sm:pl-10">
                  <RoomPanel
                    roomCode={roomCode}
                    shareLink={shareLink ?? ""}
                    copied={copied}
                    copiedCode={copiedCode}
                    onCopyRoomCode={() => void copyRoomCode()}
                    onCopyShareLink={() => void copyShareLink()}
                  />
                </div>
              </section>

              <section className="border-t border-zinc-800 py-10">
                <SectionHead title="Share" />
                <div className="mt-7 sm:pl-10">
                  <ShareDashboard controller={activeController} />
                </div>
              </section>

              {incoming && (
                <section className="border-t border-zinc-800 py-10">
                  <SectionHead title="Received" />
                  <div className="mt-7 sm:pl-10">
                    <div className="flex w-full flex-col gap-3">
                      <div className="flex items-center justify-between gap-4">
                        <span className="flex min-w-0 items-center gap-2">
                          <FileDown className="h-4 w-4 shrink-0 text-zinc-400" />
                          <span className="truncate font-mono text-sm text-zinc-200">
                            {incoming.fileName}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-xs text-zinc-500">
                          {incoming.progress}%
                        </span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-[2px] bg-zinc-800">
                        <div
                          className="h-full rounded-[2px] bg-zinc-300 transition-[width] duration-200"
                          style={{ width: `${incoming.progress}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </section>
              )}
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
        ) : (
          <div className="flex w-full flex-col">
            <section className="border-t border-zinc-800 py-10">
              <SectionHead title="Room" />
              <div className="mt-7 sm:pl-10">
                <RoomPanel
                  roomCode={roomCode}
                  shareLink={shareLink ?? ""}
                  copied={copied}
                  copiedCode={copiedCode}
                  onCopyRoomCode={() => void copyRoomCode()}
                  onCopyShareLink={() => void copyShareLink()}
                />
              </div>
            </section>
            <section className="border-t border-zinc-800 py-10">
              <SectionHead title="Share" />
              <div className="mt-7 sm:pl-10">
                <div className="flex w-full flex-col items-center gap-4 rounded-[6px] border border-zinc-800 bg-zinc-950 px-6 py-14 text-center">
                  <p className="font-mono text-sm uppercase tracking-[0.25em] text-zinc-300">
                    Waiting for the receiver
                  </p>
                  <p className="max-w-sm text-sm text-zinc-500">
                    Share the code and link above. Text, passwords, code, and
                    files become available once the peer joins.
                  </p>
                </div>
              </div>
            </section>
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