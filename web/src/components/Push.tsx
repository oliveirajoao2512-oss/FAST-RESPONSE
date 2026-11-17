import { BellRing, CheckCircle2, X } from 'lucide-react';
import { useState } from 'react';
import { post } from '../lib/api';
import { isIos } from '../lib/install';
import { usePush } from '../lib/push';
import { Button, Modal } from './ui';

const DISMISS_KEY = 'fr-push-later';
const dismissedRecently = () => {
  try { return Date.now() - Number(localStorage.getItem(DISMISS_KEY) ?? 0) < 3 * 24 * 3600_000; } catch { return false; }
};

/** Invitation shown above the pages until notifications are on in this device (or "Agora não", for 3 days). */
export function PushBanner() {
  const push = usePush();
  const [howTo, setHowTo] = useState(false);
  const onHowToInstall = () => setHowTo(true);
  const [later, setLater] = useState(dismissedRecently);
  const [done, setDone] = useState(false);
  const hide = () => { try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode */ } setLater(true); };

  if (done) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900" role="status">
        <CheckCircle2 size={18} className="shrink-0" />
        <span className="flex-1">Avisos ativados neste aparelho. Enviamos uma notificação de teste.</span>
        <button aria-label="Fechar" onClick={() => setDone(false)} className="rounded p-1 hover:bg-green-100"><X size={16} /></button>
      </div>
    );
  }
  if (later || (push.state !== 'off' && push.state !== 'ios-install')) return null;
  return (
    <>
    {howTo && <InstallHelp onClose={() => setHowTo(false)} />}
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-gray-900" role="region" aria-label="Avisos no celular">
      <BellRing size={18} className="shrink-0 text-brand-700" />
      <span className="min-w-[12rem] flex-1">
        {push.state === 'ios-install'
          ? 'No iPhone, os avisos chegam só com o Fast Response instalado na tela inicial.'
          : 'Receba as ordens e cobranças na hora, mesmo com o app fechado.'}
        {push.error && <span className="block text-xs text-red-700">{push.error}</span>}
      </span>
      <div className="flex gap-2">
        {push.state === 'ios-install'
          ? <Button size="sm" kind="primary" onClick={onHowToInstall}>Como instalar</Button>
          : <Button size="sm" kind="primary" loading={push.busy} onClick={async () => { await push.enable(); if (Notification.permission === 'granted') setDone(true); }}>Ativar avisos</Button>}
        <Button size="sm" kind="ghost" onClick={hide}>Agora não</Button>
      </div>
    </div>
    </>
  );
}

/** "Avisos no celular" in the user menu: state of this device, test, turn off, and help when blocked. */
export function PushModal({ onClose }: { onClose: () => void }) {
  const push = usePush();
  const [howTo, setHowTo] = useState(false);
  const [tested, setTested] = useState<string | null>(null);
  const onHowToInstall = () => setHowTo(true);
  if (howTo) return <InstallHelp onClose={() => setHowTo(false)} />;
  const test = async () => {
    const r = await post<{ sent: number }>('/api/push/test').catch(() => ({ sent: 0 }));
    setTested(r.sent ? 'Notificação de teste enviada. Ela deve aparecer em alguns segundos.' : 'Não foi possível enviar. Desative e ative de novo.');
  };
  return (
    <Modal open onClose={onClose} title="Avisos no celular" footer={<Button kind="primary" onClick={onClose}>Fechar</Button>}>
      <div className="space-y-3 text-sm text-gray-700">
        <p>Com os avisos ativados, este aparelho toca quando uma ordem é aberta para a sua equipe, quando ela fica sem atendimento e nas suas pendências, mesmo com o app fechado.</p>
        {push.state === null && <p className="text-gray-500">Verificando…</p>}
        {push.state === 'on' && (
          <>
            <p className="flex items-center gap-2 font-medium text-green-800"><CheckCircle2 size={18} />Ativados neste aparelho.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={test}>Enviar teste</Button>
              <Button size="sm" kind="ghost" loading={push.busy} onClick={push.disable}>Desativar neste aparelho</Button>
            </div>
            {tested && <p className="text-xs text-gray-600" role="status">{tested}</p>}
            <p className="text-xs text-gray-500">Ao tocar em Sair, este aparelho para de receber os seus avisos. Quem entrar depois recebe os dele.</p>
          </>
        )}
        {push.state === 'off' && (
          <Button kind="primary" loading={push.busy} onClick={push.enable}><BellRing size={16} />Ativar avisos neste aparelho</Button>
        )}
        {push.state === 'denied' && (
          <div className="rounded-lg bg-amber-50 p-3 text-amber-900">
            <p className="font-medium">Os avisos estão bloqueados neste navegador.</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              <li>Toque no cadeado (ou no ícone de configurações) ao lado do endereço do site.</li>
              <li>Em <strong>Notificações</strong>, escolha <strong>Permitir</strong>.</li>
              <li>Recarregue a página e volte aqui.</li>
            </ol>
          </div>
        )}
        {push.state === 'ios-install' && (
          <div className="rounded-lg bg-amber-50 p-3 text-amber-900">
            <p>No iPhone e no iPad, os avisos só funcionam com o app instalado na tela inicial (iOS 16.4 ou mais novo). Depois de instalar, abra pelo ícone e ative aqui.</p>
            <Button size="sm" className="mt-2" onClick={onHowToInstall}>Como instalar</Button>
          </div>
        )}
        {push.state === 'unsupported' && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">Este navegador não recebe avisos. Use o Chrome, o Edge ou o Safari atualizados.</p>}
        {push.error && <p className="text-red-700" role="alert">{push.error}</p>}
      </div>
    </Modal>
  );
}

export function InstallHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Instalar o Fast Response" footer={<Button kind="primary" onClick={onClose}>Entendi</Button>}>
      <p className="mb-3 text-sm text-gray-600">Instalado, o sistema abre direto por um ícone na tela inicial ou na área de trabalho, em janela própria, sem barra de endereço.</p>
      {isIos() ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Abra este endereço no <strong>Safari</strong>.</li>
          <li>Toque em <strong>Compartilhar</strong> (quadrado com seta para cima).</li>
          <li>Escolha <strong>Adicionar à Tela de Início</strong> e confirme.</li>
        </ol>
      ) : (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li><strong>Android (Chrome):</strong> menu ⋮ → <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>.</li>
          <li><strong>Computador (Chrome ou Edge):</strong> clique no ícone de instalar no fim da barra de endereço, ou menu ⋮ → <strong>Transmitir, salvar e compartilhar → Instalar página como app</strong>.</li>
        </ol>
      )}
    </Modal>
  );
}

