import { readFileSync } from "node:fs";

export interface DaemonConfig {
  hostId: string;
  listenPort: number;
  /** Ed25519 public key (base64) of the control-plane Worker; verifies signed RPCs. */
  workerRpcPublicKey: string;
  /** X25519 private key (base64); credential payloads are sealed to its public half. */
  x25519PrivateKey: string;
  /** Incus image alias used for provisioning (built by infra/build-image.sh). */
  baseImage: string;
  storagePool: string;
  /** Dedicated Incus project containing only service-managed tenant instances. */
  project: string;
  /** Optional TLS material; when absent the daemon serves plain HTTP (dev only). */
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

const DEFAULT_PATH = "/etc/codestation/daemon.json";

export function loadConfig(path = process.env.CS_DAEMON_CONFIG ?? DEFAULT_PATH): DaemonConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonConfig>;
  for (const key of ["hostId", "workerRpcPublicKey", "x25519PrivateKey"] as const) {
    if (!raw[key]) throw new Error(`daemon config missing required field: ${key}`);
  }
  return {
    hostId: raw.hostId!,
    listenPort: raw.listenPort ?? 8443,
    workerRpcPublicKey: raw.workerRpcPublicKey!,
    x25519PrivateKey: raw.x25519PrivateKey!,
    baseImage: raw.baseImage ?? "codestation-base",
    storagePool: raw.storagePool ?? "default",
    // Keep existing daemon configs compatible. New hosts explicitly select the
    // restricted `codestation` project during bootstrap.
    project: raw.project ?? "default",
    tlsCertPath: raw.tlsCertPath,
    tlsKeyPath: raw.tlsKeyPath,
  };
}
