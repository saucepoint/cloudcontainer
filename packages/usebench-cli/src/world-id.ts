import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CredentialRequest, IDKit, type IDKitRequestConfig } from "@worldcoin/idkit-core";
import qrcode from "qrcode-terminal";
import type { ApiClient } from "./http.js";

type WorldIdRequest = IDKitRequestConfig & { signal: string };

function wasmFileUrl(input: RequestInfo | URL): URL | null {
  const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  return url.protocol === "file:" && url.pathname.endsWith("/idkit_wasm_bg.wasm") ? url : null;
}

/** IDKit's generated WASM loader uses fetch(), which cannot read Node file URLs. */
export async function withNodeWasmFetch<T>(operation: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = wasmFileUrl(input);
    if (!url) return originalFetch(input, init);
    const body = await readFile(fileURLToPath(url));
    return new Response(body, {
      headers: { "content-type": "application/wasm" },
    });
  };
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function verifyWithWorldId(api: ApiClient): Promise<void> {
  const response = await api.post<WorldIdRequest>("/api/account/world-id/request");
  const { signal, ...config } = response;
  const request = await withNodeWasmFetch(() => IDKit.requestWithInviteCode(config)
    .constraints(CredentialRequest("proof_of_human", { signal })));
  if (!request.connectorURI) throw new Error("World ID did not return a QR connector URI.");

  console.log("\nScan this QR code with World App and approve the request:\n");
  qrcode.generate(request.connectorURI, { small: true });
  console.log("\nWaiting for World ID approval…");
  const completion = await request.pollUntilCompletion({ pollInterval: 1_000, timeout: 15 * 60_000 });
  if (!completion.success) throw new Error(`World ID verification failed (${completion.error}).`);
  console.log("World ID approved. Confirming proof…");
  await api.post("/api/account/world-id/verify", completion.result);
}
