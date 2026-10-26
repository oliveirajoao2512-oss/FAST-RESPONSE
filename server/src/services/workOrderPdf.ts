// Printable evidence of a work order ("comprovante"): everything recorded about the order, from the opening
// to the finish, with a fingerprint of the content so a printed copy can be checked against the system.

import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { WO_PRIORITY_LABELS, WO_STATUS_LABELS, type WoDomain, type WoPriority, type WoStatus } from '../../../shared/maintenance.js';

export interface PdfInput {
  domain: WoDomain;
  order: any;
  category: string;
  events: { action: string; text: string; created_at: string | Date; actor_name: string | null }[];
  hoursByWorker: { name: string; ms: number }[];
  photos: { purpose: string; filename: string; mime: string; data: Buffer | null }[];
  issuedBy: string;
  zone: string;
}

const A4 = { w: 595.28, h: 841.89 };
const M = 42;
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.82, 0.84, 0.87);
const BRAND = rgb(0.92, 0.42, 0.12);

const fmtDur = (ms: number | null | undefined) => {
  if (ms == null) return '—';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')} min`;
};

/** Fingerprint of what the order says (fields + history), shown on every page. */
export function orderFingerprint(order: any, events: { action: string; created_at: string | Date; actor_name: string | null; text: string }[]) {
  const content = JSON.stringify({
    code: order.code, asset: order.asset_ref, kind: order.kind, reason: order.reason, part: order.part_number, description: order.description,
    stopped: order.machine_stopped, opened: order.opened_at, accepted: order.first_accepted_at, finished: order.finished_at,
    service: order.service_done, material: order.material,
    events: events.map((e) => [e.action, new Date(e.created_at).toISOString(), e.actor_name, e.text]),
  });
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
}

export async function workOrderPdf(input: PdfInput): Promise<Buffer> {
  const { order: o, domain, zone } = input;
  const adj = domain === 'ajuste';
  const doc = await PDFDocument.create();
  doc.setTitle(`${o.code} — ${adj ? 'Ordem de Ajuste' : 'Ordem de Manutenção'}`);
  doc.setProducer('Fast Response');
  doc.setCreator('Fast Response');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const dt = (x: string | Date | null | undefined) => (x ? DateTime.fromJSDate(new Date(x)).setZone(zone).toFormat('dd/MM/yyyy HH:mm') : '—');
  const fingerprint = orderFingerprint(o, input.events);
  const issuedAt = DateTime.now().setZone(zone).toFormat('dd/MM/yyyy HH:mm');

  // the standard PDF fonts only cover Latin-1 (WinAnsi): replace anything else so the file is always produced
  const safe = (f: PDFFont, s: string) =>
    [...String(s ?? '').replace(/\r/g, '').replace(/→/g, '->').replace(/\t/g, ' ')].map((c) => {
      if (c === '\n') return c;
      try { f.encodeText(c); return c; } catch { return '?'; }
    }).join('');

  let page: PDFPage = doc.addPage([A4.w, A4.h]);
  let y = A4.h - M;
  const newPage = () => { page = doc.addPage([A4.w, A4.h]); y = A4.h - M; };
  const need = (h: number) => { if (y - h < M + 30) newPage(); };

  const wrap = (text: string, f: PDFFont, size: number, width: number) => {
    const out: string[] = [];
    for (const para of safe(f, text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const tryLine = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(tryLine, size) <= width) { line = tryLine; continue; }
        if (line) out.push(line);
        // a single word longer than the line is cut
        let w = word;
        while (f.widthOfTextAtSize(w, size) > width) {
          let i = w.length;
          while (i > 1 && f.widthOfTextAtSize(w.slice(0, i), size) > width) i--;
          out.push(w.slice(0, i));
          w = w.slice(i);
        }
        line = w;
      }
      out.push(line);
    }
    return out;
  };
  const text = (s: string, x: number, yy: number, size = 10, f = font, color = INK) => page.drawText(safe(f, s), { x, y: yy, size, font: f, color });
  const paragraph = (s: string, x: number, width: number, size = 10, f = font, color = INK) => {
    for (const line of wrap(s, f, size, width)) {
      need(size + 4);
      text(line, x, y - size, size, f, color);
      y -= size + 4;
    }
  };
  const section = (title: string) => {
    need(40);
    y -= 14;
    text(title.toUpperCase(), M, y - 10, 9, bold, BRAND);
    y -= 15;
    page.drawLine({ start: { x: M, y }, end: { x: A4.w - M, y }, thickness: 0.6, color: LINE });
    y -= 6;
  };
  /** Label/value pairs in two columns. */
  const fields = (pairs: [string, string][]) => {
    const colW = (A4.w - 2 * M - 16) / 2;
    for (let i = 0; i < pairs.length; i += 2) {
      const row = pairs.slice(i, i + 2);
      const heights = row.map(([, v]) => wrap(v || '—', font, 10.5, colW).length);
      const h = 13 + Math.max(...heights) * 14;
      need(h + 4);
      row.forEach(([label, value], j) => {
        const x = M + j * (colW + 16);
        text(label, x, y - 9, 8, font, MUTED);
        wrap(value || '—', font, 10.5, colW).forEach((line, k) => text(line, x, y - 23 - k * 14, 10.5));
      });
      y -= h + 6;
    }
  };

  // ---- header
  page.drawRectangle({ x: 0, y: A4.h - 6, width: A4.w, height: 6, color: BRAND });
  text('FAST RESPONSE', M, y - 10, 9, bold, BRAND);
  text(adj ? 'Ordem de Ajuste - Processo' : 'Ordem de Manutenção', M, y - 32, 20, bold);
  const codeW = bold.widthOfTextAtSize(o.code, 18);
  text(o.code, A4.w - M - codeW, y - 30, 18, bold);
  const st = `${WO_STATUS_LABELS[o.status as WoStatus]} · prioridade ${WO_PRIORITY_LABELS[o.priority as WoPriority].toLowerCase()}`;
  text(st, A4.w - M - font.widthOfTextAtSize(safe(font, st), 9.5), y - 46, 9.5, font, MUTED);
  y -= 58;
  if (o.machine_stopped) {
    page.drawRectangle({ x: M, y: y - 18, width: 118, height: 18, color: rgb(0.86, 0.15, 0.15) });
    text(o.location_type === 'montagem' ? 'MONTAGEM PARADA' : 'MÁQUINA PARADA', M + 8, y - 13, 9.5, bold, rgb(1, 1, 1));
    y -= 26;
  }

  section('Abertura');
  fields([
    ['Solicitante', o.opened_by_name],
    ['Setor', o.area_name],
    [o.location_type === 'montagem' ? 'Montagem' : 'Máquina', o.asset_ref],
    [adj ? 'Motivo' : 'Tipo de manutenção', input.category],
    ...(adj ? [['Part number', o.part_number ?? '—'] as [string, string]] : []),
    ...(o.virgin_pct != null ? [['Material', `${o.virgin_pct}% virgem · ${o.regrind_pct}% moído`] as [string, string]] : []),
    [adj ? 'Hora da chamada' : 'Aberta em', dt(o.opened_at)],
    ['Máquina parada', o.machine_stopped ? 'Sim' : 'Não'],
  ]);
  need(30);
  text(adj ? 'Motivo / problema da parada' : 'O que está acontecendo', M, y - 9, 8, font, MUTED);
  y -= 14;
  paragraph(o.description, M, A4.w - 2 * M, 10.5);

  section(adj ? 'Ajuste' : 'Atendimento');
  const t = o.times ?? {};
  fields([
    [adj ? 'Hora inicial' : 'Primeiro aceite', dt(o.first_accepted_at)],
    [adj ? 'Hora final' : 'Finalizada em', dt(o.finished_at)],
    ['Espera até o aceite', o.first_accepted_at ? fmtDur(t.waitMs) : '—'],
    [adj ? 'Tempo de ajuste' : 'Tempo de atendimento', fmtDur(t.workMs)],
    ['Tempo pausado', fmtDur(t.pausedMs)],
    ['Tempo total', o.finished_at ? fmtDur(t.totalMs) : '—'],
    [adj ? 'Técnico(s) de processo' : 'Manutentor(es)', input.hoursByWorker.length ? input.hoursByWorker.map((w) => `${w.name} (${fmtDur(w.ms)})`).join(', ') : '—'],
    ['Finalizada por', o.finished_by_name ?? '—'],
  ]);
  if (o.service_done || o.status === 'finalizada') {
    need(30);
    text(adj ? 'Ação tomada' : 'Serviço realizado', M, y - 9, 8, font, MUTED);
    y -= 14;
    paragraph(o.service_done ?? '—', M, A4.w - 2 * M, 10.5);
    if (o.material) {
      y -= 4;
      need(30);
      text(adj ? 'Observações' : 'Material utilizado', M, y - 9, 8, font, MUTED);
      y -= 14;
      paragraph(o.material, M, A4.w - 2 * M, 10.5);
    }
  }

  section('Histórico');
  for (const e of input.events) {
    const when = dt(e.created_at);
    const lines = wrap(`${e.actor_name ?? 'Sistema'} ${e.text}`, font, 9.5, A4.w - 2 * M - 92);
    need(lines.length * 13 + 2);
    text(when, M, y - 9.5, 9.5, font, MUTED);
    lines.forEach((l, k) => text(l, M + 92, y - 9.5 - k * 13, 9.5));
    y -= lines.length * 13 + 3;
  }

  // ---- photos (JPEG and PNG are embedded; other formats are listed by name)
  const embedded: { img: PDFImage; label: string }[] = [];
  const listed: string[] = [];
  for (const p of input.photos) {
    const label = `${p.purpose === 'servico' ? 'Serviço' : 'Abertura'} · ${p.filename}`;
    try {
      if (p.data && p.mime === 'image/jpeg') embedded.push({ img: await doc.embedJpg(p.data), label });
      else if (p.data && p.mime === 'image/png') embedded.push({ img: await doc.embedPng(p.data), label });
      else listed.push(label);
    } catch {
      listed.push(label);
    }
  }
  if (embedded.length || listed.length) {
    section('Fotos e vídeos');
    const boxW = (A4.w - 2 * M - 16) / 2;
    const boxH = 190;
    for (let i = 0; i < embedded.length; i += 2) {
      need(boxH + 20);
      embedded.slice(i, i + 2).forEach(({ img, label }, j) => {
        const s = Math.min(boxW / img.width, boxH / img.height);
        const x = M + j * (boxW + 16);
        page.drawImage(img, { x, y: y - img.height * s, width: img.width * s, height: img.height * s });
        text(wrap(label, font, 8, boxW)[0], x, y - boxH - 11, 8, font, MUTED);
      });
      y -= boxH + 20;
    }
    for (const l of listed) paragraph(`• ${l} (abrir no sistema)`, M, A4.w - 2 * M, 9.5, font, MUTED);
  }

  // ---- footer on every page
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    pg.drawLine({ start: { x: M, y: M - 4 }, end: { x: A4.w - M, y: M - 4 }, thickness: 0.6, color: LINE });
    const left = safe(font, `${o.code} · emitido em ${issuedAt} por ${input.issuedBy} · código de verificação ${fingerprint}`);
    pg.drawText(left, { x: M, y: M - 16, size: 7.5, font, color: MUTED });
    const right = `Página ${i + 1} de ${pages.length}`;
    pg.drawText(safe(font, right), { x: A4.w - M - font.widthOfTextAtSize(safe(font, right), 7.5), y: M - 16, size: 7.5, font, color: MUTED });
  });
  return Buffer.from(await doc.save());
}
