// THE single zod truth for every wire shape, split by wire domain into sibling files. This barrel
// re-exports everything so no importer changes: codegen-kotlin.ts, the gateway, the MCP, and the
// tests all keep importing named symbols from "./schemas.js". Codegen emission order comes from
// scripts/codegen-kotlin.ts's own ROOTS list, not from this barrel's (biome-sorted) export order.

export * from "./schemasBlob.js";
export * from "./schemasBoard.js";
export * from "./schemasCapability.js";
export * from "./schemasConsoleOp.js";
export * from "./schemasConsoleResults.js";
export * from "./schemasCore.js";
export * from "./schemasGatewayBootstrap.js";
export * from "./schemasGatewayTransport.js";
export * from "./schemasPresence.js";
export * from "./schemasProvisioning.js";
export * from "./schemasRegister.js";
