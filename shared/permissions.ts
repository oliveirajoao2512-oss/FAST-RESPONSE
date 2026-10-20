import type { Role } from './constants.js';

export interface Actor {
  id: string;
  role: Role;
  areaId: number | null;
}

export interface IssueRef {
  areaId: number;
  originAreaId: number;
  assigneeId: string | null;
  openedById: string;
  completedById?: string | null;
}

const isManager = (a: Actor) => a.role === 'admin' || a.role === 'gestor';
/** Leader of the area currently responsible for the issue, or of the area that opened it. */
const leadsIssueArea = (a: Actor, i: IssueRef) =>
  a.role === 'lider' && a.areaId !== null && (a.areaId === i.areaId || a.areaId === i.originAreaId);
const isAssignee = (a: Actor, i: IssueRef) => i.assigneeId === a.id;

/** Central permission rules. Every check happens on the server; the web only mirrors them to hide buttons. */
export const can = {
  createIssue: (_a: Actor) => true,
  viewIssues: (_a: Actor) => true,
  comment: (_a: Actor) => true,
  editIssue: (a: Actor, i: IssueRef) => isManager(a) || leadsIssueArea(a, i) || isAssignee(a, i) || i.openedById === a.id,
  /** Assign anyone: leaders of the area, managers, admins. */
  assign: (a: Actor, i: IssueRef) => isManager(a) || leadsIssueArea(a, i),
  /** Collaborators may take ("assumir") an unassigned issue for themselves. */
  selfAssign: (a: Actor, i: IssueRef) => i.assigneeId === null,
  changeStatus: (a: Actor, i: IssueRef) => isManager(a) || leadsIssueArea(a, i) || isAssignee(a, i),
  block: (a: Actor, i: IssueRef) => isManager(a) || leadsIssueArea(a, i) || isAssignee(a, i),
  complete: (a: Actor, i: IssueRef) => isManager(a) || leadsIssueArea(a, i) || isAssignee(a, i),
  validate: (a: Actor, i: IssueRef, allowSelfValidation: boolean) => {
    if (!allowSelfValidation && i.completedById === a.id) return false;
    return isManager(a) || leadsIssueArea(a, i) || i.openedById === a.id;
  },
  reopen: (a: Actor, i: IssueRef) => isManager(a) || leadsIssueArea(a, i) || i.openedById === a.id,
  cancel: (a: Actor, i: IssueRef) => isManager(a) || leadsIssueArea(a, i),
  transfer: (a: Actor, i: IssueRef) => isManager(a) || leadsIssueArea(a, i),
  /** Change the deadline directly (approved immediately). */
  changeDeadline: (a: Actor, i: IssueRef, needsApprovalRoles: Role[]) =>
    !needsApprovalRoles.includes(a.role) && (isManager(a) || leadsIssueArea(a, i)),
  /** Request a deadline change (subject to approval). */
  requestDeadline: (a: Actor, i: IssueRef) => isManager(a) || leadsIssueArea(a, i) || isAssignee(a, i),
  approveDeadline: (a: Actor, i: IssueRef) => isManager(a) || leadsIssueArea(a, i),
  setComplexity: (a: Actor, i: IssueRef) => isManager(a) || leadsIssueArea(a, i),
  manageSteps: (a: Actor, i: IssueRef) => isManager(a) || leadsIssueArea(a, i) || isAssignee(a, i),
  manageMeeting: (a: Actor) => isManager(a) || a.role === 'lider',
  viewReports: (a: Actor) => isManager(a) || a.role === 'lider',
  viewAudit: (a: Actor) => isManager(a),
  manageUsers: (a: Actor) => a.role === 'admin',
  manageSettings: (a: Actor) => a.role === 'admin',
  manageCatalog: (a: Actor) => isManager(a),
  recomputeRanking: (a: Actor) => isManager(a),
};
