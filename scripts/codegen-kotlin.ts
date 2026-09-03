// Generates committed Kotlin types from src/shared schemas.
// Run: bun scripts/codegen-kotlin.ts
// Encode unions use sealed classes. Decode unions stay open.
// Non-discriminated unions emit JsonElement.
// Integers emit Long. Optionals emit nullable types.
// JSON Schema uses io:"input" and .meta ids.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
	AdmissionSchema,
	RevocationSchema,
	SignedAdmissionSchema,
	SignedRevocationSchema,
} from "../src/shared/admission.js";
import { CONSOLE_PROTOCOL_VERSION } from "../src/shared/console-protocol.js";
import {
	ConsoleApprovalOpSchema,
	ConsoleApprovalResultSchema,
	EnrollHandshakeOpSchema,
	EnrollHandshakeResultSchema,
	EnrollOpSchema,
	EnrollResultSchema,
	PendingTenantSchema,
	RosterRequestSchema,
	RosterResultSchema,
	TransportRequestSchema,
	TransportResultSchema,
	TrustHandshakeOpSchema,
	TrustHandshakeResultSchema,
	TrustPendingRequestSchema,
	TrustPendingResultSchema,
} from "../src/shared/federation-lifecycle.js";
import { SignedXDomainUntrustSchema } from "../src/shared/federation-protocol.js";
import { BLOB_CHUNK_BYTES, MAX_BLOB_BYTES } from "../src/shared/router-protocol.js";
import {
	BOARD_ATTACHMENTS_MAX,
	BOARD_AUTO_DOWNLOAD_MAX_BYTES,
	ChannelFileSchema,
	ConsoleListTeamsResultSchema,
	ConsoleOpEnvelopeSchema,
	ConsoleOpSchema,
	ConsolePeekResultSchema,
	ConsolePollResultSchema,
	ConsoleRegisterResultSchema,
	ConsoleRelayFrameSchema,
	ConsoleRelayReplySchema,
	ConsoleReplyBodySchema,
	ConsoleRespondResultSchema,
	ConsoleSendResultSchema,
	ConsoleTmuxSendResultSchema,
	ContentEnvelopeSchema,
	CrossDomainShareTargetSchema,
	GatewayBootstrapBundleSchema,
	GatewayBootstrapFrameSchema,
	GatewayTransportSchema,
	InboxRowSchema,
	KeyEnvelopeSchema,
	KeyGrantOpSchema,
	KeyGrantSchema,
	KeyReceiptEntrySchema,
	KeyReceiptOpSchema,
	KeyReceiptSchema,
	KeyReceiptsReadOpSchema,
	KeyReceiptsReadResultSchema,
	KeyRequestOpSchema,
	KeyRequestSchema,
	MailboxEntrySchema,
	OpKeySchema,
	OpResultEnvelopeSchema,
	OwnerOpSchema,
	ProvisioningSchema,
	RowEnvelopeSchema,
	RowOriginSchema,
	TeamInfoSchema,
} from "../src/shared/schemas.js";
import {
	BoardActorSchema,
	BoardObservationRowSchema,
	BoardOpSchema,
	BoardReadResultSchema,
	BoardStoredEntrySchema,
	BoardWriteResultSchema,
	BoardWriteSchema,
} from "../src/shared/schemasBoardState.js";
import {
	ConsoleAckFrameSchema,
	ConsoleHelloFrameSchema,
	ConsoleInboxRowsFrameSchema,
	ConsolePingFrameSchema,
	ConsolePlaneFrameSchema,
	ConsolePongFrameSchema,
	ConsoleRefusedFrameSchema,
	ConsoleSocketInboundSchema,
	ConsoleSocketOutboundSchema,
	ConsoleWelcomeFrameSchema,
} from "../src/shared/schemasConsoleSocket.js";
import {
	FriendPresenceProjectionSchema,
	OwnerPresenceProjectionSchema,
	RosterEntrySchema,
} from "../src/shared/schemasRouterPresence.js";
import {
	ScheduleCancelValueSchema,
	ScheduledRecordSchema,
	ScheduledResultRowSchema,
	ScheduleSendValueSchema,
} from "../src/shared/schemasScheduled.js";
import {
	CrossDomainShareValueSchema,
	CrossDomainUnlinkValueSchema,
	CrossDomainUnshareValueSchema,
} from "../src/shared/schemasShare.js";
import {
	CapabilitiesReportSchema,
	CapabilitySnapshotWireSchema,
	ReadAnchorsResultSchema,
	ReportReadSchema,
} from "../src/shared/schemasTier1.js";
import {
	ADDRESS_SEP,
	CONV_TAG,
	DEFAULT_SESSION,
	MAX_CONV_ID_LEN,
	MAX_SLUG_LEN,
	NOTICE_TAG,
	SLUG_RE,
} from "../src/shared/session-id.js";
import { SttsProvidersSchema } from "../src/shared/stts-providers.js";

const OUT_PATH = join(
	import.meta.dir,
	"../android/app/src/main/java/com/atelier_nyaarium/switchboard/proto/Protocol.kt",
);

// Roots to emit, in output order. Every schema here must carry .meta({ id }).
const ROOTS: z.ZodType[] = [
	ChannelFileSchema,
	TeamInfoSchema,
	MailboxEntrySchema,
	CrossDomainShareTargetSchema,
	ConsoleOpSchema,
	ConsoleOpEnvelopeSchema,
	ConsoleRelayFrameSchema,
	ConsoleRelayReplySchema,
	ConsoleReplyBodySchema,
	ConsoleRegisterResultSchema,
	ConsoleListTeamsResultSchema,
	ConsoleSendResultSchema,
	ConsoleRespondResultSchema,
	ConsolePollResultSchema,
	ConsoleHelloFrameSchema,
	ConsoleAckFrameSchema,
	ConsolePingFrameSchema,
	ConsoleSocketInboundSchema,
	ConsoleWelcomeFrameSchema,
	ConsoleInboxRowsFrameSchema,
	ConsolePlaneFrameSchema,
	ConsoleRefusedFrameSchema,
	ConsolePongFrameSchema,
	ConsoleSocketOutboundSchema,
	ConsolePeekResultSchema,
	ConsoleTmuxSendResultSchema,
	ProvisioningSchema,
	SttsProvidersSchema,
	AdmissionSchema,
	SignedAdmissionSchema,
	RevocationSchema,
	SignedRevocationSchema,
	EnrollOpSchema,
	EnrollResultSchema,
	EnrollHandshakeOpSchema,
	EnrollHandshakeResultSchema,
	ConsoleApprovalOpSchema,
	ConsoleApprovalResultSchema,
	PendingTenantSchema,
	GatewayTransportSchema,
	GatewayBootstrapBundleSchema,
	GatewayBootstrapFrameSchema,
	ContentEnvelopeSchema,
	KeyEnvelopeSchema,
	KeyRequestSchema,
	KeyGrantSchema,
	KeyReceiptSchema,
	KeyRequestOpSchema,
	KeyGrantOpSchema,
	KeyReceiptOpSchema,
	KeyReceiptsReadOpSchema,
	KeyReceiptEntrySchema,
	KeyReceiptsReadResultSchema,
	SignedXDomainUntrustSchema,
	RosterRequestSchema,
	RosterResultSchema,
	TrustHandshakeOpSchema,
	TrustHandshakeResultSchema,
	TrustPendingRequestSchema,
	TrustPendingResultSchema,
	TransportRequestSchema,
	TransportResultSchema,
	OwnerOpSchema,
	InboxRowSchema,
	RowEnvelopeSchema,
	RowOriginSchema,
	OpKeySchema,
	OpResultEnvelopeSchema,
	OwnerPresenceProjectionSchema,
	FriendPresenceProjectionSchema,
	RosterEntrySchema,
	CrossDomainShareValueSchema,
	CrossDomainUnshareValueSchema,
	CrossDomainUnlinkValueSchema,
	BoardStoredEntrySchema,
	BoardActorSchema,
	BoardOpSchema,
	BoardWriteSchema,
	BoardWriteResultSchema,
	BoardReadResultSchema,
	BoardObservationRowSchema,
	ScheduledRecordSchema,
	ScheduleSendValueSchema,
	ScheduleCancelValueSchema,
	ScheduledResultRowSchema,
	CapabilitiesReportSchema,
	CapabilitySnapshotWireSchema,
	ReportReadSchema,
	ReadAnchorsResultSchema,
];

// Listed unions are encoded; others stay open for decoding.
const SEALED_ROOTS = new Set([
	"ConsoleOp",
	"EnrollOp",
	"EnrollHandshakeOp",
	"ConsoleApprovalOp",
	"TrustHandshakeOp",
	"CrossDomainShareTarget",
	"BoardOp",
	"BoardActor",
]);

type Json = Record<string, unknown>;

/** Strip unsupported schema metadata. */
function zodToCleanJsonSchema(schema: z.ZodType): Json {
	const json = z.toJSONSchema(schema, { io: "input" }) as Json;
	delete json.$schema;
	const walk = (node: unknown): void => {
		if (typeof node !== "object" || node === null) return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		const record = node as Json;
		// Remove only the format keyword.
		if (typeof record.format === "string") delete record.format;
		for (const key in record) walk(record[key]);
	};
	walk(json);
	return json;
}

function discriminatorOf(schema: z.ZodType): string {
	const def = (schema as unknown as { _zod: { def: { discriminator?: string } } })._zod.def;
	if (!def.discriminator) throw new Error("schema has no discriminator");
	return def.discriminator;
}

function idOf(schema: z.ZodType): string {
	const id = z.globalRegistry.get(schema)?.id;
	if (!id) throw new Error("root schema missing .meta({ id })");
	return id;
}

const INDENT = "\t";

function pascal(value: string): string {
	return value
		.split(/[_\-\s]+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

function nullableInner(node: Json): Json | null {
	const members = (node.anyOf ?? node.oneOf) as Json[] | undefined;
	if (members?.length !== 2) return null;
	const nullIndex = members.findIndex((m) => (m as Json).type === "null");
	if (nullIndex === -1) return null;
	return members[1 - nullIndex] as Json;
}

function kotlinType(node: Json, defs: Map<string, Json>): string {
	const ref = node.$ref as string | undefined;
	if (ref) {
		const name = ref.replace("#/$defs/", "");
		const target = defs.get(name);
		if (!target) throw new Error(`unresolved $ref ${ref}`);
		if (!target.properties && !target.oneOf && !target.anyOf) return kotlinType(target, defs);
		return name;
	}
	const inner = nullableInner(node);
	if (inner) return kotlinType(inner, defs);
	if (node.anyOf || node.oneOf) return "JsonElement";
	const type = node.type as string | undefined;
	switch (type) {
		case "string":
			return "String";
		case "integer":
			return "Long";
		case "number":
			return "Double";
		case "boolean":
			return "Boolean";
		case "array": {
			const items = node.items as Json | undefined;
			return `List<${items ? kotlinType(items, defs) : "JsonElement"}>`;
		}
		case "object":
			if (node.properties)
				throw new Error("inline object without $defs id - add .meta({ id }) to the sub-schema");
			return "JsonObject";
		default:
			return "JsonElement";
	}
}

function escapeKdoc(text: string): string {
	return text.replace(/\*\//g, "*&#47;").trim();
}

function kotlinString(value: string): string {
	return JSON.stringify(value).replace(/\$/g, "\\$");
}

function emitParams(node: Json, defs: Map<string, Json>, omit: Set<string>): string[] {
	const props = (node.properties ?? {}) as Record<string, Json>;
	const required = new Set((node.required as string[] | undefined) ?? []);
	const lines: string[] = [];
	for (const [name, prop] of Object.entries(props)) {
		if (omit.has(name)) continue;
		const baseType = kotlinType(prop, defs);
		const nullable = nullableInner(prop) !== null;
		const optional = !required.has(name) || nullable;
		const constValue = prop.const;
		const description = prop.description as string | undefined;
		if (description) lines.push(`${INDENT}/** ${escapeKdoc(description)} */`);
		if (typeof constValue === "string") {
			// Required consts must be encoded.
			if (required.has(name)) lines.push(`${INDENT}@EncodeDefault`);
			lines.push(`${INDENT}val ${name}: ${baseType} = ${kotlinString(constValue)},`);
		} else if (constValue !== undefined) {
			if (typeof constValue !== "number") throw new Error(`unsupported const for ${name}`);
			const isInteger = Number.isInteger(constValue);
			const type = isInteger ? "Long" : baseType;
			const literal = isInteger ? `${constValue}L` : `${constValue}`;
			lines.push(
				required.has(name) ? `${INDENT}val ${name}: ${type},` : `${INDENT}val ${name}: ${type} = ${literal},`,
			);
		} else if (optional) {
			lines.push(`${INDENT}val ${name}: ${baseType}? = null,`);
		} else {
			lines.push(`${INDENT}val ${name}: ${baseType},`);
		}
	}
	return lines;
}

function emitDataClass(name: string, node: Json, defs: Map<string, Json>): string {
	const params = emitParams(node, defs, new Set());
	return [`@Serializable`, `data class ${name}(`, ...params, `)`].join("\n");
}

function emitSealedClass(name: string, node: Json, discriminator: string, defs: Map<string, Json>): string {
	const members = (node.oneOf ?? node.anyOf) as Json[];
	if (!members) throw new Error(`sealed root ${name} has no oneOf`);
	const out: string[] = [
		`@Serializable`,
		`@OptIn(ExperimentalSerializationApi::class)`,
		`@JsonClassDiscriminator(${kotlinString(discriminator)})`,
		`sealed class ${name} {`,
	];
	for (const member of members) {
		const props = (member.properties ?? {}) as Record<string, Json>;
		const kindValue = props[discriminator]?.const as string | undefined;
		if (!kindValue) throw new Error(`sealed member of ${name} lacks const ${discriminator}`);
		const memberName = pascal(kindValue);
		// @SerialName supplies the discriminator.
		const params = emitParams(member, defs, new Set([discriminator]));
		out.push(`${INDENT}@Serializable`);
		out.push(`${INDENT}@SerialName(${kotlinString(kindValue)})`);
		if (params.length === 0) {
			// Use data objects for parameterless members.
			out.push(`${INDENT}data object ${memberName} : ${name}()`);
		} else {
			out.push(`${INDENT}data class ${memberName}(`);
			out.push(...params.map((line) => `${INDENT}${line}`));
			out.push(`${INDENT}) : ${name}()`);
		}
		out.push("");
	}
	while (out[out.length - 1] === "") out.pop();
	out.push(`}`);
	return out.join("\n");
}

const defs = new Map<string, Json>();
const rootIds: string[] = [];

for (const schema of ROOTS) {
	const id = idOf(schema);
	const json = zodToCleanJsonSchema(schema);
	const nested = (json.$defs ?? {}) as Record<string, Json>;
	delete json.$defs;
	// Shared definitions must keep identical bodies.
	const guardedSet = (name: string, body: Json) => {
		const existing = defs.get(name);
		if (existing && JSON.stringify(existing) !== JSON.stringify(body)) {
			throw new Error(`conversion-root versus inline-object conflict: "${name}" maps to two different shapes`);
		}
		defs.set(name, body);
	};
	guardedSet(id, json);
	for (const [name, body] of Object.entries(nested)) {
		if (name === id) continue;
		guardedSet(name, body);
	}
	rootIds.push(id);
}

const order = [...new Set([...rootIds, ...defs.keys()])];

const blocks: string[] = [];
for (const name of order) {
	const node = defs.get(name);
	if (!node) continue;
	// Skip scalar and enum aliases.
	if (!node.properties && !node.oneOf && !node.anyOf) continue;
	if (SEALED_ROOTS.has(name)) {
		const schema = ROOTS.find((s) => idOf(s) === name);
		if (!schema) throw new Error(`sealed root ${name} not in ROOTS`);
		blocks.push(emitSealedClass(name, node, discriminatorOf(schema), defs));
	} else if (node.properties) {
		blocks.push(emitDataClass(name, node, defs));
	} else {
	}
}

const header = `// generated from src/shared/schemas.ts + src/shared/console-protocol.ts - DO NOT EDIT.
// Regenerate: bun scripts/codegen-kotlin.ts
// Decode with ignoreUnknownKeys = true. Enum-like fields are open Strings, so a console
// tolerates values newer than its build.
//
// Keep encodeDefaults false: zod .optional() rejects an explicit null. Enabling it MUST pair
// with explicitNulls = false. Required consts become parameters.
//
// The console POSTs the op-only envelope, so ConsoleRelayFrame is decode-side here.
@file:Suppress("unused")
@file:OptIn(ExperimentalSerializationApi::class)

package com.atelier_nyaarium.switchboard.proto

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

object Protocol {
${INDENT}const val CONSOLE_PROTOCOL_VERSION: Int = ${CONSOLE_PROTOCOL_VERSION}

${INDENT}/** Address and store separator. */
${INDENT}const val ADDRESS_SEP: String = ${kotlinString(ADDRESS_SEP)}

${INDENT}/** Channel key tag. */
${INDENT}const val CONV_TAG: String = ${kotlinString(CONV_TAG)}

${INDENT}/** Broadcast key tag. */
${INDENT}const val NOTICE_TAG: String = ${kotlinString(NOTICE_TAG)}

${INDENT}/** Default session. */
${INDENT}const val DEFAULT_SESSION: String = ${kotlinString(DEFAULT_SESSION)}

${INDENT}/** Address slug pattern. */
${INDENT}const val SLUG_PATTERN: String = ${kotlinString(SLUG_RE.source)}

${INDENT}const val MAX_SLUG_LEN: Int = ${MAX_SLUG_LEN}

${INDENT}const val MAX_CONV_ID_LEN: Int = ${MAX_CONV_ID_LEN}

${INDENT}/** Blob chunk size. */
${INDENT}const val BLOB_CHUNK_BYTES: Int = ${BLOB_CHUNK_BYTES}

${INDENT}/** Blob size limit. Enforced where the bytes land: a stated size is the sender's claim. */
${INDENT}const val MAX_BLOB_BYTES: Long = ${MAX_BLOB_BYTES}

${INDENT}/** Unprompted fetch threshold, not an attachment cap. The wire still carries MAX_BLOB_BYTES. */
${INDENT}const val BOARD_AUTO_DOWNLOAD_MAX_BYTES: Long = ${BOARD_AUTO_DOWNLOAD_MAX_BYTES}

${INDENT}/** Board attachment limit. */
${INDENT}const val BOARD_ATTACHMENTS_MAX: Int = ${BOARD_ATTACHMENTS_MAX}
}`;

const output = `${[header, ...blocks].join("\n\n")}\n`;

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, output);
console.log(`Wrote ${OUT_PATH} (${blocks.length} types + constants).`);
