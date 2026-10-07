import { Router } from 'express';
import { asyncH, parse } from '../lib/http.js';
import { monthlyReportQuery, monthlyDetailQuery, reportMonthParam, clearMonthQuery } from '../lib/schemas.js';
import { monthlyReport, monthDetail, monthImpact, clearMonth } from '../services/reports.js';

/* /api/admin/reports — laporan production (hanya baca, kecuali "hapus rekap" yang cuma menulis penanda ReportReset). Di belakang requireAdmin. */
const r = Router();
r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

r.get('/monthly', asyncH(async (req, res) => {
  res.json(await monthlyReport(parse(monthlyReportQuery, req.query)));
}));

r.get('/monthly/:month', asyncH(async (req, res) => {
  const month = parse(reportMonthParam, req.params.month);
  const { page, limit, ...filters } = parse(monthlyDetailQuery, req.query);
  res.json(await monthDetail(filters, month, { page, limit }));
}));

r.get('/monthly/:month/impact', asyncH(async (req, res) => {
  res.json(await monthImpact(parse(reportMonthParam, req.params.month)));
}));

r.delete('/monthly/:month', asyncH(async (req, res) => {
  const month = parse(reportMonthParam, req.params.month);
  const { asOf } = parse(clearMonthQuery, req.query);
  res.json({ cleared: await clearMonth(month, asOf, req.admin?._id) });
}));

export default r;
