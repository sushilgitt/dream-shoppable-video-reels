import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { refreshExpiringTokens } from "../lib/instagram-sync.server";
import {
  reapStalledUploads,
  reconcileProcessingVideos,
} from "../lib/video.server";

/**
 * Scheduled maintenance. Point a daily cron at:
 *   POST /api/cron/instagram-refresh
 *   Authorization: Bearer $CRON_SECRET
 *
 * Instagram long-lived tokens last 60 days and can only be renewed while still
 * valid. Once one lapses there is no recovery — the merchant must reconnect by
 * hand — so this has to run unattended rather than relying on someone opening
 * the app.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || secret.startsWith("CHANGEME")) {
    // Refuse rather than run unauthenticated: this endpoint enumerates and
    // mutates every connected shop.
    return new Response("Cron is not configured", { status: 503 });
  }

  const provided = (request.headers.get("Authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const tokens = await refreshExpiringTokens();

  // Reconcile before reaping, and never the other way round. Reaping fails
  // every UPLOADING row past its cutoff without asking Bunny anything, so
  // running it first would mark a video whose bytes arrived and encoded
  // cleanly as "Upload did not complete" — and reconcile, which would have
  // promoted it, then finds nothing left in UPLOADING to promote.
  const reconciled = await reconcileProcessingVideos();
  const reaped = await reapStalledUploads();

  return Response.json({
    ok: true,
    instagramTokensRefreshed: tokens.refreshed,
    instagramTokensFailed: tokens.failed,
    stalledUploadsReaped: reaped,
    videosPromoted: reconciled.promoted,
    videosFailed: reconciled.failed,
    videosStillProcessing: reconciled.pending,
  });
};

export const loader = () => new Response("Method not allowed", { status: 405 });
