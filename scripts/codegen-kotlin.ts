// Generates the Kotlin protocol types + constants from the zod truth in
// src/shared/. The output (android/.../proto/Protocol.kt) is committed; CI
// regenerates and diffs so the two sides cannot drift.
//
//   bun scripts/codegen-kotlin.ts
//
// Emission rules:
// - Sealed classes ONLY for encode-side discriminated unions (the console
//   composes them, closure is safe). The list is hardcoded below. Everything
//   else the console DECODES stays forward-compatible: enums emit as open
//   String, unknown discriminator values can never throw.
// - Non-discriminated unions (ConsoleOpResult) emit as JsonElement; the per-op
//   decode mapping stays in client code, correlated by opId.
// - integer -> Long (at/seq/cursor are epoch-ms and monotonic counters),
//   record/unknown -> JsonObject/JsonElement, optional -> nullable = null.
// - The zod -> JSON Schema leg uses io:"input" (decode semantics; transforms
//   drop, defaulted fields go optional). Shared sub-schemas become named
//   $defs through their .meta ids alone - do NOT pass reused:"ref", which
//   additionally hoists every anonymous sub-schema as __schemaN defs whose
//   names collide across root conversions.

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
	CrossDomainShareTargetSchema,
	GatewayBootstrapBundleSchema,
	GatewayBootstrapFrameSchema,
	GatewayTransportSchema,
	MailboxEntrySchema,
	ProvisioningSchema,
	TeamInfoSchema,
} from "../src/shared/schemas.js";
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

////////////////////////////////
//  Config

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
	// Device self-enroll approval: the held device composes the ops, decodes the Router's reply.
	ConsoleApprovalOpSchema,
	ConsoleApprovalResultSchema,
	PendingTenantSchema,
	GatewayTransportSchema,
	GatewayBootstrapBundleSchema,
	GatewayBootstrapFrameSchema,
	// A root so the Android owner can sign it.
	SignedXDomainUntrustSchema,
	RosterRequestSchema,
	RosterResultSchema,
	// Trust rendezvous: the phone signs/encodes the handshake plus the pending query.
	TrustHandshakeOpSchema,
	TrustHandshakeResultSchema,
	TrustPendingRequestSchema,
	TrustPendingResultSchema,
	// An owner pulling its network's gateway-bridge transport (proof-of-possession + the Router's reply).
	TransportRequestSchema,
	TransportResultSchema,
];

// Encode-side discriminated unions that may emit as sealed classes. Anything
// not listed emits open (decode-side rule); the discriminator key is read from
// zod internals. EnrollOp is composed by the console, so closure is safe; the
// scanned EnrollmentPayload is decoded and stays hand-parsed in the client.
const SEALED_ROOTS = new Set([
	"ConsoleOp",
	"EnrollOp",
	"EnrollHandshakeOp",
	"ConsoleApprovalOp",
	"TrustHandshakeOp",
	"CrossDomainShareTarget",
]);

////////////////////////////////
//  zod -> cleaned JSON Schema (evie-bot's conversion hygiene)

type Json = Record<string, unknown>;

/** Strip $schema and `format` validators downstream consumers do not support
 * (zod still enforces them at parse time). Mirrors evie-bot's
 * actionSchemaToTool cleanup walk. */
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
		// Keyword form only: a PROPERTY named "format" is a schema object here,
		// while the format validator keyword is always a string.
		if (typeof record.format === "string") delete record.format;
		for (const key in record) walk(record[key]);
	};
	walk(json);
	return json;
}

/** Discriminator key of a z.discriminatedUnion, from zod internals (the JSON
 * Schema output carries no discriminator keyword - verified on zod 4.4.3). */
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

////////////////////////////////
//  Kotlin emission

const INDENT = "\t";

/** "list_teams" -> "ListTeams" */
function pascal(value: string): string {
	return value
		.split(/[_\-\s]+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

/** The non-null member of a zod .nullable() union (a 2-member anyOf with
 * {type:"null"}), or null when the node is not that shape. */
function nullableInner(node: Json): Json | null {
	const members = (node.anyOf ?? node.oneOf) as Json[] | undefined;
	if (members?.length !== 2) return null;
	const nullIndex = members.findIndex((m) => (m as Json).type === "null");
	if (nullIndex === -1) return null;
	return members[1 - nullIndex] as Json;
}

/** Kotlin type for a JSON Schema node. `defs` resolves $ref names; refs to
 * scalar/enum defs (e.g. RequestType) inline their underlying type - the
 * decode-side rule keeps them open Strings, never Kotlin enums. */
function kotlinType(node: Json, defs: Map<string, Json>): string {
	const ref = node.$ref as string | undefined;
	if (ref) {
		const name = ref.replace("#/$defs/", "");
		const target = defs.get(name);
		if (!target) throw new Error(`unresolved $ref ${ref}`);
		if (!target.properties && !target.oneOf && !target.anyOf) return kotlinType(target, defs);
		return name;
	}
	// .nullable() unwraps to T (the param emitter adds the ? = null).
	const inner = nullableInner(node);
	if (inner) return kotlinType(inner, defs);
	// Non-discriminated unions stay opaque: the consumer decodes per context.
	if (node.anyOf || node.oneOf) return "JsonElement";
	const type = node.type as string | undefined;
	switch (type) {
		case "string":
			return "String"; // enums + consts included: decode-side stays open
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
			return "JsonObject"; // z.record / free-form
		default:
			return "JsonElement"; // z.unknown and friends
	}
}

function escapeKdoc(text: string): string {
	return text.replace(/\*\//g, "*&#47;").trim();
}

/** Kotlin string literal: JSON escaping plus `$` (template interpolation). */
function kotlinString(value: string): string {
	return JSON.stringify(value).replace(/\$/g, "\\$");
}

/** Emit the properties of one object schema as constructor params. */
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
			lines.push(`${INDENT}val ${name}: ${baseType} = ${kotlinString(constValue)},`);
		} else if (constValue !== undefined) {
			throw new Error(`non-string const for ${name} - extend the emitter before using it`);
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
		// kotlinx writes the discriminator from @SerialName; it is not a property.
		const params = emitParams(member, defs, new Set([discriminator]));
		out.push(`${INDENT}@Serializable`);
		out.push(`${INDENT}@SerialName(${kotlinString(kindValue)})`);
		if (params.length === 0) {
			// kotlinx needs object (or a no-arg class) for parameterless members;
			// data object keeps equals/toString sane.
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

////////////////////////////////
//  Main

const defs = new Map<string, Json>();
const rootIds: string[] = [];

for (const schema of ROOTS) {
	const id = idOf(schema);
	const json = zodToCleanJsonSchema(schema);
	const nested = (json.$defs ?? {}) as Record<string, Json>;
	delete json.$defs;
	// The root converts to its body and .meta'd sub-schemas land in $defs
	// keyed by id. The same id reappearing across roots must carry an
	// identical body (same source schema) - anything else is a name
	// collision that would silently emit one class for two shapes.
	const guardedSet = (name: string, body: Json) => {
		const existing = defs.get(name);
		if (existing && JSON.stringify(existing) !== JSON.stringify(body)) {
			throw new Error(`.meta id collision: "${name}" maps to two different shapes`);
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
	// Skip aliases that resolve to plain scalars/enums (decode-side Strings).
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
//
// Decode with Json { ignoreUnknownKeys = true } (the additive-protocol
// posture). Enum-like fields are open Strings on purpose: the console must
// tolerate values newer than this build.
//
// ENCODE config is load-bearing: the default Json (encodeDefaults = false)
// omits null-defaulted optionals, which is exactly what the gateway's zod
// schemas accept - zod .optional() REJECTS explicit nulls. If encodeDefaults
// is ever enabled (e.g. to emit a defaulted const like ConsoleRelayFrame.type),
// it MUST pair with explicitNulls = false. Note the console's POST body is the
// op-only envelope {device, conversationId, opId, op}; the Router composes the
// full console_relay frame, so ConsoleRelayFrame is decode-side here.
@file:Suppress("unused")

package com.atelier_nyaarium.switchboard.proto

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

object Protocol {
${INDENT}const val CONSOLE_PROTOCOL_VERSION: Int = ${CONSOLE_PROTOCOL_VERSION}

${INDENT}/** The one structural separator for every address / store / thread key. */
${INDENT}const val ADDRESS_SEP: String = ${kotlinString(ADDRESS_SEP)}

${INDENT}/** Position-0 store-key tag for a channel conversation key. */
${INDENT}const val CONV_TAG: String = ${kotlinString(CONV_TAG)}

${INDENT}/** Position-0 store-key tag for a broadcast notice key. */
${INDENT}const val NOTICE_TAG: String = ${kotlinString(NOTICE_TAG)}

${INDENT}/** The session a bare spawn-point name defaults to as a wake / UI default. */
${INDENT}const val DEFAULT_SESSION: String = ${kotlinString(DEFAULT_SESSION)}

${INDENT}/** The one address-segment slug pattern (lowercase alnum, internal / trailing hyphen). */
${INDENT}const val SLUG_PATTERN: String = ${kotlinString(SLUG_RE.source)}

${INDENT}const val MAX_SLUG_LEN: Int = ${MAX_SLUG_LEN}

${INDENT}const val MAX_CONV_ID_LEN: Int = ${MAX_CONV_ID_LEN}

${INDENT}/** Bytes per blob chunk. Every runtime moves attachment bytes in units of this, so the peak
${INDENT} * allocation on a transfer is a constant no matter how large the file is. */
${INDENT}const val BLOB_CHUNK_BYTES: Int = ${BLOB_CHUNK_BYTES}

${INDENT}/** Largest a single blob may grow to. Enforced where the bytes land rather than where they
${INDENT} * are described, since a message's stated size is the sender's own claim. */
${INDENT}const val MAX_BLOB_BYTES: Long = ${MAX_BLOB_BYTES}

${INDENT}/** Above this a console waits to be asked before fetching a board attachment. NOT a cap on what
${INDENT} * may be attached - the wire carries up to MAX_BLOB_BYTES in chunks either way. It only decides
${INDENT} * what a device pulls down unprompted. */
${INDENT}const val BOARD_AUTO_DOWNLOAD_MAX_BYTES: Long = ${BOARD_AUTO_DOWNLOAD_MAX_BYTES}

${INDENT}/** Attachments one board entry may hold. */
${INDENT}const val BOARD_ATTACHMENTS_MAX: Int = ${BOARD_ATTACHMENTS_MAX}
}`;

const output = `${[header, ...blocks].join("\n\n")}\n`;

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, output);
console.log(`Wrote ${OUT_PATH} (${blocks.length} types + constants).`);
