import { readFileSync } from "node:fs";
import { HOST_TYPES, type HostType } from "@workbench/contract";

export interface DaemonConfig {
  hostId: string;
  hostType: HostType;
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

function isBase64Key32(value: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(value);
}

const DEFAULT_PATH = "/etc/workbench/daemon.json";

export function loadConfig(path = process.env.WB_DAEMON_CONFIG ?? DEFAULT_PATH): DaemonConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonConfig>;
  for (const key of ["hostId", "workerRpcPublicKey", "x25519PrivateKey"] as const) {
    if (!raw[key]) throw new Error(`daemon config missing required field: ${key}`);
  }
  if (!isBase64Key32(raw.workerRpcPublicKey!)) {
    throw new Error("daemon config workerRpcPublicKey must encode exactly 32 bytes");
  }
  if (!isBase64Key32(raw.x25519PrivateKey!)) {
    throw new Error("daemon config x25519PrivateKey must encode exactly 32 bytes");
  }
  if (typeof raw.hostId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.hostId)) {
    throw new Error("invalid daemon hostId");
  }
  const hostType = raw.hostType ?? "budget";
  if (!HOST_TYPES.includes(hostType)) throw new Error(`invalid daemon host type: ${hostType}`);
  const listenPort = raw.listenPort ?? 8443;
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error("invalid daemon listenPort");
  }
  const baseImage = raw.baseImage ?? "workbench-base";
  const storagePool = raw.storagePool ?? "default";
  const project = raw.project ?? "default";
  for (const [name, value] of Object.entries({ baseImage, storagePool, project })) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`invalid daemon ${name}`);
    }
  }
  if ((raw.tlsCertPath === undefined) !== (raw.tlsKeyPath === undefined)) {
    throw new Error("daemon TLS certificate and key paths must be configured together");
  }
  if (
    (raw.tlsCertPath !== undefined &&
      (typeof raw.tlsCertPath !== "string" || raw.tlsCertPath.length === 0)) ||
    (raw.tlsKeyPath !== undefined &&
      (typeof raw.tlsKeyPath !== "string" || raw.tlsKeyPath.length === 0))
  ) {
    throw new Error("invalid daemon TLS path");
  }
  return {
    hostId: raw.hostId!,
    hostType,
    listenPort,
    workerRpcPublicKey: raw.workerRpcPublicKey!,
    x25519PrivateKey: raw.x25519PrivateKey!,
    baseImage,
    storagePool,
    // Keep existing daemon configs compatible. New hosts explicitly select the
    // restricted `workbench` project during bootstrap.
    project,
    ...(raw.tlsCertPath ? { tlsCertPath: raw.tlsCertPath } : {}),
    ...(raw.tlsKeyPath ? { tlsKeyPath: raw.tlsKeyPath } : {}),
  };
}
