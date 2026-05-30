"use client";

interface UnregisterModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  projectName: string;
}

export function UnregisterModal({
  isOpen,
  onClose,
  onConfirm,
  projectName,
}: UnregisterModalProps) {
  if (!isOpen) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 animate-fade-in"
      onClick={handleOverlayClick}
    >
      <div className="w-[440px] bg-[#0F172A] border border-red-500/30 rounded-xl shadow-[0_0_50px_-12px_rgba(239,68,68,0.3)] overflow-hidden">
        <div className="p-8 text-center">
          <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-6 border border-red-500/20">
            <span className="text-4xl">⚠️</span>
          </div>
          
          <h3 className="text-xl font-bold text-white mb-3">UNREGISTER PROJECT</h3>
          <p className="text-sm text-slate-400 mb-8 leading-relaxed">
            Are you sure you want to remove <span className="text-white font-bold italic">"{projectName}"</span> from Kontexta?
            <br /><br />
            This will remove all associated context files from your AI's memory, but your <span className="text-amber-accent font-bold">actual source code will remain safe</span> on your disk.
          </p>

          <div className="flex flex-col gap-3">
            <button
              onClick={onConfirm}
              className="btn btn-md btn-destructive"
            >
              YES, UNREGISTER PROJECT
            </button>
            <button
              onClick={onClose}
              className="btn btn-md"
            >
              CANCEL
            </button>
          </div>
          
          <p className="mt-6 text-[10px] text-slate-500 uppercase tracking-widest font-bold">
            THIS ACTION IS PERMANENT FOR KONTEXTA METADATA
          </p>
        </div>
      </div>
    </div>
  );
}
