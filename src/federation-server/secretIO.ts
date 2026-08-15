import type { FederationSecret } from "./federationSecret.js";

////////////////////////////////
//  Interfaces & Types

export interface SecretIO {
	read(): Promise<{ value: FederationSecret; resourceVersion: string | null } | null>;
	write(value: FederationSecret, resourceVersion: string | null): Promise<void>;
}

export class ConflictError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "ConflictError";
	}
}
