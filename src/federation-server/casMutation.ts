import type { EnrollmentState, SeenAdminNonce } from "./federationSecret.js";

////////////////////////////////
//  Interfaces & Types

export const DELETE_SLICE = Symbol("delete-slice");

export type DomainMutation<T> =
	| { commit: true; next: EnrollmentState | typeof DELETE_SLICE; value: T }
	| { commit: false; value: T };

export type SecretMutation<T> =
	| {
			commit: true;
			enrollment: Record<string, EnrollmentState>;
			seenAdminNonces: SeenAdminNonce[];
			value: T;
	  }
	| { commit: false; value: T };
