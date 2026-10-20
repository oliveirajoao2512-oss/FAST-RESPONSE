import { Factory } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormError } from '../components/actions';
import { Button, Field, Input } from '../components/ui';
import { errorMessage, post } from '../lib/api';
import { useSession } from '../lib/session';

export function LoginPage() {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/login', { login, password });
      await refresh();
      navigate('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-full items-center justify-center bg-gray-900 p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white"><Factory /></span>
          <div>
            <h1 className="text-xl font-bold">Fast Response</h1>
            <p className="text-sm text-gray-500">Gestão de pendências da fábrica</p>
          </div>
        </div>
        <FormError error={error ? { msg: error } : null} />
        <div className="space-y-4">
          <Field label="E-mail ou matrícula"><Input autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required autoFocus /></Field>
          <Field label="Senha"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          <Button type="submit" kind="primary" loading={busy} className="w-full">Entrar</Button>
          <p className="text-center text-xs text-gray-500">Esqueceu a senha? Solicite a redefinição ao administrador do sistema.</p>
        </div>
      </form>
    </div>
  );
}

export function ChangePasswordPage({ forced }: { forced?: boolean }) {
  const { refresh, logout } = useSession();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError('A confirmação não confere com a nova senha.');
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/change-password', { current, next });
      setOk(true);
      await refresh();
      if (forced) navigate('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={forced ? 'flex min-h-full items-center justify-center bg-gray-900 p-4' : 'max-w-md'}>
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow">
        <h1 className="text-lg font-bold">{forced ? 'Defina sua senha' : 'Alterar senha'}</h1>
        {forced && <p className="text-sm text-gray-600">Sua senha é provisória. Defina uma senha pessoal para continuar.</p>}
        <FormError error={error ? { msg: error } : null} />
        {ok && !forced && <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">Senha alterada. As outras sessões foram encerradas.</div>}
        <Field label="Senha atual"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></Field>
        <Field label="Nova senha" hint="Mínimo de 8 caracteres, com letras e números."><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></Field>
        <Field label="Confirme a nova senha"><Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></Field>
        <div className="flex gap-2">
          <Button type="submit" kind="primary" loading={busy}>Salvar senha</Button>
          {forced && <Button onClick={() => logout()}>Sair</Button>}
        </div>
      </form>
    </div>
  );
}
