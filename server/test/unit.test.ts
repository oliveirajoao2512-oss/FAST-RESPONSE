import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../../shared/config.js';
import { computeCriticalSafetyDue, computeDefaultDue, isOverdue } from '../../shared/deadline.js';
import { can } from '../../shared/permissions.js';
import { scoreIssue } from '../../shared/scoring.js';
import { autoComplexity, canSimpleTransition, completionProblems, stepProgress } from '../../shared/workflow.js';

const cfg = DEFAULT_CONFIG;
const iso = (d: Date) => d.toISOString();

describe('regra de prazo (D+1)', () => {
  it('aberta na terça vence na quarta às 23:59 no horário da fábrica', () => {
    // Terça 20/10/2026 10:00 em São Paulo (UTC-3)
    const due = computeDefaultDue(new Date('2026-10-20T13:00:00Z'), cfg);
    expect(iso(due)).toBe('2026-10-22T02:59:59.999Z'); // quarta 21/10 23:59:59.999 -03:00
  });
  it('usa o dia local, não o dia UTC (aberta às 22h locais = 01h UTC do dia seguinte)', () => {
    const due = computeDefaultDue(new Date('2026-10-21T01:00:00Z'), cfg); // terça 22:00 local
    expect(iso(due)).toBe('2026-10-22T02:59:59.999Z');
  });
  it('aberta às 00:30 de quarta vence quinta', () => {
    const due = computeDefaultDue(new Date('2026-10-21T03:30:00Z'), cfg);
    expect(iso(due)).toBe('2026-10-23T02:59:59.999Z');
  });
  it('prazo e horário configuráveis', () => {
    const c = mergeConfig({ deadline: { days: 2, time: '17:00' } });
    expect(iso(computeDefaultDue(new Date('2026-10-20T13:00:00Z'), c))).toBe('2026-10-22T20:00:59.999Z');
  });
  it('pula fim de semana e feriados quando configurado', () => {
    const c = mergeConfig({ deadline: { skipWeekends: true, holidays: ['2026-11-02'] } });
    // sexta 30/10 → segunda 02/11 é feriado → terça 03/11
    expect(iso(computeDefaultDue(new Date('2026-10-30T13:00:00Z'), c))).toBe('2026-11-04T02:59:59.999Z');
  });
  it('sem pular fim de semana, sexta vence sábado', () => {
    expect(iso(computeDefaultDue(new Date('2026-10-30T13:00:00Z'), cfg))).toBe('2026-11-01T02:59:59.999Z');
  });
  it('segurança crítica: tratamento imediato (N horas)', () => {
    expect(iso(computeCriticalSafetyDue(new Date('2026-10-20T13:00:00Z'), cfg))).toBe('2026-10-20T17:00:00.000Z');
  });
  it('atraso: depois do vencimento', () => {
    expect(isOverdue('2026-10-20T10:00:00Z', new Date('2026-10-20T10:00:01Z'))).toBe(true);
    expect(isOverdue('2026-10-20T10:00:00Z', new Date('2026-10-20T09:59:59Z'))).toBe(false);
  });
  it('configuração parcial é mesclada com os padrões e ignora tipos inválidos', () => {
    const c = mergeConfig({ deadline: { days: 'x' }, scoring: { base: { simples: 5 } } });
    expect(c.deadline.days).toBe(1);
    expect(c.scoring.base).toEqual({ simples: 5, moderada: 20, complexa: 35 });
  });
});

describe('fluxo e encerramento', () => {
  it('transições simples permitidas e bloqueadas', () => {
    expect(canSimpleTransition('aberta', 'em_andamento')).toBe(true);
    expect(canSimpleTransition('em_andamento', 'concluida')).toBe(false);
    expect(canSimpleTransition('aguardando_validacao', 'concluida')).toBe(false);
    expect(canSimpleTransition('aberta', 'bloqueada')).toBe(false);
  });
  it('exige requisitos de encerramento', () => {
    const p = completionProblems({ solution: 'curta', criteriaConfirmed: false, evidenceCount: 0, evidenceRequired: true, pendingMandatorySteps: 2, openImpediments: 1 });
    expect(p).toHaveLength(5);
    expect(completionProblems({ solution: 'Troca do cilindro e teste OK', criteriaConfirmed: true, evidenceCount: 0, evidenceRequired: false, pendingMandatorySteps: 0, openImpediments: 0 })).toEqual([]);
  });
  it('progresso e complexidade a partir das etapas', () => {
    const steps = [{ mandatory: true, status: 'concluida' }, { mandatory: true, status: 'pendente' }, { mandatory: false, status: 'cancelada' }];
    expect(stepProgress(steps)).toBe(50);
    expect(autoComplexity(steps, cfg.complexity)).toBe('moderada');
    expect(autoComplexity(Array(5).fill({ mandatory: true, status: 'pendente' }), cfg.complexity)).toBe('complexa');
    expect(autoComplexity([], cfg.complexity)).toBe('simples');
  });
});

describe('pontuação', () => {
  const base = {
    id: '1', code: 'FR-1', complexity: 'moderada' as const, openedById: 'a', creditedUserId: 'b',
    openedAt: new Date('2026-10-01T10:00:00Z'), completedAt: new Date('2026-10-01T20:00:00Z'), dueAt: new Date('2026-10-02T02:59:59Z'),
    reopenCount: 0, hadRecurrence: false,
  };
  it('bônus no prazo', () => expect(scoreIssue(base, cfg.scoring, 0).points).toBe(26));
  it('penalidade por atraso', () => expect(scoreIssue({ ...base, completedAt: new Date('2026-10-03T00:00:00Z') }, cfg.scoring, 0).points).toBe(12));
  it('reabertura e reincidência reduzem pontos, sem ficar negativo', () => {
    expect(scoreIssue({ ...base, reopenCount: 1, hadRecurrence: true }, cfg.scoring, 0).points).toBe(1);
    expect(scoreIssue({ ...base, reopenCount: 3 }, cfg.scoring, 0).points).toBe(0);
  });
  it('não premia encerramento prematuro de tarefa simples aberta pelo próprio colaborador', () => {
    const s = scoreIssue({ ...base, complexity: 'simples', openedById: 'b', completedAt: new Date('2026-10-01T10:10:00Z') }, cfg.scoring, 0);
    expect(s.points).toBe(0);
    expect(s.counted).toBe(false);
  });
  it('limita pontuação de tarefas simples por mês', () => {
    expect(scoreIssue({ ...base, complexity: 'simples' }, cfg.scoring, cfg.scoring.maxSimplePerMonth).points).toBe(0);
  });
  it('complexa vale mais que simples', () => {
    expect(scoreIssue({ ...base, complexity: 'complexa' }, cfg.scoring, 0).points).toBeGreaterThan(scoreIssue({ ...base, complexity: 'simples' }, cfg.scoring, 0).points);
  });
});

describe('permissões', () => {
  const issue = { areaId: 3, originAreaId: 1, assigneeId: 'tec', openedById: 'op', completedById: 'tec' };
  const actor = (role: any, id = 'x', areaId: number | null = null) => ({ id, role, areaId });
  it('colaborador não atribui, não cancela, não transfere', () => {
    const a = actor('colaborador', 'y', 3);
    expect(can.assign(a, issue)).toBe(false);
    expect(can.cancel(a, issue)).toBe(false);
    expect(can.transfer(a, issue)).toBe(false);
    expect(can.manageUsers(a)).toBe(false);
    expect(can.manageSettings(a)).toBe(false);
    expect(can.viewAudit(a)).toBe(false);
  });
  it('responsável conclui mas não valida a própria conclusão', () => {
    const a = actor('colaborador', 'tec', 3);
    expect(can.complete(a, issue)).toBe(true);
    expect(can.validate(a, issue, false)).toBe(false);
  });
  it('quem abriu valida; líder da área de origem e da área atual atuam', () => {
    expect(can.validate(actor('colaborador', 'op', 1), issue, false)).toBe(true);
    expect(can.assign(actor('lider', 'l1', 3), issue)).toBe(true);
    expect(can.assign(actor('lider', 'l2', 1), issue)).toBe(true);
    expect(can.assign(actor('lider', 'l3', 6), issue)).toBe(false);
  });
  it('gestor e admin; somente admin administra usuários e configurações', () => {
    expect(can.cancel(actor('gestor'), issue)).toBe(true);
    expect(can.manageUsers(actor('gestor'))).toBe(false);
    expect(can.manageSettings(actor('gestor'))).toBe(false);
    expect(can.manageUsers(actor('admin'))).toBe(true);
  });
  it('alteração de prazo por colaborador exige aprovação', () => {
    expect(can.changeDeadline(actor('colaborador', 'tec', 3), issue, ['colaborador'])).toBe(false);
    expect(can.requestDeadline(actor('colaborador', 'tec', 3), issue)).toBe(true);
    expect(can.changeDeadline(actor('lider', 'l1', 3), issue, ['colaborador'])).toBe(true);
  });
});
