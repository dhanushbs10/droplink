import type { User } from "@supabase/supabase-js";

import { getSupabase } from "@/lib/supabase/client";
import type { ProfileShareMessage } from "@/lib/types/protocol";
import type { RoomController } from "@/lib/webrtc/room-controller";

export interface Buddy {
  buddyId: string;
  username: string;
  roomCode: string | null;
  lastConnected: string;
}

const FALLBACK_USERNAME_PREFIX = "user_";

export function formatRelative(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!value || Number.isNaN(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return pluralize(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return pluralize(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return pluralize(days, "day");
  const months = Math.floor(days / 30);
  return pluralize(months, "month");
}

function pluralize(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

export async function getSelfUsername(
  userId?: string
): Promise<{ userId: string; username: string } | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const authUserId = userId ?? (await supabase.auth.getUser()).data.user?.id;
  if (!authUserId) return null;

  const { data } = await supabase
    .from("profiles")
    .select("username")
    .eq("id", authUserId)
    .maybeSingle();
  const username =
    typeof data?.username === "string" && data.username.length > 0
      ? data.username
      : `${FALLBACK_USERNAME_PREFIX}${authUserId.slice(0, 8)}`;
  return { userId: authUserId, username };
}

export async function shareProfile(controller: RoomController): Promise<void> {
  const self = await getSelfUsername();
  if (!self) return;
  const identityProof = await controller.createIdentityProof(self.userId);
  await controller.sendControlMessage({
    kind: "profile-share",
    userId: self.userId,
    username: self.username,
    identityProof: identityProof ?? undefined,
  });
}

export async function rememberPeer(
  controller: RoomController,
  message: ProfileShareMessage
): Promise<void> {
  const self = await getSelfUsername();
  if (!self) return;
  if (!message.userId || !message.username) return;
  if (message.userId === self.userId) return;

  // The peer-asserted userId is only trustworthy if it is bound to the room's
  // share token. Without this check anyone in the room could claim to be any
  // existing user and forge a connection history.
  const expectedProof = await controller.createIdentityProof(message.userId);
  if (!expectedProof || message.identityProof !== expectedProof) {
    console.warn("Ignored an unverified profile-share from the peer.");
    return;
  }

  const roomCode = controller.getRoom()?.roomCode ?? null;
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase
    .from("buddies")
    .upsert(
      {
        user_id: self.userId,
        buddy_id: message.userId,
        room_code: roomCode,
        last_connected: new Date().toISOString(),
      },
      { onConflict: "user_id,buddy_id" }
    );
  if (error) {
    console.error("Failed to remember buddy:", error.message);
  }
}

export async function fetchRecentBuddies(): Promise<{
  user: User | null;
  buddies: Buddy[];
}> {
  const supabase = getSupabase();
  if (!supabase) return { user: null, buddies: [] };
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return { user: null, buddies: [] };

  const { data: rows, error } = (await supabase
    .from("buddies")
    .select(
      "buddy_id, room_code, last_connected, profiles!buddies_buddy_id_fkey(username)"
    )
    .order("last_connected", { ascending: false })
    .limit(20)) as unknown as {
    data: BuddyRow[] | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("Failed to fetch buddies:", error.message);
    return { user, buddies: [] };
  }

  const buddies: Buddy[] = (rows ?? []).flatMap((row) => {
    const username = Array.isArray(row.profiles)
      ? row.profiles[0]?.username
      : row.profiles?.username;
    if (!row.buddy_id || !username) return [];
    return [
      {
        buddyId: row.buddy_id,
        username,
        roomCode: row.room_code ?? null,
        lastConnected: row.last_connected,
      },
    ];
  });

  return { user, buddies };
}

interface BuddyRow {
  buddy_id: string;
  room_code: string | null;
  last_connected: string;
  profiles: { username: string } | { username: string }[] | null;
}