export const ROUTER_PATHS = {
	console: "/console",
	health: "/health",
	ingest: "/ingest",
	deviceApproval: "/device-approval",
	gateway: "/gateway",
	root: "/",
} as const;

export const CONSOLE_TOKEN_HEADER = "x-console-bridge-token";
export const BEARER_PREFIX = "Bearer ";

export const OP_OUTCOME_ACCEPTED = "accepted";
export const BOARD_OUTCOME_APPLIED = "applied";
export const CONSOLE_REASON_CURSOR_STALE = "cursor_stale";
export const GATEWAY_ERROR_STALE_INCARNATION = "stale_incarnation";
export const GATEWAY_REASON_NO_WAITER = "no_waiter";

export const SIGNING_TAGS = {
	admission: "ADMISSION_V1",
	revocation: "REVOCATION_V1",
	register: "REGISTER_V1",
	deviceJoin: "DEVICE_JOIN_V1",
	ownerOp: "OWNEROP_V1",
	inboxRow: "INBOXROW_V1",
	keyEnvelope: "KEYENVELOPE_V1",
	keyRequest: "KEYREQUEST_V1",
	keyReceipt: "KEYRECEIPT_V1",
	roster: "ROSTER_V1",
	trustPending: "TRUST_PENDING_V1",
	transportRequest: "TRANSPORT_REQUEST_V1",
	provisionTenant: "PROVISION_TENANT_V1",
	removeTenant: "REMOVE_TENANT_V1",
	firstRoot: "FIRST_ROOT_V1",
	setDisplayName: "SET_DISPLAY_NAME_V1",
	deleteDomain: "DELETE_DOMAIN_V1",
	xdomainRelayGate: "XDOMAIN_RELAY_GATE_V1",
	xdomainRevoke: "XDOMAIN_REVOKE_V1",
	xdomainLink: "XDOMAIN_LINK_V1",
	xdomainUntrust: "XDOMAIN_UNTRUST_V1",
	sasCommit: "SAS_COMMIT_V1",
	sas: "SAS_V1",
	enrollCommit: "ENROLL_COMMIT_V1",
	enrollSas: "ENROLL_SAS_V1",
	codexAgent: "CODEX_AGENT_V1",
	copilotAgent: "COPILOT_AGENT_V1",
} as const;

export const CONTENT_NONCE_BYTES = 12;
export const WIRE_NONCE_BYTES = 18;
