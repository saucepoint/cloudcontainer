import { CredentialRequest, IDKit, type IDKitRequestConfig } from "@worldcoin/idkit-core";
import qrcode from "qrcode-terminal";
import type { ApiClient } from "./http.js";

type WorldIdRequest = IDKitRequestConfig & { signal: string };

export async function verifyWithWorldId(api: ApiClient): Promise<void> {
  const response = await api.post<WorldIdRequest>("/api/account/world-id/request");
  const { signal, ...config } = response;
  const request = await IDKit.requestWithInviteCode(config)
    .constraints(CredentialRequest("proof_of_human", { signal }));
  if (!request.connectorURI) throw new Error("World ID did not return a QR connector URI.");

  console.log("\nScan this QR code with World App and approve the request:\n");
  qrcode.generate(request.connectorURI, { small: true });
  console.log("\nWaiting for World ID approval…");
  const completion = await request.pollUntilCompletion({ pollInterval: 1_000, timeout: 15 * 60_000 });
  if (!completion.success) throw new Error(`World ID verification failed (${completion.error}).`);
  console.log("World ID approved. Confirming proof…");
  await api.post("/api/account/world-id/verify", completion.result);
}
