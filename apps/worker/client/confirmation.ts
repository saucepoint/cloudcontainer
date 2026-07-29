export interface Confirmation {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  /** Render the confirm button as a solid destructive action. */
  danger?: boolean;
}

declare global {
  interface Window {
    requestConfirmation?: (confirmation: Confirmation) => void;
  }
}

export function askConfirmation(
  title: string,
  description: string,
  confirmLabel: string,
  onConfirm: () => void,
  danger = false,
): void {
  if (window.requestConfirmation) {
    window.requestConfirmation({ title, description, confirmLabel, onConfirm, danger });
  } else if (confirm(description)) {
    onConfirm();
  }
}
