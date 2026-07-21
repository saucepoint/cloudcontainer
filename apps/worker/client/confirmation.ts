export interface Confirmation {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
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
): void {
  if (window.requestConfirmation) {
    window.requestConfirmation({ title, description, confirmLabel, onConfirm });
  } else if (confirm(description)) {
    onConfirm();
  }
}
