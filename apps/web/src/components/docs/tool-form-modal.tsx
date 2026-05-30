import { ToolForm, type ToolDef } from "./tool-form";

interface Props {
  open: boolean;
  initial: { name: string; def: ToolDef } | null;
  projectName?: string;
  onSave: (name: string, def: ToolDef) => void;
  onClose: () => void;
}

export function ToolFormModal({ open, initial, projectName, onSave, onClose }: Props) {
  if (!open) return null;

  return (
    <div role="dialog" className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-12 overflow-y-auto pb-12" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-[700px] bg-[var(--bg-primary)] border border-[var(--border)] rounded-xl p-6 shadow-2xl animate-fade-in">
        <ToolForm 
          initial={initial} 
          projectName={projectName} 
          onSave={onSave} 
          onCancel={onClose} 
        />
      </div>
    </div>
  );
}
