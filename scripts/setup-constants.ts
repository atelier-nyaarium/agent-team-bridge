// Shared paths for the setup.ts split: the gateway's on-disk artifacts and the host-local admin
// secrets dir. Pure data, no logic, so every setup-*.ts module can import it without risking a cycle.

import os from "node:os";
import path from "node:path";

////////////////////////////////
//  Constants

export const HEALTH_URL = "http://localhost:20000/health";
export const ENROLL_URL = "http://localhost:20000/enroll";
export const ADMIT_PAYLOAD_URL = "http://localhost:20000/admit-payload";
// The gateway's federation dir on the host (bind-mounted to /app/data/federation in the container).
export const FED_DIR_HOST = "volumes/gateway-data/federation";
export const TRANSPORT_FILE_HOST = `${FED_DIR_HOST}/transport.json`; // enrollment writes this once a bundle installs
export const SECRETS_DIR = path.join(os.homedir(), ".config", "switchboard"); // host-local admin secrets (0700)
export const BLOB_FILE = `${SECRETS_DIR}/console-provisioning.json`; // the artifact the app imports
export const QR_GIF = `${SECRETS_DIR}/console-enrollment-qr.gif`; // optional saved QR image (menu opt 2)
export const CONSOLE_JSON_FILE = `${SECRETS_DIR}/console-enrollment.json`; // optional saved JSON (paste fallback)
// Temp artifacts Setup Gateway can save so a far-away phone can scan/paste off-screen. Always
// deleted on enrollment success, back-out, or ^C (see trackTemp / cleanupTemps).
export const GW_QR_GIF = `${SECRETS_DIR}/gateway-admit-qr.gif`;
export const GW_JSON_FILE = `${SECRETS_DIR}/gateway-admit.json`;

// The one-time invite lifetime for a freshly-staged pending admin Domain. Matches the Router's
// DEFAULT_INVITE_TTL_MS (~1 day) so the admin has time to scan + connect; the Router sweeps an
// unredeemed pending tenant at issuedAt + ttlMs.
export const INVITE_TTL_MS = 86_400_000;
