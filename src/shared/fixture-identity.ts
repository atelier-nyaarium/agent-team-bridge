// The committed test identities, refused by the shipping entry points.

const FIXTURE_SIGN_PUBS = new Set([
	"BM40ZeyXZfBY5jOpqeLEyLRc03tNPKGCfP2Z8nQJCKk=",
	"s1H7W7bG7tz0kA+qDERSO9pCIZ3USsFnGLpqFZ13m28=",
	"MXCo4mPj6sJdP9TnM34sP3ZPawSzPEIj5kJtJCkZ02Q=",
	"bXhwDB5nEMCvY00l2qbzOl9wvzHx/hMdPCJc9PMHBh4=",
]);

export const ALLOW_FIXTURE_IDENTITY_ENV = "ALLOW_FIXTURE_IDENTITY";

export function isFixtureIdentity(signPub: string): boolean {
	return FIXTURE_SIGN_PUBS.has(signPub);
}

/** Throws unless the process opted in through the environment. */
export function refuseFixtureIdentity(signPub: string, role: string, env: NodeJS.ProcessEnv = process.env): void {
	if (!isFixtureIdentity(signPub) || env[ALLOW_FIXTURE_IDENTITY_ENV] === "1") return;
	throw new Error(
		`${role} identity ${signPub} is the committed test fixture; set ${ALLOW_FIXTURE_IDENTITY_ENV}=1 to run it`,
	);
}
