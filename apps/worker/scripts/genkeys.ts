/**
 * Generate the secrets the control plane needs. Run: npx tsx scripts/genkeys.ts
 * Feed each value to `wrangler secret put <NAME>`; keep WORKER_RPC_PUBLIC_KEY
 * for the daemon config on each host.
 */
import { generateEd25519Keypair, generateSymmetricKey } from "@codestation/contract";

const rpc = generateEd25519Keypair();
console.log("CREDENTIAL_MASTER_KEY=" + generateSymmetricKey());
console.log("NULLIFIER_HMAC_KEY=" + generateSymmetricKey());
console.log("WORKER_RPC_PRIVATE_KEY=" + rpc.privateKey);
console.log("# public half — goes into /etc/codestation/daemon.json on every host:");
console.log("WORKER_RPC_PUBLIC_KEY=" + rpc.publicKey);
