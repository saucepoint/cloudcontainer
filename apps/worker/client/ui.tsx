import { AlertDialog } from "@base-ui/react/alert-dialog";
import { animate } from "motion/mini";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { Confirmation } from "./confirmation.js";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
// motion/mini's animate() is Web Animations API-only. Without WAAPI (older
// webviews, enterprise animation policies, some headless browsers) every call
// throws, so feature-detect once and degrade to static presentation instead
// of crashing the shared bundle at module scope.
const animationsAvailable = typeof Element.prototype.animate === "function";

function reveal(elements: Element | Element[] | NodeListOf<Element>): void {
  if (reducedMotion.matches || !animationsAvailable) return;
  const targets = elements instanceof Element ? [elements] : Array.from(elements);
  if (targets.length === 0) return;
  animate(
    targets,
    { opacity: [0, 1], transform: ["translateY(6px)", "translateY(0)"] },
    {
      duration: 0.28,
      delay: targets.length > 1 ? (index) => index * 0.035 : 0,
      ease: [0.22, 1, 0.36, 1],
    },
  );
}

const detailAnimations = new WeakMap<HTMLDetailsElement, ReturnType<typeof animate>>();

function collapsedDetailsHeight(details: HTMLDetailsElement, summary: HTMLElement): number {
  const styles = getComputedStyle(details);
  return summary.getBoundingClientRect().height
    + Number.parseFloat(styles.paddingTop)
    + Number.parseFloat(styles.paddingBottom);
}

function animateDetailsToggle(
  event: MouseEvent,
  details: HTMLDetailsElement,
  summary: HTMLElement,
): void {
  if (event.defaultPrevented || reducedMotion.matches || !animationsAvailable) return;
  event.preventDefault();
  if (detailAnimations.has(details)) return;

  const startHeight = details.getBoundingClientRect().height;
  const opening = !details.open;
  if (opening) details.open = true;
  const endHeight = opening
    ? details.getBoundingClientRect().height
    : collapsedDetailsHeight(details, summary);

  details.style.height = `${startHeight}px`;
  details.style.overflow = "hidden";
  const animation = animate(
    details,
    { height: [`${startHeight}px`, `${endHeight}px`] },
    { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
  );
  detailAnimations.set(details, animation);

  const reset = () => {
    if (detailAnimations.get(details) !== animation) return;
    detailAnimations.delete(details);
    details.style.height = "";
    details.style.overflow = "";
  };
  void animation.finished.then(() => {
    if (!opening) details.open = false;
    reset();
  }, reset);
}

function showToast(message: string): void {
  document.querySelector(".site-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "site-toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 2400);
}

async function copyContactAddress(address: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(address);
    showToast("Email copied to clipboard");
  } catch {
    showToast("Could not copy email");
  }
}

function wireContactLinks(): void {
  document.querySelectorAll<HTMLAnchorElement>("[data-contact-code]").forEach((link) => {
    const code = link.dataset.contactCode;
    if (!code) return;
    const codePoints = code.split(",").map(Number);
    if (codePoints.length === 0 || codePoints.some((point) => !Number.isInteger(point) || point < 0 || point > 0x10ffff)) return;
    const address = String.fromCodePoint(...codePoints);
    link.href = `mailto:${address}`;
    link.removeAttribute("data-contact-code");
    link.addEventListener("click", () => {
      void copyContactAddress(address);
    });
  });
}

function ConfirmationDialog(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState<Confirmation>({
    title: "Confirm action",
    description: "This action cannot be undone.",
    confirmLabel: "Continue",
    onConfirm: () => undefined,
  });

  React.useEffect(() => {
    window.requestConfirmation = (nextConfirmation) => {
      setConfirmation(nextConfirmation);
      setOpen(true);
    };
    return () => {
      delete window.requestConfirmation;
    };
  }, []);

  const confirm = () => {
    setOpen(false);
    confirmation.onConfirm();
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="dialog-backdrop" />
        <AlertDialog.Viewport className="dialog-viewport">
          <AlertDialog.Popup className="dialog-popup">
            <AlertDialog.Title className="dialog-title">{confirmation.title}</AlertDialog.Title>
            <AlertDialog.Description className="dialog-description">
              {confirmation.description}
            </AlertDialog.Description>
            <div className="dialog-actions">
              <AlertDialog.Close className="btn secondary">Cancel</AlertDialog.Close>
              <AlertDialog.Close className={confirmation.danger ? "btn danger-solid" : "btn primary"} onClick={confirm}>
                {confirmation.confirmLabel}
              </AlertDialog.Close>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

const root = document.getElementById("ui-root");
if (root) createRoot(root).render(<ConfirmationDialog />);

wireContactLinks();

reveal(document.querySelectorAll("main > h1, main > .lead, main > .landing-hero, main > .card, main > form > .card"));

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const summary = target.closest("summary");
  if (!(summary instanceof HTMLElement) || !(summary.parentElement instanceof HTMLDetailsElement)) return;
  animateDetailsToggle(event, summary.parentElement, summary);
});
