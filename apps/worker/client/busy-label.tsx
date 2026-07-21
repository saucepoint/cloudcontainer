import type { ReactNode } from "react";

export function BusyLabel({ busy, children }: { busy: boolean; children: ReactNode }) {
  return <>{busy ? <span className="spinner" aria-hidden="true" /> : null}{children}</>;
}
