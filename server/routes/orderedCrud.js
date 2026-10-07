import { Router } from 'express';
import { asyncH, parse, HttpError, objectIdStr } from '../lib/http.js';
import { statusInput, reorderInput } from '../lib/schemas.js';
import { emitChange, emitAdmin, emitPublic } from '../lib/realtime.js';

/**
 * CRUD untuk daftar yang punya urutan + aktif/nonaktif (kategori, FAQ, kontak).
 * Daftar ini kecil dan diurutkan manual, jadi tidak dipaginasi (reorder membutuhkan seluruh daftar).
 */
export function orderedCrud({ Model, entity, input, adm, pub, hooks = {} }) {
  const r = Router();
  const visible = (d) => d.active !== false;
  const id = (d) => String(d._id);
  const emit = (before, after) => emitChange(entity, { before, after, adm, pub, visible, id });

  const load = async (rawId) => {
    if (!objectIdStr.safeParse(rawId).success) throw new HttpError(404, 'Data tidak ditemukan.');
    const doc = await Model.findById(rawId);
    if (!doc) throw new HttpError(404, 'Data tidak ditemukan.');
    return doc;
  };
  const listAll = async () => {
    const docs = await Model.find().sort({ order: 1, _id: 1 });
    return hooks.decorateList ? hooks.decorateList(docs) : docs.map((d) => adm(d));
  };

  r.get('/', asyncH(async (_req, res) => res.json({ items: await listAll() })));

  r.post('/', asyncH(async (req, res) => {
    const data = parse(input, req.body);
    const extra = hooks.beforeSave ? await hooks.beforeSave(data, null) : {};
    const last = await Model.findOne().sort({ order: -1 }).select('order').lean();
    const doc = await Model.create({ ...data, ...extra, order: (last?.order ?? -1) + 1 });
    if (hooks.afterSave) await hooks.afterSave(doc);
    emit(null, doc);
    res.status(201).json({ item: adm(doc) });
  }));

  // Harus sebelum "/:id"
  r.put('/reorder', asyncH(async (req, res) => {
    const { ids } = parse(reorderInput, req.body);
    const existing = await Model.find({ _id: { $in: ids } }).select('_id').lean();
    if (existing.length !== ids.length) throw new HttpError(422, 'Daftar urutan berisi data yang tidak dikenal.');
    await Model.bulkWrite(ids.map((_id, order) => ({ updateOne: { filter: { _id }, update: { $set: { order } } } })));
    const docs = await Model.find().sort({ order: 1, _id: 1 });
    emitAdmin(`${entity}:reorder`, { ids: docs.map(id) });
    emitPublic(`${entity}:reorder`, { ids: docs.filter(visible).map(id) });
    res.json({ items: await listAll() });
  }));

  r.put('/:id', asyncH(async (req, res) => {
    const doc = await load(req.params.id);
    const before = doc.toObject();
    const data = parse(input, req.body);
    const extra = hooks.beforeSave ? await hooks.beforeSave(data, doc) : {};
    doc.set({ ...data, ...extra });
    await doc.save();
    if (hooks.afterSave) await hooks.afterSave(doc);
    emit(before, doc.toObject());
    res.json({ item: adm(doc) });
  }));

  r.patch('/:id/status', asyncH(async (req, res) => {
    const { active } = parse(statusInput, req.body);
    const doc = await load(req.params.id);
    const before = doc.toObject();
    doc.active = active;
    await doc.save();
    emit(before, doc.toObject());
    res.json({ item: adm(doc) });
  }));

  r.delete('/:id', asyncH(async (req, res) => {
    const doc = await load(req.params.id);
    if (hooks.beforeDelete) await hooks.beforeDelete(doc, req.query);
    const before = doc.toObject();
    await Model.deleteOne({ _id: doc._id });
    // Pembersihan aset tidak boleh menggagalkan penghapusan yang sudah tersimpan (yang gagal ditandai orphan dan dibersihkan sweeper)
    if (hooks.afterDelete) await Promise.resolve(hooks.afterDelete(before)).catch((e) => console.error(`[${entity}] pembersihan aset gagal:`, e?.message));
    emit(before, null);
    res.json({ ok: true });
  }));

  return r;
}
