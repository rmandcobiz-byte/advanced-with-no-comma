import React, { useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

/** --------------------------
 * Utility functions
 * -------------------------- */
function pmt(rate, nper, pv) {
  if (rate === 0) return -(pv / nper);
  const r = rate;
  return -(pv * r) / (1 - Math.pow(1 + r, -nper));
}

function npv(discountRate, cashflows) {
  return cashflows.reduce(
    (acc, cf, i) => acc + cf / Math.pow(1 + discountRate, i),
    0
  );
}

function irr(cashflows, guess = 0.15) {
  let rate = guess;
  for (let iter = 0; iter < 100; iter++) {
    let f = 0,
      df = 0;
    for (let t = 0; t < cashflows.length; t++) {
      const denom = Math.pow(1 + rate, t);
      f += cashflows[t] / denom;
      if (t > 0) df += (-t * cashflows[t]) / Math.pow(1 + rate, t + 1);
    }
    const step = f / df;
    rate -= step;
    if (!isFinite(rate) || Math.abs(step) < 1e-8) break;
  }
  return rate;
}

/** --------------------------
 * Core calculator (Yearly)
 * -------------------------- */
function buildYearlyProjection({
  capacityKw,
  unitsPerKwDay,
  degradationPct,
  contractYears,
  ppaTariff,
  tariffEscalationPct,
  capexPerKw,
  upfrontPercent,
  loanInterestPct,
  loanTenureYears,
  omrPerKwYear,
  omrEscalationPct,
  discountRatePct,
}) {
  const daysPerYear = 365;
  const year1Gen = capacityKw * unitsPerKwDay * daysPerYear;

  const capexTotal = capacityKw * capexPerKw;
  const upfront = (upfrontPercent / 100) * capexTotal;
  const loanAmount = capexTotal - upfront;
  const loanRate = loanInterestPct / 100;
  const loanNper = Math.max(0, Math.min(contractYears, loanTenureYears));
  const emiAnnual = loanNper > 0 ? pmt(loanRate, loanNper, loanAmount) : 0; // negative

  const rows = [];
  rows.push({
    year: 0,
    generationKwh: 0,
    tariff: 0,
    revenue: 0,
    omr: 0,
    emi: 0,
    net: -upfront,
  });

  let gen = year1Gen;
  let tariff = ppaTariff;
  let omr = capacityKw * omrPerKwYear;

  for (let y = 1; y <= contractYears; y++) {
    if (y > 1) {
      gen = gen * (1 - degradationPct / 100);
      tariff = tariff * (1 + tariffEscalationPct / 100);
      omr = omr * (1 + omrEscalationPct / 100);
    }

    const revenue = gen * tariff;
    const loanPayment = y <= loanNper ? emiAnnual : 0; // negative
    const net = revenue - omr + loanPayment;

    rows.push({
      year: y,
      generationKwh: Math.round(gen),
      tariff,
      revenue,
      omr,
      emi: loanPayment,
      net,
    });
  }

  const cashflows = rows.map((r) => r.net);

  const summary = {
    capexTotal,
    upfront,
    loanAmount,
    year1Gen: Math.round(year1Gen),
    year1Revenue: year1Gen * ppaTariff,
    emiAnnual,
    paybackYear: (() => {
      let cum = 0;
      for (let i = 0; i < rows.length; i++) {
        cum += rows[i].net;
        if (cum >= 0) return i;
      }
      return null;
    })(),
    npv: npv(discountRatePct / 100, cashflows),
    irr: (() => {
      try {
        return irr(cashflows);
      } catch {
        return null;
      }
    })(),
    cumulative: rows.reduce((acc, r) => {
      const prev = acc.length ? acc[acc.length - 1].value : 0;
      acc.push({ year: r.year, value: prev + r.net });
      return acc;
    }, []),
    rows,
  };

  return summary;
}

/** --------------------------
 * Monthly expansion (derived from yearly)
 * -------------------------- */
function buildMonthlyProjection(yearly) {
  // Equal split across months (simple). We can add seasonal CUF later.
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  const rows = [];
  rows.push({
    key: 'Y0-M0',
    label: 'Y0',
    month: '-',
    generationKwh: 0,
    tariff: 0,
    revenue: 0,
    omr: 0,
    emi: 0,
    net: yearly.rows[0].net,
  });

  for (let y = 1; y < yearly.rows.length; y++) {
    const yr = yearly.rows[y];
    const monthlyGen = yr.generationKwh / 12;
    const monthlyTariff = yr.tariff;
    const monthlyRevenue = yr.revenue / 12;
    const monthlyOMR = yr.omr / 12;
    const monthlyEMI = yr.emi / 12;
    const monthlyNet = yr.net / 12;

    for (let m = 0; m < 12; m++) {
      rows.push({
        key: `Y${y}-M${m + 1}`,
        label: `Y${y}`,
        month: months[m],
        generationKwh: Math.round(monthlyGen),
        tariff: monthlyTariff,
        revenue: monthlyRevenue,
        omr: monthlyOMR,
        emi: monthlyEMI,
        net: monthlyNet,
      });
    }
  }

  let cum = 0;
  const cumulative = rows.map((r) => (cum += r.net));

  return { rows, cumulative };
}

/** --------------------------
 * CSV & PDF helpers
 * -------------------------- */
function exportTableToCSV(filename, headers, dataRows) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const csv = [headers.join(',')]
    .concat(dataRows.map((r) => r.map(esc).join(',')))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportTableToPDF(title, headers, dataRows) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'A4' });

  // Header
  doc.setFontSize(14);
  doc.text(title, 40, 40);

  // Table
  autoTable(doc, {
    head: [headers],
    body: dataRows,
    startY: 60,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [20, 30, 60] },
  });

  doc.save(title.replace(/\s+/g, '_') + '.pdf');
}

/** --------------------------
 * UI Component
 * -------------------------- */
export default function App() {
  const [inputs, setInputs] = useState({
    capacityKw: 50,
    unitsPerKwDay: 4.2,
    degradationPct: 0.6,
    contractYears: 20,
    ppaTariff: 5.0,
    tariffEscalationPct: 2.0,
    capexPerKw: 42000,
    upfrontPercent: 20,
    loanInterestPct: 11.5,
    loanTenureYears: 7,
    omrPerKwYear: 800,
    omrEscalationPct: 3.0,
    discountRatePct: 12.0,
  });
  const [view, setView] = useState('year'); // "year" | "month"

  const onChange = (key, val) =>
    setInputs((prev) => ({ ...prev, [key]: Number(val) }));

  const yearly = useMemo(() => buildYearlyProjection(inputs), [inputs]);
  const monthly = useMemo(() => buildMonthlyProjection(yearly), [yearly]);

  const headersYear = [
    'Year',
    'Generation (kWh)',
    'Tariff (₹/kWh)',
    'Revenue (₹)',
    'O&M (₹)',
    'Loan EMI (₹)',
    'Net (₹)',
    'Cumulative (₹)',
  ];

  const rowsYear = yearly.rows.map((r) => {
    const cum = yearly.cumulative.find((c) => c.year === r.year)?.value ?? 0;
    return [
      r.year,
      r.generationKwh,
      r.tariff ? r.tariff.toFixed(2) : '-',
      Math.round(r.revenue),
      Math.round(r.omr),
      Math.round(r.emi),
      Math.round(r.net),
      Math.round(cum),
    ];
  });

  const headersMonth = [
    'Year',
    'Month',
    'Generation (kWh)',
    'Tariff (₹/kWh)',
    'Revenue (₹)',
    'O&M (₹)',
    'Loan EMI (₹)',
    'Net (₹)',
    'Cumulative (₹)',
  ];

  const rowsMonth = monthly.rows.map((r, idx) => [
    r.label,
    r.month,
    r.generationKwh,
    r.tariff ? r.tariff.toFixed(2) : '-',
    Math.round(r.revenue),
    Math.round(r.omr),
    Math.round(r.emi),
    Math.round(r.net),
    Math.round(monthly.cumulative[idx]),
  ]);

  const exportCSV = () => {
    if (view === 'year') {
      exportTableToCSV('ppa_yearly.csv', headersYear, rowsYear);
    } else {
      exportTableToCSV('ppa_monthly.csv', headersMonth, rowsMonth);
    }
  };

  const exportPDF = () => {
    if (view === 'year') {
      exportTableToPDF('PPA Yearly Breakdown', headersYear, rowsYear);
    } else {
      exportTableToPDF('PPA Monthly Breakdown', headersMonth, rowsMonth);
    }
  };

  return (
    <div style={styles.wrap}>
      <h1 style={styles.h1}>Solar PPA Earning Calculator</h1>

      <div style={styles.grid}>
        {/* Inputs */}
        <div style={styles.card}>
          <h2 style={styles.h2}>Inputs</h2>

          {[
            ['Plant Capacity (kW)', 'capacityKw', 1],
            ['Units/kW/day', 'unitsPerKwDay', 0.1],
            ['Degradation (%/yr)', 'degradationPct', 0.1],
            ['Contract Years', 'contractYears', 1],
            ['PPA Tariff (₹/kWh)', 'ppaTariff', 0.1],
            ['Tariff Escalation (%/yr)', 'tariffEscalationPct', 0.1],
            ['CapEx (₹/kW)', 'capexPerKw', 1],
            ['Upfront / Equity (% of CapEx)', 'upfrontPercent', 1],
            ['Loan Interest (% p.a.)', 'loanInterestPct', 0.1],
            ['Loan Tenure (years)', 'loanTenureYears', 1],
            ['O&M (₹/kW/year)', 'omrPerKwYear', 1],
            ['O&M Escalation (%/yr)', 'omrEscalationPct', 0.1],
            ['Discount Rate (% for NPV)', 'discountRatePct', 0.1],
          ].map(([label, key, step]) => (
            <div key={key} style={styles.field}>
              <label style={styles.label}>{label}</label>
              <input
                type="number"
                step={step}
                value={inputs[key]}
                onChange={(e) => onChange(key, e.target.value)}
                style={styles.input}
              />
            </div>
          ))}

          <p style={styles.note}>
            💡 Tip: Discount Rate ~ your WACC/expected return (10–12% typical
            for rooftop PPA).
          </p>
        </div>

        {/* Results */}
        <div style={styles.card}>
          <div style={styles.toolbar}>
            <div style={styles.tabs}>
              <button
                onClick={() => setView('year')}
                style={{
                  ...styles.tab,
                  ...(view === 'year' ? styles.tabActive : {}),
                }}
              >
                Yearly
              </button>
              <button
                onClick={() => setView('month')}
                style={{
                  ...styles.tab,
                  ...(view === 'month' ? styles.tabActive : {}),
                }}
              >
                Monthly
              </button>
            </div>
            <div>
              <button onClick={exportCSV} style={styles.btn}>
                Export CSV
              </button>
              <button
                onClick={exportPDF}
                style={{ ...styles.btn, marginLeft: 8 }}
              >
                Export PDF
              </button>
            </div>
          </div>

          <h2 style={styles.h2}>Summary</h2>
          <div style={styles.kpigrid}>
            <div style={styles.kpiBox}>
              <div style={styles.kpiLabel}>CapEx Total</div>
              <div style={styles.kpiValue}>₹ {yearly.capexTotal}</div>
            </div>
            <div style={styles.kpiBox}>
              <div style={styles.kpiLabel}>Upfront (Equity)</div>
              <div style={styles.kpiValue}>₹ {yearly.upfront}</div>
            </div>
            <div style={styles.kpiBox}>
              <div style={styles.kpiLabel}>Loan Amount</div>
              <div style={styles.kpiValue}>₹ {yearly.loanAmount}</div>
            </div>
            <div style={styles.kpiBox}>
              <div style={styles.kpiLabel}>Year-1 Generation</div>
              <div style={styles.kpiValue}>{yearly.year1Gen} kWh</div>
            </div>
            <div style={styles.kpiBox}>
              <div style={styles.kpiLabel}>EMI (annual)</div>
              <div style={styles.kpiValue}>
                ₹ {Math.round(-yearly.emiAnnual)}
              </div>
            </div>
            <div style={styles.kpiBox}>
              <div style={styles.kpiLabel}>NPV</div>
              <div style={styles.kpiValue}>₹ {Math.round(yearly.npv)}</div>
            </div>
            <div style={styles.kpiBox}>
              <div style={styles.kpiLabel}>IRR</div>
              <div style={styles.kpiValue}>
                {isFinite(yearly.irr)
                  ? (yearly.irr * 100).toFixed(2) + '%'
                  : 'n/a'}
              </div>
            </div>
            <div style={styles.kpiBox}>
              <div style={styles.kpiLabel}>Simple Payback</div>
              <div style={styles.kpiValue}>
                {yearly.paybackYear
                  ? `${yearly.paybackYear} yrs`
                  : 'beyond term'}
              </div>
            </div>
          </div>

          {view === 'year' ? (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Year</th>
                    <th style={styles.th}>Generation (kWh)</th>
                    <th style={styles.th}>Tariff (₹/kWh)</th>
                    <th style={styles.th}>Revenue (₹)</th>
                    <th style={styles.th}>O&M (₹)</th>
                    <th style={styles.th}>Loan EMI (₹)</th>
                    <th style={styles.th}>Net (₹)</th>
                    <th style={styles.th}>Cumulative (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {yearly.rows.map((r, idx) => {
                    const cum =
                      yearly.cumulative.find((c) => c.year === r.year)?.value ??
                      0;
                    return (
                      <tr key={idx}>
                        <td style={styles.tdLeft}>{r.year}</td>
                        <td style={styles.tdLeft}>{r.generationKwh}</td>
                        <td style={styles.td}>
                          {r.tariff ? r.tariff.toFixed(2) : '-'}
                        </td>
                        <td style={styles.td}>{Math.round(r.revenue)}</td>
                        <td style={styles.td}>{Math.round(r.omr)}</td>
                        <td style={styles.td}>{Math.round(r.emi)}</td>
                        <td
                          style={{
                            ...styles.td,
                            color: r.net >= 0 ? '#6ef3a8' : '#ff8e8e',
                          }}
                        >
                          {Math.round(r.net)}
                        </td>
                        <td
                          style={{
                            ...styles.td,
                            color: cum >= 0 ? '#6ef3a8' : '#ff8e8e',
                          }}
                        >
                          {Math.round(cum)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Year</th>
                    <th style={styles.th}>Month</th>
                    <th style={styles.th}>Generation (kWh)</th>
                    <th style={styles.th}>Tariff (₹/kWh)</th>
                    <th style={styles.th}>Revenue (₹)</th>
                    <th style={styles.th}>O&M (₹)</th>
                    <th style={styles.th}>Loan EMI (₹)</th>
                    <th style={styles.th}>Net (₹)</th>
                    <th style={styles.th}>Cumulative (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {monthly.rows.map((r, idx) => (
                    <tr key={r.key}>
                      <td style={styles.tdLeft}>{r.label}</td>
                      <td style={styles.tdLeft}>{r.month}</td>
                      <td style={styles.tdLeft}>{r.generationKwh}</td>
                      <td style={styles.td}>
                        {r.tariff ? r.tariff.toFixed(2) : '-'}
                      </td>
                      <td style={styles.td}>{Math.round(r.revenue)}</td>
                      <td style={styles.td}>{Math.round(r.omr)}</td>
                      <td style={styles.td}>{Math.round(r.emi)}</td>
                      <td
                        style={{
                          ...styles.td,
                          color: r.net >= 0 ? '#6ef3a8' : '#ff8e8e',
                        }}
                      >
                        {Math.round(r.net)}
                      </td>
                      <td
                        style={{
                          ...styles.td,
                          color:
                            monthly.cumulative[idx] >= 0
                              ? '#6ef3a8'
                              : '#ff8e8e',
                        }}
                      >
                        {Math.round(monthly.cumulative[idx])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p style={styles.note}>
            Notes: Monthly view splits each year equally (for simplicity). We
            can add seasonal CUF, downtime, and tax later.
          </p>
        </div>
      </div>
    </div>
  );
}

/** --------------------------
 * Inline styles (dark UI)
 * -------------------------- */
const styles = {
  wrap: {
    width: '100%',
    margin: '0 auto',
    padding: 24,
    background: '#0b1020',
    color: '#e7ecff',
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial',
  },
  h1: { fontSize: 24, margin: '24px 0' },
  h2: { fontSize: 18, margin: '0 0 12px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: '360px 1fr',
    gap: 24,
    alignItems: 'start',
  },
  card: {
    background: '#121939',
    border: '1px solid rgba(255,255,255,.06)',
    borderRadius: 12,
    padding: 18,
    boxShadow: '0 6px 24px rgba(0,0,0,.08)',
  },
  field: { display: 'grid', gap: 6, marginBottom: 12 },
  label: { fontSize: 12, opacity: 0.9 },
  input: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,.12)',
    background: '#0f1530',
    color: '#e7ecff',
  },
  kpigrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 12,
    marginBottom: 12,
  },
  kpiBox: {
    background: '#0f1530',
    padding: 12,
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,.06)',
  },
  kpiLabel: { fontSize: 11, opacity: 0.8 },
  kpiValue: { fontSize: 16, marginTop: 4, fontVariantNumeric: 'tabular-nums' },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  tabs: { display: 'flex', gap: 8 },
  tab: {
    padding: '8px 12px',
    background: '#0f1530',
    border: '1px solid rgba(255,255,255,.12)',
    color: '#e7ecff',
    borderRadius: 8,
    cursor: 'pointer',
  },
  tabActive: { outline: '2px solid #6ea8fe' },
  btn: {
    padding: '8px 12px',
    background: '#1a254d',
    border: '1px solid rgba(255,255,255,.12)',
    color: '#e7ecff',
    borderRadius: 8,
    cursor: 'pointer',
  },
  tableWrap: {
    overflow: 'auto',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,.08)',
    marginTop: 10,
  },
  table: { width: '100%', borderCollapse: 'collapse', minWidth: 900 },
  th: {
    padding: '10px 12px',
    textAlign: 'right',
    borderBottom: '1px solid rgba(255,255,255,.06)',
    fontVariantNumeric: 'tabular-nums',
  },
  td: {
    padding: '10px 12px',
    textAlign: 'right',
    borderBottom: '1px solid rgba(255,255,255,.06)',
    fontVariantNumeric: 'tabular-nums',
  },
  tdLeft: {
    padding: '10px 12px',
    textAlign: 'left',
    borderBottom: '1px solid rgba(255,255,255,.06)',
    fontVariantNumeric: 'tabular-nums',
  },
  note: { opacity: 0.8, fontSize: 12, marginTop: 12 },
};
