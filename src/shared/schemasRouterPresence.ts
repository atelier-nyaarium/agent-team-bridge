import { z } from "zod";
import { CrossDomainPresenceSessionSchema, MAX_CROSSDOMAIN_PRESENCE_SESSIONS } from "./federation-protocol.js";
import { DiscoverCoverageSchema } from "./schemasConsoleResults.js";
import { CrossDomainPresenceEntrySchema, GatewaySpawnPointsSchema, TeamInfoSchema } from "./schemasPresence.js";

export const PresenceBaselineParamsSchema = z
	.object({
		incarnation: z.number().int().positive(),
		seq: z.literal(0),
		rows: z.array(TeamInfoSchema),
		spawnPoints: GatewaySpawnPointsSchema,
	})
	.meta({ id: "PresenceBaselineParams" });

export const PresenceDeltaParamsSchema = z
	.object({
		incarnation: z.number().int().positive(),
		seq: z.number().int().min(1),
		upserts: z.array(TeamInfoSchema),
		tombstones: z.array(z.string()),
	})
	.meta({ id: "PresenceDeltaParams" });

export const PresenceResyncFrameSchema = z
	.object({ type: z.literal("presence_resync"), incarnation: z.number().int().positive() })
	.meta({ id: "PresenceResyncFrame" });

export const RosterEntrySchema = z
	.object({
		gatewayId: z.string(),
		connected: z.boolean(),
		incarnation: z.number().int().nonnegative(),
		lastRegisteredAt: z.number().int().nonnegative(),
	})
	.meta({ id: "RosterEntry" });

export const PresencePlaneSchema = z
	.object({ epoch: z.number().int().positive(), version: z.number().int().nonnegative() })
	.meta({ id: "PresencePlane" });

export const OwnerPresenceProjectionSchema = z
	.object({
		plane: PresencePlaneSchema,
		rows: z.array(TeamInfoSchema),
		linked: z.array(CrossDomainPresenceEntrySchema),
		roster: z.array(RosterEntrySchema),
		coverage: DiscoverCoverageSchema,
		spawnPoints: z.array(GatewaySpawnPointsSchema),
	})
	.meta({ id: "OwnerPresenceProjection" });

export const FriendPresenceProjectionSchema = z
	.object({
		plane: PresencePlaneSchema,
		sessions: z.array(CrossDomainPresenceSessionSchema).max(MAX_CROSSDOMAIN_PRESENCE_SESSIONS),
	})
	.meta({ id: "FriendPresenceProjection" });
