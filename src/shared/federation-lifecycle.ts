//
// The owner-device lifecycle wire truth, split by flow into sibling synced leaves (each with its
// own SYNC-HASH and copy target). This barrel re-exports everything so no importer changes in
// either repo. The siblings export exactly the public surface; module-private schemas stay private.

export * from "./federation-device-approval.js";
export * from "./federation-enroll-ops.js";
export * from "./federation-enrollment.js";
export * from "./federation-handshakes.js";
export * from "./federation-proofs.js";
export * from "./federation-tenants.js";
export * from "./federation-xdomain-links.js";
