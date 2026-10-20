import { CheckCircle2, TriangleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Toast = { id: number; kind: 'ok' | 'error'; text: string };
const Ctx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, kind, text }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[100] flex flex-col gap-2 sm:w-96" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'}
            className={`flex items-start gap-2 rounded-lg px-4 py-3 shadow-lg text-sm text-white ${t.kind === 'ok' ? 'bg-emerald-700' : 'bg-red-700'}`}>
            {t.kind === 'ok' ? <CheckCircle2 size={18} className="shrink-0 mt-0.5" /> : <TriangleAlert size={18} className="shrink-0 mt-0.5" />}
            <span className="flex-1">{t.text}</span>
            <button aria-label="Fechar" onClick={() => setItems((s) => s.filter((x) => x.id !== t.id))}><X size={16} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
