/** Print a fresh X25519 keypair for this host as JSON. Used by infra/bootstrap.sh. */
import { generateX25519Keypair } from "@workbench/contract";

console.log(JSON.stringify(generateX25519Keypair()));
