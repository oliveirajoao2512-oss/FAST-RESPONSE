// Domain constants shared by server and web. Server is the source of truth for every rule.

export const ROLES = ['admin', 'gestor', 'lider', 'colaborador', 'manutentor', 'tecnico_processo', 'plant_manager'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrador',
  gestor: 'Gestor',
  lider: 'Líder de área',
  colaborador: 'Colaborador',
  manutentor: 'Manutentor',
  tecnico_processo: 'Processista',
  plant_manager: 'Plant Manager',
};

export const STATUSES = [
  'aberta',
  'aguardando_responsavel',
  'planejada',
  'em_andamento',
  'bloqueada',
  'aguardando_validacao',
  'concluida',
  'cancelada',
] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<Status, string> = {
  aberta: 'Aberta',
  aguardando_responsavel: 'Aguardando responsável',
  planejada: 'Planejada',
  em_andamento: 'Em andamento',
  bloqueada: 'Bloqueada',
  aguardando_validacao: 'Aguardando validação',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};
/** Statuses in which the issue is still being worked and can become overdue. */
export const ACTIVE_STATUSES: Status[] = ['aberta', 'aguardando_responsavel', 'planejada', 'em_andamento', 'bloqueada'];
/** Statuses that are not finished (includes awaiting validation). */
export const OPEN_STATUSES: Status[] = [...ACTIVE_STATUSES, 'aguardando_validacao'];
export const CLOSED_STATUSES: Status[] = ['concluida', 'cancelada'];

export const PRIORITIES = ['baixa', 'media', 'alta', 'critica'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = {
  baixa: 'Baixa',
  media: 'Média',
  alta: 'Alta',
  critica: 'Crítica',
};
export const PRIORITY_WEIGHT: Record<Priority, number> = { critica: 4, alta: 3, media: 2, baixa: 1 };

export const COMPLEXITIES = ['simples', 'moderada', 'complexa'] as const;
export type Complexity = (typeof COMPLEXITIES)[number];
export const COMPLEXITY_LABELS: Record<Complexity, string> = {
  simples: 'Simples',
  moderada: 'Moderada',
  complexa: 'Complexa',
};

export const SOURCES = ['fast_response', 'direto'] as const;
export type Source = (typeof SOURCES)[number];
export const SOURCE_LABELS: Record<Source, string> = {
  fast_response: 'Fast Response',
  direto: 'Registro direto',
};

export const STEP_STATUSES = ['pendente', 'em_andamento', 'bloqueada', 'concluida', 'cancelada'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  pendente: 'Pendente',
  em_andamento: 'Em andamento',
  bloqueada: 'Bloqueada',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};

export const ASSET_TYPES = ['maquina', 'montagem', 'equipamento', 'molde', 'item', 'op', 'outro'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  maquina: 'Máquina',
  montagem: 'Montagem',
  equipamento: 'Equipamento',
  molde: 'Molde',
  item: 'Item',
  op: 'OP',
  outro: 'Outro',
};

/** The seven factory areas. Slugs are stable identifiers used in URLs. */
export const DEFAULT_AREAS = [
  { slug: 'producao', name: 'Produção', color: '#2563eb' },
  { slug: 'logistica', name: 'Logística', color: '#7c3aed' },
  { slug: 'manutencao', name: 'Manutenção', color: '#ea6a1f' },
  { slug: 'qualidade', name: 'Qualidade', color: '#059669' },
  { slug: 'processos', name: 'Processos', color: '#0891b2' },
  { slug: 'ferramentaria', name: 'Ferramentaria', color: '#a16207' },
  { slug: 'seguranca', name: 'Segurança', color: '#dc2626' },
] as const;

export const NOTIFICATION_TYPES = [
  'atribuida',
  'prazo_proximo',
  'atrasada',
  'bloqueada',
  'validacao_solicitada',
  'responsavel_alterado',
  'prazo_alterado',
  'prazo_solicitado',
  'escalonamento',
  'seguranca_critica',
  'validacao_rejeitada',
  'reaberta',
  'etapa_atribuida',
  'os_aberta',
  'os_aceita',
  'os_finalizada',
  'os_transferida',
  'os_indicada',
  'os_devolvida',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Roles that only use one work-order module and nothing else of the system. */
export const ORDER_ONLY_ROLES: Role[] = ['manutentor', 'tecnico_processo'];
