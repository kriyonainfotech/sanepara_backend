import { Router } from 'express';
import { ChecklistTemplate } from '../models/ChecklistTemplate.js';
import { protect, can } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';

const router = Router();
router.use(protect);

const clean = (b) => ({
  title: b.title?.trim(),
  items: (Array.isArray(b.items) ? b.items : []).map((i) => String(i).trim()).filter(Boolean),
});

// Everyone can read templates (needed in task forms).
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ data: await ChecklistTemplate.find().sort({ createdAt: -1 }) });
  })
);

router.post(
  '/',
  can('tasks', 'templates'),
  asyncHandler(async (req, res) => {
    const data = clean(req.body);
    if (!data.title) throw new HttpError(400, 'Template title is required');
    res.status(201).json({ data: await ChecklistTemplate.create({ ...data, createdBy: req.user._id }) });
  })
);

router.put(
  '/:id',
  can('tasks', 'templates'),
  asyncHandler(async (req, res) => {
    const data = clean(req.body);
    if (!data.title) throw new HttpError(400, 'Template title is required');
    const tpl = await ChecklistTemplate.findByIdAndUpdate(req.params.id, data, { new: true });
    if (!tpl) throw new HttpError(404, 'Template not found');
    res.json({ data: tpl });
  })
);

router.delete(
  '/:id',
  can('tasks', 'templates'),
  asyncHandler(async (req, res) => {
    const tpl = await ChecklistTemplate.findByIdAndDelete(req.params.id);
    if (!tpl) throw new HttpError(404, 'Template not found');
    res.json({ message: 'Template deleted' });
  })
);

export default router;
