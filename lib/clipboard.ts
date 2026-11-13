export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    // execCommand returns false when the browser refuses the copy (for
    // example after an async callback lost the user gesture). Reject so
    // callers do not show a false "copied" state.
    if (!document.execCommand("copy")) throw new Error("Copy command failed");
    return Promise.resolve();
  } catch {
    return Promise.reject(new Error("Copy failed"));
  } finally {
    ta.remove();
  }
}
