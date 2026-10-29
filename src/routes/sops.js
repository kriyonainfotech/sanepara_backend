import { Router } from 'express';
import mongoose from 'mongoose';
import { Sop } from '../models/Sop.js';
import { protect, hasPermission } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';

const router = Router();
router.use(protect);

// SOPs and Rules are managed separately, each under its own permission module.
const MODULE = { SOP: 'sop', Rule: 'rules' };
const kindOf = (k) => (k === 'Rule' ? 'Rule' : 'SOP');
const seesAll = (req, kind) => hasPermission(req, MODULE[kind], 'view') || hasPermission(req, MODULE[kind], 'manage');
const mustManage = (req, kind) => {
  if (!hasPermission(req, MODULE[kind], 'manage')) throw new HttpError(403, 'You do not have access to this');
};

const clean = (b, kind) => {
  if (!String(b.title || '').trim()) throw new HttpError(400, 'Add a title');
  if (!String(b.content || '').trim()) throw new HttpError(400, kind === 'Rule' ? 'Write the rule' : 'Write the SOP steps');
  return {
    title: b.title,
    area: String(b.area || '').trim() || 'General',
    content: b.content,
    assignToAll: Boolean(b.assignToAll),
    assignedTo: b.assignToAll ? [] : (Array.isArray(b.assignedTo) ? b.assignedTo : []).filter((id) => mongoose.isValidObjectId(id)),
    isActive: b.isActive !== false,
  };
};

const populate = (q) => q.populate('assignedTo', 'name role').populate('createdBy', 'name').populate('acknowledgements.user', 'name');

// ?kind=SOP|Rule. ?mine=1 = only the active ones assigned to me (My SOP / My Rules);
// otherwise the full list for the management page.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const kind = kindOf(req.query.kind);
    const mine = req.query.mine === '1';
    if (!mine && !seesAll(req, kind)) throw new HttpError(403, 'You do not have access to this');
    const filter = mine ? { kind, isActive: true, $or: [{ assignToAll: true }, { assignedTo: req.user._id }] } : { kind };
    const data = (await populate(Sop.find(filter).sort({ area: 1, title: 1 })).lean()).map((s) => ({
      ...s,
      ackedByMe: s.acknowledgements.some((a) => String(a.user?._id) === String(req.user._id)),
      assignedToMe: s.assignToAll || s.assignedTo.some((u) => String(u._id) === String(req.user._id)),
    }));
    res.json({ data });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const kind = kindOf(req.body.kind);
    mustManage(req, kind);
    const sop = await Sop.create({ ...clean(req.body, kind), kind, createdBy: req.user._id });
    res.status(201).json({ message: `${sop.kind} created`, data: sop });
  })
);

// Editing the content asks everyone to read and acknowledge it again.
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const sop = await Sop.findById(req.params.id);
    if (!sop) throw new HttpError(404, 'Not found');
    mustManage(req, sop.kind);
    const data = clean(req.body, sop.kind);
    const changed = data.content.trim() !== sop.content || data.title.trim() !== sop.title;
    Object.assign(sop, data);
    if (changed) sop.acknowledgements = [];
    await sop.save();
    res.json({ message: changed ? 'Saved — members will need to acknowledge it again' : 'Saved', data: sop });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const sop = await Sop.findById(req.params.id);
    if (!sop) throw new HttpError(404, 'Not found');
    mustManage(req, sop.kind);
    await sop.deleteOne();
    res.json({ message: 'Deleted' });
  })
);

// "I have read and understood this."
router.post(
  '/:id/ack',
  asyncHandler(async (req, res) => {
    const sop = await Sop.findById(req.params.id);
    if (!sop || !sop.isActive) throw new HttpError(404, 'Not found');
    if (!sop.acknowledgements.some((a) => String(a.user) === String(req.user._id))) {
      sop.acknowledgements.push({ user: req.user._id });
      await sop.save();
    }
    res.json({ message: 'Marked as read' });
  })
);

export default router;
