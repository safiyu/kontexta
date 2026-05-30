"use client";

interface GitErrorDialogProps {
  open: boolean;
  onClose: () => void;
  error: string;
}

export function GitErrorDialog({ open, onClose, error }: GitErrorDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div 
        className="bg-[var(--bg-primary)] border border-red-500/30 rounded-xl w-full max-w-md shadow-2xl overflow-hidden animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-red-500/10 px-6 py-4 border-b border-red-500/20 flex items-center gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <h3 className="text-lg font-bold text-red-500">Git Auto-Commit Failed</h3>
            <p className="text-[11px] text-red-500/70 uppercase tracking-widest font-bold">Partial Success</p>
          </div>
        </div>
        
        <div className="p-6">
          <p className="text-sm text-[var(--text-primary)] mb-4 leading-relaxed">
            Your changes were saved to the database, but Kontexta could not create a Git history entry for this file.
          </p>
          
          <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-4 mb-6">
            <p className="text-[11px] text-red-500 uppercase tracking-tighter font-bold mb-2 opacity-70">Git Error Detail:</p>
            <pre className="text-[12px] font-mono text-red-400 whitespace-pre-wrap break-words leading-tight overflow-x-auto max-h-48 custom-scrollbar">
              {error}
            </pre>
          </div>
          
          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="px-8 py-2.5 bg-red-500 text-white font-bold rounded-lg hover:bg-red-600 transition-all btn-press shadow-lg shadow-red-500/20"
            >
              GOT IT
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
