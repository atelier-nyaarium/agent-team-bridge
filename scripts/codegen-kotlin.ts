import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { OWNER_OP_KIND_LIST } from "../src/federation-server/ownerOpRegistry.js";
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
	FirstRootSchema,
	PendingTenantSchema,
	RosterRequestSchema,
	RosterResultSchema,
	SignedFirstRootSchema,
	TransportRequestSchema,
	TransportResultSchema,
	TrustHandshakeOpSchema,
	TrustHandshakeResultSchema,
	TrustPendingRequestSchema,
	TrustPendingResultSchema,
} from "../src/shared/federation-lifecycle.js";
import { SignedXDomainUntrustSchema } from "../src/shared/federation-protocol.js";
import {
	BLOB_CHUNK_BYTES,
	FEDERATION_PROTOCOL_FLOOR,
	FEDERATION_PROTOCOL_VERSION,
	MAX_BLOB_BYTES,
} from "../src/shared/router-protocol.js";
import {
	BOARD_ATTACHMENTS_MAX,
	BOARD_AUTO_DOWNLOAD_MAX_BYTES,
	ChannelFileSchema,
	ConsoleBlobGetResultSchema,
	ConsoleBlobPutResultSchema,
	ConsoleBlobStatResultSchema,
	ConsoleCloseSessionResultSchema,
	ConsoleCreateSessionResultSchema,
	ConsoleForgetResultSchema,
	ConsoleListDirsResultSchema,
	ConsoleOpSchema,
	ConsolePeekResultSchema,
	ConsolePollResultSchema,
	ConsoleReloadPluginsResultSchema,
	ConsoleRenameSessionResultSchema,
	ConsoleReportReadResultSchema,
	ConsoleRespondResultSchema,
	ConsoleSendResultSchema,
	ConsoleTmuxSendResultSchema,
	ContentEnvelopeSchema,
	CrossDomainCancelResultSchema,
	CrossDomainConfirmResultSchema,
	CrossDomainListenResultSchema,
	CrossDomainListenStateResultSchema,
	CrossDomainListPeersResultSchema,
	CrossDomainListSharesResultSchema,
	CrossDomainPresenceEntrySchema,
	CrossDomainRequestResultSchema,
	CrossDomainShareResultSchema,
	CrossDomainShareTargetSchema,
	CrossDomainUnlinkResultSchema,
	CrossDomainUnshareResultSchema,
	GatewayBootstrapBundleSchema,
	GatewayBootstrapFrameSchema,
	GatewayTransportSchema,
	GatewayValueOpSchema,
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
	PlaneReadSchema,
	PlanesReadResultSchema,
	PlanesReadValueSchema,
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
	ConsoleRunbookDeleteResultSchema,
	ConsoleRunbookListResultSchema,
	ConsoleRunbookPutResultSchema,
	RunbookParameterSchema,
	RunbookSchema,
} from "../src/shared/schemasRunbook.js";
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
	ConsoleVaultAnswerResultSchema,
	ConsoleVaultGrantsResultSchema,
	ConsoleVaultRevokeResultSchema,
	VaultDeleteValueSchema,
	VaultGrantSchema,
	VaultListResultSchema,
	VaultListValueSchema,
	VaultPutSchema,
	VaultPutValueSchema,
	VaultRequestSchema,
	VaultRetractSchema,
	VaultStoredEntrySchema,
	VaultWriteResultSchema,
} from "../src/shared/schemasVault.js";
import {
	WireFixtureEntrySchema,
	WireFixtureSchema,
	WireFrameSchema,
	WireManifestSchema,
	WirePhoneDecodeSchema,
	WireRequestSchema,
	WireSealedSchema,
} from "../src/shared/schemasWireFixture.js";
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
import {
	BEARER_PREFIX,
	BOARD_OUTCOME_APPLIED,
	CONSOLE_REASON_CURSOR_STALE,
	CONSOLE_TOKEN_HEADER,
	CONTENT_NONCE_BYTES,
	GATEWAY_ERROR_INBOX_UNAVAILABLE,
	GATEWAY_ERROR_NOT_ADMITTED,
	GATEWAY_ERROR_NOT_REGISTERED,
	GATEWAY_ERROR_STALE_INCARNATION,
	GATEWAY_REASON_NO_WAITER,
	OP_OUTCOME_ACCEPTED,
	ROUTER_PATHS,
	SIGNING_TAGS,
	WIRE_NONCE_BYTES,
} from "../src/shared/wire-vocabulary.js";

const OUT_PATH =
	process.env.KOTLIN_PROTOCOL_OUT ??
	join(import.meta.dir, "../android/app/src/main/java/com/atelier_nyaarium/switchboard/proto/Protocol.kt");

const ROOTS: z.ZodType[] = [
	ChannelFileSchema,
	TeamInfoSchema,
	MailboxEntrySchema,
	CrossDomainShareTargetSchema,
	ConsoleOpSchema,
	ConsolePollResultSchema,
	FirstRootSchema,
	SignedFirstRootSchema,
	CrossDomainPresenceEntrySchema,
	ConsoleSendResultSchema,
	ConsoleRespondResultSchema,
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
	ConsoleCreateSessionResultSchema,
	ConsoleReloadPluginsResultSchema,
	ConsoleForgetResultSchema,
	ConsoleReportReadResultSchema,
	ConsoleCloseSessionResultSchema,
	ConsoleRenameSessionResultSchema,
	ConsoleListDirsResultSchema,
	ConsoleBlobStatResultSchema,
	ConsoleBlobPutResultSchema,
	ConsoleBlobGetResultSchema,
	CrossDomainListenResultSchema,
	CrossDomainRequestResultSchema,
	CrossDomainConfirmResultSchema,
	CrossDomainCancelResultSchema,
	CrossDomainListenStateResultSchema,
	CrossDomainShareResultSchema,
	CrossDomainUnshareResultSchema,
	CrossDomainListSharesResultSchema,
	CrossDomainListPeersResultSchema,
	CrossDomainUnlinkResultSchema,
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
	GatewayValueOpSchema,
	PlaneReadSchema,
	PlanesReadResultSchema,
	PlanesReadValueSchema,
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
	VaultStoredEntrySchema,
	VaultPutSchema,
	VaultWriteResultSchema,
	VaultListResultSchema,
	VaultListValueSchema,
	VaultPutValueSchema,
	VaultDeleteValueSchema,
	VaultRequestSchema,
	VaultRetractSchema,
	VaultGrantSchema,
	ConsoleVaultAnswerResultSchema,
	ConsoleVaultGrantsResultSchema,
	ConsoleVaultRevokeResultSchema,
	RunbookParameterSchema,
	RunbookSchema,
	ConsoleRunbookListResultSchema,
	ConsoleRunbookPutResultSchema,
	ConsoleRunbookDeleteResultSchema,
	ScheduledRecordSchema,
	ScheduleSendValueSchema,
	ScheduleCancelValueSchema,
	ScheduledResultRowSchema,
	CapabilitiesReportSchema,
	CapabilitySnapshotWireSchema,
	ReportReadSchema,
	ReadAnchorsResultSchema,
	WireFrameSchema,
	WireRequestSchema,
	WirePhoneDecodeSchema,
	WireSealedSchema,
	WireFixtureSchema,
	WireFixtureEntrySchema,
	WireManifestSchema,
];

const SEALED_ROOTS = new Set([
	"ConsoleOp",
	"EnrollOp",
	"EnrollHandshakeOp",
	"ConsoleApprovalOp",
	"TrustHandshakeOp",
	"CrossDomainShareTarget",
	"BoardOp",
	"BoardActor",
	"VaultRequest",
	"WireFixture",
]);

type Json = Record<string, unknown>;

function zodToCleanJsonSchema(schema: z.ZodType): Json {
	// Strip format only; other schema metadata is preserved.
	const json = z.toJSONSchema(schema, { io: "input" }) as Json;
	delete json.$schema;
	const walk = (node: unknown): void => {
		if (typeof node !== "object" || node === null) return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		const record = node as Json;
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
	// SerialName carries the wire discriminator.
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
		const params = emitParams(member, defs, new Set([discriminator]));
		out.push(`${INDENT}@Serializable`);
		out.push(`${INDENT}@SerialName(${kotlinString(kindValue)})`);
		if (params.length === 0) {
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

function literalValues(schema: z.ZodType, field: string): string[] {
	const definition = (schema as unknown as { _def: { options?: unknown[]; shape?: Record<string, ZodInternal> } })
		._def;
	const options = definition.options ?? [];
	return options.flatMap((option) => {
		const shape = (option as { _def?: { shape?: Record<string, ZodInternal> } })._def?.shape;
		const values = shape?.[field]?._def.values;
		return values?.filter((value): value is string => typeof value === "string") ?? [];
	});
}

function objectLiteralValue(schema: z.ZodType, field: string): string[] {
	const shape = (schema as unknown as { _def: { shape: Record<string, ZodInternal> } })._def.shape;
	return shape[field]._def.values?.filter((value): value is string => typeof value === "string") ?? [];
}

type ZodInternal = { _def: { values?: unknown[] } };

function kotlinConstName(name: string): string {
	return name.replace(/[a-z][A-Z]/g, (match) => `${match[0]}_${match[1]}`).toUpperCase();
}

const wireConstants: ReadonlyArray<readonly [string, string | number]> = [
	...Object.entries(ROUTER_PATHS).map(([name, value]) => [`ROUTER_PATH_${name}`, value] as const),
	["CONSOLE_TOKEN_HEADER", CONSOLE_TOKEN_HEADER],
	["BEARER_PREFIX", BEARER_PREFIX],
	...OWNER_OP_KIND_LIST.map((kind) => [`OWNER_OP_${kind}`, kind] as const),
	...Object.entries(SIGNING_TAGS).map(([name, value]) => [`SIGNING_TAG_${name}`, value] as const),
	["OP_OUTCOME_ACCEPTED", OP_OUTCOME_ACCEPTED],
	["BOARD_OUTCOME_APPLIED", BOARD_OUTCOME_APPLIED],
	["CONSOLE_REASON_CURSOR_STALE", CONSOLE_REASON_CURSOR_STALE],
	["GATEWAY_ERROR_STALE_INCARNATION", GATEWAY_ERROR_STALE_INCARNATION],
	["GATEWAY_ERROR_NOT_REGISTERED", GATEWAY_ERROR_NOT_REGISTERED],
	["GATEWAY_ERROR_NOT_ADMITTED", GATEWAY_ERROR_NOT_ADMITTED],
	["GATEWAY_ERROR_INBOX_UNAVAILABLE", GATEWAY_ERROR_INBOX_UNAVAILABLE],
	["GATEWAY_REASON_NO_WAITER", GATEWAY_REASON_NO_WAITER],
	["CONTENT_NONCE_BYTES", CONTENT_NONCE_BYTES],
	["WIRE_NONCE_BYTES", WIRE_NONCE_BYTES],
];
const wireConstantBlock = wireConstants
	.map(
		([name, value]) =>
			`${INDENT}${INDENT}const val ${kotlinConstName(name)}: ${typeof value === "number" ? "Int" : "String"} = ${typeof value === "number" ? value : kotlinString(value)}`,
	)
	.join("\n");
const consoleOpKinds = literalValues(ConsoleOpSchema, "kind");
const socketFrameTypes = literalValues(ConsoleSocketOutboundSchema, "type");
const keyOpKinds = [KeyRequestOpSchema, KeyGrantOpSchema, KeyReceiptOpSchema, KeyReceiptsReadOpSchema].flatMap(
	(schema) => objectLiteralValue(schema, "kind"),
);
const schemaConstantBlock = (name: string, values: string[]) =>
	[
		`${INDENT}${INDENT}object ${name} {`,
		...values.map(
			(value) =>
				`${INDENT}${INDENT}${INDENT}const val ${kotlinConstName(value)}: String = ${kotlinString(value)}`,
		),
		`${INDENT}${INDENT}}`,
	].join("\n");

const blocks: string[] = [];
for (const name of order) {
	const node = defs.get(name);
	if (!node) continue;
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
${INDENT}const val FEDERATION_PROTOCOL_FLOOR: Int = ${FEDERATION_PROTOCOL_FLOOR}
${INDENT}const val FEDERATION_PROTOCOL_VERSION: Int = ${FEDERATION_PROTOCOL_VERSION}

${INDENT}object Wire {
${wireConstantBlock}

${schemaConstantBlock("ConsoleOpKind", consoleOpKinds)}

${schemaConstantBlock("SocketFrame", socketFrameTypes)}

${schemaConstantBlock("KeyOpKind", keyOpKinds)}
${INDENT}}

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
