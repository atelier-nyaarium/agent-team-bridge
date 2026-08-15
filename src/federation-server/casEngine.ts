import type { Identity } from "../shared/crypto.js";
import type { EnrollmentState, SeenAdminNonce } from "./federationSecret.js";

////////////////////////////////
//  Interfaces & Types

export type WriteOutcome = { ok: true } | { ok: false; error: Error };

export interface CasBase {
	enrollment: Record<string, EnrollmentState>;
	seenAdminNonces: SeenAdminNonce[];
	identity: Identity;
}

export type CasMutation<T> =
	| {
			commit: true;
			enrollment: Record<string, EnrollmentState>;
			seenAdminNonces: SeenAdminNonce[];
			value: T;
	  }
	| { commit: false; value: T };

export const MAX_WRITE_RETRIES = 5;
