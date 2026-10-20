import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

/** Opened vs. concluded per bucket. Two series, fixed colors (validated for color-vision deficiency). */
export function Evolution({ data, unit }: { data: { bucket?: string; month?: string; opened: number; completed: number }[]; unit: 'week' | 'month' }) {
  const rows = data.map((d) => {
    const key = d.bucket ?? d.month!;
    const [y, m, day] = key.split('-');
    return { label: unit === 'week' ? `${day}/${m}` : `${m}/${y.slice(2)}`, Abertas: d.opened, Concluídas: d.completed };
  });
  return (
    <div className="h-56 w-full" aria-label="Evolução de pendências abertas e concluídas">
      <ResponsiveContainer>
        <BarChart data={rows} barGap={2} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#e5e7eb" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={{ stroke: '#d1d5db' }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: '#f3f4f6' }} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
          <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
          <Bar dataKey="Abertas" fill="#2a78d6" radius={[4, 4, 0, 0]} maxBarSize={18} />
          <Bar dataKey="Concluídas" fill="#ea6a1f" radius={[4, 4, 0, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
