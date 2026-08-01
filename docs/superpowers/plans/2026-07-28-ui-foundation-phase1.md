# Kontexta Web UI — Phase 1: Foundation & Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Kontexta web app shared UI primitives (Dialog, ConfirmDialog, Dropdown, Toast, `.btn-primary`), full token discipline across all three themes, and fix every "actually broken" bug — with a feedback policy of no `alert()`, no silent failures.

**Architecture:** New `src/components/ui/` primitives built on Radix (headless) + sonner, styled exclusively with the existing CSS-variable tokens in `globals.css`. Existing hand-rolled modals/dropdowns/toasts migrate onto the primitives. Color usage in TSX is swept onto tokens so light/dark/Blueprint all render correctly.

**Tech Stack:** Next.js 15 (App Router), React 19, Tailwind 3.4, `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `sonner`, `lucide-react` (already installed), vitest + @testing-library/react (jsdom via `// @vitest-environment jsdom` pragma).

**Spec:** `docs/superpowers/specs/2026-07-28-ui-foundation-phase1-design.md`

## Global Constraints

- Working directory for all paths below: `apps/web` (e.g. `src/app/globals.css` = `apps/web/src/app/globals.css`). Run commands from repo root.
- Test command: `pnpm --filter kxta-web test` (vitest, jsdom per-file pragma). Build check: `pnpm --filter kxta-web build`.
- Component tests start with `// @vitest-environment jsdom`, use `@testing-library/react`, `afterEach(() => cleanup())` (see `src/components/docs/save-bar.test.tsx` for the house style).
- **Never add `Co-Authored-By` trailers to commits.** Commit as `safiyu <dheensafiyu@gmail.com>`.
- **Do not revert or fight uncommitted work in progress:** `src/components/content/content-pane.tsx`, `apps/publish/src/render/pdf.ts`, `src/app/api/files/[id]/export-pdf/` have uncommitted changes (PDF export feature). When a task touches `content-pane.tsx`, read its CURRENT working-tree state first and apply changes on top. Do not `git checkout`/`git restore` these files. When committing, stage only the files your task changed (`git add <specific paths>`, never `git add -A`).
- All three themes are first-class: light (`:root`, warm cream), dark (`.dark`, navy/gold), Blueprint (`.blueprint`, near-black/orange). `darkMode: ["class", ":is(.dark, .blueprint)"]` — every `dark:` utility also fires under Blueprint.
- Colors in TSX must come from tokens: CSS vars (`var(--accent)` etc.) or the Tailwind aliases (`amber-accent`, `surface-*`). No new hex literals in `.tsx` files.
- Line numbers cited below were verified 2026-07-28; treat them as anchors, not gospel — locate by the quoted code.
- `.mmd`/docs copy: sentence case for dialog titles and buttons (no ALL-CAPS in new code).

---

### Task 1: Token groundwork in globals.css + tailwind.config

**Files:**
- Modify: `src/app/globals.css`
- Modify: `tailwind.config.ts`

**Interfaces:**
- Produces (used by all later tasks): CSS vars `--text-tertiary`, `--z-dropdown` (60), `--z-modal` (100), `--z-toast` (150); CSS classes `.btn-primary`, `.scrollbar-thin`; fixed `.glass`; Blueprint select chevron.

- [ ] **Step 1: Add missing tokens to the three theme blocks**

In `src/app/globals.css`, add to `:root` (after `--danger: #C05656;` line 21):

```css
  --text-tertiary: #6B7A99;

  /* Layering scale — use z-[var(--z-*)] in components. */
  --z-dropdown: 60;
  --z-modal: 100;
  --z-toast: 150;
```

Add to `.dark` (after its `--danger` line 39): `--text-tertiary: #A08662;`
Add to `.blueprint` (after its `--danger` line 57): `--text-tertiary: #8E8270;`
(The z-scale vars are inherited from `:root`; do not repeat them.)

- [ ] **Step 2: Fix `.glass` and define `.scrollbar-thin`**

Replace (line ~256):

```css
.glass {
  background-color: var(--bg-secondary);
  backdrop-filter: blur(12px) saturate(180%);
  -webkit-backdrop-filter: blur(12px) saturate(180%);
  background-opacity: 0.8;
}
```

with:

```css
.glass {
  background-color: color-mix(in srgb, var(--bg-secondary) 80%, transparent);
  backdrop-filter: blur(12px) saturate(180%);
  -webkit-backdrop-filter: blur(12px) saturate(180%);
}
```

After the existing `.dark *` scrollbar rule (line ~165), add:

```css
/* Referenced by components; scrollbars are already thin globally, this
   class exists so the reference is real and can be tuned later. */
.scrollbar-thin { scrollbar-width: thin; }
```

- [ ] **Step 3: Add `.btn-primary` and pin `.btn-destructive` to the danger token**

After the `.btn-icon-md` size rules (line ~389), add:

```css
/* Primary role — solid accent. Replaces ad-hoc `!text-amber-accent` and
   docs-area solid-accent buttons. */
.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #FFFFFF;
}
.dark .btn-primary,
.blueprint .btn-primary {
  color: #FFFFFF;
}
.btn-primary:hover,
.btn-primary:active,
.btn-primary:focus {
  background: color-mix(in srgb, var(--accent) 82%, black);
  color: #FFFFFF;
}
.btn-primary:disabled:hover,
.btn-primary:disabled:active,
.btn-primary:disabled:focus {
  background: var(--accent);
  color: #FFFFFF;
}
```

In the destructive block (line ~392), replace the hex literals with the token:

```css
.btn-destructive { color: var(--danger); }

.btn-destructive:hover,
.btn-destructive:active,
.btn-destructive:focus {
  color: #ffffff;
  background: color-mix(in srgb, var(--danger) 85%, transparent);
}

.dark .btn-destructive:hover,
.dark .btn-destructive:active,
.dark .btn-destructive:focus {
  color: #ffffff;
  background: color-mix(in srgb, var(--danger) 85%, transparent);
}

.btn-destructive:disabled:hover,
.btn-destructive:disabled:active,
.btn-destructive:disabled:focus {
  color: var(--danger);
  background: transparent;
}
```

- [ ] **Step 4: Theme the `<select>` chevron for Blueprint; fix stale comment**

The `select` rule (line ~312) bakes `%23B4781E` into a data URI and its comment says "coral". Change the comment to `/* Themed <select> — strip browser chrome, replace with accent chevron, theme options. */` and add after the `option` rule:

```css
/* Blueprint uses the ember-orange accent for the chevron. */
.blueprint select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='%23E09030'%3E%3Cpath d='M2 4 L6 8 L10 4 Z'/%3E%3C/svg%3E");
}
```

- [ ] **Step 5: Verify build and existing tests**

Run: `pnpm --filter kxta-web build && pnpm --filter kxta-web test`
Expected: build succeeds, all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/globals.css apps/web/tailwind.config.ts
git commit -m "feat(web): token groundwork — text-tertiary, z-scale, btn-primary, glass/scrollbar/chevron fixes"
```

(If `tailwind.config.ts` needed no change, commit only globals.css.)

---

### Task 2: Install deps; mount sonner Toaster; migrate the two ad-hoc toasts

**Files:**
- Modify: `package.json` (apps/web, via pnpm)
- Modify: `src/app/layout.tsx`
- Modify: `src/components/layout/top-bar.tsx` (reindex toast, lines 46–76, 269–276)
- Modify: `src/app/home-client.tsx` (publish toast, lines 40, 671, 674–721)

**Interfaces:**
- Produces: `toast` from `"sonner"` usable anywhere client-side; `<Toaster>` mounted once in root layout. Later tasks call `toast.success(msg)`, `toast.error(msg)`, `toast(msg, { description, action })`.

- [ ] **Step 1: Install dependencies (all three now, used by Tasks 2–8)**

Run: `pnpm --filter kxta-web add sonner @radix-ui/react-dialog @radix-ui/react-dropdown-menu`
Expected: lockfile updated, no peer warnings blocking install.

- [ ] **Step 2: Mount `<Toaster>` in the root layout**

Read `src/app/layout.tsx`. Inside the `<body>`, after `{children}` (inside the ThemeProvider so CSS vars apply), add:

```tsx
import { Toaster } from "sonner";
// ... in the JSX, sibling after {children}:
<Toaster
  position="bottom-right"
  gap={8}
  offset={24}
  toastOptions={{
    style: {
      background: "var(--bg-secondary)",
      color: "var(--text-primary)",
      border: "1px solid var(--border)",
    },
    className: "text-sm",
  }}
/>
```

- [ ] **Step 3: Migrate the reindex toast in top-bar.tsx**

In `src/components/layout/top-bar.tsx`:
- Delete `const [reindexToast, setReindexToast] = useState<string | null>(null);` (line 48) and the `{reindexToast && (...)}` JSX block (lines 269–276).
- Add `import { toast } from "sonner";`
- Rewrite `handleReindex` result handling (keep the fetch logic):

```tsx
const handleReindex = async () => {
  if (reindexing) return;
  setReindexing(true);
  try {
    const res = await fetch("/api/reindex", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.success) {
      const t = body.totals ?? { newly_indexed: 0, refreshed: 0, pruned: 0, errors: 0 };
      toast.success(
        `Reindexed ${body.scopes?.length ?? 0} scope(s) in ${body.duration_ms ?? "?"}ms — ` +
        `+${t.newly_indexed} new, ${t.refreshed} updated, ${t.pruned} removed` +
        (t.errors ? `, ${t.errors} scope error(s)` : ""),
      );
    } else if (res.status === 409) {
      toast.error("Reindex already in progress");
    } else {
      toast.error(`Reindex failed: ${body?.error ?? `HTTP ${res.status}`}`);
    }
  } catch (e: any) {
    toast.error(`Reindex failed: ${e?.message ?? "Network error"}`);
  } finally {
    setReindexing(false);
  }
};
```

- [ ] **Step 4: Migrate the publish toast in home-client.tsx**

In `src/app/home-client.tsx`:
- Delete `const [publishToast, setPublishToast] = useState<PublishResult | null>(null);` (line 40) and the entire `{publishToast && (...)}` JSX block (lines 674–721).
- Add `import { toast } from "sonner";`
- Change the `onPublishSuccess` prop (line 671) to:

```tsx
onPublishSuccess={(r) =>
  toast.success("Publish successful", {
    duration: Infinity,
    description: [
      `${r.docCount ?? 0} docs`,
      r.endpointCount ? `${r.endpointCount} endpoints` : null,
      r.termCount ? `${r.termCount} terms` : null,
      r.output ?? null,
    ]
      .filter(Boolean)
      .join(" · "),
    action: {
      label: "View Published",
      onClick: () => window.open("/api/publish/html", "_blank", "noopener,noreferrer"),
    },
  })
}
```

(`PublishResult` import stays — it's still the callback's parameter type. sonner's persistent toast keeps a built-in close button via `closeButton`; add `closeButton` to the options object so it can be dismissed.)

- [ ] **Step 5: Verify**

Run: `pnpm --filter kxta-web test && pnpm --filter kxta-web build`
Expected: PASS. Then quick smoke via dev server if convenient (reindex button → toast bottom-right).

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/app/layout.tsx apps/web/src/components/layout/top-bar.tsx apps/web/src/app/home-client.tsx
git commit -m "feat(web): sonner toast system; migrate reindex and publish toasts"
```

---

### Task 3: Feedback policy — replace every alert()/silent failure with toasts; create-file surfaces + auto-opens

**Files:**
- Modify: `src/app/home-client.tsx` (handlers at lines 92–113, 282–304, 373–398, 400–413, 415–444, 452–472)
- Modify: `src/components/file-list/file-item.tsx` (download alerts, lines 134, 150)
- Modify: `src/components/file-list/file-list.tsx` (folder-delete alert ~line 362; bulk-delete failure alert)
- Modify: `src/components/content/content-pane.tsx` (alerts ~lines 151, 168 — CURRENT working-tree state; do not revert PDF work)
- Modify: `src/components/docs/onboard-modal.tsx` (alerts ~lines 41, 44)
- Modify (maybe): `src/app/api/files/route.ts` (POST must return created file id)

**Interfaces:**
- Consumes: `toast` from Task 2.
- Produces: `handleCreateFile` selects the new file after creation (calls existing `handleSelectFile(id)`).

- [ ] **Step 1: Check the create-file API response**

Read `src/app/api/files/route.ts` (POST handler). If the success response does not include the created file's `id`, add it (the MCP/core layer returns created metadata — pass `id` through as `{ id: ..., ... }`).

- [ ] **Step 2: home-client.tsx — rewrite the silent/alert handlers**

`handleCreateFile` (lines 373–398) becomes:

```tsx
const handleCreateFile = async (
  title: string,
  content: string,
  destination: "knowledge" | "project" | "kontexta",
  folder?: string
) => {
  try {
    const response = await fetch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content, destination, projectId: selectedProjectId, folder }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      setNewFileOpen(false);
      toast.success(`Created "${title}"`);
      await refreshAllFiles();
      if (typeof data.id === "number") setSelectedFileId(data.id);
    } else {
      toast.error(data.error || "Failed to create file");
    }
  } catch (error: any) {
    toast.error(`Failed to create file: ${error?.message ?? "Network error"}`);
  }
};
```

Note: select via `setSelectedFileId(data.id)` directly (not `handleSelectFile`) because `allFiles` may not contain the new file until the refresh lands; ContentPane fetches by id independently, and the next `allFiles` update fixes the breadcrumb.

Apply the same pattern (toast.error on `!response.ok` + catch; toast.success on mutation success) to:
- `handleDeleteFile` (400–413): success → `toast.success("File deleted")`; failure → `toast.error(...)`.
- `handleCreateFolder` (415–444): success → `toast.success(\`Folder "${name}" created\`)`; failure → toast.error with server `data.error`.
- `onConfirmDeleteFolder` (452–472): replace `alert(data.error || "Failed to delete folder")` with `toast.error(...)`; catch → toast.error; success → `toast.success("Folder deleted")`.
- `handleRefresh` (282–304): remove `console.log` (line 283); replace `alert(data.error || "Refresh failed")` with toast.error; catch → toast.error; success → `toast.success("Index refreshed")`.
- `handleUnregisterProject` (92–113): replace `alert(...)` with toast.error; catch → toast.error; success → `toast.success("Project unregistered")`.

- [ ] **Step 3: file-item.tsx download errors**

Replace both `alert(\`Download failed: ...\`)` calls (lines 134, 150) with `toast.error(...)` (add the sonner import).

- [ ] **Step 4: file-list.tsx folder-delete + bulk-delete errors**

Read `src/components/file-list/file-list.tsx`. Replace the `alert(...)` at ~line 362 and the bulk-delete failure `alert(...)` with `toast.error(...)`; add `toast.success(\`Deleted ${okCount} file(s)\`)` after a bulk delete completes (report partial failures: `toast.error(\`${failCount} file(s) failed to delete\`)` when `failCount > 0`).

- [ ] **Step 5: content-pane.tsx alerts (careful — uncommitted PDF work)**

Read the CURRENT `src/components/content/content-pane.tsx`. Replace the `alert(...)` calls (~lines 151, 168 in the pre-change file; there may be more in the new PDF-export code — sweep `grep -n "alert(" src/components/content/content-pane.tsx`) with `toast.error(...)`. Add success toasts: after a successful save (`toast.success("Saved")`), successful restore (`toast.success("Restored from history")`), successful export/download.

- [ ] **Step 6: onboard-modal.tsx**

Replace the two `alert(...)` calls (~lines 41, 44) with `toast.error(...)`.

- [ ] **Step 7: Verify no alert() remains and tests pass**

Run: `grep -rn "alert(" apps/web/src --include="*.tsx" | grep -v "test"`
Expected: no hits (or only genuinely non-UI matches — there should be none).
Run: `pnpm --filter kxta-web test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/home-client.tsx apps/web/src/components/file-list/file-item.tsx apps/web/src/components/file-list/file-list.tsx apps/web/src/components/content/content-pane.tsx apps/web/src/components/docs/onboard-modal.tsx apps/web/src/app/api/files/route.ts
git commit -m "feat(web): route all action feedback through toasts; surface create-file failures; auto-open created file"
```

---

### Task 4: Dialog + ConfirmDialog primitives (with tests)

**Files:**
- Create: `src/components/ui/dialog.tsx`
- Create: `src/components/ui/confirm-dialog.tsx`
- Test: `src/components/ui/dialog.test.tsx`

**Interfaces:**
- Produces:
  - `Dialog({ open, onClose, title, description?, widthClass?, hideHeader?, children }: { open: boolean; onClose: () => void; title: string; description?: string; widthClass?: string; hideHeader?: boolean; children: React.ReactNode })`
  - `ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel?, cancelLabel?, destructive?, loading? }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; message: React.ReactNode; confirmLabel?: string; cancelLabel?: string; destructive?: boolean; loading?: boolean })`

- [ ] **Step 1: Write the failing tests**

`src/components/ui/dialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Dialog } from "./dialog";
import { ConfirmDialog } from "./confirm-dialog";

afterEach(() => cleanup());

describe("Dialog", () => {
  it("renders nothing when closed", () => {
    render(<Dialog open={false} onClose={() => {}} title="T"><p>body</p></Dialog>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders role=dialog with title and children when open", () => {
    render(<Dialog open onClose={() => {}} title="My Title"><p>body text</p></Dialog>);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("My Title")).toBeTruthy();
    expect(screen.getByText("body text")).toBeTruthy();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="T"><p>b</p></Dialog>);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("has a close button that calls onClose", () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="T"><p>b</p></Dialog>);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ConfirmDialog", () => {
  it("renders title, message, and calls onConfirm", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open onClose={() => {}} onConfirm={onConfirm} title="Delete file?" message="This is recoverable via Time Travel." />
    );
    expect(screen.getByText("This is recoverable via Time Travel.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("uses destructive styling and custom labels", () => {
    render(
      <ConfirmDialog open onClose={() => {}} onConfirm={() => {}} title="T" message="m" confirmLabel="Delete" destructive />
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.className).toMatch(/btn-destructive/);
  });

  it("cancel button calls onClose", () => {
    const onClose = vi.fn();
    render(<ConfirmDialog open onClose={onClose} onConfirm={() => {}} title="T" message="m" />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter kxta-web test -- src/components/ui/dialog.test.tsx`
Expected: FAIL — cannot resolve `./dialog`.

- [ ] **Step 3: Implement `src/components/ui/dialog.tsx`**

```tsx
"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Required for accessibility. Hidden visually when hideHeader is set. */
  title: string;
  description?: string;
  /** Tailwind max-width class for the panel. */
  widthClass?: string;
  /** Hide the standard header row (title still announced to screen readers). */
  hideHeader?: boolean;
  children: ReactNode;
}

/**
 * The one modal scaffold. Focus trap, Escape, overlay click, focus restore,
 * and dialog semantics come from Radix. Styling comes from theme tokens.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  widthClass = "max-w-md",
  hideHeader = false,
  children,
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-black/60 backdrop-blur-sm animate-fade-in" />
        <DialogPrimitive.Content
          className={`fixed left-1/2 top-1/2 z-[var(--z-modal)] w-[92vw] ${widthClass} -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-2xl animate-scale-in focus:outline-none max-h-[85vh] flex flex-col`}
        >
          {hideHeader ? (
            <>
              <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
              <DialogPrimitive.Close
                className="btn btn-icon-sm absolute right-3 top-3 z-10"
                aria-label="Close"
              >
                <X className="w-4 h-4" aria-hidden />
              </DialogPrimitive.Close>
            </>
          ) : (
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--border)] shrink-0">
              <DialogPrimitive.Title className="text-sm font-bold text-[var(--text-primary)] font-title">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close className="btn btn-icon-sm" aria-label="Close">
                <X className="w-4 h-4" aria-hidden />
              </DialogPrimitive.Close>
            </div>
          )}
          {description ? (
            <DialogPrimitive.Description className="px-5 pt-3 text-xs text-[var(--text-secondary)]">
              {description}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
          <div className="p-5 overflow-y-auto">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
```

- [ ] **Step 4: Implement `src/components/ui/confirm-dialog.tsx`**

```tsx
"use client";

import type { ReactNode } from "react";
import { Dialog } from "./dialog";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  loading = false,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="text-sm text-[var(--text-secondary)]">{message}</div>
      <div className="flex justify-end gap-2 mt-5">
        <button type="button" className="btn btn-md" onClick={onClose} disabled={loading}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`btn btn-md ${destructive ? "btn-destructive" : "btn-primary"}`}
          onClick={onConfirm}
          disabled={loading}
        >
          {loading ? "…" : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter kxta-web test -- src/components/ui/dialog.test.tsx`
Expected: PASS. (If the Escape test fails because Radix listens on document, change the test to `fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })` — Radix traps focus inside the content, so the active element is within the dialog.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ui/
git commit -m "feat(web): Dialog and ConfirmDialog primitives on Radix with tests"
```

---

### Task 5: Migrate content-area dialogs to the primitives; unify delete copy

**Files:**
- Modify: `src/components/content/new-file-dialog.tsx`
- Modify: `src/components/folder-tree/new-folder-dialog.tsx`
- Modify: `src/components/folder-tree/delete-folder-dialog.tsx`
- Modify: `src/components/content/delete-confirm-dialog.tsx`
- Modify: `src/components/content/git-error-dialog.tsx`
- Modify: `src/components/file-list/unregister-modal.tsx`
- Modify: `src/components/about/about-dialog.tsx`

**Interfaces:**
- Consumes: `Dialog`, `ConfirmDialog` from Task 4; `toast` from Task 2.
- Produces: unchanged public props for each dialog component (parents don't change except where noted).

- [ ] **Step 1: Migrate each dialog**

For each file: read it, keep its public props and inner form/content, replace the hand-rolled overlay/panel scaffolding (`fixed inset-0 ... z-[100]` divs) with the `Dialog` primitive. Specifics:

- `new-file-dialog.tsx`: wrap the existing form in `<Dialog open={open} onClose={onClose} title="New file" widthClass="max-w-lg">`. While here: replace the `var(--border-color)` references with `var(--border)` and the hardcoded label colors `#475569`/`#94A3B8` with `text-[var(--text-secondary)]`. Reset `title`/`content` state when the dialog opens (mirror the existing folder/destination reset effect).
- `new-folder-dialog.tsx`: use `Dialog` with title "New folder". Fix the copy "Folder will be created in the project root" → "Folder will be created in the Knowledge Base" (this dialog is only reachable for the KB today).
- `delete-folder-dialog.tsx`: replace with `ConfirmDialog` usage (destructive, confirmLabel "Delete folder", loading passthrough).
- `delete-confirm-dialog.tsx`: replace with `ConfirmDialog` (destructive). **Copy change** — message becomes:
  "Delete \"{title}\"? Knowledge Base files are recoverable from git history (Time Travel). Project files are only removed from the index — the file on disk is untouched."
- `unregister-modal.tsx`: `ConfirmDialog` (destructive, confirmLabel "Unregister"). Message keeps its existing explanation text.
- `git-error-dialog.tsx`: keep as a component but rebuild on `Dialog`. Title comes from a new optional prop `title?: string` defaulting to "Save failed" — the misleading hardcoded "Git Auto-Commit Failed / Partial Success" header only shows when the caller passes it explicitly (content-pane's git-warning path). The 409-conflict caller keeps its existing message body but under title "File changed on disk" (pass from content-pane; read content-pane's current call sites and pass appropriate titles).
- `about-dialog.tsx`: rebuild on `Dialog` (`widthClass="max-w-xl"`). Replace all `var(--border-color)` with `var(--border)`. Replace the changelog `[&_*]:!text-[#F5C97A]`-style hacks (if present at read time) with token classes.

- [ ] **Step 2: Run tests**

Run: `pnpm --filter kxta-web test`
Expected: PASS (docs-modal tests unaffected; if any test asserts old markup of these dialogs, update it to query by role/name).

- [ ] **Step 3: Manual smoke**

Run dev server briefly: open each dialog (new file, new folder, delete file, about, unregister) — Escape closes, overlay click closes, focus lands inside.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/content/ apps/web/src/components/folder-tree/new-folder-dialog.tsx apps/web/src/components/folder-tree/delete-folder-dialog.tsx apps/web/src/components/file-list/unregister-modal.tsx apps/web/src/components/about/about-dialog.tsx
git commit -m "refactor(web): content-area dialogs on Dialog/ConfirmDialog primitives; truthful delete copy"
```

---

### Task 6: Migrate search, publish, docs-modal, onboard + bulk-delete confirm

**Files:**
- Modify: `src/components/search/search-dialog.tsx`
- Modify: `src/components/publish/publish-dialog.tsx`
- Modify: `src/components/docs/docs-modal.tsx`
- Modify: `src/components/docs/onboard-modal.tsx`
- Modify: `src/components/file-list/file-list.tsx` (bulk-delete confirm dialog, ~line 404)

**Interfaces:**
- Consumes: `Dialog`, `ConfirmDialog`, `toast`.

- [ ] **Step 1: search-dialog.tsx**

Rebuild the shell on `Dialog` with `hideHeader` (title "Search", `widthClass="max-w-[560px]"`). The fixed `w-[560px]` becomes `w-[92vw] max-w-[560px]` via Dialog's classes — no more tablet overflow. Keep the input/results/keyboard logic as-is, with two additions:
- On result buttons add `onMouseEnter={() => setSelectedIdx(idx)}` so hover and keyboard highlight can't diverge.
- Note: Dialog is centered; search wants top-anchored. Add an optional `positionClass` prop to `Dialog` (default `left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`; search passes `left-1/2 top-[20vh] -translate-x-1/2`). Update `dialog.tsx` accordingly and keep its tests green.
(The selected-row `text-white` styling is fixed in Task 10, not here.)

- [ ] **Step 2: publish-dialog.tsx, docs-modal.tsx, onboard-modal.tsx**

Read each; replace hand-rolled portal/overlay scaffolding with `Dialog`:
- `publish-dialog.tsx`: `widthClass` matching its current size.
- `docs-modal.tsx`: `widthClass="max-w-6xl"`, `hideHeader` (it has its own tab header row); the content area keeps `h-[85vh]` behavior via Dialog's `max-h-[85vh]` + internal layout. Verify `builder-section`'s `-m-6` padding escape still lines up with Dialog's `p-5` — adjust to `-m-5` if needed.
- `onboard-modal.tsx`: standard `Dialog`.

- [ ] **Step 3: file-list.tsx bulk-delete confirm → ConfirmDialog**

Replace the inline confirm dialog markup (~line 404) with `ConfirmDialog` (destructive, confirmLabel "Delete N files"). Keep the existing KB-vs-project explanation text as the message — it is already truthful.

- [ ] **Step 4: Run tests (docs-modal has tests)**

Run: `pnpm --filter kxta-web test`
Expected: PASS. `docs-modal.test.tsx` may query old markup — update queries to roles (`getByRole("dialog")`) as needed, without weakening assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/search/search-dialog.tsx apps/web/src/components/publish/publish-dialog.tsx apps/web/src/components/docs/docs-modal.tsx apps/web/src/components/docs/onboard-modal.tsx apps/web/src/components/file-list/file-list.tsx apps/web/src/components/ui/dialog.tsx apps/web/src/components/ui/dialog.test.tsx
git commit -m "refactor(web): search/publish/docs/onboard dialogs and bulk-delete confirm on primitives"
```

---

### Task 7: Migrate calendar dialogs + docs-area confirms; kill window.confirm on 409

**Files:**
- Modify: `src/components/calendar/event-dialog.tsx`
- Modify: `src/components/calendar/entity-manager.tsx`
- Modify: `src/components/docs/save-bar.tsx` (two duplicated confirm dialogs)
- Modify: `src/app/docs/builder/builder-section.tsx` (two confirm dialogs + `window.confirm` 409 + literal `**Save**` copy)

**Interfaces:**
- Consumes: `Dialog`, `ConfirmDialog`.

- [ ] **Step 1: event-dialog.tsx and entity-manager.tsx**

Rebuild both on `Dialog`. Titles become sentence case: "Edit event" / "New event", "Manage entities & links". Replace the two-click "Confirm" delete (3s timeout) in BOTH files with `ConfirmDialog` (destructive). Entity delete message must state the cascade: "Deleting an entity also deletes all of its events and links." Calendar-specific form content stays untouched.

- [ ] **Step 2: save-bar.tsx — dedupe its two confirm dialogs**

Both branches (inline pill and sticky bar) render near-identical discard-confirm portals. Replace both with one `ConfirmDialog` instance (destructive, title "Discard unsaved changes?", confirmLabel "Discard"). Update `save-bar.test.tsx` queries if they match old markup; keep assertions equivalent.

- [ ] **Step 3: builder-section.tsx**

- Replace both hand-rolled confirm dialogs with `ConfirmDialog`.
- Replace the `window.confirm` fallback in the 409 save path with a `ConfirmDialog` (state-driven: store the pending conflict, render `ConfirmDialog` with title "Config changed on disk", message explaining the conflict, confirmLabel "Overwrite").
- Fix the literal markdown copy: the delete-tool dialog message containing `click **Save** in the top bar` becomes plain text: `This removes the tool from the draft. Click Save in the top bar to apply.`

- [ ] **Step 4: Run tests**

Run: `pnpm --filter kxta-web test`
Expected: PASS (update `save-bar.test.tsx` / builder-related tests for the new dialog markup — query by role and accessible name).

- [ ] **Step 5: Verify no window.confirm remains outside the nav guard**

Run: `grep -rn "window.confirm" apps/web/src --include="*.tsx"`
Expected: only `home-client.tsx` `confirmDiscardIfDirty` (the unsaved-navigation guard — Phase 2 scope) remains.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/calendar/event-dialog.tsx apps/web/src/components/calendar/entity-manager.tsx apps/web/src/components/docs/save-bar.tsx apps/web/src/components/docs/save-bar.test.tsx apps/web/src/app/docs/builder/builder-section.tsx
git commit -m "refactor(web): calendar/docs confirms on ConfirmDialog; replace 409 window.confirm; fix literal markdown copy"
```

---

### Task 8: DropdownMenu primitive + migrate the three hand-rolled menus

**Files:**
- Create: `src/components/ui/dropdown-menu.tsx`
- Test: `src/components/ui/dropdown-menu.test.tsx`
- Modify: `src/components/layout/top-bar.tsx` (publish menu, lines 83–89, 171–215)
- Modify: `src/components/content/content-pane.tsx` (export menu — read current state first)
- Modify: `src/components/file-list/file-list.tsx` (New ▾ menu and any other ref-based menus)

**Interfaces:**
- Produces: `DropdownMenu({ trigger, items, align? }: { trigger: ReactNode; items: { label: string; icon?: ReactNode; onSelect: () => void; destructive?: boolean }[]; align?: "start" | "end" })`

- [ ] **Step 1: Write failing test**

```tsx
// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { DropdownMenu } from "./dropdown-menu";

afterEach(() => cleanup());

describe("DropdownMenu", () => {
  it("opens on trigger click and fires onSelect", () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu
        trigger={<button>Open menu</button>}
        items={[{ label: "First action", onSelect }]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "First action" }));
    expect(onSelect).toHaveBeenCalled();
  });
});
```

Run: `pnpm --filter kxta-web test -- src/components/ui/dropdown-menu.test.tsx` — expected FAIL (module missing). (Radix menus use pointer events; if `fireEvent.click` doesn't open it under jsdom, use `fireEvent.pointerDown` + `fireEvent.pointerUp` on the trigger, or `userEvent` if available — adjust the test, not the component.)

- [ ] **Step 2: Implement `src/components/ui/dropdown-menu.tsx`**

```tsx
"use client";

import * as Menu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

interface DropdownItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
}

interface DropdownMenuProps {
  trigger: ReactNode;
  items: DropdownItem[];
  align?: "start" | "end";
}

export function DropdownMenu({ trigger, items, align = "end" }: DropdownMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>{trigger}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align={align}
          sideOffset={6}
          className="z-[var(--z-dropdown)] min-w-[180px] rounded-md border border-[var(--border)] bg-[var(--bg-primary)] py-1.5 shadow-xl animate-scale-in"
        >
          {items.map((item) => (
            <Menu.Item
              key={item.label}
              onSelect={item.onSelect}
              className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs font-medium outline-none transition-colors data-[highlighted]:bg-[var(--accent)] data-[highlighted]:text-white ${
                item.destructive ? "text-[var(--danger)]" : "text-[var(--text-secondary)]"
              }`}
            >
              {item.icon}
              {item.label}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
```

- [ ] **Step 3: Run test to verify pass**

Run: `pnpm --filter kxta-web test -- src/components/ui/dropdown-menu.test.tsx`
Expected: PASS.

- [ ] **Step 4: Migrate the three menus**

- `top-bar.tsx`: delete `publishMenuOpen` state and its window-click effect (lines 83–89); replace the publish-menu block (171–215) with `DropdownMenu` — trigger is the existing "Publish ▾" button (keep classes), items "New Publish" / "View Published" with their existing SVG icons (swap `text-[#B4781E]` → `text-[var(--accent)]` while touching them).
- `content-pane.tsx` (CURRENT state): replace the export menu's window-click-close pattern with `DropdownMenu`, preserving all current export options including the new PDF export.
- `file-list.tsx`: replace the ref-based `mousedown`-outside menus (New ▾, and the overflow/sort menus if present as custom popovers — native `<select>` for sort stays for now) with `DropdownMenu`.

- [ ] **Step 5: Run full tests**

Run: `pnpm --filter kxta-web test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ui/dropdown-menu.tsx apps/web/src/components/ui/dropdown-menu.test.tsx apps/web/src/components/layout/top-bar.tsx apps/web/src/components/content/content-pane.tsx apps/web/src/components/file-list/file-list.tsx
git commit -m "feat(web): DropdownMenu primitive; migrate top-bar, export, and file-list menus"
```

---

### Task 9: Theme the chrome — breadcrumb, icon rail, top-bar hexes

**Files:**
- Modify: `src/components/layout/breadcrumb.tsx` (line 22)
- Modify: `src/components/layout/icon-rail.tsx` (lines 26, 42–48, 66–77)
- Modify: `src/components/layout/top-bar.tsx` (lines 98, 107, 122)

- [ ] **Step 1: Breadcrumb → tokens**

Replace the `nav` className (line 22):

```tsx
className="h-8 px-4 flex items-center gap-1.5 text-[13px] border-b border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] select-none"
```

Last segment (line 30): `className={isLast ? "font-bold text-[var(--text-primary)]" : ""}`.
Clickable segments (line 34): `className="hover:text-[var(--accent)] transition-colors"`.

- [ ] **Step 2: IconRail → tokens**

- Rail container (line 26): `bg-[#0A0F1A] border-r border-amber-accent/10` → `bg-[var(--bg-secondary)] border-r border-[var(--border)]`.
- `RailButton` inactive state (line 70): `"bg-white/5 text-white/50 hover:bg-white/10 hover:text-white active:scale-95"` → `"bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)] active:scale-95"`.
- Active state (line 69) keeps `bg-amber-accent text-white` (white on solid accent is legible in all themes); add `bp-keep-round` next to `rounded-xl`? No — squares are fine under Blueprint; instead add `bp-keep-round` to the active-indicator pill (line 76, `rounded-r-full`).
- Peek popover (line 43): `border-amber-accent/20` stays (token alias), `bg-[var(--bg-secondary)]/90` stays.
- Footer divider (line 34): `border-amber-accent/10` → `border-[var(--border)]`.

- [ ] **Step 3: Top-bar hexes**

- Line 98 (wordmark): `text-[#0F274F] dark:text-white` → `text-[var(--text-primary)]`.
- Line 107 (search button): `text-[#5C3D24] dark:text-[#F5C97A]` → `text-[var(--text-secondary)]`.
- Line 122 (kbd): `text-[#5C3D24] dark:text-[#F5C97A]` → `text-[var(--text-secondary)]`.
- Line 224 (lock button): `hover:text-red-400` → `hover:text-[var(--danger)]`.

- [ ] **Step 4: Visual check in all three themes**

Run the dev server; cycle themes with the top-bar pill. Breadcrumb, rail, and top-bar must read correctly in light, dark, and Blueprint (rail no longer a dark slab in light mode).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/layout/breadcrumb.tsx apps/web/src/components/layout/icon-rail.tsx apps/web/src/components/layout/top-bar.tsx
git commit -m "fix(web): breadcrumb, icon rail, and top-bar follow theme tokens"
```

---

### Task 10: Light-theme legibility — kill text-white on tinted backgrounds

**Files:**
- Modify: `src/components/folder-tree/tree-node.tsx` (lines 39–43)
- Modify: `src/components/file-list/file-item.tsx` (lines 70–79, 94–96, 102–104)
- Modify: `src/components/search/search-dialog.tsx` (lines 151–162)
- Modify: `src/components/folder-tree/folder-tree.tsx` (icon `group-hover:text-white` at lines ~86, 102, 156)

The pattern: active/hover rows use `text-white` over 5–20% accent tints — invisible on the cream light theme. Replacement pattern: text uses `--text-primary`, secondary text uses `--text-secondary`, backgrounds use `--accent-soft`.

- [ ] **Step 1: tree-node.tsx**

Replace the row className (lines 39–43) with:

```tsx
className={`relative flex items-center gap-1.5 py-1.5 px-2 rounded-lg text-sm cursor-pointer transition-all duration-200 group ${
  active
    ? "bg-[var(--accent-soft)] text-[var(--text-primary)] font-semibold"
    : "text-[var(--text-secondary)] hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)]"
}`}
```

- [ ] **Step 2: file-item.tsx**

Row container (lines 70–79):

```tsx
className={`
  group relative px-4 py-3 cursor-pointer border-l-[3px] transition-all duration-200
  ${
    active && !selectMode
      ? "bg-[var(--accent-soft)] border-amber-accent"
      : selectMode && selected
      ? "bg-[var(--accent-soft)] border-amber-accent"
      : "border-transparent hover:bg-[var(--accent-soft)]/60 hover:translate-x-0.5"
  }
`}
```

Title div (lines 94–96):

```tsx
<div className={`text-sm font-semibold truncate transition-colors flex items-center gap-1.5 ${
  active ? "text-[var(--text-primary)]" : "text-[var(--text-primary)] group-hover:text-[var(--accent)]"
}`}>
```

Meta div (lines 102–104):

```tsx
<div className="text-[11px] mt-1 flex flex-wrap items-center gap-1.5 transition-colors text-[var(--text-secondary)]">
```

(This also removes the `#0F172A`/`#475569` hexes in those lines.)

- [ ] **Step 3: search-dialog.tsx result rows**

Replace the result button classNames (lines 151–162):

```tsx
className={`w-full px-5 py-4 text-left rounded-lg transition-all duration-200 flex flex-col gap-1 ${
  idx === selectedIdx
    ? "bg-[var(--accent-soft)]"
    : "hover:bg-[var(--accent-soft)]/60"
}`}
```

Title line: `text-sm font-semibold text-[var(--text-primary)]`.
Path line: `text-xs text-[var(--text-secondary)]`.
(The `onMouseEnter` sync was added in Task 6.)

- [ ] **Step 4: folder-tree.tsx icon hovers**

Replace each `group-hover:text-white` on section icons (lines ~86, 102, 156) with `group-hover:text-[var(--accent)]`. Also fix the empty states at lines ~177/231: `text-gray-400` → `text-[var(--muted)]`.

- [ ] **Step 5: Verify — no text-white on tint remains in these components; visual pass**

Run: `grep -n "text-white" apps/web/src/components/folder-tree/*.tsx apps/web/src/components/file-list/file-item.tsx apps/web/src/components/search/search-dialog.tsx`
Expected: no hits (IconRail's white-on-solid-accent active state lives in icon-rail.tsx and is fine).
Light theme: tree hover, file rows, and search results must be clearly readable.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/folder-tree/ apps/web/src/components/file-list/file-item.tsx apps/web/src/components/search/search-dialog.tsx
git commit -m "fix(web): light-theme legibility — token-based active/hover states in tree, list, search"
```

---

### Task 11: Global hex/palette sweep to tokens

**Files:**
- Modify (sweep targets, grep-driven): `src/components/**`, `src/app/**` `.tsx` files, notably:
  - `src/components/mcp/mcp-pipeline-row.tsx` (inline styles → Tailwind + tokens)
  - `src/components/file-list/profile-banner.tsx` (raw `amber-50/200/800`)
  - `src/app/docs/journal/live-status.tsx` (raw grays)
  - `src/app/docs/journal/journal-panel.tsx` (tooltip grays)
  - `src/app/login/login-client.tsx` (`--text-tertiary` now exists; glow rgba)
  - `src/components/docs/install-snippet-view.tsx` (`--accent-opacity` → `--accent-soft`)
  - `src/components/docs/docs-modal.tsx` (tab hexes `#5C3D24`/`#F5C97A`)
  - `src/components/content/content-pane.tsx` + `src/components/file-list/file-list.tsx` empty states (`#0F172A`/`#F1F5F9`/`#475569`/`#94A3B8`)

**Mapping table (apply everywhere):**

| Current | Replace with |
|---|---|
| `#B4781E` (class or SVG stroke/fill in TSX) | `var(--accent)` / `text-amber-accent` |
| `#475569`, `#94A3B8` (and `dark:` pairs) | `text-[var(--text-secondary)]` / `text-[var(--muted)]` |
| `#F5C97A`, `#E5C079` in TSX | `text-amber-accent-light` (only where a light accent is really wanted) or `var(--text-primary)` in dark-context text |
| `#5C3D24` | `var(--text-secondary)` |
| `#0F172A`, `#F1F5F9`, `dark:text-white` in empty states | `text-[var(--text-primary)]` |
| `text-red-400/500/600`, `bg-red-500/600/700`, `border-red-500` | `text-[var(--danger)]`, `bg-[var(--danger)]`, `border-[var(--danger)]` (opacity via `/NN` suffix works on arbitrary values: `bg-[var(--danger)]/10` requires Tailwind alpha support on vars — if it doesn't compile, use `color-mix` inline style or keep a `--danger-soft: rgba(192,86,86,0.15)` token added to all three themes) |
| `text-green-500`, `bg-green-500` | `text-[var(--success)]`, `bg-[var(--success)]` |
| `text-gray-400/500`, `bg-gray-50`, `dark:bg-gray-900/40` | `text-[var(--muted)]`, `bg-[var(--bg-secondary)]` |
| `rgba(180,120,30,X)` literals in TSX (shadows/glows) | keep the shadow but reference `var(--accent-soft)` where the alpha is close (0.14–0.2); for stronger glows keep literal ONLY inside `globals.css`, never TSX |
| `amber-50`, `amber-200`, `amber-800` (profile-banner) | `bg-[var(--accent-soft)]`, `border-[var(--border)]`, `text-[var(--text-primary)]` |

- [ ] **Step 1: Add `--danger-soft` token (needed by the sweep)**

In `globals.css`, add to each of `:root`, `.dark`, `.blueprint`: `--danger-soft: rgba(192, 86, 86, 0.15);`

- [ ] **Step 2: Sweep, file by file**

Run: `grep -rln "#B4781E\|#475569\|#94A3B8\|#F5C97A\|#5C3D24\|#0F172A\|#F1F5F9\|#E5C079\|#0A0F1A" apps/web/src --include="*.tsx"`
For each hit file, apply the mapping table. `mcp-pipeline-row.tsx` is a rewrite from inline `style` objects to Tailwind classes with tokens (keep its visual structure: dot + label + gradient line + result; gradient via `bg-gradient-to-r from-[var(--accent)]/60 to-transparent`).

- [ ] **Step 3: Shared EmptyState component**

Create `src/components/ui/empty-state.tsx`:

```tsx
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}

/** One styling convention for the three divergent empty states. */
export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center gap-2">
      {icon && <div className="text-[var(--muted)] opacity-60 mb-1">{icon}</div>}
      <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>
      {hint && <p className="text-xs text-[var(--text-secondary)]">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
```

Adopt it in the empty states of `folder-tree.tsx` (~lines 177, 231), `file-list.tsx` (~lines 470–500 — keep the existing "DELETE THIS FOLDER" button as the `action`), and `content-pane.tsx` (no-file-selected and file-not-found branches, ~lines 437–480 of the current working tree).

- [ ] **Step 4: Scope Blueprint's radius nuke — bp-keep-round on semantic circles**

Run: `grep -rn "rounded-full" apps/web/src --include="*.tsx"`
For each hit that is a semantic circle (status dots in `status-bar.tsx`, sync indicators, the rail active pill from Task 9, avatar-like circles, radio-style indicators), add `bp-keep-round` alongside `rounded-full`. Pills/badges that may go square under Blueprint are left alone.

- [ ] **Step 5: Sweep raw Tailwind palette colors**

Run: `grep -rn "text-red-\|bg-red-\|border-red-\|text-green-\|bg-green-\|text-gray-\|bg-gray-\|bg-slate-\|text-slate-" apps/web/src --include="*.tsx"`
Apply the mapping table. Exception: `event-colors.ts` sky/emerald/violet/rose/cyan palette is handled in Task 12 — skip calendar palette entries here.

- [ ] **Step 6: Verify zero stray hexes and passing tests**

Run: `grep -rn "#B4781E\|#475569\|#94A3B8\|#F5C97A\|#5C3D24\|#0F172A\|#F1F5F9\|#0A0F1A" apps/web/src --include="*.tsx"`
Expected: 0 hits.
Run: `pnpm --filter kxta-web test && pnpm --filter kxta-web build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src apps/web/src/app/globals.css
git commit -m "refactor(web): sweep hexes to tokens; shared EmptyState; scope blueprint radius nuke"
```

---

### Task 12: Calendar — light-theme colors, conflict focus, buffer sync

**Files:**
- Modify: `src/components/calendar/event-colors.ts`
- Modify: `src/components/calendar/month-grid.tsx` (today circle `text-[#0A0F1A]`)
- Modify: `src/components/calendar/week-view.tsx` (event button ids; time-indicator shadow rgba)
- Modify: `src/components/calendar/event-chip.tsx` (element id)
- Modify: `src/components/calendar/calendar-client.tsx` (`handleConflictFocus`)
- Modify: `src/components/calendar/conflicts-panel.tsx` (buffer input sync)

- [ ] **Step 1: Light-theme event palette**

Replace `event-colors.ts` PALETTE with paired light/dark classes (literal strings for JIT):

```ts
const PALETTE = [
  { chip: "bg-amber-accent/15 text-amber-accent-dark dark:text-amber-accent-light border-amber-accent/30", dot: "bg-amber-accent" },
  { chip: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30", dot: "bg-sky-400" },
  { chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30", dot: "bg-emerald-400" },
  { chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30", dot: "bg-violet-400" },
  { chip: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30", dot: "bg-rose-400" },
  { chip: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30", dot: "bg-cyan-400" },
] as const;
```

In `month-grid.tsx`, the today-circle `text-[#0A0F1A]` → `text-white` (white on solid accent — same rationale as rail active state).

- [ ] **Step 2: Conflict focus works in month/week**

- `event-chip.tsx`: add `id={`cal-ev-${event.id}`}` to the chip's root element (read the file for the event prop name).
- `week-view.tsx`: add the same `id` to each event button.
- `calendar-client.tsx` `handleConflictFocus`: before scrolling, ensure the event is reachable — set the anchor date to the event's start date, and if `view === "month"`, keep month; the element now exists in all views. Retry the `scrollIntoView` after a `requestAnimationFrame` so the re-render lands first:

```tsx
const handleConflictFocus = (eventId: number, startsAt: string) => {
  setAnchor(new Date(startsAt));
  setHighlightIds(/* existing logic */);
  requestAnimationFrame(() => {
    document.getElementById(`cal-ev-${eventId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
};
```

(Read the file for actual state setter names; keep its existing highlight logic. If the callback currently receives only the conflict object, pass the event's `starts_at` through from `conflicts-panel.tsx`.)

- [ ] **Step 3: Buffer input sync in conflicts-panel.tsx**

The input initializes `useState(String(bufferMinutes))` before settings load. Add:

```tsx
useEffect(() => {
  setBufferInput(String(bufferMinutes));
}, [bufferMinutes]);
```

(match actual state names when reading the file).

- [ ] **Step 4: week-view shadow rgba → token**

Replace the current-time indicator's `rgba(180,120,30,...)` shadow with `var(--accent-soft)` equivalent or a Tailwind `shadow-[0_0_8px_var(--accent-soft)]`.

- [ ] **Step 5: Tests + visual pass**

Run: `pnpm --filter kxta-web test` (agenda-list and date-utils tests must stay green).
Visual: light theme calendar chips readable; click a conflict while in month view → view jumps to the event and scrolls to it.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/calendar/
git commit -m "fix(web): calendar light-theme palette, working conflict focus in all views, buffer sync"
```

---

### Task 13: Docs-area fixes — journal discard/diff, tab hover, button unification, login cleanup

**Files:**
- Modify: `src/app/docs/journal/journal-panel.tsx`
- Modify: `src/components/docs/docs-modal.tsx` (tab hover ≠ selected)
- Modify: `src/components/docs/template-gallery.tsx` (card hover)
- Modify: `src/components/docs/tool-form.tsx` (footer buttons → `.btn`)
- Modify: `src/components/docs/save-bar.tsx` (buttons → `.btn`/`.btn-primary`)
- Modify: `src/app/docs/builder/builder-section.tsx` (buttons → `.btn`)
- Modify: `src/app/login/login-client.tsx` (console.logs; submit button → `.btn btn-md btn-primary`)
- Modify: `src/components/calendar/toolbar.tsx`, `event-dialog.tsx`, `entity-manager.tsx` (`!text-amber-accent font-bold` hacks → `btn-primary`)

- [ ] **Step 1: journal-panel.tsx — snapshot-based discard and diff-based unsaved count**

Read the file. Changes:
- On successful config fetch, store the loaded config in a ref/state: `const loadedRef = useRef<JournalConfig | null>(null); loadedRef.current = fetched;`
- `discard()` restores `loadedRef.current` (falling back to `DEFAULTS` only when nothing was ever loaded).
- Replace the keystroke counter (`setUnsaved(n => n + 1)`) with a derived diff count: `const unsaved = useMemo(() => countDiffs(form, loadedRef.current ?? DEFAULTS), [form])` where `countDiffs` counts top-level fields that differ (`JSON.stringify` per field). SaveBar receives this count; Save disabled at 0.

- [ ] **Step 2: DocsModal tab hover distinct from selected**

Selected tab keeps `bg-[var(--accent)] text-white` (post-Task-11 tokens). Hover on non-selected becomes `hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)]` — no longer identical to selected. Same fix for `template-gallery.tsx` cards: hover tints (`hover:bg-[var(--accent-soft)]`), not full accent takeover.

- [ ] **Step 3: Button unification**

- `tool-form.tsx` footer: Cancel → `className="btn btn-md"`, Save/primary → `className="btn btn-md btn-primary"`. Delete the red-hover Cancel styling.
- `save-bar.tsx`: Save → `btn btn-sm btn-primary`; Discard → `btn btn-sm btn-destructive`.
- `builder-section.tsx`: ad-hoc `px-4 py-2 ... bg-[var(--accent)] text-black` buttons → `.btn btn-md btn-primary` / secondary `.btn btn-md`; "Delete Config" → `btn btn-md btn-destructive`.
- `login-client.tsx`: submit button → `btn btn-md btn-primary w-full` (keep the spinner SVG); remove the glow shadow literal.
- Calendar: replace every `btn btn-sm !text-amber-accent font-bold` (toolbar "+ New event", event-dialog "Save", entity-manager "Add") with `btn btn-sm btn-primary`.

- [ ] **Step 4: login-client.tsx console.logs**

Delete the `console.log("[Login] ...")` lines (submission, response status, auth-failure bodies).

- [ ] **Step 5: Tests**

Run: `pnpm --filter kxta-web test`
Expected: PASS — `save-bar.test.tsx`, `tool-form-modal` (dead — removed in Task 14), gallery/builder tests updated for new classes ONLY where they assert styling classes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/docs/ apps/web/src/components/docs/ apps/web/src/app/login/login-client.tsx apps/web/src/components/calendar/
git commit -m "fix(web): journal discard/diff semantics, distinct tab hover, unified btn system, login cleanup"
```

---

### Task 14: Misc bugs — filter trap, hydration flash, version drift, dead code

**Files:**
- Modify: `src/components/file-list/file-list.tsx` (filter visibility, ~line 327)
- Modify: `src/hooks/use-media-query.ts`
- Modify: `src/app/home-client.tsx` (hydration gate; phone wall stays)
- Modify: `src/components/layout/top-bar.tsx` (KONTEXTA_REV)
- Delete: `src/components/docs/tool-list-row.tsx`, `src/components/docs/tool-list-row.test.tsx`, `src/components/docs/tool-form-modal.tsx`, `src/components/docs/tool-form-modal.test.tsx`

- [ ] **Step 1: Filter trap**

In `file-list.tsx`, the filter input renders only when `files.length > 10`. Change the condition so it also renders whenever a filter is active:

```tsx
{(files.length > 10 || filter.trim() !== "") && (
  <FileListFilter ... />
)}
```

(match the actual state variable name when reading the file).

- [ ] **Step 2: Hydration flash**

`use-media-query.ts` — lazy-init from `window` when available:

```tsx
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}
```

`home-client.tsx` — gate the first paint so SSR markup (which can't know the viewport) never flashes desktop at a phone/tablet:

```tsx
const [hydrated, setHydrated] = useState(false);
useEffect(() => setHydrated(true), []);
// ... just before the isPhone check:
if (!hydrated) {
  return <div className="h-screen bg-[var(--bg-primary)]" />;
}
```

(With the gate, `ThreePane` and `IconRail` mount client-side only, so the lazy initializer gives them the correct viewport on first render — no snap.)

- [ ] **Step 3: Version from package.json**

`top-bar.tsx` line 10: replace `const KONTEXTA_REV = "4.1.0";` with:

```tsx
import pkg from "../../../package.json";
const KONTEXTA_REV = pkg.version;
```

(`resolveJsonModule` is on by default in Next's tsconfig; verify import path depth — `src/components/layout/` → three levels up to `apps/web/package.json`.)

- [ ] **Step 4: Delete dead components**

```bash
git rm apps/web/src/components/docs/tool-list-row.tsx apps/web/src/components/docs/tool-list-row.test.tsx apps/web/src/components/docs/tool-form-modal.tsx apps/web/src/components/docs/tool-form-modal.test.tsx
```

Verify nothing imports them: `grep -rn "tool-list-row\|tool-form-modal" apps/web/src --include="*.ts*"` → expect no remaining references.

- [ ] **Step 5: Tests + build**

Run: `pnpm --filter kxta-web test && pnpm --filter kxta-web build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/file-list/file-list.tsx apps/web/src/hooks/use-media-query.ts apps/web/src/app/home-client.tsx apps/web/src/components/layout/top-bar.tsx
git commit -m "fix(web): filter trap, hydration flash, version drift; remove dead docs components"
```

---

### Task 15: Icon unification — lucide replaces functional emoji

**Files:**
- Modify (grep-driven): all `.tsx` under `src/components/` and `src/app/` using functional emoji glyphs.

**Mapping (lucide-react components, all with `className="w-4 h-4"` unless noted, `aria-hidden` on the icon, keep the wrapping button's `aria-label`):**

| Emoji / glyph | Replace with |
|---|---|
| ✕ (close buttons) | `<X />` — most vanish automatically via Dialog migration; sweep stragglers |
| ‹ / › (calendar prev/next) | `<ChevronLeft />` / `<ChevronRight />` |
| ▶ (tree expand, tree-node.tsx line 47) | `<ChevronRight className="w-3 h-3 transition-transform" />` with the existing `rotate-90` toggle |
| 🔍 (search empty state) | `<Search className="w-8 h-8 opacity-30" />` |
| 📂 / 📁 | `<Folder />` / `<FolderOpen />` |
| ★ (favorite, file-item.tsx line 98) | `<Star className="w-3.5 h-3.5 fill-current" />` |
| ⚠️ | `<AlertTriangle />` |
| ✅ | `<CheckCircle2 />` |
| 🔒 | `<Lock />` |
| ⊘ | `<Ban />` |
| ↻ (refresh) | `<RotateCw />` |
| ↑ / ↗ | `<ArrowUp />` / `<ArrowUpRight />` |
| ☀ / ☽ / ▦ (theme cycler labels in top-bar) | `<Sun className="w-3 h-3" />` / `<Moon className="w-3 h-3" />` / `<LayoutGrid className="w-3 h-3" />` inline before the label text |
| 🗓️ | `<CalendarDays />` |
| § | keep (typographic, not iconic) |

- [ ] **Step 1: Sweep**

Run: `grep -rn "✕\|‹\|›\|▶\|🔍\|📂\|📁\|★\|⚠️\|✅\|🔒\|⊘\|↻\|🗓️\|☀\|☽\|▦\|↗" apps/web/src --include="*.tsx"`
Replace per the table. Decorative emoji inside prose sentences (e.g. install instructions body text) may stay; anything acting as an icon (button glyph, empty-state pictogram, status marker) is replaced.

- [ ] **Step 2: Tests + visual**

Run: `pnpm --filter kxta-web test` — update any test asserting emoji text content to assert accessible names instead.
Visual: check tree chevrons rotate, theme pill, calendar nav.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): lucide icons replace functional emoji glyphs"
```

---

### Task 16: Final verification — full suite, build, three-theme manual pass

**Files:** none (verification only; small fixups allowed)

- [ ] **Step 1: Full automated check**

Run: `pnpm --filter kxta-web test && pnpm --filter kxta-web build && pnpm --filter kxta-web lint`
Expected: all green. Fix anything broken before proceeding.

- [ ] **Step 2: Grep audit — the policy holds**

```bash
grep -rn "alert(" apps/web/src --include="*.tsx"                    # expect: none
grep -rn "window.confirm" apps/web/src --include="*.tsx"            # expect: only home-client dirty guard
grep -rn "#B4781E\|#475569\|#94A3B8\|#5C3D24\|#0F172A" apps/web/src --include="*.tsx"   # expect: none
grep -rn "z-\[100\]\|z-\[150\]\|z-\[200\]" apps/web/src --include="*.tsx"               # expect: none (z-scale vars instead)
```

- [ ] **Step 3: Manual pass in all three themes (use the app)**

Launch the dev server (`pnpm --filter kxta-web dev`) and for EACH of light, dark, blueprint verify:
1. Home: tree hover/active readable; file rows readable; breadcrumb and rail themed; search dialog (⌘K) results readable, Escape closes.
2. Create a file → success toast, file opens. Create with a bad folder → error toast.
3. Delete a file → ConfirmDialog with truthful copy → success toast.
4. Reindex → toast. Publish menu opens/closes via dropdown.
5. Calendar: chips readable, conflict click focuses event in month view, dialogs close on Escape.
6. Configure modal: tabs' hover ≠ selected, journal Discard restores saved values, Save disabled at 0 changes.
7. Login page renders with tokens (log out via lock icon).
8. Blueprint: square corners everywhere except status dots/rail pill; grid background on login intact.
9. Narrow the window to tablet width — no desktop→rail flash on reload.

- [ ] **Step 4: Update CHANGELOG.md**

Add an Unreleased entry summarizing Phase 1 (primitives, tokens, feedback policy, bug fixes). Note: CHANGELOG.md already has uncommitted edits from the in-flight PDF work — append, don't rewrite.

- [ ] **Step 5: Final commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for UI foundation phase 1"
```
